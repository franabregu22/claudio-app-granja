-- ADR-025 §18 — precondition of a STAGING upgrade: the installed bot staging (wa + sim), never the ERP.
DO $$ BEGIN
  IF to_regclass('migration_ledger.applied') IS NOT NULL OR to_regclass('public.perfiles') IS NOT NULL
     OR to_regnamespace('wa') IS NULL OR to_regnamespace('sim') IS NULL THEN
    RAISE EXCEPTION 'STAGING_UPGRADE_GUARD: not the installed AppGranja bot staging';
  END IF;
  RAISE NOTICE 'STAGING_UPGRADE_GUARD: PASS';
END $$;
DO $$ BEGIN IF to_regprocedure('wa.selectable_categories()') IS NULL THEN RAISE EXCEPTION 'UPGRADE_005_GUARD: upgrade-004 is not installed'; END IF; END $$;
SET LOCAL search_path = sim, public, pg_temp;
-- >>> validate_payload
-- payload validation against the accounting catalogs (the RPCs re-validate everything at confirmation)
CREATE OR REPLACE FUNCTION wa.validate_payload(p_type TEXT, p_payload JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE p JSONB := p_payload; v_total NUMERIC; v_why TEXT; v_opt TEXT; v_today DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: object required'; END IF;
  p := p || jsonb_build_object('date', coalesce(p ->> 'date', v_today::text));
  IF (p ->> 'date')::date > v_today + 1 THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: date in the future'; END IF;
  v_total := (p ->> 'total')::numeric;
  IF v_total IS NULL OR v_total <= 0 THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: total > 0 required'; END IF;
  IF p ? 'net' AND ((p ->> 'net')::numeric <= 0 OR (p ->> 'net')::numeric > v_total) THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: 0 < net <= total'; END IF;
  -- error contract (kept from the published V2): a subcategory that can NEVER be used for an expense (unknown id, fiscal-reserved,
  -- owner withdrawal / non-EXPENSE group) is an invalid payload (WA_INVALID_PAYLOAD); only the live catalog state (subcategory or
  -- category deactivated) is WA_CATEGORY_NOT_SELECTABLE. Both are refused; inside the confirmation every refusal is NOT_SELECTABLE.
  IF p_type <> 'VAT_ONLY_DOCUMENT' THEN
    IF p ->> 'category_id' IS NULL AND p_type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') THEN
      -- the subcategory is still to choose (ambiguous or not stated): the draft keeps amount / concept / date but can NOT be
      -- confirmed (WA_CATEGORY_REQUIRED); every option offered to the user must be selectable right now
      IF jsonb_typeof(coalesce(p -> 'category_options', '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(p -> 'category_options', '[]'::jsonb)) > 20 THEN
        RAISE EXCEPTION 'WA_INVALID_PAYLOAD: category_options';
      END IF;
      FOR v_opt IN SELECT jsonb_array_elements_text(coalesce(p -> 'category_options', '[]'::jsonb)) LOOP
        IF v_opt !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: category_options'; END IF;
        v_why := wa.category_check(v_opt::uuid, false);
        IF v_why IS NOT NULL THEN RAISE EXCEPTION '%: %', CASE WHEN v_why = 'unknown subcategory' OR v_why LIKE '% is not selectable for expenses' THEN 'WA_INVALID_PAYLOAD' ELSE 'WA_CATEGORY_NOT_SELECTABLE' END, v_why; END IF;
      END LOOP;
      p := p || jsonb_build_object('category_pending', true, 'category_options', coalesce(p -> 'category_options', '[]'::jsonb));
    ELSE
      IF coalesce(p ->> 'category_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: category_id'; END IF;
      v_why := wa.category_check((p ->> 'category_id')::uuid, false);
      IF v_why IS NOT NULL THEN RAISE EXCEPTION '%: %', CASE WHEN v_why = 'unknown subcategory' OR v_why LIKE '% is not selectable for expenses' THEN 'WA_INVALID_PAYLOAD' ELSE 'WA_CATEGORY_NOT_SELECTABLE' END, v_why; END IF;
      p := p - 'category_pending' - 'category_options';
    END IF;
    IF coalesce(p ->> 'nature', '') NOT IN ('OPERATING', 'REINVESTMENT', 'INVESTMENT') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: nature'; END IF;
  END IF;
  IF p_type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') THEN
    IF length(coalesce(p ->> 'concept', '')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: concept 1–100'; END IF;
    IF p ->> 'method' IS NULL THEN
      -- owner decision (2026-10-24): the payment method is NEVER presumed. Not said, unknown or ambiguous → the draft keeps every
      -- other datum with the method (and so the paying account) PENDING; it can not be confirmed (WA_METHOD_REQUIRED) until chosen
      IF p ->> 'account_id' IS NOT NULL THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: a paying account without its payment method'; END IF;
      IF p ? 'mp_source_id' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: a Mercado Pago outflow without the Mercado Pago method'; END IF;
      p := (p - 'method' - 'account_id') || jsonb_build_object('method_pending', true, 'account_pending', true, 'needs_mp', false);
    ELSIF (p ->> 'method') NOT IN ('CASH', 'TRANSFER', 'MERCADOPAGO') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: method';
    ELSIF p ->> 'account_id' IS NULL THEN
      p := p - 'method_pending';
      -- several enabled accounts fit the method and the user has not said which: a draft that can NOT be confirmed until it is set
      IF NOT EXISTS (SELECT 1 FROM wa.selectable_accounts() s WHERE s.method = p ->> 'method') THEN
        RAISE EXCEPTION 'WA_ACCOUNT_NOT_SELECTABLE: no enabled account for %', p ->> 'method';
      END IF;
      p := p || jsonb_build_object('account_pending', true, 'needs_mp', false);
    ELSE
      IF (p ->> 'account_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: account_id'; END IF;
      v_why := wa.account_check((p ->> 'account_id')::uuid, p ->> 'method', false);
      IF v_why IS NOT NULL THEN RAISE EXCEPTION 'WA_ACCOUNT_NOT_SELECTABLE: %', v_why; END IF;
      p := (p - 'account_pending' - 'method_pending') || jsonb_build_object('needs_mp', p ->> 'method' = 'MERCADOPAGO');
    END IF;
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
  -- a button can only drive the correction it names: METHOD:<this draft>:<this version>:<method>, setting exactly that method on a
  -- draft whose method is pending (an old button, another draft's or another person's button, or a different payload is refused)
  IF (ci.msg).button_payload IS NOT NULL AND ((ci.msg).button_payload IS DISTINCT FROM 'METHOD:' || d.id || ':' || d.version || ':' || (p_payload ->> 'method')
       OR NOT (d.payload ? 'method_pending') OR (p_payload ->> 'method') NOT IN ('CASH', 'TRANSFER', 'MERCADOPAGO')) THEN
    RAISE EXCEPTION 'WA_BUTTON_MISMATCH: this button does not choose that payment method on this version';
  END IF;
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
-- >>> wa_confirm
-- the UNCLASSIFIED expense (owner decision, stage 2): the money leaves now — ONE payment, ONE posting, ONE pending in the ERP
-- (register_unclassified_expense, 0102) — and the subcategory is chosen later in the ERP (no second movement). Same key as a
-- classified confirmation of that version: the ERP serializes both on it, so one draft version is one expense, whichever button.
CREATE OR REPLACE FUNCTION wa.dispatch_unclassified(d wa.draft, p_key TEXT, p_inbound BIGINT) RETURNS JSONB LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE p JSONB := d.payload;
BEGIN
  RETURN register_unclassified_expense(
    p_economic_date := (p ->> 'date')::date, p_amount_total := (p ->> 'total')::numeric, p_concept := p ->> 'concept',
    p_paid_from_account_id := (p ->> 'account_id')::uuid, p_payment_method := (p ->> 'method')::payment_method,
    p_idempotency_key := p_key, p_counterparty_name := p ->> 'counterparty', p_origin := 'WHATSAPP',
    p_origin_ref := jsonb_build_object('draft_id', d.id, 'draft_short_code', d.short_code, 'version', d.version, 'inbound_id', p_inbound),
    p_reason := 'WhatsApp ' || d.short_code || ' v' || d.version);
END $$;

-- 6. confirm: explicit button of THIS version, by the owner, in time → delegated identity → accounting (§14.3).
--    CONFIRM:<draft>:<v>      classified expense (every datum set)
--    UNCLASSIFIED:<draft>:<v> "Confirmar sin clasificar": a casual expense whose subcategory is still to choose, every financial
--                             datum set. Cash / bank → register_unclassified_expense; Mercado Pago → NO accounting call: its outflow
--                             is already in the ERP (ADR-021 provisional, pending classification); the draft only records the
--                             explicit confirmation (never a second outflow).
CREATE OR REPLACE FUNCTION public.wa_confirm(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE ci RECORD; d wa.draft; v_key TEXT; v_old_sub TEXT; v_old_claims TEXT; v_inside UUID; v_role TEXT; v_res JSONB; v_err TEXT; v_why TEXT; r JSONB;
        v_mode TEXT;
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
  v_mode := CASE (ci.msg).button_payload WHEN 'CONFIRM:' || d.id || ':' || d.version THEN 'CLASSIFIED'
                                         WHEN 'UNCLASSIFIED:' || d.id || ':' || d.version THEN 'UNCLASSIFIED' END;
  IF v_mode IS NULL THEN
    RAISE EXCEPTION 'WA_CONFIRMATION_NOT_EXPLICIT: the confirm button of version % is required', d.version;
  END IF;
  IF (ci.msg).meta_ts < d.version_at - interval '5 seconds' THEN RAISE EXCEPTION 'WA_CONFIRMATION_STALE'; END IF;
  -- the payment method is never presumed: while it is pending nothing can be recorded, whatever the button (CONFIRM or UNCLASSIFIED)
  IF d.type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') AND (d.payload ->> 'method' IS NULL OR d.payload ? 'method_pending') THEN
    RAISE EXCEPTION 'WA_METHOD_REQUIRED: choose how it was paid first';
  END IF;
  -- every mandatory datum must be chosen before a confirmation (the draft stays DRAFT; nothing is recorded). Without a
  -- subcategory only the explicit "Confirmar sin clasificar" of a casual expense without invoice is accepted.
  IF v_mode = 'UNCLASSIFIED' AND (d.type <> 'CASUAL_EXPENSE' OR d.payload ->> 'category_id' IS NOT NULL) THEN
    RAISE EXCEPTION 'WA_UNCLASSIFIED_NOT_ALLOWED: only a casual expense whose subcategory is still to choose';
  END IF;
  IF v_mode = 'CLASSIFIED' AND d.type <> 'VAT_ONLY_DOCUMENT' AND d.payload ->> 'category_id' IS NULL THEN
    RAISE EXCEPTION 'WA_CATEGORY_REQUIRED: choose the subcategory first';
  END IF;
  IF d.type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') AND d.payload ->> 'account_id' IS NULL THEN
    RAISE EXCEPTION 'WA_ACCOUNT_REQUIRED: choose the paying account first';
  END IF;
  UPDATE wa.draft SET state = 'CONFIRMING', updated_at = now() WHERE id = d.id;
  v_key := 'WA:' || d.id || ':v' || d.version;
  BEGIN   -- subtransaction: an accounting refusal rolls back only the accounting part; the draft records the failure
    -- the subcategory chosen at proposal time may have been deactivated / moved since: re-check it NOW, locked until commit
    IF v_mode = 'CLASSIFIED' AND d.type <> 'VAT_ONLY_DOCUMENT' THEN
      v_why := wa.category_check((d.payload ->> 'category_id')::uuid, true);
      IF v_why IS NOT NULL THEN RAISE EXCEPTION 'WA_CATEGORY_NOT_SELECTABLE: %', v_why; END IF;
    END IF;
    -- the paying account may have been disabled / renamed to another type since the proposal: re-check it NOW, locked
    IF d.type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') THEN
      v_why := wa.account_check((d.payload ->> 'account_id')::uuid, d.payload ->> 'method', true);
      IF v_why IS NOT NULL THEN RAISE EXCEPTION 'WA_ACCOUNT_NOT_SELECTABLE: %', v_why; END IF;
    END IF;
    v_old_sub := current_setting('request.jwt.claim.sub', true);
    v_old_claims := current_setting('request.jwt.claims', true);
    PERFORM set_config('request.jwt.claim.sub', d.owner_perfil_id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', d.owner_perfil_id, 'role', 'authenticated')::text, true);
    v_inside := auth.uid(); v_role := current_app_role();
    IF v_inside IS DISTINCT FROM d.owner_perfil_id OR v_role <> 'ADMIN' THEN RAISE EXCEPTION 'WA_DELEGATION_MISMATCH'; END IF;
    IF v_mode = 'UNCLASSIFIED' AND d.payload ->> 'method' = 'MERCADOPAGO' THEN
      -- the outflow already moved Mercado Pago in the ERP and waits there for its classification: nothing is posted here
      IF d.payload ->> 'mp_source_id' IS NULL OR NOT wa.pending_outflow_ok(d.owner_perfil_id, d.payload ->> 'mp_source_id',
                                                                           (d.payload ->> 'total')::numeric, (d.payload ->> 'date')::date) THEN
        RAISE EXCEPTION 'WA_MP_OUTFLOW_NOT_MATCHING: the Mercado Pago outflow is no longer pending with that amount and date';
      END IF;
      v_res := jsonb_build_object('unclassified', true, 'financial_effect', 'EXISTING_MP_OUTFLOW', 'mp_source_id', d.payload ->> 'mp_source_id',
                                  'amount', (d.payload ->> 'total')::numeric, 'status', 'SIN_CLASIFICAR');
    ELSIF v_mode = 'UNCLASSIFIED' THEN
      v_res := wa.dispatch_unclassified(d, v_key, p_inbound_id) || jsonb_build_object('unclassified', true, 'financial_effect', 'PAYMENT_POSTED');
    ELSE
      v_res := wa.dispatch(d, v_key);
    END IF;
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
  PERFORM wa.audit('CONFIRM', 'CONFIRMED', d.owner_perfil_id, p_inbound_id, d.id, d.version, jsonb_build_object('idempotency_key', v_key, 'mode', v_mode));
  r := jsonb_build_object('ok', true, 'draft_id', d.id, 'short_code', d.short_code, 'state', 'CONFIRMED', 'unclassified', v_mode = 'UNCLASSIFIED', 'result', v_res);
  RETURN wa.use_inbound(p_inbound_id, 'CONFIRM', d.id, r);
END $$;
-- <<< wa_confirm
ALTER FUNCTION wa.validate_payload(text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.validate_payload(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.wa_correct(bigint, uuid, integer, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_correct(bigint, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_correct(bigint, uuid, integer, jsonb) TO authenticated;
ALTER FUNCTION public.wa_confirm(bigint, uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_confirm(bigint, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_confirm(bigint, uuid, integer) TO authenticated;
