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
  601, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Carolina Brecciaroli',
  'CUIT',
  '27250934152',
  '2026-08-01T12:14:59-03:00'::timestamp with time zone,
  '2026-08-01T12:14:59-03:00'::timestamp with time zone,
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
  602, 1054315166, 'payment_in',
  5000.00, 4970.00, -30.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GUILLERMO ARIEL GIANNI',
  'CUIL',
  '23230697779',
  '2026-08-01T12:14:49-03:00'::timestamp with time zone,
  '2026-08-01T12:14:50-03:00'::timestamp with time zone,
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
  603, 1054315166, 'transfer_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T12:10:48-03:00'::timestamp with time zone,
  '2026-08-01T12:10:48-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126933813780'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  604, 1054315166, 'payment_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARTA INES CORIA',
  'CUIT',
  '27176937322',
  '2026-08-01T12:10:37-03:00'::timestamp with time zone,
  '2026-08-01T12:10:37-03:00'::timestamp with time zone,
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
  605, 1054315166, 'payment_in',
  10000.00, 9940.00, -60.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ventas Varias',
  'CUIL',
  '20338489820',
  '2026-08-01T12:09:51-03:00'::timestamp with time zone,
  '2026-08-01T12:09:51-03:00'::timestamp with time zone,
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
  606, 1054315166, 'transfer_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T12:09:14-03:00'::timestamp with time zone,
  '2026-08-01T12:09:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126933778450'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  607, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Alejandro Ferrara',
  'CUIT',
  '20305560112',
  '2026-08-01T12:07:56-03:00'::timestamp with time zone,
  '2026-08-01T12:07:56-03:00'::timestamp with time zone,
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
  608, 1054315166, 'transfer_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T12:05:53-03:00'::timestamp with time zone,
  '2026-08-01T12:05:53-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126849713703'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  609, 1054315166, 'payment_in',
  10000.00, 9940.00, -60.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lucrecia Beloqui',
  'CUIT',
  '23244288634',
  '2026-08-01T12:05:06-03:00'::timestamp with time zone,
  '2026-08-01T12:05:06-03:00'::timestamp with time zone,
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
  610, 1054315166, 'payment_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Carlos10',
  'CUIL',
  '20320495165',
  '2026-08-01T12:03:34-03:00'::timestamp with time zone,
  '2026-08-01T12:03:35-03:00'::timestamp with time zone,
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
  611, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Nicole Bari ',
  'CUIT',
  '27397438525',
  '2026-08-01T12:01:27-03:00'::timestamp with time zone,
  '2026-08-01T12:01:28-03:00'::timestamp with time zone,
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
  612, 1054315166, 'payment_in',
  5000.00, 4970.00, -30.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Micaela Zunzunegui',
  'CUIT',
  '27350586534',
  '2026-08-01T11:59:20-03:00'::timestamp with time zone,
  '2026-08-01T11:59:21-03:00'::timestamp with time zone,
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
  613, 1054315166, 'payment_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Nelson Fabian Fernandez',
  'CUIL',
  '20174753491',
  '2026-08-01T11:59:08-03:00'::timestamp with time zone,
  '2026-08-01T11:59:08-03:00'::timestamp with time zone,
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
  614, 1054315166, 'payment_in',
  10000.00, 9940.00, -60.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'NICOLÁS ANDRÉS FRATTINI',
  'CUIT',
  '20349589266',
  '2026-08-01T11:59:07-03:00'::timestamp with time zone,
  '2026-08-01T11:59:07-03:00'::timestamp with time zone,
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
  615, 1054315166, 'payment_in',
  16500.00, 16401.00, -99.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'HECTOR CROCIATI',
  'CUIT',
  '20082114492',
  '2026-08-01T11:55:17-03:00'::timestamp with time zone,
  '2026-08-01T11:55:18-03:00'::timestamp with time zone,
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
  616, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SR Carbon Custom',
  'CUIT',
  '20227309688',
  '2026-08-01T11:53:37-03:00'::timestamp with time zone,
  '2026-08-01T11:53:38-03:00'::timestamp with time zone,
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
  617, 1054315166, 'transfer_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'los 25 de la 51',
  'CUIT',
  '23213152459',
  '2026-08-01T11:51:41-03:00'::timestamp with time zone,
  '2026-08-01T11:51:43-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126849149885'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  618, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ceci Garcia',
  'CUIT',
  '27310635230',
  '2026-08-01T11:50:24-03:00'::timestamp with time zone,
  '2026-08-01T11:50:25-03:00'::timestamp with time zone,
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
  619, 1054315166, 'payment_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'CAROLINA FERRER',
  'CUIT',
  '27217803611',
  '2026-08-01T11:47:40-03:00'::timestamp with time zone,
  '2026-08-01T11:47:40-03:00'::timestamp with time zone,
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
  620, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'LUCIA CRESPO',
  'CUIT',
  '27355919132',
  '2026-08-01T11:46:52-03:00'::timestamp with time zone,
  '2026-08-01T11:46:53-03:00'::timestamp with time zone,
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
  621, 1054315166, 'payment_in',
  10500.00, 10437.00, -63.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'viaje',
  'CUIT',
  '27206894852',
  '2026-08-01T11:46:52-03:00'::timestamp with time zone,
  '2026-08-01T11:46:53-03:00'::timestamp with time zone,
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
  622, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Daluarviedma',
  'CUIT',
  '20229512995',
  '2026-08-01T11:45:17-03:00'::timestamp with time zone,
  '2026-08-01T11:45:18-03:00'::timestamp with time zone,
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
  623, 1054315166, 'payment_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mabel Monica Lopez',
  'CUIT',
  '27308789069',
  '2026-08-01T11:44:55-03:00'::timestamp with time zone,
  '2026-08-01T11:44:55-03:00'::timestamp with time zone,
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
  624, 1054315166, 'transfer_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'MIRTA YOLANDA COLLOMILLA',
  'CUIT',
  '27223788438',
  '2026-08-01T11:42:42-03:00'::timestamp with time zone,
  '2026-08-01T11:42:44-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126932698894'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  625, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Laura Haydée Segovia',
  'CUIT',
  '27147059200',
  '2026-08-01T11:42:07-03:00'::timestamp with time zone,
  '2026-08-01T11:42:07-03:00'::timestamp with time zone,
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
  626, 1054315166, 'transfer_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Martin Nicolas Abdala',
  'CUIT',
  '20303668978',
  '2026-08-01T11:41:57-03:00'::timestamp with time zone,
  '2026-08-01T11:42:00-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126932684212'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  627, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Juan Pablo Nieva',
  'CUIT',
  '20389058573',
  '2026-08-01T11:41:02-03:00'::timestamp with time zone,
  '2026-08-01T11:41:02-03:00'::timestamp with time zone,
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
  628, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Milton Damian Pereyra',
  'CUIL',
  '20349589851',
  '2026-08-01T11:40:06-03:00'::timestamp with time zone,
  '2026-08-01T11:40:06-03:00'::timestamp with time zone,
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
  629, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'alejandra carmona',
  'CUIT',
  '27247623391',
  '2026-08-01T11:38:24-03:00'::timestamp with time zone,
  '2026-08-01T11:38:25-03:00'::timestamp with time zone,
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
  630, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lorenzo Mora',
  'CUIT',
  '20310633950',
  '2026-08-01T11:38:14-03:00'::timestamp with time zone,
  '2026-08-01T11:38:15-03:00'::timestamp with time zone,
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
  631, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Gustavo Carnevale',
  'CUIT',
  '20246483427',
  '2026-08-01T11:36:13-03:00'::timestamp with time zone,
  '2026-08-01T11:36:13-03:00'::timestamp with time zone,
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
  632, 1054315166, 'transfer_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'GIANFRANCO MAZZIOTTI',
  'CUIL',
  '20376947050',
  '2026-08-01T11:35:14-03:00'::timestamp with time zone,
  '2026-08-01T11:35:16-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126932401010'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  633, 1054315166, 'payment_in',
  10000.00, 9940.00, -60.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'andres zimmermann',
  'CUIT',
  '20184047064',
  '2026-08-01T11:34:38-03:00'::timestamp with time zone,
  '2026-08-01T11:34:38-03:00'::timestamp with time zone,
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
  634, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARCOS HERNAN SELEIMAN',
  'CUIT',
  '20256953502',
  '2026-08-01T11:33:34-03:00'::timestamp with time zone,
  '2026-08-01T11:33:35-03:00'::timestamp with time zone,
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
  635, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARCOS HERNAN SELEIMAN',
  'CUIT',
  '20256953502',
  '2026-08-01T11:33:00-03:00'::timestamp with time zone,
  '2026-08-01T11:33:00-03:00'::timestamp with time zone,
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
  636, 1054315166, 'transfer_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Marcela Burgoa',
  'CUIL',
  '27298983309',
  '2026-08-01T11:31:44-03:00'::timestamp with time zone,
  '2026-08-01T11:31:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126932261328'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  637, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Jumpingviedma ',
  'CUIT',
  '27251791967',
  '2026-08-01T11:30:36-03:00'::timestamp with time zone,
  '2026-08-01T11:30:36-03:00'::timestamp with time zone,
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
  638, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Rosana Soracio',
  'CUIT',
  '27143302992',
  '2026-08-01T11:27:57-03:00'::timestamp with time zone,
  '2026-08-01T11:27:57-03:00'::timestamp with time zone,
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
  639, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Autoservicio puma',
  'CUIT',
  '27345803969',
  '2026-08-01T11:26:30-03:00'::timestamp with time zone,
  '2026-08-01T11:26:31-03:00'::timestamp with time zone,
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
  640, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'romina ekerman',
  'CUIL',
  '27364855961',
  '2026-08-01T11:25:25-03:00'::timestamp with time zone,
  '2026-08-01T11:25:26-03:00'::timestamp with time zone,
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
  641, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Gráfica el Maestro',
  'CUIL',
  '20327097920',
  '2026-08-01T11:22:14-03:00'::timestamp with time zone,
  '2026-08-01T11:22:14-03:00'::timestamp with time zone,
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
  642, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lisandro',
  'CUIT',
  '20327098986',
  '2026-08-01T11:18:22-03:00'::timestamp with time zone,
  '2026-08-01T11:18:22-03:00'::timestamp with time zone,
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
  643, 1054315166, 'payment_in',
  120000.00, 119280.00, -720.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Matias Margiotta',
  'CUIL',
  '20298982626',
  '2026-08-01T11:16:04-03:00'::timestamp with time zone,
  '2026-08-01T11:16:05-03:00'::timestamp with time zone,
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
  644, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Hilda Maria Huentelaf',
  'CUIT',
  '27144368342',
  '2026-08-01T11:16:01-03:00'::timestamp with time zone,
  '2026-08-01T11:16:02-03:00'::timestamp with time zone,
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
  645, 1054315166, 'payment_in',
  36000.00, 35784.00, -216.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Su Guerrero',
  'CUIT',
  '23109762954',
  '2026-08-01T11:15:28-03:00'::timestamp with time zone,
  '2026-08-01T11:15:28-03:00'::timestamp with time zone,
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
  646, 1054315166, 'transfer_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T11:15:23-03:00'::timestamp with time zone,
  '2026-08-01T11:15:23-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126847768957'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  647, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ADRIANA FERREYRA',
  'CUIL',
  '27215364742',
  '2026-08-01T11:14:25-03:00'::timestamp with time zone,
  '2026-08-01T11:14:25-03:00'::timestamp with time zone,
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
  648, 1054315166, 'transfer_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T11:14:11-03:00'::timestamp with time zone,
  '2026-08-01T11:14:11-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126847705983'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  649, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIA VANESA SURIN',
  'CUIT',
  '27263530891',
  '2026-08-01T11:11:40-03:00'::timestamp with time zone,
  '2026-08-01T11:11:41-03:00'::timestamp with time zone,
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
  650, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Gaspar Ivan Garrido',
  'CUIT',
  '20472441346',
  '2026-08-01T11:09:36-03:00'::timestamp with time zone,
  '2026-08-01T11:09:37-03:00'::timestamp with time zone,
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
  651, 1054315166, 'transfer_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T11:08:19-03:00'::timestamp with time zone,
  '2026-08-01T11:08:19-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126847507565'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  652, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Marien®',
  'CUIL',
  '27317717380',
  '2026-08-01T11:07:31-03:00'::timestamp with time zone,
  '2026-08-01T11:07:31-03:00'::timestamp with time zone,
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
  653, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maria Pia Vidussi',
  'CUIT',
  '27276248885',
  '2026-08-01T11:06:09-03:00'::timestamp with time zone,
  '2026-08-01T11:06:10-03:00'::timestamp with time zone,
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
  654, 1054315166, 'payment_in',
  1800.00, 1789.20, -10.80,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Carola  González León',
  'CUIT',
  '27207503024',
  '2026-08-01T11:05:48-03:00'::timestamp with time zone,
  '2026-08-01T11:05:49-03:00'::timestamp with time zone,
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
  655, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ROBERTO ADRIAN HAURE',
  'CUIT',
  '20166903131',
  '2026-08-01T11:04:19-03:00'::timestamp with time zone,
  '2026-08-01T11:04:20-03:00'::timestamp with time zone,
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
  656, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'FLORENCIA BELEN BERREAUTE',
  'CUIT',
  '27372129803',
  '2026-08-01T11:02:40-03:00'::timestamp with time zone,
  '2026-08-01T11:02:41-03:00'::timestamp with time zone,
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
  657, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Martin Alcalde',
  'CUIT',
  '20248936550',
  '2026-08-01T11:01:34-03:00'::timestamp with time zone,
  '2026-08-01T11:01:34-03:00'::timestamp with time zone,
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
  658, 1054315166, 'transfer_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T11:01:03-03:00'::timestamp with time zone,
  '2026-08-01T11:01:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126931145110'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  659, 1054315166, 'transfer_in',
  3500.00, 3479.00, -21.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T11:01:01-03:00'::timestamp with time zone,
  '2026-08-01T11:01:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126931141390'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  660, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Gustavo Rivero',
  'CUIT',
  '20235809517',
  '2026-08-01T10:55:36-03:00'::timestamp with time zone,
  '2026-08-01T10:55:37-03:00'::timestamp with time zone,
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
  661, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'RENE EDUARDO TEUSCHER PALMA',
  'CUIL',
  '20188338071',
  '2026-08-01T10:55:23-03:00'::timestamp with time zone,
  '2026-08-01T10:55:23-03:00'::timestamp with time zone,
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
  662, 1054315166, 'transfer_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T10:55:03-03:00'::timestamp with time zone,
  '2026-08-01T10:55:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126930929848'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  663, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'la autentica',
  'CUIT',
  '27364977188',
  '2026-08-01T10:54:57-03:00'::timestamp with time zone,
  '2026-08-01T10:54:57-03:00'::timestamp with time zone,
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
  664, 1054315166, 'payment_in',
  21000.00, 20874.00, -126.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'alejandro coleffi',
  'CUIL',
  '20168625503',
  '2026-08-01T10:54:39-03:00'::timestamp with time zone,
  '2026-08-01T10:54:40-03:00'::timestamp with time zone,
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
  665, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'andres monzon',
  'CUIL',
  '20139227515',
  '2026-08-01T10:53:08-03:00'::timestamp with time zone,
  '2026-08-01T10:53:08-03:00'::timestamp with time zone,
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
  666, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lorena Garat',
  'CUIT',
  '27255256217',
  '2026-08-01T10:52:08-03:00'::timestamp with time zone,
  '2026-08-01T10:52:09-03:00'::timestamp with time zone,
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
  667, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Carolina psa',
  'CUIT',
  '27347816340',
  '2026-08-01T10:50:34-03:00'::timestamp with time zone,
  '2026-08-01T10:50:34-03:00'::timestamp with time zone,
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
  668, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'paola marcel',
  'CUIL',
  '27241346973',
  '2026-08-01T10:50:08-03:00'::timestamp with time zone,
  '2026-08-01T10:50:09-03:00'::timestamp with time zone,
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
  669, 1054315166, 'transfer_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T10:48:43-03:00'::timestamp with time zone,
  '2026-08-01T10:48:43-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126846850119'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  670, 1054315166, 'payment_in',
  5300.00, 5268.20, -31.80,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Sergio Vechiati',
  'CUIT',
  '20130941363',
  '2026-08-01T10:48:42-03:00'::timestamp with time zone,
  '2026-08-01T10:48:42-03:00'::timestamp with time zone,
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
  671, 1054315166, 'payment_in',
  21000.00, 20874.00, -126.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Royal prestige',
  'CUIL',
  '27184582762',
  '2026-08-01T10:43:05-03:00'::timestamp with time zone,
  '2026-08-01T10:43:06-03:00'::timestamp with time zone,
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
  672, 1054315166, 'transfer_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T10:42:37-03:00'::timestamp with time zone,
  '2026-08-01T10:42:38-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126846631297'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  673, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Santiago Alberto Miguelez',
  'CUIT',
  '20226510444',
  '2026-08-01T10:41:17-03:00'::timestamp with time zone,
  '2026-08-01T10:41:18-03:00'::timestamp with time zone,
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
  674, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mario juaquin Urrutia',
  'CUIL',
  '20161914240',
  '2026-08-01T10:40:35-03:00'::timestamp with time zone,
  '2026-08-01T10:40:35-03:00'::timestamp with time zone,
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
  675, 1054315166, 'transfer_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T10:39:57-03:00'::timestamp with time zone,
  '2026-08-01T10:39:57-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126930460324'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  676, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PABLO VERA',
  'CUIT',
  '20290890315',
  '2026-08-01T10:37:30-03:00'::timestamp with time zone,
  '2026-08-01T10:37:31-03:00'::timestamp with time zone,
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
  677, 1054315166, 'payment_in',
  2500.00, 2485.00, -15.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Narciso Esteban Martinez',
  'CUIL',
  '20149797743',
  '2026-08-01T10:35:17-03:00'::timestamp with time zone,
  '2026-08-01T10:35:17-03:00'::timestamp with time zone,
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
  678, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Pablo Dalponte',
  'CUIL',
  '20296219348',
  '2026-08-01T10:33:20-03:00'::timestamp with time zone,
  '2026-08-01T10:33:21-03:00'::timestamp with time zone,
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
  679, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'leonardo sandon',
  'CUIT',
  '23220530469',
  '2026-08-01T10:32:56-03:00'::timestamp with time zone,
  '2026-08-01T10:32:57-03:00'::timestamp with time zone,
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
  680, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Europie',
  'CUIT',
  '20355917313',
  '2026-08-01T10:27:16-03:00'::timestamp with time zone,
  '2026-08-01T10:27:16-03:00'::timestamp with time zone,
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
  681, 1054315166, 'transfer_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T10:24:47-03:00'::timestamp with time zone,
  '2026-08-01T10:24:47-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126929965434'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  682, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SUSANA ANGELICA ELGUETA',
  'CUIT',
  '27109946910',
  '2026-08-01T10:23:54-03:00'::timestamp with time zone,
  '2026-08-01T10:23:54-03:00'::timestamp with time zone,
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
  683, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'antonio francioni',
  'CUIT',
  '20109948749',
  '2026-08-01T10:21:13-03:00'::timestamp with time zone,
  '2026-08-01T10:21:13-03:00'::timestamp with time zone,
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
  684, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'sergio zucal',
  'CUIT',
  '20173383658',
  '2026-08-01T10:17:40-03:00'::timestamp with time zone,
  '2026-08-01T10:17:41-03:00'::timestamp with time zone,
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
  685, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Jose Garcia Francisco Lago',
  'CUIT',
  '20254317730',
  '2026-08-01T10:15:30-03:00'::timestamp with time zone,
  '2026-08-01T10:15:30-03:00'::timestamp with time zone,
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
  686, 1054315166, 'transfer_in',
  10000.00, 9940.00, -60.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T10:14:10-03:00'::timestamp with time zone,
  '2026-08-01T10:14:11-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126929658678'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  687, 1054315166, 'payment_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Marcela Alejandra Poblete',
  'CUIL',
  '27213884366',
  '2026-08-01T10:09:39-03:00'::timestamp with time zone,
  '2026-08-01T10:09:39-03:00'::timestamp with time zone,
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
  688, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Vicente ',
  'CUIL',
  '20244375821',
  '2026-08-01T10:07:49-03:00'::timestamp with time zone,
  '2026-08-01T10:07:49-03:00'::timestamp with time zone,
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
  689, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIA ROSA BARBARA',
  'CUIL',
  '27147059383',
  '2026-08-01T10:00:36-03:00'::timestamp with time zone,
  '2026-08-01T10:00:36-03:00'::timestamp with time zone,
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
  690, 1054315166, 'transfer_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Ramon Antonio Suarez',
  'CUIT',
  '20127680788',
  '2026-08-01T09:58:45-03:00'::timestamp with time zone,
  '2026-08-01T09:58:47-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126929205572'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  691, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'CHRISTIAN ALBERTO MURO',
  'CUIT',
  '20259292175',
  '2026-08-01T09:56:42-03:00'::timestamp with time zone,
  '2026-08-01T09:56:43-03:00'::timestamp with time zone,
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
  692, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Nai',
  'CUIL',
  '27425390932',
  '2026-08-01T09:54:51-03:00'::timestamp with time zone,
  '2026-08-01T09:54:52-03:00'::timestamp with time zone,
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
  693, 1054315166, 'transfer_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Guille',
  'CUIT',
  '23295089059',
  '2026-08-01T09:52:03-03:00'::timestamp with time zone,
  '2026-08-01T09:52:05-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126845145135'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  694, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Andrea D''Angelo Rios',
  'CUIL',
  '27281195293',
  '2026-08-01T09:51:54-03:00'::timestamp with time zone,
  '2026-08-01T09:51:54-03:00'::timestamp with time zone,
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
  695, 1054315166, 'payment_in',
  10000.00, 9940.00, -60.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'LUCRECIA MARCELA TORRES',
  'CUIT',
  '27299381701',
  '2026-08-01T09:48:49-03:00'::timestamp with time zone,
  '2026-08-01T09:48:50-03:00'::timestamp with time zone,
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
  696, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIANO FERRARI',
  'CUIT',
  '20246505188',
  '2026-08-01T09:47:25-03:00'::timestamp with time zone,
  '2026-08-01T09:47:26-03:00'::timestamp with time zone,
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
  697, 1054315166, 'payment_in',
  10000.00, 9940.00, -60.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GUILLERMO GIRONDE',
  'CUIT',
  '20241345727',
  '2026-08-01T09:46:18-03:00'::timestamp with time zone,
  '2026-08-01T09:46:19-03:00'::timestamp with time zone,
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
  698, 1054315166, 'payment_in',
  10000.00, 9940.00, -60.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Hoy_viedma',
  'CUIT',
  '27255457727',
  '2026-08-01T09:43:18-03:00'::timestamp with time zone,
  '2026-08-01T09:43:18-03:00'::timestamp with time zone,
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
  699, 1054315166, 'payment_in',
  2000.00, 1988.00, -12.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'morena',
  'CUIT',
  '27267047362',
  '2026-08-01T09:36:21-03:00'::timestamp with time zone,
  '2026-08-01T09:36:21-03:00'::timestamp with time zone,
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
  700, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Sebastian Fuse',
  'CUIL',
  '20320495858',
  '2026-08-01T09:35:15-03:00'::timestamp with time zone,
  '2026-08-01T09:35:16-03:00'::timestamp with time zone,
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
  701, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'BOUNTANG SICHANH',
  'CUIT',
  '27188304317',
  '2026-08-01T09:34:40-03:00'::timestamp with time zone,
  '2026-08-01T09:34:41-03:00'::timestamp with time zone,
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
  702, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'delvis Hecker',
  'CUIT',
  '20297261887',
  '2026-08-01T09:29:15-03:00'::timestamp with time zone,
  '2026-08-01T09:29:15-03:00'::timestamp with time zone,
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
  703, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Claudio Carlos Parra',
  'CUIL',
  '20139897642',
  '2026-08-01T09:29:12-03:00'::timestamp with time zone,
  '2026-08-01T09:29:12-03:00'::timestamp with time zone,
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
  704, 1054315166, 'transfer_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T09:17:40-03:00'::timestamp with time zone,
  '2026-08-01T09:17:40-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126928199008'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  705, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIELA FERNANDA BARRIONUEVO',
  'CUIT',
  '27261168796',
  '2026-08-01T09:11:44-03:00'::timestamp with time zone,
  '2026-08-01T09:11:45-03:00'::timestamp with time zone,
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
  706, 1054315166, 'payment_in',
  21000.00, 20874.00, -126.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Adelicia',
  'CUIL',
  '27380835997',
  '2026-08-01T09:11:19-03:00'::timestamp with time zone,
  '2026-08-01T09:11:20-03:00'::timestamp with time zone,
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
  707, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Julieta Racca',
  'CUIL',
  '27176937756',
  '2026-08-01T09:06:35-03:00'::timestamp with time zone,
  '2026-08-01T09:06:35-03:00'::timestamp with time zone,
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
  708, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Liliana Recio',
  'CUIT',
  '27067233684',
  '2026-08-01T09:06:07-03:00'::timestamp with time zone,
  '2026-08-01T09:06:08-03:00'::timestamp with time zone,
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
  709, 1054315166, 'payment_in',
  21000.00, 20874.00, -126.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ana',
  'CUIL',
  '27317423662',
  '2026-08-01T09:05:04-03:00'::timestamp with time zone,
  '2026-08-01T09:05:05-03:00'::timestamp with time zone,
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
  710, 1054315166, 'transfer_in',
  21000.00, 20874.00, -126.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'JULIO LEANDRO FERMANELLI',
  'CUIT',
  '20227308762',
  '2026-08-01T09:04:30-03:00'::timestamp with time zone,
  '2026-08-01T09:04:33-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126927901580'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  711, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'NataliaD',
  'CUIT',
  '27246660439',
  '2026-08-01T08:47:36-03:00'::timestamp with time zone,
  '2026-08-01T08:47:36-03:00'::timestamp with time zone,
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
  712, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PABLO SOLANO',
  'CUIT',
  '20221243928',
  '2026-08-01T08:30:17-03:00'::timestamp with time zone,
  '2026-08-01T08:30:17-03:00'::timestamp with time zone,
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
  713, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ALDA CINTIA LUCRECIA VALLA',
  'CUIL',
  '27314551058',
  '2026-08-01T08:26:38-03:00'::timestamp with time zone,
  '2026-08-01T08:26:38-03:00'::timestamp with time zone,
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
  714, 1054315166, 'transfer_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T08:19:54-03:00'::timestamp with time zone,
  '2026-08-01T08:19:54-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126927116898'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  715, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'FAUSTO RODRIGO CENTENO',
  'CUIT',
  '23232015519',
  '2026-08-01T08:15:53-03:00'::timestamp with time zone,
  '2026-08-01T08:15:54-03:00'::timestamp with time zone,
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
  716, 1054315166, 'transfer_in',
  9000.00, 8946.00, -54.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-01T07:10:26-03:00'::timestamp with time zone,
  '2026-08-01T07:10:27-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126842422527'
) ON CONFLICT DO NOTHING;
