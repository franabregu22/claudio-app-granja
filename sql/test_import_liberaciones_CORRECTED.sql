-- TEST TRANSACCIONAL CORRECTED: import_liberaciones_primary
-- Ejecución segura en transacción con ROLLBACK garantizado
-- TODAS las assertions son reales (no descriptivas)
-- RPC candidata solo en transacción, revertida con ROLLBACK
-- Tests: A B C D E F asset_management reserves unknown FM_sin_LE >1FM NULL_source blank_source NULL_desc blank_desc J

BEGIN;

-- ============================================================================
-- FIRMAS REALES POSTGRESQL (consulta solamente)
-- ============================================================================

SELECT 'FIRMAS REALES' as section;

SELECT
  COALESCE(pg_get_function_identity_arguments(oid), 'NO ENCONTRADA') as calc_economic_hash
FROM pg_proc WHERE proname = 'calc_economic_hash';

SELECT
  COALESCE(pg_get_function_identity_arguments(oid), 'NO ENCONTRADA') as calc_liberaciones_economic_hash
FROM pg_proc WHERE proname = 'calc_liberaciones_economic_hash';

SELECT
  COALESCE(pg_get_function_identity_arguments(oid), 'NO ENCONTRADA') as import_liberaciones_primary_ACTUAL
FROM pg_proc WHERE proname = 'import_liberaciones_primary';

-- ============================================================================
-- INSTALAR RPC CANDIDATA DENTRO DE TRANSACCIÓN (solo test scope)
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

    -- VALIDACIÓN: NULL/blank source_external_id
    IF v_source_external_id IS NULL OR BTRIM(v_source_external_id) = '' THEN
      RAISE EXCEPTION 'Invalid source_external_id (NULL or blank)';
    END IF;

    -- VALIDACIÓN: NULL/blank description
    IF v_description IS NULL OR BTRIM(v_description) = '' THEN
      RAISE EXCEPTION 'Invalid description (NULL or blank)';
    END IF;

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

    -- PASO 2: DESCRIPTION-first whitelist (RAW-only reserves)
    IF v_description IN ('reserve_for_payment', 'reserve_for_payout') THEN
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;

    -- PASO 2b: Unknown DESCRIPTION → RAW-only
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

    -- PASO 4: Versionado same-source (solo liberaciones)
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
      -- Obtener FM vinculado al SR anterior (mismo account_id)
      SELECT l.financial_movement_id INTO v_prev_fm_id
      FROM mp_movement_source_link l
      JOIN mp_financial_movement fm ON fm.id = l.financial_movement_id
      WHERE l.source_record_id = v_prev_sr_id
        AND fm.account_id = p_account_id
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

    -- PASO 5: Correlación CROSS-SOURCE (SOLO si NO hay same-source)
    v_existing_fm_id := NULL;
    v_fm_count_for_source := 0;

    -- Si hay same-source previo, ya está resuelto por v_prev_fm_id
    IF v_prev_fm_id IS NULL THEN
      IF v_description IN ('payment', 'asset_management', 'payout') THEN
        -- Contar FMs distintos para este source_external_id en esta cuenta
        -- CROSS-SOURCE: SOLO source_type='report' explícitamente
        SELECT COUNT(DISTINCT l.financial_movement_id) INTO v_fm_count_for_source
        FROM mp_movement_source_link l
        JOIN mp_source_record sr ON sr.id = l.source_record_id
        JOIN mp_financial_movement fm ON fm.id = l.financial_movement_id
        WHERE sr.source_type = 'report'
          AND sr.source_external_id = v_source_external_id
          AND sr.id != v_source_record_id
          AND fm.account_id = p_account_id;

        IF v_fm_count_for_source > 1 THEN
          RAISE EXCEPTION 'Corrupción: múltiples FMs para source_external_id=% en account=%',
                          v_source_external_id, p_account_id;
        END IF;

        IF v_fm_count_for_source = 1 THEN
          SELECT DISTINCT l.financial_movement_id INTO v_existing_fm_id
          FROM mp_movement_source_link l
          JOIN mp_source_record sr ON sr.id = l.source_record_id
          JOIN mp_financial_movement fm ON fm.id = l.financial_movement_id
          WHERE sr.source_type = 'report'
            AND sr.source_external_id = v_source_external_id
            AND sr.id != v_source_record_id
            AND fm.account_id = p_account_id
          LIMIT 1;

          -- Validar que LE existe (1:1 forzado)
          SELECT id INTO v_existing_le_id
          FROM ledger_entry
          WHERE financial_movement_id = v_existing_fm_id;

          IF v_existing_le_id IS NULL THEN
            RAISE EXCEPTION 'Corrupción: FM existe pero LE falta (FM_ID=%)', v_existing_fm_id;
          END IF;

          -- Validar balance_impact exacto (SOLO cross-source)
          IF (SELECT balance_impact FROM ledger_entry WHERE id = v_existing_le_id) != v_balance_impact THEN
            RAISE EXCEPTION 'Mismatch: LE.balance_impact != incoming (FM_ID=%)', v_existing_fm_id;
          END IF;
        END IF;
      END IF;
    END IF;

    -- Marcar needs_review si cambio económico (SAME-SOURCE O CROSS-SOURCE)
    IF v_economic_changed THEN
      IF v_prev_fm_id IS NOT NULL THEN
        UPDATE mp_financial_movement
        SET needs_review = TRUE
        WHERE id = v_prev_fm_id;
      ELSIF v_existing_fm_id IS NOT NULL THEN
        UPDATE mp_financial_movement
        SET needs_review = TRUE
        WHERE id = v_existing_fm_id;
      END IF;
    END IF;

    -- PASO 6: movement_class
    v_movement_class := 'unclassified';
    IF v_description = 'payment' THEN
      v_movement_class := 'payment_in';
    ELSIF v_description = 'asset_management' THEN
      v_movement_class := 'yield';
    END IF;

    -- PASO 7: Decidir (reutilizar vs crear)
    v_is_primary := FALSE;

    IF v_prev_fm_id IS NOT NULL THEN
      -- Reutilizar FM same-source (versionado liberaciones)
      v_financial_movement_id := v_prev_fm_id;
      v_is_primary := FALSE;

    ELSIF v_existing_fm_id IS NOT NULL THEN
      -- Reutilizar FM cross-source (report)
      v_financial_movement_id := v_existing_fm_id;
      v_is_primary := FALSE;

    ELSIF v_description IN ('payment', 'asset_management') THEN
      -- Payment/asset SIN correlación: ERROR
      RAISE EXCEPTION 'Payment/asset_management has no prior correlation (source_external_id=%)',
                      v_source_external_id;

    ELSE
      -- Payout nuevo: crear FM + LE
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

