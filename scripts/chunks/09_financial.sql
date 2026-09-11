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
  451, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Liliana Recio',
  'CUIT',
  '27067233684',
  '2026-08-15T09:21:33-03:00'::timestamp with time zone,
  '2026-08-15T09:21:34-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  452, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Irma',
  'CUIL',
  '20271288973',
  '2026-08-15T09:19:43-03:00'::timestamp with time zone,
  '2026-08-15T09:19:43-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  453, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIELA FERNANDA BARRIONUEVO',
  'CUIT',
  '27261168796',
  '2026-08-15T09:19:08-03:00'::timestamp with time zone,
  '2026-08-15T09:19:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  454, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ariel Dario Barbieri',
  'CUIT',
  '20232528673',
  '2026-08-15T09:01:56-03:00'::timestamp with time zone,
  '2026-08-15T09:01:57-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  455, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'federico montoya',
  'CUIL',
  '23332451529',
  '2026-08-15T08:51:52-03:00'::timestamp with time zone,
  '2026-08-15T08:51:52-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  456, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PABLO SOLANO',
  'CUIT',
  '20221243928',
  '2026-08-15T08:49:34-03:00'::timestamp with time zone,
  '2026-08-15T08:49:35-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  457, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Tercer Set',
  'CUIT',
  '20288685208',
  '2026-08-15T08:48:56-03:00'::timestamp with time zone,
  '2026-08-15T08:48:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  458, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Claudio Carlos Parra',
  'CUIL',
  '20139897642',
  '2026-08-15T08:45:14-03:00'::timestamp with time zone,
  '2026-08-15T08:45:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  459, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ALDA CINTIA LUCRECIA VALLA',
  'CUIL',
  '27314551058',
  '2026-08-15T08:21:58-03:00'::timestamp with time zone,
  '2026-08-15T08:21:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  460, 1054315166, 'payment_in',
  66000.00, 65604.00, -396.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'DESPENSA EL TILO',
  'CUIT',
  '20218114211',
  '2026-08-15T07:50:31-03:00'::timestamp with time zone,
  '2026-08-15T07:50:32-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  461, 1054315166, 'payment_out',
  -116033.00, -116729.20, -696.20,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-15T07:49:44-03:00'::timestamp with time zone,
  '2026-08-15T07:49:45-03:00'::timestamp with time zone,
  '43630076905',
  '146454735',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  462, 1054315166, 'payment_out',
  -140012.06, -140852.13, -840.07,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-14T08:10:26-03:00'::timestamp with time zone,
  '2026-08-14T08:10:26-03:00'::timestamp with time zone,
  '43631806444',
  'e3fe5089-0335-4b56-8107-673edb9b6ebe',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  463, 1054315166, 'yield',
  1743.79, 1743.79, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-14T04:58:34-03:00'::timestamp with time zone,
  '2026-08-14T04:58:34-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  464, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Cuadrito',
  'CUIL',
  '27333687254',
  '2026-08-13T18:55:59-03:00'::timestamp with time zone,
  '2026-08-13T18:55:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  465, 1054315166, 'payment_out',
  -260000.00, -261560.00, -1560.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-13T17:54:05-03:00'::timestamp with time zone,
  '2026-08-13T17:54:05-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  466, 1054315166, 'yield',
  1872.34, 1872.34, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-13T05:51:48-03:00'::timestamp with time zone,
  '2026-08-13T05:51:48-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  467, 1054315166, 'payment_out',
  -45033.00, -45303.20, -270.20,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-12T21:23:54-03:00'::timestamp with time zone,
  '2026-08-12T21:23:54-03:00'::timestamp with time zone,
  '43527988713',
  '146113865',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  468, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maria Daniela Damboria',
  'CUIT',
  '27181245374',
  '2026-08-12T19:52:36-03:00'::timestamp with time zone,
  '2026-08-12T19:52:36-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  469, 1054315166, 'payment_in',
  143999.99, 143135.99, -864.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'EL KEROSENERO SA',
  'CUIT',
  '30717165078',
  '2026-08-12T12:21:56-03:00'::timestamp with time zone,
  '2026-08-12T12:21:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  470, 1054315166, 'payment_in',
  36000.00, 35784.00, -216.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'HiHat Experience',
  'CUIL',
  '23423011599',
  '2026-08-12T10:31:45-03:00'::timestamp with time zone,
  '2026-08-12T10:31:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  471, 1054315166, 'yield',
  1639.58, 1639.58, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-12T02:05:19-03:00'::timestamp with time zone,
  '2026-08-12T02:05:19-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  472, 1054315166, 'payment_in',
  234000.00, 232596.00, -1404.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mrpolloviedma1',
  'CUIT',
  '27145276417',
  '2026-08-11T22:00:45-03:00'::timestamp with time zone,
  '2026-08-11T22:00:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  473, 1054315166, 'payment_in',
  78000.00, 77532.00, -468.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'lu',
  'CUIT',
  '20255457072',
  '2026-08-11T21:36:45-03:00'::timestamp with time zone,
  '2026-08-11T21:36:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  474, 1054315166, 'transfer_in',
  75000.00, 74550.00, -450.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-11T21:27:45-03:00'::timestamp with time zone,
  '2026-08-11T21:27:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127272187132'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  475, 1054315166, 'payment_out',
  -124643.81, -125391.67, -747.86,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-11T20:24:41-03:00'::timestamp with time zone,
  '2026-08-11T20:24:42-03:00'::timestamp with time zone,
  '43531419694',
  '328edcee-3ce1-4b56-bb45-c181f412d34a',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  476, 1054315166, 'yield',
  1615.20, 1615.20, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-11T03:58:59-03:00'::timestamp with time zone,
  '2026-08-11T03:58:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  477, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Lucrecia Guttmann',
  'CUIL',
  '27349589031',
  '2026-08-10T20:46:44-03:00'::timestamp with time zone,
  '2026-08-10T20:46:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127240438304'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  478, 1054315166, 'payment_in',
  292000.00, 290248.00, -1752.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Autoservicio ailen ',
  'CUIT',
  '20339867012',
  '2026-08-10T14:15:55-03:00'::timestamp with time zone,
  '2026-08-10T14:15:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  479, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'CARLOS MANUEL IERACITANO',
  'CUIT',
  '20226615211',
  '2026-08-10T11:09:34-03:00'::timestamp with time zone,
  '2026-08-10T11:09:34-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  480, 1054315166, 'yield',
  2213.91, 2213.91, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-10T03:23:30-03:00'::timestamp with time zone,
  '2026-08-10T03:23:30-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  481, 1054315166, 'payment_in',
  33000.00, 32802.00, -198.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIANA SACCHETTI',
  'CUIL',
  '27426534938',
  '2026-08-09T21:17:55-03:00'::timestamp with time zone,
  '2026-08-09T21:17:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  482, 1054315166, 'payment_in',
  21000.00, 20874.00, -126.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'club',
  'CUIL',
  '27285136151',
  '2026-08-09T20:30:17-03:00'::timestamp with time zone,
  '2026-08-09T20:30:17-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  483, 1054315166, 'payment_out',
  -20000.00, -20120.00, -120.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-09T14:35:20-03:00'::timestamp with time zone,
  '2026-08-09T14:35:21-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  484, 1054315166, 'transfer_in',
  78000.00, 77532.00, -468.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T18:03:37-03:00'::timestamp with time zone,
  '2026-08-08T18:03:37-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127176077002'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  485, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Maria Daniela Damboria',
  'CUIT',
  '27181245374',
  '2026-08-08T14:30:27-03:00'::timestamp with time zone,
  '2026-08-08T14:30:28-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  486, 1054315166, 'payment_in',
  200000.00, 198800.00, -1200.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'marcial',
  'CUIT',
  '20927193257',
  '2026-08-08T12:48:08-03:00'::timestamp with time zone,
  '2026-08-08T12:48:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  487, 1054315166, 'payment_in',
  117000.00, 116298.00, -702.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Puesto 92',
  'CUIT',
  '27943603745',
  '2026-08-08T12:45:33-03:00'::timestamp with time zone,
  '2026-08-08T12:45:33-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  488, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Odontología Dr Rial',
  'CUIT',
  '20208076494',
  '2026-08-08T12:30:17-03:00'::timestamp with time zone,
  '2026-08-08T12:30:17-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  489, 1054315166, 'transfer_in',
  3500.00, 3479.00, -21.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T11:49:42-03:00'::timestamp with time zone,
  '2026-08-08T11:49:42-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127162477610'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  490, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'NICOLÁS ANDRÉS FRATTINI',
  'CUIT',
  '20349589266',
  '2026-08-08T11:48:48-03:00'::timestamp with time zone,
  '2026-08-08T11:48:49-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  491, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Aldi',
  'CUIT',
  '27380838570',
  '2026-08-08T11:47:54-03:00'::timestamp with time zone,
  '2026-08-08T11:47:54-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  492, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ELVIA RODRIGUEZ',
  'CUIL',
  '27102136131',
  '2026-08-08T11:46:59-03:00'::timestamp with time zone,
  '2026-08-08T11:47:00-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  493, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T11:45:19-03:00'::timestamp with time zone,
  '2026-08-08T11:45:19-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127162281686'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  494, 1054315166, 'payment_in',
  24000.00, 23856.00, -144.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Leonardo Namur',
  'CUIT',
  '20313594131',
  '2026-08-08T11:44:38-03:00'::timestamp with time zone,
  '2026-08-08T11:44:39-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  495, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T11:44:37-03:00'::timestamp with time zone,
  '2026-08-08T11:44:38-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127162249960'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  496, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MIGUEL MARCELO CALVO',
  'CUIT',
  '20221243634',
  '2026-08-08T11:44:23-03:00'::timestamp with time zone,
  '2026-08-08T11:44:24-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  497, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'RDInd',
  'CUIT',
  '27306491356',
  '2026-08-08T11:43:32-03:00'::timestamp with time zone,
  '2026-08-08T11:43:33-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  498, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'COVEN MZMG',
  'CUIL',
  '27413589512',
  '2026-08-08T11:42:12-03:00'::timestamp with time zone,
  '2026-08-08T11:42:13-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  499, 1054315166, 'payment_in',
  5000.00, 4970.00, -30.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Jessica gasperoni',
  'CUIL',
  '27332484031',
  '2026-08-08T11:42:03-03:00'::timestamp with time zone,
  '2026-08-08T11:42:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  500, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'credit_card',
  'master',
  'gustavo franchello',
  'CUIT',
  '23230639019',
  '2026-08-08T11:39:56-03:00'::timestamp with time zone,
  '2026-08-08T11:39:58-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  501, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T11:38:32-03:00'::timestamp with time zone,
  '2026-08-08T11:38:32-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127077656839'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  502, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Nicole Bari ',
  'CUIT',
  '27397438525',
  '2026-08-08T11:35:55-03:00'::timestamp with time zone,
  '2026-08-08T11:35:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  503, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ANA LAURA VIGLIONE',
  'CUIL',
  '27334165626',
  '2026-08-08T11:34:03-03:00'::timestamp with time zone,
  '2026-08-08T11:34:04-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  504, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'delfin venancio pardo',
  'CUIT',
  '20138129064',
  '2026-08-08T11:32:34-03:00'::timestamp with time zone,
  '2026-08-08T11:32:35-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  505, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PABLO SOLANO',
  'CUIT',
  '20221243928',
  '2026-08-08T11:31:11-03:00'::timestamp with time zone,
  '2026-08-08T11:31:12-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  506, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ALEJANDRO ALBERTO AGRA',
  'CUIT',
  '20149023098',
  '2026-08-08T11:30:15-03:00'::timestamp with time zone,
  '2026-08-08T11:30:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  507, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ALFONSO GIMENEZ MELLUSO',
  'CUIT',
  '20327947789',
  '2026-08-08T11:29:11-03:00'::timestamp with time zone,
  '2026-08-08T11:29:12-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  508, 1054315166, 'transfer_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T11:28:37-03:00'::timestamp with time zone,
  '2026-08-08T11:28:38-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127161611368'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  509, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T11:28:24-03:00'::timestamp with time zone,
  '2026-08-08T11:28:25-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127161597478'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  510, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Hernan bocci',
  'CUIT',
  '20300899545',
  '2026-08-08T11:26:57-03:00'::timestamp with time zone,
  '2026-08-08T11:26:57-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  511, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Alejandro Lezcano',
  'CUIT',
  '20271956763',
  '2026-08-08T11:24:23-03:00'::timestamp with time zone,
  '2026-08-08T11:24:24-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  512, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Carlos Lugani',
  'CUIT',
  '20219819022',
  '2026-08-08T11:23:37-03:00'::timestamp with time zone,
  '2026-08-08T11:23:37-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  513, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mauro Darío Armas',
  'CUIT',
  '20179897122',
  '2026-08-08T11:22:19-03:00'::timestamp with time zone,
  '2026-08-08T11:22:19-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  514, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Martin Nicolas Abdala',
  'CUIT',
  '20303668978',
  '2026-08-08T11:21:57-03:00'::timestamp with time zone,
  '2026-08-08T11:21:58-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  515, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Juan Domingo Díaz',
  'CUIT',
  '20162178645',
  '2026-08-08T11:16:13-03:00'::timestamp with time zone,
  '2026-08-08T11:16:13-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  516, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'EDUARDO MENDEZ',
  'CUIT',
  '20185615309',
  '2026-08-08T11:15:22-03:00'::timestamp with time zone,
  '2026-08-08T11:15:23-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  517, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Jorge Farabello',
  'CUIL',
  '20291708219',
  '2026-08-08T11:11:37-03:00'::timestamp with time zone,
  '2026-08-08T11:11:37-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  518, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Alejandro Ferrara',
  'CUIT',
  '20305560112',
  '2026-08-08T11:08:09-03:00'::timestamp with time zone,
  '2026-08-08T11:08:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  519, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'CAROLINA CAMACHO',
  'CUIT',
  '27245080498',
  '2026-08-08T11:06:24-03:00'::timestamp with time zone,
  '2026-08-08T11:06:24-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  520, 1054315166, 'transfer_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'MARIA MAGDALENA RIVAS',
  'CUIT',
  '27297260494',
  '2026-08-08T11:04:30-03:00'::timestamp with time zone,
  '2026-08-08T11:04:32-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127160685618'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  521, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T10:59:00-03:00'::timestamp with time zone,
  '2026-08-08T10:59:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127160500250'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  522, 1054315166, 'payment_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Jose Garcia Francisco Lago',
  'CUIT',
  '20254317730',
  '2026-08-08T10:56:07-03:00'::timestamp with time zone,
  '2026-08-08T10:56:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  523, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T10:53:42-03:00'::timestamp with time zone,
  '2026-08-08T10:53:43-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127160287962'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  524, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Hector Hernandez',
  'CUIT',
  '20171359563',
  '2026-08-08T10:52:08-03:00'::timestamp with time zone,
  '2026-08-08T10:52:09-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  525, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIA VANESA SURIN',
  'CUIT',
  '27263530891',
  '2026-08-08T10:50:25-03:00'::timestamp with time zone,
  '2026-08-08T10:50:25-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  526, 1054315166, 'payment_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'alejandro coleffi',
  'CUIL',
  '20168625503',
  '2026-08-08T10:48:33-03:00'::timestamp with time zone,
  '2026-08-08T10:48:33-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  527, 1054315166, 'transfer_in',
  1500.00, 1491.00, -9.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T10:45:30-03:00'::timestamp with time zone,
  '2026-08-08T10:45:31-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127075666507'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  528, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T10:44:41-03:00'::timestamp with time zone,
  '2026-08-08T10:44:41-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127075619467'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  529, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'CLEMENTE ARAMENDI',
  'CUIT',
  '20176938022',
  '2026-08-08T10:44:16-03:00'::timestamp with time zone,
  '2026-08-08T10:44:17-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  530, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Tiny',
  'CUIL',
  '23174647534',
  '2026-08-08T10:41:36-03:00'::timestamp with time zone,
  '2026-08-08T10:41:36-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  531, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Julio Nadal',
  'CUIL',
  '20206902184',
  '2026-08-08T10:41:20-03:00'::timestamp with time zone,
  '2026-08-08T10:41:20-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  532, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Vicente ',
  'CUIL',
  '20244375821',
  '2026-08-08T10:40:56-03:00'::timestamp with time zone,
  '2026-08-08T10:40:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  533, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIO DANIEL LORCA',
  'CUIT',
  '20207504549',
  '2026-08-08T10:38:38-03:00'::timestamp with time zone,
  '2026-08-08T10:38:39-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  534, 1054315166, 'transfer_in',
  21000.00, 20874.00, -126.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T10:38:01-03:00'::timestamp with time zone,
  '2026-08-08T10:38:01-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127075408763'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  535, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Carlos10',
  'CUIL',
  '20320495165',
  '2026-08-08T10:37:11-03:00'::timestamp with time zone,
  '2026-08-08T10:37:12-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  536, 1054315166, 'transfer_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T10:31:56-03:00'::timestamp with time zone,
  '2026-08-08T10:31:56-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127159551554'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  537, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Luci Cornou',
  'CUIL',
  '27280211759',
  '2026-08-08T10:30:43-03:00'::timestamp with time zone,
  '2026-08-08T10:30:44-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  538, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'ADRIAN OLIVETTI',
  'CUIT',
  '20169675946',
  '2026-08-08T10:30:04-03:00'::timestamp with time zone,
  '2026-08-08T10:30:05-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  539, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Gustavo Carnevale',
  'CUIT',
  '20246483427',
  '2026-08-08T10:24:58-03:00'::timestamp with time zone,
  '2026-08-08T10:24:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  540, 1054315166, 'payment_in',
  13500.00, 13419.00, -81.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Federico Tonini',
  'CUIT',
  '20376629547',
  '2026-08-08T10:23:26-03:00'::timestamp with time zone,
  '2026-08-08T10:23:26-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  541, 1054315166, 'transfer_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T10:23:05-03:00'::timestamp with time zone,
  '2026-08-08T10:23:06-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127074903725'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  542, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Fabi Schw',
  'CUIL',
  '27220907592',
  '2026-08-08T10:21:45-03:00'::timestamp with time zone,
  '2026-08-08T10:21:47-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127074855747'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  543, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'CARLOS LIZARRALDE',
  'CUIL',
  '20144635826',
  '2026-08-08T10:21:35-03:00'::timestamp with time zone,
  '2026-08-08T10:21:36-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  544, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'sofia quiriconi',
  'CUIT',
  '27355915439',
  '2026-08-08T10:19:25-03:00'::timestamp with time zone,
  '2026-08-08T10:19:26-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  545, 1054315166, 'payment_in',
  39000.00, 38766.00, -234.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Hector Masajes',
  'CUIT',
  '23231216979',
  '2026-08-08T10:18:03-03:00'::timestamp with time zone,
  '2026-08-08T10:18:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  546, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Milene Marie Rica',
  'CUIL',
  '23265463754',
  '2026-08-08T10:13:58-03:00'::timestamp with time zone,
  '2026-08-08T10:13:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  547, 1054315166, 'transfer_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T10:13:07-03:00'::timestamp with time zone,
  '2026-08-08T10:13:07-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127158966802'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  548, 1054315166, 'transfer_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T10:08:00-03:00'::timestamp with time zone,
  '2026-08-08T10:08:00-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127158820052'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  549, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Ezequiel Fazio',
  'CUIL',
  '20330025213',
  '2026-08-08T10:01:40-03:00'::timestamp with time zone,
  '2026-08-08T10:01:41-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  550, 1054315166, 'transfer_in',
  18000.00, 17892.00, -108.00,
  NULL, 0.6000,
  'bank_transfer',
  'debin_transfer',
  'Remeruli',
  'CUIT',
  '20364975741',
  '2026-08-08T09:55:52-03:00'::timestamp with time zone,
  '2026-08-08T09:55:54-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127158445320'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  551, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mirian Edith Dominguez',
  'CUIL',
  '27179361626',
  '2026-08-08T09:50:51-03:00'::timestamp with time zone,
  '2026-08-08T09:50:52-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  552, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Nai',
  'CUIL',
  '27425390932',
  '2026-08-08T09:46:23-03:00'::timestamp with time zone,
  '2026-08-08T09:46:24-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  553, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Pasionarte',
  'CUIT',
  '27267948653',
  '2026-08-08T09:45:23-03:00'::timestamp with time zone,
  '2026-08-08T09:45:24-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  554, 1054315166, 'payment_in',
  18000.00, 17892.00, -108.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'SERGIO DANIEL CAMPOS',
  'CUIT',
  '20246567205',
  '2026-08-08T09:41:57-03:00'::timestamp with time zone,
  '2026-08-08T09:41:57-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  555, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARCOS HERNAN SELEIMAN',
  'CUIT',
  '20256953502',
  '2026-08-08T09:30:35-03:00'::timestamp with time zone,
  '2026-08-08T09:30:35-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  556, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRACIELA MILET SANCHEZ',
  'CUIT',
  '27201222457',
  '2026-08-08T09:27:02-03:00'::timestamp with time zone,
  '2026-08-08T09:27:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  557, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Adelicia',
  'CUIL',
  '27380835997',
  '2026-08-08T09:20:06-03:00'::timestamp with time zone,
  '2026-08-08T09:20:07-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  558, 1054315166, 'transfer_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-08T09:14:35-03:00'::timestamp with time zone,
  '2026-08-08T09:14:35-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127073054895'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  559, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'MARIELA FERNANDA BARRIONUEVO',
  'CUIT',
  '27261168796',
  '2026-08-08T09:12:05-03:00'::timestamp with time zone,
  '2026-08-08T09:12:06-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  560, 1054315166, 'payment_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'delvis Hecker',
  'CUIT',
  '20297261887',
  '2026-08-08T09:03:29-03:00'::timestamp with time zone,
  '2026-08-08T09:03:30-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  561, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PaOo Calderon',
  'CUIL',
  '27341739034',
  '2026-08-08T09:02:58-03:00'::timestamp with time zone,
  '2026-08-08T09:02:59-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  562, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Julieta Racca',
  'CUIL',
  '27176937756',
  '2026-08-08T09:02:16-03:00'::timestamp with time zone,
  '2026-08-08T09:02:16-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  563, 1054315166, 'payment_in',
  6000.00, 5964.00, -36.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Liliana Recio',
  'CUIT',
  '27067233684',
  '2026-08-08T09:00:43-03:00'::timestamp with time zone,
  '2026-08-08T09:00:44-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  564, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'credit_card',
  'visa',
  'zonaXx',
  'CUIL',
  '20372130971',
  '2026-08-08T08:51:56-03:00'::timestamp with time zone,
  '2026-08-08T08:51:58-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  565, 1054315166, 'payment_in',
  22500.00, 22365.00, -135.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'PABLO VERA',
  'CUIT',
  '20290890315',
  '2026-08-08T08:49:14-03:00'::timestamp with time zone,
  '2026-08-08T08:49:15-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  566, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Marcos Saez',
  'CUIT',
  '20272921327',
  '2026-08-08T08:42:04-03:00'::timestamp with time zone,
  '2026-08-08T08:42:05-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  567, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Pablo Dalponte',
  'CUIL',
  '20296219348',
  '2026-08-08T08:38:54-03:00'::timestamp with time zone,
  '2026-08-08T08:38:54-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  568, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'DANIEL ENRIQUE TORRES',
  'CUIT',
  '20228348393',
  '2026-08-08T08:29:41-03:00'::timestamp with time zone,
  '2026-08-08T08:29:41-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  569, 1054315166, 'payment_in',
  12000.00, 11928.00, -72.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'LUCIANA SANCOCHIA',
  'CUIT',
  '27355973501',
  '2026-08-08T08:19:54-03:00'::timestamp with time zone,
  '2026-08-08T08:19:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  570, 1054315166, 'payment_in',
  15000.00, 14910.00, -90.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'LUCIANA GARCIA CABEZON',
  'CUIT',
  '27282978917',
  '2026-08-08T08:16:54-03:00'::timestamp with time zone,
  '2026-08-08T08:16:55-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  571, 1054315166, 'payment_in',
  128000.00, 127232.00, -768.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'DESPENSA EL TILO',
  'CUIT',
  '20218114211',
  '2026-08-08T08:02:03-03:00'::timestamp with time zone,
  '2026-08-08T08:02:04-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  572, 1054315166, 'payment_in',
  33000.00, 32802.00, -198.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Matias Margiotta',
  'CUIL',
  '20298982626',
  '2026-08-07T16:38:02-03:00'::timestamp with time zone,
  '2026-08-07T16:38:03-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  573, 1054315166, 'transfer_in',
  14000.00, 13916.00, -84.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-07T11:32:15-03:00'::timestamp with time zone,
  '2026-08-07T11:32:16-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '127123483608'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  574, 1054315166, 'yield',
  729.46, 729.46, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-07T07:53:46-03:00'::timestamp with time zone,
  '2026-08-07T07:53:46-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  575, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Higiene y Control',
  'CUIL',
  '20330965399',
  '2026-08-06T21:02:10-03:00'::timestamp with time zone,
  '2026-08-06T21:02:11-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  576, 1054315166, 'payment_out',
  -44014.00, -44278.08, -264.08,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-06T21:00:55-03:00'::timestamp with time zone,
  '2026-08-06T21:00:56-03:00'::timestamp with time zone,
  '43361364089',
  '145229096',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  577, 1054315166, 'payment_in',
  234000.00, 232596.00, -1404.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mrpolloviedma2',
  'CUIT',
  '27372128599',
  '2026-08-06T12:42:05-03:00'::timestamp with time zone,
  '2026-08-06T12:42:06-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  578, 1054315166, 'payment_out',
  -170000.00, -171020.00, -1020.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-06T09:58:19-03:00'::timestamp with time zone,
  '2026-08-06T09:58:20-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  579, 1054315166, 'yield',
  754.57, 754.57, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-06T05:52:00-03:00'::timestamp with time zone,
  '2026-08-06T05:52:00-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  580, 1054315166, 'payment_out',
  -75670.41, -76124.43, -454.02,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-05T22:51:06-03:00'::timestamp with time zone,
  '2026-08-05T22:51:07-03:00'::timestamp with time zone,
  '43365597322',
  '23895b6b-93ae-4db3-aaf3-de2d36041c80',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  581, 1054315166, 'payment_in',
  72000.00, 71568.00, -432.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Bachin',
  'CUIT',
  '20269991462',
  '2026-08-05T20:54:01-03:00'::timestamp with time zone,
  '2026-08-05T20:54:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  582, 1054315166, 'payment_in',
  354000.00, 351876.00, -2124.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'jorgito',
  'CUIT',
  '20349588456',
  '2026-08-05T17:32:16-03:00'::timestamp with time zone,
  '2026-08-05T17:32:17-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  583, 1054315166, 'payment_in',
  234000.00, 232596.00, -1404.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mrpolloviedma2',
  'CUIT',
  '27372128599',
  '2026-08-05T12:53:06-03:00'::timestamp with time zone,
  '2026-08-05T12:53:06-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  584, 1054315166, 'payment_in',
  66000.00, 65604.00, -396.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lo de Luca',
  'CUIT',
  '27358247267',
  '2026-08-05T11:14:34-03:00'::timestamp with time zone,
  '2026-08-05T11:14:35-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  585, 1054315166, 'yield',
  1230.80, 1230.80, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-05T06:02:53-03:00'::timestamp with time zone,
  '2026-08-05T06:02:53-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  586, 1054315166, 'payment_out',
  -77670.09, -78136.11, -466.02,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-04T22:43:56-03:00'::timestamp with time zone,
  '2026-08-04T22:43:56-03:00'::timestamp with time zone,
  '43337917922',
  'bf1fc1b0-ad25-4791-b103-f3070db0454c',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  587, 1054315166, 'payment_in',
  66000.00, 65604.00, -396.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Matias Margiotta',
  'CUIL',
  '20298982626',
  '2026-08-04T12:17:47-03:00'::timestamp with time zone,
  '2026-08-04T12:17:48-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  588, 1054315166, 'yield',
  1220.63, 1220.63, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-04T05:01:10-03:00'::timestamp with time zone,
  '2026-08-04T05:01:10-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  589, 1054315166, 'transfer_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'bank_transfer',
  'cvu',
  NULL,
  NULL,
  NULL,
  '2026-08-03T20:17:38-03:00'::timestamp with time zone,
  '2026-08-03T20:17:39-03:00'::timestamp with time zone,
  NULL,
  NULL,
  '126923565049'
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  590, 1054315166, 'payment_in',
  7500.00, 7455.00, -45.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Lucía Zamborán',
  'CUIT',
  '27317284859',
  '2026-08-03T14:17:26-03:00'::timestamp with time zone,
  '2026-08-03T14:17:27-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  591, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Natalia Pastelería',
  'CUIT',
  '27263043850',
  '2026-08-03T10:22:01-03:00'::timestamp with time zone,
  '2026-08-03T10:22:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  592, 1054315166, 'yield',
  297.48, 297.48, 0.00,
  NULL, NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-03T04:46:02-03:00'::timestamp with time zone,
  '2026-08-03T04:46:02-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  593, 1054315166, 'payment_in',
  324000.00, 322056.00, -1944.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Mandi',
  'CUIT',
  '20170676425',
  '2026-08-02T20:30:17-03:00'::timestamp with time zone,
  '2026-08-02T20:30:18-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  594, 1054315166, 'payment_in',
  7000.00, 6958.00, -42.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Odontología Dr Rial',
  'CUIT',
  '20208076494',
  '2026-08-01T20:33:35-03:00'::timestamp with time zone,
  '2026-08-01T20:33:35-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  595, 1054315166, 'payment_out',
  -117014.00, -117716.08, -702.08,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'GRANJA SANTO TOMAS S. A. S.',
  'CUIT',
  '30719089891',
  '2026-08-01T19:48:37-03:00'::timestamp with time zone,
  '2026-08-01T19:48:37-03:00'::timestamp with time zone,
  '43225391109',
  '144531355',
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  596, 1054315166, 'payment_in',
  243000.00, 241542.00, -1458.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'freddy',
  'CUIT',
  '23943241759',
  '2026-08-01T14:39:05-03:00'::timestamp with time zone,
  '2026-08-01T14:39:05-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  597, 1054315166, 'payment_in',
  500000.00, 497000.00, -3000.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'marcial',
  'CUIT',
  '20927193257',
  '2026-08-01T14:29:30-03:00'::timestamp with time zone,
  '2026-08-01T14:29:30-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  598, 1054315166, 'payment_in',
  5500.00, 5467.00, -33.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Juanvidal',
  'CUIT',
  '20232704617',
  '2026-08-01T12:18:18-03:00'::timestamp with time zone,
  '2026-08-01T12:18:19-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  599, 1054315166, 'payment_in',
  11000.00, 10934.00, -66.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'Silvia Mabel Calvo',
  'CUIL',
  '27171357913',
  '2026-08-01T12:17:51-03:00'::timestamp with time zone,
  '2026-08-01T12:17:51-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
INSERT INTO mp_financial_movement (
  id, account_id, movement_class,
  transaction_amount, settlement_amount, tax_amount,
  tax_detail, tax_percentage,
  payment_method, payment_detail,
  payer_name, payer_id_type, payer_id_number,
  transaction_date, settlement_date,
  order_id, external_reference, bank_transfer_id
) VALUES (
  600, 1054315166, 'payment_in',
  16500.00, 16401.00, -99.00,
  NULL, 0.6000,
  'available_money',
  'available_money',
  'juan carlos gonzales',
  'CUIT',
  '20188024182',
  '2026-08-01T12:17:08-03:00'::timestamp with time zone,
  '2026-08-01T12:17:08-03:00'::timestamp with time zone,
  NULL,
  NULL,
  NULL
) ON CONFLICT DO NOTHING;
