#!/usr/bin/env python3
"""Auditar datos actuales en Supabase"""

import os
import json
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

account_id = 1054315166

print("\n" + "="*80)
print("AUDITORÍA: DATOS ACTUALES EN SUPABASE")
print("="*80)

# [1] Contar registros por tabla
print("\n[1] CONTEO DE REGISTROS:")
for table in ['mp_source_record', 'mp_financial_movement', 'ledger_entry', 'account_balance']:
    url = f'{SUPABASE_URL}/rest/v1/{table}?account_id=eq.{account_id}&select=id'
    response = requests.get(url, headers=headers)
    count = len(response.json()) if response.status_code == 200 else 0
    print(f"  {table}: {count}")

# [2] Resumen por categoría
print("\n[2] RESUMEN POR CATEGORÍA:")
url = f"{SUPABASE_URL}/rest/v1/mp_financial_movement?account_id=eq.{account_id}&select=movement_class"
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    categories = {}
    for row in data:
        cat = row['movement_class']
        categories[cat] = categories.get(cat, 0) + 1
    for cat in sorted(categories.keys()):
        print(f"  {cat}: {categories[cat]}")

# [3] Totales financieros
print("\n[3] TOTALES FINANCIEROS:")
url = f"{SUPABASE_URL}/rest/v1/mp_financial_movement?account_id=eq.{account_id}&select=transaction_amount,settlement_amount,tax_amount,movement_class"
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    total_tx = sum(float(row.get('transaction_amount', 0)) for row in data)
    total_settlement = sum(float(row.get('settlement_amount', 0)) for row in data)
    total_tax = sum(float(row.get('tax_amount', 0)) for row in data)
    print(f"  Monto total transacciones: ${total_tx:,.2f}")
    print(f"  Monto total liquidación: ${total_settlement:,.2f}")
    print(f"  Impuestos totales: ${total_tax:,.2f}")
    print(f"  Impacto neto (balance): ${total_settlement + total_tax:,.2f}")

# [4] Primeros 10 movimientos
print("\n[4] PRIMEROS 10 MOVIMIENTOS (por fecha):")
url = f"{SUPABASE_URL}/rest/v1/mp_financial_movement?account_id=eq.{account_id}&select=movement_class,settlement_amount,tax_amount,payment_method,payer_name,transaction_date&order=transaction_date.asc&limit=10"
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    for i, row in enumerate(data, 1):
        print(f"  {i}. {row['transaction_date'][:10]} | {row['movement_class']:15} | "
              f"${float(row.get('settlement_amount', 0)):10,.2f} | "
              f"Tax: ${float(row.get('tax_amount', 0)):8,.2f} | "
              f"{row.get('payer_name', 'N/A')[:20]}")

# [5] Últimos 10 movimientos
print("\n[5] ÚLTIMOS 10 MOVIMIENTOS (por fecha):")
url = f"{SUPABASE_URL}/rest/v1/mp_financial_movement?account_id=eq.{account_id}&select=movement_class,settlement_amount,tax_amount,payment_method,payer_name,transaction_date&order=transaction_date.desc&limit=10"
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    for i, row in enumerate(data, 1):
        print(f"  {i}. {row['transaction_date'][:10]} | {row['movement_class']:15} | "
              f"${float(row.get('settlement_amount', 0)):10,.2f} | "
              f"Tax: ${float(row.get('tax_amount', 0)):8,.2f} | "
              f"{row.get('payer_name', 'N/A')[:20]}")

# [6] Saldo actual
print("\n[6] SALDO ACTUAL:")
url = f"{SUPABASE_URL}/rest/v1/account_balance?account_id=eq.{account_id}&select=balance_date,opening_balance,calculated_balance&order=balance_date.desc&limit=1"
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    if data:
        row = data[0]
        print(f"  Fecha: {row['balance_date']}")
        print(f"  Saldo inicial: ${float(row.get('opening_balance', 0)):,.2f}")
        print(f"  Saldo calculado: ${float(row.get('calculated_balance', 0)):,.2f}")

# [7] Detalles de rendimientos (yield)
print("\n[7] RESUMEN DE RENDIMIENTOS:")
url = f"{SUPABASE_URL}/rest/v1/mp_financial_movement?account_id=eq.{account_id}&movement_class=eq.yield&select=settlement_amount,transaction_date"
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    if data:
        yield_total = sum(float(row.get('settlement_amount', 0)) for row in data)
        yield_count = len(data)
        yield_avg = yield_total / yield_count if yield_count > 0 else 0
        dates = [row['transaction_date'] for row in data]
        print(f"  Cantidad: {yield_count}")
        print(f"  Total rendimientos: ${yield_total:,.2f}")
        print(f"  Promedio por rendimiento: ${yield_avg:,.2f}")
        if dates:
            print(f"  Primer rendimiento: {min(dates)[:10]}")
            print(f"  Último rendimiento: {max(dates)[:10]}")

# [8] Detalles de impuestos
print("\n[8] RESUMEN DE IMPUESTOS:")
url = f"{SUPABASE_URL}/rest/v1/mp_financial_movement?account_id=eq.{account_id}&tax_amount=not.eq.0&select=tax_amount,tax_percentage,movement_class"
response = requests.get(url, headers=headers)
if response.status_code == 200:
    data = response.json()
    if data:
        tax_total = sum(float(row.get('tax_amount', 0)) for row in data)
        tax_count = len(data)
        tax_pct_avg = sum(float(row.get('tax_percentage', 0)) for row in data) / tax_count if tax_count > 0 else 0
        print(f"  Transacciones con impuesto: {tax_count}")
        print(f"  Total impuestos: ${tax_total:,.2f}")
        print(f"  Porcentaje promedio: {tax_pct_avg:.4f}%")

# [9] Movimientos que requieren revisión
print("\n[9] MOVIMIENTOS CON needs_review:")
url = f"{SUPABASE_URL}/rest/v1/mp_financial_movement?account_id=eq.{account_id}&needs_review=eq.true&select=id"
response = requests.get(url, headers=headers)
if response.status_code == 200:
    count = len(response.json())
    print(f"  Total pendientes de revisión: {count}")

print("\n" + "="*80 + "\n")