SELECT 'RPC candidata instalada dentro de transacción' as status;

-- ============================================================================
-- TEST A: Payout nuevo
-- ============================================================================

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_A_PAYOUT',
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
        'SOURCE_ID', 'TEST_A_PAYOUT',
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
    ELSE format(
      'FAIL: sr=%s fm=%s le=%s link=%s',
      rpc_result->'summary'->>'source_records_created',
      rpc_result->'summary'->>'financial_movements_created',
      rpc_result->'summary'->>'ledger_entries_created',
      rpc_result->'summary'->>'movement_source_links_created'
    )
  END as test_result
FROM result;

-- ============================================================================
-- TEST B: Idempotencia
-- ============================================================================

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_A_PAYOUT',
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
        'SOURCE_ID', 'TEST_A_PAYOUT',
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
    ELSE format(
      'FAIL: sr=%s fm=%s le=%s link=%s',
      rpc_result->'summary'->>'source_records_created',
      rpc_result->'summary'->>'financial_movements_created',
      rpc_result->'summary'->>'ledger_entries_created',
      rpc_result->'summary'->>'movement_source_links_created'
    )
  END as test_result
FROM result;

-- ============================================================================
-- TEST C: Payout metadata-only change (reutiliza FM)
-- ============================================================================

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_A_PAYOUT',
      'description', 'payout',
      'transaction_date', '2026-08-15T10:30:00Z',
      'net_credit', '1100.00',
      'net_debit', '0.00',
      'gross_amount', '1000.00',
      'tax_amount', '50.00',
      'payment_method', 'available_money',
      'payment_method_type', 'different_type',
      'payload_hash', 'hash_a_2',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_A_PAYOUT',
        'DATE', '2026-08-15T10:30:00Z',
        'DESCRIPTION', 'payout',
        'GROSS_AMOUNT', '1000.00',
        'NET_CREDIT_AMOUNT', '1100.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'available_money',
        'PAYMENT_METHOD_TYPE', 'different_type'
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
    THEN 'PASS'
    ELSE format(
      'FAIL: sr=%s fm=%s',
      rpc_result->'summary'->>'source_records_created',
      rpc_result->'summary'->>'financial_movements_created'
    )
  END as test_result
FROM result;

