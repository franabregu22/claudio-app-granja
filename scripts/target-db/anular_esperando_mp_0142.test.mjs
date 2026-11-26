#!/usr/bin/env node
/**
 * 0142 — anular un gasto que espera su movimiento de Mercado Pago (the owner's duplicate Gasoil of 17/11): annul_expense accepts an
 * expense paid with Mercado Pago whose movement is not linked yet; fin_purchase_mp_link / fin_operation_list leave it out; a linked
 * one is still paid; an annulled one is never linked (guard). LOCAL TEST DATABASE ONLY; one transaction, rolled back. 0142 is applied
 * inside it when not yet in the ledger.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/anular_esperando_mp_0142.test.mjs
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

const FILES = ['0142_anular_gasto_esperando_mp.sql'];
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0142-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0142-0000-0000-00000000000b';
const C_MAIZ = 'cccccccc-0142-0000-0000-0000000000c1';
const C_SOJA = 'cccccccc-0142-0000-0000-0000000000c2';
const C_SAL = 'cccccccc-0142-0000-0000-0000000000c5';
const C_FLETE = 'cccccccc-0142-0000-0000-0000000000c3';
const C_OTRA = 'cccccccc-0142-0000-0000-0000000000c4';
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

add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0142')) AS has_0142 \\gset
\\if :has_0142
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'mp-0142-admin@test.local', 'ADMIN'), ('${OPER}', 'mp-0142-oper@test.local', 'OPERATOR');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES
  ('${C_MAIZ}', 'Gasoil 0142', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));`);

// ── A. Un gasto pagado con Mercado Pago que espera su movimiento ───────────
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
add(`SELECT ${ADM(`SELECT register_casual_purchase_mp_pending(p_economic_date => '2026-11-17'::date, p_amount_net => 93026.93, p_amount_total => 93026.93, p_expense_category_id => '${C_MAIZ}'::uuid, p_concept => 'Gasoil 0142', p_nature => 'OPERATING', p_idempotency_key => 'G-0142-A', p_mp_account_id => ${P(MPACC)}::uuid, p_origin => 'ERP')::text`, 'dup')};`);
const ROOT = `(SELECT purchase_chain_root(id) FROM purchases WHERE idempotency_key = 'G-0142-A' LIMIT 1)`;
const PID = `(SELECT id FROM purchases WHERE is_current AND purchase_chain_root(id) = ${ROOT})`;
expect('A0 registered, waiting for its movement', readAdmin(`SELECT status FROM fin_purchase_mp_link WHERE purchase_root_id = ${ROOT}`), 'PENDIENTE_VINCULACION_MP');
const ANUL = (k, pid, who = ADM) => who(`SELECT annul_expense(${P(pid)}::uuid, 'Duplicado: la salida ya se clasificó', '${k}')::text`);
const OPL = readAdmin(`SELECT count(*)::text FROM jsonb_array_elements(fin_operation_list(p_from => '2026-11-17', p_to => '2026-11-17', p_limit => 100) -> 'rows') r WHERE r ->> 'purchase_root_id' = ${ROOT}::text`);
expect('A0b before: a row of Todas las operaciones (pagado con Mercado Pago, esperando su movimiento)', OPL, '1');
expect('A1 OPERATOR cannot annul', ANUL('K-0142-O', PID, OPE), 'ERR:FORBIDDEN%');
expect('A2 annulled (it was waiting: no settlement)', ANUL('K-0142-A', PID), 'OK:%"replayed": false%');
expect('A3 replay by its key', ANUL('K-0142-A', PID), 'OK:%"replayed": true%');
expect('A4 it no longer waits for its movement', readAdmin(`SELECT count(*)::text FROM fin_purchase_mp_link WHERE purchase_root_id = ${ROOT}`), '0');
expect('A5 not a row of Todas las operaciones any more', OPL, '0');
expect('A6 the link row is kept (history) and the audit says it was waiting',
  `(SELECT (SELECT count(*) FROM purchase_mp_link WHERE purchase_root_id = ${ROOT}) || '|' || (before_values ->> 'mp_pending') FROM audit_events WHERE action = 'ANNUL_EXPENSE' AND entity_id = ${ROOT}::text)`, '1|true');
expect('A7 an annulled expense is never linked to a movement (guard)',
  `pg_temp.run_as('postgres', '${ADMIN}', $q$INSERT INTO purchase_mp_settlement (purchase_root_id, purchase_id, source_id, mp_financial_movement_id, financial_operation_id, economic_date, movement_date, amount, idempotency_key, result)
     SELECT ${ROOT}, ${PID}, '1', (SELECT id FROM mp_financial_movement LIMIT 1), (SELECT id FROM financial_operation LIMIT 1), '2026-11-17', '2026-11-17', 1, 'K-0142-G', '{}'::jsonb RETURNING id::text$q$, NULL)`,
  'ERR:EXPENSE_ANNULLED%');

// ── B. Uno ya vinculado sigue pagado ─────────────────────────────────────────
expect('B1 a linked one (paid with its movement) still cannot be annulled',
  `coalesce((SELECT ${ADM(`SELECT annul_expense(${P(`(SELECT purchase_id FROM purchase_mp_settlement ORDER BY id LIMIT 1)`)}::uuid, 'x', 'K-0142-B')::text`)} WHERE EXISTS (SELECT 1 FROM purchase_mp_settlement)), 'ERR:EXPENSE_PAID (no linked one in this database)')`,
  'ERR:EXPENSE_PAID%');

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
