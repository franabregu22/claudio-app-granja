-- Agregar campos de nombre y apellido a tabla producciones
-- Esto es "denormalización": guardamos el nombre en el momento de crear el registro

ALTER TABLE producciones
ADD COLUMN creado_por_primer_nombre VARCHAR(255),
ADD COLUMN creado_por_apellido VARCHAR(255);

-- Si ya hay registros, rellenarlos con datos de perfiles (opcional)
-- UPDATE producciones p
-- SET creado_por_primer_nombre = pf.primer_nombre,
--     creado_por_apellido = pf.apellido
-- FROM perfiles pf
-- WHERE p.creado_por = pf.id;
