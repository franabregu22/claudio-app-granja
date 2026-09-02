-- Delete all egresos (expense test data)
DELETE FROM movimientos_caja WHERE tipo = 'egreso';

-- Add columns for expense planning: estimated payment date, cheque flag, and echeq proof link
ALTER TABLE movimientos_caja ADD COLUMN es_cheque boolean NOT NULL DEFAULT false;
ALTER TABLE movimientos_caja ADD COLUMN fecha_pago_estimada date;
ALTER TABLE movimientos_caja ADD COLUMN url_echeq text;
