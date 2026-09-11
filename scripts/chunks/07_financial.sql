SET CONSTRAINTS ALL DEFERRED;

INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  151, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIA PAULA MONTERO DE ESPINOSA',
  'CUIT',
  '27298980709',
  '2026-08-29T08:47:56-03:00'::timestamp with time zone,
  '2026-08-29T08:47:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  152, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Gladys Beatriz Yanisky',
  'CUIL',
  '27171359843',
  '2026-08-29T08:47:46-03:00'::timestamp with time zone,
  '2026-08-29T08:47:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  153, 1054315166, 'payment_in',
  33000.00, 32802.00, -198.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'DESPENSA EL TILO',
  'CUIT',
  '20218114211',
  '2026-08-29T08:12:45-03:00'::timestamp with time zone,
  '2026-08-29T08:12:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  154, 1054315166, 'payment_in',
  39000.00, 38766.00, -234.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'La casa de Carlos ',
  'CUIT',
  '20109920968',
  '2026-08-29T08:11:48-03:00'::timestamp with time zone,
  '2026-08-29T08:11:48-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  155, 1054315166, 'payment_in',
  78000.00, 77532.00, -468.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Bachin',
  'CUIT',
  '20269991462',
  '2026-08-29T08:02:29-03:00'::timestamp with time zone,
  '2026-08-29T08:02:30-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  156, 1054315166, 'payment_in',
  78000.00, 77532.00, -468.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Austral panaderia',
  'CUIT',
  '20385482265',
  '2026-08-29T07:23:32-03:00'::timestamp with time zone,
  '2026-08-29T07:23:33-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  157, 1054315166, 'payment_in',
  39000.00, 38766.00, -234.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Matias Margiotta',
  'CUIL',
  '20298982626',
  '2026-08-28T22:15:00-03:00'::timestamp with time zone,
  '2026-08-28T22:15:00-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  158, 1054315166, 'payment_out',
  -10000.00, -10060.00, -60.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-28T21:23:39-03:00'::timestamp with time zone,
  '2026-08-28T21:23:40-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  159, 1054315166, 'payment_out',
  -80000.00, -80480.00, -480.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-28T21:23:05-03:00'::timestamp with time zone,
  '2026-08-28T21:23:06-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  160, 1054315166, 'payment_in',
  2000.00, 1988.00, -12.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mariana',
  'CUIT',
  '27245460673',
  '2026-08-28T08:50:15-03:00'::timestamp with time zone,
  '2026-08-28T08:50:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  161, 1054315166, 'yield',
  1913.62, 1913.62, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-28T02:36:57-03:00'::timestamp with time zone,
  '2026-08-28T02:36:57-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  162, 1054315166, 'payment_in',
  78000.00, 77532.00, -468.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Jose Choque',
  'CUIL',
  '20188424032',
  '2026-08-27T20:55:02-03:00'::timestamp with time zone,
  '2026-08-27T20:55:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  163, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Natalia Pastelería',
  'CUIT',
  '27263043850',
  '2026-08-27T12:56:51-03:00'::timestamp with time zone,
  '2026-08-27T12:56:52-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  164, 1054315166, 'yield',
  2155.16, 2155.16, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-27T03:17:37-03:00'::timestamp with time zone,
  '2026-08-27T03:17:37-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  165, 1054315166, 'payment_out',
  -360000.00, -362160.00, -2160.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-26T22:45:29-03:00'::timestamp with time zone,
  '2026-08-26T22:45:29-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  166, 1054315166, 'payment_out',
  -78016.00, -78484.10, -468.10,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-26T18:17:45-03:00'::timestamp with time zone,
  '2026-08-26T18:17:45-03:00'::timestamp with time zone,
  '43925785337',
  '148232386',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  167, 1054315166, 'payment_in',
  108000.00, 107352.00, -648.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'freddy',
  'CUIT',
  '23943241759',
  '2026-08-26T12:42:58-03:00'::timestamp with time zone,
  '2026-08-26T12:42:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  168, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'club',
  'CUIL',
  '27285136151',
  '2026-08-26T12:34:02-03:00'::timestamp with time zone,
  '2026-08-26T12:34:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  169, 1054315166, 'yield',
  1807.90, 1807.90, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-26T04:09:56-03:00'::timestamp with time zone,
  '2026-08-26T04:09:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  170, 1054315166, 'payment_in',
  39000.00, 38766.00, -234.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Matias Margiotta',
  'CUIL',
  '20298982626',
  '2026-08-25T22:01:21-03:00'::timestamp with time zone,
  '2026-08-25T22:01:21-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  171, 1054315166, 'payment_in',
  350000.00, 347900.00, -2100.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'marcial',
  'CUIT',
  '20927193257',
  '2026-08-25T21:47:44-03:00'::timestamp with time zone,
  '2026-08-25T21:47:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  172, 1054315166, 'payment_in',
  195000.00, 193830.00, -1170.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mrpolloviedma1',
  'CUIT',
  '27145276417',
  '2026-08-25T19:53:22-03:00'::timestamp with time zone,
  '2026-08-25T19:53:22-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  173, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mariana',
  'CUIT',
  '27245460673',
  '2026-08-25T14:12:08-03:00'::timestamp with time zone,
  '2026-08-25T14:12:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  174, 1054315166, 'yield',
  1813.91, 1813.91, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-25T05:26:13-03:00'::timestamp with time zone,
  '2026-08-25T05:26:13-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  175, 1054315166, 'payment_in',
  143999.99, 143135.99, -864.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'EL KEROSENERO SA',
  'CUIT',
  '30717165078',
  '2026-08-24T13:52:45-03:00'::timestamp with time zone,
  '2026-08-24T13:52:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  176, 1054315166, 'payment_in',
  300000.00, 298200.00, -1800.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'freddy',
  'CUIT',
  '23943241759',
  '2026-08-24T12:52:09-03:00'::timestamp with time zone,
  '2026-08-24T12:52:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  177, 1054315166, 'yield',
  2611.86, 2611.86, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-24T03:58:38-03:00'::timestamp with time zone,
  '2026-08-24T03:58:38-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  178, 1054315166, 'payment_out',
  -90003.00, -90543.02, -540.02,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-23T18:12:57-03:00'::timestamp with time zone,
  '2026-08-23T18:12:57-03:00'::timestamp with time zone,
  '43884407372',
  '147720461',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  179, 1054315166, 'payment_out',
  -100000.00, -100600.00, -600.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-23T17:34:52-03:00'::timestamp with time zone,
  '2026-08-23T17:34:53-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  180, 1054315166, 'payment_out',
  -51728.29, -52038.66, -310.37,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-23T08:23:17-03:00'::timestamp with time zone,
  '2026-08-23T08:23:17-03:00'::timestamp with time zone,
  '43872294938',
  '37c85e84-8688-4bd3-b73d-d7630cffb13d',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  181, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maria Daniela Damboria',
  'CUIT',
  '27181245374',
  '2026-08-22T17:18:23-03:00'::timestamp with time zone,
  '2026-08-22T17:18:23-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  182, 1054315166, 'payment_in',
  156000.00, 155064.00, -936.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Choque Casimiro Riquelme',
  'CUIL',
  '20943603309',
  '2026-08-22T15:58:11-03:00'::timestamp with time zone,
  '2026-08-22T15:58:11-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  183, 1054315166, 'payment_in',
  36000.00, 35784.00, -216.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'terminal kiosco',
  'CUIT',
  '20256738326',
  '2026-08-22T15:02:04-03:00'::timestamp with time zone,
  '2026-08-22T15:02:05-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  184, 1054315166, 'payment_in',
  24000.00, 23856.00, -144.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lorena Moreno',
  'CUIL',
  '27298983279',
  '2026-08-22T14:56:00-03:00'::timestamp with time zone,
  '2026-08-22T14:56:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  185, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIA GABRIELA DELGADO',
  'CUIT',
  '27165792934',
  '2026-08-22T14:17:48-03:00'::timestamp with time zone,
  '2026-08-22T14:17:48-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  186, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'claudia alejandra villar',
  'CUIL',
  '23216180844',
  '2026-08-22T13:58:19-03:00'::timestamp with time zone,
  '2026-08-22T13:58:20-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  187, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lic Lorena Canteros',
  'CUIT',
  '27285107003',
  '2026-08-22T13:42:01-03:00'::timestamp with time zone,
  '2026-08-22T13:42:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  188, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T13:40:15-03:00'::timestamp with time zone,
  '2026-08-22T13:40:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127503821875'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  189, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'MIRIAM GRACIELA BARILA',
  'CUIT',
  '23179895684',
  '2026-08-22T13:38:48-03:00'::timestamp with time zone,
  '2026-08-22T13:38:50-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127589011654'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  190, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Silvia Ines Santos',
  'CUIL',
  '23148133514',
  '2026-08-22T13:33:57-03:00'::timestamp with time zone,
  '2026-08-22T13:33:57-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  191, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SERGIO ADRIAN PUGLIESE',
  'CUIT',
  '23264017629',
  '2026-08-22T13:33:34-03:00'::timestamp with time zone,
  '2026-08-22T13:33:34-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  192, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Pablo Palermiti',
  'CUIL',
  '20346083485',
  '2026-08-22T13:24:28-03:00'::timestamp with time zone,
  '2026-08-22T13:24:28-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  193, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Romina Manquelef',
  'CUIL',
  '27351636101',
  '2026-08-22T13:22:51-03:00'::timestamp with time zone,
  '2026-08-22T13:22:52-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  194, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ADRIAN ANTONIO RASQUELA',
  'CUIT',
  '20297260090',
  '2026-08-22T13:22:18-03:00'::timestamp with time zone,
  '2026-08-22T13:22:18-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  195, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Rodri',
  'CUIL',
  '20395858204',
  '2026-08-22T13:21:09-03:00'::timestamp with time zone,
  '2026-08-22T13:21:10-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  196, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'VIVIANA EDITH BREIDE',
  'CUIT',
  '27141690847',
  '2026-08-22T13:16:36-03:00'::timestamp with time zone,
  '2026-08-22T13:16:37-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  197, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'adrianazuñiga',
  'CUIT',
  '27162218315',
  '2026-08-22T13:14:47-03:00'::timestamp with time zone,
  '2026-08-22T13:14:47-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  198, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'adriana ruiz',
  'CUIT',
  '27165901660',
  '2026-08-22T13:14:22-03:00'::timestamp with time zone,
  '2026-08-22T13:14:23-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  199, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Alphaville',
  'CUIT',
  '23275168149',
  '2026-08-22T13:12:39-03:00'::timestamp with time zone,
  '2026-08-22T13:12:40-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  200, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Florencia Jakimczuk',
  'CUIL',
  '27317948196',
  '2026-08-22T13:12:39-03:00'::timestamp with time zone,
  '2026-08-22T13:12:39-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  201, 1054315166, 'transfer_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T13:10:44-03:00'::timestamp with time zone,
  '2026-08-22T13:10:44-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127502846301'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  202, 1054315166, 'transfer_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T13:10:40-03:00'::timestamp with time zone,
  '2026-08-22T13:10:40-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127502823261'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  203, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ANTONELLA MIRENGHI',
  'CUIT',
  '27334167335',
  '2026-08-22T13:09:03-03:00'::timestamp with time zone,
  '2026-08-22T13:09:04-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  204, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Eliana Melivilo',
  'CUIT',
  '27343312852',
  '2026-08-22T13:07:00-03:00'::timestamp with time zone,
  '2026-08-22T13:07:00-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  205, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'pedrohgalceran',
  'CUIT',
  '20125494189',
  '2026-08-22T13:05:44-03:00'::timestamp with time zone,
  '2026-08-22T13:05:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127502645505'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  206, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Micaela Zunzunegui',
  'CUIT',
  '27350586534',
  '2026-08-22T13:04:02-03:00'::timestamp with time zone,
  '2026-08-22T13:04:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  207, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'viaje',
  'CUIT',
  '27206894852',
  '2026-08-22T13:03:40-03:00'::timestamp with time zone,
  '2026-08-22T13:03:41-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  208, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'VALERIA VENTURA',
  'CUIT',
  '27185652993',
  '2026-08-22T12:59:37-03:00'::timestamp with time zone,
  '2026-08-22T12:59:37-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  209, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T12:57:44-03:00'::timestamp with time zone,
  '2026-08-22T12:57:44-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127587575938'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  210, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Julio Lavezzo',
  'CUIL',
  '20350589881',
  '2026-08-22T12:52:46-03:00'::timestamp with time zone,
  '2026-08-22T12:52:47-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  211, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T12:52:31-03:00'::timestamp with time zone,
  '2026-08-22T12:52:31-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127502176665'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  212, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Sol   Roa',
  'CUIL',
  '27190489642',
  '2026-08-22T12:49:12-03:00'::timestamp with time zone,
  '2026-08-22T12:49:12-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  213, 1054315166, 'transfer_in',
  18000.00, 17892.00, -108.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Diego Sacchetti',
  'CUIT',
  '20209210674',
  '2026-08-22T12:46:24-03:00'::timestamp with time zone,
  '2026-08-22T12:46:26-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127587169216'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  214, 1054315166, 'payment_in',
  18000.00, 17892.00, -108.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SERGIO DANIEL CAMPOS',
  'CUIT',
  '20246567205',
  '2026-08-22T12:45:25-03:00'::timestamp with time zone,
  '2026-08-22T12:45:25-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  215, 1054315166, 'transfer_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T12:43:21-03:00'::timestamp with time zone,
  '2026-08-22T12:43:21-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127501815581'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  216, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Helmer Sandro Calvo',
  'CUIL',
  '20165901402',
  '2026-08-22T12:42:45-03:00'::timestamp with time zone,
  '2026-08-22T12:42:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  217, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Paula Pabletich',
  'CUIL',
  '27281198896',
  '2026-08-22T12:41:59-03:00'::timestamp with time zone,
  '2026-08-22T12:42:00-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  218, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Gabriel Linares',
  'CUIT',
  '20320495629',
  '2026-08-22T12:35:55-03:00'::timestamp with time zone,
  '2026-08-22T12:35:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  219, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARCELO ALEJANDRO BELLINI CURZ',
  'CUIT',
  '20230698830',
  '2026-08-22T12:35:55-03:00'::timestamp with time zone,
  '2026-08-22T12:35:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  220, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T12:34:45-03:00'::timestamp with time zone,
  '2026-08-22T12:34:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127586738880'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  221, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Sandra Mary Salazar Aguilar',
  'CUIT',
  '27188832364',
  '2026-08-22T12:30:30-03:00'::timestamp with time zone,
  '2026-08-22T12:30:30-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  222, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Las flias',
  'CUIT',
  '27286776960',
  '2026-08-22T12:27:28-03:00'::timestamp with time zone,
  '2026-08-22T12:27:29-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  223, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Diana Silvia Atri',
  'CUIL',
  '27174745035',
  '2026-08-22T12:26:50-03:00'::timestamp with time zone,
  '2026-08-22T12:26:51-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  224, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Sol',
  'CUIL',
  '27166447734',
  '2026-08-22T12:25:54-03:00'::timestamp with time zone,
  '2026-08-22T12:25:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  225, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ana kern',
  'CUIT',
  '27062661564',
  '2026-08-22T12:25:08-03:00'::timestamp with time zone,
  '2026-08-22T12:25:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  226, 1054315166, 'transfer_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T12:25:03-03:00'::timestamp with time zone,
  '2026-08-22T12:25:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127586359770'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  227, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Silvia Mabel Calvo',
  'CUIL',
  '27171357913',
  '2026-08-22T12:22:42-03:00'::timestamp with time zone,
  '2026-08-22T12:22:42-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  228, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GUILLERMO ARIEL GIANNI',
  'CUIL',
  '23230697779',
  '2026-08-22T12:22:20-03:00'::timestamp with time zone,
  '2026-08-22T12:22:21-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  229, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Oscar Grela',
  'CUIT',
  '20293179213',
  '2026-08-22T12:22:15-03:00'::timestamp with time zone,
  '2026-08-22T12:22:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  230, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Laurapaillalef ',
  'CUIT',
  '27363026724',
  '2026-08-22T12:20:20-03:00'::timestamp with time zone,
  '2026-08-22T12:20:21-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  231, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PEDRO HERRERA',
  'CUIL',
  '20250118458',
  '2026-08-22T12:19:18-03:00'::timestamp with time zone,
  '2026-08-22T12:19:18-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  232, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Antonella Chavez',
  'CUIL',
  '27363026295',
  '2026-08-22T12:18:48-03:00'::timestamp with time zone,
  '2026-08-22T12:18:48-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  233, 1054315166, 'transfer_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T12:16:58-03:00'::timestamp with time zone,
  '2026-08-22T12:16:58-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127500852259'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  234, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'BIANCA MOLINI',
  'CUIT',
  '27364976815',
  '2026-08-22T12:12:08-03:00'::timestamp with time zone,
  '2026-08-22T12:12:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  235, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Laureana Laurido',
  'CUIL',
  '27372133657',
  '2026-08-22T12:07:45-03:00'::timestamp with time zone,
  '2026-08-22T12:07:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  236, 1054315166, 'transfer_in',
  10000.00, 9940.00, -60.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T12:05:07-03:00'::timestamp with time zone,
  '2026-08-22T12:05:07-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127500410269'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  237, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Paola',
  'CUIL',
  '27317717666',
  '2026-08-22T11:58:51-03:00'::timestamp with time zone,
  '2026-08-22T11:58:51-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  238, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Alejandro Ferrara',
  'CUIT',
  '20305560112',
  '2026-08-22T11:53:08-03:00'::timestamp with time zone,
  '2026-08-22T11:53:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  239, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T11:52:02-03:00'::timestamp with time zone,
  '2026-08-22T11:52:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127585121846'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  240, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Pablo Epuñan',
  'CUIL',
  '20330026716',
  '2026-08-22T11:51:47-03:00'::timestamp with time zone,
  '2026-08-22T11:51:47-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  241, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T11:49:03-03:00'::timestamp with time zone,
  '2026-08-22T11:49:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127499820299'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  242, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'digital_currency',
  'consumer_credits',
  'Beja productos de la colmena',
  'CUIT',
  '20306088581',
  '2026-08-22T11:48:10-03:00'::timestamp with time zone,
  '2026-08-22T11:48:11-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  243, 1054315166, 'transfer_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T11:43:44-03:00'::timestamp with time zone,
  '2026-08-22T11:43:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127584848330'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  244, 1054315166, 'transfer_in',
  3500.00, 3479.00, -21.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T11:38:11-03:00'::timestamp with time zone,
  '2026-08-22T11:38:11-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127584650460'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  245, 1054315166, 'payment_in',
  18000.00, 17892.00, -108.00,
  NULL, 0.6000,
  'credit_card',
  'master',
  'gustavo franchello',
  'CUIT',
  '23230639019',
  '2026-08-22T11:37:53-03:00'::timestamp with time zone,
  '2026-08-22T11:37:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  246, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Javier sanchez',
  'CUIT',
  '20327948572',
  '2026-08-22T11:36:25-03:00'::timestamp with time zone,
  '2026-08-22T11:36:25-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  247, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Eladio Marifili',
  'CUIL',
  '20259292248',
  '2026-08-22T11:35:21-03:00'::timestamp with time zone,
  '2026-08-22T11:35:21-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  248, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'VERONICA PAULA VENTURA',
  'CUIT',
  '27223642824',
  '2026-08-22T11:32:17-03:00'::timestamp with time zone,
  '2026-08-22T11:32:17-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  249, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Fabiana Arias Valla',
  'CUIL',
  '27227309518',
  '2026-08-22T11:30:30-03:00'::timestamp with time zone,
  '2026-08-22T11:30:31-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  250, 1054315166, 'transfer_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T11:28:34-03:00'::timestamp with time zone,
  '2026-08-22T11:28:34-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127499100631'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  251, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lavarropa',
  'CUIT',
  '27306089760',
  '2026-08-22T11:27:22-03:00'::timestamp with time zone,
  '2026-08-22T11:27:22-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  252, 1054315166, 'payment_in',
  12500.00, 12425.00, -75.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Nicole Bari ',
  'CUIT',
  '27397438525',
  '2026-08-22T11:25:44-03:00'::timestamp with time zone,
  '2026-08-22T11:25:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  253, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Juan Villegas',
  'CUIT',
  '20231600648',
  '2026-08-22T11:25:38-03:00'::timestamp with time zone,
  '2026-08-22T11:25:38-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  254, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Sabana',
  'CUIL',
  '27298980857',
  '2026-08-22T11:24:18-03:00'::timestamp with time zone,
  '2026-08-22T11:24:19-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  255, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'agencia recaudacion tributaria',
  'CUIT',
  '20179895790',
  '2026-08-22T11:21:24-03:00'::timestamp with time zone,
  '2026-08-22T11:21:25-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  256, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Wilson Abeiro',
  'CUIT',
  '20320495688',
  '2026-08-22T11:20:50-03:00'::timestamp with time zone,
  '2026-08-22T11:20:50-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  257, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mario juaquin Urrutia',
  'CUIL',
  '20161914240',
  '2026-08-22T11:20:09-03:00'::timestamp with time zone,
  '2026-08-22T11:20:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  258, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SERGIO DANIEL CASTRILLO',
  'CUIL',
  '20218780955',
  '2026-08-22T11:18:35-03:00'::timestamp with time zone,
  '2026-08-22T11:18:35-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  259, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'victoria',
  'CUIL',
  '27323621999',
  '2026-08-22T11:10:40-03:00'::timestamp with time zone,
  '2026-08-22T11:10:41-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  260, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'paola marcel',
  'CUIL',
  '27241346973',
  '2026-08-22T11:06:18-03:00'::timestamp with time zone,
  '2026-08-22T11:06:19-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  261, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'CLEMENTE ARAMENDI',
  'CUIT',
  '20176938022',
  '2026-08-22T11:04:32-03:00'::timestamp with time zone,
  '2026-08-22T11:04:33-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  262, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PAULA RODRIGUEZ FRANDSEN',
  'CUIT',
  '27267095642',
  '2026-08-22T11:04:25-03:00'::timestamp with time zone,
  '2026-08-22T11:04:26-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  263, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIO DANIEL LORCA',
  'CUIT',
  '20207504549',
  '2026-08-22T11:03:00-03:00'::timestamp with time zone,
  '2026-08-22T11:03:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  264, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'QuieroFrutillas',
  'CUIT',
  '27206901050',
  '2026-08-22T11:00:58-03:00'::timestamp with time zone,
  '2026-08-22T11:00:58-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  265, 1054315166, 'payment_in',
  12500.00, 12425.00, -75.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'DIEGO HERNAN FRIAS',
  'CUIT',
  '20324972596',
  '2026-08-22T11:00:16-03:00'::timestamp with time zone,
  '2026-08-22T11:00:17-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  266, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Humberto Gattas',
  'CUIT',
  '20927867517',
  '2026-08-22T10:58:41-03:00'::timestamp with time zone,
  '2026-08-22T10:58:41-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  267, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Juan Andres Ruf',
  'CUIT',
  '23231308199',
  '2026-08-22T10:57:06-03:00'::timestamp with time zone,
  '2026-08-22T10:57:06-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  268, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maria Fuentes',
  'CUIL',
  '27241660953',
  '2026-08-22T10:54:33-03:00'::timestamp with time zone,
  '2026-08-22T10:54:34-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  269, 1054315166, 'transfer_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T10:54:12-03:00'::timestamp with time zone,
  '2026-08-22T10:54:13-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127497992243'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  270, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maria Gabriela Kunisch',
  'CUIL',
  '27401107989',
  '2026-08-22T10:53:27-03:00'::timestamp with time zone,
  '2026-08-22T10:53:27-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  271, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Fede',
  'CUIT',
  '20383523606',
  '2026-08-22T10:52:49-03:00'::timestamp with time zone,
  '2026-08-22T10:52:49-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  272, 1054315166, 'transfer_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T10:51:22-03:00'::timestamp with time zone,
  '2026-08-22T10:51:22-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127583109070'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  273, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lorena Acosta',
  'CUIT',
  '27247125294',
  '2026-08-22T10:46:21-03:00'::timestamp with time zone,
  '2026-08-22T10:46:21-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  274, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'NATALIA YAMILA GOMEZ',
  'CUIL',
  '27337291169',
  '2026-08-22T10:43:38-03:00'::timestamp with time zone,
  '2026-08-22T10:43:38-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  275, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lorenzo Mora',
  'CUIT',
  '20310633950',
  '2026-08-22T10:42:49-03:00'::timestamp with time zone,
  '2026-08-22T10:42:50-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  276, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Nai',
  'CUIL',
  '27425390932',
  '2026-08-22T10:41:12-03:00'::timestamp with time zone,
  '2026-08-22T10:41:13-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  277, 1054315166, 'payment_in',
  13500.00, 13419.00, -81.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'lorena hughes',
  'CUIL',
  '27247942233',
  '2026-08-22T10:40:55-03:00'::timestamp with time zone,
  '2026-08-22T10:40:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  278, 1054315166, 'transfer_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T10:35:21-03:00'::timestamp with time zone,
  '2026-08-22T10:35:21-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127497421001'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  279, 1054315166, 'payment_in',
  39000.00, 38766.00, -234.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Matias Margiotta',
  'CUIL',
  '20298982626',
  '2026-08-22T10:32:52-03:00'::timestamp with time zone,
  '2026-08-22T10:32:52-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  280, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Informe Carlos Fischer ',
  'CUIT',
  '20177662535',
  '2026-08-22T10:31:51-03:00'::timestamp with time zone,
  '2026-08-22T10:31:51-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  281, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ignacio Jns',
  'CUIT',
  '20359699396',
  '2026-08-22T10:31:31-03:00'::timestamp with time zone,
  '2026-08-22T10:31:31-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  282, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'sergio zucal',
  'CUIT',
  '20173383658',
  '2026-08-22T10:30:50-03:00'::timestamp with time zone,
  '2026-08-22T10:30:50-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  283, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Pasionarte',
  'CUIT',
  '27267948653',
  '2026-08-22T10:26:42-03:00'::timestamp with time zone,
  '2026-08-22T10:26:43-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  284, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T10:24:53-03:00'::timestamp with time zone,
  '2026-08-22T10:24:54-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127497128897'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  285, 1054315166, 'payment_in',
  39000.00, 38766.00, -234.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Julio Argentino Morales',
  'CUIT',
  '20227308606',
  '2026-08-22T10:24:52-03:00'::timestamp with time zone,
  '2026-08-22T10:24:52-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  286, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'HUMBERTO GERARDO COLOMBO',
  'CUIT',
  '23138236439',
  '2026-08-22T10:22:57-03:00'::timestamp with time zone,
  '2026-08-22T10:22:57-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  287, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'alejandro coleffi',
  'CUIL',
  '20168625503',
  '2026-08-22T10:21:34-03:00'::timestamp with time zone,
  '2026-08-22T10:21:34-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  288, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SOLEDAD MARGOT CECCHINI',
  'CUIL',
  '27295049583',
  '2026-08-22T10:21:07-03:00'::timestamp with time zone,
  '2026-08-22T10:21:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  289, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T10:20:55-03:00'::timestamp with time zone,
  '2026-08-22T10:20:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127582237098'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  290, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'WALTER RIERA',
  'CUIT',
  '20164403182',
  '2026-08-22T10:16:10-03:00'::timestamp with time zone,
  '2026-08-22T10:16:10-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  291, 1054315166, 'transfer_in',
  19500.00, 19383.00, -117.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T10:14:11-03:00'::timestamp with time zone,
  '2026-08-22T10:14:11-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127496852531'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  292, 1054315166, 'payment_in',
  3500.00, 3479.00, -21.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Claudia Olga Martinez',
  'CUIL',
  '27227308422',
  '2026-08-22T10:13:30-03:00'::timestamp with time zone,
  '2026-08-22T10:13:30-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  293, 1054315166, 'payment_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Gladis Toscano',
  'CUIL',
  '27240058451',
  '2026-08-22T10:12:56-03:00'::timestamp with time zone,
  '2026-08-22T10:12:57-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  294, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T10:12:07-03:00'::timestamp with time zone,
  '2026-08-22T10:12:07-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127496792851'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  295, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maria Pia Vidussi',
  'CUIT',
  '27276248885',
  '2026-08-22T10:11:30-03:00'::timestamp with time zone,
  '2026-08-22T10:11:30-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  296, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PABLO VERA',
  'CUIT',
  '20290890315',
  '2026-08-22T10:07:09-03:00'::timestamp with time zone,
  '2026-08-22T10:07:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  297, 1054315166, 'payment_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Diego',
  'CUIT',
  '20277865964',
  '2026-08-22T10:05:37-03:00'::timestamp with time zone,
  '2026-08-22T10:05:37-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  298, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Pablo Dalponte',
  'CUIL',
  '20296219348',
  '2026-08-22T10:04:44-03:00'::timestamp with time zone,
  '2026-08-22T10:04:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  299, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T10:03:42-03:00'::timestamp with time zone,
  '2026-08-22T10:03:42-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127496564915'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  300, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Cueros GM',
  'CUIL',
  '27161997183',
  '2026-08-22T10:03:37-03:00'::timestamp with time zone,
  '2026-08-22T10:03:37-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
