#!/usr/bin/env python3
"""
Filter Liberaciones3.csv to ONLY August 2026 (America/Argentina/Buenos_Aires timezone)
Validate structure and distribution
"""

import csv
from datetime import datetime, timezone, timedelta

# Buenos Aires timezone: UTC-3 (standard) or UTC-2 (DST)
# August is always UTC-3 (standard time in Southern Hemisphere)
BUENOS_AIRES_TZ = timezone(timedelta(hours=-3))
INPUT_FILE = 'data/mercadopago/Liberaciones3.csv'
OUTPUT_FILE = 'data/mercadopago/Liberaciones3_agosto_2026.csv'
AUGUST_START = datetime(2026, 8, 1, 0, 0, 0, tzinfo=BUENOS_AIRES_TZ)
AUGUST_END = datetime(2026, 8, 31, 23, 59, 59, tzinfo=BUENOS_AIRES_TZ)

# Expected distribution (from user specification)
EXPECTED = {
    'total_filas': 798,
    'payment': 696,
    'asset_management': 20,
    'reserve_for_payment': 52,
    'reserve_for_payout': 20,
    'payout': 10,
    'definitivas': 726,
    'raw_only': 72,
    'creditos_definitivos': 13337721.86,
    'debitos_definitivos': 13461925.10,
    'neto_definitivo': -124203.24,
    'neto_10_payouts': -10904815.29
}

def parse_date(date_str):
    """Parse ISO 8601 date with timezone offset"""
    try:
        # Handle formats like "2026-07-04T00:00:00.000-03:00"
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt
    except Exception as e:
        print(f"ERROR parsing date '{date_str}': {e}")
        return None

def parse_numeric(value):
    """Parse numeric, handling blanks as 0"""
    if value is None or value == '':
        return 0.0
    try:
        return float(value)
    except:
        return 0.0

# Read and filter
filtered_rows = []
stats = {
    'payment': 0,
    'asset_management': 0,
    'reserve_for_payment': 0,
    'reserve_for_payout': 0,
    'payout': 0,
    'unknown': 0,
    'blank': 0,
    'total_august': 0,
    'creditos_def': 0.0,
    'debitos_def': 0.0,
    'creditos_payouts': 0.0,
    'debitos_payouts': 0.0
}

