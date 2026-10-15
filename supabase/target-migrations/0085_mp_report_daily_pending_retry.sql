-- ============================================================================
-- TARGET V1 — 0085 MERCADO PAGO DAILY REPORT: PENDING STATE + MORNING RETRY SLOTS (ADR-018 §9.1, owner GO 2026-10-15)
--
-- First production run (2026-10-15 07:00 BA): Mercado Pago accepted the task but needed minutes to build the file; the
-- scheduler recorded FAILED MP_TASK_TIMEOUT although nothing had failed. From now on a task that is still being prepared
-- is PENDING, and the scheduler retries it often during the morning, always on the SAME task.
--
--   1. fin_mp_report_schedule_log accepts outcome PENDING: task_id required, no run, error_code = 'MP_TASK_PREPARING'
--      (the reason). FAILED keeps meaning a real failure. Existing rows satisfy the new constraints; the table stays
--      append-only (fin_evidence_immutable_guard), fin_record_mp_report_schedule is unchanged.
--   2. Schedule (UTC; Buenos Aires = UTC-3, no DST):
--        mp_release_report_daily           '0,15,30,45 10 * * *'  → 07:00, 07:15, 07:30, 07:45 BA   (same job, same command)
--        mp_release_report_daily_fallback  '0 11,14 * * *'        → 08:00 and 11:00 BA (the final fallback)
--      The fallback job runs exactly the command of mp_release_report_daily (copied from cron.job, not retyped). Every
--      slot is the same idempotent call: an existing run → ALREADY_PROCESSED (no Mercado Pago call); a PENDING task →
--      that task is polled again; nothing pending → one task is requested. mp_worker_every_minute is untouched.
-- No financial function, table or semantics change. No SECURITY DEFINER change (79).
-- ============================================================================

ALTER TABLE fin_mp_report_schedule_log DROP CONSTRAINT chk_mrsl_outcome;
ALTER TABLE fin_mp_report_schedule_log DROP CONSTRAINT chk_mrsl_error;
ALTER TABLE fin_mp_report_schedule_log DROP CONSTRAINT chk_mrsl_run;
ALTER TABLE fin_mp_report_schedule_log
  ADD CONSTRAINT chk_mrsl_outcome CHECK (outcome IN ('SUCCESS', 'SUCCESS_EMPTY', 'ALREADY_PROCESSED', 'FAILED', 'PENDING')),
  ADD CONSTRAINT chk_mrsl_error   CHECK ((outcome IN ('FAILED', 'PENDING')) = (error_code IS NOT NULL AND btrim(error_code) <> '')),
  ADD CONSTRAINT chk_mrsl_run     CHECK (outcome IN ('FAILED', 'PENDING') OR run_id IS NOT NULL),
  ADD CONSTRAINT chk_mrsl_pending CHECK (outcome <> 'PENDING' OR (task_id IS NOT NULL AND run_id IS NULL AND error_code = 'MP_TASK_PREPARING'));

SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'mp_release_report_daily'), schedule := '0,15,30,45 10 * * *');
SELECT cron.schedule('mp_release_report_daily_fallback', '0 11,14 * * *', (SELECT command FROM cron.job WHERE jobname = 'mp_release_report_daily'));
