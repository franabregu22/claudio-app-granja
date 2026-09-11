-- ============================================================================
-- DIAGNOSTIC: Aislar INSERT en ledger_entry con valores hardcodeados
-- ============================================================================

CREATE OR REPLACE FUNCTION diagnostic_ledger_only()
RETURNS JSONB AS $$
DECLARE
  v_fm_id BIGINT;
BEGIN
  BEGIN
    -- Crear un financial_movement de prueba
    INSERT INTO mp_financial_movement (
      account_id, movement_class, transaction_amount, settlement_amount,
      tax_amount, tax_detail, tax_percentage, payment_method, payment_detail,
      payer_name, payer_id_type, payer_id_number, transaction_date, settlement_date,
      order_id, external_reference, bank_transfer_id,
      economic_hash
    ) VALUES (
      1054315166, 'payment_in', 234000.00, 232596.00,
      -1404.00, NULL, 0.6000, 'available_money', 'available_money',
      'Test Payer', 'CUIT', '20123456789',
      '2026-08-31T19:23:44-03:00'::TIMESTAMP WITH TIME ZONE,
      '2026-08-31T19:23:45-03:00'::TIMESTAMP WITH TIME ZONE,
      NULL, NULL, NULL,
      'abc123hash'
    )
    RETURNING id INTO v_fm_id;

    -- Intentar INSERT en ledger_entry
    INSERT INTO ledger_entry (
      account_id, financial_movement_id, balance_impact, category,
      source_reference, description, observation, occurred_at
    ) VALUES (
      1054315166,
      v_fm_id,
      232596.00,
      'income',
      'SOURCE_ID=test123 (report)',
      'payment_in: Test Payer',
      NULL,
      '2026-08-31T19:23:44-03:00'::TIMESTAMP WITH TIME ZONE
    );

    -- Si llegó aquí, forzar rollback
    RAISE EXCEPTION USING
      ERRCODE = 'PZ001',
      MESSAGE = 'SUCCESS_ROLLBACK';

  EXCEPTION
  WHEN SQLSTATE 'PZ001' THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', 'ledger_entry insert succeeded (rolled back)'
    );

  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'sqlstate', SQLSTATE,
      'error_message', SQLERRM
    );
  END;

END;
$$ LANGUAGE plpgsql;
