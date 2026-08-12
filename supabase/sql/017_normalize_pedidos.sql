-- Create pedido_lineas table (normalized structure)
create table pedido_lineas (
  id uuid primary key default gen_random_uuid(),
  pedido_id bigint not null references pedidos(id) on delete cascade,
  producto_id uuid not null references productos(id),
  producto_nombre text not null,
  cantidad numeric not null,
  precio_unitario numeric not null,
  subtotal numeric not null,
  creado_en timestamptz default now(),
  actualizado_en timestamptz default now()
);

-- Add indexes
create index idx_pedido_lineas_pedido_id on pedido_lineas(pedido_id);
create index idx_pedido_lineas_producto_id on pedido_lineas(producto_id);

-- Migrate data from old JSONB lineas to new table
-- This handles the new format (array of {producto_id, producto_nombre, cantidad, precio_unitario, subtotal})
insert into pedido_lineas (pedido_id, producto_id, producto_nombre, cantidad, precio_unitario, subtotal)
select 
  p.id as pedido_id,
  (line->>'producto_id')::uuid as producto_id,
  line->>'producto_nombre' as producto_nombre,
  (line->>'cantidad')::numeric as cantidad,
  (line->>'precio_unitario')::numeric as precio_unitario,
  (line->>'subtotal')::numeric as subtotal
from pedidos p
cross join jsonb_array_elements(p.lineas) as line
where p.lineas is not null 
  and jsonb_typeof(p.lineas) = 'array'
  and line ? 'producto_id';

-- Update monto_total based on new lineas table
update pedidos p
set monto_total = (
  select coalesce(sum(subtotal), 0)
  from pedido_lineas pl
  where pl.pedido_id = p.id
)
where exists (
  select 1 from pedido_lineas where pedido_id = p.id
);

-- Remove old JSONB columns
alter table pedidos drop column if exists lineas;

-- Add trigger to update monto_total automatically
create or replace function actualizar_monto_total_pedido()
returns trigger as $$
begin
  update pedidos
  set monto_total = (
    select coalesce(sum(subtotal), 0)
    from pedido_lineas
    where pedido_id = new.pedido_id
  ),
  actualizado_en = now()
  where id = new.pedido_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trigger_actualizar_monto_total_pedido on pedido_lineas;
create trigger trigger_actualizar_monto_total_pedido
after insert or update or delete on pedido_lineas
for each row
execute function actualizar_monto_total_pedido();

-- Updated_at trigger for pedido_lineas
create or replace function actualizar_timestamp_pedido_lineas()
returns trigger as $$
begin
  new.actualizado_en = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trigger_actualizar_timestamp_pedido_lineas on pedido_lineas;
create trigger trigger_actualizar_timestamp_pedido_lineas
before update on pedido_lineas
for each row
execute function actualizar_timestamp_pedido_lineas();
