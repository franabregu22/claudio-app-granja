#!/usr/bin/env python3
"""
June 2026 Import Script - Chunked RPC Import via Supabase
Imports report and liberaciones data using import_financial_movements_reconciliation_v2 RPC.
"""

import json
import os
import sys
from decimal import Decimal
from datetime import datetime
from typing import List, Dict, Any, Optional
from pathlib import Path

try:
    from supabase import create_client, Client
except ImportError:
    print("[ERROR] supabase-py library required. Install: pip install supabase")
    sys.exit(1)


class JuneImporter:
    """Imports June 2026 report and liberaciones data via Supabase RPC in chunks."""

    CHUNK_SIZE = 50
    ACCOUNT_ID = 1054315166
    MONTH_START = "2026-06-01"
    MONTH_END = "2026-06-30"
    EXPECTED_REPORT_ROWS = 682
    EXPECTED_LIBERACIONES_ROWS = 744

    def __init__(self):
        # Load from environment or .env.local
        self.supabase_url = os.environ.get('SUPABASE_URL')
        self.supabase_key = os.environ.get('SUPABASE_KEY')

        # Fallback: read from .env.local in multiple possible locations
        if not self.supabase_url or not self.supabase_key:
            possible_paths = [
                Path(__file__).parent.parent / '.env.local',
                Path.cwd() / '.env.local',
                Path.home() / '.env.local',
            ]

            for env_path in possible_paths:
                if env_path.exists():
                    try:
                        with open(env_path, 'r') as f:
                            for line in f:
                                line = line.strip()
                                if line.startswith('SUPABASE_URL='):
                                    self.supabase_url = line.split('=', 1)[1]
                                elif line.startswith('SUPABASE_KEY='):
                                    self.supabase_key = line.split('=', 1)[1]
                        if self.supabase_url and self.supabase_key:
                            break
                    except Exception as e:
                        print(f"[WARN] Could not read {env_path}: {e}")

        if not self.supabase_url or not self.supabase_key:
            print("[ERROR] SUPABASE_URL and SUPABASE_KEY not found in env or .env.local")
            print(f"[DEBUG] Checked locations:")
            for p in possible_paths:
                print(f"  - {p}")
            sys.exit(1)

        self.supabase: Client = create_client(self.supabase_url, self.supabase_key)

        # Accumulators for summary
        self.report_summary = {
            'chunks_processed': 0,
            'total_input_rows': 0,
            'total_existing_raw': 0,
            'total_new_source_records': 0,
            'total_new_financial_movements': 0,
            'total_new_ledger_entries': 0,
            'total_reused': 0,
            'total_ambiguous': 0,
            'total_delta': Decimal('0')
        }

        self.liberaciones_summary = {
            'chunks_processed': 0,
            'total_input_rows': 0,
            'total_existing_raw': 0,
            'total_new_source_records': 0,
            'total_new_financial_movements': 0,
            'total_new_ledger_entries': 0,
            'total_reused': 0,
            'total_ambiguous': 0,
            'total_delta': Decimal('0')
        }

    def load_preview_json(self, filepath: str) -> Dict[str, Any]:
        """Load _preview_batches.json"""
        try:
            with open(filepath, 'r') as f:
                data = json.load(f)
            return data
        except FileNotFoundError:
            print(f"[ERROR] File not found: {filepath}")
            sys.exit(1)
        except json.JSONDecodeError as e:
            print(f"[ERROR] Invalid JSON: {e}")
            sys.exit(1)

    def validate_batch_sizes(self, data: Dict[str, Any]) -> bool:
        """Validate that report has exactly 682 rows and liberaciones has exactly 744 rows."""
        report_count = len(data.get('report', []))
        liberaciones_count = len(data.get('liberaciones', []))

        print(f"[INFO] Validating batch sizes...")
        print(f"       Report rows: {report_count} (expected {self.EXPECTED_REPORT_ROWS})")
        print(f"       Liberaciones rows: {liberaciones_count} (expected {self.EXPECTED_LIBERACIONES_ROWS})")

        if report_count != self.EXPECTED_REPORT_ROWS:
            print(f"[ERROR] Report row count mismatch: {report_count} != {self.EXPECTED_REPORT_ROWS}")
            return False

        if liberaciones_count != self.EXPECTED_LIBERACIONES_ROWS:
            print(f"[ERROR] Liberaciones row count mismatch: {liberaciones_count} != {self.EXPECTED_LIBERACIONES_ROWS}")
            return False

        print(f"[OK] Batch sizes validated")
        return True

    def prepare_rows_for_rpc(self, rows: List[Dict[str, Any]], source_type: str) -> List[Dict[str, Any]]:
        """
        Prepare rows for RPC import.
        Ensures each row has necessary DATE field.
        """
        prepared = []

        for row in rows:
            # Create a copy to avoid modifying original
            row_copy = dict(row)

            # Ensure DATE field exists for RPC
            if source_type == 'report' and 'DATE' not in row_copy:
                # Use TRANSACTION_DATE as DATE
                if 'TRANSACTION_DATE' in row_copy:
                    row_copy['DATE'] = row_copy['TRANSACTION_DATE']
                else:
                    print(f"[WARN] Report row missing DATE/TRANSACTION_DATE, using SETTLEMENT_DATE")
                    row_copy['DATE'] = row_copy.get('SETTLEMENT_DATE', '')

            # For liberaciones, DATE should already exist
            if source_type == 'liberaciones' and 'DATE' not in row_copy:
                print(f"[WARN] Liberaciones row missing DATE field")

            prepared.append(row_copy)

        return prepared

    def call_import_rpc(self, chunk: List[Dict[str, Any]], source_type: str, chunk_num: int) -> Optional[Dict[str, Any]]:
        """
        Call import_financial_movements_reconciliation_v2 RPC with chunk of rows.
        Returns result or None if error.
        """
        try:
            # Debug: print first row if first chunk
            if chunk_num == 1:
                print(f"[DEBUG] First row keys for {source_type}: {list(chunk[0].keys())}")
                print(f"[DEBUG] SOURCE_ID value: {chunk[0].get('SOURCE_ID')}")
                print(f"[DEBUG] DATE value: {chunk[0].get('DATE')}")

            result = self.supabase.rpc(
                'import_financial_movements_reconciliation_v2',
                {
                    'p_account_id': self.ACCOUNT_ID,
                    'p_input_rows': chunk,
                    'p_source_type': source_type,
                    'p_month_start': self.MONTH_START,
                    'p_month_end': self.MONTH_END
                }
            ).execute()

            # Supabase client returns data attribute
            if hasattr(result, 'data') and result.data:
                return result.data
            elif isinstance(result, dict):
                return result
            else:
                print(f"[ERROR] Unexpected RPC response type: {type(result)}")
                return None

        except Exception as e:
            print(f"[ERROR] RPC call failed for chunk {chunk_num}: {e}")
            return None

    def process_chunk_result(self, result: Dict[str, Any], source_type: str, chunk_num: int, chunk_size: int) -> bool:
        """
        Process and display chunk result.
        Returns True if successful and should continue, False if should stop.
        """
        if not result:
            print(f"[ERROR] {source_type} chunk {chunk_num}: No result from RPC")
            return False

        # Check for errors in result
        if result.get('errors'):
            print(f"[ERROR] {source_type} chunk {chunk_num}: {result['errors']}")
            return False

        summary = result.get('summary', {})
        impact = result.get('financial_impact', {})

        # Extract metrics - handle both naming conventions
        total_input = summary.get('total_input_rows', 0)
        existing_raw = summary.get('existing_raw_exact_match', summary.get('reused_existing_fm', 0))
        new_sr = summary.get('new_source_records', summary.get('created_source_records', 0))
        new_fm = summary.get('new_financial_movements', summary.get('created_financial_movements', 0))
        new_le = summary.get('new_ledger_entries', summary.get('created_ledger_entries', 0))
        reused = existing_raw
        ambiguous = summary.get('ambiguous_rows', 0)
        delta = Decimal(str(impact.get('expected_delta', 0)))

        # Display chunk result
        print(f"[CHUNK] {source_type:12} / {chunk_num:3d} / rows:{total_input:3d} / "
              f"created_sr:{new_sr:3d} / created_fm:{new_fm:3d} / created_le:{new_le:3d} / "
              f"reused:{reused:3d} / ambiguous:{ambiguous:3d} / delta:{delta}")

        # Check for ambiguous rows or errors - STOP if found
        if ambiguous > 0:
            print(f"[STOP] Ambiguous rows detected ({ambiguous}). Import halted to prevent data corruption.")
            return False

        return True

    def accumulate_summary(self, result: Dict[str, Any], source_type: str):
        """Accumulate metrics into running totals."""
        summary = result.get('summary', {})
        impact = result.get('financial_impact', {})

        target_summary = self.report_summary if source_type == 'report' else self.liberaciones_summary

        target_summary['chunks_processed'] += 1
        target_summary['total_input_rows'] += summary.get('total_input_rows', 0)
        target_summary['total_existing_raw'] += summary.get('existing_raw_exact_match', 0)
        target_summary['total_new_source_records'] += summary.get('new_source_records', 0)
        target_summary['total_new_financial_movements'] += summary.get('new_financial_movements', 0)
        target_summary['total_new_ledger_entries'] += summary.get('new_ledger_entries', 0)
        target_summary['total_reused'] += summary.get('existing_raw_exact_match', 0)
        target_summary['total_ambiguous'] += summary.get('ambiguous_rows', 0)
        target_summary['total_delta'] += Decimal(str(impact.get('expected_delta', 0)))

    def import_source_type(self, rows: List[Dict[str, Any]], source_type: str) -> bool:
        """
        Import all rows for a source type in chunks.
        Returns True if successful, False if should stop.
        """
        print(f"\n{'='*100}")
        print(f"IMPORTING {source_type.upper()}")
        print(f"{'='*100}")
        print(f"[INFO] Starting import of {len(rows)} rows in chunks of {self.CHUNK_SIZE}...\n")

        # Prepare rows
        prepared_rows = self.prepare_rows_for_rpc(rows, source_type)

        # Process in chunks
        chunk_num = 0
        for i in range(0, len(prepared_rows), self.CHUNK_SIZE):
            chunk = prepared_rows[i:i+self.CHUNK_SIZE]
            chunk_num += 1

            # Call RPC
            result = self.call_import_rpc(chunk, source_type, chunk_num)

            if not result:
                print(f"[STOP] Failed to process chunk {chunk_num}. Import halted.")
                return False

            # Debug first chunk response
            if chunk_num == 1:
                print(f"[DEBUG] Full result for chunk 1:")
                print(json.dumps(result, indent=2, default=str))

            # Process result
            if not self.process_chunk_result(result, source_type, chunk_num, len(chunk)):
                return False

            # Accumulate summary
            self.accumulate_summary(result, source_type)

        return True

    def display_final_summary(self):
        """Display final summary of import results."""
        print(f"\n{'='*100}")
        print(f"FINAL SUMMARY")
        print(f"{'='*100}")

        print(f"\n--- REPORT ---")
        print(f"  Chunks processed:              {self.report_summary['chunks_processed']}")
        print(f"  Total input rows:              {self.report_summary['total_input_rows']}")
        print(f"  Total existing (reused):       {self.report_summary['total_existing_raw']}")
        print(f"  Total new source records:      {self.report_summary['total_new_source_records']}")
        print(f"  Total new financial movements: {self.report_summary['total_new_financial_movements']}")
        print(f"  Total new ledger entries:      {self.report_summary['total_new_ledger_entries']}")
        print(f"  Total ambiguous rows:          {self.report_summary['total_ambiguous']}")
        print(f"  Expected delta:                {self.report_summary['total_delta']}")

        print(f"\n--- LIBERACIONES ---")
        print(f"  Chunks processed:              {self.liberaciones_summary['chunks_processed']}")
        print(f"  Total input rows:              {self.liberaciones_summary['total_input_rows']}")
        print(f"  Total existing (reused):       {self.liberaciones_summary['total_existing_raw']}")
        print(f"  Total new source records:      {self.liberaciones_summary['total_new_source_records']}")
        print(f"  Total new financial movements: {self.liberaciones_summary['total_new_financial_movements']}")
        print(f"  Total new ledger entries:      {self.liberaciones_summary['total_new_ledger_entries']}")
        print(f"  Total ambiguous rows:          {self.liberaciones_summary['total_ambiguous']}")
        print(f"  Expected delta:                {self.liberaciones_summary['total_delta']}")

        print(f"\n--- COMBINED ---")
        total_chunks = self.report_summary['chunks_processed'] + self.liberaciones_summary['chunks_processed']
        total_input = self.report_summary['total_input_rows'] + self.liberaciones_summary['total_input_rows']
        total_new_sr = self.report_summary['total_new_source_records'] + self.liberaciones_summary['total_new_source_records']
        total_new_fm = self.report_summary['total_new_financial_movements'] + self.liberaciones_summary['total_new_financial_movements']
        total_new_le = self.report_summary['total_new_ledger_entries'] + self.liberaciones_summary['total_new_ledger_entries']
        total_delta = self.report_summary['total_delta'] + self.liberaciones_summary['total_delta']

        print(f"  Total chunks:                  {total_chunks}")
        print(f"  Total input rows:              {total_input}")
        print(f"  Total new source records:      {total_new_sr}")
        print(f"  Total new financial movements: {total_new_fm}")
        print(f"  Total new ledger entries:      {total_new_le}")
        print(f"  Total expected delta:          {total_delta}")
        print(f"\n{'='*100}\n")

    def run(self, preview_json_path: str):
        """Main entry point."""
        print(f"[START] June 2026 Import Script")
        print(f"[INFO] Loading {preview_json_path}...")

        # Load preview JSON
        data = self.load_preview_json(preview_json_path)

        # Validate
        if not self.validate_batch_sizes(data):
            sys.exit(1)

        # Extract report and liberaciones
        report_rows = data.get('report', [])
        liberaciones_rows = data.get('liberaciones', [])

        # Import report first
        print(f"\n[INFO] account_id: {self.ACCOUNT_ID}")
        print(f"[INFO] month: {self.MONTH_START} to {self.MONTH_END}")

        if not self.import_source_type(report_rows, 'report'):
            print(f"\n[STOP] Report import failed or halted. Aborting entire process.")
            sys.exit(1)

        # Import liberaciones
        if not self.import_source_type(liberaciones_rows, 'liberaciones'):
            print(f"\n[STOP] Liberaciones import failed or halted.")
            sys.exit(1)

        # Display final summary
        self.display_final_summary()

        print(f"[SUCCESS] Import completed successfully")


def main():
    """Entry point."""
    # Allow credentials to be passed as command line arguments
    if len(sys.argv) > 2:
        os.environ['SUPABASE_URL'] = sys.argv[1]
        os.environ['SUPABASE_KEY'] = sys.argv[2]

    # Get path to _preview_batches.json
    current_dir = Path(__file__).parent.parent  # scripts/.. = root
    preview_json = current_dir / '_preview_batches.json'

    importer = JuneImporter()
    importer.run(str(preview_json))


if __name__ == '__main__':
    main()
