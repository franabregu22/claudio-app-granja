/**
 * ADR-018 §9 — runtime wiring shared by the Edge Functions mp-report-ingest (ADMIN) and mp-report-daily (scheduler).
 * Runtime values read here and nowhere else: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (platform) and
 * MP_ACCESS_TOKEN (the existing Edge Function secret also used by mp-worker). Neither the service key nor the Mercado
 * Pago token ever leaves the function, and neither is logged.
 *
 *   reads      PostgREST with the service key (financial_account, fin_import_run, fin_mp_report_schedule_log)
 *   evidence   Storage with the service key, bucket financial-statements, x-upsert: false, never deleted
 *   writes     POST /rest/v1/rpc/<function> with the service key (report ingestion; payout destinations: values never logged)
 *   MP         https://api.mercadopago.com/v1/account/release_report{/config,/task/{id},/list,/{file_name}} (15 s timeout each)
 */
import { BUCKET, CaptureRpcError, type LogEntry, type ReportDeps, type RunRow } from '../mp-report-ingest/handler.ts';

export const env = (name: string): string | null => {
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

export const runtimeConfigured = () => supabaseUrl !== null && anonKey !== null && serviceKey !== null && mpToken !== null;
export const SUPABASE_URL = supabaseUrl;
export const ANON_KEY = anonKey;

export async function select<T>(table: string, query: string): Promise<T[]> {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, { headers: service });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`select ${table}: HTTP ${res.status}`); }
  return await res.json() as T[];
}

/** POST /rest/v1/rpc/<fn> with the service key; a database refusal becomes CaptureRpcError(message). */
export async function rpc(fn: string, params: unknown): Promise<unknown> {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { ...service, 'content-type': 'application/json' }, body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new CaptureRpcError(String(body?.message ?? `HTTP ${res.status}`));
  return body;
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

/** Every IngestDeps member except `authorize` (each function authenticates its own callers). */
export function reportDeps(fnName: string): ReportDeps {
  return {
    loadMpAccount: async () => {
      const rows = await select<{ id: string }>('financial_account', 'select=id&nombre=eq.Mercado%20Pago&account_type=eq.EXTERNAL_SERVICE&activo=is.true');
      return rows.length === 1 ? rows[0].id : null;
    },
    loadRun: async (id) => {
      const rows = await select<RunRow>('fin_import_run',
        'select=id,source_kind,mode,status,financial_account_id,format_code,parser_version,file_sha256,storage_path,coverage_from,coverage_to,' +
          'rows_total,rows_captured,rows_invalid,reject_reason,previous_run_id,lines_new,lines_known,rows_ignored,file_name,byte_size,source_meta' +
          `&id=eq.${encodeURIComponent(id)}`);
      return rows.length === 1 ? rows[0] : null;
    },
    mp,
    download,
    upload,
    capture: async (p) => await rpc('fin_capture_mp_release_report', p) as Record<string, unknown>,
    ingest: async (p) => await rpc('fin_ingest_mp_release_report', p) as Record<string, unknown>,
    recordDestinations: async (p) => Number(await rpc('fin_record_mp_payout_destinations', p)),
    sha256,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (entry: LogEntry) => console.log(JSON.stringify({ fn: fnName, ...entry })),
    now: () => Date.now(),
  };
}
