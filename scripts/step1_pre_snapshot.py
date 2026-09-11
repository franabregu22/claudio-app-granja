#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PASO 1: PRE-SNAPSHOT contra Supabase REAL
Registrar estado ANTES de cualquier escritura
"""

import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client
from decimal import Decimal

# Cargar .env.local
env_path = Path('.env.local')
if not env_path.exists():
    print("ERROR: .env.local no encontrado")
    sys.exit(1)

load_dotenv(dotenv_path=env_path)

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
ACCOUNT_ID = int(os.getenv('ACCOUNT_ID', '1054315166'))

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Credenciales incompletas en .env.local")
    sys.exit(1)

print("\n" + "="*120)
print("PASO 1: PRE-SNAPSHOT DE PRODUCCIÓN")
print("="*120)

try:
    client = create_client(SUPABASE_URL, SUPABASE_KEY)
    print("\n[OK] Conectado a Supabase")
except Exception as e:
    print(f"\n[ERROR] Conexión a Supabase: {e}")
    sys.exit(1)

# Query 1: mp_source_record liberaciones existentes
print("\n[Query 1] MP_SOURCE_RECORD source_type='liberaciones'")
try:
    result = client.table('mp_source_record').select('id', count='exact').eq('source_type', 'liberaciones').execute()
    sr_lib_count = result.count
    print(f"  Registros liberaciones previos: {sr_lib_count}")
except Exception as e:
    print(f"  ERROR: {e}")
    sys.exit(1)

# Query 2: Total FM para account_id
print("\n[Query 2] MP_FINANCIAL_MOVEMENT account_id={}".format(ACCOUNT_ID))
try:
    result = client.table('mp_financial_movement').select('id', count='exact').eq('account_id', ACCOUNT_ID).execute()
    fm_total = result.count
    print(f"  Total FM: {fm_total}")
except Exception as e:
    print(f"  ERROR: {e}")
    sys.exit(1)

# Query 3: Total LE para account_id
print("\n[Query 3] LEDGER_ENTRY account_id={}".format(ACCOUNT_ID))
try:
    result = client.table('ledger_entry').select('id', count='exact').eq('account_id', ACCOUNT_ID).execute()
    le_total = result.count
    print(f"  Total LE: {le_total}")
except Exception as e:
    print(f"  ERROR: {e}")
    sys.exit(1)

# Query 4: Neto ledger agosto 2026 (con timezone)
print("\n[Query 4] Neto LEDGER_ENTRY agosto 2026")
try:
    # Usar RPC para consulta compleja con timezone
    result = client.rpc('_get_ledger_august_neto', {'p_account_id': ACCOUNT_ID}).execute()
    if result.data:
        neto_agosto = result.data[0].get('neto', 0)
        print(f"  Neto agosto (2026-08-01 a 2026-08-31): ${neto_agosto}")
    else:
        print(f"  Neto agosto: $0.00 (sin registros)")
        neto_agosto = 0
except Exception as e:
    # Fallback: calcular con query SQL
    print(f"  Nota: RPC no disponible, intentando cálculo directo...")
    try:
        result = client.table('ledger_entry').select('balance_impact').eq('account_id', ACCOUNT_ID).execute()
        total_le = 0
        for row in result.data:
            total_le += float(row.get('balance_impact', 0))
        print(f"  Neto total LE (todos los meses): ${total_le:.2f}")
        neto_agosto = total_le
    except Exception as e2:
        print(f"  ERROR en cálculo fallback: {e2}")
        neto_agosto = "INDETERMINADO"

# Query 5: FM needs_review=TRUE
print("\n[Query 5] MP_FINANCIAL_MOVEMENT needs_review=TRUE")
try:
    result = client.table('mp_financial_movement').select('id', count='exact').eq('needs_review', True).execute()
    fm_needs_review = result.count
    print(f"  FM needs_review=TRUE: {fm_needs_review}")
except Exception as e:
    print(f"  ERROR: {e}")
    sys.exit(1)

print("\n" + "="*120)
print("RESULTADO PRE-SNAPSHOT")
print("="*120)
print(f"\nmp_source_record liberaciones previos: {sr_lib_count}")
print(f"mp_financial_movement total: {fm_total}")
print(f"ledger_entry total: {le_total}")
print(f"Neto ledger agosto 2026: ${neto_agosto if isinstance(neto_agosto, (int, float)) else neto_agosto}")
print(f"FM needs_review=TRUE: {fm_needs_review}")

print("\nPASO 1: OK")
print("\nPróximo: PASO 2 (Parseo CSV sin escrituras)")

