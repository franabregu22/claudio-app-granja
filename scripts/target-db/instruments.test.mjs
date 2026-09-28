#!/usr/bin/env node
/**
 * PHASE 16 — CHEQUES / eCHEQS (INSTRUMENTS) TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Behavioural tests of RPCs 5–12 and 42 (received and issued instrument lifecycles)
 * over financial_instrument / financial_instrument_event / supplier_ledger and
 * their consequences on client_ledger, supplier_ledger and the money ledger
 * (financial_operation / financial_posting).
 *
 * Role-scoped calls simulate real Supabase sessions. Failure injection uses
 * test-only triggers in schema p16_harness (dropped at the end). The
 * concurrency group runs genuinely independent PostgreSQL sessions (separate
 * psql processes) and observes the lock wait in pg_stat_activity.
 *
 * Supplier debt fixtures: no Phase 16 RPC creates supplier debt (purchases are
 * Phase 17), so an initial supplier debt is written by the table owner as an
 * OPENING_BALANCE row tagged as a test fixture. Everything the suite asserts on
 * is produced by the RPCs under test.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/instruments.test.mjs
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
const TAG = 'P16-TEST';
const RPCS = [
  'cancel_supplier_instrument', 'clear_cheque', 'deposit_cheque', 'endorse_cheque', 'issue_supplier_instrument',
  'mark_supplier_instrument_debited', 'receive_cheque', 'reject_cheque', 'reject_supplier_instrument',
];
const ALL_DEFINERS = 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,open_sales_session,pay_fiscal_obligation,pay_supplier,receive_cheque,'
  + 'rectify_daily_production,rectify_delivered_order,rectify_mortality,rectify_purchase,register_classification,register_collection,'
  + 'register_count_adjustment,register_daily_production,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,register_fiscal_document,register_fiscal_obligation,register_freight,register_management_event,register_mortality,register_purchase,register_session_cash_event,register_session_movement,reject_cheque,'
  + 'reject_supplier_instrument,transfer_between_accounts';
const NEW_TABLES = ['financial_instrument', 'financial_instrument_event', 'supplier_ledger'];

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

function adminOk(sqlText) {
  const r = ADMIN(sqlText);
  if (!r.ok) throw new Error(`ADMIN SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const rpc = (call) => JSON.parse(adminOk(`SELECT ${call};`));
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 150);
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

const CURRENT_MONTH = owner(`SELECT date_trunc('month', (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::DATE;`);
const CLOSED_BY_SUITE = ['2026-03-01', '2026-06-01', CURRENT_MONTH];

// ── fixture lifecycle ──────────────────────────────────────────────────────
const TC = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
const TS = `(SELECT id FROM suppliers WHERE nombre LIKE '${TAG}%')`;
const TA = `(SELECT id FROM financial_account WHERE nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
DROP SCHEMA IF EXISTS p16_harness CASCADE;
CREATE TEMP TABLE _i AS SELECT id FROM financial_instrument
  WHERE cliente_id IN ${TC} OR supplier_id IN ${TS} OR endorsed_to_supplier_id IN ${TS} OR bank_account_id IN ${TA};
CREATE TEMP TABLE _o AS
  SELECT id FROM financial_operation WHERE source_entity_type = 'financial_instrument'
     AND source_entity_id IN (SELECT id::TEXT FROM _i)
  UNION SELECT financial_operation_id FROM financial_posting WHERE financial_account_id IN ${TA}
  UNION SELECT id FROM financial_operation WHERE external_ref LIKE '${TAG}%';
DELETE FROM audit_events WHERE entity_type = 'financial_instrument' AND entity_id IN (SELECT id::TEXT FROM _i);
DELETE FROM audit_events WHERE entity_type = 'pedido'
   AND entity_id IN (SELECT id::TEXT FROM pedidos WHERE cliente_id IN ${TC});
DELETE FROM financial_instrument_event WHERE financial_instrument_id IN (SELECT id FROM _i);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _o);
DELETE FROM supplier_ledger WHERE reversal_of_id IS NOT NULL AND supplier_id IN ${TS};
DELETE FROM supplier_ledger WHERE supplier_id IN ${TS};
DELETE FROM financial_instrument WHERE id IN (SELECT id FROM _i);
DELETE FROM client_ledger WHERE reversal_of_id IS NOT NULL AND cliente_id IN ${TC};
DELETE FROM client_ledger WHERE cliente_id IN ${TC};
DELETE FROM pedido_lineas WHERE pedido_id IN (SELECT id FROM pedidos WHERE cliente_id IN ${TC});
DELETE FROM pedidos WHERE cliente_id IN ${TC};
DELETE FROM price_history WHERE producto_id IN (SELECT id FROM products WHERE nombre LIKE '${TAG}%');
DELETE FROM products WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
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

// ── fixture helpers (allowed paths) ────────────────────────────────────────
let seq = 0;
const uniq = (p) => `${TAG}-${p}-${++seq}`;
const mkAccount = (name, type = 'BANK_ACCOUNT', activo = true) =>
  adminOk(`INSERT INTO financial_account (nombre, account_type, activo) VALUES ('${TAG} ${name}', '${type}', ${activo}) RETURNING id;`);
const mkSupplier = (name, activo = true) =>
  adminOk(`INSERT INTO suppliers (nombre, activo) VALUES ('${TAG} ${name}', ${activo}) RETURNING id;`);
/** Test-only initial supplier debt (no Phase 16 RPC creates purchases). */
const supplierDebt = (s, amount, date = '2026-04-01') =>
  owner(`INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date, source_entity_type, reason)
         VALUES ('${s}', 'OPENING_BALANCE', ${amount}, '${date}', 'test_fixture', '${TAG} opening debt fixture');`);

/** A client who owes `total` through a real delivered sale (Phase 14 RPCs). */
function debtor(name, total, deliveredAt = '2026-04-02 10:00:00-03', activo = true) {
  const client = adminOk(`INSERT INTO clients (nombre) VALUES ('${TAG} ${name}') RETURNING id;`);
  if (total > 0) {
    const prod = adminOk(`INSERT INTO products (nombre, product_type) VALUES ('${TAG} Prod ${name}', 'VENDIBLE') RETURNING id;`);
    adminOk(`INSERT INTO price_history (producto_id, price_list_type, precio, effective_from) VALUES ('${prod}', 'MAYORISTA', 1000, '2026-01-01');`);
    const order = adminOk(`INSERT INTO pedidos (cliente_id) VALUES ('${client}') RETURNING id;`);
    adminOk(`INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre)
             SELECT '${order}', id, ${total / 1000}, 1000, nombre FROM products WHERE id = '${prod}';`);
    rpc(`deliver_order('${order}', '${deliveredAt}'::timestamptz)`);
  }
  if (!activo) adminOk(`UPDATE clients SET activo = false WHERE id = '${client}';`);
  return client;
}

const q = (v) => (v === null ? 'NULL' : `'${v}'`);
const receiveCall = (c, amount, receipt, at = '2026-04-10 10:00:00-03', type = 'CHEQUE', num = '00012345') =>
  `receive_cheque(${q(c)}, '${type}', '${num}', ${amount === null ? 'NULL' : amount}, '2026-12-31', '${at}'::timestamptz, ${q(receipt)}, 'recepción')`;
const depositCall = (i, d = '2026-04-12') => `deposit_cheque(${q(i)}, ${q(d)})`;
const clearCall = (i, acct, d = '2026-04-15') => `clear_cheque(${q(i)}, ${q(d)}, ${q(acct)})`;
const endorseCall = (i, s, d = '2026-04-14') => `endorse_cheque(${q(i)}, ${q(s)}, ${q(d)})`;
const rejectCall = (i, d = '2026-04-20', reason = 'rechazado por banco') => `reject_cheque(${q(i)}, ${q(d)}, ${q(reason)})`;
const issueCall = (s, amount, acct, ref, d = '2026-04-10', type = 'ECHEQ', num = '98765') =>
  `issue_supplier_instrument(${q(s)}, '${type}', '${num}', ${amount === null ? 'NULL' : amount}, '2026-12-31', ${q(d)}, ${q(acct)}, ${q(ref)}, 'emisión')`;
const debitCall = (i, d = '2026-04-15') => `mark_supplier_instrument_debited(${q(i)}, ${q(d)})`;
const rejectIssuedCall = (i, d = '2026-04-20', reason = 'rechazado') => `reject_supplier_instrument(${q(i)}, ${q(d)}, ${q(reason)})`;
const cancelCall = (i, d = '2026-04-19', reason = 'anulado antes de débito') => `cancel_supplier_instrument(${q(i)}, ${q(d)}, ${q(reason)})`;

const receive = (...a) => rpc(receiveCall(...a)).instrument_id;
const issue = (...a) => rpc(issueCall(...a)).instrument_id;

const clientBal = (c) => owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM client_ledger WHERE cliente_id = '${c}';`);
const supplierBal = (s) => owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM supplier_ledger WHERE supplier_id = '${s}';`);
const acctBal = (a) => owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM financial_posting WHERE financial_account_id = '${a}';`);
const totalMoney = () => owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM financial_posting;`);
const estado = (i) => owner(`SELECT estado FROM financial_instrument WHERE id = '${i}';`);
const events = (i) => owner(`SELECT coalesce(string_agg(event_type::TEXT, ',' ORDER BY id), '') FROM financial_instrument_event WHERE financial_instrument_id = '${i}';`);
const opsOf = (i) => owner(`SELECT coalesce(string_agg(operation_type || ':' || external_ref, ',' ORDER BY id), '') FROM financial_operation
  WHERE source_entity_type = 'financial_instrument' AND source_entity_id = '${i}';`);
const postingsOf = (i) => owner(`SELECT coalesce(string_agg(p.financial_account_id || ':' || p.signed_amount || ':' || p.effective_date, ',' ORDER BY p.id), '')
  FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id
  WHERE o.source_entity_type = 'financial_instrument' AND o.source_entity_id = '${i}';`);
const n = (x) => Number(x);
const f2 = (x) => Number(x).toFixed(2);

let r;
const snapshot = () => owner(`
SELECT concat_ws('|',
  (SELECT count(*) FROM financial_instrument),
  (SELECT string_agg(estado::TEXT, ',' ORDER BY id) FROM financial_instrument),
  (SELECT count(*) FROM financial_instrument_event), (SELECT count(*) FROM client_ledger),
  (SELECT count(*) FROM supplier_ledger), (SELECT count(*) FROM financial_operation),
  (SELECT count(*) FROM financial_posting), (SELECT COALESCE(SUM(signed_amount), 0) FROM financial_posting),
  (SELECT count(*) FROM audit_events));`);
