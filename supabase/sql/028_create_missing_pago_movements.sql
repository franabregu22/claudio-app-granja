-- Create missing movements in movimientos_caja for existing pagos
INSERT INTO movimientos_caja (
  tipo,
  concepto,
  monto,
  forma_pago,
  fecha_operacion,
  fecha_pago,
  estado,
  vinculado_a,
  vinculado_id,
  cliente_id,
  notas,
  created_at
)
SELECT
  'ingreso',
  'Cobro - ' || c.nombre,
  p.monto,
  CASE p.metodo_pago
    WHEN 'efectivo' THEN 'efectivo'
    WHEN 'transferencia' THEN 'efectivo'
    WHEN 'tarjeta' THEN 'mercadopago'
    WHEN 'mercadopago' THEN 'mercadopago'
    WHEN 'cheque' THEN 'cheque'
    WHEN 'echeq' THEN 'echeq'
    ELSE 'efectivo'
  END,
  p.fecha_pago,
  p.fecha_pago,
  'confirmado',
  'pago',
  p.id::text,
  p.cliente_id,
  CASE WHEN p.notas IS NOT NULL THEN 'Pago: ' || p.notas ELSE 'Pago registrado en Cobros' END,
  NOW()
FROM pagos p
JOIN clientes c ON p.cliente_id = c.id
WHERE NOT EXISTS (
  SELECT 1 FROM movimientos_caja m
  WHERE m.vinculado_a = 'pago'
    AND m.vinculado_id = p.id::text
)
ORDER BY p.fecha_pago;
