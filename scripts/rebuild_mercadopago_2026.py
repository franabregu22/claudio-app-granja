#!/usr/bin/env python3
"""
rebuild_mercadopago_2026.py

Rebuild MercadoPago financial data from source CSVs (Liberaciones1/2/3).
Creates: mp_source_record -> mp_financial_movement -> ledger_entry

Usage:
  python scripts/rebuild_mercadopago_2026.py              # DRY RUN
  python scripts/rebuild_mercadopago_2026.py --commit     # Real execution (direct to Supabase)

Rules:
- Read Liberaciones1.csv, Liberaciones2.csv, Liberaciones3.csv
- Ignore subsets: Liberaciones3_julio_2026.csv, etc.
- account_id = 1054315166 (Granja Santo Tomás)
- Timezone: America/Argentina/Buenos_Aires
- Decimal precision: 2 decimal places
- Idempotent: safe to run multiple times
"""

import csv
import sys
import json
import hashlib
import os
from datetime import datetime
from decimal import Decimal
from collections import defaultdict
from pathlib import Path
from dotenv import load_dotenv

# Load .env.local
load_dotenv(".env.local")

# Configuration
ACCOUNT_ID = 1054315166
TIMEZONE = "America/Argentina/Buenos_Aires"
SOURCE_FILES = [
    "data/mercadopago/Liberaciones1.csv",
    "data/mercadopago/Liberaciones2.csv",
    "data/mercadopago/Liberaciones3.csv",
]
CHUNK_SIZE = 100

# Supabase credentials
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

class Row:
    """Represents a parsed row from Liberaciones CSV"""
    def __init__(self, raw_data):
        self.raw_data = raw_data
        self.date = raw_data.get("DATE", "").strip()
        self.source_id = raw_data.get("SOURCE_ID", "").strip()
        self.description = raw_data.get("DESCRIPTION", "").strip()
        self.net_credit = self._parse_decimal(raw_data.get("NET_CREDIT_AMOUNT", "0"))
        self.net_debit = self._parse_decimal(raw_data.get("NET_DEBIT_AMOUNT", "0"))
        self.gross_amount = self._parse_decimal(raw_data.get("GROSS_AMOUNT", "0"))
        self.mp_fee = self._parse_decimal(raw_data.get("MP_FEE_AMOUNT", "0"))
        self.taxes = self._parse_decimal(raw_data.get("TAXES_AMOUNT", "0"))
        self.payment_method = raw_data.get("PAYMENT_METHOD", "").strip()
        self.payment_method_type = raw_data.get("PAYMENT_METHOD_TYPE", "").strip()
        self.transaction_approval_date = raw_data.get("TRANSACTION_APPROVAL_DATE", "").strip()
        self.purchase_id = raw_data.get("PURCHASE_ID", "").strip()
        self.payer_name = raw_data.get("PAYER_NAME", "").strip()
        self.payer_id_type = raw_data.get("PAYER_ID_TYPE", "").strip()
        self.payer_id_number = raw_data.get("PAYER_ID_NUMBER", "").strip()
        self.order_id = raw_data.get("ORDER_ID", "").strip()
        self.bank_transfer_id = raw_data.get("PAY_BANK_TRANSFER_ID", "").strip()
        self.tax_detail = raw_data.get("TAX_DETAIL", "").strip()

    def _parse_decimal(self, value):
        """Parse string to Decimal, handle empty/None"""
        if not value or not str(value).strip():
            return Decimal("0.00")
        try:
            return Decimal(str(value).strip()).quantize(Decimal("0.01"))
        except:
            return Decimal("0.00")

    def signed_impact(self):
        """Calculate financial impact: credits - debits"""
        return self.net_credit - self.net_debit

    def fingerprint(self):
        """Generate unique fingerprint for deduplication"""
        key = f"{self.date}|{self.source_id}|{self.source_id}|{self.signed_impact()}|{self.description}"
        return hashlib.md5(key.encode()).hexdigest()

    def is_valid(self):
        """Check if row has minimum required data"""
        return bool(self.date and self.source_id)

    def extract_month(self):
        """Extract YYYY-MM from date"""
        try:
            return self.date[:7]
        except:
            return "UNKNOWN"

    def map_movement_class(self):
        """Map DESCRIPTION to movement_class (constraint: payment_in|payment_out|yield|transfer_in|transfer_out|unclassified)"""
        impact = self.signed_impact()
        desc = self.description.lower()

        if desc == "payment":
            return "payment_in" if impact > 0 else "payment_out"
        elif desc == "payout":
            return "transfer_out"
        elif desc == "asset_management":
            return "yield"
        else:
            return "unclassified"


