-- RPC: import_liberaciones_primary CORRECTED
-- Atomic batch import of Liberaciones.csv records
-- ARQUITECTURA CORRECTA:
--   - calc_liberaciones_economic_hash(): same-source version comparison ONLY
--   - calc_economic_hash(): FM creation hash
--   - observed_at: NOW() (not transaction_date)
--   - ledger_entry 1:1 UNIQUE per FM
--   - is_primary: TRUE iff payout novo, FALSE iff reutilizado/versionado
--   - Detección corrupción: ERROR si múltiples FM para mismo source

CREATE OR REPLACE FUNCTION import_liberaciones_primary(
  p_account_id BIGINT,
  p_input JSONB[]
) RETURNS JSONB AS $$
DECLARE
  v_input_json JSONB;
  v_idx INTEGER;

  -- Input fields (lowercase from normalize_row)
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

  -- Working variables
  v_source_record_id BIGINT;
  v_existing_link_id BIGINT;
  v_balance_impact NUMERIC;
  v_movement_class VARCHAR;
  v_existing_fm_id_from_report BIGINT;
  v_existing_le_id BIGINT;
  v_financial_movement_id BIGINT;
  v_ledger_entry_id BIGINT;
  v_link_id BIGINT;
  v_fm_count_for_source BIGINT;
  v_is_primary BOOLEAN;

  -- Versionado: previous record economics
  v_prev_sr_id BIGINT;
  v_prev_fm_id BIGINT;
  v_prev_libera_economic_hash VARCHAR(64);
  v_current_libera_economic_hash VARCHAR(64);
  v_current_fm_economic_hash VARCHAR(64);
  v_economic_changed BOOLEAN;

  -- Accumulators
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

  -- Loop through input array
  FOR v_idx IN 1 .. array_length(p_input, 1) LOOP
    v_input_json := p_input[v_idx];

    -- Extract fields (lowercase keys from normalize_row)
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

    -- PASO 1: Create/retrieve mp_source_record (idempotent)
    -- observed_at = NOW() (when we see this version)
    INSERT INTO mp_source_record (
      source_type, source_external_id, payload_hash,
      raw_data, observed_at
    ) VALUES (
      'liberaciones', v_source_external_id, v_payload_hash,
      v_raw_data, NOW()
    )
    ON CONFLICT (source_type, source_external_id, payload_hash) DO NOTHING
    RETURNING id INTO v_source_record_id;

    -- If SR not created, retrieve existing one
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

    IF v_description NOT IN ('payment', 'asset_management', 'payout') THEN
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;

    -- PASO 3: Idempotencia—check for existing LINK
    SELECT id INTO v_existing_link_id
    FROM mp_movement_source_link
    WHERE source_record_id = v_source_record_id
    LIMIT 1;

    IF v_existing_link_id IS NOT NULL THEN
      v_link_created := v_link_created + 1;
      CONTINUE;
    END IF;

    -- PASO 4: Versionado RAW same-source (economic change detection)
    -- Buscar SR anterior del mismo SOURCE_ID (orden observación temporal)
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
      -- Obtener FM vinculado al SR anterior
      SELECT financial_movement_id INTO v_prev_fm_id
      FROM mp_movement_source_link
      WHERE source_record_id = v_prev_sr_id
      LIMIT 1;

      IF v_prev_fm_id IS NOT NULL THEN
        -- Comparar economic hashes using calc_liberaciones_economic_hash (same-source only)
        SELECT calc_liberaciones_economic_hash(
          source_external_id,
          (raw_data->>'NET_CREDIT_AMOUNT')::NUMERIC,
          (raw_data->>'NET_DEBIT_AMOUNT')::NUMERIC,
          (raw_data->>'GROSS_AMOUNT')::NUMERIC,
          (raw_data->>'TAXES_AMOUNT')::NUMERIC,
          transaction_date,
          description,
          raw_data->>'PAYMENT_METHOD'
        ) INTO v_prev_libera_economic_hash
        FROM mp_source_record
        WHERE id = v_prev_sr_id;

        v_current_libera_economic_hash := calc_liberaciones_economic_hash(
          v_source_external_id,
          v_net_credit,
          v_net_debit,
          v_gross_amount,
          v_tax_amount,
          v_transaction_date,
          v_description,
          v_payment_method
        );

        IF v_prev_libera_economic_hash IS NOT NULL
           AND v_prev_libera_economic_hash != v_current_libera_economic_hash THEN
          v_economic_changed := TRUE;
        END IF;
      END IF;
    END IF;

    -- PASO 5: Correlación report (solo para payment/asset_management)
    v_existing_fm_id_from_report := NULL;
    v_fm_count_for_source := 0;

    IF v_description IN ('payment', 'asset_management') THEN
      SELECT COUNT(DISTINCT fm.id) INTO v_fm_count_for_source
      FROM mp_financial_movement fm
      INNER JOIN ledger_entry le ON le.financial_movement_id = fm.id
      WHERE fm.account_id = p_account_id
        AND fm.source_type = 'report'
        AND fm.settlement_amount = v_balance_impact
        AND le.balance_impact = v_balance_impact;

      -- Detección de corrupción: múltiples FMs para mismo source
      IF v_fm_count_for_source > 1 THEN
        RAISE EXCEPTION 'Corrupción detectada: múltiples FMs para settlement_amount=% (source=%)',
                        v_balance_impact, v_source_external_id;
      END IF;

      -- Si existe, obtener el único FM
      IF v_fm_count_for_source = 1 THEN
        SELECT fm.id INTO v_existing_fm_id_from_report
        FROM mp_financial_movement fm
        INNER JOIN ledger_entry le ON le.financial_movement_id = fm.id
        WHERE fm.account_id = p_account_id
          AND fm.source_type = 'report'
          AND fm.settlement_amount = v_balance_impact
          AND le.balance_impact = v_balance_impact
        LIMIT 1;
      END IF;
    END IF;

    -- Si economic change en payment/asset que tiene report correlation, flag needs_review
    IF v_economic_changed AND v_existing_fm_id_from_report IS NOT NULL THEN
      UPDATE mp_financial_movement
      SET needs_review = TRUE
      WHERE id = v_existing_fm_id_from_report;
    END IF;

    -- PASO 6: movement_class
    v_movement_class := 'unclassified';
    IF v_description = 'payment' THEN
      v_movement_class := 'payment_in';
    ELSIF v_description = 'asset_management' THEN
      v_movement_class := 'yield';
    END IF;

    -- PASO 7: Decidir (reutilizar vs crear FM)
    v_is_primary := FALSE;

    IF v_existing_fm_id_from_report IS NOT NULL THEN
      -- Reutilizar FM existente (correlacionado con report)
      v_financial_movement_id := v_existing_fm_id_from_report;
      v_is_primary := FALSE;  -- reutilizado

      -- Verificar que LE existe (1:1 forzado)
      SELECT id INTO v_existing_le_id
      FROM ledger_entry
      WHERE financial_movement_id = v_financial_movement_id;

      IF v_existing_le_id IS NULL THEN
        RAISE EXCEPTION 'Corrupción: FM existe pero LE falta (FM_ID=%)', v_financial_movement_id;
      END IF;

    ELSIF v_description IN ('payment', 'asset_management') THEN
      -- Payment/asset_management WITHOUT prior report correlation: ERROR
      RAISE EXCEPTION 'Payment/asset_management record has no report correlation (SR_ID=%)', v_source_external_id;

    ELSE
      -- Payout (nuevo): crear FM + LE
      v_is_primary := TRUE;  -- payout nuevo origina FM

      -- Calcular economic_hash para el nuevo FM usando calc_economic_hash (FM level hash)
      v_current_fm_economic_hash := calc_economic_hash(
        v_gross_amount,  -- transaction_amount
        v_balance_impact,  -- settlement_amount
        v_tax_amount,  -- tax_amount
        v_movement_class,  -- movement_class
        v_transaction_date,  -- transaction_date
        NULL,  -- settlement_date (no disponible en Liberaciones)
        v_payment_method,  -- payment_method
        v_payment_method_type,  -- payment_detail
        NULL  -- tax_detail (no disponible en Liberaciones)
      );

      INSERT INTO mp_financial_movement (
        account_id, source_type, movement_class,
        transaction_amount, settlement_amount, tax_amount,
        payment_method, payment_detail, transaction_date,
        needs_review, economic_hash
      ) VALUES (
        p_account_id, 'liberaciones', v_movement_class,
        v_gross_amount, v_balance_impact, v_tax_amount,
        v_payment_method, v_payment_method_type, v_transaction_date,
        v_economic_changed, v_current_fm_economic_hash
      )
      RETURNING id INTO v_financial_movement_id;

      v_fm_created := v_fm_created + 1;
      v_created_fm_ids := array_append(v_created_fm_ids, v_financial_movement_id);

      -- PASO 8: Create ledger entry (1:1 con FM)
      INSERT INTO ledger_entry (
        account_id, financial_movement_id, balance_impact,
        category, description, occurred_at
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

    -- PASO 9: Insert LINK
    INSERT INTO mp_movement_source_link (
      financial_movement_id, source_record_id, is_primary
    ) VALUES (
      v_financial_movement_id, v_source_record_id, v_is_primary
    )
    RETURNING id INTO v_link_id;

    v_link_created := v_link_created + 1;
    v_created_link_ids := array_append(v_created_link_ids, v_link_id);

  END LOOP;

  -- Return result
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
  'Atomic batch import of Liberaciones records. CORRECTED ARCHITECTURE: (1) calc_liberaciones_economic_hash for same-source comparison ONLY, (2) calc_economic_hash for FM creation, (3) observed_at=NOW(), (4) ledger_entry 1:1 unique per FM with validation, (5) is_primary=TRUE iff payout novo, (6) corruption detection for multiple FMs. Supports idempotence, checkpoint-based rollback.';
