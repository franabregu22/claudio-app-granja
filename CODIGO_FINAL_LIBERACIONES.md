# CÓDIGO FINAL: Integración Liberaciones3.csv
## Lista de cambios: Migración 006 + RPC + Importer + Validación

**Estado**: LISTO PARA EJECUTAR (pero NO ejecutado aún)  
**Fecha**: 2026-09-05  
**Validado**: Puntos críticos 1-6 incorporados

---

## [A] MIGRACIÓN 006: Expandir source_type

**Archivo**: `supabase/migrations/006_add_liberaciones_source_type.sql`

```sql
-- ============================================================================
-- MIGRACIÓN 006: Agregar 'liberaciones' como source_type válido
-- ============================================================================
-- Propósito: Permitir importación de Settlement Report CSV (Liberaciones)
-- como fuente secundaria de datos
-- ============================================================================

-- PASO 1: Eliminar constraint actual
ALTER TABLE mp_source_record
DROP CONSTRAINT valid_source_type;

-- PASO 2: Crear constraint expandido
ALTER TABLE mp_source_record
ADD CONSTRAINT valid_source_type 
  CHECK (source_type IN ('report', 'api', 'webhook', 'liberaciones'));

-- PASO 3: Documentación
COMMENT ON CONSTRAINT valid_source_type ON mp_source_record IS
  'Valores permitidos de source_type: 
   - report: Account Money Report CSV (arch5.csv)
   - api: MercadoPago API (futuro)
   - webhook: MP webhooks real-time (futuro)
   - liberaciones: Settlement Report CSV (Liquidaciones.csv)';

-- ============================================================================
-- FIN MIGRACIÓN 006
-- ============================================================================
```

---

## [B] RPC: import_liberaciones_primary()

**Archivo**: `supabase/functions/import_liberaciones_primary.sql`

