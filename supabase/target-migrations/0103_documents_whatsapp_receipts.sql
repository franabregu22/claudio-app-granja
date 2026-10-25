-- ============================================================================
-- TARGET V1 — 0103 DOCUMENTS + WHATSAPP RECEIPTS (ADR-025 stage 4, owner GO 2026-10-25)
--
-- One stored original file per document (photo / PDF of an invoice, ticket, cheque), linked to what it supports. No accounting
-- table changes: the expense, the fiscal document, the payment and the reconciliation keep their existing functions.
--   1. document_file (immutable; the AI reading `extraction` may be set ONCE) + document_link (append-only): one file, many
--      targets (PURCHASE, EXPENSE_PENDING, MP_PENDING_OUTFLOW, FISCAL_DOCUMENT, FINANCIAL_INSTRUMENT) — never a copy.
--      Readable by ADMIN only; written only by SECURITY DEFINER functions.
--   2. Storage bucket `wa-media` (private, 10 MB, PDF / JPEG / PNG / WebP): the WhatsApp gateway uploads under wa/<sha256>.<ext>
--      while the bot is ENABLED; ADMIN reads (signed URLs). Helpers never raise for a profile-less caller.
--   3. WhatsApp: the caption / MIME / Meta digest of a photo or PDF are kept (wa_ingest wrapper); public.wa_store_media
--      registers the uploaded original (dedupe by sha256); a draft references it by `document_file_id` (set by the gateway,
--      validated here) — client-supplied `attachments` / `lines` are dropped; `concept_pending` (a receipt without a concept)
--      is never confirmable (WA_CONCEPT_REQUIRED); a CASUAL_WITH_INVOICE fiscal total must equal the expense total.
--   4. On confirmation (trigger on wa.draft) the file is linked to the recorded purchase (+ purchase_attachment, same path),
--      fiscal document, unclassified expense or existing Mercado Pago outflow; the AI reading is stored once. Classifying an
--      unclassified expense later carries its file to the new purchase.
--   5. Mercado Pago: wa_propose / wa_correct add `mp_candidates` (pending outflows with the same amount and date — the rule
--      wa_link_mp applies — not used by another draft) to a WAITING_MP result: the user picks; wa_link_mp re-validates.
--      Never a second outflow. A receipt already used by another draft is refused (WA_DOCUMENT_ALREADY_USED).
-- The 0102 functions are wrapped, not rewritten: wa.validate_payload_0102, wa.ingest_0102, wa.propose_0102, wa.correct_0102,
-- wa.confirm_0102 keep their bodies (moved out of the API schema). The bot stays OFF while wa.config.enabled = false.
-- ============================================================================

-- ── 1. documents ─────────────────────────────────────────────────────────────
CREATE TABLE document_file (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_bucket TEXT NOT NULL CHECK (storage_bucket IN ('wa-media', 'purchase-attachments')),
  storage_path   TEXT NOT NULL CHECK (length(storage_path) BETWEEN 5 AND 300),
  sha256         CHAR(64) NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type   VARCHAR(100) NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  byte_size      BIGINT NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  file_name      VARCHAR(255) NOT NULL,
  origin         TEXT NOT NULL CHECK (origin IN ('WHATSAPP', 'ERP')),
  origin_ref     JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by    UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  extraction     JSONB,                 -- the AI reading (reference only, never authority); set once
  extracted_at   TIMESTAMPTZ,
  UNIQUE (storage_bucket, storage_path),
  CONSTRAINT chk_document_wa_path CHECK (storage_bucket <> 'wa-media' OR storage_path ~ '^wa/[0-9a-f]{64}\.(pdf|jpg|png|webp)$'),
  CONSTRAINT chk_document_extraction CHECK ((extraction IS NULL) = (extracted_at IS NULL))
);
CREATE TABLE document_link (
  id               BIGSERIAL PRIMARY KEY,
  document_file_id UUID NOT NULL REFERENCES document_file(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  target_kind      TEXT NOT NULL CHECK (target_kind IN ('PURCHASE', 'EXPENSE_PENDING', 'MP_PENDING_OUTFLOW', 'FISCAL_DOCUMENT', 'FINANCIAL_INSTRUMENT')),
  target_id        TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 100),
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_by        UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE (document_file_id, target_kind, target_id)
);
CREATE INDEX idx_document_link_target ON document_link(target_kind, target_id);

