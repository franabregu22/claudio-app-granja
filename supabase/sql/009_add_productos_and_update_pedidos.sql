-- ETAPA 1: Add generic productos table and update pedidos structure

-- Create productos table
create table productos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  categoria text not null, -- 'huevos', 'maiz', 'alimento_balanceado', 'subproducto', etc
  precio_actual numeric(10,2) not null,
  unidad text not null, -- 'kg', 'docena', 'unidad', etc
  activo boolean default true,
  creado_por uuid references perfiles(id),
  creado_en timestamptz default now(),
  actualizado_en timestamptz default now()
);

-- Add indexes for productos
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

-- Add new columns to pedidos: fecha_operacion and fecha_pago
alter table pedidos add column if not exists fecha_operacion date not null default CURRENT_DATE;
alter table pedidos add column if not exists fecha_pago date;
alter table pedidos add column if not exists monto_total numeric(10,2);

-- Seed initial productos from existing categorias
insert into productos (nombre, categoria, precio_actual, unidad) values
  ('Huevo Jumbo', 'huevos', 4500, 'kg'),
  ('Huevo AAA', 'huevos', 4200, 'kg'),
  ('Huevo AA', 'huevos', 3900, 'kg'),
  ('Huevo A', 'huevos', 3600, 'kg'),
  ('Huevo B', 'huevos', 3200, 'kg'),
  ('Maíz', 'cereales', 0, 'kg'),
  ('Expeller de Soja', 'cereales', 0, 'kg'),
  ('Alimento Balanceado', 'alimento', 0, 'kg')
on conflict (nombre) do nothing;

-- Index for pedidos fecha_operacion (for reporting)
create index if not exists idx_pedidos_fecha_operacion on pedidos(fecha_operacion);
create index if not exists idx_pedidos_fecha_pago on pedidos(fecha_pago);
