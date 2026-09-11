# CÓDIGO FINAL v6: Integración Liberaciones3.csv
## Versionado RAW completo + account_id + rollback automático

**Estado**: CÓDIGO FINAL V6, VERSIONADO RAW IMPLEMENTADO  
**Fecha**: 2026-09-05  
**Cambios**: v5 (bloqueadores) + versionado completo (4)

---

## [B] RPC: import_liberaciones_primary() v6 - VERSIONADO COMPLETO

**Correcciones v6 implementadas:**
- ✅ [BLOQUEADOR A] SR exacto ya tiene link → reutilizar FM, no crear nada
- ✅ [BLOQUEADOR B] Buscar versión previa de liberaciones (mismo SOURCE_ID + account_id)
  - Si economía igual → crear solo LINK (sin FM/LE)
  - Si economía cambió → crear LINK, marcar needs_review, NO modificar FM/LE
- ✅ [BLOQUEADOR C] Buscar en report con account_id explícito
- ✅ [BLOQUEADOR D] payout crea FM/LE solo si no existe previa
- ✅ [SEGURIDAD] account_id en todas las búsquedas (SOURCE_ID + account_id)

```sql
-- ============================================================================
-- RPC: import_liberaciones_primary() v6 FINAL
-- ============================================================================
-- VERSIONADO RAW: Soporta múltiples versiones del mismo SOURCE_ID
-- IDEMPOTENCIA: Completa para payload idéntico Y distinto pero economía igual
-- BLOQUEADORES: A/B/C/D implementados
-- ============================================================================

CREATE OR REPLACE FUNCTION import_liberaciones_primary(
  p_account_id BIGINT,
  p_input JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_records JSONB[];
  v_record JSONB;
  
  v_source_record_id BIGINT;
  v_existing_link_id BIGINT;
  v_existing_fm_id BIGINT;
  v_existing_fm_id_from_lib BIGINT;
  v_existing_settlement DECIMAL(15,2);
  v_existing_settlement_from_lib DECIMAL(15,2);
  v_existing_economic_hash VARCHAR(64);
  v_ledger_entry_id BIGINT;
  
  v_payload_hash VARCHAR(64);
  v_source_external_id VARCHAR(100);
  v_description VARCHAR(50);
  v_balance_impact DECIMAL(15,2);
  v_transaction_date TIMESTAMP WITH TIME ZONE;
  
  v_movement_class VARCHAR(30);
  v_category VARCHAR(30);
  
  v_sr_created INT := 0;
  v_sr_existing INT := 0;
  v_sr_raw_only INT := 0;
  v_fm_created INT := 0;
  v_le_created INT := 0;
  v_link_created INT := 0;
  
  v_created_sr_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_fm_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_le_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_link_ids BIGINT[] := ARRAY[]::BIGINT[];
  
  v_idx INT := 0;
  v_link_id BIGINT;
  
  v_transaction_amount DECIMAL(15,2);
  v_settlement_amount DECIMAL(15,2);
  v_tax_amount DECIMAL(15,2);
  v_payment_date TIMESTAMP WITH TIME ZONE;
  v_payment_method VARCHAR(30);
  v_payment_detail VARCHAR(50);
  v_tax_detail JSONB;
  
  v_new_economic_hash VARCHAR(64);
  v_is_economic_change BOOLEAN;
  
BEGIN
  v_records := ARRAY(SELECT jsonb_array_elements(p_input));
  
  FOREACH v_record IN ARRAY v_records
  LOOP
    v_idx := v_idx + 1;
    
    v_source_external_id := v_record->>'source_external_id';
    v_description := v_record->>'description';
    v_payload_hash := v_record->>'payload_hash';
    
    IF v_source_external_id IS NULL 
       OR v_description IS NULL 
       OR v_payload_hash IS NULL THEN
      RAISE EXCEPTION '[Fila %] Campos requeridos faltando: source_external_id, description, payload_hash', v_idx;
    END IF;
    
    v_balance_impact := 
      (COALESCE((v_record->>'net_credit'), '0'))::NUMERIC(15,2) -
      (COALESCE((v_record->>'net_debit'), '0'))::NUMERIC(15,2);
    
    v_transaction_date := 
      (v_record->>'transaction_date')::TIMESTAMP WITH TIME ZONE;
    
    -- ================================================================
    -- PASO 1: Crear/recuperar mp_source_record
    -- ================================================================
    
    INSERT INTO mp_source_record (
      source_type,
      source_external_id,
      payload_hash,
      raw_data,
      observed_at,
      received_at,
      processing_status
    ) VALUES (
      'liberaciones',
      v_source_external_id,
      v_payload_hash,
      v_record->'raw_data',
      NOW(),
      NOW(),
      'processed'
    )
    ON CONFLICT (source_type, source_external_id, payload_hash) 
    DO NOTHING
    RETURNING id INTO v_source_record_id;
    
    IF v_source_record_id IS NULL THEN
      SELECT id INTO v_source_record_id
      FROM mp_source_record
      WHERE source_type='liberaciones'
        AND source_external_id=v_source_external_id
        AND payload_hash=v_payload_hash;
      v_sr_existing := v_sr_existing + 1;
    ELSE
      v_sr_created := v_sr_created + 1;
      v_created_sr_ids := array_append(v_created_sr_ids, v_source_record_id);
    END IF;
    
    -- ================================================================
    -- PASO 2: DESCRIPCIÓN-FIRST WHITELIST
    -- ================================================================
    
    IF v_description IN ('reserve_for_payment', 'reserve_for_payout') THEN
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    ELSIF v_description NOT IN ('payment', 'asset_management', 'payout') THEN
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;
    
    -- ================================================================
    -- PASO 3: IDEMPOTENCIA CHECK A - SR exacto ya tiene link
    -- ================================================================
    
    SELECT link.id, fm.id
    INTO v_existing_link_id, v_financial_movement_id
    FROM mp_movement_source_link link
    JOIN mp_financial_movement fm ON fm.id = link.financial_movement_id
    WHERE link.source_record_id = v_source_record_id
      AND fm.account_id = p_account_id
    LIMIT 1;
    
    IF v_existing_link_id IS NOT NULL THEN
      -- SR exacto ya linkeado → reutilizar, no crear nada
      CONTINUE;
    END IF;
    
    -- ================================================================
    -- PASO 4: VERSIONADO RAW - Buscar previa versión de LIBERACIONES
    -- ================================================================
    -- Si existe OTRO SR de liberaciones con mismo SOURCE_ID + account_id
    -- linkeado a FM, verificar cambio económico.
    
    SELECT fm.id, fm.settlement_amount, fm.economic_hash
    INTO v_existing_fm_id_from_lib, v_existing_settlement_from_lib, v_existing_economic_hash
    FROM mp_financial_movement fm
    INNER JOIN mp_movement_source_link link 
      ON fm.id = link.financial_movement_id
    INNER JOIN mp_source_record sr_lib 
      ON sr_lib.id = link.source_record_id
    WHERE sr_lib.source_type='liberaciones'
      AND sr_lib.source_external_id=v_source_external_id
      AND fm.account_id = p_account_id
      AND link.source_record_id != v_source_record_id  -- distinto SR (versionado)
    LIMIT 1;
    
    IF v_existing_fm_id_from_lib IS NOT NULL THEN
      -- Existe versión previa de liberaciones con este SOURCE_ID
      -- Calcular economic_hash de la NUEVA versión
      
      v_transaction_amount := (v_record->>'gross_amount')::DECIMAL(15,2);
      v_settlement_amount := v_balance_impact;
      v_tax_amount := (v_record->>'tax_amount')::DECIMAL(15,2);
      v_payment_date := v_transaction_date;
      v_payment_method := v_record->>'payment_method';
      v_payment_detail := v_record->>'payment_method_type';
      v_tax_detail := NULL;
      
      v_new_economic_hash := calc_economic_hash(
        v_transaction_amount,
        v_settlement_amount,
        v_tax_amount,
        CASE v_description
          WHEN 'payment' THEN 'payment_in'
          WHEN 'asset_management' THEN 'yield'
          WHEN 'payout' THEN 'unclassified'
          ELSE 'unclassified'
        END,
        v_payment_date,
        v_payment_date,
        v_payment_method,
        v_payment_detail,
        v_tax_detail
      );
      
      -- Comparar economic_hash
      v_is_economic_change := (v_new_economic_hash != v_existing_economic_hash);
      
      IF v_is_economic_change THEN
        -- Cambio económico: crear LINK, marcar needs_review, NO modificar FM/LE
        UPDATE mp_financial_movement
        SET needs_review = TRUE
        WHERE id = v_existing_fm_id_from_lib;
        
        v_financial_movement_id := v_existing_fm_id_from_lib;
        -- Crear LINK al FM existente
      ELSE
        -- Economía igual: crear solo LINK (sin FM/LE nuevo)
        v_financial_movement_id := v_existing_fm_id_from_lib;
        -- Crear LINK al FM existente
      END IF;
      
      -- Ir a PASO 7 (crear LINK)
      INSERT INTO mp_movement_source_link (
        financial_movement_id,
        source_record_id,
        is_primary
      ) VALUES (
        v_financial_movement_id,
        v_source_record_id,
        FALSE
      )
      ON CONFLICT (financial_movement_id, source_record_id) 
      DO NOTHING
      RETURNING id INTO v_link_id;
      
      IF v_link_id IS NOT NULL THEN
        v_link_created := v_link_created + 1;
        v_created_link_ids := array_append(v_created_link_ids, v_link_id);
      END IF;
      
      CONTINUE;  -- Fin iteración, pasar a siguiente registro
    END IF;
    
    -- ================================================================
    -- PASO 5: Buscar correlación en REPORT (con account_id explícito)
    -- ================================================================
    
    SELECT fm.id, fm.settlement_amount
    INTO v_existing_fm_id, v_existing_settlement
    FROM mp_financial_movement fm
    INNER JOIN mp_movement_source_link link 
      ON fm.id = link.financial_movement_id
    INNER JOIN mp_source_record sr_arch5 
      ON sr_arch5.id = link.source_record_id
    WHERE sr_arch5.source_type='report'
      AND sr_arch5.source_external_id=v_source_external_id
      AND fm.account_id = p_account_id
    LIMIT 1;
    
    -- ================================================================
    -- PASO 6: Determinar movement_class
    -- ================================================================
    
    CASE v_description
      WHEN 'payment' THEN
        v_movement_class := 'payment_in';
        v_category := 'income';
      WHEN 'asset_management' THEN
        v_movement_class := 'yield';
        v_category := 'interest_income';
      WHEN 'payout' THEN
        v_movement_class := 'unclassified';
        v_category := 'other';
      ELSE
        v_movement_class := 'unclassified';
        v_category := 'other';
    END CASE;
    
    -- ================================================================
    -- PASO 7: Decidir: Reutilizar vs Crear FM (ESCENARIOS C/D)
    -- ================================================================
    
    IF v_existing_fm_id IS NOT NULL THEN
      -- CORRELACIONADO CON REPORT
      
      IF v_balance_impact::NUMERIC(15,2) != v_existing_settlement::NUMERIC(15,2) THEN
        RAISE EXCEPTION '[Fila %] Monto discrepante: SOURCE_ID=%, Liberaciones balance_impact=% vs FM settlement_amount=%', 
          v_idx, v_source_external_id, v_balance_impact, v_existing_settlement;
      END IF;
      
      v_financial_movement_id := v_existing_fm_id;
      
    ELSE
      -- NO CORRELACIONADO (ni en report ni en liberaciones previos)
      
      IF v_description IN ('payment', 'asset_management') THEN
        RAISE EXCEPTION '[Fila %] Correlación fallida: SOURCE_ID=% es % pero no existe en report',
          v_idx, v_source_external_id, v_description;
      END IF;
      
      -- ESCENARIO A: payout nuevo → crear FM + LE
      IF v_description = 'payout' THEN
        
        v_transaction_amount := (v_record->>'gross_amount')::DECIMAL(15,2);
        v_settlement_amount := v_balance_impact;
        v_tax_amount := (v_record->>'tax_amount')::DECIMAL(15,2);
        v_payment_date := v_transaction_date;
        v_payment_method := v_record->>'payment_method';
        v_payment_detail := v_record->>'payment_method_type';
        v_tax_detail := NULL;
        
        INSERT INTO mp_financial_movement (
          account_id,
          movement_class,
          transaction_amount,
          settlement_amount,
          tax_amount,
          payment_method,
          payment_detail,
          tax_detail,
          payer_name,
          transaction_date,
          settlement_date,
          economic_hash,
          needs_review
        ) VALUES (
          p_account_id,
          v_movement_class,
          v_transaction_amount,
          v_settlement_amount,
          v_tax_amount,
          v_payment_method,
          v_payment_detail,
          v_tax_detail,
          NULL,
          v_payment_date,
          v_payment_date,
          calc_economic_hash(
            v_transaction_amount,
            v_settlement_amount,
            v_tax_amount,
            v_movement_class,
            v_payment_date,
            v_payment_date,
            v_payment_method,
            v_payment_detail,
            v_tax_detail
          ),
          TRUE
        )
        RETURNING id INTO v_financial_movement_id;
        
        v_fm_created := v_fm_created + 1;
        v_created_fm_ids := array_append(v_created_fm_ids, v_financial_movement_id);
        
        INSERT INTO ledger_entry (
          account_id,
          financial_movement_id,
          balance_impact,
          category,
          source_reference,
          description,
          occurred_at
        ) VALUES (
          p_account_id,
          v_financial_movement_id,
          v_settlement_amount,
          v_category,
          'SOURCE_ID=' || v_source_external_id || ' (liberaciones)',
          v_description,
          v_payment_date
        )
        RETURNING id INTO v_ledger_entry_id;
        
        v_le_created := v_le_created + 1;
        v_created_le_ids := array_append(v_created_le_ids, v_ledger_entry_id);
      END IF;
    END IF;
    
    -- ================================================================
    -- PASO 8: Crear LINK (siempre)
    -- ================================================================
    
    INSERT INTO mp_movement_source_link (
      financial_movement_id,
      source_record_id,
      is_primary
    ) VALUES (
      v_financial_movement_id,
      v_source_record_id,
      FALSE
    )
    ON CONFLICT (financial_movement_id, source_record_id) 
    DO NOTHING
    RETURNING id INTO v_link_id;
    
    IF v_link_id IS NOT NULL THEN
      v_link_created := v_link_created + 1;
      v_created_link_ids := array_append(v_created_link_ids, v_link_id);
    END IF;
    
  END LOOP;
  
  RETURN jsonb_build_object(
    'success', TRUE,
    'records_processed', array_length(v_records, 1),
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
  RAISE EXCEPTION '[import_liberaciones_primary] Lote falló en fila %: % (SQLSTATE: %)', 
    v_idx, SQLERRM, SQLSTATE;

END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION import_liberaciones_primary(BIGINT, JSONB) IS
  'Importa Liquidaciones.csv con versionado RAW completo.
   ESCENARIOS: A (nuevo), B (payload idéntico), C (payload distinto, economía igual),
              D (economía cambió, marcar needs_review).
   IDEMPOTENCIA: Completa para todos los escenarios.
   Todas las búsquedas incluyen account_id explícito.
   Retorna IDs creados para rollback multi-período seguro.';
```

