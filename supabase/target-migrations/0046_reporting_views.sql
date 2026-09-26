-- ============================================================================
-- TARGET V1 — 0046 REPORTING VIEWS (Phase 25, ADR-005)
-- Reporting reads derived values only. Seven views, and nothing else: no table,
-- no materialized view, no function, no RPC, no stored value.
--
-- Every view is security_invoker = true: the caller's own base-table RLS applies
-- inside the view, so a join can never widen access.
--   ADMIN-only views (V1–V5) also carry an explicit ADMIN predicate. OPERATOR
--   gets zero rows, never a partial figure. That matters for V5 in particular:
--   feed_movement has no OPERATOR policy, so an unguarded invoker view would
--   silently compute a wrong internal consumption.
--   Shared views (V6, V7) carry no role predicate. RLS scopes them to assigned
--   flocks (V6) or own classification sessions (V7), so an OPERATOR farm-wide
--   aggregate is impossible by construction. They project no monetary column.
-- Grants: authenticated only; anon and service_role get nothing.
--
-- Period = date_trunc('month', business_date)::DATE, the expression pnl_line_item
-- uses. Every business_date is the fact's own business date, never created_at.
-- Views emit rows only where facts exist; zero months are filled by the consumer
-- from management_period.
-- ============================================================================

-- ── V1 report_sales_line — delivered sales at line level (ADMIN) ───────────
-- Same source predicate as pnl_line_item VENTAS_NETAS: DELIVERED Pedido,
-- current lines, delivered_date. Σ subtotal per period = ventas_netas_devengadas.
CREATE VIEW report_sales_line
WITH (security_invoker = true)
AS
SELECT p.delivered_date                                AS business_date,
       date_trunc('month', p.delivered_date)::DATE     AS period,
       p.id                                            AS pedido_id,
       p.numero_pedido,
       p.cliente_id,
       c.nombre                                        AS cliente_nombre,
       l.id                                            AS pedido_linea_id,
       l.producto_id,
       l.producto_nombre,
       l.cantidad,
       l.precio_unitario,
       l.subtotal,
       p.sales_session_id,
       p.is_aggregated_retail
  FROM pedidos p
  JOIN pedido_lineas l ON l.pedido_id = p.id AND l.is_current
  JOIN clients c       ON c.id = p.cliente_id
 WHERE p.estado = 'DELIVERED'
   AND (SELECT current_app_role()) = 'ADMIN';

-- ── V2 report_balance_period — the three frozen ledgers (ADMIN) ────────────
-- Invariants 5 / 6 / 7: balance = SUM(signed_amount). closing_balance is the
-- running sum up to and including the period; it is derived, never stored.
CREATE VIEW report_balance_period
WITH (security_invoker = true)
AS
WITH m AS (
  SELECT 'CLIENT'::TEXT AS ledger, cliente_id AS entity_id, effective_date, signed_amount FROM client_ledger
  UNION ALL
  SELECT 'SUPPLIER', supplier_id, effective_date, signed_amount FROM supplier_ledger
  UNION ALL
  SELECT 'ACCOUNT', financial_account_id, effective_date, signed_amount FROM financial_posting
), g AS (
  SELECT ledger, entity_id, date_trunc('month', effective_date)::DATE AS period,
         COALESCE(SUM(signed_amount) FILTER (WHERE signed_amount > 0), 0) AS increases,
         COALESCE(SUM(signed_amount) FILTER (WHERE signed_amount < 0), 0) AS decreases,
         SUM(signed_amount) AS net,
         count(*)           AS movements
    FROM m
   GROUP BY ledger, entity_id, date_trunc('month', effective_date)
)
SELECT g.ledger,
       g.entity_id,
       COALESCE(c.nombre, s.nombre, a.nombre)::TEXT AS entity_name,
       g.period,
       g.increases,
       g.decreases,
       g.net,
       g.movements,
       SUM(g.net) OVER (PARTITION BY g.ledger, g.entity_id ORDER BY g.period) AS closing_balance
  FROM g
  LEFT JOIN clients           c ON g.ledger = 'CLIENT'   AND c.id = g.entity_id
  LEFT JOIN suppliers         s ON g.ledger = 'SUPPLIER' AND s.id = g.entity_id
  LEFT JOIN financial_account a ON g.ledger = 'ACCOUNT'  AND a.id = g.entity_id
 WHERE (SELECT current_app_role()) = 'ADMIN';

