/**
 * ADR-018 §9 — mp-report-ingest request handler (runtime-agnostic core; index.ts wires it).
 *
 * Authority: ADR-018 §6.1 / §6.3 (runs, appearances), §9.1 (NORMAL), §9.3 (validation mode: capture → verify, zero
 * financial effect; then NORMAL over the same stored bytes), §11 (ADMIN only, checked here and again in the database),
 * §12 (idempotency), §13 (evidence immutability), §21 G-4; fin_capture_mp_release_report (0078),
 * fin_ingest_mp_release_report (0079); bucket financial-statements (0074 / 0078).
 *
 * POST application/json, one of:
 *   {"action":"config"}                                    read-only: GET the release report configuration and say
 *                                                          whether it is compatible with the frozen 15-column layout.
 *   {"action":"capture","date":"YYYY-MM-DD"[,"task_id":"<digits>"][,"mode":"VALIDATION"|"NORMAL"]}
 *                                                          one complete Buenos Aires business day: GET config (stop if
 *                                                          incompatible) → POST report request (or resume task_id) →
 *                                                          poll the task (bounded) → resolve file_name → GET download →
 *                                                          store the original once at mp/<account>/<sha256>.csv →
 *                                                          parse → VALIDATION (default, fin_capture_mp_release_report) or
 *                                                          NORMAL (fin_ingest_mp_release_report: report rows, back-fills).
 *   {"action":"process","run_id":"<uuid>"}                 NORMAL over the stored original of a VALIDATED capture, or a
 *                                                          reprocess of a REJECTED run with the current parser version
 *                                                          (no Mercado Pago call, no re-download; hash re-verified).
 * Mercado Pago endpoints used, and no other: GET release_report/config, POST release_report, GET release_report/task/{id},
 * GET release_report/list, GET release_report/{file_name}. The configuration is never written; nothing is scheduled.
 * NORMAL never creates payment money here: report payment rows only request a back-fill that the unchanged worker fetches.
 *
 * Errors before the file is downloaded → HTTP error, nothing stored. Once downloaded, the bytes are stored (no upsert,
 * never deleted) and every outcome — VALIDATED / PARSED or REJECTED — is a persisted run returned with HTTP 200.
 * No response or log carries the Mercado Pago token, the Authorization header or report content.
 */
import {
  businessDayWindow, checkReleaseConfig, type ConfigCheck, FORMAT_CODE, PARSER_VERSION, parseReleaseReport,
} from '../_shared/mp-release-report.ts';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const BUCKET = 'financial-statements';
export const MAX_POLLS = 20;
export const POLL_MS = 3000;
const MP = '/v1/account/release_report';
const FAILED_TASK = ['failed', 'error', 'canceled', 'cancelled', 'deleted', 'expired'];
const DIGITS = /^[0-9]{1,20}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type Mode = 'VALIDATION' | 'NORMAL';

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

export interface RunRow {
  id: string; source_kind: string; mode: string; status: string; financial_account_id: string; format_code: string | null;
  parser_version: string; file_sha256: string; storage_path: string; coverage_from: string | null; coverage_to: string | null;
  rows_total: number; rows_captured: number; rows_invalid: number; reject_reason: string | null; previous_run_id: string | null;
  lines_new: number; lines_known: number; rows_ignored: number; file_name: string; byte_size: number; source_meta: Record<string, unknown> | null;
}
export interface CaptureParams {
  p_actor: string | null; p_parser_version: string; p_format_code: string | null; p_file_sha256: string; p_storage_path: string;
  p_file_name: string; p_byte_size: number; p_coverage_from: string; p_coverage_to: string; p_source_meta: Record<string, unknown>;
  p_reject_reason: string | null; p_rows: unknown[] | null;
}
export type AuthResult = { ok: true; uid: string } | { ok: false; status: 401 | 403; code: string };
export interface LogEntry { event: string; code?: string; status?: number; run_id?: string; task?: string; sha?: string; ms?: number; date?: string; outcome?: string }

