-- PASO 1: Crear secuencia para IDs de pedidos
CREATE SEQUENCE IF NOT EXISTS public.pedidos_id_seq START WITH 1 INCREMENT BY 1;

-- PASO 2: Agregar columna temporal con bigint
ALTER TABLE public.pedidos
ADD COLUMN IF NOT EXISTS id_new bigint DEFAULT nextval('public.pedidos_id_seq');

-- PASO 3: Asegurar que todos los pedidos tengan id_new
UPDATE public.pedidos
SET id_new = nextval('public.pedidos_id_seq')
WHERE id_new IS NULL;

-- PASO 4: Hacer que id_new sea NOT NULL
ALTER TABLE public.pedidos
ALTER COLUMN id_new SET NOT NULL;

-- PASO 5: Dropear constraint de primary key
ALTER TABLE public.pedidos
DROP CONSTRAINT pedidos_pkey;

-- PASO 6: Renombrar columnas
ALTER TABLE public.pedidos RENAME COLUMN id TO id_old;
ALTER TABLE public.pedidos RENAME COLUMN id_new TO id;

-- PASO 7: Hacer id PRIMARY KEY
ALTER TABLE public.pedidos
ADD PRIMARY KEY (id);

-- PASO 8: Configurar id para auto-increment en futuras inserciones
ALTER TABLE public.pedidos
ALTER COLUMN id SET DEFAULT nextval('public.pedidos_id_seq');