-- ── V3 report_mp_movement_status — MP reconciliation state (ADMIN) ─────────
-- ADR-003 D4: remaining_unassigned = net_amount − Σ assigned_amount (signed),
-- derived and never stored. The RECONCILED status is owned by RPC 41 and is
-- only displayed here.
CREATE VIEW report_mp_movement_status
WITH (security_invoker = true)
AS
SELECT m.id                                           AS mp_financial_movement_id,
       m.mp_source_record_id,
       s.source_type,
       s.external_id,
       s.processing_status,
       m.occurred_date                                AS business_date,
       date_trunc('month', m.occurred_date)::DATE     AS period,
       m.movement_kind,
       m.gross_amount,
       m.fee_amount,
       m.tax_amount,
       m.net_amount,
       COALESCE(r.assigned_amount, 0)                 AS assigned_amount,
       m.net_amount - COALESCE(r.assigned_amount, 0)  AS remaining_unassigned,
       COALESCE(r.reconciliations, 0)                 AS reconciliations
  FROM mp_financial_movement m
  JOIN mp_source_record s ON s.id = m.mp_source_record_id
  LEFT JOIN (SELECT mp_financial_movement_id, SUM(assigned_amount) AS assigned_amount, count(*) AS reconciliations
               FROM mp_reconciliation
              GROUP BY mp_financial_movement_id) r ON r.mp_financial_movement_id = m.id
 WHERE (SELECT current_app_role()) = 'ADMIN';

-- ── V4 report_feria_session_cash — session cash and variance (ADMIN) ───────
-- Phase 21 K2: expected = OPENING_FUND − EXPENSE − WITHDRAWAL − TRANSFER_OUT.
-- Each COUNT is its own observation with its own variance. Counts are never
-- summed, averaged or picked; a session without a COUNT has one row with NULLs.
CREATE VIEW report_feria_session_cash
WITH (security_invoker = true)
AS
WITH e AS (
  SELECT sales_session_id,
         COALESCE(SUM(amount) FILTER (WHERE event_type = 'OPENING_FUND'), 0) AS opening_fund,
         COALESCE(SUM(amount) FILTER (WHERE event_type = 'EXPENSE'), 0)      AS expenses,
         COALESCE(SUM(amount) FILTER (WHERE event_type = 'WITHDRAWAL'), 0)   AS withdrawals,
         COALESCE(SUM(amount) FILTER (WHERE event_type = 'TRANSFER_OUT'), 0) AS transfers_out,
         count(*) FILTER (WHERE event_type = 'COUNT')                        AS count_events
    FROM sales_session_cash_event
   GROUP BY sales_session_id
)
SELECT s.id                                          AS sales_session_id,
       s.session_date                                AS business_date,
       date_trunc('month', s.session_date)::DATE     AS period,
       s.location,
       s.estado,
       COALESCE(e.opening_fund, 0)                   AS opening_fund,
       COALESCE(e.expenses, 0)                       AS expenses,
       COALESCE(e.withdrawals, 0)                    AS withdrawals,
       COALESCE(e.transfers_out, 0)                  AS transfers_out,
       COALESCE(e.opening_fund, 0) - COALESCE(e.expenses, 0)
         - COALESCE(e.withdrawals, 0) - COALESCE(e.transfers_out, 0) AS expected_cash,
       COALESCE(e.count_events, 0)                   AS count_events,
       k.id                                          AS count_event_id,
       k.event_date                                  AS count_date,
       k.amount                                      AS counted_cash,
       k.amount - (COALESCE(e.opening_fund, 0) - COALESCE(e.expenses, 0)
         - COALESCE(e.withdrawals, 0) - COALESCE(e.transfers_out, 0)) AS variance
  FROM sales_session s
  LEFT JOIN e ON e.sales_session_id = s.id
  LEFT JOIN sales_session_cash_event k ON k.sales_session_id = s.id AND k.event_type = 'COUNT'
 WHERE (SELECT current_app_role()) = 'ADMIN';

