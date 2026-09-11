#!/usr/bin/env python3
"""
Importador de Account Money Reports de Mercado Pago (mltiples CSVs histricos).

Caractersticas:
   Detecta automticamente todos los CSVs en data/mercadopago/
   Valida estructura flexible (columnas mnimas, permite nuevas)
   Deduplicacin automtica por (source_type, source_external_id, payload_hash)
   Permite perodos superpuestos sin duplicar movimientos
   Preserva RAW completo en JSONB
   Inserts por lotes (NO genera archivos SQL gigantes)
   Idempotente: seguro ejecutar mltiples veces
   Transaccional en medida de lo posible
   Resumen detallado al finalizar

Uso:
  python scripts/import_mp_reports.py

Configuracin:
  1. Crea .env.local en la raz del proyecto
  2. Completa SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY
  3. Ver instrucciones abajo
"""

import os
import sys
import json
import csv
import hashlib
from pathlib import Path
from decimal import Decimal
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass, field
from collections import defaultdict

# ============================================================================
# CARGAR CONFIGURACIN DESDE .env.local
# ============================================================================

def load_env_file():
    """Carga variables de entorno desde .env.local"""
    env_path = Path(__file__).parent.parent / ".env.local"

    if not env_path.exists():
        print("\n" + "="*80)
        print("ERROR: No se encontr .env.local")
        print("="*80)
        print("\nSolucin:")
        print("  1. Abre este archivo en un editor")
        print("  2. Ve a la seccin INSTRUCCIONES_SETUP ms abajo")
        print("  3. Sigue los pasos para crear .env.local")
        print("\n" + "="*80 + "\n")
        sys.exit(1)

    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, value = line.split('=', 1)
                os.environ[key.strip()] = value.strip()

load_env_file()

SUPABASE_URL = os.environ.get('SUPABASE_URL', '').strip()
SUPABASE_SERVICE_ROLE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '').strip()
ACCOUNT_ID = int(os.environ.get('ACCOUNT_ID', '1054315166'))
LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO')

# Validar configuracin
if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    print("\n[FAIL] ERROR: Credenciales de Supabase incompletas")
    print(f"   SUPABASE_URL: {'[OK]' if SUPABASE_URL else '[FAIL]'}")
    print(f"   SUPABASE_SERVICE_ROLE_KEY: {'[OK]' if SUPABASE_SERVICE_ROLE_KEY else '[FAIL]'}")
    print("\nVer: .env.local.example\n")
    sys.exit(1)

# Usar supabase-py si est disponible, si no, usar requests
try:
    from supabase import create_client
    SUPABASE_CLIENT = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    USE_SUPABASE_LIB = True
except ImportError:
    try:
        import requests
        USE_SUPABASE_LIB = False
    except ImportError:
        print("[FAIL] Instala: pip install supabase requests")
        sys.exit(1)

# ============================================================================
# CONFIGURACIN DE MOVIMIENTOS
# ============================================================================

MOVEMENT_CLASS_RULES = [
    ('yield', lambda row: (
        not row.get('PAYMENT_METHOD_TYPE', '').strip()
        and not row.get('PAYER_NAME', '').strip()
        and not row.get('PAYER_ID_NUMBER', '').strip()
        and Decimal(row.get('TAXES_AMOUNT', '0') or '0') == 0
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') > 0
    )),
    ('transfer_out', lambda row: (
        Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') < 0
        and row.get('PAYER_NAME', '').strip() == 'GRANJA SANTO TOMAS S.A.S.'
    )),
    ('transfer_in', lambda row: (
        row.get('PAYMENT_METHOD_TYPE', '').strip() == 'bank_transfer'
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') > 0
    )),
    ('payment_in', lambda row: (
        row.get('PAYMENT_METHOD_TYPE', '').strip() == 'available_money'
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') > 0
    )),
    ('payment_out', lambda row: (
        row.get('PAYMENT_METHOD_TYPE', '').strip() == 'available_money'
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') < 0
    )),
    ('digital_currency_payment_in', lambda row: (
        row.get('PAYMENT_METHOD_TYPE', '').strip() == 'digital_currency'
        and row.get('PAYMENT_METHOD', '').strip() == 'consumer_credits'
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') > 0
    )),
    ('credit_card_payment_in', lambda row: (
        row.get('PAYMENT_METHOD_TYPE', '').strip() == 'credit_card'
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') > 0
    )),
]

