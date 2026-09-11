-- ============================================================================
-- MAIN RPC FUNCTIONS FOR JUNE RECONCILIATION
-- File: 008_reconciliation_rpc.sql
-- Status: V2 import engine (separate from V1)
-- ============================================================================

-- ============================================================================
-- PREVIEW FUNCTION (READ-ONLY)
-- Purpose: Analyze input data and return expected classification/impact
--          WITHOUT modifying database
-- ============================================================================

CREATE OR REPLACE FUNCTION preview_financial_movements_reconciliation_v2(
  p_account_id BIGINT,
  p_input_rows JSONB[],
  p_source_type TEXT,
  p_month_start DATE,
  p_month_end DATE
) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_result JSONB := '{}'::JSONB;
  v_row JSONB;
  v_idx INT := 0;
  v_payload_hash TEXT;
  v_explicit_payload_hash TEXT;
  v_signed_impact NUMERIC;
  v_description TEXT;
  v_economic_row_fp TEXT;
  v_cross_source_fp TEXT;
  v_economic_class TEXT;
  v_is_raw_only BOOLEAN;
  v_existing_fm RECORD;
  v_existing_sr RECORD;
  v_existing_sr_count BIGINT;
  v_existing_fm_id BIGINT;
  v_existing_le_balance NUMERIC;
  v_collapse_detected BOOLEAN;

  v_total_input INT := 0;
  v_existing_raw_exact INT := 0;
  v_new_source_records INT := 0;
  v_new_financial_movements INT := 0;
  v_new_ledger_entries INT := 0;
  v_create_fm_from_sr INT := 0;
  v_ambiguous_rows INT := 0;
  v_raw_only_rows INT := 0;
  v_distinct_same_source INT := 0;

  v_expected_delta NUMERIC := 0;
  v_current_ledger_net NUMERIC;
  v_expected_final NUMERIC;
