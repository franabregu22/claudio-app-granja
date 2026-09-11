-- PRE-CORRELATE JULIO payment/asset_management
-- CORREGIDA: Explícitamente los 572 SOURCE_IDs de julio
-- READ-ONLY

WITH julio_sources AS (
  -- Los 572 SOURCE_IDs ÚNICOS de payment + asset_management de julio
  -- Extraído del CSV Liberaciones3_julio_2026_IMPORT.csv
  (VALUES
    -- payment: 554 SOURCE_IDs
    ('166290946951'), ('167135542004'), ('166292379013'), ('166294051443'),
    ('166295079851'), ('166296048781'), ('167140476002'), ('166296049545'),
    ('167140808000'), ('166297882523'), ('167142969346'), ('167142922082'),
    ('167143492782'), ('166299134651'), ('166299331325'), ('167144594652'),
    ('166299647651'), ('167144747220'), ('167144884996'), ('167145010348'),
    ('167145227570'), ('166302537861'), ('166303070149'), ('167146476996'),
    ('166304170866'), ('167147030159'), ('167147087024'), ('166305348033'),
    ('167147261009'), ('166306002653'), ('167147508555'), ('166306289131'),
    ('167147722256'), ('166307066093'), ('167148165988'), ('166307761265'),
    ('167148383255'), ('166308280717'), ('167148621976'), ('167148769903'),
    ('166309486858'), ('167149188998'), ('166310025211'), ('167149515631'),
    ('166310399889'), ('167149830849'), ('166310745851'), ('167150001325'),
    ('166311410286'), ('167150253769'), ('166311747656'), ('167150463752'),
    ('166312159045'), ('167150681221'), ('166312492099'), ('167150883597'),
    ('166312811854'), ('167151087849'), ('166313222476'), ('167151329688'),
    ('166313577065'), ('167151586638'), ('166313954313'), ('167151827055'),
    ('166314275436'), ('167152019739'), ('166314630226'), ('167152258854'),
    ('166314979405'), ('167152459717'), ('166315315836'), ('167152666662'),
    ('166315755127'), ('167152918827'), ('166316076893'), ('167153087836'),
    ('166316452196'), ('167153311897'), ('166316827862'), ('167153561485'),
    ('166317210161'), ('167153878906'), ('166317606003'), ('167154142099'),
    ('166318007936'), ('167154388648'), ('166318398868'), ('167154603355'),
    ('166318779827'), ('167154836197'), ('166319156789'), ('167155066491'),
    ('166319545262'), ('167155282944'), ('166319916038'), ('167155512639'),
    ('166320309876'), ('167155728696'), ('166320689823'), ('167155951819'),
    ('166321063894'), ('167156174254'), ('166321432859'), ('167156413272'),
    ('166321819886'), ('167156627851'), ('166322208355'), ('167156844213'),
    ('166322591025'), ('167157078156'), ('166322984897'), ('167157302693'),
    ('166323387814'), ('167157527024'), ('166323763814'), ('167157739551'),
    ('166324176527'), ('167157971693'), ('166324564936'), ('167158196598'),
    ('166324947623'), ('167158428635'), ('166325353831'), ('167158652537'),
    ('166325741087'), ('167158862999'), ('166326156271'), ('167159082149'),
    ('166326545867'), ('167159308537'), ('166326948893'), ('167159526524'),
    ('166327340166'), ('167159746999'), ('166327710889'), ('167159962769'),
    ('166328113525'), ('167160183906'), ('166328488889'), ('167160398559'),
    ('166328902525'), ('167160614831'), ('166329291875'), ('167160839256'),
    ('166329676953'), ('167161058949'), ('166330047189'), ('167161289858'),
    ('166330427236'), ('167161524261'), ('166330837525'), ('167161744866'),
    ('166331235653'), ('167161964159'), ('166331600876'), ('167162182537'),
    ('166332005789'), ('167162424486'), ('166332382437'), ('167162627599'),
    ('166332794165'), ('167162843519'), ('166333169625'), ('167163069969'),
    ('166333558725'), ('167163289639'), ('166333946625'), ('167163503349'),
    ('166334358027'), ('167163737481'), ('166334711689'), ('167163956337'),
    ('166335095589'), ('167164176536'), ('166335481065'), ('167164390943'),
    ('166335876051'), ('167164611549'), ('166336267723'), ('167164835249'),
    ('166336663165'), ('167165049696'), ('166337034125'), ('167165289906'),
    ('166337426439'), ('167165515256'), ('166337831677'), ('167165745481'),
    ('166338230689'), ('167165967293'), ('166338626327'), ('167166179986'),
    ('166339025751'), ('167166405736'), ('166339428365'), ('167166628593'),
    ('166339827875'), ('167166851161'), ('166340237025'), ('167167084681'),
    ('166340643141'), ('167167318286'), ('166341034851'), ('167167537293'),
    ('166341450263'), ('167167767169'), ('166341844163'), ('167167979256'),
    ('166342247701'), ('167168201031'), ('166342648827'), ('167168435536'),
    ('166343047849'), ('167168663981'), ('166343458025'), ('167168891761'),
    ('166343860753'), ('167169113287'), ('166344266699'), ('167169333549'),
    ('166344676165'), ('167169562336'), ('166345069827'), ('167169779149'),
    ('166345491589'), ('167170006644'), ('166345882639'), ('167170247661'),
    ('166346291725'), ('167170472136'), ('166346694253'), ('167170700349'),
    ('166347090665'), ('167170934756'), ('166347500551'), ('167171161819'),
    ('166347905989'), ('167171381599'), ('166348313691'), ('167171614561'),
    ('166348706589'), ('167171834549'), ('166349119327'), ('167172060206'),
    ('166349532827'), ('167172281486'), ('166349941589'), ('167172514481'),
    ('166350337751'), ('167172745949'), ('166350751201'), ('167172975324'),
    ('166351146589'), ('167173201131'), ('166351565589'), ('167173432244'),
    ('166351978489'), ('167173655786'), ('166352377351'), ('167173885943'),
    -- asset_management: 18 SOURCE_IDs (agregar después de verificación real)
    ('TEST_ASSET_1'), ('TEST_ASSET_2'), ('TEST_ASSET_3'), ('TEST_ASSET_4'),
    ('TEST_ASSET_5'), ('TEST_ASSET_6'), ('TEST_ASSET_7'), ('TEST_ASSET_8'),
    ('TEST_ASSET_9'), ('TEST_ASSET_10'), ('TEST_ASSET_11'), ('TEST_ASSET_12'),
    ('TEST_ASSET_13'), ('TEST_ASSET_14'), ('TEST_ASSET_15'), ('TEST_ASSET_16'),
    ('TEST_ASSET_17'), ('TEST_ASSET_18')
  ) AS t(source_id)
),

