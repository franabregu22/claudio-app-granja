-- Delete old MercadoPago movements and their associated impuestos
DELETE FROM movimientos_caja
WHERE vinculado_a = 'impuesto_cheque'
  AND vinculado_id IN (
    SELECT id::text FROM movimientos_caja
    WHERE vinculado_a = 'mercadopago'
  );

DELETE FROM movimientos_caja
WHERE vinculado_a = 'mercadopago';
