/**
 * ADR-006 Step 8 — mpWorkerCore: the pure, injectable worker loop.
 *
 * Authority: ADR006_WEBHOOK_WORKER_DESIGN_V1 §4 / §4a / §5; ADR006_IDEMPOTENCY_AND_STATE_V1 §3;
 * ADR006_RPC_CONTRACTS_V1 S2 / S3 / S4 / RPC 40 / A1 / C2 / S5.
 *
 * Pure: no env, no Deno / Node globals, no network, no DB. Everything is injected
 * (db, mpApi, clock, log, state). Each DB step is its own atomic RPC; cross-call state is always
 * re-derived from the database, never kept only in memory.
 *
 * Logging policy: entries carry only {event, delivery_id, resource_id, http_status, code,
 * duration_ms, counts}. Never a token, secret, payload, payer data, signature or full response.
 */

export const WORKER_INVOKE_HEADER = 'x-worker-invoke-secret';
export const CLAIM_LIMIT = 20;
export const LEASE_SECONDS = 120;
export const BUDGET_MS = 50_000;
export const ITEM_RESERVE_MS = 12_000; // one 10 s fetch + DB calls must still fit in the budget
export const PROBE_INTERVAL_MS = 3_600_000;
export const SWEEP_WINDOW_START_MIN = 3 * 60; // 03:00 America/Argentina/Buenos_Aires
export const SWEEP_WINDOW_END_MIN = 3 * 60 + 10; // [03:00, 03:10)
export const BA_OFFSET_MIN = -180; // America/Argentina/Buenos_Aires: UTC−3, no DST
const PAYMENT_ID = /^[0-9]{1,20}$/;

export interface Claim {
  delivery_id: string;
  claim_token: string;
  origin: string;
  topic_class: string;
  topic: string;
  resource_id: string | null;
  attempts: number;
}

export interface MpResponse {
  status?: number; // absent when the request failed before a response
  failure?: 'timeout' | 'network';
  retryAfter?: string | null;
  body?: unknown; // parsed JSON (undefined if not JSON)
}

export interface PaymentMovement {
  movement_id: number;
  movement_kind: string;
  net_amount: number;
  assigned_amount: number;
}

export interface WorkerDb {
  claimDeliveries(limit: number, leaseSeconds: number): Promise<Claim[]>;
  transition(deliveryId: string, token: string, outcome: string, opts?: {
    sourceRecordId?: string | null; errorCode?: string | null; errorDetail?: string | null;
    retryAfterSeconds?: number | null; linkPaymentId?: string | null;
  }): Promise<unknown>;
  ingestSnapshot(deliveryId: string, token: string, paymentId: string, payload: unknown): Promise<{ source_record_id: string; created: boolean; processing_status: string }>;
  normalizeSource(sourceId: string): Promise<{ processing_status: string }>;
  paymentMovements(paymentId: string): Promise<PaymentMovement[]>;
  applyTransition(movementId: number): Promise<{ status: string }>;
  autoAllocate(movementId: number): Promise<{ allocated: boolean; reason?: string }>;
  /** The chargeback notification's documented payment reference (V-1: data.payment_id); null if absent or unreadable. */
  chargebackPaymentRef(deliveryId: string): Promise<string | null>;
  /** Oldest CONFIG_BLOCKED payment delivery (resource id only), for the hourly probe; null if none or unreadable. */
  oldestConfigBlocked(): Promise<{ resource_id: string } | null>;
  requeueConfigBlocked(reason: string): Promise<unknown>;
  pendingApiSources(limit: number): Promise<string[]>;
  unappliedMovements(limit: number): Promise<number[]>;
  postedPaymentMovements(sinceDate: string, limit: number): Promise<number[]>;
}

export interface MpApi {
  getPayment(paymentId: string): Promise<MpResponse>;
}

export interface WorkerLogEntry {
  event: string;
  delivery_id?: string;
  resource_id?: string | null;
  http_status?: number;
  code?: string;
  duration_ms?: number;
  counts?: Record<string, number>;
}

export interface WorkerState {
  lastProbeAt?: number;
  lastSweepLocalDate?: string;
}

export interface WorkerDeps {
  db: WorkerDb;
  mpApi: MpApi;
  clock: { now(): number };
  log(entry: WorkerLogEntry): void;
  config: { collectorId: string };
  state: WorkerState;
}

