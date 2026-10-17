-- ============================================================================
-- TARGET V1 — 0096 EXPENSE CATEGORY → SUBCATEGORY (ADR-024, owner GO 2026-10-16)
--
-- Master data only: no financial operation, no historical reference rewritten (financial delta 0.00).
--   1. expense_category_group — the parent CATEGORY (nombre, activo, display_order, kind EXPENSE | OWNER_WITHDRAWAL). RLS ADMIN
--      SELECT / INSERT / UPDATE (as expense_category); no DELETE.
--   2. expense_category = the SUBCATEGORY (IDs kept): group_id (mandatory after the backfill), default_nature (pre-filled purchase
--      nature; the operation keeps its own), fiscal_reserved (IVA / Ganancias: Fiscal route only). A new subcategory takes the
--      legacy pnl_cost_class of its siblings (else INDIRECT) — DIRECT / INDIRECT is in standby and never asked — and, when a
--      legacy writer sends no parent (the pre-ADR-024 master editor), the parent "Otros".
--   3. Backfill of the authoritative map (14 groups); "Afrechillo de trigo" and "Cartones" created once when missing
--      ("Cartones" exists in production since 2026-10-16 — a real MP casual purchase — and keeps its ID and history; it is
--      only given its parent "Cartones / envases" and OPERATING); IVA / Ganancias deactivated and reserved; Santi / Fran / Padres under "Retiros de socios" (OWNER_WITHDRAWAL). Any unmapped row aborts the migration.
--   4. expense_category_selectable_guard: purchases, freight and feria cash events refuse an OWNER_WITHDRAWAL or fiscal-reserved
--      subcategory (CATEGORY_NOT_SELECTABLE); a rectification of a legacy purchase keeps its own category.
--   5. management_event.socio_category_id: the optional socio of a RETIRO (an OWNER_WITHDRAWAL subcategory);
--      register_management_event gains p_socio_category_id (DEFAULT NULL, appended: every existing call keeps working).
--   6. Every insert / update of a category or subcategory is audited (expense_category_audit, SECURITY DEFINER).
-- SECURITY DEFINER set 93 → 94 (expense_category_audit).
-- ============================================================================

-- ── 1. parent categories ────────────────────────────────────────────────────
CREATE TABLE expense_category_group (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        VARCHAR(100) NOT NULL,
  activo        BOOLEAN      NOT NULL DEFAULT true,
  display_order INTEGER      NOT NULL DEFAULT 0,
  kind          VARCHAR(20)  NOT NULL DEFAULT 'EXPENSE',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ecg_nombre CHECK (btrim(nombre) <> ''),
  CONSTRAINT chk_ecg_kind CHECK (kind IN ('EXPENSE', 'OWNER_WITHDRAWAL'))
);
CREATE UNIQUE INDEX uq_ecg_nombre ON expense_category_group (lower(btrim(nombre)));
ALTER TABLE expense_category_group ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE expense_category_group FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE expense_category_group TO authenticated;
CREATE POLICY expense_category_group_admin_select ON expense_category_group FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY expense_category_group_admin_insert ON expense_category_group FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY expense_category_group_admin_update ON expense_category_group FOR UPDATE USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