---

## [E] ROLLBACK v6 - TEMPLATE VÁLIDO + SCRIPT AUTOMÁTICO

**Rollback SQL template válido (con arrays vacíos tipados)**:

```sql
-- ============================================================================
-- ROLLBACK v6: Template SQL con arrays tipados (seguro incluso si vacío)
-- ============================================================================

DO $$
DECLARE
  v_created_sr_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_fm_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_le_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_link_ids BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  -- INSERTAR IDs reales de liberaciones_import_result.json
  -- Usar format: ARRAY[1, 2, 3, ...]::BIGINT[]
  
  v_created_sr_ids := ARRAY[]::BIGINT[];      -- REEMPLAZAR
  v_created_fm_ids := ARRAY[]::BIGINT[];      -- REEMPLAZAR
  v_created_le_ids := ARRAY[]::BIGINT[];      -- REEMPLAZAR
  v_created_link_ids := ARRAY[]::BIGINT[];    -- REEMPLAZAR
  
  -- Orden: LE → LINK → FM → SR
  DELETE FROM ledger_entry WHERE id = ANY(v_created_le_ids);
  RAISE NOTICE 'Deleted % LE', array_length(v_created_le_ids, 1);
  
  DELETE FROM mp_movement_source_link WHERE id = ANY(v_created_link_ids);
  RAISE NOTICE 'Deleted % LINK', array_length(v_created_link_ids, 1);
  
  DELETE FROM mp_financial_movement WHERE id = ANY(v_created_fm_ids);
  RAISE NOTICE 'Deleted % FM', array_length(v_created_fm_ids, 1);
  
  DELETE FROM mp_source_record WHERE id = ANY(v_created_sr_ids);
  RAISE NOTICE 'Deleted % SR', array_length(v_created_sr_ids, 1);
END $$;
```

