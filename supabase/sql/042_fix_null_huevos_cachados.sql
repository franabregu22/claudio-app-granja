-- Reemplazar NULL por 0 en huevos_cachados_mediodia
UPDATE producciones
SET huevos_cachados_mediodia = 0
WHERE huevos_cachados_mediodia IS NULL;

-- Reemplazar NULL por 0 en huevos_cachados_tarde
UPDATE producciones
SET huevos_cachados_tarde = 0
WHERE huevos_cachados_tarde IS NULL;

-- Reemplazar NULL por 0 en huevos_totales_mediodia (para consistencia)
UPDATE producciones
SET huevos_totales_mediodia = 0
WHERE huevos_totales_mediodia IS NULL;

-- Reemplazar NULL por 0 en huevos_totales_tarde (para consistencia)
UPDATE producciones
SET huevos_totales_tarde = 0
WHERE huevos_totales_tarde IS NULL;

-- Verificar que quedó bien
-- SELECT COUNT(*) as registros_null FROM producciones WHERE huevos_cachados_mediodia IS NULL OR huevos_cachados_tarde IS NULL;
