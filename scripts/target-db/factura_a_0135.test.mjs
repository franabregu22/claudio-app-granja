#!/usr/bin/env node
/**
 * 0135 — Factura A on orders (IVA 21 % apart: the client owes net + IVA, the issued invoice in Fiscal, recalculated on rectification,
 * its number set later) and the Mercado Pago débitos y créditos tax (named in Todas las operaciones, added to the period report).
 * LOCAL TEST DATABASE ONLY; one transaction, rolled back. If 0135 is not yet in the ledger it is applied inside that transaction.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/factura_a_0135.test.mjs
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

const FILE = '0135_factura_a_y_debcred_mp.sql';
const MIGRATION = resolve(import.meta.dirname, '../../supabase/target-migrations', FILE);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0135-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0135-0000-0000-00000000000b';
const OPER2 = 'aaaaaaaa-0135-0000-0000-00000000000c';
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
SELECT (EXISTS (SELECT 1 FROM migration_ledger.applied WHERE version = '0135')) AS has_0135 \\gset
\\if :has_0135
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'prod-0135-admin@test.local', 'ADMIN'), ('${OPER}', 'prod-0135-oper@test.local', 'OPERATOR');
INSERT INTO clients (nombre, fiscal_id) VALUES ('T0135 con CUIT', '20-12345678-9'), ('T0135 sin CUIT', '12345678'), ('T0135 otro con CUIT', '30719089891');
CREATE TEMP TABLE t_ped (k TEXT PRIMARY KEY, id UUID);
WITH n AS (
  INSERT INTO pedidos (cliente_id, estado, created_by, factura_a)
  SELECT c.id, 'PENDING', '${ADMIN}', x.fa FROM (VALUES ('fa', 'T0135 con CUIT', true), ('sin', 'T0135 sin CUIT', true), ('comun', 'T0135 con CUIT', false), ('fa2', 'T0135 otro con CUIT', true)) x(k, cli, fa)
  JOIN clients c ON c.nombre = x.cli RETURNING id, cliente_id, factura_a)
SELECT 1;
INSERT INTO t_ped SELECT x.k, p.id FROM pedidos p JOIN clients c ON c.id = p.cliente_id
  JOIN (VALUES ('fa', 'T0135 con CUIT', true), ('sin', 'T0135 sin CUIT', true), ('comun', 'T0135 con CUIT', false), ('fa2', 'T0135 otro con CUIT', true)) x(k, cli, fa)
    ON x.cli = c.nombre AND x.fa = p.factura_a;
INSERT INTO pedido_lineas (pedido_id, producto_id, producto_nombre, cantidad, precio_unitario, created_by)
SELECT t.id, pr.id, pr.nombre, 3, 36000, '${ADMIN}' FROM t_ped t CROSS JOIN LATERAL (SELECT id, nombre FROM products ORDER BY nombre LIMIT 1) pr;`);

const PED = (k) => `(SELECT id FROM t_ped WHERE k = '${k}')`;
const PRODUCTO = `(SELECT id FROM products ORDER BY nombre LIMIT 1)`;
const DOC = (k) => `(SELECT d FROM fiscal_document d WHERE d.pedido_id = ${PED(k)})`;
const AT = `'2026-11-20 12:00:00-03'`;
const LEDGER = (k) => `(SELECT sum(signed_amount)::text FROM client_ledger WHERE source_entity_type = 'pedido' AND source_entity_id = ${PED(k)}::text)`;

expect('F0 a Factura A order of a client without CUIT is not delivered', ADM(`SELECT deliver_order(${P(PED('sin'))}::uuid, ${AT})::text`), 'ERR:CLIENT_CUIT_REQUIRED%');
expect('F1 … and stays pending, nothing booked', `(SELECT estado::text || '|' || coalesce(${LEDGER('sin')}, '-') FROM pedidos WHERE id = ${PED('sin')})`, 'PENDING|-');
expect('F2 a Factura A order: 3 boxes × 36.000 + IVA → the client owes 130.680', ADM(`SELECT deliver_order(${P(PED('fa'))}::uuid, ${AT})::text`, 'd1'),
  'OK:%"iva": 22680.00%"net": 108000.00%"order_total": 130680.00%');
expect('F3 the client ledger carries net + IVA', LEDGER('fa'), '130680.00');
expect('F4 the issued Factura A: INVOICE_A / DEBITO, the client, net, total, no number yet, its order',
  `(SELECT (${DOC('fa')}).document_type::text || '|' || (${DOC('fa')}).direction::text || '|' || ((${DOC('fa')}).cliente_id = (SELECT cliente_id FROM pedidos WHERE id = ${PED('fa')}))::text || '|' || (${DOC('fa')}).net_amount || '|' || (${DOC('fa')}).total_amount || '|' || coalesce((${DOC('fa')}).external_number, '-') || '|' || (${DOC('fa')}).fiscal_period || '|' || (${DOC('fa')}).document_date)`,
  'INVOICE_A|DEBITO|true|108000.00|130680.00|-|2026-11-01|2026-11-20');
expect('F5 … its IVA débito fiscal component: base net, rate 21, the IVA',
  `(SELECT string_agg(tax_kind::text || '|' || direction::text || '|' || base_amount || '|' || rate_applied || '|' || tax_amount, ',') FROM fiscal_document_component WHERE fiscal_document_id = (${DOC('fa')}).id)`,
  'IVA|DEBITO|108000.00|21.0000|22680.00');
expect('F6 the sale (P&L / reports) stays the net: the lines are untouched', `(SELECT sum(subtotal)::text FROM pedido_lineas WHERE pedido_id = ${PED('fa')} AND is_current)`, '108000.00%');
expect('F7 an order without Factura A: the client owes the net, no fiscal document', ADM(`SELECT deliver_order(${P(PED('comun'))}::uuid, ${AT})::text`), 'OK:%"iva": 0%"order_total": 108000.00%');
expect('F8 … ledger 108.000, no document', `(${LEDGER('comun')} || '|' || (SELECT count(*) FROM fiscal_document WHERE pedido_id = ${PED('comun')}))`, '108000.00|0');
expect('F9 rectified to 4 boxes: the IVA is recalculated (net 144.000 + 30.240)',
  ADM(`SELECT rectify_delivered_order(${P(PED('fa'))}::uuid, '[{"producto_id": "[[${PRODUCTO}]]", "cantidad": 4, "precio_unitario": 36000}]'::jsonb, 'eran 4 cajas')::text`),
  'OK:%"new_total": 174240.00, "adjustment": 43560.00%"previous_total": 130680.00%');
expect('F10 … the client ledger now nets 174.240', LEDGER('fa'), '174240.00');
expect('F11 … the Factura A follows: net, total and IVA', `(SELECT (${DOC('fa')}).net_amount || '|' || (${DOC('fa')}).total_amount || '|' || (SELECT tax_amount || '|' || base_amount FROM fiscal_document_component WHERE fiscal_document_id = (${DOC('fa')}).id))`,
  '144000.00|174240.00|30240.00|144000.00');
expect('F12 … audited with before / after', `(SELECT count(*)::text || '|' || max(before_values->>'total') || '|' || max(after_values->>'total') FROM audit_events WHERE entity_type = 'fiscal_document' AND action = 'RECTIFY_SALE_INVOICE' AND entity_id = (${DOC('fa')}).id::text)`, '1|130680.00|174240.00');
expect('F13 rectifying an order without Factura A stays as before (no IVA)',
  ADM(`SELECT rectify_delivered_order(${P(PED('comun'))}::uuid, '[{"producto_id": "[[${PRODUCTO}]]", "cantidad": 2, "precio_unitario": 36000}]'::jsonb, 'eran 2')::text`), 'OK:%"new_total": 72000.00%"previous_total": 108000.00%');
expect('F14 an OPERATOR cannot set the invoice number', as('authenticated', OPER, `SELECT set_sale_invoice_number(${P(PED('fa'))}::uuid, '00003-00000123')::text`), 'ERR:FORBIDDEN%');
expect('F15 the number of the Factura A is set', ADM(`SELECT set_sale_invoice_number(${P(PED('fa'))}::uuid, ' 00003-00000123 ')::text`), 'OK:{"number": "00003-00000123", "changed": true%');
expect('F16 … stored and audited', `(SELECT (${DOC('fa')}).external_number || '|' || (SELECT count(*) FROM audit_events WHERE action = 'SET_SALE_INVOICE_NUMBER' AND entity_id = (${DOC('fa')}).id::text))`, '00003-00000123|1');
expect('F17 the same number again changes nothing', ADM(`SELECT set_sale_invoice_number(${P(PED('fa'))}::uuid, '00003-00000123')::text`), 'OK:%"changed": false%');
expect('F18 another Factura A cannot take the same number', ADM(`SELECT deliver_order(${P(PED('fa2'))}::uuid, ${AT})::text || set_sale_invoice_number(${P(PED('fa2'))}::uuid, '00003-00000123')::text`), 'ERR:DUPLICATE_INVOICE_NUMBER%');
expect('F19 an invalid number is refused', ADM(`SELECT set_sale_invoice_number(${P(PED('fa'))}::uuid, '0003;drop')::text`), 'ERR:INVALID_INVOICE_NUMBER%');
expect('F20 an order without Factura A has no number to set', ADM(`SELECT set_sale_invoice_number(${P(PED('comun'))}::uuid, '1')::text`), 'ERR:SALE_INVOICE_NOT_FOUND%');
expect('F21 the number can be cleared', ADM(`SELECT set_sale_invoice_number(${P(PED('fa'))}::uuid, NULL)::text`), 'OK:%"changed": true%');
expect('F22 rights: set_sale_invoice_number definer, EXECUTE authenticated only', `(SELECT p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_sale_invoice_number(uuid,text)'))`, 'true|falsetruefalse');
expect('F23 rights: tax_is_debcred_mp / client_cuit are not definers, no anon', `(SELECT string_agg(p.prosecdef || has_function_privilege('anon', p.oid, 'EXECUTE')::text, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.tax_is_debcred_mp(text)'), to_regprocedure('public.client_cuit(text)')))`, 'falsefalse,falsefalse');
expect('F24 client_cuit: 11 digits from any format, otherwise NULL', `(SELECT client_cuit('20-12345678-9') || '|' || coalesce(client_cuit('12345678'), '-') || '|' || coalesce(client_cuit(NULL), '-'))`, '20123456789|-|-');
// B — Mercado Pago debits / credits tax (seeded: an inflow of 7.500 with its 45 tax, and one of 1.000 with a 10 tax that is not 0.6 %)
add(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason, created_by) VALUES
  ('MP_SETTLEMENT', '2026-11-29', 'MP:MPA:991350001:SETTLE', 'T0135', '${ADMIN}'), ('ADJUSTMENT', '2026-11-29', 'MP:MPA:991350001:TAX', 'ADR-006 auto-apply', '${ADMIN}'),
  ('MP_SETTLEMENT', '2026-11-29', 'MP:MPA:991350002:SETTLE', 'T0135', '${ADMIN}'), ('ADJUSTMENT', '2026-11-29', 'MP:MPA:991350002:TAX', 'ADR-006 auto-apply', '${ADMIN}');
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
SELECT o.id, (SELECT id FROM financial_account WHERE account_type::text = 'MERCADO_PAGO' OR nombre ILIKE '%mercado%' ORDER BY id LIMIT 1), x.amt, '2026-11-29', '${ADMIN}'
  FROM (VALUES ('MP:MPA:991350001:SETTLE', 7500), ('MP:MPA:991350001:TAX', -45), ('MP:MPA:991350002:SETTLE', 1000), ('MP:MPA:991350002:TAX', -10)) x(ref, amt)
  JOIN financial_operation o ON o.external_ref = x.ref;`);
expect('F25 an inflow tax of exactly 0.6 % is the débitos y créditos tax; another amount is not',
  `(SELECT tax_is_debcred_mp('MP:MPA:991350001:TAX') || '|' || tax_is_debcred_mp('MP:MPA:991350002:TAX') || '|' || tax_is_debcred_mp('MP:MPA:991350001:SETTLE') || '|' || tax_is_debcred_mp(NULL))`, 'true|false|false|false');
expect('F26 the list names it «Imp. débitos y créditos MP»; the other stays «Impuesto de Mercado Pago»',
  `(SELECT string_agg(e->>'concepto', ',' ORDER BY (e->>'amount')::numeric) FROM jsonb_array_elements(substr(pg_temp.run_as('authenticated', '${ADMIN}', 'SELECT fin_operation_list(p_from => ''2026-11-29'', p_to => ''2026-11-29'', p_limit => 100)::text', NULL), 4)::jsonb->'rows') e
     WHERE (e->>'operation_id')::bigint IN (SELECT id FROM financial_operation WHERE external_ref IN ('MP:MPA:991350001:TAX', 'MP:MPA:991350002:TAX')))`,
  'Imp. débitos y créditos MP,Impuesto de Mercado Pago');   // ordered by amount: −45, then −10
expect('F27 the period report (ADMIN) adds the Mercado Pago débitos y créditos (the 45, not the 10)',
  `(SELECT pg_temp.read_as('${ADMIN}', $q$SELECT (sum(amount_paid) FILTER (WHERE tax_kind::text = 'DEBITOS_CREDITOS'))::text FROM report_bank_tax_period WHERE period = '2026-11-01' AND financial_account_id = (SELECT financial_account_id FROM financial_posting WHERE financial_operation_id = (SELECT id FROM financial_operation WHERE external_ref = 'MP:MPA:991350001:TAX'))$q$)::numeric
     - (SELECT coalesce(sum(-p.signed_amount), 0) FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id AND p.signed_amount < 0
         WHERE o.effective_date >= '2026-11-01' AND o.effective_date < '2026-12-01' AND o.external_ref NOT LIKE 'MP:MPA:99135000%'
           AND p.financial_account_id = (SELECT financial_account_id FROM financial_posting WHERE financial_operation_id = (SELECT id FROM financial_operation WHERE external_ref = 'MP:MPA:991350001:TAX'))
           AND (o.external_ref LIKE 'MP-OUTFLOW-TAX:%' OR tax_is_debcred_mp(o.external_ref))))::text`, '45.00');
expect('F28 an OPERATOR reads nothing from the period report', `pg_temp.read_as('${OPER}', 'SELECT count(*)::text FROM report_bank_tax_period')`, '0');
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
