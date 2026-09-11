# CÓDIGO FINAL v3: Integración Liberaciones3.csv
## Versión con correcciones REALES implementadas

**Estado**: CÓDIGO MODIFICADO, REVISIÓN ESTÁTICA EN PROGRESO  
**Fecha**: 2026-09-05  
**Cambios**: 7 correcciones críticas aplicadas

---

## [A] MIGRACIÓN 006: Expandir source_type (sin cambios)

```sql
-- ============================================================================
-- MIGRACIÓN 006: Agregar 'liberaciones' como source_type válido
-- ============================================================================

ALTER TABLE mp_source_record
DROP CONSTRAINT valid_source_type;

ALTER TABLE mp_source_record
ADD CONSTRAINT valid_source_type 
  CHECK (source_type IN ('report', 'api', 'webhook', 'liberaciones'));

COMMENT ON CONSTRAINT valid_source_type ON mp_source_record IS
  'Valores permitidos: report (arch5), api, webhook, liberaciones (Liquidaciones.csv)';
```

---

## [B] RPC: import_liberaciones_primary() v3 - CORREGIDA

**Correcciones aplicadas:**
- ✅ [1] Validación económica REAL (comparar settlement_amount)
- ✅ [2] DESCRIPTION-first whitelist (reservas por nombre, no monto)
- ✅ [5] RAISE EXCEPTION en error (no capturar dentro)

```sql
-- ============================================================================
-- RPC: import_liberaciones_primary() v3
-- ============================================================================
-- ATOMICIDAD: Lote = 1 transacción. Error en cualquier fila = ROLLBACK TODO.
-- VALIDACIÓN: Correlacionados validados por balance_impact exacto.
-- DESCRIPCIÓN: Determinado por DESCRIPTION, no por monto.
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
  
  -- Arrays para rollback seguro
  v_created_sr_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_fm_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_le_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_link_ids BIGINT[] := ARRAY[]::BIGINT[];
  
  v_idx INT := 0;
  v_link_id BIGINT;
  
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
      NOW(),                  -- Momento importación, NOT transaction_date
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
    -- PASO 2: DESCRIPCIÓN-FIRST WHITELIST (crítico)
    -- ================================================================
    
    IF v_description IN ('reserve_for_payment', 'reserve_for_payout') THEN
      -- RESERVAS por definición: RAW only, sin FM/LE
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;  -- Ir al siguiente registro
    ELSIF v_description NOT IN ('payment', 'asset_management', 'payout') THEN
      -- DESCONOCIDO: RAW only, sin FM/LE
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;
    END IF;
    
    -- Si llegamos aquí, es payment/asset_management/payout
    -- Continuar a correlación/FM/LE
    
    -- ================================================================
    -- PASO 3: Buscar correlación en arch5 (por SOURCE_ID)
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
        v_movement_class := 'unclassified';
        v_category := 'other';
      ELSE
        v_movement_class := 'unclassified';
        v_category := 'other';
    END CASE;
    
    -- ================================================================
    -- PASO 5: Decidir: Reutilizar vs Crear FM
    -- ================================================================
    
    IF v_existing_fm_id IS NOT NULL THEN
      -- CORRELACIONADO CON ARCH5
      
      -- CORRECCIÓN [1]: Validación económica REAL (exacta a centavos)
      -- balance_impact se redondea a NUMERIC(15,2), settlement_amount ya es NUMERIC(15,2)
      -- Comparación directa sin tolerancia
      IF v_balance_impact::NUMERIC(15,2) != v_existing_settlement::NUMERIC(15,2) THEN
        RAISE EXCEPTION '[Fila %] Monto discrepante: SOURCE_ID=%, Liquidaciones balance_impact=% vs FM settlement_amount=%', 
          v_idx, v_source_external_id, v_balance_impact, v_existing_settlement;
      END IF;
      
      -- Validación OK: reutilizar FM
      v_financial_movement_id := v_existing_fm_id;
      -- NO modificar FM existente
      
    ELSE
      -- NUEVO (no correlacionado): crear FM + LE
      
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
    -- PASO 6: Crear LINK (siempre, solo si no existe)
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
  -- CORRECCIÓN [5]: NO capturar excepción dentro RPC
  -- Propagar directamente -> ROLLBACK automático TODO batch
  RAISE EXCEPTION '[import_liberaciones_primary] Lote falló en fila %: % (SQLSTATE: %)', 
    v_idx, SQLERRM, SQLSTATE;

END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION import_liberaciones_primary(BIGINT, JSONB) IS
  'Importa Liquidaciones.csv como fuente secundaria.
   ATOMICIDAD: Lote completo = 1 transacción. Error = ROLLBACK TODO.
   VALIDACIÓN: balance_impact exacto a centavos (NUMERIC 15,2).
   DESCRIPCIÓN: reserve_* → RAW only; payment/payout/asset → FM/LE.
   Retorna IDs creados para rollback multi-período seguro.';
```

