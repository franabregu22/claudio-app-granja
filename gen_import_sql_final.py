#!/usr/bin/env python3
"""
Genera SQL final con datos embebidos para PASO 2 y PASO 3
"""

import json

try:
    with open('_preview_batches.json', 'r', encoding='utf-8') as f:
        batches = json.load(f)

    report_batch = batches.get('report', [])
    lib_batch = batches.get('liberaciones', [])

    print(f"✓ Cargadas {len(report_batch)} filas de Report")
    print(f"✓ Cargadas {len(lib_batch)} filas de Liberaciones")
    print()

    # PASO 2: Report
    sql_report = """-- ============================================================================
-- PASO 2: IMPORT REPORT (WRITE)
-- ============================================================================

SELECT import_financial_movements_reconciliation_v2(
  1054315166,
  ARRAY[
"""

    for i, row in enumerate(report_batch):
        row_json = json.dumps(row)
        row_json_escaped = row_json.replace("'", "''")
        sql_report += f"    '{row_json_escaped}'::jsonb"
        if i < len(report_batch) - 1:
            sql_report += ",\n"
        else:
            sql_report += "\n"

    sql_report += """  ]::jsonb[],
  'report',
  '2026-06-01'::DATE,
  '2026-06-30'::DATE
) AS report_import_result;
"""

    with open('PASO_2_IMPORT_REPORT_FINAL.sql', 'w', encoding='utf-8') as f:
        f.write(sql_report)

    print(f"✓ PASO_2_IMPORT_REPORT_FINAL.sql ({len(sql_report) / 1024 / 1024:.1f} MB)")

    # PASO 3: Liberaciones
    sql_lib = """-- ============================================================================
-- PASO 3: IMPORT LIBERACIONES (WRITE)
-- ============================================================================

SELECT import_financial_movements_reconciliation_v2(
  1054315166,
  ARRAY[
"""

    for i, row in enumerate(lib_batch):
        row_json = json.dumps(row)
        row_json_escaped = row_json.replace("'", "''")
        sql_lib += f"    '{row_json_escaped}'::jsonb"
        if i < len(lib_batch) - 1:
            sql_lib += ",\n"
        else:
            sql_lib += "\n"

    sql_lib += """  ]::jsonb[],
  'liberaciones',
  '2026-06-01'::DATE,
  '2026-06-30'::DATE
) AS lib_import_result;
"""

    with open('PASO_3_IMPORT_LIBERACIONES_FINAL.sql', 'w', encoding='utf-8') as f:
        f.write(sql_lib)

    print(f"✓ PASO_3_IMPORT_LIBERACIONES_FINAL.sql ({len(sql_lib) / 1024 / 1024:.1f} MB)")
    print()
    print("Pasos:")
    print("1. Copia TODO el contenido de PASO_2_IMPORT_REPORT_FINAL.sql")
    print("2. Pégalo en Supabase Studio → SQL Editor")
    print("3. Click RUN")
    print("4. Luego repite con PASO_3_IMPORT_LIBERACIONES_FINAL.sql")
    print()

except FileNotFoundError:
    print("ERROR: No se encuentra _preview_batches.json")
except Exception as e:
    print(f"ERROR: {e}")
