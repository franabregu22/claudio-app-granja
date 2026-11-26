#!/usr/bin/env node
/**
 * 0141 — quitar un flete asignado: unallocate_feed_freight (ADMIN, audited) frees one allocation of a feed freight so its amount can
 * be allocated anew (the owner's case: 60.000 of a 255.000 freight that was all that invoice's). LOCAL TEST DATABASE ONLY; one
 * transaction, rolled back. 0141 is applied inside it when not yet in the ledger.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/quitar_flete_0141.test.mjs
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

const FILES = ['0141_quitar_flete_asignado.sql'];
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0141-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0141-0000-0000-00000000000b';
const C_MAIZ = 'cccccccc-0141-0000-0000-0000000000c1';
const C_SOJA = 'cccccccc-0141-0000-0000-0000000000c2';
const C_SAL = 'cccccccc-0141-0000-0000-0000000000c5';
const C_FLETE = 'cccccccc-0141-0000-0000-0000000000c3';
const C_OTRA = 'cccccccc-0141-0000-0000-0000000000c4';
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0141')) AS has_0141 \\gset
\\if :has_0141
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'flete-0141-admin@test.local', 'ADMIN'), ('${OPER}', 'flete-0141-oper@test.local', 'OPERATOR');
INSERT INTO feed_ingredient (nombre) VALUES ('Ing 0141 Maiz');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id, feed_ingredient_id, is_feed_freight) VALUES
  ('${C_MAIZ}', 'Maíz 0141', 'DIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'), (SELECT id FROM feed_ingredient WHERE nombre = 'Ing 0141 Maiz'), false),
  ('${C_FLETE}', 'Flete insumos 0141', 'DIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'), NULL, true);`);

// ── A. Un flete de 255.000 asignado mal (60.000) a la única compra ─────────
add(`SELECT ${ADM(`SELECT register_pending_expense('2026-11-13'::date, 1000, 1000, '${C_MAIZ}'::uuid, 'Compra 0141', 'OPERATING', 'G-0141-A', NULL, 'Proveedor 0141', '[]'::jsonb, '[]'::jsonb, NULL)::text`, 'compra')};
SELECT ${ADM(`SELECT register_pending_expense('2026-11-13'::date, 1000, 1000, '${C_MAIZ}'::uuid, 'Otra compra 0141', 'OPERATING', 'G-0141-B', NULL, 'Proveedor 0141', '[]'::jsonb, '[]'::jsonb, NULL)::text`, 'otra')};
SELECT ${ADM(`SELECT register_pending_expense('2026-11-13'::date, 255000, 255000, '${C_FLETE}'::uuid, 'Flete 0141', 'OPERATING', 'G-0141-F', NULL, 'Flete 0141', '[]'::jsonb, '[]'::jsonb, NULL)::text`, 'flete')};`);
expect('A0 purchases registered', `(SELECT count(*) FROM res WHERE k IN ('compra','otra','flete'))`, '3');
expect('A1 kg of the purchase', ADM(`SELECT set_feed_purchase_quantity(${P(PU('compra'))}::uuid, 405, NULL)::text`), 'OK:%');
const ALLOC = (k, amount) => ADM(`SELECT allocate_feed_freight(${P(PU('flete'))}::uuid, ('[{"purchase_id":"' || ${P(PU(k))} || '","amount":${amount}}]')::jsonb)::text`);
const QUITAR = (k, reason = 'monto mal puesto', who = ADM) => who(`SELECT unallocate_feed_freight(${P(PU('flete'))}::uuid, ${P(PU(k))}::uuid, ${lit(reason)})::text`);
const ROOT = `(SELECT purchase_chain_root(id) FROM purchases WHERE idempotency_key = 'G-0141-A')`;
const ROW = readAdmin(`SELECT freight_amount || '/' || freight_status FROM report_feed_purchase WHERE purchase_root_id = ${ROOT}`);
const LEFT = readAdmin(`SELECT remaining::text FROM report_feed_freight WHERE freight_purchase_root_id = (SELECT purchase_chain_root(id) FROM purchases WHERE idempotency_key = 'G-0141-F')`);
expect('A2 60.000 allocated by mistake', ALLOC('compra', 60000), 'OK:%"remaining": 195000%');
expect('A3 the rest cannot go to the same purchase (one allocation per freight and purchase)', ALLOC('compra', 195000), 'ERR:ALREADY_ALLOCATED%');
expect('A4 the purchase carries 60.000 of freight', ROW, '60000.00/ASIGNADO');

// ── B. Quitar el flete ──────────────────────────────────────────────────────
expect('B1 OPERATOR cannot remove it', QUITAR('compra', 'x', OPE), 'ERR:FORBIDDEN%');
expect('B2 a reason is required', QUITAR('compra', '   '), 'ERR:INVALID_REASON%');
expect('B3 a purchase without that freight: ALLOCATION_NOT_FOUND', QUITAR('otra'), 'ERR:ALLOCATION_NOT_FOUND%');
expect('B4 removed: 60.000 released, the whole freight free again', QUITAR('compra'), 'OK:%"released": 60000%"remaining": 255000%');
expect('B5 the purchase has no freight (pending again)', ROW, '0/PENDIENTE');
expect('B6 the freight shows its whole amount to allocate', LEFT, '255000.00');
expect('B7 audited with the amount, who allocated it and the reason',
  `(SELECT action || '|' || (before_values ->> 'amount') || '|' || (before_values ->> 'allocated_by') || '|' || reason || '|' || performed_by FROM audit_events WHERE entity_type = 'feed_freight_allocation' AND action = 'UNALLOCATE' ORDER BY id DESC LIMIT 1)`,
  `UNALLOCATE|60000.00|${ADMIN}|monto mal puesto|${ADMIN}`);
expect('B8 nothing else changed: the freight expense and the purchase are as they were',
  `(SELECT string_agg(amount_total::text, ',' ORDER BY idempotency_key) FROM purchases WHERE idempotency_key IN ('G-0141-A', 'G-0141-F') AND is_current)`, '1000.00,255000.00');
expect('B9 removing it twice: ALLOCATION_NOT_FOUND', QUITAR('compra'), 'ERR:ALLOCATION_NOT_FOUND%');

// ── C. Asignarlo bien ───────────────────────────────────────────────────────
expect('C1 the whole 255.000 allocated to the purchase', ALLOC('compra', 255000), 'OK:%"remaining": 0%');
expect('C2 the purchase carries the whole freight', ROW, '255000.00/ASIGNADO');

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