LEDGER_CATEGORY_MAP = {
    'payment_in': 'income',
    'payment_out': 'expense',
    'yield': 'interest_income',
    'transfer_in': 'transfer',
    'transfer_out': 'transfer',
    'unclassified': 'other',
}

REQUIRED_COLUMNS = {
    'SOURCE_ID', 'TRANSACTION_DATE', 'TRANSACTION_AMOUNT',
    'SETTLEMENT_NET_AMOUNT', 'TAXES_AMOUNT'
}

# ============================================================================
# ESTRUCTURAS DE DATOS
# ============================================================================

@dataclass
class ImportStats:
    """Estadsticas de importacin"""
    csv_files_found: int = 0
    csv_files_processed: int = 0
    csv_files_error: List[Tuple[str, str]] = field(default_factory=list)

    rows_read: int = 0
    rows_error: List[Tuple[str, int, str]] = field(default_factory=list)

    source_records_new: int = 0
    source_records_existing: int = 0
    source_records_modified: int = 0  # Mismo SOURCE_ID pero payload_hash diferente

    financial_movements_new: int = 0
    financial_movements_existing: int = 0

    movement_links_new: int = 0

    ledger_entries_new: int = 0
    ledger_entries_existing: int = 0

    needs_review: List[str] = field(default_factory=list)  # Cambios econmicos detectados

    movements_by_class: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    yields_total: Decimal = Decimal('0')
    taxes_total: Decimal = Decimal('0')
    balance_impact_total: Decimal = Decimal('0')

    errors: List[str] = field(default_factory=list)

# ============================================================================
# UTILIDADES
# ============================================================================

def log(msg: str, level: str = 'INFO'):
    """Log con timestamp"""
    if LOG_LEVEL in ('DEBUG', 'INFO') or level in ('WARNING', 'ERROR'):
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        print(f"[{timestamp}] {level:8} {msg}")

def calculate_payload_hash(data: Dict[str, Any]) -> str:
    """Calcula SHA256 del payload JSON"""
    json_str = json.dumps(data, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(json_str.encode()).hexdigest()

def parse_iso_datetime(dt_str: str) -> Optional[str]:
    """Parsea datetime ISO  timestamp Postgres"""
    if not dt_str or not dt_str.strip():
        return None
    try:
        dt = datetime.fromisoformat(dt_str.replace('Z', '+00:00'))
        return dt.isoformat()
    except Exception:
        return None

def classify_movement(row: Dict[str, str]) -> str:
    """Clasifica movimiento segn reglas"""
    for class_name, rule_func in MOVEMENT_CLASS_RULES:
        try:
            if rule_func(row):
                if class_name in ('credit_card_payment_in', 'digital_currency_payment_in'):
                    return 'payment_in'
                return class_name
        except Exception:
            pass
    return 'unclassified'

def extract_tax_detail(tax_detail_str: str) -> Optional[Dict]:
    """Parsea TAX_DETAIL JSON"""
    if not tax_detail_str or tax_detail_str.strip() in ('', '[]'):
        return None
    try:
        data = json.loads(tax_detail_str)
        if isinstance(data, list) and len(data) > 0:
            return data[0]
        return data if isinstance(data, dict) else None
    except Exception:
        return None

def calculate_tax_percentage(tax_amount: Decimal, transaction_amount: Decimal) -> Optional[Decimal]:
    """Calcula porcentaje de impuesto"""
    if transaction_amount == 0 or tax_amount is None:
        return None
    try:
        return (abs(tax_amount) / abs(transaction_amount) * 100).quantize(Decimal('0.0001'))
    except Exception:
        return None

def get_economically_relevant_fields(row: Dict[str, str]) -> Dict[str, Any]:
    """
    Extrae campos econmicamente relevantes de una fila.
    Usada para detectar cambios que requieren revisin.
    """
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
        'transaction_date': parse_iso_datetime(row.get('TRANSACTION_DATE', '')),
        'settlement_date': parse_iso_datetime(row.get('SETTLEMENT_DATE', '')),
        'payment_method_type': row.get('PAYMENT_METHOD_TYPE', '').strip(),
        'payment_method': row.get('PAYMENT_METHOD', '').strip(),
        'transaction_type': row.get('TRANSACTION_TYPE', '').strip(),
    }

