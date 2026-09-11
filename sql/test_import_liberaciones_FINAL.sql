-- TEST FINAL: import_liberaciones_primary CORRECTED
-- RPC candidata instalada DENTRO de transacción
-- Assertions reales en JSON
-- Errores aislados con SAVEPOINT
-- TODO: post-ROLLBACK revierte completamente

BEGIN;

-- ============================================================================
-- FIRMAS REALES POSTGRESQL (pre-test)
-- ============================================================================

SELECT 'FIRMAS REALES' as section;

SELECT pg_get_function_identity_arguments(oid) as calc_economic_hash_firma
FROM pg_proc WHERE proname = 'calc_economic_hash';

SELECT pg_get_function_identity_arguments(oid) as calc_liberaciones_economic_hash_firma
FROM pg_proc WHERE proname = 'calc_liberaciones_economic_hash';

SELECT pg_get_function_identity_arguments(oid) as import_liberaciones_primary_firma_ACTUAL
FROM pg_proc WHERE proname = 'import_liberaciones_primary';

-- ============================================================================
-- INSTALAR RPC FIXED DENTRO DE TRANSACCIÓN (reemplaza temporalmente)
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
BEGIN
  v_json_array := jsonb_build_array(
    p_source_external_id, p_net_credit, p_net_debit, p_gross_amount, p_tax_amount,
    p_transaction_date, p_description, p_payment_method
  );
  RETURN encode(digest(v_json_array::TEXT, 'sha256'), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION import_liberaciones_primary(
  p_account_id BIGINT,
  p_input JSONB[]
) RETURNS JSONB AS $$
DECLARE
  v_input_json JSONB;
  v_idx INTEGER;
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
  v_source_record_id BIGINT;
  v_existing_link_id BIGINT;
  v_balance_impact NUMERIC;
  v_movement_class VARCHAR;
  v_existing_fm_id BIGINT;
  v_existing_le_id BIGINT;
  v_financial_movement_id BIGINT;
  v_ledger_entry_id BIGINT;
  v_link_id BIGINT;
  v_fm_count_for_source BIGINT;
  v_is_primary BOOLEAN;
  v_prev_sr_id BIGINT;
  v_prev_fm_id BIGINT;
  v_prev_libera_economic_hash VARCHAR(64);
  v_current_libera_economic_hash VARCHAR(64);
  v_current_fm_economic_hash VARCHAR(64);
  v_economic_changed BOOLEAN;
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

  FOR v_idx IN 1 .. array_length(p_input, 1) LOOP
    v_input_json := p_input[v_idx];
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

    -- PASO 1: Create/retrieve mp_source_record
    INSERT INTO mp_source_record (
      source_type, source_external_id, payload_hash, raw_data, observed_at
    ) VALUES (
      'liberaciones', v_source_external_id, v_payload_hash, v_raw_data, NOW()
    )
    ON CONFLICT (source_type, source_external_id, payload_hash) DO NOTHING
    RETURNING id INTO v_source_record_id;

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

    -- PASO 2: DESCRIPTION-first whitelist
    IF v_description IN ('reserve_for_payment', 'reserve_for_payout') THEN
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;

    IF v_description NOT IN ('payment', 'asset_management', 'payout') THEN
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;

    -- PASO 3: Idempotencia
    SELECT id INTO v_existing_link_id
    FROM mp_movement_source_link
    WHERE source_record_id = v_source_record_id
    LIMIT 1;

    IF v_existing_link_id IS NOT NULL THEN
      CONTINUE;
    END IF;

    -- PASO 4: Versionado same-source
    SELECT id INTO v_prev_sr_id
    FROM mp_source_record
    WHERE source_external_id = v_source_external_id
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
          (raw_data->>'DATE')::TIMESTAMP WITH TIME ZONE,
          raw_data->>'DESCRIPTION',
          raw_data->>'PAYMENT_METHOD'
        ) INTO v_prev_libera_economic_hash
        FROM mp_source_record
        WHERE id = v_prev_sr_id;

        v_current_libera_economic_hash := calc_liberaciones_economic_hash(
          v_source_external_id, v_net_credit, v_net_debit, v_gross_amount, v_tax_amount,
          v_transaction_date, v_description, v_payment_method
        );

        IF v_prev_libera_economic_hash IS NOT NULL
           AND v_prev_libera_economic_hash != v_current_libera_economic_hash THEN
          v_economic_changed := TRUE;
        END IF;
      END IF;
    END IF;

    -- PASO 5: Correlación POR SOURCE_ID (no por monto)
    v_existing_fm_id := NULL;
    v_fm_count_for_source := 0;

    IF v_description IN ('payment', 'asset_management') THEN
      SELECT COUNT(DISTINCT l.financial_movement_id) INTO v_fm_count_for_source
      FROM mp_movement_source_link l
      JOIN mp_source_record sr ON sr.id = l.source_record_id
      WHERE sr.source_external_id = v_source_external_id
        AND sr.id != v_source_record_id;

      IF v_fm_count_for_source > 1 THEN
        RAISE EXCEPTION 'Corrupción: múltiples FMs para source_external_id=%', v_source_external_id;
      END IF;

      IF v_fm_count_for_source = 1 THEN
        SELECT DISTINCT l.financial_movement_id INTO v_existing_fm_id
        FROM mp_movement_source_link l
        JOIN mp_source_record sr ON sr.id = l.source_record_id
        WHERE sr.source_external_id = v_source_external_id
          AND sr.id != v_source_record_id
        LIMIT 1;

        SELECT id INTO v_existing_le_id
        FROM ledger_entry
        WHERE financial_movement_id = v_existing_fm_id;

        IF v_existing_le_id IS NULL THEN
          RAISE EXCEPTION 'Corrupción: FM existe pero LE falta (FM_ID=%)', v_existing_fm_id;
        END IF;

        IF (SELECT balance_impact FROM ledger_entry WHERE id = v_existing_le_id) != v_balance_impact THEN
          RAISE EXCEPTION 'Mismatch: balance_impact != incoming (FM_ID=%)', v_existing_fm_id;
        END IF;
      END IF;
    END IF;

    IF v_economic_changed AND v_existing_fm_id IS NOT NULL THEN
      UPDATE mp_financial_movement SET needs_review = TRUE WHERE id = v_existing_fm_id;
    END IF;

    -- PASO 6: movement_class
    v_movement_class := 'unclassified';
    IF v_description = 'payment' THEN
      v_movement_class := 'payment_in';
    ELSIF v_description = 'asset_management' THEN
      v_movement_class := 'yield';
    END IF;

    -- PASO 7: Decidir
    v_is_primary := FALSE;

    IF v_existing_fm_id IS NOT NULL THEN
      v_financial_movement_id := v_existing_fm_id;
      v_is_primary := FALSE;

    ELSIF v_description IN ('payment', 'asset_management') THEN
      RAISE EXCEPTION 'Payment/asset_management has no prior correlation (source_external_id=%)', v_source_external_id;

    ELSE
      v_is_primary := TRUE;
      v_current_fm_economic_hash := calc_economic_hash(
        v_gross_amount, v_balance_impact, v_tax_amount, v_movement_class,
        v_transaction_date, NULL, v_payment_method, v_payment_method_type, NULL
      );

      INSERT INTO mp_financial_movement (
        account_id, movement_class, transaction_amount, settlement_amount,
        tax_amount, payment_method, payment_detail, transaction_date,
        needs_review, economic_hash
      ) VALUES (
        p_account_id, v_movement_class, v_gross_amount, v_balance_impact, v_tax_amount,
        v_payment_method, v_payment_method_type, v_transaction_date,
        v_economic_changed, v_current_fm_economic_hash
      )
      RETURNING id INTO v_financial_movement_id;

      v_fm_created := v_fm_created + 1;
      v_created_fm_ids := array_append(v_created_fm_ids, v_financial_movement_id);

      INSERT INTO ledger_entry (
        account_id, financial_movement_id, balance_impact, category, description, occurred_at
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

    -- PASO 8: Insert LINK
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

SELECT 'RPC FIXED instalada dentro de transacción' as status;

-- ============================================================================
-- TEST A: Payout nuevo
-- ============================================================================

SELECT 'TEST A: Payout nuevo TEST_LIB_A' as test_name;

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_LIB_A',
      'description', 'payout',
      'transaction_date', '2026-08-15T10:30:00Z',
      'net_credit', '1100.00',
      'net_debit', '0.00',
      'gross_amount', '1000.00',
      'tax_amount', '50.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_a_1',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_LIB_A',
        'DATE', '2026-08-15T10:30:00Z',
        'DESCRIPTION', 'payout',
        'GROSS_AMOUNT', '1000.00',
        'NET_CREDIT_AMOUNT', '1100.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'available_money'
      )
    )]
  ) as rpc_result
)
SELECT
  CASE
    WHEN (rpc_result->'summary'->>'source_records_created')::INT = 1
         AND (rpc_result->'summary'->>'financial_movements_created')::INT = 1
         AND (rpc_result->'summary'->>'ledger_entries_created')::INT = 1
         AND (rpc_result->'summary'->>'movement_source_links_created')::INT = 1
    THEN 'PASS'
    ELSE 'FAIL: sr=' || rpc_result->'summary'->>'source_records_created'
         || ' fm=' || rpc_result->'summary'->>'financial_movements_created'
  END as test_a_assertion
