-- Remove precios_snapshot column from pedidos
alter table pedidos drop column if exists precios_snapshot;

-- Create precios_historial table to track price changes over time
create table if not exists precios_historial (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references productos(id),
  precio_anterior numeric(10,2),
  precio_nuevo numeric(10,2) not null,
  cambio_por uuid references perfiles(id),
  cambio_en timestamptz default now()
);

-- Add index
create index if not exists idx_precios_historial_producto on precios_historial(producto_id);
create index if not exists idx_precios_historial_cambio_en on precios_historial(cambio_en desc);

-- Trigger to log price changes
create or replace function registrar_cambio_precio()
returns trigger as $$
begin
  if new.precio_actual != old.precio_actual then
    insert into precios_historial (producto_id, precio_anterior, precio_nuevo)
    values (new.id, old.precio_actual, new.precio_actual);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trigger_registrar_cambio_precio on productos;
create trigger trigger_registrar_cambio_precio
before update on productos
for each row
execute function registrar_cambio_precio();
