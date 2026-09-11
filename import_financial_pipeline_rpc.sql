-- ============================================================================
-- RPC: import_financial_pipeline
-- ============================================================================
-- Importa batch de source_records + financial_movements + links + ledger
-- Manejo atomicidad, deduplicación y 1:1 ledger_entry per financial_movement
--
-- Entrada: JSONB con array de registros
-- {
--   "records": [
--     {
--       "source_type": "report",
--       "source_external_id": "MP-001",
--       "payload_hash": "sha256...",
--       "raw_data": {...},
--       "observed_at": "2026-09-01T10:00:00Z",
--       "account_id": 1054315166,
--       "movement_class": "payment_in",
--       "transaction_amount": 1000.00,
--       "settlement_amount": 993.20,
--       "tax_amount": -6.80,
--       "tax_detail": null,
--       "tax_percentage": null,
--       "payment_method": "available_money",
--       "payment_detail": null,
--       "payer_name": "Customer",
--       "payer_id_type": null,
--       "payer_id_number": null,
--       "transaction_date": "2026-09-01T10:00:00Z",
--       "settlement_date": "2026-09-02T00:00:00Z",
--       "order_id": null,
--       "external_reference": null,
--       "bank_transfer_id": null
--     },
--     ...
--   ]
-- }
--
-- Retorna:
-- {
--   "success": true,
--   "source_records_new": 100,
--   "source_records_existing": 50,
--   "financial_movements_new": 100,
--   "ledger_entries_new": 100,
--   "error": null
-- }
-- ============================================================================

CREATE OR REPLACE FUNCTION import_financial_pipeline(p_input JSONB)
RETURNS JSONB AS $$
DECLARE
  v_records JSONB[];
  v_record JSONB;
  v_source_record_id BIGINT;
  v_financial_movement_id BIGINT;
  v_existing_fm_id BIGINT;
  v_ledger_exists BOOLEAN;

  v_source_records_new INT := 0;
  v_source_records_existing INT := 0;
  v_financial_movements_new INT := 0;
  v_ledger_entries_new INT := 0;
  v_error_msg TEXT := NULL;

  v_idx INT := 0;