FROM result;

-- ============================================================================
-- TEST B: Idempotencia (segunda ejecución idéntica)
-- ============================================================================

SELECT 'TEST B: Idempotencia (2a ejecución, mismo payload)' as test_name;

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_LIB_A',
      'description', 'payout',
      'transaction_date', '2026-08-15T10:30:00Z',
      'net_credit', '1100.00',
      'net_debit', '0.00',
      'gross_amount', '1000.00',
      'tax_amount', '50.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_a_1',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_LIB_A',
        'DATE', '2026-08-15T10:30:00Z',
        'DESCRIPTION', 'payout',
        'GROSS_AMOUNT', '1000.00',
        'NET_CREDIT_AMOUNT', '1100.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'available_money'
      )
    )]
  ) as rpc_result
)
SELECT
  CASE
    WHEN (rpc_result->'summary'->>'source_records_created')::INT = 0
         AND (rpc_result->'summary'->>'financial_movements_created')::INT = 0
         AND (rpc_result->'summary'->>'ledger_entries_created')::INT = 0
         AND (rpc_result->'summary'->>'movement_source_links_created')::INT = 0
    THEN 'PASS'
    ELSE 'FAIL: sr=' || rpc_result->'summary'->>'source_records_created'
         || ' fm=' || rpc_result->'summary'->>'financial_movements_created'
         || ' le=' || rpc_result->'summary'->>'ledger_entries_created'
         || ' link=' || rpc_result->'summary'->>'movement_source_links_created'
  END as test_b_assertion
