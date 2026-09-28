/**
 * ADR-006 Step 8 — `mp-worker` Supabase Edge Function (verify_jwt = false).
 *
 * Authority: ADR006_WEBHOOK_WORKER_DESIGN_V1 §1, §4, §5. The loop lives in
 * ../_shared/mp-worker-core.ts; this file only reads env, authenticates the invocation,
 * builds the real adapters and calls runWorker.
 *
 * Runtime values read here and nowhere else:
 *   MP_ACCESS_TOKEN, MP_COLLECTOR_ID, WORKER_INVOKE_SECRET   — Edge Function secrets
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY                   — platform-injected
 *   MP_API_BASE_URL (optional; default https://api.mercadopago.com) — local tests point it at a mock
 * None of them is ever logged, returned or persisted.
 *
 * Invocation auth: header `x-worker-invoke-secret` (the same constant mp-webhook's kick sends),
 * compared in constant time (SHA-256 digests + timingSafeEqual). Missing / wrong → 401.
 * No CORS headers: server-to-server only.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  runWorker, WORKER_INVOKE_HEADER, type WorkerDb, type MpApi, type MpResponse, type Claim, type WorkerState, type WorkerLogEntry,
} from '../_shared/mp-worker-core.ts';

const env = (name: string): string | null => {
  const v = Deno.env.get(name);
  return v !== undefined && v !== '' ? v : null;
};
const TOKEN = env('MP_ACCESS_TOKEN');
const COLLECTOR = env('MP_COLLECTOR_ID');
const INVOKE_SECRET = env('WORKER_INVOKE_SECRET');
const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const MP_BASE = (env('MP_API_BASE_URL') ?? 'https://api.mercadopago.com').replace(/\/+$/, '');

// per-instance, non-authoritative scheduling memory (probe cadence, sweep once per local day)
const STATE: WorkerState = {};

const JSON_HEADERS = { 'content-type': 'application/json' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const log = (entry: WorkerLogEntry | Record<string, unknown>) => console.log(JSON.stringify({ fn: 'mp-worker', ...entry }));

function secretMatches(given: string | null): boolean {
  if (given === null || INVOKE_SECRET === null) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(INVOKE_SECRET, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// ── PostgREST adapter (service role) ─────────────────────────────────────────
const rest = `${SUPABASE_URL}/rest/v1`;
const restHeaders = () => ({ apikey: SERVICE_KEY as string, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' });

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${rest}/rpc/${name}`, { method: 'POST', headers: restHeaders(), body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) {
    let message = `DB_ERROR: http ${res.status}`;
    try {
      const e = JSON.parse(text);
      if (typeof e?.message === 'string') message = e.message;
    } catch { /* keep the generic message */ }
    throw new Error(message);
  }
  return (text === '' ? null : JSON.parse(text)) as T;
}

async function select<T>(pathAndQuery: string): Promise<T[] | null> {
  const res = await fetch(`${rest}/${pathAndQuery}`, { headers: restHeaders() });
  if (!res.ok) {
    await res.body?.cancel();
    return null; // e.g. a table whose service-role grant arrives with Step 9: fail closed
  }
  return (await res.json()) as T[];
}

type MvRow = { id: number; movement_kind: string; net_amount: number; occurred_date?: string; mp_reconciliation: { assigned_amount: number }[] };
const assigned = (m: MvRow) => Math.round(m.mp_reconciliation.reduce((s, r) => s + Number(r.assigned_amount), 0) * 100) / 100;

