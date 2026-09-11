#!/usr/bin/env python3
"""
Generar SQL de rollback a partir de checkpoint FIRST_RUN
Extrae IDs creados y genera DELETE statements en orden correcto
"""

import json
import sys
from pathlib import Path

CHECKPOINT_FILE = 'liberaciones_import_result_FIRST_RUN_AGOSTO_2026.json'
OUTPUT_FILE = 'sql/rollback_liberaciones_FIRST_RUN_AGOSTO_2026.sql'

print(f"Leyendo checkpoint: {CHECKPOINT_FILE}")

if not Path(CHECKPOINT_FILE).exists():
    print(f"ERROR: {CHECKPOINT_FILE} no existe")
    sys.exit(1)

with open(CHECKPOINT_FILE, 'r') as f:
    checkpoint = json.load(f)

# Extraer IDs de todos los batches
all_le_ids = []
all_link_ids = []
all_fm_ids = []
all_sr_ids = []

for batch in checkpoint.get('batches', []):
    created = batch.get('created', {})
    all_le_ids.extend(created.get('ledger_entry_ids', []))
    all_link_ids.extend(created.get('link_ids', []))
    all_fm_ids.extend(created.get('financial_movement_ids', []))
    all_sr_ids.extend(created.get('source_record_ids', []))

print(f"\nIDs Extraídos:")
print(f"  LE IDs: {len(all_le_ids)} (IDs: {all_le_ids[:5]}... {all_le_ids[-5:] if len(all_le_ids) > 10 else ''})")
print(f"  LINK IDs: {len(all_link_ids)} (IDs: {all_link_ids[:5]}... {all_link_ids[-5:] if len(all_link_ids) > 10 else ''})")
print(f"  FM IDs: {len(all_fm_ids)} (IDs: {all_fm_ids})")
print(f"  SR IDs: {len(all_sr_ids)} (IDs: {all_sr_ids[:5]}... {all_sr_ids[-5:] if len(all_sr_ids) > 10 else ''})")

# Generar SQL
sql = f"""-- ROLLBACK: FIRST RUN AGOSTO 2026
-- Elimina EXCLUSIVAMENTE los IDs creados por la primera importación
-- NO modifica nada más
-- Orden: LE → LINK → FM → SR (respetando FK constraints)

BEGIN;

-- PASO 1: Eliminar ledger_entry (10 registros)
DELETE FROM ledger_entry
WHERE id = ANY(ARRAY[{','.join(map(str, all_le_ids))}]::BIGINT[]);

-- PASO 2: Eliminar movement_source_link (726 registros)
DELETE FROM mp_movement_source_link
WHERE id = ANY(ARRAY[{','.join(map(str, all_link_ids))}]::BIGINT[]);

-- PASO 3: Eliminar financial_movement (10 registros)
DELETE FROM mp_financial_movement
WHERE id = ANY(ARRAY[{','.join(map(str, all_fm_ids))}]::BIGINT[]);

-- PASO 4: Eliminar source_record (798 registros)
DELETE FROM mp_source_record
WHERE id = ANY(ARRAY[{','.join(map(str, all_sr_ids))}]::BIGINT[]);

-- VALIDACIÓN POST-ROLLBACK
SELECT 'POST-ROLLBACK' as status,
       (SELECT COUNT(*) FROM ledger_entry WHERE id = ANY(ARRAY[{','.join(map(str, all_le_ids))}]::BIGINT[])) as le_remaining,
       (SELECT COUNT(*) FROM mp_movement_source_link WHERE id = ANY(ARRAY[{','.join(map(str, all_link_ids))}]::BIGINT[])) as link_remaining,
       (SELECT COUNT(*) FROM mp_financial_movement WHERE id = ANY(ARRAY[{','.join(map(str, all_fm_ids))}]::BIGINT[])) as fm_remaining,
       (SELECT COUNT(*) FROM mp_source_record WHERE id = ANY(ARRAY[{','.join(map(str, all_sr_ids))}]::BIGINT[])) as sr_remaining;

-- COMMIT;
"""

print(f"\nEscribiendo {OUTPUT_FILE}...")
with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
    f.write(sql)

print(f"OK. Rollback generado.")
print(f"\nRESUMEN:")
print(f"  LE IDs a borrar: {len(all_le_ids)}")
print(f"  LINK IDs a borrar: {len(all_link_ids)}")
print(f"  FM IDs a borrar: {len(all_fm_ids)}")
print(f"  SR IDs a borrar: {len(all_sr_ids)}")
print(f"  Total: {len(all_le_ids) + len(all_link_ids) + len(all_fm_ids) + len(all_sr_ids)} registros a eliminar")
print(f"\nNOTA: El SQL contiene 'COMMIT' comentado al final.")
print(f"NO ejecutar hasta confirmación explícita.")
