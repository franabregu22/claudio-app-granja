#!/usr/bin/env python3
"""
Automatically detect collapses by:
1. Load 682 Report rows from batch
2. For each row: calculate payload_hash
3. Look up SR in DB by payload_hash
4. If found: get its LE.balance_impact
5. Compare: ABS(le_balance - v_signed_impact_batch) > 0.01?
6. Print only the 3 (or more) cases with discrepancy > 0.01
"""

import json
import hashlib
import sys

def calculate_payload_hash(row):
    json_str = json.dumps(row, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(json_str.encode()).hexdigest()

# Try to connect to DB
try:
    import psycopg2
    HAS_PSYCOPG2 = True
except ImportError:
    HAS_PSYCOPG2 = False
    print("psycopg2 not installed. Attempting subprocess approach...")

def query_db_via_psql(sr_payload_hash):
    """Query DB using psql subprocess"""
    import subprocess
    sql = f"""
    SELECT sr.id, le.balance_impact
    FROM mp_source_record sr
    LEFT JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
    LEFT JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
    LEFT JOIN ledger_entry le ON fm.id = le.financial_movement_id
      AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
    WHERE sr.source_type = 'report'
      AND sr.payload_hash = '{sr_payload_hash}'
      AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
    LIMIT 1;
    """

    try:
        result = subprocess.run(
            ['psql', '-h', 'localhost', '-U', 'postgres', '-d', 'appgranja', '-t', '-A', '-c', sql],
            capture_output=True,
            text=True,
            timeout=3
        )

        if result.returncode == 0 and result.stdout.strip():
            parts = result.stdout.strip().split('|')
            if len(parts) >= 2 and parts[0]:
                sr_id = int(parts[0])
                le_balance = float(parts[1]) if parts[1] else None
                return sr_id, le_balance
    except Exception as e:
        pass

    return None, None

def query_db_via_psycopg2(sr_payload_hash):
    """Query DB using psycopg2"""
    try:
        conn = psycopg2.connect(
            host="localhost",
            user="postgres",
            database="appgranja",
            password="postgres"  # Adjust if needed
        )
        cur = conn.cursor()

        sql = """
        SELECT sr.id, le.balance_impact
        FROM mp_source_record sr
        LEFT JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
        LEFT JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
        LEFT JOIN ledger_entry le ON fm.id = le.financial_movement_id
          AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
        WHERE sr.source_type = 'report'
          AND sr.payload_hash = %s
          AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
        LIMIT 1;
        """

        cur.execute(sql, (sr_payload_hash,))
        result = cur.fetchone()
        cur.close()
        conn.close()

        if result:
            sr_id, le_balance = result
            return sr_id, le_balance
    except Exception as e:
        pass

    return None, None

# Load batch
with open('_preview_batches.json', 'r', encoding='utf-8') as f:
    batches = json.load(f)

report_batch = batches['report']

print("=" * 120)
print("COLLAPSE DETECTOR - Automated")
print("=" * 120)
print()
print(f"Processing {len(report_batch)} Report rows...")
print()

collapses = []
processed = 0
found_in_db = 0

for i, rep_row in enumerate(report_batch):
    v_signed_impact = float(rep_row.get('SETTLEMENT_NET_AMOUNT', 0))
    source_id = rep_row.get('SOURCE_ID', '')
    payload_hash = rep_row.get('_payload_hash')

    if not payload_hash:
        payload_hash = calculate_payload_hash(rep_row)

    processed += 1

    # Query DB
    if HAS_PSYCOPG2:
        sr_id, le_balance = query_db_via_psycopg2(payload_hash)
    else:
        sr_id, le_balance = query_db_via_psql(payload_hash)

    if sr_id is not None:
        found_in_db += 1

        # Replicate preview logic: ABS(v_existing_le_balance - v_signed_impact) > 0.01
        if le_balance is not None and abs(le_balance - v_signed_impact) > 0.01:
            collapses.append({
                'sr_id': sr_id,
                'source_id': source_id,
                'v_signed_impact': v_signed_impact,
                'le_balance': le_balance,
                'discrepancy': abs(le_balance - v_signed_impact),
                'payload_hash': payload_hash[:20] + '...'
            })

    if (i + 1) % 100 == 0:
        print(f"  Processed {i + 1}/{len(report_batch)}...")

print()
print("=" * 120)
print(f"RESULTS: {len(collapses)} COLLAPSES DETECTED")
print("=" * 120)
print()

if not collapses:
    print("ERROR: No collapses found. Possible issues:")
    print("  1. DB connection failed (check localhost/credentials)")
    print("  2. Account_id filter is excluding data")
    print("  3. No SR exist with LE in June")
    print()
    print(f"Found in DB: {found_in_db} / {processed} SR checked")
    sys.exit(1)

print("SR_ID | SOURCE_ID       | Batch amount | LE actual | Discrepancy | Payload (first 20)")
print("-" * 120)

for collapse in collapses:
    print(f"{collapse['sr_id']:5} | {collapse['source_id']:15} | {collapse['v_signed_impact']:12.2f} | {collapse['le_balance']:12.2f} | {collapse['discrepancy']:10.2f} | {collapse['payload_hash']}")

print()
print("=" * 120)
print(f"SUMMARY: {len(collapses)} collapsesidentified")
print("Expected: 3 (SR3903, SR3909, + 1 unknown)")
if len(collapses) == 3:
    print("✓ Count matches!")
elif len(collapses) > 3:
    print(f"✗ More than 3 found. Double-check.")
else:
    print(f"✗ Less than 3 found. Check DB access or filters.")
print("=" * 120)
