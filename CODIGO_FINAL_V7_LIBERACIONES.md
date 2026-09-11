# CÓDIGO FINAL v7: Integración Liberaciones3.csv
## Versionado SAME-SOURCE + RAW-only determinístico + Multi-período

**Estado**: CÓDIGO FINAL V7, BLOQUEADORES CRÍTICOS CORREGIDOS  
**Fecha**: 2026-09-05  
**Cambios**: v6 + 3 bloqueadores = Arquitectura definitiva

---

## [EXTRA] FUNCIÓN AUXILIAR: calc_liberaciones_economic_hash()

**Propósito**: Comparar SOLO versiones de Liberaciones (same-source), sin depender de FM.economic_hash

```sql
-- ============================================================================
-- Función auxiliar: calc_liberaciones_economic_hash()
-- ============================================================================
-- Calcula hash económico específico de Liberaciones (same-source comparison)
-- NO usa fm.economic_hash (que pertenece al contexto original del FM)
-- ============================================================================

CREATE OR REPLACE FUNCTION calc_liberaciones_economic_hash(
  p_description VARCHAR,
  p_gross_amount NUMERIC,
  p_net_credit_amount NUMERIC,
  p_net_debit_amount NUMERIC,
  p_taxes_amount NUMERIC,
  p_transaction_date TIMESTAMP WITH TIME ZONE,
  p_payment_method VARCHAR,
  p_payment_method_type VARCHAR
)
RETURNS VARCHAR(64) AS $$
DECLARE
  v_hash_input TEXT;
BEGIN
  -- Concatenar SOLO campos económicos disponibles en Liberaciones
  v_hash_input :=
    COALESCE(p_description, '') ||
    COALESCE(p_gross_amount::TEXT, '') ||
    COALESCE(p_net_credit_amount::TEXT, '') ||
    COALESCE(p_net_debit_amount::TEXT, '') ||
    COALESCE(p_taxes_amount::TEXT, '') ||
    COALESCE(p_transaction_date::TEXT, '') ||
    COALESCE(p_payment_method, '') ||
    COALESCE(p_payment_method_type, '');
  
  RETURN encode(digest(v_hash_input, 'sha256'), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION calc_liberaciones_economic_hash(...) IS
  'Hash económico específico de Liberaciones (same-source).
   NO compara contra FM.economic_hash (contexto origen diferente).
   Usado para detectar cambios metadata-only vs económicos en nuevas versiones de Liberaciones.';
```

---

## [B] RPC: import_liberaciones_primary() v7 - DEFINITIVA

**Correcciones v7 implementadas:**
- ✅ [BLOQUEADOR 1] Comparación same-source: usar calc_liberaciones_economic_hash() en lugar de fm.economic_hash
- ✅ [BLOQUEADOR 1] NO modificar economic_hash del FM
- ✅ [BLOQUEADOR 2] Filas sin SOURCE_ID/DESCRIPTION: generar determinístico, preservar como RAW-only
- ✅ Comparación cross-source (report ↔ liberaciones): sigue siendo por balance_impact == settlement_amount

