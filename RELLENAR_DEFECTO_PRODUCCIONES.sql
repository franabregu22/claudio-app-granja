-- Rellenar los registros que aún tienen NULL con nombre por defecto
-- Esto sirve para registros viejos sin auditoría de quién los creó

UPDATE producciones
SET
  creado_por_primer_nombre = 'Andrés',
  creado_por_apellido = 'Aragón'
WHERE creado_por_primer_nombre IS NULL
  OR creado_por_apellido IS NULL;
