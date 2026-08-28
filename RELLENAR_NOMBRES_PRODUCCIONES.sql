-- Rellenar nombres y apellidos de registros existentes
-- Cruza producciones.creado_por con perfiles.id

UPDATE producciones p
SET
  creado_por_primer_nombre = pf.primer_nombre,
  creado_por_apellido = pf.apellido
FROM perfiles pf
WHERE p.creado_por = pf.id
  AND (p.creado_por_primer_nombre IS NULL OR p.creado_por_apellido IS NULL);
