-- MAESTRO DE LOTES
-- Tabla para registrar cada lote de gallinas y su ciclo de vida

create type lote_estado as enum ('Activo', 'Retirado', 'Planificado');

create table lotes (
  id uuid primary key default gen_random_uuid(),
  galpon text not null,
  fecha_entrada date not null,
  fecha_salida date,
  aves_iniciales_postura bigint not null, -- Campo principal para cálculo de postura
  linea text, -- ej: HY-Line Brown, HN-Brown Nick
  lote_id text, -- ej: G01-2501
  estado lote_estado default 'Activo',
  notas text,
  creado_por uuid references perfiles(id),
  creado_en timestamptz default now(),
  actualizado_en timestamptz default now(),
  unique(galpon, fecha_entrada)
);

-- Agregar lote_id a producciones
alter table producciones
add column lote_id uuid references lotes(id);

-- Crear índices
create index idx_lotes_galpon on lotes(galpon);
create index idx_lotes_fecha_entrada on lotes(fecha_entrada desc);
create index idx_lotes_estado on lotes(estado);
create index idx_lotes_galpon_fecha_salida on lotes(galpon, fecha_salida)
  where fecha_salida is null;

-- Trigger para actualizar timestamp
create or replace function actualizar_timestamp_lotes()
returns trigger as $$
begin
  new.actualizado_en = now();
  return new;
end;
$$ language plpgsql;

create trigger trigger_actualizar_timestamp_lotes
before update on lotes
for each row
execute function actualizar_timestamp_lotes();
