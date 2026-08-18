-- Add factura URL and IVA fields to movimientos_caja
alter table movimientos_caja add column if not exists es_facturada boolean default false;
alter table movimientos_caja add column if not exists alicuota_iva numeric default 0;
alter table movimientos_caja add column if not exists monto_iva numeric default 0;
alter table movimientos_caja add column if not exists url_factura text;

-- Create index for filtering facturados
create index if not exists idx_movimientos_caja_facturada on movimientos_caja(es_facturada);
