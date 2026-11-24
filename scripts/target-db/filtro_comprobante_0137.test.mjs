#!/usr/bin/env node
/**
 * 0137 — the «Factura / comprobante» filter of Todas las operaciones (fin_operation_list p_comprobante 'CON' | 'SIN'). LOCAL TEST
 * DATABASE ONLY; one transaction, rolled back. If 0137 is not yet in the ledger it is applied inside that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/filtro_comprobante_0137.test.mjs
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

const FILE = '0137_filtro_comprobante_operaciones.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0137-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0137-0000-0000-00000000000b';
const C_OTRA = 'cccccccc-0137-0000-0000-0000000000c4';
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const PU = (k) => `(${RES(k, 'purchase_id')})::uuid`;

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const ADM = (call, key) => as('authenticated', ADMIN, call, key);
const OPE = (call, key) => as('authenticated', OPER, call, key);
const ATT = `[{"storage_path": "${ADMIN}/f0137.pdf", "file_name": "factura.pdf", "content_type": "application/pdf", "byte_size": 1000}]`;
const gasto = (date, total, key, att = '[]') =>
  `SELECT register_pending_expense(${lit(date)}::date, ${total}, ${total}, '${C_OTRA}'::uuid, 'Compra 0137', 'OPERATING', ${lit(key)}, NULL, 'Proveedor 0137', '[]'::jsonb, '${att}'::jsonb, NULL)::text`;
const LISTA = (args) => ADM(`SELECT (r->>'total') || '|' || (r->>'importe') FROM (SELECT fin_operation_list(${args}p_search => 'Compra 0137', p_limit => 100) AS r) x`);

// ── harness ─────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0137')) AS has_0137 \\gset
\\if :has_0137
\\else
\\i /tmp/${FILE}
\\endif
CREATE TEMP TABLE res (k TEXT PRIMARY KEY, v JSONB);
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT, p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; msg TEXT; ok BOOLEAN := false;
BEGIN
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
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN
    RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, p_got, p_like;
  ELSE
    RAISE NOTICE 'PASS %', p_name;
  END IF;
END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'comprobante-0137-admin@test.local', 'ADMIN'), ('${OPER}', 'comprobante-0137-oper@test.local', 'OPERATOR');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES ('${C_OTRA}', 'Otra 0137', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));`);

// G1 a file uploaded in the ERP, G2 an invoice number, G3 a WhatsApp document link, G4 nothing
add(`SELECT ${ADM(gasto('2026-11-03', 1000, 'G-0137-1', ATT), 'g1')};
SELECT ${ADM(gasto('2026-11-04', 2000, 'G-0137-2'), 'g2')};
SELECT ${ADM(gasto('2026-11-05', 4000, 'G-0137-3'), 'g3')};
SELECT ${ADM(gasto('2026-11-06', 8000, 'G-0137-4'), 'g4')};
UPDATE purchases SET supplier_invoice_number = '0001-00000137' WHERE id = ${PU('g2')};
WITH f AS (INSERT INTO document_file (storage_bucket, storage_path, sha256, content_type, byte_size, file_name, origin)
           VALUES ('wa-media', 'wa/' || repeat('7', 64) || '.jpg', repeat('7', 64), 'image/jpeg', 500, 'ticket.jpg', 'WHATSAPP') RETURNING id)
INSERT INTO document_link (document_file_id, target_kind, target_id) SELECT f.id, 'PURCHASE', ${PU('g3')}::text FROM f;`);
expect('F0 fixtures: 4 expenses', `(SELECT count(*) FROM res)`, '4');
expect('F1 no filter: the 4, −15.000', LISTA(''), 'OK:4|-15000.00');
expect('F2 «Con comprobante»: file, number and WhatsApp link (3), −7.000', LISTA("p_comprobante => 'CON', "), 'OK:3|-7000.00');
expect('F3 «Sin comprobante»: only G4, −8.000', LISTA("p_comprobante => 'SIN', "), 'OK:1|-8000.00');
add(`UPDATE purchases SET supplier_invoice_number = '   ' WHERE id = ${PU('g4')};`);
expect('F4 a blank invoice number is no comprobante', LISTA("p_comprobante => 'SIN', "), 'OK:1|-8000.00');
expect('F5 an unknown value is refused', ADM(`SELECT fin_operation_list(p_comprobante => 'X')::text`), 'ERR:INVALID_COMPROBANTE%');
expect('F6 an OPERATOR cannot read the list', OPE(`SELECT fin_operation_list(p_comprobante => 'CON')::text`), 'ERR:FORBIDDEN%');
expect('F7 «Sin comprobante» never lists a row of no expense',
  ADM(`SELECT count(*)::text FROM jsonb_array_elements((SELECT fin_operation_list(p_comprobante => 'SIN', p_limit => 100)) -> 'rows') e WHERE e->>'purchase_root_id' IS NULL`), 'OK:0');
expect('F8 the old identity is gone; the new one: definer, EXECUTE authenticated only',
  `(SELECT count(*) FROM pg_proc WHERE proname = 'fin_operation_list') || '|' || (SELECT p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE')
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.fin_operation_list(date,date,text,uuid,boolean,text,uuid,uuid,text,uuid,text,numeric,text,text,integer,integer,uuid,boolean,text)'))`,
  '1|true|falsetruefalse');
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
