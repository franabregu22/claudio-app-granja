// ADR-025 — wa-gateway handler tests (PRODUCTION build; generated from tests/handler.test.ts with the project refs swapped) (Deno, no network: fetch is simulated). deno test --allow-read=n8n tests/handler.test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { createHandler, MAX_META_BODY, mintCap } from '../supabase/functions/wa-gateway/handler.ts';

const BASE = 'https://ycmkpnunhxluqqtecbyu.supabase.co';
const N8N = 'https://n8n.example.test/webhook/adr025-staging-gastos-whatsapp';
const T_E2N = 'e2n-token-'.padEnd(40, 'x'), T_N2E = 'n2e-token-'.padEnd(40, 'y'), CAPS = 'cap-secret-'.padEnd(40, 'z');
const ENV: Record<string, string> = {
  SUPABASE_URL: BASE, SUPABASE_ANON_KEY: 'anon-key', WA_GATEWAY_EMAIL: 'wa-gateway@staging.invalid', WA_GATEWAY_PASSWORD: 'gw-pass-secret',
  WA_META_VERIFY_TOKEN: 'verify-tok-'.padEnd(40, 'v'), WA_EDGE_TO_N8N_TOKEN: T_E2N, WA_N8N_TO_EDGE_TOKEN: T_N2E, WA_CAPABILITY_SECRET: CAPS, WA_N8N_INBOUND_URL: N8N,
};
type Call = { url: string; init: RequestInit };
function rig(opts: { env?: Record<string, string>; rpc?: (fn: string, args: any, n: number) => [number, unknown]; n8n?: number[]; loginStatus?: number;
                     extra?: (url: string, init: RequestInit) => Response | null } = {}) {
  const calls: Call[] = [], logs: Record<string, unknown>[] = [], bg: Promise<unknown>[] = [];
  let t = 1_800_000_000_000, n8nIdx = 0; const perFn: Record<string, number> = {};
  const fetchMock = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init });
    const x = opts.extra?.(url, init); if (x) return x;
    if (url.includes('/auth/v1/token')) return new Response(JSON.stringify({ access_token: `tok${calls.length}`, expires_in: 3600 }), { status: opts.loginStatus ?? 200 });
    if (url.includes('/rest/v1/rpc/')) {
      const fn = url.split('/rpc/')[1]; perFn[fn] = (perFn[fn] ?? 0) + 1;
      const [s, b] = opts.rpc ? opts.rpc(fn, JSON.parse(String(init.body)), perFn[fn]) : [200, { ok: true }];
      return new Response(JSON.stringify(b), { status: s });
    }
    if (url === N8N) { const s = opts.n8n?.[n8nIdx++] ?? 200; if (s === 0) throw new Error('network'); return new Response('ok', { status: s }); }
    throw new Error('unexpected fetch ' + url);
  }) as typeof fetch;
  const h = createHandler({ env: (k) => ({ ...ENV, ...opts.env })[k], fetch: fetchMock, now: () => t, log: (e) => logs.push(e),
    waitUntil: (p) => bg.push(p), sleep: async () => {} });
  return { h, calls, logs, bg, nowS: () => Math.floor(t / 1000) };
}
const metaBody = (msgs: unknown[]) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: msgs } }] }] });
const SIG = 'sha256=' + 'a'.repeat(64);
const metaReq = (body: string, sig: string | null = SIG) => new Request(`${BASE}/functions/v1/wa-gateway`, { method: 'POST', body,
  headers: sig ? { 'x-hub-signature-256': sig } : {} });
let nn = 0;
const actionReq = (body: unknown, ts: number, o: { token?: string; nonce?: string } = {}) => new Request(`${BASE}/functions/v1/wa-gateway/action`,
  { method: 'POST', body: JSON.stringify(body), headers: { 'x-wa-token': o.token ?? T_N2E, 'x-wa-timestamp': String(ts), 'x-wa-nonce': o.nonce ?? (++nn).toString(16).padStart(32, '0') } });
const ingestOk = (messages: unknown[]) => (fn: string): [number, unknown] => fn === 'wa_ingest' ? [200, { ok: true, messages }] : [200, { ok: true }];
const PHONE = '+5491155551234';
const D = '11111111-2222-4333-8444-555555555555';
const noSecrets = (logs: unknown[]) => { const s = JSON.stringify(logs); return ![T_E2N, T_N2E, CAPS, 'gw-pass-secret', '5491155551234', 'gasté', 'v1.'].some((x) => s.includes(x)) && !/tok[0-9]/.test(s); };

