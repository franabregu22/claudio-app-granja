-- ============================================================================
-- TARGET V1 — 0077 FINANCIAL STATEMENT CUT vs ACTIVE MATCH GUARD (ADR-018, bank branch)
-- Authority: .planning/adr/ADR-018_FINANCIAL_STATEMENT_IMPORT.md §6.6 "Active matches and cut changes", §8, §16 #24,
--            §17 (owner decision 2026-10-11, commit d3383a3).
--
-- Invariant: every active fin_statement_match refers to a statement line that is POST_CUTOVER under the active cut
-- of its account. 0075 (frozen, applied) is not modified; this migration CREATE OR REPLACEs two of its functions with
-- the same signatures, owners and grants:
--   fin_resolve_statement_cutover  — evaluates every active match of the account against the PROPOSED anchor (first
--                                    cut and supersession alike) with the frozen ordering rules; any line that would not
--                                    be exactly POST_CUTOVER refuses the whole call (CUTOVER_ACTIVE_MATCH_CONFLICT),
--                                    nothing written, no automatic reversal. Takes FOR NO KEY UPDATE on the account row.
--   fin_match_statement_line       — one added statement: FOR SHARE on the same account row before reading the cut.
-- Concurrency: a match and a cut change of the same account serialise on that row lock, and two cut changes serialise
-- with each other; in READ COMMITTED every later statement sees what the other committed, so neither can slip past the
-- other's check (including a line imported after the cut change started). NO KEY UPDATE does not conflict with the
-- KEY SHARE taken by posting inserts. fin_reverse_statement_match is unchanged (a reversal can only lift a conflict).
--
-- No table, view, grant or policy change; the SECURITY DEFINER set stays 73. Bodies are otherwise identical to 0075.
-- ============================================================================

