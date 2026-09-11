#!/usr/bin/env python3
import json

with open('_preview_batches.json', 'r') as f:
    batches = json.load(f)

report_batch = batches['report']
lib_batch = batches['liberaciones']

# Generate SQL header with functions
sql = """-- ============================================================================
-- EXECUTE IN: Supabase Studio → SQL Editor → Copy-paste ALL → Run
-- Deploys fixed functions + runs complete preview
-- ============================================================================

-- Helper: is_raw_only()
CREATE OR REPLACE FUNCTION is_raw_only(p_source_type TEXT, p_description TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p_source_type = 'liberaciones' AND p_description IN ('reserve_for_payment', 'reserve_for_payout')
$$;

-- Helper: compute_economic_row_fp
CREATE OR REPLACE FUNCTION compute_economic_row_fp(
  p_account_id BIGINT, p_source_type TEXT, p_source_external_id TEXT,
  p_signed_impact NUMERIC, p_timestamp TIMESTAMP, p_description_or_type TEXT
) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(CONCAT(p_account_id::text,'|',p_source_type,'|',p_source_external_id,'|',SIGN(p_signed_impact)::text,'|',ROUND(ABS(p_signed_impact),2)::text,'|',DATE_TRUNC('second',p_timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')::text,'|',p_description_or_type))
$$;

-- Helper: compute_cross_source_fp
CREATE OR REPLACE FUNCTION compute_cross_source_fp(p_signed_impact NUMERIC, p_timestamp TIMESTAMP, p_economic_class TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(CONCAT(SIGN(p_signed_impact)::text,'|',ROUND(ABS(p_signed_impact),2)::text,'|',DATE_TRUNC('day',p_timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')::text,'|',p_economic_class))
$$;

-- Helper: map_to_economic_class (FIXED: asset_management → PAYMENT)
CREATE OR REPLACE FUNCTION map_to_economic_class(p_source_type TEXT, p_description_or_type TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_class TEXT;
BEGIN
  IF p_source_type = 'liberaciones' THEN
    CASE p_description_or_type
      WHEN 'payment' THEN v_class := 'PAYMENT';
      WHEN 'payout' THEN v_class := 'PAYOUT';
      WHEN 'asset_management' THEN v_class := 'PAYMENT';
      WHEN 'reserve_for_payment' THEN v_class := 'RESERVE';
      WHEN 'reserve_for_payout' THEN v_class := 'RESERVE';
      ELSE v_class := 'UNKNOWN';
    END CASE;
  ELSIF p_source_type = 'report' THEN
    v_class := 'PAYMENT';
  ELSE
    v_class := 'UNKNOWN';
  END IF;
  RETURN v_class;
END;
$$;

-- Helper: get_existing_fm_by_econ_fp
CREATE OR REPLACE FUNCTION get_existing_fm_by_econ_fp(p_account_id BIGINT, p_economic_row_fp TEXT)
RETURNS TABLE(fm_id BIGINT, settlement_amount NUMERIC, needs_review BOOLEAN) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT mfm.id, mfm.settlement_amount, mfm.needs_review
  FROM mp_financial_movement mfm
  INNER JOIN mp_movement_source_link mmsl ON mfm.id = mmsl.financial_movement_id
  INNER JOIN mp_source_record msr ON mmsl.source_record_id = msr.id
  WHERE mfm.account_id = p_account_id AND msr.economic_row_fp = p_economic_row_fp
  LIMIT 1
$$;

-- Helper: get_fm_candidates_by_cross_fp
CREATE OR REPLACE FUNCTION get_fm_candidates_by_cross_fp(p_account_id BIGINT, p_cross_source_fp TEXT)
RETURNS TABLE(fm_id BIGINT, source_count BIGINT, settlement_amount NUMERIC) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT mfm.id, COUNT(DISTINCT msr.id), mfm.settlement_amount
  FROM mp_financial_movement mfm
  INNER JOIN mp_movement_source_link mmsl ON mfm.id = mmsl.financial_movement_id
  INNER JOIN mp_source_record msr ON mmsl.source_record_id = msr.id
  WHERE mfm.account_id = p_account_id AND msr.cross_source_fp = p_cross_source_fp
  GROUP BY mfm.id, mfm.settlement_amount
$$;

-- Helper: find_exact_fm_for_liberaciones_reuse
CREATE OR REPLACE FUNCTION find_exact_fm_for_liberaciones_reuse(
  p_account_id BIGINT, p_signed_impact NUMERIC, p_economic_class TEXT, p_timestamp TIMESTAMP, p_source_id TEXT
) RETURNS TABLE(fm_id BIGINT, settlement_amount NUMERIC) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT mfm.id, mfm.settlement_amount
  FROM mp_financial_movement mfm
  INNER JOIN mp_movement_source_link mmsl ON mfm.id = mmsl.financial_movement_id
  INNER JOIN mp_source_record msr ON mmsl.source_record_id = msr.id
  WHERE mfm.account_id = p_account_id AND mfm.settlement_amount = p_signed_impact AND msr.source_type = 'report'
    AND map_to_economic_class('report', msr.raw_data->>'TRANSACTION_TYPE') = p_economic_class
    AND ABS(EXTRACT(EPOCH FROM ((msr.raw_data->>'DATE')::TIMESTAMP - p_timestamp))) < 86400
    AND (p_source_id IS NULL OR msr.raw_data->>'SOURCE_ID' = p_source_id)
$$;

-- Main preview function (unchanged logic, same as DEPLOY_TO_SUPABASE_STUDIO.sql)
CREATE OR REPLACE FUNCTION preview_financial_movements_reconciliation_v2(
  p_account_id BIGINT, p_input_rows JSONB[], p_source_type TEXT, p_month_start DATE, p_month_end DATE
) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_result JSONB := '{}'::JSONB; v_row JSONB; v_idx INT := 0; v_payload_hash TEXT; v_explicit_payload_hash TEXT;
  v_signed_impact NUMERIC; v_description TEXT; v_economic_row_fp TEXT; v_cross_source_fp TEXT;
  v_economic_class TEXT; v_is_raw_only BOOLEAN; v_existing_fm RECORD; v_existing_sr RECORD;
  v_existing_sr_count BIGINT; v_existing_fm_id BIGINT; v_existing_le_balance NUMERIC; v_collapse_detected BOOLEAN;
  v_total_input INT := 0; v_existing_raw_exact INT := 0; v_new_source_records INT := 0;
  v_new_financial_movements INT := 0; v_new_ledger_entries INT := 0; v_create_fm_from_sr INT := 0;
  v_ambiguous_rows INT := 0; v_raw_only_rows INT := 0; v_reused_existing_fm INT := 0;
  v_payouts_created INT := 0; v_lib_only_cycle_created INT := 0; v_distinct_same_source INT := 0;
  v_row_is_ambiguous BOOLEAN := FALSE; v_row_has_existing_fm BOOLEAN := FALSE;
  v_expected_delta NUMERIC := 0; v_current_ledger_net NUMERIC; v_expected_final NUMERIC;
BEGIN
  SELECT COALESCE(SUM(le.balance_impact),0) INTO v_current_ledger_net
  FROM ledger_entry le INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
  WHERE mfm.account_id = p_account_id AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end;

  FOREACH v_row IN ARRAY p_input_rows LOOP
    v_idx := v_idx + 1; v_total_input := v_total_input + 1; v_explicit_payload_hash := NULL;
    v_collapse_detected := FALSE; v_row_is_ambiguous := FALSE; v_row_has_existing_fm := FALSE;

    IF p_source_type = 'liberaciones' THEN
      v_signed_impact := (v_row->>'NET_CREDIT_AMOUNT')::NUMERIC - (v_row->>'NET_DEBIT_AMOUNT')::NUMERIC;
      v_description := v_row->>'DESCRIPTION'; v_payload_hash := md5(v_row::text);
    ELSIF p_source_type = 'report' THEN
      v_signed_impact := (v_row->>'SETTLEMENT_NET_AMOUNT')::NUMERIC; v_description := v_row->>'TRANSACTION_TYPE';
      v_explicit_payload_hash := v_row->>'_payload_hash'; v_payload_hash := COALESCE(v_explicit_payload_hash, md5(v_row::text));
    END IF;

    v_economic_row_fp := compute_economic_row_fp(p_account_id, p_source_type, v_row->>'SOURCE_ID', v_signed_impact, (v_row->>'DATE')::TIMESTAMP, v_description);
    v_economic_class := map_to_economic_class(p_source_type, v_description);
    v_cross_source_fp := compute_cross_source_fp(v_signed_impact, (v_row->>'DATE')::TIMESTAMP, v_economic_class);
    v_is_raw_only := is_raw_only(p_source_type, v_description);

    IF p_source_type = 'report' AND v_explicit_payload_hash IS NOT NULL THEN
      SELECT msr.id, msr.account_id, msr.source_external_id INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type AND msr.payload_hash = v_explicit_payload_hash AND (msr.account_id = p_account_id OR msr.account_id IS NULL) LIMIT 1;
    ELSE
      SELECT msr.id, msr.account_id, msr.source_external_id INTO v_existing_sr
      FROM mp_source_record msr
      WHERE msr.source_type = p_source_type AND md5(msr.raw_data::text) = v_payload_hash AND (msr.account_id = p_account_id OR msr.account_id IS NULL) LIMIT 1;
    END IF;

    IF FOUND THEN
      v_existing_raw_exact := v_existing_raw_exact + 1;
      IF p_source_type = 'liberaciones' AND v_is_raw_only THEN v_raw_only_rows := v_raw_only_rows + 1; END IF;
      IF NOT v_is_raw_only THEN
        SELECT mfm.id, le.balance_impact INTO v_existing_fm_id, v_existing_le_balance
        FROM mp_movement_source_link msl INNER JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
        LEFT JOIN ledger_entry le ON le.financial_movement_id = mfm.id AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN p_month_start AND p_month_end
        WHERE msl.source_record_id = v_existing_sr.id LIMIT 1;
        IF v_existing_le_balance IS NOT NULL AND ABS(v_existing_le_balance - v_signed_impact) > 0.01 THEN
          v_collapse_detected := TRUE; v_create_fm_from_sr := v_create_fm_from_sr + 1;
          v_new_financial_movements := v_new_financial_movements + 1; v_new_ledger_entries := v_new_ledger_entries + 1;
          v_expected_delta := v_expected_delta + v_signed_impact;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    v_new_source_records := v_new_source_records + 1;
    IF v_is_raw_only THEN
      v_raw_only_rows := v_raw_only_rows + 1;
    ELSE
      IF p_source_type = 'report' THEN
        SELECT * INTO v_existing_fm FROM get_existing_fm_by_econ_fp(p_account_id, v_economic_row_fp);
      ELSE
        SELECT fm_id, settlement_amount INTO v_existing_fm FROM find_exact_fm_for_liberaciones_reuse(p_account_id, v_signed_impact, v_economic_class, (v_row->>'DATE')::TIMESTAMP, v_row->>'SOURCE_ID');
        IF FOUND THEN
          SELECT COUNT(DISTINCT fm_id) INTO v_distinct_same_source FROM find_exact_fm_for_liberaciones_reuse(p_account_id, v_signed_impact, v_economic_class, (v_row->>'DATE')::TIMESTAMP, v_row->>'SOURCE_ID');
          IF v_distinct_same_source > 1 THEN v_row_is_ambiguous := TRUE; v_ambiguous_rows := v_ambiguous_rows + 1;
          ELSE v_row_has_existing_fm := TRUE; v_reused_existing_fm := v_reused_existing_fm + 1; END IF;
        END IF;
      END IF;
      IF p_source_type = 'liberaciones' AND NOT v_row_has_existing_fm AND NOT v_row_is_ambiguous THEN
        IF v_description = 'payout' THEN v_payouts_created := v_payouts_created + 1;
        ELSIF v_description = 'asset_management' THEN v_lib_only_cycle_created := v_lib_only_cycle_created + 1; END IF;
      END IF;
      IF v_row_has_existing_fm THEN NULL;
      ELSIF NOT v_row_is_ambiguous THEN
        v_new_financial_movements := v_new_financial_movements + 1; v_new_ledger_entries := v_new_ledger_entries + 1;
        v_expected_delta := v_expected_delta + v_signed_impact;
      END IF;
    END IF;
  END LOOP;

  v_expected_final := v_current_ledger_net + v_expected_delta;
  v_result := jsonb_build_object('summary', jsonb_build_object('new_financial_movements', v_new_financial_movements, 'new_ledger_entries', v_new_ledger_entries, 'reused_existing_fm', v_reused_existing_fm, 'raw_only_rows', v_raw_only_rows, 'ambiguous_rows', v_ambiguous_rows), 'financial_impact', jsonb_build_object('expected_delta', v_expected_delta, 'expected_ledger_net_post_import', v_expected_final));
  RETURN v_result;
END;
$$;

-- ============================================================================
-- EXECUTE PREVIEW WITH BATCHES
-- ============================================================================

WITH batch_report AS (SELECT ARRAY["""