def has_economic_change(old_fields: Dict[str, Any], new_fields: Dict[str, Any]) -> bool:
    """
    Detecta si hubo cambio en campos econmicamente relevantes.
    Retorna True si hay cambio que requiere revisin.
    """
    # Comparar campos numricos con tolerancia
    tolerance = 0.01  # 1 centavo

    for key in ['transaction_amount', 'settlement_amount', 'tax_amount']:
        if abs(old_fields.get(key, 0) - new_fields.get(key, 0)) > tolerance:
            return True

    # Comparar fechas
    for key in ['transaction_date', 'settlement_date']:
        if old_fields.get(key) != new_fields.get(key):
            return True

    # Comparar mtodos de pago
    for key in ['payment_method_type', 'payment_method', 'transaction_type']:
        if old_fields.get(key) != new_fields.get(key):
            return True

    # Comparar detalle de impuestos
    if old_fields.get('tax_detail') != new_fields.get('tax_detail'):
        return True

    return False

# ============================================================================
# VALIDACIN DE CSV
# ============================================================================

def validate_csv_structure(csv_path: Path, rows: List[Dict[str, str]]) -> Tuple[bool, Optional[str]]:
    """
    Valida estructura del CSV.
    Retorna (es_vlido, mensaje_error)
    """
    if not rows:
        return False, "CSV vaco"

    # Revisar columnas
    headers = set(rows[0].keys())
    missing = REQUIRED_COLUMNS - headers

    if missing:
        return False, f"Columnas faltantes: {', '.join(sorted(missing))}"

    return True, None

# ============================================================================
# LECTURA DE CSVS
# ============================================================================

def read_csv_file(csv_path: Path) -> Tuple[Optional[List[Dict]], Optional[str]]:
    """
    Lee CSV y retorna (rows, error)
    """
    try:
        rows = []
        with open(csv_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f, delimiter=';')
            if reader.fieldnames is None:
                return None, "CSV sin encabezados"

            for i, row in enumerate(reader, 1):
                if row is None:
                    continue
                rows.append(row)

        return rows, None
    except Exception as e:
        return None, f"Error leyendo CSV: {str(e)}"

def discover_csv_files() -> List[Path]:
    """Descubre todos los CSVs en data/mercadopago/"""
    data_dir = Path(__file__).parent.parent / "data" / "mercadopago"
    if not data_dir.exists():
        log(f"Directorio no existe: {data_dir}", 'WARNING')
        return []

    csvs = sorted(data_dir.glob("*.csv"))
    return csvs

# ============================================================================
# CONSTRUCCIN DE REGISTROS PARA INSERTAR
# ============================================================================

def build_source_record(row: Dict[str, str], csv_filename: str) -> Dict[str, Any]:
    """Construye record para insertar en mp_source_record"""
    source_id = row.get('SOURCE_ID', '')
    raw_data = dict(row)
    payload_hash = calculate_payload_hash(raw_data)
    observed_at = parse_iso_datetime(row.get('TRANSACTION_DATE', ''))

    return {
        'source_type': 'report',
        'source_external_id': source_id,
        'payload_hash': payload_hash,
        'raw_data': raw_data,
        'observed_at': observed_at,
        'received_at': datetime.now().isoformat(),
        'processing_status': 'processed',
    }

