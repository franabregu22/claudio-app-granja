-- ============================================================================
-- TARGET V1 — 0100 PEDIDOS: CORRELATIVE ORDER NUMBER + DELIVERY RESPONSIBLE (owner GO 2026-10-19)
--
-- 1 order = 1 delivery. Master / attribution data only: no financial operation, no ledger, no P&L change.
--   1. numero_pedido (existing BIGINT UNIQUE) becomes mandatory and permanent:
--        * existing numbers (the 129 migrated orders keep their legacy number) are never changed;
--        * orders without a number are numbered max + 1, max + 2 … in creation order (created_at, id);
--        * every new order (PENDING form, Feria aggregated orders, later cancelled ones) is numbered by the database:
--          max + 1 under a transaction-scoped advisory lock (concurrent inserts are serialized; UNIQUE stays the backstop);
--          a client-supplied number is refused; gaps are allowed;
--        * no UPDATE (direct API or RPC) can change it.
--   2. delivered_by: the ADMIN who confirmed the delivery (auth.uid() in deliver_order). Set only on the PENDING → DELIVERED
--      transition and only to the caller; never changed afterwards (a rectification keeps it); never derived from
--      updated_by / created_by. History: filled only from an unambiguous audit_events DELIVER (exactly one event, one
--      performer, an existing profile); orders without that evidence (the migrated deliveries) stay NULL ("No disponible").
-- The guard trigger is INVOKER (no SECURITY DEFINER added: set unchanged at 94); deliver_order keeps its signature,
-- SECURITY DEFINER and grants.
-- ============================================================================

LOCK TABLE pedidos IN SHARE ROW EXCLUSIVE MODE;

-- ── 1. order number: back-fill (existing numbers untouched) ─────────────────
WITH base AS (SELECT coalesce(max(numero_pedido), 0) AS m FROM pedidos),
     n AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS r FROM pedidos WHERE numero_pedido IS NULL)
UPDATE pedidos p SET numero_pedido = base.m + n.r FROM n, base WHERE p.id = n.id;

ALTER TABLE pedidos ALTER COLUMN numero_pedido SET NOT NULL;
ALTER TABLE pedidos ADD CONSTRAINT chk_pedidos_numero_positive CHECK (numero_pedido > 0);
COMMENT ON COLUMN pedidos.numero_pedido IS 'Correlative order number: assigned by the database on insert, permanent (0100)';

-- ── 2. delivery responsible ─────────────────────────────────────────────────
ALTER TABLE pedidos ADD COLUMN delivered_by UUID;
ALTER TABLE pedidos ADD CONSTRAINT pedidos_delivered_by_fkey FOREIGN KEY (delivered_by) REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE;
COMMENT ON COLUMN pedidos.delivered_by IS 'ADMIN who confirmed the delivery (deliver_order, auth.uid()); NULL = no evidence (0100)';

WITH d AS (
  SELECT a.entity_id, min(a.performed_by::text)::uuid AS uid
    FROM audit_events a
   WHERE a.entity_type = 'pedido' AND a.action = 'DELIVER'
   GROUP BY a.entity_id
  HAVING count(*) = 1 AND count(a.performed_by) = 1)
UPDATE pedidos p SET delivered_by = d.uid
  FROM d JOIN perfiles pf ON pf.id = d.uid
 WHERE p.id::text = d.entity_id AND p.estado = 'DELIVERED';

-- ── 3. guard: number assigned on insert, number and responsible immutable ──
CREATE OR REPLACE FUNCTION pedidos_numero_entrega_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.numero_pedido IS NOT NULL THEN
      RAISE EXCEPTION 'ORDER_NUMBER_ASSIGNED_BY_SYSTEM: an order number cannot be supplied';
    END IF;
    IF NEW.delivered_by IS NOT NULL THEN
      RAISE EXCEPTION 'DELIVERED_BY_SET_ON_DELIVERY_ONLY: the delivery responsible is recorded by deliver_order';
    END IF;
    -- serialize numbering (released at commit / rollback); then the next number above every existing one
    PERFORM pg_advisory_xact_lock(7410100);
    SELECT coalesce(max(numero_pedido), 0) + 1 INTO NEW.numero_pedido FROM pedidos;
    RETURN NEW;
  END IF;
  IF NEW.numero_pedido IS DISTINCT FROM OLD.numero_pedido THEN
    RAISE EXCEPTION 'ORDER_NUMBER_IMMUTABLE: order % keeps number %', OLD.id, OLD.numero_pedido;
  END IF;
  IF NEW.delivered_by IS DISTINCT FROM OLD.delivered_by
     AND NOT (OLD.delivered_by IS NULL AND OLD.estado = 'PENDING' AND NEW.estado = 'DELIVERED' AND NEW.delivered_by = auth.uid()) THEN
    RAISE EXCEPTION 'DELIVERED_BY_IMMUTABLE: the delivery responsible is recorded once, by the confirming ADMIN';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION pedidos_numero_entrega_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION pedidos_numero_entrega_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_pedidos_numero_entrega_guard BEFORE INSERT OR UPDATE ON pedidos
  FOR EACH ROW EXECUTE FUNCTION pedidos_numero_entrega_guard();

