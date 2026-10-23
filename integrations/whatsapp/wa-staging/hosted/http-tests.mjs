// ADR-025 §18 hosted — REAL Supabase Auth + PostgREST of AppGranja. Every request goes to https://<WA_REF>.supabase.co only.
// Environment (from run-hosted-tests.sh; nothing printed): WA_REF, WA_ANON, WA_USERS (file), WA_RUN_SECRET, WA_PHONE_A/B/OPER,
// WA_ACC_CASH, WA_ACC_MP. Output: PASS/FAIL lines and HTTP_SUMMARY|passed|failed. Exit 0 only if all passed.
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';

const E = process.env;
const BASE = `https://${E.WA_REF}.supabase.co`;
if (!/^[a-z]{20}$/.test(E.WA_REF) || ['ycmkpnunhxluqqtecbyu', 'shdrztqgwpyyxclgfpdg'].includes(E.WA_REF)) throw new Error('forbidden / invalid ref');
const users = Object.fromEntries(JSON.parse(readFileSync(E.WA_USERS, 'utf8')).map((u) => [u.email.split('@')[0], u]));
const CAT = 'aaaaaaaa-0025-0000-0000-0000000000c1';
const RUN = randomBytes(4).toString('hex');
let pass = 0, fail = 0, seq = 0, skew = 0;
const check = (id, desc, ok, got) => {
  if (ok) { pass++; console.log(`PASS ${id} ${desc}`); } else { fail++; console.log(`FAIL ${id} ${desc} :: got ${String(got).slice(0, 300)}`); }
};

async function req(path, { method = 'POST', token, body, headers = {} } = {}) {
  const url = new URL(path, BASE);
  if (url.host !== `${E.WA_REF}.supabase.co`) throw new Error('host guard');
  const r = await fetch(url, { method, headers: { apikey: E.WA_ANON, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.headers.get('date')) skew = new Date(r.headers.get('date')).getTime() - Date.now();
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const rpc = (token, fn, args = {}, headers) => req(`/rest/v1/rpc/${fn}`, { token, body: args, headers });
const msgOf = (r) => (r.json && (r.json.message || r.json.msg)) || r.text;
const login = async (name) => {
  const r = await req('/auth/v1/token?grant_type=password', { body: { email: users[name].email, password: users[name].password } });
  return r.status === 200 && r.json?.access_token ? r.json.access_token : null;
};

// Meta envelope + signature over the exact bytes
const nowTs = () => Math.floor((Date.now() + skew) / 1000);
const envelope = (phone, { text, button, ts = nowTs() } = {}) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '0', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', messages: [button
    ? { from: phone.replace('+', ''), id: `wamid.HT${RUN}.${++seq}`, timestamp: String(ts), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: button, title: 'Sí' } } }
    : { from: phone.replace('+', ''), id: `wamid.HT${RUN}.${++seq}`, timestamp: String(ts), type: 'text', text: { body: text } }] } }] }] });
const sign = (raw) => 'sha256=' + createHmac('sha256', E.WA_RUN_SECRET).update(Buffer.from(raw, 'utf8')).digest('hex');
let GW;
const ingest = (raw, sig = sign(raw)) => rpc(GW, 'wa_ingest', { p_raw_b64: Buffer.from(raw, 'utf8').toString('base64'), p_signature: sig });
const msg = async (phone, opts) => { const r = await ingest(envelope(phone, opts)); return r.json?.messages?.[0]?.inbound_id; };
const btn = (phone, d, v) => msg(phone, { button: `CONFIRM:${d}:${v}` });
const propose = (inb, payload, type = 'CASUAL_EXPENSE') => rpc(GW, 'wa_propose', { p_inbound_id: inb, p_type: type, p_payload: payload });
const correct = (inb, d, v, payload) => rpc(GW, 'wa_correct', { p_inbound_id: inb, p_draft_id: d, p_expected_version: v, p_payload: payload });
const confirm = (inb, d, v) => rpc(GW, 'wa_confirm', { p_inbound_id: inb, p_draft_id: d, p_expected_version: v });
const link = (inb, d, v, src) => rpc(GW, 'wa_link_mp', { p_inbound_id: inb, p_draft_id: d, p_expected_version: v, p_source_id: src });
const cash = (total) => ({ date: '2026-10-20', total, category_id: CAT, nature: 'OPERATING', concept: 'Prueba hospedada', account_id: E.WA_ACC_CASH, method: 'CASH' });
const mp = (total) => ({ ...cash(total), concept: 'Pago MP hospedado', account_id: E.WA_ACC_MP, method: 'MERCADOPAGO' });
const A = E.WA_PHONE_A, B = E.WA_PHONE_B;

