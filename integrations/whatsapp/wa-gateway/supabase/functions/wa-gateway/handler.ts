/**
 * ADR-025 §18 — wa-gateway (STAGING: AppGranja only). Pure request handler; index.ts wires the runtime.
 *
 *   GET  /wa-gateway          Meta webhook verification (hub.verify_token = WA_META_VERIFY_TOKEN)
 *   POST /wa-gateway          Meta webhook: the ORIGINAL bytes + X-Hub-Signature-256 go to public.wa_ingest, which verifies
 *                             the HMAC in the database (app secret only in Vault) BEFORE anything is stored; accepted, new
 *                             messages are forwarded to n8n (retried) after Meta already got its 200.
 *   POST /wa-gateway/action   n8n → one of the public.wa_* RPCs (incl. the read-only wa_context).
 *
 * Shared n8n instance (owner decision): n8n holds NO signing secret and needs no env / builtin access. Instead:
 *   Edge → n8n   header x-wa-token (n8n Webhook "Header Auth" credential, encrypted by n8n) + ts + nonce (checked in n8n)
 *   n8n → Edge   header x-wa-token (n8n HTTP "Header Auth" credential) + ts window + single-use nonce + per-message
 *                CAPABILITY: cap = v1.<inbound_id>.<exp>.HMAC(WA_CAPABILITY_SECRET) minted here when forwarding, echoed back
 *                by n8n; an action on an inbound message is refused without the capability of THAT message (15 min).
 *   and the database idempotency (wa.claim_inbound: one action per message, replays return the stored result).
 *
 * Identity: the dedicated Auth user wa-gateway (no profile) through PostgREST — never service_role, never a DB URL.
 * Logs: JSON lines with event names, inbound ids, error codes and phone LAST 3 digits only; never message text, tokens,
 * capabilities or full phones.
 */
