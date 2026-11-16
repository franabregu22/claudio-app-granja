#!/usr/bin/env node
/**
 * 0126 (alimento-balanceado-v1) — costo por kg y estado de resultados: categorías insumo / flete, kg de compras,
 * reparto de flete, costo por insumo y por receta, costo del consumo y pnl_line_item desde feed_cost_start().
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

const FILES = ['0125_alimento_recetas_fabricaciones_cierre.sql', '0126_alimento_costo_y_resultados.sql'];
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0126-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0126-0000-0000-00000000000b';
const C_MAIZ = 'cccccccc-0126-0000-0000-0000000000c1';
const C_SOJA = 'cccccccc-0126-0000-0000-0000000000c2';
const C_FLETE = 'cccccccc-0126-0000-0000-0000000000c3';
const C_OTRA = 'cccccccc-0126-0000-0000-0000000000c4';
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
  `SELECT register_pending_expense(${lit(date)}::date, ${total}, ${total}, '${cat}'::uuid, 'Compra 0126', 'OPERATING', ${lit(key)}, NULL, 'Proveedor 0126', '[]'::jsonb, '[]'::jsonb, NULL)::text`;
const T = `(SELECT id FROM feed_type WHERE nombre = 'Receta 0126')`;
const ING = (n) => `(SELECT id FROM feed_ingredient WHERE nombre = 'Ing 0126 ${n}')`;
const PNL = (q) => readAdmin(`SELECT coalesce(string_agg(${q}, ';' ORDER BY source_entity_type, signed_amount), 'none') FROM pnl_line_item WHERE source_entity_id IN (SELECT id::text FROM purchases WHERE expense_category_id IN ('${C_MAIZ}','${C_SOJA}','${C_FLETE}','${C_OTRA}')) OR source_entity_type = 'feed_consumption'`);

add(`\\set ON_ERROR_STOP 1
BEGIN;
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0125')) AS has_0125 \\gset
\\if :has_0125
\\else
\\i /tmp/${FILES[0]}
\\endif
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0126')) AS has_0126 \\gset
\\if :has_0126
\\else
\\i /tmp/${FILES[1]}
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'alimento-0126-admin@test.local', 'ADMIN'), ('${OPER}', 'alimento-0126-oper@test.local', 'OPERATOR');
UPDATE feed_type SET activo = false WHERE activo;
INSERT INTO feed_type (nombre, feed_category) VALUES ('Receta 0126', 'LAYER'), ('Receta 0126 B', 'LAYER');
INSERT INTO feed_ingredient (nombre) VALUES ('Ing 0126 Maiz'), ('Ing 0126 Soja'), ('Ing 0126 Sal');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES
  ('${C_MAIZ}', 'Maíz 0126', 'DIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros')),
  ('${C_SOJA}', 'Soja 0126', 'DIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros')),
  ('${C_FLETE}', 'Flete insumos 0126', 'DIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros')),
  ('${C_OTRA}', 'Otra 0126', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));`);

// ── A. Categorías ───────────────────────────────────────────────────────────
expect('A1 mark Maíz as ingredient', ADM(`SELECT set_expense_category_feed('${C_MAIZ}'::uuid, ${P(ING('Maiz'))}::uuid, false)::text`), 'OK:%');
expect('A2 mark Soja as ingredient', ADM(`SELECT set_expense_category_feed('${C_SOJA}'::uuid, ${P(ING('Soja'))}::uuid, false)::text`), 'OK:%');
expect('A3 mark Flete as feed freight', ADM(`SELECT set_expense_category_feed('${C_FLETE}'::uuid, NULL, true)::text`), 'OK:%');
expect('A4 ingredient and freight at once is refused', ADM(`SELECT set_expense_category_feed('${C_OTRA}'::uuid, ${P(ING('Maiz'))}::uuid, true)::text`), 'ERR:INVALID_INPUT%');
expect('A5 OPERATOR cannot mark', OPE(`SELECT set_expense_category_feed('${C_OTRA}'::uuid, NULL, true)::text`), 'ERR:FORBIDDEN%');
expect('A6 audited', `(SELECT count(*) FROM audit_events WHERE entity_type = 'expense_category' AND action = 'FEED_ROLE' AND entity_id IN ('${C_MAIZ}','${C_SOJA}','${C_FLETE}'))`, '3');

// ── B. Compras, kg y flete ──────────────────────────────────────────────────
add(`SELECT ${ADM(gasto('2026-10-20', 100000, C_MAIZ, 'G-0126-OCT'), 'oct')};
SELECT ${ADM(gasto('2026-11-03', 300000, C_MAIZ, 'G-0126-MAIZ'), 'maiz')};
SELECT ${ADM(gasto('2026-11-04', 250000, C_SOJA, 'G-0126-SOJA'), 'soja')};
SELECT ${ADM(gasto('2026-11-05', 30000, C_FLETE, 'G-0126-FLETE'), 'flete')};
SELECT ${ADM(gasto('2026-11-06', 5000, C_OTRA, 'G-0126-OTRA'), 'otra')};`);
expect('B0 purchases registered', `(SELECT count(*) FROM res WHERE k IN ('oct','maiz','soja','flete','otra'))`, '5');
expect('B1 kg on a non-feed purchase is refused', ADM(`SELECT set_feed_purchase_quantity(${P(PU('otra'))}::uuid, 10)::text`), 'ERR:NOT_A_FEED_PURCHASE%');
expect('B2 freight to a purchase without kg is refused', ADM(`SELECT allocate_feed_freight(${P(PU('flete'))}::uuid, ('[{"purchase_id":"' || ${P(PU('maiz'))} || '","amount":20000}]')::jsonb)::text`), 'ERR:FEED_PURCHASE_KG_REQUIRED%');
expect('B3 kg Maíz 1000', ADM(`SELECT set_feed_purchase_quantity(${P(PU('maiz'))}::uuid, 1000)::text`), 'OK:%');
expect('B4 kg Soja 500', ADM(`SELECT set_feed_purchase_quantity(${P(PU('soja'))}::uuid, 500)::text`), 'OK:%');
expect('B5 OPERATOR cannot set kg', OPE(`SELECT set_feed_purchase_quantity(${P(PU('soja'))}::uuid, 1)::text`), 'ERR:FORBIDDEN%');
expect('B6 before the freight: Maíz 300/kg, freight pending', readAdmin(`SELECT cost_per_kg || '|' || freight_status FROM report_feed_purchase WHERE ingredient_nombre = 'Ing 0126 Maiz' AND period = '2026-11-01'`), '300.0000|PENDIENTE');
expect('B7 over-allocating the freight is refused', ADM(`SELECT allocate_feed_freight(${P(PU('flete'))}::uuid, ('[{"purchase_id":"' || ${P(PU('maiz'))} || '","amount":20000},{"purchase_id":"' || ${P(PU('soja'))} || '","amount":10001}]')::jsonb)::text`), 'ERR:OVER_ALLOCATION%');
expect('B8 allocate 20.000 Maíz + 10.000 Soja', ADM(`SELECT allocate_feed_freight(${P(PU('flete'))}::uuid, ('[{"purchase_id":"' || ${P(PU('maiz'))} || '","amount":20000},{"purchase_id":"' || ${P(PU('soja'))} || '","amount":10000}]')::jsonb)::text`), 'OK:%"remaining": 0%');
expect('B9 allocating to a non-freight purchase is refused', ADM(`SELECT allocate_feed_freight(${P(PU('otra'))}::uuid, ('[{"purchase_id":"' || ${P(PU('maiz'))} || '","amount":1}]')::jsonb)::text`), 'ERR:NOT_A_FEED_FREIGHT%');
expect('B10 no-freight on a purchase that has freight is refused', ADM(`SELECT set_feed_purchase_quantity(${P(PU('maiz'))}::uuid, 1000, true)::text`), 'ERR:FREIGHT_ALREADY_ALLOCATED%');
expect('B11 costs with freight: Maíz 320, Soja 520', readAdmin(`SELECT string_agg(ingredient_nombre || '=' || cost_per_kg || '/' || freight_status, ';' ORDER BY ingredient_nombre) FROM report_feed_purchase WHERE period = '2026-11-01' AND ingredient_nombre LIKE 'Ing 0126%'`), 'Ing 0126 Maiz=320.0000/ASIGNADO;Ing 0126 Soja=520.0000/ASIGNADO');
expect('B12 freight report: nothing left', readAdmin(`SELECT allocated || '|' || remaining FROM report_feed_freight WHERE supplier_name = 'Proveedor 0126'`), '30000.00|0.00');
expect('B13 OPERATOR reads no purchase report', `pg_temp.read_as('${OPER}', 'SELECT count(*)::text FROM report_feed_purchase')`, '0');

// ── B'. Factura A: costo sin IVA (owner 2026-11-16) ─────────────────────────
const FISCAL = (n, net, total) => ({ document_type: 'INVOICE_A', document_date: '2026-10-10', fiscal_period: '2026-10-01', net_amount: net, total_amount: total,
  external_number: `0126-0000${n}`, issuer_tax_id: '30712345678', issuer_name: 'Proveedor 0126 A',
  components: [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: net, rate_applied: 21, tax_amount: total - net }] });
const gastoA = (total, net, cat, key, n) =>
  `SELECT register_pending_expense('2026-10-10'::date, ${net}, ${total}, '${cat}'::uuid, 'Compra A 0126', 'OPERATING', ${lit(key)}, NULL, 'Proveedor 0126 A', '[]'::jsonb, '[]'::jsonb, ${lit(JSON.stringify(FISCAL(n, net, total)))}::jsonb)::text`;
expect('BA1 Soja with Factura A (net 100.000, total 121.000)', ADM(gastoA(121000, 100000, C_SOJA, 'G-0126-SOJA-A', 1), 'sojaA'), 'OK:%');
expect('BA2 freight with Factura A (net 10.000, total 12.100)', ADM(gastoA(12100, 10000, C_FLETE, 'G-0126-FLETE-A', 2), 'fleteA'), 'OK:%');
add(`SELECT ${ADM(`SELECT set_feed_purchase_quantity(${P(PU('sojaA'))}::uuid, 200)::text`)};`);
expect('BA3 price per kg without VAT: 100.000 / 200 = 500', readAdmin(`SELECT price_per_kg || '|' || invoice_a FROM report_feed_purchase WHERE ingredient_nombre = 'Ing 0126 Soja' AND period = '2026-10-01'`), '500.0000|true');
expect('BA4 allocate the whole Factura A freight (12.100)', ADM(`SELECT allocate_feed_freight(${P(PU('fleteA'))}::uuid, ('[{"purchase_id":"' || ${P(PU('sojaA'))} || '","amount":12100}]')::jsonb)::text`), 'OK:%');
expect('BA5 freight costed without VAT too: (100.000 + 10.000) / 200 = 550', readAdmin(`SELECT freight_amount || '|' || freight_cost || '|' || cost_per_kg FROM report_feed_purchase WHERE ingredient_nombre = 'Ing 0126 Soja' AND period = '2026-10-01'`), '12100.00|10000.00|550.0000');
expect('BA6 ingredient cost of October = 550', readAdmin(`SELECT cost_per_kg FROM report_feed_ingredient_cost_month WHERE ingredient_nombre = 'Ing 0126 Soja' AND period = '2026-10-01'`), '550.0000');

// ── C. Receta, consumo y estado de resultados ───────────────────────────────
add(`SELECT ${ADM(`SELECT publish_feed_formula_version(${P(T)}::uuid, '2026-10-01'::date, ('[{"ingredient_id":"' || ${P(ING('Maiz'))} || '","quantity_kg":150},{"ingredient_id":"' || ${P(ING('Soja'))} || '","quantity_kg":50}]')::jsonb)::text`)};
SELECT ${ADM(`SELECT register_feed_inventory_count(${P(T)}::uuid, '2026-10-31'::date, 0, 'Stock inicial')::text`)};
SELECT ${OPE(`SELECT register_feed_manufacturing(p_formula_version_id => ${P(`(SELECT id FROM feed_formula_version WHERE feed_type_id = ${T})`)}::uuid, p_manufacturing_date => '2026-11-05'::date, p_quantity_kg => 1000, p_idempotency_key => 'F-0126-1')::text`)};
-- November cannot be closed before it ends: the test closes it directly
INSERT INTO feed_stock_period (period, status, closed_by, closed_at) VALUES ('2026-11-01', 'CLOSED', '${ADMIN}', now());
INSERT INTO feed_inventory_count (feed_type_id, count_date, quantity_kg, created_by) VALUES (${T}, '2026-11-30', 200, '${ADMIN}');`);
expect('C1 recipe cost Nov = (150×320 + 50×520) / 200 = 370', readAdmin(`SELECT cost_per_kg || '|' || estimated FROM report_feed_recipe_cost_month WHERE feed_type_nombre = 'Receta 0126' AND period = '2026-11-01'`), '370.0000|false');
expect('C2 consumption Nov = 0 + 1000 − 200 = 800 → cost 296.000', readAdmin(`SELECT internal_consumption_kg || '|' || consumption_cost FROM report_feed_consumption_cost WHERE feed_type_nombre = 'Receta 0126' AND period = '2026-11-01'`), '800.000|296000.00');
expect('C3 P&L: Oct ingredient purchase stays; Nov ingredient/freight purchases out; ordinary stays; consumption line in',
  PNL(`source_entity_type || ':' || bucket || ':' || signed_amount`),
  'feed_consumption:COSTOS_DIRECTOS:-296000.00;purchases:COSTOS_DIRECTOS:-121000.00;purchases:COSTOS_DIRECTOS:-100000.00;purchases:COSTOS_DIRECTOS:-12100.00;purchases:COSTOS_INDIRECTOS:-5000.00');
expect('C4 the consumption line is dated at month end and named after the recipe',
  readAdmin(`SELECT business_date || '|' || description FROM pnl_line_item WHERE source_entity_type = 'feed_consumption' AND description LIKE '%Receta 0126'`), '2026-11-30|Alimento consumido — Receta 0126');
add(`SELECT ${ADM(`SELECT publish_feed_formula_version((SELECT id FROM feed_type WHERE nombre = 'Receta 0126 B'), '2026-10-01'::date, ('[{"ingredient_id":"' || ${P(ING('Maiz'))} || '","quantity_kg":100},{"ingredient_id":"' || ${P(ING('Sal'))} || '","quantity_kg":100}]')::jsonb)::text`)};`);
expect('C5 a recipe with an unpriced ingredient: NULL cost and the ingredient listed',
  readAdmin(`SELECT coalesce(cost_per_kg::text, 'null') || '|' || array_to_string(missing_ingredients, ',') FROM report_feed_recipe_cost_month WHERE feed_type_nombre = 'Receta 0126 B' AND period = '2026-11-01'`), 'null|Ing 0126 Sal');

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