export interface IngestDeps {
  authorize(authorization: string | null): Promise<AuthResult>;
  /** The active 'Mercado Pago' EXTERNAL_SERVICE account id, or null. */
  loadMpAccount(): Promise<string | null>;
  loadRun(id: string): Promise<RunRow | null>;
  /** One Mercado Pago API call (token added by the runtime); throws on network failure / timeout. */
  mp(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response>;
  download(path: string): Promise<Uint8Array | null>;
  upload(path: string, bytes: Uint8Array): Promise<'created' | 'exists'>;
  /** fin_capture_mp_release_report; throws CaptureRpcError with the database message on failure. */
  capture(params: CaptureParams): Promise<Record<string, unknown>>;
  /** fin_ingest_mp_release_report (NORMAL, same parameters); throws CaptureRpcError with the database message on failure. */
  ingest(params: CaptureParams): Promise<Record<string, unknown>>;
  /** fin_record_mp_payout_destinations (parser 1.2.0): stores the payout destination values of a run privately (idempotent);
   *  returns how many rows of the run hold one. Throws CaptureRpcError on refusal. The values never leave this call. */
  recordDestinations(params: { p_run_id: string; p_items: { row_number: number; value: string }[] }): Promise<number>;
  sha256(bytes: Uint8Array): Promise<string>;
  sleep(ms: number): Promise<void>;
  log(entry: LogEntry): void;
  now(): number;
}

/** Everything but `authorize`: what the report pipeline itself needs (the ADMIN action and the scheduler). */
export type ReportDeps = Omit<IngestDeps, 'authorize'>;

export class CaptureRpcError extends Error {}
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) { super(code); }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
const fail = (status: number, code: string, extra: Record<string, unknown> = {}): never => { throw new HttpError(status, code, extra); };
export const canonicalPath = (accountId: string, sha: string) => `mp/${accountId}/${sha}.csv`;

/** One MP call; transport failures and non-JSON bodies are MP failures, never partial results. */
async function mpJson(deps: ReportDeps, method: 'GET' | 'POST', path: string, okStatuses: number[], code: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try { res = await deps.mp(method, path, body); } catch { return fail(502, 'MP_UNREACHABLE'); }
  if (!okStatuses.includes(res.status)) { await res.body?.cancel(); return fail(502, code, { mp_status: res.status }); }
  try { return await res.json(); } catch { return fail(502, 'MP_RESPONSE_INCONSISTENT'); }
}

async function readConfig(deps: ReportDeps): Promise<ConfigCheck> {
  return checkReleaseConfig(await mpJson(deps, 'GET', `${MP}/config`, [200], 'MP_CONFIG_UNAVAILABLE'));
}

const sameInstant = (a: unknown, b: string) => typeof a === 'string' && Date.parse(a) === Date.parse(b);
const idOf = (v: unknown): string | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && DIGITS.test(v)) ? String(v) : null;

/** Poll the task until `processed`; its window must be exactly the requested one. */
async function awaitTask(deps: ReportDeps, taskId: string, window: { begin_date: string; end_date: string }, maxPolls = MAX_POLLS): Promise<Record<string, unknown>> {
  for (let i = 0; i < maxPolls; i++) {
    if (i > 0) await deps.sleep(POLL_MS);
    const t = await mpJson(deps, 'GET', `${MP}/task/${taskId}`, [200], 'MP_TASK_UNAVAILABLE');
    if (t === null || typeof t !== 'object' || Array.isArray(t)) fail(502, 'MP_RESPONSE_INCONSISTENT', { task_id: taskId });
    const task = t as Record<string, unknown>;
    if (!sameInstant(task.begin_date, window.begin_date) || !sameInstant(task.end_date, window.end_date)) {
      fail(502, 'MP_TASK_WINDOW_MISMATCH', { task_id: taskId });
    }
    const status = typeof task.status === 'string' ? task.status.toLowerCase() : '';
    if (status === 'processed') return task;
    if (FAILED_TASK.includes(status)) fail(502, 'MP_TASK_FAILED', { task_id: taskId, task_status: status });
  }
  return fail(504, 'MP_TASK_TIMEOUT', { task_id: taskId });
}

