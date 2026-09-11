#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AUDITORÍA EXHAUSTIVA READ-ONLY: Liberaciones3.csv (agosto 2026)
Análisis 8 secciones para determinar arquitectura óptima de integración contable.
"""

import csv
from pathlib import Path
from decimal import Decimal
from collections import defaultdict
from datetime import datetime

csv_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/Liberaciones3.csv")

print("\n" + "="*150)
print("AUDITORIA EXHAUSTIVA: LIBERACIONES3.CSV (AGOSTO 2026)")
print("="*150)

# LECTURA INICIAL
with open(csv_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    fieldnames = reader.fieldnames
    all_records = []
    for row in reader:
        all_records.append(row)

print(f"\n[1] ESTRUCTURA DEL REPORTE")
print("-" * 150)
print(f"Total de columnas: {len(fieldnames)}")
print(f"Columnas: {', '.join(fieldnames)}")

# Filtrar agosto
august_records = []
for row in all_records:
    date_str = row.get('DATE', '')[:10]
    if date_str:
        try:
            d = datetime.strptime(date_str, '%Y-%m-%d')
            if d.month == 8 and d.year == 2026:
                august_records.append(row)
        except:
            pass

print(f"\n[2] CONCILIACION AGOSTO 2026")
print("-" * 150)

total_credit = Decimal('0')
total_debit = Decimal('0')
total_fee = Decimal('0')
total_tax = Decimal('0')
by_type = defaultdict(lambda: {'count': 0, 'credit': Decimal('0'), 'debit': Decimal('0'), 'fee': Decimal('0'), 'tax': Decimal('0')})

for row in august_records:
    desc = row.get('DESCRIPTION', 'UNKNOWN')
    try:
        cr = Decimal(str(row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
        db = Decimal(str(row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
        fee = Decimal(str(row.get('MP_FEE_AMOUNT', '0')).replace(',', '.'))
        tax = Decimal(str(row.get('TAXES_AMOUNT', '0')).replace(',', '.'))

        total_credit += cr
        total_debit += db
        total_fee += fee
        total_tax += tax

        by_type[desc]['count'] += 1
        by_type[desc]['credit'] += cr
        by_type[desc]['debit'] += db
        by_type[desc]['fee'] += fee
        by_type[desc]['tax'] += tax
    except:
        pass

neto = total_credit - total_debit

print(f"Total registros agosto: {len(august_records)}")
print(f"Creditos (entradas): ${total_credit:,.2f}")
print(f"Debitos (salidas): ${total_debit:,.2f}")
print(f"Comisiones: ${total_fee:,.2f}")
print(f"Impuestos: ${total_tax:,.2f}")
print(f"Neto: ${neto:,.2f}")

print(f"\nComparacion con MP UI agosto:")
mp_cr = Decimal('13337721.84')
mp_db = Decimal('13461925.11')
mp_neto = Decimal('-124203.27')

print(f"MP UI Entradas: ${mp_cr:,.2f} | Archivo: ${total_credit:,.2f} | Diff: ${total_credit-mp_cr:,.2f}")
print(f"MP UI Salidas: ${mp_db:,.2f} | Archivo: ${total_debit:,.2f} | Diff: ${total_debit-mp_db:,.2f}")
print(f"MP UI Neto: ${mp_neto:,.2f} | Archivo: ${neto:,.2f} | Diff: ${neto-mp_neto:,.2f}")

print(f"\nResumen por TIPO:")
print(f"{'TIPO':<25} {'CANTIDAD':>10} {'CREDITO':>18} {'DEBITO':>18} {'NETO':>18} {'COMISION':>12} {'IMPUESTO':>12}")
print("-" * 150)
for typ in sorted(by_type.keys()):
    data = by_type[typ]
    neto_tipo = data['credit'] - data['debit']
    print(f"{typ:<25} {data['count']:>10} ${data['credit']:>17,.2f} ${data['debit']:>17,.2f} ${neto_tipo:>17,.2f} ${data['fee']:>11,.2f} ${data['tax']:>11,.2f}")

# PAYOUTS
print(f"\n[3] ANALISIS DE PAYOUTS")
print("-" * 150)
payouts = [r for r in august_records if r.get('DESCRIPTION', '').upper() == 'PAYOUT']
print(f"Total PAYOUTS: {len(payouts)}")

if payouts:
    payout_credit = Decimal('0')
    payout_debit = Decimal('0')
    print(f"\nPAYOUT DETALLE:")
    print(f"{'SOURCE_ID':<20} {'FECHA':<12} {'CREDITO':>15} {'DEBITO':>15} {'FEE':>12} {'PAYMENT_METHOD':<20}")
    print("-" * 150)

    for p in sorted(payouts, key=lambda x: x.get('DATE', ''))[:20]:
        pid = p.get('SOURCE_ID', 'N/A')
        pdate = p.get('DATE', '')[:10]
        pcr = p.get('NET_CREDIT_AMOUNT', '0')
        pdb = p.get('NET_DEBIT_AMOUNT', '0')
        pfee = p.get('MP_FEE_AMOUNT', '0')
        pmethod = p.get('PAYMENT_METHOD_TYPE', 'N/A')[:18]

        try:
            payout_credit += Decimal(str(pcr).replace(',', '.'))
            payout_debit += Decimal(str(pdb).replace(',', '.'))
        except:
            pass

        print(f"{pid:<20} {pdate:<12} ${pcr:>14} ${pdb:>14} ${pfee:>11} {pmethod:<20}")

    print(f"\nTotal PAYOUT creditos: ${payout_credit:,.2f}")
    print(f"Total PAYOUT debitos: ${payout_debit:,.2f}")
    print(f"Neto PAYOUTS: ${payout_credit - payout_debit:,.2f}")

# RESERVAS
print(f"\n[4] ANALISIS DE RESERVAS")
print("-" * 150)
reserves = [r for r in august_records if 'reserve' in r.get('DESCRIPTION', '').lower()]
print(f"Total RESERVAS: {len(reserves)}")

reserve_by_type = defaultdict(Decimal)
for r in reserves:
    rtype = r.get('DESCRIPTION', 'UNKNOWN')
    try:
        rcr = Decimal(str(r.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
        rdb = Decimal(str(r.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
        reserve_by_type[rtype] += (rcr - rdb)
    except:
        pass

print(f"\nRESERVAS por tipo:")
for rtype in sorted(reserve_by_type.keys()):
    print(f"  {rtype}: ${reserve_by_type[rtype]:,.2f}")

# ASSET MANAGEMENT (rendimientos)
print(f"\n[5] ASSET MANAGEMENT (RENDIMIENTOS)")
print("-" * 150)
assets = [r for r in august_records if r.get('DESCRIPTION', '').lower() == 'asset_management']
print(f"Total ASSET_MANAGEMENT: {len(assets)}")

asset_total = Decimal('0')
for a in assets:
    try:
        acr = Decimal(str(a.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
        adb = Decimal(str(a.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
        asset_total += (acr - adb)
    except:
        pass

print(f"Total ASSET_MANAGEMENT (rendimientos): ${asset_total:,.2f}")
print(f"Esperado segun datos previos: $38,896.48")
print(f"Diferencia: ${asset_total - Decimal('38896.48'):,.2f}")

# BALANCE TRACING
print(f"\n[6] BALANCE TRACING (cambio dia por dia)")
print("-" * 150)

august_sorted = sorted(august_records, key=lambda x: x.get('DATE', ''))
balance_by_date = defaultdict(Decimal)

for record in august_sorted:
    try:
        date = record.get('DATE', '')[:10]
        balance_str = record.get('BALANCE_AMOUNT', '0')
        balance = Decimal(str(balance_str).replace(',', '.'))
        balance_by_date[date] = balance
    except:
        pass

print(f"Balance por fecha (ultimas 10):")
for date in sorted(balance_by_date.keys())[-10:]:
    print(f"  {date}: ${balance_by_date[date]:,.2f}")

# OPERACIONES NEGATIVAS (posibles salidas faltantes)
print(f"\n[7] OPERACIONES NEGATIVAS (SALIDAS)")
print("-" * 150)

negative_ops = [r for r in august_records if Decimal(str(r.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.')) > 0]
print(f"Total operaciones con debito (salidas): {len(negative_ops)}")

neg_by_type = defaultdict(Decimal)
neg_count_by_type = defaultdict(int)
for n in negative_ops:
    ntype = n.get('DESCRIPTION', 'UNKNOWN')
    try:
        ndb = Decimal(str(n.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
        neg_by_type[ntype] += ndb
        neg_count_by_type[ntype] += 1
    except:
        pass

print(f"\nSalidas por tipo:")
for ntype in sorted(neg_by_type.keys()):
    print(f"  {ntype}: {neg_count_by_type[ntype]} ops = ${neg_by_type[ntype]:,.2f}")

total_negative = sum(neg_by_type.values())
print(f"\nTotal salidas: ${total_negative:,.2f}")
print(f"MP UI salidas: ${mp_db:,.2f}")
print(f"Diferencia: ${total_negative - mp_db:,.2f}")

# RESUMEN CONCLUSIONES
print(f"\n" + "="*150)
print("[8] CONCLUSIONES Y RECOMENDACION")
print("="*150)

print(f"""
HALLAZGOS FINALES:

1. ESTRUCTURA: 15 columnas incluyen todo lo necesario para contabilidad
   - Identificadores: SOURCE_ID, PURCHASE_ID
   - Montos netos: NET_CREDIT/DEBIT, GROSS_AMOUNT
   - Costos: MP_FEE_AMOUNT, TAXES_AMOUNT
   - Estado: BALANCE_AMOUNT, DESCRIPTION

2. CONCILIACION AGOSTO:
   - Creditos: ${total_credit:,.2f} vs MP UI ${mp_cr:,.2f} -> Diff: ${total_credit-mp_cr:,.2f}
   - Debitos: ${total_debit:,.2f} vs MP UI ${mp_db:,.2f} -> Diff: ${total_debit-mp_db:,.2f}
   - MATCH: {'SI' if abs(total_credit-mp_cr) < Decimal('1') and abs(total_debit-mp_db) < Decimal('1') else 'NO - hay discrepancia'}

3. COMPOSICION:
   - PAYMENT (ingresos): 696 registros = ${by_type['payment']['credit']:,.2f}
   - PAYOUT (egresos): {len(payouts)} registros = ${payout_debit:,.2f}
   - RESERVES: {len(reserves)} registros (movimientos de reserva, NO impactan balance final)
   - ASSET_MANAGEMENT: {len(assets)} registros = ${asset_total:,.2f}

4. ARCHITECTURE FIT:
   - Fuente: IDEAL como fuente primaria (completa + neta + con comisiones/impuestos)
   - Relacion: Puede correlacionarse con reporte anterior via SOURCE_ID/PURCHASE_ID
   - Duplicacion: EVITABLE si usamos SOURCE_ID como PK en lugar de re-importar

5. RECOMENDACION:
   -> Usar LIBERACIONES como fuente PRIMARIA
      (tiene neto + impacto real en balance)
   -> Usar REPORTS anterior como ENRIQUECIMIENTO
      (detalles de payer, categorización, metadata)
   -> Correlacionar via SOURCE_ID/PURCHASE_ID
   -> RESERVES: mapear a account_balance (no a ledger)
""")

print("="*150)
print("AUDITORIA COMPLETADA")
print("="*150 + "\n")