const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);

try {
// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure');

const tables = owner(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN (${NEW_TABLES.map((t) => `'${t}'`).join(',')});`);
check('A1 financial_instrument, financial_instrument_event, supplier_ledger exist', tables === NEW_TABLES.join(','), tables);
const cols = owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'financial_instrument';`);
check('A2 financial_instrument columns are exactly the frozen set',
  cols === 'id,instrument_type,direction,estado,cheque_number,amount,maturity_date,cliente_id,supplier_id,bank_account_id,'
  + 'source_collection_id,endorsed_to_supplier_id,receipt_id,external_ref,received_date,deposited_date,cleared_date,'
  + 'endorsed_date,issued_date,debited_date,rejected_date,created_at,created_by,cancelled_date', cols);
const enums = owner(`SELECT string_agg(t.typname || '=' || (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), ' ' ORDER BY t.typname)
  FROM pg_type t WHERE t.typname IN ('financial_instrument_type','instrument_direction','instrument_estado');`);
check('A3 enums: type CHEQUE/ECHEQ, direction RECEIVED/ISSUED, estado (8 frozen values)',
  enums === 'financial_instrument_type=CHEQUE,ECHEQ instrument_direction=RECEIVED,ISSUED '
  + 'instrument_estado=RECEIVED,DEPOSITED,CLEARED,ENDORSED,ISSUED,DEBITED,REJECTED,CANCELLED', enums);
const checks = owner(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE contype = 'c'
  AND conrelid IN ('financial_instrument'::regclass, 'supplier_ledger'::regclass);`);
check('A4 CHECKs: amount > 0, received/issued provenance, estado↔direction, supplier signed_amount <> 0',
  checks === 'chk_instrument_cancelled_coherent,chk_instrument_estado_direction,chk_instrument_issued_provenance,chk_instrument_received_provenance,'
  + 'financial_instrument_amount_check,supplier_ledger_signed_amount_check', checks);
const uniques = owner(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE contype = 'u'
  AND conrelid IN ('financial_instrument'::regclass, 'financial_instrument_event'::regclass, 'supplier_ledger'::regclass);`);
check('A5 UNIQUE only on receipt_id and external_ref — cheque_number is NOT unique',
  uniques === 'financial_instrument_external_ref_key,financial_instrument_receipt_id_key', uniques);
const fks = owner(`SELECT string_agg(x, ',' ORDER BY x) FROM (
  SELECT c.conrelid::regclass || '.' || a.attname || '>' || c.confrelid::regclass || ':' || c.confdeltype::TEXT AS x
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.conrelid IN ('financial_instrument'::regclass, 'financial_instrument_event'::regclass, 'supplier_ledger'::regclass)) s;`);
check('A6 foreign keys exactly as frozen, all ON DELETE RESTRICT',
  fks === 'financial_instrument.bank_account_id>financial_account:r,financial_instrument.cliente_id>clients:r,'
  + 'financial_instrument.created_by>perfiles:r,financial_instrument.endorsed_to_supplier_id>suppliers:r,'
  + 'financial_instrument.source_collection_id>collections:r,financial_instrument.supplier_id>suppliers:r,'
  + 'financial_instrument_event.created_by>perfiles:r,financial_instrument_event.financial_instrument_id>financial_instrument:r,'
  + 'financial_instrument_event.financial_operation_id>financial_operation:r,'
  + 'supplier_ledger.created_by>perfiles:r,supplier_ledger.reversal_of_id>supplier_ledger:r,supplier_ledger.supplier_id>suppliers:r', fks);
const idx = owner(`SELECT string_agg(indexname || ':' || (indexdef LIKE 'CREATE UNIQUE%'), ',' ORDER BY indexname) FROM pg_indexes
  WHERE tablename IN ('financial_instrument','financial_instrument_event','supplier_ledger') AND indexname LIKE 'idx_%';`);
check('A7 indexes as frozen; (instrument, event_type) is UNIQUE',
  idx === 'idx_instrument_cliente:false,idx_instrument_estado:false,idx_instrument_event_date:false,'
  + 'idx_instrument_event_unique:true,idx_instrument_maturity:false,idx_instrument_supplier:false,idx_supplier_ledger_supplier_date:false', idx);
const rls = owner(`SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
  AND relname IN (${NEW_TABLES.map((t) => `'${t}'`).join(',')}) AND relrowsecurity;`);
check('A8 RLS enabled on the three tables', rls === '3', rls);
const parallel = owner(`SELECT coalesce(string_agg(table_name, ','), '') FROM information_schema.tables WHERE table_schema = 'public'
  AND table_name ~* '(cheque|echeq|cartera|portfolio|instrument_audit|supplier_balance|balance|saldo)' AND table_name NOT IN (${ADR005_VIEWS});`);
const chequeAcct = owner(`SELECT count(*) FROM financial_account WHERE nombre ~* '(cheque|echeq|cartera|valores)';`);
check('A9 no parallel structure: no cheque/portfolio/balance table, no cheque "account"', parallel === '' && chequeAcct === '0', `${parallel}/${chequeAcct}`);
const slCols = owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'supplier_ledger';`);
check('A10 supplier_ledger is exactly the frozen signed ledger (no balance, no invoice allocation)',
  slCols === 'id,supplier_id,movement_type,signed_amount,effective_date,source_entity_type,source_entity_id,reversal_of_id,reason,created_at,created_by', slCols);

// ── common fixtures ──
const BANK = mkAccount('Banco');
const BANK2 = mkAccount('Banco 2');
const BANK_OFF = mkAccount('Banco inactivo', 'BANK_ACCOUNT', false);
const SUP = mkSupplier('Proveedor');
const SUP_OFF = mkSupplier('Proveedor inactivo', false);

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Received — RECEIVE');

const cB = debtor('Cliente B', 100000);
check('B0 fixture: client owes 100000.00 from a delivered sale', clientBal(cB) === '100000.00');
let money = totalMoney();
const recB = rpc(receiveCall(cB, 100000, `${TAG}-R-B`, '2026-04-10 23:30:00-03', 'CHEQUE', '00012345'));
const iB = recB.instrument_id;
check('B1 receive_cheque returns {instrument_id, estado RECEIVED, received_date = BA date}',
  recB.estado === 'RECEIVED' && recB.received_date === '2026-04-10', JSON.stringify(recB));
const rowB = owner(`SELECT direction || '|' || estado || '|' || instrument_type || '|' || cheque_number || '|' || amount || '|' || cliente_id
  || '|' || receipt_id || '|' || received_date || '|' || coalesce(bank_account_id::TEXT, '-') FROM financial_instrument WHERE id = '${iB}';`);
check('B2 instrument in portfolio: RECEIVED direction/estado, provenance and receipt persisted, no bank account yet',
  rowB === `RECEIVED|RECEIVED|CHEQUE|00012345|100000.00|${cB}|${TAG}-R-B|2026-04-10|-`, rowB);
check('B3 client debt reduced by exactly the amount (100000 → 0.00)', clientBal(cB) === '0.00', clientBal(cB));
const ledB = owner(`SELECT movement_type || '|' || signed_amount || '|' || effective_date || '|' || source_entity_type || '|' || source_entity_id
  FROM client_ledger WHERE cliente_id = '${cB}' AND movement_type <> 'SALE_DELIVERY';`);
check('B4 client_ledger CHEQUE_RECEIVED -100000.00 at received_date, source financial_instrument',
  ledB === `CHEQUE_RECEIVED|-100000.00|2026-04-10|financial_instrument|${iB}`, ledB);
check('B5 event RECEIVED recorded with event_date = received_date',
  events(iB) === 'RECEIVED' && owner(`SELECT event_date FROM financial_instrument_event WHERE financial_instrument_id = '${iB}';`) === '2026-04-10');
check('B6 NO financial_operation / posting: the bank is untouched at reception',
  opsOf(iB) === '' && totalMoney() === money && acctBal(BANK) === '0.00');
const audB = owner(`SELECT action || '|' || (after_values->>'amount') || '|' || (after_values->>'cheque_number') || '|' || performed_by
  FROM audit_events WHERE entity_type = 'financial_instrument' AND entity_id = '${iB}';`);
check('B7 audit RECEIVE with amount, cheque_number, actor', audB === `RECEIVE|100000|00012345|${ADMIN_UID}`, audB);

let snap = snapshot();
const recErrors = [
  [receiveCall(cB, 0, uniq('RE')), 'INVALID_AMOUNT'],
  [receiveCall(cB, -1, uniq('RE')), 'INVALID_AMOUNT'],
  [receiveCall(cB, null, uniq('RE')), 'INVALID_AMOUNT'],
  [receiveCall(MISSING_UUID, 10, uniq('RE')), 'CLIENT_NOT_FOUND_OR_INACTIVE'],
  [receiveCall(debtor('Cliente inactivo', 0, undefined, false), 10, uniq('RE')), 'CLIENT_NOT_FOUND_OR_INACTIVE'],
  [receiveCall(cB, 10, `${TAG}-R-B`), 'DUPLICATE_RECEIPT'],
];
snap = snapshot();
const recErrOk = recErrors.map(([c, code]) => [code, raised(ADMIN(`SELECT ${c};`), code)]);
check(`B8 contract errors: ${recErrors.map((e) => e[1]).join(', ')}; nothing written`,
  recErrOk.every(([, ok]) => ok) && snapshot() === snap, recErrOk.filter(([, ok]) => !ok).map(([c]) => c).join(','));
const iSameNum = receive(debtor('Cliente B9', 1000), 500, uniq('R'), '2026-04-10 10:00:00-03', 'ECHEQ', '00012345');
check('B9 the same cheque_number can legitimately recur (identity is id, idempotency is receipt_id)',
  owner(`SELECT count(*) FROM financial_instrument WHERE cheque_number = '00012345';`) === '2' && estado(iSameNum) === 'RECEIVED');

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Received — DEPOSIT');

money = totalMoney();
const ledCountB = owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${cB}';`);
const depB = rpc(depositCall(iB, '2026-04-12'));
check('C1 RECEIVED → DEPOSITED with deposited_date', depB.estado === 'DEPOSITED' && estado(iB) === 'DEPOSITED'
  && owner(`SELECT deposited_date FROM financial_instrument WHERE id = '${iB}';`) === '2026-04-12', JSON.stringify(depB));
