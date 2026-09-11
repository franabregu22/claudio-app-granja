#!/usr/bin/env python3
"""
Verificación POST-instalación de RPC productiva en Supabase
PASO 1: Instalar RPC
PASO 2-4: Validaciones READ-ONLY
"""

import sys
import os
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client

env_path = Path('.env.local')
if not env_path.exists():
    print("ERROR: .env.local no encontrado")
    sys.exit(1)

load_dotenv(dotenv_path=env_path)

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
ACCOUNT_ID = int(os.getenv('ACCOUNT_ID', '1054315166'))

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Credenciales no configuradas")
    sys.exit(1)

client = create_client(SUPABASE_URL, SUPABASE_KEY)

print("="*120)
print("PASO 1: INSTALAR RPC PRODUCTIVA")
print("="*120)

print("\nLeyendo sql/006_import_liberaciones_primary_PRODUCTION.sql...")
sql_file = Path('sql/006_import_liberaciones_primary_PRODUCTION.sql')
if not sql_file.exists():
    print(f"ERROR: {sql_file} no existe")
    sys.exit(1)

with open(sql_file, 'r', encoding='utf-8') as f:
    sql_content = f.read()

print(f"SQL size: {len(sql_content)} bytes")

try:
    response = client.postgrest.auth(SUPABASE_KEY).execute_sql(sql_content)
    print("✓ RPC INSTALADA CORRECTAMENTE")
except Exception as e:
    print(f"✗ ERROR AL INSTALAR RPC:")
    print(f"  {str(e)}")
    sys.exit(1)

print("\n" + "="*120)
print("PASO 2: VERIFICAR FIRMAS DE FUNCIONES")
print("="*120)

# Query 1: calc_liberaciones_economic_hash
try:
    result = client.postgrest.auth(SUPABASE_KEY).execute_sql(
        "SELECT pg_get_function_identity_arguments(oid) as firma "
        "FROM pg_proc WHERE proname = 'calc_liberaciones_economic_hash'"
    ).data
    if result and len(result) > 0:
        sig1 = result[0].get('firma', 'NO ENCONTRADA')
        print(f"\ncalc_liberaciones_economic_hash:\n  {sig1}")
    else:
        print("\ncalc_liberaciones_economic_hash: NO ENCONTRADA")
except Exception as e:
    print(f"ERROR consultando calc_liberaciones_economic_hash: {e}")

# Query 2: import_liberaciones_primary
try:
    result = client.postgrest.auth(SUPABASE_KEY).execute_sql(
        "SELECT pg_get_function_identity_arguments(oid) as firma "
        "FROM pg_proc WHERE proname = 'import_liberaciones_primary'"
    ).data
    if result and len(result) > 0:
        sig2 = result[0].get('firma', 'NO ENCONTRADA')
        print(f"\nimport_liberaciones_primary:\n  {sig2}")
    else:
        print("\nimport_liberaciones_primary: NO ENCONTRADA")
except Exception as e:
    print(f"ERROR consultando import_liberaciones_primary: {e}")

print("\n" + "="*120)
print("PASO 3: SNAPSHOT PRE-IMPORT")
print("="*120)

# Snapshot queries
try:
    # FM total
    result = client.postgrest.auth(SUPABASE_KEY).execute_sql(
        "SELECT COUNT(*) as total FROM mp_financial_movement"
    ).data
    fm_total = result[0]['total'] if result else 0
    print(f"\nmp_financial_movement total: {fm_total}")

    # LE total
    result = client.postgrest.auth(SUPABASE_KEY).execute_sql(
        "SELECT COUNT(*) as total FROM ledger_entry"
    ).data
    le_total = result[0]['total'] if result else 0
    print(f"ledger_entry total: {le_total}")

    # needs_review
    result = client.postgrest.auth(SUPABASE_KEY).execute_sql(
        "SELECT COUNT(*) as total FROM mp_financial_movement WHERE needs_review = TRUE"
    ).data
    needs_review = result[0]['total'] if result else 0
    print(f"needs_review = TRUE: {needs_review}")

    # Ledger agosto 2026 sum para account_id
    result = client.postgrest.auth(SUPABASE_KEY).execute_sql(
        """
        SELECT COALESCE(SUM(balance_impact), 0) as total
        FROM ledger_entry
        WHERE account_id = %s
          AND occurred_at >= '2026-08-01'::date AT TIME ZONE 'America/Argentina/Buenos_Aires'
          AND occurred_at < '2026-09-01'::date AT TIME ZONE 'America/Argentina/Buenos_Aires'
        """ % ACCOUNT_ID
    ).data
    ledger_agosto = float(result[0]['total']) if result else 0.0
    print(f"ledger agosto 2026 (account={ACCOUNT_ID}): {ledger_agosto}")

