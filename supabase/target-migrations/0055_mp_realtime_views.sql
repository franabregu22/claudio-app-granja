-- ============================================================================
-- TARGET V1 — 0055 MERCADO PAGO REAL-TIME VIEWS (ADR-006, Step 10)
-- Authority: ADR006_IMPLEMENTATION_ORDER_V1 step 10 (planned file name "0052"; the ledger's next
--            free number is 0055); ADR006_IDEMPOTENCY_AND_STATE_V1 §2.3 (the two derived axes, the
--            evaluation order); ADR006_SCHEMA_DELTA_V1 §9 (columns); ADR-006 §6.4 / §8a (terminology);
--            ADR006_WEBHOOK_WORKER_DESIGN_V1 §4a / §5 (health alerts); ADR006_RLS_AND_SECURITY_V1 §1.
--
-- Pattern of 0046: security_invoker = true (the caller's base-table RLS applies), an explicit
-- ADMIN filter, OWNER postgres, SELECT granted to authenticated only. anon and service_role have
-- no access (the backend never reads these views). OPERATOR gets 0 rows. No function, no table,
-- no stored state: every value is derived from the authoritative rows at read time.
--
-- Axis A (MP reconciliation) and axis B (client attribution) are separate columns and never
-- combined. Axis B never produces a review reason; CLIENT_UNASSIGNED is a valid terminal state.
-- Only states the implemented backend can produce are derived from real rows; the reversal
-- terms (REFUND / CHARGEBACK movements) evaluate to zero while those kinds stay deferred.
-- ============================================================================

-- ── report_mp_receipt_status: one row per payment / APPROVAL movement ────────
CREATE VIEW report_mp_receipt_status
WITH (security_invoker = true)
AS
WITH base AS (
  SELECT m.id                         AS mp_financial_movement_id,
         t.id                         AS transition_id,
         t.resource_id                AS payment_id,
         m.mp_source_record_id,
         s.source_type,
         s.processing_status          AS source_processing_status,
         m.occurred_date,
         m.gross_amount,
         m.fee_amount,
         m.tax_amount,
         m.net_amount,
         rc.assigned_amount,
         rc.reconciliations,
         ls.processing_status         AS latest_snapshot_processing_status,
         ls.mp_status                 AS latest_snapshot_status,
         EXISTS (SELECT 1 FROM mp_report_match x
                  WHERE x.transition_id = t.id AND x.outcome = 'MATCHED')                         AS report_matched,
         (SELECT count(*) FROM mp_report_match x
           WHERE x.transition_id = t.id AND x.is_exception AND x.resolution IS NULL)              AS open_report_exceptions,
         EXISTS (SELECT 1 FROM mp_transition_identity c
                  WHERE c.resource_type = t.resource_type AND c.resource_id = t.resource_id
                    AND c.transition = 'CHARGEBACK')                                              AS chargeback_claimed,
         EXISTS (SELECT 1 FROM mp_webhook_delivery d
                  WHERE d.topic_class = 'payment' AND d.resource_id = t.resource_id AND d.status = 'FAILED_PERMANENT'
                    AND NOT EXISTS (SELECT 1 FROM mp_webhook_delivery f
                                     WHERE f.topic_class = 'payment' AND f.resource_id = d.resource_id
                                       AND f.status = 'FETCHED' AND f.updated_at > d.updated_at))  AS delivery_failed_permanent,
         EXISTS (SELECT 1 FROM mp_webhook_delivery d
                  WHERE d.topic_class = 'payment' AND d.resource_id = t.resource_id AND d.status = 'CONFIG_BLOCKED'
                    AND NOT EXISTS (SELECT 1 FROM mp_webhook_delivery f
                                     WHERE f.topic_class = 'payment' AND f.resource_id = d.resource_id
                                       AND f.status = 'FETCHED' AND f.updated_at > d.updated_at))  AS delivery_config_blocked,
         EXISTS (SELECT 1 FROM mp_webhook_delivery r
                   JOIN mp_webhook_delivery sg ON sg.id = r.triggered_by_delivery_id
                  WHERE r.origin = 'chargeback_refresh' AND r.resource_id = t.resource_id
                    AND sg.topic_class = 'chargeback' AND r.status <> 'FETCHED')                  AS chargeback_refresh_pending,
         (m.created_at < NOW() - INTERVAL '15 minutes')                                           AS older_than_15_min,
         rv.applied_reversal_amount,
         rv.unapplied_reversal_count,
         rv.unapplied_reversal_amount,
         al.active_attributed,
         fl.open_flag_id
    FROM mp_financial_movement m
    JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
    JOIN mp_source_record s       ON s.id = m.mp_source_record_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(r.assigned_amount), 0) AS assigned_amount, count(*) AS reconciliations
        FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id) rc
    LEFT JOIN LATERAL (
      -- the current resource = the api_payment snapshot seen last: the latest of its ingestion and of
      -- the latest FETCHED delivery that linked it (a re-fetch of identical content re-uses the old
      -- version, so ingestion time alone would miss an A → B → A sequence)
      SELECT a.processing_status, a.event_data ->> 'status' AS mp_status
        FROM mp_source_record a
        LEFT JOIN LATERAL (SELECT max(d.updated_at) AS last_fetch
                             FROM mp_webhook_delivery d
                            WHERE d.source_record_id = a.id AND d.status = 'FETCHED') lf ON true
       WHERE a.source_type = 'api_payment' AND a.external_id LIKE 'MPPAY:' || t.resource_id || ':%'
       ORDER BY greatest(a.ingested_at, lf.last_fetch) DESC, a.external_id DESC
       LIMIT 1) ls ON true
    CROSS JOIN LATERAL (
      -- REFUND / CHARGEBACK movements of the same payment; applied = A1 wrote MPA:{t}:SETTLE
      SELECT COALESCE(SUM(abs(m2.gross_amount)) FILTER (WHERE ap.applied), 0)     AS applied_reversal_amount,
             count(*) FILTER (WHERE NOT ap.applied)                               AS unapplied_reversal_count,
             COALESCE(SUM(abs(m2.gross_amount)) FILTER (WHERE NOT ap.applied), 0) AS unapplied_reversal_amount
        FROM mp_transition_identity t2
        JOIN mp_financial_movement m2 ON m2.id = t2.mp_financial_movement_id
        CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM mp_reconciliation r2
                                            WHERE r2.mp_financial_movement_id = m2.id
                                              AND r2.idempotency_key = 'MPA:' || t2.id || ':SETTLE') AS applied) ap
       WHERE t2.resource_type = t.resource_type AND t2.resource_id = t.resource_id
         AND t2.transition IN ('REFUND', 'CHARGEBACK')) rv
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(a.amount), 0) AS active_attributed
        FROM mp_client_allocation a WHERE a.mp_financial_movement_id = m.id) al
    LEFT JOIN LATERAL (
      SELECT f.id AS open_flag_id
        FROM mp_attribution_flag f
       WHERE f.mp_financial_movement_id = m.id AND f.cleared_at IS NULL
       ORDER BY f.requested_at, f.id
       LIMIT 1) fl ON true
   WHERE m.movement_kind = 'payment' AND t.transition = 'APPROVAL'
     AND (SELECT current_app_role()) = 'ADMIN'
), reasons AS (
  SELECT b.*,
         array_remove(ARRAY[
           CASE WHEN b.source_processing_status = 'ERROR'
                  OR b.latest_snapshot_processing_status = 'ERROR'             THEN 'SOURCE_ERROR' END,
           CASE WHEN b.delivery_failed_permanent                                THEN 'DELIVERY_FAILED_PERMANENT' END,
           CASE WHEN b.delivery_config_blocked                                  THEN 'DELIVERY_CONFIG_BLOCKED' END,
           CASE WHEN b.open_report_exceptions > 0                               THEN 'REPORT_EXCEPTION' END,
           CASE WHEN b.reconciliations = 0 AND b.older_than_15_min              THEN 'APPLICATION_STUCK' END,
           CASE WHEN b.latest_snapshot_status = 'charged_back' AND NOT b.chargeback_claimed THEN 'CHARGEBACK_ALERT' END,
           CASE WHEN b.latest_snapshot_status = 'in_mediation' AND NOT b.chargeback_claimed THEN 'MEDIATION_ALERT' END,
           CASE WHEN b.chargeback_refresh_pending                               THEN 'CHARGEBACK_SIGNAL_REFRESH_PENDING' END,
           CASE WHEN b.unapplied_reversal_count > 0                             THEN 'UNAPPLIED_REVERSAL' END
         ], NULL) AS review_reasons,
         b.gross_amount - b.applied_reversal_amount AS effective_applied_receipt
    FROM base b
)
SELECT r.mp_financial_movement_id,
       r.transition_id,
       r.payment_id,
       r.mp_source_record_id,
       r.source_type,
       r.source_processing_status,
       r.latest_snapshot_status,
       r.occurred_date,
       r.gross_amount,
       r.fee_amount,
       r.tax_amount,
       r.net_amount,
       r.assigned_amount,
       r.report_matched,
       CASE WHEN cardinality(r.review_reasons) > 0                       THEN 'REVIEW_REQUIRED'
            WHEN r.assigned_amount = r.net_amount AND r.report_matched   THEN 'REPORT_CONFIRMED'
            WHEN r.assigned_amount = r.net_amount                        THEN 'POSTED'
            ELSE 'NORMALIZED' END                                        AS axis_a_state,
       r.review_reasons,
       r.effective_applied_receipt,
       r.unapplied_reversal_count,
       r.unapplied_reversal_amount,
       r.active_attributed,
       CASE WHEN r.open_flag_id IS NOT NULL AND r.active_attributed < r.effective_applied_receipt THEN 'CLIENT_RESOLUTION_REQUESTED'
            WHEN r.effective_applied_receipt > 0 AND r.active_attributed = r.effective_applied_receipt THEN 'CLIENT_ASSIGNED'
            WHEN r.active_attributed > 0 AND r.active_attributed < r.effective_applied_receipt       THEN 'CLIENT_PARTIAL'
            ELSE 'CLIENT_UNASSIGNED' END                                 AS axis_b_state,
       (r.open_flag_id IS NOT NULL)                                      AS open_flag,
       r.open_flag_id
  FROM reasons r;

