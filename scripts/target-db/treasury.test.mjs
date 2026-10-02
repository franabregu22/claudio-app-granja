#!/usr/bin/env node
/**
 * PHASE 15 — TREASURY TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Behavioural tests of RPC 39 transfer_between_accounts over the Target V1
 * financial ledger (financial_operation 1:N financial_posting) and its
 * integration with the Phase 14 commercial slice.
 *
 * Role-scoped calls simulate real Supabase sessions (SET LOCAL ROLE +
 * request.jwt.claims). The concurrency group runs two genuinely independent
 * PostgreSQL sessions in parallel (two psql processes) and observes the lock
 * wait in pg_stat_activity; it is not a sequential simulation.
 *
 * Fixtures are synthetic, prefixed "P15-TEST", and include dedicated test
 * financial accounts so balances start from zero. They are removed at start and
 * end; periods the suite closes are reopened.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/treasury.test.mjs
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
const TAG = 'P15-TEST';
const RPC = 'transfer_between_accounts';
// Exact inventory: Foundation 2 + Commercial 4 + Treasury 1 + built later phases (Phase 16: RPCs 5–12 + 42; Phase 17: RPCs 13–17; Phase 18: RPCs 18–22; Phase 19: RPC 25).
const ALL_DEFINERS = 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,close_feria_summary,close_flock,close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_apply_transition,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_report_fallback,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,open_sales_session,pay_fiscal_obligation,pay_supplier,publish_feed_formula_version,receive_cheque,'
  + 'rectify_classification,rectify_daily_production,rectify_delivered_order,rectify_feed_manufacturing,rectify_feria_closing,rectify_mortality,rectify_purchase,register_bank_tax,register_classification,register_collection,'
  + 'register_count_adjustment,register_daily_production,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,register_fiscal_document,register_fiscal_obligation,register_flock,register_freight,register_management_event,register_mortality,register_purchase,register_purchase_with_fiscal_document,register_session_cash_event,register_session_movement,reject_cheque,'
  + 'reject_supplier_instrument,transfer_between_accounts';
// Tables created by phases built after Treasury (Phase 16 Instruments, Phase 17 Purchases).
const LATER_PHASE_TABLES = ['financial_instrument', 'financial_instrument_event', 'supplier_ledger',   // Phase 16
  'freight', 'freight_allocation', 'purchase_attachment', 'purchase_line', 'purchases',            // Phase 17
  'daily_production', 'population_events',                                                           // Phase 18
  'classification', 'classification_line',                                                           // Phase 19
  'feed_formula_line', 'feed_formula_version', 'feed_inventory_count', 'feed_manufacturing', 'feed_movement', 'flock_feed_assignment', // Phase 20
  'sales_session', 'sales_session_cash_event', 'sales_session_movement',                           // Phase 21
  'fiscal_document', 'fiscal_document_component', 'fiscal_obligation', 'fiscal_obligation_installment', 'fiscal_payment', // Phase 22
  'mp_financial_movement', 'mp_reconciliation', 'mp_source_record',                               // Phase 23
  'management_event',                                                                               // Phase 24
  'mp_attribution_flag', 'mp_client_allocation', 'mp_payer_client_map', 'mp_report_match', 'mp_transition_identity', 'mp_webhook_delivery',  // ADR-006 (0047)
  'bank_tax_charge',                                                                                // ADR-011 (0062)
  'sales_session_closing'];                                                                         // ADR-016 (0070)

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
const asUser = (uid, sqlText) => asRole('authenticated', { sub: uid, role: 'authenticated' }, sqlText);
const ADMIN = (sqlText) => asUser(ADMIN_UID, sqlText);
const OPER = (sqlText) => asUser(OPER_UID, sqlText);
const asAnon = (sqlText) => asRole('anon', { role: 'anon' }, sqlText);
const asServiceRole = (sqlText) => asRole('service_role', { role: 'service_role' }, sqlText);

/** An independent PostgreSQL session (its own psql process), run asynchronously. */
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

