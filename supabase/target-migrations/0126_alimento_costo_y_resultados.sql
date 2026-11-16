-- ============================================================================
-- TARGET V1 — 0126 ALIMENTO BALANCEADO: COSTO POR KG Y ESTADO DE RESULTADOS
-- (alimento-balanceado-v1, owner decisions 2026-11-16)
--
--   Owner rule: purchases of feed ingredients and their freight are NOT P&L
--   expenses; the P&L expense is the feed CONSUMED × its cost per kg. Cash and
--   bank balances are untouched (payments stay exactly as they are).
--   In force from feed_cost_start() = 2026-11-01; earlier months keep the
--   purchases as expenses. Stock at 31/10/2026 is zero (initial load, not here).
--
--   * expense_category.feed_ingredient_id / is_feed_freight: the categories that
--     ARE an ingredient (e.g. "Expeller de Soja") or feed freight ("Flete Insumos
--     balanceado"). Set by ADMIN through set_expense_category_feed (audited).
--   * feed_purchase_quantity: kg of an ingredient purchase (per purchase chain)
--     and the "no freight" confirmation. RPC set_feed_purchase_quantity.
--   * feed_freight_allocation: a feed-freight purchase split over ingredient
--     purchases (by kg or by hand, decided by the caller). RPC allocate_feed_freight.
--   * Reports (ADMIN): report_feed_purchase, report_feed_freight,
--     report_feed_ingredient_cost_month, report_feed_recipe_cost_month,
--     report_feed_consumption_cost.
--   * pnl_line_item (copied from 0124, three filters + one branch):
--       - ingredient / feed-freight purchases from feed_cost_start(): excluded;
--       - freight (freight table) allocated to such purchases, and unallocated
--         freight of a feed-freight category, from feed_cost_start(): excluded;
--       - NEW COSTOS_DIRECTOS lines "Alimento consumido — <receta>" per closed
--         month from feed_cost_start(): consumption × recipe cost per kg.
--   Cost basis (owner 2026-11-16): a purchase with Factura A costs its amount without VAT
--   (amount_net), any other its total; allocated freight likewise.
--   No data is written by this migration.
-- ============================================================================

CREATE FUNCTION feed_cost_start() RETURNS DATE LANGUAGE sql IMMUTABLE AS $$ SELECT DATE '2026-11-01' $$;
ALTER  FUNCTION feed_cost_start() OWNER TO postgres;
REVOKE ALL     ON FUNCTION feed_cost_start() FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION feed_cost_start() TO authenticated;

-- ── categorías de gasto: insumo / flete de insumos ──────────────────────────
ALTER TABLE expense_category
  ADD COLUMN feed_ingredient_id UUID REFERENCES feed_ingredient(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN is_feed_freight    BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT chk_expense_category_feed_role CHECK (NOT (feed_ingredient_id IS NOT NULL AND is_feed_freight));

CREATE FUNCTION set_expense_category_feed(p_category_id UUID, p_feed_ingredient_id UUID, p_is_feed_freight BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_old expense_category;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_is_feed_freight IS NULL OR (p_feed_ingredient_id IS NOT NULL AND p_is_feed_freight) THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;
  SELECT * INTO v_old FROM expense_category WHERE id = p_category_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CATEGORY_NOT_FOUND';
  END IF;
  IF p_feed_ingredient_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM feed_ingredient WHERE id = p_feed_ingredient_id) THEN
    RAISE EXCEPTION 'INGREDIENT_NOT_FOUND';
  END IF;
  IF v_old.feed_ingredient_id IS NOT DISTINCT FROM p_feed_ingredient_id AND v_old.is_feed_freight = p_is_feed_freight THEN
    RAISE EXCEPTION 'NO_CHANGES';
  END IF;
  UPDATE expense_category SET feed_ingredient_id = p_feed_ingredient_id, is_feed_freight = p_is_feed_freight WHERE id = v_old.id;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, performed_by)
  VALUES ('expense_category', v_old.id::TEXT, 'FEED_ROLE',
          jsonb_build_object('feed_ingredient_id', v_old.feed_ingredient_id, 'is_feed_freight', v_old.is_feed_freight),
          jsonb_build_object('feed_ingredient_id', p_feed_ingredient_id, 'is_feed_freight', p_is_feed_freight), v_uid);
  RETURN jsonb_build_object('category_id', v_old.id, 'feed_ingredient_id', p_feed_ingredient_id, 'is_feed_freight', p_is_feed_freight);
END;
$$;
ALTER  FUNCTION set_expense_category_feed(UUID, UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL     ON FUNCTION set_expense_category_feed(UUID, UUID, BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION set_expense_category_feed(UUID, UUID, BOOLEAN) TO authenticated;

-- ── kg de una compra de insumo + "sin flete" ────────────────────────────────
CREATE TABLE feed_purchase_quantity (
  purchase_root_id UUID PRIMARY KEY REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  quantity_kg      NUMERIC(15,3) NOT NULL CONSTRAINT chk_feed_purchase_quantity_kg CHECK (quantity_kg > 0),
  no_freight       BOOLEAN NOT NULL DEFAULT false,
  updated_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE feed_purchase_quantity OWNER TO postgres;
ALTER TABLE feed_purchase_quantity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON feed_purchase_quantity FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON feed_purchase_quantity TO authenticated;
CREATE POLICY feed_purchase_quantity_admin_select ON feed_purchase_quantity FOR SELECT USING (current_app_role() = 'ADMIN');

-- p_no_freight NULL keeps the current flag
CREATE FUNCTION set_feed_purchase_quantity(p_purchase_id UUID, p_quantity_kg NUMERIC, p_no_freight BOOLEAN DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_root UUID;
  v_pu   purchases;
  v_old  feed_purchase_quantity;
  v_nf   BOOLEAN;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_quantity_kg IS NULL OR p_quantity_kg <= 0 OR p_quantity_kg <> round(p_quantity_kg, 3) OR p_quantity_kg >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  SELECT * INTO v_pu FROM purchases WHERE id = p_purchase_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  v_root := purchase_chain_root(p_purchase_id);
  SELECT * INTO v_pu FROM purchases WHERE purchase_chain_root(id) = v_root AND is_current;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = v_root) THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM expense_category WHERE id = v_pu.expense_category_id AND feed_ingredient_id IS NOT NULL) THEN
    RAISE EXCEPTION 'NOT_A_FEED_PURCHASE';
  END IF;
  SELECT * INTO v_old FROM feed_purchase_quantity WHERE purchase_root_id = v_root FOR UPDATE;
  v_nf := COALESCE(p_no_freight, v_old.no_freight, false);
  IF v_nf AND EXISTS (SELECT 1 FROM feed_freight_allocation WHERE purchase_root_id = v_root) THEN
    RAISE EXCEPTION 'FREIGHT_ALREADY_ALLOCATED';
  END IF;
  INSERT INTO feed_purchase_quantity (purchase_root_id, quantity_kg, no_freight, updated_by, updated_at)
  VALUES (v_root, p_quantity_kg, v_nf, v_uid, NOW())
  ON CONFLICT (purchase_root_id) DO UPDATE SET quantity_kg = EXCLUDED.quantity_kg, no_freight = EXCLUDED.no_freight,
                                               updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, performed_by)
  VALUES ('feed_purchase_quantity', v_root::TEXT, CASE WHEN v_old.purchase_root_id IS NULL THEN 'CREATE' ELSE 'UPDATE' END,
          CASE WHEN v_old.purchase_root_id IS NULL THEN NULL ELSE jsonb_build_object('quantity_kg', v_old.quantity_kg, 'no_freight', v_old.no_freight) END,
          jsonb_build_object('quantity_kg', p_quantity_kg, 'no_freight', v_nf), v_uid);
  RETURN jsonb_build_object('purchase_root_id', v_root, 'quantity_kg', p_quantity_kg, 'no_freight', v_nf);
END;
$$;

-- ── flete de insumos repartido entre compras ────────────────────────────────
CREATE TABLE feed_freight_allocation (
  id                       BIGSERIAL PRIMARY KEY,
  freight_purchase_root_id UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  purchase_root_id         UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                   NUMERIC(15,2) NOT NULL CONSTRAINT chk_feed_freight_allocation_amount CHECK (amount > 0),
  allocated_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  allocated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (freight_purchase_root_id, purchase_root_id)
);
ALTER TABLE feed_freight_allocation OWNER TO postgres;
ALTER TABLE feed_freight_allocation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON feed_freight_allocation FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON feed_freight_allocation TO authenticated;
CREATE POLICY feed_freight_allocation_admin_select ON feed_freight_allocation FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE INDEX idx_feed_freight_allocation_purchase ON feed_freight_allocation (purchase_root_id);

ALTER  FUNCTION set_feed_purchase_quantity(UUID, NUMERIC, BOOLEAN) OWNER TO postgres;
REVOKE ALL     ON FUNCTION set_feed_purchase_quantity(UUID, NUMERIC, BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION set_feed_purchase_quantity(UUID, NUMERIC, BOOLEAN) TO authenticated;

-- p_allocations: [{purchase_id, amount}] — ingredient purchases with kg; their sum ≤ what is left of the freight
CREATE FUNCTION allocate_feed_freight(p_freight_purchase_id UUID, p_allocations JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_froot     UUID;
  v_freight   purchases;
  v_a         JSONB;
  v_root      UUID;
  v_amount    NUMERIC;
  v_sum       NUMERIC := 0;
  v_seen      UUID[] := '{}';
  v_left      NUMERIC;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM purchases WHERE id = p_freight_purchase_id) THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  v_froot := purchase_chain_root(p_freight_purchase_id);
  PERFORM pg_advisory_xact_lock(hashtext('feed_freight_allocation'), hashtext(v_froot::TEXT));
  SELECT * INTO v_freight FROM purchases WHERE purchase_chain_root(id) = v_froot AND is_current;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = v_froot) THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM expense_category WHERE id = v_freight.expense_category_id AND is_feed_freight) THEN
    RAISE EXCEPTION 'NOT_A_FEED_FREIGHT';
  END IF;
  IF p_allocations IS NULL OR jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'EMPTY_LINE_SET';
  END IF;

  FOR v_a IN SELECT value FROM jsonb_array_elements(p_allocations) LOOP
    v_amount := (v_a->>'amount')::NUMERIC;
    IF (v_a->>'purchase_id') IS NULL OR NOT EXISTS (SELECT 1 FROM purchases WHERE id = (v_a->>'purchase_id')::UUID) THEN
      RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
    END IF;
    v_root := purchase_chain_root((v_a->>'purchase_id')::UUID);
    IF v_root = ANY (v_seen) THEN
      RAISE EXCEPTION 'DUPLICATE_PURCHASE';
    END IF;
    v_seen := v_seen || v_root;
    IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> round(v_amount, 2) THEN
      RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM purchases pu JOIN expense_category ec ON ec.id = pu.expense_category_id
                    WHERE purchase_chain_root(pu.id) = v_root AND pu.is_current AND ec.feed_ingredient_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = v_root) THEN
      RAISE EXCEPTION 'NOT_A_FEED_PURCHASE';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM feed_purchase_quantity WHERE purchase_root_id = v_root) THEN
      RAISE EXCEPTION 'FEED_PURCHASE_KG_REQUIRED';
    END IF;
    IF EXISTS (SELECT 1 FROM feed_purchase_quantity WHERE purchase_root_id = v_root AND no_freight) THEN
      RAISE EXCEPTION 'FEED_PURCHASE_NO_FREIGHT';
    END IF;
    IF EXISTS (SELECT 1 FROM feed_freight_allocation WHERE freight_purchase_root_id = v_froot AND purchase_root_id = v_root) THEN
      RAISE EXCEPTION 'ALREADY_ALLOCATED';
    END IF;
    v_sum := v_sum + v_amount;
  END LOOP;

  v_left := v_freight.amount_total - COALESCE((SELECT SUM(amount) FROM feed_freight_allocation WHERE freight_purchase_root_id = v_froot), 0);
  IF v_sum > v_left THEN
    RAISE EXCEPTION 'OVER_ALLOCATION: quedan % del flete', v_left;
  END IF;

  FOR v_a IN SELECT value FROM jsonb_array_elements(p_allocations) LOOP
    INSERT INTO feed_freight_allocation (freight_purchase_root_id, purchase_root_id, amount, allocated_by)
    VALUES (v_froot, purchase_chain_root((v_a->>'purchase_id')::UUID), (v_a->>'amount')::NUMERIC, v_uid);
  END LOOP;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, performed_by)
  VALUES ('feed_freight_allocation', v_froot::TEXT, 'ALLOCATE', jsonb_build_object('allocations', p_allocations, 'total', v_sum), v_uid);

  RETURN jsonb_build_object('freight_purchase_root_id', v_froot, 'allocated', v_sum, 'remaining', v_left - v_sum);
