/**
 * ADR-018 — fin-statement-import request handler (runtime-agnostic core; index.ts wires the runtime).
 *
 * Authority: ADR-018 §6.1 (runs, reprocess chain), §7 (ingestion), §7.4 (expected identifiers), §7.5 (parser, limits),
 * §11 (ADMIN only, actor = the authenticated user), §13 (evidence immutability), §17 (failure handling);
 * fin_import_bank_statement (0075); bucket financial-statements (0074).
 *
 * Two explicit modes:
 *   upload    — multipart/form-data with exactly `financial_account_id` and one `file`;
 *   reprocess — application/json {"action":"reprocess","previous_run_id":"<uuid>"} over the bytes already stored.
 * The browser never supplies the actor, format_code, identifiers, parser version, path, hash or any derived field.
 *
 * Errors before the file is accepted (auth, request, account / configuration, size, not a PDF) → HTTP error, nothing
 * stored. Once accepted, the original bytes are stored once at bank/<account>/<sha256>.pdf (no upsert, never
 * deleted) and every outcome — parsed or rejected by the parser or by the database — is a persisted run returned
 * with HTTP 200 (status PARSED | REJECTED). Logs carry only ids, a hash prefix, codes and timings.
 */
import type { ParseResult, StatementAccountConfig } from '../_shared/bank-statement/index.ts';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const BUCKET = 'financial-statements';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

export interface AccountRow { id: string; activo: boolean; account_type: string }
export interface RunRow {
  id: string; source_kind: string; mode: string; status: string; financial_account_id: string; format_code: string | null;
  parser_version: string; file_sha256: string; storage_path: string; file_name: string; byte_size: number;
  rows_total: number; lines_new: number; lines_known: number; rows_ignored: number; rows_invalid: number; rows_captured: number;
  reject_reason: string | null;
}
export interface ImportParams {
  p_actor: string; p_account_id: string; p_parser_version: string; p_format_code: string | null; p_file_sha256: string;
  p_storage_path: string; p_file_name: string; p_byte_size: number; p_coverage_from: string | null; p_coverage_to: string | null;
  p_source_meta: Record<string, unknown> | null; p_previous_run_id: string | null; p_reject_reason: string | null; p_rows: unknown[] | null;
}
export type AuthResult = { ok: true; uid: string } | { ok: false; status: 401 | 403; code: string };
export interface LogEntry { event: string; code?: string; status?: number; run_id?: string; account?: string; sha?: string; ms?: number }

export interface ImportDeps {
  authorize(authorization: string | null): Promise<AuthResult>;
  loadAccount(id: string): Promise<AccountRow | null>;
  loadConfig(accountId: string): Promise<StatementAccountConfig | null>;
  loadRun(id: string): Promise<RunRow | null>;
  /** Stored object bytes, or null when the object does not exist. */
  download(path: string): Promise<Uint8Array | null>;
  /** Upload with upsert disabled: 'created', or 'exists' when the path is already taken. */
  upload(path: string, bytes: Uint8Array): Promise<'created' | 'exists'>;
  /** fin_import_bank_statement; throws ImportRpcError with the database message on failure. */
  importStatement(params: ImportParams): Promise<Record<string, unknown>>;
  parse(bytes: Uint8Array, cfg: StatementAccountConfig): Promise<ParseResult>;
  sha256(bytes: Uint8Array): Promise<string>;
  log(entry: LogEntry): void;
  now(): number;
}

export class ImportRpcError extends Error {}
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
const fail = (status: number, code: string) => { throw new HttpError(status, code); };
export const canonicalPath = (accountId: string, sha: string) => `bank/${accountId}/${sha}.pdf`;
const startsWithPdfMagic = (b: Uint8Array) => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;

/** Account must be an active BANK_ACCOUNT with an active statement configuration. */
async function accountContext(deps: ImportDeps, accountId: string): Promise<StatementAccountConfig> {
  const account = await deps.loadAccount(accountId);
  if (!account || !account.activo || account.account_type !== 'BANK_ACCOUNT') fail(422, 'ACCOUNT_NOT_FOUND_OR_NOT_BANK');
  const cfg = await deps.loadConfig(accountId);
  if (!cfg) fail(422, 'STATEMENT_CONFIG_MISSING');
  return cfg as StatementAccountConfig;
}

