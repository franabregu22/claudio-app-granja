#!/usr/bin/env node
/**
 * ADR-024 — MERCADO PAGO PAYER PRIVACY + SAFE PAYER DISPLAY (migration 0097). LOCAL TEST DATABASE ONLY.
 *
 * Live payments with the field shapes of the owner's read-only proof (synthetic values): the display name comes from the bank
 * holder (DEBIN) or the cardholder (card), else nothing (CVU / account money fall back to the type); payer.id stays the only
 * identity (mapping + mp_auto_allocate unchanged); the raw payload is not readable by any API role while the service role keeps
 * it; no email / document / phone / bank identifier in any ADMIN-readable MP view; ADR-023 semantics unchanged.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_mp_payer_privacy.test.mjs
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
const ADMIN = 'aaaaaaaa-0097-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0097-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR024-0097-${seed}`).digest('hex');
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
CREATE FUNCTION pg_temp.must(p_name TEXT, p_got TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE 'OK:%' THEN RAISE NOTICE 'FAIL setup % :: %', p_name, left(p_got, 300); END IF;
END $f$;
CREATE FUNCTION pg_temp.err_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN others THEN RETURN 'ERR:' || SQLERRM; END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'adr024-0097-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr024-0097-oper@test.local',  'OPERATOR');`);

// ── fixtures: live payments with the real field shapes of the owner's read-only proof (values synthetic) ──
const CLI = 'cccccccc-0097-0000-0000-0000000000d1';
add(`INSERT INTO clients (id, nombre) VALUES ('${CLI}', 'Cliente ADR-024');`);
const SECRET_EMAIL = 'pagador.adr024@example.invalid';
const SECRET_DOC = '27999888';
const SECRET_PHONE = '1155550000';
const SECRET_BANK = '9999999999999999990777';
const svc = (q, key = null) => as('service_role', null, q, key);
const A = (q, key = null) => as('authenticated', ADMIN, q, key);
function payment(k, pid, opType, method, amount, extra = {}) {
  const at = '2026-11-05T10:00:00.000-03:00';
  const pl = { id: Number(pid), operation_type: opType, payment_method_id: method, payment_type_id: method === 'account_money' ? 'account_money' : (method === 'visa' ? 'credit_card' : 'bank_transfer'),
    status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true, collector_id: 100000001,
    payer: { id: extra.payerId ?? '800000997', email: SECRET_EMAIL, identification: { type: 'DNI', number: SECRET_DOC }, phone: { number: SECRET_PHONE }, first_name: null, last_name: null },
    description: extra.description ?? 'Transferencia', external_reference: null, date_created: at, date_approved: at, date_last_updated: at, transaction_amount: amount,
    transaction_details: { net_received_amount: amount }, fee_details: [], refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [], ...(extra.payload ?? {}) };
  add(`SELECT pg_temp.must(${lit(`${k} delivery`)}, ${svc(`SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', '${pid}', NULL, 'T97', ${lit(JSON.stringify({ notification_id: `t97-${pid}` }))}::jsonb, true)::text`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} claim`)}, ${svc(`SELECT row_to_json(c)::text FROM mp_claim_deliveries(50, 120) c WHERE c.resource_id = '${pid}'`, `${k}_c`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} snapshot`)}, ${svc(`SELECT mp_ingest_api_snapshot(${P(RES(`${k}_c`, 'delivery_id'))}::uuid, ${P(RES(`${k}_c`, 'claim_token'))}::uuid, '${pid}', ${lit(JSON.stringify(pl))}::jsonb)::text`, `${k}_i`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} normalize`)}, ${svc(`SELECT mp_normalize_source(${P(RES(`${k}_i`, 'source_record_id'))}::uuid)::text`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} apply`)}, ${svc(`SELECT mp_apply_transition(${P(`(SELECT t.mp_financial_movement_id FROM mp_transition_identity t WHERE t.resource_type = 'payment' AND t.resource_id = '${pid}' AND t.transition = 'APPROVAL')`)})::text`)});`);
}
const MVP = (pid) => `(SELECT t.mp_financial_movement_id FROM mp_transition_identity t WHERE t.resource_type = 'payment' AND t.resource_id = '${pid}' AND t.transition = 'APPROVAL')`;
const P_DEBIN = '970000008001'; const P_CARD = '970000008002'; const P_CVU = '970000008003'; const P_MAPPED = '970000008004'; const P_MONEY = '970000008005';
payment('D', P_DEBIN, 'account_fund', 'debin_transfer', 7500, { payerId: '800000111', payload: { point_of_interaction: { type: 'TRANSFER', transaction_data: { bank_info: { payer: { long_name: 'Juan Pérez', account_id: SECRET_BANK } } } } } });
payment('C', P_CARD, 'money_transfer', 'visa', 3000, { payerId: '800000222', payload: { card: { cardholder: { name: 'MARIA GOMEZ', identification: { number: SECRET_DOC } } } } });
payment('V', P_CVU, 'account_fund', 'cvu', 2000, { payerId: '800000333', description: 'Transferencia recibida' });
payment('M', P_MONEY, 'money_transfer', 'account_money', 1500, { payerId: '800000444' });
const UNL = (pid, cols) => A(`SELECT ${cols} FROM fin_mp_unlinked_inflows WHERE source_id = '${pid}'`);

// ── C / D / E. safe display ──
expect('C-1 DEBIN: display = bank holder name; payer_id kept; no mapping yet', UNL(P_DEBIN, `inflow_subtype || '|' || payer_id || '|' || coalesce(payer_display_name, '-') || '|' || coalesce(mapped_client_name, '-')`), 'OK:DEBIN|800000111|Juan Pérez|-');
expect('D-1 card: display = cardholder name', UNL(P_CARD, `inflow_subtype || '|' || payer_id || '|' || coalesce(payer_display_name, '-')`), 'OK:RECEIPT|800000222|MARIA GOMEZ');
expect('E-1 CVU without a name: no display name (the UI falls back to the type / description)', UNL(P_CVU, `inflow_subtype || '|' || payer_id || '|' || coalesce(payer_display_name, '-') || '|' || coalesce(description, '-')`), 'OK:CVU|800000333|-|Transferencia recibida');
expect('E-2 account money: payer_id only, never the email as a name', UNL(P_MONEY, `payer_id || '|' || coalesce(payer_display_name, '-')`), 'OK:800000444|-');

// ── A / B. payer.id mapping + auto-allocation unchanged ──
expect('A-1 "Recordar este pagador": the existing mapping RPC by payer.id', A(`SELECT mp_map_payer_to_client('800000111', '${CLI}'::uuid, 'ADR-024 test')::text`), 'OK:%');
expect('A-2 the unlinked row now shows the mapped client', UNL(P_DEBIN, `coalesce(mapped_client_name, '-')`), 'OK:Cliente ADR-024');
payment('MAP', P_MAPPED, 'account_fund', 'debin_transfer', 2500, { payerId: '800000111' });
expect('B-1 mp_auto_allocate (service role) allocates a new payment of a mapped payer.id, as before', svc(`SELECT mp_auto_allocate(${P(MVP(P_MAPPED))})::text`), 'OK:%"allocated": true%');
expect('B-2 … the client ledger has the collection; the payment leaves "Entradas sin vincular"', `((SELECT sum(signed_amount)::text FROM client_ledger WHERE cliente_id = '${CLI}') || '|' || ${UNL(P_MAPPED, `count(*)::text`)})`, '-2500.00|OK:0');

// ── F / G / H. raw payload privacy ──
expect('F-1 ADMIN cannot read mp_source_record.event_data through the API', A(`SELECT event_data::text FROM mp_source_record LIMIT 1`), 'ERR:permission denied%');
expect('F-2 ADMIN still reads the safe source columns', A(`SELECT count(*)::text FROM (SELECT id, source_type, external_id, occurred_at, processing_status FROM mp_source_record WHERE external_id LIKE 'MPPAY:97000000800%') x`), 'OK:5');
expect('F-3 anon / OPERATOR read nothing', `(${as('anon', null, `SELECT count(*)::text FROM mp_source_record`)} || '|' || ${as('authenticated', OPER, `SELECT count(*)::text FROM fin_mp_unlinked_inflows`)})`, 'ERR:permission denied%|OK:0');
expect('G-1 the trusted server paths keep the evidence: service role reads the payload', svc(`SELECT (event_data #>> '{payer,email}' IS NOT NULL)::text FROM mp_source_record WHERE external_id LIKE 'MPPAY:${P_DEBIN}:%' LIMIT 1`), 'OK:true');
const LEAK = (v) => `(SELECT count(*) FROM fin_mp_unlinked_inflows x WHERE x::text LIKE '%${v}%') + (SELECT count(*) FROM fin_mp_report_activity x WHERE x::text LIKE '%${v}%')
  + (SELECT count(*) FROM fin_mp_technical_review x WHERE x::text LIKE '%${v}%') + (SELECT count(*) FROM report_mp_receipt_status x WHERE x::text LIKE '%${v}%')
  + (SELECT count(*) FROM fin_mp_pending_classification x WHERE x::text LIKE '%${v}%') + (SELECT count(*) FROM report_mp_movement_status x WHERE x::text LIKE '%${v}%')
  + (SELECT count(*) FROM fin_mp_pending_summary x WHERE x::text LIKE '%${v}%')`;
expect('H-1 no email / document / phone / bank identifier in any ADMIN-readable MP view', A(`SELECT (${[SECRET_EMAIL, SECRET_DOC, SECRET_PHONE, SECRET_BANK].map(LEAK).join(' + ')})::text`), 'OK:0');
expect('H-2 the payload-reading views run with the owner rights and keep their ADMIN filter (anon has no grant)',
  `(SELECT string_agg(c.relname || ':' || coalesce(c.reloptions::text, '-') || ':' || (pg_get_viewdef(c.oid) ~ 'current_app_role') || ':' || has_table_privilege('anon', c.oid, 'SELECT'), ',' ORDER BY c.relname)
     FROM pg_class c WHERE c.relname IN ('fin_mp_report_activity', 'fin_mp_technical_review', 'report_mp_receipt_status', 'fin_mp_unlinked_inflows'))`,
  'fin_mp_report_activity:{security_invoker=false}:true:false,fin_mp_technical_review:{security_invoker=false}:true:false,fin_mp_unlinked_inflows:{security_invoker=false}:true:false,report_mp_receipt_status:{security_invoker=false}:true:false');

// ── I / J. ADR-023 semantics unchanged ──
expect('I-1 inflows stay optional unlinked inflows (live DEBIN / card / CVU / account money listed, remaining = amount)',
  A(`SELECT string_agg(source_id || ':' || remaining_amount, ',' ORDER BY source_id) FROM fin_mp_unlinked_inflows WHERE source_id LIKE '97000000800%'`),
  `OK:${P_DEBIN}:7500.00,${P_CARD}:3000.00,${P_CVU}:2000.00,${P_MONEY}:1500.00`);
expect('J-1 no inflow became a mandatory pending', A(`SELECT count(*)::text FROM fin_mp_pending_classification WHERE source_id LIKE '97000000800%'`), 'OK:0');
expect('J-2 the summary still counts unlinked inflows apart from the mandatory pendings', A(`SELECT (count(*) = 4)::text FROM fin_mp_pending_summary`), 'OK:true');

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
console.log(`\n  ══ ADR-024 0097 MP PAYER PRIVACY RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