END;
$$;
ALTER  FUNCTION allocate_feed_freight(UUID, JSONB) OWNER TO postgres;
REVOKE ALL     ON FUNCTION allocate_feed_freight(UUID, JSONB) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION allocate_feed_freight(UUID, JSONB) TO authenticated;

-- ── reportes de costo (ADMIN) ───────────────────────────────────────────────
-- current, non-annulled purchases of an ingredient category; freight: allocated freight of
-- current, non-annulled feed-freight purchases. Cost basis (owner 2026-11-16): a purchase with
-- Factura A costs its amount WITHOUT VAT (amount_net); any other, its total. Allocated freight is
-- costed the same way (its share × net/total of the freight purchase when that one has Factura A).
CREATE VIEW report_feed_purchase
WITH (security_invoker = true)
AS
SELECT r.root AS purchase_root_id, pu.id AS purchase_id, pu.economic_date, date_trunc('month', pu.economic_date)::DATE AS period,
       ec.feed_ingredient_id, fi.nombre AS ingredient_nombre, ec.id AS expense_category_id,
       COALESCE(s.nombre, pu.counterparty_name) AS supplier_name,
       pu.amount_total, (fd.document_type = 'INVOICE_A') IS TRUE AS invoice_a,
       CASE WHEN fd.document_type = 'INVOICE_A' THEN pu.amount_net ELSE pu.amount_total END AS cost_amount,
       q.quantity_kg, COALESCE(q.no_freight, false) AS no_freight,
       COALESCE(fr.freight, 0) AS freight_amount,
       COALESCE(fr.freight_cost, 0) AS freight_cost,
       CASE WHEN COALESCE(fr.freight, 0) > 0 THEN 'ASIGNADO' WHEN q.no_freight THEN 'SIN_FLETE' ELSE 'PENDIENTE' END AS freight_status,
       CASE WHEN q.quantity_kg IS NULL THEN NULL
            ELSE round(CASE WHEN fd.document_type = 'INVOICE_A' THEN pu.amount_net ELSE pu.amount_total END / q.quantity_kg, 4) END AS price_per_kg,
       CASE WHEN q.quantity_kg IS NULL THEN NULL
            ELSE round((CASE WHEN fd.document_type = 'INVOICE_A' THEN pu.amount_net ELSE pu.amount_total END + COALESCE(fr.freight_cost, 0))
                       / q.quantity_kg, 4) END AS cost_per_kg
  FROM purchases pu
  JOIN expense_category ec ON ec.id = pu.expense_category_id AND ec.feed_ingredient_id IS NOT NULL
  JOIN feed_ingredient fi ON fi.id = ec.feed_ingredient_id
 CROSS JOIN LATERAL (SELECT purchase_chain_root(pu.id) AS root) r
  LEFT JOIN fiscal_document fd ON fd.id = pu.fiscal_document_id
  LEFT JOIN suppliers s ON s.id = pu.supplier_id
  LEFT JOIN feed_purchase_quantity q ON q.purchase_root_id = r.root
  LEFT JOIN LATERAL (
    SELECT SUM(fa.amount) AS freight,
           SUM(CASE WHEN ffd.document_type = 'INVOICE_A' AND f.amount_total > 0 THEN round(fa.amount * f.amount_net / f.amount_total, 2)
                    ELSE fa.amount END) AS freight_cost
      FROM feed_freight_allocation fa
      JOIN purchases f ON purchase_chain_root(f.id) = fa.freight_purchase_root_id AND f.is_current
      LEFT JOIN fiscal_document ffd ON ffd.id = f.fiscal_document_id
     WHERE fa.purchase_root_id = r.root
       AND NOT EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = fa.freight_purchase_root_id)) fr ON true
 WHERE pu.is_current
   AND NOT EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = r.root)
   AND (SELECT current_app_role()) = 'ADMIN';