-- immutable: only the one-time AI reading may be added to a document_file
CREATE FUNCTION document_file_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE: document_file rows are never deleted'; END IF;
  IF OLD.extraction IS NULL AND NEW.extraction IS NOT NULL
     AND (to_jsonb(NEW) - 'extraction' - 'extracted_at') = (to_jsonb(OLD) - 'extraction' - 'extracted_at') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'IMMUTABLE_EVIDENCE: document_file rows are immutable (the AI reading is set once)';
END $$;
ALTER FUNCTION document_file_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION document_file_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_document_file_guard BEFORE UPDATE OR DELETE ON document_file FOR EACH ROW EXECUTE FUNCTION document_file_guard();
CREATE TRIGGER trg_document_link_immutable BEFORE UPDATE OR DELETE ON document_link FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();

ALTER TABLE document_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_link ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE document_file, document_link FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE document_link_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE document_file, document_link TO authenticated;
CREATE POLICY document_file_admin_select ON document_file FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY document_link_admin_select ON document_link FOR SELECT USING (current_app_role() = 'ADMIN');

-- the ERP read model: one row per (file, target) — what the screens open with a signed URL
CREATE VIEW fin_document_links WITH (security_invoker = true) AS
  SELECT l.target_kind, l.target_id, f.id AS document_file_id, f.storage_bucket, f.storage_path, f.file_name, f.content_type, f.byte_size,
         f.origin, f.origin_ref, f.received_at, f.received_by, l.linked_at,
         f.extraction ->> 'document_type' AS read_document_type, f.extraction ->> 'number' AS read_number,
         f.extraction ->> 'issuer_name' AS read_issuer_name, f.extraction ->> 'issuer_cuit' AS read_issuer_cuit
    FROM document_link l JOIN document_file f ON f.id = l.document_file_id;
ALTER VIEW fin_document_links OWNER TO postgres;
REVOKE ALL ON fin_document_links FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON fin_document_links TO authenticated;

-- ── 2. storage: private bucket wa-media ─────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('wa-media', 'wa-media', false, 10485760, ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

-- never raise for a caller without an ERP profile (the gateway has none); EXECUTE for authenticated only
CREATE FUNCTION public.wa_media_writer() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM wa.config c WHERE c.singleton AND c.enabled AND c.gateway_user_id = auth.uid());
$$;
CREATE FUNCTION public.wa_media_reader() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.wa_media_writer()
      OR EXISTS (SELECT 1 FROM perfiles p WHERE p.id = auth.uid() AND p.activo AND p.rol_type::text = 'ADMIN');
$$;
ALTER FUNCTION public.wa_media_writer() OWNER TO postgres;
ALTER FUNCTION public.wa_media_reader() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_media_writer(), public.wa_media_reader() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.wa_media_writer(), public.wa_media_reader() TO authenticated;

CREATE POLICY wa_media_gateway_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (CASE WHEN bucket_id = 'wa-media' THEN public.wa_media_writer() AND name ~ '^wa/[0-9a-f]{64}\.(pdf|jpg|png|webp)$' ELSE false END);
CREATE POLICY wa_media_read ON storage.objects FOR SELECT TO authenticated
  USING (CASE WHEN bucket_id = 'wa-media' THEN public.wa_media_reader() ELSE false END);

-- ── 3. WhatsApp: media metadata, store, payload rules ─────────────────────
ALTER TABLE wa.inbound_message ADD COLUMN caption TEXT, ADD COLUMN media_mime TEXT, ADD COLUMN media_file_name TEXT;

-- one live draft per receipt file (as one per Mercado Pago SOURCE_ID)
CREATE UNIQUE INDEX wa_draft_document_once ON wa.draft ((payload ->> 'document_file_id'))
  WHERE payload ? 'document_file_id' AND state IN ('DRAFT', 'WAITING_MP', 'CONFIRMING', 'CONFIRMED');

