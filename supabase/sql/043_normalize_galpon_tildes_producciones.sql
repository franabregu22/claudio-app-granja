-- Normalizar TODOS los nombres de Galpón en la tabla producciones con tilde correcta

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

-- Verificar que quedó bien
-- SELECT DISTINCT galpon FROM producciones ORDER BY galpon;
