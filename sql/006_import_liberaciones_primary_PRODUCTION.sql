-- PRODUCCIÓN: import_liberaciones_primary RPC
-- Extraído directamente de suite probada sql/test_import_liberaciones_CORRECTED.sql
-- Lógica idéntica, sin test scaffolding

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

COMMENT ON FUNCTION import_liberaciones_primary(BIGINT, JSONB[]) IS
  'Production: atomic batch import of Liberaciones records. Extracted from verified suite test_import_liberaciones_CORRECTED.sql. Identical logic.';
