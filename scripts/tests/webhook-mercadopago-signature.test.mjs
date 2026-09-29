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
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    requests.push({ url: u, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : null });
    if (u.includes('/oauth/token')) return mock.tokenOk ? json(200, { access_token: 'fake-mp-token' }) : json(401, { message: 'fake token failure' });
    if (u.includes('api.mercadopago.com/v1/payments/')) {
      if (mock.paymentStatus !== 200) return json(mock.paymentStatus, { message: 'fake payment failure' });
      return json(200, { id: mock.paymentIdOverride ?? Number(decodeURIComponent(u.split('/v1/payments/')[1])), status: 'approved', transaction_amount: 1000, currency_id: 'ARS', transaction_details: { net_received_amount: 950, total_paid_amount: 1000 }, payer: { id: 1 }, payment_method: { id: 'account_money' } });
    }
    if (u.includes('supabase.invalid')) {
      const table = u.split('/rest/v1/')[1]?.split('?')[0];
      if (mock.dbFailTable === table) return json(400, { message: 'fake db failure', code: 'XX000' });
      return json(201, []);
    }
    throw new Error(`unexpected outbound request ${u}`);
  };
});
after(async () => { await server?.close(); });

const requests = [];
const mock = {};
const dbWrites = (table) => requests.filter((r) => r.url.includes(`/rest/v1/${table}`) && r.method === 'POST');
const mpCalls = () => requests.filter((r) => r.url.includes('mercadopago.com'));

beforeEach(() => {
  calls.length = 0;
  requests.length = 0;
  Object.assign(mock, { tokenOk: true, paymentStatus: 200, paymentIdOverride: undefined, dbFailTable: undefined });
  process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
  process.env.SUPABASE_URL = 'http://supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
  process.env.MERCADOPAGO_CLIENT_ID = 'fake-client';
  process.env.MERCADOPAGO_CLIENT_SECRET = 'fake-client-secret';
});

// Mercado Pago "Pagos (legacy)" webhook body: type "payment", action payment.created / payment.updated, data.id = payment id
const body = (id = '123456789', type = 'payment', action = 'payment.updated') => JSON.stringify({ id: 999, live_mode: false, type, action, api_version: 'v1', data: { id } });
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

