#!/usr/bin/env python3
import json
import csv
import hashlib
from datetime import datetime
from pathlib import Path

def calculate_historical_payload_hash(row):
    json_str = json.dumps(row, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(json_str.encode()).hexdigest()

def read_csv_june(filepath, delimiter=';', date_field='TRANSACTION_DATE'):
    rows = []
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f, delimiter=delimiter)
        for row in reader:
            if '2026-06' in row.get(date_field, ''):
                rows.append(dict(row))
    return rows

print("Regenerating _preview_batches.json with correct encoding...\n")

# Read Report (arch4.csv) - uses TRANSACTION_DATE
report_path = "data/mercadopago/arch4.csv"
report_rows = read_csv_june(report_path, date_field='TRANSACTION_DATE')
print(f"Report rows (June 2026): {len(report_rows)}")

# Calculate hashes for Report and add _payload_hash
report_batch = []
for row in report_rows:
    payload_hash = calculate_historical_payload_hash(row)
    jsonb_row = {k: (v if v else None) for k, v in row.items()}
    jsonb_row['_payload_hash'] = payload_hash
    report_batch.append(jsonb_row)

# Read Liberaciones (Liberaciones2.csv) - uses DATE
lib_path = "data/mercadopago/Liberaciones2.csv"
lib_rows = read_csv_june(lib_path, date_field='DATE')
print(f"Liberaciones rows (June 2026): {len(lib_rows)}")

# Convert Liberaciones (no payload_hash, use MD5 fallback)
lib_batch = []
for row in lib_rows:
    jsonb_row = {k: (v if v else None) for k, v in row.items()}
    lib_batch.append(jsonb_row)

# Create batches output
batches_output = {
    'account_id': 1054315166,
    'month_start': '2026-06-01',
    'month_end': '2026-06-30',
    'report': report_batch,
    'liberaciones': lib_batch
}

# Write to _preview_batches.json
output_path = '_preview_batches.json'
with open(output_path, 'w') as f:
    json.dump(batches_output, f)

print(f"\nWrote {len(report_batch)} Report + {len(lib_batch)} Liberaciones rows")
print(f"Output: {output_path}")
print("\n✅ Done. Report rows now have correct _payload_hash values.")
