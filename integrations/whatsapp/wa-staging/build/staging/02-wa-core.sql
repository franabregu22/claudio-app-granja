-- ============================================================================
-- ADR-025 — WhatsApp gateway core (schema wa + public.wa_* API). Generated from ONE template; the builds differ only in
-- search_path, which decides which accounting functions the unqualified calls in wa.dispatch resolve to.
-- Identity: §14.3 — the actor is read from the draft row, both JWT claims are set transaction-locally, asserted, and the
-- caller's values restored. The API is gated to the single gateway Auth user (wa.config) and a master switch.
-- ============================================================================
SET LOCAL search_path = sim, public, pg_temp;

CREATE SCHEMA wa;
REVOKE ALL ON SCHEMA wa FROM PUBLIC;

-- ── tables ───────────────────────────────────────────────────────────────────
CREATE TABLE wa.config (
  singleton       BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  gateway_user_id UUID NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  draft_ttl       INTERVAL NOT NULL DEFAULT '48 hours',
  waiting_mp_ttl  INTERVAL NOT NULL DEFAULT '72 hours',
  waiting_mp_cap  INTEGER NOT NULL DEFAULT 5 CHECK (waiting_mp_cap BETWEEN 0 AND 20),
  message_max_age INTERVAL NOT NULL DEFAULT '24 hours'
);
CREATE TABLE wa.sender (
  phone_e164 TEXT PRIMARY KEY CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  perfil_id  UUID NOT NULL UNIQUE REFERENCES perfiles(id) ON DELETE RESTRICT,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE wa.inbound_message (
  id               BIGSERIAL PRIMARY KEY,
  wamid            TEXT NOT NULL UNIQUE CHECK (length(wamid) BETWEEN 1 AND 200),
  phone_e164       TEXT NOT NULL,
  sender_perfil_id UUID,
  meta_ts          TIMESTAMPTZ NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind             TEXT NOT NULL,
  text_body        TEXT,
  button_payload   TEXT,
  media_id         TEXT,
  raw_sha256       TEXT NOT NULL,
  outcome          TEXT NOT NULL CHECK (outcome IN ('ACCEPTED', 'UNAUTHORIZED_SENDER', 'STALE', 'FUTURE')),
  used_action      TEXT CHECK (used_action IN ('PROPOSE', 'CORRECT', 'CANCEL', 'LINK_MP', 'CONFIRM')),
  used_draft_id    UUID,
  action_result    JSONB
);
CREATE SEQUENCE wa.draft_code_seq;
CREATE TABLE wa.draft (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code      TEXT NOT NULL UNIQUE DEFAULT 'W-' || lpad(nextval('wa.draft_code_seq')::text, 4, '0'),
  owner_perfil_id UUID NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT,
  type            TEXT NOT NULL CHECK (type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE', 'SUPPLIER_CREDIT_PURCHASE', 'SUPPLIER_PURCHASE_WITH_INVOICE', 'VAT_ONLY_DOCUMENT')),
  state           TEXT NOT NULL CHECK (state IN ('DRAFT', 'WAITING_MP', 'CONFIRMING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  version_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  result          JSONB,
  error_code      TEXT
);
-- one editable draft per sender; WAITING_MP does not count (O-14)
CREATE UNIQUE INDEX wa_draft_one_open ON wa.draft (owner_perfil_id) WHERE state IN ('DRAFT', 'CONFIRMING');
-- one Mercado Pago outflow belongs to at most one live or confirmed draft (also under concurrency)
CREATE UNIQUE INDEX wa_draft_mp_source_once ON wa.draft ((payload ->> 'mp_source_id'))
  WHERE payload ? 'mp_source_id' AND state IN ('DRAFT', 'WAITING_MP', 'CONFIRMING', 'CONFIRMED');
CREATE TABLE wa.draft_version (
  draft_id   UUID NOT NULL REFERENCES wa.draft(id) ON DELETE RESTRICT,
  version    INTEGER NOT NULL,
  payload    JSONB NOT NULL,
  inbound_id BIGINT REFERENCES wa.inbound_message(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, version)
);
CREATE TABLE wa.confirmation (
  draft_id        UUID PRIMARY KEY REFERENCES wa.draft(id) ON DELETE RESTRICT,
  version         INTEGER NOT NULL,
  perfil_id       UUID NOT NULL,
  inbound_id      BIGINT NOT NULL UNIQUE REFERENCES wa.inbound_message(id),
  payload_sha256  TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  result          JSONB NOT NULL
);
CREATE TABLE wa.audit_event (
  id              BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  action          TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  actor_perfil_id UUID,
  gateway_uid     UUID,
  inbound_id      BIGINT,
  draft_id        UUID,
  version         INTEGER,
  detail          JSONB
);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['config', 'sender', 'inbound_message', 'draft', 'draft_version', 'confirmation', 'audit_event'] LOOP
    EXECUTE format('ALTER TABLE wa.%I ENABLE ROW LEVEL SECURITY', t);          -- no policy: nobody through the API
    EXECUTE format('REVOKE ALL ON TABLE wa.%I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END $$;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA wa FROM PUBLIC, anon, authenticated, service_role;

-- ── internal helpers (INVOKER; only reachable from the SECURITY DEFINER wa_* functions, which run as the owner) ──
CREATE FUNCTION wa.audit(p_action TEXT, p_outcome TEXT, p_actor UUID, p_inbound BIGINT, p_draft UUID, p_version INTEGER, p_detail JSONB)
RETURNS VOID LANGUAGE sql SET search_path = sim, public, pg_temp AS $$
  INSERT INTO wa.audit_event (action, outcome, actor_perfil_id, gateway_uid, inbound_id, draft_id, version, detail)
  VALUES (p_action, p_outcome, p_actor, auth.uid(), p_inbound, p_draft, p_version, p_detail);
$$;

-- the API gate: only the gateway Auth user, only while enabled
CREATE FUNCTION wa.gate() RETURNS UUID LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE c wa.config;
BEGIN
  SELECT * INTO c FROM wa.config WHERE singleton;
  IF NOT FOUND OR NOT c.enabled OR auth.uid() IS DISTINCT FROM c.gateway_user_id THEN
    RAISE EXCEPTION 'FORBIDDEN: WhatsApp gateway only';
  END IF;
  RETURN c.gateway_user_id;
END $$;

-- the sender of a message is authorized only while its mapping AND its ERP profile are active ADMIN
CREATE FUNCTION wa.admin_sender(p_phone TEXT) RETURNS UUID LANGUAGE sql STABLE SET search_path = sim, public, pg_temp AS $$
  SELECT s.perfil_id FROM wa.sender s JOIN perfiles p ON p.id = s.perfil_id
   WHERE s.phone_e164 = p_phone AND s.activo AND p.activo AND p.rol_type::text = 'ADMIN';
$$;
CREATE FUNCTION wa.assert_owner(p_perfil UUID) RETURNS VOID LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wa.sender s JOIN perfiles p ON p.id = s.perfil_id
                  WHERE s.perfil_id = p_perfil AND s.activo AND p.activo AND p.rol_type::text = 'ADMIN') THEN
    RAISE EXCEPTION 'WA_OWNER_NOT_AUTHORIZED: the draft owner is no longer an active, mapped ADMIN';
  END IF;
END $$;

-- one inbound message drives at most one action; a retry of the SAME action on the SAME draft replays its result
CREATE FUNCTION wa.claim_inbound(p_inbound BIGINT, p_action TEXT, p_draft UUID, OUT msg wa.inbound_message, OUT replay JSONB)
LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
BEGIN
  SELECT * INTO msg FROM wa.inbound_message WHERE id = p_inbound FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WA_MESSAGE_NOT_FOUND'; END IF;
  IF msg.outcome <> 'ACCEPTED' THEN RAISE EXCEPTION 'WA_MESSAGE_NOT_ACCEPTED: %', msg.outcome; END IF;
  IF msg.used_action IS NOT NULL THEN
    IF msg.used_action = p_action AND (p_draft IS NULL OR msg.used_draft_id = p_draft) THEN
      replay := msg.action_result || jsonb_build_object('replay', true);
      RETURN;
    END IF;
    RAISE EXCEPTION 'WA_MESSAGE_ALREADY_USED: % on %', msg.used_action, msg.used_draft_id;
  END IF;
END $$;
CREATE FUNCTION wa.use_inbound(p_inbound BIGINT, p_action TEXT, p_draft UUID, p_result JSONB) RETURNS JSONB
LANGUAGE sql SET search_path = sim, public, pg_temp AS $$
  UPDATE wa.inbound_message SET used_action = p_action, used_draft_id = p_draft, action_result = p_result WHERE id = p_inbound;
  SELECT p_result;
$$;

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
CREATE FUNCTION wa.validate_payload(p_type TEXT, p_payload JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
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

-- possible duplicates already recorded (a warning for the confirmation text; never a block)
CREATE FUNCTION wa.duplicate_hint(p JSONB) RETURNS INTEGER LANGUAGE sql STABLE SET search_path = sim, public, pg_temp AS $$
  SELECT count(*)::int FROM purchases x
   WHERE x.is_current AND x.amount_total = (p ->> 'total')::numeric
     AND x.economic_date BETWEEN (p ->> 'date')::date - 2 AND (p ->> 'date')::date + 2;
$$;
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

-- the pending-outflow view is ADMIN-only (current_app_role()): it is read as the draft owner, then the caller's claims return
CREATE FUNCTION wa.pending_outflow_ok(p_owner UUID, p_source TEXT, p_total NUMERIC, p_date DATE) RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE v_old_sub TEXT := current_setting('request.jwt.claim.sub', true); v_old_claims TEXT := current_setting('request.jwt.claims', true); v_ok BOOLEAN;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_owner::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_owner, 'role', 'authenticated')::text, true);
  IF auth.uid() IS DISTINCT FROM p_owner OR current_app_role() <> 'ADMIN' THEN RAISE EXCEPTION 'WA_DELEGATION_MISMATCH'; END IF;
  v_ok := EXISTS (SELECT 1 FROM fin_mp_pending_classification v WHERE v.source_id = p_source AND v.direction = 'OUT' AND v.status = 'PENDING'
                   AND v.economic_amount = p_total AND v.business_date = p_date);
  PERFORM set_config('request.jwt.claim.sub', coalesce(v_old_sub, ''), true);
  PERFORM set_config('request.jwt.claims', coalesce(v_old_claims, ''), true);
  RETURN v_ok;
END $$;

-- the ONLY place that calls accounting: unqualified, named parameters (resolved through search_path)
CREATE FUNCTION wa.dispatch(d wa.draft, p_key TEXT) RETURNS JSONB LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE p JSONB := d.payload; f JSONB := d.payload -> 'fiscal'; v_reason TEXT := 'WhatsApp ' || d.short_code || ' v' || d.version;
BEGIN
  CASE d.type
    WHEN 'CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE' THEN
      RETURN register_casual_purchase(
        p_economic_date := (p ->> 'date')::date, p_amount_net := coalesce((p ->> 'net')::numeric, (p ->> 'total')::numeric),
        p_amount_total := (p ->> 'total')::numeric, p_expense_category_id := (p ->> 'category_id')::uuid, p_concept := p ->> 'concept',
        p_nature := (p ->> 'nature')::purchase_nature, p_paid_from_account_id := (p ->> 'account_id')::uuid,
        p_payment_method := (p ->> 'method')::payment_method, p_idempotency_key := p_key, p_counterparty_name := p ->> 'counterparty',
        p_lines := coalesce(p -> 'lines', '[]'::jsonb), p_attachments := coalesce(p -> 'attachments', '[]'::jsonb),
        p_fiscal := CASE WHEN d.type = 'CASUAL_WITH_INVOICE' THEN f END, p_mp_source_id := p ->> 'mp_source_id', p_reason := v_reason);
    WHEN 'SUPPLIER_CREDIT_PURCHASE' THEN
      RETURN register_purchase(
        p_supplier_id := (p ->> 'supplier_id')::uuid, p_economic_date := (p ->> 'date')::date,
        p_amount_net := coalesce((p ->> 'net')::numeric, (p ->> 'total')::numeric), p_amount_total := (p ->> 'total')::numeric,
        p_expense_category_id := (p ->> 'category_id')::uuid, p_subcategory := NULL, p_nature := (p ->> 'nature')::purchase_nature,
        p_lines := coalesce(p -> 'lines', '[]'::jsonb), p_attachments := coalesce(p -> 'attachments', '[]'::jsonb), p_idempotency_key := p_key,
        p_supplier_invoice_number := p ->> 'invoice_number', p_reason := v_reason);
    WHEN 'SUPPLIER_PURCHASE_WITH_INVOICE' THEN
      RETURN register_purchase_with_fiscal_document(
        p_supplier_id := (p ->> 'supplier_id')::uuid, p_economic_date := (p ->> 'date')::date,
        p_amount_net := coalesce((p ->> 'net')::numeric, (p ->> 'total')::numeric), p_amount_total := (p ->> 'total')::numeric,
        p_expense_category_id := (p ->> 'category_id')::uuid, p_nature := (p ->> 'nature')::purchase_nature,
        p_lines := coalesce(p -> 'lines', '[]'::jsonb), p_attachments := coalesce(p -> 'attachments', '[]'::jsonb), p_idempotency_key := p_key,
        p_fiscal_document_type := (f ->> 'document_type')::fiscal_document_type, p_fiscal_period := (f ->> 'fiscal_period')::date,
        p_fiscal_net_amount := (f ->> 'net_amount')::numeric, p_fiscal_total_amount := (f ->> 'total_amount')::numeric,
        p_fiscal_components := coalesce(f -> 'components', '[]'::jsonb), p_supplier_invoice_number := p ->> 'invoice_number', p_reason := v_reason);
    WHEN 'VAT_ONLY_DOCUMENT' THEN
      RETURN register_fiscal_document(
        p_document_type := (f ->> 'document_type')::fiscal_document_type, p_direction := 'CREDITO'::fiscal_direction,
        p_document_date := (f ->> 'document_date')::date, p_fiscal_period := (f ->> 'fiscal_period')::date,
        p_net_amount := (f ->> 'net_amount')::numeric, p_total_amount := (f ->> 'total_amount')::numeric,
        p_components := coalesce(f -> 'components', '[]'::jsonb), p_supplier_id := NULL, p_cliente_id := NULL,
        p_external_number := f ->> 'external_number', p_reason := v_reason,
        p_issuer_tax_id := f ->> 'issuer_tax_id', p_issuer_name := f ->> 'issuer_name');
  END CASE;
END $$;

-- ── public API: SECURITY DEFINER, EXECUTE for authenticated only, gated to the gateway user ──
-- 1. ingest: Meta HMAC over the ORIGINAL bytes (secret in Vault), then one row per message (wamid UNIQUE)
CREATE FUNCTION public.wa_ingest(p_raw_b64 TEXT, p_signature TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE v_bytes BYTEA; v_secret TEXT; v_body JSONB; m JSONB; v_phone TEXT; v_sender UUID; v_ts TIMESTAMPTZ; v_outcome TEXT;
        v_id BIGINT; v_dup BOOLEAN; v_out JSONB := '[]'::jsonb; c wa.config; v_sha TEXT;
BEGIN
  PERFORM wa.gate();
  SELECT * INTO c FROM wa.config WHERE singleton;
  BEGIN v_bytes := decode(p_raw_b64, 'base64'); EXCEPTION WHEN others THEN RAISE EXCEPTION 'WA_BAD_BODY: base64 required'; END;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'wa_meta_app_secret';
  IF v_secret IS NULL THEN RAISE EXCEPTION 'WA_NOT_CONFIGURED: Meta app secret missing'; END IF;
  -- constant-time comparison: compare HMACs of the two signatures, never the text itself
  IF coalesce(p_signature, '') !~ '^sha256=[0-9a-f]{64}$'
     OR extensions.hmac(convert_to(p_signature, 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256')
        <> extensions.hmac(convert_to('sha256=' || encode(extensions.hmac(v_bytes, convert_to(v_secret, 'UTF8'), 'sha256'), 'hex'), 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256') THEN
    PERFORM wa.audit('INGEST', 'BAD_SIGNATURE', NULL, NULL, NULL, NULL, jsonb_build_object('bytes', octet_length(v_bytes)));
    RETURN jsonb_build_object('ok', false, 'error', 'WA_BAD_SIGNATURE');
  END IF;
  v_sha := encode(extensions.digest(v_bytes, 'sha256'), 'hex');
  v_body := convert_from(v_bytes, 'UTF8')::jsonb;
  FOR m IN SELECT msg FROM jsonb_array_elements(coalesce(v_body -> 'entry', '[]'::jsonb)) e,
                          jsonb_array_elements(coalesce(e -> 'changes', '[]'::jsonb)) ch,
                          jsonb_array_elements(coalesce(ch -> 'value' -> 'messages', '[]'::jsonb)) msg LOOP
    v_phone := '+' || (m ->> 'from');
    v_ts := to_timestamp((m ->> 'timestamp')::bigint);
    v_sender := wa.admin_sender(v_phone);
    v_outcome := CASE WHEN v_sender IS NULL THEN 'UNAUTHORIZED_SENDER' WHEN v_ts < now() - c.message_max_age THEN 'STALE'
                      WHEN v_ts > now() + interval '5 minutes' THEN 'FUTURE' ELSE 'ACCEPTED' END;
    INSERT INTO wa.inbound_message (wamid, phone_e164, sender_perfil_id, meta_ts, kind, text_body, button_payload, media_id, raw_sha256, outcome)
    VALUES (m ->> 'id', v_phone, v_sender, v_ts, coalesce(m ->> 'type', 'unknown'), left(m -> 'text' ->> 'body', 2000),
            coalesce(m -> 'interactive' -> 'button_reply' ->> 'id', m -> 'button' ->> 'payload'),
            coalesce(m -> 'image' ->> 'id', m -> 'document' ->> 'id'), v_sha, v_outcome)
    ON CONFLICT (wamid) DO NOTHING RETURNING id INTO v_id;
    v_dup := v_id IS NULL;
    IF v_dup THEN SELECT id, outcome INTO v_id, v_outcome FROM wa.inbound_message WHERE wamid = m ->> 'id'; END IF;
    IF NOT v_dup THEN PERFORM wa.audit('INGEST', v_outcome, v_sender, v_id, NULL, NULL, jsonb_build_object('kind', m ->> 'type')); END IF;
    v_out := v_out || jsonb_build_object('inbound_id', v_id, 'wamid', m ->> 'id', 'duplicate', v_dup, 'outcome', v_outcome, 'phone', v_phone,
      'kind', m ->> 'type', 'text', left(m -> 'text' ->> 'body', 2000),
      'button_payload', coalesce(m -> 'interactive' -> 'button_reply' ->> 'id', m -> 'button' ->> 'payload'),
      'media_id', coalesce(m -> 'image' ->> 'id', m -> 'document' ->> 'id'));
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'messages', v_out);
END $$;

-- 2. propose: the interpreted payload becomes a draft of the message's sender
-- >>> wa_propose
CREATE FUNCTION public.wa_propose(p_inbound_id BIGINT, p_type TEXT, p_payload JSONB) RETURNS JSONB
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

-- shared checks for an existing draft acted on by a message
CREATE FUNCTION wa.lock_owned_draft(p_msg wa.inbound_message, p_draft UUID, p_version INTEGER) RETURNS wa.draft
LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE d wa.draft;
BEGIN
  SELECT * INTO d FROM wa.draft WHERE id = p_draft FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WA_DRAFT_NOT_FOUND'; END IF;
  IF p_msg.sender_perfil_id IS DISTINCT FROM d.owner_perfil_id THEN RAISE EXCEPTION 'WA_NOT_DRAFT_OWNER'; END IF;
  PERFORM wa.assert_owner(d.owner_perfil_id);
  IF d.state IN ('CONFIRMED', 'CANCELLED', 'EXPIRED') THEN RETURN d; END IF;   -- callers decide (replay / refusal)
  IF d.version <> p_version THEN RAISE EXCEPTION 'WA_VERSION_CHANGED: current version %', d.version; END IF;
  RETURN d;
END $$;
CREATE FUNCTION wa.expire_if_due(d wa.draft) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
BEGIN
  IF d.state IN ('DRAFT', 'WAITING_MP', 'FAILED') AND d.expires_at <= now() THEN
    UPDATE wa.draft SET state = 'EXPIRED', updated_at = now() WHERE id = d.id;
    PERFORM wa.audit('EXPIRE', 'EXPIRED', d.owner_perfil_id, NULL, d.id, d.version, NULL);
    RETURN true;
  END IF;
  RETURN false;
END $$;

-- 3. correct: a new version of the sender's own draft
-- >>> wa_correct
CREATE FUNCTION public.wa_correct(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER, p_payload JSONB) RETURNS JSONB
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

-- 4. cancel
CREATE FUNCTION public.wa_cancel(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE ci RECORD; d wa.draft; r JSONB;
BEGIN
  PERFORM wa.gate();
  SELECT * INTO ci FROM wa.claim_inbound(p_inbound_id, 'CANCEL', p_draft_id);
  IF ci.replay IS NOT NULL THEN RETURN ci.replay; END IF;
  d := wa.lock_owned_draft(ci.msg, p_draft_id, p_expected_version);
  IF d.state NOT IN ('DRAFT', 'WAITING_MP', 'FAILED') THEN RAISE EXCEPTION 'WA_DRAFT_NOT_CANCELLABLE: %', d.state; END IF;
  UPDATE wa.draft SET state = 'CANCELLED', updated_at = now() WHERE id = d.id;
  r := jsonb_build_object('ok', true, 'draft_id', d.id, 'short_code', d.short_code, 'state', 'CANCELLED');
  PERFORM wa.audit('CANCEL', 'CANCELLED', d.owner_perfil_id, p_inbound_id, d.id, d.version, NULL);
  RETURN wa.use_inbound(p_inbound_id, 'CANCEL', d.id, r);
END $$;

-- 5. link a WAITING_MP draft to the real Mercado Pago outflow (pending, same amount, same business date, not taken)
CREATE FUNCTION public.wa_link_mp(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER, p_source_id TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE c wa.config; ci RECORD; d wa.draft; r JSONB;
BEGIN
  PERFORM wa.gate(); SELECT * INTO c FROM wa.config WHERE singleton;
  SELECT * INTO ci FROM wa.claim_inbound(p_inbound_id, 'LINK_MP', p_draft_id);
  IF ci.replay IS NOT NULL THEN RETURN ci.replay; END IF;
  d := wa.lock_owned_draft(ci.msg, p_draft_id, p_expected_version);
  IF wa.expire_if_due(d) THEN RETURN wa.use_inbound(p_inbound_id, 'LINK_MP', d.id, jsonb_build_object('ok', false, 'error', 'WA_DRAFT_EXPIRED')); END IF;
  IF d.state <> 'WAITING_MP' THEN RAISE EXCEPTION 'WA_NOT_WAITING_MP: %', d.state; END IF;
  IF NOT wa.pending_outflow_ok(d.owner_perfil_id, p_source_id, (d.payload ->> 'total')::numeric, (d.payload ->> 'date')::date) THEN
    RAISE EXCEPTION 'WA_MP_OUTFLOW_NOT_MATCHING: no pending outflow % with that amount and date', p_source_id;
  END IF;
  IF EXISTS (SELECT 1 FROM wa.draft x WHERE x.payload ->> 'mp_source_id' = p_source_id AND x.state IN ('DRAFT', 'WAITING_MP', 'CONFIRMING', 'CONFIRMED') AND x.id <> d.id) THEN
    RAISE EXCEPTION 'WA_MP_OUTFLOW_TAKEN: % is linked to another draft', p_source_id;
  END IF;
  IF EXISTS (SELECT 1 FROM wa.draft WHERE owner_perfil_id = d.owner_perfil_id AND state IN ('DRAFT', 'CONFIRMING')) THEN
    RAISE EXCEPTION 'WA_OPEN_DRAFT_EXISTS: finish the open draft before linking this one';
  END IF;
  UPDATE wa.draft SET version = version + 1, payload = payload || jsonb_build_object('mp_source_id', p_source_id), state = 'DRAFT',
                      updated_at = now(), version_at = now(), expires_at = now() + c.draft_ttl
   WHERE id = d.id RETURNING * INTO d;
  INSERT INTO wa.draft_version (draft_id, version, payload, inbound_id) VALUES (d.id, d.version, d.payload, p_inbound_id);
  r := jsonb_build_object('ok', true, 'draft_id', d.id, 'short_code', d.short_code, 'state', d.state, 'version', d.version, 'payload', d.payload,
                          'confirm_payload', 'CONFIRM:' || d.id || ':' || d.version, 'cancel_payload', 'CANCEL:' || d.id || ':' || d.version);
  PERFORM wa.audit('LINK_MP', 'DRAFT', d.owner_perfil_id, p_inbound_id, d.id, d.version, jsonb_build_object('source_id', p_source_id));
  RETURN wa.use_inbound(p_inbound_id, 'LINK_MP', d.id, r);
END $$;

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
CREATE FUNCTION public.wa_confirm(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER) RETURNS JSONB
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

-- 7. expiry sweep (called by the scheduler of the gateway)
CREATE FUNCTION public.wa_expire() RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE n INTEGER := 0; d wa.draft;
BEGIN
  PERFORM wa.gate();
  FOR d IN SELECT * FROM wa.draft WHERE state IN ('DRAFT', 'WAITING_MP', 'FAILED') AND expires_at <= now() FOR UPDATE SKIP LOCKED LOOP
    IF wa.expire_if_due(d) THEN n := n + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'expired', n);
END $$;

-- >>> wa_context
-- 8. context (READ-ONLY): the live drafts of the SENDER of an accepted, fresh message — current version and payload are the
--    source of truth for corrections — plus the selectable catalog. Consumes nothing (the message stays usable for one action).
CREATE FUNCTION public.wa_context(p_inbound_id BIGINT) RETURNS JSONB
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

-- ── privileges: helpers callable by nobody; the API by authenticated (and the gate inside) ──
DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'wa' OR (n.nspname = 'public' AND p.proname IN ('wa_ingest', 'wa_propose', 'wa_correct', 'wa_cancel', 'wa_link_mp', 'wa_confirm', 'wa_expire', 'wa_context')) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f.sig);
    IF f.nspname = 'public' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig); END IF;
  END LOOP;
END $$;
