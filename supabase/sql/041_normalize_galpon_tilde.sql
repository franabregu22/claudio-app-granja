-- Normalizar la columna 'galpon' en la tabla 'producciones'
-- Reemplazar todas las variantes sin tilde con "Galpón" correctamente escrito

UPDATE producciones
SET galpon = REPLACE(
  REPLACE(
    REPLACE(
      REPLACE(galpon, 'galpon', 'Galpón'),
      'Galpon', 'Galpón'
    ),
    'GALPON', 'Galpón'
  ),
  'GALPÓN', 'Galpón'
)
WHERE galpon ILIKE '%galpon%' OR galpon ILIKE '%GALPON%';

-- Verificar que todos los galpones están normalizados
-- SELECT DISTINCT galpon FROM producciones ORDER BY galpon;
