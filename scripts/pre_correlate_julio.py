#!/usr/bin/env python3
"""
Pre-correlate JULIO payment/asset_management against existing report FMs
READ-ONLY against Supabase
"""

import csv
import os
from pathlib import Path
from dotenv import load_dotenv
import psycopg2

env_path = Path('.env.local')
if not env_path.exists():
    print("ERROR: .env.local no encontrado")
    exit(1)

load_dotenv(dotenv_path=env_path)

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
ACCOUNT_ID = 1054315166

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Credenciales no configuradas")
    exit(1)

# Parse Supabase URL
from urllib.parse import urlparse
parsed = urlparse(SUPABASE_URL)
db_host = parsed.hostname
db_port = parsed.port or 5432
db_name = 'postgres'
db_user = 'postgres'
db_password = SUPABASE_KEY

print("Conectando a Supabase...")
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
    print("OK\n")
except Exception as e:
    print(f"ERROR: {e}")
    exit(1)

# Read JULIO CSV
print("Leyendo Liberaciones3_julio_2026.csv...")
julio_rows = []
with open('data/mercadopago/Liberaciones3_julio_2026.csv', 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        julio_rows.append(row)

print(f"Total filas: {len(julio_rows)}\n")

# Filter payment + asset_management only
payment_asset_rows = [r for r in julio_rows if r.get('DESCRIPTION', '').strip() in ('payment', 'asset_management')]
payout_rows = [r for r in julio_rows if r.get('DESCRIPTION', '').strip() == 'payout']

print(f"Payment/asset_management filas: {len(payment_asset_rows)}")
print(f"Payout filas: {len(payout_rows)}\n")

# Get unique SOURCE_IDs from payment/asset
unique_source_ids = set()
for r in payment_asset_rows:
    sid = r.get('SOURCE_ID', '').strip()
    if sid:
        unique_source_ids.add(sid)

print(f"Payment/asset SOURCE_ID únicos: {len(unique_source_ids)}\n")

# Pre-correlate each SOURCE_ID
print("PRE-CORRELACIÓN (READ-ONLY):\n")

stats = {
    'correlacionables': 0,
    'sin_correlacion': 0,
    'multiples_fm': 0,
    'fm_sin_le': 0,
    'mismatches': 0,
    'exactas': 0,
    'problematicos': []
}

for source_id in sorted(unique_source_ids):
    # Query 1: Get report SR for this SOURCE_ID
    cursor.execute(
        "SELECT id FROM mp_source_record WHERE source_type='report' AND source_external_id=%s LIMIT 1",
        (source_id,)
    )
    sr_result = cursor.fetchone()

    if not sr_result:
        stats['sin_correlacion'] += 1
        stats['problematicos'].append(f"  {source_id}: NO report SR")
        continue

    sr_id = sr_result[0]

    # Query 2: Get FM linked to this SR for our account
    cursor.execute(
        """
        SELECT DISTINCT l.financial_movement_id
        FROM mp_movement_source_link l
        JOIN mp_financial_movement fm ON fm.id = l.financial_movement_id
        WHERE l.source_record_id = %s
          AND fm.account_id = %s
        """,
        (sr_id, ACCOUNT_ID)
    )
    fm_results = cursor.fetchall()

    if len(fm_results) == 0:
        stats['sin_correlacion'] += 1
        stats['problematicos'].append(f"  {source_id}: report SR sin FM")
        continue

    if len(fm_results) > 1:
        stats['multiples_fm'] += 1
        stats['problematicos'].append(f"  {source_id}: {len(fm_results)} FMs found")
        continue

    fm_id = fm_results[0][0]

    # Query 3: Get LE for this FM
    cursor.execute(
        "SELECT id, balance_impact FROM ledger_entry WHERE financial_movement_id=%s LIMIT 1",
        (fm_id,)
    )
    le_result = cursor.fetchone()

    if not le_result:
        stats['fm_sin_le'] += 1
        stats['problematicos'].append(f"  {source_id}: FM {fm_id} sin LE")
        continue

    le_id, le_balance = le_result

    # Query 4: Get settlement_amount from FM
    cursor.execute(
        "SELECT settlement_amount FROM mp_financial_movement WHERE id=%s",
        (fm_id,)
    )
    fm_result = cursor.fetchone()
    fm_settlement = fm_result[0] if fm_result else None

    # Query 5: Compare with incoming balance from CSV
    incoming_balance = sum([float(r.get('NET_CREDIT_AMOUNT', 0) or 0) - float(r.get('NET_DEBIT_AMOUNT', 0) or 0)
                           for r in payment_asset_rows if r.get('SOURCE_ID', '').strip() == source_id])

    # Validar exactitud
    if abs(float(le_balance) - incoming_balance) < 0.01 and abs(float(fm_settlement) - incoming_balance) < 0.01:
        stats['exactas'] += 1
        stats['correlacionables'] += 1
    else:
        stats['mismatches'] += 1
        stats['problematicos'].append(f"  {source_id}: mismatch (FM={fm_settlement}, LE={le_balance}, incoming={incoming_balance})")

cursor.close()
conn.close()

print(f"RESULTADOS PRE-CORRELACIÓN:")
print(f"  Filas payment/asset: {len(payment_asset_rows)}")
print(f"  SOURCE_ID únicos: {len(unique_source_ids)}")
print(f"  Correlacionables: {stats['correlacionables']}")
print(f"  Sin correlación: {stats['sin_correlacion']}")
print(f"  Múltiples FM: {stats['multiples_fm']}")
print(f"  FM sin LE: {stats['fm_sin_le']}")
print(f"  Mismatches: {stats['mismatches']}")
print(f"  Exactas: {stats['exactas']}")

if stats['problematicos']:
    print(f"\nPROBLEMATICOS:")
    for p in stats['problematicos'][:20]:
        print(p)
    if len(stats['problematicos']) > 20:
        print(f"  ... y {len(stats['problematicos']) - 20} mas")

print(f"\nCONCLUSIÓN:")
if stats['sin_correlacion'] == 0 and stats['multiples_fm'] == 0 and stats['fm_sin_le'] == 0 and stats['mismatches'] == 0:
    print("LISTO: todos los payment/asset tienen correlación válida")
else:
    print("BLOQUEADO: existen payment/asset sin correlación válida")
