/**
 * ADR-018 §9.1 — `mp-report-daily` Supabase Edge Function (verify_jwt = false): the daily scheduled NORMAL ingestion of
 * the previous Buenos Aires day's Mercado Pago release report. Logic in ./handler.ts; runtime wiring (service key,
 * Storage, MP API) in ../_shared/mp-report-runtime.ts.
 *
 * Invocation auth: header `x-worker-invoke-secret`, the same Edge secret WORKER_INVOKE_SECRET (and Vault entry
 * mp_worker_invoke_secret) the mp-worker schedule already uses, compared in constant time (SHA-256 digests +
 * timingSafeEqual). Missing / wrong → 401. No CORS: server-to-server only. No value is ever logged or returned.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { env, reportDeps, rpc, runtimeConfigured, select } from '../_shared/mp-report-runtime.ts';
import { type DailyDeps, handleDaily, type ScheduleEntry } from './handler.ts';

const INVOKE_SECRET = env('WORKER_INVOKE_SECRET');

function secretMatches(given: string | null): boolean {
  if (given === null || INVOKE_SECRET === null) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(INVOKE_SECRET, 'utf8').digest();
  return timingSafeEqual(a, b);
}

const deps: DailyDeps = {
  ...reportDeps('mp-report-daily'),
  secretMatches,
  findProcessedRun: async (accountId, date) => {
    const rows = await select<{ id: string }>('fin_import_run',
      `select=id&source_kind=eq.MP_RELEASE_REPORT&mode=eq.NORMAL&status=eq.PARSED&financial_account_id=eq.${encodeURIComponent(accountId)}` +
        `&coverage_from=eq.${date}&coverage_to=eq.${date}&order=created_at.desc&limit=1`);
    return rows.length === 1 ? rows[0].id : null;
  },
  lastSchedule: async (date) => {
    const rows = await select<ScheduleEntry>('fin_mp_report_schedule_log', `select=outcome,task_id,error_code&target_date=eq.${date}&order=id.desc&limit=1`);
    return rows.length === 1 ? rows[0] : null;
  },
  recordSchedule: async (r) => Number(await rpc('fin_record_mp_report_schedule', r)),
};

Deno.serve((req) => {
  if (!runtimeConfigured() || INVOKE_SECRET === null) {
    deps.log({ event: 'refused', status: 503, code: 'NOT_CONFIGURED' });
    return new Response(JSON.stringify({ error: 'NOT_CONFIGURED' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
  return handleDaily(req, deps);
});
