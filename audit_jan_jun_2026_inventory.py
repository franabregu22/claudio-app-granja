#!/usr/bin/env python3
"""
Audit CSV files in data/mercadopago/ to inventory all months coverage
Read-only analysis: no modifications to files or database
Uses only standard library (csv, datetime, os, collections)
"""

import csv
import os
import sys
from datetime import datetime
from collections import defaultdict

# Force UTF-8 output on Windows
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

data_dir = "data/mercadopago"
csv_files = [f for f in os.listdir(data_dir) if f.endswith('.csv')]

print("=" * 120)
print("MERCADO PAGO CSV AUDIT: DETAILED FILE INVENTORY")
print("=" * 120)
print()

# Data structure per file
file_info = {}

for csv_file in sorted(csv_files):
    filepath = os.path.join(data_dir, csv_file)

    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            # Detect delimiter
            sample = f.read(1024)
            f.seek(0)
            delimiter = ';' if ';' in sample else ','

            reader = csv.DictReader(f, delimiter=delimiter)
            rows = list(reader)

        if not rows:
            print(f"[SKIP] {csv_file} — EMPTY FILE")
            continue

        # Get columns
        cols = [col.strip() for col in rows[0].keys() if col and col.strip()]

        # Find date column
        date_cols = [col for col in cols if any(x in col.lower() for x in ['fecha', 'date', 'date_'])]

        if not date_cols:
            print(f"[SKIP] {csv_file} — NO DATE COLUMN FOUND")
            continue

        date_col = date_cols[0]

        # Parse all dates
        dates_by_row = []
        for idx, row in enumerate(rows):
            date_str = row.get(date_col, '').strip() if date_col in row else ''
            if not date_str:
                dates_by_row.append(None)
                continue

            # Extract date part if ISO 8601 with timestamp
            if 'T' in date_str:
                date_str = date_str.split('T')[0]

            parsed = None
            for fmt in ['%Y-%m-%d', '%d/%m/%Y', '%m/%d/%Y', '%Y/%m/%d']:
                try:
                    parsed = datetime.strptime(date_str, fmt)
                    break
                except ValueError:
                    continue

            dates_by_row.append(parsed)

        valid_dates = [d for d in dates_by_row if d is not None]
        if not valid_dates:
            print(f"[SKIP] {csv_file} — COULD NOT PARSE DATES FROM COLUMN '{date_col}'")
            continue

        min_date = min(valid_dates)
        max_date = max(valid_dates)

        # Count rows by month
        month_counts = defaultdict(int)
        for d in valid_dates:
            month_key = f"{d.year:04d}-{d.month:02d}"
            month_counts[month_key] += 1

        # Infer source type
        cols_lower = [c.lower() for c in cols]
        if any('liberaciones' in c or 'liberación' in c for c in cols_lower):
            source_type = 'liberaciones'
        elif any('report' in c or 'reporte' in c for c in cols_lower):
            source_type = 'report'
        else:
            source_type = 'unknown'

        # Count unique SOURCE_ID if exists
        id_cols = [col for col in cols if 'source_id' in col.lower() or ('id' in col.lower() and col != col.upper())]
        source_ids = set()
        if id_cols:
            id_col = id_cols[0]
            for row in rows:
                val = row.get(id_col, '').strip() if id_col in row else ''
                if val:
                    source_ids.add(val)

        # Count DESCRIPTION types if Liberaciones
        descriptions = defaultdict(int)
        if source_type == 'liberaciones':
            desc_cols = [col for col in cols if 'description' in col.lower() or 'descripcion' in col.lower()]
            if desc_cols:
                desc_col = desc_cols[0]
                for row in rows:
                    val = row.get(desc_col, '').strip() if desc_col in row else ''
                    if val:
                        descriptions[val] += 1

        # Store info
        file_info[csv_file] = {
            'rows': len(rows),
            'date_column': date_col,
            'min_date': min_date,
            'max_date': max_date,
            'month_counts': dict(month_counts),
            'source_type': source_type,
            'source_ids': source_ids,
            'descriptions': dict(descriptions),
            'all_dates': valid_dates,
        }

        print(f"[OK] {csv_file}")
        print(f"  Total rows: {len(rows)}")
        print(f"  Date column: {date_col}")
        print(f"  Date range: {min_date.date()} to {max_date.date()}")
        print(f"  Source type: {source_type}")
        print(f"  Unique source_ids: {len(source_ids)}")
        if descriptions:
            print(f"  Description types: {len(descriptions)} unique values")
        print()

    except Exception as e:
        print(f"[ERROR] {csv_file}: {type(e).__name__}: {str(e)[:100]}")
        print()

# ============================================================================
# MATRIX: ROWS BY MONTH BY FILE
# ============================================================================

print("\n" + "=" * 120)
print("MATRIX: ROWS PER MONTH BY FILE")
print("=" * 120)
print()

# Collect all months present
all_months = set()
for info in file_info.values():
    all_months.update(info['month_counts'].keys())
all_months = sorted(all_months)

# Print matrix header
header = "FILE" + " " * 30 + "|"
for month in all_months:
    header += f" {month} |"
print(header)
print("-" * len(header))

# Print rows
for filename in sorted(file_info.keys()):
    info = file_info[filename]
    row_str = filename[:30].ljust(30) + "|"
    for month in all_months:
        count = info['month_counts'].get(month, 0)
        row_str += f" {count:6d} |"
    print(row_str)

print()

# ============================================================================
# MARCH TRACE
# ============================================================================

print("=" * 120)
print("MARCH 2026 TRACE")
print("=" * 120)
print()

march_files = []
for filename, info in sorted(file_info.items()):
    if info['month_counts'].get('2026-03', 0) > 0:
        march_files.append((filename, info))

if march_files:
    for filename, info in march_files:
        march_count = info['month_counts']['2026-03']
        march_dates = [d for d in info['all_dates'] if d.year == 2026 and d.month == 3]
        march_min = min(march_dates) if march_dates else None
        march_max = max(march_dates) if march_dates else None
        march_source_ids = len(set(str(row) for d in march_dates for row in info['source_ids']))

        print(f"File: {filename}")
        print(f"  March 2026 rows: {march_count}")
        print(f"  March date range: {march_min.date() if march_min else 'N/A'} to {march_max.date() if march_max else 'N/A'}")
        print(f"  Unique source_ids in file: {len(info['source_ids'])}")
        print()
else:
    print("NO LOCAL CSV COVERS MARCH 2026")
    print()

# ============================================================================
# JANUARY TRACE
# ============================================================================

print("=" * 120)
print("JANUARY 2026 TRACE")
print("=" * 120)
print()

january_files = []
for filename, info in sorted(file_info.items()):
    if info['month_counts'].get('2026-01', 0) > 0:
        january_files.append((filename, info))

if january_files:
    for filename, info in january_files:
        january_count = info['month_counts']['2026-01']
        january_dates = [d for d in info['all_dates'] if d.year == 2026 and d.month == 1]
        january_min = min(january_dates) if january_dates else None
        january_max = max(january_dates) if january_dates else None

        print(f"File: {filename}")
        print(f"  January 2026 rows: {january_count}")
        print(f"  January date range: {january_min.date() if january_min else 'N/A'} to {january_max.date() if january_max else 'N/A'}")
        print(f"  Unique source_ids in file: {len(info['source_ids'])}")
        print()
else:
    print("NO LOCAL CSV COVERS JANUARY 2026")
    print()
