# CÓDIGO FINAL v8: Integración Liberaciones3.csv
## Bloqueadores críticos corregidos + Variables limpias + Hash inequívoco

**Estado**: CÓDIGO FINAL V8, BLOQUEADORES CRÍTICOS RESUELTOS  
**Fecha**: 2026-09-05  
**Cambios**: v7 + 9 bloqueadores = Código compilable y seguro

---

## [EXTRA] FUNCIÓN AUXILIAR V8: calc_liberaciones_economic_hash()

**Corrección 7 + 8**: COMMENT válido + hash inequívoco con jsonb_build_array()

```sql
-- ============================================================================
-- Función auxiliar: calc_liberaciones_economic_hash()
-- ============================================================================
-- Calcula hash económico INEQUÍVOCO de Liberaciones (same-source)
-- Usa jsonb_build_array para evitar colisiones por concatenación
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
  v_canonical_input TEXT;
BEGIN
  -- CORRECCIÓN 8: Usar jsonb_build_array para evitar ambigüedad en concatenación
  v_canonical_input := jsonb_build_array(
    p_description,
    p_gross_amount,
    p_net_credit_amount,
    p_net_debit_amount,
    p_taxes_amount,
    p_transaction_date,
    p_payment_method,
    p_payment_method_type
  )::TEXT;
  
  RETURN encode(digest(v_canonical_input, 'sha256'), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- CORRECCIÓN 7: COMMENT ON FUNCTION con firma EXACTA
COMMENT ON FUNCTION calc_liberaciones_economic_hash(
  VARCHAR,
  NUMERIC,
  NUMERIC,
  NUMERIC,
  NUMERIC,
  TIMESTAMP WITH TIME ZONE,
  VARCHAR,
  VARCHAR
) IS
  'Hash económico inequívoco de Liberaciones (same-source).
   Usa jsonb_build_array para evitar colisiones en concatenación.
   NO depende de fm.economic_hash (contexto origen diferente).';
```

---

## [B] RPC: import_liberaciones_primary() v8 - FINAL CORREGIDA

**Correcciones v8 implementadas:**
- ✅ [BLOQUEADOR 1] Variables SEPARADAS: v_current_* y v_prev_*
- ✅ [BLOQUEADOR 2] raw_data keys REALES (MAYÚSCULAS): DESCRIPTION, GROSS_AMOUNT, etc.
- ✅ [BLOQUEADOR 3] Versión previa determinística: ORDER BY observed_at DESC, id DESC
- ✅ [BLOQUEADOR 4] TRIM + NULLIF para campos STRING
- ✅ [BLOQUEADOR 6] Validación cross-source: FM.settlement == LE.balance_impact
- ✅ [BLOQUEADOR 9] Escenario F: payment correlacionado + cambio económico = LINK + needs_review (NO ERROR)

