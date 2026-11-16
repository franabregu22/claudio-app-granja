#!/usr/bin/env node
/**
 * 0127 — gastos: etiquetas (purchase_tag, set_purchase_tag, fin_purchase_tag, fin_expense_tag_total).
 * LOCAL TEST DATABASE ONLY; everything runs inside ONE transaction that is rolled back. 0125 / 0126 are applied
 * inside it when not yet in the ledger.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/alimento_0126.test.mjs
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

const FILES = ['0127_gastos_etiquetas.sql'];
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0127-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0127-0000-0000-00000000000b';
const C_OTRA = 'cccccccc-0127-0000-0000-0000000000c4';
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;
const PU = (k) => `(${RES(k, 'purchase_id')})::uuid`;

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);
const OPE = (call, key) => as('authenticated', OPER, call, key);
const readAdmin = (q) => `pg_temp.read_as('${ADMIN}', ${lit(q)})`;
const gasto = (date, total, cat, key) =>
  `SELECT register_pending_expense(${lit(date)}::date, ${total}, ${total}, '${cat}'::uuid, 'Compra 0127', 'OPERATING', ${lit(key)}, NULL, 'Proveedor 0127', '[]'::jsonb, '[]'::jsonb, NULL)::text`;
const TAG = (n) => `(SELECT id FROM projects WHERE nombre = '${n} (0127)')`;
const TOTAL = (n) => readAdmin(`SELECT expenses || '|' || total FROM fin_expense_tag_total WHERE tag_nombre = '${n} (0127)'`);

add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0127')) AS has_0127 \\gset
\\if :has_0127
\\else
\\i /tmp/${FILES[0]}
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'etiquetas-0127-admin@test.local', 'ADMIN'), ('${OPER}', 'etiquetas-0127-oper@test.local', 'OPERATOR');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES ('${C_OTRA}', 'Otra 0127', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));
INSERT INTO projects (nombre) VALUES ('Maíz 2027 (0127)'), ('Galpón 4 (0127)');`);

add(`SELECT ${ADM(gasto('2026-11-03', 300000, C_OTRA, 'G-0127-1'), 'g1')};
SELECT ${ADM(gasto('2026-11-04', 50000, C_OTRA, 'G-0127-2'), 'g2')};
SELECT ${ADM(gasto('2026-11-05', 7000, C_OTRA, 'G-0127-3'), 'g3')};`);
expect('A0 fixtures', `(SELECT count(*) FROM res)`, '3');
expect('A1 a new expense has no tag («Sin etiqueta»)', readAdmin(`SELECT count(*)::text FROM fin_purchase_tag pt JOIN purchases p ON p.id = pt.purchase_id WHERE p.expense_category_id = '${C_OTRA}'`), '0');
expect('A2 tag G1 «Maíz 2027»', ADM(`SELECT set_purchase_tag(${P(PU('g1'))}::uuid, ${P(TAG('Maíz 2027'))}::uuid)::text`), 'OK:%');
expect('A3 tag G2 «Maíz 2027»', ADM(`SELECT set_purchase_tag(${P(PU('g2'))}::uuid, ${P(TAG('Maíz 2027'))}::uuid)::text`), 'OK:%');
expect('A4 the same tag again is NO_CHANGES', ADM(`SELECT set_purchase_tag(${P(PU('g2'))}::uuid, ${P(TAG('Maíz 2027'))}::uuid)::text`), 'ERR:NO_CHANGES%');
expect('A5 total «Maíz 2027» = 2 expenses, 350.000', TOTAL('Maíz 2027'), '2|350000.00');
expect('A5b Todas las operaciones filtered by «Maíz 2027»: 2 rows, −350.000',
  ADM(`SELECT (r->>'total') || '|' || (r->>'importe') FROM (SELECT fin_operation_list(p_tag_id => ${P(TAG('Maíz 2027'))}::uuid, p_limit => 100) AS r) x`), 'OK:2|-350000.00');
expect('A5c … «Sin etiqueta» + search: only G3',
  ADM(`SELECT (r->>'total') || '|' || (r->>'importe') FROM (SELECT fin_operation_list(p_sin_etiqueta => true, p_search => 'Compra 0127', p_limit => 100) AS r) x`), 'OK:1|-7000.00');
expect('A5d … without a tag filter the same search finds the 3', ADM(`SELECT r->>'total' FROM (SELECT fin_operation_list(p_search => 'Compra 0127', p_limit => 100) AS r) x`), 'OK:3');
expect('A6 change G2 to «Galpón 4»', ADM(`SELECT set_purchase_tag(${P(PU('g2'))}::uuid, ${P(TAG('Galpón 4'))}::uuid)::text`), 'OK:%');
expect('A7 … totals move: Maíz 1 / 300.000, Galpón 1 / 50.000', `${TOTAL('Maíz 2027')} || ';' || ${TOTAL('Galpón 4')}`, '1|300000.00;1|50000.00');
expect('A8 remove the tag of G1 (NULL = Sin etiqueta)', ADM(`SELECT set_purchase_tag(${P(PU('g1'))}::uuid, NULL)::text`), 'OK:%');
expect('A9 … «Maíz 2027» has no expenses left', TOTAL('Maíz 2027'), '0|0');
expect('A10 removing an absent tag is NO_CHANGES', ADM(`SELECT set_purchase_tag(${P(PU('g3'))}::uuid, NULL)::text`), 'ERR:NO_CHANGES%');
expect('A11 an unknown tag is refused', ADM(`SELECT set_purchase_tag(${P(PU('g3'))}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)::text`), 'ERR:TAG_NOT_FOUND%');
expect('A12 OPERATOR cannot tag', OPE(`SELECT set_purchase_tag(${P(PU('g3'))}::uuid, ${P(TAG('Galpón 4'))}::uuid)::text`), 'ERR:FORBIDDEN%');
expect('A13 OPERATOR reads no tags', `pg_temp.read_as('${OPER}', 'SELECT count(*)::text FROM fin_purchase_tag')`, '0');
expect('A14 audited: SET, SET, CHANGE, REMOVE', `(SELECT string_agg(action, ',' ORDER BY id) FROM audit_events WHERE entity_type = 'purchase_tag' AND entity_id IN (SELECT purchase_chain_root((v->>'purchase_id')::uuid)::text FROM res))`, 'SET,SET,CHANGE,REMOVE');
expect('A15 an annulled expense leaves the total', ADM(`SELECT annul_expense(${P(PU('g2'))}::uuid, 'error de carga', 'ANUL-0127')::text`), 'OK:%');
expect('A16 … «Galpón 4» back to 0', TOTAL('Galpón 4'), '0|0');
add('ROLLBACK;');

// ── run (rolled back) on the container behind the guarded local URL ─────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const containers = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean);
const container = containers.find((c) => (dockerRun(['port', c, '5432/tcp']).stdout || '').includes(`:${target.port}`));
if (!container) { console.error(`  no running supabase_db container mapped to the guarded port ${target.port}. Run \`supabase start\`.`); process.exit(1); }
console.log(`  container: ${container}`);
for (const f of FILES) {
  const cp = dockerRun(['exec', '-i', container, 'sh', '-c', `cat > /tmp/${f}`], readFileSync(resolve(import.meta.dirname, '../../supabase/target-migrations', f), 'utf8'));
  if (cp.status !== 0) { console.error(`  could not copy ${f} into the container`); process.exit(1); }
}
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
