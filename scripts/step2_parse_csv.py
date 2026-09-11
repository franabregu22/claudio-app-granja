#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PASO 2: Parsear Liberaciones3.csv SIN escrituras
Validar conteos y netos ANTES de cualquier importación
"""

import csv
from pathlib import Path
from decimal import Decimal

CSV_PATH = Path('data/mercadopago/Liberaciones3.csv')

if not CSV_PATH.exists():
    print(f"ERROR: {CSV_PATH} no encontrado")
    exit(1)

print("\n" + "="*120)
print("PASO 2: PARSEO CSV SIN ESCRITURAS")
print("="*120)

# Leer CSV
records = []
with open(CSV_PATH, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('DATE', '')[:10]
        if date_str.startswith('2026-08'):
            records.append(row)

print(f"\n[OK] Leído CSV: {len(records)} filas agosto")

# Conteo por DESCRIPTION
descriptions = {}
for r in records:
    desc = r.get('DESCRIPTION', '(ninguno)')
    descriptions[desc] = descriptions.get(desc, 0) + 1

print(f"\n[Validación 1] Conteos por DESCRIPTION")
payment = descriptions.get('payment', 0)
asset_management = descriptions.get('asset_management', 0)
reserve_for_payment = descriptions.get('reserve_for_payment', 0)
reserve_for_payout = descriptions.get('reserve_for_payout', 0)
payout = descriptions.get('payout', 0)
otros = sum(v for k, v in descriptions.items() if k not in ['payment', 'asset_management', 'reserve_for_payment', 'reserve_for_payout', 'payout'])

print(f"  payment: {payment} (esperado 696)")
print(f"  asset_management: {asset_management} (esperado 20)")
print(f"  reserve_for_payment: {reserve_for_payment} (esperado 52)")
print(f"  reserve_for_payout: {reserve_for_payout} (esperado 20)")
print(f"  payout: {payout} (esperado 10)")
print(f"  otros: {otros} (esperado 0)")

definitivas = payment + asset_management + payout
raw_only = reserve_for_payment + reserve_for_payout + otros
total = definitivas + raw_only

print(f"\n[Validación 2] Totales")
print(f"  Definitivas (payment+asset+payout): {definitivas} (esperado 726)")
print(f"  RAW-only (reserve+otros): {raw_only} (esperado 72)")
print(f"  TOTAL: {total} (esperado 798)")

# Netos
print(f"\n[Validación 3] Netos DEFINITIVOS (payment+asset_management+payout)")

credit_def = Decimal('0')
debit_def = Decimal('0')
neto_payouts = Decimal('0')

for r in records:
    desc = r.get('DESCRIPTION', '')
    if desc in ['payment', 'asset_management', 'payout']:
        cr = Decimal(str(r.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
        db = Decimal(str(r.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
        credit_def += cr
        debit_def += db

        if desc == 'payout':
            neto_payouts += (cr - db)

neto_def = credit_def - debit_def

print(f"  Créditos definivos: ${credit_def:.2f} (esperado 13,337,721.86)")
print(f"  Débitos definivos: ${debit_def:.2f} (esperado 13,461,925.10)")
print(f"  Neto definitivo: ${neto_def:.2f} (esperado -124,203.24)")
print(f"  Neto 10 payouts: ${neto_payouts:.2f} (esperado -10,904,815.29)")

# Validaciones
print(f"\n[Validación FINAL]")
checks = [
    ("Total agosto = 798", total == 798),
    ("payment = 696", payment == 696),
    ("asset_management = 20", asset_management == 20),
    ("reserve_for_payment = 52", reserve_for_payment == 52),
    ("reserve_for_payout = 20", reserve_for_payout == 20),
    ("payout = 10", payout == 10),
    ("Definitivas = 726", definitivas == 726),
    ("RAW-only = 72", raw_only == 72),
    ("Créditos = 13,337,721.86", credit_def == Decimal('13337721.86')),
    ("Débitos = 13,461,925.10", debit_def == Decimal('13461925.10')),
    ("Neto def = -124,203.24", neto_def == Decimal('-124203.24')),
    ("Neto payouts = -10,904,815.29", neto_payouts == Decimal('-10904815.29')),
]

all_pass = True
for check_name, result in checks:
    status = "OK" if result else "FAIL"
    print(f"  [{status}] {check_name}")
    if not result:
        all_pass = False

print("\n" + "="*120)
if all_pass:
    print("PASO 2: OK - Todos los valores coinciden exactamente")
    print("\nPróximo: PASO 3 (Aplicar SQL)")
else:
    print("PASO 2: FAIL - Discrepancias encontradas")
    print("\nDetenido. NO continuar a importación.")
    exit(1)
