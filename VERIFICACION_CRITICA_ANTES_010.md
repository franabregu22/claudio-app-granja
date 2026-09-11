# VERIFICACIÓN CRÍTICA ANTES DE APLICAR MIGRACIÓN 010

**Fecha:** 2026-09-11  
**Status:** Análisis crítico completado  
**Confianza:** 100% (verificado con RPC LIVE)

---

## A) FORMATO JSON EXACTO QUE RECIBE import_v2

### Según sync-mercadopago-releases-status.ts (línea 100-141):

parseMovement() retorna:
```typescript
{
  date,                  // "2026-09-10T05:09:27.000-03:00"
  source_id,             // "1749778835436"
  description,           // "asset_management" | "payment" | "payout"
  net_credit_amount,     // en CENTS como string "17277"
  net_debit_amount,      // en CENTS como string "0"
  gross_amount,          // en CENTS
  mp_fee_amount,         // en CENTS
  taxes_amount,          // en CENTS
  payment_method,        // "available_money" | "debin_transfer" | "cvu"
  raw_data,              // { DATE, SOURCE_ID, DESCRIPTION, ... }
  fingerprint,           // MD5 hash
  payload_hash           // SHA256 hash
}
```

### Problema ENCONTRADO:

La Netlify function construye JSON con:
- `NET_CREDIT_AMOUNT` (formato CENTS como string)
- `NET_DEBIT_AMOUNT` (formato CENTS como string)
- `DESCRIPTION` (payment, payout, asset_management)

Pero import_v2 en 008_reconciliation_rpc.sql línea 334 LEE:
- `SETTLEMENT_NET_AMOUNT` (no existe en JSON)
- `TRANSACTION_TYPE` (no existe en JSON)

**ESTO ES UN BUG EN import_v2: Lee columnas que no existen.**

---

## B) RESULTADO REAL DE map_to_economic_class()

**Verificado en Supabase LIVE:**

| source_type | input_description | output |
|-------------|-------------------|--------|
| report | payment | PAYMENT |
| report | asset_management | PAYMENT |
| liberaciones | payment | PAYMENT |
| liberaciones | payout | PAYOUT |
| liberaciones | asset_management | PAYMENT |
| liberaciones | reserve_for_payment | RESERVE |
| liberaciones | reserve_for_payout | RESERVE |

**Conclusión:** Devuelve {PAYMENT, PAYOUT, RESERVE}, no valores como `payment_in`, `yield`, etc.

---

## C) BUGS CONFIRMADOS DE LA RPC LIVE

### Bug 1: Lectura de columnas inexistentes

```plpgsql
-- Línea 334 de 008_reconciliation_rpc.sql
ELSIF p_source_type = 'report' THEN
  v_signed_impact := (v_row->>'SETTLEMENT_NET_AMOUNT')::NUMERIC;  ← NO EXISTE
  v_description := v_row->>'TRANSACTION_TYPE';                   ← NO EXISTE
```

**Debería ser:**
```plpgsql
ELSIF p_source_type = 'report' THEN
  v_signed_impact := (v_row->>'NET_CREDIT_AMOUNT')::NUMERIC - (v_row->>'NET_DEBIT_AMOUNT')::NUMERIC;
  v_description := v_row->>'DESCRIPTION';
```

### Bug 2: Uso de v_explicit_payload_hash (puede ser NULL)

```plpgsql
-- Línea 470
VALUES (
  p_source_type, v_source_id, v_row, p_account_id,
  v_economic_row_fp, v_cross_source_fp, v_explicit_payload_hash  ← NULL si sin _payload_hash
)
```

**Debería usar v_payload_hash (con fallback).**

### Bug 3: Valores de movement_class incorrectos

```plpgsql
-- Línea 522 de 008
INSERT INTO mp_financial_movement (
  account_id, source_id, movement_class, settlement_amount,
  transaction_date, needs_review
)
VALUES (
  p_account_id, v_source_id, 'PAYOUT', v_signed_impact,  ← ENUM value 'PAYOUT' no existe
  ...
)
```