Deno.test('E-1 Meta verification: right token → challenge; wrong → 403', async () => {
  const { h } = rig();
  const ok = await h(new Request(`${BASE}/functions/v1/wa-gateway?hub.mode=subscribe&hub.verify_token=${ENV.WA_META_VERIFY_TOKEN}&hub.challenge=12345`));
  assertEquals([ok.status, await ok.text()], [200, '12345']);
  assertEquals((await h(new Request(`${BASE}/functions/v1/wa-gateway?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`))).status, 403);
});

Deno.test('E-2 webhook without / malformed signature header → 401, the database is never called', async () => {
  for (const sig of [null, 'sha256=xyz', 'md5=' + 'a'.repeat(64)]) {
    const { h, calls } = rig();
    assertEquals((await h(metaReq('{}', sig))).status, 401);
    assertEquals(calls.length, 0);
  }
});

Deno.test('E-3 oversized webhook body → 413 without database call', async () => {
  const { h, calls } = rig();
  assertEquals((await h(metaReq('x'.repeat(MAX_META_BODY + 1)))).status, 413);
  assertEquals(calls.length, 0);
});

Deno.test('E-4 original bytes reach wa_ingest; only ACCEPTED new messages go to n8n with token, ts, nonce and a capability; logs clean', async () => {
  const raw = metaBody([{ id: 'wamid.1', from: '5491155551234', type: 'text', text: { body: 'gasté 1500' } }]).replace(':', ' : ');
  const msgs = [
    { inbound_id: 7, outcome: 'ACCEPTED', duplicate: false, kind: 'text', text: 'gasté 1500', phone: PHONE },
    { inbound_id: 8, outcome: 'ACCEPTED', duplicate: true, kind: 'text', text: 'x', phone: PHONE },
    { inbound_id: 9, outcome: 'UNAUTHORIZED_SENDER', duplicate: false, kind: 'text', text: 'x', phone: '+5491100000000' },
  ];
  const x = rig({ rpc: ingestOk(msgs) });
  assertEquals((await x.h(metaReq(raw))).status, 200);
  await Promise.all(x.bg);
  const args = JSON.parse(String(x.calls.find((c) => c.url.endsWith('/rpc/wa_ingest'))!.init.body));
  assertEquals(new TextDecoder().decode(Uint8Array.from(atob(args.p_raw_b64), (c) => c.charCodeAt(0))), raw);
  assertEquals(args.p_signature, SIG);
  const fw = x.calls.filter((c) => c.url === N8N);
  assertEquals(fw.length, 1);
  const b = JSON.parse(String(fw[0].init.body)); const hd = fw[0].init.headers as Record<string, string>;
  assertEquals(hd['x-wa-token'], T_E2N);
  assertEquals(hd['x-wa-idempotency-key'], 'in:7');
  assert(/^[0-9]{10}$/.test(b.ts) && /^[0-9a-f]{32}$/.test(b.nonce));
  assertEquals(b.event.inbound_id, 7);
  assertEquals(b.event.cap, await mintCap(CAPS, 7, x.nowS()));
  assert(noSecrets(x.logs), 'logs leak secrets / phone / text / capability');
  assert(JSON.stringify(x.logs).includes('***234'));
});

Deno.test('E-5 database rejects the Meta signature → 401, nothing forwarded', async () => {
  const { h, calls } = rig({ rpc: () => [200, { ok: false, error: 'WA_BAD_SIGNATURE' }] });
  assertEquals((await h(metaReq(metaBody([])))).status, 401);
  assertEquals(calls.filter((c) => c.url === N8N).length, 0);
});

Deno.test('E-6 ingest failure → 500 (Meta retries; wamid dedupes)', async () => {
  const { h } = rig({ rpc: () => [500, { message: 'boom' }] });
  assertEquals((await h(metaReq(metaBody([])))).status, 500);
});