export const STAGING_REF = 'aplbsutpzgemexayldct';
const FORBIDDEN_REFS = ['ycmkpnunhxluqqtecbyu', 'shdrztqgwpyyxclgfpdg'];
export const MAX_META_BODY = 256 * 1024;
export const MAX_ACTION_BODY = 64 * 1024;
export const ACTION_WINDOW_S = 300;
export const CAP_TTL_S = 900;
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const SIGNED_URL_S = 600;
const MEDIA_BUCKET = 'wa-media';
const GRAPH_VERSION = 'v21.0';
const MEDIA_EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface Deps {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;                       // ms
  log: (entry: Record<string, unknown>) => void;
  waitUntil: (p: Promise<unknown>) => void;
  sleep: (ms: number) => Promise<void>;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export async function hmacHex(secret: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
/** constant-time comparison of two strings (length leak only) */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
export const maskPhone = (p: unknown) => (typeof p === 'string' && p.length > 3 ? `***${p.slice(-3)}` : '***');
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const short = (s: unknown) => String(s ?? '').slice(0, 160);

export async function mintCap(secret: string, inboundId: number, nowS: number): Promise<string> {
  const exp = nowS + CAP_TTL_S;
  return `v1.${inboundId}.${exp}.${await hmacHex(secret, `v1.${inboundId}.${exp}`)}`;
}
async function capOk(secret: string, cap: unknown, inboundId: unknown, nowS: number): Promise<string | null> {
  const m = typeof cap === 'string' ? cap.match(/^v1\.([0-9]{1,18})\.([0-9]{10})\.([0-9a-f]{64})$/) : null;
  if (!m) return 'cap_format';
  if (Number(m[1]) !== inboundId) return 'cap_other_message';
  if (Number(m[2]) < nowS) return 'cap_expired';
  return safeEqual(m[3], await hmacHex(secret, `v1.${m[1]}.${m[2]}`)) ? null : 'cap_signature';
}

// the seven public.wa_* RPCs, with the exact parameter names the n8n actions map to
const ACTIONS: Record<string, { fn: string; inbound: boolean; args: (b: Record<string, unknown>) => Record<string, unknown> | null }> = {
  propose: { fn: 'wa_propose', inbound: true, args: (b) => isId(b.inbound_id) && typeof b.type === 'string' && isObj(b.payload)
    ? { p_inbound_id: b.inbound_id, p_type: b.type, p_payload: b.payload } : null },
  correct: { fn: 'wa_correct', inbound: true, args: (b) => isId(b.inbound_id) && isUuid(b.draft_id) && isVer(b.expected_version) && isObj(b.payload)
    ? { p_inbound_id: b.inbound_id, p_draft_id: b.draft_id, p_expected_version: b.expected_version, p_payload: b.payload } : null },
  cancel: { fn: 'wa_cancel', inbound: true, args: (b) => isId(b.inbound_id) && isUuid(b.draft_id) && isVer(b.expected_version)
    ? { p_inbound_id: b.inbound_id, p_draft_id: b.draft_id, p_expected_version: b.expected_version } : null },
  link_mp: { fn: 'wa_link_mp', inbound: true, args: (b) => isId(b.inbound_id) && isUuid(b.draft_id) && isVer(b.expected_version) && typeof b.source_id === 'string' && /^[0-9]{1,20}$/.test(b.source_id)
    ? { p_inbound_id: b.inbound_id, p_draft_id: b.draft_id, p_expected_version: b.expected_version, p_source_id: b.source_id } : null },
  confirm: { fn: 'wa_confirm', inbound: true, args: (b) => isId(b.inbound_id) && isUuid(b.draft_id) && isVer(b.expected_version)
    ? { p_inbound_id: b.inbound_id, p_draft_id: b.draft_id, p_expected_version: b.expected_version } : null },
  expire: { fn: 'wa_expire', inbound: false, args: () => ({}) },
  // read-only: the sender's live drafts (current version + payload) and the catalog, for the interpreter
  context: { fn: 'wa_context', inbound: true, args: (b) => isId(b.inbound_id) ? { p_inbound_id: b.inbound_id } : null },
};
const isId = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const isVer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 10000;
const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);

export function createHandler(d: Deps) {
  const E = (k: string) => d.env(k) ?? '';
  const base = E('SUPABASE_URL').replace(/\/+$/, '');
  const anon = E('SUPABASE_ANON_KEY');
  const required = ['WA_GATEWAY_EMAIL', 'WA_GATEWAY_PASSWORD', 'WA_META_VERIFY_TOKEN', 'WA_EDGE_TO_N8N_TOKEN', 'WA_N8N_TO_EDGE_TOKEN', 'WA_CAPABILITY_SECRET', 'WA_N8N_INBOUND_URL'];
  const weak = ['WA_EDGE_TO_N8N_TOKEN', 'WA_N8N_TO_EDGE_TOKEN', 'WA_CAPABILITY_SECRET', 'WA_META_VERIFY_TOKEN'].find((k) => E(k) && E(k).length < 32);
  const distinct = new Set(['WA_EDGE_TO_N8N_TOKEN', 'WA_N8N_TO_EDGE_TOKEN', 'WA_CAPABILITY_SECRET'].map(E)).size === 3;
  const misconfig = !base.startsWith(`https://${STAGING_REF}.supabase.co`) ? 'not the AppGranja staging project'
    : FORBIDDEN_REFS.some((r) => base.includes(r) || E('WA_N8N_INBOUND_URL').includes(r)) ? 'forbidden project reference'
    : !anon ? 'SUPABASE_ANON_KEY missing'
    : required.find((k) => !E(k)) ? `secret missing: ${required.find((k) => !E(k))}`
    : weak ? `secret too short: ${weak}`
    : !distinct ? 'tokens and capability secret must be distinct'
    : !/^https:\/\//.test(E('WA_N8N_INBOUND_URL')) ? 'WA_N8N_INBOUND_URL must be https'
    : null;
  const seenNonces = new Map<string, number>();    // per isolate; the capability + the database idempotency are the real barriers

  // ── gateway session (password grant of the wa-gateway Auth user; cached until 60 s before expiry) ──
  let session: { token: string; exp: number } | null = null;
  async function token(force = false): Promise<string> {
    if (!force && session && session.exp - 60_000 > d.now()) return session.token;
    const r = await d.fetch(`${base}/auth/v1/token?grant_type=password`, { method: 'POST',
      headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: E('WA_GATEWAY_EMAIL'), password: E('WA_GATEWAY_PASSWORD') }) });
    if (!r.ok) { session = null; throw new Error(`gateway sign-in failed: HTTP ${r.status}`); }
    const j = await r.json();
    session = { token: j.access_token, exp: d.now() + Number(j.expires_in ?? 3600) * 1000 };
    return session.token;
  }
  async function rpc(fn: string, args: Record<string, unknown>): Promise<{ status: number; body: any }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await d.fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST',
        headers: { apikey: anon, authorization: `Bearer ${await token(attempt > 0)}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
      const text = await r.text();
      let body: any = null; try { body = JSON.parse(text); } catch { body = { message: text }; }
      if (r.status === 401 && attempt === 0) continue;   // expired / revoked token: sign in again once
      return { status: r.status, body };
    }
    return { status: 401, body: { message: 'gateway unauthorized' } };
  }

  // ── Edge → n8n (token header + fresh ts / nonce per attempt; retried on network error / 429 / 5xx) ──
  async function forward(event: Record<string, unknown>): Promise<void> {
    const cap = await mintCap(E('WA_CAPABILITY_SECRET'), event.inbound_id as number, Math.floor(d.now() / 1000));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const body = JSON.stringify({ ts: Math.floor(d.now() / 1000).toString(), nonce: crypto.randomUUID().replace(/-/g, ''), event: { ...event, cap } });
      let status = 0;
      try {
        const r = await d.fetch(E('WA_N8N_INBOUND_URL'), { method: 'POST', body, headers: {
          'content-type': 'application/json', 'x-wa-token': E('WA_EDGE_TO_N8N_TOKEN'), 'x-wa-idempotency-key': `in:${event.inbound_id}` } });
        status = r.status; await r.body?.cancel();
      } catch { status = 0; }
      if (status >= 200 && status < 300) { d.log({ evt: 'n8n_forwarded', inbound_id: event.inbound_id, attempt }); return; }
      const retry = status === 0 || status === 429 || status >= 500;
      d.log({ evt: retry && attempt < 3 ? 'n8n_retry' : 'n8n_forward_failed', inbound_id: event.inbound_id, attempt, status });
      if (!retry) return;
      if (attempt < 3) await d.sleep(500 * 2 ** (attempt - 1));
    }
  }

  // ── receipts (ADR-025 stage 4): the original photo / PDF, downloaded from Meta right away (its URL expires), stored once in the
  //    private bucket wa-media (wa/<sha256>.<ext>, gateway identity), registered by wa_store_media; n8n gets a 10-minute signed URL.
  //    Any failure → the event goes on with media_error (n8n asks for the file again); never a token / URL in the logs.
  async function storeMedia(m: Record<string, unknown>): Promise<Record<string, unknown>> {
    const graph = E('WA_META_GRAPH_TOKEN');
    if (!graph) return { media_error: 'media_not_configured' };
    try {
      const meta = await d.fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(String(m.media_id))}`, { headers: { authorization: `Bearer ${graph}` } });
      if (!meta.ok) return { media_error: `meta_media_${meta.status}` };
      const info = await meta.json() as { url?: string; mime_type?: string; file_size?: number };
      const mime = String(info.mime_type ?? '').split(';')[0].trim().toLowerCase();
      const ext = MEDIA_EXT[mime];
      if (!ext) return { media_error: 'unsupported_type' };
      if (Number(info.file_size ?? 0) > MAX_MEDIA_BYTES) return { media_error: 'too_large' };
      if (!info.url || !/^https:\/\//.test(info.url)) return { media_error: 'meta_media_url' };
      const file = await d.fetch(info.url, { headers: { authorization: `Bearer ${graph}` } });
      if (!file.ok) return { media_error: `meta_download_${file.status}` };
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) return { media_error: bytes.length ? 'too_large' : 'empty' };
      const sha = hex(await crypto.subtle.digest('SHA-256', bytes));
      const path = `wa/${sha}.${ext}`;
      const up = await d.fetch(`${base}/storage/v1/object/${MEDIA_BUCKET}/${path}`, { method: 'POST', body: bytes,
        headers: { apikey: anon, authorization: `Bearer ${await token()}`, 'content-type': mime, 'x-upsert': 'false' } });
      const upText = up.ok ? '' : await up.text();
      if (!up.ok && !(up.status === 409 || /duplicate|already exists/i.test(upText))) return { media_error: `storage_${up.status}` };
      const reg = await rpc('wa_store_media', { p_inbound_id: m.inbound_id, p_sha256: sha, p_content_type: mime, p_byte_size: bytes.length });
      if (reg.status !== 200 || reg.body?.ok !== true) return { media_error: 'store_refused' };
      const sg = await d.fetch(`${base}/storage/v1/object/sign/${MEDIA_BUCKET}/${path}`, { method: 'POST', body: JSON.stringify({ expiresIn: SIGNED_URL_S }),
        headers: { apikey: anon, authorization: `Bearer ${await token()}`, 'content-type': 'application/json' } });
      const sj = sg.ok ? await sg.json() as { signedURL?: string } : {};
      if (!sj.signedURL) return { media_error: 'sign_failed' };
      d.log({ evt: 'media_stored', inbound_id: m.inbound_id, mime, bytes: bytes.length, duplicate: reg.body.duplicate === true });
      return { document: { id: reg.body.document_file_id, mime, signed_url: `${base}/storage/v1${sj.signedURL}`, duplicate: reg.body.duplicate === true,
                           links: Array.isArray(reg.body.links) ? reg.body.links.length : 0, draft_short_code: reg.body.draft_short_code ?? null } };
    } catch (e) {
      d.log({ evt: 'media_error', inbound_id: m.inbound_id, error: short((e as Error).message) });
      return { media_error: 'media_exception' };
    }
  }

  async function metaVerify(url: URL): Promise<Response> {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && safeEqual(url.searchParams.get('hub.verify_token') ?? '', E('WA_META_VERIFY_TOKEN'));
    d.log({ evt: 'meta_verify', ok });
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 }) : json(403, { error: 'forbidden' });
  }

  async function metaWebhook(req: Request): Promise<Response> {
    const sig = req.headers.get('x-hub-signature-256') ?? '';
    if (!/^sha256=[0-9a-f]{64}$/.test(sig)) { d.log({ evt: 'meta_rejected', reason: 'signature_header' }); return json(401, { error: 'unauthorized' }); }
    if (Number(req.headers.get('content-length') ?? 0) > MAX_META_BODY) { d.log({ evt: 'meta_rejected', reason: 'too_large' }); return json(413, { error: 'too large' }); }
    const bytes = new Uint8Array(await req.arrayBuffer());     // the ORIGINAL bytes — never re-serialized
    if (bytes.length > MAX_META_BODY) { d.log({ evt: 'meta_rejected', reason: 'too_large' }); return json(413, { error: 'too large' }); }
    let res;
    try { res = await rpc('wa_ingest', { p_raw_b64: b64(bytes), p_signature: sig }); }
    catch (e) { d.log({ evt: 'ingest_error', error: short((e as Error).message) }); return json(503, { error: 'unavailable' }); }
    if (res.status !== 200) { d.log({ evt: 'ingest_error', status: res.status, code: res.body?.code, error: short(res.body?.message) }); return json(500, { error: 'ingest failed' }); }
    if (res.body?.ok !== true) { d.log({ evt: 'meta_rejected', reason: res.body?.error ?? 'unknown' }); return json(401, { error: 'unauthorized' }); }
    const msgs: any[] = Array.isArray(res.body.messages) ? res.body.messages : [];
    for (const m of msgs) {
      d.log({ evt: 'message', inbound_id: m.inbound_id, outcome: m.outcome, duplicate: m.duplicate, kind: m.kind, phone: maskPhone(m.phone) });
      if (m.outcome === 'ACCEPTED' && !m.duplicate) {
        const ev = { type: 'wa.message', inbound_id: m.inbound_id, kind: m.kind, text: m.text ?? null,
          button_payload: m.button_payload ?? null, media_id: m.media_id ?? null, phone: m.phone };
        if ((m.kind === 'image' || m.kind === 'document') && m.media_id) {
          d.waitUntil(storeMedia(m).then((media) => forward({ ...ev, caption: m.caption ?? null, ...media })));
        } else d.waitUntil(forward(ev));
      }
    }
    return json(200, { received: msgs.length });
  }

  async function action(req: Request): Promise<Response> {
    const tok = req.headers.get('x-wa-token') ?? '', ts = req.headers.get('x-wa-timestamp') ?? '', nonce = req.headers.get('x-wa-nonce') ?? '';
    if (!safeEqual(tok, E('WA_N8N_TO_EDGE_TOKEN'))) { d.log({ evt: 'action_rejected', reason: 'token' }); return json(401, { error: 'unauthorized' }); }
    if (!/^[0-9]{10}$/.test(ts) || !/^[0-9a-f]{16,64}$/.test(nonce)) { d.log({ evt: 'action_rejected', reason: 'headers' }); return json(401, { error: 'unauthorized' }); }
    const nowS = d.now() / 1000;
    if (Math.abs(nowS - Number(ts)) > ACTION_WINDOW_S) { d.log({ evt: 'action_rejected', reason: 'stale' }); return json(401, { error: 'unauthorized' }); }
    if (Number(req.headers.get('content-length') ?? 0) > MAX_ACTION_BODY) return json(413, { error: 'too large' });
    const raw = await req.text();
    if (raw.length > MAX_ACTION_BODY) return json(413, { error: 'too large' });
    const now = d.now();
    for (const [k, t] of seenNonces) if (now - t > ACTION_WINDOW_S * 2000) seenNonces.delete(k);
    if (seenNonces.has(nonce)) { d.log({ evt: 'action_rejected', reason: 'nonce_replay' }); return json(409, { error: 'replayed' }); }
    seenNonces.set(nonce, now);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return json(400, { error: 'invalid json' }); }
    const a = ACTIONS[String(body?.action)];
    const args = a?.args(body ?? {});
    if (!a || !args) { d.log({ evt: 'action_rejected', reason: 'invalid_action', action: short(body?.action) }); return json(400, { error: 'invalid action' }); }
    if (a.inbound) {
      const bad = await capOk(E('WA_CAPABILITY_SECRET'), body.cap, body.inbound_id, Math.floor(nowS));
      if (bad) { d.log({ evt: 'action_rejected', reason: bad, inbound_id: body.inbound_id }); return json(403, { error: 'forbidden' }); }
    }
    let res;
    try { res = await rpc(a.fn, args); }
    catch (e) { d.log({ evt: 'action_error', action: body.action, error: short((e as Error).message) }); return json(503, { error: 'unavailable' }); }
    if (res.status === 200) {
      d.log({ evt: 'action', action: body.action, inbound_id: body.inbound_id ?? null, ok: res.body?.ok ?? null, state: res.body?.state ?? null,
              replay: res.body?.replay ?? false, error: res.body?.error ? short(res.body.error) : undefined });
      return json(200, { ok: true, result: res.body });
    }
    const code = String(res.body?.message ?? '').match(/^[A-Z_]{3,60}/)?.[0] ?? res.body?.code ?? 'ERROR';
    d.log({ evt: 'action_refused', action: body.action, inbound_id: body.inbound_id ?? null, status: res.status, code });
    return json(res.status === 400 ? 422 : 502, { ok: false, error: { code, message: short(res.body?.message) } });
  }

  return async (req: Request): Promise<Response> => {
    if (misconfig) { d.log({ evt: 'misconfigured', reason: misconfig }); return json(503, { error: 'misconfigured' }); }
    const url = new URL(req.url);
    const isAction = url.pathname.replace(/\/+$/, '').endsWith('/wa-gateway/action');
    try {
      if (isAction) return req.method === 'POST' ? await action(req) : json(405, { error: 'method' });
      if (req.method === 'GET') return await metaVerify(url);
      if (req.method === 'POST') return await metaWebhook(req);
      return json(405, { error: 'method' });
    } catch (e) {
      d.log({ evt: 'unhandled', error: short((e as Error).message) });
      return json(500, { error: 'internal' });
    }
  };
}
