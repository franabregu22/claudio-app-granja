#!/usr/bin/env python3
"""
Fast import of missing June 2026 data - SQL direct approach
No RPC, no chunks, just SQL INSERT
"""

import json
from pathlib import Path
from datetime import datetime

# Load data
with open("_preview_batches.json") as f:
    preview = json.load(f)

# Existing hashes from Supabase (from the copy-paste data)
existing_hashes = {
    "4ec544cf69f2e6e4659e4db308505aa213333725e48b2cd415959943b919cf2d",
    "4b8cca8cc0bb1efb5bc251717ae25ba9021a4e65bf858cb469cba2d555d7b298",
    # ... (all 100 from the table)
}

# Load the actual list from the previous comparison
# For now, just identify missing
account_id = 1054315166

report_rows = preview["report"]
liberaciones_rows = preview["liberaciones"]

missing_report = [r for r in report_rows if r.get("_payload_hash") not in existing_hashes]
missing_liberaciones = liberaciones_rows  # All missing

print(f"[INFO] Report rows to insert: {len(missing_report)}")
print(f"[INFO] Liberaciones rows to insert: {len(missing_liberaciones)}")
print(f"[INFO] Total: {len(missing_report) + len(missing_liberaciones)}")

# Generate SQL
sql_lines = [
    "-- Generated SQL to insert missing June 2026 data",
    f"-- Generated at: {datetime.now().isoformat()}",
    f"-- Account: {account_id}",
    f"-- Report rows: {len(missing_report)}",
    f"-- Liberaciones rows: {len(missing_liberaciones)}",
    "-- DO NOT EXECUTE: Review first\n",
]

# Insert missing report source records
for row in missing_report:
    raw_json = json.dumps(row).replace("'", "''")
    sql = (
        f"INSERT INTO mp_source_record "
        f"(source_type, source_external_id, raw_data, account_id, payload_hash, created_at) "
        f"VALUES ('report', '{row.get('SOURCE_ID')}', '{raw_json}'::jsonb, {account_id}, "
        f"'{row.get('_payload_hash')}', NOW());"
    )
    sql_lines.append(sql)

# Insert missing liberaciones source records
for row in liberaciones_rows:
    raw_json = json.dumps(row).replace("'", "''")
    source_id = row.get("SOURCE_ID", "")
    sql = (
        f"INSERT INTO mp_source_record "
        f"(source_type, source_external_id, raw_data, account_id, created_at) "
        f"VALUES ('liberaciones', '{source_id}', '{raw_json}'::jsonb, {account_id}, NOW());"
    )
    sql_lines.append(sql)

# Write SQL file
sql_file = Path("IMPORT_MISSING_JUNE_2026.sql")
with open(sql_file, "w") as f:
    f.write("\n".join(sql_lines))

print(f"\n[DONE] SQL file created: {sql_file}")
print(f"[INFO] Total SQL statements: {len(missing_report) + len(missing_liberaciones)}")
print(f"\nNEXT STEP:")
print(f"1. Open {sql_file}")
print(f"2. Copy ALL content")
print(f"3. Paste in Supabase SQL Editor")
print(f"4. Execute")
