-- ============================================================================
-- DIAGNOSTIC v6_debug: Aislar exactamente cuál línea del INSERT ledger_entry falla
-- ============================================================================

CREATE OR REPLACE FUNCTION diagnostic_json_v6_debug(p_input JSONB)
RETURNS JSONB AS $$
DECLARE
  v_records JSONB[];
  v_record JSONB;
  v_idx INT := 0;

  v_source_record_id BIGINT;
  v_financial_movement_id BIGINT;
  v_existing_fm_id BIGINT;
  v_current_economic_hash VARCHAR(64);

  v_account_id BIGINT;
  v_settlement_amount NUMERIC(15,2);
  v_category VARCHAR(30);
  v_source_reference VARCHAR(100);
  v_description VARCHAR(255);
  v_occurred_at TIMESTAMP WITH TIME ZONE;

  v_original_sqlstate VARCHAR(5) := NULL;
  v_original_sqlerrm TEXT := NULL;
  v_stage TEXT := NULL;
  v_error_detail TEXT := NULL;
  v_error_hint TEXT := NULL;
  v_error_context TEXT := NULL;
BEGIN
  v_records := ARRAY(SELECT jsonb_array_elements(p_input -> 'records'));

  BEGIN
    FOREACH v_record IN ARRAY v_records
    LOOP
      v_idx := v_idx + 1;

      BEGIN
        -- Calcular economic_hash
        v_stage := 'calc_economic_hash';
        v_current_economic_hash := calc_economic_hash(
          (v_record->>'transaction_amount')::NUMERIC,
          (v_record->>'settlement_amount')::NUMERIC,
          (v_record->>'tax_amount')::NUMERIC,
          v_record->>'movement_class',
          (v_record->>'transaction_date')::TIMESTAMP WITH TIME ZONE,
          (v_record->>'settlement_date')::TIMESTAMP WITH TIME ZONE,
          v_record->>'payment_method',
          v_record->>'payment_detail',
          CASE WHEN v_record->>'tax_detail' IS NOT NULL THEN v_record->'tax_detail' ELSE NULL END
        );

        -- Insertar source_record
        v_stage := 'insert_source_record';
        INSERT INTO mp_source_record (
          source_type, source_external_id, payload_hash, raw_data,
          observed_at, received_at, processing_status
        ) VALUES (
          v_record->>'source_type',
          v_record->>'source_external_id',
          v_record->>'payload_hash',
          v_record->'raw_data',
          (v_record->>'observed_at')::TIMESTAMP WITH TIME ZONE,
          NOW(),
          'processed'::VARCHAR(20)
        )
        ON CONFLICT (source_type, source_external_id, payload_hash) DO NOTHING
        RETURNING id INTO v_source_record_id;

        IF v_source_record_id IS NOT NULL THEN

          -- Buscar existing financial_movement
          v_stage := 'select_existing_fm';
          SELECT fm.id
          INTO v_existing_fm_id
          FROM mp_financial_movement fm
          INNER JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
          INNER JOIN mp_source_record sr ON sr.id = link.source_record_id
          WHERE sr.source_type = v_record->>'source_type'
            AND sr.source_external_id = v_record->>'source_external_id'
          LIMIT 1;

          IF v_existing_fm_id IS NULL THEN
            -- Crear financial_movement
            v_stage := 'insert_financial_movement';
            INSERT INTO mp_financial_movement (
              account_id, movement_class, transaction_amount, settlement_amount,
              tax_amount, tax_detail, tax_percentage, payment_method, payment_detail,
              payer_name, payer_id_type, payer_id_number, transaction_date, settlement_date,
              order_id, external_reference, bank_transfer_id,
              economic_hash
            ) VALUES (
              (v_record->>'account_id')::BIGINT,
              v_record->>'movement_class',
              (v_record->>'transaction_amount')::NUMERIC(15,2),
              (v_record->>'settlement_amount')::NUMERIC(15,2),
              (v_record->>'tax_amount')::NUMERIC(15,2),
              CASE WHEN v_record->>'tax_detail' IS NOT NULL THEN v_record->'tax_detail' ELSE NULL END,
              (v_record->>'tax_percentage')::NUMERIC(5,4),
              v_record->>'payment_method',
              v_record->>'payment_detail',
              v_record->>'payer_name',
              v_record->>'payer_id_type',
              v_record->>'payer_id_number',
              (v_record->>'transaction_date')::TIMESTAMP WITH TIME ZONE,
              (v_record->>'settlement_date')::TIMESTAMP WITH TIME ZONE,
              v_record->>'order_id',
              v_record->>'external_reference',
              v_record->>'bank_transfer_id',
              v_current_economic_hash
            )
            RETURNING id INTO v_financial_movement_id;

            -- Crear movement_source_link
            v_stage := 'insert_movement_source_link';
            INSERT INTO mp_movement_source_link (
              financial_movement_id, source_record_id, is_primary
            ) VALUES (
              v_financial_movement_id, v_source_record_id, TRUE
            );

            -- ================================================================
            -- AQUÍ: Probar INSERT de ledger_entry paso a paso
            -- ================================================================

            -- Pre-calcular todos los valores (cada asignación aislada con su own stage)
            v_stage := 'prepare_account_id';
            v_account_id := (v_record->>'account_id')::BIGINT;

            v_stage := 'prepare_settlement_amount';
            v_settlement_amount := (v_record->>'settlement_amount')::NUMERIC(15,2);

            v_stage := 'prepare_category';
            v_category := CASE
              WHEN v_record->>'movement_class' = 'payment_in' THEN 'income'
              WHEN v_record->>'movement_class' = 'payment_out' THEN 'expense'
              WHEN v_record->>'movement_class' = 'yield' THEN 'interest_income'
              WHEN v_record->>'movement_class' IN ('transfer_in', 'transfer_out') THEN 'transfer'
              ELSE 'other'
            END;

            v_stage := 'prepare_source_reference';
            v_source_reference := 'SOURCE_ID=' || (v_record->>'source_external_id') || ' (report)';

            v_stage := 'prepare_description';
            v_description := (v_record->>'movement_class') || ': ' || COALESCE(v_record->>'payer_name', 'N/A');

            v_stage := 'prepare_occurred_at';
            v_occurred_at := (v_record->>'transaction_date')::TIMESTAMP WITH TIME ZONE;

            -- Ahora intentar el INSERT
            v_stage := 'insert_ledger_entry';
            INSERT INTO ledger_entry (
              account_id, financial_movement_id, balance_impact, category,
              source_reference, description, observation, occurred_at
            ) VALUES (
              v_account_id,
              v_financial_movement_id,
              v_settlement_amount,
              v_category,
              v_source_reference,
              v_description,
              NULL,
              v_occurred_at
            );

          END IF;

        END IF;

      EXCEPTION WHEN OTHERS THEN
        v_original_sqlstate := SQLSTATE;
        v_original_sqlerrm := SQLERRM;
        GET STACKED DIAGNOSTICS
          v_error_detail = PG_EXCEPTION_DETAIL,
          v_error_hint = PG_EXCEPTION_HINT,
          v_error_context = PG_EXCEPTION_CONTEXT;
        RAISE EXCEPTION USING
          ERRCODE = 'PZ002',
          MESSAGE = 'DIAGNOSTIC_REAL_ERROR';
      END;
    END LOOP;

    -- Todos pasaron - forzar rollback
    RAISE EXCEPTION USING
      ERRCODE = 'PZ001',
      MESSAGE = 'DIAGNOSTIC_SUCCESS_ROLLBACK';

  EXCEPTION
  WHEN SQLSTATE 'PZ001' THEN
    RETURN jsonb_build_object(
      'success', true,
      'records_processed', v_idx
    );

  WHEN SQLSTATE 'PZ002' THEN
    RETURN jsonb_build_object(
      'success', false,
      'stage', v_stage,
      'failed_at_record', v_idx,
      'source_external_id', v_record->>'source_external_id',
      'sqlstate', v_original_sqlstate,
      'error_message', v_original_sqlerrm,
      'error_detail', v_error_detail,
      'error_hint', v_error_hint,
      'error_context', v_error_context
    );
  END;

END;
$$ LANGUAGE plpgsql;
