-- Agregar columna observaciones a pedidos
ALTER TABLE public.pedidos
ADD COLUMN IF NOT EXISTS observaciones text;
