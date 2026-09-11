-- ============================================================================
-- DIAGNOSTIC v6_step_by_step: Aislar cuál CAST en mp_financial_movement falla
-- Prueba INSERT en mp_financial_movement con cada tipo de cast verificado
-- ============================================================================

CREATE OR REPLACE FUNCTION diagnostic_json_v6_step_by_step(p_input JSONB)
RETURNS JSONB AS $$
DECLARE
  v_records JSONB[];
  v_record JSONB;
  v_idx INT := 0;

  v_source_record_id BIGINT;
  v_financial_movement_id BIGINT;
  v_existing_fm_id BIGINT;
  v_current_economic_hash VARCHAR(64);

  v_original_sqlstate VARCHAR(5) := NULL;
  v_original_sqlerrm TEXT := NULL;
BEGIN
  v_records := ARRAY(SELECT jsonb_array_elements(p_input -> 'records'));

  BEGIN
    FOREACH v_record IN ARRAY v_records
    LOOP
      v_idx := v_idx + 1;

      BEGIN
        -- ====================================================================
        -- PASO 1: Calcular economic_hash
        -- ====================================================================
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
          SELECT fm.id
          INTO v_existing_fm_id
          FROM mp_financial_movement fm
          INNER JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
          INNER JOIN mp_source_record sr ON sr.id = link.source_record_id
          WHERE sr.source_type = v_record->>'source_type'
            AND sr.source_external_id = v_record->>'source_external_id'
          LIMIT 1;

          IF v_existing_fm_id IS NULL THEN
            -- ================================================================
            -- PASO 2: Crear financial_movement
            -- Pero AQUÍ es donde está el error. Intento cada cast en orden.
            -- ================================================================
            INSERT INTO mp_financial_movement (
              account_id, movement_class, transaction_amount, settlement_amount,
              tax_amount, tax_detail, tax_percentage, payment_method, payment_detail,
              payer_name, payer_id_type, payer_id_number, transaction_date, settlement_date,
              order_id, external_reference, bank_transfer_id,
              economic_hash
            ) VALUES (
              (v_record->>'account_id')::BIGINT,                          -- Cast 1
              v_record->>'movement_class',                                -- Cast 2 (string)
              (v_record->>'transaction_amount')::NUMERIC(15,2),           -- Cast 3
              (v_record->>'settlement_amount')::NUMERIC(15,2),            -- Cast 4
              (v_record->>'tax_amount')::NUMERIC(15,2),                   -- Cast 5
              CASE WHEN v_record->>'tax_detail' IS NOT NULL THEN v_record->'tax_detail' ELSE NULL END,  -- Cast 6 (JSONB)
              (v_record->>'tax_percentage')::NUMERIC(5,4),                -- Cast 7
              v_record->>'payment_method',                                -- Cast 8 (string)
              v_record->>'payment_detail',                                -- Cast 9 (string)
              v_record->>'payer_name',                                    -- Cast 10 (string)
              v_record->>'payer_id_type',                                 -- Cast 11 (string)
              v_record->>'payer_id_number',                               -- Cast 12 (string)
              (v_record->>'transaction_date')::TIMESTAMP WITH TIME ZONE,  -- Cast 13
              (v_record->>'settlement_date')::TIMESTAMP WITH TIME ZONE,   -- Cast 14
              v_record->>'order_id',                                      -- Cast 15 (string)
              v_record->>'external_reference',                            -- Cast 16 (string)
              v_record->>'bank_transfer_id',                              -- Cast 17 (string)
              v_current_economic_hash                                     -- Cast 18 (string)
            );

          END IF;

        END IF;

      EXCEPTION WHEN OTHERS THEN
        v_original_sqlstate := SQLSTATE;
        v_original_sqlerrm := SQLERRM;
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
      'records_processed', v_idx,
      'message', 'All financial_movements inserted successfully (rolled back)'
    );

  WHEN SQLSTATE 'PZ002' THEN
    RETURN jsonb_build_object(
      'success', false,
      'failed_at_record', v_idx,
      'source_external_id', v_record->>'source_external_id',
      'sqlstate', v_original_sqlstate,
      'error_message', v_original_sqlerrm
    );
  END;

END;
$$ LANGUAGE plpgsql;
