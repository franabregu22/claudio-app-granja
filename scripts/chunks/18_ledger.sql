SET CONSTRAINTS ALL DEFERRED;

INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  301, 1054315166, 301,
  6461.00, 'income',
  'SOURCE_ID=174158430257', 'GUILLERMO GIRONDE',
  'movement_class=payment_in',
  '2026-08-22T10:02:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  302, 1054315166, 302,
  11928.00, 'income',
  'SOURCE_ID=174157869765', 'Kurmi Arcoíris',
  'movement_class=payment_in',
  '2026-08-22T10:02:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  303, 1054315166, 303,
  7455.00, 'income',
  'SOURCE_ID=174158108933', 'Urano',
  'movement_class=payment_in',
  '2026-08-22T10:01:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  304, 1054315166, 304,
  5964.00, 'income',
  'SOURCE_ID=175093456260', 'Eliana Maribel Alvarez',
  'movement_class=payment_in',
  '2026-08-22T10:00:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  305, 1054315166, 305,
  7455.00, 'income',
  'SOURCE_ID=174158108441', 'Ramos',
  'movement_class=payment_in',
  '2026-08-22T09:59:59-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  306, 1054315166, 306,
  7455.00, 'income',
  'SOURCE_ID=175092883412', 'ANDY WILDER ORE ACUÑA',
  'movement_class=payment_in',
  '2026-08-22T09:59:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  307, 1054315166, 307,
  7455.00, 'income',
  'SOURCE_ID=174157581615', 'CHRISTIAN ALBERTO MURO',
  'movement_class=payment_in',
  '2026-08-22T09:59:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  308, 1054315166, 308,
  7455.00, 'income',
  'SOURCE_ID=175092896938', 'Pablo Montenegro',
  'movement_class=payment_in',
  '2026-08-22T09:58:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  309, 1054315166, 309,
  7455.00, 'income',
  'SOURCE_ID=174157687067', 'Jorge Farabello',
  'movement_class=payment_in',
  '2026-08-22T09:58:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  310, 1054315166, 310,
  7455.00, 'income',
  'SOURCE_ID=175092808852', 'Julio Nadal',
  'movement_class=payment_in',
  '2026-08-22T09:56:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  311, 1054315166, 311,
  29820.00, 'income',
  'SOURCE_ID=174156897871', 'Leonardo Namur',
  'movement_class=payment_in',
  '2026-08-22T09:54:06-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  312, 1054315166, 312,
  7455.00, 'transfer',
  'SOURCE_ID=174157124581', '',
  'movement_class=transfer_in',
  '2026-08-22T09:51:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  313, 1054315166, 313,
  6461.00, 'income',
  'SOURCE_ID=174156187641', 'MARIA BEATRIZ JACOBI',
  'movement_class=payment_in',
  '2026-08-22T09:47:13-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  314, 1054315166, 314,
  7455.00, 'income',
  'SOURCE_ID=175091984334', 'ADRIAN OLIVETTI',
  'movement_class=payment_in',
  '2026-08-22T09:47:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  315, 1054315166, 315,
  7455.00, 'income',
  'SOURCE_ID=174156634371', 'RENE EDUARDO TEUSCHER PALMA',
  'movement_class=payment_in',
  '2026-08-22T09:46:46-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  316, 1054315166, 316,
  12922.00, 'income',
  'SOURCE_ID=175091627238', 'Silvia Luciana León',
  'movement_class=payment_in',
  '2026-08-22T09:46:36-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  317, 1054315166, 317,
  12922.00, 'income',
  'SOURCE_ID=175091395582', 'Ana',
  'movement_class=payment_in',
  '2026-08-22T09:45:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  318, 1054315166, 318,
  7455.00, 'income',
  'SOURCE_ID=174156178557', 'romina ekerman',
  'movement_class=payment_in',
  '2026-08-22T09:43:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  319, 1054315166, 319,
  5964.00, 'income',
  'SOURCE_ID=174155808965', 'María Valeria Fernandez',
  'movement_class=payment_in',
  '2026-08-22T09:41:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  320, 1054315166, 320,
  12922.00, 'income',
  'SOURCE_ID=174155744951', 'ELIZABET IVANISKY',
  'movement_class=payment_in',
  '2026-08-22T09:40:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  321, 1054315166, 321,
  7455.00, 'income',
  'SOURCE_ID=175089831614', 'Agus Oliva Gardey',
  'movement_class=payment_in',
  '2026-08-22T09:32:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  322, 1054315166, 322,
  7455.00, 'income',
  'SOURCE_ID=174154788987', 'ROBERTO ADRIAN HAURE',
  'movement_class=payment_in',
  '2026-08-22T09:31:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  323, 1054315166, 323,
  14910.00, 'income',
  'SOURCE_ID=174153469665', 'LUCIANA GARCIA CABEZON',
  'movement_class=payment_in',
  '2026-08-22T09:21:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  324, 1054315166, 324,
  7455.00, 'income',
  'SOURCE_ID=175088653194', 'YAMILA VALERIA DIETZ',
  'movement_class=payment_in',
  '2026-08-22T09:19:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  325, 1054315166, 325,
  14910.00, 'income',
  'SOURCE_ID=175088341248', 'antoniavique',
  'movement_class=payment_in',
  '2026-08-22T09:16:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  326, 1054315166, 326,
  7455.00, 'income',
  'SOURCE_ID=175087877576', 'viedma temporarios',
  'movement_class=payment_in',
  '2026-08-22T09:13:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  327, 1054315166, 327,
  14910.00, 'income',
  'SOURCE_ID=174152509403', 'Jose Garcia Francisco Lago',
  'movement_class=payment_in',
  '2026-08-22T09:09:50-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  328, 1054315166, 328,
  5964.00, 'income',
  'SOURCE_ID=175086846086', 'Liliana Recio',
  'movement_class=payment_in',
  '2026-08-22T09:05:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  329, 1054315166, 329,
  7455.00, 'income',
  'SOURCE_ID=174152294561', 'Mario Block',
  'movement_class=payment_in',
  '2026-08-22T09:03:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  330, 1054315166, 330,
  7455.00, 'income',
  'SOURCE_ID=175087564190', 'DANIEL ENRIQUE TORRES',
  'movement_class=payment_in',
  '2026-08-22T09:02:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  331, 1054315166, 331,
  7455.00, 'income',
  'SOURCE_ID=175087200472', 'MARIELA FERNANDA BARRIONUEVO',
  'movement_class=payment_in',
  '2026-08-22T09:00:06-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  332, 1054315166, 332,
  7455.00, 'income',
  'SOURCE_ID=175087172184', 'Dinámica Kinesiologia',
  'movement_class=payment_in',
  '2026-08-22T08:57:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  333, 1054315166, 333,
  7455.00, 'income',
  'SOURCE_ID=174148748595', 'ALDA CINTIA LUCRECIA VALLA',
  'movement_class=payment_in',
  '2026-08-22T08:14:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  334, 1054315166, 334,
  7455.00, 'income',
  'SOURCE_ID=175019804124', 'Higiene y Control',
  'movement_class=payment_in',
  '2026-08-21T19:13:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  335, 1054315166, 335,
  -35210.00, 'expense',
  'SOURCE_ID=174014343167', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-21T12:34:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  336, 1054315166, 336,
  7455.00, 'transfer',
  'SOURCE_ID=174009558907', '',
  'movement_class=transfer_in',
  '2026-08-21T12:09:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  337, 1054315166, 337,
  7455.00, 'transfer',
  'SOURCE_ID=174931098910', 'Natalia Pastelería',
  'movement_class=transfer_in',
  '2026-08-21T10:59:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  338, 1054315166, 338,
  14910.00, 'income',
  'SOURCE_ID=173995598893', 'mauro canale',
  'movement_class=payment_in',
  '2026-08-21T10:50:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  339, 1054315166, 339,
  7455.00, 'transfer',
  'SOURCE_ID=174924053992', 'Lucrecia Guttmann',
  'movement_class=transfer_in',
  '2026-08-21T10:16:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  340, 1054315166, 340,
  786.42, 'interest_income',
  'SOURCE_ID=1748720696166', '',
  'movement_class=yield',
  '2026-08-21T03:23:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  341, 1054315166, 341,
  232596.00, 'income',
  'SOURCE_ID=173935201797', 'Mrpolloviedma1',
  'movement_class=payment_in',
  '2026-08-20T21:31:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  342, 1054315166, 342,
  -10060.00, 'expense',
  'SOURCE_ID=173902768861', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-20T18:33:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  343, 1054315166, 343,
  836.20, 'interest_income',
  'SOURCE_ID=1748645249288', '',
  'movement_class=yield',
  '2026-08-20T02:57:23-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  344, 1054315166, 344,
  7455.00, 'transfer',
  'SOURCE_ID=173735395979', 'natalia alcaraz',
  'movement_class=transfer_in',
  '2026-08-19T18:36:22-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  345, 1054315166, 345,
  -44264.00, 'expense',
  'SOURCE_ID=174664961876', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-19T18:26:14-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  346, 1054315166, 346,
  994.00, 'income',
  'SOURCE_ID=173711240843', 'colibri',
  'movement_class=payment_in',
  '2026-08-19T16:12:04-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  347, 1054315166, 347,
  13916.00, 'income',
  'SOURCE_ID=174639518202', 'colibri',
  'movement_class=payment_in',
  '2026-08-19T15:47:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  348, 1054315166, 348,
  -116697.01, 'expense',
  'SOURCE_ID=173637079859', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-19T07:56:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  349, 1054315166, 349,
  809.04, 'interest_income',
  'SOURCE_ID=1748579043436', '',
  'movement_class=yield',
  '2026-08-19T03:46:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  350, 1054315166, 350,
  38766.00, 'income',
  'SOURCE_ID=174529363962', 'sebastian montero de espinosa',
  'movement_class=payment_in',
  '2026-08-18T21:07:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  351, 1054315166, 351,
  38766.00, 'transfer',
  'SOURCE_ID=174525786312', '',
  'movement_class=transfer_in',
  '2026-08-18T20:38:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  352, 1054315166, 352,
  27832.00, 'income',
  'SOURCE_ID=174460656952', 'El chico del pórtico',
  'movement_class=payment_in',
  '2026-08-18T14:14:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  353, 1054315166, 353,
  -60360.00, 'expense',
  'SOURCE_ID=174455781804', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-18T13:46:41-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  354, 1054315166, 354,
  6972.47, 'interest_income',
  'SOURCE_ID=1748508374873', '',
  'movement_class=yield',
  '2026-08-18T04:39:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  355, 1054315166, 355,
  232596.00, 'income',
  'SOURCE_ID=174368040694', 'Mrpolloviedma1',
  'movement_class=payment_in',
  '2026-08-17T21:44:34-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  356, 1054315166, 356,
  -45290.12, 'expense',
  'SOURCE_ID=174273731418', 'GRANJA SANTO TOMAS S. A. S.',
  'movement_class=payment_out',
  '2026-08-17T11:41:40-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  357, 1054315166, 357,
  7455.00, 'income',
  'SOURCE_ID=173163927865', 'Higiene y Control',
  'movement_class=payment_in',
  '2026-08-15T22:57:47-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  358, 1054315166, 358,
  193830.00, 'transfer',
  'SOURCE_ID=174046317446', '',
  'movement_class=transfer_in',
  '2026-08-15T18:28:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  359, 1054315166, 359,
  377720.00, 'income',
  'SOURCE_ID=173071750587', 'marcial',
  'movement_class=payment_in',
  '2026-08-15T13:23:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  360, 1054315166, 360,
  155064.00, 'income',
  'SOURCE_ID=173995299362', 'Puesto 92',
  'movement_class=payment_in',
  '2026-08-15T13:12:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  361, 1054315166, 361,
  7455.00, 'income',
  'SOURCE_ID=173986600840', 'JORGE RUBEN JUAREZ',
  'movement_class=payment_in',
  '2026-08-15T12:24:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  362, 1054315166, 362,
  7455.00, 'income',
  'SOURCE_ID=173986554330', 'Hector Muñoz',
  'movement_class=payment_in',
  '2026-08-15T12:23:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  363, 1054315166, 363,
  7455.00, 'income',
  'SOURCE_ID=173059948459', 'SOLEDAD MARGOT CECCHINI',
  'movement_class=payment_in',
  '2026-08-15T12:20:47-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  364, 1054315166, 364,
  7455.00, 'income',
  'SOURCE_ID=173059527793', 'Farmacia Krenz',
  'movement_class=payment_in',
  '2026-08-15T12:19:59-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  365, 1054315166, 365,
  7455.00, 'income',
  'SOURCE_ID=173059647007', 'GUSTAVO GABRIEL CORNEJO',
  'movement_class=payment_in',
  '2026-08-15T12:19:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  366, 1054315166, 366,
  14910.00, 'income',
  'SOURCE_ID=173985107064', 'MIRTA MABEL MELLADO',
  'movement_class=payment_in',
  '2026-08-15T12:18:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  367, 1054315166, 367,
  7455.00, 'income',
  'SOURCE_ID=173985104824', 'Europie',
  'movement_class=payment_in',
  '2026-08-15T12:17:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  368, 1054315166, 368,
  3479.00, 'income',
  'SOURCE_ID=173058950663', 'ALEJANDRO PEDRO MONGABURE',
  'movement_class=payment_in',
  '2026-08-15T12:15:07-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  369, 1054315166, 369,
  7455.00, 'income',
  'SOURCE_ID=173984584160', 'Establecimiento La Victoria',
  'movement_class=payment_in',
  '2026-08-15T12:14:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  370, 1054315166, 370,
  7455.00, 'income',
  'SOURCE_ID=173983493326', 'Federada viedma',
  'movement_class=payment_in',
  '2026-08-15T12:10:21-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  371, 1054315166, 371,
  14910.00, 'transfer',
  'SOURCE_ID=173057257939', 'Miguel',
  'movement_class=transfer_in',
  '2026-08-15T12:08:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  372, 1054315166, 372,
  7455.00, 'income',
  'SOURCE_ID=173982907544', 'MONICA SUSANA ROTONDO',
  'movement_class=payment_in',
  '2026-08-15T12:07:08-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  373, 1054315166, 373,
  3479.00, 'income',
  'SOURCE_ID=173983022664', 'Sergio Vechiati',
  'movement_class=payment_in',
  '2026-08-15T12:06:19-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  374, 1054315166, 374,
  7455.00, 'income',
  'SOURCE_ID=173982347314', 'NICOLÁS ANDRÉS FRATTINI',
  'movement_class=payment_in',
  '2026-08-15T12:03:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  375, 1054315166, 375,
  5964.00, 'income',
  'SOURCE_ID=173982522814', 'NORMA MONICA AMADIO',
  'movement_class=payment_in',
  '2026-08-15T12:03:43-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  376, 1054315166, 376,
  13916.00, 'income',
  'SOURCE_ID=173056460905', 'guillermo',
  'movement_class=payment_in',
  '2026-08-15T12:03:36-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  377, 1054315166, 377,
  14910.00, 'income',
  'SOURCE_ID=173056046659', 'Debora Vanesa Moreno',
  'movement_class=payment_in',
  '2026-08-15T12:00:49-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  378, 1054315166, 378,
  5964.00, 'transfer',
  'SOURCE_ID=173981329904', 'MARIA ALEJANDRA CASTRILLO',
  'movement_class=transfer_in',
  '2026-08-15T11:58:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  379, 1054315166, 379,
  11928.00, 'transfer',
  'SOURCE_ID=173055377389', '',
  'movement_class=transfer_in',
  '2026-08-15T11:57:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  380, 1054315166, 380,
  7455.00, 'income',
  'SOURCE_ID=173055155533', 'VILMA ESTHER CASTILLO',
  'movement_class=payment_in',
  '2026-08-15T11:56:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  381, 1054315166, 381,
  14910.00, 'income',
  'SOURCE_ID=173054761489', 'Marco',
  'movement_class=payment_in',
  '2026-08-15T11:54:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  382, 1054315166, 382,
  7455.00, 'income',
  'SOURCE_ID=173979646828', 'SERGIO DANIEL HENRIQUEZ',
  'movement_class=payment_in',
  '2026-08-15T11:49:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  383, 1054315166, 383,
  7455.00, 'transfer',
  'SOURCE_ID=173053359237', 'PAULA SARRAMONE',
  'movement_class=transfer_in',
  '2026-08-15T11:46:22-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  384, 1054315166, 384,
  7455.00, 'income',
  'SOURCE_ID=173978493216', 'Planeta equipamientos ',
  'movement_class=payment_in',
  '2026-08-15T11:42:57-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  385, 1054315166, 385,
  13419.00, 'income',
  'SOURCE_ID=173052003629', 'Angie Pich',
  'movement_class=payment_in',
  '2026-08-15T11:40:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  386, 1054315166, 386,
  14910.00, 'income',
  'SOURCE_ID=173051885463', 'Fabiana Arias Valla',
  'movement_class=payment_in',
  '2026-08-15T11:38:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  387, 1054315166, 387,
  7455.00, 'income',
  'SOURCE_ID=173051674021', 'Beja productos de la colmena',
  'movement_class=payment_in',
  '2026-08-15T11:38:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  388, 1054315166, 388,
  7455.00, 'income',
  'SOURCE_ID=173977746798', 'mirta cayutur',
  'movement_class=payment_in',
  '2026-08-15T11:37:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  389, 1054315166, 389,
  7455.00, 'income',
  'SOURCE_ID=173051658759', 'seba rost',
  'movement_class=payment_in',
  '2026-08-15T11:36:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  390, 1054315166, 390,
  7455.00, 'income',
  'SOURCE_ID=173051442921', 'Liliana Esther Moron',
  'movement_class=payment_in',
  '2026-08-15T11:35:06-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  391, 1054315166, 391,
  7455.00, 'transfer',
  'SOURCE_ID=173051221209', 'MIRIAM GRACIELA BARILA',
  'movement_class=transfer_in',
  '2026-08-15T11:34:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  392, 1054315166, 392,
  7455.00, 'income',
  'SOURCE_ID=173051122927', 'bucci',
  'movement_class=payment_in',
  '2026-08-15T11:33:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  393, 1054315166, 393,
  7455.00, 'income',
  'SOURCE_ID=173050538177', 'Vicente ',
  'movement_class=payment_in',
  '2026-08-15T11:27:49-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  394, 1054315166, 394,
  19383.00, 'income',
  'SOURCE_ID=173049473413', 'HECTOR CROCIATI',
  'movement_class=payment_in',
  '2026-08-15T11:24:27-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  395, 1054315166, 395,
  29820.00, 'transfer',
  'SOURCE_ID=173975097468', 'La Reina del Sur Miel',
  'movement_class=transfer_in',
  '2026-08-15T11:23:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  396, 1054315166, 396,
  22365.00, 'income',
  'SOURCE_ID=173974705698', 'Jose Garcia Francisco Lago',
  'movement_class=payment_in',
  '2026-08-15T11:22:20-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  397, 1054315166, 397,
  14910.00, 'income',
  'SOURCE_ID=173974694188', 'N LIDA RAQUEL FLORES',
  'movement_class=payment_in',
  '2026-08-15T11:19:10-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  398, 1054315166, 398,
  14910.00, 'income',
  'SOURCE_ID=173048425607', 'FACUNDO MARTIN SIGILLI',
  'movement_class=payment_in',
  '2026-08-15T11:18:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  399, 1054315166, 399,
  7455.00, 'income',
  'SOURCE_ID=173974370690', 'la autentica',
  'movement_class=payment_in',
  '2026-08-15T11:17:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  400, 1054315166, 400,
  14910.00, 'income',
  'SOURCE_ID=173973465804', 'paola marcel',
  'movement_class=payment_in',
  '2026-08-15T11:14:58-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  401, 1054315166, 401,
  7455.00, 'income',
  'SOURCE_ID=173973224678', 'Sergio Caballieri',
  'movement_class=payment_in',
  '2026-08-15T11:11:29-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  402, 1054315166, 402,
  7455.00, 'income',
  'SOURCE_ID=173973200694', 'cristian martin',
  'movement_class=payment_in',
  '2026-08-15T11:11:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  403, 1054315166, 403,
  7455.00, 'income',
  'SOURCE_ID=173047472397', 'STELLA MARIS RUGGERI',
  'movement_class=payment_in',
  '2026-08-15T11:10:24-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  404, 1054315166, 404,
  14910.00, 'income',
  'SOURCE_ID=173047033401', 'ADRIAN FARID CHEBEIR',
  'movement_class=payment_in',
  '2026-08-15T11:09:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  405, 1054315166, 405,
  7455.00, 'income',
  'SOURCE_ID=173972445504', 'Laura Haydée Segovia',
  'movement_class=payment_in',
  '2026-08-15T11:09:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  406, 1054315166, 406,
  14910.00, 'transfer',
  'SOURCE_ID=173971823050', '',
  'movement_class=transfer_in',
  '2026-08-15T11:03:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  407, 1054315166, 407,
  11928.00, 'income',
  'SOURCE_ID=173971629502', 'Kurmi Arcoíris',
  'movement_class=payment_in',
  '2026-08-15T11:03:31-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  408, 1054315166, 408,
  3479.00, 'income',
  'SOURCE_ID=173045389769', 'Juan Ignacio Llambi',
  'movement_class=payment_in',
  '2026-08-15T11:01:11-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  409, 1054315166, 409,
  14910.00, 'transfer',
  'SOURCE_ID=173971518612', 'los 25 de la 51',
  'movement_class=transfer_in',
  '2026-08-15T11:00:52-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  410, 1054315166, 410,
  7455.00, 'income',
  'SOURCE_ID=173045435115', 'ROCIO MARIANELLA MATEOS',
  'movement_class=payment_in',
  '2026-08-15T11:00:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  411, 1054315166, 411,
  11928.00, 'income',
  'SOURCE_ID=173044423291', 'María Belén Fernández',
  'movement_class=payment_in',
  '2026-08-15T10:52:48-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  412, 1054315166, 412,
  7455.00, 'income',
  'SOURCE_ID=173044095281', 'Maria Cevoli',
  'movement_class=payment_in',
  '2026-08-15T10:50:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  413, 1054315166, 413,
  14910.00, 'income',
  'SOURCE_ID=173042911071', 'PABLO VERA',
  'movement_class=payment_in',
  '2026-08-15T10:42:25-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  414, 1054315166, 414,
  7455.00, 'income',
  'SOURCE_ID=173042241957', 'Hilda Maria Huentelaf',
  'movement_class=payment_in',
  '2026-08-15T10:40:44-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  415, 1054315166, 415,
  7455.00, 'income',
  'SOURCE_ID=173042123301', 'iris mendoza',
  'movement_class=payment_in',
  '2026-08-15T10:37:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  416, 1054315166, 416,
  7455.00, 'income',
  'SOURCE_ID=173042122905', 'Justo Daniel Cuello',
  'movement_class=payment_in',
  '2026-08-15T10:36:55-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  417, 1054315166, 417,
  14910.00, 'income',
  'SOURCE_ID=173042200573', 'VANESA NOEMI MIRTA FLORES',
  'movement_class=payment_in',
  '2026-08-15T10:36:49-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  418, 1054315166, 418,
  13419.00, 'transfer',
  'SOURCE_ID=173966745874', '',
  'movement_class=transfer_in',
  '2026-08-15T10:32:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  419, 1054315166, 419,
  7455.00, 'income',
  'SOURCE_ID=173041269513', 'Miryam Raquel Molina',
  'movement_class=payment_in',
  '2026-08-15T10:31:52-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  420, 1054315166, 420,
  11928.00, 'income',
  'SOURCE_ID=173040913609', 'alejandro coleffi',
  'movement_class=payment_in',
  '2026-08-15T10:29:32-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  421, 1054315166, 421,
  22365.00, 'income',
  'SOURCE_ID=173965687774', 'MARIA ROSA BARBARA',
  'movement_class=payment_in',
  '2026-08-15T10:24:33-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  422, 1054315166, 422,
  7455.00, 'income',
  'SOURCE_ID=173965629474', 'Lorenzo Mora',
  'movement_class=payment_in',
  '2026-08-15T10:23:10-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  423, 1054315166, 423,
  5964.00, 'income',
  'SOURCE_ID=173965765028', 'MARIO DANIEL LORCA',
  'movement_class=payment_in',
  '2026-08-15T10:22:54-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  424, 1054315166, 424,
  7455.00, 'income',
  'SOURCE_ID=173965215124', 'Ana Buzzeo',
  'movement_class=payment_in',
  '2026-08-15T10:18:51-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  425, 1054315166, 425,
  5964.00, 'transfer',
  'SOURCE_ID=173964743136', '',
  'movement_class=transfer_in',
  '2026-08-15T10:15:16-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  426, 1054315166, 426,
  13419.00, 'transfer',
  'SOURCE_ID=173038869759', '',
  'movement_class=transfer_in',
  '2026-08-15T10:14:45-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  427, 1054315166, 427,
  5964.00, 'income',
  'SOURCE_ID=173964413596', 'Gladys Beatriz Yanisky',
  'movement_class=payment_in',
  '2026-08-15T10:14:02-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  428, 1054315166, 428,
  7455.00, 'income',
  'SOURCE_ID=173038828947', 'Carlos10',
  'movement_class=payment_in',
  '2026-08-15T10:11:56-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  429, 1054315166, 429,
  7455.00, 'income',
  'SOURCE_ID=173038691077', 'Mirian Gladys Guerrero',
  'movement_class=payment_in',
  '2026-08-15T10:11:29-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  430, 1054315166, 430,
  7455.00, 'income',
  'SOURCE_ID=173963473762', 'La lita',
  'movement_class=payment_in',
  '2026-08-15T10:08:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  431, 1054315166, 431,
  5964.00, 'income',
  'SOURCE_ID=173963930218', 'Federico Tonini',
  'movement_class=payment_in',
  '2026-08-15T10:07:04-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  432, 1054315166, 432,
  11928.00, 'transfer',
  'SOURCE_ID=173963175856', '',
  'movement_class=transfer_in',
  '2026-08-15T10:06:18-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  433, 1054315166, 433,
  7455.00, 'transfer',
  'SOURCE_ID=173037854759', '',
  'movement_class=transfer_in',
  '2026-08-15T10:03:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  434, 1054315166, 434,
  7455.00, 'income',
  'SOURCE_ID=173962971452', 'HORACIO VIDAL FLORES',
  'movement_class=payment_in',
  '2026-08-15T10:02:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  435, 1054315166, 435,
  7455.00, 'income',
  'SOURCE_ID=173037812201', 'EDUARDO ALFREDO MOSER',
  'movement_class=payment_in',
  '2026-08-15T10:01:26-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  436, 1054315166, 436,
  14910.00, 'transfer',
  'SOURCE_ID=173963044564', 'Angelica Romani',
  'movement_class=transfer_in',
  '2026-08-15T10:00:53-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  437, 1054315166, 437,
  7455.00, 'income',
  'SOURCE_ID=173036871597', 'fernanda gorriti',
  'movement_class=payment_in',
  '2026-08-15T09:59:35-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  438, 1054315166, 438,
  11928.00, 'income',
  'SOURCE_ID=173962654588', 'Mnd',
  'movement_class=payment_in',
  '2026-08-15T09:57:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  439, 1054315166, 439,
  7455.00, 'income',
  'SOURCE_ID=173036752823', 'YAMILA VALERIA DIETZ',
  'movement_class=payment_in',
  '2026-08-15T09:56:12-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  440, 1054315166, 440,
  7455.00, 'income',
  'SOURCE_ID=173961925762', 'LUCRECIA MARCELA TORRES',
  'movement_class=payment_in',
  '2026-08-15T09:54:31-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  441, 1054315166, 441,
  5964.00, 'income',
  'SOURCE_ID=173036013965', 'GABRIELA CALVO',
  'movement_class=payment_in',
  '2026-08-15T09:52:42-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  442, 1054315166, 442,
  5964.00, 'income',
  'SOURCE_ID=173961354970', 'SUSANA ANGELICA ELGUETA',
  'movement_class=payment_in',
  '2026-08-15T09:48:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  443, 1054315166, 443,
  7455.00, 'income',
  'SOURCE_ID=173035802299', 'monica werner',
  'movement_class=payment_in',
  '2026-08-15T09:44:21-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  444, 1054315166, 444,
  7455.00, 'income',
  'SOURCE_ID=173960625118', 'Hugo Alberto Cévoli',
  'movement_class=payment_in',
  '2026-08-15T09:42:38-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  445, 1054315166, 445,
  7455.00, 'income',
  'SOURCE_ID=173960287136', 'FAUSTO RODRIGO CENTENO',
  'movement_class=payment_in',
  '2026-08-15T09:39:03-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  446, 1054315166, 446,
  7455.00, 'income',
  'SOURCE_ID=173960038244', 'Julieta Racca',
  'movement_class=payment_in',
  '2026-08-15T09:33:17-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  447, 1054315166, 447,
  22365.00, 'transfer',
  'SOURCE_ID=173959173526', 'JULIO LEANDRO FERMANELLI',
  'movement_class=transfer_in',
  '2026-08-15T09:30:30-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  448, 1054315166, 448,
  17892.00, 'income',
  'SOURCE_ID=173959208190', 'delvis Hecker',
  'movement_class=payment_in',
  '2026-08-15T09:25:15-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  449, 1054315166, 449,
  7455.00, 'transfer',
  'SOURCE_ID=173958299452', '',
  'movement_class=transfer_in',
  '2026-08-15T09:23:09-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
INSERT INTO ledger_entry (
  id, account_id, financial_movement_id,
  balance_impact, category,
  source_reference, description, observation,
  occurred_at
) VALUES (
  450, 1054315166, 450,
  14910.00, 'income',
  'SOURCE_ID=173958241382', 'Libreria Estudiando',
  'movement_class=payment_in',
  '2026-08-15T09:22:01-03:00'::timestamp with time zone
) ON CONFLICT DO NOTHING;