/** file_name from the processed task, else exactly one entry of the report list referring to this task. */
async function resolveFileName(deps: ReportDeps, task: Record<string, unknown>): Promise<string> {
  let name: unknown = task.file_name;
  if (typeof name !== 'string') {
    const ids = new Set([idOf(task.id), idOf(task.report_id)].filter((v): v is string => v !== null));
    const list = await mpJson(deps, 'GET', `${MP}/list`, [200], 'MP_LIST_UNAVAILABLE');
    const items = Array.isArray(list) ? list : [];
    const names = new Set(items
      .filter((it) => it && typeof it === 'object' && ['id', 'report_id', 'task_id'].some((k) => { const v = idOf((it as Record<string, unknown>)[k]); return v !== null && ids.has(v); }))
      .map((it) => (it as Record<string, unknown>).file_name)
      .filter((n) => typeof n === 'string'));
    if (names.size !== 1) fail(502, 'MP_FILE_UNRESOLVED', { task_id: idOf(task.id) });
    name = [...names][0];
  }
  const fileName = name as string;
  if (!FILE_NAME.test(fileName)) fail(502, 'MP_RESPONSE_INCONSISTENT');
  if (!fileName.toLowerCase().endsWith('.csv')) fail(422, 'FORMAT_UNSUPPORTED', { task_id: idOf(task.id) });
  return fileName;
}

async function downloadReport(deps: ReportDeps, fileName: string): Promise<Uint8Array> {
  let res: Response;
  try { res = await deps.mp('GET', `${MP}/${encodeURIComponent(fileName)}`); } catch { return fail(502, 'MP_UNREACHABLE'); }
  if (res.status !== 200) { await res.body?.cancel(); return fail(502, 'MP_DOWNLOAD_FAILED', { mp_status: res.status }); }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_FILE_BYTES) { await res.body?.cancel(); return fail(413, 'FILE_TOO_LARGE'); }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) fail(502, 'MP_EMPTY_DOWNLOAD');
  if (bytes.length > MAX_FILE_BYTES) fail(413, 'FILE_TOO_LARGE');
  return bytes;
}

/** Store the original once; an existing object must hold exactly the same bytes (content-addressed path). */
async function storeEvidence(deps: ReportDeps, path: string, sha: string, bytes: Uint8Array): Promise<'created' | 'reused'> {
  const verifyExisting = async () => {
    const stored = await deps.download(path);
    if (!stored || (await deps.sha256(stored)) !== sha) fail(409, 'EVIDENCE_INTEGRITY');
    return 'reused' as const;
  };
  if (await deps.download(path)) return verifyExisting();
  return (await deps.upload(path, bytes)) === 'created' ? 'created' : verifyExisting();
}

const rpcStatus = (message: string): [number, string] => {
  const code = (/^([A-Z][A-Z_]+)/.exec(message) ?? [])[1] ?? 'CAPTURE_FAILED';
  if (code === 'FORBIDDEN') return [403, code];
  if (code === 'ALREADY_PROCESSED' || code === 'CUTOVER_BOUNDARY_MISSING') return [409, code];
  if (code === 'MP_ACCOUNT_MISSING') return [422, code];
  return [500, 'CAPTURE_FAILED'];
};

async function handleCapture(deps: IngestDeps, uid: string, b: Record<string, unknown>, t0: number): Promise<Response> {
  const date = typeof b.date === 'string' ? b.date : '';
  let resumeId: string | null = null;
  if (b.task_id !== undefined) {
    resumeId = idOf(b.task_id);
    if (resumeId === null) fail(400, 'INVALID_TASK_ID');
  }
  if (b.mode !== undefined && b.mode !== 'VALIDATION' && b.mode !== 'NORMAL') fail(400, 'INVALID_MODE');
  const mode: Mode = b.mode === 'NORMAL' ? 'NORMAL' : 'VALIDATION';
  const { summary: _summary, ...res } = await captureReport(deps, { actor: uid, date, mode, taskId: resumeId, t0 });
  return json(200, res);
}

