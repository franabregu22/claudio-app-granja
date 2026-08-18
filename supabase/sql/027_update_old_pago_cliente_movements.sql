-- Update old "Pago cliente" movements to show client name and add cliente_id
UPDATE movimientos_caja m
SET
  concepto = 'Cobro - ' || c.nombre,
  cliente_id = p.cliente_id
FROM pagos p
JOIN clientes c ON p.cliente_id = c.id
WHERE m.vinculado_a = 'pago'
  AND m.vinculado_id = p.id
  AND m.concepto = 'Pago cliente';
