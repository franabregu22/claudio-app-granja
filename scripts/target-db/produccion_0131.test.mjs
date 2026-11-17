#!/usr/bin/env node
/**
 * 0131 — Producción: the day registered / edited in one call (reason mandatory, any role), notes, the modifications list and bird
 * counts by their total (only the last one can be deleted). LOCAL TEST DATABASE ONLY; one transaction, rolled back. If 0131 is
 * not yet in the ledger it is applied inside that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/produccion_0131.test.mjs
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

const FILE = '0131_produccion_edicion_y_conteos.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0131-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0131-0000-0000-00000000000b';
const OPER2 = 'aaaaaaaa-0131-0000-0000-00000000000c';
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0131')) AS has_0131 \\gset
\\if :has_0131
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'prod-0131-admin@test.local', 'ADMIN'), ('${OPER}', 'prod-0131-oper@test.local', 'OPERATOR'), ('${OPER2}', 'prod-0131-oper2@test.local', 'OPERATOR');
INSERT INTO sheds (nombre) VALUES ('Galpón 0131');
INSERT INTO flocks (shed_id, entry_date, initial_population, estado) SELECT id, '2026-10-01', 1000, 'ACTIVE' FROM sheds WHERE nombre = 'Galpón 0131';
INSERT INTO sheds (nombre) VALUES ('Galpón 0131 cerrado');
INSERT INTO flocks (shed_id, entry_date, initial_population, exit_date) SELECT id, '2026-04-01', 50, '2026-10-31' FROM sheds WHERE nombre = 'Galpón 0131 cerrado';`);

const FL = `(SELECT f.id FROM flocks f JOIN sheds s ON s.id = f.shed_id WHERE s.nombre = 'Galpón 0131')`;
const OP = (uid, call, key) => as('authenticated', uid, call, key);
const POP = (d) => `(SELECT population FROM report_flock_day WHERE flock_id = ${FL} AND business_date = '${d}')`;
const LIST = (uid, call) => `substr(${OP(uid, call)}, 4)::jsonb`;
const CNT = (k) => P(`(SELECT (v->>'count_id')::bigint FROM res WHERE k = '${k}')`);
add(`UPDATE perfiles SET nombre = 'Ana', apellido = 'Oper' WHERE id = '${OPER}';`);

expect('C1 OPERATOR registers the day in one call (production + mortality + note)',
  OP(OPER, `SELECT register_production_day(${P(FL)}::uuid, '2026-11-10', 900, 5, 3, '  junté a la tarde  ')::text`), 'OK:%production_id%');
expect('C2 … the production (dirty 0), the mortality and the trimmed note are there',
  `(SELECT (SELECT eggs_total || '/' || eggs_broken || '/' || eggs_dirty FROM daily_production WHERE flock_id = ${FL} AND is_current) || '|' || (SELECT -delta FROM population_events WHERE flock_id = ${FL} AND event_type = 'MORTALITY' AND is_current) || '|' || (SELECT notes FROM flock_day_note WHERE flock_id = ${FL}))`,
  '900/5/0|3|junté a la tarde');
expect('C3 broken above the total is refused', OP(OPER, `SELECT register_production_day(${P(FL)}::uuid, '2026-11-11', 10, 11, 0, null)::text`), 'ERR:BROKEN_EXCEEDS_TOTAL%');
expect('C4 a day already registered is refused as a whole', OP(OPER, `SELECT register_production_day(${P(FL)}::uuid, '2026-11-10', 1, 0, 9, 'x')::text`), 'ERR:DUPLICATE_PRODUCTION%');
expect('C5 another OPERATOR edits a day it did not record — without reason refused',
  OP(OPER2, `SELECT edit_production_day(${P(FL)}::uuid, '2026-11-10', 910, 4, 5, 'junté a la tarde', null, '')::text`), 'ERR:REASON_REQUIRED%');
expect('C6 … with a reason it is saved', OP(OPER2, `SELECT edit_production_day(${P(FL)}::uuid, '2026-11-10', 910, 4, 5, 'junté a la tarde', null, 'mal contado')::text`), 'OK:%');
expect('C7 … production and mortality got new versions in their chains',
  `(SELECT (SELECT eggs_total || '/' || eggs_broken || '/v' || version_seq FROM daily_production WHERE flock_id = ${FL} AND is_current) || '|' || (SELECT count(*) FROM daily_production WHERE flock_id = ${FL} AND superseded_by IS NOT NULL) || '|' || (SELECT -delta || '/v' || version_seq FROM population_events WHERE flock_id = ${FL} AND event_type = 'MORTALITY' AND is_current) || '|' || (SELECT count(*) FROM population_events WHERE flock_id = ${FL} AND event_type = 'MORTALITY' AND superseded_by IS NOT NULL))`,
  '910/4/v1|1|5/v1|1');
expect('C8 the same values again → NO_CHANGES', OP(OPER2, `SELECT edit_production_day(${P(FL)}::uuid, '2026-11-10', 910, 4, 5, 'junté a la tarde', null, 'otra vez')::text`), 'ERR:NO_CHANGES%');
expect('C9 mortality to 0 and the note removed', OP(ADMIN, `SELECT edit_production_day(${P(FL)}::uuid, '2026-11-10', 910, 4, 0, '', null, 'no murieron')::text`), 'OK:%');
expect('C10 … no current mortality, no note; population back to 1000',
  `(SELECT (SELECT count(*) FROM population_events WHERE flock_id = ${FL} AND event_type = 'MORTALITY' AND is_current) || '|' || (SELECT count(*) FROM flock_day_note WHERE flock_id = ${FL}) || '|' || ${POP('2026-11-10')})`, '0|0|1000');
expect('C11 mortality from 0 again (a new event after the retired one)', OP(OPER, `SELECT edit_production_day(${P(FL)}::uuid, '2026-11-10', 910, 4, 2, null, null, 'aparecieron 2')::text`), 'OK:%');
expect('C12 … version 2, population 998', `(SELECT (SELECT -delta || '/v' || version_seq FROM population_events WHERE flock_id = ${FL} AND event_type = 'MORTALITY' AND is_current) || '|' || ${POP('2026-11-10')})`, '2/v2|998');
expect('C13 the eggs of a day with production cannot be emptied', OP(OPER, `SELECT edit_production_day(${P(FL)}::uuid, '2026-11-10', null, 0, 2, null, null, 'x')::text`), 'ERR:EGGS_REQUIRED%');
expect('C14 a day with nothing cannot be edited', OP(OPER, `SELECT edit_production_day(${P(FL)}::uuid, '2026-11-12', null, 0, 0, null, null, 'x')::text`), 'ERR:DAY_NOT_FOUND%');
expect('C15 a day without production gets it by editing', OP(OPER, `SELECT edit_production_day(${P(FL)}::uuid, '2026-11-12', 800, 0, 1, null, null, 'faltaba la producción')::text`), 'OK:%');
expect('C16 the edits list: actors named (or «No disponible»), before → after',
  `(SELECT string_agg((x->>'actor') || ':' || coalesce(x->'before'->>'eggs_total', '-') || '>' || (x->'after'->>'eggs_total') || ':' || (x->'after'->>'deaths') || ':' || (x->>'reason'), ',' ORDER BY ord) FROM jsonb_array_elements(${LIST(OPER, "SELECT list_production_day_edits('2026-11-01', '2026-11-30')::text")}) WITH ORDINALITY AS t(x, ord))`,
  'No disponible:900>910:5:mal contado,No disponible:910>910:0:no murieron,Ana Oper:910>910:2:aparecieron 2,Ana Oper:->800:1:faltaba la producción');
expect('C17 a closed flock cannot be edited after its exit', OP(ADMIN, `SELECT edit_production_day(${P(`(SELECT f.id FROM flocks f JOIN sheds s ON s.id = f.shed_id WHERE s.nombre = 'Galpón 0131 cerrado')`)}::uuid, '2026-11-10', 1, 0, 0, null, null, 'x')::text`), 'ERR:ACTIVITY_AFTER_FLOCK_EXIT%');

// ── the time of the record ─────────────────────────────────────────────────
expect('T1 the day registered with its time', OP(OPER, `SELECT register_production_day(${P(FL)}::uuid, '2026-11-15', 500, 1, 0, null, '07:45')::text`), 'OK:%"time": "07:45"%');
expect('T2 … stored on the production', `(SELECT recorded_time::text FROM daily_production WHERE flock_id = ${FL} AND production_date = '2026-11-15' AND is_current)`, '07:45:00');
expect('T3 without a time it takes the current one', OP(OPER, `SELECT register_production_day(${P(FL)}::uuid, '2026-11-16', 500, 1, 0, null)::text`), 'OK:%"time": "__:__"%');
expect('T4 only the time edited (reason) → a new version with it', OP(OPER2, `SELECT edit_production_day(${P(FL)}::uuid, '2026-11-15', 500, 1, 0, null, '08:10', 'la hora era otra')::text`), 'OK:%');
expect('T5 … version 1 at 08:10; the edit records the time before / after',
  `(SELECT (SELECT recorded_time || '/v' || version_seq FROM daily_production WHERE flock_id = ${FL} AND production_date = '2026-11-15' AND is_current) || '|' || (SELECT before_values->>'time' || '>' || (after_values->>'time') FROM audit_events WHERE entity_type = 'flock_day' AND entity_id LIKE '%|2026-11-15' ORDER BY id DESC LIMIT 1))`,
  '08:10:00/v1|07:45>08:10');
expect('T6 an edit without a time keeps it', OP(OPER2, `SELECT edit_production_day(${P(FL)}::uuid, '2026-11-15', 501, 1, 0, null, null, 'un huevo más')::text`), 'OK:%');
expect('T7 … still 08:10', `(SELECT recorded_time::text FROM daily_production WHERE flock_id = ${FL} AND production_date = '2026-11-15' AND is_current)`, '08:10:00');

expect('T8 who loaded each day and its time (the first version\'s author, not the editor)',
  `(SELECT string_agg((x->>'date') || ':' || coalesce(x->>'time', '-') || ':' || coalesce(x->>'by', '-'), ',' ORDER BY ord) FROM jsonb_array_elements(${LIST(OPER2, "SELECT list_production_days('2026-11-15', '2026-11-15')::text")}) WITH ORDINALITY AS t(x, ord))`,
  '2026-11-15:08:10:Ana Oper');
expect('T9 a day whose production was first loaded through an edit names that editor',
  `(SELECT x->>'by' FROM jsonb_array_elements(${LIST(OPER, "SELECT list_production_days('2026-11-12', '2026-11-12')::text")}) x)`, 'Ana Oper');

// ── bird counts ─────────────────────────────────────────────────────────────
expect('D1 a count by its total: 990 counted, the system had 997', OP(OPER, `SELECT register_bird_count(${P(FL)}::uuid, '2026-11-13', 990, null)::text`, 'c1'), 'OK:%"computed": 997%"difference": -7%');
expect('D2 … the population is now 990', POP('2026-11-13'), '990');
expect('D3 an equal count leaves no adjustment', OP(OPER2, `SELECT register_bird_count(${P(FL)}::uuid, '2026-11-14', 990, 'repaso')::text`, 'c2'), 'OK:%"difference": 0%');
expect('D4 … its row has no event', `(SELECT coalesce(population_event_id::text, 'none') FROM bird_count WHERE id = (SELECT (v->>'count_id')::bigint FROM res WHERE k = 'c2'))`, 'none');
expect('D5 a count before the last one is refused', OP(OPER, `SELECT register_bird_count(${P(FL)}::uuid, '2026-11-12', 900, null)::text`), 'ERR:COUNT_BEFORE_LAST%');
expect('D6 the first count is not the last: cannot be deleted', OP(OPER, `SELECT void_bird_count(${CNT('c1')}::bigint)::text`), 'ERR:NOT_LAST_COUNT%');
expect('D7 the last one is deleted', OP(OPER, `SELECT void_bird_count(${CNT('c2')}::bigint, 'repetido')::text`), 'OK:%');
expect('D8 … twice → ALREADY_VOIDED', OP(OPER, `SELECT void_bird_count(${CNT('c2')}::bigint)::text`), 'ERR:ALREADY_VOIDED%');
expect('D9 now the first is the last: deleted', OP(ADMIN, `SELECT void_bird_count(${CNT('c1')}::bigint)::text`), 'OK:%');
expect('D10 … population back to 997, the adjustment event retired',
  `(SELECT ${POP('2026-11-13')} || '|' || (SELECT count(*) FROM population_events WHERE flock_id = ${FL} AND event_type = 'COUNT_ADJUSTMENT' AND is_current))`, '997|0');
expect('D11 the counts list: newest first, responsible and who deleted',
  `(SELECT string_agg((x->>'counted') || ':' || (x->>'difference') || ':' || (x->>'by') || ':' || coalesce(x->>'voided_by', '-'), ',' ORDER BY ord) FROM jsonb_array_elements(${LIST(OPER2, `SELECT list_bird_counts(${P(FL)}::uuid)::text`)}) WITH ORDINALITY AS t(x, ord))`,
  '990:0:No disponible:Ana Oper,990:-7:Ana Oper:No disponible');
expect('D12 a negative count is refused', OP(OPER, `SELECT register_bird_count(${P(FL)}::uuid, '2026-11-13', -1, null)::text`), 'ERR:INVALID_QUANTITY%');
expect('D13 the new tables: an operator reads, nobody writes directly',
  `pg_temp.read_as('${OPER}', 'SELECT (SELECT count(*) FROM bird_count) || ''|'' || has_table_privilege(''bird_count'', ''INSERT'') || ''|'' || has_table_privilege(''flock_day_note'', ''UPDATE'')')`, '%|false|false');
expect('D14 an unknown user cannot read the counts', `pg_temp.read_as('aaaaaaaa-0131-0000-0000-0000000000ff', 'SELECT count(*)::text FROM bird_count')`, 'ERR:%');
expect('D15 anon cannot execute the new RPCs', `(SELECT count(*) FROM pg_proc WHERE proname IN ('register_production_day','edit_production_day','list_production_day_edits','list_production_days','register_bird_count','void_bird_count','list_bird_counts') AND has_function_privilege('anon', oid, 'EXECUTE'))`, '0');
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
