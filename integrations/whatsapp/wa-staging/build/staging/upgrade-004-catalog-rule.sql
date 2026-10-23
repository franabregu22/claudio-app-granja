-- ADR-025 §18 — precondition of a STAGING upgrade: the installed bot staging (wa + sim), never the ERP.
DO $$ BEGIN
  IF to_regclass('migration_ledger.applied') IS NOT NULL OR to_regclass('public.perfiles') IS NOT NULL
     OR to_regnamespace('wa') IS NULL OR to_regnamespace('sim') IS NULL THEN
    RAISE EXCEPTION 'STAGING_UPGRADE_GUARD: not the installed AppGranja bot staging';
  END IF;
  RAISE NOTICE 'STAGING_UPGRADE_GUARD: PASS';
END $$;
SET LOCAL search_path = sim, public, pg_temp;
DROP FUNCTION IF EXISTS wa.selectable_categories();
DROP FUNCTION IF EXISTS wa.category_check(uuid, boolean);
-- >>> category_rule
-- THE selectability rule of the bot, read live from the ERP catalog on every call (no copy, no cache): an active subcategory,
-- not fiscal-reserved, inside an active EXPENSE category. Used by the catalog sent to the interpreter (wa_context), by the
-- proposal / correction validation and by the re-check inside the confirmation transaction.
CREATE FUNCTION wa.selectable_categories() RETURNS TABLE (id UUID, nombre TEXT, grupo_id UUID, grupo TEXT)
LANGUAGE sql STABLE SET search_path = sim, public, pg_temp AS $$
  SELECT c.id, c.nombre::text, g.id, g.nombre::text FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id
   WHERE c.activo AND NOT c.fiscal_reserved AND g.kind::text = 'EXPENSE' AND g.activo
$$;
-- why a subcategory is NOT selectable right now (NULL = selectable). p_lock: FOR SHARE on the subcategory and its category, so a
-- concurrent deactivation / move waits until the confirming transaction ends.
CREATE FUNCTION wa.category_check(p_id UUID, p_lock BOOLEAN) RETURNS TEXT LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE v RECORD;
BEGIN
  IF p_id IS NULL THEN RETURN 'subcategory required'; END IF;
  IF p_lock THEN
    SELECT c.nombre, c.activo, c.fiscal_reserved, g.nombre AS grupo, g.kind::text AS kind, g.activo AS grupo_activo INTO v
      FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE c.id = p_id FOR SHARE OF c, g;
  ELSE
    SELECT c.nombre, c.activo, c.fiscal_reserved, g.nombre AS grupo, g.kind::text AS kind, g.activo AS grupo_activo INTO v
      FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE c.id = p_id;
  END IF;
  IF NOT FOUND THEN RETURN 'unknown subcategory'; END IF;
  IF NOT v.activo THEN RETURN 'subcategory ' || v.nombre || ' is inactive'; END IF;
  IF v.fiscal_reserved OR v.kind <> 'EXPENSE' THEN RETURN 'subcategory ' || v.nombre || ' is not selectable for expenses'; END IF;
  IF NOT v.grupo_activo THEN RETURN 'category ' || v.grupo || ' is inactive'; END IF;
  RETURN NULL;
