-- ============================================================================
-- TARGET V1 — 0140 CORTE DE CLASIFICACIÓN MERCADO PAGO (01/12/2026) + SALDO INICIAL DE CAJA POR CONTEO
-- (owner decisions 2026-11-25)
--
--   * corte_clasificacion_mp() = 2026-12-01: a Mercado Pago outflow still pending before that date is closed WITHOUT detail —
--     it stays in the balance (its provisional posting is untouched), never enters the P&L, and leaves every list of things to do:
--       - fin_mp_pending_classification: historical (no action) like the reconstructed ones;
--       - mp_pending_classification_totals: the month close only counts what is from the cutover on;
--       - fin_operation_list (same identity): «Salida MP sin detalle (antes del corte)», no «Por revisar».
--     Nothing is classified, resolved or written: a pending outflow can still be classified later if wanted.
--   * Cash opening by count (Caja chica, counted on 30/11/2026 at the end of the day): cash_opening_count + register_cash_opening
--     (ADMIN, audited, once per cash account): the ERP balance at the count date vs the counted cash; the difference is posted as
--     an ADJUSTMENT «Saldo inicial (conteo de caja)» on that date — outside the P&L (pnl_line_item never reads postings).
--     fin_account_balance_on(account, date): the ERP balance of an account at the end of a day (invoker, RLS).
--   No data is written by this migration; DEFINER count 180 → 181 (register_cash_opening).
-- ============================================================================

CREATE FUNCTION corte_clasificacion_mp() RETURNS DATE LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$ SELECT DATE '2026-12-01' $$;
ALTER  FUNCTION corte_clasificacion_mp() OWNER TO postgres;
REVOKE ALL     ON FUNCTION corte_clasificacion_mp() FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION corte_clasificacion_mp() TO authenticated;

CREATE OR REPLACE VIEW fin_mp_pending_classification
WITH (security_invoker = true)
AS
SELECT u.* FROM (
  SELECT 'OUT:' || p.source_id AS pending_key, p.source_id::TEXT AS source_id, p.kind::TEXT AS kind, 'OUT'::TEXT AS direction,
         p.occurred_date AS business_date, coalesce(s.occurred_at, h.occurred_at) AS occurred_at, p.amount, abs(m.gross_amount) AS economic_amount,
         (m.fee_amount + m.tax_amount) AS charges_amount, a.nombre::TEXT AS account_name,
         CASE p.kind WHEN 'PAYOUT' THEN 'payout' ELSE 'payment' END AS description,
         'PENDING'::TEXT AS status, true AS already_posted, p.provisional_operation_id AS financial_operation_id,
         (h.id IS NOT NULL OR p.occurred_date < corte_clasificacion_mp()) AS is_historical,   -- [0140] + before the cutover                                      -- [0095] ADR-022 evidence
         hp.destination_status::TEXT AS destination_status, hp.destination_last4::TEXT AS destination_last4,
         (SELECT x.nombre::TEXT FROM financial_account x WHERE x.id = hp.matched_account_id) AS matched_account_name
    FROM (SELECT p0.*, p0.source_id || ':' || CASE p0.kind WHEN 'PAYOUT' THEN 'payout' ELSE 'payment' END || ':D' AS hist_identity
            FROM mp_pending_outflow p0
           WHERE p0.kind IN ('PAYOUT', 'OUTBOUND')
          OFFSET 0) p                                                            -- [0105] kept apart: the join below stays indexable
    JOIN mp_financial_movement m ON m.id = p.mp_financial_movement_id
    LEFT JOIN mp_source_record s ON s.id = m.mp_source_record_id
    LEFT JOIN mp_historical_row h ON h.identity = p.hist_identity
    LEFT JOIN mp_historical_payout hp ON hp.identity = h.identity
    JOIN financial_account a ON a.id = p.mp_account_id
   WHERE NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id)
) u
WHERE (SELECT current_app_role()) = 'ADMIN';

ALTER VIEW fin_mp_pending_classification OWNER TO postgres;

