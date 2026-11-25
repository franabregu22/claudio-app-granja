#!/usr/bin/env node
/**
 * 0138 — una factura con varios insumos: feed_purchase_part, set_feed_purchase_parts and report_feed_purchase one row per part
 * (amounts by the parts' amounts, freight by kg, shared to the cent). LOCAL TEST DATABASE ONLY; one transaction, rolled back.
 * 0138 is applied inside it when not yet in the ledger.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/insumos_varios_0138.test.mjs
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

const FILES = ['0138_compra_insumos_varios.sql'];
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0138-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0138-0000-0000-00000000000b';
const C_MAIZ = 'cccccccc-0138-0000-0000-0000000000c1';
const C_SOJA = 'cccccccc-0138-0000-0000-0000000000c2';
const C_SAL = 'cccccccc-0138-0000-0000-0000000000c5';
const C_FLETE = 'cccccccc-0138-0000-0000-0000000000c3';
const C_OTRA = 'cccccccc-0138-0000-0000-0000000000c4';
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0138')) AS has_0138 \\gset
\\if :has_0138
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'insumos-0138-admin@test.local', 'ADMIN'), ('${OPER}', 'insumos-0138-oper@test.local', 'OPERATOR');
INSERT INTO feed_ingredient (nombre) VALUES ('Ing 0138 Maiz'), ('Ing 0138 Soja'), ('Ing 0138 Sal');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id, feed_ingredient_id, is_feed_freight) VALUES
  ('${C_MAIZ}', 'Maíz 0138', 'DIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'), (SELECT id FROM feed_ingredient WHERE nombre = 'Ing 0138 Maiz'), false),
  ('${C_SOJA}', 'Soja 0138', 'DIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'), (SELECT id FROM feed_ingredient WHERE nombre = 'Ing 0138 Soja'), false),
  ('${C_SAL}', 'Sal 0138', 'DIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'), (SELECT id FROM feed_ingredient WHERE nombre = 'Ing 0138 Sal'), false),
  ('${C_FLETE}', 'Flete insumos 0138', 'DIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'), NULL, true),
  ('${C_OTRA}', 'Otra 0138', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'), NULL, false);`);

// ── A. Una factura A con tres insumos (neto 1.000, total 1.210) ─────────────
const FISCAL = { document_type: 'INVOICE_A', document_date: '2026-11-20', fiscal_period: '2026-11-01', net_amount: 1000, total_amount: 1210,
  external_number: '0138-00000001', issuer_tax_id: '30712345678', issuer_name: 'Proveedor 0138',
  components: [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 1000, rate_applied: 21, tax_amount: 210 }] };
add(`SELECT ${ADM(`SELECT register_pending_expense('2026-11-20'::date, 1000, 1210, '${C_MAIZ}'::uuid, 'Compra 0138', 'OPERATING', 'G-0138-A', NULL, 'Proveedor 0138', '[]'::jsonb, '[]'::jsonb, ${lit(JSON.stringify(FISCAL))}::jsonb)::text`, 'fa')};
SELECT ${ADM(`SELECT register_pending_expense('2026-11-21'::date, 500, 500, '${C_SOJA}'::uuid, 'Compra 0138 sola', 'OPERATING', 'G-0138-B', NULL, 'Proveedor 0138', '[]'::jsonb, '[]'::jsonb, NULL)::text`, 'sola')};
SELECT ${ADM(`SELECT register_pending_expense('2026-11-22'::date, 100, 100, '${C_FLETE}'::uuid, 'Flete 0138', 'OPERATING', 'G-0138-F', NULL, 'Flete 0138', '[]'::jsonb, '[]'::jsonb, NULL)::text`, 'flete')};
SELECT ${ADM(`SELECT register_pending_expense('2026-11-22'::date, 50, 50, '${C_OTRA}'::uuid, 'Otra 0138', 'OPERATING', 'G-0138-O', NULL, 'Otra 0138', '[]'::jsonb, '[]'::jsonb, NULL)::text`, 'otra')};`);
expect('A0 purchases registered', `(SELECT count(*) FROM res WHERE k IN ('fa','sola','flete','otra'))`, '4');
const part = (cat, kg, amount) => `{"expense_category_id":"${cat}","quantity_kg":${kg},"amount":${amount}}`;
const TRES = `[${part(C_MAIZ, 3, 333.33)},${part(C_SOJA, 3, 333.33)},${part(C_SAL, 3, 333.34)}]`;
const PARTS = (k, parts, nf = 'NULL') => ADM(`SELECT set_feed_purchase_parts(${P(PU(k))}::uuid, '${parts}'::jsonb, ${nf})::text`);
const ROOT_A = `(SELECT purchase_chain_root(id) FROM purchases WHERE idempotency_key = 'G-0138-A')`;
expect('A1 one ingredient only is refused', PARTS('fa', `[${part(C_MAIZ, 9, 1000)}]`), 'ERR:INVALID_PARTS%');
expect('A2 amounts adding up to the total (not the neto of the Factura A) are refused',
  PARTS('fa', `[${part(C_MAIZ, 3, 403.33)},${part(C_SOJA, 3, 403.33)},${part(C_SAL, 3, 403.34)}]`), 'ERR:PARTS_AMOUNT_MISMATCH%');
expect('A3 the same category twice is refused', PARTS('fa', `[${part(C_MAIZ, 3, 500)},${part(C_MAIZ, 3, 500)}]`), 'ERR:DUPLICATE_CATEGORY%');
expect('A4 a category that is not an ingredient is refused', PARTS('fa', `[${part(C_MAIZ, 3, 500)},${part(C_OTRA, 3, 500)}]`), 'ERR:NOT_A_FEED_CATEGORY%');
expect('A5 zero kg is refused', PARTS('fa', `[${part(C_MAIZ, 0, 500)},${part(C_SOJA, 3, 500)}]`), 'ERR:INVALID_QUANTITY%');
expect('A6 a non-feed purchase is refused', PARTS('otra', TRES), 'ERR:NOT_A_FEED_PURCHASE%');
expect('A7 OPERATOR cannot split', OPE(`SELECT set_feed_purchase_parts(${P(PU('fa'))}::uuid, '${TRES}'::jsonb)::text`), 'ERR:FORBIDDEN%');
expect('A8 removing a split that does not exist: NO_CHANGES', PARTS('fa', '[]'), 'ERR:NO_CHANGES%');
expect('A9 three ingredients, 9 kg', PARTS('fa', TRES), 'OK:%"parts": 3%"quantity_kg": 9%');
expect('A10 the purchase kg = the sum of the parts', `(SELECT quantity_kg FROM feed_purchase_quantity WHERE purchase_root_id = ${ROOT_A})`, '9.000');
const ROWS = (cols) => readAdmin(`SELECT string_agg(${cols}, ';' ORDER BY part_position) FROM report_feed_purchase WHERE purchase_root_id = ${ROOT_A}`);
expect('A11 one row per ingredient: kg, neto share, price per kg without VAT',
  ROWS(`part_position || ':' || ingredient_nombre || ':' || quantity_kg || ':' || cost_amount || ':' || price_per_kg || ':' || invoice_a`),
  '1:Ing 0138 Maiz:3.000:333.33:111.1100:true;2:Ing 0138 Soja:3.000:333.33:111.1100:true;3:Ing 0138 Sal:3.000:333.34:111.1133:true');
expect('A12 each row carries its own ingredient category', ROWS(`expense_category_id::text`), `${C_MAIZ};${C_SOJA};${C_SAL}`);
expect('A13 nothing duplicated: the shares add up exactly to the neto and the total',
  readAdmin(`SELECT SUM(cost_amount) || '|' || SUM(amount_total) || '|' || count(*) || '|' || max(purchase_quantity_kg) FROM report_feed_purchase WHERE purchase_root_id = ${ROOT_A}`),
  '1000.00|1210.00|3|9.000');
expect('A14 the total shared to the cent (403.33 + 403.33 + 403.34)', ROWS(`amount_total::text`), '403.33;403.33;403.34');
expect('A15 a purchase without split: one row as before', readAdmin(`SELECT count(*) || '|' || coalesce(max(part_position)::text, 'null') || '|' || max(ingredient_nombre) FROM report_feed_purchase WHERE purchase_root_id = (SELECT purchase_chain_root(id) FROM purchases WHERE idempotency_key = 'G-0138-B')`), '1|null|Ing 0138 Soja');

// ── B. Flete repartido por kg entre los insumos ─────────────────────────────
expect('B1 allocate the freight (100) to the split purchase', ADM(`SELECT allocate_feed_freight(${P(PU('flete'))}::uuid, ('[{"purchase_id":"' || ${P(PU('fa'))} || '","amount":100}]')::jsonb)::text`), 'OK:%');
expect('B2 freight shared by kg to the cent (33.33 + 33.34 + 33.33 = 100)', ROWS(`freight_amount || '/' || freight_cost || '/' || cost_per_kg || '/' || freight_status`),
  '33.33/33.33/122.2200/ASIGNADO;33.34/33.34/122.2233/ASIGNADO;33.33/33.33/122.2233/ASIGNADO');
expect('B3 cost per ingredient per month: each one on its own', readAdmin(`SELECT string_agg(ingredient_nombre || '=' || cost_per_kg, ';' ORDER BY ingredient_nombre) FROM report_feed_ingredient_cost_month WHERE ingredient_nombre IN ('Ing 0138 Maiz', 'Ing 0138 Sal') AND period = '2026-11-01'`),
  'Ing 0138 Maiz=122.2200;Ing 0138 Sal=122.2233');
expect('B4 no-freight on a purchase with freight is refused', PARTS('fa', TRES, 'true'), 'ERR:FREIGHT_ALREADY_ALLOCATED%');

// ── C. Corregir y quitar el detalle ─────────────────────────────────────────
expect('C1 two ingredients instead of three', PARTS('fa', `[${part(C_SOJA, 6, 800)},${part(C_MAIZ, 2, 200)}]`), 'OK:%"parts": 2%"quantity_kg": 8%');
expect('C2 the new order and amounts', ROWS(`ingredient_nombre || ':' || cost_amount || ':' || freight_amount`), 'Ing 0138 Soja:800.00:75.00;Ing 0138 Maiz:200.00:25.00');
expect('C3 audited: CREATE then UPDATE', `(SELECT string_agg(action, ',' ORDER BY id) FROM audit_events WHERE entity_type = 'feed_purchase_part' AND entity_id = ${ROOT_A}::text)`, 'CREATE,UPDATE');
expect('C4 the split removed', PARTS('fa', '[]'), 'OK:%"parts": 0%');
expect('C5 back to one row: the purchase category, its kg kept, the whole neto', ROWS(`coalesce(part_position::text, 'null') || ':' || ingredient_nombre || ':' || quantity_kg || ':' || cost_amount || ':' || freight_amount`),
  'null:Ing 0138 Maiz:8.000:1000.00:100.00');
expect('C6 OPERATOR reads no parts', `pg_temp.read_as('${OPER}', 'SELECT count(*)::text FROM feed_purchase_part')`, '0');

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