/** Row classes of a parsed report (no row content): what a run will hold, for logs and the scheduler record. */
export interface ReportSummary { rows: number; control: number; payments_in: number; payments_out: number; yields: number; payouts: number; reserves: number }
function summarize(rows: { raw_row: Record<string, string> }[]): ReportSummary {
  const s: ReportSummary = { rows: rows.length, control: 0, payments_in: 0, payments_out: 0, yields: 0, payouts: 0, reserves: 0 };
  for (const { raw_row: r } of rows) {
    if (r.SOURCE_ID === '' && r.DESCRIPTION === '') s.control++;
    else if (r.DESCRIPTION === 'payment') { if (Number(r.NET_CREDIT_AMOUNT) - Number(r.NET_DEBIT_AMOUNT) > 0) s.payments_in++; else s.payments_out++; }
    else if (r.DESCRIPTION === 'asset_management') s.yields++;
    else if (r.DESCRIPTION === 'payout') s.payouts++;
    else if (r.DESCRIPTION === 'reserve_for_payment' || r.DESCRIPTION === 'reserve_for_payout') s.reserves++;
  }
  return s;
}

/**
 * One business day: configuration check → report request (or resume of taskId) → bounded polling → download → evidence →
 * parse → VALIDATION or NORMAL record. Shared by the ADMIN action (actor = the user) and the daily scheduler
 * (mp-report-daily, actor = null: the database records created_by NULL). Throws HttpError on every refusal.
 */
export async function captureReport(deps: ReportDeps, o: { actor: string | null; date: string; mode: Mode; taskId: string | null; t0: number; maxPolls?: number }):
  Promise<Record<string, unknown> & { summary: ReportSummary | null }> {
  const { date, mode } = o;
  const window = businessDayWindow(date, deps.now());
  if (!window) fail(400, 'INVALID_DATE');
  const w = window as { begin_date: string; end_date: string };
  const resumeId = o.taskId;
  const account = await deps.loadMpAccount();
  if (!account) fail(422, 'MP_ACCOUNT_MISSING');
  const acc = account as string;

  // 1. configuration first: an incompatible layout stops before any report is requested
  const cfg = await readConfig(deps);
  if (!cfg.compatible) fail(422, 'CONFIG_INCOMPATIBLE', { problems: cfg.problems, config: cfg.evidence });

  // 2. request (or resume) and wait for the task
  let taskId = resumeId;
  if (taskId === null) {
    const created = await mpJson(deps, 'POST', MP, [200, 201, 202], 'MP_REPORT_REQUEST_FAILED', w);
    taskId = idOf(created && typeof created === 'object' ? (created as Record<string, unknown>).id : null);
    if (taskId === null) fail(502, 'MP_RESPONSE_INCONSISTENT');
  }
  const task = await awaitTask(deps, taskId as string, w, o.maxPolls ?? MAX_POLLS);   // the scheduler polls briefly (PENDING, retried later)
  const fileName = await resolveFileName(deps, task);

  // 3. original bytes: download, hash, store once
  const bytes = await downloadReport(deps, fileName);
  const sha = await deps.sha256(bytes);
  const path = canonicalPath(acc, sha);
  const stored = await storeEvidence(deps, path, sha, bytes);


  // 4. parse and record the run (rows judged by the database's frozen D1 parser)
  const parsed = parseReleaseReport(bytes, cfg.separator);
  const source_meta: Record<string, unknown> = {
    report_type: 'release_report', task_id: taskId, mp_file_name: fileName, business_day: date, ...w, config: cfg.evidence,
    file: parsed.ok
      ? { separator: parsed.separator, line_ending: parsed.line_ending, has_bom: parsed.has_bom, header: parsed.header, ...parsed.summary }
      : null,
  };
  const res = await record(deps, mode, {
    p_actor: o.actor, p_parser_version: PARSER_VERSION, p_format_code: parsed.ok ? FORMAT_CODE : null, p_file_sha256: sha,
    p_storage_path: path, p_file_name: fileName, p_byte_size: bytes.length, p_coverage_from: date, p_coverage_to: date,
    p_source_meta: source_meta, p_reject_reason: parsed.ok ? null : parsed.reject_reason, p_rows: parsed.ok ? parsed.rows : null,
  }, { task_id: taskId, evidence: stored });
  if (parsed.ok) res.payout_destinations = await storeDestinations(deps, String(res.run_id), parsed.destinations);
  deps.log({ event: mode === 'NORMAL' ? 'capture_normal' : 'capture', status: 200, run_id: String(res.run_id), task: taskId as string,
    sha: sha.slice(0, 12), code: stored, ms: Math.round(deps.now() - o.t0) });
  return { ...res, summary: parsed.ok ? summarize(parsed.rows) : null };
}