Deno.test('E-7 n8n delivery: retried on 5xx / network (3 attempts, fresh nonce each), not on 4xx', async () => {
  const m = [{ inbound_id: 1, outcome: 'ACCEPTED', duplicate: false, kind: 'text', text: 't', phone: PHONE }];
  let x = rig({ rpc: ingestOk(m), n8n: [503, 0, 200] }); await x.h(metaReq(metaBody([]))); await Promise.all(x.bg);
  const sent = x.calls.filter((c) => c.url === N8N);
  assertEquals(sent.length, 3);
  assertEquals(new Set(sent.map((c) => JSON.parse(String(c.init.body)).nonce)).size, 3);
  assert(x.logs.some((l) => l.evt === 'n8n_forwarded' && l.attempt === 3));
  x = rig({ rpc: ingestOk(m), n8n: [401] }); await x.h(metaReq(metaBody([]))); await Promise.all(x.bg);
  assertEquals(x.calls.filter((c) => c.url === N8N).length, 1);
  x = rig({ rpc: ingestOk(m), n8n: [500, 500, 500] }); await x.h(metaReq(metaBody([]))); await Promise.all(x.bg);
  assert(x.logs.some((l) => l.evt === 'n8n_forward_failed' && l.attempt === 3));
});

Deno.test('E-8 action: token + ts + single-use nonce + capability of THAT message → exact RPC args; every other case refused', async () => {
  const x = rig({ rpc: () => [200, { ok: true, state: 'CONFIRMED' }] });
  const cap = await mintCap(CAPS, 42, x.nowS());
  const body = { action: 'confirm', inbound_id: 42, cap, draft_id: D, expected_version: 2 };
  assertEquals((await x.h(actionReq(body, x.nowS(), { nonce: 'aa'.repeat(16) }))).status, 200);
  assertEquals(JSON.parse(String(x.calls.find((k) => k.url.endsWith('/rpc/wa_confirm'))!.init.body)), { p_inbound_id: 42, p_draft_id: D, p_expected_version: 2 });
  const st = async (b: unknown, o: { token?: string; nonce?: string; ts?: number } = {}) => (await x.h(actionReq(b, o.ts ?? x.nowS(), o))).status;
  assertEquals(await st(body, { nonce: 'aa'.repeat(16) }), 409);                                     // replayed nonce
  assertEquals(await st(body, { token: 'wrong'.padEnd(40, 'w') }), 401);                            // wrong token
  assertEquals(await st(body, { ts: x.nowS() - 301 }), 401);                                        // stale
  assertEquals(await st({ ...body, cap: undefined }), 403);                                         // no capability
  assertEquals(await st({ ...body, inbound_id: 43 }), 403);                                         // capability of another message
  assertEquals(await st({ ...body, cap: cap.slice(0, -1) + (cap.endsWith('0') ? '1' : '0') }), 403); // forged capability
  assertEquals(await st({ ...body, cap: await mintCap(CAPS, 42, x.nowS() - 901) }), 403);           // expired capability
  assertEquals(await st({ ...body, cap: await mintCap('other-secret'.padEnd(40, 'q'), 42, x.nowS()) }), 403);
  assertEquals(await st({ action: 'drop_table' }), 400);
  assertEquals(await st({ action: 'link_mp', inbound_id: 42, cap, draft_id: D, expected_version: 1, source_id: '1;drop' }), 400);
  assertEquals(await st({ action: 'expire' }), 200);                                                // no inbound → no capability needed
  assertEquals(x.calls.filter((k) => k.url.includes('/rpc/')).length, 2);
  assert(noSecrets(x.logs));
});

Deno.test('E-9 action refused by the database → 422 with the error code (no stack, no secrets)', async () => {
  const x = rig({ rpc: () => [400, { code: 'P0001', message: 'WA_NOT_DRAFT_OWNER' }] });
  const r = await x.h(actionReq({ action: 'cancel', inbound_id: 3, cap: await mintCap(CAPS, 3, x.nowS()), draft_id: D, expected_version: 1 }, x.nowS()));
  assertEquals(r.status, 422);
  assertEquals((await r.json()).error.code, 'WA_NOT_DRAFT_OWNER');
});

Deno.test('E-10 gateway token cached; a 401 from PostgREST triggers ONE fresh sign-in', async () => {
  const x = rig({ rpc: (_fn, _a, n) => n === 2 ? [401, { message: 'JWT expired' }] : [200, { ok: true }] });
  for (let i = 0; i < 3; i++) await x.h(actionReq({ action: 'expire' }, x.nowS()));
  assertEquals(x.calls.filter((c) => c.url.includes('/auth/v1/token')).length, 2);
  assertEquals(x.calls.filter((c) => c.url.includes('/rpc/wa_expire')).length, 4);
});

