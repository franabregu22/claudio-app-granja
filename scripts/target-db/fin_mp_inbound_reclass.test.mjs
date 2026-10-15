#!/usr/bin/env node
/**
 * MP INBOUND OWN-ACCOUNT TRANSFERS (migration 0086). LOCAL TEST DATABASE ONLY.
 *
 * Real pipeline inside one rolled-back transaction: webhook delivery → claim → API snapshot → RPC 40 normalization →
 * A1 application. Covers: account_fund + debin_transfer is no longer auto-applied (NOT_AUTO_APPLICABLE, stays
 * NORMALIZED) while money_transfer and account_fund + cvu still are; mp_reclassify_inbound_own_transfer on an APPLIED
 * payment (explicit MP_SETTLEMENT reversal + one TRANSFER: MP unchanged, bank −net) and on an UNAPPLIED one (TRANSFER
 * only); idempotency (replay, another account refused); refusals (money_transfer, unknown payment, non-bank source,
 * OPERATOR, anon); no client allocation afterwards; the activity status OWN_TRANSFER / CLASSIFY_INFLOW logic; P&L
 * untouched; privileges; SECURITY DEFINER 80.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_mp_inbound_reclass.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// ── SQL helpers ──────────────────────────────────────────────────────────────
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0086-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0086-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR018-0086-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved by run_as as the owner, before the role switch
const PARSER = 'mp-release-report-csv/1.1.0';
const DAY = '2026-10-13';
const FORMAT = 'MP_RELEASE_REPORT_CSV_V1';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);

// ── synthetic Liberaciones rows (ADR-003 D1: 15 keys, every value the exported string) ─────────────────────────
const EMPTY = { BALANCE_AMOUNT: '', BUSINESS_UNIT: '', DATE: '', DESCRIPTION: '', GROSS_AMOUNT: '', MP_FEE_AMOUNT: '',
  NET_CREDIT_AMOUNT: '', NET_DEBIT_AMOUNT: '', PAYMENT_METHOD: '', PAYMENT_METHOD_TYPE: '', PURCHASE_ID: '', SOURCE_ID: '',
  SUB_UNIT: '', TAXES_AMOUNT: '', TRANSACTION_APPROVAL_DATE: '' };
const mv = (t, sid, desc, credit, debit, gross, tax, bal, method = 'available_money', type = 'account_money') => ({
  ...EMPTY, DATE: `2026-10-13T${t}.000-03:00`, SOURCE_ID: sid, DESCRIPTION: desc, NET_CREDIT_AMOUNT: credit, NET_DEBIT_AMOUNT: debit,
  GROSS_AMOUNT: gross, MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: tax, PAYMENT_METHOD: method, TRANSACTION_APPROVAL_DATE: `2026-10-13T${t}.000-03:00`,
  BALANCE_AMOUNT: bal, PAYMENT_METHOD_TYPE: type });
const OPENING = { ...EMPTY, DATE: '2026-10-13T00:00:00.000-03:00', NET_CREDIT_AMOUNT: '1000.00', NET_DEBIT_AMOUNT: '0.00',
  GROSS_AMOUNT: '1000.00', MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '1000.00' };
const TOTALS = { ...EMPTY, NET_CREDIT_AMOUNT: '9941.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '10000.00', MP_FEE_AMOUNT: '0.00',
  TAXES_AMOUNT: '-59.00', BALANCE_AMOUNT: '0.00' };
const GOOD = [
  OPENING,
  mv('08:00:00', '810000000001', 'payment', '8946.00', '0.00', '9000.00', '-54.00', '9946.00', 'cvu', 'bank_transfer'),
  mv('09:00:00', '810000000002', 'payment', '0.00', '500.00', '-500.00', '0.00', '9446.00'),
  mv('10:00:00', '810000000003', 'asset_management', '12.34', '0.00', '12.34', '0.00', '9458.34', '', ''),
  mv('11:00:00', '810000000004', 'reserve_for_payout', '0.00', '200.00', '-200.00', '0.00', '9258.34', 'available_money', ''),
  mv('11:00:01', '810000000004', 'reserve_for_payout', '200.00', '0.00', '200.00', '0.00', '9458.34', 'available_money', ''),
  mv('11:00:01', '810000000004', 'payout', '0.00', '200.00', '-200.00', '0.00', '9258.34', 'available_money', ''),
  mv('12:00:00', '810000000005', 'reserve_for_payment', '0.00', '10.00', '-10.00', '0.00', '9248.34'),
  TOTALS,
];
const rowsOf = (raws) => raws.map((raw_row, i) => ({ row_number: i + 1, raw_row }));
const swap = (i, over) => GOOD.map((r, j) => (j === i ? { ...r, ...over } : r));

function captureCall(o) {
  const s = o.sha;
  return `SELECT ${o.fn ?? 'fin_capture_mp_release_report'}(${lit(o.actor === undefined ? ADMIN : o.actor)}::uuid, ${lit(o.parser ?? PARSER)},
    ${lit(o.format === undefined ? FORMAT : o.format)}, ${lit(s)},
    ${o.path === undefined ? P(`'mp/' || ${MPACC} || '/${s}.csv'`) : lit(o.path)}, ${lit(o.file ?? 'release-report.csv')}, 2048,
    ${lit(o.day ?? DAY)}::date, ${lit(o.day ?? DAY)}::date, ${lit(JSON.stringify(o.meta ?? { report_type: 'release_report', task_id: '1' }))}::jsonb,
    ${lit(o.reject ?? null)}, ${o.rows === null ? 'NULL' : `${lit(JSON.stringify(o.rows ?? rowsOf(GOOD)))}::jsonb`})::text`;
}
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const service = (o, key = null) => as('service_role', null, captureCall(o), key);
const RUN = (key) => `(SELECT r FROM fin_import_run r WHERE r.id = ${RES(key)}::uuid)`;
const outcomes = (key) => `(SELECT string_agg(row_number || ':' || outcome || ':' || coalesce(appearance_meta ->> 'row_class', '?') || ':' || coalesce(split_part(note, ':', 1), '-'), ',' ORDER BY row_number)
  FROM fin_import_run_line WHERE run_id = ${RES(key)}::uuid)`;

const FIN_TABLES = ['financial_operation', 'financial_posting', 'mp_source_record', 'mp_transition_identity', 'mp_webhook_delivery',
  'mp_reconciliation', 'mp_financial_movement', 'mp_report_match', 'fin_statement_line'];
const counts = () => FIN_TABLES.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');

// ── prelude ──────────────────────────────────────────────────────────────────
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
  ('${ADMIN}', 'adr018-0086-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr018-0086-oper@test.local',  'OPERATOR');
CREATE TEMP TABLE before_counts AS ${counts()};
CREATE TEMP TABLE before_jobs AS SELECT jobid, jobname, schedule, command, active FROM cron.job;`);

const NORMAL = (o, key = null) => as('service_role', null, captureCall({ ...o, fn: 'fin_ingest_mp_release_report' }), key);
const runOf = (key, cols) => `(SELECT ${cols} FROM fin_import_run r WHERE r.id = ${RES(key)}::uuid)`;
const backfills = (pid) => `(SELECT count(*)::text FROM mp_webhook_delivery WHERE origin = 'report_backfill' AND resource_id = '${pid}')`;
const deliveries = (pid) => `(SELECT count(*)::text FROM mp_webhook_delivery WHERE resource_id = '${pid}')`;
const CTL = (day) => ({ ...GOOD[0], DATE: `${day}T00:00:00.000-03:00` });
const TOT = (credit, gross, tax) => ({ ...GOOD[GOOD.length - 1], NET_CREDIT_AMOUNT: credit, GROSS_AMOUNT: gross, TAXES_AMOUNT: tax });
// a payments day without yields: inbound payment, outbound payment, payout with its reserve pair, control rows
const DAILY = [
  CTL(DAY),
  mv('08:00:00', '810000000001', 'payment', '8946.00', '0.00', '9000.00', '-54.00', '9946.00', 'cvu', 'bank_transfer'),
  mv('09:00:00', '810000000002', 'payment', '0.00', '500.00', '-500.00', '0.00', '9446.00'),
  mv('11:00:00', '810000000004', 'reserve_for_payout', '0.00', '200.00', '-200.00', '0.00', '9246.00', 'available_money', ''),
  mv('11:00:01', '810000000004', 'reserve_for_payout', '200.00', '0.00', '200.00', '0.00', '9446.00', 'available_money', ''),
  mv('11:00:01', '810000000004', 'payout', '0.00', '200.00', '-200.00', '0.00', '9246.00', 'available_money', ''),
  TOT('8246.00', '8300.00', '-54.00'),
];
const D14 = '2026-10-14';
const WEBHOOK_FIRST = [
  CTL(D14),
  { ...mv('08:00:00', '810000000021', 'payment', '79.52', '0.00', '80.00', '-0.48', '1079.52', 'cvu', 'bank_transfer'),
    DATE: `${D14}T08:00:00.000-03:00`, TRANSACTION_APPROVAL_DATE: `${D14}T08:00:00.000-03:00` },
  TOT('79.52', '80.00', '-0.48'),
];

const BNA = `(SELECT id FROM financial_account WHERE nombre = 'BNA' AND account_type = 'BANK_ACCOUNT')`;
const MPID = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const bal = (acc) => `(SELECT coalesce(sum(signed_amount), 0) FROM financial_posting WHERE financial_account_id = ${acc})`;
add(`CREATE TEMP TABLE bal0 AS SELECT ${bal(BNA)} AS bna, ${bal(MPID)} AS mp;`);
const svc = (sql, key = null) => as('service_role', null, sql, key);
// one inbound payment through the real pipeline: delivery → claim → snapshot → RPC 40; returns nothing, keys `<k>_c`, `<k>_i`
function payment(k, pid, opType, method, amount) {
  const at = '2026-11-05T10:00:00.000-04:00';
  const pl = { id: Number(pid), operation_type: opType, payment_method_id: method, payment_type_id: method === 'account_money' ? 'account_money' : 'bank_transfer',
    status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true, collector_id: 100000001, payer: { id: '800000999' },
    external_reference: null, date_created: at, date_approved: at, date_last_updated: at, transaction_amount: amount,
    transaction_details: { net_received_amount: amount }, fee_details: [], refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
  expect(`${k}: delivery registered`, svc(`SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', '${pid}', NULL, 'T86', ${lit(JSON.stringify({ notification_id: `t86-${pid}` }))}::jsonb, true)::text`), 'OK:%');
  expect(`${k}: claimed`, svc(`SELECT row_to_json(c)::text FROM mp_claim_deliveries(50, 120) c WHERE c.resource_id = '${pid}'`, `${k}_c`), 'OK:%');
  expect(`${k}: snapshot ingested`, svc(`SELECT mp_ingest_api_snapshot(${P(RES(`${k}_c`, 'delivery_id'))}::uuid, ${P(RES(`${k}_c`, 'claim_token'))}::uuid, '${pid}', ${lit(JSON.stringify(pl))}::jsonb)::text`, `${k}_i`), 'OK:%');
  expect(`${k}: normalized`, svc(`SELECT mp_normalize_source(${P(RES(`${k}_i`, 'source_record_id'))}::uuid)::text`), 'OK:%NORMALIZED%');
}
const MV = (pid) => `(SELECT t.mp_financial_movement_id FROM mp_transition_identity t WHERE t.resource_type = 'payment' AND t.resource_id = '${pid}' AND t.transition = 'APPROVAL')`;
const apply = (pid) => svc(`SELECT mp_apply_transition(${P(MV(pid))})::text`);
const reclass = (role, uid, pid, acc = BNA) => as(role, uid, `SELECT mp_reclassify_inbound_own_transfer('${pid}', ${P(acc)}::uuid, 'test')::text`);
const P_FUND_DEBIN = '861000000001';   // own transfer, by DEBIN
const P_FUND_CVU = '861000000002';     // account_fund by CVU (keeps today's behaviour)
const P_SALE = '861000000003';         // money_transfer (a sale)
const P_LEGACY = '861000000004';       // account_fund + DEBIN applied before 0086 (the 3 real cases)
const P_UNAPPLIED = '861000000005';    // account_fund + DEBIN after 0086

// ── A. future rule: account_fund + DEBIN is not auto-applied; the others still are ─
payment('A1', P_FUND_DEBIN, 'account_fund', 'debin_transfer', 100000);
payment('A2', P_FUND_CVU, 'account_fund', 'cvu', 7500);
payment('A3', P_SALE, 'money_transfer', 'account_money', 12000);
expect('A-1 account_fund + debin_transfer → NOT_AUTO_APPLICABLE (stays NORMALIZED for classification)', apply(P_FUND_DEBIN), 'ERR:NOT_AUTO_APPLICABLE%');
expect('A-2 account_fund + cvu → still applied as MP_SETTLEMENT', apply(P_FUND_CVU), 'OK:%');
expect('A-3 money_transfer → still applied as MP_SETTLEMENT', apply(P_SALE), 'OK:%');
expect('A-4 the DEBIN inflow has no operation yet', `(SELECT count(*)::text FROM mp_reconciliation WHERE mp_financial_movement_id = ${MV(P_FUND_DEBIN)})`, '0');

// ── B. reclassify an UNAPPLIED inflow: one TRANSFER, movement reconciled to it ─
expect('B-1 reclassify the unapplied DEBIN inflow → TRANSFER only (no reversal)', reclass('authenticated', ADMIN, P_FUND_DEBIN), 'OK:%"replayed": false%"reversal_operation_id": null%');
expect('B-2 operations of the movement: TRANSFER BNA −100000 / MP +100000, reconciled +100000',
  `(SELECT string_agg(o.operation_type || ':' || o.external_ref || ':' || r.assigned_amount, ',' ORDER BY o.id) FROM mp_reconciliation r JOIN financial_operation o ON o.id = r.financial_operation_id
     WHERE r.mp_financial_movement_id = ${MV(P_FUND_DEBIN)})`, `TRANSFER:MP-INBOUND-TRANSFER:${P_FUND_DEBIN}:100000.00`);
expect('B-3 the TRANSFER has exactly the two postings BNA −100000, MP +100000',
  `(SELECT string_agg(a.nombre || ':' || p.signed_amount, ',' ORDER BY p.signed_amount) FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id
     JOIN financial_account a ON a.id = p.financial_account_id WHERE o.external_ref = 'MP-INBOUND-TRANSFER:${P_FUND_DEBIN}')`, 'BNA:-100000.00,Mercado Pago:100000.00');

// ── C. reclassify an APPLIED inflow (the 3 real cases: applied before 0086) ─
payment('C1', P_LEGACY, 'account_fund', 'debin_transfer', 1000000);
// simulate "applied before 0086": the A1 settlement exactly as it was created (MP_SETTLEMENT +net, reconciled)
add(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason)
     SELECT 'MP_SETTLEMENT', m.occurred_date, 'MP:MPA:T86LEGACY:SETTLE', 'mp_financial_movement', m.id::text, 'ADR-006 auto-apply' FROM mp_financial_movement m WHERE m.id = ${MV(P_LEGACY)};
     INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
     SELECT o.id, ${MPID}, 1000000, o.effective_date FROM financial_operation o WHERE o.external_ref = 'MP:MPA:T86LEGACY:SETTLE';
     INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at)
     SELECT ${MV(P_LEGACY)}, o.id, ${MPID}, 1000000, 'MPA:T86LEGACY:SETTLE', NOW() FROM financial_operation o WHERE o.external_ref = 'MP:MPA:T86LEGACY:SETTLE';
     CREATE TEMP TABLE bal1 AS SELECT ${bal(BNA)} AS bna, ${bal(MPID)} AS mp;`);
expect('C-1 reclassify the applied inflow → reversal + TRANSFER', reclass('authenticated', ADMIN, P_LEGACY), 'OK:%"amount": 1000000.00, "replayed": false%"reversal_operation_id": %');
expect('C-2 movement operations: original SETTLE +1000000, explicit RECLASS −1000000 (MP_SETTLEMENT, not ADJUSTMENT), TRANSFER +1000000',
  `(SELECT string_agg(o.operation_type || ':' || o.external_ref || ':' || r.assigned_amount, ',' ORDER BY o.id) FROM mp_reconciliation r JOIN financial_operation o ON o.id = r.financial_operation_id
     WHERE r.mp_financial_movement_id = ${MV(P_LEGACY)})`,
  `MP_SETTLEMENT:MP:MPA:T86LEGACY:SETTLE:1000000.00,MP_SETTLEMENT:MP-INBOUND-RECLASS:${P_LEGACY}:-1000000.00,TRANSFER:MP-INBOUND-TRANSFER:${P_LEGACY}:1000000.00`);
expect('C-3 MP balance unchanged by the reclassification; BNA −1000000',
  `(SELECT ((${bal(MPID)}) - b.mp)::text || '|' || ((${bal(BNA)}) - b.bna)::text FROM bal1 b)`, '0.00|-1000000.00');
expect('C-4 net assigned to the movement = its net (fully linked, nothing left as receipt)',
  `(SELECT sum(assigned_amount)::text FROM mp_reconciliation WHERE mp_financial_movement_id = ${MV(P_LEGACY)})`, '1000000.00');
expect('C-5 link row: settlement, reversal and transfer recorded, source BNA',
  `(SELECT (settlement_operation_id IS NOT NULL AND reversal_operation_id IS NOT NULL AND transfer_operation_id IS NOT NULL)::text || '|' || (source_account_id = ${BNA})::text || '|' || amount
     FROM mp_inbound_reclassification WHERE payment_id = '${P_LEGACY}')`, 'true|true|1000000.00');

// ── D. idempotency and refusals ─────────────────────────────────────────────
expect('D-1 the same reclassification again → replay, no new operation', reclass('authenticated', ADMIN, P_LEGACY), 'OK:%"replayed": true%');
expect('D-2 still exactly one TRANSFER and one RECLASS for the payment',
  `(SELECT count(*) FILTER (WHERE external_ref = 'MP-INBOUND-TRANSFER:${P_LEGACY}')::text || '|' || count(*) FILTER (WHERE external_ref = 'MP-INBOUND-RECLASS:${P_LEGACY}') FROM financial_operation)`, '1|1');
expect('D-3 the same payment from another account → refused', reclass('authenticated', ADMIN, P_LEGACY, `(SELECT id FROM financial_account WHERE nombre = 'Patagonia')`), 'ERR:ALREADY_RECLASSIFIED_FROM_ANOTHER_ACCOUNT%');
expect('D-4 a sale (money_transfer) → refused', reclass('authenticated', ADMIN, P_SALE), 'ERR:NOT_ACCOUNT_FUND%');
expect('D-5 an unknown payment → refused', reclass('authenticated', ADMIN, '861999999999'), 'ERR:PAYMENT_NOT_FOUND%');
expect('D-6 the Mercado Pago account itself as source → refused (not a bank account)', reclass('authenticated', ADMIN, P_FUND_CVU, MPID), 'ERR:SOURCE_ACCOUNT_INVALID%');
expect('D-7 OPERATOR → FORBIDDEN; anon and service_role → no EXECUTE',
  `(${reclass('authenticated', OPER, P_FUND_CVU)} || '|' || ${reclass('anon', null, P_FUND_CVU)} || '|' || ${reclass('service_role', null, P_FUND_CVU)})`,
  'ERR:FORBIDDEN%|ERR:permission denied%|ERR:permission denied%');
expect('D-8 the link table is immutable', `(pg_temp.err_of('DELETE FROM mp_inbound_reclassification') || '|' || pg_temp.err_of('UPDATE mp_inbound_reclassification SET reason = ''x'''))`, 'ERR:%|ERR:%');
expect('D-9 a reclassified movement cannot be allocated to a client (trigger)',
  `pg_temp.err_of('INSERT INTO mp_client_allocation (mp_financial_movement_id) VALUES (' || ${MV(P_LEGACY)} || ')')`, 'ERR:OWN_TRANSFER_NOT_ALLOCATABLE%');

// ── E. perimeter, P&L, totals ───────────────────────────────────────────────
expect('E-1 overall: MP +100000 (unapplied DEBIN, now via TRANSFER) +7500 +12000 (applied) ; BNA −1100000',
  `(SELECT ((${bal(MPID)}) - b.mp)::text || '|' || ((${bal(BNA)}) - b.bna)::text FROM bal0 b)`, '1119500.00|-1100000.00');
expect('E-2 P&L unaffected (no fee on these inflows; P&L never reads operations)',
  `(SELECT count(*)::text FROM mp_financial_movement m WHERE m.id IN (${MV(P_FUND_DEBIN)}, ${MV(P_LEGACY)}) AND m.fee_amount <> 0)`, '0');
expect('E-3 SECURITY DEFINER set = 80 (79 + mp_reclassify_inbound_own_transfer); the guard trigger function is INVOKER',
  `((SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)::text || '|' || (SELECT prosecdef::text FROM pg_proc WHERE proname = 'mp_own_transfer_allocation_guard'))`, '80|false');
expect('E-4 mp_reclassify_inbound_own_transfer: EXECUTE authenticated only',
  `(SELECT has_function_privilege('anon', oid, 'EXECUTE')::text || has_function_privilege('authenticated', oid, 'EXECUTE')::text || has_function_privilege('service_role', oid, 'EXECUTE')::text FROM pg_proc WHERE proname = 'mp_reclassify_inbound_own_transfer')`,
  'falsetruefalse');
expect('E-5 link table: RLS on, ADMIN SELECT policy, no write privilege for API roles',
  `((SELECT relrowsecurity FROM pg_class WHERE relname = 'mp_inbound_reclassification')
     AND NOT has_table_privilege('authenticated', 'mp_inbound_reclassification', 'INSERT,UPDATE,DELETE')
     AND NOT has_table_privilege('service_role', 'mp_inbound_reclassification', 'SELECT,INSERT,UPDATE,DELETE'))::text`, 'true');
expect('E-6 cron jobs unchanged; mp_v4_verified() false',
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
console.log(`\n  ══ 0086 MP INBOUND OWN TRANSFER RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
