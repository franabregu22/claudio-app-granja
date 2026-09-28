#!/usr/bin/env node
/**
 * ADR-006 Step 4 — mp-webhook tests (ADR006_TEST_MATRIX_V1 block W; Step-4 prompt W1–W10).
 *
 * Run (local stack up with kong + rest + edge runtime, target DB at 0001–0049):
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/mp_webhook.test.mjs
 *
 * U — the handler core with injected mocks (no network).
 * W — the real function under `supabase functions serve` (spawned here, local-only argv
 *     proven by the guard) against the local database. Deterministic test secret and
 *     collector id; no Mercado Pago contact; no MP_ACCESS_TOKEN anywhere.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { assertSafeDestructiveTarget, assertSafeCliOperation, assertNoProductionCredentials } from '../test-env/guard.mjs';
import { handleMpWebhook, MAX_BODY_BYTES } from '../../supabase/functions/mp-webhook/handler.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
const SECRET = 'mp-webhook-local-test-secret-not-real';
const COLLECTOR = '900000001';
const WORKER_SECRET = 'mp-worker-local-test-invoke-secret';
const FN_URL = process.env.MP_WEBHOOK_URL || 'http://127.0.0.1:54321/functions/v1/mp-webhook';
const RID = 'W4T-';
const container = 'supabase_db_Claudio_app_Granja';

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  cond ? pass++ : fail++;
  console.log(`    ${cond ? 'OK  ' : 'MAL '} ${label}${cond ? '' : ` :: ${detail}`}`);
}
const section = (id, t) => console.log(`\n  ${id} — ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── DB (owner, via docker exec psql) ───────────────────────────────────────────
function resolveBin(name, candidates) {
  const onPath = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return name;
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`${name} not found`);
}
const DOCKER = resolveBin('docker', [resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe')]);
const SUPABASE = resolveBin('supabase', [
  resolve(process.env.APPDATA ?? '', 'npm', 'node_modules', 'supabase', 'node_modules', '@supabase', 'cli-windows-x64', 'bin', 'supabase.exe'),
  resolve(process.env.APPDATA ?? '', 'npm', 'node_modules', 'supabase', 'bin', 'supabase.exe'),
]);
function owner(sqlText) {
  const r = spawnSync(DOCKER, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sqlText, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`owner SQL failed:\n${sqlText}\n${r.stderr}`);
  return (r.stdout || '').trim();
}
const TABLE_COUNTS_SQL = `SELECT string_agg(table_name || '=' || (xpath('/row/c/text()',
  query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text, ',' ORDER BY table_name)
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';`;
const snapshot = () => Object.fromEntries(owner(TABLE_COUNTS_SQL).split(',').map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
function delta(before, after) {
  const d = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if ((after[k] ?? 0) !== (before[k] ?? 0)) d[k] = (after[k] ?? 0) - (before[k] ?? 0);
  return d;
}
const deliveries = (where) => JSON.parse(owner(`SELECT coalesce(json_agg(row_to_json(d) ORDER BY received_at), '[]') FROM
  (SELECT id, delivery_key, notification_sha256, origin, topic, topic_class, action, resource_id, x_request_id,
          notification_payload, signature_verified, status::text AS status, key_conflict_of, received_at FROM mp_webhook_delivery WHERE ${where}) d;`));
function cleanup() {
  owner(`
DROP TRIGGER IF EXISTS w4t_fault ON mp_webhook_delivery;
DROP FUNCTION IF EXISTS w4t_fault_fn();
CREATE TEMP TABLE _dl AS SELECT id FROM mp_webhook_delivery WHERE x_request_id LIKE '${RID}%';
DELETE FROM audit_events WHERE entity_type = 'mp_webhook_delivery' AND entity_id IN (SELECT id::TEXT FROM _dl);
DELETE FROM mp_webhook_delivery WHERE key_conflict_of IN (SELECT id FROM _dl) OR triggered_by_delivery_id IN (SELECT id FROM _dl);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);`);
}

// ── signed fixtures (official recipe, ADR006_V1_WEBHOOK_EVIDENCE §3) ─────────────
function sign({ dataId, requestId, ts = String(Date.now()), secret = SECRET }) {
  let m = '';
  if (dataId) m += `id:${String(dataId).toLowerCase()};`;
  if (requestId) m += `request-id:${requestId};`;
  m += `ts:${ts};`;
  return `ts=${ts},v1=${createHmac('sha256', secret).update(m, 'utf8').digest('hex')}`;
}
const run = Date.now().toString().slice(-8);
const pid = (n) => `97${run}${String(n).padStart(2, '0')}`; // unique numeric payment ids per run
function paymentBody(id, over = {}) {
  return { action: 'payment.updated', api_version: 'v1', data: { id }, date_created: '2026-09-28T12:00:00Z',
    id: `n-${id}`, live_mode: true, type: 'payment', user_id: Number(COLLECTOR), ...over };
}
const CB_ID = `23300006168${run.slice(-7)}`; // 18 digits: beyond Number.MAX_SAFE_INTEGER, as in the official example
const chargebackRaw = (cbId, paymentId) => `{"actions":["changed_case_status"],"api_version":"v1","application_id":1234,` +
  `"data":{"checkout":"PRO","date_updated":"2026-09-28T12:00:00.000-04:00","id":${cbId},"payment_id":${paymentId},` +
  `"product_id":"TEST","site_id":"MLA","transaction_intent_id":""},"date_created":"2026-09-28T12:00:01.000-04:00",` +
  `"id":114411153595,"live_mode":true,"type":"topic_chargebacks_wh","user_id":${COLLECTOR},"version":1}`;

async function post({ query = {}, body, raw, headers = {}, method = 'POST', sig = true, requestId, dataId, ts }) {
  const url = new URL(FN_URL);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const h = { 'content-type': 'application/json', ...headers };
  if (requestId) h['x-request-id'] = requestId;
  if (sig) h['x-signature'] = sign({ dataId: dataId ?? query['data.id'], requestId, ts });
  const res = await fetch(url, { method, headers: h, body: method === 'GET' ? undefined : (raw ?? JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

// ════════════════════════════════════════════════════════════════════════════
// U — handler core with mocks
// ════════════════════════════════════════════════════════════════════════════
async function unit() {
  section('U', 'handler core (mocks; no network)');
  const logs = [];
  const calls = [];
  let kicks = 0;
  const deps = (over = {}) => ({
    config: { webhookSecret: SECRET, collectorId: COLLECTOR },
    registerDelivery: async (p) => { calls.push(p); },
    scheduleKick: () => { kicks++; },
    log: (e) => logs.push(JSON.stringify(e)),
    now: () => Date.now(),
    ...over,
  });
  const req = (id, over = {}, headers = {}) => {
    const rid = `${RID}u-${id}`;
    return new Request(`http://x/mp-webhook?data.id=${id}&type=payment`, { method: 'POST',
      headers: { 'x-request-id': rid, 'x-signature': sign({ dataId: id, requestId: rid }), ...headers },
      body: JSON.stringify(paymentBody(String(id), over)) });
  };

  let r = await handleMpWebhook(req(111), deps());
  check('U1 valid → 200 {} and exactly one registration with notification_id null', r.status === 200 && (await r.text()) === '{}'
    && calls.length === 1 && calls[0].p_notification_id === null && calls[0].p_origin === 'webhook' && calls[0].p_signature_verified === true);
  check('U2 kick scheduled once after a successful registration', kicks === 1);
  r = await handleMpWebhook(req(112), deps({ registerDelivery: async () => { throw new Error('db down'); } }));
  check('U3 registration failure → 500; no kick', r.status === 500 && kicks === 1);
  r = await handleMpWebhook(req(113), deps({ config: null }));
  check('U4 missing runtime config → 500; nothing registered', r.status === 500 && calls.length === 1);
  const before = calls.length;
  r = await handleMpWebhook(req(114, { user_id: 1 }), deps());
  check('U5 foreign collector → 200; nothing registered; no kick', r.status === 200 && calls.length === before && kicks === 1);
  r = await handleMpWebhook(req(115, { payer: { email: 'x@example.invalid' }, transaction_amount: 10 }), deps());
  const p = calls.at(-1).p_notification_payload;
  check('U6 payload is the allow-list only (no payer / amount / unknown key)',
    r.status === 200 && Object.keys(p).every((k) => ['type', 'topic', 'action', 'data_id', 'live_mode', 'user_id', 'api_version', 'date_created', 'notification_id'].includes(k)),
    JSON.stringify(p));
  r = await handleMpWebhook(new Request('http://x/mp-webhook?data.id=116&type=merchant_order', { method: 'POST',
    headers: { 'x-request-id': `${RID}u-116`, 'x-signature': sign({ dataId: '116', requestId: `${RID}u-116` }) },
    body: JSON.stringify(paymentBody('116', { type: 'merchant_order', action: 'x' })) }), deps());
  check('U7 unsupported → registered as unsupported; no kick', r.status === 200 && calls.at(-1).p_topic_class === 'unsupported' && kicks === 2);
  r = await handleMpWebhook(new Request('http://x/mp-webhook?data.id=117&type=merchant_order', { method: 'POST',
    headers: { 'x-request-id': `${RID}u-117`, 'x-signature': sign({ dataId: '117', requestId: `${RID}u-117` }) },
    body: JSON.stringify(paymentBody('117')) }), deps());
  check('U8 body type ≠ query type → 400 TOPIC_MISMATCH; nothing registered', r.status === 400 && logs.at(-1).includes('TOPIC_MISMATCH'));
  r = await handleMpWebhook(new Request('http://x/mp-webhook', { method: 'POST', headers: { 'content-length': String(MAX_BODY_BYTES + 1) }, body: 'x' }), deps());
  check('U9 declared Content-Length over 64 KB → 413 before reading', r.status === 413);

  const statuses = [];
  for (const [rq, dp] of [
    [req(120), deps()], // 200
    [req(121, {}, { 'x-signature': 'ts=1,v1=00' }), deps()], // 401
    [new Request('http://x/mp-webhook', { method: 'GET' }), deps()], // 405
    [new Request('http://x/mp-webhook', { method: 'POST', body: '{x' }), deps()], // 400
    [new Request('http://x/mp-webhook', { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES + 1) }), deps()], // 413
    [req(122), deps({ registerDelivery: async () => { throw new Error('x'); } })], // 500
  ]) {
    const res = await handleMpWebhook(rq, dp);
    statuses.push(res.status);
    if ([...res.headers.keys()].some((k) => k.startsWith('access-control-'))) statuses.push('CORS');
  }
  check('U15 no Access-Control-* header on any function response (200/401/405/400/413/500)',
    JSON.stringify(statuses) === JSON.stringify([200, 401, 405, 400, 413, 500]), JSON.stringify(statuses));
  // The local Kong gateway adds its own CORS header in front of every function; that is
  // gateway configuration, not this function, so it is asserted here on the function's Response.

  const joined = logs.join('\n');
  const sigHex = sign({ dataId: '111', requestId: `${RID}u-111` }).split('v1=')[1];
  check('U10 logs hold no secret, signature, manifest, payload value or payer data',
    !joined.includes(SECRET) && !joined.includes(sigHex.slice(0, 16)) && !joined.includes('request-id:') && !joined.includes('ts=')
    && !joined.includes('payment.updated') && !joined.includes('example.invalid') && !joined.includes(COLLECTOR), joined);
  check('U11 log entries carry only event / request_id / reason / status',
    logs.every((l) => Object.keys(JSON.parse(l)).every((k) => ['event', 'request_id', 'reason', 'status'].includes(k))));

  const src = ['index.ts', 'handler.ts'].map((f) => readFileSync(join(REPO, 'supabase', 'functions', 'mp-webhook', f), 'utf8')).join('\n');
  check('U12 no MP_ACCESS_TOKEN read in the function', !/env(\.get)?\(\s*['"]MP_ACCESS_TOKEN/.test(src) && !/['"]MP_ACCESS_TOKEN['"]/.test(src));
  check('U13 no Mercado Pago API host and no CORS header in the function source',
    !/api\.mercadopago\.com/i.test(src) && !/access-control-allow-origin/i.test(src));
  check('U14 env is read only in index.ts, never in handler.ts or the shared contract',
    !/Deno\.env|process\.env/.test(readFileSync(join(REPO, 'supabase', 'functions', 'mp-webhook', 'handler.ts'), 'utf8'))
    && !/Deno\.env|process\.env/.test(readFileSync(join(REPO, 'supabase', 'functions', '_shared', 'mp-webhook-contract.ts'), 'utf8')));
}

// ════════════════════════════════════════════════════════════════════════════
// W — real function under `supabase functions serve`
// ════════════════════════════════════════════════════════════════════════════
async function startServe(envPath) {
  const args = ['functions', 'serve', '--no-verify-jwt', '--env-file', envPath];
  assertSafeCliOperation(args);
  const child = spawn(SUPABASE, args, { cwd: REPO, env: { ...process.env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const t0 = Date.now();
  // the previous edge-runtime container keeps answering until this serve replaces it:
  // wait for this process to announce its own runtime first
  while (Date.now() - t0 < 180000) {
    if (!out.includes('Serving functions on')) { await sleep(500); continue; }
    try {
      const r = await fetch(FN_URL, { method: 'GET' });
      await r.text();
      if (r.status === 405) return { child, output: () => out };
    } catch { /* not ready */ }
    await sleep(1000);
  }
  child.kill();
  throw new Error(`functions serve did not become ready\n${out.slice(-2000)}`);
}

