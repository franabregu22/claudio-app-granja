-- ============================================================================
-- AUDIT: BASECSV vs APPGRANJA - Junio 2026
-- SINGLE EXECUTION: Crea TEMP TABLE, carga datos, ejecuta auditoría
-- READ-ONLY: No modifica tablas persistentes de AppGranja
-- ============================================================================

-- PASO 1: Crear tabla temporal
DROP TABLE IF EXISTS basecsv_june_temp CASCADE;

CREATE TEMP TABLE basecsv_june_temp (
  fecha_pago TIMESTAMP,
  tipo_operacion TEXT,
  numero_movimiento BIGINT,
  operacion_relacionada BIGINT,
  importe NUMERIC
);

-- PASO 2: Cargar 1373 movimientos de junio (INSERT HERE - ver INSERT_BASECSV_JUNE.sql)
-- [INSERT AQUÍ: reemplazar con contenido de INSERT_BASECSV_JUNE.sql]

-- PASO 3: Auditoría - Mantener Número de Movimiento como identidad única
WITH appgranja_movimientos AS (
  -- Liberaciones: cada fila es un movimiento económico potencial
  SELECT
    'liberaciones'::TEXT AS source_type,
    msr.raw_data->>'SOURCE_ID' AS source_id,
    (msr.raw_data->>'DATE')::TIMESTAMP AS fecha,
    msr.raw_data->>'DESCRIPTION' AS tipo,
    ((msr.raw_data->>'NET_CREDIT_AMOUNT')::NUMERIC - (msr.raw_data->>'NET_DEBIT_AMOUNT')::NUMERIC) AS importe,
    mfm.id AS fm_id,
    mfm.settlement_amount,
    msr.id AS sr_id
  FROM mp_source_record msr
  LEFT JOIN mp_movement_source_link msl ON msr.id = msl.source_record_id
  LEFT JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
  WHERE msr.source_type = 'liberaciones'
    AND DATE((msr.raw_data->>'DATE')::TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'

  UNION ALL

  -- Report: cada fila es un movimiento económico
  SELECT
    'report'::TEXT AS source_type,
    msr.raw_data->>'SOURCE_ID' AS source_id,
    (msr.raw_data->>'DATE')::TIMESTAMP AS fecha,
    msr.raw_data->>'TRANSACTION_TYPE' AS tipo,
    (msr.raw_data->>'SETTLEMENT_NET_AMOUNT')::NUMERIC AS importe,
    mfm.id AS fm_id,
    mfm.settlement_amount,
    msr.id AS sr_id
  FROM mp_source_record msr
  LEFT JOIN mp_movement_source_link msl ON msr.id = msl.source_record_id
  LEFT JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
  WHERE msr.source_type = 'report'
    AND DATE((msr.raw_data->>'DATE')::TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
),

-- Buscar candidatos en AppGranja para cada movimiento de BASECSV
-- SIN AGRUPAR: mantener Número de Movimiento como identidad
cruce_inicial AS (
  SELECT
    bj.numero_movimiento,
    bj.operacion_relacionada,
    bj.fecha_pago,
    bj.tipo_operacion,
    bj.importe,

    am.source_type,
    am.source_id,
    am.fm_id,
    am.importe AS importe_appgranja,
    ABS(am.importe - bj.importe) AS diferencia_importe,
    ABS(EXTRACT(EPOCH FROM (am.fecha - bj.fecha_pago))) AS diferencia_segundos,

    COUNT(*) OVER (
      PARTITION BY bj.numero_movimiento
    ) AS candidatos_totales,

    ROW_NUMBER() OVER (
      PARTITION BY bj.numero_movimiento
      ORDER BY
        ABS(am.importe - bj.importe) ASC,
        ABS(EXTRACT(EPOCH FROM (am.fecha - bj.fecha_pago))) ASC
    ) AS candidato_rank

  FROM basecsv_june_temp bj
  FULL OUTER JOIN appgranja_movimientos am ON (
    -- Estrategia 1: Por SOURCE_ID exacto (Operación Relacionada = SOURCE_ID)
    (bj.operacion_relacionada::TEXT = am.source_id)
    OR
    -- Estrategia 2: Por fecha exacta + importe exacto (respaldo)
    (
      DATE(am.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') = DATE(bj.fecha_pago AT TIME ZONE 'America/Argentina/Buenos_Aires')
      AND ABS(am.importe - bj.importe) < 0.01
      AND am.source_type IS NOT NULL
    )
  )
)

SELECT
  numero_movimiento AS basecsv_numero_movimiento,
  operacion_relacionada AS basecsv_operacion_relacionada,
  fecha_pago AS basecsv_fecha,
  tipo_operacion AS basecsv_tipo,
  importe AS basecsv_importe,

  source_type AS appgranja_source_type,
  source_id AS appgranja_source_id,
  importe_appgranja AS appgranja_importe,
  fm_id AS appgranja_fm_id,

  CASE
    WHEN fm_id IS NULL THEN 'FALTA_EN_APPGRANJA'
    WHEN candidatos_totales > 1 AND candidato_rank > 1 THEN 'POSIBLE_DUPLICADO_EN_APPGRANJA'
    WHEN candidatos_totales > 1 AND candidato_rank = 1 AND diferencia_importe > 0.01 THEN 'AMBIGUO'
    WHEN diferencia_importe > 0.01 THEN 'IMPORTE_DIFERENTE'
    WHEN diferencia_segundos < 1 THEN 'MATCH_EXACTO'
    WHEN diferencia_segundos < 60 THEN 'MATCH_SEGUNDOS_CERCANOS'
    WHEN diferencia_segundos < 3600 THEN 'MATCH_HORA_COMPATIBLE'
    ELSE 'MATCH_CON_DISCREPANCIA_TEMPORAL'
  END AS clasificacion,

  diferencia_importe,
  ROUND(diferencia_segundos::NUMERIC, 0)::BIGINT AS diferencia_segundos,
  candidatos_totales

FROM cruce_inicial

ORDER BY
  CASE
    WHEN fm_id IS NULL THEN 0  -- FALTA_EN_APPGRANJA primero
    WHEN candidatos_totales > 1 THEN 1  -- DUPLICADOS segundo
    WHEN diferencia_importe > 0.01 THEN 2  -- IMPORTE_DIFERENTE tercero
    ELSE 3  -- MATCHES últimos
  END,
  numero_movimiento ASC;