-- ── 2. subcategory columns ──────────────────────────────────────────────────
ALTER TABLE expense_category
  ADD COLUMN group_id        UUID REFERENCES expense_category_group(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN default_nature  purchase_nature,
  ADD COLUMN fiscal_reserved BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_expense_category_group ON expense_category(group_id);

-- a new subcategory without a parent goes to "Otros" (legacy writers); without a legacy class it takes its siblings'
-- (DIRECT / INDIRECT is in standby: never asked)
CREATE OR REPLACE FUNCTION expense_category_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.group_id IS NULL THEN
    SELECT id INTO NEW.group_id FROM expense_category_group WHERE nombre = 'Otros';
  END IF;
  IF NEW.pnl_cost_class IS NULL THEN
    SELECT c.pnl_cost_class INTO NEW.pnl_cost_class FROM expense_category c
     WHERE c.group_id = NEW.group_id AND c.group_id IS NOT NULL
     GROUP BY c.pnl_cost_class ORDER BY count(*) DESC, c.pnl_cost_class LIMIT 1;
    NEW.pnl_cost_class := coalesce(NEW.pnl_cost_class, 'INDIRECT');
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION expense_category_defaults() OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_category_defaults() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_expense_category_defaults BEFORE INSERT ON expense_category
  FOR EACH ROW EXECUTE FUNCTION expense_category_defaults();

-- ── 3. the authoritative map ────────────────────────────────────────────────
INSERT INTO expense_category_group (nombre, display_order, kind) VALUES
  ('Insumos alimento balanceado', 1, 'EXPENSE'), ('Cartones / envases', 2, 'EXPENSE'), ('Mano de obra', 3, 'EXPENSE'),
  ('Retiros de socios', 4, 'OWNER_WITHDRAWAL'), ('Combustible', 5, 'EXPENSE'), ('Servicios', 6, 'EXPENSE'),
  ('Materiales / Repuestos', 7, 'EXPENSE'), ('Logística / Fletes', 8, 'EXPENSE'), ('Impuestos y tasas', 9, 'EXPENSE'),
  ('Insumos varios', 10, 'EXPENSE'), ('Otros', 11, 'EXPENSE'), ('Créditos', 12, 'EXPENSE'), ('Recria', 13, 'EXPENSE'),
  ('Feria', 14, 'EXPENSE');

INSERT INTO expense_category (nombre, activo, pnl_cost_class, group_id, default_nature)
SELECT 'Afrechillo de trigo', true, 'DIRECT', g.id, 'OPERATING' FROM expense_category_group g
 WHERE g.nombre = 'Insumos alimento balanceado' AND NOT EXISTS (SELECT 1 FROM expense_category WHERE nombre = 'Afrechillo de trigo');
INSERT INTO expense_category (nombre, activo, pnl_cost_class, group_id, default_nature)
SELECT 'Cartones', true, 'DIRECT', g.id, 'OPERATING' FROM expense_category_group g
 WHERE g.nombre = 'Cartones / envases' AND NOT EXISTS (SELECT 1 FROM expense_category WHERE nombre = 'Cartones');

WITH m (grupo, sub, nature) AS (VALUES
  ('Insumos alimento balanceado', 'Sal', 'OPERATING'), ('Insumos alimento balanceado', 'Metionina', 'OPERATING'),
  ('Insumos alimento balanceado', 'Nucleo Brower con Fitasas', 'OPERATING'), ('Insumos alimento balanceado', 'Ciromazina', 'OPERATING'),
  ('Insumos alimento balanceado', 'Conchilla', 'OPERATING'), ('Insumos alimento balanceado', 'Maiz', 'OPERATING'),
  ('Insumos alimento balanceado', 'Expeller de Soja', 'OPERATING'), ('Insumos alimento balanceado', 'Harina de carne', 'OPERATING'),
  ('Insumos alimento balanceado', 'Secuestrante Micotoxinas', 'OPERATING'), ('Insumos alimento balanceado', 'Compras viejas', 'OPERATING'),
  ('Insumos alimento balanceado', 'Carbonato de calcio', 'OPERATING'), ('Insumos alimento balanceado', 'Afrechillo de trigo', 'OPERATING'),
  ('Cartones / envases', 'Manga x125U - Maples30u', 'OPERATING'), ('Cartones / envases', 'Manga x125U - Maples20u', 'OPERATING'),
  ('Cartones / envases', 'Manga x125U - Docenas', 'OPERATING'), ('Cartones / envases', 'Cartones', 'OPERATING'),
  ('Mano de obra', 'Sueldos empleados', 'OPERATING'), ('Mano de obra', 'Jornales', 'OPERATING'), ('Mano de obra', 'Horas extra', 'OPERATING'),
  ('Mano de obra', 'Trabajos chacra', 'OPERATING'),
  ('Retiros de socios', 'Santi', NULL), ('Retiros de socios', 'Fran', NULL), ('Retiros de socios', 'Padres', NULL),
  ('Combustible', 'Gasoil', 'OPERATING'), ('Combustible', 'Nafta', 'OPERATING'),
  ('Servicios', 'Electricidad', 'OPERATING'), ('Servicios', 'Canon de riego', 'OPERATING'), ('Servicios', 'Telefonía / Internet', 'OPERATING'),
  ('Servicios', 'Otros servicios', 'OPERATING'), ('Servicios', 'Contador', 'OPERATING'), ('Servicios', 'Veterinario', 'OPERATING'),
  ('Materiales / Repuestos', 'Repuestos', 'REINVESTMENT'), ('Materiales / Repuestos', 'Herramientas', 'REINVESTMENT'),
  ('Materiales / Repuestos', 'Materiales', 'OPERATING'), ('Materiales / Repuestos', 'Arreglos edilicios', 'INVESTMENT'),
  ('Materiales / Repuestos', 'Servicios técnicos', 'REINVESTMENT'),
  ('Logística / Fletes', 'Flete Insumos balanceado', 'OPERATING'), ('Logística / Fletes', 'Flete Varios', 'OPERATING'),
  ('Logística / Fletes', 'Flete Cartones', 'OPERATING'), ('Logística / Fletes', 'Flete Guano', 'OPERATING'),
  ('Impuestos y tasas', 'Monotributo', 'OPERATING'), ('Impuestos y tasas', 'Comisiones', 'OPERATING'), ('Impuestos y tasas', 'Otros impuestos', 'OPERATING'),
  ('Impuestos y tasas', 'IVA', NULL), ('Impuestos y tasas', 'Ganancias', NULL),   -- fiscal_reserved (Fiscal route), deactivated
  ('Insumos varios', 'Agua potable', 'OPERATING'), ('Insumos varios', 'Gas', 'OPERATING'), ('Insumos varios', 'Medicamentos', 'OPERATING'),
  ('Insumos varios', 'Otros', 'OPERATING'), ('Insumos varios', 'Chacra', 'OPERATING'),
  ('Otros', 'Gastos no clasificados', 'OPERATING'),
  ('Créditos', 'ProPAV', 'OPERATING'),   -- owner simplification: each installment is an ordinary expense
  ('Recria', 'Pollitas BB', 'INVESTMENT'),
  ('Feria', 'Gastos de Feria', 'OPERATING')
)
UPDATE expense_category c
   SET group_id = g.id, default_nature = m.nature::purchase_nature
  FROM m JOIN expense_category_group g ON g.nombre = m.grupo
 WHERE c.nombre = m.sub;
UPDATE expense_category SET fiscal_reserved = true, activo = false WHERE nombre IN ('IVA', 'Ganancias');

DO $$
DECLARE v_unmapped TEXT; v_missing INTEGER;
BEGIN
  SELECT string_agg(nombre, ', ' ORDER BY nombre) INTO v_unmapped FROM expense_category WHERE group_id IS NULL;
  IF v_unmapped IS NOT NULL THEN
    RAISE EXCEPTION 'EXPENSE_CATEGORY_UNMAPPED: % (owner decision required; nothing changed)', v_unmapped;
  END IF;
  SELECT count(*) INTO v_missing FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id
   WHERE g.kind = 'EXPENSE' AND NOT c.fiscal_reserved AND c.default_nature IS NULL;
  IF v_missing > 0 OR (SELECT count(*) FROM expense_category_group) <> 14 THEN
    RAISE EXCEPTION 'EXPENSE_CATEGORY_BACKFILL_INCOMPLETE: % expense subcategories without default nature', v_missing;
  END IF;
END $$;
ALTER TABLE expense_category ALTER COLUMN group_id SET NOT NULL;

-- ── 4. reserved subcategories are not selectable for new operations ─────────
CREATE OR REPLACE FUNCTION expense_category_selectable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_kind     TEXT;
  v_reserved BOOLEAN;
  v_name     TEXT;
  v_prev     UUID;
BEGIN
  IF NEW.expense_category_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT g.kind, c.fiscal_reserved, c.nombre INTO v_kind, v_reserved, v_name
    FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id WHERE c.id = NEW.expense_category_id;
  IF v_kind = 'OWNER_WITHDRAWAL' OR v_reserved THEN
    -- a rectification of a legacy purchase keeps its own category ('RECTIFY:<purchase id>:v<n>')
    IF TG_TABLE_NAME = 'purchases' AND NEW.idempotency_key ~ '^RECTIFY:[0-9a-f-]{36}:v[0-9]+$' THEN
      SELECT p.expense_category_id INTO v_prev FROM purchases p WHERE p.id = split_part(NEW.idempotency_key, ':', 2)::UUID;
      IF v_prev = NEW.expense_category_id THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'CATEGORY_NOT_SELECTABLE: % — %', v_name,
      CASE WHEN v_kind = 'OWNER_WITHDRAWAL' THEN 'usá Retiro de socios' ELSE 'usá la ruta Fiscal' END;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION expense_category_selectable_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_category_selectable_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_purchases_category_selectable BEFORE INSERT ON purchases
  FOR EACH ROW EXECUTE FUNCTION expense_category_selectable_guard();
CREATE TRIGGER trg_freight_category_selectable BEFORE INSERT ON freight
  FOR EACH ROW EXECUTE FUNCTION expense_category_selectable_guard();
CREATE TRIGGER trg_session_cash_event_category_selectable BEFORE INSERT ON sales_session_cash_event
  FOR EACH ROW EXECUTE FUNCTION expense_category_selectable_guard();

-- ── 6. audit of every category / subcategory change ─────────────────────────
CREATE OR REPLACE FUNCTION expense_category_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES (TG_TABLE_NAME, NEW.id::TEXT, CASE TG_OP WHEN 'INSERT' THEN 'CREATE' ELSE 'UPDATE' END,
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW), 'ADR-024 category administration', auth.uid());
  RETURN NEW;