def build_financial_movement(row: Dict[str, str], movement_class: str) -> Dict[str, Any]:
    """Construye record para insertar en mp_financial_movement"""
    try:
        transaction_amount = Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0')
        settlement_amount = Decimal(row.get('SETTLEMENT_NET_AMOUNT', '0') or '0')
        tax_amount = Decimal(row.get('TAXES_AMOUNT', '0') or '0')
    except Exception:
        transaction_amount = settlement_amount = tax_amount = Decimal('0')

    tax_percentage = calculate_tax_percentage(tax_amount, transaction_amount)
    tax_detail = extract_tax_detail(row.get('TAX_DETAIL', ''))

    transaction_date = parse_iso_datetime(row.get('TRANSACTION_DATE', ''))
    settlement_date = parse_iso_datetime(row.get('SETTLEMENT_DATE', ''))

    return {
        'account_id': ACCOUNT_ID,
        'movement_class': movement_class,
        'transaction_amount': float(transaction_amount),
        'settlement_amount': float(settlement_amount),
        'tax_amount': float(tax_amount),
        'tax_detail': tax_detail,
        'tax_percentage': float(tax_percentage) if tax_percentage else None,
        'payment_method': row.get('PAYMENT_METHOD_TYPE') or None,
        'payment_detail': row.get('PAYMENT_METHOD') or None,
        'payer_name': row.get('PAYER_NAME') or None,
        'payer_id_type': row.get('PAYER_ID_TYPE') or None,
        'payer_id_number': row.get('PAYER_ID_NUMBER') or None,
        'transaction_date': transaction_date,
        'settlement_date': settlement_date,
        'order_id': row.get('ORDER_ID') or None,
        'external_reference': row.get('EXTERNAL_REFERENCE') or None,
        'bank_transfer_id': row.get('PAY_BANK_TRANSFER_ID') or None,
    }

def build_ledger_entry(source_id: str, movement_class: str, row: Dict[str, str]) -> Dict[str, Any]:
    """Construye record para insertar en ledger_entry"""
    settlement_amount = Decimal(row.get('SETTLEMENT_NET_AMOUNT', '0') or '0')
    category = LEDGER_CATEGORY_MAP.get(movement_class, 'other')
    transaction_date = parse_iso_datetime(row.get('TRANSACTION_DATE', ''))

    return {
        'account_id': ACCOUNT_ID,
        'balance_impact': float(settlement_amount),
        'category': category,
        'source_reference': f"SOURCE_ID={source_id} (report)",
        'description': f"{movement_class.upper()}: {row.get('PAYER_NAME', 'N/A')}",
        'observation': None,
        'occurred_at': transaction_date,
    }

# ============================================================================
# INSERCIN EN SUPABASE
# ============================================================================

def get_existing_source_records() -> set:
    """
    Consulta Supabase y retorna SET de (source_type, source_external_id, payload_hash)
    que ya existen. Usado para deduplicacin en Python.
    """
    import requests

    try:
        headers = {
            'Content-Type': 'application/json',
        }

        url = f'{SUPABASE_URL}/rest/v1/mp_source_record?select=source_type,source_external_id,payload_hash&apikey={SUPABASE_SERVICE_ROLE_KEY}'
        response = requests.get(url, headers=headers)

        if response.status_code == 200:
            data = response.json()
            existing = set()
            for row in data:
                key = (row['source_type'], row['source_external_id'], row['payload_hash'])
                existing.add(key)
            return existing
        else:
            log(f"Advertencia: no se pudieron consultar source records existentes (HTTP {response.status_code})", 'WARNING')
            return set()
    except Exception as e:
        log(f"Advertencia: error consultando source records existentes: {str(e)}", 'WARNING')
        return set()

