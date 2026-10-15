-- ============================================================================
-- TARGET V1 — 0092 MANUAL MP COLLECTION CORRECTIONS + CUSTOMER COLLECTIONS VIEW (META A closure)
--
-- A manual collection (register_collection) posted on the Mercado Pago account without its real Mercado Pago movement
-- is corrected APPEND-ONLY, idempotently, through the ERP's existing routes, keeping ONE customer collection:
--   mp_correct_manual_collection(p_collection_id, p_mp_source_id, p_cash_amount, p_partner_withdrawal, p_reason,
--                                p_cash_account_id) — SECURITY DEFINER, ADMIN:
--     1. the manual money on Mercado Pago is reversed: ADJUSTMENT −amount on Mercado Pago ('COLLECTION-CORRECTION:<id>'),
--        recorded as an audited COLLECTION_CORRECTION exception to the 0091 invariant;
--     2. the manual customer credit is reversed: client_ledger REVERSAL +amount;
--     3. it is re-expressed by what really happened:
--        • the Mercado Pago part (p_mp_source_id) → mp_allocate_to_client of that REAL, already applied MP payment
--          (amount = its gross, the same customer) — no new money;
--        • the cash part (p_cash_amount) → register_collection CASH on the cash account (+cash);
--        • optionally the cash part leaves at once as a partner withdrawal → register_management_event RETIRO.
--     Net: the customer's balance is unchanged; Mercado Pago loses the duplicated / wrong manual inflow; the original
--     collection, its ledger rows and operations stay (history).
--   collection_correction — one immutable row per corrected collection (what was done, with every link).
--   fin_customer_collections (view, ADMIN): every customer collection whatever the account — manual collections (cash, bank,
--   Mercado Pago) and Mercado Pago payments allocated to a customer — with origin, status and the correction grouping
--   (a corrected collection shows as one logical collection with its components, e.g. MP 150,000 + Caja 50,000).
-- SECURITY DEFINER set 87 → 88.
-- ============================================================================