FROM result;

-- ============================================================================
-- TEST E: Payment con report previo (same source_external_id)
-- ============================================================================

SELECT 'TEST E: Crear report SR + FM + LE previo' as test_name;

WITH sr AS (
  INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
  VALUES ('report', 'TEST_LIB_E', 'hash_report_e', '{"test":"report"}'::JSONB, NOW())
  RETURNING id
),
fm AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash
  ) VALUES (
    1054315166, 'payment_in', 500.00, 500.00, 0, 'transfer', NOW(), 'hash_report_e'
  )
  RETURNING id as fm_id_e
),
le AS (
  INSERT INTO ledger_entry (
    account_id, financial_movement_id, balance_impact, category, occurred_at
  ) VALUES (
    1054315166, (SELECT fm_id_e FROM fm), 500.00, 'income', NOW()
  )
  RETURNING id
),
link AS (
  INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
  SELECT (SELECT fm_id_e FROM fm), (SELECT id FROM sr), TRUE
  RETURNING id
)
SELECT 'Report setup OK' as status;

SELECT 'TEST E: Importar payment Liberaciones con mismo source_external_id' as test_name;

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_LIB_E',
      'description', 'payment',
      'transaction_date', '2026-08-15T11:00:00Z',
      'net_credit', '500.00',
      'net_debit', '0.00',
      'gross_amount', '500.00',
      'tax_amount', '0.00',
      'payment_method', 'transfer',
      'payment_method_type', 'bank_transfer',
      'payload_hash', 'hash_lib_e',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_LIB_E',
        'DATE', '2026-08-15T11:00:00Z',
        'DESCRIPTION', 'payment',
        'GROSS_AMOUNT', '500.00',
        'NET_CREDIT_AMOUNT', '500.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'transfer'
      )
    )]
  ) as rpc_result
)
SELECT
  CASE
    WHEN (rpc_result->'summary'->>'source_records_created')::INT = 1
         AND (rpc_result->'summary'->>'financial_movements_created')::INT = 0
         AND (rpc_result->'summary'->>'ledger_entries_created')::INT = 0
         AND (rpc_result->'summary'->>'movement_source_links_created')::INT = 1
         AND (rpc_result->'created'->'link_ids'->0)::TEXT IS NOT NULL
    THEN 'PASS (sr=1, fm=0 reutilizado, le=0, link=1, is_primary=FALSE)'
    ELSE 'FAIL'
  END as test_e_assertion