**Script: scripts/generate_liberaciones_rollback.py**

```python
#!/usr/bin/env python3
"""
Generar SQL rollback automático desde liberaciones_import_result.json
"""

import json
import sys
from pathlib import Path

def generate_rollback_sql(json_path: Path) -> str:
    """Leer .json y generar SQL rollback"""
    
    if not json_path.exists():
        print(f"ERROR: {json_path} no encontrado")
        sys.exit(1)
    
    with open(json_path, 'r') as f:
        result = json.load(f)
    
    # Extraer arrays de IDs
    batches = result.get('batches', [])
    
    sr_ids = []
    fm_ids = []
    le_ids = []
    link_ids = []
    
    for batch in batches:
        created = batch.get('created', {})
        
        if created.get('source_record_ids'):
            sr_ids.extend(created['source_record_ids'])
        if created.get('financial_movement_ids'):
            fm_ids.extend(created['financial_movement_ids'])
        if created.get('ledger_entry_ids'):
            le_ids.extend(created['ledger_entry_ids'])
        if created.get('link_ids'):
            link_ids.extend(created['link_ids'])
    
    # Generar SQL
    sql_lines = [
        "-- ============================================================================",
        "-- ROLLBACK v6: Auto-generado de liberaciones_import_result.json",
        "-- ============================================================================",
        "",
        "DO $$",
        "DECLARE",
        f"  v_created_sr_ids BIGINT[] := ARRAY[{', '.join(map(str, sr_ids))}]::BIGINT[];",
        f"  v_created_fm_ids BIGINT[] := ARRAY[{', '.join(map(str, fm_ids))}]::BIGINT[];",
        f"  v_created_le_ids BIGINT[] := ARRAY[{', '.join(map(str, le_ids))}]::BIGINT[];",
        f"  v_created_link_ids BIGINT[] := ARRAY[{', '.join(map(str, link_ids))}]::BIGINT[];",
        "BEGIN",
        "  DELETE FROM ledger_entry WHERE id = ANY(v_created_le_ids);",
        "  RAISE NOTICE 'Deleted % LE', array_length(v_created_le_ids, 1);",
        "",
        "  DELETE FROM mp_movement_source_link WHERE id = ANY(v_created_link_ids);",
        "  RAISE NOTICE 'Deleted % LINK', array_length(v_created_link_ids, 1);",
        "",
        "  DELETE FROM mp_financial_movement WHERE id = ANY(v_created_fm_ids);",
        "  RAISE NOTICE 'Deleted % FM', array_length(v_created_fm_ids, 1);",
        "",
        "  DELETE FROM mp_source_record WHERE id = ANY(v_created_sr_ids);",
        "  RAISE NOTICE 'Deleted % SR', array_length(v_created_sr_ids, 1);",
        "END $$;",
        "",
        "-- VERIFICACIÓN POST-ROLLBACK",
        "SELECT 'Post_rollback_verification' as check,",
        "       (SELECT COUNT(*) FROM mp_source_record WHERE source_type='liberaciones') as sr_liberaciones,",
        "       (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class='unclassified' AND needs_review=TRUE) as fm_unclassified;",
    ]
    
    return '\n'.join(sql_lines)

def main():
    json_path = Path('liberaciones_import_result.json')
    
    sql = generate_rollback_sql(json_path)
    
    output_path = Path('sql/rollback_liberaciones_auto.sql')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'w') as f:
        f.write(sql)
    
    print(f"✓ Rollback generado: {output_path}")
    print(f"\nÚso:")
    print(f"  psql -U postgres -d tu_db -f {output_path}")

if __name__ == '__main__':
    main()
```

**Uso post-importación**:
```bash
python scripts/generate_liberaciones_rollback.py
# Genera: sql/rollback_liberaciones_auto.sql
# (sin ejecutar, solo genera el SQL)
```

