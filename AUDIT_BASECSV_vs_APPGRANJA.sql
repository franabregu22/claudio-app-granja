-- ============================================================================
-- AUDIT: BASECSV vs APPGRANJA - Junio 2026
-- PURPOSE: READ-ONLY comparison to classify movements
-- ============================================================================

-- PASO 1: Crear tabla temporal con datos de BASECSV (junio 2026)
-- Usuario: Copiar datos de junio desde BASECSV.csv y pegar aquí como VALUES
DROP TABLE IF EXISTS basecsv_june_temp CASCADE;

CREATE TEMP TABLE basecsv_june_temp (
  fecha_pago TIMESTAMP,
  tipo_operacion TEXT,
  numero_movimiento BIGINT,
  operacion_relacionada BIGINT,
  importe NUMERIC
);

-- El usuario debe copiar aquí los 1373 movimientos de junio en formato:
-- (timestamp, tipo, número, relacionada, importe)
-- POR AHORA: TABLA VACÍA (será poblada manualmente o via Python)

-- ============================================================================
-- PASO 2: Agrupar BASECSV en pares (Dinero + Impuesto)
-- ============================================================================

WITH basecsv_grouped AS (
  SELECT
    operacion_relacionada,
    MIN(fecha_pago) AS fecha,
    SUM(importe) AS importe_neto,
    STRING_AGG(DISTINCT tipo_operacion, ' + ' ORDER BY tipo_operacion) AS tipos,
    ARRAY_AGG(numero_movimiento ORDER BY numero_movimiento) AS numeros_movimiento,
    COUNT(*) AS movimientos_en_grupo
  FROM basecsv_june_temp
  GROUP BY operacion_relacionada
),

-- ============================================================================
-- PASO 3: Extraer movimientos de AppGranja (Liberaciones + Report)
-- ============================================================================

appgranja_movimientos AS (
  -- Liberaciones: cada fila es un potencial movimiento económico
  SELECT
    msr.source_type,
    msr.raw_data->>'SOURCE_ID' AS source_id,
    msr.raw_data->>'DATE' AS fecha_texto,
    (msr.raw_data->>'DATE')::TIMESTAMP AS fecha,
    msr.raw_data->>'DESCRIPTION' AS tipo,
    ((msr.raw_data->>'NET_CREDIT_AMOUNT')::NUMERIC - (msr.raw_data->>'NET_DEBIT_AMOUNT')::NUMERIC) AS importe,
    mfm.id AS fm_id,
    mfm.settlement_amount,
    le.id AS le_id,
    le.balance_impact
  FROM mp_source_record msr
  LEFT JOIN mp_movement_source_link msl ON msr.id = msl.source_record_id
  LEFT JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
  LEFT JOIN ledger_entry le ON mfm.id = le.financial_movement_id
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
  WHERE msr.source_type = 'liberaciones'
    AND DATE((msr.raw_data->>'DATE')::TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'

  UNION ALL

  -- Report: cada fila es un movimiento económico
  SELECT
    msr.source_type,
    msr.raw_data->>'SOURCE_ID' AS source_id,
    msr.raw_data->>'DATE' AS fecha_texto,
    (msr.raw_data->>'DATE')::TIMESTAMP AS fecha,
    msr.raw_data->>'TRANSACTION_TYPE' AS tipo,
    (msr.raw_data->>'SETTLEMENT_NET_AMOUNT')::NUMERIC AS importe,
    mfm.id AS fm_id,
    mfm.settlement_amount,
    le.id AS le_id,
    le.balance_impact
  FROM mp_source_record msr
  LEFT JOIN mp_movement_source_link msl ON msr.id = msl.source_record_id
  LEFT JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
  LEFT JOIN ledger_entry le ON mfm.id = le.financial_movement_id
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
  WHERE msr.source_type = 'report'
    AND DATE((msr.raw_data->>'DATE')::TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
),

-- ============================================================================
-- PASO 4: Buscar candidatos en AppGranja para cada movimiento de BASECSV
-- ============================================================================

cruce_inicial AS (
  SELECT
    bg.operacion_relacionada,
    bg.fecha,
    bg.importe_neto,
    bg.tipos,
    bg.numeros_movimiento,

    am.source_type,
    am.source_id,
    am.fm_id,
    am.importe,
    ABS(am.importe - bg.importe_neto) AS diferencia_importe,
    ABS(EXTRACT(EPOCH FROM (am.fecha - bg.fecha))) AS diferencia_segundos,

    COUNT(*) OVER (
      PARTITION BY bg.operacion_relacionada
    ) AS candidatos_totales,

    ROW_NUMBER() OVER (
      PARTITION BY bg.operacion_relacionada
      ORDER BY
        ABS(am.importe - bg.importe_neto) ASC,
        ABS(EXTRACT(EPOCH FROM (am.fecha - bg.fecha))) ASC
    ) AS candidato_rank

  FROM basecsv_grouped bg
  FULL OUTER JOIN appgranja_movimientos am ON (
    -- Estrategia 1: Por SOURCE_ID exacto (si existe)
    (bg.operacion_relacionada::TEXT = am.source_id)
    OR
    -- Estrategia 2: Por fecha + importe + tipo compatible (respaldo)
    (
      DATE(am.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') = DATE(bg.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')
      AND ABS(am.importe - bg.importe_neto) < 0.01
      AND am.source_type IS NOT NULL
    )
  )
)

-- ============================================================================
-- PASO 5: Clasificación final
-- ============================================================================

SELECT
  operacion_relacionada AS basecsv_id,
  fecha AS basecsv_fecha,
  importe_neto AS basecsv_importe,
  tipos AS basecsv_tipos,

  source_type AS appgranja_source,
  source_id AS appgranja_source_id,
  importe AS appgranja_importe,
  fm_id AS appgranja_fm_id,

  CASE
    WHEN fm_id IS NULL THEN 'FALTA_EN_APPGRANJA'
    WHEN candidatos_totales > 1 AND candidato_rank = 1 AND diferencia_importe > 0.01 THEN 'AMBIGUO'
    WHEN candidatos_totales > 1 AND candidato_rank > 1 THEN 'POSIBLE_DUPLICADO_EN_APPGRANJA'
    WHEN diferencia_importe > 0.01 THEN 'IMPORTE_DIFERENTE'
    WHEN diferencia_segundos < 60 THEN 'MATCH_EXACTO'
    WHEN diferencia_segundos < 3600 THEN 'MATCH_FECHA_COMPATIBLE'
    ELSE 'MATCH_CON_DISCREPANCIA'
  END AS clasificacion,

  diferencia_importe,
  diferencia_segundos,
  candidatos_totales

FROM cruce_inicial

ORDER BY
  CASE
    WHEN fm_id IS NULL THEN 0  -- Faltas primero
    WHEN candidatos_totales > 1 THEN 1  -- Ambigüos segundo
    WHEN diferencia_importe > 0.01 THEN 2  -- Importes diferentes
    ELSE 3  -- Matches últimos
  END,
  operacion_relacionada;
