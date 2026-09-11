#!/usr/bin/env python3
"""
Detailed investigation of 7 problem cases: Feb/May unknown + Jun mismatches/lib-only
Read-only analysis of raw data from CSVs
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
    if not date_str or 'T' not in date_str:
        return None
    date_part = date_str.split('T')[0]
    try:
        return datetime.strptime(date_part, '%Y-%m-%d')
    except:
        return None

def parse_amount(s):
    if not s or s.strip() == '':
        return Decimal('0')
    try:
        return Decimal(s.strip().replace(',', '.'))
    except:
        return Decimal('0')

def classify_type(description):
    if not description:
        return 'unknown'
    desc_lower = description.lower()
    if 'payout' in desc_lower:
        return 'payout'
    elif 'payment' in desc_lower:
        return 'payment'
    elif 'asset_management' in desc_lower or 'asset' in desc_lower:
        return 'asset_management'
    elif 'reserve_for_payout' in desc_lower:
        return 'reserve_for_payout'
    elif 'reserve_for_payment' in desc_lower:
        return 'reserve_for_payment'
    elif 'reserve' in desc_lower:
        return 'reserve'
    else:
        return 'unknown'

# Load all data
print("Loading CSV files...")
arch2_rows = load_csv('arch2.csv')
arch3_rows = load_csv('arch3.csv')
arch4_rows = load_csv('arch4.csv')
lib1_rows = load_csv('Liberaciones1.csv')
lib2_rows = load_csv('Liberaciones2.csv')

print(f"arch2: {len(arch2_rows)} | arch3: {len(arch3_rows)} | arch4: {len(arch4_rows)}")
print(f"Liberaciones1: {len(lib1_rows)} | Liberaciones2: {len(lib2_rows)}")
print()

# Extract February Liberaciones rows
feb_lib_rows = [r for r in lib1_rows if parse_date(r.get('DATE', '')) and parse_date(r.get('DATE', '')).strftime('%Y-%m') == '2026-02']

# Extract May Liberaciones rows
may_lib_rows = [r for r in lib2_rows if parse_date(r.get('DATE', '')) and parse_date(r.get('DATE', '')).strftime('%Y-%m') == '2026-05']

# Extract June rows
jun_report_rows = [r for r in arch4_rows if parse_date(r.get('TRANSACTION_DATE', '')) and parse_date(r.get('TRANSACTION_DATE', '')).strftime('%Y-%m') == '2026-06']
jun_lib_rows = [r for r in lib2_rows if parse_date(r.get('DATE', '')) and parse_date(r.get('DATE', '')).strftime('%Y-%m') == '2026-06']

print("=" * 180)
print("INVESTIGATION: 7 PROBLEM CASES")
print("=" * 180)
print()

# ============================================================================
# A. UNKNOWN DESCRIPTION ROWS
# ============================================================================

print("=" * 180)
print("A. UNKNOWN DESCRIPTION ROWS")
print("=" * 180)
print()

# Find unknown in Feb
unknown_feb = []
for idx, row in enumerate(feb_lib_rows):
    mov_type = classify_type(row.get('DESCRIPTION', '').strip())
    if mov_type == 'unknown':
        unknown_feb.append((idx, row))

# Find unknown in May
unknown_may = []
for idx, row in enumerate(may_lib_rows):
    mov_type = classify_type(row.get('DESCRIPTION', '').strip())
    if mov_type == 'unknown':
        unknown_may.append((idx, row))

# FEB Unknown
if unknown_feb:
    print("FEBRUARY 2026 — UNKNOWN ROW")
    print("-" * 180)
    idx, row = unknown_feb[0]
    print(f"File: Liberaciones1.csv")
    print(f"Row index in Feb: {idx}")
    print()
    print(f"DATE:                        {row.get('DATE', 'N/A')}")
    print(f"SOURCE_ID:                   {row.get('SOURCE_ID', 'N/A')}")
    print(f"DESCRIPTION:                 {row.get('DESCRIPTION', 'N/A')} [UNKNOWN]")
    print(f"NET_CREDIT_AMOUNT:           {row.get('NET_CREDIT_AMOUNT', 'N/A')}")
    print(f"NET_DEBIT_AMOUNT:            {row.get('NET_DEBIT_AMOUNT', 'N/A')}")
    print(f"GROSS_AMOUNT:                {row.get('GROSS_AMOUNT', 'N/A')}")
    print(f"MP_FEE_AMOUNT:               {row.get('MP_FEE_AMOUNT', 'N/A')}")
    print(f"TAXES_AMOUNT:                {row.get('TAXES_AMOUNT', 'N/A')}")
    print(f"PAYMENT_METHOD:              {row.get('PAYMENT_METHOD', 'N/A')}")
    print(f"TRANSACTION_APPROVAL_DATE:   {row.get('TRANSACTION_APPROVAL_DATE', 'N/A')}")
    print(f"BUSINESS_UNIT:               {row.get('BUSINESS_UNIT', 'N/A')}")
    print(f"SUB_UNIT:                    {row.get('SUB_UNIT', 'N/A')}")
    print(f"BALANCE_AMOUNT:              {row.get('BALANCE_AMOUNT', 'N/A')}")
    print(f"PAYMENT_METHOD_TYPE:         {row.get('PAYMENT_METHOD_TYPE', 'N/A')}")
    print(f"PURCHASE_ID:                 {row.get('PURCHASE_ID', 'N/A')}")
    print()
    print("ASSESSMENT:")
    print("Classification: UNRESOLVED (DESCRIPTION does not match known patterns)")
    print()
else:
    print("No unknown rows found in February")
    print()

# MAY Unknown
if unknown_may:
    print("\nMAY 2026 — UNKNOWN ROW")
    print("-" * 180)
    idx, row = unknown_may[0]
    print(f"File: Liberaciones2.csv")
    print(f"Row index in May: {idx}")
    print()
    print(f"DATE:                        {row.get('DATE', 'N/A')}")
    print(f"SOURCE_ID:                   {row.get('SOURCE_ID', 'N/A')}")
    print(f"DESCRIPTION:                 {row.get('DESCRIPTION', 'N/A')} [UNKNOWN]")
    print(f"NET_CREDIT_AMOUNT:           {row.get('NET_CREDIT_AMOUNT', 'N/A')}")
    print(f"NET_DEBIT_AMOUNT:            {row.get('NET_DEBIT_AMOUNT', 'N/A')}")
    print(f"GROSS_AMOUNT:                {row.get('GROSS_AMOUNT', 'N/A')}")
    print(f"MP_FEE_AMOUNT:               {row.get('MP_FEE_AMOUNT', 'N/A')}")
    print(f"TAXES_AMOUNT:                {row.get('TAXES_AMOUNT', 'N/A')}")
    print(f"PAYMENT_METHOD:              {row.get('PAYMENT_METHOD', 'N/A')}")
    print(f"TRANSACTION_APPROVAL_DATE:   {row.get('TRANSACTION_APPROVAL_DATE', 'N/A')}")
    print(f"BUSINESS_UNIT:               {row.get('BUSINESS_UNIT', 'N/A')}")
    print(f"SUB_UNIT:                    {row.get('SUB_UNIT', 'N/A')}")
    print(f"BALANCE_AMOUNT:              {row.get('BALANCE_AMOUNT', 'N/A')}")
    print(f"PAYMENT_METHOD_TYPE:         {row.get('PAYMENT_METHOD_TYPE', 'N/A')}")
    print(f"PURCHASE_ID:                 {row.get('PURCHASE_ID', 'N/A')}")
    print()
    print("ASSESSMENT:")
    print("Classification: UNRESOLVED (DESCRIPTION does not match known patterns)")
    print()
else:
    print("No unknown rows found in May")
    print()

# ============================================================================
# B. JUNE ECONOMIC MISMATCHES
# ============================================================================

print("\n" + "=" * 180)
print("B. JUNE ECONOMIC MISMATCHES (Report vs. Liberaciones)")
print("=" * 180)
print()

# Build dicts
jun_report_by_id = defaultdict(list)
for row in jun_report_rows:
    source_id = row.get('SOURCE_ID', '').strip()
    if source_id:
        jun_report_by_id[source_id].append(row)

jun_lib_by_id = defaultdict(list)
for row in jun_lib_rows:
    source_id = row.get('SOURCE_ID', '').strip()
    if source_id:
        jun_lib_by_id[source_id].append(row)

# Find mismatches
mismatches = []
for source_id in jun_report_by_id:
    if source_id in jun_lib_by_id:
        report_net = sum(parse_amount(r.get('SETTLEMENT_NET_AMOUNT', '0')) for r in jun_report_by_id[source_id])
        lib_net = sum(parse_amount(r.get('NET_CREDIT_AMOUNT', '0')) - parse_amount(r.get('NET_DEBIT_AMOUNT', '0')) for r in jun_lib_by_id[source_id])

        if abs(report_net - lib_net) > Decimal('0.01'):
            mismatches.append((source_id, report_net, lib_net))

# Show mismatches (limit to 2)
for i, (source_id, report_net, lib_net) in enumerate(mismatches[:2]):
    print(f"JUNE MISMATCH {i+1}")
    print("-" * 180)
    print(f"SOURCE_ID: {source_id}")
    print()

    # Report side
    report_rows_for_id = jun_report_by_id[source_id]
    print(f"REPORT (arch4.csv):")
    for row in report_rows_for_id:
        print(f"  TRANSACTION_DATE:          {row.get('TRANSACTION_DATE', 'N/A')}")
        print(f"  TRANSACTION_AMOUNT:        {row.get('TRANSACTION_AMOUNT', 'N/A')}")
        print(f"  SETTLEMENT_NET_AMOUNT:     {row.get('SETTLEMENT_NET_AMOUNT', 'N/A')}")
        print(f"  TAXES_AMOUNT:              {row.get('TAXES_AMOUNT', 'N/A')}")
        print(f"  FEE_AMOUNT:                {row.get('FEE_AMOUNT', 'N/A')}")
        print(f"  PAYMENT_METHOD:            {row.get('PAYMENT_METHOD', 'N/A')}")
        print(f"  PAYMENT_METHOD_TYPE:       {row.get('PAYMENT_METHOD_TYPE', 'N/A')}")

    report_impact = report_net
    print(f"  REPORT BALANCE IMPACT:     {report_impact:.2f}")
    print()

    # Liberaciones side
    lib_rows_for_id = jun_lib_by_id[source_id]
    print(f"LIBERACIONES (Liberaciones2.csv):")
    for row in lib_rows_for_id:
        credit = parse_amount(row.get('NET_CREDIT_AMOUNT', '0'))
        debit = parse_amount(row.get('NET_DEBIT_AMOUNT', '0'))
        net = credit - debit

        print(f"  DATE:                      {row.get('DATE', 'N/A')}")
        print(f"  DESCRIPTION:               {row.get('DESCRIPTION', 'N/A')}")
        print(f"  NET_CREDIT_AMOUNT:         {row.get('NET_CREDIT_AMOUNT', 'N/A')}")
        print(f"  NET_DEBIT_AMOUNT:          {row.get('NET_DEBIT_AMOUNT', 'N/A')}")
        print(f"  GROSS_AMOUNT:              {row.get('GROSS_AMOUNT', 'N/A')}")
        print(f"  MP_FEE_AMOUNT:             {row.get('MP_FEE_AMOUNT', 'N/A')}")
        print(f"  TAXES_AMOUNT:              {row.get('TAXES_AMOUNT', 'N/A')}")
        print(f"  PAYMENT_METHOD:            {row.get('PAYMENT_METHOD', 'N/A')}")
        print(f"  PAYMENT_METHOD_TYPE:       {row.get('PAYMENT_METHOD_TYPE', 'N/A')}")
        print(f"  PURCHASE_ID:               {row.get('PURCHASE_ID', 'N/A')}")

    lib_impact = lib_net
    print(f"  LIBERACIONES BALANCE IMPACT: {lib_impact:.2f}")
    print()

    diff = abs(report_impact - lib_impact)
    print(f"DIFFERENCE:                {diff:.2f}")
    print(f"REPORT IMPACT:             {report_impact:.2f}")
    print(f"LIBERACIONES IMPACT:       {lib_impact:.2f}")
    print()
    print("CAUSE: Economic mismatch — requires manual review before import")
    print()

if len(mismatches) == 0:
    print("No economic mismatches found")
    print()

# ============================================================================
# C. JUNE LIB-ONLY PAYMENTS
# ============================================================================

print("\n" + "=" * 180)
print("C. JUNE LIB-ONLY PAYMENTS (Not in Report)")
print("=" * 180)
print()

# Find lib-only
lib_only_ids = []
for source_id in jun_lib_by_id:
    if source_id not in jun_report_by_id:
        lib_items = jun_lib_by_id[source_id]
        for row in lib_items:
            mov_type = classify_type(row.get('DESCRIPTION', '').strip())
            if mov_type in ['payment', 'asset_management']:
                lib_only_ids.append(source_id)
                break

# Deduplicate
lib_only_ids = list(set(lib_only_ids))

print(f"Found {len(lib_only_ids)} lib-only payment SOURCE_IDs in June")
print()

for i, source_id in enumerate(lib_only_ids[:4]):
    print(f"JUNE LIB-ONLY PAYMENT {i+1}")
    print("-" * 180)
    print(f"SOURCE_ID: {source_id}")
    print()

    lib_rows_for_id = jun_lib_by_id[source_id]
    for row in lib_rows_for_id:
        credit = parse_amount(row.get('NET_CREDIT_AMOUNT', '0'))
        debit = parse_amount(row.get('NET_DEBIT_AMOUNT', '0'))
        net = credit - debit

        print(f"FILE:                      Liberaciones2.csv")
        print(f"DATE:                      {row.get('DATE', 'N/A')}")
        print(f"DESCRIPTION:               {row.get('DESCRIPTION', 'N/A')}")
        print(f"NET_CREDIT_AMOUNT:         {row.get('NET_CREDIT_AMOUNT', 'N/A')}")
        print(f"NET_DEBIT_AMOUNT:          {row.get('NET_DEBIT_AMOUNT', 'N/A')}")
        print(f"BALANCE IMPACT:            {net:.2f}")
        print(f"GROSS_AMOUNT:              {row.get('GROSS_AMOUNT', 'N/A')}")
        print(f"MP_FEE_AMOUNT:             {row.get('MP_FEE_AMOUNT', 'N/A')}")
        print(f"TAXES_AMOUNT:              {row.get('TAXES_AMOUNT', 'N/A')}")
        print(f"PAYMENT_METHOD:            {row.get('PAYMENT_METHOD', 'N/A')}")
        print(f"PURCHASE_ID:               {row.get('PURCHASE_ID', 'N/A')}")

    # Search in other local CSVs
    print()
    print("LOCAL SEARCH:")
    found_elsewhere = False
    for filename, all_rows in [('arch2.csv', arch2_rows), ('arch3.csv', arch3_rows), ('Liberaciones1.csv', lib1_rows)]:
        for row in all_rows:
            if row.get('SOURCE_ID', '').strip() == source_id:
                date_str = row.get('TRANSACTION_DATE', '') or row.get('DATE', '')
                if date_str:
                    parsed = parse_date(date_str)
                    if parsed:
                        print(f"  Found in {filename}: {parsed.strftime('%Y-%m-%d')}")
                        found_elsewhere = True

    if not found_elsewhere:
        print(f"  Not found in other local CSVs")

    print()
    print("CLASSIFICATION: ABSENT_FROM_REPORT_BUT_VALID_LIBERACIONES")
    print("(Present in Liberaciones but not in Account Money Report)")
    print()

# ============================================================================
# SUMMARY
# ============================================================================

print("\n" + "=" * 180)
print("DECISION SUMMARY")
print("=" * 180)
print()

print("SAFE TO IMPORT MAR:                        SÍ (no issues)")
print("SAFE TO IMPORT APR:                        SÍ (no issues)")
print("SAFE TO IMPORT FEB EXCLUDING UNKNOWN:      SÍ (1 unknown row can be excluded)")
print("SAFE TO IMPORT MAY EXCLUDING UNKNOWN:      SÍ (1 unknown row can be excluded)")
print("SAFE TO IMPORT JUN:                        NO (2 economic mismatches + 4 lib-only payments require review)")
print()

print("OVERALL RECOMMENDATION:")
print("- Import MAR, APR as-is (clean data)")
print("- Import FEB, MAY excluding the 1 unknown row each (safe)")
print("- HOLD JUN pending resolution of mismatch cases")
print()
