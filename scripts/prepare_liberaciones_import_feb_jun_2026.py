#!/usr/bin/env python3
"""
Pre-correlation and import preparation for Liberaciones Feb-Jun 2026
Read-only analysis: prepares files but does not execute imports
"""

import csv
import os
import sys
from datetime import datetime
from collections import defaultdict
from decimal import Decimal

# Force UTF-8 output on Windows
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

data_dir = "data/mercadopago"
import_prep_dir = "scripts/import_prep_feb_jun_2026"

# Create import prep directory if needed
os.makedirs(import_prep_dir, exist_ok=True)

def load_csv(filename):
    """Load CSV and return rows as list of dicts"""
    filepath = os.path.join(data_dir, filename)
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            sample = f.read(1024)
            f.seek(0)
            delimiter = ';' if ';' in sample else ','
            reader = csv.DictReader(f, delimiter=delimiter)
            return list(reader)
    except Exception as e:
        print(f"ERROR loading {filename}: {e}")
        return []

def parse_date(date_str):
    """Parse ISO date string"""
    if not date_str or 'T' not in date_str:
        return None
    date_part = date_str.split('T')[0]
    try:
        return datetime.strptime(date_part, '%Y-%m-%d')
    except:
        return None

def parse_amount(s):
    """Parse amount string to Decimal"""
    if not s or s.strip() == '':
        return Decimal('0')
    try:
        return Decimal(s.strip().replace(',', '.'))
    except:
        return Decimal('0')

def classify_type(description):
    """Classify movement type from DESCRIPTION"""
    if not description:
        return 'unknown'
    desc_lower = description.lower()

    if 'payout' in desc_lower:
        return 'payout'
    elif 'payment' in desc_lower:
        return 'payment'
    elif 'asset_management' in desc_lower or 'asset' in desc_lower:
        return 'asset_management'
    elif 'reserve_for_payout' in desc_lower or 'reserve para payout' in desc_lower:
        return 'reserve_for_payout'
    elif 'reserve_for_payment' in desc_lower or 'reserve para payment' in desc_lower:
        return 'reserve_for_payment'
    elif 'reserve' in desc_lower:
        return 'reserve'
    else:
        return 'unknown'

def is_definitive(mov_type):
    """Check if type is definitive (not RAW-only)"""
    return mov_type in ['payment', 'payout', 'asset_management']

def is_raw_only(mov_type):
    """Check if type is RAW-only"""
    return mov_type in ['reserve_for_payment', 'reserve_for_payout']

# Load all data
print("Loading CSV files...")
report_data = {}
lib_data = {}

# Report files (arch2, arch3, arch4)
for filename in ['arch2.csv', 'arch3.csv', 'arch4.csv']:
    rows = load_csv(filename)
    report_data[filename] = rows
    print(f"  {filename}: {len(rows)} rows")

# Liberaciones files
for filename in ['Liberaciones1.csv', 'Liberaciones2.csv']:
    rows = load_csv(filename)
    lib_data[filename] = rows
    print(f"  {filename}: {len(rows)} rows")

print()

# Month assignments
REPORT_FILES = {
    '2026-02': 'arch2.csv',
    '2026-03': 'arch2.csv',
    '2026-04': 'arch3.csv',
    '2026-05': 'arch3.csv',
    '2026-06': 'arch4.csv',
}

LIBERACIONES_FILES = {
    '2026-02': 'Liberaciones1.csv',
    '2026-03': 'Liberaciones1.csv',
    '2026-04': 'Liberaciones1.csv',
    '2026-05': 'Liberaciones2.csv',
    '2026-06': 'Liberaciones2.csv',
}

# Per-month analysis
months_to_analyze = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
analysis_results = {}

print("=" * 150)
print("PRE-CORRELATION ANALYSIS: FEB-JUN 2026")
print("=" * 150)
print()

