#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VERIFICACIÓN FILA A FILA: Resolver contradicción crítica sobre asset_management.
¿Están o NO en arch5?
"""

import csv
from pathlib import Path
from decimal import Decimal

arch5_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/arch5.csv")
lib_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/Liberaciones3.csv")

print("\n" + "="*250)
print("VERIFICACIÓN FILA A FILA: asset_management en Liberaciones vs arch5")
print("="*250)

# ============================================================================
# Leer arch5 y crear índice
# ============================================================================

arch5_by_sid = {}
with open(arch5_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('TRANSACTION_DATE', '')[:10]
        if date_str.startswith('2026-08'):
            sid = row.get('SOURCE_ID')
            if sid:
                arch5_by_sid[sid] = {
                    'type': row.get('TRANSACTION_TYPE'),
                    'amount': Decimal(str(row.get('TRANSACTION_AMOUNT', '0')).replace(',', '.')),
                    'settlement_net': Decimal(str(row.get('SETTLEMENT_NET_AMOUNT', '0')).replace(',', '.')),
                    'date': date_str,
                }

print(f"\narch5 agosto: {len(arch5_by_sid)} SOURCE_ID únicos cargados en índice")

# ============================================================================
# Verificar cada asset_management de Liberaciones
# ============================================================================

asset_mgmt = []
with open(lib_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('DATE', '')[:10]
        if date_str.startswith('2026-08') and row.get('DESCRIPTION') == 'asset_management':
            asset_mgmt.append(row)

print(f"Liquidaciones asset_management: {len(asset_mgmt)} registros\n")

print("="*250)
print("[DETALLE FILA A FILA]")
print("="*250)

print(f"\n{'#':<3} {'LIB SOURCE_ID':<20} {'FECHA':<12} {'NET_CREDIT':<18} {'EN ARCH5':<8} {'ARCH5 TYPE':<15} {'ARCH5 SETTLEMENT':<18} {'MATCH':<10}")
print("-" * 250)

matches = 0
no_matches = 0
ambiguous = 0

for i, lib_row in enumerate(asset_mgmt, 1):
    lib_sid = lib_row.get('SOURCE_ID')
    lib_date = lib_row.get('DATE', '')[:10]
    lib_credit = Decimal(str(lib_row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))

    if lib_sid in arch5_by_sid:
        arch5_rec = arch5_by_sid[lib_sid]
        en_arch5 = 'YES'
        arch5_type = arch5_rec['type']
        arch5_settlement = arch5_rec['settlement_net']

        # Verificar si amounts coinciden
        if abs(lib_credit - arch5_settlement) < Decimal('0.01'):
            match_status = 'EXACT'
            matches += 1
        else:
            match_status = 'DIFF_AMT'
            ambiguous += 1
    else:
        en_arch5 = 'NO'
        arch5_type = '-'
        arch5_settlement = Decimal('0')
        match_status = 'NEW'
        no_matches += 1

    print(f"{i:<3} {lib_sid:<20} {lib_date:<12} ${lib_credit:>16,.2f} {en_arch5:<8} {arch5_type:<15} ${arch5_settlement:>16,.2f} {match_status:<10}")

print("-" * 250)
print(f"\nRESUMEN ASSET_MANAGEMENT:")
print(f"  Total registros: {len(asset_mgmt)}")
print(f"  Matches exactos (SOURCE_ID + amount): {matches}")
print(f"  Sin match en arch5 (NUEVOS): {no_matches}")
print(f"  Ambiguos (SOURCE_ID existe pero amount distinto): {ambiguous}")

# ============================================================================
# Ahora hacer lo MISMO para PAYMENT
# ============================================================================

print("\n" + "="*250)
print("[DETALLE FILA A FILA: PAYMENT]")
print("="*250)

payment_records = []
with open(lib_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('DATE', '')[:10]
        if date_str.startswith('2026-08') and row.get('DESCRIPTION') == 'payment':
            payment_records.append(row)

print(f"\nLibraciones payment: {len(payment_records)} registros")
print(f"\nMostrando primeros 20 registros como muestra:\n")

print(f"{'#':<3} {'LIB SOURCE_ID':<20} {'FECHA':<12} {'NET_CREDIT':<18} {'EN ARCH5':<8} {'ARCH5 TYPE':<15} {'ARCH5 SETTLEMENT':<18} {'MATCH':<10}")
print("-" * 250)

payment_matches = 0
payment_no_matches = 0
payment_ambiguous = 0

for i, lib_row in enumerate(payment_records[:20], 1):
    lib_sid = lib_row.get('SOURCE_ID')
    lib_date = lib_row.get('DATE', '')[:10]
    lib_credit = Decimal(str(lib_row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
    lib_debit = Decimal(str(lib_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
    lib_net = lib_credit - lib_debit

    if lib_sid in arch5_by_sid:
        arch5_rec = arch5_by_sid[lib_sid]
        en_arch5 = 'YES'
        arch5_type = arch5_rec['type']
        arch5_settlement = arch5_rec['settlement_net']

        if abs(lib_net - arch5_settlement) < Decimal('0.01'):
            match_status = 'EXACT'
            payment_matches += 1
        else:
            match_status = 'DIFF_AMT'
            payment_ambiguous += 1
    else:
        en_arch5 = 'NO'
        arch5_type = '-'
        arch5_settlement = Decimal('0')
        match_status = 'NEW'
        payment_no_matches += 1

    print(f"{i:<3} {lib_sid:<20} {lib_date:<12} ${lib_net:>16,.2f} {en_arch5:<8} {arch5_type:<15} ${arch5_settlement:>16,.2f} {match_status:<10}")

print("-" * 250)
print(f"\nRESUMEN PAYMENT (primeros 20):")
print(f"  Matches: {payment_matches}")
print(f"  Nuevos: {payment_no_matches}")
print(f"  Ambiguos: {payment_ambiguous}")

# Contar totales de todo el conjunto
payment_matches_total = 0
payment_no_matches_total = 0
payment_ambiguous_total = 0

for lib_row in payment_records:
    lib_sid = lib_row.get('SOURCE_ID')
    lib_credit = Decimal(str(lib_row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
    lib_debit = Decimal(str(lib_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
    lib_net = lib_credit - lib_debit

    if lib_sid in arch5_by_sid:
        arch5_rec = arch5_by_sid[lib_sid]
        arch5_settlement = arch5_rec['settlement_net']

        if abs(lib_net - arch5_settlement) < Decimal('0.01'):
            payment_matches_total += 1
        else:
            payment_ambiguous_total += 1
    else:
        payment_no_matches_total += 1

print(f"\nRESUMEN PAYMENT (TODOS {len(payment_records)}):")
print(f"  Matches exactos: {payment_matches_total}")
print(f"  Sin match (NUEVOS): {payment_no_matches_total}")
print(f"  Ambiguos: {payment_ambiguous_total}")

# ============================================================================
# PAYOUT
# ============================================================================

print("\n" + "="*250)
print("[DETALLE FILA A FILA: PAYOUT]")
print("="*250)

payout_records = []
with open(lib_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('DATE', '')[:10]
        if date_str.startswith('2026-08') and row.get('DESCRIPTION') == 'payout':
            payout_records.append(row)

print(f"\nLibraciones payout: {len(payout_records)} registros\n")

print(f"{'#':<3} {'LIB SOURCE_ID':<20} {'FECHA':<12} {'NET_DEBIT':<18} {'EN ARCH5':<8} {'ARCH5 TYPE':<15} {'ARCH5 SETTLEMENT':<18} {'MATCH':<10}")
print("-" * 250)

payout_matches = 0
payout_no_matches = 0

for i, lib_row in enumerate(payout_records, 1):
    lib_sid = lib_row.get('SOURCE_ID')
    lib_date = lib_row.get('DATE', '')[:10]
    lib_debit = Decimal(str(lib_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))

    if lib_sid in arch5_by_sid:
        arch5_rec = arch5_by_sid[lib_sid]
        en_arch5 = 'YES'
        arch5_type = arch5_rec['type']
        arch5_settlement = arch5_rec['settlement_net']
        match_status = 'EXISTS_BUT_DIFFERENT'
        payout_matches += 1
    else:
        en_arch5 = 'NO'
        arch5_type = '-'
        arch5_settlement = Decimal('0')
        match_status = 'NEW'
        payout_no_matches += 1

    print(f"{i:<3} {lib_sid:<20} {lib_date:<12} ${lib_debit:>16,.2f} {en_arch5:<8} {arch5_type:<15} ${arch5_settlement:>16,.2f} {match_status:<10}")

print("-" * 250)
print(f"\nRESUMEN PAYOUT:")
print(f"  Total registros: {len(payout_records)}")
print(f"  En arch5: {payout_matches}")
print(f"  NUEVOS (NO en arch5): {payout_no_matches}")

# ============================================================================
# RECONCILIACIÓN MATEMÁTICA FINAL
# ============================================================================

print("\n" + "="*250)
print("[RECONCILIACION MATEMATICA FINAL]")
print("="*250)

print(f"\nLibraciones agosto: 726 SOURCE_ID unicos\n")
print(f"Distribucion:")
print(f"  payment:            {len(payment_records):4} registros, {payment_matches_total:4} matches + {payment_no_matches_total:4} nuevos = {payment_matches_total + payment_no_matches_total:4}")
print(f"  asset_management:   {len(asset_mgmt):4} registros, {matches:4} matches + {no_matches:4} nuevos = {matches + no_matches:4}")
print(f"  payout:             {len(payout_records):4} registros, {payout_matches:4} en arch5 + {payout_no_matches:4} nuevos = {payout_no_matches:4}")
print(f"  reserve_*:          (72 registros, pero duplicados de payment/payout)")
total_expected = payment_matches_total + payment_no_matches_total + matches + no_matches + payout_no_matches
print(f"  -------------------------------------------")
print(f"  TOTAL SOURCE_ID unicos esperados: {total_expected}")
print(f"  Coincide con 726? {'SI' if total_expected == 726 else 'NO - DISCREPANCIA'}")

print(f"\nNuevo en Liberaciones (NO en arch5):")
print(f"  payment:              {payment_no_matches_total}")
print(f"  asset_management:     {no_matches}")
print(f"  payout:               {payout_no_matches}")
print(f"  Total nuevos:         {payment_no_matches_total + no_matches + payout_no_matches}")

print(f"\nCompartidos (EN AMBOS):")
print(f"  Total:                {len(arch5_by_sid)}")

# ============================================================================
# SUMATORIA EXACTA DE LOS 716 COMPARTIDOS
# ============================================================================

print("\n" + "="*250)
print("[SUMATORIA EXACTA DE COMPARTIDOS - Fila a fila]")
print("="*250)

shared_discrepancies = []
shared_total_arch5 = Decimal('0')
shared_total_lib = Decimal('0')
shared_match_count = 0
shared_diff_count = 0

# Para los 716 compartidos, buscar discrepancias
all_shared_sids = set()
for payment_row in payment_records:
    sid = payment_row.get('SOURCE_ID')
    if sid in arch5_by_sid:
        all_shared_sids.add(sid)

for asset_row in asset_mgmt:
    sid = asset_row.get('SOURCE_ID')
    if sid in arch5_by_sid:
        all_shared_sids.add(sid)

print(f"\nVerificando {len(all_shared_sids)} SOURCE_ID compartidos fila a fila...\n")

# Procesar cada SOURCE_ID compartido
for sid in sorted(all_shared_sids):
    arch5_rec = arch5_by_sid[sid]
    arch5_amount = arch5_rec['settlement_net']
    shared_total_arch5 += arch5_amount

    # Buscar en Liberaciones (puede ser payment o asset_management)
    lib_amount = None
    lib_desc = None

    for payment_row in payment_records:
        if payment_row.get('SOURCE_ID') == sid:
            cr = Decimal(str(payment_row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
            db = Decimal(str(payment_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
            lib_amount = cr - db
            lib_desc = 'payment'
            break

    if lib_amount is None:
        for asset_row in asset_mgmt:
            if asset_row.get('SOURCE_ID') == sid:
                cr = Decimal(str(asset_row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
                db = Decimal(str(asset_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
                lib_amount = cr - db
                lib_desc = 'asset_management'
                break

    if lib_amount is not None:
        shared_total_lib += lib_amount
        diff = abs(arch5_amount - lib_amount)

        if diff < Decimal('0.01'):
            shared_match_count += 1
        else:
            shared_diff_count += 1
            shared_discrepancies.append({
                'sid': sid,
                'arch5': arch5_amount,
                'lib': lib_amount,
                'diff': diff,
                'lib_desc': lib_desc
            })

print(f"RESULTADOS 716 COMPARTIDOS:")
print(f"  Match exacto (diff < 0.01): {shared_match_count}")
print(f"  Con discrepancia (diff >= 0.01): {shared_diff_count}")

if shared_discrepancies:
    print(f"\n[DISCREPANCIAS ENCONTRADAS]:")
    for disc in shared_discrepancies:
        print(f"  {disc['sid']}: arch5=${disc['arch5']:,.2f} vs lib=${disc['lib']:,.2f} (diff=${disc['diff']:,.2f}) [{disc['lib_desc']}]")

print(f"\nSUMATORIA 716 COMPARTIDOS:")
print(f"  arch5 total:        ${shared_total_arch5:,.2f}")
print(f"  Liberaciones total: ${shared_total_lib:,.2f}")
print(f"  Diferencia:         ${shared_total_lib - shared_total_arch5:,.2f}")

# ============================================================================
# SUMATORIA DE 10 PAYOUTS NUEVOS
# ============================================================================

print("\n" + "="*250)
print("[SUMATORIA DE 10 PAYOUTS (solo en Liberaciones)]")
print("="*250)

payout_total = Decimal('0')
for payout_row in payout_records:
    db = Decimal(str(payout_row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
    payout_total -= db  # Negativo porque son egresos

print(f"\nTotal payout: ${payout_total:,.2f}")

# ============================================================================
# RECONSTRUCCIÓN TOTAL
# ============================================================================

print("\n" + "="*250)
print("[RECONSTRUCCION TOTAL AGOSTO]")
print("="*250)

total_reconstructed = shared_total_lib + payout_total
mp_ui_total = Decimal('-124203.27')
residual = total_reconstructed - mp_ui_total

print(f"\nNeto 716 compartidos: ${shared_total_lib:,.2f}")
print(f"Neto 10 payouts nuevos: ${payout_total:,.2f}")
print(f"-------------------------------------------")
print(f"TOTAL RECONSTRUIDO: ${total_reconstructed:,.2f}")
print(f"MP UI ESPERADO: ${mp_ui_total:,.2f}")
print(f"-------------------------------------------")
print(f"RESIDUAL: ${residual:,.2f}")

if abs(residual) < Decimal('0.01'):
    print(f"\nRESULTADO: COINCIDE EXACTO")
elif abs(residual) < Decimal('1.00'):
    print(f"\nRESULTADO: Diferencia pequena ({residual}), probable redondeo")
else:
    print(f"\nRESULTADO: DISCREPANCIA SIGNIFICATIVA - Investigar")

print("\n" + "="*250)
print("VERIFICACION COMPLETADA")
print("="*250 + "\n")
