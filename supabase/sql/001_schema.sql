-- Enum for categoria
create type categoria as enum ('jumbo', 'aaa', 'aa', 'a', 'b');

-- Enum for pedido estado
create type pedido_estado as enum ('pendiente', 'entregado', 'cancelado');

-- Enum for rol
create type rol_type as enum ('dueño', 'repartidor');

-- Perfiles table (linked to auth.users)
create table perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text,
  rol rol_type not null default 'repartidor',
  created_at timestamptz default now()
);

-- Clientes table
create table clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  activo boolean default true,
  created_at timestamptz default now()
);

-- Precios actuales table (one row per categoria)
create table precios_actuales (
  categoria categoria primary key,
  precio numeric(10,2) not null,
  actualizado_por uuid references perfiles(id),
  actualizado_en timestamptz default now()
);

-- Pedidos table with JSONB for lineas and precios_snapshot
create table pedidos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id),
  cliente_nombre text not null,
  lineas jsonb not null,
  precios_snapshot jsonb not null,
  estado pedido_estado not null default 'pendiente',
  rectificado boolean not null default false,
  creado_por uuid references perfiles(id),
  entregado_por uuid references perfiles(id),
  entregado_en timestamptz,
  creado_en timestamptz default now(),
  actualizado_en timestamptz default now()
);

-- Indexes
create index idx_pedidos_estado on pedidos(estado);
create index idx_pedidos_cliente_id on pedidos(cliente_id);
create index idx_pedidos_creado_en on pedidos(creado_en desc);

-- Updated_at trigger for pedidos
create or replace function actualizar_timestamp_pedidos()
returns trigger as $$
begin
  new.actualizado_en = now();
  return new;
end;
$$ language plpgsql;

create trigger trigger_actualizar_timestamp_pedidos
before update on pedidos
for each row
execute function actualizar_timestamp_pedidos();

-- Seed initial data
insert into precios_actuales (categoria, precio) values
  ('jumbo', 4500),
  ('aaa', 4200),
  ('aa', 3900),
  ('a', 3600),
  ('b', 3200)
on conflict (categoria) do nothing;

insert into clientes (nombre) values
  ('Almacén Don Raúl'),
  ('Verdulería La Esquina'),
  ('Rotisería Martínez'),
  ('Comedor Escolar')
on conflict (nombre) do nothing;
