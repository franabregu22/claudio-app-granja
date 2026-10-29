#!/usr/bin/env node
/**
 * LOTE 1E — ANULAR / RECTIFICAR COBROS EN EFECTIVO Y BANCOS (migration 0108). LOCAL TEST DATABASE ONLY.
 *
 * reverse_collection / rectify_collection: client balance, financial postings, idempotency (replay / second reversal / key
 * reuse), audit, ADMIN only, refusals (Mercado Pago account, bank-statement match, closed period, identical rectification),
 * atomicity of a rectification (a refusal after the reversal leaves NOTHING), P&L and fiscal untouched, the
 * fin_customer_collections statuses, immutability of collection_reversal.
 *
 * Everything runs inside ONE transaction that is rolled back. If 0108 is not in the ledger yet, the migration file itself is
 * executed first INSIDE that transaction (so it is rolled back too). Each call runs in its own subtransaction and is checked
 * as at its own COMMIT (SET CONSTRAINTS ALL IMMEDIATE): a refused call leaves nothing behind.
 *
 * Part 2 (concurrency reconciliation ↔ annulment) commits synthetic evidence, so it runs only on a DISPOSABLE local project
 * (FIN_E2E_PROJECT = its project_id; never Claudio_app_Granja) and is skipped otherwise.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" [FIN_E2E_PROJECT=<disposable id>] \
 *     node scripts/target-db/fin_collection_reversal.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

function resolveDockerBin() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  return existsSync(c) ? c : 'docker';
}
const DOCKER = resolveDockerBin();
const dockerRun = (args, input) => {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker: ${r.error.message}`);
  return r;
};

const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations/0108_collection_reversal.sql');
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0108-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0108-0000-0000-00000000000b';
const CA = 'cccccccc-0108-0000-0000-0000000000a1';
const CB = 'cccccccc-0108-0000-0000-0000000000b2';
const CX = 'cccccccc-0108-0000-0000-0000000000c3';   // inactive client
const CAJA = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo LIMIT 1)`;
const BNA = `(SELECT id FROM financial_account WHERE nombre = 'BNA' AND account_type = 'BANK_ACCOUNT')`;
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved as the owner before the role switch

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);

const collect = (cliente, amount, acc, date, receipt, method = 'CASH') =>
  `SELECT register_collection(${lit(cliente)}::uuid, ${amount}, '${method}'::payment_method, ${lit(receipt)}, ${lit(date)}::date, ${P(acc)}::uuid, NULL, 'cobro de prueba')::text`;
const reverse = (col, reason, key) => `SELECT reverse_collection(${P(col)}::uuid, ${lit(reason)}, ${lit(key)})::text`;
const rectify = (col, cliente, amount, acc, date, reason, key) =>
  `SELECT rectify_collection(${P(col)}::uuid, ${lit(cliente)}::uuid, ${amount}, ${P(acc)}::uuid, ${lit(date)}::date, ${lit(reason)}, ${lit(key)})::text`;
const COL = (key) => RES(key, 'collection_id');

const TABLES = ['collections', 'client_ledger', 'financial_operation', 'financial_posting', 'collection_reversal', 'audit_events',
  'fiscal_document', 'fiscal_obligation', 'fiscal_payment', 'mp_client_allocation', 'fin_statement_match'];
const counts = () => TABLES.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const snap = (name) => add(`CREATE TEMP TABLE ${name} AS ${counts()};`);
const delta = (name) => `(SELECT coalesce(string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t), 'none') FROM (${counts()}) c JOIN ${name} b ON b.t = c.t WHERE c.n <> b.n)`;
const CLB = (c) => `(SELECT coalesce(sum(signed_amount), 0) FROM client_ledger WHERE cliente_id = '${c}')`;
const ACB = (acc) => `(SELECT coalesce(sum(signed_amount), 0) FROM financial_posting WHERE financial_account_id = ${acc})`;
const PNL = `(SELECT md5(coalesce((SELECT string_agg(x::text, '#' ORDER BY x::text) FROM pnl_summary x), '')) || md5(coalesce((SELECT string_agg(x::text, '#' ORDER BY x::text) FROM pnl_line_item x), '')))`;
const VIEW = (col, field) => `(SELECT ${field} FROM fin_customer_collections WHERE row_id = 'C:' || ${col})`;

// ── harness ─────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0108')) AS has_0108 \\gset
\\if :has_0108
\\else
\\i /tmp/0108_collection_reversal.sql
\\endif
CREATE TEMP TABLE res (k TEXT PRIMARY KEY, v JSONB);
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT, p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; msg TEXT; ok BOOLEAN := false; e TEXT; val TEXT;
BEGIN
  LOOP
    e := substring(p_sql FROM '\\{\\{(.+?)\\}\\}');
    EXIT WHEN e IS NULL;
    EXECUTE 'SELECT (' || e || ')::text' INTO val;
    p_sql := replace(p_sql, '{{' || e || '}}', quote_nullable(val));
  END LOOP;
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
    EXECUTE p_sql INTO v;
    RESET ROLE;
    SET CONSTRAINTS ALL IMMEDIATE;   -- the call as at its own COMMIT
    SET CONSTRAINTS ALL DEFERRED;
    ok := true;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    RESET ROLE;
  END;
  IF ok AND p_key IS NOT NULL THEN
    INSERT INTO res VALUES (p_key, v::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
  END IF;
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || msg END;
END $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN
    RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, p_got, p_like;
  ELSE
    RAISE NOTICE 'PASS %', p_name;
  END IF;
END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'lote1e-0108-admin@test.local', 'ADMIN'), ('${OPER}', 'lote1e-0108-oper@test.local', 'OPERATOR');
INSERT INTO clients (id, nombre) VALUES ('${CA}', 'Cliente 0108 A'), ('${CB}', 'Cliente 0108 B');
INSERT INTO clients (id, nombre, activo) VALUES ('${CX}', 'Cliente 0108 inactivo', false);`);

// ── fixtures: real collections through register_collection ────────────────
const D = '2026-10-10';
expect('fixture C1 cash 100.000', ADM(collect(CA, 100000, CAJA, D, 'T0108-C1'), 'c1'), 'OK:%');
expect('fixture C2 bank 50.000', ADM(collect(CA, 50000, BNA, D, 'T0108-C2', 'TRANSFER'), 'c2'), 'OK:%');
expect('fixture C3 cash 30.000', ADM(collect(CA, 30000, CAJA, D, 'T0108-C3'), 'c3'), 'OK:%');
expect('fixture C5 cash 10.000 on 2026-09-05 (period closed afterwards)', ADM(collect(CA, 10000, CAJA, '2026-09-05', 'T0108-C5'), 'c5'), 'OK:%');
// legacy-shaped rows no current route can create in this test: a manual collection on the Mercado Pago account and a Feria
// collection (sales_session_id, 0032 / 0070). Test-only, triggers off for the insert.
add(`SET LOCAL session_replication_role = replica;
INSERT INTO collections (id, cliente_id, amount, payment_method, receipt_id, effective_date, financial_account_id, created_by)
VALUES ('dddddddd-0108-0000-0000-0000000000e1', '${CA}', 5000, 'MERCADOPAGO', 'T0108-MP', '${D}', ${MPACC}, '${ADMIN}');
INSERT INTO collections (id, cliente_id, amount, payment_method, receipt_id, effective_date, financial_account_id, sales_session_id, created_by)
VALUES ('dddddddd-0108-0000-0000-0000000000f1', '${CA}', 7000, 'CASH', 'FERIA:T0108:CASH', '${D}', ${CAJA}, 'eeeeeeee-0108-0000-0000-0000000000f1', '${ADMIN}');
SET LOCAL session_replication_role = origin;
CREATE TEMP TABLE b0 AS SELECT ${CLB(CA)} AS ca, ${CLB(CB)} AS cb, ${ACB(CAJA)} AS caja, ${ACB(BNA)} AS bna, ${PNL} AS pnl;`);

// ── permissions and input ───────────────────────────────────────────────────
expect('OPERATOR cannot annul', as('authenticated', OPER, reverse(COL('c1'), 'x', 'k-oper')), 'ERR:FORBIDDEN%');
expect('reason required', ADM(reverse(COL('c1'), '  ', 'k-blank')), 'ERR:REASON_REQUIRED%');
expect('idempotency key required', ADM(reverse(COL('c1'), 'x', '')), 'ERR:INVALID_IDEMPOTENCY_KEY%');
expect('core is not executable by authenticated', `has_function_privilege('authenticated', 'collection_reversal_core(uuid,text,text,text)', 'EXECUTE')`, 'false');
expect('anon cannot execute reverse_collection', `has_function_privilege('anon', 'reverse_collection(uuid,text,text)', 'EXECUTE')`, 'false');

// ── ANULAR C1 (cash 100.000) ────────────────────────────────────────────────
snap('s1');
expect('annul C1', ADM(reverse(COL('c1'), 'cobro duplicado', 'k-annul-c1'), 'a1'), 'OK:%"replayed": false%');
expect('annul C1: rows written', delta('s1'), 'audit_events=1,client_ledger=1,collection_reversal=1,financial_operation=1,financial_posting=1');
expect('annul C1: client A debt back up by 100.000', `${CLB(CA)} - (SELECT ca FROM b0)`, '100000.00');
expect('annul C1: Caja down by 100.000', `${ACB(CAJA)} - (SELECT caja FROM b0)`, '-100000.00');
expect('annul C1: original collection kept', `(SELECT count(*) FROM collections WHERE id::text = ${COL('c1')})`, '1');
expect('annul C1: original COLLECTION ledger row kept', `(SELECT count(*) FROM client_ledger WHERE movement_type = 'COLLECTION' AND source_entity_id = ${COL('c1')})`, '1');
expect('annul C1: reversal = ADJUSTMENT at the original date', `(SELECT operation_type || ' ' || effective_date FROM financial_operation WHERE external_ref = 'COLLECTION-REVERSAL:' || ${COL('c1')})`, `ADJUSTMENT ${D}`);
expect('annul C1: audit', `(SELECT action FROM audit_events WHERE entity_type = 'collection_reversal' AND after_values ->> 'collection_id' = ${COL('c1')})`, 'ANNUL_COLLECTION');
expect('annul C1: view status ANNULLED, no longer counts', `${VIEW(COL('c1'), "status || ' ' || counts_for_customer || ' ' || reversal_kind || ' ' || reversal_reason")}`, 'ANNULLED false ANNUL cobro duplicado');

// ── idempotency ─────────────────────────────────────────────────────────────
snap('s2');
expect('replay with the same key returns the stored result', ADM(reverse(COL('c1'), 'cobro duplicado', 'k-annul-c1')), 'OK:%"replayed": true%');
expect('replay writes nothing', delta('s2'), 'none');
expect('second annulment with another key refused', ADM(reverse(COL('c1'), 'otra vez', 'k-annul-c1-bis')), 'ERR:ALREADY_REVERSED%');
expect('rectifying an annulled collection refused', ADM(rectify(COL('c1'), CA, 90000, CAJA, D, 'x', 'k-rect-c1')), 'ERR:ALREADY_REVERSED%');
expect('a key already used for another collection refused', ADM(reverse(COL('c3'), 'x', 'k-annul-c1')), 'ERR:DUPLICATE_IDEMPOTENCY_KEY%');
expect('refusals wrote nothing', delta('s2'), 'none');

// ── RECTIFICAR C2 (bank 50.000, client A) → client B, 45.000, Caja ─────────
snap('s3');
expect('rectify C2', ADM(rectify(COL('c2'), CB, 45000, CAJA, D, 'era de otro cliente y en efectivo', 'k-rect-c2'), 'r2'), 'OK:%"replayed": false%');
expect('rectify C2: rows written (reversal + new collection)', delta('s3'), 'audit_events=2,client_ledger=2,collection_reversal=1,collections=1,financial_operation=2,financial_posting=2');
expect('rectify C2: client A +50.000 (cumulative with C1)', `${CLB(CA)} - (SELECT ca FROM b0)`, '150000.00');
expect('rectify C2: client B −45.000', `${CLB(CB)} - (SELECT cb FROM b0)`, '-45000.00');
expect('rectify C2: BNA −50.000', `${ACB(BNA)} - (SELECT bna FROM b0)`, '-50000.00');
expect('rectify C2: Caja +45.000 (cumulative with C1 −100.000)', `${ACB(CAJA)} - (SELECT caja FROM b0)`, '-55000.00');
expect('rectify C2: replacement linked, method from the account', `(SELECT c.payment_method || ' ' || c.amount || ' ' || c.receipt_id FROM collection_reversal r JOIN collections c ON c.id = r.replacement_collection_id WHERE r.collection_id::text = ${COL('c2')})`, 'CASH 45000.00 COLLECTION-RECTIFY:%');
expect('rectify C2: view original RECTIFIED', `${VIEW(COL('c2'), "status || ' ' || counts_for_customer")}`, 'RECTIFIED false');
expect('rectify C2: view replacement counts and points to the original', `(SELECT counts_for_customer || ' ' || replacement_of FROM fin_customer_collections WHERE row_id = 'C:' || ${RES('r2', 'replacement_collection_id')})`, 'true C:%');
expect('rectify replay', ADM(rectify(COL('c2'), CB, 45000, CAJA, D, 'era de otro cliente y en efectivo', 'k-rect-c2')), 'OK:%"replayed": true%');

// ── refusals and atomicity of a rectification ──────────────────────────────
snap('s4');
expect('rectify to Mercado Pago refused (separate circuit)', ADM(rectify(COL('c3'), CA, 30000, MPACC, D, 'x', 'k-rect-mp')), 'ERR:COLLECTION_ACCOUNT_NOT_SUPPORTED%');
expect('identical rectification refused', ADM(rectify(COL('c3'), CA, 30000, CAJA, D, 'x', 'k-rect-same')), 'ERR:NOTHING_TO_RECTIFY%');
expect('rectify to an inactive client refused AFTER the reversal step', ADM(rectify(COL('c3'), CX, 30000, CAJA, D, 'x', 'k-rect-inactive')), 'ERR:CLIENT_NOT_FOUND_OR_INACTIVE%');
expect('invalid amount refused', ADM(rectify(COL('c3'), CA, 0, CAJA, D, 'x', 'k-rect-zero')), 'ERR:INVALID_AMOUNT%');
expect('atomicity: refused rectifications left NOTHING (no reversal persisted)', delta('s4'), 'none');
expect('atomicity: C3 still counts for the client', `${VIEW(COL('c3'), "status || ' ' || counts_for_customer")}`, 'CASH true');
expect('Mercado Pago collection refused', ADM(reverse(`'dddddddd-0108-0000-0000-0000000000e1'`, 'x', 'k-mp')), 'ERR:COLLECTION_ACCOUNT_NOT_SUPPORTED%');
expect('Feria collection refused', ADM(reverse(`'dddddddd-0108-0000-0000-0000000000f1'`, 'x', 'k-feria')), 'ERR:FERIA_COLLECTION%');
expect('Feria collection: the view exposes its session (UI hides the actions)', `(SELECT sales_session_id FROM fin_customer_collections WHERE row_id = 'C:dddddddd-0108-0000-0000-0000000000f1')`, 'eeeeeeee-0108-0000-0000-0000000000f1');
// test fixture: close September directly (the close guard's Mercado Pago checks belong to other tests)
add(`SET LOCAL session_replication_role = replica;
UPDATE management_period SET status = 'CLOSED', closed_at = now(), closed_by = '${ADMIN}' WHERE periodo_fecha = '2026-09-01';
SET LOCAL session_replication_role = origin;`);
expect('closed period of the original refused', ADM(reverse(COL('c5'), 'x', 'k-closed')), 'ERR:PERIOD_CLOSED%');
expect('rectification INTO a closed period refused (atomic)', ADM(rectify(COL('c3'), CA, 30000, CAJA, '2026-09-20', 'x', 'k-rect-closed')), 'ERR:PERIOD_CLOSED%');
expect('closed-period refusals wrote nothing', delta('s4'), 'none');

// ── bank reconciliation (real statement, real cut, real fin_match_statement_line) ──────────────────────────
// a dedicated bank account with the BNA format: anchor 10.00 then +60.000 / +70.000 / −70.000 / +40.000 / +45.000
const ACCT = `(SELECT id FROM financial_account WHERE nombre = 'T0108 BANCO')`;
const SHA = 'a0108'.padEnd(64, '0');
const eco = (n, date, desc, amt, bal) => ({ row_number: n + 1, kind: 'ECONOMIC', statement_position: n, value_date: date, description_raw: desc,
  bank_reference: String(n), signed_amount: amt, running_balance: bal, raw_row: { text: `${date} ${desc} ${amt} ${bal}` }, appearance_meta: { page: 1, physical_row: n } });
const ROWS = [{ row_number: 1, kind: 'CONTROL', control_type: 'SALDO_ANTERIOR', balance: '1000.00', raw_row: { text: 'SALDO_ANTERIOR' } },
  eco(1, '2026-10-01', 'ANCLA', '10.00', '1010.00'), eco(2, '2026-10-12', 'TRF C6', '60000.00', '61010.00'),
  eco(3, '2026-10-12', 'TRF C7', '70000.00', '131010.00'), eco(4, '2026-10-13', 'DEB X', '-70000.00', '61010.00'),
  eco(5, '2026-10-14', 'TRF C8', '40000.00', '101010.00'), eco(6, '2026-10-14', 'TRF R8', '45000.00', '146010.00'),
  { row_number: 8, kind: 'CONTROL', control_type: 'SALDO_FINAL', balance: '146010.00', raw_row: { text: 'SALDO_FINAL' } }];
const LINE = (n) => `(SELECT statement_line_id FROM fin_import_run_line WHERE run_id::text = ${RES('imp', 'run_id')} AND statement_position = ${n})`;
const POST = (colExpr) => `(SELECT p.id FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id WHERE o.operation_type = 'COLLECTION' AND o.source_entity_id = ${colExpr})`;
const REVPOST = (colExpr) => `(SELECT p.id FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id WHERE o.external_ref = 'COLLECTION-REVERSAL:' || ${colExpr})`;
const match = (line, post) => `SELECT fin_match_statement_line(${P(line)}::bigint, ${P(post)}::bigint, 'test 0108')::text`;
add(`INSERT INTO financial_account (nombre, account_type) VALUES ('T0108 BANCO', 'BANK_ACCOUNT');
INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu)
SELECT id, 'BNA_MONTHLY_PDF_V1', '0000000108', '0000000000000000000108' FROM financial_account WHERE nombre = 'T0108 BANCO';`);
expect('bank fixture: statement imported', as('service_role', null, `SELECT fin_import_bank_statement(${lit(ADMIN)}::uuid, ${P(ACCT)}::uuid, 'bna-0108', 'BNA_MONTHLY_PDF_V1', ${lit(SHA)}, 'bank/t0108.pdf', 't0108.pdf', 1024, '2026-09-30'::date, '2026-10-31'::date, ${lit(JSON.stringify({ opening_balance: '1000.00', closing_balance: '146010.00', period: 'SYNTHETIC' }))}::jsonb, NULL::uuid, NULL, ${lit(JSON.stringify(ROWS))}::jsonb)::text`, 'imp'), 'OK:%"status": "PARSED"%');
expect('bank fixture: cut on the anchor', ADM(`SELECT fin_resolve_statement_cutover(${P(ACCT)}::uuid, ${P(LINE(1))}::bigint, 1010.00, 'evidence', NULL)::text`), 'OK:%cutover_id%');
expect('bank fixture C6 60.000', ADM(collect(CA, 60000, ACCT, D, 'T0108-C6', 'TRANSFER'), 'c6'), 'OK:%');
expect('bank fixture C7 70.000', ADM(collect(CA, 70000, ACCT, D, 'T0108-C7', 'TRANSFER'), 'c7'), 'OK:%');
expect('bank fixture C8 40.000', ADM(collect(CA, 40000, ACCT, D, 'T0108-C8', 'TRANSFER'), 'c8'), 'OK:%');
expect('valid collection C6 still reconciles', ADM(match(LINE(2), POST(COL('c6'))), 'm6'), 'OK:%"replayed": false%');
expect('a reconciled collection cannot be annulled', ADM(reverse(COL('c6'), 'x', 'k-c6-matched')), 'ERR:BANK_MATCHED%');
expect('nor rectified', ADM(rectify(COL('c6'), CA, 59000, ACCT, D, 'x', 'k-c6-rect')), 'ERR:BANK_MATCHED%');
expect('after undoing the match (existing route), it can be annulled', ADM(`SELECT fin_reverse_statement_match(${P(RES('m6', 'match_id'))}::bigint, 'reconciliado por error')::text`), 'OK:%');
expect('… annul C6', ADM(reverse(COL('c6'), 'cobro inexistente', 'k-c6-annul')), 'OK:%"replayed": false%');
expect('annulled C6 cannot be reconciled again', ADM(match(LINE(2), POST(COL('c6')))), 'ERR:COLLECTION_REVERSED%');
expect('annul C7 (unmatched)', ADM(reverse(COL('c7'), 'duplicado', 'k-c7-annul')), 'OK:%');
expect('annulled C7 cannot be reconciled afterwards', ADM(match(LINE(3), POST(COL('c7')))), 'ERR:COLLECTION_REVERSED%');
expect('the compensating entry of C7 cannot be reconciled', ADM(match(LINE(4), REVPOST(COL('c7')))), 'ERR:COLLECTION_REVERSAL_NOT_MATCHABLE%');
expect('rectify C8 40.000 → 45.000 same account', ADM(rectify(COL('c8'), CA, 45000, ACCT, D, 'importe mal cargado', 'k-c8-rect'), 'r8'), 'OK:%"replayed": false%');
expect('rectified original C8 cannot be reconciled', ADM(match(LINE(5), POST(COL('c8')))), 'ERR:COLLECTION_REVERSED%');
expect('the replacement of C8 reconciles normally', ADM(match(LINE(6), POST(RES('r8', 'replacement_collection_id')))), 'OK:%"replayed": false%');
expect('view: replacement CONCILIATED, original RECTIFIED', `(SELECT string_agg(status, ',' ORDER BY status) FROM fin_customer_collections WHERE row_id IN ('C:' || ${COL('c8')}, 'C:' || ${RES('r8', 'replacement_collection_id')}))`, 'CONCILIATED,RECTIFIED');
expect('guard runs as its owner, not executable by API roles', `(SELECT prosecdef::text || ':' || has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM pg_proc WHERE proname = 'fin_statement_match_collection_reversal_guard')`, 'true:false');

// ── P&L, fiscal, immutability ───────────────────────────────────────────────
expect('P&L unchanged by annulments and rectifications', `${PNL} = (SELECT pnl FROM b0)`, 'true');
expect('fiscal tables untouched', `(SELECT count(*) FROM (${counts()}) c JOIN s1 b ON b.t = c.t WHERE c.t LIKE 'fiscal%' AND c.n <> b.n)`, '0');
expect('collection_reversal is immutable', `pg_temp.run_as('postgres', NULL, 'UPDATE collection_reversal SET reason = ''x''', NULL)`, 'ERR:%');

add('ROLLBACK;');

// ── run part 1 (rolled back) on the container behind the guarded local URL ───
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const containers = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean);
const container = containers.find((c) => (dockerRun(['port', c, '5432/tcp']).stdout || '').includes(`:${target.port}`));
if (!container) { console.error(`  no running supabase_db container mapped to the guarded port ${target.port}. Run \`supabase start\`.`); process.exit(1); }
console.log(`  container: ${container}`);
const cp = dockerRun(['exec', '-i', container, 'sh', '-c', 'cat > /tmp/0108_collection_reversal.sql'], readFileSync(MIGRATION, 'utf8'));
if (cp.status !== 0) { console.error('  could not copy the migration into the container'); process.exit(1); }
const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.replace(/^.*NOTICE:\s*/, '')).filter((l) => /^(PASS|FAIL) /.test(l));
for (const l of lines) console.log(`    ${l.startsWith('PASS') ? 'OK ' : 'MAL'}  ${l.slice(5)}`);
let pass = lines.filter((l) => l.startsWith('PASS')).length;
let fail = lines.length - pass;
if (r.status !== 0) {
  console.log(`    MAL  psql aborted: ${(`${r.stdout}\n${r.stderr}`.split('\n').find((l) => /ERROR/.test(l)) || '').slice(0, 300)}`);
  process.exit(1);
}
const ok = (name, good, detail = '') => { if (good) pass += 1; else fail += 1; console.log(`    ${good ? 'OK ' : 'MAL'}  ${name}${good || !detail ? '' : ` :: ${detail}`}`); };

