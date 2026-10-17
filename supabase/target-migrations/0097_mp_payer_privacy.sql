-- ============================================================================
-- TARGET V1 — 0097 MERCADO PAGO PAYER PRIVACY + SAFE PAYER DISPLAY (ADR-024 §6, owner GO 2026-10-16)
--
-- The raw provider payload (mp_source_record.event_data: Payment API snapshot with payer email, document, phone, bank data)
-- is no longer readable by any API role. Trusted server paths keep it: SECURITY DEFINER functions (normalization, application,
-- mp_auto_allocate, classification routes) and the service role (worker).
--   1. Column privileges: authenticated reads every mp_source_record column EXCEPT event_data (RLS unchanged).
--   2. The four ADMIN views that read the payload run with the owner's rights (security_invoker off) and keep their explicit
--      ADMIN filter: fin_mp_report_activity, fin_mp_technical_review, report_mp_receipt_status, fin_mp_unlinked_inflows.
--      None of them projects the payload.
--   3. fin_mp_unlinked_inflows (0095 body) gains payer_id (the only identity key — mp_payer_client_map / mp_auto_allocate),
--      payer_display_name (bank_info.payer.long_name → card.cardholder.name; never the email or the document) and the client
--      the payer is mapped to (mapped_client_id / mapped_client_name).
-- No financial write. SECURITY DEFINER set unchanged.
-- ============================================================================

REVOKE SELECT ON TABLE mp_source_record FROM authenticated;
GRANT SELECT (id, source_type, external_id, occurred_at, occurred_date, ingested_at, processing_status, processed_at, processing_note)
  ON TABLE mp_source_record TO authenticated;

ALTER VIEW fin_mp_report_activity   SET (security_invoker = false);
ALTER VIEW fin_mp_technical_review  SET (security_invoker = false);
ALTER VIEW report_mp_receipt_status SET (security_invoker = false);

CREATE OR REPLACE VIEW fin_mp_unlinked_inflows
WITH (security_invoker = false)   -- [0097] reads the protected payload with the owner's rights; the ADMIN filter stays
AS
SELECT m.id AS movement_id,
       CASE WHEN t.resource_type = 'payment' THEN t.resource_id ELSE split_part(t.resource_id, ':', 1) END::TEXT AS source_id,
       s.occurred_at, m.occurred_date AS business_date, m.gross_amount AS amount, m.net_amount,
       CASE coalesce(s.event_data ->> 'payment_method_id', s.event_data ->> 'PAYMENT_METHOD')
         WHEN 'cvu' THEN 'CVU' WHEN 'debin_transfer' THEN 'DEBIN' ELSE 'RECEIPT' END AS inflow_subtype,
       coalesce(s.event_data ->> 'operation_type' = 'account_fund', false) AS account_fund,
       nullif(btrim(s.event_data ->> 'description'), '') AS description,
       h.id IS NOT NULL AS is_historical,
       coalesce(al.allocated, 0)::NUMERIC(15,2) AS allocated_amount,
       (m.gross_amount - coalesce(al.allocated, 0))::NUMERIC(15,2) AS remaining_amount,
       -- [0097] safe payer projection (ADR-024 §6): identity = payer.id; display = bank holder name → card holder name
       pay.payer_id,
       pay.payer_display_name,
       pm.cliente_id AS mapped_client_id,
       (SELECT cl.nombre::TEXT FROM clients cl WHERE cl.id = pm.cliente_id) AS mapped_client_name
  FROM mp_financial_movement m
  JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id AND t.transition = 'APPROVAL'
  JOIN mp_source_record s ON s.id = m.mp_source_record_id
  CROSS JOIN LATERAL (SELECT CASE WHEN s.source_type = 'api_payment' THEN nullif(btrim(s.event_data #>> '{payer,id}'), '') END::TEXT AS payer_id,
                             coalesce(nullif(btrim(s.event_data #>> '{point_of_interaction,transaction_data,bank_info,payer,long_name}'), ''),
                                      nullif(btrim(s.event_data #>> '{card,cardholder,name}'), ''))::TEXT AS payer_display_name) pay
  LEFT JOIN mp_payer_client_map pm ON pm.mp_payer_id = pay.payer_id AND pm.activo
  LEFT JOIN mp_historical_row h ON s.source_type = 'csv_import' AND h.identity = s.external_id
  LEFT JOIN (SELECT mp_financial_movement_id, sum(amount) AS allocated FROM mp_client_allocation GROUP BY 1) al ON al.mp_financial_movement_id = m.id
 WHERE m.movement_kind IN ('payment', 'inflow') AND m.gross_amount > 0
   AND EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id)          -- in the balance
   AND NOT EXISTS (SELECT 1 FROM mp_inbound_reclassification x WHERE x.mp_financial_movement_id = m.id)   -- not an own transfer
   AND m.gross_amount - coalesce(al.allocated, 0) > 0
   AND (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_mp_unlinked_inflows OWNER TO postgres;
REVOKE ALL    ON fin_mp_unlinked_inflows FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_unlinked_inflows TO authenticated;
