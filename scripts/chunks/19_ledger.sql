SET CONSTRAINTS ALL DEFERRED;

INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  451, 1054315166, 451,
  5964.00, 'income',
  'SOURCE_ID=173958512598', 'Liliana Recio',
  'movement_class=payment_in',
  '2026-08-15T09:21:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  452, 1054315166, 452,
  14910.00, 'income',
  'SOURCE_ID=173032667343', 'Irma',
  'movement_class=payment_in',
  '2026-08-15T09:19:43-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  453, 1054315166, 453,
  14910.00, 'income',
  'SOURCE_ID=173033074319', 'MARIELA FERNANDA BARRIONUEVO',
  'movement_class=payment_in',
  '2026-08-15T09:19:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  454, 1054315166, 454,
  14910.00, 'income',
  'SOURCE_ID=173031127129', 'Ariel Dario Barbieri',
  'movement_class=payment_in',
  '2026-08-15T09:01:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  455, 1054315166, 455,
  7455.00, 'income',
  'SOURCE_ID=173030009601', 'federico montoya',
  'movement_class=payment_in',
  '2026-08-15T08:51:52-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  456, 1054315166, 456,
  7455.00, 'income',
  'SOURCE_ID=173955317330', 'PABLO SOLANO',
  'movement_class=payment_in',
  '2026-08-15T08:49:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  457, 1054315166, 457,
  14910.00, 'income',
  'SOURCE_ID=173955161494', 'Tercer Set',
  'movement_class=payment_in',
  '2026-08-15T08:48:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  458, 1054315166, 458,
  7455.00, 'income',
  'SOURCE_ID=173955346670', 'Claudio Carlos Parra',
  'movement_class=payment_in',
  '2026-08-15T08:45:14-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  459, 1054315166, 459,
  7455.00, 'income',
  'SOURCE_ID=173953359156', 'ALDA CINTIA LUCRECIA VALLA',
  'movement_class=payment_in',
  '2026-08-15T08:21:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  460, 1054315166, 460,
  65604.00, 'income',
  'SOURCE_ID=173025524085', 'DESPENSA EL TILO',
  'movement_class=payment_in',
  '2026-08-15T07:50:31-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  461, 1054315166, 461,
  -116729.20, 'expense',
  'SOURCE_ID=173026324909', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-15T07:49:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  462, 1054315166, 462,
  -140852.13, 'expense',
  'SOURCE_ID=172846283509', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-14T08:10:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  463, 1054315166, 463,
  1743.79, 'interest_income',
  'SOURCE_ID=1748393881517', '',
  'movement_class=yield',
  '2026-08-14T04:58:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  464, 1054315166, 464,
  7455.00, 'income',
  'SOURCE_ID=172781714333', 'Cuadrito',
  'movement_class=payment_in',
  '2026-08-13T18:55:59-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  465, 1054315166, 465,
  -261560.00, 'expense',
  'SOURCE_ID=173692799190', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-13T17:54:05-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  466, 1054315166, 466,
  1872.34, 'interest_income',
  'SOURCE_ID=1748326829154', '',
  'movement_class=yield',
  '2026-08-13T05:51:48-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  467, 1054315166, 467,
  -45303.20, 'expense',
  'SOURCE_ID=172561562947', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-12T21:23:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  468, 1054315166, 468,
  14910.00, 'income',
  'SOURCE_ID=172546560625', 'Maria Daniela Damboria',
  'movement_class=payment_in',
  '2026-08-12T19:52:36-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  469, 1054315166, 469,
  143135.99, 'income',
  'SOURCE_ID=172470033121', 'EL KEROSENERO SA',
  'movement_class=payment_in',
  '2026-08-12T12:21:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  470, 1054315166, 470,
  35784.00, 'income',
  'SOURCE_ID=173367906592', 'HiHat Experience',
  'movement_class=payment_in',
  '2026-08-12T10:31:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  471, 1054315166, 471,
  1639.58, 'interest_income',
  'SOURCE_ID=1748229250572', '',
  'movement_class=yield',
  '2026-08-12T02:05:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  472, 1054315166, 472,
  232596.00, 'income',
  'SOURCE_ID=172400289769', 'Mrpolloviedma1',
  'movement_class=payment_in',
  '2026-08-11T22:00:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  473, 1054315166, 473,
  77532.00, 'income',
  'SOURCE_ID=172397305193', 'lu',
  'movement_class=payment_in',
  '2026-08-11T21:36:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  474, 1054315166, 474,
  74550.00, 'transfer',
  'SOURCE_ID=173310344146', '',
  'movement_class=transfer_in',
  '2026-08-11T21:27:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  475, 1054315166, 475,
  -125391.67, 'expense',
  'SOURCE_ID=172386381667', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-11T20:24:41-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  476, 1054315166, 476,
  1615.20, 'interest_income',
  'SOURCE_ID=1748160072092', '',
  'movement_class=yield',
  '2026-08-11T03:58:59-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  477, 1054315166, 477,
  7455.00, 'transfer',
  'SOURCE_ID=172221288879', 'Lucrecia Guttmann',
  'movement_class=transfer_in',
  '2026-08-10T20:46:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  478, 1054315166, 478,
  290248.00, 'income',
  'SOURCE_ID=173061964864', 'Autoservicio ailen ',
  'movement_class=payment_in',
  '2026-08-10T14:15:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  479, 1054315166, 479,
  7455.00, 'income',
  'SOURCE_ID=172114310215', 'CARLOS MANUEL IERACITANO',
  'movement_class=payment_in',
  '2026-08-10T11:09:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  480, 1054315166, 480,
  2213.91, 'interest_income',
  'SOURCE_ID=1748077074905', '',
  'movement_class=yield',
  '2026-08-10T03:23:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  481, 1054315166, 481,
  32802.00, 'income',
  'SOURCE_ID=172051417587', 'MARIANA SACCHETTI',
  'movement_class=payment_in',
  '2026-08-09T21:17:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  482, 1054315166, 482,
  20874.00, 'income',
  'SOURCE_ID=172954029942', 'club',
  'movement_class=payment_in',
  '2026-08-09T20:30:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  483, 1054315166, 483,
  -20120.00, 'expense',
  'SOURCE_ID=172910540152', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-09T14:35:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  484, 1054315166, 484,
  77532.00, 'transfer',
  'SOURCE_ID=171883688881', '',
  'movement_class=transfer_in',
  '2026-08-08T18:03:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  485, 1054315166, 485,
  6958.00, 'income',
  'SOURCE_ID=171848447651', 'Maria Daniela Damboria',
  'movement_class=payment_in',
  '2026-08-08T14:30:27-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  486, 1054315166, 486,
  198800.00, 'income',
  'SOURCE_ID=172737153258', 'marcial',
  'movement_class=payment_in',
  '2026-08-08T12:48:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  487, 1054315166, 487,
  116298.00, 'income',
  'SOURCE_ID=171829776149', 'Puesto 92',
  'movement_class=payment_in',
  '2026-08-08T12:45:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  488, 1054315166, 488,
  7455.00, 'income',
  'SOURCE_ID=171826389995', 'Odontología Dr Rial',
  'movement_class=payment_in',
  '2026-08-08T12:30:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  489, 1054315166, 489,
  3479.00, 'transfer',
  'SOURCE_ID=171818323821', '',
  'movement_class=transfer_in',
  '2026-08-08T11:49:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  490, 1054315166, 490,
  11928.00, 'income',
  'SOURCE_ID=171818608143', 'NICOLÁS ANDRÉS FRATTINI',
  'movement_class=payment_in',
  '2026-08-08T11:48:48-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  491, 1054315166, 491,
  5964.00, 'income',
  'SOURCE_ID=171818213045', 'Aldi',
  'movement_class=payment_in',
  '2026-08-08T11:47:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  492, 1054315166, 492,
  5964.00, 'income',
  'SOURCE_ID=172724726888', 'ELVIA RODRIGUEZ',
  'movement_class=payment_in',
  '2026-08-08T11:46:59-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  493, 1054315166, 493,
  5964.00, 'transfer',
  'SOURCE_ID=171817319933', '',
  'movement_class=transfer_in',
  '2026-08-08T11:45:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  494, 1054315166, 494,
  23856.00, 'income',
  'SOURCE_ID=171817269605', 'Leonardo Namur',
  'movement_class=payment_in',
  '2026-08-08T11:44:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  495, 1054315166, 495,
  7455.00, 'transfer',
  'SOURCE_ID=172724327180', '',
  'movement_class=transfer_in',
  '2026-08-08T11:44:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  496, 1054315166, 496,
  5964.00, 'income',
  'SOURCE_ID=171817249561', 'MIGUEL MARCELO CALVO',
  'movement_class=payment_in',
  '2026-08-08T11:44:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  497, 1054315166, 497,
  14910.00, 'income',
  'SOURCE_ID=171817268959', 'RDInd',
  'movement_class=payment_in',
  '2026-08-08T11:43:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  498, 1054315166, 498,
  11928.00, 'income',
  'SOURCE_ID=172724012820', 'COVEN MZMG',
  'movement_class=payment_in',
  '2026-08-08T11:42:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  499, 1054315166, 499,
  4970.00, 'income',
  'SOURCE_ID=171816609337', 'Jessica gasperoni',
  'movement_class=payment_in',
  '2026-08-08T11:42:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  500, 1054315166, 500,
  11928.00, 'income',
  'SOURCE_ID=172723469902', 'gustavo franchello',
  'movement_class=payment_in',
  '2026-08-08T11:39:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  501, 1054315166, 501,
  5964.00, 'transfer',
  'SOURCE_ID=171815983097', '',
  'movement_class=transfer_in',
  '2026-08-08T11:38:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  502, 1054315166, 502,
  11928.00, 'income',
  'SOURCE_ID=171815770373', 'Nicole Bari ',
  'movement_class=payment_in',
  '2026-08-08T11:35:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  503, 1054315166, 503,
  5964.00, 'income',
  'SOURCE_ID=172722403342', 'ANA LAURA VIGLIONE',
  'movement_class=payment_in',
  '2026-08-08T11:34:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  504, 1054315166, 504,
  5964.00, 'income',
  'SOURCE_ID=171814937937', 'delfin venancio pardo',
  'movement_class=payment_in',
  '2026-08-08T11:32:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  505, 1054315166, 505,
  5964.00, 'income',
  'SOURCE_ID=171815060617', 'PABLO SOLANO',
  'movement_class=payment_in',
  '2026-08-08T11:31:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  506, 1054315166, 506,
  14910.00, 'income',
  'SOURCE_ID=171815020205', 'ALEJANDRO ALBERTO AGRA',
  'movement_class=payment_in',
  '2026-08-08T11:30:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  507, 1054315166, 507,
  7455.00, 'income',
  'SOURCE_ID=172721502482', 'ALFONSO GIMENEZ MELLUSO',
  'movement_class=payment_in',
  '2026-08-08T11:29:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  508, 1054315166, 508,
  22365.00, 'transfer',
  'SOURCE_ID=171814227927', '',
  'movement_class=transfer_in',
  '2026-08-08T11:28:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  509, 1054315166, 509,
  7455.00, 'transfer',
  'SOURCE_ID=171814193933', '',
  'movement_class=transfer_in',
  '2026-08-08T11:28:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  510, 1054315166, 510,
  7455.00, 'income',
  'SOURCE_ID=171813979873', 'Hernan bocci',
  'movement_class=payment_in',
  '2026-08-08T11:26:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  511, 1054315166, 511,
  14910.00, 'income',
  'SOURCE_ID=171813444011', 'Alejandro Lezcano',
  'movement_class=payment_in',
  '2026-08-08T11:24:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  512, 1054315166, 512,
  7455.00, 'income',
  'SOURCE_ID=172720453034', 'Carlos Lugani',
  'movement_class=payment_in',
  '2026-08-08T11:23:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  513, 1054315166, 513,
  5964.00, 'income',
  'SOURCE_ID=172720131370', 'Mauro Darío Armas',
  'movement_class=payment_in',
  '2026-08-08T11:22:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  514, 1054315166, 514,
  7455.00, 'income',
  'SOURCE_ID=172720394334', 'Martin Nicolas Abdala',
  'movement_class=payment_in',
  '2026-08-08T11:21:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  515, 1054315166, 515,
  7455.00, 'income',
  'SOURCE_ID=172719026090', 'Juan Domingo Díaz',
  'movement_class=payment_in',
  '2026-08-08T11:16:13-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  516, 1054315166, 516,
  5964.00, 'income',
  'SOURCE_ID=172719332650', 'EDUARDO MENDEZ',
  'movement_class=payment_in',
  '2026-08-08T11:15:22-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  517, 1054315166, 517,
  7455.00, 'income',
  'SOURCE_ID=172718255720', 'Jorge Farabello',
  'movement_class=payment_in',
  '2026-08-08T11:11:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  518, 1054315166, 518,
  7455.00, 'income',
  'SOURCE_ID=172717836682', 'Alejandro Ferrara',
  'movement_class=payment_in',
  '2026-08-08T11:08:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  519, 1054315166, 519,
  11928.00, 'income',
  'SOURCE_ID=172717596228', 'CAROLINA CAMACHO',
  'movement_class=payment_in',
  '2026-08-08T11:06:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  520, 1054315166, 520,
  11928.00, 'transfer',
  'SOURCE_ID=171810279283', 'MARIA MAGDALENA RIVAS',
  'movement_class=transfer_in',
  '2026-08-08T11:04:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  521, 1054315166, 521,
  7455.00, 'transfer',
  'SOURCE_ID=172716330668', '',
  'movement_class=transfer_in',
  '2026-08-08T10:59:00-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  522, 1054315166, 522,
  22365.00, 'income',
  'SOURCE_ID=172715908890', 'Jose Garcia Francisco Lago',
  'movement_class=payment_in',
  '2026-08-08T10:56:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  523, 1054315166, 523,
  7455.00, 'transfer',
  'SOURCE_ID=171808011377', '',
  'movement_class=transfer_in',
  '2026-08-08T10:53:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  524, 1054315166, 524,
  14910.00, 'income',
  'SOURCE_ID=172715334752', 'Hector Hernandez',
  'movement_class=payment_in',
  '2026-08-08T10:52:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  525, 1054315166, 525,
  14910.00, 'income',
  'SOURCE_ID=172715158570', 'MARIA VANESA SURIN',
  'movement_class=payment_in',
  '2026-08-08T10:50:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  526, 1054315166, 526,
  22365.00, 'income',
  'SOURCE_ID=172715040144', 'alejandro coleffi',
  'movement_class=payment_in',
  '2026-08-08T10:48:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  527, 1054315166, 527,
  1491.00, 'transfer',
  'SOURCE_ID=171806789647', '',
  'movement_class=transfer_in',
  '2026-08-08T10:45:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  528, 1054315166, 528,
  5964.00, 'transfer',
  'SOURCE_ID=171807020417', '',
  'movement_class=transfer_in',
  '2026-08-08T10:44:41-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  529, 1054315166, 529,
  11928.00, 'income',
  'SOURCE_ID=171806599613', 'CLEMENTE ARAMENDI',
  'movement_class=payment_in',
  '2026-08-08T10:44:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  530, 1054315166, 530,
  5964.00, 'income',
  'SOURCE_ID=171806722131', 'Tiny',
  'movement_class=payment_in',
  '2026-08-08T10:41:36-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  531, 1054315166, 531,
  7455.00, 'income',
  'SOURCE_ID=172713185444', 'Julio Nadal',
  'movement_class=payment_in',
  '2026-08-08T10:41:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  532, 1054315166, 532,
  7455.00, 'income',
  'SOURCE_ID=172712761978', 'Vicente ',
  'movement_class=payment_in',
  '2026-08-08T10:40:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  533, 1054315166, 533,
  5964.00, 'income',
  'SOURCE_ID=171805947687', 'MARIO DANIEL LORCA',
  'movement_class=payment_in',
  '2026-08-08T10:38:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  534, 1054315166, 534,
  20874.00, 'transfer',
  'SOURCE_ID=171806057005', '',
  'movement_class=transfer_in',
  '2026-08-08T10:38:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  535, 1054315166, 535,
  7455.00, 'income',
  'SOURCE_ID=171806108521', 'Carlos10',
  'movement_class=payment_in',
  '2026-08-08T10:37:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  536, 1054315166, 536,
  5964.00, 'transfer',
  'SOURCE_ID=171805316783', '',
  'movement_class=transfer_in',
  '2026-08-08T10:31:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  537, 1054315166, 537,
  14910.00, 'income',
  'SOURCE_ID=171805025299', 'Luci Cornou',
  'movement_class=payment_in',
  '2026-08-08T10:30:43-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  538, 1054315166, 538,
  7455.00, 'income',
  'SOURCE_ID=171804791619', 'ADRIAN OLIVETTI',
  'movement_class=payment_in',
  '2026-08-08T10:30:04-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  539, 1054315166, 539,
  7455.00, 'income',
  'SOURCE_ID=172710463934', 'Gustavo Carnevale',
  'movement_class=payment_in',
  '2026-08-08T10:24:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  540, 1054315166, 540,
  13419.00, 'income',
  'SOURCE_ID=172710760524', 'Federico Tonini',
  'movement_class=payment_in',
  '2026-08-08T10:23:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  541, 1054315166, 541,
  22365.00, 'transfer',
  'SOURCE_ID=171803779069', '',
  'movement_class=transfer_in',
  '2026-08-08T10:23:05-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  542, 1054315166, 542,
  7455.00, 'transfer',
  'SOURCE_ID=172710684128', 'Fabi Schw',
  'movement_class=transfer_in',
  '2026-08-08T10:21:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  543, 1054315166, 543,
  7455.00, 'income',
  'SOURCE_ID=171803389085', 'CARLOS LIZARRALDE',
  'movement_class=payment_in',
  '2026-08-08T10:21:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  544, 1054315166, 544,
  7455.00, 'income',
  'SOURCE_ID=171802962979', 'sofia quiriconi',
  'movement_class=payment_in',
  '2026-08-08T10:19:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  545, 1054315166, 545,
  38766.00, 'income',
  'SOURCE_ID=172709771806', 'Hector Masajes',
  'movement_class=payment_in',
  '2026-08-08T10:18:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  546, 1054315166, 546,
  7455.00, 'income',
  'SOURCE_ID=171802384611', 'Milene Marie Rica',
  'movement_class=payment_in',
  '2026-08-08T10:13:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  547, 1054315166, 547,
  7455.00, 'transfer',
  'SOURCE_ID=171801921915', '',
  'movement_class=transfer_in',
  '2026-08-08T10:13:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  548, 1054315166, 548,
  14910.00, 'transfer',
  'SOURCE_ID=171801722769', '',
  'movement_class=transfer_in',
  '2026-08-08T10:08:00-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  549, 1054315166, 549,
  5964.00, 'income',
  'SOURCE_ID=171801248185', 'Ezequiel Fazio',
  'movement_class=payment_in',
  '2026-08-08T10:01:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  550, 1054315166, 550,
  17892.00, 'transfer',
  'SOURCE_ID=172706473734', 'Remeruli',
  'movement_class=transfer_in',
  '2026-08-08T09:55:52-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  551, 1054315166, 551,
  14910.00, 'income',
  'SOURCE_ID=171799665369', 'Mirian Edith Dominguez',
  'movement_class=payment_in',
  '2026-08-08T09:50:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  552, 1054315166, 552,
  7455.00, 'income',
  'SOURCE_ID=172706028180', 'Nai',
  'movement_class=payment_in',
  '2026-08-08T09:46:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  553, 1054315166, 553,
  5964.00, 'income',
  'SOURCE_ID=171798453437', 'Pasionarte',
  'movement_class=payment_in',
  '2026-08-08T09:45:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  554, 1054315166, 554,
  17892.00, 'income',
  'SOURCE_ID=172705656204', 'SERGIO DANIEL CAMPOS',
  'movement_class=payment_in',
  '2026-08-08T09:41:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  555, 1054315166, 555,
  14910.00, 'income',
  'SOURCE_ID=171797216557', 'MARCOS HERNAN SELEIMAN',
  'movement_class=payment_in',
  '2026-08-08T09:30:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  556, 1054315166, 556,
  11928.00, 'income',
  'SOURCE_ID=171796324065', 'GRACIELA MILET SANCHEZ',
  'movement_class=payment_in',
  '2026-08-08T09:27:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  557, 1054315166, 557,
  14910.00, 'income',
  'SOURCE_ID=172702062046', 'Adelicia',
  'movement_class=payment_in',
  '2026-08-08T09:20:06-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  558, 1054315166, 558,
  11928.00, 'transfer',
  'SOURCE_ID=172702104680', '',
  'movement_class=transfer_in',
  '2026-08-08T09:14:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  559, 1054315166, 559,
  14910.00, 'income',
  'SOURCE_ID=171795636319', 'MARIELA FERNANDA BARRIONUEVO',
  'movement_class=payment_in',
  '2026-08-08T09:12:05-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  560, 1054315166, 560,
  22365.00, 'income',
  'SOURCE_ID=172701120960', 'delvis Hecker',
  'movement_class=payment_in',
  '2026-08-08T09:03:29-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  561, 1054315166, 561,
  7455.00, 'income',
  'SOURCE_ID=171793969461', 'PaOo Calderon',
  'movement_class=payment_in',
  '2026-08-08T09:02:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  562, 1054315166, 562,
  14910.00, 'income',
  'SOURCE_ID=172700755568', 'Julieta Racca',
  'movement_class=payment_in',
  '2026-08-08T09:02:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  563, 1054315166, 563,
  5964.00, 'income',
  'SOURCE_ID=171794518317', 'Liliana Recio',
  'movement_class=payment_in',
  '2026-08-08T09:00:43-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  564, 1054315166, 564,
  14910.00, 'income',
  'SOURCE_ID=171792583595', 'zonaXx',
  'movement_class=payment_in',
  '2026-08-08T08:51:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  565, 1054315166, 565,
  22365.00, 'income',
  'SOURCE_ID=172699685962', 'PABLO VERA',
  'movement_class=payment_in',
  '2026-08-08T08:49:14-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  566, 1054315166, 566,
  7455.00, 'income',
  'SOURCE_ID=172699744758', 'Marcos Saez',
  'movement_class=payment_in',
  '2026-08-08T08:42:04-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  567, 1054315166, 567,
  7455.00, 'income',
  'SOURCE_ID=172699075368', 'Pablo Dalponte',
  'movement_class=payment_in',
  '2026-08-08T08:38:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  568, 1054315166, 568,
  7455.00, 'income',
  'SOURCE_ID=172697733426', 'DANIEL ENRIQUE TORRES',
  'movement_class=payment_in',
  '2026-08-08T08:29:41-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  569, 1054315166, 569,
  11928.00, 'income',
  'SOURCE_ID=171790285947', 'LUCIANA SANCOCHIA',
  'movement_class=payment_in',
  '2026-08-08T08:19:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  570, 1054315166, 570,
  14910.00, 'income',
  'SOURCE_ID=171790351503', 'LUCIANA GARCIA CABEZON',
  'movement_class=payment_in',
  '2026-08-08T08:16:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  571, 1054315166, 571,
  127232.00, 'income',
  'SOURCE_ID=172696502814', 'DESPENSA EL TILO',
  'movement_class=payment_in',
  '2026-08-08T08:02:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  572, 1054315166, 572,
  32802.00, 'income',
  'SOURCE_ID=172594999866', 'Matias Margiotta',
  'movement_class=payment_in',
  '2026-08-07T16:38:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  573, 1054315166, 573,
  13916.00, 'transfer',
  'SOURCE_ID=172538854572', '',
  'movement_class=transfer_in',
  '2026-08-07T11:32:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  574, 1054315166, 574,
  729.46, 'interest_income',
  'SOURCE_ID=1748021959381', '',
  'movement_class=yield',
  '2026-08-07T07:53:46-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  575, 1054315166, 575,
  7455.00, 'income',
  'SOURCE_ID=171555564807', 'Higiene y Control',
  'movement_class=payment_in',
  '2026-08-06T21:02:10-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  576, 1054315166, 576,
  -44278.08, 'expense',
  'SOURCE_ID=171555285347', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-06T21:00:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  577, 1054315166, 577,
  232596.00, 'income',
  'SOURCE_ID=171463417891', 'Mrpolloviedma2',
  'movement_class=payment_in',
  '2026-08-06T12:42:05-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  578, 1054315166, 578,
  -171020.00, 'expense',
  'SOURCE_ID=172337263372', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-06T09:58:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  579, 1054315166, 579,
  754.57, 'interest_income',
  'SOURCE_ID=1747935766031', '',
  'movement_class=yield',
  '2026-08-06T05:52:00-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  580, 1054315166, 580,
  -76124.43, 'expense',
  'SOURCE_ID=172294372566', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-05T22:51:06-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  581, 1054315166, 581,
  71568.00, 'income',
  'SOURCE_ID=171376315073', 'Bachin',
  'movement_class=payment_in',
  '2026-08-05T20:54:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  582, 1054315166, 582,
  351876.00, 'income',
  'SOURCE_ID=171337834905', 'jorgito',
  'movement_class=payment_in',
  '2026-08-05T17:32:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  583, 1054315166, 583,
  232596.00, 'income',
  'SOURCE_ID=172193145866', 'Mrpolloviedma2',
  'movement_class=payment_in',
  '2026-08-05T12:53:06-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  584, 1054315166, 584,
  65604.00, 'income',
  'SOURCE_ID=171273760735', 'Lo de Luca',
  'movement_class=payment_in',
  '2026-08-05T11:14:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  585, 1054315166, 585,
  1230.80, 'interest_income',
  'SOURCE_ID=1747872186642', '',
  'movement_class=yield',
  '2026-08-05T06:02:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  586, 1054315166, 586,
  -78136.11, 'expense',
  'SOURCE_ID=172119544400', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-04T22:43:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  587, 1054315166, 587,
  65604.00, 'income',
  'SOURCE_ID=171118646749', 'Matias Margiotta',
  'movement_class=payment_in',
  '2026-08-04T12:17:47-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  588, 1054315166, 588,
  1220.63, 'interest_income',
  'SOURCE_ID=1747793855401', '',
  'movement_class=yield',
  '2026-08-04T05:01:10-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  589, 1054315166, 589,
  6958.00, 'transfer',
  'SOURCE_ID=171933056520', '',
  'movement_class=transfer_in',
  '2026-08-03T20:17:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  590, 1054315166, 590,
  7455.00, 'income',
  'SOURCE_ID=170972153957', 'Lucía Zamborán',
  'movement_class=payment_in',
  '2026-08-03T14:17:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  591, 1054315166, 591,
  5467.00, 'income',
  'SOURCE_ID=170930659443', 'Natalia Pastelería',
  'movement_class=payment_in',
  '2026-08-03T10:22:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  592, 1054315166, 592,
  297.48, 'interest_income',
  'SOURCE_ID=1747709954707', '',
  'movement_class=yield',
  '2026-08-03T04:46:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  593, 1054315166, 593,
  322056.00, 'income',
  'SOURCE_ID=170870343349', 'Mandi',
  'movement_class=payment_in',
  '2026-08-02T20:30:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  594, 1054315166, 594,
  6958.00, 'income',
  'SOURCE_ID=171636974226', 'Odontología Dr Rial',
  'movement_class=payment_in',
  '2026-08-01T20:33:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  595, 1054315166, 595,
  -117716.08, 'expense',
  'SOURCE_ID=170732506159', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-01T19:48:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  596, 1054315166, 596,
  241542.00, 'income',
  'SOURCE_ID=171577893876', 'freddy',
  'movement_class=payment_in',
  '2026-08-01T14:39:05-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  597, 1054315166, 597,
  497000.00, 'income',
  'SOURCE_ID=171576489764', 'marcial',
  'movement_class=payment_in',
  '2026-08-01T14:29:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  598, 1054315166, 598,
  5467.00, 'income',
  'SOURCE_ID=170657158679', 'Juanvidal',
  'movement_class=payment_in',
  '2026-08-01T12:18:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  599, 1054315166, 599,
  10934.00, 'income',
  'SOURCE_ID=170657136271', 'Silvia Mabel Calvo',
  'movement_class=payment_in',
  '2026-08-01T12:17:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  600, 1054315166, 600,
  16401.00, 'income',
  'SOURCE_ID=171553382666', 'juan carlos gonzales',
  'movement_class=payment_in',
  '2026-08-01T12:17:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
