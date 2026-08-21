-- Update handle_new_user to save email as nombre
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into perfiles (id, nombre, rol)
  values (new.id, new.email, 'repartidor');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- Fill in missing nombres from auth.users emails
update perfiles p
set nombre = u.email
from auth.users u
where p.id = u.id and p.nombre is null;
