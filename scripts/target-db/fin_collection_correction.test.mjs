#!/usr/bin/env node
/**
 * META A — MANUAL MP COLLECTION CORRECTIONS + CUSTOMER COLLECTIONS (migration 0092). LOCAL TEST DATABASE ONLY.
 *
 * The four owner decisions on legacy manual collections posted on Mercado Pago: 450k / 72k (same money as a real MP
 * payment), 100k (cash + partner withdrawal), 200k (MP 150k + cash 50k): append-only, idempotent, audited, customer
 * balances unchanged, Mercado Pago corrected; refusals; the Caja → Cobros de clientes view (grouping, statuses, ADMIN).
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_collection_correction.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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

// ── SQL helpers ──────────────────────────────────────────────────────────────
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0092-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0092-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`META-A-0092-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved by run_as as the owner, before the role switch
const PARSER = 'mp-release-report-csv/1.1.0';
const DAY = '2026-10-13';
const FORMAT = 'MP_RELEASE_REPORT_CSV_V1';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);

const EMPTY = { BALANCE_AMOUNT: '', BUSINESS_UNIT: '', DATE: '', DESCRIPTION: '', GROSS_AMOUNT: '', MP_FEE_AMOUNT: '',
  NET_CREDIT_AMOUNT: '', NET_DEBIT_AMOUNT: '', PAYMENT_METHOD: '', PAYMENT_METHOD_TYPE: '', PURCHASE_ID: '', SOURCE_ID: '',
  SUB_UNIT: '', TAXES_AMOUNT: '', TRANSACTION_APPROVAL_DATE: '' };
const mv = (t, sid, desc, credit, debit, gross, tax, bal, method = 'available_money', type = 'account_money') => ({
  ...EMPTY, DATE: `${DAY}T${t}.000-03:00`, SOURCE_ID: sid, DESCRIPTION: desc, NET_CREDIT_AMOUNT: credit, NET_DEBIT_AMOUNT: debit,
  GROSS_AMOUNT: gross, MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: tax, PAYMENT_METHOD: method, TRANSACTION_APPROVAL_DATE: `${DAY}T${t}.000-03:00`,
  BALANCE_AMOUNT: bal, PAYMENT_METHOD_TYPE: type });
const CTL = { ...EMPTY, DATE: `${DAY}T00:00:00.000-03:00`, NET_CREDIT_AMOUNT: '10000.00', NET_DEBIT_AMOUNT: '0.00',
  GROSS_AMOUNT: '10000.00', MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '10000.00' };
const TOT = { ...EMPTY, NET_CREDIT_AMOUNT: '0.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '-762462.72', MP_FEE_AMOUNT: '0.00',
  TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '0.00' };
const rowsOf = (raws) => raws.map((raw_row, i) => ({ row_number: i + 1, raw_row }));

function captureCall(o) {
  const s = o.sha;
  return `SELECT ${o.fn ?? 'fin_capture_mp_release_report'}(${lit(o.actor === undefined ? ADMIN : o.actor)}::uuid, ${lit(PARSER)},
    ${lit(FORMAT)}, ${lit(s)}, ${P(`'mp/' || ${MPACC} || '/${s}.csv'`)}, 'release-report.csv', 2048,
    ${lit(DAY)}::date, ${lit(DAY)}::date, ${lit(JSON.stringify({ report_type: 'release_report', task_id: '1' }))}::jsonb,
    NULL, ${lit(JSON.stringify(o.rows))}::jsonb)::text`;
}
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const NORMAL = (o, key) => as('service_role', null, captureCall({ ...o, fn: 'fin_ingest_mp_release_report' }), key);

const FIN_TABLES = ['financial_operation', 'financial_posting', 'mp_reconciliation', 'mp_financial_movement', 'mp_transition_identity',
  'mp_source_record', 'fin_mp_payout_destination', 'fin_import_run_line', 'mp_client_allocation', 'fin_statement_line', 'fin_statement_match', 'purchases', 'management_event', 'suppliers'];
const counts = () => FIN_TABLES.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const delta = (snap) => `(SELECT string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t) FROM (${counts()}) c JOIN ${snap} b ON b.t = c.t WHERE c.n <> b.n)`;
const BAL = (acc) => `(SELECT coalesce(sum(p.signed_amount), 0) FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id WHERE a.nombre = '${acc}')`;
const PNL = `SELECT md5(coalesce((SELECT string_agg(x::text, '#' ORDER BY x::text) FROM pnl_summary x), '')) || md5(coalesce((SELECT string_agg(x::text, '#' ORDER BY x::text) FROM pnl_line_item x), ''))`;

add(`\\set ON_ERROR_STOP 1
BEGIN;
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
    PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
                                                  ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
    EXECUTE p_sql INTO v;
    ok := true;
    RESET ROLE;
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
CREATE FUNCTION pg_temp.err_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN others THEN RETURN 'ERR:' || SQLERRM; END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'meta-a-0092-admin@test.local', 'ADMIN'),
  ('${OPER}',  'meta-a-0092-oper@test.local',  'OPERATOR');`);

// ── fixtures ────────────────────────────────────────────────────────────────
const CA = 'cccccccc-0092-0000-0000-0000000000d1';   // Verdulería (450k)
const CB = 'cccccccc-0092-0000-0000-0000000000d2';   // 72k
const CC = 'cccccccc-0092-0000-0000-0000000000d3';   // 100k + 200k
add(`INSERT INTO clients (id, nombre) VALUES ('${CA}', 'Cliente 0092 A'), ('${CB}', 'Cliente 0092 B'), ('${CC}', 'Cliente 0092 C');
-- every call is checked as at its own COMMIT (the 0091 invariant forced at the end of the call)
CREATE OR REPLACE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT, p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
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
    PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
                                                  ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
    SET CONSTRAINTS trg_mp_account_posting_source DEFERRED;
    EXECUTE p_sql INTO v;
    SET CONSTRAINTS trg_mp_account_posting_source IMMEDIATE;
    SET CONSTRAINTS trg_mp_account_posting_source DEFERRED;
    ok := true;
    RESET ROLE;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    RESET ROLE;
  END;
  IF ok AND p_key IS NOT NULL THEN
    INSERT INTO res VALUES (p_key, v::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
  END IF;
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || msg END;
END $f$;`);
const ACC = (n) => `(SELECT id FROM financial_account WHERE nombre = '${n}')`;
const A = (sql, key = null) => as('authenticated', ADMIN, sql, key);
const svc = (sql, key = null) => as('service_role', null, sql, key);

// real MP payments through the pipeline (A1 applied)
function payment(k, pid, amount, day) {
  const at = `${day}T10:00:00.000-03:00`;
  const pl = { id: Number(pid), operation_type: 'money_transfer', payment_method_id: 'account_money', payment_type_id: 'account_money', status: 'approved', status_detail: 'accredited',
    currency_id: 'ARS', live_mode: true, collector_id: 100000001, payer: { id: '800000996' }, external_reference: null, date_created: at, date_approved: at, date_last_updated: at,
    transaction_amount: amount, transaction_details: { net_received_amount: amount }, fee_details: [], refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
  expect(`${k}: payment registered / claimed / snapshot / normalized / applied`,
    `(${svc(`SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', '${pid}', NULL, 'T92', ${lit(JSON.stringify({ notification_id: `t92-${pid}` }))}::jsonb, true)::text`)} LIKE 'OK:%')::text`, 'true');
  expect(`${k}: claimed`, svc(`SELECT row_to_json(c)::text FROM mp_claim_deliveries(50, 120) c WHERE c.resource_id = '${pid}'`, `${k}_c`), 'OK:%');
  expect(`${k}: snapshot`, svc(`SELECT mp_ingest_api_snapshot(${P(RES(`${k}_c`, 'delivery_id'))}::uuid, ${P(RES(`${k}_c`, 'claim_token'))}::uuid, '${pid}', ${lit(JSON.stringify(pl))}::jsonb)::text`, `${k}_i`), 'OK:%');
  expect(`${k}: normalized`, svc(`SELECT mp_normalize_source(${P(RES(`${k}_i`, 'source_record_id'))}::uuid)::text`), 'OK:%NORMALIZED%');
  expect(`${k}: applied (A1)`, svc(`SELECT mp_apply_transition(${P(`(SELECT t.mp_financial_movement_id FROM mp_transition_identity t WHERE t.resource_type = 'payment' AND t.resource_id = '${pid}' AND t.transition = 'APPROVAL')`)})::text`), 'OK:%APPLIED%');
}
const P450 = '892000000450', P72 = '892000000072', P150 = '892000000150', PX = '892000000999';
payment('P450', P450, 450000, '2026-10-05');
payment('P72', P72, 72000, '2026-10-07');
payment('P150', P150, 150000, '2026-10-10');
payment('PX', PX, 10000, '2026-10-07');
const PY = '892000000030';
payment('PY', PY, 30000, '2026-10-07');
expect('S-1 PX already imputed to a customer (to test the refusal)', A(`SELECT mp_allocate_to_client(${P(`(SELECT mp_financial_movement_id FROM mp_transition_identity WHERE resource_type = 'payment' AND resource_id = '${PX}')`)}::bigint, '${CB}'::uuid, 10000, '2026-10-07', 'T92-PX', 'test')::text`), 'OK:%');

// the four legacy manual collections on Mercado Pago (written before 0091: the guard is disabled for this setup only)
add(`ALTER TABLE financial_posting DISABLE TRIGGER trg_mp_account_posting_source;`);
const COL = (k, cli, amount, day, reason) => expect(`S-2 legacy manual MP collection ${k}`,
  A(`SELECT register_collection('${cli}'::uuid, ${amount}, 'MERCADOPAGO', 'T92-${k}', '${day}'::date, ${P(ACC('Mercado Pago'))}::uuid, NULL, ${lit(reason)})::text`, `COL${k}`), 'OK:%');
COL('450', CA, 450000, '2026-10-07', null);
COL('72', CB, 72000, '2026-10-07', null);
COL('100', CC, 100000, '2026-10-09', 'MP Santi');
COL('200', CC, 200000, '2026-10-10', '150 a la granja y 50 a pivi feria 10/10');
COL('BNA', CB, 5000, '2026-10-07', null);
add(`ALTER TABLE financial_posting ENABLE TRIGGER trg_mp_account_posting_source;
UPDATE collections SET financial_account_id = (SELECT id FROM financial_account WHERE nombre = 'BNA') WHERE receipt_id = 'T92-BNA';`);
const CID = (k) => `(SELECT id FROM collections WHERE receipt_id = 'T92-${k}')`;
const CLIBAL = (cli) => `(SELECT coalesce(sum(signed_amount), 0) FROM client_ledger WHERE cliente_id = '${cli}')`;
add(`CREATE TEMP TABLE b0 AS SELECT ${BAL('Mercado Pago')} AS mp, ${BAL('Caja chica')} AS caja, ${CLIBAL(CA)} AS ca, ${CLIBAL(CB)} AS cb, ${CLIBAL(CC)} AS cc;
CREATE TEMP TABLE c0 AS ${counts()};`);
const CORR = (k, sid, cash, wd, key = null, role = 'authenticated', uid = ADMIN) =>
  as(role, uid, `SELECT mp_correct_manual_collection(${P(CID(k))}::uuid, ${lit(sid)}, ${cash}, ${wd}, 'Corrección owner META A')::text`, key);

// K. the four owner decisions
expect('K-1 450k → same money as the real MP payment: reversed + MP payment imputed to the customer', CORR('450', P450, 0, false), 'OK:%"replayed": false%');
expect('K-2 72k → same correction', CORR('72', P72, 0, false), 'OK:%"replayed": false%');
expect('K-3 100k → cash collection + partner withdrawal from Caja', CORR('100', null, 100000, true), 'OK:%"replayed": false%');
expect('K-4 200k → MP 150k (real payment) + Caja 50k', CORR('200', P150, 50000, false), 'OK:%"replayed": false%');
expect('K-5 balances: MP −822,000; Caja +50,000 (100k in and out, 50k kept); customers unchanged',
  `((SELECT ${BAL('Mercado Pago')} - mp FROM b0) || '|' || (SELECT ${BAL('Caja chica')} - caja FROM b0) || '|' || (SELECT ${CLIBAL(CA)} - ca FROM b0) || '|' || (SELECT ${CLIBAL(CB)} - cb FROM b0) || '|' || (SELECT ${CLIBAL(CC)} - cc FROM b0))`,
  '-822000.00|50000.00|0.00|0.00|0.00');
expect('K-6 the real MP payments are imputed to the customers (450k → A, 72k → B, 150k → C); none twice',
  `(SELECT string_agg(t.resource_id || ':' || al.amount || ':' || (al.cliente_id = CASE t.resource_id WHEN '${P450}' THEN '${CA}'::uuid WHEN '${P72}' THEN '${CB}'::uuid ELSE '${CC}'::uuid END), ',' ORDER BY t.resource_id)
     FROM mp_client_allocation al JOIN mp_transition_identity t ON t.mp_financial_movement_id = al.mp_financial_movement_id WHERE t.resource_id IN ('${P450}', '${P72}', '${P150}'))`,
  `${P72}:72000.00:true,${P150}:150000.00:true,${P450}:450000.00:true`);
expect('K-7 history kept: the 4 original collections and their COLLECTION operations still exist; 4 audited exceptions; 1 partner withdrawal; 2 cash collections',
  `((SELECT count(*) FROM collections WHERE receipt_id IN ('T92-450', 'T92-72', 'T92-100', 'T92-200')) || ':' || (SELECT count(*) FROM financial_operation WHERE operation_type = 'COLLECTION' AND external_ref IN ('T92-450', 'T92-72', 'T92-100', 'T92-200'))
     || ':' || (SELECT count(*) FROM mp_source_exception WHERE kind = 'COLLECTION_CORRECTION') || ':' || (SELECT count(*) FROM management_event WHERE idempotency_key LIKE 'COLLECTION-CORRECTION-RETIRO:%')
     || ':' || (SELECT count(*) FROM collections WHERE receipt_id LIKE 'COLLECTION-CORRECTION-CASH:%'))`, '4:4:4:1:2');
add(`CREATE TEMP TABLE c1 AS ${counts()};`);
expect('K-8 exact replay of every correction → replayed, nothing written',
  `((${CORR('450', P450, 0, false)} || ${CORR('72', P72, 0, false)} || ${CORR('100', null, 100000, true)} || ${CORR('200', P150, 50000, false)}) LIKE '%"replayed": true%"replayed": true%"replayed": true%"replayed": true%'
     AND coalesce(${delta('c1')}, 'none') = 'none')::text`, 'true');
expect('K-9 a different correction of a corrected collection → ALREADY_CORRECTED', CORR('450', null, 450000, false), 'ERR:ALREADY_CORRECTED%');

// E. refusals
add(`ALTER TABLE financial_posting DISABLE TRIGGER trg_mp_account_posting_source;`);
COL('E1', CA, 72000, '2026-10-07', null);
COL('E2', CB, 10000, '2026-10-07', null);
add(`ALTER TABLE financial_posting ENABLE TRIGGER trg_mp_account_posting_source;`);
expect('E-1 wrong MP payment amount → MP_AMOUNT_MISMATCH; already imputed payment → PAYMENT_ALREADY_ALLOCATED; MP part without SOURCE_ID → MP_SOURCE_REQUIRED',
  `(${CORR('E1', PY, 0, false)} || '|' || ${CORR('E2', PX, 0, false)} || '|' || ${CORR('E1', null, 0, false)})`,
  'ERR:MP_AMOUNT_MISMATCH%|ERR:PAYMENT_ALREADY_ALLOCATED%|ERR:MP_SOURCE_REQUIRED%');
expect('E-2 cash above the amount; withdrawal without cash; a bank collection; OPERATOR',
  `(${CORR('E1', null, 99999999, false)} || '|' || ${CORR('E1', P72, 0, true)} || '|' || ${CORR('BNA', null, 5000, false)} || '|' || ${CORR('E1', null, 72000, false, null, 'authenticated', OPER)})`,
  'ERR:INVALID_CASH_AMOUNT%|ERR:WITHDRAWAL_REQUIRES_CASH%|ERR:NOT_A_MANUAL_MP_COLLECTION%|ERR:FORBIDDEN%');

// V. Caja → Cobros de clientes
const VIEW = A(`SELECT string_agg(client_name || ':' || amount || ':' || account_name || ':' || origin || ':' || status || ':' || correction_role || ':' || counts_for_customer || ':' || coalesce(source_id, '-'), ',' ORDER BY client_name, correction_role DESC, account_name, amount DESC)
  FROM fin_customer_collections WHERE cliente_id IN ('${CA}', '${CC}')`);
expect('V-1 grouped: 450k corrected → MP payment component; 100k → cash component; 200k → MP 150k + Caja 50k components',
  VIEW, `OK:Cliente 0092 A:72000.00:Mercado Pago:MANUAL_MP:MANUAL_WITHOUT_SOURCE:SINGLE:true:-,Cliente 0092 A:450000.00:Mercado Pago:MANUAL_MP:CORRECTED:CORRECTED_ORIGINAL:false:-,Cliente 0092 A:450000.00:Mercado Pago:CORRECTION:ALLOCATED_TO_CUSTOMER:COMPONENT:true:${P450},`
  + `Cliente 0092 C:200000.00:Mercado Pago:MANUAL_MP:CORRECTED:CORRECTED_ORIGINAL:false:-,Cliente 0092 C:100000.00:Mercado Pago:MANUAL_MP:CORRECTED:CORRECTED_ORIGINAL:false:-,`
  + `Cliente 0092 C:100000.00:Caja chica:CORRECTION:CASH:COMPONENT:true:-,Cliente 0092 C:50000.00:Caja chica:CORRECTION:CASH:COMPONENT:true:-,Cliente 0092 C:150000.00:Mercado Pago:CORRECTION:ALLOCATED_TO_CUSTOMER:COMPONENT:true:${P150}`);
expect('V-2 what the customer counts equals the customer ledger credit (collections + allocations − reversals)',
  A(`SELECT (sum(amount) FILTER (WHERE counts_for_customer))::text FROM fin_customer_collections WHERE cliente_id = '${CC}'`), 'OK:300000.00');
expect('V-3 a bank collection reads BANK / PENDING_RECONCILIATION', A(`SELECT origin || ':' || status FROM fin_customer_collections WHERE row_id = 'C:' || ${P(CID('BNA'))}`), 'OK:BANK:PENDING_RECONCILIATION');
expect('V-4 the view exposes no CBU / CVU / payer data (columns)', `(SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'fin_customer_collections')`,
  'row_id,business_date,created_at,cliente_id,client_name,amount,account_name,account_type,payment_method,notes,financial_operation_id,source_id,origin,status,correction_id,correction_role,counts_for_customer');
expect('V-5 OPERATOR sees no row', as('authenticated', OPER, `SELECT count(*)::text FROM fin_customer_collections`), 'OK:0');

// Z. perimeter
expect('Z-1 table: RLS, ADMIN SELECT only, immutable; RPC DEFINER, EXECUTE authenticated only',
  `((SELECT relrowsecurity FROM pg_class WHERE relname = 'collection_correction') AND (SELECT string_agg(policyname, ',') FROM pg_policies WHERE tablename = 'collection_correction') = 'collection_correction_admin_select'
     AND pg_temp.err_of('UPDATE collection_correction SET reason = ''x''') LIKE 'ERR:%'
     AND (SELECT prosecdef AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('service_role', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'mp_correct_manual_collection'))::text`, 'true');
expect('Z-2 SECURITY DEFINER set = 91 (87 + mp_correct_manual_collection)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '91');

add('ROLLBACK;');

// ── run ──────────────────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);

const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const lines = `${r.stdout}\n${r.stderr}`.split('\n');
let pass = 0;
let fail = 0;
for (const l of lines) {
  const m = l.match(/NOTICE:\s+(PASS|FAIL) (.*)$/);
  if (m) {
    if (m[1] === 'PASS') { pass += 1; console.log(`    OK   ${m[2]}`); } else { fail += 1; console.log(`    MAL  ${m[2]}`); }
  }
}
if (r.status !== 0) {
  fail += 1;
  console.log(`    MAL  psql aborted: ${(lines.find((l) => /ERROR/.test(l)) || r.stderr || '').slice(0, 300)}`);
}
console.log(`\n  ══ META A 0092 COLLECTION CORRECTION RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
