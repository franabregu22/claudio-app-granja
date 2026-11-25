#!/usr/bin/env node
/**
 * 0131 — Producción: the day registered / edited in one call (reason mandatory, any role), notes, the modifications list and bird
 * counts by their total (only the last one can be deleted). LOCAL TEST DATABASE ONLY; one transaction, rolled back. If 0131 is
 * not yet in the ledger it is applied inside that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/operaciones_sin_par_mp_0132.test.mjs
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

const FILE = '0132_operaciones_sin_par_mp.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0132-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0132-0000-0000-00000000000b';
const OPER2 = 'aaaaaaaa-0132-0000-0000-00000000000c';
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0132')) AS has_0132 \\gset
\\if :has_0132
\\else
\\i /tmp/${FILE}
\\endif
CREATE TEMP TABLE res (k TEXT PRIMARY KEY, v JSONB);
-- [0140] the Mercado Pago cutover closes the older pending outflows without detail: this test checks the classifiable row, so its
-- transaction moves the cutover before every fixture (rolled back)
DO $c$ BEGIN IF to_regprocedure('public.corte_clasificacion_mp()') IS NOT NULL THEN
  EXECUTE $f$CREATE OR REPLACE FUNCTION corte_clasificacion_mp() RETURNS DATE LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $b$ SELECT DATE '2000-01-01' $b$$f$;
END IF; END $c$;
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'prod-0132-admin@test.local', 'ADMIN'), ('${OPER}', 'prod-0132-oper@test.local', 'OPERATOR'), ('${OPER2}', 'prod-0132-oper2@test.local', 'OPERATOR');
INSERT INTO sheds (nombre) VALUES ('Galpón 0131');
INSERT INTO flocks (shed_id, entry_date, initial_population, estado) SELECT id, '2026-10-01', 1000, 'ACTIVE' FROM sheds WHERE nombre = 'Galpón 0131';
INSERT INTO sheds (nombre) VALUES ('Galpón 0131 cerrado');
INSERT INTO flocks (shed_id, entry_date, initial_population, exit_date) SELECT id, '2026-04-01', 50, '2026-10-31' FROM sheds WHERE nombre = 'Galpón 0131 cerrado';`);

const LIST = (args) => `substr(${ADM(`SELECT fin_operation_list(${args})::text`)}, 4)::jsonb`;
add(`CREATE TEMP TABLE resolved AS SELECT p.source_id, p.provisional_operation_id AS prov, r.reversal_operation_id AS rel FROM mp_pending_outflow p JOIN mp_pending_outflow_resolution r ON r.pending_id = p.id;
CREATE TEMP TABLE unresolved AS SELECT p.source_id, p.provisional_operation_id AS prov FROM mp_pending_outflow p WHERE NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id) ORDER BY p.id DESC LIMIT 3;
GRANT SELECT ON resolved, unresolved TO authenticated;`);

expect('E0 the copy holds classified Mercado Pago outflows (the case under test)', `(SELECT (count(*) > 0)::text FROM resolved)`, 'true');
expect('E1 every classified outflow nets to zero: provisional + release',
  `(SELECT count(*)::text FROM resolved x WHERE (SELECT sum(signed_amount) FROM financial_posting WHERE financial_operation_id IN (x.prov, x.rel)) <> 0)`, '0');
add(`DO $d$ DECLARE x RECORD; v JSONB; n INT := 0; m INT := 0; BEGIN
  FOR x IN SELECT * FROM resolved LOOP
    SELECT substr(pg_temp.run_as('authenticated', '${ADMIN}', format('SELECT fin_operation_list(p_search => %L, p_limit => 100)::text', x.source_id), NULL), 4)::jsonb INTO v;
    n := n + (SELECT count(*) FROM jsonb_array_elements(v->'rows') e WHERE (e->>'operation_id')::bigint IN (x.prov, x.rel));
    m := m + (SELECT count(*) FROM jsonb_array_elements(v->'rows') e WHERE e->>'row_kind' = 'OP');
  END LOOP;
  INSERT INTO res VALUES ('classified', jsonb_build_object('hidden_rows_shown', n, 'other_rows', m));
END $d$;`);
expect('E2 searching a classified outflow: neither its provisional nor its release is listed', `(SELECT v->>'hidden_rows_shown' FROM res WHERE k = 'classified')`, '0');
expect('E3 … its classified operation still is', `(SELECT ((v->>'other_rows')::int > 0)::text FROM res WHERE k = 'classified')`, 'true');
add(`DO $d$ DECLARE x RECORD; v JSONB; n INT := 0; BEGIN
  FOR x IN SELECT * FROM unresolved LOOP
    SELECT substr(pg_temp.run_as('authenticated', '${ADMIN}', format('SELECT fin_operation_list(p_search => %L, p_limit => 100)::text', x.source_id), NULL), 4)::jsonb INTO v;
    n := n + (SELECT count(*) FROM jsonb_array_elements(v->'rows') e WHERE (e->>'operation_id')::bigint = x.prov AND e->>'clasificacion' = 'MP_SIN_CLASIFICAR'
                AND e->>'concepto' = 'Salida MP sin clasificar' AND e->>'mp_source_id' = x.source_id);
  END LOOP;
  INSERT INTO res VALUES ('unresolved', to_jsonb(n));
END $d$;`);
add(`DO $d$ DECLARE v JSONB; p INT := 0; BEGIN
  -- every listed row of the copy (pages of 100): the concepts as shown
  CREATE TEMP TABLE conceptos (concepto TEXT, kind TEXT);
  LOOP
    SELECT substr(pg_temp.run_as('authenticated', '${ADMIN}', format('SELECT fin_operation_list(p_limit => 100, p_offset => %s)::text', p * 100), NULL), 4)::jsonb INTO v;
    INSERT INTO conceptos SELECT e->>'concepto', e->>'row_kind' FROM jsonb_array_elements(v->'rows') e;
    EXIT WHEN jsonb_array_length(v->'rows') < 100 OR p > 200;
    p := p + 1;
  END LOOP;
END $d$;`);
expect('E9 no row reads the generic «Cobro Mercado Pago» any more', `(SELECT count(*)::text FROM conceptos WHERE concepto = 'Cobro Mercado Pago')`, '0');
expect('E10 Mercado Pago inflows say what they are', `(SELECT (count(*) > 0)::text FROM conceptos WHERE concepto ~ '^(Rendimiento MP|Transferencia recibida MP|Cobro con tarjeta MP|Cobro MP)')`, 'true');
expect('E11 no concept carries internal references (ADR notes, «histórico», statement lines, «Owner …:»)',
  `(SELECT count(*)::text FROM conceptos WHERE concepto ~* '(ADR-?\\d|histórico|\\(línea|^Owner |^Meta [A-Z]:|pendiente de clasificar \\()')`, '0');
expect('E4 an outflow still to classify keeps its row, classifiable from its cell (short concept, its SOURCE_ID in mp_source_id)', `(SELECT (v::text::int = (SELECT count(*) FROM unresolved))::text FROM res WHERE k = 'unresolved')`, 'true');
expect('E5 no release («salida clasificada») is listed at all',
  `(SELECT (${LIST("p_search => 'MP-PENDING-RELEASE', p_limit => 1")})->>'total')`, '0');
expect('E6 the provisional rows listed are exactly the outflows still to classify',
  `(SELECT ((${LIST("p_search => 'MP-PENDING:', p_limit => 1")})->>'total')::int = (SELECT count(*) FROM mp_pending_outflow p WHERE NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id)))::text`, 'true');
expect('E7 an OPERATOR is still refused', as('authenticated', OPER, 'SELECT fin_operation_list()::text'), 'ERR:FORBIDDEN%');
// one overload (0137 widened the identity with p_comprobante): rights as always
expect('E8 one overload; rights unchanged: definer, owner postgres, EXECUTE authenticated only',
  `(SELECT count(*) || '|' || bool_and(p.prosecdef) || '|' || min(pg_get_userbyid(p.proowner)) || '|' || bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE')) || bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) || bool_and(NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.proname = 'fin_operation_list' AND p.pronamespace = 'public'::regnamespace)`,
  '1|true|postgres|truetruetrue');
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