CREATE TABLE collection_correction (
  id                        BIGSERIAL PRIMARY KEY,
  collection_id             UUID        NOT NULL UNIQUE REFERENCES collections(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                    NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  mp_source_id              VARCHAR(30),
  mp_amount                 NUMERIC(15,2) NOT NULL CHECK (mp_amount >= 0),
  cash_amount               NUMERIC(15,2) NOT NULL CHECK (cash_amount >= 0),
  partner_withdrawal        BOOLEAN     NOT NULL DEFAULT false,
  reversal_operation_id     BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  client_reversal_ledger_id BIGINT      NOT NULL UNIQUE REFERENCES client_ledger(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  client_allocation_id      UUID        UNIQUE REFERENCES mp_client_allocation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cash_collection_id        UUID        UNIQUE REFERENCES collections(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cash_account_id           UUID        REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  withdrawal_event_id       UUID        UNIQUE REFERENCES management_event(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason                    TEXT        NOT NULL CHECK (btrim(reason) <> ''),
  created_by                UUID        REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cc_split CHECK (mp_amount + cash_amount = amount),
  CONSTRAINT chk_cc_mp CHECK ((mp_amount > 0) = (mp_source_id IS NOT NULL AND client_allocation_id IS NOT NULL)),
  CONSTRAINT chk_cc_cash CHECK ((cash_amount > 0) = (cash_collection_id IS NOT NULL AND cash_account_id IS NOT NULL)),
  CONSTRAINT chk_cc_withdrawal CHECK (partner_withdrawal = (withdrawal_event_id IS NOT NULL) AND (NOT partner_withdrawal OR cash_amount > 0))
);
ALTER TABLE collection_correction ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_collection_correction_immutable
  BEFORE UPDATE OR DELETE ON collection_correction
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
REVOKE ALL ON TABLE collection_correction FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE collection_correction TO authenticated;
REVOKE ALL ON SEQUENCE collection_correction_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY collection_correction_admin_select ON collection_correction
  FOR SELECT USING (current_app_role() = 'ADMIN');

CREATE OR REPLACE FUNCTION mp_correct_manual_collection(
  p_collection_id      UUID,
  p_mp_source_id       TEXT,
  p_cash_amount        NUMERIC,
  p_partner_withdrawal BOOLEAN,
  p_reason             TEXT,
  p_cash_account_id    UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_row      collection_correction%ROWTYPE;
  v_c        collections%ROWTYPE;
  v_mp       UUID;
  v_cash_acc UUID := p_cash_account_id;
  v_cash     NUMERIC(15,2) := coalesce(p_cash_amount, 0);
  v_mp_part  NUMERIC(15,2);
  v_wd       BOOLEAN := coalesce(p_partner_withdrawal, false);
  v_mvid     BIGINT;
  v_mv       mp_financial_movement%ROWTYPE;
  v_client   TEXT;
  v_op       BIGINT;
  v_ledger   BIGINT;
  v_alloc    UUID;
  v_cashcol  UUID;
  v_event    UUID;
  v_res      JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('collection_correction:' || p_collection_id::text, 0));

  SELECT * INTO v_row FROM collection_correction WHERE collection_id = p_collection_id;
  IF FOUND THEN
    IF v_row.mp_source_id IS NOT DISTINCT FROM p_mp_source_id AND v_row.cash_amount = v_cash AND v_row.partner_withdrawal = v_wd THEN
      RETURN jsonb_build_object('correction_id', v_row.id, 'replayed', true, 'reversal_operation_id', v_row.reversal_operation_id,
        'client_allocation_id', v_row.client_allocation_id, 'cash_collection_id', v_row.cash_collection_id, 'withdrawal_event_id', v_row.withdrawal_event_id);
    END IF;
    RAISE EXCEPTION 'ALREADY_CORRECTED: collection % was already corrected differently', p_collection_id;
  END IF;

  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  SELECT * INTO v_c FROM collections WHERE id = p_collection_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COLLECTION_NOT_FOUND';
  END IF;
  IF v_c.financial_account_id IS DISTINCT FROM v_mp THEN
    RAISE EXCEPTION 'NOT_A_MANUAL_MP_COLLECTION: only a manual collection posted on Mercado Pago is corrected here';
  END IF;
  IF EXISTS (SELECT 1 FROM collection_correction WHERE cash_collection_id = p_collection_id) THEN
    RAISE EXCEPTION 'NOT_A_MANUAL_MP_COLLECTION: a correction component cannot be corrected';
  END IF;
  IF v_cash < 0 OR v_cash > v_c.amount THEN
    RAISE EXCEPTION 'INVALID_CASH_AMOUNT: 0 to %', v_c.amount;
  END IF;
  v_mp_part := v_c.amount - v_cash;
  IF v_mp_part > 0 AND p_mp_source_id IS NULL THEN
    RAISE EXCEPTION 'MP_SOURCE_REQUIRED: % of the collection must be the real Mercado Pago payment', v_mp_part;
  END IF;
  IF v_mp_part = 0 AND p_mp_source_id IS NOT NULL THEN
    RAISE EXCEPTION 'MP_SOURCE_NOT_ALLOWED: the whole collection is cash';
  END IF;
  IF v_wd AND v_cash = 0 THEN
    RAISE EXCEPTION 'WITHDRAWAL_REQUIRES_CASH: only a cash part can leave as a partner withdrawal';
  END IF;
  IF v_cash > 0 THEN
    IF v_cash_acc IS NULL THEN
      SELECT id INTO v_cash_acc FROM financial_account WHERE account_type = 'CASH' AND activo;
      IF (SELECT count(*) FROM financial_account WHERE account_type = 'CASH' AND activo) <> 1 THEN
        RAISE EXCEPTION 'CASH_ACCOUNT_REQUIRED: choose the cash account';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = v_cash_acc AND account_type = 'CASH' AND activo) THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_REQUIRED: an active cash account is required';
    END IF;
  ELSE
    v_cash_acc := NULL;
  END IF;

  -- the real Mercado Pago payment: approved, applied in full, not allocated, not an own-account transfer, same amount
  IF v_mp_part > 0 THEN
    IF p_mp_source_id !~ '^[0-9]{1,20}$' THEN
      RAISE EXCEPTION 'INVALID_SOURCE_ID';
    END IF;
    SELECT t.mp_financial_movement_id INTO v_mvid FROM mp_transition_identity t
     WHERE t.resource_type = 'payment' AND t.resource_id = p_mp_source_id AND t.transition = 'APPROVAL' AND t.transition_ref = '';
    IF v_mvid IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_NOT_FOUND: no approved Mercado Pago payment %', p_mp_source_id;
    END IF;
    SELECT * INTO v_mv FROM mp_financial_movement WHERE id = v_mvid FOR UPDATE;
    IF v_mv.movement_kind <> 'payment' OR v_mv.net_amount <= 0
       OR v_mv.net_amount <> coalesce((SELECT sum(assigned_amount) FROM mp_reconciliation WHERE mp_financial_movement_id = v_mv.id), 0) THEN
      RAISE EXCEPTION 'PAYMENT_NOT_APPLIED: the Mercado Pago payment is not an applied inbound payment';
    END IF;
    IF EXISTS (SELECT 1 FROM mp_inbound_reclassification WHERE mp_financial_movement_id = v_mv.id) THEN
      RAISE EXCEPTION 'PAYMENT_IS_OWN_TRANSFER: the Mercado Pago payment was reclassified as an own-account transfer';
    END IF;
    IF coalesce((SELECT sum(amount) FROM mp_client_allocation WHERE mp_financial_movement_id = v_mv.id), 0) <> 0 THEN
      RAISE EXCEPTION 'PAYMENT_ALREADY_ALLOCATED: the Mercado Pago payment is already imputed to a customer';
    END IF;
    IF v_mv.gross_amount <> v_mp_part THEN
      RAISE EXCEPTION 'MP_AMOUNT_MISMATCH: the Mercado Pago payment is % (gross); the Mercado Pago part is %', v_mv.gross_amount, v_mp_part;
    END IF;
    IF abs(v_mv.occurred_date - v_c.effective_date) > 10 THEN
      RAISE EXCEPTION 'MP_DATE_MISMATCH: the Mercado Pago payment (%) is more than 10 days away from the collection (%)', v_mv.occurred_date, v_c.effective_date;
    END IF;
  END IF;

  PERFORM assert_period_open(v_c.effective_date);
  SELECT nombre INTO v_client FROM clients WHERE id = v_c.cliente_id;

  -- 1. the manual money leaves Mercado Pago (audited exception to the 0091 invariant)
  INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
  VALUES ('ADJUSTMENT', v_c.effective_date, 'COLLECTION-CORRECTION:' || v_c.id, 'collections', v_c.id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_op;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, v_mp, -v_c.amount, v_c.effective_date, v_uid);
  INSERT INTO mp_source_exception (financial_operation_id, kind, amount, reason, evidence_ref, created_by)
  VALUES (v_op, 'COLLECTION_CORRECTION', -v_c.amount, p_reason, 'collection ' || v_c.receipt_id, v_uid);

  -- 2. the manual customer credit is reversed
  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_c.cliente_id, 'REVERSAL', v_c.amount, v_c.effective_date, v_client, 'collection_correction', v_c.id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_ledger;

  -- 3. re-expressed: the real Mercado Pago payment, the cash part, the partner withdrawal
  IF v_mp_part > 0 THEN
    v_res := mp_allocate_to_client(v_mv.id, v_c.cliente_id, v_mp_part, greatest(v_c.effective_date, v_mv.occurred_date),
                                   'COLLECTION-CORRECTION-MP:' || v_c.id, p_reason);
    v_alloc := (v_res ->> 'allocation_id')::UUID;
  END IF;
  IF v_cash > 0 THEN
    v_res := register_collection(v_c.cliente_id, v_cash, 'CASH', 'COLLECTION-CORRECTION-CASH:' || v_c.id, v_c.effective_date, v_cash_acc, NULL, p_reason);
    v_cashcol := (v_res ->> 'collection_id')::UUID;
    IF v_wd THEN
      v_res := register_management_event('RETIRO', v_c.effective_date, v_cash, 'COLLECTION-CORRECTION-RETIRO:' || v_c.id, p_reason, v_cash_acc, NULL);
      v_event := (v_res ->> 'management_event_id')::UUID;
    END IF;
  END IF;

  INSERT INTO collection_correction (collection_id, amount, mp_source_id, mp_amount, cash_amount, partner_withdrawal, reversal_operation_id,
         client_reversal_ledger_id, client_allocation_id, cash_collection_id, cash_account_id, withdrawal_event_id, reason, created_by)
  VALUES (v_c.id, v_c.amount, CASE WHEN v_mp_part > 0 THEN p_mp_source_id END, v_mp_part, v_cash, v_wd, v_op,
          v_ledger, v_alloc, v_cashcol, v_cash_acc, v_event, p_reason, v_uid)
  RETURNING * INTO v_row;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('collection_correction', v_row.id::TEXT, 'CORRECT_MANUAL_COLLECTION',
          jsonb_build_object('collection_id', v_c.id, 'amount', v_c.amount, 'mp_source_id', v_row.mp_source_id, 'mp_amount', v_mp_part,
                             'cash_amount', v_cash, 'partner_withdrawal', v_wd, 'reversal_operation', v_op), p_reason, v_uid);
  RETURN jsonb_build_object('correction_id', v_row.id, 'replayed', false, 'reversal_operation_id', v_op,
    'client_allocation_id', v_alloc, 'cash_collection_id', v_cashcol, 'withdrawal_event_id', v_event);
END;
$$;
ALTER FUNCTION mp_correct_manual_collection(UUID, TEXT, NUMERIC, BOOLEAN, TEXT, UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_correct_manual_collection(UUID, TEXT, NUMERIC, BOOLEAN, TEXT, UUID) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION mp_correct_manual_collection(UUID, TEXT, NUMERIC, BOOLEAN, TEXT, UUID) TO authenticated;

-- ── Caja → Cobros de clientes ───────────────────────────────────────────────
CREATE OR REPLACE VIEW fin_customer_collections
WITH (security_invoker = true)
AS
WITH manual AS (
  SELECT 'C:' || c.id::TEXT AS row_id, c.effective_date AS business_date, c.created_at, c.cliente_id, cl.nombre::TEXT AS client_name,
         c.amount, a.nombre::TEXT AS account_name, a.account_type::TEXT AS account_type, c.payment_method::TEXT AS payment_method,
         o.reason AS notes, o.id AS financial_operation_id, NULL::TEXT AS source_id,
         cc_orig.id AS corrected_by, cc_comp.id AS component_of,
         EXISTS (SELECT 1 FROM financial_posting p JOIN fin_statement_match m ON m.financial_posting_id = p.id AND m.reversed_at IS NULL
                  WHERE p.financial_operation_id = o.id) AS bank_matched
    FROM collections c
    JOIN clients cl ON cl.id = c.cliente_id
    JOIN financial_account a ON a.id = c.financial_account_id
    LEFT JOIN financial_operation o ON o.operation_type = 'COLLECTION' AND o.source_entity_type = 'collections' AND o.source_entity_id = c.id::TEXT
    LEFT JOIN collection_correction cc_orig ON cc_orig.collection_id = c.id
    LEFT JOIN collection_correction cc_comp ON cc_comp.cash_collection_id = c.id
), mp AS (
  SELECT 'A:' || al.id::TEXT AS row_id, al.effective_date AS business_date, al.created_at, al.cliente_id, cl.nombre::TEXT AS client_name,
         al.amount - coalesce((SELECT sum(-r.amount) FROM mp_client_allocation r WHERE r.reversal_of_id = al.id), 0) AS amount,
         'Mercado Pago'::TEXT AS account_name, 'EXTERNAL_SERVICE'::TEXT AS account_type, 'MERCADOPAGO'::TEXT AS payment_method,
         al.reason AS notes,
         (SELECT min(r.financial_operation_id) FROM mp_reconciliation r JOIN financial_operation o ON o.id = r.financial_operation_id
           WHERE r.mp_financial_movement_id = al.mp_financial_movement_id AND o.operation_type = 'MP_SETTLEMENT') AS financial_operation_id,
         t.resource_id::TEXT AS source_id, cc.id AS component_of
    FROM mp_client_allocation al
    JOIN clients cl ON cl.id = al.cliente_id
    JOIN mp_transition_identity t ON t.mp_financial_movement_id = al.mp_financial_movement_id
    LEFT JOIN collection_correction cc ON cc.client_allocation_id = al.id
   WHERE al.origin = 'ALLOCATION'
)
SELECT u.* FROM (
SELECT row_id, business_date, created_at, cliente_id, client_name, amount, account_name, account_type, payment_method, notes,
       financial_operation_id, source_id,
       CASE WHEN component_of IS NOT NULL THEN 'CORRECTION'
            WHEN account_type = 'CASH' THEN 'CASH'
            WHEN account_type = 'BANK_ACCOUNT' THEN 'BANK'
            ELSE 'MANUAL_MP' END AS origin,
       CASE WHEN corrected_by IS NOT NULL THEN 'CORRECTED'
            WHEN account_type = 'EXTERNAL_SERVICE' THEN 'MANUAL_WITHOUT_SOURCE'
            WHEN account_type = 'BANK_ACCOUNT' AND bank_matched THEN 'CONCILIATED'
            WHEN account_type = 'BANK_ACCOUNT' THEN 'PENDING_RECONCILIATION'
            ELSE 'CASH' END AS status,
       coalesce(corrected_by, component_of) AS correction_id,
       CASE WHEN corrected_by IS NOT NULL THEN 'CORRECTED_ORIGINAL' WHEN component_of IS NOT NULL THEN 'COMPONENT' ELSE 'SINGLE' END AS correction_role,
       corrected_by IS NULL AS counts_for_customer
  FROM manual
UNION ALL
SELECT row_id, business_date, created_at, cliente_id, client_name, amount, account_name, account_type, payment_method, notes,
       financial_operation_id, source_id,
       CASE WHEN component_of IS NOT NULL THEN 'CORRECTION' ELSE 'AUTO_MP' END AS origin,
       'ALLOCATED_TO_CUSTOMER' AS status,
       component_of AS correction_id,
       CASE WHEN component_of IS NOT NULL THEN 'COMPONENT' ELSE 'SINGLE' END AS correction_role,
       true AS counts_for_customer
  FROM mp
) u
WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_customer_collections OWNER TO postgres;
REVOKE ALL    ON fin_customer_collections FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_customer_collections TO authenticated;
