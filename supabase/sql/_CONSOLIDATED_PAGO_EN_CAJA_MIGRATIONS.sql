-- Helper function to check if user is dueño
create or replace function is_dueño()
returns boolean as $$
  select exists (
    select 1 from perfiles
    where id = auth.uid() and rol = 'dueño'
  );
$$ language sql security definer set search_path = public;

-- Trigger to auto-create profile for new users (defaults to repartidor)
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into perfiles (id, rol)
  values (new.id, 'repartidor');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- RPC function to mark pedido as entregado (safe, only updates estado/entregado_* fields)
create or replace function marcar_pedido_entregado(pedido_id uuid)
returns void as $$
begin
  update pedidos
  set
    estado = 'entregado',
    entregado_en = now(),
    entregado_por = auth.uid(),
    actualizado_en = now()
  where id = pedido_id and estado = 'pendiente';
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function marcar_pedido_entregado(uuid) to authenticated;
-- Enable RLS on all tables
alter table perfiles enable row level security;
alter table clientes enable row level security;
alter table precios_actuales enable row level security;
alter table pedidos enable row level security;

-- ===== PERFILES =====
-- Everyone can read all profiles (needed for resolving entregado_por names, etc.)
create policy "perfiles_select_authenticated"
  on perfiles for select to authenticated
  using (true);

-- Only dueño can update perfiles
create policy "perfiles_update_dueño"
  on perfiles for update to authenticated
  using (is_dueño());

-- ===== CLIENTES =====
-- Everyone can read all clientes
create policy "clientes_select_authenticated"
  on clientes for select to authenticated
  using (true);

-- Only dueño can insert clientes
create policy "clientes_insert_dueño"
  on clientes for insert to authenticated
  with check (is_dueño());

-- Only dueño can update clientes
create policy "clientes_update_dueño"
  on clientes for update to authenticated
  using (is_dueño());

-- ===== PRECIOS_ACTUALES =====
-- Everyone can read all precios
create policy "precios_select_authenticated"
  on precios_actuales for select to authenticated
  using (true);

-- Only dueño can update precios
create policy "precios_update_dueño"
  on precios_actuales for update to authenticated
  using (is_dueño());

-- ===== PEDIDOS =====
-- Everyone can read all pedidos
create policy "pedidos_select_authenticated"
  on pedidos for select to authenticated
  using (true);

-- Only dueño can insert pedidos
create policy "pedidos_insert_dueño"
  on pedidos for insert to authenticated
  with check (is_dueño());

-- Only dueño can update pedidos (general purpose, for rectificar/cancelar)
-- Repartidor's only write path is the marcar_pedido_entregado() RPC
create policy "pedidos_update_dueño"
  on pedidos for update to authenticated
  using (is_dueño());

-- No DELETE policy: neither role can hard-delete, only via dashboard (soft-delete via estado='cancelado')
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
-- Add estado field to pagos table
ALTER TABLE pagos
ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'confirmado' CHECK (estado IN ('confirmado', 'cancelado'));

-- Create index for filtering by estado
CREATE INDEX IF NOT EXISTS idx_pagos_estado ON pagos(estado);
-- Add creado_por to pagos table for audit trail
ALTER TABLE public.pagos
ADD COLUMN IF NOT EXISTS creado_por uuid REFERENCES public.perfiles(id);

-- Add index for performance
CREATE INDEX IF NOT EXISTS pagos_creado_por_idx ON public.pagos(creado_por);
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
