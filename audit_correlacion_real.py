#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AUDITORÍA EMPÍRICA READ-ONLY: Correlación real entre Account Money (arch5) y Liquidaciones3
Análisis de deduplicación inteligente antes de implementar RPC.
"""

import csv
from pathlib import Path
from decimal import Decimal
from collections import defaultdict
from datetime import datetime

# Rutas
arch5_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/arch5.csv")
liberaciones_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/Liberaciones3.csv")

print("\n" + "="*200)
print("ANÁLISIS DE CORRELACIÓN REAL: Account Money vs Liquidaciones (AGOSTO 2026)")
print("="*200)

# ============================================================================
# [1] LECTURA DE ARCH5 (Account Money)
# ============================================================================

print("\n[1] LEYENDO ACCOUNT MONEY (arch5.csv)")
print("-" * 200)

arch5_records = []
arch5_by_type = defaultdict(list)

with open(arch5_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('TRANSACTION_DATE', '')[:10]
        if date_str and date_str.startswith('2026-08'):
            arch5_records.append(row)
            tx_type = row.get('TRANSACTION_TYPE', 'UNKNOWN')
            arch5_by_type[tx_type].append(row)

print(f"Total registros arch5 agosto: {len(arch5_records)}")
print(f"Distribución por TRANSACTION_TYPE:")
for tx_type in sorted(arch5_by_type.keys()):
    print(f"  {tx_type}: {len(arch5_by_type[tx_type])}")

# ============================================================================
# [2] LECTURA DE LIBERACIONES3
# ============================================================================

print("\n[2] LEYENDO LIQUIDACIONES (Liberaciones3.csv)")
print("-" * 200)

lib_records = []
lib_by_desc = defaultdict(list)

with open(liberaciones_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('DATE', '')[:10]
        if date_str and date_str.startswith('2026-08'):
            lib_records.append(row)
            desc = row.get('DESCRIPTION', 'UNKNOWN')
            lib_by_desc[desc].append(row)

print(f"Total registros Liberaciones agosto: {len(lib_records)}")
print(f"Distribución por DESCRIPTION:")
for desc in sorted(lib_by_desc.keys()):
    print(f"  {desc}: {len(lib_by_desc[desc])}")

# ============================================================================
# [3] CORRELACIÓN PAYMENT: Amount + PURCHASE_ID + SOURCE_ID
# ============================================================================

print("\n" + "="*200)
print("[3] ANÁLISIS PAYMENT: Correlación Account Money vs Liquidaciones")
print("="*200)

arch5_payments = arch5_by_type.get('payment', [])
lib_payments = lib_by_desc.get('payment', [])

print(f"\nAccount Money payments: {len(arch5_payments)}")
print(f"Liquidaciones payments: {len(lib_payments)}")

# Crear índices para búsqueda rápida
lib_by_source_id = {r.get('SOURCE_ID'): r for r in lib_payments}
lib_by_purchase_id = defaultdict(list)
for r in lib_payments:
    pid = r.get('PURCHASE_ID')
    if pid:
        lib_by_purchase_id[pid].append(r)

arch5_by_source_id = {}
arch5_by_purchase_id = defaultdict(list)
for r in arch5_payments:
    # En arch5, el SOURCE_ID puede estar en diferentes columnas
    sid = r.get('SOURCE_ID') or r.get('REFERENCE_ID') or r.get('ID')
    if sid:
        arch5_by_source_id[sid] = r
    pid = r.get('PURCHASE_ID') or r.get('ID_COMPRADOR')
    if pid:
        arch5_by_purchase_id[pid].append(r)

# Matriz de correlación
print(f"\n[MATRIZ DE CORRELACIÓN PAYMENT]")
print(f"\n  Total arch5: {len(arch5_payments)}")
print(f"  Total Liberaciones: {len(lib_payments)}")

source_id_matches = 0
purchase_id_matches = 0
both_match = 0
ambiguous = 0
no_match = 0

correlation_details = []

for lib_p in lib_payments:
    lib_sid = lib_p.get('SOURCE_ID')
    lib_pid = lib_p.get('PURCHASE_ID')
    lib_amt = Decimal(str(lib_p.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
    lib_date = lib_p.get('DATE', '')[:10]

    # Buscar por SOURCE_ID
    match_by_sid = arch5_by_source_id.get(lib_sid)

    # Buscar por PURCHASE_ID
    match_by_pid = arch5_by_purchase_id.get(lib_pid, [])

    # Clasificar
    result = {
        'lib_source_id': lib_sid,
        'lib_purchase_id': lib_pid,
        'lib_amount': lib_amt,
        'lib_date': lib_date,
        'match_type': None,
        'arch5_count': 0,
        'confidence': None
    }

    if match_by_sid and match_by_pid and match_by_sid in [x.get('SOURCE_ID') or x.get('REFERENCE_ID') or x.get('ID') for x in match_by_pid]:
        # Ambos coinciden con la misma fila
        result['match_type'] = 'BOTH_IDS_SAME'
        result['arch5_count'] = 1
        result['confidence'] = 'HIGH'
        both_match += 1
    elif match_by_sid:
        result['match_type'] = 'SOURCE_ID_ONLY'
        result['arch5_count'] = 1
        result['confidence'] = 'HIGH'
        source_id_matches += 1
    elif match_by_pid:
        result['match_type'] = 'PURCHASE_ID_ONLY'
        result['arch5_count'] = len(match_by_pid)
        if len(match_by_pid) > 1:
            result['confidence'] = 'AMBIGUOUS'
            ambiguous += 1
        else:
            result['confidence'] = 'MEDIUM'
            purchase_id_matches += 1
    else:
        result['match_type'] = 'NO_MATCH'
        result['arch5_count'] = 0
        result['confidence'] = 'NEW'
        no_match += 1

    correlation_details.append(result)

print(f"\n[RESULTADOS CORRELACIÓN PAYMENT]:")
print(f"  Matches por SOURCE_ID: {source_id_matches}")
print(f"  Matches por PURCHASE_ID: {purchase_id_matches}")
print(f"  Matches ambos IDs coinciden: {both_match}")
print(f"  Ambiguos (1 Lib a N Account Money): {ambiguous}")
print(f"  Sin match (NEW en Liberaciones): {no_match}")
print(f"  TOTAL: {source_id_matches + purchase_id_matches + both_match + ambiguous + no_match}")

# Mostrar ejemplos de cada categoría
print(f"\n[EJEMPLOS POR CATEGORÍA]:")

for match_type in ['BOTH_IDS_SAME', 'SOURCE_ID_ONLY', 'PURCHASE_ID_ONLY', 'NO_MATCH']:
    examples = [r for r in correlation_details if r['match_type'] == match_type]
    if examples:
        print(f"\n  {match_type}: {len(examples)} casos")
        for ex in examples[:3]:
            print(f"    Lib:{ex['lib_source_id']} amount=${ex['lib_amount']:,.2f} date={ex['lib_date']}")

# ============================================================================
# [4] CORRELACIÓN ASSET_MANAGEMENT
# ============================================================================

print(f"\n" + "="*200)
print("[4] ANÁLISIS ASSET_MANAGEMENT (RENDIMIENTOS)")
print("="*200)

arch5_yields = [r for r in arch5_records if r.get('TRANSACTION_TYPE') == 'yield']
lib_assets = lib_by_desc.get('asset_management', [])

print(f"\nAccount Money yields: {len(arch5_yields)}")
print(f"Liquidaciones asset_management: {len(lib_assets)}")

total_yield_arch5 = sum(
    Decimal(str(r.get('SETTLEMENT_NET_AMOUNT', '0')).replace(',', '.'))
    for r in arch5_yields
)
total_asset_lib = sum(
    Decimal(str(r.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.')) -
    Decimal(str(r.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
    for r in lib_assets
)

print(f"Total yield arch5: ${total_yield_arch5:,.2f}")
print(f"Total asset_management Liberaciones: ${total_asset_lib:,.2f}")
print(f"Diferencia: ${total_yield_arch5 - total_asset_lib:,.2f}")

if abs(total_yield_arch5 - total_asset_lib) < Decimal('1'):
    print(f"[MATCH] Yields están en AMBOS reportes (misma información)")
else:
    print(f"[DIFERENCIA] Revisar si uno es subset del otro")

# ============================================================================
# [5] ANÁLISIS PAYOUT (10 registros Liberaciones, 0 en arch5)
# ============================================================================

print(f"\n" + "="*200)
print("[5] ANÁLISIS PAYOUT: 10 nuevos registros en Liquidaciones")
print("="*200)

lib_payouts = lib_by_desc.get('payout', [])
arch5_payouts = [r for r in arch5_records if r.get('TRANSACTION_TYPE') == 'transfer_out' or 'payout' in r.get('TRANSACTION_TYPE', '').lower()]

print(f"\nAccount Money transfers/payouts: {len(arch5_payouts)}")
print(f"Liquidaciones payouts: {len(lib_payouts)}")

if len(arch5_payouts) == 0:
    print(f"\n[CONCLUSIÓN] CERO payouts en arch5. Los 10 de Liberaciones son 100% NUEVOS.")
    print(f"Necesarios para importación.")

    print(f"\n[DETALLE DE PAYOUTS NUEVOS]:")
    print(f"{'SOURCE_ID':<20} {'FECHA':<12} {'MONTO':<18} {'PAYMENT_METHOD':<20}")
    print("-" * 70)
    total_payout = Decimal('0')
    for p in sorted(lib_payouts, key=lambda x: x.get('DATE', '')):
        sid = p.get('SOURCE_ID', 'N/A')
        date = p.get('DATE', '')[:10]
        monto = Decimal(str(p.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
        method = p.get('PAYMENT_METHOD_TYPE', 'N/A')[:18]
        total_payout += monto
        print(f"{sid:<20} {date:<12} ${monto:>16,.2f} {method:<20}")
    print("-" * 70)
    print(f"{'TOTAL':<20} {'':<12} ${total_payout:>16,.2f}")
else:
    print(f"\n[VERIFICACIÓN] Comparar identificadores...")
    # Análisis de matching si existen en ambos

# ============================================================================
# [6] VERIFICACIÓN SOURCE_ID: ¿Es único entre reportes?
# ============================================================================

print(f"\n" + "="*200)
print("[6] VERIFICACIÓN: ¿SOURCE_ID es único entre reportes?")
print("="*200)

arch5_source_ids = set()
for r in arch5_records:
    sid = r.get('SOURCE_ID') or r.get('REFERENCE_ID') or r.get('ID')
    if sid:
        arch5_source_ids.add(sid)

lib_source_ids = set()
for r in lib_records:
    sid = r.get('SOURCE_ID')
    if sid:
        lib_source_ids.add(sid)

intersection = arch5_source_ids & lib_source_ids
only_arch5 = arch5_source_ids - lib_source_ids
only_lib = lib_source_ids - arch5_source_ids

print(f"\nTotal SOURCE_ID únicos en arch5: {len(arch5_source_ids)}")
print(f"Total SOURCE_ID únicos en Liberaciones: {len(lib_source_ids)}")
print(f"Intersección (IDs en AMBOS): {len(intersection)}")
print(f"Solo en arch5: {len(only_arch5)}")
print(f"Solo en Liberaciones: {len(only_lib)}")

print(f"\n[CONCLUSIÓN SOURCE_ID]:")
if len(intersection) > 0:
    print(f"  {len(intersection)} IDs coinciden entre reportes ({100*len(intersection)/len(lib_source_ids):.1f}% de Lib)")
    print(f"  Primeros 10 coincidencias: {list(intersection)[:10]}")
else:
    print(f"  CERO coincidencias: SOURCE_ID es COMPLETAMENTE DISTINTO entre reportes")
    print(f"  Conclusión: NO usar SOURCE_ID para deduplicación entre arch5 y Liberaciones")

# ============================================================================
# [7] INVESTIGACIÓN: Diferencia de $0,03
# ============================================================================

print(f"\n" + "="*200)
print("[7] INVESTIGACIÓN: Diferencia de $0,03 en neto")
print("="*200)

lib_total_credit = Decimal('0')
lib_total_debit = Decimal('0')

for r in lib_records:
    try:
        cr = Decimal(str(r.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
        db = Decimal(str(r.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
        lib_total_credit += cr
        lib_total_debit += db
    except:
        pass

lib_neto = lib_total_credit - lib_total_debit
mp_ui_neto = Decimal('-124203.27')
diferencia = lib_neto - mp_ui_neto

print(f"\nLibraciones neto calculado: ${lib_neto:,.2f}")
print(f"MP UI neto reportado: ${mp_ui_neto:,.2f}")
print(f"Diferencia: ${diferencia:,.2f}")

# Buscar montos con más de 2 decimales o redondeos problemáticos
print(f"\n[BÚSQUEDA DE FUENTE DE $0.03]:")

anomalías = []
for i, r in enumerate(lib_records, 1):
    cr_str = r.get('NET_CREDIT_AMOUNT', '0').replace(',', '.')
    db_str = r.get('NET_DEBIT_AMOUNT', '0').replace(',', '.')
    fee_str = r.get('MP_FEE_AMOUNT', '0').replace(',', '.')
    tax_str = r.get('TAXES_AMOUNT', '0').replace(',', '.')

    # Verificar si alguien tiene >2 decimales
    for field, val_str in [('CR', cr_str), ('DB', db_str), ('FEE', fee_str), ('TAX', tax_str)]:
        if '.' in val_str:
            decimals = len(val_str.split('.')[1])
            if decimals > 2:
                anomalías.append({
                    'row': i,
                    'field': field,
                    'value': val_str,
                    'decimals': decimals
                })

if anomalías:
    print(f"Encontradas {len(anomalías)} anomalías de precisión:")
    for anom in anomalías[:5]:
        print(f"  Row {anom['row']}: {anom['field']}={anom['value']} ({anom['decimals']} decimales)")
else:
    print(f"Todos los campos respetan 2 decimales. La diferencia puede ser:")
    print(f"  - Operación no incluida en este período")
    print(f"  - Redondeo acumulado de múltiples operaciones")
    print(f"  - Diferencia de período (MP UI vs Liberaciones)")

# ============================================================================
# [8] VALIDACIÓN: BALANCE_AMOUNT (reconstrucción fila por fila)
# ============================================================================

print(f"\n" + "="*200)
print("[8] VALIDACIÓN BALANCE_AMOUNT: Reconstrucción fila a fila")
print("="*200)

lib_sorted = sorted(lib_records, key=lambda x: (x.get('DATE', '')[:10], x.get('SOURCE_ID', '')))

running_balance = Decimal('0')
discrepancias_balance = []
balance_by_date = defaultdict(Decimal)

for i, r in enumerate(lib_sorted, 1):
    try:
        date = r.get('DATE', '')[:10]
        cr = Decimal(str(r.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
        db = Decimal(str(r.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
        reported_balance = Decimal(str(r.get('BALANCE_AMOUNT', '0')).replace(',', '.'))

        balance_impact = cr - db
        running_balance += balance_impact
        balance_by_date[date] = reported_balance

        if abs(running_balance - reported_balance) > Decimal('0.01'):
            discrepancias_balance.append({
                'row': i,
                'date': date,
                'source_id': r.get('SOURCE_ID'),
                'calculated': running_balance,
                'reported': reported_balance,
                'diff': reported_balance - running_balance
            })
    except:
        pass

print(f"\nTotal filas procesadas: {len(lib_sorted)}")
print(f"Discrepancias encontradas: {len(discrepancias_balance)}")

if discrepancias_balance:
    print(f"\n[PRIMERAS 10 DISCREPANCIAS]:")
    for d in discrepancias_balance[:10]:
        print(f"  Row {d['row']} ({d['date']}): calc=${d['calculated']:,.2f} vs report=${d['reported']:,.2f} " +
              f"(diff=${d['diff']:,.2f})")

    print(f"\n[INTERPRETACIÓN]:")
    print(f"  BALANCE_AMOUNT NO puede reconstruirse simplemente con balance_impact")
    print(f"  Posibles causas:")
    print(f"    - Incluye conceptos no desglosados en esta fila")
    print(f"    - Las reservas restan del balance disponible")
    print(f"    - Es un snapshot de fin de jornada, no acumulativo de filas")
else:
    print(f"\n[BALANCE_AMOUNT VÁLIDO] Puede reconstruirse fila a fila")
    print(f"Balance inicial implícito (asumiendo 0): ${running_balance - (lib_total_credit - lib_total_debit):,.2f}")
    print(f"Balance final calculado: ${running_balance:,.2f}")
    print(f"Balance final reportado (2026-08-31): ${balance_by_date.get('2026-08-31', 'N/A')}")

print(f"\n" + "="*200)
print("AUDITORÍA COMPLETADA")
print("="*200 + "\n")
