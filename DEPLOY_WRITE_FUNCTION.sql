-- ============================================================================
-- DEPLOY WRITE FUNCTION: import_financial_movements_reconciliation_v2
-- Uses same logic as preview but performs actual INSERT/UPDATE to database
-- ============================================================================

CREATE OR REPLACE FUNCTION import_financial_movements_reconciliation_v2(
  p_account_id BIGINT,
  p_input_rows JSONB[],
  p_source_type TEXT,
  p_month_start DATE,
  p_month_end DATE
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_result JSONB := '{}'::JSONB;
  v_row JSONB;
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
  v_existing_fm_id BIGINT;
  v_existing_le_balance NUMERIC;
  v_new_fm_id BIGINT;
  v_new_le_id BIGINT;
  v_new_sr_id BIGINT;

  v_total_input INT := 0;
  v_created_sr INT := 0;
  v_created_fm INT := 0;
  v_created_le INT := 0;
  v_created_links INT := 0;
  v_reused_fm INT := 0;
  v_raw_only_rows INT := 0;
  v_ambiguous_rows INT := 0;
  v_multi_settlement_corrections INT := 0;

  v_expected_delta NUMERIC := 0;
  v_current_ledger_net NUMERIC;
  v_expected_final NUMERIC;
BEGIN
  -- Get current ledger balance for specified month
  SELECT COALESCE(SUM(le.balance_impact), 0)
  INTO v_current_ledger_net
  FROM ledger_entry le
  INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
  WHERE mfm.account_id = p_account_id
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end;

  -- Process each input row
  FOREACH v_row IN ARRAY p_input_rows LOOP
    v_total_input := v_total_input + 1;
    v_explicit_payload_hash := NULL;

    -- Parse row based on source type
    IF p_source_type = 'liberaciones' THEN
      v_signed_impact := (v_row->>'NET_CREDIT_AMOUNT')::NUMERIC - (v_row->>'NET_DEBIT_AMOUNT')::NUMERIC;
      v_description := v_row->>'DESCRIPTION';
      v_payload_hash := md5(v_row::text);
    ELSIF p_source_type = 'report' THEN
      v_signed_impact := (v_row->>'SETTLEMENT_NET_AMOUNT')::NUMERIC;
      v_description := v_row->>'TRANSACTION_TYPE';
      v_explicit_payload_hash := v_row->>'_payload_hash';
      v_payload_hash := COALESCE(v_explicit_payload_hash, md5(v_row::text));
    END IF;

    v_economic_row_fp := compute_economic_row_fp(p_account_id, p_source_type, v_row->>'SOURCE_ID', v_signed_impact, (v_row->>'DATE')::TIMESTAMP, v_description);
    v_economic_class := map_to_economic_class(p_source_type, v_description);
    v_cross_source_fp := compute_cross_source_fp(v_signed_impact, (v_row->>'DATE')::TIMESTAMP, v_economic_class);
    v_is_raw_only := is_raw_only(p_source_type, v_description);

    -- Layer 1: Check if SR already exists (idempotent deduplication)
    IF p_source_type = 'report' AND v_explicit_payload_hash IS NOT NULL THEN
      SELECT msr.id, msr.account_id INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND msr.payload_hash = v_explicit_payload_hash
        AND (msr.account_id = p_account_id OR msr.account_id IS NULL)
      LIMIT 1;
    ELSE
      SELECT msr.id, msr.account_id INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND md5(msr.raw_data::text) = v_payload_hash
        AND (msr.account_id = p_account_id OR msr.account_id IS NULL)
      LIMIT 1;
    END IF;

    IF FOUND THEN
      -- SR exists: check for multi-settlement collapse
      IF NOT v_is_raw_only THEN
        SELECT mfm.id, le.balance_impact
        INTO v_existing_fm_id, v_existing_le_balance
        FROM mp_movement_source_link msl
        INNER JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
        LEFT JOIN ledger_entry le ON le.financial_movement_id = mfm.id
          AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end
        WHERE msl.source_record_id = v_existing_sr.id
        LIMIT 1;

        -- Collapse detected: create new FM/LE for this SR
        IF v_existing_le_balance IS NOT NULL AND ABS(v_existing_le_balance - v_signed_impact) > 0.01 THEN
          v_multi_settlement_corrections := v_multi_settlement_corrections + 1;

          -- Insert new FM
          INSERT INTO mp_financial_movement (account_id, settlement_amount, needs_review)
          VALUES (p_account_id, v_signed_impact, FALSE)
          RETURNING id INTO v_new_fm_id;
          v_created_fm := v_created_fm + 1;

          -- Insert link
          INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id)
          VALUES (v_new_fm_id, v_existing_sr.id);
          v_created_links := v_created_links + 1;

          -- Insert LE
          INSERT INTO ledger_entry (financial_movement_id, balance_impact, occurred_at, record_type)
          VALUES (v_new_fm_id, v_signed_impact, (v_row->>'DATE')::TIMESTAMP, 'mp_financial_movement')
          RETURNING id INTO v_new_le_id;
          v_created_le := v_created_le + 1;

          v_expected_delta := v_expected_delta + v_signed_impact;
        END IF;
      ELSIF v_is_raw_only THEN
        v_raw_only_rows := v_raw_only_rows + 1;
      END IF;

      CONTINUE;
    END IF;

    -- SR does not exist: create new SR
    INSERT INTO mp_source_record (source_type, payload_hash, account_id, economic_row_fp, cross_source_fp, raw_data)
    VALUES (p_source_type, v_payload_hash, p_account_id, v_economic_row_fp, v_cross_source_fp, v_row)
    RETURNING id INTO v_new_sr_id;
    v_created_sr := v_created_sr + 1;

    IF v_is_raw_only THEN
      v_raw_only_rows := v_raw_only_rows + 1;
    ELSE
      -- Layer 3: Check for existing FM to reuse (Liberaciones only)
      SELECT fm_id INTO v_existing_fm_id
      FROM find_exact_fm_for_liberaciones_reuse(p_account_id, v_signed_impact, v_economic_class, (v_row->>'DATE')::TIMESTAMP, v_row->>'SOURCE_ID')
      LIMIT 1;

      IF FOUND THEN
        -- Reuse existing FM (no FM/LE creation, no delta change)
        INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id)
        VALUES (v_existing_fm_id, v_new_sr_id);
        v_created_links := v_created_links + 1;
        v_reused_fm := v_reused_fm + 1;
      ELSE
        -- Create new FM/LE
        INSERT INTO mp_financial_movement (account_id, settlement_amount, needs_review)
        VALUES (p_account_id, v_signed_impact, FALSE)
        RETURNING id INTO v_new_fm_id;
        v_created_fm := v_created_fm + 1;

        INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id)
        VALUES (v_new_fm_id, v_new_sr_id);
        v_created_links := v_created_links + 1;

        INSERT INTO ledger_entry (financial_movement_id, balance_impact, occurred_at, record_type)
        VALUES (v_new_fm_id, v_signed_impact, (v_row->>'DATE')::TIMESTAMP, 'mp_financial_movement')
        RETURNING id INTO v_new_le_id;
        v_created_le := v_created_le + 1;

        v_expected_delta := v_expected_delta + v_signed_impact;
      END IF;
    END IF;
  END LOOP;

  v_expected_final := v_current_ledger_net + v_expected_delta;

  v_result := jsonb_build_object(
    'import_complete', TRUE,
    'timestamp_utc', now()::TEXT,
    'account_id', p_account_id,
    'summary', jsonb_build_object(
      'total_input_rows', v_total_input,
      'created_source_records', v_created_sr,
      'created_financial_movements', v_created_fm,
      'created_ledger_entries', v_created_le,
      'created_links', v_created_links,
      'reused_existing_fm', v_reused_fm,
      'raw_only_rows', v_raw_only_rows,
      'ambiguous_rows', v_ambiguous_rows,
      'multi_settlement_corrections', v_multi_settlement_corrections
    ),
    'financial_impact', jsonb_build_object(
      'current_ledger_net_pre_import', v_current_ledger_net,
      'expected_delta', v_expected_delta,
      'expected_ledger_net_post_import', v_expected_final
    )
  );

  RETURN v_result;
END;
$$;
