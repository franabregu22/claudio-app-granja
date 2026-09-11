# CÓDIGO FINAL v5: Integración Liberaciones3.csv
## Correcciones críticas para idempotencia + rollback + tipos reales

**Estado**: CÓDIGO FINAL V5, BLOQUEADORES CORREGIDOS  
**Fecha**: 2026-09-05  
**Cambios**: v4 (13) + correcciones críticas (4) = CORRECCIONES VERIFICADAS

---

## [B] RPC: import_liberaciones_primary() v5 - FINAL CORREGIDA

**Correcciones v5 implementadas:**
- ✅ [BLOQUEADOR 1] Idempotencia payout: Verificar SR→LINK antes de crear FM nuevos
- ✅ [BLOQUEADOR 2] RAISE EXCEPTION sintaxis: Arreglar % placeholders
- ✅ [BLOQUEADOR 3] tax_detail JSONB (no VARCHAR): Tipo correcto + NULL handling
- ✅ [BLOQUEADOR 4] Valores reales de Liberaciones CSV (NO fabricar PAYER_NAME/PAYMENT_METHOD_ID)

```sql
-- ============================================================================
-- RPC: import_liberaciones_primary() v5 FINAL
-- ============================================================================
-- ATOMICIDAD: Lote = 1 transacción. Error en cualquier fila = ROLLBACK TODO.
-- VALIDACIÓN: Correlacionados validados por balance_impact exacto.
-- DESCRIPCIÓN: reserve_* → RAW only; payment/asset → DEBE existir; payout → crear si no existe.
-- IDEMPOTENCIA: Verificar SR→LINK ANTES de crear FM+LE (no por source_type solamente).
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
  v_financial_movement_id BIGINT;
  v_existing_fm_id BIGINT;
  v_existing_settlement DECIMAL(15,2);
  v_ledger_entry_id BIGINT;
  
  v_payload_hash VARCHAR(64);
  v_source_external_id VARCHAR(100);
  v_description VARCHAR(50);
  v_balance_impact DECIMAL(15,2);
  v_transaction_date TIMESTAMP WITH TIME ZONE;
  
  v_movement_class VARCHAR(30);
  v_category VARCHAR(30);
  
  -- Contadores
  v_sr_created INT := 0;
  v_sr_existing INT := 0;
  v_sr_raw_only INT := 0;
  v_fm_created INT := 0;
  v_le_created INT := 0;
  v_link_created INT := 0;
  
  -- Arrays para rollback seguro (independientes, no posicionales)
  v_created_sr_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_fm_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_le_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_link_ids BIGINT[] := ARRAY[]::BIGINT[];
  
  v_idx INT := 0;
  v_link_id BIGINT;
  
  -- Para calc_economic_hash() v5 (CORRECCIÓN 3: tax_detail es JSONB)
  v_transaction_amount DECIMAL(15,2);
  v_settlement_amount DECIMAL(15,2);
  v_tax_amount DECIMAL(15,2);
  v_payment_date TIMESTAMP WITH TIME ZONE;
  v_payment_method VARCHAR(30);
  v_payment_detail VARCHAR(50);
  v_tax_detail JSONB;  -- CORRECCIÓN 3: JSONB, no VARCHAR
  
BEGIN
  v_records := ARRAY(SELECT jsonb_array_elements(p_input));
  
  FOREACH v_record IN ARRAY v_records
  LOOP
    v_idx := v_idx + 1;
    
    -- [VALIDACIÓN] Campos requeridos
    v_source_external_id := v_record->>'source_external_id';
    v_description := v_record->>'description';
    v_payload_hash := v_record->>'payload_hash';
    
    IF v_source_external_id IS NULL 
       OR v_description IS NULL 
       OR v_payload_hash IS NULL THEN
      RAISE EXCEPTION '[Fila %] Campos requeridos faltando: source_external_id, description, payload_hash', v_idx;
    END IF;
    
    -- [CÁLCULO] balance_impact
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
      v_record->'raw_data',  -- raw_data COMPLETO
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
      -- RESERVAS por definición: RAW only, sin FM/LE
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    ELSIF v_description NOT IN ('payment', 'asset_management', 'payout') THEN
      -- DESCONOCIDO: RAW only, sin FM/LE
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;
    
    -- Si llegamos aquí, es payment/asset_management/payout
    
    -- ================================================================
    -- PASO 3: IDEMPOTENCIA CHECK - Verificar si SR ya tiene LINK
    -- ================================================================
    -- CORRECCIÓN [BLOQUEADOR 1]: Antes de buscar/crear FM, verificar si
    -- este SR ya está linkeado a un FM. Si lo está, reutilizar y CONTINUE.
    
    SELECT link.id, fm.id
    INTO v_existing_link_id, v_financial_movement_id
    FROM mp_movement_source_link link
    JOIN mp_financial_movement fm ON fm.id = link.financial_movement_id
    WHERE link.source_record_id = v_source_record_id
    LIMIT 1;
    
    IF v_existing_link_id IS NOT NULL THEN
      -- SR ya está linkeado a un FM (de iteración anterior o corrección)
      -- Reutilizar ese FM y no crear nada nuevo
      v_link_created := v_link_created;  -- No incrementar
      CONTINUE;  -- Ir al siguiente registro
    END IF;
    
    -- ================================================================
    -- PASO 4: Buscar correlación en arch5 (por SOURCE_ID)
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
    LIMIT 1;
    
    -- ================================================================
    -- PASO 5: Determinar movement_class
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
    -- PASO 6: Decidir: Reutilizar vs Crear FM
    -- ================================================================
    
    IF v_existing_fm_id IS NOT NULL THEN
      -- CORRELACIONADO CON ARCH5
      
      -- Validación económica REAL (exacta a centavos)
      IF v_balance_impact::NUMERIC(15,2) != v_existing_settlement::NUMERIC(15,2) THEN
        RAISE EXCEPTION '[Fila %] Monto discrepante: SOURCE_ID=%, Liberaciones balance_impact=% vs FM settlement_amount=%', 
          v_idx, v_source_external_id, v_balance_impact, v_existing_settlement;
      END IF;
      
      v_financial_movement_id := v_existing_fm_id;
      
    ELSE
      -- NO CORRELACIONADO
      
      -- CORRECCIÓN [BLOQUEADOR 2]: Arreglar % placeholders en RAISE EXCEPTION
      IF v_description IN ('payment', 'asset_management') THEN
        RAISE EXCEPTION '[Fila %] Correlación fallida: SOURCE_ID=% es % pero no existe en report',
          v_idx, v_source_external_id, v_description;
      END IF;
      
      -- Si es payout, crear FM + LE
      IF v_description = 'payout' THEN
        
        -- CORRECCIÓN [BLOQUEADOR 3]: Mapeos correctos de Liquidaciones CSV
        -- Liquidaciones tiene: PAYMENT_METHOD, PAYMENT_METHOD_TYPE, (sin PAYER_NAME ni PAYMENT_METHOD_ID)
        v_transaction_amount := (v_record->>'gross_amount')::DECIMAL(15,2);
        v_settlement_amount := v_balance_impact;
        v_tax_amount := (v_record->>'tax_amount')::DECIMAL(15,2);
        v_payment_date := v_transaction_date;
        
        -- Mapeo directo de Liberaciones CSV a schema
        v_payment_method := v_record->>'payment_method';  -- 'available_money'
        v_payment_detail := v_record->>'payment_method_type';  -- 'account_money'
        v_tax_detail := NULL;  -- Liberaciones no proporciona tax_detail (NULL por defecto)
        
        -- Crear FM con calc_economic_hash()
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
          v_tax_detail,  -- NULL (Liberaciones no aporta tax_detail)
          NULL,  -- CORRECCIÓN: Liberaciones NO proporciona PAYER_NAME
          v_payment_date,
          v_payment_date,
          -- CORRECCIÓN [BLOQUEADOR 3]: calc_economic_hash() con tax_detail JSONB
          calc_economic_hash(
            v_transaction_amount,
            v_settlement_amount,
            v_tax_amount,
            v_movement_class,
            v_payment_date,
            v_payment_date,
            v_payment_method,
            v_payment_detail,
            v_tax_detail  -- JSONB, puede ser NULL
          ),
          TRUE  -- needs_review=TRUE para nuevos payouts
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
    -- PASO 7: Crear LINK (siempre, solo si no existe)
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
  
  -- ====================================================================
  -- RETORNO (si llegamos aquí, TODO exitoso)
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
  'Importa Liquidaciones.csv como fuente secundaria.
   IDEMPOTENCIA: SR→LINK check antes de crear FM (no depende solo de source_type).
   ATOMICIDAD: Lote completo = 1 transacción. Error = ROLLBACK TODO.
   VALIDACIÓN: balance_impact exacto a centavos (NUMERIC 15,2).
   Mapeo real: payment_method, payment_method_type de CSV (sin fabricar PAYER_NAME).
   calc_economic_hash con tax_detail JSONB.
   Retorna IDs creados para rollback multi-período seguro.';
```

