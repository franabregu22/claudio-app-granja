-- ADR-025 §18 — precondition of a STAGING upgrade: the installed bot staging (wa + sim), never the ERP.
DO $$ BEGIN
  IF to_regclass('migration_ledger.applied') IS NOT NULL OR to_regclass('public.perfiles') IS NOT NULL
     OR to_regnamespace('wa') IS NULL OR to_regnamespace('sim') IS NULL THEN
    RAISE EXCEPTION 'STAGING_UPGRADE_GUARD: not the installed AppGranja bot staging';
  END IF;
  RAISE NOTICE 'STAGING_UPGRADE_GUARD: PASS';
END $$;
SET LOCAL search_path = sim, public, pg_temp;
DROP FUNCTION IF EXISTS wa.duplicate_refs(jsonb, uuid);
-- >>> duplicate_refs
-- which recorded purchases the hint counted (SAME criterion as wa.duplicate_hint), at most 3, most likely first. Details (WhatsApp
-- code, category, concept of a WhatsApp expense) only when the viewer is an active, mapped ADMIN — the only role allowed to own
-- drafts and to read purchases; otherwise only date / amount / same-category. Never ids, actors, suppliers or phones.
CREATE FUNCTION wa.duplicate_refs(p JSONB, p_viewer UUID) RETURNS JSONB LANGUAGE sql STABLE SET search_path = sim, public, pg_temp AS $$
  WITH viewer AS (SELECT EXISTS (SELECT 1 FROM wa.sender s JOIN perfiles pf ON pf.id = s.perfil_id
                                  WHERE s.perfil_id = p_viewer AND s.activo AND pf.activo AND pf.rol_type::text = 'ADMIN') AS admin),
  m AS (SELECT x.economic_date, x.amount_total, x.created_at, x.expense_category_id::text = p ->> 'category_id' AS same_category,
               (SELECT e.nombre FROM expense_category e WHERE e.id = x.expense_category_id) AS category,
               (SELECT w.short_code FROM wa.confirmation c JOIN wa.draft w ON w.id = c.draft_id WHERE c.idempotency_key = x.idempotency_key) AS ref,
               (SELECT left(w.payload ->> 'concept', 40) FROM wa.confirmation c JOIN wa.draft w ON w.id = c.draft_id WHERE c.idempotency_key = x.idempotency_key) AS concept
          FROM purchases x
         WHERE x.is_current AND x.amount_total = (p ->> 'total')::numeric
           AND x.economic_date BETWEEN (p ->> 'date')::date - 2 AND (p ->> 'date')::date + 2
         ORDER BY 4 DESC, abs(x.economic_date - (p ->> 'date')::date), x.created_at DESC LIMIT 3)
  SELECT coalesce(jsonb_agg(CASE WHEN v.admin
           THEN jsonb_build_object('date', m.economic_date, 'total', m.amount_total, 'same_category', m.same_category, 'ref', m.ref, 'category', m.category, 'concept', m.concept)
           ELSE jsonb_build_object('date', m.economic_date, 'total', m.amount_total, 'same_category', m.same_category) END
           ORDER BY m.same_category DESC, abs(m.economic_date - (p ->> 'date')::date), m.created_at DESC), '[]'::jsonb)
    FROM m CROSS JOIN viewer v;
