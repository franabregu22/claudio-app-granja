-- Create RecuentosLote table for tracking periodic animal count verifications
CREATE TABLE IF NOT EXISTS public.recuentos_lote (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id uuid NOT NULL REFERENCES public.lotes(id) ON DELETE CASCADE,
  fecha_recuento date NOT NULL,
  aves_contadas integer NOT NULL CHECK (aves_contadas >= 0),
  mortandad_esperada integer,
  diferencia integer,
  notas text,
  registrado_por uuid REFERENCES public.perfiles(id),
  registrado_en timestamptz NOT NULL DEFAULT NOW(),
  actualizado_en timestamptz NOT NULL DEFAULT NOW(),

  -- Ensure one recuento per lote per date
  UNIQUE(lote_id, fecha_recuento)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS recuentos_lote_lote_id_idx ON public.recuentos_lote(lote_id);
CREATE INDEX IF NOT EXISTS recuentos_lote_fecha_idx ON public.recuentos_lote(fecha_recuento);

-- RLS Policies
ALTER TABLE public.recuentos_lote ENABLE ROW LEVEL SECURITY;

-- Dueño can view all recuentos
CREATE POLICY "recuentos_lote_select_dueño" ON public.recuentos_lote
  FOR SELECT
  USING (is_dueño());

-- Dueño can create recuentos
CREATE POLICY "recuentos_lote_insert_dueño" ON public.recuentos_lote
  FOR INSERT
  WITH CHECK (is_dueño());

-- Dueño can update recuentos
CREATE POLICY "recuentos_lote_update_dueño" ON public.recuentos_lote
  FOR UPDATE
  USING (is_dueño())
  WITH CHECK (is_dueño());

-- Dueño can delete recuentos
CREATE POLICY "recuentos_lote_delete_dueño" ON public.recuentos_lote
  FOR DELETE
  USING (is_dueño());
