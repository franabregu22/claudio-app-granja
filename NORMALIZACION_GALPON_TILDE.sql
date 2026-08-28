-- Normalización: cambiar "Galpon" por "Galpón" (con tilde)
-- Ejecutar en Supabase SQL Editor

UPDATE producciones
SET galpon = REPLACE(galpon, 'Galpon', 'Galpón')
WHERE galpon LIKE 'Galpon%';

UPDATE lotes
SET galpon = REPLACE(galpon, 'Galpon', 'Galpón')
WHERE galpon LIKE 'Galpon%';