BEGIN
  -- Get current June ledger net
  SELECT COALESCE(SUM(le.balance_impact), 0)
  INTO v_current_ledger_net
  FROM ledger_entry le
  INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
  WHERE mfm.account_id = p_account_id
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end;

  -- Process each input row
  FOREACH v_row IN ARRAY p_input_rows LOOP
    v_idx := v_idx + 1;
    v_total_input := v_total_input + 1;

    -- Extract fields based on source_type
    v_explicit_payload_hash := NULL;
    v_collapse_detected := FALSE;

    IF p_source_type = 'liberaciones' THEN
      v_signed_impact := (v_row->>'NET_CREDIT_AMOUNT')::NUMERIC - (v_row->>'NET_DEBIT_AMOUNT')::NUMERIC;
      v_description := v_row->>'DESCRIPTION';
      v_payload_hash := md5(v_row::text);
    ELSIF p_source_type = 'report' THEN
      v_signed_impact := (v_row->>'SETTLEMENT_NET_AMOUNT')::NUMERIC;
      v_description := v_row->>'TRANSACTION_TYPE';
      -- Try to extract explicit payload_hash from input (Python-calculated SHA256)
      v_explicit_payload_hash := v_row->>'_payload_hash';
      -- Fallback to MD5 if explicit not provided
      v_payload_hash := COALESCE(v_explicit_payload_hash, md5(v_row::text));
    END IF;

    -- Compute fingerprints
    v_economic_row_fp := compute_economic_row_fp(
      p_account_id,
      p_source_type,
      v_row->>'SOURCE_ID',
      v_signed_impact,
      (v_row->>'DATE')::TIMESTAMP,
      v_description
    );

    v_economic_class := map_to_economic_class(p_source_type, v_description);

    v_cross_source_fp := compute_cross_source_fp(
      v_signed_impact,
      (v_row->>'DATE')::TIMESTAMP,
      v_economic_class
    );

    v_is_raw_only := is_raw_only(p_source_type, v_description);

    -- Check Layer 1: Exact duplicate by payload_hash
    -- For Report with explicit payload_hash, search by payload_hash column (SHA256 historical)
    -- For Liberaciones or fallback, use MD5 comparison
    IF p_source_type = 'report' AND v_explicit_payload_hash IS NOT NULL THEN
      -- Search for exact SR by historical SHA256 payload_hash
      SELECT msr.id, msr.account_id, msr.source_external_id
      INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND msr.payload_hash = v_explicit_payload_hash
        AND msr.account_id = p_account_id
      LIMIT 1;
    ELSE
      -- Fallback: search by MD5 of raw_data (legacy)
      SELECT msr.id, msr.account_id, msr.source_external_id
      INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND md5(msr.raw_data::text) = v_payload_hash
        AND msr.account_id = p_account_id
      LIMIT 1;
    END IF;

    IF FOUND THEN
      -- SR already exists (idempotent)
      v_existing_raw_exact := v_existing_raw_exact + 1;

      -- For Liberaciones: count RAW-only EVEN if SR exists
      IF p_source_type = 'liberaciones' AND v_is_raw_only THEN
        v_raw_only_rows := v_raw_only_rows + 1;
      END IF;

      -- Check for multi-settlement collapse: existing SR with wrong FM link
      IF NOT v_is_raw_only THEN
        -- Get linked FM and its balance
        SELECT mfm.id, le.balance_impact
        INTO v_existing_fm_id, v_existing_le_balance
        FROM mp_movement_source_link msl
        INNER JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
        LEFT JOIN ledger_entry le ON le.financial_movement_id = mfm.id
          AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end
        WHERE msl.source_record_id = v_existing_sr.id
        LIMIT 1;

        -- Check if linked FM balance matches this row's impact (economic identity)
        IF v_existing_le_balance IS NOT NULL AND ABS(v_existing_le_balance - v_signed_impact) > 0.01 THEN
          -- Collapse detected: SR linked to FM with different balance
          v_collapse_detected := TRUE;
          v_create_fm_from_sr := v_create_fm_from_sr + 1;
          -- Mark as needing new FM but don't create SR
        END IF;
      END IF;

      CONTINUE;  -- Skip creating new SR (idempotent)
    END IF;

    -- New source record will be created
    v_new_source_records := v_new_source_records + 1;

    -- Classify based on type
    IF v_is_raw_only THEN
      v_raw_only_rows := v_raw_only_rows + 1;
      -- RAW-only: no FM, no LE
    ELSE
      -- Definitive: check Layer 2 or Layer 3 based on source
      IF p_source_type = 'report' THEN
        -- Report: use Layer 2 (within-source match by economic_row_fp)
        SELECT * INTO v_existing_fm FROM get_existing_fm_by_econ_fp(p_account_id, v_economic_row_fp);
      ELSE
        -- Liberaciones: use Layer 3 (cross-source match by cross_source_fp with validation)
        -- Get candidates with same cross_source_fp from any source
        SELECT fm_id, source_count, settlement_amount
        INTO v_existing_fm
        FROM get_fm_candidates_by_cross_fp(p_account_id, v_cross_source_fp);

        -- Validate candidate: must have exact settlement match and be unique
        IF FOUND AND ABS(v_existing_fm.settlement_amount - v_signed_impact) > 0.01 THEN
          -- Settlement mismatch: not a valid candidate
          v_existing_fm := NULL;
        END IF;

        -- If multiple candidates exist, mark as ambiguous
        IF v_existing_fm IS NOT NULL THEN
          SELECT COUNT(*) INTO v_distinct_same_source
          FROM get_fm_candidates_by_cross_fp(p_account_id, v_cross_source_fp);

          IF v_distinct_same_source > 1 THEN
            v_ambiguous_rows := v_ambiguous_rows + 1;
            v_existing_fm := NULL;
          END IF;
        END IF;
      END IF;

      IF FOUND AND v_existing_fm IS NOT NULL THEN
        -- FM already exists for this economic movement
        -- Will link to existing FM (no new FM)
      ELSE
        -- No existing FM: new movement detected
        v_new_financial_movements := v_new_financial_movements + 1;
        v_new_ledger_entries := v_new_ledger_entries + 1;
        v_expected_delta := v_expected_delta + v_signed_impact;
      END IF;
    END IF;
  END LOOP;

  -- Calculate final ledger net
  v_expected_final := v_current_ledger_net + v_expected_delta;

  -- Build result JSON
  v_result := jsonb_build_object(
    'preview_mode', TRUE,
    'timestamp_utc', now()::TEXT,
    'account_id', p_account_id,
    'month_period', CONCAT(p_month_start::TEXT, ' to ', p_month_end::TEXT),
    'summary', jsonb_build_object(
      'total_input_rows', v_total_input,
      'existing_raw_exact_match', v_existing_raw_exact,
      'new_source_records', v_new_source_records,
      'new_financial_movements', v_new_financial_movements,
      'new_ledger_entries', v_new_ledger_entries,
      'create_fm_from_existing_sr', v_create_fm_from_sr,
      'ambiguous_rows', v_ambiguous_rows,
      'raw_only_rows', v_raw_only_rows,
      'distinct_same_source_movements', v_distinct_same_source,
      'multi_settlement_collapses_detected', CASE WHEN v_create_fm_from_sr > 0 THEN 1 ELSE 0 END,
      'historical_resolutions_required', v_create_fm_from_sr
    ),
    'financial_impact', jsonb_build_object(
      'current_ledger_net_pre_import', v_current_ledger_net,
      'expected_delta', v_expected_delta,
      'expected_ledger_net_post_import', v_expected_final
    ),
    'warnings', jsonb_build_array(),
    'errors', jsonb_build_array(),
    'created_ids', jsonb_build_object(
      'source_record_ids', '[]'::JSONB,
      'financial_movement_ids', '[]'::JSONB,
      'ledger_entry_ids', '[]'::JSONB,
      'link_ids', '[]'::JSONB,
      'resolution_ids', '[]'::JSONB,
      'exception_ids', '[]'::JSONB,
      'cycle_ids', '[]'::JSONB
    )
  );

  RETURN v_result;
