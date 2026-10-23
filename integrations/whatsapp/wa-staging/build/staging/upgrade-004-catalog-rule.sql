-- ADR-025 §18 — precondition of a STAGING upgrade: the installed bot staging (wa + sim), never the ERP.
DO $$ BEGIN
  IF to_regclass('migration_ledger.applied') IS NOT NULL OR to_regclass('public.perfiles') IS NOT NULL
     OR to_regnamespace('wa') IS NULL OR to_regnamespace('sim') IS NULL THEN
    RAISE EXCEPTION 'STAGING_UPGRADE_GUARD: not the installed AppGranja bot staging';
  END IF;
  RAISE NOTICE 'STAGING_UPGRADE_GUARD: PASS';
END $$;
-- ============================================================================
-- ADR-025 stage 2 — schema sim: CONTRACT DOUBLE of register_unclassified_expense (ERP candidate 0102). STAGING ONLY.
-- Same parameter names, defaults, errors and return shape as the real RPC; the pending rows are kept in a table with the
-- real name (resolved first through search_path = sim, public), there are no postings / balances in sim.
-- ============================================================================
SET LOCAL search_path = sim, public, pg_temp;

CREATE TABLE IF NOT EXISTS sim.expense_pending_classification (
  id BIGSERIAL PRIMARY KEY, payment_operation_id BIGINT NOT NULL UNIQUE, financial_account_id UUID NOT NULL REFERENCES sim.financial_account(id),
  payment_method sim.payment_method NOT NULL, amount NUMERIC(15,2) NOT NULL CHECK (amount > 0), economic_date DATE NOT NULL,
  concept TEXT NOT NULL, counterparty_name TEXT, idempotency_key TEXT NOT NULL UNIQUE, origin TEXT NOT NULL CHECK (origin IN ('WHATSAPP', 'ERP')),
  origin_ref JSONB NOT NULL DEFAULT '{}'::jsonb, created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION sim.register_unclassified_expense(p_economic_date date, p_amount_total numeric, p_concept varchar, p_paid_from_account_id uuid,
  p_payment_method sim.payment_method, p_idempotency_key varchar, p_counterparty_name varchar DEFAULT NULL, p_origin varchar DEFAULT 'ERP',
  p_origin_ref jsonb DEFAULT '{}'::jsonb, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE v_uid UUID; v_p sim.expense_pending_classification; v_acc sim.financial_account; v_concept TEXT := nullif(btrim(p_concept), '');
        v_name TEXT := nullif(btrim(p_counterparty_name), ''); v_op BIGINT; v_id BIGINT;
BEGIN
  IF sim.current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  v_uid := auth.uid();
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required'; END IF;
  IF p_idempotency_key LIKE 'RECTIFY:%' OR p_idempotency_key LIKE 'EXPENSE-PENDING:%' THEN
    RAISE EXCEPTION 'RESERVED_IDEMPOTENCY_KEY: the prefixes RECTIFY: and EXPENSE-PENDING: are reserved';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('casual_purchase:' || p_idempotency_key, 0));
  SELECT * INTO v_p FROM sim.expense_pending_classification WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_p.amount = p_amount_total AND v_p.economic_date = p_economic_date AND v_p.financial_account_id = p_paid_from_account_id
       AND v_p.payment_method = p_payment_method AND v_p.concept = v_concept AND v_p.counterparty_name IS NOT DISTINCT FROM v_name THEN
      RETURN jsonb_build_object('pending_id', v_p.id, 'payment_operation_id', v_p.payment_operation_id, 'amount', v_p.amount, 'status', 'SIN_CLASIFICAR', 'replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: key % already registered a different expense', p_idempotency_key;
  END IF;
  IF EXISTS (SELECT 1 FROM sim.purchases WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: key % already registered a purchase', p_idempotency_key;
  END IF;
  IF p_amount_total IS NULL OR p_amount_total <= 0 OR p_amount_total <> round(p_amount_total, 2) THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF v_concept IS NULL OR length(v_concept) > 100 THEN RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required'; END IF;
  IF p_payment_method IS NULL OR p_payment_method = 'CHEQUE' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: cash, transfer or Mercado Pago (a cheque goes to a registered supplier)';
  END IF;
  SELECT * INTO v_acc FROM sim.financial_account WHERE id = p_paid_from_account_id AND activo;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE'; END IF;
  IF (v_acc.nombre = 'Mercado Pago' AND v_acc.account_type = 'EXTERNAL_SERVICE') OR p_payment_method = 'MERCADOPAGO' THEN
    RAISE EXCEPTION 'MP_USE_PENDING_OUTFLOW: a Mercado Pago outflow is already pending classification (fin_mp_pending_classification)';
  END IF;
  IF p_origin IS NULL OR p_origin NOT IN ('WHATSAPP', 'ERP') THEN RAISE EXCEPTION 'INVALID_ORIGIN'; END IF;
  v_op := nextval('sim.financial_operation_seq');
  INSERT INTO sim.expense_pending_classification (payment_operation_id, financial_account_id, payment_method, amount, economic_date, concept,
         counterparty_name, idempotency_key, origin, origin_ref, created_by)
  VALUES (v_op, p_paid_from_account_id, p_payment_method, p_amount_total, p_economic_date, v_concept, v_name, p_idempotency_key, p_origin,
          coalesce(p_origin_ref, '{}'::jsonb), v_uid) RETURNING id INTO v_id;
  INSERT INTO sim.audit_events (table_name, record_id, action, performed_by, reason, new_data)
  VALUES ('expense_pending_classification', v_id, 'EXPENSE_PENDING_REGISTERED', v_uid, p_reason,
          jsonb_build_object('amount', p_amount_total, 'origin', p_origin, 'origin_ref', p_origin_ref));
  RETURN jsonb_build_object('pending_id', v_id, 'payment_operation_id', v_op, 'amount', p_amount_total, 'status', 'SIN_CLASIFICAR', 'replayed', false);
END $$;

ALTER FUNCTION sim.register_unclassified_expense(date, numeric, varchar, uuid, sim.payment_method, varchar, varchar, varchar, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION sim.register_unclassified_expense(date, numeric, varchar, uuid, sim.payment_method, varchar, varchar, varchar, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE sim.expense_pending_classification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sim.expense_pending_classification FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE sim.expense_pending_classification_id_seq FROM PUBLIC, anon, authenticated, service_role;
SET LOCAL search_path = sim, public, pg_temp;
DROP FUNCTION IF EXISTS wa.selectable_categories();
DROP FUNCTION IF EXISTS wa.category_check(uuid, boolean);
DROP FUNCTION IF EXISTS wa.dispatch_unclassified(wa.draft, text, bigint);
DROP FUNCTION IF EXISTS wa.selectable_accounts();
DROP FUNCTION IF EXISTS wa.account_check(uuid, text, boolean);
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
-- THE payment-account rule of the bot, read live from the ERP (no account name is known to n8n / the interpreter): an active
-- account whose type gives the payment method — CASH → cash, BANK_ACCOUNT → transfer, and the ERP's Mercado Pago account (the
-- one `register_casual_purchase` recognises: name 'Mercado Pago', EXTERNAL_SERVICE) → Mercado Pago. Any other account is not
-- offered. Stricter than the ERP RPC, which does not tie the method to the account type.
CREATE FUNCTION wa.selectable_accounts() RETURNS TABLE (id UUID, nombre TEXT, account_type TEXT, method TEXT)
LANGUAGE sql STABLE SET search_path = sim, public, pg_temp AS $$
  SELECT a.id, a.nombre::text, a.account_type::text,
         CASE a.account_type::text WHEN 'CASH' THEN 'CASH' WHEN 'BANK_ACCOUNT' THEN 'TRANSFER' ELSE 'MERCADOPAGO' END
    FROM financial_account a
   WHERE a.activo AND (a.account_type::text IN ('CASH', 'BANK_ACCOUNT') OR (a.account_type::text = 'EXTERNAL_SERVICE' AND a.nombre = 'Mercado Pago'))
$$;
-- why an account cannot pay with that method right now (NULL = it can); p_lock: FOR SHARE until the confirming transaction ends
CREATE FUNCTION wa.account_check(p_id UUID, p_method TEXT, p_lock BOOLEAN) RETURNS TEXT LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE v RECORD; v_method TEXT;
BEGIN
  IF p_id IS NULL THEN RETURN 'account required'; END IF;
  IF p_lock THEN
    SELECT a.nombre, a.account_type::text AS account_type, a.activo INTO v FROM financial_account a WHERE a.id = p_id FOR SHARE;
  ELSE
    SELECT a.nombre, a.account_type::text AS account_type, a.activo INTO v FROM financial_account a WHERE a.id = p_id;
  END IF;
  IF NOT FOUND THEN RETURN 'unknown account'; END IF;
  IF NOT v.activo THEN RETURN 'account ' || v.nombre || ' is inactive'; END IF;
  v_method := CASE WHEN v.account_type = 'CASH' THEN 'CASH' WHEN v.account_type = 'BANK_ACCOUNT' THEN 'TRANSFER'
                   WHEN v.account_type = 'EXTERNAL_SERVICE' AND v.nombre = 'Mercado Pago' THEN 'MERCADOPAGO' END;
  IF v_method IS NULL THEN RETURN 'account ' || v.nombre || ' cannot pay a WhatsApp expense'; END IF;
  IF v_method IS DISTINCT FROM p_method THEN RETURN 'account ' || v.nombre || ' does not match the method ' || coalesce(p_method, '-'); END IF;
  RETURN NULL;
END $$;
-- <<< category_rule
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
        IF v_why IS NOT NULL THEN RAISE EXCEPTION 'WA_CATEGORY_NOT_SELECTABLE: %', v_why; END IF;
      END LOOP;
      p := p || jsonb_build_object('category_pending', true, 'category_options', coalesce(p -> 'category_options', '[]'::jsonb));
    ELSE
      IF coalesce(p ->> 'category_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: category_id'; END IF;
      v_why := wa.category_check((p ->> 'category_id')::uuid, false);
      IF v_why IS NOT NULL THEN RAISE EXCEPTION 'WA_CATEGORY_NOT_SELECTABLE: %', v_why; END IF;
      p := p - 'category_pending' - 'category_options';
    END IF;
    IF coalesce(p ->> 'nature', '') NOT IN ('OPERATING', 'REINVESTMENT', 'INVESTMENT') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: nature'; END IF;
  END IF;
  IF p_type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') THEN
    IF length(coalesce(p ->> 'concept', '')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: concept 1–100'; END IF;
    IF coalesce(p ->> 'method', '') NOT IN ('CASH', 'TRANSFER', 'MERCADOPAGO') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: method'; END IF;
    IF p ->> 'account_id' IS NULL THEN
      -- several enabled accounts fit the method and the user has not said which: a draft that can NOT be confirmed until it is set
      IF NOT EXISTS (SELECT 1 FROM wa.selectable_accounts() s WHERE s.method = p ->> 'method') THEN
        RAISE EXCEPTION 'WA_ACCOUNT_NOT_SELECTABLE: no enabled account for %', p ->> 'method';
      END IF;
      p := p || jsonb_build_object('account_pending', true, 'needs_mp', false);
    ELSE
      IF (p ->> 'account_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: account_id'; END IF;
      v_why := wa.account_check((p ->> 'account_id')::uuid, p ->> 'method', false);
      IF v_why IS NOT NULL THEN RAISE EXCEPTION 'WA_ACCOUNT_NOT_SELECTABLE: %', v_why; END IF;
      p := (p - 'account_pending') || jsonb_build_object('needs_mp', p ->> 'method' = 'MERCADOPAGO');
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
-- >>> wa_confirm
-- the UNCLASSIFIED expense (owner decision, stage 2): the money leaves now — ONE payment, ONE posting, ONE pending in the ERP
-- (register_unclassified_expense, 0102) — and the subcategory is chosen later in the ERP (no second movement). Same key as a
-- classified confirmation of that version: the ERP serializes both on it, so one draft version is one expense, whichever button.
CREATE FUNCTION wa.dispatch_unclassified(d wa.draft, p_key TEXT, p_inbound BIGINT) RETURNS JSONB LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
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
  -- the live enabled paying accounts with the method each one serves (ids are what the draft and the accounting call use)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.nombre, 'account_type', s.account_type, 'method', s.method) ORDER BY s.method, s.nombre), '[]'::jsonb)
    INTO v_accs FROM wa.selectable_accounts() s;
  RETURN jsonb_build_object('ok', true, 'open', v_open, 'waiting', v_waiting, 'catalog', jsonb_build_object('categories', v_cats, 'accounts', v_accs));
END $$;
-- <<< wa_context
ALTER FUNCTION wa.selectable_categories() OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.selectable_categories() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION wa.category_check(uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.category_check(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION wa.selectable_accounts() OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.selectable_accounts() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION wa.account_check(uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.account_check(uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION wa.validate_payload(text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.validate_payload(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION wa.dispatch_unclassified(wa.draft, text, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.dispatch_unclassified(wa.draft, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.wa_confirm(bigint, uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_confirm(bigint, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_confirm(bigint, uuid, integer) TO authenticated;
ALTER FUNCTION public.wa_context(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_context(bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_context(bigint) TO authenticated;
DROP VIEW IF EXISTS public.fin_mp_whatsapp_notes;
-- >>> mp_notes
-- 9. ERP read model (ADMIN only): the concept received by WhatsApp for a Mercado Pago outflow confirmed with "Registrar sin
--    clasif". That confirmation wrote nothing in the ERP (the outflow is already the ADR-021 provisional); this view only shows
--    the note next to the pending outflow. Tie: the SOURCE_ID — one live / confirmed draft per SOURCE_ID (wa_draft_mp_source_once),
--    one pending outflow per SOURCE_ID (its unique key) — so at most one note per outflow. Read-only: no operation, posting,
--    payment or purchase; no change to the reconciliation or to the Mercado Pago RPCs. Owner postgres (reads wa.draft, which the
--    API cannot reach); the ADMIN filter (active ADMIN profile of auth.uid()) is the authority, as in the ERP views.
--    security_barrier: the ADMIN condition is evaluated BEFORE any condition of the caller (no leak through query filters /
--    functions); only the four columns the screen needs leave wa.draft.
CREATE VIEW public.fin_mp_whatsapp_notes WITH (security_barrier = true) AS
  SELECT p.source_id::text AS source_id, d.short_code AS draft_short_code, (d.payload ->> 'concept') AS concept, c.confirmed_at
    FROM wa.draft d
    JOIN wa.confirmation c ON c.draft_id = d.id
    JOIN mp_pending_outflow p ON p.source_id = d.payload ->> 'mp_source_id'
   WHERE d.state = 'CONFIRMED' AND d.result ->> 'financial_effect' = 'EXISTING_MP_OUTFLOW'
     -- the caller is an active ADMIN profile (same rule as current_app_role(); read through the view owner, no error for others)
     AND EXISTS (SELECT 1 FROM perfiles pf WHERE pf.id = auth.uid() AND pf.activo AND pf.rol_type::text = 'ADMIN');
ALTER VIEW public.fin_mp_whatsapp_notes OWNER TO postgres;
REVOKE ALL ON public.fin_mp_whatsapp_notes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.fin_mp_whatsapp_notes TO authenticated;
-- <<< mp_notes
