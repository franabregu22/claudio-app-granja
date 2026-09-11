-- COMMIT REAL: Reporte 65330696 - PRIMERA EJECUCIÓN (6 filas contables)
-- Resultado esperado: 6 SR, 6 FM, 6 LE, 6 links, delta +115203.14
-- ============================================================================

SELECT import_financial_movements_reconciliation_v2(
  1054315166,
  ARRAY[
    jsonb_build_object(
      'DATE', '2026-09-10T05:09:27.000-03:00',
      'SOURCE_ID', '1749778835436',
      'DESCRIPTION', 'asset_management',
      'NET_CREDIT_AMOUNT', '172.77',
      'NET_DEBIT_AMOUNT', '0.00',
      'GROSS_AMOUNT', '172.77',
      'MP_FEE_AMOUNT', '0.00',
      'TAXES_AMOUNT', '0.00',
      'PAYMENT_METHOD', 'available_money'
    ),
    jsonb_build_object(
      'DATE', '2026-09-10T09:15:42.000-03:00',
      'SOURCE_ID', '178284169630',
      'DESCRIPTION', 'payment',
      'NET_CREDIT_AMOUNT', '77532.00',
      'NET_DEBIT_AMOUNT', '0.00',
      'GROSS_AMOUNT', '77532.00',
      'MP_FEE_AMOUNT', '0.00',
      'TAXES_AMOUNT', '0.00',
      'PAYMENT_METHOD', 'available_money'
    ),
    jsonb_build_object(
      'DATE', '2026-09-10T11:22:15.000-03:00',
      'SOURCE_ID', '178295460032',
      'DESCRIPTION', 'payment',
      'NET_CREDIT_AMOUNT', '7455.00',
      'NET_DEBIT_AMOUNT', '0.00',
      'GROSS_AMOUNT', '7455.00',
      'MP_FEE_AMOUNT', '0.00',
      'TAXES_AMOUNT', '0.00',
      'PAYMENT_METHOD', 'debin_transfer'
    ),
    jsonb_build_object(
      'DATE', '2026-09-10T14:31:08.000-03:00',
      'SOURCE_ID', '178400937794',
      'DESCRIPTION', 'payment',
      'NET_CREDIT_AMOUNT', '7455.00',
      'NET_DEBIT_AMOUNT', '0.00',
      'GROSS_AMOUNT', '7455.00',
      'MP_FEE_AMOUNT', '0.00',
      'TAXES_AMOUNT', '0.00',
      'PAYMENT_METHOD', 'debin_transfer'
    ),
    jsonb_build_object(
      'DATE', '2026-09-10T16:45:33.000-03:00',
      'SOURCE_ID', '1749829712459',
      'DESCRIPTION', 'asset_management',
      'NET_CREDIT_AMOUNT', '223.37',
      'NET_DEBIT_AMOUNT', '0.00',
      'GROSS_AMOUNT', '223.37',
      'MP_FEE_AMOUNT', '0.00',
      'TAXES_AMOUNT', '0.00',
      'PAYMENT_METHOD', 'available_money'
    ),
    jsonb_build_object(
      'DATE', '2026-09-10T19:52:19.000-03:00',
      'SOURCE_ID', '177514804873',
      'DESCRIPTION', 'payment',
      'NET_CREDIT_AMOUNT', '22365.00',
      'NET_DEBIT_AMOUNT', '0.00',
      'GROSS_AMOUNT', '22365.00',
      'MP_FEE_AMOUNT', '0.00',
      'TAXES_AMOUNT', '0.00',
      'PAYMENT_METHOD', 'cvu'
    )
  ],
  'report',
  '2026-09-01'::DATE,
  '2026-09-30'::DATE,
  'report-65330696-ejecucion-1'
) as result;

-- Validación: Verificar conteos después
SELECT
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166 AND source_type = 'report') as sr_total,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_total,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_total,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_total,
  (SELECT SUM(le.balance_impact) FROM ledger_entry le
    INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
    WHERE mfm.account_id = 1054315166) as ledger_net_total;

-- Verificar clasificaciones correctas
SELECT
  mfm.id,
  mfm.movement_class,
  msr.source_external_id,
  le.category,
  le.balance_impact
FROM mp_financial_movement mfm
LEFT JOIN mp_movement_source_link msl ON mfm.id = msl.financial_movement_id
LEFT JOIN mp_source_record msr ON msl.source_record_id = msr.id
LEFT JOIN ledger_entry le ON mfm.id = le.financial_movement_id
WHERE mfm.account_id = 1054315166
  AND msr.source_external_id IN ('1749778835436', '178284169630', '178295460032', '178400937794', '1749829712459', '177514804873')
ORDER BY mfm.id;
