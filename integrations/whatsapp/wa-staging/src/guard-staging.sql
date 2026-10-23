-- ADR-025 §18 — STAGING precondition: only an EMPTY bot-staging database (AppGranja after the reset). Refuses the ERP.
DO $$
DECLARE v_problems TEXT[] := '{}';
BEGIN
  IF to_regclass('migration_ledger.applied') IS NOT NULL THEN v_problems := array_append(v_problems, 'migration_ledger.applied exists (ERP database)'); END IF;
  IF to_regclass('public.perfiles') IS NOT NULL THEN v_problems := array_append(v_problems, 'public.perfiles exists (ERP database)'); END IF;
  IF to_regprocedure('public.current_app_role()') IS NOT NULL THEN v_problems := array_append(v_problems, 'public.current_app_role() exists (ERP database)'); END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'register\_%') THEN
    v_problems := array_append(v_problems, 'public.register_* functions exist (ERP database)');
  END IF;
  IF (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') > 0 THEN v_problems := array_append(v_problems, 'public has tables / views'); END IF;
  IF to_regnamespace('wa') IS NOT NULL OR to_regnamespace('sim') IS NOT NULL THEN v_problems := array_append(v_problems, 'schema wa or sim already exists'); END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN v_problems := array_append(v_problems, 'auth.uid() missing'); END IF;
  IF to_regclass('vault.decrypted_secrets') IS NULL THEN v_problems := array_append(v_problems, 'vault missing'); END IF;
  IF to_regprocedure('extensions.hmac(bytea,bytea,text)') IS NULL THEN v_problems := array_append(v_problems, 'extensions.hmac (pgcrypto) missing'); END IF;
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'STAGING_GUARD: %', array_to_string(v_problems, '; '); END IF;
  RAISE NOTICE 'STAGING_GUARD: PASS (empty bot-staging database)';
END $$;
