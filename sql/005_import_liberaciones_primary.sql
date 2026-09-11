-- RPC: import_liberaciones_primary v8
-- Atomic batch import of Liberaciones.csv records
-- Input: array of normalized JSON objects from import_liberaciones.py
-- Returns: {success, summary, created} with counts and IDs

CREATE OR REPLACE FUNCTION import_liberaciones_primary(
  p_account_id BIGINT,
  p_input JSONB[]
) RETURNS JSONB AS $$
DECLARE
  v_input_json JSONB;
  v_idx INTEGER;

  -- Input fields (lowercase from normalize_row)
  v_source_external_id VARCHAR;
  v_description VARCHAR;
  v_transaction_date TIMESTAMP WITH TIME ZONE;
  v_net_credit NUMERIC;
  v_net_debit NUMERIC;
  v_gross_amount NUMERIC;
  v_tax_amount NUMERIC;
  v_payment_method VARCHAR;
  v_payment_method_type VARCHAR;
  v_payload_hash VARCHAR;
  v_raw_data JSONB;

  -- Working variables
  v_source_record_id BIGINT;
  v_existing_link_id BIGINT;
  v_balance_impact NUMERIC;
  v_movement_class VARCHAR;
  v_existing_fm_id_from_report BIGINT;
  v_existing_le_id BIGINT;
  v_financial_movement_id BIGINT;
  v_ledger_entry_id BIGINT;
  v_link_id BIGINT;

  -- Versionado: previous record economics
  v_prev_sr_id BIGINT;
  v_prev_economic_hash VARCHAR(64);
  v_current_economic_hash VARCHAR(64);
  v_economic_changed BOOLEAN;

  -- Accumulators
  v_sr_created BIGINT := 0;
  v_sr_existing BIGINT := 0;
  v_sr_raw_only BIGINT := 0;
  v_fm_created BIGINT := 0;
  v_le_created BIGINT := 0;
  v_link_created BIGINT := 0;

  v_created_sr_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_fm_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_le_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_link_ids BIGINT[] := ARRAY[]::BIGINT[];