export type Classification =
  | { kind: 'success'; payload: Record<string, unknown> }
  | { kind: 'retry'; code: 'MP_NOT_FOUND' | 'MP_RATE_LIMIT' | 'MP_UNAVAILABLE'; retryAfterSeconds: number | null; httpStatus?: number }
  | { kind: 'permanent'; code: 'MP_BAD_REQUEST' | 'MP_BAD_PAYLOAD'; httpStatus?: number }
  | { kind: 'auth'; httpStatus: number };

/** DB errors arrive as "CODE: detail" (RAISE EXCEPTION convention); return the code. */
export function dbErrorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/([A-Z][A-Z0-9_]{2,})(?=[:\s]|$)/);
  return m ? m[1] : 'DB_ERROR';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Retry-After (seconds or HTTP date) → seconds, clamped to [60, 3600]; null when absent / unparsable. */
export function parseRetryAfter(v: string | null | undefined, nowMs: number): number | null {
  if (v === null || v === undefined || v.trim() === '') return null;
  let secs: number;
  if (/^[0-9]+$/.test(v.trim())) secs = Number(v.trim());
  else {
    const t = Date.parse(v);
    if (Number.isNaN(t)) return null;
    secs = Math.ceil((t - nowMs) / 1000);
  }
  return Math.min(3600, Math.max(60, secs));
}

/** §5 classification table. */
export function classify(resp: MpResponse, nowMs: number): Classification {
  if (resp.failure) return { kind: 'retry', code: 'MP_UNAVAILABLE', retryAfterSeconds: null };
  const s = resp.status ?? 0;
  if (s === 200) return isPlainObject(resp.body) ? { kind: 'success', payload: resp.body } : { kind: 'permanent', code: 'MP_BAD_PAYLOAD', httpStatus: s };
  if (s === 401 || s === 403) return { kind: 'auth', httpStatus: s };
  if (s === 404) return { kind: 'retry', code: 'MP_NOT_FOUND', retryAfterSeconds: null, httpStatus: s };
  if (s === 429) return { kind: 'retry', code: 'MP_RATE_LIMIT', retryAfterSeconds: parseRetryAfter(resp.retryAfter, nowMs), httpStatus: s };
  if (s >= 500 && s <= 599) return { kind: 'retry', code: 'MP_UNAVAILABLE', retryAfterSeconds: null, httpStatus: s };
  if (s >= 400 && s <= 499) return { kind: 'permanent', code: 'MP_BAD_REQUEST', httpStatus: s };
  return { kind: 'permanent', code: 'MP_BAD_REQUEST', httpStatus: s };
}

/** Local (America/Argentina/Buenos_Aires) date and minute-of-day. */
export function localParts(nowMs: number): { date: string; minuteOfDay: number } {
  const d = new Date(nowMs + BA_OFFSET_MIN * 60_000);
  return { date: d.toISOString().slice(0, 10), minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export interface WorkerSummary {
  claimed: number;
  fetched: number;
  retried: number;
  permanent: number;
  config_blocked: number;
  released: number;
  signals: number;
  applied: number;
  allocated: number;
  stopped: 'completed' | 'auth_circuit_breaker' | 'budget';
  sweep: boolean;
  probe: 'none' | 'requeued' | 'still_blocked';
}

export async function runWorker(deps: WorkerDeps): Promise<WorkerSummary> {
  const { db, clock, log } = deps;
  const start = clock.now();
  const sum: WorkerSummary = {
    claimed: 0, fetched: 0, retried: 0, permanent: 0, config_blocked: 0, released: 0, signals: 0,
    applied: 0, allocated: 0, stopped: 'completed', sweep: false, probe: 'none',
  };

  await maybeProbe(deps, sum);

  const claims = await db.claimDeliveries(CLAIM_LIMIT, LEASE_SECONDS);
  sum.claimed = claims.length;
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i];
    if (clock.now() - start > BUDGET_MS - ITEM_RESERVE_MS) {
      sum.stopped = 'budget';
      await releaseRest(deps, claims.slice(i), sum);
      break;
    }
    const t0 = clock.now();
    try {
      if (c.topic_class === 'chargeback') {
        await processChargeback(deps, c, sum);
      } else if (c.topic_class === 'payment') {
        const outcome = await processPayment(deps, c, sum);
        if (outcome === 'auth') {
          sum.stopped = 'auth_circuit_breaker';
          await releaseRest(deps, claims.slice(i + 1), sum);
          break;
        }
      } else {
        await db.transition(c.delivery_id, c.claim_token, 'PERMANENT', { errorCode: 'UNSUPPORTED_TOPIC', errorDetail: `topic_class ${c.topic_class}` });
        sum.permanent++;
      }
    } catch (err) {
      // unexpected DB failure: no transition; the lease expires and the row is re-claimed (crash-safe)
      log({ event: 'WORKER_ITEM_FAILED', delivery_id: c.delivery_id, resource_id: c.resource_id, code: dbErrorCode(err) });
    } finally {
      log({ event: 'WORKER_ITEM_DONE', delivery_id: c.delivery_id, resource_id: c.resource_id, duration_ms: clock.now() - t0 });
    }
  }

  if (sum.stopped === 'completed') await maybeSweep(deps, sum);
  log({ event: 'WORKER_RUN', duration_ms: clock.now() - start, counts: { ...countsOf(sum) } });
  return sum;
}

