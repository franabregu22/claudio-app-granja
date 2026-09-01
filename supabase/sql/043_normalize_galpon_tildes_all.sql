-- Normalizar TODOS los nombres de Galpón en todas las tablas con tilde correcta

-- Tabla producciones
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

-- Tabla recuentos (si existe)
UPDATE recuentos
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
-- SELECT DISTINCT galpon FROM recuentos ORDER BY galpon;
