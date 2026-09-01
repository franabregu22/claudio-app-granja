-- Crear tabla de cuentas de caja
CREATE TABLE IF NOT EXISTS cuentas_caja (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(100) NOT NULL UNIQUE,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('efectivo', 'digital')),
  descripcion TEXT,
  activa BOOLEAN DEFAULT true,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Crear tabla de arqueos de caja
CREATE TABLE IF NOT EXISTS arqueos_caja (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id UUID NOT NULL REFERENCES cuentas_caja(id),
  fecha_arqueo DATE NOT NULL,
  monto_fisico NUMERIC(15,2) NOT NULL,
  monto_registrado NUMERIC(15,2) NOT NULL,
  diferencia NUMERIC(15,2) GENERATED ALWAYS AS (monto_fisico - monto_registrado) STORED,
  notas TEXT,
  creado_por UUID NOT NULL REFERENCES auth.users(id),
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cuenta_id, fecha_arqueo)
);

-- Insertar las 3 cuentas
INSERT INTO cuentas_caja (nombre, tipo, descripcion) VALUES
  ('Caja Chica', 'efectivo', 'Efectivo en mano - caja principal'),
  ('MercadoPago', 'digital', 'Pagos recibidos por MercadoPago'),
  ('BNA', 'digital', 'Cuenta corriente BNA')
ON CONFLICT (nombre) DO NOTHING;

-- Índices para búsquedas rápidas
CREATE INDEX idx_arqueos_caja_cuenta_fecha ON arqueos_caja(cuenta_id, fecha_arqueo DESC);
CREATE INDEX idx_arqueos_caja_fecha ON arqueos_caja(fecha_arqueo DESC);

-- RLS: Solo el dueño puede ver/crear arqueos
ALTER TABLE cuentas_caja ENABLE ROW LEVEL SECURITY;
ALTER TABLE arqueos_caja ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Cuentas visible a todos" ON cuentas_caja
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Arqueos insert dueño" ON arqueos_caja
  FOR INSERT WITH CHECK (auth.uid() = creado_por);

CREATE POLICY "Arqueos select dueño" ON arqueos_caja
  FOR SELECT USING (true);  -- Todos ven el historial para auditoría