(async () => {
  // ── H. Auth ──
  const tok = {};
  for (const n of ['admin-a', 'admin-b', 'oper', 'wa-gateway']) tok[n] = await login(n);
  check('H-1', 'the 4 synthetic users sign in through Supabase Auth', Object.values(tok).every(Boolean), Object.entries(tok).map(([k, v]) => `${k}:${!!v}`).join(','));
  GW = tok['wa-gateway'];
  if (!GW) { console.log(`HTTP_SUMMARY|${pass}|${fail + 1}`); process.exit(1); }
  const [h, p, s] = GW.split('.');
  const forged = [h, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: users['admin-a'].id })).toString('base64url'), s].join('.');
  const f = await rpc(forged, 'wa_expire');
  check('H-2', 'a JWT with a forged sub (admin A) is rejected', f.status === 401, `${f.status} ${msgOf(f)}`);

  // ── S. API surface ──
  const an = await rpc(null, 'wa_expire');
  check('S-1', 'anon calling wa_* is refused (permission denied)', [401, 403].includes(an.status) && an.json?.code === '42501', `${an.status} ${an.json?.code} ${msgOf(an)}`);
  for (const [id, n] of [['S-2', 'admin-a'], ['S-3', 'admin-b'], ['S-4', 'oper']]) {
    const r = await rpc(tok[n], 'wa_expire');
    check(id, `${n} calling wa_* directly is refused (FORBIDDEN)`, r.status === 400 && /^FORBIDDEN/.test(msgOf(r)), `${r.status} ${msgOf(r)}`);
  }
  const g = await rpc(GW, 'wa_expire');
  check('S-5', 'the gateway is admitted', g.status === 200 && g.json?.ok === true, `${g.status} ${g.text}`);
  for (const [id, schema] of [['S-6', 'wa'], ['S-7', 'sim'], ['S-8', 'vault'], ['S-9', 'net'], ['S-10', 'cron']]) {
    const r = await req('/rest/v1/draft?select=*', { method: 'GET', token: GW, headers: { 'accept-profile': schema } });
    check(id, `schema ${schema} is not exposed through PostgREST`, r.status === 406 && r.json?.code === 'PGRST106', `${r.status} ${r.json?.code}`);
  }
  const rp = await rpc(GW, 'register_casual_purchase', { p_idempotency_key: 'GW-DIRECT' });
  check('S-11', 'the gateway cannot reach any accounting function', rp.status === 404, `${rp.status} ${rp.json?.code}`);

  // ── I. ingest over HTTP ──
  const raw = envelope(A, { text: 'gasté 1500' });
  const i1 = await ingest(raw);
  check('I-1', 'valid signature, mapped ADMIN → ACCEPTED', i1.json?.messages?.[0]?.outcome === 'ACCEPTED', i1.text);
  const mA1 = i1.json?.messages?.[0]?.inbound_id;
  const i2 = await ingest(envelope(A, { text: 'x' }), 'sha256=' + '0'.repeat(64));
  check('I-2', 'wrong signature → WA_BAD_SIGNATURE', i2.json?.error === 'WA_BAD_SIGNATURE', i2.text);
  const i3 = await ingest(JSON.stringify(JSON.parse(raw), null, 1), sign(raw));
  check('I-3', 're-serialized body with the original signature → WA_BAD_SIGNATURE', i3.json?.error === 'WA_BAD_SIGNATURE', i3.text);
  const i4 = await ingest(raw);
  check('I-4', 'replayed delivery → duplicate, same inbound id', i4.json?.messages?.[0]?.duplicate === true && i4.json.messages[0].inbound_id === mA1, i4.text);
  const i5 = await ingest(envelope('+5491100000000', { text: 'hola' }));
  check('I-5', 'unknown phone → UNAUTHORIZED_SENDER', i5.json?.messages?.[0]?.outcome === 'UNAUTHORIZED_SENDER', i5.text);
  const i6 = await ingest(envelope(E.WA_PHONE_OPER, { text: 'gasto' }));
  check('I-6', 'OPERATOR phone → UNAUTHORIZED_SENDER', i6.json?.messages?.[0]?.outcome === 'UNAUTHORIZED_SENDER', i6.text);
  const i7 = await propose(i6.json?.messages?.[0]?.inbound_id, cash(10));
  check('I-7', 'an unauthorized message cannot create a draft', i7.status === 400 && /WA_MESSAGE_NOT_ACCEPTED/.test(msgOf(i7)), `${i7.status} ${msgOf(i7)}`);

  // ── D. sender isolation, versions, idempotency ──
  const d1 = await propose(mA1, cash(1500)); const dA = d1.json?.draft_id;
  check('D-1', 'A proposes → DRAFT v1', d1.json?.state === 'DRAFT' && d1.json?.version === 1, d1.text);
  const d2 = await correct(await msg(B, { text: 'corrijo' }), dA, 1, cash(1600));
  check('D-2', 'admin B cannot correct A\'s draft', /WA_NOT_DRAFT_OWNER/.test(msgOf(d2)), msgOf(d2));
  const d3 = await confirm(await btn(B, dA, 1), dA, 1);
  check('D-3', 'admin B pressing A\'s confirm button is refused', /WA_NOT_DRAFT_OWNER/.test(msgOf(d3)), msgOf(d3));
  const d4 = await correct(await msg(A, { text: 'eran 1600' }), dA, 1, cash(1600));
  check('D-4', 'A corrects → v2', d4.json?.version === 2, d4.text);
  const d5 = await confirm(await btn(A, dA, 1), dA, 2);
  check('D-5', 'the v1 button cannot confirm v2', /WA_CONFIRMATION_NOT_EXPLICIT/.test(msgOf(d5)), msgOf(d5));
  const d6 = await confirm(await btn(A, dA, 1), dA, 1);
  check('D-6', 'confirming the obsolete version is refused', /WA_VERSION_CHANGED/.test(msgOf(d6)), msgOf(d6));
  const mAc = await btn(A, dA, 2);
  const d7 = await confirm(mAc, dA, 2);
  check('D-7', 'explicit v2 button by A → CONFIRMED (sim purchase)', d7.json?.state === 'CONFIRMED' && !!d7.json?.result?.purchase_id, d7.text);
  const d8 = await confirm(mAc, dA, 2);
  check('D-8', 'retry of the same confirmation → replay, same purchase', d8.json?.replay === true && d8.json?.result?.purchase_id === d7.json?.result?.purchase_id, d8.text);
  const d9 = await confirm(await btn(A, dA, 2), dA, 2);
  check('D-9', 'a second "SÍ" → already confirmed, same purchase', d9.json?.already_confirmed === true && d9.json?.result?.purchase_id === d7.json?.result?.purchase_id, d9.text);

  // ── C. concurrency through PostgREST (simultaneous requests) ──
  const dB = (await propose(await msg(B, { text: 'gasto 300' }), cash(300))).json?.draft_id;
  const [b1, b2] = [await btn(B, dB, 1), await btn(B, dB, 1)];
  const [c1, c2] = await Promise.all([confirm(b1, dB, 1), confirm(b2, dB, 1)]);
  const states = [c1, c2].map((r) => r.json?.state === 'CONFIRMED' ? 'C' : r.json?.already_confirmed ? 'A' : `?${r.status}`).sort().join('');
  check('C-1', 'two simultaneous "SÍ" for one draft → one CONFIRMED + one already confirmed, same purchase',
    states === 'AC' && c1.json?.result?.purchase_id === c2.json?.result?.purchase_id, `${states} ${c1.text} ${c2.text}`);
  const dA2 = (await propose(await msg(A, { text: 'gasto 710' }), cash(710))).json?.draft_id;
  const dB2 = (await propose(await msg(B, { text: 'gasto 720' }), cash(720))).json?.draft_id;
  const [ba, bb] = [await btn(A, dA2, 1), await btn(B, dB2, 1)];
  const [ca, cb] = await Promise.all([confirm(ba, dA2, 1), confirm(bb, dB2, 1)]);
  check('C-2', 'A and B confirm their own drafts simultaneously → both CONFIRMED', ca.json?.state === 'CONFIRMED' && cb.json?.state === 'CONFIRMED', `${ca.text} ${cb.text}`);
  const wA = (await propose(await msg(A, { text: 'mp 2500' }), mp(2500))).json;
  const wB = (await propose(await msg(B, { text: 'mp 2500' }), mp(2500))).json;
  check('C-3', 'MP-paid expenses without SOURCE_ID → WAITING_MP', wA?.state === 'WAITING_MP' && wB?.state === 'WAITING_MP', `${JSON.stringify(wA)} ${JSON.stringify(wB)}`);
  const [la, lb] = [await msg(A, { text: 'es el 25002' }), await msg(B, { text: 'es el 25002' })];
  const [ra, rb] = await Promise.all([link(la, wA?.draft_id, 1, '930000025002'), link(lb, wB?.draft_id, 1, '930000025002')]);
  const okCount = [ra, rb].filter((r) => r.status === 200 && r.json?.state === 'DRAFT').length;
  check('C-4', 'A and B link the SAME outflow simultaneously → exactly one succeeds', okCount === 1, `${ra.status} ${msgOf(ra)} | ${rb.status} ${msgOf(rb)}`);
  const [win, winPhone, lose, losePhone] = ra.status === 200 ? [wA, A, wB, B] : [wB, B, wA, A];

  // ── M. Mercado Pago linking (sim outflows) ──
  const m1 = await link(await msg(losePhone, { text: 'es el 25001' }), lose?.draft_id, 1, '930000025001');
  check('M-1', 'linking to an outflow of another amount is refused', /WA_MP_OUTFLOW_NOT_MATCHING/.test(msgOf(m1)), msgOf(m1));
  const m2 = await confirm(await btn(winPhone, win?.draft_id, 2), win?.draft_id, 2);
  check('M-2', 'the linked draft confirms → purchase anchored to 930000025002', m2.json?.state === 'CONFIRMED', m2.text);
  const m3 = await link(await msg(losePhone, { text: 'es el 25002' }), lose?.draft_id, 1, '930000025002');
  check('M-3', 'a classified outflow cannot be linked again', /WA_MP_OUTFLOW_/.test(msgOf(m3)), msgOf(m3));

  console.log(`HTTP_SUMMARY|${pass}|${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`FAIL X-0 unexpected error :: ${e.message}`); console.log(`HTTP_SUMMARY|${pass}|${fail + 1}`); process.exit(1); });