/** Parser 1.2.0: the payout destinations of a parsed file go to the private table (count only in the response). */
async function storeDestinations(deps: ReportDeps, runId: string, destinations: { row_number: number; value: string }[]): Promise<number> {
  if (destinations.length === 0) return 0;
  try {
    return await deps.recordDestinations({ p_run_id: runId, p_items: destinations });
  } catch (e) {
    if (!(e instanceof CaptureRpcError)) throw e;
    return fail(500, 'DESTINATION_RECORD_FAILED', { run_id: runId });
  }
}

/** fin_capture_mp_release_report (VALIDATION) or fin_ingest_mp_release_report (NORMAL), then the stored run. */
async function record(deps: ReportDeps, mode: Mode, params: CaptureParams, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  let result: Record<string, unknown>;
  try {
    result = mode === 'NORMAL' ? await deps.ingest(params) : await deps.capture(params);
  } catch (e) {
    if (!(e instanceof CaptureRpcError)) throw e;
    const [status, code] = rpcStatus(e.message);
    return fail(status, code);
  }
  const run = await deps.loadRun(String(result.run_id));
  if (!run) fail(500, 'CAPTURE_FAILED');
  const r = run as RunRow;
  const counters: Record<string, unknown> = mode === 'NORMAL'
    ? { rows_total: r.rows_total, lines_new: r.lines_new, lines_known: r.lines_known, rows_ignored: r.rows_ignored, rows_invalid: r.rows_invalid }
    : { rows_total: r.rows_total, rows_captured: r.rows_captured, rows_invalid: r.rows_invalid };
  const effects = mode === 'NORMAL' && result.replayed !== true
    ? {
      backfills_created: result.backfills_created ?? 0, backfills_existing: result.backfills_existing ?? 0,
      yields_applied: result.yields_applied ?? 0, yields_not_applied: result.yields_not_applied ?? 0,
    }
    : undefined;
  return {
    run_id: r.id, mode: r.mode, status: r.status, replayed: result.replayed === true, file_sha256: r.file_sha256,
    parser_version: r.parser_version, format_code: r.format_code, coverage: { from: r.coverage_from, to: r.coverage_to },
    counters, ...(effects ? { effects } : {}), reject_reason: r.reject_reason, previous_run_id: r.previous_run_id, ...extra,
  };
}

/**
 * NORMAL over the stored original of a VALIDATED capture (ADR-018 §9.3 rollout step 3), or of a REJECTED run (an explicit
 * reprocess with the current parser version; the database links the new run through previous_run_id and replays the same
 * attempt): no re-download; the run, its path, size and hash come only from the database and the stored object, never from
 * the request. A PARSED NORMAL run is never reprocessed.
 */
