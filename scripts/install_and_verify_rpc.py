#!/usr/bin/env python3
"""
Instalar RPC productiva y verificar POST-instalación
Usa psycopg2 para ejecutar SQL directo
"""

import sys
import os
from pathlib import Path
from dotenv import load_dotenv
import psycopg2
from urllib.parse import urlparse

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

# Parse Supabase URL to get postgres connection string
parsed = urlparse(SUPABASE_URL)
db_host = parsed.hostname
db_port = parsed.port or 5432
db_name = 'postgres'
db_user = 'postgres'
db_password = SUPABASE_KEY

print("="*120)
print("CONECTANDO A SUPABASE")
print("="*120)

try:
    conn = psycopg2.connect(
        host=db_host,
        port=db_port,
        database=db_name,
        user=db_user,
        password=db_password,
        sslmode='require'
    )
    cursor = conn.cursor()
    print("\nConexion establecida OK\n")
except Exception as e:
    print(f"ERROR conectando: {e}")
    sys.exit(1)

print("="*120)
print("PASO 1: INSTALAR RPC PRODUCTIVA")
print("="*120)

sql_file = Path('sql/006_import_liberaciones_primary_PRODUCTION.sql')
if not sql_file.exists():
    print(f"ERROR: {sql_file} no existe")
    sys.exit(1)

with open(sql_file, 'r', encoding='utf-8') as f:
    sql_content = f.read()

print(f"Leyendo {sql_file}...")
print(f"SQL size: {len(sql_content)} bytes")

try:
    cursor.execute(sql_content)
    conn.commit()
    print("\n[OK] RPC PRODUCTIVA INSTALADA CORRECTAMENTE\n")
except Exception as e:
    conn.rollback()
    print(f"\n[ERROR] AL INSTALAR RPC:")
    print(f"  {str(e)}\n")
    cursor.close()
    conn.close()
    sys.exit(1)

print("="*120)
print("PASO 2: VERIFICAR FIRMAS DE FUNCIONES")
print("="*120)

try:
    cursor.execute(
        "SELECT pg_get_function_identity_arguments(oid) as firma "
        "FROM pg_proc WHERE proname = 'calc_liberaciones_economic_hash'"
    )
    result = cursor.fetchone()
    sig1 = result[0] if result else "NO ENCONTRADA"
    print(f"\ncalc_liberaciones_economic_hash:\n  {sig1}")
except Exception as e:
    print(f"ERROR: {e}")
    sig1 = "ERROR"

try:
    cursor.execute(
        "SELECT pg_get_function_identity_arguments(oid) as firma "
        "FROM pg_proc WHERE proname = 'import_liberaciones_primary'"
    )
    result = cursor.fetchone()
    sig2 = result[0] if result else "NO ENCONTRADA"
    print(f"\nimport_liberaciones_primary:\n  {sig2}\n")
except Exception as e:
    print(f"ERROR: {e}")
    sig2 = "ERROR"

print("="*120)
print("PASO 3: SNAPSHOT PRE-IMPORT")
print("="*120)

try:
    cursor.execute("SELECT COUNT(*) FROM mp_financial_movement")
    fm_total = cursor.fetchone()[0]
    print(f"\nmp_financial_movement total: {fm_total}")

    cursor.execute("SELECT COUNT(*) FROM ledger_entry")
    le_total = cursor.fetchone()[0]
    print(f"ledger_entry total: {le_total}")

    cursor.execute("SELECT COUNT(*) FROM mp_financial_movement WHERE needs_review = TRUE")
    needs_review = cursor.fetchone()[0]
    print(f"needs_review = TRUE: {needs_review}")

    cursor.execute("""
        SELECT COALESCE(SUM(balance_impact), 0) as total
        FROM ledger_entry
        WHERE account_id = %s
          AND occurred_at >= '2026-08-01'::timestamp
          AND occurred_at < '2026-09-01'::timestamp
    """, (ACCOUNT_ID,))
    ledger_agosto = float(cursor.fetchone()[0])
    print(f"ledger agosto 2026 (account={ACCOUNT_ID}): {ledger_agosto}\n")

