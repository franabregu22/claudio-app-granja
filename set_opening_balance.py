#!/usr/bin/env python3
"""Establecer opening_balance inicial"""

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
    'Content-Type': 'application/json',
}

# Establecer opening_balance
url = f'{SUPABASE_URL}/rest/v1/rpc/set_account_opening_balance'
payload = {
    'p_account_id': 1054315166,
    'p_opening_balance': 0.00,
    'p_opening_balance_date': '2026-01-01'
}

print("\n" + "="*80)
print("ESTABLECIENDO OPENING BALANCE")
print("="*80)
print(f"\nCuenta: 1054315166")
print(f"Saldo inicial: $0.00")
print(f"Fecha: 2026-01-01")

response = requests.post(url, json=payload, headers=headers)

print(f"\nHTTP Status: {response.status_code}")
print(f"Response:")

if response.status_code == 200:
    result = response.json()
    if isinstance(result, list) and len(result) > 0:
        result = result[0]
    print(json.dumps(result, indent=2, ensure_ascii=False))
else:
    print(response.text)

print("\n" + "="*80 + "\n")
