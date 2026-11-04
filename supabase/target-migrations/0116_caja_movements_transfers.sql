-- ============================================================================
-- TARGET V1 — 0116 CAJA: MOVIMIENTOS UNIFICADOS, TRANSFERENCIAS ANTICIPADAS E IMPUESTOS YA REGISTRADOS (owner GO 2026-11-04)
--
-- No existing row, balance, posting, match or cut changes. fin_movement_history (0113) stays as it is (the published frontend uses it).
--   1. fin_movement_list (RPC, ADMIN, STABLE): the 0113 history plus, in ONE paginated list,
--      · each operation's state (REGISTRADO / CONCILIADO / SIN_CONCILIAR / PENDIENTE_CLASIFICAR / SIN_CLASIFICAR) and its evidence:
--        the bank statement lines matched to its postings and the Mercado Pago movements reconciled to it;
--      · the bank statement lines after the active cut with no active match (kind SIN_VINCULAR), shown once, to be resolved;
--      · the "Por resolver" filters on the same list: MP_CLASIFICAR (fin_mp_pending_classification), GASTO_SIN_CLASIFICAR
--        (fin_expense_pending_classification) and ENTRADA_SIN_VINCULAR (fin_mp_unlinked_inflows: the inflow operation of each movement),
--        with the key the row's action needs. Their counts are the views' counts.
--      · for a transfer: its related bank taxes and the anticipated transfer it settled.
--   2. fin_transfer_intent + fin_register_transfer_intent / fin_link_transfer_intent / fin_cancel_transfer_intent (ADMIN): a transfer
--      between Mercado Pago and an own bank account registered BEFORE the Mercado Pago movement exists. It moves no money (0091: every
--      Mercado Pago posting needs its movement). When the movement arrives it is linked: the existing routes create the ONE transfer
--      (mp_confirm_payout_transfer / mp_reclassify_inbound_own_transfer) and the intent records it, in one transaction; or an already
--      confirmed transfer of the same accounts and amount is linked. A second transfer is never created.
--   3. fin_relate_bank_tax (ADMIN): a debits/credits tax already recorded (from the statement or by hand) is associated to its
--      transfer instead of recording it again.
--   4. fin_statement_charge_proposal: a tax line whose charge is ALREADY recorded (same account, same amount, ±3 days, not matched)
--      is RECORDED, never PROPOSED: booking it again is refused; fin_statement_charge_proposals returns the posting to match it with.
-- SECURITY DEFINER set +5 (fin_movement_list, the three intent RPCs, fin_relate_bank_tax).
-- ============================================================================