const db: WorkerDb = {
  async claimDeliveries(limit, leaseSeconds) {
    return (await rpc<Claim[]>('mp_claim_deliveries', { p_limit: limit, p_lease_seconds: leaseSeconds })) ?? [];
  },
  transition(d, t, outcome, o = {}) {
    return rpc('mp_delivery_transition', {
      p_delivery_id: d, p_claim_token: t, p_outcome: outcome, p_source_record_id: o.sourceRecordId ?? null,
      p_error_code: o.errorCode ?? null, p_error_detail: o.errorDetail ?? null,
      p_retry_after_seconds: o.retryAfterSeconds ?? null, p_link_payment_id: o.linkPaymentId ?? null,
    });
  },
  ingestSnapshot(d, t, pid, payload) {
    return rpc('mp_ingest_api_snapshot', { p_delivery_id: d, p_claim_token: t, p_payment_id: pid, p_payload: payload });
  },
  normalizeSource(id) {
    return rpc('mp_normalize_source', { p_source_record_id: id });
  },
  async paymentMovements(pid) {
    const rows = await select<{ mp_financial_movement: MvRow[] }>(
      `mp_source_record?select=mp_financial_movement(id,movement_kind,net_amount,mp_reconciliation(assigned_amount))&source_type=eq.api_payment&external_id=like.MPPAY:${pid}:*`);
    if (rows === null) throw new Error('DB_ERROR: movement read failed');
    return rows.flatMap((r) => r.mp_financial_movement).map((m) => ({
      movement_id: m.id, movement_kind: m.movement_kind, net_amount: Number(m.net_amount), assigned_amount: assigned(m),
    }));
  },
  applyTransition(id) {
    return rpc('mp_apply_transition', { p_movement_id: id });
  },
  autoAllocate(id) {
    return rpc('mp_auto_allocate', { p_movement_id: id });
  },
  async chargebackPaymentRef(d) {
    const rows = await select<{ notification_payload: Record<string, unknown> }>(`mp_webhook_delivery?select=notification_payload&id=eq.${d}`);
    const v = rows?.[0]?.notification_payload?.['data_payment_id'];
    return typeof v === 'string' ? v : null;
  },
  async oldestConfigBlocked() {
    const rows = await select<{ resource_id: string }>('mp_webhook_delivery?select=resource_id&status=eq.CONFIG_BLOCKED&topic_class=eq.payment&order=updated_at.asc&limit=1');
    return rows && rows[0] ? rows[0] : null;
  },
  requeueConfigBlocked(reason) {
    return rpc('mp_requeue_config_blocked', { p_reason: reason });
  },
  async pendingApiSources(limit) {
    const rows = await select<{ id: string }>(`mp_source_record?select=id&source_type=eq.api_payment&processing_status=eq.PENDING&order=ingested_at.asc&limit=${limit}`);
    return (rows ?? []).map((r) => r.id);
  },
  async unappliedMovements(limit) {
    const rows = await select<MvRow>(`mp_financial_movement?select=id,movement_kind,net_amount,mp_reconciliation(assigned_amount)&movement_kind=in.(payment,yield)&order=id.desc&limit=${limit * 5}`);
    return (rows ?? []).filter((m) => assigned(m) === 0).slice(0, limit).map((m) => m.id);
  },
  async postedPaymentMovements(since, limit) {
    const rows = await select<MvRow>(`mp_financial_movement?select=id,movement_kind,net_amount,occurred_date,mp_reconciliation(assigned_amount)&movement_kind=eq.payment&occurred_date=gte.${since}&order=id.desc&limit=${limit}`);
    return (rows ?? []).filter((m) => assigned(m) === Number(m.net_amount)).map((m) => m.id);
  },
};

// ── Mercado Pago adapter: GET /v1/payments/{id} only ─────────────────────────
const mpApi: MpApi = {
  async getPayment(pid): Promise<MpResponse> {
    let res: Response;
    try {
      res = await fetch(`${MP_BASE}/v1/payments/${pid}`, {
        method: 'GET', headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { failure: err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network' };
    }
    const text = await res.text();
    let body: unknown = undefined;
    try {
      body = JSON.parse(text);
    } catch { /* non-JSON body */ }
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body };
  },
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 405 });
  if (!secretMatches(req.headers.get(WORKER_INVOKE_HEADER))) {
    log({ event: 'WORKER_UNAUTHORIZED' });
    return reply(401, { error: 401 });
  }
  if (!TOKEN || !COLLECTOR || !SUPABASE_URL || !SERVICE_KEY) {
    log({ event: 'WORKER_CONFIG_MISSING' });
    return reply(500, { error: 500 });
  }
  await req.body?.cancel();
  const summary = await runWorker({ db, mpApi, clock: { now: () => Date.now() }, log, config: { collectorId: COLLECTOR }, state: STATE });
  return reply(200, summary);
});
