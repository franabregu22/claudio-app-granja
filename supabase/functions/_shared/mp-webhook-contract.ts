/**
 * ADR-006 V-1 — Mercado Pago webhook notification contract (pure module).
 *
 * Authority: .planning/implementation-design/ADR006_V1_WEBHOOK_EVIDENCE.md
 * (official Mercado Pago documentation, rechecked 2026-09-28).
 *
 * Pure: no env reads, no network, no DB, no logging. The secret and the clock
 * are injected. Reasons are fixed codes and never contain the secret, the
 * received or computed signature, the manifest, or any prefix of them.
 *
 * Scope: notification ENVELOPE only (V-1). Payment resource fields are V-2 and
 * are not read here.
 *
 * Runs under Deno (Edge Functions) and Node >= 22.18 (type stripping) through
 * the node:crypto / node:buffer built-ins. Erasable TypeScript syntax only.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

// INTERNAL_POLICY: the official docs only say the ts "can" be used to set a
// delay tolerance; the window itself is ours (ADR006_WEBHOOK_WORKER_DESIGN_V1 §3).
export const FRESHNESS_TOLERANCE_MS = 15 * 60 * 1000;

// V-1 topic table: exact `type` strings from the official docs. Anything else
// is unsupported. Nothing is inferred from prefixes or from `action`.
export const TOPIC_TABLE: Readonly<Record<string, 'payment' | 'chargeback'>> = Object.freeze({
  payment: 'payment',
  topic_chargebacks_wh: 'chargeback',
});

export type TopicClass = 'payment' | 'chargeback' | 'unsupported';

type HeaderSource = Headers | Record<string, string | string[] | undefined>;
type QuerySource = URLSearchParams | Record<string, string | string[] | undefined>;

export interface VerifySignatureInput {
  headers: HeaderSource;
  query: QuerySource;
  rawBody?: string;
  secret: string;
  now: number;
}

export interface VerifySignatureResult {
  ok: boolean;
  reason?: string;
}

function firstValue(v: string | string[] | null | undefined): string | null {
  if (Array.isArray(v)) return v.length === 1 ? v[0] : null;
  return typeof v === 'string' ? v : null;
}

function getHeader(headers: HeaderSource, name: string): string | null {
  if (headers && typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  let found: string | null = null;
  let count = 0;
  for (const key of Object.keys(rec ?? {})) {
    if (key.toLowerCase() === name) {
      found = firstValue(rec[key]);
      count++;
    }
  }
  return count === 1 ? found : null;
}

function getQuery(query: QuerySource, name: string): string | null {
  if (query && typeof (query as URLSearchParams).getAll === 'function') {
    const all = (query as URLSearchParams).getAll(name);
    return all.length === 1 ? all[0] : null;
  }
  const rec = query as Record<string, string | string[] | undefined>;
  return rec && Object.prototype.hasOwnProperty.call(rec, name) ? firstValue(rec[name]) : null;
}

function present(v: string | null): v is string {
  return v !== null && v !== '';
}

/** Parses `ts=<digits>,v1=<64 hex>`; parts separated by `,`, key/value by the first `=`. */
function parseSignatureHeader(header: string): { ts: string; v1: string } | null {
  const parts: Record<string, string> = {};
  for (const raw of header.split(',')) {
    const part = raw.trim();
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (Object.prototype.hasOwnProperty.call(parts, key)) return null;
    parts[key] = value;
  }
  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (ts === undefined || v1 === undefined) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(v1)) return null;
  return { ts, v1: v1.toLowerCase() };
}

/**
 * `ts` → epoch milliseconds. The docs state milliseconds, but one official
 * example is 10 digits (seconds). INTERNAL_POLICY: 13 digits = ms, 10 digits =
 * seconds; anything else is malformed. The HMAC always uses `ts` verbatim.
 */
function tsToMillis(ts: string): number | null {
  if (/^[0-9]{13}$/.test(ts)) return Number(ts);
  if (/^[0-9]{10}$/.test(ts)) return Number(ts) * 1000;
  return null;
}

