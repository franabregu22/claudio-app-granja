#!/usr/bin/env python3
"""
Preview June 2026 Reconciliation V3.2 with SHA256 Historical Payload Hash
Executes READ-ONLY preview against AppGranja database via Supabase RPC
"""

import json
import csv
import hashlib
from datetime import datetime
from typing import List, Dict, Any, Tuple
import os
import sys

try:
    import requests
except ImportError:
    print("[ERROR] requests library required. Install: pip install requests")
    sys.exit(1)

class JuneReconciliationPreview:
    def __init__(self, account_id: int = 1054315166):
        self.account_id = account_id
        self.month_start = '2026-06-01'
        self.month_end = '2026-06-30'
        self.db_url = 'https://aplbsutpzgemexayldct.supabase.co'
        self.db_key = os.environ.get('SUPABASE_KEY')
        if not self.db_key:
            print("[ERROR] SUPABASE_KEY environment variable not set")
            sys.exit(1)

    def calculate_historical_payload_hash(self, row: Dict[str, str]) -> str:
        json_str = json.dumps(row, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(json_str.encode()).hexdigest()

    def read_csv_june(self, filepath: str, delimiter: str = ';') -> List[Dict[str, str]]:
        rows = []
        with open(filepath, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f, delimiter=delimiter)
            for row in reader:
                date_field = row.get('TRANSACTION_DATE') or row.get('DATE', '')
                if '2026-06' in date_field:
                    rows.append(dict(row))
        return rows

    def prepare_batch(self, rows: List[Dict[str, str]], source_type: str) -> Tuple[List[Dict[str, Any]], Dict]:
        batch = []
        hash_mapping = {}

        for row in rows:
            payload_hash = None
            if source_type == 'report':
                payload_hash = self.calculate_historical_payload_hash(row)
                hash_mapping[payload_hash] = {
                    'source_id': row.get('SOURCE_ID', ''),
                    'date': row.get('TRANSACTION_DATE', ''),
                    'amount': float(row.get('SETTLEMENT_NET_AMOUNT', '0') or '0'),
                }

            jsonb_row = {k: (v if v else None) for k, v in row.items()}
            if payload_hash:
                jsonb_row['_payload_hash'] = payload_hash

            batch.append(jsonb_row)

        return batch, hash_mapping

    def call_rpc_preview(self, batch: List[Dict[str, Any]], source_type: str) -> Dict[str, Any]:
        url = f"{self.db_url}/rest/v1/rpc/preview_financial_movements_reconciliation_v2"
        headers = {
            "apikey": self.db_key,
            "Authorization": f"Bearer {self.db_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "p_account_id": self.account_id,
            "p_input_rows": batch,
            "p_source_type": source_type,
            "p_month_start": self.month_start,
            "p_month_end": self.month_end
        }

        print(f"\n[INFO] Calling preview RPC for {source_type} ({len(batch)} rows)...")

        try:
            response = requests.post(url, json=payload, headers=headers, timeout=120)

            if response.status_code != 200:
                print(f"[ERROR] RPC failed: {response.status_code}")
                print(f"       {response.text[:200]}")
                return {'error': response.text}

            result = response.json()
            if isinstance(result, list) and len(result) > 0:
                return result[0]
            return result

        except Exception as e:
            print(f"[ERROR] Exception: {e}")
            return {'error': str(e)}

    def run_preview(self) -> Dict[str, Any]:
        report_path = r"C:\Users\Franabregu\Desktop\Claudio app Granja\data\mercadopago\arch4.csv"
        lib_path = r"C:\Users\Franabregu\Desktop\Claudio app Granja\data\mercadopago\Liberaciones2.csv"

        print("="*100)
        print("JUNE 2026 RECONCILIATION PREVIEW (V3.2 with SHA256 Historical Mapping)")
        print("="*100)

        results = {}

        # Report
        print("\n[1/2] Processing Report...")
        report_rows = self.read_csv_june(report_path)
        print(f"[INFO] {len(report_rows)} Report rows for June")

        report_batch, report_hashes = self.prepare_batch(report_rows, 'report')
        results['report'] = {
            'source_type': 'report',
            'input_rows': len(report_rows),
            'hashes': report_hashes,
            'preview': self.call_rpc_preview(report_batch, 'report')
        }

        # Liberaciones
        print("\n[2/2] Processing Liberaciones...")
        lib_rows = self.read_csv_june(lib_path)
        print(f"[INFO] {len(lib_rows)} Liberaciones rows for June")

        lib_batch, _ = self.prepare_batch(lib_rows, 'liberaciones')
        results['liberaciones'] = {
            'source_type': 'liberaciones',
            'input_rows': len(lib_rows),
            'preview': self.call_rpc_preview(lib_batch, 'liberaciones')
        }

        return results

    def print_report(self, results: Dict[str, Any]) -> None:
        print("\n" + "="*100)
        print("RESULTS")
        print("="*100)

        for source_type in ['report', 'liberaciones']:
            if source_type not in results:
                continue

            data = results[source_type]
            preview = data.get('preview', {})

            if 'error' in preview:
                print(f"\n{source_type.upper()}: ERROR - {preview['error']}")
                continue

            print(f"\n{source_type.upper()}:")
            print(f"  Input rows: {data['input_rows']}")

            summary = preview.get('summary', {})
            financial = preview.get('financial_impact', {})

            print(f"\n  Summary:")
            print(f"    existing_raw_exact_match: {summary.get('existing_raw_exact_match', 0)}")
            print(f"    new_source_records: {summary.get('new_source_records', 0)}")
            print(f"    new_financial_movements: {summary.get('new_financial_movements', 0)}")
            print(f"    new_ledger_entries: {summary.get('new_ledger_entries', 0)}")
            print(f"    create_fm_from_existing_sr: {summary.get('create_fm_from_existing_sr', 0)}")
            print(f"    multi_settlement_collapses_detected: {summary.get('multi_settlement_collapses_detected', 0)}")

            print(f"\n  Financial Impact:")
            print(f"    current_ledger (pre): {financial.get('current_ledger_net_pre_import')}")
            print(f"    expected_delta: {financial.get('expected_delta')}")
            print(f"    expected_final: {financial.get('expected_ledger_net_post_import')}")

        print("\n" + "="*100)

if __name__ == '__main__':
    preview = JuneReconciliationPreview()
    results = preview.run_preview()
    preview.print_report(results)

    output_file = r"C:\Users\Franabregu\Desktop\Claudio app Granja\preview_june_v32_results.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\n[OK] Results saved to: {output_file}")
