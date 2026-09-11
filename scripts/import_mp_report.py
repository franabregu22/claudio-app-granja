#!/usr/bin/env python3
"""
Importador de Account Money Report de Mercado Pago (CSV).

Lee el CSV, genera source records versionados, normaliza y crea ledger entries.
"""

import csv
import json
import hashlib
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple
import sys

# ============================================================================
# CONFIGURACIÓN
# ============================================================================

ACCOUNT_ID = 1054315166  # Granja Santo Tomás

MOVEMENT_CLASS_RULES = [
    # Regla 1: Rendimiento (sin método de pago + sin impuestos)
    ('yield', lambda row: (
        not row.get('PAYMENT_METHOD_TYPE', '').strip()
        and not row.get('PAYER_NAME', '').strip()
        and not row.get('PAYER_ID_NUMBER', '').strip()
        and Decimal(row.get('TAXES_AMOUNT', '0') or '0') == 0
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') > 0
    )),

    # Regla 2: Transferencia OUT (Granja envía dinero)
    ('transfer_out', lambda row: (
        Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') < 0
        and row.get('PAYER_NAME', '').strip() == 'GRANJA SANTO TOMAS S.A.S.'
    )),

    # Regla 3: Transferencia IN (banco transfer positivo)
    ('transfer_in', lambda row: (
        row.get('PAYMENT_METHOD_TYPE', '').strip() == 'bank_transfer'
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') > 0
    )),

    # Regla 4: Pago entrante (available_money positivo = cobro)
    ('payment_in', lambda row: (
        row.get('PAYMENT_METHOD_TYPE', '').strip() == 'available_money'
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') > 0
    )),

    # Regla 5: Pago saliente (available_money negativo)
    ('payment_out', lambda row: (
        row.get('PAYMENT_METHOD_TYPE', '').strip() == 'available_money'
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') < 0
    )),

    # Regla 6: Digital currency (consumer credits) — cobro entrante
    ('digital_currency_payment_in', lambda row: (
        row.get('PAYMENT_METHOD_TYPE', '').strip() == 'digital_currency'
        and row.get('PAYMENT_METHOD', '').strip() == 'consumer_credits'
        and Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') > 0
    )),

    # Regla 7: Tarjeta de crédito positiva
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

# ============================================================================
# FUNCIONES DE UTILIDAD
# ============================================================================

def calculate_payload_hash(data: Dict[str, Any]) -> str:
    """Calcula SHA256 del payload JSON."""
    json_str = json.dumps(data, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(json_str.encode()).hexdigest()


def parse_iso_datetime(dt_str: str) -> Optional[str]:
    """Parsea datetime ISO y retorna en formato Postgres."""
    if not dt_str or not dt_str.strip():
        return None
    try:
        # Format: 2026-08-31T19:23:44.000-03:00
        dt = datetime.fromisoformat(dt_str.replace('Z', '+00:00'))
        return dt.isoformat()
    except:
        return None


def classify_movement(row: Dict[str, str]) -> str:
    """Clasifica movimiento según reglas."""
    for class_name, rule_func in MOVEMENT_CLASS_RULES:
        try:
            if rule_func(row):
                # Mapear variantes de payment_in a categoría estándar
                if class_name in ('credit_card_payment_in', 'digital_currency_payment_in'):
                    return 'payment_in'
                return class_name
        except:
            pass
    return 'unclassified'


def extract_tax_detail(tax_detail_str: str) -> Optional[Dict]:
    """Parsea TAX_DETAIL JSON."""
    if not tax_detail_str or tax_detail_str.strip() in ('', '[]'):
        return None
    try:
        data = json.loads(tax_detail_str)
        if isinstance(data, list) and len(data) > 0:
            return data[0]
        return data if isinstance(data, dict) else None
    except:
        return None


def calculate_tax_percentage(tax_amount: Decimal, transaction_amount: Decimal) -> Optional[Decimal]:
    """Calcula porcentaje de impuesto."""
    if transaction_amount == 0 or tax_amount is None:
        return None
    try:
        return (abs(tax_amount) / abs(transaction_amount) * 100).quantize(Decimal('0.0001'))
    except:
        return None


# ============================================================================
# PARSEO DEL CSV
# ============================================================================

def read_csv_report(csv_path: str) -> List[Dict[str, str]]:
    """Lee CSV de Account Money Report."""
    rows = []
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f, delimiter=';')
        for row in reader:
            rows.append(row)
    return rows


# ============================================================================
# GENERACIÓN DE SQL
# ============================================================================

class SQLGenerator:
    """Genera SQL INSERT statements para las tablas nuevas."""

    def __init__(self):
        self.source_records_sql: List[str] = []
        self.financial_movements_sql: List[str] = []
        self.movement_links_sql: List[str] = []
        self.ledger_entries_sql: List[str] = []

        self.source_record_map: Dict[str, int] = {}  # source_external_id → id
        self.financial_movement_id_counter = 1
        self.source_record_id_counter = 1
        self.movement_link_id_counter = 1
        self.ledger_entry_id_counter = 1

    def add_source_record(self, row: Dict[str, str]) -> Tuple[int, str]:
        """
        Agrega source record y retorna (id, source_external_id).
        Si ya existe con mismo hash, retorna el existente.
        """
        source_external_id = row.get('SOURCE_ID', '')
        raw_data = dict(row)

        payload_hash = calculate_payload_hash(raw_data)
        observed_at = parse_iso_datetime(row.get('TRANSACTION_DATE', ''))

        # Clave para deduplicación
        dedup_key = f"{source_external_id}:{payload_hash}"

        if dedup_key in self.source_record_map:
            return self.source_record_map[dedup_key], source_external_id

        # Nueva observación
        record_id = self.source_record_id_counter
        self.source_record_id_counter += 1

        # Escape JSON
        raw_data_json = json.dumps(raw_data).replace("'", "''")

        sql = f"""
INSERT INTO mp_source_record (
  id, source_type, source_external_id, payload_hash,
  raw_data, observed_at, received_at, processing_status
) VALUES (
  {record_id}, 'report', '{source_external_id}', '{payload_hash}',
  '{raw_data_json}'::jsonb, '{observed_at}'::timestamp with time zone,
  NOW(), 'processed'
);
""".strip()
        self.source_records_sql.append(sql)
        self.source_record_map[dedup_key] = record_id

        return record_id, source_external_id

    def add_financial_movement(
        self,
        source_external_id: str,
        row: Dict[str, str],
        movement_class: str
    ) -> int:
        """Agrega financial movement y retorna su id."""
        movement_id = self.financial_movement_id_counter
        self.financial_movement_id_counter += 1

        # Parsear importes
        try:
            transaction_amount = Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0')
            settlement_amount = Decimal(row.get('SETTLEMENT_NET_AMOUNT', '0') or '0')
            tax_amount = Decimal(row.get('TAXES_AMOUNT', '0') or '0')
        except:
            transaction_amount = settlement_amount = tax_amount = Decimal('0')

        tax_percentage = calculate_tax_percentage(tax_amount, transaction_amount)
        tax_detail = extract_tax_detail(row.get('TAX_DETAIL', ''))
        tax_detail_json = f"'{json.dumps(tax_detail).replace(chr(39), chr(39)+chr(39))}'::jsonb" \
            if tax_detail else "NULL"

        # Parsear fechas
        transaction_date = parse_iso_datetime(row.get('TRANSACTION_DATE', ''))
        settlement_date = parse_iso_datetime(row.get('SETTLEMENT_DATE', ''))

        # Escapar strings
        payer_name = row.get('PAYER_NAME', '').replace("'", "''")
        payer_id_type = row.get('PAYER_ID_TYPE', '').replace("'", "''")
        payer_id_number = row.get('PAYER_ID_NUMBER', '').replace("'", "''")
        payment_method = row.get('PAYMENT_METHOD_TYPE', '').replace("'", "''")
        payment_detail = row.get('PAYMENT_METHOD', '').replace("'", "''")
        order_id = row.get('ORDER_ID', '').replace("'", "''")
        external_ref = row.get('EXTERNAL_REFERENCE', '').replace("'", "''")
        bank_transfer_id = row.get('PAY_BANK_TRANSFER_ID', '').replace("'", "''")

        sql = f"""
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  {movement_id}, {ACCOUNT_ID}, '{movement_class}',
  {transaction_amount}, {settlement_amount}, {tax_amount},
  {tax_detail_json}, {tax_percentage if tax_percentage else 'NULL'},
  {'NULL' if not payment_method else f"'{payment_method}'"},
  {'NULL' if not payment_detail else f"'{payment_detail}'"},
  {'NULL' if not payer_name else f"'{payer_name}'"},
  {'NULL' if not payer_id_type else f"'{payer_id_type}'"},
  {'NULL' if not payer_id_number else f"'{payer_id_number}'"},
  '{transaction_date}'::timestamp with time zone,
  {'NULL' if not settlement_date else f"'{settlement_date}'::timestamp with time zone"},
  {'NULL' if not order_id else f"'{order_id}'"},
  {'NULL' if not external_ref else f"'{external_ref}'"},
  {'NULL' if not bank_transfer_id else f"'{bank_transfer_id}'"}
);
""".strip()
        self.financial_movements_sql.append(sql)

        return movement_id

    def add_movement_link(self, financial_movement_id: int, source_record_id: int, is_primary: bool = True):
        """Agrega relación entre movement y source record."""
        link_id = self.movement_link_id_counter
        self.movement_link_id_counter += 1

        sql = f"""
INSERT INTO mp_movement_source_link (
  id, financial_movement_id, source_record_id, is_primary
) VALUES (
  {link_id}, {financial_movement_id}, {source_record_id}, {str(is_primary).lower()}
);
""".strip()
        self.movement_links_sql.append(sql)

    def add_ledger_entry(self, financial_movement_id: int, movement_class: str, row: Dict[str, str]) -> int:
        """Agrega ledger entry y retorna su id."""
        ledger_id = self.ledger_entry_id_counter
        self.ledger_entry_id_counter += 1

        # balance_impact = settlement_amount
        settlement_amount = Decimal(row.get('SETTLEMENT_NET_AMOUNT', '0') or '0')
        category = LEDGER_CATEGORY_MAP.get(movement_class, 'other')

        # Trazabilidad
        source_external_id = row.get('SOURCE_ID', '')
        description = row.get('PAYER_NAME', 'Movimiento MP')
        observation = f"movement_class={movement_class}"

        sql = f"""
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  {ledger_id}, {ACCOUNT_ID}, {financial_movement_id},
  {settlement_amount}, '{category}',
  'SOURCE_ID={source_external_id}', '{description.replace(chr(39), chr(39)+chr(39))}',
  '{observation}',
  '{parse_iso_datetime(row.get('TRANSACTION_DATE', ''))}'::timestamp with time zone
);
""".strip()
        self.ledger_entries_sql.append(sql)

        return ledger_id

    def generate_sql_file(self, output_path: str):
        """Genera archivo SQL con todos los INSERTs."""
        sql_content = f"""-- ============================================================================
-- IMPORTACIÓN: Account Money Report CSV
-- Generado: {datetime.now().isoformat()}
-- ============================================================================

-- Desactivar restricciones de FK temporalmente
SET CONSTRAINTS ALL DEFERRED;

-- SOURCE RECORDS
{chr(10).join(self.source_records_sql)}

-- FINANCIAL MOVEMENTS
{chr(10).join(self.financial_movements_sql)}

-- MOVEMENT LINKS
{chr(10).join(self.movement_links_sql)}

-- LEDGER ENTRIES
{chr(10).join(self.ledger_entries_sql)}

-- Reactivar restricciones
SET CONSTRAINTS ALL IMMEDIATE;

-- ============================================================================
-- ESTADÍSTICAS
-- ============================================================================

SELECT
  (SELECT COUNT(*) FROM mp_source_record) as source_records,
  (SELECT COUNT(*) FROM mp_financial_movement) as financial_movements,
  (SELECT COUNT(*) FROM mp_movement_source_link) as movement_links,
  (SELECT COUNT(*) FROM ledger_entry) as ledger_entries,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class = 'yield') as yields,
  (SELECT SUM(tax_amount) FROM mp_financial_movement) as total_taxes,
  (SELECT SUM(transaction_amount) FROM mp_financial_movement) as total_transaction_amount,
  (SELECT SUM(settlement_amount) FROM mp_financial_movement) as total_settlement_amount,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class = 'unclassified') as unclassified;

"""
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(sql_content)


# ============================================================================
# MAIN
# ============================================================================

def main():
    csv_path = "data/mercadopago/Reporte_movimientos_mercadopago-manual-2026-09-04-124221.csv"

    if not Path(csv_path).exists():
        print(f"ERROR: CSV no encontrado en {csv_path}")
        sys.exit(1)

    print(f"Leyendo CSV: {csv_path}")
    rows = read_csv_report(csv_path)
    print(f"Total de filas: {len(rows)}\n")

    # Procesar cada fila
    generator = SQLGenerator()
    processed = 0
    errors = []

    print("Procesando filas...")
    for idx, row in enumerate(rows, 1):
        try:
            # 1. Agregar source record
            source_record_id, source_external_id = generator.add_source_record(row)

            # 2. Clasificar movimiento
            movement_class = classify_movement(row)

            # 3. Agregar financial movement
            financial_movement_id = generator.add_financial_movement(
                source_external_id, row, movement_class
            )

            # 4. Crear relación
            generator.add_movement_link(financial_movement_id, source_record_id, is_primary=True)

            # 5. Agregar ledger entry
            generator.add_ledger_entry(financial_movement_id, movement_class, row)

            processed += 1

            if idx % 100 == 0:
                print(f"  {idx}/{len(rows)} procesadas...")

        except Exception as e:
            errors.append((idx, str(e)))
            print(f"  ERROR en fila {idx}: {e}")

    print(f"\nTotal procesadas: {processed}")
    print(f"Total errores: {len(errors)}\n")

    # Generar SQL
    output_sql = "scripts/import_mp_report.sql"
    generator.generate_sql_file(output_sql)
    print(f"SQL generado en: {output_sql}\n")

    # Estadísticas
    print("=" * 80)
    print("ESTADÍSTICAS DE GENERACIÓN")
    print("=" * 80)
    print(f"Source records: {len(generator.source_records_sql)}")
    print(f"Financial movements: {len(generator.financial_movements_sql)}")
    print(f"Movement links: {len(generator.movement_links_sql)}")
    print(f"Ledger entries: {len(generator.ledger_entries_sql)}")
    print()

    # Contar por tipo de movement
    movement_classes = {}
    for row in rows:
        cls = classify_movement(row)
        movement_classes[cls] = movement_classes.get(cls, 0) + 1

    print("Distribuición por tipo de movimiento:")
    for cls, count in sorted(movement_classes.items(), key=lambda x: -x[1]):
        print(f"  {cls}: {count}")
    print()

    # Totales de importes
    total_tx = sum(Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0') for row in rows)
    total_settlement = sum(Decimal(row.get('SETTLEMENT_NET_AMOUNT', '0') or '0') for row in rows)
    total_taxes = sum(Decimal(row.get('TAXES_AMOUNT', '0') or '0') for row in rows)
    total_yields = sum(
        Decimal(row.get('TRANSACTION_AMOUNT', '0') or '0')
        for row in rows
        if classify_movement(row) == 'yield'
    )

    print("Totales de importes:")
    print(f"  TRANSACTION_AMOUNT: ${total_tx:,.2f}")
    print(f"  SETTLEMENT_NET_AMOUNT: ${total_settlement:,.2f}")
    print(f"  TAXES_AMOUNT: ${total_taxes:,.2f}")
    print(f"  Rendimientos total: ${total_yields:,.2f}")
    print()

    if errors:
        print(f"Errores encontrados ({len(errors)}):")
        for row_idx, err_msg in errors[:10]:
            print(f"  Fila {row_idx}: {err_msg}")
        if len(errors) > 10:
            print(f"  ... y {len(errors) - 10} más")

    print("\n✅ Importación completada.")
    print(f"Ejecutá el SQL con:\n  psql -d tu_db -f {output_sql}")


if __name__ == '__main__':
    main()
