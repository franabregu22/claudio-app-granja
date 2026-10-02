-- ============================================================================
-- TARGET V1 — 0070 FERIA V1 SUMMARIZED CLOSING (ADR-016, owner decisions
-- D-FER-1…5, Phase 27 acceptance fixes)
--
-- The paper / spreadsheet worksheet stays the detailed operational record; the
-- app stores a summarized, versioned closing:
--   inputs (stored):   cash / Mercado Pago / bank-transfer sales, opening float,
--                      aggregate Feria expenses, counted cash, merma, notes,
--                      physical-cash and transfer destination accounts, worksheet
--   derived (never stored, invariant 27; computed by the RPC for postings and by
--                      the views): total_sales = cash + MP + transfer;
--                      expected_cash = opening_float + cash_sales − expenses;
--                      cash_difference = counted_cash − expected_cash
--
-- Effects of one closing version (RPC 51; RPC 52 reverses the previous version
-- and applies the new one, the original rows are never changed):
--   sales      aggregated CONSUMIDOR FINAL pedido with ONE line of the internal
--              system product "Venta Feria (resumen)" (products.is_system), price
--              = total_sales, delivered on the Feria date (normal RPC 1 path) →
--              VENTAS_NETAS once; corrected through RPC 2 on rectification
--   cash       RPC 4 collection CASH, cash_sales → physical destination account
--   transfer   RPC 4 collection TRANSFER, transfer_sales → transfer account
--   MP         NO collection: the MP part stays a CONSUMIDOR FINAL receivable,
--              settled only by the ADR-006 pipeline allocation (no duplicate)
--   expenses   one SESSION_CASH operation, −expenses on the physical destination;
--              P&L once, from the closing row, category "Gastos de Feria"
--   difference one ADJUSTMENT operation, ±cash_difference on the physical
--              destination; P&L once, from the closing row, line DIFERENCIA_CAJA
--   float      no posting: taken from and returned to the physical destination
--              account; it only enters expected_cash (never revenue)
--   ⇒ net change of the physical destination = counted_cash − opening_float
--
-- Also: private Storage bucket `feria-worksheets` (ADR-008 pattern), the P&L
-- views gain the summarized Feria expense and the "Diferencia de caja" line, and
-- report_feria_closing lists every version. Feria stays ADMIN-only (ADR-009).
-- ============================================================================

-- ── internal system product + dedicated expense category (reference data) ───
ALTER TABLE products ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT false;
INSERT INTO products (nombre, product_type, unit_type, activo, is_system)
VALUES ('Venta Feria (resumen)', 'VENDIBLE', 'UNIT', true, true);
INSERT INTO expense_category (nombre, description, activo, pnl_cost_class)
VALUES ('Gastos de Feria', 'Gastos de la Feria (agregado del cierre resumido; detalle en la planilla)', true, 'INDIRECT');

