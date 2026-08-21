-- Create table to track when cash payments are marked as added to cash box
CREATE TABLE IF NOT EXISTS public.pago_en_caja (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pago_id uuid NOT NULL UNIQUE REFERENCES public.pagos(id) ON DELETE CASCADE,
  agregado_por uuid NOT NULL REFERENCES public.perfiles(id),
  agregado_en timestamptz NOT NULL DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS pago_en_caja_pago_id_idx ON public.pago_en_caja(pago_id);
CREATE INDEX IF NOT EXISTS pago_en_caja_agregado_por_idx ON public.pago_en_caja(agregado_por);

-- RLS policies for pago_en_caja
ALTER TABLE public.pago_en_caja ENABLE ROW LEVEL SECURITY;

-- Dueño can view all entries
CREATE POLICY "Dueño puede ver pago_en_caja" ON public.pago_en_caja
  FOR SELECT
  USING (is_dueño());

-- Dueño can create entries (when marking as added to cash)
CREATE POLICY "Dueño puede crear pago_en_caja" ON public.pago_en_caja
  FOR INSERT
  WITH CHECK (is_dueño());

-- No update allowed (immutable once created)
-- No delete allowed (immutable once created)
