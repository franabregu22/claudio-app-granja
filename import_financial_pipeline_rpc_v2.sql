-- ============================================================================
-- RPC v2: import_financial_pipeline (CON VERSIONADO RAW)
-- ============================================================================
-- DEPENDENCIA: Requiere función calc_economic_hash() de migración 005
-- Usa canonicalización compartida para detectar cambios económicos consistentemente.
--
-- Lógica de versionado:
--
-- Scenario A: source_record exactamente duplicado (mismo payload_hash)
--   → Ignorar (ON CONFLICT)
--   → Validar que tenga mp_movement_source_link válido (detectar huérfanos)
--   → Si huérfano: RAISE EXCEPTION (requiere reparación manual)
--
-- Scenario B: source_record NEW con MISMO source_external_id pero payload_hash diferente
--   → Detectar versión anterior + verificar si cambio es económico
--   B1: Cambio SOLO metadata (economic_hash igual)
--       - Crear nuevo source_record
--       - Reutilizar financial_movement existente
--       - Crear nuevo movement_source_link
--       - NO crear ledger_entry (ya existe 1:1)
--       - NO modificar columnas económicas ni economic_hash
--   B2: Cambio ECONÓMICO (economic_hash diferente)
--       - Crear nuevo source_record
--       - Reutilizar financial_movement existente
--       - Crear nuevo movement_source_link
--       - Marcar financial_movement como needs_review = TRUE
--       - NO modificar columnas económicas (transaction_amount, settlement_amount, etc)
--       - NO modificar economic_hash (refleja estado normalizado actual)
--       - NO modificar ledger_entry existente
--       - Usuario debe revisar manualmente y ejecutar UPDATE atómico posterior si acepta nueva versión
--
-- Scenario C: source_record NUEVO (primer registro de este source_external_id)
--   → Crear financial_movement nuevo
--   → Crear movement_source_link
--   → Crear ledger_entry (1:1)
-- ============================================================================

CREATE OR REPLACE FUNCTION import_financial_pipeline(p_input JSONB)
RETURNS JSONB AS $$
DECLARE
  v_records JSONB[];
  v_record JSONB;
  v_source_record_id BIGINT;
  v_financial_movement_id BIGINT;
  v_existing_fm_id BIGINT;
  v_existing_economic_hash VARCHAR(64);
  v_current_economic_hash VARCHAR(64);
  v_is_economic_change BOOLEAN;

  v_source_records_new INT := 0;
  v_source_records_existing INT := 0;
  v_financial_movements_new INT := 0;
  v_ledger_entries_new INT := 0;
  v_needs_review_marked INT := 0;

  v_idx INT := 0;
