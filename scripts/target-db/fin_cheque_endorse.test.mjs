#!/usr/bin/env node
/**
 * CARTERA DE CHEQUES — ENDOSO CONTRA UN VENCIMIENTO (migration 0123, caja-mejoras-v2). LOCAL TEST DATABASE ONLY.
 *
 * endorse_cheque_to_payable: a client cheque in portfolio endorsed to ONE invoice (or ONE plan item, 0121) in one transaction —
 * endorse_cheque + its allocation for what is open; the excess stays as the supplier's credit; no money moves; idempotent; audited;
 * ADMIN only; a pending expense without supplier cannot take a cheque. An endorsed cheque counts as paid in the invoice, its plan item
 * and the due list; a cheque rejected after the endorsement stops counting (the debt is open again).
 *
 * Everything runs inside ONE transaction that is rolled back. 0121 must be in the ledger (local Docker); if 0123 is not yet, the
 * migration file is executed first INSIDE that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_cheque_endorse.test.mjs
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

const FILE = '0123_cartera_cheques_endoso.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0123-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0123-0000-0000-00000000000b';
const SA = 'bbbbbbbb-0123-0000-0000-0000000000a1';
const CAT = 'cccccccc-0123-0000-0000-0000000000c1';
const CLI = 'dddddddd-0123-0000-0000-0000000000d1';
const CAJA = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo LIMIT 1)`;
const BNA = `(SELECT id FROM financial_account WHERE nombre = 'BNA' AND account_type = 'BANK_ACCOUNT')`;
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);

const pending = (key, date, total, name = 'Taller 0123') =>
  `SELECT register_pending_expense(${lit(date)}::date, ${total}, ${total}, '${CAT}'::uuid, 'Reparación 0123', 'OPERATING', ${lit(key)}, NULL, ${lit(name)}, '[]'::jsonb, '[]'::jsonb, NULL)::text`;
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0123')) AS has_0123 \\gset
\\if :has_0123
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'cartera-0123-admin@test.local', 'ADMIN'), ('${OPER}', 'cartera-0123-oper@test.local', 'OPERATOR');
INSERT INTO suppliers (id, nombre) VALUES ('${SA}', 'Proveedor 0123 A');
INSERT INTO clients (id, nombre) VALUES ('${CLI}', 'Cliente 0123');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES ('${CAT}', 'Categoría 0123', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));`);


const receive = (num, amount, key) => `SELECT receive_cheque('${CLI}'::uuid, 'CHEQUE', ${lit(num)}, ${amount}, '2026-12-01'::date, now(), ${lit(key)}, NULL)::text`;
const endorse = (inst, purchase, itemExpr, key) => `SELECT endorse_cheque_to_payable(${P(inst)}::uuid, ${P(purchase)}::uuid, ${itemExpr ? `${P(itemExpr)}::bigint` : 'NULL'}, '2026-11-13'::date, ${lit(key)}, NULL)::text`;
const INS = (k) => RES(k, 'instrument_id');
const PEND = (root) => `(SELECT pending FROM fin_purchase_payment_status WHERE purchase_root_id = ${root})`;
const SLB = `(SELECT coalesce(sum(signed_amount), 0) FROM supplier_ledger WHERE supplier_id = '${SA}')`;
const POSTINGS = '(SELECT count(*) FROM financial_posting)';

// ── fixtures: an invoice of supplier A (pending 60.000) with a plan of 2 × 30.000; two client cheques in portfolio ──
expect('fixture: pending expense 60.000', ADM(pending('T0123-G1', '2026-11-05', 60000), 'g1'), 'OK:%');
expect('fixture: linked to supplier A (now an invoice)', ADM(`SELECT assign_payable_to_supplier(${P(RES('g1', 'payable_id'))}::uuid, '${SA}'::uuid, 'era del proveedor', 'T0123-LINK', 'C-0123-1')::text`), 'OK:%');
expect('fixture: plan 2 × 30.000', ADM(plan(RES('g1', 'purchase_id'), [{ due_date: '2026-11-20', amount: 30000 }, { due_date: '2026-12-20', amount: 30000 }], 'T0123-PL')), 'OK:%');
expect('fixture: client cheque 40.000 received', ADM(receive('0123-A', 40000, 'T0123-RC-A'), 'ca'), 'OK:%');
expect('fixture: client cheque 5.000 received', ADM(receive('0123-B', 5000, 'T0123-RC-B'), 'cb'), 'OK:%');
expect('fixture: pending expense 7.000 WITHOUT supplier', ADM(pending('T0123-G2', '2026-11-05', 7000), 'g2'), 'OK:%');
add(`CREATE TEMP TABLE b0 AS SELECT ${SLB} AS slb, ${POSTINGS} AS postings;`);

// ── A. endorse against ONE plan item ───────────────────────────────────────
expect('A-1 OPERATOR cannot endorse', as('authenticated', OPER, endorse(INS('ca'), RES('g1', 'purchase_id'), item(R1, 1), 'T0123-E-X')), 'ERR:FORBIDDEN%');
expect('A-2 a cheque cannot pay a pending expense without supplier', ADM(endorse(INS('cb'), RES('g2', 'purchase_id'), null, 'T0123-E-NS')), 'ERR:SUPPLIER_REQUIRED%');
expect('A-3 endorse the 40.000 cheque against instalment 1 (30.000 open)', ADM(endorse(INS('ca'), RES('g1', 'purchase_id'), item(R1, 1), 'T0123-E-1'), 'e1'), 'OK:%"allocated": 30000%"supplier_credit": 10000%');
expect('A-4 instalment 1 covered, instalment 2 untouched', `(${covered(item(R1, 1))} || '|' || ${covered(item(R1, 2))})`, '30000.00|0');
expect('A-5 the invoice pending drops to 30.000', `(${PEND(R1)})::text`, '30000.00');
expect('A-6 the supplier ledger takes the whole cheque (−40.000): 10.000 stay as credit', `(${SLB} - (SELECT slb FROM b0))::text`, '-40000.00');
expect('A-7 no money moved (no posting)', `(${POSTINGS} - (SELECT postings FROM b0))::text`, '0');
expect('A-8 the due list = what is open (instalment 2 only)', DUE(R1), 'CUOTA=30000.00');
expect('A-9 a replay by key returns the recorded endorsement', `(${ADM(endorse(INS('ca'), RES('g1', 'purchase_id'), item(R1, 1), 'T0123-E-1'))} || '|' || (SELECT count(*) FROM purchase_payment_allocation WHERE financial_instrument_id = (${INS('ca')})::uuid))`, 'OK:%"replayed": true%|1');
expect('A-10 an endorsed cheque cannot be endorsed again', ADM(endorse(INS('ca'), RES('g1', 'purchase_id'), item(R1, 2), 'T0123-E-2')), 'ERR:INVALID_STATE%');
expect('A-11 audited ENDORSE_TO_PAYABLE', `(SELECT count(*) FROM audit_events WHERE action = 'ENDORSE_TO_PAYABLE' AND entity_id = ${R1}::text)`, '1');

// ── B. without item: oldest open item; rejection reopens the debt ──────────
expect('B-1 endorse the 5.000 cheque against the invoice (no item chosen)', ADM(endorse(INS('cb'), RES('g1', 'purchase_id'), null, 'T0123-E-3')), 'OK:%"allocated": 5000%');
expect('B-2 it goes to the oldest open item (instalment 2)', `(${covered(item(R1, 2))})::text`, '5000.00');
expect('B-3 the client cheque is rejected after the endorsement', ADM(`SELECT reject_cheque(${P(INS('cb'))}::uuid, '2026-11-14'::date, 'sin fondos')::text`), 'OK:%');
expect('B-4 the rejected cheque no longer counts: pending and instalment 2 open again', `(${PEND(R1)} || '|' || ${covered(item(R1, 2))})`, '30000.00|0');

// ── C. privileges ──────────────────────────────────────────────────────────
expect('C-1 anon cannot execute the RPC', `(NOT has_function_privilege('anon', 'endorse_cheque_to_payable(uuid, uuid, bigint, date, character varying, text)', 'EXECUTE'))::text`, 'true');
expect('C-2 the whole due list still adds up to the calendar', `((SELECT sum(amount) FROM fin_payables_due) = (SELECT sum(amount) FROM fin_payment_calendar))::text`, 'true');

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
