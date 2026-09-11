#!/usr/bin/env python3
"""
AUDITORÍA EXHAUSTIVA: Liquidaciones MercadoPago agosto 2026
READ-ONLY analysis para determinar arquitectura óptima de integración contable.

Discrepancia actual:
- MP UI agosto: Entradas $13.337.721,84 | Salidas $13.461.925,11 | Neto -$124.203,27
- Supabase: Entradas $13.337.721,86 | Salidas $2.557.109,81 | Falta $10.904.815,30 en salidas
"""

import csv
from pathlib import Path
from decimal import Decimal
from collections import defaultdict
from datetime import datetime

csv_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/liquidaciones-agosto-2026.csv")

print("\n" + "="*120)
print("AUDITORÍA EXHAUSTIVA: LIQUIDACIONES MERCADOPAGO AGOSTO 2026")
print("="*120)

# ============================================================================
# [1] ESTRUCTURA DEL REPORTE
# ============================================================================

print("\n[1] ESTRUCTURA DEL REPORTE")
print("-" * 120)

with open(csv_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    fieldnames = reader.fieldnames

print(f"\nTotal de columnas: {len(fieldnames)}")
print(f"\nNombres de columnas reales:")
for i, col in enumerate(fieldnames, 1):
    print(f"  {i:2}. {col}")

# Identificar columnas relevantes
print(f"\n[COLUMNAS IDENTIFICADAS]:")
relevant_cols = {
    'identity': [],
    'date': [],
    'type_desc': [],
    'amounts': [],
    'credits_debits': [],
    'fees': [],
    'taxes': [],
    'balance': [],
    'counterparty': [],
    'bank_account': [],
    'payment_method': [],
    'tags': [],
    'metadata': []
}

for col in fieldnames:
    col_upper = col.upper()
    if any(x in col_upper for x in ['ID', 'SOURCE', 'REFERENCE']):
        relevant_cols['identity'].append(col)
    elif any(x in col_upper for x in ['DATE', 'TIME', 'FECHA']):
        relevant_cols['date'].append(col)
    elif any(x in col_upper for x in ['DESCRIPTION', 'TYPE', 'CONCEPT']):
        relevant_cols['type_desc'].append(col)
    elif any(x in col_upper for x in ['AMOUNT', 'GROSS', 'MONTO']):
        relevant_cols['amounts'].append(col)
    elif any(x in col_upper for x in ['CREDIT', 'DEBIT', 'CREDITO', 'DEBITO']):
        relevant_cols['credits_debits'].append(col)
    elif any(x in col_upper for x in ['FEE', 'COMISION']):
        relevant_cols['fees'].append(col)
    elif any(x in col_upper for x in ['TAX', 'IMPUESTO']):
        relevant_cols['taxes'].append(col)
    elif any(x in col_upper for x in ['BALANCE', 'SALDO']):
        relevant_cols['balance'].append(col)
    elif any(x in col_upper for x in ['COUNTERPARTY', 'PAYER', 'RECEIVER']):
        relevant_cols['counterparty'].append(col)
    elif any(x in col_upper for x in ['BANK', 'ACCOUNT', 'CUENTA']):
        relevant_cols['bank_account'].append(col)
    elif any(x in col_upper for x in ['PAYMENT', 'METHOD']):
        relevant_cols['payment_method'].append(col)
    elif any(x in col_upper for x in ['TAG', 'ETIQUETA']):
        relevant_cols['tags'].append(col)
    elif any(x in col_upper for x in ['METADATA', 'DETAIL', 'EXTRA']):
        relevant_cols['metadata'].append(col)

for category, cols in relevant_cols.items():
    if cols:
        print(f"\n{category.upper()}:")
        for col in cols:
            print(f"  - {col}")

# ============================================================================
# [2] LECTURA Y CONCILIACIÓN DE AGOSTO
# ============================================================================

print(f"\n" + "="*120)
print("[2] CONCILIACIÓN DE AGOSTO")
print("-" * 120)

records_by_type = defaultdict(list)
all_records = []
total_credit = Decimal('0')
total_debit = Decimal('0')
balance_values = []
record_count = 0
positives = 0
negatives = 0

# Detectar qué columna tiene el monto/descripción
description_col = None
amount_col = None
credit_col = None
debit_col = None
balance_col = None
date_col = None

# Búsqueda heurística
for col in fieldnames:
    if 'DESCRIPTION' in col.upper() or 'CONCEPTO' in col.upper():
        description_col = col
    if 'GROSS' in col.upper() or 'MONTO' in col.upper():
        amount_col = col
    if 'CREDIT' in col.upper():
        credit_col = col
    if 'DEBIT' in col.upper():
        debit_col = col
    if 'BALANCE' in col.upper():
        balance_col = col
    if 'DATE' in col.upper() or 'FECHA' in col.upper():
        date_col = col

print(f"\nColumnas detectadas para análisis:")
print(f"  DESCRIPTION: {description_col}")
print(f"  AMOUNT: {amount_col}")
print(f"  CREDIT: {credit_col}")
print(f"  DEBIT: {debit_col}")
print(f"  BALANCE: {balance_col}")
print(f"  DATE: {date_col}")

# Leer registros
with open(csv_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        record_count += 1
        all_records.append(row)

        # Parsear montos
        try:
            if credit_col and row.get(credit_col):
                credit = Decimal(str(row[credit_col]).replace(',', '.'))
                total_credit += credit
                positives += 1
            elif debit_col and row.get(debit_col):
                debit = Decimal(str(row[debit_col]).replace(',', '.'))
                total_debit += debit
                negatives += 1
        except:
            pass

        # Guardar por tipo
        desc = row.get(description_col, 'UNKNOWN')
        records_by_type[desc].append(row)

neto = total_credit - total_debit

print(f"\n[TOTALES]:")
print(f"  Total de registros: {record_count}")
print(f"  Registros positivos (créditos): {positives}")
print(f"  Registros negativos (débitos): {negatives}")
print(f"  Suma de créditos: ${total_credit:,.2f}")
print(f"  Suma de débitos: ${total_debit:,.2f}")
print(f"  Neto: ${neto:,.2f}")

print(f"\n[COMPARACIÓN CON MP UI AGOSTO]:")
mp_entradas = Decimal('13337721.84')
mp_salidas = Decimal('13461925.11')
mp_neto = Decimal('-124203.27')

print(f"  MP UI Entradas: ${mp_entradas:,.2f}")
print(f"  MP UI Salidas: ${mp_salidas:,.2f}")
print(f"  MP UI Neto: ${mp_neto:,.2f}")

diff_entradas = total_credit - mp_entradas
diff_salidas = total_debit - mp_salidas
diff_neto = neto - mp_neto

print(f"\n[DIFERENCIAS]:")
print(f"  Diferencia en entradas: ${diff_entradas:,.2f}")
print(f"  Diferencia en salidas: ${diff_salidas:,.2f}")
print(f"  Diferencia en neto: ${diff_neto:,.2f}")

# Resumen por DESCRIPTION
print(f"\n[TOTALES POR TIPO/DESCRIPCIÓN]:")
print(f"{'TIPO':<30} {'CANTIDAD':>10} {'CRÉDITO':>15} {'DÉBITO':>15} {'NETO':>15}")
print("-" * 85)

summary_data = {}
for desc in sorted(records_by_type.keys()):
    desc_records = records_by_type[desc]
    desc_credit = Decimal('0')
    desc_debit = Decimal('0')
    desc_count = len(desc_records)

    for r in desc_records:
        try:
            if credit_col and r.get(credit_col):
                desc_credit += Decimal(str(r[credit_col]).replace(',', '.'))
            if debit_col and r.get(debit_col):
                desc_debit += Decimal(str(r[debit_col]).replace(',', '.'))
        except:
            pass

    desc_neto = desc_credit - desc_debit
    summary_data[desc] = {'count': desc_count, 'credit': desc_credit, 'debit': desc_debit, 'neto': desc_neto}

    print(f"{desc:<30} {desc_count:>10} ${desc_credit:>14,.2f} ${desc_debit:>14,.2f} ${desc_neto:>14,.2f}")

print("\n" + "="*120)
print("ANÁLISIS COMPLETO CONTINUARÁ EN PRÓXIMA EJECUCIÓN...")
print("="*120 + "\n")