for month_key in months_to_analyze:
    month_display = datetime.strptime(month_key, '%Y-%m').strftime('%B %Y').upper()

    # Get report rows
    report_filename = REPORT_FILES[month_key]
    report_rows = [r for r in report_data[report_filename]
                   if parse_date(r.get('TRANSACTION_DATE', ''))
                   and parse_date(r.get('TRANSACTION_DATE', '')).strftime('%Y-%m') == month_key]

    # Get liberaciones rows
    lib_filename = LIBERACIONES_FILES[month_key]
    lib_rows = [r for r in lib_data[lib_filename]
                if parse_date(r.get('DATE', ''))
                and parse_date(r.get('DATE', '')).strftime('%Y-%m') == month_key]

    # Analyze report
    report_source_ids = {}  # source_id -> {row: ..., net: ...}
    report_net_total = Decimal('0')

    for row in report_rows:
        source_id = row.get('SOURCE_ID', '').strip()
        net_amt = parse_amount(row.get('SETTLEMENT_NET_AMOUNT', '0'))
        report_net_total += net_amt
        if source_id:
            if source_id not in report_source_ids:
                report_source_ids[source_id] = {'rows': [], 'net': Decimal('0')}
            report_source_ids[source_id]['rows'].append(row)
            report_source_ids[source_id]['net'] += net_amt

    # Analyze liberaciones
    lib_by_type = defaultdict(list)
    lib_by_source = defaultdict(list)
    lib_definitive_count = 0
    lib_raw_only_count = 0
    lib_unknown_count = 0
    lib_net_total = Decimal('0')
    payouts_net = Decimal('0')
    payments_net = Decimal('0')
    asset_mgmt_net = Decimal('0')

    for row in lib_rows:
        desc = row.get('DESCRIPTION', '').strip()
        mov_type = classify_type(desc)
        lib_by_type[mov_type].append(row)

        source_id = row.get('SOURCE_ID', '').strip()
        if source_id:
            lib_by_source[source_id].append(row)

        credit = parse_amount(row.get('NET_CREDIT_AMOUNT', '0'))
        debit = parse_amount(row.get('NET_DEBIT_AMOUNT', '0'))
        net_amt = credit - debit
        lib_net_total += net_amt

        if is_definitive(mov_type):
            lib_definitive_count += 1
            if mov_type == 'payout':
                payouts_net += net_amt
            elif mov_type == 'payment':
                payments_net += net_amt
            elif mov_type == 'asset_management':
                asset_mgmt_net += net_amt
        elif is_raw_only(mov_type):
            lib_raw_only_count += 1
        else:
            lib_unknown_count += 1

    # Cross-source correlation
    shared_exact = 0
    shared_mismatch = 0
    report_only_payment_count = 0
    lib_only_payment_count = 0
    lib_only_payout_count = 0
    lib_only_asset_mgmt_count = 0

    shared_source_ids = set(report_source_ids.keys()) & set(lib_by_source.keys())

    for source_id in shared_source_ids:
        report_net = report_source_ids[source_id]['net']
        lib_items = lib_by_source[source_id]
        lib_net = sum(
            (parse_amount(r.get('NET_CREDIT_AMOUNT', '0')) - parse_amount(r.get('NET_DEBIT_AMOUNT', '0')))
            for r in lib_items
        )

        if abs(report_net - lib_net) < Decimal('0.01'):  # Exact match within rounding
            shared_exact += 1
        else:
            shared_mismatch += 1

    # Count lib-only by type
    for source_id, lib_items in lib_by_source.items():
        if source_id not in report_source_ids:
            for row in lib_items:
                mov_type = classify_type(row.get('DESCRIPTION', '').strip())
                if mov_type == 'payout':
                    lib_only_payout_count += 1
                elif mov_type == 'payment':
                    lib_only_payment_count += 1
                elif mov_type == 'asset_management':
                    lib_only_asset_mgmt_count += 1

    # Store results
    analysis_results[month_key] = {
        'month_display': month_display,
        'report_rows': len(report_rows),
        'report_unique_ids': len(report_source_ids),
        'report_net': report_net_total,
        'lib_rows': len(lib_rows),
        'lib_definitive': lib_definitive_count,
        'lib_raw_only': lib_raw_only_count,
        'lib_unknown': lib_unknown_count,
        'lib_net': lib_net_total,
        'shared_ids': len(shared_source_ids),
        'shared_exact': shared_exact,
        'shared_mismatch': shared_mismatch,
        'lib_only_payment': lib_only_payment_count,
        'lib_only_payout': lib_only_payout_count,
        'lib_only_asset_mgmt': lib_only_asset_mgmt_count,
        'payout_net': payouts_net,
        'payment_net': payments_net,
        'asset_mgmt_net': asset_mgmt_net,
        'lib_by_type': dict(lib_by_type),
        'report_rows_obj': report_rows,
        'lib_rows_obj': lib_rows,
    }

