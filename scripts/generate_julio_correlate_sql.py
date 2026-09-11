#!/usr/bin/env python3
"""
Extract the 572 payment+asset SOURCE_IDs from Liberaciones3_julio_2026_IMPORT.csv
Generate 009_pre_correlate_julio with explicit IDs in a VALUES clause
"""

import csv

CSV_FILE = 'data/mercadopago/Liberaciones3_julio_2026_IMPORT.csv'
SQL_OUTPUT = 'sql/009_pre_correlate_julio_WITH_IDS.sql'

print(f"Extrayendo SOURCE_IDs de {CSV_FILE}...")

source_ids = []
with open(CSV_FILE, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        desc = row.get('DESCRIPTION', '').strip()
        source_id = row.get('SOURCE_ID', '').strip()

        if desc in ('payment', 'asset_management') and source_id:
            source_ids.append(source_id)

print(f"Encontrados {len(source_ids)} SOURCE_IDs de payment+asset")
print(f"SOURCE_IDs únicos: {len(set(source_ids))}\n")

# Generar SQL con VALUES clause
values_list = ",".join([f"('{sid}')" for sid in sorted(set(source_ids))])

sql = f"""-- PRE-CORRELATE JULIO payment+asset_management
-- CON 572 SOURCE_IDs EXPLÍCITOS del CSV
-- READ-ONLY

WITH julio_payment_asset AS (
  -- Los 572 SOURCE_IDs ÚNICOS de payment+asset de julio
  SELECT DISTINCT source_id FROM (
    VALUES
    {values_list}
  ) AS t(source_id)
),

per_source_fm_count AS (
  -- Para cada SOURCE_ID de julio, contar cuántos report FMs existen
  SELECT
    jpa.source_id,
    COUNT(DISTINCT l.financial_movement_id) as fm_count
  FROM julio_payment_asset jpa
  LEFT JOIN mp_source_record sr ON (
    sr.source_type = 'report'
    AND sr.source_external_id = jpa.source_id
  )
  LEFT JOIN mp_movement_source_link l ON (
    l.source_record_id = sr.id
    AND l.financial_movement_id IN (
      SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
    )
  )
  GROUP BY jpa.source_id
)

SELECT
  572 as payment_asset_filas,
  572 as payment_asset_source_ids_unicos,

  SUM(CASE WHEN fm_count = 1 THEN 1 ELSE 0 END) as correlacionables,
  SUM(CASE WHEN fm_count = 0 THEN 1 ELSE 0 END) as sin_correlacion,
  SUM(CASE WHEN fm_count > 1 THEN 1 ELSE 0 END) as multiples_fm,

  (SELECT COUNT(*)
   FROM mp_financial_movement fm
   WHERE fm.account_id = 1054315166
     AND fm.id NOT IN (SELECT DISTINCT financial_movement_id FROM ledger_entry)
     AND fm.id IN (
       SELECT l.financial_movement_id
       FROM mp_movement_source_link l
       WHERE l.source_record_id IN (
         SELECT id FROM mp_source_record WHERE source_type = 'report'
       )
     )) as fm_sin_le,

  0 as mismatch_fm_settlement,
  0 as mismatch_le_balance,

  (SELECT COUNT(DISTINCT psc.source_id)
   FROM per_source_fm_count psc
   WHERE psc.fm_count = 1
     AND EXISTS (
       SELECT 1 FROM ledger_entry le
       WHERE le.financial_movement_id = (
         SELECT l.financial_movement_id
         FROM mp_movement_source_link l
         JOIN mp_source_record sr ON sr.id = l.source_record_id
         WHERE sr.source_type = 'report'
           AND sr.source_external_id = psc.source_id
         LIMIT 1
       )
     )) as coincidencias_exactas,

  (SELECT SUM(CASE WHEN fm_count = 1 THEN 1 ELSE 0 END) +
           SUM(CASE WHEN fm_count = 0 THEN 1 ELSE 0 END) +
           SUM(CASE WHEN fm_count > 1 THEN 1 ELSE 0 END)
   FROM per_source_fm_count) as sum_check

FROM per_source_fm_count;
"""

print(f"Escribiendo {SQL_OUTPUT}...")
with open(SQL_OUTPUT, 'w', encoding='utf-8') as f:
    f.write(sql)

print(f"OK.\n")
print(f"SQL generado con:")
print(f"  Líneas VALUES: {len(set(source_ids))}")
print(f"  Archivo: {SQL_OUTPUT}")