Deno.test('E-11 misconfiguration refuses everything: production URL, missing / short / reused secrets, http n8n URL', async () => {
  for (const env of <Record<string, string>[]>[{ SUPABASE_URL: 'https://aplbsutpzgemexayldct.supabase.co' }, { WA_N8N_TO_EDGE_TOKEN: '' },
    { WA_CAPABILITY_SECRET: 'short' }, { WA_N8N_TO_EDGE_TOKEN: T_E2N }, { WA_N8N_INBOUND_URL: 'http://plain.example' },
    { WA_N8N_INBOUND_URL: 'https://x.example/aplbsutpzgemexayldct' }]) {
    const x = rig({ env });
    assertEquals((await x.h(metaReq(metaBody([])))).status, 503);
    assertEquals(x.calls.length, 0);
  }
});

Deno.test('E-12 failed gateway sign-in → 503 to Meta (retried later), no forwarding', async () => {
  const x = rig({ loginStatus: 400 });
  assertEquals((await x.h(metaReq(metaBody([])))).status, 503);
  assertEquals(x.calls.filter((c) => c.url === N8N).length, 0);
});

// ── cross-compatibility with the n8n logic (the exact code embedded in the workflow) ──
const WA = new Function(Deno.readTextFileSync(new URL('../../n8n/logic.js', import.meta.url)) + '\nreturn WA;')();

Deno.test('E-13 Edge → n8n body passes WA.verify; WA.route + WA.prepare output is accepted by the Edge action check', async () => {
  const m = [{ inbound_id: 5, outcome: 'ACCEPTED', duplicate: false, kind: 'text', text: 'gasté 1500 en alimento', phone: PHONE }];
  const x = rig({ rpc: (fn) => fn === 'wa_ingest' ? [200, { ok: true, messages: m }] : [200, { ok: true, state: 'DRAFT' }] });
  await x.h(metaReq(metaBody([]))); await Promise.all(x.bg);
  const body = JSON.parse(String(x.calls.find((c) => c.url === N8N)!.init.body));
  const v = WA.verify(body, x.nowS(), {});
  assertEquals([v.ok, v.event.inbound_id], [true, 5]);
  const cfg = { ar_strip_9: true };
  const r = WA.route(v.event, cfg);
  const p = WA.prepare(r.request, x.nowS(), WA.nonce());
  const res = await x.h(new Request(`${BASE}/functions/v1/wa-gateway/action`, { method: 'POST', body: p.raw, headers: { ...p.headers, 'x-wa-token': T_N2E } }));
  assertEquals(res.status, 200);
  assertEquals(r.request.action, 'context');                       // every text first reads the database context
  assertEquals(JSON.parse(String(x.calls.find((c) => c.url.endsWith('/rpc/wa_context'))!.init.body)), { p_inbound_id: 5 });
});

Deno.test('E-14 context action: read-only wa_context with the capability of THAT message; refused without it', async () => {
  const x = rig({ rpc: (fn) => [200, { ok: true, open: null, waiting: [], catalog: { categories: [], accounts: [] }, fn }] });
  const cap = await mintCap(CAPS, 77, x.nowS());
  const ok = await x.h(actionReq({ action: 'context', inbound_id: 77, cap }, x.nowS()));
  assertEquals(ok.status, 200);
  assertEquals(JSON.parse(String(x.calls.find((c) => c.url.endsWith('/rpc/wa_context'))!.init.body)), { p_inbound_id: 77 });
  assertEquals((await x.h(actionReq({ action: 'context', inbound_id: 78, cap }, x.nowS()))).status, 403);
  assertEquals((await x.h(actionReq({ action: 'context', inbound_id: 77 }, x.nowS()))).status, 403);
});