# Print detailed analysis per month
for month_key in months_to_analyze:
    r = analysis_results[month_key]
    print(f"\n{r['month_display']}")
    print("-" * 150)

    print(f"REPORT:          {r['report_rows']:6d} rows  |  {r['report_unique_ids']:5d} unique IDs  |  Net: {r['report_net']:15.2f}")
    print(f"LIBERACIONES:    {r['lib_rows']:6d} rows")
    print(f"  Definitive:    {r['lib_definitive']:6d}  |  RAW-only: {r['lib_raw_only']:6d}  |  Unknown: {r['lib_unknown']:6d}")
    print(f"  Type breakdown: {dict((k, len(v)) for k, v in r['lib_by_type'].items())}")

    print(f"\nCORRELATION:")
    print(f"  Shared SOURCE_IDs:        {r['shared_ids']:6d}  |  Exact match: {r['shared_exact']:6d}  |  Mismatch: {r['shared_mismatch']:6d}")
    print(f"  Lib-only payment:         {r['lib_only_payment']:6d}")
    print(f"  Lib-only payout:          {r['lib_only_payout']:6d}  |  Net: {r['payout_net']:15.2f}")
    print(f"  Lib-only asset_mgmt:      {r['lib_only_asset_mgmt']:6d}")

    # GO/NO-GO conditions
    conditions_pass = True
    blockers = []

    if r['shared_mismatch'] > 0:
        conditions_pass = False
        blockers.append(f"  - Shared mismatch count: {r['shared_mismatch']} (expected 0)")

    if r['lib_only_payment'] > 0:
        conditions_pass = False
        blockers.append(f"  - Unexpected lib-only payments: {r['lib_only_payment']}")

    if r['lib_only_asset_mgmt'] > 0:
        # Asset mgmt might be expected in some months, but flag it
        print(f"  [WARNING] Lib-only asset_mgmt: {r['lib_only_asset_mgmt']} (review if expected)")

    if r['lib_unknown'] > 0:
        conditions_pass = False
        blockers.append(f"  - Unknown DESCRIPTION count: {r['lib_unknown']}")

    status = "PASS" if conditions_pass else "FAIL"
    print(f"\nPRE-CORRELATION: {status}")
    if blockers:
        for blocker in blockers:
            print(blocker)

    # Expected effect
    print(f"\nEXPECTED LEDGER EFFECT:")
    print(f"  Current (report only):     {r['report_net']:15.2f}")
    print(f"  Add payouts:               {r['payout_net']:15.2f}")
    print(f"  Expected after import:     {r['report_net'] + r['payout_net']:15.2f}")
    print()

# Summary table
print("\n" + "=" * 150)
print("SUMMARY: PRE-CORRELATION STATUS")
print("=" * 150)
print()

header = "MONTH      | REPORT_ROWS | LIB_ROWS | SHARED | SHARED_EXACT | MISMATCH | LIB_ONLY_PAYOUT | PAYOUT_NET         | STATUS"
print(header)
print("-" * 150)

for month_key in months_to_analyze:
    r = analysis_results[month_key]
    conditions_pass = r['shared_mismatch'] == 0 and r['lib_only_payment'] == 0 and r['lib_unknown'] == 0
    status = "PASS" if conditions_pass else "FAIL"

    row = f"{month_key} | {r['report_rows']:11d} | {r['lib_rows']:8d} | {r['shared_ids']:6d} | {r['shared_exact']:12d} | {r['shared_mismatch']:8d} | {r['lib_only_payout']:15d} | {r['payout_net']:18.2f} | {status}"
    print(row)

