#!/usr/bin/env python3
"""
Genera SQL INSERT statement para cargar BASECSV junio en tabla temporal
"""

import csv
from datetime import datetime

try:
    with open('data/mercadopago/BASECSV.csv', 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        all_rows = list(reader)

    # Filtrar junio
    june_rows = [r for r in all_rows if r['Fecha de Pago'].startswith('2026-06-')]

    print(f"✓ Encontrados {len(june_rows)} movimientos de junio")
    print()

    # Generar SQL INSERT
    sql = "-- Insert de 1373 movimientos de junio desde BASECSV\nINSERT INTO basecsv_june_temp (fecha_pago, tipo_operacion, numero_movimiento, operacion_relacionada, importe) VALUES\n"

    insert_values = []
    for row in june_rows:
        fecha = row['Fecha de Pago']
        tipo = row['Tipo de Operación'].replace("'", "''")  # Escape quotes
        numero = row['Número de Movimiento']
        relacionada = row['Operación Relacionada']
        importe = row['Importe']

        # Formato: ('2026-06-01T01:44:30Z', 'Rendimiento positivo de la inversión', 2310994060269, 1744539809419, 8117.49)
        insert_values.append(
            f"('{fecha}', '{tipo}', {numero}, {relacionada}, {importe})"
        )

    sql += ",\n".join(insert_values) + ";"

    # Guardar a archivo
    with open('INSERT_BASECSV_JUNE.sql', 'w', encoding='utf-8') as f:
        f.write(sql)

    print(f"✓ SQL INSERT generado: INSERT_BASECSV_JUNE.sql ({len(sql) / 1024 / 1024:.1f} MB)")
    print()
    print("Pasos:")
    print("1. Abre Supabase Studio → SQL Editor")
    print("2. Copia el contenido de INSERT_BASECSV_JUNE.sql")
    print("3. Pégalo en el editor (reemplaza el CREATE TEMP TABLE IF NOT EXISTS)")
    print("4. Click en RUN")
    print()

except FileNotFoundError:
    print("ERROR: No se encuentra data/mercadopago/BASECSV.csv")
except Exception as e:
    print(f"ERROR: {e}")
