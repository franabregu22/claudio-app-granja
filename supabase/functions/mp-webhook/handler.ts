/**
 * ADR-006 Step 4 — mp-webhook request handler (runtime-agnostic core).
 *
 * Authority: ADR006_WEBHOOK_WORKER_DESIGN_V1 §2, ADR006_V1_WEBHOOK_EVIDENCE.md,
 * ADR006_RPC_CONTRACTS_V1 S1, 0047 + 0049 chk_delivery_payload_keys.
 *
 * Notification ENVELOPE only (V-1). No Mercado Pago payment-resource field is
 * read, and no Mercado Pago API is called. Configuration, persistence, the
 * worker kick and logging are injected; this module reads no environment.
 *
 * Logs carry only {event, request_id, reason, status}: never the secret, the
 * signature, the manifest or the payload.
 */

import {
  verifySignature,
  classifyTopic,
  extractNotificationIdentity,
  type TopicClass,
} from '../_shared/mp-webhook-contract.ts';

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT = 200;

export interface RegisterDeliveryParams {
  p_origin: 'webhook';
  p_topic: string;
  p_topic_class: TopicClass;
  p_action: string | null;
  p_resource_id: string | null;
  p_notification_id: null;
  p_x_request_id: string | null;
  p_notification_payload: Record<string, unknown>;
  p_signature_verified: true;
}

export interface WebhookLogEntry {
  event: string;
  request_id: string | null;
  reason?: string;
  status?: number;
}

export interface WebhookDeps {
  /** Null when the runtime secret / collector id are not configured. */
  config: { webhookSecret: string; collectorId: string } | null;
  /** Resolves on a successful registration (created or duplicate); throws on any DB failure. */
  registerDelivery(params: RegisterDeliveryParams): Promise<void>;
  /** Best-effort worker kick, scheduled after the response; must never throw. */
  scheduleKick(): void;
  log(entry: WebhookLogEntry): void;
  now(): number;
}

// ── JSON with source-text access for integers beyond Number.MAX_SAFE_INTEGER ──
class UnsafeNumber {
  readonly source: string | null;
  constructor(source: string | null) {
    this.source = source;
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      const source = typeof context?.source === 'string' && /^-?[0-9]+$/.test(context.source) ? context.source : null;
      return new UnsafeNumber(source);
    }
    return value;
  });
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof UnsafeNumber)
    ? (v as Record<string, unknown>)
    : null;
}

function shortString(v: unknown, max = MAX_TEXT): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** A JSON scalar id (string, safe number, or the raw text of an unsafe integer) as sent. */
function idScalar(v: unknown): string | number | null {
  if (typeof v === 'string') return v.length > 0 && v.length <= MAX_TEXT ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof UnsafeNumber) return v.source;
  return null;
}

function digitString(v: unknown): string | null {
  const s = idScalar(v);
  const text = typeof s === 'number' ? (Number.isSafeInteger(s) ? String(s) : null) : s;
  return text !== null && /^[0-9]{1,20}$/.test(text) ? text : null;
}

function singleQuery(url: URL, name: string): string | null {
  const all = url.searchParams.getAll(name);
  return all.length === 1 && all[0] !== '' ? all[0] : null;
}

function traceId(v: string | null): string | null {
  return v !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(v) ? v : null;
}

const JSON_HEADERS = { 'content-type': 'application/json' };
function respond(status: number): Response {
  return new Response(status === 200 ? '{}' : JSON.stringify({ error: status }), { status, headers: JSON_HEADERS });
}

