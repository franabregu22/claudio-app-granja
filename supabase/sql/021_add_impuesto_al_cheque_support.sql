-- Add support for impuesto al cheque tracking
-- This allows tracking of 0.6% tax on transfers, checks, and mercadopago

alter table movimientos_caja add column if not exists aplica_impuesto_cheque boolean default false;

-- Create index for filtering impuesto al cheque movements
create index if not exists idx_movimientos_caja_impuesto on movimientos_caja(vinculado_a) where vinculado_a = 'impuesto_cheque';