CREATE OR REPLACE FUNCTION mp_pending_classification_totals(p_from DATE, p_to DATE)
RETURNS TABLE (pending_count BIGINT, outgoing NUMERIC, incoming NUMERIC, unposted_count BIGINT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH o AS (
    SELECT p.amount FROM mp_pending_outflow p
     WHERE p.occurred_date BETWEEN p_from AND p_to
       AND p.kind IN ('PAYOUT', 'OUTBOUND')   -- [0095] an inflow is never a mandatory classification (ADR-023)
       AND p.occurred_date >= corte_clasificacion_mp()   -- [0140] before the cutover: closed without detail
       AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id)
  ), u AS (
    SELECT s.id FROM mp_source_record s
     WHERE s.source_type = 'csv_import' AND (s.external_id LIKE '%:payment:D' OR EXISTS (SELECT 1 FROM mp_transition_identity tp WHERE tp.resource_type = 'report' AND tp.resource_id = s.external_id AND tp.transition = 'PAYOUT'))
       AND s.processing_status NOT IN ('IGNORED', 'ERROR')
       AND (s.event_data ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (s.event_data ->> 'NET_DEBIT_AMOUNT')::NUMERIC < 0
       AND NOT EXISTS (SELECT 1 FROM mp_transition_identity t JOIN mp_reconciliation r ON r.mp_financial_movement_id = t.mp_financial_movement_id
                        WHERE t.resource_type = 'report' AND t.resource_id = s.external_id)
       AND s.occurred_date BETWEEN p_from AND p_to
  )
  SELECT (SELECT count(*) FROM o), coalesce((SELECT sum(amount) FROM o), 0), 0::NUMERIC, (SELECT count(*) FROM u)
$$;
ALTER FUNCTION mp_pending_classification_totals(DATE, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_pending_classification_totals(DATE, DATE) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION fin_movement_class(p_type TEXT, p_ref TEXT, OUT kind TEXT, OUT label TEXT)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE
      WHEN p_ref LIKE 'PURCHASE-PAY:STMT-LINE:%' THEN 'CARGO'
      WHEN p_type = 'ADJUSTMENT' AND p_ref LIKE 'EXPENSE-PAYMENT-REVERSAL:%' THEN 'PAGO'
      WHEN p_ref LIKE 'MP-PENDING%' THEN 'PENDIENTE_MP'
      WHEN p_type = 'TRANSFER' THEN 'TRANSFERENCIA'
      WHEN p_ref LIKE 'MP-INBOUND-RECLASS:%' THEN 'OTRO'
      WHEN p_type IN ('COLLECTION', 'MP_SETTLEMENT', 'CHEQUE_CLEAR') THEN 'COBRO'
      WHEN p_type IN ('SUPPLIER_PAYMENT', 'PURCHASE_PAYMENT', 'FREIGHT_PAYMENT', 'INSTRUMENT_DEBIT', 'FISCAL_PAYMENT') THEN 'PAGO'
      WHEN p_type IN ('BANK_TAX', 'FEE') OR p_ref LIKE 'MP-OUTFLOW-TAX:%' OR (p_type = 'ADJUSTMENT' AND p_ref LIKE 'MP:%') THEN 'CARGO'
      ELSE 'OTRO'
    END,
    CASE
      WHEN p_ref LIKE 'PURCHASE-PAY:STMT-LINE:%' THEN 'Cargo bancario'
      WHEN p_type = 'ADJUSTMENT' AND p_ref LIKE 'EXPENSE-PAYMENT-REVERSAL:%' THEN 'Reversión de pago'
      WHEN p_ref LIKE 'MP-PENDING-RELEASE:%' THEN 'Clasificación de salida'
      WHEN p_ref LIKE 'MP-PENDING:%' THEN 'Pendiente de clasificar'
      WHEN p_ref LIKE 'EXPENSE-PENDING:%' THEN 'Gasto (sin clasificar al registrarse)'
      WHEN p_ref LIKE 'MP-INBOUND-RECLASS:%' THEN 'Reclasificación de entrada Mercado Pago'
      WHEN p_ref LIKE 'MP-OUTFLOW-TAX:%' THEN 'Impuesto Débitos/Créditos (Mercado Pago)'
      WHEN p_type = 'ADJUSTMENT' AND p_ref LIKE 'MP:%' THEN 'Impuesto de Mercado Pago'
      WHEN p_ref LIKE 'COLLECTION-CORRECTION%' THEN 'Corrección de cobro'
      WHEN p_ref LIKE 'PHASE31-OPENING%' THEN 'Saldo inicial'
      WHEN p_ref LIKE 'CASH-OPENING:%' THEN 'Saldo inicial (conteo de caja)'   -- [0140]
      WHEN p_ref LIKE 'MP-HIST-OPENING-NEUTRALIZATION:%' THEN 'Neutralización de saldo inicial'
      WHEN p_type = 'TRANSFER' THEN 'Transferencia'
      WHEN p_type = 'FEE' THEN 'Comisión'
      WHEN p_type = 'COLLECTION' THEN 'Cobro'
      WHEN p_type = 'CHEQUE_CLEAR' THEN 'Cheque acreditado'
      WHEN p_type = 'CHEQUE_REJECTION' THEN 'Cheque rechazado'
      WHEN p_type = 'SUPPLIER_PAYMENT' THEN 'Pago a proveedor'
      WHEN p_type = 'PURCHASE_PAYMENT' THEN 'Pago de compra'
      WHEN p_type = 'FREIGHT_PAYMENT' THEN 'Pago de flete'
      WHEN p_type = 'INSTRUMENT_DEBIT' THEN 'Cheque debitado'
      WHEN p_type = 'INSTRUMENT_DEBIT_REVERSAL' THEN 'Reversión de cheque debitado'
      WHEN p_type = 'FISCAL_PAYMENT' THEN 'Pago fiscal'
      WHEN p_type = 'SESSION_CASH' THEN 'Efectivo de feria'
      WHEN p_type = 'MP_SETTLEMENT' THEN 'Cobro Mercado Pago'
      WHEN p_type = 'OWNER_WITHDRAWAL' THEN 'Retiro de socios'
      WHEN p_type = 'BANK_TAX' THEN 'Impuesto bancario'
      WHEN p_type = 'ADJUSTMENT' THEN 'Ajuste'
      ELSE p_type
    END;
$$;
ALTER  FUNCTION fin_movement_class(TEXT, TEXT) OWNER TO postgres;

CREATE OR REPLACE FUNCTION fin_operation_list(
  p_from        DATE    DEFAULT NULL,
  p_to          DATE    DEFAULT NULL,
  p_tipo        TEXT    DEFAULT NULL,
  p_account_id  UUID    DEFAULT NULL,
  p_sin_cuenta  BOOLEAN DEFAULT false,
  p_estado      TEXT    DEFAULT NULL,
  p_group_id    UUID    DEFAULT NULL,
  p_category_id UUID    DEFAULT NULL,
  p_nature      TEXT    DEFAULT NULL,
  p_supplier_id UUID    DEFAULT NULL,
  p_search      TEXT    DEFAULT NULL,
  p_amount      NUMERIC DEFAULT NULL,
  p_order       TEXT    DEFAULT 'FECHA',
  p_focus       TEXT    DEFAULT NULL,
  p_limit       INTEGER DEFAULT 50,
  p_offset      INTEGER DEFAULT 0,
  p_tag_id      UUID    DEFAULT NULL,    -- [0127] only the rows of expenses with this tag
  p_sin_etiqueta BOOLEAN DEFAULT false,  -- [0127] only the rows of expenses WITHOUT a tag
  p_comprobante TEXT    DEFAULT NULL     -- [0137] 'CON': rows of expenses with an invoice number or a file; 'SIN': rows of expenses with neither
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_search TEXT := nullif(btrim(p_search), '');
  v_like   TEXT;
  v_amount NUMERIC := abs(p_amount);
  v_focus  TEXT := nullif(btrim(p_focus), '');
  v_mp     UUID;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_LIMIT: 1 to 100'; END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN RAISE EXCEPTION 'INVALID_OFFSET'; END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN RAISE EXCEPTION 'INVALID_RANGE: from after to'; END IF;
  IF p_tipo IS NOT NULL AND p_tipo NOT IN ('INGRESO', 'EGRESO', 'TRANSFERENCIA') THEN RAISE EXCEPTION 'INVALID_TIPO'; END IF;
  IF p_estado IS NOT NULL AND p_estado NOT IN ('PENDIENTE', 'COMPLETADA', 'POR_REVISAR') THEN RAISE EXCEPTION 'INVALID_ESTADO'; END IF;
  IF p_nature IS NOT NULL AND p_nature NOT IN ('OPERATING', 'REINVESTMENT', 'INVESTMENT') THEN RAISE EXCEPTION 'INVALID_NATURE'; END IF;
  IF coalesce(p_order, 'FECHA') NOT IN ('FECHA', 'CARGA') THEN RAISE EXCEPTION 'INVALID_ORDER'; END IF;
  IF p_comprobante IS NOT NULL AND p_comprobante NOT IN ('CON', 'SIN') THEN RAISE EXCEPTION 'INVALID_COMPROBANTE'; END IF;
  IF length(v_search) > 100 OR length(v_focus) > 120 THEN RAISE EXCEPTION 'INVALID_SEARCH: too long'; END IF;
  v_like := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE';

  RETURN (
  WITH cur AS MATERIALIZED (
    -- the current version of every purchase, by chain root (few rows: the chain is resolved once here)
    SELECT pu.id, purchase_chain_root(pu.id) AS root, pu.supplier_id, pu.expense_category_id, pu.nature::TEXT AS nature, pu.subcategory,
           pu.counterparty_name, pu.amount_total, pu.economic_date, pu.created_at, pu.supplier_invoice_number, pu.fiscal_document_id
      FROM purchases pu WHERE pu.is_current
  ), comp AS MATERIALIZED (
    -- [0137] the expenses (by root) with an invoice / receipt: the invoice number or a file (ERP upload or WhatsApp) of the version in
    -- force or of the original one — what the column «Factura / comprobante» shows
    SELECT c.root FROM cur c
     WHERE p_comprobante IS NOT NULL
       AND (nullif(btrim(c.supplier_invoice_number), '') IS NOT NULL
         OR EXISTS (SELECT 1 FROM purchases r WHERE r.id = c.root AND nullif(btrim(r.supplier_invoice_number), '') IS NOT NULL)
         OR EXISTS (SELECT 1 FROM purchase_attachment pa WHERE pa.purchase_id IN (c.id, c.root))
         OR EXISTS (SELECT 1 FROM document_link dl WHERE dl.target_kind = 'PURCHASE' AND dl.target_id IN (c.id::TEXT, c.root::TEXT)))
  ), lk AS MATERIALIZED (
    -- the expense / invoice an operation belongs to, from the recorded links only (first by link kind, then by root)
    SELECT DISTINCT ON (x.op) x.op, x.root FROM (
      SELECT c.paid_operation_id AS op, c.root, 1 AS prio FROM (SELECT p.paid_operation_id, cu.root FROM purchases p JOIN cur cu ON cu.id = p.id WHERE p.paid_operation_id IS NOT NULL) c
      UNION ALL SELECT ep.financial_operation_id, e.purchase_root_id, 2 FROM expense_payable_payment ep JOIN expense_payable e ON e.id = ep.payable_id
      UNION ALL SELECT a.financial_operation_id, a.purchase_root_id, 3 FROM purchase_payment_allocation a WHERE a.financial_operation_id IS NOT NULL
      UNION ALL SELECT ev.financial_operation_id, a.purchase_root_id, 4 FROM financial_instrument_event ev
                  JOIN purchase_payment_allocation a ON a.financial_instrument_id = ev.financial_instrument_id WHERE ev.financial_operation_id IS NOT NULL
      UNION ALL SELECT s.financial_operation_id, s.purchase_root_id, 5 FROM purchase_mp_settlement s WHERE s.financial_operation_id IS NOT NULL
    ) x ORDER BY x.op, x.prio, x.root
  ), ops AS MATERIALIZED (
    SELECT o.id, o.effective_date, o.created_at, o.operation_type::TEXT AS operation_type, o.external_ref, o.reason, o.source_entity_type,
           o.source_entity_id, c.kind, c.label, pa.total, pa.has_in, pa.has_out,
           CASE WHEN o.operation_type::TEXT = 'TRANSFER' OR (pa.has_in AND pa.has_out AND pa.total = 0) THEN 'TRANSFERENCIA'
                WHEN pa.total > 0 THEN 'INGRESO' ELSE 'EGRESO' END AS tipo,
           lk.root,
           CASE WHEN o.operation_type::TEXT = 'SUPPLIER_PAYMENT' THEN sp.id END AS payee,
           concat_ws(' ', sp.nombre, cl.nombre, pu.subcategory, pu.counterparty_name, ie.nm, al.nm) AS names
      FROM financial_operation o
     CROSS JOIN LATERAL fin_movement_class(o.operation_type::TEXT, o.external_ref) c
     CROSS JOIN LATERAL (SELECT sum(p.signed_amount) AS total, bool_or(p.signed_amount > 0) AS has_in, bool_or(p.signed_amount < 0) AS has_out
                           FROM financial_posting p WHERE p.financial_operation_id = o.id) pa
      LEFT JOIN lk ON lk.op = o.id
      LEFT JOIN suppliers sp ON o.operation_type::TEXT = 'SUPPLIER_PAYMENT' AND sp.id::TEXT = o.source_entity_id
      LEFT JOIN collections co ON o.source_entity_type = 'collections' AND co.id::TEXT = o.source_entity_id
      LEFT JOIN clients cl ON cl.id = co.cliente_id
      LEFT JOIN LATERAL (SELECT x.subcategory, x.counterparty_name FROM purchases x WHERE x.paid_operation_id = o.id AND x.is_current LIMIT 1) pu ON true
      LEFT JOIN LATERAL (SELECT string_agg(DISTINCT concat_ws(' ', i.cheque_number, s2.nombre, c2.nombre), ' ') AS nm FROM financial_instrument_event ev JOIN financial_instrument i ON i.id = ev.financial_instrument_id
                           LEFT JOIN suppliers s2 ON s2.id = i.supplier_id LEFT JOIN clients c2 ON c2.id = i.cliente_id WHERE ev.financial_operation_id = o.id) ie ON true
      LEFT JOIN LATERAL (SELECT string_agg(DISTINCT concat_ws(' ', s3.nombre, r.supplier_invoice_number), ' ') AS nm FROM purchase_payment_allocation x
                           JOIN purchases r ON r.id = x.purchase_root_id LEFT JOIN suppliers s3 ON s3.id = r.supplier_id WHERE x.financial_operation_id = o.id) al ON true
     WHERE pa.total IS NOT NULL
       -- [0132] a CLASSIFIED Mercado Pago outflow: its provisional («pendiente de clasificar») and its release («salida clasificada») are
       -- bookkeeping that nets to zero (ADR-021) — only the classified operation (and its tax) is a movement of the list
       AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow mpo WHERE mpo.provisional_operation_id = o.id
                          AND EXISTS (SELECT 1 FROM mp_pending_outflow_resolution mpr WHERE mpr.pending_id = mpo.id))
       AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution mpr WHERE mpr.reversal_operation_id = o.id)
  ), pend_exp AS MATERIALIZED (
    SELECT e.payable_id, e.purchase_root_id, e.economic_date, e.concept, e.counterparty_name, e.category_name, e.pending, e.amount, e.paid, e.due_date,
           e.planned_date, e.created_at, e.created_by
      FROM fin_expense_payables e WHERE e.pending > 0
  ), pend_inv AS MATERIALIZED (
    SELECT f.purchase_id, f.purchase_root_id, f.supplier_id, f.supplier_name, f.supplier_invoice_number, f.economic_date, f.amount_total, f.scheduled, f.debited,
           f.other_payments, f.amount_total - f.debited - f.other_payments AS unpaid, f.due_date, f.planned_date,
           (SELECT pu.created_at FROM purchases pu WHERE pu.id = f.purchase_root_id) AS created_at,
           (SELECT c.subcategory FROM cur c WHERE c.id = f.purchase_id) AS concept
      FROM fin_purchase_payment_status f WHERE f.amount_total - f.debited - f.other_payments > 0
  ), mp_pend AS MATERIALIZED (
    -- paid with Mercado Pago, its movement not linked yet (no settlement)
    SELECT l.purchase_root_id, l.mp_account_id, l.created_at, c.id AS purchase_id, c.economic_date, c.amount_total, c.subcategory, c.counterparty_name
      FROM purchase_mp_link l JOIN cur c ON c.root = l.purchase_root_id
     WHERE NOT EXISTS (SELECT 1 FROM purchase_mp_settlement s WHERE s.purchase_root_id = l.purchase_root_id)
  ), u AS (
    SELECT 'OP:' || o.id AS row_key, 'OP' AS row_kind, o.effective_date AS d, o.created_at AS ca, o.tipo,
           CASE WHEN o.tipo = 'INGRESO' THEN o.total ELSE -abs(CASE WHEN o.tipo = 'TRANSFERENCIA' THEN (SELECT sum(p.signed_amount) FILTER (WHERE p.signed_amount > 0) FROM financial_posting p WHERE p.financial_operation_id = o.id) ELSE o.total END) END AS amount,
           'COMPLETADA' AS estado, NULL::TEXT AS concepto, o.label AS detalle,
           (SELECT array_agg(DISTINCT p.financial_account_id) FROM financial_posting p WHERE p.financial_operation_id = o.id) AS accounts,
           o.id AS op_id, NULL::UUID AS ref_uuid, NULL::BIGINT AS ref_id,
           concat_ws(' ', o.names, o.label, o.reason, o.external_ref) AS hay,
           o.root, coalesce(c.supplier_id, o.payee) AS supplier_id,
           -- [0133] a partner withdrawal: its socio is its subcategory (group «Retiros de socios»)
           coalesce(c.expense_category_id, (SELECT me.socio_category_id FROM management_event me WHERE me.financial_operation_id = o.id LIMIT 1)) AS category_id,
           c.nature, false AS informativo
      FROM ops o LEFT JOIN cur c ON c.root = o.root
    UNION ALL
    SELECT 'GASTO:' || e.payable_id, 'GASTO', e.economic_date, e.created_at, 'EGRESO', -e.pending, 'PENDIENTE', coalesce(e.concept, e.counterparty_name, 'Gasto a pagar'),
           'Gasto pendiente de pago' || CASE WHEN e.paid > 0 THEN ' (resto)' ELSE '' END, NULL::UUID[], NULL::BIGINT, e.payable_id, NULL::BIGINT,
           concat_ws(' ', e.concept, e.counterparty_name, e.category_name),
           e.purchase_root_id, c.supplier_id, c.expense_category_id, c.nature, false
      FROM pend_exp e LEFT JOIN cur c ON c.root = e.purchase_root_id
    UNION ALL
    SELECT 'FACTURA:' || f.purchase_root_id, 'FACTURA', f.economic_date, f.created_at, 'EGRESO', -f.unpaid, 'PENDIENTE',
           coalesce(f.concept, f.supplier_name) || coalesce(' · Factura ' || f.supplier_invoice_number, ''),
           'Factura de proveedor pendiente' || CASE WHEN f.scheduled > 0 THEN ' · con cheques por debitar' ELSE '' END, NULL::UUID[], NULL::BIGINT, f.purchase_root_id, NULL::BIGINT,
           concat_ws(' ', f.supplier_name, f.supplier_invoice_number, f.concept),
           f.purchase_root_id, f.supplier_id, c.expense_category_id, c.nature, false
      FROM pend_inv f LEFT JOIN cur c ON c.root = f.purchase_root_id
    UNION ALL
    SELECT 'CHEQUE:' || i.id, 'CHEQUE', coalesce(i.maturity_date, i.issued_date), i.created_at, 'EGRESO', -i.amount, 'PENDIENTE',
           CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number, ''),
           'Cheque propio por debitar', ARRAY[i.bank_account_id], NULL::BIGINT, i.id, NULL::BIGINT,
           concat_ws(' ', i.cheque_number, s.nombre), NULL::UUID, i.supplier_id, NULL::UUID, NULL::TEXT, false
      FROM financial_instrument i LEFT JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.direction::TEXT = 'ISSUED' AND i.estado::TEXT = 'ISSUED'
       AND NOT EXISTS (SELECT 1 FROM purchase_payment_allocation a WHERE a.financial_instrument_id = i.id)
    UNION ALL
    SELECT 'CHEQUE_RECIBIDO:' || i.id, 'CHEQUE_RECIBIDO', coalesce(i.maturity_date, i.received_date), i.created_at, 'INGRESO', i.amount, 'PENDIENTE',
           CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number, '') || coalesce(' · ' || cl.nombre, ''),
           CASE i.estado::TEXT WHEN 'DEPOSITED' THEN 'Cheque recibido depositado, por acreditar' ELSE 'Cheque recibido en cartera' END,
           CASE WHEN i.bank_account_id IS NOT NULL THEN ARRAY[i.bank_account_id] END, NULL::BIGINT, i.id, NULL::BIGINT,
           concat_ws(' ', i.cheque_number, cl.nombre), NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT, false
      FROM financial_instrument i LEFT JOIN clients cl ON cl.id = i.cliente_id
     WHERE i.direction::TEXT = 'RECEIVED' AND i.estado::TEXT IN ('RECEIVED', 'DEPOSITED')
    UNION ALL
    SELECT 'TRANSFERENCIA:' || t.id, 'TRANSFERENCIA', t.effective_date, t.created_at, 'TRANSFERENCIA', -t.amount, 'PENDIENTE',
           fa.nombre || ' → ' || ta.nombre, 'Transferencia anticipada, esperando su movimiento', ARRAY[t.from_account_id, t.to_account_id], NULL::BIGINT, NULL::UUID, t.id,
           concat_ws(' ', fa.nombre, ta.nombre, t.reason), NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT, false
      FROM fin_transfer_intent t JOIN financial_account fa ON fa.id = t.from_account_id JOIN financial_account ta ON ta.id = t.to_account_id
     WHERE t.status = 'PENDIENTE'
    UNION ALL
    SELECT 'MP_PENDIENTE:' || m.purchase_root_id, 'MP_PENDIENTE', m.economic_date, m.created_at, 'EGRESO', -m.amount_total, 'COMPLETADA',
           coalesce(m.subcategory, m.counterparty_name, 'Gasto pagado con Mercado Pago'), 'Pagado con Mercado Pago · falta vincular su movimiento',
           ARRAY[m.mp_account_id], NULL::BIGINT, m.purchase_root_id, NULL::BIGINT,
           concat_ws(' ', m.subcategory, m.counterparty_name), m.purchase_root_id, c.supplier_id, c.expense_category_id, c.nature, true
      FROM mp_pend m LEFT JOIN cur c ON c.root = m.purchase_root_id
  ), fl AS MATERIALIZED (
    SELECT * FROM u
     WHERE (v_focus IS NOT NULL AND u.row_key = v_focus)
        OR (v_focus IS NULL
            AND (p_from IS NULL OR u.d >= p_from) AND (p_to IS NULL OR u.d <= p_to)
            AND (p_tipo IS NULL OR u.tipo = p_tipo)
            -- [0127] expense tag: rows linked to an expense (root) with that tag / with none
            AND (p_tag_id IS NULL OR EXISTS (SELECT 1 FROM purchase_tag t WHERE t.purchase_root_id = u.root AND t.project_id = p_tag_id))
            AND (NOT coalesce(p_sin_etiqueta, false) OR (u.root IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchase_tag t WHERE t.purchase_root_id = u.root)))
            -- [0137] invoice / receipt: rows linked to an expense (root) with one / without one (rows of no expense are never «sin comprobante»)
            AND (p_comprobante IS NULL
              OR (p_comprobante = 'CON' AND EXISTS (SELECT 1 FROM comp k WHERE k.root = u.root))
              OR (p_comprobante = 'SIN' AND u.root IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comp k WHERE k.root = u.root)))
            AND (p_estado IS NULL OR u.estado = p_estado
              -- Por revisar: what still needs a classification or its Mercado Pago movement (never money: a filter of the same rows)
              OR (p_estado = 'POR_REVISAR' AND (u.row_kind = 'MP_PENDIENTE'
                    OR EXISTS (SELECT 1 FROM ops o WHERE o.id = u.op_id AND o.kind = 'PENDIENTE_MP')
                    OR EXISTS (SELECT 1 FROM expense_pending_classification e WHERE e.payment_operation_id = u.op_id
                                 AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = e.payment_operation_id AND pu.is_current)))))
            AND (p_account_id IS NULL OR p_account_id = ANY (u.accounts))
            AND (NOT coalesce(p_sin_cuenta, false) OR u.accounts IS NULL)
            AND (p_category_id IS NULL OR u.category_id = p_category_id)
            AND (p_group_id IS NULL OR EXISTS (SELECT 1 FROM expense_category ec WHERE ec.id = u.category_id AND ec.group_id = p_group_id))
            AND (p_nature IS NULL OR u.nature = p_nature)
            AND (p_supplier_id IS NULL OR u.supplier_id = p_supplier_id)
            AND ((v_search IS NULL AND v_amount IS NULL)
              OR (v_search IS NOT NULL AND (u.hay ILIKE v_like OR u.op_id::TEXT = v_search))
              OR (v_amount IS NOT NULL AND (abs(u.amount) = v_amount
                    OR (u.op_id IS NOT NULL AND EXISTS (SELECT 1 FROM financial_posting p WHERE p.financial_operation_id = u.op_id AND abs(p.signed_amount) = v_amount))))))
  ), page AS (
    SELECT * FROM fl
     ORDER BY CASE WHEN coalesce(p_order, 'FECHA') = 'CARGA' THEN fl.ca END DESC NULLS LAST, fl.d DESC NULLS LAST, fl.ca DESC NULLS LAST, fl.row_key DESC
     LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM fl),
    -- the money of the filtered rows, each amount once (an informative Mercado Pago row is already its provisional outflow)
    'importe', (SELECT coalesce(sum(fl.amount) FILTER (WHERE NOT fl.informativo), 0) FROM fl),
    'rows', coalesce((SELECT jsonb_agg(r.j ORDER BY r.n) FROM (
      SELECT row_number() OVER (ORDER BY CASE WHEN coalesce(p_order, 'FECHA') = 'CARGA' THEN pg.ca END DESC NULLS LAST, pg.d DESC NULLS LAST, pg.ca DESC NULLS LAST, pg.row_key DESC) AS n,
             jsonb_build_object(
               'row_key', pg.row_key, 'row_kind', pg.row_kind, 'date', pg.d, 'created_at', pg.ca, 'tipo', pg.tipo, 'amount', pg.amount, 'informativo', pg.informativo,
               'estado', pg.estado,
               'concepto', coalesce(pg.concepto, (SELECT coalesce(
                   -- [0139] the bank debit of an own cheque / eCheq paid for an expense: «eCheq 035 · <expense>» (backlog #6, owner 2026-11-25)
                   (SELECT CASE WHEN o2.operation_type::TEXT = 'INSTRUMENT_DEBIT'
                                THEN coalesce((SELECT CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number || ' · ', '')
                                                 FROM financial_instrument_event ev JOIN financial_instrument i ON i.id = ev.financial_instrument_id
                                                WHERE ev.financial_operation_id = o2.id LIMIT 1), '')
                                ELSE '' END || coalesce(c.subcategory, c.counterparty_name) FROM cur c WHERE c.root = pg.root),
                   (SELECT CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number, '') || ' · ' || coalesce(s.nombre, cl.nombre, '')
                      FROM financial_instrument_event ev JOIN financial_instrument i ON i.id = ev.financial_instrument_id
                      LEFT JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN clients cl ON cl.id = i.cliente_id WHERE ev.financial_operation_id = o2.id LIMIT 1),
                   (SELECT 'Cobro · ' || cl.nombre FROM collections co JOIN clients cl ON cl.id = co.cliente_id
                     WHERE o2.source_entity_type = 'collections' AND co.id::TEXT = o2.source_entity_id),
                   (SELECT 'Pago a ' || s.nombre FROM suppliers s WHERE o2.operation_type::TEXT = 'SUPPLIER_PAYMENT' AND s.id::TEXT = o2.source_entity_id),
                   -- [0132] a Mercado Pago inflow says what it is (its movement kind and payment method; never the payer — 0097) and
                   -- its client when one is allocated
                   (SELECT CASE
                             WHEN m.movement_kind = 'yield' THEN 'Rendimiento MP'
                             WHEN coalesce(r.event_data->>'operation_type', '') IN ('money_transfer', 'account_fund')
                               OR coalesce(r.event_data->>'PAYMENT_METHOD_TYPE', r.event_data->>'payment_type_id', '') = 'bank_transfer' THEN 'Transferencia recibida MP'
                             WHEN coalesce(r.event_data->>'PAYMENT_METHOD_TYPE', r.event_data->>'payment_type_id', '') = 'credit_card' THEN 'Cobro con tarjeta MP'
                             ELSE 'Cobro MP' END
                           || coalesce(' · ' || (SELECT string_agg(DISTINCT cl.nombre, ', ') FROM mp_client_allocation a JOIN clients cl ON cl.id = a.cliente_id
                                                  WHERE a.mp_financial_movement_id = m.id AND a.reversal_of_id IS NULL
                                                    AND NOT EXISTS (SELECT 1 FROM mp_client_allocation b WHERE b.reversal_of_id = a.id)), '')
                      FROM mp_financial_movement m JOIN mp_source_record r ON r.id = m.mp_source_record_id
                     WHERE o2.operation_type::TEXT = 'MP_SETTLEMENT'
                       AND m.id = CASE WHEN o2.source_entity_type = 'mp_financial_movement' AND o2.source_entity_id ~ '^[0-9]{1,18}$' THEN o2.source_entity_id::BIGINT
                                       ELSE (SELECT rc.mp_financial_movement_id FROM mp_reconciliation rc WHERE rc.financial_operation_id = o2.id ORDER BY rc.id LIMIT 1) END),
                   -- [0132] short concepts: never the internal reference text (ids, ADR notes, statement line numbers)
                   CASE WHEN o2.external_ref LIKE 'MP-PENDING:%' AND o2.effective_date < corte_clasificacion_mp() THEN 'Salida MP sin detalle (antes del corte)'   -- [0140]
                        WHEN o2.external_ref LIKE 'MP-PENDING:%' THEN 'Salida MP sin clasificar'
                        WHEN o2.external_ref LIKE 'MP-OUTFLOW-TAX:%' OR o2.reason ILIKE 'Impuesto débitos y créditos%' OR tax_is_debcred_mp(o2.external_ref)
                          THEN 'Imp. débitos y créditos' || CASE WHEN o2.external_ref LIKE 'MP%' OR o2.reason ILIKE '%Mercado Pago%' THEN ' MP' ELSE '' END
                        WHEN o2.operation_type::TEXT = 'OWNER_WITHDRAWAL' THEN c2.label
                        WHEN o2.reason ~ '→' THEN initcap(left(btrim(substring(regexp_replace(o2.reason, '^(Owner|Meta [A-Z])[^:]*:\s*', '') FROM '^([^(,]+)')), 1))
                                                   || substr(btrim(substring(regexp_replace(o2.reason, '^(Owner|Meta [A-Z])[^:]*:\s*', '') FROM '^([^(,]+)')), 2)
                        WHEN o2.reason IS NOT NULL AND o2.reason !~* '^(ADR-?\d|phase\d)'
                          THEN nullif(btrim(regexp_replace(split_part(regexp_replace(o2.reason, '^(Owner|Meta [A-Z])[^:]*:\s*', ''), ' — ', 1), '\s*\([^)]*\)\s*$', '')), '') END,
                   c2.label)
                   FROM financial_operation o2 CROSS JOIN LATERAL fin_movement_class(o2.operation_type::TEXT, o2.external_ref) c2 WHERE o2.id = pg.op_id)),
               'detalle', pg.detalle, 'operation_id', pg.op_id, 'ref_uuid', pg.ref_uuid, 'ref_id', pg.ref_id,
               -- [0132] the Mercado Pago SOURCE_ID of an outflow still to classify (the cell classifies it; the concept no longer carries it)
               'mp_source_id', (SELECT mpo.source_id FROM mp_pending_outflow mpo WHERE mpo.provisional_operation_id = pg.op_id),
               -- [0133] a partner withdrawal (not a compensation): its socio can be set from the row
               'retiro', (SELECT jsonb_build_object('event_id', me.id, 'socio_id', me.socio_category_id) FROM management_event me
                           WHERE me.financial_operation_id = pg.op_id AND me.event_type::TEXT = 'RETIRO' AND me.compensates_event_id IS NULL LIMIT 1),
               'purchase_root_id', pg.root, 'purchase_id', (SELECT c.id FROM cur c WHERE c.root = pg.root),
               'supplier_id', pg.supplier_id, 'supplier', (SELECT s.nombre FROM suppliers s WHERE s.id = pg.supplier_id),
               'category_id', pg.category_id, 'subcategory', (SELECT ec.nombre FROM expense_category ec WHERE ec.id = pg.category_id),
               'group_id', (SELECT ec.group_id FROM expense_category ec WHERE ec.id = pg.category_id),
               'category', (SELECT g.nombre FROM expense_category ec JOIN expense_category_group g ON g.id = ec.group_id WHERE ec.id = pg.category_id),
               'nature', pg.nature,
               'accounts', coalesce((SELECT jsonb_agg(jsonb_build_object('account_id', a.id, 'account_name', a.nombre, 'signed_amount',
                                  (SELECT sum(p.signed_amount) FROM financial_posting p WHERE p.financial_operation_id = pg.op_id AND p.financial_account_id = a.id))
                                  ORDER BY (SELECT sum(p.signed_amount) FROM financial_posting p WHERE p.financial_operation_id = pg.op_id AND p.financial_account_id = a.id) NULLS FIRST, a.nombre)
                                FROM financial_account a WHERE a.id = ANY (pg.accounts)), '[]'::jsonb),
               'conciliacion', CASE WHEN pg.op_id IS NULL THEN NULL ELSE (
                   SELECT CASE WHEN count(*) FILTER (WHERE q.needs) = 0 THEN CASE WHEN EXISTS (SELECT 1 FROM mp_reconciliation rr WHERE rr.financial_operation_id = pg.op_id) THEN 'MERCADO_PAGO' END
                               WHEN count(*) FILTER (WHERE q.needs AND q.matched) >= count(*) FILTER (WHERE q.needs) THEN 'CONCILIADA' ELSE 'SIN_CONCILIAR' END
                     FROM (SELECT (cut.anchor_date IS NOT NULL AND p.effective_date > cut.anchor_date) OR sm.id IS NOT NULL AS needs, sm.id IS NOT NULL AS matched
                             FROM financial_posting p
                             LEFT JOIN LATERAL (SELECT al.value_date AS anchor_date FROM fin_statement_cutover c JOIN fin_statement_line al ON al.id = c.cutoff_statement_line_id
                                                 WHERE c.financial_account_id = p.financial_account_id AND c.superseded_at IS NULL) cut ON true
                             LEFT JOIN fin_statement_match sm ON sm.financial_posting_id = p.id AND sm.reversed_at IS NULL
                            WHERE p.financial_operation_id = pg.op_id AND p.financial_account_id IS DISTINCT FROM v_mp) q) END,
               'clasificacion', CASE
                   WHEN pg.row_kind = 'MP_PENDIENTE' THEN 'MP_SIN_VINCULAR'
                   WHEN pg.op_id IS NULL THEN NULL
                   -- [0140] before the cutover (01/12/2026) a pending Mercado Pago outflow is closed without detail: nothing to review
                   WHEN pg.d >= corte_clasificacion_mp() AND (SELECT c.kind FROM financial_operation o CROSS JOIN LATERAL fin_movement_class(o.operation_type::TEXT, o.external_ref) c WHERE o.id = pg.op_id) = 'PENDIENTE_MP' THEN 'MP_SIN_CLASIFICAR'
                   WHEN EXISTS (SELECT 1 FROM expense_pending_classification e WHERE e.payment_operation_id = pg.op_id
                                 AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = e.payment_operation_id AND pu.is_current)) THEN 'GASTO_SIN_CLASIFICAR' END,
               'pending_class_id', CASE WHEN pg.op_id IS NOT NULL THEN (SELECT e.id FROM expense_pending_classification e WHERE e.payment_operation_id = pg.op_id
                                 AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = e.payment_operation_id AND pu.is_current) LIMIT 1) END,
               'pendiente', CASE pg.row_kind
                   WHEN 'GASTO' THEN (SELECT jsonb_build_object('total', e.amount, 'pagado', e.paid, 'pendiente', e.pending, 'vence', e.due_date, 'estimada', e.planned_date) FROM pend_exp e WHERE e.payable_id = pg.ref_uuid)
                   WHEN 'FACTURA' THEN (SELECT jsonb_build_object('purchase_id', f.purchase_id, 'total', f.amount_total, 'pagado', f.debited + f.other_payments, 'cheques_por_debitar', f.scheduled,
                                         'sin_cubrir', f.amount_total - f.debited - f.other_payments - f.scheduled, 'pendiente', f.unpaid, 'vence', f.due_date, 'estimada', f.planned_date)
                                          FROM pend_inv f WHERE f.purchase_root_id = pg.ref_uuid) END
             ) AS j
        FROM page pg) r), '[]'::jsonb))
  );
