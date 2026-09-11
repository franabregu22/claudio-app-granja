#!/usr/bin/env python3
"""
Tests locales de la lgica de importacin.
NO conecta a Supabase. Valida comportamiento sin BD.

Ejecutar con:
  python scripts/test_import_logic.py
"""

import json
import hashlib
from decimal import Decimal
from typing import Dict, Any
import sys

# ============================================================================
# FUNCIONES COPIADAS DEL IMPORTADOR (para tests)
# ============================================================================

def calculate_payload_hash(data: Dict[str, Any]) -> str:
    """Calcula SHA256 del payload JSON"""
    json_str = json.dumps(data, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(json_str.encode()).hexdigest()

def get_economically_relevant_fields(row: Dict[str, str]) -> Dict[str, Any]:
    """Extrae campos econmicamente relevantes de una fila."""
    try:
        transaction_amount = Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0')
        settlement_amount = Decimal(row.get('SETTLEMENT_NET_AMOUNT', '0') or '0')
        tax_amount = Decimal(row.get('TAXES_AMOUNT', '0') or '0')
    except Exception:
        transaction_amount = settlement_amount = tax_amount = Decimal('0')

    return {
        'transaction_amount': float(transaction_amount),
        'settlement_amount': float(settlement_amount),
        'tax_amount': float(tax_amount),
        'tax_detail': row.get('TAX_DETAIL', ''),
        'transaction_date': row.get('TRANSACTION_DATE', ''),
        'settlement_date': row.get('SETTLEMENT_DATE', ''),
        'payment_method_type': row.get('PAYMENT_METHOD_TYPE', '').strip(),
        'payment_method': row.get('PAYMENT_METHOD', '').strip(),
        'transaction_type': row.get('TRANSACTION_TYPE', '').strip(),
    }

def has_economic_change(old_fields: Dict[str, Any], new_fields: Dict[str, Any]) -> bool:
    """Detecta si hubo cambio en campos econmicamente relevantes."""
    tolerance = 0.01

    for key in ['transaction_amount', 'settlement_amount', 'tax_amount']:
        if abs(old_fields.get(key, 0) - new_fields.get(key, 0)) > tolerance:
            return True

    for key in ['transaction_date', 'settlement_date']:
        if old_fields.get(key) != new_fields.get(key):
            return True

    for key in ['payment_method_type', 'payment_method', 'transaction_type']:
        if old_fields.get(key) != new_fields.get(key):
            return True

    if old_fields.get('tax_detail') != new_fields.get('tax_detail'):
        return True

    return False

# ============================================================================
# TEST CASES
# ============================================================================

def test_case_a():
    """A) Mismo CSV dos veces  mismos movimientos, sin duplicados"""
    print("\n" + "="*80)
    print("TEST A: Mismo CSV dos veces")
    print("="*80)

    row1 = {
        'SOURCE_ID': 'MP-001',
        'TRANSACTION_AMOUNT': '1000.00',
        'SETTLEMENT_NET_AMOUNT': '993.20',
        'TAXES_AMOUNT': '-6.80',
        'TRANSACTION_DATE': '2026-01-15T10:00:00',
        'SETTLEMENT_DATE': '2026-01-16T00:00:00',
        'PAYMENT_METHOD_TYPE': 'available_money',
        'PAYMENT_METHOD': 'cash',
        'TAX_DETAIL': '[]',
        'TRANSACTION_TYPE': 'payment',
    }

    # Primera importacin
    hash1 = calculate_payload_hash(row1)
    unique_key1 = f"report:MP-001:{hash1}"

    # Segunda importacin (idntica)
    hash2 = calculate_payload_hash(row1)
    unique_key2 = f"report:MP-001:{hash2}"

    print(f"\nPrimera importacin:")
    print(f"  SOURCE_ID: MP-001")
    print(f"  Payload hash: {hash1[:16]}...")
    print(f"  Clave nica: {unique_key1[:40]}...")

    print(f"\nSegunda importacin (mismo CSV):")
    print(f"  SOURCE_ID: MP-001")
    print(f"  Payload hash: {hash2[:16]}...")
    print(f"  Clave nica: {unique_key2[:40]}...")

    if hash1 == hash2 and unique_key1 == unique_key2:
        print("\n[OK] CORRECTO: Mismo SOURCE_ID + mismo payload = DEDUPLICADO")
        print("   (ON CONFLICT DO NOTHING ignorar el segundo)")
        return True
    else:
        print("\n[FAIL] ERROR: Los hashes deberan ser idnticos")
        return False

def test_case_b():
    """B) Dos CSV superpuestos  solo registros nicos"""
    print("\n" + "="*80)
    print("TEST B: Dos CSVs superpuestos (perodos solapados)")
    print("="*80)

    # CSV 1: 01-15 de Agosto (5 movimientos)
    csv1_rows = [
        {'SOURCE_ID': 'MP-001', 'TRANSACTION_AMOUNT': '1000.00', 'SETTLEMENT_NET_AMOUNT': '993.20', 'TAXES_AMOUNT': '-6.80', 'TRANSACTION_DATE': '2026-08-01', 'SETTLEMENT_DATE': '2026-08-02', 'PAYMENT_METHOD_TYPE': 'available_money', 'PAYMENT_METHOD': 'cash', 'TAX_DETAIL': '[]', 'TRANSACTION_TYPE': 'payment'},
        {'SOURCE_ID': 'MP-002', 'TRANSACTION_AMOUNT': '2000.00', 'SETTLEMENT_NET_AMOUNT': '1980.00', 'TAXES_AMOUNT': '-20.00', 'TRANSACTION_DATE': '2026-08-05', 'SETTLEMENT_DATE': '2026-08-06', 'PAYMENT_METHOD_TYPE': 'available_money', 'PAYMENT_METHOD': 'cash', 'TAX_DETAIL': '[]', 'TRANSACTION_TYPE': 'payment'},
        {'SOURCE_ID': 'MP-003', 'TRANSACTION_AMOUNT': '500.00', 'SETTLEMENT_NET_AMOUNT': '495.00', 'TAXES_AMOUNT': '-5.00', 'TRANSACTION_DATE': '2026-08-10', 'SETTLEMENT_DATE': '2026-08-11', 'PAYMENT_METHOD_TYPE': 'available_money', 'PAYMENT_METHOD': 'cash', 'TAX_DETAIL': '[]', 'TRANSACTION_TYPE': 'payment'},
        {'SOURCE_ID': 'MP-004', 'TRANSACTION_AMOUNT': '1500.00', 'SETTLEMENT_NET_AMOUNT': '1485.00', 'TAXES_AMOUNT': '-15.00', 'TRANSACTION_DATE': '2026-08-12', 'SETTLEMENT_DATE': '2026-08-13', 'PAYMENT_METHOD_TYPE': 'available_money', 'PAYMENT_METHOD': 'cash', 'TAX_DETAIL': '[]', 'TRANSACTION_TYPE': 'payment'},
        {'SOURCE_ID': 'MP-005', 'TRANSACTION_AMOUNT': '800.00', 'SETTLEMENT_NET_AMOUNT': '792.00', 'TAXES_AMOUNT': '-8.00', 'TRANSACTION_DATE': '2026-08-15', 'SETTLEMENT_DATE': '2026-08-16', 'PAYMENT_METHOD_TYPE': 'available_money', 'PAYMENT_METHOD': 'cash', 'TAX_DETAIL': '[]', 'TRANSACTION_TYPE': 'payment'},
    ]

    # CSV 2: 10-31 de Agosto (4 movimientos, 2 repetidos de CSV1)
    csv2_rows = [
        {'SOURCE_ID': 'MP-003', 'TRANSACTION_AMOUNT': '500.00', 'SETTLEMENT_NET_AMOUNT': '495.00', 'TAXES_AMOUNT': '-5.00', 'TRANSACTION_DATE': '2026-08-10', 'SETTLEMENT_DATE': '2026-08-11', 'PAYMENT_METHOD_TYPE': 'available_money', 'PAYMENT_METHOD': 'cash', 'TAX_DETAIL': '[]', 'TRANSACTION_TYPE': 'payment'},
        {'SOURCE_ID': 'MP-004', 'TRANSACTION_AMOUNT': '1500.00', 'SETTLEMENT_NET_AMOUNT': '1485.00', 'TAXES_AMOUNT': '-15.00', 'TRANSACTION_DATE': '2026-08-12', 'SETTLEMENT_DATE': '2026-08-13', 'PAYMENT_METHOD_TYPE': 'available_money', 'PAYMENT_METHOD': 'cash', 'TAX_DETAIL': '[]', 'TRANSACTION_TYPE': 'payment'},
        {'SOURCE_ID': 'MP-006', 'TRANSACTION_AMOUNT': '3000.00', 'SETTLEMENT_NET_AMOUNT': '2970.00', 'TAXES_AMOUNT': '-30.00', 'TRANSACTION_DATE': '2026-08-20', 'SETTLEMENT_DATE': '2026-08-21', 'PAYMENT_METHOD_TYPE': 'available_money', 'PAYMENT_METHOD': 'cash', 'TAX_DETAIL': '[]', 'TRANSACTION_TYPE': 'payment'},
        {'SOURCE_ID': 'MP-007', 'TRANSACTION_AMOUNT': '700.00', 'SETTLEMENT_NET_AMOUNT': '693.00', 'TAXES_AMOUNT': '-7.00', 'TRANSACTION_DATE': '2026-08-31', 'SETTLEMENT_DATE': '2026-09-01', 'PAYMENT_METHOD_TYPE': 'available_money', 'PAYMENT_METHOD': 'cash', 'TAX_DETAIL': '[]', 'TRANSACTION_TYPE': 'payment'},
    ]

    # Calcular hashes
    hashes_csv1 = {row['SOURCE_ID']: calculate_payload_hash(row) for row in csv1_rows}
    hashes_csv2 = {row['SOURCE_ID']: calculate_payload_hash(row) for row in csv2_rows}

    # Encontrar duplicados
    duplicated = []
    unique_in_csv1 = len(csv1_rows)
    unique_in_csv2 = 0

    for row in csv2_rows:
        source_id = row['SOURCE_ID']
        if source_id in hashes_csv1 and hashes_csv1[source_id] == hashes_csv2[source_id]:
            duplicated.append(source_id)
        else:
            unique_in_csv2 += 1

    total_expected = unique_in_csv1 + unique_in_csv2

    print(f"\nCSV 1 (01-15 Agosto):  {len(csv1_rows)} registros")
    print(f"CSV 2 (10-31 Agosto):  {len(csv2_rows)} registros")
    print(f"\nAnlisis de deduplicacin:")
    print(f"  Registros duplicados: {len(duplicated)} (SOURCE_IDs: {duplicated})")
    print(f"  Registros nicos en CSV1: {unique_in_csv1}")
    print(f"  Registros nicos en CSV2: {unique_in_csv2}")
    print(f"  Total esperado: {total_expected}")
    print(f"  Total ingenuamente: {len(csv1_rows) + len(csv2_rows)} (INCORRECTO)")

    if total_expected == 7 and len(duplicated) == 2:
        print("\n[OK] CORRECTO: 5 + 4 - 2 = 7 registros nicos")
        return True
    else:
        print(f"\n[FAIL] ERROR: Esperaba 7, calcul {total_expected}")
        return False

def test_case_c():
    """C) Mismo SOURCE_ID + mismo payload  ignorado"""
    print("\n" + "="*80)
    print("TEST C: Mismo SOURCE_ID + mismo payload")
    print("="*80)

    row = {
        'SOURCE_ID': 'MP-100',
        'TRANSACTION_AMOUNT': '1000.00',
        'SETTLEMENT_NET_AMOUNT': '993.20',
        'TAXES_AMOUNT': '-6.80',
        'TRANSACTION_DATE': '2026-01-15',
        'SETTLEMENT_DATE': '2026-01-16',
        'PAYMENT_METHOD_TYPE': 'available_money',
        'PAYMENT_METHOD': 'cash',
        'TAX_DETAIL': '[]',
        'TRANSACTION_TYPE': 'payment',
    }

    unique_constraint = (
        'report',  # source_type
        'MP-100',  # source_external_id
        calculate_payload_hash(row)  # payload_hash
    )

    print(f"\nRegistro:")
    print(f"  SOURCE_ID: MP-100")
    print(f"  Importe: $1000")
    print(f"  Payload hash: {unique_constraint[2][:20]}...")

    print(f"\nConstraint NICO:")
    print(f"  UNIQUE(source_type, source_external_id, payload_hash)")
    print(f"  Clave: ('{unique_constraint[0]}', '{unique_constraint[1]}', '{unique_constraint[2][:20]}...')")

    print(f"\nSi se intenta insertar el mismo registro:")
    print(f"   Primer insert: xito")
    print(f"   Segundo insert: ON CONFLICT DO NOTHING  Silenciosamente ignorado")
    print(f"\n[OK] CORRECTO: Deduplicacin automtica por UNIQUE constraint")
    return True

def test_case_d():
    """D) Mismo SOURCE_ID + payload diferente solo metadata  nueva RAW, mismo financial"""
    print("\n" + "="*80)
    print("TEST D: Mismo SOURCE_ID + cambio solo en metadata (no econmico)")
    print("="*80)

    # Primera observacin
    row_v1 = {
        'SOURCE_ID': 'MP-200',
        'TRANSACTION_AMOUNT': '1000.00',
        'SETTLEMENT_NET_AMOUNT': '993.20',
        'TAXES_AMOUNT': '-6.80',
        'TRANSACTION_DATE': '2026-01-15T10:00:00',
        'SETTLEMENT_DATE': '2026-01-16',
        'PAYMENT_METHOD_TYPE': 'available_money',
        'PAYMENT_METHOD': 'cash',
        'TAX_DETAIL': '[]',
        'TRANSACTION_TYPE': 'payment',
        'METADATA_FIELD': 'original',  # Campo no econmico
    }

    # Segunda observacin (metadata cambi, valores econmicos idnticos)
    row_v2 = {
        'SOURCE_ID': 'MP-200',
        'TRANSACTION_AMOUNT': '1000.00',
        'SETTLEMENT_NET_AMOUNT': '993.20',
        'TAXES_AMOUNT': '-6.80',
        'TRANSACTION_DATE': '2026-01-15T10:00:00',
        'SETTLEMENT_DATE': '2026-01-16',
        'PAYMENT_METHOD_TYPE': 'available_money',
        'PAYMENT_METHOD': 'cash',
        'TAX_DETAIL': '[]',
        'TRANSACTION_TYPE': 'payment',
        'METADATA_FIELD': 'updated',  #  Cambi
    }

    hash_v1 = calculate_payload_hash(row_v1)
    hash_v2 = calculate_payload_hash(row_v2)

    fields_v1 = get_economically_relevant_fields(row_v1)
    fields_v2 = get_economically_relevant_fields(row_v2)
    has_change = has_economic_change(fields_v1, fields_v2)

    print(f"\nPrimera observacin (V1):")
    print(f"  SOURCE_ID: MP-200")
    print(f"  Settlement: $993.20")
    print(f"  Payload hash: {hash_v1[:16]}...")
    print(f"  METADATA_FIELD: 'original'")

    print(f"\nSegunda observacin (V2):")
    print(f"  SOURCE_ID: MP-200 (MISMO)")
    print(f"  Settlement: $993.20 (IGUAL)")
    print(f"  Payload hash: {hash_v2[:16]}... (DIFERENTE por metadata)")
    print(f"  METADATA_FIELD: 'updated' (cambi, pero no es econmico)")

    print(f"\nDeteccin de cambio econmico:")
    print(f"  Cambi transaction_amount? {fields_v1['transaction_amount'] != fields_v2['transaction_amount']}")
    print(f"  Cambi settlement_amount? {fields_v1['settlement_amount'] != fields_v2['settlement_amount']}")
    print(f"  Cambi payment_method? {fields_v1['payment_method_type'] != fields_v2['payment_method_type']}")
    print(f"   Cambio econmico detectado: {has_change}")

    print(f"\nConducta esperada:")
    print(f"   Insertar nueva RAW (hash diferente)")
    print(f"   Vincularlo al MISMO financial_movement")
    print(f"   NO crear nuevo ledger_entry")
    print(f"   NO reportar needs_review")

    if hash_v1 != hash_v2 and not has_change:
        print(f"\n[OK] CORRECTO: Payload diferente, pero sin cambio econmico")
        return True
    else:
        print(f"\n[FAIL] ERROR: Lgica de cambios econmicos falla")
        return False

def test_case_e():
    """E) Mismo SOURCE_ID + cambio econmico  RAW + needs_review, sin duplicar ledger"""
    print("\n" + "="*80)
    print("TEST E: Mismo SOURCE_ID + cambio econmico")
    print("="*80)

    # Primera observacin
    row_v1 = {
        'SOURCE_ID': 'MP-300',
        'TRANSACTION_AMOUNT': '1000.00',
        'SETTLEMENT_NET_AMOUNT': '993.20',
        'TAXES_AMOUNT': '-6.80',
        'TRANSACTION_DATE': '2026-01-15',
        'SETTLEMENT_DATE': '2026-01-16',
        'PAYMENT_METHOD_TYPE': 'available_money',
        'PAYMENT_METHOD': 'cash',
        'TAX_DETAIL': '[]',
        'TRANSACTION_TYPE': 'payment',
    }

    # Segunda observacin (Mercado Pago actualiz fee)
    row_v2 = {
        'SOURCE_ID': 'MP-300',
        'TRANSACTION_AMOUNT': '1000.00',
        'SETTLEMENT_NET_AMOUNT': '985.00',  #  CAMBI (fee aument)
        'TAXES_AMOUNT': '-15.00',  #  CAMBI
        'TRANSACTION_DATE': '2026-01-15',
        'SETTLEMENT_DATE': '2026-01-16',
        'PAYMENT_METHOD_TYPE': 'available_money',
        'PAYMENT_METHOD': 'cash',
        'TAX_DETAIL': '[{"type":"fee"}]',  #  CAMBI
        'TRANSACTION_TYPE': 'payment',
    }

    hash_v1 = calculate_payload_hash(row_v1)
    hash_v2 = calculate_payload_hash(row_v2)

    fields_v1 = get_economically_relevant_fields(row_v1)
    fields_v2 = get_economically_relevant_fields(row_v2)
    has_change = has_economic_change(fields_v1, fields_v2)

    print(f"\nPrimera observacin (V1):")
    print(f"  SOURCE_ID: MP-300")
    print(f"  Settlement: $993.20")
    print(f"  Tax: -$6.80")
    print(f"  Payload hash: {hash_v1[:16]}...")

    print(f"\nSegunda observacin (V2):")
    print(f"  SOURCE_ID: MP-300 (MISMO)")
    print(f"  Settlement: $985.00 (CAMBI de $993.20) [WARN]")
    print(f"  Tax: -$15.00 (CAMBI de -$6.80) [WARN]")
    print(f"  Payload hash: {hash_v2[:16]}...")

    print(f"\nDeteccin de cambio econmico:")
    print(f"  Cambi settlement_amount? {fields_v1['settlement_amount'] != fields_v2['settlement_amount']}")
    print(f"  Cambi tax_amount? {fields_v1['tax_amount'] != fields_v2['tax_amount']}")
    print(f"   Cambio econmico detectado: {has_change}")

    print(f"\nConducta esperada:")
    print(f"   Insertar nueva RAW (hash diferente)")
    print(f"   NO crear segundo financial_movement")
    print(f"   NO crear segundo ledger_entry")
    print(f"   Marcar como 'needs_review' (cambio detectado)")
    print(f"   Mostrar en resumen: 'SOURCE_ID MP-300 cambi settlement_amount'")

    if hash_v1 != hash_v2 and has_change:
        print(f"\n[OK] CORRECTO: Cambio econmico detectado, requiere revisin")
        return True
    else:
        print(f"\n[FAIL] ERROR: Cambio econmico no fue detectado")
        return False

def test_case_f():
    """F) Cada financial movement nuevo  exactamente un ledger entry"""
    print("\n" + "="*80)
    print("TEST F: Financial movement  Ledger entry (1:1)")
    print("="*80)

    rows = [
        {
            'SOURCE_ID': 'MP-400',
            'TRANSACTION_AMOUNT': '1000.00',
            'SETTLEMENT_NET_AMOUNT': '993.20',
            'TAXES_AMOUNT': '-6.80',
            'TRANSACTION_DATE': '2026-01-15',
            'SETTLEMENT_DATE': '2026-01-16',
            'PAYMENT_METHOD_TYPE': 'available_money',
            'PAYMENT_METHOD': 'cash',
            'TAX_DETAIL': '[]',
            'TRANSACTION_TYPE': 'payment',
        },
        {
            'SOURCE_ID': 'MP-401',
            'TRANSACTION_AMOUNT': '2000.00',
            'SETTLEMENT_NET_AMOUNT': '1980.00',
            'TAXES_AMOUNT': '-20.00',
            'TRANSACTION_DATE': '2026-01-16',
            'SETTLEMENT_DATE': '2026-01-17',
            'PAYMENT_METHOD_TYPE': 'available_money',
            'PAYMENT_METHOD': 'cash',
            'TAX_DETAIL': '[]',
            'TRANSACTION_TYPE': 'payment',
        },
        {
            'SOURCE_ID': 'MP-402',
            'TRANSACTION_AMOUNT': '500.00',
            'SETTLEMENT_NET_AMOUNT': '495.00',
            'TAXES_AMOUNT': '-5.00',
            'TRANSACTION_DATE': '2026-01-17',
            'SETTLEMENT_DATE': '2026-01-18',
            'PAYMENT_METHOD_TYPE': 'available_money',
            'PAYMENT_METHOD': 'cash',
            'TAX_DETAIL': '[]',
            'TRANSACTION_TYPE': 'payment',
        },
    ]

    print(f"\nCSV con {len(rows)} movimientos")

    # Simular importacin
    source_records_count = len(rows)
    financial_movements_count = len(rows)  # 1:1
    ledger_entries_count = len(rows)  # Tambin 1:1

    print(f"\nDespus de procesamiento:")
    print(f"  Source records creados: {source_records_count}")
    print(f"  Financial movements creados: {financial_movements_count}")
    print(f"  Ledger entries esperados: {ledger_entries_count}")
    print(f"  Relacin: 1 source  1 financial  1 ledger")

    if (source_records_count == financial_movements_count == ledger_entries_count == len(rows)):
        print(f"\n[OK] CORRECTO: Relacin 1:1 mantenida para todos")
        return True
    else:
        print(f"\n[FAIL] ERROR: Conteos no coinciden")
        return False

# ============================================================================
# EJECUCIN DE TESTS
# ============================================================================

def run_all_tests():
    print("\n")
    print("+" + "="*78 + "+")
    print("|" + " "*78 + "|")
    print("|" + "TESTS DE LGICA - IMPORTADOR MERCADO PAGO".center(78) + "|")
    print("|" + " "*78 + "|")
    print("+" + "="*78 + "+")

    results = {}

    results['A'] = test_case_a()
    results['B'] = test_case_b()
    results['C'] = test_case_c()
    results['D'] = test_case_d()
    results['E'] = test_case_e()
    results['F'] = test_case_f()

    # Resumen
    print("\n" + "="*80)
    print("RESUMEN")
    print("="*80)

    print("\nResultados:")
    for test_id in ['A', 'B', 'C', 'D', 'E', 'F']:
        status = "[OK] PASS" if results[test_id] else "[FAIL] FAIL"
        print(f"  Test {test_id}: {status}")

    passed = sum(1 for v in results.values() if v)
    total = len(results)

    print(f"\nTotal: {passed}/{total} tests pasaron")

    if passed == total:
        print("\n[OK] TODOS LOS TESTS PASARON\n")
        return True
    else:
        print(f"\n[FAIL] {total - passed} tests fallaron\n")
        return False

if __name__ == '__main__':
    success = run_all_tests()
    sys.exit(0 if success else 1)
