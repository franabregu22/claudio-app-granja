-- Test: 4 critical Report rows con PAYLOAD_HASH EXACTOS y COMPLETOS
-- Expected: existing_raw_exact_match=4, new_source_records=0, create_fm_from_existing_sr=2

SELECT
  (preview_financial_movements_reconciliation_v2(
    1054315166,
    ARRAY[
      jsonb_build_object(
        'DATE', '2026-06-15T10:30:00',
        'SOURCE_ID', '123456789',
        'SETTLEMENT_NET_AMOUNT', '471.71',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', '0d4ae5fcceaf937640f9c219483ea24a95e8b25794c4196cdfe6eccd3e73989c'
      ),
      jsonb_build_object(
        'DATE', '2026-06-15T10:31:00',
        'SOURCE_ID', '123456790',
        'SETTLEMENT_NET_AMOUNT', '1629.44',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', '00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50'
      ),
      jsonb_build_object(
        'DATE', '2026-06-16T09:15:00',
        'SOURCE_ID', '123456791',
        'SETTLEMENT_NET_AMOUNT', '1854.71',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', 'c404fc99c6028e8caa261229fa822bb96909555480bd432905bbd3c91858a9ce'
      ),
      jsonb_build_object(
        'DATE', '2026-06-16T09:16:00',
        'SOURCE_ID', '123456792',
        'SETTLEMENT_NET_AMOUNT', '463.84',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', 'e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f'
      )
    ],
    'report',
    '2026-06-01'::DATE,
    '2026-06-30'::DATE
  ))->'summary'->>'existing_raw_exact_match' AS existing_raw_exact_match,

  (preview_financial_movements_reconciliation_v2(
    1054315166,
    ARRAY[
      jsonb_build_object(
        'DATE', '2026-06-15T10:30:00',
        'SOURCE_ID', '123456789',
        'SETTLEMENT_NET_AMOUNT', '471.71',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', '0d4ae5fcceaf937640f9c219483ea24a95e8b25794c4196cdfe6eccd3e73989c'
      ),
      jsonb_build_object(
        'DATE', '2026-06-15T10:31:00',
        'SOURCE_ID', '123456790',
        'SETTLEMENT_NET_AMOUNT', '1629.44',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', '00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50'
      ),
      jsonb_build_object(
        'DATE', '2026-06-16T09:15:00',
        'SOURCE_ID', '123456791',
        'SETTLEMENT_NET_AMOUNT', '1854.71',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', 'c404fc99c6028e8caa261229fa822bb96909555480bd432905bbd3c91858a9ce'
      ),
      jsonb_build_object(
        'DATE', '2026-06-16T09:16:00',
        'SOURCE_ID', '123456792',
        'SETTLEMENT_NET_AMOUNT', '463.84',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', 'e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f'
      )
    ],
    'report',
    '2026-06-01'::DATE,
    '2026-06-30'::DATE
  ))->'summary'->>'new_source_records' AS new_source_records,

  (preview_financial_movements_reconciliation_v2(
    1054315166,
    ARRAY[
      jsonb_build_object(
        'DATE', '2026-06-15T10:30:00',
        'SOURCE_ID', '123456789',
        'SETTLEMENT_NET_AMOUNT', '471.71',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', '0d4ae5fcceaf937640f9c219483ea24a95e8b25794c4196cdfe6eccd3e73989c'
      ),
      jsonb_build_object(
        'DATE', '2026-06-15T10:31:00',
        'SOURCE_ID', '123456790',
        'SETTLEMENT_NET_AMOUNT', '1629.44',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', '00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50'
      ),
      jsonb_build_object(
        'DATE', '2026-06-16T09:15:00',
        'SOURCE_ID', '123456791',
        'SETTLEMENT_NET_AMOUNT', '1854.71',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', 'c404fc99c6028e8caa261229fa822bb96909555480bd432905bbd3c91858a9ce'
      ),
      jsonb_build_object(
        'DATE', '2026-06-16T09:16:00',
        'SOURCE_ID', '123456792',
        'SETTLEMENT_NET_AMOUNT', '463.84',
        'TRANSACTION_TYPE', 'SETTLEMENT',
        '_payload_hash', 'e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f'
      )
    ],
    'report',
    '2026-06-01'::DATE,
    '2026-06-30'::DATE
  ))->'summary'->>'create_fm_from_existing_sr' AS create_fm_from_existing_sr;
