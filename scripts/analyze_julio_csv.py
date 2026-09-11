#!/usr/bin/env python3
"""
Analyze JULIO CSV for problematic rows:
1. Blank SOURCE_ID or DESCRIPTION
2. Duplicate SOURCE_IDs and their patterns
"""

import csv
from collections import Counter, defaultdict

CSV_FILE = 'data/mercadopago/Liberaciones3_julio_2026.csv'

print(f"Leyendo {CSV_FILE}...\n")

rows = []
with open(CSV_FILE, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f, delimiter=';')
    for i, row in enumerate(reader, start=2):  # start=2 porque 1 es header
        rows.append((i, row))

print(f"Total filas: {len(rows)}\n")

# Find blank rows
print("=" * 80)
print("BLOQUE 2 — FILAS BLANK")
print("=" * 80)

blank_rows = []
for line_no, row in rows:
    source_id = row.get('SOURCE_ID', '').strip()
    desc = row.get('DESCRIPTION', '').strip()

    if not source_id or not desc:
        blank_rows.append((line_no, row))

if blank_rows:
    print(f"\nEncontradas {len(blank_rows)} fila(s) con SOURCE_ID o DESCRIPTION blank:\n")
    for line_no, row in blank_rows:
        print(f"Fila CSV #{line_no}:")
        print(f"  DATE: {row.get('DATE', '')}")
        print(f"  SOURCE_ID: [{row.get('SOURCE_ID', '').strip()}] (vacio={not row.get('SOURCE_ID', '').strip()})")
        print(f"  DESCRIPTION: [{row.get('DESCRIPTION', '').strip()}] (vacio={not row.get('DESCRIPTION', '').strip()})")
        print(f"  NET_CREDIT_AMOUNT: {row.get('NET_CREDIT_AMOUNT', '')}")
        print(f"  NET_DEBIT_AMOUNT: {row.get('NET_DEBIT_AMOUNT', '')}")
        print(f"  GROSS_AMOUNT: {row.get('GROSS_AMOUNT', '')}")
        print(f"  BALANCE_AMOUNT: {row.get('BALANCE_AMOUNT', '')}")
        print(f"  PAYMENT_METHOD: {row.get('PAYMENT_METHOD', '')}")
        print(f"  PURCHASE_ID: {row.get('PURCHASE_ID', '')}")

        # Check if opening/checkpoint
        date = row.get('DATE', '')
        balance = row.get('BALANCE_AMOUNT', '')
        source_id = row.get('SOURCE_ID', '')
        desc = row.get('DESCRIPTION', '')

        is_opening = (
            date.startswith('2026-07-04') and
            balance in ['5080770.69', '5,080,770.69'] and
            not source_id and
            not desc
        )
        print(f"  es opening/checkpoint (2026-07-04, balance=5,080,770.69): {is_opening}\n")
else:
    print("No hay filas con SOURCE_ID blank")

# Find duplicate SOURCE_IDs
print("=" * 80)
print("BLOQUE 3 — SOURCE_IDs REPETIDOS (TODOS, incluyendo RAW-only)")
print("=" * 80)

# Extract ALL rows (not just definitives)
# Count SOURCE_IDs for ALL rows
source_id_counts_all = Counter()
source_id_map_all = defaultdict(list)  # source_id -> [(line_no, row, desc)]

for line_no, row in rows:
    source_id = row.get('SOURCE_ID', '').strip()
    if source_id:  # Only count non-blank
        source_id_counts_all[source_id] += 1
        desc = row.get('DESCRIPTION', '').strip()
        source_id_map_all[source_id].append((line_no, row, desc))

# Find all duplicates (ANY description)
duplicates_all = {sid: count for sid, count in source_id_counts_all.items() if count > 1}

print(f"\nTODOS los SOURCE_ID repetidos: {len(duplicates_all)}")
print(f"Total filas con SOURCE_ID repetido: {sum(duplicates_all.values())}\n")

