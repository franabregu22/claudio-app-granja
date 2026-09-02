-- Update forma_pago ENUM type to include 'transferencia' and remove 'cheque' and 'echeq'
ALTER TYPE forma_pago_type RENAME TO forma_pago_type_old;

CREATE TYPE forma_pago_type AS ENUM ('efectivo', 'mercadopago', 'transferencia');

ALTER TABLE movimientos_caja
  ALTER COLUMN forma_pago TYPE forma_pago_type USING forma_pago::text::forma_pago_type;

DROP TYPE forma_pago_type_old;