```sql
-- ============================================================================
-- RPC: import_liberaciones_primary()
-- ============================================================================
-- Integración genérica de Settlement Report (Liberaciones3.csv)
-- Correlaciona con Account Money Report (arch5.csv) por SOURCE_ID
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
  v_financial_movement_id BIGINT;
  v_existing_fm_id BIGINT;
  v_payload_hash VARCHAR(64);
  v_source_external_id VARCHAR(100);
  v_description VARCHAR(50);
  v_balance_impact DECIMAL(15,2);
  v_gross_amount DECIMAL(15,2);
  v_tax_amount DECIMAL(15,2);
  v_transaction_date TIMESTAMP WITH TIME ZONE;
  
  v_current_economic_hash VARCHAR(64);
  v_existing_economic_hash VARCHAR(64);
  v_movement_class VARCHAR(30);
  v_category VARCHAR(30);
  
  -- Contadores
  v_sr_created INT := 0;
  v_sr_existing INT := 0;
  v_sr_raw_only INT := 0;
  v_fm_created INT := 0;
  v_le_created INT := 0;
  v_link_created INT := 0;
  
  -- Arrays para retornar IDs creados (para rollback seguro)
  v_created_fm_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_le_ids BIGINT[] := ARRAY[]::BIGINT[];
  
  v_idx INT := 0;
  v_error_msg TEXT;
  
BEGIN
  v_records := ARRAY(SELECT jsonb_array_elements(p_input));
  
  BEGIN
    FOREACH v_record IN ARRAY v_records
    LOOP
      v_idx := v_idx + 1;
      
      BEGIN
        -- [VALIDACIÓN] Campos requeridos
        v_source_external_id := v_record->>'SOURCE_ID';
        v_description := v_record->>'DESCRIPTION';
        
        IF v_source_external_id IS NULL OR v_description IS NULL THEN
          RAISE EXCEPTION 'Fila % - Campos requeridos: SOURCE_ID, DESCRIPTION', v_idx;
        END IF;
        
        -- [CÁLCULO] balance_impact
        v_balance_impact := 
          (COALESCE((v_record->>'NET_CREDIT_AMOUNT'), '0'))::NUMERIC(15,2) -
          (COALESCE((v_record->>'NET_DEBIT_AMOUNT'), '0'))::NUMERIC(15,2);
        
        v_gross_amount := 
          (COALESCE((v_record->>'GROSS_AMOUNT'), '0'))::NUMERIC(15,2);
        
        v_tax_amount := 
          (COALESCE((v_record->>'TAXES_AMOUNT'), '0'))::NUMERIC(15,2);
        
        v_transaction_date := 
          (v_record->>'DATE')::TIMESTAMP WITH TIME ZONE;
        
        -- [CÁLCULO] payload_hash (SHA256 de raw_data completo)
        v_payload_hash := encode(
          digest(v_record::TEXT, 'sha256'),
          'hex'
        );
        
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
          v_record,
          NOW(),  -- Momento de importación, NO DATE del CSV
          NOW(),
          'processed'
        )
        ON CONFLICT (source_type, source_external_id, payload_hash) 
        DO NOTHING
        RETURNING id INTO v_source_record_id;
        
        IF v_source_record_id IS NULL THEN
          -- Ya existe este SR
          SELECT id INTO v_source_record_id
          FROM mp_source_record
          WHERE source_type='liberaciones'
            AND source_external_id=v_source_external_id
            AND payload_hash=v_payload_hash;
          
          v_sr_existing := v_sr_existing + 1;
        ELSE
          v_sr_created := v_sr_created + 1;
        END IF;
        
        -- ================================================================
        -- PASO 2: Determinar acción según balance_impact
        -- ================================================================
        
        IF ABS(v_balance_impact) < 0.01 THEN
          -- RESERVAS: solo guardar RAW, sin FM/LE
          v_sr_raw_only := v_sr_raw_only + 1;
          CONTINUE;  -- Ir al siguiente registro
        END IF;
        
        -- ================================================================
        -- PASO 3: Buscar correlación en arch5 (por SOURCE_ID)
        -- ================================================================
        
        SELECT fm.id, fm.economic_hash
        INTO v_existing_fm_id, v_existing_economic_hash
        FROM mp_financial_movement fm
        INNER JOIN mp_movement_source_link link 
          ON fm.id = link.financial_movement_id
        INNER JOIN mp_source_record sr_arch5 
          ON sr_arch5.id = link.source_record_id
        WHERE sr_arch5.source_type='report'
          AND sr_arch5.source_external_id=v_source_external_id
        LIMIT 1;
        
        -- ================================================================
        -- PASO 4: Determinar movement_class
        -- ================================================================
        
        CASE v_description
          WHEN 'payment' THEN
            v_movement_class := 'payment_in';
            v_category := 'income';
          WHEN 'asset_management' THEN
            v_movement_class := 'yield';
            v_category := 'interest_income';
          WHEN 'payout' THEN
            -- IMPORTANTE: No asumir transfer_out
            -- Usar 'unclassified' para revisión posterior
            v_movement_class := 'unclassified';
            v_category := 'other';
          ELSE
            v_movement_class := 'unclassified';
            v_category := 'other';
        END CASE;
        
        -- ================================================================
        -- PASO 5: Calcular economic_hash
        -- ================================================================
        
        v_current_economic_hash := calc_economic_hash(
          v_gross_amount,
          v_balance_impact,
          v_tax_amount,
          v_movement_class,
          v_transaction_date,
          v_transaction_date,
          v_record->>'PAYMENT_METHOD_TYPE',
          v_record->>'PAYMENT_METHOD_ID',
          v_record->'TAX_DETAIL'
        );
        
        -- ================================================================
        -- PASO 6: Decidir: Reutilizar vs Crear FM
        -- ================================================================
        
        IF v_existing_fm_id IS NOT NULL THEN
          -- REUTILIZAR FM (compartidos: 716)
          v_financial_movement_id := v_existing_fm_id;
          
          -- Detectar cambios económicos (B1 vs B2)
          IF v_current_economic_hash != v_existing_economic_hash THEN
            -- B2: Cambio económico detectado
            UPDATE mp_financial_movement
            SET needs_review = TRUE
            WHERE id = v_existing_fm_id
              AND needs_review = FALSE;  -- Solo si no ya marcado
          END IF;
          
        ELSE
          -- CREAR FM NUEVA (payouts: 10)
          INSERT INTO mp_financial_movement (
            account_id,
            movement_class,
            transaction_amount,
            settlement_amount,
            tax_amount,
            tax_detail,
            payment_method,
            payment_detail,
            payer_name,
            transaction_date,
            settlement_date,
            economic_hash,
            needs_review
          ) VALUES (
            p_account_id,
            v_movement_class,
            v_gross_amount,
            v_balance_impact,
            v_tax_amount,
            v_record->'TAX_DETAIL',
            v_record->>'PAYMENT_METHOD_TYPE',
            v_record->>'PAYMENT_METHOD_ID',
            v_record->>'PAYER_NAME',
            v_transaction_date,
            v_transaction_date,
            v_current_economic_hash,
            CASE WHEN v_movement_class = 'unclassified' THEN TRUE ELSE FALSE END
          )
          RETURNING id INTO v_financial_movement_id;
          
          v_fm_created := v_fm_created + 1;
          v_created_fm_ids := array_append(v_created_fm_ids, v_financial_movement_id);
          
          -- Crear LE (1:1)
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
            v_balance_impact,
            v_category,
            'SOURCE_ID=' || v_source_external_id || ' (liberaciones)',
            v_description,
            v_transaction_date
          )
          RETURNING id INTO v_created_le_ids;
          
          v_le_created := v_le_created + 1;
          v_created_le_ids := array_append(v_created_le_ids, (v_created_le_ids)[1]);
        END IF;
        
        -- ================================================================
        -- PASO 7: Crear LINK (siempre)
        -- ================================================================
        
        INSERT INTO mp_movement_source_link (
          financial_movement_id,
          source_record_id,
          is_primary
        ) VALUES (
          v_financial_movement_id,
          v_source_record_id,
          FALSE  -- Secundaria (enriquecimiento)
        )
        ON CONFLICT (financial_movement_id, source_record_id) 
        DO NOTHING;
        
        v_link_created := v_link_created + 1;
        
      EXCEPTION WHEN OTHERS THEN
        v_error_msg := 'Fila ' || v_idx || ': ' || SQLERRM;
        RETURN jsonb_build_object(
          'success', FALSE,
          'error', v_error_msg,
          'sqlstate', SQLSTATE
        );
      END;
    END LOOP;
    
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'Error general en lote: ' || SQLERRM,
      'sqlstate', SQLSTATE
    );
  END;
  
  -- ====================================================================
  -- RETORNO
  -- ====================================================================
  
  RETURN jsonb_build_object(
    'success', TRUE,
    'records_processed', array_length(v_records, 1),
    'summary', jsonb_build_object(
      'source_records_created', v_sr_created,
      'source_records_existing', v_sr_existing,
      'source_records_raw_only', v_sr_raw_only,
      'financial_movements_created', v_fm_created,
      'ledger_entries_created', v_le_created,
      'movement_source_links_created', v_link_created,
      'total_sr', v_sr_created + v_sr_existing + v_sr_raw_only,
      'total_links', v_link_created
    ),
    'created_financial_movement_ids', v_created_fm_ids,
    'created_ledger_entry_ids', v_created_le_ids
  );

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMENTARIOS
-- ============================================================================

COMMENT ON FUNCTION import_liberaciones_primary(BIGINT, JSONB) IS
  'Importa Settlement Report (Liberaciones.csv) como fuente secundaria.
   Correlaciona con Account Money Report por SOURCE_ID.
   - 716 compartidos: Reutiliza FM existentes, crea LINK
   - 10 payouts nuevos: Crea FM + LE, ambos con needs_review=TRUE para clasificación posterior
   - 72 reservas: Almacena RAW, sin FM/LE (balance_impact=0)
   Retorna IDs de creados para rollback seguro.';

-- ============================================================================
-- FIN RPC
-- ============================================================================
```

