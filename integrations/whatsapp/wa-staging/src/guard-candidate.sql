-- ADR-025 — candidate precondition: an ERP database at 0100 or later, with the four accounting RPCs, no wa schema and no staging-only schema.
DO $$
DECLARE v_problems TEXT[] := '{}';
BEGIN
  IF to_regclass('migration_ledger.applied') IS NULL THEN v_problems := array_append(v_problems, 'not an ERP database (no migration ledger)');
  ELSIF (SELECT max(version) FROM migration_ledger.applied) < '0100' THEN v_problems := array_append(v_problems, 'ERP below 0100'); END IF;
  IF to_regprocedure('public.register_casual_purchase(date,numeric,numeric,uuid,varchar,purchase_nature,uuid,payment_method,varchar,varchar,jsonb,jsonb,jsonb,uuid,uuid,text,text)') IS NULL
    THEN v_problems := array_append(v_problems, 'register_casual_purchase signature'); END IF;
  IF to_regprocedure('public.register_purchase(uuid,date,numeric,numeric,uuid,varchar,purchase_nature,jsonb,jsonb,varchar,uuid,uuid,varchar,uuid,text)') IS NULL
    THEN v_problems := array_append(v_problems, 'register_purchase signature'); END IF;
  IF to_regprocedure('public.register_purchase_with_fiscal_document(uuid,date,numeric,numeric,uuid,purchase_nature,jsonb,jsonb,varchar,fiscal_document_type,date,numeric,numeric,jsonb,varchar,uuid,varchar,uuid,text)') IS NULL
    THEN v_problems := array_append(v_problems, 'register_purchase_with_fiscal_document signature'); END IF;
  IF to_regprocedure('public.register_fiscal_document(fiscal_document_type,fiscal_direction,date,date,numeric,numeric,jsonb,uuid,uuid,varchar,text,varchar,varchar)') IS NULL
    THEN v_problems := array_append(v_problems, 'register_fiscal_document signature'); END IF;
  IF to_regnamespace('wa') IS NOT NULL THEN v_problems := array_append(v_problems, 'schema wa already exists'); END IF;
  IF to_regnamespace('sim') IS NOT NULL THEN v_problems := array_append(v_problems, 'the staging-only schema exists in an ERP database'); END IF;
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'CANDIDATE_GUARD: %', array_to_string(v_problems, '; '); END IF;
END $$;
