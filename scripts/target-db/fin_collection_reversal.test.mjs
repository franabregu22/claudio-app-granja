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
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_collection_reversal.test.mjs
 */
import { spawnSync } from 'node:child_process';
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
expect('fixture C4 bank 20.000 (to be matched)', ADM(collect(CA, 20000, BNA, D, 'T0108-C4', 'TRANSFER'), 'c4'), 'OK:%');
expect('fixture C5 cash 10.000 on 2026-09-05 (period closed afterwards)', ADM(collect(CA, 10000, CAJA, '2026-09-05', 'T0108-C5'), 'c5'), 'OK:%');
// a legacy manual collection on the Mercado Pago account and a bank-statement match: test-only rows, triggers off for the insert
add(`SET LOCAL session_replication_role = replica;
INSERT INTO collections (id, cliente_id, amount, payment_method, receipt_id, effective_date, financial_account_id, created_by)
VALUES ('dddddddd-0108-0000-0000-0000000000e1', '${CA}', 5000, 'MERCADOPAGO', 'T0108-MP', '${D}', ${MPACC}, '${ADMIN}');
INSERT INTO fin_statement_match (statement_line_id, financial_operation_id, financial_posting_id, matched_by)
SELECT 999999999, o.id, p.id, '${ADMIN}' FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id
 WHERE o.operation_type = 'COLLECTION' AND o.source_entity_id = ${COL('c4')};
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
expect('bank-matched collection refused', ADM(reverse(COL('c4'), 'x', 'k-matched')), 'ERR:BANK_MATCHED%');
// test fixture: close September directly (the close guard's Mercado Pago checks belong to other tests)
add(`SET LOCAL session_replication_role = replica;
UPDATE management_period SET status = 'CLOSED', closed_at = now(), closed_by = '${ADMIN}' WHERE periodo_fecha = '2026-09-01';
SET LOCAL session_replication_role = origin;`);
expect('closed period of the original refused', ADM(reverse(COL('c5'), 'x', 'k-closed')), 'ERR:PERIOD_CLOSED%');
expect('rectification INTO a closed period refused (atomic)', ADM(rectify(COL('c3'), CA, 30000, CAJA, '2026-09-20', 'x', 'k-rect-closed')), 'ERR:PERIOD_CLOSED%');
expect('closed-period refusals wrote nothing', delta('s4'), 'none');

// ── P&L, fiscal, immutability ───────────────────────────────────────────────
expect('P&L unchanged by annulments and rectifications', `${PNL} = (SELECT pnl FROM b0)`, 'true');
expect('fiscal tables untouched', `(SELECT count(*) FROM (${counts()}) c JOIN s1 b ON b.t = c.t WHERE c.t LIKE 'fiscal%' AND c.n <> b.n)`, '0');
expect('collection_reversal is immutable', `pg_temp.run_as('postgres', NULL, 'UPDATE collection_reversal SET reason = ''x''', NULL)`, 'ERR:%');

add('ROLLBACK;');

// ── run ─────────────────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);
const cp = dockerRun(['exec', '-i', container, 'sh', '-c', 'cat > /tmp/0108_collection_reversal.sql'], readFileSync(MIGRATION, 'utf8'));
if (cp.status !== 0) { console.error('  could not copy the migration into the container'); process.exit(1); }
const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.replace(/^.*NOTICE:\s*/, '')).filter((l) => /^(PASS|FAIL) /.test(l));
for (const l of lines) console.log(`    ${l.startsWith('PASS') ? 'OK ' : 'MAL'}  ${l.slice(5)}`);
const fails = lines.filter((l) => l.startsWith('FAIL')).length;
if (r.status !== 0) {
  console.log(`    MAL  psql aborted: ${(`${r.stdout}\n${r.stderr}`.split('\n').find((l) => /ERROR/.test(l)) || '').slice(0, 300)}`);
  process.exit(1);
}
console.log(`  ${lines.length - fails}/${lines.length} PASS`);
process.exit(fails === 0 && lines.length > 0 ? 0 : 1);