def batch_insert_records(
    table: str,
    records: List[Dict[str, Any]],
    batch_size: int = 100,
    dedup_key: Optional[str] = None
) -> Tuple[int, int, List[str], List[int]]:
    """
    Inserta registros por lotes con deduplicacin en Python.
    Retorna (nuevos, existentes, errores, indices_de_nuevos)

    dedup_key: 'source' para usar UNIQUE constraint de source_record
    indices_de_nuevos: ndices de los registros que FUERON insertados (no duplicados)
    """
    if not records:
        return 0, 0, [], []

    import requests

    new_count = 0
    existing_count = 0
    errors = []
    indices_nuevos = []  # ndices de records que NO fueron duplicados

    # Si es source_record, consultar existentes y filtrar
    existing_keys = set()
    filtered_records = records
    if dedup_key == 'source' and table == 'mp_source_record':
        log(f"  Consultando {table} existentes para deduplicacin...", 'DEBUG')
        existing_keys = get_existing_source_records()
        log(f"  {len(existing_keys)} registros ya existen", 'DEBUG')

        # Filtrar registros Y guardar sus ndices
        filtered_records = []
        for idx, rec in enumerate(records):
            key = (rec.get('source_type'), rec.get('source_external_id'), rec.get('payload_hash'))
            if key not in existing_keys:
                filtered_records.append(rec)
                indices_nuevos.append(idx)
            else:
                existing_count += 1

        if not filtered_records:
            return 0, existing_count, [], []

    # Procesar en lotes
    for i in range(0, len(filtered_records), batch_size):
        batch = filtered_records[i:i+batch_size]

        try:
            headers = {
                'Content-Type': 'application/json',
                'Prefer': 'return=representation,count=exact',
            }

            url = f'{SUPABASE_URL}/rest/v1/{table}?apikey={SUPABASE_SERVICE_ROLE_KEY}'
            response = requests.post(url, json=batch, headers=headers)

            if response.status_code in (200, 201):
                new_count += len(batch)
            else:
                errors.append(f"Batch {i//batch_size}: HTTP {response.status_code} - {response.text[:100]}")

        except Exception as e:
            errors.append(f"Batch {i//batch_size}: {str(e)}")

    return new_count, existing_count, errors, indices_nuevos

# ============================================================================
# IMPORTACIN PRINCIPAL
# ============================================================================

