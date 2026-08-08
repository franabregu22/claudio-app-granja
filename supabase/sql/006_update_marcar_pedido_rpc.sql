-- Actualizar RPC marcar_pedido_entregado para trabajar con bigint
DROP FUNCTION IF EXISTS public.marcar_pedido_entregado(uuid);

CREATE OR REPLACE FUNCTION public.marcar_pedido_entregado(pedido_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.pedidos
  SET
    estado = 'entregado',
    entregado_en = NOW(),
    entregado_por = (SELECT id FROM auth.users WHERE id = auth.uid())
  WHERE id = pedido_id AND estado = 'pendiente';
END;
$$;

-- Dar permiso a usuarios autenticados para ejecutar la función
GRANT EXECUTE ON FUNCTION public.marcar_pedido_entregado(bigint) TO authenticated;
