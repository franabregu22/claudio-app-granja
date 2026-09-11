#!/usr/bin/env python3
"""
Filter Liberaciones3.csv to ONLY July 2026 (America/Argentina/Buenos_Aires timezone)
Validate structure and distribution
"""

import csv
from datetime import datetime
from collections import Counter

INPUT_FILE = 'data/mercadopago/Liberaciones3.csv'
OUTPUT_FILE = 'data/mercadopago/Liberaciones3_julio_2026.csv'

def parse_date(date_str):
    """Parse ISO 8601 date with timezone offset"""
    try:
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt
    except:
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
    'total_july': 0,
    'creditos_def': 0.0,
    'debitos_def': 0.0,
    'creditos_payouts': 0.0,
    'debitos_payouts': 0.0,
    'min_date': None,
    'max_date': None,
    'source_ids': [],
    'source_ids_null': 0,
    'source_ids_blank': 0
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

        # Check if in July 2026 (regardless of timezone, just year/month)
        if dt.year == 2026 and dt.month == 7:
            filtered_rows.append(row)
            stats['total_july'] += 1

            # Track min/max date
            if stats['min_date'] is None or dt < stats['min_date']:
                stats['min_date'] = dt
            if stats['max_date'] is None or dt > stats['max_date']:
                stats['max_date'] = dt

            # Count by description
            desc = row.get('DESCRIPTION', '').strip()
            if desc == 'payment':
                stats['payment'] += 1
                if desc not in ('reserve_for_payment', 'reserve_for_payout'):
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

            # Track SOURCE_ID
            source_id = row.get('SOURCE_ID', '').strip()
            if source_id:
                stats['source_ids'].append(source_id)
            elif source_id == '':
                stats['source_ids_blank'] += 1
            else:
                stats['source_ids_null'] += 1

print(f"\n=== FILTERED JULY 2026 RESULTS ===")
print(f"Total filas: {stats['total_july']}")
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

print(f"\nFecha minima: {stats['min_date']}")
print(f"Fecha maxima: {stats['max_date']}")

print(f"\nCreditos definitivos: {stats['creditos_def']:.2f}")
print(f"Debitos definitivos: {stats['debitos_def']:.2f}")
print(f"Neto definitivo: {stats['creditos_def'] - stats['debitos_def']:.2f}")

print(f"\nCreditos {stats['payout']} payouts: {stats['creditos_payouts']:.2f}")
print(f"Debitos {stats['payout']} payouts: {stats['debitos_payouts']:.2f}")
print(f"Neto {stats['payout']} payouts: {stats['creditos_payouts'] - stats['debitos_payouts']:.2f}")

# SOURCE_ID analysis
source_id_counts = Counter(stats['source_ids'])
duplicates = sum(1 for count in source_id_counts.values() if count > 1)

print(f"\nSOURCE_ID Analysis:")
print(f"  Total no nulos: {len(stats['source_ids'])}")
print(f"  NULL: {stats['source_ids_null']}")
print(f"  Blank: {stats['source_ids_blank']}")
print(f"  Duplicados exactos: {duplicates} SOURCE_IDs aparecen mas de una vez")
if duplicates > 0:
    dups = [sid for sid, count in source_id_counts.items() if count > 1]
    print(f"    IDs duplicados: {dups[:5]}{'...' if len(dups) > 5 else ''}")

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