def import_csv_file(csv_path: Path, stats: ImportStats) -> bool:
    """
    Importa un archivo CSV individual.
    Retorna True si fue exitoso.
    """
    log(f"\n[FILE] Procesando: {csv_path.name}")

    # Leer CSV
    rows, read_error = read_csv_file(csv_path)
    if read_error:
        msg = f"Error leyendo {csv_path.name}: {read_error}"
        log(msg, 'ERROR')
        stats.csv_files_error.append((csv_path.name, read_error))
        return False

    # Validar estructura
    is_valid, validation_error = validate_csv_structure(csv_path, rows)
    if not is_valid:
        msg = f"CSV invlido {csv_path.name}: {validation_error}"
        log(msg, 'ERROR')
        stats.csv_files_error.append((csv_path.name, validation_error))
        return False

    log(f"  [OK] Estructura vlida ({len(rows)} filas)")
    stats.rows_read += len(rows)

    # Procesar filas
    source_records = []
    financial_movements = []
    movement_links = []
    ledger_entries = []

    for row_idx, row in enumerate(rows, 1):
        try:
            # Clasificar movimiento
            movement_class = classify_movement(row)
            source_id = row.get('SOURCE_ID', '')

            # Contabilizar por clase
            stats.movements_by_class[movement_class] += 1

            # Sumar rendimientos y impuestos
            if movement_class == 'yield':
                try:
                    stats.yields_total += Decimal(row.get('SETTLEMENT_NET_AMOUNT', '0') or '0')
                except Exception:
                    pass

            try:
                tax = Decimal(row.get('TAXES_AMOUNT', '0') or '0')
                stats.taxes_total += tax
                settlement = Decimal(row.get('SETTLEMENT_NET_AMOUNT', '0') or '0')
                stats.balance_impact_total += settlement
            except Exception:
                pass

            # Construir registros
            source_record = build_source_record(row, csv_path.name)
            financial_movement = build_financial_movement(row, movement_class)

            source_records.append({
                'data': source_record,
                'source_id': source_id,
                'payload_hash': source_record['payload_hash'],
                'economic_fields': get_economically_relevant_fields(row),
                'movement_class': movement_class,
                'row': row,
            })

            financial_movements.append(financial_movement)

        except Exception as e:
            stats.rows_error.append((csv_path.name, row_idx, str(e)))
            log(f"   Fila {row_idx}: {str(e)}", 'WARNING')

    # ========================================================================
    # INSERTAR VÍA RPC v2 (import_financial_pipeline)
    # ========================================================================

    if not source_records:
        log(f"  [OK] {csv_path.name} importado exitosamente (0 registros)")
        return True

    # Deduplicar en Python antes de llamar RPC
    log(f"  Consultando mp_source_record existentes para deduplicacin...")
    existing_keys = get_existing_source_records()
    log(f"  {len(existing_keys)} registros ya existen")

    source_records_new = []
    for sr in source_records:
        key = (sr['data'].get('source_type'), sr['data'].get('source_external_id'), sr['data'].get('payload_hash'))
        if key not in existing_keys:
            source_records_new.append(sr)
        else:
            stats.source_records_existing += 1

    if not source_records_new:
        log(f"  [OK] {csv_path.name} importado exitosamente (todos deduplicados)")
        return True

    # Construir input JSONB para la RPC (versionado RAW)
    log(f"  Llamando RPC import_financial_pipeline con {len(source_records_new)} registros...")

    rpc_records = []
    for idx, sr in enumerate(source_records_new):
        row = sr['row']
        movement_class = sr['movement_class']

        # Construir input para la RPC
        # DEBUG: loguear el primer registro
        if idx == 0:
            log(f"  [DEBUG] Primer registro a enviar: {sr['data'].get('source_external_id')}", 'DEBUG')

        rpc_input = {
            'source_type': 'report',
            'source_external_id': str(row.get('SOURCE_ID', '')),
            'payload_hash': sr['data'].get('payload_hash'),
            'raw_data': {'version': 1, 'source': 'csv_import'},
            'observed_at': row.get('TRANSACTION_DATE'),
            'account_id': int(row.get('ACCOUNT_ID', ACCOUNT_ID)),
            'movement_class': movement_class,
            'transaction_amount': row.get('TRANSACTION_AMOUNT', '0'),
            'settlement_amount': row.get('SETTLEMENT_NET_AMOUNT', '0'),
            'tax_amount': row.get('TAXES_AMOUNT', '0'),
            'tax_percentage': row.get('TAXES_PERCENT', '0'),
            'payment_method': row.get('PAYMENT_METHOD_TYPE'),
            'payment_detail': row.get('PAYMENT_METHOD_ID'),
            'payer_name': row.get('PAYER_NAME'),
            'payer_id_type': row.get('PAYER_ID_TYPE'),
            'payer_id_number': row.get('PAYER_ID_NUMBER'),
            'transaction_date': row.get('TRANSACTION_DATE'),
            'settlement_date': row.get('SETTLEMENT_DATE'),
            'order_id': row.get('ORDER_ID'),
            'external_reference': row.get('EXTERNAL_REFERENCE'),
            'bank_transfer_id': row.get('BANK_TRANSFER_ID'),
        }

        rpc_records.append(rpc_input)

    # Llamar RPC en lotes de 100 registros
    batch_size = 100
    rpc_errors = []
    rpc_new = 0
    rpc_existing = 0
    rpc_fm_new = 0
    rpc_ledger_new = 0
    rpc_needs_review = 0

    for i in range(0, len(rpc_records), batch_size):
        batch = rpc_records[i:i+batch_size]
        batch_num = i // batch_size

        try:
            import requests
            import json as json_module

            # Llamar RPC via PostgREST
            headers = {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_ROLE_KEY,
            }

            url = f'{SUPABASE_URL}/rest/v1/rpc/import_financial_pipeline'
            rpc_payload = {'p_input': {'records': batch}}

            # DEBUG: Validar JSON localmente antes de enviar
            if batch_num == 0 and len(batch) > 0:
                try:
                    test_json = json_module.dumps(rpc_payload, ensure_ascii=False, allow_nan=False)
                    json_module.loads(test_json)
                    log(f"    Batch {batch_num}: JSON local válido ({len(test_json)} bytes)", 'DEBUG')
                except Exception as e:
                    log(f"    Batch {batch_num}: JSON local INVÁLIDO - {str(e)}", 'ERROR')
                    log(f"      Primer record: {batch[0]}", 'ERROR')
                    raise

            response = requests.post(url, json=rpc_payload, headers=headers)

            if response.status_code in (200, 201):
                result = response.json()
                if isinstance(result, list) and len(result) > 0:
                    result = result[0]

                if result.get('success', False):
                    rpc_new += result.get('source_records_new', 0)
                    rpc_existing += result.get('source_records_existing', 0)
                    rpc_fm_new += result.get('financial_movements_new', 0)
                    rpc_ledger_new += result.get('ledger_entries_new', 0)
                    rpc_needs_review += result.get('needs_review_marked', 0)
                    log(f"    Batch {batch_num}: OK (new={result.get('source_records_new', 0)}, existing={result.get('source_records_existing', 0)})", 'DEBUG')
                else:
                    # Error en RPC: capturar todos los detalles
                    error_msg = result.get('error_message', result.get('error', 'Unknown error'))
                    sqlstate = result.get('sqlstate', 'N/A')
                    error_detail = result.get('error_detail', '')
                    error_context = result.get('error_context', '')
                    error_full = f"Batch {batch_num}: RPC error (SQLSTATE {sqlstate}): {error_msg}"
                    if error_detail:
                        error_full += f" | Detail: {error_detail}"
                    if error_context:
                        error_full += f" | Context: {error_context[:100]}"
                    rpc_errors.append(error_full)
            else:
                rpc_errors.append(f"Batch {batch_num}: HTTP {response.status_code} - {response.text[:100]}")

        except Exception as e:
            rpc_errors.append(f"Batch {batch_num}: {str(e)}")

    stats.source_records_new += rpc_new
    stats.source_records_existing += rpc_existing
    stats.financial_movements_new += rpc_fm_new
    stats.ledger_entries_new += rpc_ledger_new

    if rpc_errors:
        stats.errors.extend(rpc_errors)
        return False  # Marcar como error si la RPC falló

    log(f"  [OK] {csv_path.name} importado exitosamente")
    return True

