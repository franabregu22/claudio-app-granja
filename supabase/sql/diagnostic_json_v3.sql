-- ============================================================================
-- DIAGNOSTIC v3: Test INSERT en mp_source_record con ROLLBACK seguro
-- Prueba todos los constraints, defaults, y JSONB sin dejar datos persistidos
-- ============================================================================

CREATE OR REPLACE FUNCTION diagnostic_json_v3(p_input JSONB)
RETURNS JSONB AS $$
DECLARE
  v_records JSONB[];
  v_record JSONB;
  v_failed_record JSONB := NULL;
  v_failed_sqlstate VARCHAR(5) := NULL;
  v_failed_sqlerrm TEXT := NULL;
  v_idx INT := 0;
  v_inserts INT := 0;
BEGIN
  v_records := ARRAY(SELECT jsonb_array_elements(p_input -> 'records'));

  BEGIN
    -- Bloque que será revertido si todos los INSERTs pasan
    FOREACH v_record IN ARRAY v_records
    LOOP
      v_idx := v_idx + 1;

      BEGIN
        -- INSERT exactamente como import_financial_pipeline lo hace
        INSERT INTO mp_source_record (
          source_type, source_external_id, payload_hash, raw_data,
          observed_at, received_at, processing_status
        ) VALUES (
          v_record->>'source_type',
          v_record->>'source_external_id',
          v_record->>'payload_hash',
          v_record->'raw_data',
          (v_record->>'observed_at')::TIMESTAMPTZ,
          NOW(),
          'processed'::VARCHAR(20)
        )
        ON CONFLICT (source_type, source_external_id, payload_hash) DO NOTHING;

        v_inserts := v_inserts + 1;

      EXCEPTION WHEN OTHERS THEN
        -- Guardar contexto de la fila que falló
        v_failed_record := v_record;
        v_failed_sqlstate := SQLSTATE;
        v_failed_sqlerrm := SQLERRM;
        -- Lanzar excepción controlada para iniciar rollback
        RAISE EXCEPTION 'Insert failed at record' USING ERRCODE = 'P0001';
      END;
    END LOOP;

    -- Todos los INSERTs pasaron - forzar rollback con excepción controlada
    RAISE EXCEPTION 'All inserts succeeded, initiating rollback' USING ERRCODE = 'P0000';

  EXCEPTION
  WHEN SQLSTATE 'P0000' THEN
    -- Rollback exitoso: todos los INSERTs pasaron pero fueron revertidos
    RETURN jsonb_build_object(
      'success', true,
      'records_processed', v_idx,
      'would_insert', v_inserts
    );

  WHEN SQLSTATE 'P0001' THEN
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