END;
$$;

-- ============================================================================
-- IMPORT FUNCTION (WRITE)
-- Purpose: Persist reconciliation changes to database
--          Uses same classification logic as preview
-- ============================================================================

CREATE OR REPLACE FUNCTION import_financial_movements_reconciliation_v2(
  p_account_id BIGINT,
  p_input_rows JSONB[],
  p_source_type TEXT,
  p_month_start DATE,
  p_month_end DATE,
  p_import_id TEXT DEFAULT gen_random_uuid()::TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_result JSONB := '{}'::JSONB;
  v_row JSONB;
  v_idx INT := 0;
  v_payload_hash TEXT;
  v_explicit_payload_hash TEXT;
  v_signed_impact NUMERIC;
  v_description TEXT;
  v_source_id TEXT;
  v_economic_row_fp TEXT;
  v_cross_source_fp TEXT;
  v_economic_class TEXT;
  v_is_raw_only BOOLEAN;
  v_existing_fm RECORD;
  v_existing_sr RECORD;
  v_existing_sr_count BIGINT;
  v_existing_fm_id BIGINT;
  v_existing_le_balance NUMERIC;
  v_collapse_detected BOOLEAN;
  v_new_sr_id BIGINT;
  v_new_fm_id BIGINT;
  v_new_le_id BIGINT;
  v_new_link_id BIGINT;
  v_resolution_id BIGINT;

  v_sr_ids BIGINT[] := '{}';
  v_fm_ids BIGINT[] := '{}';
  v_le_ids BIGINT[] := '{}';
  v_link_ids BIGINT[] := '{}';
  v_resolution_ids BIGINT[] := '{}';

  v_total_input INT := 0;
  v_existing_raw_exact INT := 0;
  v_new_source_records INT := 0;
  v_new_financial_movements INT := 0;
  v_new_ledger_entries INT := 0;
  v_create_fm_from_sr INT := 0;
  v_ambiguous_rows INT := 0;
  v_raw_only_rows INT := 0;
  v_distinct_same_source INT := 0;

  v_expected_delta NUMERIC := 0;
  v_current_ledger_net NUMERIC;
  v_expected_final NUMERIC;
BEGIN
  -- Get current June ledger net (re-evaluate as of now)
  SELECT COALESCE(SUM(le.balance_impact), 0)
  INTO v_current_ledger_net
  FROM ledger_entry le
  INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
  WHERE mfm.account_id = p_account_id
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end;

  -- Process each input row
  FOREACH v_row IN ARRAY p_input_rows LOOP
    v_idx := v_idx + 1;
    v_total_input := v_total_input + 1;

    -- Extract fields based on source_type
    v_explicit_payload_hash := NULL;
    v_collapse_detected := FALSE;

    IF p_source_type = 'liberaciones' THEN
      v_signed_impact := (v_row->>'NET_CREDIT_AMOUNT')::NUMERIC - (v_row->>'NET_DEBIT_AMOUNT')::NUMERIC;
      v_description := v_row->>'DESCRIPTION';
      v_source_id := v_row->>'SOURCE_ID';
      v_payload_hash := md5(v_row::text);
    ELSIF p_source_type = 'report' THEN
      v_signed_impact := (v_row->>'SETTLEMENT_NET_AMOUNT')::NUMERIC;
      v_description := v_row->>'TRANSACTION_TYPE';
      v_source_id := v_row->>'SOURCE_ID';
      -- Try to extract explicit payload_hash from input (Python-calculated SHA256)
      v_explicit_payload_hash := v_row->>'_payload_hash';
      -- Fallback to MD5 if explicit not provided
      v_payload_hash := COALESCE(v_explicit_payload_hash, md5(v_row::text));
    END IF;

    -- Compute fingerprints
    v_economic_row_fp := compute_economic_row_fp(
      p_account_id, p_source_type, v_source_id, v_signed_impact,
      (v_row->>'DATE')::TIMESTAMP, v_description
    );

    v_economic_class := map_to_economic_class(p_source_type, v_description);

    v_cross_source_fp := compute_cross_source_fp(
      v_signed_impact, (v_row->>'DATE')::TIMESTAMP, v_economic_class
    );

    v_is_raw_only := is_raw_only(p_source_type, v_description);

    -- Check Layer 1: Exact duplicate by payload_hash
    -- For Report with explicit payload_hash, search by payload_hash column (SHA256 historical)
    -- For Liberaciones or fallback, use MD5 comparison
    IF p_source_type = 'report' AND v_explicit_payload_hash IS NOT NULL THEN
      -- Search for exact SR by historical SHA256 payload_hash
      SELECT msr.id, msr.account_id, msr.source_external_id
      INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND msr.payload_hash = v_explicit_payload_hash
        AND msr.account_id = p_account_id
      LIMIT 1;
    ELSE
      -- Fallback: search by MD5 of raw_data (legacy)
      SELECT msr.id, msr.account_id, msr.source_external_id
      INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND md5(msr.raw_data::text) = v_payload_hash
        AND msr.account_id = p_account_id
      LIMIT 1;
    END IF;

    IF FOUND THEN
      -- SR already exists (idempotent)
      v_existing_raw_exact := v_existing_raw_exact + 1;

      -- For Liberaciones: count RAW-only EVEN if SR exists
      IF p_source_type = 'liberaciones' AND v_is_raw_only THEN
        v_raw_only_rows := v_raw_only_rows + 1;
      END IF;

      -- Check for multi-settlement collapse: existing SR with wrong FM link
      IF NOT v_is_raw_only THEN
        -- Get linked FM and its balance
        SELECT mfm.id, le.balance_impact
        INTO v_existing_fm_id, v_existing_le_balance
        FROM mp_movement_source_link msl
        INNER JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
        LEFT JOIN ledger_entry le ON le.financial_movement_id = mfm.id
          AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end
        WHERE msl.source_record_id = v_existing_sr.id
        LIMIT 1;

        -- Check if linked FM balance matches this row's impact (economic identity)
        IF v_existing_le_balance IS NOT NULL AND ABS(v_existing_le_balance - v_signed_impact) > 0.01 THEN
          -- Collapse detected: SR linked to FM with different balance
          v_collapse_detected := TRUE;
          v_create_fm_from_sr := v_create_fm_from_sr + 1;

          -- Create new FM + LE for this SR (without creating a new SR)
          INSERT INTO mp_financial_movement (
            account_id, source_id, movement_class, settlement_amount,
            transaction_date, needs_review
          )
          VALUES (
            p_account_id, v_source_id, 'PAYOUT', v_signed_impact,
            (v_row->>'DATE')::TIMESTAMP, FALSE
          )
          RETURNING id INTO v_new_fm_id;

          v_new_financial_movements := v_new_financial_movements + 1;
          v_fm_ids := array_append(v_fm_ids, v_new_fm_id);

          -- Create ledger entry for new FM
          INSERT INTO ledger_entry (
            financial_movement_id, account_id, balance_impact, occurred_at
          )
          VALUES (
            v_new_fm_id, p_account_id, v_signed_impact,
            (v_row->>'DATE')::TIMESTAMP
          )
          RETURNING id INTO v_new_le_id;

          v_new_ledger_entries := v_new_ledger_entries + 1;
          v_le_ids := array_append(v_le_ids, v_new_le_id);

          -- Link existing SR to new FM
          INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
          VALUES (v_new_fm_id, v_existing_sr.id, FALSE)
          RETURNING id INTO v_new_link_id;

          v_link_ids := array_append(v_link_ids, v_new_link_id);

          -- Record resolution in mp_source_link_resolution
          INSERT INTO mp_source_link_resolution (
            source_record_id, old_financial_movement_id, new_financial_movement_id,
            resolution_type, notes
          )
          VALUES (
            v_existing_sr.id, v_existing_fm_id, v_new_fm_id,
            'CREATE_FM_FROM_EXISTING_SR',
            'Multi-settlement collapse detected: existing SR linked to FM with different balance'
          )
          RETURNING id INTO v_resolution_id;

          v_resolution_ids := array_append(v_resolution_ids, v_resolution_id);
          v_expected_delta := v_expected_delta + v_signed_impact;
        END IF;
      END IF;

      CONTINUE;  -- Skip creating new SR (idempotent)
    END IF;

    -- New source record will be created
    v_new_source_records := v_new_source_records + 1;

    -- Create mp_source_record
    INSERT INTO mp_source_record (
      source_type, source_external_id, raw_data, account_id,
      economic_row_fp, cross_source_fp, payload_hash
    )
    VALUES (
      p_source_type, v_source_id, v_row, p_account_id,
      v_economic_row_fp, v_cross_source_fp, v_explicit_payload_hash
    )
    RETURNING id INTO v_new_sr_id;

    v_sr_ids := array_append(v_sr_ids, v_new_sr_id);

    -- Classify and create FM/LE if needed
    IF NOT v_is_raw_only THEN
      -- Try to find existing FM based on source type
      IF p_source_type = 'report' THEN
        -- Report: use Layer 2 (within-source match by economic_row_fp)
        SELECT * INTO v_existing_fm FROM get_existing_fm_by_econ_fp(p_account_id, v_economic_row_fp);
      ELSE
        -- Liberaciones: use Layer 3 (cross-source match by cross_source_fp with validation)
        -- Get candidates with same cross_source_fp from any source
        SELECT fm_id, source_count, settlement_amount
        INTO v_existing_fm
        FROM get_fm_candidates_by_cross_fp(p_account_id, v_cross_source_fp);

        -- Validate candidate: must have exact settlement match and be unique
        IF FOUND AND ABS(v_existing_fm.settlement_amount - v_signed_impact) > 0.01 THEN
          -- Settlement mismatch: not a valid candidate
          v_existing_fm := NULL;
        END IF;

        -- If multiple candidates exist, mark as ambiguous
        IF v_existing_fm IS NOT NULL THEN
          SELECT COUNT(*) INTO v_distinct_same_source
          FROM get_fm_candidates_by_cross_fp(p_account_id, v_cross_source_fp);

          IF v_distinct_same_source > 1 THEN
            v_ambiguous_rows := v_ambiguous_rows + 1;
            v_existing_fm := NULL;
          END IF;
        END IF;
      END IF;

      IF FOUND AND v_existing_fm IS NOT NULL THEN
        -- Link to existing FM
        INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
        VALUES (v_existing_fm.fm_id, v_new_sr_id, FALSE)
        RETURNING id INTO v_new_link_id;

        v_link_ids := array_append(v_link_ids, v_new_link_id);
      ELSE
        -- Create new FM and LE
        INSERT INTO mp_financial_movement (
          account_id, source_id, movement_class, settlement_amount,
          transaction_date, needs_review
        )
        VALUES (
          p_account_id, v_source_id, 'PAYOUT', v_signed_impact,
          (v_row->>'DATE')::TIMESTAMP, FALSE
        )
        RETURNING id INTO v_new_fm_id;

        v_new_financial_movements := v_new_financial_movements + 1;
        v_fm_ids := array_append(v_fm_ids, v_new_fm_id);

        -- Create ledger entry
        INSERT INTO ledger_entry (
          financial_movement_id, account_id, balance_impact, occurred_at
        )
        VALUES (
          v_new_fm_id, p_account_id, v_signed_impact,
          (v_row->>'DATE')::TIMESTAMP
        )
        RETURNING id INTO v_new_le_id;

        v_new_ledger_entries := v_new_ledger_entries + 1;
        v_le_ids := array_append(v_le_ids, v_new_le_id);

        -- Create movement source link
        INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
        VALUES (v_new_fm_id, v_new_sr_id, TRUE)
        RETURNING id INTO v_new_link_id;

        v_link_ids := array_append(v_link_ids, v_new_link_id);

        v_expected_delta := v_expected_delta + v_signed_impact;
      END IF;
    END IF;
  END LOOP;

  -- Calculate final ledger net
  v_expected_final := v_current_ledger_net + v_expected_delta;

  -- Build result JSON
  v_result := jsonb_build_object(
    'preview_mode', FALSE,
    'timestamp_utc', now()::TEXT,
    'account_id', p_account_id,
    'import_id', p_import_id,
    'summary', jsonb_build_object(
      'total_input_rows', v_total_input,
      'existing_raw_exact_match', v_existing_raw_exact,
      'new_source_records', v_new_source_records,
      'new_financial_movements', v_new_financial_movements,
      'new_ledger_entries', v_new_ledger_entries,
      'create_fm_from_existing_sr', v_create_fm_from_sr,
      'ambiguous_rows', v_ambiguous_rows,
      'raw_only_rows', v_raw_only_rows,
      'multi_settlement_collapses_detected', CASE WHEN v_create_fm_from_sr > 0 THEN 1 ELSE 0 END
    ),
    'financial_impact', jsonb_build_object(
      'current_ledger_net_pre_import', v_current_ledger_net,
      'expected_delta', v_expected_delta,
      'expected_ledger_net_post_import', v_expected_final
    ),
    'created_ids', jsonb_build_object(
      'source_record_ids', v_sr_ids,
      'financial_movement_ids', v_fm_ids,
      'ledger_entry_ids', v_le_ids,
      'link_ids', v_link_ids,
      'resolution_ids', v_resolution_ids
    )
  );

  RETURN v_result;
END;
$$;

-- ============================================================================
-- SUMMARY
-- ============================================================================
-- RPC functions created: 2
-- - preview_financial_movements_reconciliation_v2 (read-only)
-- - import_financial_movements_reconciliation_v2 (write)
-- ============================================================================