-- 3a. ingest: the 0102 function (Meta HMAC, one row per message) + caption / MIME / file name of a photo or PDF
ALTER FUNCTION public.wa_ingest(TEXT, TEXT) SET SCHEMA wa;
ALTER FUNCTION wa.wa_ingest(TEXT, TEXT) RENAME TO ingest_0102;
REVOKE ALL ON FUNCTION wa.ingest_0102(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.wa_ingest(p_raw_b64 TEXT, p_signature TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r JSONB := wa.ingest_0102(p_raw_b64, p_signature); v_body JSONB; m JSONB; v_out JSONB := '[]'::jsonb; x JSONB; im wa.inbound_message;
BEGIN
  IF r ->> 'ok' IS DISTINCT FROM 'true' THEN RETURN r; END IF;   -- refused before anything was stored: unchanged
  v_body := convert_from(decode(p_raw_b64, 'base64'), 'UTF8')::jsonb;   -- already verified by the HMAC above
  FOR m IN SELECT msg FROM jsonb_array_elements(coalesce(v_body -> 'entry', '[]'::jsonb)) e,
                          jsonb_array_elements(coalesce(e -> 'changes', '[]'::jsonb)) ch,
                          jsonb_array_elements(coalesce(ch -> 'value' -> 'messages', '[]'::jsonb)) msg LOOP
    IF m ->> 'type' IN ('image', 'document') THEN
      UPDATE wa.inbound_message SET caption = left(coalesce(m -> 'image' ->> 'caption', m -> 'document' ->> 'caption'), 1000),
             media_mime = left(coalesce(m -> 'image' ->> 'mime_type', m -> 'document' ->> 'mime_type'), 100),
             media_file_name = left(m -> 'document' ->> 'filename', 200)
       WHERE wamid = m ->> 'id' AND caption IS NULL AND media_mime IS NULL;
    END IF;
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(r -> 'messages', '[]'::jsonb)) LOOP
    SELECT * INTO im FROM wa.inbound_message WHERE id = (x ->> 'inbound_id')::bigint;
    v_out := v_out || jsonb_build_array(x || CASE WHEN im.media_mime IS NOT NULL OR im.caption IS NOT NULL
      THEN jsonb_build_object('caption', im.caption, 'media_mime', im.media_mime, 'media_file_name', im.media_file_name) ELSE '{}'::jsonb END);
  END LOOP;
  RETURN r || jsonb_build_object('messages', v_out);
END $$;

-- 3b. the gateway registers the original it uploaded to wa-media (dedupe: the same bytes are ONE document)
CREATE FUNCTION public.wa_store_media(p_inbound_id BIGINT, p_sha256 TEXT, p_content_type TEXT, p_byte_size BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE im wa.inbound_message; v_ext TEXT; v_path TEXT; v_id UUID; v_dup BOOLEAN := false; v_links JSONB; v_live TEXT;
BEGIN
  PERFORM wa.gate();
  SELECT * INTO im FROM wa.inbound_message WHERE id = p_inbound_id;
  IF NOT FOUND OR im.outcome <> 'ACCEPTED' OR im.kind NOT IN ('image', 'document') OR im.media_id IS NULL THEN
    RAISE EXCEPTION 'WA_MEDIA_NOT_ACCEPTED: inbound % is not an accepted photo / PDF', p_inbound_id;
  END IF;
  IF coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'WA_INVALID_MEDIA: sha256'; END IF;
  v_ext := CASE p_content_type WHEN 'application/pdf' THEN 'pdf' WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp' END;
  IF v_ext IS NULL THEN RAISE EXCEPTION 'WA_INVALID_MEDIA: only PDF, JPEG, PNG or WebP'; END IF;
  IF p_byte_size IS NULL OR p_byte_size NOT BETWEEN 1 AND 10485760 THEN RAISE EXCEPTION 'WA_INVALID_MEDIA: 1 byte – 10 MB'; END IF;
  v_path := 'wa/' || p_sha256 || '.' || v_ext;
  INSERT INTO document_file (storage_bucket, storage_path, sha256, content_type, byte_size, file_name, origin, origin_ref, received_by)
  VALUES ('wa-media', v_path, p_sha256, p_content_type, p_byte_size, coalesce(nullif(im.media_file_name, ''), 'whatsapp-' || p_inbound_id || '.' || v_ext),
          'WHATSAPP', jsonb_build_object('inbound_id', im.id, 'wamid', im.wamid), im.sender_perfil_id)
  ON CONFLICT (sha256) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN v_dup := true; SELECT id INTO v_id FROM document_file WHERE sha256 = p_sha256; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('target_kind', l.target_kind) ORDER BY l.id), '[]'::jsonb) INTO v_links FROM document_link l WHERE l.document_file_id = v_id;
  SELECT d.short_code INTO v_live FROM wa.draft d WHERE d.payload ->> 'document_file_id' = v_id::text
     AND d.state IN ('DRAFT', 'WAITING_MP', 'CONFIRMING', 'CONFIRMED') ORDER BY d.created_at DESC LIMIT 1;
  PERFORM wa.audit('STORE_MEDIA', CASE WHEN v_dup THEN 'DUPLICATE' ELSE 'STORED' END, im.sender_perfil_id, p_inbound_id, NULL, NULL,
                   jsonb_build_object('content_type', p_content_type, 'byte_size', p_byte_size));
  RETURN jsonb_build_object('ok', true, 'document_file_id', v_id, 'storage_path', v_path, 'duplicate', v_dup, 'links', v_links, 'draft_short_code', v_live);
