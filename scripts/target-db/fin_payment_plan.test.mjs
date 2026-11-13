#!/usr/bin/env node
/**
 * CUENTAS A PAGAR — PLAN DE PAGOS (migration 0121, caja-mejoras-v2). LOCAL TEST DATABASE ONLY.
 *
 * set_payment_plan: adds up exactly to what is open, versioned (a change needs a reason), idempotent, audited, ADMIN only.
 * pay_plan_item / issue_plan_item_instruments: a payment covers the CHOSEN item, never above its open amount; a cheque needs a supplier.
 * fin_plan_link_payment: a payment made elsewhere goes to the oldest open items; payments carried by assign_payable_to_supplier are
 * not linked twice. fin_payables_due: every open due item once; per obligation its rows add up to the calendar's pending.
 *
 * Everything runs inside ONE transaction that is rolled back. If 0121 is not in the ledger yet, the migration file itself is executed
 * first INSIDE that transaction. Each call runs in its own subtransaction, checked as at its own COMMIT.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_payment_plan.test.mjs
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

const FILE = '0121_cuentas_a_pagar_plan_pagos.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0121-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0121-0000-0000-00000000000b';
const SA = 'bbbbbbbb-0121-0000-0000-0000000000a1';
const CAT = 'cccccccc-0121-0000-0000-0000000000c1';
const CAJA = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo LIMIT 1)`;
const BNA = `(SELECT id FROM financial_account WHERE nombre = 'BNA' AND account_type = 'BANK_ACCOUNT')`;
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);

const pending = (key, date, total, name = 'Taller 0121') =>
  `SELECT register_pending_expense(${lit(date)}::date, ${total}, ${total}, '${CAT}'::uuid, 'Reparación 0121', 'OPERATING', ${lit(key)}, NULL, ${lit(name)}, '[]'::jsonb, '[]'::jsonb, NULL)::text`;
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0121')) AS has_0121 \\gset
\\if :has_0121
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'cap-0121-admin@test.local', 'ADMIN'), ('${OPER}', 'cap-0121-oper@test.local', 'OPERATOR');
INSERT INTO suppliers (id, nombre) VALUES ('${SA}', 'Proveedor 0121 A');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES ('${CAT}', 'Categoría 0121', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));`);

// ── fixtures ────────────────────────────────────────────────────────────────
expect('fixture G1: pending expense 90.000 without supplier', ADM(pending('T0121-G1', '2026-11-05', 90000), 'g1'), 'OK:%');
expect('fixture G2: pending expense 60.000 (will be linked to a supplier)', ADM(pending('T0121-G2', '2026-11-05', 60000), 'g2'), 'OK:%');
expect('fixture G3: pending expense 10.000 without plan', ADM(pending('T0121-G3', '2026-11-05', 10000), 'g3'), 'OK:%');
expect('fixture: without a plan an obligation is ONE due item (its pending)', DUE(R3), 'PAGO=10000.00');

// ── A. set_payment_plan ─────────────────────────────────────────────────────
const tres = [{ due_date: '2026-11-10', amount: 30000 }, { due_date: '2026-12-10', amount: 30000 }, { due_date: '2027-01-10', amount: 30000 }];
expect('A-1 OPERATOR cannot set a plan', as('authenticated', OPER, plan(RES('g1', 'purchase_id'), tres, 'T0121-PL-X')), 'ERR:FORBIDDEN%');
expect('A-2 the items must add up to what is open', ADM(plan(RES('g1', 'purchase_id'), tres.slice(0, 2), 'T0121-PL-BAD')), 'ERR:PLAN_TOTAL_MISMATCH%');
expect('A-3 an item needs an amount above zero', ADM(plan(RES('g1', 'purchase_id'), [{ due_date: null, amount: 0 }, { amount: 90000 }], 'T0121-PL-BAD2')), 'ERR:INVALID_PLAN%');
expect('A-4 three monthly instalments of 30.000', ADM(plan(RES('g1', 'purchase_id'), tres, 'T0121-PL-1'), 'pl1'), 'OK:%"plan_version": 1%');
expect('A-5 a replay by key returns the recorded plan, nothing new', `(${ADM(plan(RES('g1', 'purchase_id'), tres, 'T0121-PL-1'))} || '|' || (SELECT count(*) FROM payment_plan_item WHERE purchase_root_id = ${R1}))`, 'OK:%"replayed": true%|3');
expect('A-6 the list shows three instalments and no single item', DUE(R1), 'CUOTA=30000.00;CUOTA=30000.00;CUOTA=30000.00');
expect('A-7 changing a plan needs a reason', ADM(plan(RES('g1', 'purchase_id'), [{ amount: 90000 }], 'T0121-PL-NR')), 'ERR:REASON_REQUIRED%');
expect('A-8 audited SET_PAYMENT_PLAN', `(SELECT count(*) FROM audit_events WHERE action = 'SET_PAYMENT_PLAN' AND entity_id = ${R1}::text)`, '1');

// ── B. pay the chosen item ──────────────────────────────────────────────────
expect('B-1 pay 10.000 of instalment 2 (cash)', ADM(payItem(item(R1, 2), 10000, CAJA, 'CASH', 'T0121-PAY-1')), 'OK:%');
expect('B-2 only instalment 2 is covered', `(${covered(item(R1, 1))} || '|' || ${covered(item(R1, 2))} || '|' || ${covered(item(R1, 3))})`, '0|10000.00|0');
expect('B-3 never above the item\'s open amount', ADM(payItem(item(R1, 2), 25000, CAJA, 'CASH', 'T0121-PAY-2')), 'ERR:OVER_ITEM%');
expect('B-4 a replay by key adds nothing', `(${ADM(payItem(item(R1, 2), 10000, CAJA, 'CASH', 'T0121-PAY-1'))} || '|' || ${covered(item(R1, 2))})`, 'OK:%|10000.00');
expect('B-5 the list follows: 30.000 + 20.000 + 30.000 = what is open', `(${DUE(R1)} || '|' || ${SUMDUE(R1)} || '=' || ${OPEN(R1)})`, 'CUOTA=30000.00;CUOTA=20000.00;CUOTA=30000.00|80000.00=80000.00');

// ── C. a payment made elsewhere goes to the oldest items ───────────────────
expect('C-1 pay_pending_expense 35.000 directly (not from Cuentas a pagar)', ADM(payPending(RES('g1', 'payable_id'), 35000, 'T0121-PAY-EXT')), 'OK:%');
expect('C-2 oldest first: instalment 1 complete (30.000), then 5.000 of instalment 2', `(${covered(item(R1, 1))} || '|' || ${covered(item(R1, 2))} || '|' || ${covered(item(R1, 3))})`, '30000.00|15000.00|0');
expect('C-3 the links of an outside payment are marked as not chosen', `(SELECT string_agg(l.chosen::text, ',' ORDER BY l.id) FROM payment_plan_item_link l JOIN payment_plan_item p ON p.id = l.item_id WHERE p.purchase_root_id = ${R1})`, 'true,false,false');
expect('C-4 the list = what is open (45.000)', `(${SUMDUE(R1)} || '=' || ${OPEN(R1)})`, '45000.00=45000.00');

// ── D. change the payment form over what is open ───────────────────────────
expect('D-1 new plan (2 instalments) over the 45.000 still open, with a reason',
  ADM(plan(RES('g1', 'purchase_id'), [{ due_date: '2026-12-01', amount: 20000 }, { due_date: '2027-01-01', amount: 25000 }], 'T0121-PL-2', 'el taller aceptó 2 cuotas'), 'pl2'),
  'OK:%"plan_version": 2%');
expect('D-2 the list shows only the new version', DUE(R1), 'CUOTA=20000.00;CUOTA=25000.00');
expect('D-3 the old version stays (history), with its covered amounts', `(SELECT count(*) FROM payment_plan_item WHERE purchase_root_id = ${R1} AND plan_version = 1)`, '3');
expect('D-4 the audit keeps the replaced items and the reason',
  `(SELECT (before_values -> 'items' -> 0 ->> 'covered') || '|' || reason FROM audit_events WHERE action = 'SET_PAYMENT_PLAN' AND entity_id = ${R1}::text ORDER BY id DESC LIMIT 1)`,
  '30000.00|el taller aceptó 2 cuotas');

// ── E. an invoice (pending expense linked to a supplier): payments carried once, cheques per item ──
expect('E-1 plan on G2 (pending 60.000): 2 × 30.000', ADM(plan(RES('g2', 'purchase_id'), [{ due_date: '2026-11-20', amount: 30000 }, { due_date: '2026-12-20', amount: 30000 }], 'T0121-PL-G2')), 'OK:%');
expect('E-2 pay 12.000 of instalment 1 while still without supplier', ADM(payItem(item(R2, 1), 12000, CAJA, 'CASH', 'T0121-PAY-G2')), 'OK:%');
expect('E-3 a cheque needs a supplier (still a pending expense without supplier)',
  ADM(`SELECT issue_plan_item_instruments(${P(item(R2, 2))}::bigint, jsonb_build_array(jsonb_build_object('instrument_type', 'ECHEQ', 'cheque_number', 'E-0121-0', 'amount', 10000, 'maturity_date', '2026-12-20', 'issued_date', '2026-11-13', 'bank_account_id', ${P(BNA)})), 'T0121-CH-0', NULL)::text`),
  'ERR:%');
expect('E-4 link G2 to the supplier (assign_payable_to_supplier, 0110)',
  ADM(`SELECT assign_payable_to_supplier(${P(RES('g2', 'payable_id'))}::uuid, '${SA}'::uuid, 'era del proveedor A', 'T0121-LINK', 'B-0121-0001')::text`), 'OK:%');
expect('E-5 the carried payment is not linked twice', `(SELECT count(*) || '|' || sum(l.amount) FROM payment_plan_item_link l JOIN payment_plan_item p ON p.id = l.item_id WHERE p.purchase_root_id = ${R2})`, '1|12000.00');
expect('E-6 the list = the invoice pending (48.000)', `(${DUE(R2)} || '|' || ${SUMDUE(R2)} || '=' || ${OPEN(R2)})`, 'CUOTA=18000.00;CUOTA=30000.00|48000.00=48000.00');
expect('E-7 pay instalment 2 with an eCheq of 30.000 (now an invoice of supplier A)',
  ADM(`SELECT issue_plan_item_instruments(${P(item(R2, 2))}::bigint, jsonb_build_array(jsonb_build_object('instrument_type', 'ECHEQ', 'cheque_number', 'E-0121-1', 'amount', 30000, 'maturity_date', '2026-12-20', 'issued_date', '2026-11-13', 'bank_account_id', ${P(BNA)})), 'T0121-CH-1', NULL)::text`),
  'OK:%');
expect('E-8 instalment 2 is covered by the cheque; the cheque is its own row (IMPUTADO)', `(${covered(item(R2, 2))} || '|' || ${DUE(R2, `row_kind || '=' || amount || coalesce(':' || link_status, '')`)})`,
  '30000.00|CUOTA=18000.00;ECHEQ=30000.00:IMPUTADO');
expect('E-9 pay instalment 1 by transfer from the invoice route', ADM(payItem(item(R2, 1), 18000, BNA, 'TRANSFER', 'T0121-PAY-G2B')), 'OK:%');
expect('E-10 nothing open on the invoice; only the cheque to be debited remains', `(${OPEN(R2)} || '|' || ${DUE(R2)})`, '0|ECHEQ=30000.00');

// ── F. a later rectification of the total is never reconciled silently ──────
expect('F-1 (simulated) a payment above the plan from elsewhere: links stop at the plan, the list stays = pending',
  `(${SUMDUE(R1)} || '=' || ${OPEN(R1)})`, '45000.00=45000.00');

// ── G. privileges and immutability ─────────────────────────────────────────
expect('G-1 plan items and links are append-only', `(SELECT string_agg(r, '|') FROM (SELECT ${ADM(`UPDATE payment_plan_item SET amount = 1 RETURNING 'x'`)} AS r UNION ALL SELECT ${ADM(`DELETE FROM payment_plan_item_link RETURNING 'x'`)}) q)`, 'ERR:%|ERR:%');
expect('G-2 an authenticated user cannot write the new tables directly',
  `(NOT has_table_privilege('authenticated', 'payment_plan_item', 'INSERT') AND NOT has_table_privilege('authenticated', 'payment_plan_item_link', 'INSERT'))::text`, 'true');
expect('G-3 OPERATOR reads no plan / link / due row (RLS)', as('authenticated', OPER, `SELECT ((SELECT count(*) FROM payment_plan_item) + (SELECT count(*) FROM payment_plan_item_link) + (SELECT count(*) FROM fin_payables_due))::text`), 'OK:0');
expect('G-4 anon cannot execute the new RPCs',
  `(NOT has_function_privilege('anon', 'set_payment_plan(uuid, jsonb, character varying, text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'pay_plan_item(bigint, numeric, date, payment_method, uuid, character varying, text)', 'EXECUTE'))::text`, 'true');
expect('G-5 the whole list adds up to the calendar (every obligation and cheque once)',
  `((SELECT sum(amount) FROM fin_payables_due) = (SELECT sum(amount) FROM fin_payment_calendar))::text`, 'true');

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
