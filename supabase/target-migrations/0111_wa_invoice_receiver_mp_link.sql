-- ============================================================================
-- TARGET V1 — 0111 WHATSAPP: FACTURA A (RECEPTOR / CUIT EMISOR) Y GASTOS PAGADOS CON MERCADO PAGO SIN "mp <número>" (owner GO Lote 4, 2026-10-30)
--
-- Nothing here changes the financial architecture: every expense is still recorded by the existing routes (register_casual_purchase /
-- register_pending_expense through wa.dispatch); a Mercado Pago expense is recorded ONLY against its real outflow (ADR-021 route
-- CASUAL_PURCHASE, which releases the provisional): never a second outflow, never a P&L line without its movement.
--   1. Factura A (n8n reads, the database guards). Two new payload markers keep a draft from being confirmed until the user answers:
--        · vat_receiver_pending — Factura A with IVA discriminated whose receiver CUIT could not be identified: the IVA is neither
--          assumed computable nor assumed foreign (WA_RECEIVER_REQUIRED);
--        · issuer_cuit_pending — an invoice whose issuer CUIT could not be read: its fiscal data wait in payload.fiscal_pending (not
--          validated, never recorded) until the user writes the CUIT or says "sin factura" (WA_ISSUER_CUIT_REQUIRED).
--      wa_correct: a casual draft follows its payload (fiscal present ⇄ CASUAL_WITH_INVOICE / CASUAL_EXPENSE), so writing the CUIT
--      turns the same draft into an invoice draft (the 0106 rule paid ⇄ to pay is kept).
--   2. Mercado Pago without its operation number: a draft paid with Mercado Pago is a normal DRAFT (no WAITING_MP, no candidate
--      search). Confirming it records NOTHING in accounting (financial_effect NONE): the confirmation (wa.confirmation, its
--      idempotency key) keeps the explicit "Confirmar" and the result mp_link_pending = true.
--      wa_link_mp_expense (ADMIN, from the ERP, audited, idempotent): links that confirmed draft to a REAL pending Mercado Pago
--      outflow chosen by the user (same amount); only then the expense is recorded — wa.dispatch with that SOURCE_ID and the
--      confirmation's idempotency key, dated on the outflow's business date (the existing rule of a casual Mercado Pago purchase:
--      MP_DATE_MISMATCH) — and the receipt follows the purchase. wa.mp_link (append-only) is the record of the link.
--      wa_mp_link_pending (ADMIN): the confirmed drafts still to link and, for each, the pending outflows of the same amount
--      (only listed; the user picks).
--   Legacy WAITING_MP drafts (created before 0111) keep wa_link_mp.
-- ============================================================================

