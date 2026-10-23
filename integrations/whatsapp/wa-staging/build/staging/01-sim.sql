-- ============================================================================
-- ADR-025 §18 — schema sim: CONTRACT DOUBLES of the ERP accounting surface. STAGING ONLY (AppGranja).
-- NEVER part of the production candidate (the generator refuses any "sim" token in that build).
-- Names, column names, enum labels, parameter names and return shapes mirror the real objects (0001–0100), so the
-- unqualified dispatch in wa-core resolves here when search_path starts with sim. Only the guards that matter to the bot
-- are reproduced; there are no postings, ledgers or P&L.
-- ============================================================================
SET LOCAL search_path = sim, public, pg_temp;

CREATE SCHEMA sim;
REVOKE ALL ON SCHEMA sim FROM PUBLIC;

CREATE TYPE sim.rol_type AS ENUM ('ADMIN', 'OPERATOR');
CREATE TYPE sim.account_type AS ENUM ('CASH', 'BANK_ACCOUNT', 'EXTERNAL_SERVICE');
CREATE TYPE sim.purchase_nature AS ENUM ('OPERATING', 'REINVESTMENT', 'INVESTMENT');
CREATE TYPE sim.payment_method AS ENUM ('CASH', 'CHEQUE', 'TRANSFER', 'MERCADOPAGO');
CREATE TYPE sim.fiscal_document_type AS ENUM ('INVOICE_A', 'INVOICE_B', 'INVOICE_C', 'CREDIT_NOTE', 'DEBIT_NOTE', 'RECEIPT', 'OTHER');
CREATE TYPE sim.fiscal_direction AS ENUM ('DEBITO', 'CREDITO');

