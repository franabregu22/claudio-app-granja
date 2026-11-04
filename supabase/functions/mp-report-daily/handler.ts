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
 *   PENDING            (0085) Mercado Pago accepted the task but is still preparing the file after a SHORT poll
 *                      (DAILY_MAX_POLLS): task_id kept, reason MP_TASK_PREPARING, no effect. The next slot polls the SAME
 *                      task again — a new task is never requested while the day's latest task record is PENDING (or the
 *                      legacy FAILED MP_TASK_TIMEOUT), so there is at most one live task per target date.
 *   FAILED             a real refusal (MP / task failed, rejected file, configuration, database, …): error_code (+ task_id
 *                      when MP had accepted the request). The next slot requests a new task.
 */
import { previousBusinessDay } from '../_shared/mp-release-report.ts';
import { captureReport, HttpError, type ReportDeps, type ReportSummary } from '../mp-report-ingest/handler.ts';

export const SECRET_HEADER = 'x-worker-invoke-secret';
export type Outcome = 'SUCCESS' | 'SUCCESS_EMPTY' | 'ALREADY_PROCESSED' | 'FAILED' | 'PENDING';
/** Polls of the MP task per scheduled execution (3 s apart, ≈ 12 s): the scheduler retries every 15 minutes instead. */
export const DAILY_MAX_POLLS = 5;
export const PREPARING = 'MP_TASK_PREPARING';
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
  /** The latest scheduler record of that day that carries a task_id, or null. */
  lastTaskSchedule(date: string): Promise<ScheduleEntry | null>;
  /** fin_record_mp_report_schedule; returns the log id. */
  recordSchedule(r: ScheduleRecord): Promise<number>;
  /** The days in [from, to] that hold an effective NORMAL run (status PARSED) of the MP account. */
  processedDays(accountId: string, from: string, to: string): Promise<string[]>;
  /** The first day the integration processed for the MP account (its earliest PARSED NORMAL single-day run), or null. */
  firstProcessedDay(accountId: string): Promise<string | null>;
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

/**
 * Catch-up of missed days (2026-11 incident: the 29/10 task stayed MP_TASK_PREPARING through every slot of 30/10 and the next day
 * the scheduler moved on to 30/10 — the 29/10 report was never requested again). After the previous day, each execution looks back
 * BACKFILL_LOOKBACK_DAYS days (never before the first day this integration processed) for days with no effective NORMAL run and
 * processes at most MAX_BACKFILL_PER_EXECUTION of them, oldest first, through the same per-day path (its live task is resumed,
 * never replaced; ALREADY_PROCESSED protects a concurrent execution). The rest wait for the next execution. A day is complete only
 * with a PARSED NORMAL run (an empty day included: its run holds the CONTROL rows). Nothing is compensated: each report brings the
 * real rows of its own day.
 */
export const BACKFILL_LOOKBACK_DAYS = 14;
export const MAX_BACKFILL_PER_EXECUTION = 2;