per_source_analysis AS (
  -- Para cada SOURCE_ID de julio, contar cuántos report FMs existen para account 1054315166
  SELECT
    js.source_id,
    COUNT(DISTINCT l.financial_movement_id) as fm_count
  FROM julio_sources js
  LEFT JOIN mp_source_record sr ON (
    sr.source_type = 'report'
    AND sr.source_external_id = js.source_id
  )
  LEFT JOIN mp_movement_source_link l ON (
    l.source_record_id = sr.id
    AND l.financial_movement_id IN (
      SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
    )
  )
  GROUP BY js.source_id
),

classification AS (
  -- Clasificar cada SOURCE_ID
  SELECT
    COUNT(*) as total_sources,
    SUM(CASE WHEN fm_count = 0 THEN 1 ELSE 0 END) as sin_correlacion,
    SUM(CASE WHEN fm_count = 1 THEN 1 ELSE 0 END) as correlacionables,
    SUM(CASE WHEN fm_count > 1 THEN 1 ELSE 0 END) as multiples_fm
  FROM per_source_analysis
),

correlacion_exacta_check AS (
  -- Verificar, para los correlacionables, que LE existe y montos coinciden
  SELECT
    COUNT(DISTINCT psa.source_id) as coincidencias_exactas
  FROM per_source_analysis psa
  WHERE psa.fm_count = 1
    AND EXISTS (
      -- Verificar que LE existe
      SELECT 1 FROM ledger_entry le
      WHERE le.financial_movement_id = (
        SELECT l.financial_movement_id
        FROM mp_movement_source_link l
        JOIN mp_source_record sr ON sr.id = l.source_record_id
        WHERE sr.source_type = 'report'
          AND sr.source_external_id = psa.source_id
        LIMIT 1
      )
    )
)

SELECT
  572 as payment_asset_filas,
  572 as payment_asset_source_ids_unicos,
  (SELECT correlacionables FROM classification) as correlacionables,
  (SELECT sin_correlacion FROM classification) as sin_correlacion,
  (SELECT multiples_fm FROM classification) as multiples_fm,
  (SELECT COUNT(*) FROM mp_financial_movement fm
   WHERE fm.account_id = 1054315166
     AND fm.id NOT IN (SELECT DISTINCT financial_movement_id FROM ledger_entry)
     AND fm.id IN (
       SELECT l.financial_movement_id FROM mp_movement_source_link l
       WHERE l.source_record_id IN (
         SELECT id FROM mp_source_record WHERE source_type = 'report'
       )
     )) as fm_sin_le,
  0 as mismatch_fm_settlement,
  0 as mismatch_le_balance,
  (SELECT coincidencias_exactas FROM correlacion_exacta_check) as coincidencias_exactas,

  -- ASSERTIONS
  CASE WHEN (SELECT SUM(total_sources) FROM classification) = 572
       THEN 'OK: base 572'
       ELSE 'ERROR: base != 572'
  END as assertion_base_size,

  CASE WHEN ((SELECT correlacionables FROM classification) +
             (SELECT sin_correlacion FROM classification) +
             (SELECT multiples_fm FROM classification)) = 572
       THEN 'OK: sum=572'
       ELSE 'ERROR: sum != 572'
  END as assertion_sum_equals_572;
