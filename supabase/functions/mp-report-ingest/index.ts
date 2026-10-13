/**
 * ADR-018 §9.3 — `mp-report-ingest` Supabase Edge Function (verify_jwt = true), VALIDATION mode only.
 *
 * The request logic lives in ./handler.ts; this file only wires the runtime.
 * Runtime values read here and nowhere else: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (platform)
 * and MP_ACCESS_TOKEN (the existing Edge Function secret also used by mp-worker). Neither the service key nor the
 * Mercado Pago token ever leaves this function, and neither is logged.
 *
 *   identity   GET  /auth/v1/user                  with the caller's JWT  → uid (never from the body)
 *   role       POST /rest/v1/rpc/current_app_role  with the caller's JWT  → ADMIN required (active perfil)
 *   reads      PostgREST with the service key: financial_account, fin_import_run
 *   evidence   Storage with the service key, bucket financial-statements, x-upsert: false, never deleted
 *   write      POST /rest/v1/rpc/fin_capture_mp_release_report with the service key (p_actor = uid)
 *   MP         https://api.mercadopago.com/v1/account/release_report{/config,/task/{id},/list,/{file_name}} (15 s timeout each)
 */
import { BUCKET, CaptureRpcError, CORS_HEADERS, handleIngest, type LogEntry, type RunRow, type AuthResult } from './handler.ts';

const env = (name: string): string | null => {
  const v = Deno.env.get(name);
  return v !== undefined && v !== '' ? v : null;
};
const supabaseUrl = env('SUPABASE_URL');
const anonKey = env('SUPABASE_ANON_KEY');
const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
const mpToken = env('MP_ACCESS_TOKEN');
const MP_API = 'https://api.mercadopago.com';
const MP_TIMEOUT_MS = 15000;

const service = { apikey: serviceKey ?? '', authorization: `Bearer ${serviceKey}` };

async function authorize(authorization: string | null): Promise<AuthResult> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!m) return { ok: false, status: 401, code: 'NOT_AUTHENTICATED' };
  const user = { apikey: anonKey ?? '', authorization: `Bearer ${m[1]}` };
  const u = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: user });
  if (!u.ok) { await u.body?.cancel(); return { ok: false, status: 401, code: 'NOT_AUTHENTICATED' }; }
  const uid = (await u.json())?.id;
  if (typeof uid !== 'string') return { ok: false, status: 401, code: 'NOT_AUTHENTICATED' };
  const r = await fetch(`${supabaseUrl}/rest/v1/rpc/current_app_role`, {
    method: 'POST', headers: { ...user, 'content-type': 'application/json' }, body: '{}',
  });
  if (!r.ok) { await r.body?.cancel(); return { ok: false, status: 403, code: 'USER_NOT_FOUND_OR_INACTIVE' }; }
  return (await r.json()) === 'ADMIN' ? { ok: true, uid } : { ok: false, status: 403, code: 'ADMIN_REQUIRED' };
}

async function select<T>(table: string, query: string): Promise<T[]> {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, { headers: service });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`select ${table}: HTTP ${res.status}`); }
  return await res.json() as T[];
}

const objectUrl = (path: string) => `${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`;

async function download(path: string): Promise<Uint8Array | null> {
  const res = await fetch(objectUrl(path), { headers: service });
  if (res.status === 400 || res.status === 404) { await res.body?.cancel(); return null; }   // storage reports a missing object as 400/404
  if (!res.ok) { await res.body?.cancel(); throw new Error(`download: HTTP ${res.status}`); }
  return new Uint8Array(await res.arrayBuffer());
}

async function upload(path: string, bytes: Uint8Array): Promise<'created' | 'exists'> {
  const res = await fetch(objectUrl(path), {
    method: 'POST', headers: { ...service, 'content-type': 'text/csv', 'x-upsert': 'false' }, body: bytes as Uint8Array<ArrayBuffer>,
  });
  const text = await res.text();
  if (res.ok) return 'created';
  if (res.status === 409 || /Duplicate|already exists/i.test(text)) return 'exists';
  throw new Error(`upload: HTTP ${res.status}`);
}

async function capture(params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/fin_capture_mp_release_report`, {
    method: 'POST', headers: { ...service, 'content-type': 'application/json' }, body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new CaptureRpcError(String(body?.message ?? `HTTP ${res.status}`));
  return body as Record<string, unknown>;
}

function mp(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  return fetch(`${MP_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${mpToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(MP_TIMEOUT_MS),
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const log = (entry: LogEntry) => console.log(JSON.stringify({ fn: 'mp-report-ingest', ...entry }));

Deno.serve((req) => {
  if (supabaseUrl === null || anonKey === null || serviceKey === null || mpToken === null) {
    log({ event: 'refused', status: 503, code: 'NOT_CONFIGURED' });
    return new Response(JSON.stringify({ error: 'NOT_CONFIGURED' }), { status: 503, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
  }
  return handleIngest(req, {
    authorize,
    loadMpAccount: async () => {
      const rows = await select<{ id: string }>('financial_account', 'select=id&nombre=eq.Mercado%20Pago&account_type=eq.EXTERNAL_SERVICE&activo=is.true');
      return rows.length === 1 ? rows[0].id : null;
    },
    loadRun: async (id) => {
      const rows = await select<RunRow>('fin_import_run',
        'select=id,source_kind,mode,status,financial_account_id,format_code,parser_version,file_sha256,storage_path,coverage_from,coverage_to,' +
          `rows_total,rows_captured,rows_invalid,reject_reason,previous_run_id&id=eq.${encodeURIComponent(id)}`);
      return rows.length === 1 ? rows[0] : null;
    },
    mp,
    download,
    upload,
    capture,
    sha256,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    now: () => Date.now(),
  });
});
