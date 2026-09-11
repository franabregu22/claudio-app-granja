#!/usr/bin/env python3
"""
Cross-source audit: Account Money Report vs. Liberaciones (Feb-Jun 2026)
Read-only analysis: no modifications to files or database
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

# Map CSV files to months
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

def get_report_data(month_key):
    """Get report (arch) data for a month"""
    filename = REPORT_FILES.get(month_key)
    if not filename:
        return []

    all_rows = load_csv(filename)
    month_rows = []

    for row in all_rows:
        date_str = row.get('TRANSACTION_DATE', '')
        if not date_str:
            continue
        parsed = parse_date(date_str)
        if parsed and parsed.strftime('%Y-%m') == month_key:
            month_rows.append(row)

    return month_rows

def get_liberaciones_data(month_key):
    """Get liberaciones data for a month"""
    filename = LIBERACIONES_FILES.get(month_key)
    if not filename:
        return []

    all_rows = load_csv(filename)
    month_rows = []

    for row in all_rows:
        date_str = row.get('DATE', '')
        if not date_str:
            continue
        parsed = parse_date(date_str)
        if parsed and parsed.strftime('%Y-%m') == month_key:
            month_rows.append(row)

    return month_rows

def classify_liberaciones_type(description):
    """Classify liberaciones type from DESCRIPTION"""
    if not description:
        return 'unknown'
    desc_lower = description.lower()

    if 'payout' in desc_lower:
        return 'payout'
    elif 'payment' in desc_lower:
        return 'payment'
    elif 'asset_management' in desc_lower or 'asset' in desc_lower:
        return 'asset_management'
    elif 'reserve' in desc_lower:
        return 'reserve'
    else:
        return 'unknown'

def is_definitive_type(lib_type):
    """Check if liberaciones type is definitive (not RAW-only)"""
    return lib_type in ['payment', 'payout', 'asset_management']

print("=" * 150)
print("CROSS-SOURCE AUDIT: ACCOUNT MONEY REPORT vs. LIBERACIONES (FEB-JUN 2026)")
print("=" * 150)
print()

# Analysis per month
months_to_analyze = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
monthly_results = {}

for month_key in months_to_analyze:
    report_rows = get_report_data(month_key)
    lib_rows = get_liberaciones_data(month_key)

    # Report analysis
    report_source_ids = set()
    report_net_total = Decimal('0')
    for row in report_rows:
        source_id = row.get('SOURCE_ID', '').strip()
        if source_id:
            report_source_ids.add(source_id)
        net_amt = parse_amount(row.get('SETTLEMENT_NET_AMOUNT', '0'))
        report_net_total += net_amt

    # Liberaciones analysis
    lib_descriptions = defaultdict(int)
    lib_source_ids = set()
    lib_definitive_count = 0
    lib_raw_only_count = 0
    lib_definitive_source_ids = set()
    lib_definitive_net_total = Decimal('0')

    payout_count = 0
    payout_total = Decimal('0')
    asset_mgmt_count = 0
    payment_count = 0

    for row in lib_rows:
        desc = row.get('DESCRIPTION', '').strip()
        if desc:
            lib_descriptions[desc] += 1

        lib_type = classify_liberaciones_type(desc)
        source_id = row.get('SOURCE_ID', '').strip()
        if source_id:
            lib_source_ids.add(source_id)

        # Calculate net amount (credit - debit)
        credit = parse_amount(row.get('NET_CREDIT_AMOUNT', '0'))
        debit = parse_amount(row.get('NET_DEBIT_AMOUNT', '0'))
        net_amt = credit - debit

        if is_definitive_type(lib_type):
            lib_definitive_count += 1
            if source_id:
                lib_definitive_source_ids.add(source_id)
            lib_definitive_net_total += net_amt

            if lib_type == 'payout':
                payout_count += 1
                payout_total += net_amt
            elif lib_type == 'asset_management':
                asset_mgmt_count += 1
            elif lib_type == 'payment':
                payment_count += 1
        else:
            lib_raw_only_count += 1

    # Cross-source comparison
    shared_source_ids = report_source_ids & lib_source_ids
    report_only = len(report_source_ids - lib_source_ids)
    lib_only = len(lib_source_ids - report_source_ids)

    # Store results
    monthly_results[month_key] = {
        'report_rows': len(report_rows),
        'report_unique_ids': len(report_source_ids),
        'report_net_total': report_net_total,
        'lib_rows': len(lib_rows),
        'lib_descriptions': dict(lib_descriptions),
        'lib_definitive_count': lib_definitive_count,
        'lib_raw_only_count': lib_raw_only_count,
        'lib_definitive_ids': len(lib_definitive_source_ids),
        'lib_definitive_net_total': lib_definitive_net_total,
        'payout_count': payout_count,
        'payout_total': payout_total,
        'asset_mgmt_count': asset_mgmt_count,
        'payment_count': payment_count,
        'shared_ids': len(shared_source_ids),
        'report_only_ids': report_only,
        'lib_only_ids': lib_only,
    }

# Print detailed per-month analysis
for month_key in months_to_analyze:
    results = monthly_results[month_key]
    month_display = datetime.strptime(month_key, '%Y-%m').strftime('%B %Y').upper()

    print(f"\n{month_display}")
    print("-" * 150)

    print(f"REPORT (arch):                {results['report_rows']:6d} rows  |  {results['report_unique_ids']:5d} unique SOURCE_IDs  |  Net total: {results['report_net_total']:15.2f}")
    print(f"LIBERACIONES:                 {results['lib_rows']:6d} rows  |  {results['lib_descriptions']}")
    print(f"  Definitive (payment/payout/asset):    {results['lib_definitive_count']:6d}  |  {results['lib_definitive_ids']:5d} unique IDs  |  Net total: {results['lib_definitive_net_total']:15.2f}")
    print(f"  RAW-only (reserve):                   {results['lib_raw_only_count']:6d}")
    print(f"    - Payout:         {results['payout_count']:6d}  |  Net: {results['payout_total']:15.2f}")
    print(f"    - Asset management: {results['asset_mgmt_count']:6d}")
    print(f"    - Payment:        {results['payment_count']:6d}")

    print(f"\nCROSS-SOURCE:")
    print(f"  Shared SOURCE_IDs:            {results['shared_ids']:6d}")
    print(f"  Report-only:                  {results['report_only_ids']:6d}")
    print(f"  Liberaciones-only:            {results['lib_only_ids']:6d}")

    # Expected ledger if only using report
    print(f"\nEXPECTED LEDGER (report only):  {results['report_net_total']:15.2f}")

    # Expected ledger if adding liberaciones definitives
    expected_with_lib = results['report_net_total'] + results['lib_definitive_net_total']
    print(f"EXPECTED LEDGER (report + lib definitives):  {expected_with_lib:15.2f}")

    # Difference
    lib_exclusive_net = results['lib_definitive_net_total']
    print(f"LIBERACIONES-EXCLUSIVE NET:    {lib_exclusive_net:15.2f}  ({results['lib_definitive_count']} rows)")
    print()

# Summary table
print("\n" + "=" * 150)
print("SUMMARY TABLE")
print("=" * 150)
print()

header = "MONTH      | REPORT_ROWS | LIB_ROWS | SHARED_IDS | REPORT_ONLY | LIB_ONLY_DEF | PAYOUT_COUNT | PAYOUT_NET         | REPORT_NET         | EXPECTED_WITH_LIB"
print(header)
print("-" * 150)

for month_key in months_to_analyze:
    results = monthly_results[month_key]
    month_display = month_key

    row = f"{month_display} | {results['report_rows']:11d} | {results['lib_rows']:8d} | {results['shared_ids']:10d} | {results['report_only_ids']:11d} | {results['lib_definitive_count']:12d} | {results['payout_count']:12d} | {results['payout_total']:18.2f} | {results['report_net_total']:18.2f} | {results['report_net_total'] + results['lib_definitive_net_total']:16.2f}"
    print(row)

# Final analysis
print("\n" + "=" * 150)
print("JANUARY 2026")
print("=" * 150)
print("NEEDS_EXTERNAL_REPORT")
print("(No local CSV covers January 2026)")
print()

print("=" * 150)
print("ANALYSIS SUMMARY")
print("=" * 150)
print()

months_with_payout_only = [m for m in months_to_analyze if monthly_results[m]['payout_count'] > 0]
months_with_lib_exclusive = [m for m in months_to_analyze if monthly_results[m]['lib_definitive_count'] > 0]
months_without_lib = [m for m in months_to_analyze if monthly_results[m]['lib_rows'] == 0]

print(f"MONTHS WITH PAYOUTS ONLY IN LIBERACIONES:     {', '.join(months_with_payout_only) if months_with_payout_only else 'NONE'}")
print(f"MONTHS WITH LIBERACIONES EXCLUSIVE COVERAGE:  {', '.join(months_with_lib_exclusive) if months_with_lib_exclusive else 'NONE'}")
print(f"MONTHS WITHOUT LIBERACIONES DATA:             {', '.join(months_without_lib) if months_without_lib else 'NONE'}")
print()

print("COVERAGE RECOMMENDATIONS:")
print("- JANUARY:    NEEDS_EXTERNAL_REPORT (no local CSV)")
print("- FEBRUARY:   Report available, Liberaciones available (compare coverage)")
print("- MARCH:      Report available, Liberaciones available (compare coverage)")
print("- APRIL:      Report available, Liberaciones available (compare coverage)")
print("- MAY:        Report available, Liberaciones available (compare coverage)")
print("- JUNE:       Report available, Liberaciones available (compare coverage)")