-- ============================================================================
-- TEST D: Payout economic-change (reutiliza FM, needs_review=TRUE)
-- ============================================================================

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_A_PAYOUT',
      'description', 'payout',
      'transaction_date', '2026-08-15T10:30:00Z',
      'net_credit', '1200.00',
      'net_debit', '0.00',
      'gross_amount', '1000.00',
      'tax_amount', '50.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_a_3',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_A_PAYOUT',
        'DATE', '2026-08-15T10:30:00Z',
        'DESCRIPTION', 'payout',
        'GROSS_AMOUNT', '1000.00',
        'NET_CREDIT_AMOUNT', '1200.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'available_money'
      )
    )]
  ) as rpc_result
),
fm_check AS (
  SELECT
    (SELECT settlement_amount FROM mp_financial_movement WHERE id IN (
      SELECT DISTINCT financial_movement_id FROM mp_movement_source_link
      WHERE source_record_id IN (
        SELECT id FROM mp_source_record WHERE source_external_id='TEST_A_PAYOUT'
      )
    ) LIMIT 1) as settlement_amount,
    (SELECT needs_review FROM mp_financial_movement WHERE id IN (
      SELECT DISTINCT financial_movement_id FROM mp_movement_source_link
      WHERE source_record_id IN (
        SELECT id FROM mp_source_record WHERE source_external_id='TEST_A_PAYOUT'
      )
    ) LIMIT 1) as needs_review
)
SELECT
  CASE
    WHEN (SELECT rpc_result->'summary'->>'source_records_created' FROM result)::INT = 1
         AND (SELECT rpc_result->'summary'->>'financial_movements_created' FROM result)::INT = 0
         AND (SELECT settlement_amount FROM fm_check) = 1100.00
         AND (SELECT needs_review FROM fm_check) = TRUE
    THEN 'PASS'
    ELSE 'FAIL'
  END as test_result;

-- ============================================================================
-- TEST E: Payment con report previo (correlación cross-source)
-- ============================================================================

-- Crear report previo
WITH sr AS (
  INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
  VALUES ('report', 'TEST_E_PAYMENT', 'hash_report_e', '{"test":"report"}'::JSONB, NOW())
  RETURNING id
),
fm AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash
  ) VALUES (
    1054315166, 'payment_in', 500.00, 500.00, 0, 'transfer', NOW(), 'hash_report_e'
  )
  RETURNING id as fm_id
),
le AS (
  INSERT INTO ledger_entry (
    account_id, financial_movement_id, balance_impact, category, occurred_at
  ) VALUES (
    1054315166, (SELECT fm_id FROM fm), 500.00, 'income', NOW()
  )
  RETURNING id
)
INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
SELECT (SELECT fm_id FROM fm), (SELECT id FROM sr), TRUE
RETURNING id;

-- Importar payment Liberaciones con mismo source_external_id
WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_E_PAYMENT',
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
        'SOURCE_ID', 'TEST_E_PAYMENT',
        'DATE', '2026-08-15T11:00:00Z',
        'DESCRIPTION', 'payment',
        'GROSS_AMOUNT', '500.00',
        'NET_CREDIT_AMOUNT', '500.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'transfer'
      )
    )]
  ) as rpc_result
),
link_check AS (
  SELECT
    (SELECT is_primary FROM mp_movement_source_link WHERE source_record_id IN (
      SELECT id FROM mp_source_record WHERE source_external_id='TEST_E_PAYMENT' AND source_type='liberaciones'
    ) LIMIT 1) as is_primary
)
SELECT
  CASE
    WHEN (SELECT rpc_result->'summary'->>'source_records_created' FROM result)::INT = 1
         AND (SELECT rpc_result->'summary'->>'financial_movements_created' FROM result)::INT = 0
         AND (SELECT rpc_result->'summary'->>'ledger_entries_created' FROM result)::INT = 0
         AND (SELECT rpc_result->'summary'->>'movement_source_links_created' FROM result)::INT = 1
         AND (SELECT is_primary FROM link_check) = FALSE
    THEN 'PASS'
    ELSE 'FAIL'
  END as test_result;

-- ============================================================================
-- TEST F: Payment economic-version (cambio económico en payment)
-- ============================================================================

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_E_PAYMENT',
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
        'SOURCE_ID', 'TEST_E_PAYMENT',
        'DATE', '2026-08-15T11:00:00Z',
        'DESCRIPTION', 'payment',
        'GROSS_AMOUNT', '600.00',
        'NET_CREDIT_AMOUNT', '600.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'transfer'
      )
    )]
  ) as rpc_result
),
fm_check AS (
  SELECT
    (SELECT needs_review FROM mp_financial_movement WHERE id IN (
      SELECT DISTINCT l.financial_movement_id FROM mp_movement_source_link l
      JOIN mp_source_record sr ON sr.id = l.source_record_id
      WHERE sr.source_external_id='TEST_E_PAYMENT' AND sr.source_type='report'
    ) LIMIT 1) as needs_review,
    (SELECT settlement_amount FROM mp_financial_movement WHERE id IN (
      SELECT DISTINCT l.financial_movement_id FROM mp_movement_source_link l
      JOIN mp_source_record sr ON sr.id = l.source_record_id
      WHERE sr.source_external_id='TEST_E_PAYMENT' AND sr.source_type='report'
    ) LIMIT 1) as settlement_amount
)
SELECT
  CASE
    WHEN (SELECT rpc_result->'summary'->>'source_records_created' FROM result)::INT = 1
         AND (SELECT rpc_result->'summary'->>'financial_movements_created' FROM result)::INT = 0
         AND (SELECT needs_review FROM fm_check) = TRUE
         AND (SELECT settlement_amount FROM fm_check) = 500.00
    THEN 'PASS'
    ELSE 'FAIL'
  END as test_result;

