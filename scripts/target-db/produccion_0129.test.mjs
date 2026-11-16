#!/usr/bin/env node
/**
 * 0129 (alimento-balanceado-v1) — production without operator↔flock assignments: an OPERATOR with no assignment records
 * production / mortality / count adjustments on any active flock and reads every flock (owner 2026-11-16).
 * LOCAL TEST DATABASE ONLY; everything runs inside ONE transaction that is rolled back. If 0129 is not yet in the
 * ledger it is applied inside that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/produccion_0129.test.mjs
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

const FILE = '0129_produccion_sin_asignaciones.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0129-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0129-0000-0000-00000000000b';
const OPER2 = 'aaaaaaaa-0129-0000-0000-00000000000c';
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0129')) AS has_0129 \\gset
\\if :has_0129
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'prod-0129-admin@test.local', 'ADMIN'), ('${OPER}', 'prod-0129-oper@test.local', 'OPERATOR'), ('${OPER2}', 'prod-0129-oper2@test.local', 'OPERATOR');
INSERT INTO sheds (nombre) VALUES ('Galpón 0129');
INSERT INTO flocks (shed_id, entry_date, initial_population, estado) SELECT id, '2026-10-01', 1000, 'ACTIVE' FROM sheds WHERE nombre = 'Galpón 0129';
INSERT INTO sheds (nombre) VALUES ('Galpón 0129 cerrado');
INSERT INTO flocks (shed_id, entry_date, initial_population, exit_date) SELECT id, '2026-04-01', 50, '2026-10-31' FROM sheds WHERE nombre = 'Galpón 0129 cerrado';`);

const FL = `(SELECT f.id FROM flocks f JOIN sheds s ON s.id = f.shed_id WHERE s.nombre = 'Galpón 0129')`;
const OP = (uid, call, key) => as('authenticated', uid, call, key);
expect('B0 the operator has no assignment at all', `(SELECT count(*) FROM operator_assignments WHERE operator_id = '${OPER}')`, '0');
expect('B1 OPERATOR records production on an unassigned active flock', OP(OPER, `SELECT register_daily_production(${P(FL)}::uuid, '2026-11-10', 900, 5, 3)::text`, 'prod'), 'OK:%production_id%');
expect('B2 … mortality', OP(OPER, `SELECT register_mortality(${P(FL)}::uuid, '2026-11-10', 2)::text`), 'OK:%');
expect('B3 … a count adjustment', OP(OPER, `SELECT register_count_adjustment(${P(FL)}::uuid, '2026-11-10', -1, 'recuento')::text`), 'OK:%');
expect('B4 … and rectifies its own production', OP(OPER, `SELECT rectify_daily_production(${P(`(SELECT v->>'production_id' FROM res WHERE k = 'prod')`)}::uuid, 910, 5, 3, 'corrección')::text`, 'rect'), 'OK:%new_id%');
expect('B5 another OPERATOR still cannot rectify it (NOT_OWN_RECORD kept)', OP(OPER2, `SELECT rectify_daily_production(${P(`(SELECT v->>'new_id' FROM res WHERE k = 'rect')`)}::uuid, 920, 5, 3, 'otro')::text`), 'ERR:NOT_OWN_RECORD%');
expect('B6 the operator reads the flock, its production and its events', `pg_temp.read_as('${OPER2}', ${lit(`SELECT (SELECT count(*) FROM flocks f JOIN sheds s ON s.id = f.shed_id WHERE s.nombre = 'Galpón 0129') || '|' || (SELECT count(*) FROM daily_production d JOIN flocks f ON f.id = d.flock_id JOIN sheds s ON s.id = f.shed_id WHERE s.nombre = 'Galpón 0129' AND d.is_current) || '|' || (SELECT count(*) FROM population_events e JOIN flocks f ON f.id = e.flock_id JOIN sheds s ON s.id = f.shed_id WHERE s.nombre = 'Galpón 0129')`)})`, '1|1|%');
expect('B7 activity after the flock exit date is still refused (invariant 29 kept)', OP(OPER, `SELECT register_daily_production(${P(`(SELECT f.id FROM flocks f JOIN sheds s ON s.id = f.shed_id WHERE s.nombre = 'Galpón 0129 cerrado')`)}::uuid, '2026-11-10', 900)::text`), 'ERR:ACTIVITY_AFTER_FLOCK_EXIT%');
expect('B8 only close_flock still touches operator_assignments', `(SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosrc LIKE '%operator_assignments%')`, 'close_flock');
expect('B9 no policy reads operator_assignments', `(SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND (qual LIKE '%operator_assignments%' OR with_check LIKE '%operator_assignments%'))`, '0');
expect('B10 an unknown user still cannot read flocks (role-only policy, not open)', `pg_temp.read_as('aaaaaaaa-0129-0000-0000-0000000000ff', 'SELECT count(*)::text FROM flocks')`, 'ERR:%');
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
