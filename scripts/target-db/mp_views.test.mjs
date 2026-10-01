#!/usr/bin/env node
/**
 * ADR-006 Step 10 — the three derived views (0055): report_mp_receipt_status, report_mp_delivery_health,
 * report_mp_report_exceptions. Gate cases C-1, C-16, R-7, M-2, F-3a, F-5 plus the axis-separation,
 * cardinality and privilege checks.
 *
 * Run:  TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *         node scripts/target-db/mp_views.test.mjs
 *
 * Authority: ADR006_IDEMPOTENCY_AND_STATE_V1 §2.3; ADR006_SCHEMA_DELTA_V1 §9; ADR-006 §6.4 / §8a;
 * ADR006_TEST_MATRIX_V1 C-1, C-16, R-7, M-2, F-3a, F-5.
 * Receipts are built through the real service path (S1 register, S2 claim, S4 snapshot, RPC 40, A1, C2,
 * S3 transitions) exactly as the worker drives it; no MP API is contacted. Report-match rows are
 * owner-inserted: the report payment path stays DEFERRED_V4 while mp_v4_verified() is false (Step 19),
 * so MATCHED / DISCREPANCY rows for a payment cannot be produced by RPC 40 yet.
 * Synthetic ids only: payments 7777…, chargebacks 7778…, clients 'S10V …'.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

function resolveDockerBin() {
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  if (existsSync(c)) return c;
  throw new Error('docker not found');
}
const DOCKER = resolveDockerBin();
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPA = '22222222-2222-2222-2222-222222222222';
const COLLECTOR = '100000001';
const VIEWS = ['report_mp_delivery_health', 'report_mp_receipt_status', 'report_mp_report_exceptions'];
let pass = 0;
let fail = 0;
const failures = [];
const PSQL = ['psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
let container;
function raw(sqlText) {
  const r = spawnSync(DOCKER, ['exec', '-i', container, ...PSQL], { encoding: 'utf8', input: sqlText, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function owner(s) { const r = raw(s); if (!r.ok) throw new Error(`owner SQL failed:\n${s}\n${r.err}`); return r.out; }
const esc = (s) => String(s).replace(/'/g, "''");
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(v)}'`);
const wrap = (role, claims, s) => `BEGIN;\nSET LOCAL ROLE ${role};\nSET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';\n${s}\nCOMMIT;`;
const ANON = (s) => raw(wrap('anon', { role: 'anon' }, s));
const OPER = (s) => raw(wrap('authenticated', { sub: OPA, role: 'authenticated' }, s));
const ADMIN = (s) => raw(wrap('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s));
const SVC = (s) => raw(wrap('service_role', { role: 'service_role' }, s));
function json(fn, call) {
  const r = fn(`SELECT (${call})::text;`);
  if (!r.ok) throw new Error(`call failed: ${call}\n${r.err}`);
  return r.out === '' ? null : JSON.parse(r.out);
}
const svc = (call) => json(SVC, call);
const errLine = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || '').slice(0, 160);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
function check(label, condition, detail) {
  if (condition) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; failures.push(label); console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}
const section = (n, t) => console.log(`\n  ── ${n}. ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);

// ── guard, container ─────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
container = (spawnSync(DOCKER, ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container'); process.exit(1); }
const mapping = (spawnSync(DOCKER, ['port', container, '5432/tcp'], { encoding: 'utf8' }).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }

function cleanup() {
  owner(`
UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha = '2026-11-01' AND status <> 'OPEN';
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:7777%' OR external_id LIKE 'S10V-%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op  AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '7777%' OR resource_id LIKE '7778%';
CREATE TEMP TABLE _al  AS SELECT id, client_ledger_id FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _fl  AS SELECT id FROM mp_attribution_flag WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _mt  AS SELECT id FROM mp_report_match WHERE report_source_id IN (SELECT id FROM _src)
  OR transition_id IN (SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv));
CREATE TEMP TABLE _cl  AS SELECT id FROM clients WHERE nombre LIKE 'S10V %';
DELETE FROM audit_events WHERE (entity_type = 'mp_client_allocation' AND entity_id IN (SELECT id::TEXT FROM _al))
   OR (entity_type = 'mp_attribution_flag' AND entity_id IN (SELECT id::TEXT FROM _fl))
   OR (entity_type = 'mp_report_match' AND entity_id IN (SELECT id::TEXT FROM _mt))
   OR (entity_type = 'mp_source_record' AND entity_id IN (SELECT id::TEXT FROM _src))
   OR (entity_type = 'mp_financial_movement' AND entity_id IN (SELECT id::TEXT FROM _mv))
   OR (entity_type = 'mp_webhook_delivery' AND entity_id IN (SELECT id::TEXT FROM _dl))
   OR (action = 'MP_DELIVERY_REQUEUE' AND reason LIKE 'S10V%');
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al);
DELETE FROM client_ledger WHERE id IN (SELECT client_ledger_id FROM _al);
DELETE FROM mp_attribution_flag WHERE id IN (SELECT id FROM _fl);
DELETE FROM mp_report_match WHERE id IN (SELECT id FROM _mt);
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE triggered_by_delivery_id IN (SELECT id FROM _dl) OR key_conflict_of IN (SELECT id FROM _dl);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
DELETE FROM clients WHERE id IN (SELECT id FROM _cl);`);
}
cleanup();
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPA}', false, false) ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPA}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;`);

// ── the worker's DB path, driven step by step as service_role ─────────────────
let seq = 0;
const newPid = () => `7777${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;
function payload(pid, { status = 'approved', detail = 'accredited', extref = null, refunds = [] } = {}) {
  const at = '2026-11-05T10:00:00.000-04:00';
  return { id: Number(pid), operation_type: 'money_transfer', status, status_detail: detail, currency_id: 'ARS', live_mode: true,
    collector_id: Number(COLLECTOR), payer: { id: '800000999' }, external_reference: extref, date_created: at, date_approved: at,
    transaction_amount: 100, transaction_details: { net_received_amount: 93 }, fee_details: [{ type: 'mercadopago_fee', amount: 5, fee_payer: 'collector' }],
    refunds, transaction_amount_refunded: refunds.reduce((s, r) => s + r.amount, 0), taxes_amount: 0, charges_details: [] };
}
const register = (pid) => svc(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, NULL, 'S10V', ${q(JSON.stringify({ notification_id: `s10v-${pid}-${++seq}` }))}::jsonb, true)`).delivery_id;
function claim(d) {
  const rows = JSON.parse(SVC(`SELECT coalesce(json_agg(c), '[]')::text FROM mp_claim_deliveries(50, 120) c;`).out);
  const c = rows.find((x) => x.delivery_id === d);
  if (!c) throw new Error(`delivery ${d} not claimed`);
  return c.claim_token;
}
const transition = (d, tok, outcome, o = {}) => svc(`mp_delivery_transition(${q(d)}, ${q(tok)}, ${q(outcome)}, ${q(o.src ?? null)}, ${q(o.code ?? null)}, ${q(o.detail ?? null)}, NULL, ${q(o.link ?? null)})`);
/** fetch + snapshot + normalize (+ A1 + C2) + FETCHED for one delivery; `apply: false` stops before A1 */
function processDelivery(d, pid, body, { apply = true } = {}) {
  const tok = claim(d);
  const src = svc(`mp_ingest_api_snapshot(${q(d)}, ${q(tok)}, ${q(pid)}, ${q(JSON.stringify(body))}::jsonb)`);
  if (src.processing_status === 'PENDING') svc(`mp_normalize_source(${q(src.source_record_id)})`);
  const mv = owner(`SELECT coalesce(max(m.id)::text, '') FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
    WHERE t.resource_type = 'payment' AND t.resource_id = ${q(pid)} AND t.transition = 'APPROVAL';`);
  if (apply && mv && owner(`SELECT count(*) FROM mp_reconciliation WHERE mp_financial_movement_id = ${mv};`) === '0') {
    svc(`mp_apply_transition(${mv})`);
    svc(`mp_auto_allocate(${mv})`);
  }
  transition(d, tok, 'FETCHED', { src: src.source_record_id });
  return { src: src.source_record_id, mv: mv ? Number(mv) : null };
}
function receipt(opts = {}) {
  const pid = newPid();
  const d = register(pid);
  const r = processDelivery(d, pid, payload(pid, opts), opts);
  const tId = Number(owner(`SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id = ${r.mv};`));
  return { pid, d, mv: r.mv, src: r.src, tId };
}
const row = (mv) => { const r = ADMIN(`SELECT row_to_json(v)::text FROM report_mp_receipt_status v WHERE mp_financial_movement_id = ${mv};`); return r.ok && r.out ? JSON.parse(r.out) : null; };
const rowCount = (mv) => ADMIN(`SELECT count(*) FROM report_mp_receipt_status WHERE mp_financial_movement_id = ${mv};`).out;
const health = () => JSON.parse(ADMIN(`SELECT row_to_json(h)::text FROM report_mp_delivery_health h;`).out);
const exceptions = () => JSON.parse(ADMIN(`SELECT coalesce(json_agg(e), '[]')::text FROM report_mp_report_exceptions e;`).out);
const money = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting), (SELECT count(*) FROM mp_financial_movement),
  (SELECT count(*) FROM mp_reconciliation), (SELECT count(*) FROM collections), (SELECT count(*) FROM client_ledger));`);
const B_STATES = ['CLIENT_UNASSIGNED', 'CLIENT_PARTIAL', 'CLIENT_ASSIGNED', 'CLIENT_RESOLUTION_REQUESTED'];
const isWorkItem = (r) => r.axis_a_state === 'REVIEW_REQUIRED' || r.axis_b_state === 'CLIENT_RESOLUTION_REQUESTED'
  || exceptions().some((e) => e.mp_financial_movement_id === r.mp_financial_movement_id);
const reportSource = () => owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processed_at)
  VALUES ('csv_import', 'S10V-${Date.now()}-${++seq}:payment:C', '{"fixture":"owner report row"}'::jsonb, '2026-11-05T12:00:00-03:00', '2026-11-05', 'IGNORED', NOW()) RETURNING id;`);