-- ── report_mp_delivery_health: one summary row (ADMIN), no row otherwise ─────
CREATE VIEW report_mp_delivery_health
WITH (security_invoker = true)
AS
SELECT count(*)                                                              AS total_deliveries,
       count(*) FILTER (WHERE d.status = 'RECEIVED')                         AS received_count,
       count(*) FILTER (WHERE d.status = 'PROCESSING')                       AS processing_count,
       count(*) FILTER (WHERE d.status = 'FETCHED')                          AS fetched_count,
       count(*) FILTER (WHERE d.status = 'SIGNAL_RECORDED')                  AS signal_recorded_count,
       count(*) FILTER (WHERE d.status = 'FAILED_RETRYABLE')                 AS failed_retryable_count,
       count(*) FILTER (WHERE d.status = 'FAILED_PERMANENT')                 AS failed_permanent_count,
       count(*) FILTER (WHERE d.status = 'CONFIG_BLOCKED')                   AS config_blocked_count,
       count(*) FILTER (WHERE d.status = 'UNSUPPORTED')                      AS unsupported_count,
       count(*) FILTER (WHERE d.status IN ('RECEIVED', 'FAILED_RETRYABLE') AND d.next_attempt_at <= NOW()) AS due_count,
       min(d.next_attempt_at) FILTER (WHERE d.status IN ('RECEIVED', 'FAILED_RETRYABLE'))                 AS oldest_due_at,
       (SELECT COALESCE(jsonb_object_agg(x.code, x.n), '{}'::jsonb)
          FROM (SELECT COALESCE(f.last_error_code, '-') AS code, count(*) AS n
                  FROM mp_webhook_delivery f WHERE f.status = 'FAILED_PERMANENT'
                 GROUP BY 1) x)                                              AS failed_permanent_by_error_code,
       bool_or(d.status = 'CONFIG_BLOCKED') IS TRUE                          AS auth_configuration_error,
       min(d.updated_at) FILTER (WHERE d.status = 'CONFIG_BLOCKED')          AS config_blocked_oldest,
       count(*) FILTER (WHERE d.key_conflict_of IS NOT NULL)                 AS key_conflicts,
       count(*) FILTER (WHERE d.topic_class = 'chargeback' AND d.status = 'SIGNAL_RECORDED'
                          AND d.signal_resolution IS NULL)                   AS unresolved_chargeback_signals,
       (count(*) FILTER (WHERE d.status IN ('FAILED_PERMANENT', 'CONFIG_BLOCKED')
                           OR (d.topic_class = 'chargeback' AND d.status = 'SIGNAL_RECORDED' AND d.signal_resolution IS NULL))) > 0
                                                                             AS review_required
  FROM mp_webhook_delivery d