-- ============================================================================
-- TEST asset_management: correlacionado con report
-- ============================================================================

WITH sr_asset AS (
  INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
  VALUES ('report', 'TEST_ASSET_MGT', 'hash_asset_report', '{"test":"asset"}'::JSONB, NOW())
  RETURNING id
),
fm_asset AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash
  ) VALUES (
    1054315166, 'yield', 250.00, 250.00, 0, 'internal', NOW(), 'hash_asset_report'
  )
  RETURNING id as fm_id
),
le_asset AS (
  INSERT INTO ledger_entry (
    account_id, financial_movement_id, balance_impact, category, occurred_at
  ) VALUES (
    1054315166, (SELECT fm_id FROM fm_asset), 250.00, 'interest_income', NOW()
  )
  RETURNING id
)
INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
SELECT (SELECT fm_id FROM fm_asset), (SELECT id FROM sr_asset), TRUE
RETURNING id;

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_ASSET_MGT',
      'description', 'asset_management',
      'transaction_date', '2026-08-15T12:00:00Z',
      'net_credit', '250.00',
      'net_debit', '0.00',
      'gross_amount', '250.00',
      'tax_amount', '0.00',
      'payment_method', 'internal',
      'payment_method_type', 'yield',
      'payload_hash', 'hash_lib_asset',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_ASSET_MGT',
        'DATE', '2026-08-15T12:00:00Z',
        'DESCRIPTION', 'asset_management',
        'GROSS_AMOUNT', '250.00',
        'NET_CREDIT_AMOUNT', '250.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'internal'
      )
    )]
  ) as rpc_result
)
SELECT
  CASE
    WHEN (SELECT rpc_result->'summary'->>'source_records_created' FROM result)::INT = 1
         AND (SELECT rpc_result->'summary'->>'financial_movements_created' FROM result)::INT = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END as test_result;

-- ============================================================================
-- TEST reserves: RAW-only
-- ============================================================================

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[
      jsonb_build_object(
        'source_external_id', 'TEST_RESERVE_PAY',
        'description', 'reserve_for_payment',
        'transaction_date', '2026-08-15T13:00:00Z',
        'net_credit', '100.00',
        'net_debit', '0.00',
        'gross_amount', '100.00',
        'tax_amount', '0.00',
        'payment_method', 'available_money',
        'payment_method_type', 'account_money',
        'payload_hash', 'hash_reserve_pay',
        'raw_data', jsonb_build_object('SOURCE_ID', 'TEST_RESERVE_PAY', 'DESCRIPTION', 'reserve_for_payment')
      ),
      jsonb_build_object(
        'source_external_id', 'TEST_RESERVE_PAYOUT',
        'description', 'reserve_for_payout',
        'transaction_date', '2026-08-15T13:00:00Z',
        'net_credit', '200.00',
        'net_debit', '0.00',
        'gross_amount', '200.00',
        'tax_amount', '0.00',
        'payment_method', 'available_money',
        'payment_method_type', 'account_money',
        'payload_hash', 'hash_reserve_payout',
        'raw_data', jsonb_build_object('SOURCE_ID', 'TEST_RESERVE_PAYOUT', 'DESCRIPTION', 'reserve_for_payout')
      )
    ]
  ) as rpc_result
)
SELECT
  CASE
    WHEN (SELECT rpc_result->'summary'->>'source_records_created' FROM result)::INT = 2
         AND (SELECT rpc_result->'summary'->>'source_records_raw_only' FROM result)::INT = 2
         AND (SELECT rpc_result->'summary'->>'financial_movements_created' FROM result)::INT = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END as test_result;

-- ============================================================================
-- TEST unknown DESCRIPTION: RAW-only
-- ============================================================================

WITH result AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_UNKNOWN_DESC',
      'description', 'unknown_type_xyz',
      'transaction_date', '2026-08-15T14:00:00Z',
      'net_credit', '50.00',
      'net_debit', '0.00',
      'gross_amount', '50.00',
      'tax_amount', '0.00',
      'payment_method', 'other',
      'payment_method_type', 'other',
      'payload_hash', 'hash_unknown',
      'raw_data', jsonb_build_object('SOURCE_ID', 'TEST_UNKNOWN_DESC', 'DESCRIPTION', 'unknown_type_xyz')
    )]
  ) as rpc_result
)
SELECT
  CASE
    WHEN (SELECT rpc_result->'summary'->>'source_records_created' FROM result)::INT = 1
         AND (SELECT rpc_result->'summary'->>'source_records_raw_only' FROM result)::INT = 1
         AND (SELECT rpc_result->'summary'->>'financial_movements_created' FROM result)::INT = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END as test_result;

