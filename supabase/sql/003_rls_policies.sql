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