async function integration() {
  section('W', 'mp-webhook under supabase functions serve (local stack)');
  const dir = mkdtempSync(join(tmpdir(), 'mpwh-'));
  const envPath = join(dir, 'mp-webhook.env');
  writeFileSync(envPath, `MP_WEBHOOK_SECRET=${SECRET}\nMP_COLLECTOR_ID=${COLLECTOR}\nWORKER_INVOKE_SECRET=${WORKER_SECRET}\n`);
  const serve = await startServe(envPath);
  try {
    // W1 — valid payment
    const p1 = pid(1);
    let s0 = snapshot();
    let r = await post({ query: { 'data.id': p1, type: 'payment' }, body: paymentBody(p1), requestId: `${RID}r1` });
    let rows = deliveries(`resource_id = '${p1}'`);
    let d = delta(s0, snapshot());
    const w1 = rows[0] ?? {};
    check('W1 200 {} (worker kick target absent: response unaffected)', r.status === 200 && r.text === '{}', `${r.status} ${r.text}`);
    check('W1 exactly one delivery: webhook / payment / RECEIVED / resource id from the query',
      rows.length === 1 && w1.origin === 'webhook' && w1.topic === 'payment' && w1.topic_class === 'payment' && w1.status === 'RECEIVED'
      && w1.resource_id === p1 && w1.action === 'payment.updated' && w1.signature_verified === true, JSON.stringify(rows));
    check('W1 delivery_key is h:<N-SHA> (no documented stable notification id); x-request-id stored, not the key',
      w1.delivery_key === `h:${w1.notification_sha256}` && w1.x_request_id === `${RID}r1` && !w1.delivery_key.includes('W4T'));
    const nsha = owner(`SELECT encode(sha256(convert_to(jsonb_build_array(origin, topic_class, topic, action, resource_id, notification_payload)::text,'UTF8')),'hex')
      FROM mp_webhook_delivery WHERE id = '${w1.id}';`);
    check('W1 notification_sha256 equals an independent SQL N-SHA evaluation', nsha === w1.notification_sha256);
    check('W1 reduced payload = allow-list only', JSON.stringify(Object.keys(w1.notification_payload ?? {}).sort()) ===
      JSON.stringify(['action', 'api_version', 'data_id', 'date_created', 'live_mode', 'notification_id', 'type', 'user_id']), JSON.stringify(w1.notification_payload));
    check('W1 only mp_webhook_delivery (+1) and audit_events (+1) changed', JSON.stringify(d) === JSON.stringify({ audit_events: 1, mp_webhook_delivery: 1 }), JSON.stringify(d));

    // W2 — same canonical notification twice (byte-identical, same x-request-id)
    s0 = snapshot();
    r = await post({ query: { 'data.id': p1, type: 'payment' }, body: paymentBody(p1), requestId: `${RID}r1` });
    d = delta(s0, snapshot());
    check('W2 duplicate → 200 {}; Δ = 0 (one durable delivery)', r.status === 200 && r.text === '{}' && Object.keys(d).length === 0
      && deliveries(`resource_id = '${p1}'`).length === 1, `${r.status} ${r.text} ${JSON.stringify(d)}`);

    // W3 — same notification, different x-request-id
    s0 = snapshot();
    r = await post({ query: { 'data.id': p1, type: 'payment' }, body: paymentBody(p1), requestId: `${RID}r2` });
    d = delta(s0, snapshot());
    rows = deliveries(`resource_id = '${p1}'`);
    check('W3 different x-request-id → 200; Δ = 0; identity from canonical content, stored x_request_id unchanged',
      r.status === 200 && Object.keys(d).length === 0 && rows.length === 1 && rows[0].x_request_id === `${RID}r1`, JSON.stringify(d));

    // W4 — chargeback (official shape; data.id beyond the JS safe integer range)
    const payRef = '81968653106';
    s0 = snapshot();
    r = await post({ query: { 'data.id': CB_ID, type: 'topic_chargebacks_wh' }, raw: chargebackRaw(CB_ID, payRef), requestId: `${RID}cb1` });
    d = delta(s0, snapshot());
    rows = deliveries(`x_request_id = '${RID}cb1'`);
    const cb = rows[0] ?? {};
    check('W4 200; one chargeback delivery, RECEIVED (never UNSUPPORTED)',
      r.status === 200 && rows.length === 1 && cb.topic_class === 'chargeback' && cb.status === 'RECEIVED' && cb.topic === 'topic_chargebacks_wh', `${r.status} ${JSON.stringify(rows)}`);
    check('W4 resource id = the signed query id verbatim (the unsafe JSON number never replaces it)',
      cb.resource_id === CB_ID && cb.notification_payload?.data_id === CB_ID, JSON.stringify(cb));
    check('W4 data.payment_id retained only as envelope evidence (data_payment_id) with actions',
      cb.notification_payload?.data_payment_id === payRef && JSON.stringify(cb.notification_payload?.actions) === '["changed_case_status"]'
      && cb.action === null, JSON.stringify(cb.notification_payload));
    check('W4 payload keys ⊆ allow-list (no checkout / product / site / application / version fields)',
      Object.keys(cb.notification_payload ?? {}).every((k) => ['type', 'actions', 'data_id', 'data_payment_id', 'live_mode', 'user_id', 'api_version', 'date_created', 'notification_id'].includes(k)),
      JSON.stringify(cb.notification_payload));
    check('W4 no financial write: only mp_webhook_delivery (+1) and audit_events (+1)',
      JSON.stringify(d) === JSON.stringify({ audit_events: 1, mp_webhook_delivery: 1 }), JSON.stringify(d));
    const cbOther = `${CB_ID.slice(0, -1)}${CB_ID.endsWith('9') ? '8' : '9'}`;
    r = await post({ query: { 'data.id': cbOther, type: 'topic_chargebacks_wh' }, raw: chargebackRaw(CB_ID, payRef), requestId: `${RID}cb2` });
    rows = deliveries(`x_request_id = '${RID}cb2'`);
    check('W4 unsafe body number is never compared or used: resource id stays the signed query id',
      r.status === 200 && rows.length === 1 && rows[0].resource_id === cbOther, JSON.stringify(rows));
    s0 = snapshot();
    r = await post({ query: { 'data.id': CB_ID, type: 'topic_chargebacks_wh' }, raw: chargebackRaw(CB_ID, payRef), requestId: `${RID}cb3` });
    check('W4 chargeback retried → 200; Δ = 0 (W-10)', r.status === 200 && Object.keys(delta(s0, snapshot())).length === 0);

    // W5 — unsupported authentic topic
    const mo = pid(5);
    s0 = snapshot();
    r = await post({ query: { 'data.id': mo, type: 'topic_merchant_order_wh' },
      body: paymentBody(mo, { type: 'topic_merchant_order_wh', action: 'update' }), requestId: `${RID}mo` });
    rows = deliveries(`x_request_id = '${RID}mo'`);
    check('W5 unsupported → 200; stored UNSUPPORTED (resource_id NULL, class unsupported)',
      r.status === 200 && rows.length === 1 && rows[0].status === 'UNSUPPORTED' && rows[0].topic_class === 'unsupported' && rows[0].resource_id === null,
      JSON.stringify(rows));
    check('W5 Δ = delivery +1, audit +1 only', JSON.stringify(delta(s0, snapshot())) === JSON.stringify({ audit_events: 1, mp_webhook_delivery: 1 }));

    // W6 — bad signature
    const p6 = pid(6);
    s0 = snapshot();
    const w6 = [];
    w6.push(await post({ query: { 'data.id': p6, type: 'payment' }, body: paymentBody(p6), requestId: `${RID}r6`, dataId: pid(7) }));
    w6.push(await post({ query: { 'data.id': p6, type: 'payment' }, body: paymentBody(p6), requestId: `${RID}r6`, sig: false }));
    w6.push(await post({ query: { 'data.id': p6, type: 'payment' }, body: paymentBody(p6), requestId: `${RID}r6`, sig: false,
      headers: { 'x-signature': sign({ dataId: p6, requestId: `${RID}r6`, secret: 'wrong-secret' }) } }));
    w6.push(await post({ query: { 'data.id': p6, type: 'payment' }, body: paymentBody(p6), requestId: `${RID}r6`, sig: false,
      headers: { 'x-signature': 'ts=abc,v1=zz' } }));
    check('W6 tampered / missing / wrong-secret / malformed signature → 401 each; nothing stored',
      w6.every((x) => x.status === 401) && Object.keys(delta(s0, snapshot())).length === 0, w6.map((x) => x.status).join(','));

    // W7 — stale / future
    s0 = snapshot();
    const stale = await post({ query: { 'data.id': p6, type: 'payment' }, body: paymentBody(p6), requestId: `${RID}r7`, ts: String(Date.now() - 16 * 60000) });
    const future = await post({ query: { 'data.id': p6, type: 'payment' }, body: paymentBody(p6), requestId: `${RID}r7`, ts: String(Date.now() + 16 * 60000) });
    check('W7 stale (−16 min) and future (+16 min) → 401; nothing stored',
      stale.status === 401 && future.status === 401 && Object.keys(delta(s0, snapshot())).length === 0, `${stale.status},${future.status}`);

    // W8 — foreign / test
    s0 = snapshot();
    const f1 = await post({ query: { 'data.id': p6, type: 'payment' }, body: paymentBody(p6, { user_id: 123 }), requestId: `${RID}r8` });
    const f2 = await post({ query: { 'data.id': p6, type: 'payment' }, body: paymentBody(p6, { live_mode: false }), requestId: `${RID}r8` });
    const f3 = await post({ query: { 'data.id': p6, type: 'payment' }, body: paymentBody(p6, { user_id: undefined }), requestId: `${RID}r8` });
    check('W8 foreign collector / live_mode false / no user_id → 200 {}; nothing stored',
      [f1, f2, f3].every((x) => x.status === 200 && x.text === '{}') && Object.keys(delta(s0, snapshot())).length === 0,
      [f1, f2, f3].map((x) => x.status).join(','));

    // W9 — malformed / oversized / wrong method
    s0 = snapshot();
    const bad = await post({ query: { 'data.id': p6, type: 'payment' }, raw: '{not json', requestId: `${RID}r9` });
    const arr = await post({ query: { 'data.id': p6, type: 'payment' }, raw: '[1,2]', requestId: `${RID}r9` });
    const big = await post({ query: { 'data.id': p6, type: 'payment' }, raw: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }), requestId: `${RID}r9` });
    const get = await post({ query: { 'data.id': p6, type: 'payment' }, method: 'GET', requestId: `${RID}r9` });
    const put = await post({ query: { 'data.id': p6, type: 'payment' }, method: 'PUT', body: paymentBody(p6), requestId: `${RID}r9` });
    check('W9 invalid JSON / non-object → 400; > 64 KB → 413; GET / PUT → 405; nothing stored',
      bad.status === 400 && arr.status === 400 && big.status === 413 && get.status === 405 && put.status === 405
      && Object.keys(delta(s0, snapshot())).length === 0, [bad, arr, big, get, put].map((x) => x.status).join(','));

    // body resource mismatch → rejected before persistence
    s0 = snapshot();
    const mm = await post({ query: { 'data.id': p6, type: 'payment' }, body: paymentBody(pid(8)), requestId: `${RID}mm` });
    check('W-extra body data.id ≠ signed query data.id → 400; nothing stored',
      mm.status === 400 && Object.keys(delta(s0, snapshot())).length === 0, String(mm.status));

    // W10 — DB registration failure (fault injected on the local table, removed afterwards)
    const p10 = pid(10);
    owner(`CREATE FUNCTION w4t_fault_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
             IF NEW.resource_id = '${p10}' THEN RAISE EXCEPTION 'W4T_FAULT'; END IF; RETURN NEW; END $$;
           CREATE TRIGGER w4t_fault BEFORE INSERT ON mp_webhook_delivery FOR EACH ROW EXECUTE FUNCTION w4t_fault_fn();`);
    s0 = snapshot();
    let w10;
    try {
      w10 = await post({ query: { 'data.id': p10, type: 'payment' }, body: paymentBody(p10), requestId: `${RID}r10` });
    } finally {
      owner('DROP TRIGGER IF EXISTS w4t_fault ON mp_webhook_delivery; DROP FUNCTION IF EXISTS w4t_fault_fn();');
    }
    check('W10 DB failure → 500 (no fake success); Δ = 0', w10.status === 500 && w10.text !== '{}' && Object.keys(delta(s0, snapshot())).length === 0,
      `${w10.status} ${w10.text}`);
    const retry = await post({ query: { 'data.id': p10, type: 'payment' }, body: paymentBody(p10), requestId: `${RID}r10` });
    check('W10 MP retry after recovery → 200; one delivery', retry.status === 200 && deliveries(`resource_id = '${p10}'`).length === 1);

    await sleep(1500);
    const logs = serve.output();
    const fnLines = logs.split('\n').filter((l) => l.includes('"fn":"mp-webhook"'));
    check('W-log function output holds no secret, invoke secret, signature, manifest or payload',
      fnLines.length > 0 && !logs.includes(SECRET) && !logs.includes(WORKER_SECRET) && !logs.includes('request-id:')
      && !logs.includes('changed_case_status') && !logs.includes(payRef)
      && fnLines.every((l) => !/[0-9a-f]{64}/.test(l) && !l.includes('ts=') && !l.includes('v1=')), logs.slice(-1500));
    check('W-log rejections are logged with a fixed reason', /"reason":"SIGNATURE_MISMATCH"/.test(logs) && /"event":"IGNORED_FOREIGN_OR_TEST"/.test(logs),
      logs.slice(-1500));
  } finally {
    if (process.env.MP_WEBHOOK_SERVE_LOG) writeFileSync(process.env.MP_WEBHOOK_SERVE_LOG, serve.output());
    serve.child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
assertNoProductionCredentials(process.env);
if ('MP_ACCESS_TOKEN' in process.env) throw new Error('MP_ACCESS_TOKEN must not be present for this suite');
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
cleanup();
try {
  await unit();
  await integration();
} finally {
  cleanup();
}
console.log(`\n  ══ MP WEBHOOK RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