END $$;
-- <<< category_rule
-- >>> validate_payload
-- payload validation against the accounting catalogs (the RPCs re-validate everything at confirmation)
CREATE OR REPLACE FUNCTION wa.validate_payload(p_type TEXT, p_payload JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE p JSONB := p_payload; v_total NUMERIC; v_why TEXT; v_acc RECORD; v_today DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: object required'; END IF;
  p := p || jsonb_build_object('date', coalesce(p ->> 'date', v_today::text));
  IF (p ->> 'date')::date > v_today + 1 THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: date in the future'; END IF;
  v_total := (p ->> 'total')::numeric;
  IF v_total IS NULL OR v_total <= 0 THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: total > 0 required'; END IF;
  IF p ? 'net' AND ((p ->> 'net')::numeric <= 0 OR (p ->> 'net')::numeric > v_total) THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: 0 < net <= total'; END IF;
  IF p_type <> 'VAT_ONLY_DOCUMENT' THEN
    IF coalesce(p ->> 'category_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: category_id'; END IF;
    v_why := wa.category_check((p ->> 'category_id')::uuid, false);
    IF v_why IS NOT NULL THEN RAISE EXCEPTION 'WA_CATEGORY_NOT_SELECTABLE: %', v_why; END IF;
    IF coalesce(p ->> 'nature', '') NOT IN ('OPERATING', 'REINVESTMENT', 'INVESTMENT') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: nature'; END IF;
  END IF;
  IF p_type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') THEN
    IF length(coalesce(p ->> 'concept', '')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: concept 1–100'; END IF;
    SELECT a.nombre, a.account_type::text AS account_type, a.activo INTO v_acc FROM financial_account a WHERE a.id = (p ->> 'account_id')::uuid;
    IF NOT FOUND OR NOT v_acc.activo THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: unknown or inactive account'; END IF;
    IF coalesce(p ->> 'method', '') NOT IN ('CASH', 'TRANSFER', 'MERCADOPAGO') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: method'; END IF;
    p := p || jsonb_build_object('needs_mp', v_acc.nombre = 'Mercado Pago' AND v_acc.account_type = 'EXTERNAL_SERVICE');
  ELSIF p_type IN ('SUPPLIER_CREDIT_PURCHASE', 'SUPPLIER_PURCHASE_WITH_INVOICE') THEN
    IF NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = (p ->> 'supplier_id')::uuid AND s.activo) THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: unknown or inactive supplier'; END IF;
    p := p || jsonb_build_object('needs_mp', false);
  ELSE
    p := p || jsonb_build_object('needs_mp', false);
  END IF;
  IF p_type IN ('CASUAL_WITH_INVOICE', 'SUPPLIER_PURCHASE_WITH_INVOICE', 'VAT_ONLY_DOCUMENT') THEN
    IF jsonb_typeof(p -> 'fiscal') IS DISTINCT FROM 'object' OR coalesce(p -> 'fiscal' ->> 'document_type', '') = '' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: fiscal document data required'; END IF;
    IF p_type <> 'SUPPLIER_PURCHASE_WITH_INVOICE' AND coalesce(p -> 'fiscal' ->> 'issuer_tax_id', '') !~ '^[0-9]{11}$' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: issuer CUIT (11 digits) required'; END IF;
  END IF;
  RETURN p;
END $$;
-- <<< validate_payload
-- >>> wa_confirm
-- 6. confirm: explicit button of THIS version, by the owner, in time → delegated identity → accounting (§14.3)
CREATE OR REPLACE FUNCTION public.wa_confirm(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE ci RECORD; d wa.draft; v_key TEXT; v_old_sub TEXT; v_old_claims TEXT; v_inside UUID; v_role TEXT; v_res JSONB; v_err TEXT; v_why TEXT; r JSONB;
BEGIN
  PERFORM wa.gate();
  SELECT * INTO ci FROM wa.claim_inbound(p_inbound_id, 'CONFIRM', p_draft_id);
  IF ci.replay IS NOT NULL THEN RETURN ci.replay; END IF;
  d := wa.lock_owned_draft(ci.msg, p_draft_id, p_expected_version);
  IF d.state = 'CONFIRMED' THEN      -- a second, different "SÍ": the stored result, nothing new
    r := (SELECT jsonb_build_object('ok', true, 'already_confirmed', true, 'draft_id', d.id, 'short_code', d.short_code, 'result', x.result)
            FROM wa.confirmation x WHERE x.draft_id = d.id);
    PERFORM wa.audit('CONFIRM', 'ALREADY_CONFIRMED', d.owner_perfil_id, p_inbound_id, d.id, d.version, NULL);
    RETURN wa.use_inbound(p_inbound_id, 'CONFIRM', d.id, r);
  END IF;
  IF wa.expire_if_due(d) THEN RETURN wa.use_inbound(p_inbound_id, 'CONFIRM', d.id, jsonb_build_object('ok', false, 'error', 'WA_DRAFT_EXPIRED')); END IF;
  IF d.state = 'WAITING_MP' THEN RAISE EXCEPTION 'WA_WAITING_MP: link the Mercado Pago outflow first'; END IF;
  IF d.state <> 'DRAFT' THEN RAISE EXCEPTION 'WA_DRAFT_NOT_CONFIRMABLE: %', d.state; END IF;
  IF (ci.msg).button_payload IS DISTINCT FROM 'CONFIRM:' || d.id || ':' || d.version THEN
    RAISE EXCEPTION 'WA_CONFIRMATION_NOT_EXPLICIT: the confirm button of version % is required', d.version;
  END IF;
  IF (ci.msg).meta_ts < d.version_at - interval '5 seconds' THEN RAISE EXCEPTION 'WA_CONFIRMATION_STALE'; END IF;
  UPDATE wa.draft SET state = 'CONFIRMING', updated_at = now() WHERE id = d.id;
  v_key := 'WA:' || d.id || ':v' || d.version;
  BEGIN   -- subtransaction: an accounting refusal rolls back only the accounting part; the draft records the failure
    -- the subcategory chosen at proposal time may have been deactivated / moved since: re-check it NOW, locked until commit
    IF d.type <> 'VAT_ONLY_DOCUMENT' THEN
      v_why := wa.category_check((d.payload ->> 'category_id')::uuid, true);
      IF v_why IS NOT NULL THEN RAISE EXCEPTION 'WA_CATEGORY_NOT_SELECTABLE: %', v_why; END IF;
    END IF;
    v_old_sub := current_setting('request.jwt.claim.sub', true);
    v_old_claims := current_setting('request.jwt.claims', true);
    PERFORM set_config('request.jwt.claim.sub', d.owner_perfil_id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', d.owner_perfil_id, 'role', 'authenticated')::text, true);
    v_inside := auth.uid(); v_role := current_app_role();
    IF v_inside IS DISTINCT FROM d.owner_perfil_id OR v_role <> 'ADMIN' THEN RAISE EXCEPTION 'WA_DELEGATION_MISMATCH'; END IF;
    v_res := wa.dispatch(d, v_key);
    IF auth.uid() IS DISTINCT FROM d.owner_perfil_id THEN RAISE EXCEPTION 'WA_DELEGATION_DRIFT'; END IF;
    PERFORM set_config('request.jwt.claim.sub', coalesce(v_old_sub, ''), true);
    PERFORM set_config('request.jwt.claims', coalesce(v_old_claims, ''), true);
  EXCEPTION WHEN others THEN
    v_err := SQLERRM;    -- the subtransaction rollback already restored the caller's claims
    UPDATE wa.draft SET state = 'FAILED', error_code = left(v_err, 200), updated_at = now() WHERE id = d.id;
    PERFORM wa.audit('CONFIRM', 'FAILED', d.owner_perfil_id, p_inbound_id, d.id, d.version, jsonb_build_object('error', left(v_err, 200)));
    RETURN wa.use_inbound(p_inbound_id, 'CONFIRM', d.id, jsonb_build_object('ok', false, 'draft_id', d.id, 'short_code', d.short_code, 'error', left(v_err, 200)));
  END;
  UPDATE wa.draft SET state = 'CONFIRMED', result = v_res, updated_at = now() WHERE id = d.id;
  INSERT INTO wa.confirmation (draft_id, version, perfil_id, inbound_id, payload_sha256, idempotency_key, result)
  VALUES (d.id, d.version, d.owner_perfil_id, p_inbound_id, encode(extensions.digest(convert_to(d.payload::text, 'UTF8'), 'sha256'), 'hex'), v_key, v_res);
  PERFORM wa.audit('CONFIRM', 'CONFIRMED', d.owner_perfil_id, p_inbound_id, d.id, d.version, jsonb_build_object('idempotency_key', v_key));
  r := jsonb_build_object('ok', true, 'draft_id', d.id, 'short_code', d.short_code, 'state', 'CONFIRMED', 'result', v_res);
  RETURN wa.use_inbound(p_inbound_id, 'CONFIRM', d.id, r);
END $$;
-- <<< wa_confirm
-- >>> wa_context
-- 8. context (READ-ONLY): the live drafts of the SENDER of an accepted, fresh message — current version and payload are the
--    source of truth for corrections — plus the selectable catalog. Consumes nothing (the message stays usable for one action).
CREATE OR REPLACE FUNCTION public.wa_context(p_inbound_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE m wa.inbound_message; v_open JSONB; v_waiting JSONB; v_cats JSONB; v_accs JSONB;
BEGIN
  PERFORM wa.gate();
  SELECT * INTO m FROM wa.inbound_message WHERE id = p_inbound_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'WA_MESSAGE_NOT_FOUND'; END IF;
  IF m.outcome <> 'ACCEPTED' THEN RAISE EXCEPTION 'WA_MESSAGE_NOT_ACCEPTED: %', m.outcome; END IF;
  IF m.received_at < now() - interval '1 hour' THEN RAISE EXCEPTION 'WA_MESSAGE_TOO_OLD'; END IF;
  PERFORM wa.assert_owner(m.sender_perfil_id);
  SELECT jsonb_build_object('draft_id', d.id, 'short_code', d.short_code, 'state', d.state, 'version', d.version, 'payload', d.payload, 'expires_at', d.expires_at)
    INTO v_open FROM wa.draft d
   WHERE d.owner_perfil_id = m.sender_perfil_id AND d.state IN ('DRAFT', 'FAILED') AND d.expires_at > now()
   ORDER BY (d.state = 'DRAFT') DESC, d.updated_at DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('draft_id', d.id, 'short_code', d.short_code, 'version', d.version,
                                               'total', d.payload -> 'total', 'date', d.payload -> 'date') ORDER BY d.created_at), '[]'::jsonb)
    INTO v_waiting FROM wa.draft d WHERE d.owner_perfil_id = m.sender_perfil_id AND d.state = 'WAITING_MP' AND d.expires_at > now();
  -- the live ERP catalog with its hierarchy (category → subcategory); ids are what the draft and the accounting call use
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.nombre, 'grupo_id', s.grupo_id, 'grupo', s.grupo) ORDER BY s.grupo, s.nombre), '[]'::jsonb)
    INTO v_cats FROM wa.selectable_categories() s;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'nombre', a.nombre, 'account_type', a.account_type::text) ORDER BY a.nombre), '[]'::jsonb) INTO v_accs
    FROM financial_account a WHERE a.activo;
  RETURN jsonb_build_object('ok', true, 'open', v_open, 'waiting', v_waiting, 'catalog', jsonb_build_object('categories', v_cats, 'accounts', v_accs));
END $$;
-- <<< wa_context
ALTER FUNCTION wa.selectable_categories() OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.selectable_categories() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION wa.category_check(uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.category_check(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION wa.validate_payload(text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.validate_payload(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.wa_confirm(bigint, uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_confirm(bigint, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_confirm(bigint, uuid, integer) TO authenticated;
ALTER FUNCTION public.wa_context(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_context(bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_context(bigint) TO authenticated;
