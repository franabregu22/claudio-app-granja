-- Agregar producto XL - Extra grande
insert into productos (nombre, categoria, precio_actual, unidad) values
  ('XL - Extra grande', 'huevos', 4800, 'maple')
on conflict (nombre) do nothing;