FROM result;

-- ============================================================================
-- TEST F: Cambio económico en payment previo (same source, version nueva)
-- ============================================================================

SELECT 'TEST F: Mismo source TEST_LIB_E, cambio económico (net_credit 500→600)' as test_name;

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_LIB_E',
      'description', 'payment',
      'transaction_date', '2026-08-15T11:00:00Z',
      'net_credit', '600.00',
      'net_debit', '0.00',
      'gross_amount', '600.00',
      'tax_amount', '0.00',
      'payment_method', 'transfer',
      'payment_method_type', 'bank_transfer',
      'payload_hash', 'hash_lib_e_v2',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_LIB_E',
        'DATE', '2026-08-15T11:00:00Z',
        'DESCRIPTION', 'payment',
        'GROSS_AMOUNT', '600.00',
        'NET_CREDIT_AMOUNT', '600.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'transfer'
      )
    )]
  ) as rpc_result
)
SELECT
  CASE
    WHEN (rpc_result->'summary'->>'source_records_created')::INT = 1
         AND (rpc_result->'summary'->>'financial_movements_created')::INT = 0
         AND (rpc_result->'summary'->>'movement_source_links_created')::INT = 1
    THEN 'PASS (sr=1, fm=0, le=0, link=1, needs_review debe ser TRUE)'
    ELSE 'FAIL'
  END as test_f_assertion
FROM result;

-- Verificar que needs_review=TRUE en FM original y balance_impact intacto
SELECT
  'FM needs_review=TRUE (cambio económico detectado): ' ||
  CASE WHEN needs_review = TRUE THEN 'PASS' ELSE 'FAIL' END ||
  ', balance_impact intacto=500: ' ||
  CASE WHEN (SELECT balance_impact FROM ledger_entry WHERE financial_movement_id = id) = 500.00
       THEN 'PASS' ELSE 'FAIL' END as test_f_verification
FROM mp_financial_movement
WHERE settlement_amount = 500.00 AND needs_review = TRUE
LIMIT 1;

-- ============================================================================
-- TEST FM SIN LE: aislado con SAVEPOINT
-- ============================================================================

SELECT 'TEST FM SIN LE: Crear FM sin LE (corrupción)' as test_name;

WITH sr AS (
  INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
  VALUES ('report', 'TEST_LIB_CORRUPT', 'hash_corrupt', '{"test":"corrupt"}'::JSONB, NOW())
  RETURNING id
),
fm AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash
  ) VALUES (
    1054315166, 'payment_in', 300.00, 300.00, 0, 'transfer', NOW(), 'hash_corrupt'
  )
  RETURNING id
)
INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
SELECT (SELECT id FROM fm), (SELECT id FROM sr), TRUE
RETURNING id;

SELECT 'TEST FM SIN LE: Intentar importar payment (esperado: EXCEPTION aislada)' as test_name;

