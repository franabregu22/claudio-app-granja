#!/usr/bin/env python3
"""
Análisis detallado de BASECSV para entender estructura real de movimientos
"""

import csv
from collections import defaultdict

try:
    with open('data/mercadopago/BASECSV.csv', 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        all_rows = list(reader)

    # Filtrar junio 2026
    june_rows = [r for r in all_rows if r['Fecha de Pago'].startswith('2026-06-')]

    print("="*80)
    print("ANÁLISIS DETALLADO DE BASECSV - JUNIO 2026")
    print("="*80)
    print()

    # 1. Números de movimiento únicos
    numeros_unicos = set(r['Número de Movimiento'] for r in june_rows)
    print(f"✓ 'Número de Movimiento' únicos: {len(numeros_unicos)}")
    print(f"✓ Total de filas: {len(june_rows)}")
    print()

    # 2. Operación Relacionada análisis
    operaciones_relacionadas = defaultdict(list)
    for row in june_rows:
        op_rel = row['Operación Relacionada']
        operaciones_relacionadas[op_rel].append(row)

    print(f"✓ 'Operación Relacionada' únicas: {len(operaciones_relacionadas)}")
    print()

    # Distribución de movimientos por Operación Relacionada
    print("Distribución de movimientos POR Operación Relacionada:")
    distribucion = defaultdict(int)
    for op_rel, rows in operaciones_relacionadas.items():
        distribucion[len(rows)] += 1

    for cant in sorted(distribucion.keys()):
        grupos = distribucion[cant]
        print(f"  {cant} movimiento(s) en {grupos} grupos = {cant * grupos} movimientos")
    print()

    # 3. Búsqueda de Operación Relacionada con múltiples movimientos económicos reales
    print("Operaciones Relacionadas con MÁS DE 2 movimientos (potencial collapso):")
    anomalias = {op: rows for op, rows in operaciones_relacionadas.items() if len(rows) > 2}

    if anomalias:
        for op_rel, rows in list(anomalias.items())[:10]:  # Primeras 10
            print(f"\n  Operación Relacionada: {op_rel}")
            for row in rows:
                print(f"    - Número: {row['Número de Movimiento']:20s} | "
                      f"Tipo: {row['Tipo de Operación']:50s} | "
                      f"Importe: {row['Importe']:12s}")
            total = sum(float(r['Importe']) for r in rows)
            print(f"    → Suma total: {total}")
    else:
        print("  (Ninguna)")
    print()

    # 4. Buscar los 4 movimientos específicos
    print("="*80)
    print("BÚSQUEDA DE MOVIMIENTOS ESPECÍFICOS")
    print("="*80)
    print()

    target_amounts = [1629.44, 471.71, 1854.71, 463.84]

    for target in target_amounts:
        matches = [r for r in june_rows if float(r['Importe']) == target]
        if matches:
            print(f"✓ Importe +{target}:")
            for row in matches:
                print(f"  - Número Movimiento: {row['Número de Movimiento']}")
                print(f"    Operación Relacionada: {row['Operación Relacionada']}")
                print(f"    Tipo: {row['Tipo de Operación']}")
                print(f"    Fecha: {row['Fecha de Pago']}")
                print()
        else:
            print(f"✗ Importe +{target}: NO ENCONTRADO en junio")
            print()

    # 5. Resumen para la auditoría
    print("="*80)
    print("IMPLICACIONES PARA LA AUDITORÍA")
    print("="*80)
    print()
    print(f"La auditoría debe procesar {len(numeros_unicos)} movimientos únicos (por Número).")
    print(f"NO debe agrupar por Operación Relacionada (puede perder identidad).")
    print(f"Cada fila de BASECSV (Número de Movimiento) es una entidad independiente.")
    print()
    print("Criterios de cruce:")
    print("  1. Buscar por SOURCE_ID (igual a Operación Relacionada si existe)")
    print("  2. Buscar por Fecha + Importe + Tipo (respaldo)")
    print("  3. Mantener Número de Movimiento como identidad única de audit")
    print()

except FileNotFoundError:
    print("ERROR: No se encuentra data/mercadopago/BASECSV.csv")
except Exception as e:
    print(f"ERROR: {e}")
