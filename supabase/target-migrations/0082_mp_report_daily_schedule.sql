-- ============================================================================
-- TARGET V1 — 0082 MERCADO PAGO DAILY RELEASE REPORT — CRON ACTIVATION (ADR-018 §9.1, owner GO 2026-10-14)
--
-- Exactly one statement: pg_cron job 'mp_release_report_daily' (prepared as scripts/target-db/mp_report_daily_schedule.sql
-- in 0081's commit, moved here unchanged). Prerequisites already in production: 0081 (scheduler log, actor-NULL NORMAL
-- ingestion) and the Edge Function mp-report-daily (verify_jwt = false, x-worker-invoke-secret).
--
-- Same mechanism as 0056 (pg_cron + pg_net + Vault), no second scheduler, mp_worker_every_minute untouched:
--   * URL     derived from the existing Vault entry mp_worker_url (…/functions/v1/mp-worker → …/functions/v1/mp-report-daily);
--             no new Vault entry and no URL in git. A Vault URL not ending in /functions/v1/mp-worker posts nothing.
--   * secret  the existing Vault entry mp_worker_invoke_secret (= Edge secret WORKER_INVOKE_SECRET), header
--             x-worker-invoke-secret; no secret in git, no new secret, no user JWT.
--   * when    '0 10,14 * * *' UTC = 07:00 and 11:00 America/Argentina/Buenos_Aires (no DST): the previous day is closed
--             for 7 h, it avoids the worker's 03:00–03:10 BA sweep, and the 11:00 run is an idempotent retry
--             (ALREADY_PROCESSED when 07:00 succeeded; resumes a timed-out MP task otherwise).
--   * timeout 150 s for the HTTP call (the function polls MP at most ~60 s); the outcome is in fin_mp_report_schedule_log.
-- cron.schedule upserts by name: re-running never creates a second job. Rollback: SELECT cron.unschedule('mp_release_report_daily');
-- ============================================================================
SELECT cron.schedule(
  'mp_release_report_daily',
  '0 10,14 * * *',
  $job$
SELECT net.http_post(
         url                  := replace(u.decrypted_secret, '/functions/v1/mp-worker', '/functions/v1/mp-report-daily'),
         body                 := '{}'::jsonb,
         headers              := jsonb_build_object('content-type', 'application/json',
                                                    'x-worker-invoke-secret', s.decrypted_secret),
         timeout_milliseconds := 150000)
  FROM vault.decrypted_secrets u, vault.decrypted_secrets s
 WHERE u.name = 'mp_worker_url' AND s.name = 'mp_worker_invoke_secret'
   AND u.decrypted_secret LIKE '%/functions/v1/mp-worker';
$job$);