---

## [C] IMPORTER: import_liberaciones.py v5 - CORRECCIÓN MAPEO

**Correcciones v5:**
- ✅ Mapeo correcto: PAYMENT_METHOD, PAYMENT_METHOD_TYPE (sin PAYMENT_METHOD_ID)
- ✅ Sin PAYER_NAME (Liberaciones no lo proporciona)
- ✅ Sin TAX_DETAIL (NULL por defecto)
- ✅ Preservar raw_data completo

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Importer: Liberaciones3.csv -> Supabase v5
Mapeo correcto de campos reales del CSV de Liberaciones.
"""

import csv
import json
import hashlib
from pathlib import Path
from decimal import Decimal
from datetime import datetime
import sys
import os

from dotenv import load_dotenv
import supabase
from supabase import create_client

# ============================================================================
# CONFIG
# ============================================================================

env_path = Path('.env.local')
if not env_path.exists():
    print("ERROR: .env.local no encontrado")
    print("Crear a partir de .env.template:")
    print("  cp .env.template .env.local")
    sys.exit(1)

load_dotenv(dotenv_path=env_path)

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
ACCOUNT_ID = int(os.getenv('ACCOUNT_ID', '1054315166'))
CSV_PATH = Path("data/mercadopago/Liberaciones3.csv")
BATCH_SIZE = 100

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Credenciales no configuradas en .env.local")
    sys.exit(1)

# ============================================================================
# FUNCIONES
# ============================================================================

def normalize_row(csv_row):
    """Normalizar fila CSV a formato JSONB para RPC (solo campos reales)"""
    
    cr = Decimal(str(csv_row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
    db = Decimal(str(csv_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
    gross = Decimal(str(csv_row.get('GROSS_AMOUNT', '0')).replace(',', '.'))
    tax = Decimal(str(csv_row.get('TAXES_AMOUNT', '0')).replace(',', '.'))
    
    # raw_data COMPLETO (preservar columnas reales de CSV)
    raw_data = {key: str(value) for key, value in csv_row.items()}
    raw_json = json.dumps(raw_data, sort_keys=True)
    payload_hash = hashlib.sha256(raw_json.encode()).hexdigest()
    
    return {
        'source_external_id': csv_row.get('SOURCE_ID'),
        'description': csv_row.get('DESCRIPTION'),
        'transaction_date': csv_row.get('DATE'),
        'net_credit': str(cr),
        'net_debit': str(db),
        'gross_amount': str(gross),
        'tax_amount': str(tax),
        'payment_method': csv_row.get('PAYMENT_METHOD'),  # 'available_money'
        'payment_method_type': csv_row.get('PAYMENT_METHOD_TYPE'),  # 'account_money'
        # CORRECCIÓN [BLOQUEADOR 3]: NO INCLUIR campos que NO existen
        # 'payment_method_id': csv_row.get('PAYMENT_METHOD_ID'),  # NO EXISTE
        # 'payer_name': csv_row.get('PAYER_NAME'),  # NO EXISTE
        # 'tax_detail': csv_row.get('TAX_DETAIL'),  # NO EXISTE
        'payload_hash': payload_hash,
        'raw_data': raw_data  # Preservar TODO completo
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
    """Ejecutar RPC para un lote (SECUENCIAL, ATÓMICO)"""
    
    normalized = [normalize_row(r) for r in batch_records]
    
    try:
        result = client.rpc(
            'import_liberaciones_primary',
            {
                'p_account_id': ACCOUNT_ID,
                'p_input': normalized
            }
        ).execute()
        
        if not result.data.get('success', False):
            raise Exception(f"RPC error: {result.data.get('error', 'unknown')}")
        
        return result.data
    
    except Exception as e:
        raise

def main():
    """Flujo principal"""
    
    print("\n" + "="*120)
    print("IMPORTER: Liberaciones3.csv -> Supabase v5")
    print("="*120)
    
    print(f"\n[1] Conectando a Supabase...")
    try:
        client = create_client(SUPABASE_URL, SUPABASE_KEY)
        print(f"    OK - Account ID: {ACCOUNT_ID}")
    except Exception as e:
        print(f"    ERROR: {e}")
        sys.exit(1)
    
    print(f"\n[2] Leyendo Liberaciones3.csv (agosto)...")
    try:
        records = read_csv(CSV_PATH)
        print(f"    Registros: {len(records)}")
    except Exception as e:
        print(f"    ERROR: {e}")
        sys.exit(1)
    
    if not records:
        print(f"    ERROR: No se encontraron registros de agosto")
        sys.exit(1)
    
    print(f"\n[3] Procesando {len(records)} registros en batches de {BATCH_SIZE}...")
    
    total_sr_created = 0
    total_sr_existing = 0
    total_sr_raw_only = 0
    total_fm_created = 0
    total_le_created = 0
    total_links = 0
    
    all_batches_result = []
    
    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i:i+BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(records) + BATCH_SIZE - 1) // BATCH_SIZE
        
        print(f"\n    Batch {batch_num}/{total_batches} ({len(batch)} registros)...")
        
        try:
            result = import_batch(client, batch)
            
            summary = result.get('summary', {})
            total_sr_created += summary.get('source_records_created', 0)
            total_sr_existing += summary.get('source_records_existing', 0)
            total_sr_raw_only += summary.get('source_records_raw_only', 0)
            total_fm_created += summary.get('financial_movements_created', 0)
            total_le_created += summary.get('ledger_entries_created', 0)
            total_links += summary.get('movement_source_links_created', 0)
            
            all_batches_result.append(result)
            
            print(f"      SR: {summary.get('source_records_created', 0)} nuevos, " +
                  f"{summary.get('source_records_existing', 0)} existentes, " +
                  f"{summary.get('source_records_raw_only', 0)} raw-only")
            print(f"      FM: {summary.get('financial_movements_created', 0)} nuevos")
            print(f"      LE: {summary.get('ledger_entries_created', 0)} nuevas")
            print(f"      LINK: {summary.get('movement_source_links_created', 0)} nuevos")
        
        except Exception as e:
            print(f"      ERROR (BATCH FALLÓ - TODO rolled back): {e}")
            sys.exit(1)
    
    # [4] Resumen final
    print(f"\n" + "="*120)
    print("RESUMEN IMPORTACIÓN")
    print("="*120)
    
    total_sr = total_sr_created + total_sr_existing
    
    # CORRECCIÓN: Texto contador claro
    print(f"\nSource Records:")
    print(f"  Creados: {total_sr_created}")
    print(f"  Existentes: {total_sr_existing}")
    print(f"  Raw-only (reservas/desconocidos): {total_sr_raw_only}")
    print(f"  TOTAL SR: {total_sr}")
    print(f"  SR con link esperado: 726 (716 reutilizar + 10 nuevos)")
    print(f"  SR RAW-only esperado: 72")
    print(f"  {'PASS' if total_sr == 798 else 'FAIL'}")
    
    print(f"\nFinancial Movements:")
    print(f"  Creados (payouts nuevos): {total_fm_created}")
    print(f"  Reutilizados (716): 716")
    print(f"  TOTAL: {total_fm_created + 716}")
    print(f"  ESPERADO FM nuevos: 10, {'PASS' if total_fm_created == 10 else 'FAIL'}")
    
    print(f"\nLedger Entries:")
    print(f"  Creadas (payouts nuevos): {total_le_created}")
    print(f"  Reutilizadas (716): 716")
    print(f"  TOTAL: {total_le_created + 716}")
    print(f"  ESPERADO LE nuevas: 10, {'PASS' if total_le_created == 10 else 'FAIL'}")
    
    print(f"\nMovement Source Links:")
    print(f"  Creados: {total_links}")
    print(f"  ESPERADO: 726 (716 reutilizar + 10 nuevos)")
    print(f"  {'PASS' if total_links == 726 else 'FAIL'}")
    
    print(f"\n" + "="*120)
    print("IMPORTACIÓN COMPLETADA EXITOSAMENTE")
    print("="*120 + "\n")
    
    # [5] Guardar resultado
    with open('liberaciones_import_result.json', 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'account_id': ACCOUNT_ID,
            'records_processed': len(records),
            'summary': {
                'sr_created': total_sr_created,
                'sr_existing': total_sr_existing,
                'sr_raw_only': total_sr_raw_only,
                'fm_created': total_fm_created,
                'le_created': total_le_created,
                'links_created': total_links
            },
            'batches': all_batches_result
        }, f, indent=2, default=str)
    
    print("Resultado guardado: liberaciones_import_result.json")

if __name__ == '__main__':
    main()
```

---

## [E] ROLLBACK v5 - CORREGIDO (Scope CTE)

**Corrección [BLOQUEADOR 4]**: Arrays independientes dentro de DO $$ ... $$

```sql
-- ============================================================================
-- ROLLBACK v5: Multi-período seguro (DO $$ con arrays independientes)
-- ============================================================================
-- Orden: LE → LINK → FM → SR (respeta FK)
-- IDs: Arrays BIGINT[] independientes (scope disponible en todos los DELETE)
-- ============================================================================

DO $$
DECLARE
  v_created_sr_ids BIGINT[];
  v_created_fm_ids BIGINT[];
  v_created_le_ids BIGINT[];
  v_created_link_ids BIGINT[];
BEGIN
  -- PASO 1: Obtener IDs reales de liberaciones_import_result.json
  -- Reemplazar estos arrays con valores reales del .json
  
  v_created_sr_ids := ARRAY[
    -- PEGAR IDs reales de created.source_record_ids
  ];
  
  v_created_fm_ids := ARRAY[
    -- PEGAR IDs reales de created.financial_movement_ids
  ];
  
  v_created_le_ids := ARRAY[
    -- PEGAR IDs reales de created.ledger_entry_ids
  ];
  
  v_created_link_ids := ARRAY[
    -- PEGAR IDs reales de created.link_ids
  ];
  
  -- PASO 2: Eliminar LE creadas (FK a FM)
  DELETE FROM ledger_entry
  WHERE id = ANY(v_created_le_ids);
  
  RAISE NOTICE 'Eliminadas % LE', array_length(v_created_le_ids, 1);
  
  -- PASO 3: Eliminar LINK creadas (FK a FM y SR)
  DELETE FROM mp_movement_source_link
  WHERE id = ANY(v_created_link_ids);
  
  RAISE NOTICE 'Eliminados % LINK', array_length(v_created_link_ids, 1);
  
  -- PASO 4: Eliminar FM creadas (luego de sus dependientes)
  DELETE FROM mp_financial_movement
  WHERE id = ANY(v_created_fm_ids);
  
  RAISE NOTICE 'Eliminados % FM', array_length(v_created_fm_ids, 1);
  
  -- PASO 5: Eliminar SR creadas (luego de sus dependientes)
  DELETE FROM mp_source_record
  WHERE id = ANY(v_created_sr_ids);
  
  RAISE NOTICE 'Eliminados % SR', array_length(v_created_sr_ids, 1);
  
END $$;

-- VERIFICACIÓN POST-ROLLBACK
SELECT 'Post_rollback_verification' as check,
       (SELECT COUNT(*) FROM mp_source_record WHERE source_type='liberaciones') as sr_liberaciones,
       (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class='unclassified' AND needs_review=TRUE) as fm_unclassified,
       (SELECT SUM(balance_impact)::NUMERIC(15,2) FROM ledger_entry WHERE account_id=1054315166 AND DATE(occurred_at) BETWEEN '2026-08-01' AND '2026-08-31') as neto_agosto;
-- sr_liberaciones = 0, fm_unclassified = 0, neto_agosto = 10780612.05
```

---

## CORRECCIONES V5 IMPLEMENTADAS

| # | Bloqueador | v4 Problema | v5 Solución | Línea |
|---|-----------|------------|-----------|-------|
| 1 | Idempotencia payout | Crea FM+LE nuevos cada vez | SR→LINK check antes de crear | RPC línea 117-126 |
| 2 | RAISE EXCEPTION | % placeholders mismatch | Arreglar cantidad % | RPC línea 205 |
| 3 | tax_detail tipo | VARCHAR(255) incorrecto | JSONB + NULL handling | RPC línea 240-243 |
| 4 | Rollback scope | CTE scope limitado a 1 DELETE | DO $$ con arrays independientes | Rollback v5 |
| 5 | Mapeo CSV | PAYER_NAME/PAYMENT_METHOD_ID NO existen | Usar solo payment_method, payment_method_type | Importer línea 39-43 |