-- ── sales_session_closing ────────────────────────────────────────────────────
CREATE TABLE sales_session_closing (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_session_id       UUID NOT NULL REFERENCES sales_session(id) ON DELETE RESTRICT,
  version_seq            INTEGER NOT NULL DEFAULT 0 CHECK (version_seq >= 0),
  is_current             BOOLEAN NOT NULL DEFAULT true,
  supersedes_id          UUID UNIQUE REFERENCES sales_session_closing(id) ON DELETE RESTRICT,
  rectification_reason   TEXT,
  closing_date           DATE NOT NULL,
  cash_sales             NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cash_sales >= 0),
  mp_sales               NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (mp_sales >= 0),
  transfer_sales         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (transfer_sales >= 0),
  opening_float          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
  expenses               NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (expenses >= 0),
  counted_cash           NUMERIC(14,2) NOT NULL CHECK (counted_cash >= 0),
  merma                  NUMERIC(14,2) CHECK (merma IS NULL OR merma >= 0),
  notes                  TEXT,
  cash_account_id        UUID NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT,
  transfer_account_id    UUID REFERENCES financial_account(id) ON DELETE RESTRICT,
  expense_category_id    UUID NOT NULL REFERENCES expense_category(id) ON DELETE RESTRICT,
  aggregated_pedido_id   UUID REFERENCES pedidos(id) ON DELETE RESTRICT,
  cash_collection_id     UUID REFERENCES collections(id) ON DELETE RESTRICT,
  transfer_collection_id UUID REFERENCES collections(id) ON DELETE RESTRICT,
  expense_operation_id   BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT,
  difference_operation_id BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT,
  worksheet_path         TEXT,
  worksheet_file_name    TEXT,
  worksheet_content_type TEXT,
  worksheet_byte_size    BIGINT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT,
  CONSTRAINT chk_feria_closing_version_chain
    CHECK ((supersedes_id IS NULL) = (version_seq = 0) AND (supersedes_id IS NULL) = (rectification_reason IS NULL)),
  CONSTRAINT chk_feria_closing_transfer_account CHECK (transfer_sales = 0 OR transfer_account_id IS NOT NULL),
  CONSTRAINT chk_feria_closing_worksheet
    CHECK ((worksheet_path IS NULL) = (worksheet_file_name IS NULL)
       AND (worksheet_path IS NULL) = (worksheet_content_type IS NULL)
       AND (worksheet_path IS NULL) = (worksheet_byte_size IS NULL))
);
CREATE UNIQUE INDEX uq_feria_closing_current ON sales_session_closing (sales_session_id) WHERE is_current;
CREATE INDEX idx_feria_closing_date ON sales_session_closing (closing_date);

ALTER TABLE sales_session_closing ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_session_closing_admin_select ON sales_session_closing
  FOR SELECT TO authenticated USING (current_app_role() = 'ADMIN');
ALTER  TABLE sales_session_closing OWNER TO postgres;
REVOKE ALL    ON sales_session_closing FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON sales_session_closing TO authenticated;