-- ============================================================================
-- TEST FM SIN LE: debe RAISE EXCEPTION
-- ============================================================================

-- Crear FM sin LE (corrupción)
WITH sr_corrupt AS (
  INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
  VALUES ('report', 'TEST_FM_NO_LE', 'hash_fm_no_le', '{"test":"corrupt"}'::JSONB, NOW())
  RETURNING id
),
fm_corrupt AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash
  ) VALUES (
    1054315166, 'payment_in', 300.00, 300.00, 0, 'transfer', NOW(), 'hash_fm_no_le'
  )
  RETURNING id
)
INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
SELECT (SELECT id FROM fm_corrupt), (SELECT id FROM sr_corrupt), TRUE
RETURNING id;

-- Intentar importar
SAVEPOINT sp_fm_no_le;

DO $$
DECLARE
  v_error_caught BOOLEAN := FALSE;
  v_error_msg TEXT;
BEGIN
  BEGIN
    PERFORM import_liberaciones_primary(
      1054315166,
      ARRAY[jsonb_build_object(
        'source_external_id', 'TEST_FM_NO_LE',
        'description', 'payment',
        'transaction_date', '2026-08-15T15:00:00Z',
        'net_credit', '300.00',
        'net_debit', '0.00',
        'gross_amount', '300.00',
        'tax_amount', '0.00',
        'payment_method', 'transfer',
        'payment_method_type', 'bank_transfer',
        'payload_hash', 'hash_lib_no_le',
        'raw_data', jsonb_build_object(
          'SOURCE_ID', 'TEST_FM_NO_LE',
          'DATE', '2026-08-15T15:00:00Z',
          'DESCRIPTION', 'payment',
          'GROSS_AMOUNT', '300.00',
          'NET_CREDIT_AMOUNT', '300.00',
          'NET_DEBIT_AMOUNT', '0.00',
          'PAYMENT_METHOD', 'transfer'
        )
      )]
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := TRUE;
    v_error_msg := SQLERRM;
  END;

  IF NOT v_error_caught THEN
    RAISE EXCEPTION 'TEST FM_SIN_LE FAIL: se esperaba excepción al tener FM sin LE correlacionado';
  END IF;

  IF v_error_msg NOT ILIKE '%Corrupción: FM existe pero LE falta%' THEN
    RAISE EXCEPTION 'TEST FM_SIN_LE FAIL: mensaje de error inesperado: %', v_error_msg;
  END IF;

  RAISE NOTICE 'TEST FM_SIN_LE PASS: FM sin LE rechazado correctamente';
END;
$$ LANGUAGE plpgsql;

ROLLBACK TO sp_fm_no_le;

-- ============================================================================
-- TEST >1 FM POR SOURCE: debe RAISE EXCEPTION
-- ============================================================================

WITH sr1 AS (
  INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
  VALUES ('report', 'TEST_MULTI_FM', 'hash_multi_1', '{"v":1}'::JSONB, NOW())
  RETURNING id
),
sr2 AS (
  INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
  VALUES ('report', 'TEST_MULTI_FM', 'hash_multi_2', '{"v":2}'::JSONB, NOW())
  RETURNING id
),
fm1 AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash
  ) VALUES (
    1054315166, 'payment_in', 250.00, 250.00, 0, 'transfer', NOW(), 'hash_multi_1'
  )
  RETURNING id
),
fm2 AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash
  ) VALUES (
    1054315166, 'payment_in', 260.00, 260.00, 0, 'transfer', NOW(), 'hash_multi_2'
  )
  RETURNING id
)
INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
SELECT (SELECT id FROM fm1), (SELECT id FROM sr1), TRUE
UNION ALL
SELECT (SELECT id FROM fm2), (SELECT id FROM sr2), TRUE
RETURNING id;

SAVEPOINT sp_multi_fm;

DO $$
DECLARE
  v_error_caught BOOLEAN := FALSE;
  v_error_msg TEXT;