-- ── V6 report_flock_day — per-flock daily productive series (ADMIN + OPERATOR)
-- One row per flock and calendar day, from entry_date to COALESCE(exit_date,
-- CURRENT_DATE). The rows are calculated days, not facts.
--   population(D)  = initial_population + Σ current population_events.delta
--                    with event_date <= D (same-day rule, Phase 20 §15)
--   age_weeks      = (D − birth_date) / 7.0; curve week = floor (never round or ceil)
--   eggs_*         = the current daily_production row; NULL on days without one
--   laying_pct     = eggs_total / population(D) × 100 (ADR-005 D1); NULL without a
--                    production row or when population(D) <= 0; never stored.
--                    Broken and dirty eggs are subsets of eggs_total.
--   quality_data_warning = broken > total OR dirty > total (non-authoritative)
--   theoretical_feed_kg  = population(D) × curve g/bird/day / 1000 (exact at 6 decimals), attributed to
--                          the feed type assigned on D (Phase 20 §15)
-- OPERATOR sees only flocks RLS assigns to it (ADR-005 D2). No monetary column,
-- and flocks.supplier_id / purchase_id are deliberately not projected.
CREATE VIEW report_flock_day
WITH (security_invoker = true)
AS
WITH d AS (
  SELECT f.id AS flock_id, f.shed_id, f.genetics_line, f.birth_date, f.initial_population,
         gs::DATE AS business_date
    FROM flocks f
   CROSS JOIN LATERAL generate_series(f.entry_date, COALESCE(f.exit_date, CURRENT_DATE), INTERVAL '1 day') gs
), x AS (
  SELECT d.*,
         d.initial_population + COALESCE((SELECT SUM(pe.delta) FROM population_events pe
                                           WHERE pe.flock_id = d.flock_id AND pe.is_current
                                             AND pe.event_date <= d.business_date), 0) AS population,
         COALESCE((SELECT SUM(-pe.delta) FROM population_events pe
                    WHERE pe.flock_id = d.flock_id AND pe.is_current AND pe.event_type = 'MORTALITY'
                      AND pe.event_date = d.business_date), 0)                          AS mortality,
         COALESCE((SELECT SUM(pe.delta) FROM population_events pe
                    WHERE pe.flock_id = d.flock_id AND pe.is_current AND pe.event_type = 'COUNT_ADJUSTMENT'
                      AND pe.event_date = d.business_date), 0)                          AS count_adjustment,
         (d.business_date - d.birth_date) / 7.0                                         AS age_weeks_exact
    FROM d
)
SELECT x.flock_id,
       x.shed_id,
       sh.nombre                                          AS shed_nombre,
       x.genetics_line,
       x.business_date,
       date_trunc('month', x.business_date)::DATE         AS period,
       dp.id                                              AS daily_production_id,
       dp.eggs_total,
       dp.eggs_broken,
       dp.eggs_dirty,
       x.mortality,
       x.count_adjustment,
       x.population,
       round(x.age_weeks_exact, 4)                        AS age_weeks,
       floor(x.age_weeks_exact)::INTEGER                  AS curve_age_weeks,
       CASE WHEN dp.id IS NULL OR x.population <= 0 THEN NULL
            ELSE round(dp.eggs_total * 100.0 / x.population, 4) END AS laying_pct,
       cv.expected_laying_pct,
       cv.expected_g_per_bird_day,
       fa.feed_type_id,
       CASE WHEN fa.feed_type_id IS NOT NULL AND cv.expected_g_per_bird_day IS NOT NULL
            THEN round(x.population * cv.expected_g_per_bird_day / 1000, 6) END AS theoretical_feed_kg,
       CASE WHEN dp.id IS NULL THEN NULL
            ELSE (dp.eggs_broken > dp.eggs_total OR dp.eggs_dirty > dp.eggs_total) END AS quality_data_warning
  FROM x
  LEFT JOIN sheds sh ON sh.id = x.shed_id
  LEFT JOIN daily_production dp
         ON dp.flock_id = x.flock_id AND dp.production_date = x.business_date AND dp.is_current
  LEFT JOIN genetics_consumption_curve cv
         ON cv.genetics_line = x.genetics_line AND cv.age_weeks = floor(x.age_weeks_exact)::INTEGER
  LEFT JOIN LATERAL (SELECT a.feed_type_id FROM flock_feed_assignment a
                      WHERE a.flock_id = x.flock_id AND a.effective_from <= x.business_date
                        AND (a.effective_to IS NULL OR a.effective_to >= x.business_date)
                      ORDER BY a.effective_from DESC LIMIT 1) fa ON true;

