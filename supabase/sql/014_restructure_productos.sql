-- Drop and recreate productos cleanly
drop table if exists productos cascade;

create table productos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  categoria text not null,
  precio_actual numeric(10,2) not null default 0,
  unidad text not null,
  activo boolean default true,
  creado_por uuid references perfiles(id),
  creado_en timestamptz default now(),
  actualizado_en timestamptz default now()
);

-- Add indexes
create index idx_productos_categoria on productos(categoria);
create index idx_productos_activo on productos(activo);

-- Updated_at trigger for productos
create or replace function actualizar_timestamp_productos()
returns trigger as $$
begin
  new.actualizado_en = now();
  return new;
end;
$$ language plpgsql;

create trigger trigger_actualizar_timestamp_productos
before update on productos
for each row
execute function actualizar_timestamp_productos();

-- Insert correct productos
insert into productos (nombre, categoria, precio_actual, unidad) values
  ('Alimento balanceado', 'alimento', 0, 'kg'),
  ('Expeller de soja', 'expeller', 0, 'kg'),
  ('Maíz', 'maiz', 0, 'kg'),
  ('N1 - Grande', 'huevos', 4500, 'maple'),
  ('N2 - Mediano', 'huevos', 4200, 'maple'),
  ('N3 - Chico', 'huevos', 3900, 'maple'),
  ('Docena', 'huevos', 3600, 'docena'),
  ('Guano', 'guano', 0, 'kg');
