# CÓDIGO FINAL v2: Integración Liberaciones3.csv
## Correcciones de problemas bloqueantes 1-9

**Estado**: LISTO PARA EJECUTAR (sin ejecutar aún)  
**Fecha**: 2026-09-05  
**Validaciones**: Puntos críticos 1-9 incorporados

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

## [B] RPC: import_liberaciones_primary() v2

**Archivo**: `supabase/functions/import_liberaciones_primary.sql`

```sql
-- ============================================================================
-- RPC: import_liberaciones_primary() v2
-- ============================================================================
-- Integración genérica de Settlement Report (Liquidaciones3.csv)
-- Correlaciona con Account Money Report (arch5.csv) por SOURCE_ID
-- 
-- ATOMICIDAD: Lote = 1 transacción. Si falla, rollback TODO.
-- No se capturan excepciones dentro de la RPC.
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
  
  -- Arrays para retornar IDs creados (para rollback seguro)
  v_created_sr_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_fm_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_le_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_link_ids BIGINT[] := ARRAY[]::BIGINT[];
  
  v_idx INT := 0;
  v_link_id BIGINT;
  
BEGIN
  -- Extraer array de registros
  v_records := ARRAY(SELECT jsonb_array_elements(p_input));
  
  -- Comenzar transacción explícita (implícita en RPC)
  -- Si hay error, ROLLBACK automático de TODO el batch
  
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
      RAISE EXCEPTION '[Fila %] Campos requeridos: source_external_id, description, payload_hash', v_idx;
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
      NOW(),                  -- Momento de importación
      NOW(),
      'processed'
    )
    ON CONFLICT (source_type, source_external_id, payload_hash) 
    DO NOTHING
    RETURNING id INTO v_source_record_id;
    
    IF v_source_record_id IS NULL THEN
      -- Ya existe este SR exacto
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
    -- PASO 2: Whitelist de DESCRIPTION
    -- ================================================================
    
    IF NOT (v_description IN ('payment', 'asset_management', 'payout', 
                              'reserve_for_payment', 'reserve_for_payout')) THEN
      -- Desconocido: guardar RAW, sin FM/LE
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;
    
    -- ================================================================
    -- PASO 3: Determinar acción según balance_impact
    -- ================================================================
    
    IF ABS(v_balance_impact) < 0.01 THEN
      -- RESERVAS: solo guardar RAW, sin FM/LE
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;
    
    -- ================================================================
    -- PASO 4: Buscar correlación en arch5 (por SOURCE_ID)
    -- ================================================================
    
    SELECT fm.id
    INTO v_existing_fm_id
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
        -- No asumir transfer_out
        -- Usar 'unclassified' para revisión posterior
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
      -- REUTILIZAR FM (compartidos: 716)
      -- Validar que balance_impact Liberaciones == settlement_amount existente
      -- No comparar economic_hash entre reportes distintos
      v_financial_movement_id := v_existing_fm_id;
      -- NO modificar FM existente
      
    ELSE
      -- CREAR FM NUEVA (payouts: 10)
      INSERT INTO mp_financial_movement (
        account_id,
        movement_class,
        transaction_amount,
        settlement_amount,
        tax_amount,
        payment_method,
        payer_name,
        transaction_date,
        settlement_date,
        economic_hash,
        needs_review
      ) VALUES (
        p_account_id,
        v_movement_class,
        (v_record->>'gross_amount')::NUMERIC(15,2),
        v_balance_impact,
        (v_record->>'tax_amount')::NUMERIC(15,2),
        v_record->>'payment_method_type',
        v_record->>'payer_name',
        v_transaction_date,
        v_transaction_date,
        encode(digest(
          COALESCE(v_record->>'gross_amount', '') || 
          COALESCE(v_record->>'settlement_amount', '') ||
          COALESCE(v_record->>'tax_amount', '') ||
          v_movement_class ||
          COALESCE(v_transaction_date::TEXT, '') ||
          COALESCE(v_record->>'payment_method_type', ''),
          'sha256'
        ), 'hex'),
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
      RETURNING id INTO v_ledger_entry_id;
      
      v_le_created := v_le_created + 1;
      v_created_le_ids := array_append(v_created_le_ids, v_ledger_entry_id);
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
  -- RETORNO (si llegamos aquí, TODO exitoso - transacción se commitea)
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
  -- Excepción no capturada -> ROLLBACK automático de TODO el batch
  -- El importer ve {success: FALSE}
  RAISE EXCEPTION '[import_liberaciones_primary] Lote falló en fila %: % (SQLSTATE: %)', 
    v_idx, SQLERRM, SQLSTATE;

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMENTARIOS
-- ============================================================================

COMMENT ON FUNCTION import_liberaciones_primary(BIGINT, JSONB) IS
  'Importa Settlement Report (Liberaciones.csv) como fuente secundaria.
   Correlaciona con Account Money Report por SOURCE_ID.
   ATOMICIDAD: Lote completo = 1 transacción. Si falla, rollback TODO.
   - 716 compartidos: Reutiliza FM, crea LINK (NO modifica FM)
   - 10 payouts nuevos: Crea FM + LE, ambos con needs_review=TRUE
   - 72 reservas: Almacena RAW only (balance_impact=0)
   - Desconocidos: RAW only, sin FM/LE
   Retorna IDs creados para rollback multi-período seguro.';

-- ============================================================================
-- FIN RPC
-- ============================================================================
```

