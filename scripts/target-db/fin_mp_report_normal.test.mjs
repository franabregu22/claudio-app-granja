#!/usr/bin/env node
/**
 * ADR-018 §9.1 / §10 / §15 — MP RELEASE REPORT NORMAL MODE + REPORT BACK-FILL (migration 0079). LOCAL TEST DATABASE ONLY.
 *
 * End to end against the local database: fin_ingest_mp_release_report → mp_source_record (csv_import) → RPC 40 (unchanged)
 * → mp_register_report_backfill → the REAL worker core (supabase/functions/_shared/mp-worker-core.ts, psql adapter, mock
 * Mercado Pago API, no network) → S4 → RPC 40 → claim → A1. Proves: one back-fill per inbound payment, replay and
 * re-download idempotency, report-first / webhook-first / both-queued races with ONE claim and ONE set of postings,
 * pre-cutover rows as evidence only, yield applied by A1 per the frozen auto-applicable pair (and isolated when A1
 * refuses), payout and outbound payments without money, NORMAL fail closed, VALIDATION unchanged, the coverage view,
 * and the privilege perimeter.
 *
 * The scenario of the real 2026-10-04 row (G-4 evidence): payment / SOURCE_ID 181403811707 / gross 50.00 / net 49.70 /
 * available_money / account_money, 20:36:11 −03:00. Every other id is synthetic (7779…). Rows are committed (the worker
 * runs across transactions) and removed by the cleanup, before and after; immutable evidence rows of THIS suite are
 * removed with session_replication_role = replica (local test database only).
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_mp_report_normal.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';
import { runWorker } from '../../supabase/functions/_shared/mp-worker-core.ts';

globalThis.fetch = () => { throw new Error('REAL_NETWORK_CALL_ATTEMPTED'); };

function resolveDockerBin() {
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  if (existsSync(c)) return c;
  throw new Error('docker not found');
}
const DOCKER = resolveDockerBin();
const ADMIN_ID = 'aaaaaaaa-0079-0000-0000-00000000000a';
const OPER_ID = 'aaaaaaaa-0079-0000-0000-00000000000b';
const COLLECTOR = '100000001';
const REAL = '181403811707';
const PARSER = 'mp-release-report-csv/1.0.0';
const FORMAT = 'MP_RELEASE_REPORT_CSV_V1';
const PSQL = ['psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
let container;
let pass = 0;
let fail = 0;
function raw(sqlText) {
  const r = spawnSync(DOCKER, ['exec', '-i', container, ...PSQL], { encoding: 'utf8', input: sqlText, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function owner(s) { const r = raw(s); if (!r.ok) throw new Error(`owner SQL failed:\n${s.slice(0, 400)}\n${r.err}`); return r.out; }
const esc = (s) => String(s).replace(/'/g, "''");
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(v)}'`);
const j = (o) => `${q(JSON.stringify(o))}::jsonb`;
const wrap = (role, claims, s) => `BEGIN;\nSET LOCAL ROLE ${role};\nSET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';\n${s}\nCOMMIT;`;
const SVC = (s) => raw(wrap('service_role', { role: 'service_role' }, s));
const AUTH = (uid, s) => raw(wrap('authenticated', { sub: uid, role: 'authenticated' }, s));
class DbError extends Error {}
function svcJson(call) {
  const r = SVC(`SELECT (${call})::text;`);
  if (!r.ok) throw new DbError((r.err.split('\n').find((l) => /ERROR:/.test(l)) ?? r.err).replace(/^.*ERROR:\s+/, ''));
  return r.out === '' ? null : JSON.parse(r.out);
}
function svcRows(sql) {
  const r = SVC(`SELECT coalesce(json_agg(x), '[]')::text FROM (${sql}) x;`);
  if (!r.ok) throw new DbError(r.err);
  return JSON.parse(r.out);
}
const errOf = (fn) => { try { fn(); return 'OK'; } catch (e) { return `ERR:${e.message}`; } };
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${String(detail).slice(0, 400)}` : ''}`); }
}
const section = (n, t) => console.log(`\n  ── ${n}. ${t}`);

// ── guard, container ─────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
container = (spawnSync(DOCKER, ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container'); process.exit(1); }
const mapping = (spawnSync(DOCKER, ['port', container, '5432/tcp'], { encoding: 'utf8' }).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
const CUT = owner(`SELECT to_char(cutover_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM mp_cutover_boundary;`);
if (!CUT || !(Date.parse(CUT) < Date.parse('2026-10-04T23:00:00Z')) || !(Date.parse(CUT) > Date.parse('2026-09-30T23:00:00Z'))) {
  console.error(`  this suite needs a local mp_cutover_boundary between 2026-10-01 and 2026-10-04 (found ${CUT || 'none'})`); process.exit(1);
}

// ── synthetic Liberaciones rows ──────────────────────────────────────────────
const EMPTY = { BALANCE_AMOUNT: '', BUSINESS_UNIT: '', DATE: '', DESCRIPTION: '', GROSS_AMOUNT: '', MP_FEE_AMOUNT: '', NET_CREDIT_AMOUNT: '',
  NET_DEBIT_AMOUNT: '', PAYMENT_METHOD: '', PAYMENT_METHOD_TYPE: '', PURCHASE_ID: '', SOURCE_ID: '', SUB_UNIT: '', TAXES_AMOUNT: '', TRANSACTION_APPROVAL_DATE: '' };
const mv = (at, sid, desc, credit, debit, gross, tax, method = 'available_money', type = 'account_money') => ({
  ...EMPTY, DATE: at, SOURCE_ID: sid, DESCRIPTION: desc, NET_CREDIT_AMOUNT: credit, NET_DEBIT_AMOUNT: debit, GROSS_AMOUNT: gross,
  MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: tax, PAYMENT_METHOD: method, TRANSACTION_APPROVAL_DATE: at, BALANCE_AMOUNT: '1000.00', PAYMENT_METHOD_TYPE: type });
const ctl = (at) => ({ ...EMPTY, DATE: at, NET_CREDIT_AMOUNT: '0.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '0.00', MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '0.00' });
const D4 = (t) => `2026-10-04T${t}.000-03:00`;
const REAL_ROW = mv(D4('20:36:11'), REAL, 'payment', '49.70', '0.00', '50.00', '-0.30');          // the G-4 row
const YIELD_ROW = mv(D4('03:10:00'), '777900000001', 'asset_management', '12.34', '0.00', '12.34', '0.00', '', '');
const PAYOUT_ROW = mv(D4('11:00:01'), '777900000002', 'payout', '0.00', '200.00', '-200.00', '0.00', 'available_money', '');
const RES_D = mv(D4('11:00:00'), '777900000002', 'reserve_for_payout', '0.00', '200.00', '-200.00', '0.00', 'available_money', '');
const RES_C = mv(D4('11:00:01'), '777900000002', 'reserve_for_payout', '200.00', '0.00', '200.00', '0.00', 'available_money', '');
const OUT_ROW = mv(D4('12:00:00'), '777900000003', 'payment', '0.00', '500.00', '-500.00', '0.00');   // outbound (direction D)
const PRE_ROW = mv('2026-10-01T10:00:00.000-03:00', '777900000004', 'payment', '99.40', '0.00', '100.00', '-0.60');
const REPORT_1 = [ctl('2026-10-04T00:00:00.000-03:00'), YIELD_ROW, RES_D, RES_C, PAYOUT_ROW, OUT_ROW, REAL_ROW, PRE_ROW, ctl('')];   // last row: the totals CONTROL row (DATE empty, amounts present)
const rowsOf = (raws) => raws.map((raw_row, i) => ({ row_number: i + 1, raw_row }));
const sha = (seed) => createHash('sha256').update(`ADR018-0079-${seed}`).digest('hex');
const SEEDS = ['r1', 'r1-redownload', 'webhook-first', 'race', 'reject', 'pre-only', 'validation', 'closed-yield', 'auth'];
const MPACC = owner(`SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE';`);
const ingestCall = (seed, rows, { parser = PARSER, actor = ADMIN_ID, fn = 'fin_ingest_mp_release_report', format = FORMAT, reject = null } = {}) =>
  `${fn}(${q(actor)}::uuid, ${q(parser)}, ${q(format)}, ${q(sha(seed))}, ${q(`mp/${MPACC}/${sha(seed)}.csv`)}, 'release-report.csv', 2048,
    '2026-10-04'::date, '2026-10-04'::date, ${j({ report_type: 'release_report', test: seed })}, ${q(reject)}, ${rows === null ? 'NULL' : j(rowsOf(rows))})`;
const ingest = (seed, rows, o) => svcJson(ingestCall(seed, rows, o));

// ── worker: real core, psql adapter as service_role, mock MP API ─────────────
const realDb = {
  async claimDeliveries(limit, lease) { return svcRows(`SELECT * FROM mp_claim_deliveries(${limit}, ${lease})`); },
  async transition(d, t, outcome, o = {}) {
    return svcJson(`mp_delivery_transition(${q(d)}, ${q(t)}, ${q(outcome)}, ${q(o.sourceRecordId ?? null)}, ${q(o.errorCode ?? null)}, ${q(o.errorDetail ?? null)}, ${o.retryAfterSeconds ?? 'NULL'}, ${q(o.linkPaymentId ?? null)})`);
  },
  async ingestSnapshot(d, t, pid, payload) { return svcJson(`mp_ingest_api_snapshot(${q(d)}, ${q(t)}, ${q(pid)}, ${j(payload)})`); },
  async normalizeSource(id) { return svcJson(`mp_normalize_source(${q(id)})`); },
  async paymentMovements(pid) {
    return svcRows(`SELECT m.id AS movement_id, m.movement_kind, m.net_amount::float8 AS net_amount,
        coalesce((SELECT sum(r.assigned_amount) FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id), 0)::float8 AS assigned_amount
      FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id
      WHERE s.source_type = 'api_payment' AND s.external_id LIKE 'MPPAY:${pid}:%'`);
  },
  async applyTransition(id) { return svcJson(`mp_apply_transition(${id})`); },
  async autoAllocate(id) { return svcJson(`mp_auto_allocate(${id})`); },
  async chargebackPaymentRef() { return null; },
  async oldestConfigBlocked() { return null; },
  async requeueConfigBlocked(reason) { return svcJson(`mp_requeue_config_blocked(${q(reason)})`); },
  async pendingApiSources() { return []; },
  async unappliedMovements() { return []; },
  async postedPaymentMovements() { return []; },
};
const mpRequests = [];
const payments = new Map();
const mpApi = {
  async getPayment(pid) {
    mpRequests.push(pid);
    if (!payments.has(pid)) throw new Error(`UNEXPECTED_MP_REQUEST ${pid}`);
    return { status: 200, body: payments.get(pid), retryAfter: null };
  },
};
function approved(pid, gross, net, at) {
  return { id: Number(pid), operation_type: 'money_transfer', status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true,
    collector_id: Number(COLLECTOR), payer: { id: '800000999' }, external_reference: null, date_created: at, date_approved: at, date_last_updated: at,
    transaction_amount: gross, transaction_details: { net_received_amount: net }, taxes_amount: 0, charges_details: [], fee_details: [],
    refunds: [], transaction_amount_refunded: 0 };
}
const NOON = Date.parse('2026-11-15T15:00:00Z');
const worker = () => runWorker({ db: realDb, mpApi, clock: { now: () => NOON }, log: () => {}, config: { collectorId: COLLECTOR },
  state: { lastProbeAt: NOON, lastSweepLocalDate: '2026-11-15' } });
let nseq = 0;
const webhook = (pid) => svcJson(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, NULL, 'T0079', ${j({ notification_id: `t0079-${++nseq}-${Date.now()}` })}, true)`);

// ── counts ───────────────────────────────────────────────────────────────────
const n = (s) => Number(owner(s));
const approvals = (pid) => n(`SELECT count(*) FROM mp_transition_identity WHERE resource_type = 'payment' AND resource_id = '${pid}' AND transition = 'APPROVAL';`);
const settlements = (pid) => n(`SELECT count(*) FROM financial_operation o JOIN mp_reconciliation r ON r.financial_operation_id = o.id
  JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id
 WHERE s.external_id LIKE 'MPPAY:${pid}:%' AND o.operation_type = 'MP_SETTLEMENT';`);
const postingsOf = (pid) => n(`SELECT count(*) FROM financial_posting p JOIN mp_reconciliation r ON r.financial_operation_id = p.financial_operation_id
  JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${pid}:%';`);
const backfills = (pid) => n(`SELECT count(*) FROM mp_webhook_delivery WHERE origin = 'report_backfill' AND resource_id = '${pid}';`);
const activity = (pid, desc) => owner(`SELECT string_agg(DISTINCT v.coverage_status, ',') FROM (SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN_ID}","role":"authenticated"}', true)) c,
  LATERAL (SELECT * FROM fin_mp_report_activity) v WHERE v.source_id = '${pid}' ${desc ? `AND v.description = '${desc}'` : ''};`);
const FIN_TABLES = ['financial_operation', 'financial_posting', 'mp_source_record', 'mp_transition_identity', 'mp_webhook_delivery', 'mp_reconciliation', 'mp_financial_movement', 'mp_report_match'];
const snapshot = () => owner(`SELECT string_agg(c::text, '|') FROM (${FIN_TABLES.map((t) => `SELECT count(*) AS c FROM ${t}`).join(' UNION ALL ')}) x;`);

function cleanup() {
  owner(`
SET session_replication_role = replica;
UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha = '2026-12-01' AND status <> 'OPEN';
CREATE TEMP TABLE _runs AS SELECT id FROM fin_import_run WHERE file_sha256 IN (${SEEDS.map((s) => q(sha(s))).join(', ')});
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record
 WHERE external_id LIKE '${REAL}:%' OR external_id LIKE '7779%' OR external_id LIKE 'MPPAY:${REAL}:%' OR external_id LIKE 'MPPAY:7779%';
CREATE TEMP TABLE _mv AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl AS SELECT id FROM mp_webhook_delivery WHERE resource_id = '${REAL}' OR resource_id LIKE '7779%';
DELETE FROM fin_import_run_line WHERE run_id IN (SELECT id FROM _runs);
DELETE FROM fin_import_run WHERE id IN (SELECT id FROM _runs);
DELETE FROM audit_events WHERE entity_id IN (SELECT id::TEXT FROM _src UNION ALL SELECT id::TEXT FROM _mv UNION ALL SELECT id::TEXT FROM _dl UNION ALL SELECT id::TEXT FROM _op);
DELETE FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_attribution_flag WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_report_match WHERE report_source_id IN (SELECT id FROM _src);
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
DELETE FROM perfiles WHERE id IN ('${ADMIN_ID}', '${OPER_ID}');
SET session_replication_role = origin;`);
}

// ═════════════════════════════════════════════════════════════════════════════
cleanup();
owner(`INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN_ID}', 'adr018-0079-admin@test.local', 'ADMIN'), ('${OPER_ID}', 'adr018-0079-oper@test.local', 'OPERATOR');`);
check('S0 no foreign MP deliveries in the local queue (the worker must only see this suite)', n(`SELECT count(*) FROM mp_webhook_delivery;`) === 0);
const BASE = snapshot();

section('A', 'NORMAL ingestion of the 04/10 report (report first)');
let r1;
try { r1 = ingest('r1', REPORT_1); } catch (e) { r1 = { error: e.message }; }
check('A-1 PARSED: 9 rows, 7 new movement rows, 2 control rows, 0 invalid', r1.status === 'PARSED' && r1.rows_total === 9 && r1.lines_new === 7 && r1.rows_ignored === 2 && r1.rows_invalid === 0, JSON.stringify(r1));
check('A-2 exactly one back-fill created (the inbound post-cutover payment only)', r1.backfills_created === 1 && backfills(REAL) === 1 && backfills('777900000003') === 0 && backfills('777900000004') === 0, JSON.stringify(r1));
check('A-3 back-fill delivery: origin report_backfill, key report:payment:<SOURCE_ID>, RECEIVED, linked to the report row',
  owner(`SELECT d.delivery_key || '|' || d.status || '|' || d.topic_class || '|' || (s.external_id = '${REAL}:payment:C') FROM mp_webhook_delivery d JOIN mp_source_record s ON s.id = d.report_source_id WHERE d.resource_id = '${REAL}';`)
    === `report:payment:${REAL}|RECEIVED|payment|true`);
check('A-4 the back-fill links to the appearance through the same report row',
  n(`SELECT count(*) FROM fin_import_run_line l JOIN mp_webhook_delivery d ON d.report_source_id = l.mp_source_record_id WHERE l.run_id = '${r1.run_id}';`) === 1);
check('A-5 no payment money from the report row: 0 APPROVAL claims, 0 settlements, payment row parked DEFERRED_V4',
  approvals(REAL) === 0 && settlements(REAL) === 0
    && owner(`SELECT processing_status || ':' || split_part(processing_note, ':', 1) FROM mp_source_record WHERE external_id = '${REAL}:payment:C';`) === 'PENDING:DEFERRED_V4');
check('A-6 pre-cutover row: IGNORED (ADR-017), no back-fill, no movement',
  owner(`SELECT processing_status || ':' || split_part(processing_note, ':', 1) FROM mp_source_record WHERE external_id = '777900000004:payment:C';`) === 'IGNORED:PRE_CUTOVER_INCLUDED_IN_OPENING_BALANCE'
    && n(`SELECT count(*) FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE '777900000004:%';`) === 0);
check('A-7 yield: claimed (report / YIELD) and applied by A1 exactly once (frozen auto-applicable pair)',
  r1.yields_applied === 1 && n(`SELECT count(*) FROM mp_transition_identity WHERE resource_type = 'report' AND resource_id = '777900000001:asset_management:C' AND transition = 'YIELD';`) === 1
    && n(`SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id = '777900000001:asset_management:C';`) === 1);
check('A-8 payout: movement + REPORT_ONLY, never applied (no reconciliation, no operation)',
  n(`SELECT count(*) FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id = '777900000002:payout:D' AND m.movement_kind = 'transfer';`) === 1
    && n(`SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id = '777900000002:payout:D';`) === 0);
check('A-9 outbound payment: parked DEFERRED_V4, no back-fill, no movement (V-4 open)',
  owner(`SELECT processing_status || ':' || split_part(processing_note, ':', 1) FROM mp_source_record WHERE external_id = '777900000003:payment:D';`) === 'PENDING:DEFERRED_V4');
check('A-10 reserves IGNORED (RESERVE_ROW)', n(`SELECT count(*) FROM mp_source_record WHERE external_id LIKE '777900000002:reserve_for_payout:%' AND processing_status = 'IGNORED';`) === 2);
check('A-11 mp_v4_verified() stays false', owner(`SELECT mp_v4_verified();`) === 'f');

section('B', 'coverage view before the worker');
check('B-1 statuses: payment BACKFILL_PENDING, yield YIELD, payout PAYOUT, reserves RESERVE, outbound OUTBOUND, pre-cutover PRE_CUTOVER',
  activity(REAL) === 'BACKFILL_PENDING' && activity('777900000001') === 'YIELD' && activity('777900000002', 'payout') === 'PAYOUT'
    && activity('777900000002', 'reserve_for_payout') === 'RESERVE' && activity('777900000003') === 'OUTBOUND' && activity('777900000004') === 'PRE_CUTOVER',
  [activity(REAL), activity('777900000001'), activity('777900000002', 'payout'), activity('777900000003'), activity('777900000004')].join(' '));
check('B-2 control rows CONTROL (2), no amount', owner(`SELECT count(*) || ':' || count(net_amount) FROM (SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN_ID}","role":"authenticated"}', true)) c,
  LATERAL (SELECT * FROM fin_mp_report_activity WHERE run_id = '${r1.run_id}' AND coverage_status = 'CONTROL') v;`) === '2:0');
check('B-3 yield row carries its applied financial operation', owner(`SELECT (financial_operation_id IS NOT NULL)::text FROM (SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN_ID}","role":"authenticated"}', true)) c,
  LATERAL (SELECT * FROM fin_mp_report_activity WHERE source_id = '777900000001') v;`) === 'true');
check('B-4 OPERATOR sees nothing; anon cannot read', AUTH(OPER_ID, `SELECT count(*) FROM fin_mp_report_activity;`).out.split('\n').pop() === '0'
  && !raw(wrap('anon', { role: 'anon' }, 'SELECT count(*) FROM fin_mp_report_activity;')).ok);

section('C', 'idempotency of the report');
const again = ingest('r1', REPORT_1);
check('C-1 same file again → replay of the same run; no new source, delivery or money', again.replayed === true && again.run_id === r1.run_id && backfills(REAL) === 1);
const before = snapshot();
const redl = ingest('r1-redownload', REPORT_1);
check('C-2 same rows in another file (re-download) → PARSED, every movement ALREADY_KNOWN, 0 new back-fills, 0 yields', redl.status === 'PARSED' && redl.lines_new === 0 && redl.lines_known === 7
  && redl.backfills_created === 0 && redl.backfills_existing === 1 && redl.yields_applied === 0, JSON.stringify(redl));
check('C-3 the re-download changes no MP / financial table', snapshot() === before, `${before} → ${snapshot()}`);
const newParser = ingest('r1', REPORT_1, { parser: 'mp-release-report-csv/1.0.1' });
check('C-4 same bytes with a new parser version → the effective NORMAL run is replayed (processed once)', newParser.replayed === true && newParser.run_id === r1.run_id);

section('D', 'worker: back-fill fetched through the unchanged circuit');
payments.set(REAL, approved(REAL, 50, 49.7, '2026-10-04T20:36:11.000-03:00'));
const w1 = await worker();
check('D-1 the worker fetched GET payment 181403811707 once and applied it', mpRequests.filter((p) => p === REAL).length === 1 && w1.fetched === 1 && w1.applied === 1, JSON.stringify(w1));
check('D-2 one APPROVAL claim, one MP_SETTLEMENT, postings settle + tax (2)', approvals(REAL) === 1 && settlements(REAL) === 1 && postingsOf(REAL) === 2, `${approvals(REAL)}/${settlements(REAL)}/${postingsOf(REAL)}`);
check('D-3 posted amounts: +50.00 settlement, −0.30 tax on the MP account', owner(`SELECT string_agg(p.signed_amount::text, ',' ORDER BY p.signed_amount) FROM financial_posting p
  JOIN mp_reconciliation r ON r.financial_operation_id = p.financial_operation_id JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id
  JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${REAL}:%' AND p.financial_account_id = '${MPACC}';`) === '-0.30,50.00');
check('D-4 back-fill delivery FETCHED; view → BACKFILL_PROCESSED with its operation', owner(`SELECT status FROM mp_webhook_delivery WHERE delivery_key = 'report:payment:${REAL}';`) === 'FETCHED'
  && activity(REAL) === 'BACKFILL_PROCESSED');
check('D-5 the report row itself stays parked (no report money)', owner(`SELECT processing_status FROM mp_source_record WHERE external_id = '${REAL}:payment:C';`) === 'PENDING');

section('E', 'webhook after the report: no double money');
webhook(REAL);
const w2 = await worker();
check('E-1 webhook delivery processed: same snapshot, no new transition', w2.fetched === 1 && w2.applied === 0 && approvals(REAL) === 1 && settlements(REAL) === 1 && postingsOf(REAL) === 2, JSON.stringify(w2));
const after = ingest('r1-redownload', REPORT_1);
check('E-2 re-ingestion after the claim: replay, still one back-fill', after.replayed === true && backfills(REAL) === 1);
check('E-3 the back-fill function refuses nothing new: ALREADY_CLAIMED', svcJson(`mp_register_report_backfill((SELECT id FROM mp_source_record WHERE external_id = '${REAL}:payment:C'))`).reason === 'ALREADY_CLAIMED');

section('F', 'webhook first, report later');
const W = '777900000010';
payments.set(W, approved(W, 80, 79.52, '2026-10-04T15:00:00.000-03:00'));
webhook(W);
await worker();
const wf = ingest('webhook-first', [ctl('2026-10-04T00:00:00.000-03:00'), mv(D4('15:00:00'), W, 'payment', '79.52', '0.00', '80.00', '-0.48')]);
check('F-1 report after the webhook: no back-fill (already claimed), view COVERED', wf.status === 'PARSED' && wf.backfills_created === 0 && backfills(W) === 0 && activity(W) === 'COVERED', JSON.stringify(wf));
check('F-2 one claim, one settlement', approvals(W) === 1 && settlements(W) === 1);

section('G', 'webhook and back-fill both queued before the worker runs');
const R = '777900000011';
payments.set(R, approved(R, 30, 29.82, '2026-10-04T16:00:00.000-03:00'));
const race = ingest('race', [ctl('2026-10-04T00:00:00.000-03:00'), mv(D4('16:00:00'), R, 'payment', '29.82', '0.00', '30.00', '-0.18')]);
webhook(R);
const wr = await worker();
check('G-1 both deliveries fetched in one run; mp_transition_identity lets exactly one claim through', race.backfills_created === 1 && wr.fetched === 2
  && approvals(R) === 1 && settlements(R) === 1 && postingsOf(R) === 2, `${JSON.stringify(wr)} ${approvals(R)}/${settlements(R)}/${postingsOf(R)}`);
check('G-2 a direct second claim attempt for the same APPROVAL is refused by the unique identity',
  errOf(() => owner(`INSERT INTO mp_transition_identity (resource_type, resource_id, transition, transition_ref, claimed_by_source_id, mp_financial_movement_id)
    SELECT resource_type, resource_id, transition, transition_ref, claimed_by_source_id, mp_financial_movement_id FROM mp_transition_identity
     WHERE resource_type = 'payment' AND resource_id = '${R}' AND transition = 'APPROVAL';`)).includes('duplicate key'));

section('H', 'fail closed, pre-cutover only, yield refused by A1, VALIDATION regression');
const srcBefore = n(`SELECT count(*) FROM mp_source_record;`);
const rej = ingest('reject', [ctl('2026-10-04T00:00:00.000-03:00'), mv(D4('17:00:00'), '777900000012', 'money_transfer', '10.00', '0.00', '10.00', '0.00')]);
check('H-1 unknown DESCRIPTION → NORMAL run REJECTED, row INVALID, nothing reaches mp_source_record', rej.status === 'REJECTED' && rej.rows_invalid === 1
  && n(`SELECT count(*) FROM mp_source_record;`) === srcBefore
  && owner(`SELECT string_agg(outcome || ':' || coalesce(split_part(note, ':', 1), '-'), ',' ORDER BY row_number) FROM fin_import_run_line WHERE run_id = '${rej.run_id}';`) === 'IGNORED:RUN_REJECTED,INVALID:UNKNOWN_DESCRIPTION');
const pre = ingest('pre-only', [ctl('2026-10-01T00:00:00.000-03:00'), mv('2026-10-01T11:00:00.000-03:00', '777900000013', 'payment', '19.88', '0.00', '20.00', '-0.12')]);
check('H-2 pre-cutover payment only: PARSED, evidence kept, 0 back-fills, PRE_CUTOVER', pre.status === 'PARSED' && pre.backfills_created === 0 && backfills('777900000013') === 0 && activity('777900000013') === 'PRE_CUTOVER');
owner(`UPDATE management_period SET status = 'CLOSED' WHERE periodo_fecha = '2026-12-01';`);
const cy = ingest('closed-yield', [ctl('2026-12-05T00:00:00.000-03:00'), mv('2026-12-05T03:10:00.000-03:00', '777900000014', 'asset_management', '5.00', '0.00', '5.00', '0.00', '', '')]);
owner(`UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha = '2026-12-01';`);
check('H-3 yield refused by A1 (period closed): ingestion still PARSED, review YIELD_NOT_APPLIED, no operation', cy.status === 'PARSED' && cy.yields_not_applied === 1
  && owner(`SELECT review_code || ':' || note FROM fin_import_run_line WHERE run_id = '${cy.run_id}' AND row_number = 2;`).startsWith('YIELD_NOT_APPLIED:PERIOD_CLOSED')
  && n(`SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE '777900000014:%';`) === 0,
  `${JSON.stringify(cy)}`);
const vBefore = snapshot();
const val = svcJson(ingestCall('validation', [ctl('2026-10-04T00:00:00.000-03:00'), mv(D4('18:00:00'), '777900000015', 'payment', '9.94', '0.00', '10.00', '-0.06')], { fn: 'fin_capture_mp_release_report' }));
check('H-4 VALIDATION (0078) unchanged: VALIDATED, CAPTURED rows, zero MP / financial effect', val.status === 'VALIDATED' && val.rows_captured === 2 && snapshot() === vBefore, JSON.stringify(val));
const norm = ingest('validation', [ctl('2026-10-04T00:00:00.000-03:00'), mv(D4('18:00:00'), '777900000015', 'payment', '9.94', '0.00', '10.00', '-0.06')]);
check('H-5 NORMAL over the validated bytes links to the VALIDATION run (previous_run_id) and requests its back-fill',
  norm.status === 'PARSED' && norm.backfills_created === 1 && owner(`SELECT (previous_run_id = '${val.run_id}')::text FROM fin_import_run WHERE id = '${norm.run_id}';`) === 'true');

section('I', 'perimeter');
check('I-1 authenticated (ADMIN) cannot call the NORMAL ingestion or the back-fill directly',
  !AUTH(ADMIN_ID, `SELECT ${ingestCall('auth', [ctl('2026-10-04T00:00:00.000-03:00')])};`).ok
    && !AUTH(ADMIN_ID, `SELECT mp_register_report_backfill(gen_random_uuid());`).ok);
check('I-2 service_role with an OPERATOR actor → FORBIDDEN', errOf(() => ingest('auth', [ctl('2026-10-04T00:00:00.000-03:00')], { actor: OPER_ID })).startsWith('ERR:FORBIDDEN'));
check('I-3 back-fill refuses outbound and pre-cutover rows', errOf(() => svcJson(`mp_register_report_backfill((SELECT id FROM mp_source_record WHERE external_id = '777900000003:payment:D'))`)).startsWith('ERR:NOT_INBOUND_REPORT_PAYMENT')
  && errOf(() => svcJson(`mp_register_report_backfill((SELECT id FROM mp_source_record WHERE external_id = '777900000004:payment:C'))`)).startsWith('ERR:NOT_ELIGIBLE'));
check('I-4 EXECUTE: both functions service_role only; view SELECT authenticated only', owner(`SELECT string_agg(proname || ':' || has_function_privilege('anon', oid, 'EXECUTE') || has_function_privilege('authenticated', oid, 'EXECUTE')
  || has_function_privilege('service_role', oid, 'EXECUTE') || prosecdef, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('fin_ingest_mp_release_report', 'mp_register_report_backfill');`) === 'fin_ingest_mp_release_report:falsefalsetruetrue,mp_register_report_backfill:falsefalsetruetrue'
  && owner(`SELECT string_agg(grantee || ':' || privilege_type, ',') FROM information_schema.role_table_grants WHERE table_name = 'fin_mp_report_activity' AND grantee IN ('anon','authenticated','service_role','PUBLIC');`) === 'authenticated:SELECT');
check('I-5 SECURITY DEFINER set = 88 (0081 scheduler log + 0083 payout destinations + 0084 payout matches + 0086 inbound reclass + 0087 payout confirm); cron = worker + 0082 daily report job + 0085 fallback; mp_register_delivery still refuses report_backfill',
  owner(`SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`) === '88'
    && owner(`SELECT string_agg(jobname, ',' ORDER BY jobname) FROM cron.job;`) === 'mp_release_report_daily,mp_release_report_daily_fallback,mp_worker_every_minute'
    && errOf(() => svcJson(`mp_register_delivery('report_backfill', 'payment', 'payment', NULL, '1', NULL, NULL, '{}'::jsonb, false)`)).includes('origin must be webhook or chargeback_refresh'));

section('K', 'financial invariants over the whole suite');
check('K-1 per payment: ≤ 1 APPROVAL claim and ≤ 1 MP_SETTLEMENT', [REAL, W, R, '777900000015'].every((p) => approvals(p) <= 1 && settlements(p) <= 1));
check('K-2 no operation / posting from any report payment row (only api_payment movements and the applied yield carry money)',
  n(`SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id
      WHERE s.source_type = 'csv_import' AND s.event_data ->> 'DESCRIPTION' = 'payment';`) === 0);
check('K-3 no money for payout, outbound or pre-cutover rows', n(`SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id
  JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id IN ('777900000002:payout:D', '777900000003:payment:D', '777900000004:payment:C', '777900000013:payment:C');`) === 0);
console.log(`\n  baseline ${BASE} → end ${snapshot()} (financial_operation|financial_posting|mp_source_record|mp_transition_identity|mp_webhook_delivery|mp_reconciliation|mp_financial_movement|mp_report_match)`);

cleanup();
check('Z cleanup restored the MP / financial tables', snapshot() === BASE, `${BASE} vs ${snapshot()}`);
console.log(`\n  ══ ADR-018 0079 NORMAL / BACKFILL RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
