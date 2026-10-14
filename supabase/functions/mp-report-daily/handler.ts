/**
 * ADR-018 §9.1 — mp-report-daily request handler (runtime-agnostic core; index.ts wires it).
 *
 * The daily scheduled run: the Mercado Pago release report of the PREVIOUS America/Argentina/Buenos_Aires calendar day,
 * processed in NORMAL mode through exactly the same pipeline as the ADMIN action (captureReport of mp-report-ingest:
 * config check → report request → bounded polling → download → evidence → parse → fin_ingest_mp_release_report with
 * actor NULL). Nothing here creates money: report payments only request back-fills that the unchanged worker fetches,
 * and a payment the webhook already applied is recognised by the database (no double effect).
 *
 * Invocation: POST from pg_cron (job 'mp_release_report_daily', activated separately) with header x-worker-invoke-secret
 * (Edge secret WORKER_INVOKE_SECRET, compared in constant time). verify_jwt = false; no user JWT, no CORS. The request
 * body is ignored: the target day is always computed here (never chosen by the caller).
 *
 * Outcome of one execution, recorded in fin_mp_report_schedule_log (fin_record_mp_report_schedule):
 *   ALREADY_PROCESSED  an effective NORMAL run for the day exists (no Mercado Pago call), or the ingestion replayed one
 *   SUCCESS            PARSED, with movements
 *   SUCCESS_EMPTY      PARSED, only CONTROL rows (a day without activity)
 *   FAILED             any refusal: error_code (+ task_id when MP had accepted the request). No in-process retry: the
 *                      next scheduled execution retries, resuming a timed-out MP task instead of requesting a new one.
 */
import { previousBusinessDay } from '../_shared/mp-release-report.ts';
import { captureReport, HttpError, type ReportDeps, type ReportSummary } from '../mp-report-ingest/handler.ts';

export const SECRET_HEADER = 'x-worker-invoke-secret';
export type Outcome = 'SUCCESS' | 'SUCCESS_EMPTY' | 'ALREADY_PROCESSED' | 'FAILED';
export interface ScheduleRecord {
  p_target_date: string; p_outcome: Outcome; p_run_id: string | null; p_task_id: string | null; p_error_code: string | null;
  p_summary: Record<string, number>;
}
export interface ScheduleEntry { outcome: string; task_id: string | null; error_code: string | null }