END $$;

-- 3c. payload rules (wraps the 0102 validator; its rules are unchanged)
ALTER FUNCTION wa.validate_payload(TEXT, JSONB) RENAME TO validate_payload_0102;
CREATE FUNCTION wa.validate_payload(p_type TEXT, p_payload JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE p JSONB := p_payload; v_doc UUID; v_pending BOOLEAN; r JSONB;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN wa.validate_payload_0102(p_type, p); END IF;
  p := p - 'attachments' - 'lines';    -- files and lines are NEVER taken from the interpreter: the gateway sets document_file_id
  IF p ? 'document_file_id' THEN
    IF coalesce(p ->> 'document_file_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: document_file_id'; END IF;
    v_doc := (p ->> 'document_file_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM document_file f WHERE f.id = v_doc AND f.origin = 'WHATSAPP') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: unknown receipt file'; END IF;
  END IF;
  IF p ? 'receipt' AND (jsonb_typeof(p -> 'receipt') <> 'object' OR length((p -> 'receipt')::text) > 8000) THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: receipt'; END IF;
  IF p_type = 'CASUAL_WITH_INVOICE' AND jsonb_typeof(p -> 'fiscal') = 'object' AND (p -> 'fiscal' ->> 'total_amount')::numeric IS DISTINCT FROM (p ->> 'total')::numeric THEN
    RAISE EXCEPTION 'WA_INVALID_PAYLOAD: the invoice total differs from the expense total';
  END IF;
  -- a receipt without a concept: every other datum is kept, the draft can not be confirmed until the concept is told
  v_pending := coalesce(btrim(p ->> 'concept'), '') = '' AND coalesce((p ->> 'concept_pending')::boolean, false) AND p_type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE');
  IF v_pending THEN
    r := wa.validate_payload_0102(p_type, p || jsonb_build_object('concept', 'pendiente'));
    RETURN (r - 'concept') || jsonb_build_object('concept_pending', true);
  END IF;
  RETURN wa.validate_payload_0102(p_type, p - 'concept_pending');
END $$;

-- ── 4. confirmation: the file follows what was recorded ────────────────────
CREATE FUNCTION wa.link_confirmed_document() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE f document_file; r JSONB := NEW.result; v_purchase UUID;
BEGIN
  SELECT * INTO f FROM document_file WHERE id = (NEW.payload ->> 'document_file_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: unknown receipt file'; END IF;
  IF f.received_by IS DISTINCT FROM NEW.owner_perfil_id THEN RAISE EXCEPTION 'WA_DOCUMENT_NOT_OWNED: the receipt was sent by another user'; END IF;
  v_purchase := nullif(r ->> 'purchase_id', '')::uuid;
  IF v_purchase IS NOT NULL THEN
    INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size, uploaded_by)
    VALUES (v_purchase, f.storage_path, f.file_name, f.content_type, f.byte_size, NEW.owner_perfil_id) ON CONFLICT (purchase_id, storage_path) DO NOTHING;
    INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by) VALUES (f.id, 'PURCHASE', v_purchase::text, NEW.owner_perfil_id) ON CONFLICT DO NOTHING;
  END IF;
  IF nullif(r ->> 'fiscal_document_id', '') IS NOT NULL THEN
    INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by) VALUES (f.id, 'FISCAL_DOCUMENT', r ->> 'fiscal_document_id', NEW.owner_perfil_id) ON CONFLICT DO NOTHING;
  END IF;
  IF nullif(r ->> 'pending_id', '') IS NOT NULL THEN
    INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by) VALUES (f.id, 'EXPENSE_PENDING', r ->> 'pending_id', NEW.owner_perfil_id) ON CONFLICT DO NOTHING;
  END IF;
  IF coalesce(r ->> 'mp_source_id', NEW.payload ->> 'mp_source_id') IS NOT NULL THEN
    INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by)
    VALUES (f.id, 'MP_PENDING_OUTFLOW', coalesce(r ->> 'mp_source_id', NEW.payload ->> 'mp_source_id'), NEW.owner_perfil_id) ON CONFLICT DO NOTHING;
  END IF;
  IF f.extraction IS NULL AND jsonb_typeof(NEW.payload -> 'receipt') = 'object' THEN
    UPDATE document_file SET extraction = NEW.payload -> 'receipt', extracted_at = now() WHERE id = f.id;
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION wa.link_confirmed_document() OWNER TO postgres;
REVOKE ALL ON FUNCTION wa.link_confirmed_document() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_wa_draft_document_confirmed AFTER UPDATE OF state ON wa.draft FOR EACH ROW
  WHEN (NEW.state = 'CONFIRMED' AND OLD.state IS DISTINCT FROM 'CONFIRMED' AND NEW.payload ? 'document_file_id')
  EXECUTE FUNCTION wa.link_confirmed_document();

