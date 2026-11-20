#!/usr/bin/env node
/**
 * 0136 — Factura A ticked / unticked on an order already delivered (set_order_invoice_a: the client ledger re-booked, the issued invoice
 * recorded or — while unnumbered — removed, audited). LOCAL TEST DATABASE ONLY; one transaction, rolled back. If 0136 is not yet in the
 * ledger it is applied inside that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/factura_a_entregado_0136.test.mjs
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

const FILE = '0136_factura_a_pedido_entregado.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0136-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0136-0000-0000-00000000000b';
const OPER2 = 'aaaaaaaa-0136-0000-0000-00000000000c';
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0136')) AS has_0136 \\gset
\\if :has_0136
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'prod-0136-admin@test.local', 'ADMIN'), ('${OPER}', 'prod-0136-oper@test.local', 'OPERATOR');
INSERT INTO clients (nombre, fiscal_id) VALUES ('T0136 con CUIT', '20-12345678-9'), ('T0136 sin CUIT', NULL);
CREATE TEMP TABLE t_ped (k TEXT PRIMARY KEY, id UUID);
INSERT INTO pedidos (cliente_id, estado, created_by, factura_a) SELECT id, 'PENDING', '${ADMIN}', false FROM clients WHERE nombre IN ('T0136 con CUIT', 'T0136 sin CUIT');
INSERT INTO t_ped SELECT CASE c.nombre WHEN 'T0136 con CUIT' THEN 'a' ELSE 'b' END, p.id FROM pedidos p JOIN clients c ON c.id = p.cliente_id WHERE c.nombre LIKE 'T0136%';
INSERT INTO pedido_lineas (pedido_id, producto_id, producto_nombre, cantidad, precio_unitario, created_by)
SELECT t.id, pr.id, pr.nombre, 3, 36000, '${ADMIN}' FROM t_ped t CROSS JOIN LATERAL (SELECT id, nombre FROM products ORDER BY nombre LIMIT 1) pr;`);

const PED = (k) => `(SELECT id FROM t_ped WHERE k = '${k}')`;
const AT = `'2026-11-20 12:00:00-03'`;
const LEDGER = (k) => `(SELECT sum(signed_amount)::text FROM client_ledger WHERE source_entity_type = 'pedido' AND source_entity_id = ${PED(k)}::text)`;
const DOCS = (k) => `(SELECT count(*)::text FROM fiscal_document WHERE pedido_id = ${PED(k)})`;
const SET = (k, on, reason = 'era con factura') => ADM(`SELECT set_order_invoice_a(${P(PED(k))}::uuid, ${on}, ${reason === null ? 'NULL' : `'${reason}'`})::text`);

expect('G0 the two orders delivered without Factura A (the client owes the net)', ADM(`SELECT deliver_order(${P(PED('a'))}::uuid, ${AT})::text || deliver_order(${P(PED('b'))}::uuid, ${AT})::text`), 'OK:%');
expect('G1 … ledger 108.000, no fiscal document', `(${LEDGER('a')} || '|' || ${DOCS('a')})`, '108000.00|0');
expect('G2 an OPERATOR cannot change it', as('authenticated', OPER, `SELECT set_order_invoice_a(${P(PED('a'))}::uuid, true, 'x')::text`), 'ERR:FORBIDDEN%');
expect('G3 a reason is required', SET('a', 'true', null), 'ERR:REASON_REQUIRED%');
expect('G4 a client without CUIT cannot get a Factura A', SET('b', 'true'), 'ERR:CLIENT_CUIT_REQUIRED%');
expect('G5 Factura A ticked on the delivered order: the client now owes 130.680', SET('a', 'true'), 'OK:%"changed": true%"new_total": 130680.00%"previous_total": 108000.00%');
expect('G6 … ledger 130.680 (reversal + new delivery on the delivered date)',
  `(${LEDGER('a')} || '|' || (SELECT string_agg(movement_type::text || ':' || signed_amount || ':' || effective_date, ',' ORDER BY id) FROM client_ledger WHERE source_entity_type = 'pedido' AND source_entity_id = ${PED('a')}::text))`,
  '130680.00|SALE_DELIVERY:108000.00:2026-11-20,REVERSAL:-108000.00:2026-11-20,SALE_DELIVERY:130680.00:2026-11-20');
expect('G7 … the issued Factura A with its IVA débito, the order marked',
  `(SELECT d.document_type || '|' || d.direction || '|' || d.net_amount || '|' || d.total_amount || '|' || c.tax_amount || '|' || c.rate_applied || '|' || (SELECT factura_a FROM pedidos WHERE id = ${PED('a')}) FROM fiscal_document d JOIN fiscal_document_component c ON c.fiscal_document_id = d.id WHERE d.pedido_id = ${PED('a')})`,
  'INVOICE_A|DEBITO|108000.00|130680.00|22680.00|21.0000|true');
expect('G8 the same value again changes nothing', SET('a', 'true'), 'OK:%"changed": false%');
expect('G9 a rectification afterwards keeps following the IVA', ADM(`SELECT rectify_delivered_order(${P(PED('a'))}::uuid, '[{"producto_id": "[[(SELECT id FROM products ORDER BY nombre LIMIT 1)]]", "cantidad": 4, "precio_unitario": 36000}]'::jsonb, 'eran 4')::text`), 'OK:%"new_total": 174240.00%');
expect('G10 unticked: back to the net, the unissued invoice removed', SET('a', 'false', 'no llevaba factura'), 'OK:%"changed": true%"new_total": 144000.00%"previous_total": 174240.00%');
expect('G11 … ledger 144.000, no document, the order unmarked', `(${LEDGER('a')} || '|' || ${DOCS('a')} || '|' || (SELECT factura_a FROM pedidos WHERE id = ${PED('a')}))`, '144000.00|0|false');
expect('G12 … the removed document is kept whole in the audit row', `(SELECT count(*) || '|' || max(before_values->'fiscal_document'->>'total_amount') || '|' || max(jsonb_array_length(before_values->'components'))
     FROM audit_events WHERE action = 'SET_ORDER_INVOICE_A' AND entity_id = ${PED('a')}::text AND after_values->>'factura_a' = 'false')`, '1|174240.00|1');
expect('G13 ticked again and numbered: it can no longer be unticked (issued in ARCA → credit note)',
  ADM(`SELECT set_order_invoice_a(${P(PED('a'))}::uuid, true, 'sí era')::text || set_sale_invoice_number(${P(PED('a'))}::uuid, '00003-00000999')::text || set_order_invoice_a(${P(PED('a'))}::uuid, false, 'no')::text`),
  'ERR:SALE_INVOICE_ISSUED%');
expect('G14 a pending order is not handled here (it is edited)', ADM(`SELECT set_order_invoice_a((SELECT id FROM pedidos WHERE estado = 'CANCELLED' LIMIT 1), true, 'x')::text`), 'ERR:ORDER_NOT_%');
expect('G15 rights: definer, EXECUTE authenticated only', `(SELECT p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_order_invoice_a(uuid,boolean,text)'))`, 'true|falsetruefalse');
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
