#!/usr/bin/env python3
"""
Find collapse by comparing batch (v_signed_impact) vs DB (v_existing_le_balance).

For each Report row in batch:
1. Calculate v_signed_impact = SETTLEMENT_NET_AMOUNT
2. Calculate payload_hash
3. Look up in DB: does this SR exist?
4. If yes: get its LE.balance_impact from DB
5. Compare: ABS(le_balance - v_signed_impact) > 0.01?
6. If yes: COLLAPSE DETECTED → this SR needs new FM
"""

import json
import hashlib
import sys

def calculate_payload_hash(row):
    json_str = json.dumps(row, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(json_str.encode()).hexdigest()

# Load batch
with open('_preview_batches.json', 'r', encoding='utf-8') as f:
    batches = json.load(f)

report_batch = batches['report']

print("=" * 130)
print("COLLAPSE DETECTION: Compare batch v_signed_impact vs DB LE.balance_impact")
print("=" * 130)
print()
print("NOTE: This requires querying the DB. Below are the payload_hashes to look up.")
print("Copy them into a Supabase query to fetch the corresponding SR/FM/LE data.")
print()

# Prepare list of payload_hashes for DB lookup
payload_hashes_to_check = []

for rep_row in report_batch:
    v_signed_impact = float(rep_row.get('SETTLEMENT_NET_AMOUNT', 0))
    source_id = rep_row.get('SOURCE_ID', '')
    payload_hash = rep_row.get('_payload_hash')

    if not payload_hash:
        payload_hash = calculate_payload_hash(rep_row)

    payload_hashes_to_check.append({
        'payload_hash': payload_hash,
        'source_id': source_id,
        'v_signed_impact': v_signed_impact,
        'transaction_date': rep_row.get('TRANSACTION_DATE', '')
    })

# Generate SQL to fetch all matching SR/FM/LE
print("Execute this query in Supabase Studio to get all SR with their LE:")
print()
print("""
SELECT
  sr.id AS sr_id,
  sr.payload_hash,
  sr.raw_data->>'SOURCE_ID' AS source_id,
  fm.id AS fm_id,
  fm.settlement_amount,
  le.id AS le_id,
  le.balance_impact
FROM mp_source_record sr
INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = mfm.id
INNER JOIN ledger_entry le ON fm.id = le.financial_movement_id
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
WHERE sr.source_type = 'report'
  AND sr.payload_hash IN (
""")

# Add payload hashes in chunks
for i, item in enumerate(payload_hashes_to_check):
    if i < len(payload_hashes_to_check) - 1:
        print(f"    '{item['payload_hash']}',")
    else:
        print(f"    '{item['payload_hash']}'")

print("""  )
  AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
ORDER BY sr.id;
""")

print()
print("=" * 130)
print("Once you have the results, I will compare each row:")
print("  - v_signed_impact (from batch: SETTLEMENT_NET_AMOUNT)")
print("  - le_balance_impact (from DB)")
print("  - If ABS(difference) > 0.01 → COLLAPSE DETECTED")
print("=" * 130)
print()
print("BATCH DATA to match against DB results:")
print()
print("payload_hash | source_id | v_signed_impact (from batch)")
print("-" * 130)

known_sr = {
    '0d4ae5fcceaf937640f9c219483ea24a95e8b25794c4196cdfe6eccd3e73989c': 'SR3902',
    '00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50': 'SR3903',
    'c404fc99c6028e8caa261229fa822bb96909555480bd432905bbd3c91858a9ce': 'SR3908',
    'e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f': 'SR3909'
}

for item in payload_hashes_to_check:
    label = known_sr.get(item['payload_hash'], '')
    print(f"{item['payload_hash'][:16]}... | {item['source_id']:15} | {item['v_signed_impact']:12.2f}  {label}")

print()
print("=" * 130)
print("SUMMARY")
print("=" * 130)
print("Known collapses from user feedback:")
print("  SR3903 (payload ending in 'f164c50'): batch=+1629.44, DB LE should differ")
print("  SR3909 (payload ending in 'b912390f'): batch=+463.84, DB LE should differ")
print()
print("Task: Find the THIRD SR where batch amount != DB LE amount")