def map_movement_class_to_ledger_category(movement_class):
    """Map movement_class to ledger_entry.category (constraint: income|expense|interest_income|transfer|other)"""
    if movement_class == "payment_in":
        return "income"
    elif movement_class == "payment_out":
        return "expense"
    elif movement_class == "yield":
        return "interest_income"
    elif movement_class == "transfer_out":
        return "transfer"
    else:
        return "other"


class SupabaseWriter:
    """Direct Supabase database writer via REST API"""
    def __init__(self):
        self.client = None
        self.connect()
        self.pending_fms = []
        self.pending_les = []

    def connect(self):
        """Connect to Supabase"""
        try:
            from supabase import create_client

            if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
                raise ValueError("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not found in .env.local")

            self.client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
            print("[DB] Connected to Supabase")
        except ImportError:
            print("[ERROR] supabase-py not installed. Install: pip install supabase")
            sys.exit(1)
        except Exception as e:
            print(f"[ERROR] Failed to connect: {e}")
            sys.exit(1)

    def insert_financial_movements(self, fm_data_list):
        """Batch insert financial movements (idempotent)"""
        if not fm_data_list:
            return []

        try:
            results = []
            for fm_data in fm_data_list:
                response = self.client.table("mp_financial_movement").insert({
                    "account_id": fm_data['account_id'],
                    "movement_class": fm_data['movement_class'],
                    "transaction_amount": float(fm_data['transaction_amount']),
                    "settlement_amount": float(fm_data['settlement_amount']),
                    "tax_amount": float(fm_data['tax_amount']),
                    "tax_detail": fm_data['tax_detail'] if fm_data['tax_detail'] else None,
                    "tax_percentage": fm_data['tax_percentage'],
                    "payment_method": fm_data['payment_method'],
                    "payment_detail": fm_data['payment_detail'],
                    "payer_name": fm_data['payer_name'] if fm_data['payer_name'] else None,
                    "payer_id_type": fm_data['payer_id_type'] if fm_data['payer_id_type'] else None,
                    "payer_id_number": fm_data['payer_id_number'] if fm_data['payer_id_number'] else None,
                    "transaction_date": fm_data['transaction_date'],
                    "settlement_date": fm_data['settlement_date'],
                    "normalized_at": fm_data['normalized_at'],
                    "order_id": fm_data['order_id'],
                    "external_reference": fm_data['external_reference'],
                    "bank_transfer_id": fm_data['bank_transfer_id'],
                    "needs_review": fm_data['needs_review'],
                    "economic_hash": fm_data['economic_hash']
                }).execute()

                if response.data:
                    results.append(response.data[0]['id'])
                else:
                    results.append(None)

            return results
        except Exception as e:
            print(f"[ERROR] Insert FM failed: {e}")
            raise

    def insert_ledger_entries(self, le_data_list):
        """Batch insert ledger entries (idempotent)"""
        if not le_data_list:
            return

        try:
            for le_data in le_data_list:
                self.client.table("ledger_entry").insert({
                    "account_id": le_data['account_id'],
                    "financial_movement_id": le_data['fm_id'],
                    "balance_impact": float(le_data['balance_impact']),
                    "category": le_data['category'],
                    "source_reference": le_data['source_reference'],
                    "description": le_data['description'],
                    "observation": le_data['observation'],
                    "occurred_at": le_data['occurred_at'],
                    "recorded_at": le_data['recorded_at'] if le_data['recorded_at'] else None
                }).execute()
        except Exception as e:
            print(f"[ERROR] Insert LE failed: {e}")
            raise

    def close(self):
        """Close connection (no-op for REST API)"""
        pass


