#!/usr/bin/env node
/**
 * PHASE 23 — MERCADO PAGO DEFINITIVE TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Pipeline under test (frozen Part 22 + ADR-003):
 *   immutable raw source (service_role INSERT) → RPC 40 mp_normalize_source
 *   (Liberaciones csv_import contract; ERROR / IGNORED outcomes) → RPC 41
 *   mp_reconcile_movement (amount-assigned, idempotent, Mode 1 create / Mode 2
 *   link, movement cap + operation-per-account cap) → financial_operation /
 *   financial_posting. MP is not a ledger: no balance is stored anywhere.
 *
 * Parser fixtures include rows copied VERBATIM from the committed exports
 * data/mercadopago/Liberaciones1.csv and Liberaciones2.csv (cited below).
 *
 * Sessions: service_role (request.jwt.claims role=service_role, no perfil),
 * ADMIN, OPERATOR, anon. Failure injection uses test-only triggers in schema
 * p23_harness. Concurrency uses independent PostgreSQL sessions.
 *
 * Fixtures: the MP tables are written only by this suite in the local test DB;
 * cleanup removes every MP row, the operations/postings they created and the
 * "P23-TEST" fixture operations.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/mp.test.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
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

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPA = '22222222-2222-2222-2222-222222222222';
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'P23-TEST';
const TABLES = ['mp_financial_movement', 'mp_reconciliation', 'mp_source_record'];
const MP_RPCS = ['mp_normalize_source', 'mp_reconcile_movement'];
const ALL_DEFINERS = 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,'
  + 'close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_apply_transition,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_report_fallback,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,'
  + 'open_sales_session,pay_fiscal_obligation,pay_supplier,receive_cheque,'
  + 'rectify_daily_production,rectify_delivered_order,rectify_mortality,rectify_purchase,register_classification,register_collection,'
  + 'register_count_adjustment,register_daily_production,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,'
  + 'register_fiscal_document,register_fiscal_obligation,'
  + 'register_freight,register_management_event,register_mortality,register_purchase,register_session_cash_event,register_session_movement,reject_cheque,'
  + 'reject_supplier_instrument,transfer_between_accounts';

let container;
let pass = 0;
let fail = 0;
const failures = [];

function dockerRun(args, input) {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker: ${r.error.message}`);
  return r;
}
const PSQL = ['psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
function raw(sqlText) {
  const r = dockerRun(['exec', '-i', container, ...PSQL], sqlText);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function owner(sqlText) {
  const r = raw(sqlText);
  if (!r.ok) throw new Error(`owner SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const esc = (s) => s.replace(/'/g, "''");
const sessionSql = (pgRole, claims, sqlText) => `
BEGIN;
SET LOCAL ROLE ${pgRole};
SET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';
${sqlText}
COMMIT;`;
const asRole = (pgRole, claims, sqlText) => raw(sessionSql(pgRole, claims, sqlText));
const ADMIN = (s) => asRole('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s);
const OPER = (s) => asRole('authenticated', { sub: OPA, role: 'authenticated' }, s);
const SVC = (s) => asRole('service_role', { role: 'service_role' }, s);
const ANON = (s) => asRole('anon', { role: 'anon' }, s);
const ROLE_SQL = {
  admin: (s) => sessionSql('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s),
  svc: (s) => sessionSql('service_role', { role: 'service_role' }, s),
};

function session(sqlText, appName) {
  return new Promise((done) => {
    const p = spawn(DOCKER, ['exec', '-i', '-e', `PGAPPNAME=${appName}`, container, ...PSQL]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => done({ ok: code === 0, out: out.trim(), err: err.trim() }));
    p.stdin.end(sqlText);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(condSql, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (owner(condSql) === 't') return true;
    await sleep(100);
  }
  return false;
}
async function race(roleA, sqlA, roleB, sqlB, appPrefix, expectWait = true) {
  const pA = session(ROLE_SQL[roleA](`${sqlA}\nSELECT pg_sleep(2);`), `${appPrefix}-A`);
  const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-A'
    AND state = 'active' AND query LIKE '%pg_sleep%');`);
  const pB = session(ROLE_SQL[roleB](sqlB), `${appPrefix}-B`);
  const bWait = expectWait
    ? await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-B' AND wait_event_type = 'Lock');`)
    : null;
  const [ra, rb] = await Promise.all([pA, pB]);
  return { aIn, bWait, ra, rb };
}

function okAs(fn, sqlText) {
  const r = fn(sqlText);
  if (!r.ok) throw new Error(`SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const rpcAs = (fn, call) => JSON.parse(okAs(fn, `SELECT ${call};`));
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 200);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
const raised = (r, code) => !r.ok && new RegExp(`ERROR:\\s+${code}`).test(r.err);
const violates = (r, name) => !r.ok && r.err.includes(name);

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`    OK   ${label}`);
  } else {
    fail += 1;
    failures.push({ label, detail });
    console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`);
  }
}
function section(n, title) {
  console.log(`\n  ── ${n}. ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

// ── guard, container ───────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '')
  .trim().split('\n').filter(Boolean)[0];
if (!container) {
  console.error('  no running supabase_db container. Run `supabase start`.');
  process.exit(1);
}
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) {
  console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`);
  process.exit(1);
}
console.log(`  container: ${container}`);

const CURRENT_MONTH = owner(`SELECT date_trunc('month', (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::DATE;`);
const CLOSED_BY_SUITE = ['2026-03-01', CURRENT_MONTH];

// ── fixture lifecycle ──────────────────────────────────────────────────────
function cleanup() {
  owner(`
DROP SCHEMA IF EXISTS p23_harness CASCADE;
CREATE TEMP TABLE _o AS
  SELECT id FROM financial_operation WHERE source_entity_type = 'mp_financial_movement'
  UNION SELECT id FROM financial_operation WHERE external_ref LIKE '${TAG}%' OR external_ref LIKE 'MP:${TAG}%';
DELETE FROM audit_events WHERE entity_type = 'mp_reconciliation';
DELETE FROM audit_events WHERE entity_type = 'mp_source_record';
DELETE FROM mp_report_match;          -- ADR-006 HRN-4: dependents of movement / source, in FK order
DELETE FROM mp_transition_identity;
DELETE FROM mp_reconciliation;
DELETE FROM mp_financial_movement;
DELETE FROM mp_source_record;   -- the raw guard is BEFORE UPDATE only; no role but the owner holds DELETE
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _o);
UPDATE management_period SET status = 'OPEN', closed_at = NULL
 WHERE periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
}

cleanup();
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPA}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPA}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;`);

// ── Liberaciones rows ──────────────────────────────────────────────────────
const HEADER = ['DATE', 'SOURCE_ID', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT', 'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'TAXES_AMOUNT',
  'PAYMENT_METHOD', 'TRANSACTION_APPROVAL_DATE', 'BUSINESS_UNIT', 'SUB_UNIT', 'BALANCE_AMOUNT', 'PAYMENT_METHOD_TYPE', 'PURCHASE_ID'];
const fromLine = (line) => { const v = line.split(';'); return Object.fromEntries(HEADER.map((h, i) => [h, v[i] ?? ''])); };
// verbatim rows of the committed exports
const REAL = {
  payment: fromLine('2026-02-06T22:44:10.000-03:00;144502568133;payment;0.99;0.00;1.00;0.00;-0.01;available_money;2026-02-06T22:44:10.000-03:00;;;0.99;account_money;'), // Liberaciones1.csv
  paymentOut: fromLine('2026-02-11T07:52:49.000-03:00;145781917504;payment;0.00;20120.95;-20000.94;0.00;-120.01;available_money;2026-02-11T07:52:49.000-03:00;Mercado Pago;QR;1615555.75;account_money;'), // Liberaciones1.csv
  payout: fromLine('2026-02-19T16:01:55.000-03:00;146231746361;payout;0.00;532415.53;-529240.09;0.00;-3175.44;available_money;2026-02-19T16:01:55.000-03:00;;;2732824.55;;'), // Liberaciones1.csv
  asset: fromLine('2026-05-19T04:01:07.000-03:00;1743973531011;asset_management;2337.10;0.00;2337.10;0.00;0.00;available_money;2026-05-19T04:01:07.000-03:00;;;4861916.91;;'), // Liberaciones2.csv
  reservePayment: fromLine('2026-02-11T07:52:49.000-03:00;145781917504;reserve_for_payment;0.00;20120.95;-20120.95;0.00;0.00;available_money;2026-02-11T07:52:49.000-03:00;Mercado Pago;QR;1615555.75;account_money;'), // Liberaciones1.csv
  reservePayout: fromLine('2026-02-19T16:01:52.000-03:00;146231746361;reserve_for_payout;0.00;532415.53;-532415.53;0.00;0.00;available_money;2026-02-19T16:01:52.000-03:00;;;2732824.55;;'), // Liberaciones1.csv
};
let sidSeq = 0;
// synthetic Liberaciones row with a unique SOURCE_ID
const synth = (o = {}) => {
  const credit = o.credit ?? '1000.00';
  const debit = o.debit ?? '0.00';
  return { ...fromLine(`${o.date ?? '2026-05-10T10:00:00.000-03:00'};${o.sid ?? `9${String(++sidSeq).padStart(11, '0')}`};${o.desc ?? 'payment'};${credit};${debit};`
    + `${o.gross ?? '1010.00'};${o.fee ?? '-6.00'};${o.tax ?? '-4.00'};available_money;${o.date ?? '2026-05-10T10:00:00.000-03:00'};;;0.00;account_money;${TAG}`), ...(o.override || {}) };
};
const netOf = (row) => Number(row.NET_CREDIT_AMOUNT) - Number(row.NET_DEBIT_AMOUNT);
const extIdOf = (row) => `${row.SOURCE_ID}:${row.DESCRIPTION}:${netOf(row) > 0 ? 'C' : 'D'}`;
// ingestion = direct service_role INSERT (RLS §9); raw values derived per ADR-003
const ingest = (row, o = {}) => {
  const ext = o.ext ?? extIdOf(row);
  const at = o.at ?? row.DATE;
  const date = o.date ?? `(TIMESTAMPTZ '${at}' AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`;
  return okAs(SVC, `INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
    VALUES ('${o.type ?? 'csv_import'}', '${esc(ext)}', '${esc(JSON.stringify(row))}'::jsonb, '${at}', ${date}) RETURNING id;`);
};
const normalize = (src) => rpcAs(SVC, `mp_normalize_source('${src}')`);
const srcRow = (src) => owner(`SELECT processing_status || '|' || (processed_at IS NOT NULL) || '|' || coalesce(processing_note, '-') FROM mp_source_record WHERE id = '${src}';`);
const rawOf = (src) => owner(`SELECT md5(source_type || external_id || event_data::TEXT || occurred_at::TEXT || occurred_date::TEXT || ingested_at::TEXT) FROM mp_source_record WHERE id = '${src}';`);
const movOf = (src) => owner(`SELECT coalesce(string_agg(movement_kind || ':' || gross_amount || ':' || fee_amount || ':' || tax_amount || ':' || net_amount || ':' || occurred_date, ','), '')
  FROM mp_financial_movement WHERE mp_source_record_id = '${src}';`);
const movId = (src) => owner(`SELECT id FROM mp_financial_movement WHERE mp_source_record_id = '${src}' ORDER BY id LIMIT 1;`);
let keySeq = 0;
const newKey = () => `${TAG}:${String(++keySeq).padStart(4, '0')}`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(String(v))}'`);
const n = (v) => (v === null || v === undefined ? 'NULL' : String(v));
const recCall = (mv, amount, key, acct, opType = null, existing = null, reason = null) =>
  `mp_reconcile_movement(${n(mv)}, ${n(amount)}, ${q(key)}, ${q(acct)}, ${opType ? `'${opType}'` : `'MP_SETTLEMENT'`}, ${n(existing)}, ${q(reason)})`;
const reconcile = (fn, mv, amount, acct, o = {}) => {
  const key = o.key ?? newKey();
  return { key, ...rpcAs(fn, recCall(mv, amount, key, acct, o.opType, o.existing, o.reason)) };
};
// a normalized synthetic movement
// ADR-006 §P23: the fixture movement is a Liberaciones payout (kind transfer, still normalized by the unchanged
// ADR-003 parser, not auto-applicable, RPC 41-owned); payment rows are parked DEFERRED_V4 while V-4 is open.
const movement = (o = {}) => { const src = ingest(synth({ desc: 'payout', ...o })); normalize(src); return { src, mv: movId(src) }; };
const statusOf = (src) => owner(`SELECT processing_status FROM mp_source_record WHERE id = '${src}';`);
const assignedOf = (mv) => owner(`SELECT coalesce(SUM(assigned_amount), 0) FROM mp_reconciliation WHERE mp_financial_movement_id = ${mv};`);
const balance = (acc) => owner(`SELECT coalesce(SUM(signed_amount), 0) FROM financial_posting WHERE financial_account_id = '${acc}';`);
const cents = (v) => Math.round(Number(v) * 100);
const snapshot = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM mp_source_record), (SELECT count(*) FROM mp_financial_movement),
  (SELECT count(*) FROM mp_reconciliation), (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT count(*) FROM audit_events), (SELECT string_agg(processing_status::TEXT, ',' ORDER BY id) FROM mp_source_record));`);
const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);
const visible = (fn, t) => { const x2 = fn(`SELECT count(*) FROM ${t};`); return x2.ok ? x2.out : `ERR ${firstErr(x2)}`; };
// an existing internal operation (fixture through the privileged path) with explicit postings
let opSeq = 0;
const existingOp = (postings) => {
  const op = owner(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason)
    VALUES ('TRANSFER', '2026-05-10', '${TAG}:op${++opSeq}', 'fixture') RETURNING id;`);
  for (const [acct, amount] of postings) owner(`INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date) VALUES (${op}, '${acct}', ${amount}, '2026-05-10');`);
  return op;
};

let r;
let snap;
let x;

try {
const MPACC = owner(`SELECT id FROM financial_account WHERE nombre = 'Mercado Pago';`);
const CAJA = owner(`SELECT id FROM financial_account WHERE nombre = 'Caja chica';`);
const BNA = owner(`SELECT id FROM financial_account WHERE nombre = 'BNA';`);

// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure');

const colsOf = (t) => owner(`SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = '${t}';`);
check('A1 the three MP tables exist', owner(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN (${TABLES.map((t) => `'${t}'`).join(',')});`) === TABLES.join(','));
const wantCols = {
  mp_source_record: 'id:uuid,source_type:character varying,external_id:character varying,event_data:jsonb,occurred_at:timestamp with time zone,'
    + 'occurred_date:date,ingested_at:timestamp with time zone,processing_status:USER-DEFINED,processed_at:timestamp with time zone,processing_note:text',
  mp_financial_movement: 'id:bigint,mp_source_record_id:uuid,movement_kind:character varying,gross_amount:numeric,fee_amount:numeric,tax_amount:numeric,'
    + 'net_amount:numeric,occurred_date:date,created_at:timestamp with time zone',
  mp_reconciliation: 'id:uuid,mp_financial_movement_id:bigint,financial_operation_id:bigint,financial_account_id:uuid,assigned_amount:numeric,'
    + 'idempotency_key:character varying,reconciled_at:timestamp with time zone,reconciled_by:uuid',
};
const badCols = Object.entries(wantCols).filter(([t, c]) => colsOf(t) !== c).map(([t]) => `${t}=${colsOf(t)}`);
check('A2 columns exactly as frozen Domain L + ADR-003 (mp_reconciliation.financial_account_id, idempotency_key); source_type / movement_kind are free VARCHAR',
  badCols.length === 0, badCols.join(' ; '));
const cons = owner(`SELECT string_agg(conrelid::regclass || '.' || conname || ':' || contype::TEXT, ',' ORDER BY conrelid::regclass::TEXT, conname) FROM pg_constraint
  WHERE conrelid IN (${TABLES.map((t) => `'${t}'::regclass`).join(',')}) AND contype IN ('u','c');`);
check('A3 UNIQUE/CHECK: source (type, external_id); movement (source, kind); reconciliation (movement, operation), idempotency_key, assigned_amount <> 0',
  cons === 'mp_financial_movement.mp_financial_movement_mp_source_record_id_movement_kind_key:u,'
  + 'mp_reconciliation.mp_reconciliation_assigned_amount_check:c,mp_reconciliation.mp_reconciliation_idempotency_key_key:u,'
  + 'mp_reconciliation.mp_reconciliation_mp_financial_movement_id_financial_operat_key:u,'
  + 'mp_source_record.mp_source_record_source_type_external_id_key:u', cons);
const fks = owner(`SELECT string_agg(x, ',' ORDER BY x) FROM (
  SELECT c.conrelid::regclass || '.' || a.attname || '>' || c.confrelid::regclass || ':' || c.confdeltype::TEXT AS x
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.conrelid IN (${TABLES.map((t) => `'${t}'::regclass`).join(',')})) s;`);
check('A4 FKs all ON DELETE RESTRICT (incl. ADR-003 financial_account)',
  fks === 'mp_financial_movement.mp_source_record_id>mp_source_record:r,mp_reconciliation.financial_account_id>financial_account:r,'
  + 'mp_reconciliation.financial_operation_id>financial_operation:r,mp_reconciliation.mp_financial_movement_id>mp_financial_movement:r,'
  + 'mp_reconciliation.reconciled_by>perfiles:r', fks);
const idx = owner(`SELECT string_agg(indexname || '=' || regexp_replace(indexdef, '^.* USING ', ''), ' ; ' ORDER BY indexname) FROM pg_indexes
  WHERE indexname IN ('idx_mp_source_status','idx_mp_source_date','idx_mp_movement_date','idx_mp_reconciliation_operation_account');`);
check('A5 indexes: source status, source date, movement date, reconciliation (operation, account)',
  idx === 'idx_mp_movement_date=btree (occurred_date) ; idx_mp_reconciliation_operation_account=btree (financial_operation_id, financial_account_id) ; '
  + 'idx_mp_source_date=btree (occurred_date) ; idx_mp_source_status=btree (processing_status)', idx);
check('A6 trg_mp_source_raw_guard BEFORE UPDATE exists; mp_source_raw_guard() is SECURITY INVOKER and not executable by application roles',
  owner(`SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_mp_source_raw_guard' AND tgrelid = 'mp_source_record'::regclass AND NOT tgisinternal;`) === '1'
  && owner(`SELECT prosecdef || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE')
     FROM pg_proc WHERE proname = 'mp_source_raw_guard';`) === 'false:false:false');
check('A7 RLS enabled on the three tables', owner(`SELECT count(*) FROM pg_class WHERE relname IN (${TABLES.map((t) => `'${t}'`).join(',')}) AND relrowsecurity;`) === '3');
check('A8 no stored MP balance / remaining / reconciled balance column', owner(`SELECT count(*) FROM information_schema.columns
  WHERE table_name IN (${TABLES.map((t) => `'${t}'`).join(',')}) AND column_name ~* '(balance|remaining|saldo|reconciled_amount)';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Raw ingestion (service_role INSERT)');

const bSrc = ingest(REAL.payment);
check('B1 service_role ingests a verbatim Liberaciones row: PENDING, raw columns exactly as derived by ADR-003',
  owner(`SELECT source_type || '|' || external_id || '|' || occurred_at || '|' || occurred_date || '|' || processing_status || '|' || (event_data->>'GROSS_AMOUNT')
     FROM mp_source_record WHERE id = '${bSrc}';`) === 'csv_import|144502568133:payment:C|2026-02-07 01:44:10+00|2026-02-06|PENDING|1.00');
const insSql = `INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date) VALUES ('csv_import', 'x', '{}'::jsonb, NOW(), '2026-05-01');`;
const ins = [ADMIN(insSql), OPER(insSql), ANON(insSql)];
check('B2 ADMIN, OPERATOR and anon cannot ingest', ins.every(denied), ins.map(firstErr).join(' | '));
r = SVC(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
  VALUES ('csv_import', '144502568133:payment:C', '{}'::jsonb, NOW(), '2026-05-01');`);
check('B3 duplicate (source_type, external_id) is rejected by the physical UNIQUE', violates(r, 'mp_source_record_source_type_external_id_key'), firstErr(r));
const bOther = ingest({ id: 'x', [TAG]: true }, { type: 'webhook', ext: '144502568133:payment:C', at: '2026-05-10T10:00:00-03:00' });
check('B4 the same external_id under another source_type is a different source', !!bOther);
check('B5 read visibility: ADMIN and service_role see raw sources; OPERATOR sees none; anon has no privilege',
  Number(visible(ADMIN, 'mp_source_record')) >= 2 && Number(visible(SVC, 'mp_source_record')) >= 2 && visible(OPER, 'mp_source_record') === '0'
  && denied(ANON(`SELECT 1 FROM mp_source_record;`)));

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Raw immutability');

const cRaw = rawOf(bSrc);
for (const [col, val] of [['source_type', `'api'`], ['external_id', `'changed'`], ['event_data', `'{}'::jsonb`], ['occurred_at', 'NOW()'],
  ['occurred_date', `'2026-01-01'`], ['ingested_at', 'NOW()']]) {
  r = raw(`UPDATE mp_source_record SET ${col} = ${val} WHERE id = '${bSrc}';`);
  check(`C1 owner/postgres UPDATE of raw column ${col} → "raw source data is immutable"`, raised(r, 'mp_source_record raw source data is immutable'), firstErr(r));
}
r = raw(`UPDATE mp_source_record SET event_data = jsonb_set(event_data, '{GROSS_AMOUNT}', '"999.00"') WHERE id = '${bSrc}';`);
const rMulti = raw(`UPDATE mp_source_record SET occurred_date = '2026-01-01', processing_note = 'x' WHERE id = '${bSrc}';`);
check('C2 raw JSON cannot be rewritten (jsonb_set) and a raw+metadata multi-column edit is blocked; raw bytes unchanged',
  raised(r, 'mp_source_record raw source data is immutable') && raised(rMulti, 'mp_source_record raw source data is immutable') && rawOf(bSrc) === cRaw);
const upd = [ADMIN(`UPDATE mp_source_record SET processing_note = 'x';`), SVC(`UPDATE mp_source_record SET processing_status = 'IGNORED';`),
  SVC(`DELETE FROM mp_source_record;`), ADMIN(`DELETE FROM mp_source_record;`)];
check('C3 no UPDATE / DELETE privilege for ADMIN or service_role (metadata changes only through RPCs 40/41)', upd.every(denied), upd.map(firstErr).join(' | '));

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Normalization (RPC 40) — ratified Liberaciones contract');

let econ0 = owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_posting) FROM financial_operation;`);
const d1 = normalize(bSrc);
check('D1 real payment row (Liberaciones1.csv 144502568133) passes D1 validation, then is parked PENDING DEFERRED_V4 (ADR-006, V-4 open): 0 movements',
  d1.processing_status === 'PENDING' && d1.movements_created === 0 && Object.keys(d1).length === 3
  && movOf(bSrc) === '' && srcRow(bSrc) === 'PENDING|false|DEFERRED_V4: payment/API equivalence unverified', `${JSON.stringify(d1)} ${srcRow(bSrc)}`);
check('D2 raw columns untouched by normalization (byte-identical)', rawOf(bSrc) === cRaw);
const sOut = ingest(REAL.paymentOut); normalize(sOut);
check('D3 real outgoing payment (145781917504, debit) → PENDING DEFERRED_V4, no movement (ADR-006); external_id direction D',
  movOf(sOut) === '' && statusOf(sOut) === 'PENDING'
  && owner(`SELECT external_id FROM mp_source_record WHERE id = '${sOut}';`) === '145781917504:payment:D');
const sAsset = ingest(REAL.asset); normalize(sAsset);
check('D4 real asset_management row (Liberaciones2.csv 1743973531011) → movement_kind yield, net +2337.10', movOf(sAsset) === 'yield:2337.10:0.00:0.00:2337.10:2026-05-19');
const sPayout = ingest(REAL.payout); normalize(sPayout);
check('D5 real payout row (146231746361) → movement_kind transfer, net −532415.53 (money out of Mercado Pago)',
  movOf(sPayout) === 'transfer:-529240.09:0.00:-3175.44:-532415.53:2026-02-19');
const sRes1 = ingest(REAL.reservePayment);
const sRes2 = ingest(REAL.reservePayout);
const res1Raw = rawOf(sRes1);
const r1 = normalize(sRes1);
const r2 = normalize(sRes2);
check('D6 real reserve_for_payment / reserve_for_payout rows → IGNORED with a note; no movement; raw unchanged',
  r1.processing_status === 'IGNORED' && r2.processing_status === 'IGNORED' && r1.movements_created === 0 && movOf(sRes1) === '' && movOf(sRes2) === ''
  && /^IGNORED\|true\|RESERVE_ROW/.test(srcRow(sRes1)) && rawOf(sRes1) === res1Raw, srcRow(sRes1));
const errCases = [
  ['unknown DESCRIPTION', synth({ desc: 'chargeback' }), {}, 'UNKNOWN_DESCRIPTION'],
  ['malformed numeric', synth({ gross: '1.010,00' }), {}, 'MALFORMED_AMOUNT'],
  ['missing amount', synth({ tax: '' }), {}, 'MISSING_AMOUNT'],
  ['both credit and debit non-zero', synth({ debit: '5.00' }), { ext: 'x' }, 'CREDIT_DEBIT_INVALID'],
  ['both credit and debit zero', synth({ credit: '0.00', gross: '0.00', fee: '0.00', tax: '0.00' }), { ext: 'y' }, 'CREDIT_DEBIT_INVALID'],
  ['arithmetic mismatch (gross + fee + tax ≠ net)', synth({ gross: '1010.01' }), {}, 'ARITHMETIC_MISMATCH'],
  ['positive fee', synth({ gross: '990.00', fee: '14.00' }), {}, 'SIGN_INVALID'],
  ['more than 2 decimals (no rounding tolerance)', synth({ credit: '1000.001', gross: '1010.001' }), {}, 'MALFORMED_AMOUNT'],
  ['external_id not the ADR-003 composite', synth(), { ext: 'wrong-identity' }, 'IDENTITY_MISMATCH'],
  ['occurred_date not derived from DATE', synth(), { date: `'2026-05-11'` }, 'DATE_MISMATCH'],
  ['non-string value in event_data', { ...synth(), GROSS_AMOUNT: 1010 }, {}, 'MALFORMED_EVENT_DATA'],
  ['unsupported CSV format (settlement report layout)', { SOURCE_ID: '9', TRANSACTION_TYPE: 'SETTLEMENT', SETTLEMENT_NET_AMOUNT: '10.00', [TAG]: '1' },
    { ext: 'settlement-1', at: '2026-05-10T10:00:00-03:00' }, 'UNSUPPORTED_CSV_FORMAT'],
  ['unsupported source_type webhook', { type: 'payment', data: { id: '1' }, [TAG]: '1' }, { type: 'webhook', ext: 'wh-1', at: '2026-05-10T10:00:00-03:00' }, 'UNSUPPORTED_SOURCE_TYPE'],
  ['unsupported source_type api', { id: 1, transaction_amount: 10, [TAG]: '1' }, { type: 'api', ext: 'api-1', at: '2026-05-10T10:00:00-03:00' }, 'UNSUPPORTED_SOURCE_TYPE'],
];
for (const [what, row, o, code] of errCases) {
  const src = ingest(row, o);
  const before = rawOf(src);
  const out = normalize(src);
  check(`D7 ${what} → ERROR (${code}); no movement; note recorded; raw unchanged`,
    out.processing_status === 'ERROR' && out.movements_created === 0 && movOf(src) === ''
    && srcRow(src).startsWith(`ERROR|true|${code}`) && rawOf(src) === before, `${JSON.stringify(out)} ${srcRow(src)}`);
}
// reserve rows are IGNORED only as VALID events: every common validation applies first (0042)
const resOk = ingest(synth({ desc: 'reserve_for_payout', credit: '0.00', debit: '500.00', gross: '-500.00', fee: '0.00', tax: '0.00' }));
const resOkOut = normalize(resOk);
check('D7b a valid synthetic reserve row passes every validation and is IGNORED (no movement, note RESERVE_ROW)',
  resOkOut.processing_status === 'IGNORED' && resOkOut.movements_created === 0 && movOf(resOk) === '' && /^IGNORED\|true\|RESERVE_ROW/.test(srcRow(resOk)), srcRow(resOk));
const reserve = (o) => synth({ desc: 'reserve_for_payment', credit: '0.00', debit: '700.00', gross: '-700.00', fee: '0.00', tax: '0.00', ...o });
for (const [what, row, o, code] of [
  ['malformed amount', reserve({ gross: '-700,00' }), {}, 'MALFORMED_AMOUNT'],
  ['missing amount', reserve({ tax: '' }), {}, 'MISSING_AMOUNT'],
  ['credit and debit both non-zero', reserve({ credit: '5.00' }), { ext: 'reserve-both' }, 'CREDIT_DEBIT_INVALID'],
  ['invalid arithmetic', reserve({ gross: '-699.00' }), {}, 'ARITHMETIC_MISMATCH'],
  ['bad external_id', reserve(), { ext: 'reserve-wrong-identity' }, 'IDENTITY_MISMATCH'],
  ['malformed DATE', reserve({ override: { DATE: '10/05/2026 10:00' } }), { at: '2026-05-10T10:00:00-03:00' }, 'MALFORMED_DATE'],
  ['occurred_date not derived from DATE', reserve(), { date: `'2026-05-12'` }, 'DATE_MISMATCH'],
]) {
  const src = ingest(row, o);
  const before = rawOf(src);
  const out = normalize(src);
  check(`D7c reserve row with ${what} → ERROR (${code}), not IGNORED; no movement; raw unchanged`,
    out.processing_status === 'ERROR' && out.movements_created === 0 && movOf(src) === ''
    && srcRow(src).startsWith(`ERROR|true|${code}`) && rawOf(src) === before, `${JSON.stringify(out)} ${srcRow(src)}`);
}
r = SVC(`SELECT mp_normalize_source('${sAsset}');`);
const d8b = normalize(bSrc);
check('D8 normalizing a processed source again → ALREADY_PROCESSED; no duplicate movement. A deferred payment rerun stays PENDING DEFERRED_V4 with no movement and no new audit',
  raised(r, 'ALREADY_PROCESSED') && owner(`SELECT count(*) FROM mp_financial_movement WHERE mp_source_record_id = '${sAsset}';`) === '1'
  && d8b.processing_status === 'PENDING' && d8b.movements_created === 0 && movOf(bSrc) === ''
  && owner(`SELECT count(*) FROM audit_events WHERE entity_type = 'mp_source_record' AND entity_id = '${bSrc}';`) === '1', firstErr(r));
r = SVC(`SELECT mp_normalize_source('${MISSING_UUID}');`);
check('D9 missing source → SOURCE_NOT_FOUND', raised(r, 'SOURCE_NOT_FOUND'), firstErr(r));
const pendingSrc = ingest(synth());
const dAuth = [ADMIN(`SELECT mp_normalize_source('${pendingSrc}');`), OPER(`SELECT mp_normalize_source('${pendingSrc}');`), ANON(`SELECT mp_normalize_source('${pendingSrc}');`)];
check('D10 ADMIN, OPERATOR and anon cannot normalize (EXECUTE granted to service_role only); source stays PENDING',
  dAuth.every(denied) && statusOf(pendingSrc) === 'PENDING', dAuth.map(firstErr).join(' | '));
check('D11 audit NORMALIZE: before PENDING, after status + movement count, performed_by NULL (backend); the DEFERRED_V4 payment row is audited once as PENDING / 0',
  owner(`SELECT action || '|' || (before_values->>'processing_status') || '|' || (after_values->>'processing_status') || '|' || (after_values->>'movements') || '|' || coalesce(performed_by::TEXT, 'NULL')
     FROM audit_events WHERE entity_type = 'mp_source_record' AND entity_id = '${bSrc}';`) === 'NORMALIZE|PENDING|PENDING|0|NULL'
  && owner(`SELECT (after_values->>'processing_status') || '|' || reason FROM audit_events WHERE entity_type = 'mp_source_record' AND entity_id = '${sRes1}';`).startsWith('IGNORED|RESERVE_ROW'));
check('D12 ingestion and normalization create no financial operation or posting (MP is not a ledger)',
  owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_posting) FROM financial_operation;`) === econ0);

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Reconciliation Mode 1 (create) — amount assignment and sign');

const E = movement({ credit: '1000.00' });
const mp0Base = cents(balance(MPACC));
const e1 = reconcile(ADMIN, E.mv, 600, MPACC, { reason: 'liquidación parcial' });
check('E1 ADMIN assigns +600 of +1000 → {reconciliation_id, financial_operation_id, remaining_unassigned 400}; source stays NORMALIZED',
  Number(e1.remaining_unassigned) === 400 && Object.keys(e1).length === 4 && statusOf(E.src) === 'NORMALIZED', JSON.stringify(e1));
check('E2 Mode 1 operation: type MP_SETTLEMENT, external_ref MP:<idempotency_key>, dated occurred_date, source mp_financial_movement; ONE posting +600 on the account',
  owner(`SELECT o.operation_type || '|' || o.external_ref || '|' || o.effective_date || '|' || o.source_entity_type || '|' || o.source_entity_id || '|'
     || (SELECT string_agg(p.financial_account_id || ':' || p.signed_amount || ':' || p.effective_date, ',') FROM financial_posting p WHERE p.financial_operation_id = o.id)
     FROM financial_operation o WHERE o.id = ${e1.financial_operation_id};`)
  === `MP_SETTLEMENT|MP:${e1.key}|2026-05-10|mp_financial_movement|${E.mv}|${MPACC}:600.00:2026-05-10`);
check('E3 reconciliation row: movement, operation, account, amount, idempotency_key, reconciled_by ADMIN',
  owner(`SELECT mp_financial_movement_id || '|' || financial_operation_id || '|' || financial_account_id || '|' || assigned_amount || '|' || idempotency_key || '|' || reconciled_by
     FROM mp_reconciliation WHERE id = '${e1.reconciliation_id}';`) === `${E.mv}|${e1.financial_operation_id}|${MPACC}|600.00|${e1.key}|${ADMIN_UID}`);
const e4 = reconcile(SVC, E.mv, 400, MPACC);
check('E4 service_role assigns the remaining +400 → remaining 0, source RECONCILED; reconciled_by and created_by NULL (no fabricated user)',
  Number(e4.remaining_unassigned) === 0 && statusOf(E.src) === 'RECONCILED'
  && owner(`SELECT coalesce(reconciled_by::TEXT, 'NULL') FROM mp_reconciliation WHERE id = '${e4.reconciliation_id}';`) === 'NULL'
  && owner(`SELECT coalesce(created_by::TEXT, 'NULL') FROM financial_operation WHERE id = ${e4.financial_operation_id};`) === 'NULL');
snap = snapshot();
r = ADMIN(`SELECT ${recCall(E.mv, 1, newKey(), MPACC)};`);
check('E5 +1 more → OVER_ASSIGNMENT; nothing written', raised(r, 'OVER_ASSIGNMENT') && snapshot() === snap, firstErr(r));
const EN = movement({ credit: '0.00', debit: '250.00', gross: '-240.00', fee: '-6.00', tax: '-4.00' });
const en1 = reconcile(ADMIN, EN.mv, -100, MPACC);
const en2 = reconcile(ADMIN, EN.mv, -150, MPACC);
check('E6 negative movement −250: −100 → remaining −150, −150 → remaining 0, RECONCILED (signed exactness)',
  Number(en1.remaining_unassigned) === -150 && Number(en2.remaining_unassigned) === 0 && statusOf(EN.src) === 'RECONCILED');
const EC = movement({ credit: '1000.00' });
const ec1 = reconcile(ADMIN, EC.mv, 600, MPACC);
const ec2 = reconcile(ADMIN, EC.mv, -100, MPACC);
const ec3 = reconcile(ADMIN, EC.mv, 500, MPACC);
check('E7 counter-assignment +600, −100, +500 on +1000 is valid → total 1000, RECONCILED; no row deleted or rewritten',
  Number(ec3.remaining_unassigned) === 0 && statusOf(EC.src) === 'RECONCILED' && assignedOf(EC.mv) === '1000.00'
  && owner(`SELECT string_agg(assigned_amount::TEXT, ',' ORDER BY reconciled_at, id) FROM mp_reconciliation WHERE mp_financial_movement_id = ${EC.mv};`).split(',').length === 3);
const ec4 = reconcile(ADMIN, EC.mv, -100, MPACC);
check('E8 a later correction (−100) on a RECONCILED source is allowed within the cap and returns it to NORMALIZED (RECONCILED iff fully assigned)',
  Number(ec4.remaining_unassigned) === 100 && statusOf(EC.src) === 'NORMALIZED');
r = ADMIN(`SELECT ${recCall(EC.mv, -2000, newKey(), MPACC)};`);
check('E9 a counter-assignment beyond the cap (abs(900 − 2000) > 1000) → OVER_ASSIGNMENT', raised(r, 'OVER_ASSIGNMENT'), firstErr(r));
snap = snapshot();
for (const [what, fn, call, code] of [
  ['OPERATOR', OPER, recCall(EC.mv, 1, newKey(), MPACC), 'FORBIDDEN'],
  ['amount 0', ADMIN, recCall(EC.mv, 0, newKey(), MPACC), 'INVALID_AMOUNT'],
  ['NULL amount', ADMIN, recCall(EC.mv, null, newKey(), MPACC), 'INVALID_AMOUNT'],
  ['NULL idempotency key', ADMIN, recCall(EC.mv, 1, null, MPACC), 'INVALID_IDEMPOTENCY_KEY'],
  ['empty idempotency key', ADMIN, recCall(EC.mv, 1, '', MPACC), 'INVALID_IDEMPOTENCY_KEY'],
  ['98-character idempotency key', ADMIN, recCall(EC.mv, 1, 'k'.repeat(98), MPACC), 'INVALID_IDEMPOTENCY_KEY'],
  ['NULL account', ADMIN, recCall(EC.mv, 1, newKey(), null), 'ACCOUNT_REQUIRED'],
  ['missing movement', ADMIN, recCall(999999999, 1, newKey(), MPACC), 'MOVEMENT_NOT_FOUND'],
]) {
  r = fn(`SELECT ${call};`);
  check(`E10 ${what} → ${code}; nothing written`, raised(r, code) && snapshot() === snap, firstErr(r));
}
check('E11 anon cannot execute RPC 41', denied(ANON(`SELECT ${recCall(EC.mv, 1, newKey(), MPACC)};`)));
const e97 = reconcile(ADMIN, EC.mv, 50, MPACC, { key: 'q'.repeat(97) });
check('E12 a 97-character key is accepted; external_ref = MP: + key fits VARCHAR(100)',
  owner(`SELECT length(external_ref) FROM financial_operation WHERE id = ${e97.financial_operation_id};`) === '100');
check('E13 audit RECONCILE: movement, amount, operation, account, mode, source status, reason, actor',
  owner(`SELECT action || '|' || (after_values->>'movement_id') || '|' || (after_values->>'assigned_amount') || '|' || (after_values->>'financial_operation_id') || '|'
     || (after_values->>'financial_account_id') || '|' || (after_values->>'mode') || '|' || (after_values->>'source_status') || '|' || reason || '|' || performed_by
     FROM audit_events WHERE entity_type = 'mp_reconciliation' AND entity_id = '${e1.reconciliation_id}';`)
  === `RECONCILE|${E.mv}|600|${e1.financial_operation_id}|${MPACC}|1|NORMALIZED|liquidación parcial|${ADMIN_UID}`);
// Mode 1 operation-type ownership (0042)
const ET = movement({ credit: '1000.00' });
const eFee = reconcile(ADMIN, ET.mv, 10, MPACC, { opType: 'FEE' });
const eAdj = reconcile(ADMIN, ET.mv, 20, MPACC, { opType: 'ADJUSTMENT' });
const opTypeOf = (op) => owner(`SELECT operation_type || ':' || (SELECT count(*) FROM financial_posting WHERE financial_operation_id = ${op}) FROM financial_operation WHERE id = ${op};`);
check('E15 Mode 1 creates MP_SETTLEMENT (E2), FEE and ADJUSTMENT operations, each with exactly one posting',
  opTypeOf(eFee.financial_operation_id) === 'FEE:1' && opTypeOf(eAdj.financial_operation_id) === 'ADJUSTMENT:1'
  && opTypeOf(e1.financial_operation_id) === 'MP_SETTLEMENT:1');
snap = snapshot();
for (const t of ['TRANSFER', 'COLLECTION', 'FISCAL_PAYMENT', 'SESSION_CASH', 'SUPPLIER_PAYMENT', 'CHEQUE_CLEAR']) {
  r = ADMIN(`SELECT ${recCall(ET.mv, 5, newKey(), MPACC, t)};`);
  check(`E16 Mode 1 with operation type ${t} (owned by another RPC) → INVALID_MP_OPERATION_TYPE; no operation, posting, reconciliation or audit`,
    raised(r, 'INVALID_MP_OPERATION_TYPE') && snapshot() === snap, firstErr(r));
}
const mp0 = mp0Base;
check('E14 postings are the sole balance authority: the MP account moved exactly by the Mode 1 assignments',
  cents(balance(MPACC)) === mp0 + 100 * (600 + 400 - 100 - 150 + 600 - 100 + 500 - 100 + 50 + 10 + 20));

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Source status (RECONCILED iff every movement fully assigned)');

const F1 = movement({ credit: '300.00', gross: '303.00', fee: '-2.00', tax: '-1.00' });
reconcile(ADMIN, F1.mv, 100, MPACC);
check('F1 one partial movement → source NORMALIZED', statusOf(F1.src) === 'NORMALIZED');
reconcile(ADMIN, F1.mv, 200, MPACC);
check('F2 one fully assigned movement → source RECONCILED', statusOf(F1.src) === 'RECONCILED');
// V1 parser yields one movement per source; a sibling movement is an owner fixture (the frozen schema allows one per kind)
const F3 = movement({ credit: '500.00', gross: '505.00', fee: '-3.00', tax: '-2.00' });
const sib = owner(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, net_amount, occurred_date)
  VALUES ('${F3.src}', 'fee', -20.00, -20.00, '2026-05-10') RETURNING id;`);
reconcile(ADMIN, F3.mv, 500, MPACC);
check('F3 multi-movement source: first movement complete, sibling unmatched → NORMALIZED', statusOf(F3.src) === 'NORMALIZED');
reconcile(ADMIN, sib, -20, MPACC);
check('F4 all siblings complete → RECONCILED', statusOf(F3.src) === 'RECONCILED');

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'Request idempotency');

const G = movement({ credit: '1000.00' });
const gKey = newKey();
reconcile(ADMIN, G.mv, 400, MPACC, { key: gKey });
snap = snapshot();
r = ADMIN(`SELECT ${recCall(G.mv, 400, gKey, MPACC)};`);
const rOther = ADMIN(`SELECT ${recCall(E.mv, -1, gKey, MPACC)};`);
check('G1 the same key again (same or another movement) → DUPLICATE_RECONCILIATION: no second operation, posting, reconciliation, status change or audit',
  raised(r, 'DUPLICATE_RECONCILIATION') && raised(rOther, 'DUPLICATE_RECONCILIATION') && snapshot() === snap && assignedOf(G.mv) === '400.00', firstErr(r));
const GC = movement({ credit: '1000.00' });
const gc = [reconcile(ADMIN, GC.mv, 600, MPACC), reconcile(ADMIN, GC.mv, -600, MPACC), reconcile(ADMIN, GC.mv, 600, MPACC)];
check('G2 +600, −600, +600 (cumulative returns to 600) all succeed: external_ref derives from the key, no cumulative collision',
  new Set(gc.map((c) => owner(`SELECT external_ref FROM financial_operation WHERE id = ${c.financial_operation_id};`))).size === 3 && assignedOf(GC.mv) === '600.00');

// ═══════════════════════════════════════════════════════════════════════════
section('H', 'True N:N — Mode 2 link existing operation, operation-side capacity');

const HA = movement({ credit: '1000.00' });
const HB = movement({ credit: '900.00', gross: '909.00', fee: '-5.00', tax: '-4.00' });
const HC = movement({ credit: '50.00', gross: '50.50', fee: '-0.30', tax: '-0.20' });
const op2 = existingOp([[MPACC, 1500], [CAJA, -1500]]);
const op3 = existingOp([[MPACC, 100], [MPACC, 200]]);
const postings0 = owner(`SELECT count(*) FROM financial_posting;`);
const hA1 = reconcile(ADMIN, HA.mv, 400, MPACC);
const hA2 = reconcile(ADMIN, HA.mv, 600, MPACC, { existing: op2 });
check('H1 movement A → op1 (Mode 1, +400) + op2 (Mode 2, +600): one movement, two operations; A fully assigned',
  hA2.financial_operation_id === Number(op2) && hA1.financial_operation_id !== hA2.financial_operation_id && statusOf(HA.src) === 'RECONCILED');
const hB = reconcile(ADMIN, HB.mv, 900, MPACC, { existing: op2 });
check('H2 movement B → the same existing op2 (+900): two movements, one operation; op2 MP posting capacity exactly used (600 + 900 = 1500)',
  hB.financial_operation_id === Number(op2) && owner(`SELECT SUM(assigned_amount) FROM mp_reconciliation WHERE financial_operation_id = ${op2} AND financial_account_id = '${MPACC}';`) === '1500.00');
check('H3 link mode created no operation and no posting (only Mode 1 of A added one)',
  Number(owner(`SELECT count(*) FROM financial_posting;`)) === Number(postings0) + 1
  && owner(`SELECT count(*) FROM financial_posting WHERE financial_operation_id = ${op2};`) === '2');
snap = snapshot();
for (const [what, call, code] of [
  ['one more on op2 (1500 + 1 > capacity)', recCall(HC.mv, 1, newKey(), MPACC, null, op2), 'OPERATION_OVER_ASSIGNMENT'],
  ['the same pair A → op2 again (new key)', recCall(HA.mv, -1, newKey(), MPACC, null, op2), 'DUPLICATE_LINK'],
  ['missing existing operation', recCall(HC.mv, 1, newKey(), MPACC, null, 999999999), 'OPERATION_NOT_FOUND'],
  ['operation without a posting on the account (BNA on op2)', recCall(HC.mv, 1, newKey(), BNA, null, op2), 'OPERATION_ACCOUNT_POSTING_NOT_FOUND'],
  ['operation with two postings on the account (op3)', recCall(HC.mv, 1, newKey(), MPACC, null, op3), 'OPERATION_ACCOUNT_POSTING_AMBIGUOUS'],
  ['movement cap still applies in Mode 2 (C: 51 > 50)', recCall(HC.mv, 51, newKey(), CAJA, null, op2), 'OVER_ASSIGNMENT'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`H4 ${what} → ${code}; nothing written`, raised(r, code) && snapshot() === snap, firstErr(r));
}
const hCaja = reconcile(ADMIN, HC.mv, -50, CAJA, { existing: op2 });
check('H5 the capacity is per (operation, account): op2\'s Caja posting (−1500) is a separate capacity; C links −50 against it',
  hCaja.financial_operation_id === Number(op2) && owner(`SELECT SUM(assigned_amount) FROM mp_reconciliation WHERE financial_operation_id = ${op2} AND financial_account_id = '${CAJA}';`) === '-50.00');
const HD = movement({ credit: '0.00', debit: '300.00', gross: '-294.00', fee: '-4.00', tax: '-2.00' });
const hD = reconcile(ADMIN, HD.mv, -100, MPACC, { existing: op2 });
check('H6 counter-assignment correction within both caps: D links −100 on op2 MP (1500 − 100 = 1400 ≤ 1500; movement 100 ≤ 300)',
  !!hD.reconciliation_id && owner(`SELECT SUM(assigned_amount) FROM mp_reconciliation WHERE financial_operation_id = ${op2} AND financial_account_id = '${MPACC}';`) === '1400.00'
  && Number(hD.remaining_unassigned) === -200);
const HE = movement({ credit: '100.00', gross: '101.00', fee: '-0.60', tax: '-0.40' });
const hE = reconcile(ADMIN, HE.mv, 100, MPACC, { existing: op2 });
check('H7 capacity partial then exact: after the correction, +100 fits again (1500 = capacity)', !!hE.reconciliation_id
  && owner(`SELECT SUM(assigned_amount) FROM mp_reconciliation WHERE financial_operation_id = ${op2} AND financial_account_id = '${MPACC}';`) === '1500.00');
const opT = existingOp([[MPACC, 300]]);
const HT = movement({ credit: '300.00', gross: '303.00', fee: '-2.00', tax: '-1.00' });
const opTypeBefore = owner(`SELECT operation_type FROM financial_operation WHERE id = ${opT};`);
const hT = reconcile(ADMIN, HT.mv, 300, MPACC, { existing: opT, opType: 'TRANSFER' });
check('H9 Mode 2 is unchanged: linking a valid existing operation works; p_operation_type is ignored (not validated, never applied to the existing operation)',
  hT.financial_operation_id === Number(opT) && owner(`SELECT operation_type FROM financial_operation WHERE id = ${opT};`) === opTypeBefore
  && owner(`SELECT count(*) FROM financial_posting WHERE financial_operation_id = ${opT};`) === '1');
check('H8 no auto-match: every Mode 2 row references exactly the operation the caller supplied',
  owner(`SELECT count(*) FROM mp_reconciliation WHERE financial_operation_id = ${op2};`) === '5');

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'RLS / privileges / service_role boundary');

check('I1 ADMIN and service_role read all three MP tables; OPERATOR sees nothing', TABLES.every((t) => Number(visible(ADMIN, t)) > 0 && Number(visible(SVC, t)) > 0)
  && TABLES.every((t) => visible(OPER, t) === '0'));
check('I2 anon: no SELECT on any MP table', TABLES.every((t) => denied(ANON(`SELECT 1 FROM ${t};`))));
snap = snapshot();
const direct = [
  ADMIN(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, net_amount, occurred_date) VALUES ('${bSrc}', 'fee', 1, 1, '2026-05-01');`),
  SVC(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, net_amount, occurred_date) VALUES ('${bSrc}', 'fee', 1, 1, '2026-05-01');`),
  SVC(`UPDATE mp_financial_movement SET net_amount = 1;`),
  ADMIN(`DELETE FROM mp_reconciliation;`),
  SVC(`INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key) VALUES (${E.mv}, ${op2}, '${MPACC}', 1, 'x');`),
  SVC(`TRUNCATE mp_source_record CASCADE;`),
  OPER(`UPDATE mp_reconciliation SET assigned_amount = 1;`),
];
check('I3 no direct DML for ADMIN / service_role / OPERATOR beyond the service raw INSERT (RPCs 40/41 only)',
  direct.every(denied) && snapshot() === snap, direct.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
const acl = owner(`SELECT string_agg(relname || '=' || relacl::TEXT, ' ' ORDER BY relname) FROM pg_class WHERE relname IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('I4 exact ACLs: authenticated SELECT; service_role SELECT (+INSERT on mp_source_record only)',
  acl === 'mp_financial_movement={postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=r/postgres} '
  + 'mp_reconciliation={postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=r/postgres} '
  + 'mp_source_record={postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=ar/postgres}', acl);
const pols = owner(`SELECT string_agg(tablename || ':' || policyname || ':' || cmd, ',' ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('I5 policies exactly as frozen RLS §9',
  pols === 'mp_financial_movement:mp_movement_admin_select:SELECT,mp_financial_movement:mp_movement_service_select:SELECT,'
  + 'mp_reconciliation:mp_reconciliation_admin_select:SELECT,mp_reconciliation:mp_reconciliation_service_select:SELECT,'
  + 'mp_source_record:mp_source_admin_select:SELECT,mp_source_record:mp_source_service_insert:INSERT,mp_source_record:mp_source_service_select:SELECT', pols);
const svcOut = ['clients', 'pedidos', 'supplier_ledger', 'client_ledger', 'daily_production', 'population_events', 'purchases'].map((t) => SVC(`SELECT 1 FROM ${t};`));
check('I6 service_role has no access to clients, Pedidos, ledgers or production', svcOut.every(denied), svcOut.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
check('I7 function grants: RPC 40 service_role only; RPC 41 authenticated + service_role; neither for anon',
  owner(`SELECT string_agg(proname || '=' || has_function_privilege('service_role', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE')
     || ':' || has_function_privilege('anon', oid, 'EXECUTE'), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('mp_normalize_source','mp_reconcile_movement');`)
  === 'mp_normalize_source=true:false:false,mp_reconcile_movement=true:true:false');

// ═══════════════════════════════════════════════════════════════════════════
section('J', 'Periods (determinant = MP occurred_date)');

const JM = movement({ date: '2026-03-12T10:00:00.000-03:00' });
closePeriod('2026-03-01');
snap = snapshot();
r = ADMIN(`SELECT ${recCall(JM.mv, 10, newKey(), MPACC)};`);
const rJ2 = ADMIN(`SELECT ${recCall(JM.mv, 10, newKey(), MPACC, null, op2)};`);
check('J1 movement dated in a CLOSED month → PERIOD_CLOSED (Mode 1 and Mode 2); nothing written', raised(r, 'PERIOD_CLOSED') && raised(rJ2, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
// ADR-006 §P23 (J/K/L amendment): a valid payout row, the same fixture shape as movement(); payment rows park DEFERRED_V4
const jSrc = ingest(synth({ desc: 'payout', date: '2026-03-20T10:00:00.000-03:00' }));
const jn = normalize(jSrc);
check('J2 normalization has no period guard (frozen RPC 40): a valid payout source dated in March normalizes while March is CLOSED; the movement carries 2026-03-20',
  jn.processing_status === 'NORMALIZED' && movOf(jSrc).endsWith(':2026-03-20'));
openPeriod('2026-03-01');
const JX = movement({ date: '2027-02-10T10:00:00.000-03:00' });
r = ADMIN(`SELECT ${recCall(JX.mv, 10, newKey(), MPACC)};`);
check('J3 movement dated without a management_period → PERIOD_NOT_FOUND', raised(r, 'PERIOD_NOT_FOUND'), firstErr(r));
closePeriod(CURRENT_MONTH);
const JO = movement({ date: '2026-05-31T23:30:00.000-03:00' });
const jo = reconcile(ADMIN, JO.mv, 100, MPACC);
check(`J4 reconciled_at / processed_at never decide: current month ${CURRENT_MONTH} CLOSED, a May movement reconciles; operation and posting dated 2026-05-31 (local date of 23:30 −03:00)`,
  owner(`SELECT o.effective_date || '|' || p.effective_date FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id WHERE o.id = ${jo.financial_operation_id};`)
  === '2026-05-31|2026-05-31');
openPeriod(CURRENT_MONTH);

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'Atomicity (injected failures)');

const KM = movement({ credit: '1000.00' });
const KN = movement({ credit: '100.00', gross: '101.00', fee: '-0.60', tax: '-0.40' });
const opK = existingOp([[MPACC, 500]]);
// ADR-006 §P23 (J/K/L amendment): valid payout rows, so RPC 40 reaches the movement insert under injected failure
const kPending = ingest(synth({ desc: 'payout' }));
const kPending2 = ingest(synth({ desc: 'payout' }));
const kPending3 = ingest(synth({ desc: 'payout' }));
owner(`
CREATE SCHEMA p23_harness;
CREATE TABLE p23_harness.fail_on (target TEXT, marker TEXT);
CREATE FUNCTION p23_harness.mov_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM p23_harness.fail_on WHERE target = 'mov' AND marker = NEW.mp_source_record_id::TEXT) THEN RAISE EXCEPTION 'HARNESS_FAIL_MOVEMENT'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p23_harness.src_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM p23_harness.fail_on WHERE target = 'src' AND marker = NEW.id::TEXT) THEN RAISE EXCEPTION 'HARNESS_FAIL_SOURCE_UPDATE'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p23_harness.op_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM p23_harness.fail_on WHERE target = 'op' AND marker = NEW.external_ref) THEN RAISE EXCEPTION 'HARNESS_FAIL_OPERATION'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p23_harness.post_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM p23_harness.fail_on f JOIN public.financial_operation o ON o.external_ref = f.marker WHERE f.target = 'post' AND o.id = NEW.financial_operation_id) THEN RAISE EXCEPTION 'HARNESS_FAIL_POSTING'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p23_harness.rec_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM p23_harness.fail_on WHERE target = 'rec' AND marker = NEW.idempotency_key) THEN RAISE EXCEPTION 'HARNESS_FAIL_RECONCILIATION'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p23_harness.audit_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM p23_harness.fail_on WHERE target = 'audit' AND (marker = NEW.entity_id OR marker = NEW.reason)) THEN RAISE EXCEPTION 'HARNESS_FAIL_AUDIT'; END IF; RETURN NEW; END $$;
CREATE TRIGGER p23_mov_ins BEFORE INSERT ON public.mp_financial_movement FOR EACH ROW EXECUTE FUNCTION p23_harness.mov_ins();
CREATE TRIGGER p23_src_upd BEFORE UPDATE ON public.mp_source_record FOR EACH ROW EXECUTE FUNCTION p23_harness.src_upd();
CREATE TRIGGER p23_op_ins BEFORE INSERT ON public.financial_operation FOR EACH ROW EXECUTE FUNCTION p23_harness.op_ins();
CREATE TRIGGER p23_post_ins BEFORE INSERT ON public.financial_posting FOR EACH ROW EXECUTE FUNCTION p23_harness.post_ins();
CREATE TRIGGER p23_rec_ins BEFORE INSERT ON public.mp_reconciliation FOR EACH ROW EXECUTE FUNCTION p23_harness.rec_ins();
CREATE TRIGGER p23_audit_ins BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION p23_harness.audit_ins();`);
const failOn = (t, m) => owner(`DELETE FROM p23_harness.fail_on; INSERT INTO p23_harness.fail_on VALUES ('${t}', '${esc(m)}');`);
try {
  snap = snapshot();
  for (const [what, t, src, code] of [
    ['at the movement insert', 'mov', kPending, 'HARNESS_FAIL_MOVEMENT'],
    ['after the movement, at the source metadata update', 'src', kPending2, 'HARNESS_FAIL_SOURCE_UPDATE'],
    ['after movement + metadata, at the audit', 'audit', kPending3, 'HARNESS_FAIL_AUDIT'],
  ]) {
    failOn(t, src);
    const before = rawOf(src);
    r = SVC(`SELECT mp_normalize_source('${src}');`);
    check(`K1 RPC 40 fails ${what} → source still PENDING, raw untouched, no movement, no audit`,
      raised(r, code) && snapshot() === snap && statusOf(src) === 'PENDING' && rawOf(src) === before && movOf(src) === '', firstErr(r));
  }
  for (const [what, t, mode, code] of [
    ['Mode 1 at the operation insert', 'op', 1, 'HARNESS_FAIL_OPERATION'],
    ['Mode 1 after the operation, at the posting', 'post', 1, 'HARNESS_FAIL_POSTING'],
    ['Mode 1 after operation + posting, at the reconciliation', 'rec', 1, 'HARNESS_FAIL_RECONCILIATION'],
    ['Mode 1 after the reconciliation, at the source status update (final assignment)', 'src', 1, 'HARNESS_FAIL_SOURCE_UPDATE'],
    ['Mode 1 at the audit', 'audit', 1, 'HARNESS_FAIL_AUDIT'],
    ['Mode 2 at the reconciliation', 'rec', 2, 'HARNESS_FAIL_RECONCILIATION'],
    ['Mode 2 at the audit', 'audit', 2, 'HARNESS_FAIL_AUDIT'],
  ]) {
    const key = newKey();
    const mv = mode === 1 ? KM.mv : KN.mv;
    const amount = mode === 1 ? 1000 : 100;
    const src = mode === 1 ? KM.src : KN.src;
    failOn(t, t === 'op' || t === 'post' ? `MP:${key}` : t === 'src' ? src : t === 'audit' ? `${TAG}-audit` : key);
    r = ADMIN(`SELECT ${recCall(mv, amount, key, MPACC, null, mode === 2 ? opK : null, `${TAG}-audit`)};`);
    check(`K2 RPC 41 fails ${what} → full rollback: no operation / posting without reconciliation, no reconciliation without posting, source not RECONCILED`,
      raised(r, code) && snapshot() === snap && assignedOf(mv) === '0' && statusOf(src) === 'NORMALIZED', firstErr(r));
  }
} finally {
  owner(`DROP SCHEMA IF EXISTS p23_harness CASCADE;`);
}
check('K3 harness triggers removed', owner(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p23_%';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'Concurrency (independent PostgreSQL sessions)');

const lSrc = ingest(synth({ desc: 'payout' }));   // ADR-006 §P23 (J/K/L amendment): valid payout row
x = await race('svc', `SELECT mp_normalize_source('${lSrc}');`, 'svc', `SELECT mp_normalize_source('${lSrc}');`, 'p23-norm');
check('L1 normalize the same source twice concurrently: B waited, then ALREADY_PROCESSED; exactly one movement',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'ALREADY_PROCESSED') && owner(`SELECT count(*) FROM mp_financial_movement WHERE mp_source_record_id = '${lSrc}';`) === '1', firstErr(x.rb));
const L2 = movement({ credit: '1000.00' });
x = await race('admin', `SELECT ${recCall(L2.mv, 600, newKey(), MPACC)};`, 'admin', `SELECT ${recCall(L2.mv, 600, newKey(), MPACC)};`, 'p23-cap');
check('L2 two assignments racing on one movement (600 + 600 > 1000): B waited on the movement lock, then OVER_ASSIGNMENT; 600 assigned',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'OVER_ASSIGNMENT') && assignedOf(L2.mv) === '600.00', firstErr(x.rb));
x = await race('admin', `SELECT ${recCall(L2.mv, 300, newKey(), MPACC)};`, 'svc', `SELECT ${recCall(L2.mv, 100, newKey(), MPACC)};`, 'p23-final');
check('L3 final assignments that are both valid (300 + 100 of the remaining 400) are both accepted in order → RECONCILED, never over',
  x.aIn && x.bWait && x.ra.ok && x.rb.ok && assignedOf(L2.mv) === '1000.00' && statusOf(L2.src) === 'RECONCILED', firstErr(x.rb));
const L4 = movement({ credit: '1000.00' });
const lKey = newKey();
x = await race('admin', `SELECT ${recCall(L4.mv, 100, lKey, MPACC)};`, 'svc', `SELECT ${recCall(L4.mv, 100, lKey, MPACC)};`, 'p23-key');
check('L4 the same idempotency key concurrently: B waited, then DUPLICATE_RECONCILIATION; exactly one operation, posting and reconciliation',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_RECONCILIATION')
  && owner(`SELECT (SELECT count(*) FROM mp_reconciliation WHERE idempotency_key = '${lKey}') || '|' || (SELECT count(*) FROM financial_operation WHERE external_ref = 'MP:${lKey}')
     || '|' || (SELECT count(*) FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id WHERE o.external_ref = 'MP:${lKey}');`) === '1|1|1', firstErr(x.rb));
const dupRow = synth();
const dupSql = `INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
  VALUES ('csv_import', '${extIdOf(dupRow)}', '${esc(JSON.stringify(dupRow))}'::jsonb, '${dupRow.DATE}', '2026-05-10');`;
x = await race('svc', dupSql, 'svc', dupSql, 'p23-ingest');
check('L5 duplicate ingestion racing: B waited on the UNIQUE index, then was rejected; one source',
  x.aIn && x.bWait && x.ra.ok && violates(x.rb, 'mp_source_record_source_type_external_id_key')
  && owner(`SELECT count(*) FROM mp_source_record WHERE external_id = '${extIdOf(dupRow)}';`) === '1', firstErr(x.rb));
const L6 = movement({ credit: '200.00', gross: '202.00', fee: '-1.00', tax: '-1.00' });
const L6sib = owner(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, net_amount, occurred_date)
  VALUES ('${L6.src}', 'fee', -5.00, -5.00, '2026-05-10') RETURNING id;`);
x = await race('admin', `SELECT ${recCall(L6.mv, 200, newKey(), MPACC)};`, 'admin', `SELECT ${recCall(L6sib, -5, newKey(), MPACC)};`, 'p23-sib');
check('L6 sibling movements completed concurrently: B waited on the source lock; the transition is not missed → RECONCILED',
  x.aIn && x.bWait && x.ra.ok && x.rb.ok && statusOf(L6.src) === 'RECONCILED', firstErr(x.rb));
const opL = existingOp([[MPACC, 1000]]);
const L7a = movement({ credit: '700.00', gross: '707.00', fee: '-4.00', tax: '-3.00' });
const L7b = movement({ credit: '700.00', gross: '707.00', fee: '-4.00', tax: '-3.00' });
x = await race('admin', `SELECT ${recCall(L7a.mv, 700, newKey(), MPACC, null, opL)};`, 'admin', `SELECT ${recCall(L7b.mv, 700, newKey(), MPACC, null, opL)};`, 'p23-opcap');
check('L7 two movements linking the same operation (700 + 700 > 1000): B waited on the operation lock, then OPERATION_OVER_ASSIGNMENT',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'OPERATION_OVER_ASSIGNMENT')
  && owner(`SELECT SUM(assigned_amount) FROM mp_reconciliation WHERE financial_operation_id = ${opL};`) === '700.00', firstErr(x.rb));

// ═══════════════════════════════════════════════════════════════════════════
section('M', 'SECURITY DEFINER');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
check('M1 SECURITY DEFINER inventory = previous 38 + RPCs 40–41 + built later-phase RPCs (the raw guard is not a definer)', definers === ALL_DEFINERS, definers);
const hard = owner(`SELECT string_agg(proname || '=' || prosecdef || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || ':' || pg_get_userbyid(proowner) || ':'
  || (proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)), ',' ORDER BY proname)
  FROM pg_proc WHERE proname IN (${MP_RPCS.map((p) => `'${p}'`).join(',')});`);
check('M2 each: DEFINER, search_path=public, owner postgres, no PUBLIC', hard === MP_RPCS.map((p) => `${p}=true:true:postgres:true`).join(','), hard);
const sigs = owner(`SELECT string_agg(proname || '(' || pg_get_function_identity_arguments(oid) || ')', ' ; ' ORDER BY proname) FROM pg_proc WHERE proname IN (${MP_RPCS.map((p) => `'${p}'`).join(',')});`);
check('M3 signatures: RPC 40 frozen; RPC 41 as amended by ADR-003 (idempotency key, account required, existing operation); no actor parameter',
  sigs === 'mp_normalize_source(p_source_record_id uuid) ; mp_reconcile_movement(p_movement_id bigint, p_assigned_amount numeric, p_idempotency_key character varying, '
  + 'p_financial_account_id uuid, p_operation_type financial_operation_type, p_existing_financial_operation_id bigint, p_reason text)', sigs);

// ═══════════════════════════════════════════════════════════════════════════
section('N', 'No parallel ledger / legacy MP status in the target');

check('N1 no legacy MP object exists in the target DB (mercadopago_*, ledger_entry, account_balance, sync_metadata, mp_movement_source_link, …)',
  owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('mercadopago_raw','mercadopago_movements','mercadopago_settlement',
    'ledger_entry','account_balance','sync_metadata','monthly_reconciliation','reconciliation_snapshot','period_flow_observation','import_period_coverage',
    'mp_financial_cycle','mp_import_exception','mp_source_link_resolution','mp_movement_source_link','webhook_events');`) === '0');
check('N2 the target migration ledger contains only target-migrations files (no legacy migration applied)',
  owner(`SELECT count(*) FROM migration_ledger.applied WHERE filename !~ '^[0-9]{4}_';`) === '0');
check('N3 every MP-created operation is traceable to a movement; balances are only SUM(financial_posting)',
  owner(`SELECT count(*) FROM financial_operation o WHERE o.source_entity_type = 'mp_financial_movement'
         AND NOT EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.financial_operation_id = o.id);`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('P', 'End to end (real Liberaciones row)');

const pRow = fromLine('2026-02-06T22:44:17.000-03:00;145187899970;payment;19.88;0.00;20.00;0.00;-0.12;available_money;2026-02-06T22:44:17.000-03:00;;;20.87;account_money;'); // Liberaciones1.csv
const pSrc = ingest(pRow);
const pRaw = rawOf(pSrc);
const pMp0 = cents(balance(MPACC));
const pn = normalize(pSrc);
check('P1 service ingests the real payment row 145187899970: validated, then parked PENDING DEFERRED_V4 (ADR-006); no movement; raw unchanged',
  pn.processing_status === 'PENDING' && movOf(pSrc) === '' && rawOf(pSrc) === pRaw);
// P2–P4 (ADR-006 §P23): the end-to-end RPC 41 pipeline on the D5 real payout movement (146231746361, net −532415.53)
const pRawOut = rawOf(sPayout);
const pMv = movId(sPayout);
const pp1 = reconcile(SVC, pMv, -10000, MPACC);
check('P2 partial reconciliation to the Mercado Pago account: posting −10000.00 dated 2026-02-19; remaining −522415.53 derived; source still NORMALIZED',
  cents(pp1.remaining_unassigned) === -52241553 && statusOf(sPayout) === 'NORMALIZED' && cents(balance(MPACC)) === pMp0 - 1000000);
const pp2 = reconcile(SVC, pMv, -522415.53, MPACC);
check('P3 final reconciliation → remaining 0, RECONCILED; the account moved exactly −532415.53, only through postings',
  cents(pp2.remaining_unassigned) === 0 && statusOf(sPayout) === 'RECONCILED' && cents(balance(MPACC)) === pMp0 - 53241553);
check('P4 raw source byte-identical after the whole pipeline', rawOf(sPayout) === pRawOut);
} finally {
  cleanup();
}

section('Z', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM mp_source_record) + (SELECT count(*) FROM mp_financial_movement) + (SELECT count(*) FROM mp_reconciliation)
  + (SELECT count(*) FROM financial_operation WHERE source_entity_type = 'mp_financial_movement' OR external_ref LIKE '${TAG}%' OR external_ref LIKE 'MP:%')
  + (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'p23_harness') + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p23_%');`);
check('Z1 all MP rows, MP-created and fixture operations/postings, harness schema and triggers removed; raw guard re-enabled',
  left === '0' && owner(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_mp_source_raw_guard';`) === 'O', left);
check('Z2 periods closed by the suite are OPEN again',
  owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`) === '0');

console.log(`\n  ══ MP RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
