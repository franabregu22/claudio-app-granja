#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ESTRATEGIA FINAL: Mapeo completo y determinístico de deduplicación.
"""

import csv
from pathlib import Path
from decimal import Decimal
from collections import defaultdict

arch5_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/arch5.csv")
lib_path = Path("C:/Users/Franabregu/Desktop/Claudio app Granja/data/mercadopago/Liberaciones3.csv")

print("\n" + "="*200)
print("ESTRATEGIA FINAL DE IMPORTACIÓN")
print("="*200)

# ============================================================================
# Lectura arch5
# ============================================================================

arch5_records = {}
with open(arch5_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('TRANSACTION_DATE', '')[:10]
        if date_str.startswith('2026-08'):
            sid = row.get('SOURCE_ID')
            arch5_records[sid] = {
                'type': 'SETTLEMENT',
                'settlement_net': Decimal(str(row.get('SETTLEMENT_NET_AMOUNT', '0')).replace(',', '.')),
                'date': date_str,
            }

print(f"\narch5 agosto: {len(arch5_records)} SOURCE_ID únicos")

# ============================================================================
# Lectura Liberaciones3 con todas sus combinaciones
# ============================================================================

lib_entries = {}  # source_id -> list of (desc, net_impact)

with open(lib_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        date_str = row.get('DATE', '')[:10]
        if date_str.startswith('2026-08'):
            sid = row.get('SOURCE_ID')
            desc = row.get('DESCRIPTION')
            cr = Decimal(str(row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
            db = Decimal(str(row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
            net = cr - db

            if sid not in lib_entries:
                lib_entries[sid] = []
            lib_entries[sid].append({
                'desc': desc,
                'net': net,
                'date': date_str,
            })

print(f"Liberaciones agosto: {len(lib_entries)} SOURCE_ID únicos")

# ============================================================================
# Clasificación por tipo de correlación
# ============================================================================

print(f"\n" + "="*200)
print("[CLASIFICACIÓN POR ESTRATEGIA DE DEDUPLICACIÓN]")
print("="*200)

# Grupo 1: Compartidos (SOURCE_ID en AMBOS) + balance_impact idéntico
shared = {}
for sid in arch5_records:
    if sid in lib_entries:
        arch5_net = arch5_records[sid]['settlement_net']
        # Buscar el neto en Liberaciones para este SOURCE_ID
        lib_net_total = sum(e['net'] for e in lib_entries[sid])

        if abs(arch5_net - lib_net_total) < Decimal('0.01'):
            shared[sid] = {
                'arch5_net': arch5_net,
                'lib_net': lib_net_total,
                'lib_descs': [e['desc'] for e in lib_entries[sid]],
            }

# Grupo 2: Solo en Liberaciones (nuevos)
only_in_lib = {}
for sid in lib_entries:
    if sid not in arch5_records:
        lib_records = lib_entries[sid]
        only_in_lib[sid] = {
            'net': sum(e['net'] for e in lib_records),
            'descs': [e['desc'] for e in lib_records],
            'count': len(lib_records),
        }

print(f"\n[GRUPO 1: REUTILIZAR FM (compartidos)]")
print(f"Total SOURCE_ID: {len(shared)}")
print(f"Acción: Crear mp_source_record tipo='liberaciones', crear mp_movement_source_link")
print(f"Resultado: 0 nuevas FM, 0 nuevas LE")

# Detalles de compartidos
shared_payment_count = 0
shared_with_reserves = 0
for sid, info in shared.items():
    descs = info['lib_descs']
    if 'payment' in descs:
        shared_payment_count += 1
    if 'reserve_for_payment' in descs:
        shared_with_reserves += 1

print(f"\nDesglose compartidos:")
print(f"  Con DESCRIPTION='payment': {shared_payment_count}")
print(f"  También con 'reserve_for_payment': {shared_with_reserves}")

print(f"\n[GRUPO 2: CREAR NUEVAS FM (solo en Liberaciones)]")
print(f"Total SOURCE_ID: {len(only_in_lib)}")

# Desglosar por tipo
by_type = defaultdict(list)
for sid, info in only_in_lib.items():
    for desc in info['descs']:
        by_type[desc].append(sid)

print(f"\nDesglose nuevos:")
for desc in sorted(by_type.keys()):
    sids = by_type[desc]
    unique = len(set(sids))
    print(f"  {desc}: {unique} SOURCE_ID únicos")

# Analizar si hay duplicados por SOURCE_ID
print(f"\nVerificación: ¿Hay SOURCE_ID que aparecen múltiples veces?")
duplicates = {sid: info['count'] for sid, info in only_in_lib.items() if info['count'] > 1}
if duplicates:
    print(f"  SI, {len(duplicates)} SOURCE_ID aparecen múltiples veces:")
    for sid, cnt in list(duplicates.items())[:5]:
        descs = only_in_lib[sid]['descs']
        print(f"    {sid}: {cnt} filas con DESCRIPTION={descs}")
else:
    print(f"  NO, cada SOURCE_ID nuevo aparece exactamente 1 vez")

# ============================================================================
# Validación de arquitectura
# ============================================================================

print(f"\n" + "="*200)
print("[VALIDACIÓN DE ARQUITECTURA]")
print("="*200)

print(f"\nPor importar:")
print(f"  SR (source_record): {len(lib_entries)} (tipo='liberaciones')")
print(f"  FM (financial_movement) nuevas: {len(only_in_lib)}")
print(f"  LE (ledger_entry) nuevas: {len(only_in_lib)}")
print(f"  Links (movement_source_link): {len(lib_entries)} (716 reutilizar + {len(only_in_lib)} nuevos)")

# Verificar impacto total
shared_net = sum(s['arch5_net'] for s in shared.values())
new_net = sum(o['net'] for o in only_in_lib.values())
total_net = shared_net + new_net

print(f"\nImpacto contable:")
print(f"  Compartidos (reutilizar FM): ${shared_net:,.2f}")
print(f"  Nuevos (crear FM): ${new_net:,.2f}")
print(f"  TOTAL: ${total_net:,.2f}")
print(f"  Esperado (MP UI): -$124,203.27")
print(f"  Diferencia: ${total_net - Decimal('-124203.27'):,.2f}")

# ============================================================================
# Estrategia final de RPC
# ============================================================================

print(f"\n" + "="*200)
print("[ESTRATEGIA RPC FINAL]")
print("="*200)

print(f"""
PSEUDOCÓDIGO:

FOR each row IN liberaciones_august_records:

  [1] SIEMPRE crear SR (source_record)
      source_type='liberaciones'
      source_external_id=SOURCE_ID
      payload=fila completa en JSON
      ON CONFLICT: recuperar SR_ID sin actualizar

  [2] Si balance_impact = 0 (reservas):
      STOP. Solo guardar RAW, sin FM/LE.

  [3] Buscar FM existente por SOURCE_ID en arch5 (compartidos)
      SELECT fm.id FROM mp_financial_movement fm
      WHERE correlate_by_source_id(fm, current_source_id) = TRUE

      Si existe:
        [3a] FM_ID = existente.id
        [3b] Crear LINK SR -> FM_ID
        [3c] STOP (LE ya existe)

      Si NO existe:
        [4] Crear FM nuevo
            account_id = p_account_id
            transaction_date = DATE
            settlement_date = TRANSACTION_APPROVAL_DATE
            movement_class = mapeo_seguro(DESCRIPTION)
            transaction_amount = balance_impact
            settlement_amount = balance_impact
            needs_review = FALSE (a menos que haya discrepancia)

        [5] Crear LINK SR -> FM_ID nuevo

        [6] Crear LE nuevo
            account_id = p_account_id
            financial_movement_id = FM_ID
            movement_class = movement_class
            occurred_at = transaction_date
            balance_impact = balance_impact

RESULTADO:
  SR creados: {len(lib_entries)}
  FM reutilizados: {len(shared)}
  FM nuevos: {len(only_in_lib)}
  LE nuevos: {len(only_in_lib)}
  Links nuevos: {len(lib_entries)} (todos, mezcla reutilizar + nuevos)
""")

# ============================================================================
# Mapeo de DESCRIPTION -> movement_class
# ============================================================================

print(f"\n[MAPEO DESCRIPTION -> movement_class]")
print(f"""
DESCRIPTION='payment'         -> movement_class='payment'     (696 compartidos)
DESCRIPTION='payout'          -> movement_class='payout'      (10 nuevos)
DESCRIPTION='asset_management'-> movement_class='yield'       (20 nuevos)
DESCRIPTION='reserve_*'       -> SKIP (balance_impact=0)
DESCRIPTION (desconocido)     -> movement_class='unknown'     (futuro)

WHITELIST actual (solo estos generan ledger):
  - payment
  - payout
  - asset_management (mapear a 'yield')
  - (otros son RAW only, sin impacto contable)
""")

print("\n" + "="*200)
print("ESTRATEGIA LISTA PARA IMPLEMENTAR")
print("="*200 + "\n")