END $$;

-- ── saldo inicial de caja por conteo ─────────────────────────────────────────
CREATE TABLE cash_opening_count (
  id                     BIGSERIAL PRIMARY KEY,
  financial_account_id   UUID NOT NULL UNIQUE REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  count_date             DATE NOT NULL,
  counted_amount         NUMERIC(15,2) NOT NULL CONSTRAINT chk_cash_opening_counted CHECK (counted_amount >= 0),
  erp_balance            NUMERIC(15,2) NOT NULL,
  difference             NUMERIC(15,2) NOT NULL,
  financial_operation_id BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason                 TEXT,
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cash_opening_difference CHECK (difference = counted_amount - erp_balance),
  CONSTRAINT chk_cash_opening_operation CHECK ((difference = 0) = (financial_operation_id IS NULL))
);
ALTER TABLE cash_opening_count OWNER TO postgres;
ALTER TABLE cash_opening_count ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cash_opening_count FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON cash_opening_count TO authenticated;
CREATE POLICY cash_opening_count_admin_select ON cash_opening_count FOR SELECT USING (current_app_role() = 'ADMIN');
REVOKE ALL ON SEQUENCE cash_opening_count_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- the ERP balance of an account at the end of a day (invoker: the caller's RLS applies)
CREATE FUNCTION fin_account_balance_on(p_account_id UUID, p_date DATE) RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(p.signed_amount), 0)::NUMERIC(15,2) FROM financial_posting p WHERE p.financial_account_id = p_account_id AND p.effective_date <= p_date
$$;
ALTER  FUNCTION fin_account_balance_on(UUID, DATE) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_account_balance_on(UUID, DATE) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_account_balance_on(UUID, DATE) TO authenticated;

