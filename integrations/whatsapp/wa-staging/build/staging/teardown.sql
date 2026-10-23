-- ADR-025 §18 — staging teardown: removes every object of this package (wa, sim, public.wa_*, the Meta test secret) and proves it.
-- Refuses an ERP database (the candidate is never torn down with this file).
DO $$ BEGIN
  IF to_regclass('migration_ledger.applied') IS NOT NULL OR to_regclass('public.perfiles') IS NOT NULL THEN
    RAISE EXCEPTION 'TEARDOWN_GUARD: ERP database — refused';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.wa_context(bigint), public.wa_ingest(text, text), public.wa_propose(bigint, text, jsonb), public.wa_correct(bigint, uuid, integer, jsonb),
  public.wa_cancel(bigint, uuid, integer), public.wa_link_mp(bigint, uuid, integer, text), public.wa_confirm(bigint, uuid, integer), public.wa_expire();
DROP VIEW IF EXISTS public.fin_mp_whatsapp_notes;
DROP SCHEMA IF EXISTS wa CASCADE;
DROP SCHEMA IF EXISTS sim CASCADE;
DELETE FROM vault.secrets WHERE name = 'wa_meta_app_secret';
SELECT 'teardown|wa=' || (to_regnamespace('wa') IS NULL) || ' sim=' || (to_regnamespace('sim') IS NULL)
       || ' public_wa_functions=' || (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\_%')
       || ' public_tables=' || (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public')
       || ' secret=' || (SELECT count(*) FROM vault.secrets WHERE name = 'wa_meta_app_secret');
