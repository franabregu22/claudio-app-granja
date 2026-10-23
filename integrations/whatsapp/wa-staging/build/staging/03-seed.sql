-- ADR-025 §18 — staging seed (synthetic data only). psql variables (Auth user ids from .staging-users.json, test phones E.164):
--   admin_a admin_b oper gw   phone_a phone_b phone_oper
-- Catalog / supplier ids are fixed so the test suite can address them in both builds.
SET LOCAL search_path = sim, public, pg_temp;
INSERT INTO sim.perfiles (id, email, rol_type) VALUES
  (:'admin_a', 'admin-a@staging.invalid', 'ADMIN'), (:'admin_b', 'admin-b@staging.invalid', 'ADMIN'), (:'oper', 'oper@staging.invalid', 'OPERATOR');
INSERT INTO sim.expense_category_group (id, nombre, kind, display_order) VALUES
  ('aaaaaaaa-0025-0000-0000-0000000000b1', 'Operación', 'EXPENSE', 1), ('aaaaaaaa-0025-0000-0000-0000000000b2', 'Retiros', 'OWNER_WITHDRAWAL', 9);
INSERT INTO sim.expense_category (id, nombre, group_id, pnl_cost_class, default_nature, fiscal_reserved) VALUES
  ('aaaaaaaa-0025-0000-0000-0000000000c1', 'Insumos', 'aaaaaaaa-0025-0000-0000-0000000000b1', 'INDIRECT', 'OPERATING', false),
  ('aaaaaaaa-0025-0000-0000-0000000000c2', 'IVA (reservada)', 'aaaaaaaa-0025-0000-0000-0000000000b1', 'INDIRECT', 'OPERATING', true),
  ('aaaaaaaa-0025-0000-0000-0000000000c3', 'Retiro socio', 'aaaaaaaa-0025-0000-0000-0000000000b2', NULL, 'OPERATING', false);
INSERT INTO sim.financial_account (nombre, account_type) VALUES ('Caja chica', 'CASH'), ('BNA', 'BANK_ACCOUNT'), ('Mercado Pago', 'EXTERNAL_SERVICE');
INSERT INTO sim.suppliers (id, nombre) VALUES ('aaaaaaaa-0025-0000-0000-0000000000a1', 'Proveedor staging');
-- two pending outflows: 1,000.00 and 2,500.00 on 2026-10-20
INSERT INTO sim.mp_pending_outflow (pending_key, source_id, kind, business_date, amount, economic_amount, account_name, description) VALUES
  ('OUT:930000025001', '930000025001', 'OUTBOUND', '2026-10-20', -1006.00, 1000.00, 'Mercado Pago', 'payment'),
  ('OUT:930000025002', '930000025002', 'OUTBOUND', '2026-10-20', -2515.00, 2500.00, 'Mercado Pago', 'payment');
INSERT INTO wa.sender (phone_e164, perfil_id) VALUES (:'phone_a', :'admin_a'), (:'phone_b', :'admin_b'), (:'phone_oper', :'oper');
INSERT INTO wa.config (gateway_user_id, enabled) VALUES (:'gw', true);
INSERT INTO sim.expense_category (id, nombre, group_id, pnl_cost_class, default_nature, fiscal_reserved) VALUES
  ('aaaaaaaa-0025-0000-0000-0000000000c4', 'Combustible', 'aaaaaaaa-0025-0000-0000-0000000000b1', 'INDIRECT', 'OPERATING', false),
  ('aaaaaaaa-0025-0000-0000-0000000000c5', 'Limpieza', 'aaaaaaaa-0025-0000-0000-0000000000b1', 'INDIRECT', 'OPERATING', false),
  ('aaaaaaaa-0025-0000-0000-0000000000c6', 'Mantenimiento', 'aaaaaaaa-0025-0000-0000-0000000000b1', 'INDIRECT', 'OPERATING', false)
ON CONFLICT (id) DO NOTHING;