// part 1 again on the disposable project, when given (e.g. a fresh 0001…0107 rebuild + the 0108 file applied by the runner)
const PROJECT1 = process.env.FIN_E2E_PROJECT ?? '';
if (PROJECT1 && PROJECT1 !== 'Claudio_app_Granja' && containers.includes(`supabase_db_${PROJECT1}`) && `supabase_db_${PROJECT1}` !== container) {
  const c1 = `supabase_db_${PROJECT1}`;
  console.log(`  part 1 again on: ${c1}`);
  dockerRun(['exec', '-i', c1, 'sh', '-c', 'cat > /tmp/0108_collection_reversal.sql'], readFileSync(MIGRATION, 'utf8'));
  const r1 = dockerRun(['exec', '-i', c1, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
  const out1 = `${r1.stdout}\n${r1.stderr}`.split('\n');
  const l1 = out1.map((l) => l.replace(/^.*NOTICE:\s*/, '')).filter((l) => /^(PASS|FAIL) /.test(l));
  for (const l of l1) ok(`[${PROJECT1}] ${l.slice(5)}`, l.startsWith('PASS'));
  if (r1.status !== 0) ok(`[${PROJECT1}] psql`, false, (out1.find((l) => /ERROR/.test(l)) || '').slice(0, 300));
}

// ── part 2: concurrency reconciliation ↔ annulment (DISPOSABLE project only; commits synthetic evidence) ──
// FIN_E2E_PROJECT names a disposable local Supabase project (never Claudio_app_Granja); its db container is reached with
// `docker exec` only (no URL, nothing leaves this machine).
const PROJECT = process.env.FIN_E2E_PROJECT ?? '';
const e2e = `supabase_db_${PROJECT}`;
if (!PROJECT || PROJECT === 'Claudio_app_Granja' || !containers.includes(e2e) || e2e === container) {
  console.log(`    --   concurrency part skipped (set FIN_E2E_PROJECT to a running disposable project id)`);
} else {
  console.log(`  concurrency container: ${e2e}`);
  const psqlArgs = ['exec', '-i', e2e, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAq'];
  const one = (q) => {
    const x = dockerRun([...psqlArgs, '-v', 'ON_ERROR_STOP=1'], q);
    if (x.status !== 0) throw new Error(x.stderr);
    return x.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  };
  const tag = randomUUID().slice(0, 8);
  const uid = randomUUID();
  const cli = randomUUID();
  one(`INSERT INTO perfiles (id, email, rol_type) VALUES ('${uid}', 'lote1e-0108-conc-${tag}@test.local', 'ADMIN');
       INSERT INTO clients (id, nombre) VALUES ('${cli}', 'Cliente 0108 conc ${tag}');`);
  const acc = one(`WITH a AS (INSERT INTO financial_account (nombre, account_type) VALUES ('T0108 CONC ${tag}', 'BANK_ACCOUNT') RETURNING id)
    INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu)
    SELECT id, 'BNA_MONTHLY_PDF_V1', '0000000109', '0000000000000000000109' FROM a RETURNING financial_account_id`);
  const rows = [{ row_number: 1, kind: 'CONTROL', control_type: 'SALDO_ANTERIOR', balance: '1000.00', raw_row: { text: 'SALDO_ANTERIOR' } },
    eco(1, '2026-10-01', 'ANCLA', '10.00', '1010.00'), eco(2, '2026-10-12', 'TRF X1', '11111.11', '12121.11'),
    eco(3, '2026-10-12', 'TRF X2', '22222.22', '34343.33'),
    { row_number: 5, kind: 'CONTROL', control_type: 'SALDO_FINAL', balance: '34343.33', raw_row: { text: 'SALDO_FINAL' } }];
  const run = one(`BEGIN; SET LOCAL ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true) \\g /dev/null
    SELECT fin_import_bank_statement('${uid}'::uuid, '${acc}'::uuid, 'bna-0108', 'BNA_MONTHLY_PDF_V1', '${createHash('sha256').update(`CONC-${tag}`).digest('hex')}',
      'bank/conc.pdf', 'conc.pdf', 1024, '2026-09-30', '2026-10-31', ${lit(JSON.stringify({ opening_balance: '1000.00', closing_balance: '34343.33', period: 'SYNTHETIC' }))}::jsonb,
      NULL, NULL, ${lit(JSON.stringify(rows))}::jsonb)->>'run_id'; COMMIT;`);
  const L = (n) => one(`SELECT statement_line_id FROM fin_import_run_line WHERE run_id = '${run}' AND statement_position = ${n}`);
  const asAdmin = (call) => `SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true) \\g /dev/null
    SELECT (${call})::text;`;
  one(`BEGIN; ${asAdmin(`fin_resolve_statement_cutover('${acc}'::uuid, ${L(1)}, 1010.00, 'ev', NULL)`)} COMMIT;`);
  const col = (amt, receipt) => JSON.parse(one(`BEGIN; ${asAdmin(`register_collection('${cli}'::uuid, ${amt}, 'TRANSFER', '${receipt}-${tag}', '2026-10-12'::date, '${acc}'::uuid, NULL, 'conc')`)} COMMIT;`)).collection_id;
  const x1 = col(11111.11, 'CONC-X1');
  const x2 = col(22222.22, 'CONC-X2');
  const post = (c) => one(`SELECT p.id FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id WHERE o.operation_type = 'COLLECTION' AND o.source_entity_id = '${c}'`);
  const reverseSql = (c, k) => `reverse_collection('${c}'::uuid, 'conc', '${k}-${tag}')`;
  const matchSql = (l, p) => `fin_match_statement_line(${l}, ${p}, 'conc')`;

  /** Session A holds its transaction for `holdMs` after its call; session B starts `delayMs` later. */
  const session = (body) => new Promise((done) => {
    const p = spawn(DOCKER, [...psqlArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => { o += d; });
    p.stderr.on('data', (d) => { o += d; });
    p.on('close', () => done(o));
    p.stdin.end(body);
  });
  const race = async (a, b, holdMs = 2500, delayMs = 600) => {
    const pa = session(`BEGIN; ${asAdmin(a)} SELECT pg_sleep(${holdMs / 1000}); COMMIT;`);
    await new Promise((x) => setTimeout(x, delayMs));
    const tb = Date.now();
    const ob = await session(`BEGIN; ${asAdmin(b)} COMMIT;`);
    return { a: await pa, b: ob, waited: Date.now() - tb };
  };

  // R1: the annulment commits first; a concurrent match of the same posting waits on its row lock, then is refused
  const r1 = await race(reverseSql(x1, 'R1'), matchSql(L(2), post(x1)));
  ok('R1 annulment committed', /"replayed": false/.test(r1.a), r1.a.slice(0, 200));
  ok('R1 concurrent match waited for the annulment (same posting lock)', r1.waited >= 1200, `waited ${r1.waited} ms`);
  ok('R1 the waiting match sees the annulment → COLLECTION_REVERSED', /COLLECTION_REVERSED/.test(r1.b), r1.b.slice(0, 200));

  // R2: the match commits first; a concurrent annulment waits on the posting lock, then sees the match and is refused
  const r2 = await race(matchSql(L(3), post(x2)), reverseSql(x2, 'R2'));
  ok('R2 match committed', /"replayed": false/.test(r2.a), r2.a.slice(0, 200));
  ok('R2 concurrent annulment waited for the match (same posting lock)', r2.waited >= 1200, `waited ${r2.waited} ms`);
  ok('R2 the waiting annulment sees the match → BANK_MATCHED', /BANK_MATCHED/.test(r2.b), r2.b.slice(0, 200));

  ok('R* invariant: no active match on a reversed collection, no reversal of a matched one',
    one(`SELECT count(*) FROM fin_statement_match m JOIN financial_operation o ON o.id = m.financial_operation_id
          JOIN collection_reversal r ON r.collection_id::text = o.source_entity_id WHERE m.reversed_at IS NULL AND o.source_entity_type = 'collections'`) === '0');
}

console.log(`  ${pass}/${pass + fail} PASS`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);