/** Store the original bytes once; an existing object must hold exactly the same bytes (content-addressed path). */
async function storeEvidence(deps: ImportDeps, path: string, sha: string, bytes: Uint8Array): Promise<'created' | 'reused'> {
  const verifyExisting = async () => {
    const stored = await deps.download(path);
    if (!stored || (await deps.sha256(stored)) !== sha) fail(409, 'EVIDENCE_INTEGRITY');
    return 'reused' as const;
  };
  if (await deps.download(path)) return verifyExisting();
  return (await deps.upload(path, bytes)) === 'created' ? 'created' : verifyExisting();   // 'exists': lost a race
}

const rpcStatus = (message: string): [number, string] => {
  const code = (/^([A-Z][A-Z_]+)/.exec(message) ?? [])[1] ?? 'IMPORT_FAILED';
  if (code === 'PREVIOUS_RUN_INVALID') return [409, code];
  if (code === 'FORBIDDEN') return [403, code];
  if (['ACCOUNT_NOT_FOUND_OR_NOT_BANK', 'STATEMENT_CONFIG_MISSING', 'FORMAT_NOT_ALLOWED_FOR_ACCOUNT'].includes(code)) return [422, code];
  return [500, 'IMPORT_FAILED'];
};

async function importParsed(deps: ImportDeps, args: {
  uid: string; accountId: string; cfg: StatementAccountConfig; bytes: Uint8Array; sha: string; path: string; fileName: string; previousRunId: string | null;
}): Promise<Response> {
  const parsed = await deps.parse(args.bytes, args.cfg);
  const params: ImportParams = parsed.ok
    ? {
      p_actor: args.uid, p_account_id: args.accountId, p_parser_version: parsed.statement.parser_version, p_format_code: parsed.statement.format_code,
      p_file_sha256: args.sha, p_storage_path: args.path, p_file_name: args.fileName, p_byte_size: args.bytes.length,
      p_coverage_from: parsed.statement.coverage_from, p_coverage_to: parsed.statement.coverage_to, p_source_meta: parsed.statement.source_meta,
      p_previous_run_id: args.previousRunId, p_reject_reason: null, p_rows: parsed.statement.rows,
    }
    : {
      p_actor: args.uid, p_account_id: args.accountId, p_parser_version: parsed.parser_version, p_format_code: parsed.format_code,
      p_file_sha256: args.sha, p_storage_path: args.path, p_file_name: args.fileName, p_byte_size: args.bytes.length,
      p_coverage_from: null, p_coverage_to: null, p_source_meta: null, p_previous_run_id: args.previousRunId,
      p_reject_reason: parsed.reject_reason, p_rows: null,
    };
  let result: Record<string, unknown>;
  try {
    result = await deps.importStatement(params);
  } catch (e) {
    if (!(e instanceof ImportRpcError)) throw e;
    const [status, code] = rpcStatus(e.message);
    fail(status, code);
    throw e;
  }
  const run = await deps.loadRun(String(result.run_id));
  if (!run) fail(500, 'IMPORT_FAILED');
  const r = run as RunRow;
  return json(200, {
    run_id: r.id, status: r.status, replayed: result.replayed === true, financial_account_id: r.financial_account_id,
    file_sha256: r.file_sha256, parser_version: r.parser_version, format_code: r.format_code,
    counters: { rows_total: r.rows_total, lines_new: r.lines_new, lines_known: r.lines_known, rows_ignored: r.rows_ignored,
      rows_invalid: r.rows_invalid, rows_captured: r.rows_captured },
    reject_reason: r.reject_reason,
  });
}

