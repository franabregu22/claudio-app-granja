#!/usr/bin/env node
/**
 * PHASE 22 — FISCAL TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Behavioural tests of RPCs 34–36 (register_fiscal_document,
 * register_fiscal_obligation, pay_fiscal_obligation) over fiscal_document,
 * fiscal_document_component, fiscal_obligation, fiscal_obligation_installment
 * and fiscal_payment, plus the frozen purchases/freight → fiscal_document FKs.
 *
 * The fiscal layer never duplicates an economic operation: documents and
 * obligations create no ledger row, no operation and no posting; only a fiscal
 * payment moves money (one FISCAL_PAYMENT operation + one −amount posting).
 *
 * Role-scoped calls simulate real Supabase sessions (OPERATOR, ADMIN).
 * Failure injection uses test-only triggers in schema p22_harness (dropped at
 * the end). The concurrency group runs independent PostgreSQL sessions.
 *
 * Fixtures: suppliers, clients and the expense category are named
 * "P22-TEST …"; payment idempotency keys start with "P22-TEST:". Fiscal
 * obligations are identified by the test ADMIN as creator (only this suite
 * writes the fiscal tables).
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fiscal.test.mjs
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
const INACTIVE_UID = '33333333-3333-3333-3333-333333333333';
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'P22-TEST';
const KEY_PREFIX = `${TAG}:`;
const TABLES = ['fiscal_document', 'fiscal_document_component', 'fiscal_obligation', 'fiscal_obligation_installment', 'fiscal_payment'];
const FISCAL_RPCS = ['pay_fiscal_obligation', 'register_fiscal_document', 'register_fiscal_obligation'];
const ALL_DEFINERS = 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,'
  + 'close_flock,close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_apply_transition,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_report_fallback,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,open_sales_session,pay_fiscal_obligation,pay_supplier,publish_feed_formula_version,receive_cheque,'
  + 'rectify_classification,rectify_daily_production,rectify_delivered_order,rectify_feed_manufacturing,rectify_mortality,rectify_purchase,register_bank_tax,register_classification,register_collection,'
  + 'register_count_adjustment,register_daily_production,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,'
  + 'register_fiscal_document,register_fiscal_obligation,register_flock,'
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
async function race(sqlA, sqlB, appPrefix, expectWait = true) {
  const pA = session(sessionSql('authenticated', claimsOf(ADMIN_UID), `${sqlA}\nSELECT pg_sleep(2);`), `${appPrefix}-A`);
  const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-A'
    AND state = 'active' AND query LIKE '%pg_sleep%');`);
  const pB = session(sessionSql('authenticated', claimsOf(ADMIN_UID), sqlB), `${appPrefix}-B`);
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
const TSUP = `(SELECT id FROM suppliers WHERE nombre LIKE '${TAG}%')`;
const TCLI = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
const TDOC = `(SELECT id FROM fiscal_document WHERE supplier_id IN ${TSUP} OR cliente_id IN ${TCLI})`;
const TOBL = `(SELECT id FROM fiscal_obligation WHERE created_by = '${ADMIN_UID}')`;
function cleanup() {
  owner(`
DROP SCHEMA IF EXISTS p22_harness CASCADE;
CREATE TEMP TABLE _p AS SELECT id FROM purchases WHERE supplier_id IN ${TSUP};
CREATE TEMP TABLE _f AS SELECT id FROM freight WHERE supplier_id IN ${TSUP};
CREATE TEMP TABLE _o AS SELECT id FROM financial_operation WHERE source_entity_type = 'fiscal_obligation'
  AND source_entity_id IN (SELECT id::TEXT FROM ${TOBL} ob);
DELETE FROM audit_events WHERE entity_type = 'purchases' AND entity_id IN (SELECT id::TEXT FROM _p);
DELETE FROM audit_events WHERE entity_type = 'freight' AND entity_id IN (SELECT id::TEXT FROM _f);
DELETE FROM supplier_ledger WHERE supplier_id IN ${TSUP};
DELETE FROM purchase_attachment WHERE purchase_id IN (SELECT id FROM _p);
DELETE FROM purchase_line WHERE purchase_id IN (SELECT id FROM _p);
DELETE FROM purchases WHERE id IN (SELECT id FROM _p);
DELETE FROM freight WHERE id IN (SELECT id FROM _f);
DELETE FROM audit_events WHERE entity_type = 'fiscal_obligation' AND entity_id IN (SELECT id::TEXT FROM ${TOBL} ob);
DELETE FROM fiscal_payment WHERE fiscal_obligation_id IN ${TOBL};
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _o);
DELETE FROM fiscal_obligation_installment WHERE fiscal_obligation_id IN ${TOBL};
DELETE FROM fiscal_obligation WHERE id IN ${TOBL};
DELETE FROM audit_events WHERE entity_type = 'fiscal_document' AND entity_id IN (SELECT id::TEXT FROM ${TDOC} d);
DELETE FROM fiscal_document_component WHERE fiscal_document_id IN ${TDOC};
DELETE FROM fiscal_document WHERE id IN ${TDOC};
DELETE FROM expense_category WHERE nombre LIKE '${TAG}%';
DELETE FROM suppliers WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
UPDATE management_period SET status = 'OPEN', closed_at = NULL
 WHERE periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
}

cleanup();   // first: remove leftovers of an earlier run
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES
  ('${ADMIN_UID}', false, false), ('${OPA}', false, false), ('${INACTIVE_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true),
  ('${OPA}', 'operator@test.local', 'OPERATOR', true),
  ('${INACTIVE_UID}', 'inactive@test.local', 'OPERATOR', false)
ON CONFLICT (id) DO NOTHING;`);

// ── helpers ────────────────────────────────────────────────────────────────
let keySeq = 0;
const newKey = () => `${KEY_PREFIX}${String(++keySeq).padStart(4, '0')}`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${v}'`);
const n = (v) => (v === null || v === undefined ? 'NULL' : String(v));
const j = (v) => (v === null || v === undefined ? 'NULL' : `'${JSON.stringify(v)}'::jsonb`);
const C = (tax, dir, base, rate, amount) => ({ tax_kind: tax, direction: dir, base_amount: base, rate_applied: rate, tax_amount: amount });

const docCall = (o) => {
  const x = { type: 'INVOICE_A', dir: 'CREDITO', date: '2026-05-05', period: '2026-05-01', net: 1000, total: 1210,
    comps: [C('IVA', 'CREDITO', 1000, 21, 210)], sup: null, cli: null, num: null, reason: null, ...o };
  return `register_fiscal_document(${q(x.type)}, ${q(x.dir)}, ${q(x.date)}, ${q(x.period)}, ${n(x.net)}, ${n(x.total)}, ${j(x.comps)}, `
    + `${q(x.sup)}, ${q(x.cli)}, ${q(x.num)}, ${q(x.reason)})`;
};
const oblCall = (tax, period, amount, due = null, inst = null, reason = null) =>
  `register_fiscal_obligation(${q(tax)}, ${q(period)}, ${n(amount)}, ${q(due)}, ${j(inst)}, ${q(reason)})`;
const payCall = (ob, date, amount, acct, key, inst = null, reason = null) =>
  `pay_fiscal_obligation(${q(ob)}, ${q(date)}, ${n(amount)}, ${q(acct)}, ${q(key)}, ${q(inst)}, ${q(reason)})`;
const I = (num, amount, due) => ({ installment_number: num, amount, due_date: due });

const snapshot = () => owner(`SELECT concat_ws('|', ${TABLES.map((t) => `(SELECT count(*) FROM ${t})`).join(', ')},
  (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting), (SELECT count(*) FROM audit_events));`);
const econ = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM purchases), (SELECT count(*) FROM freight), (SELECT count(*) FROM pedidos),
  (SELECT count(*) FROM supplier_ledger), (SELECT count(*) FROM client_ledger), (SELECT count(*) FROM collections),
  (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT coalesce(SUM(signed_amount), 0) FROM supplier_ledger), (SELECT coalesce(SUM(signed_amount), 0) FROM client_ledger));`);
const balance = (acc) => owner(`SELECT coalesce(SUM(signed_amount), 0) FROM financial_posting WHERE financial_account_id = '${acc}';`);
const status = (ob) => owner(`SELECT status FROM fiscal_obligation WHERE id = '${ob}';`);
const paidOf = (ob) => owner(`SELECT coalesce(SUM(amount), 0) FROM fiscal_payment WHERE fiscal_obligation_id = '${ob}';`);
const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);
const visible = (fn, t, where) => { const x2 = fn(`SELECT count(*) FROM ${t} WHERE ${where};`); return x2.ok ? x2.out : `ERR ${firstErr(x2)}`; };

let r;
let snap;
let x;

try {
// ── fixtures (ADMIN master path) ───────────────────────────────────────────
const SUP = okAs(ADMIN, `INSERT INTO suppliers (nombre) VALUES ('${TAG} Proveedor maíz') RETURNING id;`);
const SUP2 = okAs(ADMIN, `INSERT INTO suppliers (nombre) VALUES ('${TAG} Proveedor soja') RETURNING id;`);
const CLI = okAs(ADMIN, `INSERT INTO clients (nombre) VALUES ('${TAG} Cliente mayorista') RETURNING id;`);
const CAT = okAs(ADMIN, `INSERT INTO expense_category (nombre, pnl_cost_class) VALUES ('${TAG} Insumos', 'DIRECT') RETURNING id;`);
const BNA = owner(`SELECT id FROM financial_account WHERE nombre = 'BNA';`);
const CAJA = owner(`SELECT id FROM financial_account WHERE nombre = 'Caja chica';`);
const purchaseCall = (key, fiscal = null, invoice = null) => `register_purchase('${SUP}', '2026-05-04', 100000, 121000, '${CAT}', NULL, 'OPERATING', `
  + `'[{"descripcion":"Maíz","cantidad":10,"unit_type":"TON","precio_unitario":10000}]'::jsonb, `
  + `'[{"storage_path":"purchases/${key}.pdf","file_name":"${key}.pdf","content_type":"application/pdf","byte_size":1000}]'::jsonb, `
  + `'${key}', NULL, ${q(fiscal)}, ${q(invoice)}, NULL, 'compra')`;

// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure');

const colsOf = (t) => owner(`SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = '${t}';`);
check('A1 the five fiscal tables exist', owner(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN (${TABLES.map((t) => `'${t}'`).join(',')});`) === TABLES.join(','));
const wantCols = {
  fiscal_document: 'id:uuid,document_type:USER-DEFINED,direction:USER-DEFINED,document_date:date,fiscal_period:date,supplier_id:uuid,cliente_id:uuid,'
    + 'external_number:character varying,net_amount:numeric,total_amount:numeric,created_at:timestamp with time zone,created_by:uuid',
  fiscal_document_component: 'id:uuid,fiscal_document_id:uuid,tax_kind:USER-DEFINED,direction:USER-DEFINED,base_amount:numeric,rate_applied:numeric,'
    + 'tax_amount:numeric,created_at:timestamp with time zone',
  fiscal_obligation: 'id:uuid,tax_kind:USER-DEFINED,fiscal_period:date,amount:numeric,due_date:date,status:USER-DEFINED,created_at:timestamp with time zone,created_by:uuid',
  fiscal_obligation_installment: 'id:uuid,fiscal_obligation_id:uuid,installment_number:integer,amount:numeric,due_date:date,created_at:timestamp with time zone',
  fiscal_payment: 'id:uuid,fiscal_obligation_id:uuid,installment_id:uuid,effective_date:date,amount:numeric,financial_account_id:uuid,'
    + 'financial_operation_id:bigint,idempotency_key:character varying,created_at:timestamp with time zone,created_by:uuid',
};
const badCols = Object.entries(wantCols).filter(([t, c]) => colsOf(t) !== c).map(([t]) => `${t}=${colsOf(t)}`);
check('A2 columns of all five tables exactly as frozen Domain K', badCols.length === 0, badCols.join(' ; '));
const cons = owner(`SELECT string_agg(conrelid::regclass || '.' || conname || ':' || contype::TEXT, ',' ORDER BY conrelid::regclass::TEXT, conname) FROM pg_constraint
  WHERE conrelid IN (${TABLES.map((t) => `'${t}'::regclass`).join(',')}) AND contype IN ('u','c');`);
check('A3 UNIQUE / CHECK constraints exactly as frozen (month start, counterparty, amounts, rates, installment number, idempotency)',
  cons === 'fiscal_document.chk_fiscal_counterparty:c,fiscal_document.chk_fiscal_period_month_start:c,'
  + 'fiscal_document.fiscal_document_net_amount_check:c,fiscal_document.fiscal_document_total_amount_check:c,'
  + 'fiscal_document_component.fiscal_document_component_base_amount_check:c,fiscal_document_component.fiscal_document_component_rate_applied_check:c,'
  + 'fiscal_document_component.fiscal_document_component_tax_amount_check:c,'
  + 'fiscal_obligation.chk_obligation_period_month_start:c,fiscal_obligation.fiscal_obligation_amount_check:c,'
  + 'fiscal_obligation.fiscal_obligation_tax_kind_fiscal_period_key:u,'
  + 'fiscal_obligation_installment.fiscal_obligation_installment_amount_check:c,'
  + 'fiscal_obligation_installment.fiscal_obligation_installment_fiscal_obligation_id_installm_key:u,'
  + 'fiscal_obligation_installment.fiscal_obligation_installment_installment_number_check:c,'
  + 'fiscal_payment.fiscal_payment_amount_check:c,fiscal_payment.fiscal_payment_idempotency_key_key:u', cons);
const fks = owner(`SELECT string_agg(x, ',' ORDER BY x) FROM (
  SELECT c.conrelid::regclass || '.' || a.attname || '>' || c.confrelid::regclass || ':' || c.confdeltype::TEXT AS x
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.conrelid IN (${TABLES.map((t) => `'${t}'::regclass`).join(',')})) s;`);
check('A4 FKs exactly as frozen, all ON DELETE RESTRICT',
  fks === 'fiscal_document.cliente_id>clients:r,fiscal_document.created_by>perfiles:r,fiscal_document.supplier_id>suppliers:r,'
  + 'fiscal_document_component.fiscal_document_id>fiscal_document:r,fiscal_obligation.created_by>perfiles:r,'
  + 'fiscal_obligation_installment.fiscal_obligation_id>fiscal_obligation:r,'
  + 'fiscal_payment.created_by>perfiles:r,fiscal_payment.financial_account_id>financial_account:r,fiscal_payment.financial_operation_id>financial_operation:r,'
  + 'fiscal_payment.fiscal_obligation_id>fiscal_obligation:r,fiscal_payment.installment_id>fiscal_obligation_installment:r', fks);
const idx = owner(`SELECT string_agg(indexname || '=' || regexp_replace(indexdef, '^.* USING ', ''), ' ; ' ORDER BY indexname) FROM pg_indexes
  WHERE indexname IN ('idx_fiscal_document_supplier_number','idx_fiscal_document_period','idx_fiscal_component_document','idx_fiscal_payment_obligation');`);
check('A5 indexes: UNIQUE (supplier_id, external_number) partial; fiscal_period; components by document; payments by obligation',
  idx === 'idx_fiscal_component_document=btree (fiscal_document_id) ; idx_fiscal_document_period=btree (fiscal_period) ; '
  + 'idx_fiscal_document_supplier_number=btree (supplier_id, external_number) WHERE ((supplier_id IS NOT NULL) AND (external_number IS NOT NULL)) ; '
  + 'idx_fiscal_payment_obligation=btree (fiscal_obligation_id)'
  && owner(`SELECT indexdef LIKE 'CREATE UNIQUE%' FROM pg_indexes WHERE indexname = 'idx_fiscal_document_supplier_number';`) === 't', idx);
check('A6 RLS enabled on the five tables', owner(`SELECT count(*) FROM pg_class WHERE relname IN (${TABLES.map((t) => `'${t}'`).join(',')}) AND relrowsecurity;`) === '5');
const links = owner(`SELECT string_agg(conname || ':' || convalidated, ',' ORDER BY conname) FROM pg_constraint
  WHERE conname IN ('purchases_fiscal_document_id_fkey','freight_fiscal_document_id_fkey','chk_purchases_fiscal_document_fk_deferred','chk_freight_fiscal_document_fk_deferred');`);
check('A7 deferred links resolved at their scheduled point: purchases / freight → fiscal_document FKs exist and are validated; the 0019 stand-ins are gone',
  links === 'freight_fiscal_document_id_fkey:true,purchases_fiscal_document_id_fkey:true', links);
check('A8 no tax-rate master and no rate constant table: rates live only as component snapshots',
  owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(rate|alicuota|tasa|tax_rule|impuesto)';`) === '0'
  && owner(`SELECT string_agg(table_name || '.' || column_name, ',') FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* 'rate';`)
  === 'fiscal_document_component.rate_applied');
check('A9 pedidos has NO fiscal_document_id column in the frozen schema (see §36 of the evidence: Pedido link not built)',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'pedidos' AND column_name = 'fiscal_document_id';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Fiscal documents (RPC 34, ADMIN only)');

let econ0 = econ();
const b1 = rpc(docCall({ sup: SUP, num: 'A-0001-00000123', comps: [C('IVA', 'CREDITO', 100000, 21, 21000), C('PERCEPTION', 'CREDITO', 100000, 3, 3000)],
  net: 100000, total: 124000, reason: 'factura proveedor' }));
check('B1 CREDITO document with two components → {fiscal_document_id, component_count 2}; row exact',
  !!b1.fiscal_document_id && b1.component_count === 2 && Object.keys(b1).length === 2
  && owner(`SELECT document_type || '|' || direction || '|' || document_date || '|' || fiscal_period || '|' || supplier_id || '|' || coalesce(cliente_id::TEXT, '-')
     || '|' || external_number || '|' || net_amount || '|' || total_amount || '|' || created_by FROM fiscal_document WHERE id = '${b1.fiscal_document_id}';`)
  === `INVOICE_A|CREDITO|2026-05-05|2026-05-01|${SUP}|-|A-0001-00000123|100000.00|124000.00|${ADMIN_UID}`);
const b2 = rpc(docCall({ type: 'INVOICE_B', dir: 'DEBITO', cli: CLI, num: 'B-0002-00000001', comps: [C('IVA', 'DEBITO', 50000, 21, 10500)], net: 50000, total: 60500 }));
check('B2 DEBITO document for an existing client', owner(`SELECT direction || '|' || cliente_id FROM fiscal_document WHERE id = '${b2.fiscal_document_id}';`) === `DEBITO|${CLI}`);
check('B3 registering documents created no ledger row, operation, posting, purchase, Pedido or collection', econ() === econ0);
snap = snapshot();
r = A(`SELECT ${docCall({ sup: SUP })};`);
const rIn = asUser(INACTIVE_UID, `SELECT ${docCall({ sup: SUP })};`);
check('B4 OPERATOR → FORBIDDEN; inactive profile → USER_NOT_FOUND_OR_INACTIVE', raised(r, 'FORBIDDEN') && raised(rIn, 'USER_NOT_FOUND_OR_INACTIVE'), firstErr(r));
for (const [what, call, code] of [
  ['CREDITO without supplier', docCall({}), 'SUPPLIER_REQUIRED'],
  ['DEBITO without client', docCall({ dir: 'DEBITO' }), 'CLIENT_REQUIRED'],
  ['fiscal_period not a month start (2026-05-15)', docCall({ sup: SUP, period: '2026-05-15' }), 'INVALID_FISCAL_PERIOD'],
  ['NULL fiscal_period', docCall({ sup: SUP, period: null }), 'INVALID_FISCAL_PERIOD'],
  ['NULL document_date', docCall({ sup: SUP, date: null }), 'BUSINESS_DATE_REQUIRED'],
  ['same supplier + same external_number', docCall({ sup: SUP, num: 'A-0001-00000123' }), 'DUPLICATE_FISCAL_DOCUMENT'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`B5 ${what} → ${code}`, raised(r, code), firstErr(r));
}
r = ADMIN(`SELECT ${docCall({ sup: SUP, net: -1 })};`);
check('B6 negative net amount → rejected by the frozen CHECK', violates(r, 'fiscal_document_net_amount_check'), firstErr(r));
r = ADMIN(`SELECT ${docCall({ sup: MISSING_UUID })};`);
check('B7 a nonexistent supplier is rejected (no master is created)', violates(r, 'fiscal_document_supplier_id_fkey'), firstErr(r));
check('B8 every rejection was atomic (no document, component or audit)', snapshot() === snap);
const b9 = rpc(docCall({ sup: SUP2, num: 'A-0001-00000123' }));
const b9b = rpc(docCall({ sup: SUP }));
const b9c = rpc(docCall({ sup: SUP }));
check('B9 duplicate rule is scoped: the same number for ANOTHER supplier is valid; documents without external_number never collide',
  !!b9.fiscal_document_id && !!b9b.fiscal_document_id && !!b9c.fiscal_document_id);
const b10 = rpc(docCall({ sup: SUP, date: '2026-05-03', period: '2026-04-01', num: 'A-0001-00000200' }));
check('B10 fiscal_period may differ from the document_date month and is stored exactly as supplied (2026-04-01 for a 2026-05-03 document)',
  owner(`SELECT document_date || '|' || fiscal_period FROM fiscal_document WHERE id = '${b10.fiscal_document_id}';`) === '2026-05-03|2026-04-01');
const b11 = rpc(docCall({ type: 'RECEIPT', sup: SUP, comps: [] }));
check('B11 no component count is invented: an empty component list is accepted (component_count 0)', b11.component_count === 0);
check('B12 audit CREATE: document_type, direction, fiscal_period, total_amount, reason, actor',
  owner(`SELECT action || '|' || (after_values->>'document_type') || '|' || (after_values->>'direction') || '|' || (after_values->>'fiscal_period') || '|'
         || (after_values->>'total_amount') || '|' || reason || '|' || performed_by FROM audit_events WHERE entity_type = 'fiscal_document' AND entity_id = '${b1.fiscal_document_id}';`)
  === `CREATE|INVOICE_A|CREDITO|2026-05-01|124000|factura proveedor|${ADMIN_UID}`);

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Components — rates are snapshots');

const comps = (d) => owner(`SELECT string_agg(tax_kind || ':' || direction || ':' || base_amount || ':' || rate_applied || ':' || tax_amount, ',' ORDER BY tax_kind::TEXT)
  FROM fiscal_document_component WHERE fiscal_document_id = '${d}';`);
check('C1 components stored exactly as supplied (several tax kinds per document)',
  comps(b1.fiscal_document_id) === 'IVA:CREDITO:100000.00:21.0000:21000.00,PERCEPTION:CREDITO:100000.00:3.0000:3000.00', comps(b1.fiscal_document_id));
const dA = rpc(docCall({ sup: SUP, num: 'A-0001-00000300', comps: [C('IVA', 'CREDITO', 10000, 10.5, 1050)], net: 10000, total: 11050 }));
const dB = rpc(docCall({ sup: SUP, num: 'A-0001-00000301', comps: [C('IVA', 'CREDITO', 10000, 21, 2100)], net: 10000, total: 12100 }));
check('C2 IVA 10.5000 (document A) and IVA 21.0000 (document B) coexist; neither is corrected to the other',
  comps(dA.fiscal_document_id) === 'IVA:CREDITO:10000.00:10.5000:1050.00' && comps(dB.fiscal_document_id) === 'IVA:CREDITO:10000.00:21.0000:2100.00');
const dC = rpc(docCall({ sup: SUP, num: 'A-0001-00000302', comps: [C('IVA', 'CREDITO', 1000, 21, 209.99)] }));
check('C3 tax_amount is the recorded value, not recomputed (1000 × 21% = 210 but 209.99 recorded stays 209.99)',
  comps(dC.fiscal_document_id) === 'IVA:CREDITO:1000.00:21.0000:209.99');
snap = snapshot();
for (const [what, comp, con] of [
  ['negative base_amount', C('IVA', 'CREDITO', -1, 21, 0), 'fiscal_document_component_base_amount_check'],
  ['negative rate_applied', C('IVA', 'CREDITO', 1, -21, 0), 'fiscal_document_component_rate_applied_check'],
  ['negative tax_amount', C('IVA', 'CREDITO', 1, 21, -1), 'fiscal_document_component_tax_amount_check'],
]) {
  r = ADMIN(`SELECT ${docCall({ sup: SUP, comps: [C('IVA', 'CREDITO', 100, 21, 21), comp] })};`);
  check(`C4 later component with ${what} → frozen CHECK; the whole document rolls back`, violates(r, con) && snapshot() === snap, firstErr(r));
}
r = ADMIN(`SELECT ${docCall({ sup: SUP, comps: [C('VAT', 'CREDITO', 1, 1, 1)] })};`);
check('C5 tax_kind outside the frozen enum is rejected', !r.ok && /invalid input value for enum tax_kind/.test(r.err) && snapshot() === snap, firstErr(r));
check('C6 historical snapshot kept exactly after later documents with other rates (document A still 10.5000)',
  comps(dA.fiscal_document_id) === 'IVA:CREDITO:10000.00:10.5000:1050.00');

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Obligations (RPC 35, ADMIN only)');

econ0 = econ();
const d1 = rpc(oblCall('IVA', '2026-04-01', 100000, '2026-05-20', null, 'IVA abril'));
check('D1 obligation registered PENDING → {obligation_id, installment_count 0}',
  !!d1.obligation_id && d1.installment_count === 0 && Object.keys(d1).length === 2
  && owner(`SELECT tax_kind || '|' || fiscal_period || '|' || amount || '|' || due_date || '|' || status || '|' || created_by FROM fiscal_obligation WHERE id = '${d1.obligation_id}';`)
  === `IVA|2026-04-01|100000.00|2026-05-20|PENDING|${ADMIN_UID}`);
check('D2 an obligation is a tax payable record only: no ledger, operation or posting', econ() === econ0);
snap = snapshot();
r = A(`SELECT ${oblCall('IIBB', '2026-04-01', 1)};`);
check('D3 OPERATOR → FORBIDDEN', raised(r, 'FORBIDDEN'), firstErr(r));
for (const [what, call, code] of [
  ['amount 0', oblCall('IIBB', '2026-04-01', 0), 'INVALID_AMOUNT'],
  ['negative amount', oblCall('IIBB', '2026-04-01', -1), 'INVALID_AMOUNT'],
  ['NULL amount', oblCall('IIBB', '2026-04-01', null), 'INVALID_AMOUNT'],
  ['fiscal_period 2026-04-15', oblCall('IIBB', '2026-04-15', 1), 'INVALID_FISCAL_PERIOD'],
  ['NULL fiscal_period', oblCall('IIBB', null, 1), 'INVALID_FISCAL_PERIOD'],
  ['same tax_kind + fiscal_period', oblCall('IVA', '2026-04-01', 5), 'DUPLICATE_OBLIGATION'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`D4 ${what} → ${code}`, raised(r, code), firstErr(r));
}
check('D5 every rejection was atomic', snapshot() === snap);
const d6 = rpc(oblCall('IIBB', '2026-04-01', 20000));
check('D6 the same period for another tax kind is a separate obligation', !!d6.obligation_id);
check('D7 audit CREATE: tax_kind, fiscal_period, amount, reason, actor',
  owner(`SELECT action || '|' || (after_values->>'tax_kind') || '|' || (after_values->>'fiscal_period') || '|' || (after_values->>'amount') || '|' || reason || '|' || performed_by
         FROM audit_events WHERE entity_type = 'fiscal_obligation' AND entity_id = '${d1.obligation_id}';`) === `CREATE|IVA|2026-04-01|100000|IVA abril|${ADMIN_UID}`);

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Installments (payment plan)');

econ0 = econ();
const e1 = rpc(oblCall('GANANCIAS', '2026-04-01', 90000, null, [I(1, 30000, '2026-05-10'), I(2, 30000, '2026-06-10'), I(3, 30000, '2026-07-10')]));
check('E1 three installments summing exactly to the obligation → installment_count 3, rows exact',
  e1.installment_count === 3 && owner(`SELECT string_agg(installment_number || ':' || amount || ':' || due_date, ',' ORDER BY installment_number)
    FROM fiscal_obligation_installment WHERE fiscal_obligation_id = '${e1.obligation_id}';`) === '1:30000.00:2026-05-10,2:30000.00:2026-06-10,3:30000.00:2026-07-10');
check('E2 installments create no posting, operation or other liability', econ() === econ0);
snap = snapshot();
for (const [what, inst, check2] of [
  ['sum ≠ amount (80000 vs 90000)', [I(1, 40000, '2026-05-10'), I(2, 40000, '2026-06-10')], (x2) => raised(x2, 'INSTALLMENT_MISMATCH')],
  ['empty installment list (sum 0)', [], (x2) => raised(x2, 'INSTALLMENT_MISMATCH')],
  ['duplicate installment_number', [I(1, 45000, '2026-05-10'), I(1, 45000, '2026-06-10')], (x2) => violates(x2, 'fiscal_obligation_installment_fiscal_obligation_id_installm_key')],
  ['installment amount 0', [I(1, 90000, '2026-05-10'), I(2, 0, '2026-06-10')], (x2) => violates(x2, 'fiscal_obligation_installment_amount_check')],
  ['installment_number 0', [I(0, 90000, '2026-05-10')], (x2) => violates(x2, 'fiscal_obligation_installment_installment_number_check')],
  ['missing due_date', [{ installment_number: 1, amount: 90000 }], (x2) => violates(x2, 'due_date')],
]) {
  r = ADMIN(`SELECT ${oblCall('RETENTION', '2026-04-01', 90000, null, inst)};`);
  check(`E3 ${what} → rejected; no obligation and no partial plan`, check2(r) && snapshot() === snap, firstErr(r));
}

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Payments (RPC 36, ADMIN only)');

const econF = econ().split('|');
const bna0 = Number(balance(BNA));
const P = d1.obligation_id;
const f1Key = newKey();
const f1 = rpc(payCall(P, '2026-05-15', 40000, BNA, f1Key, null, 'anticipo IVA'));
const opRow = (op) => owner(`SELECT o.operation_type || '|' || o.external_ref || '|' || o.source_entity_type || '|' || o.source_entity_id || '|' || o.effective_date || '|'
  || (SELECT string_agg(p.financial_account_id || ':' || p.signed_amount, ',') FROM financial_posting p WHERE p.financial_operation_id = o.id) FROM financial_operation o WHERE o.id = ${op};`);
check('F1 pay 40000 → {payment_id, financial_operation_id, obligation_status PARTIALLY_PAID}; one FISCAL_PAYMENT operation with ONE −40000 posting on BNA',
  f1.obligation_status === 'PARTIALLY_PAID' && Object.keys(f1).length === 3
  && opRow(f1.financial_operation_id) === `FISCAL_PAYMENT|${f1Key}|fiscal_obligation|${P}|2026-05-15|${BNA}:-40000.00`);
check('F2 the fiscal_payment row links obligation, account, operation, key and actor',
  owner(`SELECT fiscal_obligation_id || '|' || coalesce(installment_id::TEXT, '-') || '|' || effective_date || '|' || amount || '|' || financial_account_id || '|' || financial_operation_id
         || '|' || idempotency_key || '|' || created_by FROM fiscal_payment WHERE id = '${f1.payment_id}';`)
  === `${P}|-|2026-05-15|40000.00|${BNA}|${f1.financial_operation_id}|${f1Key}|${ADMIN_UID}`);
const f3 = rpc(payCall(P, '2026-05-20', 60000, BNA, newKey()));
check('F3 pay the remaining 60000 → PAID', f3.obligation_status === 'PAID' && status(P) === 'PAID' && paidOf(P) === '100000.00');
snap = snapshot();
r = ADMIN(`SELECT ${payCall(P, '2026-05-21', 1, BNA, newKey())};`);
check('F4 a third payment → ALREADY_PAID; nothing written', raised(r, 'ALREADY_PAID') && snapshot() === snap, firstErr(r));
const O2 = rpc(oblCall('IVA', '2026-05-01', 100000)).obligation_id;
rpc(payCall(O2, '2026-05-22', 70000, BNA, newKey()));
snap = snapshot();
r = ADMIN(`SELECT ${payCall(O2, '2026-05-22', 40000, BNA, newKey())};`);
check('F5 70000 then 40000 → OVERPAYMENT; nothing written; status stays PARTIALLY_PAID', raised(r, 'OVERPAYMENT') && snapshot() === snap && status(O2) === 'PARTIALLY_PAID', firstErr(r));
r = ADMIN(`SELECT ${payCall(O2, '2026-05-22', 1, BNA, f1Key)};`);
check('F6 sequential retry with an existing idempotency_key → DUPLICATE_PAYMENT; nothing written', raised(r, 'DUPLICATE_PAYMENT') && snapshot() === snap, firstErr(r));
const OC = rpc(oblCall('OTHER', '2026-05-01', 500)).obligation_id;
owner(`UPDATE fiscal_obligation SET status = 'CANCELLED' WHERE id = '${OC}';`);   // no frozen RPC cancels; owner fixture only
snap = snapshot();
r = ADMIN(`SELECT ${payCall(OC, '2026-05-22', 1, BNA, newKey())};`);
check('F7 a CANCELLED obligation → OBLIGATION_CANCELLED', raised(r, 'OBLIGATION_CANCELLED') && snapshot() === snap, firstErr(r));
for (const [what, fn, call, test] of [
  ['OPERATOR', A, payCall(O2, '2026-05-22', 1, BNA, newKey()), (x2) => raised(x2, 'FORBIDDEN')],
  ['amount 0', ADMIN, payCall(O2, '2026-05-22', 0, BNA, newKey()), (x2) => raised(x2, 'INVALID_AMOUNT')],
  ['NULL amount', ADMIN, payCall(O2, '2026-05-22', null, BNA, newKey()), (x2) => raised(x2, 'INVALID_AMOUNT')],
  ['missing obligation', ADMIN, payCall(MISSING_UUID, '2026-05-22', 1, BNA, newKey()), (x2) => raised(x2, 'OBLIGATION_NOT_FOUND')],
  ['NULL effective_date', ADMIN, payCall(O2, null, 1, BNA, newKey()), (x2) => raised(x2, 'BUSINESS_DATE_REQUIRED')],
  ['missing account', ADMIN, payCall(O2, '2026-05-22', 1, MISSING_UUID, newKey()), (x2) => violates(x2, 'financial_posting_financial_account_id_fkey')],
  ['NULL idempotency_key', ADMIN, payCall(O2, '2026-05-22', 1, BNA, null), (x2) => violates(x2, 'idempotency_key')],
]) {
  r = fn(`SELECT ${call};`);
  check(`F8 ${what} → rejected, nothing written`, test(r) && snapshot() === snap, firstErr(r));
}
check('F9 BNA moved by exactly the payments (−40000 −60000 −70000); supplier and client ledgers untouched',
  Number(balance(BNA)) === bna0 - 170000 && econ().split('|')[3] === econF[3] && econ().split('|')[4] === econF[4]);
check('F10 audit PAY: before status / paid_so_far, after status / payment, reason, actor',
  owner(`SELECT (before_values->>'status') || '|' || (before_values->>'paid_so_far') || '|' || (after_values->>'status') || '|' || (after_values->>'payment') || '|' || reason || '|' || performed_by
         FROM audit_events WHERE entity_type = 'fiscal_obligation' AND entity_id = '${P}' AND action = 'PAY' ORDER BY id LIMIT 1;`)
  === `PENDING|0.00|PARTIALLY_PAID|40000|anticipo IVA|${ADMIN_UID}`);
check('F11 no direct status change for any application role (status moves only inside RPC 36)',
  denied(ADMIN(`UPDATE fiscal_obligation SET status = 'PAID' WHERE id = '${O2}';`)) && status(O2) === 'PARTIALLY_PAID');

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'Installment link (owner decision: a supplied installment must belong to the obligation)');

const G = e1.obligation_id;
const instId = (num) => owner(`SELECT id FROM fiscal_obligation_installment WHERE fiscal_obligation_id = '${G}' AND installment_number = ${num};`);
const g1 = rpc(payCall(G, '2026-05-10', 30000, CAJA, newKey(), instId(1)));
check('G1 (A) installment of the SAME obligation → success; the link is stored, status computed at obligation level (PARTIALLY_PAID)',
  g1.obligation_status === 'PARTIALLY_PAID' && owner(`SELECT installment_id FROM fiscal_payment WHERE id = '${g1.payment_id}';`) === instId(1));
// obligation B with its own plan
const GB = rpc(oblCall('PERCEPTION', '2026-04-01', 1000, null, [I(1, 1000, '2026-05-10')])).obligation_id;
const instB1 = owner(`SELECT id FROM fiscal_obligation_installment WHERE fiscal_obligation_id = '${GB}' AND installment_number = 1;`);
const cajaG = balance(CAJA);
const gStatus = status(G);
const gPaid = paidOf(G);
snap = snapshot();
r = ADMIN(`SELECT ${payCall(G, '2026-05-10', 100, CAJA, newKey(), instB1)};`);
check('G2 (B) payment of obligation A carrying an installment of obligation B → INSTALLMENT_NOT_FOUND_OR_MISMATCH; no operation, posting, payment, status change or audit',
  raised(r, 'INSTALLMENT_NOT_FOUND_OR_MISMATCH') && snapshot() === snap && balance(CAJA) === cajaG && status(G) === gStatus && paidOf(G) === gPaid
  && status(GB) === 'PENDING' && paidOf(GB) === '0', firstErr(r));
r = ADMIN(`SELECT ${payCall(G, '2026-05-10', 1, CAJA, newKey(), MISSING_UUID)};`);
check('G3 (C) nonexistent installment → INSTALLMENT_NOT_FOUND_OR_MISMATCH (checked before any write, not by the FK); full rollback',
  raised(r, 'INSTALLMENT_NOT_FOUND_OR_MISMATCH') && snapshot() === snap && balance(CAJA) === cajaG, firstErr(r));
const g4 = rpc(payCall(G, '2026-05-11', 40000, CAJA, newKey(), instId(2)));
check('G4 amount control stays obligation-level only: 40000 against a 30000 installment of the same obligation is accepted (70000 ≤ 90000); no installment status / balance exists',
  g4.obligation_status === 'PARTIALLY_PAID' && paidOf(G) === '70000.00'
  && owner(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'fiscal_obligation_installment' AND column_name ~* '(status|paid|balance)';`) === '0');
r = ADMIN(`SELECT ${payCall(G, '2026-05-12', 30000, CAJA, newKey(), instId(3))};`);
check('G5 the obligation-level cap still holds with a valid installment link (70000 + 30000 > 90000 → OVERPAYMENT)', raised(r, 'OVERPAYMENT'), firstErr(r));
const g6 = rpc(payCall(G, '2026-05-13', 20000, CAJA, newKey()));
check('G6 (D) p_installment_id NULL is still allowed: the remaining 20000 is paid without a link → PAID',
  g6.obligation_status === 'PAID' && owner(`SELECT coalesce(installment_id::TEXT, 'null') FROM fiscal_payment WHERE id = '${g6.payment_id}';`) === 'null');

// ═══════════════════════════════════════════════════════════════════════════
section('H', 'RLS / privileges');

check('H1 ADMIN reads all five fiscal tables', TABLES.every((t) => Number(visible(ADMIN, t, 'true')) > 0));
check('H2 OPERATOR sees nothing in any fiscal table', TABLES.every((t) => visible(A, t, 'true') === '0'));
snap = snapshot();
const direct = [
  ADMIN(`INSERT INTO fiscal_document (document_type, direction, document_date, fiscal_period, supplier_id, net_amount, total_amount) VALUES ('OTHER','CREDITO','2026-05-01','2026-05-01','${SUP}',1,1);`),
  ADMIN(`UPDATE fiscal_document_component SET rate_applied = 27;`),
  ADMIN(`DELETE FROM fiscal_document_component;`),
  ADMIN(`INSERT INTO fiscal_obligation (tax_kind, fiscal_period, amount) VALUES ('OTHER','2026-06-01',1);`),
  ADMIN(`UPDATE fiscal_obligation SET amount = 1;`),
  ADMIN(`INSERT INTO fiscal_obligation_installment (fiscal_obligation_id, installment_number, amount, due_date) VALUES ('${P}', 9, 1, '2026-06-01');`),
  ADMIN(`DELETE FROM fiscal_payment;`),
  ADMIN(`TRUNCATE fiscal_payment, fiscal_obligation_installment, fiscal_obligation, fiscal_document_component, fiscal_document CASCADE;`),
  A(`INSERT INTO fiscal_obligation (tax_kind, fiscal_period, amount) VALUES ('OTHER','2026-06-01',1);`),
  A(`UPDATE fiscal_payment SET amount = 1;`),
];
check('H3 no direct INSERT / UPDATE / DELETE / TRUNCATE for ADMIN or OPERATOR (RPCs 34–36 only)',
  direct.every(denied) && snapshot() === snap, direct.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
const acl = owner(`SELECT string_agg(relname || '=' || relacl::TEXT, ' ' ORDER BY relname) FROM pg_class WHERE relname IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('H4 exact ACLs: authenticated SELECT only', acl === TABLES.map((t) => `${t}={postgres=arwdDxtm/postgres,authenticated=r/postgres}`).join(' '), acl);
const pols = owner(`SELECT string_agg(tablename || ':' || policyname || ':' || cmd, ',' ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('H5 policies exactly as frozen RLS §9: one ADMIN SELECT policy per table, nothing else',
  pols === TABLES.map((t) => `${t}:${t}_admin_select:SELECT`).join(','), pols);
const anonSr = [
  ...TABLES.map((t) => asAnon(`SELECT 1 FROM ${t};`)), ...TABLES.map((t) => asServiceRole(`SELECT 1 FROM ${t};`)),
  asAnon(`SELECT ${docCall({ sup: SUP })};`), asServiceRole(`SELECT ${docCall({ sup: SUP })};`),
  asServiceRole(`SELECT ${oblCall('OTHER', '2026-06-01', 1)};`), asServiceRole(`SELECT ${payCall(O2, '2026-05-22', 1, BNA, newKey())};`),
];
check('H6 anon and service_role: no SELECT on any fiscal table and no EXECUTE on RPCs 34–36', anonSr.every(denied), anonSr.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'Periods (34: document_date; 35: fiscal_period; 36: effective_date)');

closePeriod('2026-03-01');
snap = snapshot();
for (const [what, call] of [
  ['RPC 34 document_date in a CLOSED month', docCall({ sup: SUP, date: '2026-03-10', period: '2026-03-01' })],
  ['RPC 35 fiscal_period in a CLOSED month', oblCall('OTHER', '2026-03-01', 1)],
  ['RPC 36 effective_date in a CLOSED month', payCall(O2, '2026-03-10', 1, BNA, newKey())],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`I1 ${what} → PERIOD_CLOSED`, raised(r, 'PERIOD_CLOSED'), firstErr(r));
}
check('I2 CLOSED-period rejections wrote nothing', snapshot() === snap);
const i3 = rpc(docCall({ sup: SUP, date: '2026-05-06', period: '2026-03-01', num: 'A-0001-00000400' }));
check('I3 RPC 34: the write period is document_date — a May document for the CLOSED March tax period is accepted, fiscal_period stored as 2026-03-01',
  owner(`SELECT fiscal_period FROM fiscal_document WHERE id = '${i3.fiscal_document_id}';`) === '2026-03-01');
openPeriod('2026-03-01');
for (const [what, call] of [
  ['RPC 34', docCall({ sup: SUP, date: '2027-02-10', period: '2027-02-01' })],
  ['RPC 35', oblCall('OTHER', '2027-02-01', 1)],
  ['RPC 36', payCall(O2, '2027-02-10', 1, BNA, newKey())],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`I4 date without a management_period → PERIOD_NOT_FOUND: ${what}`, raised(r, 'PERIOD_NOT_FOUND'), firstErr(r));
}
closePeriod(CURRENT_MONTH);
const i5d = rpc(docCall({ sup: SUP, date: '2026-05-07', num: 'A-0001-00000401' }));
const i5o = rpc(oblCall('OTHER', '2026-06-01', 1000));
const i5p = rpc(payCall(i5o.obligation_id, '2026-06-05', 1000, BNA, newKey()));
check(`I5 created_at irrelevant: current month ${CURRENT_MONTH} CLOSED, business dates in OPEN months → all three RPCs accepted`,
  !!i5d.fiscal_document_id && !!i5o.obligation_id && i5p.obligation_status === 'PAID');
openPeriod(CURRENT_MONTH);

// ═══════════════════════════════════════════════════════════════════════════
section('J', 'Atomicity (injected failures)');

const JO = rpc(oblCall('OTHER', '2026-07-01', 1000, '2099-12-31')).obligation_id;
const JO2 = rpc(oblCall('RETENTION', '2026-07-01', 1000)).obligation_id;
owner(`
CREATE SCHEMA p22_harness;
CREATE FUNCTION p22_harness.doc_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.external_number = 'J-D1' THEN RAISE EXCEPTION 'HARNESS_FAIL_DOCUMENT'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p22_harness.comp_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rate_applied = 1.1111 THEN RAISE EXCEPTION 'HARNESS_FAIL_FIRST_COMPONENT'; END IF;
  IF NEW.rate_applied = 2.2222 THEN RAISE EXCEPTION 'HARNESS_FAIL_LATER_COMPONENT'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p22_harness.obl_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.tax_kind = 'OTHER' AND NEW.fiscal_period = '2026-08-01' THEN RAISE EXCEPTION 'HARNESS_FAIL_OBLIGATION'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p22_harness.obl_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.due_date = '2099-12-31' AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'HARNESS_FAIL_STATUS'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p22_harness.inst_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount = 111 THEN RAISE EXCEPTION 'HARNESS_FAIL_FIRST_INSTALLMENT'; END IF;
  IF NEW.amount = 333 THEN RAISE EXCEPTION 'HARNESS_FAIL_LATER_INSTALLMENT'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p22_harness.op_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.external_ref = 'J-P1' THEN RAISE EXCEPTION 'HARNESS_FAIL_OPERATION'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p22_harness.posting_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_operation o WHERE o.id = NEW.financial_operation_id AND o.external_ref = 'J-P2') THEN
    RAISE EXCEPTION 'HARNESS_FAIL_POSTING';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p22_harness.pay_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.idempotency_key = 'J-P3' THEN RAISE EXCEPTION 'HARNESS_FAIL_PAYMENT'; END IF; RETURN NEW; END $$;
CREATE FUNCTION p22_harness.audit_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_type IN ('fiscal_document','fiscal_obligation') AND NEW.reason IN ('J-A','J-OA','J-P5') THEN
    RAISE EXCEPTION 'HARNESS_FAIL_AUDIT';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p22_doc_ins AFTER INSERT ON public.fiscal_document FOR EACH ROW EXECUTE FUNCTION p22_harness.doc_ins();
CREATE TRIGGER p22_comp_ins BEFORE INSERT ON public.fiscal_document_component FOR EACH ROW EXECUTE FUNCTION p22_harness.comp_ins();
CREATE TRIGGER p22_obl_ins AFTER INSERT ON public.fiscal_obligation FOR EACH ROW EXECUTE FUNCTION p22_harness.obl_ins();
CREATE TRIGGER p22_obl_upd BEFORE UPDATE ON public.fiscal_obligation FOR EACH ROW EXECUTE FUNCTION p22_harness.obl_upd();
CREATE TRIGGER p22_inst_ins BEFORE INSERT ON public.fiscal_obligation_installment FOR EACH ROW EXECUTE FUNCTION p22_harness.inst_ins();
CREATE TRIGGER p22_op_ins BEFORE INSERT ON public.financial_operation FOR EACH ROW EXECUTE FUNCTION p22_harness.op_ins();
CREATE TRIGGER p22_posting_ins BEFORE INSERT ON public.financial_posting FOR EACH ROW EXECUTE FUNCTION p22_harness.posting_ins();
CREATE TRIGGER p22_pay_ins BEFORE INSERT ON public.fiscal_payment FOR EACH ROW EXECUTE FUNCTION p22_harness.pay_ins();
CREATE TRIGGER p22_audit_ins BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION p22_harness.audit_ins();`);
try {
  snap = snapshot();
  for (const [what, call, code] of [
    ['RPC 34 after the document insert', docCall({ sup: SUP, num: 'J-D1' }), 'HARNESS_FAIL_DOCUMENT'],
    ['RPC 34 at the first component', docCall({ sup: SUP, comps: [C('IVA', 'CREDITO', 1, 1.1111, 0)] }), 'HARNESS_FAIL_FIRST_COMPONENT'],
    ['RPC 34 at a later component', docCall({ sup: SUP, comps: [C('IVA', 'CREDITO', 1, 21, 0), C('IIBB', 'CREDITO', 1, 2.2222, 0)] }), 'HARNESS_FAIL_LATER_COMPONENT'],
    ['RPC 34 at the audit', docCall({ sup: SUP, reason: 'J-A' }), 'HARNESS_FAIL_AUDIT'],
    ['RPC 35 after the obligation insert', oblCall('OTHER', '2026-08-01', 1000), 'HARNESS_FAIL_OBLIGATION'],
    ['RPC 35 at the first installment', oblCall('OTHER', '2026-09-01', 444, null, [I(1, 111, '2026-09-10'), I(2, 333, '2026-10-10')]), 'HARNESS_FAIL_FIRST_INSTALLMENT'],
    ['RPC 35 at a later installment', oblCall('OTHER', '2026-09-01', 444, null, [I(1, 11, '2026-09-10'), I(2, 100, '2026-10-10'), I(3, 333, '2026-11-10')]), 'HARNESS_FAIL_LATER_INSTALLMENT'],
    ['RPC 35 after all installments, at the mismatch check', oblCall('OTHER', '2026-09-01', 500, null, [I(1, 200, '2026-09-10'), I(2, 200, '2026-10-10')]), 'INSTALLMENT_MISMATCH'],
    ['RPC 35 at the audit', oblCall('OTHER', '2026-09-01', 500, null, null, 'J-OA'), 'HARNESS_FAIL_AUDIT'],
    ['RPC 36 at the operation insert', payCall(JO, '2026-07-05', 100, BNA, 'J-P1'), 'HARNESS_FAIL_OPERATION'],
    ['RPC 36 after the operation, at the posting', payCall(JO, '2026-07-05', 100, BNA, 'J-P2'), 'HARNESS_FAIL_POSTING'],
    ['RPC 36 after operation + posting, at the payment row', payCall(JO, '2026-07-05', 100, BNA, 'J-P3'), 'HARNESS_FAIL_PAYMENT'],
    ['RPC 36 after the payment, at the status update', payCall(JO, '2026-07-05', 100, BNA, 'J-P4'), 'HARNESS_FAIL_STATUS'],
    ['RPC 36 at the audit', payCall(JO2, '2026-07-05', 100, BNA, 'J-P5b', null, 'J-P5'), 'HARNESS_FAIL_AUDIT'],
  ]) {
    r = ADMIN(`SELECT ${call};`);
    check(`J1 ${what} → full rollback (no document / component / obligation / installment / payment / operation / posting / audit)`,
      raised(r, code) && snapshot() === snap, firstErr(r));
  }
  check('J2 the obligation used by the RPC 36 injections is untouched: PENDING, nothing paid, no money moved',
    status(JO) === 'PENDING' && paidOf(JO) === '0' && status(JO2) === 'PENDING' && paidOf(JO2) === '0'
    && owner(`SELECT count(*) FROM financial_operation WHERE source_entity_type = 'fiscal_obligation' AND source_entity_id = '${JO}';`) === '0');
} finally {
  owner(`DROP SCHEMA IF EXISTS p22_harness CASCADE;`);
}
check('J3 harness triggers removed', owner(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p22_%';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'Concurrency (independent PostgreSQL sessions)');

x = await race(`SELECT ${oblCall('IVA', '2026-06-01', 5000)};`, `SELECT ${oblCall('IVA', '2026-06-01', 7000)};`, 'p22-obl');
check('K1 same tax_kind + fiscal_period: B waited, then DUPLICATE_OBLIGATION; exactly one obligation (A\'s)',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_OBLIGATION')
  && owner(`SELECT count(*) || '|' || max(amount) FROM fiscal_obligation WHERE tax_kind = 'IVA' AND fiscal_period = '2026-06-01';`) === '1|5000.00', firstErr(x.rb));
x = await race(`SELECT ${docCall({ sup: SUP2, date: '2026-05-08', num: 'RACE-001' })};`, `SELECT ${docCall({ sup: SUP2, date: '2026-06-08', period: '2026-06-01', num: 'RACE-001' })};`, 'p22-doc');
check('K2 same supplier + external_number from different document months (both pass the pre-check): B waited on the frozen UNIQUE index, then DUPLICATE_FISCAL_DOCUMENT; one document',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_FISCAL_DOCUMENT')
  && owner(`SELECT count(*) FROM fiscal_document WHERE supplier_id = '${SUP2}' AND external_number = 'RACE-001';`) === '1', firstErr(x.rb));
const KO = rpc(oblCall('IIBB', '2026-06-01', 100000)).obligation_id;
const kKey = newKey();
x = await race(`SELECT ${payCall(KO, '2026-06-10', 10000, BNA, kKey)};`, `SELECT ${payCall(KO, '2026-06-10', 10000, BNA, kKey)};`, 'p22-key');
check('K3 same payment idempotency_key: B waited, then DUPLICATE_PAYMENT; exactly one payment, one operation, one posting',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_PAYMENT')
  && owner(`SELECT (SELECT count(*) FROM fiscal_payment WHERE idempotency_key = '${kKey}') || '|' || (SELECT count(*) FROM financial_operation WHERE external_ref = '${kKey}')
     || '|' || (SELECT count(*) FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id WHERE o.external_ref = '${kKey}');`) === '1|1|1', firstErr(x.rb));
x = await race(`SELECT ${payCall(KO, '2026-06-11', 50000, BNA, newKey())};`, `SELECT ${payCall(KO, '2026-06-11', 30000, BNA, newKey())};`, 'p22-two');
check('K4 two different payments on one obligation: B waited on the obligation lock; both applied in order; 90000 paid, PARTIALLY_PAID',
  x.aIn && x.bWait && x.ra.ok && x.rb.ok && paidOf(KO) === '90000.00' && status(KO) === 'PARTIALLY_PAID', firstErr(x.rb));
x = await race(`SELECT ${payCall(KO, '2026-06-12', 10000, BNA, newKey())};`, `SELECT ${payCall(KO, '2026-06-12', 10000, BNA, newKey())};`, 'p22-final');
check('K5 two concurrent final payments: A closes it (PAID), B waited, then ALREADY_PAID; never exceeds 100000',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'ALREADY_PAID') && paidOf(KO) === '100000.00' && status(KO) === 'PAID', firstErr(x.rb));
const KO2 = rpc(oblCall('GANANCIAS', '2026-06-01', 100000)).obligation_id;
rpc(payCall(KO2, '2026-06-13', 40000, BNA, newKey()));
x = await race(`SELECT ${payCall(KO2, '2026-06-13', 50000, BNA, newKey())};`, `SELECT ${payCall(KO2, '2026-06-13', 20000, BNA, newKey())};`, 'p22-over');
check('K6 concurrent payments whose sum would exceed the obligation: B waited, re-read the paid amount, then OVERPAYMENT; 90000 paid, postings = payments',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'OVERPAYMENT') && paidOf(KO2) === '90000.00'
  && owner(`SELECT -SUM(p.signed_amount) FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id
            WHERE o.source_entity_type = 'fiscal_obligation' AND o.source_entity_id = '${KO2}';`) === '90000.00', firstErr(x.rb));

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'No economic duplication / economic-fact links');

const l0 = econ();
const lDoc = rpc(docCall({ sup: SUP, num: 'A-0001-00000999', net: 100000, total: 121000, comps: [C('IVA', 'CREDITO', 100000, 21, 21000)] }));
check('L1 a fiscal document for a supplier purchase creates no purchase, liability, ledger movement or money movement', econ() === l0);
const lKey = newKey();
const lPur = rpc(purchaseCall(lKey, lDoc.fiscal_document_id, 'A-0001-00000999'));
check('L2 the economic purchase references the fiscal document through the frozen path (register_purchase p_fiscal_document_id)',
  owner(`SELECT fiscal_document_id FROM purchases WHERE id = '${lPur.purchase_id}';`) === lDoc.fiscal_document_id);
check('L3 the supplier liability exists exactly once: +121000 from the purchase, nothing from the fiscal document',
  owner(`SELECT count(*) || '|' || SUM(signed_amount) FROM supplier_ledger WHERE supplier_id = '${SUP}';`) === '1|121000.00'
  && owner(`SELECT count(*) FROM fiscal_document_component WHERE fiscal_document_id = '${lDoc.fiscal_document_id}';`) === '1');
r = ADMIN(`SELECT ${purchaseCall(newKey(), MISSING_UUID)};`);
check('L4 a dangling purchases.fiscal_document_id is impossible (purchases_fiscal_document_id_fkey)', violates(r, 'purchases_fiscal_document_id_fkey'), firstErr(r));
const fr = rpc(`register_freight('2026-05-09', 5000, '${CAT}', '${newKey()}', '${SUP}', 'REM-1', '${lDoc.fiscal_document_id}', 'flete')`);
r = ADMIN(`SELECT register_freight('2026-05-09', 5000, '${CAT}', '${newKey()}', '${SUP}', 'REM-2', '${MISSING_UUID}', 'flete');`);
check('L5 freight references a fiscal document through register_freight; a dangling one is impossible (freight_fiscal_document_id_fkey)',
  owner(`SELECT fiscal_document_id FROM freight WHERE id = '${fr.freight_id}';`) === lDoc.fiscal_document_id && violates(r, 'freight_fiscal_document_id_fkey'), firstErr(r));
const cl0 = owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${CLI}';`);
rpc(docCall({ type: 'INVOICE_A', dir: 'DEBITO', cli: CLI, num: 'B-0002-00000009', comps: [C('IVA', 'DEBITO', 1000, 21, 210)] }));
check('L6 an issued (DEBITO) fiscal document creates no client debt and no Pedido', owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${CLI}';`) === cl0
  && owner(`SELECT count(*) FROM pedidos WHERE cliente_id = '${CLI}';`) === '0');
check('L7 frozen invariant 12: fiscal tables hold no economic columns (no ledger / posting / purchase / Pedido reference) and nothing in the economic layer references a component',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_name IN (${TABLES.map((t) => `'${t}'`).join(',')})
         AND column_name ~* '(purchase|pedido|ledger|posting)';`) === '0'
  && owner(`SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND confrelid = 'fiscal_document_component'::regclass;`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('M', 'SECURITY DEFINER');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
check('M1 SECURITY DEFINER inventory = previous 35 + RPCs 34–36 = 38', definers === ALL_DEFINERS, definers);
const hard = owner(`SELECT string_agg(proname || '=' || prosecdef || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || ':' || pg_get_userbyid(proowner) || ':'
  || (proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)) || ':' || has_function_privilege('anon', oid, 'EXECUTE')
  || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
  FROM pg_proc WHERE proname IN (${FISCAL_RPCS.map((p) => `'${p}'`).join(',')});`);
check('M2 each: DEFINER, search_path=public, owner postgres, no PUBLIC, anon no, authenticated yes, service_role no',
  hard === FISCAL_RPCS.map((p) => `${p}=true:true:postgres:true:false:true:false`).join(','), hard);
const sigs = owner(`SELECT string_agg(proname || '(' || pg_get_function_identity_arguments(oid) || ')', ' ; ' ORDER BY proname) FROM pg_proc WHERE proname IN (${FISCAL_RPCS.map((p) => `'${p}'`).join(',')});`);
const argNames = owner(`SELECT string_agg(array_to_string(proargnames, ','), ',') FROM pg_proc WHERE proname IN (${FISCAL_RPCS.map((p) => `'${p}'`).join(',')});`);
check('M3 exact frozen signatures; no actor / role / user parameter',
  sigs === 'pay_fiscal_obligation(p_obligation_id uuid, p_effective_date date, p_amount numeric, p_financial_account_id uuid, p_idempotency_key character varying, p_installment_id uuid, p_reason text) ; '
  + 'register_fiscal_document(p_document_type fiscal_document_type, p_direction fiscal_direction, p_document_date date, p_fiscal_period date, p_net_amount numeric, p_total_amount numeric, p_components jsonb, p_supplier_id uuid, p_cliente_id uuid, p_external_number character varying, p_reason text) ; '
  + 'register_fiscal_obligation(p_tax_kind tax_kind, p_fiscal_period date, p_amount numeric, p_due_date date, p_installments jsonb, p_reason text)'
  && !/(user|actor|role|performed|created_by|uid)/i.test(argNames), sigs);

// ═══════════════════════════════════════════════════════════════════════════
section('N', 'Fiscal end to end');

const e2eSup = okAs(ADMIN, `INSERT INTO suppliers (nombre) VALUES ('${TAG} Proveedor E2E') RETURNING id;`);
const nDoc = rpc(docCall({ sup: e2eSup, date: '2026-07-06', period: '2026-07-01', num: 'A-0009-00000001', net: 200000, total: 242000,
  comps: [C('IVA', 'CREDITO', 200000, 21, 42000)], reason: 'factura insumos julio' }));
const ledgerBefore = owner(`SELECT count(*) FROM supplier_ledger WHERE supplier_id = '${e2eSup}';`);
const nPur = rpc(`register_purchase('${e2eSup}', '2026-07-06', 200000, 242000, '${CAT}', NULL, 'OPERATING', `
  + `'[{"descripcion":"Soja","cantidad":20,"unit_type":"TON","precio_unitario":10000}]'::jsonb, `
  + `'[{"storage_path":"purchases/e2e.pdf","file_name":"e2e.pdf","content_type":"application/pdf","byte_size":1000}]'::jsonb, `
  + `'${newKey()}', NULL, '${nDoc.fiscal_document_id}', 'A-0009-00000001', NULL, 'compra julio')`);
check('N1 tax record + economic fact: the purchase (242000) carries fiscal_document_id; the supplier ledger has exactly one +242000 (from the purchase)',
  ledgerBefore === '0' && owner(`SELECT fiscal_document_id FROM purchases WHERE id = '${nPur.purchase_id}';`) === nDoc.fiscal_document_id
  && owner(`SELECT count(*) || '|' || SUM(signed_amount) FROM supplier_ledger WHERE supplier_id = '${e2eSup}';`) === '1|242000.00');
check('N2 the IVA crédito component keeps its snapshot rate (21.0000) and amounts', comps(nDoc.fiscal_document_id) === 'IVA:CREDITO:200000.00:21.0000:42000.00');
const nOb = rpc(oblCall('IVA', '2026-07-01', 30000, '2026-08-20', [I(1, 18000, '2026-08-20'), I(2, 12000, '2026-09-20')], 'posición IVA julio'));
check('N3 tax payable for July: obligation 30000 PENDING with a 2-installment plan', nOb.installment_count === 2 && status(nOb.obligation_id) === 'PENDING');
const bnaN = Number(balance(BNA));
const inst1 = owner(`SELECT id FROM fiscal_obligation_installment WHERE fiscal_obligation_id = '${nOb.obligation_id}' AND installment_number = 1;`);
const inst2 = owner(`SELECT id FROM fiscal_obligation_installment WHERE fiscal_obligation_id = '${nOb.obligation_id}' AND installment_number = 2;`);
const np1 = rpc(payCall(nOb.obligation_id, '2026-08-20', 18000, BNA, newKey(), inst1, 'cuota 1'));
const np2 = rpc(payCall(nOb.obligation_id, '2026-09-18', 12000, BNA, newKey(), inst2, 'cuota 2'));
check('N4 partial payment → PARTIALLY_PAID, remainder → PAID', np1.obligation_status === 'PARTIALLY_PAID' && np2.obligation_status === 'PAID' && status(nOb.obligation_id) === 'PAID');
check('N5 BNA postings equal exactly the payments (−30000 in two FISCAL_PAYMENT operations); nothing else moved',
  Number(balance(BNA)) === bnaN - 30000
  && owner(`SELECT count(*) || '|' || SUM(p.signed_amount) FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id
            WHERE o.source_entity_type = 'fiscal_obligation' AND o.source_entity_id = '${nOb.obligation_id}' AND o.operation_type = 'FISCAL_PAYMENT';`) === '2|-30000.00');
check('N6 no duplicate economic event: the supplier ledger still holds only the purchase; fiscal tables reference no ledger',
  owner(`SELECT count(*) || '|' || SUM(signed_amount) FROM supplier_ledger WHERE supplier_id = '${e2eSup}';`) === '1|242000.00');
} finally {
  cleanup();
}

section('Z', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM fiscal_document) + (SELECT count(*) FROM fiscal_obligation) + (SELECT count(*) FROM fiscal_payment)
  + (SELECT count(*) FROM suppliers WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM clients WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'p22_harness') + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p22_%');`);
check('Z1 all P22-TEST fiscal rows, purchases, freight, payments, operations, masters, harness schema and triggers removed', left === '0', left);
check('Z2 periods closed by the suite are OPEN again',
  owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`) === '0');

console.log(`\n  ══ FISCAL RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