-- ── 1. payload rules (wrap 0106) ──────────────────────────────────────────────
ALTER FUNCTION wa.validate_payload(TEXT, JSONB) RENAME TO validate_payload_0106;
CREATE FUNCTION wa.validate_payload(p_type TEXT, p_payload JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE p JSONB := p_payload; r JSONB;
BEGIN
  IF jsonb_typeof(p) = 'object' THEN
    IF p ? 'fiscal_pending' THEN
      IF jsonb_typeof(p -> 'fiscal_pending') <> 'object' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: fiscal_pending'; END IF;
      IF jsonb_typeof(p -> 'fiscal') = 'object' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: fiscal and fiscal_pending together'; END IF;
      IF p_type NOT IN ('CASUAL_EXPENSE', 'PENDING_EXPENSE') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: fiscal_pending only on an expense without its invoice yet'; END IF;
    END IF;
    IF (p ? 'issuer_cuit_pending') <> (p ? 'fiscal_pending') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: issuer_cuit_pending goes with fiscal_pending'; END IF;
    IF p ? 'vat_receiver_pending' AND jsonb_typeof(p -> 'fiscal') IS DISTINCT FROM 'object' AND jsonb_typeof(p -> 'fiscal_pending') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'WA_INVALID_PAYLOAD: vat_receiver_pending without fiscal data';
    END IF;
    IF p ? 'vat_receiver_pending' AND jsonb_array_length(coalesce(coalesce(p -> 'fiscal', p -> 'fiscal_pending') -> 'components', '[]'::jsonb)) > 0 THEN
      RAISE EXCEPTION 'WA_INVALID_PAYLOAD: no computable IVA while the receiver is not identified';
    END IF;
    p := p - 'mp_link_pending';
  END IF;
  r := wa.validate_payload_0106(p_type, p);
  -- Mercado Pago without its outflow: an ordinary draft (confirmable; recorded later against the real outflow, from the ERP)
  IF r ->> 'method' = 'MERCADOPAGO' AND NOT r ? 'mp_source_id' THEN
    r := r || jsonb_build_object('needs_mp', false, 'mp_link_pending', true);
  END IF;
  RETURN r;
END $$;

-- ── 2. correction: a casual draft follows its payload (invoice present or not) ─
ALTER FUNCTION public.wa_correct(BIGINT, UUID, INTEGER, JSONB) SET SCHEMA wa;
ALTER FUNCTION wa.wa_correct(BIGINT, UUID, INTEGER, JSONB) RENAME TO correct_0106;
REVOKE ALL ON FUNCTION wa.correct_0106(BIGINT, UUID, INTEGER, JSONB) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.wa_correct(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER, p_payload JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM wa.gate();
  IF jsonb_typeof(p_payload) = 'object' AND NOT coalesce((p_payload ->> 'pending_payment')::boolean, false) THEN
    UPDATE wa.draft SET type = CASE WHEN jsonb_typeof(p_payload -> 'fiscal') = 'object' THEN 'CASUAL_WITH_INVOICE' ELSE 'CASUAL_EXPENSE' END
     WHERE id = p_draft_id AND state IN ('DRAFT', 'FAILED') AND type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE')
       AND type <> CASE WHEN jsonb_typeof(p_payload -> 'fiscal') = 'object' THEN 'CASUAL_WITH_INVOICE' ELSE 'CASUAL_EXPENSE' END;
  END IF;
  RETURN wa.correct_0106(p_inbound_id, p_draft_id, p_expected_version, p_payload);
END $$;

-- ── 3. recording: Mercado Pago without its outflow records nothing at confirmation ─
ALTER FUNCTION wa.dispatch(wa.draft, TEXT) RENAME TO dispatch_0106;
CREATE FUNCTION wa.dispatch(d wa.draft, p_key TEXT) RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF d.type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') AND d.payload ->> 'method' = 'MERCADOPAGO' AND d.payload ->> 'mp_source_id' IS NULL THEN
    RETURN jsonb_build_object('mp_link_pending', true, 'financial_effect', 'NONE', 'amount', (d.payload ->> 'total')::numeric,
                              'status', 'PENDIENTE_VINCULACION_MP');
  END IF;
  RETURN wa.dispatch_0106(d, p_key);
END $$;

-- ── 4. confirmation: nothing pending about the invoice; Mercado Pago confirmed without accounting ─
ALTER FUNCTION public.wa_confirm(BIGINT, UUID, INTEGER) SET SCHEMA wa;
ALTER FUNCTION wa.wa_confirm(BIGINT, UUID, INTEGER) RENAME TO confirm_0106;
REVOKE ALL ON FUNCTION wa.confirm_0106(BIGINT, UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.wa_confirm(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r JSONB;
BEGIN
  PERFORM wa.gate();
  IF EXISTS (SELECT 1 FROM wa.draft d WHERE d.id = p_draft_id AND d.state = 'DRAFT' AND d.payload ? 'vat_receiver_pending') THEN
    RAISE EXCEPTION 'WA_RECEIVER_REQUIRED: say whether the invoice is addressed to Santo Tomás first';
  END IF;
  IF EXISTS (SELECT 1 FROM wa.draft d WHERE d.id = p_draft_id AND d.state = 'DRAFT' AND d.payload ? 'issuer_cuit_pending') THEN
    RAISE EXCEPTION 'WA_ISSUER_CUIT_REQUIRED: write the issuer CUIT or say "sin factura" first';
  END IF;
  r := wa.confirm_0106(p_inbound_id, p_draft_id, p_expected_version);
  IF coalesce((r ->> 'ok')::boolean, false) AND r ->> 'state' = 'CONFIRMED' AND coalesce((r -> 'result' ->> 'mp_link_pending')::boolean, false)
     AND NOT coalesce((r ->> 'replay')::boolean, false) THEN
    PERFORM wa.audit('CONFIRM', 'MP_LINK_PENDING', (SELECT owner_perfil_id FROM wa.draft WHERE id = p_draft_id), p_inbound_id, p_draft_id, p_expected_version,
                     jsonb_build_object('financial_effect', 'NONE'));
  END IF;
  RETURN r || CASE WHEN coalesce((r -> 'result' ->> 'mp_link_pending')::boolean, false) THEN jsonb_build_object('mp_link_pending', true) ELSE '{}'::jsonb END;
END $$;

-- ── 5. the later link, from the ERP ────────────────────────────────────────────
CREATE TABLE wa.mp_link (
  draft_id           UUID PRIMARY KEY REFERENCES wa.draft(id) ON DELETE RESTRICT,
  source_id          VARCHAR(30) NOT NULL UNIQUE CHECK (source_id ~ '^[0-9]{1,20}$'),
  purchase_id        UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  fiscal_document_id UUID,
  expense_date       DATE NOT NULL,   -- the date written in WhatsApp
  economic_date      DATE NOT NULL,   -- the outflow's business date (the date of the recorded purchase)
  reason             TEXT,
  result             JSONB NOT NULL,
  linked_by          UUID NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT,
  linked_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_wa_mp_link_immutable BEFORE UPDATE OR DELETE ON wa.mp_link FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE wa.mp_link ENABLE ROW LEVEL SECURITY;          -- no policy: read only through wa_mp_link_pending / the audit
REVOKE ALL ON TABLE wa.mp_link FROM PUBLIC, anon, authenticated, service_role;

-- the confirmed drafts paid with Mercado Pago and not linked yet; per draft, the pending outflows of the same amount not taken
CREATE FUNCTION public.wa_mp_link_pending() RETURNS TABLE (draft_id UUID, short_code TEXT, concept TEXT, total NUMERIC, expense_date DATE,
  category_name TEXT, account_name TEXT, confirmed_at TIMESTAMPTZ, document_file_id UUID, candidates JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  RETURN QUERY
  SELECT d.id, d.short_code, d.payload ->> 'concept', (d.payload ->> 'total')::numeric, (d.payload ->> 'date')::date,
         (SELECT e.nombre::text FROM expense_category e WHERE e.id = (d.payload ->> 'category_id')::uuid),
         (SELECT a.nombre::text FROM financial_account a WHERE a.id = (d.payload ->> 'account_id')::uuid),
         c.confirmed_at, nullif(d.payload ->> 'document_file_id', '')::uuid,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('source_id', v.source_id, 'date', v.business_date, 'amount', v.economic_amount)
                                    ORDER BY abs(v.business_date - (d.payload ->> 'date')::date), v.source_id), '[]'::jsonb)
            FROM fin_mp_pending_classification v
           WHERE v.direction = 'OUT' AND v.status = 'PENDING' AND v.economic_amount = (d.payload ->> 'total')::numeric
             AND NOT EXISTS (SELECT 1 FROM wa.mp_link l WHERE l.source_id = v.source_id::text)
             AND NOT EXISTS (SELECT 1 FROM wa.draft x WHERE x.payload ->> 'mp_source_id' = v.source_id::text
                              AND x.state IN ('DRAFT', 'WAITING_MP', 'CONFIRMING', 'CONFIRMED')))
    FROM wa.draft d JOIN wa.confirmation c ON c.draft_id = d.id
   WHERE d.state = 'CONFIRMED' AND coalesce((c.result ->> 'mp_link_pending')::boolean, false)
     AND NOT EXISTS (SELECT 1 FROM wa.mp_link l WHERE l.draft_id = d.id)
   ORDER BY c.confirmed_at;
END $$;

CREATE FUNCTION public.wa_link_mp_expense(p_draft_id UUID, p_source_id TEXT, p_reason TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid UUID := auth.uid(); d wa.draft; c wa.confirmation; l wa.mp_link; v RECORD; v_res JSONB; v_out JSONB; f document_file; v_written DATE;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF coalesce(p_source_id, '') !~ '^[0-9]{1,20}$' THEN RAISE EXCEPTION 'WA_INVALID_SOURCE_ID: a Mercado Pago operation number is required'; END IF;
  SELECT * INTO d FROM wa.draft WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WA_DRAFT_NOT_FOUND'; END IF;
  -- replay / conflict
  SELECT * INTO l FROM wa.mp_link WHERE draft_id = d.id;
  IF FOUND THEN
    IF l.source_id = p_source_id THEN RETURN l.result || jsonb_build_object('replayed', true); END IF;
    RAISE EXCEPTION 'WA_MP_ALREADY_LINKED: % is linked to operation %', d.short_code, l.source_id;
  END IF;
  SELECT * INTO c FROM wa.confirmation WHERE draft_id = d.id;
  IF d.state <> 'CONFIRMED' OR NOT FOUND OR NOT coalesce((c.result ->> 'mp_link_pending')::boolean, false) THEN
    RAISE EXCEPTION 'WA_NOT_MP_LINK_PENDING: % is not a confirmed expense waiting for its Mercado Pago movement', d.short_code;
  END IF;
  IF EXISTS (SELECT 1 FROM wa.mp_link x WHERE x.source_id = p_source_id)
     OR EXISTS (SELECT 1 FROM wa.draft x WHERE x.payload ->> 'mp_source_id' = p_source_id AND x.state IN ('DRAFT', 'WAITING_MP', 'CONFIRMING', 'CONFIRMED')) THEN
    RAISE EXCEPTION 'WA_MP_OUTFLOW_TAKEN: operation % already belongs to another WhatsApp expense', p_source_id;
  END IF;
  SELECT x.source_id, x.business_date, x.economic_amount INTO v FROM fin_mp_pending_classification x
   WHERE x.source_id::text = p_source_id AND x.direction = 'OUT' AND x.status = 'PENDING';
  IF NOT FOUND THEN RAISE EXCEPTION 'WA_MP_OUTFLOW_NOT_MATCHING: operation % is not a pending Mercado Pago outflow', p_source_id; END IF;
  IF v.economic_amount <> (d.payload ->> 'total')::numeric THEN
    RAISE EXCEPTION 'WA_MP_AMOUNT_MISMATCH: the outflow is % and the expense %', v.economic_amount, d.payload ->> 'total';
  END IF;
  -- the SAME expense, now against its real outflow: the existing route (register_casual_purchase releases the provisional), the
  -- confirmation's idempotency key, dated on the outflow (the rule of a casual Mercado Pago purchase)
  v_written := (d.payload ->> 'date')::date;
  d.payload := d.payload || jsonb_build_object('mp_source_id', p_source_id, 'date', v.business_date);
  v_res := wa.dispatch(d, c.idempotency_key);
  IF nullif(v_res ->> 'purchase_id', '') IS NULL THEN RAISE EXCEPTION 'WA_LINK_NOT_RECORDED: %', v_res; END IF;
  v_out := jsonb_build_object('replayed', false, 'draft_id', d.id, 'short_code', d.short_code, 'source_id', p_source_id,
                              'purchase_id', v_res ->> 'purchase_id', 'fiscal_document_id', v_res ->> 'fiscal_document_id',
                              'expense_date', v_written, 'economic_date', v.business_date, 'amount', v.economic_amount,
                              'financial_effect', 'EXISTING_MP_OUTFLOW');
  INSERT INTO wa.mp_link (draft_id, source_id, purchase_id, fiscal_document_id, expense_date, economic_date, reason, result, linked_by)
  VALUES (d.id, p_source_id, (v_res ->> 'purchase_id')::uuid, nullif(v_res ->> 'fiscal_document_id', '')::uuid,
          v_written, v.business_date, nullif(trim(coalesce(p_reason, '')), ''), v_out, v_uid);
  -- the receipt follows the recorded purchase (as at a normal confirmation)
  SELECT * INTO f FROM document_file WHERE id = nullif(d.payload ->> 'document_file_id', '')::uuid;
  IF FOUND THEN
    INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size, uploaded_by)
    VALUES ((v_res ->> 'purchase_id')::uuid, f.storage_path, f.file_name, f.content_type, f.byte_size, v_uid) ON CONFLICT (purchase_id, storage_path) DO NOTHING;
    INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by) VALUES (f.id, 'PURCHASE', v_res ->> 'purchase_id', v_uid) ON CONFLICT DO NOTHING;
    IF nullif(v_res ->> 'fiscal_document_id', '') IS NOT NULL THEN
      INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by) VALUES (f.id, 'FISCAL_DOCUMENT', v_res ->> 'fiscal_document_id', v_uid) ON CONFLICT DO NOTHING;
    END IF;
    INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by) VALUES (f.id, 'MP_PENDING_OUTFLOW', p_source_id, v_uid) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM wa.audit('LINK_MP_ERP', 'LINKED', v_uid, NULL, d.id, d.version, v_out);
  RETURN v_out;
END $$;

-- ── privileges ─────────────────────────────────────────────────────────────────
DO $p$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT unnest(ARRAY['public.wa_correct(bigint,uuid,integer,jsonb)', 'public.wa_confirm(bigint,uuid,integer)',
                               'public.wa_mp_link_pending()', 'public.wa_link_mp_expense(uuid,text,text)']::regprocedure[]) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
  FOR f IN SELECT unnest(ARRAY['wa.validate_payload(text,jsonb)', 'wa.validate_payload_0106(text,jsonb)', 'wa.dispatch(wa.draft,text)',
                               'wa.dispatch_0106(wa.draft,text)']::regprocedure[]) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $p$;