function adminOk(sqlText) {
  const r = ADMIN(sqlText);
  if (!r.ok) throw new Error(`ADMIN SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const rpc = (call) => JSON.parse(adminOk(`SELECT ${call};`));
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 140);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
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

// Business "today" in Buenos Aires: the month that NOW()/created_at falls into.
const CURRENT_MONTH = owner(`SELECT date_trunc('month', (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::DATE;`);

// ── fixture lifecycle ──────────────────────────────────────────────────────
const TEST_ACCOUNTS = `(SELECT id FROM financial_account WHERE nombre LIKE '${TAG}%')`;
const TEST_CLIENTS = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
const TEST_OPS = `(SELECT id FROM financial_operation WHERE external_ref LIKE '${TAG}%'
   UNION SELECT financial_operation_id FROM financial_posting WHERE financial_account_id IN ${TEST_ACCOUNTS})`;
function cleanup() {
  owner(`
DROP SCHEMA IF EXISTS p15_harness CASCADE;
DELETE FROM audit_events WHERE entity_type = 'financial_operation' AND entity_id IN (SELECT id::TEXT FROM ${TEST_OPS} o);
DELETE FROM audit_events WHERE entity_type = 'pedido'
   AND entity_id IN (SELECT id::TEXT FROM pedidos WHERE cliente_id IN ${TEST_CLIENTS});
DELETE FROM audit_events WHERE entity_type = 'collections'
   AND entity_id IN (SELECT id::TEXT FROM collections WHERE cliente_id IN ${TEST_CLIENTS});
CREATE TEMP TABLE _p15_ops AS SELECT id FROM ${TEST_OPS} o;
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _p15_ops);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _p15_ops);
DELETE FROM collections WHERE cliente_id IN ${TEST_CLIENTS};
DELETE FROM client_ledger WHERE reversal_of_id IS NOT NULL AND cliente_id IN ${TEST_CLIENTS};
DELETE FROM client_ledger WHERE cliente_id IN ${TEST_CLIENTS};
DELETE FROM pedido_lineas WHERE pedido_id IN (SELECT id FROM pedidos WHERE cliente_id IN ${TEST_CLIENTS});
DELETE FROM pedidos WHERE cliente_id IN ${TEST_CLIENTS};
DELETE FROM price_history WHERE producto_id IN (SELECT id FROM products WHERE nombre LIKE '${TAG}%');
DELETE FROM products WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
DELETE FROM financial_account WHERE nombre LIKE '${TAG}%';
UPDATE management_period SET status = 'OPEN', closed_at = NULL
 WHERE periodo_fecha IN ('2026-03-01', '${CURRENT_MONTH}');`);
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

// ── helpers over the allowed paths ─────────────────────────────────────────
const mkAccount = (name, type, activo = true) =>
  adminOk(`INSERT INTO financial_account (nombre, account_type, activo)
           VALUES ('${TAG} ${name}', '${type}', ${activo}) RETURNING id;`);
const mkClient = (name) => adminOk(`INSERT INTO clients (nombre) VALUES ('${TAG} ${name}') RETURNING id;`);

/** Sale of `total` to a new client, delivered, returns { client, order }. */
function sale(name, total, deliveredAt) {
  const client = mkClient(name);
  const prod = adminOk(`INSERT INTO products (nombre, product_type) VALUES ('${TAG} Prod ${name}', 'VENDIBLE') RETURNING id;`);
  adminOk(`INSERT INTO price_history (producto_id, price_list_type, precio, effective_from)
           VALUES ('${prod}', 'MAYORISTA', 1000, '2026-01-01');`);
  const order = adminOk(`INSERT INTO pedidos (cliente_id) VALUES ('${client}') RETURNING id;`);
  adminOk(`INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre)
           SELECT '${order}', p.id, ${total / 1000}, 1000, p.nombre FROM products p WHERE p.id = '${prod}';`);
  rpc(`deliver_order('${order}', '${deliveredAt}'::timestamptz)`);
  return { client, order };
}
const collect = (client, amount, method, receipt, date, account) =>
  rpc(`register_collection('${client}', ${amount}, '${method}', '${receipt}', '${date}', '${account}')`);

const tr = (src, dst, amount, date, ref, reason = null) =>
  `${RPC}(${src === null ? 'NULL' : `'${src}'`}, ${dst === null ? 'NULL' : `'${dst}'`}, ${amount === null ? 'NULL' : amount}, '${date}', ${ref === null ? 'NULL' : `'${ref}'`}, ${reason === null ? 'NULL' : `'${reason}'`})`;

const balance = (a) =>
  owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM financial_posting WHERE financial_account_id = '${a}';`);
const clientBalance = (c) =>
  owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM client_ledger WHERE cliente_id = '${c}';`);
const totalMoney = () => owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM financial_posting;`);
const opsWithRef = (ref) => owner(`SELECT count(*) FROM financial_operation WHERE external_ref = '${ref}';`);

const snapshot = () => owner(`
SELECT concat_ws('|',
  (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT COALESCE(SUM(signed_amount), 0) FROM financial_posting),
  (SELECT count(*) FROM client_ledger), (SELECT count(*) FROM collections),
  (SELECT count(*) FROM pedidos), (SELECT count(*) FROM audit_events));`);

const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);

const ADMIN_CLAIMS = { sub: ADMIN_UID, role: 'authenticated' };

try {
// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure / contract');

const sig = owner(`SELECT pg_get_function_identity_arguments(oid) || ' -> ' || pg_get_function_result(oid)
  FROM pg_proc WHERE proname = '${RPC}' AND pronamespace = 'public'::regnamespace;`);
check('A1 RPC 39 exists with the exact frozen signature',
  sig === 'p_source_account_id uuid, p_dest_account_id uuid, p_amount numeric, p_effective_date date, p_external_ref character varying, p_reason text -> jsonb', sig);
const tcount = owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';`);
const reused = owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
  AND table_name IN ('financial_account','financial_operation','financial_posting');`);
check(`A2 Treasury reuses financial_account / financial_operation / financial_posting; added no table (public = 23 + ${LATER_PHASE_TABLES.length} later-phase)`,
  reused === '3' && tcount === String(23 + LATER_PHASE_TABLES.length), `${reused}/${tcount}`);
const cons = owner(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint
  WHERE conrelid IN ('financial_operation'::regclass, 'financial_posting'::regclass);`);
check('A3 constraints: posting signed_amount <> 0, posting → operation FK, posting → account FK, UNIQUE external_ref, PKs',
  cons === 'financial_operation_created_by_fkey,financial_operation_external_ref_key,financial_operation_pkey,'
  + 'financial_posting_created_by_fkey,financial_posting_financial_account_id_fkey,financial_posting_financial_operation_id_fkey,'
  + 'financial_posting_pkey,financial_posting_signed_amount_check', cons);
const notNull = owner(`SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns
  WHERE table_name = 'financial_posting' AND is_nullable = 'NO';`);
check('A4 posting always has an operation, an account, an amount and a date (NOT NULL)',
  notNull === 'created_at,effective_date,financial_account_id,financial_operation_id,id,signed_amount', notNull);
const hasTransfer = owner(`SELECT 'TRANSFER' = ANY(enum_range(NULL::financial_operation_type)::TEXT[]);`);
check('A5 financial_operation_type includes TRANSFER', hasTransfer === 't');
const idx = owner(`SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes
  WHERE tablename IN ('financial_operation','financial_posting') AND indexname LIKE 'idx_%';`);
