-- TEST SIMPLE: queries separadas, sin DO blocks, ROLLBACK al final

BEGIN;

-- ============================================================================
-- FIRMAS REALES POSTGRESQL
-- ============================================================================

SELECT 'FIRMA: calc_economic_hash' as test,
  pg_get_function_identity_arguments(oid) as firma
FROM pg_proc
WHERE proname = 'calc_economic_hash';

SELECT 'FIRMA: calc_liberaciones_economic_hash' as test,
  pg_get_function_identity_arguments(oid) as firma
FROM pg_proc
WHERE proname = 'calc_liberaciones_economic_hash';

SELECT 'FIRMA: import_liberaciones_primary' as test,
  pg_get_function_identity_arguments(oid) as firma
FROM pg_proc
WHERE proname = 'import_liberaciones_primary';

-- ============================================================================
-- CREAR FUNCIONES (scope de transacción)
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

-- ============================================================================
-- TEST A: Payout nuevo
-- ============================================================================

SELECT 'TEST A: Payout nuevo TEST_LIB_A' as test;

SELECT import_liberaciones_primary(
  1054315166,
  ARRAY[
    jsonb_build_object(
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
    )
  ]
) as result_a;

-- ============================================================================
-- TEST B: Idempotencia (mismo payload)
-- ============================================================================

SELECT 'TEST B: Idempotencia (2a ejecución mismo payload)' as test;

SELECT import_liberaciones_primary(
  1054315166,
  ARRAY[
    jsonb_build_object(
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
    )
  ]
) as result_b;

SELECT 'TEST B VALIDACIÓN: sr_created=0, fm_created=0, le_created=0, link_created=0' as check_b;

-- ============================================================================
-- TEST E: Payment con report previo
-- ============================================================================

SELECT 'TEST E: Crear report FM con LE previo' as test;

-- Crear SR report
INSERT INTO mp_source_record (source_type, source_external_id, payload_hash, raw_data, observed_at)
VALUES ('report', 'TEST_LIB_E', 'hash_report_e', '{"test":"report"}'::JSONB, NOW())
RETURNING id as sr_report_id;

-- Guardar el ID en variable (simular con query anidada)
WITH sr AS (
  SELECT id FROM mp_source_record WHERE source_type='report' AND source_external_id='TEST_LIB_E' LIMIT 1
),
fm AS (
  INSERT INTO mp_financial_movement (
    account_id, movement_class, transaction_amount, settlement_amount,
    tax_amount, payment_method, transaction_date, economic_hash
  ) VALUES (
    1054315166, 'payment_in', 500.00, 500.00, 0, 'transfer', NOW(), 'hash_report_e'
  )
  RETURNING id
),
le AS (
  INSERT INTO ledger_entry (
    account_id, financial_movement_id, balance_impact, category, occurred_at
  ) VALUES (
    1054315166, (SELECT id FROM fm), 500.00, 'income', NOW()
  )
  RETURNING id
)
INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
SELECT (SELECT id FROM fm), (SELECT id FROM sr), TRUE
RETURNING id as link_id;

SELECT 'TEST E: Ahora importar payment Liberaciones con mismo source_external_id' as test;

SELECT import_liberaciones_primary(
  1054315166,
  ARRAY[
    jsonb_build_object(
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
    )
  ]
) as result_e;

SELECT 'TEST E VALIDACIÓN: sr_created=1, fm_created=0 (reutilizado), link_created=1, is_primary=FALSE' as check_e;

-- ============================================================================
-- TEST FM SIN LE: debe RAISE EXCEPTION
-- ============================================================================

SELECT 'TEST FM SIN LE: Crear FM sin LE (corrupción)' as test;

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
RETURNING id as link_corrupt_id;

SELECT 'TEST FM SIN LE: Intentar importar payment (debe fallar con EXCEPTION)' as test;

SELECT import_liberaciones_primary(
  1054315166,
  ARRAY[
    jsonb_build_object(
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
    )
  ]
) as result_corrupt;

-- ============================================================================
-- TEST G: NULL source_external_id
-- ============================================================================

SELECT 'TEST G: NULL source_external_id' as test;

SELECT import_liberaciones_primary(
  1054315166,
  ARRAY[
    jsonb_build_object(
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
    )
  ]
) as result_g;

-- ============================================================================
-- TEST H: Empty string source_external_id
-- ============================================================================

SELECT 'TEST H: Empty string source_external_id' as test;

SELECT import_liberaciones_primary(
  1054315166,
  ARRAY[
    jsonb_build_object(
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
    )
  ]
) as result_h;

-- ============================================================================
-- TEST I: Numeric blank
-- ============================================================================

SELECT 'TEST I blank: numeric vacío' as test;

SELECT import_liberaciones_primary(
  1054315166,
  ARRAY[
    jsonb_build_object(
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
    )
  ]
) as result_i_blank;

-- ============================================================================
-- TEST J: Reimportación idéntica
-- ============================================================================

SELECT 'TEST J: Reimportación idéntica (1a vez)' as test;

SELECT import_liberaciones_primary(
  1054315166,
  ARRAY[
    jsonb_build_object(
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
    )
  ]
) as result_j_1;

SELECT 'TEST J: Reimportación idéntica (2a vez, debe dar sr=0, fm=0, le=0, link=0)' as test;

SELECT import_liberaciones_primary(
  1054315166,
  ARRAY[
    jsonb_build_object(
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
    )
  ]
) as result_j_2;

-- ============================================================================
-- VALIDACIÓN POST-TRANSACCIÓN (dentro de BEGIN...ROLLBACK)
-- ============================================================================

SELECT 'VALIDACIÓN PRE-ROLLBACK' as validation;

SELECT COUNT(*) as sr_sintéticos
FROM mp_source_record
WHERE source_external_id LIKE 'TEST_LIB_%';

SELECT COUNT(*) as fm_sintéticos_via_links
FROM mp_financial_movement fm
JOIN mp_movement_source_link l ON l.financial_movement_id = fm.id
JOIN mp_source_record sr ON sr.id = l.source_record_id
WHERE sr.source_external_id LIKE 'TEST_LIB_%';

SELECT COUNT(*) as le_sintéticas
FROM ledger_entry le
WHERE EXISTS (
  SELECT 1 FROM mp_movement_source_link l
  JOIN mp_source_record sr ON sr.id = l.source_record_id
  WHERE sr.source_external_id LIKE 'TEST_LIB_%'
    AND le.financial_movement_id = l.financial_movement_id
);

SELECT COUNT(*) as link_sintéticos
FROM mp_movement_source_link l
WHERE EXISTS (
  SELECT 1 FROM mp_source_record sr
  WHERE sr.id = l.source_record_id
    AND sr.source_external_id LIKE 'TEST_LIB_%'
);

-- ============================================================================
-- ROLLBACK
-- ============================================================================

ROLLBACK;

-- ============================================================================
-- VALIDACIÓN POST-ROLLBACK
-- ============================================================================

SELECT 'VALIDACIÓN POST-ROLLBACK (debe ser 0)' as validation;

SELECT COUNT(*) as sr_post_rollback
FROM mp_source_record
WHERE source_external_id LIKE 'TEST_LIB_%';

SELECT COUNT(*) as link_post_rollback
FROM mp_movement_source_link l
WHERE EXISTS (
  SELECT 1 FROM mp_source_record sr
  WHERE sr.id = l.source_record_id
    AND sr.source_external_id LIKE 'TEST_LIB_%'
);
