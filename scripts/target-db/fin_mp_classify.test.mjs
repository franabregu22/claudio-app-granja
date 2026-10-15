#!/usr/bin/env node
/**
 * META A — CLASSIFY MP OUTFLOWS AND INFLOWS (migration 0089, on top of ADR-019 / 0088). LOCAL TEST DATABASE ONLY.
 *
 * OUTFLOWS (real pipeline: NORMAL ingestion → payout movements → destinations → 0084 match): a NO_OWN_ACCOUNT_MATCH payout
 * classified as SUPPLIER_PAYMENT (pay_supplier), EXPENSE (register_purchase + pay_supplier), CASUAL_PURCHASE (ADR-019:
 * register_casual_purchase, no supplier, the 13/10 case) or OWNER_WITHDRAWAL
 * (register_management_event RETIRO), resolved server-side from the SOURCE_ID; own / conflict / unknown destination and an
 * unknown id refused; replay writes nothing; another choice refused; MP down once; P&L per type.
 * INFLOWS (real pipeline: delivery → snapshot → RPC 40): account_fund + debin_transfer is not auto-applied; classified as a
 * collection (the A1 plan + optional client allocation) or as an own transfer (0086); account_fund + cvu unchanged.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"  *     node scripts/target-db/fin_mp_classify.test.mjs
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
const ADMIN = 'aaaaaaaa-0088-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0088-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`META-A-0088-${seed}`).digest('hex');
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
CREATE FUNCTION pg_temp.err_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN others THEN RETURN 'ERR:' || SQLERRM; END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'meta-a-0088-admin@test.local', 'ADMIN'),
  ('${OPER}',  'meta-a-0088-oper@test.local',  'OPERATOR');`);

// ── fixtures: one supplier, one expense category, one client ───────────────
const SUP = 'cccccccc-0088-0000-0000-0000000000a1';
const CAT = 'cccccccc-0088-0000-0000-0000000000c1';
const CLI = 'cccccccc-0088-0000-0000-0000000000d1';
add(`INSERT INTO suppliers (id, nombre) VALUES ('${SUP}', 'Proveedor META A 0088');
INSERT INTO expense_category (id, nombre, pnl_cost_class) VALUES ('${CAT}', 'Categoría META A 0088', 'INDIRECT');
INSERT INTO clients (id, nombre) VALUES ('${CLI}', 'Cliente META A 0088');`);

// ── OUTFLOWS: one payout day ────────────────────────────────────────────────
// Q1 third party → supplier payment · Q2 third party → expense · Q3 third party → owner withdrawal
// Q4 → BNA (own) · Q5 conflicting destinations · Q6 no destination
// Q7 mirrors the real 13/10 payout (third party, 759,702.86) → casual purchase
const PAYOUTS = ['880000000001', '880000000002', '880000000003', '880000000004', '880000000005', '880000000006', '880000000007'];
const [Q1, Q2, Q3, Q4, Q5, Q6, Q7] = PAYOUTS;
const AMT = ['759.86', '300.00', '500.00', '1000.00', '100.00', '100.00', '759702.86'];
const PDAY = [CTL, ...PAYOUTS.map((sid, i) => mv(`1${i}:00:00`, sid, 'payout', '0.00', AMT[i], `-${AMT[i]}`, '0.00', '0.00', 'available_money', '')), TOT];
const rowOf = (sid) => PDAY.findIndex((r) => r.SOURCE_ID === sid) + 1;
const CBU = (bank) => `(SELECT c.expected_cbu::text FROM fin_statement_account_config c JOIN financial_account a ON a.id = c.financial_account_id WHERE a.nombre = '${bank}' AND c.activo)`;
const EXTERNAL = `'2850590940090418135201'`;
const OTHER = `'2850590940090418135299'`;
const record = (key, items) => as('service_role', null,
  `SELECT fin_record_mp_payout_destinations(${P(RES(key))}::uuid, jsonb_build_array(${items.map(([sid, v]) => `jsonb_build_object('row_number', ${rowOf(sid)}, 'value', ${v})`).join(', ')}))::text`);
const OUT = (sid, cls, sup = null, cat = null, nature = null, role = 'authenticated', uid = ADMIN, concept = cat ? 'Repuestos bomba de agua' : null, name = null) =>
  as(role, uid, `SELECT mp_classify_payout_outflow(${lit(sid)}, ${lit(cls)}, ${sup ? `'${sup}'::uuid` : 'NULL'}, ${cat ? `'${cat}'::uuid` : 'NULL'}, ${nature ? `'${nature}'::purchase_nature` : 'NULL'}, ${lit(concept)}, ${lit(name)}, NULL)::text`);
const PMOV = (sid) => `(SELECT m.id FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
  WHERE t.resource_type = 'report' AND t.resource_id = '${sid}:payout:D' AND t.transition = 'PAYOUT')`;
const OPOF = (sid) => `(SELECT financial_operation_id FROM mp_outflow_classification WHERE source_id = '${sid}')`;
const OPDESC = (sid) => `(SELECT o.operation_type || ':' || coalesce(o.external_ref, '-') || ':' || o.effective_date || ':' || (SELECT string_agg(a.nombre || ' ' || p.signed_amount, ' / ' ORDER BY p.signed_amount)
   FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id WHERE p.financial_operation_id = o.id) FROM financial_operation o WHERE o.id = ${OPOF(sid)})`;
const SUPBAL = `(SELECT coalesce(sum(signed_amount), 0) FROM supplier_ledger WHERE supplier_id = '${SUP}')`;
const PNLAS = (bucket) => as('authenticated', ADMIN, `SELECT coalesce(sum(signed_amount), 0)::text FROM pnl_line_item WHERE bucket = '${bucket}' AND business_date = '${DAY}'`);

expect('A-1 NORMAL run of the payout day → PARSED', NORMAL({ sha: sha('payout-day'), actor: null, rows: rowsOf(PDAY) }, 'R'), 'OK:%"status": "PARSED"%');
expect('A-2 VALIDATION capture of the same day (other bytes)', as('service_role', null, captureCall({ sha: sha('payout-day-validation'), rows: rowsOf(PDAY) }), 'V'), 'OK:%"status": "VALIDATED"%');
expect('A-3 destinations: Q1–Q3 third party, Q4 BNA, Q5 third party, Q7 third party', record('R', [[Q1, EXTERNAL], [Q2, EXTERNAL], [Q3, EXTERNAL], [Q4, CBU('BNA')], [Q5, EXTERNAL], [Q7, EXTERNAL]]), 'OK:6');
expect('A-4 Q5 reported elsewhere by the VALIDATION run (conflict)', record('V', [[Q5, OTHER]]), 'OK:1');
add(`CREATE TEMP TABLE c0 AS ${counts()};
CREATE TEMP TABLE b0 AS SELECT ${BAL('Mercado Pago')} AS mp, ${BAL('BNA')} AS bna, ${SUPBAL} AS sup;`);
add(`CREATE TEMP TABLE p0 AS SELECT ${PNLAS('COSTOS_INDIRECTOS')} AS ind, ${PNLAS('RETIROS')} AS ret, ${as('authenticated', ADMIN, PNL)} AS h;`);

// B. supplier payment
expect('B-1 Q1 → SUPPLIER_PAYMENT: amount from the server', OUT(Q1, 'SUPPLIER_PAYMENT', SUP), 'OK:%"amount": 759.86%"replayed": false%');
expect('B-2 operation SUPPLIER_PAYMENT MP-OUTFLOW:<id>, payout date, MP −759.86 only',
  OPDESC(Q1), `SUPPLIER_PAYMENT:MP-OUTFLOW:${Q1}:${DAY}:Mercado Pago -759.86`);
expect('B-3 supplier ledger PAYMENT −759.86 (anticipo / reduces the debt — the current global supplier account)',
  `(SELECT string_agg(movement_type || ' ' || signed_amount, ',') FROM supplier_ledger WHERE supplier_id = '${SUP}' AND source_entity_id = ${OPOF(Q1)}::text)`, 'PAYMENT -759.86');
expect('B-4 the payout movement is reconciled once to that operation (−759.86)',
  `(SELECT string_agg((financial_operation_id = ${OPOF(Q1)})::text || ':' || assigned_amount, ',') FROM mp_reconciliation WHERE mp_financial_movement_id = ${PMOV(Q1)})`, 'true:-759.86');
add(`CREATE TEMP TABLE c1 AS ${counts()};`);
expect('B-5 replay (same choice) → replayed, nothing written', OUT(Q1, 'SUPPLIER_PAYMENT', SUP), 'OK:%"replayed": true%');
expect('B-6 Δ after the replay = none', `coalesce(${delta('c1')}, 'none')`, 'none');
expect('B-7 another choice on a classified payout → ALREADY_CLASSIFIED', OUT(Q1, 'OWNER_WITHDRAWAL'), 'ERR:ALREADY_CLASSIFIED%');
expect('B-8 the expense replays only with the same category and concept', `(${OUT(Q1, 'EXPENSE', SUP, CAT)})`, 'ERR:ALREADY_CLASSIFIED%');

// C. expense (purchase + payment)
expect('C-1 Q2 → EXPENSE (supplier + category, nature OPERATING default)', OUT(Q2, 'EXPENSE', SUP, CAT), 'OK:%"amount": 300.00%"purchase_id": "%');
expect('C-2 purchase: supplier, payout date, total 300, category, OPERATING, subcategory = the concept, no attachment, idempotency MP-OUTFLOW-PURCHASE:<id>',
  `(SELECT pu.economic_date || ':' || pu.amount_total || ':' || (pu.expense_category_id = '${CAT}') || ':' || pu.subcategory || ':' || pu.nature || ':' || pu.idempotency_key || ':' || (SELECT count(*) FROM purchase_attachment a WHERE a.purchase_id = pu.id)
     FROM purchases pu WHERE pu.id = (SELECT purchase_id FROM mp_outflow_classification WHERE source_id = '${Q2}'))`, `${DAY}:300.00:true:Repuestos bomba de agua:OPERATING:MP-OUTFLOW-PURCHASE:${Q2}:0`);
expect('C-3 payment: SUPPLIER_PAYMENT MP −300', OPDESC(Q2), `SUPPLIER_PAYMENT:MP-OUTFLOW:${Q2}:${DAY}:Mercado Pago -300.00`);
expect('C-4 supplier ledger for the expense: PURCHASE +300 and PAYMENT −300 (net 0)',
  `(SELECT string_agg(movement_type || ' ' || signed_amount, ',' ORDER BY id) FROM supplier_ledger WHERE supplier_id = '${SUP}' AND id > (SELECT min(id) FROM supplier_ledger WHERE supplier_id = '${SUP}'))`, 'PURCHASE 300.00,PAYMENT -300.00');

// D. owner withdrawal
expect('D-1 Q3 → OWNER_WITHDRAWAL (no supplier)', OUT(Q3, 'OWNER_WITHDRAWAL'), 'OK:%"amount": 500.00%');
expect('D-2 operation OWNER_WITHDRAWAL MGMT:MP-OUTFLOW:<id>, MP −500; management_event RETIRO on MP',
  `(${OPDESC(Q3)} || '|' || (SELECT me.event_type || ':' || me.amount || ':' || (me.financial_account_id = ${MPACC}) FROM management_event me WHERE me.id = (SELECT management_event_id FROM mp_outflow_classification WHERE source_id = '${Q3}')))`,
  `OWNER_WITHDRAWAL:MGMT:MP-OUTFLOW:${Q3}:${DAY}:Mercado Pago -500.00|RETIRO:500.00:true`);

// K. casual purchase without a registered supplier (ADR-019) — the 13/10 case
const CAS = (o = {}) => OUT(Q7, 'CASUAL_PURCHASE', null, CAT, null, 'authenticated', ADMIN, o.concept ?? 'Repuestos bomba de agua', o.name === undefined ? '  Ferretería X  ' : o.name);
expect('K-1 Q7 → Compra / gasto, Sin proveedor registrado (category, concept, nature default OPERATING, counterparty): amount from the server',
  CAS(), 'OK:%"amount": 759702.86%"replayed": false%"classification": "CASUAL_PURCHASE"%');
expect('K-2 purchase: no supplier, counterparty trimmed, concept as subcategory, OPERATING, total 759,702.86, payout date, current',
  `(SELECT (p.supplier_id IS NULL) || ':' || p.counterparty_name || ':' || p.subcategory || ':' || p.nature || ':' || p.amount_total || ':' || p.economic_date || ':' || p.is_current
     FROM purchases p WHERE p.id = (SELECT purchase_id FROM mp_outflow_classification WHERE source_id = '${Q7}'))`, `true:Ferretería X:Repuestos bomba de agua:OPERATING:759702.86:${DAY}:true`);
expect('K-3 payment: PURCHASE_PAYMENT MP-OUTFLOW:<id>, MP −759,702.86 only; the movement reconciled once',
  `(${OPDESC(Q7)} || '|' || (SELECT string_agg(assigned_amount::text, ',') FROM mp_reconciliation WHERE mp_financial_movement_id = ${PMOV(Q7)}))`,
  `PURCHASE_PAYMENT:MP-OUTFLOW:${Q7}:${DAY}:Mercado Pago -759702.86|-759702.86`);
expect('K-4 no supplier ledger row and no supplier created for the casual purchase',
  `((SELECT count(*) FROM supplier_ledger WHERE source_entity_id IN ((SELECT purchase_id::text FROM mp_outflow_classification WHERE source_id = '${Q7}'), ${OPOF(Q7)}::text))
     || ':' || (SELECT count(*) FROM suppliers WHERE id <> '${SUP}' AND nombre ILIKE '%Ferretería%'))`, '0:0');
add(`CREATE TEMP TABLE c7 AS ${counts()};`);
expect('K-5 exact replay from the MP activity → replayed, nothing written', `(${CAS()} LIKE 'OK:%"replayed": true%' AND coalesce(${delta('c7')}, 'none') = 'none')::text`, 'true');
expect('K-6 exact replay from Compras (register_casual_purchase, another key, same data) → replayed, nothing written',
  `(${as('authenticated', ADMIN, `SELECT register_casual_purchase('${DAY}'::date, 759702.86, 759702.86, '${CAT}'::uuid, 'Repuestos bomba de agua', 'OPERATING',
     ${P(MPACC)}::uuid, 'MERCADOPAGO', 'COMPRAS-K6', 'Ferretería X', '[]'::jsonb, '[]'::jsonb, NULL, NULL, NULL, '${Q7}', NULL)::text`)} LIKE 'OK:%"replayed": true%'
     AND coalesce(${delta('c7')}, 'none') = 'none')::text`, 'true');
expect('K-7 a conflicting second classification of the same SOURCE_ID is refused (activity: other concept / withdrawal; Compras: other concept)',
  `(${CAS({ concept: 'Otra cosa' })} || '|' || ${OUT(Q7, 'OWNER_WITHDRAWAL')} || '|' || ${as('authenticated', ADMIN, `SELECT register_casual_purchase('${DAY}'::date, 759702.86, 759702.86, '${CAT}'::uuid, 'Otra cosa', 'OPERATING',
     ${P(MPACC)}::uuid, 'MERCADOPAGO', 'COMPRAS-K7', NULL, '[]'::jsonb, '[]'::jsonb, NULL, NULL, NULL, '${Q7}', NULL)::text`)})`,
  'ERR:ALREADY_CLASSIFIED%|ERR:ALREADY_CLASSIFIED%|ERR:ALREADY_CLASSIFIED%');

// E. refusals
expect('E-1 Q4 (own account, OWN_ACCOUNT_EXACT) → use the transfer flow', OUT(Q4, 'SUPPLIER_PAYMENT', SUP), 'ERR:OWN_ACCOUNT_PAYOUT%');
expect('E-2 Q5 DESTINATION_CONFLICT → refused', OUT(Q5, 'OWNER_WITHDRAWAL'), 'ERR:DESTINATION_REVIEW_REQUIRED%DESTINATION_CONFLICT%');
expect('E-3 Q6 no stored destination → refused', OUT(Q6, 'OWNER_WITHDRAWAL'), 'ERR:DESTINATION_UNKNOWN%');
expect('E-4 unknown SOURCE_ID → refused', OUT('889999999999', 'OWNER_WITHDRAWAL'), 'ERR:PAYOUT_NOT_FOUND%');
expect('E-5 malformed SOURCE_ID / unknown classification / "OTHER" not offered',
  `(${OUT('1 OR 1=1', 'OWNER_WITHDRAWAL')} || '|' || ${OUT(Q5, 'OTHER')} || '|' || ${OUT(Q5, 'TRANSFER')})`, 'ERR:INVALID_SOURCE_ID%|ERR:INVALID_CLASSIFICATION%|ERR:INVALID_CLASSIFICATION%');
expect('E-6 refused: payment without supplier / purchase without category / withdrawal with a supplier / purchase without concept / EXPENSE without supplier (casual is CASUAL_PURCHASE) / concept on a debt payment',
  `(${OUT(Q6, 'SUPPLIER_PAYMENT')} || '|' || ${OUT(Q6, 'EXPENSE', SUP)} || '|' || ${OUT(Q6, 'OWNER_WITHDRAWAL', SUP)} || '|' || ${OUT(Q6, 'EXPENSE', SUP, CAT, null, 'authenticated', ADMIN, '  ')}
    || '|' || ${OUT(Q6, 'EXPENSE', null, CAT)} || '|' || ${OUT(Q6, 'SUPPLIER_PAYMENT', SUP, null, null, 'authenticated', ADMIN, 'x')})`,
  'ERR:%SUPPLIER_REQUIRED%|ERR:%CATEGORY_REQUIRED%|ERR:%SUPPLIER_NOT_ALLOWED%|ERR:%CONCEPT_REQUIRED%|ERR:%SUPPLIER_REQUIRED%|ERR:%CATEGORY_NOT_ALLOWED%');
expect('E-6b casual purchase with a supplier / without category; a counterparty name on a supplier purchase → refused',
  `(${OUT(Q6, 'CASUAL_PURCHASE', SUP, CAT)} || '|' || ${OUT(Q6, 'CASUAL_PURCHASE', null, null, null, 'authenticated', ADMIN, 'x')} || '|' || ${OUT(Q6, 'EXPENSE', SUP, CAT, null, 'authenticated', ADMIN, 'x', 'Ferretería')})`,
  'ERR:%SUPPLIER_NOT_ALLOWED%|ERR:%CATEGORY_REQUIRED%|ERR:%COUNTERPARTY_NOT_ALLOWED%');
expect('E-7 a payout confirmed as an own transfer cannot be classified (already applied)',
  `(${as('authenticated', ADMIN, `SELECT mp_confirm_payout_transfer('${Q4}')::text`)} LIKE 'OK:%' AND ${OUT(Q4, 'OWNER_WITHDRAWAL')} LIKE 'ERR:PAYOUT_ALREADY_APPLIED%')::text`, 'true');
expect('E-8 OPERATOR → FORBIDDEN; anon / service_role → no EXECUTE',
  `(${OUT(Q5, 'OWNER_WITHDRAWAL', null, null, null, 'authenticated', OPER)} || '|' || ${OUT(Q5, 'OWNER_WITHDRAWAL', null, null, null, 'anon', null)} || '|' || ${OUT(Q5, 'OWNER_WITHDRAWAL', null, null, null, 'service_role', null)})`,
  'ERR:FORBIDDEN%|ERR:permission denied%|ERR:permission denied%');
expect('E-9 no amount / account / date parameter exists (single overload)',
  `(SELECT string_agg(pg_get_function_identity_arguments(oid), ',') FROM pg_proc WHERE proname = 'mp_classify_payout_outflow')`,
  'p_source_id text, p_classification text, p_supplier_id uuid, p_expense_category_id uuid, p_nature purchase_nature, p_concept text, p_counterparty_name text, p_reason text');

// F. economy of the outflows (Q1 + Q2 + Q3 + Q4 transfer + Q7 casual)
expect('F-1 MP −(759.86 + 300 + 500 + 1000 + 759,702.86) once each; BNA +1000 (Q4 transfer); supplier net −759.86 (the casual purchase adds nothing)',
  `((SELECT ${BAL('Mercado Pago')} - mp FROM b0) || '|' || (SELECT ${BAL('BNA')} - bna FROM b0) || '|' || (SELECT ${SUPBAL} - sup FROM b0))`, '-762262.72|1000.00|-759.86');
expect('F-2 P&L: supplier payment and transfer neutral; expense −300 and casual purchase −759,702.86 COSTOS_INDIRECTOS (from purchases); withdrawal −500 RETIROS',
  `(((${PNLAS('COSTOS_INDIRECTOS')}) || '|' || (${PNLAS('RETIROS')})) || ' vs ' || (SELECT ind || '|' || ret FROM p0))`,
  'OK:-760002.86|OK:-500.00 vs OK:0|OK:0');
expect('F-3 Δ: 5 operations (2 supplier payments, 1 withdrawal, 1 transfer, 1 purchase payment), 6 postings, 5 reconciliations, 2 purchases, 1 management event; no new movement / source / evidence',
  delta('c0'), 'financial_operation=5,financial_posting=6,management_event=1,mp_reconciliation=5,purchases=2');
expect('F-4 no duplicate postings', `(SELECT count(*)::text FROM (SELECT financial_operation_id, financial_account_id, signed_amount FROM financial_posting GROUP BY 1, 2, 3 HAVING count(*) > 1) x)`, '0');
const ACT = as('authenticated', ADMIN, `SELECT string_agg(source_id || ':' || coverage_status || ':' || coalesce(classification, '-') || ':' || coalesce(classification_detail, '-') || ':' || (financial_operation_id IS NOT NULL), ',' ORDER BY source_id)
  FROM fin_mp_report_activity WHERE run_id = ${P(RES('R'))}::uuid AND description = 'payout'`);
expect('F-5 activity: Q1 debt payment, Q2 purchase (concept · category · supplier), Q3 withdrawal, Q4 own transfer, Q5/Q6 still PAYOUT, Q7 casual (concept · category · counterparty)',
  ACT, `OK:${Q1}:CLASSIFIED_OUTFLOW:SUPPLIER_PAYMENT:Proveedor META A 0088:true,${Q2}:CLASSIFIED_OUTFLOW:EXPENSE:Repuestos bomba de agua · Categoría META A 0088 · Proveedor META A 0088:true,`
  + `${Q3}:CLASSIFIED_OUTFLOW:OWNER_WITHDRAWAL:-:true,${Q4}:OWN_TRANSFER:-:-:true,${Q5}:PAYOUT:-:-:false,${Q6}:PAYOUT:-:-:false,`
  + `${Q7}:CLASSIFIED_OUTFLOW:CASUAL_PURCHASE:Repuestos bomba de agua · Categoría META A 0088 · Ferretería X:true`);
expect('F-6 classification rows immutable; ADMIN cannot write them directly',
  `(pg_temp.err_of('UPDATE mp_outflow_classification SET amount = 1') LIKE 'ERR:%' AND ${as('authenticated', ADMIN, `DELETE FROM mp_outflow_classification RETURNING 'x'`)} LIKE 'ERR:permission denied%')::text`, 'true');

// ── INFLOWS ─────────────────────────────────────────────────────────────────
const svc = (sql, key = null) => as('service_role', null, sql, key);
function payment(k, pid, opType, method, amount) {
  const at = '2026-11-05T10:00:00.000-04:00';
  const pl = { id: Number(pid), operation_type: opType, payment_method_id: method, payment_type_id: method === 'account_money' ? 'account_money' : 'bank_transfer',
    status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true, collector_id: 100000001, payer: { id: '800000998' },
    external_reference: null, date_created: at, date_approved: at, date_last_updated: at, transaction_amount: amount,
    transaction_details: { net_received_amount: amount }, fee_details: [], refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
  expect(`${k}: delivery registered`, svc(`SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', '${pid}', NULL, 'T88', ${lit(JSON.stringify({ notification_id: `t88-${pid}` }))}::jsonb, true)::text`), 'OK:%');
  expect(`${k}: claimed`, svc(`SELECT row_to_json(c)::text FROM mp_claim_deliveries(50, 120) c WHERE c.resource_id = '${pid}'`, `${k}_c`), 'OK:%');
  expect(`${k}: snapshot ingested`, svc(`SELECT mp_ingest_api_snapshot(${P(RES(`${k}_c`, 'delivery_id'))}::uuid, ${P(RES(`${k}_c`, 'claim_token'))}::uuid, '${pid}', ${lit(JSON.stringify(pl))}::jsonb)::text`, `${k}_i`), 'OK:%');
  expect(`${k}: normalized`, svc(`SELECT mp_normalize_source(${P(RES(`${k}_i`, 'source_record_id'))}::uuid)::text`), 'OK:%NORMALIZED%');
}
const MV = (pid) => `(SELECT t.mp_financial_movement_id FROM mp_transition_identity t WHERE t.resource_type = 'payment' AND t.resource_id = '${pid}' AND t.transition = 'APPROVAL')`;
const apply = (pid) => svc(`SELECT mp_apply_transition(${P(MV(pid))})::text`);
const COLL = (pid, client = null, role = 'authenticated', uid = ADMIN) => as(role, uid, `SELECT mp_classify_inflow_as_collection('${pid}', ${client ? `'${client}'::uuid` : 'NULL'})::text`);
const RECL = (pid) => as('authenticated', ADMIN, `SELECT mp_reclassify_inbound_own_transfer('${pid}', ${P(`(SELECT id FROM financial_account WHERE nombre = 'BNA')`)}::uuid, 'test')::text`);
const OPS = (pid) => `(SELECT string_agg(o.operation_type || ':' || r.assigned_amount || ':' || coalesce(o.external_ref, '-'), ' ' ORDER BY o.id) FROM mp_reconciliation r
  JOIN financial_operation o ON o.id = r.financial_operation_id WHERE r.mp_financial_movement_id = ${MV(pid)})`;
const I1 = '881000000001';   // DEBIN → client collection (with client)
const I2 = '881000000002';   // DEBIN → collection without client
const I3 = '881000000003';   // DEBIN → own transfer
const I4 = '881000000004';   // account_fund + cvu (unchanged: auto-applied)
payment('I1', I1, 'account_fund', 'debin_transfer', 50000);
payment('I2', I2, 'account_fund', 'debin_transfer', 20000);
payment('I3', I3, 'account_fund', 'debin_transfer', 30000);
payment('I4', I4, 'account_fund', 'cvu', 7500);
expect('G-1 account_fund + debin_transfer is NOT auto-applied (stays for classification)', apply(I1), 'ERR:NOT_AUTO_APPLICABLE%');
expect('G-2 account_fund + cvu is still auto-applied as a collection (unchanged)', apply(I4), 'OK:%APPLIED%');
add(`CREATE TEMP TABLE c2 AS ${counts()};
CREATE TEMP TABLE b2 AS SELECT ${BAL('Mercado Pago')} AS mp, ${BAL('BNA')} AS bna;
CREATE TEMP TABLE p2 AS SELECT ${as('authenticated', ADMIN, PNL)} AS h;`);
expect('H-1 I1 → collection with client: the A1 plan (MP_SETTLEMENT gross) + client allocation', COLL(I1, CLI), 'OK:%"replayed": false%"client_allocation_id": "%');
expect('H-2 I1 operations = MP_SETTLEMENT +50000 with the A1 key; source RECONCILED',
  `(${OPS(I1)} || '|' || (SELECT s.processing_status::text FROM mp_source_record s JOIN mp_financial_movement m ON m.mp_source_record_id = s.id WHERE m.id = ${MV(I1)}))`,
  `MP_SETTLEMENT:50000.00:MP:MPA:%:SETTLE|RECONCILED`);
expect('H-3 client ledger COLLECTION −50000 for the client', `(SELECT string_agg(movement_type || ' ' || signed_amount, ',') FROM client_ledger WHERE cliente_id = '${CLI}')`, 'COLLECTION -50000.00');
add(`CREATE TEMP TABLE c3 AS ${counts()};`);
expect('H-4 replay (same client) → replayed, nothing written', `(${COLL(I1, CLI)} LIKE 'OK:%"replayed": true%' AND coalesce(${delta('c3')}, 'none') = 'none')::text`, 'true');
expect('H-5 another choice: other client / own transfer on a collected inflow → refused',
  `(${COLL(I1)} || '|' || ${RECL(I1)})`, 'ERR:ALREADY_CLASSIFIED%|ERR:%');
expect('H-6 I2 → collection without client (no allocation)', COLL(I2), 'OK:%"client_allocation_id": null%');
expect('H-7 I3 → own transfer (0086)', RECL(I3), 'OK:%"replayed": false%');
expect('H-7b I3 operations: one TRANSFER BNA → MP (+30000 on MP), not income', OPS(I3), `TRANSFER:30000.00:MP-INBOUND-TRANSFER:${I3}`);
expect('H-8 a reclassified inflow cannot be collected; cvu / sale / unknown payment refused',
  `(${COLL(I3)} || '|' || ${COLL(I4)} || '|' || ${COLL('889999999999')} || '|' || ${COLL('x1')})`,
  'ERR:ALREADY_CLASSIFIED%|ERR:NOT_A_CLASSIFIABLE_INFLOW%|ERR:PAYMENT_NOT_FOUND%|ERR:INVALID_PAYMENT_ID%');
expect('H-9 OPERATOR → FORBIDDEN; anon → no EXECUTE', `(${COLL(I2, null, 'authenticated', OPER)} || '|' || ${COLL(I2, null, 'anon', null)})`, 'ERR:FORBIDDEN%|ERR:permission denied%');
expect('H-10 Δ inflows: MP +100000 (50k + 20k collections + 30k transfer), BNA −30000',
  `((SELECT ${BAL('Mercado Pago')} - mp FROM b2) || '|' || (SELECT ${BAL('BNA')} - bna FROM b2))`, '100000.00|-30000.00');
expect('H-11 P&L unchanged by the inflow classification (collections and transfers carry no P&L line)', `((SELECT h FROM p2) = ${as('authenticated', ADMIN, PNL)})::text`, 'true');
expect('H-12 Δ inflow counts: 3 operations, 4 postings, 3 reconciliations, 1 allocation',
  delta('c2'), 'financial_operation=3,financial_posting=4,mp_client_allocation=1,mp_reconciliation=3');
const ACT2 = as('authenticated', ADMIN, `SELECT count(*)::text FROM fin_mp_report_activity WHERE coverage_status = 'CLASSIFY_INFLOW' AND source_id LIKE '88100000000%'`);
expect('H-13 no inflow of this suite is left as CLASSIFY_INFLOW (none is in a report here; view rule exercised by 0086)', ACT2, 'OK:0');

// ── perimeter ───────────────────────────────────────────────────────────────
expect('Z-1 both RPCs: DEFINER, owner postgres, search_path=public, EXECUTE authenticated only',
  `(SELECT string_agg(proname || '=' || prosecdef || ':' || pg_get_userbyid(proowner) || ':' || (proconfig @> ARRAY['search_path=public']) || ':' || has_function_privilege('anon', oid, 'EXECUTE')
      || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
     FROM pg_proc WHERE proname IN ('mp_classify_payout_outflow', 'mp_classify_inflow_as_collection'))`,
  'mp_classify_inflow_as_collection=true:postgres:true:falsetruefalse,mp_classify_payout_outflow=true:postgres:true:falsetruefalse');
expect('Z-2 tables: RLS, one ADMIN SELECT policy each, SELECT only for authenticated, immutable triggers',
  `(SELECT string_agg(t || '=' || (SELECT relrowsecurity FROM pg_class WHERE relname = t) || ':' || (SELECT string_agg(policyname || ':' || cmd, ',') FROM pg_policies WHERE tablename = t)
      || ':' || has_table_privilege('authenticated', t, 'SELECT') || has_table_privilege('authenticated', t, 'INSERT,UPDATE,DELETE') || has_table_privilege('anon', t, 'SELECT')
      || ':' || (SELECT count(*) FROM pg_trigger WHERE tgrelid = t::regclass AND NOT tgisinternal), ',' ORDER BY t)
     FROM unnest(ARRAY['mp_inflow_classification', 'mp_outflow_classification']) t)`,
  'mp_inflow_classification=true:mp_inflow_classification_admin_select:SELECT:truefalsefalse:1,mp_outflow_classification=true:mp_outflow_classification_admin_select:SELECT:truefalsefalse:1');
expect('Z-3 SECURITY DEFINER set = 87 (83 after ADR-019 + the two classification RPCs)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '87');
expect('Z-4 cron jobs unchanged; mp_v4_verified() false',
  `((SELECT string_agg(jobname, ',' ORDER BY jobname) FROM cron.job) || '|' || mp_v4_verified()::text)`, 'mp_release_report_daily,mp_release_report_daily_fallback,mp_worker_every_minute|false');

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
console.log(`\n  ══ META A 0089 MP CLASSIFICATION RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
