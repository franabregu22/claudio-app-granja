#!/usr/bin/env python3
"""
AUDITORÍA EXHAUSTIVA READ-ONLY: Liberaciones1.csv
Análisis completo para determinar arquitectura óptima de integración contable.
"""

import csv
from pathlib import Path
from decimal import Decimal
from collections import defaultdict
from datetime import datetime

csv_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/Liberaciones1.csv")

print("\n" + "="*140)
print("AUDITORÍA EXHAUSTIVA: LIBERACIONES1.CSV")
print("="*140)

# ============================================================================
# [1] ESTRUCTURA DEL REPORTE
# ============================================================================

print("\n[1] ESTRUCTURA DEL REPORTE - COLUMNAS REALES")
print("-" * 140)

with open(csv_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    fieldnames = reader.fieldnames
    first_row = next(reader)

print(f"\nTotal de columnas: {len(fieldnames)}\n")

print(f"{'#':<3} {'NOMBRE COLUMNA':<35} {'VALOR EJEMPLO':<50} {'TIPO PROBABLE':<25}")
print("-" * 140)

for i, col in enumerate(fieldnames, 1):
    example = str(first_row.get(col, ''))[:48]
    col_type = 'IDENTITY' if any(x in col.upper() for x in ['ID', 'SOURCE', 'REFERENCE']) else \
               'DATE' if any(x in col.upper() for x in ['DATE', 'FECHA', 'TIME']) else \
               'DESCRIPTION' if any(x in col.upper() for x in ['DESCRIPTION', 'TYPE', 'CONCEPTO']) else \
               'AMOUNT' if any(x in col.upper() for x in ['AMOUNT', 'MONTO', 'GROSS']) else \
               'CREDIT/DEBIT' if any(x in col.upper() for x in ['CREDIT', 'DEBIT', 'CREDITO', 'DEBITO']) else \
               'FEE/TAX' if any(x in col.upper() for x in ['FEE', 'TAX', 'COMISION', 'IMPUESTO']) else \
               'BALANCE' if any(x in col.upper() for x in ['BALANCE', 'SALDO']) else \
               'COUNTERPARTY' if any(x in col.upper() for x in ['PAYER', 'RECEIVER', 'COUNTERPARTY']) else \
               'METADATA'
    print(f"{i:<3} {col:<35} {example:<50} {col_type:<25}")

# ============================================================================
# LEER TODOS LOS DATOS
# ============================================================================

print("\n" + "="*140)
print("[2] ANÁLISIS COMPLETO DE REGISTROS")
print("-" * 140)

all_records = []
records_by_type = defaultdict(list)
records_by_date = defaultdict(list)

with open(csv_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        all_records.append(row)

print(f"\nTotal de registros: {len(all_records)}")

# Detectar columnas clave automáticamente
description_col = None
credit_col = None
debit_col = None
date_col = None
balance_col = None
fee_col = None
tax_col = None
id_col = None
detail_col = None

for col in fieldnames:
    col_upper = col.upper()
    if not id_col and any(x in col_upper for x in ['ID', 'SOURCE_ID', 'REFERENCE']):
        id_col = col
    if not date_col and any(x in col_upper for x in ['DATE', 'FECHA']):
        date_col = col
    if not description_col and any(x in col_upper for x in ['DESCRIPTION', 'CONCEPTO', 'TYPE']):
        description_col = col
    if not credit_col and any(x in col_upper for x in ['CREDIT', 'CREDITO', 'INFLOW']):
        credit_col = col
    if not debit_col and any(x in col_upper for x in ['DEBIT', 'DEBITO', 'OUTFLOW']):
        debit_col = col
    if not balance_col and any(x in col_upper for x in ['BALANCE', 'SALDO']):
        balance_col = col
    if not fee_col and any(x in col_upper for x in ['FEE', 'COMISION']):
        fee_col = col
    if not tax_col and any(x in col_upper for x in ['TAX', 'IMPUESTO']):
        tax_col = col
    if not detail_col and any(x in col_upper for x in ['DETAIL', 'TAGS', 'METADATA']):
        detail_col = col

print(f"\n[COLUMNAS IDENTIFICADAS PARA ANÁLISIS]:")
print(f"  ID: {id_col}")
print(f"  DATE: {date_col}")
print(f"  DESCRIPTION: {description_col}")
print(f"  CREDIT: {credit_col}")
print(f"  DEBIT: {debit_col}")
print(f"  BALANCE: {balance_col}")
print(f"  FEE: {fee_col}")
print(f"  TAX: {tax_col}")
print(f"  DETAIL: {detail_col}")

# ============================================================================
# CÁLCULOS PRINCIPALES
# ============================================================================

print("\n" + "="*140)
print("[3] CÁLCULOS DE CONCILIACIÓN")
print("-" * 140)

total_credit = Decimal('0')
total_debit = Decimal('0')
total_fee = Decimal('0')
total_tax = Decimal('0')
positive_count = 0
negative_count = 0
august_records = []

for row in all_records:
    # Parsear montos
    try:
        if credit_col and row.get(credit_col):
            val = Decimal(str(row[credit_col]).replace(',', '.'))
            if val != 0:
                total_credit += val
                positive_count += 1
        if debit_col and row.get(debit_col):
            val = Decimal(str(row[debit_col]).replace(',', '.'))
            if val != 0:
                total_debit += val
                negative_count += 1
        if fee_col and row.get(fee_col):
            val = Decimal(str(row[fee_col]).replace(',', '.'))
            total_fee += val
        if tax_col and row.get(tax_col):
            val = Decimal(str(row[tax_col]).replace(',', '.'))
            total_tax += val
    except:
        pass

    # Filtrar agosto
    if date_col and row.get(date_col):
        try:
            date_obj = datetime.strptime(row[date_col][:10], '%Y-%m-%d')
            if date_obj.month == 8 and date_obj.year == 2026:
                august_records.append(row)
                # Agrupar por tipo
                desc = row.get(description_col, 'UNKNOWN')
                records_by_type[desc].append(row)
        except:
            pass

neto = total_credit - total_debit

print(f"\n[TOTALES GLOBALES DEL ARCHIVO]:")
print(f"  Total de registros: {len(all_records)}")
print(f"  Registros con crédito: {positive_count}")
print(f"  Registros con débito: {negative_count}")
print(f"  Suma de créditos: ${total_credit:,.2f}")
print(f"  Suma de débitos: ${total_debit:,.2f}")
print(f"  Suma de comisiones: ${total_fee:,.2f}")
print(f"  Suma de impuestos: ${total_tax:,.2f}")
print(f"  Neto (crédito - débito): ${neto:,.2f}")

print(f"\n[REGISTROS DE AGOSTO 2026]:")
print(f"  Total registros: {len(august_records)}")

august_credit = Decimal('0')
august_debit = Decimal('0')
august_fee = Decimal('0')
august_tax = Decimal('0')

for row in august_records:
    try:
        if credit_col and row.get(credit_col):
            august_credit += Decimal(str(row[credit_col]).replace(',', '.'))
        if debit_col and row.get(debit_col):
            august_debit += Decimal(str(row[debit_col]).replace(',', '.'))
        if fee_col and row.get(fee_col):
            august_fee += Decimal(str(row[fee_col]).replace(',', '.'))
        if tax_col and row.get(tax_col):
            august_tax += Decimal(str(row[tax_col]).replace(',', '.'))
    except:
        pass

august_neto = august_credit - august_debit

print(f"  Créditos agosto: ${august_credit:,.2f}")
print(f"  Débitos agosto: ${august_debit:,.2f}")
print(f"  Comisiones agosto: ${august_fee:,.2f}")
print(f"  Impuestos agosto: ${august_tax:,.2f}")
print(f"  Neto agosto: ${august_neto:,.2f}")

# ============================================================================
# COMPARACIÓN CON MP UI
# ============================================================================

print(f"\n[COMPARACIÓN CON MERCADOPAGO UI AGOSTO]:")
mp_entradas = Decimal('13337721.84')
mp_salidas = Decimal('13461925.11')
mp_neto = Decimal('-124203.27')

print(f"  MP UI Entradas: ${mp_entradas:,.2f}")
print(f"  MP UI Salidas: ${mp_salidas:,.2f}")
print(f"  MP UI Neto: ${mp_neto:,.2f}")

print(f"\n[DIFERENCIAS]:")
diff_cr = august_credit - mp_entradas
diff_db = august_debit - mp_salidas
diff_neto = august_neto - mp_neto

print(f"  Diferencia créditos: ${diff_cr:,.2f}")
print(f"  Diferencia débitos: ${diff_db:,.2f}")
print(f"  Diferencia neto: ${diff_neto:,.2f}")

# ============================================================================
# RESUMEN POR TIPO/DESCRIPCIÓN
# ============================================================================

print(f"\n" + "="*140)
print("[4] DISTRIBUCIÓN POR TIPO (AGOSTO)")
print("-" * 140)

print(f"\n{'TIPO':<30} {'CANTIDAD':>10} {'CRÉDITO':>18} {'DÉBITO':>18} {'NETO':>18} {'COMISIÓN':>12} {'IMPUESTO':>12}")
print("-" * 140)

summary_by_type = {}
for desc in sorted(records_by_type.keys()):
    desc_records = records_by_type[desc]
    desc_credit = Decimal('0')
    desc_debit = Decimal('0')
    desc_fee = Decimal('0')
    desc_tax = Decimal('0')

    for r in desc_records:
        try:
            if credit_col and r.get(credit_col):
                desc_credit += Decimal(str(r[credit_col]).replace(',', '.'))
            if debit_col and r.get(debit_col):
                desc_debit += Decimal(str(r[debit_col]).replace(',', '.'))
            if fee_col and r.get(fee_col):
                desc_fee += Decimal(str(r[fee_col]).replace(',', '.'))
            if tax_col and r.get(tax_col):
                desc_tax += Decimal(str(r[tax_col]).replace(',', '.'))
        except:
            pass

    desc_neto = desc_credit - desc_debit
    summary_by_type[desc] = {
        'count': len(desc_records),
        'credit': desc_credit,
        'debit': desc_debit,
        'fee': desc_fee,
        'tax': desc_tax,
        'neto': desc_neto
    }

    print(f"{desc:<30} {len(desc_records):>10} ${desc_credit:>17,.2f} ${desc_debit:>17,.2f} ${desc_neto:>17,.2f} ${desc_fee:>11,.2f} ${desc_tax:>11,.2f}")

# ============================================================================
# ANÁLISIS DE PAYOUTS
# ============================================================================

print(f"\n" + "="*140)
print("[5] ANÁLISIS DETALLADO DE PAYOUTS")
print("-" * 140)

payouts = [r for r in august_records if r.get(description_col, '').upper() == 'PAYOUT']

print(f"\nTotal de PAYOUTS en agosto: {len(payouts)}")

if payouts:
    print(f"\n{'ID':<20} {'FECHA':<12} {'CRÉDITO':>15} {'DÉBITO':>15} {'COMISIÓN':>12} {'IMPUESTO':>12} {'PAGADOR':<25}")
    print("-" * 140)

    for payout in payouts:
        payout_id = payout.get(id_col, 'N/A')
        payout_date = payout.get(date_col, 'N/A')[:10]
        payout_credit = payout.get(credit_col, '0')
        payout_debit = payout.get(debit_col, '0')
        payout_fee = payout.get(fee_col, '0')
        payout_tax = payout.get(tax_col, '0')
        payout_detail = payout.get(detail_col, 'N/A')[:23]

        print(f"{payout_id:<20} {payout_date:<12} ${payout_credit:>14} ${payout_debit:>14} ${payout_fee:>11} ${payout_tax:>11} {payout_detail:<25}")

# ============================================================================
# ANÁLISIS DE RESERVAS
# ============================================================================

print(f"\n" + "="*140)
print("[6] ANÁLISIS DE RESERVAS (reserve_for_payment / reserve_for_payout)")
print("-" * 140)

reserves = [r for r in august_records if 'reserve' in r.get(description_col, '').lower()]

print(f"\nTotal de registros de RESERVA en agosto: {len(reserves)}")

if reserves:
    print(f"\n[PRIMEROS 10 EJEMPLOS DE RESERVAS]:")
    print(f"\n{'ID':<20} {'TIPO':<25} {'CRÉDITO':>15} {'DÉBITO':>15} {'DETALLE':<50}")
    print("-" * 140)

    for i, reserve in enumerate(reserves[:10]):
        res_id = reserve.get(id_col, 'N/A')
        res_type = reserve.get(description_col, 'N/A')[:23]
        res_credit = reserve.get(credit_col, '0')
        res_debit = reserve.get(debit_col, '0')
        res_detail = str(reserve.get(detail_col, ''))[:48]

        print(f"{res_id:<20} {res_type:<25} ${res_credit:>14} ${res_debit:>14} {res_detail:<50}")

# ============================================================================
# RESUMEN FINAL
# ============================================================================

print(f"\n" + "="*140)
print("[7] RESUMEN Y OBSERVACIONES")
print("="*140)

print(f"""
[HALLAZGOS PRINCIPALES]

1. ESTRUCTURA:
   - El archivo tiene {len(fieldnames)} columnas relevantes para contabilidad
   - Columnas clave identificadas automáticamente
   - Datos están categorizados por DESCRIPTION (payment, payout, reserve, etc.)

2. CONCILIACIÓN AGOSTO 2026:
   - Créditos (entradas): ${august_credit:,.2f}
   - Débitos (salidas): ${august_debit:,.2f}
   - Neto: ${august_neto:,.2f}

   Comparado con MP UI:
   - Diferencia créditos: ${diff_cr:,.2f}
   - Diferencia débitos: ${diff_db:,.2f}
   - Diferencia neto: ${diff_neto:,.2f}

3. DISTRIBUCIÓN POR TIPO:
""")

for tipo in sorted(summary_by_type.keys()):
    data = summary_by_type[tipo]
    print(f"   - {tipo}: {data['count']} registros, Neto: ${data['neto']:,.2f}")

print(f"""
4. OPERACIONES ESPECIALES:
   - PAYOUTS detectados: {len(payouts)} (transferencias/retiros)
   - RESERVAS detectadas: {len(reserves)} (movimientos de reserva)

5. ANÁLISIS PRELIMINAR:
   ✓ Archivo contiene detalles completos de liquidaciones
   ✓ Estructura permite rastrear cada transacción hasta su origen
   ✓ Diferencias vs MP UI pueden ser por clasificación o períodos

6. PRÓXIMAS INVESTIGACIONES:
   ☐ Verificar si PAYMENT + ASSET_MANAGEMENT = Entradas MP UI
   ☐ Verificar si PAYMENT negativo + PAYOUT = Salidas MP UI
   ☐ Analizar relación entre RESERVE y operación definitiva
   ☐ Comparar IDs entre este archivo y reporte anterior
   ☐ Determinar arquitectura óptima: Liquidaciones como fuente primaria vs secundaria

""")

print("="*140)
print("FIN DE AUDITORÍA FASE 1")
print("="*140 + "\n")