-- ── fin_match_statement_line (ADMIN) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION fin_match_statement_line(
  p_statement_line_id    BIGINT,
  p_financial_posting_id BIGINT,
  p_reason               TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_line    fin_statement_line;
  v_post    financial_posting;
  v_cut     fin_statement_cutover;
  v_anchor  fin_statement_line;
  v_fmt     TEXT;
  v_l_cov   DATE;
  v_l_pos   INTEGER;
  v_a_cov   DATE;
  v_a_pos   INTEGER;
  v_active  fin_statement_match;
  v_id      BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN only';
  END IF;
  SELECT * INTO v_line FROM fin_statement_line WHERE id = p_statement_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STATEMENT_LINE_NOT_FOUND';
  END IF;
  -- 0077: serialise with cut changes of this account (fin_resolve_statement_cutover holds FOR NO KEY UPDATE on the
  -- account row): the cut read below is then the committed one, and a cut change waits for this match to commit.
  PERFORM 1 FROM financial_account WHERE id = v_line.financial_account_id FOR SHARE;
  SELECT * INTO v_post FROM financial_posting WHERE id = p_financial_posting_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTING_NOT_FOUND';
  END IF;
  IF v_post.financial_account_id <> v_line.financial_account_id THEN
    RAISE EXCEPTION 'ACCOUNT_MISMATCH: the posting and the statement line belong to different accounts';
  END IF;
  IF v_post.signed_amount <> v_line.signed_amount THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH: posting % vs statement line %', v_post.signed_amount, v_line.signed_amount;
  END IF;

  -- cut classification (§6.6, §7.2, §7.3): only POST_CUTOVER lines are reconcilable
  SELECT * INTO v_cut FROM fin_statement_cutover
   WHERE financial_account_id = v_line.financial_account_id AND superseded_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUTOVER_UNRESOLVED: the account has no active statement cut';
  END IF;
  SELECT format_code INTO v_fmt FROM fin_statement_account_config WHERE financial_account_id = v_line.financial_account_id;
  SELECT * INTO v_anchor FROM fin_statement_line WHERE id = v_cut.cutoff_statement_line_id;
  IF v_line.id = v_anchor.id THEN
    RAISE EXCEPTION 'PRE_CUTOVER_LINE: the line is the cut anchor';
  END IF;
  IF v_fmt = 'BNA_MONTHLY_PDF_V1' THEN
    -- position = (statement period end, balance-chain index) of the appearance in the run that created the line
    SELECT r.coverage_to, a.statement_position INTO v_l_cov, v_l_pos
      FROM fin_import_run r JOIN fin_import_run_line a ON a.run_id = r.id AND a.statement_line_id = v_line.id
     WHERE r.id = v_line.first_run_id;
    SELECT r.coverage_to, a.statement_position INTO v_a_cov, v_a_pos
      FROM fin_import_run r JOIN fin_import_run_line a ON a.run_id = r.id AND a.statement_line_id = v_anchor.id
     WHERE r.id = v_anchor.first_run_id;
    IF v_l_cov IS NULL OR v_l_pos IS NULL OR v_a_cov IS NULL OR v_a_pos IS NULL THEN
      RAISE EXCEPTION 'CUTOVER_ORDER_UNAVAILABLE';
    END IF;
    IF (v_l_cov, v_l_pos) <= (v_a_cov, v_a_pos) THEN
      RAISE EXCEPTION 'PRE_CUTOVER_LINE: the line is included in the opening balance';
    END IF;
  ELSIF v_fmt = 'PATAGONIA_STATEMENT_PDF_V1' THEN
    IF v_line.value_date < v_anchor.value_date THEN
      RAISE EXCEPTION 'PRE_CUTOVER_LINE: the line is included in the opening balance';
    ELSIF v_line.value_date = v_anchor.value_date THEN
      RAISE EXCEPTION 'CUTOVER_AMBIGUOUS_DAY: same-day order relative to the anchor is not verifiable';
    END IF;
  ELSE
    RAISE EXCEPTION 'STATEMENT_CONFIG_MISSING';
  END IF;

  -- one active match per line and per posting; an identical replay returns the existing match
  SELECT * INTO v_active FROM fin_statement_match WHERE statement_line_id = v_line.id AND reversed_at IS NULL;
  IF FOUND THEN
    IF v_active.financial_posting_id = v_post.id THEN
      RETURN jsonb_build_object('match_id', v_active.id, 'financial_operation_id', v_active.financial_operation_id, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'LINE_ALREADY_MATCHED: statement line % has active match %', v_line.id, v_active.id;
  END IF;
  IF EXISTS (SELECT 1 FROM fin_statement_match WHERE financial_posting_id = v_post.id AND reversed_at IS NULL) THEN
    RAISE EXCEPTION 'POSTING_ALREADY_MATCHED: posting % already has an active match', v_post.id;
  END IF;

  BEGIN
    INSERT INTO fin_statement_match (statement_line_id, financial_operation_id, financial_posting_id, matched_by, reason)
    VALUES (v_line.id, v_post.financial_operation_id, v_post.id, v_uid, nullif(btrim(p_reason), ''))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'MATCH_CONFLICT: a concurrent active match exists';
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('fin_statement_match', v_id::TEXT, 'FIN_STATEMENT_MATCH',
          jsonb_build_object('statement_line_id', v_line.id, 'financial_operation_id', v_post.financial_operation_id,
                             'financial_posting_id', v_post.id, 'account', v_line.financial_account_id,
                             'signed_amount', v_line.signed_amount),
          nullif(btrim(p_reason), ''), v_uid);

  RETURN jsonb_build_object('match_id', v_id, 'financial_operation_id', v_post.financial_operation_id, 'replayed', false);
END;
$$;
ALTER FUNCTION fin_match_statement_line(BIGINT, BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_match_statement_line(BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_match_statement_line(BIGINT, BIGINT, TEXT) TO authenticated;

-- ── fin_resolve_statement_cutover (ADMIN) ──────────────────────────────────
CREATE OR REPLACE FUNCTION fin_resolve_statement_cutover(
  p_account_id               UUID,
  p_cutoff_statement_line_id BIGINT,
  p_opening_balance          NUMERIC,
  p_evidence_note            TEXT,
  p_supersede_reason         TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_fmt    TEXT;
  v_anchor fin_statement_line;
  v_active fin_statement_cutover;
  v_new    BIGINT;
  v_a_cov  DATE;
  v_a_pos  INTEGER;
  v_conflicts INTEGER;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN only';
  END IF;
  -- 0077: one cut change at a time per account, serialised with fin_match_statement_line (FOR SHARE on the same row);
  -- NO KEY UPDATE does not block posting inserts referencing the account (their FK takes KEY SHARE).
  PERFORM 1 FROM financial_account WHERE id = p_account_id FOR NO KEY UPDATE;
  IF NOT EXISTS (SELECT 1 FROM financial_account
                  WHERE id = p_account_id AND activo AND account_type = 'BANK_ACCOUNT') THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_NOT_BANK';
  END IF;
  SELECT format_code INTO v_fmt FROM fin_statement_account_config WHERE financial_account_id = p_account_id AND activo;
  IF v_fmt IS NULL THEN
    RAISE EXCEPTION 'STATEMENT_CONFIG_MISSING';
  END IF;
  IF p_evidence_note IS NULL OR btrim(p_evidence_note) = '' THEN
    RAISE EXCEPTION 'EVIDENCE_REQUIRED';
  END IF;
  SELECT * INTO v_anchor FROM fin_statement_line WHERE id = p_cutoff_statement_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANCHOR_NOT_FOUND';
  END IF;
  IF v_anchor.financial_account_id <> p_account_id THEN
    RAISE EXCEPTION 'ANCHOR_NOT_IN_ACCOUNT';
  END IF;
  -- K-4: the anchor carries a balance and the opening balance equals it exactly
  IF v_anchor.running_balance IS NULL THEN
    RAISE EXCEPTION 'ANCHOR_WITHOUT_BALANCE: a line without a running balance cannot be the anchor';
  END IF;
  IF p_opening_balance IS NULL OR p_opening_balance <> v_anchor.running_balance THEN
    RAISE EXCEPTION 'OPENING_BALANCE_MISMATCH: opening % vs anchor balance %', p_opening_balance, v_anchor.running_balance;
  END IF;
  -- Patagonia: same-day order is not verifiable, so the anchor must be alone on its date
  IF v_fmt = 'PATAGONIA_STATEMENT_PDF_V1' AND EXISTS (
       SELECT 1 FROM fin_statement_line
        WHERE financial_account_id = p_account_id AND value_date = v_anchor.value_date AND id <> v_anchor.id) THEN
    RAISE EXCEPTION 'ANCHOR_AMBIGUOUS_DAY: another statement line shares the anchor date';
  END IF;

  -- 0077 (ADR-018 §6.6, §16 #24): every active match of the account must stay exactly POST_CUTOVER under the
  -- PROPOSED anchor, with the frozen ordering rules of fin_match_statement_line. Anything else — the anchor itself,
  -- PRE, same-day ambiguous, indeterminate order or an unknown format — refuses the whole operation.
  IF v_fmt = 'BNA_MONTHLY_PDF_V1' THEN
    SELECT r.coverage_to, a.statement_position INTO v_a_cov, v_a_pos
      FROM fin_import_run r JOIN fin_import_run_line a ON a.run_id = r.id AND a.statement_line_id = v_anchor.id
     WHERE r.id = v_anchor.first_run_id;
  END IF;
  SELECT count(*) INTO v_conflicts
    FROM fin_statement_match m
    JOIN fin_statement_line l ON l.id = m.statement_line_id
    LEFT JOIN LATERAL (
      SELECT r.coverage_to, x.statement_position
        FROM fin_import_run r
        JOIN fin_import_run_line x ON x.run_id = r.id AND x.statement_line_id = l.id
       WHERE r.id = l.first_run_id
    ) lp ON true
   WHERE m.reversed_at IS NULL
     AND l.financial_account_id = p_account_id
     AND NOT (l.id <> v_anchor.id AND CASE v_fmt
           WHEN 'BNA_MONTHLY_PDF_V1' THEN
             lp.coverage_to IS NOT NULL AND lp.statement_position IS NOT NULL AND v_a_cov IS NOT NULL AND v_a_pos IS NOT NULL
             AND (lp.coverage_to, lp.statement_position) > (v_a_cov, v_a_pos)
           WHEN 'PATAGONIA_STATEMENT_PDF_V1' THEN l.value_date > v_anchor.value_date
           ELSE false
         END);
  IF v_conflicts > 0 THEN
    RAISE EXCEPTION 'CUTOVER_ACTIVE_MATCH_CONFLICT: % active match(es) would not remain POST_CUTOVER under the proposed cut', v_conflicts;
  END IF;

  SELECT * INTO v_active FROM fin_statement_cutover
   WHERE financial_account_id = p_account_id AND superseded_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    IF p_supersede_reason IS NOT NULL THEN
      RAISE EXCEPTION 'SUPERSEDE_REASON_NOT_ALLOWED: there is no active cut to supersede';
    END IF;
    INSERT INTO fin_statement_cutover (financial_account_id, opening_balance, cutoff_statement_line_id, resolved_by, evidence_note)
    VALUES (p_account_id, p_opening_balance, v_anchor.id, v_uid, btrim(p_evidence_note))
    RETURNING id INTO v_new;
  ELSE
    IF p_supersede_reason IS NULL OR btrim(p_supersede_reason) = '' THEN
      RAISE EXCEPTION 'SUPERSEDE_REASON_REQUIRED: the account already has an active cut';
    END IF;
    v_new := nextval('fin_statement_cutover_id_seq');
    UPDATE fin_statement_cutover
       SET superseded_by = v_new, superseded_at = NOW(), supersede_reason = btrim(p_supersede_reason)
     WHERE id = v_active.id;
    INSERT INTO fin_statement_cutover (id, financial_account_id, opening_balance, cutoff_statement_line_id, resolved_by, evidence_note)
    VALUES (v_new, p_account_id, p_opening_balance, v_anchor.id, v_uid, btrim(p_evidence_note));
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('fin_statement_cutover', v_new::TEXT, 'FIN_STATEMENT_CUTOVER',
          CASE WHEN v_active.id IS NULL THEN NULL
               ELSE jsonb_build_object('cutover_id', v_active.id, 'cutoff_statement_line_id', v_active.cutoff_statement_line_id,
                                       'opening_balance', v_active.opening_balance) END,
          jsonb_build_object('account', p_account_id, 'cutoff_statement_line_id', v_anchor.id,
                             'opening_balance', p_opening_balance, 'superseded_id', v_active.id),
          coalesce(btrim(p_supersede_reason), btrim(p_evidence_note)), v_uid);

  RETURN jsonb_build_object('cutover_id', v_new, 'superseded_id', v_active.id);
END;
$$;
ALTER FUNCTION fin_resolve_statement_cutover(UUID, BIGINT, NUMERIC, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_resolve_statement_cutover(UUID, BIGINT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_resolve_statement_cutover(UUID, BIGINT, NUMERIC, TEXT, TEXT) TO authenticated;