check('C2 event DEPOSITED appended', events(iB) === 'RECEIVED,DEPOSITED');
check('C3 client debt intact (0.00) and no new client_ledger row',
  clientBal(cB) === '0.00' && owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${cB}';`) === ledCountB);
check('C4 bank intact: deposit is custody only (no operation, no posting)', opsOf(iB) === '' && totalMoney() === money);
check('C5 audit DEPOSIT RECEIVED → DEPOSITED', owner(`SELECT (before_values->>'estado') || '>' || (after_values->>'estado') FROM audit_events
  WHERE entity_id = '${iB}' AND action = 'DEPOSIT';`) === 'RECEIVED>DEPOSITED');

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Received — CLEAR');

const ledCountB2 = owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${cB}';`);
money = totalMoney();
r = ADMIN(`SELECT ${clearCall(iB, BANK_OFF, '2026-04-15')};`);
check('D0 clearing into an inactive account → ACCOUNT_NOT_FOUND_OR_INACTIVE', raised(r, 'ACCOUNT_NOT_FOUND_OR_INACTIVE') && estado(iB) === 'DEPOSITED', firstErr(r));
const clrB = rpc(clearCall(iB, BANK, '2026-04-15'));
check('D1 DEPOSITED → CLEARED; bank_account_id persisted for later reversal',
  clrB.estado === 'CLEARED' && owner(`SELECT estado || '|' || cleared_date || '|' || bank_account_id FROM financial_instrument WHERE id = '${iB}';`)
  === `CLEARED|2026-04-15|${BANK}`, JSON.stringify(clrB));
check('D2 exactly one CHEQUE_CLEAR operation, external_ref CLEAR:<id>', opsOf(iB) === `CHEQUE_CLEAR:CLEAR:${iB}`, opsOf(iB));
check('D3 exactly one posting +100000.00 on the real bank account at cleared_date', postingsOf(iB) === `${BANK}:100000.00:2026-04-15`, postingsOf(iB));
check('D4 bank balance +100000; total money +100000', acctBal(BANK) === '100000.00' && totalMoney() === f2(n(money) + 100000));
check('D5 client debt NOT reduced again (still 0.00, no new client_ledger row)',
  clientBal(cB) === '0.00' && owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${cB}';`) === ledCountB2);
check('D6 event CLEARED references the operation', owner(`SELECT event_type || ':' || (financial_operation_id = ${clrB.financial_operation_id})
  FROM financial_instrument_event WHERE financial_instrument_id = '${iB}' AND event_type = 'CLEARED';`) === 'CLEARED:true');

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Received — ENDORSE');

const cE = debtor('Cliente E', 60000);
const SUP_E = mkSupplier('Proveedor E');
supplierDebt(SUP_E, 60000);
const iE = receive(cE, 60000, uniq('R'));
check('E0 fixture: client paid by cheque (0.00), supplier owes 60000.00', clientBal(cE) === '0.00' && supplierBal(SUP_E) === '60000.00');
money = totalMoney();
r = ADMIN(`SELECT ${endorseCall(iE, SUP_OFF)};`);
check('E1 endorsing to an inactive supplier → SUPPLIER_NOT_FOUND_OR_INACTIVE', raised(r, 'SUPPLIER_NOT_FOUND_OR_INACTIVE'), firstErr(r));
const endE = rpc(endorseCall(iE, SUP_E, '2026-04-14'));
check('E2 RECEIVED → ENDORSED (leaves the portfolio), endorsed_to + endorsed_date persisted',
  endE.estado === 'ENDORSED' && owner(`SELECT estado || '|' || endorsed_to_supplier_id || '|' || endorsed_date FROM financial_instrument WHERE id = '${iE}';`)
  === `ENDORSED|${SUP_E}|2026-04-14`, JSON.stringify(endE));
check('E3 supplier debt reduced: CHEQUE_ENDORSED -60000.00 → 0.00',
  supplierBal(SUP_E) === '0.00' && owner(`SELECT movement_type || '|' || signed_amount || '|' || source_entity_id FROM supplier_ledger
    WHERE supplier_id = '${SUP_E}' AND movement_type = 'CHEQUE_ENDORSED';`) === `CHEQUE_ENDORSED|-60000.00|${iE}`);
check('E4 client remains paid (0.00), no client_ledger movement from the endorsement',
  clientBal(cE) === '0.00' && owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${cE}' AND movement_type NOT IN ('SALE_DELIVERY','CHEQUE_RECEIVED');`) === '0');
check('E5 bank untouched: no operation, no posting', opsOf(iE) === '' && totalMoney() === money);
check('E6 event ENDORSED + audit ENDORSE with supplier', events(iE) === 'RECEIVED,ENDORSED'
  && owner(`SELECT after_values->>'supplier_id' FROM audit_events WHERE entity_id = '${iE}' AND action = 'ENDORSE';`) === SUP_E);

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Received — REJECTION BEFORE CLEAR');

const cF = debtor('Cliente F', 80000);
const iF = receive(cF, 80000, uniq('R'));
check('F0 fixture: debt 80000 → 0.00 after reception', clientBal(cF) === '0.00');
money = totalMoney();
r = ADMIN(`SELECT ${rejectCall(iF, '2026-04-20', '  ')};`);
check('F1 reason is mandatory → REASON_REQUIRED', raised(r, 'REASON_REQUIRED') && estado(iF) === 'RECEIVED', firstErr(r));
const rjF = rpc(rejectCall(iF, '2026-04-20', 'sin fondos'));
check('F2 RECEIVED → REJECTED, prior_estado RECEIVED, no financial operation',
  rjF.prior_estado === 'RECEIVED' && rjF.estado === 'REJECTED' && rjF.financial_operation_id === null, JSON.stringify(rjF));
check('F3 client debt reopens: CHEQUE_REJECTED +80000.00 at rejected_date → 80000.00',
  clientBal(cF) === '80000.00' && owner(`SELECT signed_amount || '|' || effective_date FROM client_ledger WHERE cliente_id = '${cF}' AND movement_type = 'CHEQUE_REJECTED';`) === '80000.00|2026-04-20');
check('F4 bank unchanged, no fictitious posting', opsOf(iF) === '' && totalMoney() === money);
const cF2 = debtor('Cliente F2', 30000);
const iF2 = receive(cF2, 30000, uniq('R'));
rpc(depositCall(iF2, '2026-04-12'));
const rjF2 = rpc(rejectCall(iF2, '2026-04-21', 'rechazado en depósito'));
check('F5 DEPOSITED → REJECTED: debt reopens (30000.00), no bank movement',
  rjF2.prior_estado === 'DEPOSITED' && clientBal(cF2) === '30000.00' && opsOf(iF2) === '' && totalMoney() === money);
check('F6 events RECEIVED,DEPOSITED,REJECTED; REJECTED event has no operation',
  events(iF2) === 'RECEIVED,DEPOSITED,REJECTED'
  && owner(`SELECT financial_operation_id IS NULL FROM financial_instrument_event WHERE financial_instrument_id = '${iF2}' AND event_type = 'REJECTED';`) === 't');

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'Received — REJECTION AFTER CLEAR');

const bankBeforeG = acctBal(BANK);
const rjB = rpc(rejectCall(iB, '2026-04-25', 'cheque rechazado tras acreditación'));
check('G1 CLEARED → REJECTED with a CHEQUE_REJECTION operation', rjB.prior_estado === 'CLEARED' && Number.isInteger(rjB.financial_operation_id), JSON.stringify(rjB));
check('G2 client debt reopens (+100000.00 → 100000.00)', clientBal(cB) === '100000.00', clientBal(cB));
check('G3 the bank credit is reversed on the SAME account that was credited (-100000.00)',
  postingsOf(iB) === `${BANK}:100000.00:2026-04-15,${BANK}:-100000.00:2026-04-25` && acctBal(BANK) === f2(n(bankBeforeG) - 100000), postingsOf(iB));
check('G4 operations: CLEAR:<id> then REJECT:<id>', opsOf(iB) === `CHEQUE_CLEAR:CLEAR:${iB},CHEQUE_REJECTION:REJECT:${iB}`, opsOf(iB));
snap = snapshot();
r = ADMIN(`SELECT ${rejectCall(iB, '2026-04-26', 'otra vez')};`);
check('G5 a second rejection → ALREADY_REJECTED; no double reversal', raised(r, 'ALREADY_REJECTED') && snapshot() === snap, firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('H', 'Received — ENDORSED REJECTION');

money = totalMoney();
const clientLedE = owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${cE}';`);
const rjE = rpc(rejectCall(iE, '2026-04-28', 'el proveedor devolvió el cheque'));
check('H1 ENDORSED → REJECTED, no financial operation', rjE.prior_estado === 'ENDORSED' && rjE.financial_operation_id === null, JSON.stringify(rjE));
check('H2 supplier debt reopens: INSTRUMENT_REJECTED +60000.00 on the endorsee → 60000.00',
  supplierBal(SUP_E) === '60000.00' && owner(`SELECT signed_amount || '|' || effective_date FROM supplier_ledger WHERE supplier_id = '${SUP_E}' AND movement_type = 'INSTRUMENT_REJECTED';`) === '60000.00|2026-04-28');
check('H3 the client is NOT reopened (frozen: the endorsement settled it) — 0.00, no client_ledger row',
  clientBal(cE) === '0.00' && owner(`SELECT count(*) FROM client_ledger WHERE cliente_id = '${cE}';`) === clientLedE);
check('H4 bank untouched', opsOf(iE) === '' && totalMoney() === money);

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'Issued — ISSUE');

const SUP_I = mkSupplier('Proveedor I');
supplierDebt(SUP_I, 50000);
money = totalMoney();
snap = snapshot();
const issErrors = [
  [issueCall(SUP_I, 0, BANK2, uniq('X')), 'INVALID_AMOUNT'],
  [issueCall(SUP_I, null, BANK2, uniq('X')), 'INVALID_AMOUNT'],
  [issueCall(SUP_OFF, 100, BANK2, uniq('X')), 'SUPPLIER_NOT_FOUND_OR_INACTIVE'],
  [issueCall(MISSING_UUID, 100, BANK2, uniq('X')), 'SUPPLIER_NOT_FOUND_OR_INACTIVE'],
  [issueCall(SUP_I, 100, BANK_OFF, uniq('X')), 'ACCOUNT_NOT_FOUND_OR_INACTIVE'],
  [issueCall(SUP_I, 100, null, uniq('X')), 'ACCOUNT_NOT_FOUND_OR_INACTIVE'],
];
const issErrOk = issErrors.map(([c, code]) => [code, raised(ADMIN(`SELECT ${c};`), code)]);
check(`I0 contract errors: ${issErrors.map((e) => e[1]).join(', ')}; nothing written`,
  issErrOk.every(([, ok]) => ok) && snapshot() === snap, issErrOk.filter(([, ok]) => !ok).map(([c]) => c).join(','));
const isI = rpc(issueCall(SUP_I, 50000, BANK2, `${TAG}-X-I`, '2026-04-10'));
const iI = isI.instrument_id;
check('I1 issue_supplier_instrument → ISSUED with issued_date', isI.estado === 'ISSUED' && isI.issued_date === '2026-04-10', JSON.stringify(isI));
check('I2 supplier, bank account and external_ref persisted at issue', owner(`SELECT direction || '|' || instrument_type || '|' || supplier_id || '|' || bank_account_id || '|' || external_ref
  FROM financial_instrument WHERE id = '${iI}';`) === `ISSUED|ECHEQ|${SUP_I}|${BANK2}|${TAG}-X-I`);
check('I3 supplier debt reduced: INSTRUMENT_ISSUED -50000.00 → 0.00', supplierBal(SUP_I) === '0.00'
  && owner(`SELECT movement_type || '|' || signed_amount FROM supplier_ledger WHERE source_entity_id = '${iI}';`) === 'INSTRUMENT_ISSUED|-50000.00');
check('I4 bank untouched at issue (no operation, no posting)', opsOf(iI) === '' && totalMoney() === money && acctBal(BANK2) === '0.00');
check('I5 event ISSUED + audit ISSUE', events(iI) === 'ISSUED'
  && owner(`SELECT action FROM audit_events WHERE entity_id = '${iI}';`) === 'ISSUE');
r = ADMIN(`SELECT ${issueCall(SUP_I, 10, BANK2, `${TAG}-X-I`)};`);
check('I6 duplicate external_ref → DUPLICATE_EXTERNAL_REF', raised(r, 'DUPLICATE_EXTERNAL_REF'), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('J', 'Issued — DEBIT');

const dbI = rpc(debitCall(iI, '2026-04-18'));
check('J1 ISSUED → DEBITED with debited_date', dbI.estado === 'DEBITED' && owner(`SELECT debited_date FROM financial_instrument WHERE id = '${iI}';`) === '2026-04-18');
check('J2 exactly one INSTRUMENT_DEBIT operation (DEBIT:<id>) and one posting -50000.00 on the issuing account',
  opsOf(iI) === `INSTRUMENT_DEBIT:DEBIT:${iI}` && postingsOf(iI) === `${BANK2}:-50000.00:2026-04-18`, `${opsOf(iI)} / ${postingsOf(iI)}`);
check('J3 bank -50000', acctBal(BANK2) === '-50000.00' && totalMoney() === f2(n(money) - 50000));
check('J4 supplier debt NOT touched again (0.00, one supplier_ledger row for the instrument)',
  supplierBal(SUP_I) === '0.00' && owner(`SELECT count(*) FROM supplier_ledger WHERE source_entity_id = '${iI}';`) === '1');
check('J5 event DEBITED references the operation', owner(`SELECT financial_operation_id = ${dbI.financial_operation_id} FROM financial_instrument_event
  WHERE financial_instrument_id = '${iI}' AND event_type = 'DEBITED';`) === 't');

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'Issued — REJECTION BEFORE DEBIT');

const SUP_K = mkSupplier('Proveedor K');
supplierDebt(SUP_K, 30000);
const iK = issue(SUP_K, 30000, BANK2, uniq('X'));
money = totalMoney();
const rjK = rpc(rejectIssuedCall(iK, '2026-04-22', 'eCheq rechazado'));
check('K1 ISSUED → REJECTED, no operation', rjK.prior_estado === 'ISSUED' && rjK.financial_operation_id === null, JSON.stringify(rjK));
check('K2 supplier debt reopens (0 → 30000.00)', supplierBal(SUP_K) === '30000.00', supplierBal(SUP_K));
check('K3 bank intact: no reversal of a debit that never happened', opsOf(iK) === '' && totalMoney() === money);

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'Issued — REJECTION AFTER DEBIT');

const bankBeforeL = acctBal(BANK2);
const rjI = rpc(rejectIssuedCall(iI, '2026-04-26', 'eCheq rechazado tras débito'));
check('L1 DEBITED → REJECTED with an INSTRUMENT_DEBIT_REVERSAL operation', rjI.prior_estado === 'DEBITED' && Number.isInteger(rjI.financial_operation_id));
check('L2 supplier debt reopens (+50000.00 → 50000.00)', supplierBal(SUP_I) === '50000.00', supplierBal(SUP_I));
check('L3 bank debit reversed on the same account (+50000.00)', acctBal(BANK2) === f2(n(bankBeforeL) + 50000)
  && postingsOf(iI) === `${BANK2}:-50000.00:2026-04-18,${BANK2}:50000.00:2026-04-26`, postingsOf(iI));
snap = snapshot();
r = ADMIN(`SELECT ${rejectIssuedCall(iI, '2026-04-27')};`);
check('L4 a second rejection → INVALID_STATE; no duplicate reversal', raised(r, 'INVALID_STATE') && snapshot() === snap, firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('M', 'Illegal transitions');

const cM = debtor('Cliente M', 50000);
const iM1 = receive(cM, 1000, uniq('R'));
const iM2 = receive(cM, 1000, uniq('R'));
rpc(depositCall(iM2));
const iM3 = receive(cM, 1000, uniq('R'));
rpc(endorseCall(iM3, SUP));
const iM4 = issue(SUP, 1000, BANK2, uniq('X'));
const iM5 = issue(SUP, 1000, BANK2, uniq('X'));
rpc(debitCall(iM5));
snap = snapshot();
const illegal = [
  ['clear without deposit (RECEIVED)', clearCall(iM1, BANK), 'INVALID_STATE'],
  ['deposit twice', depositCall(iM2), 'INVALID_STATE'],
  ['endorse a DEPOSITED instrument', endorseCall(iM2, SUP), 'INVALID_STATE'],
  ['clear twice (CLEARED)', clearCall(iB, BANK), 'INVALID_STATE'],
  ['endorse twice', endorseCall(iM3, SUP), 'INVALID_STATE'],
  ['deposit an ENDORSED instrument', depositCall(iM3), 'INVALID_STATE'],
  ['clear an ENDORSED instrument', clearCall(iM3, BANK), 'INVALID_STATE'],
  ['deposit from terminal REJECTED', depositCall(iF), 'INVALID_STATE'],
  ['clear from terminal REJECTED', clearCall(iF2, BANK), 'INVALID_STATE'],
  ['endorse from terminal REJECTED', endorseCall(iF, SUP), 'INVALID_STATE'],
  ['reject a REJECTED received instrument', rejectCall(iF), 'ALREADY_REJECTED'],
  ['debit twice (DEBITED)', debitCall(iM5), 'INVALID_STATE'],
  ['debit from terminal REJECTED', debitCall(iK), 'INVALID_STATE'],
  ['reject a REJECTED issued instrument', rejectIssuedCall(iK), 'INVALID_STATE'],
  ['deposit an issued instrument', depositCall(iM4), 'WRONG_DIRECTION'],
  ['clear an issued instrument', clearCall(iM4, BANK), 'WRONG_DIRECTION'],
  ['endorse an issued instrument', endorseCall(iM4, SUP), 'WRONG_DIRECTION'],
  ['reject_cheque on an issued instrument', rejectCall(iM4), 'WRONG_DIRECTION'],
  ['debit a received instrument', debitCall(iM1), 'WRONG_DIRECTION'],
  ['reject_supplier_instrument on a received instrument', rejectIssuedCall(iM1), 'WRONG_DIRECTION'],
  ['unknown instrument', depositCall(MISSING_UUID), 'INSTRUMENT_NOT_FOUND'],
];
for (const [what, call, code] of illegal) {
  r = ADMIN(`SELECT ${call};`);
  check(`M ${what} → ${code}`, raised(r, code), firstErr(r));
}
check('M none of the illegal transitions changed anything', snapshot() === snap);
r = raw(`INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date) VALUES ('${iM2}', 'DEPOSITED', '2026-04-30');`);
check('M a duplicate lifecycle event is physically impossible (idx_instrument_event_unique, even for the owner)',
  !r.ok && /idx_instrument_event_unique/.test(r.err), firstErr(r));
r = raw(`UPDATE financial_instrument SET estado = 'CLEARED' WHERE id = '${iM4}';`);
check('M a state of the wrong direction is physically impossible (chk_instrument_estado_direction)',
  !r.ok && /chk_instrument_estado_direction/.test(r.err), firstErr(r));
const cancelRpc = owner(`SELECT coalesce(string_agg(proname, ',' ORDER BY proname), '') FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  AND prosrc ~ 'estado\\s*=\\s*''CANCELLED''' AND prosrc LIKE '%financial_instrument%';`);
check('M CANCELLED is written to an instrument only by RPC 42 cancel_supplier_instrument (ADR-001)',
  cancelRpc === 'cancel_supplier_instrument', cancelRpc);

// ═══════════════════════════════════════════════════════════════════════════
section('N', 'Periods');

const cN = debtor('Cliente N', 20000);
const iN_rec = receive(cN, 1000, uniq('R'));
const iN_dep = receive(cN, 1000, uniq('R'));
rpc(depositCall(iN_dep));
const iN_iss = issue(SUP, 1000, BANK2, uniq('X'));
closePeriod('2026-03-01');
snap = snapshot();
const closedCalls = [
  ['receive (received_at in CLOSED March)', receiveCall(cN, 100, uniq('R'), '2026-03-20 10:00:00-03')],
  ['receive at 2026-04-01 02:00 UTC = 2026-03-31 BA', receiveCall(cN, 100, uniq('R'), '2026-04-01 02:00:00+00')],
  ['deposit (deposited_date March)', depositCall(iN_rec, '2026-03-25')],
  ['clear (cleared_date March)', clearCall(iN_dep, BANK, '2026-03-25')],
  ['endorse (endorsed_date March)', endorseCall(iN_rec, SUP, '2026-03-25')],
  ['reject received (rejected_date March)', rejectCall(iN_rec, '2026-03-25')],
  ['issue (issued_date March)', issueCall(SUP, 100, BANK2, uniq('X'), '2026-03-25')],
  ['debit (debited_date March)', debitCall(iN_iss, '2026-03-25')],
  ['reject issued (rejected_date March)', rejectIssuedCall(iN_iss, '2026-03-25')],
];
for (const [what, call] of closedCalls) {
  r = ADMIN(`SELECT ${call};`);
  check(`N CLOSED → PERIOD_CLOSED: ${what}`, raised(r, 'PERIOD_CLOSED'), firstErr(r));
}
check('N every CLOSED rejection rolled back completely (states, events, ledgers, money, audit)', snapshot() === snap);
r = ADMIN(`SELECT ${depositCall(iN_rec, '2027-02-10')};`);
check('N date without a management_period → PERIOD_NOT_FOUND', raised(r, 'PERIOD_NOT_FOUND'), firstErr(r));
openPeriod('2026-03-01');

// each step uses its OWN determinant: receive in June, close June, continue in July
const cN2 = debtor('Cliente N2', 7000);
const iN2 = receive(cN2, 7000, uniq('R'), '2026-06-10 10:00:00-03');
const iN3 = receive(cN2, 500, uniq('R'), '2026-06-10 10:00:00-03');
closePeriod('2026-06-01');
rpc(depositCall(iN2, '2026-07-02'));
rpc(clearCall(iN2, BANK, '2026-07-05'));
rpc(rejectCall(iN3, '2026-07-06', 'rechazo en julio'));
check('N each lifecycle step is guarded by its own date: received in (now CLOSED) June, deposited/cleared/rejected in OPEN July',
  estado(iN2) === 'CLEARED' && estado(iN3) === 'REJECTED'
  && owner(`SELECT effective_date FROM client_ledger WHERE source_entity_id = '${iN3}' AND movement_type = 'CHEQUE_REJECTED';`) === '2026-07-06');
openPeriod('2026-06-01');

closePeriod(CURRENT_MONTH);
const iN4 = receive(cN2, 100, uniq('R'), '2026-05-10 10:00:00-03');
check(`N created_at irrelevant: created in CLOSED ${CURRENT_MONTH}, received_date 2026-05-10 (OPEN) → accepted`,
  owner(`SELECT received_date || '|' || date_trunc('month', created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE FROM financial_instrument WHERE id = '${iN4}';`)
  === `2026-05-10|${CURRENT_MONTH}`);
openPeriod(CURRENT_MONTH);

// ═══════════════════════════════════════════════════════════════════════════
section('O', 'Atomicity (injected failures at intermediate points)');

owner(`
CREATE SCHEMA p16_harness;
CREATE TABLE p16_harness.fail_on (target TEXT, instrument_id TEXT);
CREATE FUNCTION p16_harness.fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM p16_harness.fail_on WHERE target = 'event' AND instrument_id = NEW.financial_instrument_id::TEXT) THEN
    RAISE EXCEPTION 'HARNESS_EVENT_FAILURE';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p16_harness.fail_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_operation o JOIN p16_harness.fail_on f
              ON f.target = 'posting' AND f.instrument_id = o.source_entity_id
             WHERE o.id = NEW.financial_operation_id) THEN
    RAISE EXCEPTION 'HARNESS_POSTING_FAILURE';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p16_harness.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM p16_harness.fail_on WHERE target = 'audit' AND instrument_id = NEW.entity_id) THEN
    RAISE EXCEPTION 'HARNESS_AUDIT_FAILURE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p16_fail_event BEFORE INSERT ON public.financial_instrument_event FOR EACH ROW EXECUTE FUNCTION p16_harness.fail_event();
CREATE TRIGGER p16_fail_posting BEFORE INSERT ON public.financial_posting FOR EACH ROW EXECUTE FUNCTION p16_harness.fail_posting();
CREATE TRIGGER p16_fail_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION p16_harness.fail_audit();`);
const failOn = (t, i) => owner(`DELETE FROM p16_harness.fail_on; INSERT INTO p16_harness.fail_on VALUES ('${t}', '${i}');`);
try {
  const cO = debtor('Cliente O', 20000);
  const SUP_O = mkSupplier('Proveedor O');
  supplierDebt(SUP_O, 20000);
  const iO1 = receive(cO, 5000, uniq('R'));
  failOn('event', iO1);
  snap = snapshot();
  r = ADMIN(`SELECT ${rejectCall(iO1, '2026-04-20', 'x')};`);
  check('O1 reject: state updated + client_ledger written, then the REJECTED event fails → full rollback',
    raised(r, 'HARNESS_EVENT_FAILURE') && snapshot() === snap && estado(iO1) === 'RECEIVED', firstErr(r));

  const iO2 = receive(cO, 5000, uniq('R'));
  rpc(depositCall(iO2));
  failOn('posting', iO2);
  snap = snapshot();
  r = ADMIN(`SELECT ${clearCall(iO2, BANK, '2026-04-16')};`);
  check('O2 clear: state updated + operation written, then the posting fails → full rollback (still DEPOSITED, no operation)',
    raised(r, 'HARNESS_POSTING_FAILURE') && snapshot() === snap && estado(iO2) === 'DEPOSITED' && opsOf(iO2) === '', firstErr(r));

  const iO3 = receive(cO, 5000, uniq('R'));
  failOn('audit', iO3);
  snap = snapshot();
  r = ADMIN(`SELECT ${endorseCall(iO3, SUP_O)};`);
  check('O3 endorse: state + event + supplier_ledger written, then audit fails → full rollback',
    raised(r, 'HARNESS_AUDIT_FAILURE') && snapshot() === snap && estado(iO3) === 'RECEIVED' && supplierBal(SUP_O) === '20000.00', firstErr(r));

  const iO4 = issue(SUP_O, 4000, BANK2, uniq('X'));
  failOn('posting', iO4);
  snap = snapshot();
  r = ADMIN(`SELECT ${debitCall(iO4)};`);
  check('O4 debit: state + operation written, then posting fails → full rollback (still ISSUED)',
    raised(r, 'HARNESS_POSTING_FAILURE') && snapshot() === snap && estado(iO4) === 'ISSUED', firstErr(r));

  owner(`DELETE FROM p16_harness.fail_on;`);
  rpc(debitCall(iO4));
  failOn('posting', iO4);
  snap = snapshot();
  r = ADMIN(`SELECT ${rejectIssuedCall(iO4, '2026-04-22')};`);
  check('O5 reject after debit: supplier_ledger + reversal operation written, then the reversal posting fails → full rollback',
    raised(r, 'HARNESS_POSTING_FAILURE') && snapshot() === snap && estado(iO4) === 'DEBITED', firstErr(r));

  const iO6 = receive(cO, 2000, uniq('R'));
  rpc(depositCall(iO6));
  rpc(clearCall(iO6, BANK));
  failOn('audit', iO6);
  snap = snapshot();
  r = ADMIN(`SELECT ${rejectCall(iO6, '2026-04-23', 'x')};`);
  check('O6 reject after clear: client_ledger + reversal operation + posting + event written, then audit fails → full rollback',
    raised(r, 'HARNESS_AUDIT_FAILURE') && snapshot() === snap && estado(iO6) === 'CLEARED', firstErr(r));
} finally {
  owner(`DROP SCHEMA IF EXISTS p16_harness CASCADE;`);
}
check('O7 harness triggers removed', owner(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p16_fail_%';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('P', 'Security');

const cP = debtor('Cliente P', 5000);
const iP = receive(cP, 1000, uniq('R'));
const iPi = issue(SUP, 1000, BANK2, uniq('X'));
const operCalls = [
  receiveCall(cP, 10, uniq('R')), depositCall(iP), clearCall(iP, BANK), endorseCall(iP, SUP), rejectCall(iP),
  issueCall(SUP, 10, BANK2, uniq('X')), debitCall(iPi), rejectIssuedCall(iPi), cancelCall(iPi),
];
const operRes = operCalls.map((c) => raised(OPER(`SELECT ${c};`), 'FORBIDDEN'));
check('P1 OPERATOR gets FORBIDDEN from all 8 instrument RPCs', operRes.every(Boolean), operRes.join(','));
for (const t of NEW_TABLES) {
  r = OPER(`SELECT count(*) FROM ${t};`);
  check(`P2 OPERATOR reads 0 rows of ${t}`, r.ok && r.out === '0', r.out || firstErr(r));
}
const inact = [asUser(INACTIVE_UID, `SELECT ${depositCall(iP)};`), asUser(NOPROFILE_UID, `SELECT ${depositCall(iP)};`)];
check('P3 inactive / missing profile → USER_NOT_FOUND_OR_INACTIVE', inact.every((x) => raised(x, 'USER_NOT_FOUND_OR_INACTIVE')));
const anonRes = [...operCalls.map((c) => asAnon(`SELECT ${c};`)), ...NEW_TABLES.map((t) => asAnon(`SELECT count(*) FROM ${t};`))];
check('P4 anon: no EXECUTE on any instrument RPC and no SELECT on the three tables', anonRes.every(denied));
const srRes = [...operCalls.map((c) => asServiceRole(`SELECT ${c};`)), ...NEW_TABLES.map((t) => asServiceRole(`SELECT count(*) FROM ${t};`))];
check('P5 service_role: no EXECUTE and no access (the frozen spec grants it nothing here)', srRes.every(denied));
snap = snapshot();
const direct = [
  ADMIN(`INSERT INTO financial_instrument (instrument_type, direction, estado, cheque_number, amount, cliente_id, receipt_id, received_date)
         VALUES ('CHEQUE', 'RECEIVED', 'RECEIVED', '1', 1, '${cP}', 'x', '2026-04-10');`),
  ADMIN(`UPDATE financial_instrument SET estado = 'CLEARED' WHERE id = '${iP}';`),
  ADMIN(`UPDATE financial_instrument SET estado = 'CANCELLED' WHERE id = '${iPi}';`),
  ADMIN(`DELETE FROM financial_instrument WHERE id = '${iP}';`),
  ADMIN(`TRUNCATE financial_instrument CASCADE;`),
  ADMIN(`INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date) VALUES ('${iP}', 'CLEARED', '2026-04-10');`),
  ADMIN(`DELETE FROM financial_instrument_event WHERE financial_instrument_id = '${iP}';`),
  ADMIN(`INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date) VALUES ('${SUP}', 'ADJUSTMENT', -1000000, '2026-04-10');`),
  ADMIN(`UPDATE supplier_ledger SET signed_amount = 1;`),
  ADMIN(`TRUNCATE supplier_ledger;`),
];
check('P6 even ADMIN: no direct INSERT / UPDATE / DELETE / TRUNCATE on instruments, events or supplier_ledger',
  direct.every(denied) && snapshot() === snap, direct.map((x) => (denied(x) ? 'd' : 'OPEN')).join(','));
const acl = owner(`SELECT string_agg(relname || '=' || relacl::TEXT, ' ' ORDER BY relname) FROM pg_class WHERE relname IN
  ('financial_instrument','financial_instrument_event','supplier_ledger','financial_instrument_event_id_seq','supplier_ledger_id_seq');`);
check('P7 exact ACLs: authenticated SELECT only; sequences owner-only',
  acl === 'financial_instrument={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'financial_instrument_event={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'financial_instrument_event_id_seq={postgres=rwU/postgres} '
  + 'supplier_ledger={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'supplier_ledger_id_seq={postgres=rwU/postgres}', acl);
const pols = owner(`SELECT string_agg(tablename || ':' || policyname || ':' || cmd, ',' ORDER BY tablename) FROM pg_policies
  WHERE tablename IN (${NEW_TABLES.map((t) => `'${t}'`).join(',')});`);
check('P8 exactly one ADMIN SELECT policy per table, nothing for OPERATOR, no write policy',
  pols === 'financial_instrument:financial_instrument_admin_select:SELECT,financial_instrument_event:financial_instrument_event_admin_select:SELECT,'
  + 'supplier_ledger:supplier_ledger_admin_select:SELECT', pols);

// ═══════════════════════════════════════════════════════════════════════════
section('Q', 'SECURITY DEFINER');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
check('Q1 SECURITY DEFINER inventory = previous 7 + the 9 instrument RPCs + built later-phase RPCs', definers === ALL_DEFINERS, definers);
const hard = owner(`SELECT string_agg(proname || ':' || prosecdef || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || ':' ||
  pg_get_userbyid(proowner) || ':' || (proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)) || ':' ||
  has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' ||
  has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
  FROM pg_proc WHERE proname IN (${RPCS.map((p) => `'${p}'`).join(',')});`);
check('Q2 every instrument RPC: DEFINER, search_path=public, owner postgres, no PUBLIC, anon no, authenticated yes, service_role no',
  hard === RPCS.map((p) => `${p}:true:true:postgres:true:false:true:false`).join(','), hard);
const actorArgs = owner(`SELECT coalesce(string_agg(proname, ','), '') FROM pg_proc WHERE proname IN (${RPCS.map((p) => `'${p}'`).join(',')})
  AND EXISTS (SELECT 1 FROM unnest(proargnames) a WHERE a ~* '(user|actor|role|performed|created_by|uid)');`);
check('Q3 no parameter can name the actor or the role', actorArgs === '', actorArgs);

// ═══════════════════════════════════════════════════════════════════════════
section('R', 'Concurrency (independent PostgreSQL sessions)');

async function race(label, callA, callB, appPrefix) {
  const pA = session(sessionSql('authenticated', ADMIN_CLAIMS, `SELECT ${callA};\nSELECT pg_sleep(2);`), `${appPrefix}-A`);
  const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-A'
    AND state = 'active' AND query LIKE '%pg_sleep%');`);
  const pB = session(sessionSql('authenticated', ADMIN_CLAIMS, `SELECT ${callB};`), `${appPrefix}-B`);
  const bWait = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-B' AND wait_event_type = 'Lock');`);
  const [ra, rb] = await Promise.all([pA, pB]);
  return { aIn, bWait, ra, rb };
}
const cR = debtor('Cliente R', 50000);
const iR1 = receive(cR, 3000, uniq('R'));
rpc(depositCall(iR1));
let x = await race('clear', clearCall(iR1, BANK), clearCall(iR1, BANK), 'p16-clr');
check('R1 two concurrent clears of one instrument: B waited on A\'s row lock, then INVALID_STATE',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'INVALID_STATE'), `${x.aIn}/${x.bWait}/${firstErr(x.ra)}/${firstErr(x.rb)}`);
check('R2 exactly one CHEQUE_CLEAR operation and one posting', opsOf(iR1) === `CHEQUE_CLEAR:CLEAR:${iR1}` && postingsOf(iR1).split(',').length === 1);

const iR2 = receive(cR, 3000, uniq('R'));
x = await race('reject', rejectCall(iR2), rejectCall(iR2), 'p16-rej');
check('R3 two concurrent rejects: B waited, then ALREADY_REJECTED', x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'ALREADY_REJECTED'), firstErr(x.rb));
check('R4 exactly one CHEQUE_REJECTED client movement', owner(`SELECT count(*) FROM client_ledger WHERE source_entity_id = '${iR2}' AND movement_type = 'CHEQUE_REJECTED';`) === '1');

const SUP_R = mkSupplier('Proveedor R');
supplierDebt(SUP_R, 3000);
const iR3 = receive(cR, 3000, uniq('R'));
x = await race('endorse-vs-deposit', endorseCall(iR3, SUP_R), depositCall(iR3), 'p16-end');
check('R5 conflicting endorse vs deposit (both from RECEIVED): the second waits, then INVALID_STATE; one valid transition',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'INVALID_STATE') && events(iR3) === 'RECEIVED,ENDORSED', `${firstErr(x.rb)} / ${events(iR3)}`);

const iR4 = issue(SUP_R, 2000, BANK2, uniq('X'));
x = await race('debit', debitCall(iR4), debitCall(iR4), 'p16-deb');
check('R6 two concurrent debits: B waited, then INVALID_STATE; one INSTRUMENT_DEBIT posting',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'INVALID_STATE') && opsOf(iR4) === `INSTRUMENT_DEBIT:DEBIT:${iR4}`, firstErr(x.rb));

