SET CONSTRAINTS ALL DEFERRED;

INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  601, 1054315166, 601,
  5467.00, 'income',
  'SOURCE_ID=171552796048', 'Carolina Brecciaroli',
  'movement_class=payment_in',
  '2026-08-01T12:14:59-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  602, 1054315166, 602,
  4970.00, 'income',
  'SOURCE_ID=171552847404', 'GUILLERMO ARIEL GIANNI',
  'movement_class=payment_in',
  '2026-08-01T12:14:49-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  603, 1054315166, 603,
  10934.00, 'transfer',
  'SOURCE_ID=171551933914', '',
  'movement_class=transfer_in',
  '2026-08-01T12:10:48-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  604, 1054315166, 604,
  10934.00, 'income',
  'SOURCE_ID=170655714311', 'MARTA INES CORIA',
  'movement_class=payment_in',
  '2026-08-01T12:10:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  605, 1054315166, 605,
  9940.00, 'income',
  'SOURCE_ID=170655482721', 'Ventas Varias',
  'movement_class=payment_in',
  '2026-08-01T12:09:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  606, 1054315166, 606,
  10934.00, 'transfer',
  'SOURCE_ID=170655464127', '',
  'movement_class=transfer_in',
  '2026-08-01T12:09:14-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  607, 1054315166, 607,
  5467.00, 'income',
  'SOURCE_ID=170655083371', 'Alejandro Ferrara',
  'movement_class=payment_in',
  '2026-08-01T12:07:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  608, 1054315166, 608,
  5467.00, 'transfer',
  'SOURCE_ID=171551047480', '',
  'movement_class=transfer_in',
  '2026-08-01T12:05:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  609, 1054315166, 609,
  9940.00, 'income',
  'SOURCE_ID=171550986960', 'Lucrecia Beloqui',
  'movement_class=payment_in',
  '2026-08-01T12:05:06-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  610, 1054315166, 610,
  10934.00, 'income',
  'SOURCE_ID=171550796298', 'Carlos10',
  'movement_class=payment_in',
  '2026-08-01T12:03:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  611, 1054315166, 611,
  5467.00, 'income',
  'SOURCE_ID=170653764015', 'Nicole Bari ',
  'movement_class=payment_in',
  '2026-08-01T12:01:27-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  612, 1054315166, 612,
  4970.00, 'income',
  'SOURCE_ID=171549859240', 'Micaela Zunzunegui',
  'movement_class=payment_in',
  '2026-08-01T11:59:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  613, 1054315166, 613,
  10934.00, 'income',
  'SOURCE_ID=170653441675', 'Nelson Fabian Fernandez',
  'movement_class=payment_in',
  '2026-08-01T11:59:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  614, 1054315166, 614,
  9940.00, 'income',
  'SOURCE_ID=170653630123', 'NICOLÁS ANDRÉS FRATTINI',
  'movement_class=payment_in',
  '2026-08-01T11:59:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  615, 1054315166, 615,
  16401.00, 'income',
  'SOURCE_ID=171549051326', 'HECTOR CROCIATI',
  'movement_class=payment_in',
  '2026-08-01T11:55:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  616, 1054315166, 616,
  5467.00, 'income',
  'SOURCE_ID=170652425451', 'SR Carbon Custom',
  'movement_class=payment_in',
  '2026-08-01T11:53:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  617, 1054315166, 617,
  5467.00, 'transfer',
  'SOURCE_ID=170652122799', 'los 25 de la 51',
  'movement_class=transfer_in',
  '2026-08-01T11:51:41-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  618, 1054315166, 618,
  5467.00, 'income',
  'SOURCE_ID=171548181914', 'Ceci Garcia',
  'movement_class=payment_in',
  '2026-08-01T11:50:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  619, 1054315166, 619,
  10934.00, 'income',
  'SOURCE_ID=170651432483', 'CAROLINA FERRER',
  'movement_class=payment_in',
  '2026-08-01T11:47:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  620, 1054315166, 620,
  5467.00, 'income',
  'SOURCE_ID=171547696834', 'LUCIA CRESPO',
  'movement_class=payment_in',
  '2026-08-01T11:46:52-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  621, 1054315166, 621,
  10437.00, 'income',
  'SOURCE_ID=171547533998', 'viaje',
  'movement_class=payment_in',
  '2026-08-01T11:46:52-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  622, 1054315166, 622,
  5467.00, 'income',
  'SOURCE_ID=170650879339', 'Daluarviedma',
  'movement_class=payment_in',
  '2026-08-01T11:45:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  623, 1054315166, 623,
  10934.00, 'income',
  'SOURCE_ID=170650781551', 'Mabel Monica Lopez',
  'movement_class=payment_in',
  '2026-08-01T11:44:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  624, 1054315166, 624,
  10934.00, 'transfer',
  'SOURCE_ID=170650518839', 'MIRTA YOLANDA COLLOMILLA',
  'movement_class=transfer_in',
  '2026-08-01T11:42:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  625, 1054315166, 625,
  6958.00, 'income',
  'SOURCE_ID=170650347449', 'Laura Haydée Segovia',
  'movement_class=payment_in',
  '2026-08-01T11:42:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  626, 1054315166, 626,
  6958.00, 'transfer',
  'SOURCE_ID=171546645516', 'Martin Nicolas Abdala',
  'movement_class=transfer_in',
  '2026-08-01T11:41:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  627, 1054315166, 627,
  6958.00, 'income',
  'SOURCE_ID=170650232951', 'Juan Pablo Nieva',
  'movement_class=payment_in',
  '2026-08-01T11:41:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  628, 1054315166, 628,
  6958.00, 'income',
  'SOURCE_ID=170650148433', 'Milton Damian Pereyra',
  'movement_class=payment_in',
  '2026-08-01T11:40:06-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  629, 1054315166, 629,
  13916.00, 'income',
  'SOURCE_ID=170649799051', 'alejandra carmona',
  'movement_class=payment_in',
  '2026-08-01T11:38:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  630, 1054315166, 630,
  6958.00, 'income',
  'SOURCE_ID=170649894261', 'Lorenzo Mora',
  'movement_class=payment_in',
  '2026-08-01T11:38:14-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  631, 1054315166, 631,
  13916.00, 'income',
  'SOURCE_ID=171545625642', 'Gustavo Carnevale',
  'movement_class=payment_in',
  '2026-08-01T11:36:13-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  632, 1054315166, 632,
  6958.00, 'transfer',
  'SOURCE_ID=171545457462', 'GIANFRANCO MAZZIOTTI',
  'movement_class=transfer_in',
  '2026-08-01T11:35:14-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  633, 1054315166, 633,
  9940.00, 'income',
  'SOURCE_ID=170649128827', 'andres zimmermann',
  'movement_class=payment_in',
  '2026-08-01T11:34:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  634, 1054315166, 634,
  13916.00, 'income',
  'SOURCE_ID=170649002465', 'MARCOS HERNAN SELEIMAN',
  'movement_class=payment_in',
  '2026-08-01T11:33:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  635, 1054315166, 635,
  13916.00, 'income',
  'SOURCE_ID=171545087482', 'MARCOS HERNAN SELEIMAN',
  'movement_class=payment_in',
  '2026-08-01T11:33:00-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  636, 1054315166, 636,
  13916.00, 'transfer',
  'SOURCE_ID=171544853868', 'Marcela Burgoa',
  'movement_class=transfer_in',
  '2026-08-01T11:31:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  637, 1054315166, 637,
  13916.00, 'income',
  'SOURCE_ID=171544707734', 'Jumpingviedma ',
  'movement_class=payment_in',
  '2026-08-01T11:30:36-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  638, 1054315166, 638,
  6958.00, 'income',
  'SOURCE_ID=170648084173', 'Rosana Soracio',
  'movement_class=payment_in',
  '2026-08-01T11:27:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  639, 1054315166, 639,
  5467.00, 'income',
  'SOURCE_ID=171544166854', 'Autoservicio puma',
  'movement_class=payment_in',
  '2026-08-01T11:26:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  640, 1054315166, 640,
  6958.00, 'income',
  'SOURCE_ID=170647365949', 'romina ekerman',
  'movement_class=payment_in',
  '2026-08-01T11:25:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  641, 1054315166, 641,
  6958.00, 'income',
  'SOURCE_ID=171543494314', 'Gráfica el Maestro',
  'movement_class=payment_in',
  '2026-08-01T11:22:14-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  642, 1054315166, 642,
  13916.00, 'income',
  'SOURCE_ID=170646267723', 'Lisandro',
  'movement_class=payment_in',
  '2026-08-01T11:18:22-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  643, 1054315166, 643,
  119280.00, 'income',
  'SOURCE_ID=171542285204', 'Matias Margiotta',
  'movement_class=payment_in',
  '2026-08-01T11:16:04-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  644, 1054315166, 644,
  6958.00, 'income',
  'SOURCE_ID=170646144125', 'Hilda Maria Huentelaf',
  'movement_class=payment_in',
  '2026-08-01T11:16:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  645, 1054315166, 645,
  35784.00, 'income',
  'SOURCE_ID=170645976789', 'Su Guerrero',
  'movement_class=payment_in',
  '2026-08-01T11:15:28-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  646, 1054315166, 646,
  13916.00, 'transfer',
  'SOURCE_ID=170645889071', '',
  'movement_class=transfer_in',
  '2026-08-01T11:15:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  647, 1054315166, 647,
  6958.00, 'income',
  'SOURCE_ID=171541929744', 'ADRIANA FERREYRA',
  'movement_class=payment_in',
  '2026-08-01T11:14:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  648, 1054315166, 648,
  13916.00, 'transfer',
  'SOURCE_ID=171542124170', '',
  'movement_class=transfer_in',
  '2026-08-01T11:14:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  649, 1054315166, 649,
  13916.00, 'income',
  'SOURCE_ID=170645195607', 'MARIA VANESA SURIN',
  'movement_class=payment_in',
  '2026-08-01T11:11:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  650, 1054315166, 650,
  13916.00, 'income',
  'SOURCE_ID=171541235324', 'Gaspar Ivan Garrido',
  'movement_class=payment_in',
  '2026-08-01T11:09:36-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  651, 1054315166, 651,
  13916.00, 'transfer',
  'SOURCE_ID=171541079220', '',
  'movement_class=transfer_in',
  '2026-08-01T11:08:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  652, 1054315166, 652,
  13916.00, 'income',
  'SOURCE_ID=170644488019', 'Marien®',
  'movement_class=payment_in',
  '2026-08-01T11:07:31-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  653, 1054315166, 653,
  13916.00, 'income',
  'SOURCE_ID=170644430993', 'Maria Pia Vidussi',
  'movement_class=payment_in',
  '2026-08-01T11:06:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  654, 1054315166, 654,
  1789.20, 'income',
  'SOURCE_ID=170644494351', 'Carola  González León',
  'movement_class=payment_in',
  '2026-08-01T11:05:48-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  655, 1054315166, 655,
  6958.00, 'income',
  'SOURCE_ID=170644005687', 'ROBERTO ADRIAN HAURE',
  'movement_class=payment_in',
  '2026-08-01T11:04:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  656, 1054315166, 656,
  13916.00, 'income',
  'SOURCE_ID=171540107620', 'FLORENCIA BELEN BERREAUTE',
  'movement_class=payment_in',
  '2026-08-01T11:02:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  657, 1054315166, 657,
  6958.00, 'income',
  'SOURCE_ID=170643694861', 'Martin Alcalde',
  'movement_class=payment_in',
  '2026-08-01T11:01:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  658, 1054315166, 658,
  6958.00, 'transfer',
  'SOURCE_ID=170643571179', '',
  'movement_class=transfer_in',
  '2026-08-01T11:01:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  659, 1054315166, 659,
  3479.00, 'transfer',
  'SOURCE_ID=171539988820', '',
  'movement_class=transfer_in',
  '2026-08-01T11:01:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  660, 1054315166, 660,
  6958.00, 'income',
  'SOURCE_ID=170642926701', 'Gustavo Rivero',
  'movement_class=payment_in',
  '2026-08-01T10:55:36-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  661, 1054315166, 661,
  6958.00, 'income',
  'SOURCE_ID=170642851133', 'RENE EDUARDO TEUSCHER PALMA',
  'movement_class=payment_in',
  '2026-08-01T10:55:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  662, 1054315166, 662,
  6958.00, 'transfer',
  'SOURCE_ID=171538899870', '',
  'movement_class=transfer_in',
  '2026-08-01T10:55:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  663, 1054315166, 663,
  6958.00, 'income',
  'SOURCE_ID=170642864643', 'la autentica',
  'movement_class=payment_in',
  '2026-08-01T10:54:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  664, 1054315166, 664,
  20874.00, 'income',
  'SOURCE_ID=171539036730', 'alejandro coleffi',
  'movement_class=payment_in',
  '2026-08-01T10:54:39-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  665, 1054315166, 665,
  6958.00, 'income',
  'SOURCE_ID=171538609878', 'andres monzon',
  'movement_class=payment_in',
  '2026-08-01T10:53:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  666, 1054315166, 666,
  6958.00, 'income',
  'SOURCE_ID=170642295277', 'Lorena Garat',
  'movement_class=payment_in',
  '2026-08-01T10:52:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  667, 1054315166, 667,
  6958.00, 'income',
  'SOURCE_ID=171538329180', 'Carolina psa',
  'movement_class=payment_in',
  '2026-08-01T10:50:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  668, 1054315166, 668,
  13916.00, 'income',
  'SOURCE_ID=171538199720', 'paola marcel',
  'movement_class=payment_in',
  '2026-08-01T10:50:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  669, 1054315166, 669,
  13916.00, 'transfer',
  'SOURCE_ID=170641932421', '',
  'movement_class=transfer_in',
  '2026-08-01T10:48:43-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  670, 1054315166, 670,
  5268.20, 'income',
  'SOURCE_ID=170641962155', 'Sergio Vechiati',
  'movement_class=payment_in',
  '2026-08-01T10:48:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  671, 1054315166, 671,
  20874.00, 'income',
  'SOURCE_ID=171537185776', 'Royal prestige',
  'movement_class=payment_in',
  '2026-08-01T10:43:05-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  672, 1054315166, 672,
  6958.00, 'transfer',
  'SOURCE_ID=171537384590', '',
  'movement_class=transfer_in',
  '2026-08-01T10:42:37-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  673, 1054315166, 673,
  13916.00, 'income',
  'SOURCE_ID=170640571815', 'Santiago Alberto Miguelez',
  'movement_class=payment_in',
  '2026-08-01T10:41:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  674, 1054315166, 674,
  6958.00, 'income',
  'SOURCE_ID=171536994578', 'Mario juaquin Urrutia',
  'movement_class=payment_in',
  '2026-08-01T10:40:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  675, 1054315166, 675,
  13916.00, 'transfer',
  'SOURCE_ID=171536685836', '',
  'movement_class=transfer_in',
  '2026-08-01T10:39:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  676, 1054315166, 676,
  6958.00, 'income',
  'SOURCE_ID=171536475250', 'PABLO VERA',
  'movement_class=payment_in',
  '2026-08-01T10:37:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  677, 1054315166, 677,
  2485.00, 'income',
  'SOURCE_ID=171536169280', 'Narciso Esteban Martinez',
  'movement_class=payment_in',
  '2026-08-01T10:35:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  678, 1054315166, 678,
  6958.00, 'income',
  'SOURCE_ID=171535739924', 'Pablo Dalponte',
  'movement_class=payment_in',
  '2026-08-01T10:33:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  679, 1054315166, 679,
  6958.00, 'income',
  'SOURCE_ID=171535992108', 'leonardo sandon',
  'movement_class=payment_in',
  '2026-08-01T10:32:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  680, 1054315166, 680,
  6958.00, 'income',
  'SOURCE_ID=170638840879', 'Europie',
  'movement_class=payment_in',
  '2026-08-01T10:27:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  681, 1054315166, 681,
  10934.00, 'transfer',
  'SOURCE_ID=170638529027', '',
  'movement_class=transfer_in',
  '2026-08-01T10:24:47-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  682, 1054315166, 682,
  5467.00, 'income',
  'SOURCE_ID=171534495568', 'SUSANA ANGELICA ELGUETA',
  'movement_class=payment_in',
  '2026-08-01T10:23:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  683, 1054315166, 683,
  6958.00, 'income',
  'SOURCE_ID=171534338492', 'antonio francioni',
  'movement_class=payment_in',
  '2026-08-01T10:21:13-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  684, 1054315166, 684,
  6958.00, 'income',
  'SOURCE_ID=170637367601', 'sergio zucal',
  'movement_class=payment_in',
  '2026-08-01T10:17:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  685, 1054315166, 685,
  13916.00, 'income',
  'SOURCE_ID=170637262655', 'Jose Garcia Francisco Lago',
  'movement_class=payment_in',
  '2026-08-01T10:15:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  686, 1054315166, 686,
  9940.00, 'transfer',
  'SOURCE_ID=171533466690', '',
  'movement_class=transfer_in',
  '2026-08-01T10:14:10-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  687, 1054315166, 687,
  10934.00, 'income',
  'SOURCE_ID=170636642179', 'Marcela Alejandra Poblete',
  'movement_class=payment_in',
  '2026-08-01T10:09:39-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  688, 1054315166, 688,
  6958.00, 'income',
  'SOURCE_ID=171532389376', 'Vicente ',
  'movement_class=payment_in',
  '2026-08-01T10:07:49-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  689, 1054315166, 689,
  13916.00, 'income',
  'SOURCE_ID=171531501798', 'MARIA ROSA BARBARA',
  'movement_class=payment_in',
  '2026-08-01T10:00:36-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  690, 1054315166, 690,
  13916.00, 'transfer',
  'SOURCE_ID=171531311418', 'Ramon Antonio Suarez',
  'movement_class=transfer_in',
  '2026-08-01T09:58:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  691, 1054315166, 691,
  6958.00, 'income',
  'SOURCE_ID=170634859125', 'CHRISTIAN ALBERTO MURO',
  'movement_class=payment_in',
  '2026-08-01T09:56:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  692, 1054315166, 692,
  6958.00, 'income',
  'SOURCE_ID=170634623379', 'Nai',
  'movement_class=payment_in',
  '2026-08-01T09:54:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  693, 1054315166, 693,
  13916.00, 'transfer',
  'SOURCE_ID=171530487676', 'Guille',
  'movement_class=transfer_in',
  '2026-08-01T09:52:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  694, 1054315166, 694,
  13916.00, 'income',
  'SOURCE_ID=171530437830', 'Andrea D''Angelo Rios',
  'movement_class=payment_in',
  '2026-08-01T09:51:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  695, 1054315166, 695,
  9940.00, 'income',
  'SOURCE_ID=171530027864', 'LUCRECIA MARCELA TORRES',
  'movement_class=payment_in',
  '2026-08-01T09:48:49-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  696, 1054315166, 696,
  6958.00, 'income',
  'SOURCE_ID=171529981420', 'MARIANO FERRARI',
  'movement_class=payment_in',
  '2026-08-01T09:47:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  697, 1054315166, 697,
  9940.00, 'income',
  'SOURCE_ID=170633800601', 'GUILLERMO GIRONDE',
  'movement_class=payment_in',
  '2026-08-01T09:46:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  698, 1054315166, 698,
  9940.00, 'income',
  'SOURCE_ID=171529752206', 'Hoy_viedma',
  'movement_class=payment_in',
  '2026-08-01T09:43:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  699, 1054315166, 699,
  1988.00, 'income',
  'SOURCE_ID=171528779352', 'morena',
  'movement_class=payment_in',
  '2026-08-01T09:36:21-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  700, 1054315166, 700,
  6958.00, 'income',
  'SOURCE_ID=170632294003', 'Sebastian Fuse',
  'movement_class=payment_in',
  '2026-08-01T09:35:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  701, 1054315166, 701,
  13916.00, 'income',
  'SOURCE_ID=171528557474', 'BOUNTANG SICHANH',
  'movement_class=payment_in',
  '2026-08-01T09:34:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  702, 1054315166, 702,
  13916.00, 'income',
  'SOURCE_ID=171528091140', 'delvis Hecker',
  'movement_class=payment_in',
  '2026-08-01T09:29:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  703, 1054315166, 703,
  6958.00, 'income',
  'SOURCE_ID=171528089084', 'Claudio Carlos Parra',
  'movement_class=payment_in',
  '2026-08-01T09:29:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  704, 1054315166, 704,
  5467.00, 'transfer',
  'SOURCE_ID=171527014294', '',
  'movement_class=transfer_in',
  '2026-08-01T09:17:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  705, 1054315166, 705,
  13916.00, 'income',
  'SOURCE_ID=171526274954', 'MARIELA FERNANDA BARRIONUEVO',
  'movement_class=payment_in',
  '2026-08-01T09:11:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  706, 1054315166, 706,
  20874.00, 'income',
  'SOURCE_ID=170630194453', 'Adelicia',
  'movement_class=payment_in',
  '2026-08-01T09:11:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  707, 1054315166, 707,
  13916.00, 'income',
  'SOURCE_ID=170629441847', 'Julieta Racca',
  'movement_class=payment_in',
  '2026-08-01T09:06:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  708, 1054315166, 708,
  5467.00, 'income',
  'SOURCE_ID=170629483437', 'Liliana Recio',
  'movement_class=payment_in',
  '2026-08-01T09:06:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  709, 1054315166, 709,
  20874.00, 'income',
  'SOURCE_ID=171525734916', 'Ana',
  'movement_class=payment_in',
  '2026-08-01T09:05:04-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  710, 1054315166, 710,
  20874.00, 'transfer',
  'SOURCE_ID=170629540557', 'JULIO LEANDRO FERMANELLI',
  'movement_class=transfer_in',
  '2026-08-01T09:04:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  711, 1054315166, 711,
  13916.00, 'income',
  'SOURCE_ID=170627945629', 'NataliaD',
  'movement_class=payment_in',
  '2026-08-01T08:47:36-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  712, 1054315166, 712,
  6958.00, 'income',
  'SOURCE_ID=171523052598', 'PABLO SOLANO',
  'movement_class=payment_in',
  '2026-08-01T08:30:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  713, 1054315166, 713,
  6958.00, 'income',
  'SOURCE_ID=171522545644', 'ALDA CINTIA LUCRECIA VALLA',
  'movement_class=payment_in',
  '2026-08-01T08:26:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  714, 1054315166, 714,
  6958.00, 'transfer',
  'SOURCE_ID=171522466314', '',
  'movement_class=transfer_in',
  '2026-08-01T08:19:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  715, 1054315166, 715,
  13916.00, 'income',
  'SOURCE_ID=170626048471', 'FAUSTO RODRIGO CENTENO',
  'movement_class=payment_in',
  '2026-08-01T08:15:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  716, 1054315166, 716,
  8946.00, 'transfer',
  'SOURCE_ID=171518665014', '',
  'movement_class=transfer_in',
  '2026-08-01T07:10:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