CREATE FUNCTION register_cash_opening(p_account_id UUID, p_count_date DATE, p_counted NUMERIC, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid UUID := auth.uid(); v_acc financial_account; v_prev cash_opening_count; v_bal NUMERIC; v_diff NUMERIC; v_op BIGINT; v_id BIGINT; v_res JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  SELECT * INTO v_acc FROM financial_account WHERE id = p_account_id;
  IF NOT FOUND OR NOT v_acc.activo OR v_acc.account_type::TEXT <> 'CASH' THEN RAISE EXCEPTION 'NOT_A_CASH_ACCOUNT: an active cash account is required'; END IF;
  IF p_count_date IS NULL OR p_count_date > (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE THEN RAISE EXCEPTION 'INVALID_DATE: the count date cannot be in the future'; END IF;
  IF p_counted IS NULL OR p_counted < 0 OR p_counted <> round(p_counted, 2) OR p_counted >= 1e13 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cash_opening:' || p_account_id, 0));
  SELECT * INTO v_prev FROM cash_opening_count WHERE financial_account_id = p_account_id;
  IF FOUND THEN
    IF v_prev.count_date = p_count_date AND v_prev.counted_amount = p_counted THEN
      RETURN jsonb_build_object('replayed', true, 'id', v_prev.id, 'erp_balance', v_prev.erp_balance, 'counted', v_prev.counted_amount,
                                'difference', v_prev.difference, 'financial_operation_id', v_prev.financial_operation_id);
    END IF;
    RAISE EXCEPTION 'CASH_OPENING_EXISTS: the opening of this account was recorded on % (% counted)', v_prev.count_date, v_prev.counted_amount;
  END IF;
  PERFORM assert_period_open(p_count_date);
  v_bal := coalesce((SELECT sum(signed_amount) FROM financial_posting WHERE financial_account_id = p_account_id AND effective_date <= p_count_date), 0);
  v_diff := p_counted - v_bal;
  IF v_diff <> 0 THEN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('ADJUSTMENT', p_count_date, 'CASH-OPENING:' || p_account_id || ':' || p_count_date, 'cash_opening_count', p_account_id::TEXT,
            'Saldo inicial (conteo de caja)' || coalesce(' — ' || nullif(btrim(p_reason), ''), ''), v_uid)
    RETURNING id INTO v_op;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_op, p_account_id, v_diff, p_count_date, v_uid);
  END IF;
  INSERT INTO cash_opening_count (financial_account_id, count_date, counted_amount, erp_balance, difference, financial_operation_id, reason, created_by)
  VALUES (p_account_id, p_count_date, p_counted, v_bal, v_diff, v_op, nullif(btrim(p_reason), ''), v_uid)
  RETURNING id INTO v_id;
  v_res := jsonb_build_object('replayed', false, 'id', v_id, 'account_id', p_account_id, 'count_date', p_count_date, 'erp_balance', v_bal,
                              'counted', p_counted, 'difference', v_diff, 'financial_operation_id', v_op);
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('cash_opening_count', v_id::TEXT, 'CASH_OPENING', v_res, coalesce(nullif(btrim(p_reason), ''), 'Saldo inicial por conteo de caja'), v_uid);
  RETURN v_res;
END $$;
ALTER  FUNCTION register_cash_opening(UUID, DATE, NUMERIC, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_cash_opening(UUID, DATE, NUMERIC, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_cash_opening(UUID, DATE, NUMERIC, TEXT) TO authenticated;