```sql
-- ============================================================================
-- RPC: import_liberaciones_primary() v8 FINAL
-- ============================================================================
-- BLOQUEADOR 1: Variables separadas (current vs previous)
-- BLOQUEADOR 2: raw_data keys REALES del CSV
-- BLOQUEADOR 3: Versión previa determinística
-- BLOQUEADOR 6: Validación cross-source FM + LE
-- BLOQUEADOR 9: Escenario F correcto (payment changes = needs_review, no error)
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
  v_existing_fm_id_from_report BIGINT;
  v_existing_le_id_from_report BIGINT;
  v_existing_settlement_from_report DECIMAL(15,2);
  v_existing_le_balance_impact DECIMAL(15,2);
  v_ledger_entry_id BIGINT;
  
  v_payload_hash VARCHAR(64);
  v_source_external_id VARCHAR(100);
  v_description VARCHAR(50);
  
  -- BLOQUEADOR 1: Variables ACTUALES (de la fila actual)
  v_current_description VARCHAR(50);
  v_current_gross_amount DECIMAL(15,2);
  v_current_net_credit DECIMAL(15,2);
  v_current_net_debit DECIMAL(15,2);
  v_current_tax_amount DECIMAL(15,2);
  v_current_transaction_date TIMESTAMP WITH TIME ZONE;
  v_current_payment_method VARCHAR(30);
  v_current_payment_method_type VARCHAR(50);
  v_current_balance_impact DECIMAL(15,2);
  
  -- BLOQUEADOR 1: Variables PREVIAS (de versión anterior de Liberaciones)
  v_prev_description VARCHAR(50);
  v_prev_gross_amount DECIMAL(15,2);
  v_prev_net_credit DECIMAL(15,2);
  v_prev_net_debit DECIMAL(15,2);
  v_prev_tax_amount DECIMAL(15,2);
  v_prev_transaction_date TIMESTAMP WITH TIME ZONE;
  v_prev_payment_method VARCHAR(30);
  v_prev_payment_method_type VARCHAR(50);
  v_prev_raw_data JSONB;
  
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
  
  v_new_lib_hash VARCHAR(64);
  v_prev_lib_hash VARCHAR(64);
  v_is_economic_change BOOLEAN;
  
  v_transaction_amount DECIMAL(15,2);
  v_settlement_amount DECIMAL(15,2);
  v_tax_detail JSONB;
  
BEGIN
  v_records := ARRAY(SELECT jsonb_array_elements(p_input));
  
  FOREACH v_record IN ARRAY v_records
  LOOP
    v_idx := v_idx + 1;
    
    -- [BLOQUEADOR 4] NORMALIZAR: TRIM + NULLIF para NULL/''
    v_source_external_id := NULLIF(BTRIM(v_record->>'source_external_id'), '');
    v_description := NULLIF(BTRIM(v_record->>'description'), '');
    v_payload_hash := NULLIF(BTRIM(v_record->>'payload_hash'), '');
    
    -- Si falta SOURCE_ID y/o DESCRIPTION: RAW-only determinístico
    IF v_source_external_id IS NULL OR v_description IS NULL THEN
      
      IF v_payload_hash IS NULL THEN
        RAISE EXCEPTION '[Fila %] payload_hash requerido (incluso sin SOURCE_ID/DESCRIPTION)', v_idx;
      END IF;
      
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
      CONTINUE;
    END IF;
    
    -- ================================================================
    -- PASO 1: Crear/recuperar SR
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
    -- BLOQUEADOR 1: Extraer datos ACTUALES de la fila (ANTES de leer previa)
    -- ================================================================
    
    -- BLOQUEADOR 2: Usar EXACTAMENTE las keys del CSV (MAYÚSCULAS)
    v_current_description := v_description;
    v_current_gross_amount := (COALESCE(v_record->>'GROSS_AMOUNT', '0'))::DECIMAL(15,2);
    v_current_net_credit := (COALESCE(v_record->>'NET_CREDIT_AMOUNT', '0'))::DECIMAL(15,2);
    v_current_net_debit := (COALESCE(v_record->>'NET_DEBIT_AMOUNT', '0'))::DECIMAL(15,2);
    v_current_tax_amount := (COALESCE(v_record->>'TAXES_AMOUNT', '0'))::DECIMAL(15,2);
    v_current_transaction_date := (v_record->>'DATE')::TIMESTAMP WITH TIME ZONE;
    v_current_payment_method := COALESCE(v_record->>'PAYMENT_METHOD', '');
    v_current_payment_method_type := COALESCE(v_record->>'PAYMENT_METHOD_TYPE', '');
    v_current_balance_impact := v_current_net_credit - v_current_net_debit;
    
    -- ================================================================
    -- PASO 3: Idempotencia A
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
    -- PASO 4: BLOQUEADOR 3 - Versionado SAME-SOURCE determinístico
    -- BLOQUEADOR 1: Variables SEPARADAS v_prev_*
    -- ================================================================
    
    -- Calcular hash ACTUAL
    v_new_lib_hash := calc_liberaciones_economic_hash(
      v_current_description,
      v_current_gross_amount,
      v_current_net_credit,
      v_current_net_debit,
      v_current_tax_amount,
      v_current_transaction_date,
      v_current_payment_method,
      v_current_payment_method_type
    );
    
    -- BLOQUEADOR 3: Orden determinístico (más reciente primero)
    SELECT fm.id,
           sr_lib.raw_data,
           sr_lib.raw_data->>'DESCRIPTION' as prev_desc,
           sr_lib.raw_data->>'GROSS_AMOUNT' as prev_gross,
           sr_lib.raw_data->>'NET_CREDIT_AMOUNT' as prev_net_credit,
           sr_lib.raw_data->>'NET_DEBIT_AMOUNT' as prev_net_debit,
           sr_lib.raw_data->>'TAXES_AMOUNT' as prev_taxes,
           sr_lib.raw_data->>'DATE' as prev_date,
           sr_lib.raw_data->>'PAYMENT_METHOD' as prev_payment_method,
           sr_lib.raw_data->>'PAYMENT_METHOD_TYPE' as prev_payment_type
    INTO v_existing_fm_id_from_lib,
         v_prev_raw_data,
         v_prev_description,
         v_prev_gross_amount,
         v_prev_net_credit,
         v_prev_net_debit,
         v_prev_tax_amount,
         v_prev_transaction_date,
         v_prev_payment_method,
         v_prev_payment_method_type
    FROM mp_financial_movement fm
    INNER JOIN mp_movement_source_link link 
      ON fm.id = link.financial_movement_id
    INNER JOIN mp_source_record sr_lib 
      ON sr_lib.id = link.source_record_id
    WHERE sr_lib.source_type='liberaciones'
      AND sr_lib.source_external_id=v_source_external_id
      AND fm.account_id = p_account_id
      AND link.source_record_id != v_source_record_id
    ORDER BY sr_lib.observed_at DESC, sr_lib.id DESC
    LIMIT 1;
    
    IF v_existing_fm_id_from_lib IS NOT NULL THEN
      -- Existe versión previa de Liberaciones
      -- Comparar usando variables v_prev_* (NO sobrescribe datos actuales)
      
      v_prev_lib_hash := calc_liberaciones_economic_hash(
        v_prev_description,
        v_prev_gross_amount::DECIMAL(15,2),
        v_prev_net_credit::DECIMAL(15,2),
        v_prev_net_debit::DECIMAL(15,2),
        v_prev_tax_amount::DECIMAL(15,2),
        v_prev_transaction_date::TIMESTAMP WITH TIME ZONE,
        v_prev_payment_method,
        v_prev_payment_method_type
      );
      
      v_is_economic_change := (v_new_lib_hash != v_prev_lib_hash);
      
      IF v_is_economic_change THEN
        UPDATE mp_financial_movement
        SET needs_review = TRUE
        WHERE id = v_existing_fm_id_from_lib;
      END IF;
      
      v_financial_movement_id := v_existing_fm_id_from_lib;
      
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
    -- PASO 5: Buscar correlación REPORT (cross-source)
    -- BLOQUEADOR 6: Validar FM.settlement == LE.balance_impact
    -- ================================================================
    
    SELECT fm.id, fm.settlement_amount, le.id, le.balance_impact
    INTO v_existing_fm_id_from_report, v_existing_settlement_from_report, 
         v_existing_le_id_from_report, v_existing_le_balance_impact
    FROM mp_financial_movement fm
    INNER JOIN mp_movement_source_link link 
      ON fm.id = link.financial_movement_id
    INNER JOIN mp_source_record sr_report 
      ON sr_report.id = link.source_record_id
    LEFT JOIN ledger_entry le 
      ON le.financial_movement_id = fm.id 
      AND le.account_id = p_account_id
    WHERE sr_report.source_type='report'
      AND sr_report.source_external_id=v_source_external_id
      AND fm.account_id = p_account_id
    LIMIT 1;
    
    -- ================================================================
    -- PASO 6: Determinar movement_class
    -- ================================================================
    
    CASE v_current_description
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
    
    IF v_existing_fm_id_from_report IS NOT NULL THEN
      -- CORRELACIONADO CON REPORT
      -- BLOQUEADOR 6: Validar TANTO FM como LE
      
      IF v_current_balance_impact::NUMERIC(15,2) != v_existing_settlement_from_report::NUMERIC(15,2) THEN
        RAISE EXCEPTION '[Fila %] Discrepancia FM: balance_impact=%vs settlement=%',
          v_idx, v_current_balance_impact, v_existing_settlement_from_report;
      END IF;
      
      IF v_existing_le_id_from_report IS NOT NULL THEN
        IF v_current_balance_impact::NUMERIC(15,2) != v_existing_le_balance_impact::NUMERIC(15,2) THEN
          RAISE EXCEPTION '[Fila %] Discrepancia LE: balance_impact=%vs le_balance=%',
            v_idx, v_current_balance_impact, v_existing_le_balance_impact;
        END IF;
      END IF;
      
      v_financial_movement_id := v_existing_fm_id_from_report;
      
    ELSE
      -- NO CORRELACIONADO
      -- BLOQUEADOR 9: Escenario F correcto
      -- Si payment/asset_management sin previa ni en report ni en liberaciones → ERROR
      -- Si payment/asset_management correlacionado en report previo → usar FM (ya manejado arriba)
      -- Si payment/asset_management sin correlación → ERROR
      
      IF v_current_description IN ('payment', 'asset_management') THEN
        RAISE EXCEPTION '[Fila %] Correlación fallida: SOURCE_ID=% es % pero no existe',
          v_idx, v_source_external_id, v_current_description;
      END IF;
      
      -- payout nuevo
      IF v_current_description = 'payout' THEN
        v_transaction_amount := v_current_gross_amount;
        v_settlement_amount := v_current_balance_impact;
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
          v_current_tax_amount,
          v_current_payment_method,
          v_current_payment_method_type,
          v_tax_detail,
          NULL,
          v_current_transaction_date,
          v_current_transaction_date,
          calc_economic_hash(
            v_transaction_amount,
            v_settlement_amount,
            v_current_tax_amount,
            v_movement_class,
            v_current_transaction_date,
            v_current_transaction_date,
            v_current_payment_method,
            v_current_payment_method_type,
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
          v_current_description,
          v_current_transaction_date
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

COMMENT ON FUNCTION import_liberaciones_primary(BIGINT, JSONB) IS
  'Importa Liberaciones.csv con arquitectura definitiva.
   BLOQUEADOR 1: Variables current/previous separadas (nunca sobrescribir actuales).
   BLOQUEADOR 2: raw_data keys EXACTAS (MAYÚSCULAS): DESCRIPTION, GROSS_AMOUNT, etc.
   BLOQUEADOR 3: Versión previa determinística (ORDER BY observed_at DESC).
   BLOQUEADOR 6: Validación cross-source FM + LE (balance_impact exacto).
   BLOQUEADOR 9: Escenario F (payment cambio) = needs_review (NO error).';
```