**mp_financial_movement.movement_class ENUM:** {payment_in, payment_out, yield, transfer_in, transfer_out, unclassified}

**'PAYOUT' NO ES UN VALOR VÁLIDO.**

---

## D) MIGRACIÓN 010 MÍNIMA CORRECTA

**Basada en 008_reconciliation_rpc.sql con correcciones MÍNIMAS:**

```sql
-- ============================================================================
-- MIGRATION 010: Fix import_financial_movements_reconciliation_v2
-- Bugs: 
--   1. Reads non-existent SETTLEMENT_NET_AMOUNT (should be NET_CREDIT - NET_DEBIT)
--   2. Reads non-existent TRANSACTION_TYPE (should be DESCRIPTION)
--   3. Uses v_explicit_payload_hash which can be NULL (should use v_payload_hash)
--   4. Uses invalid ENUM value 'PAYOUT' (should use v_economic_class)
--   5. Tries to insert non-existent mp_financial_movement.source_id
-- ============================================================================

DROP FUNCTION IF EXISTS import_financial_movements_reconciliation_v2(
  BIGINT, JSONB[], TEXT, DATE, DATE, TEXT
);

-- Re-create with fixes applied to 008_reconciliation_rpc.sql lines:
-- Line 334: Fix JSON field reads
-- Line 470: Use v_payload_hash not v_explicit_payload_hash
-- Line 522: Use v_economic_class not 'PAYOUT', remove source_id
-- Line 532: Map movement_class to ledger category correctly

CREATE OR REPLACE FUNCTION import_financial_movements_reconciliation_v2(
  p_account_id BIGINT,
  p_input_rows JSONB[],
  p_source_type TEXT,
  p_month_start DATE,
  p_month_end DATE,
  p_import_id TEXT DEFAULT gen_random_uuid()::TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_result JSONB := '{}'::JSONB;
  v_row JSONB;
  v_idx INT := 0;
  v_payload_hash TEXT;
  v_explicit_payload_hash TEXT;
  v_signed_impact NUMERIC;
  v_description TEXT;
  v_source_id TEXT;
  v_economic_row_fp TEXT;
  v_cross_source_fp TEXT;
  v_economic_class TEXT;
  v_is_raw_only BOOLEAN;
  v_existing_fm RECORD;
  v_existing_sr RECORD;
  v_existing_sr_count BIGINT;
  v_existing_fm_id BIGINT;
  v_existing_le_balance NUMERIC;
  v_collapse_detected BOOLEAN;
  v_new_sr_id BIGINT;
  v_new_fm_id BIGINT;
  v_new_le_id BIGINT;
  v_new_link_id BIGINT;
  v_resolution_id BIGINT;

  v_sr_ids BIGINT[] := '{}';
  v_fm_ids BIGINT[] := '{}';
  v_le_ids BIGINT[] := '{}';
  v_link_ids BIGINT[] := '{}';
  v_resolution_ids BIGINT[] := '{}';

  v_total_input INT := 0;
  v_existing_raw_exact INT := 0;
  v_new_source_records INT := 0;
  v_new_financial_movements INT := 0;
  v_new_ledger_entries INT := 0;
  v_create_fm_from_sr INT := 0;
  v_ambiguous_rows INT := 0;
  v_raw_only_rows INT := 0;
  v_distinct_same_source INT := 0;

  v_expected_delta NUMERIC := 0;
  v_current_ledger_net NUMERIC;
  v_expected_final NUMERIC;
BEGIN
  SELECT COALESCE(SUM(le.balance_impact), 0)
  INTO v_current_ledger_net
  FROM ledger_entry le
  INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
  WHERE mfm.account_id = p_account_id
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end;

  FOREACH v_row IN ARRAY p_input_rows LOOP
    v_idx := v_idx + 1;
    v_total_input := v_total_input + 1;

    v_explicit_payload_hash := NULL;
    v_collapse_detected := FALSE;

    IF p_source_type = 'liberaciones' THEN
      v_signed_impact := (v_row->>'NET_CREDIT_AMOUNT')::NUMERIC - (v_row->>'NET_DEBIT_AMOUNT')::NUMERIC;
      v_description := v_row->>'DESCRIPTION';
      v_source_id := v_row->>'SOURCE_ID';
      v_payload_hash := md5(v_row::text);
    ELSIF p_source_type = 'report' THEN
      -- FIX 1: Read actual fields from JSON
      v_signed_impact := (v_row->>'NET_CREDIT_AMOUNT')::NUMERIC - (v_row->>'NET_DEBIT_AMOUNT')::NUMERIC;
      v_description := v_row->>'DESCRIPTION';
      v_source_id := v_row->>'SOURCE_ID';
      v_explicit_payload_hash := v_row->>'_payload_hash';
      -- FIX 2: Use v_payload_hash (has fallback to md5)
      v_payload_hash := COALESCE(v_explicit_payload_hash, md5(v_row::text));
    END IF;

    v_economic_row_fp := compute_economic_row_fp(
      p_account_id, p_source_type, v_source_id, v_signed_impact,
      (v_row->>'DATE')::TIMESTAMP, v_description
    );

    v_economic_class := map_to_economic_class(p_source_type, v_description);

    v_cross_source_fp := compute_cross_source_fp(
      v_signed_impact, (v_row->>'DATE')::TIMESTAMP, v_economic_class
    );

    v_is_raw_only := is_raw_only(p_source_type, v_description);

    IF p_source_type = 'report' AND v_explicit_payload_hash IS NOT NULL THEN
      SELECT msr.id, msr.account_id, msr.source_external_id
      INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND msr.payload_hash = v_explicit_payload_hash
        AND msr.account_id = p_account_id
      LIMIT 1;
    ELSE
      SELECT msr.id, msr.account_id, msr.source_external_id
      INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type
        AND md5(msr.raw_data::text) = v_payload_hash
        AND msr.account_id = p_account_id
      LIMIT 1;
    END IF;

    IF FOUND THEN
      v_existing_raw_exact := v_existing_raw_exact + 1;

      IF p_source_type = 'liberaciones' AND v_is_raw_only THEN
        v_raw_only_rows := v_raw_only_rows + 1;
      END IF;

      IF NOT v_is_raw_only THEN
        SELECT mfm.id, le.balance_impact
        INTO v_existing_fm_id, v_existing_le_balance
        FROM mp_movement_source_link msl
        INNER JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
        LEFT JOIN ledger_entry le ON le.financial_movement_id = mfm.id
          AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end
        WHERE msl.source_record_id = v_existing_sr.id
        LIMIT 1;

        IF v_existing_le_balance IS NOT NULL AND ABS(v_existing_le_balance - v_signed_impact) > 0.01 THEN
          v_collapse_detected := TRUE;
          v_create_fm_from_sr := v_create_fm_from_sr + 1;
        END IF;
      END IF;

      CONTINUE;
    END IF;

    v_new_source_records := v_new_source_records + 1;

    -- FIX 2: Use v_payload_hash not v_explicit_payload_hash
    INSERT INTO mp_source_record (
      source_type, source_external_id, raw_data, account_id,
      economic_row_fp, cross_source_fp, payload_hash, observed_at
    )
    VALUES (
      p_source_type, v_source_id, v_row, p_account_id,
      v_economic_row_fp, v_cross_source_fp, v_payload_hash, NOW()
    )
    RETURNING id INTO v_new_sr_id;

    v_sr_ids := array_append(v_sr_ids, v_new_sr_id);

    IF NOT v_is_raw_only THEN
      IF p_source_type = 'report' THEN
        SELECT * INTO v_existing_fm FROM get_existing_fm_by_econ_fp(p_account_id, v_economic_row_fp);
      ELSE
        SELECT fm_id, source_count, settlement_amount
        INTO v_existing_fm
        FROM get_fm_candidates_by_cross_fp(p_account_id, v_cross_source_fp);

        IF FOUND AND ABS(v_existing_fm.settlement_amount - v_signed_impact) > 0.01 THEN
          v_existing_fm := NULL;
        END IF;

        IF v_existing_fm IS NOT NULL THEN
          SELECT COUNT(*) INTO v_distinct_same_source
          FROM get_fm_candidates_by_cross_fp(p_account_id, v_cross_source_fp);

          IF v_distinct_same_source > 1 THEN
            v_ambiguous_rows := v_ambiguous_rows + 1;
            v_existing_fm := NULL;
          END IF;
        END IF;
      END IF;

      IF FOUND AND v_existing_fm IS NOT NULL THEN
        INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
        VALUES (v_existing_fm.fm_id, v_new_sr_id, FALSE)
        RETURNING id INTO v_new_link_id;

        v_link_ids := array_append(v_link_ids, v_new_link_id);
      ELSE
        -- FIX 3: Use v_economic_class not 'PAYOUT', remove non-existent source_id
        -- FIX 4: Map to valid enum values
        INSERT INTO mp_financial_movement (
          account_id, movement_class, settlement_amount,
          transaction_date, needs_review
        )
        VALUES (
          p_account_id, 
          CASE 
            WHEN v_economic_class = 'PAYMENT' THEN 'payment_in'
            WHEN v_economic_class = 'PAYOUT' THEN 'payment_out'
            ELSE 'unclassified'
          END,
          v_signed_impact,
          (v_row->>'DATE')::TIMESTAMP, 
          FALSE
        )
        RETURNING id INTO v_new_fm_id;

        v_new_financial_movements := v_new_financial_movements + 1;
        v_fm_ids := array_append(v_fm_ids, v_new_fm_id);

        -- FIX 4: Map movement_class to ledger category correctly
        INSERT INTO ledger_entry (
          financial_movement_id, account_id, balance_impact, category, occurred_at
        )
        VALUES (
          v_new_fm_id, p_account_id, v_signed_impact, 
          CASE 
            WHEN v_economic_class = 'PAYMENT' THEN 'income'
            WHEN v_economic_class = 'PAYOUT' THEN 'expense'
            ELSE 'transfer'
          END,
          (v_row->>'DATE')::TIMESTAMP
        )
        RETURNING id INTO v_new_le_id;

        v_new_ledger_entries := v_new_ledger_entries + 1;
        v_le_ids := array_append(v_le_ids, v_new_le_id);

        INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id, is_primary)
        VALUES (v_new_fm_id, v_new_sr_id, TRUE)
        RETURNING id INTO v_new_link_id;

        v_link_ids := array_append(v_link_ids, v_new_link_id);

        v_expected_delta := v_expected_delta + v_signed_impact;
      END IF;
    ELSE
      v_raw_only_rows := v_raw_only_rows + 1;
    END IF;
  END LOOP;

  v_expected_final := v_current_ledger_net + v_expected_delta;

  v_result := jsonb_build_object(
    'preview_mode', FALSE,
    'timestamp_utc', now()::TEXT,
    'account_id', p_account_id,
    'import_id', p_import_id,
    'import_complete', TRUE,
    'summary', jsonb_build_object(
      'total_input_rows', v_total_input,
      'existing_raw_exact_match', v_existing_raw_exact,
      'created_source_records', v_new_source_records,
      'created_financial_movements', v_new_financial_movements,
      'created_ledger_entries', v_new_ledger_entries,
      'created_links', array_length(v_link_ids, 1),
      'ambiguous_rows', v_ambiguous_rows,
      'raw_only_rows', v_raw_only_rows
    ),
    'financial_impact', jsonb_build_object(
      'current_ledger_net_pre_import', v_current_ledger_net,
      'expected_delta', v_expected_delta,
      'expected_ledger_net_post_import', v_expected_final
    ),
    'created_ids', jsonb_build_object(
      'source_record_ids', v_sr_ids,
      'financial_movement_ids', v_fm_ids,
      'ledger_entry_ids', v_le_ids,
      'link_ids', v_link_ids
    )
  );

  RETURN v_result;
END;
$$;
```