check('A6 indexes: operation date, posting (account, date), posting operation',
  idx === 'idx_financial_operation_date,idx_financial_posting_account_date,idx_financial_posting_operation', idx);
const rls = owner(`SELECT count(*) FROM pg_class WHERE relname IN ('financial_account','financial_operation','financial_posting')
  AND relnamespace = 'public'::regnamespace AND relrowsecurity;`);
check('A7 RLS enabled on all three Treasury tables', rls === '3', rls);
const accCols = owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
  WHERE table_name = 'financial_account';`);
check('A8 financial_account has no balance column (id, nombre, account_type, activo, created_at)',
  accCols === 'id,nombre,account_type,activo,created_at', accCols);
// Frozen tables whose names match the pattern but are not a parallel money ledger:
//   feed_movement (Phase 20, Domain I): physical feed outflows / adjustments;
//   sales_session_movement, sales_session_cash_event (Phase 21, Domain J): physical movements and
//   session cash events, whose money effect is posted through financial_operation / financial_posting;
//   mp_financial_movement (Phase 23, Domain L): normalized external MP movement, reconciled into postings, not a ledger.
//   bank_tax_charge / report_bank_tax_period (ADR-011): tax detail of a BANK_TAX operation, posted through financial_posting.
const parallel = owner(`SELECT coalesce(string_agg(table_name, ','), '') FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name ~* '(movement|movimiento|cash|caja|bank|banco|treasury|tesoreria|transfer|balance|saldo|journal|asiento)'
    AND table_name NOT IN ('feed_movement', 'sales_session_movement', 'sales_session_cash_event', 'mp_financial_movement', 'bank_tax_charge', 'report_bank_tax_period', ${ADR005_VIEWS});`);
check('A9 no parallel money ledger / cash / bank / transfer / balance table', parallel === '', parallel);

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Transfer success');

const CAJA = mkAccount('Caja', 'CASH');
const BANCO = mkAccount('Banco', 'BANK_ACCOUNT');
const MP = mkAccount('MP', 'EXTERNAL_SERVICE');
const INACT = mkAccount('Inactiva', 'BANK_ACCOUNT', false);
const fund = sale('Fondeo', 150000, '2026-04-01 10:00:00-03');
collect(fund.client, 100000, 'CASH', `${TAG}-FUND-CAJA`, '2026-04-01', CAJA);
collect(fund.client, 50000, 'TRANSFER', `${TAG}-FUND-BANCO`, '2026-04-01', BANCO);
check('B1 fixtures: two test accounts funded by real collections (Caja 100000.00, Banco 50000.00)',
  balance(CAJA) === '100000.00' && balance(BANCO) === '50000.00', `${balance(CAJA)} / ${balance(BANCO)}`);

const ledgerBefore = owner(`SELECT count(*) FROM client_ledger;`);
const money0 = totalMoney();
const collectionsBefore = owner(`SELECT count(*) FROM collections;`);
const t1 = rpc(tr(CAJA, BANCO, 30000, '2026-04-10', `${TAG}-T1`, 'mover a banco'));
check('B2 valid transfer returns {financial_operation_id, posting_ids[2]}',
  Number.isInteger(t1.financial_operation_id) && Array.isArray(t1.posting_ids) && t1.posting_ids.length === 2, JSON.stringify(t1));
const op1 = owner(`SELECT operation_type || '|' || effective_date || '|' || external_ref || '|' || reason || '|' || created_by
  || '|' || coalesce(source_entity_type, '-') FROM financial_operation WHERE external_ref = '${TAG}-T1';`);
check('B3 exactly ONE financial_operation: TRANSFER, effective date, external_ref, reason, actor',
  opsWithRef(`${TAG}-T1`) === '1' && op1 === `TRANSFER|2026-04-10|${TAG}-T1|mover a banco|${ADMIN_UID}|-`, op1);
const posts1 = owner(`SELECT string_agg(id || ':' || financial_account_id || ':' || signed_amount || ':' || effective_date, ',' ORDER BY id)
  FROM financial_posting WHERE financial_operation_id = ${t1.financial_operation_id};`).split(',');
check('B4 exactly TWO financial_posting on that operation', posts1.length === 2, posts1.join(','));
check('B5 source posting = -30000.00 on Caja (first posting id)', posts1[0] === `${t1.posting_ids[0]}:${CAJA}:-30000.00:2026-04-10`, posts1[0]);
check('B6 destination posting = +30000.00 on Banco (second posting id)', posts1[1] === `${t1.posting_ids[1]}:${BANCO}:30000.00:2026-04-10`, posts1[1]);
check('B7 postings of this transfer sum to 0',
  owner(`SELECT SUM(signed_amount) FROM financial_posting WHERE financial_operation_id = ${t1.financial_operation_id};`) === '0.00');
check('B8 source balance decreases by 30000 (100000 → 70000.00)', balance(CAJA) === '70000.00', balance(CAJA));
check('B9 destination balance increases by 30000 (50000 → 80000.00)', balance(BANCO) === '80000.00', balance(BANCO));
check('B10 client_ledger unchanged', owner(`SELECT count(*) FROM client_ledger;`) === ledgerBefore);
const body = owner(`SELECT prosrc FROM pg_proc WHERE proname = '${RPC}';`);
const supplierRows = owner(`SELECT count(*) FROM supplier_ledger WHERE source_entity_id IN
  (SELECT id::TEXT FROM financial_operation WHERE external_ref = '${TAG}-T1');`);
check('B11 no client or supplier ledger intervenes (the RPC writes neither; no supplier_ledger row references the transfer)',
  !/client_ledger|supplier_ledger/.test(body) && supplierRows === '0');
check('B12 no result created: total money across all accounts unchanged, collections unchanged, operation_type TRANSFER',
  totalMoney() === money0 && owner(`SELECT count(*) FROM collections;`) === collectionsBefore
  && owner(`SELECT count(*) FROM financial_operation WHERE external_ref = '${TAG}-T1' AND operation_type = 'TRANSFER';`) === '1',
  `${money0} → ${totalMoney()}`);

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Validation');

let snap = snapshot();
const cases = [
  [tr(CAJA, BANCO, 0, '2026-04-11', `${TAG}-C1`), 'INVALID_AMOUNT', 'amount = 0'],
  [tr(CAJA, BANCO, -500, '2026-04-11', `${TAG}-C2`), 'INVALID_AMOUNT', 'negative amount'],
  [tr(CAJA, BANCO, null, '2026-04-11', `${TAG}-C3`), 'INVALID_AMOUNT', 'NULL amount'],
  [tr(CAJA, CAJA, 100, '2026-04-11', `${TAG}-C4`), 'SAME_ACCOUNT', 'source = destination'],
  [tr(MISSING_UUID, BANCO, 100, '2026-04-11', `${TAG}-C5`), 'SOURCE_ACCOUNT_NOT_FOUND_OR_INACTIVE', 'missing source'],
  [tr(null, BANCO, 100, '2026-04-11', `${TAG}-C6`), 'SOURCE_ACCOUNT_NOT_FOUND_OR_INACTIVE', 'NULL source'],
  [tr(CAJA, MISSING_UUID, 100, '2026-04-11', `${TAG}-C7`), 'DEST_ACCOUNT_NOT_FOUND_OR_INACTIVE', 'missing destination'],
  [tr(INACT, BANCO, 100, '2026-04-11', `${TAG}-C8`), 'SOURCE_ACCOUNT_NOT_FOUND_OR_INACTIVE', 'inactive source'],
  [tr(CAJA, INACT, 100, '2026-04-11', `${TAG}-C9`), 'DEST_ACCOUNT_NOT_FOUND_OR_INACTIVE', 'inactive destination'],
];
for (const [call, code, what] of cases) {
  const r = ADMIN(`SELECT ${call};`);
  check(`C ${what} → ${code}`, raised(r, code), firstErr(r));
}
let r = OPER(`SELECT ${tr(CAJA, BANCO, 100, '2026-04-11', `${TAG}-C10`)};`);
check('C OPERATOR → FORBIDDEN', raised(r, 'FORBIDDEN'), firstErr(r));
r = asUser(INACTIVE_UID, `SELECT ${tr(CAJA, BANCO, 100, '2026-04-11', `${TAG}-C11`)};`);
check('C inactive profile → USER_NOT_FOUND_OR_INACTIVE', raised(r, 'USER_NOT_FOUND_OR_INACTIVE'), firstErr(r));
r = asUser(NOPROFILE_UID, `SELECT ${tr(CAJA, BANCO, 100, '2026-04-11', `${TAG}-C12`)};`);
check('C missing profile → USER_NOT_FOUND_OR_INACTIVE', raised(r, 'USER_NOT_FOUND_OR_INACTIVE'), firstErr(r));
check('C every rejected input left no operation, posting, ledger or audit row', snapshot() === snap);

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Period');

closePeriod('2026-03-01');
snap = snapshot();
const cajaBeforeClosed = balance(CAJA);
const bancoBeforeClosed = balance(BANCO);
r = ADMIN(`SELECT ${tr(CAJA, BANCO, 1000, '2026-03-20', `${TAG}-D1`)};`);
check('D1 effective date in CLOSED 2026-03 → PERIOD_CLOSED', raised(r, 'PERIOD_CLOSED'), firstErr(r));
check('D2 CLOSED left no financial_operation', opsWithRef(`${TAG}-D1`) === '0');
check('D3 CLOSED left no source posting and no destination posting (balances intact)',
  balance(CAJA) === cajaBeforeClosed && balance(BANCO) === bancoBeforeClosed);
check('D4 CLOSED left no partial audit (global fingerprint identical)', snapshot() === snap);
r = ADMIN(`SELECT ${tr(CAJA, BANCO, 1000, '2027-01-10', `${TAG}-D2`)};`);
check('D5 date without a management_period → PERIOD_NOT_FOUND', raised(r, 'PERIOD_NOT_FOUND'), firstErr(r));

closePeriod(CURRENT_MONTH);
const tD = rpc(tr(CAJA, BANCO, 1000, '2026-04-15', `${TAG}-D3`));
const dRow = owner(`SELECT effective_date || '|' || date_trunc('month', created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
  FROM financial_operation WHERE id = ${tD.financial_operation_id};`);
check(`D6 created_at does not decide: created in CLOSED ${CURRENT_MONTH}, effective 2026-04-15 (OPEN) → accepted`,
  dRow === `2026-04-15|${CURRENT_MONTH}`, dRow);
const postDates = owner(`SELECT string_agg(DISTINCT effective_date::TEXT, ',') FROM financial_posting WHERE financial_operation_id = ${tD.financial_operation_id};`);
check('D7 the effective date is the period determinant of both postings', postDates === '2026-04-15', postDates);
openPeriod(CURRENT_MONTH);
const tFuture = rpc(tr(CAJA, BANCO, 10, '2026-12-15', `${TAG}-D4`));
check('D8 no blanket future-date restriction: an OPEN future month is accepted (contract defines none)',
  Number.isInteger(tFuture.financial_operation_id), JSON.stringify(tFuture));
check('D9 OPEN works (B2, D6, D8)', Number.isInteger(t1.financial_operation_id) && Number.isInteger(tD.financial_operation_id));

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Atomicity');

// A failure AFTER the operation and the source posting were written: a test-only
// trigger rejects the destination posting of one specific transfer.
owner(`
CREATE SCHEMA p15_harness;
CREATE FUNCTION p15_harness.fail_dest_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signed_amount > 0 AND EXISTS (
       SELECT 1 FROM public.financial_operation
        WHERE id = NEW.financial_operation_id AND external_ref = '${TAG}-FAIL-DEST') THEN
    RAISE EXCEPTION 'HARNESS_DEST_POSTING_FAILURE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p15_fail_dest BEFORE INSERT ON public.financial_posting
  FOR EACH ROW EXECUTE FUNCTION p15_harness.fail_dest_posting();`);
snap = snapshot();
try {
  r = ADMIN(`SELECT ${tr(CAJA, BANCO, 777, '2026-04-16', `${TAG}-FAIL-DEST`)};`);
} finally {
  owner(`DROP TRIGGER p15_fail_dest ON public.financial_posting; DROP SCHEMA p15_harness CASCADE;`);
}
check('E1 failure injected at the destination posting (operation and source posting already written)',
  raised(r, 'HARNESS_DEST_POSTING_FAILURE'), firstErr(r));
check('E2 complete rollback: no operation, no source posting, no audit, balances intact',
  snapshot() === snap && opsWithRef(`${TAG}-FAIL-DEST`) === '0');

snap = snapshot();
r = ADMIN(`SELECT ${tr(CAJA, BANCO, 0.004, '2026-04-16', `${TAG}-FAIL-SRC`)};`);
check('E3 amount 0.004 passes > 0, the operation is written, then the source posting rounds to 0.00 and violates its CHECK',
  !r.ok && /financial_posting_signed_amount_check/.test(r.err), firstErr(r));
check('E4 complete rollback: no orphaned financial_operation', snapshot() === snap && opsWithRef(`${TAG}-FAIL-SRC`) === '0');

const shape = () => owner(`
SELECT count(*) FROM (
  SELECT o.id FROM financial_operation o LEFT JOIN financial_posting p ON p.financial_operation_id = o.id
   WHERE o.operation_type = 'TRANSFER'
   GROUP BY o.id, o.effective_date
  HAVING count(p.id) <> 2 OR COALESCE(SUM(p.signed_amount), 1) <> 0
      OR count(*) FILTER (WHERE p.signed_amount < 0) <> 1 OR count(*) FILTER (WHERE p.signed_amount > 0) <> 1
      OR count(DISTINCT p.financial_account_id) <> 2 OR bool_or(p.effective_date <> o.effective_date)) bad;`);
check('E5 no transfer exists with one posting, same-sign postings, one account, or a date differing from its operation', shape() === '0', shape());
const orphans = owner(`SELECT count(*) FROM financial_operation o
  WHERE o.operation_type = 'TRANSFER' AND NOT EXISTS (SELECT 1 FROM financial_posting p WHERE p.financial_operation_id = o.id);`);
check('E6 no orphaned TRANSFER operation (no operation without postings)', orphans === '0', orphans);

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Idempotency (external_ref UNIQUE)');

snap = snapshot();
r = ADMIN(`SELECT ${tr(CAJA, BANCO, 30000, '2026-04-10', `${TAG}-T1`, 'replay')};`);
check('F1 replay with the same external_ref → DUPLICATE_TRANSFER (rejection, not replay)', raised(r, 'DUPLICATE_TRANSFER'), firstErr(r));
r = ADMIN(`SELECT ${tr(BANCO, CAJA, 5, '2026-04-12', `${TAG}-T1`)};`);
check('F2 same external_ref with different accounts/amount → DUPLICATE_TRANSFER', raised(r, 'DUPLICATE_TRANSFER'), firstErr(r));
check('F3 money not duplicated: still 1 operation, 2 postings, balances intact',
  snapshot() === snap && opsWithRef(`${TAG}-T1`) === '1'
  && owner(`SELECT count(*) FROM financial_posting WHERE financial_operation_id = ${t1.financial_operation_id};`) === '2');
r = ADMIN(`SELECT ${tr(CAJA, BANCO, 5, '2026-04-12', `${TAG}-FUND-CAJA`)};`);
check('F4 external_ref is unique across all operations: a collection receipt cannot be reused → DUPLICATE_TRANSFER',
  raised(r, 'DUPLICATE_TRANSFER') && snapshot() === snap, firstErr(r));
const nullA = rpc(tr(CAJA, BANCO, 1, '2026-04-12', null));
const nullB = rpc(tr(CAJA, BANCO, 1, '2026-04-12', null));
check('F5 contract as written: a NULL external_ref is not deduplicated (UNIQUE ignores NULL) — two operations',
  nullA.financial_operation_id !== nullB.financial_operation_id, `${nullA.financial_operation_id}/${nullB.financial_operation_id}`);

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'Security');

check('G1 ADMIN executes the RPC (B2)', Number.isInteger(t1.financial_operation_id));
const g = [
  ['G2 ADMIN cannot INSERT financial_operation directly',
    ADMIN(`INSERT INTO financial_operation (operation_type, effective_date) VALUES ('TRANSFER', '2026-04-10');`)],
  ['G3 ADMIN cannot INSERT financial_posting directly',
    ADMIN(`INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
           VALUES (${t1.financial_operation_id}, '${CAJA}', 1000000, '2026-04-10');`)],
  ['G4 ADMIN cannot UPDATE postings', ADMIN(`UPDATE financial_posting SET signed_amount = 1 WHERE id = ${t1.posting_ids[0]};`)],
  ['G5 ADMIN cannot DELETE postings', ADMIN(`DELETE FROM financial_posting WHERE id = ${t1.posting_ids[0]};`)],
  ['G6 ADMIN cannot UPDATE / DELETE operations', ADMIN(`UPDATE financial_operation SET effective_date = '2026-04-01' WHERE id = ${t1.financial_operation_id};`)],
  ['G7 ADMIN cannot TRUNCATE financial_posting', ADMIN(`TRUNCATE financial_posting;`)],
  ['G8 ADMIN cannot TRUNCATE financial_operation', ADMIN(`TRUNCATE financial_operation CASCADE;`)],
];
for (const [label, res] of g) check(label, denied(res), firstErr(res));
for (const t of ['financial_account', 'financial_operation', 'financial_posting']) {
  r = OPER(`SELECT count(*) FROM ${t};`);
  check(`G9 OPERATOR reads 0 rows of ${t}`, r.ok && r.out === '0', r.out || firstErr(r));
}
r = asAnon(`SELECT ${tr(CAJA, BANCO, 1, '2026-04-12', `${TAG}-G1`)};`);
const anonSel = asAnon(`SELECT count(*) FROM financial_posting;`);
check('G10 anon: no EXECUTE on the RPC, no SELECT on postings', denied(r) && denied(anonSel), `${firstErr(r)} / ${firstErr(anonSel)}`);
const srExec = asServiceRole(`SELECT ${tr(CAJA, BANCO, 1, '2026-04-12', `${TAG}-G2`)};`);
const srOp = asServiceRole(`SELECT count(*) FROM financial_operation;`);
const srPost = asServiceRole(`INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
                              VALUES (${t1.financial_operation_id}, '${CAJA}', 1, '2026-04-10');`);
const srAcc = asServiceRole(`SELECT count(*) > 0 FROM financial_account;`);
check('G11 service_role: no EXECUTE on RPC 39, no access to operations/postings; keeps only the frozen financial_account SELECT',
  denied(srExec) && denied(srOp) && denied(srPost) && srAcc.ok && srAcc.out === 't',
  `${firstErr(srExec)} / ${firstErr(srOp)} / ${firstErr(srPost)} / ${srAcc.out || firstErr(srAcc)}`);
const acl = owner(`SELECT string_agg(relname || '=' || relacl::TEXT, ' ' ORDER BY relname) FROM pg_class
  WHERE relname IN ('financial_operation','financial_posting','financial_operation_id_seq','financial_posting_id_seq');`);
check('G12 exact ACLs: authenticated SELECT only on operations/postings; sequences owner-only',
  acl === 'financial_operation={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'financial_operation_id_seq={postgres=rwU/postgres} '
  + 'financial_posting={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'financial_posting_id_seq={postgres=rwU/postgres}', acl);
const defAcl = owner(`SELECT count(*) FROM pg_default_acl d, aclexplode(d.defaclacl) a
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype IN ('r','S')
    AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole);`);
check('G13 new tables would not inherit broad Supabase privileges (default ACL clean since 0013)', defAcl === '0', defAcl);

// ═══════════════════════════════════════════════════════════════════════════
section('H', 'SECURITY DEFINER');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc
  WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
check('H1 SECURITY DEFINER inventory = Foundation 2 + Commercial 4 + transfer_between_accounts', definers === ALL_DEFINERS, definers);
const h = owner(`SELECT prosecdef || '|' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || '|' ||
  pg_get_userbyid(proowner) || '|' ||
  (SELECT count(*) FROM aclexplode(proacl) a WHERE a.grantee = 0) || '|' || (proacl IS NULL) || '|' ||
  has_function_privilege('anon', oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', oid, 'EXECUTE') || '|' ||
  has_function_privilege('service_role', oid, 'EXECUTE')
  FROM pg_proc WHERE proname = '${RPC}';`).split('|');
check('H2 SECURITY DEFINER with search_path = public, owner postgres', h[0] === 'true' && h[1] === 'true' && h[2] === 'postgres', h.join('|'));
check('H3 PUBLIC has no EXECUTE (explicit ACL, no PUBLIC entry)', h[3] === '0' && h[4] === 'false', h.join('|'));
check('H4 anon has no EXECUTE', h[5] === 'false', h.join('|'));
check('H5 EXECUTE: authenticated yes, service_role no (spec: service_role only for MP RPCs 40/41)',
  h[6] === 'true' && h[7] === 'false', h.join('|'));
const args = owner(`SELECT array_to_string(proargnames, ',') FROM pg_proc WHERE proname = '${RPC}';`);
check('H6 no parameter can name the actor or the role (actor = auth.uid(), role = current_app_role())',
  !/(user|actor|role|performed|created_by|uid)/i.test(args), args);

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'Commercial integration');

const s = sale('Integracion', 40000, '2026-05-05 10:00:00-03');
check('I0 delivery created debt 40000.00 and no posting', clientBalance(s.client) === '40000.00'
  && owner(`SELECT count(*) FROM financial_posting fp JOIN financial_operation fo ON fo.id = fp.financial_operation_id
            WHERE fo.source_entity_id = '${s.order}';`) === '0');
const cajaI0 = balance(CAJA);
const col = collect(s.client, 40000, 'TRANSFER', `${TAG}-INT-COL`, '2026-05-06', CAJA);
check('I1 register_collection still works (payment_method TRANSFER = a client payment, not an internal transfer)',
  !!col.collection_id && owner(`SELECT operation_type || '|' || source_entity_type FROM financial_operation
                                 WHERE id = ${col.financial_operation_id};`) === 'COLLECTION|collections');
check('I2 the collection creates one positive posting (+40000.00 on Caja)', balance(CAJA) === (Number(cajaI0) + 40000).toFixed(2)
  && owner(`SELECT count(*) || '|' || SUM(signed_amount) FROM financial_posting WHERE financial_operation_id = ${col.financial_operation_id};`) === '1|40000.00');
const debtBefore = clientBalance(s.client);
const pairBefore = (Number(balance(CAJA)) + Number(balance(BANCO))).toFixed(2);
const cajaI1 = balance(CAJA);
const bancoI1 = balance(BANCO);
rpc(tr(CAJA, BANCO, 25000, '2026-05-07', `${TAG}-INT-TR`, 'depósito del cobro'));
check('I3 a later transfer moves that money: Caja -25000, Banco +25000',
  balance(CAJA) === (Number(cajaI1) - 25000).toFixed(2) && balance(BANCO) === (Number(bancoI1) + 25000).toFixed(2));
check('I4 client debt unchanged by the transfer (0.00 before and after)', debtBefore === '0.00' && clientBalance(s.client) === '0.00');
check('I5 Caja + Banco total constant across the internal transfer',
  (Number(balance(CAJA)) + Number(balance(BANCO))).toFixed(2) === pairBefore, pairBefore);
check('I6 the transfer operation has no client_ledger and no source entity (distinct fact from the collection)',
  owner(`SELECT coalesce(source_entity_type, '-') FROM financial_operation WHERE external_ref = '${TAG}-INT-TR';`) === '-'
  && owner(`SELECT count(*) FROM client_ledger WHERE source_entity_id IN
            (SELECT id::TEXT FROM financial_operation WHERE external_ref = '${TAG}-INT-TR');`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('J', 'Multiple transfers / balance derivation');

const xminBefore = owner(`SELECT string_agg(xmin::TEXT, ',' ORDER BY nombre) FROM financial_account WHERE nombre LIKE '${TAG}%';`);
const b0 = { c: Number(balance(CAJA)), b: Number(balance(BANCO)), m: Number(balance(MP)) };
rpc(tr(CAJA, BANCO, 1000, '2026-05-10', `${TAG}-J1`));
rpc(tr(BANCO, MP, 2500, '2026-05-11', `${TAG}-J2`));
rpc(tr(MP, CAJA, 500, '2026-05-12', `${TAG}-J3`));
check('J1 successive transfers: each balance = SUM(postings) = start + net flows',
  balance(CAJA) === (b0.c - 1000 + 500).toFixed(2) && balance(BANCO) === (b0.b + 1000 - 2500).toFixed(2)
  && balance(MP) === (b0.m + 2500 - 500).toFixed(2), `${balance(CAJA)} ${balance(BANCO)} ${balance(MP)}`);
const cBeforeRev = Number(balance(CAJA));
rpc(tr(BANCO, CAJA, 1000, '2026-05-13', `${TAG}-J4`));
check('J2 reverse transfer (Banco → Caja) is a normal transfer', balance(CAJA) === (cBeforeRev + 1000).toFixed(2));
const mpNow = Number(balance(MP));
rpc(tr(MP, BANCO, mpNow + 5000, '2026-05-14', `${TAG}-J5`));
check('J3 a negative account balance is allowed (not prohibited by the frozen design): MP = -5000.00', balance(MP) === '-5000.00', balance(MP));
check('J4 no transfer updated any account row (financial_account xmin unchanged; no balance field)',
  owner(`SELECT string_agg(xmin::TEXT, ',' ORDER BY nombre) FROM financial_account WHERE nombre LIKE '${TAG}%';`) === xminBefore);
check('J5 every transfer still has the exact two-posting shape', shape() === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'Concurrency (independent PostgreSQL sessions)');

const refK = `${TAG}-K-SAME`;
const winnerSql = sessionSql('authenticated', ADMIN_CLAIMS,
  `SELECT ${tr(CAJA, BANCO, 100, '2026-05-20', refK)};\nSELECT pg_sleep(3);`);
const loserSql = sessionSql('authenticated', ADMIN_CLAIMS, `SELECT ${tr(CAJA, BANCO, 100, '2026-05-20', refK)};`);
const cajaK = balance(CAJA);
const pA = session(winnerSql, 'p15-A');
const aInside = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
  WHERE application_name = 'p15-A' AND state = 'active' AND query LIKE '%pg_sleep%');`);