function countsOf(s: WorkerSummary): Record<string, number> {
  return { claimed: s.claimed, fetched: s.fetched, retried: s.retried, permanent: s.permanent, config_blocked: s.config_blocked,
    released: s.released, signals: s.signals, applied: s.applied, allocated: s.allocated };
}

async function releaseRest(deps: WorkerDeps, rest: Claim[], sum: WorkerSummary): Promise<void> {
  for (const r of rest) {
    try {
      await deps.db.transition(r.delivery_id, r.claim_token, 'RELEASE');
      sum.released++;
    } catch (err) {
      deps.log({ event: 'WORKER_RELEASE_FAILED', delivery_id: r.delivery_id, code: dbErrorCode(err) });
    }
  }
}

/** §4 steps b–k for one payment delivery. Returns 'auth' when the circuit breaker must stop the run. */
async function processPayment(deps: WorkerDeps, c: Claim, sum: WorkerSummary): Promise<'ok' | 'auth'> {
  const { db, mpApi, clock, log, config } = deps;
  const pid = c.resource_id ?? '';
  if (!PAYMENT_ID.test(pid)) {
    await db.transition(c.delivery_id, c.claim_token, 'PERMANENT', { errorCode: 'MP_BAD_REQUEST', errorDetail: 'invalid payment resource id' });
    sum.permanent++;
    return 'ok';
  }
  // b. fetch the CURRENT resource (order independence)
  const resp = await mpApi.getPayment(pid);
  const cls = classify(resp, clock.now());
  log({ event: 'MP_FETCH', delivery_id: c.delivery_id, resource_id: pid, http_status: resp.status, code: cls.kind === 'success' ? 'OK' : cls.kind === 'auth' ? 'AUTH_CONFIGURATION_ERROR' : cls.code });
  // c. classify
  if (cls.kind === 'auth') {
    await db.transition(c.delivery_id, c.claim_token, 'CONFIG_BLOCKED', { errorCode: 'AUTH_CONFIGURATION_ERROR', errorDetail: `http ${cls.httpStatus}` });
    sum.config_blocked++;
    log({ event: 'MP_AUTH_CONFIGURATION_ERROR', delivery_id: c.delivery_id, http_status: cls.httpStatus });
    return 'auth';
  }
  if (cls.kind === 'retry') {
    await db.transition(c.delivery_id, c.claim_token, 'RETRY', {
      errorCode: cls.code, errorDetail: cls.httpStatus ? `http ${cls.httpStatus}` : (resp.failure ?? 'transient'), retryAfterSeconds: cls.retryAfterSeconds,
    });
    sum.retried++;
    return 'ok';
  }
  if (cls.kind === 'permanent') {
    await db.transition(c.delivery_id, c.claim_token, 'PERMANENT', { errorCode: cls.code, errorDetail: `http ${cls.httpStatus ?? 0}` });
    sum.permanent++;
    return 'ok';
  }
  const payload = cls.payload;
  // d. boundary checks (defence in depth; not a DB authority) — before any snapshot
  if (String(payload['collector_id']) !== config.collectorId) {
    await db.transition(c.delivery_id, c.claim_token, 'PERMANENT', { errorCode: 'COLLECTOR_MISMATCH', errorDetail: 'collector does not match the configured account' });
    log({ event: 'SECURITY_COLLECTOR_MISMATCH', delivery_id: c.delivery_id, resource_id: pid, code: 'COLLECTOR_MISMATCH' });
    sum.permanent++;
    return 'ok';
  }
  if (String(payload['id']) !== pid) {
    await db.transition(c.delivery_id, c.claim_token, 'PERMANENT', { errorCode: 'PAYLOAD_ID_MISMATCH', errorDetail: 'payload id does not match the resource id' });
    log({ event: 'SECURITY_PAYLOAD_ID_MISMATCH', delivery_id: c.delivery_id, resource_id: pid, code: 'PAYLOAD_ID_MISMATCH' });
    sum.permanent++;
    return 'ok';
  }
  // e. immutable snapshot (same hash → same source)
  let src: { source_record_id: string; processing_status: string };
  try {
    src = await db.ingestSnapshot(c.delivery_id, c.claim_token, pid, payload);
  } catch (err) {
    const code = dbErrorCode(err);
    log({ event: 'WORKER_SNAPSHOT_FAILED', delivery_id: c.delivery_id, resource_id: pid, code });
    if (code !== 'CLAIM_LOST') throw err;
    return 'ok'; // stale worker: stop touching this delivery
  }
  // f. normalize (idempotent; ALREADY_PROCESSED is benign)
  if (src.processing_status === 'PENDING') {
    try {
      const n = await db.normalizeSource(src.source_record_id);
      log({ event: 'WORKER_NORMALIZED', delivery_id: c.delivery_id, resource_id: pid, code: n.processing_status });
    } catch (err) {
      const code = dbErrorCode(err);
      if (code !== 'ALREADY_PROCESSED') throw err;
    }
  }
  // g. api_refund children: none — refund discovery is disabled (V-2 §15.1)
  // h. apply every not-yet-applied movement of this payment; A1 decides eligibility (0052 helper)
  const posted: number[] = [];
  for (const m of await db.paymentMovements(pid)) {
    if (m.assigned_amount === m.net_amount) {
      posted.push(m.movement_id);
      continue;
    }
    if (m.assigned_amount !== 0) {
      log({ event: 'WORKER_APPLY_SKIPPED', delivery_id: c.delivery_id, resource_id: pid, code: 'PARTIALLY_ASSIGNED' });
      continue;
    }
    const r = await applyOne(deps, m.movement_id, c.delivery_id, pid);
    if (r === 'APPLIED' || r === 'ALREADY_APPLIED') {
      posted.push(m.movement_id);
      if (r === 'APPLIED') sum.applied++;
    }
  }
  // i. deterministic client attribution for posted APPROVAL receipts (NONE is normal)
  for (const mv of posted) {
    if (await allocateOne(deps, mv, c.delivery_id, pid)) sum.allocated++;
  }
  // j. report rows parked DEFERRED_BACKFILL: none while mp_v4_verified() is false (Step 19)
  // k. FETCHED only after every DB step above is durably complete
  try {
    await db.transition(c.delivery_id, c.claim_token, 'FETCHED', { sourceRecordId: src.source_record_id });
    sum.fetched++;
  } catch (err) {
    log({ event: 'WORKER_FETCHED_FAILED', delivery_id: c.delivery_id, resource_id: pid, code: dbErrorCode(err) });
  }
  return 'ok';
}