BEGIN

  -- Loop through input array
  FOR v_idx IN 1 .. array_length(p_input, 1) LOOP
    v_input_json := p_input[v_idx];

    -- Extract fields (lowercase keys from normalize_row)
    v_source_external_id := v_input_json->>'source_external_id';
    v_description := v_input_json->>'description';
    v_transaction_date := (v_input_json->>'transaction_date')::TIMESTAMP WITH TIME ZONE;
    v_net_credit := (v_input_json->>'net_credit')::NUMERIC;
    v_net_debit := (v_input_json->>'net_debit')::NUMERIC;
    v_gross_amount := (v_input_json->>'gross_amount')::NUMERIC;
    v_tax_amount := (v_input_json->>'tax_amount')::NUMERIC;
    v_payment_method := v_input_json->>'payment_method';
    v_payment_method_type := v_input_json->>'payment_method_type';
    v_payload_hash := v_input_json->>'payload_hash';
    v_raw_data := v_input_json->'raw_data';

    v_balance_impact := v_net_credit - v_net_debit;

    -- PASO 1: Create/retrieve mp_source_record (idempotent)
    INSERT INTO mp_source_record (
      account_id, source_type, source_external_id, payload_hash,
      description, transaction_date, raw_data, observed_at
    ) VALUES (
      p_account_id, 'liberaciones', v_source_external_id, v_payload_hash,
      v_description, v_transaction_date, v_raw_data, NOW()
    )
    ON CONFLICT (source_type, source_external_id, payload_hash) DO NOTHING
    RETURNING id INTO v_source_record_id;

    -- If SR not created, retrieve existing one
    IF v_source_record_id IS NULL THEN
      SELECT id INTO v_source_record_id
      FROM mp_source_record
      WHERE source_type = 'liberaciones'
        AND source_external_id = v_source_external_id
        AND payload_hash = v_payload_hash
      LIMIT 1;

      v_sr_existing := v_sr_existing + 1;
    ELSE
      v_sr_created := v_sr_created + 1;
      v_created_sr_ids := array_append(v_created_sr_ids, v_source_record_id);
    END IF;

    -- PASO 2: DESCRIPTION-first whitelist (RAW-only reserves)
    IF v_description IN ('reserve_for_payment', 'reserve_for_payout') THEN
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;

    IF v_description NOT IN ('payment', 'asset_management', 'payout') THEN
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;

    -- PASO 3: Idempotencia—check for existing LINK
    SELECT id INTO v_existing_link_id
    FROM mp_movement_source_link
    WHERE source_record_id = v_source_record_id
    LIMIT 1;

    IF v_existing_link_id IS NOT NULL THEN
      v_link_created := v_link_created + 1;
      CONTINUE;
    END IF;

    -- PASO 4: Versionado RAW same-source (economic change detection)
    SELECT id INTO v_prev_sr_id
    FROM mp_source_record
    WHERE source_type = 'liberaciones'
      AND source_external_id = v_source_external_id
      AND id != v_source_record_id
    ORDER BY observed_at DESC
    LIMIT 1;

    v_current_economic_hash := calc_liberaciones_economic_hash(
      v_source_external_id, v_net_credit, v_net_debit,
      v_gross_amount, v_tax_amount, v_transaction_date,
      v_description, v_payment_method
    );

    v_economic_changed := FALSE;
    IF v_prev_sr_id IS NOT NULL THEN
      -- Compare with previous version
      SELECT calc_liberaciones_economic_hash(
        source_external_id,
        (raw_data->>'NET_CREDIT_AMOUNT')::NUMERIC,
        (raw_data->>'NET_DEBIT_AMOUNT')::NUMERIC,
        (raw_data->>'GROSS_AMOUNT')::NUMERIC,
        (raw_data->>'TAXES_AMOUNT')::NUMERIC,
        transaction_date,
        description,
        raw_data->>'PAYMENT_METHOD'
      ) INTO v_prev_economic_hash
      FROM mp_source_record
      WHERE id = v_prev_sr_id;

      IF v_prev_economic_hash != v_current_economic_hash THEN
        v_economic_changed := TRUE;
      END IF;
    END IF;

    -- PASO 5: Correlación report (balance_impact = settlement_amount = balance_impact)
    v_existing_fm_id_from_report := NULL;

    SELECT fm.id INTO v_existing_fm_id_from_report
    FROM mp_financial_movement fm
    INNER JOIN ledger_entry le ON le.id = fm.ledger_entry_id
    WHERE fm.account_id = p_account_id
      AND fm.source_type = 'report'
      AND fm.settlement_amount = v_balance_impact
      AND le.balance_impact = v_balance_impact
    LIMIT 1;

    -- If economic change on payment/asset that has report correlation, flag needs_review
    IF v_economic_changed AND v_existing_fm_id_from_report IS NOT NULL THEN
      UPDATE mp_financial_movement
      SET needs_review = TRUE
      WHERE id = v_existing_fm_id_from_report;
    END IF;

    -- PASO 6: movement_class
    v_movement_class := 'unclassified';
    IF v_description = 'payment' THEN
      v_movement_class := 'payment_in';
    ELSIF v_description = 'asset_management' THEN
      v_movement_class := 'yield';
    END IF;

    -- PASO 7: Decidir (reutilizar vs crear FM)
    IF v_existing_fm_id_from_report IS NOT NULL THEN
      -- Reutilizar FM existente (correlacionado con report)
      v_financial_movement_id := v_existing_fm_id_from_report;
    ELSIF v_description IN ('payment', 'asset_management') THEN
      -- Payment/asset_management WITHOUT prior report correlation: ERROR
      RAISE EXCEPTION 'Payment/asset_management record has no report correlation (SR_ID=%)', v_source_external_id;
    ELSE
      -- Payout (nuevo): crear FM + LE
      INSERT INTO mp_financial_movement (
        account_id, source_type, settlement_amount, movement_class,
        needs_review, created_at
      ) VALUES (
        p_account_id, 'liberaciones', v_balance_impact, v_movement_class,
        CASE WHEN v_economic_changed THEN TRUE ELSE FALSE END, NOW()
      )
      RETURNING id INTO v_financial_movement_id;

      v_fm_created := v_fm_created + 1;
      v_created_fm_ids := array_append(v_created_fm_ids, v_financial_movement_id);

      -- Create ledger entry
      INSERT INTO ledger_entry (
        account_id, financial_movement_id, balance_impact, created_at
      ) VALUES (
        p_account_id, v_financial_movement_id, v_balance_impact, NOW()
      )
      RETURNING id INTO v_ledger_entry_id;

      v_le_created := v_le_created + 1;
      v_created_le_ids := array_append(v_created_le_ids, v_ledger_entry_id);

      -- Update FM with ledger_entry_id
      UPDATE mp_financial_movement
      SET ledger_entry_id = v_ledger_entry_id
      WHERE id = v_financial_movement_id;
    END IF;

    -- PASO 8: Insert LINK
    INSERT INTO mp_movement_source_link (
      financial_movement_id, source_record_id, created_at
    ) VALUES (
      v_financial_movement_id, v_source_record_id, NOW()
    )
    RETURNING id INTO v_link_id;

    v_link_created := v_link_created + 1;
    v_created_link_ids := array_append(v_created_link_ids, v_link_id);

  END LOOP;

  -- Return result
  RETURN jsonb_build_object(
    'success', TRUE,
    'summary', jsonb_build_object(
      'source_records_created', v_sr_created,
      'source_records_existing', v_sr_existing,
      'source_records_raw_only', v_sr_raw_only,
      'financial_movements_created', v_fm_created,
      'ledger_entries_created', v_le_created,
      'movement_source_links_created', v_link_created
    ),
    'created', jsonb_build_object(
      'source_record_ids', v_created_sr_ids,
      'financial_movement_ids', v_created_fm_ids,
      'ledger_entry_ids', v_created_le_ids,
      'link_ids', v_created_link_ids
    )
  );

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'import_liberaciones_primary error: %', SQLERRM;

END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION import_liberaciones_primary(BIGINT, JSONB[]) IS
  'Atomic batch import of Liberaciones records. Supports: 1) same-source economic change detection, 2) report correlation for payments/assets, 3) payout creation with idempotence, 4) checkpoint-based partial rollback.';
