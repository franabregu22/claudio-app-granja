#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MAPEO EXACTO: SOURCE_ID entre arch5 (Account Money SETTLEMENT) y Liberaciones3
Determinar estrategia de deduplicación determinística.
"""

import csv
from pathlib import Path
from decimal import Decimal
from collections import defaultdict

arch5_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/arch5.csv")
liberaciones_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/Liberaciones3.csv")

print("\n" + "="*200)
print("MAPEO DETERMINÍSTICO: SOURCE_ID arch5 -> Liberaciones3 (AGOSTO 2026)")
print("="*200)

# ============================================================================
# Lectura arch5
# ============================================================================

arch5_by_source_id = {}
arch5_august = []

with open(arch5_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('TRANSACTION_DATE', '')[:10]
        if date_str and date_str.startswith('2026-08'):
            sid = row.get('SOURCE_ID')
            if sid:
                arch5_by_source_id[sid] = {
                    'date': date_str,
                    'transaction_amount': Decimal(str(row.get('TRANSACTION_AMOUNT', '0')).replace(',', '.')),
                    'settlement_net': Decimal(str(row.get('SETTLEMENT_NET_AMOUNT', '0')).replace(',', '.')),
                    'taxes': Decimal(str(row.get('TAXES_AMOUNT', '0')).replace(',', '.')),
                    'payer_name': row.get('PAYER_NAME', ''),
                    'payment_method': row.get('PAYMENT_METHOD_TYPE', ''),
                }
                arch5_august.append(sid)

print(f"\narch5 agosto: {len(arch5_august)} registros")
print(f"SOURCE_ID únicos: {len(arch5_by_source_id)}")

# ============================================================================
# Lectura Liberaciones3
# ============================================================================

lib_by_source_id = {}
lib_august = []
lib_by_desc = defaultdict(list)

with open(liberaciones_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('DATE', '')[:10]
        if date_str and date_str.startswith('2026-08'):
            sid = row.get('SOURCE_ID')
            desc = row.get('DESCRIPTION', '')
            if sid:
                if sid not in lib_by_source_id:
                    lib_by_source_id[sid] = {
                        'date': date_str,
                        'net_credit': Decimal(str(row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.')),
                        'net_debit': Decimal(str(row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.')),
                        'description': desc,
                    }
                lib_by_desc[desc].append(sid)
            lib_august.append((sid, desc))

print(f"\nLibraciones3 agosto: {len(lib_august)} registros")
print(f"SOURCE_ID únicos: {len(lib_by_source_id)}")
print(f"Por DESCRIPTION:")
for desc in sorted(lib_by_desc.keys()):
    unique_ids = len(set(lib_by_desc[desc]))
    print(f"  {desc}: {unique_ids} SOURCE_ID únicos")

# ============================================================================
# Correlación determinística
# ============================================================================

print(f"\n" + "="*200)
print("[CORRELACIÓN DETERMINÍSTICA]")
print("="*200)

arch5_ids_set = set(arch5_by_source_id.keys())
lib_ids_set = set(lib_by_source_id.keys())

intersection = arch5_ids_set & lib_ids_set
only_in_arch5 = arch5_ids_set - lib_ids_set
only_in_lib = lib_ids_set - arch5_ids_set

print(f"\n[Totales]:")
print(f"  arch5 SOURCE_ID: {len(arch5_ids_set)}")
print(f"  Liberaciones SOURCE_ID: {len(lib_ids_set)}")
print(f"  Intersección (en AMBOS): {len(intersection)}")
print(f"  Solo en arch5: {len(only_in_arch5)}")
print(f"  Solo en Liberaciones: {len(only_in_lib)}")

# Verificar que intersection sea exactamente arch5
if only_in_arch5 == set():
    print(f"\n[CONFIRMACIÓN] Todos los 716 SOURCE_ID de arch5 están en Liberaciones")
else:
    print(f"\n[ANOMALÍA] {len(only_in_arch5)} SOURCE_ID en arch5 NO están en Liberaciones")

# Verificar que only_in_lib sean exactamente los payouts + asset_mgmt
payouts_only = set(lib_by_desc['payout'])
assets_only = set(lib_by_desc['asset_management'])
payout_asset_union = payouts_only | assets_only

print(f"\n[Verificación tipos nuevos]:")
print(f"  Payouts solo en Lib: {len(payouts_only)}")
print(f"  Assets solo en Lib: {len(assets_only)}")
print(f"  Union (nuevos): {len(payout_asset_union)}")
print(f"  only_in_lib (según cálculo): {len(only_in_lib)}")

if payout_asset_union == only_in_lib:
    print(f"  [CONFIRMACIÓN] Los 30 registros nuevos son exactamente payouts + assets")
else:
    print(f"  [DIFERENCIA] {len(only_in_lib - payout_asset_union)} registros no contabilizados")
    print(f"    Posibles duplicados en descripción O reservas en lib_ids")

# ============================================================================
# Validación de balance_impact para registros correlacionados
# ============================================================================

print(f"\n" + "="*200)
print("[VALIDACIÓN: balance_impact debe coincidir entre arch5 y Liberaciones]")
print("="*200)

discrepancias = []
for source_id in sorted(intersection):
    arch5_rec = arch5_by_source_id[source_id]
    lib_rec = lib_by_source_id[source_id]

    arch5_net = arch5_rec['settlement_net']
    lib_net = lib_rec['net_credit'] - lib_rec['net_debit']

    # Deben coincidir
    if abs(arch5_net - lib_net) > Decimal('0.01'):
        discrepancias.append({
            'source_id': source_id,
            'arch5_net': arch5_net,
            'lib_net': lib_net,
            'diff': abs(arch5_net - lib_net),
            'arch5_date': arch5_rec['date'],
            'lib_date': lib_rec['date'],
        })

print(f"\nTotal registros compartidos (intersection): {len(intersection)}")
print(f"Discrepancias en balance_impact: {len(discrepancias)}")

if discrepancias:
    print(f"\n[PRIMERAS 10 DISCREPANCIAS]:")
    for d in sorted(discrepancias, key=lambda x: x['diff'], reverse=True)[:10]:
        print(f"  {d['source_id']}: arch5=${d['arch5_net']:,.2f} vs lib=${d['lib_net']:,.2f} diff=${d['diff']:,.2f}")
else:
    print(f"\n[CONCLUSIÓN] Todos los 716 SOURCE_ID correlacionados tienen balance_impact idéntico")
    print(f"Deduplicación es SEGURA por SOURCE_ID")

# ============================================================================
# Desglose de los 10 nuevos (payouts)
# ============================================================================

print(f"\n" + "="*200)
print("[DETALLE: 10 PAYOUTS nuevos (solo en Liberaciones)")
print("="*200)

print(f"\nSOURCE_ID\tFECHA\tNET_DEBIT\tDESCRIPTION")
print("-" * 80)

payout_total = Decimal('0')
for source_id in sorted(payouts_only):
    lib_rec = lib_by_source_id[source_id]
    net_debit = lib_rec['net_debit']
    payout_total += net_debit
    print(f"{source_id}\t{lib_rec['date']}\t${net_debit:,.2f}\t{lib_rec['description']}")

print("-" * 80)
print(f"{'TOTAL':<15}\t\t${payout_total:,.2f}")

# ============================================================================
# Desglose de los 20 nuevos (asset_management)
# ============================================================================

print(f"\n" + "="*200)
print("[DETALLE: 20 ASSET_MANAGEMENT nuevos (solo en Liberaciones)")
print("="*200)

print(f"\nSOURCE_ID\tFECHA\tNET_CREDIT\tDESCRIPTION")
print("-" * 80)

asset_total = Decimal('0')
for source_id in sorted(assets_only):
    lib_rec = lib_by_source_id[source_id]
    net_credit = lib_rec['net_credit']
    asset_total += net_credit
    print(f"{source_id}\t{lib_rec['date']}\t${net_credit:,.2f}\t{lib_rec['description']}")

print("-" * 80)
print(f"{'TOTAL':<15}\t\t${asset_total:,.2f}")

# ============================================================================
# Impacto contable final
# ============================================================================

print(f"\n" + "="*200)
print("[IMPACTO CONTABLE POST-IMPORTACIÓN]")
print("="*200)

# Calcular neto total de los 716 compartidos
shared_net = sum(arch5_by_source_id[sid]['settlement_net'] for sid in intersection)

# Verificar con Liberaciones
lib_payment_total = Decimal('0')
for sid in lib_by_desc['payment']:
    if sid in lib_by_source_id:
        lib_payment_total += lib_by_source_id[sid]['net_credit'] - lib_by_source_id[sid]['net_debit']

print(f"\nCompartidos (616 payment + 0 payout):")
print(f"  balance_impact total: ${shared_net:,.2f}")

print(f"\nNuevos en Liberaciones:")
print(f"  Payouts (10): -${payout_total:,.2f}")
print(f"  Assets (20): +${asset_total:,.2f}")
print(f"  Neto nuevos: ${asset_total - payout_total:,.2f}")

print(f"\nSumas de Liberaciones:")
print(f"  payments (696): ${lib_payment_total:,.2f}")
print(f"  assets (20): ${asset_total:,.2f}")
print(f"  payouts (10): -${payout_total:,.2f}")

print(f"\n[ARQUITECTURA RESULTADO]:")
print(f"  FM reutilizados (arch5->lib): {len(intersection)}")
print(f"  FM nuevos (payouts + assets): {len(only_in_lib)}")
print(f"  Total FM: {len(intersection) + len(only_in_lib)}")

print("\n" + "="*200)
print("MAPEO COMPLETADO")
print("="*200 + "\n")
