#!/usr/bin/env node
/**
 * CAJA — FLUJO DE CAJA REAL (migration 0122, caja-mejoras-v2). LOCAL TEST DATABASE ONLY. Read only: nothing is written but the test fixtures.
 *
 * fin_cash_flow: ADMIN only; valid range and grain; per period the rows add up to the net of the postings; opening + Σ net = every posting
 * up to the end (the balance cards); weeks start on Monday; transfers between own accounts are not income nor expense; a collection is
 * income and a "Clasificación de salida" is on the outflow side; an expense paid with its category lands on its group / subcategory.
 *
 * Everything runs inside ONE transaction that is rolled back. If 0122 is not in the ledger yet, the migration file is executed first INSIDE it.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_cash_flow.test.mjs
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

const FILE = '0122_caja_flujo_de_caja.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0122-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0122-0000-0000-00000000000b';
const SA = 'bbbbbbbb-0122-0000-0000-0000000000a1';
const CAT = 'cccccccc-0122-0000-0000-0000000000c1';
const CAJA = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo LIMIT 1)`;
const BNA = `(SELECT id FROM financial_account WHERE nombre = 'BNA' AND account_type = 'BANK_ACCOUNT')`;
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);

const FLOW = (from, to, grain) => `SELECT fin_cash_flow(${lit(from)}::date, ${lit(to)}::date, ${lit(grain)})::text`;
const J = (key) => `(SELECT v FROM res WHERE k = '${key}')`;
const NETS = (key) => `(SELECT coalesce(sum((x ->> 'net')::numeric), 0) FROM jsonb_array_elements(${J(key)} -> 'net') x)`;
const ROWS = (key, where = 'true') => `(SELECT coalesce(sum((y ->> 'amount')::numeric), 0) FROM jsonb_array_elements(${J(key)} -> 'rows') y WHERE ${where})`;

// ── harness ─────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0122')) AS has_0122 \\gset
\\if :has_0122
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'flujo-0122-admin@test.local', 'ADMIN'), ('${OPER}', 'flujo-0122-oper@test.local', 'OPERATOR');
INSERT INTO suppliers (id, nombre) VALUES ('${SA}', 'Proveedor 0122 A');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES ('${CAT}', 'Categoría 0122', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));`);


// ── fixtures: a supplier expense paid now (category known) ──────────────────
expect('fixture: a casual expense paid in cash today, category 0122', ADM(`SELECT register_casual_purchase('2026-11-13'::date, 12345, 12345, '${CAT}'::uuid, 'Prueba flujo 0122', 'OPERATING', ${P(CAJA)}::uuid, 'CASH'::payment_method, 'T0122-G1', 'Comercio 0122')::text`), 'OK:%');

// ── A. guards ───────────────────────────────────────────────────────────────
expect('A-1 OPERATOR cannot read the cash flow', as('authenticated', OPER, FLOW('2026-11-01', '2026-11-30', 'MONTH')), 'ERR:FORBIDDEN%');
expect('A-2 a range from after to is refused', ADM(FLOW('2026-11-30', '2026-11-01', 'MONTH')), 'ERR:INVALID_RANGE%');
expect('A-3 an unknown grain is refused', ADM(FLOW('2026-11-01', '2026-11-30', 'DAY')), 'ERR:INVALID_GRAIN%');
expect('A-4 anon cannot execute it', `(NOT has_function_privilege('anon', 'fin_cash_flow(date, date, text)', 'EXECUTE'))::text`, 'true');

// ── B. coherence on the real data copy ─────────────────────────────────────
expect('B-1 six months by month', ADM(FLOW('2026-06-01', '2026-11-30', 'MONTH'), 'm'), 'OK:%');
expect('B-2 eight weeks by week', ADM(FLOW('2026-09-21', '2026-11-15', 'WEEK'), 'w'), 'OK:%');
expect('B-3 month: the rows of the range add up to the net of its postings', `(abs(${ROWS('m')} - ${NETS('m')}) < 0.005)::text`, 'true');
expect('B-4 month: opening + Σ net = every posting up to the end (the balance cards)',
  `((${J('m')} ->> 'opening')::numeric + ${NETS('m')} = (SELECT sum(signed_amount) FROM financial_posting WHERE effective_date <= '2026-11-30'))::text`, 'true');
expect('B-5 week: opening + Σ net = every posting up to the end',
  `((${J('w')} ->> 'opening')::numeric + ${NETS('w')} = (SELECT sum(signed_amount) FROM financial_posting WHERE effective_date <= '2026-11-15'))::text`, 'true');
expect('B-6 weeks start on Monday', `(SELECT bool_and(extract(isodow FROM (x ->> 'period')::date) = 1) FROM jsonb_array_elements(${J('w')} -> 'net') x)::text`, 'true');
expect('B-7 per period too: rows = net', `(SELECT bool_and(abs(${ROWS('w', "(y ->> 'period') = (x ->> 'period')")} - (x ->> 'net')::numeric) < 0.005) FROM jsonb_array_elements(${J('w')} -> 'net') x)::text`, 'true');
expect('B-8 no transfer is income nor expense', `(SELECT count(*) FROM jsonb_array_elements(${J('m')} -> 'rows') y WHERE y ->> 'tipo' = 'TRANSFERENCIA')::text`, '0');
expect('B-9 a "Clasificación de salida" is never income', `(SELECT count(*) FROM jsonb_array_elements(${J('m')} -> 'rows') y WHERE y ->> 'tipo' = 'INGRESO' AND y ->> 'grupo' = 'Clasificación de salida')::text`, '0');
expect('B-10 the expense paid today lands on its group / subcategory (−12.345)',
  `(SELECT (y ->> 'grupo') || '|' || (y ->> 'sub') || '|' || (y ->> 'amount') FROM jsonb_array_elements(${J('m')} -> 'rows') y WHERE y ->> 'sub' = 'Categoría 0122')`, 'Otros|Categoría 0122|-12345.00');

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