-- ── RPC 51 close_feria_summary ───────────────────────────────────────────────
-- p_worksheet: NULL or {storage_path, file_name, content_type, byte_size} of an object
-- already uploaded to `feria-worksheets` (the caller deletes it if this call fails).
CREATE OR REPLACE FUNCTION close_feria_summary(
  p_session_id          UUID,
  p_cash_sales          NUMERIC,
  p_mp_sales            NUMERIC,
  p_transfer_sales      NUMERIC,
  p_expenses            NUMERIC,
  p_counted_cash        NUMERIC,
  p_cash_account_id     UUID,
  p_transfer_account_id UUID    DEFAULT NULL,
  p_opening_float       NUMERIC DEFAULT 0,
  p_merma               NUMERIC DEFAULT NULL,
  p_notes               TEXT    DEFAULT NULL,
  p_worksheet           JSONB   DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_session    sales_session;
  v_id         UUID := gen_random_uuid();
  v_cf         UUID;
  v_product    UUID;
  v_category   UUID;
  v_total      NUMERIC;
  v_expected   NUMERIC;
  v_diff       NUMERIC;
  v_pedido     UUID;
  v_cash_col   UUID;
  v_trf_col    UUID;
  v_exp_op     BIGINT;
  v_diff_op    BIGINT;
  v_at         TIMESTAMPTZ;
  v_float      NUMERIC := COALESCE(p_opening_float, 0);
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_cash_sales IS NULL OR p_mp_sales IS NULL OR p_transfer_sales IS NULL OR p_expenses IS NULL OR p_counted_cash IS NULL
     OR p_cash_sales < 0 OR p_mp_sales < 0 OR p_transfer_sales < 0 OR p_expenses < 0 OR p_counted_cash < 0 OR v_float < 0
     OR (p_merma IS NOT NULL AND p_merma < 0)
     OR p_cash_sales <> round(p_cash_sales, 2) OR p_mp_sales <> round(p_mp_sales, 2) OR p_transfer_sales <> round(p_transfer_sales, 2)
     OR p_expenses <> round(p_expenses, 2) OR p_counted_cash <> round(p_counted_cash, 2) OR v_float <> round(v_float, 2) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT * INTO v_session FROM sales_session WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND';
  END IF;
  IF v_session.estado <> 'OPEN' THEN
    RAISE EXCEPTION 'SESSION_ALREADY_CLOSED';
  END IF;
  -- a session already carrying granular cash events keeps the detailed (legacy) path: never mix both
  IF EXISTS (SELECT 1 FROM sales_session_cash_event WHERE sales_session_id = p_session_id) THEN
    RAISE EXCEPTION 'LEGACY_CASH_EVENTS_PRESENT: this session has granular cash events; close it with the detailed path';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_cash_account_id AND activo
                   AND NOT (nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_INVALID';
  END IF;
  IF p_transfer_sales > 0 THEN
    IF p_transfer_account_id IS NULL THEN
      RAISE EXCEPTION 'TRANSFER_ACCOUNT_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_transfer_account_id AND activo
                     AND NOT (nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')) THEN
      RAISE EXCEPTION 'TRANSFER_ACCOUNT_INVALID';
    END IF;
  END IF;
  IF p_worksheet IS NOT NULL AND (
       jsonb_typeof(p_worksheet) <> 'object'
       OR coalesce(p_worksheet->>'storage_path', '') = '' OR coalesce(p_worksheet->>'file_name', '') = ''
       OR p_worksheet->>'content_type' NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
       OR (p_worksheet->>'byte_size')::BIGINT NOT BETWEEN 1 AND 10485760) THEN
    RAISE EXCEPTION 'INVALID_WORKSHEET';
  END IF;

  PERFORM assert_period_open(v_session.session_date);

  SELECT id INTO v_cf FROM clients WHERE nombre = 'CONSUMIDOR FINAL' AND activo;
  IF v_cf IS NULL THEN
    RAISE EXCEPTION 'CONSUMIDOR_FINAL_MISSING';
  END IF;
  SELECT id INTO v_product FROM products WHERE is_system AND nombre = 'Venta Feria (resumen)';
  SELECT id INTO v_category FROM expense_category WHERE nombre = 'Gastos de Feria';
  IF v_product IS NULL OR v_category IS NULL THEN
    RAISE EXCEPTION 'FERIA_REFERENCE_DATA_MISSING';
  END IF;

  v_total    := p_cash_sales + p_mp_sales + p_transfer_sales;
  v_expected := v_float + p_cash_sales - p_expenses;
  v_diff     := p_counted_cash - v_expected;
  v_at       := (v_session.session_date + TIME '12:00') AT TIME ZONE 'America/Argentina/Buenos_Aires';

  -- sales: one summarized line of the internal system product, delivered on the Feria date
  IF v_total > 0 THEN
    INSERT INTO pedidos (cliente_id, estado, sales_session_id, is_aggregated_retail, created_by, updated_by)
    VALUES (v_cf, 'PENDING', p_session_id, true, v_uid, v_uid)
    RETURNING id INTO v_pedido;
    INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, created_by)
    VALUES (v_pedido, v_product, 1, v_total, 'Venta Feria (resumen)', v_uid);
    PERFORM deliver_order(v_pedido, v_at, 'Feria: cierre resumido');
  END IF;

  IF p_cash_sales > 0 THEN
    v_cash_col := (register_collection(v_cf, p_cash_sales, 'CASH', 'FERIA:' || v_id || ':CASH', v_session.session_date,
                                       p_cash_account_id, p_session_id, 'Feria: ventas en efectivo')->>'collection_id')::UUID;
  END IF;
  IF p_transfer_sales > 0 THEN
    v_trf_col := (register_collection(v_cf, p_transfer_sales, 'TRANSFER', 'FERIA:' || v_id || ':TRF', v_session.session_date,
                                      p_transfer_account_id, p_session_id, 'Feria: ventas por transferencia')->>'collection_id')::UUID;
  END IF;
  IF p_expenses > 0 THEN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('SESSION_CASH', v_session.session_date, 'FERIA:' || v_id || ':EXP', 'sales_session_closing', v_id::TEXT, 'Feria: gastos', v_uid)
    RETURNING id INTO v_exp_op;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_exp_op, p_cash_account_id, -p_expenses, v_session.session_date, v_uid);
  END IF;
  IF v_diff <> 0 THEN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('ADJUSTMENT', v_session.session_date, 'FERIA:' || v_id || ':DIFF', 'sales_session_closing', v_id::TEXT, 'Feria: diferencia de caja', v_uid)
    RETURNING id INTO v_diff_op;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_diff_op, p_cash_account_id, v_diff, v_session.session_date, v_uid);
  END IF;

  INSERT INTO sales_session_closing (id, sales_session_id, closing_date, cash_sales, mp_sales, transfer_sales, opening_float,
         expenses, counted_cash, merma, notes, cash_account_id, transfer_account_id, expense_category_id, aggregated_pedido_id,
         cash_collection_id, transfer_collection_id, expense_operation_id, difference_operation_id,
         worksheet_path, worksheet_file_name, worksheet_content_type, worksheet_byte_size, created_by)
  VALUES (v_id, p_session_id, v_session.session_date, p_cash_sales, p_mp_sales, p_transfer_sales, v_float,
          p_expenses, p_counted_cash, p_merma, NULLIF(btrim(p_notes), ''), p_cash_account_id,
          CASE WHEN p_transfer_sales > 0 THEN p_transfer_account_id END, v_category, v_pedido,
          v_cash_col, v_trf_col, v_exp_op, v_diff_op,
          p_worksheet->>'storage_path', p_worksheet->>'file_name', p_worksheet->>'content_type', (p_worksheet->>'byte_size')::BIGINT, v_uid);

  UPDATE sales_session SET estado = 'CLOSED', closed_at = now(), closed_by = v_uid, aggregated_pedido_id = v_pedido
   WHERE id = p_session_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, performed_by)
  VALUES ('sales_session_closing', v_id::TEXT, 'CLOSE',
          jsonb_build_object('sales_session_id', p_session_id, 'total_sales', v_total, 'expected_cash', v_expected,
                             'counted_cash', p_counted_cash, 'cash_difference', v_diff), v_uid);

  RETURN jsonb_build_object('closing_id', v_id, 'total_sales', v_total, 'expected_cash', v_expected,
                            'cash_difference', v_diff, 'aggregated_pedido_id', v_pedido);