async function handleProcess(deps: IngestDeps, uid: string, b: Record<string, unknown>, t0: number): Promise<Response> {
  const runId = typeof b.run_id === 'string' ? b.run_id.trim().toLowerCase() : '';
  if (!UUID.test(runId)) fail(400, 'INVALID_RUN_ID');
  const account = await deps.loadMpAccount();
  if (!account) fail(422, 'MP_ACCOUNT_MISSING');
  const prev = await deps.loadRun(runId);
  if (!prev) fail(404, 'RUN_NOT_FOUND');
  const p = prev as RunRow;
  if (p.source_kind !== 'MP_RELEASE_REPORT' || p.financial_account_id !== account) fail(422, 'NOT_AN_MP_REPORT_RUN');
  if (p.mode === 'NORMAL' && p.status === 'PARSED') fail(409, 'ALREADY_PROCESSED');
  if (p.status !== 'VALIDATED' && p.status !== 'REJECTED') fail(409, 'NOT_REPROCESSABLE');
  if (p.storage_path !== canonicalPath(p.financial_account_id, p.file_sha256) || !p.coverage_from || !p.coverage_to) fail(409, 'EVIDENCE_INTEGRITY');
  const bytes = await deps.download(p.storage_path);
  if (!bytes) fail(409, 'EVIDENCE_MISSING');
  const stored = bytes as Uint8Array;
  if (stored.length !== p.byte_size || (await deps.sha256(stored)) !== p.file_sha256) fail(409, 'EVIDENCE_INTEGRITY');
  const meta = (p.source_meta ?? {}) as Record<string, unknown>;
  const fileMeta = meta.file as { separator?: string } | null | undefined;
  const sep = fileMeta?.separator === ';' || fileMeta?.separator === ',' ? fileMeta.separator : null;
  const parsed = parseReleaseReport(stored, sep);
  const res = await record(deps, 'NORMAL', {
    p_actor: uid, p_parser_version: PARSER_VERSION, p_format_code: parsed.ok ? FORMAT_CODE : null, p_file_sha256: p.file_sha256,
    p_storage_path: p.storage_path, p_file_name: p.file_name, p_byte_size: stored.length, p_coverage_from: p.coverage_from as string,
    p_coverage_to: p.coverage_to as string, p_source_meta: { ...meta, processed_from_run: p.id },
    p_reject_reason: parsed.ok ? null : parsed.reject_reason, p_rows: parsed.ok ? parsed.rows : null,
  }, { evidence: 'reused' });
  if (parsed.ok) res.payout_destinations = await storeDestinations(deps, String(res.run_id), parsed.destinations);
  deps.log({ event: 'process_normal', status: 200, run_id: String(res.run_id), sha: p.file_sha256.slice(0, 12), ms: Math.round(deps.now() - t0) });
  return json(200, res);
}

export async function handleIngest(req: Request, deps: IngestDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const t0 = deps.now();
  try {
    if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED');
    const auth = await deps.authorize(req.headers.get('authorization'));
    if (!auth.ok) fail(auth.status, auth.code);
    const uid = (auth as { uid: string }).uid;
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) fail(415, 'UNSUPPORTED_CONTENT_TYPE');
    let body: unknown;
    try { body = await req.json(); } catch { return fail(400, 'INVALID_JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_JSON');
    const b = body as Record<string, unknown>;
    if (b.action === 'config') {
      if (Object.keys(b).length !== 1) fail(400, 'UNEXPECTED_FIELD');
      const cfg = await readConfig(deps);
      deps.log({ event: 'config', status: 200, code: cfg.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE', ms: Math.round(deps.now() - t0) });
      return json(200, { compatible: cfg.compatible, problems: cfg.problems, config: cfg.evidence });
    }
    if (b.action === 'capture') {
      if (Object.keys(b).some((k) => !['action', 'date', 'task_id', 'mode'].includes(k))) fail(400, 'UNEXPECTED_FIELD');
      return await handleCapture(deps, uid, b, t0);
    }
    if (b.action === 'process') {
      if (Object.keys(b).some((k) => !['action', 'run_id'].includes(k))) fail(400, 'UNEXPECTED_FIELD');
      return await handleProcess(deps, uid, b, t0);
    }
    return fail(400, 'UNKNOWN_ACTION');
  } catch (e) {
    if (e instanceof HttpError) {
      deps.log({ event: 'refused', status: e.status, code: e.code, task: typeof e.extra.task_id === 'string' ? e.extra.task_id : undefined, ms: Math.round(deps.now() - t0) });
      return json(e.status, { error: e.code, ...e.extra });
    }
    deps.log({ event: 'error', status: 500, code: 'INTERNAL', ms: Math.round(deps.now() - t0) });
    return json(500, { error: 'INTERNAL' });
  }
}
