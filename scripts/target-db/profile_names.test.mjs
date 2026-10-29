#!/usr/bin/env node
/**
 * LOTE 2A — NOMBRE Y APELLIDO DE USUARIOS (migration 0109). LOCAL TEST DATABASE ONLY.
 *
 * perfiles.nombre / apellido (optional, trimmed, no control characters), set_profile_name (ADMIN only, only these two columns,
 * audited, blank → NULL, no-op when unchanged), privileges and RLS unchanged (no write privilege on perfiles, an OPERATOR reads
 * only its own row), fin_customer_collections.registered_by / reversal_by = the user ids already stored.
 *
 * Everything runs inside ONE transaction that is rolled back. Migrations 0108 / 0109 missing from the ledger are executed first
 * INSIDE that transaction (rolled back too).
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/profile_names.test.mjs
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
const MIG = (f) => resolve(import.meta.dirname, '../../supabase/target-migrations', f);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0109-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0109-0000-0000-00000000000b';
const CLI = 'cccccccc-0109-0000-0000-0000000000a1';
const CAJA = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo LIMIT 1)`;
const P = (expr) => `{{${expr}}}`;
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);
const OPR = (call, key) => as('authenticated', OPER, call, key);
const setName = (id, n, a) => `SELECT set_profile_name(${lit(id)}::uuid, ${lit(n)}, ${lit(a)})::text`;
const AUDITS = `(SELECT count(*) FROM audit_events WHERE entity_type = 'perfiles' AND entity_id = '${OPER}' AND action = 'SET_NAME')`;

add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0108')) AS has_0108,
       (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0109')) AS has_0109 \\gset
\\if :has_0108
\\else
\\i /tmp/0108_collection_reversal.sql
\\endif
\\if :has_0109
\\else
\\i /tmp/0109_profile_names.sql
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
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, p_got, p_like;
  ELSE RAISE NOTICE 'PASS %', p_name; END IF;
END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'lote2a-0109-admin@test.local', 'ADMIN'), ('${OPER}', 'lote2a-0109-oper@test.local', 'OPERATOR');
INSERT INTO clients (id, nombre) VALUES ('${CLI}', 'Cliente 0109');
CREATE TEMP TABLE before_profiles AS SELECT id, email, rol_type, activo FROM perfiles;`);

// ── schema, privileges, RLS ─────────────────────────────────────────────────
// (nothing filled by the migration itself: ADR025_POST_0109 --deployment-check, right after the apply)
expect('nombre / apellido exist and are optional; a new profile has none',
  `(SELECT string_agg(column_name || ':' || is_nullable, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'perfiles' AND column_name IN ('nombre', 'apellido'))
   || '|' || (SELECT count(*) FROM perfiles WHERE id IN ('${ADMIN}', '${OPER}') AND (nombre IS NOT NULL OR apellido IS NOT NULL))`, 'apellido:YES,nombre:YES|0');
expect('no write privilege on perfiles for API roles (table or column)',
  `has_table_privilege('authenticated', 'perfiles', 'INSERT,UPDATE,DELETE')::text || has_column_privilege('authenticated', 'perfiles', 'nombre', 'UPDATE')::text
   || has_table_privilege('anon', 'perfiles', 'SELECT')::text`, 'falsefalsefalse');
expect('a direct UPDATE by an ADMIN through the API is refused (no privilege)', ADM(`UPDATE perfiles SET nombre = 'X' WHERE id = '${OPER}' RETURNING id::text`), 'ERR:permission denied%');
expect('an OPERATOR reads only its own profile (RLS unchanged)', OPR(`SELECT count(*)::text FROM perfiles`), 'OK:1');
expect('an ADMIN reads every profile', ADM(`SELECT (count(*) > 1)::text FROM perfiles`), 'OK:true');
expect('set_profile_name: SECURITY DEFINER, EXECUTE authenticated only', `(SELECT prosecdef::text || has_function_privilege('authenticated', oid, 'EXECUTE')::text || has_function_privilege('anon', oid, 'EXECUTE')::text || has_function_privilege('service_role', oid, 'EXECUTE')::text FROM pg_proc WHERE proname = 'set_profile_name')`, 'truetruefalsefalse');

// ── set_profile_name ────────────────────────────────────────────────────────
expect('OPERATOR cannot set a name (not even its own)', OPR(setName(OPER, 'Juan', 'Pérez')), 'ERR:FORBIDDEN%');
expect('ADMIN sets name: trimmed, inner spaces collapsed', ADM(setName(OPER, '  María   José ', ' Gómez ')), 'OK:%"changed": true%');
expect('… stored', `(SELECT nombre || '|' || apellido FROM perfiles WHERE id = '${OPER}')`, 'María José|Gómez');
expect('… audited with before / after names, by the ADMIN', `(SELECT before_values::text || ' → ' || after_values::text || ' · ' || performed_by FROM audit_events WHERE entity_type = 'perfiles' AND entity_id = '${OPER}' AND action = 'SET_NAME')`,
  `{"nombre": null, "apellido": null} → {"nombre": "María José", "apellido": "Gómez"} · ${ADMIN}`);
expect('unchanged → no-op, no new audit', ADM(setName(OPER, 'María José', 'Gómez')), 'OK:%"changed": false%');
expect('… still one audit row', AUDITS, '1');
expect('blank → NULL (name removed)', ADM(setName(OPER, '   ', 'Gómez')), 'OK:%"changed": true%');
expect('… nombre NULL', `(SELECT coalesce(nombre, 'NULL') || '|' || apellido FROM perfiles WHERE id = '${OPER}')`, 'NULL|Gómez');
expect('too long refused', ADM(setName(OPER, 'x'.repeat(81), 'Gómez')), 'ERR:NAME_TOO_LONG%');
expect('control characters refused', ADM(setName(OPER, `Ju${String.fromCharCode(7)}an`, 'Gómez')), 'ERR:INVALID_NAME%');
expect('unknown profile refused', ADM(setName('aaaaaaaa-0109-0000-0000-0000000000ff', 'A', 'B')), 'ERR:PROFILE_NOT_FOUND%');
expect('the table refuses an untrimmed value written by any path', `pg_temp.run_as('postgres', NULL, 'UPDATE perfiles SET nombre = '' x'' WHERE id = ''${OPER}''', NULL)`, 'ERR:%chk_perfiles_nombre%');
expect('email, role, active flag of every profile unchanged', `(SELECT count(*) FROM perfiles p JOIN before_profiles b USING (id) WHERE (p.email, p.rol_type, p.activo) IS DISTINCT FROM (b.email, b.rol_type, b.activo))`, '0');

// ── who registered / annulled a collection (ids already stored) ─────────────
expect('a collection by the ADMIN', ADM(`SELECT register_collection('${CLI}'::uuid, 1000, 'CASH', 'T0109-C1', '2026-10-10'::date, ${P(CAJA)}::uuid, NULL, 'x')::text`, 'c1'), 'OK:%');
expect('view: registered_by = collections.created_by', ADM(`SELECT registered_by::text || '|' || coalesce(reversal_by::text, '-') FROM fin_customer_collections WHERE row_id = 'C:' || ${P(RES('c1', 'collection_id'))}`), `OK:${ADMIN}|-`);
expect('annul it', ADM(`SELECT reverse_collection(${P(RES('c1', 'collection_id'))}::uuid, 'prueba', 'k-0109')::text`), 'OK:%');
expect('view: reversal_by = collection_reversal.created_by', ADM(`SELECT reversal_by::text FROM fin_customer_collections WHERE row_id = 'C:' || ${P(RES('c1', 'collection_id'))}`), `OK:${ADMIN}`);
expect('view: existing columns first, the two new ones appended last',
  `(SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fin_customer_collections')`,
  '%,reversal_kind,reversal_reason,reversal_at,replacement_of,sales_session_id,registered_by,reversal_by');
add('ROLLBACK;');

// ── run ─────────────────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const containers = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean);
const container = containers.find((c) => (dockerRun(['port', c, '5432/tcp']).stdout || '').includes(`:${target.port}`));
if (!container) { console.error(`  no running supabase_db container mapped to the guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);
for (const f of ['0108_collection_reversal.sql', '0109_profile_names.sql']) {
  const cp = dockerRun(['exec', '-i', container, 'sh', '-c', `cat > /tmp/${f}`], readFileSync(MIG(f), 'utf8'));
  if (cp.status !== 0) { console.error(`  could not copy ${f} into the container`); process.exit(1); }
}
// the guarded local container, and — with FIN_E2E_PROJECT — a disposable project too (e.g. a fresh 0001…0108 + the 0109 file)
const PROJECT = process.env.FIN_E2E_PROJECT ?? '';
const targets = [container];
if (PROJECT && PROJECT !== 'Claudio_app_Granja' && containers.includes(`supabase_db_${PROJECT}`) && `supabase_db_${PROJECT}` !== container) targets.push(`supabase_db_${PROJECT}`);
let pass = 0; let fail = 0;
for (const c of targets) {
  if (c !== container) {
    console.log(`  again on: ${c}`);
    for (const f of ['0108_collection_reversal.sql', '0109_profile_names.sql']) dockerRun(['exec', '-i', c, 'sh', '-c', `cat > /tmp/${f}`], readFileSync(MIG(f), 'utf8'));
  }
  const r = dockerRun(['exec', '-i', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
  const out = `${r.stdout}\n${r.stderr}`.split('\n');
  const lines = out.map((l) => l.replace(/^.*NOTICE:\s*/, '')).filter((l) => /^(PASS|FAIL) /.test(l));
  for (const l of lines) console.log(`    ${l.startsWith('PASS') ? 'OK ' : 'MAL'}  ${c === container ? '' : `[${PROJECT}] `}${l.slice(5)}`);
  pass += lines.filter((l) => l.startsWith('PASS')).length; fail += lines.filter((l) => l.startsWith('FAIL')).length;
  if (r.status !== 0) { console.log(`    MAL  psql aborted on ${c}: ${(out.find((l) => /ERROR/.test(l)) || '').slice(0, 300)}`); fail += 1; }
}
console.log(`  ${pass}/${pass + fail} PASS`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);
