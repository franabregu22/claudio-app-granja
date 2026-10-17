#!/usr/bin/env node
/**
 * ADR-022 — HISTORICAL MERCADO PAGO RECONSTRUCTION (migration 0094). LOCAL TEST DATABASE ONLY.
 *
 * A synthetic two-file history (15-column + 16-column release reports, overlapping row, one post-cutover row) is staged and
 * reconstructed against a cutover opening: gates before any write (exact total to the cent), one effect per real monetary row
 * (receipt / yield by the A1 plan; CVU / DEBIN / outbound / payouts as ADR-021 pendings), reserves evidence only, own-account
 * payout tagged without a bank credit, the opening neutralized (post-cutover balances unchanged), replays write nothing,
 * period protection and the SOURCE_ID invariant intact. Real release reports are never part of this test.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_mp_historical.test.mjs
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
const ADMIN = 'aaaaaaaa-0094-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0094-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR022-0094-${seed}`).digest('hex');
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
  ('${ADMIN}', 'adr022-0094-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr022-0094-oper@test.local',  'OPERATOR');`);

// ── fixtures: cutover boundary 04/10 19:00 BA, the Mercado Pago cutover opening, a synthetic two-file history ──
const OPENING = '2000.00';
const BNA_CBU = `(SELECT i.normalized_value FROM financial_account_identifier i JOIN financial_account a ON a.id = i.financial_account_id WHERE a.nombre = 'BNA' AND i.active AND i.identifier_type IN ('CBU', 'CVU') LIMIT 1)`;
add(`UPDATE mp_cutover_boundary SET cutover_at = TIMESTAMPTZ '2026-10-04 19:00:00-03';
WITH o AS (INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason)
           VALUES ('ADJUSTMENT', DATE '2026-10-04', 'PHASE31-OPENING:TEST94:Mercado Pago', 'phase31_opening', 'Mercado Pago', 'phase31 opening (test)') RETURNING id)
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
SELECT o.id, ${MPACC}, ${OPENING}, DATE '2026-10-04' FROM o;
UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '2026-02-01';`);

const KEYS = ['DATE', 'SOURCE_ID', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT', 'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'TAXES_AMOUNT', 'PAYMENT_METHOD',
  'TRANSACTION_APPROVAL_DATE', 'BUSINESS_UNIT', 'SUB_UNIT', 'BALANCE_AMOUNT', 'PAYMENT_METHOD_TYPE', 'PURCHASE_ID'];
let bal = 0;
const row = (date, sid, desc, net, gross, tax, method = 'available_money', type = 'account_money', dest = null) => {
  bal = Math.round((bal + net) * 100) / 100;
  const r = Object.fromEntries(KEYS.map((k) => [k, '']));
  Object.assign(r, { DATE: `${date}.000-03:00`, SOURCE_ID: sid, DESCRIPTION: desc, NET_CREDIT_AMOUNT: net > 0 ? net.toFixed(2) : '0.00',
    NET_DEBIT_AMOUNT: net < 0 ? (-net).toFixed(2) : '0.00', GROSS_AMOUNT: gross.toFixed(2), MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: tax.toFixed(2),
    PAYMENT_METHOD: method, TRANSACTION_APPROVAL_DATE: `${date}.000-03:00`, BALANCE_AMOUNT: bal.toFixed(2), PAYMENT_METHOD_TYPE: type });
  if (dest !== null) r.PAYOUT_BANK_ACCOUNT_NUMBER = dest;
  return r;
};
const ctl = (date, b) => ({ ...Object.fromEntries(KEYS.map((k) => [k, ''])), DATE: `${date}.000-03:00`, NET_CREDIT_AMOUNT: b, NET_DEBIT_AMOUNT: '0.00',
  GROSS_AMOUNT: b, MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: b });
const S = (n) => `9400000000${String(n).padStart(2, '0')}`;
// file 1 (15 columns): receipt, yield, CVU, DEBIN, reserve pair + outbound, payout without destination
const F1 = [ctl('2026-02-01T00:00:00', '0.00'),
  row('2026-02-10T10:00:00', S(1), 'payment', 994, 1000, -6),
  row('2026-02-11T02:00:00', S(2), 'asset_management', 5, 5, 0, 'available_money', ''),
  row('2026-02-12T10:00:00', S(3), 'payment', 497, 500, -3, 'cvu', 'bank_transfer'),
  row('2026-02-13T10:00:00', S(4), 'payment', 298.2, 300, -1.8, 'debin_transfer', 'bank_transfer'),
  row('2026-02-14T10:00:00', S(5), 'reserve_for_payment', -100.6, -100.6, 0),
  row('2026-02-14T10:00:00', S(5), 'reserve_for_payment', 100.6, 100.6, 0),
  row('2026-02-14T10:00:00', S(5), 'payment', -100.6, -100, -0.6),
  row('2026-02-15T10:00:00', S(6), 'payout', -200, -200, 0, 'available_money', '')];
const bal1 = bal;
// file 2 (16 columns, overlaps the last row of file 1): payouts to BNA (own) and a third party, the receipt that reaches the opening, one post-cutover row
const F2raw = [ctl('2026-09-01T00:00:00', bal1.toFixed(2)), { ...F1[F1.length - 1], PAYOUT_BANK_ACCOUNT_NUMBER: '' }];
bal = bal1;
F2raw.push(row('2026-09-02T10:00:00', S(7), 'payout', -300, -300, 0, 'available_money', '', '__BNA__'));
F2raw.push(row('2026-09-03T10:00:00', S(8), 'payout', -50, -50, 0, 'available_money', '', '9999999999999999990001'));
const need = Math.round((Number(OPENING) - bal) * 100) / 100;
F2raw.push(row('2026-10-03T14:00:00', S(9), 'payment', need, need, 0));
F2raw.push(row('2026-10-04T20:36:11', S(10), 'payment', 49.7, 50, -0.3));
const rowsOfH = (raws) => raws.map((raw_row, i) => ({ row_number: i + 1, raw_row }));
const RF1 = JSON.stringify(rowsOfH(F1));
const RF2 = JSON.stringify(rowsOfH(F2raw.map((r) => { const o = { ...r }; KEYS.forEach((k) => { if (o[k] === undefined) o[k] = ''; }); if (!('PAYOUT_BANK_ACCOUNT_NUMBER' in o)) o.PAYOUT_BANK_ACCOUNT_NUMBER = ''; return o; })));
const STAGE = (name, sha, rowsSql, role = 'authenticated', uid = ADMIN) => as(role, uid, `SELECT mp_historical_stage(${lit(name)}, ${lit(sha)}, ${rowsSql})::text`);
const F2SQL = `replace(${lit(RF2)}, '__BNA__', ${P(BNA_CBU)})::jsonb`;
const RECON = (amount, role = 'authenticated', uid = ADMIN) => as(role, uid, `SELECT mp_historical_reconstruct(${amount}, 'ADR-022 test')::text`);
const MPB = (d) => `(SELECT coalesce(sum(p.signed_amount), 0)::NUMERIC(15,2) FROM financial_posting p WHERE p.financial_account_id = ${MPACC} AND p.effective_date <= DATE '${d}')`;
const MOVOPS = (identity) => `(SELECT string_agg(o.operation_type || ':' || r.assigned_amount || ':' || split_part(o.external_ref, ':', 1), ' ' ORDER BY o.id) FROM mp_reconciliation r JOIN financial_operation o ON o.id = r.financial_operation_id
  JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id = '${identity}')`;
const PEND = (sid) => `(SELECT kind || ':' || amount || ':' || NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id) FROM mp_pending_outflow p WHERE p.source_id = '${sid}')`;
add(`CREATE TEMP TABLE b0 AS SELECT d, ${MPB('1900-01-01').replace("DATE '1900-01-01'", 'd')} AS bal FROM unnest(ARRAY[DATE '2026-10-03', DATE '2026-10-04', DATE '2026-10-15', DATE '2030-12-31']) d;
CREATE TEMP TABLE bna0 AS SELECT coalesce(sum(p.signed_amount), 0) AS bal FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id WHERE a.nombre IN ('BNA', 'Patagonia');`);

// ── staging ──
expect('S-1 an operator / anon cannot stage historical evidence', `(${STAGE('f1.csv', 'a'.repeat(64), `${lit(RF1)}::jsonb`, 'authenticated', OPER)} || '|' || ${STAGE('f1.csv', 'a'.repeat(64), `${lit(RF1)}::jsonb`, 'anon', null)})`, 'ERR:FORBIDDEN%|ERR:permission denied%');
expect('S-2 file 1 staged: 8 movement rows, 1 control row, 0 excluded', STAGE('f1.csv', 'a'.repeat(64), `${lit(RF1)}::jsonb`), 'OK:%"rows": 9%"staged": 8%"control_rows": 1%"excluded_post_cutover": 0%');
add(`CREATE TEMP TABLE c1 AS ${counts()};`);
expect('C-1 the same file again → replayed', STAGE('f1.csv', 'a'.repeat(64), `${lit(RF1)}::jsonb`), 'OK:%"replayed": true%');
expect('C-2 … and nothing written', `coalesce(${delta('c1')}, 'none')`, 'none');
expect('D-1 file 2 (16 columns): the overlapping row is a duplicate, the post-cutover row (04/10 20:36) is excluded, 2 payout destinations',
  STAGE('f2.csv', 'b'.repeat(64), F2SQL), 'OK:%"rows": 6%"staged": 3%"duplicates": 1%"control_rows": 1%"destinations": 2%"excluded_post_cutover": 1%');
expect('D-2 the post-cutover row was never stored', `(SELECT count(*)::text FROM mp_historical_row WHERE source_id = '${S(10)}')`, '0');
expect('C-3 a conflicting repeated identity is refused', STAGE('f3.csv', 'c'.repeat(64), `${lit(JSON.stringify(rowsOfH([{ ...F1[1], NET_CREDIT_AMOUNT: '995.00', BALANCE_AMOUNT: '995.00' }])))}::jsonb`),
  'ERR:HISTORICAL_ROW_CONFLICT%');

// ── gates before any write ──
add(`CREATE TEMP TABLE c2 AS ${counts()};`);
expect('B-1 one cent above the opening → refused (HISTORICAL_TOTAL_MISMATCH)', RECON('2000.01'), 'ERR:HISTORICAL_TOTAL_MISMATCH%');
expect('B-2 one cent below → refused', RECON('1999.99'), 'ERR:HISTORICAL_TOTAL_MISMATCH%');
expect('B-3 the refusals wrote nothing (no movement, no posting, no neutralization)', `coalesce(${delta('c2')}, 'none')`, 'none');
expect('Q-1 an operator cannot reconstruct', RECON(OPENING, 'authenticated', OPER), 'ERR:FORBIDDEN%');

// ── the reconstruction ──
expect('A-1 reconstruction: continuity from 0.00, total = opening = 2,000.00; 11 rows applied',
  RECON(OPENING), `OK:%"replayed": false%"rows_applied": 11%"opening_amount": ${OPENING}%"reconstructed_total": ${OPENING}%`);
expect('A-2 MP as of 03/10 grows by the reconstructed history = 2,000.00 = the opening', `(SELECT (${MPB('2026-10-03')} - bal)::text FROM b0 WHERE d = DATE '2026-10-03')`, OPENING);
expect('O-1 MP: +2,000.00 on 03/10 (history), 0.00 at / after the cutover (opening neutralized)', `(SELECT string_agg((${MPB('1900-01-01').replace("DATE '1900-01-01'", 'b.d')} - b.bal)::text, ',' ORDER BY b.d) FROM b0 b)`, '2000.00,0.00,0.00,0.00');
expect('E-1 a receipt affects MP once: A1 plan MP_SETTLEMENT gross + tax ADJUSTMENT = net; no client allocation',
  `(${MOVOPS(`${S(1)}:payment:C`)} || '|' || (SELECT count(*) FROM mp_client_allocation al JOIN mp_transition_identity t ON t.mp_financial_movement_id = al.mp_financial_movement_id WHERE t.resource_id = '${S(1)}'))`,
  'MP_SETTLEMENT:1000.00:MP ADJUSTMENT:-6.00:MP|0');
expect('F-1 CVU: real effect, pending classification (INFLOW), no allocation', `(${MOVOPS(`${S(3)}:payment:C`)} || '|' || ${PEND(S(3))})`, 'ADJUSTMENT:497.00:MP-PENDING|INFLOW:497.00:true');
expect('G-1 DEBIN: pending classification', PEND(S(4)), 'INFLOW:298.20:true');
expect('H-1 outbound payment: pending (OUTBOUND), its reserve pair evidence only', `(${PEND(S(5))} || '|' || (SELECT string_agg(processing_status::text, ',') FROM mp_source_record WHERE external_id LIKE '${S(5)}:reserve_for_payment:%'))`, 'OUTBOUND:-100.60:true|IGNORED,IGNORED');
expect('K-1 reserve rows: no movement, no posting', `(SELECT count(*)::text FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE '${S(5)}:reserve_for_payment:%')`, '0');
expect('I-1 payouts pending; destination status: unknown / own BNA / third party (last 4 only)', as('authenticated', ADMIN,
  `SELECT string_agg(source_id || ':' || destination_status || ':' || coalesce(matched_account_name, '-') || ':' || pending, ',' ORDER BY source_id) FROM fin_mp_historical_payouts`),
  `OK:${S(6)}:UNKNOWN_DESTINATION:-:true,${S(7)}:OWN_ACCOUNT_TRANSFER_CANDIDATE:BNA:true,${S(8)}:THIRD_PARTY:-:true`);
expect('L-1 the own-account candidate does NOT credit the bank account', `((SELECT coalesce(sum(p.signed_amount), 0) FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id WHERE a.nombre IN ('BNA', 'Patagonia')) - (SELECT bal FROM bna0))::text`, '0');
expect('J-1 the yield is historical financial income exactly once; no other historical P&L line', as('authenticated', ADMIN,
  `SELECT string_agg(bucket || ':' || signed_amount, ',') FROM pnl_line_item WHERE business_date < DATE '2026-10-04' AND ((source_entity_type = 'mp_financial_movement' AND source_entity_id IN (SELECT m.id::text FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE '9400%')) OR source_entity_id IN (SELECT o.id::text FROM financial_operation o WHERE o.external_ref LIKE 'MP-PENDING:9400%'))`),
  'OK:OTROS_INGRESOS_FINANCIEROS:5.00');
expect('A-3 historical status classes', as('authenticated', ADMIN, `SELECT string_agg(class || ':' || row_count || ':' || amount, ',' ORDER BY class) FROM fin_mp_historical_status`),
  `OK:INFLOW_CVU:1:497.00,INFLOW_DEBIN:1:298.20,OUTBOUND:1:-100.60,PAYOUT:3:-550.00,RECEIPT:2:${(994 + need).toFixed(2)},RESERVE:2:0.00,YIELD:1:5.00`);
expect('M-1 the neutralization: −opening on the opening date, linked to it, audited source exception', `(SELECT (o.external_ref LIKE 'MP-HIST-OPENING-NEUTRALIZATION:%')::text || ':' || p.signed_amount || ':' || o.effective_date || ':' || (SELECT kind FROM mp_source_exception WHERE financial_operation_id = o.id)
   FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id WHERE o.external_ref LIKE 'MP-HIST-OPENING-NEUTRALIZATION:%')`, 'true:-2000.00:2026-10-04:OPENING_NEUTRALIZATION');
expect('Q-2 audited: staging and reconstruction events', `(SELECT string_agg(action || ':' || n, ',' ORDER BY action) FROM (SELECT action, count(*) n FROM audit_events WHERE action IN ('MP_HISTORICAL_STAGED', 'MP_HISTORICAL_RECONSTRUCTED') GROUP BY action) x)`, 'MP_HISTORICAL_RECONSTRUCTED:1,MP_HISTORICAL_STAGED:2');
add(`CREATE TEMP TABLE c3 AS ${counts()};`);
expect('N-1 reconstruction replay → replayed', RECON(OPENING), 'OK:%"replayed": true%');
expect('N-2 … and nothing written', `coalesce(${delta('c3')}, 'none')`, 'none');
expect('C-4 staging after the reconstruction is closed', STAGE('f4.csv', 'd'.repeat(64), `${lit(RF1)}::jsonb`), 'ERR:HISTORICAL_ALREADY_APPLIED%');

// ── period protection and invariants ──
expect('P-1 the reconstruction wrote into the CLOSED February; the normal guard still refuses it', `pg_temp.err_of($q$SELECT assert_period_open(DATE '2026-02-10')$q$)`, 'ERR:PERIOD_CLOSED%');
expect('P-2 a normal route into the closed period is still refused', as('authenticated', ADMIN,
  `SELECT mp_admin_correction(1, DATE '2026-02-10', 'x', 'evidence', 'TEST94-P2')::text`), 'ERR:PERIOD_CLOSED%');
expect('Q-3 the historical functions are DEFINER, EXECUTE for authenticated only; SECURITY DEFINER set 94',
  `((SELECT string_agg(proname || '=' || prosecdef || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('anon', oid, 'EXECUTE'), ',' ORDER BY proname)
     FROM pg_proc WHERE proname IN ('mp_historical_stage', 'mp_historical_reconstruct')) || '|' || (SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace))`,
  'mp_historical_reconstruct=truetruefalse,mp_historical_stage=truetruefalse|94');
expect('Q-4 historical evidence is immutable; the destination is not readable by API roles', `(pg_temp.err_of($q$UPDATE mp_historical_row SET net_amount = 1 WHERE source_id = '${S(1)}'$q$) || '|' || has_table_privilege('authenticated', 'mp_historical_destination', 'SELECT'))`,
  'ERR:FIN_EVIDENCE_IMMUTABLE%|false');
expect('R-1 SOURCE_ID invariant: every MP posting is linked (deferred check passes now)', `pg_temp.err_of($q$SET CONSTRAINTS ALL IMMEDIATE$q$)`, 'OK');
expect('R-2 a manual MP posting without source is still refused', `pg_temp.err_of($q$DO $x$ DECLARE v BIGINT; BEGIN INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason) VALUES ('ADJUSTMENT', DATE '2026-10-16', 'TEST94-R2', 'probe', 'x', 'probe') RETURNING id INTO v; INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date) VALUES (v, ${MPACC}, 1, DATE '2026-10-16'); SET CONSTRAINTS ALL IMMEDIATE; END $x$$q$)`,
  'ERR:MP_POSTING_REQUIRES_SOURCE%');

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
console.log(`\n  ══ ADR-022 0094 MP HISTORICAL RECONSTRUCTION RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
