#!/usr/bin/env python3
"""
Auditoría de CSV: buscar dónde están las salidas faltantes de agosto.

Discrepancia detectada:
- MP UI agosto: Salidas $13.461.925,11
- Supabase: Salidas $2.557.109,81
- Falta: $10.904.815,30
"""

import csv
from pathlib import Path
from decimal import Decimal
from collections import defaultdict
from datetime import datetime

csv_dir = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago")

print("\n" + "="*100)
print("AUDITORÍA CSV: SALIDAS FALTANTES DE AGOSTO")
print("="*100)

# Buscar archivos que contengan datos de agosto
august_rows = []
all_negative_rows = []
negative_by_type = defaultdict(list)
negative_by_method = defaultdict(Decimal)

for csv_file in sorted(csv_dir.glob("*.csv")):
    print(f"\n[LEYENDO] {csv_file.name}")

    try:
        with open(csv_file, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f, delimiter=';')

            if reader.fieldnames is None:
                print(f"  [ERROR] No se pudieron leer headers")
                continue

            print(f"  Headers: {', '.join(reader.fieldnames[:5])}...")

            file_august_count = 0
            file_negative_count = 0
            file_negative_sum = Decimal('0')

            for row in reader:
                try:
                    # Parsear settlement_net_amount
                    settlement_str = row.get('SETTLEMENT_NET_AMOUNT', '0').replace(',', '.')
                    settlement = Decimal(settlement_str) if settlement_str else Decimal('0')

                    # Parsear fecha
                    date_str = row.get('TRANSACTION_DATE', '')
                    if date_str:
                        try:
                            date_obj = datetime.strptime(date_str[:10], '%Y-%m-%d')
                            is_august = date_obj.month == 8 and date_obj.year == 2026
                        except:
                            is_august = False
                    else:
                        is_august = False

                    # Si es negativo, guardar
                    if settlement < 0:
                        all_negative_rows.append({
                            'file': csv_file.name,
                            'source_id': row.get('SOURCE_ID', 'N/A'),
                            'transaction_date': row.get('TRANSACTION_DATE', 'N/A'),
                            'settlement_date': row.get('SETTLEMENT_DATE', 'N/A'),
                            'transaction_type': row.get('TRANSACTION_TYPE', 'N/A'),
                            'transaction_amount': row.get('TRANSACTION_AMOUNT', '0'),
                            'settlement_net_amount': settlement_str,
                            'payment_method_type': row.get('PAYMENT_METHOD_TYPE', 'N/A'),
                            'payment_method_id': row.get('PAYMENT_METHOD_ID', 'N/A'),
                            'business_unit': row.get('BUSINESS_UNIT', 'N/A'),
                            'sub_unit': row.get('SUB_UNIT', 'N/A'),
                            'operation_tags': row.get('OPERATION_TAGS', 'N/A'),
                            'payer_name': row.get('PAYER_NAME', 'N/A'),
                        })
                        file_negative_count += 1
                        file_negative_sum += settlement

                        tx_type = row.get('TRANSACTION_TYPE', 'UNKNOWN')
                        negative_by_type[tx_type].append(settlement)

                        if is_august:
                            file_august_count += 1
                            august_rows.append(all_negative_rows[-1])

                except Exception as e:
                    pass

        if file_negative_count > 0:
            print(f"  [INFO] Filas negativas: {file_negative_count}")
            print(f"  [MONEY] Suma negativa: ${file_negative_sum:,.2f}")
            print(f"  [DATE] Negativas en agosto: {file_august_count}")

    except Exception as e:
        print(f"  [ERROR] Error leyendo {csv_file.name}: {e}")

# ============================================================================
# RESUMEN GLOBAL
# ============================================================================

print("\n" + "="*100)
print("RESUMEN: OPERACIONES NEGATIVAS GLOBALES")
print("="*100)

print(f"\n[1] TOTAL DE FILAS NEGATIVAS: {len(all_negative_rows)}")

total_negative = sum(Decimal(row['settlement_net_amount'].replace(',', '.') or 0)
                     for row in all_negative_rows)
print(f"[2] SUMA TOTAL NEGATIVO: ${total_negative:,.2f}")

print(f"\n[3] NEGATIVAS EN AGOSTO: {len(august_rows)}")
august_negative_total = sum(Decimal(row['settlement_net_amount'].replace(',', '.') or 0)
                            for row in august_rows)
print(f"    Suma agosto: ${august_negative_total:,.2f}")

print(f"\n[4] DISTRIBUCIÓN POR TRANSACTION_TYPE (TODAS LAS NEGATIVAS):")
for tx_type in sorted(negative_by_type.keys()):
    count = len(negative_by_type[tx_type])
    total = sum(negative_by_type[tx_type])
    print(f"    {tx_type:20} | {count:5} | ${total:,.2f}")

# ============================================================================
# OPERACIONES CANDIDATAS (agosto, negativas)
# ============================================================================

print(f"\n" + "="*100)
print(f"DETALLE: OPERACIONES NEGATIVAS EN AGOSTO (Candidatas a transferencias faltantes)")
print(f"="*100)

if august_rows:
    print(f"\nEncontradas {len(august_rows)} operaciones negativas en agosto:\n")

    for i, row in enumerate(august_rows, 1):
        print(f"\n[{i}] {row['source_id']}")
        print(f"    Fecha transacción: {row['transaction_date']}")
        print(f"    Fecha liquidación: {row['settlement_date']}")
        print(f"    Tipo: {row['transaction_type']}")
        print(f"    Monto transacción: {row['transaction_amount']}")
        print(f"    SETTLEMENT_NET_AMOUNT: {row['settlement_net_amount']}")
        print(f"    Método pago: {row['payment_method_type']} / {row['payment_method_id']}")
        print(f"    Negocio: {row['business_unit']} / {row['sub_unit']}")
        print(f"    Tags: {row['operation_tags']}")
        print(f"    Pagador: {row['payer_name']}")
else:
    print("\n[ERROR] NO SE ENCONTRARON operaciones negativas en agosto en los CSV")

# ============================================================================
# COMPARACIÓN CON FALTA DETECTADA
# ============================================================================

print(f"\n" + "="*100)
print("CONCLUSIÓN")
print(f"="*100)

falta_reportada = Decimal('10904815.30')
print(f"\nFalta según auditoría Supabase: ${falta_reportada:,.2f}")
print(f"Negativas en agosto encontradas: ${august_negative_total:,.2f}")

if august_negative_total == falta_reportada:
    print(f"\n[OK] COINCIDENCIA EXACTA: Las operaciones negativas en CSV son exactamente las faltantes")
elif august_rows:
    diferencia = abs(falta_reportada - august_negative_total)
    print(f"\n[WARNING]  Diferencia: ${diferencia:,.2f}")
    print(f"   Status: Las operaciones ESTÁN en los CSV pero NO fueron importadas")
else:
    print(f"\n[ERROR] No hay operaciones negativas de agosto en los CSV")
    print(f"   Status: Las operaciones NO aparecen en los CSV originales")

print("\n" + "="*100 + "\n")