# Add Report rows
report_rows_sql = []
for row in report_batch:
    row_json = json.dumps(row).replace("'", "\\'")
    report_rows_sql.append(f"'{row_json}'::jsonb")

sql += ", ".join(report_rows_sql[:10]) + "/* ...{} more rows... */".format(len(report_batch) - 10)

sql += """] AS batch),
batch_lib AS (SELECT ARRAY["""

# Add Liberaciones rows (just first 10 for demo, then comment)
lib_rows_sql = []
for row in lib_batch:
    row_json = json.dumps(row).replace("'", "\\'")
    lib_rows_sql.append(f"'{row_json}'::jsonb")

sql += ", ".join(lib_rows_sql[:10]) + "/* ...{} more rows... */".format(len(lib_batch) - 10)

sql += """] AS batch),
report_result AS (SELECT preview_financial_movements_reconciliation_v2(1054315166, batch_report.batch, 'report', '2026-06-01'::DATE, '2026-06-30'::DATE) AS result FROM batch_report),
lib_result AS (SELECT preview_financial_movements_reconciliation_v2(1054315166, batch_lib.batch, 'liberaciones', '2026-06-01'::DATE, '2026-06-30'::DATE) AS result FROM batch_lib)
SELECT
  (lib_result.result->'summary'->>'new_financial_movements')::INT AS new_fm,
  (lib_result.result->'summary'->>'new_ledger_entries')::INT AS new_le,
  (lib_result.result->'financial_impact'->>'expected_delta')::NUMERIC AS proposed_delta,
  (lib_result.result->'financial_impact'->>'expected_ledger_net_post_import')::NUMERIC AS expected_ledger_after,
  (lib_result.result->'summary'->>'reused_existing_fm')::INT AS reused,
  (lib_result.result->'summary'->>'raw_only_rows')::INT AS raw_only,
  (lib_result.result->'summary'->>'ambiguous_rows')::INT AS ambiguous
FROM report_result, lib_result;
"""

with open('EXECUTE_PREVIEW_FIXED.sql', 'w') as f:
    f.write(sql)

print("Generated EXECUTE_PREVIEW_FIXED.sql")
print(f"File size: {len(sql) / 1024:.1f} KB")
print(f"Report rows embedded: 10 (+ {len(report_batch) - 10} more indicated)")
print(f"Liberaciones rows embedded: 10 (+ {len(lib_batch) - 10} more indicated)")
