-- Enable RLS on remaining tables without protection
-- This completes security hardening across all tables

-- ===== PRODUCTOS =====
ALTER TABLE productos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "productos_select_auth" ON productos;
DROP POLICY IF EXISTS "productos_insert_dueño" ON productos;
DROP POLICY IF EXISTS "productos_update_dueño" ON productos;
DROP POLICY IF EXISTS "productos_delete_dueño" ON productos;

CREATE POLICY "productos_select_auth" ON productos
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "productos_insert_dueño" ON productos
  FOR INSERT WITH CHECK (is_dueño());

CREATE POLICY "productos_update_dueño" ON productos
  FOR UPDATE USING (is_dueño()) WITH CHECK (is_dueño());

CREATE POLICY "productos_delete_dueño" ON productos
  FOR DELETE USING (is_dueño());

-- ===== LOTES =====
ALTER TABLE lotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lotes_select_auth" ON lotes;
DROP POLICY IF EXISTS "lotes_insert_dueño" ON lotes;
DROP POLICY IF EXISTS "lotes_update_dueño" ON lotes;
DROP POLICY IF EXISTS "lotes_delete_dueño" ON lotes;

CREATE POLICY "lotes_select_auth" ON lotes
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "lotes_insert_dueño" ON lotes
  FOR INSERT WITH CHECK (is_dueño());

CREATE POLICY "lotes_update_dueño" ON lotes
  FOR UPDATE USING (is_dueño()) WITH CHECK (is_dueño());

CREATE POLICY "lotes_delete_dueño" ON lotes
  FOR DELETE USING (is_dueño());

-- ===== PEDIDO_LINEAS (if exists) =====
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pedido_lineas') THEN
    ALTER TABLE pedido_lineas ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "pedido_lineas_select_auth" ON pedido_lineas;
    DROP POLICY IF EXISTS "pedido_lineas_insert_dueño" ON pedido_lineas;
    DROP POLICY IF EXISTS "pedido_lineas_update_dueño" ON pedido_lineas;
    DROP POLICY IF EXISTS "pedido_lineas_delete_dueño" ON pedido_lineas;

    CREATE POLICY "pedido_lineas_select_auth" ON pedido_lineas
      FOR SELECT USING (auth.role() = 'authenticated');

    CREATE POLICY "pedido_lineas_insert_dueño" ON pedido_lineas
      FOR INSERT WITH CHECK (is_dueño());

    CREATE POLICY "pedido_lineas_update_dueño" ON pedido_lineas
      FOR UPDATE USING (is_dueño()) WITH CHECK (is_dueño());

    CREATE POLICY "pedido_lineas_delete_dueño" ON pedido_lineas
      FOR DELETE USING (is_dueño());
  END IF;
END $$;
