SELECT
  mfm.id as fm_id,
  le.id as le_id,
  le.balance_impact,
  le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires' as occurred_at,
  mfm.movement_class,
  mfm.settlement_amount,
  mfm.needs_review,
  mfm.transaction_date,
  json_agg(
    json_build_object(
      'sr_id', msr.id,
      'source_type', msr.source_type,
      'source_external_id', msr.source_external_id,
      'payload_hash', msr.payload_hash
    )
    ORDER BY msr.id
  ) FILTER (WHERE msr.id IS NOT NULL) as source_records
FROM mp_financial_movement mfm
LEFT JOIN ledger_entry le ON le.financial_movement_id = mfm.id
LEFT JOIN mp_movement_source_link mmsl ON mfm.id = mmsl.financial_movement_id
LEFT JOIN mp_source_record msr ON mmsl.source_record_id = msr.id
WHERE mfm.account_id = 1054315166
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
GROUP BY
  mfm.id, le.id, le.balance_impact, le.occurred_at, mfm.movement_class,
  mfm.settlement_amount, mfm.needs_review, mfm.transaction_date
ORDER BY mfm.id ASC, le.id ASC;

