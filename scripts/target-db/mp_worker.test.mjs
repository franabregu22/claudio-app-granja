#!/usr/bin/env node
/**
 * ADR-006 Step 8 — mpWorkerCore against the local database (F block, crash table, R-12 / R-14).
 *
 * Run:  TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *         node scripts/target-db/mp_worker.test.mjs
 *
 * The worker core (supabase/functions/_shared/mp-worker-core.ts) runs with:
 *   - a psql DB adapter that calls the real RPCs and performs the reads as service_role (the same calls the
 *     edge adapter makes through PostgREST), including the two mp_webhook_delivery reads that the Step-9
 *     grant (0054) enables: the chargeback notification's data_payment_id and the oldest CONFIG_BLOCKED row;
 *   - a mock Mercado Pago API (no network: globalThis.fetch is replaced by a thrower);
 *   - an injected clock and log collector.
 * Synthetic ids only: payments 7772…, chargebacks 7773…; dates 2026-11.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';
import { ensureLocalMpBoundary } from '../test-env/mp-boundary-fixture.mjs';   // ADR-017: RPC 40 needs the cutover boundary (fail safe)
import {
  runWorker, classify, parseRetryAfter, localParts, dbErrorCode, WORKER_INVOKE_HEADER, BUDGET_MS, ITEM_RESERVE_MS,
} from '../../supabase/functions/_shared/mp-worker-core.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
globalThis.fetch = () => { throw new Error('REAL_NETWORK_CALL_ATTEMPTED'); };

function resolveDockerBin() {
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  if (existsSync(c)) return c;
  throw new Error('docker not found');
}
const DOCKER = resolveDockerBin();
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const COLLECTOR = '100000001';
const FAKE_TOKEN = 'APP-TEST-FAKE-TOKEN-not-real-0000';
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
const j = (o) => `${q(JSON.stringify(o))}::jsonb`;
const wrap = (role, claims, s) => `BEGIN;\nSET LOCAL ROLE ${role};\nSET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';\n${s}\nCOMMIT;`;
const SVC = (s) => raw(wrap('service_role', { role: 'service_role' }, s));
const ADMIN = (s) => raw(wrap('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s));
function check(label, condition, detail) {
  if (condition) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; failures.push(label); console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}
const section = (n, t) => console.log(`\n  ── ${n}. ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);

// ── guard, container ─────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
ensureLocalMpBoundary();
container = (spawnSync(DOCKER, ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container'); process.exit(1); }
const mapping = (spawnSync(DOCKER, ['port', container, '5432/tcp'], { encoding: 'utf8' }).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }

// ── DB adapter (psql, service_role; two Step-9 reads as OWNER) ──────────────────
class DbError extends Error {}
function svcJson(call) {
  const r = SVC(`SELECT (${call})::text;`);
  if (!r.ok) {
    const line = r.err.split('\n').find((l) => /ERROR:/.test(l)) ?? r.err;
    throw new DbError(line.replace(/^.*ERROR:\s+/, ''));
  }
  return r.out === '' ? null : JSON.parse(r.out);
}
function svcRows(sql) {
  const r = SVC(`SELECT coalesce(json_agg(x), '[]')::text FROM (${sql}) x;`);
  if (!r.ok) throw new DbError(r.err);
  return JSON.parse(r.out);
}
const calls = [];
const realDb = {
  async claimDeliveries(limit, lease) {
    calls.push('claim');
    return svcRows(`SELECT * FROM mp_claim_deliveries(${limit}, ${lease})`);
  },
  async transition(d, t, outcome, o = {}) {
    calls.push(`transition:${outcome}`);
    return svcJson(`mp_delivery_transition(${q(d)}, ${q(t)}, ${q(outcome)}, ${q(o.sourceRecordId ?? null)}, ${q(o.errorCode ?? null)}, ${q(o.errorDetail ?? null)}, ${o.retryAfterSeconds ?? 'NULL'}, ${q(o.linkPaymentId ?? null)})`);
  },
  async ingestSnapshot(d, t, pid, payload) { calls.push('ingest'); return svcJson(`mp_ingest_api_snapshot(${q(d)}, ${q(t)}, ${q(pid)}, ${j(payload)})`); },
  async normalizeSource(id) { calls.push('normalize'); return svcJson(`mp_normalize_source(${q(id)})`); },
  async paymentMovements(pid) {
    return svcRows(`SELECT m.id AS movement_id, m.movement_kind, m.net_amount::float8 AS net_amount,
        coalesce((SELECT sum(r.assigned_amount) FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id), 0)::float8 AS assigned_amount
      FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id
      WHERE s.source_type = 'api_payment' AND s.external_id LIKE 'MPPAY:${pid}:%'`);
  },
  async applyTransition(id) { calls.push('apply'); return svcJson(`mp_apply_transition(${id})`); },
  async autoAllocate(id) { calls.push('allocate'); return svcJson(`mp_auto_allocate(${id})`); },
  async chargebackPaymentRef(d) { // service_role read (0054 grant)
    const rows = svcRows(`SELECT notification_payload->>'data_payment_id' AS v FROM mp_webhook_delivery WHERE id = ${q(d)}`);
    return rows[0]?.v ?? null;
  },
  async oldestConfigBlocked() { // service_role read (0054 grant), limited to this suite's rows
    const rows = svcRows(`SELECT resource_id FROM mp_webhook_delivery WHERE status = 'CONFIG_BLOCKED' AND topic_class = 'payment'
      AND resource_id LIKE '7772%' ORDER BY updated_at LIMIT 1`);
    return rows[0] ? { resource_id: rows[0].resource_id } : null;
  },
  async requeueConfigBlocked(reason) { calls.push('requeue'); return svcJson(`mp_requeue_config_blocked(${q(reason)})`); },
  async pendingApiSources(limit) {
    return svcRows(`SELECT id FROM mp_source_record WHERE source_type = 'api_payment' AND processing_status = 'PENDING' AND external_id LIKE 'MPPAY:7772%' ORDER BY ingested_at LIMIT ${limit}`).map((r) => r.id);
  },
  async unappliedMovements(limit) {
    return svcRows(`SELECT m.id FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id
      WHERE m.movement_kind IN ('payment', 'yield') AND s.external_id LIKE 'MPPAY:7772%'
        AND NOT EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id) ORDER BY m.id DESC LIMIT ${limit}`).map((r) => r.id);
  },
  async postedPaymentMovements(since, limit) {
    return svcRows(`SELECT m.id FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id
      WHERE m.movement_kind = 'payment' AND m.occurred_date >= '${since}' AND s.external_id LIKE 'MPPAY:7772%'
        AND m.net_amount = coalesce((SELECT sum(r.assigned_amount) FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id), 0)
      ORDER BY m.id DESC LIMIT ${limit}`).map((r) => r.id);
  },
};

// ── mock Mercado Pago API ─────────────────────────────────────────────────────
const mp = { requests: [], responses: new Map(), fallback: null };
const mpApi = {
  async getPayment(pid) {
    mp.requests.push(pid);
    const queue = mp.responses.get(pid);
    if (queue && queue.length) return queue.length > 1 ? queue.shift() : queue[0];
    if (mp.fallback) return mp.fallback(pid);
    throw new Error(`UNEXPECTED_MP_REQUEST for ${pid}`);
  },
};
const ok200 = (body) => ({ status: 200, body, retryAfter: null });
let seq = 0;
const newPid = () => `7772${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;
function paymentPayload(pid, { gross = 100, fee = 5, net = 93, status = 'approved', detail = 'accredited', day = '05', collector = COLLECTOR, extra = {} } = {}) {
  const at = `2026-11-${day}T10:00:00.000-04:00`;
  return {
    id: Number(pid), operation_type: 'money_transfer', status, status_detail: detail, currency_id: 'ARS', live_mode: true,
    collector_id: Number(collector), payer: { id: '800000999', email: 'buyer@example.invalid', first_name: 'Buyer', identification: { type: 'DNI', number: '99999999' } },
    external_reference: null, date_created: at, date_approved: status === 'approved' ? at : null, date_last_updated: at,
    transaction_amount: gross, transaction_details: { net_received_amount: net }, taxes_amount: 0, charges_details: [],
    fee_details: fee ? [{ type: 'mercadopago_fee', amount: fee, fee_payer: 'collector' }] : [], refunds: [], transaction_amount_refunded: 0, ...extra,
  };
}
let nseq = 0;
function registerPayment(pid) {
  return svcJson(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, NULL, 'S8T-x', ${j({ notification_id: `s8t-${++nseq}-${Date.now()}` })}, true)`).delivery_id;
}
function registerChargeback(cbId, paymentRef) {
  const payload = { type: 'topic_chargebacks_wh', actions: ['changed_case_status'], data_id: cbId, live_mode: true, user_id: Number(COLLECTOR), notification_id: `cb-${++nseq}-${Date.now()}` };
  if (paymentRef) payload.data_payment_id = paymentRef;
  return svcJson(`mp_register_delivery('webhook', 'topic_chargebacks_wh', 'chargeback', NULL, ${q(cbId)}, NULL, 'S8T-cb', ${j(payload)}, true)`).delivery_id;
}
const dRow = (id) => owner(`SELECT concat_ws('|', status, attempts, coalesce(last_error_code, '-'), coalesce(last_error_detail, '-'),
  round(extract(epoch FROM next_attempt_at - updated_at))::int, first_failed_at IS NOT NULL, coalesce(source_record_id::text, '-'), coalesce(signal_resolution, '-'))
  FROM mp_webhook_delivery WHERE id = ${q(id)};`).split('|');
const srcCount = (pid) => Number(owner(`SELECT count(*) FROM mp_source_record WHERE external_id LIKE 'MPPAY:${pid}:%';`));
const mvCount = (pid) => Number(owner(`SELECT count(*) FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${pid}:%';`));
const opCount = (pid) => Number(owner(`SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id
  JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${pid}:%';`));
const makeDue = (id) => owner(`UPDATE mp_webhook_delivery SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ${q(id)};`);
const expireLease = (id) => owner(`UPDATE mp_webhook_delivery SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = ${q(id)};`);

const NOON = Date.parse('2026-11-15T15:00:00Z'); // 12:00 local: outside the sweep window
let logs = [];
function deps(over = {}) {
  return {
    db: realDb, mpApi, clock: { now: () => NOON }, log: (e) => logs.push(e), config: { collectorId: COLLECTOR },
    state: { lastProbeAt: NOON, lastSweepLocalDate: '2026-11-15' }, ...over,
  };
}
const run = (over) => runWorker(deps(over));

function cleanup() {
  owner(`
UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha = '2026-11-01' AND status <> 'OPEN';
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:7772%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op  AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '7772%' OR resource_id LIKE '7773%';
CREATE TEMP TABLE _al  AS SELECT id, client_ledger_id FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _cl  AS SELECT id FROM clients WHERE nombre LIKE 'S8T-C2 %';
DELETE FROM audit_events WHERE entity_type = 'mp_client_allocation' AND entity_id IN (SELECT id::TEXT FROM _al);
DELETE FROM mp_attribution_flag WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al);
DELETE FROM client_ledger WHERE id IN (SELECT client_ledger_id FROM _al);
DELETE FROM mp_payer_client_map WHERE mp_payer_id LIKE '5557%' OR cliente_id IN (SELECT id FROM _cl);
DELETE FROM pedidos WHERE cliente_id IN (SELECT id FROM _cl);
DELETE FROM audit_events WHERE entity_type IN ('mp_source_record') AND entity_id IN (SELECT id::TEXT FROM _src);
DELETE FROM audit_events WHERE entity_type = 'mp_financial_movement' AND entity_id IN (SELECT id::TEXT FROM _mv);
DELETE FROM audit_events WHERE entity_type = 'mp_webhook_delivery' AND entity_id IN (SELECT id::TEXT FROM _dl);
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
UPDATE mp_webhook_delivery SET source_record_id = NULL WHERE id IN (SELECT id FROM _dl) AND source_record_id IS NOT NULL AND false;
DELETE FROM mp_webhook_delivery WHERE triggered_by_delivery_id IN (SELECT id FROM _dl) OR key_conflict_of IN (SELECT id FROM _dl);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
DELETE FROM clients WHERE id IN (SELECT id FROM _cl);`);
}

// ═════════════════════════════════════════════════════════════════════════════
cleanup();
const foreignDue = owner(`SELECT count(*) FROM mp_webhook_delivery WHERE status IN ('RECEIVED', 'FAILED_RETRYABLE') AND next_attempt_at <= NOW() + INTERVAL '1 day'
  AND coalesce(resource_id, '') NOT LIKE '7772%' AND coalesce(resource_id, '') NOT LIKE '7773%';`);
check('S0 no foreign due deliveries (the worker must only see this suite\'s rows)', foreignDue === '0', foreignDue);

section('U', 'pure core units (no DB)');
{
  const now = Date.parse('2026-11-15T15:00:00Z');
  const c = (r) => classify(r, now);
  check('U-1 classification table: 200 object → success; 200 array → PERMANENT MP_BAD_PAYLOAD; 401 / 403 → auth',
    c({ status: 200, body: { a: 1 } }).kind === 'success' && c({ status: 200, body: [1] }).code === 'MP_BAD_PAYLOAD'
      && c({ status: 200 }).code === 'MP_BAD_PAYLOAD' && c({ status: 401 }).kind === 'auth' && c({ status: 403 }).kind === 'auth');
  check('U-2 404 → RETRY MP_NOT_FOUND; 429 → MP_RATE_LIMIT; 500 / 503 / timeout / network → MP_UNAVAILABLE; 400 / 422 → PERMANENT MP_BAD_REQUEST',
    c({ status: 404 }).code === 'MP_NOT_FOUND' && c({ status: 429 }).code === 'MP_RATE_LIMIT' && c({ status: 500 }).code === 'MP_UNAVAILABLE'
      && c({ status: 503 }).code === 'MP_UNAVAILABLE' && c({ failure: 'timeout' }).code === 'MP_UNAVAILABLE' && c({ failure: 'network' }).code === 'MP_UNAVAILABLE'
      && c({ status: 400 }).code === 'MP_BAD_REQUEST' && c({ status: 422 }).code === 'MP_BAD_REQUEST');
  check('U-3 Retry-After: 120 → 120; 5 → 60 (clamp); 99999 → 3600 (clamp); HTTP date +300 s → 300; absent / garbage → null',
    parseRetryAfter('120', now) === 120 && parseRetryAfter('5', now) === 60 && parseRetryAfter('99999', now) === 3600
      && parseRetryAfter(new Date(now + 300_000).toUTCString(), now) === 300 && parseRetryAfter(null, now) === null && parseRetryAfter('soon', now) === null);
  check('U-4 local day part uses America/Argentina/Buenos_Aires (UTC−3): 06:05Z → 03:05 local; 02:59Z on 11-16 → 23:59 on 11-15',
    localParts(Date.parse('2026-11-16T06:05:00Z')).minuteOfDay === 185 && localParts(Date.parse('2026-11-16T02:59:00Z')).date === '2026-11-15');
  check('U-5 DB error codes are extracted from "CODE: detail" messages', dbErrorCode(new Error('CLAIM_LOST')) === 'CLAIM_LOST'
    && dbErrorCode(new Error('PERIOD_CLOSED: period 2026-11-01 is CLOSED')) === 'PERIOD_CLOSED');
  check('U-6 the invoke header constant is exactly the one mp-webhook\'s kick sends, and the kick targets /functions/v1/mp-worker',
    WORKER_INVOKE_HEADER === 'x-worker-invoke-secret'
      && readFileSync(join(REPO, 'supabase', 'functions', 'mp-webhook', 'index.ts'), 'utf8').includes("export const WORKER_INVOKE_HEADER = 'x-worker-invoke-secret';")
      && readFileSync(join(REPO, 'supabase', 'functions', 'mp-webhook', 'index.ts'), 'utf8').includes('/functions/v1/mp-worker'));
  // unsupported topic + budget (fake db)
  const fake = (claims) => {
    const t = [];
    return { t, db: { ...Object.fromEntries(Object.keys(realDb).map((k) => [k, async () => { throw new Error(`unexpected ${k}`); }])),
      claimDeliveries: async () => claims, transition: async (d, _tok, o, opts) => { t.push(`${d}:${o}:${opts?.errorCode ?? ''}`); return {}; },
      oldestConfigBlocked: async () => null, chargebackPaymentRef: async () => null } };
  };
  const f1 = fake([{ delivery_id: 'd1', claim_token: 't', origin: 'webhook', topic_class: 'unsupported', topic: 'x', resource_id: null, attempts: 1 }]);
  await runWorker({ ...deps(), db: f1.db });
  check('U-7 unsupported topic (defensive) → PERMANENT UNSUPPORTED_TOPIC, no fetch', f1.t.join() === 'd1:PERMANENT:UNSUPPORTED_TOPIC');
  const f2 = fake([1, 2, 3].map((n) => ({ delivery_id: `b${n}`, claim_token: 't', origin: 'webhook', topic_class: 'unsupported', topic: 'x', resource_id: null, attempts: 1 })));
  let tick = 0;
  const s2 = await runWorker({ ...deps(), db: f2.db, clock: { now: () => NOON + (tick++ >= 2 ? BUDGET_MS - ITEM_RESERVE_MS + 1 : 0) } });
  check('U-8 time budget: once the budget would be exceeded no new item starts; the remaining claims are RELEASEd', s2.stopped === 'budget'
    && f2.t.filter((x) => x.endsWith(':RELEASE:')).length >= 1, JSON.stringify(s2) + ' ' + f2.t.join());
}

// ═════════════════════════════════════════════════════════════════════════════
section('F', 'payment deliveries through the real RPCs');
const P1 = newPid();
{
  const d1 = registerPayment(P1);
  mp.responses.set(P1, [ok200(paymentPayload(P1))]);
  logs = [];
  const s = await run();
  const r = dRow(d1);
  check('F-1 happy path: delivery → mocked 200 → snapshot → normalize → A1 → FETCHED; 1 source, 1 movement, 3 components',
    s.fetched === 1 && s.applied === 1 && r[0] === 'FETCHED' && r[6] !== '-' && srcCount(P1) === 1 && mvCount(P1) === 1 && opCount(P1) === 3, JSON.stringify(s) + ' ' + r.join('|'));
  check('F-1b the source is RECONCILED and exactly one MP request was made', owner(`SELECT processing_status FROM mp_source_record WHERE external_id LIKE 'MPPAY:${P1}:%';`) === 'RECONCILED'
    && mp.requests.filter((x) => x === P1).length === 1);
  check('F-1c C2 auto-allocation called after posting; no evidence → NONE (CLIENT_UNASSIGNED); Δ allocation = 0',
    logs.some((l) => l.event === 'WORKER_AUTO_ALLOCATE' && l.code === 'NO_EVIDENCE')
      && owner(`SELECT count(*) FROM mp_client_allocation a JOIN mp_financial_movement m ON m.id = a.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${P1}:%';`) === '0');
  // F-2 duplicate notification for the same resource
  const d2 = registerPayment(P1);
  const s2 = await run();
  check('F-2 duplicate notification: current resource re-fetched → same hash → same source; Δ source / movement / operation = 0; FETCHED',
    s2.fetched === 1 && s2.applied === 0 && dRow(d2)[0] === 'FETCHED' && srcCount(P1) === 1 && mvCount(P1) === 1 && opCount(P1) === 3);
}
{
  // F-13 out of order: pending first, then approved, then a stale earlier notification
  const P = newPid();
  const pending = paymentPayload(P, { status: 'pending', detail: 'pending_waiting_transfer' });
  const approved = paymentPayload(P);
  mp.responses.set(P, [ok200(pending)]);
  registerPayment(P);
  await run();
  const afterPending = mvCount(P);
  mp.responses.set(P, [ok200(approved)]);
  registerPayment(P);
  await run();
  registerPayment(P); // the older "created" notification arrives last; the current resource is fetched again
  await run();
  check('F-13 out-of-order notifications: each fetch reads the current resource; pending → no movement; approved → APPROVAL once; stale re-delivery → same hash, Δ = 0',
    afterPending === 0 && srcCount(P) === 2 && mvCount(P) === 1 && opCount(P) === 3, `${afterPending} ${srcCount(P)} ${mvCount(P)} ${opCount(P)}`);
}
{
  // F-3a / F-3b / F-3c: auth failures and the circuit breaker
  const ids = [newPid(), newPid(), newPid(), newPid(), newPid()];
  const ds = ids.map((p) => registerPayment(p));
  const attemptsBefore = ds.map((d) => dRow(d)[1]);
  mp.requests.length = 0;
  mp.fallback = () => ({ status: 401, body: { message: 'unauthorized' } });
  logs = [];
  const s = await run();
  const rows = ds.map(dRow);
  const blocked = rows.filter((r) => r[0] === 'CONFIG_BLOCKED');
  const released = rows.filter((r) => r[0] === 'RECEIVED');
  check('F-3a / F-3c first delivery 401 → CONFIG_BLOCKED (AUTH_CONFIGURATION_ERROR, http 401); the other 4 RELEASEd back to RECEIVED with attempts unchanged; stop; exactly 1 MP request',
    s.stopped === 'auth_circuit_breaker' && blocked.length === 1 && blocked[0][2] === 'AUTH_CONFIGURATION_ERROR' && blocked[0][3] === 'http 401'
      && released.length === 4 && mp.requests.length === 1 && s.released === 4
      && rows.every((r, i) => r[0] === 'CONFIG_BLOCKED' || r[1] === attemptsBefore[i]), JSON.stringify(s) + ' ' + rows.map((r) => r.slice(0, 3).join(':')).join(' '));
  const blockedPid = ids[rows.findIndex((r) => r[0] === 'CONFIG_BLOCKED')];
  check('F-3a no source / movement / operation for the blocked payment; error log MP_AUTH_CONFIGURATION_ERROR with delivery_id + http_status only',
    srcCount(blockedPid) === 0 && logs.some((l) => l.event === 'MP_AUTH_CONFIGURATION_ERROR' && l.http_status === 401 && Object.keys(l).every((k) => ['event', 'delivery_id', 'http_status'].includes(k))));
  // F-3d: no hot retry — further runs never claim the CONFIG_BLOCKED row
  mp.fallback = (pid) => ({ status: 403, body: {} });
  mp.requests.length = 0;
  const s3 = await run(); // claims the 4 released rows: the first gets 403 → CONFIG_BLOCKED, 3 released
  const blockedNow = ds.map(dRow).filter((r) => r[0] === 'CONFIG_BLOCKED');
  check('F-3b 403 → CONFIG_BLOCKED detail http 403 (circuit breaker again: 1 request)', s3.stopped === 'auth_circuit_breaker' && mp.requests.length === 1
    && blockedNow.length === 2 && blockedNow.some((r) => r[3] === 'http 403'));
  for (let k = 0; k < 3; k++) await run(); // drain the rest into CONFIG_BLOCKED
  mp.requests.length = 0;
  for (let k = 0; k < 5; k++) await run();
  owner(`UPDATE mp_webhook_delivery SET updated_at = NOW() - INTERVAL '72 hours', first_failed_at = NOW() - INTERVAL '72 hours' WHERE id IN (${ds.map(q).join(',')});`);
  await run();
  check('F-3d CONFIG_BLOCKED rows are never claimed again (0 MP requests over further runs) and never age into FAILED_PERMANENT (simulated 72 h)',
    mp.requests.length === 0 && ds.map(dRow).every((r) => r[0] === 'CONFIG_BLOCKED'));
  // F-3f: automatic probe (fresh state → one probe; 200 → requeue)
  mp.fallback = null;
  mp.requests.length = 0;
  for (const p of ids) mp.responses.set(p, [ok200(paymentPayload(p))]);
  const auditBefore = Number(owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE';`));
  const sp = await runWorker(deps({ state: { lastSweepLocalDate: '2026-11-15' } }));
  const audits = owner(`SELECT '1|' || (performed_by IS NULL) || '|' || coalesce(reason, '-') FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE' ORDER BY id DESC LIMIT 1;`).split('|');
  check('F-3f probe: exactly one probe request; 200 → mp_requeue_config_blocked (actor NULL, reason "auto: credential probe succeeded"); the requeued rows are then processed → FETCHED',
    sp.probe === 'requeued' && Number(owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE';`)) === auditBefore + 1
      && audits[1] === 'true' && audits[2] === 'auto: credential probe succeeded' && ds.map(dRow).every((r) => r[0] === 'FETCHED'),
    JSON.stringify(sp) + ' ' + audits.join('|') + ' ' + ds.map((d) => dRow(d)[0]).join(','));
  // F-3e / F-3g: requeue while still broken → back to CONFIG_BLOCKED with attempts +1; then fixed → FETCHED once
  const P = newPid();
  const d = registerPayment(P);
  mp.responses.set(P, [{ status: 401, body: {} }]);
  await run();
  const a1 = Number(dRow(d)[1]);
  ADMIN(`SELECT mp_requeue_config_blocked('token rotated (still wrong)');`);
  await run();
  const a2 = Number(dRow(d)[1]);
  check('F-3g requeue while the credential is still broken → CONFIG_BLOCKED again, attempts +1; Δ source = 0', dRow(d)[0] === 'CONFIG_BLOCKED' && a2 === a1 + 1 && srcCount(P) === 0, `${a1} ${a2}`);
  mp.responses.set(P, [ok200(paymentPayload(P))]);
  const rq = JSON.parse(ADMIN(`SELECT mp_requeue_config_blocked('token rotated')::text;`).out);
  await run();
  const rq2 = JSON.parse(ADMIN(`SELECT mp_requeue_config_blocked('again')::text;`).out);
  check('F-3e ADMIN requeue after the fix → RECEIVED → next pass FETCHED; 1 source, 1 movement, 3 operations; a second requeue → {requeued: 0}',
    rq.requeued >= 1 && dRow(d)[0] === 'FETCHED' && srcCount(P) === 1 && mvCount(P) === 1 && opCount(P) === 3 && rq2.requeued === 0, JSON.stringify(rq) + JSON.stringify(rq2));
}
{
  // transient classes + retry schedule
  const cases = [
    ['F-1(matrix) timeout → RETRY MP_UNAVAILABLE, attempts 1, next +60 s, first_failed_at set', { failure: 'timeout' }, 'MP_UNAVAILABLE', 60],
    ['network error → RETRY MP_UNAVAILABLE', { failure: 'network' }, 'MP_UNAVAILABLE', 60],
    ['500 → RETRY MP_UNAVAILABLE', { status: 500, body: {} }, 'MP_UNAVAILABLE', 60],
    ['F-4a 404 → RETRY MP_NOT_FOUND', { status: 404, body: {} }, 'MP_NOT_FOUND', 60],
    ['F-2(matrix) 429 Retry-After 120 → next +120 s, MP_RATE_LIMIT', { status: 429, retryAfter: '120', body: {} }, 'MP_RATE_LIMIT', 120],
    ['429 Retry-After 5 → clamped to 60 s', { status: 429, retryAfter: '5', body: {} }, 'MP_RATE_LIMIT', 60],
    ['429 Retry-After 99999 → clamped to 3600 s', { status: 429, retryAfter: '99999', body: {} }, 'MP_RATE_LIMIT', 3600],
  ];
  for (const [label, resp, code, secs] of cases) {
    const P = newPid();
    const d = registerPayment(P);
    mp.responses.set(P, [resp]);
    await run();
    const r = dRow(d);
    check(label, r[0] === 'FAILED_RETRYABLE' && r[1] === '1' && r[2] === code && Math.abs(Number(r[4]) - secs) <= 2 && r[5] === 't' && srcCount(P) === 0, r.join('|'));
  }
  // schedule 1, 2, 4, 8, 16, 32, then 60 min
  const P = newPid();
  const d = registerPayment(P);
  mp.responses.set(P, [{ status: 503, body: {} }]);
  const delays = [];
  for (let k = 0; k < 8; k++) {
    makeDue(d);
    await run();
    delays.push(Math.round(Number(dRow(d)[4]) / 60));
  }
  check('retry schedule after attempts 1..8: 1, 2, 4, 8, 16, 32, 60, 60 min', delays.join(',') === '1,2,4,8,16,32,60,60', delays.join(','));
  // F-5 48 h exhaustion
  owner(`UPDATE mp_webhook_delivery SET first_failed_at = NOW() - INTERVAL '49 hours' WHERE id = ${q(d)};`);
  makeDue(d);
  await run();
  check('F-5 transient failure beyond the 48 h internal horizon → FAILED_PERMANENT', dRow(d)[0] === 'FAILED_PERMANENT', dRow(d).join('|'));
  // F-4b 404 then 200
  const P4 = newPid();
  const d4 = registerPayment(P4);
  mp.responses.set(P4, [{ status: 404, body: {} }, ok200(paymentPayload(P4))]);
  await run();
  makeDue(d4);
  await run();
  check('F-4 404 then 200 → first RETRY, then FETCHED; exactly one source', dRow(d4)[0] === 'FETCHED' && srcCount(P4) === 1 && mvCount(P4) === 1);
}
{
  const perm = [
    ['F-6 400 → FAILED_PERMANENT MP_BAD_REQUEST immediately', { status: 400, body: {} }, 'MP_BAD_REQUEST'],
    ['422 → FAILED_PERMANENT MP_BAD_REQUEST', { status: 422, body: {} }, 'MP_BAD_REQUEST'],
    ['200 with a non-object JSON body → FAILED_PERMANENT MP_BAD_PAYLOAD', { status: 200, body: [1, 2] }, 'MP_BAD_PAYLOAD'],
  ];
  for (const [label, resp, code] of perm) {
    const P = newPid();
    const d = registerPayment(P);
    mp.responses.set(P, [resp]);
    await run();
    check(label, dRow(d)[0] === 'FAILED_PERMANENT' && dRow(d)[2] === code && srcCount(P) === 0, dRow(d).join('|'));
  }
  const Pc = newPid();
  const dc = registerPayment(Pc);
  mp.responses.set(Pc, [ok200(paymentPayload(Pc, { collector: '100000002' }))]);
  logs = [];
  await run();
  check('F-7 collector mismatch → FAILED_PERMANENT COLLECTOR_MISMATCH before any snapshot (Δ source = 0); security log', dRow(dc)[0] === 'FAILED_PERMANENT'
    && dRow(dc)[2] === 'COLLECTOR_MISMATCH' && srcCount(Pc) === 0 && !calls.slice(-3).includes('ingest') && logs.some((l) => l.event === 'SECURITY_COLLECTOR_MISMATCH'));
  const Pi = newPid();
  const di = registerPayment(Pi);
  mp.responses.set(Pi, [ok200({ ...paymentPayload(Pi), id: Number(Pi) + 1 })]);
  await run();
  check('payload id ≠ resource id → FAILED_PERMANENT PAYLOAD_ID_MISMATCH before any snapshot (Δ source = 0)',
    dRow(di)[0] === 'FAILED_PERMANENT' && dRow(di)[2] === 'PAYLOAD_ID_MISMATCH' && srcCount(Pi) === 0 && srcCount(String(Number(Pi) + 1)) === 0);
  // source ERROR behaviour: refund evidence → normalization ERROR; delivery still FETCHED; no movement
  const Pr = newPid();
  const dr = registerPayment(Pr);
  mp.responses.set(Pr, [ok200(paymentPayload(Pr, { extra: { refunds: [{ id: 1, amount: 10 }], transaction_amount_refunded: 10 } }))]);
  await run();
  check('source ERROR (refund evidence → REFUND_UNSUPPORTED) → delivery FETCHED; the ERROR source is review evidence; no movement, no hot retry',
    dRow(dr)[0] === 'FETCHED' && owner(`SELECT processing_status || '|' || split_part(processing_note, ':', 1) FROM mp_source_record WHERE external_id LIKE 'MPPAY:${Pr}:%';`) === 'ERROR|REFUND_UNSUPPORTED'
      && mvCount(Pr) === 0);
}

// ═════════════════════════════════════════════════════════════════════════════
section('X', 'crash table and stale worker');
{
  const claimOnly = (d) => realDb.claimDeliveries(20, 120).then((rows) => rows.find((r) => r.delivery_id === d));
  // F-8 crash after S2
  const P8 = newPid();
  const d8 = registerPayment(P8);
  mp.responses.set(P8, [ok200(paymentPayload(P8))]);
  const c8 = await claimOnly(d8);
  expireLease(d8);
  await run();
  check('F-8 crash after the claim: lease expires → re-claim → FETCHED; 1 source, 1 movement, 3 operations', c8 && dRow(d8)[0] === 'FETCHED' && srcCount(P8) === 1 && opCount(P8) === 3);
  // F-9 crash after S4
  const P9 = newPid();
  const d9 = registerPayment(P9);
  mp.responses.set(P9, [ok200(paymentPayload(P9))]);
  const c9 = await claimOnly(d9);
  await realDb.ingestSnapshot(c9.delivery_id, c9.claim_token, P9, paymentPayload(P9));
  expireLease(d9);
  await run();
  check('F-9 crash after the snapshot: next pass → same hash, same source; RPC 40 then A1; totals as F-8', dRow(d9)[0] === 'FETCHED' && srcCount(P9) === 1 && mvCount(P9) === 1 && opCount(P9) === 3);
  // crash after RPC 40, before A1
  const Pn = newPid();
  const dn = registerPayment(Pn);
  mp.responses.set(Pn, [ok200(paymentPayload(Pn))]);
  const cn = await claimOnly(dn);
  const sn = await realDb.ingestSnapshot(cn.delivery_id, cn.claim_token, Pn, paymentPayload(Pn));
  await realDb.normalizeSource(sn.source_record_id);
  const guard = ADMIN(`SELECT mp_reconcile_movement((SELECT m.id FROM mp_financial_movement m WHERE m.mp_source_record_id = '${sn.source_record_id}'), 93, 'S8T-g-${Pn}', (SELECT id FROM financial_account WHERE nombre = 'Mercado Pago'), 'MP_SETTLEMENT', NULL, 'x');`);
  expireLease(dn);
  await run();
  check('crash after RPC 40, before A1: RPC 41 is blocked meanwhile (AUTO_APPLICATION_PENDING); next pass applies exactly once',
    /AUTO_APPLICATION_PENDING/.test(guard.err) && dRow(dn)[0] === 'FETCHED' && mvCount(Pn) === 1 && opCount(Pn) === 3);
  // F-10 crash after A1, before S3
  const Pa = newPid();
  const da = registerPayment(Pa);
  mp.responses.set(Pa, [ok200(paymentPayload(Pa))]);
  const ca = await claimOnly(da);
  const sa = await realDb.ingestSnapshot(ca.delivery_id, ca.claim_token, Pa, paymentPayload(Pa));
  await realDb.normalizeSource(sa.source_record_id);
  const mva = (await realDb.paymentMovements(Pa))[0].movement_id;
  await realDb.applyTransition(mva);
  const opsBefore = owner('SELECT count(*) FROM financial_operation;');
  const auditBefore = owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_APPLY_TRANSITION';`);
  expireLease(da);
  logs = [];
  await run();
  check('F-10 crash after A1, before FETCHED: next pass sees the movement fully assigned (step h applies only unreconciled movements; A1 would be ALREADY_APPLIED); Δ operation / apply-audit = 0; C2 re-offered (NONE); delivery FETCHED',
    dRow(da)[0] === 'FETCHED' && owner('SELECT count(*) FROM financial_operation;') === opsBefore
      && owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_APPLY_TRANSITION';`) === auditBefore
      && !logs.some((l) => l.event === 'WORKER_APPLY') && logs.some((l) => l.event === 'WORKER_AUTO_ALLOCATE' && l.code === 'NO_EVIDENCE')
      && JSON.parse(SVC(`SELECT mp_apply_transition(${mva})::text;`).out).status === 'ALREADY_APPLIED');
  // F-12 stale worker after lease loss
  const Ps = newPid();
  const ds = registerPayment(Ps);
  mp.responses.set(Ps, [ok200(paymentPayload(Ps))]);
  const stale = await claimOnly(ds);
  expireLease(ds);
  await run(); // worker 2 completes
  let lateIngest = 'none';
  let lateFetched = 'none';
  try { await realDb.ingestSnapshot(stale.delivery_id, stale.claim_token, Ps, paymentPayload(Ps)); } catch (e) { lateIngest = dbErrorCode(e); }
  try { await realDb.transition(stale.delivery_id, stale.claim_token, 'FETCHED', { sourceRecordId: dRow(ds)[6] }); } catch (e) { lateFetched = dbErrorCode(e); }
  check('F-12 stale worker 1 after worker 2 finished: its snapshot and FETCHED calls → CLAIM_LOST; totals unchanged',
    lateIngest === 'CLAIM_LOST' && lateFetched === 'CLAIM_LOST' && srcCount(Ps) === 1 && opCount(Ps) === 3, `${lateIngest} ${lateFetched}`);
}

// ═════════════════════════════════════════════════════════════════════════════
section('P', 'closed period + daily sweep');
{
  const Pp = newPid();
  const dp = registerPayment(Pp);
  mp.responses.set(Pp, [ok200(paymentPayload(Pp, { day: '20' }))]);
  owner(`UPDATE management_period SET status = 'CLOSED' WHERE periodo_fecha = '2026-11-01';`);
  logs = [];
  await run();
  const closedState = [dRow(dp)[0], mvCount(Pp), opCount(Pp)].join('|');
  owner(`UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha = '2026-11-01';`);
  check('period closed: A1 → PERIOD_CLOSED (left for the sweep, no hot retry); delivery FETCHED; movement unapplied',
    closedState === 'FETCHED|1|0' && logs.some((l) => l.event === 'WORKER_APPLY' && l.code === 'PERIOD_CLOSED'), closedState);
  // a PENDING api source left by a crash (no delivery needed for the sweep)
  const Pl = newPid();
  const dl = registerPayment(Pl);
  const cl = (await realDb.claimDeliveries(20, 120)).find((r) => r.delivery_id === dl);
  await realDb.ingestSnapshot(cl.delivery_id, cl.claim_token, Pl, paymentPayload(Pl));
  owner(`UPDATE mp_webhook_delivery SET status = 'FAILED_PERMANENT', claim_token = NULL, lease_expires_at = NULL, last_error_code = 'S8T_SIMULATED' WHERE id = ${q(dl)};`);
  // sweep: first invocation in [03:00, 03:10) local
  const SWEEP = Date.parse('2026-11-21T06:02:00Z'); // 03:02 local
  logs = [];
  const sw = await runWorker(deps({ clock: { now: () => SWEEP }, state: { lastProbeAt: SWEEP } }));
  check('daily sweep (03:02 local): normalizes the crash-left PENDING api source and applies it; re-applies the period-closed movement; exactly once each',
    sw.sweep === true && mvCount(Pl) === 1 && opCount(Pl) === 3 && opCount(Pp) === 3, JSON.stringify(sw));
  const st = { lastProbeAt: SWEEP };
  await runWorker(deps({ clock: { now: () => SWEEP }, state: st }));
  const opsAfter = owner('SELECT count(*) FROM financial_operation;');
  const sw2 = await runWorker(deps({ clock: { now: () => SWEEP + 60_000 }, state: st }));
  check('the sweep is idempotent and runs once per local day per instance (second invocation: no sweep; re-running changes nothing)',
    sw2.sweep === false && owner('SELECT count(*) FROM financial_operation;') === opsAfter);
  const outside = await runWorker(deps({ clock: { now: () => Date.parse('2026-11-21T06:15:00Z') }, state: { lastProbeAt: SWEEP } }));
  check('no sweep outside the [03:00, 03:10) local window', outside.sweep === false);
}

// ═════════════════════════════════════════════════════════════════════════════
section('C2', 'mp_auto_allocate deterministic evidence (0053)');
let cseq = 0;
const mkClient = (activo = true) => owner(`INSERT INTO clients (nombre, activo) VALUES ('S8T-C2 ${++cseq}-${Date.now()}', ${activo}) RETURNING id;`);
const mkPedido = (cli) => owner(`INSERT INTO pedidos (cliente_id) VALUES ('${cli}') RETURNING id;`);
let payerSeq = 0;
const newPayer = () => `5557${String(Date.now()).slice(-6)}${String(++payerSeq).padStart(2, '0')}`;
const mkMap = (payer, cli) => owner(`INSERT INTO mp_payer_client_map (mp_payer_id, cliente_id, created_by) VALUES ('${payer}', '${cli}', '${ADMIN_UID}') RETURNING id;`);
const mvOf = (pid) => owner(`SELECT m.id || '|' || t.id || '|' || m.occurred_date FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
  JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${pid}:%' AND t.transition = 'APPROVAL';`).split('|');
const allocRows = (pid) => JSON.parse(owner(`SELECT coalesce(json_agg(json_build_object('cliente', a.cliente_id, 'amount', a.amount::float8, 'mode', a.mode, 'key', a.idempotency_key,
    'eff', a.effective_date, 'by', a.created_by, 'evidence', a.evidence, 'l_type', l.movement_type, 'l_amount', l.signed_amount::float8, 'l_date', l.effective_date,
    'l_cli', l.cliente_id, 'l_src', l.source_entity_type || ':' || l.source_entity_id, 'l_by', l.created_by, 'id', a.id) ORDER BY a.created_at), '[]')::text
  FROM mp_client_allocation a JOIN client_ledger l ON l.id = a.client_ledger_id JOIN mp_financial_movement m ON m.id = a.mp_financial_movement_id
  JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${pid}:%';`));
const allocAudits = (pid) => Number(owner(`SELECT count(*) FROM audit_events e WHERE e.action = 'MP_CLIENT_ALLOCATION' AND e.entity_id IN (
  SELECT a.id::TEXT FROM mp_client_allocation a JOIN mp_financial_movement m ON m.id = a.mp_financial_movement_id
  JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${pid}:%');`));
const totals = () => owner(`SELECT (SELECT count(*) FROM collections) || '|' || (SELECT count(*) FROM financial_posting) || '|' || (SELECT count(*) FROM financial_operation) || '|' || (SELECT count(*) FROM client_ledger);`).split('|').map(Number);
async function viaWorker({ extref = null, payer = '800000999', dbOver = null } = {}) {
  const pid = newPid();
  const d = registerPayment(pid);
  const p = paymentPayload(pid);
  p.external_reference = extref;
  p.payer = { ...p.payer, id: payer };
  mp.responses.set(pid, [ok200(p)]);
  logs = [];
  const s = await (dbOver ? runWorker(deps({ db: { ...realDb, ...dbOver } })) : run());
  const codes = logs.filter((l) => l.event === 'WORKER_AUTO_ALLOCATE').map((l) => l.code);
  return { pid, d, s, codes };
}
const autoAlloc = (mvId) => svcJson(`mp_auto_allocate(${mvId})`);
check('C2-0 no active payer map exists for the default synthetic payer 800000999 (fixtures cannot leak evidence)',
  owner(`SELECT count(*) FROM mp_payer_client_map WHERE mp_payer_id = '800000999' AND activo;`) === '0');
check('C2-0b C2 has exactly one signature, (p_movement_id bigint): no client can be chosen through a parameter; still SECURITY DEFINER, service_role only',
  owner(`SELECT string_agg(pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef, ',') FROM pg_proc p WHERE p.proname = 'mp_auto_allocate';`) === 'p_movement_id bigint:true'
    && owner(`SELECT has_function_privilege('authenticated', 'mp_auto_allocate(bigint)', 'EXECUTE') || '|' || has_function_privilege('service_role', 'mp_auto_allocate(bigint)', 'EXECUTE');`) === 'false|true');
{
  // C2-1 + worker end-to-end: API payment → normalize → A1 → C2 AUTO → FETCHED
  const A = mkClient();
  const before = totals();
  const r = await viaWorker({ extref: `GST:C:${A}` });
  const after = totals();
  const [mvId, tId, occ] = mvOf(r.pid);
  const al = allocRows(r.pid);
  check('C2-1 external_reference GST:C:<client> → exactly one AUTO allocation to that client; delivery FETCHED', r.s.allocated === 1 && dRow(r.d)[0] === 'FETCHED'
    && al.length === 1 && al[0].cliente === A && al[0].mode === 'AUTO' && r.codes.join() === 'ALLOCATED', JSON.stringify(al) + r.codes.join());
  check('C2-1b amount = effective receipt (gross 100, no applied refunds); effective_date = movement.occurred_date; key MPAUTO:<approval transition id>; created_by NULL; evidence {external_reference}',
    al[0].amount === 100 && al[0].eff === occ && al[0].key === `MPAUTO:${tId}` && al[0].by === null
      && JSON.stringify(al[0].evidence) === JSON.stringify({ external_reference: `GST:C:${A}` }), JSON.stringify(al[0]));
  check('C2-1c client_ledger: one COLLECTION −100 for that client, dated movement.occurred_date, source mp_client_allocation:<allocation id>, created_by NULL',
    al[0].l_type === 'COLLECTION' && al[0].l_amount === -100 && al[0].l_date === occ && al[0].l_cli === A && al[0].l_src === `mp_client_allocation:${al[0].id}` && al[0].l_by === null);
  check('C2-1d E2E totals: MP treasury effect exactly once (A1: 3 operations / 3 postings); Δ client_ledger = 1; Δ collections = 0; audit MP_CLIENT_ALLOCATION exactly once',
    opCount(r.pid) === 3 && after[1] - before[1] === 3 && after[2] - before[2] === 3 && after[3] - before[3] === 1 && after[0] === before[0] && allocAudits(r.pid) === 1,
    `${before} → ${after}`);
  // C2-10 replay
  const t0 = totals();
  const rep = autoAlloc(mvId);
  registerPayment(r.pid);
  await run();
  check('C2-10 replay: direct C2 → {allocated:false, ALREADY_ALLOCATED}; duplicate notification through the worker → FETCHED; Δ ledger / allocation / audit / postings = 0',
    rep.allocated === false && rep.reason === 'ALREADY_ALLOCATED' && allocRows(r.pid).length === 1 && allocAudits(r.pid) === 1 && totals().join() === t0.join(), JSON.stringify(rep));
}
{
  const B = mkClient();
  const ped = mkPedido(B);
  const r = await viaWorker({ extref: `GST:P:${ped}` });
  const al = allocRows(r.pid);
  check('C2-2 GST:P:<pedido> → pedidos.cliente_id; one AUTO allocation, evidence {external_reference}', al.length === 1 && al[0].cliente === B
    && al[0].evidence.external_reference === `GST:P:${ped}` && al[0].l_amount === -100, JSON.stringify(al));
}
{
  const C = mkClient();
  const payer = newPayer();
  const map = mkMap(payer, C);
  const r = await viaWorker({ payer });
  const al = allocRows(r.pid);
  check('C2-3 exact active payer map (payer.id as text) → mapped client; evidence {payer_map_id}', al.length === 1 && al[0].cliente === C
    && JSON.stringify(al[0].evidence) === JSON.stringify({ payer_map_id: map }), JSON.stringify(al));
  const rn = await viaWorker({ payer: Number(payer) });
  check('C2-3b payer.id delivered as a JSON number is read as its text form (payload->\'payer\'->>\'id\') → same mapped client', allocRows(rn.pid).length === 1 && allocRows(rn.pid)[0].cliente === C);
  const payer2 = newPayer();
  const C2b = mkClient();
  mkMap(payer2, C2b);
  owner(`UPDATE mp_payer_client_map SET activo = false, deactivated_at = NOW(), deactivated_by = '${ADMIN_UID}', deactivation_reason = 'S8T' WHERE mp_payer_id = '${payer2}';`);
  const ri = await viaWorker({ payer: payer2 });
  check('C2-3c an INACTIVE payer map is not evidence → NO_EVIDENCE', allocRows(ri.pid).length === 0 && ri.codes.join() === 'NO_EVIDENCE', ri.codes.join());
}
{
  const D = mkClient();
  const payer = newPayer();
  const map = mkMap(payer, D);
  const r = await viaWorker({ extref: `GST:C:${D}`, payer });
  const al = allocRows(r.pid);
  check('C2-4 external_reference and payer map name the same client → one candidate → allocated once; evidence carries both axes',
    al.length === 1 && al[0].cliente === D && al[0].evidence.external_reference === `GST:C:${D}` && al[0].evidence.payer_map_id === map, JSON.stringify(al));
}
{
  const E = mkClient();
  const F = mkClient();
  const payer = newPayer();
  mkMap(payer, F);
  const t0 = totals();
  const r = await viaWorker({ extref: `GST:C:${E}`, payer });
  const t1 = totals();
  check('C2-5 external_reference and payer map name different clients → AMBIGUOUS_EVIDENCE; zero allocation, zero client_ledger; delivery FETCHED',
    r.codes.join() === 'AMBIGUOUS_EVIDENCE' && allocRows(r.pid).length === 0 && t1[3] === t0[3] && dRow(r.d)[0] === 'FETCHED', r.codes.join());
}
{
  const r = await viaWorker({});
  check('C2-6 no evidence (external_reference null, payer unmapped) → NO_EVIDENCE; CLIENT_UNASSIGNED remains a valid FETCHED end state',
    r.codes.join() === 'NO_EVIDENCE' && allocRows(r.pid).length === 0 && dRow(r.d)[0] === 'FETCHED' && opCount(r.pid) === 3);
}
{
  const G = mkClient(false);
  const r = await viaWorker({ extref: `GST:C:${G}` });
  check('C2-7 evidence names an inactive client → CLIENT_INACTIVE; no write', r.codes.join() === 'CLIENT_INACTIVE' && allocRows(r.pid).length === 0, r.codes.join());
}
{
  // C2-8 a MANUAL attribution already exists; the payer is mapped afterwards and C2 is re-offered
  const payer = newPayer();
  const r = await viaWorker({ payer });
  const [mvId, , occ] = mvOf(r.pid);
  const H = mkClient();
  const I = mkClient();
  const man = ADMIN(`SELECT mp_allocate_to_client(${mvId}, '${I}', 40, '${occ}', 'S8T-man-${r.pid}', 'manual test')::text;`);
  mkMap(payer, H);
  const t0 = totals();
  const res = autoAlloc(mvId);
  check('C2-8 manual attribution exists (active ≠ 0) → ALREADY_ATTRIBUTED; no second client_ledger row',
    man.ok && res.allocated === false && res.reason === 'ALREADY_ATTRIBUTED' && allocRows(r.pid).length === 1 && totals()[3] === t0[3], JSON.stringify(res) + man.err);
}
{
  // C2-9 closed period: posted receipt, payer mapped later, period closed → PERIOD_CLOSED; reopened → allocated (the sweep's re-offer)
  const payer = newPayer();
  const r = await viaWorker({ payer });
  const [mvId] = mvOf(r.pid);
  const K = mkClient();
  mkMap(payer, K);
  owner(`UPDATE management_period SET status = 'CLOSED' WHERE periodo_fecha = '2026-11-01';`);
  const t0 = totals();
  const res = autoAlloc(mvId);
  const t1 = totals();
  owner(`UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha = '2026-11-01';`);
  const res2 = autoAlloc(mvId);
  check('C2-9 period of movement.occurred_date CLOSED → {allocated:false, PERIOD_CLOSED}, no write; after reopening the same call allocates',
    res.allocated === false && res.reason === 'PERIOD_CLOSED' && t1.join() === t0.join() && res2.allocated === true && allocRows(r.pid)[0].cliente === K,
    JSON.stringify(res) + JSON.stringify(res2));
}
{
  // C2-11 numeric-shaped payer ids are text: '0'-prefixed string ≠ mapped digits
  const L = mkClient();
  const payer = newPayer();
  mkMap(payer, L);
  const r = await viaWorker({ payer: `0${payer}` });
  check('C2-11 payer.id "0<mapped digits>" (numerically equal, textually different) → NO_EVIDENCE: exact text match only, no numeric cast',
    r.codes.join() === 'NO_EVIDENCE' && allocRows(r.pid).length === 0, r.codes.join());
}
{
  // C2-12 unknown external_reference never guesses a client
  const M = mkClient();
  const cases = ['ORDER-123', `GST:C:${M} `, `gst:c:${M}`, `GST:X:${M}`, `GST:C:${M}:extra`, 'GST:C:not-a-uuid', 'GST:C:00000000-0000-4000-8000-000000000000',
    'GST:P:00000000-0000-4000-8000-000000000000'];
  const got = [];
  for (const x of cases) {
    const r = await viaWorker({ extref: x });
    got.push(`${r.codes.join()}:${allocRows(r.pid).length}`);
  }
  check('C2-12 non-deterministic external_reference values (free text, whitespace, lower-case prefix, other axis, suffix, malformed uuid, unknown client / pedido) → NO_EVIDENCE, never a guessed client',
    got.every((g) => g === 'NO_EVIDENCE:0'), got.join(' '));
}

// ═════════════════════════════════════════════════════════════════════════════
section('AC', 'auto-allocation failure recovery + sweep marker');
{
  // AUTOALLOC-CRASH
  const J = mkClient();
  const before = totals();
  const r = await viaWorker({ extref: `GST:C:${J}`, dbOver: { autoAllocate: async () => { calls.push('allocate'); throw new DbError('could not obtain lock on row (simulated)'); } } });
  const mid = totals();
  const st = dRow(r.d)[0];
  check('AUTOALLOC-CRASH A1 committed, then C2 throws a DB error → item aborted: delivery NOT FETCHED (still PROCESSING under its lease); money applied exactly once; no allocation',
    st === 'PROCESSING' && r.s.fetched === 0 && opCount(r.pid) === 3 && mid[1] - before[1] === 3 && allocRows(r.pid).length === 0
      && logs.some((l) => l.event === 'WORKER_ITEM_FAILED' && l.delivery_id === r.d), `${st} ${JSON.stringify(r.s)}`);
  expireLease(r.d);
  logs = [];
  const s2 = await run();
  const after = totals();
  const [mvId] = mvOf(r.pid);
  check('AUTOALLOC-CRASH after the lease expires, a healthy pass: no A1 re-application (Δ operations / postings = 0), C2 allocates once, delivery FETCHED',
    dRow(r.d)[0] === 'FETCHED' && s2.applied === 0 && s2.allocated === 1 && after[1] === mid[1] && after[2] === mid[2] && after[3] - mid[3] === 1
      && allocRows(r.pid).length === 1 && allocRows(r.pid)[0].cliente === J && allocAudits(r.pid) === 1 && after[0] === before[0]
      && JSON.parse(SVC(`SELECT mp_apply_transition(${mvId})::text;`).out).status === 'ALREADY_APPLIED', `${JSON.stringify(s2)} ${mid} → ${after}`);
}
{
  // SWEEP-RETRY
  const T1 = Date.parse('2026-11-22T06:01:00Z'); // 03:01 local
  const st = { lastProbeAt: T1 };
  logs = [];
  const s1 = await runWorker(deps({ clock: { now: () => T1 }, state: st, db: { ...realDb, pendingApiSources: async () => { throw new DbError('DB_ERROR: simulated read failure'); } } }));
  check('SWEEP-RETRY 1st invocation: a structural sweep read throws → sweep not completed; lastSweepLocalDate stays unset; failure logged',
    s1.sweep === false && st.lastSweepLocalDate === undefined && logs.some((l) => l.event === 'WORKER_SWEEP_FAILED'), JSON.stringify(st));
  const s2 = await runWorker(deps({ clock: { now: () => T1 + 120_000 }, state: st }));
  check('SWEEP-RETRY 2nd invocation at 03:03 with a healthy DB → the sweep runs; after completion the marker is set to the local date',
    s2.sweep === true && st.lastSweepLocalDate === '2026-11-22', JSON.stringify(st));
  const s3 = await runWorker(deps({ clock: { now: () => T1 + 240_000 }, state: st }));
  check('SWEEP-RETRY 3rd invocation the same local day (03:05) → no second sweep', s3.sweep === false);
}

// ═════════════════════════════════════════════════════════════════════════════
section('R', 'chargeback signal path (R-12 / R-13 / R-14)');
{
  const Pcb = newPid();
  const cbId = `7773${String(Date.now()).slice(-8)}`;
  const d = registerChargeback(cbId, Pcb);
  mp.requests.length = 0;
  const finBefore = owner('SELECT count(*) || \'|\' || (SELECT count(*) FROM financial_posting) FROM financial_operation;');
  await run();
  const sig = owner(`SELECT status || '|' || coalesce(signal_resolution, '-') FROM mp_webhook_delivery WHERE id = ${q(d)};`);
  const refresh = owner(`SELECT count(*) || '|' || coalesce(max(topic_class), '-') || '|' || coalesce(max(resource_id), '-') || '|' || coalesce(max(origin), '-') FROM mp_webhook_delivery WHERE triggered_by_delivery_id = ${q(d)};`);
  check('R-12 signal with the documented payment reference → SIGNAL_RECORDED + LINKED; one chargeback_refresh payment delivery for that payment; no MP fetch for the signal; Δ financial = 0',
    sig === 'SIGNAL_RECORDED|LINKED' && refresh === `1|payment|${Pcb}|chargeback_refresh` && !mp.requests.includes(cbId)
      && owner('SELECT count(*) || \'|\' || (SELECT count(*) FROM financial_posting) FROM financial_operation;') === finBefore, `${sig} ${refresh}`);
  // the refresh is processed like any payment delivery (current resource; here disputed → no movement)
  mp.responses.set(Pcb, [ok200(paymentPayload(Pcb, { status: 'charged_back', detail: 'in_process' }))]);
  await run();
  check('R-12b the refresh delivery fetches the payment: charged_back without a prior APPROVAL → source ERROR DISPUTE_WITHOUT_APPROVAL; no movement; refresh FETCHED',
    owner(`SELECT status FROM mp_webhook_delivery WHERE triggered_by_delivery_id = ${q(d)};`) === 'FETCHED'
      && owner(`SELECT split_part(processing_note, ':', 1) FROM mp_source_record WHERE external_id LIKE 'MPPAY:${Pcb}:%';`) === 'DISPUTE_WITHOUT_APPROVAL' && mvCount(Pcb) === 0);
  // R-13 no reference → unresolved
  const d2 = registerChargeback(`7773${String(Date.now()).slice(-7)}9`, null);
  await run();
  check('R-13 signal without a payment reference → SIGNAL_RECORDED, unresolved; no refresh delivery',
    owner(`SELECT status || '|' || coalesce(signal_resolution, '-') FROM mp_webhook_delivery WHERE id = ${q(d2)};`) === 'SIGNAL_RECORDED|-'
      && owner(`SELECT count(*) FROM mp_webhook_delivery WHERE triggered_by_delivery_id = ${q(d2)};`) === '0');
  // invalid reference → INVALID_PAYMENT_ID, retried unlinked
  const d3 = registerChargeback(`7773${String(Date.now()).slice(-7)}8`, null);
  logs = [];
  await runWorker(deps({ db: { ...realDb, chargebackPaymentRef: async () => 'abc' } }));
  check('F-14 path: malformed reference → first transition INVALID_PAYMENT_ID (rolled back) → retried with NULL → SIGNAL_RECORDED unresolved; no refresh',
    owner(`SELECT status || '|' || coalesce(signal_resolution, '-') FROM mp_webhook_delivery WHERE id = ${q(d3)};`) === 'SIGNAL_RECORDED|-'
      && logs.some((l) => l.event === 'WORKER_CHARGEBACK_SIGNAL' && l.code === 'INVALID_PAYMENT_ID')
      && owner(`SELECT count(*) FROM mp_webhook_delivery WHERE triggered_by_delivery_id = ${q(d3)};`) === '0');
  // R-14 idempotency
  const again = svcJson(`mp_register_delivery('webhook', 'topic_chargebacks_wh', 'chargeback', NULL, ${q(cbId)}, NULL, 'S8T-cb', ${j(JSON.parse(owner(`SELECT notification_payload::text FROM mp_webhook_delivery WHERE id = ${q(d)};`)))}, true)`);
  await run();
  await run();
  check('R-14 the same chargeback notification again → duplicate (created false); worker runs twice → 1 signal, ≤ 1 refresh, Δ financial = 0',
    again.created === false && owner(`SELECT count(*) FROM mp_webhook_delivery WHERE resource_id = ${q(cbId)};`) === '1'
      && owner(`SELECT count(*) FROM mp_webhook_delivery WHERE triggered_by_delivery_id = ${q(d)};`) === '1'
      && owner('SELECT count(*) || \'|\' || (SELECT count(*) FROM financial_posting) FROM financial_operation;') === finBefore);
}

// ═════════════════════════════════════════════════════════════════════════════
section('L', 'logging policy');
{
  const P = newPid();
  registerPayment(P);
  mp.responses.set(P, [ok200(paymentPayload(P))]);
  logs = [];
  await run();
  const text = JSON.stringify(logs);
  const allowed = ['event', 'delivery_id', 'resource_id', 'http_status', 'code', 'duration_ms', 'counts'];
  check('L-1 log entries carry only event / delivery_id / resource_id / http_status / code / duration_ms / counts',
    logs.length > 0 && logs.every((l) => Object.keys(l).every((k) => allowed.includes(k))), text.slice(0, 300));
  check('L-2 no token, secret, payload, payer data or amounts in any log entry',
    !text.includes(FAKE_TOKEN) && !text.includes('buyer@example.invalid') && !text.includes('Buyer') && !text.includes('99999999')
      && !text.includes('transaction_amount') && !text.includes('fee_details') && !text.includes('payer'));
  check('L-3 no real network call was attempted anywhere in this suite (fetch replaced by a thrower)', !text.includes('REAL_NETWORK_CALL_ATTEMPTED'));
}

cleanup();
console.log(`\n  ══ MP WORKER CORE RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail) console.log(failures.map((f) => `   - ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
