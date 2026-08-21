-- Add creado_por to pagos table for audit trail
ALTER TABLE public.pagos
ADD COLUMN IF NOT EXISTS creado_por uuid REFERENCES public.perfiles(id);

-- Add index for performance
CREATE INDEX IF NOT EXISTS pagos_creado_por_idx ON public.pagos(creado_por);