/** YYYY-MM-DD ± n calendar days (no time zone involved: the date is already the Buenos Aires business day). */
export function shiftDay(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The earlier days to recover: inside the window, not before the integration's first processed day, not processed; oldest first. */
export function missingDays(previous: string, firstProcessed: string | null, processed: ReadonlySet<string>, lookback = BACKFILL_LOOKBACK_DAYS): string[] {
  if (firstProcessed === null) return [];   // the integration never processed a day: nothing to catch up
  const from = [shiftDay(previous, -lookback), firstProcessed].sort()[1];
  const out: string[] = [];
  for (let d = from; d < previous; d = shiftDay(d, 1)) if (!processed.has(d)) out.push(d);
  return out;
}

interface DayResult { schedule_id: number | null; target_date: string; outcome: Outcome; run_id: string | null; task_id: string | null; error_code: string | null; summary: Record<string, number> }

/** One day: execute, then record it in the scheduler log (its own row: the next execution resumes that day's task from it). */
async function runDay(deps: DailyDeps, date: string, t0: number): Promise<DayResult & { recordFailed: boolean }> {
  let rec: ScheduleRecord;
  try {
    rec = await execute(deps, date, t0);
  } catch {
    rec = { p_target_date: date, p_outcome: 'FAILED', p_run_id: null, p_task_id: null, p_error_code: 'INTERNAL', p_summary: {} };
  }
  const out = { target_date: date, outcome: rec.p_outcome, run_id: rec.p_run_id, task_id: rec.p_task_id, error_code: rec.p_error_code, summary: rec.p_summary };
  try {
    return { ...out, schedule_id: await deps.recordSchedule(rec), recordFailed: false };
  } catch {
    deps.log({ event: 'daily', status: 500, date, outcome: rec.p_outcome, code: 'SCHEDULE_RECORD_FAILED', run_id: rec.p_run_id ?? undefined });
    return { ...out, schedule_id: null, recordFailed: true };
  }
}

export async function handleDaily(req: Request, deps: DailyDeps): Promise<Response> {
  const t0 = deps.now();
  if (req.method !== 'POST') { await req.body?.cancel(); return json(405, { error: 'METHOD_NOT_ALLOWED' }); }
  if (!deps.secretMatches(req.headers.get(SECRET_HEADER))) {
    await req.body?.cancel();
    deps.log({ event: 'refused', status: 401, code: 'UNAUTHORIZED' });
    return json(401, { error: 'UNAUTHORIZED' });
  }
  await req.body?.cancel();   // the body is never read: the target days are not a caller choice
  const date = previousBusinessDay(t0);

  // 1. the previous day, exactly as before
  const main = await runDay(deps, date, t0);
  if (main.recordFailed) return json(500, { error: 'SCHEDULE_RECORD_FAILED', target_date: date, outcome: main.outcome, run_id: main.run_id });
  const status = main.outcome === 'FAILED' ? 502 : main.outcome === 'PENDING' ? 202 : 200;
  deps.log({ event: 'daily', status, date, outcome: main.outcome, code: main.error_code ?? undefined, run_id: main.run_id ?? undefined,
    task: main.task_id ?? undefined, ms: Math.round(deps.now() - t0) });

  // 2. earlier days still missing (bounded; a failure stops the catch-up of this execution, the next one continues)
  const backfill: DayResult[] = [];
  try {
    const account = await deps.loadMpAccount();
    if (account && main.outcome !== 'FAILED') {
      const from = shiftDay(date, -BACKFILL_LOOKBACK_DAYS);
      const days = missingDays(date, await deps.firstProcessedDay(account), new Set(await deps.processedDays(account, from, shiftDay(date, -1))));
      for (const d of days.slice(0, MAX_BACKFILL_PER_EXECUTION)) {
        const { recordFailed, ...r } = await runDay(deps, d, t0);
        backfill.push(r);
        deps.log({ event: 'daily_backfill', status: r.outcome === 'FAILED' ? 502 : r.outcome === 'PENDING' ? 202 : 200, date: d, outcome: r.outcome,
          code: r.error_code ?? undefined, run_id: r.run_id ?? undefined, task: r.task_id ?? undefined });
        if (recordFailed || r.outcome === 'FAILED') break;
      }
    }
  } catch {
    deps.log({ event: 'daily_backfill', status: 500, date, code: 'BACKFILL_LOOKUP_FAILED' });   // the previous day is already done and recorded
  }

  return json(status, {
    schedule_id: main.schedule_id, target_date: date, outcome: main.outcome, run_id: main.run_id, task_id: main.task_id,
    error_code: main.error_code, summary: main.summary, backfill,
  });
}

async function execute(deps: DailyDeps, date: string, t0: number): Promise<ScheduleRecord> {
  const base = { p_target_date: date, p_run_id: null, p_task_id: null, p_error_code: null, p_summary: {} };
  const account = await deps.loadMpAccount();
  if (!account) return { ...base, p_outcome: 'FAILED', p_error_code: 'MP_ACCOUNT_MISSING' };

  // 1. idempotent: a day already processed (by an earlier execution or an ADMIN) needs no Mercado Pago call
  const done = await deps.findProcessedRun(account, date);
  if (done) return { ...base, p_outcome: 'ALREADY_PROCESSED', p_run_id: done };

  // 2. the day's live task (still being prepared by MP) is polled again, never replaced by a new request
  const last = await deps.lastTaskSchedule(date);
  const live = last !== null && last.task_id !== null
    && (last.outcome === 'PENDING' || (last.outcome === 'FAILED' && last.error_code === 'MP_TASK_TIMEOUT'));   // legacy record (before 0085)
  const resume = live ? last.task_id : null;

  try {
    const res = await captureReport(deps, { actor: null, date, mode: 'NORMAL', taskId: resume, t0, maxPolls: DAILY_MAX_POLLS });
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
    // MP accepted the task and is still preparing the file: not a failure (the next slot polls the same task)
    if (e.code === 'MP_TASK_TIMEOUT' && task) return { ...base, p_outcome: 'PENDING', p_task_id: task, p_error_code: PREPARING };
    return { ...base, p_outcome: 'FAILED', p_task_id: task, p_error_code: e.code };
  }
}