const refR = uniq('RR');
x = await race('receive-same-receipt', receiveCall(cR, 1000, refR), receiveCall(cR, 1000, refR), 'p16-rcv');
check('R7 two concurrent receptions with the same receipt_id: B waited, then DUPLICATE_RECEIPT; one instrument',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_RECEIPT')
  && owner(`SELECT count(*) FROM financial_instrument WHERE receipt_id = '${refR}';`) === '1', firstErr(x.rb));

// ═══════════════════════════════════════════════════════════════════════════
section('S', 'Cross-domain end-to-end scenarios');

const BNA = mkAccount('E2E BNA');
// received: pedido → delivery → debt → cheque → deposit → clear
const s1 = debtor('E2E Cliente 1', 100000, '2026-05-02 10:00:00-03');
check('S1 client owes 100000.00 after pedido → delivery', clientBal(s1) === '100000.00');
const bna0 = acctBal(BNA);
const is1 = receive(s1, 100000, uniq('R'), '2026-05-05 10:00:00-03');
check('S2 receive cheque 100000: client debt 0.00, bank unchanged', clientBal(s1) === '0.00' && acctBal(BNA) === bna0);
rpc(depositCall(is1, '2026-05-06'));
check('S3 deposit: client debt 0.00, bank unchanged', clientBal(s1) === '0.00' && acctBal(BNA) === bna0);
rpc(clearCall(is1, BNA, '2026-05-08'));
check('S4 clear into BNA: client debt 0.00, BNA +100000.00', clientBal(s1) === '0.00' && acctBal(BNA) === f2(n(bna0) + 100000));
rpc(rejectCall(is1, '2026-05-20', 'rechazo posterior'));
check('S5 rejection after clearing: debt back to 100000.00, BNA back to its initial balance',
  clientBal(s1) === '100000.00' && acctBal(BNA) === bna0);

