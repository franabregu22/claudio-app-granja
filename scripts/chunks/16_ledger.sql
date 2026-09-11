SET CONSTRAINTS ALL DEFERRED;

INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  1, 1054315166, 1,
  232596.00, 'income',
  'SOURCE_ID=176584213670', 'Autoservicio ailen ',
  'movement_class=payment_in',
  '2026-08-31T19:23:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  2, 1054315166, 2,
  38766.00, 'income',
  'SOURCE_ID=175563321995', 'Matias Margiotta',
  'movement_class=payment_in',
  '2026-08-31T12:53:21-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  3, 1054315166, 3,
  14910.00, 'income',
  'SOURCE_ID=175542083357', 'miel el jarillal',
  'movement_class=payment_in',
  '2026-08-31T10:57:39-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  4, 1054315166, 4,
  35784.00, 'income',
  'SOURCE_ID=175537656939', 'La casa de Carlos ',
  'movement_class=payment_in',
  '2026-08-31T10:28:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  5, 1054315166, 5,
  5872.14, 'interest_income',
  'SOURCE_ID=1749167287611', '',
  'movement_class=yield',
  '2026-08-31T03:32:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  6, 1054315166, 6,
  -100600.00, 'expense',
  'SOURCE_ID=176283687808', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-29T19:29:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  7, 1054315166, 7,
  -173032.00, 'expense',
  'SOURCE_ID=176283631622', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-29T19:29:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  8, 1054315166, 8,
  155064.00, 'income',
  'SOURCE_ID=175287666541', 'Choque Casimiro Riquelme',
  'movement_class=payment_in',
  '2026-08-29T14:30:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  9, 1054315166, 9,
  38766.00, 'income',
  'SOURCE_ID=176236452138', 'LAURA INES CAUCOTA FERNANDEZ',
  'movement_class=payment_in',
  '2026-08-29T14:28:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  10, 1054315166, 10,
  14910.00, 'income',
  'SOURCE_ID=176230881368', 'STELLA MARIS APARICIO',
  'movement_class=payment_in',
  '2026-08-29T13:56:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  11, 1054315166, 11,
  6461.00, 'income',
  'SOURCE_ID=176230724124', 'Silvia Nieto',
  'movement_class=payment_in',
  '2026-08-29T13:52:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  12, 1054315166, 12,
  6461.00, 'income',
  'SOURCE_ID=176228435962', 'SERGIO RUBEN GIANNI',
  'movement_class=payment_in',
  '2026-08-29T13:43:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  13, 1054315166, 13,
  6461.00, 'transfer',
  'SOURCE_ID=176227327926', 'MARIA JOSE ROMAN',
  'movement_class=transfer_in',
  '2026-08-29T13:36:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  14, 1054315166, 14,
  6461.00, 'transfer',
  'SOURCE_ID=176227548212', '',
  'movement_class=transfer_in',
  '2026-08-29T13:34:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  15, 1054315166, 15,
  7455.00, 'income',
  'SOURCE_ID=176226501336', 'MARIA ALEJANDRA PEÑA',
  'movement_class=payment_in',
  '2026-08-29T13:29:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  16, 1054315166, 16,
  7455.00, 'transfer',
  'SOURCE_ID=176225314476', '',
  'movement_class=transfer_in',
  '2026-08-29T13:21:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  17, 1054315166, 17,
  7455.00, 'transfer',
  'SOURCE_ID=175275277417', '',
  'movement_class=transfer_in',
  '2026-08-29T13:15:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  18, 1054315166, 18,
  7455.00, 'income',
  'SOURCE_ID=175275291283', 'alicia rickert',
  'movement_class=payment_in',
  '2026-08-29T13:15:50-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  19, 1054315166, 19,
  14910.00, 'income',
  'SOURCE_ID=175274991423', 'Federic11',
  'movement_class=payment_in',
  '2026-08-29T13:14:29-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  20, 1054315166, 20,
  7455.00, 'transfer',
  'SOURCE_ID=175275025263', '',
  'movement_class=transfer_in',
  '2026-08-29T13:14:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  21, 1054315166, 21,
  6461.00, 'income',
  'SOURCE_ID=175274900221', 'ULISES DANIEL BELIU',
  'movement_class=payment_in',
  '2026-08-29T13:11:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  22, 1054315166, 22,
  3479.00, 'income',
  'SOURCE_ID=175273077783', 'Lic Lorena Canteros',
  'movement_class=payment_in',
  '2026-08-29T13:04:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  23, 1054315166, 23,
  7455.00, 'income',
  'SOURCE_ID=175273370263', 'LILIANA ELIZABETH WALTER',
  'movement_class=payment_in',
  '2026-08-29T13:03:31-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  24, 1054315166, 24,
  7455.00, 'income',
  'SOURCE_ID=176221882644', 'Beto Trom',
  'movement_class=payment_in',
  '2026-08-29T13:02:43-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  25, 1054315166, 25,
  7455.00, 'income',
  'SOURCE_ID=175271513723', 'Paula Crespo',
  'movement_class=payment_in',
  '2026-08-29T12:56:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  26, 1054315166, 26,
  7455.00, 'income',
  'SOURCE_ID=175271267125', 'Africa accesorios',
  'movement_class=payment_in',
  '2026-08-29T12:53:43-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  27, 1054315166, 27,
  7455.00, 'income',
  'SOURCE_ID=175271182677', 'silvia martinez',
  'movement_class=payment_in',
  '2026-08-29T12:52:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  28, 1054315166, 28,
  7455.00, 'income',
  'SOURCE_ID=175270790791', 'GUSTAVO OYOLA',
  'movement_class=payment_in',
  '2026-08-29T12:50:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  29, 1054315166, 29,
  7455.00, 'income',
  'SOURCE_ID=176219496310', 'EDUARDO ALFREDO MOSER',
  'movement_class=payment_in',
  '2026-08-29T12:49:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  30, 1054315166, 30,
  14910.00, 'income',
  'SOURCE_ID=175270287685', 'Nicole Bari ',
  'movement_class=payment_in',
  '2026-08-29T12:49:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  31, 1054315166, 31,
  7455.00, 'income',
  'SOURCE_ID=175270456465', 'ARASELI CAROLINA PANETTA',
  'movement_class=payment_in',
  '2026-08-29T12:47:50-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  32, 1054315166, 32,
  7455.00, 'income',
  'SOURCE_ID=176218572988', 'VILMA ESTHER CASTILLO',
  'movement_class=payment_in',
  '2026-08-29T12:45:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  33, 1054315166, 33,
  7455.00, 'income',
  'SOURCE_ID=175268932065', 'Nuria Teresa Anahi Cordoba',
  'movement_class=payment_in',
  '2026-08-29T12:42:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  34, 1054315166, 34,
  12922.00, 'income',
  'SOURCE_ID=175269160727', 'Fernando Schroh',
  'movement_class=payment_in',
  '2026-08-29T12:41:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  35, 1054315166, 35,
  6461.00, 'income',
  'SOURCE_ID=176217131696', 'Maira Erica',
  'movement_class=payment_in',
  '2026-08-29T12:38:43-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  36, 1054315166, 36,
  7455.00, 'income',
  'SOURCE_ID=176217044600', 'Fernando Ruiz',
  'movement_class=payment_in',
  '2026-08-29T12:36:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  37, 1054315166, 37,
  7455.00, 'income',
  'SOURCE_ID=176216681746', 'ALEJANDRA GLADYS DELGADO',
  'movement_class=payment_in',
  '2026-08-29T12:35:59-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  38, 1054315166, 38,
  7455.00, 'income',
  'SOURCE_ID=175267789163', 'Lucia',
  'movement_class=payment_in',
  '2026-08-29T12:35:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  39, 1054315166, 39,
  3479.00, 'income',
  'SOURCE_ID=176216535894', 'Sergio Vechiati',
  'movement_class=payment_in',
  '2026-08-29T12:35:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  40, 1054315166, 40,
  7455.00, 'transfer',
  'SOURCE_ID=176216898312', '',
  'movement_class=transfer_in',
  '2026-08-29T12:34:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  41, 1054315166, 41,
  7455.00, 'transfer',
  'SOURCE_ID=176216555200', '',
  'movement_class=transfer_in',
  '2026-08-29T12:34:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  42, 1054315166, 42,
  22365.00, 'transfer',
  'SOURCE_ID=176216041986', '',
  'movement_class=transfer_in',
  '2026-08-29T12:32:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  43, 1054315166, 43,
  7455.00, 'transfer',
  'SOURCE_ID=176216071746', '',
  'movement_class=transfer_in',
  '2026-08-29T12:32:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  44, 1054315166, 44,
  7455.00, 'transfer',
  'SOURCE_ID=176216136764', '',
  'movement_class=transfer_in',
  '2026-08-29T12:31:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  45, 1054315166, 45,
  7455.00, 'transfer',
  'SOURCE_ID=175266608003', '',
  'movement_class=transfer_in',
  '2026-08-29T12:31:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  46, 1054315166, 46,
  6461.00, 'income',
  'SOURCE_ID=175266889077', 'Roberto Carlos Tarifeño Molina',
  'movement_class=payment_in',
  '2026-08-29T12:31:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  47, 1054315166, 47,
  14910.00, 'income',
  'SOURCE_ID=175266540547', 'Carolina Serra',
  'movement_class=payment_in',
  '2026-08-29T12:28:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  48, 1054315166, 48,
  7455.00, 'income',
  'SOURCE_ID=176215338552', 'Rosana Paola Fondrini',
  'movement_class=payment_in',
  '2026-08-29T12:26:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  49, 1054315166, 49,
  6461.00, 'income',
  'SOURCE_ID=175265660033', 'CARLOS ALBERTO ANTENAO',
  'movement_class=payment_in',
  '2026-08-29T12:25:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  50, 1054315166, 50,
  14910.00, 'income',
  'SOURCE_ID=176214063518', 'Mabel Monica Lopez',
  'movement_class=payment_in',
  '2026-08-29T12:23:00-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  51, 1054315166, 51,
  12922.00, 'income',
  'SOURCE_ID=176213695720', 'STELLA MARIS COLLADO',
  'movement_class=payment_in',
  '2026-08-29T12:21:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  52, 1054315166, 52,
  7455.00, 'income',
  'SOURCE_ID=176212801682', 'Juan Castro',
  'movement_class=payment_in',
  '2026-08-29T12:15:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  53, 1054315166, 53,
  7455.00, 'income',
  'SOURCE_ID=175263967173', 'Yonii Navarro',
  'movement_class=payment_in',
  '2026-08-29T12:15:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  54, 1054315166, 54,
  14910.00, 'income',
  'SOURCE_ID=176213044110', 'Adrian Torrillas',
  'movement_class=payment_in',
  '2026-08-29T12:14:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  55, 1054315166, 55,
  6461.00, 'income',
  'SOURCE_ID=175263369363', 'Antonio Alfredo Gimenez',
  'movement_class=payment_in',
  '2026-08-29T12:12:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  56, 1054315166, 56,
  14910.00, 'income',
  'SOURCE_ID=176212286804', 'Clara Redondo',
  'movement_class=payment_in',
  '2026-08-29T12:11:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  57, 1054315166, 57,
  12922.00, 'income',
  'SOURCE_ID=176211496882', 'hgcbaefd fcbgahde',
  'movement_class=payment_in',
  '2026-08-29T12:07:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  58, 1054315166, 58,
  12922.00, 'income',
  'SOURCE_ID=176211716268', 'Adriana Carrasco',
  'movement_class=payment_in',
  '2026-08-29T12:07:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  59, 1054315166, 59,
  14910.00, 'income',
  'SOURCE_ID=175262299469', 'Chino',
  'movement_class=payment_in',
  '2026-08-29T12:06:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  60, 1054315166, 60,
  7455.00, 'income',
  'SOURCE_ID=176211289122', 'NIDIA MARGOTT LOBOS FRANCO',
  'movement_class=payment_in',
  '2026-08-29T12:06:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  61, 1054315166, 61,
  7455.00, 'transfer',
  'SOURCE_ID=176210507810', '',
  'movement_class=transfer_in',
  '2026-08-29T12:04:04-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  62, 1054315166, 62,
  22365.00, 'income',
  'SOURCE_ID=175261339633', 'Mabel Ortiz',
  'movement_class=payment_in',
  '2026-08-29T12:01:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  63, 1054315166, 63,
  7455.00, 'income',
  'SOURCE_ID=175261279309', 'Carlos Agustin Biondo',
  'movement_class=payment_in',
  '2026-08-29T12:00:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  64, 1054315166, 64,
  7455.00, 'transfer',
  'SOURCE_ID=175261502139', '',
  'movement_class=transfer_in',
  '2026-08-29T12:00:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  65, 1054315166, 65,
  14910.00, 'income',
  'SOURCE_ID=175260780807', 'RDInd',
  'movement_class=payment_in',
  '2026-08-29T11:56:50-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  66, 1054315166, 66,
  6461.00, 'income',
  'SOURCE_ID=176209346964', 'Ana Cosmética & Perfumería',
  'movement_class=payment_in',
  '2026-08-29T11:56:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  67, 1054315166, 67,
  7455.00, 'income',
  'SOURCE_ID=176209476554', 'Mauro Tello Dev',
  'movement_class=payment_in',
  '2026-08-29T11:56:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  68, 1054315166, 68,
  7455.00, 'income',
  'SOURCE_ID=175260097521', 'GUILLERMO ARIEL GIANNI',
  'movement_class=payment_in',
  '2026-08-29T11:54:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  69, 1054315166, 69,
  5964.00, 'income',
  'SOURCE_ID=175260034165', 'bucci',
  'movement_class=payment_in',
  '2026-08-29T11:51:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  70, 1054315166, 70,
  7455.00, 'income',
  'SOURCE_ID=175259512875', 'EMANUEL SARMIENTO',
  'movement_class=payment_in',
  '2026-08-29T11:50:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  71, 1054315166, 71,
  7455.00, 'income',
  'SOURCE_ID=176208247100', 'Carlos Agustin Biondo',
  'movement_class=payment_in',
  '2026-08-29T11:49:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  72, 1054315166, 72,
  5964.00, 'transfer',
  'SOURCE_ID=176208145240', 'Diego Sacchetti',
  'movement_class=transfer_in',
  '2026-08-29T11:49:43-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  73, 1054315166, 73,
  7455.00, 'income',
  'SOURCE_ID=175258527665', 'Tyy',
  'movement_class=payment_in',
  '2026-08-29T11:47:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  74, 1054315166, 74,
  7455.00, 'income',
  'SOURCE_ID=176207495074', 'delfin venancio pardo',
  'movement_class=payment_in',
  '2026-08-29T11:45:50-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  75, 1054315166, 75,
  14910.00, 'income',
  'SOURCE_ID=175258491095', 'Gabriela Nieli',
  'movement_class=payment_in',
  '2026-08-29T11:45:50-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  76, 1054315166, 76,
  7455.00, 'income',
  'SOURCE_ID=176207127930', 'la autentica',
  'movement_class=payment_in',
  '2026-08-29T11:45:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  77, 1054315166, 77,
  12922.00, 'income',
  'SOURCE_ID=175258077243', 'sonia Sandoval',
  'movement_class=payment_in',
  '2026-08-29T11:42:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  78, 1054315166, 78,
  7455.00, 'income',
  'SOURCE_ID=176206934876', 'Horacio Segura',
  'movement_class=payment_in',
  '2026-08-29T11:42:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  79, 1054315166, 79,
  5964.00, 'income',
  'SOURCE_ID=175257993491', 'Marcela Alejandra Poblete',
  'movement_class=payment_in',
  '2026-08-29T11:42:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  80, 1054315166, 80,
  12922.00, 'income',
  'SOURCE_ID=175257753511', 'Nadia Urrutia',
  'movement_class=payment_in',
  '2026-08-29T11:41:10-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  81, 1054315166, 81,
  7455.00, 'income',
  'SOURCE_ID=176206408596', 'STELLA MARIS RUGGERI',
  'movement_class=payment_in',
  '2026-08-29T11:39:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  82, 1054315166, 82,
  14910.00, 'transfer',
  'SOURCE_ID=175257552987', '',
  'movement_class=transfer_in',
  '2026-08-29T11:39:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  83, 1054315166, 83,
  14910.00, 'income',
  'SOURCE_ID=176206342488', 'paola marcel',
  'movement_class=payment_in',
  '2026-08-29T11:38:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  84, 1054315166, 84,
  22365.00, 'transfer',
  'SOURCE_ID=176205746090', '',
  'movement_class=transfer_in',
  '2026-08-29T11:38:29-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  85, 1054315166, 85,
  6461.00, 'income',
  'SOURCE_ID=175256323101', 'Cecilia Noemi Castagna',
  'movement_class=payment_in',
  '2026-08-29T11:32:43-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  86, 1054315166, 86,
  5964.00, 'transfer',
  'SOURCE_ID=176205003346', '',
  'movement_class=transfer_in',
  '2026-08-29T11:32:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  87, 1054315166, 87,
  1988.00, 'income',
  'SOURCE_ID=175256382539', 'Silvina Montesi',
  'movement_class=payment_in',
  '2026-08-29T11:32:04-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  88, 1054315166, 88,
  6461.00, 'income',
  'SOURCE_ID=176204586594', 'Juana',
  'movement_class=payment_in',
  '2026-08-29T11:28:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  89, 1054315166, 89,
  7455.00, 'income',
  'SOURCE_ID=175254702473', 'rodriguwz',
  'movement_class=payment_in',
  '2026-08-29T11:22:31-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  90, 1054315166, 90,
  13916.00, 'transfer',
  'SOURCE_ID=176203015812', '',
  'movement_class=transfer_in',
  '2026-08-29T11:21:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  91, 1054315166, 91,
  7455.00, 'income',
  'SOURCE_ID=175254296331', 'Vicente ',
  'movement_class=payment_in',
  '2026-08-29T11:19:41-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  92, 1054315166, 92,
  7455.00, 'income',
  'SOURCE_ID=176202517690', 'Juan',
  'movement_class=payment_in',
  '2026-08-29T11:18:06-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  93, 1054315166, 93,
  6461.00, 'income',
  'SOURCE_ID=176202368810', 'Odonto',
  'movement_class=payment_in',
  '2026-08-29T11:15:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  94, 1054315166, 94,
  14910.00, 'income',
  'SOURCE_ID=175252797341', 'MIRIAM GRACIELA BARILA',
  'movement_class=payment_in',
  '2026-08-29T11:11:46-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  95, 1054315166, 95,
  7455.00, 'income',
  'SOURCE_ID=175252595867', 'SERGIO ADRIAN PUGLIESE',
  'movement_class=payment_in',
  '2026-08-29T11:11:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  96, 1054315166, 96,
  7455.00, 'transfer',
  'SOURCE_ID=175252281833', 'Liliana Esther Moron',
  'movement_class=transfer_in',
  '2026-08-29T11:09:48-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  97, 1054315166, 97,
  7455.00, 'income',
  'SOURCE_ID=175251959855', 'Maria Cevoli',
  'movement_class=payment_in',
  '2026-08-29T11:08:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  98, 1054315166, 98,
  6461.00, 'transfer',
  'SOURCE_ID=175251301225', '',
  'movement_class=transfer_in',
  '2026-08-29T11:03:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  99, 1054315166, 99,
  14910.00, 'income',
  'SOURCE_ID=175251035503', 'alejandro coleffi',
  'movement_class=payment_in',
  '2026-08-29T11:02:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  100, 1054315166, 100,
  12922.00, 'transfer',
  'SOURCE_ID=175249689179', '',
  'movement_class=transfer_in',
  '2026-08-29T10:52:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  101, 1054315166, 101,
  7455.00, 'income',
  'SOURCE_ID=176197952850', 'RAQUEL ESTELA CASTRO',
  'movement_class=payment_in',
  '2026-08-29T10:49:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  102, 1054315166, 102,
  5964.00, 'transfer',
  'SOURCE_ID=175248437649', '',
  'movement_class=transfer_in',
  '2026-08-29T10:45:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  103, 1054315166, 103,
  5964.00, 'income',
  'SOURCE_ID=176196891900', 'silvana sabbadini',
  'movement_class=payment_in',
  '2026-08-29T10:44:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  104, 1054315166, 104,
  29820.00, 'income',
  'SOURCE_ID=175248442225', 'MCPaulao',
  'movement_class=payment_in',
  '2026-08-29T10:42:13-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  105, 1054315166, 105,
  6461.00, 'income',
  'SOURCE_ID=175248182537', 'Hugo Alberto Cévoli',
  'movement_class=payment_in',
  '2026-08-29T10:40:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  106, 1054315166, 106,
  29820.00, 'income',
  'SOURCE_ID=176196682850', 'SANDRA GOICOECHEA',
  'movement_class=payment_in',
  '2026-08-29T10:40:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  107, 1054315166, 107,
  7455.00, 'income',
  'SOURCE_ID=176196125838', 'HECTOR CROCIATI',
  'movement_class=payment_in',
  '2026-08-29T10:38:46-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  108, 1054315166, 108,
  7455.00, 'income',
  'SOURCE_ID=176196184658', 'Europie',
  'movement_class=payment_in',
  '2026-08-29T10:36:31-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  109, 1054315166, 109,
  11928.00, 'income',
  'SOURCE_ID=176196160622', 'Eladio Marifili',
  'movement_class=payment_in',
  '2026-08-29T10:36:05-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  110, 1054315166, 110,
  7455.00, 'income',
  'SOURCE_ID=175246333883', 'alicia damonte',
  'movement_class=payment_in',
  '2026-08-29T10:31:14-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  111, 1054315166, 111,
  6461.00, 'income',
  'SOURCE_ID=176195392180', 'Claudia Olga Martinez',
  'movement_class=payment_in',
  '2026-08-29T10:29:14-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  112, 1054315166, 112,
  7455.00, 'income',
  'SOURCE_ID=175246062929', 'sergio zucal',
  'movement_class=payment_in',
  '2026-08-29T10:26:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  113, 1054315166, 113,
  6461.00, 'income',
  'SOURCE_ID=176194126914', 'Karen Moyano',
  'movement_class=payment_in',
  '2026-08-29T10:23:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  114, 1054315166, 114,
  12922.00, 'transfer',
  'SOURCE_ID=175245169023', '',
  'movement_class=transfer_in',
  '2026-08-29T10:21:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  115, 1054315166, 115,
  14910.00, 'income',
  'SOURCE_ID=176193599728', 'lorena hughes',
  'movement_class=payment_in',
  '2026-08-29T10:20:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  116, 1054315166, 116,
  14910.00, 'income',
  'SOURCE_ID=176193876634', 'Teresa68',
  'movement_class=payment_in',
  '2026-08-29T10:20:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  117, 1054315166, 117,
  14910.00, 'income',
  'SOURCE_ID=176193298012', 'Marina Fazolari',
  'movement_class=payment_in',
  '2026-08-29T10:19:47-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  118, 1054315166, 118,
  5964.00, 'income',
  'SOURCE_ID=176193006008', 'Alphaville',
  'movement_class=payment_in',
  '2026-08-29T10:16:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  119, 1054315166, 119,
  7455.00, 'transfer',
  'SOURCE_ID=175244524495', '',
  'movement_class=transfer_in',
  '2026-08-29T10:15:05-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  120, 1054315166, 120,
  5964.00, 'income',
  'SOURCE_ID=175244111445', 'Stella Maris de Vivo',
  'movement_class=payment_in',
  '2026-08-29T10:14:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  121, 1054315166, 121,
  7455.00, 'income',
  'SOURCE_ID=175243562091', 'Mirtha Duarte',
  'movement_class=payment_in',
  '2026-08-29T10:12:39-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  122, 1054315166, 122,
  7455.00, 'income',
  'SOURCE_ID=176192461432', 'Seguro rivadavia ',
  'movement_class=payment_in',
  '2026-08-29T10:11:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  123, 1054315166, 123,
  7455.00, 'income',
  'SOURCE_ID=175243828545', 'Tercer Set',
  'movement_class=payment_in',
  '2026-08-29T10:10:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  124, 1054315166, 124,
  5964.00, 'income',
  'SOURCE_ID=176191949688', 'Noemi',
  'movement_class=payment_in',
  '2026-08-29T10:10:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  125, 1054315166, 125,
  6461.00, 'income',
  'SOURCE_ID=175243455193', 'Silvia Beatriz Edelstein',
  'movement_class=payment_in',
  '2026-08-29T10:08:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  126, 1054315166, 126,
  5964.00, 'income',
  'SOURCE_ID=175243144837', 'Tiny',
  'movement_class=payment_in',
  '2026-08-29T10:03:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  127, 1054315166, 127,
  7455.00, 'income',
  'SOURCE_ID=175242319281', 'PABLO SOLANO',
  'movement_class=payment_in',
  '2026-08-29T10:00:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  128, 1054315166, 128,
  7455.00, 'income',
  'SOURCE_ID=175241297937', 'Mariano Alejandro Terny',
  'movement_class=payment_in',
  '2026-08-29T09:52:50-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  129, 1054315166, 129,
  13419.00, 'income',
  'SOURCE_ID=175240313275', 'Kurmi Arcoíris',
  'movement_class=payment_in',
  '2026-08-29T09:42:41-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  130, 1054315166, 130,
  7455.00, 'income',
  'SOURCE_ID=176187971384', 'Maria Sanservino',
  'movement_class=payment_in',
  '2026-08-29T09:34:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  131, 1054315166, 131,
  14910.00, 'income',
  'SOURCE_ID=176187745772', 'Jose Garcia Francisco Lago',
  'movement_class=payment_in',
  '2026-08-29T09:34:29-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  132, 1054315166, 132,
  7455.00, 'income',
  'SOURCE_ID=175239023723', 'LUCIO ANTONIO JAVIER CALVO',
  'movement_class=payment_in',
  '2026-08-29T09:33:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  133, 1054315166, 133,
  35784.00, 'income',
  'SOURCE_ID=175238963803', 'Ana Josefina Correa',
  'movement_class=payment_in',
  '2026-08-29T09:32:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  134, 1054315166, 134,
  14910.00, 'transfer',
  'SOURCE_ID=175238883599', 'Mirna Bus',
  'movement_class=transfer_in',
  '2026-08-29T09:31:21-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  135, 1054315166, 135,
  6461.00, 'transfer',
  'SOURCE_ID=176187108082', '',
  'movement_class=transfer_in',
  '2026-08-29T09:30:59-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  136, 1054315166, 136,
  6461.00, 'transfer',
  'SOURCE_ID=176187986388', '',
  'movement_class=transfer_in',
  '2026-08-29T09:30:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  137, 1054315166, 137,
  5964.00, 'income',
  'SOURCE_ID=176187116528', 'Pablo Dalponte',
  'movement_class=payment_in',
  '2026-08-29T09:25:00-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  138, 1054315166, 138,
  7455.00, 'income',
  'SOURCE_ID=176186811150', 'SOFIA FRANCO',
  'movement_class=payment_in',
  '2026-08-29T09:22:49-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  139, 1054315166, 139,
  6461.00, 'transfer',
  'SOURCE_ID=175237581813', '',
  'movement_class=transfer_in',
  '2026-08-29T09:21:22-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  140, 1054315166, 140,
  7455.00, 'income',
  'SOURCE_ID=176186305918', 'PABLO VERA',
  'movement_class=payment_in',
  '2026-08-29T09:20:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  141, 1054315166, 141,
  14910.00, 'income',
  'SOURCE_ID=175237635293', 'sergio alejendro gauna',
  'movement_class=payment_in',
  '2026-08-29T09:20:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  142, 1054315166, 142,
  14910.00, 'income',
  'SOURCE_ID=175237577069', 'Julieta Racca',
  'movement_class=payment_in',
  '2026-08-29T09:18:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  143, 1054315166, 143,
  12922.00, 'income',
  'SOURCE_ID=176185359764', 'MARIELA FERNANDA BARRIONUEVO',
  'movement_class=payment_in',
  '2026-08-29T09:12:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  144, 1054315166, 144,
  6461.00, 'income',
  'SOURCE_ID=175237426311', 'Julia Zanotti',
  'movement_class=payment_in',
  '2026-08-29T09:12:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  145, 1054315166, 145,
  14910.00, 'income',
  'SOURCE_ID=175237354169', 'lucas lucero',
  'movement_class=payment_in',
  '2026-08-29T09:10:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  146, 1054315166, 146,
  3479.00, 'income',
  'SOURCE_ID=176184599340', 'Analìa da Palma',
  'movement_class=payment_in',
  '2026-08-29T09:03:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  147, 1054315166, 147,
  7455.00, 'transfer',
  'SOURCE_ID=175235899203', '',
  'movement_class=transfer_in',
  '2026-08-29T09:01:05-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  148, 1054315166, 148,
  14910.00, 'income',
  'SOURCE_ID=175235821185', 'Teresa68',
  'movement_class=payment_in',
  '2026-08-29T08:59:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  149, 1054315166, 149,
  5964.00, 'income',
  'SOURCE_ID=175235142039', 'Liliana Recio',
  'movement_class=payment_in',
  '2026-08-29T08:58:27-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  150, 1054315166, 150,
  29820.00, 'income',
  'SOURCE_ID=176183918706', 'Luis',
  'movement_class=payment_in',
  '2026-08-29T08:50:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
