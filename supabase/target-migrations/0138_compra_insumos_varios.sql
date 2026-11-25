-- ============================================================================
-- TARGET V1 — 0138 UNA FACTURA CON VARIOS INSUMOS (owner decisions 2026-11-25)
--
--   An ingredient purchase (one expense: one payment, one invoice, one IVA) may
--   bring several ingredients. Nothing of the expense is duplicated: the split is
--   a costing detail of Alimento, like its kg and its freight.
--   * feed_purchase_part: the ingredients of one purchase chain — for each one its
--     ingredient category (each ingredient keeps its own category), its kg and its
--     amount on the invoice (the neto with Factura A, otherwise the total).
--   * set_feed_purchase_parts (ADMIN, audited): two or more parts, distinct
--     categories marked as an ingredient, amounts adding up exactly to the cost
--     basis of the current version (amount_net with Factura A, else amount_total);
--     the purchase kg (feed_purchase_quantity) = the sum of the parts, and the
--     «no freight» flag as set_feed_purchase_quantity. An empty list removes the
--     split (the purchase kg stay).
--   * report_feed_purchase: one row per part (one row as before without parts).
--     The purchase amount, its cost basis and its allocated freight are shared to
--     the cent (feed_share: cumulative rounding, the parts add up exactly to the
--     purchase): amounts by the parts' amounts, freight by kg. Two columns added
--     at the end: part_position (NULL without parts), purchase_quantity_kg.
--     Every view built on it (cost per ingredient per month, recipe and
--     consumption cost, P&L) then costs each ingredient on its own.
--   No data is written by this migration.
-- ============================================================================