except Exception as e:
    print(f"ERROR en snapshot queries: {e}")

print("\n" + "="*120)
print("PASO 4: VERIFICAR AUSENCIA DE LIBERACIONES PRODUCTIVAS PREVIAS")
print("="*120)

try:
    # SR liberaciones
    result = client.postgrest.auth(SUPABASE_KEY).execute_sql(
        "SELECT COUNT(*) as total FROM mp_source_record WHERE source_type = 'liberaciones'"
    ).data
    sr_liberaciones = result[0]['total'] if result else 0
    print(f"\nmp_source_record con source_type='liberaciones': {sr_liberaciones}")

    # Links asociados
    result = client.postgrest.auth(SUPABASE_KEY).execute_sql(
        """
        SELECT COUNT(*) as total
        FROM mp_movement_source_link
        WHERE source_record_id IN (
          SELECT id FROM mp_source_record WHERE source_type = 'liberaciones'
        )
        """
    ).data
    link_liberaciones = result[0]['total'] if result else 0
    print(f"movement_source_link asociados: {link_liberaciones}")

    # FM asociados
    result = client.postgrest.auth(SUPABASE_KEY).execute_sql(
        """
        SELECT COUNT(DISTINCT fm.id) as total
        FROM mp_financial_movement fm
        WHERE fm.id IN (
          SELECT l.financial_movement_id
          FROM mp_movement_source_link l
          WHERE l.source_record_id IN (
            SELECT id FROM mp_source_record WHERE source_type = 'liberaciones'
          )
        )
        """
    ).data
    fm_liberaciones = result[0]['total'] if result else 0
    print(f"financial_movement asociados: {fm_liberaciones}")

except Exception as e:
    print(f"ERROR en verificación liberaciones: {e}")

print("\n" + "="*120)
print("RESUMEN DE VALIDACIONES")
print("="*120)

# Compare con valores esperados
EXPECTED = {
    'fm_total': 4106,
    'le_total': 4106,
    'needs_review': 2,
    'ledger_agosto': 10780612.05
}

print(f"\nExpected vs Actual:")
print(f"  FM total: {EXPECTED['fm_total']} vs {fm_total} {'✓' if fm_total == EXPECTED['fm_total'] else '✗'}")
print(f"  LE total: {EXPECTED['le_total']} vs {le_total} {'✓' if le_total == EXPECTED['le_total'] else '✗'}")
print(f"  needs_review: {EXPECTED['needs_review']} vs {needs_review} {'✓' if needs_review == EXPECTED['needs_review'] else '✗'}")
print(f"  ledger agosto: {EXPECTED['ledger_agosto']} vs {ledger_agosto} {'✓' if abs(ledger_agosto - EXPECTED['ledger_agosto']) < 0.01 else '✗'}")

print(f"\nLiber aciones previas:")
print(f"  SR: {sr_liberaciones} {'✓' if sr_liberaciones == 0 else '✗ DETENER'}")
print(f"  LINK: {link_liberaciones} {'✓' if link_liberaciones == 0 else '✗ DETENER'}")
print(f"  FM: {fm_liberaciones} {'✓' if fm_liberaciones == 0 else '✗ DETENER'}")

all_match = (
    fm_total == EXPECTED['fm_total'] and
    le_total == EXPECTED['le_total'] and
    needs_review == EXPECTED['needs_review'] and
    abs(ledger_agosto - EXPECTED['ledger_agosto']) < 0.01 and
    sr_liberaciones == 0 and
    link_liberaciones == 0 and
    fm_liberaciones == 0
)

print(f"\nTODO COINCIDE: {'SÍ ✓' if all_match else 'NO ✗ DETENER'}")
print(f"LISTO PARA PRIMER IMPORT REAL DE AGOSTO: {'SÍ ✓' if all_match else 'NO ✗'}")
print("\n" + "="*120)