# ============================================================================
# PUNTO DE ENTRADA
# ============================================================================

def main():
    print("\n" + "="*80)
    print("  IMPORTADOR DE ACCOUNT MONEY REPORTS - MERCADO PAGO")
    print("="*80)

    stats = ImportStats()

    # Descobrir CSVs
    csv_files = discover_csv_files()
    stats.csv_files_found = len(csv_files)

    if not csv_files:
        print("\n No se encontraron archivos .csv en data/mercadopago/")
        print("  Crea o coloca tus Account Money Reports en ese directorio.\n")
        return

    log(f"Encontrados {len(csv_files)} archivos CSV")
    for csv_file in csv_files:
        print(f"   {csv_file.name}")

    # Procesar cada CSV
    print()
    for csv_file in csv_files:
        if import_csv_file(csv_file, stats):
            stats.csv_files_processed += 1

    # Resumen
    print("\n" + "="*80)
    print("  RESUMEN DE IMPORTACIN")
    print("="*80)

    print(f"\n[DIR] ARCHIVOS:")
    print(f"  Encontrados:  {stats.csv_files_found}")
    print(f"  Procesados:   {stats.csv_files_processed}")
    print(f"  Con error:    {len(stats.csv_files_error)}")

    if stats.csv_files_error:
        print("\n  Errores:")
        for filename, error in stats.csv_files_error:
            print(f"    [FAIL] {filename}: {error}")

    print(f"\n[DATA] DATOS:")
    print(f"  Filas ledas: {stats.rows_read}")

    if stats.rows_error:
        print(f"  Filas con error: {len(stats.rows_error)}")
        for filename, row_num, error in stats.rows_error[:5]:  # Mostrar primeras 5
            print(f"    [FAIL] {filename}:{row_num} - {error}")
        if len(stats.rows_error) > 5:
            print(f"    ... y {len(stats.rows_error)-5} ms")

    print(f"\n[RECORDS] SOURCE RECORDS:")
    print(f"  Nuevos:       {stats.source_records_new}")
    print(f"  Ya existan:  {stats.source_records_existing}")

    print(f"\n[MONEY] FINANCIAL MOVEMENTS:")
    print(f"  Nuevos:       {stats.financial_movements_new}")
    print(f"  Ya existan:  {stats.financial_movements_existing}")

    print(f"\n[LEDGER] LEDGER ENTRIES:")
    print(f"  Nuevos:       {stats.ledger_entries_new}")
    print(f"  Ya existan:  {stats.ledger_entries_existing}")

    print(f"\n[LINK] MOVEMENT LINKS:")
    print(f"  Nuevos:       {stats.movement_links_new}")

    if stats.needs_review:
        print(f"\n[WARN] CAMBIOS DETECTADOS (requieren revisin):")
        for item in stats.needs_review[:10]:
            print(f"   {item}")
        if len(stats.needs_review) > 10:
            print(f"  ... y {len(stats.needs_review)-10} ms")

    print(f"\n[TAG] CLASIFICACIN:")
    for movement_class in sorted(stats.movements_by_class.keys()):
        count = stats.movements_by_class[movement_class]
        print(f"  {movement_class:20} {count:6}")

    print(f"\n[FINANCE] TOTALES FINANCIEROS:")
    print(f"  Rendimientos:       ${stats.yields_total:,.2f}")
    print(f"  Impuestos:          ${stats.taxes_total:,.2f}")
    print(f"  Balance Impact:     ${stats.balance_impact_total:,.2f}")

    if stats.errors:
        print(f"\n ERRORES DE SINCRONIZACIN:")
        for error in stats.errors[:10]:
            print(f"   {error}")
        if len(stats.errors) > 10:
            print(f"  ... y {len(stats.errors)-10} ms")

    print("\n" + "="*80 + "\n")

    # Verificar si hubo errores
    has_errors = (stats.csv_files_processed < stats.csv_files_found or
                  len(stats.csv_files_error) > 0 or
                  len(stats.errors) > 0)

    if has_errors:
        print(" IMPORTACIN PARCIAL (algunos archivos tuvieron errores)\n")
    elif stats.csv_files_processed == stats.csv_files_found:
        print("[OK] IMPORTACIN COMPLETADA\n")
    else:
        print(" IMPORTACIN PARCIAL\n")

