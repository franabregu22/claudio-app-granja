#!/usr/bin/env python3
"""
Genera query de PREVIEW para Liberaciones (744 rows)
Usa _preview_batches.json y devuelve SQL listo para pegar en Supabase Studio
"""

import json

try:
    with open('_preview_batches.json', 'r', encoding='utf-8') as f:
        batches = json.load(f)

    lib_batch = batches.get('liberaciones', [])

    if not lib_batch:
        print("ERROR: No hay filas de Liberaciones en _preview_batches.json")
        exit(1)

    print(f"✓ Cargadas {len(lib_batch)} filas de Liberaciones")
    print()

    # Convertir filas a formato JSONB[] para SQL
    jsonb_array = "ARRAY["
    for i, row in enumerate(lib_batch):
        row_json = json.dumps(row)
        # Escapeamos comillas simples duplicándolas
        row_json_escaped = row_json.replace("'", "''")
        jsonb_array += f"'{row_json_escaped}'::jsonb"
        if i < len(lib_batch) - 1:
            jsonb_array += ", "
    jsonb_array += "]"

    # Generar query SQL
    sql = f"""-- ============================================================================
-- PREVIEW LIBERACIONES AFTER FIX (asset_management -> PAYMENT)
-- ============================================================================

SELECT
  (result->'summary'->>'new_financial_movements')::INT AS new_fm,
  (result->'summary'->>'new_ledger_entries')::INT AS new_le,
  (result->'financial_impact'->>'expected_delta')::NUMERIC AS proposed_delta,
  (result->'financial_impact'->>'expected_ledger_net_post_import')::NUMERIC AS expected_ledger_after,
  (result->'summary'->>'reused_existing_fm')::INT AS reused,
  (result->'summary'->>'raw_only_rows')::INT AS raw_only,
  (result->'summary'->>'ambiguous_rows')::INT AS ambiguous
FROM (
  SELECT preview_financial_movements_reconciliation_v2(
    1054315166,
    {jsonb_array},
    'liberaciones',
    '2026-06-01'::DATE,
    '2026-06-30'::DATE
  ) AS result
) sub;
"""

    # Guardar en archivo
    with open('PREVIEW_LIBERACIONES_FINAL.sql', 'w', encoding='utf-8') as f:
        f.write(sql)

    print(f"✓ Query generada: PREVIEW_LIBERACIONES_FINAL.sql ({len(sql) / 1024:.1f} KB)")
    print()
    print("Pasos:")
    print("1. Abre Supabase Studio → SQL Editor")
    print("2. Borra todo y copias el contenido de PREVIEW_LIBERACIONES_FINAL.sql")
    print("3. Click en RUN")
    print()
    print("Resultado esperado:")
    print("  new_fm: 20")
    print("  new_le: 20")
    print("  proposed_delta: -10299646.76")
    print("  expected_ledger_after: 2043480.55")
    print("  ambiguous: 0")

except FileNotFoundError:
    print("ERROR: No se encuentra _preview_batches.json en el directorio actual")
    exit(1)
except json.JSONDecodeError as e:
    print(f"ERROR al parsear JSON: {e}")
    exit(1)
except Exception as e:
    print(f"ERROR: {e}")
    exit(1)