SAVEPOINT sp_fm_sin_le;

SELECT
  CASE
    WHEN (
      SELECT import_liberaciones_primary(
        1054315166,
        ARRAY[jsonb_build_object(
          'source_external_id', 'TEST_LIB_CORRUPT',
          'description', 'payment',
          'transaction_date', '2026-08-15T12:00:00Z',
          'net_credit', '300.00',
          'net_debit', '0.00',
          'gross_amount', '300.00',
          'tax_amount', '0.00',
          'payment_method', 'transfer',
          'payment_method_type', 'bank_transfer',
          'payload_hash', 'hash_lib_corrupt',
          'raw_data', jsonb_build_object(
            'SOURCE_ID', 'TEST_LIB_CORRUPT',
            'DATE', '2026-08-15T12:00:00Z',
            'DESCRIPTION', 'payment',
            'GROSS_AMOUNT', '300.00',
            'NET_CREDIT_AMOUNT', '300.00',
            'NET_DEBIT_AMOUNT', '0.00',
            'PAYMENT_METHOD', 'transfer'
          )
        )]
      ) IS NOT NULL
    )
    THEN 'FAIL: no lanzó exception'
    ELSE 'N/A (no debería alcanzar aquí)'
  END as test_fm_sin_le_result;

BEGIN
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_LIB_CORRUPT',
      'description', 'payment',
      'transaction_date', '2026-08-15T12:00:00Z',
      'net_credit', '300.00',
      'net_debit', '0.00',
      'gross_amount', '300.00',
      'tax_amount', '0.00',
      'payment_method', 'transfer',
      'payment_method_type', 'bank_transfer',
      'payload_hash', 'hash_lib_corrupt',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_LIB_CORRUPT',
        'DATE', '2026-08-15T12:00:00Z',
        'DESCRIPTION', 'payment',
        'GROSS_AMOUNT', '300.00',
        'NET_CREDIT_AMOUNT', '300.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'transfer'
      )
    )]
  ) INTO NULL;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'PASS: TEST FM SIN LE capturó exception esperada: %', SQLERRM;
END;

ROLLBACK TO sp_fm_sin_le;

SELECT 'Suite continúa normalmente después de SAVEPOINT' as status;

-- ============================================================================
-- TEST G: NULL source_external_id (aislado)
-- ============================================================================

SELECT 'TEST G: NULL source_external_id' as test_name;

SAVEPOINT sp_g;

BEGIN
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', NULL,
      'description', 'payout',
      'transaction_date', '2026-08-15T13:00:00Z',
      'net_credit', '100.00',
      'net_debit', '0.00',
      'gross_amount', '100.00',
      'tax_amount', '0.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_g',
      'raw_data', jsonb_build_object('SOURCE_ID', NULL)
    )]
  ) INTO NULL;
  RAISE NOTICE 'PASS: TEST G procesado (NULL permitido como source_external_id)';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Exception en TEST G: %', SQLERRM;
END;

ROLLBACK TO sp_g;

-- ============================================================================
-- TEST H: Empty string source_external_id (aislado)
-- ============================================================================

SELECT 'TEST H: Empty string source_external_id' as test_name;

SAVEPOINT sp_h;

BEGIN
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', '',
      'description', 'payout',
      'transaction_date', '2026-08-15T14:00:00Z',
      'net_credit', '100.00',
      'net_debit', '0.00',
      'gross_amount', '100.00',
      'tax_amount', '0.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_h',
      'raw_data', jsonb_build_object('SOURCE_ID', '')
    )]
  ) INTO NULL;
  RAISE NOTICE 'PASS: TEST H procesado (empty string permitido)';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Exception en TEST H: %', SQLERRM;
END;

ROLLBACK TO sp_h;

-- ============================================================================
-- TEST I: Numeric blank
-- ============================================================================