---

## [C] IMPORTER: import_liberaciones.py

**Archivo**: `scripts/import_liberaciones.py`

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Importer: Liberaciones3.csv → Supabase
Settlement Report como fuente secundaria de datos.

Ejecución: SECUENCIAL, batches de 100, sin paralelismo.
"""

import csv
import json
import hashlib
from pathlib import Path
from decimal import Decimal
from datetime import datetime
import sys

import supabase
from supabase import create_client

# ============================================================================
# CONFIG
# ============================================================================

SUPABASE_URL = "<SUPABASE_URL>"
SUPABASE_KEY = "<SUPABASE_SERVICE_ROLE_KEY>"
ACCOUNT_ID = 1054315166
CSV_PATH = Path("data/mercadopago/Liberaciones3.csv")
BATCH_SIZE = 100

# ============================================================================
# FUNCIONES
# ============================================================================

def normalize_row(csv_row):
    """Normalizar fila CSV a formato JSONB para RPC"""
    
    # Parsear montos
    cr = Decimal(str(csv_row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
    db = Decimal(str(csv_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
    gross = Decimal(str(csv_row.get('GROSS_AMOUNT', '0')).replace(',', '.'))
    tax = Decimal(str(csv_row.get('TAXES_AMOUNT', '0')).replace(',', '.'))
    
    # Payload hash: SHA256 de row completa como JSON
    payload_json = json.dumps(csv_row, sort_keys=True, default=str)
    payload_hash = hashlib.sha256(payload_json.encode()).hexdigest()
    
    # Retornar normalizado para RPC
    return {
        'SOURCE_ID': csv_row.get('SOURCE_ID'),
        'DESCRIPTION': csv_row.get('DESCRIPTION'),
        'DATE': csv_row.get('DATE'),
        'NET_CREDIT_AMOUNT': str(cr),
        'NET_DEBIT_AMOUNT': str(db),
        'GROSS_AMOUNT': str(gross),
        'TAXES_AMOUNT': str(tax),
        'MP_FEE_AMOUNT': csv_row.get('MP_FEE_AMOUNT', '0'),
        'PAYMENT_METHOD_TYPE': csv_row.get('PAYMENT_METHOD_TYPE'),
        'PAYMENT_METHOD_ID': csv_row.get('PAYMENT_METHOD_ID'),
        'PAYER_NAME': csv_row.get('PAYER_NAME'),
        'TAX_DETAIL': csv_row.get('TAX_DETAIL'),
        'BALANCE_AMOUNT': csv_row.get('BALANCE_AMOUNT'),
        # ... todos los campos
        '_payload_hash': payload_hash
    }

def read_csv(path):
    """Leer CSV de Liberaciones"""
    records = []
    with open(path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        for row in reader:
            date_str = row.get('DATE', '')[:10]
            if date_str.startswith('2026-08'):
                records.append(row)
    return records

def import_batch(client, batch_records):
    """Ejecutar RPC para un lote (SECUENCIAL)"""
    
    normalized = [normalize_row(r) for r in batch_records]
    
    try:
        result = client.rpc(
            'import_liberaciones_primary',
            {
                'p_account_id': ACCOUNT_ID,
                'p_input': normalized
            }
        ).execute()
        
        return result.data
    
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'batch_size': len(batch_records)
        }

def main():
    """Flujo principal"""
    
    print("\n" + "="*100)
    print("IMPORTER: Liberaciones3.csv -> Supabase")
    print("="*100)
    
    # [1] Conectar
    print(f"\n[1] Conectando a Supabase...")
    client = create_client(SUPABASE_URL, SUPABASE_KEY)
    print(f"    OK")
    
    # [2] Leer CSV
    print(f"\n[2] Leyendo Liberaciones3.csv (agosto)...")
    records = read_csv(CSV_PATH)
    print(f"    Registros: {len(records)}")
    
    if not records:
        print(f"    ERROR: No se encontraron registros de agosto")
        sys.exit(1)
    
    # [3] Procesar batches SECUENCIALMENTE
    print(f"\n[3] Procesando {len(records)} registros en batches de {BATCH_SIZE}...")
    
    total_sr_created = 0
    total_sr_existing = 0
    total_sr_raw_only = 0
    total_fm_created = 0
    total_le_created = 0
    total_links = 0
    
    all_created_fm_ids = []
    all_created_le_ids = []
    
    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i:i+BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(records) + BATCH_SIZE - 1) // BATCH_SIZE
        
        print(f"\n    Batch {batch_num}/{total_batches} ({len(batch)} registros)...")
        
        result = import_batch(client, batch)
        
        if not result.get('success', False):
            print(f"      ERROR: {result.get('error')}")
            print(f"      Rollback recomendado. IDs creados hasta ahora:")
            print(f"        FM: {all_created_fm_ids}")
            print(f"        LE: {all_created_le_ids}")
            sys.exit(1)
        
        summary = result.get('summary', {})
        total_sr_created += summary.get('source_records_created', 0)
        total_sr_existing += summary.get('source_records_existing', 0)
        total_sr_raw_only += summary.get('source_records_raw_only', 0)
        total_fm_created += summary.get('financial_movements_created', 0)
        total_le_created += summary.get('ledger_entries_created', 0)
        total_links += summary.get('movement_source_links_created', 0)
        
        if result.get('created_financial_movement_ids'):
            all_created_fm_ids.extend(result['created_financial_movement_ids'])
        
        if result.get('created_ledger_entry_ids'):
            all_created_le_ids.extend(result['created_ledger_entry_ids'])
        
        print(f"      SR: {summary.get('source_records_created')} nuevos, " +
              f"{summary.get('source_records_existing')} existentes, " +
              f"{summary.get('source_records_raw_only')} raw-only")
        print(f"      FM: {summary.get('financial_movements_created')} nuevos")
        print(f"      LE: {summary.get('ledger_entries_created')} nuevas")
        print(f"      LINK: {summary.get('movement_source_links_created')}")
    
    # [4] Resumen
    print(f"\n" + "="*100)
    print("RESUMEN IMPORTACIÓN")
    print("="*100)
    print(f"\nSource Records:")
    print(f"  Creados: {total_sr_created}")
    print(f"  Existentes: {total_sr_existing}")
    print(f"  Raw-only (reservas): {total_sr_raw_only}")
    print(f"  TOTAL: {total_sr_created + total_sr_existing + total_sr_raw_only}")
    
    print(f"\nFinancial Movements:")
    print(f"  Creados (payouts nuevos): {total_fm_created}")
    print(f"  Reutilizados (716): 716")
    print(f"  TOTAL correlacionados: {total_fm_created + 716}")
    
    print(f"\nLedger Entries:")
    print(f"  Creadas (payouts nuevos): {total_le_created}")
    print(f"  Reutilizadas (716): 716")
    print(f"  TOTAL: {total_le_created + 716}")
    
    print(f"\nMovement Source Links:")
    print(f"  Creados (reutilizar + nuevos): {total_links}")
    print(f"  Esperado: 726 (716 reutilizar + 10 nuevos)")
    
    print(f"\nIDs creados (para rollback si es necesario):")
    print(f"  FM: {all_created_fm_ids}")
    print(f"  LE: {all_created_le_ids}")
    
    print(f"\n" + "="*100)
    print("IMPORTACIÓN COMPLETADA")
    print("Ejecutar queries de validación desde VALIDACION_QUERIES.sql")
    print("="*100 + "\n")

if __name__ == '__main__':
    main()
```

---

## [D] QUERIES DE VALIDACIÓN

**Archivo**: `sql/validacion_liberaciones_import.sql`

```sql
-- ============================================================================
-- VALIDACIÓN POST-IMPORTACIÓN: Liberaciones3.csv
-- ============================================================================
-- Ejecutar DESPUÉS de completar import_liberaciones_primary()
-- Todas las queries son READ-ONLY
-- ============================================================================

-- [1] Verificar SR creados (debe ser 798)
SELECT 'SR_created' as check_name,
       COUNT(*) as total,
       '798' as expected,
       CASE WHEN COUNT(*) = 798 THEN 'PASS' ELSE 'FAIL' END as status
FROM mp_source_record
WHERE source_type='liberaciones';

-- [2] Verificar FM nuevos (debe ser 10, los payouts)
SELECT 'FM_new_payouts' as check_name,
       COUNT(*) as total,
       '10' as expected,
       CASE WHEN COUNT(*) = 10 THEN 'PASS' ELSE 'FAIL' END as status
FROM mp_financial_movement fm
WHERE fm.movement_class='unclassified'
  AND fm.needs_review=TRUE
  AND EXISTS (
    SELECT 1 FROM mp_movement_source_link link
    JOIN mp_source_record sr ON sr.id = link.source_record_id
    WHERE sr.source_type='liberaciones'
      AND fm.id = link.financial_movement_id
  );

-- [3] Verificar LE nuevas (debe ser 10)
SELECT 'LE_new' as check_name,
       COUNT(*) as total,
       '10' as expected,
       CASE WHEN COUNT(*) = 10 THEN 'PASS' ELSE 'FAIL' END as status
FROM ledger_entry le
WHERE le.category='other'
  AND EXISTS (
    SELECT 1 FROM mp_financial_movement fm
    WHERE fm.id = le.financial_movement_id
      AND fm.movement_class='unclassified'
      AND fm.needs_review=TRUE
  );

-- [4] Verificar LINKS creados (debe ser 726)
SELECT 'Links_created' as check_name,
       COUNT(*) as total,
       '726' as expected,
       CASE WHEN COUNT(*) = 726 THEN 'PASS' ELSE 'FAIL' END as status
FROM mp_movement_source_link link
WHERE EXISTS (
  SELECT 1 FROM mp_source_record sr
  WHERE sr.id = link.source_record_id
    AND sr.source_type='liberaciones'
);

-- [5] Verificar CERO duplicate LE
SELECT 'No_duplicate_LE' as check_name,
       COUNT(*) as duplicates,
       '0' as expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END as status
FROM (
  SELECT financial_movement_id, COUNT(*) as cnt
  FROM ledger_entry
  GROUP BY financial_movement_id
  HAVING COUNT(*) > 1
) x;

-- [6] Neto total agosto (debe ser -124203.24 ± 0.03)
SELECT 'August_neto' as check_name,
       SUM(balance_impact) as total_neto,
       '-124203.24'::DECIMAL as expected,
       CASE 
         WHEN ABS(SUM(balance_impact) - '-124203.24'::DECIMAL) <= 0.03 THEN 'PASS'
         ELSE 'FAIL'
       END as status
FROM ledger_entry le
WHERE le.account_id=1054315166
  AND DATE(le.occurred_at) BETWEEN '2026-08-01' AND '2026-08-31';

-- [7] Desglose: Reutilizados vs Nuevos
SELECT 'Reutilizados_716' as category,
       COUNT(*) as fm_count,
       SUM(le.balance_impact) as total_neto
FROM mp_financial_movement fm
JOIN ledger_entry le ON le.financial_movement_id = fm.id
JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
JOIN mp_source_record sr ON sr.id = link.source_record_id
WHERE sr.source_type='report'
  AND le.account_id=1054315166
  AND DATE(le.occurred_at) BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

SELECT 'Nuevos_10' as category,
       COUNT(*) as fm_count,
       SUM(le.balance_impact) as total_neto
FROM mp_financial_movement fm
JOIN ledger_entry le ON le.financial_movement_id = fm.id
JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
JOIN mp_source_record sr ON sr.id = link.source_record_id
WHERE sr.source_type='liberaciones'
  AND fm.movement_class='unclassified'
  AND le.account_id=1054315166
  AND DATE(le.occurred_at) BETWEEN '2026-08-01' AND '2026-08-31'

ORDER BY category;

-- ============================================================================
-- FIN VALIDACIÓN
-- ============================================================================
```

---

## [E] ROLLBACK SEGURO (SI ES NECESARIO)

**Archivo**: `sql/rollback_liberaciones_import.sql`

**IMPORTANTE**: Solo usar si algo salió mal DURANTE la importación.

```sql
-- ============================================================================
-- ROLLBACK: Liberaciones Import (SOLO SI NECESARIO)
-- ============================================================================
-- USO: Ejecutar SOLAMENTE si la importación falló o produce datos incorrectos
-- PRECAUCIÓN: Requiere IDs exactos de FM/LE creados por la importación
-- ============================================================================

-- PARÁMETROS: Reemplazar con valores REALES retornados por importer
-- Ej: SELECT FROM import_liberaciones_primary() result -> created_financial_movement_ids
SET @created_fm_ids = ARRAY[1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010];
SET @created_le_ids = ARRAY[2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010];

-- PASO 1: Eliminar LE creadas (por ID exacto)
DELETE FROM ledger_entry
WHERE id = ANY(@created_le_ids);

-- PASO 2: Eliminar FM creadas (por ID exacto)
DELETE FROM mp_financial_movement
WHERE id = ANY(@created_fm_ids);

-- PASO 3: Eliminar LINK de Liberaciones creadas
DELETE FROM mp_movement_source_link link
WHERE EXISTS (
  SELECT 1 FROM mp_source_record sr
  WHERE sr.id = link.source_record_id
    AND sr.source_type='liberaciones'
);

-- PASO 4: Eliminar SR de Liberaciones
DELETE FROM mp_source_record sr
WHERE sr.source_type='liberaciones';

-- PASO 5: Verificar estado POST-ROLLBACK
SELECT 'Verificacion_post_rollback' as step,
       (SELECT COUNT(*) FROM mp_source_record WHERE source_type='liberaciones') as sr_liberaciones,
       (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class='unclassified' AND needs_review=TRUE) as fm_unclassified,
       (SELECT SUM(balance_impact) FROM ledger_entry WHERE account_id=1054315166 AND DATE(occurred_at) BETWEEN '2026-08-01' AND '2026-08-31') as neto_agosto;

-- Esperado:
-- sr_liberaciones = 0
-- fm_unclassified = 0
-- neto_agosto = 10,780,612.05 (solo arch5, sin payouts nuevos)

-- ============================================================================
-- FIN ROLLBACK
-- ============================================================================
```

---

## [F] CHECKLIST DE EJECUCIÓN

Antes de ejecutar, verificar:

- [ ] Migración 006 no se ha ejecutado
- [ ] RPC no existe en Supabase (o será reemplazada)
- [ ] Archivo `data/mercadopago/Liberaciones3.csv` existe y es accesible
- [ ] SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY están configuradas
- [ ] account_id 1054315166 existe en BD
- [ ] calc_economic_hash() función está disponible (de migración 005)

Orden de ejecución:

1. Ejecutar migración 006 (ALTER CONSTRAINT)
2. Ejecutar RPC (create function)
3. Ejecutar importer.py
4. Ejecutar validacion_queries.sql (READ-ONLY)
5. Guardar IDs creados para rollback si es necesario

---

**Estado**: LISTO PARA EJECUTAR (pero NO ejecutado aún)  
**Validación pendiente**: User review

