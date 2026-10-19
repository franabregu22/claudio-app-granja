#!/usr/bin/env node
/**
 * 0100 — PEDIDOS: CORRELATIVE ORDER NUMBER + DELIVERY RESPONSIBLE. LOCAL TEST DATABASE ONLY.
 *
 *   A. back-fill rehearsal (one transaction, rolled back): the local database is brought back to the pre-0100 state, a
 *      production-like history is seeded (migrated numbers, orders without number, unambiguous / ambiguous / missing
 *      DELIVER evidence) and the committed 0100 file is applied verbatim.
 *   B. behaviour after 0100 (one transaction, rolled back): automatic numbering, refused / immutable numbers, the
 *      responsible captured from auth.uid() by deliver_order and kept by rectification / cancellation, ADMIN-only.
 *   C. concurrency: two real sessions insert at the same time and both commit — distinct consecutive numbers (the
 *      second waits for the first); the two fixture orders and the fixture client are removed afterwards.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/pedidos_numero_entrega.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
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
const MIG = resolve(import.meta.dirname, '../../supabase/target-migrations');
const read = (f) => readFileSync(resolve(MIG, f), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a); if (i < 0) throw new Error(a); const j = src.indexOf(b, i); if (j < 0) throw new Error(b); return src.slice(i, j + b.length); };

// ── SQL helpers ──────────────────────────────────────────────────────────────
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0100-0000-0000-00000000000a';
const ADMIN2 = 'aaaaaaaa-0100-0000-0000-00000000000c';
const OPER = 'aaaaaaaa-0100-0000-0000-00000000000b';
const CLI = 'cccccccc-0100-0000-0000-0000000000c1';
const PROD = `(SELECT id FROM products WHERE product_type <> 'INPUT' AND activo ORDER BY nombre LIMIT 1)`;
const P = (expr) => `{{${expr}}}`;   // resolved by run_as as the owner, before the role switch
const as = (role, uid, call) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)})`;
const A = (q) => as('authenticated', ADMIN, q);

const HARNESS = `\\set ON_ERROR_STOP 1
BEGIN;
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
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
    PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
                                                  ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
    EXECUTE p_sql INTO v;
    ok := true;
    RESET ROLE;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    RESET ROLE;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || msg END;
END $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, p_got, p_like;
  ELSE RAISE NOTICE 'PASS %', p_name; END IF;
END $f$;
CREATE FUNCTION pg_temp.err_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN others THEN RETURN 'ERR:' || SQLERRM; END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'p0100-admin@test.local', 'ADMIN'), ('${ADMIN2}', 'p0100-admin2@test.local', 'ADMIN'), ('${OPER}', 'p0100-oper@test.local', 'OPERATOR');
INSERT INTO clients (id, nombre) VALUES ('${CLI}', 'Cliente 0100 test');`;

// ── A. back-fill rehearsal ───────────────────────────────────────────────────
const A_SQL = [];
const a = (s) => A_SQL.push(s);
const ae = (name, got, like) => a(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);
const deliver0011 = `${between(read('0011_commercial_rpcs.sql'), 'CREATE OR REPLACE FUNCTION deliver_order(', '$$;')}`;
a(HARNESS);
a(`-- back to the pre-0100 state
DROP TRIGGER trg_pedidos_numero_entrega_guard ON pedidos;
DROP FUNCTION pedidos_numero_entrega_guard();
ALTER TABLE pedidos DROP COLUMN delivered_by;
ALTER TABLE pedidos DROP CONSTRAINT chk_pedidos_numero_positive, ALTER COLUMN numero_pedido DROP NOT NULL;
${deliver0011}
DELETE FROM migration_ledger.applied WHERE version = '0100';`);
const o = (n) => `dddddddd-0100-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const DEL = (t) => `'DELIVERED', TIMESTAMPTZ '${t}', DATE '${t.slice(0, 10)}'`;
a(`CREATE TEMP TABLE base AS SELECT greatest(coalesce((SELECT max(numero_pedido) FROM pedidos), 0), 500) AS m;
INSERT INTO pedidos (id, numero_pedido, cliente_id, estado, delivered_at, delivered_date, created_at) VALUES
  ('${o(1)}', 500, '${CLI}', ${DEL('2026-01-01 12:00-03')}, '2026-01-01 10:00-03'),          -- migrated delivery: number kept, no evidence
  ('${o(4)}', NULL, '${CLI}', ${DEL('2026-10-05 12:00-03')}, '2026-10-05 10:00-03'),         -- unambiguous DELIVER
  ('${o(6)}', NULL, '${CLI}', ${DEL('2026-10-06 12:00-03')}, '2026-10-06 10:00-03'),         -- two DELIVER events: ambiguous
  ('${o(7)}', NULL, '${CLI}', ${DEL('2026-10-07 12:00-03')}, '2026-10-07 10:00-03');         -- delivered, no event
INSERT INTO pedidos (id, numero_pedido, cliente_id, estado, cancelled_at, cancelled_date, created_at) VALUES
  ('${o(2)}', 7, '${CLI}', 'CANCELLED', '2026-01-02 12:00-03', '2026-01-02', '2026-01-02 10:00-03'),   -- migrated, low number kept
  ('${o(3)}', NULL, '${CLI}', 'CANCELLED', '2026-10-04 12:00-03', '2026-10-04', '2026-10-04 10:00-03');
INSERT INTO pedidos (id, numero_pedido, cliente_id, estado, created_at) VALUES
  ('${o(5)}', NULL, '${CLI}', 'PENDING', '2026-10-05 10:00-03');                                        -- same created_at as ${o(4)}: id breaks the tie
INSERT INTO audit_events (entity_type, entity_id, action, after_values, performed_by) VALUES
  ('pedido', '${o(4)}', 'DELIVER', '{"estado":"DELIVERED"}', '${ADMIN}'),
  ('pedido', '${o(6)}', 'DELIVER', '{"estado":"DELIVERED"}', '${ADMIN}'),
  ('pedido', '${o(6)}', 'DELIVER', '{"estado":"DELIVERED"}', '${ADMIN2}'),
  ('pedido', '${o(3)}', 'DELIVER', '{"estado":"DELIVERED"}', '${ADMIN}'),     -- not delivered: never attributed
  ('pedido', '${o(1)}', 'MIGRATION_LOAD', '{}', '${ADMIN}');                  -- not a DELIVER: never evidence`);
a(`-- the committed 0100 file, verbatim\n${read('0100_pedidos_numero_delivered_by.sql')}`);
const NUM = (n) => `(SELECT numero_pedido - (SELECT m FROM base) FROM pedidos WHERE id = '${o(n)}')`;
ae('A-1 existing numbers are kept (migrated 500 and 7)', `(SELECT string_agg(numero_pedido::text, ',' ORDER BY numero_pedido) FROM pedidos WHERE id IN ('${o(1)}', '${o(2)}'))`, '7,500');
ae('A-2 orders without number: max + 1 … in creation order (created_at, id as tie-break), cancelled and pending included',
  `(${NUM(3)} || ',' || ${NUM(4)} || ',' || ${NUM(5)} || ',' || ${NUM(6)} || ',' || ${NUM(7)})`, '1,2,3,4,5');
ae('A-3 no order without number; numero_pedido mandatory', `((SELECT count(*) FROM pedidos WHERE numero_pedido IS NULL) || ':' || (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'pedidos'::regclass AND attname = 'numero_pedido'))`, '0:true');
ae('A-4 responsible recovered only from an unambiguous DELIVER (one event, one performer, delivered order)',
  `(SELECT string_agg(right(id::text, 2) || '=' || coalesce(delivered_by::text, 'null'), ',' ORDER BY id) FROM pedidos WHERE id IN ('${o(1)}', '${o(3)}', '${o(4)}', '${o(6)}', '${o(7)}'))`,
  `01=null,03=null,04=${ADMIN},06=null,07=null`);
ae('A-5 the guard trigger is installed and deliver_order records delivered_by',
  `((SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_pedidos_numero_entrega_guard') || ':' || (SELECT prosrc LIKE '%delivered_by = v_uid%' FROM pg_proc WHERE proname = 'deliver_order'))`, '1:true');
a('ROLLBACK;');

// ── B. behaviour after 0100 ──────────────────────────────────────────────────
const B_SQL = [];
const b = (s) => B_SQL.push(s);
const be = (name, got, like) => b(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);
b(HARNESS);
const NEW = () => A(`INSERT INTO pedidos (cliente_id, estado, created_by, updated_by) VALUES ('${CLI}', 'PENDING', '${ADMIN}', '${ADMIN}') RETURNING numero_pedido::text`);
b(`CREATE TEMP TABLE n0 AS SELECT coalesce(max(numero_pedido), 0) AS m FROM pedidos;`);
be('B-1 a new order (ADMIN, API) is numbered by the database: max + 1', `(SELECT ${NEW()} = 'OK:' || (m + 1) FROM n0)::text`, 'true');
be('B-2 … and the next one max + 2', `(SELECT ${NEW()} = 'OK:' || (m + 2) FROM n0)::text`, 'true');
be('B-3 a client-supplied number is refused', A(`INSERT INTO pedidos (cliente_id, estado, numero_pedido) VALUES ('${CLI}', 'PENDING', 999999) RETURNING 1`), 'ERR:ORDER_NUMBER_ASSIGNED_BY_SYSTEM%');
be('B-4 a responsible cannot be supplied on insert', A(`INSERT INTO pedidos (cliente_id, estado, delivered_by) VALUES ('${CLI}', 'PENDING', '${ADMIN}') RETURNING 1`), 'ERR:DELIVERED_BY_SET_ON_DELIVERY_ONLY%');
b(`CREATE TEMP TABLE ids AS SELECT id, numero_pedido FROM pedidos WHERE numero_pedido > (SELECT m FROM n0) ORDER BY numero_pedido;
INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre)
SELECT i.id, ${PROD}, 2, 1000, 'Producto 0100' FROM ids i;`);
const FIRST = `(SELECT id FROM ids ORDER BY numero_pedido LIMIT 1)`;
const SECOND = `(SELECT id FROM ids ORDER BY numero_pedido OFFSET 1 LIMIT 1)`;
be('B-5 the number cannot be changed through the API (PENDING order, ADMIN)', A(`UPDATE pedidos SET numero_pedido = numero_pedido + 1000 WHERE id = ${P(FIRST)}::uuid RETURNING 1`), 'ERR:ORDER_NUMBER_IMMUTABLE%');
be('B-6 … nor by the owner', `pg_temp.err_of('UPDATE pedidos SET numero_pedido = numero_pedido + 1000 WHERE id = ''' || ${FIRST} || '''')`, 'ERR:ORDER_NUMBER_IMMUTABLE%');
be('B-7 a responsible cannot be set on a PENDING order through the API', A(`UPDATE pedidos SET delivered_by = '${ADMIN}' WHERE id = ${P(FIRST)}::uuid RETURNING 1`), 'ERR:DELIVERED_BY_IMMUTABLE%');
be('B-8 an OPERATOR cannot deliver (FORBIDDEN) nor create orders (RLS)',
  `(${as('authenticated', OPER, `SELECT deliver_order(${P(FIRST)}::uuid, now())::text`)} || '|' || ${as('authenticated', OPER, `INSERT INTO pedidos (cliente_id, estado) VALUES ('${CLI}', 'PENDING') RETURNING 1`)})`,
  'ERR:FORBIDDEN%|ERR:new row violates row-level security%');
be('B-9 deliver_order (ADMIN) records the confirming ADMIN from auth.uid()', A(`SELECT deliver_order(${P(FIRST)}::uuid, now())->>'estado'`), 'OK:DELIVERED');
be('B-10 … delivered_by = the ADMIN, not updated_by / created_by semantics; number unchanged',
  `(SELECT (delivered_by = '${ADMIN}')::text || ':' || (numero_pedido = (SELECT numero_pedido FROM ids WHERE id = p.id))::text FROM pedidos p WHERE id = ${FIRST})`, 'true:true');
be('B-11 another ADMIN rectifies the delivered order', as('authenticated', ADMIN2, `SELECT rectify_delivered_order(${P(FIRST)}::uuid, ${P(`'[{"producto_id":"' || ${PROD} || '","cantidad":1,"precio_unitario":1000}]'`)}::jsonb, 'test 0100')::text`), 'OK:%');
be('B-12 … the responsible and the number are kept; updated_by is the rectifier (not the responsible)',
  `(SELECT (delivered_by = '${ADMIN}')::text || ':' || (numero_pedido = (SELECT numero_pedido FROM ids WHERE id = p.id))::text || ':' || rectification_seq || ':' || (updated_by = '${ADMIN2}')::text FROM pedidos p WHERE id = ${FIRST})`,
  'true:true:1:true');
be('B-13 the responsible cannot be changed afterwards, not even by the owner', `pg_temp.err_of('UPDATE pedidos SET delivered_by = ''${ADMIN2}'' WHERE id = ''' || ${FIRST} || '''')`, 'ERR:DELIVERED_BY_IMMUTABLE%');
be('B-14 delivering twice is still refused (1 order = 1 delivery)', A(`SELECT deliver_order(${P(FIRST)}::uuid, now())::text`), 'ERR:ORDER_NOT_PENDING%');
be('B-15 a cancelled order keeps its number and has no responsible', `(${A(`SELECT cancel_order(${P(SECOND)}::uuid, now(), 'test 0100')::text`)} LIKE 'OK:%')::text || ':'
  || (SELECT (numero_pedido = (SELECT numero_pedido FROM ids WHERE id = p.id))::text || ':' || coalesce(delivered_by::text, 'null') FROM pedidos p WHERE id = ${SECOND})`, 'true:true:null');
be('B-16 SECURITY DEFINER set unchanged (94); deliver_order EXECUTE: authenticated + service_role, not anon; guard not callable',
  `((SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace) || ':' || has_function_privilege('authenticated', 'deliver_order(uuid,timestamptz,text)', 'EXECUTE')
    || ':' || has_function_privilege('service_role', 'deliver_order(uuid,timestamptz,text)', 'EXECUTE') || ':' || has_function_privilege('anon', 'deliver_order(uuid,timestamptz,text)', 'EXECUTE')
    || ':' || (SELECT prosecdef FROM pg_proc WHERE proname = 'pedidos_numero_entrega_guard'))`, '94:true:true:false:false');
be('B-17 the responsible email is readable by an ADMIN through perfiles (embedded by delivered_by)',
  A(`SELECT pf.email FROM pedidos p JOIN perfiles pf ON pf.id = p.delivered_by WHERE p.id = ${P(FIRST)}::uuid`), 'OK:p0100-admin@test.local');
b('ROLLBACK;');

// ── run ──────────────────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);

let pass = 0;
let fail = 0;
const ok = (good, name, detail = '') => { if (good) { pass += 1; console.log(`    OK   ${name}`); } else { fail += 1; console.log(`    MAL  ${name}${detail ? ` :: ${detail}` : ''}`); } };
function runScript(title, sqlText) {
  console.log(`  ${title}`);
  const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sqlText);
  const lines = `${r.stdout}\n${r.stderr}`.split('\n');
  for (const l of lines) {
    const m = l.match(/NOTICE:\s+(PASS|FAIL) (.*)$/);
    if (m) ok(m[1] === 'PASS', m[2]);
  }
  if (r.status !== 0) ok(false, 'psql aborted', (lines.find((l) => /ERROR/.test(l)) || r.stderr || '').slice(0, 300));
}
runScript('A. back-fill rehearsal (rolled back)', A_SQL.join('\n'));
runScript('B. behaviour after 0100 (rolled back)', B_SQL.join('\n'));

// ── C. concurrency: two committed sessions ───────────────────────────────────
console.log('  C. concurrency (two real sessions, committed, then removed)');
const psql = (input) => new Promise((done) => {
  const t0 = Date.now();
  const p = spawn(DOCKER, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-']);
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => done({ code, out: out.trim(), ms: Date.now() - t0 }));
  p.stdin.end(input);
});
const CC = 'cccccccc-0100-0000-0000-0000000000c2';
const cleanup = `DELETE FROM pedidos WHERE cliente_id = '${CC}'; DELETE FROM clients WHERE id = '${CC}';`;
dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
  `${cleanup} INSERT INTO clients (id, nombre) VALUES ('${CC}', 'Cliente 0100 concurrencia');`);
try {
  const ins = `INSERT INTO pedidos (cliente_id, estado) VALUES ('${CC}', 'PENDING') RETURNING numero_pedido;`;
  const first = psql(`BEGIN; ${ins} SELECT pg_sleep(2); COMMIT;`);
  await new Promise((r) => setTimeout(r, 700));
  const second = await psql(`BEGIN; ${ins} COMMIT;`);
  const one = await first;
  const n1 = Number(one.out.split('\n')[0]);
  const n2 = Number(second.out.split('\n')[0]);
  ok(one.code === 0 && second.code === 0, 'C-1 both concurrent inserts commit', `${one.out} | ${second.out}`);
  ok(n2 === n1 + 1, 'C-2 distinct consecutive numbers, no collision (second = first + 1)', `${n1} / ${n2}`);
  ok(second.ms >= 900, 'C-3 the second session waited for the first (numbering serialized)', `${second.ms} ms`);
} finally {
  dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], cleanup);
  const left = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', `SELECT count(*) FROM pedidos WHERE cliente_id = '${CC}'`]).stdout.trim();
  ok(left === '0', 'C-4 the concurrency fixtures were removed', left);
}

console.log(`\n  ══ 0100 PEDIDOS NUMERO / ENTREGA RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
