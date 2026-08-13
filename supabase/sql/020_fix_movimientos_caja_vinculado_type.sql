-- Fix vinculado_id type to support both bigint (pedidos) and UUID (pagos)
alter table movimientos_caja alter column vinculado_id type text using vinculado_id::text;
