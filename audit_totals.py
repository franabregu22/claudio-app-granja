#!/usr/bin/env python3
"""Auditar totales globales (sin filtro account_id)"""

import os
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env.local")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
}

print("\n" + "="*80)
print("AUDITORÍA GLOBAL: TODOS LOS DATOS")
print("="*80)

# [1] Totales globales
print("\n[1] TOTALES POR TABLA:")
for table in ['mp_source_record', 'mp_financial_movement', 'ledger_entry', 'account_balance']:
    url = f'{SUPABASE_URL}/rest/v1/{table}?select=id&limit=1'
    response = requests.head(url, headers=headers)
    # PostgREST devuelve el count en header si usamos ?select=count
    url_count = f'{SUPABASE_URL}/rest/v1/{table}?select=count'
    response = requests.get(url_count, headers=headers)
    count_header = response.headers.get('content-range', '').split('/')[-1] if 'content-range' in response.headers else 'N/A'
    print(f"  {table}: {count_header}")

# [2] Cuentas únicas
print("\n[2] CUENTAS EN LA BD:")
url = f'{SUPABASE_URL}/rest/v1/mp_financial_movement?select=account_id'
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    accounts = set(row['account_id'] for row in data)
    for acc in sorted(accounts):
        count = len([r for r in data if r['account_id'] == acc])
        print(f"  Account {acc}: {count} movimientos")

# [3] Categorías globales
print("\n[3] CATEGORÍAS (GLOBALES):")
url = f'{SUPABASE_URL}/rest/v1/mp_financial_movement?select=movement_class'
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    categories = {}
    for row in data:
        cat = row['movement_class']
        categories[cat] = categories.get(cat, 0) + 1
    for cat in sorted(categories.keys()):
        print(f"  {cat}: {categories[cat]}")

# [4] Totales financieros globales
print("\n[4] TOTALES FINANCIEROS (GLOBALES):")
url = f'{SUPABASE_URL}/rest/v1/mp_financial_movement?select=transaction_amount,settlement_amount,tax_amount'
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    total_tx = sum(float(row.get('transaction_amount', 0)) for row in data)
    total_settlement = sum(float(row.get('settlement_amount', 0)) for row in data)
    total_tax = sum(float(row.get('tax_amount', 0)) for row in data)
    print(f"  Total transacciones: ${total_tx:,.2f}")
    print(f"  Total liquidación: ${total_settlement:,.2f}")
    print(f"  Total impuestos: ${total_tax:,.2f}")
    print(f"  Impacto neto: ${total_settlement + total_tax:,.2f}")

# [5] Status needs_review
print("\n[5] MOVIMIENTOS CON needs_review:")
url = f'{SUPABASE_URL}/rest/v1/mp_financial_movement?select=needs_review'
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    needs_review_count = len([r for r in data if r['needs_review'] == True])
    print(f"  Pendientes de revisión: {needs_review_count} / {len(data)}")

print("\n" + "="*80 + "\n")