END;
$$;

ALTER  FUNCTION close_feria_summary(UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL     ON FUNCTION close_feria_summary(UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION close_feria_summary(UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB) TO authenticated;

-- ── RPC 52 rectify_feria_closing ─────────────────────────────────────────────
-- Replaces the WHOLE current closing. The previous version's treasury effects are
-- reversed by compensating rows (collection → client_ledger REVERSAL + ADJUSTMENT
-- posting; expense / difference → opposite ADJUSTMENT posting); the new values are
-- applied as in RPC 51; sales are corrected through RPC 2 (or created when the
-- previous total was 0). p_keep_worksheet: carry the previous worksheet when no
-- new one is supplied.
CREATE OR REPLACE FUNCTION rectify_feria_closing(
  p_closing_id          UUID,
  p_reason              TEXT,
  p_cash_sales          NUMERIC,
  p_mp_sales            NUMERIC,
  p_transfer_sales      NUMERIC,
  p_expenses            NUMERIC,
  p_counted_cash        NUMERIC,
  p_cash_account_id     UUID,
  p_transfer_account_id UUID    DEFAULT NULL,
  p_opening_float       NUMERIC DEFAULT 0,
  p_merma               NUMERIC DEFAULT NULL,
  p_notes               TEXT    DEFAULT NULL,
  p_worksheet           JSONB   DEFAULT NULL,
  p_keep_worksheet      BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_old        sales_session_closing;
  v_id         UUID := gen_random_uuid();
  v_cf         UUID;
  v_product    UUID;
  v_total      NUMERIC;
  v_old_total  NUMERIC;
  v_expected   NUMERIC;
  v_diff       NUMERIC;
  v_old_diff   NUMERIC;
  v_pedido     UUID;
  v_cash_col   UUID;
  v_trf_col    UUID;
  v_exp_op     BIGINT;
  v_diff_op    BIGINT;
  v_op         BIGINT;
  v_col        collections;
  v_ledger     client_ledger;
  v_at         TIMESTAMPTZ;
  v_float      NUMERIC := COALESCE(p_opening_float, 0);
  v_ws         JSONB;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_cash_sales IS NULL OR p_mp_sales IS NULL OR p_transfer_sales IS NULL OR p_expenses IS NULL OR p_counted_cash IS NULL
     OR p_cash_sales < 0 OR p_mp_sales < 0 OR p_transfer_sales < 0 OR p_expenses < 0 OR p_counted_cash < 0 OR v_float < 0
     OR (p_merma IS NOT NULL AND p_merma < 0)
     OR p_cash_sales <> round(p_cash_sales, 2) OR p_mp_sales <> round(p_mp_sales, 2) OR p_transfer_sales <> round(p_transfer_sales, 2)
     OR p_expenses <> round(p_expenses, 2) OR p_counted_cash <> round(p_counted_cash, 2) OR v_float <> round(v_float, 2) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT * INTO v_old FROM sales_session_closing WHERE id = p_closing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLOSING_NOT_FOUND';
  END IF;
  IF NOT v_old.is_current THEN
    RAISE EXCEPTION 'CLOSING_SUPERSEDED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_cash_account_id AND activo
                   AND NOT (nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_INVALID';
  END IF;
  IF p_transfer_sales > 0 THEN
    IF p_transfer_account_id IS NULL THEN
      RAISE EXCEPTION 'TRANSFER_ACCOUNT_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_transfer_account_id AND activo
                     AND NOT (nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')) THEN
      RAISE EXCEPTION 'TRANSFER_ACCOUNT_INVALID';
    END IF;
  END IF;
  IF p_worksheet IS NOT NULL AND (
       jsonb_typeof(p_worksheet) <> 'object'
       OR coalesce(p_worksheet->>'storage_path', '') = '' OR coalesce(p_worksheet->>'file_name', '') = ''
       OR p_worksheet->>'content_type' NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
       OR (p_worksheet->>'byte_size')::BIGINT NOT BETWEEN 1 AND 10485760) THEN
    RAISE EXCEPTION 'INVALID_WORKSHEET';
  END IF;

  PERFORM assert_period_open(v_old.closing_date);

  SELECT id INTO v_cf FROM clients WHERE nombre = 'CONSUMIDOR FINAL';
  SELECT id INTO v_product FROM products WHERE is_system AND nombre = 'Venta Feria (resumen)';

  v_old_total := v_old.cash_sales + v_old.mp_sales + v_old.transfer_sales;
  v_old_diff  := v_old.counted_cash - (v_old.opening_float + v_old.cash_sales - v_old.expenses);
  v_total     := p_cash_sales + p_mp_sales + p_transfer_sales;
  v_expected  := v_float + p_cash_sales - p_expenses;
  v_diff      := p_counted_cash - v_expected;
  v_at        := (v_old.closing_date + TIME '12:00') AT TIME ZONE 'America/Argentina/Buenos_Aires';

  -- (1) reverse the previous version's treasury effects (compensating rows only)
  FOREACH v_cash_col IN ARRAY ARRAY[v_old.cash_collection_id, v_old.transfer_collection_id] LOOP
    CONTINUE WHEN v_cash_col IS NULL;
    SELECT * INTO v_col FROM collections WHERE id = v_cash_col;
    SELECT * INTO v_ledger FROM client_ledger
     WHERE source_entity_type = 'collections' AND source_entity_id = v_col.id::TEXT AND movement_type = 'COLLECTION';
    INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name,
           source_entity_type, source_entity_id, reversal_of_id, reason, created_by)
    VALUES (v_col.cliente_id, 'REVERSAL', -v_ledger.signed_amount, v_old.closing_date, v_ledger.ledger_client_name,
            'sales_session_closing', v_id::TEXT, v_ledger.id, btrim(p_reason), v_uid);
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('ADJUSTMENT', v_old.closing_date, 'FERIA:' || v_id || ':REV:' || v_col.id, 'sales_session_closing', v_id::TEXT,
            'Feria: reversión de cobro por rectificación', v_uid)
    RETURNING id INTO v_op;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_op, v_col.financial_account_id, -v_col.amount, v_old.closing_date, v_uid);
  END LOOP;
  v_cash_col := NULL;
  IF v_old.expenses > 0 THEN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('ADJUSTMENT', v_old.closing_date, 'FERIA:' || v_id || ':REV:EXP', 'sales_session_closing', v_id::TEXT,
            'Feria: reversión de gastos por rectificación', v_uid)
    RETURNING id INTO v_op;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_op, v_old.cash_account_id, v_old.expenses, v_old.closing_date, v_uid);
  END IF;
  IF v_old_diff <> 0 THEN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('ADJUSTMENT', v_old.closing_date, 'FERIA:' || v_id || ':REV:DIFF', 'sales_session_closing', v_id::TEXT,
            'Feria: reversión de diferencia por rectificación', v_uid)
    RETURNING id INTO v_op;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_op, v_old.cash_account_id, -v_old_diff, v_old.closing_date, v_uid);
  END IF;

  -- (2) sales: corrected through RPC 2; created when the previous total was 0
  v_pedido := v_old.aggregated_pedido_id;
  IF v_pedido IS NOT NULL THEN
    IF v_total <> v_old_total THEN
      PERFORM rectify_delivered_order(v_pedido,
        jsonb_build_array(jsonb_build_object('producto_id', v_product, 'cantidad', 1, 'precio_unitario', v_total)),
        btrim(p_reason));
    END IF;
  ELSIF v_total > 0 THEN
    INSERT INTO pedidos (cliente_id, estado, sales_session_id, is_aggregated_retail, created_by, updated_by)
    VALUES (v_cf, 'PENDING', v_old.sales_session_id, true, v_uid, v_uid)
    RETURNING id INTO v_pedido;
    INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, created_by)
    VALUES (v_pedido, v_product, 1, v_total, 'Venta Feria (resumen)', v_uid);
    PERFORM deliver_order(v_pedido, v_at, 'Feria: cierre resumido (rectificación)');
    UPDATE sales_session SET aggregated_pedido_id = v_pedido WHERE id = v_old.sales_session_id;
  END IF;

  -- (3) apply the new version's treasury effects
  IF p_cash_sales > 0 THEN
    v_cash_col := (register_collection(v_cf, p_cash_sales, 'CASH', 'FERIA:' || v_id || ':CASH', v_old.closing_date,
                                       p_cash_account_id, v_old.sales_session_id, 'Feria: ventas en efectivo')->>'collection_id')::UUID;
  END IF;
  IF p_transfer_sales > 0 THEN
    v_trf_col := (register_collection(v_cf, p_transfer_sales, 'TRANSFER', 'FERIA:' || v_id || ':TRF', v_old.closing_date,
                                      p_transfer_account_id, v_old.sales_session_id, 'Feria: ventas por transferencia')->>'collection_id')::UUID;
  END IF;
  IF p_expenses > 0 THEN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('SESSION_CASH', v_old.closing_date, 'FERIA:' || v_id || ':EXP', 'sales_session_closing', v_id::TEXT, 'Feria: gastos', v_uid)
    RETURNING id INTO v_exp_op;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_exp_op, p_cash_account_id, -p_expenses, v_old.closing_date, v_uid);
  END IF;
  IF v_diff <> 0 THEN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('ADJUSTMENT', v_old.closing_date, 'FERIA:' || v_id || ':DIFF', 'sales_session_closing', v_id::TEXT, 'Feria: diferencia de caja', v_uid)
    RETURNING id INTO v_diff_op;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_diff_op, p_cash_account_id, v_diff, v_old.closing_date, v_uid);
  END IF;

  v_ws := CASE WHEN p_worksheet IS NOT NULL THEN p_worksheet
               WHEN p_keep_worksheet AND v_old.worksheet_path IS NOT NULL THEN
                 jsonb_build_object('storage_path', v_old.worksheet_path, 'file_name', v_old.worksheet_file_name,
                                    'content_type', v_old.worksheet_content_type, 'byte_size', v_old.worksheet_byte_size)
          END;

  UPDATE sales_session_closing SET is_current = false WHERE id = v_old.id;
  INSERT INTO sales_session_closing (id, sales_session_id, version_seq, is_current, supersedes_id, rectification_reason,
         closing_date, cash_sales, mp_sales, transfer_sales, opening_float, expenses, counted_cash, merma, notes,
         cash_account_id, transfer_account_id, expense_category_id, aggregated_pedido_id,
         cash_collection_id, transfer_collection_id, expense_operation_id, difference_operation_id,
         worksheet_path, worksheet_file_name, worksheet_content_type, worksheet_byte_size, created_by)
  VALUES (v_id, v_old.sales_session_id, v_old.version_seq + 1, true, v_old.id, btrim(p_reason),
          v_old.closing_date, p_cash_sales, p_mp_sales, p_transfer_sales, v_float, p_expenses, p_counted_cash, p_merma,
          NULLIF(btrim(p_notes), ''), p_cash_account_id, CASE WHEN p_transfer_sales > 0 THEN p_transfer_account_id END,
          v_old.expense_category_id, v_pedido, v_cash_col, v_trf_col, v_exp_op, v_diff_op,
          v_ws->>'storage_path', v_ws->>'file_name', v_ws->>'content_type', (v_ws->>'byte_size')::BIGINT, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('sales_session_closing', v_id::TEXT, 'RECTIFY',
          jsonb_build_object('closing_id', v_old.id, 'version_seq', v_old.version_seq, 'total_sales', v_old_total, 'cash_difference', v_old_diff),
          jsonb_build_object('closing_id', v_id, 'version_seq', v_old.version_seq + 1, 'total_sales', v_total, 'cash_difference', v_diff),
          btrim(p_reason), v_uid);

  RETURN jsonb_build_object('closing_id', v_id, 'superseded_id', v_old.id, 'version_seq', v_old.version_seq + 1,
                            'total_sales', v_total, 'expected_cash', v_expected, 'cash_difference', v_diff);
END;
$$;

ALTER  FUNCTION rectify_feria_closing(UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB, BOOLEAN) OWNER TO postgres;
REVOKE ALL     ON FUNCTION rectify_feria_closing(UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB, BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION rectify_feria_closing(UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, UUID, UUID, NUMERIC, NUMERIC, TEXT, JSONB, BOOLEAN) TO authenticated;

-- ── report_feria_closing (ADMIN): every version, derived values computed here ──
CREATE VIEW report_feria_closing
WITH (security_invoker = true)
AS
SELECT c.id AS closing_id, c.sales_session_id, c.closing_date, s.location, c.version_seq, c.is_current, c.supersedes_id,
       c.rectification_reason,
       c.cash_sales, c.mp_sales, c.transfer_sales,
       c.cash_sales + c.mp_sales + c.transfer_sales                          AS total_sales,
       c.opening_float, c.expenses,
       c.opening_float + c.cash_sales - c.expenses                           AS expected_cash,
       c.counted_cash,
       c.counted_cash - (c.opening_float + c.cash_sales - c.expenses)        AS cash_difference,
       c.cash_account_id, ca.nombre::TEXT AS cash_account_name,
       c.transfer_account_id, ta.nombre::TEXT AS transfer_account_name,
       c.merma, c.notes,
       c.worksheet_path IS NOT NULL AS has_worksheet, c.worksheet_path, c.worksheet_file_name,
       c.created_at, c.created_by
  FROM sales_session_closing c
  JOIN sales_session s ON s.id = c.sales_session_id
  JOIN financial_account ca ON ca.id = c.cash_account_id
  LEFT JOIN financial_account ta ON ta.id = c.transfer_account_id
 WHERE (SELECT current_app_role()) = 'ADMIN';

ALTER  VIEW report_feria_closing OWNER TO postgres;
REVOKE ALL    ON report_feria_closing FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON report_feria_closing TO authenticated;

-- ── P&L: summarized Feria expense (category class) and "Diferencia de caja" ──
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
   WHERE pu.is_current

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
) u
WHERE (SELECT current_app_role()) = 'ADMIN';

-- pnl_summary: existing columns unchanged in name and order; "diferencia_caja" is
-- appended, and it is part of the operating result and of every later subtotal
CREATE OR REPLACE VIEW pnl_summary
WITH (security_invoker = true)
AS
WITH b AS (
  SELECT period,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'VENTAS_NETAS'), 0)               AS ventas_netas_devengadas,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'COSTOS_DIRECTOS'), 0)            AS costos_directos,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'COSTOS_INDIRECTOS'), 0)          AS costos_indirectos,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'DIFERENCIA_CAJA'), 0)            AS diferencia_caja,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'OTROS_INGRESOS_FINANCIEROS'), 0) AS otros_ingresos_financieros,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'REINVERSION'), 0)                AS reinversion,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'RETIROS'), 0)                    AS retiros,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'RESERVAS_INTERNAS'), 0)          AS reservas_internas,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'INVERSIONES'), 0)                AS inversiones
    FROM pnl_line_item
   GROUP BY period
)
SELECT period,
       ventas_netas_devengadas, costos_directos, costos_indirectos,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja                 AS resultado_operativo,
       otros_ingresos_financieros,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja
         + otros_ingresos_financieros                                                                   AS resultado_antes_de_reinversion,
       reinversion,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja
         + otros_ingresos_financieros + reinversion                                                     AS resultado_post_reinversion,
       retiros,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja
         + otros_ingresos_financieros + reinversion + retiros                                           AS disponible_post_retiros,
       reservas_internas,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja
         + otros_ingresos_financieros + reinversion + retiros + reservas_internas                       AS post_reservas,
       inversiones,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja
         + otros_ingresos_financieros + reinversion + retiros + reservas_internas + inversiones         AS resultado_post_inversiones,
       diferencia_caja
  FROM b;

-- ── Storage: private bucket `feria-worksheets` (ADR-008 pattern) ─────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('feria-worksheets', 'feria-worksheets', false, 10485760,
        ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
CREATE POLICY feria_worksheets_admin_select ON storage.objects
  FOR SELECT TO authenticated
  USING (CASE WHEN bucket_id = 'feria-worksheets' THEN public.current_app_role() = 'ADMIN' ELSE false END);
CREATE POLICY feria_worksheets_admin_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (CASE WHEN bucket_id = 'feria-worksheets'
                   THEN public.current_app_role() = 'ADMIN' AND (storage.foldername(name))[1] = auth.uid()::TEXT
                   ELSE false END);
CREATE POLICY feria_worksheets_admin_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (CASE WHEN bucket_id = 'feria-worksheets' THEN public.current_app_role() = 'ADMIN' ELSE false END);
