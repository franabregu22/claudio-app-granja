#!/usr/bin/env python3
"""Verificar cálculos de balance"""

import os
import json
import requests
from pathlib import Path
from dotenv import load_dotenv
from datetime import datetime, timedelta

load_dotenv(Path(__file__).parent / ".env.local")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
}

account_id = 1054315166

# Query 1: Ver opening_balance establecido
query1 = """
SELECT
  account_id,
  balance_date,
  opening_balance,
  opening_balance_date,
  opening_balance_source,
  calculated_balance,
  last_synced_at
FROM account_balance
WHERE account_id = %s AND opening_balance_date IS NOT NULL
LIMIT 1;
""" % account_id

# Query 2: Ver primeros 5 días después del opening
query2 = """
SELECT
  balance_date,
  opening_balance,
  calculated_balance,
  sync_source
FROM account_balance
WHERE account_id = %s
ORDER BY balance_date ASC
LIMIT 5;
""" % account_id

# Query 3: Ver balance summary
query3 = """
SELECT
  COUNT(*) as total_balance_rows,
  COUNT(CASE WHEN calculated_balance > 0 THEN 1 END) as positive_balance_days,
  COUNT(CASE WHEN calculated_balance < 0 THEN 1 END) as negative_balance_days,
  MAX(calculated_balance) as max_balance,
  MIN(calculated_balance) as min_balance,
  MAX(balance_date) as last_balance_date
FROM account_balance
WHERE account_id = %s;
""" % account_id

print("\n" + "="*80)
print("VERIFICACIÓN DE BALANCES")
print("="*80)

# Ejecutar queries via Supabase
url = f'{SUPABASE_URL}/rest/v1/account_balance?select=*&account_id=eq.{account_id}&opening_balance_date=not.is.null'
response = requests.get(url, headers=headers)
print(f"\n[1] Opening Balance Establecido:")
if response.status_code == 200:
    data = response.json()
    if data:
        row = data[0]
        print(f"  Cuenta: {row['account_id']}")
        print(f"  Fecha: {row['balance_date']}")
        print(f"  Saldo Inicial: ${row['opening_balance']}")
        print(f"  Saldo Calculado (1-ene): ${row['calculated_balance']}")
        print(f"  Fuente: {row['opening_balance_source']}")
    else:
        print("  No se encontró opening_balance")
else:
    print(f"  Error: {response.status_code}")

# Primeros 5 días
url2 = f'{SUPABASE_URL}/rest/v1/account_balance?select=balance_date,opening_balance,calculated_balance,sync_source&account_id=eq.{account_id}&order=balance_date.asc&limit=5'
response2 = requests.get(url2, headers=headers)
print(f"\n[2] Primeros 5 Días:")
if response2.status_code == 200:
    data = response2.json()
    for row in data:
        print(f"  {row['balance_date']}: ${row['calculated_balance']:.2f} (sync: {row['sync_source']})")
else:
    print(f"  Error: {response2.status_code}")

# Summary
url3 = f'{SUPABASE_URL}/rest/v1/account_balance?select=count&account_id=eq.{account_id}'
response3 = requests.get(url3, headers=headers)
print(f"\n[3] Resumen:")
if response3.status_code == 200:
    # Contar filas
    url_count = f'{SUPABASE_URL}/rest/v1/account_balance?account_id=eq.{account_id}&select=id'
    resp_count = requests.get(url_count, headers=headers)
    total_rows = len(resp_count.json())

    # Obtener min/max
    url_stats = f'{SUPABASE_URL}/rest/v1/account_balance?select=calculated_balance&account_id=eq.{account_id}&order=calculated_balance.desc&limit=1'
    resp_max = requests.get(url_stats, headers=headers)
    max_val = resp_max.json()[0]['calculated_balance'] if resp_max.json() else 0

    url_stats2 = f'{SUPABASE_URL}/rest/v1/account_balance?select=calculated_balance&account_id=eq.{account_id}&order=calculated_balance.asc&limit=1'
    resp_min = requests.get(url_stats2, headers=headers)
    min_val = resp_min.json()[0]['calculated_balance'] if resp_min.json() else 0

    print(f"  Total de días con balance: {total_rows}")
    print(f"  Saldo máximo: ${max_val:.2f}")
    print(f"  Saldo mínimo: ${min_val:.2f}")

print("\n" + "="*80 + "\n")