```sql
-- ============================================================================
-- RPC: import_liberaciones_primary() v7 FINAL
-- ============================================================================
-- BLOQUEADOR 1: calc_liberaciones_economic_hash() para same-source (PASO 4)
-- BLOQUEADOR 2: Filas sin SOURCE_ID/DESCRIPTION toleradas como RAW-only
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
  v_existing_fm_id_from_lib BIGINT;
  v_existing_settlement_from_lib DECIMAL(15,2);
  v_existing_lib_hash VARCHAR(64);
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
  
  v_new_lib_hash VARCHAR(64);
  v_is_economic_change BOOLEAN;
  
  v_gross_amount DECIMAL(15,2);
  v_net_credit DECIMAL(15,2);
  v_net_debit DECIMAL(15,2);
  
BEGIN
  v_records := ARRAY(SELECT jsonb_array_elements(p_input));
  
  FOREACH v_record IN ARRAY v_records
  LOOP
    v_idx := v_idx + 1;
    
    -- [BLOQUEADOR 2] Campos opcionales
    v_source_external_id := v_record->>'source_external_id';
    v_description := v_record->>'description';
    v_payload_hash := v_record->>'payload_hash';
    
    -- Si falta SOURCE_ID y/o DESCRIPTION: generar determinístico y RAW-only
    IF v_source_external_id IS NULL OR v_description IS NULL THEN
      
      IF v_payload_hash IS NULL THEN
        RAISE EXCEPTION '[Fila %] payload_hash requerido (incluso sin SOURCE_ID/DESCRIPTION)', v_idx;
      END IF;
      
      -- Generar source_external_id determinístico: liberaciones_raw:<payload_hash>
      v_source_external_id := 'liberaciones_raw:' || v_payload_hash;
      
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
      ELSE
        v_sr_created := v_sr_created + 1;
        v_created_sr_ids := array_append(v_created_sr_ids, v_source_record_id);
      END IF;
      
      v_sr_raw_only := v_sr_raw_only + 1;
      CONTINUE;  -- RAW-only, no procesar más
    END IF;
    
    -- ================================================================
    -- PASO 1: Crear/recuperar mp_source_record (con SOURCE_ID + DESCRIPTION)
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
    -- PASO 3: Idempotencia A - SR exacto ya tiene link
    -- ================================================================
    
    SELECT link.id, fm.id
    INTO v_existing_link_id, v_financial_movement_id
    FROM mp_movement_source_link link
    JOIN mp_financial_movement fm ON fm.id = link.financial_movement_id
    WHERE link.source_record_id = v_source_record_id
      AND fm.account_id = p_account_id
    LIMIT 1;
    
    IF v_existing_link_id IS NOT NULL THEN
      CONTINUE;
    END IF;
    
    -- ================================================================
    -- PASO 4: BLOQUEADOR 1 - Versionado RAW SAME-SOURCE
    -- Comparar usando calc_liberaciones_economic_hash() (NO fm.economic_hash)
    -- ================================================================
    
    v_gross_amount := (v_record->>'gross_amount')::DECIMAL(15,2);
    v_net_credit := (v_record->>'net_credit')::DECIMAL(15,2);
    v_net_debit := (v_record->>'net_debit')::DECIMAL(15,2);
    v_tax_amount := (v_record->>'tax_amount')::DECIMAL(15,2);
    v_payment_date := (v_record->>'transaction_date')::TIMESTAMP WITH TIME ZONE;
    v_payment_method := v_record->>'payment_method';
    v_payment_detail := v_record->>'payment_method_type';
    
    -- Hash económico ESPECÍFICO DE LIBERACIONES
    v_new_lib_hash := calc_liberaciones_economic_hash(
      v_description,
      v_gross_amount,
      v_net_credit,
      v_net_debit,
      v_tax_amount,
      v_payment_date,
      v_payment_method,
      v_payment_detail
    );
    
    -- Buscar versión previa de liberaciones (same-source)
    SELECT fm.id, fm.settlement_amount,
           sr_lib.raw_data->>'description' as prev_description,
           sr_lib.raw_data->>'gross_amount' as prev_gross,
           sr_lib.raw_data->>'net_credit_amount' as prev_net_credit,
           sr_lib.raw_data->>'net_debit_amount' as prev_net_debit,
           sr_lib.raw_data->>'taxes_amount' as prev_taxes,
           sr_lib.raw_data->>'date' as prev_date,
           sr_lib.raw_data->>'payment_method' as prev_payment_method,
           sr_lib.raw_data->>'payment_method_type' as prev_payment_type
    INTO v_existing_fm_id_from_lib, v_existing_settlement_from_lib,
         v_description, v_gross_amount, v_net_credit, v_net_debit, v_tax_amount, v_payment_date,
         v_payment_method, v_payment_detail
    FROM mp_financial_movement fm
    INNER JOIN mp_movement_source_link link 
      ON fm.id = link.financial_movement_id
    INNER JOIN mp_source_record sr_lib 
      ON sr_lib.id = link.source_record_id
    WHERE sr_lib.source_type='liberaciones'
      AND sr_lib.source_external_id=v_source_external_id
      AND fm.account_id = p_account_id
      AND link.source_record_id != v_source_record_id
    LIMIT 1;
    
    IF v_existing_fm_id_from_lib IS NOT NULL THEN
      -- Existe versión previa: comparar económico
      v_existing_lib_hash := calc_liberaciones_economic_hash(
        v_description,
        v_gross_amount::DECIMAL(15,2),
        v_net_credit::DECIMAL(15,2),
        v_net_debit::DECIMAL(15,2),
        v_tax_amount::DECIMAL(15,2),
        v_payment_date::TIMESTAMP WITH TIME ZONE,
        v_payment_method,
        v_payment_detail
      );
      
      v_is_economic_change := (v_new_lib_hash != v_existing_lib_hash);
      
      IF v_is_economic_change THEN
        -- Cambio económico: marcar needs_review
        UPDATE mp_financial_movement
        SET needs_review = TRUE
        WHERE id = v_existing_fm_id_from_lib;
      END IF;
      
      v_financial_movement_id := v_existing_fm_id_from_lib;
      
      -- Crear LINK al FM existente
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
      
      CONTINUE;
    END IF;
    
    -- ================================================================
    -- PASO 5: Buscar correlación en REPORT (cross-source, balance_impact)
    -- ================================================================
    
    v_balance_impact := v_net_credit - v_net_debit;
    
    SELECT fm.id, fm.settlement_amount
    INTO v_existing_fm_id, v_existing_settlement_from_lib
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
    -- PASO 7: Decidir: Reutilizar vs Crear FM (cross-source)
    -- ================================================================
    
    IF v_existing_fm_id IS NOT NULL THEN
      -- CORRELACIONADO CON REPORT
      IF v_balance_impact::NUMERIC(15,2) != v_existing_settlement_from_lib::NUMERIC(15,2) THEN
        RAISE EXCEPTION '[Fila %] Monto discrepante: SOURCE_ID=%, balance_impact=% vs FM=%', 
          v_idx, v_source_external_id, v_balance_impact, v_existing_settlement_from_lib;
      END IF;
      v_financial_movement_id := v_existing_fm_id;
      
    ELSE
      -- NO CORRELACIONADO
      IF v_description IN ('payment', 'asset_management') THEN
        RAISE EXCEPTION '[Fila %] Correlación fallida: SOURCE_ID=% es % pero no existe en report',
          v_idx, v_source_external_id, v_description;
      END IF;
      
      IF v_description = 'payout' THEN
        v_transaction_amount := v_gross_amount;
        v_settlement_amount := v_balance_impact;
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
    -- PASO 8: Crear LINK
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
```