CREATE VIEW report_feed_freight
WITH (security_invoker = true)
AS
SELECT r.root AS freight_purchase_root_id, pu.id AS purchase_id, pu.economic_date,
       COALESCE(s.nombre, pu.counterparty_name) AS supplier_name, pu.supplier_invoice_number,
       pu.amount_total,
       COALESCE((SELECT SUM(fa.amount) FROM feed_freight_allocation fa WHERE fa.freight_purchase_root_id = r.root), 0) AS allocated,
       pu.amount_total - COALESCE((SELECT SUM(fa.amount) FROM feed_freight_allocation fa WHERE fa.freight_purchase_root_id = r.root), 0) AS remaining
  FROM purchases pu
  JOIN expense_category ec ON ec.id = pu.expense_category_id AND ec.is_feed_freight
 CROSS JOIN LATERAL (SELECT purchase_chain_root(pu.id) AS root) r
  LEFT JOIN suppliers s ON s.id = pu.supplier_id
 WHERE pu.is_current
   AND NOT EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = r.root)
   AND (SELECT current_app_role()) = 'ADMIN';

-- cost per kg of an ingredient in a month: weighted by kg over that month's purchases with kg
CREATE VIEW report_feed_ingredient_cost_month
WITH (security_invoker = true)
AS
SELECT feed_ingredient_id, ingredient_nombre, period,
       SUM(quantity_kg) AS quantity_kg,
       SUM(cost_amount + freight_cost) AS total_cost,
       round(SUM(cost_amount + freight_cost) / SUM(quantity_kg), 4) AS cost_per_kg,
       bool_or(freight_status = 'PENDIENTE') AS freight_pending
  FROM report_feed_purchase
 WHERE quantity_kg IS NOT NULL
 GROUP BY feed_ingredient_id, ingredient_nombre, period;