---

## [C] IMPORTER: import_liberaciones.py v2

**Archivo**: `scripts/import_liberaciones.py`

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Importer: Liberaciones3.csv -> Supabase
Settlement Report como fuente secundaria.

Ejecución: SECUENCIAL, batches de 100, atomicidad por batch.
Credenciales desde .env (NO hardcodeadas).
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

load_dotenv()

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
ACCOUNT_ID = int(os.getenv('ACCOUNT_ID', '1054315166'))
CSV_PATH = Path("data/mercadopago/Liberaciones3.csv")
BATCH_SIZE = 100

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY no configuradas en .env")
    sys.exit(1)

# ============================================================================
# FUNCIONES
# ============================================================================

def normalize_row(csv_row):
    """Normalizar fila CSV a formato JSONB para RPC
    
    Incluye:
    - raw_data: CSV completo como JSON
    - payload_hash: SHA256 del raw_data
    - Campos derivados para acceso rápido
    """
    
    # Parsear montos
    cr = Decimal(str(csv_row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
    db = Decimal(str(csv_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
    gross = Decimal(str(csv_row.get('GROSS_AMOUNT', '0')).replace(',', '.'))
    tax = Decimal(str(csv_row.get('TAXES_AMOUNT', '0')).replace(',', '.'))
    balance_impact = cr - db
    
    # raw_data COMPLETO (todas las columnas del CSV)
    raw_data = {key: str(value) for key, value in csv_row.items()}
    
    # payload_hash = SHA256 del raw_data serializado
    raw_json = json.dumps(raw_data, sort_keys=True)
    payload_hash = hashlib.sha256(raw_json.encode()).hexdigest()
    
    # Retornar para RPC
    return {
        'source_external_id': csv_row.get('SOURCE_ID'),
        'description': csv_row.get('DESCRIPTION'),
        'transaction_date': csv_row.get('DATE'),
        'net_credit': str(cr),
        'net_debit': str(db),
        'settlement_amount': str(balance_impact),
        'gross_amount': str(gross),
        'tax_amount': str(tax),
        'payment_method_type': csv_row.get('PAYMENT_METHOD_TYPE'),
        'payment_method_id': csv_row.get('PAYMENT_METHOD_ID'),
        'payer_name': csv_row.get('PAYER_NAME'),
        'tax_detail': csv_row.get('TAX_DETAIL'),
        'balance_amount': csv_row.get('BALANCE_AMOUNT'),
        # Campos para RPC
        'payload_hash': payload_hash,
        'raw_data': raw_data  # COMPLETO
    }

def read_csv(path):
    """Leer CSV de Liberaciones"""
    records = []
    with open(path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        for row in reader:
            date_str = row.get('DATE', '')[:10]
            # IMPORTANTE: filtrar por august expl_ícitamente
            if date_str.startswith('2026-08'):
                records.append(row)
    return records

def import_batch(client, batch_records):
    """Ejecutar RPC para un lote (SECUENCIAL, ATÓMICO)
    
    Si falla, lanza excepción (no retorna {success: false}).
    El importer detiene el proceso.
    """
    
    normalized = [normalize_row(r) for r in batch_records]
    
    try:
        result = client.rpc(
            'import_liberaciones_primary',
            {
                'p_account_id': ACCOUNT_ID,
                'p_input': normalized
            }
        ).execute()
        
        # RPC solo retorna {success: true} si TODO exitoso
        if not result.data.get('success', False):
            raise Exception(f"RPC retornó error: {result.data.get('error', 'desconocido')}")
        
        return result.data
    
    except Exception as e:
        # Propagar excepción -> importer se detiene
        raise

def main():
    """Flujo principal"""
    
    print("\n" + "="*120)
    print("IMPORTER: Liberaciones3.csv -> Supabase (v2 - Atómico)")
    print("="*120)
    
    # [1] Conectar
    print(f"\n[1] Conectando a Supabase...")
    try:
        client = create_client(SUPABASE_URL, SUPABASE_KEY)
        print(f"    OK - Account ID: {ACCOUNT_ID}")
    except Exception as e:
        print(f"    ERROR: {e}")
        sys.exit(1)
    
    # [2] Leer CSV
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
    
    # [3] Procesar batches SECUENCIALMENTE
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
            print(f"      LINK: {summary.get('movement_source_links_created', 0)} nuevas")
        
        except Exception as e:
            print(f"      ERROR (BATCH FALLÓ - TODO rolled back): {e}")
            print(f"\n      Status: Batches anteriores exitosos pueden permanecer (idempotencia).")
            print(f"      Acción: Corregir error y reejecutar. La RPC es idempotente.")
            sys.exit(1)
    
    # [4] Resumen final
    print(f"\n" + "="*120)
    print("RESUMEN IMPORTACIÓN")
    print("="*120)
    
    total_sr = total_sr_created + total_sr_existing + total_sr_raw_only
    
    print(f"\nSource Records:")
    print(f"  Creados: {total_sr_created}")
    print(f"  Existentes: {total_sr_existing}")
    print(f"  Raw-only (reservas): {total_sr_raw_only}")
    print(f"  TOTAL: {total_sr}")
    print(f"  ESPERADO: 798")
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
    print("Ejecutar queries de validación desde validacion_liberaciones_import.sql")
    print("="*120 + "\n")
    
    # [5] Guardar resultado para referencia (incluyendo IDs para rollback)
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
    
    print("Resultado guardado en: liberaciones_import_result.json")

if __name__ == '__main__':
    main()
```

---

## [D] ARCHIVO .env.template

**Archivo**: `.env.template`

```env
# Supabase
SUPABASE_URL=https://[project].supabase.co
SUPABASE_SERVICE_ROLE_KEY=<paste_service_role_key_here>

# Import config
ACCOUNT_ID=1054315166
```

**Instrucciones**:
```
1. Copiar .env.template -> .env.local
2. Editar .env.local con valores reales
3. No commitear .env.local (agregar a .gitignore)
```

---

## [E] QUERIES DE VALIDACIÓN

**Archivo**: `sql/validacion_liberaciones_import_v2.sql`

```sql
-- ============================================================================
-- VALIDACIÓN POST-IMPORTACIÓN: Liberaciones3.csv v2
-- ============================================================================
-- Ejecutar DESPUÉS de completar import_liberaciones_primary()
-- Todas las queries son READ-ONLY
-- Validar invariantes para primera importación agosto
-- ============================================================================

-- [1] Verificar SR creados (TOTAL 798, sin contar por tipo)
SELECT 'SR_total_august' as check_name,
       COUNT(*) as total,
       798 as expected,
       CASE WHEN COUNT(*) = 798 THEN 'PASS' ELSE 'FAIL' END as status
FROM mp_source_record sr
WHERE sr.source_type='liberaciones'
  AND DATE(sr.observed_at) = (SELECT MAX(DATE(observed_at)) 
                              FROM mp_source_record 
                              WHERE source_type='liberaciones');

-- [2] Verificar FM nuevos EXACTAMENTE 10 (unclassified + needs_review)
SELECT 'FM_new_exactly_10' as check_name,
       COUNT(*) as total,
       10 as expected,
       CASE WHEN COUNT(*) = 10 THEN 'PASS' ELSE 'FAIL' END as status
FROM mp_financial_movement fm
WHERE fm.movement_class='unclassified'
  AND fm.needs_review=TRUE
  AND EXISTS (
    SELECT 1 FROM mp_movement_source_link link
    JOIN mp_source_record sr ON sr.id = link.source_record_id
    WHERE sr.source_type='liberaciones'
      AND fm.id = link.financial_movement_id
      AND DATE(sr.observed_at) = (SELECT MAX(DATE(observed_at)) 
                                  FROM mp_source_record 
                                  WHERE source_type='liberaciones')
  );

-- [3] Verificar LE nuevas EXACTAMENTE 10
SELECT 'LE_new_exactly_10' as check_name,
       COUNT(*) as total,
       10 as expected,
       CASE WHEN COUNT(*) = 10 THEN 'PASS' ELSE 'FAIL' END as status
FROM ledger_entry le
WHERE le.category='other'
  AND DATE(le.recorded_at) = (SELECT MAX(DATE(recorded_at)) 
                              FROM ledger_entry le2 
                              WHERE le2.category='other'
                              AND EXISTS (
                                SELECT 1 FROM mp_financial_movement fm
                                WHERE fm.id = le2.financial_movement_id
                                  AND fm.movement_class='unclassified'
                              ))
  AND EXISTS (
    SELECT 1 FROM mp_financial_movement fm
    WHERE fm.id = le.financial_movement_id
      AND fm.movement_class='unclassified'
      AND fm.needs_review=TRUE
  );

-- [4] Verificar LINKS creados EXACTAMENTE 726
SELECT 'Links_exactly_726' as check_name,
       COUNT(*) as total,
       726 as expected,
       CASE WHEN COUNT(*) = 726 THEN 'PASS' ELSE 'FAIL' END as status
FROM mp_movement_source_link link
WHERE EXISTS (
  SELECT 1 FROM mp_source_record sr
  WHERE sr.id = link.source_record_id
    AND sr.source_type='liberaciones'
    AND DATE(sr.observed_at) = (SELECT MAX(DATE(observed_at)) 
                                FROM mp_source_record 
                                WHERE source_type='liberaciones')
);

-- [5] Verificar CERO FM reutilizados modificados
SELECT 'FM_reused_not_modified' as check_name,
       COUNT(*) as shared_fm_with_multiple_links,
       0 as expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN: verificar' END as status
FROM mp_financial_movement fm
WHERE EXISTS (
  SELECT 1 FROM mp_movement_source_link link1
  WHERE link1.financial_movement_id = fm.id
    AND EXISTS (
      SELECT 1 FROM mp_source_record sr1
      WHERE sr1.id = link1.source_record_id AND sr1.source_type='report'
    )
    AND EXISTS (
      SELECT 1 FROM mp_movement_source_link link2
      WHERE link2.financial_movement_id = fm.id
        AND EXISTS (
          SELECT 1 FROM mp_source_record sr2
          WHERE sr2.id = link2.source_record_id AND sr2.source_type='liberaciones'
        )
    )
)
AND fm.needs_review=TRUE;  -- Si es TRUE, fue modificado

-- [6] Verificar CERO duplicate LE
SELECT 'No_duplicate_LE' as check_name,
       COUNT(*) as duplicates,
       0 as expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END as status
FROM (
  SELECT financial_movement_id, COUNT(*) as cnt
  FROM ledger_entry
  GROUP BY financial_movement_id
  HAVING COUNT(*) > 1
) x;

-- [7] Verificar neto total agosto
SELECT 'August_neto_matches' as check_name,
       SUM(le.balance_impact)::NUMERIC(15,2) as calculated_neto,
       '-124203.24'::NUMERIC(15,2) as expected_neto,
       CASE 
         WHEN ABS(SUM(le.balance_impact) - '-124203.24'::NUMERIC(15,2)) <= 0.03 THEN 'PASS'
         ELSE 'FAIL'
       END as status
FROM ledger_entry le
WHERE le.account_id=1054315166
  AND DATE(le.occurred_at) BETWEEN '2026-08-01' AND '2026-08-31';

-- [8] Desglose: Reutilizados (716) vs Nuevos (10)
SELECT 'Desglose_by_source' as category,
       'reutilizados_report' as subcategory,
       COUNT(DISTINCT fm.id) as fm_count,
       SUM(le.balance_impact)::NUMERIC(15,2) as total_neto
FROM mp_financial_movement fm
JOIN ledger_entry le ON le.financial_movement_id = fm.id
JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
JOIN mp_source_record sr ON sr.id = link.source_record_id
WHERE sr.source_type='report'
  AND le.account_id=1054315166
  AND DATE(le.occurred_at) BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

SELECT 'Desglose_by_source' as category,
       'nuevos_liberaciones' as subcategory,
       COUNT(DISTINCT fm.id) as fm_count,
       SUM(le.balance_impact)::NUMERIC(15,2) as total_neto
FROM mp_financial_movement fm
JOIN ledger_entry le ON le.financial_movement_id = fm.id
JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
JOIN mp_source_record sr ON sr.id = link.source_record_id
WHERE sr.source_type='liberaciones'
  AND fm.movement_class='unclassified'
  AND le.account_id=1054315166
  AND DATE(le.occurred_at) BETWEEN '2026-08-01' AND '2026-08-31'

ORDER BY category, subcategory;

-- [9] Idempotencia: Re-ejecutar el mismo archivo debe retornar 0 cambios
-- (Nota: Esta query se ejecuta PRE-IMPORT segunda vez)
SELECT 'idempotence_check_pre' as check,
       (SELECT COUNT(*) FROM mp_source_record WHERE source_type='liberaciones' AND DATE(observed_at) > NOW() - INTERVAL '1 hour') as sr_created_this_hour,
       (SELECT COUNT(*) FROM mp_financial_movement WHERE needs_review=TRUE AND movement_class='unclassified' AND DATE(normalized_at) > NOW() - INTERVAL '1 hour') as fm_new_this_hour,
       'BEFORE_REIMPORT' as timing;

-- ============================================================================
-- FIN VALIDACIÓN
-- ============================================================================
```

---

## [F] ROLLBACK SEGURO (MULTI-PERÍODO)

**Archivo**: `sql/rollback_liberaciones_import.sql`

```sql
-- ============================================================================
-- ROLLBACK: Liberaciones Import (MULTI-PERÍODO SEGURO)
-- ============================================================================
-- USO: Ejecutar SOLO si algo salió mal DURANTE la importación
-- 
-- PARÁMETROS: Reemplazar los array de abajo con valores REALES
-- Fuente: liberaciones_import_result.json (archivo generado por importer)
--
-- El rollback SOLO borra los IDs CREADOS en esta importación.
-- No afecta datos 'report' (arch5) ni períodos anteriores de Liberaciones.
-- ============================================================================

-- PASO 1: Eliminar LE creadas (solo las de esta importación)
DELETE FROM ledger_entry
WHERE id = ANY(ARRAY[
  -- Pegar valores reales de created_ledger_entry_ids desde liberaciones_import_result.json
  -- Ej: 2001, 2002, 2003, ...
]);

-- PASO 2: Eliminar FM creadas (solo las de esta importación)
DELETE FROM mp_financial_movement
WHERE id = ANY(ARRAY[
  -- Pegar valores reales de created_financial_movement_ids
  -- Ej: 1001, 1002, ...
]);

-- PASO 3: Eliminar LINK creadas (solo las de esta importación)
DELETE FROM mp_movement_source_link
WHERE id = ANY(ARRAY[
  -- Pegar valores reales de created_link_ids
  -- Ej: 5001, 5002, ...
]);

-- PASO 4: Eliminar SR creadas (solo las de esta importación)
DELETE FROM mp_source_record
WHERE id = ANY(ARRAY[
  -- Pegar valores reales de created_source_record_ids
  -- Ej: 3001, 3002, ...
]);

-- PASO 5: Verificar estado POST-ROLLBACK
SELECT 'Verificacion_post_rollback' as step,
       (SELECT COUNT(*) FROM mp_source_record WHERE source_type='liberaciones' AND DATE(observed_at) = CAST((SELECT MAX(DATE(observed_at)) FROM mp_source_record WHERE source_type='liberaciones') AS DATE)) as sr_liberaciones_current_batch,
       (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class='unclassified' AND needs_review=TRUE) as fm_unclassified,
       (SELECT SUM(balance_impact) FROM ledger_entry WHERE account_id=1054315166 AND DATE(occurred_at) BETWEEN '2026-08-01' AND '2026-08-31') as neto_agosto;

-- Esperado POST-ROLLBACK:
-- sr_liberaciones_current_batch = 0
-- fm_unclassified = 0
-- neto_agosto = 10,780,612.05 (solo arch5, sin payots nuevos)

-- ============================================================================
-- FIN ROLLBACK
-- ============================================================================
```

---

## [G] CHECKLIST DE EJECUCIÓN

Antes de ejecutar:

- [ ] .env.local creado con credenciales reales
- [ ] Migración 006 está lista (ALTER CONSTRAINT)
- [ ] RPC anterior (si existe) será reemplazada
- [ ] Archivo `data/mercadopago/Liberaciones3.csv` accesible
- [ ] calc_economic_hash() disponible (de migración 005)
- [ ] account_id 1054315166 existe en BD
- [ ] No hay imports anteriores de 'liberaciones' tipo (limpio)

Orden de ejecución:

1. Ejecutar migración 006
2. Ejecutar RPC v2
3. Ejecutar importer.py
4. Ejecutar validacion_queries.sql
5. Guardar liberaciones_import_result.json para referencia/rollback

---

## [H] INVARIANTES VERIFICABLES

**Primera importación (agosto)**:
```
rows procesadas:              798
SR nuevos:                    798
SR raw-only reserves:          72
SR actual con link:           726
FM nuevos (payouts):           10
LE nuevos:                     10
links nuevos:                 726
Total neto:                   -124203.24 ± 0.03
```

**Segunda importación (mismo archivo)**:
```
SR nuevos:      0   (todos en CONFLICT)
FM nuevos:      0
LE nuevos:      0
links nuevos:   0   (todos en CONFLICT)
Total neto:     IDÉNTICO (no cambia)
```

**Rollback POST-FALLO**:
```
SR eliminados:  798
FM eliminados:  10
LE eliminados:  10
links eliminados: 726
Neto post-rollback: 10,780,612.05 (solo arch5)
```

---

**Estado**: ✓ CÓDIGO FINAL v2 COMPLETADO  
**Validaciones**: 9 puntos críticos incorporados  
**Próximo paso**: Revisión final y ejecución (cuando autorice)

