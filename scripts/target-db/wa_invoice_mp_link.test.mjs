#!/usr/bin/env node
/**
 * Lote 4 (0111) — WhatsApp: Factura A receiver / issuer CUIT pending, Mercado Pago expenses confirmed without the operation number
 * and linked later from the ERP. LOCAL TEST DATABASE ONLY; everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/wa_invoice_mp_link.test.mjs
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

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0111-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0111-0000-0000-00000000000b';
const GW = 'aaaaaaaa-0111-0000-0000-0000000000ff';
const PHONE = '+5491100000111';
const CAT = 'cccccccc-0111-0000-0000-0000000000c1';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const CASH = `(SELECT id FROM financial_account WHERE account_type = 'CASH' AND activo ORDER BY nombre LIMIT 1)`;
const sha = (seed) => createHash('sha256').update(`LOTE4-0111-${seed}`).digest('hex');
const RES = (key, path) => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;
const DAY = '2026-10-20';            // the Mercado Pago report day (the outflow's business date)
const WDAY = '2026-10-22';           // the date written in WhatsApp
const O = '930011100101';            // a real outbound payment: economic 500, tax 3, net 503

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, (${got})::text, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const GWC = (call, key) => as('authenticated', GW, call, key);
const ADM = (call, key) => as('authenticated', ADMIN, call, key);

add(`\\set ON_ERROR_STOP 1
BEGIN;
CREATE TEMP TABLE res (k TEXT PRIMARY KEY, v JSONB);
CREATE TEMP TABLE msg (k TEXT PRIMARY KEY, id BIGINT);
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT, p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; m TEXT; ok BOOLEAN := false; e TEXT; val TEXT;
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
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
    EXECUTE p_sql INTO v;
    ok := true;
    RESET ROLE;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS m = MESSAGE_TEXT;
    RESET ROLE;
  END;
  IF ok AND p_key IS NOT NULL THEN INSERT INTO res VALUES (p_key, v::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v; END IF;
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || m END;
END $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, left(p_got, 400), p_like;
  ELSE RAISE NOTICE 'PASS %', p_name; END IF;
END $f$;
CREATE FUNCTION pg_temp.err_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN others THEN RETURN 'ERR:' || SQLERRM; END $f$;
-- one accepted WhatsApp message of the sender (text, or the explicit button of a draft version)
CREATE FUNCTION pg_temp.msg(p_key TEXT, p_button TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $f$
DECLARE v BIGINT;
BEGIN
  INSERT INTO wa.inbound_message (wamid, phone_e164, sender_perfil_id, meta_ts, kind, text_body, button_payload, raw_sha256, outcome)
  VALUES ('T0111-' || p_key, '${PHONE}', '${ADMIN}', now(), CASE WHEN p_button IS NULL THEN 'text' ELSE 'interactive' END,
          CASE WHEN p_button IS NULL THEN 'test' END, p_button, md5(p_key), 'ACCEPTED') RETURNING id INTO v;
  INSERT INTO msg VALUES (p_key, v);
  RETURN v;
END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'lote4-0111-admin@test.local', 'ADMIN'), ('${OPER}', 'lote4-0111-oper@test.local', 'OPERATOR');
INSERT INTO wa.config (singleton, gateway_user_id, enabled) VALUES (true, '${GW}', true)
  ON CONFLICT (singleton) DO UPDATE SET gateway_user_id = EXCLUDED.gateway_user_id, enabled = true;
INSERT INTO wa.sender (phone_e164, perfil_id) VALUES ('${PHONE}', '${ADMIN}');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES ('${CAT}', 'Combustible 0111', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));`);

// ── helpers ──────────────────────────────────────────────────────────────────
const MSG = (k, button = null) => `(SELECT pg_temp.msg(${lit(k)}, ${button === null ? 'NULL' : button}))`;
const BTN = (draftKey, v, kind = 'CONFIRM') => `'${kind}:' || ${RES(draftKey, 'draft_id')} || ':${v}'`;
const propose = (k, type, payload, key) => GWC(`SELECT wa_propose(${P(MSG(k))}::bigint, ${lit(type)}, ${payload})::text`, key);
const correct = (k, draftKey, v, payload, key) => GWC(`SELECT wa_correct(${P(MSG(k))}::bigint, ${P(RES(draftKey, 'draft_id'))}::uuid, ${v}, ${payload})::text`, key);
const confirm = (k, draftKey, v, key) => GWC(`SELECT wa_confirm(${P(MSG(k, BTN(draftKey, v)))}::bigint, ${P(RES(draftKey, 'draft_id'))}::uuid, ${v})::text`, key);
const cancel = (k, draftKey, v) => GWC(`SELECT wa_cancel(${P(MSG(k))}::bigint, ${P(RES(draftKey, 'draft_id'))}::uuid, ${v})::text`);
const J = (o) => `${lit(JSON.stringify(o))}::jsonb`;
const base = (extra) => ({ date: WDAY, total: 70637.06, concept: 'Gasoil', category_id: CAT, nature: 'OPERATING', ...extra });
const FISCAL = (components, issuer = '30712345671') => ({ document_type: 'INVOICE_A', document_date: WDAY, fiscal_period: '2026-10-01', net_amount: 55462.5,
  total_amount: 70637.06, components, external_number: '0110-00010999', issuer_tax_id: issuer, issuer_name: 'EESS Ruta 3' });
const IVA = [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 55462.5, rate_applied: 21, tax_amount: 11647.14 }];
const STATE = (draftKey) => `(SELECT d.type || ':' || d.state FROM wa.draft d WHERE d.id = ${RES(draftKey, 'draft_id')}::uuid)`;
const TABLES = ['financial_operation', 'financial_posting', 'purchases', 'fiscal_document', 'fiscal_document_component', 'expense_payable', 'mp_pending_outflow_resolution'];
const counts = () => TABLES.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const snap = (n) => add(`CREATE TEMP TABLE ${n} AS ${counts()};`);
const delta = (n) => `(SELECT coalesce(string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t), 'none') FROM (${counts()}) c JOIN ${n} b ON b.t = c.t WHERE c.n <> b.n)`;
const BAL = (acc) => `(SELECT coalesce(sum(signed_amount), 0) FROM financial_posting WHERE financial_account_id = ${acc})`;

// ── A. Factura A: receiver not identified / issuer CUIT unreadable ───────────
expect('A-1 Factura A with IVA, receiver not identified → a DRAFT (CASUAL_WITH_INVOICE), IVA not assumed',
  propose('a1', 'CASUAL_WITH_INVOICE', J(base({ method: 'CASH', fiscal: FISCAL([]), vat_receiver_pending: true })), 'A1'), 'OK:%"state": "DRAFT"%');
expect('A-2 it cannot be confirmed while the receiver is pending (WA_RECEIVER_REQUIRED)', confirm('a2', 'A1', 1), 'ERR:WA_RECEIVER_REQUIRED%');
expect('A-3 computable IVA is refused while the receiver is pending', correct('a3', 'A1', 1, J(base({ method: 'CASH', fiscal: FISCAL(IVA), vat_receiver_pending: true }))), 'ERR:WA_INVALID_PAYLOAD%');
expect('A-4 the user says "es de Santo Tomás": the SAME draft gets the IVA (v2)',
  correct('a4', 'A1', 1, J(base({ method: 'CASH', fiscal: FISCAL(IVA) }))), 'OK:%"version": 2%');
expect('A-5 and it stays the same draft, now confirmable', STATE('A1'), 'CASUAL_WITH_INVOICE:DRAFT');
snap('sa');
add(`UPDATE wa.draft SET payload = payload || jsonb_build_object('account_id', ${CASH}) WHERE id = ${RES('A1', 'draft_id')}::uuid;`);
expect('A-6 confirmed (cash): one purchase, one fiscal document with IVA 11,647.14',
  confirm('a6', 'A1', 2, 'A6'), 'OK:%"state": "CONFIRMED"%');
expect('A-7 … IVA recorded once, computable', `(SELECT coalesce(sum(tax_amount), 0) FROM fiscal_document_component WHERE fiscal_document_id = (${RES('A6', 'result')}::jsonb ->> 'fiscal_document_id')::uuid)`, '11647.14');
expect('A-9 Factura A with an unreadable issuer CUIT → CASUAL_EXPENSE, fiscal data held apart (never recorded)',
  propose('a9', 'CASUAL_EXPENSE', J(base({ method: 'CASH', fiscal_pending: FISCAL([], null), issuer_cuit_pending: true, vat_receiver_pending: true })), 'A9'), 'OK:%"state": "DRAFT"%');
expect('A-10 not confirmable without the issuer CUIT (WA_RECEIVER_REQUIRED first, then WA_ISSUER_CUIT_REQUIRED)', confirm('a10', 'A9', 1), 'ERR:WA_RECEIVER_REQUIRED%');
expect('A-11 the user writes the CUIT and confirms the receiver: the same draft becomes CASUAL_WITH_INVOICE',
  correct('a11', 'A9', 1, J(base({ method: 'CASH', fiscal: FISCAL(IVA) }))), 'OK:%"version": 2%');
expect('A-12 … type follows the payload', STATE('A9'), 'CASUAL_WITH_INVOICE:DRAFT');
expect('A-13 "sin factura": back to an expense without invoice (no IVA)', correct('a13', 'A9', 2, J(base({ method: 'CASH' }))), 'OK:%"version": 3%');
expect('A-14 … CASUAL_EXPENSE again', STATE('A9'), 'CASUAL_EXPENSE:DRAFT');
expect('A-15 issuer pending without fiscal_pending is an invalid payload', correct('a15', 'A9', 3, J(base({ method: 'CASH', issuer_cuit_pending: true }))), 'ERR:WA_INVALID_PAYLOAD%');
expect('A-16 cancelled (W-0007 style: nothing recorded)', cancel('a16', 'A9', 3), 'OK:%"state": "CANCELLED"%');

// ── B. Mercado Pago (opción A): the purchase + IVA at confirmation, the outflow linked later (ADR-021 §2.3(c)) ──
const EMPTY = { BALANCE_AMOUNT: '', BUSINESS_UNIT: '', DATE: '', DESCRIPTION: '', GROSS_AMOUNT: '', MP_FEE_AMOUNT: '', NET_CREDIT_AMOUNT: '', NET_DEBIT_AMOUNT: '',
  PAYMENT_METHOD: '', PAYMENT_METHOD_TYPE: '', PURCHASE_ID: '', SOURCE_ID: '', SUB_UNIT: '', TAXES_AMOUNT: '', TRANSACTION_APPROVAL_DATE: '' };
const pay = (t, sid, gross, tax) => ({ ...EMPTY, DATE: `${DAY}T${t}.000-03:00`, SOURCE_ID: sid, DESCRIPTION: 'payment', NET_CREDIT_AMOUNT: '0.00',
  NET_DEBIT_AMOUNT: (gross + tax).toFixed(2), GROSS_AMOUNT: (-gross).toFixed(2), MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: (-tax).toFixed(2),
  PAYMENT_METHOD: 'available_money', TRANSACTION_APPROVAL_DATE: `${DAY}T${t}.000-03:00`, BALANCE_AMOUNT: '0.00', PAYMENT_METHOD_TYPE: 'account_money' });
const O2 = '930011100102';   // same gross: classified as a NEW purchase (the duplicate the warning is about)
const O3 = '930011100103';   // another gross: amount mismatch
const ROWS = [
  { ...EMPTY, DATE: `${DAY}T00:00:00.000-03:00`, NET_CREDIT_AMOUNT: '10000.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '10000.00', MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '10000.00' },
  pay('02:00:00', O, 500, 3), pay('03:00:00', O2, 500, 3), pay('04:00:00', O3, 400, 2),
  { ...EMPTY, NET_CREDIT_AMOUNT: '0.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '-762462.72', MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '0.00' },
].map((raw_row, i) => ({ row_number: i + 1, raw_row }));
const s = sha('day');
const INGEST = as('service_role', null, `SELECT fin_ingest_mp_release_report(NULL::uuid, 'mp-release-report-csv/1.1.0', 'MP_RELEASE_REPORT_CSV_V1', ${lit(s)},
  ${P(`'mp/' || ${MPACC} || '/${s}.csv'`)}, 'release-report.csv', 2048, ${lit(DAY)}::date, ${lit(DAY)}::date,
  ${lit(JSON.stringify({ report_type: 'release_report', task_id: '1' }))}::jsonb, NULL, ${lit(JSON.stringify(ROWS))}::jsonb)::text`);
expect('B-0 three real Mercado Pago outbound payments imported (provisionals, pending classification)', INGEST, 'OK:%"provisionals_posted": 3%');
const EDAY = '2026-09-28';   // the invoice / economic date (September) ≠ the movement date (October 20)
const MPFISCAL = { document_type: 'INVOICE_A', document_date: EDAY, fiscal_period: '2026-09-01', net_amount: 413.22, total_amount: 500,
  components: [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 413.22, rate_applied: 21, tax_amount: 86.78 }], external_number: '0001-00000777',
  issuer_tax_id: '30712345671', issuer_name: 'EESS Ruta 3' };
const mpExpense = { date: EDAY, total: 500, net: 413.22, concept: 'Gasoil MP', category_id: CAT, nature: 'OPERATING', method: 'MERCADOPAGO', fiscal: MPFISCAL };
const PURCHASE = RES('B3', 'result') + "::jsonb ->> 'purchase_id'";
const PNLP = ADM(`SELECT count(*) || ':' || coalesce(sum(signed_amount), 0) FROM pnl_line_item WHERE source_entity_type = 'purchases' AND source_entity_id = (${P(PURCHASE)})`);
const MPB = BAL(MPACC);
add(`CREATE TEMP TABLE mp0 AS SELECT ${MPB} AS mp;`);
expect('B-1 an invoice paid with Mercado Pago WITHOUT operation number → a normal DRAFT (no WAITING_MP, no candidate search)',
  propose('b1', 'CASUAL_WITH_INVOICE', `${J(mpExpense)} || jsonb_build_object('account_id', ${P(MPACC)}::uuid)`, 'B1'), 'OK:%"state": "DRAFT"%');
expect('B-2 … no mp_candidates, marked mp_link_pending', `(SELECT (NOT (v ? 'mp_candidates'))::text || ':' || (v -> 'payload' ->> 'mp_link_pending') FROM res WHERE k = 'B1')`, 'true:true');
snap('sb');
expect('B-3 confirmed → the purchase is recorded now (P&L + IVA), MP pending link, no money',
  confirm('b3', 'B1', 1, 'B3'), 'OK:%"status": "PENDIENTE_VINCULACION_MP"%"mp_link_pending": true, "financial_effect": "NONE"%');
expect('B-4 … one purchase, one fiscal document with ONE IVA line; no operation, no posting, no payable, no release', delta('sb'),
  'fiscal_document=1,fiscal_document_component=1,purchases=1');
expect('B-5 recognised in the P&L BEFORE the link (one line, at the economic date)', PNLP, 'OK:1:%');
expect('B-6 … at its economic date (September), not the movement date', `(SELECT economic_date::text FROM purchases WHERE id = (${PURCHASE})::uuid)`, EDAY);
expect('B-7 explicit state: PENDIENTE_VINCULACION_MP with the two same-amount pending outflows listed (never chosen)',
  ADM(`SELECT status || ':' || jsonb_array_length(candidates) || ':' || coalesce(origin_code, '-') FROM fin_purchase_mp_link WHERE purchase_id = (${P(PURCHASE)})::uuid`), 'OK:PENDIENTE_VINCULACION_MP:2:W-%');
expect('B-8 a second confirmation (another message) → already confirmed', confirm('b8', 'B1', 1), 'OK:%"already_confirmed": true%');
expect('B-8b … nothing new', delta('sb'), 'fiscal_document=1,fiscal_document_component=1,purchases=1');
expect('B-9 audit: CONFIRM / MP_LINK_PENDING and CREATE_MP_PENDING_PURCHASE',
  `((SELECT string_agg(action || ':' || outcome, ',' ORDER BY id) FROM wa.audit_event WHERE draft_id = ${RES('B1', 'draft_id')}::uuid) || '|' || (SELECT count(*) FROM audit_events WHERE action = 'CREATE_MP_PENDING_PURCHASE' AND entity_id = (${PURCHASE})))`,
  '%CONFIRM:MP_LINK_PENDING%|1');
// the duplicate the owner warned about: O2 classified as a NEW casual purchase (not blocked), then refused for the link
expect('B-10 O2 classified as a new purchase from Pendientes MP (allowed: a warning, not a block)',
  ADM(`SELECT register_casual_purchase('${DAY}'::date, 500, 500, '${CAT}'::uuid, 'Otro gasto', 'OPERATING', ${P(MPACC)}::uuid, 'MERCADOPAGO', 'T0111-O2', NULL, '[]'::jsonb, '[]'::jsonb, NULL, NULL, NULL, '${O2}', 'clasificado aparte')::text`), 'OK:%');
snap('sc');
const SETTLE = (src, key = 'T0111-SETTLE', who = ADMIN) => as('authenticated', who, `SELECT settle_purchase_mp(${P(PURCHASE)}::uuid, '${src}', '${key}', 'vinculación manual')::text`);
expect('B-11 linking the already classified O2 → ALREADY_CLASSIFIED (never re-pointed)', SETTLE(O2), 'ERR:ALREADY_CLASSIFIED%CASUAL_PURCHASE%');
expect('B-12 linking O3 (gross 400 ≠ 500) → MP_AMOUNT_MISMATCH', SETTLE(O3), 'ERR:MP_AMOUNT_MISMATCH%');
expect('B-13 an OPERATOR cannot link', SETTLE(O, 'T0111-OP', OPER), 'ERR:FORBIDDEN%');
expect('B-13b … nothing written by the refusals', delta('sc'), 'none');
// the expense's month (September) is closed; the movement's month (October) is open: the link only touches October
add(`INSERT INTO management_period (periodo_fecha, status) VALUES ('2026-09-01', 'OPEN') ON CONFLICT (periodo_fecha) DO UPDATE SET status = 'OPEN';`);
expect('B-14 closing September with an MP purchase pending link → NOT blocked, a warning + audit row',
  as('postgres', null, `UPDATE management_period SET status = 'CLOSED', closed_at = now() WHERE periodo_fecha = '2026-09-01' RETURNING status::text`), 'OK:CLOSED');
expect('B-14b … the warning left its audit row', `(SELECT count(*) FROM audit_events WHERE action = 'CLOSE_WITH_MP_LINK_PENDING' AND entity_id = '2026-09-01')`, '1');
add(`CREATE TEMP TABLE mp1 AS SELECT ${MPB} AS mp; CREATE TEMP TABLE pnl1 AS SELECT ${ADM(`SELECT md5(coalesce((SELECT string_agg(x::text, '#' ORDER BY x::text) FROM pnl_line_item x), ''))`)} AS h;`);
snap('sd');
expect('B-15 linked to O (gross 500 + tax 3) with September closed → only the payment side, on the MOVEMENT date',
  SETTLE(O, 'T0111-SETTLE'), `OK:%"tax": -3.00, "amount": 500.00, "status": "VINCULADO"%"economic_date": "${EDAY}", "movement_date": "${DAY}"%`);
expect('B-16 … no purchase, no fiscal document, no IVA line; release + payment + tax charge, one classification, one link',
  delta('sd'), 'financial_operation=3,financial_posting=3,mp_pending_outflow_resolution=1');
expect('B-17 … P&L unchanged by the link (recognised once, at confirmation)', `(${ADM(`SELECT md5(coalesce((SELECT string_agg(x::text, '#' ORDER BY x::text) FROM pnl_line_item x), ''))`)} = (SELECT h FROM pnl1))::text`, 'true');
expect('B-18 … Mercado Pago unchanged by the link: the provisional already took the net 503 (release +503, payment −500, tax −3)',
  `((SELECT ${MPB} - mp FROM mp1)::NUMERIC(15,2))`, '0.00');
expect('B-19 … the movement reconciles to its net once (provisional, release, payment, charge)',
  `(SELECT sum(r.assigned_amount)::text FROM mp_reconciliation r JOIN mp_pending_outflow po ON po.mp_financial_movement_id = r.mp_financial_movement_id WHERE po.source_id = '${O}')`, '-503.00');
expect('B-20 … IVA recorded once for the purchase', `(SELECT count(*) || ':' || sum(c.tax_amount) FROM fiscal_document_component c JOIN purchases p ON p.fiscal_document_id = c.fiscal_document_id WHERE p.id = (${PURCHASE})::uuid)`, '1:86.78');
expect('B-21 … the payment is dated on the movement, the purchase keeps its economic date',
  `(SELECT o.effective_date || '|' || p.economic_date FROM purchase_mp_settlement s JOIN financial_operation o ON o.id = s.financial_operation_id JOIN purchases p ON p.id = s.purchase_id WHERE s.source_id = '${O}')`, `${DAY}|${EDAY}`);
expect('B-22 the same link again → replayed, nothing new', SETTLE(O, 'T0111-SETTLE'), 'OK:%"replayed": true%');
expect('B-22b … nothing new', delta('sd'), 'financial_operation=3,financial_posting=3,mp_pending_outflow_resolution=1');
expect('B-23 another operation for the same purchase → PURCHASE_MP_ALREADY_LINKED', SETTLE(O3, 'T0111-OTHER'), 'ERR:PURCHASE_MP_ALREADY_LINKED%');
expect('B-24 state VINCULADO with both dates; no candidates any more',
  ADM(`SELECT status || ':' || movement_date || ':' || economic_date || ':' || (candidates IS NULL) FROM fin_purchase_mp_link WHERE purchase_id = (${P(PURCHASE)})::uuid`), `OK:VINCULADO:${DAY}:${EDAY}:true`);
expect('B-25 the MP activity shows the outflow classified with the EXISTING purchase', ADM(`SELECT coverage_status || ':' || classification || ':' || classification_detail FROM fin_mp_report_activity WHERE source_id = '${O}' AND description = 'payment'`),
  'OK:CLASSIFIED_OUTFLOW:CASUAL_PURCHASE:Gasoil MP · Combustible 0111%');
expect('B-26 audit SETTLE_MP; the link records are append-only',
  `((SELECT count(*) FROM audit_events WHERE action = 'SETTLE_MP' AND entity_id = (${PURCHASE}))::text || '|' || ${as('postgres', null, `UPDATE purchase_mp_settlement SET reason = 'x' RETURNING 'x'`)} || '|' || ${as('postgres', null, `DELETE FROM purchase_mp_link RETURNING 'x'`)})`, '1|ERR:%|ERR:%');
expect('B-27 an OPERATOR reads no link (RLS)', as('authenticated', OPER, `SELECT ((SELECT count(*) FROM purchase_mp_link) + (SELECT count(*) FROM purchase_mp_settlement) + (SELECT count(*) FROM fin_purchase_mp_link))::text`), 'OK:0');
expect('B-28 a casual purchase without payment, payable or MP link is still refused at commit (the amended 0106 check)',
  `pg_temp.err_of($q$INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature, is_current, version_seq, idempotency_key)
    VALUES (NULL, '2026-10-20', 1, 1, '${CAT}', 'x', 'OPERATING', true, 0, 'T0111-UNSETTLED'); SET CONSTRAINTS trg_purchases_casual_settlement IMMEDIATE$q$)`, 'ERR:CASUAL_PURCHASE_UNSETTLED%');

// ── C. compatibility: cash, transfer, "a pagar", solo IVA keep their routes ───
snap('se');
expect('C-1 a pending expense ("a pagar") still becomes PENDING_EXPENSE', propose('c1', 'CASUAL_EXPENSE', J(base({ total: 1200, concept: 'Flete', pending_payment: true })), 'C1'), 'OK:%"type": "PENDING_EXPENSE"%');
expect('C-2 … confirmed: a payable', confirm('c2', 'C1', 1), 'OK:%"payable_id"%"financial_effect": "NONE"%');
expect('C-2b … one payable and its purchase, no money, no MP link', delta('se'), 'expense_payable=1,purchases=1');
const BNA = `(SELECT id FROM financial_account WHERE nombre = 'BNA' AND account_type = 'BANK_ACCOUNT')`;
snap('sf');
expect('C-3 a transfer expense: proposed and confirmed', `(${propose('c3', 'CASUAL_EXPENSE', `${J(base({ total: 800, concept: 'Repuestos' , method: 'TRANSFER' }))} || jsonb_build_object('account_id', ${P(BNA)}::uuid)`, 'C3')})`, 'OK:%"state": "DRAFT"%');
expect('C-4 … confirmed: purchase + payment from the bank (born paid)', confirm('c4', 'C3', 1), 'OK:%"state": "CONFIRMED"%"payment_operation_id"%');
expect('C-4b … one purchase, one operation, one posting', delta('sf'), 'financial_operation=1,financial_posting=1,purchases=1');
snap('sg');
const VATDOC = { document_type: 'INVOICE_A', document_date: WDAY, fiscal_period: '2026-10-01', net_amount: 1000, total_amount: 1210, external_number: '0009-00000001',
  issuer_tax_id: '30709998885', issuer_name: 'Otro', components: [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 1000, rate_applied: 21, tax_amount: 210 }] };
expect('C-5 "solo IVA": only Fiscal', propose('c5', 'VAT_ONLY_DOCUMENT', J({ date: WDAY, total: 1210, vat_only: true, fiscal: VATDOC }), 'C5'), 'OK:%"state": "DRAFT"%');
expect('C-6 … confirmed: a fiscal document, no purchase, no money', confirm('c6', 'C5', 1), 'OK:%"state": "CONFIRMED"%');
expect('C-6b … only the fiscal document and its IVA line', delta('sg'), 'fiscal_document=1,fiscal_document_component=1');

add('ROLLBACK;');

const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const containers = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean);
const container = containers.find((c) => (dockerRun(['port', c, '5432/tcp']).stdout || '').includes(`:${target.port}`));
if (!container) { console.error(`  no running supabase_db container mapped to the guarded port ${target.port}. Run \`supabase start\`.`); process.exit(1); }
console.log(`  container: ${container}`);
const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const lines = `${r.stdout}\n${r.stderr}`.split('\n');
let pass = 0; let fail = 0;
for (const l of lines) {
  const m = l.match(/NOTICE:\s+(PASS|FAIL) (.*)$/);
  if (m) { if (m[1] === 'PASS') { pass += 1; console.log(`    OK   ${m[2]}`); } else { fail += 1; console.log(`    MAL  ${m[2]}`); } }
}
if (r.status !== 0) { fail += 1; console.log(`    MAL  psql aborted: ${(lines.find((l) => /ERROR/.test(l)) || r.stderr || '').slice(0, 300)}`); }
console.log(`\n  ${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);