# Now also analyze ONLY definitives
definitive_rows = [(line_no, row) for line_no, row in rows
                   if row.get('DESCRIPTION', '').strip() in ('payment', 'asset_management', 'payout')]

# Count SOURCE_IDs in definitives
source_id_counts = Counter()
source_id_map = defaultdict(list)  # source_id -> [(line_no, row, desc, balance)]

for line_no, row in definitive_rows:
    source_id = row.get('SOURCE_ID', '').strip()
    if source_id:
        source_id_counts[source_id] += 1
        desc = row.get('DESCRIPTION', '').strip()
        balance = float(row.get('NET_CREDIT_AMOUNT', 0) or 0) - float(row.get('NET_DEBIT_AMOUNT', 0) or 0)
        source_id_map[source_id].append((line_no, row, desc, balance))

# Find duplicates
duplicates = {sid: count for sid, count in source_id_counts.items() if count > 1}

print(f"\nSOURCE_ID repetidos: {len(duplicates)}")
print(f"Total de IDs con duplicados: {sum(duplicates.values())}\n")

if duplicates:
    # Categorize duplicates
    metadata_only = 0  # reserve→definitive or same payload
    reserve_to_def = 0
    mult_def_same_impact = 0
    mult_def_diff_impact = 0
    problematic = []

    for source_id in sorted(duplicates.keys()):
        versions = source_id_map[source_id]
        print(f"\n{source_id}: {len(versions)} versiones")

        descs = [v[2] for v in versions]
        balances = [v[3] for v in versions]

        # Check if reserve→definitive
        has_reserve = any(d in ('reserve_for_payment', 'reserve_for_payout') for d in descs)
        has_definitive = any(d in ('payment', 'asset_management', 'payout') for d in descs)

        definitive_count = sum(1 for d in descs if d in ('payment', 'asset_management', 'payout'))

        print(f"  DESCRIPTIONs: {descs}")
        print(f"  Balances: {balances}")
        print(f"  Definitivas: {definitive_count}")

        if definitive_count == 0:
            print(f"  Categoría: reserve-only")
            metadata_only += 1
        elif definitive_count == 1 and has_reserve:
            print(f"  Categoría: reserve→definitive")
            reserve_to_def += 1
        elif definitive_count > 1:
            # Multiple definitives
            def_balances = [b for d, b in zip(descs, balances) if d in ('payment', 'asset_management', 'payout')]
            if all(abs(b - def_balances[0]) < 0.01 for b in def_balances):
                print(f"  Categoría: múltiples definitivas MISMO impacto")
                mult_def_same_impact += 1
            else:
                print(f"  Categoría: múltiples definitivas DISTINTO impacto *** PROBLEMA ***")
                mult_def_diff_impact += 1
                for i, (line_no, row, desc, balance) in enumerate(versions):
                    if desc in ('payment', 'asset_management', 'payout'):
                        print(f"    v{i+1} (fila {line_no}): {desc} balance={balance}")
                problematic.append((source_id, versions))
        else:
            print(f"  Categoría: metadata-only")
            metadata_only += 1

    print(f"\n\nRESUMEN DUPLICADOS:")
    print(f"  Metadata-only: {metadata_only}")
    print(f"  Reserve→definitive: {reserve_to_def}")
    print(f"  Múltiples definitivas MISMO impacto: {mult_def_same_impact}")
    print(f"  Múltiples definitivas DISTINTO impacto: {mult_def_diff_impact} *** PROBLEMÁTICOS ***")

    if problematic:
        print(f"\nPROBLEMÁTICOS (múltiples definitivas con distinto impacto):")
        for source_id, versions in problematic:
            print(f"  {source_id}:")
            for line_no, row, desc, balance in versions:
                print(f"    Fila {line_no}: {desc} balance={balance}")

print("\n" + "=" * 80)
