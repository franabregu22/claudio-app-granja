-- Make precios_snapshot nullable since we're not using it anymore
alter table pedidos alter column precios_snapshot drop not null;

-- Ensure fecha_operacion has proper default
alter table pedidos alter column fecha_operacion set default CURRENT_DATE;

-- Make sure monto_total is not null and has proper type
alter table pedidos alter column monto_total set not null;
alter table pedidos alter column monto_total set default 0;

-- Ensure lineas is handled properly for both old and new structure
-- This column should already accept both JSON objects and arrays