/** Official manifest: `id:[data.id];request-id:[x-request-id];ts:[ts];`, absent parts removed. */
function buildManifest(dataId: string | null, requestId: string | null, ts: string): string {
  let manifest = '';
  if (present(dataId)) manifest += `id:${dataId.toLowerCase()};`;
  if (present(requestId)) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  return manifest;
}

export function verifySignature(input: VerifySignatureInput): VerifySignatureResult {
  const { headers, query, secret, now } = input ?? ({} as VerifySignatureInput);
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'MISSING_SECRET' };
  if (typeof now !== 'number' || !Number.isFinite(now)) return { ok: false, reason: 'INVALID_CLOCK' };

  const header = getHeader(headers, 'x-signature');
  if (!present(header)) return { ok: false, reason: 'MISSING_SIGNATURE_HEADER' };

  const parsed = parseSignatureHeader(header);
  if (parsed === null) return { ok: false, reason: 'MALFORMED_SIGNATURE_HEADER' };

  const tsMillis = tsToMillis(parsed.ts);
  if (tsMillis === null) return { ok: false, reason: 'MALFORMED_TIMESTAMP' };

  const manifest = buildManifest(getQuery(query, 'data.id'), getHeader(headers, 'x-request-id'), parsed.ts);
  const expected = createHmac('sha256', secret).update(manifest, 'utf8').digest();
  const received = Buffer.from(parsed.v1, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: 'SIGNATURE_MISMATCH' };
  }

  if (tsMillis < now - FRESHNESS_TOLERANCE_MS) return { ok: false, reason: 'STALE_TIMESTAMP' };
  if (tsMillis > now + FRESHNESS_TOLERANCE_MS) return { ok: false, reason: 'FUTURE_TIMESTAMP' };
  return { ok: true };
}

/** Exact-match topic table; `action` never changes the class. */
export function classifyTopic(type: unknown, _action?: unknown): TopicClass {
  if (typeof type !== 'string') return 'unsupported';
  return Object.prototype.hasOwnProperty.call(TOPIC_TABLE, type) ? TOPIC_TABLE[type] : 'unsupported';
}

export interface NotificationIdentity {
  ok: boolean;
  reason?: string;
  resourceId: string | null;
  notificationId: null;
}

/**
 * Resource id = the query `data.id` (the signed manifest component), lowercased
 * as signed. A body `data.id` given as a string, or as a safe-integer number,
 * must agree with it. Unsafe JSON-number body ids are not compared: official
 * chargeback examples exceed the JS safe integer range.
 *
 * notificationId is always null: the official docs name the body `id`
 * "Notification ID" but do not document that it is stable across retries, so
 * the DB derives the `h:` key. x-request-id is never an identity.
 */
export function extractNotificationIdentity(input: {
  topicClass: TopicClass;
  query: QuerySource;
  body: unknown;
}): NotificationIdentity {
  const { topicClass, query, body } = input;
  const fail = (reason: string): NotificationIdentity => ({ ok: false, reason, resourceId: null, notificationId: null });
  if (topicClass === 'unsupported') return { ok: true, resourceId: null, notificationId: null };

  const queryId = getQuery(query, 'data.id');
  if (!present(queryId)) return fail('MISSING_RESOURCE_ID');
  const resourceId = queryId.toLowerCase();

  const data = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['data'] : undefined;
  const bodyId = data !== null && typeof data === 'object' ? (data as Record<string, unknown>)['id'] : undefined;
  if (typeof bodyId === 'string' && bodyId.toLowerCase() !== resourceId) return fail('RESOURCE_ID_MISMATCH');
  if (typeof bodyId === 'number' && Number.isSafeInteger(bodyId) && String(bodyId) !== resourceId) {
    return fail('RESOURCE_ID_MISMATCH');
  }

  if (topicClass === 'payment' && !/^[0-9]{1,20}$/.test(resourceId)) return fail('INVALID_PAYMENT_RESOURCE_ID');
  if (topicClass === 'chargeback' && !/^[0-9a-z._:-]{1,120}$/.test(resourceId)) return fail('INVALID_CHARGEBACK_RESOURCE_ID');

  return { ok: true, resourceId, notificationId: null };
}