export async function handleMpWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const requestId = traceId(req.headers.get('x-request-id'));
  const done = (status: number, event: string, reason?: string): Response => {
    deps.log({ event, request_id: requestId, reason, status });
    return respond(status);
  };

  // 1. method
  if (req.method !== 'POST') return done(405, 'REJECTED', 'METHOD_NOT_ALLOWED');

  // 2. size (declared, then actual)
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return done(413, 'REJECTED', 'BODY_TOO_LARGE');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return done(400, 'REJECTED', 'BODY_UNREADABLE');
  }
  if (bytes.byteLength > MAX_BODY_BYTES) return done(413, 'REJECTED', 'BODY_TOO_LARGE');

  // 3. JSON object
  let rawBody: string;
  let body: Record<string, unknown> | null;
  try {
    rawBody = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    body = obj(parseJson(rawBody));
  } catch {
    return done(400, 'REJECTED', 'INVALID_JSON');
  }
  if (body === null) return done(400, 'REJECTED', 'INVALID_JSON');

  if (deps.config === null) return done(500, 'CONFIG_MISSING', 'WEBHOOK_NOT_CONFIGURED');

  // 4–5. signature (headers x-signature / x-request-id, query data.id; body is not signed)
  const url = new URL(req.url);
  const sig = verifySignature({
    headers: req.headers,
    query: url.searchParams,
    rawBody,
    secret: deps.config.webhookSecret,
    now: deps.now(),
  });
  if (!sig.ok) return done(401, 'REJECTED', sig.reason ?? 'SIGNATURE_INVALID');

  // 6. ownership envelope
  const userId = idScalar(body['user_id']);
  if (body['live_mode'] !== true || userId === null || String(userId) !== deps.config.collectorId) {
    return done(200, 'IGNORED_FOREIGN_OR_TEST');
  }

  // 7. topic (body type/topic, cross-checked with the query when both are present)
  const bodyTopic = shortString(body['type'], 50) ?? shortString(body['topic'], 50);
  const queryTopic = singleQuery(url, 'type') ?? singleQuery(url, 'topic');
  if (bodyTopic !== null && queryTopic !== null && bodyTopic !== queryTopic) return done(400, 'REJECTED', 'TOPIC_MISMATCH');
  const topic = bodyTopic ?? (queryTopic !== null && queryTopic.length <= 50 ? queryTopic : null);
  if (topic === null) return done(400, 'REJECTED', 'MISSING_TOPIC');
  const action = shortString(body['action'], 50);
  const topicClass = classifyTopic(topic, action);

  // 8. identity: the signed query data.id; notificationId stays null (V-1)
  const identity = extractNotificationIdentity({ topicClass, query: url.searchParams, body });
  if (!identity.ok) return done(400, 'REJECTED', identity.reason ?? 'INVALID_IDENTITY');

  // 9. reduced payload (allow-list; key set enforced again by chk_delivery_payload_keys)
  const payload: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) payload[key] = value;
  };
  put('type', shortString(body['type'], 50));
  put('topic', shortString(body['topic'], 50));
  put('action', action);
  const signedDataId = singleQuery(url, 'data.id');
  put('data_id', identity.resourceId ??
    (signedDataId !== null && /^[0-9a-z._:-]{1,120}$/.test(signedDataId.toLowerCase()) ? signedDataId.toLowerCase() : null));
  put('live_mode', true);
  put('user_id', userId);
  put('api_version', shortString(body['api_version'], 20));
  put('date_created', shortString(body['date_created'], 40));
  put('notification_id', idScalar(body['id']));
  if (topicClass === 'chargeback') {
    const actions = body['actions'];
    if (Array.isArray(actions) && actions.length <= 10 && actions.every((a) => shortString(a, 50) !== null)) {
      put('actions', actions);
    }
    const data = obj(body['data']);
    put('data_payment_id', data === null ? null : digitString(data['payment_id']));
  }

  // 10–12. register; the database derives N-SHA and the delivery key
  try {
    await deps.registerDelivery({
      p_origin: 'webhook',
      p_topic: topic,
      p_topic_class: topicClass,
      p_action: action,
      p_resource_id: identity.resourceId,
      p_notification_id: null,
      p_x_request_id: requestId,
      p_notification_payload: payload,
      p_signature_verified: true,
    });
  } catch {
    return done(500, 'DB_REGISTER_FAILED');
  }

  if (topicClass !== 'unsupported') deps.scheduleKick();
  return done(200, topicClass === 'unsupported' ? 'REGISTERED_UNSUPPORTED' : 'REGISTERED');
}
