#!/usr/bin/env node
/**
 * PHASE 17 — PURCHASES / SUPPLIERS (SLICE 2) TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Behavioural tests of RPCs 13–17 (register_purchase, rectify_purchase,
 * pay_supplier, register_freight, assign_freight_to_purchase) over purchases,
 * purchase_line, purchase_attachment, freight, freight_allocation, the reused
 * supplier_ledger and the money ledger (financial_operation / financial_posting).
 *
 * Role-scoped calls simulate real Supabase sessions. Failure injection uses
 * test-only triggers in schema p17_harness (dropped at the end). The
 * concurrency group runs genuinely independent PostgreSQL sessions (separate
 * psql processes) and observes the lock wait in pg_stat_activity.
 *
 * Fixtures are synthetic and prefixed "P17-TEST"; they are removed at start and
 * end, and periods closed by the suite are reopened.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/purchases.test.mjs
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
const OPER_UID = '22222222-2222-2222-2222-222222222222';
const INACTIVE_UID = '33333333-3333-3333-3333-333333333333';
const NOPROFILE_UID = '44444444-4444-4444-4444-444444444444';
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'P17-TEST';
const RPCS = ['assign_freight_to_purchase', 'pay_supplier', 'rectify_purchase', 'register_freight', 'register_purchase'];
const TABLES = ['freight', 'freight_allocation', 'purchase_attachment', 'purchase_line', 'purchases'];
const ALL_DEFINERS = 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,close_feria_summary,close_flock,close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_apply_transition,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_report_fallback,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,open_sales_session,pay_fiscal_obligation,pay_supplier,publish_feed_formula_version,receive_cheque,'
  + 'rectify_classification,rectify_daily_production,rectify_delivered_order,rectify_feed_manufacturing,rectify_feria_closing,rectify_mortality,rectify_purchase,register_bank_tax,register_classification,register_collection,'
  + 'register_count_adjustment,register_daily_production,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,register_fiscal_document,register_fiscal_obligation,register_flock,register_freight,register_management_event,register_mortality,register_purchase,register_purchase_with_fiscal_document,register_session_cash_event,register_session_movement,reject_cheque,'
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
const ADMIN_CLAIMS = { sub: ADMIN_UID, role: 'authenticated' };
const asUser = (uid, sqlText) => asRole('authenticated', { sub: uid, role: 'authenticated' }, sqlText);
const ADMIN = (sqlText) => asUser(ADMIN_UID, sqlText);
const OPER = (sqlText) => asUser(OPER_UID, sqlText);
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
async function race(callA, callB, appPrefix) {
  const pA = session(sessionSql('authenticated', ADMIN_CLAIMS, `SELECT ${callA};\nSELECT pg_sleep(2);`), `${appPrefix}-A`);
  const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-A'
    AND state = 'active' AND query LIKE '%pg_sleep%');`);
  const pB = session(sessionSql('authenticated', ADMIN_CLAIMS, `SELECT ${callB};`), `${appPrefix}-B`);
  const bWait = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-B' AND wait_event_type = 'Lock');`);
  const [ra, rb] = await Promise.all([pA, pB]);
  return { aIn, bWait, ra, rb };
}

function adminOk(sqlText) {
  const r = ADMIN(sqlText);
  if (!r.ok) throw new Error(`ADMIN SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const rpc = (call) => JSON.parse(adminOk(`SELECT ${call};`));
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 160);
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
const TS = `(SELECT id FROM suppliers WHERE nombre LIKE '${TAG}%')`;
const TA = `(SELECT id FROM financial_account WHERE nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
DROP SCHEMA IF EXISTS p17_harness CASCADE;
CREATE TEMP TABLE _p AS SELECT id FROM purchases WHERE supplier_id IN ${TS};
CREATE TEMP TABLE _f AS SELECT id FROM freight WHERE supplier_id IN ${TS} OR idempotency_key LIKE '${TAG}%';
CREATE TEMP TABLE _i AS SELECT id FROM financial_instrument WHERE supplier_id IN ${TS} OR endorsed_to_supplier_id IN ${TS};
CREATE TEMP TABLE _o AS
  SELECT id FROM financial_operation WHERE external_ref LIKE '${TAG}%'
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'suppliers' AND source_entity_id IN (SELECT id::TEXT FROM ${TS} s)
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'financial_instrument' AND source_entity_id IN (SELECT id::TEXT FROM _i)
  UNION SELECT financial_operation_id FROM financial_posting WHERE financial_account_id IN ${TA};
DELETE FROM audit_events WHERE entity_type = 'purchases' AND entity_id IN (SELECT id::TEXT FROM _p);
DELETE FROM audit_events WHERE entity_type = 'freight' AND entity_id IN (SELECT id::TEXT FROM _f);
DELETE FROM audit_events WHERE entity_type = 'freight_allocation' AND entity_id IN
  (SELECT id::TEXT FROM freight_allocation WHERE freight_id IN (SELECT id FROM _f) OR purchase_id IN (SELECT id FROM _p));
DELETE FROM audit_events WHERE entity_type = 'suppliers' AND entity_id IN (SELECT id::TEXT FROM ${TS} s);
DELETE FROM audit_events WHERE entity_type = 'financial_instrument' AND entity_id IN (SELECT id::TEXT FROM _i);
DELETE FROM freight_allocation WHERE freight_id IN (SELECT id FROM _f) OR purchase_id IN (SELECT id FROM _p);
DELETE FROM purchase_attachment WHERE purchase_id IN (SELECT id FROM _p);
DELETE FROM purchase_line WHERE purchase_id IN (SELECT id FROM _p);
UPDATE flocks SET purchase_id = NULL WHERE purchase_id IN (SELECT id FROM _p);
DELETE FROM purchases WHERE id IN (SELECT id FROM _p);
DELETE FROM freight WHERE id IN (SELECT id FROM _f);
DELETE FROM financial_instrument_event WHERE financial_instrument_id IN (SELECT id FROM _i);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _o);
DELETE FROM supplier_ledger WHERE reversal_of_id IS NOT NULL AND supplier_id IN ${TS};
DELETE FROM supplier_ledger WHERE supplier_id IN ${TS};
DELETE FROM financial_instrument WHERE id IN (SELECT id FROM _i);
DELETE FROM flocks WHERE shed_id IN (SELECT id FROM sheds WHERE nombre LIKE '${TAG}%');
DELETE FROM sheds WHERE nombre LIKE '${TAG}%';
DELETE FROM products WHERE nombre LIKE '${TAG}%';
DELETE FROM feed_ingredient WHERE nombre LIKE '${TAG}%';
DELETE FROM projects WHERE nombre LIKE '${TAG}%';
DELETE FROM expense_category WHERE nombre LIKE '${TAG}%';
DELETE FROM suppliers WHERE nombre LIKE '${TAG}%';
DELETE FROM financial_account WHERE nombre LIKE '${TAG}%';
UPDATE management_period SET status = 'OPEN', closed_at = NULL
 WHERE periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
}

owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES
  ('${ADMIN_UID}', false, false), ('${OPER_UID}', false, false),
  ('${INACTIVE_UID}', false, false), ('${NOPROFILE_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true),
  ('${OPER_UID}', 'operator@test.local', 'OPERATOR', true),
  ('${INACTIVE_UID}', 'inactive@test.local', 'OPERATOR', false)
ON CONFLICT (id) DO NOTHING;`);
cleanup();

// ── fixture helpers (allowed ADMIN paths) ──────────────────────────────────
let seq = 0;
const uniq = (p) => `${TAG}-${p}-${++seq}`;
const mkSupplier = (name, activo = true) =>
  adminOk(`INSERT INTO suppliers (nombre, activo) VALUES ('${TAG} ${name}', ${activo}) RETURNING id;`);
const mkAccount = (name, type = 'BANK_ACCOUNT', activo = true) =>
  adminOk(`INSERT INTO financial_account (nombre, account_type, activo) VALUES ('${TAG} ${name}', '${type}', ${activo}) RETURNING id;`);

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${v}'`);
const j = (v) => (v === null || v === undefined ? 'NULL' : `'${JSON.stringify(v)}'::jsonb`);
const num = (v) => (v === null || v === undefined ? 'NULL' : String(v));

let CAT; let CAT2; let PROJ; let PROD; let ING;
const line = (o = {}) => ({ descripcion: 'Maíz', cantidad: 10, unit_type: 'TON', precio_unitario: 9000, ...o });
const att = (name) => ({ storage_path: `purchases/${name}.pdf`, file_name: `${name}.pdf`, content_type: 'application/pdf', byte_size: 12345 });

function purchaseCall(o) {
  const x = {
    date: '2026-04-10', net: 80000, total: 100000, cat: CAT, sub: null, nature: 'OPERATING',
    lines: [line({ feed_ingredient_id: ING })], project: null, fiscal: null, invoice: null, flock: null, reason: 'compra', ...o,
  };
  if (!('atts' in o)) x.atts = [att(x.key)];
  return `register_purchase(${q(x.sup)}, ${q(x.date)}, ${num(x.net)}, ${num(x.total)}, ${q(x.cat)}, ${q(x.sub)}, `
    + `${x.nature === null ? 'NULL' : `'${x.nature}'`}, ${j(x.lines)}, ${j(x.atts)}, ${q(x.key)}, ${q(x.project)}, `
    + `${q(x.fiscal)}, ${q(x.invoice)}, ${q(x.flock)}, ${q(x.reason)})`;
}
const purchase = (o) => rpc(purchaseCall({ key: uniq('K'), ...o }));
const rectifyCall = (id, net, total, lines, reason = 'corrección') =>
  `rectify_purchase(${q(id)}, ${num(net)}, ${num(total)}, ${j(lines)}, ${q(reason)})`;
const payCall = (sup, amount, acct, ref, date = '2026-04-15', method = 'TRANSFER') =>
  `pay_supplier(${q(sup)}, ${num(amount)}, ${q(date)}, '${method}', ${q(acct)}, ${q(ref)}, 'pago')`;
const freightCall = (o) => {
  const x = { date: '2026-04-11', amount: 15000, cat: CAT2, sup: null, doc: null, fiscal: null, reason: 'flete', ...o };
  return `register_freight(${q(x.date)}, ${num(x.amount)}, ${q(x.cat)}, ${q(x.key)}, ${q(x.sup)}, ${q(x.doc)}, ${q(x.fiscal)}, ${q(x.reason)})`;
};
const freight = (o) => rpc(freightCall({ key: uniq('F'), ...o }));
const assignCall = (fr, pu, amount) => `assign_freight_to_purchase(${q(fr)}, ${q(pu)}, ${num(amount)}, 'asignación')`;

const supplierBal = (s) => owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM supplier_ledger WHERE supplier_id = '${s}';`);
const acctBal = (a) => owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM financial_posting WHERE financial_account_id = '${a}';`);
const totalMoney = () => owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM financial_posting;`);
const landed = (p) => owner(`SELECT (p.amount_total + COALESCE((SELECT SUM(allocated_amount) FROM freight_allocation WHERE purchase_id = p.id), 0))::NUMERIC(15,2)
  FROM purchases p WHERE p.id = '${p}';`);
const ledgerOf = (sup) => owner(`SELECT coalesce(string_agg(movement_type || ':' || signed_amount, ',' ORDER BY id), '') FROM supplier_ledger WHERE supplier_id = '${sup}';`);
const snapshot = () => owner(`
SELECT concat_ws('|',
  (SELECT count(*) FROM purchases), (SELECT count(*) FROM purchases WHERE is_current),
  (SELECT string_agg(id::TEXT || is_current, ',' ORDER BY id) FROM purchases),
  (SELECT count(*) FROM purchase_line), (SELECT count(*) FROM purchase_attachment),
  (SELECT count(*) FROM freight), (SELECT count(*) FROM freight_allocation),
  (SELECT string_agg(id::TEXT || ':' || purchase_id, ',' ORDER BY id) FROM freight_allocation),
  (SELECT count(*) FROM supplier_ledger), (SELECT COALESCE(SUM(signed_amount), 0) FROM supplier_ledger),
  (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT count(*) FROM audit_events));`);
const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);

let r;
let snap;
let x;

try {
CAT = adminOk(`INSERT INTO expense_category (nombre, pnl_cost_class) VALUES ('${TAG} Insumos', 'DIRECT') RETURNING id;`);
CAT2 = adminOk(`INSERT INTO expense_category (nombre, pnl_cost_class) VALUES ('${TAG} Fletes', 'INDIRECT') RETURNING id;`);
PROJ = adminOk(`INSERT INTO projects (nombre) VALUES ('${TAG} Galpón nuevo') RETURNING id;`);
PROD = adminOk(`INSERT INTO products (nombre, product_type) VALUES ('${TAG} Maple', 'INPUT') RETURNING id;`);
ING = adminOk(`INSERT INTO feed_ingredient (nombre) VALUES ('${TAG} Maíz') RETURNING id;`);
const BANK = mkAccount('Banco');
const BANK_OFF = mkAccount('Banco inactivo', 'BANK_ACCOUNT', false);

// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure');

const tables = owner(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('A1 purchases, purchase_line, purchase_attachment, freight, freight_allocation exist', tables === TABLES.join(','), tables);
const colsOf = (t) => owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = '${t}';`);
check('A2 purchases columns exactly as frozen', colsOf('purchases') === 'id,supplier_id,economic_date,amount_net,amount_total,expense_category_id,subcategory,'
  + 'nature,project_id,fiscal_document_id,supplier_invoice_number,flock_id,is_current,version_seq,idempotency_key,created_at,created_by', colsOf('purchases'));
check('A3 purchase_line / attachment / freight / allocation columns exactly as frozen',
  colsOf('purchase_line') === 'id,purchase_id,producto_id,feed_ingredient_id,descripcion,cantidad,unit_type,precio_unitario,subtotal,created_at'
  && colsOf('purchase_attachment') === 'id,purchase_id,storage_path,file_name,content_type,byte_size,uploaded_at,uploaded_by'
  && colsOf('freight') === 'id,supplier_id,economic_date,amount,document_ref,fiscal_document_id,expense_category_id,is_current,version_seq,idempotency_key,created_at,created_by'
  && colsOf('freight_allocation') === 'id,freight_id,purchase_id,allocated_amount,allocated_at,allocated_by');
const gen = owner(`SELECT is_generated || ':' || generation_expression FROM information_schema.columns WHERE table_name = 'purchase_line' AND column_name = 'subtotal';`);
check('A4 purchase_line.subtotal GENERATED ALWAYS (cantidad * precio_unitario)', /^ALWAYS:.*cantidad.*precio_unitario/.test(gen), gen);
const checks = owner(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE contype = 'c'
  AND conrelid::regclass::TEXT IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('A5 CHECKs as frozen (the 2 fiscal deferred-FK stand-ins were replaced by the frozen FKs in Phase 22)', checks === ''
  + 'freight_allocation_allocated_amount_check,freight_amount_check,purchase_attachment_byte_size_check,purchase_line_cantidad_check,'
  + 'purchase_line_precio_unitario_check,purchases_amount_net_check,purchases_amount_total_check', checks);
const uniques = owner(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE contype = 'u'
  AND conrelid::regclass::TEXT IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('A6 UNIQUE: purchases/freight idempotency_key, (purchase, storage_path), (freight, purchase)',
  uniques === 'freight_allocation_freight_id_purchase_id_key,freight_idempotency_key_key,purchase_attachment_purchase_id_storage_path_key,purchases_idempotency_key_key', uniques);
const inv = owner(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_purchases_supplier_invoice';`);
check('A7 invoice uniqueness is (supplier_id, supplier_invoice_number) for current, non-null rows only',
  /UNIQUE INDEX .*\(supplier_id, supplier_invoice_number\) WHERE \(\(supplier_invoice_number IS NOT NULL\) AND \(is_current = true\)\)/.test(inv), inv);
const idx = owner(`SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE indexname LIKE 'idx_%'
  AND tablename IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('A8 indexes as frozen', idx === 'idx_freight_allocation_purchase,idx_freight_economic_date,idx_purchase_attachment_purchase,'
  + 'idx_purchase_line_purchase,idx_purchases_economic_date,idx_purchases_project,idx_purchases_supplier,idx_purchases_supplier_invoice', idx);
const fks = owner(`SELECT string_agg(x, ',' ORDER BY x) FROM (
  SELECT c.conrelid::regclass || '.' || a.attname || '>' || c.confrelid::regclass || ':' || c.confdeltype::TEXT AS x
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.conrelid::regclass::TEXT IN (${TABLES.map((t) => `'${t}'`).join(',')})) s;`);
check('A9 foreign keys as frozen, all RESTRICT; fiscal_document_id FKs added by Phase 22',
  fks === 'freight.created_by>perfiles:r,freight.expense_category_id>expense_category:r,freight.fiscal_document_id>fiscal_document:r,freight.supplier_id>suppliers:r,'
  + 'freight_allocation.allocated_by>perfiles:r,freight_allocation.freight_id>freight:r,freight_allocation.purchase_id>purchases:r,'
  + 'purchase_attachment.purchase_id>purchases:r,purchase_attachment.uploaded_by>perfiles:r,'
  + 'purchase_line.feed_ingredient_id>feed_ingredient:r,purchase_line.producto_id>products:r,purchase_line.purchase_id>purchases:r,'
  + 'purchases.created_by>perfiles:r,purchases.expense_category_id>expense_category:r,purchases.fiscal_document_id>fiscal_document:r,purchases.flock_id>flocks:r,'
  + 'purchases.project_id>projects:r,purchases.supplier_id>suppliers:r', fks);
const cyc = owner(`SELECT string_agg(conname || ':' || convalidated, ',' ORDER BY conname) FROM pg_constraint
  WHERE conname IN ('fk_pedidos_sales_session','fk_sales_session_aggregated_pedido','fk_flocks_purchase','fk_purchases_flock');`);
check('A10 step 3.6 cycle 2 FKs (flocks ↔ purchases) exist and are validated; cycle 1 (pedidos ↔ sales_session) added by Phase 21',
  cyc === 'fk_flocks_purchase:true,fk_pedidos_sales_session:true,fk_purchases_flock:true,fk_sales_session_aggregated_pedido:true', cyc);
check('A11 fiscal_document exists since Phase 22 and both references carry the frozen FK',
  owner(`SELECT count(*) FROM pg_constraint WHERE conname IN ('purchases_fiscal_document_id_fkey','freight_fiscal_document_id_fkey') AND convalidated;`) === '2');
const rls = owner(`SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${TABLES.map((t) => `'${t}'`).join(',')}) AND relrowsecurity;`);
check('A12 RLS enabled on the five tables', rls === '5', rls);
check('A13 supplier_ledger reused, not duplicated (exactly one supplier ledger table)',
  owner(`SELECT string_agg(table_name, ',') FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* 'supplier.*(ledger|balance|account)|payable';`) === 'supplier_ledger');
const stored = owner(`SELECT coalesce(string_agg(table_name || '.' || column_name, ','), '') FROM information_schema.columns
  WHERE table_schema = 'public' AND (column_name ~* '(landed|saldo|balance)' OR (table_name = 'suppliers' AND column_name ~* 'debt|deuda')) AND table_name NOT IN (${ADR005_VIEWS});`);
check('A14 no stored landed_cost / supplier balance anywhere', stored === '', stored);
const forbidden = owner(`SELECT coalesce(string_agg(table_name, ','), '') FROM information_schema.tables WHERE table_schema = 'public'
  AND table_name ~* '(purchase_order|payment_allocation|invoice_allocation|purchase_payment|accounts_payable)';`);
check('A15 no purchase orders, invoice allocation or parallel AP structure', forbidden === '', forbidden);

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Register purchase');

const SUP_B = mkSupplier('Proveedor B');
let money = totalMoney();
const opsBefore = owner(`SELECT count(*) FROM financial_operation;`);
const keyB = uniq('K');
const pB = rpc(purchaseCall({
  sup: SUP_B, key: keyB, net: 82644.63, total: 100000, sub: 'Cereales', project: PROJ, invoice: 'A-0001',
  lines: [line({ feed_ingredient_id: ING, cantidad: 10, precio_unitario: 9000 }), line({ producto_id: PROD, descripcion: 'Maples', cantidad: 100, unit_type: 'UNIT', precio_unitario: 100 })],
  atts: [att(`${keyB}-factura`), att(`${keyB}-remito`)],
}));
check('B1 returns {purchase_id, supplier_ledger_id, line_count 2, attachment_count 2}',
  !!pB.purchase_id && Number.isInteger(pB.supplier_ledger_id) && pB.line_count === 2 && pB.attachment_count === 2, JSON.stringify(pB));
const rowB = owner(`SELECT supplier_id || '|' || economic_date || '|' || amount_net || '|' || amount_total || '|' || expense_category_id || '|' || subcategory
  || '|' || nature || '|' || project_id || '|' || supplier_invoice_number || '|' || is_current || '|' || version_seq || '|' || idempotency_key || '|' || created_by
  FROM purchases WHERE id = '${pB.purchase_id}';`);
check('B2 purchase persisted: supplier, economic_date, amounts, category, subcategory, nature, project, invoice, version 0 current, key, actor',
  rowB === `${SUP_B}|2026-04-10|82644.63|100000.00|${CAT}|Cereales|OPERATING|${PROJ}|A-0001|true|0|${keyB}|${ADMIN_UID}`, rowB);
const linesB = owner(`SELECT string_agg(descripcion || ':' || cantidad || ':' || unit_type || ':' || precio_unitario || ':' || subtotal, ',' ORDER BY subtotal DESC)
  FROM purchase_line WHERE purchase_id = '${pB.purchase_id}';`);
check('B3 lines inserted with derived subtotal (10×9000 = 90000, 100×100 = 10000)',
  linesB === 'Maíz:10.0000:TON:9000.00:90000.00,Maples:100.0000:UNIT:100.00:10000.00', linesB);
check('B4 ≥1 attachment inserted with metadata and uploader', owner(`SELECT count(*) || '|' || bool_and(uploaded_by = '${ADMIN_UID}') || '|' || min(content_type)
  FROM purchase_attachment WHERE purchase_id = '${pB.purchase_id}';`) === '2|true|application/pdf');
check('B5 exactly one PURCHASE +100000.00 at economic_date, source purchases/<id>',
  owner(`SELECT string_agg(movement_type || '|' || signed_amount || '|' || effective_date || '|' || source_entity_type || '|' || source_entity_id, ',')
         FROM supplier_ledger WHERE supplier_id = '${SUP_B}';`) === `PURCHASE|100000.00|2026-04-10|purchases|${pB.purchase_id}`);
check('B6 supplier debt = SUM(ledger) = 100000.00', supplierBal(SUP_B) === '100000.00');
check('B7 no financial operation / posting: buying is not paying', totalMoney() === money && owner(`SELECT count(*) FROM financial_operation;`) === opsBefore);
check('B8 audit CREATE with amount, nature, date and attachment count',
  owner(`SELECT (after_values->>'amount_total') || '|' || (after_values->>'nature') || '|' || (after_values->>'attachments') || '|' || performed_by
         FROM audit_events WHERE entity_type = 'purchases' AND entity_id = '${pB.purchase_id}' AND action = 'CREATE';`) === `100000|OPERATING|2|${ADMIN_UID}`);
const SHED = owner(`INSERT INTO sheds (nombre) VALUES ('${TAG} Galpón') RETURNING id;`);
const FLOCK = owner(`INSERT INTO flocks (shed_id, entry_date, initial_population) VALUES ('${SHED}', '2026-01-10', 5000) RETURNING id;`);
const pFlock = purchase({ sup: SUP_B, total: 500, net: 500, flock: FLOCK, nature: 'INVESTMENT' });
check('B9 optional flock linkage accepted (existing flock; cycle 2 FK)',
  owner(`SELECT flock_id || '|' || nature FROM purchases WHERE id = '${pFlock.purchase_id}';`) === `${FLOCK}|INVESTMENT`);
const pNoLines = purchase({ sup: SUP_B, total: 1200, net: 1000, lines: [] });
check('B10 contract as written: a purchase with no lines (e.g. a service) is accepted',
  pNoLines.line_count === 0 && pNoLines.attachment_count === 1);

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Attachments optional (ADR-010, owner D-WALK-5)');

snap = snapshot();
r = ADMIN(`SELECT ${purchaseCall({ sup: SUP_B, key: uniq('K'), atts: { storage_path: 'x' } })};`);
check('C0 non-array attachments → INVALID_ATTACHMENTS', raised(r, 'INVALID_ATTACHMENTS'), firstErr(r));
check('C1 no purchase, no line, no attachment, no ledger, no audit after that failure', snapshot() === snap);
const SUP_C = mkSupplier('Proveedor C (sin comprobante)');
const noAtt = [];
for (const [what, atts] of [['NULL attachments', null], ['empty attachment array', []]]) {
  const p = rpc(purchaseCall({ sup: SUP_C, key: uniq('K'), atts }));
  noAtt.push(p.purchase_id);
  check(`C ${what} → accepted with 0 attachments and the supplier debt booked`, p.attachment_count === 0 && Number.isInteger(p.supplier_ledger_id), JSON.stringify(p));
}
const rNoAtt = rpc(rectifyCall(noAtt[0], 1, 1, [line({ descripcion: 'Compra', cantidad: 1, unit_type: 'UNIT', precio_unitario: 1 })], 'corrección sin comprobante'));
check('C1b a purchase without attachments can be rectified; the new version carries none (ADR-010)',
  rNoAtt.version_seq === 1 && owner(`SELECT count(*) FROM purchase_attachment WHERE purchase_id = '${rNoAtt.new_purchase_id}';`) === '0');

snap = snapshot();
r = ADMIN(`SELECT ${purchaseCall({ sup: SUP_B, key: uniq('K'), atts: [{ file_name: 'x.pdf', content_type: 'application/pdf', byte_size: 1 }] })};`);
check('C2 attachment missing storage_path fails AFTER the purchase insert → full rollback', !r.ok && /storage_path/.test(r.err) && snapshot() === snap, firstErr(r));
r = ADMIN(`INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total, expense_category_id, nature, idempotency_key)
           VALUES ('${SUP_B}', '2026-04-10', 1, 1, '${CAT}', 'OPERATING', 'direct');`);
check('C3 no application path inserts a purchase directly (RPC 13 is the only creation path)', denied(r), firstErr(r));
check('C4 [ADR-010] invariant 23 superseded: purchases without attachments exist only through RPC 13 (the ones registered above)',
  owner(`SELECT count(*) FROM purchases p WHERE p.supplier_id = '${SUP_C}' AND NOT EXISTS (SELECT 1 FROM purchase_attachment a WHERE a.purchase_id = p.id);`) === '3');

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Purchase validation');

const SUP_OFF = mkSupplier('Proveedor inactivo', false);
snap = snapshot();
const dCases = [
  ['amount_total 0', { total: 0 }, 'INVALID_AMOUNT'],
  ['amount_total negative', { total: -5 }, 'INVALID_AMOUNT'],
  ['amount_total NULL', { total: null }, 'INVALID_AMOUNT'],
  ['nature NULL', { nature: null }, 'NATURE_REQUIRED'],
  ['category NULL', { cat: null }, 'CATEGORY_REQUIRED'],
  ['inactive supplier', { sup: SUP_OFF }, 'SUPPLIER_NOT_FOUND_OR_INACTIVE'],
  ['missing supplier', { sup: MISSING_UUID }, 'SUPPLIER_NOT_FOUND_OR_INACTIVE'],
];
for (const [what, o, code] of dCases) {
  r = ADMIN(`SELECT ${purchaseCall({ sup: SUP_B, key: uniq('K'), ...o })};`);
  check(`D ${what} → ${code}`, raised(r, code), firstErr(r));
}
const schemaCases = [
  ['line quantity 0', { lines: [line({ cantidad: 0 })] }, 'purchase_line_cantidad_check'],
  ['line negative price', { lines: [line({ precio_unitario: -1 })] }, 'purchase_line_precio_unitario_check'],
  ['unknown product', { lines: [line({ producto_id: MISSING_UUID })] }, 'purchase_line_producto_id_fkey'],
  ['unknown ingredient', { lines: [line({ feed_ingredient_id: MISSING_UUID })] }, 'purchase_line_feed_ingredient_id_fkey'],
  ['line without descripcion', { lines: [{ cantidad: 1, unit_type: 'KG', precio_unitario: 1 }] }, 'descripcion'],
  ['invalid unit_type', { lines: [line({ unit_type: 'BARREL' })] }, 'unit_type'],
  ['negative amount_net', { net: -1 }, 'purchases_amount_net_check'],
  ['dangling fiscal_document_id', { fiscal: MISSING_UUID }, 'purchases_fiscal_document_id_fkey'],   // frozen FK since Phase 22
  ['unknown flock', { flock: MISSING_UUID }, 'fk_purchases_flock'],
  ['unknown expense category', { cat: MISSING_UUID }, 'purchases_expense_category_id_fkey'],
];
for (const [what, o, name] of schemaCases) {
  r = ADMIN(`SELECT ${purchaseCall({ sup: SUP_B, key: uniq('K'), ...o })};`);
  check(`D ${what} → rejected by ${name} (schema-enforced)`, violates(r, name), firstErr(r));
}
r = OPER(`SELECT ${purchaseCall({ sup: SUP_B, key: uniq('K') })};`);
check('D OPERATOR → FORBIDDEN', raised(r, 'FORBIDDEN'), firstErr(r));
check('D1 none of the rejected registrations left any effect', snapshot() === snap);

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Idempotency');

snap = snapshot();
r = ADMIN(`SELECT ${purchaseCall({ sup: SUP_B, key: keyB, invoice: 'A-9999' })};`);
check('E1 duplicate idempotency_key → DUPLICATE_PURCHASE; no second debt', raised(r, 'DUPLICATE_PURCHASE') && snapshot() === snap && supplierBal(SUP_B) === f2(100000 + 500 + 1200), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Supplier invoice scope');

const SUP_F = mkSupplier('Proveedor F');
r = ADMIN(`SELECT ${purchaseCall({ sup: SUP_B, key: uniq('K'), invoice: 'A-0001' })};`);
check('F1 same invoice + same supplier → DUPLICATE_SUPPLIER_INVOICE', raised(r, 'DUPLICATE_SUPPLIER_INVOICE'), firstErr(r));
const pF = purchase({ sup: SUP_F, invoice: 'A-0001' });
check('F2 same invoice + different supplier → allowed', !!pF.purchase_id);
const pN1 = purchase({ sup: SUP_F });
const pN2 = purchase({ sup: SUP_F });
check('F3 NULL invoice twice for the same supplier → allowed', !!pN1.purchase_id && !!pN2.purchase_id);

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'Period');

closePeriod('2026-03-01');
snap = snapshot();
r = ADMIN(`SELECT ${purchaseCall({ sup: SUP_F, key: uniq('K'), date: '2026-03-15' })};`);
check('G1 CLOSED economic_date → PERIOD_CLOSED, nothing written', raised(r, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
openPeriod('2026-03-01');
r = ADMIN(`SELECT ${purchaseCall({ sup: SUP_F, key: uniq('K'), date: '2027-02-10' })};`);
check('G2 date without a management_period → PERIOD_NOT_FOUND', raised(r, 'PERIOD_NOT_FOUND'), firstErr(r));
closePeriod(CURRENT_MONTH);
const pG = purchase({ sup: SUP_F, date: '2026-05-20', total: 700, net: 700 });
check(`G3 created_at irrelevant: current month ${CURRENT_MONTH} CLOSED, economic_date 2026-05-20 OPEN → accepted; debt dated 2026-05-20`,
  owner(`SELECT effective_date FROM supplier_ledger WHERE source_entity_id = '${pG.purchase_id}';`) === '2026-05-20');
openPeriod(CURRENT_MONTH);

// ═══════════════════════════════════════════════════════════════════════════
section('H', 'Rectification');

const SUP_H = mkSupplier('Proveedor H');
const keyH = uniq('K');
const pH = rpc(purchaseCall({ sup: SUP_H, key: keyH, net: 82000, total: 100000, sub: 'Cereales', project: PROJ, invoice: 'H-1', atts: [att(`${keyH}-f`)] }));
const oldRow = owner(`SELECT amount_net || '|' || amount_total || '|' || version_seq FROM purchases WHERE id = '${pH.purchase_id}';`);
money = totalMoney();
const newLinesH = [line({ feed_ingredient_id: ING, cantidad: 12, precio_unitario: 9000 }), line({ descripcion: 'Flete incluido', cantidad: 1, unit_type: 'UNIT', precio_unitario: 12000 })];
const rH = rpc(rectifyCall(pH.purchase_id, 99000, 120000, newLinesH, 'factura corregida'));
check('H1 returns previous id, new id, version 1, adjustment +20000',
  rH.previous_purchase_id === pH.purchase_id && rH.new_purchase_id !== pH.purchase_id && rH.version_seq === 1 && Number(rH.adjustment) === 20000, JSON.stringify(rH));
check('H2 old row retired (is_current false) with its business fields untouched',
  owner(`SELECT is_current || '|' || amount_net || '|' || amount_total || '|' || version_seq FROM purchases WHERE id = '${pH.purchase_id}';`) === `false|${oldRow}`);
const newRow = owner(`SELECT supplier_id || '|' || economic_date || '|' || expense_category_id || '|' || subcategory || '|' || nature || '|' || project_id
  || '|' || supplier_invoice_number || '|' || coalesce(flock_id::TEXT, '-') || '|' || coalesce(fiscal_document_id::TEXT, '-') || '|' || amount_net || '|' || amount_total
  || '|' || is_current || '|' || version_seq || '|' || idempotency_key FROM purchases WHERE id = '${rH.new_purchase_id}';`);
check('H3 new current version inherits supplier, original economic_date, category, subcategory, nature, project, invoice; new amounts; key RECTIFY:<v0 id>:v1 (ADR-002)',
  newRow === `${SUP_H}|2026-04-10|${CAT}|Cereales|OPERATING|${PROJ}|H-1|-|-|99000.00|120000.00|true|1|RECTIFY:${pH.purchase_id}:v1`, newRow);
check('H4 new lines exactly the replacement set (12×9000 + 1×12000)',
  owner(`SELECT count(*) || '|' || SUM(subtotal) FROM purchase_line WHERE purchase_id = '${rH.new_purchase_id}';`) === '2|120000.00');
check('H5 old lines remain on the old version (history)', owner(`SELECT count(*) FROM purchase_line WHERE purchase_id = '${pH.purchase_id}';`) === '1');
check('H6 attachments carried forward (same storage paths on the new version)',
  owner(`SELECT string_agg(storage_path, ',') FROM purchase_attachment WHERE purchase_id = '${rH.new_purchase_id}';`) === `purchases/${keyH}-f.pdf`);
check('H7 supplier ledger: PURCHASE +100000, REVERSAL -100000 (source old id), PURCHASE +120000 (source new id), all at the ORIGINAL date',
  owner(`SELECT string_agg(movement_type || ':' || signed_amount || ':' || effective_date || ':' || source_entity_id, ',' ORDER BY id) FROM supplier_ledger WHERE supplier_id = '${SUP_H}';`)
  === `PURCHASE:100000.00:2026-04-10:${pH.purchase_id},REVERSAL:-100000.00:2026-04-10:${pH.purchase_id},PURCHASE:120000.00:2026-04-10:${rH.new_purchase_id}`);
check('H8 net supplier debt = new amount 120000.00', supplierBal(SUP_H) === '120000.00');
check('H9 no money moved by the rectification', totalMoney() === money);
check('H10 audit RECTIFY: before {100000, v0}, after {120000, v1, new_id}, reason',
  owner(`SELECT (before_values->>'amount_total') || '|' || (before_values->>'version') || '|' || (after_values->>'amount_total') || '|' || (after_values->>'version')
         || '|' || (after_values->>'new_id') || '|' || reason FROM audit_events WHERE entity_id = '${pH.purchase_id}' AND action = 'RECTIFY';`)
  === `100000.00|0|120000|1|${rH.new_purchase_id}|factura corregida`);
r = ADMIN(`SELECT ${purchaseCall({ sup: SUP_H, key: uniq('K'), invoice: 'H-1' })};`);
check('H11 the invoice stays taken by the current version after rectification', raised(r, 'DUPLICATE_SUPPLIER_INVOICE'), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'N rectifications');

const r2 = rpc(rectifyCall(rH.new_purchase_id, 75000, 90000, [line({ cantidad: 10 })]));
const r3 = rpc(rectifyCall(r2.new_purchase_id, 90000, 110000, [line({ cantidad: 12 })]));
const chainIds = `('${pH.purchase_id}','${rH.new_purchase_id}','${r2.new_purchase_id}','${r3.new_purchase_id}')`;
const chain = owner(`SELECT string_agg(version_seq || ':' || is_current || ':' || amount_total, ',' ORDER BY version_seq) FROM purchases WHERE id IN ${chainIds};`);
check('I1 four versions 0..3, exactly one current (v3), old business rows kept', chain === '0:false:100000.00,1:false:120000.00,2:false:90000.00,3:true:110000.00', chain);
check('I2 version_seq increments by one per pass', r2.version_seq === 2 && r3.version_seq === 3);
check('I3 each REVERSAL cancels the then-current version: -100000, -120000, -90000 (no double correction)',
  owner(`SELECT string_agg(signed_amount::TEXT, ',' ORDER BY id) FROM supplier_ledger WHERE supplier_id = '${SUP_H}' AND movement_type = 'REVERSAL';`) === '-100000.00,-120000.00,-90000.00');
check('I4 supplier ledger telescopes to the latest amount: 110000.00', supplierBal(SUP_H) === '110000.00');
check('I5 every version carries ≥1 attachment', owner(`SELECT bool_and(EXISTS (SELECT 1 FROM purchase_attachment a WHERE a.purchase_id = p.id))
  FROM purchases p WHERE id IN ${chainIds};`) === 't');
check('I6 version keys are deterministic and non-recursive (ADR-002): K, RECTIFY:<v0 id>:v1, RECTIFY:<v1 id>:v2, RECTIFY:<v2 id>:v3',
  owner(`SELECT string_agg(idempotency_key, ',' ORDER BY version_seq) FROM purchases WHERE id IN ${chainIds};`)
  === `${keyH},RECTIFY:${pH.purchase_id}:v1,RECTIFY:${rH.new_purchase_id}:v2,RECTIFY:${r2.new_purchase_id}:v3`);

// ═══════════════════════════════════════════════════════════════════════════
section('IB', 'ADR-002 — bounded version key, 100-char key, 30+ passes, reserved prefix');

const SUP_IB = mkSupplier('Proveedor IB');
const key100 = `${TAG}-`.padEnd(100, 'x');
const pIB = rpc(purchaseCall({ sup: SUP_IB, key: key100, total: 1000, net: 1000, invoice: 'IB-1', atts: [att('ib-factura'), att('ib-remito')] }));
check('IB1 initial idempotency_key of exactly 100 characters is accepted',
  key100.length === 100 && owner(`SELECT length(idempotency_key) FROM purchases WHERE id = '${pIB.purchase_id}';`) === '100');
const ibIds = [pIB.purchase_id];
const ibTotals = [1000];
const PASSES = 32;
let ibFail = '';
for (let n = 1; n <= PASSES; n += 1) {
  const total = 1000 + n * 10;
  const rr = ADMIN(`SELECT ${rectifyCall(ibIds[ibIds.length - 1], total, total, [line({ cantidad: 1, precio_unitario: total })], `pasada ${n}`)};`);
  if (!rr.ok) { ibFail = `pass ${n}: ${firstErr(rr)}`; break; }
  ibIds.push(JSON.parse(rr.out).new_purchase_id);
  ibTotals.push(total);
  if (n === 1) {
    check('IB2 the first rectification of a 100-character-key purchase succeeds',
      owner(`SELECT idempotency_key FROM purchases WHERE id = '${ibIds[1]}';`) === `RECTIFY:${pIB.purchase_id}:v1`);
  }
}
check(`IB3 ${PASSES} sequential rectifications all succeed`, ibFail === '' && ibIds.length === PASSES + 1, ibFail);
const ibList = `(${ibIds.map((i) => `'${i}'`).join(',')})`;
check('IB4 exactly one current version (the last one)',
  owner(`SELECT count(*) FILTER (WHERE is_current) || '|' || bool_or(is_current AND id = '${ibIds[PASSES]}') FROM purchases WHERE id IN ${ibList};`) === '1|true');
check(`IB5 version_seq is 0..${PASSES}, one per pass`,
  owner(`SELECT string_agg(version_seq::TEXT, ',' ORDER BY version_seq) FROM purchases WHERE id IN ${ibList};`) === [...Array(PASSES + 1).keys()].join(','));
const ibKeys = owner(`SELECT string_agg(version_seq || '=' || idempotency_key, ',' ORDER BY version_seq) FROM purchases WHERE id IN ${ibList} AND version_seq > 0;`).split(',');
check('IB6 every generated key is ≤ 56 characters (max observed ≤ 56)',
  owner(`SELECT max(length(idempotency_key)) <= 56 FROM purchases WHERE id IN ${ibList} AND version_seq > 0;`) === 't');
check('IB7 every generated key has the exact format RECTIFY:<uuid>:v<n>',
  owner(`SELECT bool_and(idempotency_key ~ '^RECTIFY:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:v[0-9]+$')
         FROM purchases WHERE id IN ${ibList} AND version_seq > 0;`) === 't');
check('IB8 determinism: key(vN) = RECTIFY:<id of v(N-1)>:vN for every pass',
  ibKeys.every((kv, idx) => kv === `${idx + 1}=RECTIFY:${ibIds[idx]}:v${idx + 1}`), ibKeys.slice(0, 3).join(' | '));
check('IB9 all keys of the chain are distinct',
  owner(`SELECT count(DISTINCT idempotency_key) = count(*) FROM purchases WHERE id IN ${ibList};`) === 't');
check(`IB10 supplier ledger telescopes to the last amount (${ibTotals[PASSES].toFixed(2)}), with one REVERSAL per pass cancelling the then-current total`,
  supplierBal(SUP_IB) === ibTotals[PASSES].toFixed(2)
  && owner(`SELECT string_agg((-signed_amount)::TEXT, ',' ORDER BY id) FROM supplier_ledger WHERE supplier_id = '${SUP_IB}' AND movement_type = 'REVERSAL';`)
     === ibTotals.slice(0, PASSES).map((t) => t.toFixed(2)).join(','));
check('IB11 attachments preserved on every version (same two storage paths)',
  owner(`SELECT bool_and((SELECT string_agg(storage_path, ',' ORDER BY storage_path) FROM purchase_attachment a WHERE a.purchase_id = p.id)
         = 'purchases/ib-factura.pdf,purchases/ib-remito.pdf') FROM purchases p WHERE id IN ${ibList};`) === 't');
check('IB12 the invoice stays unique among current versions after 32 passes',
  owner(`SELECT count(*) FROM purchases WHERE supplier_id = '${SUP_IB}' AND supplier_invoice_number = 'IB-1' AND is_current;`) === '1');
snap = snapshot();
const reserved = [
  ['RECTIFY:anything', 'RESERVED_IDEMPOTENCY_KEY'],
  [`RECTIFY:${ibIds[PASSES]}:v${PASSES + 1}`, 'RESERVED_IDEMPOTENCY_KEY'],
  ['RECTIFY:', 'RESERVED_IDEMPOTENCY_KEY'],
];
for (const [k, code] of reserved) {
  r = ADMIN(`SELECT ${purchaseCall({ sup: SUP_IB, key: k })};`);
  check(`IB13 register_purchase with key "${k.length > 30 ? `${k.slice(0, 30)}…` : k}" → ${code}`, raised(r, code), firstErr(r));
}
check('IB14 the reserved-prefix rejections left no partial effect', snapshot() === snap);
const lowerOk = ADMIN(`SELECT ${purchaseCall({ sup: SUP_IB, key: `rectify:${uniq('lc')}`, total: 1, net: 1 })};`);
const midOk = ADMIN(`SELECT ${purchaseCall({ sup: SUP_IB, key: `X-RECTIFY:${uniq('mid')}`, total: 1, net: 1 })};`);
check('IB15 the reservation is exact and case-sensitive: "rectify:…" and "X-RECTIFY:…" are ordinary keys', lowerOk.ok && midOk.ok,
  `${firstErr(lowerOk)} / ${firstErr(midOk)}`);

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'Rectification errors / superseded');

snap = snapshot();
const kCases = [
  ['superseded version', rectifyCall(pH.purchase_id, 1, 1, [line()]), 'PURCHASE_SUPERSEDED'],
  ['missing purchase', rectifyCall(MISSING_UUID, 1, 1, [line()]), 'PURCHASE_NOT_FOUND'],
  ['blank reason', rectifyCall(r3.new_purchase_id, 1, 1, [line()], '  '), 'REASON_REQUIRED'],
  ['total 0', rectifyCall(r3.new_purchase_id, 0, 0, [line()]), 'INVALID_AMOUNT'],
  ['total NULL', rectifyCall(r3.new_purchase_id, 1, null, [line()]), 'INVALID_AMOUNT'],
  ['net negative', rectifyCall(r3.new_purchase_id, -1, 10, [line()]), 'INVALID_AMOUNT'],
  ['empty line set', rectifyCall(r3.new_purchase_id, 1, 1, []), 'EMPTY_LINE_SET'],
  ['NULL line set', rectifyCall(r3.new_purchase_id, 1, 1, null), 'EMPTY_LINE_SET'],
  ['quantity 0', rectifyCall(r3.new_purchase_id, 1, 1, [line({ cantidad: 0 })]), 'INVALID_QUANTITY'],
  ['negative price', rectifyCall(r3.new_purchase_id, 1, 1, [line({ precio_unitario: -1 })]), 'INVALID_PRICE'],
  ['unknown product (in 2nd line)', rectifyCall(r3.new_purchase_id, 1, 1, [line(), line({ producto_id: MISSING_UUID })]), 'PRODUCT_NOT_FOUND'],
  ['unknown ingredient', rectifyCall(r3.new_purchase_id, 1, 1, [line({ feed_ingredient_id: MISSING_UUID })]), 'INGREDIENT_NOT_FOUND'],
];
for (const [what, call, code] of kCases) {
  r = ADMIN(`SELECT ${call};`);
  check(`K rectify ${what} → ${code}`, raised(r, code), firstErr(r));
}
check('K1 no rejected rectification changed anything (validation happens before the first mutation)', snapshot() === snap);
const pK = purchase({ sup: SUP_H, date: '2026-03-12' });
closePeriod('2026-03-01');
snap = snapshot();
r = ADMIN(`SELECT ${rectifyCall(pK.purchase_id, 1, 1, [line()])};`);
check('K2 ORIGINAL economic_date in a CLOSED period → PERIOD_CLOSED, nothing changed', raised(r, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
openPeriod('2026-03-01');
const pK2 = purchase({ sup: SUP_H });
owner(`DELETE FROM purchase_attachment WHERE purchase_id = '${pK2.purchase_id}';`);   // owner-only synthetic corruption
snap = snapshot();
r = ADMIN(`SELECT ${rectifyCall(pK2.purchase_id, 1, 1, [line()])};`);
check('K3 [ADR-010] a current version without attachment is rectified; the new version carries none', r.ok
  && owner(`SELECT count(*) FROM purchase_attachment a JOIN purchases p ON p.id = a.purchase_id WHERE p.supplier_id = '${SUP_H}' AND p.is_current AND p.version_seq = 1 AND p.idempotency_key LIKE 'RECTIFY:${pK2.purchase_id}%';`) === '0', firstErr(r));
owner(`INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size) VALUES ('${pK2.purchase_id}', 'restored.pdf', 'restored.pdf', 'application/pdf', 1);`);

// ═══════════════════════════════════════════════════════════════════════════
section('J', 'Rectification atomicity (injected failures)');

owner(`
CREATE SCHEMA p17_harness;
CREATE TABLE p17_harness.fail_on (target TEXT, old_id TEXT, old_key TEXT);
CREATE FUNCTION p17_harness.hit(p_target TEXT, p_new_key TEXT, p_old_id TEXT) RETURNS BOOLEAN LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM p17_harness.fail_on f WHERE f.target = p_target
                   AND (p_old_id = f.old_id OR p_new_key LIKE f.old_key || ':v%'));
$$;
-- one trigger function per table: PL/pgSQL resolves NEW.<field> per table, so
-- a shared function cannot reference columns that only some tables have.
CREATE FUNCTION p17_harness.f_purchases() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF p17_harness.hit('purchase_insert', NEW.idempotency_key, NULL) THEN RAISE EXCEPTION 'HARNESS_FAILURE_AFTER_RETIRE'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p17_harness.f_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k TEXT;
BEGIN
  SELECT idempotency_key INTO k FROM public.purchases WHERE id = NEW.purchase_id;
  IF TG_TABLE_NAME = 'purchase_line' AND p17_harness.hit('line', k, NULL) THEN
    RAISE EXCEPTION 'HARNESS_FAILURE_PURCHASE_LINE';
  ELSIF TG_TABLE_NAME = 'purchase_attachment' AND p17_harness.hit('attachment', k, NULL) THEN
    RAISE EXCEPTION 'HARNESS_FAILURE_PURCHASE_ATTACHMENT';
  ELSIF TG_TABLE_NAME = 'freight_allocation' AND p17_harness.hit('allocation', k, NULL) THEN
    RAISE EXCEPTION 'HARNESS_FAILURE_ALLOCATION_REPOINT';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p17_harness.f_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k TEXT;
BEGIN
  IF NEW.movement_type = 'REVERSAL' AND p17_harness.hit('reversal', NULL, NEW.source_entity_id) THEN
    RAISE EXCEPTION 'HARNESS_FAILURE_REVERSAL';
  END IF;
  IF NEW.movement_type = 'PURCHASE' THEN
    SELECT idempotency_key INTO k FROM public.purchases WHERE id::TEXT = NEW.source_entity_id;
    IF p17_harness.hit('new_purchase_ledger', k, NULL) THEN RAISE EXCEPTION 'HARNESS_FAILURE_NEW_PURCHASE_LEDGER'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p17_harness.f_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action = 'RECTIFY' AND p17_harness.hit('audit', NULL, NEW.entity_id) THEN RAISE EXCEPTION 'HARNESS_FAILURE_AUDIT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p17_fail_purchases BEFORE INSERT ON public.purchases FOR EACH ROW EXECUTE FUNCTION p17_harness.f_purchases();
CREATE TRIGGER p17_fail_lines BEFORE INSERT ON public.purchase_line FOR EACH ROW EXECUTE FUNCTION p17_harness.f_child();
CREATE TRIGGER p17_fail_atts BEFORE INSERT ON public.purchase_attachment FOR EACH ROW EXECUTE FUNCTION p17_harness.f_child();
CREATE TRIGGER p17_fail_alloc BEFORE UPDATE ON public.freight_allocation FOR EACH ROW EXECUTE FUNCTION p17_harness.f_child();
CREATE TRIGGER p17_fail_ledger BEFORE INSERT ON public.supplier_ledger FOR EACH ROW EXECUTE FUNCTION p17_harness.f_ledger();
CREATE TRIGGER p17_fail_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION p17_harness.f_audit();`);
try {
  const SUP_J = mkSupplier('Proveedor J');
  const keyJ = uniq('K');
  const pJ = rpc(purchaseCall({ sup: SUP_J, key: keyJ, invoice: 'J-1', total: 50000, net: 50000 }));
  const frJ = freight({ sup: SUP_J, amount: 5000 });
  rpc(assignCall(frJ.freight_id, pJ.purchase_id, 3000));
  const jCases = [
    ['purchase_insert', 'after the old version is retired, inserting the new version fails', 'HARNESS_FAILURE_AFTER_RETIRE'],
    ['line', 'after the new version is inserted, the replacement lines fail', 'HARNESS_FAILURE_PURCHASE_LINE'],
    ['attachment', 'after the lines, copying attachments fails', 'HARNESS_FAILURE_PURCHASE_ATTACHMENT'],
    ['allocation', 'after the attachments, re-pointing freight allocations fails', 'HARNESS_FAILURE_ALLOCATION_REPOINT'],
    ['reversal', 'after the re-point, the ledger REVERSAL fails', 'HARNESS_FAILURE_REVERSAL'],
    ['new_purchase_ledger', 'after the REVERSAL, the new PURCHASE ledger row fails', 'HARNESS_FAILURE_NEW_PURCHASE_LEDGER'],
    ['audit', 'after the new PURCHASE ledger row, the audit fails', 'HARNESS_FAILURE_AUDIT'],
  ];
  for (const [targetName, what, code] of jCases) {
    owner(`DELETE FROM p17_harness.fail_on; INSERT INTO p17_harness.fail_on VALUES ('${targetName}', '${pJ.purchase_id}', 'RECTIFY:${pJ.purchase_id}');`);
    snap = snapshot();
    r = ADMIN(`SELECT ${rectifyCall(pJ.purchase_id, 60000, 60000, [line()])};`);
    check(`J ${what} → full rollback (old version still current, ledger 50000+5000, allocation on the old version)`,
      raised(r, code) && snapshot() === snap
      && owner(`SELECT is_current FROM purchases WHERE id = '${pJ.purchase_id}';`) === 't'
      && supplierBal(SUP_J) === '55000.00'
      && owner(`SELECT purchase_id FROM freight_allocation WHERE freight_id = '${frJ.freight_id}';`) === pJ.purchase_id, firstErr(r));
  }
} finally {
  owner(`DROP SCHEMA IF EXISTS p17_harness CASCADE;`);
}
check('J harness triggers removed', owner(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p17_fail_%';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'Pay supplier');

const SUP_L = mkSupplier('Proveedor L');
const pL = purchase({ sup: SUP_L, total: 100000, net: 100000 });
const pLrow = owner(`SELECT xmin || '|' || amount_total FROM purchases WHERE id = '${pL.purchase_id}';`);
const refL = uniq('PAY');
const payL = rpc(payCall(SUP_L, 40000, BANK, refL, '2026-04-15', 'TRANSFER'));
check('L1 payment reduces supplier debt: 100000 → 60000.00', supplierBal(SUP_L) === '60000.00');
check('L2 the chosen account decreases by the same amount (-40000.00)', acctBal(BANK) === '-40000.00');
check('L3 exactly one SUPPLIER_PAYMENT operation (external_ref, source suppliers/<id>, date)',
  owner(`SELECT operation_type || '|' || external_ref || '|' || source_entity_type || '|' || source_entity_id || '|' || effective_date FROM financial_operation WHERE id = ${payL.financial_operation_id};`)
  === `SUPPLIER_PAYMENT|${refL}|suppliers|${SUP_L}|2026-04-15`);
check('L4 exactly one posting -40000.00 on the account at the same date',
  owner(`SELECT count(*) || '|' || SUM(signed_amount) || '|' || min(financial_account_id::TEXT) || '|' || min(effective_date) FROM financial_posting WHERE financial_operation_id = ${payL.financial_operation_id};`)
  === `1|-40000.00|${BANK}|2026-04-15`);
check('L5 exactly one PAYMENT ledger row -40000.00, source payment/<operation id>, same date',
  owner(`SELECT movement_type || '|' || signed_amount || '|' || source_entity_type || '|' || source_entity_id || '|' || effective_date FROM supplier_ledger WHERE id = ${payL.supplier_ledger_id};`)
  === `PAYMENT|-40000.00|payment|${payL.financial_operation_id}|2026-04-15`);
check('L6 the purchase row is not touched by the payment (no settlement status, same xmin)',
  owner(`SELECT xmin || '|' || amount_total FROM purchases WHERE id = '${pL.purchase_id}';`) === pLrow);
check('L7 payment is not allocated to any invoice (no purchase reference anywhere in the payment)',
  owner(`SELECT count(*) FROM financial_operation WHERE id = ${payL.financial_operation_id} AND (source_entity_type = 'purchases' OR external_ref LIKE '%${pL.purchase_id}%');`) === '0');
check('L8 audit PAY with amount, date and method',
  owner(`SELECT (after_values->>'amount') || '|' || (after_values->>'method') FROM audit_events WHERE entity_type = 'suppliers' AND entity_id = '${SUP_L}' AND action = 'PAY';`) === '40000|TRANSFER');

// ═══════════════════════════════════════════════════════════════════════════
section('M', 'Partial / overpayment');

check('M1 a partial payment leaves a positive balance (60000.00)', supplierBal(SUP_L) === '60000.00');
rpc(payCall(SUP_L, 100000, BANK, uniq('PAY'), '2026-04-16', 'CASH'));
check('N1 an overpayment is accepted: balance -40000.00 (supplier credit), no rejection by balance', supplierBal(SUP_L) === '-40000.00');

// ═══════════════════════════════════════════════════════════════════════════
section('O', 'Cheque boundary / payment validation');

snap = snapshot();
const oCases = [
  ['CHEQUE', payCall(SUP_L, 100, BANK, uniq('PAY'), '2026-04-17', 'CHEQUE'), 'USE_ISSUE_SUPPLIER_INSTRUMENT'],
  ['amount 0', payCall(SUP_L, 0, BANK, uniq('PAY')), 'INVALID_AMOUNT'],
  ['amount NULL', payCall(SUP_L, null, BANK, uniq('PAY')), 'INVALID_AMOUNT'],
  ['inactive supplier', payCall(SUP_OFF, 10, BANK, uniq('PAY')), 'SUPPLIER_NOT_FOUND_OR_INACTIVE'],
  ['inactive account', payCall(SUP_L, 10, BANK_OFF, uniq('PAY')), 'ACCOUNT_NOT_FOUND_OR_INACTIVE'],
  ['missing account', payCall(SUP_L, 10, MISSING_UUID, uniq('PAY')), 'ACCOUNT_NOT_FOUND_OR_INACTIVE'],
];
for (const [what, call, code] of oCases) {
  r = ADMIN(`SELECT ${call};`);
  check(`O pay ${what} → ${code}`, raised(r, code), firstErr(r));
}
check('O1 none of them wrote ledger, operation or posting', snapshot() === snap);
closePeriod('2026-03-01');
r = ADMIN(`SELECT ${payCall(SUP_L, 10, BANK, uniq('PAY'), '2026-03-20')};`);
check('O1b payment with effective_date in a CLOSED period → PERIOD_CLOSED, nothing written', raised(r, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
r = ADMIN(`SELECT ${payCall(SUP_L, 10, BANK, uniq('PAY'), '2027-02-10')};`);
check('O1c payment date without a management_period → PERIOD_NOT_FOUND', raised(r, 'PERIOD_NOT_FOUND') && snapshot() === snap, firstErr(r));
openPeriod('2026-03-01');
const iss = rpc(`issue_supplier_instrument('${SUP_L}', 'ECHEQ', '777', 5000, '2026-12-31', '2026-04-18', '${BANK}', '${uniq('X')}', 'pago con eCheq')`);
check('O2 the cheque path is the Phase 16 issued instrument: it reduces supplier debt by 5000 without moving the bank',
  iss.estado === 'ISSUED' && supplierBal(SUP_L) === '-45000.00' && acctBal(BANK) === '-140000.00');

// ═══════════════════════════════════════════════════════════════════════════
section('P', 'Payment idempotency');

snap = snapshot();
r = ADMIN(`SELECT ${payCall(SUP_L, 10, BANK, refL)};`);
check('P1 duplicate external_ref → DUPLICATE_PAYMENT, no second movement', raised(r, 'DUPLICATE_PAYMENT') && snapshot() === snap, firstErr(r));
const nullA = rpc(payCall(SUP_L, 1, BANK, null));
const nullB = rpc(payCall(SUP_L, 1, BANK, null));
check('P2 contract as written: NULL external_ref is not deduplicated (two payments) — carry-forward idempotency decision',
  nullA.financial_operation_id !== nullB.financial_operation_id);

// ═══════════════════════════════════════════════════════════════════════════
section('Q', 'Register freight');

const SUP_Q = mkSupplier('Transporte Q');
money = totalMoney();
const kQ = uniq('F');
const fQ = rpc(freightCall({ key: kQ, sup: SUP_Q, amount: 15000, doc: 'R-0001' }));
check('Q1 returns {freight_id, economic_date, amount}', !!fQ.freight_id && fQ.economic_date === '2026-04-11' && Number(fQ.amount) === 15000, JSON.stringify(fQ));
check('Q2 freight row: supplier, date, amount, document, category, version 0 current, key',
  owner(`SELECT supplier_id || '|' || economic_date || '|' || amount || '|' || document_ref || '|' || expense_category_id || '|' || is_current || '|' || version_seq || '|' || idempotency_key
         FROM freight WHERE id = '${fQ.freight_id}';`) === `${SUP_Q}|2026-04-11|15000.00|R-0001|${CAT2}|true|0|${kQ}`);
check('Q3 with supplier: exactly one FREIGHT +15000.00 at economic_date, source freight/<id>',
  ledgerOf(SUP_Q) === 'FREIGHT:15000.00'
  && owner(`SELECT effective_date || '|' || source_entity_type || '|' || source_entity_id FROM supplier_ledger WHERE supplier_id = '${SUP_Q}';`) === `2026-04-11|freight|${fQ.freight_id}`);
check('Q4 no money moved on registration', totalMoney() === money);
check('Q5 audit CREATE freight', owner(`SELECT action || '|' || (after_values->>'amount') FROM audit_events WHERE entity_type = 'freight' AND entity_id = '${fQ.freight_id}';`) === 'CREATE|15000');
const ledgerCount = owner(`SELECT count(*) FROM supplier_ledger;`);
const fQ2 = freight({ amount: 3000 });
check('Q6 without supplier: freight row, NO supplier_ledger row, no posting',
  owner(`SELECT supplier_id IS NULL FROM freight WHERE id = '${fQ2.freight_id}';`) === 't'
  && owner(`SELECT count(*) FROM supplier_ledger;`) === ledgerCount && totalMoney() === money);
snap = snapshot();
const qCases = [
  [freightCall({ key: uniq('F'), amount: 0 }), 'INVALID_AMOUNT', 'raised'],
  [freightCall({ key: uniq('F'), amount: null }), 'INVALID_AMOUNT', 'raised'],
  [freightCall({ key: kQ }), 'DUPLICATE_FREIGHT', 'raised'],
  [freightCall({ key: uniq('F'), fiscal: MISSING_UUID }), 'freight_fiscal_document_id_fkey', 'violates'],   // frozen FK since Phase 22
  [freightCall({ key: uniq('F'), cat: null }), 'expense_category_id', 'violates'],
];
for (const [call, code, kind] of qCases) {
  r = ADMIN(`SELECT ${call};`);
  check(`Q freight rejected: ${code}`, kind === 'raised' ? raised(r, code) : violates(r, code), firstErr(r));
}
check('R1 duplicate freight key and invalid inputs left nothing', snapshot() === snap);
closePeriod('2026-03-01');
r = ADMIN(`SELECT ${freightCall({ key: uniq('F'), date: '2026-03-20' })};`);
check('Q7 CLOSED economic_date → PERIOD_CLOSED', raised(r, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
openPeriod('2026-03-01');

// ═══════════════════════════════════════════════════════════════════════════
section('S', 'Allocate freight');

const SUP_S = mkSupplier('Proveedor S');
const pS1 = purchase({ sup: SUP_S, total: 100000, net: 100000 });
const pS2 = purchase({ sup: SUP_S, total: 50000, net: 50000 });
const fS = freight({ sup: SUP_Q, amount: 100 });
money = totalMoney();
const slCount = owner(`SELECT count(*) || '|' || SUM(signed_amount) FROM supplier_ledger;`);
const opCount = owner(`SELECT count(*) FROM financial_operation;`);
const aS = rpc(assignCall(fS.freight_id, pS1.purchase_id, 60));
check('S1 valid allocation returns {allocation_id, freight_remaining 40}', !!aS.allocation_id && Number(aS.freight_remaining) === 40, JSON.stringify(aS));
check('S2 exactly one freight_allocation row (freight, purchase, amount, actor)',
  owner(`SELECT count(*) || '|' || min(allocated_amount) || '|' || min(allocated_by::TEXT) FROM freight_allocation WHERE freight_id = '${fS.freight_id}';`) === `1|60.00|${ADMIN_UID}`);
check('S3 allocation creates NO supplier_ledger, NO operation, NO posting',
  owner(`SELECT count(*) || '|' || SUM(signed_amount) FROM supplier_ledger;`) === slCount
  && owner(`SELECT count(*) FROM financial_operation;`) === opCount && totalMoney() === money);
check('S4 audit ALLOCATE', owner(`SELECT (after_values->>'allocated_amount') FROM audit_events WHERE entity_type = 'freight_allocation' AND entity_id = '${aS.allocation_id}' AND action = 'ALLOCATE';`) === '60');

// ═══════════════════════════════════════════════════════════════════════════
section('T', 'Over-allocation');

const aS2 = rpc(assignCall(fS.freight_id, pS2.purchase_id, 40));
check('T1 partial allocations across two purchases up to the exact cap (60 + 40 = 100) are allowed', Number(aS2.freight_remaining) === 0);
const fT = freight({ amount: 100 });
rpc(assignCall(fT.freight_id, pS1.purchase_id, 60));
snap = snapshot();
r = ADMIN(`SELECT ${assignCall(fT.freight_id, pS2.purchase_id, 40.01)};`);
check('T2 one cent over the cap → OVER_ALLOCATION, nothing written', raised(r, 'OVER_ALLOCATION') && snapshot() === snap, firstErr(r));
check('T3 SUM(allocated) never exceeds freight.amount for any freight',
  owner(`SELECT count(*) FROM freight f WHERE (SELECT COALESCE(SUM(allocated_amount), 0) FROM freight_allocation a WHERE a.freight_id = f.id) > f.amount;`) === '0');
const sCases = [
  [assignCall(fT.freight_id, pS1.purchase_id, 0), 'INVALID_AMOUNT'],
  [assignCall(fT.freight_id, pS1.purchase_id, null), 'INVALID_AMOUNT'],
  [assignCall(MISSING_UUID, pS1.purchase_id, 1), 'FREIGHT_NOT_FOUND'],
  [assignCall(fT.freight_id, MISSING_UUID, 1), 'PURCHASE_NOT_FOUND'],
  [assignCall(fT.freight_id, pH.purchase_id, 1), 'PURCHASE_SUPERSEDED'],
];
for (const [call, code] of sCases) {
  r = ADMIN(`SELECT ${call};`);
  check(`T allocation rejected → ${code}`, raised(r, code), firstErr(r));
}
check('T4 rejected allocations left nothing', snapshot() === snap);

// ═══════════════════════════════════════════════════════════════════════════
section('U', 'Duplicate allocation');

r = ADMIN(`SELECT ${assignCall(fT.freight_id, pS1.purchase_id, 10)};`);
check('U1 same freight/purchase pair again → ALREADY_ALLOCATED', raised(r, 'ALREADY_ALLOCATED') && snapshot() === snap, firstErr(r));
r = raw(`INSERT INTO freight_allocation (freight_id, purchase_id, allocated_amount) VALUES ('${fT.freight_id}', '${pS1.purchase_id}', 1);`);
check('U2 UNIQUE(freight_id, purchase_id) is the physical backstop (even for the owner)', violates(r, 'freight_allocation_freight_id_purchase_id_key'), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('V', 'Landed cost');

const SUP_V = mkSupplier('Proveedor V');
const pV = purchase({ sup: SUP_V, total: 100000, net: 100000 });
const fV = freight({ sup: SUP_Q, amount: 15000 });
const supVBefore = supplierBal(SUP_V);
const supQBefore = supplierBal(SUP_Q);
money = totalMoney();
rpc(assignCall(fV.freight_id, pV.purchase_id, 15000));
check('V1 derived landed cost = amount_total + allocation = 115000.00', landed(pV.purchase_id) === '115000.00', landed(pV.purchase_id));
check('V2 allocation changed neither purchase liability, nor freight liability, nor money',
  supplierBal(SUP_V) === supVBefore && supplierBal(SUP_Q) === supQBefore && totalMoney() === money);
const fV2 = freight({ amount: 2500 });
rpc(assignCall(fV2.freight_id, pV.purchase_id, 2500));
check('V3 several freights allocated to one purchase sum: 100000 + 15000 + 2500 = 117500.00', landed(pV.purchase_id) === '117500.00');
check('V4 landed cost is not stored anywhere (derived by query only)',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* 'landed|cost_per|unit_cost'
    AND NOT (table_name = 'feed_formula_line' AND column_name = 'unit_cost_snapshot');`) === '0');   // Phase 20: frozen per-version ingredient cost snapshot, not landed cost

// ═══════════════════════════════════════════════════════════════════════════
section('W', 'Rectification with freight');

const SUP_W = mkSupplier('Proveedor W');
const pW = purchase({ sup: SUP_W, total: 100000, net: 100000 });
const fW = freight({ sup: SUP_Q, amount: 15000 });
const aW = rpc(assignCall(fW.freight_id, pW.purchase_id, 15000));
const freightRows = owner(`SELECT count(*) FROM supplier_ledger WHERE movement_type = 'FREIGHT';`);
const supQW = supplierBal(SUP_Q);
const rW1 = rpc(rectifyCall(pW.purchase_id, 120000, 120000, [line()]));
check('W1 the allocation follows the new version (same allocation id, amount unchanged)',
  owner(`SELECT id || '|' || purchase_id || '|' || allocated_amount FROM freight_allocation WHERE freight_id = '${fW.freight_id}';`) === `${aW.allocation_id}|${rW1.new_purchase_id}|15000.00`);
check('W2 no extra FREIGHT ledger row, freight supplier debt unchanged',
  owner(`SELECT count(*) FROM supplier_ledger WHERE movement_type = 'FREIGHT';`) === freightRows && supplierBal(SUP_Q) === supQW);
check('W3 landed cost follows the current version: 120000 + 15000 = 135000.00', landed(rW1.new_purchase_id) === '135000.00');
check('W4 the retired version carries no allocation (nothing double counted)', owner(`SELECT count(*) FROM freight_allocation WHERE purchase_id = '${pW.purchase_id}';`) === '0');
const rW2 = rpc(rectifyCall(rW1.new_purchase_id, 90000, 90000, [line()]));
check('W5 repeated rectification: allocation follows again; landed 105000.00; supplier W nets 90000.00',
  owner(`SELECT purchase_id FROM freight_allocation WHERE id = '${aW.allocation_id}';`) === rW2.new_purchase_id
  && landed(rW2.new_purchase_id) === '105000.00' && supplierBal(SUP_W) === '90000.00');

// ═══════════════════════════════════════════════════════════════════════════
section('X', 'Closed freight period');

const fX = freight({ amount: 800, date: '2026-03-05' });
const pX = purchase({ sup: SUP_W, date: '2026-04-20' });
closePeriod('2026-03-01');
snap = snapshot();
r = ADMIN(`SELECT ${assignCall(fX.freight_id, pX.purchase_id, 500)};`);
check('X1 freight economic_date CLOSED → allocation PERIOD_CLOSED even though the purchase date is OPEN; nothing written',
  raised(r, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
openPeriod('2026-03-01');

// ═══════════════════════════════════════════════════════════════════════════
section('Y', 'Security');

const operCalls = [
  purchaseCall({ sup: SUP_B, key: uniq('K') }), rectifyCall(pS1.purchase_id, 1, 1, [line()]),
  payCall(SUP_L, 1, BANK, uniq('PAY')), freightCall({ key: uniq('F') }), assignCall(fT.freight_id, pS2.purchase_id, 1),
];
check('Y1 OPERATOR gets FORBIDDEN from all five RPCs', operCalls.map((c) => raised(OPER(`SELECT ${c};`), 'FORBIDDEN')).every(Boolean));
for (const t of [...TABLES, 'supplier_ledger', 'suppliers']) {
  r = OPER(`SELECT count(*) FROM ${t};`);
  check(`Y2 OPERATOR reads 0 rows of ${t}`, r.ok && r.out === '0', r.out || firstErr(r));
}
check('Y3 inactive / missing profile → USER_NOT_FOUND_OR_INACTIVE',
  [INACTIVE_UID, NOPROFILE_UID].every((u) => raised(asUser(u, `SELECT ${payCall(SUP_L, 1, BANK, uniq('PAY'))};`), 'USER_NOT_FOUND_OR_INACTIVE')));
check('Y4 anon: no EXECUTE on any RPC and no SELECT on any table',
  [...operCalls.map((c) => asAnon(`SELECT ${c};`)), ...TABLES.map((t) => asAnon(`SELECT count(*) FROM ${t};`))].every(denied));
check('Y5 service_role: no EXECUTE and no table access (frozen spec grants none here)',
  [...operCalls.map((c) => asServiceRole(`SELECT ${c};`)), ...TABLES.map((t) => asServiceRole(`SELECT count(*) FROM ${t};`))].every(denied));
snap = snapshot();
const direct = [
  ADMIN(`INSERT INTO purchase_line (purchase_id, descripcion, cantidad, unit_type, precio_unitario) VALUES ('${pS1.purchase_id}', 'x', 1, 'KG', 1);`),
  ADMIN(`UPDATE purchases SET amount_total = 1 WHERE id = '${pS1.purchase_id}';`),
  ADMIN(`DELETE FROM purchases WHERE id = '${pS1.purchase_id}';`),
  ADMIN(`TRUNCATE purchases CASCADE;`),
  ADMIN(`INSERT INTO freight (economic_date, amount, expense_category_id, idempotency_key) VALUES ('2026-04-10', 1, '${CAT}', 'x');`),
  ADMIN(`UPDATE freight SET amount = 1;`),
  ADMIN(`INSERT INTO freight_allocation (freight_id, purchase_id, allocated_amount) VALUES ('${fT.freight_id}', '${pS2.purchase_id}', 1);`),
  ADMIN(`UPDATE freight_allocation SET allocated_amount = 1;`),
  ADMIN(`DELETE FROM freight_allocation;`),
  ADMIN(`INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date) VALUES ('${SUP_L}', 'PAYMENT', -1000000, '2026-04-10');`),
  ADMIN(`UPDATE supplier_ledger SET signed_amount = 1;`),
  ADMIN(`DELETE FROM purchase_attachment;`),
  ADMIN(`TRUNCATE purchase_attachment;`),
];
check('Y6 even ADMIN: no direct INSERT / UPDATE / DELETE / TRUNCATE on facts (attachment DELETE included)',
  direct.every(denied) && snapshot() === snap, direct.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
const attAdd = ADMIN(`INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size)
  VALUES ('${pS1.purchase_id}', 'purchases/extra-${pS1.purchase_id}.pdf', 'extra.pdf', 'application/pdf', 10);`);
check('Y7 frozen exception: ADMIN may ADD an attachment to an existing purchase', attAdd.ok, firstErr(attAdd));
r = OPER(`INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type) VALUES ('${pS1.purchase_id}', 'op.pdf', 'op.pdf', 'application/pdf');`);
check('Y8 OPERATOR cannot add an attachment (RLS)', !r.ok && /row-level security/i.test(r.err), firstErr(r));
r = ADMIN(`WITH u AS (UPDATE purchase_attachment SET file_name = 'x' WHERE purchase_id = '${pS1.purchase_id}' RETURNING 1) SELECT count(*) FROM u;`);
check('Y9 attachments cannot be updated (UPDATE granted by the frozen list, no UPDATE policy → 0 rows)', r.ok && r.out === '0', r.out || firstErr(r));
const acl = owner(`SELECT string_agg(relname || '=' || relacl::TEXT, ' ' ORDER BY relname) FROM pg_class WHERE relname IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('Y10 exact ACLs: authenticated SELECT only, plus INSERT/UPDATE on purchase_attachment',
  acl === 'freight={postgres=arwdDxtm/postgres,authenticated=r/postgres} freight_allocation={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'purchase_attachment={postgres=arwdDxtm/postgres,authenticated=arw/postgres} purchase_line={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'purchases={postgres=arwdDxtm/postgres,authenticated=r/postgres}', acl);
const pols = owner(`SELECT string_agg(tablename || ':' || policyname || ':' || cmd, ',' ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('Y11 policies exactly as frozen (ADMIN SELECT ×5, ADMIN INSERT on attachments), none for OPERATOR, no DELETE',
  pols === 'freight:freight_admin_select:SELECT,freight_allocation:freight_allocation_admin_select:SELECT,'
  + 'purchase_attachment:purchase_attachment_admin_insert:INSERT,purchase_attachment:purchase_attachment_admin_select:SELECT,'
  + 'purchase_line:purchase_line_admin_select:SELECT,purchases:purchases_admin_select:SELECT', pols);

// ═══════════════════════════════════════════════════════════════════════════
section('Z', 'SECURITY DEFINER');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
// Exact inventory: previous 16 + RPCs 13–17 = 21, + built later phases (Phase 18: RPCs 18–22) = 26.
check('Z1 SECURITY DEFINER inventory = previous 16 + RPCs 13–17 + built later-phase RPCs', definers === ALL_DEFINERS, definers);
const hard = owner(`SELECT string_agg(proname || ':' || prosecdef || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || ':' ||
  pg_get_userbyid(proowner) || ':' || (proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)) || ':' ||
  has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' ||
  has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname) FROM pg_proc WHERE proname IN (${RPCS.map((p) => `'${p}'`).join(',')});`);
check('Z2 RPCs 13–17: DEFINER, search_path=public, owner postgres, no PUBLIC, anon no, authenticated yes, service_role no',
  hard === RPCS.map((p) => `${p}:true:true:postgres:true:false:true:false`).join(','), hard);
const actorArgs = owner(`SELECT coalesce(string_agg(proname, ','), '') FROM pg_proc WHERE proname IN (${RPCS.map((p) => `'${p}'`).join(',')})
  AND EXISTS (SELECT 1 FROM unnest(proargnames) a WHERE a ~* '(user|actor|role|performed|created_by|uid|uploaded_by|allocated_by)');`);
check('Z3 no parameter can name the actor or the role', actorArgs === '', actorArgs);

// ═══════════════════════════════════════════════════════════════════════════
section('AA', 'Concurrency (independent PostgreSQL sessions)');

const SUP_AA = mkSupplier('Proveedor AA');
const kAA = uniq('K');
x = await race(purchaseCall({ sup: SUP_AA, key: kAA, total: 1000, net: 1000 }), purchaseCall({ sup: SUP_AA, key: kAA, total: 1000, net: 1000 }), 'p17-key');
check('AA1 concurrent registrations with the same idempotency_key: B waited, then DUPLICATE_PURCHASE; one purchase, one debt',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_PURCHASE')
  && owner(`SELECT count(*) FROM purchases WHERE idempotency_key = '${kAA}';`) === '1' && supplierBal(SUP_AA) === '1000.00', firstErr(x.rb));
x = await race(purchaseCall({ sup: SUP_AA, key: uniq('K'), invoice: 'AA-1' }), purchaseCall({ sup: SUP_AA, key: uniq('K'), invoice: 'AA-1' }), 'p17-inv');
check('AA2 concurrent registrations with the same supplier invoice: B waited, then DUPLICATE_SUPPLIER_INVOICE',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_SUPPLIER_INVOICE')
  && owner(`SELECT count(*) FROM purchases WHERE supplier_id = '${SUP_AA}' AND supplier_invoice_number = 'AA-1';`) === '1', firstErr(x.rb));
const fAA = freight({ amount: 100 });
const pAA1 = purchase({ sup: SUP_AA });
const pAA2 = purchase({ sup: SUP_AA });
x = await race(assignCall(fAA.freight_id, pAA1.purchase_id, 70), assignCall(fAA.freight_id, pAA2.purchase_id, 70), 'p17-alloc');
check('AA3 over-allocation race: B waited on the freight row lock, recomputed `already`, then OVER_ALLOCATION; SUM = 70 ≤ 100',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'OVER_ALLOCATION')
  && owner(`SELECT SUM(allocated_amount) FROM freight_allocation WHERE freight_id = '${fAA.freight_id}';`) === '70.00', firstErr(x.rb));
const pAA3 = purchase({ sup: SUP_AA, total: 5000, net: 5000, invoice: 'AA-2' });
x = await race(rectifyCall(pAA3.purchase_id, 6000, 6000, [line()]), rectifyCall(pAA3.purchase_id, 7000, 7000, [line()]), 'p17-rect');
const chainAA = owner(`SELECT count(*) FILTER (WHERE is_current) || '|' || max(version_seq) FROM purchases WHERE supplier_id = '${SUP_AA}' AND supplier_invoice_number = 'AA-2';`);
check('AA4 conflicting rectifications of the same current purchase: B waited, then PURCHASE_SUPERSEDED; one current, version 1 only',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'PURCHASE_SUPERSEDED') && chainAA === '1|1', `${firstErr(x.rb)} / ${chainAA}`);
const pAA4 = purchase({ sup: SUP_AA, total: 3000, net: 3000 });
const fAA2 = freight({ amount: 500 });
x = await race(rectifyCall(pAA4.purchase_id, 3500, 3500, [line()]), assignCall(fAA2.freight_id, pAA4.purchase_id, 100), 'p17-rva');
check('AA5 rectify vs allocate on the same purchase: the allocation waits, then PURCHASE_SUPERSEDED (never attached to a retired version)',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'PURCHASE_SUPERSEDED')
  && owner(`SELECT count(*) FROM freight_allocation WHERE freight_id = '${fAA2.freight_id}';`) === '0', firstErr(x.rb));
const refAA = uniq('PAY');
x = await race(payCall(SUP_AA, 100, BANK, refAA), payCall(SUP_AA, 100, BANK, refAA), 'p17-pay');
check('AA6 concurrent payments with the same external_ref: B waited, then DUPLICATE_PAYMENT; one operation',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_PAYMENT') && owner(`SELECT count(*) FROM financial_operation WHERE external_ref = '${refAA}';`) === '1', firstErr(x.rb));
const kFAA = uniq('F');
x = await race(freightCall({ key: kFAA }), freightCall({ key: kFAA }), 'p17-frt');
check('AA7 concurrent freight registrations with the same key: B waited, then DUPLICATE_FREIGHT; one freight',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_FREIGHT') && owner(`SELECT count(*) FROM freight WHERE idempotency_key = '${kFAA}';`) === '1', firstErr(x.rb));

// ═══════════════════════════════════════════════════════════════════════════
section('BB', 'Phase 16 integration — one global supplier ledger');

const SUP_M = mkSupplier('Proveedor mixto');
purchase({ sup: SUP_M, total: 100000, net: 100000 });
rpc(payCall(SUP_M, 30000, BANK, uniq('PAY')));
const issM = rpc(`issue_supplier_instrument('${SUP_M}', 'ECHEQ', '1', 20000, '2026-12-31', '2026-04-18', '${BANK}', '${uniq('X')}', 'eCheq')`);
rpc(`reject_supplier_instrument('${issM.instrument_id}', '2026-04-22', 'rechazado')`);
freight({ sup: SUP_M, amount: 10000 });
check('BB1 mixed history in ONE ledger: PURCHASE +100000, PAYMENT -30000, INSTRUMENT_ISSUED -20000, INSTRUMENT_REJECTED +20000, FREIGHT +10000',
  ledgerOf(SUP_M) === 'PURCHASE:100000.00,PAYMENT:-30000.00,INSTRUMENT_ISSUED:-20000.00,INSTRUMENT_REJECTED:20000.00,FREIGHT:10000.00', ledgerOf(SUP_M));
check('BB2 derived balance = signed SUM = 80000.00 (no domain-specific balance)', supplierBal(SUP_M) === '80000.00');

// ═══════════════════════════════════════════════════════════════════════════
section('E2E', 'Slice 2 end to end');

const A = mkSupplier('E2E Proveedor A');
const B = mkSupplier('E2E Transporte B');
const BNA = mkAccount('E2E BNA');
check('E1 Supplier A opening balance 0.00', supplierBal(A) === '0.00');
const eP = purchase({ sup: A, total: 100000, net: 82644.63, date: '2026-05-04' });
check('E2 register purchase 100000: Supplier A debt 100000.00, bank unchanged', supplierBal(A) === '100000.00' && acctBal(BNA) === '0.00');
rpc(payCall(A, 40000, BNA, uniq('PAY'), '2026-05-06'));
check('E3 pay 40000: Supplier A debt 60000.00, BNA -40000.00', supplierBal(A) === '60000.00' && acctBal(BNA) === '-40000.00');
const eF = freight({ sup: B, amount: 15000, date: '2026-05-05' });
check('E4 register freight 15000 with Supplier B: B debt 15000.00, bank unchanged', supplierBal(B) === '15000.00' && acctBal(BNA) === '-40000.00');
rpc(assignCall(eF.freight_id, eP.purchase_id, 15000));
check('E5 allocate freight to the purchase: A 60000.00, B 15000.00, bank unchanged, landed cost 115000.00',
  supplierBal(A) === '60000.00' && supplierBal(B) === '15000.00' && acctBal(BNA) === '-40000.00' && landed(eP.purchase_id) === '115000.00');
rpc(payCall(A, 60000, BNA, uniq('PAY'), '2026-05-20'));
check('E6 pay remaining 60000: Supplier A 0.00, BNA -100000.00', supplierBal(A) === '0.00' && acctBal(BNA) === '-100000.00');
check('E7 no invoice allocation exists: payments reference the supplier, never the purchase',
  owner(`SELECT count(*) FROM financial_operation WHERE operation_type = 'SUPPLIER_PAYMENT' AND source_entity_id = '${A}';`) === '2'
  && owner(`SELECT count(*) FROM financial_operation WHERE source_entity_type = 'purchases';`) === '0');

const C = mkSupplier('E2E Proveedor C');
const eP2 = purchase({ sup: C, total: 100000, net: 100000, invoice: 'C-1', date: '2026-05-08' });
const eF2 = freight({ sup: B, amount: 15000, date: '2026-05-08' });
rpc(assignCall(eF2.freight_id, eP2.purchase_id, 15000));
const freightB = supplierBal(B);
const eR = rpc(rectifyCall(eP2.purchase_id, 120000, 120000, [line()], 'precio final'));
check('E8 rectification 100000 → 120000: supplier purchase liability nets to 120000.00', supplierBal(C) === '120000.00');
check('E9 freight debt unchanged, no duplicated freight expense', supplierBal(B) === freightB
  && owner(`SELECT count(*) FROM supplier_ledger WHERE source_entity_type = 'freight' AND source_entity_id = '${eF2.freight_id}';`) === '1');
check('E10 allocation follows the current purchase; landed cost 135000.00',
  owner(`SELECT purchase_id FROM freight_allocation WHERE freight_id = '${eF2.freight_id}';`) === eR.new_purchase_id && landed(eR.new_purchase_id) === '135000.00');
} finally {
  cleanup();
}

section('ZZ', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM suppliers WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM financial_account WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM expense_category WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'p17_harness')
  + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p17_fail_%') + (SELECT count(*) FROM freight WHERE idempotency_key LIKE '${TAG}%');`);
check('ZZ1 all P17-TEST fixtures, harness schema and triggers removed', left === '0', left);
const closedLeft = owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
check('ZZ2 periods closed by the suite are OPEN again', closedLeft === '0', closedLeft);

console.log(`\n  ══ PURCHASES RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);

function f2(v) { return Number(v).toFixed(2); }
