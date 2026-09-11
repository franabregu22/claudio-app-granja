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
  1, 1054315166, 'payment_in',
  234000.00, 232596.00, -1404.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Autoservicio ailen ',
  'CUIT',
  '20339867012',
  '2026-08-31T19:23:44-03:00'::timestamp with time zone,
  '2026-08-31T19:23:45-03:00'::timestamp with time zone,
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
  2, 1054315166, 'payment_in',
  39000.00, 38766.00, -234.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Matias Margiotta',
  'CUIL',
  '20298982626',
  '2026-08-31T12:53:21-03:00'::timestamp with time zone,
  '2026-08-31T12:53:22-03:00'::timestamp with time zone,
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
  3, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'miel el jarillal',
  'CUIT',
  '20248763427',
  '2026-08-31T10:57:39-03:00'::timestamp with time zone,
  '2026-08-31T10:57:40-03:00'::timestamp with time zone,
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
  4, 1054315166, 'payment_in',
  36000.00, 35784.00, -216.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'La casa de Carlos ',
  'CUIT',
  '20109920968',
  '2026-08-31T10:28:23-03:00'::timestamp with time zone,
  '2026-08-31T10:28:24-03:00'::timestamp with time zone,
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
  5, 1054315166, 'yield',
  5872.14, 5872.14, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-31T03:32:33-03:00'::timestamp with time zone,
  '2026-08-31T03:32:33-03:00'::timestamp with time zone,
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
  6, 1054315166, 'payment_out',
  -100000.00, -100600.00, -600.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-29T19:29:42-03:00'::timestamp with time zone,
  '2026-08-29T19:29:42-03:00'::timestamp with time zone,
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
  7, 1054315166, 'payment_out',
  -172000.00, -173032.00, -1032.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-29T19:29:09-03:00'::timestamp with time zone,
  '2026-08-29T19:29:10-03:00'::timestamp with time zone,
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
  8, 1054315166, 'payment_in',
  156000.00, 155064.00, -936.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Choque Casimiro Riquelme',
  'CUIL',
  '20943603309',
  '2026-08-29T14:30:33-03:00'::timestamp with time zone,
  '2026-08-29T14:30:34-03:00'::timestamp with time zone,
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
  9, 1054315166, 'payment_in',
  39000.00, 38766.00, -234.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'LAURA INES CAUCOTA FERNANDEZ',
  'CUIT',
  '27942460118',
  '2026-08-29T14:28:55-03:00'::timestamp with time zone,
  '2026-08-29T14:28:55-03:00'::timestamp with time zone,
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
  10, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'STELLA MARIS APARICIO',
  'CUIT',
  '27066884258',
  '2026-08-29T13:56:09-03:00'::timestamp with time zone,
  '2026-08-29T13:56:10-03:00'::timestamp with time zone,
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
  11, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Silvia Nieto',
  'CUIT',
  '27281938237',
  '2026-08-29T13:52:11-03:00'::timestamp with time zone,
  '2026-08-29T13:52:11-03:00'::timestamp with time zone,
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
  12, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SERGIO RUBEN GIANNI',
  'CUIT',
  '20207504468',
  '2026-08-29T13:43:16-03:00'::timestamp with time zone,
  '2026-08-29T13:43:17-03:00'::timestamp with time zone,
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
  13, 1054315166, 'transfer_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'MARIA JOSE ROMAN',
  'CUIL',
  '27232702600',
  '2026-08-29T13:36:19-03:00'::timestamp with time zone,
  '2026-08-29T13:36:23-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127787036590'
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
  14, 1054315166, 'transfer_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T13:34:17-03:00'::timestamp with time zone,
  '2026-08-29T13:34:17-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127786939498'
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
  15, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIA ALEJANDRA PEÑA',
  'CUIL',
  '27394038410',
  '2026-08-29T13:29:16-03:00'::timestamp with time zone,
  '2026-08-29T13:29:16-03:00'::timestamp with time zone,
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
  16, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T13:21:07-03:00'::timestamp with time zone,
  '2026-08-29T13:21:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127700813849'
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
  17, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T13:15:58-03:00'::timestamp with time zone,
  '2026-08-29T13:15:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127786298746'
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
  18, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'alicia rickert',
  'CUIL',
  '27178245681',
  '2026-08-29T13:15:50-03:00'::timestamp with time zone,
  '2026-08-29T13:15:50-03:00'::timestamp with time zone,
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
  19, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Federic11',
  'CUIL',
  '20463291587',
  '2026-08-29T13:14:29-03:00'::timestamp with time zone,
  '2026-08-29T13:14:30-03:00'::timestamp with time zone,
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
  20, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T13:14:26-03:00'::timestamp with time zone,
  '2026-08-29T13:14:27-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127786240852'
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
  21, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ULISES DANIEL BELIU',
  'CUIT',
  '20368499006',
  '2026-08-29T13:11:56-03:00'::timestamp with time zone,
  '2026-08-29T13:11:57-03:00'::timestamp with time zone,
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
  22, 1054315166, 'payment_in',
  3500.00, 3479.00, -21.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lic Lorena Canteros',
  'CUIT',
  '27285107003',
  '2026-08-29T13:04:40-03:00'::timestamp with time zone,
  '2026-08-29T13:04:41-03:00'::timestamp with time zone,
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
  23, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'LILIANA ELIZABETH WALTER',
  'CUIT',
  '27240937501',
  '2026-08-29T13:03:31-03:00'::timestamp with time zone,
  '2026-08-29T13:03:31-03:00'::timestamp with time zone,
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
  24, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Beto Trom',
  'CUIL',
  '24313200074',
  '2026-08-29T13:02:43-03:00'::timestamp with time zone,
  '2026-08-29T13:02:43-03:00'::timestamp with time zone,
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
  25, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Paula Crespo',
  'CUIT',
  '27298981470',
  '2026-08-29T12:56:44-03:00'::timestamp with time zone,
  '2026-08-29T12:56:45-03:00'::timestamp with time zone,
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
  26, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Africa accesorios',
  'CUIT',
  '27338972607',
  '2026-08-29T12:53:43-03:00'::timestamp with time zone,
  '2026-08-29T12:53:43-03:00'::timestamp with time zone,
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
  27, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'silvia martinez',
  'CUIL',
  '27297260400',
  '2026-08-29T12:52:32-03:00'::timestamp with time zone,
  '2026-08-29T12:52:33-03:00'::timestamp with time zone,
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
  28, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GUSTAVO OYOLA',
  'CUIT',
  '20252528564',
  '2026-08-29T12:50:30-03:00'::timestamp with time zone,
  '2026-08-29T12:50:31-03:00'::timestamp with time zone,
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
  29, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'EDUARDO ALFREDO MOSER',
  'CUIT',
  '20244374221',
  '2026-08-29T12:49:20-03:00'::timestamp with time zone,
  '2026-08-29T12:49:20-03:00'::timestamp with time zone,
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
  30, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Nicole Bari ',
  'CUIT',
  '27397438525',
  '2026-08-29T12:49:03-03:00'::timestamp with time zone,
  '2026-08-29T12:49:04-03:00'::timestamp with time zone,
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
  31, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ARASELI CAROLINA PANETTA',
  'CUIT',
  '27232702325',
  '2026-08-29T12:47:50-03:00'::timestamp with time zone,
  '2026-08-29T12:47:51-03:00'::timestamp with time zone,
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
  32, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'VILMA ESTHER CASTILLO',
  'CUIT',
  '27180954169',
  '2026-08-29T12:45:18-03:00'::timestamp with time zone,
  '2026-08-29T12:45:19-03:00'::timestamp with time zone,
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
  33, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Nuria Teresa Anahi Cordoba',
  'CUIL',
  '27320542273',
  '2026-08-29T12:42:32-03:00'::timestamp with time zone,
  '2026-08-29T12:42:33-03:00'::timestamp with time zone,
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
  34, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Fernando Schroh',
  'CUIT',
  '20235273870',
  '2026-08-29T12:41:42-03:00'::timestamp with time zone,
  '2026-08-29T12:41:43-03:00'::timestamp with time zone,
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
  35, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maira Erica',
  'CUIT',
  '27335306479',
  '2026-08-29T12:38:43-03:00'::timestamp with time zone,
  '2026-08-29T12:38:44-03:00'::timestamp with time zone,
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
  36, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Fernando Ruiz',
  'CUIT',
  '20167866841',
  '2026-08-29T12:36:24-03:00'::timestamp with time zone,
  '2026-08-29T12:36:24-03:00'::timestamp with time zone,
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
  37, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ALEJANDRA GLADYS DELGADO',
  'CUIT',
  '27171359959',
  '2026-08-29T12:35:59-03:00'::timestamp with time zone,
  '2026-08-29T12:36:00-03:00'::timestamp with time zone,
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
  38, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lucia',
  'CUIL',
  '27346084117',
  '2026-08-29T12:35:30-03:00'::timestamp with time zone,
  '2026-08-29T12:35:30-03:00'::timestamp with time zone,
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
  39, 1054315166, 'payment_in',
  3500.00, 3479.00, -21.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Sergio Vechiati',
  'CUIT',
  '20130941363',
  '2026-08-29T12:35:11-03:00'::timestamp with time zone,
  '2026-08-29T12:35:12-03:00'::timestamp with time zone,
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
  40, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T12:34:54-03:00'::timestamp with time zone,
  '2026-08-29T12:34:54-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127784730950'
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
  41, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T12:34:08-03:00'::timestamp with time zone,
  '2026-08-29T12:34:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127699045107'
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
  42, 1054315166, 'transfer_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T12:32:54-03:00'::timestamp with time zone,
  '2026-08-29T12:32:54-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127698991187'
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
  43, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T12:32:37-03:00'::timestamp with time zone,
  '2026-08-29T12:32:38-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127784650434'
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
  44, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T12:31:24-03:00'::timestamp with time zone,
  '2026-08-29T12:31:24-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127698948373'
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
  45, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T12:31:11-03:00'::timestamp with time zone,
  '2026-08-29T12:31:11-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127698915973'
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
  46, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Roberto Carlos Tarifeño Molina',
  'CUIT',
  '20188292748',
  '2026-08-29T12:31:03-03:00'::timestamp with time zone,
  '2026-08-29T12:31:04-03:00'::timestamp with time zone,
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
  47, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Carolina Serra',
  'CUIL',
  '27290556010',
  '2026-08-29T12:28:16-03:00'::timestamp with time zone,
  '2026-08-29T12:28:17-03:00'::timestamp with time zone,
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
  48, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Rosana Paola Fondrini',
  'CUIL',
  '27230971485',
  '2026-08-29T12:26:44-03:00'::timestamp with time zone,
  '2026-08-29T12:26:44-03:00'::timestamp with time zone,
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
  49, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'credit_card',
  'amex',
  'CARLOS ALBERTO ANTENAO',
  'CUIT',
  '20161648796',
  '2026-08-29T12:25:16-03:00'::timestamp with time zone,
  '2026-08-29T12:25:17-03:00'::timestamp with time zone,
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
  50, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mabel Monica Lopez',
  'CUIT',
  '27308789069',
  '2026-08-29T12:23:00-03:00'::timestamp with time zone,
  '2026-08-29T12:23:01-03:00'::timestamp with time zone,
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
  51, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'STELLA MARIS COLLADO',
  'CUIL',
  '27144369373',
  '2026-08-29T12:21:16-03:00'::timestamp with time zone,
  '2026-08-29T12:21:16-03:00'::timestamp with time zone,
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
  52, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Juan Castro',
  'CUIT',
  '20314218990',
  '2026-08-29T12:15:32-03:00'::timestamp with time zone,
  '2026-08-29T12:15:32-03:00'::timestamp with time zone,
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
  53, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Yonii Navarro',
  'CUIL',
  '23376946509',
  '2026-08-29T12:15:12-03:00'::timestamp with time zone,
  '2026-08-29T12:15:13-03:00'::timestamp with time zone,
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
  54, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Adrian Torrillas',
  'CUIT',
  '20243634661',
  '2026-08-29T12:14:20-03:00'::timestamp with time zone,
  '2026-08-29T12:14:21-03:00'::timestamp with time zone,
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
  55, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Antonio Alfredo Gimenez',
  'CUIL',
  '20138235956',
  '2026-08-29T12:12:37-03:00'::timestamp with time zone,
  '2026-08-29T12:12:37-03:00'::timestamp with time zone,
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
  56, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Clara Redondo',
  'CUIT',
  '27217325248',
  '2026-08-29T12:11:24-03:00'::timestamp with time zone,
  '2026-08-29T12:11:24-03:00'::timestamp with time zone,
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
  57, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'hgcbaefd fcbgahde',
  'CUIT',
  '20271130865',
  '2026-08-29T12:07:45-03:00'::timestamp with time zone,
  '2026-08-29T12:07:45-03:00'::timestamp with time zone,
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
  58, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Adriana Carrasco',
  'CUIL',
  '27207574827',
  '2026-08-29T12:07:42-03:00'::timestamp with time zone,
  '2026-08-29T12:07:43-03:00'::timestamp with time zone,
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
  59, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Chino',
  'CUIL',
  '20447166144',
  '2026-08-29T12:06:53-03:00'::timestamp with time zone,
  '2026-08-29T12:06:54-03:00'::timestamp with time zone,
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
  60, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'NIDIA MARGOTT LOBOS FRANCO',
  'CUIT',
  '27188081547',
  '2026-08-29T12:06:38-03:00'::timestamp with time zone,
  '2026-08-29T12:06:38-03:00'::timestamp with time zone,
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
  61, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T12:04:04-03:00'::timestamp with time zone,
  '2026-08-29T12:04:04-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127783507358'
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
  62, 1054315166, 'payment_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mabel Ortiz',
  'CUIT',
  '27175363799',
  '2026-08-29T12:01:35-03:00'::timestamp with time zone,
  '2026-08-29T12:01:36-03:00'::timestamp with time zone,
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
  63, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Carlos Agustin Biondo',
  'CUIL',
  '20447051169',
  '2026-08-29T12:00:32-03:00'::timestamp with time zone,
  '2026-08-29T12:00:33-03:00'::timestamp with time zone,
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
  64, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T12:00:02-03:00'::timestamp with time zone,
  '2026-08-29T12:00:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127697689191'
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
  65, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'RDInd',
  'CUIT',
  '27306491356',
  '2026-08-29T11:56:50-03:00'::timestamp with time zone,
  '2026-08-29T11:56:50-03:00'::timestamp with time zone,
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
  66, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ana Cosmética & Perfumería',
  'CUIL',
  '23278287394',
  '2026-08-29T11:56:25-03:00'::timestamp with time zone,
  '2026-08-29T11:56:26-03:00'::timestamp with time zone,
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
  67, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mauro Tello Dev',
  'CUIT',
  '20230638897',
  '2026-08-29T11:56:25-03:00'::timestamp with time zone,
  '2026-08-29T11:56:25-03:00'::timestamp with time zone,
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
  68, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GUILLERMO ARIEL GIANNI',
  'CUIL',
  '23230697779',
  '2026-08-29T11:54:18-03:00'::timestamp with time zone,
  '2026-08-29T11:54:19-03:00'::timestamp with time zone,
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
  69, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'bucci',
  'CUIT',
  '20322716576',
  '2026-08-29T11:51:34-03:00'::timestamp with time zone,
  '2026-08-29T11:51:35-03:00'::timestamp with time zone,
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
  70, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'EMANUEL SARMIENTO',
  'CUIT',
  '20298983169',
  '2026-08-29T11:50:09-03:00'::timestamp with time zone,
  '2026-08-29T11:50:10-03:00'::timestamp with time zone,
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
  71, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Carlos Agustin Biondo',
  'CUIL',
  '20447051169',
  '2026-08-29T11:49:58-03:00'::timestamp with time zone,
  '2026-08-29T11:49:59-03:00'::timestamp with time zone,
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
  72, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Diego Sacchetti',
  'CUIT',
  '20209210674',
  '2026-08-29T11:49:43-03:00'::timestamp with time zone,
  '2026-08-29T11:49:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127782951314'
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
  73, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Tyy',
  'CUIT',
  '27183055807',
  '2026-08-29T11:47:12-03:00'::timestamp with time zone,
  '2026-08-29T11:47:12-03:00'::timestamp with time zone,
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
  74, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'delfin venancio pardo',
  'CUIT',
  '20138129064',
  '2026-08-29T11:45:50-03:00'::timestamp with time zone,
  '2026-08-29T11:45:51-03:00'::timestamp with time zone,
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
  75, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Gabriela Nieli',
  'CUIT',
  '27317868427',
  '2026-08-29T11:45:50-03:00'::timestamp with time zone,
  '2026-08-29T11:45:50-03:00'::timestamp with time zone,
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
  76, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'la autentica',
  'CUIT',
  '27364977188',
  '2026-08-29T11:45:23-03:00'::timestamp with time zone,
  '2026-08-29T11:45:23-03:00'::timestamp with time zone,
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
  77, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'sonia Sandoval',
  'CUIL',
  '27295840345',
  '2026-08-29T11:42:54-03:00'::timestamp with time zone,
  '2026-08-29T11:42:54-03:00'::timestamp with time zone,
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
  78, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Horacio Segura',
  'CUIT',
  '20250899964',
  '2026-08-29T11:42:45-03:00'::timestamp with time zone,
  '2026-08-29T11:42:46-03:00'::timestamp with time zone,
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
  79, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Marcela Alejandra Poblete',
  'CUIL',
  '27213884366',
  '2026-08-29T11:42:35-03:00'::timestamp with time zone,
  '2026-08-29T11:42:35-03:00'::timestamp with time zone,
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
  80, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Nadia Urrutia',
  'CUIL',
  '23335304764',
  '2026-08-29T11:41:10-03:00'::timestamp with time zone,
  '2026-08-29T11:41:11-03:00'::timestamp with time zone,
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
  81, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'STELLA MARIS RUGGERI',
  'CUIL',
  '27236386754',
  '2026-08-29T11:39:40-03:00'::timestamp with time zone,
  '2026-08-29T11:39:40-03:00'::timestamp with time zone,
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
  82, 1054315166, 'transfer_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T11:39:15-03:00'::timestamp with time zone,
  '2026-08-29T11:39:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127782551192'
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
  83, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'paola marcel',
  'CUIL',
  '27241346973',
  '2026-08-29T11:38:56-03:00'::timestamp with time zone,
  '2026-08-29T11:38:56-03:00'::timestamp with time zone,
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
  84, 1054315166, 'transfer_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T11:38:29-03:00'::timestamp with time zone,
  '2026-08-29T11:38:29-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127696869569'
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
  85, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Cecilia Noemi Castagna',
  'CUIL',
  '23262279774',
  '2026-08-29T11:32:43-03:00'::timestamp with time zone,
  '2026-08-29T11:32:44-03:00'::timestamp with time zone,
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
  86, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T11:32:40-03:00'::timestamp with time zone,
  '2026-08-29T11:32:41-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127782310864'
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
  87, 1054315166, 'payment_in',
  2000.00, 1988.00, -12.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Silvina Montesi',
  'CUIT',
  '27216248797',
  '2026-08-29T11:32:04-03:00'::timestamp with time zone,
  '2026-08-29T11:32:05-03:00'::timestamp with time zone,
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
  88, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Juana',
  'CUIL',
  '27410926542',
  '2026-08-29T11:28:23-03:00'::timestamp with time zone,
  '2026-08-29T11:28:24-03:00'::timestamp with time zone,
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
  89, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'rodriguwz',
  'CUIT',
  '27303397464',
  '2026-08-29T11:22:31-03:00'::timestamp with time zone,
  '2026-08-29T11:22:31-03:00'::timestamp with time zone,
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
  90, 1054315166, 'transfer_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T11:21:03-03:00'::timestamp with time zone,
  '2026-08-29T11:21:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127781869816'
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
  91, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Vicente ',
  'CUIL',
  '20244375821',
  '2026-08-29T11:19:41-03:00'::timestamp with time zone,
  '2026-08-29T11:19:42-03:00'::timestamp with time zone,
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
  92, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Juan',
  'CUIT',
  '20310634752',
  '2026-08-29T11:18:06-03:00'::timestamp with time zone,
  '2026-08-29T11:18:07-03:00'::timestamp with time zone,
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
  93, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Odonto',
  'CUIT',
  '27295089208',
  '2026-08-29T11:15:32-03:00'::timestamp with time zone,
  '2026-08-29T11:15:32-03:00'::timestamp with time zone,
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
  94, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MIRIAM GRACIELA BARILA',
  'CUIT',
  '23179895684',
  '2026-08-29T11:11:46-03:00'::timestamp with time zone,
  '2026-08-29T11:11:46-03:00'::timestamp with time zone,
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
  95, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SERGIO ADRIAN PUGLIESE',
  'CUIT',
  '23264017629',
  '2026-08-29T11:11:32-03:00'::timestamp with time zone,
  '2026-08-29T11:11:33-03:00'::timestamp with time zone,
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
  96, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Liliana Esther Moron',
  'CUIL',
  '27144369942',
  '2026-08-29T11:09:48-03:00'::timestamp with time zone,
  '2026-08-29T11:09:51-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127781479636'
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
  97, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maria Cevoli',
  'CUIT',
  '27241345381',
  '2026-08-29T11:08:37-03:00'::timestamp with time zone,
  '2026-08-29T11:08:38-03:00'::timestamp with time zone,
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
  98, 1054315166, 'transfer_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T11:03:53-03:00'::timestamp with time zone,
  '2026-08-29T11:03:53-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127781277828'
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
  99, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'alejandro coleffi',
  'CUIL',
  '20168625503',
  '2026-08-29T11:02:44-03:00'::timestamp with time zone,
  '2026-08-29T11:02:44-03:00'::timestamp with time zone,
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
  100, 1054315166, 'transfer_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T10:52:03-03:00'::timestamp with time zone,
  '2026-08-29T10:52:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127780902070'
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
  101, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'RAQUEL ESTELA CASTRO',
  'CUIL',
  '27174647785',
  '2026-08-29T10:49:20-03:00'::timestamp with time zone,
  '2026-08-29T10:49:20-03:00'::timestamp with time zone,
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
  102, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T10:45:25-03:00'::timestamp with time zone,
  '2026-08-29T10:45:26-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127695016855'
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
  103, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'silvana sabbadini',
  'CUIT',
  '27200496448',
  '2026-08-29T10:44:32-03:00'::timestamp with time zone,
  '2026-08-29T10:44:33-03:00'::timestamp with time zone,
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
  104, 1054315166, 'payment_in',
  30000.00, 29820.00, -180.00,
  NULL, 0.6000,
  'credit_card',
  'visa',
  'MCPaulao',
  'CUIT',
  '23436704909',
  '2026-08-29T10:42:13-03:00'::timestamp with time zone,
  '2026-08-29T10:42:14-03:00'::timestamp with time zone,
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
  105, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Hugo Alberto Cévoli',
  'CUIT',
  '20115339592',
  '2026-08-29T10:40:44-03:00'::timestamp with time zone,
  '2026-08-29T10:40:45-03:00'::timestamp with time zone,
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
  106, 1054315166, 'payment_in',
  30000.00, 29820.00, -180.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SANDRA GOICOECHEA',
  'CUIT',
  '27175363497',
  '2026-08-29T10:40:44-03:00'::timestamp with time zone,
  '2026-08-29T10:40:44-03:00'::timestamp with time zone,
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
  107, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'HECTOR CROCIATI',
  'CUIT',
  '20082114492',
  '2026-08-29T10:38:46-03:00'::timestamp with time zone,
  '2026-08-29T10:38:47-03:00'::timestamp with time zone,
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
  108, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Europie',
  'CUIT',
  '20355917313',
  '2026-08-29T10:36:31-03:00'::timestamp with time zone,
  '2026-08-29T10:36:31-03:00'::timestamp with time zone,
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
  109, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Eladio Marifili',
  'CUIL',
  '20259292248',
  '2026-08-29T10:36:05-03:00'::timestamp with time zone,
  '2026-08-29T10:36:06-03:00'::timestamp with time zone,
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
  110, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'alicia damonte',
  'CUIT',
  '27207502745',
  '2026-08-29T10:31:14-03:00'::timestamp with time zone,
  '2026-08-29T10:31:15-03:00'::timestamp with time zone,
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
  111, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Claudia Olga Martinez',
  'CUIL',
  '27227308422',
  '2026-08-29T10:29:14-03:00'::timestamp with time zone,
  '2026-08-29T10:29:15-03:00'::timestamp with time zone,
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
  112, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'sergio zucal',
  'CUIT',
  '20173383658',
  '2026-08-29T10:26:02-03:00'::timestamp with time zone,
  '2026-08-29T10:26:02-03:00'::timestamp with time zone,
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
  113, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Karen Moyano',
  'CUIT',
  '27380908692',
  '2026-08-29T10:23:24-03:00'::timestamp with time zone,
  '2026-08-29T10:23:24-03:00'::timestamp with time zone,
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
  114, 1054315166, 'transfer_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T10:21:01-03:00'::timestamp with time zone,
  '2026-08-29T10:21:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127779893818'
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
  115, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'lorena hughes',
  'CUIL',
  '27247942233',
  '2026-08-29T10:20:56-03:00'::timestamp with time zone,
  '2026-08-29T10:20:56-03:00'::timestamp with time zone,
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
  116, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Teresa68',
  'CUIT',
  '23188001424',
  '2026-08-29T10:20:33-03:00'::timestamp with time zone,
  '2026-08-29T10:20:34-03:00'::timestamp with time zone,
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
  117, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Marina Fazolari',
  'CUIT',
  '27396496645',
  '2026-08-29T10:19:47-03:00'::timestamp with time zone,
  '2026-08-29T10:19:47-03:00'::timestamp with time zone,
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
  118, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Alphaville',
  'CUIT',
  '23275168149',
  '2026-08-29T10:16:26-03:00'::timestamp with time zone,
  '2026-08-29T10:16:26-03:00'::timestamp with time zone,
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
  119, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T10:15:05-03:00'::timestamp with time zone,
  '2026-08-29T10:15:05-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127779736994'
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
  120, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Stella Maris de Vivo',
  'CUIL',
  '23147754434',
  '2026-08-29T10:14:42-03:00'::timestamp with time zone,
  '2026-08-29T10:14:43-03:00'::timestamp with time zone,
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
  121, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mirtha Duarte',
  'CUIL',
  '27140017944',
  '2026-08-29T10:12:39-03:00'::timestamp with time zone,
  '2026-08-29T10:12:39-03:00'::timestamp with time zone,
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
  122, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Seguro rivadavia ',
  'CUIL',
  '27226845416',
  '2026-08-29T10:11:24-03:00'::timestamp with time zone,
  '2026-08-29T10:11:24-03:00'::timestamp with time zone,
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
  123, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Tercer Set',
  'CUIT',
  '20288685208',
  '2026-08-29T10:10:07-03:00'::timestamp with time zone,
  '2026-08-29T10:10:07-03:00'::timestamp with time zone,
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
  124, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Noemi',
  'CUIL',
  '27267541626',
  '2026-08-29T10:10:01-03:00'::timestamp with time zone,
  '2026-08-29T10:10:02-03:00'::timestamp with time zone,
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
  125, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Silvia Beatriz Edelstein',
  'CUIT',
  '27045527897',
  '2026-08-29T10:08:24-03:00'::timestamp with time zone,
  '2026-08-29T10:08:25-03:00'::timestamp with time zone,
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
  126, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Tiny',
  'CUIL',
  '23174647534',
  '2026-08-29T10:03:42-03:00'::timestamp with time zone,
  '2026-08-29T10:03:43-03:00'::timestamp with time zone,
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
  127, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PABLO SOLANO',
  'CUIT',
  '20221243928',
  '2026-08-29T10:00:26-03:00'::timestamp with time zone,
  '2026-08-29T10:00:27-03:00'::timestamp with time zone,
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
  128, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mariano Alejandro Terny',
  'CUIT',
  '20259940053',
  '2026-08-29T09:52:50-03:00'::timestamp with time zone,
  '2026-08-29T09:52:51-03:00'::timestamp with time zone,
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
  129, 1054315166, 'payment_in',
  13500.00, 13419.00, -81.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Kurmi Arcoíris',
  'CUIT',
  '27295048080',
  '2026-08-29T09:42:41-03:00'::timestamp with time zone,
  '2026-08-29T09:42:41-03:00'::timestamp with time zone,
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
  130, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maria Sanservino',
  'CUIL',
  '27338490416',
  '2026-08-29T09:34:32-03:00'::timestamp with time zone,
  '2026-08-29T09:34:32-03:00'::timestamp with time zone,
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
  131, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Jose Garcia Francisco Lago',
  'CUIT',
  '20254317730',
  '2026-08-29T09:34:29-03:00'::timestamp with time zone,
  '2026-08-29T09:34:30-03:00'::timestamp with time zone,
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
  132, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'LUCIO ANTONIO JAVIER CALVO',
  'CUIT',
  '20218714278',
  '2026-08-29T09:33:17-03:00'::timestamp with time zone,
  '2026-08-29T09:33:17-03:00'::timestamp with time zone,
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
  133, 1054315166, 'payment_in',
  36000.00, 35784.00, -216.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ana Josefina Correa',
  'CUIL',
  '27261891536',
  '2026-08-29T09:32:54-03:00'::timestamp with time zone,
  '2026-08-29T09:32:54-03:00'::timestamp with time zone,
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
  134, 1054315166, 'transfer_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Mirna Bus',
  'CUIL',
  '27178941866',
  '2026-08-29T09:31:21-03:00'::timestamp with time zone,
  '2026-08-29T09:31:24-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127778561804'
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
  135, 1054315166, 'transfer_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T09:30:59-03:00'::timestamp with time zone,
  '2026-08-29T09:30:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127778553422'
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
  136, 1054315166, 'transfer_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T09:30:56-03:00'::timestamp with time zone,
  '2026-08-29T09:30:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127778578154'
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
  137, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Pablo Dalponte',
  'CUIL',
  '20296219348',
  '2026-08-29T09:25:00-03:00'::timestamp with time zone,
  '2026-08-29T09:25:01-03:00'::timestamp with time zone,
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
  138, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SOFIA FRANCO',
  'CUIL',
  '27397438959',
  '2026-08-29T09:22:49-03:00'::timestamp with time zone,
  '2026-08-29T09:22:49-03:00'::timestamp with time zone,
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
  139, 1054315166, 'transfer_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T09:21:22-03:00'::timestamp with time zone,
  '2026-08-29T09:21:22-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127778315996'
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
  140, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PABLO VERA',
  'CUIT',
  '20290890315',
  '2026-08-29T09:20:55-03:00'::timestamp with time zone,
  '2026-08-29T09:20:57-03:00'::timestamp with time zone,
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
  141, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'sergio alejendro gauna',
  'CUIL',
  '20174647705',
  '2026-08-29T09:20:09-03:00'::timestamp with time zone,
  '2026-08-29T09:20:10-03:00'::timestamp with time zone,
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
  142, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Julieta Racca',
  'CUIL',
  '27176937756',
  '2026-08-29T09:18:02-03:00'::timestamp with time zone,
  '2026-08-29T09:18:02-03:00'::timestamp with time zone,
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
  143, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIELA FERNANDA BARRIONUEVO',
  'CUIT',
  '27261168796',
  '2026-08-29T09:12:51-03:00'::timestamp with time zone,
  '2026-08-29T09:12:51-03:00'::timestamp with time zone,
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
  144, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Julia Zanotti',
  'CUIL',
  '27230698371',
  '2026-08-29T09:12:11-03:00'::timestamp with time zone,
  '2026-08-29T09:12:12-03:00'::timestamp with time zone,
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
  145, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'lucas lucero',
  'CUIT',
  '20265869166',
  '2026-08-29T09:10:25-03:00'::timestamp with time zone,
  '2026-08-29T09:10:25-03:00'::timestamp with time zone,
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
  146, 1054315166, 'payment_in',
  3500.00, 3479.00, -21.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Analìa da Palma',
  'CUIT',
  '27062673090',
  '2026-08-29T09:03:11-03:00'::timestamp with time zone,
  '2026-08-29T09:03:12-03:00'::timestamp with time zone,
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
  147, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-29T09:01:05-03:00'::timestamp with time zone,
  '2026-08-29T09:01:06-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127777912232'
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
  148, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Teresa68',
  'CUIT',
  '23188001424',
  '2026-08-29T08:59:33-03:00'::timestamp with time zone,
  '2026-08-29T08:59:34-03:00'::timestamp with time zone,
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
  149, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Liliana Recio',
  'CUIT',
  '27067233684',
  '2026-08-29T08:58:27-03:00'::timestamp with time zone,
  '2026-08-29T08:58:28-03:00'::timestamp with time zone,
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
  150, 1054315166, 'payment_in',
  30000.00, 29820.00, -180.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Luis',
  'CUIL',
  '20123825587',
  '2026-08-29T08:50:45-03:00'::timestamp with time zone,
  '2026-08-29T08:50:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
