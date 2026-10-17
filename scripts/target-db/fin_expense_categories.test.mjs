#!/usr/bin/env node
/**
 * ADR-024 — EXPENSE CATEGORY → SUBCATEGORY, RESERVED SUBCATEGORIES, FISCAL ROUTES (migrations 0096 / 0098). LOCAL TEST DATABASE ONLY.
 *
 * 14 parent categories over the existing subcategories (ids kept), Afrechillo de trigo, Cartones (kept when it exists), default purchase nature (pre-filled,
 * overridable per operation), withdrawal socios and the fiscal-reserved IVA / Ganancias refused for new purchases (a legacy
 * rectification keeps its category), the optional socio of a Retiro de socios (still RETIROS), the Fiscal IVA payment and the
 * "Solo crédito fiscal IVA" document (issuer by CUIT; no money, no purchase, no payable, no P&L; IVA credit), audited ADMIN-only
 * category administration and no financial effect.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_expense_categories.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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

// ── SQL helpers ──────────────────────────────────────────────────────────────
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0096-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0096-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR024-0096-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved by run_as as the owner, before the role switch
const PARSER = 'mp-release-report-csv/1.1.0';
const DAY = '2026-10-13';
const FORMAT = 'MP_RELEASE_REPORT_CSV_V1';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);

const EMPTY = { BALANCE_AMOUNT: '', BUSINESS_UNIT: '', DATE: '', DESCRIPTION: '', GROSS_AMOUNT: '', MP_FEE_AMOUNT: '',
  NET_CREDIT_AMOUNT: '', NET_DEBIT_AMOUNT: '', PAYMENT_METHOD: '', PAYMENT_METHOD_TYPE: '', PURCHASE_ID: '', SOURCE_ID: '',
  SUB_UNIT: '', TAXES_AMOUNT: '', TRANSACTION_APPROVAL_DATE: '' };
const mv = (t, sid, desc, credit, debit, gross, tax, bal, method = 'available_money', type = 'account_money') => ({
  ...EMPTY, DATE: `${DAY}T${t}.000-03:00`, SOURCE_ID: sid, DESCRIPTION: desc, NET_CREDIT_AMOUNT: credit, NET_DEBIT_AMOUNT: debit,
  GROSS_AMOUNT: gross, MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: tax, PAYMENT_METHOD: method, TRANSACTION_APPROVAL_DATE: `${DAY}T${t}.000-03:00`,
  BALANCE_AMOUNT: bal, PAYMENT_METHOD_TYPE: type });
const CTL = { ...EMPTY, DATE: `${DAY}T00:00:00.000-03:00`, NET_CREDIT_AMOUNT: '10000.00', NET_DEBIT_AMOUNT: '0.00',
  GROSS_AMOUNT: '10000.00', MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '10000.00' };
const TOT = { ...EMPTY, NET_CREDIT_AMOUNT: '0.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '-762462.72', MP_FEE_AMOUNT: '0.00',
  TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '0.00' };
const rowsOf = (raws) => raws.map((raw_row, i) => ({ row_number: i + 1, raw_row }));

function captureCall(o) {
  const s = o.sha;
  return `SELECT ${o.fn ?? 'fin_capture_mp_release_report'}(${lit(o.actor === undefined ? ADMIN : o.actor)}::uuid, ${lit(PARSER)},
    ${lit(FORMAT)}, ${lit(s)}, ${P(`'mp/' || ${MPACC} || '/${s}.csv'`)}, 'release-report.csv', 2048,
    ${lit(DAY)}::date, ${lit(DAY)}::date, ${lit(JSON.stringify({ report_type: 'release_report', task_id: '1' }))}::jsonb,
    NULL, ${lit(JSON.stringify(o.rows))}::jsonb)::text`;
}
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const NORMAL = (o, key) => as('service_role', null, captureCall({ ...o, fn: 'fin_ingest_mp_release_report' }), key);

const FIN_TABLES = ['financial_operation', 'financial_posting', 'mp_reconciliation', 'mp_financial_movement', 'mp_transition_identity',
  'mp_source_record', 'fin_mp_payout_destination', 'fin_import_run_line', 'mp_client_allocation', 'fin_statement_line', 'fin_statement_match', 'purchases', 'management_event', 'suppliers'];
const counts = () => FIN_TABLES.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const delta = (snap) => `(SELECT string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t) FROM (${counts()}) c JOIN ${snap} b ON b.t = c.t WHERE c.n <> b.n)`;
const BAL = (acc) => `(SELECT coalesce(sum(p.signed_amount), 0) FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id WHERE a.nombre = '${acc}')`;
const PNL = `SELECT md5(coalesce((SELECT string_agg(x::text, '#' ORDER BY x::text) FROM pnl_summary x), '')) || md5(coalesce((SELECT string_agg(x::text, '#' ORDER BY x::text) FROM pnl_line_item x), ''))`;

add(`\\set ON_ERROR_STOP 1
BEGIN;
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
    PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
                                                  ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
    EXECUTE p_sql INTO v;
    ok := true;
    RESET ROLE;
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
CREATE FUNCTION pg_temp.must(p_name TEXT, p_got TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE 'OK:%' THEN RAISE NOTICE 'FAIL setup % :: %', p_name, left(p_got, 300); END IF;
END $f$;
CREATE FUNCTION pg_temp.err_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN others THEN RETURN 'ERR:' || SQLERRM; END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'adr024-0096-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr024-0096-oper@test.local',  'OPERATOR');`);

// ── fixtures ─────────────────────────────────────────────────────────────────
const SUP = 'cccccccc-0096-0000-0000-0000000000a1';
add(`INSERT INTO suppliers (id, nombre) VALUES ('${SUP}', 'Proveedor ADR-024');`);
const CAT = (n) => `(SELECT id FROM expense_category WHERE nombre = '${n}')`;
const GRP = (n) => `(SELECT id FROM expense_category_group WHERE nombre = '${n}')`;
const BNA = `(SELECT id FROM financial_account WHERE nombre = 'BNA')`;
const A = (q, key = null) => as('authenticated', ADMIN, q, key);
const PURCHASE = (cat, nature, key, sup = SUP) => A(`SELECT register_purchase(${sup ? `'${sup}'::uuid` : 'NULL'}, DATE '2026-10-16', 1000, 1000, ${P(cat)}::uuid, NULL, '${nature}',
  ${lit(JSON.stringify([{ descripcion: 'ADR-024', cantidad: 1, unit_type: 'UNIT', precio_unitario: 1000 }]))}::jsonb, '[]'::jsonb, ${lit(key)})::text`, key);
const FINSNAP = `SELECT (SELECT count(*) FROM financial_operation) || ':' || (SELECT count(*) FROM financial_posting) || ':' || (SELECT count(*) FROM purchases)
  || ':' || (SELECT count(*) FROM supplier_ledger) || ':' || (SELECT count(*) FROM client_ledger) || ':' || (SELECT count(*) FROM management_event)`;
add(`CREATE TEMP TABLE f0 AS SELECT (${FINSNAP}) AS v; CREATE TEMP TABLE p0 AS SELECT ${as('authenticated', ADMIN, PNL)} AS h;`);

// ── A–F. the category model ──
expect('A-1 14 parent categories, in the authoritative order; Retiros de socios is OWNER_WITHDRAWAL, the rest EXPENSE; no "Imputar solo IVA"',
  `(SELECT string_agg(display_order || ':' || nombre || ':' || kind, ',' ORDER BY display_order) FROM expense_category_group)`,
  '1:Insumos alimento balanceado:EXPENSE,2:Cartones / envases:EXPENSE,3:Mano de obra:EXPENSE,4:Retiros de socios:OWNER_WITHDRAWAL,5:Combustible:EXPENSE,6:Servicios:EXPENSE,'
  + '7:Materiales / Repuestos:EXPENSE,8:Logística / Fletes:EXPENSE,9:Impuestos y tasas:EXPENSE,10:Insumos varios:EXPENSE,11:Otros:EXPENSE,12:Créditos:EXPENSE,13:Recria:EXPENSE,14:Feria:EXPENSE');
expect('B-1 the pre-existing subcategories keep their ids (created before 0096, none recreated; 52 here, 53 in production with Cartones); 54 in total, 52 active',
  `(SELECT count(*) FILTER (WHERE created_at < (SELECT applied_at FROM migration_ledger.applied WHERE version = '0096')) + count(*) FILTER (WHERE nombre IN ('Afrechillo de trigo', 'Cartones')
     AND created_at >= (SELECT applied_at FROM migration_ledger.applied WHERE version = '0096')) || ':' || count(*) || ':' || count(*) FILTER (WHERE activo) FROM expense_category)`, '54:54:52');
expect('C-1 Afrechillo de trigo exactly once, under Insumos alimento balanceado, OPERATING, active', `(SELECT count(*) || ':' || min(g.nombre) || ':' || min(c.default_nature::text) || ':' || bool_and(c.activo)
   FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE c.nombre = 'Afrechillo de trigo')`, '1:Insumos alimento balanceado:OPERATING:true');
expect('C-2 Cartones exactly once, under Cartones / envases, OPERATING, active, not reserved (created after the cutover by a real purchase; kept)',
  `(SELECT count(*) || ':' || min(g.nombre) || ':' || min(c.default_nature::text) || ':' || bool_and(c.activo) || ':' || bool_and(NOT c.fiscal_reserved)
   FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE c.nombre = 'Cartones')`, '1:Cartones / envases:OPERATING:true:true');
expect('C-3 Cartones / envases lists Cartones and the three mangas', A(`SELECT string_agg(c.nombre, ',' ORDER BY c.nombre) FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE c.activo AND g.nombre = 'Cartones / envases'`),
  'OK:Cartones,Manga x125U - Docenas,Manga x125U - Maples20u,Manga x125U - Maples30u');
expect('D-1 Gastos de Feria → Feria (the feria closing still finds it by name)', `(SELECT g.nombre FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE c.nombre = 'Gastos de Feria')`, 'Feria');
expect('E-1 parent backfill complete: group_id mandatory, no orphan', `((SELECT attnotnull::text FROM pg_attribute WHERE attrelid = 'expense_category'::regclass AND attname = 'group_id') || ':' || (SELECT count(*) FROM expense_category WHERE group_id IS NULL))`, 'true:0');
expect('F-1 default nature: every active expense subcategory has one; withdrawal socios and the reserved IVA / Ganancias have none',
  `(SELECT count(*) FILTER (WHERE g.kind = 'EXPENSE' AND NOT c.fiscal_reserved AND c.default_nature IS NULL) || ':' || count(*) FILTER (WHERE (g.kind = 'OWNER_WITHDRAWAL' OR c.fiscal_reserved) AND c.default_nature IS NOT NULL)
   FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id)`, '0:0');
expect('F-2 approved defaults: INVESTMENT Pollitas BB / Arreglos edilicios; REINVESTMENT Servicios técnicos / Herramientas / Repuestos; OPERATING Materiales, Chacra, Compras viejas, Otros, Gastos no clasificados, Gastos de Feria',
  `(SELECT string_agg(nombre || '=' || default_nature, ',' ORDER BY nombre) FROM expense_category WHERE nombre IN ('Pollitas BB', 'Arreglos edilicios', 'Servicios técnicos', 'Herramientas', 'Repuestos',
     'Materiales', 'Chacra', 'Compras viejas', 'Otros', 'Gastos no clasificados', 'Gastos de Feria'))`,
  'Arreglos edilicios=INVESTMENT,Chacra=OPERATING,Compras viejas=OPERATING,Gastos de Feria=OPERATING,Gastos no clasificados=OPERATING,Herramientas=REINVESTMENT,Materiales=OPERATING,Otros=OPERATING,Pollitas BB=INVESTMENT,Repuestos=REINVESTMENT,Servicios técnicos=REINVESTMENT');
expect('K-1 ProPAV (Créditos) defaults OPERATING (owner simplification)', `(SELECT g.nombre || ':' || c.default_nature FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE c.nombre = 'ProPAV')`, 'Créditos:OPERATING');
expect('G-1 a category lists only its active subcategories (ADMIN read): Combustible → Gasoil, Nafta; Impuestos y tasas → Comisiones, Monotributo, Otros impuestos',
  A(`SELECT string_agg(g.nombre || '>' || c.nombre, ',' ORDER BY g.nombre, c.nombre) FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE c.activo AND g.nombre IN ('Combustible', 'Impuestos y tasas')`),
  'OK:Combustible>Gasoil,Combustible>Nafta,Impuestos y tasas>Comisiones,Impuestos y tasas>Monotributo,Impuestos y tasas>Otros impuestos');

// ── H–J. nature per operation ──
expect('H-1 the subcategory default the form pre-fills: Gasoil → OPERATING', A(`SELECT default_nature::text FROM expense_category WHERE nombre = 'Gasoil'`), 'OK:OPERATING');
expect('I-1 the owner overrides the nature for one operation: a Gasoil purchase stored as INVESTMENT', PURCHASE(CAT('Gasoil'), 'INVESTMENT', 'T96-I1'), 'OK:%');
expect('I-2 … the purchase keeps INVESTMENT', `(SELECT nature::text FROM purchases WHERE idempotency_key = 'T96-I1')`, 'INVESTMENT');
expect('J-1 … and the master default is unchanged (OPERATING)', `(SELECT default_nature::text FROM expense_category WHERE nombre = 'Gasoil')`, 'OPERATING');

// ── L / O. reserved subcategories ──
expect('L-1 Santi / Fran / Padres are refused for a purchase (CATEGORY_NOT_SELECTABLE)', `(${PURCHASE(CAT('Santi'), 'OPERATING', 'T96-L1')} || '|' || ${PURCHASE(CAT('Padres'), 'OPERATING', 'T96-L1b')})`,
  'ERR:CATEGORY_NOT_SELECTABLE: Santi%Retiro de socios|ERR:CATEGORY_NOT_SELECTABLE: Padres%');
expect('L-2 … and for freight', A(`SELECT register_freight(DATE '2026-10-16', 500, ${P(CAT('Fran'))}::uuid, 'T96-L2')::text`), 'ERR:CATEGORY_NOT_SELECTABLE: Fran%');
expect('O-1 IVA / Ganancias: deactivated, fiscal-reserved, refused for a new purchase (Fiscal route)',
  `((SELECT string_agg(nombre || ':' || activo || ':' || fiscal_reserved, ',' ORDER BY nombre) FROM expense_category WHERE nombre IN ('IVA', 'Ganancias')) || '|' || ${PURCHASE(CAT('IVA'), 'OPERATING', 'T96-O1')} || '|' || ${PURCHASE(CAT('Ganancias'), 'OPERATING', 'T96-O1b')})`,
  'Ganancias:false:true,IVA:false:true|ERR:CATEGORY_NOT_SELECTABLE: IVA%Fiscal|ERR:CATEGORY_NOT_SELECTABLE: Ganancias%');
// a legacy purchase with the IVA category (history before 0096) can still be rectified: it keeps its own category
add(`ALTER TABLE purchases DISABLE TRIGGER trg_purchases_category_selectable;
INSERT INTO purchases (id, supplier_id, economic_date, amount_net, amount_total, expense_category_id, nature, idempotency_key)
VALUES ('cccccccc-0096-0000-0000-0000000000b1', '${SUP}', DATE '2026-10-10', 300, 300, ${CAT('IVA')}, 'OPERATING', 'T96-LEGACY');
INSERT INTO purchase_line (purchase_id, descripcion, cantidad, unit_type, precio_unitario) VALUES ('cccccccc-0096-0000-0000-0000000000b1', 'legacy', 1, 'UNIT', 300);
ALTER TABLE purchases ENABLE TRIGGER trg_purchases_category_selectable;`);
expect('O-2 a legacy IVA purchase is still rectifiable (the new version keeps its own category)',
  A(`SELECT rectify_purchase('cccccccc-0096-0000-0000-0000000000b1', 250, 250, ${lit(JSON.stringify([{ descripcion: 'legacy', cantidad: 1, unit_type: 'UNIT', precio_unitario: 250 }]))}::jsonb, 'ADR-024 test')::text`), 'OK:%');

// ── M / N. withdrawal socio ──
const RETIRO = (key, socio, type = 'RETIRO', comp = null) => A(`SELECT register_management_event('${type}', DATE '2026-10-16', 400, ${lit(key)}, 'ADR-024 test', ${type === 'RETIRO' ? `${P(BNA)}::uuid` : 'NULL'},
  ${comp ? `${P(`(SELECT id FROM management_event WHERE idempotency_key = '${comp}')`)}::uuid` : 'NULL'}, ${socio ? `${P(CAT(socio))}::uuid` : 'NULL'})::text`);
expect('M-1 a Retiro de socios stores the optional socio (Santi); without socio it is still valid', `(${RETIRO('T96-M1', 'Santi')} || '|' || ${RETIRO('T96-M1b', null)})`, 'OK:%|OK:%');
expect('M-2 the socio is stored on the event', `(SELECT string_agg(e.idempotency_key || ':' || coalesce(c.nombre, '-'), ',' ORDER BY e.idempotency_key) FROM management_event e LEFT JOIN expense_category c ON c.id = e.socio_category_id WHERE e.idempotency_key LIKE 'T96-M1%')`, 'T96-M1:Santi,T96-M1b:-');
expect('M-3 an ordinary subcategory is not a socio; a reserva interna has no socio', `(${RETIRO('T96-M3', 'Gasoil')} || '|' || ${RETIRO('T96-M3b', 'Fran', 'RESERVA_INTERNA')})`, 'ERR:INVALID_SOCIO%|ERR:SOCIO_NOT_ALLOWED%');
expect('M-4 a compensation inherits the socio of the original withdrawal', `(${A(`SELECT register_management_event('RETIRO', DATE '2026-10-16', 100, 'T96-M4', 'devolución', NULL, ${P(`(SELECT id FROM management_event WHERE idempotency_key = 'T96-M1')`)}::uuid)::text`)} LIKE 'OK:%')::text`, 'true');
expect('M-5 … stored with Santi', `(SELECT c.nombre FROM management_event e JOIN expense_category c ON c.id = e.socio_category_id WHERE e.idempotency_key = 'T96-M4')`, 'Santi');
expect('N-1 the withdrawal still posts to RETIROS (P&L) and moves BNA', A(`SELECT string_agg(li.bucket || ':' || li.signed_amount, ',') FROM pnl_line_item li WHERE li.source_entity_type = 'management_event' AND li.source_entity_id = (SELECT id::text FROM management_event WHERE idempotency_key = 'T96-M1')`), 'OK:RETIROS:-400.00');

// ── P / Q. fiscal routes ──
add(`CREATE TEMP TABLE q0 AS SELECT (${FINSNAP}) AS v, ${BAL('BNA')} AS bna;
CREATE TEMP TABLE q0p AS SELECT ${as('authenticated', ADMIN, PNL)} AS h;
CREATE TEMP TABLE q0f AS SELECT coalesce((SELECT credit_amount FROM report_fiscal_period WHERE tax_kind = 'IVA' AND period = DATE '2026-10-01'), 0) AS c;`);
expect('Q-1 "Solo crédito fiscal IVA": a manual CREDITO document by issuer CUIT, no supplier (net 100000, IVA 21000, total 121000)',
  A(`SELECT register_fiscal_document('INVOICE_A', 'CREDITO', DATE '2026-10-16', DATE '2026-10-01', 100000, 121000,
     '[{"tax_kind": "IVA", "direction": "CREDITO", "base_amount": 100000, "rate_applied": 21, "tax_amount": 21000}]'::jsonb, NULL, NULL, '0001-00004321', 'ADR-024 test', '20123456786', 'Ferretería Test')::text`), 'OK:%');
expect('Q-2 … money movement 0, purchase 0, supplier payable 0, P&L unchanged', `((SELECT v FROM q0) = (${FINSNAP}))::text || '|' || ((SELECT h FROM q0p) = ${as('authenticated', ADMIN, PNL)})::text`, 'true|true');
expect('Q-3 … the IVA credit of the period grows by 21000; the document keeps the issuer (no supplier)',
  `((SELECT coalesce((SELECT credit_amount FROM report_fiscal_period WHERE tax_kind = 'IVA' AND period = DATE '2026-10-01'), 0) - c FROM q0f)::text || '|' || (SELECT supplier_id IS NULL AND issuer_tax_id = '20123456786' AND external_number = '0001-00004321' FROM fiscal_document WHERE external_number = '0001-00004321')::text)`,
  '21000.00|true');
expect('Q-4 the issuer form is validated (CUIT 11 digits)', A(`SELECT register_fiscal_document('INVOICE_A', 'CREDITO', DATE '2026-10-16', DATE '2026-10-01', 100, 121, '[]'::jsonb, NULL, NULL, '0001-1', 'x', '123')::text`), 'ERR:INVALID_ISSUER%');
expect('P-1 IVA payment through Fiscal: obligation registered and paid from BNA',
  `(${A(`SELECT register_fiscal_obligation('IVA', DATE '2026-10-01', 5000, NULL, NULL, 'ADR-024 test')::text`, 'OBL')} LIKE 'OK:%' AND ${A(`SELECT pay_fiscal_obligation(${P(`(SELECT id FROM fiscal_obligation WHERE tax_kind = 'IVA' AND fiscal_period = DATE '2026-10-01' AND amount = 5000 ORDER BY created_at DESC LIMIT 1)`)}::uuid, DATE '2026-10-16', 5000, ${P(BNA)}::uuid, 'T96-P1')::text`)} LIKE 'OK:%')::text`, 'true');
expect('P-2 … BNA −5000, no purchase, no P&L line from the payment', `((SELECT (${BAL('BNA')} - bna)::text FROM q0) || '|' || (SELECT count(*) FROM purchases WHERE idempotency_key LIKE 'T96-P%') || '|' || ((SELECT h FROM q0p) = ${as('authenticated', ADMIN, PNL)})::text)`, '-5000.00|0|true');

// ── category administration (audited, ADMIN only) and R. no financial effect ──
add(`CREATE TEMP TABLE r0 AS SELECT (${FINSNAP}) AS v; CREATE TEMP TABLE r0p AS SELECT ${as('authenticated', ADMIN, PNL)} AS h; CREATE TEMP TABLE r0a AS SELECT count(*) AS n FROM audit_events WHERE entity_type IN ('expense_category', 'expense_category_group');`);
expect('ADM-1 ADMIN creates a category and a subcategory (no legacy class asked: taken from the siblings / INDIRECT)',
  `(${A(`INSERT INTO expense_category_group (nombre, display_order) VALUES ('Prueba ADR-024', 99) RETURNING 'g'`)} || '|' || ${A(`INSERT INTO expense_category (nombre, group_id, default_nature) VALUES ('Sub prueba', ${P(GRP('Prueba ADR-024'))}::uuid, 'OPERATING') RETURNING pnl_cost_class::text`)}
    || '|' || ${A(`INSERT INTO expense_category (nombre, group_id, default_nature) VALUES ('Sub alimento', ${P(GRP('Insumos alimento balanceado'))}::uuid, 'OPERATING') RETURNING pnl_cost_class::text`)})`, 'OK:g|OK:INDIRECT|OK:DIRECT');
expect('ADM-2 rename, move and deactivate a subcategory; change a default nature', `(${A(`UPDATE expense_category SET nombre = 'Sub renombrada', group_id = ${P(GRP('Otros'))}::uuid, default_nature = 'INVESTMENT', activo = false WHERE nombre = 'Sub prueba' RETURNING 'u'`)})`, 'OK:u');
expect('ADM-3 every change is audited (2 creates of subcategories, 1 of the category, 1 update)', `((SELECT count(*) FROM audit_events WHERE entity_type IN ('expense_category', 'expense_category_group')) - (SELECT n FROM r0a))::text`, '4');
expect('ADM-4 an OPERATOR cannot create categories; nobody can delete one through the API',
  `(${as('authenticated', OPER, `INSERT INTO expense_category_group (nombre) VALUES ('x') RETURNING 'g'`)} || '|' || ${A(`DELETE FROM expense_category WHERE nombre = 'Sub alimento' RETURNING 'd'`)})`, 'ERR:%row-level security%|ERR:permission denied%');
expect('ADM-5 duplicate category names (case-insensitive) are refused', A(`INSERT INTO expense_category_group (nombre) VALUES ('combustible') RETURNING 'g'`), 'ERR:duplicate key%');
expect('R-1 the category model writes no financial row and does not change the P&L', `((SELECT v FROM r0) = (${FINSNAP}))::text || '|' || ((SELECT h FROM r0p) = ${as('authenticated', ADMIN, PNL)})::text`, 'true|true');
expect('R-2 SECURITY DEFINER set 94 (expense_category_audit)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '94');

add('ROLLBACK;');

// ── run ──────────────────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);

const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const lines = `${r.stdout}\n${r.stderr}`.split('\n');
let pass = 0;
let fail = 0;
for (const l of lines) {
  const m = l.match(/NOTICE:\s+(PASS|FAIL) (.*)$/);
  if (m) {
    if (m[1] === 'PASS') { pass += 1; console.log(`    OK   ${m[2]}`); } else { fail += 1; console.log(`    MAL  ${m[2]}`); }
  }
}
if (r.status !== 0) {
  fail += 1;
  console.log(`    MAL  psql aborted: ${(lines.find((l) => /ERROR/.test(l)) || r.stderr || '').slice(0, 300)}`);
}
console.log(`\n  ══ ADR-024 0096 EXPENSE CATEGORIES RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
