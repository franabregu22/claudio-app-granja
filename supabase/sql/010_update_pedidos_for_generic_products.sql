-- Update existing pedidos to have fecha_operacion (defaults to fecha_pedido for now)
-- This migration makes the transition from old structure to new structure

-- Ensure fecha_operacion is properly set
update pedidos
set fecha_operacion = coalesce(fecha_operacion, fecha_pedido, CURRENT_DATE)
where fecha_operacion is null;

-- Update monto_total for existing pedidos if missing
-- For old structure with lineas object, we'll leave monto_total as is
-- New pedidos should always have monto_total calculated

-- Create an index on monto_total for future reporting
create index if not exists idx_pedidos_monto_total on pedidos(monto_total);