CREATE TABLE sim.perfiles (
  id         UUID PRIMARY KEY,                      -- = auth.users.id of the synthetic staging user
  email      TEXT NOT NULL UNIQUE CHECK (email LIKE '%@staging.invalid'),
  rol_type   sim.rol_type NOT NULL,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sim.expense_category_group (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL UNIQUE, activo BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL CHECK (kind IN ('EXPENSE', 'OWNER_WITHDRAWAL')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sim.expense_category (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL, description TEXT, activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), pnl_cost_class TEXT, group_id UUID NOT NULL REFERENCES sim.expense_category_group(id),
  default_nature sim.purchase_nature, fiscal_reserved BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE sim.financial_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL UNIQUE, account_type sim.account_type NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sim.suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL, fiscal_id TEXT, contacto TEXT,
  activo BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- the pending Mercado Pago outflows (real: mp_pending_outflow + the ADMIN-only view fin_mp_pending_classification)
CREATE TABLE sim.mp_pending_outflow (
  pending_key TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK (kind IN ('PAYOUT', 'OUTBOUND')),
  direction TEXT NOT NULL DEFAULT 'OUT', business_date DATE NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount NUMERIC(14,2) NOT NULL, economic_amount NUMERIC(14,2) NOT NULL, charges_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  account_name TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'PENDING', already_posted BOOLEAN NOT NULL DEFAULT false,
  financial_operation_id BIGINT, is_historical BOOLEAN NOT NULL DEFAULT false, destination_status TEXT, destination_last4 TEXT,
  matched_account_name TEXT,
  classified_as TEXT, purchase_id UUID                         -- sim-only: "classified once"
);
CREATE TABLE sim.fiscal_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_type sim.fiscal_document_type NOT NULL, direction sim.fiscal_direction NOT NULL,
  document_date DATE NOT NULL, fiscal_period DATE NOT NULL, net_amount NUMERIC(14,2) NOT NULL, total_amount NUMERIC(14,2) NOT NULL,
  external_number TEXT, issuer_tax_id TEXT, issuer_name TEXT, supplier_id UUID, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sim_fiscal_document_unique ON sim.fiscal_document (direction, document_type, coalesce(issuer_tax_id, supplier_id::text), external_number)
  WHERE external_number IS NOT NULL;
CREATE TABLE sim.purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id UUID REFERENCES sim.suppliers(id), economic_date DATE NOT NULL,
  amount_net NUMERIC(14,2) NOT NULL, amount_total NUMERIC(14,2) NOT NULL, expense_category_id UUID NOT NULL REFERENCES sim.expense_category(id),
  subcategory TEXT, nature sim.purchase_nature NOT NULL, fiscal_document_id UUID REFERENCES sim.fiscal_document(id),
  supplier_invoice_number TEXT, is_current BOOLEAN NOT NULL DEFAULT true, version_seq INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by UUID, counterparty_name TEXT,
  paid_operation_id BIGINT,
  concept TEXT, paid_from_account_id UUID, payment_method sim.payment_method, mp_source_id TEXT    -- sim-only evidence
);
CREATE TABLE sim.audit_events (
  id BIGSERIAL PRIMARY KEY, table_name TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL,
  performed_by UUID, reason TEXT, new_data JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE sim.financial_operation_seq;

-- identity contract: auth.uid() → active profile → role (same errors as the real one)
CREATE FUNCTION sim.current_app_role() RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE v_uid UUID := auth.uid(); v_role TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT rol_type::text INTO v_role FROM sim.perfiles WHERE id = v_uid AND activo;
  IF v_role IS NULL THEN RAISE EXCEPTION 'USER_NOT_FOUND_OR_INACTIVE'; END IF;
  RETURN v_role;
END $$;

-- same contract as the real view: unclassified outflows, visible only when the CURRENT identity is an active ADMIN
CREATE VIEW sim.fin_mp_pending_classification AS
  SELECT pending_key, source_id, kind, direction, business_date, occurred_at, amount, economic_amount, charges_amount, account_name,
         description, status, already_posted, financial_operation_id, is_historical, destination_status, destination_last4, matched_account_name
    FROM sim.mp_pending_outflow
   WHERE classified_as IS NULL AND (SELECT sim.current_app_role()) = 'ADMIN';

-- shared guards
CREATE FUNCTION sim.assert_admin_and_key(p_key TEXT) RETURNS UUID LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
BEGIN
  IF sim.current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required'; END IF;
  IF p_key LIKE 'RECTIFY:%' THEN RAISE EXCEPTION 'RESERVED_IDEMPOTENCY_KEY: the prefix RECTIFY: is reserved for system-generated version keys'; END IF;
  RETURN auth.uid();
END $$;
CREATE FUNCTION sim.assert_category(p_category UUID) RETURNS VOID LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE c RECORD;
BEGIN
  SELECT e.activo, e.fiscal_reserved, g.kind INTO c FROM sim.expense_category e JOIN sim.expense_category_group g ON g.id = e.group_id WHERE e.id = p_category;
  IF NOT FOUND OR NOT c.activo THEN RAISE EXCEPTION 'CATEGORY_REQUIRED: an active expense category is required'; END IF;
  IF c.fiscal_reserved OR c.kind = 'OWNER_WITHDRAWAL' THEN RAISE EXCEPTION 'CATEGORY_NOT_SELECTABLE'; END IF;
END $$;
CREATE FUNCTION sim.fiscal_document_insert(p_type sim.fiscal_document_type, p_direction sim.fiscal_direction, p_date DATE, p_period DATE,
  p_net NUMERIC, p_total NUMERIC, p_supplier UUID, p_number TEXT, p_tax_id TEXT, p_name TEXT, p_uid UUID) RETURNS JSONB
LANGUAGE plpgsql SET search_path = sim, public, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  IF p_supplier IS NULL AND coalesce(p_tax_id, '') !~ '^[0-9]{11}$' THEN RAISE EXCEPTION 'INVALID_ISSUER: an issuer CUIT (11 digits) identifies a received document without a supplier'; END IF;
  IF p_period IS NULL OR p_period <> date_trunc('month', p_period)::date THEN RAISE EXCEPTION 'INVALID_FISCAL_PERIOD: must be the first day of a month'; END IF;
  IF p_total IS NULL OR p_total <= 0 OR p_net IS NULL OR p_net < 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  BEGIN
    INSERT INTO sim.fiscal_document (document_type, direction, document_date, fiscal_period, net_amount, total_amount, external_number, issuer_tax_id, issuer_name, supplier_id, created_by)
    VALUES (p_type, p_direction, coalesce(p_date, p_period), p_period, p_net, p_total, p_number, p_tax_id, p_name, p_supplier, p_uid) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'DUPLICATE_FISCAL_DOCUMENT'; END;
  INSERT INTO sim.audit_events (table_name, record_id, action, performed_by, new_data) VALUES ('fiscal_document', v_id, 'INSERT', p_uid, jsonb_build_object('total', p_total));
  RETURN jsonb_build_object('fiscal_document_id', v_id, 'component_count', 0);
END $$;

-- ── doubles of the four RPCs (same parameter names and defaults; same return shape) ──
CREATE FUNCTION sim.register_casual_purchase(p_economic_date date, p_amount_net numeric, p_amount_total numeric, p_expense_category_id uuid,
  p_concept varchar, p_nature sim.purchase_nature, p_paid_from_account_id uuid, p_payment_method sim.payment_method, p_idempotency_key varchar,
  p_counterparty_name varchar DEFAULT NULL, p_lines jsonb DEFAULT '[]', p_attachments jsonb DEFAULT '[]', p_fiscal jsonb DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_flock_id uuid DEFAULT NULL, p_mp_source_id text DEFAULT NULL, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE v_uid UUID; v_existing sim.purchases; v_is_mp BOOLEAN; v_out sim.mp_pending_outflow; v_fiscal UUID; v_op BIGINT; v_id UUID;
BEGIN
  v_uid := sim.assert_admin_and_key(p_idempotency_key);
  SELECT * INTO v_existing FROM sim.purchases WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.supplier_id IS NULL THEN
      RETURN jsonb_build_object('purchase_id', v_existing.id, 'replayed', true, 'payment_operation_id', v_existing.paid_operation_id,
                                'amount', v_existing.amount_total, 'fiscal_document_id', v_existing.fiscal_document_id);
    END IF;
    RAISE EXCEPTION 'DUPLICATE_PURCHASE';
  END IF;
  IF p_amount_total IS NULL OR p_amount_total <= 0 OR p_amount_net IS NULL OR p_amount_net < 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  PERFORM sim.assert_category(p_expense_category_id);
  IF length(coalesce(btrim(p_concept), '')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required'; END IF;
  IF p_nature IS NULL THEN RAISE EXCEPTION 'NATURE_REQUIRED'; END IF;
  IF p_payment_method IS NULL OR p_payment_method = 'CHEQUE' THEN RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: a casual purchase is paid by cash, transfer or Mercado Pago (a cheque goes to a registered supplier)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sim.financial_account WHERE id = p_paid_from_account_id AND activo) THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE'; END IF;
  v_is_mp := EXISTS (SELECT 1 FROM sim.financial_account WHERE id = p_paid_from_account_id AND nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE');
  IF v_is_mp AND p_mp_source_id IS NULL THEN RAISE EXCEPTION 'MP_SOURCE_REQUIRED: a purchase paid from Mercado Pago must reference its payout SOURCE_ID'; END IF;
  IF NOT v_is_mp AND p_mp_source_id IS NOT NULL THEN RAISE EXCEPTION 'MP_SOURCE_NOT_ALLOWED: a SOURCE_ID is only valid for a purchase paid from Mercado Pago'; END IF;
  IF v_is_mp THEN
    SELECT * INTO v_out FROM sim.mp_pending_outflow WHERE source_id = p_mp_source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MP_SOURCE_NOT_FOUND: %', p_mp_source_id; END IF;
    IF v_out.classified_as IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_CLASSIFIED: payout % is already classified as %', p_mp_source_id, v_out.classified_as; END IF;
    IF p_amount_total <> v_out.economic_amount THEN RAISE EXCEPTION 'MP_AMOUNT_MISMATCH: the economic amount of the outflow is %', v_out.economic_amount; END IF;
    IF p_economic_date IS DISTINCT FROM v_out.business_date THEN RAISE EXCEPTION 'MP_DATE_MISMATCH: the payout date is %', v_out.business_date; END IF;
  END IF;
  IF p_fiscal IS NOT NULL THEN
    IF jsonb_typeof(p_fiscal) <> 'object' OR coalesce(p_fiscal ->> 'issuer_tax_id', '') = '' THEN
      RAISE EXCEPTION 'INVALID_FISCAL_DOCUMENT: an issuer CUIT is required for the invoice of a casual purchase';
    END IF;
    v_fiscal := (sim.fiscal_document_insert((p_fiscal ->> 'document_type')::sim.fiscal_document_type, 'CREDITO', (p_fiscal ->> 'document_date')::date,
                 (p_fiscal ->> 'fiscal_period')::date, (p_fiscal ->> 'net_amount')::numeric, (p_fiscal ->> 'total_amount')::numeric, NULL,
                 p_fiscal ->> 'external_number', p_fiscal ->> 'issuer_tax_id', p_fiscal ->> 'issuer_name', v_uid) ->> 'fiscal_document_id')::uuid;
  END IF;
  v_op := nextval('sim.financial_operation_seq');
  INSERT INTO sim.purchases (economic_date, amount_net, amount_total, expense_category_id, nature, fiscal_document_id, idempotency_key, created_by,
                             counterparty_name, paid_operation_id, concept, paid_from_account_id, payment_method, mp_source_id)
  VALUES (p_economic_date, p_amount_net, p_amount_total, p_expense_category_id, p_nature, v_fiscal, p_idempotency_key, v_uid,
          p_counterparty_name, v_op, btrim(p_concept), p_paid_from_account_id, p_payment_method, p_mp_source_id) RETURNING id INTO v_id;
  IF v_is_mp THEN UPDATE sim.mp_pending_outflow SET classified_as = 'CASUAL_PURCHASE', purchase_id = v_id, status = 'CLASSIFIED' WHERE source_id = p_mp_source_id; END IF;
  INSERT INTO sim.audit_events (table_name, record_id, action, performed_by, reason, new_data)
  VALUES ('purchases', v_id, 'INSERT', v_uid, p_reason, jsonb_build_object('amount_total', p_amount_total, 'economic_date', p_economic_date));
  RETURN jsonb_build_object('purchase_id', v_id, 'replayed', false, 'payment_operation_id', v_op, 'amount', p_amount_total, 'fiscal_document_id', v_fiscal);
END $$;

CREATE FUNCTION sim.register_purchase(p_supplier_id uuid, p_economic_date date, p_amount_net numeric, p_amount_total numeric,
  p_expense_category_id uuid, p_subcategory varchar DEFAULT NULL, p_nature sim.purchase_nature DEFAULT 'OPERATING', p_lines jsonb DEFAULT '[]',
  p_attachments jsonb DEFAULT '[]', p_idempotency_key varchar DEFAULT NULL, p_project_id uuid DEFAULT NULL, p_fiscal_document_id uuid DEFAULT NULL,
  p_supplier_invoice_number varchar DEFAULT NULL, p_flock_id uuid DEFAULT NULL, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE v_uid UUID; v_id UUID;
BEGIN
  v_uid := sim.assert_admin_and_key(p_idempotency_key);
  IF p_amount_total IS NULL OR p_amount_total <= 0 OR p_amount_net IS NULL OR p_amount_net < 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_nature IS NULL THEN RAISE EXCEPTION 'NATURE_REQUIRED'; END IF;
  PERFORM sim.assert_category(p_expense_category_id);
  IF NOT EXISTS (SELECT 1 FROM sim.suppliers WHERE id = p_supplier_id AND activo) THEN RAISE EXCEPTION 'SUPPLIER_NOT_FOUND_OR_INACTIVE'; END IF;
  IF EXISTS (SELECT 1 FROM sim.purchases WHERE idempotency_key = p_idempotency_key) THEN RAISE EXCEPTION 'DUPLICATE_PURCHASE'; END IF;
  IF p_supplier_invoice_number IS NOT NULL AND EXISTS (SELECT 1 FROM sim.purchases WHERE supplier_id = p_supplier_id AND supplier_invoice_number = p_supplier_invoice_number AND is_current) THEN
    RAISE EXCEPTION 'DUPLICATE_SUPPLIER_INVOICE: % already recorded for this supplier', p_supplier_invoice_number;
  END IF;
  INSERT INTO sim.purchases (supplier_id, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature, fiscal_document_id,
                             supplier_invoice_number, idempotency_key, created_by)
  VALUES (p_supplier_id, p_economic_date, p_amount_net, p_amount_total, p_expense_category_id, p_subcategory, p_nature, p_fiscal_document_id,
          p_supplier_invoice_number, p_idempotency_key, v_uid) RETURNING id INTO v_id;
  INSERT INTO sim.audit_events (table_name, record_id, action, performed_by, reason, new_data)
  VALUES ('purchases', v_id, 'INSERT', v_uid, p_reason, jsonb_build_object('amount_total', p_amount_total, 'supplier_id', p_supplier_id));
  RETURN jsonb_build_object('purchase_id', v_id, 'supplier_ledger_id', NULL, 'amount', p_amount_total);
END $$;

CREATE FUNCTION sim.register_purchase_with_fiscal_document(p_supplier_id uuid, p_economic_date date, p_amount_net numeric, p_amount_total numeric,
  p_expense_category_id uuid, p_nature sim.purchase_nature, p_lines jsonb, p_attachments jsonb, p_idempotency_key varchar,
  p_fiscal_document_type sim.fiscal_document_type, p_fiscal_period date, p_fiscal_net_amount numeric, p_fiscal_total_amount numeric,
  p_fiscal_components jsonb, p_subcategory varchar DEFAULT NULL, p_project_id uuid DEFAULT NULL, p_supplier_invoice_number varchar DEFAULT NULL,
  p_flock_id uuid DEFAULT NULL, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE v_uid UUID; v_doc UUID; v_res JSONB;
BEGIN
  v_uid := sim.assert_admin_and_key(p_idempotency_key);
  IF NOT EXISTS (SELECT 1 FROM sim.suppliers WHERE id = p_supplier_id AND activo) THEN RAISE EXCEPTION 'SUPPLIER_NOT_FOUND_OR_INACTIVE'; END IF;
  v_doc := (sim.fiscal_document_insert(p_fiscal_document_type, 'CREDITO', p_economic_date, p_fiscal_period, p_fiscal_net_amount, p_fiscal_total_amount,
            p_supplier_id, p_supplier_invoice_number, NULL, NULL, v_uid) ->> 'fiscal_document_id')::uuid;
  v_res := sim.register_purchase(p_supplier_id := p_supplier_id, p_economic_date := p_economic_date, p_amount_net := p_amount_net,
             p_amount_total := p_amount_total, p_expense_category_id := p_expense_category_id, p_subcategory := p_subcategory, p_nature := p_nature,
             p_idempotency_key := p_idempotency_key, p_fiscal_document_id := v_doc, p_supplier_invoice_number := p_supplier_invoice_number, p_reason := p_reason);
  RETURN v_res || jsonb_build_object('fiscal_document_id', v_doc);
END $$;

CREATE FUNCTION sim.register_fiscal_document(p_document_type sim.fiscal_document_type, p_direction sim.fiscal_direction, p_document_date date,
  p_fiscal_period date, p_net_amount numeric, p_total_amount numeric, p_components jsonb, p_supplier_id uuid DEFAULT NULL, p_cliente_id uuid DEFAULT NULL,
  p_external_number varchar DEFAULT NULL, p_reason text DEFAULT NULL, p_issuer_tax_id varchar DEFAULT NULL, p_issuer_name varchar DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
BEGIN
  IF sim.current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  RETURN sim.fiscal_document_insert(p_document_type, p_direction, p_document_date, p_fiscal_period, p_net_amount, p_total_amount,
                                    p_supplier_id, p_external_number, p_issuer_tax_id, p_issuer_name, auth.uid());
END $$;

-- privileges: nothing in sim is reachable by an API role (the schema is not exposed either)
DO $$
DECLARE f RECORD; t RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'sim'::regnamespace LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f.sig);
  END LOOP;
  FOR t IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'sim'::regnamespace AND c.relkind = 'r' LOOP
    EXECUTE format('ALTER TABLE sim.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('REVOKE ALL ON TABLE sim.%I FROM PUBLIC, anon, authenticated, service_role', t.relname);
  END LOOP;
END $$;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA sim FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON sim.fin_mp_pending_classification FROM PUBLIC, anon, authenticated, service_role;