const REVIEW_CODES = new Set(['TRANSITION_ALREADY_ASSIGNED', 'APPLICATION_NET_MISMATCH', 'EXTERNAL_REF_CONFLICT',
  'SOURCE_NOT_APPLICABLE', 'NOT_AUTO_APPLICABLE', 'PERIOD_CLOSED', 'PERIOD_NOT_FOUND', 'MOVEMENT_INVALID', 'TRANSITION_KIND_NOT_SUPPORTED']);

async function applyOne(deps: WorkerDeps, movementId: number, deliveryId: string | undefined, pid: string | null): Promise<string> {
  try {
    const r = await deps.db.applyTransition(movementId);
    deps.log({ event: 'WORKER_APPLY', delivery_id: deliveryId, resource_id: pid, code: r.status });
    return r.status;
  } catch (err) {
    const code = dbErrorCode(err);
    deps.log({ event: 'WORKER_APPLY', delivery_id: deliveryId, resource_id: pid, code });
    if (!REVIEW_CODES.has(code)) throw err;
    return code; // left for review / the daily sweep; never hot-retried
  }
}

async function allocateOne(deps: WorkerDeps, movementId: number, deliveryId: string | undefined, pid: string | null): Promise<boolean> {
  try {
    const r = await deps.db.autoAllocate(movementId);
    deps.log({ event: 'WORKER_AUTO_ALLOCATE', delivery_id: deliveryId, resource_id: pid, code: r.allocated ? 'ALLOCATED' : (r.reason ?? 'NONE') });
    return r.allocated === true;
  } catch (err) {
    deps.log({ event: 'WORKER_AUTO_ALLOCATE', delivery_id: deliveryId, resource_id: pid, code: dbErrorCode(err) });
    return false;
  }
}