END;
$$;
ALTER FUNCTION expense_category_audit() OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_category_audit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_expense_category_audit AFTER INSERT OR UPDATE ON expense_category
  FOR EACH ROW EXECUTE FUNCTION expense_category_audit();
CREATE TRIGGER trg_expense_category_group_audit AFTER INSERT OR UPDATE ON expense_category_group
  FOR EACH ROW EXECUTE FUNCTION expense_category_audit();

-- ── 5. the optional socio of a withdrawal ───────────────────────────────────
ALTER TABLE management_event ADD COLUMN socio_category_id UUID REFERENCES expense_category(id) ON DELETE RESTRICT ON UPDATE CASCADE;

DROP FUNCTION register_management_event(management_event_type, DATE, NUMERIC, VARCHAR, TEXT, UUID, UUID);
CREATE OR REPLACE FUNCTION register_management_event(
  p_event_type           management_event_type,
  p_effective_date       DATE,
  p_amount               NUMERIC,
  p_idempotency_key      VARCHAR,
  p_reason               TEXT,
  p_financial_account_id UUID DEFAULT NULL,
  p_compensates_event_id UUID DEFAULT NULL,
  p_socio_category_id    UUID DEFAULT NULL   -- [0096] ADR-024: Santi / Fran / Padres (OWNER_WITHDRAWAL subcategory), optional
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_event_id     UUID := gen_random_uuid();
  v_original     management_event;
  v_compensated  NUMERIC(15,2);
  v_account      UUID := p_financial_account_id;
  v_operation_id BIGINT := NULL;
  v_sign         INTEGER := -1;
  v_socio        UUID := p_socio_category_id;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_event_type IS NULL THEN
    RAISE EXCEPTION 'INVALID_EVENT_TYPE';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 95 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 95 characters required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a management decision must be explained';
  END IF;
  IF EXISTS (SELECT 1 FROM management_event WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_MANAGEMENT_EVENT';
  END IF;
  -- [0096] the socio is a RETIRO dimension only, one of the OWNER_WITHDRAWAL subcategories
  IF v_socio IS NOT NULL THEN
    IF p_event_type <> 'RETIRO' THEN
      RAISE EXCEPTION 'SOCIO_NOT_ALLOWED: only a Retiro de socios carries a socio';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id
                    WHERE c.id = v_socio AND g.kind = 'OWNER_WITHDRAWAL') THEN
      RAISE EXCEPTION 'INVALID_SOCIO: not a Retiro de socios subcategory';
    END IF;
  END IF;

  IF p_compensates_event_id IS NOT NULL THEN
    SELECT * INTO v_original FROM management_event WHERE id = p_compensates_event_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'EVENT_NOT_FOUND';
    END IF;
    IF v_original.compensates_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_COMPENSATION_TARGET: a compensation cannot itself be compensated';
    END IF;
    IF v_original.event_type <> p_event_type THEN
      RAISE EXCEPTION 'COMPENSATION_TYPE_MISMATCH';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO v_compensated
      FROM management_event WHERE compensates_event_id = p_compensates_event_id;
    IF v_compensated + p_amount > v_original.amount THEN
      RAISE EXCEPTION 'COMPENSATION_EXCEEDS_ORIGINAL: compensating % exceeds the outstanding % of the original',
        p_amount, v_original.amount - v_compensated;
    END IF;
    IF p_event_type = 'RETIRO' THEN
      IF v_account IS NULL THEN
        v_account := v_original.financial_account_id;
      ELSIF v_account <> v_original.financial_account_id THEN
        RAISE EXCEPTION 'ACCOUNT_MISMATCH: a RETIRO compensation returns money to the original account';
      END IF;
    END IF;
    v_socio := coalesce(v_socio, v_original.socio_category_id);   -- [0096] a compensation belongs to the same socio
    v_sign := 1;
  END IF;

  IF p_event_type = 'RETIRO' AND v_account IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_REQUIRED: a RETIRO moves money out of a financial account';
  END IF;
  IF p_event_type = 'RESERVA_INTERNA' AND v_account IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_ALLOWED: a RESERVA_INTERNA moves no money';
  END IF;

  PERFORM assert_period_open(p_effective_date);

  IF p_event_type = 'RETIRO' THEN
    BEGIN
      INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                                       source_entity_type, source_entity_id, reason, created_by)
      VALUES ('OWNER_WITHDRAWAL', p_effective_date, 'MGMT:' || p_idempotency_key,
              'management_event', v_event_id::TEXT, p_reason, v_uid)
      RETURNING id INTO v_operation_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'DUPLICATE_MANAGEMENT_EVENT';
    END;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount,
                                   effective_date, created_by)
    VALUES (v_operation_id, v_account, v_sign * p_amount, p_effective_date, v_uid);
  END IF;

  BEGIN
    INSERT INTO management_event (id, event_type, effective_date, amount, compensates_event_id,
                                  financial_account_id, financial_operation_id, idempotency_key,
                                  reason, created_by, socio_category_id)
    VALUES (v_event_id, p_event_type, p_effective_date, p_amount, p_compensates_event_id,
            v_account, v_operation_id, p_idempotency_key, p_reason, v_uid, v_socio);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_MANAGEMENT_EVENT';
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('management_event', v_event_id::TEXT,
          CASE WHEN p_compensates_event_id IS NULL THEN 'CREATE' ELSE 'COMPENSATE' END,
          jsonb_build_object('event_type', p_event_type, 'effective_date', p_effective_date,
                             'amount', p_amount, 'compensates_event_id', p_compensates_event_id,
                             'financial_account_id', v_account, 'financial_operation_id', v_operation_id,
                             'socio_category_id', v_socio),
          p_reason, v_uid);

  RETURN jsonb_build_object('management_event_id', v_event_id, 'financial_operation_id', v_operation_id);
END;
$$;
ALTER  FUNCTION register_management_event(management_event_type, DATE, NUMERIC, VARCHAR, TEXT, UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_management_event(management_event_type, DATE, NUMERIC, VARCHAR, TEXT, UUID, UUID, UUID) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_management_event(management_event_type, DATE, NUMERIC, VARCHAR, TEXT, UUID, UUID, UUID) TO authenticated;
