#!/usr/bin/env node
/**
 * 0117 — GASTOS: NUEVO GASTO PAGADO A UN PROVEEDOR Y RECTIFICACIÓN AUDITADA. LOCAL TEST DATABASE ONLY. Synthetic values.
 *
 *   P. register_paid_supplier_purchase: ADMIN only; Mercado Pago and a wrong account refused; one purchase + ONE payment on the real
 *      payment date + its allocation (the invoice is paid, the supplier owes nothing); replay; fiscal variant; duplicate invoice.
 *   R. rectify_purchase_details: every field of a pending invoice (new version, supplier ledger rebooked, audit before / after,
 *      history by chain root); supplier change; the locks of allocated invoices, fiscal documents, paid expenses without supplier,
 *      pending expenses; adding the missing invoice; the old rectify_purchase can no longer go below what is allocated.
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_expense_rectify.test.mjs
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
const dockerRun = (args, input) => {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker: ${r.error.message}`);
  return r;
};

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0117-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0117-0000-0000-00000000000b';
const BANK = 'bbbbbbbb-0117-0000-0000-0000000000a1';
const CASH = 'bbbbbbbb-0117-0000-0000-0000000000c1';
const S1 = 'dddddddd-0117-0000-0000-000000000001';
const S2 = 'dddddddd-0117-0000-0000-000000000002';
const MP = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const CAT = `(SELECT id FROM expense_category WHERE activo AND group_id IS NOT NULL ORDER BY nombre LIMIT 1)`;
const CAT2 = `(SELECT id FROM expense_category WHERE activo AND group_id IS NOT NULL ORDER BY nombre OFFSET 1 LIMIT 1)`;
const Y = '2033';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const A = (q, key = null) => as('authenticated', ADMIN, q, key);
const O = (q) => as('authenticated', OPER, q);
const CUR = (key) => `(SELECT p.id FROM purchases p WHERE p.is_current AND purchase_chain_root(p.id) = (SELECT id FROM purchases WHERE idempotency_key = '${key}'))`;
const ROOT = (key) => `(SELECT id FROM purchases WHERE idempotency_key = '${key}')`;
const BAL = (s) => `(SELECT coalesce(sum(signed_amount), 0)::text FROM supplier_ledger WHERE supplier_id = '${s}')`;
const MONEY = ['financial_operation', 'financial_posting', 'purchase_payment_allocation', 'supplier_ledger', 'fiscal_document', 'purchases', 'audit_events'];
const counts = () => MONEY.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const delta = (snap) => `coalesce((SELECT string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t) FROM (${counts()}) c JOIN ${snap} b ON b.t = c.t WHERE c.n <> b.n), 'none')`;
const paid = (args) => `SELECT register_paid_supplier_purchase(${args})::text`;
const rect = (key, o = {}) => {
  const v = { concept: 'Maíz', cat: CAT, nature: 'OPERATING', date: `${Y}-10-10`, supplier: `'${S1}'`, invoice: 'NULL', total: 1000, net: 1000, reason: "'corrección'", fiscal: 'NULL', ...o };
  return `SELECT rectify_purchase_details(${CUR(key)}, ${lit(v.concept)}, ${v.cat}, '${v.nature}', '${v.date}', ${v.supplier}::uuid, ${v.invoice}, ${v.total}, ${v.net}, ${v.reason}, ${v.fiscal})::text`;
};
const FISCAL = (net, total, extra = '') => `jsonb_build_object('document_type', 'INVOICE_A', 'fiscal_period', '${Y}-10-01', 'net_amount', ${net}, 'total_amount', ${total},
  'components', jsonb_build_array(jsonb_build_object('tax_kind', 'IVA', 'direction', 'CREDITO', 'base_amount', ${net}, 'rate_applied', 21, 'tax_amount', ${total - net}))${extra})`;

add(`\\set ON_ERROR_STOP 1
BEGIN;
CREATE TEMP TABLE res (k TEXT PRIMARY KEY, v TEXT);
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT, p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; msg TEXT; ok BOOLEAN := false;
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
                                                  ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
    EXECUTE p_sql INTO v;
    ok := true;
    RESET ROLE;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    RESET ROLE;
  END;
  IF ok AND p_key IS NOT NULL THEN
    INSERT INTO res VALUES (p_key, v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
  END IF;
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || msg END;
END $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN
    RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, left(p_got, 400), p_like;
  ELSE
    RAISE NOTICE 'PASS %', p_name;
  END IF;
END $f$;
CREATE FUNCTION pg_temp.must(p_name TEXT, p_got TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE 'OK:%' THEN RAISE NOTICE 'FAIL setup % :: %', p_name, left(p_got, 300); END IF;
END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'gastos-0117-admin@test.local', 'ADMIN'), ('${OPER}', 'gastos-0117-oper@test.local', 'OPERATOR');
INSERT INTO financial_account (id, nombre, account_type) VALUES ('${BANK}', 'ZZ Banco 0117', 'BANK_ACCOUNT'), ('${CASH}', 'ZZ Caja 0117', 'CASH');
INSERT INTO suppliers (id, nombre) VALUES ('${S1}', 'ZZ Proveedor 0117 A'), ('${S2}', 'ZZ Proveedor 0117 B');
INSERT INTO management_period (periodo_fecha, status) VALUES ('${Y}-09-01', 'OPEN'), ('${Y}-10-01', 'OPEN'), ('${Y}-11-01', 'OPEN')
  ON CONFLICT (periodo_fecha) DO UPDATE SET status = 'OPEN';`);

// ── P. a supplier expense recorded already paid ──
const P = (key, o = {}) => {
  const v = { supplier: S1, date: `${Y}-10-01`, total: 1000, method: 'CASH', acc: `'${CASH}'`, pdate: `${Y}-10-03`, invoice: 'NULL', fiscal: 'NULL', ...o };
  return paid(`'${v.supplier}', '${v.date}', ${v.total}, ${CAT}, 'Maíz', 'OPERATING', '${key}', '${v.pdate}', '${v.method}', ${v.acc}, ${v.invoice}, '[]'::jsonb, ${v.fiscal}, 'prueba 0117'`);
};
expect('P-1 OPERATOR: refused', O(P('PSP-0117-X')), 'ERR:FORBIDDEN%');
expect('P-2 Mercado Pago: refused (classified from its movement)', A(P('PSP-0117-X', { method: 'MERCADOPAGO', acc: MP })), 'ERR:INVALID_PAYMENT_METHOD%');
expect('P-3 cash from a bank account: refused', A(P('PSP-0117-X', { acc: `'${BANK}'` })), 'ERR:INVALID_PAYMENT_ACCOUNT%');
expect('P-4 no concept: refused', A(paid(`'${S1}', '${Y}-10-01', 1000, ${CAT}, ' ', 'OPERATING', 'PSP-0117-X', '${Y}-10-03', 'CASH', '${CASH}'`)), 'ERR:CONCEPT_REQUIRED%');
add(`CREATE TEMP TABLE s1 AS ${counts()};`);
expect('P-5 recorded: the purchase, one payment and its allocation', A(P('PSP-0117-1')), 'OK:%"replayed": false%');
expect('P-6 what it wrote', delta('s1'), 'audit_events=2,financial_operation=1,financial_posting=1,purchase_payment_allocation=1,purchases=1,supplier_ledger=2');
expect('P-7 the money left the cash account once, on the real payment date',
  `(SELECT string_agg(p.signed_amount || '@' || p.effective_date, ',') FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id WHERE o.external_ref = 'GASTO-PAGADO:PSP-0117-1')`, `-1000.00@${Y}-10-03`);
expect('P-8 the invoice is paid', A(`SELECT pending || '|' || other_payments FROM fin_purchase_payment_status WHERE purchase_id = ${CUR('PSP-0117-1')}`), 'OK:0.00|1000.00');
expect('P-8b the supplier owes nothing; the concept is kept', `${BAL(S1)} || '|' || (SELECT subcategory FROM purchases WHERE idempotency_key = 'PSP-0117-1')`, '0.00|Maíz');
add(`CREATE TEMP TABLE s2 AS ${counts()};`);
expect('P-9 replay: the recorded result, nothing new', A(P('PSP-0117-1')), 'OK:%"replayed": true%');
expect('P-10 the replay wrote nothing', delta('s2'), 'none');
expect('P-11 with its invoice A: the fiscal document is recorded once', A(P('PSP-0117-2', { total: 1210, invoice: "'0001-00000001'", fiscal: FISCAL(1000, 1210) })), 'OK:%"fiscal_document_id": "%');
expect('P-12 the same invoice number again: refused, nothing paid', A(P('PSP-0117-3', { total: 1210, invoice: "'0001-00000001'" })), 'ERR:DUPLICATE_SUPPLIER_INVOICE%');
expect('P-13 the refused one left no payment', `(SELECT count(*)::text FROM financial_operation WHERE external_ref = 'GASTO-PAGADO:PSP-0117-3')`, '0');

// ── R. audited rectification ──
add(`SELECT pg_temp.must('pending invoice', ${A(`SELECT register_purchase('${S1}', '${Y}-10-10', 1000, 1000, ${CAT}, 'Maíz', 'OPERATING', '[]'::jsonb, '[]'::jsonb, 'RP-0117-1', NULL, NULL, NULL, NULL, 'factura pendiente')::text`)});`);
expect('R-1 OPERATOR: refused', O(rect('RP-0117-1', { concept: 'Otro' })), 'ERR:FORBIDDEN%');
expect('R-2 no reason: refused', A(rect('RP-0117-1', { concept: 'Otro', reason: "' '" })), 'ERR:REASON_REQUIRED%');
expect('R-3 nothing changed: refused', A(rect('RP-0117-1')), 'ERR:NOTHING_TO_RECTIFY%');
add(`CREATE TEMP TABLE s3 AS ${counts()};`);
expect('R-4 concept, category, nature, date and amount corrected', A(rect('RP-0117-1', { concept: 'Maíz partido', cat: CAT2, nature: 'REINVESTMENT', date: `${Y}-10-12`, total: 1200, net: 1200 })), 'OK:%"supplier_ledger_rebooked": true%');
expect('R-5 a new version (the old one kept as history), the debt rebooked, one audit row', delta('s3'), 'audit_events=1,purchases=1,supplier_ledger=2');
expect('R-6 the current version carries every corrected value',
  `(SELECT subcategory || '|' || (expense_category_id = ${CAT2}) || '|' || nature || '|' || economic_date || '|' || amount_total || '|' || version_seq FROM purchases WHERE id = ${CUR('RP-0117-1')})`,
  `Maíz partido|true|REINVESTMENT|${Y}-10-12|1200.00|1`);
expect('R-7 the supplier now owes the corrected amount', BAL(S1), '1200.00');
expect('R-8 the audit keeps who, why, before and after',
  `(SELECT action || '|' || reason || '|' || (performed_by = '${ADMIN}') || '|' || (before_values ->> 'amount_total') || '>' || (after_values ->> 'amount_total') || '|' || (before_values ->> 'concept') || '>' || (after_values ->> 'concept') || '|' || (before_values ->> 'economic_date') || '>' || (after_values ->> 'economic_date') FROM audit_events WHERE action = 'RECTIFY_DETAILS' AND entity_id = ${ROOT('RP-0117-1')}::text)`,
  `RECTIFY_DETAILS|corrección|true|1000.00>1200|Maíz>Maíz partido|${Y}-10-10>${Y}-10-12`);
expect('R-9 a second correction: the supplier', A(rect('RP-0117-1', { concept: 'Maíz partido', cat: CAT2, nature: 'REINVESTMENT', date: `${Y}-10-12`, supplier: `'${S2}'`, total: 1200, net: 1200 })), 'OK:%');
expect('R-9b the old supplier owes nothing, the new one the amount', `${BAL(S1)} || '|' || ${BAL(S2)}`, '0.00|1200.00');
expect('R-10 the history of the expense: both rectifications by its chain root, newest last',
  A(`SELECT string_agg(action, ',' ORDER BY audit_id) FROM fin_purchase_audit WHERE purchase_root_id = ${ROOT('RP-0117-1')} AND action = 'RECTIFY_DETAILS'`), 'OK:RECTIFY_DETAILS,RECTIFY_DETAILS');
expect('R-11 OPERATOR: no history', O(`SELECT count(*)::text FROM fin_purchase_audit WHERE purchase_root_id = ${ROOT('RP-0117-1')}`), 'OK:0');
expect('R-12 an invoice number already used by that supplier: refused', A(rect('PSP-0117-1', { invoice: "'0001-00000001'", date: `${Y}-10-01` })), 'ERR:%');
// the paid invoice (allocated payment)
expect('R-13 allocated invoice: no supplier change', A(rect('PSP-0117-1', { date: `${Y}-10-01`, supplier: `'${S2}'` })), 'ERR:PURCHASE_HAS_PAYMENTS%');
expect('R-14 allocated invoice: never below what is allocated', A(rect('PSP-0117-1', { date: `${Y}-10-01`, total: 900, net: 900 })), 'ERR:OVER_ALLOCATION%');
expect('R-15 allocated invoice: its date can be corrected', A(rect('PSP-0117-1', { date: `${Y}-10-02` })), 'OK:%');
expect('R-15b it stays paid, the supplier owes nothing for it', A(`SELECT pending || '|' || economic_date FROM fin_purchase_payment_status WHERE purchase_id = ${CUR('PSP-0117-1')}`), `OK:0.00|${Y}-10-02`);
expect('R-16 the old rectify_purchase can no longer go below what is allocated',
  A(`SELECT rectify_purchase(${CUR('PSP-0117-1')}, 500, 500, '[{"descripcion":"x","cantidad":1,"unit_type":"UNIT","precio_unitario":500}]'::jsonb, 'baja')::text`), 'ERR:OVER_ALLOCATION%');
// the invoice with its fiscal document
expect('R-17 fiscal invoice: no amount change', A(rect('PSP-0117-2', { date: `${Y}-10-01`, invoice: "'0001-00000001'", total: 1300, net: 1000 })), 'ERR:FISCAL_DOCUMENT_LOCKED%');
expect('R-18 fiscal invoice: no second document', A(rect('PSP-0117-2', { date: `${Y}-10-01`, invoice: "'0001-00000001'", total: 1210, fiscal: FISCAL(1000, 1210) })), 'ERR:FISCAL_DOCUMENT_LOCKED%');
expect('R-19 fiscal invoice: its concept can be corrected', A(rect('PSP-0117-2', { concept: 'Maíz molido', date: `${Y}-10-01`, invoice: "'0001-00000001'", total: 1210, net: 1000 })), 'OK:%');
expect('R-19b the document stays linked', `(SELECT subcategory || '|' || (fiscal_document_id IS NOT NULL) FROM purchases WHERE id = ${CUR('PSP-0117-2')})`, 'Maíz molido|true');
// adding the missing invoice
add(`SELECT pg_temp.must('invoice without document', ${A(`SELECT register_purchase('${S1}', '${Y}-10-15', 1210, 1210, ${CAT}, 'Sorgo', 'OPERATING', '[]'::jsonb, '[]'::jsonb, 'RP-0117-2', NULL, NULL, NULL, NULL, NULL)::text`)});`);
expect('R-20 the received invoice added later', A(rect('RP-0117-2', { concept: 'Sorgo', date: `${Y}-10-15`, invoice: "'0001-00000099'", total: 1210, net: 1000, fiscal: FISCAL(1000, 1210) })), 'OK:%');
expect('R-20b recorded once and linked to the current version', `(SELECT count(*) || '|' || bool_and(d.id = p.fiscal_document_id) FROM fiscal_document d JOIN purchases p ON p.id = ${CUR('RP-0117-2')} WHERE d.supplier_id = '${S1}' AND d.external_number = '0001-00000099')`, '1|true');
// a paid expense without supplier
add(`SELECT pg_temp.must('casual paid', ${A(`SELECT register_casual_purchase('${Y}-10-05', 80, 80, ${CAT}, 'Ferretería', 'OPERATING', '${CASH}', 'CASH', 'RC-0117-1')::text`)});`);
const RC = (o) => rect('RC-0117-1', { concept: 'Ferretería', date: `${Y}-10-05`, supplier: 'NULL', total: 80, net: 80, ...o });
expect('R-21 paid without supplier: date locked', A(RC({ date: `${Y}-10-06` })), 'ERR:PAID_EXPENSE_DATE_LOCKED%');
expect('R-22 paid without supplier: amount locked', A(RC({ total: 90, net: 90 })), 'ERR:CASUAL_PURCHASE_AMOUNT_LOCKED%');
expect('R-23 paid without supplier: no supplier set here', A(RC({ supplier: `'${S1}'` })), 'ERR:SUPPLIER_CHANGE_NOT_ALLOWED%');
add(`CREATE TEMP TABLE s4 AS ${counts()};`);
expect('R-24 paid without supplier: concept and category corrected', A(RC({ concept: 'Ferretería El Tornillo', cat: CAT2 })), 'OK:%');
expect('R-24b the payment stays linked to the new version', `(SELECT subcategory || '|' || (paid_operation_id = (SELECT paid_operation_id FROM purchases WHERE idempotency_key = 'RC-0117-1')) FROM purchases WHERE id = ${CUR('RC-0117-1')})`, 'Ferretería El Tornillo|true');
expect('R-25 no money moved', delta('s4'), 'audit_events=1,purchases=1');
// a pending expense without supplier
add(`SELECT pg_temp.must('pending expense', ${A(`SELECT register_pending_expense('${Y}-10-07', 500, 500, ${CAT}, 'Gasoil', 'OPERATING', 'RPE-0117-1')::text`)});`);
const RPE = (o) => rect('RPE-0117-1', { concept: 'Gasoil', date: `${Y}-10-07`, supplier: 'NULL', total: 500, net: 500, ...o });
expect('R-26 pending without supplier: amount locked (the obligation)', A(RPE({ total: 600, net: 600 })), 'ERR:PENDING_EXPENSE_AMOUNT_LOCKED%');
expect('R-27 pending without supplier: date and concept corrected', A(RPE({ concept: 'Gasoil tractor', date: `${Y}-10-08` })), 'OK:%');
expect('R-27b still pending in full under its new data', A(`SELECT concept || '|' || pending || '|' || economic_date FROM fin_expense_payables WHERE purchase_root_id = ${ROOT('RPE-0117-1')}`), `OK:Gasoil tractor|500.00|${Y}-10-08`);

add('ROLLBACK;');

// ── run ────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const lines = out.split('\n').map((l) => l.replace(/^.*NOTICE:\s+/, '').trim());
const pass = lines.filter((l) => l.startsWith('PASS ')).length;
const fail = lines.filter((l) => l.startsWith('FAIL '));
for (const f of fail) console.log(`  ${f}`);
console.log(`\n  ${pass} passed, ${fail.length} failed`);
if (r.status !== 0 || fail.length > 0 || pass === 0) {
  if (r.status !== 0) console.log(out.slice(-2000));
  process.exit(1);
}
