#!/usr/bin/env node
/**
 * PHASE 14 — COMMERCIAL (SLICE 1) TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Behavioural tests of the commercial vertical slice:
 *   CLIENT → PEDIDO → PEDIDO_LINEAS (snapshot) → DELIVERY → CLIENT_LEDGER
 *   → COLLECTION → FINANCIAL_OPERATION → FINANCIAL_POSTING → FINANCIAL_ACCOUNT
 *
 * Every role-scoped call simulates a real Supabase session
 * (SET LOCAL ROLE authenticated + request.jwt.claims). Business roles come only
 * from current_app_role(). All fixtures are synthetic and carry the prefix
 * "P14-TEST"; they are removed at the start (leftovers of an earlier run) and at
 * the end. Periods closed by the suite (2026-03, 2026-06) are reopened at the end.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/commercial.test.mjs
 */

import { spawnSync } from 'node:child_process';
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
const TAG = 'P14-TEST';

const COMMERCIAL_TABLES = [
  'client_ledger', 'collections', 'financial_operation', 'financial_posting', 'pedido_lineas', 'pedidos',
];
const RPCS = ['cancel_order', 'deliver_order', 'rectify_delivered_order', 'register_collection'];

let container;
let pass = 0;
let fail = 0;
const failures = [];

function dockerRun(args, input) {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker: ${r.error.message}`);
  return r;
}

/** SQL as the database owner. `-q` keeps command tags out of stdout. */
function raw(sqlText) {
  const r = dockerRun(
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    sqlText
  );
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function owner(sqlText) {
  const r = raw(sqlText);
  if (!r.ok) throw new Error(`owner SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}