const s2 = debtor('E2E Cliente 2', 80000, '2026-05-02 10:00:00-03');
const is2 = receive(s2, 80000, uniq('R'), '2026-05-05 10:00:00-03');
check('S6 owes 80000 → cheque → debt 0.00', clientBal(s2) === '0.00');
rpc(rejectCall(is2, '2026-05-09', 'rechazo antes de acreditar'));
check('S7 rejected before clearing → debt 80000.00, bank unchanged', clientBal(s2) === '80000.00' && acctBal(BNA) === bna0);

const s3 = debtor('E2E Cliente 3', 60000, '2026-05-02 10:00:00-03');
const SUP_S = mkSupplier('E2E Proveedor 1');
supplierDebt(SUP_S, 60000, '2026-05-01');
const is3 = receive(s3, 60000, uniq('R'), '2026-05-05 10:00:00-03');
check('S8 owes 60000 → cheque → client 0.00', clientBal(s3) === '0.00');
rpc(endorseCall(is3, SUP_S, '2026-05-07'));
check('S9 endorse to a supplier owed 60000: supplier 0.00, client stays 0.00, bank unchanged',
  supplierBal(SUP_S) === '0.00' && clientBal(s3) === '0.00' && acctBal(BNA) === bna0);

const SUP_S2 = mkSupplier('E2E Proveedor 2');
supplierDebt(SUP_S2, 50000, '2026-05-01');
const is4 = issue(SUP_S2, 50000, BNA, uniq('X'), '2026-05-10');
check('S10 supplier owed 50000 → issue eCheq: supplier 0.00, bank unchanged', supplierBal(SUP_S2) === '0.00' && acctBal(BNA) === bna0);
rpc(debitCall(is4, '2026-05-15'));
check('S11 marked debited: bank -50000.00, supplier unchanged (0.00)', acctBal(BNA) === f2(n(bna0) - 50000) && supplierBal(SUP_S2) === '0.00');
rpc(rejectIssuedCall(is4, '2026-05-25', 'eCheq rechazado'));
check('S12 rejected after debit: supplier 50000.00 again, bank restored', supplierBal(SUP_S2) === '50000.00' && acctBal(BNA) === bna0);