const pB = session(loserSql, 'p15-B');
const bBlocked = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
  WHERE application_name = 'p15-B' AND wait_event_type = 'Lock');`);
const [ra, rb] = await Promise.all([pA, pB]);
check('K1 session A performed the transfer and held its transaction open', aInside && ra.ok, firstErr(ra));
check('K2 session B ran truly concurrently: observed waiting on a lock held by A', bBlocked);
check('K3 same external_ref, concurrent: B fails DUPLICATE_TRANSFER after A commits', raised(rb, 'DUPLICATE_TRANSFER'), firstErr(rb));
check('K4 exactly one operation, two postings, one debit of 100 on Caja',
  opsWithRef(refK) === '1'
  && owner(`SELECT count(*) FROM financial_posting WHERE financial_operation_id = (SELECT id FROM financial_operation WHERE external_ref = '${refK}');`) === '2'
  && balance(CAJA) === (Number(cajaK) - 100).toFixed(2));

const cajaK2 = balance(CAJA);
const pC = session(sessionSql('authenticated', ADMIN_CLAIMS,
  `SELECT ${tr(CAJA, BANCO, 200, '2026-05-21', `${TAG}-K-C`)};\nSELECT pg_sleep(2);`), 'p15-C');
await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'p15-C' AND query LIKE '%pg_sleep%' AND state = 'active');`);
const pD = session(sessionSql('authenticated', ADMIN_CLAIMS, `SELECT ${tr(CAJA, BANCO, 300, '2026-05-21', `${TAG}-K-D`)};`), 'p15-D');
const [rc, rd] = await Promise.all([pC, pD]);
check('K5 distinct refs concurrently: both commit and both debits are reflected (no lost update — no balance field)',
  rc.ok && rd.ok && balance(CAJA) === (Number(cajaK2) - 500).toFixed(2), `${firstErr(rc)} / ${firstErr(rd)} / ${balance(CAJA)}`);

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'Audit');