// ── receipts: photo / PDF stored once, n8n gets a signed URL (ADR-025 stage 4) ────────────────────────────────────────────
const GRAPH = 'graph-token-'.padEnd(40, 'g');
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const mediaWorld = (o: { mime?: string; size?: number; upload?: number } = {}) => (url: string, init: RequestInit): Response | null => {
  if (url.startsWith('https://graph.facebook.com/')) return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp/x', mime_type: o.mime ?? 'image/jpeg', file_size: o.size ?? JPEG.length }), { status: 200 });
  if (url.startsWith('https://lookaside.fbsbx.com/')) return new Response(JPEG, { status: 200 });
  if (url.includes('/storage/v1/object/sign/')) return new Response(JSON.stringify({ signedURL: '/object/sign/wa-media/wa/x.jpg?token=SECRET-SIGNED' }), { status: 200 });
  if (url.includes('/storage/v1/object/wa-media/')) return new Response(o.upload === 409 ? '{"error":"Duplicate"}' : '{}', { status: o.upload ?? 200 });
  return null;
};
const imageMsg = (caption: string | null) => ({ inbound_id: 41, outcome: 'ACCEPTED', duplicate: false, kind: 'image', media_id: 'm-1', caption, phone: PHONE });
const forwarded = (calls: Call[]) => calls.filter((c) => c.url === N8N).map((c) => JSON.parse(String(c.init.body)).event);
const storeRpc = (doc: Record<string, unknown> = { ok: true, document_file_id: 'f-1', duplicate: false, links: [] }) => (fn: string): [number, unknown] =>
  fn === 'wa_ingest' ? [200, { ok: true, messages: [imageMsg('gasté esto en gasoil')] }] : fn === 'wa_store_media' ? [200, doc] : [200, { ok: true }];

Deno.test('M-1 a photo: downloaded with the Graph token, stored as wa/<sha256>.jpg (no upsert), registered, forwarded with caption + signed URL', async () => {
  const { h, calls, bg, logs } = rig({ env: { WA_META_GRAPH_TOKEN: GRAPH }, rpc: storeRpc(), extra: mediaWorld() });
  assertEquals((await h(metaReq(metaBody([{}])))).status, 200);
  await Promise.all(bg);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', JPEG))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const up = calls.find((c) => c.url.includes('/storage/v1/object/wa-media/'))!;
  assertEquals(up.url, `${BASE}/storage/v1/object/wa-media/wa/${sha}.jpg`);
  assertEquals((up.init.headers as Record<string, string>)['x-upsert'], 'false');
  const store = calls.find((c) => c.url.endsWith('/rpc/wa_store_media'))!;
  assertEquals(JSON.parse(String(store.init.body)), { p_inbound_id: 41, p_sha256: sha, p_content_type: 'image/jpeg', p_byte_size: JPEG.length });
  const ev = forwarded(calls)[0];
  assertEquals([ev.kind, ev.caption, ev.document.id, ev.document.mime], ['image', 'gasté esto en gasoil', 'f-1', 'image/jpeg']);
  assert(ev.document.signed_url.startsWith(`${BASE}/storage/v1/object/sign/`));
  const graphCall = calls.find((c) => c.url.startsWith('https://graph.facebook.com/'))!;
  assertEquals((graphCall.init.headers as Record<string, string>).authorization, `Bearer ${GRAPH}`);
  assert(!JSON.stringify(logs).includes('SECRET-SIGNED') && !JSON.stringify(logs).includes(GRAPH), 'no token / signed URL in the logs');
});

Deno.test('M-2 the same bytes already stored (409) are reused; unsupported type / too large / no Graph token → media_error, nothing stored', async () => {
  let r = rig({ env: { WA_META_GRAPH_TOKEN: GRAPH }, rpc: storeRpc({ ok: true, document_file_id: 'f-1', duplicate: true, links: [{}] }), extra: mediaWorld({ upload: 409 }) });
  await r.h(metaReq(metaBody([{}]))); await Promise.all(r.bg);
  assertEquals(forwarded(r.calls)[0].document.duplicate, true);
  for (const [o, env, code] of <[Record<string, number | string>, Record<string, string>, string][]>[
    [{ mime: 'audio/ogg' }, { WA_META_GRAPH_TOKEN: GRAPH }, 'unsupported_type'], [{ size: 11 * 1024 * 1024 }, { WA_META_GRAPH_TOKEN: GRAPH }, 'too_large'],
    [{}, {}, 'media_not_configured']]) {
    r = rig({ env, rpc: storeRpc(), extra: mediaWorld(o as any) });
    await r.h(metaReq(metaBody([{}]))); await Promise.all(r.bg);
    assertEquals(forwarded(r.calls)[0].media_error, code);
    assert(!r.calls.some((c) => c.url.endsWith('/rpc/wa_store_media')), 'nothing registered');
  }
});
