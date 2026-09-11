-- ============================================================================
-- DEPLOY THIS TO: AppGranja → SQL Editor → Run
-- This is the ONLY SQL you need. Copy-paste everything and execute once.
-- It ONLY does CREATE OR REPLACE (no drops, no data modifications)
-- ============================================================================

-- Helper: is_raw_only() - returns TRUE for liberaciones reserves
CREATE OR REPLACE FUNCTION is_raw_only(
  p_source_type TEXT,
  p_description TEXT
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p_source_type = 'liberaciones' AND p_description IN ('reserve_for_payment', 'reserve_for_payout')
$$;

-- Helper: compute_economic_row_fp
CREATE OR REPLACE FUNCTION compute_economic_row_fp(
  p_account_id BIGINT,
  p_source_type TEXT,
  p_source_external_id TEXT,
  p_signed_impact NUMERIC,
  p_timestamp TIMESTAMP,
  p_description_or_type TEXT
) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(
    CONCAT(
      p_account_id::text, '|',
      p_source_type, '|',
      p_source_external_id, '|',
      SIGN(p_signed_impact)::text, '|',
      ROUND(ABS(p_signed_impact), 2)::text, '|',
      DATE_TRUNC('second', p_timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')::text, '|',
      p_description_or_type
    )
  )
$$;

-- Helper: compute_cross_source_fp
CREATE OR REPLACE FUNCTION compute_cross_source_fp(
  p_signed_impact NUMERIC,
  p_timestamp TIMESTAMP,
  p_economic_class TEXT
) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(
    CONCAT(
      SIGN(p_signed_impact)::text, '|',
      ROUND(ABS(p_signed_impact), 2)::text, '|',
      DATE_TRUNC('day', p_timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')::text, '|',
      p_economic_class
    )
  )
$$;

-- Helper: map_to_economic_class
CREATE OR REPLACE FUNCTION map_to_economic_class(
  p_source_type TEXT,
  p_description_or_type TEXT
) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_class TEXT;
BEGIN
  IF p_source_type = 'liberaciones' THEN
    CASE p_description_or_type
      WHEN 'payment' THEN v_class := 'PAYMENT';
      WHEN 'payout' THEN v_class := 'PAYOUT';
      WHEN 'asset_management' THEN v_class := 'PAYMENT';
      WHEN 'reserve_for_payment' THEN v_class := 'RESERVE';
      WHEN 'reserve_for_payout' THEN v_class := 'RESERVE';
      ELSE v_class := 'UNKNOWN';
    END CASE;
  ELSIF p_source_type = 'report' THEN
    CASE p_description_or_type
      WHEN 'SETTLEMENT' THEN v_class := 'PAYMENT';
      ELSE v_class := 'PAYMENT';
    END CASE;
  ELSE
    v_class := 'UNKNOWN';
  END IF;
  RETURN v_class;
END;
$$;

-- Helper: get_existing_fm_by_econ_fp
CREATE OR REPLACE FUNCTION get_existing_fm_by_econ_fp(
  p_account_id BIGINT,
  p_economic_row_fp TEXT
) RETURNS TABLE(fm_id BIGINT, settlement_amount NUMERIC, needs_review BOOLEAN)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT mfm.id, mfm.settlement_amount, mfm.needs_review
  FROM mp_financial_movement mfm
  INNER JOIN mp_movement_source_link mmsl ON mfm.id = mmsl.financial_movement_id
  INNER JOIN mp_source_record msr ON mmsl.source_record_id = msr.id
  WHERE mfm.account_id = p_account_id
    AND msr.economic_row_fp = p_economic_row_fp
  LIMIT 1
$$;

-- Helper: get_fm_candidates_by_cross_fp
CREATE OR REPLACE FUNCTION get_fm_candidates_by_cross_fp(
  p_account_id BIGINT,
  p_cross_source_fp TEXT
) RETURNS TABLE(fm_id BIGINT, source_count BIGINT, settlement_amount NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT mfm.id, COUNT(DISTINCT msr.id), mfm.settlement_amount
  FROM mp_financial_movement mfm
  INNER JOIN mp_movement_source_link mmsl ON mfm.id = mmsl.financial_movement_id
  INNER JOIN mp_source_record msr ON mmsl.source_record_id = msr.id
  WHERE mfm.account_id = p_account_id
    AND msr.cross_source_fp = p_cross_source_fp
  GROUP BY mfm.id, mfm.settlement_amount
$$;

-- Helper: find_exact_fm_for_liberaciones_reuse
-- Searches Report FM for exact Liberaciones match (account, impact, class, timestamp window, SOURCE_ID)
CREATE OR REPLACE FUNCTION find_exact_fm_for_liberaciones_reuse(
  p_account_id BIGINT,
  p_signed_impact NUMERIC,
  p_economic_class TEXT,
  p_timestamp TIMESTAMP,
  p_source_id TEXT
) RETURNS TABLE(fm_id BIGINT, settlement_amount NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT mfm.id, mfm.settlement_amount
  FROM mp_financial_movement mfm
  INNER JOIN mp_movement_source_link mmsl ON mfm.id = mmsl.financial_movement_id
  INNER JOIN mp_source_record msr ON mmsl.source_record_id = msr.id
  WHERE mfm.account_id = p_account_id
    AND mfm.settlement_amount = p_signed_impact
    AND msr.source_type = 'report'
    AND map_to_economic_class('report', msr.raw_data->>'TRANSACTION_TYPE') = p_economic_class
    AND ABS(EXTRACT(EPOCH FROM ((msr.raw_data->>'DATE')::TIMESTAMP - p_timestamp))) < 86400
    AND (p_source_id IS NULL OR msr.raw_data->>'SOURCE_ID' = p_source_id)
$$;

-- ============================================================================
-- MAIN PREVIEW FUNCTION - WITH RAW-ONLY FIX
-- Key fix: counts raw_only EVEN if SR already exists (line ~131, 164)
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
  v_reused_existing_fm INT := 0;
  v_payouts_created INT := 0;
  v_lib_only_cycle_created INT := 0;
  v_distinct_same_source INT := 0;
  v_row_is_ambiguous BOOLEAN := FALSE;
  v_row_has_existing_fm BOOLEAN := FALSE;

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
    v_row_is_ambiguous := FALSE;
    v_row_has_existing_fm := FALSE;

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

    v_economic_row_fp := compute_economic_row_fp(
      p_account_id, p_source_type, v_row->>'SOURCE_ID', v_signed_impact,
      (v_row->>'DATE')::TIMESTAMP, v_description
    );
    v_economic_class := map_to_economic_class(p_source_type, v_description);
    v_cross_source_fp := compute_cross_source_fp(
      v_signed_impact, (v_row->>'DATE')::TIMESTAMP, v_economic_class
    );
    v_is_raw_only := is_raw_only(p_source_type, v_description);

    IF p_source_type = 'report' AND v_explicit_payload_hash IS NOT NULL THEN
      SELECT msr.id, msr.account_id, msr.source_external_id
      INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND msr.payload_hash = v_explicit_payload_hash
        AND (msr.account_id = p_account_id OR msr.account_id IS NULL)
      LIMIT 1;
    ELSE
      SELECT msr.id, msr.account_id, msr.source_external_id
      INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND md5(msr.raw_data::text) = v_payload_hash
        AND (msr.account_id = p_account_id OR msr.account_id IS NULL)
      LIMIT 1;
    END IF;

    IF FOUND THEN
      v_existing_raw_exact := v_existing_raw_exact + 1;

      -- FIX: Count RAW-only EVEN if SR already exists (Liberaciones reserves)
      IF p_source_type = 'liberaciones' AND v_is_raw_only THEN
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
          v_new_financial_movements := v_new_financial_movements + 1;
          v_new_ledger_entries := v_new_ledger_entries + 1;
          v_expected_delta := v_expected_delta + v_signed_impact;
        END IF;
      END IF;

      CONTINUE;
    END IF;

    v_new_source_records := v_new_source_records + 1;

    IF v_is_raw_only THEN
      v_raw_only_rows := v_raw_only_rows + 1;
    ELSE
      IF p_source_type = 'report' THEN
        -- Layer 2: Report uses within-source economic_row_fp matching
        SELECT * INTO v_existing_fm FROM get_existing_fm_by_econ_fp(p_account_id, v_economic_row_fp);
      ELSE
        -- Layer 3: Liberaciones uses exact cross-source matching against Report FM
        SELECT fm_id, settlement_amount
        INTO v_existing_fm
        FROM find_exact_fm_for_liberaciones_reuse(
          p_account_id, v_signed_impact, v_economic_class,
          (v_row->>'DATE')::TIMESTAMP, v_row->>'SOURCE_ID'
        );

        IF FOUND THEN
          -- Check for ambiguity: more than 1 matching FM
          SELECT COUNT(DISTINCT fm_id) INTO v_distinct_same_source
          FROM find_exact_fm_for_liberaciones_reuse(
            p_account_id, v_signed_impact, v_economic_class,
            (v_row->>'DATE')::TIMESTAMP, v_row->>'SOURCE_ID'
          );

          IF v_distinct_same_source > 1 THEN
            -- Multiple FM match: ambiguous, don't create FM/LE
            v_row_is_ambiguous := TRUE;
            v_ambiguous_rows := v_ambiguous_rows + 1;
          ELSE
            -- Exactly 1 FM match: reuse it (no FM/LE creation, no delta change)
            v_row_has_existing_fm := TRUE;
            v_reused_existing_fm := v_reused_existing_fm + 1;
          END IF;
        END IF;
      END IF;

      -- Track payout and lib_only_cycle separately (only for Liberaciones new FM, not ambiguous)
      IF p_source_type = 'liberaciones' AND NOT v_row_has_existing_fm AND NOT v_row_is_ambiguous THEN
        IF v_description = 'payout' THEN
          v_payouts_created := v_payouts_created + 1;
        ELSIF v_description = 'asset_management' THEN
          v_lib_only_cycle_created := v_lib_only_cycle_created + 1;
        END IF;
      END IF;

      -- Create FM/LE only if: not ambiguous AND no existing FM to reuse
      IF v_row_has_existing_fm THEN
        NULL;
      ELSIF NOT v_row_is_ambiguous THEN
        v_new_financial_movements := v_new_financial_movements + 1;
        v_new_ledger_entries := v_new_ledger_entries + 1;
        v_expected_delta := v_expected_delta + v_signed_impact;
      END IF;
    END IF;
  END LOOP;

  v_expected_final := v_current_ledger_net + v_expected_delta;

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
      'reused_existing_fm', v_reused_existing_fm,
      'ambiguous_rows', v_ambiguous_rows,
      'raw_only_rows', v_raw_only_rows,
      'payouts_created', v_payouts_created,
      'lib_only_cycle_created', v_lib_only_cycle_created,
      'multi_settlement_corrections_created', v_create_fm_from_sr
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
