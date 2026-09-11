#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Importer: Liberaciones.csv -> Supabase v8 FINAL
Con checkpoint atomico por batch para rollback parcial seguro
"""

import csv
import json
import hashlib
import os
import sys
from pathlib import Path
from decimal import Decimal, InvalidOperation
from datetime import datetime

from dotenv import load_dotenv
from supabase import create_client

# ============================================================================
# CONFIG
# ============================================================================

env_path = Path('.env.local')
if not env_path.exists():
    print("ERROR: .env.local no encontrado")
    sys.exit(1)

load_dotenv(dotenv_path=env_path)

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
ACCOUNT_ID = int(os.getenv('ACCOUNT_ID', '1054315166'))
BATCH_SIZE = 100

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Credenciales no configuradas")
    sys.exit(1)

# ============================================================================
# FUNCIONES
# ============================================================================

def parse_decimal(value):
    """Parsear valor a Decimal, tolerando vacio/None"""
    if value is None:
        return Decimal('0')
    value = str(value).strip()
    if value == '':
        return Decimal('0')
    try:
        return Decimal(value.replace(',', '.'))
    except InvalidOperation as e:
        raise ValueError(f"Numero malformado: '{value}' ({e})")

def normalize_row(csv_row):
    """Normalizar fila CSV a JSONB"""
    try:
        cr = parse_decimal(csv_row.get('NET_CREDIT_AMOUNT'))
        db = parse_decimal(csv_row.get('NET_DEBIT_AMOUNT'))
        gross = parse_decimal(csv_row.get('GROSS_AMOUNT'))
        tax = parse_decimal(csv_row.get('TAXES_AMOUNT'))
    except ValueError as e:
        raise ValueError(f"Fila malformada: {e}")

    raw_data = {key: str(value) for key, value in csv_row.items()}
    raw_json = json.dumps(raw_data, sort_keys=True)
    payload_hash = hashlib.sha256(raw_json.encode()).hexdigest()

    return {
        'source_external_id': csv_row.get('SOURCE_ID'),
        'description': csv_row.get('DESCRIPTION'),
        'transaction_date': csv_row.get('DATE'),
        'net_credit': str(cr),
        'net_debit': str(db),
        'gross_amount': str(gross),
        'tax_amount': str(tax),
        'payment_method': csv_row.get('PAYMENT_METHOD', ''),
        'payment_method_type': csv_row.get('PAYMENT_METHOD_TYPE', ''),
        'payload_hash': payload_hash,
        'raw_data': raw_data
    }

def read_csv(path):
    """Leer CSV de Liberaciones"""
    records = []
    with open(path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        for row in reader:
            if row:
                records.append(row)
    return records

def import_batch(client, batch_records):
    """Ejecutar RPC para un lote"""
    normalized = []
    for r in batch_records:
        try:
            normalized.append(normalize_row(r))
        except ValueError as e:
            raise Exception(f"Fila malformada (error numerico): {e}")

    if not normalized:
        return {'summary': {}}

    try:
        result = client.rpc(
            'import_liberaciones_primary',
            {'p_account_id': ACCOUNT_ID, 'p_input': normalized}
        ).execute()
        if not result.data.get('success', False):
            raise Exception(f"RPC error: {result.data}")
        return result.data
    except Exception as e:
        raise

def save_checkpoint(result_path, accumulated_result):
    """
    Guardar checkpoint atomicamente usando temp + rename
    BLOQUEADOR DE CONTROL: Checkpoint por batch para rollback parcial seguro
    """
    tmp_path = result_path.with_suffix('.tmp')
    try:
        with open(tmp_path, 'w') as f:
            json.dump(accumulated_result, f, indent=2, default=str)
        os.replace(tmp_path, result_path)
    except Exception as e:
        raise Exception(f"Checkpoint error: {e}")

def main():
    """Flujo principal"""

    if len(sys.argv) < 2:
        print("Uso: python scripts/import_liberaciones.py <CSV_PATH>")
        sys.exit(1)

    csv_path = Path(sys.argv[1])

    if not csv_path.exists():
        print(f"ERROR: {csv_path} no existe")
        sys.exit(1)

    print("\n" + "="*120)
    print(f"IMPORTER: {csv_path.name} -> Supabase v8 (con checkpoint por batch)")
    print("="*120)

    try:
        client = create_client(SUPABASE_URL, SUPABASE_KEY)
        print(f"\n[1] Conectado. Account ID: {ACCOUNT_ID}")
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    print(f"\n[2] Leyendo {csv_path.name}...")
    try:
        records = read_csv(csv_path)
        print(f"    Registros totales: {len(records)}")
    except Exception as e:
        print(f"    ERROR: {e}")
        sys.exit(1)

    if not records:
        print("    ERROR: Archivo vacio")
        sys.exit(1)

    print(f"\n[3] Procesando {len(records)} registros...")

    total_sr_created = 0
    total_sr_existing = 0
    total_sr_raw_only = 0
    total_fm_created = 0
    total_le_created = 0
    total_links = 0

    all_batches_result = []
    result_path = Path('liberaciones_import_result.json')

    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i:i+BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(records) + BATCH_SIZE - 1) // BATCH_SIZE

        print(f"    Batch {batch_num}/{total_batches} ({len(batch)} registros)...")

        try:
            result = import_batch(client, batch)
            summary = result.get('summary', {})

            total_sr_created += summary.get('source_records_created', 0)
            total_sr_existing += summary.get('source_records_existing', 0)
            total_sr_raw_only += summary.get('source_records_raw_only', 0)
            total_fm_created += summary.get('financial_movements_created', 0)
            total_le_created += summary.get('ledger_entries_created', 0)
            total_links += summary.get('movement_source_links_created', 0)

            all_batches_result.append(result)

            print(f"      SR: {summary.get('source_records_created', 0)} nuevos, " +
                  f"{summary.get('source_records_existing', 0)} existentes, " +
                  f"{summary.get('source_records_raw_only', 0)} raw-only")
            print(f"      FM: {summary.get('financial_movements_created', 0)} nuevos")
            print(f"      LE: {summary.get('ledger_entries_created', 0)} nuevas")
            print(f"      LINK: {summary.get('movement_source_links_created', 0)} nuevos")

            # BLOQUEADOR DE CONTROL: Guardar checkpoint INMEDIATAMENTE despues de cada batch exitoso
            accumulated = {
                'timestamp': datetime.now().isoformat(),
                'account_id': ACCOUNT_ID,
                'batch_number': batch_num,
                'total_batches': total_batches,
                'records_processed_so_far': i + len(batch),
                'summary': {
                    'sr_created_total': total_sr_created,
                    'sr_existing_total': total_sr_existing,
                    'sr_raw_only_total': total_sr_raw_only,
                    'fm_created_total': total_fm_created,
                    'le_created_total': total_le_created,
                    'links_created_total': total_links
                },
                'batches': all_batches_result
            }
            save_checkpoint(result_path, accumulated)
            print(f"      [Checkpoint guardado]")

        except Exception as e:
            print(f"      ERROR: {e}")
            print(f"\n      BATCH FALLÓ (batch {batch_num} abortado)")
            print(f"      Batches anteriores {batch_num - 1} permanecen committed")
            print(f"      Checkpoint disponible: {result_path}")
            sys.exit(1)

    # Resumen final
    print(f"\n" + "="*120)
    print("RESUMEN IMPORTACION")
    print("="*120)

    total_sr = total_sr_created + total_sr_existing

    print(f"\nSource Records: {total_sr}")
    print(f"  Creados: {total_sr_created}")
    print(f"  Existentes: {total_sr_existing}")
    print(f"  Raw-only: {total_sr_raw_only}")

    print(f"\nFinancial Movements: {total_fm_created} nuevos")
    print(f"Ledger Entries: {total_le_created} nuevas")
    print(f"Links: {total_links} nuevos")

    print(f"\n" + "="*120 + "\n")
    print("Resultado guardado: liberaciones_import_result.json")
    print("Rollback seguro disponible (sin ejecutar automaticamente)")

if __name__ == '__main__':
    main()
