#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generar SQL rollback desde liberaciones_import_result.json
Soporta checkpoint parcial (si un batch fallo)
"""

import json
from pathlib import Path

def generate_rollback(json_path):
    """Leer .json y generar SQL rollback con orden FK correcto"""

    if not json_path.exists():
        print(f"ERROR: {json_path} no encontrado")
        return False

    try:
        with open(json_path, 'r') as f:
            result = json.load(f)
    except Exception as e:
        print(f"ERROR al leer {json_path}: {e}")
        return False

    # Extraer arrays de IDs de todos los batches
    batches = result.get('batches', [])

    sr_ids = []
    fm_ids = []
    le_ids = []
    link_ids = []

    for batch in batches:
        created = batch.get('created', {})

        if created.get('source_record_ids'):
            sr_ids.extend(created['source_record_ids'])
        if created.get('financial_movement_ids'):
            fm_ids.extend(created['financial_movement_ids'])
        if created.get('ledger_entry_ids'):
            le_ids.extend(created['ledger_entry_ids'])
        if created.get('link_ids'):
            link_ids.extend(created['link_ids'])

    # Generar SQL con arrays siempre tipados (soporta vacío)
    def format_array(ids_list):
        """Formatear array tipado: vacío o con IDs"""
        if not ids_list:
            return "ARRAY[]::BIGINT[]"
        return f"ARRAY[{','.join(str(i) for i in ids_list)}]::BIGINT[]"

    sql_lines = [
        "-- ============================================================================",
        "-- ROLLBACK: Auto-generado de liberaciones_import_result.json",
        f"-- Generado: {result.get('timestamp', 'N/A')}",
        f"-- Batch {result.get('batch_number', '?')}/{result.get('total_batches', '?')}",
        f"-- Records procesados: {result.get('records_processed_so_far', '?')}",
        "-- Orden FK: LE -> LINK -> FM -> SR",
        "-- ============================================================================",
        "",
        "DO $$",
        "DECLARE",
        f"  v_created_sr_ids BIGINT[] := {format_array(sr_ids)};",
        f"  v_created_fm_ids BIGINT[] := {format_array(fm_ids)};",
        f"  v_created_le_ids BIGINT[] := {format_array(le_ids)};",
        f"  v_created_link_ids BIGINT[] := {format_array(link_ids)};",
        "BEGIN",
        "  DELETE FROM ledger_entry WHERE id = ANY(v_created_le_ids);",
        "  RAISE NOTICE 'Deleted % LE', array_length(v_created_le_ids, 1);",
        "",
        "  DELETE FROM mp_movement_source_link WHERE id = ANY(v_created_link_ids);",
        "  RAISE NOTICE 'Deleted % LINK', array_length(v_created_link_ids, 1);",
        "",
        "  DELETE FROM mp_financial_movement WHERE id = ANY(v_created_fm_ids);",
        "  RAISE NOTICE 'Deleted % FM', array_length(v_created_fm_ids, 1);",
        "",
        "  DELETE FROM mp_source_record WHERE id = ANY(v_created_sr_ids);",
        "  RAISE NOTICE 'Deleted % SR', array_length(v_created_sr_ids, 1);",
        "END $$;",
    ]

    # Guardar SQL
    output_path = Path('sql/rollback_liberaciones_auto.sql')
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        with open(output_path, 'w') as f:
            f.write('\n'.join(sql_lines))
        print(f"OK: Rollback generado: {output_path}")
        print(f"  SR IDs: {len(sr_ids)}")
        print(f"  FM IDs: {len(fm_ids)}")
        print(f"  LE IDs: {len(le_ids)}")
        print(f"  LINK IDs: {len(link_ids)}")
        return True
    except Exception as e:
        print(f"ERROR al escribir {output_path}: {e}")
        return False

if __name__ == '__main__':
    json_path = Path('liberaciones_import_result.json')
    if generate_rollback(json_path):
        print("\nRollback listo (no ejecutado automaticamente)")
    else:
        exit(1)