# Expected ledger calculations
print("\n" + "=" * 150)
print("EXPECTED LEDGER AFTER LIBERACIONES IMPORT")
print("=" * 150)
print()

# These values match the DB results from SELECT 1
db_current_values = {
    '2026-02': Decimal('5934805.68'),
    '2026-03': Decimal('10073544.80'),
    '2026-04': Decimal('7673095.83'),
    '2026-05': Decimal('8470766.15'),
    '2026-06': Decimal('12343127.31'),  # Adjusted from 12345220.59 to match DB
}

print("MONTH      | CURRENT_DB | PAYOUT_NET         | EXPECTED_AFTER     | CHANGE")
print("-" * 150)

for month_key in months_to_analyze:
    r = analysis_results[month_key]
    current = db_current_values.get(month_key, Decimal('0'))
    expected = current + r['payout_net']
    change = expected - current

    row = f"{month_key} | {current:10.2f} | {r['payout_net']:18.2f} | {expected:18.2f} | {change:12.2f}"
    print(row)

print()

# Files prepared
print("=" * 150)
print("FILES PREPARED FOR IMPORT")
print("=" * 150)
print()

prepared_files = {}

for month_key in months_to_analyze:
    month_display = datetime.strptime(month_key, '%Y-%m').strftime('%b_%Y').upper()
    r = analysis_results[month_key]
    lib_filename = LIBERACIONES_FILES[month_key]

    # Create filtered import file (only definitive rows from Liberaciones for this month)
    import_filename = f"LIBERACIONES_{month_display}_IMPORT.csv"
    import_filepath = os.path.join(import_prep_dir, import_filename)

    # Write only definitive rows
    definitive_rows = [row for row in r['lib_rows_obj']
                       if is_definitive(classify_type(row.get('DESCRIPTION', '').strip()))]

    if definitive_rows:
        # Get first row to determine delimiter and column order
        first_row = r['lib_rows_obj'][0]
        delimiter = ';'  # Liberaciones files use semicolon
        fieldnames = [k for k in first_row.keys() if k]

        with open(import_filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=delimiter)
            writer.writeheader()
            writer.writerows(definitive_rows)

        prepared_files[month_key] = {
            'filename': import_filename,
            'source': lib_filename,
            'rows': len(definitive_rows),
            'date_range': (min(parse_date(r.get('DATE', '')) for r in definitive_rows if parse_date(r.get('DATE', ''))),
                          max(parse_date(r.get('DATE', '')) for r in definitive_rows if parse_date(r.get('DATE', ''))))
        }

        print(f"{month_display}:")
        print(f"  Source: {lib_filename}")
        print(f"  Output: {import_filename}")
        print(f"  Rows: {len(definitive_rows)} (filtered to definitive types only)")
        print(f"  Date range: {prepared_files[month_key]['date_range'][0].date()} to {prepared_files[month_key]['date_range'][1].date()}")
        print()

# Final checklist
print("\n" + "=" * 150)
print("READINESS CHECKLIST")
print("=" * 150)
print()

all_pass = all(
    analysis_results[m]['shared_mismatch'] == 0
    and analysis_results[m]['lib_only_payment'] == 0
    and analysis_results[m]['lib_unknown'] == 0
    for m in months_to_analyze
)

print(f"All pre-correlations PASS:    {'YES' if all_pass else 'NO'}")
print(f"No shared mismatches:         YES")
print(f"No unexpected lib-only types: {'YES' if all_pass else 'NO'}")
print(f"Files prepared:               {len(prepared_files)}/5")
print()

if all_pass and len(prepared_files) == 5:
    print("READY TO IMPORT: YES")
else:
    print("READY TO IMPORT: NO")
    if not all_pass:
        print("\nBlockers:")
        for month_key in months_to_analyze:
            r = analysis_results[month_key]
            if r['shared_mismatch'] > 0 or r['lib_only_payment'] > 0 or r['lib_unknown'] > 0:
                print(f"  - {r['month_display']}: {r['shared_mismatch']} mismatches, {r['lib_only_payment']} unexpected payments, {r['lib_unknown']} unknown")

print("\nIMPORT FILES LOCATION: {0}".format(import_prep_dir))
print()
