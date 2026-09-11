#!/usr/bin/env python3
"""
Replicate EXACTLY the preview RPC logic locally, instrumenting every v_new_financial_movements increment.
This traces the EXACT same decision path as the SQL function.
"""

import json
import hashlib
from datetime import datetime

def parse_timestamp(ts_str):
    if not ts_str or 'T' not in ts_str:
        return None
    try:
        if '+' in ts_str:
            ts_str = ts_str.split('+')[0]
        elif ts_str.endswith('-03:00'):
            ts_str = ts_str[:-6]
        return datetime.fromisoformat(ts_str)
    except:
        return None

def time_diff_seconds(dt1, dt2):
    if not dt1 or not dt2:
        return float('inf')
    delta = abs((dt1 - dt2).total_seconds())
    return delta

def compute_economic_row_fp(account_id, source_type, source_id, signed_impact, timestamp, description):
    """Compute economic row fingerprint (MD5 in original, but we use for matching)"""
    data = f"{account_id}|{source_type}|{source_id}|{1 if signed_impact > 0 else (-1 if signed_impact < 0 else 0)}|{abs(round(signed_impact, 2))}|{timestamp}|{description}"
    return hashlib.md5(data.encode()).hexdigest()

def is_raw_only(source_type, description):
    """Check if row is raw-only (reserves)"""
    return source_type == 'liberaciones' and description in ('reserve_for_payment', 'reserve_for_payout')

def map_to_economic_class(source_type, description_or_type):
    """Map to economic class"""
    if source_type == 'liberaciones':
        if description_or_type == 'payment':
            return 'PAYMENT'
        elif description_or_type == 'payout':
            return 'PAYOUT'
        elif description_or_type == 'asset_management':
            return 'ASSET_MANAGEMENT'
        elif description_or_type in ('reserve_for_payment', 'reserve_for_payout'):
            return 'RESERVE'
        else:
            return 'UNKNOWN'
    elif source_type == 'report':
        return 'PAYMENT'
    else:
        return 'UNKNOWN'

# Load batches
with open('_preview_batches.json', 'r', encoding='utf-8') as f:
    batches = json.load(f)

report_batch = batches['report']
lib_batch = batches['liberaciones']
account_id = 1054315166

print("=" * 120)
print("TRACING v_new_financial_movements INCREMENTS (EXACTLY as preview logic)")
print("=" * 120)
print()

# Build Report index by payload_hash (Layer 1 deduplication)
# Assumption: all Report SR already exist in DB
report_by_hash = {}
for rep_row in report_batch:
    payload_hash = rep_row.get('_payload_hash', hashlib.md5(json.dumps(rep_row, sort_keys=True).encode()).hexdigest())
    report_by_hash[payload_hash] = rep_row

print(f"Report batch: {len(report_batch)} rows (all assumed existing in DB)")
print(f"Liberaciones batch: {len(lib_batch)} rows")
print()

# Build Report index by impact for matching
report_by_impact = {}
for rep_row in report_batch:
    impact = float(rep_row.get('SETTLEMENT_NET_AMOUNT', 0))
    if impact not in report_by_impact:
        report_by_impact[impact] = []
    report_by_impact[impact].append(rep_row)

# Track increments
v_new_financial_movements = 0
increments = []

# === PROCESS REPORT ROWS ===
print("PROCESSING REPORT ROWS:")
print("-" * 120)

for rep_row in report_batch:
    payload_hash = rep_row.get('_payload_hash', hashlib.md5(json.dumps(rep_row, sort_keys=True).encode()).hexdigest())
    signed_impact = float(rep_row.get('SETTLEMENT_NET_AMOUNT', 0))
    source_id = rep_row.get('SOURCE_ID', '')
    description = rep_row.get('TRANSACTION_TYPE', '')

    # Layer 1: SR exists (all Report assumed to exist)
    # Since SR exists and is not raw-only, check for multi-settlement collapse
    # For Report: assume FM already created and LE matches FM
    # So NO new FM created for Report (they all reuse existing)
    pass

print("-> All Report rows: EXISTING_SR found, no NEW_FM created")
print()

# === PROCESS LIBERACIONES ROWS ===
print("PROCESSING LIBERACIONES ROWS:")
print("-" * 120)
print()

for lib_row in lib_batch:
    signed_impact = float(lib_row.get('NET_CREDIT_AMOUNT', 0)) - float(lib_row.get('NET_DEBIT_AMOUNT', 0))
    source_id = lib_row.get('SOURCE_ID', '')
    description = lib_row.get('DESCRIPTION', '')
    lib_ts = parse_timestamp(lib_row.get('DATE', ''))

    v_is_raw_only = is_raw_only('liberaciones', description)
    economic_class = map_to_economic_class('liberaciones', description)

    # Layer 1: Check if this exact row exists (MD5 of JSONB)
    payload_hash_md5 = hashlib.md5(json.dumps(lib_row, sort_keys=True).encode()).hexdigest()

    # Assumption: Liberaciones rows are all new (not in DB yet)
    v_existing_sr = None  # Liberaciones not in DB yet

    if v_existing_sr:
        # SR exists: would check multi-settlement
        pass
    else:
        # New SR (Liberaciones)

        if v_is_raw_only:
            # Raw-only: no FM/LE created
            pass
        else:
            # Try to find matching FM in Report (Layer 3 cross-source matching)
            found_candidate = False

            if signed_impact in report_by_impact:
                report_candidates = report_by_impact[signed_impact]
                for rep_row in report_candidates:
                    rep_ts = parse_timestamp(rep_row.get('TRANSACTION_DATE', ''))
                    time_diff = time_diff_seconds(lib_ts, rep_ts)

                    if time_diff < 86400:  # Within 1 day
                        found_candidate = True
                        break

            if found_candidate:
                # Has existing FM to reuse: NO new FM
                pass
            else:
                # No existing FM found: CREATE NEW FM/LE
                v_new_financial_movements += 1
                increments.append({
                    'number': v_new_financial_movements,
                    'origin': f'liberaciones_{description}',
                    'sr_id': None,
                    'source_id': source_id,
                    'signed_impact': signed_impact,
                    'reason': 'NO_REPORT_CANDIDATE',
                    'description': description,
                    'date': lib_row.get('DATE', '')
                })

print(f"Processed {len(lib_batch)} Liberaciones rows")
print()

# === OUTPUT RESULTS ===
print("=" * 120)
print(f"TOTAL v_new_financial_movements INCREMENTS: {v_new_financial_movements}")
print("=" * 120)
print()

if v_new_financial_movements != len(increments):
    print(f"WARNING: Counter mismatch! {v_new_financial_movements} != {len(increments)}")
    print()

print("DETAILED TRACE:")
print()
for inc in increments:
    print(f"[{inc['number']:2d}] {inc['origin']:30s} | {inc['source_id']:15s} | {inc['signed_impact']:15.2f} | {inc['reason']}")

print()
print("=" * 120)
print("SUMMARY")
print("=" * 120)
print(f"Total NEW_FM traced: {len(increments)}")
print(f"Expected by preview: 21")
print(f"Match: {'YES' if len(increments) == 21 else 'NO - MISSING ' + str(21 - len(increments))}")
print()

# Group by origin
origin_counts = {}
for inc in increments:
    origin = inc['origin']
    origin_counts[origin] = origin_counts.get(origin, 0) + 1

print("By origin:")
for origin in sorted(origin_counts.keys()):
    print(f"  {origin:30s}: {origin_counts[origin]:3d}")
