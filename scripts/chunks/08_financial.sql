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
  301, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GUILLERMO GIRONDE',
  'CUIT',
  '20241345727',
  '2026-08-22T10:02:12-03:00'::timestamp with time zone,
  '2026-08-22T10:02:14-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  302, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Kurmi Arcoíris',
  'CUIT',
  '27295048080',
  '2026-08-22T10:02:02-03:00'::timestamp with time zone,
  '2026-08-22T10:02:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  303, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Urano',
  'CUIT',
  '27349587357',
  '2026-08-22T10:01:35-03:00'::timestamp with time zone,
  '2026-08-22T10:01:36-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  304, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Eliana Maribel Alvarez',
  'CUIT',
  '27338489620',
  '2026-08-22T10:00:11-03:00'::timestamp with time zone,
  '2026-08-22T10:00:11-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  305, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ramos',
  'CUIL',
  '27340265640',
  '2026-08-22T09:59:59-03:00'::timestamp with time zone,
  '2026-08-22T09:59:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  306, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ANDY WILDER ORE ACUÑA',
  'CUIL',
  '20947144643',
  '2026-08-22T09:59:15-03:00'::timestamp with time zone,
  '2026-08-22T09:59:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  307, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'CHRISTIAN ALBERTO MURO',
  'CUIT',
  '20259292175',
  '2026-08-22T09:59:12-03:00'::timestamp with time zone,
  '2026-08-22T09:59:12-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  308, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Pablo Montenegro',
  'CUIT',
  '20241345905',
  '2026-08-22T09:58:03-03:00'::timestamp with time zone,
  '2026-08-22T09:58:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  309, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Jorge Farabello',
  'CUIL',
  '20291708219',
  '2026-08-22T09:58:01-03:00'::timestamp with time zone,
  '2026-08-22T09:58:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  310, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Julio Nadal',
  'CUIL',
  '20206902184',
  '2026-08-22T09:56:45-03:00'::timestamp with time zone,
  '2026-08-22T09:56:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  311, 1054315166, 'payment_in',
  30000.00, 29820.00, -180.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Leonardo Namur',
  'CUIT',
  '20313594131',
  '2026-08-22T09:54:06-03:00'::timestamp with time zone,
  '2026-08-22T09:54:07-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  312, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-22T09:51:09-03:00'::timestamp with time zone,
  '2026-08-22T09:51:10-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127581465686'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  313, 1054315166, 'payment_in',
  6500.00, 6461.00, -39.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIA BEATRIZ JACOBI',
  'CUIT',
  '27223256258',
  '2026-08-22T09:47:13-03:00'::timestamp with time zone,
  '2026-08-22T09:47:13-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  314, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ADRIAN OLIVETTI',
  'CUIT',
  '20169675946',
  '2026-08-22T09:47:12-03:00'::timestamp with time zone,
  '2026-08-22T09:47:12-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  315, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'RENE EDUARDO TEUSCHER PALMA',
  'CUIL',
  '20188338071',
  '2026-08-22T09:46:46-03:00'::timestamp with time zone,
  '2026-08-22T09:46:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  316, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Silvia Luciana León',
  'CUIT',
  '27310633769',
  '2026-08-22T09:46:36-03:00'::timestamp with time zone,
  '2026-08-22T09:46:36-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  317, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ana',
  'CUIL',
  '27317423662',
  '2026-08-22T09:45:35-03:00'::timestamp with time zone,
  '2026-08-22T09:45:36-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  318, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'romina ekerman',
  'CUIL',
  '27364855961',
  '2026-08-22T09:43:17-03:00'::timestamp with time zone,
  '2026-08-22T09:43:18-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  319, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'María Valeria Fernandez',
  'CUIT',
  '27243107534',
  '2026-08-22T09:41:33-03:00'::timestamp with time zone,
  '2026-08-22T09:41:33-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  320, 1054315166, 'payment_in',
  13000.00, 12922.00, -78.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ELIZABET IVANISKY',
  'CUIL',
  '27259290630',
  '2026-08-22T09:40:33-03:00'::timestamp with time zone,
  '2026-08-22T09:40:34-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  321, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Agus Oliva Gardey',
  'CUIL',
  '24355400804',
  '2026-08-22T09:32:20-03:00'::timestamp with time zone,
  '2026-08-22T09:32:21-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  322, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ROBERTO ADRIAN HAURE',
  'CUIT',
  '20166903131',
  '2026-08-22T09:31:18-03:00'::timestamp with time zone,
  '2026-08-22T09:31:18-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  323, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'LUCIANA GARCIA CABEZON',
  'CUIT',
  '27282978917',
  '2026-08-22T09:21:44-03:00'::timestamp with time zone,
  '2026-08-22T09:21:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  324, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'YAMILA VALERIA DIETZ',
  'CUIL',
  '23348761684',
  '2026-08-22T09:19:24-03:00'::timestamp with time zone,
  '2026-08-22T09:19:24-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  325, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'antoniavique',
  'CUIT',
  '27188920891',
  '2026-08-22T09:16:26-03:00'::timestamp with time zone,
  '2026-08-22T09:16:26-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  326, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'viedma temporarios',
  'CUIT',
  '20350585770',
  '2026-08-22T09:13:26-03:00'::timestamp with time zone,
  '2026-08-22T09:13:27-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  327, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Jose Garcia Francisco Lago',
  'CUIT',
  '20254317730',
  '2026-08-22T09:09:50-03:00'::timestamp with time zone,
  '2026-08-22T09:09:51-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  328, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Liliana Recio',
  'CUIT',
  '27067233684',
  '2026-08-22T09:05:01-03:00'::timestamp with time zone,
  '2026-08-22T09:05:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  329, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mario Block',
  'CUIT',
  '20280042960',
  '2026-08-22T09:03:11-03:00'::timestamp with time zone,
  '2026-08-22T09:03:12-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  330, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'DANIEL ENRIQUE TORRES',
  'CUIT',
  '20228348393',
  '2026-08-22T09:02:25-03:00'::timestamp with time zone,
  '2026-08-22T09:02:25-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  331, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIELA FERNANDA BARRIONUEVO',
  'CUIT',
  '27261168796',
  '2026-08-22T09:00:06-03:00'::timestamp with time zone,
  '2026-08-22T09:00:06-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  332, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Dinámica Kinesiologia',
  'CUIT',
  '24236387484',
  '2026-08-22T08:57:40-03:00'::timestamp with time zone,
  '2026-08-22T08:57:40-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  333, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ALDA CINTIA LUCRECIA VALLA',
  'CUIL',
  '27314551058',
  '2026-08-22T08:14:33-03:00'::timestamp with time zone,
  '2026-08-22T08:14:33-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  334, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Higiene y Control',
  'CUIL',
  '20330965399',
  '2026-08-21T19:13:40-03:00'::timestamp with time zone,
  '2026-08-21T19:13:40-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  335, 1054315166, 'payment_out',
  -35000.00, -35210.00, -210.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-21T12:34:42-03:00'::timestamp with time zone,
  '2026-08-21T12:34:43-03:00'::timestamp with time zone,
  '43822126910',
  'INSTORE-69dc0060-cfd1-4e34-939d-909cee6ee708',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  336, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-21T12:09:11-03:00'::timestamp with time zone,
  '2026-08-21T12:09:11-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127552870582'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  337, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Natalia Pastelería',
  'CUIT',
  '27263043850',
  '2026-08-21T10:59:01-03:00'::timestamp with time zone,
  '2026-08-21T10:59:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127465307285'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  338, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'mauro canale',
  'CUIT',
  '20320494630',
  '2026-08-21T10:50:26-03:00'::timestamp with time zone,
  '2026-08-21T10:50:26-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  339, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Lucrecia Guttmann',
  'CUIL',
  '27349589031',
  '2026-08-21T10:16:34-03:00'::timestamp with time zone,
  '2026-08-21T10:16:36-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127549269068'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  340, 1054315166, 'yield',
  786.42, 786.42, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-21T03:23:19-03:00'::timestamp with time zone,
  '2026-08-21T03:23:19-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  341, 1054315166, 'payment_in',
  234000.00, 232596.00, -1404.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mrpolloviedma1',
  'CUIT',
  '27145276417',
  '2026-08-20T21:31:01-03:00'::timestamp with time zone,
  '2026-08-20T21:31:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  342, 1054315166, 'payment_out',
  -10000.00, -10060.00, -60.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-20T18:33:09-03:00'::timestamp with time zone,
  '2026-08-20T18:33:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  343, 1054315166, 'yield',
  836.20, 836.20, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-20T02:57:23-03:00'::timestamp with time zone,
  '2026-08-20T02:57:23-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  344, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'natalia alcaraz',
  'CUIL',
  '27322091678',
  '2026-08-19T18:36:22-03:00'::timestamp with time zone,
  '2026-08-19T18:36:24-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127417815539'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  345, 1054315166, 'payment_out',
  -44000.00, -44264.00, -264.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-19T18:26:14-03:00'::timestamp with time zone,
  '2026-08-19T18:26:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  346, 1054315166, 'payment_in',
  1000.00, 994.00, -6.00,
  NULL, 0.6000,
  'credit_card',
  'naranja',
  'colibri',
  'CUIL',
  '27338490475',
  '2026-08-19T16:12:04-03:00'::timestamp with time zone,
  '2026-08-19T16:12:05-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  347, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'credit_card',
  'naranja',
  'colibri',
  'CUIL',
  '27338490475',
  '2026-08-19T15:47:18-03:00'::timestamp with time zone,
  '2026-08-19T15:47:20-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  348, 1054315166, 'payment_out',
  -116001.00, -116697.01, -696.01,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-19T07:56:26-03:00'::timestamp with time zone,
  '2026-08-19T07:56:26-03:00'::timestamp with time zone,
  '43731795765',
  '147000095',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  349, 1054315166, 'yield',
  809.04, 809.04, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-19T03:46:08-03:00'::timestamp with time zone,
  '2026-08-19T03:46:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  350, 1054315166, 'payment_in',
  39000.00, 38766.00, -234.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'sebastian montero de espinosa',
  'CUIT',
  '20323026336',
  '2026-08-18T21:07:32-03:00'::timestamp with time zone,
  '2026-08-18T21:07:32-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  351, 1054315166, 'transfer_in',
  39000.00, 38766.00, -234.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-18T20:38:15-03:00'::timestamp with time zone,
  '2026-08-18T20:38:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127393340939'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  352, 1054315166, 'payment_in',
  28000.00, 27832.00, -168.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'El chico del pórtico',
  'CUIT',
  '27349589228',
  '2026-08-18T14:14:07-03:00'::timestamp with time zone,
  '2026-08-18T14:14:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  353, 1054315166, 'payment_out',
  -60000.00, -60360.00, -360.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-18T13:46:41-03:00'::timestamp with time zone,
  '2026-08-18T13:46:42-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  354, 1054315166, 'yield',
  6972.47, 6972.47, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-18T04:39:16-03:00'::timestamp with time zone,
  '2026-08-18T04:39:16-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  355, 1054315166, 'payment_in',
  234000.00, 232596.00, -1404.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mrpolloviedma1',
  'CUIT',
  '27145276417',
  '2026-08-17T21:44:34-03:00'::timestamp with time zone,
  '2026-08-17T21:44:34-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  356, 1054315166, 'payment_out',
  -45020.00, -45290.12, -270.12,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-17T11:41:40-03:00'::timestamp with time zone,
  '2026-08-17T11:41:41-03:00'::timestamp with time zone,
  '43717607222',
  '146743635',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  357, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Higiene y Control',
  'CUIL',
  '20330965399',
  '2026-08-15T22:57:47-03:00'::timestamp with time zone,
  '2026-08-15T22:57:47-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  358, 1054315166, 'transfer_in',
  195000.00, 193830.00, -1170.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-15T18:28:35-03:00'::timestamp with time zone,
  '2026-08-15T18:28:36-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127307642069'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  359, 1054315166, 'payment_in',
  380000.00, 377720.00, -2280.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'marcial',
  'CUIT',
  '20927193257',
  '2026-08-15T13:23:09-03:00'::timestamp with time zone,
  '2026-08-15T13:23:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  360, 1054315166, 'payment_in',
  156000.00, 155064.00, -936.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Puesto 92',
  'CUIT',
  '27943603745',
  '2026-08-15T13:12:08-03:00'::timestamp with time zone,
  '2026-08-15T13:12:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  361, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'JORGE RUBEN JUAREZ',
  'CUIL',
  '20335498276',
  '2026-08-15T12:24:56-03:00'::timestamp with time zone,
  '2026-08-15T12:24:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  362, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Hector Muñoz',
  'CUIT',
  '23180670009',
  '2026-08-15T12:23:51-03:00'::timestamp with time zone,
  '2026-08-15T12:23:51-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  363, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SOLEDAD MARGOT CECCHINI',
  'CUIL',
  '27295049583',
  '2026-08-15T12:20:47-03:00'::timestamp with time zone,
  '2026-08-15T12:20:48-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  364, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Farmacia Krenz',
  'CUIT',
  '27315600885',
  '2026-08-15T12:19:59-03:00'::timestamp with time zone,
  '2026-08-15T12:19:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  365, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GUSTAVO GABRIEL CORNEJO',
  'CUIT',
  '20285211299',
  '2026-08-15T12:19:44-03:00'::timestamp with time zone,
  '2026-08-15T12:19:44-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  366, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MIRTA MABEL MELLADO',
  'CUIL',
  '27138236205',
  '2026-08-15T12:18:25-03:00'::timestamp with time zone,
  '2026-08-15T12:18:25-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  367, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Europie',
  'CUIT',
  '20355917313',
  '2026-08-15T12:17:55-03:00'::timestamp with time zone,
  '2026-08-15T12:17:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  368, 1054315166, 'payment_in',
  3500.00, 3479.00, -21.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ALEJANDRO PEDRO MONGABURE',
  'CUIT',
  '20165339712',
  '2026-08-15T12:15:07-03:00'::timestamp with time zone,
  '2026-08-15T12:15:07-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  369, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Establecimiento La Victoria',
  'CUIT',
  '27286160781',
  '2026-08-15T12:14:38-03:00'::timestamp with time zone,
  '2026-08-15T12:14:39-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  370, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Federada viedma',
  'CUIT',
  '20218781501',
  '2026-08-15T12:10:21-03:00'::timestamp with time zone,
  '2026-08-15T12:10:22-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  371, 1054315166, 'transfer_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Miguel',
  'CUIT',
  '20230697516',
  '2026-08-15T12:08:57-03:00'::timestamp with time zone,
  '2026-08-15T12:09:00-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127295004653'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  372, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MONICA SUSANA ROTONDO',
  'CUIL',
  '27173758672',
  '2026-08-15T12:07:08-03:00'::timestamp with time zone,
  '2026-08-15T12:07:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  373, 1054315166, 'payment_in',
  3500.00, 3479.00, -21.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Sergio Vechiati',
  'CUIT',
  '20130941363',
  '2026-08-15T12:06:19-03:00'::timestamp with time zone,
  '2026-08-15T12:06:20-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  374, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'NICOLÁS ANDRÉS FRATTINI',
  'CUIT',
  '20349589266',
  '2026-08-15T12:03:44-03:00'::timestamp with time zone,
  '2026-08-15T12:03:44-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  375, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'NORMA MONICA AMADIO',
  'CUIT',
  '27164281952',
  '2026-08-15T12:03:43-03:00'::timestamp with time zone,
  '2026-08-15T12:03:44-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  376, 1054315166, 'payment_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'guillermo',
  'CUIT',
  '20167866574',
  '2026-08-15T12:03:36-03:00'::timestamp with time zone,
  '2026-08-15T12:03:37-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  377, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Debora Vanesa Moreno',
  'CUIT',
  '27320495860',
  '2026-08-15T12:00:49-03:00'::timestamp with time zone,
  '2026-08-15T12:00:50-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  378, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'MARIA ALEJANDRA CASTRILLO',
  'CUIT',
  '27270916460',
  '2026-08-15T11:58:54-03:00'::timestamp with time zone,
  '2026-08-15T11:58:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127379376396'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  379, 1054315166, 'transfer_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-15T11:57:57-03:00'::timestamp with time zone,
  '2026-08-15T11:57:58-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127294560563'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  380, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'VILMA ESTHER CASTILLO',
  'CUIT',
  '27180954169',
  '2026-08-15T11:56:54-03:00'::timestamp with time zone,
  '2026-08-15T11:56:54-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  381, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Marco',
  'CUIT',
  '20338490322',
  '2026-08-15T11:54:17-03:00'::timestamp with time zone,
  '2026-08-15T11:54:17-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  382, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SERGIO DANIEL HENRIQUEZ',
  'CUIL',
  '20238194939',
  '2026-08-15T11:49:45-03:00'::timestamp with time zone,
  '2026-08-15T11:49:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  383, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'PAULA SARRAMONE',
  'CUIT',
  '23220538214',
  '2026-08-15T11:46:22-03:00'::timestamp with time zone,
  '2026-08-15T11:46:25-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127294135083'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  384, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Planeta equipamientos ',
  'CUIT',
  '20321891722',
  '2026-08-15T11:42:57-03:00'::timestamp with time zone,
  '2026-08-15T11:42:58-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  385, 1054315166, 'payment_in',
  13500.00, 13419.00, -81.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Angie Pich',
  'CUIT',
  '27955799149',
  '2026-08-15T11:40:02-03:00'::timestamp with time zone,
  '2026-08-15T11:40:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  386, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Fabiana Arias Valla',
  'CUIL',
  '27227309518',
  '2026-08-15T11:38:53-03:00'::timestamp with time zone,
  '2026-08-15T11:38:53-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  387, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Beja productos de la colmena',
  'CUIT',
  '20306088581',
  '2026-08-15T11:38:26-03:00'::timestamp with time zone,
  '2026-08-15T11:38:27-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  388, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'mirta cayutur',
  'CUIT',
  '27286776782',
  '2026-08-15T11:37:53-03:00'::timestamp with time zone,
  '2026-08-15T11:37:53-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  389, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'seba rost',
  'CUIT',
  '20277864569',
  '2026-08-15T11:36:01-03:00'::timestamp with time zone,
  '2026-08-15T11:36:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  390, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Liliana Esther Moron',
  'CUIL',
  '27144369942',
  '2026-08-15T11:35:06-03:00'::timestamp with time zone,
  '2026-08-15T11:35:06-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  391, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'MIRIAM GRACIELA BARILA',
  'CUIT',
  '23179895684',
  '2026-08-15T11:34:11-03:00'::timestamp with time zone,
  '2026-08-15T11:34:13-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127378437592'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  392, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'bucci',
  'CUIT',
  '20322716576',
  '2026-08-15T11:33:09-03:00'::timestamp with time zone,
  '2026-08-15T11:33:10-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  393, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Vicente ',
  'CUIL',
  '20244375821',
  '2026-08-15T11:27:49-03:00'::timestamp with time zone,
  '2026-08-15T11:27:49-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  394, 1054315166, 'payment_in',
  19500.00, 19383.00, -117.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'HECTOR CROCIATI',
  'CUIT',
  '20082114492',
  '2026-08-15T11:24:27-03:00'::timestamp with time zone,
  '2026-08-15T11:24:28-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  395, 1054315166, 'transfer_in',
  30000.00, 29820.00, -180.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'La Reina del Sur Miel',
  'CUIT',
  '27331847629',
  '2026-08-15T11:23:58-03:00'::timestamp with time zone,
  '2026-08-15T11:24:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127378096130'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  396, 1054315166, 'payment_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Jose Garcia Francisco Lago',
  'CUIT',
  '20254317730',
  '2026-08-15T11:22:20-03:00'::timestamp with time zone,
  '2026-08-15T11:22:20-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  397, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'N LIDA RAQUEL FLORES',
  'CUIT',
  '27323902521',
  '2026-08-15T11:19:10-03:00'::timestamp with time zone,
  '2026-08-15T11:19:10-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  398, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'FACUNDO MARTIN SIGILLI',
  'CUIL',
  '20306088549',
  '2026-08-15T11:18:58-03:00'::timestamp with time zone,
  '2026-08-15T11:18:58-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  399, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'la autentica',
  'CUIT',
  '27364977188',
  '2026-08-15T11:17:55-03:00'::timestamp with time zone,
  '2026-08-15T11:17:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  400, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'paola marcel',
  'CUIL',
  '27241346973',
  '2026-08-15T11:14:58-03:00'::timestamp with time zone,
  '2026-08-15T11:14:58-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  401, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Sergio Caballieri',
  'CUIL',
  '20201222339',
  '2026-08-15T11:11:29-03:00'::timestamp with time zone,
  '2026-08-15T11:11:29-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  402, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'cristian martin',
  'CUIT',
  '20301296860',
  '2026-08-15T11:11:25-03:00'::timestamp with time zone,
  '2026-08-15T11:11:26-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  403, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'STELLA MARIS RUGGERI',
  'CUIL',
  '27236386754',
  '2026-08-15T11:10:24-03:00'::timestamp with time zone,
  '2026-08-15T11:10:24-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  404, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ADRIAN FARID CHEBEIR',
  'CUIT',
  '20263042442',
  '2026-08-15T11:09:32-03:00'::timestamp with time zone,
  '2026-08-15T11:09:32-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  405, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Laura Haydée Segovia',
  'CUIT',
  '27147059200',
  '2026-08-15T11:09:30-03:00'::timestamp with time zone,
  '2026-08-15T11:09:30-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  406, 1054315166, 'transfer_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-15T11:03:54-03:00'::timestamp with time zone,
  '2026-08-15T11:03:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127292636499'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  407, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Kurmi Arcoíris',
  'CUIT',
  '27295048080',
  '2026-08-15T11:03:31-03:00'::timestamp with time zone,
  '2026-08-15T11:03:31-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  408, 1054315166, 'payment_in',
  3500.00, 3479.00, -21.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Juan Ignacio Llambi',
  'CUIT',
  '20352010627',
  '2026-08-15T11:01:11-03:00'::timestamp with time zone,
  '2026-08-15T11:01:12-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  409, 1054315166, 'transfer_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'los 25 de la 51',
  'CUIT',
  '23213152459',
  '2026-08-15T11:00:52-03:00'::timestamp with time zone,
  '2026-08-15T11:00:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127377290762'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  410, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ROCIO MARIANELLA MATEOS',
  'CUIL',
  '27419870825',
  '2026-08-15T11:00:03-03:00'::timestamp with time zone,
  '2026-08-15T11:00:04-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  411, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'María Belén Fernández',
  'CUIL',
  '27424029071',
  '2026-08-15T10:52:48-03:00'::timestamp with time zone,
  '2026-08-15T10:52:49-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  412, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maria Cevoli',
  'CUIT',
  '27241345381',
  '2026-08-15T10:50:25-03:00'::timestamp with time zone,
  '2026-08-15T10:50:25-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  413, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PABLO VERA',
  'CUIT',
  '20290890315',
  '2026-08-15T10:42:25-03:00'::timestamp with time zone,
  '2026-08-15T10:42:25-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  414, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Hilda Maria Huentelaf',
  'CUIT',
  '27144368342',
  '2026-08-15T10:40:44-03:00'::timestamp with time zone,
  '2026-08-15T10:40:45-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  415, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'iris mendoza',
  'CUIL',
  '27137124527',
  '2026-08-15T10:37:54-03:00'::timestamp with time zone,
  '2026-08-15T10:37:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  416, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Justo Daniel Cuello',
  'CUIT',
  '20166560897',
  '2026-08-15T10:36:55-03:00'::timestamp with time zone,
  '2026-08-15T10:36:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  417, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'VANESA NOEMI MIRTA FLORES',
  'CUIL',
  '27323902084',
  '2026-08-15T10:36:49-03:00'::timestamp with time zone,
  '2026-08-15T10:36:50-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  418, 1054315166, 'transfer_in',
  13500.00, 13419.00, -81.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-15T10:32:03-03:00'::timestamp with time zone,
  '2026-08-15T10:32:04-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127376408622'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  419, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Miryam Raquel Molina',
  'CUIT',
  '27170716391',
  '2026-08-15T10:31:52-03:00'::timestamp with time zone,
  '2026-08-15T10:31:53-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  420, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'alejandro coleffi',
  'CUIL',
  '20168625503',
  '2026-08-15T10:29:32-03:00'::timestamp with time zone,
  '2026-08-15T10:29:32-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  421, 1054315166, 'payment_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIA ROSA BARBARA',
  'CUIL',
  '27147059383',
  '2026-08-15T10:24:33-03:00'::timestamp with time zone,
  '2026-08-15T10:24:34-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  422, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lorenzo Mora',
  'CUIT',
  '20310633950',
  '2026-08-15T10:23:10-03:00'::timestamp with time zone,
  '2026-08-15T10:23:10-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  423, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIO DANIEL LORCA',
  'CUIT',
  '20207504549',
  '2026-08-15T10:22:54-03:00'::timestamp with time zone,
  '2026-08-15T10:22:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  424, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ana Buzzeo',
  'CUIL',
  '27200162434',
  '2026-08-15T10:18:51-03:00'::timestamp with time zone,
  '2026-08-15T10:18:51-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  425, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-15T10:15:16-03:00'::timestamp with time zone,
  '2026-08-15T10:15:16-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127291168521'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  426, 1054315166, 'transfer_in',
  13500.00, 13419.00, -81.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-15T10:14:45-03:00'::timestamp with time zone,
  '2026-08-15T10:14:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127291139227'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  427, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Gladys Beatriz Yanisky',
  'CUIL',
  '27171359843',
  '2026-08-15T10:14:02-03:00'::timestamp with time zone,
  '2026-08-15T10:14:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  428, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Carlos10',
  'CUIL',
  '20320495165',
  '2026-08-15T10:11:56-03:00'::timestamp with time zone,
  '2026-08-15T10:11:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  429, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mirian Gladys Guerrero',
  'CUIL',
  '27142053476',
  '2026-08-15T10:11:29-03:00'::timestamp with time zone,
  '2026-08-15T10:11:29-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  430, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'La lita',
  'CUIT',
  '27138239131',
  '2026-08-15T10:08:38-03:00'::timestamp with time zone,
  '2026-08-15T10:08:38-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  431, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Federico Tonini',
  'CUIT',
  '20376629547',
  '2026-08-15T10:07:04-03:00'::timestamp with time zone,
  '2026-08-15T10:07:04-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  432, 1054315166, 'transfer_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-15T10:06:18-03:00'::timestamp with time zone,
  '2026-08-15T10:06:18-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127375663634'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  433, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-15T10:03:38-03:00'::timestamp with time zone,
  '2026-08-15T10:03:38-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127290833989'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  434, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'HORACIO VIDAL FLORES',
  'CUIT',
  '20176414228',
  '2026-08-15T10:02:53-03:00'::timestamp with time zone,
  '2026-08-15T10:02:53-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  435, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'EDUARDO ALFREDO MOSER',
  'CUIT',
  '20244374221',
  '2026-08-15T10:01:26-03:00'::timestamp with time zone,
  '2026-08-15T10:01:26-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  436, 1054315166, 'transfer_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Angelica Romani',
  'CUIT',
  '27240547991',
  '2026-08-15T10:00:53-03:00'::timestamp with time zone,
  '2026-08-15T10:00:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127375546388'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  437, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'fernanda gorriti',
  'CUIT',
  '27278854057',
  '2026-08-15T09:59:35-03:00'::timestamp with time zone,
  '2026-08-15T09:59:36-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  438, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mnd',
  'CUIT',
  '23253444444',
  '2026-08-15T09:57:12-03:00'::timestamp with time zone,
  '2026-08-15T09:57:13-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  439, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'YAMILA VALERIA DIETZ',
  'CUIL',
  '23348761684',
  '2026-08-15T09:56:12-03:00'::timestamp with time zone,
  '2026-08-15T09:56:12-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  440, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'LUCRECIA MARCELA TORRES',
  'CUIT',
  '27299381701',
  '2026-08-15T09:54:31-03:00'::timestamp with time zone,
  '2026-08-15T09:54:32-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  441, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GABRIELA CALVO',
  'CUIT',
  '27230699920',
  '2026-08-15T09:52:42-03:00'::timestamp with time zone,
  '2026-08-15T09:52:43-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  442, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SUSANA ANGELICA ELGUETA',
  'CUIT',
  '27109946910',
  '2026-08-15T09:48:01-03:00'::timestamp with time zone,
  '2026-08-15T09:48:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  443, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'monica werner',
  'CUIT',
  '27206083986',
  '2026-08-15T09:44:21-03:00'::timestamp with time zone,
  '2026-08-15T09:44:22-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  444, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Hugo Alberto Cévoli',
  'CUIT',
  '20115339592',
  '2026-08-15T09:42:38-03:00'::timestamp with time zone,
  '2026-08-15T09:42:38-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  445, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'FAUSTO RODRIGO CENTENO',
  'CUIT',
  '23232015519',
  '2026-08-15T09:39:03-03:00'::timestamp with time zone,
  '2026-08-15T09:39:04-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  446, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Julieta Racca',
  'CUIL',
  '27176937756',
  '2026-08-15T09:33:17-03:00'::timestamp with time zone,
  '2026-08-15T09:33:18-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  447, 1054315166, 'transfer_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'JULIO LEANDRO FERMANELLI',
  'CUIT',
  '20227308762',
  '2026-08-15T09:30:30-03:00'::timestamp with time zone,
  '2026-08-15T09:30:32-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127290062871'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  448, 1054315166, 'payment_in',
  18000.00, 17892.00, -108.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'delvis Hecker',
  'CUIT',
  '20297261887',
  '2026-08-15T09:25:15-03:00'::timestamp with time zone,
  '2026-08-15T09:25:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  449, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-15T09:23:09-03:00'::timestamp with time zone,
  '2026-08-15T09:23:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127289908659'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  450, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Libreria Estudiando',
  'CUIT',
  '27105481549',
  '2026-08-15T09:22:01-03:00'::timestamp with time zone,
  '2026-08-15T09:22:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