// ═══════════════════════════════════════════════════════════════════════════
section('T', 'Rejection matrix (fresh instrument per stage)');

const MT = mkAccount('Matriz');
const tClient = debtor('Matriz Cliente', 100000);
const tSup = mkSupplier('Matriz Proveedor');
supplierDebt(tSup, 100000);
function reach(stage) {
  if (['RECEIVED', 'DEPOSITED', 'CLEARED', 'ENDORSED'].includes(stage)) {
    const i = receive(tClient, 1000, uniq('R'));
    if (stage === 'DEPOSITED' || stage === 'CLEARED') rpc(depositCall(i));
    if (stage === 'CLEARED') rpc(clearCall(i, MT));
    if (stage === 'ENDORSED') rpc(endorseCall(i, tSup));
    return i;
  }
  const i = issue(tSup, 1000, MT, uniq('X'));
  if (stage === 'DEBITED') rpc(debitCall(i));
  return i;
}
const expected = {
  RECEIVED: { client: 1000, supplier: 0, bank: 0, ops: 0 },
  DEPOSITED: { client: 1000, supplier: 0, bank: 0, ops: 0 },
  CLEARED: { client: 1000, supplier: 0, bank: -1000, ops: 1 },
  ENDORSED: { client: 0, supplier: 1000, bank: 0, ops: 0 },
  ISSUED: { client: 0, supplier: 1000, bank: 0, ops: 0 },
  DEBITED: { client: 0, supplier: 1000, bank: 1000, ops: 1 },
};
for (const [stage, e] of Object.entries(expected)) {
  const i = reach(stage);
  const before = { c: n(clientBal(tClient)), s: n(supplierBal(tSup)), b: n(acctBal(MT)), o: n(owner(`SELECT count(*) FROM financial_operation WHERE source_entity_id = '${i}';`)) };
  const res = rpc(['ISSUED', 'DEBITED'].includes(stage) ? rejectIssuedCall(i, '2026-04-29', 'matriz') : rejectCall(i, '2026-04-29', 'matriz'));
  const d = {
    client: n(clientBal(tClient)) - before.c, supplier: n(supplierBal(tSup)) - before.s,
    bank: n(acctBal(MT)) - before.b, ops: n(owner(`SELECT count(*) FROM financial_operation WHERE source_entity_id = '${i}';`)) - before.o,
  };
  check(`T rejected after ${stage}: client ${e.client >= 0 ? '+' : ''}${e.client}, supplier +${e.supplier}, bank ${e.bank >= 0 ? '+' : ''}${e.bank}, ${e.ops} operation(s)`,
    res.prior_estado === stage && d.client === e.client && d.supplier === e.supplier && d.bank === e.bank && d.ops === e.ops,
    JSON.stringify(d));
}

