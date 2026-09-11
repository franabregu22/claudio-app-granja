SET CONSTRAINTS ALL IMMEDIATE;
SELECT
  'VALIDATION' as check,
  (SELECT COUNT(*) FROM mp_source_record) as source_records,
  (SELECT COUNT(*) FROM mp_financial_movement) as movements,
  (SELECT COUNT(*) FROM mp_movement_source_link) as links,
  (SELECT COUNT(*) FROM ledger_entry) as ledger,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class='yield') as yields,
  (SELECT SUM(settlement_amount)::NUMERIC(15,2) FROM mp_financial_movement) as total_settlement;
