#!/usr/bin/env node
/**
 * ADR-019 — CASUAL PURCHASES WITHOUT A SUPPLIER (migration 0088). LOCAL TEST DATABASE ONLY.
 *
 * Supplier purchases unchanged; a casual purchase (supplier NULL, optional trimmed counterparty name) is born paid by ONE
 * PURCHASE_PAYMENT operation, never touches the supplier ledger, reaches the P&L through purchases; an optional received
 * invoice identifies its issuer by CUIT (duplicates refused, IVA credit through report_fiscal_period); one payment per
 * current purchase; amount-locked rectification, versioned reclassification; Mercado Pago money anchored to one payout
 * SOURCE_ID (exact replay → no-op, conflicting classification refused, own-account payout refused).
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_casual_purchase.test.mjs
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
const ADMIN = 'aaaaaaaa-0089-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0089-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR-019-0088-${seed}`).digest('hex');
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
const TOT = { ...EMPTY, NET_CREDIT_AMOUNT: '0.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '-1259.86', MP_FEE_AMOUNT: '0.00',
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
  'mp_source_record', 'fin_mp_payout_destination', 'fin_import_run_line', 'mp_client_allocation', 'fin_statement_line', 'fin_statement_match',
  'purchases', 'purchase_line', 'fiscal_document', 'fiscal_document_component', 'supplier_ledger', 'mp_outflow_classification'];
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
CREATE FUNCTION pg_temp.err_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN others THEN RETURN 'ERR:' || SQLERRM; END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'adr019-0088-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr019-0088-oper@test.local',  'OPERATOR');`);

// ── fixtures ────────────────────────────────────────────────────────────────
const SUP = 'cccccccc-0089-0000-0000-0000000000a1';
const CAT = 'cccccccc-0089-0000-0000-0000000000c1';   // INDIRECT
const CATD = 'cccccccc-0089-0000-0000-0000000000c2';  // DIRECT
add(`INSERT INTO suppliers (id, nombre) VALUES ('${SUP}', 'Proveedor ADR-019');
INSERT INTO expense_category (id, nombre, pnl_cost_class) VALUES ('${CAT}', 'Categoría ADR-019 indirecta', 'INDIRECT'), ('${CATD}', 'Categoría ADR-019 directa', 'DIRECT');`);
const ACC = (n) => `(SELECT id FROM financial_account WHERE nombre = '${n}')`;
const D = '2026-10-13';
const CASUAL = (o = {}) => {
  const v = { date: D, net: '1000', total: '1000', cat: CAT, concept: 'Repuestos', nature: 'OPERATING', acc: 'BNA', method: 'TRANSFER', key: 'ADR019-K1',
    name: null, lines: '[]', fiscal: null, sid: null, role: 'authenticated', uid: ADMIN, ...o };
  return as(v.role, v.uid, `SELECT register_casual_purchase('${v.date}'::date, ${v.net}, ${v.total}, '${v.cat}'::uuid, ${lit(v.concept)}, '${v.nature}'::purchase_nature,
    ${P(ACC(v.acc))}::uuid, '${v.method}'::payment_method, ${lit(v.key)}, ${lit(v.name)}, ${lit(v.lines)}::jsonb, '[]'::jsonb,
    ${v.fiscal ? `${lit(JSON.stringify(v.fiscal))}::jsonb` : 'NULL'}, NULL, NULL, ${lit(v.sid)}, NULL)::text`, v.res ?? null);
};
const PUR = (key, cols) => `(SELECT ${cols} FROM purchases WHERE idempotency_key = '${key}')`;
const SUPLEDGER = `(SELECT count(*) FROM supplier_ledger)`;
const PNLBUCKET = (b) => as('authenticated', ADMIN, `SELECT coalesce(sum(signed_amount), 0)::text FROM pnl_line_item WHERE bucket = '${b}' AND source_entity_type = 'purchases' AND business_date = '${D}' AND description LIKE 'ADR019%'`);
const FISCAL = (n, extra = {}) => ({ document_type: 'INVOICE_A', document_date: D, fiscal_period: '2026-10-01', net_amount: 1000, total_amount: 1210,
  external_number: `0001-0000${n}`, issuer_tax_id: '30712345678', issuer_name: 'Ferretería del Centro', components: [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 1000, rate_applied: 21, tax_amount: 210 }], ...extra });
const IVA = as('authenticated', ADMIN, `SELECT coalesce(sum(credit_amount), 0)::text FROM report_fiscal_period WHERE period = '2026-10-01' AND tax_kind = 'IVA'`);

add(`CREATE TEMP TABLE c0 AS ${counts()};
CREATE TEMP TABLE b0 AS SELECT ${BAL('BNA')} AS bna, ${BAL('Mercado Pago')} AS mp, ${BAL('Caja chica')} AS caja, ${SUPLEDGER} AS led;
CREATE TEMP TABLE i0 AS SELECT ${IVA} AS iva;`);

// A. supplier purchases unchanged
expect('A-1 register_purchase with a supplier (unchanged contract)', as('authenticated', ADMIN, `SELECT register_purchase('${SUP}'::uuid, '${D}'::date, 500, 500, '${CAT}'::uuid, 'ADR019 proveedor', 'OPERATING', '[]'::jsonb, '[]'::jsonb, 'ADR019-SUP-1')::text`), 'OK:%');
expect('A-1b supplier ledger +1, no payment link, supplier set', `((${SUPLEDGER} - (SELECT led FROM b0))::text || ':' || ${PUR('ADR019-SUP-1', "(paid_operation_id IS NULL AND supplier_id IS NOT NULL)::text")})`, '1:true');
expect('A-2 register_purchase without a supplier is still refused (no unpaid casual purchase through RPC 13)',
  as('authenticated', ADMIN, `SELECT register_purchase(NULL, '${D}'::date, 500, 500, '${CAT}'::uuid, NULL, 'OPERATING', '[]'::jsonb, '[]'::jsonb, 'ADR019-SUP-NULL')::text`), 'ERR:SUPPLIER_NOT_FOUND_OR_INACTIVE%');

// B. casual purchase without counterparty, paid from BNA
add(`CREATE TEMP TABLE c1 AS ${counts()};`);
expect('B-1 casual purchase (no supplier, no name) from BNA', CASUAL({ concept: 'ADR019 repuestos', key: 'ADR019-K1' }), 'OK:%"replayed": false%');
expect('B-2 purchase: supplier NULL, name NULL, concept as subcategory, paid_operation set, current',
  PUR('ADR019-K1', "(supplier_id IS NULL)::text || ':' || coalesce(counterparty_name, '-') || ':' || subcategory || ':' || (paid_operation_id IS NOT NULL) || ':' || is_current"), 'true:-:ADR019 repuestos:true:true');
expect('B-3 payment: ONE PURCHASE_PAYMENT operation, ONE posting BNA −1000, source = the purchase',
  `(SELECT o.operation_type || ':' || o.external_ref || ':' || o.source_entity_type || ':' || (o.source_entity_id = p.id::text) || ':' || (SELECT string_agg(a.nombre || ' ' || fp.signed_amount, ',') FROM financial_posting fp JOIN financial_account a ON a.id = fp.financial_account_id WHERE fp.financial_operation_id = o.id)
     FROM purchases p JOIN financial_operation o ON o.id = p.paid_operation_id WHERE p.idempotency_key = 'ADR019-K1')`, 'PURCHASE_PAYMENT:PURCHASE-PAY:ADR019-K1:purchases:true:BNA -1000.00');
expect('B-4 supplier ledger untouched by the casual purchase', `(${SUPLEDGER} - (SELECT led FROM b0))::text`, '1');
expect('B-5 P&L: the casual purchase is a COSTOS_INDIRECTOS line of −1000 (from purchases)', PNLBUCKET('COSTOS_INDIRECTOS'), 'OK:-1500.00');
add(`CREATE TEMP TABLE c2 AS ${counts()};`);
expect('B-6 replay (same key) → replayed, nothing written', `(${CASUAL({ concept: 'ADR019 repuestos', key: 'ADR019-K1' })} LIKE 'OK:%"replayed": true%' AND coalesce(${delta('c2')}, 'none') = 'none')::text`, 'true');

// C. counterparty name
expect('C-1 with a counterparty name (trimmed)', CASUAL({ concept: 'ADR019 pintura', key: 'ADR019-K2', name: '  Pinturería Sur  ', acc: 'Caja chica', method: 'CASH' }), 'OK:%');
expect('C-2 stored trimmed', PUR('ADR019-K2', 'counterparty_name'), 'Pinturería Sur');
expect('C-3 a blank name is no name', CASUAL({ concept: 'ADR019 varios', key: 'ADR019-K3', name: '   ' }), 'OK:%');
expect('C-3b stored as NULL', PUR('ADR019-K3', '(counterparty_name IS NULL)::text'), 'true');
expect('C-4 the table refuses an untrimmed / blank name and a name on a supplier purchase',
  `(pg_temp.err_of('UPDATE purchases SET counterparty_name = '' x '' WHERE idempotency_key = ''ADR019-K2''') || '|' || pg_temp.err_of('UPDATE purchases SET counterparty_name = ''Z'' WHERE idempotency_key = ''ADR019-SUP-1'''))`,
  'ERR:%chk_purchases_counterparty%|ERR:%chk_purchases_counterparty%');

// D. fiscal invoice of a casual purchase (issuer CUIT + name)
expect('D-1 casual purchase with a received invoice A (issuer CUIT / name, IVA 21%)', CASUAL({ concept: 'ADR019 con factura', key: 'ADR019-K4', fiscal: FISCAL(1) }), 'OK:%"fiscal_document_id": "%');
expect('D-2 fiscal document: CREDITO, no supplier, issuer CUIT / name, linked to the purchase',
  `(SELECT d.direction || ':' || (d.supplier_id IS NULL) || ':' || d.issuer_tax_id || ':' || d.issuer_name || ':' || d.external_number FROM fiscal_document d WHERE d.id = ${PUR('ADR019-K4', 'fiscal_document_id')})`,
  'CREDITO:true:30712345678:Ferretería del Centro:0001-00001');
expect('D-3 IVA crédito of the period +210 through the unchanged report_fiscal_period', `((${IVA}) || ' vs ' || (SELECT iva FROM i0))`, 'OK:210.00 vs OK:0');
add(`CREATE TEMP TABLE c3 AS ${counts()};`);
expect('D-4 same issuer CUIT + number again → DUPLICATE_FISCAL_DOCUMENT; nothing written (whole call rolled back)',
  `(${CASUAL({ concept: 'ADR019 dup', key: 'ADR019-K5', fiscal: FISCAL(1) })} LIKE 'ERR:DUPLICATE_FISCAL_DOCUMENT%' AND coalesce(${delta('c3')}, 'none') = 'none')::text`, 'true');
expect('D-5 the same number from another issuer CUIT is a different document', CASUAL({ concept: 'ADR019 otro emisor', key: 'ADR019-K6', fiscal: FISCAL(1, { issuer_tax_id: '20123456786', issuer_name: null }) }), 'OK:%');
expect('D-6 invalid CUIT / missing CUIT refused',
  `(${CASUAL({ key: 'ADR019-K7', fiscal: FISCAL(7, { issuer_tax_id: '30-71234567-8' }) })} || '|' || ${CASUAL({ key: 'ADR019-K8', fiscal: FISCAL(8, { issuer_tax_id: '' }) })})`,
  'ERR:INVALID_ISSUER%|ERR:INVALID_FISCAL_DOCUMENT%');
expect('D-7 RPC 34 unchanged: CREDITO without supplier → SUPPLIER_REQUIRED; with a supplier → OK',
  `(${as('authenticated', ADMIN, `SELECT register_fiscal_document('INVOICE_A', 'CREDITO', '${D}'::date, '2026-10-01'::date, 100, 121, '[]'::jsonb)::text`)} || '|' || ${as('authenticated', ADMIN, `SELECT register_fiscal_document('INVOICE_A', 'CREDITO', '${D}'::date, '2026-10-01'::date, 100, 121, '[]'::jsonb, '${SUP}'::uuid, NULL, 'ADR019-RPC34')::text`)})`,
  'ERR:SUPPLIER_REQUIRED%|OK:%');

// E. one payment per casual purchase
expect('E-1 a second current purchase on the same payment operation is impossible (unique)',
  `pg_temp.err_of('INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total, expense_category_id, nature, paid_operation_id, is_current, version_seq, idempotency_key)
     SELECT NULL, economic_date, 1, 1, expense_category_id, nature, paid_operation_id, true, 0, ''ADR019-DUP-OP'' FROM purchases WHERE idempotency_key = ''ADR019-K1''')`, 'ERR:%uq_purchases_paid_operation_current%');
expect('E-2 a casual purchase without a payment is impossible (casual ⇔ paid)',
  `pg_temp.err_of('INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total, expense_category_id, nature, is_current, version_seq, idempotency_key)
     VALUES (NULL, ''${D}'', 1, 1, ''${CAT}'', ''OPERATING'', true, 0, ''ADR019-NOPAY'')')`, 'ERR:%chk_purchases_casual_paid%');
expect('E-3 CHEQUE refused; inactive / unknown account refused; OPERATOR forbidden; anon no EXECUTE',
  `(${CASUAL({ key: 'ADR019-K9', method: 'CHEQUE' })} || '|' || ${as('authenticated', ADMIN, `SELECT register_casual_purchase('${D}'::date, 1, 1, '${CAT}'::uuid, 'x', 'OPERATING', gen_random_uuid(), 'CASH', 'ADR019-K10')::text`)}
    || '|' || ${CASUAL({ key: 'ADR019-K11', uid: OPER })} || '|' || ${CASUAL({ key: 'ADR019-K12', role: 'anon', uid: null })})`,
  'ERR:INVALID_PAYMENT_METHOD%|ERR:ACCOUNT_NOT_FOUND_OR_INACTIVE%|ERR:FORBIDDEN%|ERR:permission denied%');
expect('E-4 category / concept / nature required',
  `(${as('authenticated', ADMIN, `SELECT register_casual_purchase('${D}'::date, 1, 1, NULL, 'x', 'OPERATING', ${P(ACC('BNA'))}::uuid, 'CASH', 'ADR019-K13')::text`)} || '|' || ${CASUAL({ key: 'ADR019-K14', concept: '  ' })}
    || '|' || ${as('authenticated', ADMIN, `SELECT register_casual_purchase('${D}'::date, 1, 1, '${CAT}'::uuid, 'x', NULL, ${P(ACC('BNA'))}::uuid, 'CASH', 'ADR019-K15')::text`)})`,
  'ERR:CATEGORY_REQUIRED%|ERR:CONCEPT_REQUIRED%|ERR:NATURE_REQUIRED%');

// F. rectification
const RECT = (key, total, lines = '[]') => as('authenticated', ADMIN, `SELECT rectify_purchase(${P(PUR(key, 'id'))}::uuid, ${total}, ${total}, '${lines}'::jsonb, 'ADR019 test')::text`);
const RECL = (key, cat, nature, concept, name = null) => as('authenticated', ADMIN,
  `SELECT rectify_casual_purchase_classification(${P(`(SELECT id FROM purchases WHERE paid_operation_id = (SELECT paid_operation_id FROM purchases WHERE idempotency_key = '${key}') AND is_current)`)}::uuid, '${cat}'::uuid, '${nature}'::purchase_nature, ${lit(concept)}, ${lit(name)}, 'ADR019 reclass')::text`);
add(`CREATE TEMP TABLE c4 AS ${counts()};
CREATE TEMP TABLE b4 AS SELECT ${BAL('BNA')} AS bna, ${SUPLEDGER} AS led;`);
expect('F-1 amount change of a paid casual purchase → CASUAL_PURCHASE_AMOUNT_LOCKED', RECT('ADR019-K1', 900), 'ERR:CASUAL_PURCHASE_AMOUNT_LOCKED%');
expect('F-2 same amount, empty line set → new version', RECT('ADR019-K1', 1000), 'OK:%');
expect('F-2b payment carried, one current version, no ledger',
  `(true AND (SELECT count(*) FROM purchases WHERE paid_operation_id = (SELECT paid_operation_id FROM purchases WHERE idempotency_key = 'ADR019-K1')) = 2
     AND (SELECT count(*) FROM purchases WHERE paid_operation_id = (SELECT paid_operation_id FROM purchases WHERE idempotency_key = 'ADR019-K1') AND is_current) = 1
     AND ${SUPLEDGER} = (SELECT led FROM b4))::text`, 'true');
expect('F-3 reclassification: category INDIRECT → DIRECT, nature, concept, name — new version, same amount, no money',
  RECL('ADR019-K1', CATD, 'REINVESTMENT', 'ADR019 repuestos bomba', 'Casa del Repuesto'), 'OK:%"version_seq": 2%');
expect('F-4 current version carries the new classification and the same payment',
  `(SELECT (expense_category_id = '${CATD}') || ':' || nature || ':' || subcategory || ':' || counterparty_name || ':' || amount_total FROM purchases
     WHERE paid_operation_id = (SELECT paid_operation_id FROM purchases WHERE idempotency_key = 'ADR019-K1') AND is_current)`, 'true:REINVESTMENT:ADR019 repuestos bomba:Casa del Repuesto:1000.00');
expect('F-5 Δ after rectifications: purchases +2 versions only; BNA and supplier ledger unchanged',
  `(coalesce(${delta('c4')}, 'none') || '|' || ((SELECT ${BAL('BNA')} - bna FROM b4))::text || '|' || (${SUPLEDGER} - (SELECT led FROM b4))::text)`, 'purchases=2|0.00|0');
expect('F-6 reclassify: same classification → NO_CHANGE; a supplier purchase → NOT_A_CASUAL_PURCHASE',
  `(${RECL('ADR019-K1', CATD, 'REINVESTMENT', 'ADR019 repuestos bomba', 'Casa del Repuesto')} || '|' || ${as('authenticated', ADMIN, `SELECT rectify_casual_purchase_classification(${P(PUR('ADR019-SUP-1', 'id'))}::uuid, '${CAT}'::uuid, 'OPERATING', 'x', NULL, 'r')::text`)})`,
  'ERR:NO_CHANGE%|ERR:NOT_A_CASUAL_PURCHASE%');
expect('F-7 a supplier purchase is still rectified (unchanged)', RECT('ADR019-SUP-1', 600, '[{"descripcion":"x","cantidad":1,"unit_type":"UNIT","precio_unitario":600}]'), 'OK:%');
expect('F-7b with its two ledger compensations', `(${SUPLEDGER} - (SELECT led FROM b4))::text`, '2');

// G. Mercado Pago gateway: one SOURCE_ID → one economic classification
const PAYOUTS = ['890000000001', '890000000002', '890000000003'];
const [G1, G2, G3] = PAYOUTS;
const PDAY = [CTL, ...PAYOUTS.map((sid, i) => mv(`1${i}:00:00`, sid, 'payout', '0.00', ['759.86', '200.00', '300.00'][i], `-${['759.86', '200.00', '300.00'][i]}`, '0.00', '0.00', 'available_money', '')), TOT];
const rowOf = (sid) => PDAY.findIndex((r) => r.SOURCE_ID === sid) + 1;
const CBU = (bank) => `(SELECT c.expected_cbu::text FROM fin_statement_account_config c JOIN financial_account a ON a.id = c.financial_account_id WHERE a.nombre = '${bank}' AND c.activo)`;
const EXTERNAL = `'2850590940090418135201'`;
expect('G-0 payout day ingested; destinations G1 / G2 third party, G3 BNA',
  `(${NORMAL({ sha: sha('casual-payout-day'), actor: null, rows: rowsOf(PDAY) }, 'R')} LIKE 'OK:%PARSED%' AND ${as('service_role', null,
    `SELECT fin_record_mp_payout_destinations(${P(RES('R'))}::uuid, jsonb_build_array(jsonb_build_object('row_number', ${rowOf(G1)}, 'value', ${EXTERNAL}), jsonb_build_object('row_number', ${rowOf(G2)}, 'value', ${EXTERNAL}), jsonb_build_object('row_number', ${rowOf(G3)}, 'value', ${CBU('BNA')})))::text`)} = 'OK:3')::text`, 'true');
const MPC = (sid, o = {}) => CASUAL({ acc: 'Mercado Pago', method: 'MERCADOPAGO', net: '759.86', total: '759.86', concept: 'ADR019 compra MP', sid, key: `ADR019-MP-${sid}`, ...o });
add(`CREATE TEMP TABLE b5 AS SELECT ${BAL('Mercado Pago')} AS mp, ${SUPLEDGER} AS led;`);
expect('G-1 paying from Mercado Pago without a SOURCE_ID → MP_SOURCE_REQUIRED; a SOURCE_ID with BNA → MP_SOURCE_NOT_ALLOWED',
  `(${MPC(null)} || '|' || ${CASUAL({ key: 'ADR019-K16', sid: G1 })})`, 'ERR:MP_SOURCE_REQUIRED%|ERR:MP_SOURCE_NOT_ALLOWED%');
expect('G-2 wrong amount / date → refused (the payout decides)',
  `(${MPC(G1, { net: '700', total: '700' })} || '|' || ${MPC(G1, { date: '2026-10-14' })})`, 'ERR:MP_AMOUNT_MISMATCH%|ERR:MP_DATE_MISMATCH%');
expect('G-3 G1 → casual purchase from MP (SOURCE_ID anchored)', MPC(G1), 'OK:%"replayed": false%');
expect('G-4 the payout movement: provisional and release (ADR-021), then reconciled once to the PURCHASE_PAYMENT; classification CASUAL_PURCHASE',
  `(SELECT oc.classification || ':' || o.operation_type || ':' || o.external_ref || ':' || (SELECT string_agg(r.assigned_amount::text, ',' ORDER BY r.financial_operation_id) FROM mp_reconciliation r WHERE r.mp_financial_movement_id = oc.mp_financial_movement_id)
     FROM mp_outflow_classification oc JOIN financial_operation o ON o.id = oc.financial_operation_id WHERE oc.source_id = '${G1}')`, `CASUAL_PURCHASE:PURCHASE_PAYMENT:MP-OUTFLOW:${G1}:-759.86,759.86,-759.86`);
add(`CREATE TEMP TABLE c6 AS ${counts()};`);
expect('G-5 exact replay from another entry point (other key, same data) → replayed, nothing written',
  `(${MPC(G1, { key: 'ADR019-COMPRAS-G1' })} LIKE 'OK:%"replayed": true%' AND coalesce(${delta('c6')}, 'none') = 'none')::text`, 'true');
expect('G-6 a conflicting second classification of the same SOURCE_ID → ALREADY_CLASSIFIED', MPC(G1, { key: 'ADR019-COMPRAS-G1b', concept: 'otra cosa' }), 'ERR:ALREADY_CLASSIFIED%');
expect('G-7 an own-account payout cannot become a purchase', MPC(G3, { net: '300.00', total: '300.00' }), 'ERR:OWN_ACCOUNT_PAYOUT%');
expect('G-8 MP unchanged by the classification (down once at the ingest, ADR-021); supplier ledger untouched',
  `(((SELECT ${BAL('Mercado Pago')} - mp FROM b5))::text || '|' || (${SUPLEDGER} - (SELECT led FROM b5))::text)`, '0.00|0');

// Z. perimeter
expect('Z-1 RPCs: DEFINER, owner postgres, search_path=public, EXECUTE authenticated only; helpers INVOKER, no API EXECUTE',
  `(SELECT string_agg(proname || '=' || prosecdef || ':' || has_function_privilege('anon', oid, 'EXECUTE') || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
     FROM pg_proc WHERE proname IN ('register_casual_purchase', 'rectify_casual_purchase_classification', 'fiscal_document_insert', 'mp_payout_outflow_resolve'))`,
  'fiscal_document_insert=false:falsefalsefalse,mp_payout_outflow_resolve=false:falsefalsefalse,rectify_casual_purchase_classification=true:falsetruefalse,register_casual_purchase=true:falsetruefalse');
expect('Z-2 mp_outflow_classification: RLS, ADMIN SELECT only, immutable', `((SELECT relrowsecurity FROM pg_class WHERE relname = 'mp_outflow_classification')
   AND (SELECT string_agg(policyname || ':' || cmd, ',') FROM pg_policies WHERE tablename = 'mp_outflow_classification') = 'mp_outflow_classification_admin_select:SELECT'
   AND NOT has_table_privilege('authenticated', 'mp_outflow_classification', 'INSERT,UPDATE,DELETE')
   AND pg_temp.err_of('UPDATE mp_outflow_classification SET amount = 1') LIKE 'ERR:%')::text`, 'true');
expect('Z-3 SECURITY DEFINER set = 91 (81 + register_casual_purchase + rectify_casual_purchase_classification)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '91');

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
console.log(`\n  ══ ADR-019 0088 CASUAL PURCHASE RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
