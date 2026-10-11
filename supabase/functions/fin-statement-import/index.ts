/**
 * ADR-018 — `fin-statement-import` Supabase Edge Function (verify_jwt = true).
 *
 * The request logic lives in ./handler.ts; this file only wires the runtime.
 * Runtime values read here and nowhere else (platform-injected): SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY. The service key never leaves this function.
 *
 *   identity   GET  /auth/v1/user                  with the caller's JWT  → uid (never from the body)
 *   role       POST /rest/v1/rpc/current_app_role  with the caller's JWT  → ADMIN required (active perfil)
 *   reads      PostgREST with the service key: financial_account, fin_statement_account_config, fin_import_run
 *   evidence   Storage with the service key, bucket financial-statements, x-upsert: false, never deleted
 *   write      POST /rest/v1/rpc/fin_import_bank_statement with the service key (p_actor = uid)
 */
import { parseStatementPdf, type StatementAccountConfig } from '../_shared/bank-statement/index.ts';
import { type AccountRow, type AuthResult, BUCKET, CORS_HEADERS, handleImport, ImportRpcError, type LogEntry, type RunRow } from './handler.ts';

const env = (name: string): string | null => {
  const v = Deno.env.get(name);
  return v !== undefined && v !== '' ? v : null;
};
const supabaseUrl = env('SUPABASE_URL');
const anonKey = env('SUPABASE_ANON_KEY');
const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');

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

async function selectOne<T>(table: string, query: string): Promise<T | null> {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, { headers: service });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`select ${table}: HTTP ${res.status}`); }
  const rows = await res.json() as T[];
  return rows.length === 1 ? rows[0] : null;
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
    method: 'POST', headers: { ...service, 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: bytes as Uint8Array<ArrayBuffer>,
  });
  const text = await res.text();
  if (res.ok) return 'created';
  if (res.status === 409 || /Duplicate|already exists/i.test(text)) return 'exists';
  throw new Error(`upload: HTTP ${res.status}`);
}

async function importStatement(params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/fin_import_bank_statement`, {
    method: 'POST', headers: { ...service, 'content-type': 'application/json' }, body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ImportRpcError(String(body?.message ?? `HTTP ${res.status}`));
  return body as Record<string, unknown>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const log = (entry: LogEntry) => console.log(JSON.stringify({ fn: 'fin-statement-import', ...entry }));

Deno.serve((req) => {
  if (supabaseUrl === null || anonKey === null || serviceKey === null) {
    log({ event: 'refused', status: 503, code: 'NOT_CONFIGURED' });
    return new Response(JSON.stringify({ error: 'NOT_CONFIGURED' }), { status: 503, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
  }
  return handleImport(req, {
    authorize,
    loadAccount: (id) => selectOne<AccountRow>('financial_account', `select=id,activo,account_type&id=eq.${id}`),
    loadConfig: (id) => selectOne<StatementAccountConfig>('fin_statement_account_config',
      `select=format_code,expected_account_number,expected_cbu,expected_extra&financial_account_id=eq.${id}&activo=is.true`),
    loadRun: (id) => selectOne<RunRow>('fin_import_run',
      'select=id,source_kind,mode,status,financial_account_id,format_code,parser_version,file_sha256,storage_path,file_name,byte_size,' +
        `rows_total,lines_new,lines_known,rows_ignored,rows_invalid,rows_captured,reject_reason&id=eq.${id}`),
    download,
    upload,
    importStatement,
    parse: (bytes, cfg) => parseStatementPdf(bytes, cfg),
    sha256,
    log,
    now: () => Date.now(),
  });
});