---

## [C] IMPORTER: import_liberaciones.py v7 - MULTI-PERÍODO

**Correcciones v7:**
- ✅ [BLOQUEADOR 3] Acepta archivo/período por argumento (no hardcodea agosto)
- ✅ Procesa todas las filas válidas sin filtro de fecha
- ✅ Tolera columnas adicionales futuras
- ✅ Preserva raw_data completo

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Importer: Liberaciones.csv -> Supabase v7 (multi-período)
Acepta archivo por argumento, procesa todas las filas válidas.
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
from supabase import create_client

# ============================================================================
# CONFIG
# ============================================================================

env_path = Path('.env.local')
if not env_path.exists():
    print("ERROR: .env.local no encontrado")
    sys.exit(1)

load_dotenv(dotenv_path=env_path)

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
ACCOUNT_ID = int(os.getenv('ACCOUNT_ID', '1054315166'))
BATCH_SIZE = 100

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Credenciales no configuradas")
    sys.exit(1)

# ============================================================================
# FUNCIONES
# ============================================================================

def normalize_row(csv_row):
    """Normalizar fila CSV a JSONB (multi-período, tolera columnas faltantes)"""
    
    # Campos opcionales con defaults
    cr = Decimal(str(csv_row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
    db = Decimal(str(csv_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
    gross = Decimal(str(csv_row.get('GROSS_AMOUNT', '0')).replace(',', '.'))
    tax = Decimal(str(csv_row.get('TAXES_AMOUNT', '0')).replace(',', '.'))
    
    raw_data = {key: str(value) for key, value in csv_row.items()}
    raw_json = json.dumps(raw_data, sort_keys=True)
    payload_hash = hashlib.sha256(raw_json.encode()).hexdigest()
    
    return {
        'source_external_id': csv_row.get('SOURCE_ID'),  # Puede ser None
        'description': csv_row.get('DESCRIPTION'),  # Puede ser None
        'transaction_date': csv_row.get('DATE'),
        'net_credit': str(cr),
        'net_debit': str(db),
        'gross_amount': str(gross),
        'tax_amount': str(tax),
        'payment_method': csv_row.get('PAYMENT_METHOD', ''),
        'payment_method_type': csv_row.get('PAYMENT_METHOD_TYPE', ''),
        'payload_hash': payload_hash,
        'raw_data': raw_data  # Preservar TODO
    }

def read_csv(path: Path):
    """Leer CSV de Liberaciones (multi-período, tolera columnas adicionales)"""
    records = []
    with open(path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        for row in reader:
            if row:  # Saltar filas vacías
                records.append(row)
    return records

def import_batch(client, batch_records):
    """Ejecutar RPC para un lote"""
    normalized = [normalize_row(r) for r in batch_records]
    try:
        result = client.rpc(
            'import_liberaciones_primary',
            {'p_account_id': ACCOUNT_ID, 'p_input': normalized}
        ).execute()
        if not result.data.get('success', False):
            raise Exception(f"RPC error: {result.data}")
        return result.data
    except Exception as e:
        raise

def main():
    """Flujo principal"""
    
    if len(sys.argv) < 2:
        print("Uso: python scripts/import_liberaciones.py <CSV_PATH>")
        print("Ejemplo: python scripts/import_liberaciones.py data/mercadopago/Liberaciones3.csv")
        sys.exit(1)
    
    csv_path = Path(sys.argv[1])
    
    if not csv_path.exists():
        print(f"ERROR: Archivo no encontrado: {csv_path}")
        sys.exit(1)
    
    print("\n" + "="*120)
    print(f"IMPORTER: {csv_path.name} -> Supabase v7 (multi-período)")
    print("="*120)
    
    try:
        client = create_client(SUPABASE_URL, SUPABASE_KEY)
        print(f"\n[1] Conectado. Account ID: {ACCOUNT_ID}")
    except Exception as e:
        print(f"ERROR de conexión: {e}")
        sys.exit(1)
    
    print(f"\n[2] Leyendo {csv_path.name}...")
    try:
        records = read_csv(csv_path)
        print(f"    Registros: {len(records)}")
    except Exception as e:
        print(f"    ERROR: {e}")
        sys.exit(1)
    
    if not records:
        print("    ERROR: Archivo vacío")
        sys.exit(1)
    
    print(f"\n[3] Procesando {len(records)} registros...")
    
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
        
        print(f"    Batch {batch_num}/{total_batches} ({len(batch)} registros)...")
        
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
            print(f"      FM/LE: {summary.get('financial_movements_created', 0)} nuevos")
            print(f"      LINK: {summary.get('movement_source_links_created', 0)} nuevos")
        
        except Exception as e:
            print(f"      ERROR: {e}")
            sys.exit(1)
    
    # Resumen final
    print(f"\n" + "="*120)
    print("RESUMEN IMPORTACIÓN")
    print("="*120)
    
    total_sr = total_sr_created + total_sr_existing
    
    print(f"\nSource Records:")
    print(f"  Creados: {total_sr_created}")
    print(f"  Existentes: {total_sr_existing}")
    print(f"  Raw-only (sin SOURCE_ID o DESCRIPTION): {total_sr_raw_only}")
    print(f"  TOTAL SR: {total_sr}")
    
    print(f"\nFinancial Movements:")
    print(f"  Creados: {total_fm_created}")
    
    print(f"\nMovement Source Links:")
    print(f"  Creados: {total_links}")
    
    print(f"\n" + "="*120 + "\n")
    
    # Guardar resultado
    with open('liberaciones_import_result.json', 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'file': str(csv_path),
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
    
    print("Resultado: liberaciones_import_result.json")

if __name__ == '__main__':
    main()
```

**Uso v7**:
```bash
# Agosto 2026
python scripts/import_liberaciones.py data/mercadopago/Liberaciones3.csv

# Enero 2026 (archivo diferente)
python scripts/import_liberaciones.py data/mercadopago/Liberaciones_enero.csv

# Archivo único histórico completo
python scripts/import_liberaciones.py data/mercadopago/Liberaciones_2026_completo.csv
```