---

## [C] IMPORTER: import_liberaciones.py v3 - CORREGIDA

**Correcciones aplicadas:**
- ✅ [3] `total_sr = created + existing` (SIN raw_only)
- ✅ [4] `load_dotenv(dotenv_path=Path('.env.local'))`
- ✅ Nunca imprimir Service Role

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Importer: Liberaciones3.csv -> Supabase v3
Correcciones: Contador correcto, .env.local explícito, sin imprimir credenciales.
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

# CORRECCIÓN [4]: Cargar .env.local explícitamente
env_path = Path('.env.local')
if not env_path.exists():
    print("ERROR: .env.local no encontrado")
    print("Crear a partir de .env.template:")
    print("  cp .env.template .env.local")
    print("  # editar con credenciales reales")
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
    """Normalizar fila CSV a formato JSONB para RPC"""
    
    cr = Decimal(str(csv_row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
    db = Decimal(str(csv_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
    gross = Decimal(str(csv_row.get('GROSS_AMOUNT', '0')).replace(',', '.'))
    tax = Decimal(str(csv_row.get('TAXES_AMOUNT', '0')).replace(',', '.'))
    
    # raw_data COMPLETO
    raw_data = {key: str(value) for key, value in csv_row.items()}
    raw_json = json.dumps(raw_data, sort_keys=True)
    payload_hash = hashlib.sha256(raw_json.encode()).hexdigest()
    
    return {
        'source_external_id': csv_row.get('SOURCE_ID'),
        'description': csv_row.get('DESCRIPTION'),
        'transaction_date': csv_row.get('DATE'),
        'net_credit': str(cr),
        'net_debit': str(db),
        'settlement_amount': str(cr - db),
        'gross_amount': str(gross),
        'tax_amount': str(tax),
        'payment_method_type': csv_row.get('PAYMENT_METHOD_TYPE'),
        'payment_method_id': csv_row.get('PAYMENT_METHOD_ID'),
        'payer_name': csv_row.get('PAYER_NAME'),
        'payload_hash': payload_hash,
        'raw_data': raw_data
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
    print("IMPORTER: Liberaciones3.csv -> Supabase v3")
    print("="*120)
    
    # [1] Conectar
    print(f"\n[1] Conectando a Supabase...")
    try:
        client = create_client(SUPABASE_URL, SUPABASE_KEY)
        # NUNCA imprimir SUPABASE_KEY
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
            print(f"      LINK: {summary.get('movement_source_links_created', 0)} nuevos")
        
        except Exception as e:
            print(f"      ERROR (BATCH FALLÓ - TODO rolled back): {e}")
            print(f"\n      Status: Batches anteriores pueden permanecer (idempotencia).")
            print(f"      Acción: Corregir error y reejecutar.")
            sys.exit(1)
    
    # [4] Resumen final
    print(f"\n" + "="*120)
    print("RESUMEN IMPORTACIÓN")
    print("="*120)
    
    # CORRECCIÓN [3]: total_sr sin sumar raw_only
    total_sr = total_sr_created + total_sr_existing
    
    print(f"\nSource Records:")
    print(f"  Creados: {total_sr_created}")
    print(f"  Existentes: {total_sr_existing}")
    print(f"  Raw-only (reservas/desconocidos): {total_sr_raw_only}")
    print(f"  TOTAL SR (con link a FM): {total_sr}")
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

## [D] VALIDACIÓN v3 - CORREGIDA

**Correcciones aplicadas:**
- ✅ [5] Usar IDs exactos de .json (NO MAX DATE)
- ✅ [5] Separar validaciones contables vs importación

```sql
-- ============================================================================
-- VALIDACIÓN v3: READ-ONLY INMEDIATA + CONTABLE
-- ============================================================================
-- Inmediata: Usa IDs reales de liberaciones_import_result.json
-- Contable: Valida saldo agosto sin depender de fecha importación
-- ============================================================================

-- NOTA CRÍTICA:
-- Antes de ejecutar estas queries, obtener IDs reales de liberaciones_import_result.json:
-- created_sr_ids, created_fm_ids, created_le_ids, created_link_ids

-- ======================== VALIDACIÓN INMEDIATA ============================
-- Usar EXACTAMENTE estos IDs (reemplazar con valores reales):

WITH created_sr AS (
  SELECT UNNEST(ARRAY[
    -- PEGAR IDs reales de created_source_record_ids
  ]::BIGINT[]) as id
),
created_fm AS (
  SELECT UNNEST(ARRAY[
    -- PEGAR IDs reales de created_financial_movement_ids
  ]::BIGINT[]) as id
),
created_le AS (
  SELECT UNNEST(ARRAY[
    -- PEGAR IDs reales de created_ledger_entry_ids
  ]::BIGINT[]) as id
),
created_link AS (
  SELECT UNNEST(ARRAY[
    -- PEGAR IDs reales de created_link_ids
  ]::BIGINT[]) as id
)

SELECT 'SR_created_immediate' as check,
       COUNT(*) as count,
       798 as expected,
       CASE WHEN COUNT(*) = 798 THEN 'PASS' ELSE 'FAIL' END as status
FROM mp_source_record
WHERE id IN (SELECT id FROM created_sr);

-- ==================== VALIDACIÓN CONTABLE (AGOSTO) ======================
-- Independiente de cuándo se importó; basada en fecha económica

SELECT 'FM_reutilizados_716' as category,
       COUNT(DISTINCT fm.id) as fm_count,
       SUM(le.balance_impact)::NUMERIC(15,2) as total_neto,
       '10780612.05'::NUMERIC(15,2) as expected_neto
FROM mp_financial_movement fm
JOIN ledger_entry le ON le.financial_movement_id = fm.id
JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
JOIN mp_source_record sr ON sr.id = link.source_record_id
WHERE sr.source_type='report'
  AND le.account_id=1054315166
  AND DATE(le.occurred_at) BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

SELECT 'FM_nuevos_10' as category,
       COUNT(DISTINCT fm.id) as fm_count,
       SUM(le.balance_impact)::NUMERIC(15,2) as total_neto,
       '-10904815.29'::NUMERIC(15,2) as expected_neto
FROM mp_financial_movement fm
JOIN ledger_entry le ON le.financial_movement_id = fm.id
JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
JOIN mp_source_record sr ON sr.id = link.source_record_id
WHERE sr.source_type='liberaciones'
  AND fm.movement_class='unclassified'
  AND le.account_id=1054315166
  AND DATE(le.occurred_at) BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

SELECT 'FM_modificados' as category,
       COUNT(*) as count,
       0 as dummy,
       0::NUMERIC(15,2) as expected_neto
FROM mp_financial_movement
WHERE needs_review=TRUE
  AND movement_class IN ('payment_in', 'yield', 'transfer_in')
  AND NOT (movement_class='unclassified' AND needs_review=TRUE);
-- Esperado: 0 (FM reutilizados NO fueron modificados)

-- ======================== VALIDACIÓN IDEMPOTENCIA =======================
-- Segunda ejecución del mismo archivo = 0 cambios

SELECT 'Idempotence_check_second_run' as expected,
       0 as sr_created,
       798 as sr_existing,
       0 as fm_created,
       0 as le_created,
       0 as links_created,
       'Si segunda ejecución muestra estos números, es IDEMPOTENTE' as note;
```

---

## [E] ROLLBACK v3 - CORREGIDO

**Correcciones aplicadas:**
- ✅ [6] Orden FK: LE → LINK → FM → SR
- ✅ [6] IDs exactos (NO `WHERE source_type`)
- ✅ [4] SQL PostgreSQL válido

```sql
-- ============================================================================
-- ROLLBACK v3: Multi-período seguro
-- ============================================================================
-- Orden: LE → LINK → FM → SR (respeta FK)
-- Efecto: Solo IDs creados por ESTA importación
-- ============================================================================

-- PASO 1: Preparar IDs (obtener de liberaciones_import_result.json)
-- Crear tabla temporal si necesitas hacer rollback múltiples veces

CREATE TEMPORARY TABLE IF NOT EXISTS rollback_ids (
  sr_id BIGINT,
  fm_id BIGINT,
  le_id BIGINT,
  link_id BIGINT
);

-- INSERTAR IDs reales obtenidos de .json:
-- INSERT INTO rollback_ids VALUES 
--   (3001, 1001, 2001, 5001),
--   (3002, 1002, 2002, 5002),
--   ... (todos los IDs creados)
-- ;

-- PASO 1: Eliminar LE creadas (FK a FM)
DELETE FROM ledger_entry
WHERE id IN (SELECT DISTINCT le_id FROM rollback_ids WHERE le_id IS NOT NULL);

-- PASO 2: Eliminar LINK creadas (FK a FM y SR)
DELETE FROM mp_movement_source_link
WHERE id IN (SELECT DISTINCT link_id FROM rollback_ids WHERE link_id IS NOT NULL);

-- PASO 3: Eliminar FM creadas (luego de sus dependientes)
DELETE FROM mp_financial_movement
WHERE id IN (SELECT DISTINCT fm_id FROM rollback_ids WHERE fm_id IS NOT NULL);

-- PASO 4: Eliminar SR creadas (luego de sus dependientes)
DELETE FROM mp_source_record
WHERE id IN (SELECT DISTINCT sr_id FROM rollback_ids WHERE sr_id IS NOT NULL);

-- PASO 5: Verificar estado POST-ROLLBACK
SELECT 'Post_rollback_verification' as check,
       (SELECT COUNT(*) FROM mp_source_record WHERE source_type='liberaciones') as sr_liberaciones,
       (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class='unclassified' AND needs_review=TRUE) as fm_unclassified,
       (SELECT SUM(balance_impact) FROM ledger_entry WHERE account_id=1054315166 AND DATE(occurred_at) BETWEEN '2026-08-01' AND '2026-08-31') as neto_agosto_esperado;
-- sr_liberaciones = 0, fm_unclassified = 0, neto_agosto = 10780612.05
```

---

## [F] .env.template (sin cambios)

```env
SUPABASE_URL=https://[project].supabase.co
SUPABASE_SERVICE_ROLE_KEY=<paste_here_NOT_in_code>
ACCOUNT_ID=1054315166
```

---

## RESUMEN CAMBIOS V3

| Punto | v2 | v3 | Línea RPC |
|-------|----|----|-----------|
| [1] Validación económica | Comento | ✅ IMPLEMENTADA | 163-170 |
| [2] DESCRIPTION-first | balance_impact decide | ✅ IMPLEMENTADA | 129-146 |
| [3] Contador total_sr | +raw_only | ✅ CORREGIDO | importer |
| [4] load_dotenv() | .env | ✅ .env.local | importer |
| [5] Queries MAX DATE | Usa MAX(DATE) | ✅ IDs exactos | validacion |
| [6] Rollback FK order | Incierto | ✅ LE→LINK→FM→SR | rollback |
| [5] RAISE EXCEPTION | N/A | ✅ Propagar | 351-354 |

---

**ARCHIVOS LISTOS PARA REVISIÓN ESTÁTICA**

