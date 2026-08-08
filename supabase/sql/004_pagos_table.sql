-- Agregar columna monto_total a pedidos (si no existe)
ALTER TABLE public.pedidos
ADD COLUMN IF NOT EXISTS monto_total integer DEFAULT 0;

-- Crear tabla pagos
CREATE TABLE IF NOT EXISTS public.pagos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES public.clientes(id),
  monto integer NOT NULL CHECK (monto > 0),
  metodo_pago text NOT NULL CHECK (metodo_pago IN ('efectivo', 'transferencia', 'tarjeta', 'mercadopago', 'otro')),
  fecha_pago date NOT NULL DEFAULT CURRENT_DATE,
  notas text,
  creado_en timestamp NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_monto CHECK (monto > 0)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS pagos_cliente_idx ON public.pagos(cliente_id);
CREATE INDEX IF NOT EXISTS pagos_fecha_idx ON public.pagos(fecha_pago);

-- RLS policies para pagos
ALTER TABLE public.pagos ENABLE ROW LEVEL SECURITY;

-- Dueño puede ver todos los pagos
CREATE POLICY "Dueño puede ver todos los pagos" ON public.pagos
  FOR SELECT
  USING (is_dueño());

-- Dueño puede crear pagos
CREATE POLICY "Dueño puede crear pagos" ON public.pagos
  FOR INSERT
  WITH CHECK (is_dueño());

-- Dueño puede actualizar pagos
CREATE POLICY "Dueño puede actualizar pagos" ON public.pagos
  FOR UPDATE
  USING (is_dueño())
  WITH CHECK (is_dueño());

-- Dueño puede borrar pagos
CREATE POLICY "Dueño puede borrar pagos" ON public.pagos
  FOR DELETE
  USING (is_dueño());