if __name__ == '__main__':
    main()

# ============================================================================
# INSTRUCCIONES DE SETUP
# ============================================================================
"""
INSTRUCCIONES DE CONFIGURACIN
==============================

1. CREAR .env.local
   ---
   En la raz del proyecto (al lado de package.json), crea un archivo:

   Nombre: .env.local

   Contenido:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ACCOUNT_ID=1054315166
   LOG_LEVEL=INFO
   ```

2. OBTENER SUPABASE_URL
   ---
    Ve a https://app.supabase.com/
    Selecciona tu proyecto
    Ve a "Settings"  "API"
    Busca "Project URL"
    Cpialo (ej: https://xxxxx.supabase.co)

3. OBTENER SUPABASE_SERVICE_ROLE_KEY
   ---
   ADVERTENCIA: Esta clave da acceso TOTAL a tu base de datos.
   NUNCA la compartas ni la commitees al repositorio.

    Ve a https://app.supabase.com/
    Selecciona tu proyecto
    Settings  API
    Busca "service_role"
    Haz clic en "Reveal"
    Cpialo
    Pgalo en .env.local (SOLO EN TU MQUINA LOCAL)

4. INSTALAR DEPENDENCIAS (si es necesario)
   ---
   python -m pip install supabase requests python-dotenv

5. USAR EL IMPORTADOR
   ---
   a) Coloca tus CSVs de Account Money Report en:
      data/mercadopago/

   b) Ejecuta:
      python scripts/import_mp_reports.py

   c) El script:
       Descubre automticamente todos los CSVs
       Valida estructura
       Inserta datos en Supabase
       Muestra resumen detallado

   d) Puedes ejecutarlo mltiples veces:
       Los registros duplicados se ignoran automticamente
       Es seguro si se interrumpe (simplemente vuelve a ejecutar)

6. TROUBLESHOOTING
   ---
    ".env.local not found"  Verifica que existe en la raz del proyecto
    "Credenciales incompletas"  Verifica SUPABASE_URL y SERVICE_ROLE_KEY
    "Estructura invlida"  El CSV no tiene las columnas esperadas
    "connection refused"  Verifica SUPABASE_URL sea correcta
"""