CREATE TABLE feed_purchase_part (
  id                  BIGSERIAL PRIMARY KEY,
  purchase_root_id    UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  position            SMALLINT NOT NULL CONSTRAINT chk_feed_purchase_part_position CHECK (position >= 1),
  expense_category_id UUID NOT NULL REFERENCES expense_category(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  quantity_kg         NUMERIC(15,3) NOT NULL CONSTRAINT chk_feed_purchase_part_kg CHECK (quantity_kg > 0),
  amount              NUMERIC(15,2) NOT NULL CONSTRAINT chk_feed_purchase_part_amount CHECK (amount >= 0),
  updated_by          UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (purchase_root_id, position),
  UNIQUE (purchase_root_id, expense_category_id)
);
ALTER TABLE feed_purchase_part OWNER TO postgres;
ALTER TABLE feed_purchase_part ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON feed_purchase_part FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON feed_purchase_part TO authenticated;
CREATE POLICY feed_purchase_part_admin_select ON feed_purchase_part FOR SELECT USING (current_app_role() = 'ADMIN');
REVOKE ALL ON SEQUENCE feed_purchase_part_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- p_parts: [{expense_category_id, quantity_kg, amount}] in invoice order; [] removes the split. p_no_freight NULL keeps the flag.
CREATE FUNCTION set_feed_purchase_parts(p_purchase_id UUID, p_parts JSONB, p_no_freight BOOLEAN DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_root   UUID;
  v_pu     purchases;
  v_basis  NUMERIC;
  v_old    JSONB;
  v_q      feed_purchase_quantity;
  v_p      JSONB;
  v_cat    UUID;
  v_kg     NUMERIC;
  v_amount NUMERIC;
  v_seen   UUID[] := '{}';
  v_sum_kg NUMERIC := 0;
  v_sum    NUMERIC := 0;
  v_nf     BOOLEAN;
  v_pos    INTEGER := 0;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM purchases WHERE id = p_purchase_id) THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  v_root := purchase_chain_root(p_purchase_id);
  PERFORM pg_advisory_xact_lock(hashtext('feed_purchase_part'), hashtext(v_root::TEXT));
  SELECT * INTO v_pu FROM purchases WHERE purchase_chain_root(id) = v_root AND is_current;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = v_root) THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM expense_category WHERE id = v_pu.expense_category_id AND feed_ingredient_id IS NOT NULL) THEN
    RAISE EXCEPTION 'NOT_A_FEED_PURCHASE';
  END IF;
  IF p_parts IS NULL OR jsonb_typeof(p_parts) <> 'array' OR jsonb_array_length(p_parts) = 1 THEN
    RAISE EXCEPTION 'INVALID_PARTS: two or more ingredients, or none';
  END IF;
  v_basis := CASE WHEN EXISTS (SELECT 1 FROM fiscal_document fd WHERE fd.id = v_pu.fiscal_document_id AND fd.document_type = 'INVOICE_A')
                  THEN v_pu.amount_net ELSE v_pu.amount_total END;
  SELECT jsonb_agg(jsonb_build_object('expense_category_id', expense_category_id, 'quantity_kg', quantity_kg, 'amount', amount) ORDER BY position)
    INTO v_old FROM feed_purchase_part WHERE purchase_root_id = v_root;
  SELECT * INTO v_q FROM feed_purchase_quantity WHERE purchase_root_id = v_root FOR UPDATE;

  IF jsonb_array_length(p_parts) = 0 THEN
    IF v_old IS NULL THEN
      RAISE EXCEPTION 'NO_CHANGES';
    END IF;
    DELETE FROM feed_purchase_part WHERE purchase_root_id = v_root;
    INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, performed_by)
    VALUES ('feed_purchase_part', v_root::TEXT, 'DELETE', jsonb_build_object('parts', v_old), NULL, v_uid);
    RETURN jsonb_build_object('purchase_root_id', v_root, 'parts', 0, 'quantity_kg', v_q.quantity_kg);
  END IF;

  FOR v_p IN SELECT value FROM jsonb_array_elements(p_parts) LOOP
    BEGIN
      v_cat := (v_p->>'expense_category_id')::UUID;
      v_kg := (v_p->>'quantity_kg')::NUMERIC;
      v_amount := (v_p->>'amount')::NUMERIC;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'INVALID_PARTS: unreadable part';
    END;
    IF v_cat IS NULL OR NOT EXISTS (SELECT 1 FROM expense_category WHERE id = v_cat AND feed_ingredient_id IS NOT NULL) THEN
      RAISE EXCEPTION 'NOT_A_FEED_CATEGORY';
    END IF;
    IF v_cat = ANY (v_seen) THEN
      RAISE EXCEPTION 'DUPLICATE_CATEGORY';
    END IF;
    v_seen := v_seen || v_cat;
    IF v_kg IS NULL OR v_kg <= 0 OR v_kg <> round(v_kg, 3) OR v_kg >= 1e12 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;
    IF v_amount IS NULL OR v_amount < 0 OR v_amount <> round(v_amount, 2) OR v_amount >= 1e13 THEN
      RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;
    v_sum_kg := v_sum_kg + v_kg;
    v_sum := v_sum + v_amount;
  END LOOP;
  IF v_sum <> v_basis THEN
    RAISE EXCEPTION 'PARTS_AMOUNT_MISMATCH: the parts add up to %, the invoice is %', v_sum, v_basis;
  END IF;
  IF v_sum_kg >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  v_nf := COALESCE(p_no_freight, v_q.no_freight, false);
  IF v_nf AND EXISTS (SELECT 1 FROM feed_freight_allocation WHERE purchase_root_id = v_root) THEN
    RAISE EXCEPTION 'FREIGHT_ALREADY_ALLOCATED';
  END IF;

  DELETE FROM feed_purchase_part WHERE purchase_root_id = v_root;
  FOR v_p IN SELECT value FROM jsonb_array_elements(p_parts) LOOP
    v_pos := v_pos + 1;
    INSERT INTO feed_purchase_part (purchase_root_id, position, expense_category_id, quantity_kg, amount, updated_by)
    VALUES (v_root, v_pos, (v_p->>'expense_category_id')::UUID, (v_p->>'quantity_kg')::NUMERIC, (v_p->>'amount')::NUMERIC, v_uid);
  END LOOP;
  INSERT INTO feed_purchase_quantity (purchase_root_id, quantity_kg, no_freight, updated_by, updated_at)
  VALUES (v_root, v_sum_kg, v_nf, v_uid, NOW())
  ON CONFLICT (purchase_root_id) DO UPDATE SET quantity_kg = EXCLUDED.quantity_kg, no_freight = EXCLUDED.no_freight,
                                               updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, performed_by)
  VALUES ('feed_purchase_part', v_root::TEXT, CASE WHEN v_old IS NULL THEN 'CREATE' ELSE 'UPDATE' END,
          CASE WHEN v_old IS NULL THEN NULL ELSE jsonb_build_object('parts', v_old, 'quantity_kg', v_q.quantity_kg, 'no_freight', v_q.no_freight) END,
          jsonb_build_object('parts', p_parts, 'quantity_kg', v_sum_kg, 'no_freight', v_nf), v_uid);
  RETURN jsonb_build_object('purchase_root_id', v_root, 'parts', v_pos, 'quantity_kg', v_sum_kg, 'no_freight', v_nf);
