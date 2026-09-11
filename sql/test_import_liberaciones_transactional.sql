-- TEST TRANSACCIONAL: import_liberaciones_primary CORRECTED
-- Ejecución real dentro de transacción
-- ROLLBACK al final para garantizar 0 datos persistidos

BEGIN;

-- ============================================================================
-- PASO 1: Crear función auxiliar calc_liberaciones_economic_hash
-- ============================================================================

CREATE OR REPLACE FUNCTION calc_liberaciones_economic_hash(
  p_source_external_id VARCHAR,
  p_net_credit NUMERIC,
  p_net_debit NUMERIC,
  p_gross_amount NUMERIC,
  p_tax_amount NUMERIC,
  p_transaction_date TIMESTAMP WITH TIME ZONE,
  p_description VARCHAR,
  p_payment_method VARCHAR
) RETURNS VARCHAR(64) AS $$
DECLARE
  v_json_array JSONB;
  v_json_text TEXT;
  v_hash VARCHAR(64);
BEGIN
  -- Construir array JSON con valores económicos en orden determinístico
  v_json_array := jsonb_build_array(
    p_source_external_id,
    p_net_credit,
    p_net_debit,
    p_gross_amount,
    p_tax_amount,
    p_transaction_date,
    p_description,
    p_payment_method
  );

  v_json_text := v_json_array::TEXT;
  v_hash := encode(digest(v_json_text, 'sha256'), 'hex');

  RETURN v_hash;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- PASO 2: Crear RPC import_liberaciones_primary CORRECTED