const due = owner(`SELECT count(*) FROM mp_webhook_delivery WHERE status IN ('RECEIVED', 'FAILED_RETRYABLE') AND next_attempt_at <= NOW() + INTERVAL '1 day'
  AND coalesce(resource_id, '') NOT LIKE '7777%' AND coalesce(resource_id, '') NOT LIKE '7778%';`);
check('S0 no foreign due deliveries (claims see only this suite rows)', due === '0', due);
const CLI = owner(`INSERT INTO clients (nombre, activo) VALUES ('S10V client ${Date.now()}', true) RETURNING id;`);

// ═════════════════════════════════════════════════════════════════════════════
section('V', 'definitions and privileges');
{
  check('V-1 the three views exist, owned by postgres, with security_invoker = true',
    owner(`SELECT string_agg(c.relname || ':' || pg_get_userbyid(c.relowner) || ':' || (c.reloptions @> ARRAY['security_invoker=true']), ',' ORDER BY c.relname)
      FROM pg_class c WHERE c.relkind = 'v' AND c.relnamespace = 'public'::regnamespace AND c.relname IN (${VIEWS.map(q).join(',')});`)
      === VIEWS.map((v) => `${v}:postgres:true`).join(','));
  check('V-2 privileges: SELECT for authenticated only; nothing for anon, service_role or PUBLIC; no write privilege',
    owner(`SELECT string_agg(c.relname || ':' || coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY c.relname, 2, 3)
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE c.relname IN (${VIEWS.map(q).join(',')}) AND (a.grantee = 0 OR r.rolname IN ('anon','authenticated','service_role'));`)
      === VIEWS.map((v) => `${v}:authenticated:SELECT`).join(','));
  check('V-3 receipt-status columns carry both axes separately (axis_a_state, review_reasons / axis_b_state, open_flag) and no combined status',
    owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'report_mp_receipt_status';`)
      === 'mp_financial_movement_id,transition_id,payment_id,mp_source_record_id,source_type,source_processing_status,latest_snapshot_status,occurred_date,gross_amount,fee_amount,tax_amount,net_amount,assigned_amount,report_matched,axis_a_state,review_reasons,effective_applied_receipt,unapplied_reversal_count,unapplied_reversal_amount,active_attributed,axis_b_state,open_flag,open_flag_id');
  check('V-4 no view definition references an attribution state as a review reason, and no "reconciled / pending" wording on axis B',
    owner(`SELECT count(*) FROM pg_views WHERE viewname IN (${VIEWS.map(q).join(',')})
      AND (definition ~ 'CLIENT_[A-Z_]+''::text[^,]*review' OR definition ~* 'CLIENT_(RECONCILED|UNRECONCILED|PENDING)');`) === '0');
  check('V-5 SECURITY DEFINER set unchanged by the views: exactly 63 (60 + ADR-007 RPCs 44 / 45 + ADR-011 RPC 46; no function added for the views)',
    owner(`SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`) === '63');
}

// ═════════════════════════════════════════════════════════════════════════════
section('C', 'axis B — client attribution (C-1, C-16)');
const R1 = receipt();
{
  const r = row(R1.mv);
  check('C-1 anonymous Feria receipt (POSTED, no allocation): axis A POSTED; axis B CLIENT_UNASSIGNED; no review reason; not a work item; not in the exceptions view',
    r && r.axis_a_state === 'POSTED' && r.axis_b_state === 'CLIENT_UNASSIGNED' && r.review_reasons.length === 0 && Number(r.active_attributed) === 0
      && Number(r.effective_applied_receipt) === 100 && !isWorkItem(r), JSON.stringify(r));
  check('C-1b health view: FETCHED delivery counted; no review_required from a receipt without a client', health().review_required === false, JSON.stringify(health()));
  const rs = reportSource();
  owner(`INSERT INTO mp_report_match (outcome, report_source_id, transition_id, detail, is_exception) VALUES ('MATCHED', ${q(rs)}, ${R1.tId}, '{}'::jsonb, false);`);
  const r2 = row(R1.mv);
  check('C-1c REPORT_CONFIRMED + CLIENT_UNASSIGNED is a valid combination (MATCHED report evidence, no client): no review reason, not a work item',
    r2.axis_a_state === 'REPORT_CONFIRMED' && r2.report_matched === true && r2.axis_b_state === 'CLIENT_UNASSIGNED' && r2.review_reasons.length === 0 && !isWorkItem(r2), JSON.stringify(r2));
}
{
  const R = receipt();
  const occ = owner(`SELECT occurred_date FROM mp_financial_movement WHERE id = ${R.mv};`);
  const fl = json(ADMIN, `mp_flag_for_attribution(${R.mv}, 'S10V who paid?')`);
  const r = row(R.mv);
  check('C-16a open attribution flag → axis B CLIENT_RESOLUTION_REQUESTED (the only attribution work item); axis A stays POSTED (axis B raises no review reason)',
    r.axis_b_state === 'CLIENT_RESOLUTION_REQUESTED' && r.open_flag === true && r.axis_a_state === 'POSTED' && r.review_reasons.length === 0, JSON.stringify(r) + JSON.stringify(fl));
  json(ADMIN, `mp_allocate_to_client(${R.mv}, ${q(CLI)}, 40, ${q(occ)}, 'S10V-part-${R.pid}', 'S10V partial')`);
  const rp = row(R.mv);
  check('C-16b partial allocation while flagged → still CLIENT_RESOLUTION_REQUESTED (active 40 < effective 100); flag still open',
    rp.axis_b_state === 'CLIENT_RESOLUTION_REQUESTED' && Number(rp.active_attributed) === 40 && rp.open_flag === true, JSON.stringify(rp));
  json(ADMIN, `mp_allocate_to_client(${R.mv}, ${q(CLI)}, 60, ${q(occ)}, 'S10V-rest-${R.pid}', 'S10V rest')`);
  const rf = row(R.mv);
  check('C-16c full allocation auto-clears the flag (clear_reason FULLY_ASSIGNED) → CLIENT_ASSIGNED, open_flag false, axis A unchanged (POSTED)',
    rf.axis_b_state === 'CLIENT_ASSIGNED' && rf.open_flag === false && Number(rf.active_attributed) === 100 && rf.axis_a_state === 'POSTED'
      && owner(`SELECT clear_reason FROM mp_attribution_flag WHERE mp_financial_movement_id = ${R.mv};`) === 'FULLY_ASSIGNED', JSON.stringify(rf));
  check('C-16d cardinality: two allocations + one flag + their audit rows → still exactly one view row for the movement', rowCount(R.mv) === '1');
}
{
  const R = receipt();
  const occ = owner(`SELECT occurred_date FROM mp_financial_movement WHERE id = ${R.mv};`);
  json(ADMIN, `mp_allocate_to_client(${R.mv}, ${q(CLI)}, 30, ${q(occ)}, 'S10V-p-${R.pid}', 'S10V partial, no flag')`);
  const r = row(R.mv);
  check('C-17 partial allocation without a flag → CLIENT_PARTIAL; not a work item; axis A POSTED', r.axis_b_state === 'CLIENT_PARTIAL' && r.axis_a_state === 'POSTED' && !isWorkItem(r), JSON.stringify(r));
  const A = receipt({ extref: `GST:C:${CLI}` });
  const ra = row(A.mv);
  check('C-18 AUTO attribution (C2 with GST:C evidence) → CLIENT_ASSIGNED (active = effective receipt = 100)', ra.axis_b_state === 'CLIENT_ASSIGNED' && Number(ra.active_attributed) === 100, JSON.stringify(ra));
}

// ═════════════════════════════════════════════════════════════════════════════
section('R', 'chargeback / mediation alerts (R-7) and the signal refresh');
{
  const R = receipt();
  const before = money();
  const d2 = register(R.pid);
  processDelivery(d2, R.pid, payload(R.pid, { status: 'charged_back', detail: 'reimbursed' }));
  const r = row(R.mv);
  check('R-7 API snapshot status charged_back on a posted payment → no new movement / operation / posting / ledger row; axis A REVIEW_REQUIRED with CHARGEBACK_ALERT; axis B unchanged',
    money() === before && r.axis_a_state === 'REVIEW_REQUIRED' && r.review_reasons.join() === 'CHARGEBACK_ALERT' && r.latest_snapshot_status === 'charged_back'
      && r.axis_b_state === 'CLIENT_UNASSIGNED' && Number(r.effective_applied_receipt) === 100, `${money()} vs ${before} ${JSON.stringify(r)}`);
  const d3 = register(R.pid);
  processDelivery(d3, R.pid, payload(R.pid));
  check('R-7b a later snapshot resolved in favour (approved again) → the alert clears (the current resource decides) → POSTED', row(R.mv).axis_a_state === 'POSTED', JSON.stringify(row(R.mv)));
  const M = receipt();
  processDelivery(register(M.pid), M.pid, payload(M.pid, { status: 'in_mediation', detail: 'pending' }));
  const rm = row(M.mv);
  check('R-7c status in_mediation → REVIEW_REQUIRED with MEDIATION_ALERT; no financial effect', rm.axis_a_state === 'REVIEW_REQUIRED' && rm.review_reasons.join() === 'MEDIATION_ALERT', JSON.stringify(rm));
}
{
  const R = receipt();
  const cbId = `7778${String(Date.now()).slice(-8)}`;
  const sig = svc(`mp_register_delivery('webhook', 'topic_chargebacks_wh', 'chargeback', NULL, ${q(cbId)}, NULL, 'S10V-cb',
    ${q(JSON.stringify({ type: 'topic_chargebacks_wh', data_id: cbId, live_mode: true, user_id: Number(COLLECTOR), notification_id: `s10v-cb-${cbId}` }))}::jsonb, true)`).delivery_id;
  const before = money();
  const h0 = health();
  transition(sig, claim(sig), 'SIGNAL_RECORDED', { link: R.pid });
  const r = row(R.mv);
  check('R-12v linked chargeback signal whose payment refresh is not yet FETCHED → REVIEW_REQUIRED (CHARGEBACK_SIGNAL_REFRESH_PENDING); no financial effect',
    r.axis_a_state === 'REVIEW_REQUIRED' && r.review_reasons.join() === 'CHARGEBACK_SIGNAL_REFRESH_PENDING' && money() === before, JSON.stringify(r));
  const refresh = owner(`SELECT id FROM mp_webhook_delivery WHERE triggered_by_delivery_id = ${q(sig)};`);
  processDelivery(refresh, R.pid, payload(R.pid));
  check('R-12w after the refresh is FETCHED and the current resource is approved → the reason clears → POSTED; the signal stays LINKED (not unresolved in health)',
    row(R.mv).axis_a_state === 'POSTED' && health().unresolved_chargeback_signals === h0.unresolved_chargeback_signals, JSON.stringify(row(R.mv)));
  const cb2 = `7778${String(Date.now()).slice(-7)}9`;
  const un = svc(`mp_register_delivery('webhook', 'topic_chargebacks_wh', 'chargeback', NULL, ${q(cb2)}, NULL, 'S10V-cb2',
    ${q(JSON.stringify({ type: 'topic_chargebacks_wh', data_id: cb2, live_mode: true, user_id: Number(COLLECTOR), notification_id: `s10v-cb-${cb2}` }))}::jsonb, true)`).delivery_id;
  transition(un, claim(un), 'SIGNAL_RECORDED');
  const h1 = health();
  check('R-13v an unresolved (unlinked) chargeback signal → health unresolved_chargeback_signals +1 and review_required', h1.unresolved_chargeback_signals === h0.unresolved_chargeback_signals + 1
    && h1.review_required === true, JSON.stringify(h1));
  json(ADMIN, `mp_resolve_chargeback_signal(${q(un)}, 'DISMISSED', NULL, 'S10V no money moved')`);
  check('R-13w dismissed by the ADMIN → no longer unresolved', health().unresolved_chargeback_signals === h0.unresolved_chargeback_signals);
}

// ═════════════════════════════════════════════════════════════════════════════
section('M', 'report exceptions (M-2)');
{
  const R = receipt();
  const rs = reportSource();
  const before = money();
  const matchId = owner(`INSERT INTO mp_report_match (outcome, report_source_id, transition_id, detail, is_exception)
    VALUES ('DISCREPANCY', ${q(rs)}, ${R.tId}, '{"fee": {"report": -6, "recorded": -5}}'::jsonb, true) RETURNING id;`);
  const ex = exceptions().filter((e) => e.match_id === matchId);
  const r = row(R.mv);
  check('M-2 open DISCREPANCY → listed once in report_mp_report_exceptions with the authoritative detail, transition and movement; no financial write',
    ex.length === 1 && ex[0].outcome === 'DISCREPANCY' && ex[0].detail.fee.report === -6 && ex[0].detail.fee.recorded === -5 && Object.keys(ex[0].detail).join() === 'fee'
      && ex[0].transition_id === R.tId && ex[0].mp_financial_movement_id === R.mv && ex[0].resource_id === R.pid && ex[0].axis_a_state === 'REVIEW_REQUIRED'
      && money() === before, JSON.stringify(ex));
  check('M-2b the receipt: axis A REVIEW_REQUIRED (REPORT_EXCEPTION); axis B unaffected (CLIENT_UNASSIGNED)', r.axis_a_state === 'REVIEW_REQUIRED'
    && r.review_reasons.join() === 'REPORT_EXCEPTION' && r.axis_b_state === 'CLIENT_UNASSIGNED', JSON.stringify(r));
  const corr = ADMIN(`SELECT mp_resolve_match(${q(matchId)}, 'CORRECTED', 'S10V no correction');`);
  json(ADMIN, `mp_resolve_match(${q(matchId)}, 'EXPLAINED', 'S10V explained by MP support')`);
  check('M-2c CORRECTED without an RPC 41 correction → NO_CORRECTION_FOUND; EXPLAINED resolves it → gone from the exceptions view; axis A back to POSTED',
    /NO_CORRECTION_FOUND/.test(corr.err) && exceptions().every((e) => e.match_id !== matchId) && row(R.mv).axis_a_state === 'POSTED', errLine(corr));
  const rsZero = reportSource();
  const rsDiff = reportSource();
  owner(`INSERT INTO mp_report_match (outcome, report_source_id, detail, is_exception) VALUES ('BALANCE_CHECK', ${q(rsZero)}, '{"difference": "0.00"}'::jsonb, false),
    ('BALANCE_CHECK', ${q(rsDiff)}, '{"difference": "-1.50"}'::jsonb, true);`);
  const bal = exceptions().filter((e) => e.report_source_id === rsZero || e.report_source_id === rsDiff);
  check('M-2d a BALANCE_CHECK with a non-zero difference is an exception (listed, no transition); a zero difference is not',
    bal.length === 1 && bal[0].report_source_id === rsDiff && bal[0].outcome === 'BALANCE_CHECK' && bal[0].transition_id === null, JSON.stringify(bal));
}

// ═════════════════════════════════════════════════════════════════════════════
section('F', 'delivery health (F-3a, F-5) and stuck application');
{
  const R = receipt();
  const h0 = health();
  const before = money();
  const d = register(R.pid);
  transition(d, claim(d), 'CONFIG_BLOCKED', { code: 'AUTH_CONFIGURATION_ERROR', detail: 'http 401' });
  const never = newPid();
  const dn = register(never);
  transition(dn, claim(dn), 'CONFIG_BLOCKED', { code: 'AUTH_CONFIGURATION_ERROR', detail: 'http 401' });
  const h = health();
  const r = row(R.mv);
  check('F-3a CONFIG_BLOCKED (401) → health auth_configuration_error = true, config_blocked_count +2, config_blocked_oldest set, review_required; no financial effect',
    h.auth_configuration_error === true && h.config_blocked_count === h0.config_blocked_count + 2 && h.config_blocked_oldest !== null && h.review_required === true
      && money() === before, JSON.stringify(h));
  check('F-3a(b) the known payment: axis A REVIEW_REQUIRED (DELIVERY_CONFIG_BLOCKED); a never-fetched payment has no receipt row (nothing invented) but is counted in health',
    r.axis_a_state === 'REVIEW_REQUIRED' && r.review_reasons.join() === 'DELIVERY_CONFIG_BLOCKED'
      && ADMIN(`SELECT count(*) FROM report_mp_receipt_status WHERE payment_id = ${q(never)};`).out === '0'
      && owner(`SELECT count(*) FROM mp_source_record WHERE external_id LIKE 'MPPAY:${never}:%';`) === '0', JSON.stringify(r));
  json(ADMIN, `mp_requeue_config_blocked('S10V credential fixed')`);
  processDelivery(d, R.pid, payload(R.pid));
  // the requeue released both blocked rows; the claim above took dn too — let its lease lapse
  owner(`UPDATE mp_webhook_delivery SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = ${q(dn)} AND status = 'PROCESSING';`);
  const tokN = claim(dn);
  transition(dn, tokN, 'PERMANENT', { code: 'MP_BAD_REQUEST', detail: 'http 400' });
  check('F-3a(c) after requeue + a later FETCHED the reason clears (POSTED); auth_configuration_error back to false',
    row(R.mv).axis_a_state === 'POSTED' && health().auth_configuration_error === (h0.config_blocked_count > 0), JSON.stringify(row(R.mv)) + JSON.stringify(health()));
}
{
  const R = receipt();
  const h0 = health();
  const before = money();
  const d = register(R.pid);
  transition(d, claim(d), 'RETRY', { code: 'MP_UNAVAILABLE', detail: 'http 503' });
  owner(`UPDATE mp_webhook_delivery SET first_failed_at = NOW() - INTERVAL '49 hours', next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ${q(d)};`);
  transition(d, claim(d), 'RETRY', { code: 'MP_UNAVAILABLE', detail: 'http 503' });
  const st = owner(`SELECT status FROM mp_webhook_delivery WHERE id = ${q(d)};`);
  const h = health();
  const r = row(R.mv);
  check('F-5 transient failures beyond 48 h → FAILED_PERMANENT; health failed_permanent_count +1 with the error code; review_required',
    st === 'FAILED_PERMANENT' && h.failed_permanent_count === h0.failed_permanent_count + 1
      && (h.failed_permanent_by_error_code.MP_UNAVAILABLE ?? 0) === (h0.failed_permanent_by_error_code.MP_UNAVAILABLE ?? 0) + 1 && h.review_required === true, `${st} ${JSON.stringify(h)}`);
  check('F-5b the payment: axis A REVIEW_REQUIRED (DELIVERY_FAILED_PERMANENT); no source / movement / posting invented', r.axis_a_state === 'REVIEW_REQUIRED'
    && r.review_reasons.join() === 'DELIVERY_FAILED_PERMANENT' && money() === before, JSON.stringify(r));
}
{
  const pid = newPid();
  const d = register(pid);
  const p = processDelivery(d, pid, payload(pid), { apply: false });
  const r0 = row(p.mv);
  owner(`UPDATE mp_financial_movement SET created_at = NOW() - INTERVAL '16 minutes' WHERE id = ${p.mv};`);
  const r1 = row(p.mv);
  svc(`mp_apply_transition(${p.mv})`);
  check('A-stuck movement without application: NORMALIZED while fresh; REVIEW_REQUIRED (APPLICATION_STUCK) after 15 min; POSTED once A1 commits',
    r0.axis_a_state === 'NORMALIZED' && r1.axis_a_state === 'REVIEW_REQUIRED' && r1.review_reasons.join() === 'APPLICATION_STUCK' && row(p.mv).axis_a_state === 'POSTED',
    `${JSON.stringify(r0)} ${JSON.stringify(r1)}`);
  const R = receipt();
  processDelivery(register(R.pid), R.pid, payload(R.pid, { refunds: [{ id: 1, amount: 10 }] }));
  const re = row(R.mv);
  check('A-error a later snapshot rejected by RPC 40 (refund evidence → ERROR, refunds deferred) → REVIEW_REQUIRED (SOURCE_ERROR); axis B unchanged',
    re.axis_a_state === 'REVIEW_REQUIRED' && re.review_reasons.join() === 'SOURCE_ERROR' && re.latest_snapshot_status === 'approved' && re.axis_b_state === 'CLIENT_UNASSIGNED', JSON.stringify(re));
}

// ═════════════════════════════════════════════════════════════════════════════
section('X', 'axis separation, cardinality, exact counts');
{
  const all = JSON.parse(ADMIN(`SELECT coalesce(json_agg(v), '[]')::text FROM report_mp_receipt_status v;`).out);
  check('X-1 one row per payment / APPROVAL movement: view rows = distinct APPROVAL payment movements (no multiplication by deliveries, snapshots, allocations, matches, audits)',
    all.length === Number(owner(`SELECT count(*) FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id WHERE m.movement_kind = 'payment' AND t.transition = 'APPROVAL';`))
      && new Set(all.map((r) => r.mp_financial_movement_id)).size === all.length, String(all.length));
  check('X-2 axis B never produces a review reason: every reason is an axis-A reason; every axis_b_state is one of the four attribution states',
    all.every((r) => r.review_reasons.every((x) => !x.startsWith('CLIENT_')) && B_STATES.includes(r.axis_b_state)));
  // each axis-B state with a non-review axis A is proven case by case: C-1 (UNASSIGNED), C-16a (RESOLUTION_REQUESTED),
  // C-17 (PARTIAL), C-18 (ASSIGNED) — all POSTED
  check('X-3 axis A is REVIEW_REQUIRED exactly when an axis-A review reason exists',
    all.every((r) => (r.axis_a_state === 'REVIEW_REQUIRED') === (r.review_reasons.length > 0)));
  check('X-4 current scope: no REFUND / CHARGEBACK movement exists, so effective_applied_receipt = gross and no UNAPPLIED_REVERSAL anywhere',
    all.every((r) => Number(r.unapplied_reversal_count) === 0 && Number(r.effective_applied_receipt) === Number(r.gross_amount) && !r.review_reasons.includes('UNAPPLIED_REVERSAL')));
  check('X-5 invariant 0 ≤ active_attributed ≤ effective_applied_receipt on every row', all.every((r) => Number(r.active_attributed) >= 0 && Number(r.active_attributed) <= Number(r.effective_applied_receipt)));
  const h = health();
  const exact = JSON.parse(owner(`SELECT json_build_object('total', count(*), 'received', count(*) FILTER (WHERE status = 'RECEIVED'), 'processing', count(*) FILTER (WHERE status = 'PROCESSING'),
    'fetched', count(*) FILTER (WHERE status = 'FETCHED'), 'signal', count(*) FILTER (WHERE status = 'SIGNAL_RECORDED'), 'retry', count(*) FILTER (WHERE status = 'FAILED_RETRYABLE'),
    'failed', count(*) FILTER (WHERE status = 'FAILED_PERMANENT'), 'blocked', count(*) FILTER (WHERE status = 'CONFIG_BLOCKED'), 'unsupported', count(*) FILTER (WHERE status = 'UNSUPPORTED'),
    'conflicts', count(*) FILTER (WHERE key_conflict_of IS NOT NULL))::text FROM mp_webhook_delivery;`));
  check('X-6 health counts equal direct per-status counts of mp_webhook_delivery (one row per delivery; no join multiplication); statuses sum to the total',
    h.total_deliveries === exact.total && h.received_count === exact.received && h.processing_count === exact.processing && h.fetched_count === exact.fetched
      && h.signal_recorded_count === exact.signal && h.failed_retryable_count === exact.retry && h.failed_permanent_count === exact.failed
      && h.config_blocked_count === exact.blocked && h.unsupported_count === exact.unsupported && h.key_conflicts === exact.conflicts
      && h.received_count + h.processing_count + h.fetched_count + h.signal_recorded_count + h.failed_retryable_count + h.failed_permanent_count
        + h.config_blocked_count + h.unsupported_count === h.total_deliveries, `${JSON.stringify(h)} ${JSON.stringify(exact)}`);
  check('X-7 exceptions view = unresolved is_exception matches exactly (one row per match)', exceptions().length === Number(owner(`SELECT count(*) FROM mp_report_match WHERE is_exception AND resolution IS NULL;`)));
}

// ═════════════════════════════════════════════════════════════════════════════
section('S', 'row exposure per actor');
{
  const an = VIEWS.map((v) => [v, ANON(`SELECT count(*) FROM ${v};`)]);
  check('S-1v anon: SELECT on each view → permission denied', an.every(([, r]) => denied(r)), an.map(([v, r]) => `${v}:${errLine(r)}`).join(' | '));
  const op = VIEWS.map((v) => [v, OPER(`SELECT count(*) FROM ${v};`)]);
  check('S-2v OPERATOR: 0 rows in each view (the health summary row included); no MP exposure', op.every(([, r]) => r.ok && r.out === '0'), op.map(([v, r]) => `${v}=${r.ok ? r.out : errLine(r)}`).join(' '));
  const ad = VIEWS.map((v) => [v, ADMIN(`SELECT count(*) FROM ${v};`)]);
  check('S-3v ADMIN: receipts and exceptions visible; exactly one health row', ad.every(([, r]) => r.ok) && ad[0][1].out === '1' && Number(ad[1][1].out) > 0 && Number(ad[2][1].out) > 0,
    ad.map(([v, r]) => `${v}=${r.ok ? r.out : errLine(r)}`).join(' '));
  const sv = VIEWS.map((v) => [v, SVC(`SELECT count(*) FROM ${v};`)]);
  check('S-4v service_role: SELECT on each view → permission denied (the backend never reads the views)', sv.every(([, r]) => denied(r)), sv.map(([v, r]) => `${v}:${errLine(r)}`).join(' | '));
}

cleanup();
console.log(`\n  ══ MP VIEWS (STEP 10) RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail) console.log(failures.map((f) => `   - ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
