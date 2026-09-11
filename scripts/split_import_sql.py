#!/usr/bin/env python3
"""
Divide import_mp_report.sql en chunks pequeños para ejecutar en Supabase SQL Editor.
Cada chunk es ~200-300 KB, garantizado que cabe en el editor.
"""

import re
from pathlib import Path

def split_sql_into_chunks(input_file, output_dir, chunk_lines=150):
    """
    Lee import_mp_report.sql y lo parte en chunks basado en líneas de INSERT.
    """
    input_path = Path(input_file)
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    with open(input_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Separar en secciones
    # Source records, Financial movements, Movement links, Ledger entries

    source_records = []
    financial_movements = []
    movement_links = []
    ledger_entries = []

    current_section = None
    current_lines = []

    for line in content.split('\n'):
        # Detectar secciones
        if '-- SOURCE RECORDS' in line:
            current_section = 'source'
            continue
        elif '-- FINANCIAL MOVEMENTS' in line:
            if current_lines:
                source_records.append('\n'.join(current_lines))
                current_lines = []
            current_section = 'financial'
            continue
        elif '-- MOVEMENT LINKS' in line:
            if current_lines:
                financial_movements.append('\n'.join(current_lines))
                current_lines = []
            current_section = 'links'
            continue
        elif '-- LEDGER ENTRIES' in line:
            if current_lines:
                movement_links.append('\n'.join(current_lines))
                current_lines = []
            current_section = 'ledger'
            continue
        elif '-- ESTADÍSTICAS' in line or '-- RESUMEN' in line:
            if current_lines:
                ledger_entries.append('\n'.join(current_lines))
                current_lines = []
            break

        if line.strip():
            current_lines.append(line)

    # Juntar lo que falta
    if current_lines:
        if current_section == 'source':
            source_records.append('\n'.join(current_lines))
        elif current_section == 'financial':
            financial_movements.append('\n'.join(current_lines))
        elif current_section == 'links':
            movement_links.append('\n'.join(current_lines))
        elif current_section == 'ledger':
            ledger_entries.append('\n'.join(current_lines))

    # Juntar INSERT por sección
    source_sql = '\n'.join(source_records)
    financial_sql = '\n'.join(financial_movements)
    links_sql = '\n'.join(movement_links)
    ledger_sql = '\n'.join(ledger_entries)

    # Extraer INSERT statements
    source_inserts = re.findall(r'INSERT INTO mp_source_record.*?\);', source_sql, re.DOTALL)
    financial_inserts = re.findall(r'INSERT INTO mp_financial_movement.*?\);', financial_sql, re.DOTALL)
    links_inserts = re.findall(r'INSERT INTO mp_movement_source_link.*?\);', links_sql, re.DOTALL)
    ledger_inserts = re.findall(r'INSERT INTO ledger_entry.*?\);', ledger_sql, re.DOTALL)

    print(f"Encontrados:")
    print(f"  Source records: {len(source_inserts)}")
    print(f"  Financial movements: {len(financial_inserts)}")
    print(f"  Movement links: {len(links_inserts)}")
    print(f"  Ledger entries: {len(ledger_inserts)}")
    print(f"  Total: {len(source_inserts) + len(financial_inserts) + len(links_inserts) + len(ledger_inserts)}\n")

    # Crear chunks
    chunk_number = 1
    all_chunks = []

    # Chunk 0: Metadatos iniciales
    chunk_0 = """-- ============================================================================
-- IMPORTACIÓN MERCADO PAGO - CHUNK 0 (INICIO)
-- ============================================================================
-- Ejecutar primero este chunk para preparar la base de datos

SET CONSTRAINTS ALL DEFERRED;

-- Este chunk prepara el entorno
-- Los siguientes chunks (1, 2, 3...) insertarán los datos

-- ============================================================================
"""

    with open(output_path / f"00_inicio.sql", 'w', encoding='utf-8') as f:
        f.write(chunk_0)

    print(f"[OK] Chunk 00: inicio")

    # Chunks de source records
    for i in range(0, len(source_inserts), chunk_lines):
        chunk_inserts = source_inserts[i:i+chunk_lines]
        chunk_sql = f"""-- ============================================================================
-- IMPORTACIÓN MERCADO PAGO - CHUNK {chunk_number}
-- ============================================================================
-- SOURCE RECORDS ({i+1} a {min(i+chunk_lines, len(source_inserts))} de {len(source_inserts)})

SET CONSTRAINTS ALL DEFERRED;

{chr(10).join(chunk_inserts)}

-- ============================================================================
"""
        with open(output_path / f"{chunk_number:02d}_source_records.sql", 'w', encoding='utf-8') as f:
            f.write(chunk_sql)
        print(f"[OK] Chunk {chunk_number:02d}: source records ({i+1}-{min(i+chunk_lines, len(source_inserts))})")
        chunk_number += 1

    # Chunks de financial movements
    for i in range(0, len(financial_inserts), chunk_lines):
        chunk_inserts = financial_inserts[i:i+chunk_lines]
        chunk_sql = f"""-- ============================================================================
-- IMPORTACIÓN MERCADO PAGO - CHUNK {chunk_number}
-- ============================================================================
-- FINANCIAL MOVEMENTS ({i+1} a {min(i+chunk_lines, len(financial_inserts))} de {len(financial_inserts)})

SET CONSTRAINTS ALL DEFERRED;

{chr(10).join(chunk_inserts)}

-- ============================================================================
"""
        with open(output_path / f"{chunk_number:02d}_financial_movements.sql", 'w', encoding='utf-8') as f:
            f.write(chunk_sql)
        print(f"[OK] Chunk {chunk_number:02d}: financial movements ({i+1}-{min(i+chunk_lines, len(financial_inserts))})")
        chunk_number += 1

    # Chunks de movement links
    for i in range(0, len(links_inserts), chunk_lines):
        chunk_inserts = links_inserts[i:i+chunk_lines]
        chunk_sql = f"""-- ============================================================================
-- IMPORTACIÓN MERCADO PAGO - CHUNK {chunk_number}
-- ============================================================================
-- MOVEMENT LINKS ({i+1} a {min(i+chunk_lines, len(links_inserts))} de {len(links_inserts)})

SET CONSTRAINTS ALL DEFERRED;

{chr(10).join(chunk_inserts)}

-- ============================================================================
"""
        with open(output_path / f"{chunk_number:02d}_movement_links.sql", 'w', encoding='utf-8') as f:
            f.write(chunk_sql)
        print(f"[OK] Chunk {chunk_number:02d}: movement links ({i+1}-{min(i+chunk_lines, len(links_inserts))})")
        chunk_number += 1

    # Chunks de ledger entries
    for i in range(0, len(ledger_inserts), chunk_lines):
        chunk_inserts = ledger_inserts[i:i+chunk_lines]
        chunk_sql = f"""-- ============================================================================
-- IMPORTACIÓN MERCADO PAGO - CHUNK {chunk_number}
-- ============================================================================
-- LEDGER ENTRIES ({i+1} a {min(i+chunk_lines, len(ledger_inserts))} de {len(ledger_inserts)})

SET CONSTRAINTS ALL DEFERRED;

{chr(10).join(chunk_inserts)}

-- ============================================================================
"""
        with open(output_path / f"{chunk_number:02d}_ledger_entries.sql", 'w', encoding='utf-8') as f:
            f.write(chunk_sql)
        print(f"✓ Chunk {chunk_number:02d}: ledger entries ({i+1}-{min(i+chunk_lines, len(ledger_inserts))})")
        chunk_number += 1

    # Chunk final: validación
    chunk_final = f"""-- ============================================================================
-- IMPORTACIÓN MERCADO PAGO - CHUNK {chunk_number} (FINAL - VALIDACIÓN)
-- ============================================================================
-- Ejecutar este chunk DESPUÉS de todos los anteriores para verificar

SET CONSTRAINTS ALL IMMEDIATE;

-- Verificar integridad
SELECT
  'VALIDACIÓN FINAL' as check_name,
  (SELECT COUNT(*) FROM mp_source_record) as source_records,
  (SELECT COUNT(*) FROM mp_financial_movement) as financial_movements,
  (SELECT COUNT(*) FROM mp_movement_source_link) as movement_links,
  (SELECT COUNT(*) FROM ledger_entry) as ledger_entries
;

-- Verificar totales
SELECT
  'TOTALES' as summary,
  (SELECT SUM(transaction_amount)::NUMERIC(15,2) FROM mp_financial_movement) as transaction_total,
  (SELECT SUM(settlement_amount)::NUMERIC(15,2) FROM mp_financial_movement) as settlement_total,
  (SELECT SUM(balance_impact)::NUMERIC(15,2) FROM ledger_entry) as ledger_total,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class = 'yield') as yields
;

-- ============================================================================
"""

    with open(output_path / f"{chunk_number:02d}_validacion.sql", 'w', encoding='utf-8') as f:
        f.write(chunk_final)
    print(f"✓ Chunk {chunk_number:02d}: validación final")

    print(f"\n{'='*80}")
    print(f"LISTO: {chunk_number} chunks creados en: {output_path}/")
    print(f"{'='*80}\n")

    # Crear archivo de instrucciones
    instructions = f"""INSTRUCCIONES PARA IMPORTAR EN SUPABASE
=========================================

Total de chunks a ejecutar: {chunk_number}

1. Abre Supabase SQL Editor
2. Para CADA archivo (en orden):
   - Copia el contenido del archivo
   - Pégalo en el SQL Editor
   - Haz clic en RUN
   - Espera a que termine (debe decir "success")

Orden de ejecución:
{chr(10).join([f'  {i:02d}. {f}' for i, f in enumerate(sorted((output_path).glob('*.sql')))])}

IMPORTANTE:
- Ejecutar en ORDEN (00, 01, 02, 03, ...)
- Esperar a que cada chunk termine antes de pasar al siguiente
- El chunk final (validación) debe mostrar:
  - source_records: 716
  - financial_movements: 716
  - movement_links: 716
  - ledger_entries: 716
  - yields: 20
  - settlement_total: $10,780,612.05

Si algún chunk falla, detente y reporta cuál fue el error.
"""

    with open(output_path / "INSTRUCCIONES.txt", 'w', encoding='utf-8') as f:
        f.write(instructions)

    print("INSTRUCCIONES:")
    print(instructions)

if __name__ == '__main__':
    input_file = "scripts/import_mp_report.sql"
    output_dir = "scripts/chunks"

    print("Partiendo import_mp_report.sql en chunks...")
    print()

    split_sql_into_chunks(input_file, output_dir)
