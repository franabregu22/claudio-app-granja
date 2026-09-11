#!/usr/bin/env python3
"""
Reconciliation Import Script V2
Handles multiple sources/batches with unified preview and import.
"""

import json
import csv
import hashlib
from datetime import datetime, date
from typing import List, Dict, Any, Optional
import os
import sys

class ReconciliationImporter:
    def __init__(self, account_id: int = 1054315166, timezone: str = 'America/Argentina/Buenos_Aires'):
        self.account_id = account_id
        self.timezone = timezone
        self.import_id = str(datetime.now().isoformat())

    def read_csv(self, filepath: str, delimiter: str = ';', source_type: str = 'liberaciones') -> List[Dict[str, str]]:
        """Read CSV file and return list of row dicts"""
        rows = []
        with open(filepath, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f, delimiter=delimiter)
            for row in reader:
                rows.append(dict(row))
        return rows

    def calculate_historical_payload_hash(self, row: Dict[str, str]) -> str:
        """Calculate SHA256 payload hash for Report using historical algorithm.
        Must match: json.dumps(data, sort_keys=True, ensure_ascii=False)
        """
        json_str = json.dumps(row, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(json_str.encode()).hexdigest()

    def prepare_batch(self, rows: List[Dict[str, str]], source_type: str) -> List[Dict[str, Any]]:
        """Convert CSV rows to JSONB format for RPC.
        For source_type='report', calculates historical payload_hash BEFORE string normalization.
        """
        batch = []
        for row in rows:
            # Calculate historical payload_hash for Report BEFORE any normalization
            payload_hash: Optional[str] = None
            if source_type == 'report':
                payload_hash = self.calculate_historical_payload_hash(row)

            # Convert to jsonb-compatible dict
            jsonb_row = {}
            for key, val in row.items():
                jsonb_row[key] = val if val else None

            # Add payload_hash to row if calculated
            if payload_hash:
                jsonb_row['_payload_hash'] = payload_hash

            batch.append(jsonb_row)
        return batch

    def generate_preview_json(self, batches: List[Dict[str, Any]]) -> str:
        """Generate JSON for preview RPC call"""
        # Format: multiple batches, each with source_type, month_range, rows
        preview_spec = {
            'batches': batches,
            'import_id': self.import_id,
            'account_id': self.account_id
        }
        return json.dumps(preview_spec, indent=2, default=str)

    def display_preview(self, preview_result: Dict[str, Any]) -> None:
        """Display preview results to user"""
        print("\n" + "="*80)
        print("PREVIEW RESULTS")
        print("="*80)
        print(f"Import ID: {preview_result.get('import_id', 'N/A')}")
        print(f"Expected Ledger Net: {preview_result['financial_impact'].get('expected_ledger_net_post_import', 'N/A')}")
        print(f"Expected Delta: {preview_result['financial_impact'].get('expected_delta', 'N/A')}")
        print()
        print("Summary:")
        summary = preview_result.get('summary', {})
        for key, val in summary.items():
            print(f"  {key}: {val}")
        print()
        if preview_result.get('errors'):
            print("ERRORS:")
            for err in preview_result['errors']:
                print(f"  - {err}")
        if preview_result.get('warnings'):
            print("WARNINGS:")
            for warn in preview_result['warnings']:
                print(f"  - {warn}")
        print("="*80 + "\n")


if __name__ == '__main__':
    import sys
    importer = ReconciliationImporter()

    if '--preview-only' in sys.argv:
        # Generate preview queries (no DB connection needed)
        try:
            import json

            with open('_preview_batches.json', 'r') as f:
                batches = json.load(f)

            report_batch = batches['report']
            lib_batch = batches['liberaciones']

            # Prepare batches
            report_prepared = importer.prepare_batch(report_batch, 'report')
            lib_prepared = importer.prepare_batch(lib_batch, 'liberaciones')

            print("="*100)
            print("PREVIEW QUERIES (Ready to execute in Supabase Studio)")
            print("="*100)
            print()
            print("After deploying DEPLOY_TO_SUPABASE_STUDIO.sql, run this in SQL Editor:")
            print()
            print("-- STEP 1: Report Preview")
            sql_report = f"SELECT (preview_financial_movements_reconciliation_v2(1054315166, '{json.dumps(report_prepared)}'::jsonb, 'report', '2026-06-01'::DATE, '2026-06-30'::DATE)->'summary'->>'new_financial_movements')::INT AS report_new_fm;"
            print(sql_report)
            print()
            print("-- STEP 2: Liberaciones Preview")
            sql_lib = f"""SELECT
  (result->'summary'->>'new_financial_movements')::INT AS new_fm,
  (result->'summary'->>'new_ledger_entries')::INT AS new_le,
  (result->'financial_impact'->>'expected_delta')::NUMERIC AS proposed_delta,
  (result->'financial_impact'->>'expected_ledger_net_post_import')::NUMERIC AS expected_ledger_after,
  (result->'summary'->>'reused_existing_fm')::INT AS reused,
  (result->'summary'->>'raw_only_rows')::INT AS raw_only,
  (result->'summary'->>'ambiguous_rows')::INT AS ambiguous
FROM (SELECT preview_financial_movements_reconciliation_v2(1054315166, '{json.dumps(lib_prepared)}'::jsonb, 'liberaciones', '2026-06-01'::DATE, '2026-06-30'::DATE) AS result) sub;"""
            print(sql_lib)
            print()
            print("="*100)
            print(f"Report rows: {len(report_prepared)} | Liberaciones rows: {len(lib_prepared)}")
            print("="*100)

        except Exception as e:
            print(f"Error loading batches: {e}")
    else:
        print("ReconciliationImporter V2 ready")
        print(f"Account ID: {importer.account_id}")
        print(f"Import ID: {importer.import_id}")
        print()
        print("Usage: python3 scripts/import_reconciliation_v2.py --preview-only")
