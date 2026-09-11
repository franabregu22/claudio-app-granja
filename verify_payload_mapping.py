#!/usr/bin/env python3
"""
Verifica el mapeo de filas arch4.csv a SR históricos usando payload_hash.
"""

import csv
import json
import hashlib

def calculate_payload_hash(data: dict) -> str:
    """Calcula SHA256 del payload JSON como lo hacía el importador histórico."""
    json_str = json.dumps(data, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(json_str.encode()).hexdigest()

# Hashes conocidos de AppGranja
KNOWN_HASHES = {
    "1745058376008": [
        "c404fc99c6028e8caa261229fa822bb96909555480bd432905bbd3c91858a9ce",
        "e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f",
    ],
    "1745105363064": [
        "00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50",
        "0d4ae5fcceaf937640f9c219483ea24a95e8b25794c4196cdfe6eccd3e73989c",
    ],
}

SR_MAPPING = {
    "1745058376008": {
        "c404fc99c6028e8caa261229fa822bb96909555480bd432905bbd3c91858a9ce": 3908,
        "e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f": 3909,
    },
    "1745105363064": {
        "00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50": 3903,
        "0d4ae5fcceaf937640f9c219483ea24a95e8b25794c4196cdfe6eccd3e73989c": 3902,
    },
}

# Expected impacts
EXPECTED_IMPACTS = {
    "1745105363064": [471.71, 1629.44],
    "1745058376008": [1854.71, 463.84],
}

print("=" * 100)
print("PAYLOAD HASH MAPPING VERIFICATION")
print("=" * 100)

# Read arch4.csv
matching_rows = []

with open(r"C:\Users\Franabregu\Desktop\Claudio app Granja\data\mercadopago\arch4.csv", 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        source_id = row.get('SOURCE_ID', '').strip()

        # Filter for our SOURCE_IDs
        if source_id not in ["1745105363064", "1745058376008"]:
            continue

        # Calculate net impact
        credit = float(row.get('NET_CREDIT_AMOUNT', '0') or '0')
        debit = float(row.get('NET_DEBIT_AMOUNT', '0') or '0')
        impact = credit - debit

        # Calculate payload hash
        payload_hash = calculate_payload_hash(row)

        # Look up SR id
        sr_id = SR_MAPPING.get(source_id, {}).get(payload_hash, "NOT_FOUND")

        matching_rows.append({
            'SOURCE_ID': source_id,
            'IMPACT': impact,
            'DATE': row.get('DATE', ''),
            'DESCRIPTION': row.get('DESCRIPTION', ''),
            'PAYLOAD_HASH_CALCULATED': payload_hash,
            'SR_ID': sr_id,
            'HASH_MATCH': 'YES' if sr_id != "NOT_FOUND" else 'NO',
        })

# Display results
print("\n")
for row in matching_rows:
    print(f"SOURCE_ID: {row['SOURCE_ID']}")
    print(f"  IMPACT: {row['IMPACT']:>10.2f}")
    print(f"  DATE: {row['DATE']}")
    print(f"  DESCRIPTION: {row['DESCRIPTION']}")
    print(f"  PAYLOAD_HASH (calculated): {row['PAYLOAD_HASH_CALCULATED']}")
    print(f"  SR_ID: {row['SR_ID']}")
    print(f"  HASH MATCH: {row['HASH_MATCH']}")
    print()

# Consolidation
print("\n" + "=" * 100)
print("CONSOLIDATED MAPPING TABLE")
print("=" * 100)
print()
print("SOURCE_ID          | IMPACT      | SR_ID | PAYLOAD_HASH_MATCH")
print("-" * 100)
for row in sorted(matching_rows, key=lambda x: (x['SOURCE_ID'], x['IMPACT'])):
    print(f"{row['SOURCE_ID']}  | {row['IMPACT']:>10.2f}  | {row['SR_ID']:>5} | {row['HASH_MATCH']}")

# Determine if all matched
all_matched = all(row['HASH_MATCH'] == 'YES' for row in matching_rows)

print("\n" + "=" * 100)
print("CONCLUSIONS")
print("=" * 100)
print()
print(f"LEGACY_SR_HASH_MAPPING_POSSIBLE = {'YES' if all_matched else 'NO'}")
print()

# Check for collapse
for source_id in ["1745105363064", "1745058376008"]:
    source_rows = [r for r in matching_rows if r['SOURCE_ID'] == source_id]
    sr_ids = [r['SR_ID'] for r in source_rows]

    if len(sr_ids) == 2:
        if sr_ids[0] == sr_ids[1]:
            print(f"MULTI_SETTLEMENT_COLLAPSE_CONFIRMED_{source_id} = YES (both impacts map to SR {sr_ids[0]})")
        else:
            print(f"MULTI_SETTLEMENT_COLLAPSE_CONFIRMED_{source_id} = NO (distinct SR: {sr_ids[0]}, {sr_ids[1]})")
    else:
        print(f"MULTI_SETTLEMENT_COLLAPSE_CONFIRMED_{source_id} = UNKNOWN (found {len(sr_ids)} rows, expected 2)")

print()