except Exception as e:
    print(f"ERROR: {e}")
    fm_total = le_total = needs_review = ledger_agosto = None

print("="*120)
print("PASO 4: VERIFICAR AUSENCIA DE LIBERACIONES PRODUCTIVAS PREVIAS")
print("="*120)

try:
    cursor.execute(
        "SELECT COUNT(*) FROM mp_source_record WHERE source_type = 'liberaciones'"
    )
    sr_liberaciones = cursor.fetchone()[0]
    print(f"\nmp_source_record con source_type='liberaciones': {sr_liberaciones}")

    cursor.execute("""
        SELECT COUNT(*)
        FROM mp_movement_source_link
        WHERE source_record_id IN (
          SELECT id FROM mp_source_record WHERE source_type = 'liberaciones'
        )
    """)
    link_liberaciones = cursor.fetchone()[0]
    print(f"movement_source_link asociados: {link_liberaciones}")

    cursor.execute("""
        SELECT COUNT(DISTINCT fm.id)
        FROM mp_financial_movement fm
        WHERE fm.id IN (
          SELECT l.financial_movement_id
          FROM mp_movement_source_link l
          WHERE l.source_record_id IN (
            SELECT id FROM mp_source_record WHERE source_type = 'liberaciones'
          )
        )
    """)
    fm_liberaciones = cursor.fetchone()[0]
    print(f"financial_movement asociados: {fm_liberaciones}\n")

except Exception as e:
    print(f"ERROR: {e}")
    sr_liberaciones = link_liberaciones = fm_liberaciones = None

cursor.close()
conn.close()

print("="*120)
print("RESUMEN DE VALIDACIONES")
print("="*120)

EXPECTED = {
    'fm_total': 4106,
    'le_total': 4106,
    'needs_review': 2,
    'ledger_agosto': 10780612.05
}

def check(actual, expected, desc):
    if isinstance(expected, float):
        match = abs(actual - expected) < 0.01 if actual else False
    else:
        match = actual == expected
    status = "OK" if match else "FAIL"
    return f"{desc}: {expected} vs {actual} [{status}]"

print(f"\nExpected vs Actual:")
if fm_total is not None:
    print(f"  {check(fm_total, EXPECTED['fm_total'], 'FM total')}")
if le_total is not None:
    print(f"  {check(le_total, EXPECTED['le_total'], 'LE total')}")
if needs_review is not None:
    print(f"  {check(needs_review, EXPECTED['needs_review'], 'needs_review')}")
if ledger_agosto is not None:
    print(f"  {check(ledger_agosto, EXPECTED['ledger_agosto'], 'ledger agosto')}")

print(f"\nLiberaciones previas:")
if sr_liberaciones is not None:
    status = "OK" if sr_liberaciones == 0 else "STOP"
    print(f"  SR: {sr_liberaciones} [{status}]")
if link_liberaciones is not None:
    status = "OK" if link_liberaciones == 0 else "STOP"
    print(f"  LINK: {link_liberaciones} [{status}]")
if fm_liberaciones is not None:
    status = "OK" if fm_liberaciones == 0 else "STOP"
    print(f"  FM: {fm_liberaciones} [{status}]")

all_match = (
    fm_total == EXPECTED['fm_total'] and
    le_total == EXPECTED['le_total'] and
    needs_review == EXPECTED['needs_review'] and
    abs(ledger_agosto - EXPECTED['ledger_agosto']) < 0.01 and
    sr_liberaciones == 0 and
    link_liberaciones == 0 and
    fm_liberaciones == 0
)

print(f"\nTODO COINCIDE: {'SÍ' if all_match else 'NO'}")
print(f"LISTO PARA PRIMER IMPORT: {'SÍ' if all_match else 'NO'}")
print("="*120)
