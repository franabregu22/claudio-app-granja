#!/usr/bin/env node
/**
 * ADR-006 Step 3 — verifySignature.test (pure module, no DB, no network).
 *
 * Run:  node scripts/target-db/verifySignature.test.mjs
 * Exit: 0 only if every case passes.
 *
 * Authority: .planning/implementation-design/ADR006_V1_WEBHOOK_EVIDENCE.md.
 * The secret below is a fixed test literal, not a credential.
 */

import { createHmac } from 'node:crypto';
import {
  verifySignature,
  classifyTopic,
  extractNotificationIdentity,
  FRESHNESS_TOLERANCE_MS,
  TOPIC_TABLE,
} from '../../supabase/functions/_shared/mp-webhook-contract.ts';

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  cond ? pass++ : fail++;
  console.log(`    ${cond ? 'OK  ' : 'MAL '} ${label}${cond ? '' : ` :: ${detail}`}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SECRET = 'v1-test-secret-not-a-real-key';
const TS = '1742505638683'; // 13 digits (ms), official payment-notification example
const NOW = Number(TS) + 1000;
const REQ = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';
// Fixed vector computed independently over the literal manifest
// 'id:123456;request-id:bb56a2f1-6aae-46ac-982e-9dcd3581d08e;ts:1742505638683;'
const V1 = '85aaea44adced84bf23e95db43da124f818caad473052e8d0ecd46c5319c231e';

const hmac = (manifest, secret = SECRET) => createHmac('sha256', secret).update(manifest, 'utf8').digest('hex');
const base = (over = {}) => ({
  headers: { 'x-signature': `ts=${TS},v1=${V1}`, 'x-request-id': REQ },
  query: { 'data.id': '123456', type: 'payment' },
  rawBody: '{"action":"payment.updated","data":{"id":"123456"},"type":"payment"}',
  secret: SECRET,
  now: NOW,
  ...over,
});
const verify = (over) => verifySignature(base(over));
const reason = (over) => verify(over).reason;

console.log('\n  V — signature recipe');
check('V1 fixed vector equals HMAC-SHA256 hex of the literal manifest', hmac(`id:123456;request-id:${REQ};ts:${TS};`) === V1);
check('V2 valid notification → ok', same(verify(), { ok: true }), JSON.stringify(verify()));
check('V3 Headers object (case-insensitive) → ok',
  verify({ headers: new Headers({ 'X-Signature': `ts=${TS},v1=${V1}`, 'X-Request-Id': REQ }) }).ok === true);
check('V4 URLSearchParams query → ok', verify({ query: new URLSearchParams(`data.id=123456&type=payment`) }).ok === true);
check('V5 header with spaces after comma and uppercase hex digest → ok',
  verify({ headers: { 'x-signature': `ts=${TS}, v1=${V1.toUpperCase()}`, 'x-request-id': REQ } }).ok === true);
check('V6 rawBody is not part of the manifest (changed body still ok)', verify({ rawBody: '{}' }).ok === true);

console.log('\n  T — tamper');
check('T1 changed data.id → SIGNATURE_MISMATCH', reason({ query: { 'data.id': '123457' } }) === 'SIGNATURE_MISMATCH');
check('T2 changed x-request-id → SIGNATURE_MISMATCH',
  reason({ headers: { 'x-signature': `ts=${TS},v1=${V1}`, 'x-request-id': REQ + 'x' } }) === 'SIGNATURE_MISMATCH');
check('T3 changed ts → SIGNATURE_MISMATCH',
  reason({ headers: { 'x-signature': `ts=1742505638684,v1=${V1}`, 'x-request-id': REQ } }) === 'SIGNATURE_MISMATCH');
check('T4 wrong secret → SIGNATURE_MISMATCH', reason({ secret: 'another-test-secret' }) === 'SIGNATURE_MISMATCH');
const flipped = (V1[0] === '0' ? '1' : '0') + V1.slice(1);
check('T5 one digest nibble changed → SIGNATURE_MISMATCH',
  reason({ headers: { 'x-signature': `ts=${TS},v1=${flipped}`, 'x-request-id': REQ } }) === 'SIGNATURE_MISMATCH');

console.log('\n  M — missing / malformed');
check('M1 no x-signature header → MISSING_SIGNATURE_HEADER', reason({ headers: { 'x-request-id': REQ } }) === 'MISSING_SIGNATURE_HEADER');
check('M2 empty x-signature → MISSING_SIGNATURE_HEADER', reason({ headers: { 'x-signature': '', 'x-request-id': REQ } }) === 'MISSING_SIGNATURE_HEADER');
for (const [label, sig] of [
  ['no v1', `ts=${TS}`],
  ['no ts', `v1=${V1}`],
  ['duplicate ts', `ts=${TS},ts=${TS},v1=${V1}`],
  ['part without =', `ts=${TS},v1`],
  ['short digest', `ts=${TS},v1=${V1.slice(0, 63)}`],
  ['non-hex digest', `ts=${TS},v1=${'z'.repeat(64)}`],
  ['base64 digest', `ts=${TS},v1=haqqRK3O2Evx4+20Q9oST4GMqtRzBS6NDs1GxTGcIx4=`],
  ['empty part', `ts=${TS},,v1=${V1}`],
]) {
  check(`M3 ${label} → MALFORMED_SIGNATURE_HEADER`,
    reason({ headers: { 'x-signature': sig, 'x-request-id': REQ } }) === 'MALFORMED_SIGNATURE_HEADER', reason({ headers: { 'x-signature': sig } }));
}
for (const ts of ['', 'abc', '17425056386', '174250563868', '17425056386830', '-1742505638', '1742505638.5']) {
  const sig = `ts=${ts},v1=${V1}`;
  check(`M4 ts '${ts}' → MALFORMED_TIMESTAMP`, reason({ headers: { 'x-signature': sig, 'x-request-id': REQ } }) === 'MALFORMED_TIMESTAMP',
    reason({ headers: { 'x-signature': sig, 'x-request-id': REQ } }));
}
check('M5 empty secret → MISSING_SECRET', reason({ secret: '' }) === 'MISSING_SECRET');
check('M6 undefined secret → MISSING_SECRET', reason({ secret: undefined }) === 'MISSING_SECRET');
check('M7 non-finite now → INVALID_CLOCK', reason({ now: NaN }) === 'INVALID_CLOCK');
check('M8 repeated data.id query param → treated as absent → SIGNATURE_MISMATCH',
  reason({ query: new URLSearchParams('data.id=123456&data.id=123456') }) === 'SIGNATURE_MISMATCH');

console.log('\n  P — manifest components removed when absent (official rule)');
{
  const noReq = hmac(`id:123456;ts:${TS};`);
  check('P1 no x-request-id, manifest without request-id → ok',
    verify({ headers: { 'x-signature': `ts=${TS},v1=${noReq}` } }).ok === true);
  check('P2 no x-request-id but digest signed with it → SIGNATURE_MISMATCH',
    reason({ headers: { 'x-signature': `ts=${TS},v1=${V1}` } }) === 'SIGNATURE_MISMATCH');
  const noId = hmac(`request-id:${REQ};ts:${TS};`);
  check('P3 no data.id, manifest without id → ok',
    verify({ headers: { 'x-signature': `ts=${TS},v1=${noId}`, 'x-request-id': REQ }, query: { type: 'payment' } }).ok === true);
  const tsOnly = hmac(`ts:${TS};`);
  check('P4 neither present, manifest ts only → ok', verify({ headers: { 'x-signature': `ts=${TS},v1=${tsOnly}` }, query: {} }).ok === true);
  check('P5 empty data.id is treated as absent',
    verify({ headers: { 'x-signature': `ts=${TS},v1=${noId}`, 'x-request-id': REQ }, query: { 'data.id': '' } }).ok === true);
}

console.log('\n  L — data.id lowercase rule (official example)');
{
  const tsSec = '1704908010';
  const lower = 'c285d968dd7dba65149a955467060b70de5c3ae538b2aa8f4ac8c61045cf0c3b';
  check('L1 fixed vector: lowercase manifest', hmac(`id:ord01jq4s4ky8hwq6na5pxb65b3d3;request-id:req-1;ts:${tsSec};`) === lower);
  const input = {
    headers: { 'x-signature': `ts=${tsSec},v1=${lower}`, 'x-request-id': 'req-1' },
    query: { 'data.id': 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3' },
    now: Number(tsSec) * 1000,
  };
  check('L2 uppercase data.id verified against lowercased manifest → ok', verify(input).ok === true);
  const upper = hmac(`id:ORD01JQ4S4KY8HWQ6NA5PXB65B3D3;request-id:req-1;ts:${tsSec};`);
  check('L3 digest over the uppercase id → SIGNATURE_MISMATCH',
    reason({ ...input, headers: { 'x-signature': `ts=${tsSec},v1=${upper}`, 'x-request-id': 'req-1' } }) === 'SIGNATURE_MISMATCH');
  check('L4 x-request-id is NOT lowercased',
    reason({ ...input, headers: { 'x-signature': `ts=${tsSec},v1=${lower}`, 'x-request-id': 'REQ-1' } }) === 'SIGNATURE_MISMATCH');
}

console.log('\n  F — freshness (INTERNAL_POLICY ±15 min)');
check('F0 tolerance is 15 minutes', FRESHNESS_TOLERANCE_MS === 900000);
check('F1 exactly -15 min → ok', verify({ now: Number(TS) + FRESHNESS_TOLERANCE_MS }).ok === true);
check('F2 -15 min -1 ms → STALE_TIMESTAMP', reason({ now: Number(TS) + FRESHNESS_TOLERANCE_MS + 1 }) === 'STALE_TIMESTAMP');
check('F3 exactly +15 min → ok', verify({ now: Number(TS) - FRESHNESS_TOLERANCE_MS }).ok === true);
check('F4 +15 min +1 ms → FUTURE_TIMESTAMP', reason({ now: Number(TS) - FRESHNESS_TOLERANCE_MS - 1 }) === 'FUTURE_TIMESTAMP');
{
  const tsSec = '1742505638';
  const d = hmac(`id:123456;request-id:${REQ};ts:${tsSec};`);
  const input = { headers: { 'x-signature': `ts=${tsSec},v1=${d}`, 'x-request-id': REQ } };
  check('F5 10-digit ts read as seconds, fresh → ok', verify({ ...input, now: Number(tsSec) * 1000 + 5000 }).ok === true);
  check('F6 10-digit ts read as seconds, 1 h old → STALE_TIMESTAMP', reason({ ...input, now: Number(tsSec) * 1000 + 3600000 }) === 'STALE_TIMESTAMP');
}
check('F7 stale ts with a forged digest → SIGNATURE_MISMATCH (authenticity checked first)',
  reason({ headers: { 'x-signature': `ts=${TS},v1=${flipped}`, 'x-request-id': REQ }, now: Number(TS) + 86400000 }) === 'SIGNATURE_MISMATCH');

console.log('\n  R — reasons never leak sensitive material');
{
  const inputs = [base(), base({ secret: 'x' }), base({ query: { 'data.id': '9' } }), base({ now: 0 }),
    base({ headers: { 'x-signature': `ts=${TS},v1=${V1.slice(0, 10)}` } })];
  const leaks = inputs.map((i) => JSON.stringify(verifySignature(i))).filter((s) =>
    s.includes(SECRET) || s.includes(V1) || s.includes(V1.slice(0, 8)) || s.includes('request-id:') || s.includes(REQ));
  check('R1 results contain no secret, digest, digest prefix, manifest or request id', leaks.length === 0, leaks.join(' | '));
  check('R2 every failure reason is an UPPER_SNAKE code',
    inputs.map((i) => verifySignature(i)).every((r) => r.ok || /^[A-Z_]+$/.test(r.reason)));
}

console.log('\n  C — topic classification (V-1 table)');
check('C1 table has exactly payment and topic_chargebacks_wh', same(Object.keys(TOPIC_TABLE).sort(), ['payment', 'topic_chargebacks_wh']));
check('C2 payment → payment', classifyTopic('payment', 'payment.updated') === 'payment');
check('C3 payment with action payment.created → payment', classifyTopic('payment', 'payment.created') === 'payment');
check('C4 topic_chargebacks_wh → chargeback', classifyTopic('topic_chargebacks_wh', ['changed_case_status']) === 'chargeback');
for (const t of ['Payment', 'payments', 'payment ', 'chargebacks', 'chargeback', 'topic_merchant_order_wh', 'merchant_order',
  'topic_claims_integration_wh', 'order', 'subscription_preapproval', '', 'toString', '__proto__', 'constructor']) {
  check(`C5 '${t}' → unsupported`, classifyTopic(t, 'payment.updated') === 'unsupported');
}
check('C6 non-string type → unsupported', classifyTopic(undefined) === 'unsupported' && classifyTopic(123) === 'unsupported' && classifyTopic(null) === 'unsupported');
check('C7 action never changes the class', classifyTopic('merchant_order', 'payment.created') === 'unsupported');

console.log('\n  I — notification identity / resource id');
{
  const payBody = { action: 'payment.updated', api_version: 'v1', data: { id: '123456' }, id: '123456', type: 'payment' };
  const r1 = extractNotificationIdentity({ topicClass: 'payment', query: { 'data.id': '123456' }, body: payBody });
  check('I1 payment: resource id from query data.id, notificationId null', same(r1, { ok: true, resourceId: '123456', notificationId: null }), JSON.stringify(r1));
  check('I2 body id (documented "Notification ID") is never used as notificationId', r1.notificationId === null);
  check('I3 x-request-id is not an input of identity (no headers parameter)', extractNotificationIdentity.length === 1 && !('headers' in r1));
  check('I4 payment: missing query data.id → MISSING_RESOURCE_ID',
    extractNotificationIdentity({ topicClass: 'payment', query: {}, body: payBody }).reason === 'MISSING_RESOURCE_ID');
  check('I5 payment: body data.id disagrees → RESOURCE_ID_MISMATCH',
    extractNotificationIdentity({ topicClass: 'payment', query: { 'data.id': '123457' }, body: payBody }).reason === 'RESOURCE_ID_MISMATCH');
  check('I6 payment: non-numeric id → INVALID_PAYMENT_RESOURCE_ID',
    extractNotificationIdentity({ topicClass: 'payment', query: { 'data.id': 'abc' }, body: {} }).reason === 'INVALID_PAYMENT_RESOURCE_ID');
  check('I7 payment: 21-digit id → INVALID_PAYMENT_RESOURCE_ID',
    extractNotificationIdentity({ topicClass: 'payment', query: { 'data.id': '1'.repeat(21) }, body: {} }).reason === 'INVALID_PAYMENT_RESOURCE_ID');
  check('I8 payment: safe-integer number body id that disagrees → RESOURCE_ID_MISMATCH',
    extractNotificationIdentity({ topicClass: 'payment', query: { 'data.id': '123456' }, body: { data: { id: 123457 } } }).reason === 'RESOURCE_ID_MISMATCH');

  // Official chargeback example: data.id is a JSON number beyond Number.MAX_SAFE_INTEGER.
  const cbRaw = '{"actions":["changed_case_status"],"api_version":"v1","data":{"checkout":"PRO","id":233000061680860000,"payment_id":81968653106,"site_id":"MLA"},"id":114411153595,"live_mode":true,"type":"topic_chargebacks_wh"}';
  const cbBody = JSON.parse(cbRaw);
  const r2 = extractNotificationIdentity({ topicClass: 'chargeback', query: { 'data.id': '233000061680860000' }, body: cbBody });
  check('I9 chargeback: resource id is the query string, not the lossy JSON number', same(r2, { ok: true, resourceId: '233000061680860000', notificationId: null }), JSON.stringify(r2));
  check('I10 chargeback: missing query data.id → MISSING_RESOURCE_ID',
    extractNotificationIdentity({ topicClass: 'chargeback', query: {}, body: cbBody }).reason === 'MISSING_RESOURCE_ID');
  for (const id of ['a b', 'abc', 'ORD01ABC', 'ord01abc', '123a', '12.34', '12_34', '12:34', '12-34', '-123', '1'.repeat(101)]) {
    check(`I11 chargeback: non-numeric or over-bound id '${id.length > 20 ? id.slice(0, 8) + '…' : id}' → INVALID_CHARGEBACK_RESOURCE_ID`,
      extractNotificationIdentity({ topicClass: 'chargeback', query: { 'data.id': id }, body: {} }).reason === 'INVALID_CHARGEBACK_RESOURCE_ID');
  }
  check('I11b chargeback: 100-digit id (internal storage bound) → ok',
    extractNotificationIdentity({ topicClass: 'chargeback', query: { 'data.id': '9'.repeat(100) }, body: {} }).ok === true);
  check('I12 unsupported: ok with null ids',
    same(extractNotificationIdentity({ topicClass: 'unsupported', query: {}, body: null }), { ok: true, resourceId: null, notificationId: null }));
  check('I13 chargeback: numeric query id is returned verbatim',
    extractNotificationIdentity({ topicClass: 'chargeback', query: { 'data.id': '114411153595' }, body: {} }).resourceId === '114411153595');
}

console.log(`\n  ══ VERIFY SIGNATURE RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
