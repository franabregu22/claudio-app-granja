-- Migrate old pedidos format to new format
-- This converts {"n1":1,"n2":0,"n3":0,"xl":0,"docena":0}
-- to [{"producto_id":"...","producto_nombre":"...","cantidad":1,"precio_unitario":4500,"subtotal":4500}]

-- Uses precio_actual from productos table at time of migration
-- The user will manually enter correct prices in the formula

with producto_map as (
  select id, nombre, precio_actual from productos
  where nombre in ('N1 - Grande', 'N2 - Mediano', 'N3 - Chico', 'Docena')
)
update pedidos
set lineas = jsonb_build_array(
  case when ((lineas->'n1')::int)::numeric > 0
    then jsonb_build_object(
      'producto_id', (select id from producto_map where nombre = 'N1 - Grande'),
      'producto_nombre', 'N1 - Grande',
      'cantidad', ((lineas->'n1')::int)::numeric,
      'precio_unitario', (select precio_actual from producto_map where nombre = 'N1 - Grande'),
      'subtotal', (((lineas->'n1')::int) * (select precio_actual from producto_map where nombre = 'N1 - Grande'))::numeric
    )
  else null end,
  case when ((lineas->'n2')::int)::numeric > 0
    then jsonb_build_object(
      'producto_id', (select id from producto_map where nombre = 'N2 - Mediano'),
      'producto_nombre', 'N2 - Mediano',
      'cantidad', ((lineas->'n2')::int)::numeric,
      'precio_unitario', (select precio_actual from producto_map where nombre = 'N2 - Mediano'),
      'subtotal', (((lineas->'n2')::int) * (select precio_actual from producto_map where nombre = 'N2 - Mediano'))::numeric
    )
  else null end,
  case when ((lineas->'n3')::int)::numeric > 0
    then jsonb_build_object(
      'producto_id', (select id from producto_map where nombre = 'N3 - Chico'),
      'producto_nombre', 'N3 - Chico',
      'cantidad', ((lineas->'n3')::int)::numeric,
      'precio_unitario', (select precio_actual from producto_map where nombre = 'N3 - Chico'),
      'subtotal', (((lineas->'n3')::int) * (select precio_actual from producto_map where nombre = 'N3 - Chico'))::numeric
    )
  else null end,
  case when ((lineas->'docena')::int)::numeric > 0
    then jsonb_build_object(
      'producto_id', (select id from producto_map where nombre = 'Docena'),
      'producto_nombre', 'Docena',
      'cantidad', ((lineas->'docena')::int)::numeric,
      'precio_unitario', (select precio_actual from producto_map where nombre = 'Docena'),
      'subtotal', (((lineas->'docena')::int) * (select precio_actual from producto_map where nombre = 'Docena'))::numeric
    )
  else null end
) - 'null'::text
where lineas ? 'n1' or lineas ? 'n2' or lineas ? 'n3' or lineas ? 'docena';

-- Update monto_total for all pedidos to ensure it's calculated correctly
update pedidos
set monto_total = (
  select coalesce(sum((line->>'subtotal')::numeric), 0)
  from jsonb_array_elements(lineas) as line
  where line->>'subtotal' is not null
)
where lineas != 'null'::jsonb;