-- recipe cost per kg per month: the version effective at month end; each ingredient at its cost of the
-- month or, without purchases that month, its latest earlier month. NULL when an ingredient has no cost yet.
CREATE VIEW report_feed_recipe_cost_month
WITH (security_invoker = true)
AS
WITH months AS (
  SELECT gs::DATE AS period
    FROM generate_series(LEAST(feed_cost_start(), COALESCE((SELECT min(period) FROM report_feed_ingredient_cost_month), feed_cost_start())),
                         date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::DATE, INTERVAL '1 month') gs
), fv AS (
  SELECT ft.id AS feed_type_id, ft.nombre AS feed_type_nombre, m.period, v.id AS formula_version_id, v.version
    FROM feed_type ft
   CROSS JOIN months m
    JOIN LATERAL (SELECT * FROM feed_formula_version v
                   WHERE v.feed_type_id = ft.id AND v.effective_from <= (m.period + INTERVAL '1 month - 1 day')::DATE
                   ORDER BY v.effective_from DESC LIMIT 1) v ON true
), lines AS (
  SELECT fv.*, l.ingredient_id, l.quantity_kg, c.cost_per_kg, c.freight_pending, fi.nombre AS ingredient_nombre
    FROM fv
    JOIN feed_formula_line l ON l.formula_version_id = fv.formula_version_id
    JOIN feed_ingredient fi ON fi.id = l.ingredient_id
    LEFT JOIN LATERAL (SELECT cm.cost_per_kg, cm.freight_pending FROM report_feed_ingredient_cost_month cm
                        WHERE cm.feed_ingredient_id = l.ingredient_id AND cm.period <= fv.period
                        ORDER BY cm.period DESC LIMIT 1) c ON true
)
SELECT feed_type_id, feed_type_nombre, period, formula_version_id, version,
       CASE WHEN bool_and(cost_per_kg IS NOT NULL) THEN round(SUM(quantity_kg * cost_per_kg) / SUM(quantity_kg), 4) END AS cost_per_kg,
       COALESCE(bool_or(freight_pending), false) AS estimated,
       array_remove(array_agg(CASE WHEN cost_per_kg IS NULL THEN ingredient_nombre END ORDER BY ingredient_nombre), NULL) AS missing_ingredients
  FROM lines
 GROUP BY feed_type_id, feed_type_nombre, period, formula_version_id, version;

