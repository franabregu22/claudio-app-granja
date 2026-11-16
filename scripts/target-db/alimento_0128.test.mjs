#!/usr/bin/env node
/**
 * 0128 (alimento-balanceado-v1) — the same ingredient once per section (Premezcla / Macronutrientes) of a formula version.
 * LOCAL TEST DATABASE ONLY; everything runs inside ONE transaction that is rolled back. If 0125 is not yet in the
 * ledger it is applied inside that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/alimento_0125.test.mjs
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

const FILE = '0128_alimento_ingrediente_por_seccion.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0128-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0128-0000-0000-00000000000b';
const P = (expr) => `{{${expr}}}`;           // replaced by the quoted value
const R = (expr) => `[[${expr}]]`;           // replaced by the raw value (inside JSON literals)

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);

const T1 = `(SELECT id FROM feed_type WHERE nombre = 'Ponedoras 0128 Fase I')`;
const T2 = `(SELECT id FROM feed_type WHERE nombre = 'Ponedoras 0128 Recria')`;
const ING = (n) => `(SELECT id FROM feed_ingredient WHERE nombre = 'Ing 0128 ${n}')`;
const publish = (type, from, lines, comment = null) =>
  `SELECT publish_feed_formula_version(p_feed_type_id => ${P(type)}::uuid, p_effective_from => ${lit(from)}::date, p_lines => ${lit(lines)}::jsonb, p_comment => ${lit(comment)})::text`;
const V = (type, n) => `(SELECT id FROM feed_formula_version WHERE feed_type_id = ${type} AND version = ${n})`;

// ── harness ─────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0128')) AS has_0128 \\gset
\\if :has_0128
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'alimento-0128-admin@test.local', 'ADMIN'), ('${OPER}', 'alimento-0128-oper@test.local', 'OPERATOR');
-- the module's close checks every ACTIVE feed type: the test runs with its own two types only
UPDATE feed_type SET activo = false WHERE activo;
INSERT INTO feed_type (nombre, feed_category) VALUES ('Ponedoras 0128 Fase I', 'LAYER'), ('Ponedoras 0128 Recria', 'PULLET');
INSERT INTO feed_ingredient (nombre) VALUES ('Ing 0128 Maiz'), ('Ing 0128 Soja'), ('Ing 0128 Metionina');`);

const MIX = (sec1, sec2) => `[{"ingredient_id":"${R(ING('Metionina'))}","quantity_kg":0.29,"section":"${sec1}"},`
  + `{"ingredient_id":"${R(ING('Metionina'))}","quantity_kg":10,"section":"${sec2}"},{"ingredient_id":"${R(ING('Maiz'))}","quantity_kg":189.71,"section":"MACRO"}]`;
expect('A1 the same ingredient in Premezcla and in Macronutrientes is accepted', ADM(publish(T1, '2026-08-01', MIX('PREMIX', 'MACRO'))), 'OK:%"line_count": 3%');
expect('A2 … both lines stored, one per section', `(SELECT string_agg(section || '=' || quantity_kg, ',' ORDER BY section) FROM feed_formula_line WHERE formula_version_id = ${V(T1, 1)} AND ingredient_id = ${ING('Metionina')})`, 'PREMIX=0.290,MACRO=10.000');
expect('A3 the same ingredient twice in ONE section is still refused', ADM(publish(T2, '2026-08-01', MIX('MACRO', 'MACRO'))), 'ERR:DUPLICATE_INGREDIENT%MACRO%');
expect('A4 the uniqueness is per version, ingredient and section', `(SELECT count(*) FROM pg_constraint WHERE conname = 'feed_formula_line_version_ingredient_section_key') || '|' || (SELECT count(*) FROM pg_constraint WHERE conname = 'feed_formula_line_formula_version_id_ingredient_id_key')`, '1|0');
expect('A5 the safe composition view shows both lines to OPERATOR', `pg_temp.read_as('${OPER}', ${lit(`SELECT count(*)::text FROM feed_formula_line_safe s JOIN feed_formula_version v ON v.id = s.formula_version_id JOIN feed_type t ON t.id = v.feed_type_id WHERE t.nombre = 'Ponedoras 0128 Fase I'`)})`, '3');
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
