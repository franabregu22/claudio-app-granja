#!/usr/bin/env python3
"""
Call preview_financial_movements_reconciliation_v2 RPC and show breakdown.
"""

import json
import subprocess

# Load batches
with open('_preview_batches.json', 'r') as f:
    batches = json.load(f)

# Prepare RPC call for Report first
report_rows = batches['report']
lib_rows = batches['liberaciones']
account_id = 1054315166

# Use psql to call RPC
sql_report_preview = f"""
SELECT
  (preview_financial_movements_reconciliation_v2(
    {account_id},
    ARRAY{json.dumps(report_rows)},
    'report',
    '2026-06-01'::DATE,
    '2026-06-30'::DATE
  ))::JSONB AS result;
"""

sql_lib_preview = f"""
SELECT
  (preview_financial_movements_reconciliation_v2(
    {account_id},
    ARRAY{json.dumps(lib_rows)},
    'liberaciones',
    '2026-06-01'::DATE,
    '2026-06-30'::DATE
  ))::JSONB AS result;
"""

print("Cannot easily call RPC from local Python without Supabase SDK.")
print()
print("Instead, execute these queries in Supabase Studio → SQL Editor:")
print()
print("=" * 80)
print("QUERY 1: Report Preview")
print("=" * 80)
print(sql_report_preview[:200] + "...")
print()
print("=" * 80)
print("QUERY 2: Liberaciones Preview")
print("=" * 80)
print(sql_lib_preview[:200] + "...")
print()
print("Or, simpler: Let me read the DEPLOY_TO_SUPABASE_STUDIO.sql and identify the bug...")
