-- Migración: Renombrar huevos_sanos a huevos_totales
-- Razón: Los campos contienen el TOTAL recolectado (buenos + rotos), no solo los buenos

ALTER TABLE produccion
RENAME COLUMN huevos_sanos_mediodia TO huevos_totales_mediodia;

ALTER TABLE produccion
RENAME COLUMN huevos_sanos_tarde TO huevos_totales_tarde;