// ═══════════════════════════════════════════════════════════════════════════
section('V', 'RPC 42 cancel_supplier_instrument (ADR-001)');

const issuedEntry = (i) => owner(`SELECT id FROM supplier_ledger WHERE movement_type = 'INSTRUMENT_ISSUED'
  AND source_entity_type = 'financial_instrument' AND source_entity_id = '${i}';`);
const reversalsOf = (i) => owner(`SELECT coalesce(string_agg(supplier_id || '|' || signed_amount || '|' || effective_date || '|' || source_entity_type
  || '|' || source_entity_id || '|' || reversal_of_id || '|' || reason || '|' || created_by, ';' ORDER BY id), '')
  FROM supplier_ledger WHERE movement_type = 'REVERSAL' AND source_entity_id = '${i}';`);

// A. happy path
const SUP_V = mkSupplier('Proveedor V');
supplierDebt(SUP_V, 50000);
const BANK_V = mkAccount('Banco V');
const iV = issue(SUP_V, 50000, BANK_V, uniq('X'), '2026-04-10');
check('V1 fixture: supplier owes 50000 → issue 50000 → supplier 0.00, bank unchanged',
  supplierBal(SUP_V) === '0.00' && acctBal(BANK_V) === '0.00');
money = totalMoney();
const cV = rpc(cancelCall(iV, '2026-04-19', 'no se entregó al proveedor'));
check('V2 returns {instrument_id, estado CANCELLED, cancelled_date}',
  cV.instrument_id === iV && cV.estado === 'CANCELLED' && cV.cancelled_date === '2026-04-19' && Object.keys(cV).length === 3, JSON.stringify(cV));
check('V3 state CANCELLED with cancelled_date persisted', owner(`SELECT estado || '|' || cancelled_date FROM financial_instrument WHERE id = '${iV}';`) === 'CANCELLED|2026-04-19');
check('V4 supplier debt reopens to 50000.00', supplierBal(SUP_V) === '50000.00', supplierBal(SUP_V));
check('V5 bank unchanged: no financial_operation, no posting, total money unchanged',
  opsOf(iV) === '' && postingsOf(iV) === '' && acctBal(BANK_V) === '0.00' && totalMoney() === money);

// B. reversal provenance
check('V6 exactly one REVERSAL +50000.00, same supplier, instrument provenance, cancelled_date, reversal_of_id = the INSTRUMENT_ISSUED row, reason, actor',
  reversalsOf(iV) === `${SUP_V}|50000.00|2026-04-19|financial_instrument|${iV}|${issuedEntry(iV)}|no se entregó al proveedor|${ADMIN_UID}`, reversalsOf(iV));
check('V7 the referenced row is the -50000.00 INSTRUMENT_ISSUED of the same supplier, and the pair nets to zero',
  owner(`SELECT movement_type || '|' || signed_amount || '|' || supplier_id FROM supplier_ledger WHERE id = ${issuedEntry(iV)};`) === `INSTRUMENT_ISSUED|-50000.00|${SUP_V}`
  && owner(`SELECT SUM(signed_amount) FROM supplier_ledger WHERE source_entity_id = '${iV}';`) === '0.00');

// C. event / audit
check('V8 exactly one CANCELLED event, event_date = cancelled_date, no financial_operation_id',
  events(iV) === 'ISSUED,CANCELLED'
  && owner(`SELECT event_date || '|' || (financial_operation_id IS NULL) || '|' || reason || '|' || created_by FROM financial_instrument_event
            WHERE financial_instrument_id = '${iV}' AND event_type = 'CANCELLED';`) === `2026-04-19|true|no se entregó al proveedor|${ADMIN_UID}`);
const audV = owner(`SELECT count(*) || '|' || min(before_values->>'estado') || '|' || min(after_values->>'estado') || '|' || min(after_values->>'cancelled_date')
  || '|' || min(reason) || '|' || min(performed_by::TEXT) FROM audit_events WHERE entity_id = '${iV}' AND action = 'CANCEL_ISSUED';`);
check('V9 exactly one CANCEL_ISSUED audit: ISSUED → CANCELLED, cancelled_date, reason, real actor',
  audV === `1|ISSUED|CANCELLED|2026-04-19|no se entregó al proveedor|${ADMIN_UID}`, audV);

// D. invalid states — every rejection leaves no partial writes
const cVr = debtor('Cliente V', 5000);
const iVrec = receive(cVr, 1000, uniq('R'));
const iVdeb = issue(SUP_V, 1000, BANK_V, uniq('X'));
rpc(debitCall(iVdeb));
const iVrej = issue(SUP_V, 1000, BANK_V, uniq('X'));
rpc(rejectIssuedCall(iVrej));
const iVopen = issue(SUP_V, 1000, BANK_V, uniq('X'));
snap = snapshot();
const cancelInvalid = [
  ['DEBITED', cancelCall(iVdeb), 'INVALID_STATE'],
  ['REJECTED', cancelCall(iVrej), 'INVALID_STATE'],
  ['CANCELLED (second cancel)', cancelCall(iV), 'INVALID_STATE'],
  ['received instrument', cancelCall(iVrec), 'WRONG_DIRECTION'],
  ['missing instrument', cancelCall(MISSING_UUID), 'INSTRUMENT_NOT_FOUND'],
  ['blank reason', cancelCall(iVopen, '2026-04-19', '   '), 'REASON_REQUIRED'],
  ['NULL reason', `cancel_supplier_instrument('${iVopen}', '2026-04-19', NULL)`, 'REASON_REQUIRED'],
];
for (const [what, call, code] of cancelInvalid) {
  r = ADMIN(`SELECT ${call};`);
  check(`V cancel ${what} → ${code}`, raised(r, code), firstErr(r));
}
r = OPER(`SELECT ${cancelCall(iVopen)};`);
check('V cancel as OPERATOR → FORBIDDEN', raised(r, 'FORBIDDEN'), firstErr(r));
check('V10 none of the rejected cancellations wrote anything (instrument still ISSUED)', snapshot() === snap && estado(iVopen) === 'ISSUED');