/** §4a: signal only — no fetch, no movement, no treasury effect. */
async function processChargeback(deps: WorkerDeps, c: Claim, sum: WorkerSummary): Promise<void> {
  const { db, log } = deps;
  let ref: string | null = null;
  try {
    ref = await db.chargebackPaymentRef(c.delivery_id);
  } catch {
    ref = null;
  }
  try {
    await db.transition(c.delivery_id, c.claim_token, 'SIGNAL_RECORDED', { linkPaymentId: ref });
    log({ event: 'WORKER_CHARGEBACK_SIGNAL', delivery_id: c.delivery_id, resource_id: c.resource_id, code: ref ? 'LINKED' : 'UNRESOLVED' });
  } catch (err) {
    const code = dbErrorCode(err);
    if (code !== 'INVALID_PAYMENT_ID') throw err;
    // the whole transition rolled back; record it unlinked for ADMIN resolution
    log({ event: 'WORKER_CHARGEBACK_SIGNAL', delivery_id: c.delivery_id, resource_id: c.resource_id, code: 'INVALID_PAYMENT_ID' });
    await db.transition(c.delivery_id, c.claim_token, 'SIGNAL_RECORDED', { linkPaymentId: null });
    log({ event: 'WORKER_CHARGEBACK_SIGNAL', delivery_id: c.delivery_id, resource_id: c.resource_id, code: 'UNRESOLVED' });
  }
  sum.signals++;
}

/** §5 optional recovery probe: at most once per hour, only while CONFIG_BLOCKED rows exist. */
async function maybeProbe(deps: WorkerDeps, sum: WorkerSummary): Promise<void> {
  const { db, mpApi, clock, log, state } = deps;
  const now = clock.now();
  if (state.lastProbeAt !== undefined && now - state.lastProbeAt < PROBE_INTERVAL_MS) return;
  let oldest: { resource_id: string } | null = null;
  try {
    oldest = await db.oldestConfigBlocked();
  } catch {
    oldest = null;
  }
  if (!oldest || !PAYMENT_ID.test(oldest.resource_id)) return;
  state.lastProbeAt = now;
  const resp = await mpApi.getPayment(oldest.resource_id);
  log({ event: 'MP_CREDENTIAL_PROBE', resource_id: oldest.resource_id, http_status: resp.status });
  if (resp.status === 200) {
    await db.requeueConfigBlocked('auto: credential probe succeeded');
    sum.probe = 'requeued';
  } else {
    sum.probe = 'still_blocked';
  }
}

/** §4 step 3: daily sweep, first invocation in [03:00, 03:10) local; idempotent. */
async function maybeSweep(deps: WorkerDeps, sum: WorkerSummary): Promise<void> {
  const { db, clock, log, state } = deps;
  const { date, minuteOfDay } = localParts(clock.now());
  if (minuteOfDay < SWEEP_WINDOW_START_MIN || minuteOfDay >= SWEEP_WINDOW_END_MIN || state.lastSweepLocalDate === date) return;
  state.lastSweepLocalDate = date;
  sum.sweep = true;
  let normalized = 0;
  for (const s of await db.pendingApiSources(100)) {
    try {
      await db.normalizeSource(s);
      normalized++;
    } catch (err) {
      log({ event: 'SWEEP_NORMALIZE', code: dbErrorCode(err) });
    }
  }
  let applied = 0;
  for (const m of await db.unappliedMovements(200)) {
    const r = await applyOne(deps, m, undefined, null).catch((err) => dbErrorCode(err));
    if (r === 'APPLIED') applied++;
  }
  const since = localParts(clock.now() - 30 * 86_400_000).date;
  let allocated = 0;
  for (const m of await db.postedPaymentMovements(since, 500)) {
    if (await allocateOne(deps, m, undefined, null)) allocated++;
  }
  sum.applied += applied;
  sum.allocated += allocated;
  log({ event: 'WORKER_SWEEP', counts: { normalized, applied, allocated } });
}
