#!/usr/bin/env python3
"""
Análisis local del BASECSV para entender estructura y proponer estrategia de cruce
"""

import csv
from datetime import datetime
from collections import defaultdict

try:
    # Leer CSV
    with open('data/mercadopago/BASECSV.csv', 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        all_rows = list(reader)

    print(f"✓ Total de movimientos en CSV: {len(all_rows)}")
    print()

    # Filtrar junio 2026
    june_rows = [r for r in all_rows if r['Fecha de Pago'].startswith('2026-06-')]
    print(f"✓ Movimientos de junio 2026: {len(june_rows)}")
    print()

    # Analizar tipos de operación
    operation_types = defaultdict(int)
    for row in june_rows:
        operation_types[row['Tipo de Operación']] += 1

    print("Tipos de operación en junio:")
    for op_type, count in sorted(operation_types.items(), key=lambda x: -x[1]):
        print(f"  {op_type}: {count}")
    print()

    # Analizar estructura de pares (Dinero + Impuesto)
    print("Análisis de estructura de pares:")
    print()

    # Agrupar por Operación Relacionada
    related_op_groups = defaultdict(list)
    for row in june_rows:
        related_op = row['Operación Relacionada']
        if related_op:  # Solo si tiene Operación Relacionada
            related_op_groups[related_op].append(row)

    # Estadísticas de grupos
    group_sizes = defaultdict(int)
    total_paired = 0
    for group_id, rows in related_op_groups.items():
        group_sizes[len(rows)] += 1
        total_paired += len(rows)

    print(f"Movimientos con 'Operación Relacionada': {total_paired}")
    print("Distribución:")
    for size in sorted(group_sizes.keys()):
        count = group_sizes[size]
        print(f"  {size} movimientos en el par: {count} grupos (={count*size} movimientos)")
    print()

    # Ejemplos de pares
    print("Ejemplo de estructura de par (Dinero + Impuesto):")
    sample_group = next((rows for rows in related_op_groups.values() if len(rows) == 2), None)
    if sample_group:
        for row in sample_group:
            print(f"  {row['Tipo de Operación']:50s} | Mov: {row['Número de Movimiento']:20s} | "
                  f"Rel: {row['Operación Relacionada']:20s} | Importe: {row['Importe']:12s}")
        total_pair = sum(float(r['Importe']) for r in sample_group)
        print(f"  → Suma neta del par: {total_pair}")
    print()

    # Movimientos sin Operación Relacionada (rendimientos, etc)
    unpaired = [r for r in june_rows if not r['Operación Relacionada']]
    print(f"Movimientos SIN 'Operación Relacionada': {len(unpaired)}")
    if unpaired:
        unpaired_ops = defaultdict(int)
        for row in unpaired:
            unpaired_ops[row['Tipo de Operación']] += 1
        for op_type, count in sorted(unpaired_ops.items(), key=lambda x: -x[1]):
            print(f"  {op_type}: {count}")
    print()

    # Calcular suma total de junio
    total_amount = sum(float(r['Importe']) for r in june_rows)
    print(f"Suma total de movimientos en junio (BASECSV): {total_amount:,.2f}")
    print()

    # Primeras y últimas fechas de junio
    first_date = june_rows[0]['Fecha de Pago']
    last_date = june_rows[-1]['Fecha de Pago']
    print(f"Rango de fechas en junio: {first_date} → {last_date}")
    print()

    # Estrategia de cruce
    print("="*80)
    print("ESTRATEGIA DE CRUCE PROPUESTA")
    print("="*80)
    print()
    print("Identidad fuerte en BASECSV:")
    print("  1. Número de Movimiento (único por movimiento)")
    print("  2. Operación Relacionada (agrupa dinero + impuesto)")
    print("  3. Fecha (ISO 8601 timestamp)")
    print("  4. Importe (con signo)")
    print()
    print("Para cruzar contra AppGranja (Liberaciones + Report):")
    print("  - Usar SOURCE_ID como clave primaria (si existe)")
    print("  - Usar fecha + tipo + importe como respaldo")
    print("  - NO confiar solo en SOURCE_ID (puede tener múltiples movimientos)")
    print()
    print("Lógica de clasificación:")
    print("  ✓ MATCH: Existe en AppGranja con mismo importe, fecha compatível y tipo")
    print("  ✗ FALTA_EN_APPGRANJA: Existe en BASECSV pero NO en AppGranja")
    print("  ⚠ POSIBLE_DUPLICADO: Existe múltiples veces en AppGranja (mismo SOURCE_ID)")
    print("  ! IMPORTE_DIFERENTE: Existe en AppGranja pero importe no coincide")
    print("  ? AMBIGUO: Múltiples candidatos en AppGranja sin criterio claro")
    print()

except FileNotFoundError:
    print("ERROR: No se encuentra data/mercadopago/BASECSV.csv")
except Exception as e:
    print(f"ERROR: {e}")
