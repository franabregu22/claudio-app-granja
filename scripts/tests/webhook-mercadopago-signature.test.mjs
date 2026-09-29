/**
 * Mercado Pago webhook signature tests (fake values only; no network: global fetch is intercepted).
 *
 *   node --test scripts/tests/webhook-mercadopago-signature.test.mjs
 *
 * The handler is loaded through Vite's SSR module loader (TypeScript transform, no extra dependency).
 * Every outgoing request (Supabase service-role REST call or Mercado Pago API call) goes through fetch,
 * so the recorded calls prove whether any side effect happened before authentication.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SECRET = 'fake-webhook-secret-for-tests';
const REQUEST_ID = '0f3a1c2e-test-request';
const TS = '1700000000';
// Independently computed with: printf 'id:123456789;request-id:0f3a1c2e-test-request;ts:1700000000;' | openssl dgst -sha256 -hmac 'fake-webhook-secret-for-tests'
const V1_NUMERIC = '471e6f6dbdd0faa15e8b7442996deefffd51cbdab4286d3114cac6dbd429c264';
// Same, with manifest id 'abc123def' (alphanumeric ids are signed in lowercase)
const V1_ALNUM = '74dda13087c1912a51afba0afd795ade26628f9b33696f29b8d3d858e331f67e';

let server;
let mod;
const calls = [];

before(async () => {
  server = await createServer({ root: ROOT, configFile: false, envDir: resolve(ROOT, 'scripts', 'tests'), logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false } });
  mod = await server.ssrLoadModule('/netlify/functions/webhook-mercadopago.ts');
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 'fake-mp-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('api.mercadopago.com/v1/payments/')) return new Response(JSON.stringify({ id: 123456789, status: 'approved' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('[]', { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
});
after(async () => { await server?.close(); });

beforeEach(() => {
  calls.length = 0;
  process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
  process.env.SUPABASE_URL = 'http://supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
  process.env.MERCADOPAGO_CLIENT_ID = 'fake-client';
  process.env.MERCADOPAGO_CLIENT_SECRET = 'fake-client-secret';
});

const body = (id = '123456789', type = 'payment.updated') => JSON.stringify({ id: 999, type, action: 'payment.updated', data: { id } });
function event({ sig = `ts=${TS},v1=${V1_NUMERIC}`, rid = REQUEST_ID, dataId = '123456789', payload = body() } = {}) {
  const headers = {};
  if (sig !== null) headers['x-signature'] = sig;
  if (rid !== null) headers['x-request-id'] = rid;
  return { httpMethod: 'POST', headers, queryStringParameters: dataId === null ? {} : { 'data.id': dataId, type: 'payment' }, rawQuery: '', body: payload, isBase64Encoded: false };
}
const run = (ev) => mod.handler(ev, {});
async function rejected(ev) {
  const res = await run(ev);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0, 'no Supabase or Mercado Pago call before authentication');
  return res;
}

describe('verifyMercadoPagoSignature (known-good openssl fixtures)', () => {
  it('accepts the numeric fixture', () => {
    assert.deepEqual(mod.verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: `ts=${TS},v1=${V1_NUMERIC}`, requestId: REQUEST_ID, dataId: '123456789' }), { ok: true, dataId: '123456789' });
  });
  it('signs alphanumeric data ids in lowercase', () => {
    const r = mod.verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: `ts=${TS},v1=${V1_ALNUM}`, requestId: REQUEST_ID, dataId: 'ABC123DEF' });
    assert.deepEqual(r, { ok: true, dataId: 'abc123def' });
  });
  it('tolerates spaces around the header pairs and an uppercase digest', () => {
    assert.equal(mod.verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: ` ts=${TS} , v1=${V1_NUMERIC.toUpperCase()} `, requestId: REQUEST_ID, dataId: '123456789' }).ok, true);
  });
});

describe('webhook handler authentication (fail closed before side effects)', () => {
  it('1. correct signature: accepted past authentication', async () => {
    // reaches the post-authentication structure check (legacy 400 for a body without type/id)
    const structural = await run(event({ payload: JSON.stringify({ data: { id: '123456789' } }) }));
    assert.equal(structural.statusCode, 400);
    assert.equal(JSON.parse(structural.body).error, 'Invalid webhook');
    // a complete body proceeds into the unchanged legacy processing (never an auth rejection)
    const full = await run(event());
    assert.notEqual(full.statusCode, 401);
    assert.notEqual(JSON.parse(full.body).error, 'Unauthorized');
  });
  it('2. wrong signature -> 401', async () => { await rejected(event({ sig: `ts=${TS},v1=${'0'.repeat(64)}` })); });
  it('2b. signature for another ts -> 401', async () => { await rejected(event({ sig: `ts=1700000001,v1=${V1_NUMERIC}` })); });
  it('3. missing signature -> 401', async () => { await rejected(event({ sig: null })); });
  it('3b. empty signature -> 401', async () => { await rejected(event({ sig: '' })); });
  it('4. malformed signatures -> 401', async () => {
    for (const sig of ['garbage', 'ts=,v1=', `v1=${V1_NUMERIC}`, `ts=${TS}`, `ts=abc,v1=${V1_NUMERIC}`, `ts=${TS},v1=xyz`, `ts=${TS},v1=${V1_NUMERIC}00`, `ts=${TS},v1=${V1_NUMERIC.slice(2)}`, `ts=${TS},ts=${TS},v1=${V1_NUMERIC}`, `=,=`, 'Bearer anything']) {
      await rejected(event({ sig }));
    }
  });
  it('5. missing secret -> 401 (never downgrades to unsigned processing)', async () => {
    delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
    await rejected(event());
    process.env.MERCADOPAGO_WEBHOOK_SECRET = '';
    await rejected(event());
  });
  it('6. missing request id -> 401', async () => { await rejected(event({ rid: null })); });
  it('7. missing data id -> 401', async () => { await rejected(event({ dataId: null })); });
  it('8. body tampering cannot bypass verification', async () => {
    // valid signature for data.id 123456789, body claims another resource
    await rejected(event({ payload: body('987654321') }));
    // signed data.id swapped in the URL, body adjusted to match: signature no longer matches
    await rejected(event({ dataId: '987654321', payload: body('987654321') }));
    // forged body with an invalid signature
    await rejected(event({ sig: `ts=${TS},v1=${'a'.repeat(64)}`, payload: JSON.stringify({ id: 1, type: 'commission.created', data: { id: '123456789', amount: 1e9 } }) }));
  });
  it('9/10. no service-role DB call and no MP API call before successful auth', async () => {
    await rejected(event({ sig: null }));
    assert.equal(calls.filter((u) => u.includes('supabase.invalid')).length, 0);
    assert.equal(calls.filter((u) => u.includes('mercadopago.com')).length, 0);
  });
  it('11. malformed input does not crash the function', async () => {
    for (const ev of [
      { httpMethod: 'POST', headers: null, queryStringParameters: null, body: null },
      { httpMethod: 'POST', headers: {}, body: '{not json' },
      event({ payload: '{not json' }),
      event({ payload: 'null' }),
      event({ payload: '' }),
    ]) {
      const res = await run(ev);
      assert.ok([400, 401].includes(res.statusCode), `status ${res.statusCode}`);
    }
    assert.equal(calls.length, 0);
  });
  it('header names are matched case-insensitively', async () => {
    const ev = event();
    ev.headers = { 'X-Signature': ev.headers['x-signature'], 'X-Request-Id': ev.headers['x-request-id'] };
    assert.notEqual((await run(ev)).statusCode, 401);
  });
  it('the secret, the signature header and the digest are never logged', async () => {
    const logs = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
    try {
      await run(event());
      await run(event({ sig: `ts=${TS},v1=${'0'.repeat(64)}` }));
    } finally { Object.assign(console, orig); }
    const text = logs.join('\n');
    for (const s of [SECRET, V1_NUMERIC, `ts=${TS},v1=`]) assert.ok(!text.includes(s), 'sensitive value logged');
  });
});