BEGIN
  BEGIN
    PERFORM import_liberaciones_primary(
      1054315166,
      ARRAY[jsonb_build_object(
        'source_external_id', 'TEST_MULTI_FM',
        'description', 'payment',
        'transaction_date', '2026-08-15T16:00:00Z',
        'net_credit', '250.00',
        'net_debit', '0.00',
        'gross_amount', '250.00',
        'tax_amount', '0.00',
        'payment_method', 'transfer',
        'payment_method_type', 'bank_transfer',
        'payload_hash', 'hash_lib_multi',
        'raw_data', jsonb_build_object(
          'SOURCE_ID', 'TEST_MULTI_FM',
          'DATE', '2026-08-15T16:00:00Z',
          'DESCRIPTION', 'payment',
          'GROSS_AMOUNT', '250.00',
          'NET_CREDIT_AMOUNT', '250.00',
          'NET_DEBIT_AMOUNT', '0.00',
          'PAYMENT_METHOD', 'transfer'
        )
      )]
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := TRUE;
    v_error_msg := SQLERRM;
  END;

  IF NOT v_error_caught THEN
    RAISE EXCEPTION 'TEST >1FM FAIL: se esperaba excepción al tener múltiples FM';
  END IF;

  IF v_error_msg NOT ILIKE '%Corrupción: múltiples FMs%'
     AND v_error_msg NOT ILIKE '%Corrupción detectada: múltiples FMs%' THEN
    RAISE EXCEPTION 'TEST >1FM FAIL: mensaje de error inesperado: %', v_error_msg;
  END IF;

  RAISE NOTICE 'TEST >1FM PASS: múltiples FMs rechazados correctamente';
END;
$$ LANGUAGE plpgsql;

ROLLBACK TO sp_multi_fm;

-- ============================================================================
-- TEST NULL source_external_id: debe ERROR
-- ============================================================================

SAVEPOINT sp_null_source;

DO $$
DECLARE
  v_error_caught BOOLEAN := FALSE;
  v_error_msg TEXT;
BEGIN
  BEGIN
    PERFORM import_liberaciones_primary(
      1054315166,
      ARRAY[jsonb_build_object(
        'source_external_id', NULL,
        'description', 'payout',
        'transaction_date', '2026-08-15T17:00:00Z',
        'net_credit', '100.00',
        'net_debit', '0.00',
        'gross_amount', '100.00',
        'tax_amount', '0.00',
        'payment_method', 'available_money',
        'payment_method_type', 'account_money',
        'payload_hash', 'hash_null_source',
        'raw_data', jsonb_build_object('SOURCE_ID', NULL)
      )]
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := TRUE;
    v_error_msg := SQLERRM;
  END;

  IF NOT v_error_caught THEN
    RAISE EXCEPTION 'TEST NULL_SOURCE FAIL: se esperaba excepción con source_external_id NULL';
  END IF;

  IF v_error_msg NOT ILIKE '%Invalid source_external_id%' THEN
    RAISE EXCEPTION 'TEST NULL_SOURCE FAIL: mensaje de error inesperado: %', v_error_msg;
  END IF;

  RAISE NOTICE 'TEST NULL_SOURCE PASS: NULL source_external_id rechazado correctamente';
END;
$$ LANGUAGE plpgsql;

ROLLBACK TO sp_null_source;

-- ============================================================================
-- TEST blank source_external_id: debe ERROR
-- ============================================================================

SAVEPOINT sp_blank_source;

DO $$
DECLARE
  v_error_caught BOOLEAN := FALSE;
  v_error_msg TEXT;
BEGIN
  BEGIN
    PERFORM import_liberaciones_primary(
      1054315166,
      ARRAY[jsonb_build_object(
        'source_external_id', '',
        'description', 'payout',
        'transaction_date', '2026-08-15T18:00:00Z',
        'net_credit', '100.00',
        'net_debit', '0.00',
        'gross_amount', '100.00',
        'tax_amount', '0.00',
        'payment_method', 'available_money',
        'payment_method_type', 'account_money',
        'payload_hash', 'hash_blank_source',
        'raw_data', jsonb_build_object('SOURCE_ID', '')
      )]
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := TRUE;
    v_error_msg := SQLERRM;
  END;

  IF NOT v_error_caught THEN
    RAISE EXCEPTION 'TEST BLANK_SOURCE FAIL: se esperaba excepción con source_external_id vacío';
  END IF;

  IF v_error_msg NOT ILIKE '%Invalid source_external_id%' THEN
    RAISE EXCEPTION 'TEST BLANK_SOURCE FAIL: mensaje de error inesperado: %', v_error_msg;
  END IF;

  RAISE NOTICE 'TEST BLANK_SOURCE PASS: blank source_external_id rechazado correctamente';
END;
$$ LANGUAGE plpgsql;

ROLLBACK TO sp_blank_source;

-- ============================================================================
-- TEST NULL DESCRIPTION: debe ERROR
-- ============================================================================

SAVEPOINT sp_null_desc;

DO $$
DECLARE
  v_error_caught BOOLEAN := FALSE;
  v_error_msg TEXT;
BEGIN
  BEGIN
    PERFORM import_liberaciones_primary(
      1054315166,
      ARRAY[jsonb_build_object(
        'source_external_id', 'TEST_NULL_DESC',
        'description', NULL,
        'transaction_date', '2026-08-15T19:00:00Z',
        'net_credit', '100.00',
        'net_debit', '0.00',
        'gross_amount', '100.00',
        'tax_amount', '0.00',
        'payment_method', 'available_money',
        'payment_method_type', 'account_money',
        'payload_hash', 'hash_null_desc',
        'raw_data', jsonb_build_object('SOURCE_ID', 'TEST_NULL_DESC', 'DESCRIPTION', NULL)
      )]
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := TRUE;
    v_error_msg := SQLERRM;
  END;

  IF NOT v_error_caught THEN
    RAISE EXCEPTION 'TEST NULL_DESC FAIL: se esperaba excepción con description NULL';
  END IF;

  IF v_error_msg NOT ILIKE '%Invalid description%' THEN
    RAISE EXCEPTION 'TEST NULL_DESC FAIL: mensaje de error inesperado: %', v_error_msg;
  END IF;

  RAISE NOTICE 'TEST NULL_DESC PASS: NULL description rechazado correctamente';
END;
$$ LANGUAGE plpgsql;

ROLLBACK TO sp_null_desc;

-- ============================================================================
-- TEST blank DESCRIPTION: debe ERROR
-- ============================================================================

SAVEPOINT sp_blank_desc;

DO $$
DECLARE
  v_error_caught BOOLEAN := FALSE;
  v_error_msg TEXT;
BEGIN
  BEGIN
    PERFORM import_liberaciones_primary(
      1054315166,
      ARRAY[jsonb_build_object(
        'source_external_id', 'TEST_BLANK_DESC',
        'description', '   ',
        'transaction_date', '2026-08-15T20:00:00Z',
        'net_credit', '100.00',
        'net_debit', '0.00',
        'gross_amount', '100.00',
        'tax_amount', '0.00',
        'payment_method', 'available_money',
        'payment_method_type', 'account_money',
        'payload_hash', 'hash_blank_desc',
        'raw_data', jsonb_build_object('SOURCE_ID', 'TEST_BLANK_DESC', 'DESCRIPTION', '   ')
      )]
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := TRUE;
    v_error_msg := SQLERRM;
  END;

  IF NOT v_error_caught THEN
    RAISE EXCEPTION 'TEST BLANK_DESC FAIL: se esperaba excepción con description en blanco';
  END IF;

  IF v_error_msg NOT ILIKE '%Invalid description%' THEN
    RAISE EXCEPTION 'TEST BLANK_DESC FAIL: mensaje de error inesperado: %', v_error_msg;
  END IF;

  RAISE NOTICE 'TEST BLANK_DESC PASS: blank description rechazado correctamente';
END;
$$ LANGUAGE plpgsql;

ROLLBACK TO sp_blank_desc;

-- ============================================================================
-- TEST CROSS-SOURCE: Verifica que otro source_type (webhook) NO se usa
-- ============================================================================

-- Crear FM con webhook (NO report)
WITH sr_webhook AS (
  INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
  VALUES ('webhook', 'TEST_CROSS_SOURCE_IGNORE', 'hash_webhook', '{"test":"webhook"}'::JSONB, NOW())
  RETURNING id
),
fm_webhook AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash, payment_detail
  ) VALUES (
    1054315166, 'payment_in', 400.00, 400.00, 0, 'transfer', NOW(), 'hash_webhook', 'TEST_LIB_webhook'
  )
  RETURNING id as fm_id
),
le_webhook AS (
  INSERT INTO ledger_entry (
    account_id, financial_movement_id, balance_impact, category, occurred_at, description
  ) VALUES (
    1054315166, (SELECT fm_id FROM fm_webhook), 400.00, 'income', NOW(), 'TEST_LIB_webhook'
  )
  RETURNING id
)
INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
SELECT (SELECT fm_id FROM fm_webhook), (SELECT id FROM sr_webhook), TRUE
RETURNING id;

-- Intentar importar payment con mismo SOURCE_ID pero sin report correlation
-- Debe fallar porque payment requiere report (no webhook)
SAVEPOINT sp_cross_source_test;

DO $$
DECLARE
  v_error_caught BOOLEAN := FALSE;
  v_error_msg TEXT;
BEGIN
  BEGIN
    PERFORM import_liberaciones_primary(
      1054315166,
      ARRAY[jsonb_build_object(
        'source_external_id', 'TEST_CROSS_SOURCE_IGNORE',
        'description', 'payment',
        'transaction_date', '2026-08-15T22:00:00Z',
        'net_credit', '400.00',
        'net_debit', '0.00',
        'gross_amount', '400.00',
        'tax_amount', '0.00',
        'payment_method', 'transfer',
        'payment_method_type', 'bank_transfer',
        'payload_hash', 'hash_lib_cross_ignore',
        'raw_data', jsonb_build_object(
          'SOURCE_ID', 'TEST_CROSS_SOURCE_IGNORE',
          'DATE', '2026-08-15T22:00:00Z',
          'DESCRIPTION', 'payment',
          'GROSS_AMOUNT', '400.00',
          'NET_CREDIT_AMOUNT', '400.00',
          'NET_DEBIT_AMOUNT', '0.00',
          'PAYMENT_METHOD', 'transfer'
        )
      )]
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := TRUE;
    v_error_msg := SQLERRM;
  END;

  IF NOT v_error_caught THEN
    RAISE EXCEPTION 'TEST CROSS-SOURCE FAIL: se esperaba excepción sin report correlation';
  END IF;

  IF v_error_msg NOT ILIKE '%Payment/asset_management has no prior correlation%' THEN
    RAISE EXCEPTION 'TEST CROSS-SOURCE FAIL: mensaje inesperado: %', v_error_msg;
  END IF;

  RAISE NOTICE 'TEST CROSS-SOURCE PASS: webhook source_type rechazado correctamente';
END;
$$ LANGUAGE plpgsql;

ROLLBACK TO sp_cross_source_test;

-- ============================================================================
-- TEST J: Reimportación completa idéntica
-- ============================================================================

WITH result_j1 AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_J_REIMPORT',
      'description', 'payout',
      'transaction_date', '2026-08-15T21:00:00Z',
      'net_credit', '777.00',
      'net_debit', '0.00',
      'gross_amount', '700.00',
      'tax_amount', '77.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_j_first',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_J_REIMPORT',
        'DATE', '2026-08-15T21:00:00Z',
        'DESCRIPTION', 'payout',
        'GROSS_AMOUNT', '700.00',
        'NET_CREDIT_AMOUNT', '777.00',
        'NET_DEBIT_AMOUNT', '0.00',
        'PAYMENT_METHOD', 'available_money'
      )
    )]
  ) as rpc_result
),
result_j2 AS (
  SELECT import_liberaciones_primary(
    1054315166,
    ARRAY[jsonb_build_object(
      'source_external_id', 'TEST_J_REIMPORT',
      'description', 'payout',
      'transaction_date', '2026-08-15T21:00:00Z',
      'net_credit', '777.00',
      'net_debit', '0.00',
      'gross_amount', '700.00',
      'tax_amount', '77.00',
      'payment_method', 'available_money',
      'payment_method_type', 'account_money',
      'payload_hash', 'hash_j_first',
      'raw_data', jsonb_build_object(
        'SOURCE_ID', 'TEST_J_REIMPORT',
        'DATE', '2026-08-15T21:00:00Z',
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
    WHEN (SELECT rpc_result->'summary'->>'source_records_created' FROM result_j2)::INT = 0
         AND (SELECT rpc_result->'summary'->>'financial_movements_created' FROM result_j2)::INT = 0
         AND (SELECT rpc_result->'summary'->>'ledger_entries_created' FROM result_j2)::INT = 0
         AND (SELECT rpc_result->'summary'->>'movement_source_links_created' FROM result_j2)::INT = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END as test_result;

-- ============================================================================
-- POST-ROLLBACK VALIDATION (dentro de transacción, antes de ROLLBACK)
-- ============================================================================

SELECT 'PRE-ROLLBACK COUNTS' as section;

SELECT
  (SELECT COUNT(*) FROM mp_source_record WHERE source_external_id LIKE 'TEST_%') as sr_count,
  (SELECT COUNT(*) FROM mp_financial_movement
   WHERE account_id = 1054315166
     AND (payment_detail LIKE 'TEST_LIB_%' OR payment_detail LIKE 'TEST_%')) as fm_count,
  (SELECT COUNT(*) FROM ledger_entry
   WHERE account_id = 1054315166
     AND (description LIKE 'TEST_LIB_%' OR description LIKE 'TEST_%')) as le_count,
  (SELECT COUNT(*) FROM mp_movement_source_link l
   WHERE EXISTS (SELECT 1 FROM mp_source_record sr
                 WHERE sr.id = l.source_record_id
                   AND sr.source_external_id LIKE 'TEST_%')) as link_count;

-- ============================================================================
-- ROLLBACK
-- ============================================================================

ROLLBACK;

-- ============================================================================
-- POST-ROLLBACK VALIDATION (después ROLLBACK)
-- ============================================================================

SELECT 'POST-ROLLBACK' as section;

SELECT
  (SELECT COUNT(*) FROM mp_source_record WHERE source_external_id LIKE 'TEST_%') as sr_post,
  (SELECT COUNT(*) FROM mp_financial_movement
   WHERE account_id = 1054315166
     AND (payment_detail LIKE 'TEST_LIB_%' OR payment_detail LIKE 'TEST_%')) as fm_post,
  (SELECT COUNT(*) FROM ledger_entry
   WHERE account_id = 1054315166
     AND (description LIKE 'TEST_LIB_%' OR description LIKE 'TEST_%')) as le_post,
  (SELECT COUNT(*) FROM mp_movement_source_link l
   WHERE EXISTS (SELECT 1 FROM mp_source_record sr
                 WHERE sr.id = l.source_record_id
                   AND sr.source_external_id LIKE 'TEST_%')) as link_post;
