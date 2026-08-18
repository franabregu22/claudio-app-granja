-- Add categoria/subcategoria/naturaleza_gasto columns to movimientos_caja
alter table movimientos_caja add column if not exists categoria text;
alter table movimientos_caja add column if not exists subcategoria text;
alter table movimientos_caja add column if not exists naturaleza_gasto text;

-- Create indexes for filtering by categoría and naturaleza
create index if not exists idx_movimientos_caja_categoria on movimientos_caja(categoria);
create index if not exists idx_movimientos_caja_naturaleza on movimientos_caja(naturaleza_gasto);