-- classifying an unclassified expense later: its file follows to the new purchase (same object, no copy)
CREATE FUNCTION expense_pending_document_carry() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size, uploaded_by)
  SELECT NEW.purchase_id, f.storage_path, f.file_name, f.content_type, f.byte_size, NEW.resolved_by
    FROM document_link l JOIN document_file f ON f.id = l.document_file_id
   WHERE l.target_kind = 'EXPENSE_PENDING' AND l.target_id = NEW.pending_id::text
  ON CONFLICT (purchase_id, storage_path) DO NOTHING;
  INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by)
  SELECT l.document_file_id, 'PURCHASE', NEW.purchase_id::text, NEW.resolved_by FROM document_link l
   WHERE l.target_kind = 'EXPENSE_PENDING' AND l.target_id = NEW.pending_id::text
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
ALTER FUNCTION expense_pending_document_carry() OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_pending_document_carry() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_expense_pending_document_carry AFTER INSERT ON expense_pending_resolution FOR EACH ROW EXECUTE FUNCTION expense_pending_document_carry();

-- confirmation wrapper: a concept is required (everything else unchanged, 0102 body)
ALTER FUNCTION public.wa_confirm(BIGINT, UUID, INTEGER) SET SCHEMA wa;
ALTER FUNCTION wa.wa_confirm(BIGINT, UUID, INTEGER) RENAME TO confirm_0102;
REVOKE ALL ON FUNCTION wa.confirm_0102(BIGINT, UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.wa_confirm(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM wa.gate();
  IF EXISTS (SELECT 1 FROM wa.draft d WHERE d.id = p_draft_id AND d.state = 'DRAFT' AND d.payload ? 'concept_pending') THEN
    RAISE EXCEPTION 'WA_CONCEPT_REQUIRED: tell the concept of the expense first';
  END IF;
  RETURN wa.confirm_0102(p_inbound_id, p_draft_id, p_expected_version);
END $$;

-- ── 5. Mercado Pago candidates for a draft waiting for its outflow ─────────
CREATE FUNCTION wa.mp_candidates(p_owner UUID, p_total NUMERIC, p_date DATE, p_draft UUID) RETURNS JSONB
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_old_sub TEXT := current_setting('request.jwt.claim.sub', true); v_old_claims TEXT := current_setting('request.jwt.claims', true); v JSONB;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_owner::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_owner, 'role', 'authenticated')::text, true);
  IF auth.uid() IS DISTINCT FROM p_owner OR current_app_role() <> 'ADMIN' THEN RAISE EXCEPTION 'WA_DELEGATION_MISMATCH'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('source_id', x.source_id, 'amount', x.economic_amount, 'date', x.business_date) ORDER BY x.source_id), '[]'::jsonb)
    INTO v FROM (SELECT v.source_id::text AS source_id, v.economic_amount, v.business_date FROM fin_mp_pending_classification v
                  WHERE v.direction = 'OUT' AND v.status = 'PENDING' AND v.economic_amount = p_total AND v.business_date = p_date
                    AND NOT EXISTS (SELECT 1 FROM wa.draft d WHERE d.payload ->> 'mp_source_id' = v.source_id::text AND d.id <> p_draft
                                     AND d.state IN ('DRAFT', 'WAITING_MP', 'CONFIRMING', 'CONFIRMED'))
                  ORDER BY v.source_id LIMIT 3) x;
  PERFORM set_config('request.jwt.claim.sub', coalesce(v_old_sub, ''), true);
  PERFORM set_config('request.jwt.claims', coalesce(v_old_claims, ''), true);
  RETURN v;
