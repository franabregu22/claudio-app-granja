#!/usr/bin/env python3
import csv
from collections import defaultdict

print("=" * 100)
print("JUNE DECISION PACK (CORRECTED) - DATABASE SOURCE OF TRUTH")
print("=" * 100)
print()

# STEP 1: READ LIBERACIONES DEFINITIVE ROWS FOR JUNE
print("STEP 1: LIBERACIONES DEFINITIVE ROWS")
print("-" * 100)

lib_file = "data/mercadopago/Liberaciones2.csv"
lib_definitive = []
lib_raw_only = []
desc_summary = defaultdict(lambda: {'count': 0, 'net': 0})

with open(lib_file, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('DATE', '').strip()
        date_part = date_str.split('T')[0] if 'T' in date_str else date_str

        if date_part.startswith('2026-06'):
            desc = row.get('DESCRIPTION', '').strip()
            source_id = row.get('SOURCE_ID', '').strip()
            credit = float(row.get('NET_CREDIT_AMOUNT', '0').replace(',', '.') or 0)
            debit = float(row.get('NET_DEBIT_AMOUNT', '0').replace(',', '.') or 0)
            net = credit - debit

            row_data = {
                'date': date_part,
                'source_id': source_id,
                'description': desc,
                'credit': credit,
                'debit': debit,
                'net': net
            }

            if desc in ['payment', 'payout', 'asset_management']:
                lib_definitive.append(row_data)
            elif desc in ['reserve_for_payment', 'reserve_for_payout']:
                lib_raw_only.append(row_data)

            desc_summary[desc]['count'] += 1
            desc_summary[desc]['net'] += net

print(f"Total Liberaciones June rows: {len(lib_definitive) + len(lib_raw_only)}")
print()
print("CLASSIFICATION:")
print(f"  DEFINITIVE (payment + payout + asset_management): {len(lib_definitive)}")
print(f"    payment: {desc_summary['payment']['count']} (net: {desc_summary['payment']['net']:,.2f})")
print(f"    payout: {desc_summary['payout']['count']} (net: {desc_summary['payout']['net']:,.2f})")
print(f"    asset_management: {desc_summary['asset_management']['count']} (net: {desc_summary['asset_management']['net']:,.2f})")
print()
print(f"  RAW-ONLY (reserves): {len(lib_raw_only)}")
print(f"    reserve_for_payment: {desc_summary['reserve_for_payment']['count']}")
print(f"    reserve_for_payout: {desc_summary['reserve_for_payout']['count']}")
print()

# Group definitive by source_id
lib_by_source = defaultdict(list)
for row in lib_definitive:
    if row['source_id']:
        lib_by_source[row['source_id']].append(row)

print(f"Unique SOURCE_IDs in definitive rows: {len(lib_by_source)}")
print()

# STEP 2: KNOWN JUNE DATABASE BASELINE
print("=" * 100)
print("STEP 2: KNOWN JUNE DATABASE BASELINE (PRODUCTION STATE)")
print("-" * 100)
print()

known_baseline = {
    'fm_count': 680,
    'ledger_count': 680,
    'ledger_net': 12343127.31,
    'report_sr_count': 682,
    'needs_review': 2
}

print("Confirmed production baseline (Report-imported data):")
print(f"  Financial movements: {known_baseline['fm_count']}")
print(f"  Ledger entries: {known_baseline['ledger_count']}")
print(f"  Ledger net: {known_baseline['ledger_net']:,.2f}")
print(f"  Report source records: {known_baseline['report_sr_count']}")
print(f"  Needs review: {known_baseline['needs_review']}")
print()

# STEP 3: CLASSIFICATION FRAMEWORK
print("=" * 100)
print("STEP 3: CLASSIFICATION FRAMEWORK")
print("-" * 100)
print()
print("For each definitive Liberaciones row, classify as:")
print("  A. EXACT_SHARED: Same SOURCE_ID in Report, 1:1 mapping, same net impact")
print("  B. AMBIGUOUS_SHARED: Same SOURCE_ID but multiple candidates or structure mismatch")
print("  C. LIBERACIONES_ONLY: Definitive row with no Report equivalent")
print("  D. REPORT_ONLY: Report row with no Liberaciones equivalent")
print()

# STEP 4: EXCEPTION ANALYSIS
print("=" * 100)
print("STEP 4: DETAILED EXCEPTION ANALYSIS")
print("-" * 100)
print()

exception_cases = {
    '1745105363064': 'asset_management',
    '1745058376008': 'asset_management',
    '163606899930': 'payment',
    '162458726007': 'payment'
}

for source_id in exception_cases.keys():
    print(f"SOURCE_ID: {source_id}")

    matching = lib_by_source.get(source_id, [])
    if matching:
        print(f"  Found in Liberaciones: {len(matching)} row(s)")
        total_lib_net = sum(r['net'] for r in matching)
        for i, row in enumerate(matching, 1):
            print(f"    [{i}] {row['date']} | {row['description']:20s} | net: {row['net']:12,.2f}")
        print(f"  Total net: {total_lib_net:,.2f}")
    else:
        print(f"  NOT found in Liberaciones")

    print(f"  Status in DB/Report: [REQUIRES DB QUERY]")
    print()

# STEP 5: REQUIRED DB QUERIES
print("=" * 100)
print("STEP 5: REQUIRED DB QUERIES")
print("-" * 100)
print()
print("Execute in Supabase SQL Editor:")
print()
print("QUERY 1: JUNE REPORT BASELINE CONFIRMATION")
print()
print("""
SELECT
  COUNT(DISTINCT msr.id) as report_sr_count,
  COUNT(DISTINCT mmsl.id) as report_links_count,
  COUNT(DISTINCT mfm.id) as report_fm_count,
  COUNT(DISTINCT le.id) as report_ledger_count,
  COALESCE(SUM(le.balance_impact), 0) as report_ledger_net,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND needs_review = TRUE) as total_needs_review
FROM mp_source_record msr
INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
LEFT JOIN ledger_entry le ON mfm.id = le.financial_movement_id
WHERE msr.source_type = 'report'
  AND mfm.account_id = 1054315166
  AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30';
""")

print()
print("QUERY 2: FOR EACH EXCEPTION SOURCE_ID:")
print()
print("""
SELECT
  msr.source_external_id,
  COUNT(DISTINCT msr.id) as source_record_count,
  COUNT(DISTINCT mfm.id) as financial_movement_count,
  COUNT(DISTINCT le.id) as ledger_entry_count,
  COALESCE(SUM(le.balance_impact), 0) as ledger_balance_impact
FROM mp_source_record msr
LEFT JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
LEFT JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
LEFT JOIN ledger_entry le ON mfm.id = le.financial_movement_id
WHERE msr.source_external_id IN ('1745105363064', '1745058376008', '163606899930', '162458726007')
GROUP BY msr.source_external_id;
""")

print()
print("Provide query results to complete JUNE DECISION PACK.")
