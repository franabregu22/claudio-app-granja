-- ============================================================================
-- TARGET V1 — 0008 FOUNDATION SEEDS
-- Authority: IMPLEMENTATION_DEPENDENCY_ORDER_V1.md step 5.2
--            TARGET_ARCHITECTURE_V2_FROZEN.md Parts 6, 14, 16, 20
--
-- ONLY structural/configuration seeds whose values are enumerated in the frozen
-- documents. Nothing here is business data and nothing was invented.
--
-- Idempotent: every statement is ON CONFLICT DO NOTHING, so a re-apply is a no-op.
--
-- NOT seeded, deliberately:
--   expense_category  -- the frozen documents enumerate no categories. Inventing
--                        them would be inventing business data. Purchases is a
--                        later phase and will need them then.
--   perfiles          -- real users cannot be invented. Tests create their own.
--   sheds, products, suppliers, feed_type, projects, feed_ingredient,
--   genetics_consumption_curve -- real business data.
-- ============================================================================

-- ── management_period: frozen Part 20 ──────────────────────────────────────
-- assert_period_open raises PERIOD_NOT_FOUND when a month has no row, so the
-- months that will receive facts must exist. The migration-strategy window opens
-- at 2026-01-01, so the 2026 calendar is seeded OPEN.

INSERT INTO management_period (periodo_fecha, status)
SELECT d::DATE, 'OPEN'
  FROM generate_series('2026-01-01'::DATE, '2026-12-01'::DATE, INTERVAL '1 month') AS d
ON CONFLICT (periodo_fecha) DO NOTHING;

-- ── financial_account: frozen Part 6 names exactly these four ──────────────

INSERT INTO financial_account (nombre, account_type) VALUES
  ('Caja chica',   'CASH'),
  ('Mercado Pago', 'EXTERNAL_SERVICE'),
  ('BNA',          'BANK_ACCOUNT'),
  ('Patagonia',    'BANK_ACCOUNT')
ON CONFLICT (nombre) DO NOTHING;

-- ── classification_grade: frozen Part 14 names exactly these seven ─────────

INSERT INTO classification_grade (nombre) VALUES
  ('XL'), ('N1'), ('N2'), ('N3'), ('Rotos'), ('Sucios'), ('Descarte')
ON CONFLICT (nombre) DO NOTHING;

-- ── clients: the aggregated retail counterparty required by frozen Part 16 ─
-- close_sales_session raises CONSUMIDOR_FINAL_MISSING without it. It is a
-- structural requirement named in the dependency order, not invented data.

INSERT INTO clients (nombre) VALUES ('CONSUMIDOR FINAL')
ON CONFLICT (nombre) DO NOTHING;
