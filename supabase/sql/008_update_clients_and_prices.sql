-- Agregar categoría a clientes
ALTER TABLE public.clientes
ADD COLUMN IF NOT EXISTS categoria text DEFAULT 'particular'
CHECK (categoria IN ('particular', 'comercio', 'distribuidor', 'feria municipal'));

-- Modificar tabla precios_actuales para mayorista/minorista
-- Primero, dropear la tabla actual y recrearla con la nueva estructura
DROP TABLE IF EXISTS public.precios_actuales CASCADE;

CREATE TABLE public.precios_actuales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  categoria text NOT NULL CHECK (categoria IN ('xl', 'n1', 'n2', 'n3', 'docena')),
  tipo_cliente text NOT NULL CHECK (tipo_cliente IN ('minorista', 'mayorista', 'ambos')),
  precio integer NOT NULL CHECK (precio >= 0),
  vigente_desde date NOT NULL DEFAULT CURRENT_DATE,
  actualizado_por uuid,
  actualizado_en timestamp DEFAULT NOW(),

  UNIQUE(categoria, tipo_cliente)
);

-- Insertar precios iniciales
INSERT INTO public.precios_actuales (categoria, tipo_cliente, precio) VALUES
-- Minorista
('xl', 'minorista', 5000),
('n1', 'minorista', 4500),
('n2', 'minorista', 3800),
('n3', 'minorista', 3200),
('docena', 'ambos', 1200),
-- Mayorista
('xl', 'mayorista', 4500),
('n1', 'mayorista', 4000),
('n2', 'mayorista', 3300),
('n3', 'mayorista', 2700);

-- Habilitar RLS en precios_actuales
ALTER TABLE public.precios_actuales ENABLE ROW LEVEL SECURITY;

-- Políticas RLS
CREATE POLICY "Todos pueden leer precios" ON public.precios_actuales
  FOR SELECT USING (true);

CREATE POLICY "Dueño puede editar precios" ON public.precios_actuales
  FOR UPDATE
  USING (EXISTS (SELECT 1 FROM perfiles WHERE id = auth.uid() AND rol = 'dueño'))
  WITH CHECK (EXISTS (SELECT 1 FROM perfiles WHERE id = auth.uid() AND rol = 'dueño'));