END;
$$;
ALTER  FUNCTION set_feed_purchase_parts(UUID, JSONB, BOOLEAN) OWNER TO postgres;
REVOKE ALL     ON FUNCTION set_feed_purchase_parts(UUID, JSONB, BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION set_feed_purchase_parts(UUID, JSONB, BOOLEAN) TO authenticated;

-- The share of p_total of a part whose weight is p_part, p_cum the cumulative weight up to and including it, p_whole the weight of
-- all the parts: cumulative rounding to the cent, so the shares of all the parts add up exactly to p_total. No parts (p_whole NULL):
-- the whole amount.
CREATE FUNCTION feed_share(p_total NUMERIC, p_part NUMERIC, p_cum NUMERIC, p_whole NUMERIC) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_whole IS NULL OR p_whole = 0 THEN p_total
              ELSE round(p_total * p_cum / p_whole, 2) - round(p_total * (p_cum - p_part) / p_whole, 2) END
$$;
ALTER  FUNCTION feed_share(NUMERIC, NUMERIC, NUMERIC, NUMERIC) OWNER TO postgres;
REVOKE ALL     ON FUNCTION feed_share(NUMERIC, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION feed_share(NUMERIC, NUMERIC, NUMERIC, NUMERIC) TO authenticated;

-- One row per part (or the purchase as before). Amounts shared by the parts' amounts (by kg if they are all 0), freight by kg.
CREATE OR REPLACE VIEW report_feed_purchase
WITH (security_invoker = true)
AS
SELECT b.purchase_root_id, b.purchase_id, b.economic_date, b.period, b.feed_ingredient_id, b.ingredient_nombre, b.expense_category_id,
       b.supplier_name, b.amount_total, b.invoice_a, b.cost_amount, b.quantity_kg, b.no_freight, b.freight_amount, b.freight_cost,
       b.freight_status,
       CASE WHEN b.quantity_kg IS NULL THEN NULL ELSE round(b.cost_amount / b.quantity_kg, 4) END AS price_per_kg,
       CASE WHEN b.quantity_kg IS NULL THEN NULL ELSE round((b.cost_amount + b.freight_cost) / b.quantity_kg, 4) END AS cost_per_kg,
       b.part_position, b.purchase_quantity_kg
  FROM (
SELECT r.root AS purchase_root_id, pu.id AS purchase_id, pu.economic_date, date_trunc('month', pu.economic_date)::DATE AS period,
       COALESCE(pec.feed_ingredient_id, ec.feed_ingredient_id) AS feed_ingredient_id, COALESCE(pfi.nombre, fi.nombre) AS ingredient_nombre,
       COALESCE(pt.expense_category_id, ec.id) AS expense_category_id,
       COALESCE(s.nombre, pu.counterparty_name) AS supplier_name,
       feed_share(pu.amount_total, pt.w, pt.cw, pt.tw)::NUMERIC(15,2) AS amount_total,
       (fd.document_type = 'INVOICE_A') IS TRUE AS invoice_a,
       feed_share(CASE WHEN fd.document_type = 'INVOICE_A' THEN pu.amount_net ELSE pu.amount_total END, pt.w, pt.cw, pt.tw)::NUMERIC(15,2) AS cost_amount,
       COALESCE(pt.quantity_kg, q.quantity_kg) AS quantity_kg, COALESCE(q.no_freight, false) AS no_freight,
       feed_share(COALESCE(fr.freight, 0), pt.quantity_kg, pt.ck, pt.tk) AS freight_amount,
       feed_share(COALESCE(fr.freight_cost, 0), pt.quantity_kg, pt.ck, pt.tk) AS freight_cost,
       CASE WHEN COALESCE(fr.freight, 0) > 0 THEN 'ASIGNADO' WHEN q.no_freight THEN 'SIN_FLETE' ELSE 'PENDIENTE' END AS freight_status,
       pt.position AS part_position, q.quantity_kg AS purchase_quantity_kg
  FROM purchases pu
  JOIN expense_category ec ON ec.id = pu.expense_category_id AND ec.feed_ingredient_id IS NOT NULL
  JOIN feed_ingredient fi ON fi.id = ec.feed_ingredient_id
 CROSS JOIN LATERAL (SELECT purchase_chain_root(pu.id) AS root) r
  LEFT JOIN fiscal_document fd ON fd.id = pu.fiscal_document_id
  LEFT JOIN suppliers s ON s.id = pu.supplier_id
  LEFT JOIN feed_purchase_quantity q ON q.purchase_root_id = r.root
  LEFT JOIN LATERAL (
    SELECT x.position, x.expense_category_id, x.quantity_kg, x.w,
           SUM(x.w) OVER (ORDER BY x.position) AS cw, SUM(x.w) OVER () AS tw,
           SUM(x.quantity_kg) OVER (ORDER BY x.position) AS ck, SUM(x.quantity_kg) OVER () AS tk
      FROM (SELECT p.position, p.expense_category_id, p.quantity_kg,
                   CASE WHEN SUM(p.amount) OVER () > 0 THEN p.amount ELSE p.quantity_kg END AS w
              FROM feed_purchase_part p WHERE p.purchase_root_id = r.root) x) pt ON true
  LEFT JOIN expense_category pec ON pec.id = pt.expense_category_id
  LEFT JOIN feed_ingredient pfi ON pfi.id = pec.feed_ingredient_id
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
   AND (SELECT current_app_role()) = 'ADMIN'
  ) b;