async function handleUpload(req: Request, deps: ImportDeps, uid: string, t0: number): Promise<Response> {
  let form: FormData;
  try { form = await req.formData(); } catch { return fail(400, 'INVALID_MULTIPART'); }
  const keys = [...form.keys()];
  if (keys.some((k) => k !== 'financial_account_id' && k !== 'file')) fail(400, 'UNEXPECTED_FIELD');
  const files = form.getAll('file');
  if (files.length !== 1 || !(files[0] instanceof File)) fail(400, files.length > 1 ? 'MULTIPLE_FILES' : 'FILE_REQUIRED');
  const ids = form.getAll('financial_account_id');
  const accountId = typeof ids[0] === 'string' ? ids[0].trim().toLowerCase() : '';
  if (ids.length !== 1 || !UUID.test(accountId)) fail(400, 'INVALID_ACCOUNT_ID');
  const file = files[0] as File;
  if (file.size === 0) fail(400, 'EMPTY_FILE');
  if (file.size > MAX_FILE_BYTES) fail(413, 'FILE_TOO_LARGE');
  if (file.type && file.type !== 'application/pdf') fail(415, 'UNSUPPORTED_MEDIA_TYPE');

  const cfg = await accountContext(deps, accountId);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!startsWithPdfMagic(bytes)) fail(415, 'NOT_A_PDF');   // never trust the MIME type alone
  const sha = await deps.sha256(bytes);
  const path = canonicalPath(accountId, sha);
  const stored = await storeEvidence(deps, path, sha, bytes);
  // the user's file name is metadata only (never part of the path); keep it printable and bounded
  // deno-lint-ignore no-control-regex -- stripping control characters from the user's file name is intended
  const fileName = (file.name || 'statement.pdf').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) || 'statement.pdf';
  const res = await importParsed(deps, { uid, accountId, cfg, bytes, sha, path, fileName, previousRunId: null });
  deps.log({ event: 'import', status: res.status, account: accountId, sha: sha.slice(0, 12), code: stored, ms: Math.round(deps.now() - t0) });
  return res;
}

async function handleReprocess(req: Request, deps: ImportDeps, uid: string, t0: number): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return fail(400, 'INVALID_JSON'); }
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'action' && k !== 'previous_run_id')) fail(400, 'UNEXPECTED_FIELD');
  if (b.action !== 'reprocess') fail(400, 'UNKNOWN_ACTION');
  const runId = typeof b.previous_run_id === 'string' ? b.previous_run_id.trim().toLowerCase() : '';
  if (!UUID.test(runId)) fail(400, 'INVALID_RUN_ID');

  const run = await deps.loadRun(runId);
  if (!run) fail(404, 'RUN_NOT_FOUND');
  const prev = run as RunRow;
  if (prev.source_kind !== 'BANK_STATEMENT') fail(422, 'NOT_A_BANK_STATEMENT_RUN');
  if (prev.mode === 'NORMAL' && prev.status === 'PARSED') fail(409, 'ALREADY_PROCESSED');
  if (!['REJECTED', 'VALIDATED'].includes(prev.status)) fail(409, 'NOT_REPROCESSABLE');
  const cfg = await accountContext(deps, prev.financial_account_id);
  // evidence comes only from the stored run: same account, hash, path and file name; never from the request
  if (prev.storage_path !== canonicalPath(prev.financial_account_id, prev.file_sha256)) fail(409, 'EVIDENCE_INTEGRITY');
  const bytes = await deps.download(prev.storage_path);
  if (!bytes) fail(409, 'EVIDENCE_MISSING');
  const stored = bytes as Uint8Array;
  if (stored.length !== prev.byte_size || (await deps.sha256(stored)) !== prev.file_sha256) fail(409, 'EVIDENCE_INTEGRITY');
  const res = await importParsed(deps, {
    uid, accountId: prev.financial_account_id, cfg, bytes: stored, sha: prev.file_sha256, path: prev.storage_path,
    fileName: prev.file_name, previousRunId: prev.id,
  });
  deps.log({ event: 'reprocess', status: res.status, account: prev.financial_account_id, sha: prev.file_sha256.slice(0, 12), ms: Math.round(deps.now() - t0) });
  return res;
}

export async function handleImport(req: Request, deps: ImportDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const t0 = deps.now();
  try {
    if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED');
    const auth = await deps.authorize(req.headers.get('authorization'));
    if (!auth.ok) fail(auth.status, auth.code);
    const uid = (auth as { uid: string }).uid;
    const type = (req.headers.get('content-type') ?? '').toLowerCase();
    if (type.startsWith('multipart/form-data')) return await handleUpload(req, deps, uid, t0);
    if (type.startsWith('application/json')) return await handleReprocess(req, deps, uid, t0);
    return fail(415, 'UNSUPPORTED_CONTENT_TYPE');
  } catch (e) {
    if (e instanceof HttpError) {
      deps.log({ event: 'refused', status: e.status, code: e.code, ms: Math.round(deps.now() - t0) });
      return json(e.status, { error: e.code });
    }
    deps.log({ event: 'error', status: 500, code: 'INTERNAL', ms: Math.round(deps.now() - t0) });
    return json(500, { error: 'INTERNAL' });
  }
}
