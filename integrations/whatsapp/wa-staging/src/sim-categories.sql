-- ADR-025 §18 — fictitious staging categories (sim ONLY; the ERP catalog is never touched). Idempotent.
INSERT INTO sim.expense_category (id, nombre, group_id, pnl_cost_class, default_nature, fiscal_reserved) VALUES
  ('aaaaaaaa-0025-0000-0000-0000000000c4', 'Combustible', 'aaaaaaaa-0025-0000-0000-0000000000b1', 'INDIRECT', 'OPERATING', false),
  ('aaaaaaaa-0025-0000-0000-0000000000c5', 'Limpieza', 'aaaaaaaa-0025-0000-0000-0000000000b1', 'INDIRECT', 'OPERATING', false),
  ('aaaaaaaa-0025-0000-0000-0000000000c6', 'Mantenimiento', 'aaaaaaaa-0025-0000-0000-0000000000b1', 'INDIRECT', 'OPERATING', false)
ON CONFLICT (id) DO NOTHING;
