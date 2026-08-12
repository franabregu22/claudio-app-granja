-- Verify pedido_lineas has data
select count(*) as total_lineas from pedido_lineas;

-- Check if any pedido has lineas
select count(distinct pedido_id) as pedidos_with_lineas from pedido_lineas;

-- Check current monto_total values in pedidos (should show NaN, NULL, or 0)
select id, cliente_nombre, monto_total,
  (select coalesce(sum(subtotal), 0) from pedido_lineas where pedido_id = pedidos.id) as calculated_total
from pedidos
order by id desc
limit 20;

-- Recalculate all monto_total values based on pedido_lineas
update pedidos
set monto_total = coalesce(
  (select sum(subtotal) from pedido_lineas where pedido_id = pedidos.id),
  0
)
where true;

-- Verify the update worked
select id, cliente_nombre, monto_total from pedidos order by id desc limit 20;