function asRole(pgRole, claims, sqlText) {
  const claimsJson = JSON.stringify(claims).replace(/'/g, "''");
  return raw(`
BEGIN;
SET LOCAL ROLE ${pgRole};
SET LOCAL "request.jwt.claims" = '${claimsJson}';
${sqlText}
COMMIT;`);
}

const asUser = (uid, sqlText, extra = {}) =>
  asRole('authenticated', { sub: uid, role: 'authenticated', ...extra }, sqlText);
const ADMIN = (sqlText) => asUser(ADMIN_UID, sqlText);
const OPER = (sqlText) => asUser(OPER_UID, sqlText);
const asAnon = (sqlText) => asRole('anon', { role: 'anon' }, sqlText);
const asServiceRole = (sqlText) => asRole('service_role', { role: 'service_role' }, sqlText);

function adminOk(sqlText) {
  const r = ADMIN(sqlText);
  if (!r.ok) throw new Error(`ADMIN SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const rpc = (call) => JSON.parse(adminOk(`SELECT ${call};`));

const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 140);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
const rlsDenied = (r) => !r.ok && /row-level security/i.test(r.err);
const raised = (r, code) => !r.ok && new RegExp(`ERROR:\\s+${code}`).test(r.err);

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
const TEST_CLIENTS = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
DELETE FROM audit_events WHERE entity_type = 'pedido'
   AND entity_id IN (SELECT id::TEXT FROM pedidos WHERE cliente_id IN ${TEST_CLIENTS});
DELETE FROM audit_events WHERE entity_type = 'collections'
   AND entity_id IN (SELECT id::TEXT FROM collections WHERE cliente_id IN ${TEST_CLIENTS});
DELETE FROM financial_posting WHERE financial_operation_id IN
  (SELECT id FROM financial_operation WHERE external_ref LIKE '${TAG}%');
DELETE FROM financial_operation WHERE external_ref LIKE '${TAG}%';
DELETE FROM collections WHERE cliente_id IN ${TEST_CLIENTS};
DELETE FROM client_ledger WHERE reversal_of_id IS NOT NULL AND cliente_id IN ${TEST_CLIENTS};
DELETE FROM client_ledger WHERE cliente_id IN ${TEST_CLIENTS};
DELETE FROM pedido_lineas WHERE pedido_id IN (SELECT id FROM pedidos WHERE cliente_id IN ${TEST_CLIENTS});
DELETE FROM pedidos WHERE cliente_id IN ${TEST_CLIENTS};
DELETE FROM price_history WHERE producto_id IN (SELECT id FROM products WHERE nombre LIKE '${TAG}%');
DELETE FROM products WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
UPDATE management_period SET status = 'OPEN', closed_at = NULL
 WHERE periodo_fecha IN ('2026-03-01', '2026-06-01');`);
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

// ── helpers over the ALLOWED paths (ADMIN, RLS-filtered) ────────────────────
const mkClient = (name, activo = true) =>
  adminOk(`INSERT INTO clients (nombre, activo) VALUES ('${TAG} ${name}', ${activo}) RETURNING id;`);

function mkProduct(name, price) {
  const id = adminOk(`INSERT INTO products (nombre, product_type) VALUES ('${TAG} ${name}', 'VENDIBLE') RETURNING id;`);
  adminOk(`INSERT INTO price_history (producto_id, price_list_type, precio, effective_from, created_by)
           VALUES ('${id}', 'MAYORISTA', ${price}, '2026-01-01', '${ADMIN_UID}');`);
  return id;
}

function changePrice(productId, newPrice, from) {
  adminOk(`
UPDATE price_history SET effective_to = ('${from}'::DATE - 1)
 WHERE producto_id = '${productId}' AND price_list_type = 'MAYORISTA' AND effective_to IS NULL;
INSERT INTO price_history (producto_id, price_list_type, precio, effective_from, created_by)
VALUES ('${productId}', 'MAYORISTA', ${newPrice}, '${from}', '${ADMIN_UID}');`);
}

/** Line snapshot: the current list price and the product name at order time. */
function addLine(orderId, productId, qty) {
  adminOk(`
INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, created_by)
SELECT '${orderId}', p.id, ${qty}, ph.precio, p.nombre, '${ADMIN_UID}'
  FROM products p
  JOIN price_history ph ON ph.producto_id = p.id AND ph.price_list_type = 'MAYORISTA' AND ph.effective_to IS NULL
 WHERE p.id = '${productId}';`);
}

function createOrder(clientId, lines) {
  const id = adminOk(`INSERT INTO pedidos (cliente_id, created_by) VALUES ('${clientId}', '${ADMIN_UID}') RETURNING id;`);
  for (const [prod, qty] of lines) addLine(id, prod, qty);
  return id;
}

const lines = (arr) => `'${JSON.stringify(arr.map(([producto_id, cantidad, precio_unitario]) =>
  ({ producto_id, cantidad, precio_unitario })))}'::jsonb`;

const deliverCall = (o, at, reason = 'NULL') => `deliver_order('${o}', '${at}'::timestamptz, ${reason})`;
const rectifyCall = (o, arr, reason) => `rectify_delivered_order('${o}', ${lines(arr)}, ${reason === null ? 'NULL' : `'${reason}'`})`;
const cancelCall = (o, at, reason) => `cancel_order('${o}', '${at}'::timestamptz, '${reason}')`;
const collectCall = (c, amount, method, receipt, date, account, session = 'NULL') =>
  `register_collection('${c}', ${amount}, '${method}', '${receipt}', '${date}', ${account === null ? 'NULL' : `'${account}'`}, ${session})`;

const clientBalance = (c) =>
  owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM client_ledger WHERE cliente_id = '${c}';`);
const accountBalance = (a) =>
  owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM financial_posting WHERE financial_account_id = '${a}';`);
const plus = (a, b) => (Number(a) + Number(b)).toFixed(2);

/** Fingerprint of every table the slice writes, for "nothing changed" proofs. */
const snapshot = () => owner(`
SELECT concat_ws('|',
  (SELECT count(*) FROM pedidos),
  (SELECT string_agg(estado::TEXT || ':' || rectification_seq || ':' || coalesce(delivered_date::TEXT, '-')
                     || ':' || coalesce(cancelled_date::TEXT, '-'), ',' ORDER BY id) FROM pedidos),
  (SELECT count(*) FROM pedido_lineas),
  (SELECT count(*) FROM pedido_lineas WHERE is_current),
  (SELECT count(*) FROM client_ledger),
  (SELECT count(*) FROM collections),
  (SELECT count(*) FROM financial_operation),
  (SELECT count(*) FROM financial_posting),
  (SELECT count(*) FROM audit_events));`);
const moneyCounts = () =>
  owner(`SELECT (SELECT count(*) FROM financial_operation) || '|' || (SELECT count(*) FROM financial_posting);`);

const closePeriod = (month) =>
  owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${month}';`);
const openPeriod = (month) =>
  owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${month}';`);

const ACC = {};
for (const [key, nombre] of [['CAJA', 'Caja chica'], ['MP', 'Mercado Pago'], ['BNA', 'BNA'], ['PAT', 'Patagonia']]) {
  ACC[key] = owner(`SELECT id FROM financial_account WHERE nombre = '${nombre}';`);
}
const allAccountBalances = () => Object.values(ACC).map(accountBalance).join(',');

const periodClosedBlocks = {};

try {
// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Schema');

const tables = owner(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN (${COMMERCIAL_TABLES.map((t) => `'${t}'`).join(',')});`);
check('A1 the six Commercial tables exist', tables === COMMERCIAL_TABLES.join(','), tables);

const rlsOn = owner(`SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
  AND relname IN (${COMMERCIAL_TABLES.map((t) => `'${t}'`).join(',')}) AND relrowsecurity;`);
check('A2 RLS enabled on all six', rlsOn === '6', rlsOn);

const excl = owner(`SELECT pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conname = 'excl_pedido_lineas_single_current_version';`);
check('A3 excl_pedido_lineas_single_current_version is the frozen GiST exclusion',
  excl === 'EXCLUDE USING gist (pedido_id WITH =, version_seq WITH <>) WHERE (is_current)', excl);

const wantChecks = [
  'chk_collections_account_required', 'chk_collections_no_cheque',
  'chk_pedidos_aggregated_has_session',   // Phase 21 (0032): invariant 28 backstop; the 2 deferred-FK stand-ins were replaced by the frozen FKs
  'chk_pedidos_cancelled_coherent', 'chk_pedidos_delivered_coherent',
  'client_ledger_signed_amount_check', 'collections_amount_check', 'financial_posting_signed_amount_check',
  'pedido_lineas_cantidad_check', 'pedido_lineas_precio_unitario_check',
];
const checks = owner(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint
  WHERE contype = 'c' AND conrelid::regclass::TEXT IN (${COMMERCIAL_TABLES.map((t) => `'${t}'`).join(',')});`);
check('A4 CHECK constraints are exactly the frozen set (+ Phase 21 invariant-28 backstop)', checks === wantChecks.join(','), checks);

const wantFks = [
  'client_ledger.cliente_id>clients', 'client_ledger.created_by>perfiles', 'client_ledger.reversal_of_id>client_ledger',
  'collections.cliente_id>clients', 'collections.created_by>perfiles', 'collections.financial_account_id>financial_account',
  'financial_operation.created_by>perfiles',
  'financial_posting.created_by>perfiles', 'financial_posting.financial_account_id>financial_account',
  'financial_posting.financial_operation_id>financial_operation',
  'pedido_lineas.created_by>perfiles', 'pedido_lineas.pedido_id>pedidos', 'pedido_lineas.producto_id>products',
  'pedidos.cliente_id>clients', 'pedidos.created_by>perfiles', 'pedidos.updated_by>perfiles',
  'pedidos.sales_session_id>sales_session', 'collections.sales_session_id>sales_session',   // frozen FKs added by Phase 21 (0032)
].sort();
const fks = owner(`SELECT string_agg(x, ',' ORDER BY x) FROM (
  SELECT c.conrelid::regclass || '.' || a.attname || '>' || c.confrelid::regclass AS x
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.conrelid::regclass::TEXT IN (${COMMERCIAL_TABLES.map((t) => `'${t}'`).join(',')})) s;`);
check('A5 foreign keys are exactly the frozen set (16 + 2 sales_session FKs since Phase 21)', fks === wantFks.join(','), fks);
const notRestrict = owner(`SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND confdeltype <> 'r'
  AND conrelid::regclass::TEXT IN (${COMMERCIAL_TABLES.map((t) => `'${t}'`).join(',')});`);
check('A6 every Commercial FK is ON DELETE RESTRICT', notRestrict === '0', notRestrict);

const wantIdx = [
  'idx_client_ledger_cliente_date', 'idx_client_ledger_source', 'idx_collections_cliente_date',
  'idx_financial_operation_date', 'idx_financial_posting_account_date', 'idx_financial_posting_operation',
  'idx_pedido_lineas_current', 'idx_pedido_lineas_version', 'idx_pedidos_cliente', 'idx_pedidos_delivered_date',
  'idx_pedidos_session',
  'idx_pedidos_one_aggregate_per_session',   // Phase 21 (0032): invariant 28 backstop
].sort();
const idx = owner(`SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes
  WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
    AND tablename IN (${COMMERCIAL_TABLES.map((t) => `'${t}'`).join(',')});`);
check('A7 the 11 frozen indexes exist (+ Phase 21 invariant-28 backstop)', idx === wantIdx.join(','), idx);
const curUnique = owner(`SELECT indisunique FROM pg_index WHERE indexrelid = 'idx_pedido_lineas_current'::regclass;`);
check('A8 idx_pedido_lineas_current is NOT unique (the guarantee is the exclusion)', curUnique === 'f', curUnique);

const uniques = owner(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE contype = 'u'
  AND conrelid::regclass::TEXT IN (${COMMERCIAL_TABLES.map((t) => `'${t}'`).join(',')});`);
check('A9 UNIQUE: numero_pedido, receipt_id, external_ref',
  uniques === 'collections_receipt_id_key,financial_operation_external_ref_key,pedidos_numero_pedido_key', uniques);

const gen = owner(`SELECT is_generated || ':' || generation_expression FROM information_schema.columns
  WHERE table_name = 'pedido_lineas' AND column_name = 'subtotal';`);
check('A10 pedido_lineas.subtotal is GENERATED ALWAYS (cantidad * precio_unitario)', /^ALWAYS:.*cantidad.*precio_unitario/.test(gen), gen);

const forbidden = owner(`SELECT coalesce(string_agg(table_name, ','), '') FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('sale','sales','ventas','pedido_audit_events',
    'client_balance','account_balance','collection_allocation','purchase_orders');`);
check('A11 no forbidden parallel structure (sales, pedido_audit_events, balances, allocation)', forbidden === '', forbidden);

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Pedido PENDING');

const cB = mkClient('Cliente B');
const pA = mkProduct('Huevo A', 1250.50);
const pB = mkProduct('Huevo B', 800);
const money0 = moneyCounts();

const oB = createOrder(cB, [[pA, 12], [pB, 7]]);
check('B1 ADMIN creates a pedido through the permitted path; default estado PENDING',
  owner(`SELECT estado FROM pedidos WHERE id = '${oB}';`) === 'PENDING');

const bLines = owner(`SELECT count(*) || '|' || bool_and(is_current) || '|' || max(version_seq) || '|' || SUM(subtotal)
  FROM pedido_lineas WHERE pedido_id = '${oB}';`);
check('B2 two lines, version 0, current; subtotal sum 12×1250.50 + 7×800 = 20606.00', bLines === '2|true|0|20606.00', bLines);

check('B3 line snapshot = list price and product name at order time',
  owner(`SELECT precio_unitario || '|' || producto_nombre FROM pedido_lineas
         WHERE pedido_id = '${oB}' AND producto_id = '${pA}';`) === `1250.50|${TAG} Huevo A`);

changePrice(pA, 1400, '2026-02-01');
adminOk(`UPDATE products SET nombre = '${TAG} Huevo A (renamed)' WHERE id = '${pA}';`);
check('B4 a later price change and product rename do not alter the line snapshot',
  owner(`SELECT precio_unitario || '|' || producto_nombre FROM pedido_lineas
         WHERE pedido_id = '${oB}' AND producto_id = '${pA}';`) === `1250.50|${TAG} Huevo A`);

check('B5 PENDING creates no client_ledger movement',
  owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${cB}';`) === '0');
check('B6 PENDING creates no financial_operation / financial_posting', moneyCounts() === money0, moneyCounts());

let r = ADMIN(`DELETE FROM pedido_lineas WHERE pedido_id = '${oB}' AND producto_id = '${pB}';`);
addLine(oB, pB, 7);
check('B7 ADMIN may freely remove and re-add lines while PENDING',
  r.ok && owner(`SELECT count(*) FROM pedido_lineas WHERE pedido_id = '${oB}';`) === '2', firstErr(r));

r = ADMIN(`INSERT INTO pedidos (cliente_id, estado, delivered_at, delivered_date)
           VALUES ('${cB}', 'DELIVERED', NOW(), CURRENT_DATE);`);
check('B8 ADMIN cannot INSERT a pedido already DELIVERED (RLS WITH CHECK)', rlsDenied(r), firstErr(r));

r = ADMIN(`UPDATE pedidos SET estado = 'DELIVERED', delivered_at = NOW(), delivered_date = CURRENT_DATE WHERE id = '${oB}';`);
check('B9 ADMIN cannot move PENDING → DELIVERED by direct UPDATE (RLS WITH CHECK)', rlsDenied(r), firstErr(r));

r = ADMIN(`UPDATE pedido_lineas SET precio_unitario = 1 WHERE pedido_id = '${oB}';`);
check('B10 no role may UPDATE pedido_lineas (snapshot immutable: no privilege)', denied(r), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Delivery');

const moneyBeforeDelivery = moneyCounts();
const dB = rpc(deliverCall(oB, '2026-04-10 23:30:00-03', "'entrega B'"));
check('C1 deliver_order PENDING → DELIVERED (return + row)',
  dB.estado === 'DELIVERED' && owner(`SELECT estado FROM pedidos WHERE id = '${oB}';`) === 'DELIVERED', JSON.stringify(dB));
check('C2 delivered_date is the Buenos Aires date (UTC is already 2026-04-11)',
  dB.delivered_date === '2026-04-10' && owner(`SELECT delivered_date FROM pedidos WHERE id = '${oB}';`) === '2026-04-10',
  dB.delivered_date);
check('C3 order_total derives from current lines at their snapshot price (20606, not the new 1400 price)',
  Number(dB.order_total) === 20606, dB.order_total);

const ledB = owner(`SELECT movement_type || '|' || signed_amount || '|' || effective_date || '|' || ledger_client_name
  || '|' || source_entity_type || '|' || source_entity_id || '|' || created_by FROM client_ledger WHERE cliente_id = '${cB}';`);
check('C4 exactly one client_ledger SALE_DELIVERY +20606.00 at delivered_date, name snapshot, source pedido, actor',
  ledB === `SALE_DELIVERY|20606.00|2026-04-10|${TAG} Cliente B|pedido|${oB}|${ADMIN_UID}`, ledB);
check('C5 delivery creates NO financial_operation / financial_posting', moneyCounts() === moneyBeforeDelivery, moneyCounts());

let snap = snapshot();
r = ADMIN(`SELECT ${deliverCall(oB, '2026-04-11 10:00:00-03')};`);
check('C6 a second delivery is rejected ORDER_NOT_PENDING and changes nothing',
  raised(r, 'ORDER_NOT_PENDING') && snapshot() === snap, firstErr(r));

r = ADMIN(`SELECT ${deliverCall(MISSING_UUID, '2026-04-11 10:00:00-03')};`);
check('C7 unknown order → ORDER_NOT_FOUND', raised(r, 'ORDER_NOT_FOUND'), firstErr(r));

const oEmpty = createOrder(cB, []);
r = ADMIN(`SELECT ${deliverCall(oEmpty, '2026-04-11 10:00:00-03')};`);
check('C8 order without lines → ORDER_HAS_NO_LINES, stays PENDING',
  raised(r, 'ORDER_HAS_NO_LINES') && owner(`SELECT estado FROM pedidos WHERE id = '${oEmpty}';`) === 'PENDING', firstErr(r));

closePeriod('2026-03-01');
const oC = createOrder(cB, [[pB, 1]]);
snap = snapshot();
r = ADMIN(`SELECT ${deliverCall(oC, '2026-03-15 10:00:00-03')};`);
periodClosedBlocks.deliver = raised(r, 'PERIOD_CLOSED');
check('C9 CLOSED period blocks delivery (PERIOD_CLOSED)', periodClosedBlocks.deliver, firstErr(r));
check('C10 the rejected delivery left no partial change (order, lines, ledger, money, audit)',
  snapshot() === snap && owner(`SELECT estado || '|' || coalesce(delivered_at::TEXT, 'null') FROM pedidos WHERE id = '${oC}';`) === 'PENDING|null');

r = ADMIN(`SELECT ${deliverCall(oC, '2027-02-10 10:00:00-03')};`);
check('C11 date without a management_period → PERIOD_NOT_FOUND', raised(r, 'PERIOD_NOT_FOUND'), firstErr(r));

const cI = mkClient('Inactivo', false);
const oI = createOrder(cI, [[pB, 1]]);
r = ADMIN(`SELECT ${deliverCall(oI, '2026-04-11 10:00:00-03')};`);
check('C12 inactive client → CLIENT_NOT_FOUND_OR_INACTIVE (contract validation), stays PENDING',
  raised(r, 'CLIENT_NOT_FOUND_OR_INACTIVE') && owner(`SELECT estado FROM pedidos WHERE id = '${oI}';`) === 'PENDING', firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Rectification');

const moneyBeforeRect = moneyCounts();
const rect1 = rpc(rectifyCall(oB, [[pA, 10, 1250.50], [pB, 5, 800], [pA, 2, 1300]], 'ajuste cantidades'));
check('D1 rectification creates version 1 (return: version, previous, new, adjustment)',
  rect1.version_seq === 1 && Number(rect1.previous_total) === 20606 && Number(rect1.new_total) === 19105
  && Number(rect1.adjustment) === -1501, JSON.stringify(rect1));

const v0 = owner(`SELECT string_agg(is_current || ':' || cantidad || ':' || precio_unitario, ',' ORDER BY precio_unitario)
  FROM pedido_lineas WHERE pedido_id = '${oB}' AND version_seq = 0;`);
check('D2 version 0 is no longer current and its snapshot fields are untouched',
  v0 === 'false:7.0000:800.00,false:12.0000:1250.50', v0);

const cur = owner(`SELECT count(DISTINCT version_seq) || '|' || count(*) || '|' || max(version_seq)
  FROM pedido_lineas WHERE pedido_id = '${oB}' AND is_current;`);
check('D3 exactly one current version (1), holding 3 current lines',
  cur === '1|3|1' && owner(`SELECT rectification_seq FROM pedidos WHERE id = '${oB}';`) === '1', cur);

r = raw(`INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, version_seq, is_current)
         VALUES ('${oB}', '${pB}', 1, 1, 'x', 0, true);`);
check('D4 exclusion constraint rejects a second current version (even for the table owner)',
  !r.ok && /excl_pedido_lineas_single_current_version/.test(r.err), firstErr(r));
r = raw(`UPDATE pedido_lineas SET is_current = true WHERE pedido_id = '${oB}' AND version_seq = 0;`);
check('D5 exclusion constraint rejects re-activating the old version', !r.ok && /excl_pedido_lineas_single_current_version/.test(r.err), firstErr(r));

const rled = owner(`SELECT string_agg(movement_type || ':' || signed_amount || ':' || effective_date
  || ':' || coalesce(reversal_of_id::TEXT, '-'), ',' ORDER BY id) FROM client_ledger WHERE cliente_id = '${cB}';`);
const revId = owner(`SELECT id FROM client_ledger WHERE cliente_id = '${cB}' AND movement_type = 'REVERSAL';`);
check('D6 previous effect compensated: REVERSAL -20606.00 at the ORIGINAL delivered_date',
  rled.split(',')[1] === `REVERSAL:-20606.00:2026-04-10:-`, rled);
check('D7 new effect registered: SALE_DELIVERY +19105.00 with reversal_of_id → the reversal',
  rled.split(',')[2] === `SALE_DELIVERY:19105.00:2026-04-10:${revId}`, rled);
check('D8 client balance = new total 19105.00', clientBalance(cB) === '19105.00', clientBalance(cB));
check('D9 rectification creates NO financial_operation / financial_posting', moneyCounts() === moneyBeforeRect, moneyCounts());

const aud = owner(`SELECT before_values::TEXT || '|' || after_values::TEXT || '|' || reason || '|' || performed_by
  || '|' || (performed_at IS NOT NULL) FROM audit_events
  WHERE entity_type = 'pedido' AND entity_id = '${oB}' AND action = 'RECTIFY_DELIVERED_ORDER';`);
check('D10 audit_events RECTIFY_DELIVERED_ORDER holds before/after version, total, line_count, reason, actor, time',
  aud === `{"total": 20606.00, "version": 0, "line_count": 2}|{"total": 19105.00, "version": 1, "line_count": 3}|ajuste cantidades|${ADMIN_UID}|true`, aud);

const rect2 = rpc(rectifyCall(oB, [[pB, 10, 800]], 'segunda corrección'));
const lastRev2 = owner(`SELECT signed_amount FROM client_ledger WHERE cliente_id = '${cB}' AND movement_type = 'REVERSAL'
  ORDER BY id DESC LIMIT 1;`);
check('D11 second pass reverses the CURRENT version (-19105.00), not the original (-20606.00)',
  rect2.version_seq === 2 && lastRev2 === '-19105.00', `${JSON.stringify(rect2)} rev=${lastRev2}`);
const rect3 = rpc(rectifyCall(oB, [[pA, 4, 1500]], 'tercera corrección'));
const lastRev3 = owner(`SELECT signed_amount FROM client_ledger WHERE cliente_id = '${cB}' AND movement_type = 'REVERSAL'
  ORDER BY id DESC LIMIT 1;`);
const curTotalB = owner(`SELECT SUM(subtotal) FROM pedido_lineas WHERE pedido_id = '${oB}' AND is_current;`);
check('D12 third pass reverses -8000.00; ledger nets to the current total (6000.00) across repeated passes',
  rect3.version_seq === 3 && lastRev3 === '-8000.00' && clientBalance(cB) === '6000.00' && curTotalB === '6000.00',
  `rev=${lastRev3} bal=${clientBalance(cB)} cur=${curTotalB}`);
check('D13 history retained: 2+3+1+1 = 7 lines, 4 versions, 1 current',
  owner(`SELECT count(*) || '|' || count(DISTINCT version_seq) || '|' || count(*) FILTER (WHERE is_current)
         FROM pedido_lineas WHERE pedido_id = '${oB}';`) === '7|4|1');

snap = snapshot();
const rectErrors = [
  [rectifyCall(oB, [[pA, 1, 1]], null), 'REASON_REQUIRED'],
  [rectifyCall(oB, [[pA, 1, 1]], '   '), 'REASON_REQUIRED'],
  [`rectify_delivered_order('${oB}', '[]'::jsonb, 'x')`, 'EMPTY_LINE_SET'],
  [`rectify_delivered_order('${oB}', NULL, 'x')`, 'EMPTY_LINE_SET'],
  [rectifyCall(oC, [[pA, 1, 1]], 'x'), 'ORDER_NOT_DELIVERED'],
  [rectifyCall(MISSING_UUID, [[pA, 1, 1]], 'x'), 'ORDER_NOT_FOUND'],
  [rectifyCall(oB, [[pA, 0, 1]], 'x'), 'INVALID_QUANTITY'],
  [rectifyCall(oB, [[pA, 1, -1]], 'x'), 'INVALID_PRICE'],
  [rectifyCall(oB, [[pA, 1, 1], [MISSING_UUID, 1, 1]], 'x'), 'PRODUCT_NOT_FOUND'],
];
const rectErrOk = rectErrors.map(([call, code]) => [code, raised(ADMIN(`SELECT ${call};`), code)]);
check(`D14 contract errors raised: ${rectErrors.map((e) => e[1]).join(', ')}`,
  rectErrOk.every(([, ok]) => ok), rectErrOk.filter(([, ok]) => !ok).map(([c]) => c).join(','));
check('D15 none of those failures left any partial state (a later invalid line aborts before mutation)',
  snapshot() === snap);

const cR = mkClient('Cliente R');
const oR = createOrder(cR, [[pB, 2]]);
rpc(deliverCall(oR, '2026-06-05 12:00:00-03'));
closePeriod('2026-06-01');
snap = snapshot();
r = ADMIN(`SELECT ${rectifyCall(oR, [[pB, 1, 800]], 'en período cerrado')};`);
periodClosedBlocks.rectify = raised(r, 'PERIOD_CLOSED');
check('D16 CLOSED period of the ORIGINAL delivered_date blocks rectification', periodClosedBlocks.rectify, firstErr(r));
check('D17 the rejected rectification left no partial state (lines, seq, ledger, audit)',
  snapshot() === snap && owner(`SELECT rectification_seq FROM pedidos WHERE id = '${oR}';`) === '0');
openPeriod('2026-06-01');

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Cancellation');

const oE = createOrder(cB, [[pB, 3]]);
const ledgerCountBeforeCancel = owner(`SELECT count(*) FROM client_ledger;`);
const moneyBeforeCancel = moneyCounts();
const cE1 = rpc(cancelCall(oE, '2026-04-20 22:00:00-03', 'cliente desistió'));
check('E1 PENDING → CANCELLED with Buenos Aires cancelled_date',
  cE1.estado === 'CANCELLED' && cE1.cancelled_date === '2026-04-20'
  && owner(`SELECT estado || '|' || cancelled_date FROM pedidos WHERE id = '${oE}';`) === 'CANCELLED|2026-04-20', JSON.stringify(cE1));
check('E2 no hard delete: order and its lines remain',
  owner(`SELECT count(*) FROM pedidos WHERE id = '${oE}';`) === '1'
  && owner(`SELECT count(*) FROM pedido_lineas WHERE pedido_id = '${oE}';`) === '1');
check('E3 cancellation creates no client_ledger and no money movement',
  owner(`SELECT count(*) FROM client_ledger;`) === ledgerCountBeforeCancel && moneyCounts() === moneyBeforeCancel);
const audE = owner(`SELECT (before_values->>'estado') || '|' || (after_values->>'estado') || '|' || reason || '|' || performed_by
  FROM audit_events WHERE entity_type = 'pedido' AND entity_id = '${oE}' AND action = 'CANCEL';`);
check('E4 audit CANCEL: PENDING → CANCELLED, reason, actor', audE === `PENDING|CANCELLED|cliente desistió|${ADMIN_UID}`, audE);

r = ADMIN(`SELECT ${cancelCall(oE, '2026-04-21 10:00:00-03', 'otra vez')};`);
check('E5 cancelling a CANCELLED order → ONLY_PENDING_CAN_CANCEL', raised(r, 'ONLY_PENDING_CAN_CANCEL'), firstErr(r));
snap = snapshot();
r = ADMIN(`SELECT ${cancelCall(oB, '2026-04-21 10:00:00-03', 'no')};`);
check('E6 a DELIVERED order is never cancelled (ONLY_PENDING_CAN_CANCEL), nothing changes',
  raised(r, 'ONLY_PENDING_CAN_CANCEL') && snapshot() === snap, firstErr(r));

const oE2 = createOrder(cB, [[pB, 1]]);
const cE2 = rpc(cancelCall(oE2, '2026-03-10 10:00:00-03', 'cancelado en marzo'));
check('E7 cancel has no period determinant: allowed with a date in CLOSED 2026-03 (contract)',
  cE2.estado === 'CANCELLED', JSON.stringify(cE2));

r = ADMIN(`WITH u AS (UPDATE pedidos SET estado = 'PENDING' WHERE id = '${oE}' RETURNING 1) SELECT count(*) FROM u;`);
check('E8 a CANCELLED order cannot be revived by direct UPDATE (0 rows, still CANCELLED)',
  r.ok && r.out === '0' && owner(`SELECT estado FROM pedidos WHERE id = '${oE}';`) === 'CANCELLED', r.out || firstErr(r));
r = ADMIN(`DELETE FROM pedidos WHERE id = '${oE}';`);
check('E9 ADMIN cannot DELETE pedidos (no privilege)', denied(r), firstErr(r));
r = ADMIN(`INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre)
           VALUES ('${oE}', '${pB}', 1, 800, 'x');`);
check('E10 no lines may be added to a CANCELLED order (RLS)', rlsDenied(r), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Collection');

const cF = mkClient('Cliente F');
const oF = createOrder(cF, [[pB, 25]]);
rpc(deliverCall(oF, '2026-04-12 10:00:00-03'));
check('F0 fixture: client F owes 20000.00 after delivery', clientBalance(cF) === '20000.00', clientBalance(cF));

const caja0 = accountBalance(ACC.CAJA);
const bna0 = accountBalance(ACC.BNA);
const mp0 = accountBalance(ACC.MP);
const pat0 = accountBalance(ACC.PAT);

const colCash = rpc(collectCall(cF, 5000, 'CASH', `${TAG}-R-CASH-1`, '2026-04-15', ACC.CAJA, "NULL, 'efectivo'"));
check('F1 CASH reduces debt: COLLECTION -5000.00 at the collection date, source collections',
  owner(`SELECT movement_type || '|' || signed_amount || '|' || effective_date || '|' || source_entity_type || '|' || source_entity_id
         FROM client_ledger WHERE id = ${colCash.client_ledger_id};`) === `COLLECTION|-5000.00|2026-04-15|collections|${colCash.collection_id}`
  && clientBalance(cF) === '15000.00', clientBalance(cF));
check('F2 CASH increases Caja chica by exactly +5000.00', accountBalance(ACC.CAJA) === plus(caja0, 5000), accountBalance(ACC.CAJA));

const colTr = rpc(collectCall(cF, 7000, 'TRANSFER', `${TAG}-R-TR-1`, '2026-04-16', ACC.BNA));
check('F3 TRANSFER reduces debt by 7000.00', clientBalance(cF) === '8000.00', clientBalance(cF));
check('F4 TRANSFER increases BNA by exactly +7000.00', accountBalance(ACC.BNA) === plus(bna0, 7000), accountBalance(ACC.BNA));

const colMp = rpc(collectCall(cF, 3000, 'MERCADOPAGO', `${TAG}-R-MP-1`, '2026-04-17', ACC.MP));
check('F5 MERCADOPAGO reduces debt by the gross amount (3000.00)', clientBalance(cF) === '5000.00', clientBalance(cF));
check('F6 MERCADOPAGO increases the Mercado Pago account by the gross +3000.00 (no netting)',
  accountBalance(ACC.MP) === plus(mp0, 3000), accountBalance(ACC.MP));
check('F7 an account not involved is untouched (Patagonia)', accountBalance(ACC.PAT) === pat0);

const op = owner(`SELECT operation_type || '|' || effective_date || '|' || external_ref || '|' || source_entity_type
  || '|' || source_entity_id || '|' || created_by FROM financial_operation WHERE id = ${colTr.financial_operation_id};`);
check('F8 financial_operation COLLECTION: external_ref = receipt_id, source collections, date, actor',
  op === `COLLECTION|2026-04-16|${TAG}-R-TR-1|collections|${colTr.collection_id}|${ADMIN_UID}`, op);
const postings = owner(`SELECT count(*) || '|' || SUM(signed_amount) || '|' || min(effective_date) || '|' || min(financial_account_id::TEXT)
  FROM financial_posting WHERE financial_operation_id = ${colTr.financial_operation_id};`);
check('F9 exactly one posting per collection: +7000.00 on BNA at the collection date',
  postings === `1|7000.00|2026-04-16|${ACC.BNA}`, postings);
const colRow = owner(`SELECT payment_method || '|' || amount || '|' || receipt_id || '|' || financial_account_id || '|' || created_by
  FROM collections WHERE id = '${colMp.collection_id}';`);
check('F10 collections row keeps method, amount, receipt, account, actor',
  colRow === `MERCADOPAGO|3000.00|${TAG}-R-MP-1|${ACC.MP}|${ADMIN_UID}`, colRow);

const sep = owner(`SELECT string_agg(movement_type || ':' || source_entity_type, ',' ORDER BY id) FROM client_ledger WHERE cliente_id = '${cF}';`);
const postingFromPedido = owner(`SELECT count(*) FROM financial_posting fp JOIN financial_operation fo ON fo.id = fp.financial_operation_id
  WHERE fo.source_entity_type = 'pedido';`);
const pedidoCol = owner(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'collections' AND column_name LIKE 'pedido%';`);
check('F11 delivery and collection stay separate (ledger sources, no pedido posting, no collection→order allocation)',
  sep === 'SALE_DELIVERY:pedido,COLLECTION:collections,COLLECTION:collections,COLLECTION:collections'
  && postingFromPedido === '0' && pedidoCol === '0', `${sep} / ${postingFromPedido} / ${pedidoCol}`);

rpc(collectCall(cF, 9000, 'CASH', `${TAG}-R-CASH-2`, '2026-04-18', ACC.CAJA));
check('F12 prepayment allowed: collecting 9000 on a 5000 debt leaves a -4000.00 credit', clientBalance(cF) === '-4000.00', clientBalance(cF));

snap = snapshot();
r = ADMIN(`SELECT ${collectCall(cF, 100, 'CASH', `${TAG}-R-CLOSED`, '2026-03-20', ACC.CAJA)};`);
periodClosedBlocks.collect = raised(r, 'PERIOD_CLOSED');
check('F13 CLOSED period blocks the collection', periodClosedBlocks.collect, firstErr(r));
check('F14 rejected collection: no collection, ledger, operation, posting or audit row', snapshot() === snap);

snap = snapshot();
const colErrors = [
  [collectCall(cF, 100, 'CHEQUE', `${TAG}-R-E1`, '2026-04-20', ACC.CAJA), 'USE_RECEIVE_CHEQUE'],
  [collectCall(cF, 0, 'CASH', `${TAG}-R-E2`, '2026-04-20', ACC.CAJA), 'INVALID_AMOUNT'],
  [collectCall(cF, -5, 'CASH', `${TAG}-R-E3`, '2026-04-20', ACC.CAJA), 'INVALID_AMOUNT'],
  [collectCall(cF, 100, 'CASH', `${TAG}-R-E4`, '2026-04-20', null), 'ACCOUNT_REQUIRED'],
  [collectCall(cI, 100, 'CASH', `${TAG}-R-E5`, '2026-04-20', ACC.CAJA), 'CLIENT_NOT_FOUND_OR_INACTIVE'],
  [collectCall(MISSING_UUID, 100, 'CASH', `${TAG}-R-E6`, '2026-04-20', ACC.CAJA), 'CLIENT_NOT_FOUND_OR_INACTIVE'],
  [collectCall(cF, 100, 'CASH', `${TAG}-R-CASH-1`, '2026-04-20', ACC.CAJA), 'DUPLICATE_RECEIPT'],
];
const colErrOk = colErrors.map(([call, code]) => [code, raised(ADMIN(`SELECT ${call};`), code)]);
check(`F15 contract errors raised: ${colErrors.map((e) => e[1]).join(', ')}`,
  colErrOk.every(([, ok]) => ok), colErrOk.filter(([, ok]) => !ok).map(([c]) => c).join(','));
check('F16 none of those failures wrote anything', snapshot() === snap);

// failure AFTER the collection and ledger rows were written: the operation's
// external_ref collides, so the whole call must roll back.
owner(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason)
       VALUES ('ADJUSTMENT', '2026-04-01', '${TAG}-R-BLOCK', 'test blocker');`);
snap = snapshot();
r = ADMIN(`SELECT ${collectCall(cF, 250, 'CASH', `${TAG}-R-BLOCK`, '2026-04-21', ACC.CAJA)};`);
check('F17 a failure at the financial_operation step rolls back the already-written collection and ledger rows',
  !r.ok && /financial_operation_external_ref_key/.test(r.err) && snapshot() === snap
  && owner(`SELECT count(*) FROM collections WHERE receipt_id = '${TAG}-R-BLOCK';`) === '0', firstErr(r));

snap = snapshot();
r = ADMIN(`SELECT ${collectCall(cF, 100, 'CASH', `${TAG}-R-SESS`, '2026-04-21', ACC.CAJA, `'${MISSING_UUID}'`)};`);
check('F18 a sales_session_id cannot dangle (frozen FK collections_sales_session_id_fkey since Phase 21), full rollback',
  !r.ok && /collections_sales_session_id_fkey/.test(r.err) && snapshot() === snap, firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'Derived balances');

check('G1 client balance = SUM(client_ledger.signed_amount) = 20000 - (5000+7000+3000+9000) = -4000.00',
  clientBalance(cF) === '-4000.00');
const derivedF = owner(`SELECT (
    (SELECT COALESCE(SUM(l.subtotal), 0) FROM pedido_lineas l JOIN pedidos p ON p.id = l.pedido_id
      WHERE p.cliente_id = '${cF}' AND p.estado = 'DELIVERED' AND l.is_current)
  - (SELECT COALESCE(SUM(amount), 0) FROM collections WHERE cliente_id = '${cF}'))::NUMERIC(15,2);`);
check('G2 ledger balance equals current delivered lines minus collections (no hidden source)', derivedF === clientBalance(cF), derivedF);
check('G3 account balance = SUM(financial_posting.signed_amount): Caja +14000, BNA +7000, MP +3000',
  accountBalance(ACC.CAJA) === plus(caja0, 14000) && accountBalance(ACC.BNA) === plus(bna0, 7000)
  && accountBalance(ACC.MP) === plus(mp0, 3000));
const balanceCols = owner(`SELECT coalesce(string_agg(table_name || '.' || column_name, ','), '') FROM information_schema.columns
  WHERE table_schema = 'public' AND (column_name ~* '(saldo|balance)' OR column_name IN ('monto_total','total')) AND table_name NOT IN (${ADR005_VIEWS});`);
check('G4 no authoritative stored balance column anywhere in public (no saldo/balance/total)', balanceCols === '', balanceCols);
const triggers = owner(`SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
  AND tgrelid::regclass::TEXT IN (${COMMERCIAL_TABLES.map((t) => `'${t}'`).join(',')}, 'clients', 'financial_account');`);
check('G5 no trigger maintains any balance (no user triggers on commercial/master tables)', triggers === '0', triggers);

// ═══════════════════════════════════════════════════════════════════════════
section('H', 'Security');

for (const t of ['clients', 'pedidos', 'pedido_lineas', 'client_ledger', 'collections',
  'financial_operation', 'financial_posting', 'financial_account']) {
  r = OPER(`SELECT count(*) FROM ${t};`);
  check(`H1 OPERATOR reads 0 rows of ${t}`, r.ok && r.out === '0', r.out || firstErr(r));
}
r = OPER(`INSERT INTO pedidos (cliente_id) VALUES ('${cB}');`);
check('H2 OPERATOR cannot INSERT pedidos (RLS)', rlsDenied(r), firstErr(r));
r = OPER(`INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre)
          VALUES ('${oC}', '${pB}', 1, 800, 'x');`);
check('H3 OPERATOR cannot INSERT pedido_lineas (RLS)', rlsDenied(r), firstErr(r));
r = OPER(`WITH u AS (UPDATE pedidos SET numero_pedido = 1 WHERE id = '${oC}' RETURNING 1) SELECT count(*) FROM u;`);
check('H4 OPERATOR UPDATE on pedidos touches 0 rows', r.ok && r.out === '0', r.out || firstErr(r));
const operRpc = [
  deliverCall(oC, '2026-04-22 10:00:00-03'), rectifyCall(oB, [[pA, 1, 1]], 'x'),
  cancelCall(oC, '2026-04-22 10:00:00-03', 'x'), collectCall(cF, 1, 'CASH', `${TAG}-R-OP`, '2026-04-22', ACC.CAJA),
].map((c) => raised(OPER(`SELECT ${c};`), 'FORBIDDEN'));
check('H5 OPERATOR gets FORBIDDEN from all four Commercial RPCs', operRpc.every(Boolean), operRpc.join(','));

r = ADMIN(`INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name)
           VALUES ('${cB}', 'ADJUSTMENT', -100, '2026-04-10', 'x');`);
check('H6 authenticated (even ADMIN) cannot INSERT client_ledger directly', denied(r), firstErr(r));
r = ADMIN(`INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
           VALUES (${colTr.financial_operation_id}, '${ACC.CAJA}', 1000000, '2026-04-10');`);
check('H7 authenticated (even ADMIN) cannot INSERT financial_posting directly', denied(r), firstErr(r));
r = ADMIN(`INSERT INTO financial_operation (operation_type, effective_date) VALUES ('ADJUSTMENT', '2026-04-10');`);
const r2 = ADMIN(`INSERT INTO collections (cliente_id, amount, payment_method, receipt_id, effective_date, financial_account_id)
                  VALUES ('${cB}', 1, 'CASH', 'x', '2026-04-10', '${ACC.CAJA}');`);
check('H8 no direct INSERT into financial_operation or collections', denied(r) && denied(r2), `${firstErr(r)} / ${firstErr(r2)}`);

snap = snapshot();
r = ADMIN(`WITH u AS (UPDATE pedidos SET rectification_seq = 99, delivered_date = '2026-04-01' WHERE id = '${oB}' RETURNING 1)
           SELECT count(*) FROM u;`);
check('H9 a DELIVERED sale cannot be altered by direct UPDATE (0 rows, unchanged)', r.ok && r.out === '0' && snapshot() === snap, r.out || firstErr(r));
r = ADMIN(`WITH d AS (DELETE FROM pedido_lineas WHERE pedido_id = '${oB}' RETURNING 1) SELECT count(*) FROM d;`);
check('H10 lines of a DELIVERED sale cannot be deleted (0 rows)', r.ok && r.out === '0' && snapshot() === snap, r.out || firstErr(r));
const ledgerWrites = [
  ADMIN(`UPDATE client_ledger SET signed_amount = 1 WHERE cliente_id = '${cB}';`),
  ADMIN(`DELETE FROM client_ledger WHERE cliente_id = '${cB}';`),
  ADMIN(`TRUNCATE client_ledger;`),
  ADMIN(`TRUNCATE financial_posting;`),
  ADMIN(`DELETE FROM financial_posting;`),
  ADMIN(`TRUNCATE pedidos CASCADE;`),
];
check('H11 UPDATE/DELETE/TRUNCATE on ledgers and TRUNCATE on pedidos: permission denied (TRUNCATE would bypass RLS)',
  ledgerWrites.every(denied) && snapshot() === snap, ledgerWrites.map((x) => (denied(x) ? 'd' : 'OPEN')).join(','));

r = asUser(INACTIVE_UID, `SELECT ${deliverCall(oC, '2026-04-22 10:00:00-03')};`);
const rs = asUser(INACTIVE_UID, `SELECT count(*) FROM pedidos;`);
check('H12 inactive profile: RPC → USER_NOT_FOUND_OR_INACTIVE; reads yield no rows',
  raised(r, 'USER_NOT_FOUND_OR_INACTIVE') && (!rs.ok || rs.out === '0'), `${firstErr(r)} / ${rs.out || firstErr(rs)}`);
r = asUser(NOPROFILE_UID, `SELECT ${collectCall(cF, 1, 'CASH', `${TAG}-R-NP`, '2026-04-22', ACC.CAJA)};`);
check('H13 missing profile: RPC → USER_NOT_FOUND_OR_INACTIVE', raised(r, 'USER_NOT_FOUND_OR_INACTIVE'), firstErr(r));
r = asUser(OPER_UID, `SELECT ${deliverCall(oC, '2026-04-22 10:00:00-03')};`, { app_role: 'ADMIN', user_role: 'ADMIN' });
check('H14 a forged JWT business-role claim grants nothing (still FORBIDDEN)', raised(r, 'FORBIDDEN'), firstErr(r));
const anonSel = asAnon(`SELECT count(*) FROM client_ledger;`);
const anonExec = asAnon(`SELECT ${deliverCall(oC, '2026-04-22 10:00:00-03')};`);
check('H15 anon: no SELECT on Commercial tables and no EXECUTE on the RPCs', denied(anonSel) && denied(anonExec),
  `${firstErr(anonSel)} / ${firstErr(anonExec)}`);
const srSel = asServiceRole(`SELECT count(*) FROM client_ledger;`);
const srIns = asServiceRole(`INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
                             VALUES (${colTr.financial_operation_id}, '${ACC.CAJA}', 1, '2026-04-10');`);
check('H16 service_role holds no privilege on Commercial tables (not a business role)', denied(srSel) && denied(srIns),
  `${firstErr(srSel)} / ${firstErr(srIns)}`);
check('H17 RPC as ADMIN works (deliveries, rectifications, cancellations, collections above succeeded)',
  dB.estado === 'DELIVERED' && rect1.version_seq === 1 && cE1.estado === 'CANCELLED' && !!colCash.collection_id);

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'SECURITY DEFINER');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc
  WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
// Exact inventory: Foundation (2) + Commercial (4) + RPCs of built later phases
// (Phase 15: transfer_between_accounts; Phase 16: RPCs 5–12 + 42; Phase 17: RPCs 13–17; Phase 18: RPCs 18–22; Phase 19: RPC 25).
check('I1 SECURITY DEFINER inventory = 2 Foundation functions + the 4 Commercial RPCs + built later-phase RPCs',
  definers === 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,close_flock,close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_apply_transition,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_report_fallback,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,open_sales_session,pay_fiscal_obligation,pay_supplier,publish_feed_formula_version,receive_cheque,'
  + 'rectify_classification,rectify_daily_production,rectify_delivered_order,rectify_feed_manufacturing,rectify_mortality,rectify_purchase,register_bank_tax,register_classification,register_collection,'
  + 'register_count_adjustment,register_daily_production,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,register_fiscal_document,register_fiscal_obligation,register_flock,register_freight,register_management_event,register_mortality,register_purchase,register_session_cash_event,register_session_movement,reject_cheque,'
  + 'reject_supplier_instrument,transfer_between_accounts', definers);
const inList = RPCS.map((p) => `'${p}'`).join(',');
const unpinned = owner(`SELECT coalesce(string_agg(proname, ','), '') FROM pg_proc WHERE proname IN (${inList})
  AND NOT (prosecdef AND coalesce(proconfig, '{}') @> ARRAY['search_path=public']);`);
check('I2 all four RPCs are SECURITY DEFINER with search_path=public', unpinned === '', unpinned);
const pubExec = owner(`SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname IN (${inList}) AND a.grantee = 0;`);
const nullAcl = owner(`SELECT count(*) FROM pg_proc WHERE proname IN (${inList}) AND proacl IS NULL;`);
check('I3 PUBLIC has no EXECUTE on any of them (explicit ACL, no PUBLIC entry)', pubExec === '0' && nullAcl === '0', `${pubExec}/${nullAcl}`);
const execMatrix = owner(`SELECT string_agg(proname || ':' || has_function_privilege('authenticated', oid, 'EXECUTE')
  || ':' || has_function_privilege('anon', oid, 'EXECUTE') || ':' || pg_get_userbyid(proowner), ',' ORDER BY proname)
  FROM pg_proc WHERE proname IN (${inList});`);
check('I4 EXECUTE: authenticated yes, anon no; owner postgres',
  execMatrix === RPCS.map((p) => `${p}:true:false:postgres`).join(','), execMatrix);
const actorArgs = owner(`SELECT coalesce(string_agg(proname, ','), '') FROM pg_proc WHERE proname IN (${inList})
  AND EXISTS (SELECT 1 FROM unnest(proargnames) n WHERE n ~* '(user|actor|role|performed|created_by|uid)');`);
check('I5 no RPC parameter can name the actor or the role', actorArgs === '', actorArgs);

// ═══════════════════════════════════════════════════════════════════════════
section('J', 'Audit');

const actions = owner(`SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_events
  WHERE (entity_type = 'pedido' AND entity_id IN (SELECT id::TEXT FROM pedidos WHERE cliente_id IN ${TEST_CLIENTS}))
     OR (entity_type = 'collections' AND entity_id IN (SELECT id::TEXT FROM collections WHERE cliente_id IN ${TEST_CLIENTS}));`);
check('J1 transversal audit_events holds CANCEL, CREATE (collections), DELIVER, RECTIFY_DELIVERED_ORDER',
  actions === 'CANCEL,CREATE,DELIVER,RECTIFY_DELIVERED_ORDER', actions);
const audCounts = owner(`SELECT
  (SELECT count(*) FROM audit_events WHERE entity_type = 'pedido' AND entity_id = '${oB}' AND action = 'DELIVER') || '|' ||
  (SELECT count(*) FROM audit_events WHERE entity_type = 'pedido' AND entity_id = '${oB}' AND action = 'RECTIFY_DELIVERED_ORDER') || '|' ||
  (SELECT count(*) FROM audit_events WHERE entity_type = 'collections'
     AND entity_id IN (SELECT id::TEXT FROM collections WHERE cliente_id = '${cF}'));`);
check('J2 one audit row per successful operation (1 delivery, 3 rectifications, 4 collections)', audCounts === '1|3|4', audCounts);
const badAudit = owner(`SELECT count(*) FROM audit_events WHERE entity_type IN ('pedido','collections')
  AND (performed_by IS DISTINCT FROM '${ADMIN_UID}' OR performed_at IS NULL);`);
check('J3 every Commercial audit row names the real actor and a time', badAudit === '0', badAudit);
const auditTamper = [ADMIN(`UPDATE audit_events SET reason = 'x';`), ADMIN(`DELETE FROM audit_events;`), ADMIN(`TRUNCATE audit_events;`)];
check('J4 audit_events: no UPDATE / DELETE / TRUNCATE for any application role', auditTamper.every(denied),
  auditTamper.map(firstErr).join(' / '));
const extraAudit = owner(`SELECT coalesce(string_agg(table_name, ','), '') FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name LIKE '%audit%' AND table_name <> 'audit_events';`);
check('J5 no parallel audit table', extraAudit === '', extraAudit);

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'Period');

const oK = createOrder(cB, [[pB, 2]]);
owner(`UPDATE pedidos SET created_at = '2026-03-15 10:00:00-03' WHERE id = '${oK}';`);
const dK = rpc(deliverCall(oK, '2026-04-25 10:00:00-03'));
check('K1 created_at in CLOSED 2026-03 does not decide the period: delivery into OPEN 2026-04 succeeds',
  dK.delivered_date === '2026-04-25'
  && owner(`SELECT effective_date FROM client_ledger WHERE source_entity_id = '${oK}';`) === '2026-04-25', JSON.stringify(dK));

const oK2 = createOrder(cB, [[pB, 2]]);
r = ADMIN(`SELECT ${deliverCall(oK2, '2026-03-28 10:00:00-03')};`);
check('K2 the business date decides: created now (OPEN month) but delivered in CLOSED 2026-03 → PERIOD_CLOSED',
  raised(r, 'PERIOD_CLOSED'), firstErr(r));
r = ADMIN(`SELECT ${deliverCall(oK2, '2026-04-01 02:00:00+00')};`);
check('K3 Buenos Aires date, not UTC: 2026-04-01 02:00 UTC is 2026-03-31 in BA → PERIOD_CLOSED',
  raised(r, 'PERIOD_CLOSED'), firstErr(r));
const dK2 = rpc(deliverCall(oK2, '2026-04-01 03:30:00+00'));
check('K4 2026-04-01 03:30 UTC is 2026-04-01 00:30 in BA → accepted, delivered_date 2026-04-01',
  dK2.delivered_date === '2026-04-01', JSON.stringify(dK2));
check('K5 CLOSED blocks every period-sensitive Commercial RPC: deliver, rectify, collect',
  periodClosedBlocks.deliver && periodClosedBlocks.rectify && periodClosedBlocks.collect, JSON.stringify(periodClosedBlocks));
openPeriod('2026-03-01');
const dC = rpc(deliverCall(oC, '2026-03-15 10:00:00-03'));
check('K6 once reopened, the same March delivery is accepted (the guard reads live period status)',
  dC.delivered_date === '2026-03-15', JSON.stringify(dC));
closePeriod('2026-03-01');

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'Idempotency / atomicity');

snap = snapshot();
const failing = [
  deliverCall(oB, '2026-04-10 10:00:00-03'), deliverCall(oI, '2026-04-10 10:00:00-03'),
  deliverCall(oEmpty, '2026-04-10 10:00:00-03'), rectifyCall(oB, [[MISSING_UUID, 1, 1]], 'x'),
  rectifyCall(oC, [[pB, 1, 800]], 'x'),                          // oC delivered in now-CLOSED March
  cancelCall(oB, '2026-04-10 10:00:00-03', 'x'),
  collectCall(cF, 10, 'CASH', `${TAG}-R-CASH-1`, '2026-04-10', ACC.CAJA),
  collectCall(cF, 10, 'CASH', `${TAG}-R-L1`, '2026-03-10', ACC.CAJA),
  collectCall(cF, 10, 'CHEQUE', `${TAG}-R-L2`, '2026-04-10', ACC.CAJA),
];
const allFailed = failing.map((c) => !ADMIN(`SELECT ${c};`).ok);
check(`L1 ${failing.length} failing calls across all four RPCs: every one failed and the global state is byte-identical`,
  allFailed.every(Boolean) && snapshot() === snap, allFailed.join(','));

const dupCount = owner(`SELECT (SELECT count(*) FROM collections WHERE receipt_id = '${TAG}-R-CASH-1') || '|' ||
  (SELECT count(*) FROM financial_operation WHERE external_ref = '${TAG}-R-CASH-1');`);
check('L2 repeated collection with the same receipt: exactly one collection and one operation exist', dupCount === '1|1', dupCount);
check('L3 repeated deliver / cancel are rejected by the state guard (C6, E5)',
  owner(`SELECT count(*) FROM client_ledger WHERE source_entity_id = '${oB}' AND movement_type = 'SALE_DELIVERY' AND reversal_of_id IS NULL;`) === '1'
  && owner(`SELECT count(*) FROM audit_events WHERE entity_id = '${oE}' AND action = 'CANCEL';`) === '1');

const same = [[pB, 3, 800]];
const rA = rpc(rectifyCall(oK, same, 'replay 1'));
const rB = rpc(rectifyCall(oK, same, 'replay 2'));
check('L4 rectification is not idempotent by design: identical replays create versions 1 and 2, ledger nets to 2400.00',
  rA.version_seq === 1 && rB.version_seq === 2 && Number(rB.adjustment) === 0
  && owner(`SELECT SUM(signed_amount) FROM client_ledger WHERE source_entity_id = '${oK}';`) === '2400.00',
  `${JSON.stringify(rA)} ${JSON.stringify(rB)}`);

// Money enters only through collections. Internal transfers (Phase 15) may also
// exist; each one nets to zero, so it moves money without creating any.
const moneyPaths = owner(`SELECT
  (SELECT count(*) FROM financial_posting fp JOIN financial_operation fo ON fo.id = fp.financial_operation_id
    WHERE NOT ((fo.operation_type = 'COLLECTION' AND fo.source_entity_type = 'collections')
               OR fo.operation_type = 'TRANSFER')) || '|' ||
  (SELECT count(*) FROM financial_posting fp JOIN financial_operation fo ON fo.id = fp.financial_operation_id
    WHERE fo.operation_type = 'COLLECTION') || '|' || (SELECT count(*) FROM collections) || '|' ||
  ((SELECT COALESCE(SUM(fp.signed_amount), 0) FROM financial_posting fp JOIN financial_operation fo ON fo.id = fp.financial_operation_id
     WHERE fo.operation_type = 'COLLECTION') = (SELECT COALESCE(SUM(amount), 0) FROM collections)) || '|' ||
  (SELECT count(*) FROM (SELECT fo.id FROM financial_operation fo JOIN financial_posting fp ON fp.financial_operation_id = fo.id
     WHERE fo.operation_type = 'TRANSFER' GROUP BY fo.id HAVING SUM(fp.signed_amount) <> 0) t);`);
check('L5 no path creates money from a delivery: every posting is a collection or a zero-sum transfer; collection postings = collections in count and sum',
  /^0\|(\d+)\|\1\|true\|0$/.test(moneyPaths), moneyPaths);

// ═══════════════════════════════════════════════════════════════════════════
section('S1', 'End-to-end scenario');

const cS = mkClient('E2E');
check('S1.1 test client exists and is visible to ADMIN', adminOk(`SELECT count(*) FROM clients WHERE id = '${cS}';`) === '1');
const pM = mkProduct('E2E Maple', 4500);
const pD = mkProduct('E2E Docena', 1800);
const oS = createOrder(cS, [[pM, 10], [pD, 6]]);
check('S1.2 PENDING order with two lines at the configured prices (10×4500 + 6×1800 = 55800.00)',
  owner(`SELECT estado || '|' || (SELECT count(*) FROM pedido_lineas WHERE pedido_id = '${oS}') || '|'
         || (SELECT SUM(subtotal) FROM pedido_lineas WHERE pedido_id = '${oS}' AND is_current) FROM pedidos WHERE id = '${oS}';`)
  === 'PENDING|2|55800.00');
check('S1.3 client debt = 0.00 before delivery', clientBalance(cS) === '0.00');
const bnaS = accountBalance(ACC.BNA);
const postingsS0 = owner(`SELECT count(*) FROM financial_posting;`);
rpc(deliverCall(oS, '2026-05-06 11:00:00-03'));
check('S1.4 after delivery debt = sale total 55800.00', clientBalance(cS) === '55800.00', clientBalance(cS));
check('S1.5 financial account unchanged by delivery (BNA and posting count)',
  accountBalance(ACC.BNA) === bnaS && owner(`SELECT count(*) FROM financial_posting;`) === postingsS0);
rpc(collectCall(cS, 20000, 'TRANSFER', `${TAG}-E2E-1`, '2026-05-10', ACC.BNA));
check('S1.6 partial collection: debt = 55800 - 20000 = 35800.00', clientBalance(cS) === '35800.00', clientBalance(cS));
check('S1.7 BNA += 20000.00', accountBalance(ACC.BNA) === plus(bnaS, 20000), accountBalance(ACC.BNA));
rpc(collectCall(cS, 35800, 'TRANSFER', `${TAG}-E2E-2`, '2026-05-20', ACC.BNA));
check('S1.8 remaining collection: debt = 0.00', clientBalance(cS) === '0.00', clientBalance(cS));
check('S1.9 BNA += total collected 55800.00', accountBalance(ACC.BNA) === plus(bnaS, 55800), accountBalance(ACC.BNA));
const e2ePost = owner(`SELECT count(*) || '|' || bool_and(fo.operation_type = 'COLLECTION' AND fo.source_entity_type = 'collections')
  FROM financial_posting fp JOIN financial_operation fo ON fo.id = fp.financial_operation_id
  WHERE fo.external_ref LIKE '${TAG}-E2E-%' OR fo.source_entity_id = '${oS}';`);
check('S1.10 exactly 2 postings in the scenario, both from collections — none from the delivery', e2ePost === '2|true', e2ePost);

// ═══════════════════════════════════════════════════════════════════════════
section('S2', 'Rectification scenario');

const cT = mkClient('Rect');
const oT = createOrder(cT, [[pM, 5], [pD, 10], [pA, 1]]);                 // 22500 + 18000 + 1400
rpc(deliverCall(oT, '2026-05-05 10:00:00-03'));
const treasuryT0 = allAccountBalances();
check('S2.0 delivered total 41900.00', clientBalance(cT) === '41900.00', clientBalance(cT));
rpc(rectifyCall(oT, [[pM, 4, 4500], [pD, 10, 1800]], 'devolución parcial'));   // 36000
rpc(rectifyCall(oT, [[pM, 4, 4500]], 'segunda devolución'));                  // 18000
const histT = owner(`SELECT string_agg(version_seq || ':' || is_current || ':' || cnt, ',' ORDER BY version_seq) FROM (
  SELECT version_seq, bool_and(is_current) AS is_current, count(*) AS cnt FROM pedido_lineas WHERE pedido_id = '${oT}' GROUP BY version_seq) s;`);
check('S2.1 line history retained: v0 3 lines, v1 2 lines (retired), v2 1 line (current)',
  histT === '0:false:3,1:false:2,2:true:1', histT);
check('S2.2 exactly one version is current',
  owner(`SELECT count(DISTINCT version_seq) FROM pedido_lineas WHERE pedido_id = '${oT}' AND is_current;`) === '1');
const ledT = owner(`SELECT string_agg(movement_type || ':' || signed_amount, ',' ORDER BY id) FROM client_ledger WHERE cliente_id = '${cT}';`);
check('S2.3 CC reflects the rectified amount (18000.00) through reversals of each CURRENT version',
  clientBalance(cT) === '18000.00'
  && ledT === 'SALE_DELIVERY:41900.00,REVERSAL:-41900.00,SALE_DELIVERY:36000.00,REVERSAL:-36000.00,SALE_DELIVERY:18000.00', ledT);
check('S2.4 treasury unchanged by delivery and both rectifications', allAccountBalances() === treasuryT0);
const cajaT = accountBalance(ACC.CAJA);
rpc(collectCall(cT, 18000, 'CASH', `${TAG}-RECT-1`, '2026-05-25', ACC.CAJA));
check('S2.5 treasury moves only at collection: Caja +18000.00, CC 0.00',
  accountBalance(ACC.CAJA) === plus(cajaT, 18000) && clientBalance(cT) === '0.00');
} finally {
  // ── cleanup ────────────────────────────────────────────────────────────
  cleanup();
}

section('Z', 'Cleanup');
const leftovers = owner(`SELECT
  (SELECT count(*) FROM clients WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM products WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM financial_operation WHERE external_ref LIKE '${TAG}%');`);
check('Z1 all P14-TEST fixtures removed', leftovers === '0', leftovers);
const closedLeft = owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN ('2026-03-01','2026-06-01');`);
check('Z2 periods closed by the suite are OPEN again', closedLeft === '0', closedLeft);

console.log(`\n  ══ COMMERCIAL RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
