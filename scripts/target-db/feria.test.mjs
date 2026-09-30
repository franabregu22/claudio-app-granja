#!/usr/bin/env node
/**
 * PHASE 21 — FERIA TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Behavioural tests of RPCs 30–33 (open_sales_session, register_session_movement,
 * register_session_cash_event, close_sales_session) over sales_session,
 * sales_session_movement and sales_session_cash_event, reusing pedidos /
 * pedido_lineas / deliver_order (Commercial) and financial_operation /
 * financial_posting (Treasury).
 *
 * The session is the operational event; the Pedido is the economic fact.
 * Anonymous retail is one aggregated CONSUMIDOR FINAL Pedido per session;
 * identified clients keep their own Pedidos. COUNT is an observation.
 *
 * Role-scoped calls simulate real Supabase sessions with two operator profiles
 * (A, B) and ADMIN. Failure injection uses test-only triggers in schema
 * p21_harness (dropped at the end). The concurrency group runs independent
 * PostgreSQL sessions.
 *
 * Fixtures: every session key starts with "P21-TEST:"; products, the expense
 * category and the identified client are named "P21-TEST …". The seeded
 * CONSUMIDOR FINAL master is reused (temporarily deactivated in one test and
 * always restored). Operator B is a Phase 21 fixture removed at the end.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/feria.test.mjs
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
const ADR005_VIEWS = ['report_balance_period', 'report_classification_day', 'report_feed_consumption_interval', 'report_feria_session_cash',
  'report_flock_day', 'report_mp_movement_status', 'report_sales_line'].map((v) => `'${v}'`).join(',');   // ADR-005 derived views (Phase 25): no stored value, proven by reporting.test.mjs

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPA = '22222222-2222-2222-2222-222222222222';
const OPB = '88888888-8888-8888-8888-888888888888';
const INACTIVE_UID = '33333333-3333-3333-3333-333333333333';
const NOPROFILE_UID = '44444444-4444-4444-4444-444444444444';
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'P21-TEST';
const KEY_PREFIX = `${TAG}:`;
const TABLES = ['sales_session', 'sales_session_cash_event', 'sales_session_movement'];
const FERIA_RPCS = ['close_sales_session', 'open_sales_session', 'register_session_cash_event', 'register_session_movement'];
const ALL_DEFINERS = 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,'
  + 'close_flock,close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_apply_transition,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_report_fallback,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,open_sales_session,pay_fiscal_obligation,pay_supplier,receive_cheque,'
  + 'rectify_daily_production,rectify_delivered_order,rectify_mortality,rectify_purchase,register_classification,register_collection,'
  + 'register_count_adjustment,register_daily_production,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,'
  + 'register_fiscal_document,register_fiscal_obligation,register_flock,register_freight,register_management_event,register_mortality,register_purchase,register_session_cash_event,register_session_movement,reject_cheque,'
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
const sessionSql = (pgRole, claims, sqlText) => `
BEGIN;
SET LOCAL ROLE ${pgRole};
SET LOCAL "request.jwt.claims" = '${JSON.stringify(claims).replace(/'/g, "''")}';
${sqlText}
COMMIT;`;
const asRole = (pgRole, claims, sqlText) => raw(sessionSql(pgRole, claims, sqlText));
const claimsOf = (uid) => ({ sub: uid, role: 'authenticated' });
const asUser = (uid, sqlText) => asRole('authenticated', claimsOf(uid), sqlText);
const ADMIN = (sqlText) => asUser(ADMIN_UID, sqlText);
const A = (sqlText) => asUser(OPA, sqlText);
const B = (sqlText) => asUser(OPB, sqlText);
const asAnon = (sqlText) => asRole('anon', { role: 'anon' }, sqlText);
const asServiceRole = (sqlText) => asRole('service_role', { role: 'service_role' }, sqlText);

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
// A runs sqlA and then holds its transaction open; B starts once A is inside.
async function race(uidA, sqlA, uidB, sqlB, appPrefix, expectWait = true) {
  const pA = session(sessionSql('authenticated', claimsOf(uidA), `${sqlA}\nSELECT pg_sleep(2);`), `${appPrefix}-A`);
  const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-A'
    AND state = 'active' AND query LIKE '%pg_sleep%');`);
  const pB = session(sessionSql('authenticated', claimsOf(uidB), sqlB), `${appPrefix}-B`);
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
const rpc = (call) => rpcAs(ADMIN, call);
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 180);
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
const TS = `(SELECT id FROM sales_session WHERE idempotency_key LIKE '${KEY_PREFIX}%')`;
const TC = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
const TP = `(SELECT id FROM pedidos WHERE sales_session_id IN ${TS} OR cliente_id IN ${TC})`;
const TO = `(SELECT id FROM financial_operation WHERE source_entity_type = 'sales_session' AND source_entity_id IN (SELECT id::TEXT FROM ${TS} s))`;
function cleanup() {
  owner(`
DROP SCHEMA IF EXISTS p21_harness CASCADE;
UPDATE clients SET activo = true WHERE nombre = 'CONSUMIDOR FINAL';
UPDATE sales_session SET aggregated_pedido_id = NULL WHERE id IN ${TS};
DELETE FROM audit_events WHERE entity_type = 'pedido' AND entity_id IN (SELECT id::TEXT FROM ${TP} p);
DELETE FROM client_ledger WHERE source_entity_type = 'pedido' AND source_entity_id IN (SELECT id::TEXT FROM ${TP} p);
DELETE FROM pedido_lineas WHERE pedido_id IN ${TP};
DELETE FROM pedidos WHERE id IN ${TP};
DELETE FROM audit_events WHERE entity_type = 'sales_session_cash_event'
   AND entity_id IN (SELECT id::TEXT FROM sales_session_cash_event WHERE sales_session_id IN ${TS});
DELETE FROM sales_session_cash_event WHERE sales_session_id IN ${TS};
DELETE FROM financial_posting WHERE financial_operation_id IN ${TO};
DELETE FROM financial_operation WHERE id IN ${TO};
DELETE FROM audit_events WHERE entity_type = 'sales_session_movement'
   AND entity_id IN (SELECT id::TEXT FROM sales_session_movement WHERE sales_session_id IN ${TS});
DELETE FROM sales_session_movement WHERE sales_session_id IN ${TS};
DELETE FROM audit_events WHERE entity_type = 'sales_session' AND entity_id IN (SELECT id::TEXT FROM ${TS} s);
DELETE FROM sales_session WHERE id IN ${TS};
DELETE FROM products WHERE nombre LIKE '${TAG}%';
DELETE FROM expense_category WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
-- operator B is a Phase 21 fixture: removed so other suites keep their exact profile counts
DELETE FROM audit_events WHERE performed_by = '${OPB}';
DELETE FROM operator_assignments WHERE operator_id = '${OPB}';
DELETE FROM perfiles WHERE id = '${OPB}';
DELETE FROM auth.users WHERE id = '${OPB}';
UPDATE management_period SET status = 'OPEN', closed_at = NULL
 WHERE periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
}

cleanup();   // first: remove leftovers of an earlier run
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES
  ('${ADMIN_UID}', false, false), ('${OPA}', false, false), ('${OPB}', false, false),
  ('${INACTIVE_UID}', false, false), ('${NOPROFILE_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true),
  ('${OPA}', 'operator@test.local', 'OPERATOR', true),
  ('${OPB}', 'operator-p21@test.local', 'OPERATOR', true),
  ('${INACTIVE_UID}', 'inactive@test.local', 'OPERATOR', false)
ON CONFLICT (id) DO NOTHING;`);

// ── helpers ────────────────────────────────────────────────────────────────
let keySeq = 0;
const newKey = () => `${KEY_PREFIX}${String(++keySeq).padStart(4, '0')}`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${v}'`);
const n = (v) => (v === null || v === undefined ? 'NULL' : String(v));
const j = (v) => (v === null || v === undefined ? 'NULL' : `'${JSON.stringify(v)}'::jsonb`);

const openCall = (date, location, key, fund, account) =>
  `open_sales_session(${q(date)}, ${q(location)}, ${q(key)}${fund === undefined ? '' : `, ${n(fund)}`}${account === undefined ? '' : `, ${q(account)}`})`;
const moveCall = (s, type, producto, cantidad, reason = null) =>
  `register_session_movement(${q(s)}, ${q(type)}, ${q(producto)}, ${n(cantidad)}, ${q(reason)})`;
const cashCall = (s, type, amount, account = null, category = null, dest = null, reason = null) =>
  `register_session_cash_event(${q(s)}, ${q(type)}, ${n(amount)}, ${q(account)}, ${q(category)}, ${q(dest)}, ${q(reason)})`;
const closeCall = (s, lines, reason = null) => `close_sales_session(${q(s)}, ${j(lines)}, ${q(reason)})`;
const L = (producto, cantidad, precio) => ({ producto_id: producto, cantidad, precio_unitario: precio });
const openS = (date, location = 'Feria test', fund, account) => {
  const key = newKey();
  return { key, ...rpc(openCall(date, location, key, fund, account)) };
};

const sessionRow = (id) => owner(`SELECT session_date || '|' || location || '|' || estado || '|' || coalesce(aggregated_pedido_id::TEXT, '-') || '|'
  || coalesce(opened_by::TEXT, '-') || '|' || coalesce(closed_by::TEXT, '-') || '|' || (closed_at IS NOT NULL) FROM sales_session WHERE id = '${id}';`);
const balance = (acc) => owner(`SELECT coalesce(SUM(signed_amount), 0) FROM financial_posting WHERE financial_account_id = '${acc}';`);
const snapshot = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM sales_session), (SELECT count(*) FROM sales_session_movement),
  (SELECT count(*) FROM sales_session_cash_event), (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT count(*) FROM pedidos), (SELECT count(*) FROM pedido_lineas), (SELECT count(*) FROM client_ledger), (SELECT count(*) FROM audit_events));`);
const econ = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT count(*) FROM client_ledger), (SELECT count(*) FROM supplier_ledger), (SELECT count(*) FROM collections),
  (SELECT count(*) FROM pedidos), (SELECT count(*) FROM pedido_lineas), (SELECT count(*) FROM purchases));`);
const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);
const visible = (fn, t, where) => { const x2 = fn(`SELECT count(*) FROM ${t} WHERE ${where};`); return x2.ok ? x2.out : `ERR ${firstErr(x2)}`; };
const pedidosOf = (s) => owner(`SELECT count(*) FROM pedidos WHERE sales_session_id = '${s}';`);

let r;
let snap;
let x;

try {
// ── masters / fixtures (ADMIN master path) ────────────────────────────────
const XL = okAs(ADMIN, `INSERT INTO products (nombre, product_type) VALUES ('${TAG} Huevo XL', 'VENDIBLE') RETURNING id;`);
const N1 = okAs(ADMIN, `INSERT INTO products (nombre, product_type) VALUES ('${TAG} Huevo N1', 'VENDIBLE') RETURNING id;`);
const MAPLE = okAs(ADMIN, `INSERT INTO products (nombre, product_type) VALUES ('${TAG} Maple', 'VENDIBLE') RETURNING id;`);
const CAT = okAs(ADMIN, `INSERT INTO expense_category (nombre, pnl_cost_class) VALUES ('${TAG} Gastos de feria', 'INDIRECT') RETURNING id;`);
const MAYORISTA = okAs(ADMIN, `INSERT INTO clients (nombre) VALUES ('${TAG} Mayorista') RETURNING id;`);
const CAJA = owner(`SELECT id FROM financial_account WHERE nombre = 'Caja chica';`);
const BNA = owner(`SELECT id FROM financial_account WHERE nombre = 'BNA';`);
const CF = owner(`SELECT id FROM clients WHERE nombre = 'CONSUMIDOR FINAL';`);
const econAtStart = econ();

// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure');

const colsOf = (t) => owner(`SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = '${t}';`);
check('A1 the three Feria tables exist', owner(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN (${TABLES.map((t) => `'${t}'`).join(',')});`) === TABLES.join(','));
const wantCols = {
  sales_session: 'id:uuid,session_date:date,location:character varying,estado:USER-DEFINED,aggregated_pedido_id:uuid,opened_at:timestamp with time zone,'
    + 'opened_by:uuid,closed_at:timestamp with time zone,closed_by:uuid,idempotency_key:character varying,created_at:timestamp with time zone',
  sales_session_movement: 'id:bigint,sales_session_id:uuid,movement_type:USER-DEFINED,producto_id:uuid,cantidad:numeric,reason:text,'
    + 'created_at:timestamp with time zone,created_by:uuid',
  sales_session_cash_event: 'id:bigint,sales_session_id:uuid,event_type:USER-DEFINED,amount:numeric,financial_account_id:uuid,expense_category_id:uuid,'
    + 'financial_operation_id:bigint,event_date:date,reason:text,created_at:timestamp with time zone,created_by:uuid',
};
const badCols = Object.entries(wantCols).filter(([t, c]) => colsOf(t) !== c).map(([t]) => `${t}=${colsOf(t)}`);
check('A2 columns of all three tables exactly as frozen Domain J', badCols.length === 0, badCols.join(' ; '));
const cons = owner(`SELECT string_agg(conrelid::regclass || '.' || conname || ':' || contype::TEXT, ',' ORDER BY conrelid::regclass::TEXT, conname) FROM pg_constraint
  WHERE conrelid IN (${TABLES.map((t) => `'${t}'::regclass`).join(',')}) AND contype IN ('u','c');`);
check('A3 UNIQUE / CHECK constraints exactly as frozen',
  cons === 'sales_session.sales_session_idempotency_key_key:u,'
  + 'sales_session_cash_event.chk_session_expense_category:c,sales_session_cash_event.sales_session_cash_event_amount_check:c,'
  + 'sales_session_movement.sales_session_movement_cantidad_check:c', cons);
const fks = owner(`SELECT string_agg(x, ',' ORDER BY x) FROM (
  SELECT c.conrelid::regclass || '.' || a.attname || '>' || c.confrelid::regclass || ':' || c.confdeltype::TEXT AS x
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.conrelid IN (${TABLES.map((t) => `'${t}'::regclass`).join(',')})) s;`);
check('A4 FKs exactly as frozen, all ON DELETE RESTRICT',
  fks === 'sales_session.aggregated_pedido_id>pedidos:r,sales_session.closed_by>perfiles:r,sales_session.opened_by>perfiles:r,'
  + 'sales_session_cash_event.created_by>perfiles:r,sales_session_cash_event.expense_category_id>expense_category:r,'
  + 'sales_session_cash_event.financial_account_id>financial_account:r,sales_session_cash_event.financial_operation_id>financial_operation:r,'
  + 'sales_session_cash_event.sales_session_id>sales_session:r,'
  + 'sales_session_movement.created_by>perfiles:r,sales_session_movement.producto_id>products:r,sales_session_movement.sales_session_id>sales_session:r', fks);
const idx = owner(`SELECT string_agg(indexname || '=' || regexp_replace(indexdef, '^.* USING ', ''), ' ; ' ORDER BY indexname) FROM pg_indexes
  WHERE indexname IN ('idx_sales_session_date','idx_session_movement_session','idx_session_cash_session');`);
check('A5 indexes: session_date; movements by session; cash events by session',
  idx === 'idx_sales_session_date=btree (session_date) ; idx_session_cash_session=btree (sales_session_id) ; idx_session_movement_session=btree (sales_session_id)', idx);
const cyc = owner(`SELECT string_agg(conname || ':' || convalidated, ',' ORDER BY conname) FROM pg_constraint
  WHERE conname IN ('fk_pedidos_sales_session','fk_sales_session_aggregated_pedido','collections_sales_session_id_fkey',
                    'chk_pedidos_sales_session_fk_deferred','chk_collections_sales_session_fk_deferred');`);
check('A6 step 3.6 cycle 1 FKs exist and are validated; the 0010 stand-ins are gone; collections.sales_session_id has its FK',
  cyc === 'collections_sales_session_id_fkey:true,fk_pedidos_sales_session:true,fk_sales_session_aggregated_pedido:true', cyc);
check('A7 invariant 28 backstops: aggregated Pedido requires a session; UNIQUE aggregated Pedido per session',
  owner(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_pedidos_aggregated_has_session';`) === 'CHECK (((NOT is_aggregated_retail) OR (sales_session_id IS NOT NULL)))'
  && owner(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_pedidos_one_aggregate_per_session';`)
  === 'CREATE UNIQUE INDEX idx_pedidos_one_aggregate_per_session ON public.pedidos USING btree (sales_session_id) WHERE is_aggregated_retail');
check('A8 RLS enabled on the three tables', owner(`SELECT count(*) FROM pg_class WHERE relname IN (${TABLES.map((t) => `'${t}'`).join(',')}) AND relrowsecurity;`) === '3');
check('A9 no parallel sales table and no stored balance / total / variance column in the Feria tables',
  owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(venta|sale|retail|ticket)' AND table_name NOT LIKE 'sales_session%' AND table_name NOT IN (${ADR005_VIEWS});`) === '0'
  && owner(`SELECT count(*) FROM information_schema.columns WHERE table_name IN (${TABLES.map((t) => `'${t}'`).join(',')})
    AND column_name ~* '(balance|saldo|total|variance|diferencia|expected)';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Open session (RPC 30, ADMIN only)');

let econ0 = econ();
const cajaBefore = balance(CAJA);
const bKey = newKey();
const b1 = rpc(openCall('2026-05-02', 'Feria Plaza', bKey));
check('B1 ADMIN opens a session → {session_id, estado OPEN}; row exact (date, location, OPEN, opened_by, no aggregate, not closed)',
  !!b1.session_id && b1.estado === 'OPEN' && Object.keys(b1).length === 2
  && sessionRow(b1.session_id) === `2026-05-02|Feria Plaza|OPEN|-|${ADMIN_UID}|-|false`, sessionRow(b1.session_id));
check('B2 no opening fund (default 0): no cash event and no financial operation', econ() === econ0
  && owner(`SELECT count(*) FROM sales_session_cash_event WHERE sales_session_id = '${b1.session_id}';`) === '0');
const b3 = openS('2026-05-02', 'Feria Fondo', 5000, CAJA);
const fundRow = owner(`SELECT e.event_type || '|' || e.amount || '|' || e.financial_account_id || '|' || e.event_date || '|' || o.operation_type || '|' || o.external_ref
  || '|' || o.source_entity_type || '|' || o.source_entity_id || '|' || o.effective_date || '|' || (SELECT count(*) FROM financial_posting p WHERE p.financial_operation_id = o.id)
  FROM sales_session_cash_event e JOIN financial_operation o ON o.id = e.financial_operation_id WHERE e.sales_session_id = '${b3.session_id}';`);
check('B3 opening fund 5000: OPENING_FUND event on the cash account + one SESSION_CASH operation (external_ref SESSION_FUND:<id>) with ZERO postings',
  fundRow === `OPENING_FUND|5000.00|${CAJA}|2026-05-02|SESSION_CASH|SESSION_FUND:${b3.session_id}|sales_session|${b3.session_id}|2026-05-02|0`, fundRow);
check('B4 the opening fund is a transfer into the session, not income and not an outflow: the cash account balance is unchanged, no client ledger, no collection',
  balance(CAJA) === cajaBefore && owner(`SELECT count(*) FROM client_ledger WHERE effective_date = '2026-05-02' AND cliente_id = '${CF}';`) === '0');
snap = snapshot();
r = A(`SELECT ${openCall('2026-05-02', 'x', newKey())};`);
const rNp = asUser(NOPROFILE_UID, `SELECT ${openCall('2026-05-02', 'x', newKey())};`);
const rIn = asUser(INACTIVE_UID, `SELECT ${openCall('2026-05-02', 'x', newKey())};`);
check('B5 OPERATOR → FORBIDDEN; missing / inactive profile → USER_NOT_FOUND_OR_INACTIVE',
  raised(r, 'FORBIDDEN') && raised(rNp, 'USER_NOT_FOUND_OR_INACTIVE') && raised(rIn, 'USER_NOT_FOUND_OR_INACTIVE'), firstErr(r));
for (const [what, call, code] of [
  ['opening fund without cash account', openCall('2026-05-02', 'x', newKey(), 100), 'ACCOUNT_REQUIRED'],
  ['negative opening fund', openCall('2026-05-02', 'x', newKey(), -1, CAJA), 'INVALID_AMOUNT'],
  ['NULL opening fund', openCall('2026-05-02', 'x', newKey(), null, CAJA), 'INVALID_AMOUNT'],
  ['NULL session_date', openCall(null, 'x', newKey()), 'BUSINESS_DATE_REQUIRED'],
  ['duplicate idempotency_key', openCall('2026-05-03', 'otra', bKey), 'DUPLICATE_SESSION'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`B6 ${what} → ${code}`, raised(r, code), firstErr(r));
}
r = ADMIN(`SELECT ${openCall('2026-05-02', null, newKey())};`);
const rKey = ADMIN(`SELECT ${openCall('2026-05-02', 'x', null)};`);
check('B7 NULL location / NULL idempotency_key → rejected by the frozen NOT NULL columns', violates(r, 'location') && violates(rKey, 'idempotency_key'), firstErr(r));
check('B8 every rejection was atomic (no session, event, operation or audit)', snapshot() === snap);
check('B9 audit OPEN: session_date, location, opening_fund, actor',
  owner(`SELECT action || '|' || (after_values->>'session_date') || '|' || (after_values->>'location') || '|' || (after_values->>'opening_fund') || '|' || performed_by
         FROM audit_events WHERE entity_type = 'sales_session' AND entity_id = '${b3.session_id}';`) === `OPEN|2026-05-02|Feria Fondo|5000|${ADMIN_UID}`);
const b10 = openS('2026-05-02', 'Feria Plaza');
check('B10 the same date and location can hold another session (different key): no uniqueness beyond the idempotency key', b10.session_id !== b1.session_id);

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Physical movements (RPC 31, ADMIN only — ADR-009 supersedes the OPERATOR permission)');

econ0 = econ();
const balances0 = [balance(CAJA), balance(BNA)].join('|');
const S = b1.session_id;
snap = snapshot();
const opMoves = [A(`SELECT ${moveCall(S, 'DISPATCH', MAPLE, 100)};`), B(`SELECT ${moveCall(S, 'LOSS', MAPLE, 2, 'maples rotos')};`)];
check('C0 [ADR-009] OPERATOR (assigned or not) → FORBIDDEN on RPC 31; nothing written',
  opMoves.every((x) => raised(x, 'FORBIDDEN')) && snapshot() === snap, opMoves.map(firstErr).join(' / '));
const mv = {
  DISPATCH: rpc(moveCall(S, 'DISPATCH', MAPLE, 100)),
  RETURN: rpc(moveCall(S, 'RETURN', MAPLE, 10)),
  LOSS: rpc(moveCall(S, 'LOSS', MAPLE, 2, 'maples rotos')),
  ADJUSTMENT: rpc(moveCall(S, 'ADJUSTMENT', MAPLE, 1, 'recuento')),
};
const mvRows = owner(`SELECT string_agg(movement_type::TEXT || ':' || cantidad || ':' || coalesce(reason, '-') || ':' || created_by, ',' ORDER BY id)
  FROM sales_session_movement WHERE sales_session_id = '${S}';`);
check('C1 all four physical movement types persist exactly (ADMIN); {movement_id}',
  mvRows === `DISPATCH:100.0000:-:${ADMIN_UID},RETURN:10.0000:-:${ADMIN_UID},LOSS:2.0000:maples rotos:${ADMIN_UID},ADJUSTMENT:1.0000:recuento:${ADMIN_UID}`
  && Object.values(mv).every((m) => typeof m.movement_id === 'number' && Object.keys(m).length === 1), mvRows);
check('C2 physical ≠ sale: no operation, posting, ledger, collection or Pedido; account balances unchanged',
  econ() === econ0 && [balance(CAJA), balance(BNA)].join('|') === balances0 && pedidosOf(S) === '0');
snap = snapshot();
for (const [what, fn, call, code] of [
  ['LOSS without reason', ADMIN, moveCall(S, 'LOSS', MAPLE, 1), 'REASON_REQUIRED'],
  ['ADJUSTMENT with blank reason', ADMIN, moveCall(S, 'ADJUSTMENT', MAPLE, 1, '  '), 'REASON_REQUIRED'],
  ['quantity 0', ADMIN, moveCall(S, 'DISPATCH', MAPLE, 0), 'INVALID_QUANTITY'],
  ['negative quantity', ADMIN, moveCall(S, 'DISPATCH', MAPLE, -1), 'INVALID_QUANTITY'],
  ['NULL quantity', ADMIN, moveCall(S, 'DISPATCH', MAPLE, null), 'INVALID_QUANTITY'],
  ['missing session', ADMIN, moveCall(MISSING_UUID, 'DISPATCH', MAPLE, 1), 'SESSION_NOT_FOUND'],
  ['OPERATOR, even with a valid call', A, moveCall(S, 'DISPATCH', MAPLE, 1), 'FORBIDDEN'],
  ['inactive profile', (s) => asUser(INACTIVE_UID, s), moveCall(S, 'DISPATCH', MAPLE, 1), 'USER_NOT_FOUND_OR_INACTIVE'],
]) {
  r = fn(`SELECT ${call};`);
  check(`C3 ${what} → ${code}`, raised(r, code), firstErr(r));
}
r = ADMIN(`SELECT ${moveCall(S, 'DISPATCH', MISSING_UUID, 1)};`);
check('C4 missing product → rejected by the frozen FK', violates(r, 'sales_session_movement_producto_id_fkey'), firstErr(r));
r = ADMIN(`SELECT ${moveCall(S, 'SALE', MAPLE, 1)};`);
check('C5 movement type outside the frozen enum is rejected', !r.ok && /invalid input value for enum session_movement_type/.test(r.err), firstErr(r));
check('C6 every rejection was atomic', snapshot() === snap);
check('C7 audit CREATE: session_id, movement_type, producto_id, cantidad, reason, actor',
  owner(`SELECT action || '|' || (after_values->>'session_id') || '|' || (after_values->>'movement_type') || '|' || (after_values->>'cantidad') || '|' || reason || '|' || performed_by
         FROM audit_events WHERE entity_type = 'sales_session_movement' AND entity_id = '${mv.LOSS.movement_id}';`) === `CREATE|${S}|LOSS|2|maples rotos|${ADMIN_UID}`);

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Cash events (RPC 32, ADMIN only)');

const D = openS('2026-05-04', 'Feria Caja', 3000, CAJA).session_id;
snap = snapshot();
r = A(`SELECT ${cashCall(D, 'COUNT', 10, CAJA)};`);
check('D1 OPERATOR → FORBIDDEN: cash is financial', raised(r, 'FORBIDDEN') && snapshot() === snap, firstErr(r));
const postingsOf = (op) => owner(`SELECT coalesce(string_agg(financial_account_id || ':' || signed_amount || ':' || effective_date, ',' ORDER BY signed_amount), '') FROM financial_posting WHERE financial_operation_id = ${op};`);
const cajaD0 = balance(CAJA);
const bnaD0 = balance(BNA);
const dExp = rpc(cashCall(D, 'EXPENSE', 300, CAJA, CAT, null, 'viáticos'));
check('D2 EXPENSE 300: one SESSION_CASH operation with ONE posting −300 on the source account, dated session_date; {event_id, financial_operation_id}',
  typeof dExp.event_id === 'number' && typeof dExp.financial_operation_id === 'number' && Object.keys(dExp).length === 2
  && postingsOf(dExp.financial_operation_id) === `${CAJA}:-300.00:2026-05-04`
  && owner(`SELECT operation_type || '|' || source_entity_type || '|' || source_entity_id || '|' || effective_date || '|' || reason FROM financial_operation WHERE id = ${dExp.financial_operation_id};`)
  === `SESSION_CASH|sales_session|${D}|2026-05-04|viáticos`);
const dWd = rpc(cashCall(D, 'WITHDRAWAL', 1000, CAJA, null, null, 'retiro socio'));
check('D3 WITHDRAWAL 1000: one posting −1000; it is a distribution, not an operating expense (no expense category)',
  postingsOf(dWd.financial_operation_id) === `${CAJA}:-1000.00:2026-05-04`
  && owner(`SELECT event_type || '|' || coalesce(expense_category_id::TEXT, 'none') FROM sales_session_cash_event WHERE id = ${dWd.event_id};`) === 'WITHDRAWAL|none');
const dTr = rpc(cashCall(D, 'TRANSFER_OUT', 2000, CAJA, null, BNA, 'depósito'));
check('D4 TRANSFER_OUT 2000 Caja → BNA: exactly two legs (−2000 source, +2000 destination) under ONE operation',
  postingsOf(dTr.financial_operation_id) === `${CAJA}:-2000.00:2026-05-04,${BNA}:2000.00:2026-05-04`);
const opsBefore = owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_posting) FROM financial_operation;`);
const dCount = rpc(cashCall(D, 'COUNT', 4200, CAJA, null, null, 'arqueo'));
check('D5 COUNT 4200: an observation — no operation, no posting; the event carries financial_operation_id NULL',
  dCount.financial_operation_id === null && owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_posting) FROM financial_operation;`) === opsBefore
  && owner(`SELECT coalesce(financial_operation_id::TEXT, 'null') || '|' || amount FROM sales_session_cash_event WHERE id = ${dCount.event_id};`) === 'null|4200.00');
check('D6 account effects exactly: Caja −300 −1000 −2000 = −3300, BNA +2000; the opening fund and the count moved nothing',
  Number(balance(CAJA)) === Number(cajaD0) - 3300 && Number(balance(BNA)) === Number(bnaD0) + 2000);
snap = snapshot();
for (const [what, call, code] of [
  ['EXPENSE without category', cashCall(D, 'EXPENSE', 1, CAJA), 'CATEGORY_REQUIRED'],
  ['EXPENSE without account', cashCall(D, 'EXPENSE', 1, null, CAT), 'ACCOUNT_REQUIRED'],
  ['WITHDRAWAL without account', cashCall(D, 'WITHDRAWAL', 1), 'ACCOUNT_REQUIRED'],
  ['TRANSFER_OUT without account', cashCall(D, 'TRANSFER_OUT', 1, null, null, BNA), 'ACCOUNT_REQUIRED'],
  ['TRANSFER_OUT without destination', cashCall(D, 'TRANSFER_OUT', 1, CAJA), 'DESTINATION_REQUIRED'],
  ['amount 0', cashCall(D, 'COUNT', 0, CAJA), 'INVALID_AMOUNT'],
  ['negative amount', cashCall(D, 'WITHDRAWAL', -5, CAJA), 'INVALID_AMOUNT'],
  ['NULL amount', cashCall(D, 'COUNT', null, CAJA), 'INVALID_AMOUNT'],
  ['NULL event type', cashCall(D, null, 1, CAJA), 'INVALID_EVENT_TYPE'],
  ['OPENING_FUND outside open_sales_session', cashCall(D, 'OPENING_FUND', 1, CAJA), 'INVALID_EVENT_TYPE'],
  ['missing session', cashCall(MISSING_UUID, 'COUNT', 1, CAJA), 'SESSION_NOT_FOUND'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`D7 ${what} → ${code}`, raised(r, code), firstErr(r));
}
check('D8 every rejection was atomic (no event, operation, posting or audit)', snapshot() === snap);
// OWNER DECISION (Phase 21): OPENING_FUND is exclusively the change fund at opening (RPC 30); there is no top-up through RPC 32.
const fundPostings = () => owner(`SELECT count(*) || '|' || coalesce(SUM(signed_amount), 0) FROM financial_posting WHERE financial_account_id = '${CAJA}';`);
const ofBefore = [snapshot(), fundPostings(), owner(`SELECT count(*) FROM sales_session_cash_event WHERE sales_session_id = '${D}' AND event_type = 'OPENING_FUND';`)];
r = ADMIN(`SELECT ${cashCall(D, 'OPENING_FUND', 700, CAJA, null, null, 'top up')};`);
check('D8b owner decision: RPC 32 rejects OPENING_FUND (INVALID_EVENT_TYPE) on an OPEN session that already has its RPC 30 fund; '
  + 'no operation, no additional posting, the session still has exactly one OPENING_FUND event',
  raised(r, 'INVALID_EVENT_TYPE') && ofBefore[0] === snapshot() && ofBefore[1] === fundPostings() && ofBefore[2] === '1'
  && owner(`SELECT count(*) FROM sales_session_cash_event WHERE sales_session_id = '${D}' AND event_type = 'OPENING_FUND';`) === '1', firstErr(r));
r = raw(`INSERT INTO sales_session_cash_event (sales_session_id, event_type, amount, event_date) VALUES ('${D}', 'EXPENSE', 1, '2026-05-04');`);
check('D9 physical backstop: an EXPENSE without category violates chk_session_expense_category (even for the owner)', violates(r, 'chk_session_expense_category'), firstErr(r));
check('D10 audit CREATE: session_id, event_type, amount, reason, actor',
  owner(`SELECT action || '|' || (after_values->>'event_type') || '|' || (after_values->>'amount') || '|' || reason || '|' || performed_by
         FROM audit_events WHERE entity_type = 'sales_session_cash_event' AND entity_id = '${dTr.event_id}';`) === `CREATE|TRANSFER_OUT|2000|depósito|${ADMIN_UID}`);

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Close session (RPC 33)');

const e0 = openS('2026-05-05', 'Feria vacía');
snap = snapshot();
const e0c = rpc(closeCall(e0.session_id, []));
check('E1 empty aggregate: session CLOSED with aggregated_pedido_id NULL and aggregated_total 0; no Pedido, no ledger',
  e0c.estado === 'CLOSED' && e0c.aggregated_pedido_id === null && Number(e0c.aggregated_total) === 0 && Object.keys(e0c).length === 4
  && sessionRow(e0.session_id) === `2026-05-05|Feria vacía|CLOSED|-|${ADMIN_UID}|${ADMIN_UID}|true` && pedidosOf(e0.session_id) === '0');
const E = openS('2026-05-06', 'Feria agregada').session_id;
const ledgerBefore = owner(`SELECT count(*) FROM client_ledger;`);
const opsE0 = owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_posting) FROM financial_operation;`);
const ec = rpc(closeCall(E, [L(XL, 10, 100), L(XL, 5, 120), L(N1, 3, 50)], 'cierre feria'));
const AP = ec.aggregated_pedido_id;
check('E2 exactly ONE aggregated Pedido: CONSUMIDOR FINAL, is_aggregated_retail, linked to the session, DELIVERED',
  !!AP && owner(`SELECT cliente_id || '|' || is_aggregated_retail || '|' || sales_session_id || '|' || estado FROM pedidos WHERE id = '${AP}';`) === `${CF}|true|${E}|DELIVERED`
  && pedidosOf(E) === '1');
check('E3 the same product at different prices stays itemised: XL 10 @ 100 and XL 5 @ 120 are two lines; price and name snapshots kept',
  owner(`SELECT string_agg(producto_nombre || ':' || cantidad || '@' || precio_unitario || '=' || subtotal, ',' ORDER BY producto_nombre, precio_unitario)
         FROM pedido_lineas WHERE pedido_id = '${AP}' AND is_current;`)
  === `${TAG} Huevo N1:3.0000@50.00=150.00,${TAG} Huevo XL:10.0000@100.00=1000.00,${TAG} Huevo XL:5.0000@120.00=600.00`);
check('E4 aggregated_total = SUM(current pedido_lineas.subtotal) = 1750',
  Number(ec.aggregated_total) === 1750 && owner(`SELECT SUM(subtotal) FROM pedido_lineas WHERE pedido_id = '${AP}' AND is_current;`) === '1750.00');
check('E5 normal delivery path: delivered_at = session_date 23:59 America/Argentina/Buenos_Aires, delivered_date = session_date, '
  + 'one SALE_DELIVERY +1750 on CONSUMIDOR FINAL, deliver_order audit',
  owner(`SELECT (delivered_at = ('2026-05-06 23:59'::TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')) || '|' || delivered_date FROM pedidos WHERE id = '${AP}';`) === 'true|2026-05-06'
  && owner(`SELECT movement_type || '|' || signed_amount || '|' || effective_date || '|' || ledger_client_name FROM client_ledger WHERE source_entity_type = 'pedido' AND source_entity_id = '${AP}';`)
  === 'SALE_DELIVERY|1750.00|2026-05-06|CONSUMIDOR FINAL'
  && owner(`SELECT action || '|' || reason FROM audit_events WHERE entity_type = 'pedido' AND entity_id = '${AP}';`) === 'DELIVER|Feria aggregated retail sale'
  && Number(owner(`SELECT count(*) FROM client_ledger;`)) === Number(ledgerBefore) + 1);
check('E6 closing moves no money: the retail sale is a credit to CONSUMIDOR FINAL; no operation, posting or collection is invented',
  owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_posting) FROM financial_operation;`) === opsE0);
check('E7 session CLOSED with closed_at, closed_by and aggregated_pedido_id; audit CLOSE before OPEN / after CLOSED + aggregate',
  sessionRow(E) === `2026-05-06|Feria agregada|CLOSED|${AP}|${ADMIN_UID}|${ADMIN_UID}|true`
  && owner(`SELECT (before_values->>'estado') || '|' || (after_values->>'estado') || '|' || (after_values->>'aggregated_pedido_id') || '|' || reason
         FROM audit_events WHERE entity_type = 'sales_session' AND entity_id = '${E}' AND action = 'CLOSE';`) === `OPEN|CLOSED|${AP}|cierre feria`);
snap = snapshot();
r = ADMIN(`SELECT ${closeCall(E, [L(XL, 1, 1)])};`);
check('E8 closing twice → SESSION_ALREADY_CLOSED; never a second aggregated Pedido', raised(r, 'SESSION_ALREADY_CLOSED') && snapshot() === snap && pedidosOf(E) === '1', firstErr(r));
const rm = ADMIN(`SELECT ${moveCall(E, 'DISPATCH', MAPLE, 1)};`);   // [ADR-009] RPC 31 is ADMIN-only
const rc = ADMIN(`SELECT ${cashCall(E, 'COUNT', 1, CAJA)};`);
check('E9 a CLOSED session rejects movements and cash events → SESSION_CLOSED', raised(rm, 'SESSION_CLOSED') && raised(rc, 'SESSION_CLOSED') && snapshot() === snap);
const EV = openS('2026-05-07', 'Feria validación').session_id;
snap = snapshot();
for (const [what, fn, call, code] of [
  ['OPERATOR closing', A, closeCall(EV, []), 'FORBIDDEN'],
  ['NULL aggregated lines', ADMIN, closeCall(EV, null), 'INVALID_AGGREGATED_LINES'],
  ['non-array aggregated lines', ADMIN, closeCall(EV, { producto_id: XL, cantidad: 1, precio_unitario: 1 }), 'INVALID_AGGREGATED_LINES'],
  ['line quantity 0', ADMIN, closeCall(EV, [L(XL, 0, 100)]), 'INVALID_QUANTITY'],
  ['line negative price', ADMIN, closeCall(EV, [L(XL, 1, -1)]), 'INVALID_PRICE'],
  ['line with a missing product (later line)', ADMIN, closeCall(EV, [L(XL, 1, 100), L(MISSING_UUID, 1, 100)]), 'PRODUCT_NOT_FOUND'],
  ['missing session', ADMIN, closeCall(MISSING_UUID, []), 'SESSION_NOT_FOUND'],
]) {
  r = fn(`SELECT ${call};`);
  check(`E10 ${what} → ${code}`, raised(r, code), firstErr(r));
}
owner(`UPDATE clients SET activo = false WHERE nombre = 'CONSUMIDOR FINAL';`);
r = ADMIN(`SELECT ${closeCall(EV, [L(XL, 1, 100)])};`);
check('E11 CONSUMIDOR FINAL inactive and aggregated lines present → CONSUMIDOR_FINAL_MISSING (never created dynamically)',
  raised(r, 'CONSUMIDOR_FINAL_MISSING') && owner(`SELECT count(*) FROM clients WHERE nombre = 'CONSUMIDOR FINAL';`) === '1', firstErr(r));
check('E12 every rejection was atomic: session still OPEN, no Pedido, no line, no ledger, no audit', snapshot() === snap
  && sessionRow(EV).includes('|OPEN|-|') && pedidosOf(EV) === '0');
const evc = rpc(closeCall(EV, []));
owner(`UPDATE clients SET activo = true WHERE nombre = 'CONSUMIDOR FINAL';`);
check('E13 with an empty aggregate the session closes even without an active CONSUMIDOR FINAL (the master is not needed)', evc.estado === 'CLOSED' && evc.aggregated_pedido_id === null);

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Identified clients keep their own Pedidos');

const F = openS('2026-05-08', 'Feria mayorista').session_id;
const IP = okAs(ADMIN, `INSERT INTO pedidos (cliente_id, sales_session_id, created_by) VALUES ('${MAYORISTA}', '${F}', '${ADMIN_UID}') RETURNING id;`);
okAs(ADMIN, `INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, created_by)
  VALUES ('${IP}', '${MAPLE}', 20, 900, '${TAG} Maple', '${ADMIN_UID}');`);
const ipd = rpc(`deliver_order('${IP}', '2026-05-08 12:00-03', 'venta mayorista en feria')`);
check('F1 the identified client uses the existing Commercial path: own Pedido linked to the session, delivered by deliver_order, own ledger (+18000)',
  ipd.estado === 'DELIVERED' && Number(ipd.order_total) === 18000
  && owner(`SELECT signed_amount FROM client_ledger WHERE source_entity_type = 'pedido' AND source_entity_id = '${IP}' AND cliente_id = '${MAYORISTA}';`) === '18000.00');
const fc = rpc(closeCall(F, [L(MAPLE, 30, 1000)]));
check('F2 closing the session creates a SEPARATE CONSUMIDOR FINAL aggregate (30000); the identified Pedido is not folded in',
  fc.aggregated_pedido_id !== IP && Number(fc.aggregated_total) === 30000
  && owner(`SELECT cliente_id || '|' || is_aggregated_retail || '|' || sales_session_id || '|' || estado FROM pedidos WHERE id = '${IP}';`) === `${MAYORISTA}|false|${F}|DELIVERED`
  && owner(`SELECT count(*) FROM pedido_lineas WHERE pedido_id = '${fc.aggregated_pedido_id}';`) === '1');
check('F3 the session holds exactly one identified Pedido and one aggregate; no anonymous individual Pedido',
  owner(`SELECT string_agg(is_aggregated_retail::TEXT, ',' ORDER BY is_aggregated_retail) FROM pedidos WHERE sales_session_id = '${F}';`) === 'false,true');
r = ADMIN(`INSERT INTO pedidos (cliente_id, sales_session_id) VALUES ('${MAYORISTA}', '${MISSING_UUID}');`);
check('F4 a Pedido cannot reference a nonexistent session (fk_pedidos_sales_session)', violates(r, 'fk_pedidos_sales_session'), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'RLS / privileges');

const GO = openS('2026-05-09', 'Feria abierta').session_id;
rpc(moveCall(GO, 'DISPATCH', MAPLE, 5));
rpc(cashCall(GO, 'COUNT', 50, CAJA));
const GC = openS('2026-05-09', 'Feria cerrada').session_id;
rpc(moveCall(GC, 'DISPATCH', MAPLE, 6));
rpc(closeCall(GC, []));
check('G1 OPERATOR sees OPEN sessions only (not the CLOSED one); ADMIN sees both',
  visible(A, 'sales_session', `id = '${GO}'`) === '1' && visible(A, 'sales_session', `id = '${E}'`) === '0'
  && visible(B, 'sales_session', `id = '${GO}'`) === '1' && visible(ADMIN, 'sales_session', `id IN ('${GO}','${E}')`) === '2');
check('G2 OPERATOR sees movements of OPEN sessions only; ADMIN sees all',
  visible(A, 'sales_session_movement', `sales_session_id = '${GO}'`) === '1' && visible(A, 'sales_session_movement', `sales_session_id = '${GC}'`) === '0'
  && visible(ADMIN, 'sales_session_movement', `sales_session_id IN ('${GO}','${GC}')`) === '2');
check('G3 cash events: ADMIN only; OPERATOR sees none, even of an OPEN session',
  visible(A, 'sales_session_cash_event', 'true') === '0' && visible(B, 'sales_session_cash_event', 'true') === '0'
  && visible(ADMIN, 'sales_session_cash_event', `sales_session_id = '${GO}'`) === '1');
snap = snapshot();
const direct = [
  A(`INSERT INTO sales_session (session_date, location, idempotency_key) VALUES ('2026-05-09', 'x', '${newKey()}');`),
  A(`INSERT INTO sales_session_movement (sales_session_id, movement_type, producto_id, cantidad) VALUES ('${GO}', 'DISPATCH', '${MAPLE}', 1);`),
  A(`UPDATE sales_session SET estado = 'CLOSED' WHERE id = '${GO}';`),
  A(`DELETE FROM sales_session_movement;`),
  ADMIN(`INSERT INTO sales_session (session_date, location, idempotency_key) VALUES ('2026-05-09', 'x', '${newKey()}');`),
  ADMIN(`UPDATE sales_session SET estado = 'OPEN' WHERE id = '${E}';`),
  ADMIN(`INSERT INTO sales_session_cash_event (sales_session_id, event_type, amount, event_date) VALUES ('${GO}', 'COUNT', 1, '2026-05-09');`),
  ADMIN(`UPDATE sales_session_cash_event SET amount = 1;`),
  ADMIN(`DELETE FROM sales_session_cash_event;`),
  ADMIN(`TRUNCATE sales_session, sales_session_movement, sales_session_cash_event CASCADE;`),
];
check('G4 no direct INSERT / UPDATE / DELETE / TRUNCATE for OPERATOR or ADMIN (RPCs 30–33 only)',
  direct.every(denied) && snapshot() === snap, direct.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
const acl = owner(`SELECT string_agg(relname || '=' || relacl::TEXT, ' ' ORDER BY relname) FROM pg_class WHERE relname IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('G5 exact ACLs: authenticated SELECT only',
  acl === TABLES.map((t) => `${t}={postgres=arwdDxtm/postgres,authenticated=r/postgres}`).join(' '), acl);
const pols = owner(`SELECT string_agg(tablename || ':' || policyname || ':' || cmd, ',' ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('G6 policies exactly as frozen RLS §8 Feria',
  pols === 'sales_session:sales_session_admin_select:SELECT,sales_session:sales_session_operator_select:SELECT,'
  + 'sales_session_cash_event:sales_session_cash_event_admin_select:SELECT,'
  + 'sales_session_movement:sales_session_movement_admin_select:SELECT,sales_session_movement:sales_session_movement_operator_select:SELECT', pols);
check('G7 sequences grant nothing to application roles',
  owner(`SELECT count(*) FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a
         WHERE c.relname IN ('sales_session_movement_id_seq','sales_session_cash_event_id_seq') AND a.grantee <> c.relowner;`) === '0');
const anonSr = [
  ...TABLES.map((t) => asAnon(`SELECT 1 FROM ${t};`)), ...TABLES.map((t) => asServiceRole(`SELECT 1 FROM ${t};`)),
  asAnon(`SELECT ${openCall('2026-05-09', 'x', newKey())};`), asServiceRole(`SELECT ${openCall('2026-05-09', 'x', newKey())};`),
  asAnon(`SELECT ${moveCall(GO, 'DISPATCH', MAPLE, 1)};`), asServiceRole(`SELECT ${cashCall(GO, 'COUNT', 1, CAJA)};`),
  asServiceRole(`SELECT ${closeCall(GO, [])};`),
];
check('G8 anon and service_role: no SELECT and no EXECUTE on RPCs 30–33', anonSr.every(denied), anonSr.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
check('G9 [ADR-009] OPERATOR has no Feria movement of its own, so it reads no Feria audit (movement, session or cash)',
  okAs(A, `SELECT count(*) FROM audit_events WHERE entity_type = 'sales_session_movement';`) === '0'
  && okAs(A, `SELECT count(*) FROM audit_events WHERE entity_type IN ('sales_session','sales_session_cash_event');`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('H', 'Periods (determinant = session_date; created_at / opened_at / closed_at never decide)');

closePeriod('2026-03-01');
snap = snapshot();
r = ADMIN(`SELECT ${openCall('2026-03-14', 'x', newKey())};`);
check('H1 RPC 30 in a CLOSED month → PERIOD_CLOSED', raised(r, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
openPeriod('2026-03-01');
const HS = openS('2026-03-14', 'Feria marzo', 100, CAJA).session_id;
closePeriod('2026-03-01');
snap = snapshot();
r = A(`SELECT ${moveCall(HS, 'DISPATCH', MAPLE, 1)};`);
check('H2 [ADR-009] RPC 31 (OPERATOR) is refused by the role guard before any period check → FORBIDDEN', raised(r, 'FORBIDDEN'), firstErr(r));
for (const [what, fn, call] of [
  ['RPC 31 (ADMIN)', ADMIN, moveCall(HS, 'DISPATCH', MAPLE, 1)],
  ['RPC 32', ADMIN, cashCall(HS, 'EXPENSE', 1, CAJA, CAT)],
  ['RPC 33', ADMIN, closeCall(HS, [L(XL, 1, 100)])],
]) {
  r = fn(`SELECT ${call};`);
  check(`H2 session opened while March was OPEN, March now CLOSED → PERIOD_CLOSED: ${what}`, raised(r, 'PERIOD_CLOSED'), firstErr(r));
}
check('H3 CLOSED-period rejections wrote nothing; the session is still OPEN', snapshot() === snap && sessionRow(HS).includes('|OPEN|'));
openPeriod('2026-03-01');
r = ADMIN(`SELECT ${openCall('2027-02-10', 'x', newKey())};`);
check('H4 RPC 30 on a date without management_period → PERIOD_NOT_FOUND', raised(r, 'PERIOD_NOT_FOUND'), firstErr(r));
closePeriod(CURRENT_MONTH);
const HM = openS('2026-05-11', 'Feria mayo', 200, CAJA).session_id;
rpc(moveCall(HM, 'DISPATCH', MAPLE, 3));
rpc(cashCall(HM, 'EXPENSE', 10, CAJA, CAT));
const hmc = rpc(closeCall(HM, [L(MAPLE, 1, 1000)]));
check(`H5 created_at / opened_at / closed_at irrelevant: current month ${CURRENT_MONTH} CLOSED, session dated OPEN May → open, move, cash, close all accepted; delivered_date = 2026-05-11`,
  hmc.estado === 'CLOSED' && owner(`SELECT delivered_date FROM pedidos WHERE id = '${hmc.aggregated_pedido_id}';`) === '2026-05-11');
openPeriod(CURRENT_MONTH);

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'Atomicity (injected failures)');

owner(`
CREATE SCHEMA p21_harness;
CREATE FUNCTION p21_harness.session_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.location = 'I-S1' THEN RAISE EXCEPTION 'HARNESS_FAIL_AFTER_SESSION'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p21_harness.session_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.estado = 'CLOSED' AND NEW.location = 'I-L3' THEN RAISE EXCEPTION 'HARNESS_FAIL_CLOSE_UPDATE'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p21_harness.op_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_entity_type = 'sales_session' AND EXISTS (SELECT 1 FROM public.sales_session s WHERE s.id::TEXT = NEW.source_entity_id AND s.location = 'I-S2') THEN
    RAISE EXCEPTION 'HARNESS_FAIL_OPERATION';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p21_harness.posting_ins() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_reason TEXT;
BEGIN
  SELECT reason INTO v_reason FROM public.financial_operation WHERE id = NEW.financial_operation_id;
  IF v_reason = 'I-C1' AND NEW.signed_amount < 0 THEN RAISE EXCEPTION 'HARNESS_FAIL_FIRST_POSTING'; END IF;
  IF v_reason = 'I-C2' AND NEW.signed_amount > 0 THEN RAISE EXCEPTION 'HARNESS_FAIL_SECOND_POSTING'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p21_harness.cash_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reason = 'I-C3' OR EXISTS (SELECT 1 FROM public.sales_session s WHERE s.id = NEW.sales_session_id AND s.location = 'I-S3') THEN
    RAISE EXCEPTION 'HARNESS_FAIL_CASH_EVENT';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p21_harness.move_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.reason = 'I-M1' THEN RAISE EXCEPTION 'HARNESS_FAIL_MOVEMENT'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p21_harness.line_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pedidos p JOIN public.sales_session s ON s.id = p.sales_session_id
              WHERE p.id = NEW.pedido_id AND ((s.location = 'I-L0') OR (s.location = 'I-L1' AND NEW.precio_unitario = 120))) THEN
    RAISE EXCEPTION 'HARNESS_FAIL_LINE';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p21_harness.ledger_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_entity_type = 'pedido' AND EXISTS (SELECT 1 FROM public.pedidos p JOIN public.sales_session s ON s.id = p.sales_session_id
              WHERE p.id::TEXT = NEW.source_entity_id AND s.location = 'I-L2') THEN
    RAISE EXCEPTION 'HARNESS_FAIL_DELIVER';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p21_harness.audit_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.entity_type = 'sales_session' AND NEW.action = 'OPEN' AND NEW.after_values->>'location' = 'I-S4')
     OR (NEW.entity_type IN ('sales_session_movement','sales_session_cash_event','sales_session') AND NEW.reason IN ('I-M2','I-C4','I-L4')) THEN
    RAISE EXCEPTION 'HARNESS_FAIL_AUDIT';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p21_session_ins AFTER INSERT ON public.sales_session FOR EACH ROW EXECUTE FUNCTION p21_harness.session_ins();
CREATE TRIGGER p21_session_upd BEFORE UPDATE ON public.sales_session FOR EACH ROW EXECUTE FUNCTION p21_harness.session_upd();
CREATE TRIGGER p21_op_ins BEFORE INSERT ON public.financial_operation FOR EACH ROW EXECUTE FUNCTION p21_harness.op_ins();
CREATE TRIGGER p21_posting_ins BEFORE INSERT ON public.financial_posting FOR EACH ROW EXECUTE FUNCTION p21_harness.posting_ins();
CREATE TRIGGER p21_cash_ins BEFORE INSERT ON public.sales_session_cash_event FOR EACH ROW EXECUTE FUNCTION p21_harness.cash_ins();
CREATE TRIGGER p21_move_ins BEFORE INSERT ON public.sales_session_movement FOR EACH ROW EXECUTE FUNCTION p21_harness.move_ins();
CREATE TRIGGER p21_line_ins BEFORE INSERT ON public.pedido_lineas FOR EACH ROW EXECUTE FUNCTION p21_harness.line_ins();
CREATE TRIGGER p21_ledger_ins BEFORE INSERT ON public.client_ledger FOR EACH ROW EXECUTE FUNCTION p21_harness.ledger_ins();
CREATE TRIGGER p21_audit_ins BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION p21_harness.audit_ins();`);
try {
  snap = snapshot();
  for (const [what, loc, code] of [
    ['after the session insert', 'I-S1', 'HARNESS_FAIL_AFTER_SESSION'],
    ['at the opening-fund financial operation', 'I-S2', 'HARNESS_FAIL_OPERATION'],
    ['at the OPENING_FUND cash event', 'I-S3', 'HARNESS_FAIL_CASH_EVENT'],
    ['at the audit', 'I-S4', 'HARNESS_FAIL_AUDIT'],
  ]) {
    r = ADMIN(`SELECT ${openCall('2026-05-12', loc, newKey(), 500, CAJA)};`);
    check(`I1 RPC 30 fails ${what} → nothing written (no session, operation, event or audit)`, raised(r, code) && snapshot() === snap, firstErr(r));
  }
  const IS = openS('2026-05-12', 'Feria atomicidad').session_id;
  snap = snapshot();
  for (const [what, call, code] of [
    ['RPC 31 at the movement insert', moveCall(IS, 'LOSS', MAPLE, 1, 'I-M1'), 'HARNESS_FAIL_MOVEMENT'],
    ['RPC 31 at the audit', moveCall(IS, 'LOSS', MAPLE, 1, 'I-M2'), 'HARNESS_FAIL_AUDIT'],
    ['RPC 32 after the operation, at the first posting', cashCall(IS, 'EXPENSE', 5, CAJA, CAT, null, 'I-C1'), 'HARNESS_FAIL_FIRST_POSTING'],
    ['RPC 32 TRANSFER_OUT after the first leg, at the second posting', cashCall(IS, 'TRANSFER_OUT', 5, CAJA, null, BNA, 'I-C2'), 'HARNESS_FAIL_SECOND_POSTING'],
    ['RPC 32 after both postings, at the cash event', cashCall(IS, 'TRANSFER_OUT', 5, CAJA, null, BNA, 'I-C3'), 'HARNESS_FAIL_CASH_EVENT'],
    ['RPC 32 at the audit', cashCall(IS, 'WITHDRAWAL', 5, CAJA, null, null, 'I-C4'), 'HARNESS_FAIL_AUDIT'],
  ]) {
    r = ADMIN(`SELECT ${call};`);
    check(`I2 ${what} → full rollback`, raised(r, code) && snapshot() === snap, firstErr(r));
  }
  const cfLedger = () => owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${CF}';`);
  const cf0 = cfLedger();
  for (const [what, loc, code, reason] of [
    ['after the aggregated Pedido insert, at the first line', 'I-L0', 'HARNESS_FAIL_LINE', null],
    ['at a later line', 'I-L1', 'HARNESS_FAIL_LINE', null],
    ['inside deliver_order (client ledger)', 'I-L2', 'HARNESS_FAIL_DELIVER', null],
    ['after delivery, at the session CLOSE update', 'I-L3', 'HARNESS_FAIL_CLOSE_UPDATE', null],
    ['at the CLOSE audit', 'I-L5', 'HARNESS_FAIL_AUDIT', 'I-L4'],
  ]) {
    const cs = openS('2026-05-12', loc).session_id;
    snap = snapshot();
    r = ADMIN(`SELECT ${closeCall(cs, [L(XL, 10, 100), L(XL, 5, 120)], reason)};`);
    check(`I3 RPC 33 fails ${what} → no half Pedido, no delivered orphan, no ledger; session still OPEN without aggregate`,
      raised(r, code) && snapshot() === snap && pedidosOf(cs) === '0' && cfLedger() === cf0 && sessionRow(cs).includes('|OPEN|-|'), firstErr(r));
  }
} finally {
  owner(`DROP SCHEMA IF EXISTS p21_harness CASCADE;`);
}
check('I4 harness triggers removed', owner(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p21_%';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('J', 'Concurrency (independent PostgreSQL sessions)');

const raceKey = newKey();
x = await race(ADMIN_UID, `SELECT ${openCall('2026-06-01', 'Race', raceKey)};`, ADMIN_UID, `SELECT ${openCall('2026-06-01', 'Race 2', raceKey)};`, 'p21-open');
check('J1 same idempotency_key: B waited, then DUPLICATE_SESSION; exactly one session (A\'s)',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_SESSION')
  && owner(`SELECT count(*) || '|' || max(location) FROM sales_session WHERE idempotency_key = '${raceKey}';`) === '1|Race', firstErr(x.rb));
let JS = openS('2026-06-02', 'Race close/move').session_id;
x = await race(ADMIN_UID, `SELECT ${closeCall(JS, [])};`, ADMIN_UID, `SELECT ${moveCall(JS, 'DISPATCH', MAPLE, 7)};`, 'p21-cm');   // [ADR-009] both ADMIN
check('J2 close first, movement concurrently: the movement waited on the session lock, then SESSION_CLOSED; no movement in the closed session',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'SESSION_CLOSED')
  && owner(`SELECT count(*) FROM sales_session_movement WHERE sales_session_id = '${JS}';`) === '0', firstErr(x.rb));
JS = openS('2026-06-03', 'Race move/close').session_id;
x = await race(ADMIN_UID, `SELECT ${moveCall(JS, 'DISPATCH', MAPLE, 8)};`, ADMIN_UID, `SELECT ${closeCall(JS, [L(MAPLE, 2, 1000)])};`, 'p21-mc');
check('J3 movement first, close concurrently: the close waited, then closed; the movement belongs to the session, the aggregate exists once',
  x.aIn && x.bWait && x.ra.ok && x.rb.ok && sessionRow(JS).includes('|CLOSED|')
  && owner(`SELECT count(*) FROM sales_session_movement WHERE sales_session_id = '${JS}';`) === '1' && pedidosOf(JS) === '1', firstErr(x.rb));
JS = openS('2026-06-04', 'Race close/cash').session_id;
const opsJ = owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_posting) FROM financial_operation;`);
x = await race(ADMIN_UID, `SELECT ${closeCall(JS, [])};`, ADMIN_UID, `SELECT ${cashCall(JS, 'EXPENSE', 50, CAJA, CAT)};`, 'p21-cc');
check('J4 close first, cash event concurrently: the cash event waited, then SESSION_CLOSED; no operation or posting created',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'SESSION_CLOSED')
  && owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_posting) FROM financial_operation;`) === opsJ, firstErr(x.rb));
JS = openS('2026-06-05', 'Race close/close').session_id;
x = await race(ADMIN_UID, `SELECT ${closeCall(JS, [L(XL, 4, 100)])};`, ADMIN_UID, `SELECT ${closeCall(JS, [L(XL, 9, 100)])};`, 'p21-cl');
check('J5 close vs close: B waited, then SESSION_ALREADY_CLOSED; exactly one aggregated Pedido (A\'s, total 400)',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'SESSION_ALREADY_CLOSED') && pedidosOf(JS) === '1'
  && owner(`SELECT SUM(l.subtotal) FROM pedido_lineas l JOIN pedidos p ON p.id = l.pedido_id WHERE p.sales_session_id = '${JS}';`) === '400.00', firstErr(x.rb));

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'Reconciliation — variances surface, no correspondence invented');

const K = openS('2026-06-06', 'Feria arqueo', 5000, CAJA).session_id;
rpc(cashCall(K, 'EXPENSE', 300, CAJA, CAT, null, 'hielo'));
rpc(cashCall(K, 'WITHDRAWAL', 1000, CAJA, null, null, 'retiro'));
const kCount = rpc(cashCall(K, 'COUNT', 4100, CAJA, null, null, 'arqueo de cierre'));
const kc = rpc(closeCall(K, [L(XL, 10, 100)]));
snap = snapshot();
// read-only reconciliation view of the facts (nothing stored)
const expected = owner(`SELECT coalesce(SUM(CASE WHEN event_type = 'OPENING_FUND' THEN amount WHEN event_type IN ('EXPENSE','WITHDRAWAL','TRANSFER_OUT') THEN -amount END), 0)
  FROM sales_session_cash_event WHERE sales_session_id = '${K}';`);
const counted = owner(`SELECT amount FROM sales_session_cash_event WHERE sales_session_id = '${K}' AND event_type = 'COUNT';`);
check('K1 the COUNT persists as an observation (4100, no operation)', counted === '4100.00'
  && owner(`SELECT coalesce(financial_operation_id::TEXT, 'null') FROM sales_session_cash_event WHERE id = ${kCount.event_id};`) === 'null');
check('K2 posting-based expectation derived from the session facts = 5000 − 300 − 1000 = 3700; the variance (+400) is visible, not forced to 0',
  expected === '3700.00' && Number(counted) - Number(expected) === 400);
check('K3 nothing auto-corrects: no ADJUSTMENT operation, no posting and no collection created for the variance or for the retail sale',
  owner(`SELECT count(*) FROM financial_operation WHERE source_entity_type = 'sales_session' AND source_entity_id = '${K}';`) === '3'
  && owner(`SELECT count(*) FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id
           WHERE o.source_entity_type = 'sales_session' AND o.source_entity_id = '${K}';`) === '2'
  && owner(`SELECT count(*) FROM collections WHERE sales_session_id = '${K}';`) === '0');
check('K4 the retail sale stays an open CONSUMIDOR FINAL debit (+1000): no invented match between the count and the aggregate',
  owner(`SELECT signed_amount FROM client_ledger WHERE source_entity_type = 'pedido' AND source_entity_id = '${kc.aggregated_pedido_id}';`) === '1000.00');
// the only reconciliation objects allowed are the frozen Domain L MP tables (Phase 23); no cash variance / arqueo object exists
check('K5 no stored variance / cash-reconciliation object exists (only the frozen MP pipeline tables, built in Phase 23)',
  owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(reconcil|variance|arqueo|mp_)'
    AND table_name NOT IN ('mp_source_record', 'mp_financial_movement', 'mp_reconciliation',
      'mp_attribution_flag', 'mp_client_allocation', 'mp_payer_client_map', 'mp_report_match', 'mp_transition_identity', 'mp_webhook_delivery', ${ADR005_VIEWS},
      'report_mp_receipt_status', 'report_mp_delivery_health', 'report_mp_report_exceptions');`) === '0'   // + ADR-006 derived views (0055), proven by mp_views.test.mjs
  && snapshot() === snap);

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'Structural invariants (invariant 28)');

check('L1 no individual anonymous sale table exists', owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
  AND table_name ~* '(venta|sale_|retail|ticket|anonymous)' AND table_name NOT LIKE 'sales_session%';`) === '0');
check('L2 frozen invariant query 28: no session has more than one aggregated Pedido',
  owner(`SELECT count(*) FROM (SELECT sales_session_id FROM pedidos WHERE is_aggregated_retail AND sales_session_id IS NOT NULL
         GROUP BY sales_session_id HAVING count(*) > 1) s;`) === '0');
r = ADMIN(`INSERT INTO pedidos (cliente_id, is_aggregated_retail) VALUES ('${CF}', true);`);
check('L3 an aggregated retail Pedido outside a session is impossible, even through the ADMIN PENDING-order path (chk_pedidos_aggregated_has_session)',
  violates(r, 'chk_pedidos_aggregated_has_session'), firstErr(r));
r = ADMIN(`INSERT INTO pedidos (cliente_id, is_aggregated_retail, sales_session_id) VALUES ('${CF}', true, '${E}');`);
check('L4 a second aggregated Pedido for a session is impossible (idx_pedidos_one_aggregate_per_session)', violates(r, 'idx_pedidos_one_aggregate_per_session'), firstErr(r));
check('L5 every aggregated Pedido of the suite belongs to CONSUMIDOR FINAL and is named back by its session',
  owner(`SELECT count(*) FROM pedidos p JOIN sales_session s ON s.id = p.sales_session_id WHERE p.is_aggregated_retail AND s.idempotency_key LIKE '${KEY_PREFIX}%'
         AND (p.cliente_id <> '${CF}' OR s.aggregated_pedido_id IS DISTINCT FROM p.id);`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('M', 'SECURITY DEFINER');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
check('M1 SECURITY DEFINER inventory = previous 31 + RPCs 30–33 = 35', definers === ALL_DEFINERS, definers);
const hard = owner(`SELECT string_agg(proname || '=' || prosecdef || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || ':' || pg_get_userbyid(proowner) || ':'
  || (proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)) || ':' || has_function_privilege('anon', oid, 'EXECUTE')
  || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
  FROM pg_proc WHERE proname IN (${FERIA_RPCS.map((p) => `'${p}'`).join(',')});`);
check('M2 each: DEFINER, search_path=public, owner postgres, no PUBLIC, anon no, authenticated yes, service_role no',
  hard === FERIA_RPCS.map((p) => `${p}=true:true:postgres:true:false:true:false`).join(','), hard);
const sigs = owner(`SELECT string_agg(proname || '(' || pg_get_function_identity_arguments(oid) || ')', ' ; ' ORDER BY proname) FROM pg_proc WHERE proname IN (${FERIA_RPCS.map((p) => `'${p}'`).join(',')});`);
const argNames = owner(`SELECT string_agg(array_to_string(proargnames, ','), ',') FROM pg_proc WHERE proname IN (${FERIA_RPCS.map((p) => `'${p}'`).join(',')});`);
check('M3 exact frozen signatures; no actor / role / user parameter',
  sigs === 'close_sales_session(p_session_id uuid, p_aggregated_lines jsonb, p_reason text) ; '
  + 'open_sales_session(p_session_date date, p_location character varying, p_idempotency_key character varying, p_opening_fund numeric, p_cash_account_id uuid) ; '
  + 'register_session_cash_event(p_session_id uuid, p_event_type session_cash_event_type, p_amount numeric, p_financial_account_id uuid, p_expense_category_id uuid, p_destination_account_id uuid, p_reason text) ; '
  + 'register_session_movement(p_session_id uuid, p_movement_type session_movement_type, p_producto_id uuid, p_cantidad numeric, p_reason text)'
  && !/(user|actor|role|performed|created_by|uid)/i.test(argNames), sigs);
check('M4 deliver_order (RPC 1) is reused unchanged: same signature, still the only path that delivers the aggregate',
  owner(`SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'deliver_order';`) === 'p_order_id uuid, p_delivered_at timestamp with time zone, p_reason text');

// ═══════════════════════════════════════════════════════════════════════════
section('O', 'Feria end to end');

const e2eKey = newKey();
const O = rpc(openCall('2026-05-23', 'Feria Plaza Central', e2eKey, 3000, CAJA)).session_id;
const cajaO = balance(CAJA);
rpc(moveCall(O, 'DISPATCH', MAPLE, 100));
rpc(moveCall(O, 'RETURN', MAPLE, 10));
rpc(moveCall(O, 'LOSS', MAPLE, 2, 'rotos en traslado'));
rpc(moveCall(O, 'ADJUSTMENT', MAPLE, 1, 'recuento'));
rpc(cashCall(O, 'EXPENSE', 200, CAJA, CAT, null, 'bolsas'));
const OIP = okAs(ADMIN, `INSERT INTO pedidos (cliente_id, sales_session_id, created_by) VALUES ('${MAYORISTA}', '${O}', '${ADMIN_UID}') RETURNING id;`);
okAs(ADMIN, `INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, created_by)
  VALUES ('${OIP}', '${MAPLE}', 20, 900, '${TAG} Maple', '${ADMIN_UID}');`);
rpc(`deliver_order('${OIP}', '2026-05-23 11:00-03', 'mayorista en feria')`);
rpc(cashCall(O, 'COUNT', 5000, CAJA, null, null, 'arqueo'));
check('O1 during the session operator A sees the session and its 4 physical movements, but no cash event',
  visible(A, 'sales_session', `id = '${O}'`) === '1' && visible(A, 'sales_session_movement', `sales_session_id = '${O}'`) === '4'
  && visible(A, 'sales_session_cash_event', `sales_session_id = '${O}'`) === '0');
const oc = rpc(closeCall(O, [L(MAPLE, 50, 1000), L(MAPLE, 17, 950)], 'cierre jornada'));
check('O2 close: one CONSUMIDOR FINAL aggregate with two Maple lines at different prices, total 50·1000 + 17·950 = 66150, delivered on 2026-05-23',
  Number(oc.aggregated_total) === 66150 && owner(`SELECT count(*) || '|' || estado || '|' || delivered_date FROM pedido_lineas l JOIN pedidos p ON p.id = l.pedido_id
    WHERE p.id = '${oc.aggregated_pedido_id}' GROUP BY estado, delivered_date;`) === '2|DELIVERED|2026-05-23');
check('O3 the identified client keeps its own delivered Pedido (18000) in the same session; the session has exactly 2 Pedidos, no anonymous individual one',
  owner(`SELECT string_agg(c.nombre || ':' || p.is_aggregated_retail, ',' ORDER BY p.is_aggregated_retail) FROM pedidos p JOIN clients c ON c.id = p.cliente_id WHERE p.sales_session_id = '${O}';`)
  === `${TAG} Mayorista:false,CONSUMIDOR FINAL:true`);
check('O4 physical facts stay physical and are NOT turned into sales: DISPATCH 100 / RETURN 10 / LOSS 2 / ADJUSTMENT 1 unchanged; '
  + 'no "sold = dispatch − return − loss ± adj" is inferred (89 dispatched net vs 67 aggregate + 20 identified are not forced to match)',
  owner(`SELECT string_agg(movement_type::TEXT || ':' || cantidad, ',' ORDER BY id) FROM sales_session_movement WHERE sales_session_id = '${O}';`)
  === 'DISPATCH:100.0000,RETURN:10.0000,LOSS:2.0000,ADJUSTMENT:1.0000'
  && owner(`SELECT SUM(cantidad) FROM pedido_lineas WHERE pedido_id = '${oc.aggregated_pedido_id}';`) === '67.0000');
check('O5 cash: only the EXPENSE moved money (Caja −200); the opening fund and the COUNT did not; COUNT 5000 vs expectation 2800 stays a visible variance',
  Number(balance(CAJA)) === Number(cajaO) - 200
  && owner(`SELECT coalesce(SUM(CASE WHEN event_type = 'OPENING_FUND' THEN amount WHEN event_type IN ('EXPENSE','WITHDRAWAL','TRANSFER_OUT') THEN -amount END), 0)
            FROM sales_session_cash_event WHERE sales_session_id = '${O}';`) === '2800.00');
check('O6 after close operator A no longer sees the session or its movements; ADMIN keeps full visibility',
  visible(A, 'sales_session', `id = '${O}'`) === '0' && visible(A, 'sales_session_movement', `sales_session_id = '${O}'`) === '0'
  && visible(ADMIN, 'sales_session', `id = '${O}'`) === '1' && visible(ADMIN, 'sales_session_cash_event', `sales_session_id = '${O}'`) === '3');
check('O7 audit trail of the day: OPEN, 4 movements, 3 cash events (fund has none of its own: it is in the OPEN audit), CLOSE, 2 DELIVER',
  owner(`SELECT count(*) FROM audit_events WHERE (entity_type = 'sales_session' AND entity_id = '${O}')
         OR (entity_type = 'sales_session_movement' AND entity_id IN (SELECT id::TEXT FROM sales_session_movement WHERE sales_session_id = '${O}'))
         OR (entity_type = 'sales_session_cash_event' AND entity_id IN (SELECT id::TEXT FROM sales_session_cash_event WHERE sales_session_id = '${O}'))
         OR (entity_type = 'pedido' AND entity_id IN (SELECT id::TEXT FROM pedidos WHERE sales_session_id = '${O}'));`) === String(1 + 4 + 2 + 1 + 2));

// ═══════════════════════════════════════════════════════════════════════════
section('N', 'No hidden economic effect (whole suite)');

const econNow = econ().split('|');
const econStart = econAtStart.split('|');
check('N1 no supplier ledger or purchase was touched by any Feria call (Feria economics flow only through Pedidos and SESSION_CASH operations)',
  econNow[3] === econStart[3] && econNow[7] === econStart[7], `${econAtStart} → ${econ()}`);
} finally {
  cleanup();
}

section('Z', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM sales_session WHERE idempotency_key LIKE '${KEY_PREFIX}%') + (SELECT count(*) FROM products WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM clients WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM expense_category WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM perfiles WHERE id = '${OPB}') + (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'p21_harness')
  + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p21_%');`);
check('Z1 all P21-TEST sessions, Pedidos, operations, masters, operator B, harness schema and triggers removed', left === '0', left);
check('Z2 CONSUMIDOR FINAL is active again and periods closed by the suite are OPEN',
  owner(`SELECT activo FROM clients WHERE nombre = 'CONSUMIDOR FINAL';`) === 't'
  && owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`) === '0');

console.log(`\n  ══ FERIA RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