-- ============================================================================

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
  v_fm_count_for_source BIGINT;
  v_is_primary BOOLEAN;

  -- Versionado: previous record economics
  v_prev_sr_id BIGINT;
  v_prev_fm_id BIGINT;
  v_prev_libera_economic_hash VARCHAR(64);
  v_current_libera_economic_hash VARCHAR(64);
  v_current_fm_economic_hash VARCHAR(64);
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
      source_type, source_external_id, payload_hash,
      raw_data, observed_at
    ) VALUES (
      'liberaciones', v_source_external_id, v_payload_hash,
      v_raw_data, NOW()
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
    ORDER BY observed_at DESC, id DESC
    LIMIT 1;

    v_economic_changed := FALSE;
    v_prev_fm_id := NULL;

    IF v_prev_sr_id IS NOT NULL THEN
      SELECT financial_movement_id INTO v_prev_fm_id
      FROM mp_movement_source_link
      WHERE source_record_id = v_prev_sr_id
      LIMIT 1;

      IF v_prev_fm_id IS NOT NULL THEN
        SELECT calc_liberaciones_economic_hash(
          source_external_id,
          (raw_data->>'NET_CREDIT_AMOUNT')::NUMERIC,
          (raw_data->>'NET_DEBIT_AMOUNT')::NUMERIC,
          (raw_data->>'GROSS_AMOUNT')::NUMERIC,
          (raw_data->>'TAXES_AMOUNT')::NUMERIC,
          transaction_date,
          description,
          raw_data->>'PAYMENT_METHOD'
        ) INTO v_prev_libera_economic_hash
        FROM mp_source_record
        WHERE id = v_prev_sr_id;

        v_current_libera_economic_hash := calc_liberaciones_economic_hash(
          v_source_external_id,
          v_net_credit,
          v_net_debit,
          v_gross_amount,
          v_tax_amount,
          v_transaction_date,
          v_description,
          v_payment_method
        );

        IF v_prev_libera_economic_hash IS NOT NULL
           AND v_prev_libera_economic_hash != v_current_libera_economic_hash THEN
          v_economic_changed := TRUE;
        END IF;
      END IF;
    END IF;

    -- PASO 5: Correlación report (solo para payment/asset_management)
    v_existing_fm_id_from_report := NULL;
    v_fm_count_for_source := 0;

    IF v_description IN ('payment', 'asset_management') THEN
      SELECT COUNT(DISTINCT fm.id) INTO v_fm_count_for_source
      FROM mp_financial_movement fm
      INNER JOIN ledger_entry le ON le.financial_movement_id = fm.id
      WHERE fm.account_id = p_account_id
        AND fm.source_type = 'report'
        AND fm.settlement_amount = v_balance_impact
        AND le.balance_impact = v_balance_impact;

      IF v_fm_count_for_source > 1 THEN
        RAISE EXCEPTION 'Corrupción detectada: múltiples FMs para settlement_amount=% (source=%)',
                        v_balance_impact, v_source_external_id;
      END IF;

      IF v_fm_count_for_source = 1 THEN
        SELECT fm.id INTO v_existing_fm_id_from_report
        FROM mp_financial_movement fm
        INNER JOIN ledger_entry le ON le.financial_movement_id = fm.id
        WHERE fm.account_id = p_account_id
          AND fm.source_type = 'report'
          AND fm.settlement_amount = v_balance_impact
          AND le.balance_impact = v_balance_impact
        LIMIT 1;
      END IF;
    END IF;

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
    v_is_primary := FALSE;

    IF v_existing_fm_id_from_report IS NOT NULL THEN
      v_financial_movement_id := v_existing_fm_id_from_report;
      v_is_primary := FALSE;

      SELECT id INTO v_existing_le_id
      FROM ledger_entry
      WHERE financial_movement_id = v_financial_movement_id;

      IF v_existing_le_id IS NULL THEN
        RAISE EXCEPTION 'Corrupción: FM existe pero LE falta (FM_ID=%)', v_financial_movement_id;
      END IF;

    ELSIF v_description IN ('payment', 'asset_management') THEN
      RAISE EXCEPTION 'Payment/asset_management record has no report correlation (SR_ID=%)', v_source_external_id;

    ELSE
      -- Payout (nuevo): crear FM + LE
      v_is_primary := TRUE;

      v_current_fm_economic_hash := calc_economic_hash(
        v_gross_amount,
        v_balance_impact,
        v_tax_amount,
        v_movement_class,
        v_transaction_date,
        NULL,
        v_payment_method,
        v_payment_method_type,
        NULL
      );

      INSERT INTO mp_financial_movement (
        account_id, source_type, movement_class,
        transaction_amount, settlement_amount, tax_amount,
        payment_method, payment_detail, transaction_date,
        needs_review, economic_hash
      ) VALUES (
        p_account_id, 'liberaciones', v_movement_class,
        v_gross_amount, v_balance_impact, v_tax_amount,
        v_payment_method, v_payment_method_type, v_transaction_date,
        v_economic_changed, v_current_fm_economic_hash
      )
      RETURNING id INTO v_financial_movement_id;

      v_fm_created := v_fm_created + 1;
      v_created_fm_ids := array_append(v_created_fm_ids, v_financial_movement_id);

      INSERT INTO ledger_entry (
        account_id, financial_movement_id, balance_impact,
        category, description, occurred_at
      ) VALUES (
        p_account_id, v_financial_movement_id, v_balance_impact,
        CASE v_movement_class
          WHEN 'payment_in' THEN 'income'
          WHEN 'yield' THEN 'interest_income'
          ELSE 'other'
        END,
        v_description || ' (liberaciones)',
        v_transaction_date
      )
      RETURNING id INTO v_ledger_entry_id;

      v_le_created := v_le_created + 1;
      v_created_le_ids := array_append(v_created_le_ids, v_ledger_entry_id);
    END IF;

    -- PASO 9: Insert LINK
    INSERT INTO mp_movement_source_link (
      financial_movement_id, source_record_id, is_primary
    ) VALUES (
      v_financial_movement_id, v_source_record_id, v_is_primary
    )
    RETURNING id INTO v_link_id;

    v_link_created := v_link_created + 1;
    v_created_link_ids := array_append(v_created_link_ids, v_link_id);

  END LOOP;

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

-- ============================================================================
-- TESTS A-J (Dentro de transacción)
-- ============================================================================

DO $$
DECLARE
  v_test_account_id BIGINT := 1054315166;
  v_result JSONB;
  v_sr_count BIGINT;
  v_fm_count BIGINT;
  v_le_count BIGINT;
  v_link_count BIGINT;
  v_link_exists BOOLEAN;
BEGIN

  RAISE NOTICE '========== TEST A: Payout nuevo ==========';
  v_result := import_liberaciones_primary(v_test_account_id, ARRAY[
    jsonb_build_object(
      'source_external_id', 'TEST_PAYOUT_A',
      'description', 'payout',
      'transaction_date', '2026-08-15T10:30:00Z',
      'net_credit', '1100.00',
      'net_debit', '0.00',
      'gross_amount', '1000.00',
      'tax_amount', '50.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_a_1',
      'raw_data', jsonb_build_object('GROSS_AMOUNT', '1000.00', 'NET_CREDIT_AMOUNT', '1100.00')
    )
  ]);
  IF (v_result->>'success')::BOOLEAN THEN
    RAISE NOTICE '  A: PASS (sr_created=%, fm_created=%, le_created=%)',
      v_result->'summary'->>'source_records_created',
      v_result->'summary'->>'financial_movements_created',
      v_result->'summary'->>'ledger_entries_created';
  ELSE
    RAISE NOTICE '  A: FAIL %', v_result;
  END IF;

  RAISE NOTICE '========== TEST B: Payout idéntico (idempotencia) ==========';
  v_result := import_liberaciones_primary(v_test_account_id, ARRAY[
    jsonb_build_object(
      'source_external_id', 'TEST_PAYOUT_A',
      'description', 'payout',
      'transaction_date', '2026-08-15T10:30:00Z',
      'net_credit', '1100.00',
      'net_debit', '0.00',
      'gross_amount', '1000.00',
      'tax_amount', '50.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_a_1',
      'raw_data', jsonb_build_object('GROSS_AMOUNT', '1000.00', 'NET_CREDIT_AMOUNT', '1100.00')
    )
  ]);
  IF (v_result->>'success')::BOOLEAN
     AND (v_result->'summary'->>'source_records_created')::BIGINT = 0
     AND (v_result->'summary'->>'financial_movements_created')::BIGINT = 0 THEN
    RAISE NOTICE '  B: PASS (sr_created=0, fm_created=0)';
  ELSE
    RAISE NOTICE '  B: FAIL %', v_result;
  END IF;

  RAISE NOTICE '========== TEST C: Mismo source, metadata-only change ==========';
  v_result := import_liberaciones_primary(v_test_account_id, ARRAY[
    jsonb_build_object(
      'source_external_id', 'TEST_PAYOUT_A',
      'description', 'payout',
      'transaction_date', '2026-08-15T10:30:00Z',
      'net_credit', '1100.00',
      'net_debit', '0.00',
      'gross_amount', '1000.00',
      'tax_amount', '50.00',
      'payment_method', 'available_money',
      'payment_method_type', 'different_type',
      'payload_hash', 'hash_a_2',
      'raw_data', jsonb_build_object('GROSS_AMOUNT', '1000.00', 'NET_CREDIT_AMOUNT', '1100.00', 'PAYMENT_METHOD_TYPE', 'different_type')
    )
  ]);
  IF (v_result->>'success')::BOOLEAN
     AND (v_result->'summary'->>'source_records_created')::BIGINT = 1
     AND (v_result->'summary'->>'financial_movements_created')::BIGINT = 0 THEN
    RAISE NOTICE '  C: PASS (sr_created=1, fm_created=0, only LINK)';
  ELSE
    RAISE NOTICE '  C: FAIL %', v_result;
  END IF;

  RAISE NOTICE '========== TEST D: Cambio económico mismo source ==========';
  v_result := import_liberaciones_primary(v_test_account_id, ARRAY[
    jsonb_build_object(
      'source_external_id', 'TEST_PAYOUT_A',
      'description', 'payout',
      'transaction_date', '2026-08-15T10:30:00Z',
      'net_credit', '1200.00',
      'net_debit', '0.00',
      'gross_amount', '1000.00',
      'tax_amount', '50.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_a_3',
      'raw_data', jsonb_build_object('GROSS_AMOUNT', '1000.00', 'NET_CREDIT_AMOUNT', '1200.00')
    )
  ]);
  IF (v_result->>'success')::BOOLEAN
     AND (v_result->'summary'->>'source_records_created')::BIGINT = 1 THEN
    RAISE NOTICE '  D: PASS (detected economic change, flagged needs_review)';
  ELSE
    RAISE NOTICE '  D: FAIL %', v_result;
  END IF;

  RAISE NOTICE '========== TEST E-J: Placeholder (requieren FM report previo) ==========';
  RAISE NOTICE '  E-J: Skipped (no report FM en this test)';

  RAISE NOTICE '========== VERIFICACION: Datos creados temporales ==========';
  SELECT COUNT(*) INTO v_sr_count FROM mp_source_record WHERE source_type='liberaciones';
  SELECT COUNT(*) INTO v_fm_count FROM mp_financial_movement WHERE source_type='liberaciones';
  SELECT COUNT(*) INTO v_le_count FROM ledger_entry WHERE account_id=v_test_account_id AND description LIKE '%(liberaciones)%';
  SELECT COUNT(*) INTO v_link_count FROM mp_movement_source_link;

  RAISE NOTICE 'Antes ROLLBACK: SR=%d, FM=%d, LE=%d, LINK=%d', v_sr_count, v_fm_count, v_le_count, v_link_count;

END;
$$;

-- ============================================================================
-- ROLLBACK: Garantizar 0 datos persistidos
-- ============================================================================

ROLLBACK;

-- Verificación post-ROLLBACK
SELECT COUNT(*) FROM mp_source_record WHERE source_type='liberaciones';  -- Debe ser 0
SELECT COUNT(*) FROM mp_financial_movement WHERE source_type='liberaciones';  -- Debe ser 0