print(f"Reading {INPUT_FILE}...")
with open(INPUT_FILE, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('DATE', '')
        if not date_str:
            continue

        dt = parse_date(date_str)
        if not dt:
            continue

        # Check if in August 2026 (regardless of timezone, just year/month)
        if dt.year == 2026 and dt.month == 8:
            filtered_rows.append(row)
            stats['total_august'] += 1

            # Count by description
            desc = row.get('DESCRIPTION', '').strip()
            if desc == 'payment':
                stats['payment'] += 1
                if not desc in ('reserve_for_payment', 'reserve_for_payout'):
                    stats['creditos_def'] += parse_numeric(row.get('NET_CREDIT_AMOUNT'))
                    stats['debitos_def'] += parse_numeric(row.get('NET_DEBIT_AMOUNT'))
            elif desc == 'asset_management':
                stats['asset_management'] += 1
                stats['creditos_def'] += parse_numeric(row.get('NET_CREDIT_AMOUNT'))
                stats['debitos_def'] += parse_numeric(row.get('NET_DEBIT_AMOUNT'))
            elif desc == 'reserve_for_payment':
                stats['reserve_for_payment'] += 1
            elif desc == 'reserve_for_payout':
                stats['reserve_for_payout'] += 1
            elif desc == 'payout':
                stats['payout'] += 1
                stats['creditos_payouts'] += parse_numeric(row.get('NET_CREDIT_AMOUNT'))
                stats['debitos_payouts'] += parse_numeric(row.get('NET_DEBIT_AMOUNT'))
                stats['creditos_def'] += parse_numeric(row.get('NET_CREDIT_AMOUNT'))
                stats['debitos_def'] += parse_numeric(row.get('NET_DEBIT_AMOUNT'))
            elif desc == '':
                stats['blank'] += 1
            else:
                stats['unknown'] += 1

print(f"\n=== FILTERED AUGUST 2026 RESULTS ===")
print(f"Total filas: {stats['total_august']}")
print(f"  payment: {stats['payment']}")
print(f"  asset_management: {stats['asset_management']}")
print(f"  reserve_for_payment: {stats['reserve_for_payment']}")
print(f"  reserve_for_payout: {stats['reserve_for_payout']}")
print(f"  payout: {stats['payout']}")
print(f"  blank: {stats['blank']}")
print(f"  unknown: {stats['unknown']}")

definitivas = (stats['payment'] + stats['asset_management'] + stats['payout'])
raw_only = (stats['reserve_for_payment'] + stats['reserve_for_payout'] + stats['blank'] + stats['unknown'])

print(f"\nDefinitivas (payment+asset+payout): {definitivas}")
print(f"RAW-only (reserves+blank+unknown): {raw_only}")
print(f"Total: {definitivas + raw_only}")

print(f"\nCreditos definitivos: {stats['creditos_def']:.2f}")
print(f"Debitos definitivos: {stats['debitos_def']:.2f}")
print(f"Neto definitivo: {stats['creditos_def'] - stats['debitos_def']:.2f}")

print(f"\nCreditos 10 payouts: {stats['creditos_payouts']:.2f}")
print(f"Debitos 10 payouts: {stats['debitos_payouts']:.2f}")
print(f"Neto 10 payouts: {stats['creditos_payouts'] - stats['debitos_payouts']:.2f}")

# Write filtered CSV
print(f"\nWriting {OUTPUT_FILE}...")
with open(OUTPUT_FILE, 'w', encoding='utf-8', newline='') as f:
    reader = csv.DictReader(open(INPUT_FILE, 'r', encoding='utf-8'), delimiter=';')
    fieldnames = reader.fieldnames
    writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=';')
    writer.writeheader()
    for row in filtered_rows:
        writer.writerow(row)

print(f"Done. Wrote {len(filtered_rows)} rows to {OUTPUT_FILE}")

# Validate against expected
print(f"\n=== VALIDATION ===")
errors = []
if stats['total_august'] != EXPECTED['total_filas']:
    errors.append(f"FAIL: total_filas={stats['total_august']}, expected {EXPECTED['total_filas']}")
if stats['payment'] != EXPECTED['payment']:
    errors.append(f"FAIL: payment={stats['payment']}, expected {EXPECTED['payment']}")
if stats['asset_management'] != EXPECTED['asset_management']:
    errors.append(f"FAIL: asset_management={stats['asset_management']}, expected {EXPECTED['asset_management']}")
if stats['reserve_for_payment'] != EXPECTED['reserve_for_payment']:
    errors.append(f"FAIL: reserve_for_payment={stats['reserve_for_payment']}, expected {EXPECTED['reserve_for_payment']}")
if stats['reserve_for_payout'] != EXPECTED['reserve_for_payout']:
    errors.append(f"FAIL: reserve_for_payout={stats['reserve_for_payout']}, expected {EXPECTED['reserve_for_payout']}")
if stats['payout'] != EXPECTED['payout']:
    errors.append(f"FAIL: payout={stats['payout']}, expected {EXPECTED['payout']}")
if definitivas != EXPECTED['definitivas']:
    errors.append(f"FAIL: definitivas={definitivas}, expected {EXPECTED['definitivas']}")
if raw_only != EXPECTED['raw_only']:
    errors.append(f"FAIL: raw_only={raw_only}, expected {EXPECTED['raw_only']}")

if errors:
    print("VALIDATION ERRORS:")
    for e in errors:
        print(f"  {e}")
else:
    print("✓ ALL CHECKS PASS")
