#!/usr/bin/env node
/**
 * 0133 — the socio of a partner withdrawal set from Todas las operaciones (set_withdrawal_socio; its compensations follow; audited)
 * and the list showing it (Categoría «Retiros de socios», Subcategoría the socio). LOCAL TEST DATABASE ONLY; one transaction,
 * rolled back. If 0133 is not yet in the ledger it is applied inside that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/retiro_socio_0133.test.mjs
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

const FILE = '0133_retiro_socio_desde_tabla.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0133-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0133-0000-0000-00000000000b';
const OPER2 = 'aaaaaaaa-0133-0000-0000-00000000000c';
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0133')) AS has_0133 \\gset
\\if :has_0133
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'prod-0133-admin@test.local', 'ADMIN'), ('${OPER}', 'prod-0133-oper@test.local', 'OPERATOR'), ('${OPER2}', 'prod-0133-oper2@test.local', 'OPERATOR');
INSERT INTO sheds (nombre) VALUES ('Galpón 0131');
INSERT INTO flocks (shed_id, entry_date, initial_population, estado) SELECT id, '2026-10-01', 1000, 'ACTIVE' FROM sheds WHERE nombre = 'Galpón 0131';
INSERT INTO sheds (nombre) VALUES ('Galpón 0131 cerrado');
INSERT INTO flocks (shed_id, entry_date, initial_population, exit_date) SELECT id, '2026-04-01', 50, '2026-10-31' FROM sheds WHERE nombre = 'Galpón 0131 cerrado';`);

const CAJA = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo ORDER BY id LIMIT 1)`;
const SOCIO1 = `(SELECT c.id FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE g.kind = 'OWNER_WITHDRAWAL' ORDER BY c.nombre LIMIT 1)`;
const SOCIO2 = `(SELECT c.id FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE g.kind = 'OWNER_WITHDRAWAL' ORDER BY c.nombre DESC LIMIT 1)`;
const NO_SOCIO = `(SELECT c.id FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE g.kind <> 'OWNER_WITHDRAWAL' ORDER BY c.id LIMIT 1)`;
const ADM2 = (call, key) => as('authenticated', ADMIN, call, key);
const W1OP = `(SELECT (v->>'financial_operation_id')::bigint FROM res WHERE k = 'w1')`;
const W1EV = `(SELECT (v->>'management_event_id')::uuid FROM res WHERE k = 'w1')`;
const FILA = `(SELECT e FROM jsonb_array_elements(substr(pg_temp.run_as('authenticated', '${ADMIN}', 'SELECT fin_operation_list(p_search => ''T0133-retiro'', p_limit => 100)::text', NULL), 4)::jsonb->'rows') e WHERE (e->>'operation_id')::bigint = ${W1OP})`;

expect('F0 a partner withdrawal without socio (as the Mercado Pago cell records it)',
  ADM2(`SELECT register_management_event('RETIRO', '2026-11-17', 1000, 'T0133-W1', 'T0133-retiro de prueba', ${P(CAJA)}::uuid)::text`, 'w1'), 'OK:%financial_operation_id%');
expect('F1 … and a compensation of it', ADM2(`SELECT register_management_event('RETIRO', '2026-11-17', 200, 'T0133-W1C', 'T0133-retiro devuelto', ${P(CAJA)}::uuid, ${P(W1EV)}::uuid)::text`), 'OK:%');
expect('F2 the list shows it as a withdrawal without socio (key «retiro», no subcategory)',
  `(SELECT (${FILA}->'retiro'->>'event_id' IS NOT NULL)::text || '|' || coalesce(${FILA}->>'subcategory', '-') || '|' || coalesce(${FILA}->'retiro'->>'socio_id', '-'))`, 'true|-|-');
expect('F3 an OPERATOR cannot set the socio', as('authenticated', OPER, `SELECT set_withdrawal_socio(${P(W1OP)}::bigint, ${P(SOCIO1)}::uuid)::text`), 'ERR:FORBIDDEN%');
expect('F4 a subcategory that is not a socio is refused', ADM2(`SELECT set_withdrawal_socio(${P(W1OP)}::bigint, ${P(NO_SOCIO)}::uuid)::text`), 'ERR:INVALID_SOCIO%');
expect('F5 the socio is set', ADM2(`SELECT set_withdrawal_socio(${P(W1OP)}::bigint, ${P(SOCIO1)}::uuid, 'era de Fran')::text`), 'OK:%"changed": true%');
expect('F6 … on the withdrawal and on its compensation (the same socio)',
  `(SELECT count(*)::text FROM management_event WHERE (id = ${W1EV} OR compensates_event_id = ${W1EV}) AND socio_category_id = ${SOCIO1})`, '2');
expect('F7 the list: Categoría «Retiros de socios»-group, Subcategoría the socio, the key carries it',
  `(SELECT (${FILA}->>'subcategory' = (SELECT nombre FROM expense_category WHERE id = ${SOCIO1}))::text || '|' || (${FILA}->>'category' = (SELECT g.nombre FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE c.id = ${SOCIO1}))::text || '|' || (${FILA}->'retiro'->>'socio_id' = ${SOCIO1}::text)::text)`,
  'true|true|true');
expect('F8 the category filter finds it', `(SELECT (jsonb_array_length(substr(pg_temp.run_as('authenticated', '${ADMIN}', format('SELECT fin_operation_list(p_search => %L, p_category_id => %L, p_limit => 100)::text', 'T0133-retiro', ${SOCIO1}), NULL), 4)::jsonb->'rows') >= 1)::text)`, 'true');
expect('F9 the same socio again changes nothing', ADM2(`SELECT set_withdrawal_socio(${P(W1OP)}::bigint, ${P(SOCIO1)}::uuid)::text`), 'OK:%"changed": false%');
expect('F10 another socio, then cleared', ADM2(`SELECT set_withdrawal_socio(${P(W1OP)}::bigint, ${P(SOCIO2)}::uuid)::text || set_withdrawal_socio(${P(W1OP)}::bigint, NULL)::text`), 'OK:%');
expect('F11 … audited: three changes with before / after', `(SELECT count(*)::text FROM audit_events WHERE entity_type = 'management_event' AND entity_id = ${W1EV}::text AND action = 'SET_WITHDRAWAL_SOCIO')`, '3');
expect('F12 an operation that is not a withdrawal is refused', ADM2(`SELECT set_withdrawal_socio((SELECT max(id) FROM financial_operation WHERE operation_type::text <> 'OWNER_WITHDRAWAL'), ${P(SOCIO1)}::uuid)::text`), 'ERR:WITHDRAWAL_NOT_FOUND%');
expect('F13 the compensation itself cannot be given a socio apart', ADM2(`SELECT set_withdrawal_socio((SELECT financial_operation_id FROM management_event WHERE compensates_event_id = ${P(W1EV)}::uuid), ${P(SOCIO1)}::uuid)::text`), 'ERR:WITHDRAWAL_NOT_FOUND%');
expect('F14 no amount or posting moved', `(SELECT sum(signed_amount)::text FROM financial_posting WHERE financial_operation_id IN (SELECT financial_operation_id FROM management_event WHERE id = ${W1EV} OR compensates_event_id = ${W1EV}))`, '-800.00');
expect('F15 rights: definer, EXECUTE authenticated only', `(SELECT p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_withdrawal_socio(bigint,uuid,text)'))`, 'true|falsetruefalse');
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