-- cost of the feed consumed: closed months only (report_feed_month), consumption × recipe cost per kg
CREATE VIEW report_feed_consumption_cost
WITH (security_invoker = true)
AS
SELECT fm.feed_type_id, fm.feed_type_nombre, fm.period, fm.internal_consumption_kg,
       rc.cost_per_kg, rc.estimated, rc.missing_ingredients,
       CASE WHEN fm.internal_consumption_kg IS NOT NULL AND rc.cost_per_kg IS NOT NULL
            THEN round(fm.internal_consumption_kg * rc.cost_per_kg, 2) END AS consumption_cost
  FROM report_feed_month fm
  LEFT JOIN report_feed_recipe_cost_month rc ON rc.feed_type_id = fm.feed_type_id AND rc.period = fm.period;

ALTER VIEW report_feed_purchase               OWNER TO postgres;
ALTER VIEW report_feed_freight                OWNER TO postgres;
ALTER VIEW report_feed_ingredient_cost_month  OWNER TO postgres;
ALTER VIEW report_feed_recipe_cost_month      OWNER TO postgres;
ALTER VIEW report_feed_consumption_cost       OWNER TO postgres;
REVOKE ALL ON report_feed_purchase, report_feed_freight, report_feed_ingredient_cost_month, report_feed_recipe_cost_month,
              report_feed_consumption_cost FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON report_feed_purchase, report_feed_freight, report_feed_ingredient_cost_month, report_feed_recipe_cost_month,
                report_feed_consumption_cost TO authenticated;