-- ── 4. deliver_order records the responsible (body of 0011 + delivered_by) ──
CREATE OR REPLACE FUNCTION deliver_order(
  p_order_id     UUID,
  p_delivered_at TIMESTAMPTZ,
  p_reason       TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            UUID := auth.uid();
  v_order          pedidos;
  v_delivered_date DATE;
  v_total          NUMERIC(15,2);
  v_client_name    TEXT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;

  SELECT * INTO v_order FROM pedidos WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;
  IF v_order.estado <> 'PENDING' THEN
    RAISE EXCEPTION 'ORDER_NOT_PENDING: current state is %', v_order.estado;
  END IF;

  v_delivered_date := (p_delivered_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
  PERFORM assert_period_open(v_delivered_date);

  SELECT COALESCE(SUM(subtotal), 0) INTO v_total
    FROM pedido_lineas
   WHERE pedido_id = p_order_id AND is_current = true;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'ORDER_HAS_NO_LINES';
  END IF;

  -- contract validation list: client activo = true
  SELECT nombre INTO v_client_name FROM clients WHERE id = v_order.cliente_id AND activo = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND_OR_INACTIVE';
  END IF;

  UPDATE pedidos
     SET estado = 'DELIVERED', delivered_at = p_delivered_at, delivered_date = v_delivered_date,
         delivered_by = v_uid,   -- [0100] the confirming ADMIN
         updated_at = NOW(), updated_by = v_uid
   WHERE id = p_order_id;

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_order.cliente_id, 'SALE_DELIVERY', v_total, v_delivered_date,
          v_client_name, 'pedido', p_order_id::TEXT, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('pedido', p_order_id::TEXT, 'DELIVER',
          jsonb_build_object('estado', 'PENDING'),
          jsonb_build_object('estado', 'DELIVERED', 'delivered_date', v_delivered_date, 'total', v_total),
          p_reason, v_uid);

  RETURN jsonb_build_object(
    'id', p_order_id, 'estado', 'DELIVERED', 'delivered_at', p_delivered_at,
    'delivered_date', v_delivered_date, 'order_total', v_total);
END;
$$;
-- CREATE OR REPLACE keeps the existing ACL (0011 / 0069: authenticated + service_role, no anon); owner restated only
ALTER  FUNCTION deliver_order(UUID, TIMESTAMPTZ, TEXT) OWNER TO postgres;

-- ── 5. gate ─────────────────────────────────────────────────────────────────
DO $$
DECLARE v_null INTEGER; v_dup INTEGER; v_by INTEGER; v_del INTEGER;
BEGIN
  SELECT count(*) FILTER (WHERE numero_pedido IS NULL), count(*) - count(DISTINCT numero_pedido) INTO v_null, v_dup FROM pedidos;
  IF v_null > 0 OR v_dup > 0 THEN
    RAISE EXCEPTION 'ORDER_NUMBER_BACKFILL_FAILED: % without number, % duplicated', v_null, v_dup;
  END IF;
  SELECT count(delivered_by), count(*) INTO v_by, v_del FROM pedidos WHERE estado = 'DELIVERED';
  IF (SELECT count(*) FROM pedidos WHERE delivered_by IS NOT NULL AND estado <> 'DELIVERED') > 0 THEN
    RAISE EXCEPTION 'DELIVERED_BY_BACKFILL_FAILED: a responsible on an order that is not delivered';
  END IF;
  RAISE NOTICE '0100: % orders numbered (max %), % / % deliveries with a verifiable responsible',
    (SELECT count(*) FROM pedidos), (SELECT max(numero_pedido) FROM pedidos), v_by, v_del;
END $$;
