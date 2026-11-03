-- ============================================================================
-- TARGET V1 — 0114 CARGOS BANCARIOS DESDE EL EXTRACTO (ADR-018 §23, owner GO BNA fase 2, 2026-11-03)
--
-- A bank statement line that is a bank charge (the debits / credits tax, a fee, an eCheq charge, the IVA on fees) is recognised by
-- its description and proposed; nothing is recorded until an ADMIN confirms. Confirming several lines is one transaction, and each
-- line keeps its own financial operation, posting and 1:1 match — the import itself still never creates money (ADR-018 §2.2).
--   1. fin_statement_charge_rule — recognition rules per statement FORMAT (each bank writes its own descriptions): an anchored
--      case-insensitive pattern on description_norm, the kind (BANK_TAX_DEBCRED / BANK_FEE / BANK_IVA), a label and, for a fee, the
--      expense category. Data, not code: a bank is added with rows. Read by ADMIN; written only by migrations.
--   2. fin_statement_charge_booking — one row per booked line (its primary key: a line is booked once, ever), with the rule, the
--      operation, the posting, the match, the purchase of a fee and the batch key. Immutable (fin_evidence_immutable_guard).
--   3. fin_statement_line_cut_class / fin_statement_charge_proposal (internal): the cut classification of 0076 for one line, and
--      what a line is: PROPOSED (one rule kind), NO_RULE, AMBIGUOUS (rules of different kinds), CREDIT (a charge is a debit),
--      CATEGORY_MISSING (a fee rule without an active category), MATCHED / BOOKED / NOT_POST_CUTOVER.
--   4. fin_statement_charge_proposals(account) (ADMIN, STABLE): every post-cut line of the account still unmatched and unbooked,
--      with its proposal or the reason it needs review. Cheques, fiscal instalments, transfers and unknown concepts have no rule.
--   5. fin_book_statement_charges(account, items, key) (ADMIN): items [{statement_line_id, kind}], 1…100, the kind the user saw.
--      Each line is locked and must still be PROPOSED with that kind (else PROPOSAL_CHANGED: nothing is booked). Then:
--        BANK_TAX_DEBCRED → register_bank_tax (DEBITOS_CREDITOS; ADR-011: never in the P&L, never an extra expense)
--        BANK_IVA        → a BANK_TAX operation with bank_tax_charge.tax_kind IVA: its own fiscal category, not an expense and not
--                          a computable fiscal credit (no fiscal_document is written)
--        BANK_FEE        → register_casual_purchase paid from the account (one expense, in its category, in the P&L)
--      and fin_match_statement_line pairs the line with that posting. Idempotent: the same key and lines replay the result; a key
--      used for other lines is refused; a line is booked once (primary key). Atomic: any failure books nothing. Closed periods are
--      refused by the reused functions.
-- No existing row, table or function changes. SECURITY DEFINER set +2.
-- ============================================================================

