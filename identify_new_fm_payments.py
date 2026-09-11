#!/usr/bin/env python3
"""
Identify Liberaciones payment rows that DON'T find Report candidates.
Simulates find_exact_fm_for_liberaciones_reuse matching locally.
"""

import json
from datetime import datetime, timedelta

def parse_timestamp(ts_str):
    """Parse ISO timestamp string"""
    if not ts_str:
        return None
    # Handle timezone-aware strings
    if 'T' not in ts_str:
        return None
    try:
        # Remove timezone for comparison
        if '+' in ts_str:
            ts_str = ts_str.split('+')[0]
        elif '-03:00' in ts_str:
            ts_str = ts_str.replace('-03:00', '')
        return datetime.fromisoformat(ts_str)
    except:
        return None

def time_diff_seconds(dt1, dt2):
    """Calculate absolute time difference in seconds"""
    if not dt1 or not dt2:
        return float('inf')
    delta = abs((dt1 - dt2).total_seconds())
    return delta

# Load batches
with open('_preview_batches.json', 'r') as f:
    batches = json.load(f)

report_batch = batches['report']
lib_batch = batches['liberaciones']

print("="*120)
print("IDENTIFYING LIBERACIONES PAYMENT ROWS WITH ZERO REPORT CANDIDATES")
print("="*120)
print()

# Build Report index: settlement_amount -> [Report rows]
report_by_impact = {}
for rep_row in report_batch:
    impact = float(rep_row.get('SETTLEMENT_NET_AMOUNT', 0))
    if impact not in report_by_impact:
        report_by_impact[impact] = []
    report_by_impact[impact].append(rep_row)

print(f"Report batch: {len(report_batch)} rows")
print(f"  Unique settlement amounts: {len(report_by_impact)}")
print()

# Filter Liberaciones for payments only
lib_payments = [r for r in lib_batch if r.get('DESCRIPTION') == 'payment']
print(f"Liberaciones batch: {len(lib_batch)} total rows")
print(f"Liberaciones payments: {len(lib_payments)} rows")
print()

# For each payment, check if it finds a Report candidate
no_candidate_payments = []

for lib_row in lib_payments:
    signed_impact = float(lib_row.get('NET_CREDIT_AMOUNT', 0)) - float(lib_row.get('NET_DEBIT_AMOUNT', 0))
    lib_ts = parse_timestamp(lib_row.get('DATE', ''))

    # Check if this impact exists in Report (Report uses SETTLEMENT_NET_AMOUNT)
    if signed_impact not in report_by_impact:
        # No Report row with this exact impact
        no_candidate_payments.append({
            'reason': 'NO_MATCHING_IMPACT',
            'lib_row': lib_row,
            'signed_impact': signed_impact,
            'lib_ts': lib_ts
        })
        continue

    # Check if any Report row is within 86400s (1 day)
    # Report uses TRANSACTION_DATE, not DATE
    report_candidates = report_by_impact[signed_impact]
    found_candidate = False
    closest_candidate = None
    closest_diff = float('inf')

    for rep_row in report_candidates:
        rep_ts = parse_timestamp(rep_row.get('TRANSACTION_DATE', ''))  # Fixed: use TRANSACTION_DATE for Report
        time_diff = time_diff_seconds(lib_ts, rep_ts)

        if time_diff < closest_diff:
            closest_diff = time_diff
            closest_candidate = rep_row

        if time_diff < 86400:  # Within 1 day
            found_candidate = True
            break

    if not found_candidate:
        no_candidate_payments.append({
            'reason': 'IMPACT_FOUND_BUT_TIMESTAMP_OUT_OF_WINDOW',
            'lib_row': lib_row,
            'signed_impact': signed_impact,
            'lib_ts': lib_ts,
            'num_report_candidates': len(report_candidates),
            'closest_candidate': closest_candidate,
            'closest_time_diff_seconds': int(closest_diff) if closest_diff != float('inf') else None
        })

print()
print("="*120)
print(f"LIBERACIONES PAYMENTS WITH ZERO REPORT CANDIDATES: {len(no_candidate_payments)}")
print("="*120)
print()

if len(no_candidate_payments) == 0:
    print("✅ ALL payment rows found Report candidates. No new FM would be created.")
else:
    for i, entry in enumerate(no_candidate_payments, 1):
        lib = entry['lib_row']
        print(f"\nRow {i}:")
        print(f"  SOURCE_ID:           {lib.get('SOURCE_ID', 'N/A')}")
        print(f"  DATE:                {lib.get('DATE', 'N/A')}")
        print(f"  NET_CREDIT_AMOUNT:   {lib.get('NET_CREDIT_AMOUNT', 'N/A')}")
        print(f"  NET_DEBIT_AMOUNT:    {lib.get('NET_DEBIT_AMOUNT', 'N/A')}")
        print(f"  signed_impact:       {entry['signed_impact']:12.2f}")
        print(f"  PURCHASE_ID:         {lib.get('PURCHASE_ID', 'N/A')}")
        print(f"  PAYMENT_METHOD:      {lib.get('PAYMENT_METHOD', 'N/A')}")
        print(f"  PAYMENT_METHOD_TYPE: {lib.get('PAYMENT_METHOD_TYPE', 'N/A')}")
        print(f"  Reason:              {entry['reason']}")
        if entry['reason'] == 'IMPACT_FOUND_BUT_TIMESTAMP_OUT_OF_WINDOW':
            print(f"  Report candidates:   {entry['num_report_candidates']} rows with same impact")
            if entry['closest_candidate']:
                print(f"  Closest match:       {entry['closest_candidate'].get('SOURCE_ID', 'N/A')} @ {entry['closest_candidate'].get('TRANSACTION_DATE', 'N/A')}")
                print(f"  Time diff:           {entry['closest_time_diff_seconds']} seconds (~{entry['closest_time_diff_seconds']//3600 if entry['closest_time_diff_seconds'] else 0} hours)")

print()
print("="*120)
print(f"SUMMARY: {len(no_candidate_payments)} payment rows would create NEW_FM")
print("="*120)

# Check consistency with preview
total_lib_accounted = len(lib_payments) - len(no_candidate_payments) + len(no_candidate_payments)
raw_only_payments = len([r for r in lib_batch if r.get('DESCRIPTION') in ('reserve_for_payment', 'reserve_for_payout')])
payouts = len([r for r in lib_batch if r.get('DESCRIPTION') == 'payout'])
asset_mgmt = len([r for r in lib_batch if r.get('DESCRIPTION') == 'asset_management'])

print()
print("BATCH COMPOSITION:")
print(f"  Payouts (new FM):      {payouts}")
print(f"  Asset management:      {asset_mgmt}")
print(f"  Payments:              {len(lib_payments)}")
print(f"    -> with candidates:  {len(lib_payments) - len(no_candidate_payments)}")
print(f"    -> no candidates:    {len(no_candidate_payments)}")
print(f"  Reserves (raw-only):   {raw_only_payments}")
print(f"  TOTAL:                 {payouts + asset_mgmt + len(lib_payments) + raw_only_payments}")
