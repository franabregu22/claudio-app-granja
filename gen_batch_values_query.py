#!/usr/bin/env python3
"""
Generate SQL query that compares all 682 batch values against DB.
Output: SQL ready to execute in Supabase Studio.
"""

import json
import hashlib

def calculate_payload_hash(row):
    json_str = json.dumps(row, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(json_str.encode()).hexdigest()

# Load batch
with open('_preview_batches.json', 'r', encoding='utf-8') as f:
    batches = json.load(f)

report_batch = batches['report']

# Build VALUES clause
values_rows = []
for rep_row in report_batch:
    payload_hash = rep_row.get('_payload_hash')
    if not payload_hash:
        payload_hash = calculate_payload_hash(rep_row)

    source_id = rep_row.get('SOURCE_ID', '').replace("'", "''")  # Escape quotes
    monto = float(rep_row.get('SETTLEMENT_NET_AMOUNT', 0))

    values_rows.append(f"    ('{payload_hash}'::TEXT, '{source_id}'::TEXT, {monto}::NUMERIC)")

values_clause = ",\n".join(values_rows)

# Generate complete SQL query
sql_query = f"""-- ============================================================================
-- COLLAPSE DETECTION: Compare ALL 682 batch Report rows against DB LE
-- Logic: ABS(monto_batch - LE.balance_impact) > 0.01
-- ============================================================================

WITH batch_data AS (
  SELECT * FROM (VALUES
{values_clause}
  ) AS t(payload_hash, source_id_batch, monto_batch)
)
SELECT
  sr.id AS sr_id,
  bd.source_id_batch,
  fm.id AS fm_id,
  fm.settlement_amount AS fm_settlement,
  le.id AS le_id,
  le.balance_impact AS monto_le,
  bd.monto_batch,
  ABS(bd.monto_batch - le.balance_impact) AS discrepancia
FROM batch_data bd
INNER JOIN mp_source_record sr ON sr.payload_hash = bd.payload_hash
INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
INNER JOIN ledger_entry le ON fm.id = le.financial_movement_id
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
WHERE sr.source_type = 'report'
  AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
  AND ABS(bd.monto_batch - le.balance_impact) > 0.01
ORDER BY sr.id;
"""

# Write to file
with open('COLLAPSE_BATCH_vs_DB_FULL.sql', 'w', encoding='utf-8') as f:
    f.write(sql_query)

print("Generated COLLAPSE_BATCH_vs_DB_FULL.sql")
print()
print(f"Query includes {len(report_batch)} Report rows from batch")
print(f"Output file: COLLAPSE_BATCH_vs_DB_FULL.sql")
print()
print("Next step: Copy-paste COLLAPSE_BATCH_vs_DB_FULL.sql into Supabase Studio and Run")
print()
print("Expected result: 3 rows (SR3903, SR3909, + 1 unknown)")
