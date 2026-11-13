#!/usr/bin/env node
/**
 * GASTOS — ANULAR Y CORREGIR EL IMPORTE (migration 0124, caja-mejoras-v2). LOCAL TEST DATABASE ONLY.
 *
 * annul_expense: an expense without payments, cheques, Mercado Pago link or freight is annulled (reason, who, when; audited; idempotent;
 * ADMIN only): it leaves the pending list, the calendar, the due list, the P&L and — when its IVA period is not declared — the IVA report;
 * a supplier expense books a REVERSAL; nothing is ever paid, allocated or rectified against it afterwards. rectify_purchase_details: a
 * pending expense without supplier and without payments changes its amount (its obligation follows); with a payment it stays locked.
 *
 * Everything runs inside ONE transaction that is rolled back. 0121 must be in the ledger (local Docker); if 0124 is not yet, the
 * migration file is executed first INSIDE that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_expense_annul.test.mjs
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

const FILE = '0124_gastos_anular_y_editar.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0124-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0124-0000-0000-00000000000b';
const SA = 'bbbbbbbb-0124-0000-0000-0000000000a1';
const CAT = 'cccccccc-0124-0000-0000-0000000000c1';
const CLI = 'dddddddd-0124-0000-0000-0000000000d1';
const CAJA = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo LIMIT 1)`;
const BNA = `(SELECT id FROM financial_account WHERE nombre = 'BNA' AND account_type = 'BANK_ACCOUNT')`;
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);

const pending = (key, date, total, name = 'Taller 0124') =>
  `SELECT register_pending_expense(${lit(date)}::date, ${total}, ${total}, '${CAT}'::uuid, 'Reparación 0124', 'OPERATING', ${lit(key)}, NULL, ${lit(name)}, '[]'::jsonb, '[]'::jsonb, NULL)::text`;
const plan = (purchase, items, key, reason = null) =>
  `SELECT set_payment_plan(${P(purchase)}::uuid, ${lit(JSON.stringify(items))}::jsonb, ${lit(key)}, ${lit(reason)})::text`;
const item = (root, seq, ver = null) => `(SELECT id FROM payment_plan_item WHERE purchase_root_id = ${root} AND seq = ${seq} AND plan_version = ${ver ?? `payment_plan_current_version(${root})`})`;
const payItem = (itemExpr, amount, acc, method, key) =>
  `SELECT pay_plan_item(${P(itemExpr)}::bigint, ${amount}, '2026-11-13'::date, '${method}'::payment_method, ${P(acc)}::uuid, ${lit(key)})::text`;
const payPending = (payable, amount, key) =>
  `SELECT pay_pending_expense(${P(payable)}::uuid, ${amount}, '2026-11-13'::date, ${P(CAJA)}::uuid, 'CASH'::payment_method, ${lit(key)})::text`;
const covered = (itemExpr) => `payment_plan_item_covered(${itemExpr})`;
const DUE = (root, cols = `row_kind || '=' || amount`) => `(SELECT coalesce(string_agg(${cols}, ';' ORDER BY row_kind, coalesce(seq, 0), amount), 'none') FROM fin_payables_due WHERE purchase_root_id = ${root})`;
const SUMDUE = (root) => `(SELECT coalesce(sum(amount), 0) FROM fin_payables_due WHERE purchase_root_id = ${root} AND row_kind NOT IN ('CHEQUE', 'ECHEQ'))`;
const OPEN = (root) => `payment_plan_open_amount(${root})`;
const R1 = `(${RES('g1', 'purchase_id')})::uuid`;
const R2 = `(${RES('g2', 'purchase_id')})::uuid`;
const R3 = `(${RES('g3', 'purchase_id')})::uuid`;

// ── harness ─────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0124')) AS has_0124 \\gset
\\if :has_0124
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
    SET CONSTRAINTS ALL IMMEDIATE;
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'anular-0124-admin@test.local', 'ADMIN'), ('${OPER}', 'anular-0124-oper@test.local', 'OPERATOR');
INSERT INTO suppliers (id, nombre) VALUES ('${SA}', 'Proveedor 0124 A');
INSERT INTO clients (id, nombre) VALUES ('${CLI}', 'Cliente 0124');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES ('${CAT}', 'Categoría 0124', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));`);


const FISCAL = (n) => ({ document_type: 'INVOICE_A', document_date: '2026-11-05', fiscal_period: '2026-11-01', net_amount: 100000, total_amount: 121000,
  external_number: `0124-0000${n}`, issuer_tax_id: '30712345678', issuer_name: 'Estación 0124',
  components: [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 100000, rate_applied: 21, tax_amount: 21000 }] });
const pendingF = (key, total, fiscal) =>
  `SELECT register_pending_expense('2026-11-05'::date, ${fiscal.net_amount}, ${total}, '${CAT}'::uuid, 'Gasoil 0124', 'OPERATING', ${lit(key)}, NULL, 'Estación 0124', '[]'::jsonb, '[]'::jsonb, ${lit(JSON.stringify(fiscal))}::jsonb)::text`;
const annul = (purchase, reason, key) => `SELECT annul_expense(${P(purchase)}::uuid, ${lit(reason)}, ${lit(key)})::text`;
const CUR = (root) => `(SELECT id FROM purchases WHERE is_current AND purchase_chain_root(id) = ${root})`;
const rectAmount = (root, amount) => `SELECT rectify_purchase_details(${P(CUR(root))}::uuid, 'Reparación 0124', '${CAT}'::uuid, 'OPERATING', '2026-11-05'::date, NULL, NULL, ${amount}, ${amount}, 'se tipeó mal el importe', NULL)::text`;
const PAYV = (root, col) => `(SELECT ${col} FROM fin_expense_payables WHERE purchase_root_id = ${root})`;
const IN_CAL = (root) => `(SELECT count(*) FROM fin_payment_calendar WHERE purchase_root_id = ${root})`;
const PNL = (root) => `(SELECT coalesce(sum(signed_amount), 0) FROM pnl_line_item WHERE source_entity_type = 'purchases' AND purchase_chain_root(source_entity_id::uuid) = ${root})`;
const IVA = `(SELECT coalesce(sum(credit_amount), 0) FROM report_fiscal_period WHERE period = '2026-11-01' AND tax_kind = 'IVA')`;
const SLB = `(SELECT coalesce(sum(signed_amount), 0) FROM supplier_ledger WHERE supplier_id = '${SA}')`;
const R4 = `(${RES('g4', 'purchase_id')})::uuid`;
const R5 = `(${RES('g5', 'purchase_id')})::uuid`;
const R6 = `(${RES('g6', 'purchase_id')})::uuid`;

// ── fixtures ────────────────────────────────────────────────────────────────
expect('fixture G1: pending expense 100.000 without supplier', ADM(pending('T0124-G1', '2026-11-05', 100000), 'g1'), 'OK:%');
expect('fixture G2: pending expense 50.000 with a partial payment of 10.000', `(${ADM(pending('T0124-G2', '2026-11-05', 50000), 'g2')} || ${ADM(payPending(RES('g2', 'payable_id'), 10000, 'T0124-P2'))})`, 'OK:%OK:%');
expect('fixture G3: pending expense 30.000 without supplier (to annul)', ADM(pending('T0124-G3', '2026-11-05', 30000), 'g3'), 'OK:%');
expect('fixture G4: pending expense 40.000 linked to supplier A (an invoice, to annul)',
  `(${ADM(pending('T0124-G4', '2026-11-05', 40000), 'g4')} || ${ADM(`SELECT assign_payable_to_supplier(${P(RES('g4', 'payable_id'))}::uuid, '${SA}'::uuid, 'era del proveedor', 'T0124-LINK4', 'X-0124-4')::text`)})`, 'OK:%OK:%');
expect('fixture G5: pending expense 121.000 with invoice A (IVA 21.000), period 11/2026', ADM(pendingF('T0124-G5', 121000, FISCAL(5)), 'g5'), 'OK:%');
expect('fixture G6: pending expense 121.000 with invoice A, its IVA period declared', ADM(pendingF('T0124-G6', 121000, FISCAL(6)), 'g6'), 'OK:%');

// ── A. the amount of a pending expense without supplier ─────────────────────
expect('A-1 without payments its amount changes (100.000 → 80.000)', ADM(rectAmount(R1, 80000)), 'OK:%');
expect('A-2 the obligation follows: amount 80.000, pending 80.000', `(${PAYV(R1, 'amount')} || '|' || ${PAYV(R1, 'pending')})`, '80000.00|80000.00');
expect('A-3 it can be paid up to 80.000, never above', `(${ADM(payPending(RES('g1', 'payable_id'), 80001, 'T0124-P1X'))})`, 'ERR:OVER_PAYMENT%');
expect('A-4 raised to 120.000 (still nothing paid) it can be paid 120.000', `(${ADM(rectAmount(R1, 120000))} || ${ADM(payPending(RES('g1', 'payable_id'), 120000, 'T0124-P1'))})`, 'OK:%OK:%');
expect('A-5 with a payment the amount stays locked', ADM(rectAmount(R2, 45000)), 'ERR:PENDING_EXPENSE_AMOUNT_LOCKED%');

// ── B. annul ────────────────────────────────────────────────────────────────
expect('B-1 OPERATOR cannot annul', as('authenticated', OPER, annul(RES('g3', 'purchase_id'), 'prueba', 'T0124-AX')), 'ERR:FORBIDDEN%');
expect('B-2 a reason is required', ADM(annul(RES('g3', 'purchase_id'), ' ', 'T0124-A0')), 'ERR:REASON_REQUIRED%');
expect('B-3 an expense with payments is not annulled', ADM(annul(RES('g2', 'purchase_id'), 'no va', 'T0124-A2')), 'ERR:EXPENSE_PAID%');
add(`CREATE TEMP TABLE b3 AS SELECT ${PNL(R3)} AS pnl, ${SLB} AS slb, ${IVA} AS iva, (SELECT count(*) FROM financial_posting) AS postings;`);
expect('B-4 annul the pending expense of 30.000', ADM(annul(RES('g3', 'purchase_id'), 'carga de prueba', 'T0124-A3'), 'a3'), 'OK:%');
expect('B-5 it leaves the pending list, the calendar and the due list', `(coalesce(${PAYV(R3, 'pending')}::text, 'gone') || '|' || ${IN_CAL(R3)} || '|' || (SELECT count(*) FROM fin_payables_due WHERE purchase_root_id = ${R3}))`, 'gone|0|0');
expect('B-6 it leaves the P&L (−30.000 → 0) and no money moved', `((SELECT pnl FROM b3) || '|' || ${PNL(R3)} || '|' || ((SELECT count(*) FROM financial_posting) - (SELECT postings FROM b3)))`, '-30000.00|0|0');
expect('B-7 it stays visible as annulled, with who and why', `(SELECT amount_total || '|' || reason || '|' || (created_by = '${ADMIN}') FROM fin_expense_annulments WHERE purchase_root_id = ${R3})`, '30000.00|carga de prueba|true');
expect('B-8 audited ANNUL_EXPENSE', `(SELECT count(*) FROM audit_events WHERE action = 'ANNUL_EXPENSE' AND entity_id = ${R3}::text)`, '1');
expect('B-9 a replay by key returns the annulment; a second annulment is refused', `(${ADM(annul(RES('g3', 'purchase_id'), 'carga de prueba', 'T0124-A3'))} || '|' || ${ADM(annul(RES('g3', 'purchase_id'), 'otra', 'T0124-A3b'))})`, 'OK:%"replayed": true%|ERR:ALREADY_ANNULLED%');
expect('B-10 an annulled expense is never paid nor rectified', `(${ADM(payPending(RES('g3', 'payable_id'), 1000, 'T0124-P3'))} || '|' || ${ADM(rectAmount(R3, 20000))})`, 'ERR:EXPENSE_ANNULLED%|ERR:EXPENSE_ANNULLED%');
expect('B-11 an invoice of supplier A is annulled', ADM(annul(RES('g4', 'purchase_id'), 'factura duplicada', 'T0124-A4')), 'OK:%');
expect('B-11b its debt goes back (REVERSAL −40.000) and it leaves the invoices', `((${SLB} - (SELECT slb FROM b3)) || '|' || coalesce((SELECT pending::text FROM fin_purchase_payment_status WHERE purchase_root_id = ${R4}), 'gone'))`, '-40000.00|gone');
expect('B-12 nothing can be allocated to the annulled invoice (guard, whatever RPC)',
  ADM(`SELECT pay_purchase_invoice(${P(R4)}::uuid, 1000, '2026-11-13'::date, 'CASH'::payment_method, ${P(CAJA)}::uuid, 'T0124-PI4', NULL)::text`), 'ERR:%');
expect('B-13 with its invoice (period not declared) it is annulled', ADM(annul(RES('g5', 'purchase_id'), 'mal cargada', 'T0124-A5')), 'OK:%');
expect('B-13b its IVA credit leaves the period (−21.000)', `((SELECT iva FROM b3) - ${IVA})::text`, '21000.00');
add(`INSERT INTO fiscal_obligation (tax_kind, fiscal_period, amount, due_date) VALUES ('IVA', '2026-11-01', 1, '2026-12-20');`);
expect('B-14 with its IVA period declared it is refused (credit note)', ADM(annul(RES('g6', 'purchase_id'), 'mal cargada', 'T0124-A6')), 'ERR:FISCAL_PERIOD_DECLARED%');

// ── C. privileges and immutability ─────────────────────────────────────────
expect('C-1 the annulment is append-only and not writable from the API',
  `(${ADM(`DELETE FROM purchase_annulment RETURNING 'x'`)} || '|' || (NOT has_table_privilege('authenticated', 'purchase_annulment', 'INSERT'))::text)`, 'ERR:%|true');
expect('C-2 OPERATOR reads no annulment (RLS)', as('authenticated', OPER, `SELECT ((SELECT count(*) FROM purchase_annulment) + (SELECT count(*) FROM fin_expense_annulments))::text`), 'OK:0');
expect('C-3 anon cannot execute annul_expense', `(NOT has_function_privilege('anon', 'annul_expense(uuid, text, character varying, date)', 'EXECUTE'))::text`, 'true');
expect('C-4 the due list still adds up to the calendar', `((SELECT sum(amount) FROM fin_payables_due) = (SELECT sum(amount) FROM fin_payment_calendar))::text`, 'true');

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