describe('legacy "Pagos (legacy)" payment processing after authentication', () => {
  const processedPayment = () => {
    const writes = dbWrites('mercadopago_raw');
    assert.equal(writes.length, 1, 'exactly one mercadopago_raw upsert');
    return JSON.parse(writes[0].body)[0];
  };

  it('P1. signed type=payment action=payment.created: signature -> MP fetch -> mercadopago_raw upsert -> 200', async () => {
    const res = await run(event({ payload: body('123456789', 'payment', 'payment.created') }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).success, true);
    assert.ok(mpCalls().some((r) => r.url.endsWith('/v1/payments/123456789')));
    const row = processedPayment();
    assert.equal(row.id, '123456789');
    assert.equal(row.transaction_amount, 1000);
    assert.equal(row.net_received_amount, 950);
    assert.equal(dbWrites('webhook_events').length, 1, 'audit row written');
  });
  it('P2. signed payment.updated is processed', async () => {
    const res = await run(event({ payload: body('123456789', 'payment', 'payment.updated') }));
    assert.equal(res.statusCode, 200);
    assert.equal(processedPayment().id, '123456789');
  });
  it('P3. signed type=payment with an unsupported action is not processed', async () => {
    for (const action of ['payment.deleted', 'state_FINISHED', '', undefined]) {
      requests.length = 0;
      const res = await run(event({ payload: JSON.stringify({ id: 999, type: 'payment', action, data: { id: '123456789' } }) }));
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).ignored, 'UNSUPPORTED_ACTION');
      assert.equal(mpCalls().length, 0);
      assert.equal(dbWrites('mercadopago_raw').length, 0);
    }
  });
  it('P4. the old action-like type=payment.created is not processed as a payment', async () => {
    const res = await run(event({ payload: body('123456789', 'payment.created', 'payment.created') }));
    assert.equal(res.statusCode, 200);
    assert.equal(mpCalls().length, 0);
    assert.equal(dbWrites('mercadopago_raw').length, 0);
  });
  it('P5. the payment id used by processing is the signed query data.id (body without data.id)', async () => {
    const res = await run(event({ payload: JSON.stringify({ id: 999, type: 'payment', action: 'payment.created' }) }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(mpCalls().filter((r) => r.url.includes('/v1/payments/')).map((r) => r.url.split('/v1/payments/')[1]), ['123456789']);
    assert.equal(processedPayment().id, '123456789');
  });
  it('P5b. an MP response for a different payment id is rejected, nothing written', async () => {
    mock.paymentIdOverride = 555;
    const res = await run(event({ payload: body('123456789', 'payment', 'payment.created') }));
    assert.equal(res.statusCode, 502);
    assert.equal(dbWrites('mercadopago_raw').length, 0);
  });
  it('P6. body data.id different from the signed data.id -> 401, no side effect', async () => {
    await rejected(event({ payload: body('987654321', 'payment', 'payment.created') }));
  });
  it('P7. invalid signature on a well-formed payment event -> 401 with 0 DB and 0 MP calls', async () => {
    await rejected(event({ sig: `ts=${TS},v1=${'f'.repeat(64)}`, payload: body('123456789', 'payment', 'payment.created') }));
    assert.equal(requests.length, 0);
  });
  it('P8. a valid signed payment no longer crashes on the old .catch path', async () => {
    const res = await run(event({ payload: body('123456789', 'payment', 'payment.created') }));
    assert.equal(res.statusCode, 200);
    assert.ok(!String(res.body).includes('is not a function'));
  });
  it('P9. mercadopago_raw write failure -> 500 PAYMENT_WRITE_FAILED (never reported as success)', async () => {
    mock.dbFailTable = 'mercadopago_raw';
    const res = await run(event({ payload: body('123456789', 'payment', 'payment.created') }));
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).error, 'PAYMENT_WRITE_FAILED');
  });
  it('P9b. webhook_events audit failure stays best effort (legacy) and is handled explicitly', async () => {
    mock.dbFailTable = 'webhook_events';
    const res = await run(event({ payload: body('123456789', 'payment', 'payment.created') }));
    assert.equal(res.statusCode, 200);
    assert.equal(processedPayment().id, '123456789');
  });
  it('P10. Mercado Pago API failures are deterministic 502s with nothing written', async () => {
    mock.tokenOk = false;
    let res = await run(event({ payload: body('123456789', 'payment', 'payment.created') }));
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'MP_TOKEN_FAILED');
    assert.equal(dbWrites('mercadopago_raw').length, 0);
    mock.tokenOk = true;
    for (const status of [404, 500]) {
      requests.length = 0;
      mock.paymentStatus = status;
      res = await run(event({ payload: body('123456789', 'payment', 'payment.created') }));
      assert.equal(res.statusCode, 502);
      assert.equal(JSON.parse(res.body).error, 'MP_PAYMENT_FETCH_FAILED');
      assert.equal(dbWrites('mercadopago_raw').length, 0);
    }
  });
  it('P11. no unrelated legacy branch is activated by signed non-payment types', async () => {
    for (const type of ['commission.created', 'investment_yield.created', 'yield.created', 'refund.created', 'chargeback.created', 'merchant_order', 'topic_chargebacks_wh']) {
      requests.length = 0;
      const res = await run(event({ payload: JSON.stringify({ id: 999, type, action: 'x', data: { id: '123456789', amount: 1e9 } }) }));
      assert.ok([200, 500].includes(res.statusCode), `${type}: status ${res.statusCode}`);
      assert.equal(dbWrites('mercadopago_movements').length, 0, `${type}: no mercadopago_movements write`);
      assert.equal(dbWrites('mercadopago_raw').length, 0, `${type}: no mercadopago_raw write`);
      assert.equal(mpCalls().filter((r) => r.url.includes('/v1/payments/')).length, 0, `${type}: no payment fetch`);
    }
  });
});