---

## [C] IMPORTER: import_liberaciones.py v8 - VALIDACIÓN NUMÉRICA

**BLOQUEADOR 5**: Helper para campos numéricos con tolerancia a vacíos

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Importer: Liberaciones.csv -> Supabase v8
Validación numérica robusta, tolerancia a campos vacíos.
"""

import csv
import json
import hashlib
from pathlib import Path
from decimal import Decimal, InvalidOperation
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

# BLOQUEADOR 5: Helper para parsear decimales de forma robusta
def parse_decimal(value):
    """
    Parsear valor a Decimal, tolerando vacío/None
    Retorna 0 si vacío/None, else Decimal(valor)
    Lanza excepción si valor malformado
    """
    if value is None:
        return Decimal('0')
    
    value = str(value).strip()
    if value == '':
        return Decimal('0')
    
    try:
        return Decimal(value.replace(',', '.'))
    except InvalidOperation as e:
        raise ValueError(f"Valor numérico malformado: '{value}' ({e})")

def normalize_row(csv_row):
    """Normalizar fila CSV a JSONB (V8: validación numérica robusta)"""
    
    # BLOQUEADOR 5: Usar parse_decimal() para campos numéricos
    try:
        cr = parse_decimal(csv_row.get('NET_CREDIT_AMOUNT'))
        db = parse_decimal(csv_row.get('NET_DEBIT_AMOUNT'))
        gross = parse_decimal(csv_row.get('GROSS_AMOUNT'))
        tax = parse_decimal(csv_row.get('TAXES_AMOUNT'))
    except ValueError as e:
        # Propagar error: fila malformada no puede procesarse
        raise ValueError(f"Fila con ERROR numérico: {e}")
    
    # Preservar raw_data COMPLETO (con MAYÚSCULAS del CSV)
    raw_data = {key: str(value) for key, value in csv_row.items()}
    raw_json = json.dumps(raw_data, sort_keys=True)
    payload_hash = hashlib.sha256(raw_json.encode()).hexdigest()
    
    # BLOQUEADOR 2: Usar keys EXACTAS del CSV (MAYÚSCULAS)
    return {
        'source_external_id': csv_row.get('SOURCE_ID'),  # Puede ser None/''
        'description': csv_row.get('DESCRIPTION'),  # Puede ser None/''
        'transaction_date': csv_row.get('DATE'),
        'net_credit': str(cr),
        'net_debit': str(db),
        'gross_amount': str(gross),
        'tax_amount': str(tax),
        'payment_method': csv_row.get('PAYMENT_METHOD', ''),
        'payment_method_type': csv_row.get('PAYMENT_METHOD_TYPE', ''),
        'payload_hash': payload_hash,
        'raw_data': raw_data  # Preservar TODO con keys reales
    }

def read_csv(path: Path):
    """Leer CSV, preservando orden, tolerando columnas faltantes"""
    records = []
    with open(path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        for row in reader:
            if row:
                records.append(row)
    return records

def import_batch(client, batch_records):
    """Ejecutar RPC para un lote"""
    normalized = []
    for r in batch_records:
        try:
            normalized.append(normalize_row(r))
        except ValueError as e:
            print(f"    ADVERTENCIA: {e} (saltada)")
            continue
    
    if not normalized:
        return {'summary': {}}
    
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
        sys.exit(1)
    
    csv_path = Path(sys.argv[1])
    
    if not csv_path.exists():
        print(f"ERROR: {csv_path} no existe")
        sys.exit(1)
    
    print("\n" + "="*120)
    print(f"IMPORTER: {csv_path.name} -> Supabase v8 (validación robusta)")
    print("="*120)
    
    try:
        client = create_client(SUPABASE_URL, SUPABASE_KEY)
        print(f"\n[1] Conectado. Account ID: {ACCOUNT_ID}")
    except Exception as e:
        print(f"ERROR: {e}")
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
    
    # Resumen
    print(f"\n" + "="*120)
    print("RESUMEN IMPORTACIÓN")
    print("="*120)
    
    total_sr = total_sr_created + total_sr_existing
    
    print(f"\nSource Records: {total_sr}")
    print(f"  Creados: {total_sr_created}")
    print(f"  Existentes: {total_sr_existing}")
    print(f"  Raw-only: {total_sr_raw_only}")
    
    print(f"\nFinancial Movements: {total_fm_created} nuevos")
    print(f"Ledger Entries: {total_le_created} nuevas")
    print(f"Links: {total_links} nuevos")
    
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