$$;
-- <<< duplicate_refs
ALTER FUNCTION wa.duplicate_refs(jsonb, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.duplicate_refs(jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
-- >>> wa_propose
CREATE OR REPLACE FUNCTION public.wa_propose(p_inbound_id BIGINT, p_type TEXT, p_payload JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE c wa.config; ci RECORD; v_owner UUID; p JSONB; v_state TEXT; d wa.draft; r JSONB;
BEGIN
  PERFORM wa.gate(); SELECT * INTO c FROM wa.config WHERE singleton;
  SELECT * INTO ci FROM wa.claim_inbound(p_inbound_id, 'PROPOSE', NULL);
  IF ci.replay IS NOT NULL THEN RETURN ci.replay; END IF;
  v_owner := (ci.msg).sender_perfil_id; PERFORM wa.assert_owner(v_owner);
  IF p_type NOT IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE', 'SUPPLIER_CREDIT_PURCHASE', 'SUPPLIER_PURCHASE_WITH_INVOICE', 'VAT_ONLY_DOCUMENT') THEN
    RAISE EXCEPTION 'WA_INVALID_TYPE: %', p_type;
  END IF;
  p := wa.validate_payload(p_type, p_payload);
  v_state := CASE WHEN (p ->> 'needs_mp')::boolean AND p ->> 'mp_source_id' IS NULL THEN 'WAITING_MP' ELSE 'DRAFT' END;
  IF v_state = 'DRAFT' AND EXISTS (SELECT 1 FROM wa.draft WHERE owner_perfil_id = v_owner AND state IN ('DRAFT', 'CONFIRMING')) THEN
    RAISE EXCEPTION 'WA_OPEN_DRAFT_EXISTS: confirm, correct or cancel the open draft first';
  END IF;
  IF v_state = 'WAITING_MP' AND (SELECT count(*) FROM wa.draft WHERE owner_perfil_id = v_owner AND state = 'WAITING_MP') >= c.waiting_mp_cap THEN
    RAISE EXCEPTION 'WA_WAITING_MP_LIMIT: % drafts already wait for Mercado Pago', c.waiting_mp_cap;
  END IF;
  INSERT INTO wa.draft (owner_perfil_id, type, state, payload, expires_at)
  VALUES (v_owner, p_type, v_state, p, now() + CASE WHEN v_state = 'WAITING_MP' THEN c.waiting_mp_ttl ELSE c.draft_ttl END)
  RETURNING * INTO d;
  INSERT INTO wa.draft_version (draft_id, version, payload, inbound_id) VALUES (d.id, 1, p, p_inbound_id);
  r := jsonb_build_object('ok', true, 'draft_id', d.id, 'short_code', d.short_code, 'state', d.state, 'version', d.version,
                          'expires_at', d.expires_at, 'payload', d.payload, 'possible_duplicates', wa.duplicate_hint(p), 'duplicates', wa.duplicate_refs(p, v_owner),
                          'confirm_payload', 'CONFIRM:' || d.id || ':' || d.version, 'cancel_payload', 'CANCEL:' || d.id || ':' || d.version);
  PERFORM wa.audit('PROPOSE', d.state, v_owner, p_inbound_id, d.id, d.version, jsonb_build_object('type', p_type));
  RETURN wa.use_inbound(p_inbound_id, 'PROPOSE', d.id, r);
END $$;
-- <<< wa_propose
-- >>> wa_correct
CREATE OR REPLACE FUNCTION public.wa_correct(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER, p_payload JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE c wa.config; ci RECORD; d wa.draft; p JSONB; v_state TEXT; r JSONB;
BEGIN
  PERFORM wa.gate(); SELECT * INTO c FROM wa.config WHERE singleton;
  SELECT * INTO ci FROM wa.claim_inbound(p_inbound_id, 'CORRECT', p_draft_id);
  IF ci.replay IS NOT NULL THEN RETURN ci.replay; END IF;
  d := wa.lock_owned_draft(ci.msg, p_draft_id, p_expected_version);
  IF wa.expire_if_due(d) THEN RETURN wa.use_inbound(p_inbound_id, 'CORRECT', d.id, jsonb_build_object('ok', false, 'error', 'WA_DRAFT_EXPIRED')); END IF;
  IF d.state NOT IN ('DRAFT', 'WAITING_MP', 'FAILED') THEN RAISE EXCEPTION 'WA_DRAFT_NOT_EDITABLE: %', d.state; END IF;
  p := wa.validate_payload(d.type, p_payload);
  v_state := CASE WHEN (p ->> 'needs_mp')::boolean AND p ->> 'mp_source_id' IS NULL THEN 'WAITING_MP' ELSE 'DRAFT' END;
  IF v_state = 'DRAFT' AND d.state <> 'DRAFT' AND EXISTS (SELECT 1 FROM wa.draft WHERE owner_perfil_id = d.owner_perfil_id AND state IN ('DRAFT', 'CONFIRMING') AND id <> d.id) THEN
    RAISE EXCEPTION 'WA_OPEN_DRAFT_EXISTS';
  END IF;
  UPDATE wa.draft SET version = version + 1, payload = p, state = v_state, error_code = NULL, updated_at = now(), version_at = now(),
                      expires_at = now() + CASE WHEN v_state = 'WAITING_MP' THEN c.waiting_mp_ttl ELSE c.draft_ttl END
   WHERE id = d.id RETURNING * INTO d;
  INSERT INTO wa.draft_version (draft_id, version, payload, inbound_id) VALUES (d.id, d.version, p, p_inbound_id);
  r := jsonb_build_object('ok', true, 'draft_id', d.id, 'short_code', d.short_code, 'state', d.state, 'version', d.version, 'payload', d.payload,
                          'possible_duplicates', wa.duplicate_hint(p), 'duplicates', wa.duplicate_refs(p, d.owner_perfil_id), 'confirm_payload', 'CONFIRM:' || d.id || ':' || d.version,
                          'cancel_payload', 'CANCEL:' || d.id || ':' || d.version);
  PERFORM wa.audit('CORRECT', d.state, d.owner_perfil_id, p_inbound_id, d.id, d.version, NULL);
  RETURN wa.use_inbound(p_inbound_id, 'CORRECT', d.id, r);
END $$;
-- <<< wa_correct
ALTER FUNCTION public.wa_propose(bigint, text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_propose(bigint, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_propose(bigint, text, jsonb) TO authenticated;
ALTER FUNCTION public.wa_correct(bigint, uuid, integer, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_correct(bigint, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_correct(bigint, uuid, integer, jsonb) TO authenticated;