-- ── V5 report_feed_consumption_interval — internal vs theoretical (ADMIN) ───
-- Phase 20 §14, count-day rule: a count dated D is the stock at the close of D.
-- The interval between consecutive counts (d0, d1] of one feed type takes the
-- flows dated after d0 up to and including d1:
--   internal = opening + manufactured − external_sale − loss − adj_negative
--              + adj_positive − closing
-- theoretical = Σ report_flock_day.theoretical_feed_kg over D in (d0, d1]
--               attributed to the same feed type, rounded to 3 decimals.
-- The result is per count interval and is never pro-rated into months.
CREATE VIEW report_feed_consumption_interval
WITH (security_invoker = true)
AS
WITH c AS (
  SELECT feed_type_id,
         lag(id)          OVER w AS opening_count_id,
         lag(count_date)  OVER w AS opening_date,
         lag(quantity_kg) OVER w AS opening_kg,
         id                      AS closing_count_id,
         count_date              AS closing_date,
         quantity_kg             AS closing_kg
    FROM feed_inventory_count
  WINDOW w AS (PARTITION BY feed_type_id ORDER BY count_date)
), i AS (
  SELECT c.*,
         COALESCE((SELECT SUM(m.quantity_kg) FROM feed_manufacturing m
                     JOIN feed_formula_version v ON v.id = m.formula_version_id
                    WHERE v.feed_type_id = c.feed_type_id
                      AND m.manufacturing_date > c.opening_date AND m.manufacturing_date <= c.closing_date), 0) AS manufactured_kg,
         mv.external_sale_kg, mv.loss_kg, mv.adjustment_negative_kg, mv.adjustment_positive_kg,
         (SELECT round(SUM(fd.theoretical_feed_kg), 3) FROM report_flock_day fd
           WHERE fd.feed_type_id = c.feed_type_id
             AND fd.business_date > c.opening_date AND fd.business_date <= c.closing_date) AS theoretical_kg
    FROM c
   CROSS JOIN LATERAL (
     SELECT COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'EXTERNAL_SALE'), 0)       AS external_sale_kg,
            COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'LOSS'), 0)                AS loss_kg,
            COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'ADJUSTMENT_NEGATIVE'), 0) AS adjustment_negative_kg,
            COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'ADJUSTMENT_POSITIVE'), 0) AS adjustment_positive_kg
       FROM feed_movement fm
      WHERE fm.feed_type_id = c.feed_type_id
        AND fm.movement_date > c.opening_date AND fm.movement_date <= c.closing_date) mv
   WHERE c.opening_date IS NOT NULL
)
SELECT i.feed_type_id,
       ft.nombre                                     AS feed_type_nombre,
       i.opening_count_id,
       i.opening_date,
       i.closing_count_id,
       i.closing_date                                AS business_date,
       i.opening_kg,
       i.manufactured_kg,
       i.external_sale_kg,
       i.loss_kg,
       i.adjustment_negative_kg,
       i.adjustment_positive_kg,
       i.closing_kg,
       i.opening_kg + i.manufactured_kg - i.external_sale_kg - i.loss_kg - i.adjustment_negative_kg
         + i.adjustment_positive_kg - i.closing_kg   AS internal_consumption_kg,
       COALESCE(i.theoretical_kg, 0)                 AS theoretical_kg,
       i.opening_kg + i.manufactured_kg - i.external_sale_kg - i.loss_kg - i.adjustment_negative_kg
         + i.adjustment_positive_kg - i.closing_kg - COALESCE(i.theoretical_kg, 0) AS variance_kg
  FROM i
  LEFT JOIN feed_type ft ON ft.id = i.feed_type_id
 WHERE (SELECT current_app_role()) = 'ADMIN';

-- ── V7 report_classification_day — grades by date (ADMIN + OPERATOR) ───────
-- No flock and no production link (FROZEN Part 14). OPERATOR sees only the
-- sessions it created (RLS 0028), so its totals and mix are over its own sessions.
-- The grade label is a LEFT JOIN: OPERATOR reads only active grades, and a
-- deactivated grade must never drop a fact row.
CREATE VIEW report_classification_day
WITH (security_invoker = true)
AS
WITH g AS (
  SELECT c.classification_date, cl.classification_grade_id,
         SUM(cl.quantity)             AS quantity,
         array_agg(DISTINCT c.id)     AS classification_ids
    FROM classification c
    JOIN classification_line cl ON cl.classification_id = c.id
   GROUP BY c.classification_date, cl.classification_grade_id
), s AS (
  SELECT classification_date, count(*) AS sessions
    FROM classification
   GROUP BY classification_date
)
SELECT g.classification_date                              AS business_date,
       date_trunc('month', g.classification_date)::DATE   AS period,
       g.classification_grade_id,
       gr.nombre                                          AS grade_nombre,
       g.quantity,
       SUM(g.quantity) OVER (PARTITION BY g.classification_date) AS day_total,
       CASE WHEN SUM(g.quantity) OVER (PARTITION BY g.classification_date) > 0
            THEN round(g.quantity * 100.0 / SUM(g.quantity) OVER (PARTITION BY g.classification_date), 4) END AS share_pct,
       s.sessions                                         AS day_sessions,
       g.classification_ids
  FROM g
  JOIN s ON s.classification_date = g.classification_date
  LEFT JOIN classification_grade gr ON gr.id = g.classification_grade_id;

-- ── ownership and privileges ───────────────────────────────────────────────
ALTER VIEW report_sales_line                OWNER TO postgres;
ALTER VIEW report_balance_period            OWNER TO postgres;
ALTER VIEW report_mp_movement_status        OWNER TO postgres;
ALTER VIEW report_feria_session_cash        OWNER TO postgres;
ALTER VIEW report_flock_day                 OWNER TO postgres;
ALTER VIEW report_feed_consumption_interval OWNER TO postgres;
ALTER VIEW report_classification_day        OWNER TO postgres;

REVOKE ALL ON report_sales_line, report_balance_period, report_mp_movement_status,
              report_feria_session_cash, report_flock_day, report_feed_consumption_interval,
              report_classification_day
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON report_sales_line, report_balance_period, report_mp_movement_status,
                report_feria_session_cash, report_flock_day, report_feed_consumption_interval,
                report_classification_day
  TO authenticated;
