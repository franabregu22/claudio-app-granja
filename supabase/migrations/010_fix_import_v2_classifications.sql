-- ============================================================================
-- MIGRATION 010: Fix import_financial_movements_reconciliation_v2
--
-- CRITICAL FIXES:
-- 1. asset_management classification: yield (interest_income) not payment_in (income)
-- 2. payment sign-based classification: payment_in (+) vs payment_out (-)
-- 3. payout classification: transfer_out not payment_out
-- 4. Reserves (reserve_for_payment, reserve_for_payout): RAW-only regardless of source_type
-- 5. Control rows (opening/closing without SOURCE_ID): filtered by Netlify, never reach here
-- 6. Unknown descriptions: blocked by Netlify, should NOT reach here
--
-- Changes are MINIMAL and focused on classification logic only.
-- Helper functions (is_raw_only, map_to_economic_class) are updated minimally.
-- ============================================================================

-- Update is_raw_only to handle reserves from any source_type
DROP FUNCTION IF EXISTS is_raw_only(TEXT, TEXT);

CREATE OR REPLACE FUNCTION is_raw_only(
  p_source_type TEXT,
  p_description TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  -- Reserves are RAW-only regardless of source_type
  IF p_description = 'reserve_for_payment' OR p_description = 'reserve_for_payout' THEN
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$;

-- Drop and recreate import_financial_movements_reconciliation_v2 with corrected logic
DROP FUNCTION IF EXISTS import_financial_movements_reconciliation_v2(
  BIGINT, JSONB[], TEXT, DATE, DATE, TEXT
);

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
  v_movement_class_final TEXT;
  v_ledger_category_final TEXT;
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
  SELECT COALESCE(SUM(le.balance_impact), 0)
  INTO v_current_ledger_net
  FROM ledger_entry le
  INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
  WHERE mfm.account_id = p_account_id
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end;

  FOREACH v_row IN ARRAY p_input_rows LOOP
    v_idx := v_idx + 1;
    v_total_input := v_total_input + 1;

    v_explicit_payload_hash := NULL;
    v_collapse_detected := FALSE;

    IF p_source_type = 'liberaciones' THEN
      v_signed_impact := (v_row->>'NET_CREDIT_AMOUNT')::NUMERIC - (v_row->>'NET_DEBIT_AMOUNT')::NUMERIC;
      v_description := v_row->>'DESCRIPTION';
      v_source_id := v_row->>'SOURCE_ID';
      v_payload_hash := md5(v_row::text);
    ELSIF p_source_type = 'report' THEN
      v_signed_impact := (v_row->>'NET_CREDIT_AMOUNT')::NUMERIC - (v_row->>'NET_DEBIT_AMOUNT')::NUMERIC;
      v_description := v_row->>'DESCRIPTION';
      v_source_id := v_row->>'SOURCE_ID';
      v_explicit_payload_hash := v_row->>'_payload_hash';
      v_payload_hash := COALESCE(v_explicit_payload_hash, md5(v_row::text));
    END IF;

    v_economic_row_fp := compute_economic_row_fp(
      p_account_id, p_source_type, v_source_id, v_signed_impact,
      (v_row->>'DATE')::TIMESTAMP, v_description
    );

    v_economic_class := map_to_economic_class(p_source_type, v_description);

    v_cross_source_fp := compute_cross_source_fp(
      v_signed_impact, (v_row->>'DATE')::TIMESTAMP, v_economic_class
    );

    v_is_raw_only := is_raw_only(p_source_type, v_description);

    -- Check for existing source record
    IF p_source_type = 'report' AND v_explicit_payload_hash IS NOT NULL THEN
      SELECT msr.id, msr.account_id, msr.source_external_id
      INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND msr.payload_hash = v_explicit_payload_hash
        AND msr.account_id = p_account_id
      LIMIT 1;
    ELSE
      SELECT msr.id, msr.account_id, msr.source_external_id
      INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND md5(msr.raw_data::text) = v_payload_hash
        AND msr.account_id = p_account_id
      LIMIT 1;
    END IF;

    IF FOUND THEN
      v_existing_raw_exact := v_existing_raw_exact + 1;

      IF v_is_raw_only THEN
        v_raw_only_rows := v_raw_only_rows + 1;
      END IF;

      IF NOT v_is_raw_only THEN
        SELECT mfm.id, le.balance_impact
        INTO v_existing_fm_id, v_existing_le_balance
        FROM mp_movement_source_link msl
        INNER JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
        LEFT JOIN ledger_entry le ON le.financial_movement_id = mfm.id
          AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end
        WHERE msl.source_record_id = v_existing_sr.id
        LIMIT 1;

        IF v_existing_le_balance IS NOT NULL AND ABS(v_existing_le_balance - v_signed_impact) > 0.01 THEN
          v_collapse_detected := TRUE;
          v_create_fm_from_sr := v_create_fm_from_sr + 1;
        END IF;
      END IF;

      CONTINUE;
    END IF;

    v_new_source_records := v_new_source_records + 1;

    -- Create source record
    INSERT INTO mp_source_record (
      source_type, source_external_id, raw_data, account_id,
      economic_row_fp, cross_source_fp, payload_hash, observed_at
    )
    VALUES (
      p_source_type, v_source_id, v_row, p_account_id,
      v_economic_row_fp, v_cross_source_fp, v_payload_hash, NOW()
    )
    RETURNING id INTO v_new_sr_id;

    v_sr_ids := array_append(v_sr_ids, v_new_sr_id);

    IF NOT v_is_raw_only THEN
      -- Determine final movement_class and ledger_category based on description and sign
      -- FIX 1: asset_management → yield (interest_income)
      -- FIX 2: payment with sign → payment_in (income) or payment_out (expense)
      -- FIX 3: payout → transfer_out (transfer)
      -- NOTE: unknown descriptions should NOT reach here (filtered by Netlify)

      v_movement_class_final := CASE
        WHEN v_description = 'asset_management' THEN 'yield'
        WHEN v_description = 'payment' AND v_signed_impact > 0 THEN 'payment_in'
        WHEN v_description = 'payment' AND v_signed_impact < 0 THEN 'payment_out'
        WHEN v_description = 'payment' AND v_signed_impact = 0 THEN 'unclassified'
        WHEN v_description = 'payout' THEN 'transfer_out'
        ELSE 'unclassified'
      END;

      v_ledger_category_final := CASE
        WHEN v_movement_class_final = 'yield' THEN 'interest_income'
        WHEN v_movement_class_final = 'payment_in' THEN 'income'
        WHEN v_movement_class_final = 'payment_out' THEN 'expense'
        WHEN v_movement_class_final = 'transfer_out' THEN 'transfer'
        ELSE 'transfer'
      END;

      -- Try to find existing FM by economic fingerprint (for reports) or cross-source (for liberaciones)
      IF p_source_type = 'report' THEN
        SELECT * INTO v_existing_fm FROM get_existing_fm_by_econ_fp(p_account_id, v_economic_row_fp);
      ELSE
        SELECT fm_id, source_count, settlement_amount
        INTO v_existing_fm
        FROM get_fm_candidates_by_cross_fp(p_account_id, v_cross_source_fp);

        IF FOUND AND ABS(v_existing_fm.settlement_amount - v_signed_impact) > 0.01 THEN
          v_existing_fm := NULL;
        END IF;

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
        -- Create new FM with correct classification
        INSERT INTO mp_financial_movement (
          account_id, movement_class, settlement_amount,
          transaction_date, needs_review
        )
        VALUES (
          p_account_id,
          v_movement_class_final,
          v_signed_impact,
          (v_row->>'DATE')::TIMESTAMP,
          FALSE
        )
        RETURNING id INTO v_new_fm_id;

        v_new_financial_movements := v_new_financial_movements + 1;
        v_fm_ids := array_append(v_fm_ids, v_new_fm_id);

        -- Create ledger entry with correct category
        INSERT INTO ledger_entry (
          financial_movement_id, account_id, balance_impact, category, occurred_at
        )
        VALUES (
          v_new_fm_id, p_account_id, v_signed_impact,
          v_ledger_category_final,
          (v_row->>'DATE')::TIMESTAMP
        )
        RETURNING id INTO v_new_le_id;

        v_new_ledger_entries := v_new_ledger_entries + 1;
        v_le_ids := array_append(v_le_ids, v_new_le_id);

        -- Link SR to new FM
        INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
        VALUES (v_new_fm_id, v_new_sr_id, TRUE)
        RETURNING id INTO v_new_link_id;

        v_link_ids := array_append(v_link_ids, v_new_link_id);

        v_expected_delta := v_expected_delta + v_signed_impact;
      END IF;
    ELSE
      v_raw_only_rows := v_raw_only_rows + 1;
    END IF;
  END LOOP;

  v_expected_final := v_current_ledger_net + v_expected_delta;

  v_result := jsonb_build_object(
    'preview_mode', FALSE,
    'timestamp_utc', now()::TEXT,
    'account_id', p_account_id,
    'import_id', p_import_id,
    'import_complete', TRUE,
    'summary', jsonb_build_object(
      'total_input_rows', v_total_input,
      'existing_raw_exact_match', v_existing_raw_exact,
      'created_source_records', v_new_source_records,
      'created_financial_movements', v_new_financial_movements,
      'created_ledger_entries', v_new_ledger_entries,
      'created_links', array_length(v_link_ids, 1),
      'ambiguous_rows', v_ambiguous_rows,
      'raw_only_rows', v_raw_only_rows
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
      'link_ids', v_link_ids
    )
  );

  RETURN v_result;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION import_financial_movements_reconciliation_v2(BIGINT, JSONB[], TEXT, DATE, DATE, TEXT)
TO authenticated, service_role;
