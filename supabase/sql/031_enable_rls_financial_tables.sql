-- Enable RLS on financial tables and add policies

-- movimientos_caja: Only dueño can insert/update/delete, all auth users can read their own client data
ALTER TABLE movimientos_caja ENABLE ROW LEVEL SECURITY;

CREATE POLICY "movimientos_read_auth" ON movimientos_caja
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "movimientos_insert_dueño" ON movimientos_caja
  FOR INSERT WITH CHECK (is_dueño());

CREATE POLICY "movimientos_update_dueño" ON movimientos_caja
  FOR UPDATE USING (is_dueño()) WITH CHECK (is_dueño());

CREATE POLICY "movimientos_delete_dueño" ON movimientos_caja
  FOR DELETE USING (is_dueño());

-- pagos: Only dueño can manage, all auth can read
ALTER TABLE pagos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pagos_read_auth" ON pagos
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "pagos_insert_dueño" ON pagos
  FOR INSERT WITH CHECK (is_dueño());

CREATE POLICY "pagos_update_dueño" ON pagos
  FOR UPDATE USING (is_dueño()) WITH CHECK (is_dueño());

CREATE POLICY "pagos_delete_dueño" ON pagos
  FOR DELETE USING (is_dueño());

-- cheques: Only dueño
ALTER TABLE cheques ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cheques_read_auth" ON cheques
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "cheques_insert_dueño" ON cheques
  FOR INSERT WITH CHECK (is_dueño());

CREATE POLICY "cheques_update_dueño" ON cheques
  FOR UPDATE USING (is_dueño()) WITH CHECK (is_dueño());

CREATE POLICY "cheques_delete_dueño" ON cheques
  FOR DELETE USING (is_dueño());

-- comisiones: Only dueño
ALTER TABLE comisiones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "comisiones_read_auth" ON comisiones
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "comisiones_insert_dueño" ON comisiones
  FOR INSERT WITH CHECK (is_dueño());

CREATE POLICY "comisiones_update_dueño" ON comisiones
  FOR UPDATE USING (is_dueño()) WITH CHECK (is_dueño());

CREATE POLICY "comisiones_delete_dueño" ON comisiones
  FOR DELETE USING (is_dueño());
