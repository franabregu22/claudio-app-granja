#!/usr/bin/env node
/**
 * ADR-023 — MERCADO PAGO UNLINKED INFLOWS (migration 0095). LOCAL TEST DATABASE ONLY.
 *
 * A real inflow affects Mercado Pago immediately and never requires a classification: live account_fund + DEBIN is applied,
 * inflows (live and historical ADR-022 CVU / DEBIN / receipts) never block the period close and are listed apart as optional
 * "Entradas sin vincular"; only outflows (OUTBOUND / PAYOUT) stay mandatory. Customer linking accepts payment and inflow
 * movements once (closed source month → today, never backdated), never moves Mercado Pago, creates no P&L, reverses safely.
 * No API role reads a full payout account number (raw_row / protected source rows); server side keeps the evidence.
 * Aggregates are server-side; pagination is deterministic; ADR-022 and current balances are unchanged.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_mp_unlinked_inflows.test.mjs
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
const ADMIN = 'aaaaaaaa-0095-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0095-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR023-0095-${seed}`).digest('hex');
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
  ('${ADMIN}', 'adr023-0095-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr023-0095-oper@test.local',  'OPERATOR');`);

const MPB = (d) => `(SELECT coalesce(sum(p.signed_amount), 0)::NUMERIC(15,2) FROM financial_posting p WHERE p.financial_account_id = ${MPACC} AND p.effective_date <= DATE '${d}')`;
// ── fixtures: cutover 04/10 19:00 BA, a synthetic history (receipt, CVU, DEBIN, 1100 small CVU, outbound, payout with a
// third-party destination, the receipt reaching the opening), the opening; a live payout pending; live payments ──
const CLI = 'cccccccc-0095-0000-0000-0000000000d1';
const OPENING = '5000.00';
add(`INSERT INTO clients (id, nombre) VALUES ('${CLI}', 'Cliente ADR-023');
UPDATE mp_cutover_boundary SET cutover_at = TIMESTAMPTZ '2026-10-04 19:00:00-03';
WITH o AS (INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason)
           VALUES ('ADJUSTMENT', DATE '2026-10-04', 'PHASE31-OPENING:TEST95:Mercado Pago', 'phase31_opening', 'Mercado Pago', 'phase31 opening (test)') RETURNING id)
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
SELECT o.id, ${MPACC}, ${OPENING}, DATE '2026-10-04' FROM o;`);
const KEYS = ['DATE', 'SOURCE_ID', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT', 'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'TAXES_AMOUNT', 'PAYMENT_METHOD',
  'TRANSACTION_APPROVAL_DATE', 'BUSINESS_UNIT', 'SUB_UNIT', 'BALANCE_AMOUNT', 'PAYMENT_METHOD_TYPE', 'PURCHASE_ID'];
let bal = 0;
const row = (date, sid, desc, net, gross, tax, method = 'available_money', type = 'account_money', dest = '') => {
  bal = Math.round((bal + net) * 100) / 100;
  const r = Object.fromEntries(KEYS.map((k) => [k, '']));
  Object.assign(r, { DATE: `${date}.000-03:00`, SOURCE_ID: sid, DESCRIPTION: desc, NET_CREDIT_AMOUNT: net > 0 ? net.toFixed(2) : '0.00',
    NET_DEBIT_AMOUNT: net < 0 ? (-net).toFixed(2) : '0.00', GROSS_AMOUNT: gross.toFixed(2), MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: tax.toFixed(2),
    PAYMENT_METHOD: method, TRANSACTION_APPROVAL_DATE: `${date}.000-03:00`, BALANCE_AMOUNT: bal.toFixed(2), PAYMENT_METHOD_TYPE: type,
    PAYOUT_BANK_ACCOUNT_NUMBER: dest });
  return r;
};
const H = (n) => `95000000${String(n).padStart(4, '0')}`;
const SECRET = '9999999999999999990002';
const HIST = [row('2026-02-10T10:00:00', H(1), 'payment', 994, 1000, -6),
  row('2026-02-12T10:00:00', H(2), 'payment', 500, 500, 0, 'cvu', 'bank_transfer'),
  row('2026-02-13T10:00:00', H(3), 'payment', 300, 300, 0, 'debin_transfer', 'bank_transfer')];
for (let i = 0; i < 1100; i++) HIST.push(row('2026-02-20T10:00:00', H(100 + i), 'payment', 1, 1, 0, 'cvu', 'bank_transfer'));
HIST.push(row('2026-03-05T10:00:00', H(4), 'payment', -100, -100, 0));
HIST.push(row('2026-03-06T10:00:00', H(5), 'payout', -200, -200, 0, 'available_money', '', SECRET));
HIST.push(row('2026-10-03T14:00:00', H(6), 'payment', Math.round((Number(OPENING) - bal) * 100) / 100, Math.round((Number(OPENING) - bal) * 100) / 100, 0));
const RH = JSON.stringify(HIST.map((raw_row, i) => ({ row_number: i + 1, raw_row })));
expect('setup: history staged (1106 rows, 1 destination)', as('authenticated', ADMIN, `SELECT mp_historical_stage('h95.csv', ${lit('e'.repeat(64))}, ${lit(RH)}::jsonb)::text`), 'OK:%"staged": 1106%"destinations": 1%');
expect('setup: history reconstructed = opening', as('authenticated', ADMIN, `SELECT mp_historical_reconstruct(${OPENING}, 'ADR-023 test')::text`), `OK:%"rows_applied": 1106%"reconstructed_total": ${OPENING}%`);
// a live (post-cutover) payout: ADR-021 provisional + mandatory pending
const LP = '950000009001';
const LROWS = [CTL, mv('06:00:00', LP, 'payout', '0.00', '450.00', '-450.00', '0.00', '0.00', 'available_money', ''), TOT];
expect('setup: live payout ingested (1 provisional)', NORMAL({ sha: sha('live'), actor: null, rows: rowsOf(LROWS) }, 'R'), 'OK:%"provisionals_posted": 1%');

// live payments (Nov, an OPEN month)
const svc = (q, key = null) => as('service_role', null, q, key);
function payment(k, pid, opType, method, amount) {
  const at = '2026-11-05T10:00:00.000-03:00';
  const pl = { id: Number(pid), operation_type: opType, payment_method_id: method, payment_type_id: method === 'account_money' ? 'account_money' : 'bank_transfer',
    status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true, collector_id: 100000001, payer: { id: '800000995' },
    external_reference: null, date_created: at, date_approved: at, date_last_updated: at, transaction_amount: amount,
    transaction_details: { net_received_amount: amount }, fee_details: [], refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
  add(`SELECT pg_temp.must(${lit(`${k} delivery`)}, ${svc(`SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', '${pid}', NULL, 'T95', ${lit(JSON.stringify({ notification_id: `t95-${pid}` }))}::jsonb, true)::text`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} claim`)}, ${svc(`SELECT row_to_json(c)::text FROM mp_claim_deliveries(50, 120) c WHERE c.resource_id = '${pid}'`, `${k}_c`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} snapshot`)}, ${svc(`SELECT mp_ingest_api_snapshot(${P(RES(`${k}_c`, 'delivery_id'))}::uuid, ${P(RES(`${k}_c`, 'claim_token'))}::uuid, '${pid}', ${lit(JSON.stringify(pl))}::jsonb)::text`, `${k}_i`)});`);
  add(`SELECT pg_temp.must(${lit(`${k} normalize`)}, ${svc(`SELECT mp_normalize_source(${P(RES(`${k}_i`, 'source_record_id'))}::uuid)::text`)});`);
}
const MVP = (pid) => `(SELECT t.mp_financial_movement_id FROM mp_transition_identity t WHERE t.resource_type = 'payment' AND t.resource_id = '${pid}' AND t.transition = 'APPROVAL')`;
const MVH = (sid) => `(SELECT t.mp_financial_movement_id FROM mp_transition_identity t WHERE t.resource_type = 'report' AND t.resource_id = '${sid}:payment:C' AND t.transition = 'APPROVAL')`;
const apply = (pid) => svc(`SELECT mp_apply_transition(${P(MVP(pid))})::text`);
const L1 = '950000008001';   // live account_fund + DEBIN
const L2 = '950000008002';   // live ordinary receipt (account money)
const L3 = '950000008003';   // live account_fund + DEBIN → own transfer (0086)
const L0 = '950000008000';   // account_fund + DEBIN left unapplied (pre-0095 legacy state)
payment('L1', L1, 'account_fund', 'debin_transfer', 10000);
payment('L2', L2, 'money_transfer', 'account_money', 7500);
payment('L3', L3, 'account_fund', 'debin_transfer', 2000);
payment('L0', L0, 'account_fund', 'debin_transfer', 4000);

// ── A. live DEBIN: immediate effect ──
add(`CREATE TEMP TABLE a0 AS SELECT ${BAL('Mercado Pago')} AS mp;`);
expect('A-1 live account_fund + DEBIN is auto-applied (A1 plan)', apply(L1), 'OK:%');
expect('A-2 … the Mercado Pago balance grows by 10,000.00 at once', `((SELECT ${BAL('Mercado Pago')} - mp FROM a0))::text`, '10000.00');
expect('A-3 the receipt and the own-transfer candidate are applied too', `(${apply(L2)} || '|' || ${apply(L3)})`, 'OK:%|OK:%');

// ── B–E. period close / optional inflows ──
const CLOSEPROBE = (month) => `pg_temp.err_of($q$DO $x$ BEGIN UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${month}'; RAISE EXCEPTION 'CLOSE_ALLOWED'; END $x$$q$)`;
expect('B-1 November (live DEBIN unlinked + a legacy unapplied DEBIN + an unlinked receipt) can be closed', CLOSEPROBE('2026-11-01'), 'ERR:CLOSE_ALLOWED');
expect('C-1 February (historical receipt, CVU, DEBIN, 1100 small CVU — all unlinked) can be closed', CLOSEPROBE('2026-02-01'), 'ERR:CLOSE_ALLOWED');
expect('D-1 March (historical OUTBOUND + PAYOUT unresolved) is blocked', CLOSEPROBE('2026-03-01'), 'ERR:PENDING_CLASSIFICATION: 2 %');
expect('D-2 October (the live payout unresolved) is blocked', CLOSEPROBE('2026-10-01'), 'ERR:PENDING_CLASSIFICATION: 1 %');
const PENDV = as('authenticated', ADMIN, `SELECT string_agg(source_id || ':' || kind || ':' || direction || ':' || amount || ':' || is_historical || ':' || coalesce(destination_status, '-') || ':' || coalesce(destination_last4, '-'), ',' ORDER BY source_id)
  FROM fin_mp_pending_classification WHERE source_id LIKE '9500000%'`);
expect('E-1 mandatory pendings = only outflows (historical OUTBOUND / PAYOUT third party ****0002, live payout); no inflow, no CLASSIFY_INFLOW',
  PENDV, `OK:${H(4)}:OUTBOUND:OUT:-100.00:true:-:-,${H(5)}:PAYOUT:OUT:-200.00:true:THIRD_PARTY:0002,${LP}:PAYOUT:OUT:-450.00:false:-:-`);
const UNL = (where) => as('authenticated', ADMIN, `SELECT count(*) || ':' || coalesce(sum(remaining_amount), 0) FROM fin_mp_unlinked_inflows WHERE ${where}`);
expect('E-2 unlinked inflows (historical): CVU 1101 / 1600.00, DEBIN 1 / 300.00, receipts 2 (incl. the opening receipt)',
  as('authenticated', ADMIN, `SELECT string_agg(inflow_subtype || ':' || n || ':' || s, ',' ORDER BY inflow_subtype) FROM (SELECT inflow_subtype, count(*) n, sum(remaining_amount) s FROM fin_mp_unlinked_inflows WHERE is_historical AND source_id LIKE '9500000%' GROUP BY 1) x`),
  `OK:CVU:1101:1600.00,DEBIN:1:300.00,RECEIPT:2:${(1000 + Number(OPENING) - 2594 - 0).toFixed(2)}`);
expect('E-3 unlinked inflows (live): DEBIN 10000 + 2000 (account_fund), receipt 7500; the unapplied legacy DEBIN is not in the balance → not listed',
  as('authenticated', ADMIN, `SELECT string_agg(source_id || ':' || inflow_subtype || ':' || account_fund || ':' || remaining_amount, ',' ORDER BY source_id) FROM fin_mp_unlinked_inflows WHERE NOT is_historical AND source_id LIKE '95000000800%'`),
  `OK:${L1}:DEBIN:true:10000.00,${L2}:RECEIPT:false:7500.00,${L3}:DEBIN:true:2000.00`);
expect('E-4 the legacy unapplied DEBIN is not a mandatory pending either', as('authenticated', ADMIN, `SELECT count(*)::text FROM fin_mp_pending_classification WHERE source_id = '${L0}'`), 'OK:0');
expect('E-5 inflows create no P&L', as('authenticated', ADMIN, `SELECT count(*)::text FROM pnl_line_item WHERE source_entity_type = 'mp_financial_movement' AND source_entity_id IN (SELECT id::text FROM mp_financial_movement WHERE movement_kind IN ('payment', 'inflow'))`), 'OK:0');

// ── N / O / P. volume, aggregates, pagination ──
expect('N-1 1100+ historical inflows never reach the mandatory list; the first page (oldest first, 1000) still holds the live pending',
  as('authenticated', ADMIN, `SELECT count(*) FILTER (WHERE source_id = '${LP}') || ':' || count(*) FILTER (WHERE kind NOT IN ('PAYOUT', 'OUTBOUND')) FROM (SELECT * FROM fin_mp_pending_classification ORDER BY business_date, source_id LIMIT 1000) x`), 'OK:1:0');
expect('O-1 server-side summary = the views (pending current / historical, unlinked current / historical)',
  as('authenticated', ADMIN, `SELECT (SELECT string_agg(bucket || ':' || item_count || ':' || amount, ',' ORDER BY bucket) FROM fin_mp_pending_summary) = (
     SELECT string_agg(b || ':' || n || ':' || s, ',' ORDER BY b) FROM (
       SELECT CASE WHEN is_historical THEN 'PENDING_HISTORICAL' ELSE 'PENDING_CURRENT' END b, count(*) n, sum(amount)::NUMERIC(15,2) s FROM fin_mp_pending_classification GROUP BY 1
       UNION ALL SELECT CASE WHEN is_historical THEN 'UNLINKED_HISTORICAL' ELSE 'UNLINKED_CURRENT' END, count(*), sum(remaining_amount)::NUMERIC(15,2) FROM fin_mp_unlinked_inflows GROUP BY 1) y)::text`), 'OK:true');
expect('O-2 summary always has the 4 buckets; non-ADMIN gets none', `(${as('authenticated', ADMIN, `SELECT count(*)::text FROM fin_mp_pending_summary`)} || '|' || ${as('authenticated', OPER, `SELECT count(*)::text FROM fin_mp_pending_summary`)})`, 'OK:4|OK:0');
expect('P-1 pagination (business_date desc, movement_id desc): page 1 (1000) + page 2 = all rows, disjoint, stable',
  as('authenticated', ADMIN, `WITH a AS (SELECT movement_id FROM fin_mp_unlinked_inflows ORDER BY business_date DESC, movement_id DESC LIMIT 1000),
    b AS (SELECT movement_id FROM fin_mp_unlinked_inflows ORDER BY business_date DESC, movement_id DESC OFFSET 1000)
    SELECT ((SELECT count(*) FROM a) + (SELECT count(*) FROM b) = (SELECT count(*) FROM fin_mp_unlinked_inflows)
      AND NOT EXISTS (SELECT 1 FROM a JOIN b USING (movement_id)) AND (SELECT count(*) FROM fin_mp_unlinked_inflows) > 1000)::text`), 'OK:true');

// ── F–J. customer linking ──
add(`CREATE TEMP TABLE f0 AS SELECT ${MPB('2026-10-03')} AS h, ${BAL('Mercado Pago')} AS mp, (SELECT count(*) FROM financial_posting) AS np;
CREATE TEMP TABLE f0p AS SELECT ${as('authenticated', ADMIN, PNL)} AS h;
UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '2026-02-01';`);
const ALLOC = (mvExpr, amount, date, key, role = 'authenticated', uid = ADMIN) => as(role, uid,
  `SELECT mp_allocate_to_client(${P(mvExpr)}, '${CLI}'::uuid, ${amount}, ${date === null ? 'NULL' : `DATE '${date}'`}, ${lit(key)}, 'ADR-023 test')::text`, key);
const TODAY = `(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`;
expect('F-1 a receipt (payment) with an explicit date: unchanged contract (EXPLICIT)', ALLOC(MVP(L2), 7500, '2026-11-06', 'T95-F1'), 'OK:%"effective_date": "2026-11-06"%"effective_date_rule": "EXPLICIT"%');
expect('F-2 an explicit date in a CLOSED month is still refused', ALLOC(`(SELECT t.mp_financial_movement_id FROM mp_transition_identity t WHERE t.resource_type = 'payment' AND t.resource_id = '${H(1)}')`, 10, '2026-02-15', 'T95-F2'), 'ERR:PERIOD_CLOSED%');
expect('G-1 a historical DEBIN inflow (movement kind inflow) is linked once', ALLOC(MVH(H(3)), 300, null, 'T95-G1'), 'OK:%');
expect('G-2 the same idempotency key → DUPLICATE_ALLOCATION (nothing written)', ALLOC(MVH(H(3)), 300, null, 'T95-G1'), 'ERR:DUPLICATE_ALLOCATION%');
expect('G-3 above the unallocated amount → refused', ALLOC(MVH(H(3)), 1, null, 'T95-G3'), 'ERR:ALLOCATION_EXCEEDS_RECEIPT%');
expect('G-4 a fully linked inflow leaves "Entradas sin vincular"', UNL(`source_id = '${H(3)}'`), 'OK:0:0');
expect('G-5 an outflow / OPERATOR / anon cannot be linked', `(${ALLOC(`(SELECT mp_financial_movement_id FROM mp_pending_outflow WHERE source_id = '${H(4)}')`, 10, null, 'T95-G5')} || '|' || ${ALLOC(MVH(H(2)), 10, null, 'T95-G5b', 'authenticated', OPER)} || '|' || ${ALLOC(MVH(H(2)), 10, null, 'T95-G5c', 'anon', null)})`,
  'ERR:NOT_A_RECEIPT%|ERR:FORBIDDEN%|ERR:permission denied%');
expect('I-1 a historical CVU of a CLOSED month without date → today, rule CURRENT_DATE_SOURCE_PERIOD_NOT_OPEN, source date kept', ALLOC(MVH(H(2)), 200, null, 'T95-I1'),
  `OK:%"source_date": "2026-02-12"%"effective_date_rule": "CURRENT_DATE_SOURCE_PERIOD_NOT_OPEN"%`);
expect('I-2 … the allocation and the client ledger are dated today (never backdated into February); evidence keeps SOURCE_ID / source date',
  `(SELECT (a.effective_date = ${TODAY} AND l.effective_date = ${TODAY})::text || '|' || (a.evidence ->> 'source_id') || '|' || (a.evidence ->> 'source_date')
     FROM mp_client_allocation a JOIN client_ledger l ON l.id = a.client_ledger_id WHERE a.idempotency_key = 'T95-I1')`, `true|${H(2)}|2026-02-12`);
expect('I-3 a live DEBIN of an OPEN month without date → its own date (SOURCE_DATE)', ALLOC(MVP(L1), 10000, null, 'T95-I3'), 'OK:%"effective_date": "2026-11-05"%"effective_date_rule": "SOURCE_DATE"%');
expect('I-4 February is still CLOSED (never reopened)', `(SELECT status::text FROM management_period WHERE periodo_fecha = '2026-02-01')`, 'CLOSED');
const AID = (key) => `(SELECT id FROM mp_client_allocation WHERE idempotency_key = '${key}')`;
const REV = (key, amount, rkey) => as('authenticated', ADMIN, `SELECT mp_reverse_client_allocation(${P(AID(key))}, ${amount}, ${lit(rkey)}, 'ADR-023 test')::text`);
expect('J-1 reversal of part of the DEBIN link → OK; the inflow is unlinked again for 100.00', `(${REV('T95-G1', 100, 'T95-J1')} LIKE 'OK:%')::text || '|' || ${UNL(`source_id = '${H(3)}'`)}`, 'true|OK:1:100.00');
expect('J-2 same reversal key again / above the remaining → refused', `(${REV('T95-G1', 100, 'T95-J1')} || '|' || ${REV('T95-G1', 300, 'T95-J2')})`, 'ERR:DUPLICATE_ALLOCATION%|ERR:REVERSAL_EXCEEDS_ALLOCATION%');
expect('H-1 linking / reversing never moves Mercado Pago (no posting) and creates no P&L',
  `((SELECT (${BAL('Mercado Pago')} - mp)::text || ':' || ((SELECT count(*) FROM financial_posting) - np) FROM f0) || '|' || ((SELECT h FROM f0p) = ${as('authenticated', ADMIN, PNL)})::text)`, '0.00:0|true');
expect('H-2 client ledger: 7500 + 300 + 200 + 10000 collected, 100 reversed', `(SELECT sum(signed_amount)::text FROM client_ledger WHERE cliente_id = '${CLI}')`, '-17900.00');

// ── own-account transfer (optional, 0086, unchanged) ──
add(`CREATE TEMP TABLE t0 AS SELECT ${BAL('Mercado Pago')} AS mp, ${BAL('BNA')} AS bna;`);
expect('T-1 an applied live account_fund DEBIN → own transfer (0086)', as('authenticated', ADMIN, `SELECT mp_reclassify_inbound_own_transfer('${L3}', ${P(`(SELECT id FROM financial_account WHERE nombre = 'BNA')`)}::uuid, 'test')::text`), 'OK:%');
expect('T-2 … MP unchanged, BNA −2000, no longer an unlinked inflow', `((SELECT (${BAL('Mercado Pago')} - mp)::text || ':' || (${BAL('BNA')} - bna)::text FROM t0) || '|' || ${UNL(`source_id = '${L3}'`)})`, '0.00:-2000.00|OK:0:0');

// ── K / L / M. raw evidence security ──
expect('K-1 ADMIN cannot read mp_historical_row.raw_row', as('authenticated', ADMIN, `SELECT raw_row::text FROM mp_historical_row LIMIT 1`), 'ERR:permission denied%');
expect('K-2 ADMIN reads the safe columns of mp_historical_row', as('authenticated', ADMIN, `SELECT count(*)::text FROM (SELECT id, identity, source_id, payment_method, net_amount FROM mp_historical_row WHERE source_id LIKE '9500000%') x`), 'OK:1106');
expect('K-3 ADMIN never sees the full account number in any source record (0097: the raw payload is not API-readable at all)', as('authenticated', ADMIN, `SELECT count(*)::text FROM mp_source_record WHERE event_data::text LIKE '%${SECRET}%'`), 'ERR:permission denied%');
expect('K-4 … nor in the curated views (last 4 only)', as('authenticated', ADMIN, `SELECT ((SELECT count(*) FROM fin_mp_pending_classification x WHERE x::text LIKE '%${SECRET}%') + (SELECT count(*) FROM fin_mp_historical_payouts x WHERE x::text LIKE '%${SECRET}%')
   + (SELECT count(*) FROM fin_mp_unlinked_inflows x WHERE x::text LIKE '%${SECRET}%') + (SELECT count(*) FROM report_mp_movement_status x WHERE x::text LIKE '%${SECRET}%') + (SELECT count(*) FROM audit_events x WHERE x::text LIKE '%${SECRET}%'))::text`), 'OK:0');
expect('K-5 the protected movement is still listed (report_mp_movement_status keeps it)', as('authenticated', ADMIN,
  `SELECT count(*)::text FROM report_mp_movement_status r JOIN mp_pending_outflow p ON p.mp_financial_movement_id = r.mp_financial_movement_id WHERE p.source_id = '${H(5)}'`), 'OK:1');
expect('L-1 anon cannot read the raw evidence nor the source records', `(${as('anon', null, `SELECT raw_row::text FROM mp_historical_row LIMIT 1`)} || '|' || ${as('anon', null, `SELECT count(*)::text FROM mp_source_record`)})`, 'ERR:permission denied%|ERR:permission denied%');
expect('M-1 server side keeps the evidence: service role reads the protected source; the private destination still matched (THIRD_PARTY ****0002)',
  `(${as('service_role', null, `SELECT count(*)::text FROM mp_source_record WHERE event_data ->> 'PAYOUT_BANK_ACCOUNT_NUMBER' = '${SECRET}'`)} || '|' || ${as('authenticated', ADMIN, `SELECT destination_status || ':' || destination_last4 FROM fin_mp_historical_payouts WHERE source_id = '${H(5)}'`)}
     || '|' || (SELECT count(*) FROM mp_historical_destination WHERE destination_value = '${SECRET}'))`, `OK:1|OK:THIRD_PARTY:0002|1`);
expect('M-2 the evidence is unchanged (immutable)', `(SELECT (raw_row ->> 'PAYOUT_BANK_ACCOUNT_NUMBER') = '${SECRET}' FROM mp_historical_row WHERE source_id = '${H(5)}')::text`, 'true');

// ── Q / R. balances ──
expect('R-1 ADR-022 historical balance unchanged by the 0095 operations (MP as of 03/10 = opening)', `(SELECT (${MPB('2026-10-03')} - h)::text || ':' || ${MPB('2026-10-03')} FROM f0)`, `0.00:${OPENING}`);
expect('Q-1 current / post-cutover MP balances unchanged by linking and the own transfer (only the live receipts moved it)', `((SELECT ${BAL('Mercado Pago')} - mp FROM f0))::text`, '0.00');
expect('Q-2 SOURCE_ID invariant holds', `pg_temp.err_of($q$SET CONSTRAINTS ALL IMMEDIATE$q$)`, 'OK');
expect('Q-3 no duplicate postings / allocations per key', `((SELECT count(*) FROM (SELECT financial_operation_id, financial_account_id, signed_amount FROM financial_posting GROUP BY 1, 2, 3 HAVING count(*) > 1) x) + (SELECT count(*) FROM (SELECT idempotency_key FROM mp_client_allocation GROUP BY 1 HAVING count(*) > 1) x))::text`, '0');
expect('Q-4 SECURITY DEFINER set unchanged (93)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '94');

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
console.log(`\n  ══ ADR-023 0095 MP UNLINKED INFLOWS RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
