-- ============================================================================
-- DIAGNOSTIC v4: Test INSERT en mp_source_record + mp_financial_movement
-- Con rollback seguro, sin mp_movement_source_link ni ledger_entry
-- Reproduce LITERALMENTE la lógica real de import_financial_pipeline_rpc_v2
-- ============================================================================

CREATE OR REPLACE FUNCTION diagnostic_json_v4(p_input JSONB)
RETURNS JSONB AS $$
DECLARE
  v_records JSONB[];
  v_record JSONB;
  v_failed_record JSONB := NULL;
  v_failed_sqlstate VARCHAR(5) := NULL;
  v_failed_sqlerrm TEXT := NULL;
  v_idx INT := 0;
  v_source_records_new INT := 0;
  v_financial_movements_new INT := 0;

  v_source_record_id BIGINT;
  v_financial_movement_id BIGINT;
  v_existing_fm_id BIGINT;
  v_existing_economic_hash VARCHAR(64);
  v_current_economic_hash VARCHAR(64);
BEGIN
  v_records := ARRAY(SELECT jsonb_array_elements(p_input -> 'records'));

  BEGIN
    FOREACH v_record IN ARRAY v_records
    LOOP
      v_idx := v_idx + 1;

      BEGIN
        -- ====================================================================
        -- PASO 1: Calcular economic_hash (exactamente como RPC real)
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

        -- ====================================================================
        -- PASO 2: Insertar source_record (exactamente como RPC real)
        -- ====================================================================
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
          v_source_records_new := v_source_records_new + 1;

          -- ====================================================================
          -- PASO 3: ¿Existen otras versiones del mismo source_external_id?
          -- ====================================================================
          SELECT fm.id, fm.economic_hash
          INTO v_existing_fm_id, v_existing_economic_hash
          FROM mp_financial_movement fm
          INNER JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
          INNER JOIN mp_source_record sr ON sr.id = link.source_record_id
          WHERE sr.source_type = v_record->>'source_type'
            AND sr.source_external_id = v_record->>'source_external_id'
          LIMIT 1;

          IF v_existing_fm_id IS NULL THEN
            -- ================================================================
            -- SCENARIO C: Primer source → crear financial_movement
            -- Reproduce LITERALMENTE líneas 157-183 de import_financial_pipeline_rpc_v2
            -- ================================================================
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

            v_financial_movements_new := v_financial_movements_new + 1;

            -- NOTA: NO crear mp_movement_source_link ni ledger_entry en v4
          END IF;

        END IF;

      EXCEPTION WHEN OTHERS THEN
        -- Guardar contexto de la fila que falló
        v_failed_record := v_record;
        v_failed_sqlstate := SQLSTATE;
        v_failed_sqlerrm := SQLERRM;
        -- Lanzar excepción controlada para iniciar rollback
        RAISE EXCEPTION USING
          ERRCODE = 'PZ002',
          MESSAGE = 'DIAGNOSTIC_REAL_ERROR';
      END;
    END LOOP;

    -- Todos los INSERTs pasaron - forzar rollback con excepción controlada
    RAISE EXCEPTION USING
      ERRCODE = 'PZ001',
      MESSAGE = 'DIAGNOSTIC_SUCCESS_ROLLBACK';

  EXCEPTION
  WHEN SQLSTATE 'PZ001' THEN
    -- Rollback exitoso: todos los INSERTs pasaron pero fueron revertidos
    RETURN jsonb_build_object(
      'success', true,
      'records_processed', v_idx,
      'source_records_new', v_source_records_new,
      'financial_movements_new', v_financial_movements_new
    );

  WHEN SQLSTATE 'PZ002' THEN
    -- Un INSERT falló: devolver error con contexto (datos ya revertidos)
    RETURN jsonb_build_object(
      'success', false,
      'failed_at_record', v_idx,
      'source_external_id', v_failed_record->>'source_external_id',
      'sqlstate', v_failed_sqlstate,
      'error_message', v_failed_sqlerrm
    );
  END;

END;
$$ LANGUAGE plpgsql;