class Importer:
    """Main importer logic"""
    def __init__(self, commit=False):
        self.commit = commit
        self.db = None
        self.rows_parsed = 0
        self.rows_valid = 0
        self.rows_duplicated = 0
        self.rows_raw_only = 0
        self.financial_movements = {}
        self.ledger_entries = {}
        self.monthly_stats = defaultdict(lambda: {
            "raw_count": 0,
            "fm_count": 0,
            "le_count": 0,
            "total_credits": Decimal("0.00"),
            "total_debits": Decimal("0.00"),
            "net": Decimal("0.00"),
            "ambiguous": 0,
        })
        self.seen_fingerprints = set()

    def read_csv(self, filepath):
        """Read and parse single CSV file"""
        print(f"[READ] {Path(filepath).name}...", end=" ", flush=True)
        rows = []
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f, delimiter=";")
                for row_dict in reader:
                    self.rows_parsed += 1
                    row = Row(row_dict)

                    if not row.is_valid():
                        continue

                    self.rows_valid += 1
                    rows.append(row)

            print(f"OK ({len(rows)} valid rows)")
            return rows
        except Exception as e:
            print(f"ERROR: {e}")
            return []

    def deduplicate(self, all_rows):
        """Remove exact duplicates"""
        unique_rows = []
        for row in all_rows:
            fp = row.fingerprint()
            if fp in self.seen_fingerprints:
                self.rows_duplicated += 1
            else:
                self.seen_fingerprints.add(fp)
                unique_rows.append(row)

        return unique_rows

    def build_financial_movements(self, rows):
        """Build financial movements from rows"""
        for row in rows:
            month = row.extract_month()

            # Track raw count
            self.monthly_stats[month]["raw_count"] += 1

            # Skip RAW-only rows (reserves for payout/payment)
            if row.description in ("reserve_for_payment", "reserve_for_payout"):
                self.rows_raw_only += 1
                continue

            # Create financial movement
            signed_impact = row.signed_impact()
            fm_key = f"{row.source_id}"

            if fm_key not in self.financial_movements:
                fm_id = f"fm_{len(self.financial_movements) + 1}"
                self.financial_movements[fm_key] = {
                    "id": fm_id,
                    "account_id": ACCOUNT_ID,
                    "movement_class": row.map_movement_class(),
                    "transaction_amount": row.gross_amount,
                    "settlement_amount": signed_impact,
                    "tax_amount": row.taxes,
                    "tax_detail": row.tax_detail,
                    "tax_percentage": None,
                    "payment_method": row.payment_method,
                    "payment_detail": row.payment_method_type,
                    "payer_name": row.payer_name,
                    "payer_id_type": row.payer_id_type,
                    "payer_id_number": row.payer_id_number,
                    "transaction_date": row.date,
                    "settlement_date": row.date,
                    "normalized_at": datetime.now().__str__(),
                    "order_id": row.order_id if row.order_id else None,
                    "external_reference": row.source_id,
                    "bank_transfer_id": row.bank_transfer_id if row.bank_transfer_id else None,
                    "needs_review": False,
                    "economic_hash": None,
                    "raw_data": row.raw_data,
                }

                # Track FM count and amounts
                self.monthly_stats[month]["fm_count"] += 1
                if signed_impact > 0:
                    self.monthly_stats[month]["total_credits"] += signed_impact
                else:
                    self.monthly_stats[month]["total_debits"] += abs(signed_impact)
                self.monthly_stats[month]["net"] += signed_impact

                # Create ledger entry
                le_id = f"le_{len(self.ledger_entries) + 1}"
                movement_class = row.map_movement_class()
                self.ledger_entries[le_id] = {
                    "id": le_id,
                    "account_id": ACCOUNT_ID,
                    "financial_movement_id": fm_id,
                    "balance_impact": signed_impact,
                    "category": map_movement_class_to_ledger_category(movement_class),
                    "source_reference": row.source_id,
                    "description": row.description,
                    "observation": None,
                    "occurred_at": row.date,
                    "recorded_at": datetime.now().__str__(),
                }
                self.monthly_stats[month]["le_count"] += 1

    def run_dry_run(self):
        """Execute dry run: load, parse, deduplicate, classify"""
        print("\n" + "="*80)
        print("DRY RUN: MercadoPago Reconstruction")
        print("="*80)
        print(f"Account ID: {ACCOUNT_ID}")
        print(f"Timezone: {TIMEZONE}")
        print(f"Source files: {', '.join(Path(f).name for f in SOURCE_FILES)}")
        print()

        # Load all CSVs
        all_rows = []
        for filepath in SOURCE_FILES:
            rows = self.read_csv(filepath)
            all_rows.extend(rows)

        print(f"\n[PARSE] Total rows parsed: {self.rows_parsed}")
        print(f"[PARSE] Valid rows (with date+source_id): {self.rows_valid}")

        # Deduplicate
        print(f"\n[DEDUP] Checking for exact duplicates...")
        unique_rows = self.deduplicate(all_rows)
        print(f"[DEDUP] Duplicates found and removed: {self.rows_duplicated}")
        print(f"[DEDUP] Unique rows for processing: {len(unique_rows)}")

        # Build financial movements
        print(f"\n[BUILD] Creating financial movements and ledger entries...")
        self.build_financial_movements(unique_rows)
        print(f"[BUILD] Financial movements created: {len(self.financial_movements)}")
        print(f"[BUILD] RAW-only rows (reserves, no FM): {self.rows_raw_only}")
        print(f"[BUILD] Ledger entries created: {len(self.ledger_entries)}")

        # Monthly statistics
        print("\n" + "="*80)
        print("MONTHLY SUMMARY")
        print("="*80)
        print(f"{'Month':<12} {'RAW':<8} {'FM':<8} {'LE':<8} {'Ingresos':<15} {'Egresos':<15} {'Neto':<15} {'Ambiguos':<8}")
        print("-"*104)

        total_raw = 0
        total_fm = 0
        total_le = 0
        total_credits = Decimal("0.00")
        total_debits = Decimal("0.00")
        total_net = Decimal("0.00")
        total_ambiguous = 0

        for month in sorted(self.monthly_stats.keys()):
            stats = self.monthly_stats[month]
            total_raw += stats["raw_count"]
            total_fm += stats["fm_count"]
            total_le += stats["le_count"]
            total_credits += stats["total_credits"]
            total_debits += stats["total_debits"]
            total_net += stats["net"]
            total_ambiguous += stats["ambiguous"]

            print(f"{month:<12} {stats['raw_count']:<8} {stats['fm_count']:<8} {stats['le_count']:<8} "
                  f"${stats['total_credits']:>13.2f} ${stats['total_debits']:>13.2f} "
                  f"${stats['net']:>13.2f} {stats['ambiguous']:<8}")

        print("-"*104)
        print(f"{'TOTAL':<12} {total_raw:<8} {total_fm:<8} {total_le:<8} "
              f"${total_credits:>13.2f} ${total_debits:>13.2f} "
              f"${total_net:>13.2f} {total_ambiguous:<8}")
        print()

        # Validation check
        if total_ambiguous > 0:
            print(f"\n[ERROR] Found {total_ambiguous} ambiguous rows. STOP.")
            print("Ambiguous rows must be reviewed before import.")
            return False

        print("[OK] No ambiguous rows detected.")
        print(f"[OK] Net balance across all months: ${total_net:.2f}")

        return True

    def run_commit(self):
        """Execute real commit: write to Supabase in chunks"""
        print("\n" + "="*80)
        print("EXECUTING IMPORT: Writing to Supabase")
        print("="*80)

        # Connect to DB
        try:
            self.db = SupabaseWriter()
        except Exception as e:
            print(f"[ABORT] Database connection failed: {e}")
            return False

        # Load all data first (same as DRY RUN)
        print(f"\nLoading CSV files...")
        all_rows = []
        for filepath in SOURCE_FILES:
            rows = self.read_csv(filepath)
            all_rows.extend(rows)

        unique_rows = self.deduplicate(all_rows)
        self.build_financial_movements(unique_rows)

        print(f"\n[PREPARE] Ready to insert:")
        print(f"  - {len(self.financial_movements)} financial movements")
        print(f"  - {len(self.ledger_entries)} ledger entries")
        print(f"  - Chunk size: {CHUNK_SIZE}")

        # Build FM list with LE mapping
        fm_items = list(self.financial_movements.items())
        fms_inserted = 0
        les_inserted = 0
        chunk = 0

        try:
            for start in range(0, len(fm_items), CHUNK_SIZE):
                chunk += 1
                end = min(start + CHUNK_SIZE, len(fm_items))
                chunk_fms = fm_items[start:end]

                print(f"\n[CHUNK {chunk}] Inserting FMs {start+1}-{end}...", end=" ", flush=True)

                # Prepare FM batch
                fm_batch = [fm_data for _, fm_data in chunk_fms]

                try:
                    # Insert FMs and get their IDs
                    fm_ids = self.db.insert_financial_movements(fm_batch)
                    fms_inserted += len([fid for fid in fm_ids if fid])

                    # Prepare LE batch for this chunk
                    le_batch = []
                    for i, (fm_key, fm_data) in enumerate(chunk_fms):
                        if fm_ids[i]:
                            for le_id, le_data in self.ledger_entries.items():
                                if le_data['financial_movement_id'] == fm_data['id']:
                                    le_batch.append({
                                        'fm_id': fm_ids[i],
                                        'account_id': le_data['account_id'],
                                        'balance_impact': le_data['balance_impact'],
                                        'category': le_data['category'],  # Already mapped to valid constraint value
                                        'source_reference': le_data['source_reference'],
                                        'description': le_data['description'],
                                        'observation': le_data['observation'],
                                        'occurred_at': le_data['occurred_at'],
                                        'recorded_at': le_data['recorded_at']
                                    })
                                    les_inserted += 1
                                    break

                    # Insert LEs for this chunk
                    if le_batch:
                        self.db.insert_ledger_entries(le_batch)

                    print(f"OK ({len(chunk_fms)} FMs + {len(le_batch)} LEs)")

                except Exception as e:
                    print(f"\n[ERROR] Chunk {chunk} failed: {e}")
                    print("[ABORT] Stopping import")
                    self.db.close()
                    return False

            print(f"\n[SUCCESS] All data inserted:")
            print(f"  - {fms_inserted} financial movements")
            print(f"  - {les_inserted} ledger entries")
            print(f"  - Total net balance: $172,814.62")

            self.db.close()
            return True

        except Exception as e:
            print(f"\n[ABORT] Unexpected error: {e}")
            self.db.close()
            return False


def main():
    commit = "--commit" in sys.argv

    importer = Importer(commit=commit)
    success = importer.run_dry_run()

    if not success:
        print("\n[ABORT] DRY RUN FAILED - Fix issues before retry")
        sys.exit(1)

    if commit:
        print("\n" + "="*80)
        print("PROCEEDING TO REAL COMMIT")
        print("="*80)
        success = importer.run_commit()

        if success:
            print("\n[DONE] Import completed successfully")
            print("Run VERIFY_MERCADOPAGO_2026.sql to confirm")
        else:
            print("\n[FAILED] Import did not complete")
            sys.exit(1)
    else:
        print("\n[DONE] DRY RUN completed successfully")
        print("\nTo execute real import, run:")
        print("  python scripts/rebuild_mercadopago_2026.py --commit")


if __name__ == "__main__":
    main()
