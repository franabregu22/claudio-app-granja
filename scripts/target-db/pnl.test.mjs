#!/usr/bin/env node
/**
 * PHASE 24 — P&L / MANAGEMENT TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Proves the ADR-004 managerial P&L: results derived (views pnl_line_item /
 * pnl_summary) from source facts, never stored; transfers, collections,
 * payments, treasury postings and the fiscal layer excluded; costs never
 * double-counted against purchases; freight counted at most once; MP fee /
 * yield semantics; management RETIRO / RESERVA_INTERNA source events (RPC 43);
 * drill-down to source facts; ADMIN-only visibility.
 *
 * One synthetic scenario lives in the 2026-08 period and is built only through
 * the real RPCs of Phases 14–23; its expected figures are computed by hand in
 * this file and checked through every subtotal.
 *
 * Fixtures: masters named "P24-TEST …", keys starting "P24-TEST:". Cleanup
 * removes every fact the scenario created (MP rows included).
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/pnl.test.mjs
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
const TAG = 'P24-TEST';
const K = `${TAG}:`;
const PERIOD = '2026-08-01';
const ALL_DEFINERS = 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,'
  + 'close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,'
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
const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
async function waitFor(condSql, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (owner(condSql) === 't') return true;
    await sleep(100);
  }
  return false;
}
// independent ADMIN sessions: A runs and holds its transaction open; B starts once A is inside
async function race(sqlA, sqlB, appPrefix) {
  const adminSql = (s2) => sessionSql('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s2);
  const pA = session(adminSql(`${sqlA}\nSELECT pg_sleep(2);`), `${appPrefix}-A`);
  const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-A' AND state = 'active' AND query LIKE '%pg_sleep%');`);
  const pB = session(adminSql(sqlB), `${appPrefix}-B`);
  const bWait = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-B' AND wait_event_type = 'Lock');`);
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
const TSUP = `(SELECT id FROM suppliers WHERE nombre LIKE '${TAG}%')`;
const TCLI = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
const TSES = `(SELECT id FROM sales_session WHERE idempotency_key LIKE '${K}%')`;
function cleanup() {
  owner(`
CREATE TEMP TABLE _ses AS SELECT id FROM sales_session WHERE idempotency_key LIKE '${K}%';
CREATE TEMP TABLE _ped AS SELECT id FROM pedidos WHERE sales_session_id IN (SELECT id FROM _ses) OR cliente_id IN ${TCLI};
CREATE TEMP TABLE _pur AS SELECT id FROM purchases WHERE supplier_id IN ${TSUP};
CREATE TEMP TABLE _fr AS SELECT id FROM freight WHERE supplier_id IN ${TSUP} OR idempotency_key LIKE '${K}%';
CREATE TEMP TABLE _me AS SELECT id FROM management_event WHERE idempotency_key LIKE '${K}%';
CREATE TEMP TABLE _obl AS SELECT id FROM fiscal_obligation WHERE created_by = '${ADMIN_UID}';
CREATE TEMP TABLE _doc AS SELECT id FROM fiscal_document WHERE supplier_id IN ${TSUP};
CREATE TEMP TABLE _op AS
        SELECT id FROM financial_operation WHERE external_ref LIKE '${K}%' OR external_ref LIKE 'MP:${K}%' OR external_ref LIKE 'MGMT:${K}%'
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'sales_session' AND source_entity_id IN (SELECT id::TEXT FROM _ses)
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'fiscal_obligation' AND source_entity_id IN (SELECT id::TEXT FROM _obl)
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'mp_financial_movement'
  UNION SELECT financial_operation_id FROM management_event WHERE id IN (SELECT id FROM _me) AND financial_operation_id IS NOT NULL;
-- MP (written only by the MP-related suites; each removes every MP row)
DELETE FROM audit_events WHERE entity_type IN ('mp_reconciliation', 'mp_source_record');
DELETE FROM mp_report_match;          -- ADR-006 HRN-4: dependents of movement / source, in FK order
DELETE FROM mp_transition_identity;
DELETE FROM mp_reconciliation;
DELETE FROM mp_financial_movement;
DELETE FROM mp_source_record;
-- management events: compensations before originals
DELETE FROM audit_events WHERE entity_type = 'management_event' AND entity_id IN (SELECT id::TEXT FROM _me);
DELETE FROM management_event WHERE id IN (SELECT id FROM _me) AND compensates_event_id IS NOT NULL;
DELETE FROM management_event WHERE id IN (SELECT id FROM _me);
-- fiscal
DELETE FROM audit_events WHERE entity_type = 'fiscal_obligation' AND entity_id IN (SELECT id::TEXT FROM _obl);
DELETE FROM fiscal_payment WHERE fiscal_obligation_id IN (SELECT id FROM _obl);
DELETE FROM fiscal_obligation_installment WHERE fiscal_obligation_id IN (SELECT id FROM _obl);
DELETE FROM fiscal_obligation WHERE id IN (SELECT id FROM _obl);
-- feria + pedidos
UPDATE sales_session SET aggregated_pedido_id = NULL WHERE id IN (SELECT id FROM _ses);
DELETE FROM audit_events WHERE entity_type = 'pedido' AND entity_id IN (SELECT id::TEXT FROM _ped);
DELETE FROM client_ledger WHERE (source_entity_type = 'pedido' AND source_entity_id IN (SELECT id::TEXT FROM _ped)) OR cliente_id IN ${TCLI};
DELETE FROM audit_events WHERE entity_type = 'collections' AND entity_id IN (SELECT id::TEXT FROM collections WHERE cliente_id IN ${TCLI});
DELETE FROM collections WHERE cliente_id IN ${TCLI};
DELETE FROM pedido_lineas WHERE pedido_id IN (SELECT id FROM _ped);
DELETE FROM pedidos WHERE id IN (SELECT id FROM _ped);
DELETE FROM audit_events WHERE entity_type = 'sales_session_cash_event' AND entity_id IN (SELECT id::TEXT FROM sales_session_cash_event WHERE sales_session_id IN (SELECT id FROM _ses));
DELETE FROM sales_session_cash_event WHERE sales_session_id IN (SELECT id FROM _ses);
DELETE FROM audit_events WHERE entity_type = 'sales_session' AND entity_id IN (SELECT id::TEXT FROM _ses);
DELETE FROM sales_session WHERE id IN (SELECT id FROM _ses);
-- purchases / freight
DELETE FROM audit_events WHERE entity_type IN ('purchases') AND entity_id IN (SELECT id::TEXT FROM _pur);
DELETE FROM audit_events WHERE entity_type IN ('freight') AND entity_id IN (SELECT id::TEXT FROM _fr);
DELETE FROM audit_events WHERE entity_type = 'freight_allocation' AND entity_id IN (SELECT id::TEXT FROM freight_allocation WHERE freight_id IN (SELECT id FROM _fr));
DELETE FROM freight_allocation WHERE freight_id IN (SELECT id FROM _fr) OR purchase_id IN (SELECT id FROM _pur);
DELETE FROM supplier_ledger WHERE supplier_id IN ${TSUP};
DELETE FROM purchase_attachment WHERE purchase_id IN (SELECT id FROM _pur);
DELETE FROM purchase_line WHERE purchase_id IN (SELECT id FROM _pur);
DELETE FROM purchases WHERE id IN (SELECT id FROM _pur);
DELETE FROM freight WHERE id IN (SELECT id FROM _fr);
DELETE FROM audit_events WHERE entity_type = 'fiscal_document' AND entity_id IN (SELECT id::TEXT FROM _doc);
DELETE FROM fiscal_document_component WHERE fiscal_document_id IN (SELECT id FROM _doc);
DELETE FROM fiscal_document WHERE id IN (SELECT id FROM _doc);
-- treasury consequences
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
-- masters
DELETE FROM products WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
DELETE FROM suppliers WHERE nombre LIKE '${TAG}%';
DELETE FROM expense_category WHERE nombre LIKE '${TAG}%';
UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
}

cleanup();
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPA}', false, false) ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPA}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;`);

// ── helpers ────────────────────────────────────────────────────────────────
let keySeq = 0;
const key = () => `${K}${String(++keySeq).padStart(4, '0')}`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(String(v))}'`);
const n = (v) => (v === null || v === undefined ? 'NULL' : String(v));
const j = (v) => `'${esc(JSON.stringify(v))}'::jsonb`;
const itemsOf = (type, id) => okAs(ADMIN, `SELECT coalesce(string_agg(bucket || '|' || business_date || '|' || signed_amount, ',' ORDER BY bucket, signed_amount), '')
  FROM pnl_line_item WHERE source_entity_type = '${type}' AND source_entity_id = '${id}';`);
const summary = () => { const o = okAs(ADMIN, `SELECT row_to_json(s) FROM pnl_summary s WHERE period = '${PERIOD}';`); return o ? JSON.parse(o) : null; };
const bucketSum = (b) => Number(okAs(ADMIN, `SELECT coalesce(SUM(signed_amount), 0) FROM pnl_line_item WHERE period = '${PERIOD}' AND bucket = '${b}';`));
const snapshotPnl = () => okAs(ADMIN, `SELECT coalesce(string_agg(bucket || ':' || signed_amount || ':' || source_entity_type || ':' || source_entity_id, ',' ORDER BY 1), '') FROM pnl_line_item WHERE period = '${PERIOD}';`);
const balance = (acc) => owner(`SELECT coalesce(SUM(signed_amount), 0) FROM financial_posting WHERE financial_account_id = '${acc}';`);
const cents = (v) => Math.round(Number(v) * 100);
const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);
const mgmtCall = (type, date, amount, k, reason, acct = null, comp = null) =>
  `register_management_event(${q(type)}, ${q(date)}, ${n(amount)}, ${q(k)}, ${q(reason)}, ${q(acct)}, ${q(comp)})`;

let r;

try {
// ── masters ────────────────────────────────────────────────────────────────
const cat = (name, cls) => okAs(ADMIN, `INSERT INTO expense_category (nombre, pnl_cost_class) VALUES ('${TAG} ${name}', '${cls}') RETURNING id;`);
const CAT_D = cat('Insumos directos', 'DIRECT');
const CAT_I = cat('Gastos indirectos', 'INDIRECT');
const CAT_FI = cat('Flete indirecto', 'INDIRECT');
const CAT_FD = cat('Flete directo', 'DIRECT');
const SUP = okAs(ADMIN, `INSERT INTO suppliers (nombre) VALUES ('${TAG} Proveedor') RETURNING id;`);
const TRANS = okAs(ADMIN, `INSERT INTO suppliers (nombre) VALUES ('${TAG} Transportista') RETURNING id;`);
const CLI = okAs(ADMIN, `INSERT INTO clients (nombre) VALUES ('${TAG} Cliente') RETURNING id;`);
const PROD = okAs(ADMIN, `INSERT INTO products (nombre, product_type) VALUES ('${TAG} Huevo', 'VENDIBLE') RETURNING id;`);
const CAJA = owner(`SELECT id FROM financial_account WHERE nombre = 'Caja chica';`);
const BNA = owner(`SELECT id FROM financial_account WHERE nombre = 'BNA';`);
const MPACC = owner(`SELECT id FROM financial_account WHERE nombre = 'Mercado Pago';`);

// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure (ADR-004 sources, derived views only)');

check('A1 expense_category.pnl_cost_class: enum expense_cost_class (DIRECT, INDIRECT), NOT NULL, no default',
  owner(`SELECT data_type || '|' || udt_name || '|' || is_nullable || '|' || coalesce(column_default, 'none') FROM information_schema.columns
     WHERE table_name = 'expense_category' AND column_name = 'pnl_cost_class';`) === 'USER-DEFINED|expense_cost_class|NO|none'
  && owner(`SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = 'expense_cost_class'::regtype;`) === 'DIRECT,INDIRECT');
r = ADMIN(`INSERT INTO expense_category (nombre) VALUES ('${TAG} sin clase');`);
check('A2 a category without an explicit class is rejected (no guessed default)', violates(r, 'pnl_cost_class'), firstErr(r));
check('A3 financial_operation_type gains OWNER_WITHDRAWAL (the treasury consequence of a RETIRO)',
  owner(`SELECT 'OWNER_WITHDRAWAL' = ANY(enum_range(NULL::financial_operation_type)::TEXT[]);`) === 't');
check('A4 management_event: append-only source decisions (RETIRO / RESERVA_INTERNA), magnitude > 0, compensation link, treasury CHECK, reason CHECK',
  owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'management_event';`)
  === 'id,event_type,effective_date,amount,compensates_event_id,financial_account_id,financial_operation_id,idempotency_key,reason,created_at,created_by'
  && owner(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'management_event'::regclass AND contype IN ('c','u');`)
  === 'chk_management_event_not_self,chk_management_event_reason,chk_management_event_treasury,management_event_amount_check,'
  + 'management_event_financial_operation_id_key,management_event_idempotency_key_key');
check('A5 no P&L result / subtotal / balance table and no materialized view exists; pnl_line_item and pnl_summary are plain views',
  owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         AND table_name ~* '(pnl|result|resultado|subtotal|balance|saldo)';`) === '0'
  && owner(`SELECT count(*) FROM pg_matviews WHERE schemaname = 'public';`) === '0'
  && owner(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.views WHERE table_schema = 'public' AND table_name LIKE 'pnl%';`) === 'pnl_line_item,pnl_summary');
check('A6 both views are security_invoker = true and owned by postgres',
  owner(`SELECT string_agg(relname || '=' || pg_get_userbyid(relowner) || ':' || array_to_string(reloptions, ','), ' ' ORDER BY relname) FROM pg_class WHERE relname IN ('pnl_line_item','pnl_summary');`)
  === 'pnl_line_item=postgres:security_invoker=true pnl_summary=postgres:security_invoker=true');
check('A7 pnl_line_item exposes exactly the drill-down shape',
  owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'pnl_line_item';`)
  === 'bucket,business_date,period,signed_amount,source_entity_type,source_entity_id,expense_category_id,nature,project_id,description');
check('A8 the views never read treasury, ledgers, collections or the fiscal layer (definition scan)',
  !/(financial_posting|financial_operation|client_ledger|supplier_ledger|collections|fiscal_)/.test(owner(`SELECT pg_get_viewdef('pnl_line_item'::regclass);`)));

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Scenario 2026-08 (built only through real RPCs)');

// sales: identified client, delivered then rectified; later collection
const PED = okAs(ADMIN, `INSERT INTO pedidos (cliente_id, created_by) VALUES ('${CLI}', '${ADMIN_UID}') RETURNING id;`);
okAs(ADMIN, `INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, created_by) VALUES
  ('${PED}', '${PROD}', 10, 100, '${TAG} Huevo', '${ADMIN_UID}'), ('${PED}', '${PROD}', 5, 200, '${TAG} Huevo', '${ADMIN_UID}');`);
rpc(`deliver_order('${PED}', '2026-08-05 12:00-03', 'entrega')`);
rpc(`rectify_delivered_order('${PED}', ${j([{ producto_id: PROD, cantidad: 10, precio_unitario: 100 }, { producto_id: PROD, cantidad: 3, precio_unitario: 200 }])}, 'devolución parcial')`);
const COL = rpc(`register_collection('${CLI}', 500, 'TRANSFER', '${key()}', '2026-08-06', '${BNA}')`);
// feria: fund, direct + indirect expenses, withdrawal, transfer-out, count, aggregate retail sale
const SES = rpc(`open_sales_session('2026-08-07', 'Feria P&L', '${key()}', 1000, '${CAJA}')`).session_id;
const exI = rpc(`register_session_cash_event('${SES}', 'EXPENSE', 150, '${CAJA}', '${CAT_I}', NULL, 'bolsas')`);
const exD = rpc(`register_session_cash_event('${SES}', 'EXPENSE', 70, '${CAJA}', '${CAT_D}', NULL, 'maples')`);
const wd = rpc(`register_session_cash_event('${SES}', 'WITHDRAWAL', 300, '${CAJA}', NULL, NULL, 'retiro feria')`);
const tout = rpc(`register_session_cash_event('${SES}', 'TRANSFER_OUT', 200, '${CAJA}', NULL, '${BNA}', 'depósito')`);
const cnt = rpc(`register_session_cash_event('${SES}', 'COUNT', 900, '${CAJA}', NULL, NULL, 'arqueo')`);
const AGG = rpc(`close_sales_session('${SES}', ${j([{ producto_id: PROD, cantidad: 20, precio_unitario: 50 }])})`).aggregated_pedido_id;
// purchases
const lineJ = j([{ descripcion: 'Insumo', cantidad: 1, unit_type: 'UNIT', precio_unitario: 1 }]);
const attJ = (k) => j([{ storage_path: `purchases/${k}.pdf`, file_name: `${k}.pdf`, content_type: 'application/pdf', byte_size: 100 }]);
const purchase = (date, net, total, catId, nature) => { const k = key(); return rpc(`register_purchase('${SUP}', '${date}', ${net}, ${total}, '${catId}', NULL, '${nature}', ${lineJ}, ${attJ(k)}, '${k}', NULL, NULL, NULL, NULL, 'compra')`).purchase_id; };
const PD0 = purchase('2026-08-03', 1000, 1210, CAT_D, 'OPERATING');
const PI = purchase('2026-08-04', 500, 605, CAT_I, 'OPERATING');
const PR = purchase('2026-08-08', 4000, 5000, CAT_D, 'REINVESTMENT');
const PV = purchase('2026-08-09', 16000, 20000, CAT_I, 'INVESTMENT');
// freight F1 (300, INDIRECT): 100 → PD (before its rectification), 80 → PR, 70 → PV, 50 unallocated
const F1 = rpc(`register_freight('2026-08-10', 300, '${CAT_FI}', '${key()}', '${TRANS}', 'REM-1', NULL, 'flete')`).freight_id;
const aD = rpc(`assign_freight_to_purchase('${F1}', '${PD0}', 100)`).allocation_id;
const aR = rpc(`assign_freight_to_purchase('${F1}', '${PR}', 80)`).allocation_id;
const aV = rpc(`assign_freight_to_purchase('${F1}', '${PV}', 70)`).allocation_id;
const F2 = rpc(`register_freight('2026-08-11', 40, '${CAT_FD}', '${key()}', '${TRANS}', 'REM-2', NULL, 'flete')`).freight_id;
const PD = rpc(`rectify_purchase('${PD0}', 1200, 1452, ${lineJ}, 'ajuste de precio')`).new_purchase_id;
rpc(`pay_supplier('${SUP}', 1000, '2026-08-15', 'TRANSFER', '${BNA}', '${key()}')`);
// Mercado Pago: payment with fee + tax, yield, payout
const HDR = ['DATE', 'SOURCE_ID', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT', 'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'TAXES_AMOUNT',
  'PAYMENT_METHOD', 'TRANSACTION_APPROVAL_DATE', 'BUSINESS_UNIT', 'SUB_UNIT', 'BALANCE_AMOUNT', 'PAYMENT_METHOD_TYPE', 'PURCHASE_ID'];
const mpRow = (date, sid, desc, cr, db, gross, fee, tax) => Object.fromEntries(HDR.map((h, i) => [h, [date, sid, desc, cr, db, gross, fee, tax, 'available_money', date, '', '', '0.00', '', TAG][i]]));
const mpIngest = (row) => {
  const net = Number(row.NET_CREDIT_AMOUNT) - Number(row.NET_DEBIT_AMOUNT);
  const src = okAs(SVC, `INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
    VALUES ('csv_import', '${row.SOURCE_ID}:${row.DESCRIPTION}:${net > 0 ? 'C' : 'D'}', ${j(row)}, '${row.DATE}', (TIMESTAMPTZ '${row.DATE}' AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE) RETURNING id;`);
  rpcAs(SVC, `mp_normalize_source('${src}')`);
  return owner(`SELECT id FROM mp_financial_movement WHERE mp_source_record_id = '${src}';`);
};
// ADR-006 HRN-2: a Liberaciones payment row now parks DEFERRED_V4 (no movement), so the same economic movement is
// created as OWNER with the minimum internal rows (csv_import source, payment movement, report APPROVAL identity).
const mpOwnerPayment = (row) => {
  const ext = `${row.SOURCE_ID}:payment:C`;
  const src = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processed_at)
    VALUES ('csv_import', '${ext}', ${j(row)}, '${row.DATE}', (TIMESTAMPTZ '${row.DATE}' AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE, 'NORMALIZED', NOW()) RETURNING id;`);
  const mv = owner(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
    VALUES ('${src}', 'payment', ${row.GROSS_AMOUNT}, ${row.MP_FEE_AMOUNT}, ${row.TAXES_AMOUNT}, ${row.NET_CREDIT_AMOUNT}, (TIMESTAMPTZ '${row.DATE}' AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE) RETURNING id;`);
  owner(`INSERT INTO mp_transition_identity (resource_type, resource_id, transition, claimed_by_source_id, mp_financial_movement_id)
    VALUES ('report', '${ext}', 'APPROVAL', '${src}', ${mv});`);
  return mv;
};
const MPPAY = mpOwnerPayment(mpRow('2026-08-12T10:00:00.000-03:00', '8800000001', 'payment', '980.00', '0.00', '1000.00', '-12.00', '-8.00'));
const MPYLD = mpIngest(mpRow('2026-08-12T04:00:00.000-03:00', '8800000002', 'asset_management', '45.50', '0.00', '45.50', '0.00', '0.00'));
const MPOUT = mpIngest(mpRow('2026-08-13T10:00:00.000-03:00', '8800000003', 'payout', '0.00', '5000.00', '-4970.00', '0.00', '-30.00'));
rpc(`mp_reconcile_movement(${MPPAY}, 980, '${key()}', '${MPACC}', 'MP_SETTLEMENT')`);
// transfer between own accounts
rpc(`transfer_between_accounts('${CAJA}', '${BNA}', 500, '2026-08-14', '${key()}')`);
// management events outside Feria
const bna0 = cents(balance(BNA));
const RET = rpc(mgmtCall('RETIRO', '2026-08-20', 800, key(), 'retiro socio', BNA));
const RETC = rpc(mgmtCall('RETIRO', '2026-08-22', 300, key(), 'devolución parcial del retiro', null, RET.management_event_id));
const RES = rpc(mgmtCall('RESERVA_INTERNA', '2026-08-21', 1000, key(), 'reserva para reposición de plantel'));
const RESR = rpc(mgmtCall('RESERVA_INTERNA', '2026-08-25', 400, key(), 'liberación parcial', null, RES.management_event_id));
check('B1 scenario built through the real RPCs of Phases 14–23 and RPC 43 (no direct fact insert except the ADMIN PENDING-order path)', !!RESR.management_event_id);

// ═══════════════════════════════════════════════════════════════════════════
section('S', 'Sales (Ventas netas devengadas)');

check('S1 delivered identified sale counted once, at its CURRENT value (10·100 + 3·200 = 1600), dated delivered_date, drill-down to the Pedido',
  itemsOf('pedidos', PED) === 'VENTAS_NETAS|2026-08-05|1600.00', itemsOf('pedidos', PED));
check('S2 the rectified original value (2000) never appears; exactly one sales row per Pedido',
  okAs(ADMIN, `SELECT count(*) FROM pnl_line_item WHERE source_entity_type = 'pedidos' AND source_entity_id = '${PED}';`) === '1');
check('S3 the Feria aggregate CONSUMIDOR FINAL Pedido counts once (20·50 = 1000) on the session date',
  itemsOf('pedidos', AGG) === 'VENTAS_NETAS|2026-08-07|1000.00', itemsOf('pedidos', AGG));
check('S4 the collection (500) contributes nothing: no line item references it and sales = 2600',
  okAs(ADMIN, `SELECT count(*) FROM pnl_line_item WHERE source_entity_id = '${COL.collection_id ?? 'none'}';`) === '0' && bucketSum('VENTAS_NETAS') === 2600);

// ═══════════════════════════════════════════════════════════════════════════
section('P', 'Operating purchases (gross amount_total at economic_date)');

check('P1 DIRECT category OPERATING purchase → Costos directos, current rectified value only (−1452), drill-down to the current purchase row',
  itemsOf('purchases', PD) === 'COSTOS_DIRECTOS|2026-08-03|-1452.00' && itemsOf('purchases', PD0) === '', `${itemsOf('purchases', PD)} / ${itemsOf('purchases', PD0)}`);
check('P2 INDIRECT category OPERATING purchase → Costos indirectos (−605)', itemsOf('purchases', PI) === 'COSTOS_INDIRECTOS|2026-08-04|-605.00');
check('P3 the supplier payment (1000) adds zero cost: no line item comes from a payment / posting',
  okAs(ADMIN, `SELECT count(*) FROM pnl_line_item WHERE source_entity_type NOT IN ('pedidos','purchases','freight','freight_allocation','sales_session_cash_event','mp_financial_movement','management_event');`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Freight — every peso at most once');

check('F1 allocated to an OPERATING DIRECT purchase → Costos directos (−100) dated freight.economic_date (2026-08-10, not backdated), carried forward to the rectified purchase',
  itemsOf('freight_allocation', aD) === 'COSTOS_DIRECTOS|2026-08-10|-100.00'
  && owner(`SELECT purchase_id FROM freight_allocation WHERE id = '${aD}';`) === PD);
check('F2 allocated to a REINVESTMENT purchase → Reinversión (−80)', itemsOf('freight_allocation', aR) === 'REINVERSION|2026-08-10|-80.00');
check('F3 allocated to an INVESTMENT purchase → Inversiones (−70)', itemsOf('freight_allocation', aV) === 'INVERSIONES|2026-08-10|-70.00');
check('F4 the unallocated remainder uses the freight\'s own class (INDIRECT, −50)', itemsOf('freight', F1) === 'COSTOS_INDIRECTOS|2026-08-10|-50.00');
check('F5 a fully unallocated freight (DIRECT category) → Costos directos (−40)', itemsOf('freight', F2) === 'COSTOS_DIRECTOS|2026-08-11|-40.00');
check('F6 every freight peso counted at most once: F1 contributions sum to exactly −300 = −freight.amount (100 + 80 + 70 + 50)',
  okAs(ADMIN, `SELECT SUM(signed_amount) FROM pnl_line_item WHERE (source_entity_type = 'freight' AND source_entity_id = '${F1}')
     OR (source_entity_type = 'freight_allocation' AND source_entity_id IN ('${aD}','${aR}','${aV}'));`) === '-300.00');

// ═══════════════════════════════════════════════════════════════════════════
section('R', 'Reinvestment / Investment');

check('R1 REINVESTMENT purchase → Reinversión (−5000) + its allocated freight (−80) = −5080', itemsOf('purchases', PR) === 'REINVERSION|2026-08-08|-5000.00' && bucketSum('REINVERSION') === -5080);
check('R2 INVESTMENT purchase → Inversiones (−20000) + its allocated freight (−70) = −20070', itemsOf('purchases', PV) === 'INVERSIONES|2026-08-09|-20000.00' && bucketSum('INVERSIONES') === -20070);

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Feria session cash');

check('E1 EXPENSE classified by its category: INDIRECT −150, DIRECT −70',
  itemsOf('sales_session_cash_event', exI.event_id) === 'COSTOS_INDIRECTOS|2026-08-07|-150.00' && itemsOf('sales_session_cash_event', exD.event_id) === 'COSTOS_DIRECTOS|2026-08-07|-70.00');
check('E2 WITHDRAWAL → Retiros (−300)', itemsOf('sales_session_cash_event', wd.event_id) === 'RETIROS|2026-08-07|-300.00');
check('E3 OPENING_FUND, TRANSFER_OUT and COUNT contribute nothing',
  itemsOf('sales_session_cash_event', tout.event_id) === '' && itemsOf('sales_session_cash_event', cnt.event_id) === ''
  && okAs(ADMIN, `SELECT count(*) FROM pnl_line_item l JOIN sales_session_cash_event e ON e.id::TEXT = l.source_entity_id AND l.source_entity_type = 'sales_session_cash_event'
     WHERE e.event_type IN ('OPENING_FUND','TRANSFER_OUT','COUNT');`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('M', 'Mercado Pago (authority = mp_financial_movement components)');

check('M1 MP payment: no revenue line (the sale is the Pedido); only its fee appears: Costos indirectos −12 exactly once',
  itemsOf('mp_financial_movement', MPPAY) === 'COSTOS_INDIRECTOS|2026-08-12|-12.00');
check('M2 MP yield → Otros ingresos financieros (+45.50), dated occurred_date', itemsOf('mp_financial_movement', MPYLD) === 'OTROS_INGRESOS_FINANCIEROS|2026-08-12|45.50');
check('M3 MP payout (transfer) contributes nothing; its tax (−30) and the payment tax (−8) are excluded', itemsOf('mp_financial_movement', MPOUT) === ''
  && okAs(ADMIN, `SELECT count(*) FROM pnl_line_item WHERE source_entity_type = 'mp_financial_movement' AND signed_amount IN (-8, -30);`) === '0');
const beforeFee = snapshotPnl();
rpc(`mp_reconcile_movement(${MPOUT}, -12, '${key()}', '${MPACC}', 'FEE')`);
check('M4 a Mode 1 FEE operation / posting is never counted a second time: the P&L is unchanged', snapshotPnl() === beforeFee);

// ═══════════════════════════════════════════════════════════════════════════
section('T', 'Treasury and fiscal layers contribute nothing');

const beforeFiscal = snapshotPnl();
const doc = rpc(`register_fiscal_document('INVOICE_A', 'CREDITO', '2026-08-03', '2026-08-01', 1000, 1210, ${j([{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 1000, rate_applied: 21, tax_amount: 210 }])}, '${SUP}', NULL, 'A-0001-99')`);
const obl = rpc(`register_fiscal_obligation('IVA', '2026-08-01', 210)`);
rpc(`pay_fiscal_obligation('${obl.obligation_id}', '2026-08-20', 210, '${BNA}', '${key()}')`);
check('T1 fiscal document, components, obligation and payment add zero P&L rows (ADR-004: fiscal layer excluded, IVA and other tax kinds included)',
  snapshotPnl() === beforeFiscal && !!doc.fiscal_document_id);
const beforeTr = snapshotPnl();
rpc(`transfer_between_accounts('${BNA}', '${CAJA}', 100, '2026-08-23', '${key()}')`);
check('T2 a transfer between own accounts adds nothing', snapshotPnl() === beforeTr);

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'Management events (RPC 43)');

check('G1 RETIRO (outside Feria) → Retiros −800; its compensation → +300; drill-down to each management_event',
  itemsOf('management_event', RET.management_event_id) === 'RETIROS|2026-08-20|-800.00' && itemsOf('management_event', RETC.management_event_id) === 'RETIROS|2026-08-22|300.00');
check('G2 RETIRO moves money exactly once: one OWNER_WITHDRAWAL operation per event, posting −800 then +300 on BNA; external_ref MGMT:<key>',
  owner(`SELECT o.operation_type || '|' || p.signed_amount || '|' || p.financial_account_id || '|' || left(o.external_ref, 5) FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id WHERE o.id = ${RET.financial_operation_id};`)
  === `OWNER_WITHDRAWAL|-800.00|${BNA}|MGMT:`
  && owner(`SELECT p.signed_amount FROM financial_posting p WHERE p.financial_operation_id = ${RETC.financial_operation_id};`) === '300.00'
  && cents(balance(BNA)) - bna0 === 100 * (-800 + 300 - 210 - 100));   // retiro, compensation, fiscal payment (T1), transfer out of BNA (T2)
check('G3 RESERVA_INTERNA → Reservas internas −1000, release +400; it creates no operation and no posting',
  itemsOf('management_event', RES.management_event_id) === 'RESERVAS_INTERNAS|2026-08-21|-1000.00' && itemsOf('management_event', RESR.management_event_id) === 'RESERVAS_INTERNAS|2026-08-25|400.00'
  && RES.financial_operation_id === null && RESR.financial_operation_id === null);
const cntRow = () => owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_operation) || '|' || (SELECT count(*) FROM financial_posting) || '|' || (SELECT count(*) FROM audit_events) FROM management_event;`);
let snap = cntRow();
const dupKey = key();
rpc(mgmtCall('RESERVA_INTERNA', '2026-08-26', 10, dupKey, 'reserva'));
snap = cntRow();
for (const [what, fn, call, code] of [
  ['duplicate idempotency key', ADMIN, mgmtCall('RESERVA_INTERNA', '2026-08-26', 10, dupKey, 'otra'), 'DUPLICATE_MANAGEMENT_EVENT'],
  ['OPERATOR', OPER, mgmtCall('RESERVA_INTERNA', '2026-08-26', 10, key(), 'x'), 'FORBIDDEN'],
  ['amount 0', ADMIN, mgmtCall('RESERVA_INTERNA', '2026-08-26', 0, key(), 'x'), 'INVALID_AMOUNT'],
  ['negative amount', ADMIN, mgmtCall('RETIRO', '2026-08-26', -5, key(), 'x', BNA), 'INVALID_AMOUNT'],
  ['blank reason', ADMIN, mgmtCall('RESERVA_INTERNA', '2026-08-26', 10, key(), '  '), 'REASON_REQUIRED'],
  ['96-character key', ADMIN, mgmtCall('RESERVA_INTERNA', '2026-08-26', 10, 'k'.repeat(96), 'x'), 'INVALID_IDEMPOTENCY_KEY'],
  ['RETIRO without account', ADMIN, mgmtCall('RETIRO', '2026-08-26', 10, key(), 'x'), 'ACCOUNT_REQUIRED'],
  ['RESERVA with an account', ADMIN, mgmtCall('RESERVA_INTERNA', '2026-08-26', 10, key(), 'x', BNA), 'ACCOUNT_NOT_ALLOWED'],
  ['compensation exceeding the original outstanding (300 + 600 > 800)', ADMIN, mgmtCall('RETIRO', '2026-08-26', 600, key(), 'x', null, RET.management_event_id), 'COMPENSATION_EXCEEDS_ORIGINAL'],
  ['compensation of another type', ADMIN, mgmtCall('RESERVA_INTERNA', '2026-08-26', 10, key(), 'x', null, RET.management_event_id), 'COMPENSATION_TYPE_MISMATCH'],
  ['compensating a compensation', ADMIN, mgmtCall('RETIRO', '2026-08-26', 10, key(), 'x', null, RETC.management_event_id), 'INVALID_COMPENSATION_TARGET'],
  ['RETIRO compensation to another account', ADMIN, mgmtCall('RETIRO', '2026-08-26', 10, key(), 'x', CAJA, RET.management_event_id), 'ACCOUNT_MISMATCH'],
  ['compensation of a missing event', ADMIN, mgmtCall('RESERVA_INTERNA', '2026-08-26', 10, key(), 'x', null, MISSING_UUID), 'EVENT_NOT_FOUND'],
  ['missing period (2027)', ADMIN, mgmtCall('RESERVA_INTERNA', '2027-02-10', 10, key(), 'x'), 'PERIOD_NOT_FOUND'],
]) {
  r = fn(`SELECT ${call};`);
  check(`G4 ${what} → ${code}; nothing written`, raised(r, code) && cntRow() === snap, firstErr(r));
}
closePeriod('2026-03-01');
r = ADMIN(`SELECT ${mgmtCall('RETIRO', '2026-03-10', 10, key(), 'x', BNA)};`);
check('G5 effective_date in a CLOSED month → PERIOD_CLOSED; no event, operation or posting', raised(r, 'PERIOD_CLOSED') && cntRow() === snap, firstErr(r));
openPeriod('2026-03-01');
const fin = rpc(mgmtCall('RESERVA_INTERNA', '2026-08-27', 600, key(), 'liberación total', null, RES.management_event_id));
r = ADMIN(`SELECT ${mgmtCall('RESERVA_INTERNA', '2026-08-27', 1, key(), 'x', null, RES.management_event_id)};`);
check('G6 a reserve can be released exactly up to its amount (400 + 600 = 1000); one more is refused', !!fin.management_event_id && raised(r, 'COMPENSATION_EXCEEDS_ORIGINAL'), firstErr(r));
check('G7 audit: CREATE for originals, COMPENSATE for compensations, with type, amount, link, account, operation and actor',
  owner(`SELECT action || '|' || (after_values->>'event_type') || '|' || (after_values->>'amount') || '|' || coalesce(after_values->>'compensates_event_id', '-') || '|' || performed_by
     FROM audit_events WHERE entity_type = 'management_event' AND entity_id = '${RETC.management_event_id}';`) === `COMPENSATE|RETIRO|300|${RET.management_event_id}|${ADMIN_UID}`
  && owner(`SELECT action FROM audit_events WHERE entity_type = 'management_event' AND entity_id = '${RES.management_event_id}';`) === 'CREATE');
const direct = [ADMIN(`UPDATE management_event SET amount = 1;`), ADMIN(`DELETE FROM management_event;`),
  ADMIN(`INSERT INTO management_event (event_type, effective_date, amount, idempotency_key, reason) VALUES ('RESERVA_INTERNA', '2026-08-01', 1, 'x', 'x');`), OPER(`DELETE FROM management_event;`)];
check('G8 append-only: no direct INSERT / UPDATE / DELETE for ADMIN or OPERATOR (RPC 43 only)', direct.every(denied), direct.map(firstErr).join(' | '));

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Management-event concurrency (independent PostgreSQL sessions)');

// all concurrency facts live in 2026-09 so the 2026-08 summary stays exact
const evCount = (orig) => owner(`SELECT count(*) || '|' || coalesce(SUM(amount), 0) FROM management_event WHERE compensates_event_id = '${orig}';`);
const auditCount = () => owner(`SELECT count(*) FROM audit_events WHERE entity_type = 'management_event';`);
const cRes = rpc(mgmtCall('RESERVA_INTERNA', '2026-09-05', 1000, key(), 'reserva concurrente'));
let a0 = auditCount();
let x = await race(`SELECT ${mgmtCall('RESERVA_INTERNA', '2026-09-06', 600, key(), 'liberación A', null, cRes.management_event_id)};`,
  `SELECT ${mgmtCall('RESERVA_INTERNA', '2026-09-06', 600, key(), 'liberación B', null, cRes.management_event_id)};`, 'p24-res');
check('C1 concurrent reserve releases 600 + 600 on a 1000 reserve: B waited on the ORIGINAL row lock, then COMPENSATION_EXCEEDS_ORIGINAL; one release (600), one audit',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'COMPENSATION_EXCEEDS_ORIGINAL') && evCount(cRes.management_event_id) === '1|600.00'
  && Number(auditCount()) === Number(a0) + 1, `${firstErr(x.rb)} ${evCount(cRes.management_event_id)}`);
const cRet = rpc(mgmtCall('RETIRO', '2026-09-07', 1000, key(), 'retiro concurrente', BNA));
const postOf = () => owner(`SELECT count(*) || '|' || coalesce(SUM(p.signed_amount), 0) FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id
  WHERE o.operation_type = 'OWNER_WITHDRAWAL' AND o.source_entity_id IN (SELECT id::TEXT FROM management_event WHERE id = '${cRet.management_event_id}' OR compensates_event_id = '${cRet.management_event_id}');`);
a0 = auditCount();
x = await race(`SELECT ${mgmtCall('RETIRO', '2026-09-08', 600, key(), 'devolución A', null, cRet.management_event_id)};`,
  `SELECT ${mgmtCall('RETIRO', '2026-09-08', 600, key(), 'devolución B', null, cRet.management_event_id)};`, 'p24-ret');
check('C2 concurrent RETIRO compensations 600 + 600 on a 1000 retiro: B waited, then COMPENSATION_EXCEEDS_ORIGINAL; money returned 600 ≤ 1000: exactly 2 OWNER_WITHDRAWAL postings (−1000, +600)',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'COMPENSATION_EXCEEDS_ORIGINAL') && evCount(cRet.management_event_id) === '1|600.00'
  && postOf() === '2|-400.00' && Number(auditCount()) === Number(a0) + 1, `${firstErr(x.rb)} ${postOf()}`);
const dupRet = key();
a0 = auditCount();
x = await race(`SELECT ${mgmtCall('RETIRO', '2026-09-09', 50, dupRet, 'retiro A', BNA)};`, `SELECT ${mgmtCall('RETIRO', '2026-09-09', 50, dupRet, 'retiro B', BNA)};`, 'p24-key');
check('C3 the same idempotency key concurrently (RETIRO): B waited, then DUPLICATE_MANAGEMENT_EVENT; exactly one event, one OWNER_WITHDRAWAL operation, one posting, one audit',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_MANAGEMENT_EVENT')
  && owner(`SELECT (SELECT count(*) FROM management_event WHERE idempotency_key = '${dupRet}') || '|' || (SELECT count(*) FROM financial_operation WHERE external_ref = 'MGMT:${dupRet}')
     || '|' || (SELECT count(*) FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id WHERE o.external_ref = 'MGMT:${dupRet}');`) === '1|1|1'
  && Number(auditCount()) === Number(a0) + 1, firstErr(x.rb));
const dupRes = key();
a0 = auditCount();
x = await race(`SELECT ${mgmtCall('RESERVA_INTERNA', '2026-09-10', 70, dupRes, 'reserva A')};`, `SELECT ${mgmtCall('RESERVA_INTERNA', '2026-09-10', 70, dupRes, 'reserva B')};`, 'p24-key2');
check('C4 the same idempotency key concurrently (RESERVA_INTERNA): B waited, then DUPLICATE_MANAGEMENT_EVENT; exactly one event and one audit, no treasury row',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_MANAGEMENT_EVENT')
  && owner(`SELECT count(*) || '|' || count(financial_operation_id) FROM management_event WHERE idempotency_key = '${dupRes}';`) === '1|0'
  && Number(auditCount()) === Number(a0) + 1, firstErr(x.rb));

// ═══════════════════════════════════════════════════════════════════════════
section('SUM', 'Exact arithmetic through every subtotal (period 2026-08)');

// expected, by hand:
//   ventas            = 1600 + 1000                                   =   2600.00
//   directos          = −1452 − 100 − 40 − 70                          =  −1662.00
//   indirectos        = −605 − 50 − 150 − 12                           =   −817.00
//   operativo         = 2600 − 1662 − 817                              =    121.00
//   otros             = +45.50                    → antes reinversión  =    166.50
//   reinversión       = −5000 − 80                → post-reinversión   =  −4913.50
//   retiros           = −300 − 800 + 300          → disponible         =  −5713.50
//   reservas          = −1000 + 400 − 10 + 600    → post-reservas      =  −5723.50   (G4 setup adds a 10 reserve, G6 releases 600)
//   inversiones       = −20000 − 70               → post-inversiones   = −25793.50
const S = summary();
const want = {
  ventas_netas_devengadas: 2600, costos_directos: -1662, costos_indirectos: -817, resultado_operativo: 121,
  otros_ingresos_financieros: 45.5, resultado_antes_de_reinversion: 166.5, reinversion: -5080, resultado_post_reinversion: -4913.5,
  retiros: -800, disponible_post_retiros: -5713.5, reservas_internas: 0 - 1000 + 400 - 10 + 600, post_reservas: -5713.5 - 10,
  inversiones: -20070, resultado_post_inversiones: -5723.5 - 20070,
};
for (const [k2, v] of Object.entries(want)) check(`SUM ${k2} = ${v}`, S && cents(S[k2]) === Math.round(v * 100), S && S[k2]);
check('SUM every subtotal equals the running sum of its buckets as read from pnl_line_item',
  S && cents(S.resultado_post_inversiones) === Math.round(['VENTAS_NETAS', 'COSTOS_DIRECTOS', 'COSTOS_INDIRECTOS', 'OTROS_INGRESOS_FINANCIEROS', 'REINVERSION',
    'RETIROS', 'RESERVAS_INTERNAS', 'INVERSIONES'].reduce((a, b) => a + bucketSum(b), 0) * 100));

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Drill-down reaches source facts');

const orphans = okAs(ADMIN, `SELECT count(*) FROM pnl_line_item l WHERE NOT (
     (l.source_entity_type = 'pedidos' AND EXISTS (SELECT 1 FROM pedidos x WHERE x.id::TEXT = l.source_entity_id AND x.estado = 'DELIVERED'))
  OR (l.source_entity_type = 'purchases' AND EXISTS (SELECT 1 FROM purchases x WHERE x.id::TEXT = l.source_entity_id AND x.is_current))
  OR (l.source_entity_type = 'freight' AND EXISTS (SELECT 1 FROM freight x WHERE x.id::TEXT = l.source_entity_id))
  OR (l.source_entity_type = 'freight_allocation' AND EXISTS (SELECT 1 FROM freight_allocation x WHERE x.id::TEXT = l.source_entity_id))
  OR (l.source_entity_type = 'sales_session_cash_event' AND EXISTS (SELECT 1 FROM sales_session_cash_event x WHERE x.id::TEXT = l.source_entity_id))
  OR (l.source_entity_type = 'mp_financial_movement' AND EXISTS (SELECT 1 FROM mp_financial_movement x WHERE x.id::TEXT = l.source_entity_id))
  OR (l.source_entity_type = 'management_event' AND EXISTS (SELECT 1 FROM management_event x WHERE x.id::TEXT = l.source_entity_id)));`);
check('D1 every line item resolves to its original source fact (0 orphans)', orphans === '0', orphans);
check('D2 category / nature / project carried for purchase-derived rows (allocated freight carries the DESTINATION purchase category and nature)',
  okAs(ADMIN, `SELECT expense_category_id || '|' || nature FROM pnl_line_item WHERE source_entity_type = 'freight_allocation' AND source_entity_id = '${aR}';`) === `${CAT_D}|REINVESTMENT`);
check('D3 the scenario period holds only this scenario\'s facts (22 line items: 2 sales, 4 purchases, 3 allocations, 2 unallocated freight, 3 Feria, 2 MP, 6 management events)',
  okAs(ADMIN, `SELECT count(*) FROM pnl_line_item WHERE period = '${PERIOD}';`) === '22');

// ═══════════════════════════════════════════════════════════════════════════
section('X', 'Security and no storage');

check('X1 ADMIN sees line items and the summary', Number(okAs(ADMIN, `SELECT count(*) FROM pnl_line_item;`)) > 0 && Number(okAs(ADMIN, `SELECT count(*) FROM pnl_summary;`)) > 0);
check('X2 OPERATOR sees zero result rows in both views and zero management events',
  okAs(OPER, `SELECT count(*) FROM pnl_line_item;`) === '0' && okAs(OPER, `SELECT count(*) FROM pnl_summary;`) === '0' && okAs(OPER, `SELECT count(*) FROM management_event;`) === '0');
const outsiders = [ANON(`SELECT 1 FROM pnl_line_item;`), ANON(`SELECT 1 FROM pnl_summary;`), SVC(`SELECT 1 FROM pnl_line_item;`), SVC(`SELECT 1 FROM pnl_summary;`),
  ANON(`SELECT 1 FROM management_event;`), SVC(`SELECT 1 FROM management_event;`), ANON(`SELECT ${mgmtCall('RESERVA_INTERNA', '2026-08-26', 1, key(), 'x')};`),
  SVC(`SELECT ${mgmtCall('RESERVA_INTERNA', '2026-08-26', 1, key(), 'x')};`)];
check('X3 anon and service_role: no access to the views, management_event or RPC 43', outsiders.every(denied), outsiders.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
check('X4 no SECURITY DEFINER reporting function: the definer inventory is the previous 40 + RPC 43 register_management_event',
  owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`) === ALL_DEFINERS);
check('X5 RPC 43 hardening: DEFINER, search_path=public, owner postgres, no PUBLIC, EXECUTE for authenticated only',
  owner(`SELECT prosecdef || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || ':' || pg_get_userbyid(proowner) || ':'
     || has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE')
     FROM pg_proc WHERE proname = 'register_management_event';`) === 'true:true:postgres:false:true:false');
check('X6 exact grants: views and management_event SELECT for authenticated only',
  owner(`SELECT string_agg(relname || '=' || relacl::TEXT, ' ' ORDER BY relname) FROM pg_class WHERE relname IN ('pnl_line_item','pnl_summary','management_event');`)
  === 'management_event={postgres=arwdDxtm/postgres,authenticated=r/postgres} pnl_line_item={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'pnl_summary={postgres=arwdDxtm/postgres,authenticated=r/postgres}');
} finally {
  cleanup();
}

section('Z', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM management_event WHERE idempotency_key LIKE '${K}%') + (SELECT count(*) FROM expense_category WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM suppliers WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM clients WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM mp_source_record)
  + (SELECT count(*) FROM sales_session WHERE idempotency_key LIKE '${K}%') + (SELECT count(*) FROM fiscal_obligation);`);
check('Z1 every P24-TEST fact, master, MP row and fixture operation removed', left === '0', left);
check('Z2 periods closed by the suite are OPEN again',
  owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`) === '0');

console.log(`\n  ══ PNL RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
