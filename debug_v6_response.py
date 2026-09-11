#!/usr/bin/env python3
"""Debug: Ver exactamente qué devuelve diagnostic_json_v6"""

import os
import json
import requests
from pathlib import Path
from dotenv import load_dotenv

# Cargar variables de entorno
load_dotenv(Path(__file__).parent / ".env.local")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

# Leer un registro real del CSV para testear
import csv
csv_path = Path(__file__).parent / "data" / "mercadopago" / "arch1.csv"

records = []
with open(csv_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for i, row in enumerate(reader):
        if i < 1:  # Solo el primer registro
            records.append({
                'source_type': 'report',
                'source_external_id': row.get('SOURCE_ID', ''),
                'payload_hash': f"debug_test_{row.get('SOURCE_ID', '')}",
                'raw_data': {'version': 1, 'source': 'debug'},
                'observed_at': row.get('TRANSACTION_DATE'),
                'account_id': 1054315166,
                'movement_class': 'payment_in',  # simplificado
                'transaction_amount': row.get('TRANSACTION_AMOUNT', '0'),
                'settlement_amount': row.get('SETTLEMENT_NET_AMOUNT', '0'),
                'tax_amount': row.get('TAXES_AMOUNT', '0'),
                'tax_detail': None,
                'tax_percentage': row.get('TAXES_PERCENT', '0'),
                'payment_method': row.get('PAYMENT_METHOD_TYPE'),
                'payment_detail': row.get('PAYMENT_METHOD_ID'),
                'payer_name': row.get('PAYER_NAME'),
                'payer_id_type': row.get('PAYER_ID_TYPE'),
                'payer_id_number': row.get('PAYER_ID_NUMBER'),
                'transaction_date': row.get('TRANSACTION_DATE'),
                'settlement_date': row.get('SETTLEMENT_DATE'),
                'order_id': None,
                'external_reference': None,
                'bank_transfer_id': None
            })

payload = {
    'records': records
}

# Llamar a v6
url = f'{SUPABASE_URL}/rest/v1/rpc/diagnostic_json_v6_debug'
headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
    'Content-Type': 'application/json'
}

print("\n" + "="*80)
print("DEBUG: Llamando diagnostic_json_v6")
print("="*80)
print(f"\nURL: {url}")
print(f"\nPayload (bytes): {len(json.dumps(payload))}")
print(f"Primer record source_id: {records[0]['source_external_id']}")

response = requests.post(url, json={'p_input': payload}, headers=headers)

print(f"\nHTTP Status: {response.status_code}")
print(f"\nRaw Response:")
print(response.text)

if response.status_code == 200:
    try:
        result = response.json()
        print(f"\nJSON Parsed:")
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"Error parsing JSON: {e}")
else:
    print(f"\nError: HTTP {response.status_code}")
    if response.text:
        print(f"Response text: {response.text}")