BEGIN
  -- Extraer array de registros
  v_records := ARRAY(SELECT jsonb_array_elements(p_input -> 'records'));

  -- Iniciar transacción (será atomicidad por defecto en PostgreSQL)
  BEGIN

    FOREACH v_record IN ARRAY v_records
    LOOP
      v_idx := v_idx + 1;

      BEGIN
        -- ====================================================================
        -- PASO 1: Insertar o reutilizar mp_source_record
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
          -- Nuevo source_record
          v_source_records_new := v_source_records_new + 1;

          -- ================================================================
          -- PASO 2: Crear financial_movement (nuevo)
          -- ================================================================

          INSERT INTO mp_financial_movement (
            account_id, movement_class, transaction_amount, settlement_amount,
            tax_amount, tax_detail, tax_percentage, payment_method, payment_detail,
            payer_name, payer_id_type, payer_id_number, transaction_date, settlement_date,
            order_id, external_reference, bank_transfer_id
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
            v_record->>'bank_transfer_id'
          )
          RETURNING id INTO v_financial_movement_id;

          v_financial_movements_new := v_financial_movements_new + 1;

          -- ================================================================
          -- PASO 3: Crear mp_movement_source_link (nuevo)
          -- ================================================================

          INSERT INTO mp_movement_source_link (
            financial_movement_id, source_record_id, is_primary
          ) VALUES (
            v_financial_movement_id, v_source_record_id, TRUE
          );

          -- ================================================================
          -- PASO 4: Crear ledger_entry (nuevo, 1:1 con financial_movement)
          -- ================================================================

          INSERT INTO ledger_entry (
            account_id, financial_movement_id, balance_impact, category,
            source_reference, description, observation, occurred_at
          ) VALUES (
            (v_record->>'account_id')::BIGINT,
            v_financial_movement_id,
            (v_record->>'settlement_amount')::NUMERIC(15,2),
            CASE
              WHEN v_record->>'movement_class' = 'payment_in' THEN 'income'
              WHEN v_record->>'movement_class' = 'payment_out' THEN 'expense'
              WHEN v_record->>'movement_class' = 'yield' THEN 'interest_income'
              WHEN v_record->>'movement_class' IN ('transfer_in', 'transfer_out') THEN 'transfer'
              ELSE 'other'
            END,
            'SOURCE_ID=' || v_record->>'source_external_id' || ' (report)',
            v_record->>'movement_class' || ': ' || COALESCE(v_record->>'payer_name', 'N/A'),
            NULL,
            (v_record->>'transaction_date')::TIMESTAMP WITH TIME ZONE
          );

          v_ledger_entries_new := v_ledger_entries_new + 1;

        ELSE
          -- Source_record YA EXISTE (deduplicado)
          v_source_records_existing := v_source_records_existing + 1;

          -- Obtener ID del source_record existente
          SELECT id INTO v_source_record_id
          FROM mp_source_record
          WHERE source_type = v_record->>'source_type'
            AND source_external_id = v_record->>'source_external_id'
            AND payload_hash = v_record->>'payload_hash'
          LIMIT 1;

          -- ================================================================
          -- PASO 2b: Obtener financial_movement existente vinculado
          -- ================================================================

          SELECT financial_movement_id INTO v_existing_fm_id
          FROM mp_movement_source_link
          WHERE source_record_id = v_source_record_id
          LIMIT 1;

          IF v_existing_fm_id IS NOT NULL THEN
            -- Financial_movement ya existe, vincular este source_record adicional
            INSERT INTO mp_movement_source_link (
              financial_movement_id, source_record_id, is_primary
            ) VALUES (
              v_existing_fm_id, v_source_record_id, FALSE
            )
            ON CONFLICT (financial_movement_id, source_record_id) DO NOTHING;

            -- NO crear ledger_entry adicional (1:1 constraint)

          ELSE
            -- ERROR: source_record huérfano (no debería ocurrir)
            RAISE EXCEPTION 'source_record % vinculado a ningún financial_movement', v_source_record_id;
          END IF;
        END IF;

      EXCEPTION WHEN OTHERS THEN
        -- Falla en este registro → rollback del BATCH completo
        RAISE EXCEPTION 'Error en registro % (source_id=%): %',
          v_idx, v_record->>'source_external_id', SQLERRM;
      END;

    END LOOP;

    -- Éxito: retornar resumen
    RETURN jsonb_build_object(
      'success', TRUE,
      'source_records_new', v_source_records_new,
      'source_records_existing', v_source_records_existing,
      'financial_movements_new', v_financial_movements_new,
      'ledger_entries_new', v_ledger_entries_new,
      'error', NULL
    );

  EXCEPTION WHEN OTHERS THEN
    -- Error en el batch completo → rollback automático
    RETURN jsonb_build_object(
      'success', FALSE,
      'source_records_new', v_source_records_new,
      'source_records_existing', v_source_records_existing,
      'financial_movements_new', v_financial_movements_new,
      'ledger_entries_new', v_ledger_entries_new,
      'error', SQLERRM
    );
  END;

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- RESUMEN DE LA FUNCIÓN
-- ============================================================================
--
-- TABLAS QUE TOCA:
--   - mp_source_record (INSERT con ON CONFLICT)
--   - mp_financial_movement (INSERT)
--   - mp_movement_source_link (INSERT con ON CONFLICT)
--   - ledger_entry (INSERT)
--   - account_balance (trigger automático al insertar en ledger_entry)
--
-- UNIQUE CONSTRAINTS:
--   - mp_source_record: (source_type, source_external_id, payload_hash)
--   - mp_movement_source_link: (financial_movement_id, source_record_id)
--   - ledger_entry: (financial_movement_id) — implícito por ser 1:1
--
-- OBTENCIÓN DE IDs:
--   - source_record_id: RETURNING de INSERT o SELECT si ya existe
--   - financial_movement_id: RETURNING de INSERT (generado por BIGSERIAL)
--   - existing_fm_id: SELECT de mp_movement_source_link
--
-- GARANTÍAS:
--   - 1 ledger_entry POR financial_movement: UNIQUE(financial_movement_id)
--   - Reutilización: se consulta si source_record ya tiene link
--   - Atomicidad: falla en registro 200 → rollback TODO el batch
--
-- MANEJO DE ERRORES:
--   - Falla inesperada → RAISE EXCEPTION → rollback automático
--   - Usuario re-ejecuta → deduplicación automática vía ON CONFLICT
--   - Retorna JSON detallando qué falló exactamente
--
