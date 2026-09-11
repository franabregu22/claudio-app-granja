#!/usr/bin/env python3
"""Test: Aislar insert en ledger_entry con valores hardcodeados"""

import os
import json
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env.local")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

url = f'{SUPABASE_URL}/rest/v1/rpc/diagnostic_ledger_only'
headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
    'Content-Type': 'application/json'
}

print("\n" + "="*80)
print("TEST: diagnostic_ledger_only (valores hardcodeados)")
print("="*80 + "\n")

response = requests.post(url, json={}, headers=headers)

print(f"HTTP Status: {response.status_code}")
print(f"\nResponse:")
print(response.text)

if response.status_code == 200:
    try:
        result = response.json()
        print(f"\nJSON Parsed:")
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"Error parsing JSON: {e}")