END $$;
CREATE FUNCTION wa.with_mp_candidates(r JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE d wa.draft;
BEGIN
  IF r ->> 'state' IS DISTINCT FROM 'WAITING_MP' OR r ? 'mp_candidates' THEN RETURN r; END IF;
  SELECT * INTO d FROM wa.draft WHERE id = (r ->> 'draft_id')::uuid;
  IF NOT FOUND THEN RETURN r; END IF;
  RETURN r || jsonb_build_object('mp_candidates', wa.mp_candidates(d.owner_perfil_id, (d.payload ->> 'total')::numeric, (d.payload ->> 'date')::date, d.id));
END $$;
ALTER FUNCTION public.wa_propose(BIGINT, TEXT, JSONB) SET SCHEMA wa;
ALTER FUNCTION wa.wa_propose(BIGINT, TEXT, JSONB) RENAME TO propose_0102;
ALTER FUNCTION public.wa_correct(BIGINT, UUID, INTEGER, JSONB) SET SCHEMA wa;
ALTER FUNCTION wa.wa_correct(BIGINT, UUID, INTEGER, JSONB) RENAME TO correct_0102;
REVOKE ALL ON FUNCTION wa.propose_0102(BIGINT, TEXT, JSONB), wa.correct_0102(BIGINT, UUID, INTEGER, JSONB) FROM PUBLIC, anon, authenticated, service_role;
-- a receipt file drives at most one live / confirmed draft (the unique index wa_draft_document_once is the backstop)
CREATE FUNCTION wa.document_in_use(p_payload JSONB, p_except UUID) RETURNS VOID LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v TEXT;
BEGIN
  IF jsonb_typeof(p_payload) = 'object' AND p_payload ? 'document_file_id' THEN
    SELECT d.short_code INTO v FROM wa.draft d WHERE d.payload ->> 'document_file_id' = p_payload ->> 'document_file_id'
       AND d.id IS DISTINCT FROM p_except AND d.state IN ('DRAFT', 'WAITING_MP', 'CONFIRMING', 'CONFIRMED') LIMIT 1;
    IF v IS NOT NULL THEN RAISE EXCEPTION 'WA_DOCUMENT_ALREADY_USED: %', v; END IF;
  END IF;
END $$;
CREATE FUNCTION public.wa_propose(p_inbound_id BIGINT, p_type TEXT, p_payload JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM wa.gate();
  PERFORM wa.document_in_use(p_payload, NULL);
  RETURN wa.with_mp_candidates(wa.propose_0102(p_inbound_id, p_type, p_payload));
END $$;
CREATE FUNCTION public.wa_correct(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER, p_payload JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM wa.gate();
  PERFORM wa.document_in_use(p_payload, p_draft_id);
  RETURN wa.with_mp_candidates(wa.correct_0102(p_inbound_id, p_draft_id, p_expected_version, p_payload));
END $$;

-- ── privileges: the API entry points as in 0102 (DEFINER, owner postgres, EXECUTE authenticated only) ──
ALTER FUNCTION public.wa_ingest(TEXT, TEXT) OWNER TO postgres;
ALTER FUNCTION public.wa_store_media(BIGINT, TEXT, TEXT, BIGINT) OWNER TO postgres;
ALTER FUNCTION public.wa_confirm(BIGINT, UUID, INTEGER) OWNER TO postgres;
ALTER FUNCTION public.wa_propose(BIGINT, TEXT, JSONB) OWNER TO postgres;
ALTER FUNCTION public.wa_correct(BIGINT, UUID, INTEGER, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_ingest(TEXT, TEXT), public.wa_store_media(BIGINT, TEXT, TEXT, BIGINT), public.wa_confirm(BIGINT, UUID, INTEGER),
  public.wa_propose(BIGINT, TEXT, JSONB), public.wa_correct(BIGINT, UUID, INTEGER, JSONB) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.wa_ingest(TEXT, TEXT), public.wa_store_media(BIGINT, TEXT, TEXT, BIGINT), public.wa_confirm(BIGINT, UUID, INTEGER),
  public.wa_propose(BIGINT, TEXT, JSONB), public.wa_correct(BIGINT, UUID, INTEGER, JSONB) TO authenticated;
DO $p$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'wa'::regnamespace AND p.proname IN
           ('validate_payload', 'validate_payload_0102', 'link_confirmed_document', 'mp_candidates', 'with_mp_candidates', 'document_in_use') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $p$;