CREATE TABLE fin_statement_charge_rule (
  id                  BIGSERIAL PRIMARY KEY,
  format_code         VARCHAR(40)  NOT NULL,
  pattern             TEXT         NOT NULL,
  kind                VARCHAR(20)  NOT NULL,
  label               VARCHAR(80)  NOT NULL,
  expense_category_id UUID         REFERENCES expense_category(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  activo              BOOLEAN      NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_fscr_kind    CHECK (kind IN ('BANK_TAX_DEBCRED', 'BANK_FEE', 'BANK_IVA')),
  CONSTRAINT chk_fscr_pattern CHECK (left(pattern, 1) = '^' AND right(pattern, 1) = '$'),
  CONSTRAINT chk_fscr_label   CHECK (btrim(label) <> ''),
  CONSTRAINT chk_fscr_fee_cat CHECK (kind = 'BANK_FEE' OR expense_category_id IS NULL),
  UNIQUE (format_code, pattern)
);
ALTER TABLE fin_statement_charge_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_statement_charge_rule OWNER TO postgres;
REVOKE ALL ON TABLE fin_statement_charge_rule FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE fin_statement_charge_rule_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE fin_statement_charge_rule TO authenticated;
CREATE POLICY fin_statement_charge_rule_admin_select ON fin_statement_charge_rule FOR SELECT USING (current_app_role() = 'ADMIN');

-- the descriptions seen on the real statements (2026-11-03); an anchored pattern never matches a longer, different concept
INSERT INTO fin_statement_charge_rule (format_code, pattern, kind, label, expense_category_id) VALUES
  ('BNA_MONTHLY_PDF_V1', '^GRAVAMEN LEY 25413 S/(DEB|CRED)$', 'BANK_TAX_DEBCRED', 'Impuesto Débitos/Créditos (Ley 25.413)', NULL),
  ('BNA_MONTHLY_PDF_V1', '^COMIS\.COMPENSACION ATEN C$', 'BANK_FEE', 'Comisión bancaria',
     (SELECT id FROM expense_category WHERE nombre = 'Comisiones' AND activo ORDER BY id LIMIT 1)),
  ('BNA_MONTHLY_PDF_V1', '^ECHEQ\.EMI\.NRO [0-9]+$', 'BANK_FEE', 'Cargo por emisión de eCheq',
     (SELECT id FROM expense_category WHERE nombre = 'Comisiones' AND activo ORDER BY id LIMIT 1)),
  ('BNA_MONTHLY_PDF_V1', '^I\.V\.A\. BASE$', 'BANK_IVA', 'IVA bancario', NULL),
  ('PATAGONIA_STATEMENT_PDF_V1', '^IMP\.DB/CR BANCARIOS P/(CREDITOS|DEBITOS)$', 'BANK_TAX_DEBCRED', 'Impuesto Débitos/Créditos (Ley 25.413)', NULL);

CREATE TABLE fin_statement_charge_booking (
  statement_line_id      BIGINT       PRIMARY KEY REFERENCES fin_statement_line(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  rule_id                BIGINT       NOT NULL REFERENCES fin_statement_charge_rule(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  kind                   VARCHAR(20)  NOT NULL,
  financial_operation_id BIGINT       NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  financial_posting_id   BIGINT       NOT NULL UNIQUE REFERENCES financial_posting(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  statement_match_id     BIGINT       NOT NULL UNIQUE REFERENCES fin_statement_match(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  purchase_id            UUID         REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  batch_key              VARCHAR(100) NOT NULL,
  booked_by              UUID         NOT NULL,
  booked_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_fscb_kind     CHECK (kind IN ('BANK_TAX_DEBCRED', 'BANK_FEE', 'BANK_IVA')),
  CONSTRAINT chk_fscb_purchase CHECK ((kind = 'BANK_FEE') = (purchase_id IS NOT NULL))
);
CREATE INDEX idx_fscb_batch ON fin_statement_charge_booking(batch_key);
CREATE TRIGGER trg_fin_statement_charge_booking_immutable BEFORE UPDATE OR DELETE ON fin_statement_charge_booking
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE fin_statement_charge_booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_statement_charge_booking OWNER TO postgres;
REVOKE ALL ON TABLE fin_statement_charge_booking FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE fin_statement_charge_booking TO authenticated;
CREATE POLICY fin_statement_charge_booking_admin_select ON fin_statement_charge_booking FOR SELECT USING (current_app_role() = 'ADMIN');

-- ── the cut classification of one line (the rule of fin_statement_line_status, 0076) ──────────────────────────────────────
CREATE FUNCTION fin_statement_line_cut_class(p_line_id BIGINT) RETURNS TEXT
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE
    WHEN c.id IS NULL THEN 'CUTOVER_UNRESOLVED'
    WHEN l.id = c.cutoff_statement_line_id THEN 'PRE_CUTOVER'
    WHEN cfg.format_code = 'BNA_MONTHLY_PDF_V1' THEN
      CASE WHEN lp.coverage_to IS NULL OR lp.statement_position IS NULL OR ap.coverage_to IS NULL OR ap.statement_position IS NULL THEN NULL
           WHEN (lp.coverage_to, lp.statement_position) <= (ap.coverage_to, ap.statement_position) THEN 'PRE_CUTOVER'
           ELSE 'POST_CUTOVER' END
    WHEN cfg.format_code = 'PATAGONIA_STATEMENT_PDF_V1' THEN
      CASE WHEN l.value_date < a.value_date THEN 'PRE_CUTOVER' WHEN l.value_date = a.value_date THEN 'CUTOVER_AMBIGUOUS_DAY' ELSE 'POST_CUTOVER' END
  END
  FROM fin_statement_line l
  LEFT JOIN fin_statement_cutover c ON c.financial_account_id = l.financial_account_id AND c.superseded_at IS NULL
  LEFT JOIN fin_statement_account_config cfg ON cfg.financial_account_id = l.financial_account_id
  LEFT JOIN fin_statement_line a ON a.id = c.cutoff_statement_line_id
  LEFT JOIN LATERAL (SELECT r.coverage_to, x.statement_position FROM fin_import_run r JOIN fin_import_run_line x ON x.run_id = r.id AND x.statement_line_id = l.id
                      WHERE r.id = l.first_run_id) lp ON true
  LEFT JOIN LATERAL (SELECT r.coverage_to, x.statement_position FROM fin_import_run r JOIN fin_import_run_line x ON x.run_id = r.id AND x.statement_line_id = a.id
                      WHERE r.id = a.first_run_id) ap ON true
  WHERE l.id = p_line_id
$$;
ALTER FUNCTION fin_statement_line_cut_class(BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_line_cut_class(BIGINT) FROM PUBLIC, anon, authenticated, service_role;

-- ── what one line is: its proposal, or why it needs review ───────────────────────────────────────────────────────────────
CREATE FUNCTION fin_statement_charge_proposal(p_line_id BIGINT,
  OUT status TEXT, OUT kind TEXT, OUT rule_id BIGINT, OUT label TEXT, OUT expense_category_id UUID)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_line  fin_statement_line;
  v_kinds INTEGER;
BEGIN
  SELECT * INTO v_line FROM fin_statement_line WHERE id = p_line_id;
  IF NOT FOUND THEN status := 'NOT_FOUND'; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM fin_statement_charge_booking b WHERE b.statement_line_id = p_line_id) THEN status := 'BOOKED'; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM fin_statement_match m WHERE m.statement_line_id = p_line_id AND m.reversed_at IS NULL) THEN status := 'MATCHED'; RETURN; END IF;
  IF fin_statement_line_cut_class(p_line_id) IS DISTINCT FROM 'POST_CUTOVER' THEN status := 'NOT_POST_CUTOVER'; RETURN; END IF;
  SELECT count(DISTINCT r.kind) INTO v_kinds
    FROM fin_statement_charge_rule r JOIN fin_statement_account_config cfg ON cfg.format_code = r.format_code AND cfg.activo
   WHERE cfg.financial_account_id = v_line.financial_account_id AND r.activo AND v_line.description_norm ~* r.pattern;
  IF v_kinds = 0 THEN status := 'NO_RULE'; RETURN; END IF;
  IF v_kinds > 1 THEN status := 'AMBIGUOUS'; RETURN; END IF;
  SELECT r.kind, r.id, r.label, r.expense_category_id INTO kind, rule_id, label, expense_category_id
    FROM fin_statement_charge_rule r JOIN fin_statement_account_config cfg ON cfg.format_code = r.format_code AND cfg.activo
   WHERE cfg.financial_account_id = v_line.financial_account_id AND r.activo AND v_line.description_norm ~* r.pattern
   ORDER BY r.id LIMIT 1;
  IF v_line.signed_amount > 0 THEN status := 'CREDIT'; RETURN; END IF;
  IF kind = 'BANK_FEE' AND NOT EXISTS (SELECT 1 FROM expense_category c WHERE c.id = expense_category_id AND c.activo) THEN
    status := 'CATEGORY_MISSING'; RETURN;
  END IF;
  status := 'PROPOSED';
END $$;
ALTER FUNCTION fin_statement_charge_proposal(BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_charge_proposal(BIGINT) FROM PUBLIC, anon, authenticated, service_role;

-- ── RPC: the proposals of one account (read only) ────────────────────────────────────────────────────────────────────────
CREATE FUNCTION fin_statement_charge_proposals(p_account_id UUID)
RETURNS TABLE (statement_line_id BIGINT, value_date DATE, description_raw TEXT, bank_reference TEXT, signed_amount NUMERIC, running_balance NUMERIC,
               status TEXT, kind TEXT, rule_id BIGINT, label TEXT, expense_category_id UUID, category_name TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  RETURN QUERY
  SELECT l.id, l.value_date, l.description_raw, l.bank_reference::TEXT, l.signed_amount, l.running_balance,
         p.status, p.kind, p.rule_id, p.label::TEXT, p.expense_category_id, c.nombre::TEXT
    FROM fin_statement_line l
   CROSS JOIN LATERAL fin_statement_charge_proposal(l.id) p
    LEFT JOIN expense_category c ON c.id = p.expense_category_id
   WHERE l.financial_account_id = p_account_id
     AND p.status IN ('PROPOSED', 'NO_RULE', 'AMBIGUOUS', 'CREDIT', 'CATEGORY_MISSING')
   ORDER BY l.value_date, l.id;
END $$;
ALTER  FUNCTION fin_statement_charge_proposals(UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_statement_charge_proposals(UUID) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_statement_charge_proposals(UUID) TO authenticated;

-- ── internal: the IVA of a bank charge as its own BANK_TAX operation (register_bank_tax records only DEBITOS_CREDITOS) ────
CREATE FUNCTION fin_statement_bank_iva(p_account_id UUID, p_amount NUMERIC, p_date DATE, p_ref TEXT, p_reason TEXT) RETURNS BIGINT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_op BIGINT; v_uid UUID := auth.uid();
BEGIN
  PERFORM assert_period_open(p_date);
  INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason, created_by)
  VALUES ('BANK_TAX', p_date, p_ref, p_reason, v_uid) RETURNING id INTO v_op;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, p_account_id, -p_amount, p_date, v_uid);
  INSERT INTO bank_tax_charge (financial_operation_id, tax_kind, financial_account_id, amount, related_operation_id, created_by)
  VALUES (v_op, 'IVA', p_account_id, p_amount, NULL, v_uid);
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('financial_operation', v_op::TEXT, 'REGISTER_BANK_TAX',
          jsonb_build_object('account', p_account_id, 'amount', p_amount, 'tax_kind', 'IVA', 'effective_date', p_date), p_reason, v_uid);
  RETURN v_op;
END $$;
ALTER FUNCTION fin_statement_bank_iva(UUID, NUMERIC, DATE, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_bank_iva(UUID, NUMERIC, DATE, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── RPC: confirm a batch ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION fin_book_statement_charges(p_account_id UUID, p_items JSONB, p_idempotency_key VARCHAR)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_key     TEXT := btrim(p_idempotency_key);
  v_acc     financial_account;
  v_ids     BIGINT[];
  v_item    JSONB;
  v_line    fin_statement_line;
  v_prop    RECORD;
  v_want    TEXT;
  v_amount  NUMERIC;
  v_ref     TEXT;
  v_reason  TEXT;
  v_res     JSONB;
  v_op      BIGINT;
  v_post    BIGINT;
  v_purch   UUID;
  v_match   BIGINT;
  v_total   NUMERIC := 0;
  v_count   INTEGER := 0;
  v_by      JSONB := '{}'::jsonb;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF v_key IS NULL OR v_key = '' OR length(v_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'INVALID_ITEMS: 1 to 100 lines';
  END IF;
  SELECT array_agg(DISTINCT (x ->> 'statement_line_id')::BIGINT ORDER BY (x ->> 'statement_line_id')::BIGINT) INTO v_ids FROM jsonb_array_elements(p_items) x;
  IF cardinality(v_ids) <> jsonb_array_length(p_items) OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x WHERE x ->> 'statement_line_id' IS NULL OR x ->> 'kind' IS NULL) THEN
    RAISE EXCEPTION 'INVALID_ITEMS: each line once, each with its kind';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_statement_charges:' || v_key, 0));

  -- replay: the same key books the same lines once
  IF EXISTS (SELECT 1 FROM fin_statement_charge_booking WHERE batch_key = v_key) THEN
    IF (SELECT array_agg(statement_line_id ORDER BY statement_line_id) FROM fin_statement_charge_booking WHERE batch_key = v_key) = v_ids THEN
      RETURN (SELECT jsonb_build_object('replayed', true, 'booked', count(*), 'total', sum(-l.signed_amount))
                FROM fin_statement_charge_booking b JOIN fin_statement_line l ON l.id = b.statement_line_id WHERE b.batch_key = v_key);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: the key booked other lines';
  END IF;

  SELECT * INTO v_acc FROM financial_account WHERE id = p_account_id AND activo AND account_type = 'BANK_ACCOUNT';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_NOT_BANK';
  END IF;
  -- every line locked first, in id order (two batches never wait on each other in a cycle)
  PERFORM 1 FROM fin_statement_line WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY (value ->> 'statement_line_id')::BIGINT LOOP
    SELECT * INTO v_line FROM fin_statement_line WHERE id = (v_item ->> 'statement_line_id')::BIGINT;
    IF NOT FOUND OR v_line.financial_account_id <> p_account_id THEN
      RAISE EXCEPTION 'LINE_NOT_IN_ACCOUNT: line %', v_item ->> 'statement_line_id';
    END IF;
    SELECT * INTO v_prop FROM fin_statement_charge_proposal(v_line.id);
    v_want := v_item ->> 'kind';
    IF v_prop.status = 'BOOKED' THEN
      RAISE EXCEPTION 'LINE_ALREADY_BOOKED: line %', v_line.id;
    END IF;
    IF v_prop.status IS DISTINCT FROM 'PROPOSED' OR v_prop.kind IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION 'PROPOSAL_CHANGED: line % is % % (the batch saw %)', v_line.id, v_prop.status, coalesce(v_prop.kind, ''), v_want;
    END IF;

    v_amount := -v_line.signed_amount;
    v_ref    := 'STMT-LINE:' || v_line.id;
    v_reason := v_prop.label || ' · extracto ' || v_acc.nombre || ' ' || to_char(v_line.value_date, 'DD/MM/YYYY') || ' · línea ' || v_line.id;
    v_purch  := NULL;
    IF v_prop.kind = 'BANK_TAX_DEBCRED' THEN
      v_res := register_bank_tax(p_account_id, v_amount, v_line.value_date, 'DEBITOS_CREDITOS', v_ref, NULL, v_reason);
      v_op  := (v_res ->> 'financial_operation_id')::BIGINT;
    ELSIF v_prop.kind = 'BANK_IVA' THEN
      v_op  := fin_statement_bank_iva(p_account_id, v_amount, v_line.value_date, v_ref, v_reason);
    ELSE
      v_res := register_casual_purchase(v_line.value_date, v_amount, v_amount, v_prop.expense_category_id, v_prop.label, 'OPERATING', p_account_id,
                                        'TRANSFER', v_ref, v_acc.nombre, '[]'::jsonb, '[]'::jsonb, NULL, NULL, NULL, NULL, v_reason);
      IF (v_res ->> 'replayed')::BOOLEAN THEN
        RAISE EXCEPTION 'LINE_ALREADY_BOOKED: line % already has its expense', v_line.id;
      END IF;
      v_op    := (v_res ->> 'payment_operation_id')::BIGINT;
      v_purch := (v_res ->> 'purchase_id')::UUID;
    END IF;
    SELECT id INTO v_post FROM financial_posting WHERE financial_operation_id = v_op AND financial_account_id = p_account_id;
    v_res   := fin_match_statement_line(v_line.id, v_post, v_reason);
    v_match := (v_res ->> 'match_id')::BIGINT;
    INSERT INTO fin_statement_charge_booking (statement_line_id, rule_id, kind, financial_operation_id, financial_posting_id, statement_match_id, purchase_id, batch_key, booked_by)
    VALUES (v_line.id, v_prop.rule_id, v_prop.kind, v_op, v_post, v_match, v_purch, v_key, v_uid);
    v_total := v_total + v_amount;
    v_count := v_count + 1;
    v_by := jsonb_set(v_by, ARRAY[v_prop.kind], to_jsonb(coalesce((v_by ->> v_prop.kind)::NUMERIC, 0) + v_amount));
  END LOOP;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('financial_account', p_account_id::TEXT, 'FIN_STATEMENT_CHARGES_BOOKED',
          jsonb_build_object('batch_key', v_key, 'lines', to_jsonb(v_ids), 'total', v_total, 'by_kind', v_by), 'Cargos bancarios confirmados desde el extracto', v_uid);
  RETURN jsonb_build_object('replayed', false, 'booked', v_count, 'total', v_total, 'by_kind', v_by);
END;
$$;
ALTER  FUNCTION fin_book_statement_charges(UUID, JSONB, VARCHAR) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_book_statement_charges(UUID, JSONB, VARCHAR) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_book_statement_charges(UUID, JSONB, VARCHAR) TO authenticated;
