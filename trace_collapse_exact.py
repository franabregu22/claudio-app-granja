#!/usr/bin/env python3
"""
Trace EXACTLY the collapse detection logic from preview RPC.
For each Report SR in batch:
1. Calculate v_signed_impact from SETTLEMENT_NET_AMOUNT
2. Query DB: does SR exist?
3. If exists: get its FM and LE for June
4. Compare v_signed_impact vs LE.balance_impact
5. If ABS difference > 0.01 → COLLAPSE DETECTED → v_create_fm_from_sr += 1
"""

import json
import hashlib
import subprocess
import sys
from datetime import datetime

def calculate_payload_hash(row):
    """SHA256 payload hash exactly as in import"""
    json_str = json.dumps(row, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(json_str.encode()).hexdigest()

# Load batch
with open('_preview_batches.json', 'r', encoding='utf-8') as f:
    batches = json.load(f)

report_batch = batches['report']
account_id = 1054315166

print("=" * 120)
print("TRACING COLLAPSE DETECTION (EXACT preview logic for Report SR)")
print("=" * 120)
print()

collapses_found = []
v_create_fm_from_sr_count = 0

for i, rep_row in enumerate(report_batch, 1):
    signed_impact = float(rep_row.get('SETTLEMENT_NET_AMOUNT', 0))
    source_id = rep_row.get('SOURCE_ID', '')
    payload_hash = rep_row.get('_payload_hash')

    if not payload_hash:
        payload_hash = calculate_payload_hash(rep_row)

    # Query DB to find if this SR exists
    sql_query = f"""
    SELECT sr.id, fm.id as fm_id, fm.settlement_amount, le.id as le_id, le.balance_impact
    FROM mp_source_record sr
    LEFT JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
    LEFT JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
    LEFT JOIN ledger_entry le ON fm.id = le.financial_movement_id
      AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
    WHERE sr.source_type = 'report'
      AND sr.payload_hash = '{payload_hash}'
      AND (fm.account_id = {account_id} OR fm.account_id IS NULL)
    LIMIT 1;
    """

    # Execute query via psql
    try:
        result = subprocess.run(
            ['psql', '-h', 'localhost', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sql_query],
            capture_output=True,
            text=True,
            timeout=5
        )

        if result.returncode == 0 and result.stdout.strip():
            # Parse result
            parts = result.stdout.strip().split('|')
            if len(parts) >= 5:
                sr_id = parts[0]
                fm_id = parts[1] if parts[1] != '' else None
                fm_settlement = float(parts[2]) if parts[2] and parts[2] != 'None' else None
                le_id = parts[3] if parts[3] != '' else None
                le_balance = float(parts[4]) if parts[4] and parts[4] != 'None' else None

                # Replicate preview logic:
                # IF v_existing_le_balance IS NOT NULL AND ABS(v_existing_le_balance - v_signed_impact) > 0.01
                if le_balance is not None and abs(le_balance - signed_impact) > 0.01:
                    v_create_fm_from_sr_count += 1
                    collapses_found.append({
                        'sr_id': sr_id,
                        'source_id': source_id,
                        'payload_hash': payload_hash[:16] + '...',
                        'signed_impact_expected': signed_impact,
                        'fm_id': fm_id,
                        'fm_settlement': fm_settlement,
                        'le_id': le_id,
                        'le_balance_actual': le_balance,
                        'discrepancy': abs(le_balance - signed_impact)
                    })
    except Exception as e:
        # DB not accessible or other error - skip
        pass

print()
print("=" * 120)
print(f"COLLAPSES DETECTED: {v_create_fm_from_sr_count}")
print("=" * 120)
print()

if collapses_found:
    for i, collapse in enumerate(collapses_found, 1):
        print(f"[{i}] SR{collapse['sr_id']:5} | {collapse['source_id']:15} | Expected: {collapse['signed_impact_expected']:12.2f} | LE actual: {collapse['le_balance_actual']:12.2f} | Discrepancy: {collapse['discrepancy']:10.2f}")
else:
    print("No collapses found via direct DB query.")
    print()
    print("NOTE: If DB is not accessible locally, try executing this query in Supabase Studio:")
    print()
    print("""
SELECT sr.id, sr.payload_hash, fm.id, fm.settlement_amount, le.id, le.balance_impact
FROM mp_source_record sr
INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
INNER JOIN ledger_entry le ON fm.id = le.financial_movement_id
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
WHERE sr.source_type = 'report'
  AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
  AND ABS(fm.settlement_amount - le.balance_impact) > 0.01
ORDER BY sr.id;
    """)

print()
print("=" * 120)
print("SUMMARY")
print("=" * 120)
print(f"Total collapse detections (v_create_fm_from_sr): {v_create_fm_from_sr_count}")
print(f"Expected: 3 (SR3903, SR3909, + 1 unknown)")