BEGIN
  -- Extraer array de registros
  v_records := ARRAY(SELECT jsonb_array_elements(p_input -> 'records'));

  BEGIN

    FOREACH v_record IN ARRAY v_records
    LOOP
      v_idx := v_idx + 1;

      BEGIN
        -- Calcular economic_hash para este registro
        -- Usa EXACTAMENTE la misma función que migración 005 (backfill) y Python (validación)
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
        -- PASO 1: Insertar source_record (o detectar que ya existe)
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
          -- =================================================================
          -- SCENARIO: source_record es NUEVO
          -- =================================================================

          v_source_records_new := v_source_records_new + 1;

          -- ¿Existen otras versiones del mismo source_external_id?
          SELECT fm.id, fm.economic_hash
          INTO v_existing_fm_id, v_existing_economic_hash
          FROM mp_financial_movement fm
          INNER JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
          INNER JOIN mp_source_record sr ON sr.id = link.source_record_id
          WHERE sr.source_type = v_record->>'source_type'
            AND sr.source_external_id = v_record->>'source_external_id'
          LIMIT 1;

          IF v_existing_fm_id IS NOT NULL THEN
            -- =============================================================
            -- SCENARIO B: Versión RAW nueva, pero financial_movement existe
            -- =============================================================

            v_is_economic_change := (v_current_economic_hash != COALESCE(v_existing_economic_hash, ''));

            -- Crear nuevo movement_source_link (vinculado a EXISTENTE financial_movement)
            INSERT INTO mp_movement_source_link (
              financial_movement_id, source_record_id, is_primary
            ) VALUES (
              v_existing_fm_id, v_source_record_id, FALSE
            )
            ON CONFLICT (financial_movement_id, source_record_id) DO NOTHING;

            IF v_is_economic_change THEN
              -- B2: Cambio económico → marcar needs_review
              -- IMPORTANTE: NO modificar economic_hash, transaction_amount, settlement_amount, etc.
              -- El financial_movement mantiene su estado NORMALIZADO anterior.
              -- Solo se marca para revisión manual posterior.
              UPDATE mp_financial_movement
              SET needs_review = TRUE
              WHERE id = v_existing_fm_id
                AND needs_review = FALSE;

              v_needs_review_marked := v_needs_review_marked + 1;
            ELSE
              -- B1: Solo cambio de metadata → no hacer nada
              -- El source_record ya está linkado al financial_movement existente
              NULL;
            END IF;

            -- NO crear ledger_entry (ya existe por 1:1)

          ELSE
            -- =============================================================
            -- SCENARIO C: Primer source_record → crear financial_movement
            -- =============================================================

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

            -- Crear movement_source_link
            INSERT INTO mp_movement_source_link (
              financial_movement_id, source_record_id, is_primary
            ) VALUES (
              v_financial_movement_id, v_source_record_id, TRUE
            );

            -- Crear ledger_entry (1:1)
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
              'SOURCE_ID=' || (v_record->>'source_external_id') || ' (report)',
              (v_record->>'movement_class') || ': ' || COALESCE((v_record->>'payer_name'), 'N/A'),
              NULL,
              (v_record->>'transaction_date')::TIMESTAMP WITH TIME ZONE
            );

            v_ledger_entries_new := v_ledger_entries_new + 1;
          END IF;

        ELSE
          -- =================================================================
          -- SCENARIO A: source_record es DUPLICADO (exactamente igual)
          -- =================================================================

          -- Obtener ID del source_record EXISTENTE
          SELECT id INTO v_source_record_id
          FROM mp_source_record
          WHERE source_type = v_record->>'source_type'
            AND source_external_id = v_record->>'source_external_id'
            AND payload_hash = v_record->>'payload_hash'
          LIMIT 1;

          -- Validación: verificar que tenga un mp_movement_source_link válido
          -- (evitar source_records huérfanos que indicarían corrupción de datos)
          IF NOT EXISTS (
            SELECT 1 FROM mp_movement_source_link
            WHERE source_record_id = v_source_record_id
          ) THEN
            RAISE EXCEPTION 'source_record duplicado (id=%) no tiene movement_source_link. '
              'Datos históricos pueden estar corruptos. Requiere reparación manual.',
              v_source_record_id;
          END IF;

          v_source_records_existing := v_source_records_existing + 1;
        END IF;

      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Error en registro % (source_id=%): %',
          v_idx, v_record->>'source_external_id', SQLERRM;
      END;

    END LOOP;

    -- Éxito
    RETURN jsonb_build_object(
      'success', TRUE,
      'source_records_new', v_source_records_new,
      'source_records_existing', v_source_records_existing,
      'financial_movements_new', v_financial_movements_new,
      'ledger_entries_new', v_ledger_entries_new,
      'needs_review_marked', v_needs_review_marked,
      'error', NULL
    );

  EXCEPTION WHEN OTHERS THEN
    -- Error → rollback automático
    RETURN jsonb_build_object(
      'success', FALSE,
      'source_records_new', v_source_records_new,
      'source_records_existing', v_source_records_existing,
      'financial_movements_new', v_financial_movements_new,
      'ledger_entries_new', v_ledger_entries_new,
      'needs_review_marked', v_needs_review_marked,
      'error', SQLERRM
    );
  END;

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- RESUMEN DE CAMBIOS vs v1
-- ============================================================================
--
-- ✓ Detección de versionado RAW:
--   - Cuando NEW source_record: buscar si source_external_id ya tiene versiones
--   - Comparar economic_hash calculado con calc_economic_hash() (migración 005)
--   - Si económicamente igual: reutilizar financial_movement (B1)
--   - Si económicamente diferente: reutilizar + marcar needs_review (B2)
--
-- ✓ economic_hash: canonicalización consistente
--   - Función calc_economic_hash() usada en:
--     * Migración 005: backfill de movimientos existentes
--     * RPC v2: cálculo para nuevas versiones RAW
--     * Python importer: validación opcional local
--   - Campos: transaction_amount, settlement_amount, tax_amount, movement_class,
--     transaction_date, settlement_date, payment_method, payment_detail, tax_detail
--   - Algoritmo: SHA256 hexadecimal
--
-- ✓ Garantías mantenidas:
--   - 1:1 ledger_entry per financial_movement (NO crear duplicados)
--   - Deduplicación (ON CONFLICT en source_record)
--   - Rollback atomicidad por batch
--
-- ✓ Nuevo campo: needs_review
--   - Agregado vía migración 005: BOOLEAN NOT NULL DEFAULT FALSE
--   - Marcado cuando cambio económico detectado
--   - Usuario debe revisar manualmente
--
-- ✓ Scenario A: Duplicado exacto
--   - ON CONFLICT silencioso
--   - Validación: verificar movement_source_link válido (detectar huérfanos)
--   - Si huérfano: RAISE EXCEPTION (requiere reparación manual)
--
-- ✓ Scenario B1: Metadata change (economic_hash igual)
--   - new source_record + reuse FM + same ledger + no cambios económicos
--
-- ✓ Scenario B2: Economic change (economic_hash diferente)
--   - new source_record + reuse FM + same ledger
--   - needs_review = TRUE (marca para revisión manual)
--   - NO modifica: transaction_amount, settlement_amount, economic_hash, ledger_entry
--   - Usuario resuelve manualmente con UPDATE atómico posterior
--
-- ✓ Scenario C: New source (primer source_external_id)
--   - new source_record + new FM + new ledger
--
-- ✓ Garantía: 1:1 ledger_entry per financial_movement (nunca duplica)
--