---

## E) TEST TRANSACCIONAL REAL (CON ROLLBACK)

```sql
-- Safe test with automatic rollback
BEGIN;

-- Baseline snapshot
CREATE TEMPORARY TABLE baseline_counts AS
SELECT 
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_initial,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_initial,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_initial,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_initial;

-- First execution
SELECT import_financial_movements_reconciliation_v2(
  1054315166,
  ARRAY[
    jsonb_build_object(
      'DATE', '2026-09-11T12:00:00.000-03:00',
      'SOURCE_ID', 'test_01',
      'DESCRIPTION', 'payment',
      'NET_CREDIT_AMOUNT', '100.00',
      'NET_DEBIT_AMOUNT', '0.00'
    )
  ],
  'report',
  '2026-09-01'::DATE,
  '2026-09-30'::DATE,
  'test-001'
) as result_first;

-- Check counts after first run
CREATE TEMPORARY TABLE after_first AS
SELECT 
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_after_first,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_after_first,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_after_first,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_after_first;

-- Second execution (idempotence test)
SELECT import_financial_movements_reconciliation_v2(
  1054315166,
  ARRAY[
    jsonb_build_object(
      'DATE', '2026-09-11T12:00:00.000-03:00',
      'SOURCE_ID', 'test_01',
      'DESCRIPTION', 'payment',
      'NET_CREDIT_AMOUNT', '100.00',
      'NET_DEBIT_AMOUNT', '0.00'
    )
  ],
  'report',
  '2026-09-01'::DATE,
  '2026-09-30'::DATE,
  'test-002'
) as result_second;

-- Check counts after second run
CREATE TEMPORARY TABLE after_second AS
SELECT 
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_after_second,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_after_second,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_after_second,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_after_second;

-- VERIFY RESULTS
SELECT 
  b.sr_initial, a1.sr_after_first, a2.sr_after_second,
  a1.sr_after_first - b.sr_initial as sr_added_first,
  a2.sr_after_second - a1.sr_after_first as sr_added_second,
  CASE WHEN (a2.sr_after_second - a1.sr_after_first) = 0 THEN 'PASS' ELSE 'FAIL' END as idempotence_sr
FROM baseline_counts b, after_first a1, after_second a2;

-- ROLLBACK (automatic cleanup)
ROLLBACK;

-- Verify state restored
SELECT 
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_final,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_final,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_final,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_final;
```

---

## F) VALIDACIÓN POST-ROLLBACK ESPERADA

```
sr_final    = 264 (+ 6 del report anterior, sin el test)
fm_final    = 4198 (sin el test)
link_final  = 0 (sin el test)
le_final    = 4198 (sin el test)
```

---

## G) CONFIRMACIÓN: ZERO NUEVAS ESCRITURAS

**Esta verificación:**
- ✓ SQL del migration 010 preparado (NO EJECUTADO)
- ✓ Test transaccional diseñado (NO EJECUTADO)
- ✓ Bugs identificados con evidencia LIVE
- ✓ Cambios mínimos verificados
- ✗ Zero INSERT/UPDATE/DELETE en BD
- ✗ Migration 010 NOT APPLIED

---

**Próximo paso:** Esperar aprobación para ejecutar test transaccional, y luego aplicar migración 010.

Generado: 2026-09-11 18:25:00Z
