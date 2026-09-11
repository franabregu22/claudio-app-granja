-- ============================================================================
-- ROLLBACK: Auto-generado de liberaciones_import_result.json
-- Generado: 2026-09-05T14:30:00.000000
-- Batch 1/8
-- Records procesados: 100
-- Orden FK: LE -> LINK -> FM -> SR
-- ============================================================================

DO $$
DECLARE
  v_created_sr_ids BIGINT[] := ARRAY[1001,1002,1003,1004,1005,1006,1007,1008,1009,1010,1011,1012,1013,1014,1015,1016,1017,1018,1019,1020,1021,1022,1023,1024,1025,1026,1027,1028,1029,1030,1031,1032,1033,1034,1035,1036,1037,1038,1039,1040,1041,1042,1043,1044,1045,1046,1047,1048,1049,1050,1051,1052,1053,1054,1055,1056,1057,1058,1059,1060,1061,1062,1063,1064,1065,1066,1067,1068,1069,1070,1071,1072,1073,1074,1075,1076,1077,1078,1079,1080,1081,1082,1083,1084,1085,1086,1087,1088,1089,1090,1091,1092,1093,1094,1095]::BIGINT[];
  v_created_fm_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_le_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_link_ids BIGINT[] := ARRAY[5001,5002,5003,5004,5005,5006,5007,5008,5009,5010,5011,5012,5013,5014,5015,5016,5017,5018,5019,5020,5021,5022,5023,5024,5025,5026,5027,5028,5029,5030,5031,5032,5033,5034,5035,5036,5037,5038,5039,5040,5041,5042,5043,5044,5045]::BIGINT[];
BEGIN
  DELETE FROM ledger_entry WHERE id = ANY(v_created_le_ids);
  RAISE NOTICE 'Deleted % LE', array_length(v_created_le_ids, 1);

  DELETE FROM mp_movement_source_link WHERE id = ANY(v_created_link_ids);
  RAISE NOTICE 'Deleted % LINK', array_length(v_created_link_ids, 1);

  DELETE FROM mp_financial_movement WHERE id = ANY(v_created_fm_ids);
  RAISE NOTICE 'Deleted % FM', array_length(v_created_fm_ids, 1);

  DELETE FROM mp_source_record WHERE id = ANY(v_created_sr_ids);
  RAISE NOTICE 'Deleted % SR', array_length(v_created_sr_ids, 1);
END $$;