-- Remove old unused category columns from movimientos_caja
ALTER TABLE movimientos_caja
DROP COLUMN IF EXISTS categoria,
DROP COLUMN IF EXISTS subcategoria,
DROP COLUMN IF EXISTS naturaleza_gasto;

-- Add new category fields to movimientos_caja table
ALTER TABLE movimientos_caja
ADD COLUMN IF NOT EXISTS categoria_tecnica TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS categoria_analisis TEXT DEFAULT NULL;

-- Create indexes for faster filtering
CREATE INDEX IF NOT EXISTS idx_movimientos_categoria_tecnica ON movimientos_caja(categoria_tecnica);
CREATE INDEX IF NOT EXISTS idx_movimientos_categoria_analisis ON movimientos_caja(categoria_analisis);

-- Create categorias_finanzas table if it doesn't exist
CREATE TABLE IF NOT EXISTS categorias_finanzas (
  id BIGSERIAL PRIMARY KEY,
  categoria_tecnica TEXT NOT NULL,
  subcategoria TEXT NOT NULL,
  categoria_analisis TEXT NOT NULL CHECK (categoria_analisis IN ('GASTOS_OPERATIVOS', 'REINVERSION_OPERATIVA', 'INVERSION')),
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(categoria_tecnica, subcategoria)
);

-- Enable RLS on categorias_finanzas
ALTER TABLE categorias_finanzas ENABLE ROW LEVEL SECURITY;

-- RLS policies for categorias_finanzas
CREATE POLICY "categorias_select_auth" ON categorias_finanzas FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "categorias_insert_admin" ON categorias_finanzas FOR INSERT WITH CHECK (is_dueño());
CREATE POLICY "categorias_update_admin" ON categorias_finanzas FOR UPDATE USING (is_dueño()) WITH CHECK (is_dueño());
CREATE POLICY "categorias_delete_admin" ON categorias_finanzas FOR DELETE USING (is_dueño());
