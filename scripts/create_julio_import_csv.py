#!/usr/bin/env python3
"""
Create Liberaciones3_julio_2026_IMPORT.csv
Exclude ONLY the opening/checkpoint row (2026-07-04, no SOURCE_ID, no DESCRIPTION)
Preserve all other 640 data rows
"""

import csv
from collections import Counter

INPUT_FILE = 'data/mercadopago/Liberaciones3_julio_2026.csv'
OUTPUT_FILE = 'data/mercadopago/Liberaciones3_julio_2026_IMPORT.csv'

print(f"Leyendo {INPUT_FILE}...")

rows = []
opening_row = None
row_count = 0

with open(INPUT_FILE, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        row_count += 1
        date = row.get('DATE', '')
        source_id = row.get('SOURCE_ID', '').strip()
        desc = row.get('DESCRIPTION', '').strip()
        balance = row.get('BALANCE_AMOUNT', '')

        # Identify opening: 2026-07-04, no SOURCE_ID, no DESCRIPTION, balance=5,080,770.69
        is_opening = (
            date.startswith('2026-07-04') and
            not source_id and
            not desc and
            balance in ['5080770.69', '5,080,770.69']
        )

        if is_opening:
            print(f"\n[ROW #{row_count}] OPENING/CHECKPOINT IDENTIFICADO:")
            print(f"  DATE: {date}")
            print(f"  SOURCE_ID: [{source_id}]")
            print(f"  DESCRIPTION: [{desc}]")
            print(f"  BALANCE_AMOUNT: {balance}")
            print(f"  --> EXCLUIDO del IMPORT CSV")
            opening_row = row
        else:
            rows.append(row)

print(f"\nRESULTADO:")
print(f"  Total filas leídas: {row_count}")
print(f"  Filas opening excluidas: 1")
print(f"  Filas para IMPORT: {len(rows)}\n")

# Write import CSV
print(f"Escribiendo {OUTPUT_FILE}...")
with open(OUTPUT_FILE, 'w', encoding='utf-8', newline='') as f:
    fieldnames = ['DATE', 'SOURCE_ID', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT',
                  'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'TAXES_AMOUNT', 'PAYMENT_METHOD',
                  'TRANSACTION_APPROVAL_DATE', 'BUSINESS_UNIT', 'SUB_UNIT', 'BALANCE_AMOUNT',
                  'PAYMENT_METHOD_TYPE', 'PURCHASE_ID']
    writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=';')
    writer.writeheader()
    for row in rows:
        writer.writerow(row)

print(f"OK. Wrote {len(rows)} data rows.\n")

# Validate
print("VALIDACIÓN DEL CSV IMPORT:\n")

stats = {
    'payment': 0,
    'asset_management': 0,
    'reserve_for_payment': 0,
    'reserve_for_payout': 0,
    'payout': 0,
    'blank': 0,
    'unknown': 0,
    'creditos_def': 0.0,
    'debitos_def': 0.0,
    'creditos_payouts': 0.0,
    'debitos_payouts': 0.0
}

for row in rows:
    desc = row.get('DESCRIPTION', '').strip()
    cr = float(row.get('NET_CREDIT_AMOUNT', 0) or 0)
    db = float(row.get('NET_DEBIT_AMOUNT', 0) or 0)

    if desc == 'payment':
        stats['payment'] += 1
        stats['creditos_def'] += cr
        stats['debitos_def'] += db
    elif desc == 'asset_management':
        stats['asset_management'] += 1
        stats['creditos_def'] += cr
        stats['debitos_def'] += db
    elif desc == 'reserve_for_payment':
        stats['reserve_for_payment'] += 1
    elif desc == 'reserve_for_payout':
        stats['reserve_for_payout'] += 1
    elif desc == 'payout':
        stats['payout'] += 1
        stats['creditos_payouts'] += cr
        stats['debitos_payouts'] += db
        stats['creditos_def'] += cr
        stats['debitos_def'] += db
    elif desc == '':
        stats['blank'] += 1
    else:
        stats['unknown'] += 1

definitivas = stats['payment'] + stats['asset_management'] + stats['payout']
raw_only = stats['reserve_for_payment'] + stats['reserve_for_payout'] + stats['blank'] + stats['unknown']

print(f"Ruta: {OUTPUT_FILE}")
print(f"Filas: {len(rows)}")
print(f"\nDESCRIPTION:")
print(f"  payment: {stats['payment']}")
print(f"  asset_management: {stats['asset_management']}")
print(f"  reserve_for_payment: {stats['reserve_for_payment']}")
print(f"  reserve_for_payout: {stats['reserve_for_payout']}")
print(f"  payout: {stats['payout']}")
print(f"  blank: {stats['blank']}")
print(f"  unknown: {stats['unknown']}")

print(f"\nCategories:")
print(f"  definitivas: {definitivas}")
print(f"  RAW-only: {raw_only}")

print(f"\nMONTOS DEFINITIVOS:")
print(f"  Créditos: {stats['creditos_def']:.2f}")
print(f"  Débitos: {stats['debitos_def']:.2f}")
print(f"  Neto: {stats['creditos_def'] - stats['debitos_def']:.2f}")

print(f"\nMONTOS PAYOUTS ({stats['payout']}):")
print(f"  Créditos: {stats['creditos_payouts']:.2f}")
print(f"  Débitos: {stats['debitos_payouts']:.2f}")
print(f"  Neto: {stats['creditos_payouts'] - stats['debitos_payouts']:.2f}")

print(f"\nCONFIRMACIÓN:")
expected_creditos = 10384273.34
expected_debitos = 15269477.89
expected_neto_payouts = -14695521.00

creditos_match = abs(stats['creditos_def'] - expected_creditos) < 0.01
debitos_match = abs(stats['debitos_def'] - expected_debitos) < 0.01
payouts_match = abs((stats['creditos_payouts'] - stats['debitos_payouts']) - expected_neto_payouts) < 0.01

print(f"  Créditos match: {creditos_match}")
print(f"  Débitos match: {debitos_match}")
print(f"  Payouts neto match: {payouts_match}")

if creditos_match and debitos_match and payouts_match:
    print(f"\n[OK] CSV JULIO IMPORT VALIDADO CORRECTAMENTE")
else:
    print(f"\n[ERROR] MISMATCH EN MONTOS - VERIFICAR")
