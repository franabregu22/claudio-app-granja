#!/usr/bin/env node
/**
 * 0130 (alimento-balanceado-v1) — reverse the payment of an expense without supplier (owner 2026-11-17): paid at registration →
 * a pending expense again; a pending expense's payment → no longer counted. The money comes back on the original date.
 * LOCAL TEST DATABASE ONLY; everything runs inside ONE transaction that is rolled back. If 0129 is not yet in the
 * ledger it is applied inside that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/gastos_revertir_pago_0130.test.mjs
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

const FILE = '0130_gastos_revertir_pago.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0130-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0130-0000-0000-00000000000b';
const CAT = 'cccccccc-0130-0000-0000-0000000000c1';
const SUP = 'bbbbbbbb-0130-0000-0000-0000000000b1';
const CAJA = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo ORDER BY id LIMIT 1)`;
const P = (expr) => `{{${expr}}}`;           // replaced by the quoted value
const R = (expr) => `[[${expr}]]`;           // replaced by the raw value (inside JSON literals)

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);

// ── harness ─────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0130')) AS has_0130 \\gset
\\if :has_0130
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
  LOOP
    e := substring(p_sql FROM '\\[\\[(.+?)\\]\\]');
    EXIT WHEN e IS NULL;
    -- the raw marker sits inside a SQL literal: its quotes arrive doubled
    EXECUTE 'SELECT (' || replace(e, '''''', '''') || ')::text' INTO val;
    p_sql := replace(p_sql, '[[' || e || ']]', coalesce(val, ''));
  END LOOP;
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
    EXECUTE p_sql INTO v;
    RESET ROLE;
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
CREATE FUNCTION pg_temp.read_as(p_uid TEXT, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; msg TEXT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; v := 'ERR:' || msg;
  END;
  RESET ROLE;
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN
    RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, p_got, p_like;
  ELSE
    RAISE NOTICE 'PASS %', p_name;
  END IF;
END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'revertir-0130-admin@test.local', 'ADMIN'), ('${OPER}', 'revertir-0130-oper@test.local', 'OPERATOR');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES ('${CAT}', 'Materiales 0130', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));
INSERT INTO suppliers (id, nombre) VALUES ('${SUP}', 'Proveedor 0130');`);

const OP = (call, key) => as('authenticated', ADMIN, call, key);
const RES = (k, f) => `(SELECT v ->> '${f}' FROM res WHERE k = '${k}')`;
const casual = (key, total, acc) => `SELECT register_casual_purchase('2026-11-04'::date, ${total}, ${total}, '${CAT}'::uuid, 'alambre 0130', 'REINVESTMENT'::purchase_nature, ${P(acc)}::uuid, 'CASH'::payment_method, ${lit(key)})::text`;
const revert = (purchase, op, key, reason = 'Revertir pago') => `SELECT reverse_expense_payment(${P(purchase)}::uuid, ${P(op)}::bigint, ${lit(reason)}, ${lit(key)})::text`;
const BAL = (acc) => `(SELECT coalesce(sum(signed_amount), 0) FROM financial_posting WHERE financial_account_id = ${acc})`;
const ROOT = (k) => `purchase_chain_root((${RES(k, 'purchase_id')})::uuid)`;
const CUR = (k) => `(SELECT id FROM purchases WHERE is_current AND purchase_chain_root(id) = ${ROOT(k)})`;

// A — paid at registration (like «alambre»)
add(`CREATE TEMP TABLE bal AS SELECT ${BAL(CAJA)} AS caja;`);
expect('A0 a casual expense paid in cash', OP(casual('R0130-A', 16400, CAJA), 'a'), 'OK:%payment_operation_id%');
expect('A1 OPERATOR cannot reverse a payment', as('authenticated', OPER, revert(`${RES('a', 'purchase_id')}`, `${RES('a', 'payment_operation_id')}`, 'R0130-X')), 'ERR:%');
expect('A2 reason required', OP(revert(`${RES('a', 'purchase_id')}`, `${RES('a', 'payment_operation_id')}`, 'R0130-Y', '  ')), 'ERR:REASON_REQUIRED%');
expect('A3 ADMIN reverses it (AT_REGISTRATION)', OP(revert(`${RES('a', 'purchase_id')}`, `${RES('a', 'payment_operation_id')}`, 'R0130-REV-A'), 'ra'), 'OK:%"kind": "AT_REGISTRATION"%');
expect('A4 … the money is back in the account (balance as before the expense)', `(${BAL(CAJA)} = (SELECT caja FROM bal))::text`, 'true');
expect('A5 … the expense is pending for its whole amount (new version without payment + its obligation)',
  `(SELECT (p.paid_operation_id IS NULL)::text || '|' || p.version_seq || '|' || e.amount || '|' || expense_payable_paid(e.id) FROM purchases p JOIN expense_payable e ON e.purchase_root_id = ${ROOT('a')} WHERE p.id = ${CUR('a')})`,
  'true|1|16400.00|0');
expect('A6 … the reversal is on the original date, on the same account, labelled «Reversión de pago» (kind PAGO)',
  `(SELECT o.effective_date || '|' || (p.financial_account_id = ${CAJA})::text || '|' || p.signed_amount || '|' || c.kind || '|' || c.label FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id CROSS JOIN LATERAL fin_movement_class(o.operation_type::text, o.external_ref) c WHERE o.id = (${RES('ra', 'reversal_operation_id')})::bigint)`,
  '2026-11-04|true|16400.00|PAGO|Reversión de pago');
expect('A7 … the P&L keeps the expense (accrual)', `(SELECT count(*) FROM purchases WHERE is_current AND purchase_chain_root(id) = ${ROOT('a')} AND amount_total = 16400)`, '1');
expect('A8 … audited REVERSE_PAYMENT', `(SELECT count(*) FROM audit_events WHERE action = 'REVERSE_PAYMENT' AND entity_id = ${RES('a', 'purchase_id')})`, '1');
expect('A9 same key replays', OP(revert(`${RES('a', 'purchase_id')}`, `${RES('a', 'payment_operation_id')}`, 'R0130-REV-A')), 'OK:%"replayed": true%');
expect('A10 another key → ALREADY_REVERSED', OP(revert(`${RES('a', 'purchase_id')}`, `${RES('a', 'payment_operation_id')}`, 'R0130-REV-A2')), 'ERR:%');
expect('A11 the cash flow nets in the category (outflow − reversal = 0 for the month)',
  `(SELECT coalesce(sum((x ->> 'amount')::numeric), 0) FROM jsonb_array_elements((pg_temp.read_as('${ADMIN}', ${lit(`SELECT fin_cash_flow('2026-11-01', '2026-11-30', 'MONTH')::text`)}))::jsonb -> 'rows') x WHERE x ->> 'sub' = 'Materiales 0130')`, '0%');

// B — the pending expense (now) is paid, then that payment is reversed
expect('B0 pay the pending expense in cash', OP(`SELECT pay_pending_expense(${P(`(SELECT id FROM expense_payable WHERE purchase_root_id = ${ROOT('a')})`)}::uuid, 10000, '2026-11-10'::date, ${P(CAJA)}::uuid, 'CASH'::payment_method, 'R0130-PAY-B')::text`, 'b'), 'OK:%');
expect('B1 reverse that payment (PAYABLE_PAYMENT)', OP(revert(CUR('a'), `${RES('b', 'financial_operation_id')}`, 'R0130-REV-B'), 'rb'), 'OK:%"kind": "PAYABLE_PAYMENT"%');
expect('B2 … nothing counts as paid; the balance is back', `(SELECT expense_payable_paid(id) FROM expense_payable WHERE purchase_root_id = ${ROOT('a')})::text || '|' || (${BAL(CAJA)} = (SELECT caja FROM bal))::text`, '0|true');
expect('B3 … it can be paid again for the whole amount', OP(`SELECT pay_pending_expense(${P(`(SELECT id FROM expense_payable WHERE purchase_root_id = ${ROOT('a')})`)}::uuid, 16400, '2026-11-12'::date, ${P(CAJA)}::uuid, 'CASH'::payment_method, 'R0130-PAY-B2')::text`), 'OK:%"pending": 0%');

// C — guards
expect('C1 an unknown expense is refused', OP(`SELECT reverse_expense_payment(gen_random_uuid(), 1, 'x', 'R0130-C1')::text`), 'ERR:PURCHASE_NOT_FOUND%');
expect('C2 an operation that is not this expense\'s payment is refused', OP(revert(CUR('a'), `${RES('ra', 'reversal_operation_id')}`, 'R0130-C2')), 'ERR:PAYMENT_NOT_FOUND%');
expect('C3 a payable with a reversed payment is never linked to a supplier',
  `(SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_epsl_reversal_guard' AND tgrelid = 'public.expense_payable_supplier_link'::regclass)`, '1');
expect('C4 ADMIN reads both reversals', `pg_temp.read_as('${ADMIN}', 'SELECT count(*)::text FROM expense_payment_reversal')`, '2');
expect('C5 OPERATOR reads no reversal', `pg_temp.read_as('${OPER}', 'SELECT count(*)::text FROM expense_payment_reversal')`, '0');
add('ROLLBACK;');

// ── run (rolled back) on the container behind the guarded local URL ─────────
if (process.env.DUMP_SQL) { (await import('node:fs')).writeFileSync(process.env.DUMP_SQL, sql.join('\n')); }
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