export interface DailyDeps extends ReportDeps {
  /** Constant-time comparison of the invocation header with WORKER_INVOKE_SECRET (false when either is missing). */
  secretMatches(given: string | null): boolean;
  /** The effective NORMAL run (status PARSED) of the MP account for that day, or null. */
  findProcessedRun(accountId: string, date: string): Promise<string | null>;
  /** The latest scheduler record for that day, or null. */
  lastSchedule(date: string): Promise<ScheduleEntry | null>;
  /** fin_record_mp_report_schedule; returns the log id. */
  recordSchedule(r: ScheduleRecord): Promise<number>;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** Counters only (the keys fin_record_mp_report_schedule accepts): row classes of the file + NORMAL effects. */
function counters(summary: ReportSummary | null, effects: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (summary) for (const [k, v] of Object.entries(summary)) out[k] = count(v);
  if (effects && typeof effects === 'object') {
    for (const k of ['backfills_created', 'backfills_existing', 'yields_applied', 'yields_not_applied']) {
      out[k] = count((effects as Record<string, unknown>)[k]);
    }
  }
  return out;
}

/** The code of a file-level reject reason ("HEADER_MISMATCH: …" → REPORT_REJECTED:HEADER_MISMATCH); no report content. */
const rejectCode = (reason: unknown) => `REPORT_REJECTED:${(/^([A-Z][A-Z_]+)/.exec(String(reason ?? '')) ?? [])[1] ?? 'UNKNOWN'}`;

export async function handleDaily(req: Request, deps: DailyDeps): Promise<Response> {
  const t0 = deps.now();
  if (req.method !== 'POST') { await req.body?.cancel(); return json(405, { error: 'METHOD_NOT_ALLOWED' }); }
  if (!deps.secretMatches(req.headers.get(SECRET_HEADER))) {
    await req.body?.cancel();
    deps.log({ event: 'refused', status: 401, code: 'UNAUTHORIZED' });
    return json(401, { error: 'UNAUTHORIZED' });
  }
  await req.body?.cancel();   // the body is never read: the target day is not a caller choice
  const date = previousBusinessDay(t0);

  let rec: ScheduleRecord;
  try {
    rec = await execute(deps, date, t0);
  } catch {
    rec = { p_target_date: date, p_outcome: 'FAILED', p_run_id: null, p_task_id: null, p_error_code: 'INTERNAL', p_summary: {} };
  }
  let scheduleId: number;
  try {
    scheduleId = await deps.recordSchedule(rec);
  } catch {
    deps.log({ event: 'daily', status: 500, date, outcome: rec.p_outcome, code: 'SCHEDULE_RECORD_FAILED', run_id: rec.p_run_id ?? undefined });
    return json(500, { error: 'SCHEDULE_RECORD_FAILED', target_date: date, outcome: rec.p_outcome, run_id: rec.p_run_id });
  }
  const status = rec.p_outcome === 'FAILED' ? 502 : 200;
  deps.log({ event: 'daily', status, date, outcome: rec.p_outcome, code: rec.p_error_code ?? undefined, run_id: rec.p_run_id ?? undefined,
    task: rec.p_task_id ?? undefined, ms: Math.round(deps.now() - t0) });
  return json(status, {
    schedule_id: scheduleId, target_date: date, outcome: rec.p_outcome, run_id: rec.p_run_id, task_id: rec.p_task_id,
    error_code: rec.p_error_code, summary: rec.p_summary,
  });
}

async function execute(deps: DailyDeps, date: string, t0: number): Promise<ScheduleRecord> {
  const base = { p_target_date: date, p_run_id: null, p_task_id: null, p_error_code: null, p_summary: {} };
  const account = await deps.loadMpAccount();
  if (!account) return { ...base, p_outcome: 'FAILED', p_error_code: 'MP_ACCOUNT_MISSING' };

  // 1. idempotent: a day already processed (by an earlier execution or an ADMIN) needs no Mercado Pago call
  const done = await deps.findProcessedRun(account, date);
  if (done) return { ...base, p_outcome: 'ALREADY_PROCESSED', p_run_id: done };

  // 2. a task MP accepted but did not finish in time is resumed, not requested again
  const last = await deps.lastSchedule(date);
  const resume = last?.outcome === 'FAILED' && last.error_code === 'MP_TASK_TIMEOUT' && last.task_id ? last.task_id : null;

  try {
    const res = await captureReport(deps, { actor: null, date, mode: 'NORMAL', taskId: resume, t0 });
    const run = String(res.run_id);
    const task = typeof res.task_id === 'string' ? res.task_id : null;
    const summary = counters(res.summary, res.effects);
    if (res.status === 'REJECTED') return { ...base, p_outcome: 'FAILED', p_run_id: run, p_task_id: task, p_error_code: rejectCode(res.reject_reason), p_summary: summary };
    if (res.status !== 'PARSED') return { ...base, p_outcome: 'FAILED', p_run_id: run, p_task_id: task, p_error_code: 'UNEXPECTED_RUN_STATUS' };
    if (res.replayed === true) return { ...base, p_outcome: 'ALREADY_PROCESSED', p_run_id: run, p_task_id: task, p_summary: summary };
    const movements = (res.summary?.rows ?? 0) - (res.summary?.control ?? 0);
    return { ...base, p_outcome: movements === 0 ? 'SUCCESS_EMPTY' : 'SUCCESS', p_run_id: run, p_task_id: task, p_summary: summary };
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    // a concurrent execution may have finished the day meanwhile (the database serialises NORMAL ingestion)
    if (e.code === 'ALREADY_PROCESSED') {
      const now = await deps.findProcessedRun(account, date);
      if (now) return { ...base, p_outcome: 'ALREADY_PROCESSED', p_run_id: now };
    }
    const task = typeof e.extra.task_id === 'string' ? e.extra.task_id : null;
    return { ...base, p_outcome: 'FAILED', p_task_id: task, p_error_code: e.code };
  }
}