HAVING (SELECT current_app_role()) = 'ADMIN';

-- ── report_mp_report_exceptions: unresolved exception matches (ADMIN) ────────
CREATE VIEW report_mp_report_exceptions
WITH (security_invoker = true)
AS
SELECT x.id                        AS match_id,
       x.outcome,
       x.report_source_id,
       rs.source_type              AS report_source_type,
       rs.external_id              AS report_external_id,
       x.transition_id,
       t.resource_type,
       t.resource_id,
       t.transition,
       t.mp_financial_movement_id,
       x.coverage_from,
       x.coverage_to,
       x.detail,
       x.created_at,
       'REVIEW_REQUIRED'::TEXT     AS axis_a_state
  FROM mp_report_match x
  LEFT JOIN mp_transition_identity t ON t.id = x.transition_id
  LEFT JOIN mp_source_record rs      ON rs.id = x.report_source_id
 WHERE x.is_exception AND x.resolution IS NULL
   AND (SELECT current_app_role()) = 'ADMIN';

ALTER VIEW report_mp_receipt_status    OWNER TO postgres;
ALTER VIEW report_mp_delivery_health   OWNER TO postgres;
ALTER VIEW report_mp_report_exceptions OWNER TO postgres;

REVOKE ALL ON report_mp_receipt_status, report_mp_delivery_health, report_mp_report_exceptions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON report_mp_receipt_status, report_mp_delivery_health, report_mp_report_exceptions
  TO authenticated;
