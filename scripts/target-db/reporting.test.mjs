#!/usr/bin/env node
/**
 * PHASE 25 — DASHBOARD / REPORTS TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Proves the 0046 reporting layer (ADR-005): reporting reads derived values
 * only, respects RLS, and exposes no cost data to OPERATOR.
 *
 * One synthetic scenario (May–July 2026) is built through the real RPCs and the
 * frozen ADMIN master paths. Every expected figure is computed by hand in this
 * file.
 *
 * Fixtures: masters named "R25-TEST …", keys starting "R25-TEST:". Cleanup
 * removes every fact the scenario created (MP rows included).
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/reporting.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
const TAG = 'R25-TEST';
const K = `${TAG}:`;
const GEN = `${TAG} linea`;
const VIEWS = ['report_balance_period', 'report_classification_day', 'report_feed_consumption_interval', 'report_feria_session_cash',
  'report_flock_day', 'report_mp_movement_status', 'report_sales_line'];
const ADMIN_ONLY = ['report_sales_line', 'report_balance_period', 'report_mp_movement_status', 'report_feria_session_cash', 'report_feed_consumption_interval'];
const ALL_DEFINERS = 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,'
  + 'close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,'
  + 'open_sales_session,pay_fiscal_obligation,pay_supplier,receive_cheque,'
  + 'rectify_daily_production,rectify_delivered_order,rectify_mortality,rectify_purchase,register_classification,register_collection,'
  + 'register_count_adjustment,register_daily_production,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,'
  + 'register_fiscal_document,register_fiscal_obligation,'
  + 'register_freight,register_management_event,register_mortality,register_purchase,register_session_cash_event,register_session_movement,reject_cheque,'
  + 'reject_supplier_instrument,transfer_between_accounts';
const MONEY = /(^|_)(amount|precio|price|prices|cost|costs|subtotal|balance|saldo|fee|fees|tax|taxes|gross|net|cash|variance|importe|monto)(_|$)/i;

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

function okAs(fn, sqlText) {
  const r = fn(sqlText);
  if (!r.ok) throw new Error(`SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const rpcAs = (fn, call) => JSON.parse(okAs(fn, `SELECT ${call};`));
const rpc = (call) => rpcAs(ADMIN, call);
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 200);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);

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

// ── fixture lifecycle ──────────────────────────────────────────────────────
const TSUP = `(SELECT id FROM suppliers WHERE nombre LIKE '${TAG}%')`;
const TCLI = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
const TF = `(SELECT f.id FROM flocks f JOIN sheds s ON s.id = f.shed_id WHERE s.nombre LIKE '${TAG}%')`;
const FT = `(SELECT id FROM feed_type WHERE nombre LIKE '${TAG}%')`;
const FV = `(SELECT id FROM feed_formula_version WHERE feed_type_id IN ${FT})`;
const TC = `(SELECT id FROM classification WHERE location LIKE '${TAG}%')`;
function cleanup() {
  owner(`
CREATE TEMP TABLE _ses AS SELECT id FROM sales_session WHERE idempotency_key LIKE '${K}%';
CREATE TEMP TABLE _ped AS SELECT id FROM pedidos WHERE cliente_id IN ${TCLI};
CREATE TEMP TABLE _pur AS SELECT id FROM purchases WHERE supplier_id IN ${TSUP};
CREATE TEMP TABLE _op AS
        SELECT id FROM financial_operation WHERE external_ref LIKE '${K}%' OR external_ref LIKE 'MP:${K}%'
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'sales_session' AND source_entity_id IN (SELECT id::TEXT FROM _ses)
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'mp_financial_movement'
  UNION SELECT id FROM financial_operation WHERE source_entity_type IN ('collections', 'collection')
          AND source_entity_id IN (SELECT id::TEXT FROM collections WHERE cliente_id IN ${TCLI});
-- feed movements reference Pedidos (EXTERNAL_SALE): removed before the commercial facts
DELETE FROM audit_events WHERE entity_type = 'feed_movement' AND entity_id IN (SELECT id::TEXT FROM feed_movement WHERE feed_type_id IN ${FT});
DELETE FROM feed_movement WHERE feed_type_id IN ${FT};
-- MP (written only by the MP-related suites; each removes every MP row)
DELETE FROM audit_events WHERE entity_type IN ('mp_reconciliation', 'mp_source_record');
DELETE FROM mp_report_match;          -- ADR-006 HRN-4: dependents of movement / source, in FK order
DELETE FROM mp_transition_identity;
DELETE FROM mp_reconciliation;
DELETE FROM mp_financial_movement;
DELETE FROM mp_source_record;
-- feria
DELETE FROM audit_events WHERE entity_type = 'sales_session_cash_event' AND entity_id IN (SELECT id::TEXT FROM sales_session_cash_event WHERE sales_session_id IN (SELECT id FROM _ses));
DELETE FROM sales_session_cash_event WHERE sales_session_id IN (SELECT id FROM _ses);
DELETE FROM audit_events WHERE entity_type = 'sales_session' AND entity_id IN (SELECT id::TEXT FROM _ses);
DELETE FROM sales_session WHERE id IN (SELECT id FROM _ses);
-- commercial
DELETE FROM audit_events WHERE entity_type = 'pedido' AND entity_id IN (SELECT id::TEXT FROM _ped);
DELETE FROM client_ledger WHERE cliente_id IN ${TCLI};
DELETE FROM audit_events WHERE entity_type = 'collections' AND entity_id IN (SELECT id::TEXT FROM collections WHERE cliente_id IN ${TCLI});
DELETE FROM collections WHERE cliente_id IN ${TCLI};
DELETE FROM pedido_lineas WHERE pedido_id IN (SELECT id FROM _ped);
DELETE FROM pedidos WHERE id IN (SELECT id FROM _ped);
-- purchases
DELETE FROM audit_events WHERE entity_type = 'purchases' AND entity_id IN (SELECT id::TEXT FROM _pur);
DELETE FROM supplier_ledger WHERE supplier_id IN ${TSUP};
DELETE FROM purchase_attachment WHERE purchase_id IN (SELECT id FROM _pur);
DELETE FROM purchase_line WHERE purchase_id IN (SELECT id FROM _pur);
DELETE FROM purchases WHERE id IN (SELECT id FROM _pur);
-- treasury consequences
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
-- classification
DELETE FROM audit_events WHERE entity_type = 'classification' AND entity_id IN (SELECT id::TEXT FROM classification WHERE location LIKE '${TAG}%');
DELETE FROM classification_line WHERE classification_id IN ${TC};
DELETE FROM classification WHERE id IN ${TC};
DELETE FROM classification_grade WHERE nombre LIKE '${TAG}%';
-- feed
DELETE FROM audit_events WHERE entity_type = 'feed_manufacturing' AND entity_id IN (SELECT id::TEXT FROM feed_manufacturing WHERE formula_version_id IN ${FV});
DELETE FROM audit_events WHERE entity_type = 'feed_inventory_count' AND entity_id IN (SELECT id::TEXT FROM feed_inventory_count WHERE feed_type_id IN ${FT});
DELETE FROM audit_events WHERE entity_type = 'feed_movement' AND entity_id IN (SELECT id::TEXT FROM feed_movement WHERE feed_type_id IN ${FT});
DELETE FROM audit_events WHERE entity_type = 'flock_feed_assignment' AND entity_id IN (SELECT id::TEXT FROM flock_feed_assignment WHERE feed_type_id IN ${FT} OR flock_id IN ${TF});
DELETE FROM feed_manufacturing WHERE formula_version_id IN ${FV};
DELETE FROM feed_formula_line WHERE formula_version_id IN ${FV};
DELETE FROM feed_formula_version WHERE feed_type_id IN ${FT};
DELETE FROM feed_movement WHERE feed_type_id IN ${FT};
DELETE FROM feed_inventory_count WHERE feed_type_id IN ${FT};
DELETE FROM flock_feed_assignment WHERE feed_type_id IN ${FT} OR flock_id IN ${TF};
-- production
DELETE FROM audit_events WHERE entity_type = 'daily_production' AND entity_id IN (SELECT id::TEXT FROM daily_production WHERE flock_id IN ${TF});
DELETE FROM audit_events WHERE entity_type = 'population_events' AND entity_id IN (SELECT id::TEXT FROM population_events WHERE flock_id IN ${TF});
UPDATE daily_production SET superseded_by = NULL WHERE flock_id IN ${TF};
DELETE FROM daily_production WHERE flock_id IN ${TF};
UPDATE population_events SET superseded_by = NULL WHERE flock_id IN ${TF};
DELETE FROM population_events WHERE flock_id IN ${TF};
DELETE FROM operator_assignments WHERE flock_id IN ${TF};
DELETE FROM flocks WHERE id IN ${TF};
DELETE FROM sheds WHERE nombre LIKE '${TAG}%';
-- masters
DELETE FROM genetics_consumption_curve WHERE genetics_line = '${GEN}';
DELETE FROM feed_ingredient WHERE nombre LIKE '${TAG}%';
DELETE FROM feed_type WHERE nombre LIKE '${TAG}%';
DELETE FROM products WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
DELETE FROM suppliers WHERE nombre LIKE '${TAG}%';
DELETE FROM expense_category WHERE nombre LIKE '${TAG}%';`);
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
const j = (v) => `'${esc(JSON.stringify(v))}'::jsonb`;
const cents = (v) => Math.round(Number(v) * 100);
const viewDef = (v) => owner(`SELECT pg_get_viewdef('${v}'::regclass);`);

let r;

try {
// ── masters ────────────────────────────────────────────────────────────────
const CAT = okAs(ADMIN, `INSERT INTO expense_category (nombre, pnl_cost_class) VALUES ('${TAG} Insumos', 'DIRECT') RETURNING id;`);
const SUP = okAs(ADMIN, `INSERT INTO suppliers (nombre) VALUES ('${TAG} Proveedor') RETURNING id;`);
const CLI = okAs(ADMIN, `INSERT INTO clients (nombre) VALUES ('${TAG} Cliente') RETURNING id;`);
const PROD = okAs(ADMIN, `INSERT INTO products (nombre, product_type) VALUES ('${TAG} Huevo', 'VENDIBLE') RETURNING id;`);
const PROD2 = okAs(ADMIN, `INSERT INTO products (nombre, product_type) VALUES ('${TAG} Maple', 'VENDIBLE') RETURNING id;`);
const CAJA = owner(`SELECT id FROM financial_account WHERE nombre = 'Caja chica';`);
const BNA = owner(`SELECT id FROM financial_account WHERE nombre = 'BNA';`);
const MPACC = owner(`SELECT id FROM financial_account WHERE nombre = 'Mercado Pago';`);
let shedSeq = 0;
const flock = (name, initial) => {
  const shed = owner(`INSERT INTO sheds (nombre) VALUES ('${TAG} ${name} #${++shedSeq}') RETURNING id;`);
  return owner(`INSERT INTO flocks (shed_id, entry_date, initial_population, estado, genetics_line, birth_date)
    VALUES ('${shed}', '2026-04-01', ${initial}, 'ACTIVE', '${GEN}', '2026-01-01') RETURNING id;`);
};
const FA = flock('Galpon A', 1000);   // assigned to the operator
const FB = flock('Galpon B', 500);    // not assigned
const FC = flock('Galpon C', 10);     // population reaches 0 and then −1
okAs(ADMIN, `INSERT INTO operator_assignments (operator_id, flock_id, assigned_by) VALUES ('${OPA}', '${FA}', '${ADMIN_UID}');`);
// curve: g/bird/day = 100 + week, expected laying % = 50 + week
okAs(ADMIN, `INSERT INTO genetics_consumption_curve (genetics_line, age_weeks, expected_g_per_bird_day, expected_laying_pct)
  SELECT '${GEN}', w, 100 + w, 50 + w FROM generate_series(0, 50) w;`);

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Scenario (real RPCs and frozen master paths)');

// production (FA: mortality 5 on 05-01, +3 adjustment on 05-03; FB: broken > total; FC: population 0, then −1)
rpc(`register_daily_production('${FA}', '2026-05-01', 900, 20, 10)`);
rpc(`register_mortality('${FA}', '2026-05-01', 5)`);
rpc(`register_count_adjustment('${FA}', '2026-05-03', 3, 'recuento')`);
rpc(`register_daily_production('${FA}', '2026-05-03', 800, 0, 0)`);
rpc(`register_daily_production('${FB}', '2026-05-01', 10, 12, 0)`);
rpc(`register_mortality('${FC}', '2026-05-04', 10)`);
rpc(`register_daily_production('${FC}', '2026-05-04', 0, 0, 0)`);
rpc(`register_count_adjustment('${FC}', '2026-05-05', -1, 'faltante')`);
rpc(`register_daily_production('${FC}', '2026-05-05', 1, 0, 0)`);
// feed: FA and FB fed FT from 04-01; counts 05-01 = 1000, 05-03 = 900, 06-01 = 900
const FTID = okAs(ADMIN, `INSERT INTO feed_type (nombre, feed_category) VALUES ('${TAG} Postura', 'LAYER') RETURNING id;`);
const ING = okAs(ADMIN, `INSERT INTO feed_ingredient (nombre) VALUES ('${TAG} Maiz') RETURNING id;`);
const FVID = okAs(ADMIN, `INSERT INTO feed_formula_version (feed_type_id, version, effective_from, created_by) VALUES ('${FTID}', 1, '2026-01-01', '${ADMIN_UID}') RETURNING id;`);
okAs(ADMIN, `INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg, unit_cost_snapshot) VALUES ('${FVID}', '${ING}', 1000, 55.55);`);
rpc(`assign_flock_feed('${FA}', '${FTID}', '2026-04-01')`);
rpc(`assign_flock_feed('${FB}', '${FTID}', '2026-04-01')`);
rpc(`register_feed_inventory_count('${FTID}', '2026-05-01', 1000)`);
rpc(`register_feed_manufacturing('${FVID}', '2026-05-01', 70, '${key()}')`);          // opening-count day: belongs to the earlier period
rpc(`register_feed_manufacturing('${FVID}', '2026-05-02', 500, '${key()}')`);
rpc(`register_feed_movement('${FTID}', 'LOSS', 5, '2026-05-02', NULL, 'rotura')`);
rpc(`register_feed_movement('${FTID}', 'ADJUSTMENT_POSITIVE', 40, '2026-05-02', NULL, 'pesaje')`);
const FPED = okAs(ADMIN, `INSERT INTO pedidos (cliente_id, created_by) VALUES ('${CLI}', '${ADMIN_UID}') RETURNING id;`);   // pending: never a sale
rpc(`register_feed_movement('${FTID}', 'EXTERNAL_SALE', 100, '2026-05-03', '${FPED}', 'venta')`);
rpc(`register_feed_movement('${FTID}', 'ADJUSTMENT_NEGATIVE', 15, '2026-05-03', NULL, 'humedad')`);
rpc(`register_feed_inventory_count('${FTID}', '2026-05-03', 900)`);
rpc(`register_feed_inventory_count('${FTID}', '2026-06-01', 900)`);
// classification: ADMIN 05-17 (XL 100, N1 50), OPERATOR 05-17 (XL 30, Rotos 20), ADMIN 05-18 (N2 10), OPERATOR 05-19 (own grade 5)
const G = {};
for (const g of ['XL', 'N1', 'N2', 'Rotos']) G[g] = owner(`SELECT id FROM classification_grade WHERE nombre = '${g}';`);
G.T = okAs(ADMIN, `INSERT INTO classification_grade (nombre) VALUES ('${TAG} Extra') RETURNING id;`);
const classify = (fn, date, lines) => rpcAs(fn, `register_classification('${randomUUID()}', '${date}', ${j(lines.map(([g, qty]) => ({ classification_grade_id: G[g], quantity: qty })))}, '${TAG} sala')`).classification_id;
const S1 = classify(ADMIN, '2026-05-17', [['XL', 100], ['N1', 50]]);
const S2 = classify(OPER, '2026-05-17', [['XL', 30], ['Rotos', 20]]);
classify(ADMIN, '2026-05-18', [['N2', 10]]);
const S4 = classify(OPER, '2026-05-19', [['T', 5]]);
okAs(ADMIN, `UPDATE classification_grade SET activo = false WHERE id = '${G.T}';`);
// commercial: P1 delivered 06-05 (10×100 + 5×200), P2 delivered 07-02 (3×50), collection 500 on 06-20
const P1 = okAs(ADMIN, `INSERT INTO pedidos (cliente_id, created_by) VALUES ('${CLI}', '${ADMIN_UID}') RETURNING id;`);
okAs(ADMIN, `INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, created_by) VALUES
  ('${P1}', '${PROD}', 10, 100, '${TAG} Huevo', '${ADMIN_UID}'), ('${P1}', '${PROD2}', 5, 200, '${TAG} Maple', '${ADMIN_UID}');`);
rpc(`deliver_order('${P1}', '2026-06-05 12:00-03', 'entrega')`);
const P2 = okAs(ADMIN, `INSERT INTO pedidos (cliente_id, created_by) VALUES ('${CLI}', '${ADMIN_UID}') RETURNING id;`);
okAs(ADMIN, `INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, created_by) VALUES
  ('${P2}', '${PROD}', 3, 50, '${TAG} Huevo', '${ADMIN_UID}');`);
rpc(`deliver_order('${P2}', '2026-07-02 12:00-03', 'entrega')`);
rpc(`register_collection('${CLI}', 500, 'TRANSFER', '${key()}', '2026-06-20', '${BNA}')`);
// purchase 1210 on 06-03, supplier payment 1000 on 07-10
const lineJ = j([{ descripcion: 'Insumo', cantidad: 1, unit_type: 'UNIT', precio_unitario: 1 }]);
const pk = key();
rpc(`register_purchase('${SUP}', '2026-06-03', 1000, 1210, '${CAT}', NULL, 'OPERATING', ${lineJ}, ${j([{ storage_path: `purchases/${pk}.pdf`, file_name: `${pk}.pdf`, content_type: 'application/pdf', byte_size: 100 }])}, '${pk}', NULL, NULL, NULL, NULL, 'compra')`);
rpc(`pay_supplier('${SUP}', 1000, '2026-07-10', 'TRANSFER', '${BNA}', '${key()}')`);
// feria: K (fund 1000, expense 150, withdrawal 300, transfer 200, COUNT 400 and COUNT 380); L (fund 100, no count)
const SK = rpc(`open_sales_session('2026-06-14', 'Feria K', '${key()}', 1000, '${CAJA}')`).session_id;
rpc(`register_session_cash_event('${SK}', 'EXPENSE', 150, '${CAJA}', '${CAT}', NULL, 'bolsas')`);
rpc(`register_session_cash_event('${SK}', 'WITHDRAWAL', 300, '${CAJA}', NULL, NULL, 'retiro')`);
rpc(`register_session_cash_event('${SK}', 'TRANSFER_OUT', 200, '${CAJA}', NULL, '${BNA}', 'deposito')`);
rpc(`register_session_cash_event('${SK}', 'COUNT', 400, '${CAJA}', NULL, NULL, 'arqueo 1')`);
rpc(`register_session_cash_event('${SK}', 'COUNT', 380, '${CAJA}', NULL, NULL, 'arqueo 2')`);
const SL = rpc(`open_sales_session('2026-06-15', 'Feria L', '${key()}', 100, '${CAJA}')`).session_id;
// Mercado Pago: one payment, net 980 (gross 1000, fee 12, tax 8), reconciled 500 then 480
const HDR = ['DATE', 'SOURCE_ID', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT', 'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'TAXES_AMOUNT',
  'PAYMENT_METHOD', 'TRANSACTION_APPROVAL_DATE', 'BUSINESS_UNIT', 'SUB_UNIT', 'BALANCE_AMOUNT', 'PAYMENT_METHOD_TYPE', 'PURCHASE_ID'];
const mpRow = Object.fromEntries(HDR.map((h, i) => [h, ['2026-06-12T10:00:00.000-03:00', '8800000251', 'payment', '980.00', '0.00', '1000.00', '-12.00', '-8.00',
  'available_money', '2026-06-12T10:00:00.000-03:00', '', '', '0.00', '', TAG][i]]));
// ADR-006 HRN-3: a Liberaciones payment row now parks DEFERRED_V4 (no movement); the same internal MP facts are
// created as OWNER (csv_import source, payment movement 1000 / −12 / −8 / 980, report APPROVAL identity).
const SRC = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processed_at)
  VALUES ('csv_import', '8800000251:payment:C', ${j(mpRow)}, '2026-06-12T10:00:00-03:00', '2026-06-12', 'NORMALIZED', NOW()) RETURNING id;`);
const MV = owner(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
  VALUES ('${SRC}', 'payment', 1000.00, -12.00, -8.00, 980.00, '2026-06-12') RETURNING id;`);
owner(`INSERT INTO mp_transition_identity (resource_type, resource_id, transition, claimed_by_source_id, mp_financial_movement_id)
  VALUES ('report', '8800000251:payment:C', 'APPROVAL', '${SRC}', ${MV});`);
rpc(`mp_reconcile_movement(${MV}, 500, '${key()}', '${MPACC}', 'MP_SETTLEMENT')`);
check('B1 scenario built through the real RPCs (production, feed, classification, commercial, purchases, Feria, MP)', true);

// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure: seven derived views, nothing stored');

check('A1 exactly the seven report_* views exist, and no other report object',
  owner(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.views WHERE table_schema = 'public' AND table_name LIKE 'report%';`) === VIEWS.join(',')
  && owner(`SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'report%' AND relkind <> 'v';`) === '0');
check('A2 every report view is security_invoker = true and owned by postgres',
  owner(`SELECT count(*) FROM pg_class WHERE relname IN (${VIEWS.map(q).join(',')}) AND pg_get_userbyid(relowner) = 'postgres'
     AND reloptions @> ARRAY['security_invoker=true'];`) === '7');
check('A3 exact grants: SELECT for authenticated only (no anon, no service_role, no PUBLIC)',
  owner(`SELECT count(DISTINCT relacl::TEXT) || ':' || min(relacl::TEXT) FROM pg_class WHERE relname IN (${VIEWS.map(q).join(',')});`)
  === '1:{postgres=arwdDxtm/postgres,authenticated=r/postgres}');
check('A4 no materialized view; public base tables = 53 + the 6 ADR-006 tables (0047) = 59',
  owner(`SELECT count(*) FROM pg_matviews WHERE schemaname = 'public';`) === '0'
  && owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';`) === '59');
check('A5 no SECURITY DEFINER reporting function: the definer inventory is the 41 baseline + the 16 ADR-006 Step-2 definers (0048) + the Step-6 definer mp_ingest_api_snapshot (0050), and no report_* function exists',
  owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`) === ALL_DEFINERS
  && owner(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'report%';`) === '0');
check('A6 the only non-invoker view is still the frozen feed_formula_line_safe',
  owner(`SELECT string_agg(relname, ',') FROM pg_class WHERE relkind = 'v' AND relnamespace = 'public'::regnamespace
     AND NOT coalesce(reloptions @> ARRAY['security_invoker=true'], false);`) === 'feed_formula_line_safe');

// ═══════════════════════════════════════════════════════════════════════════
section('N', 'No stored reporting values');

check('N1 no base-table column stores a laying %, theoretical consumption, variance, balance or KPI',
  owner(`SELECT count(*) FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND c.column_name ~* '^(laying_pct|theoretical_feed_kg|theoretical_kg|internal_consumption_kg|variance|variance_kg|closing_balance|balance|saldo|kpi|remaining_unassigned|expected_cash|share_pct|day_total)$';`) === '0');
check('N2 no base table named for reports, KPIs, dashboards, snapshots or balances',
  owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     AND table_name ~* '(report|kpi|dashboard|snapshot|balance|saldo|laying)'
     AND table_name <> 'mp_report_match';`) === '0');   // ADR-006: reconciliation evidence, not a stored report (§INV C)
const snap = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM daily_production), (SELECT count(*) FROM population_events), (SELECT count(*) FROM classification),
  (SELECT count(*) FROM feed_inventory_count), (SELECT count(*) FROM client_ledger), (SELECT count(*) FROM financial_posting), (SELECT count(*) FROM audit_events));`);
const before = snap();
for (const v of VIEWS) okAs(ADMIN, `SELECT count(*) FROM ${v};`);
check('N3 reading every report view writes nothing', snap() === before);

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'report_flock_day: laying % (ADR-005 D1), population, age, theoretical');

const fday = (fn, f, d) => okAs(fn, `SELECT concat_ws('|', coalesce(eggs_total::TEXT, 'null'), coalesce(eggs_broken::TEXT, 'null'), coalesce(eggs_dirty::TEXT, 'null'),
  mortality, count_adjustment, population, age_weeks, curve_age_weeks, coalesce(laying_pct::TEXT, 'null'), coalesce(expected_laying_pct::TEXT, 'null'),
  coalesce(theoretical_feed_kg::TEXT, 'null'), coalesce(quality_data_warning::TEXT, 'null'))
  FROM report_flock_day WHERE flock_id = '${f}' AND business_date = '${d}';`);
check('F1 laying exact: FA 05-01 = 900 / 995 × 100 = 90.4523 (mortality 5 of the same day already counts: population 995)',
  fday(ADMIN, FA, '2026-05-01').split('|')[8] === '90.4523' && fday(ADMIN, FA, '2026-05-01').split('|')[5] === '995', fday(ADMIN, FA, '2026-05-01'));
check('F2 broken (20) and dirty (10) are subsets: they are not added to eggs_total (930 / 995 = 93.4673 is NOT the result)',
  fday(ADMIN, FA, '2026-05-01').startsWith('900|20|10|') && fday(ADMIN, FA, '2026-05-01').split('|')[8] !== '93.4673');
check('F3 same-day population: a +3 COUNT_ADJUSTMENT dated 05-03 counts on 05-03 → population 998, laying 800 / 998 × 100 = 80.1603',
  fday(ADMIN, FA, '2026-05-03') === '800|0|0|0|3|998|17.4286|17|80.1603|67.00|116.766000|false', fday(ADMIN, FA, '2026-05-03'));
check('F4 a day without a production row: eggs NULL (not 0), laying NULL; the population is still derived (05-02 = 995)',
  fday(ADMIN, FA, '2026-05-02') === 'null|null|null|0|0|995|17.2857|17|null|67.00|116.415000|null', fday(ADMIN, FA, '2026-05-02'));
check('F5 population(D) = 0 → laying NULL (FC 05-04: 10 − 10), no division by zero',
  fday(ADMIN, FC, '2026-05-04').split('|')[5] === '0' && fday(ADMIN, FC, '2026-05-04').split('|')[8] === 'null', fday(ADMIN, FC, '2026-05-04'));
check('F6 population(D) < 0 → laying NULL (FC 05-05: −1 with 1 egg recorded)',
  fday(ADMIN, FC, '2026-05-05').split('|')[5] === '-1' && fday(ADMIN, FC, '2026-05-05').split('|')[8] === 'null', fday(ADMIN, FC, '2026-05-05'));
check('F7 age: (D − birth) / 7 exact to 4 decimals (05-01 = 120 days = 17.1429), curve week = floor = 17, expected laying from the curve = 67.00',
  fday(ADMIN, FA, '2026-05-01').split('|').slice(6, 8).join('|') === '17.1429|17' && fday(ADMIN, FA, '2026-05-01').split('|')[9] === '67.00');
check('F8 theoretical feed of the day = population × g(week 17 = 117) / 1000: FA 05-01 = 995 × 117 / 1000 = 116.415; FC (no assignment) = NULL',
  Number(fday(ADMIN, FA, '2026-05-01').split('|')[10]) === 116.415 && fday(ADMIN, FC, '2026-05-01').split('|')[10] === 'null');
check('F9 quality_data_warning: broken 12 > total 10 on FB 05-01 → true (non-authoritative; the production row stays as recorded); FA → false',
  fday(ADMIN, FB, '2026-05-01').split('|')[11] === 'true' && fday(ADMIN, FA, '2026-05-01').split('|')[11] === 'false'
  && owner(`SELECT eggs_broken || '/' || eggs_total FROM daily_production WHERE flock_id = '${FB}' AND is_current;`) === '12/10');
check('F10 one row per flock per calendar day from entry_date, with no gap (FA 04-01 … 05-31 = 61 days)',
  okAs(ADMIN, `SELECT count(*) || '|' || count(DISTINCT business_date) FROM report_flock_day WHERE flock_id = '${FA}' AND business_date BETWEEN '2026-04-01' AND '2026-05-31';`) === '61|61');
check('F11 drill-down: daily_production_id resolves to the current production row carrying the same eggs_total',
  okAs(ADMIN, `SELECT count(*) FROM report_flock_day v JOIN daily_production d ON d.id = v.daily_production_id
     WHERE v.flock_id IN ('${FA}','${FB}','${FC}') AND d.is_current AND d.eggs_total = v.eggs_total AND d.production_date = v.business_date;`) === '5');

// ═══════════════════════════════════════════════════════════════════════════
section('O', 'OPERATOR: assigned flocks only (ADR-005 D2), no global aggregate');

check('O1 OPERATOR sees the assigned flock FA with the same derived laying % as ADMIN (90.4523)',
  fday(OPER, FA, '2026-05-01') === fday(ADMIN, FA, '2026-05-01') && fday(OPER, FA, '2026-05-01').split('|')[8] === '90.4523');
check('O2 OPERATOR sees no unassigned flock: FB and FC absent, FA present, and every flock in the view is actively assigned to it',
  okAs(OPER, `SELECT count(*) FROM report_flock_day WHERE flock_id IN ('${FB}','${FC}');`) === '0'
  && okAs(OPER, `SELECT count(*) > 0 FROM report_flock_day WHERE flock_id = '${FA}';`) === 't'
  && okAs(OPER, `SELECT count(*) FROM (SELECT DISTINCT flock_id FROM report_flock_day) v WHERE v.flock_id NOT IN
       (SELECT flock_id FROM operator_assignments WHERE operator_id = '${OPA}' AND activo);`) === '0');
check('O3 no global laying aggregate for OPERATOR: Σ eggs of 05-01 over the whole view = Σ of its assigned flocks only (FA 900, FB excluded); ADMIN sees 910 (FA + FB)',
  okAs(OPER, `SELECT SUM(eggs_total) FROM report_flock_day WHERE business_date = '2026-05-01';`)
    === owner(`SELECT SUM(eggs_total) FROM daily_production WHERE production_date = '2026-05-01' AND is_current
         AND flock_id IN (SELECT flock_id FROM operator_assignments WHERE operator_id = '${OPA}' AND activo);`)
  && okAs(OPER, `SELECT SUM(eggs_total) FROM report_flock_day WHERE business_date = '2026-05-01' AND flock_id IN ('${FA}','${FB}','${FC}');`) === '900'
  && okAs(ADMIN, `SELECT SUM(eggs_total) FROM report_flock_day WHERE business_date = '2026-05-01' AND flock_id IN ('${FA}','${FB}','${FC}');`) === '910');
check('O4 OPERATOR sees the theoretical feed of its flock (116.415 on 05-01) but 0 rows of the internal-consumption interval view',
  Number(fday(OPER, FA, '2026-05-01').split('|')[10]) === 116.415 && okAs(OPER, `SELECT count(*) FROM report_feed_consumption_interval;`) === '0');
check('O5 only CURRENTLY assigned flocks: when the FA assignment is deactivated, OPERATOR sees 0 FA rows (history included)',
  (() => { owner(`UPDATE operator_assignments SET activo = false WHERE operator_id = '${OPA}' AND flock_id = '${FA}';`);
    const n0 = okAs(OPER, `SELECT count(*) FROM report_flock_day WHERE flock_id = '${FA}';`);
    owner(`UPDATE operator_assignments SET activo = true WHERE operator_id = '${OPA}' AND flock_id = '${FA}';`);
    return n0 === '0'; })());
check('O6 OPERATOR classification: only its own sessions — 05-17 XL 30 (60.0000 %) and Rotos 20 (40.0000 %), day total 50, 1 session; ADMIN-only 05-18 absent',
  okAs(OPER, `SELECT string_agg(g.nombre || ':' || v.quantity || ':' || v.share_pct || ':' || v.day_total || ':' || v.day_sessions, ',' ORDER BY g.nombre)
     FROM report_classification_day v JOIN classification_grade g ON g.id = v.classification_grade_id WHERE v.business_date = '2026-05-17';`)
  === 'Rotos:20:40.0000:50:1,XL:30:60.0000:50:1'
  && okAs(OPER, `SELECT count(*) FROM report_classification_day WHERE business_date = '2026-05-18';`) === '0');
check('O7 a deactivated grade never drops an OPERATOR fact row: 05-19 own line (5) present with grade_nombre NULL for OPERATOR, named for ADMIN',
  okAs(OPER, `SELECT quantity || ':' || coalesce(grade_nombre, 'null') FROM report_classification_day WHERE business_date = '2026-05-19';`) === '5:null'
  && okAs(ADMIN, `SELECT grade_nombre FROM report_classification_day WHERE business_date = '2026-05-19';`) === `${TAG} Extra`);

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Classification (ADMIN)');

check('C1 ADMIN 05-17: XL 130 (65.0000 %), N1 50 (25.0000 %), Rotos 20 (10.0000 %); day total 200; 2 sessions',
  okAs(ADMIN, `SELECT string_agg(grade_nombre || ':' || quantity || ':' || share_pct || ':' || day_total || ':' || day_sessions, ',' ORDER BY grade_nombre)
     FROM report_classification_day WHERE business_date = '2026-05-17';`) === 'N1:50:25.0000:200:2,Rotos:20:10.0000:200:2,XL:130:65.0000:200:2');
check('C2 drill-down: classification_ids of the XL row re-sum from classification_line to 130; no flock column exists in the view',
  okAs(ADMIN, `SELECT SUM(l.quantity) FROM report_classification_day v, unnest(v.classification_ids) cid JOIN classification_line l ON l.classification_id = cid
     WHERE v.business_date = '2026-05-17' AND v.grade_nombre = 'XL' AND l.classification_grade_id = v.classification_grade_id;`) === '130'
  && owner(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'report_classification_day' AND column_name ~* '(flock|production)';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'Feed internal consumption per count interval (Phase 20 §14)');

const iv = (d1) => okAs(ADMIN, `SELECT concat_ws('|', opening_date, opening_kg, manufactured_kg, external_sale_kg, loss_kg, adjustment_negative_kg,
  adjustment_positive_kg, closing_kg, internal_consumption_kg, theoretical_kg, variance_kg) FROM report_feed_consumption_interval
  WHERE feed_type_id = '${FTID}' AND business_date = '${d1}';`);
check('I1 interval (05-01, 05-03]: 1000 + 500 − 100 − 5 − 15 + 40 − 900 = 520 (the 70 kg made on the opening-count day are excluded)',
  iv('2026-05-03') === '2026-05-01|1000.000|500.000|100.000|5.000|15.000|40.000|900.000|520.000|350.181|169.819', iv('2026-05-03'));
check('I2 theoretical of the interval = Σ days 05-02, 05-03 of (FA + FB) × 117 / 1000 = (1495 + 1498) × 0.117 = 350.181; variance = 520 − 350.181 = 169.819',
  Number(iv('2026-05-03').split('|')[9]) === 350.181 && Number(iv('2026-05-03').split('|')[10]) === 169.819);
// independent computation of the second interval (05-03, 06-01]: FA 998, FB 500 every day; g = 100 + floor((D − 01-01) / 7)
let theo2 = 0;
for (let t = Date.UTC(2026, 4, 4); t <= Date.UTC(2026, 5, 1); t += 86400000) theo2 += (1498 * (100 + Math.floor((t - Date.UTC(2026, 0, 1)) / 86400000 / 7))) / 1000;
check('I3 an interval crossing a month boundary (05-03 → 06-01) is one row, never pro-rated: internal 0, theoretical equals an independent JS computation',
  okAs(ADMIN, `SELECT count(*) FROM report_feed_consumption_interval WHERE feed_type_id = '${FTID}';`) === '2'
  && iv('2026-06-01').split('|')[8] === '0.000' && Math.abs(Number(iv('2026-06-01').split('|')[9]) - theo2) < 0.0005, `${iv('2026-06-01')} vs ${theo2.toFixed(3)}`);
check('I4 drill-down: the opening and closing count ids resolve to the counts of the interval',
  okAs(ADMIN, `SELECT o.count_date || '|' || c.count_date FROM report_feed_consumption_interval v JOIN feed_inventory_count o ON o.id = v.opening_count_id
     JOIN feed_inventory_count c ON c.id = v.closing_count_id WHERE v.feed_type_id = '${FTID}' AND v.business_date = '2026-05-03';`) === '2026-05-01|2026-05-03');

// ═══════════════════════════════════════════════════════════════════════════
section('S', 'Sales and P&L reuse');

check('S1 sales lines: P1 (1000 + 1000) at delivered_date 06-05, P2 (150) at 07-02; line level, current lines only',
  okAs(ADMIN, `SELECT string_agg(business_date || ':' || producto_nombre || ':' || subtotal, ',' ORDER BY business_date, producto_nombre)
     FROM report_sales_line WHERE cliente_id = '${CLI}';`) === `2026-06-05:${TAG} Huevo:1000.00,2026-06-05:${TAG} Maple:1000.00,2026-07-02:${TAG} Huevo:150.00`);
check('S2 sales by product: Huevo 13 units / 1150, Maple 5 / 1000',
  okAs(ADMIN, `SELECT string_agg(producto_nombre || ':' || c || ':' || s, ',' ORDER BY producto_nombre) FROM (SELECT producto_nombre, SUM(cantidad)::INTEGER c, SUM(subtotal) s
     FROM report_sales_line WHERE cliente_id = '${CLI}' GROUP BY producto_nombre) x;`) === `${TAG} Huevo:13:1150.00,${TAG} Maple:5:1000.00`);
check('S3 P&L reused, not recalculated: for EVERY period, Σ report_sales_line = pnl_summary.ventas_netas_devengadas',
  okAs(ADMIN, `SELECT count(*) FROM (SELECT period, SUM(subtotal) s FROM report_sales_line GROUP BY period) v
     FULL JOIN (SELECT period, ventas_netas_devengadas s FROM pnl_summary WHERE ventas_netas_devengadas <> 0) p ON p.period = v.period
     WHERE v.s IS DISTINCT FROM p.s;`) === '0'
  && okAs(ADMIN, `SELECT ventas_netas_devengadas FROM pnl_summary WHERE period = '2026-06-01';`) === okAs(ADMIN, `SELECT SUM(subtotal) FROM report_sales_line WHERE period = '2026-06-01';`));
check('S4 no report view reads the P&L cost sources (purchases, freight, management_event, expense_category) or re-derives a P&L bucket',
  VIEWS.every((v) => !/(purchases|freight|management_event|expense_category|pnl_cost_class|VENTAS_NETAS|COSTOS_)/.test(viewDef(v))));

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'Balances derived from the frozen ledgers (Invariants 5–7)');

const bal = (ledger, id) => okAs(ADMIN, `SELECT string_agg(period || ':' || increases || ':' || decreases || ':' || net || ':' || closing_balance, ',' ORDER BY period)
  FROM report_balance_period WHERE ledger = '${ledger}' AND entity_id = '${id}';`);
check('L1 client: June +2000 −500 = 1500 (closing 1500), July +150 (closing 1650)',
  bal('CLIENT', CLI) === '2026-06-01:2000.00:-500.00:1500.00:1500.00,2026-07-01:150.00:0:150.00:1650.00', bal('CLIENT', CLI));
check('L2 client closing balance = SUM(client_ledger.signed_amount) exactly',
  okAs(ADMIN, `SELECT closing_balance FROM report_balance_period WHERE ledger = 'CLIENT' AND entity_id = '${CLI}' ORDER BY period DESC LIMIT 1;`)
  === owner(`SELECT SUM(signed_amount) FROM client_ledger WHERE cliente_id = '${CLI}';`));
const supRows = okAs(ADMIN, `SELECT string_agg(abs(net) || ':' || closing_balance, ',' ORDER BY period) FROM report_balance_period WHERE ledger = 'SUPPLIER' AND entity_id = '${SUP}';`);
check('L3 supplier: purchase 1210 (June) and payment 1000 (July); closing = SUM(supplier_ledger.signed_amount); |closing| = 210',
  supRows.startsWith('1210.00:') && supRows.split(',')[1].startsWith('1000.00:')
  && supRows.split(',')[1].split(':')[1] === owner(`SELECT SUM(signed_amount) FROM supplier_ledger WHERE supplier_id = '${SUP}';`)
  && Math.abs(Number(supRows.split(',')[1].split(':')[1])) === 210, supRows);
check('L4 every account: the latest closing_balance = SUM(financial_posting.signed_amount) of that account',
  okAs(ADMIN, `SELECT count(*) FROM (SELECT DISTINCT ON (entity_id) entity_id, closing_balance FROM report_balance_period WHERE ledger = 'ACCOUNT' ORDER BY entity_id, period DESC) v
     WHERE v.closing_balance IS DISTINCT FROM (SELECT SUM(signed_amount) FROM financial_posting p WHERE p.financial_account_id = v.entity_id);`) === '0'
  && Number(okAs(ADMIN, `SELECT count(*) FROM report_balance_period WHERE ledger = 'ACCOUNT';`)) > 0);
check('L5 drill-down: the June client net re-sums from its client_ledger rows by effective_date',
  owner(`SELECT SUM(signed_amount) FROM client_ledger WHERE cliente_id = '${CLI}' AND effective_date >= '2026-06-01' AND effective_date < '2026-07-01';`) === '1500.00');

// ═══════════════════════════════════════════════════════════════════════════
section('M', 'Mercado Pago remaining_unassigned (ADR-003 D4)');

const mps = () => okAs(ADMIN, `SELECT concat_ws('|', business_date, movement_kind, net_amount, assigned_amount, remaining_unassigned, reconciliations, processing_status)
  FROM report_mp_movement_status WHERE mp_financial_movement_id = ${MV};`);
check('M1 partial: net 980, assigned 500 → remaining 480, source still NORMALIZED', mps() === '2026-06-12|payment|980.00|500.00|480.00|1|NORMALIZED', mps());
rpc(`mp_reconcile_movement(${MV}, 480, '${key()}', '${MPACC}', 'MP_SETTLEMENT')`);
check('M2 full: assigned 980 → remaining 0, status RECONCILED (owned by RPC 41, only displayed)', mps() === '2026-06-12|payment|980.00|980.00|0.00|2|RECONCILED', mps());
check('M3 remaining_unassigned is derived: no column of that name exists in any base table',
  owner(`SELECT count(*) FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE t.table_type = 'BASE TABLE' AND c.column_name = 'remaining_unassigned';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'Feria cash: counts never aggregated (Phase 21 K2)');

const fk = okAs(ADMIN, `SELECT string_agg(concat_ws(':', expected_cash, count_events, counted_cash, variance), ',' ORDER BY counted_cash)
  FROM report_feria_session_cash WHERE sales_session_id = '${SK}';`);
check('K1 expected = 1000 − 150 − 300 − 200 = 350; two COUNTs → two rows with their own variances (380 → +30, 400 → +50)',
  fk === '350.00:2:380.00:30.00,350.00:2:400.00:50.00', fk);
check('K2 counts are never summed: no row carries 780, and the session contributes exactly 2 rows',
  !fk.includes('780') && okAs(ADMIN, `SELECT count(*) FROM report_feria_session_cash WHERE sales_session_id = '${SK}';`) === '2');
check('K3 a session without a COUNT has one row: expected 100, count and variance NULL',
  okAs(ADMIN, `SELECT concat_ws(':', expected_cash, count_events, coalesce(counted_cash::TEXT, 'null'), coalesce(variance::TEXT, 'null'))
     FROM report_feria_session_cash WHERE sales_session_id = '${SL}';`) === '100.00:0:null:null');

// ═══════════════════════════════════════════════════════════════════════════
section('T', 'Business dates, never created_at');

check('T1 no report view definition references created_at (or any operational timestamp)',
  VIEWS.every((v) => !/(created_at|delivered_at|ingested_at|opened_at|reconciled_at|performed_at)/.test(viewDef(v))));
check('T2 facts created today are reported at their business dates: sales in 2026-06/07, classification 05-17, production 05-01, Feria 06-14, MP 06-12',
  okAs(ADMIN, `SELECT string_agg(DISTINCT period::TEXT, ',') FROM report_sales_line WHERE cliente_id = '${CLI}';`) === '2026-06-01,2026-07-01'
  && okAs(ADMIN, `SELECT count(*) FROM report_classification_day WHERE business_date = '2026-05-17';`) === '3'
  && okAs(ADMIN, `SELECT business_date FROM report_feria_session_cash WHERE sales_session_id = '${SK}' LIMIT 1;`) === '2026-06-14'
  && owner(`SELECT count(*) FROM daily_production WHERE flock_id = '${FA}' AND created_at::DATE = production_date;`) === '0');
check('T3 period = date_trunc(month, business_date) in every view that exposes a period',
  VIEWS.filter((v) => v !== 'report_feed_consumption_interval' && v !== 'report_balance_period').every((v) =>
    okAs(ADMIN, `SELECT count(*) FROM ${v} WHERE period <> date_trunc('month', business_date)::DATE;`) === '0'));

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Empty periods');

check('E1 no fabricated zero month: the client has rows for June and July only (no May, no August)',
  okAs(ADMIN, `SELECT string_agg(period::TEXT, ',' ORDER BY period) FROM report_balance_period WHERE ledger = 'CLIENT' AND entity_id = '${CLI}';`) === '2026-06-01,2026-07-01');
check('E2 the month calendar for zero-filling is management_period, readable by ADMIN and OPERATOR (2026 seeded: 12 months)',
  okAs(ADMIN, `SELECT count(*) FROM management_period WHERE periodo_fecha BETWEEN '2026-01-01' AND '2026-12-01';`) === '12'
  && okAs(OPER, `SELECT count(*) FROM management_period WHERE periodo_fecha BETWEEN '2026-01-01' AND '2026-12-01';`) === '12');

// ═══════════════════════════════════════════════════════════════════════════
section('X', 'Security: ADMIN, OPERATOR, anon, service_role');

check('X1 ADMIN reads all seven report views and both P&L views',
  VIEWS.concat(['pnl_line_item', 'pnl_summary']).every((v) => ADMIN(`SELECT count(*) FROM ${v};`).ok)
  && ADMIN_ONLY.every((v) => Number(okAs(ADMIN, `SELECT count(*) FROM ${v};`)) > 0));
check('X2 OPERATOR gets 0 rows from every ADMIN-only report view and from the P&L views',
  ADMIN_ONLY.concat(['pnl_line_item', 'pnl_summary']).every((v) => okAs(OPER, `SELECT count(*) FROM ${v};`) === '0'));
const outsiders = VIEWS.flatMap((v) => [ANON(`SELECT 1 FROM ${v};`), SVC(`SELECT 1 FROM ${v};`)]);
check('X3 anon and service_role are denied on all seven views', outsiders.every(denied), outsiders.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
check('X4 RLS under joins: OPERATOR sees production only of assigned flocks (FA: 2 days), even though the view joins sheds, curve and feed assignment',
  okAs(OPER, `SELECT count(*) FROM report_flock_day WHERE eggs_total IS NOT NULL AND flock_id IN ('${FA}','${FB}','${FC}');`) === '2'
  && okAs(OPER, `SELECT count(*) FROM report_flock_day WHERE eggs_total IS NOT NULL;`)
    === owner(`SELECT count(*) FROM daily_production WHERE is_current AND flock_id IN (SELECT flock_id FROM operator_assignments WHERE operator_id = '${OPA}' AND activo)
         AND production_date <= CURRENT_DATE;`));

// ═══════════════════════════════════════════════════════════════════════════
section('Y', 'No reconstructable cost for OPERATOR');

check('Y1 the OPERATOR-visible report views (flock day, classification day) project no monetary column',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_name IN ('report_flock_day','report_classification_day');`) !== '0'
  && owner(`SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_name IN ('report_flock_day','report_classification_day');`)
    .split(',').every((c) => !MONEY.test(c)));
const rels = owner(`SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','v')
  AND has_table_privilege('authenticated', oid, 'SELECT');`).split(',');
const visible = rels.filter((t) => { const x = OPER(`SELECT count(*) FROM ${t};`); return x.ok && x.out !== '0'; });
const leaky = visible.flatMap((t) => owner(`SELECT coalesce(string_agg(column_name, ','), '') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t}';`)
  .split(',').filter((c) => MONEY.test(c)).map((c) => `${t}.${c}`));
check('Y2 across EVERY relation OPERATOR can read rows from, no column is monetary (amount / price / cost / subtotal / balance / fee / tax / cash / variance)',
  visible.includes('report_flock_day') && leaky.length === 0, `visible=${visible.join(',')} leaky=${leaky.join(',')}`);
check('Y3 feed cost stays hidden: OPERATOR reads 0 rows of feed_formula_line, and the safe composition carries no cost column',
  okAs(OPER, `SELECT count(*) FROM feed_formula_line;`) === '0' && okAs(OPER, `SELECT count(*) FROM feed_formula_line_safe WHERE formula_version_id = '${FVID}';`) === '1'
  && owner(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'feed_formula_line_safe' AND column_name ~* 'cost';`) === '0');
check('Y4 the audit payloads OPERATOR can read carry no monetary key',
  Number(okAs(OPER, `SELECT count(*) FROM audit_events;`)) > 0
  && okAs(OPER, `SELECT count(*) FROM audit_events WHERE concat(before_values::TEXT, after_values::TEXT) ~* '"[a-z_]*(amount|precio|price|cost|subtotal|fee|tax|saldo|balance)[a-z_]*"';`) === '0');
} finally {
  cleanup();
}

section('Z', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM clients WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM suppliers WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM sheds WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM feed_type WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM mp_source_record)
  + (SELECT count(*) FROM sales_session WHERE idempotency_key LIKE '${K}%') + (SELECT count(*) FROM classification WHERE location LIKE '${TAG}%')
  + (SELECT count(*) FROM financial_operation WHERE external_ref LIKE '${K}%');`);
check('Z1 every R25-TEST fact, master, MP row and fixture operation removed', left === '0', left);

console.log(`\n  ══ REPORTING RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