// E. period
closePeriod('2026-03-01');
snap = snapshot();
r = ADMIN(`SELECT ${cancelCall(iVopen, '2026-03-20')};`);
check('V11 CLOSED cancelled_date → PERIOD_CLOSED, full rollback', raised(r, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
openPeriod('2026-03-01');
r = ADMIN(`SELECT ${cancelCall(iVopen, '2027-02-10')};`);
check('V12 date without a management_period → PERIOD_NOT_FOUND', raised(r, 'PERIOD_NOT_FOUND') && estado(iVopen) === 'ISSUED', firstErr(r));
const iVjun = issue(SUP_V, 700, BANK_V, uniq('X'), '2026-06-10');
closePeriod('2026-06-01');
rpc(cancelCall(iVjun, '2026-07-03', 'anulado en julio'));
check('V13 cancelled_date is the determinant: issued in (now CLOSED) June, cancelled in OPEN July; REVERSAL dated July',
  estado(iVjun) === 'CANCELLED' && owner(`SELECT effective_date FROM supplier_ledger WHERE movement_type = 'REVERSAL' AND source_entity_id = '${iVjun}';`) === '2026-07-03');
openPeriod('2026-06-01');
closePeriod(CURRENT_MONTH);
const cVopen = rpc(cancelCall(iVopen, '2026-05-20', 'anulado'));
check(`V14 created_at irrelevant: current month ${CURRENT_MONTH} CLOSED, cancelled_date 2026-05-20 (OPEN) → accepted`,
  cVopen.estado === 'CANCELLED' && cVopen.cancelled_date === '2026-05-20');
openPeriod(CURRENT_MONTH);

// F. atomicity — failure after the state update AND the supplier REVERSAL
owner(`
CREATE SCHEMA p16_harness;
CREATE TABLE p16_harness.fail_on (target TEXT, instrument_id TEXT);
CREATE FUNCTION p16_harness.fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM p16_harness.fail_on WHERE target = 'event' AND instrument_id = NEW.financial_instrument_id::TEXT) THEN
    RAISE EXCEPTION 'HARNESS_EVENT_FAILURE';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p16_harness.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM p16_harness.fail_on WHERE target = 'audit' AND instrument_id = NEW.entity_id) THEN
    RAISE EXCEPTION 'HARNESS_AUDIT_FAILURE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p16_fail_event BEFORE INSERT ON public.financial_instrument_event FOR EACH ROW EXECUTE FUNCTION p16_harness.fail_event();
CREATE TRIGGER p16_fail_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION p16_harness.fail_audit();`);
try {
  const iVa = issue(SUP_V, 900, BANK_V, uniq('X'));
  owner(`INSERT INTO p16_harness.fail_on VALUES ('event', '${iVa}');`);
  snap = snapshot();
  r = ADMIN(`SELECT ${cancelCall(iVa)};`);
  check('V15 state updated + supplier REVERSAL inserted, then the CANCELLED event fails → full rollback (ISSUED, no REVERSAL, no event, no audit)',
    raised(r, 'HARNESS_EVENT_FAILURE') && snapshot() === snap && estado(iVa) === 'ISSUED' && reversalsOf(iVa) === '', firstErr(r));
  const iVb = issue(SUP_V, 800, BANK_V, uniq('X'));
  owner(`DELETE FROM p16_harness.fail_on; INSERT INTO p16_harness.fail_on VALUES ('audit', '${iVb}');`);
  snap = snapshot();
  r = ADMIN(`SELECT ${cancelCall(iVb)};`);
  check('V16 state + REVERSAL + event written, then audit fails → full rollback',
    raised(r, 'HARNESS_AUDIT_FAILURE') && snapshot() === snap && estado(iVb) === 'ISSUED' && events(iVb) === 'ISSUED', firstErr(r));
} finally {
  owner(`DROP SCHEMA IF EXISTS p16_harness CASCADE;`);
}

// G. concurrency — independent sessions
const iVc = issue(SUP_V, 600, BANK_V, uniq('X'));
x = await race('cancel', cancelCall(iVc), cancelCall(iVc), 'p16-cnl');
check('V17 two concurrent cancels: B waited on A\'s row lock, then INVALID_STATE',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'INVALID_STATE'), `${x.aIn}/${x.bWait}/${firstErr(x.ra)}/${firstErr(x.rb)}`);
check('V18 exactly one CANCELLED event, one supplier REVERSAL, zero bank postings',
  events(iVc) === 'ISSUED,CANCELLED' && reversalsOf(iVc).split(';').length === 1 && postingsOf(iVc) === '');
const iVd = issue(SUP_V, 500, BANK_V, uniq('X'));
x = await race('cancel-vs-debit', cancelCall(iVd), debitCall(iVd), 'p16-cvd');
check('V19 cancel vs debit concurrently: the debit waits, then INVALID_STATE; no bank movement',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'INVALID_STATE') && postingsOf(iVd) === '' && estado(iVd) === 'CANCELLED', firstErr(x.rb));

// H. provenance corruption (owner-only synthetic setup)
const iVh1 = issue(SUP_V, 400, BANK_V, uniq('X'));
owner(`DELETE FROM supplier_ledger WHERE movement_type = 'INSTRUMENT_ISSUED' AND source_entity_id = '${iVh1}';`);
snap = snapshot();
r = ADMIN(`SELECT ${cancelCall(iVh1)};`);
check('V20 no original INSTRUMENT_ISSUED row → ISSUANCE_LEDGER_INCONSISTENT, no cancellation effect',
  raised(r, 'ISSUANCE_LEDGER_INCONSISTENT') && snapshot() === snap && estado(iVh1) === 'ISSUED' && reversalsOf(iVh1) === '', firstErr(r));
const iVh2 = issue(SUP_V, 300, BANK_V, uniq('X'));
owner(`INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date, source_entity_type, source_entity_id, reason)
       VALUES ('${SUP_V}', 'INSTRUMENT_ISSUED', -300, '2026-04-10', 'financial_instrument', '${iVh2}', '${TAG} duplicate fixture');`);
snap = snapshot();
r = ADMIN(`SELECT ${cancelCall(iVh2)};`);
check('V21 duplicate matching issuance rows → ISSUANCE_LEDGER_INCONSISTENT, no cancellation effect',
  raised(r, 'ISSUANCE_LEDGER_INCONSISTENT') && snapshot() === snap && estado(iVh2) === 'ISSUED', firstErr(r));
const SUP_V2 = mkSupplier('Proveedor V2');
const iVh3 = issue(SUP_V, 200, BANK_V, uniq('X'));
owner(`UPDATE supplier_ledger SET supplier_id = '${SUP_V2}' WHERE movement_type = 'INSTRUMENT_ISSUED' AND source_entity_id = '${iVh3}';`);
snap = snapshot();
r = ADMIN(`SELECT ${cancelCall(iVh3)};`);
check('V22 issuance row of a different supplier does not count → ISSUANCE_LEDGER_INCONSISTENT',
  raised(r, 'ISSUANCE_LEDGER_INCONSISTENT') && snapshot() === snap && estado(iVh3) === 'ISSUED', firstErr(r));

// I. physical CHECK (owner)
const iVp = issue(SUP_V, 100, BANK_V, uniq('X'));
r = raw(`UPDATE financial_instrument SET estado = 'CANCELLED' WHERE id = '${iVp}';`);
check('V23 CANCELLED without cancelled_date is physically impossible', !r.ok && /chk_instrument_cancelled_coherent/.test(r.err), firstErr(r));
r = raw(`UPDATE financial_instrument SET cancelled_date = '2026-04-19' WHERE id = '${iVp}';`);
check('V24 a non-CANCELLED instrument cannot carry cancelled_date (bidirectional CHECK)', !r.ok && /chk_instrument_cancelled_coherent/.test(r.err), firstErr(r));
r = raw(`UPDATE financial_instrument SET estado = 'CANCELLED', cancelled_date = '2026-04-19' WHERE id = '${iVrec}';`);
check('V25 a received instrument cannot become CANCELLED (chk_instrument_estado_direction)', !r.ok && /chk_instrument_estado_direction/.test(r.err), firstErr(r));

// J. existing state machine refuses CANCELLED
snap = snapshot();
r = ADMIN(`SELECT ${debitCall(iV)};`);
const r12 = ADMIN(`SELECT ${rejectIssuedCall(iV)};`);
check('V26 RPC 11 (debit) and RPC 12 (reject) refuse a CANCELLED instrument with INVALID_STATE, nothing written',
  raised(r, 'INVALID_STATE') && raised(r12, 'INVALID_STATE') && snapshot() === snap, `${firstErr(r)} / ${firstErr(r12)}`);
check('V27 issued lifecycle reaches every frozen state: ISSUED, DEBITED, REJECTED, CANCELLED',
  owner(`SELECT string_agg(DISTINCT event_type::TEXT, ',' ORDER BY event_type::TEXT) FROM financial_instrument_event e
         JOIN financial_instrument i ON i.id = e.financial_instrument_id WHERE i.direction = 'ISSUED';`) === 'CANCELLED,DEBITED,ISSUED,REJECTED');

// ═══════════════════════════════════════════════════════════════════════════
section('U', 'Audit / events / idempotency');

const audCounts = owner(`SELECT (SELECT count(*) FROM financial_instrument_event) = (SELECT count(*) FROM audit_events WHERE entity_type = 'financial_instrument');`);
check('U1 every successful lifecycle step left exactly one event AND one audit row (failed calls left neither)', audCounts === 't');
const audActions = owner(`SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_events WHERE entity_type = 'financial_instrument';`);
check('U2 audit actions: CANCEL_ISSUED, CLEAR, DEBIT, DEPOSIT, ENDORSE, ISSUE, RECEIVE, REJECT, REJECT_ISSUED',
  audActions === 'CANCEL_ISSUED,CLEAR,DEBIT,DEPOSIT,ENDORSE,ISSUE,RECEIVE,REJECT,REJECT_ISSUED', audActions);
const badActor = owner(`SELECT count(*) FROM audit_events WHERE entity_type = 'financial_instrument' AND (performed_by IS DISTINCT FROM '${ADMIN_UID}' OR performed_at IS NULL);`);
check('U3 every instrument audit row names the real actor and a time', badActor === '0', badActor);
const tamper = [ADMIN(`UPDATE audit_events SET reason = 'x' WHERE entity_type = 'financial_instrument';`), ADMIN(`DELETE FROM financial_instrument_event;`)];
check('U4 neither audit_events nor the event trail can be modified by the application', tamper.every(denied));
const nullA = rpc(issueCall(SUP, 10, BANK2, null));
const nullB = rpc(issueCall(SUP, 10, BANK2, null));
check('U5 contract as written: issued external_ref NULL is not deduplicated (carry-forward idempotency decision)',
  nullA.instrument_id !== nullB.instrument_id);
const moneyShape = owner(`SELECT count(*) FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id
  WHERE o.operation_type IN ('CHEQUE_CLEAR','CHEQUE_REJECTION','INSTRUMENT_DEBIT','INSTRUMENT_DEBIT_REVERSAL')
    AND NOT ((o.operation_type = 'CHEQUE_CLEAR' AND p.signed_amount > 0) OR (o.operation_type = 'CHEQUE_REJECTION' AND p.signed_amount < 0)
          OR (o.operation_type = 'INSTRUMENT_DEBIT' AND p.signed_amount < 0) OR (o.operation_type = 'INSTRUMENT_DEBIT_REVERSAL' AND p.signed_amount > 0));`);
const onePosting = owner(`SELECT count(*) FROM (SELECT o.id FROM financial_operation o LEFT JOIN financial_posting p ON p.financial_operation_id = o.id
  WHERE o.operation_type IN ('CHEQUE_CLEAR','CHEQUE_REJECTION','INSTRUMENT_DEBIT','INSTRUMENT_DEBIT_REVERSAL') GROUP BY o.id HAVING count(p.id) <> 1) t;`);
check('U6 every instrument operation has exactly one posting with the frozen sign', moneyShape === '0' && onePosting === '0', `${moneyShape}/${onePosting}`);
} finally {
  cleanup();
}

section('Z', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM financial_account WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM clients WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM suppliers WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM financial_instrument)
  + (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'p16_harness') + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p16_fail_%');`);
check('Z1 all P16-TEST fixtures, instruments, harness schema and triggers removed', left === '0', left);
const closedLeft = owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
check('Z2 periods closed by the suite are OPEN again', closedLeft === '0', closedLeft);

console.log(`\n  ══ INSTRUMENTS RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
