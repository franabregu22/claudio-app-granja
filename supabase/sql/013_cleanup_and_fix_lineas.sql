-- Clean up precios_snapshot (set to NULL since we're not using it anymore)
update pedidos set precios_snapshot = null;

-- Verify lineas column exists and is JSONB
-- This should already be true from schema, but let's ensure it accepts arrays
-- The issue might be that we need to explicitly cast when inserting

-- For now, let's just document that lineas should store LineaPedido arrays:
-- [
--   {
--     "producto_id": "uuid",
--     "producto_nombre": "string",
--     "cantidad": number,
--     "precio_unitario": number,
--     "subtotal": number
--   }
-- ]

-- Drop old indexes that reference precios_snapshot if any
-- (they would be in 001_schema.sql but there shouldn't be any)
