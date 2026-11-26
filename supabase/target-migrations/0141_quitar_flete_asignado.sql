-- ============================================================================
-- TARGET V1 — 0141 QUITAR UN FLETE ASIGNADO (owner decision 2026-11-26)
--
--   A feed freight was allocated to a purchase with the wrong amount (60.000 of 255.000 when the whole freight was that invoice's) and
--   allocate_feed_freight allows one allocation per (freight, purchase): there was no way back.
--   * unallocate_feed_freight(freight, purchase, reason) (ADMIN, audited): removes that one allocation, so its amount is free again on
--     the freight and can be allocated anew. The freight expense, its payment and the purchase are untouched; only the costing changes
--     (report_feed_purchase reads the allocations). Same advisory lock as allocate_feed_freight.
--   No data is written by this migration; DEFINER count 181 → 182.
-- ============================================================================

CREATE FUNCTION unallocate_feed_freight(p_freight_purchase_id UUID, p_purchase_id UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_froot   UUID;
  v_root    UUID;
  v_freight purchases;
  v_row     feed_freight_allocation;
  v_left    NUMERIC;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 OR length(trim(p_reason)) > 200 THEN
    RAISE EXCEPTION 'INVALID_REASON';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM purchases WHERE id = p_freight_purchase_id) OR NOT EXISTS (SELECT 1 FROM purchases WHERE id = p_purchase_id) THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  v_froot := purchase_chain_root(p_freight_purchase_id);
  v_root := purchase_chain_root(p_purchase_id);
  PERFORM pg_advisory_xact_lock(hashtext('feed_freight_allocation'), hashtext(v_froot::TEXT));
  SELECT * INTO v_freight FROM purchases WHERE purchase_chain_root(id) = v_froot AND is_current;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  SELECT * INTO v_row FROM feed_freight_allocation WHERE freight_purchase_root_id = v_froot AND purchase_root_id = v_root FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ALLOCATION_NOT_FOUND';
  END IF;

  DELETE FROM feed_freight_allocation WHERE id = v_row.id;
  v_left := v_freight.amount_total - COALESCE((SELECT SUM(amount) FROM feed_freight_allocation WHERE freight_purchase_root_id = v_froot), 0);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, performed_by, reason)
  VALUES ('feed_freight_allocation', v_froot::TEXT, 'UNALLOCATE',
          jsonb_build_object('purchase_root_id', v_root, 'amount', v_row.amount, 'allocated_by', v_row.allocated_by, 'allocated_at', v_row.allocated_at),
          jsonb_build_object('remaining', v_left), v_uid, trim(p_reason));

  RETURN jsonb_build_object('freight_purchase_root_id', v_froot, 'purchase_root_id', v_root, 'released', v_row.amount, 'remaining', v_left);
END;
$$;
ALTER  FUNCTION unallocate_feed_freight(UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION unallocate_feed_freight(UUID, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION unallocate_feed_freight(UUID, UUID, TEXT) TO authenticated;
