-- Delete old productos data
delete from productos;

-- Insert correct productos with right categories and units
insert into productos (nombre, categoria, precio_actual, unidad) values
  ('Huevo N1 - Grande', 'huevos', 4500, 'maple'),
  ('Huevo N2 - Mediano', 'huevos', 4200, 'maple'),
  ('Huevo N3 - Chico', 'huevos', 3900, 'maple'),
  ('Huevo Docena', 'huevos', 3600, 'docena'),
  ('Maíz', 'cereales', 0, 'kg'),
  ('Expeller de Soja', 'cereales', 0, 'kg'),
  ('Alimento Balanceado', 'alimento', 0, 'kg')
on conflict (nombre) do nothing;
