#!/usr/bin/env node
/**
 * 0143 — facturar los cobros de Mercado Pago: mp_cobro, report_mp_facturar_dia / _mes (cobrado, Factura B, Factura A cobrada,
 * pendiente), the IVA of a Factura B out of VENTAS_NETAS, attach_fiscal_document_file. LOCAL TEST DATABASE ONLY; one transaction,
 * rolled back. 0143 is applied inside it when not yet in the ledger.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/facturar_cobros_mp_0143.test.mjs
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

const FILES = ['0143_facturar_cobros_mp.sql'];
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0143-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0143-0000-0000-00000000000b';
const C_MAIZ = 'cccccccc-0143-0000-0000-0000000000c1';
const C_SOJA = 'cccccccc-0143-0000-0000-0000000000c2';
const C_SAL = 'cccccccc-0143-0000-0000-0000000000c5';
const C_FLETE = 'cccccccc-0143-0000-0000-0000000000c3';
const C_OTRA = 'cccccccc-0143-0000-0000-0000000000c4';
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0143')) AS has_0143 \\gset
\\if :has_0143
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'fac-0143-admin@test.local', 'ADMIN'), ('${OPER}', 'fac-0143-oper@test.local', 'OPERATOR');
INSERT INTO clients (id, nombre) VALUES ('${C_MAIZ}', 'Consumidor final 0143');`);

// ── A. Una Factura B a consumidor final ─────────────────────────────────────
const DOC = 'dddddddd-0143-0000-0000-0000000000b1';
add(`INSERT INTO fiscal_document (id, document_type, direction, document_date, fiscal_period, cliente_id, external_number, net_amount, total_amount)
  VALUES ('${DOC}', 'INVOICE_B', 'DEBITO', '2030-12-05', '2030-12-01', '${C_MAIZ}', '0002-00000143', 10000, 12100);
INSERT INTO fiscal_document_component (fiscal_document_id, tax_kind, direction, base_amount, rate_applied, tax_amount)
  VALUES ('${DOC}', 'IVA', 'DEBITO', 10000, 21, 2100);`);
expect('A1 the day: invoiced with Factura B', readAdmin(`SELECT cobrado || '|' || facturado_b || '|' || facturas_b FROM report_mp_facturar_dia WHERE business_date = '2030-12-05'`), '0.00|12100.00|1');
expect('A2 the month: pending = cobrado − Factura B − Factura A cobrada', readAdmin(`SELECT cobrado || '|' || facturado_b || '|' || cobrado_factura_a || '|' || pendiente FROM report_mp_facturar_mes WHERE period = '2030-12-01'`), '0.00|12100.00|0.00|-12100.00');
expect('A3 Resultados: the Factura B IVA leaves the net sales on its date', readAdmin(`SELECT bucket || '|' || business_date || '|' || signed_amount || '|' || description FROM pnl_line_item WHERE source_entity_type = 'fiscal_document' AND source_entity_id = '${DOC}'`),
  'VENTAS_NETAS|2030-12-05|-2100.00|IVA de ventas facturadas (Factura B 0002-00000143)');
expect('A4 a Factura A is not an IVA line of the P&L (its sale is recorded net)', readAdmin(`SELECT count(*)::text FROM pnl_line_item WHERE source_entity_type = 'fiscal_document' AND source_entity_id <> '${DOC}' AND business_date >= '2030-01-01'`), '0');
expect('A5 OPERATOR reads nothing (no row)', `pg_temp.read_as('${OPER}', 'SELECT count(*)::text FROM report_mp_facturar_mes')`, '0');

// ── B. Los cobros: todo lo recibido menos lo propio ─────────────────────────
expect('B1 mp_cobro = payments and inflows received, except own transfers',
  `(SELECT (SELECT count(*) FROM mp_financial_movement m WHERE m.movement_kind IN ('payment', 'inflow') AND m.gross_amount <> 0
             AND NOT EXISTS (SELECT 1 FROM mp_inbound_reclassification x WHERE x.mp_financial_movement_id = m.id)) = (${readAdmin('SELECT count(*)::text FROM mp_cobro')})::bigint)::text`, 'true');
expect('B2 the months add up the days', readAdmin(`SELECT (SELECT coalesce(sum(cobrado), 0) FROM report_mp_facturar_mes) = (SELECT coalesce(sum(cobrado), 0) FROM report_mp_facturar_dia)`), 'true');

// ── C. Adjuntar el PDF ──────────────────────────────────────────────────────
expect('C1 OPERATOR cannot attach', OPE(`SELECT attach_fiscal_document_file('${DOC}'::uuid, '{}'::jsonb)::text`), 'ERR:FORBIDDEN%');
expect('C2 an unknown document', ADM(`SELECT attach_fiscal_document_file('dddddddd-0143-0000-0000-0000000000ff'::uuid, '{}'::jsonb)::text`), 'ERR:FISCAL_DOCUMENT_NOT_FOUND%');

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
