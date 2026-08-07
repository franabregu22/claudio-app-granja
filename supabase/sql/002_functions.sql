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