-- ── 1. the unified list ───────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION fin_movement_list(
  p_from       DATE    DEFAULT NULL,
  p_to         DATE    DEFAULT NULL,
  p_account_id UUID    DEFAULT NULL,
  p_kind       TEXT    DEFAULT NULL,
  p_search     TEXT    DEFAULT NULL,
  p_amount     NUMERIC DEFAULT NULL,
  p_pending    TEXT    DEFAULT NULL,
  p_scope      TEXT    DEFAULT NULL,
  p_limit      INTEGER DEFAULT 50,
  p_offset     INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_search TEXT := nullif(btrim(p_search), '');
  v_like   TEXT;
  v_amount NUMERIC := abs(p_amount);
  v_mp     UUID;
  v_out    JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'INVALID_LIMIT: 1 to 100';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'INVALID_OFFSET';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'INVALID_RANGE: from after to';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('TRANSFERENCIA', 'COBRO', 'PAGO', 'CARGO', 'PENDIENTE_MP', 'OTRO', 'SIN_VINCULAR') THEN
    RAISE EXCEPTION 'INVALID_KIND';
  END IF;
  IF p_pending IS NOT NULL AND p_pending NOT IN ('MP_CLASIFICAR', 'GASTO_SIN_CLASIFICAR', 'ENTRADA_SIN_VINCULAR') THEN
    RAISE EXCEPTION 'INVALID_PENDING';
  END IF;
  IF p_scope IS NOT NULL AND (p_scope NOT IN ('CURRENT', 'HISTORICAL') OR p_pending IS NULL OR p_pending NOT IN ('MP_CLASIFICAR', 'ENTRADA_SIN_VINCULAR')) THEN
    RAISE EXCEPTION 'INVALID_SCOPE';
  END IF;
  IF length(v_search) > 100 THEN
    RAISE EXCEPTION 'INVALID_SEARCH: at most 100 characters';
  END IF;
  v_like := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE';

  WITH pend AS MATERIALIZED (
    SELECT DISTINCT ON (x.op_id) x.op_id, x.pkey FROM (
      SELECT v.financial_operation_id AS op_id,
             jsonb_build_object('type', 'MP_CLASIFICAR', 'source_id', v.source_id, 'historical', v.is_historical) AS pkey
        FROM fin_mp_pending_classification v
       WHERE p_pending = 'MP_CLASIFICAR' AND v.financial_operation_id IS NOT NULL
         AND (p_scope IS NULL OR v.is_historical = (p_scope = 'HISTORICAL'))
      UNION ALL
      SELECT e.payment_operation_id, jsonb_build_object('type', 'GASTO_SIN_CLASIFICAR', 'pending_id', e.pending_id)
        FROM fin_expense_pending_classification e
       WHERE p_pending = 'GASTO_SIN_CLASIFICAR' AND e.status = 'SIN_CLASIFICAR'
      UNION ALL
      (SELECT DISTINCT ON (u.movement_id) r.financial_operation_id,
              jsonb_build_object('type', 'ENTRADA_SIN_VINCULAR', 'movement_id', u.movement_id, 'source_id', u.source_id, 'historical', u.is_historical)
         FROM fin_mp_unlinked_inflows u
         JOIN mp_reconciliation r ON r.mp_financial_movement_id = u.movement_id AND r.assigned_amount > 0
        WHERE p_pending = 'ENTRADA_SIN_VINCULAR' AND (p_scope IS NULL OR u.is_historical = (p_scope = 'HISTORICAL'))
        ORDER BY u.movement_id, r.assigned_amount DESC, r.financial_operation_id)
    ) x
    ORDER BY x.op_id
  ), f AS MATERIALIZED (
    SELECT o.id, o.effective_date, o.operation_type::TEXT AS operation_type, o.external_ref, o.reason, o.source_entity_type,
           o.created_at, o.created_by, c.kind, c.label
      FROM financial_operation o
     CROSS JOIN LATERAL fin_movement_class(o.operation_type::TEXT, o.external_ref) c
     WHERE (p_kind IS DISTINCT FROM 'SIN_VINCULAR')
       AND (p_from IS NULL OR o.effective_date >= p_from)
       AND (p_to IS NULL OR o.effective_date <= p_to)
       AND (p_kind IS NULL OR c.kind = p_kind)
       AND (p_pending IS NULL OR EXISTS (SELECT 1 FROM pend WHERE pend.op_id = o.id))
       AND EXISTS (SELECT 1 FROM financial_posting p
                    WHERE p.financial_operation_id = o.id AND (p_account_id IS NULL OR p.financial_account_id = p_account_id))
       AND ((v_search IS NULL AND v_amount IS NULL)
         OR (v_search IS NOT NULL AND (c.label ILIKE v_like OR o.reason ILIKE v_like OR o.external_ref ILIKE v_like OR o.id::TEXT = v_search))
         OR (v_amount IS NOT NULL AND EXISTS (SELECT 1 FROM financial_posting p
                    WHERE p.financial_operation_id = o.id AND abs(p.signed_amount) = v_amount
                      AND (p_account_id IS NULL OR p.financial_account_id = p_account_id))))
  ), ln AS MATERIALIZED (
    -- bank evidence still to resolve: after the active cut, no active match (a pre-cut cheque line is settled by its evidence row)
    SELECT l.id, l.value_date
      FROM fin_statement_line l
     WHERE p_pending IS NULL AND (p_kind IS NULL OR p_kind = 'SIN_VINCULAR')
       AND (p_account_id IS NULL OR l.financial_account_id = p_account_id)
       AND (p_from IS NULL OR l.value_date >= p_from)
       AND (p_to IS NULL OR l.value_date <= p_to)
       AND ((v_search IS NULL AND v_amount IS NULL)
         OR (v_search IS NOT NULL AND (l.description_raw ILIKE v_like OR l.bank_reference ILIKE v_like))
         OR (v_amount IS NOT NULL AND abs(l.signed_amount) = v_amount))
       AND NOT EXISTS (SELECT 1 FROM fin_statement_match m WHERE m.statement_line_id = l.id AND m.reversed_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM fin_instrument_precut_debit d WHERE d.statement_line_id = l.id)
       AND EXISTS (SELECT 1 FROM fin_statement_cutover c WHERE c.financial_account_id = l.financial_account_id AND c.superseded_at IS NULL)
       AND fin_statement_line_cut_class(l.id) = 'POST_CUTOVER'
  ), u AS (
    SELECT 'OP' AS t, id, effective_date AS d FROM f
    UNION ALL
    SELECT 'LINE', id, value_date FROM ln
  ), page AS (
    SELECT * FROM u ORDER BY d DESC, (t = 'OP') DESC, id DESC LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM u),
    'lines_total', (SELECT count(*) FROM ln),
    'rows', coalesce((
      SELECT jsonb_agg(r.j ORDER BY r.d DESC, (r.t = 'OP') DESC, r.id DESC) FROM (
        -- operations
        SELECT pg.t, pg.id, pg.d, jsonb_build_object(
                 'row_type', 'OP', 'operation_id', g.id, 'effective_date', g.effective_date, 'kind', g.kind, 'label', g.label,
                 'operation_type', g.operation_type, 'reason', g.reason, 'external_ref', g.external_ref, 'source_entity_type', g.source_entity_type,
                 'created_at', g.created_at, 'created_by', g.created_by,
                 'net_amount', m.net_amount, 'moved_amount', m.moved_amount, 'postings', m.postings,
                 'status', CASE
                   WHEN g.kind = 'PENDIENTE_MP' THEN 'PENDIENTE_CLASIFICAR'
                   WHEN EXISTS (SELECT 1 FROM expense_pending_classification e
                                 WHERE e.payment_operation_id = g.id
                                   AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = e.payment_operation_id AND pu.is_current)) THEN 'SIN_CLASIFICAR'
                   WHEN ev.need > 0 AND ev.matched < ev.need THEN 'SIN_CONCILIAR'
                   WHEN ev.need > 0 OR ev.mp > 0 THEN 'CONCILIADO'
                   ELSE 'REGISTRADO' END,
                 'bank', ev.bank, 'mp', ev.mpev,
                 'pending', (SELECT pend.pkey FROM pend WHERE pend.op_id = g.id),
                 'related_taxes', CASE WHEN g.operation_type = 'TRANSFER' THEN (
                     SELECT coalesce(jsonb_agg(jsonb_build_object('operation_id', t.financial_operation_id, 'amount', t.amount, 'account_name', a.nombre,
                              'matched', EXISTS (SELECT 1 FROM financial_posting tp JOIN fin_statement_match tm ON tm.financial_posting_id = tp.id AND tm.reversed_at IS NULL
                                                  WHERE tp.financial_operation_id = t.financial_operation_id)) ORDER BY t.financial_operation_id), '[]'::jsonb)
                       FROM bank_tax_charge t JOIN financial_account a ON a.id = t.financial_account_id WHERE t.related_operation_id = g.id) END,
                 'transfer_intent', (SELECT jsonb_build_object('intent_id', ti.id, 'effective_date', ti.effective_date) FROM fin_transfer_intent ti WHERE ti.transfer_operation_id = g.id)
               ) AS j
          FROM page pg
          JOIN f g ON pg.t = 'OP' AND g.id = pg.id
         CROSS JOIN LATERAL (
           SELECT coalesce(sum(p.signed_amount) FILTER (WHERE p_account_id IS NULL OR p.financial_account_id = p_account_id), 0) AS net_amount,
                  greatest(coalesce(sum(p.signed_amount) FILTER (WHERE p.signed_amount > 0), 0), abs(coalesce(sum(p.signed_amount) FILTER (WHERE p.signed_amount < 0), 0))) AS moved_amount,
                  jsonb_agg(jsonb_build_object('posting_id', p.id, 'account_id', a.id, 'account_name', a.nombre, 'account_type', a.account_type, 'signed_amount', p.signed_amount) ORDER BY p.signed_amount, p.id) AS postings
             FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id
            WHERE p.financial_operation_id = g.id) m
         CROSS JOIN LATERAL (
           SELECT count(*) FILTER (WHERE q.needs) AS need,
                  count(*) FILTER (WHERE q.needs AND q.line_id IS NOT NULL) AS matched,
                  (SELECT count(*) FROM mp_reconciliation rr WHERE rr.financial_operation_id = g.id) AS mp,
                  coalesce(jsonb_agg(jsonb_build_object('statement_line_id', q.line_id, 'account_name', q.account_name, 'value_date', q.value_date,
                             'description_raw', q.description_raw, 'bank_reference', q.bank_reference, 'signed_amount', q.line_amount,
                             'running_balance', q.running_balance, 'matched_at', q.matched_at) ORDER BY q.value_date, q.line_id)
                           FILTER (WHERE q.line_id IS NOT NULL), '[]'::jsonb) AS bank,
                  (SELECT coalesce(jsonb_agg(jsonb_build_object('movement_id', mv.id, 'occurred_date', mv.occurred_date, 'movement_kind', mv.movement_kind,
                             'gross_amount', mv.gross_amount, 'net_amount', mv.net_amount, 'assigned_amount', rr.assigned_amount, 'source_id', ti.source_id)
                             ORDER BY mv.id), '[]'::jsonb)
                     FROM mp_reconciliation rr JOIN mp_financial_movement mv ON mv.id = rr.mp_financial_movement_id
                     LEFT JOIN LATERAL (SELECT CASE WHEN t.resource_type = 'payment' THEN t.resource_id::TEXT ELSE split_part(t.resource_id::TEXT, ':', 1) END AS source_id
                                          FROM mp_transition_identity t WHERE t.mp_financial_movement_id = mv.id
                                         ORDER BY (t.transition = 'APPROVAL') DESC, t.id LIMIT 1) ti ON true
                    WHERE rr.financial_operation_id = g.id) AS mpev
             FROM (
               SELECT p.id AS posting_id, a.nombre AS account_name,
                      (cut.anchor_date IS NOT NULL AND p.effective_date > cut.anchor_date) OR sm.id IS NOT NULL AS needs,
                      sl.id AS line_id, sl.value_date, sl.description_raw, sl.bank_reference, sl.signed_amount AS line_amount, sl.running_balance, sm.matched_at
                 FROM financial_posting p
                 JOIN financial_account a ON a.id = p.financial_account_id
                 LEFT JOIN LATERAL (SELECT al.value_date AS anchor_date FROM fin_statement_cutover c JOIN fin_statement_line al ON al.id = c.cutoff_statement_line_id
                                     WHERE c.financial_account_id = p.financial_account_id AND c.superseded_at IS NULL) cut ON true
                 LEFT JOIN fin_statement_match sm ON sm.financial_posting_id = p.id AND sm.reversed_at IS NULL
                 LEFT JOIN fin_statement_line sl ON sl.id = sm.statement_line_id
                WHERE p.financial_operation_id = g.id AND p.financial_account_id IS DISTINCT FROM v_mp
             ) q) ev
        UNION ALL
        -- bank lines to resolve
        SELECT pg.t, pg.id, pg.d, jsonb_build_object(
                 'row_type', 'LINE', 'statement_line_id', l.id, 'effective_date', l.value_date, 'kind', 'SIN_VINCULAR',
                 'label', 'Movimiento bancario sin vincular', 'status', 'SIN_VINCULAR',
                 'account_id', a.id, 'account_name', a.nombre, 'description_raw', l.description_raw, 'bank_reference', l.bank_reference,
                 'signed_amount', l.signed_amount, 'running_balance', l.running_balance,
                 'charge', (SELECT jsonb_build_object('status', cp.status, 'kind', cp.kind, 'label', cp.label) FROM fin_statement_charge_proposal(l.id) cp)
               )
          FROM page pg
          JOIN fin_statement_line l ON pg.t = 'LINE' AND l.id = pg.id
          JOIN financial_account a ON a.id = l.financial_account_id
      ) r), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END;
$$;
ALTER  FUNCTION fin_movement_list(DATE, DATE, UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_movement_list(DATE, DATE, UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_movement_list(DATE, DATE, UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;

-- ── 2. anticipated transfers (Mercado Pago ↔ own bank account) ───────────────────────────────────────────────────────────
CREATE TABLE fin_transfer_intent (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_account_id       UUID          NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  to_account_id         UUID          NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  amount                NUMERIC(15,2) NOT NULL,
  effective_date        DATE          NOT NULL,
  reason                TEXT,
  idempotency_key       VARCHAR(100)  NOT NULL UNIQUE,
  status                TEXT          NOT NULL DEFAULT 'PENDIENTE',
  transfer_operation_id BIGINT        UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  linked_source_id      TEXT,
  linked_at             TIMESTAMPTZ,
  linked_by             UUID,
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID,
  cancel_reason         TEXT,
  created_by            UUID          NOT NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT chk_fti_amount   CHECK (amount > 0),
  CONSTRAINT chk_fti_accounts CHECK (from_account_id <> to_account_id),
  CONSTRAINT chk_fti_key      CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT chk_fti_status   CHECK (
       (status = 'PENDIENTE' AND transfer_operation_id IS NULL AND linked_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'VINCULADA' AND transfer_operation_id IS NOT NULL AND linked_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'ANULADA'   AND transfer_operation_id IS NULL AND cancelled_at IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> ''))
);
ALTER TABLE fin_transfer_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_transfer_intent OWNER TO postgres;
REVOKE ALL ON TABLE fin_transfer_intent FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE fin_transfer_intent TO authenticated;
CREATE POLICY fin_transfer_intent_admin_select ON fin_transfer_intent FOR SELECT USING (current_app_role() = 'ADMIN');

-- internal: the side of an intent ('PAYOUT': Mercado Pago → bank; 'INFLOW': bank → Mercado Pago), or the refusal code
CREATE FUNCTION fin_transfer_intent_route(p_from UUID, p_to UUID) RETURNS TEXT
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE
    WHEN mf.id IS NOT NULL AND bt.id IS NOT NULL THEN 'PAYOUT'
    WHEN mt.id IS NOT NULL AND bf.id IS NOT NULL THEN 'INFLOW'
    ELSE 'ROUTE_NOT_SUPPORTED' END
    FROM (SELECT 1) one
    LEFT JOIN financial_account mf ON mf.id = p_from AND mf.nombre = 'Mercado Pago' AND mf.account_type = 'EXTERNAL_SERVICE' AND mf.activo
    LEFT JOIN financial_account mt ON mt.id = p_to   AND mt.nombre = 'Mercado Pago' AND mt.account_type = 'EXTERNAL_SERVICE' AND mt.activo
    LEFT JOIN financial_account bt ON bt.id = p_to   AND bt.account_type = 'BANK_ACCOUNT' AND bt.activo
    LEFT JOIN financial_account bf ON bf.id = p_from AND bf.account_type = 'BANK_ACCOUNT' AND bf.activo
$$;
ALTER FUNCTION fin_transfer_intent_route(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_transfer_intent_route(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION fin_register_transfer_intent(p_from_account_id UUID, p_to_account_id UUID, p_amount NUMERIC, p_effective_date DATE,
                                             p_idempotency_key VARCHAR, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_key  TEXT := btrim(p_idempotency_key);
  v_prev fin_transfer_intent;
  v_id   BIGINT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF v_key IS NULL OR v_key = '' OR length(v_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_effective_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_DATE';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_transfer_intent:' || v_key, 0));
  SELECT * INTO v_prev FROM fin_transfer_intent WHERE idempotency_key = v_key;
  IF FOUND THEN
    IF v_prev.from_account_id = p_from_account_id AND v_prev.to_account_id = p_to_account_id AND v_prev.amount = p_amount AND v_prev.effective_date = p_effective_date THEN
      RETURN jsonb_build_object('intent_id', v_prev.id, 'replayed', true, 'status', v_prev.status);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: the key registered another transfer';
  END IF;
  IF fin_transfer_intent_route(p_from_account_id, p_to_account_id) = 'ROUTE_NOT_SUPPORTED' THEN
    RAISE EXCEPTION 'ROUTE_NOT_SUPPORTED: an anticipated transfer goes between Mercado Pago and an active own bank account; between other own accounts the transfer is recorded directly';
  END IF;
  INSERT INTO fin_transfer_intent (from_account_id, to_account_id, amount, effective_date, reason, idempotency_key, created_by)
  VALUES (p_from_account_id, p_to_account_id, p_amount, p_effective_date, nullif(btrim(p_reason), ''), v_key, v_uid)
  RETURNING id INTO v_id;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('fin_transfer_intent', v_id::TEXT, 'REGISTER',
          jsonb_build_object('from', p_from_account_id, 'to', p_to_account_id, 'amount', p_amount, 'effective_date', p_effective_date),
          nullif(btrim(p_reason), ''), v_uid);
  RETURN jsonb_build_object('intent_id', v_id, 'replayed', false, 'status', 'PENDIENTE');
END;
$$;
ALTER  FUNCTION fin_register_transfer_intent(UUID, UUID, NUMERIC, DATE, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_register_transfer_intent(UUID, UUID, NUMERIC, DATE, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_register_transfer_intent(UUID, UUID, NUMERIC, DATE, VARCHAR, TEXT) TO authenticated;

-- link: exactly one of p_source_id (the Mercado Pago movement just arrived: the existing route creates the transfer) or
-- p_operation_id (a transfer already confirmed); the transfer must move exactly the intent's amount between the intent's accounts
CREATE FUNCTION fin_link_transfer_intent(p_intent_id BIGINT, p_source_id TEXT DEFAULT NULL, p_operation_id BIGINT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_it    fin_transfer_intent;
  v_route TEXT;
  v_res   JSONB;
  v_op    BIGINT;
  v_shape TEXT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF (nullif(btrim(p_source_id), '') IS NULL) = (p_operation_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_LINK: give the Mercado Pago movement or the transfer operation, one of them';
  END IF;
  SELECT * INTO v_it FROM fin_transfer_intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND';
  END IF;
  IF v_it.status = 'VINCULADA' THEN
    IF (p_operation_id IS NOT NULL AND v_it.transfer_operation_id = p_operation_id) OR (p_source_id IS NOT NULL AND v_it.linked_source_id = btrim(p_source_id)) THEN
      RETURN jsonb_build_object('intent_id', v_it.id, 'replayed', true, 'transfer_operation_id', v_it.transfer_operation_id);
    END IF;
    RAISE EXCEPTION 'INTENT_ALREADY_LINKED: transfer %', v_it.transfer_operation_id;
  END IF;
  IF v_it.status <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'INTENT_CANCELLED';
  END IF;
  v_route := fin_transfer_intent_route(v_it.from_account_id, v_it.to_account_id);
  IF p_operation_id IS NOT NULL THEN
    v_op := p_operation_id;
    IF NOT EXISTS (SELECT 1 FROM financial_operation WHERE id = v_op AND operation_type::TEXT = 'TRANSFER') THEN
      RAISE EXCEPTION 'TRANSFER_NOT_FOUND';
    END IF;
  ELSIF v_route = 'PAYOUT' THEN
    v_res := mp_confirm_payout_transfer(btrim(p_source_id));
    v_op  := (v_res ->> 'transfer_operation_id')::BIGINT;
  ELSIF v_route = 'INFLOW' THEN
    v_res := mp_reclassify_inbound_own_transfer(btrim(p_source_id), v_it.from_account_id, 'Transferencia registrada antes del movimiento (intención ' || v_it.id || ')');
    v_op  := (v_res ->> 'transfer_operation_id')::BIGINT;
  ELSE
    RAISE EXCEPTION 'ROUTE_NOT_SUPPORTED';
  END IF;
  -- the one transfer must be exactly the intent: amount out of the origin, the same amount into the destination, nothing else
  SELECT string_agg(financial_account_id::TEXT || ':' || signed_amount, ',' ORDER BY signed_amount) INTO v_shape FROM financial_posting WHERE financial_operation_id = v_op;
  IF v_shape IS DISTINCT FROM (v_it.from_account_id::TEXT || ':' || (-v_it.amount)::NUMERIC(15,2) || ',' || v_it.to_account_id::TEXT || ':' || v_it.amount::NUMERIC(15,2)) THEN
    RAISE EXCEPTION 'TRANSFER_MISMATCH: the transfer does not move % from the intent''s origin to its destination', v_it.amount;
  END IF;
  IF EXISTS (SELECT 1 FROM fin_transfer_intent WHERE transfer_operation_id = v_op) THEN
    RAISE EXCEPTION 'TRANSFER_ALREADY_LINKED: transfer % settles another intent', v_op;
  END IF;
  UPDATE fin_transfer_intent SET status = 'VINCULADA', transfer_operation_id = v_op, linked_source_id = nullif(btrim(p_source_id), ''),
         linked_at = now(), linked_by = v_uid
   WHERE id = v_it.id;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('fin_transfer_intent', v_it.id::TEXT, 'LINK', jsonb_build_object('status', 'PENDIENTE'),
          jsonb_build_object('status', 'VINCULADA', 'transfer_operation_id', v_op, 'source_id', nullif(btrim(p_source_id), '')), NULL, v_uid);
  RETURN jsonb_build_object('intent_id', v_it.id, 'replayed', false, 'transfer_operation_id', v_op);
END;
$$;
ALTER  FUNCTION fin_link_transfer_intent(BIGINT, TEXT, BIGINT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_link_transfer_intent(BIGINT, TEXT, BIGINT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_link_transfer_intent(BIGINT, TEXT, BIGINT) TO authenticated;

CREATE FUNCTION fin_cancel_transfer_intent(p_intent_id BIGINT, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_it  fin_transfer_intent;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  SELECT * INTO v_it FROM fin_transfer_intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND';
  END IF;
  IF v_it.status = 'ANULADA' THEN
    RETURN jsonb_build_object('intent_id', v_it.id, 'replayed', true);
  END IF;
  IF v_it.status <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'INTENT_ALREADY_LINKED: a linked transfer is corrected on its operation, not here';
  END IF;
  UPDATE fin_transfer_intent SET status = 'ANULADA', cancelled_at = now(), cancelled_by = v_uid, cancel_reason = btrim(p_reason) WHERE id = v_it.id;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('fin_transfer_intent', v_it.id::TEXT, 'CANCEL', jsonb_build_object('status', 'PENDIENTE'), jsonb_build_object('status', 'ANULADA'), btrim(p_reason), v_uid);
  RETURN jsonb_build_object('intent_id', v_it.id, 'replayed', false);
END;
$$;
ALTER  FUNCTION fin_cancel_transfer_intent(BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_cancel_transfer_intent(BIGINT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_cancel_transfer_intent(BIGINT, TEXT) TO authenticated;

-- ── 3. a recorded debits/credits tax associated to its transfer (never recorded twice) ───────────────────────────────────
CREATE FUNCTION fin_relate_bank_tax(p_tax_operation_id BIGINT, p_transfer_operation_id BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tax bank_tax_charge;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  SELECT * INTO v_tax FROM bank_tax_charge WHERE financial_operation_id = p_tax_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BANK_TAX_NOT_FOUND';
  END IF;
  IF v_tax.tax_kind <> 'DEBITOS_CREDITOS' THEN
    RAISE EXCEPTION 'NOT_A_DEBITS_CREDITS_TAX';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_operation WHERE id = p_transfer_operation_id AND operation_type::TEXT = 'TRANSFER') THEN
    RAISE EXCEPTION 'RELATED_TRANSFER_NOT_FOUND';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_posting WHERE financial_operation_id = p_transfer_operation_id AND financial_account_id = v_tax.financial_account_id) THEN
    RAISE EXCEPTION 'ACCOUNT_MISMATCH: the tax account is not an account of the transfer';
  END IF;
  IF v_tax.related_operation_id = p_transfer_operation_id THEN
    RETURN jsonb_build_object('tax_operation_id', p_tax_operation_id, 'replayed', true);
  END IF;
  IF v_tax.related_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_TAX_ALREADY_RELATED: operation %', v_tax.related_operation_id;
  END IF;
  UPDATE bank_tax_charge SET related_operation_id = p_transfer_operation_id WHERE financial_operation_id = p_tax_operation_id;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('financial_operation', p_tax_operation_id::TEXT, 'RELATE_BANK_TAX', jsonb_build_object('related_operation_id', NULL),
          jsonb_build_object('related_operation_id', p_transfer_operation_id), nullif(btrim(p_reason), ''), v_uid);
  RETURN jsonb_build_object('tax_operation_id', p_tax_operation_id, 'replayed', false);
END;
$$;
ALTER  FUNCTION fin_relate_bank_tax(BIGINT, BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_relate_bank_tax(BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_relate_bank_tax(BIGINT, BIGINT, TEXT) TO authenticated;

-- ── 4. a statement tax line whose charge is already recorded is never booked again ───────────────────────────────────────
-- internal: the unmatched recorded tax postings a line can be matched with (same account, same amount, ±3 days, tax kind of the rule)
CREATE FUNCTION fin_statement_recorded_charges(p_line_id BIGINT, p_kind TEXT) RETURNS SETOF BIGINT
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT p.id
    FROM fin_statement_line l
    JOIN bank_tax_charge t ON t.financial_account_id = l.financial_account_id
                          AND t.tax_kind::TEXT = CASE p_kind WHEN 'BANK_TAX_DEBCRED' THEN 'DEBITOS_CREDITOS' WHEN 'BANK_IVA' THEN 'IVA' END
    JOIN financial_posting p ON p.financial_operation_id = t.financial_operation_id AND p.financial_account_id = l.financial_account_id
   WHERE l.id = p_line_id
     AND p.signed_amount = l.signed_amount
     AND p.effective_date BETWEEN l.value_date - 3 AND l.value_date + 3
     AND NOT EXISTS (SELECT 1 FROM fin_statement_match m WHERE m.financial_posting_id = p.id AND m.reversed_at IS NULL)
   ORDER BY abs(p.effective_date - l.value_date), p.id
$$;
ALTER FUNCTION fin_statement_recorded_charges(BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_recorded_charges(BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION fin_statement_charge_proposal(p_line_id BIGINT,
  OUT status TEXT, OUT kind TEXT, OUT rule_id BIGINT, OUT label TEXT, OUT expense_category_id UUID)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_line  fin_statement_line;
  v_kinds INTEGER;
BEGIN
  SELECT * INTO v_line FROM fin_statement_line WHERE id = p_line_id;
  IF NOT FOUND THEN status := 'NOT_FOUND'; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM fin_statement_charge_booking b WHERE b.statement_line_id = p_line_id) THEN status := 'BOOKED'; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM fin_statement_match m WHERE m.statement_line_id = p_line_id AND m.reversed_at IS NULL) THEN status := 'MATCHED'; RETURN; END IF;
  IF fin_statement_line_cut_class(p_line_id) IS DISTINCT FROM 'POST_CUTOVER' THEN status := 'NOT_POST_CUTOVER'; RETURN; END IF;
  SELECT count(DISTINCT r.kind) INTO v_kinds
    FROM fin_statement_charge_rule r JOIN fin_statement_account_config cfg ON cfg.format_code = r.format_code AND cfg.activo
   WHERE cfg.financial_account_id = v_line.financial_account_id AND r.activo AND v_line.description_norm ~* r.pattern;
  IF v_kinds = 0 THEN status := 'NO_RULE'; RETURN; END IF;
  IF v_kinds > 1 THEN status := 'AMBIGUOUS'; RETURN; END IF;
  SELECT r.kind, r.id, r.label, r.expense_category_id INTO kind, rule_id, label, expense_category_id
    FROM fin_statement_charge_rule r JOIN fin_statement_account_config cfg ON cfg.format_code = r.format_code AND cfg.activo
   WHERE cfg.financial_account_id = v_line.financial_account_id AND r.activo AND v_line.description_norm ~* r.pattern
   ORDER BY r.id LIMIT 1;
  IF v_line.signed_amount > 0 THEN status := 'CREDIT'; RETURN; END IF;
  IF kind IN ('BANK_TAX_DEBCRED', 'BANK_IVA') AND EXISTS (SELECT 1 FROM fin_statement_recorded_charges(p_line_id, kind)) THEN
    status := 'RECORDED'; RETURN;   -- recorded before the statement (e.g. with its transfer): matched, never booked again
  END IF;
  IF kind = 'BANK_FEE' AND NOT EXISTS (SELECT 1 FROM expense_category c WHERE c.id = expense_category_id AND c.activo) THEN
    status := 'CATEGORY_MISSING'; RETURN;
  END IF;
  status := 'PROPOSED';
END $$;
ALTER FUNCTION fin_statement_charge_proposal(BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_charge_proposal(BIGINT) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION fin_statement_charge_proposals(UUID);
CREATE FUNCTION fin_statement_charge_proposals(p_account_id UUID)
RETURNS TABLE (statement_line_id BIGINT, value_date DATE, description_raw TEXT, bank_reference TEXT, signed_amount NUMERIC, running_balance NUMERIC,
               status TEXT, kind TEXT, rule_id BIGINT, label TEXT, expense_category_id UUID, category_name TEXT, recorded_posting_id BIGINT, recorded_count INTEGER)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  RETURN QUERY
  SELECT l.id, l.value_date, l.description_raw, l.bank_reference::TEXT, l.signed_amount, l.running_balance,
         p.status, p.kind, p.rule_id, p.label::TEXT, p.expense_category_id, c.nombre::TEXT,
         rc.first_id, rc.n::INTEGER
    FROM fin_statement_line l
   CROSS JOIN LATERAL fin_statement_charge_proposal(l.id) p
    LEFT JOIN expense_category c ON c.id = p.expense_category_id
    LEFT JOIN LATERAL (SELECT (array_agg(x ORDER BY ord))[1] AS first_id, count(*) AS n
                         FROM fin_statement_recorded_charges(l.id, p.kind) WITH ORDINALITY AS z(x, ord)) rc ON p.status = 'RECORDED'
   WHERE l.financial_account_id = p_account_id
     AND p.status IN ('PROPOSED', 'NO_RULE', 'AMBIGUOUS', 'CREDIT', 'CATEGORY_MISSING', 'RECORDED')
   ORDER BY l.value_date, l.id;
END $$;
ALTER  FUNCTION fin_statement_charge_proposals(UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_statement_charge_proposals(UUID) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_statement_charge_proposals(UUID) TO authenticated;
