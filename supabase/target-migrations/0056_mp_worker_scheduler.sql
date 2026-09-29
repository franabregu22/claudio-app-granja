-- ============================================================================
-- TARGET V1 — 0056 MERCADO PAGO WORKER SCHEDULER (ADR-006, Step 11)
-- Authority: ADR006_IMPLEMENTATION_ORDER_V1 step 11; ADR006_WEBHOOK_WORKER_DESIGN_V1 §1 (scheduler row:
--            "pg_cron every minute → pg_net POST to mp-worker; the invoke secret is read from Supabase
--            Vault"), §5 (hourly credential probe, owned by the worker), §7 (WORKER_INVOKE_SECRET lives in
--            Edge Function secrets + Vault; never in git, migrations or logs); ADR-006 §6.1 / §6.2.
--
-- What this migration does:
--   1. installs pg_net and pg_cron (supabase_vault is already installed by the platform);
--   2. schedules exactly one job, `mp_worker_every_minute`, cadence '* * * * *', whose only statement
--      is one pg_net POST to mp-worker with the header `x-worker-invoke-secret`.
--      cron.schedule(name, …) upserts by name, so re-running this file never creates a second job.
--
-- What it deliberately does NOT contain (fail closed):
--   - no secret and no URL: both are read at run time from Vault by name —
--       'mp_worker_url'            the mp-worker endpoint of the environment;
--       'mp_worker_invoke_secret'  the same value as the function secret WORKER_INVOKE_SECRET.
--     If either is missing, the SELECT yields no row and no HTTP request is made. There is no fallback.
--     Vault entries are environment configuration, not schema: they are written per environment by
--     scripts/target-db/mp_scheduler_config.mjs (local stack; values from the caller's environment,
--     never printed) and, for production, at cutover time by the owner (Phase 30 / 31).
--   - no MP access token and no Authorization header: the worker authenticates the call by the invoke
--     secret and reads MP_ACCESS_TOKEN from its own function secrets;
--   - no RPC call: the job only triggers the worker, which owns claim → fetch → normalize → apply →
--     auto-allocate → transition → probe / sweep;
--   - no function: the command is inline SQL run by pg_cron as the scheduling role (postgres), so the
--     SECURITY DEFINER inventory stays exactly 60.
--
-- Privileges: nothing is granted here. The platform's own installer (event trigger
-- grant_pg_net_access, run as supabase_admin) grants EXECUTE on net.http_get / net.http_post and USAGE
-- on schema net to anon / authenticated / service_role; those grants belong to supabase_admin and
-- cannot be revoked by this migration's role. They are unreachable through the API (PostgREST exposes
-- only `public` and `graphql_public`; no public function references net / cron / vault) and are
-- recorded as a platform note in the Step 11 report. cron and vault gain no application-role access.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'mp_worker_every_minute',
  '* * * * *',
  $job$
SELECT net.http_post(
         url                  := u.decrypted_secret,
         body                 := '{}'::jsonb,
         headers              := jsonb_build_object('content-type', 'application/json',
                                                    'x-worker-invoke-secret', s.decrypted_secret),
         timeout_milliseconds := 60000)
  FROM vault.decrypted_secrets u, vault.decrypted_secrets s
 WHERE u.name = 'mp_worker_url' AND s.name = 'mp_worker_invoke_secret';
$job$);
