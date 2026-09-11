SET CONSTRAINTS ALL DEFERRED;

INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  151, 1054315166, 151,
  7455.00, 'income',
  'SOURCE_ID=175234697681', 'MARIA PAULA MONTERO DE ESPINOSA',
  'movement_class=payment_in',
  '2026-08-29T08:47:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  152, 1054315166, 152,
  14910.00, 'income',
  'SOURCE_ID=176183163362', 'Gladys Beatriz Yanisky',
  'movement_class=payment_in',
  '2026-08-29T08:47:46-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  153, 1054315166, 153,
  32802.00, 'income',
  'SOURCE_ID=175231330079', 'DESPENSA EL TILO',
  'movement_class=payment_in',
  '2026-08-29T08:12:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  154, 1054315166, 154,
  38766.00, 'income',
  'SOURCE_ID=175231871485', 'La casa de Carlos ',
  'movement_class=payment_in',
  '2026-08-29T08:11:48-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  155, 1054315166, 155,
  77532.00, 'income',
  'SOURCE_ID=176180187174', 'Bachin',
  'movement_class=payment_in',
  '2026-08-29T08:02:29-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  156, 1054315166, 156,
  77532.00, 'income',
  'SOURCE_ID=176177292004', 'Austral panaderia',
  'movement_class=payment_in',
  '2026-08-29T07:23:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  157, 1054315166, 157,
  38766.00, 'income',
  'SOURCE_ID=175200138287', 'Matias Margiotta',
  'movement_class=payment_in',
  '2026-08-28T22:15:00-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  158, 1054315166, 158,
  -10060.00, 'expense',
  'SOURCE_ID=175192470461', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-28T21:23:39-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  159, 1054315166, 159,
  -80480.00, 'expense',
  'SOURCE_ID=175192033553', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-28T21:23:05-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  160, 1054315166, 160,
  1988.00, 'income',
  'SOURCE_ID=176007332458', 'Mariana',
  'movement_class=payment_in',
  '2026-08-28T08:50:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  161, 1054315166, 161,
  1913.62, 'interest_income',
  'SOURCE_ID=1749087022268', '',
  'movement_class=yield',
  '2026-08-28T02:36:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  162, 1054315166, 162,
  77532.00, 'income',
  'SOURCE_ID=175013189443', 'Jose Choque',
  'movement_class=payment_in',
  '2026-08-27T20:55:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  163, 1054315166, 163,
  7455.00, 'income',
  'SOURCE_ID=174937107571', 'Natalia Pastelería',
  'movement_class=payment_in',
  '2026-08-27T12:56:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  164, 1054315166, 164,
  2155.16, 'interest_income',
  'SOURCE_ID=1749021137792', '',
  'movement_class=yield',
  '2026-08-27T03:17:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  165, 1054315166, 165,
  -362160.00, 'expense',
  'SOURCE_ID=174871556183', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-26T22:45:29-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  166, 1054315166, 166,
  -78484.10, 'expense',
  'SOURCE_ID=174830513775', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-26T18:17:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  167, 1054315166, 167,
  107352.00, 'income',
  'SOURCE_ID=174779614597', 'freddy',
  'movement_class=payment_in',
  '2026-08-26T12:42:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  168, 1054315166, 168,
  13916.00, 'income',
  'SOURCE_ID=175720805002', 'club',
  'movement_class=payment_in',
  '2026-08-26T12:34:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  169, 1054315166, 169,
  1807.90, 'interest_income',
  'SOURCE_ID=1748958742264', '',
  'movement_class=yield',
  '2026-08-26T04:09:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  170, 1054315166, 170,
  38766.00, 'income',
  'SOURCE_ID=175651693418', 'Matias Margiotta',
  'movement_class=payment_in',
  '2026-08-25T22:01:21-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  171, 1054315166, 171,
  347900.00, 'income',
  'SOURCE_ID=175650217208', 'marcial',
  'movement_class=payment_in',
  '2026-08-25T21:47:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  172, 1054315166, 172,
  193830.00, 'income',
  'SOURCE_ID=175633551212', 'Mrpolloviedma1',
  'movement_class=payment_in',
  '2026-08-25T19:53:22-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  173, 1054315166, 173,
  14910.00, 'income',
  'SOURCE_ID=175579998538', 'Mariana',
  'movement_class=payment_in',
  '2026-08-25T14:12:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  174, 1054315166, 174,
  1813.91, 'interest_income',
  'SOURCE_ID=1748894507219', '',
  'movement_class=yield',
  '2026-08-25T05:26:13-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  175, 1054315166, 175,
  143135.99, 'income',
  'SOURCE_ID=175416407304', 'EL KEROSENERO SA',
  'movement_class=payment_in',
  '2026-08-24T13:52:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  176, 1054315166, 176,
  298200.00, 'income',
  'SOURCE_ID=175406445880', 'freddy',
  'movement_class=payment_in',
  '2026-08-24T12:52:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  177, 1054315166, 177,
  2611.86, 'interest_income',
  'SOURCE_ID=1748798232194', '',
  'movement_class=yield',
  '2026-08-24T03:58:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  178, 1054315166, 178,
  -90543.02, 'expense',
  'SOURCE_ID=175305092954', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-23T18:12:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  179, 1054315166, 179,
  -100600.00, 'expense',
  'SOURCE_ID=174364528255', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-23T17:34:52-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  180, 1054315166, 180,
  -52038.66, 'expense',
  'SOURCE_ID=174302952609', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-23T08:23:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  181, 1054315166, 181,
  6958.00, 'income',
  'SOURCE_ID=175161623640', 'Maria Daniela Damboria',
  'movement_class=payment_in',
  '2026-08-22T17:18:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  182, 1054315166, 182,
  155064.00, 'income',
  'SOURCE_ID=174214632533', 'Choque Casimiro Riquelme',
  'movement_class=payment_in',
  '2026-08-22T15:58:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  183, 1054315166, 183,
  35784.00, 'income',
  'SOURCE_ID=174206358875', 'terminal kiosco',
  'movement_class=payment_in',
  '2026-08-22T15:02:04-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  184, 1054315166, 184,
  23856.00, 'income',
  'SOURCE_ID=175140859296', 'Lorena Moreno',
  'movement_class=payment_in',
  '2026-08-22T14:56:00-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  185, 1054315166, 185,
  5964.00, 'income',
  'SOURCE_ID=174199749415', 'MARIA GABRIELA DELGADO',
  'movement_class=payment_in',
  '2026-08-22T14:17:48-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  186, 1054315166, 186,
  11928.00, 'income',
  'SOURCE_ID=175132019744', 'claudia alejandra villar',
  'movement_class=payment_in',
  '2026-08-22T13:58:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  187, 1054315166, 187,
  5964.00, 'income',
  'SOURCE_ID=175129549402', 'Lic Lorena Canteros',
  'movement_class=payment_in',
  '2026-08-22T13:42:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  188, 1054315166, 188,
  5964.00, 'transfer',
  'SOURCE_ID=175129307374', '',
  'movement_class=transfer_in',
  '2026-08-22T13:40:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  189, 1054315166, 189,
  5964.00, 'transfer',
  'SOURCE_ID=174193487075', 'MIRIAM GRACIELA BARILA',
  'movement_class=transfer_in',
  '2026-08-22T13:38:48-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  190, 1054315166, 190,
  5964.00, 'income',
  'SOURCE_ID=174193018223', 'Silvia Ines Santos',
  'movement_class=payment_in',
  '2026-08-22T13:33:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  191, 1054315166, 191,
  5964.00, 'income',
  'SOURCE_ID=175128145444', 'SERGIO ADRIAN PUGLIESE',
  'movement_class=payment_in',
  '2026-08-22T13:33:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  192, 1054315166, 192,
  5964.00, 'income',
  'SOURCE_ID=174190979993', 'Pablo Palermiti',
  'movement_class=payment_in',
  '2026-08-22T13:24:28-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  193, 1054315166, 193,
  5964.00, 'income',
  'SOURCE_ID=174190901445', 'Romina Manquelef',
  'movement_class=payment_in',
  '2026-08-22T13:22:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  194, 1054315166, 194,
  5964.00, 'income',
  'SOURCE_ID=174191082529', 'ADRIAN ANTONIO RASQUELA',
  'movement_class=payment_in',
  '2026-08-22T13:22:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  195, 1054315166, 195,
  11928.00, 'income',
  'SOURCE_ID=174190420019', 'Rodri',
  'movement_class=payment_in',
  '2026-08-22T13:21:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  196, 1054315166, 196,
  11928.00, 'income',
  'SOURCE_ID=175125578350', 'VIVIANA EDITH BREIDE',
  'movement_class=payment_in',
  '2026-08-22T13:16:36-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  197, 1054315166, 197,
  5964.00, 'income',
  'SOURCE_ID=174189321453', 'adrianazuñiga',
  'movement_class=payment_in',
  '2026-08-22T13:14:47-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  198, 1054315166, 198,
  5964.00, 'income',
  'SOURCE_ID=175124897442', 'adriana ruiz',
  'movement_class=payment_in',
  '2026-08-22T13:14:22-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  199, 1054315166, 199,
  5964.00, 'income',
  'SOURCE_ID=174189218663', 'Alphaville',
  'movement_class=payment_in',
  '2026-08-22T13:12:39-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  200, 1054315166, 200,
  5964.00, 'income',
  'SOURCE_ID=174189336305', 'Florencia Jakimczuk',
  'movement_class=payment_in',
  '2026-08-22T13:12:39-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  201, 1054315166, 201,
  11928.00, 'transfer',
  'SOURCE_ID=174188767071', '',
  'movement_class=transfer_in',
  '2026-08-22T13:10:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  202, 1054315166, 202,
  11928.00, 'transfer',
  'SOURCE_ID=174188619525', '',
  'movement_class=transfer_in',
  '2026-08-22T13:10:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  203, 1054315166, 203,
  11928.00, 'income',
  'SOURCE_ID=174188532963', 'ANTONELLA MIRENGHI',
  'movement_class=payment_in',
  '2026-08-22T13:09:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  204, 1054315166, 204,
  5964.00, 'income',
  'SOURCE_ID=175123681352', 'Eliana Melivilo',
  'movement_class=payment_in',
  '2026-08-22T13:07:00-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  205, 1054315166, 205,
  5964.00, 'transfer',
  'SOURCE_ID=175123598864', 'pedrohgalceran',
  'movement_class=transfer_in',
  '2026-08-22T13:05:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  206, 1054315166, 206,
  5964.00, 'income',
  'SOURCE_ID=174187557325', 'Micaela Zunzunegui',
  'movement_class=payment_in',
  '2026-08-22T13:04:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  207, 1054315166, 207,
  5964.00, 'income',
  'SOURCE_ID=175123069080', 'viaje',
  'movement_class=payment_in',
  '2026-08-22T13:03:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  208, 1054315166, 208,
  11928.00, 'income',
  'SOURCE_ID=175122221216', 'VALERIA VENTURA',
  'movement_class=payment_in',
  '2026-08-22T12:59:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  209, 1054315166, 209,
  5964.00, 'transfer',
  'SOURCE_ID=175122120396', '',
  'movement_class=transfer_in',
  '2026-08-22T12:57:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  210, 1054315166, 210,
  6461.00, 'income',
  'SOURCE_ID=174185579281', 'Julio Lavezzo',
  'movement_class=payment_in',
  '2026-08-22T12:52:46-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  211, 1054315166, 211,
  5964.00, 'transfer',
  'SOURCE_ID=175121262514', '',
  'movement_class=transfer_in',
  '2026-08-22T12:52:31-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  212, 1054315166, 212,
  12922.00, 'income',
  'SOURCE_ID=174184681603', 'Sol   Roa',
  'movement_class=payment_in',
  '2026-08-22T12:49:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  213, 1054315166, 213,
  17892.00, 'transfer',
  'SOURCE_ID=175119843722', 'Diego Sacchetti',
  'movement_class=transfer_in',
  '2026-08-22T12:46:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  214, 1054315166, 214,
  17892.00, 'income',
  'SOURCE_ID=174184011625', 'SERGIO DANIEL CAMPOS',
  'movement_class=payment_in',
  '2026-08-22T12:45:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  215, 1054315166, 215,
  12922.00, 'transfer',
  'SOURCE_ID=174183996429', '',
  'movement_class=transfer_in',
  '2026-08-22T12:43:21-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  216, 1054315166, 216,
  12922.00, 'income',
  'SOURCE_ID=174183443931', 'Helmer Sandro Calvo',
  'movement_class=payment_in',
  '2026-08-22T12:42:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  217, 1054315166, 217,
  6461.00, 'income',
  'SOURCE_ID=175119077602', 'Paula Pabletich',
  'movement_class=payment_in',
  '2026-08-22T12:41:59-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  218, 1054315166, 218,
  6461.00, 'income',
  'SOURCE_ID=175118110480', 'Gabriel Linares',
  'movement_class=payment_in',
  '2026-08-22T12:35:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  219, 1054315166, 219,
  12922.00, 'income',
  'SOURCE_ID=174182259955', 'MARCELO ALEJANDRO BELLINI CURZ',
  'movement_class=payment_in',
  '2026-08-22T12:35:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  220, 1054315166, 220,
  5964.00, 'transfer',
  'SOURCE_ID=175117501798', '',
  'movement_class=transfer_in',
  '2026-08-22T12:34:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  221, 1054315166, 221,
  6461.00, 'income',
  'SOURCE_ID=175116801642', 'Sandra Mary Salazar Aguilar',
  'movement_class=payment_in',
  '2026-08-22T12:30:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  222, 1054315166, 222,
  6461.00, 'income',
  'SOURCE_ID=175116548708', 'Las flias',
  'movement_class=payment_in',
  '2026-08-22T12:27:28-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  223, 1054315166, 223,
  11928.00, 'income',
  'SOURCE_ID=175116404812', 'Diana Silvia Atri',
  'movement_class=payment_in',
  '2026-08-22T12:26:50-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  224, 1054315166, 224,
  5964.00, 'income',
  'SOURCE_ID=175116298660', 'Sol',
  'movement_class=payment_in',
  '2026-08-22T12:25:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  225, 1054315166, 225,
  5964.00, 'income',
  'SOURCE_ID=174180311285', 'ana kern',
  'movement_class=payment_in',
  '2026-08-22T12:25:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  226, 1054315166, 226,
  12922.00, 'transfer',
  'SOURCE_ID=175115967480', '',
  'movement_class=transfer_in',
  '2026-08-22T12:25:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  227, 1054315166, 227,
  6461.00, 'income',
  'SOURCE_ID=174180112527', 'Silvia Mabel Calvo',
  'movement_class=payment_in',
  '2026-08-22T12:22:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  228, 1054315166, 228,
  6461.00, 'income',
  'SOURCE_ID=174179789451', 'GUILLERMO ARIEL GIANNI',
  'movement_class=payment_in',
  '2026-08-22T12:22:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  229, 1054315166, 229,
  5964.00, 'income',
  'SOURCE_ID=174179952841', 'Oscar Grela',
  'movement_class=payment_in',
  '2026-08-22T12:22:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  230, 1054315166, 230,
  6461.00, 'income',
  'SOURCE_ID=175115111456', 'Laurapaillalef ',
  'movement_class=payment_in',
  '2026-08-22T12:20:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  231, 1054315166, 231,
  11928.00, 'income',
  'SOURCE_ID=174179173869', 'PEDRO HERRERA',
  'movement_class=payment_in',
  '2026-08-22T12:19:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  232, 1054315166, 232,
  6461.00, 'income',
  'SOURCE_ID=174179255267', 'Antonella Chavez',
  'movement_class=payment_in',
  '2026-08-22T12:18:48-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  233, 1054315166, 233,
  12922.00, 'transfer',
  'SOURCE_ID=175114331624', '',
  'movement_class=transfer_in',
  '2026-08-22T12:16:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  234, 1054315166, 234,
  5964.00, 'income',
  'SOURCE_ID=174178288689', 'BIANCA MOLINI',
  'movement_class=payment_in',
  '2026-08-22T12:12:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  235, 1054315166, 235,
  6461.00, 'income',
  'SOURCE_ID=175112419902', 'Laureana Laurido',
  'movement_class=payment_in',
  '2026-08-22T12:07:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  236, 1054315166, 236,
  9940.00, 'transfer',
  'SOURCE_ID=175112252930', '',
  'movement_class=transfer_in',
  '2026-08-22T12:05:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  237, 1054315166, 237,
  6461.00, 'income',
  'SOURCE_ID=174175396011', 'Paola',
  'movement_class=payment_in',
  '2026-08-22T11:58:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  238, 1054315166, 238,
  6461.00, 'income',
  'SOURCE_ID=174174714927', 'Alejandro Ferrara',
  'movement_class=payment_in',
  '2026-08-22T11:53:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  239, 1054315166, 239,
  5964.00, 'transfer',
  'SOURCE_ID=174174572939', '',
  'movement_class=transfer_in',
  '2026-08-22T11:52:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  240, 1054315166, 240,
  6461.00, 'income',
  'SOURCE_ID=175109896794', 'Pablo Epuñan',
  'movement_class=payment_in',
  '2026-08-22T11:51:47-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  241, 1054315166, 241,
  5964.00, 'transfer',
  'SOURCE_ID=174174116769', '',
  'movement_class=transfer_in',
  '2026-08-22T11:49:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  242, 1054315166, 242,
  6461.00, 'income',
  'SOURCE_ID=175109328670', 'Beja productos de la colmena',
  'movement_class=payment_in',
  '2026-08-22T11:48:10-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  243, 1054315166, 243,
  12922.00, 'transfer',
  'SOURCE_ID=175108443146', '',
  'movement_class=transfer_in',
  '2026-08-22T11:43:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  244, 1054315166, 244,
  3479.00, 'transfer',
  'SOURCE_ID=174172180661', '',
  'movement_class=transfer_in',
  '2026-08-22T11:38:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  245, 1054315166, 245,
  17892.00, 'income',
  'SOURCE_ID=175107341634', 'gustavo franchello',
  'movement_class=payment_in',
  '2026-08-22T11:37:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  246, 1054315166, 246,
  6461.00, 'income',
  'SOURCE_ID=175107259194', 'Javier sanchez',
  'movement_class=payment_in',
  '2026-08-22T11:36:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  247, 1054315166, 247,
  6461.00, 'income',
  'SOURCE_ID=175107210832', 'Eladio Marifili',
  'movement_class=payment_in',
  '2026-08-22T11:35:21-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  248, 1054315166, 248,
  6461.00, 'income',
  'SOURCE_ID=174171092999', 'VERONICA PAULA VENTURA',
  'movement_class=payment_in',
  '2026-08-22T11:32:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  249, 1054315166, 249,
  6461.00, 'income',
  'SOURCE_ID=174170819011', 'Fabiana Arias Valla',
  'movement_class=payment_in',
  '2026-08-22T11:30:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  250, 1054315166, 250,
  6461.00, 'transfer',
  'SOURCE_ID=175106106376', '',
  'movement_class=transfer_in',
  '2026-08-22T11:28:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  251, 1054315166, 251,
  11928.00, 'income',
  'SOURCE_ID=175105639194', 'Lavarropa',
  'movement_class=payment_in',
  '2026-08-22T11:27:22-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  252, 1054315166, 252,
  12425.00, 'income',
  'SOURCE_ID=175105217762', 'Nicole Bari ',
  'movement_class=payment_in',
  '2026-08-22T11:25:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  253, 1054315166, 253,
  12922.00, 'income',
  'SOURCE_ID=175105696110', 'Juan Villegas',
  'movement_class=payment_in',
  '2026-08-22T11:25:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  254, 1054315166, 254,
  12922.00, 'income',
  'SOURCE_ID=174169625735', 'Sabana',
  'movement_class=payment_in',
  '2026-08-22T11:24:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  255, 1054315166, 255,
  6461.00, 'income',
  'SOURCE_ID=175104810852', 'agencia recaudacion tributaria',
  'movement_class=payment_in',
  '2026-08-22T11:21:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  256, 1054315166, 256,
  6461.00, 'income',
  'SOURCE_ID=174168782043', 'Wilson Abeiro',
  'movement_class=payment_in',
  '2026-08-22T11:20:50-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  257, 1054315166, 257,
  5964.00, 'income',
  'SOURCE_ID=175104600894', 'Mario juaquin Urrutia',
  'movement_class=payment_in',
  '2026-08-22T11:20:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  258, 1054315166, 258,
  12922.00, 'income',
  'SOURCE_ID=174168864729', 'SERGIO DANIEL CASTRILLO',
  'movement_class=payment_in',
  '2026-08-22T11:18:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  259, 1054315166, 259,
  11928.00, 'income',
  'SOURCE_ID=175103286588', 'victoria',
  'movement_class=payment_in',
  '2026-08-22T11:10:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  260, 1054315166, 260,
  12922.00, 'income',
  'SOURCE_ID=175102069768', 'paola marcel',
  'movement_class=payment_in',
  '2026-08-22T11:06:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  261, 1054315166, 261,
  5964.00, 'income',
  'SOURCE_ID=174166766939', 'CLEMENTE ARAMENDI',
  'movement_class=payment_in',
  '2026-08-22T11:04:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  262, 1054315166, 262,
  6461.00, 'income',
  'SOURCE_ID=175102047028', 'PAULA RODRIGUEZ FRANDSEN',
  'movement_class=payment_in',
  '2026-08-22T11:04:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  263, 1054315166, 263,
  5964.00, 'income',
  'SOURCE_ID=175101791206', 'MARIO DANIEL LORCA',
  'movement_class=payment_in',
  '2026-08-22T11:03:00-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  264, 1054315166, 264,
  5964.00, 'income',
  'SOURCE_ID=175101816202', 'QuieroFrutillas',
  'movement_class=payment_in',
  '2026-08-22T11:00:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  265, 1054315166, 265,
  12425.00, 'income',
  'SOURCE_ID=175101616418', 'DIEGO HERNAN FRIAS',
  'movement_class=payment_in',
  '2026-08-22T11:00:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  266, 1054315166, 266,
  5964.00, 'income',
  'SOURCE_ID=175101021360', 'Humberto Gattas',
  'movement_class=payment_in',
  '2026-08-22T10:58:41-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  267, 1054315166, 267,
  11928.00, 'income',
  'SOURCE_ID=175100689806', 'Juan Andres Ruf',
  'movement_class=payment_in',
  '2026-08-22T10:57:06-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  268, 1054315166, 268,
  6461.00, 'income',
  'SOURCE_ID=175100523224', 'Maria Fuentes',
  'movement_class=payment_in',
  '2026-08-22T10:54:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  269, 1054315166, 269,
  12922.00, 'transfer',
  'SOURCE_ID=175100435406', '',
  'movement_class=transfer_in',
  '2026-08-22T10:54:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  270, 1054315166, 270,
  5964.00, 'income',
  'SOURCE_ID=174165078775', 'Maria Gabriela Kunisch',
  'movement_class=payment_in',
  '2026-08-22T10:53:27-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  271, 1054315166, 271,
  6461.00, 'income',
  'SOURCE_ID=175100506546', 'Fede',
  'movement_class=payment_in',
  '2026-08-22T10:52:49-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  272, 1054315166, 272,
  11928.00, 'transfer',
  'SOURCE_ID=174164353925', '',
  'movement_class=transfer_in',
  '2026-08-22T10:51:22-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  273, 1054315166, 273,
  6461.00, 'income',
  'SOURCE_ID=174164160405', 'Lorena Acosta',
  'movement_class=payment_in',
  '2026-08-22T10:46:21-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  274, 1054315166, 274,
  6461.00, 'income',
  'SOURCE_ID=175098568084', 'NATALIA YAMILA GOMEZ',
  'movement_class=payment_in',
  '2026-08-22T10:43:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  275, 1054315166, 275,
  12922.00, 'income',
  'SOURCE_ID=175098691478', 'Lorenzo Mora',
  'movement_class=payment_in',
  '2026-08-22T10:42:49-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  276, 1054315166, 276,
  7455.00, 'income',
  'SOURCE_ID=174163544387', 'Nai',
  'movement_class=payment_in',
  '2026-08-22T10:41:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  277, 1054315166, 277,
  13419.00, 'income',
  'SOURCE_ID=175098578994', 'lorena hughes',
  'movement_class=payment_in',
  '2026-08-22T10:40:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  278, 1054315166, 278,
  12922.00, 'transfer',
  'SOURCE_ID=175097976434', '',
  'movement_class=transfer_in',
  '2026-08-22T10:35:21-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  279, 1054315166, 279,
  38766.00, 'income',
  'SOURCE_ID=174162342243', 'Matias Margiotta',
  'movement_class=payment_in',
  '2026-08-22T10:32:52-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  280, 1054315166, 280,
  7455.00, 'income',
  'SOURCE_ID=175097203296', 'Informe Carlos Fischer ',
  'movement_class=payment_in',
  '2026-08-22T10:31:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  281, 1054315166, 281,
  7455.00, 'income',
  'SOURCE_ID=175097277126', 'Ignacio Jns',
  'movement_class=payment_in',
  '2026-08-22T10:31:31-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  282, 1054315166, 282,
  7455.00, 'income',
  'SOURCE_ID=174162062135', 'sergio zucal',
  'movement_class=payment_in',
  '2026-08-22T10:30:50-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  283, 1054315166, 283,
  5964.00, 'income',
  'SOURCE_ID=174161284905', 'Pasionarte',
  'movement_class=payment_in',
  '2026-08-22T10:26:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  284, 1054315166, 284,
  5964.00, 'transfer',
  'SOURCE_ID=174161142687', '',
  'movement_class=transfer_in',
  '2026-08-22T10:24:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  285, 1054315166, 285,
  38766.00, 'income',
  'SOURCE_ID=175096219262', 'Julio Argentino Morales',
  'movement_class=payment_in',
  '2026-08-22T10:24:52-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  286, 1054315166, 286,
  5964.00, 'income',
  'SOURCE_ID=174160402081', 'HUMBERTO GERARDO COLOMBO',
  'movement_class=payment_in',
  '2026-08-22T10:22:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  287, 1054315166, 287,
  14910.00, 'income',
  'SOURCE_ID=174160479445', 'alejandro coleffi',
  'movement_class=payment_in',
  '2026-08-22T10:21:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  288, 1054315166, 288,
  14910.00, 'income',
  'SOURCE_ID=175096112172', 'SOLEDAD MARGOT CECCHINI',
  'movement_class=payment_in',
  '2026-08-22T10:21:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  289, 1054315166, 289,
  7455.00, 'transfer',
  'SOURCE_ID=174160401411', '',
  'movement_class=transfer_in',
  '2026-08-22T10:20:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  290, 1054315166, 290,
  6461.00, 'income',
  'SOURCE_ID=175095430266', 'WALTER RIERA',
  'movement_class=payment_in',
  '2026-08-22T10:16:10-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  291, 1054315166, 291,
  19383.00, 'transfer',
  'SOURCE_ID=175095162308', '',
  'movement_class=transfer_in',
  '2026-08-22T10:14:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  292, 1054315166, 292,
  3479.00, 'income',
  'SOURCE_ID=174159357507', 'Claudia Olga Martinez',
  'movement_class=payment_in',
  '2026-08-22T10:13:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  293, 1054315166, 293,
  10934.00, 'income',
  'SOURCE_ID=174159141667', 'Gladis Toscano',
  'movement_class=payment_in',
  '2026-08-22T10:12:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  294, 1054315166, 294,
  7455.00, 'transfer',
  'SOURCE_ID=175094671136', '',
  'movement_class=transfer_in',
  '2026-08-22T10:12:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  295, 1054315166, 295,
  14910.00, 'income',
  'SOURCE_ID=175094186070', 'Maria Pia Vidussi',
  'movement_class=payment_in',
  '2026-08-22T10:11:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  296, 1054315166, 296,
  14910.00, 'income',
  'SOURCE_ID=174158461711', 'PABLO VERA',
  'movement_class=payment_in',
  '2026-08-22T10:07:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  297, 1054315166, 297,
  22365.00, 'income',
  'SOURCE_ID=175094130304', 'Diego',
  'movement_class=payment_in',
  '2026-08-22T10:05:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  298, 1054315166, 298,
  7455.00, 'income',
  'SOURCE_ID=174158101909', 'Pablo Dalponte',
  'movement_class=payment_in',
  '2026-08-22T10:04:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  299, 1054315166, 299,
  7455.00, 'transfer',
  'SOURCE_ID=174158506577', '',
  'movement_class=transfer_in',
  '2026-08-22T10:03:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  300, 1054315166, 300,
  6461.00, 'income',
  'SOURCE_ID=175093834500', 'Cueros GM',
  'movement_class=payment_in',
  '2026-08-22T10:03:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