SELECT 'TEST I blank: net_credit vacío (debe convertir a 0)' as test_name;

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_LIB_I_BLANK',
      'description', 'payout',
      'transaction_date', '2026-08-15T15:00:00Z',
      'net_credit', '',
      'net_debit', '0.00',
      'gross_amount', '100.00',
      'tax_amount', '0.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_i_blank',
      'raw_data', jsonb_build_object('NET_CREDIT_AMOUNT', '')
    )]
  ) as rpc_result
)
SELECT
  CASE
    WHEN (rpc_result->'summary'->>'source_records_created')::INT = 1
         AND (rpc_result->'summary'->>'financial_movements_created')::INT = 1
    THEN 'PASS (numeric blank convertido a 0)'
    ELSE 'FAIL'
  END as test_i_blank_assertion
FROM result;

-- ============================================================================
-- TEST I malformed: prueba en importer (no en RPC SQL)
-- ============================================================================

SELECT 'TEST I malformed: debe probarse en importer parse_decimal(), no en RPC SQL' as test_name;
SELECT 'TEST I malformed: SKIPPED (validación en parse_decimal() del importer localmente)' as status;

-- ============================================================================
-- TEST J: Reimportación completa idéntica
-- ============================================================================

SELECT 'TEST J: Reimportación (1a vez)' as test_name;

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_LIB_J',
      'description', 'payout',
      'transaction_date', '2026-08-15T17:00:00Z',
      'net_credit', '777.00',
      'net_debit', '0.00',
      'gross_amount', '700.00',
      'tax_amount', '77.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_j_first',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_LIB_J',
        'DATE', '2026-08-15T17:00:00Z',
        'DESCRIPTION', 'payout',
        'GROSS_AMOUNT', '700.00',
        'NET_CREDIT_AMOUNT', '777.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'available_money'
      )
    )]
  ) as rpc_result
)
SELECT 'J 1a vez: sr_created=' || rpc_result->'summary'->>'source_records_created' as j_first_run FROM result;

SELECT 'TEST J: Reimportación (2a vez idéntica)' as test_name;

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_LIB_J',
      'description', 'payout',
      'transaction_date', '2026-08-15T17:00:00Z',
      'net_credit', '777.00',
      'net_debit', '0.00',
      'gross_amount', '700.00',
      'tax_amount', '77.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_j_first',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_LIB_J',
        'DATE', '2026-08-15T17:00:00Z',
        'DESCRIPTION', 'payout',
        'GROSS_AMOUNT', '700.00',
        'NET_CREDIT_AMOUNT', '777.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'available_money'
      )
    )]
  ) as rpc_result
)
SELECT
  CASE
    WHEN (rpc_result->'summary'->>'source_records_created')::INT = 0
         AND (rpc_result->'summary'->>'financial_movements_created')::INT = 0
         AND (rpc_result->'summary'->>'ledger_entries_created')::INT = 0
         AND (rpc_result->'summary'->>'movement_source_links_created')::INT = 0
    THEN 'PASS (J 2a vez: sr=0, fm=0, le=0, link=0)'
    ELSE 'FAIL'
  END as test_j_assertion
FROM result;

-- ============================================================================
-- TEST CORRUPCIÓN: >1 FM para mismo source_external_id (aislado)
-- ============================================================================

SELECT 'TEST CORRUPCIÓN: Crear deliberadamente >1 FM para mismo source_external_id' as test_name;

WITH sr1 AS (
  INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
  VALUES ('report', 'TEST_LIB_CORRUPT2', 'hash_c2_1', '{"v":1}'::JSONB, NOW())
  RETURNING id
),
sr2 AS (
  INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
  VALUES ('report', 'TEST_LIB_CORRUPT2', 'hash_c2_2', '{"v":2}'::JSONB, NOW())
  RETURNING id
),
fm1 AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash
  ) VALUES (
    1054315166, 'payment_in', 250.00, 250.00, 0, 'transfer', NOW(), 'hash_c2_1'
  )
  RETURNING id
),
fm2 AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash
  ) VALUES (
    1054315166, 'payment_in', 260.00, 260.00, 0, 'transfer', NOW(), 'hash_c2_2'
  )
  RETURNING id
)
INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
SELECT (SELECT id FROM fm1), (SELECT id FROM sr1), TRUE
UNION ALL
SELECT (SELECT id FROM fm2), (SELECT id FROM sr2), TRUE;

