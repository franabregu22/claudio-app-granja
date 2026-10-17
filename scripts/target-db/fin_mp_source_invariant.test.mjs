#!/usr/bin/env node
/**
 * META A — GLOBAL MERCADO PAGO SOURCE INVARIANT (migration 0091). LOCAL TEST DATABASE ONLY.
 *
 * Every NEW operation moving the Mercado Pago account must be linked in the same transaction to an MP movement or to an
 * audited exception: manual routes on Mercado Pago are refused (Cobros, Tesorería, Cuentas a pagar, Retiro de socios),
 * other accounts unchanged; linked routes (payout / outbound classification, A1) pass; deferred semantics; the cutover
 * opening exception; mp_admin_correction (ADMIN, evidence, audit, idempotent).
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_mp_source_invariant.test.mjs
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
const ADMIN = 'aaaaaaaa-0091-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0091-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`META-A-0091-${seed}`).digest('hex');
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
  ('${ADMIN}', 'meta-a-0091-admin@test.local', 'ADMIN'),
  ('${OPER}',  'meta-a-0091-oper@test.local',  'OPERATOR');`);

// ── fixtures ────────────────────────────────────────────────────────────────
const SUP = 'cccccccc-0091-0000-0000-0000000000a1';
const CAT = 'cccccccc-0091-0000-0000-0000000000c1';
const CLI = 'cccccccc-0091-0000-0000-0000000000d1';
add(`INSERT INTO suppliers (id, nombre) VALUES ('${SUP}', 'Proveedor 0091');
INSERT INTO expense_category (id, nombre, pnl_cost_class) VALUES ('${CAT}', 'Categoría 0091', 'INDIRECT');
INSERT INTO clients (id, nombre) VALUES ('${CLI}', 'Cliente 0091');
-- every call is checked as at its own COMMIT: the deferred invariant is forced at the end of the call, inside the call's
-- subtransaction (a violation rolls the call back and is reported as its error)
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
const A = (sql) => as('authenticated', ADMIN, sql);
const D = DAY;

// A. manual routes on Mercado Pago are refused; the same routes on other accounts are unchanged
expect('A-1 Cobro manual to Mercado Pago → MP_POSTING_REQUIRES_SOURCE; to Caja chica → OK',
  `(${A(`SELECT register_collection('${CLI}'::uuid, 1000, 'MERCADOPAGO', 'INV-0091-1', '${D}'::date, ${P(ACC('Mercado Pago'))}::uuid)::text`)}
    || '|' || ${A(`SELECT register_collection('${CLI}'::uuid, 1000, 'CASH', 'INV-0091-2', '${D}'::date, ${P(ACC('Caja chica'))}::uuid)::text`)})`,
  'ERR:MP_POSTING_REQUIRES_SOURCE%|OK:%');
expect('A-2 Tesorería transfer BNA → MP and MP → BNA refused; BNA → Caja chica OK',
  `(${A(`SELECT transfer_between_accounts(${P(ACC('BNA'))}::uuid, ${P(ACC('Mercado Pago'))}::uuid, 500, '${D}'::date, 'INV-0091-T1')::text`)}
    || '|' || ${A(`SELECT transfer_between_accounts(${P(ACC('Mercado Pago'))}::uuid, ${P(ACC('BNA'))}::uuid, 500, '${D}'::date, 'INV-0091-T2')::text`)}
    || '|' || ${A(`SELECT transfer_between_accounts(${P(ACC('BNA'))}::uuid, ${P(ACC('Caja chica'))}::uuid, 500, '${D}'::date, 'INV-0091-T3')::text`)})`,
  'ERR:MP_POSTING_REQUIRES_SOURCE%|ERR:MP_POSTING_REQUIRES_SOURCE%|OK:%');
expect('A-3 Cuentas a pagar from Mercado Pago refused; from BNA OK',
  `(${A(`SELECT pay_supplier('${SUP}'::uuid, 700, '${D}'::date, 'TRANSFER', ${P(ACC('Mercado Pago'))}::uuid, 'INV-0091-P1')::text`)}
    || '|' || ${A(`SELECT pay_supplier('${SUP}'::uuid, 700, '${D}'::date, 'TRANSFER', ${P(ACC('BNA'))}::uuid, 'INV-0091-P2')::text`)})`,
  'ERR:MP_POSTING_REQUIRES_SOURCE%|OK:%');
expect('A-4 Retiro de socios (Finanzas) from Mercado Pago refused; from Caja chica OK',
  `(${A(`SELECT register_management_event('RETIRO', '${D}'::date, 300, 'INV-0091-R1', 'retiro', ${P(ACC('Mercado Pago'))}::uuid)::text`)}
    || '|' || ${A(`SELECT register_management_event('RETIRO', '${D}'::date, 300, 'INV-0091-R2', 'retiro', ${P(ACC('Caja chica'))}::uuid)::text`)})`,
  'ERR:MP_POSTING_REQUIRES_SOURCE%|OK:%');
expect('A-5 Compras: a casual purchase paid from Mercado Pago without SOURCE_ID is refused (gateway)',
  A(`SELECT register_casual_purchase('${D}'::date, 10, 10, '${CAT}'::uuid, 'x', 'OPERATING', ${P(ACC('Mercado Pago'))}::uuid, 'MERCADOPAGO', 'INV-0091-C1')::text`), 'ERR:MP_SOURCE_REQUIRED%');

// B. linked routes keep working under statement-level checking: payout and outbound classification, A1 auto-application
const SIDP = '891000000001';
const SIDO = '891000000002';
const DAYROWS = [CTL, mv('10:00:00', SIDP, 'payout', '0.00', '400.00', '-400.00', '0.00', '0.00', 'available_money', ''),
  mv('11:00:00', SIDO, 'payment', '0.00', '201.20', '-200.00', '-1.20', '0.00', 'available_money', 'account_money'), TOT];
expect('B-0 report day ingested (one payout, one outbound payment); payout destination third party',
  `(${NORMAL({ sha: sha('invariant-day'), actor: null, rows: rowsOf(DAYROWS) }, 'R')} LIKE 'OK:%PARSED%' AND ${as('service_role', null,
    `SELECT fin_record_mp_payout_destinations(${P(RES('R'))}::uuid, jsonb_build_array(jsonb_build_object('row_number', 2, 'value', '2850590940090418135201')))::text`)} = 'OK:1')::text`, 'true');
expect('B-1 payout classified (casual purchase from MP, linked) → OK', A(`SELECT mp_classify_payout_outflow('${SIDP}', 'CASUAL_PURCHASE', NULL, '${CAT}'::uuid, NULL, 'Compra', NULL, NULL)::text`), 'OK:%"replayed": false%');
expect('B-2 outbound payment classified (partner withdrawal + tax, linked) → OK', A(`SELECT mp_classify_payout_outflow('${SIDO}', 'OWNER_WITHDRAWAL', NULL, NULL, NULL, NULL, NULL, NULL)::text`), 'OK:%"replayed": false%');
const svc = (sql, key = null) => as('service_role', null, sql, key);
const PID = '891000000003';
const at = '2026-11-05T10:00:00.000-04:00';
const pl = { id: Number(PID), operation_type: 'money_transfer', payment_method_id: 'account_money', payment_type_id: 'account_money', status: 'approved', status_detail: 'accredited',
  currency_id: 'ARS', live_mode: true, collector_id: 100000001, payer: { id: '800000997' }, external_reference: null, date_created: at, date_approved: at, date_last_updated: at,
  transaction_amount: 5000, transaction_details: { net_received_amount: 5000 }, fee_details: [], refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
expect('B-3 webhook payment registered, claimed, snapshot, normalized', `(${svc(`SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', '${PID}', NULL, 'T91', ${lit(JSON.stringify({ notification_id: `t91-${PID}` }))}::jsonb, true)::text`)} LIKE 'OK:%')::text`, 'true');
expect('B-3b claimed', svc(`SELECT row_to_json(c)::text FROM mp_claim_deliveries(50, 120) c WHERE c.resource_id = '${PID}'`, 'C'), 'OK:%');
expect('B-3c snapshot', svc(`SELECT mp_ingest_api_snapshot(${P(RES('C', 'delivery_id'))}::uuid, ${P(RES('C', 'claim_token'))}::uuid, '${PID}', ${lit(JSON.stringify(pl))}::jsonb)::text`, 'I'), 'OK:%');
expect('B-3d normalized', svc(`SELECT mp_normalize_source(${P(RES('I', 'source_record_id'))}::uuid)::text`), 'OK:%NORMALIZED%');
expect('B-4 A1 automatic application (MP_SETTLEMENT on Mercado Pago, linked) → OK',
  svc(`SELECT mp_apply_transition(${P(`(SELECT t.mp_financial_movement_id FROM mp_transition_identity t WHERE t.resource_type = 'payment' AND t.resource_id = '${PID}' AND t.transition = 'APPROVAL')`)})::text`), 'OK:%APPLIED%');

// C. deferred semantics, the cutover opening and the explicit ADMIN exception
const RAWOP = (ref, src = 'manual') => `INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type) VALUES (''ADJUSTMENT'', ''${D}'', ''${ref}'', ''${src}'');
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date) SELECT id, ${ACC('Mercado Pago').replace(/'/g, "''")}, 1, ''${D}'' FROM financial_operation WHERE external_ref = ''${ref}'';`;
expect('C-1 deferred: a posting whose exception row is written later in the same transaction passes at the check',
  `pg_temp.err_of('DO $x$ BEGIN SET CONSTRAINTS trg_mp_account_posting_source DEFERRED; ${RAWOP('INV-0091-D1')}
     INSERT INTO mp_source_exception (financial_operation_id, kind, amount, reason, evidence_ref) SELECT id, ''ADMIN_CORRECTION'', 1, ''t'', ''t'' FROM financial_operation WHERE external_ref = ''INV-0091-D1'';
     SET CONSTRAINTS trg_mp_account_posting_source IMMEDIATE; END $x$')`, 'OK');
expect('C-2 deferred: without any link the check refuses (MP_POSTING_REQUIRES_SOURCE)',
  `pg_temp.err_of('DO $x$ BEGIN SET CONSTRAINTS trg_mp_account_posting_source DEFERRED; ${RAWOP('INV-0091-D2')} SET CONSTRAINTS trg_mp_account_posting_source IMMEDIATE; END $x$')`,
  'ERR:MP_POSTING_REQUIRES_SOURCE%');
expect('C-3 the cutover opening (phase31_opening) is the named historical exception',
  `pg_temp.err_of('DO $x$ BEGIN ${RAWOP('INV-0091-D3', 'phase31_opening')} END $x$')`, 'OK');
const CORR = (amount, key, evidence = 'Extracto MP 14/10', role = 'authenticated', uid = ADMIN) =>
  as(role, uid, `SELECT mp_admin_correction(${amount}, '${D}'::date, 'Corrección excepcional', ${lit(evidence)}, ${lit(key)})::text`);
expect('C-4 mp_admin_correction: ADJUSTMENT on Mercado Pago with its exception row → OK', CORR(-12.34, 'K1'), 'OK:%"replayed": false%');
expect('C-5 exception row: kind ADMIN_CORRECTION, amount, evidence; audit MP_ADMIN_CORRECTION',
  `(SELECT e.kind || ':' || e.amount || ':' || e.evidence_ref || ':' || (SELECT count(*) FROM audit_events a WHERE a.entity_type = 'mp_source_exception' AND a.entity_id = e.id::text AND a.action = 'MP_ADMIN_CORRECTION')
     FROM mp_source_exception e JOIN financial_operation o ON o.id = e.financial_operation_id WHERE o.external_ref = 'MP-ADMIN-CORRECTION:K1')`, 'ADMIN_CORRECTION:-12.34:Extracto MP 14/10:1');
expect('C-6 replay → replayed; other values with the same key → DUPLICATE_CORRECTION; no evidence → EVIDENCE_REQUIRED; OPERATOR → FORBIDDEN',
  `(${CORR(-12.34, 'K1')} || '|' || ${CORR(-99, 'K1')} || '|' || ${CORR(-1, 'K2', '  ')} || '|' || ${CORR(-1, 'K3', 'x', 'authenticated', OPER)})`,
  'OK:%"replayed": true%|ERR:DUPLICATE_CORRECTION%|ERR:EVIDENCE_REQUIRED%|ERR:FORBIDDEN%');
expect('C-7 exception rows immutable; no direct write for ADMIN',
  `(pg_temp.err_of('UPDATE mp_source_exception SET amount = 1') LIKE 'ERR:%' AND ${A(`INSERT INTO mp_source_exception (financial_operation_id, kind, amount, reason, evidence_ref) VALUES (1, 'ADMIN_CORRECTION', 1, 'x', 'x') RETURNING 'x'`)} LIKE 'ERR:permission denied%')::text`, 'true');

// Z. perimeter
expect('Z-1 constraint trigger: deferrable, initially deferred, on financial_posting; guard SECURITY DEFINER with no API EXECUTE',
  `((SELECT tgdeferrable || ':' || tginitdeferred || ':' || tgrelid::regclass FROM pg_trigger WHERE tgname = 'trg_mp_account_posting_source')
     || '|' || (SELECT prosecdef || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'mp_account_posting_guard'))`,
  'true:true:financial_posting|true:falsefalse');
expect('Z-2 mp_admin_correction: DEFINER, EXECUTE authenticated only', `(SELECT prosecdef || ':' || has_function_privilege('anon', oid, 'EXECUTE') || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'mp_admin_correction')`,
  'true:falsetruefalse');
expect('Z-3 SECURITY DEFINER set = 94 (85 + mp_account_posting_guard + mp_admin_correction)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '94');

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
console.log(`\n  ══ META A 0091 MP SOURCE INVARIANT RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
