#!/usr/bin/env node
/**
 * LOTE 3B — GASTO PENDIENTE → PROVEEDOR, VENCIMIENTO / FECHA ESTIMADA, CALENDARIO DE PAGOS (migration 0110). LOCAL TEST DATABASE ONLY.
 *
 * assign_payable_to_supplier: earlier partial payments carried without new money (no operation / posting), supplier ledger and
 * invoice pending = total − paid, P&L / IVA / accounts unchanged, idempotency (replay / conflict / second link), atomicity
 * (duplicate invoice, closed period), the old payment route closed, audit, ADMIN only.
 * set_payment_date: DUE vs PLANNED kept apart, reason for a due-date change, no financial effect, audit.
 * fin_payment_calendar: invoices / pending expenses / own cheques once each; cheques allocated to an invoice never duplicate it;
 * a cheque without allocation is SIN_IMPUTAR and never matched to an invoice; debited instruments leave the calendar.
 *
 * Everything runs inside ONE transaction that is rolled back. If 0110 is not in the ledger yet, the migration file itself is
 * executed first INSIDE that transaction (so it is rolled back too). Each call runs in its own subtransaction and is checked
 * as at its own COMMIT (SET CONSTRAINTS ALL IMMEDIATE): a refused call leaves nothing behind.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_payables_supplier_link.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

const FILE = '0110_payables_supplier_link_calendar.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0110-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0110-0000-0000-00000000000b';
const SA = 'bbbbbbbb-0110-0000-0000-0000000000a1';
const SB = 'bbbbbbbb-0110-0000-0000-0000000000b2';
const SX = 'bbbbbbbb-0110-0000-0000-0000000000c3';   // inactive supplier
const CAT = 'cccccccc-0110-0000-0000-0000000000c1';
const CAJA = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo LIMIT 1)`;
const BNA = `(SELECT id FROM financial_account WHERE nombre = 'BNA' AND account_type = 'BANK_ACCOUNT')`;
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved as the owner before the role switch

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);

const FISCAL = (n) => ({ document_type: 'INVOICE_A', document_date: '2026-10-05', fiscal_period: '2026-10-01', net_amount: 100000, total_amount: 121000,
  external_number: `0003-0000${n}`, issuer_tax_id: '30712345678', issuer_name: 'Estación 0110',
  components: [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 100000, rate_applied: 21, tax_amount: 21000 }] });
const pending = (key, date, total, { due = null, fiscal = null, name = 'Estación 0110' } = {}) =>
  `SELECT register_pending_expense(${lit(date)}::date, ${fiscal ? fiscal.net_amount : total}, ${total}, '${CAT}'::uuid, 'Gasoil 0110', 'OPERATING', ${lit(key)}, `
  + `${due ? `${lit(due)}::date` : 'NULL'}, ${lit(name)}, '[]'::jsonb, '[]'::jsonb, ${fiscal ? `${lit(JSON.stringify(fiscal))}::jsonb` : 'NULL'})::text`;
const payPending = (payable, amount, date, acc, method, key) =>
  `SELECT pay_pending_expense(${P(payable)}::uuid, ${amount}, ${lit(date)}::date, ${P(acc)}::uuid, '${method}'::payment_method, ${lit(key)})::text`;
const link = (payable, supplier, reason, key, invoice = null) =>
  `SELECT assign_payable_to_supplier(${P(payable)}::uuid, ${lit(supplier)}::uuid, ${lit(reason)}, ${lit(key)}, ${lit(invoice)})::text`;
const setDate = (purchase, kind, date, reason = null) =>
  `SELECT set_payment_date(${P(purchase)}::uuid, ${lit(kind)}, ${date ? `${lit(date)}::date` : 'NULL'}, ${lit(reason)})::text`;
const PAYABLE = (k) => RES(k, 'payable_id');
const NEWP = RES('l1', 'purchase_id');
const ROOT1 = RES('g1', 'purchase_id');

const TABLES = ['purchases', 'purchase_line', 'supplier_ledger', 'financial_operation', 'financial_posting', 'expense_payable', 'expense_payable_payment',
  'expense_payable_supplier_link', 'purchase_payment_allocation', 'purchase_payment_date', 'financial_instrument', 'fiscal_document', 'fiscal_obligation',
  'audit_events'];
const counts = () => TABLES.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const snap = (name) => add(`CREATE TEMP TABLE ${name} AS ${counts()};`);
const delta = (name) => `(SELECT coalesce(string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t), 'none') FROM (${counts()}) c JOIN ${name} b ON b.t = c.t WHERE c.n <> b.n)`;
const SLB = (s) => `(SELECT coalesce(sum(signed_amount), 0) FROM supplier_ledger WHERE supplier_id = '${s}')`;
const ACB = (acc) => `(SELECT coalesce(sum(signed_amount), 0) FROM financial_posting WHERE financial_account_id = ${acc})`;
// the P&L by its figures (bucket, date, category, nature, amount); the source id / description follow the purchase version
const PNL = `(SELECT md5(coalesce(string_agg(x, '#' ORDER BY x), '')) FROM (SELECT bucket || '|' || business_date || '|' || coalesce(expense_category_id::text, '') || '|' || coalesce(nature::text, '') || '|' || sum(signed_amount) AS x FROM pnl_line_item GROUP BY bucket, business_date, expense_category_id, nature) q)`;
const IVA = `(SELECT coalesce(sum(credit_amount), 0) FROM report_fiscal_period WHERE period = '2026-10-01' AND tax_kind = 'IVA')`;
const CAL = (where, cols) => `(SELECT coalesce(string_agg(${cols}, ';' ORDER BY item_kind, amount), 'none') FROM fin_payment_calendar WHERE ${where})`;

// ── harness ─────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0110')) AS has_0110 \\gset
\\if :has_0110
\\else
\\i /tmp/${FILE}
\\endif
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
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
    EXECUTE p_sql INTO v;
    RESET ROLE;
    SET CONSTRAINTS ALL IMMEDIATE;   -- the call as at its own COMMIT
    SET CONSTRAINTS ALL DEFERRED;
    ok := true;
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'lote3b-0110-admin@test.local', 'ADMIN'), ('${OPER}', 'lote3b-0110-oper@test.local', 'OPERATOR');
INSERT INTO suppliers (id, nombre) VALUES ('${SA}', 'Proveedor 0110 A'), ('${SB}', 'Proveedor 0110 B');
INSERT INTO suppliers (id, nombre, activo) VALUES ('${SX}', 'Proveedor 0110 inactivo', false);
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES ('${CAT}', 'Categoría 0110', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));`);

// ── fixtures: real pending expenses and real partial payments (0106 RPCs) ──
expect('fixture G1: pending expense 121.000 with invoice A (IVA 21.000), due 2026-10-30', ADM(pending('T0110-G1', '2026-10-05', 121000, { due: '2026-10-30', fiscal: FISCAL(1) }), 'g1'), 'OK:%');
expect('fixture G1 partial payment 30.000 cash 2026-10-10', ADM(payPending(PAYABLE('g1'), 30000, '2026-10-10', CAJA, 'CASH', 'T0110-P1'), 'p1'), 'OK:%');
expect('fixture G1 partial payment 20.000 bank 2026-10-12', ADM(payPending(PAYABLE('g1'), 20000, '2026-10-12', BNA, 'TRANSFER', 'T0110-P2'), 'p2'), 'OK:%');
expect('fixture G2: pending expense 5.000, paid in full', `(${ADM(pending('T0110-G2', '2026-10-06', 5000), 'g2')} || ${ADM(payPending(PAYABLE('g2'), 5000, '2026-10-07', CAJA, 'CASH', 'T0110-P3'))})`, 'OK:%OK:%');
expect('fixture G3: pending expense 8.000 (its invoice number will collide)', ADM(pending('T0110-G3', '2026-10-06', 8000), 'g3'), 'OK:%');
expect('fixture G4: pending expense 9.000 dated 2026-09-20 (period closed below)', ADM(pending('T0110-G4', '2026-09-20', 9000), 'g4'), 'OK:%');
expect('fixture G5: pending expense 7.000 without due date', ADM(pending('T0110-G5', '2026-10-08', 7000, { name: null }), 'g5'), 'OK:%');
expect('fixture: supplier A invoice B-0001-00000042 (register_purchase, 10.000)',
  ADM(`SELECT register_purchase('${SA}'::uuid, '2026-10-02'::date, 10000, 10000, '${CAT}'::uuid, NULL, 'OPERATING', '[{"producto_id":null,"feed_ingredient_id":null,"descripcion":"x","cantidad":1,"unit_type":"UNIT","precio_unitario":10000}]'::jsonb, '[]'::jsonb, 'T0110-SAP1', NULL, NULL, 'B-0001-00000042', NULL, 'fixture')::text`, 'sap1'), 'OK:%');
add(`CREATE TEMP TABLE b0 AS SELECT ${SLB(SA)} AS sa, ${ACB(CAJA)} AS caja, ${ACB(BNA)} AS bna, ${PNL} AS pnl, ${IVA} AS iva,
  (SELECT fiscal_document_id FROM purchases WHERE idempotency_key = 'T0110-G1') AS fd;`);

// ── permissions and input ───────────────────────────────────────────────────
snap('s0');
expect('A-1 OPERATOR cannot link → FORBIDDEN', as('authenticated', OPER, link(PAYABLE('g1'), SA, 'x', 'T0110-L0')), 'ERR:FORBIDDEN%');
expect('A-2 anon has no EXECUTE on assign_payable_to_supplier / set_payment_date',
  `(NOT has_function_privilege('anon', 'assign_payable_to_supplier(uuid,uuid,text,varchar,varchar)', 'EXECUTE') AND NOT has_function_privilege('anon', 'set_payment_date(uuid,text,date,text)', 'EXECUTE'))::text`, 'true');
expect('A-3 reason required', ADM(link(PAYABLE('g1'), SA, '  ', 'T0110-L0')), 'ERR:REASON_REQUIRED%');
expect('A-4 inactive supplier refused', ADM(link(PAYABLE('g1'), SX, 'factura llegó', 'T0110-L0')), 'ERR:SUPPLIER_NOT_FOUND_OR_INACTIVE%');
expect('A-5 unknown obligation refused', ADM(`SELECT assign_payable_to_supplier(gen_random_uuid(), '${SA}'::uuid, 'x', 'T0110-L0')::text`), 'ERR:PAYABLE_NOT_FOUND%');
expect('A-6 a fully paid obligation is not linked', ADM(link(PAYABLE('g2'), SA, 'x', 'T0110-L0')), 'ERR:PAYABLE_SETTLED%');
expect('A-7 refusals left nothing', delta('s0'), 'none');

// ── LINK G1 (121.000, paid 50.000 in two payments) → supplier A ────────────
snap('s1');
expect('B-0 an invoice number different from the one the expense already has → INVOICE_NUMBER_MISMATCH', ADM(link(PAYABLE('g1'), SA, 'x', 'T0110-L0', 'A-0003-00000001')), 'ERR:INVOICE_NUMBER_MISMATCH%');
expect('B-1 link G1 → supplier A (its invoice 0003-00001 is kept, key T0110-L1)', ADM(link(PAYABLE('g1'), SA, 'La factura es del Proveedor A', 'T0110-L1'), 'l1'),
  'OK:%"pending": 71000%"replayed": false%');
expect('B-2 rows written: 1 purchase version + its line set, 1 PURCHASE + 2 PAYMENT on the supplier, 2 allocations, 1 link, 1 audit; NO operation / posting / payment / fiscal row',
  delta('s1'), 'audit_events=1,expense_payable_supplier_link=1,purchase_payment_allocation=2,purchases=1,supplier_ledger=3');
expect('B-3 supplier A balance +71.000 (121.000 − 30.000 − 20.000)', `(${SLB(SA)} - (SELECT sa FROM b0))`, '71000.00');
expect('B-4 supplier ledger: PURCHASE at the expense date, each PAYMENT at its own payment date, pointing to the existing payment',
  `(SELECT string_agg(movement_type || ':' || signed_amount || ':' || effective_date || ':' || source_entity_type, ',' ORDER BY id) FROM supplier_ledger WHERE supplier_id = '${SA}' AND source_entity_type IN ('purchases', 'expense_payable_payment') AND id > (SELECT max(id) - 3 FROM supplier_ledger))`,
  'PURCHASE:121000.00:2026-10-05:purchases,PAYMENT:-30000.00:2026-10-10:expense_payable_payment,PAYMENT:-20000.00:2026-10-12:expense_payable_payment');
expect('B-5 invoice status (fin_purchase_payment_status): total 121.000, other payments 50.000, pending 71.000',
  `(SELECT supplier_invoice_number || ':' || amount_total || ':' || other_payments || ':' || pending FROM fin_purchase_payment_status WHERE purchase_id::text = ${NEWP})`,
  '0003-00001:121000.00:50000.00:71000.00');
expect('B-6 the new version keeps the chain root, date, category, amounts and the SAME fiscal document; the old one is retired',
  `(SELECT (purchase_chain_root(n.id)::text = ${ROOT1}) || ':' || n.economic_date || ':' || (n.expense_category_id = '${CAT}') || ':' || n.amount_net || ':' || n.amount_total || ':' || (n.fiscal_document_id = (SELECT fd FROM b0)) || ':' || n.version_seq || ':' || (SELECT is_current FROM purchases WHERE id::text = ${ROOT1}) FROM purchases n WHERE n.id::text = ${NEWP})`,
  'true:2026-10-05:true:100000.00:121000.00:true:1:false');
expect('B-7 P&L figures unchanged (bucket / date / category / nature / amount)', `(${PNL} = (SELECT pnl FROM b0))::text`, 'true');
expect('B-8 IVA crédito of October unchanged (the invoice is counted once)', `(${IVA} = (SELECT iva FROM b0))::text`, 'true');
expect('B-9 cash and bank unchanged', `(${ACB(CAJA)} = (SELECT caja FROM b0) AND ${ACB(BNA)} = (SELECT bna FROM b0))::text`, 'true');
expect('B-10 the obligation left "Gastos sin proveedor" (fin_expense_payables) and its payments history is kept',
  `((SELECT count(*) FROM fin_expense_payables WHERE payable_id::text = ${PAYABLE('g1')}) || ':' || (SELECT count(*) || '/' || sum(amount) FROM fin_expense_payable_payments WHERE payable_id::text = ${PAYABLE('g1')}))`, '0:2/50000.00');
expect('B-11 audit LINK_SUPPLIER by the ADMIN, with the reason and before / after',
  `(SELECT performed_by || ':' || reason || ':' || (before_values ->> 'counterparty_name') || ':' || (after_values ->> 'pending') FROM audit_events WHERE action = 'LINK_SUPPLIER' AND entity_id = ${PAYABLE('g1')})`,
  `${ADMIN}:La factura es del Proveedor A:Estación 0110:71000%`);

// ── idempotency and the old route ───────────────────────────────────────────
snap('s2');
expect('C-1 replay of the same key → replayed, same purchase', `((${ADM(link(PAYABLE('g1'), SA, 'otra', 'T0110-L1'))} LIKE '%"replayed": true%') || ':' || (${ADM(link(PAYABLE('g1'), SA, 'otra', 'T0110-L1'))} LIKE ('%' || ${NEWP} || '%')))`, 'true:true');
expect('C-2 the same key for another supplier → IDEMPOTENCY_CONFLICT', ADM(link(PAYABLE('g1'), SB, 'x', 'T0110-L1')), 'ERR:IDEMPOTENCY_CONFLICT%');
expect('C-3 another key for the same obligation → PAYABLE_ALREADY_LINKED', ADM(link(PAYABLE('g1'), SB, 'x', 'T0110-L2')), 'ERR:PAYABLE_ALREADY_LINKED%');
expect('C-4 pay_pending_expense on the linked obligation → PAYABLE_LINKED_TO_SUPPLIER', ADM(payPending(PAYABLE('g1'), 1000, '2026-10-20', CAJA, 'CASH', 'T0110-P9')), 'ERR:PAYABLE_LINKED_TO_SUPPLIER%');
expect('C-5 nothing written by replays / refusals (no operation or posting left by the refused payment)', delta('s2'), 'none');

// ── atomicity ───────────────────────────────────────────────────────────────
snap('s3');
expect('D-1 G3 with an invoice number the supplier already has → DUPLICATE_INVOICE', ADM(link(PAYABLE('g3'), SA, 'x', 'T0110-L3', 'B-0001-00000042')), 'ERR:DUPLICATE_INVOICE%');
add(`SET LOCAL session_replication_role = replica;
UPDATE management_period SET status = 'CLOSED', closed_at = now(), closed_by = '${ADMIN}' WHERE periodo_fecha = '2026-09-01';
SET LOCAL session_replication_role = origin;`);
expect('D-2 G4 dated in a closed period → PERIOD_CLOSED', ADM(link(PAYABLE('g4'), SA, 'x', 'T0110-L4')), 'ERR:PERIOD_CLOSED%');
expect('D-3 both refusals left nothing; G3 / G4 are still pending expenses without supplier',
  `(${delta('s3')} || ':' || (SELECT count(*) FROM fin_expense_payables WHERE payable_id::text IN (${PAYABLE('g3')}, ${PAYABLE('g4')})))`, 'none:2');

// ── due date / estimated payment date ───────────────────────────────────────
snap('s4');
expect('E-1 the linked invoice keeps its due date (2026-10-30, from the obligation)', `payment_date_current(${ROOT1}::uuid, 'DUE')`, '2026-10-30');
expect('E-2 changing an existing due date without a reason → REASON_REQUIRED', ADM(setDate(NEWP, 'DUE', '2026-11-10')), 'ERR:REASON_REQUIRED%');
expect('E-3 with a reason → OK', ADM(setDate(NEWP, 'DUE', '2026-11-10', 'el proveedor dio 40 días')), 'OK:%"previous": "2026-10-30"%');
expect('E-4 estimated payment date 2026-11-05 (no reason needed)', ADM(setDate(NEWP, 'PLANNED', '2026-11-05')), 'OK:%');
expect('E-5 same estimated date again → replayed, no row', `(${ADM(setDate(NEWP, 'PLANNED', '2026-11-05'))} LIKE '%"replayed": true%')::text`, 'true');
expect('E-6 the two dates are independent', `(payment_date_current(${ROOT1}::uuid, 'DUE') || '/' || payment_date_current(${ROOT1}::uuid, 'PLANNED'))`, '2026-11-10/2026-11-05');
expect('E-7 a due date cannot be cleared; a date before the expense date is refused; OPERATOR refused',
  `(${ADM(setDate(NEWP, 'DUE', null, 'x'))} || '|' || ${ADM(setDate(NEWP, 'PLANNED', '2026-09-01'))} || '|' || ${as('authenticated', OPER, setDate(NEWP, 'PLANNED', '2026-11-20'))})`,
  'ERR:INVALID_PAYMENT_DATE%|ERR:INVALID_PAYMENT_DATE%|ERR:FORBIDDEN%');
expect('E-8 a pending expense without supplier: first due date set without reason; estimated date set then cleared',
  `(${ADM(setDate(RES('g5', 'purchase_id'), 'DUE', '2026-11-30'))} || '|' || ${ADM(setDate(RES('g5', 'purchase_id'), 'PLANNED', '2026-10-25'))} || '|' || ${ADM(setDate(RES('g5', 'purchase_id'), 'PLANNED', null))})`,
  'OK:%|OK:%|OK:%');
expect('E-9 rows: 5 date rows + 5 audits; NO operation / posting (a date never moves money, even a past one)', delta('s4'), 'audit_events=5,purchase_payment_date=5');
expect('E-10 audit of a due-date change: before / after / reason',
  `(SELECT (before_values ->> 'value') || '>' || (after_values ->> 'value') || ':' || reason FROM audit_events WHERE action = 'SET_DUE_DATE' AND entity_id = ${ROOT1} ORDER BY id DESC LIMIT 1)`,
  '2026-10-30>2026-11-10:el proveedor dio 40 días');

expect('E-11 the read models show the dates in force (fin_purchase_payment_status / fin_expense_payables)',
  `((SELECT due_date || '/' || planned_date FROM fin_purchase_payment_status WHERE purchase_id::text = ${NEWP}) || '|' || (SELECT due_date || '/' || coalesce(planned_date::text, '-') FROM fin_expense_payables WHERE payable_id::text = ${PAYABLE('g5')}))`,
  '2026-11-10/2026-11-05|2026-11-30/-');

// ── calendar ────────────────────────────────────────────────────────────────
expect('F-1 the linked invoice: FACTURA 71.000, due 2026-11-10, estimated 2026-11-05, CONFIRMADO',
  CAL(`item_id = ${NEWP}`, `item_kind || ':' || amount || ':' || due_date || ':' || planned_date || ':' || link_status`), 'FACTURA:71000.00:2026-11-10:2026-11-05:CONFIRMADO');
expect('F-2 a pending expense without supplier: GASTO, its due date, estimated date cleared',
  CAL(`item_id = ${PAYABLE('g5')}`, `item_kind || ':' || amount || ':' || coalesce(due_date::text, '-') || ':' || coalesce(planned_date::text, '-')`), 'GASTO:7000.00:2026-11-30:-');
expect('F-3 a pending expense without any date is listed (sin fecha)', CAL(`item_id = ${PAYABLE('g3')}`, `item_kind || ':' || coalesce(due_date::text, 'sin fecha')`), 'GASTO:sin fecha');
expect('F-4 a paid obligation is not in the calendar', CAL(`item_id = ${PAYABLE('g2')}`, 'item_kind'), 'none');
snap('s5');
expect('F-5 an eCheq of 40.000 for the linked invoice (issue_purchase_instruments)',
  ADM(`SELECT issue_purchase_instruments(${P(NEWP)}::uuid, jsonb_build_array(jsonb_build_object('instrument_type', 'ECHEQ', 'cheque_number', 'E-0110-1', 'amount', 40000,
    'maturity_date', '2026-11-15', 'issued_date', '2026-10-20', 'bank_account_id', ${P(BNA)})), 'T0110-EQ1')::text`), 'OK:%');
expect('F-6 no duplicate: FACTURA 31.000 + ECHEQ IMPUTADO 40.000 = supplier balance of that obligation (71.000)',
  CAL(`supplier_id = '${SA}' AND (item_id = ${NEWP} OR link_status = 'IMPUTADO')`, `item_kind || ':' || amount || ':' || link_status`), 'ECHEQ:40000.00:IMPUTADO;FACTURA:31000.00:CONFIRMADO');
expect('F-7 the eCheq moved no money (scheduled payment)', `(${ACB(BNA)} = (SELECT bna FROM b0))::text`, 'true');
expect('F-8 a cheque of 10.000 to supplier A WITHOUT allocation (issue_supplier_instrument)',
  ADM(`SELECT issue_supplier_instrument('${SA}'::uuid, 'CHEQUE', 'C-0110-9', 10000, '2026-11-25'::date, '2026-10-21'::date, ${P(BNA)}::uuid, 'T0110-CH9', 'sin imputar')::text`, 'ch9'), 'OK:%');
expect('F-9 it is SIN_IMPUTAR and the invoices keep their pending (never matched to an older invoice)',
  `(${CAL(`item_id = ${RES('ch9', 'instrument_id')}`, `item_kind || ':' || amount || ':' || link_status || ':' || coalesce(purchase_root_id::text, 'sin factura')`)} || '|' || ${CAL(`supplier_id = '${SA}' AND item_kind = 'FACTURA'`, `document_number || ':' || amount`)})`,
  'CHEQUE:10000.00:SIN_IMPUTAR:sin factura|B-0001-00000042:10000.00;0003-00001:31000.00');
expect('F-10 debiting the eCheq (mark_supplier_instrument_debited)',
  ADM(`SELECT mark_supplier_instrument_debited(${P(`(SELECT id FROM financial_instrument WHERE cheque_number = 'E-0110-1')`)}::uuid, '2026-11-15'::date, 'debitado')::text`), 'OK:%');
expect('F-11 a debited instrument is a real movement: out of the calendar', CAL(`item_kind = 'ECHEQ' AND document_number = 'E-0110-1'`, 'item_kind'), 'none');

// ── immutability and privileges ─────────────────────────────────────────────
expect('G-1 the link and the dates are append-only',
  `(SELECT string_agg(r, '|') FROM (SELECT ${ADM(`UPDATE expense_payable_supplier_link SET reason = 'x' RETURNING 'x'`)} AS r UNION ALL SELECT ${ADM(`UPDATE purchase_payment_date SET value = NULL RETURNING 'x'`)}) q)`,
  'ERR:%|ERR:%');
expect('G-2 an authenticated user cannot write the new tables directly',
  `(NOT has_table_privilege('authenticated', 'expense_payable_supplier_link', 'INSERT') AND NOT has_table_privilege('authenticated', 'purchase_payment_date', 'INSERT'))::text`, 'true');
expect('G-3 OPERATOR reads no link / date / calendar row (RLS: 0 rows)',
  as('authenticated', OPER, `SELECT ((SELECT count(*) FROM expense_payable_supplier_link) + (SELECT count(*) FROM purchase_payment_date) + (SELECT count(*) FROM fin_payment_calendar))::text`), 'OK:0');

add('ROLLBACK;');

// ── run (rolled back) on the container behind the guarded local URL ─────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const containers = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean);
const container = containers.find((c) => (dockerRun(['port', c, '5432/tcp']).stdout || '').includes(`:${target.port}`));
if (!container) { console.error(`  no running supabase_db container mapped to the guarded port ${target.port}. Run \`supabase start\`.`); process.exit(1); }
console.log(`  container: ${container}`);
const cp = dockerRun(['exec', '-i', container, 'sh', '-c', `cat > /tmp/${FILE}`], readFileSync(MIGRATION, 'utf8'));
if (cp.status !== 0) { console.error('  could not copy the migration into the container'); process.exit(1); }
const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.replace(/^.*NOTICE:\s*/, '')).filter((l) => /^(PASS|FAIL) /.test(l));
for (const l of lines) console.log(`    ${l.startsWith('PASS') ? 'OK ' : 'MAL'}  ${l.slice(5)}`);
const pass = lines.filter((l) => l.startsWith('PASS')).length;
const fail = lines.length - pass;
if (r.status !== 0) {
  console.log(`    MAL  psql aborted: ${(`${r.stdout}\n${r.stderr}`.split('\n').find((l) => /ERROR/.test(l)) || '').slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n  ${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);