const aud = owner(`SELECT action || '|' || (after_values->>'source') || '|' || (after_values->>'dest') || '|'
  || (after_values->>'amount') || '|' || (after_values->>'effective_date') || '|' || reason || '|' || performed_by || '|' || (performed_at IS NOT NULL)
  FROM audit_events WHERE entity_type = 'financial_operation' AND entity_id = '${t1.financial_operation_id}';`);
check('L1 audit_events TRANSFER: source, dest, amount, effective_date, reason, actor, time',
  aud === `TRANSFER|${CAJA}|${BANCO}|30000|2026-04-10|mover a banco|${ADMIN_UID}|true`, aud);
const audCount = owner(`SELECT (SELECT count(*) FROM financial_operation WHERE operation_type = 'TRANSFER') = (SELECT count(*) FROM audit_events
  WHERE entity_type = 'financial_operation' AND action = 'TRANSFER'
    AND entity_id IN (SELECT id::TEXT FROM financial_operation WHERE operation_type = 'TRANSFER'));`);
check('L2 exactly one audit row per transfer; failed calls wrote none', audCount === 't');
const tamper = [ADMIN(`UPDATE audit_events SET reason = 'x';`), ADMIN(`DELETE FROM audit_events;`)];
check('L3 audit_events cannot be modified or deleted by the application', tamper.every(denied));
check('L4 no Treasury-specific audit table', owner(`SELECT count(*) FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name LIKE '%audit%' AND table_name <> 'audit_events';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('S', 'End-to-end scenario');

const E_CAJA = mkAccount('E2E Caja', 'CASH');
const E_BNA = mkAccount('E2E BNA', 'BANK_ACCOUNT');
const ef = sale('E2E Fondeo', 150000, '2026-06-01 09:00:00-03');
collect(ef.client, 100000, 'CASH', `${TAG}-E2E-F1`, '2026-06-01', E_CAJA);
collect(ef.client, 50000, 'TRANSFER', `${TAG}-E2E-F2`, '2026-06-01', E_BNA);
check('S1 initial state: Caja = 100000.00, BNA = 50000.00', balance(E_CAJA) === '100000.00' && balance(E_BNA) === '50000.00');
const ledgerS = owner(`SELECT count(*) || '|' || COALESCE(SUM(signed_amount), 0) FROM client_ledger;`);
const eT = rpc(tr(E_CAJA, E_BNA, 30000, '2026-06-05', `${TAG}-E2E-T`, 'Caja chica → BNA'));
check('S2 after transfer Caja → BNA 30000: Caja = 70000.00, BNA = 80000.00', balance(E_CAJA) === '70000.00' && balance(E_BNA) === '80000.00');
const eP = owner(`SELECT count(*) || '|' || string_agg(signed_amount::TEXT, ',' ORDER BY signed_amount) FROM financial_posting
  WHERE financial_operation_id = ${eT.financial_operation_id};`);
check('S3 1 financial_operation, 2 postings: -30000.00 / +30000.00', opsWithRef(`${TAG}-E2E-T`) === '1' && eP === '2|-30000.00,30000.00', eP);
check('S4 net worth change from the transfer = 0 (Caja + BNA = 150000.00 before and after)',
  (Number(balance(E_CAJA)) + Number(balance(E_BNA))).toFixed(2) === '150000.00');
check('S5 client ledger unchanged by the transfer', owner(`SELECT count(*) || '|' || COALESCE(SUM(signed_amount), 0) FROM client_ledger;`) === ledgerS);

const e = sale('E2E Cliente', 12000, '2026-06-10 11:00:00-03');
check('S6 pedido delivered: client owes 12000.00; accounts untouched',
  clientBalance(e.client) === '12000.00' && balance(E_CAJA) === '70000.00' && balance(E_BNA) === '80000.00');
collect(e.client, 12000, 'CASH', `${TAG}-E2E-COB`, '2026-06-11', E_CAJA);
check('S7 collection into Caja: money in (+12000 → 82000.00), debt 0.00', balance(E_CAJA) === '82000.00' && clientBalance(e.client) === '0.00');
rpc(tr(E_CAJA, E_BNA, 8000, '2026-06-12', `${TAG}-E2E-T2`, 'depósito'));
check('S8 transfer of part of that money only changes where it is: Caja 74000.00, BNA 88000.00, total 162000.00',
  balance(E_CAJA) === '74000.00' && balance(E_BNA) === '88000.00'
  && (Number(balance(E_CAJA)) + Number(balance(E_BNA))).toFixed(2) === '162000.00');
check('S9 the settled client debt stays 0.00 after the transfer', clientBalance(e.client) === '0.00');
} finally {
  cleanup();
}

section('Z', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM financial_account WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM clients WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM financial_operation WHERE external_ref LIKE '${TAG}%')
  + (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'p15_harness')
  + (SELECT count(*) FROM pg_trigger WHERE tgname = 'p15_fail_dest');`);
check('Z1 all P15-TEST fixtures, the harness schema and the harness trigger removed', left === '0', left);
const closedLeft = owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED'
  AND periodo_fecha IN ('2026-03-01', '${CURRENT_MONTH}');`);
check('Z2 periods closed by the suite are OPEN again', closedLeft === '0', closedLeft);

console.log(`\n  ══ TREASURY RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