-- ── pnl_line_item (0124 body; [0126] marks the changes) ─────────────────────
CREATE OR REPLACE VIEW pnl_line_item
WITH (security_invoker = true)
AS
SELECT u.bucket, u.business_date, date_trunc('month', u.business_date)::DATE AS period,
       u.signed_amount, u.source_entity_type, u.source_entity_id,
       u.expense_category_id, u.nature, u.project_id, u.description
FROM (
  SELECT 'VENTAS_NETAS'::TEXT AS bucket, p.delivered_date AS business_date,
         SUM(l.subtotal)::NUMERIC(15,2) AS signed_amount,
         'pedidos'::TEXT AS source_entity_type, p.id::TEXT AS source_entity_id,
         NULL::UUID AS expense_category_id, NULL::purchase_nature AS nature, NULL::UUID AS project_id,
         c.nombre::TEXT AS description
    FROM pedidos p
    JOIN pedido_lineas l ON l.pedido_id = p.id AND l.is_current
    JOIN clients c ON c.id = p.cliente_id
   WHERE p.estado = 'DELIVERED'
   GROUP BY p.id, p.delivered_date, c.nombre

  UNION ALL
  SELECT CASE pu.nature WHEN 'OPERATING' THEN CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END
                        WHEN 'REINVESTMENT' THEN 'REINVERSION'
                        WHEN 'INVESTMENT' THEN 'INVERSIONES' END,
         pu.economic_date, -pu.amount_total,
         'purchases', pu.id::TEXT, pu.expense_category_id, pu.nature, pu.project_id,
         coalesce(pu.subcategory, ec.nombre)::TEXT
    FROM purchases pu
    JOIN expense_category ec ON ec.id = pu.expense_category_id
   WHERE pu.is_current AND NOT EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = purchase_chain_root(pu.id))
     -- [0126] feed ingredients and feed freight are stock, not expense, from feed_cost_start()
     AND NOT ((ec.feed_ingredient_id IS NOT NULL OR ec.is_feed_freight) AND pu.economic_date >= feed_cost_start())

  UNION ALL
  SELECT CASE pu.nature WHEN 'OPERATING' THEN CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END
                        WHEN 'REINVESTMENT' THEN 'REINVERSION'
                        WHEN 'INVESTMENT' THEN 'INVERSIONES' END,
         f.economic_date, -fa.allocated_amount,
         'freight_allocation', fa.id::TEXT, pu.expense_category_id, pu.nature, pu.project_id,
         coalesce(f.document_ref, 'flete asignado')::TEXT
    FROM freight_allocation fa
    JOIN freight f ON f.id = fa.freight_id AND f.is_current
    JOIN purchases pu ON pu.id = fa.purchase_id
    JOIN expense_category ec ON ec.id = pu.expense_category_id
   -- [0126] freight allocated to a feed-ingredient purchase follows the purchase
   WHERE NOT ((ec.feed_ingredient_id IS NOT NULL OR ec.is_feed_freight) AND pu.economic_date >= feed_cost_start())

  UNION ALL
  SELECT CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END,
         f.economic_date,
         -(f.amount - COALESCE((SELECT SUM(fa.allocated_amount) FROM freight_allocation fa WHERE fa.freight_id = f.id), 0)),
         'freight', f.id::TEXT, f.expense_category_id, NULL::purchase_nature, NULL::UUID,
         coalesce(f.document_ref, ec.nombre)::TEXT
    FROM freight f
    JOIN expense_category ec ON ec.id = f.expense_category_id
   WHERE f.is_current
     AND f.amount - COALESCE((SELECT SUM(fa.allocated_amount) FROM freight_allocation fa WHERE fa.freight_id = f.id), 0) <> 0
     -- [0126] unallocated freight of a feed-freight category is not expense either
     AND NOT (ec.is_feed_freight AND f.economic_date >= feed_cost_start())

  UNION ALL
  SELECT CASE e.event_type WHEN 'WITHDRAWAL' THEN 'RETIROS'
                           ELSE CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END END,
         e.event_date, -e.amount,
         'sales_session_cash_event', e.id::TEXT, e.expense_category_id, NULL::purchase_nature, NULL::UUID,
         e.reason
    FROM sales_session_cash_event e
    LEFT JOIN expense_category ec ON ec.id = e.expense_category_id
   WHERE e.event_type IN ('EXPENSE', 'WITHDRAWAL')

  UNION ALL
  -- [ADR-016] summarized Feria closing, current version: the aggregate expense, once, by its category class
  SELECT CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END,
         sc.closing_date, -sc.expenses,
         'sales_session_closing', sc.id::TEXT, sc.expense_category_id, NULL::purchase_nature, NULL::UUID,
         'Gastos de Feria'::TEXT
    FROM sales_session_closing sc
    JOIN expense_category ec ON ec.id = sc.expense_category_id
   WHERE sc.is_current AND sc.expenses <> 0

  UNION ALL
  -- [ADR-016] "Diferencia de caja": counted − expected, current version, once (overage > 0, shortage < 0)
  SELECT 'DIFERENCIA_CAJA',
         sc.closing_date, sc.counted_cash - (sc.opening_float + sc.cash_sales - sc.expenses),
         'sales_session_closing', sc.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         'Diferencia de caja (Feria)'::TEXT
    FROM sales_session_closing sc
   WHERE sc.is_current AND sc.counted_cash - (sc.opening_float + sc.cash_sales - sc.expenses) <> 0

  UNION ALL
  SELECT 'COSTOS_INDIRECTOS', m.occurred_date, -abs(m.fee_amount),
         'mp_financial_movement', m.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         ('MP fee ' || m.movement_kind)::TEXT
    FROM mp_financial_movement m
   WHERE m.fee_amount <> 0

  UNION ALL
  SELECT 'OTROS_INGRESOS_FINANCIEROS', m.occurred_date, m.net_amount,
         'mp_financial_movement', m.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         'MP yield'::TEXT
    FROM mp_financial_movement m
   WHERE m.movement_kind = 'yield'

  UNION ALL
  SELECT CASE me.event_type WHEN 'RETIRO' THEN 'RETIROS' ELSE 'RESERVAS_INTERNAS' END,
         me.effective_date,
         CASE WHEN me.compensates_event_id IS NULL THEN -me.amount ELSE me.amount END,
         'management_event', me.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         me.reason
    FROM management_event me

  UNION ALL
  -- [0101] a registered expense without a current purchase on its payment: SIN CLASIFICAR (once; the purchase replaces it)
  SELECT 'GASTOS_SIN_CLASIFICAR', ep.economic_date, -ep.amount,
         'expense_pending_classification', ep.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         (ep.concept || ' (sin clasificar)')::TEXT
    FROM expense_pending_classification ep
   WHERE NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = ep.payment_operation_id AND pu.is_current)

  UNION ALL
  -- [0126] the feed consumed in a closed month, at its recipe cost per kg (from feed_cost_start())
  SELECT 'COSTOS_DIRECTOS', (cc.period + INTERVAL '1 month - 1 day')::DATE, -cc.consumption_cost,
         'feed_consumption', (cc.feed_type_id::TEXT || ':' || cc.period::TEXT), NULL::UUID, 'OPERATING'::purchase_nature, NULL::UUID,
         ('Alimento consumido — ' || cc.feed_type_nombre)::TEXT
    FROM report_feed_consumption_cost cc
   WHERE cc.period >= feed_cost_start() AND cc.consumption_cost IS NOT NULL AND cc.consumption_cost <> 0
) u
WHERE (SELECT current_app_role()) = 'ADMIN';