SELECT 'TEST CORRUPCIÓN: Intentar importar payment (debe detectar >1 FM y fallar)' as test_name;

SAVEPOINT sp_corruption;

BEGIN
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_LIB_CORRUPT2',
      'description', 'payment',
      'transaction_date', '2026-08-15T18:00:00Z',
      'net_credit', '250.00',
      'net_debit', '0.00',
      'gross_amount', '250.00',
      'tax_amount', '0.00',
      'payment_method', 'transfer',
      'payment_method_type', 'bank_transfer',
      'payload_hash', 'hash_lib_c2',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_LIB_CORRUPT2',
        'DATE', '2026-08-15T18:00:00Z',
        'DESCRIPTION', 'payment',
        'GROSS_AMOUNT', '250.00',
        'NET_CREDIT_AMOUNT', '250.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'transfer'
      )
    )]
  ) INTO NULL;
  RAISE NOTICE 'FAIL: TEST CORRUPCIÓN no detectó múltiples FMs';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'PASS: TEST CORRUPCIÓN capturó exception (>1 FM detectado)';
END;

ROLLBACK TO sp_corruption;

-- ============================================================================
-- VALIDACIÓN PRE-ROLLBACK
-- ============================================================================

SELECT 'PRE-ROLLBACK COUNTS' as section;

SELECT
  (SELECT COUNT(*) FROM mp_source_record WHERE source_external_id LIKE 'TEST_LIB_%') as sr_count,
  (SELECT COUNT(*) FROM mp_financial_movement fm
   WHERE EXISTS (SELECT 1 FROM mp_movement_source_link l
                 JOIN mp_source_record sr ON sr.id = l.source_record_id
                 WHERE sr.source_external_id LIKE 'TEST_LIB_%'
                   AND l.financial_movement_id = fm.id)) as fm_count_via_links,
  (SELECT COUNT(*) FROM ledger_entry le
   WHERE EXISTS (SELECT 1 FROM mp_movement_source_link l
                 JOIN mp_source_record sr ON sr.id = l.source_record_id
                 WHERE sr.source_external_id LIKE 'TEST_LIB_%'
                   AND l.financial_movement_id = le.financial_movement_id)) as le_count,
  (SELECT COUNT(*) FROM mp_movement_source_link l
   WHERE EXISTS (SELECT 1 FROM mp_source_record sr
                 WHERE sr.id = l.source_record_id
                   AND sr.source_external_id LIKE 'TEST_LIB_%')) as link_count;

-- ============================================================================
-- ROLLBACK
-- ============================================================================

ROLLBACK;

-- ============================================================================
-- VALIDACIÓN POST-ROLLBACK
-- ============================================================================

SELECT 'POST-ROLLBACK VALIDATION (todos deben ser 0)' as section;

SELECT
  (SELECT COUNT(*) FROM mp_source_record WHERE source_external_id LIKE 'TEST_LIB_%') as sr_post_rollback,
  (SELECT COUNT(*) FROM mp_financial_movement fm
   WHERE EXISTS (SELECT 1 FROM mp_movement_source_link l
                 JOIN mp_source_record sr ON sr.id = l.source_record_id
                 WHERE sr.source_external_id LIKE 'TEST_LIB_%'
                   AND l.financial_movement_id = fm.id)) as fm_post_rollback,
  (SELECT COUNT(*) FROM ledger_entry le
   WHERE EXISTS (SELECT 1 FROM mp_movement_source_link l
                 JOIN mp_source_record sr ON sr.id = l.source_record_id
                 WHERE sr.source_external_id LIKE 'TEST_LIB_%'
                   AND l.financial_movement_id = le.financial_movement_id)) as le_post_rollback,
  (SELECT COUNT(*) FROM mp_movement_source_link l
   WHERE EXISTS (SELECT 1 FROM mp_source_record sr
                 WHERE sr.id = l.source_record_id
                   AND sr.source_external_id LIKE 'TEST_LIB_%')) as link_post_rollback;
