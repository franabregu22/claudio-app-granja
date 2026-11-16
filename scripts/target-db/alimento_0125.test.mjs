#!/usr/bin/env node
/**
 * 0125 (alimento-balanceado-v1) — recetas (secciones, comentario, batch estándar, activar/desactivar, historial),
 * fabricaciones (comentario, mes cerrado) y cierre mensual de stock (orden, conteos, reapertura, reporte mensual).
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

const FILE = '0125_alimento_recetas_fabricaciones_cierre.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0125-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0125-0000-0000-00000000000b';
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;           // replaced by the quoted value
const R = (expr) => `[[${expr}]]`;           // replaced by the raw value (inside JSON literals)

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);
const OPE = (call, key) => as('authenticated', OPER, call, key);

const T1 = `(SELECT id FROM feed_type WHERE nombre = 'Ponedoras 0125 Fase I')`;
const T2 = `(SELECT id FROM feed_type WHERE nombre = 'Ponedoras 0125 Recria')`;
const ING = (n) => `(SELECT id FROM feed_ingredient WHERE nombre = 'Ing 0125 ${n}')`;
const LINES = (maiz) => `[{"ingredient_id":"${R(ING('Maiz'))}","quantity_kg":${maiz},"section":"MACRO"},`
  + `{"ingredient_id":"${R(ING('Soja'))}","quantity_kg":${(199.71 - maiz).toFixed(2)},"section":"MACRO"},`
  + `{"ingredient_id":"${R(ING('Metionina'))}","quantity_kg":0.29,"section":"PREMIX"}]`;
const publish = (type, from, lines, comment = null) =>
  `SELECT publish_feed_formula_version(p_feed_type_id => ${P(type)}::uuid, p_effective_from => ${lit(from)}::date, p_lines => ${lit(lines)}::jsonb, p_comment => ${lit(comment)})::text`;
const V = (type, n) => `(SELECT id FROM feed_formula_version WHERE feed_type_id = ${type} AND version = ${n})`;
const fab = (version, date, kg, key, notes = null) =>
  `SELECT register_feed_manufacturing(p_formula_version_id => ${P(version)}::uuid, p_manufacturing_date => ${lit(date)}::date, p_quantity_kg => ${kg}, p_idempotency_key => ${lit(key)}, p_notes => ${lit(notes)})::text`;
const close = (period, c1, c2, comment = null) =>
  `SELECT close_feed_month(${lit(period)}::date, ('[{"feed_type_id":"' || ${P(T1)} || '","quantity_kg":${c1}},{"feed_type_id":"' || ${P(T2)} || '","quantity_kg":${c2}}]')::jsonb, ${lit(comment)})::text`;
const MONTH = (type, period, col) => `(SELECT coalesce(${col}::text, 'null') FROM report_feed_month WHERE feed_type_id = ${type} AND period = '${period}')`;
const asAdminRead = (q) => `pg_temp.read_as('${ADMIN}', ${lit(q)})`;

// ── harness ─────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0125')) AS has_0125 \\gset
\\if :has_0125
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'alimento-0125-admin@test.local', 'ADMIN'), ('${OPER}', 'alimento-0125-oper@test.local', 'OPERATOR');
-- the module's close checks every ACTIVE feed type: the test runs with its own two types only
UPDATE feed_type SET activo = false WHERE activo;
INSERT INTO feed_type (nombre, feed_category) VALUES ('Ponedoras 0125 Fase I', 'LAYER'), ('Ponedoras 0125 Recria', 'PULLET');
INSERT INTO feed_ingredient (nombre) VALUES ('Ing 0125 Maiz'), ('Ing 0125 Soja'), ('Ing 0125 Metionina');`);

// ── A. Recetas ──────────────────────────────────────────────────────────────
expect('A1 publish v1 with sections and a comment', ADM(publish(T1, '2026-08-01', LINES(120), 'Primera versión'), 'v1'), 'OK:%"version": 1%');
expect('A2 premix line keeps 3 decimals and its section', `(SELECT quantity_kg || '|' || section FROM feed_formula_line WHERE formula_version_id = ${V(T1, 1)} AND ingredient_id = ${ING('Metionina')})`, '0.290|PREMIX');
expect('A3 the comment is stored on the version', `(SELECT comment FROM feed_formula_version WHERE id = ${V(T1, 1)})`, 'Primera versión');
expect('A4 a line without section defaults to MACRO (4-argument named call still works)',
  ADM(`SELECT publish_feed_formula_version(p_feed_type_id => ${P(T2)}::uuid, p_effective_from => '2026-08-01'::date, p_lines => '[{"ingredient_id":"${R(ING('Maiz'))}","quantity_kg":150}]'::jsonb)::text`), 'OK:%');
expect('A5 … MACRO', `(SELECT string_agg(section::text, ',') FROM feed_formula_line WHERE formula_version_id = ${V(T2, 1)})`, 'MACRO');
expect('A6 an unknown section is refused', ADM(publish(T1, '2026-12-01', LINES(110).replace('"PREMIX"', '"MICRO"'))), 'ERR:INVALID_SECTION%');
expect('A7 OPERATOR cannot publish', OPE(publish(T1, '2026-12-01', LINES(110))), 'ERR:FORBIDDEN%');
expect('A8 the safe composition view shows the section to OPERATOR', `pg_temp.read_as('${OPER}', ${lit(`SELECT string_agg(s.section::text, ',' ORDER BY s.section, s.quantity_kg) FROM feed_formula_line_safe s
  JOIN feed_formula_version v ON v.id = s.formula_version_id JOIN feed_type t ON t.id = v.feed_type_id WHERE t.nombre = 'Ponedoras 0125 Fase I' AND v.version = 1`)})`, 'PREMIX,MACRO,MACRO');
expect('A9 set the version comment', ADM(`SELECT set_feed_formula_comment(${P(V(T1, 1))}::uuid, 'Más conchilla')::text`), 'OK:%Más conchilla%');
expect('A10 the same comment again is NO_CHANGES', ADM(`SELECT set_feed_formula_comment(${P(V(T1, 1))}::uuid, ' Más conchilla ')::text`), 'ERR:NO_CHANGES%');
expect('A11 OPERATOR cannot edit a comment', OPE(`SELECT set_feed_formula_comment(${P(V(T1, 1))}::uuid, 'x')::text`), 'ERR:FORBIDDEN%');
expect('A12 standard batch 200 → 250 (no new version)', ADM(`SELECT set_feed_type_standard_batch(${P(T1)}::uuid, 250)::text`), 'OK:%250%');
expect('A13 … still one version, its lines untouched', `(SELECT count(*) || '|' || (SELECT sum(quantity_kg) FROM feed_formula_line WHERE formula_version_id = ${V(T1, 1)}) FROM feed_formula_version WHERE feed_type_id = ${T1})`, '1|200.000');
expect('A14 a zero batch is refused', ADM(`SELECT set_feed_type_standard_batch(${P(T1)}::uuid, 0)::text`), 'ERR:INVALID_QUANTITY%');
expect('A15 publish v2 (ingredients changed) from 2026-09-01', ADM(publish(T1, '2026-09-01', LINES(118), 'Menos maíz'), 'v2'), 'OK:%"version": 2%');
expect('A16 v1 closes the day before', `(SELECT effective_to::text FROM feed_formula_version WHERE id = ${V(T1, 1)})`, '2026-08-31');

// ── B. Fabricaciones ────────────────────────────────────────────────────────
expect('B1 register with a comment', OPE(fab(V(T1, 2), '2026-09-10', 200, 'K-0125-1', 'Maiz Joaco'), 'f1'), 'OK:%');
expect('B2 … notes stored', `(SELECT notes FROM feed_manufacturing WHERE id = (${RES('f1', 'manufacturing_id')})::uuid)`, 'Maiz Joaco');
expect('B3 rectify with NULL notes keeps the comment', OPE(`SELECT rectify_feed_manufacturing('K-0125-1R', ${P(`(${RES('f1', 'manufacturing_id')})::uuid`)}::uuid, 250, 'Eran 250')::text`, 'f1r'), 'OK:%');
expect('B4 … kept', `(SELECT notes || '|' || quantity_kg FROM feed_manufacturing WHERE id = (${RES('f1r', 'manufacturing_id')})::uuid)`, 'Maiz Joaco|250.000');
expect('B5 rectify with \'\' clears it', ADM(`SELECT rectify_feed_manufacturing(p_idempotency_key => 'K-0125-1R2', p_manufacturing_id => ${P(`(${RES('f1r', 'manufacturing_id')})::uuid`)}::uuid, p_quantity_kg => 250, p_reason => 'sin nota', p_notes => '')::text`, 'f1r2'), 'OK:%');
expect('B6 … cleared', `(SELECT coalesce(notes, 'null') FROM feed_manufacturing WHERE id = (${RES('f1r2', 'manufacturing_id')})::uuid)`, 'null');
add(`SELECT ${OPE(fab(V(T1, 1), '2026-08-12', 400, 'K-0125-2'))};
SELECT ${OPE(fab(V(T2, 1), '2026-08-20', 300, 'K-0125-3'))};
SELECT ${OPE(fab(V(T1, 2), '2026-10-05', 600, 'K-0125-4'), 'f4')};
SELECT ${OPE(fab(V(T2, 1), '2026-10-07', 450, 'K-0125-5'))};`);

// ── C. Cierre mensual ───────────────────────────────────────────────────────
expect('C1 a month that has not ended cannot close', ADM(close('2026-11-01', 100, 100)), 'ERR:FEED_MONTH_NOT_ENDED%');
expect('C2 OPERATOR cannot close', OPE(close('2026-08-01', 100, 50)), 'ERR:FORBIDDEN%');
expect('C3 a missing active type is refused', ADM(`SELECT close_feed_month('2026-08-01'::date, ('[{"feed_type_id":"' || ${P(T1)} || '","quantity_kg":100}]')::jsonb)::text`), 'ERR:FEED_COUNT_MISSING%Recria%');
expect('C4 a period that is not the 1st is refused', ADM(close('2026-08-15', 100, 50)), 'ERR:INVALID_PERIOD%');
expect('C5 first close (August)', ADM(close('2026-08-01', 150, 60, 'Primer cierre')), 'OK:%CLOSED%');
expect('C6 skipping September is refused', ADM(close('2026-10-01', 200, 90)), 'ERR:FEED_PREVIOUS_MONTH_OPEN%');
expect('C7 a manufacturing in a closed month is refused', OPE(fab(V(T1, 1), '2026-08-25', 200, 'K-0125-6')), 'ERR:FEED_MONTH_CLOSED%');
expect('C8 September closes', ADM(close('2026-09-01', 120, 40)), 'OK:%');
expect('C9 a rectification in a closed month is refused', ADM(`SELECT rectify_feed_manufacturing('K-0125-1R3', ${P(`(${RES('f1r2', 'manufacturing_id')})::uuid`)}::uuid, 300, 'x')::text`), 'ERR:FEED_MONTH_CLOSED%');
expect('C10 closing an earlier month after a later one is refused', ADM(close('2026-07-01', 0, 0)), 'ERR:FEED_LATER_MONTH_CLOSED%');
expect('C11 October closes', ADM(close('2026-10-01', 200, 90)), 'OK:%');
expect('C12 report: August has no opening (first close) → no consumption', asAdminRead(`SELECT ${MONTH(T1, '2026-08-01', 'opening_kg')} || '|' || ${MONTH(T1, '2026-08-01', 'internal_consumption_kg')}`), 'null|null');
expect('C13 report: September Fase I = 150 + 250 − 120 = 280', asAdminRead(`SELECT ${MONTH(T1, '2026-09-01', 'opening_kg')} || '|' || ${MONTH(T1, '2026-09-01', 'manufactured_kg')} || '|' || ${MONTH(T1, '2026-09-01', 'internal_consumption_kg')}`), '150.000|250.000|280.000');
expect('C14 report: October Recria = 40 + 450 − 90 = 400', asAdminRead(`SELECT ${MONTH(T2, '2026-10-01', 'internal_consumption_kg')}`), '400.000');
expect('C15 OPERATOR reads no stock report', `pg_temp.read_as('${OPER}', 'SELECT count(*)::text FROM report_feed_month')`, '0');
expect('C16 OPERATOR reads which months are closed', `pg_temp.read_as('${OPER}', 'SELECT count(*)::text FROM feed_stock_period WHERE status = ''CLOSED''')`, '3');
expect('C17 reopening September while October is closed is refused', ADM(`SELECT reopen_feed_month('2026-09-01'::date, 'error')::text`), 'ERR:FEED_LATER_MONTH_CLOSED%');
expect('C18 reopen needs a reason', ADM(`SELECT reopen_feed_month('2026-10-01'::date, ' ')::text`), 'ERR:REASON_REQUIRED%');
expect('C19 OPERATOR cannot reopen', OPE(`SELECT reopen_feed_month('2026-10-01'::date, 'x')::text`), 'ERR:FORBIDDEN%');
expect('C20 ADMIN reopens October', ADM(`SELECT reopen_feed_month('2026-10-01'::date, 'faltó una fabricación')::text`), 'OK:%REOPENED%');
expect('C21 a manufacturing in the reopened month is accepted', OPE(fab(V(T1, 2), '2026-10-20', 200, 'K-0125-7')), 'OK:%');
expect('C22 October is not in the report while reopened', asAdminRead(`SELECT count(*)::text FROM report_feed_month WHERE period = '2026-10-01'`), '0');
expect('C23 re-closing October replaces its counts', ADM(close('2026-10-01', 180, 90)), 'OK:%');
expect('C24 … one count per type at 31/10, the new one', `(SELECT count(*) || '|' || max(quantity_kg) FROM feed_inventory_count WHERE feed_type_id = ${T1} AND count_date = '2026-10-31')`, '1|180.000');
expect('C25 report: October Fase I = 120 + 800 − 180 = 740', asAdminRead(`SELECT ${MONTH(T1, '2026-10-01', 'internal_consumption_kg')}`), '740.000');
expect('C26 closing a closed month again is refused', ADM(close('2026-10-01', 1, 1)), 'ERR:FEED_MONTH_ALREADY_CLOSED%');

// ── D. Historial / desactivar ───────────────────────────────────────────────
expect('D1 deactivate Recria records the date', ADM(`SELECT set_feed_type_active(${P(T2)}::uuid, false)::text`), 'OK:%inactive_from%');
expect('D2 … inactive_from is business today', `(SELECT (inactive_from = (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::text FROM feed_type WHERE id = ${T2})`, 'true');
expect('D3 deactivating again is NO_CHANGES', ADM(`SELECT set_feed_type_active(${P(T2)}::uuid, false)::text`), 'ERR:NO_CHANGES%');
expect('D4 recipe history: publishes, comment, batch, deactivate',
  asAdminRead(`SELECT string_agg(action, ',' ORDER BY id) FROM report_feed_recipe_change WHERE feed_type_nombre LIKE 'Ponedoras 0125%'`), 'PUBLISH,PUBLISH,COMMENT,STANDARD_BATCH,PUBLISH,DEACTIVATE');
expect('D5 … with the author name', asAdminRead(`SELECT max(performed_by_name) FROM report_feed_recipe_change WHERE feed_type_nombre LIKE 'Ponedoras 0125%'`), 'alimento-0125-admin@test.local');
expect('D6 the publish keeps previous and new lines (for the change detail)',
  asAdminRead(`SELECT (jsonb_array_length(after_values->'lines') || '|' || jsonb_array_length(after_values->'previous_lines')) FROM report_feed_recipe_change WHERE action = 'PUBLISH' AND (after_values->>'version')::int = 2 AND feed_type_nombre = 'Ponedoras 0125 Fase I'`), '3|3');
expect('D7 OPERATOR reads no recipe history', `pg_temp.read_as('${OPER}', 'SELECT count(*)::text FROM report_feed_recipe_change')`, '0');

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
