-- ============================================================================
-- TARGET V1 — 0105 PENDIENTES MP: PERFORMANCE OF fin_mp_pending_classification (owner GO 2026-10-28)
--
-- Production symptom: Caja → Pendientes de clasificar (current) and the pending summary answered SQLSTATE 57014 (statement
-- timeout, authenticated = 8 s): fin_mp_pending_classification took ~9.8 s, fin_mp_pending_summary ~10.4 s.
-- Cause: the LEFT JOIN to mp_historical_row compared h.identity with an expression built from the pending row
-- (source_id || ':' || CASE … || ':D'). mp_historical_row has RLS; a join clause holding non-leakproof functions (textcat) can
-- not be evaluated before its security qual, so the unique index mp_historical_row_identity_key was never used: every pending
-- outflow scanned the whole table and evaluated current_app_role() per row (207 × 3,081 rows, ~1.3 M buffer hits).
-- Fix (view text only): the historical identity is computed in a sub-select kept apart from the join (OFFSET 0 prevents its
-- pull-up), so the join is a plain column comparison (texteq, leakproof) and uses the existing unique index.
-- Unchanged: the columns (names, types, order), every filter and criterion, the ADMIN rule, security_invoker, owner and grants.
-- Verified read-only on production data before this migration: 203 rows identical (EXCEPT ALL both ways, same md5),
-- summary buckets identical; 9,813 ms → 16 ms (view), 10,437 ms → 442 ms (summary). No table, row or function changes.
-- ============================================================================

CREATE OR REPLACE VIEW fin_mp_pending_classification
WITH (security_invoker = true)
AS
SELECT u.* FROM (
  SELECT 'OUT:' || p.source_id AS pending_key, p.source_id::TEXT AS source_id, p.kind::TEXT AS kind, 'OUT'::TEXT AS direction,
         p.occurred_date AS business_date, coalesce(s.occurred_at, h.occurred_at) AS occurred_at, p.amount, abs(m.gross_amount) AS economic_amount,
         (m.fee_amount + m.tax_amount) AS charges_amount, a.nombre::TEXT AS account_name,
         CASE p.kind WHEN 'PAYOUT' THEN 'payout' ELSE 'payment' END AS description,
         'PENDING'::TEXT AS status, true AS already_posted, p.provisional_operation_id AS financial_operation_id,
         h.id IS NOT NULL AS is_historical,                                      -- [0095] ADR-022 evidence
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
REVOKE ALL    ON fin_mp_pending_classification FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_pending_classification TO authenticated;
