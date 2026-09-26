-- ============================================================================
-- LEGACY DATA PROFILING — READ-ONLY
--
-- Purpose: produce the evidence MIGRATION_STRATEGY_V1.md needs to turn every
-- "REQUIRES DATA PROFILING" entry in its §5 matrix into a confirmed mapping, and
-- to supply the facts behind gaps G-1…G-15 and owner decisions OD-1, OD-2, OD-3.
--
-- READ-ONLY BY CONSTRUCTION: every statement is a SELECT. There is no INSERT,
-- UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE or COPY … TO anywhere in this file.
-- It creates nothing in the database it runs against and corrects nothing.
--
-- It also decides nothing: it reports distributions and counts. Mapping rules are
-- written down afterwards, by a human, in the migration strategy.
--
-- HOW TO RUN (by the owner, with a read-only role):
--   psql "$LEGACY_READONLY_DATABASE_URL" -f scripts/test-env/profiling/legacy-profile.sql \
--        --echo-queries > .planning/legacy-schema/profile-$(date -u +%Y%m%dT%H%M%SZ).txt
--
-- NOT EXECUTED in Phase 12: no authenticated, provably read-only connection to the
-- live database exists in that session.
--
-- The window boundary used throughout is the frozen one: 2026-01-01.
-- ============================================================================

\set WINDOW_START '2026-01-01'

-- ---------------------------------------------------------------------------
-- 0. INVENTORY — confirms which tables actually exist (G-1)
-- ---------------------------------------------------------------------------
SELECT c.relname               AS table_name,
       c.reltuples::bigint     AS approx_rows,
       c.relrowsecurity        AS rls_enabled,
       (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY c.relname;

-- Exact row counts for the tables the strategy maps (G-2).
-- Kept as one statement so the output is a single comparable table.
SELECT 'perfiles'            AS t, count(*) FROM perfiles
UNION ALL SELECT 'clientes',            count(*) FROM clientes
UNION ALL SELECT 'productos',           count(*) FROM productos
UNION ALL SELECT 'precios_historial',   count(*) FROM precios_historial
UNION ALL SELECT 'precios_actuales',    count(*) FROM precios_actuales
UNION ALL SELECT 'pedidos',             count(*) FROM pedidos
UNION ALL SELECT 'pedido_lineas',       count(*) FROM pedido_lineas
UNION ALL SELECT 'pagos',               count(*) FROM pagos
UNION ALL SELECT 'pago_en_caja',        count(*) FROM pago_en_caja
UNION ALL SELECT 'movimientos_caja',    count(*) FROM movimientos_caja
UNION ALL SELECT 'cuentas_caja',        count(*) FROM cuentas_caja
UNION ALL SELECT 'arqueos_caja',        count(*) FROM arqueos_caja
UNION ALL SELECT 'categorias_finanzas', count(*) FROM categorias_finanzas
UNION ALL SELECT 'cheques',             count(*) FROM cheques
UNION ALL SELECT 'comisiones',          count(*) FROM comisiones
UNION ALL SELECT 'facturas',            count(*) FROM facturas
UNION ALL SELECT 'lotes',               count(*) FROM lotes
UNION ALL SELECT 'producciones',        count(*) FROM producciones
UNION ALL SELECT 'recuentos_lote',      count(*) FROM recuentos_lote
 ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 1. WINDOW COVERAGE — how much data falls inside 2026+ (principle 1)
-- ---------------------------------------------------------------------------
SELECT 'pedidos'          AS t, min(fecha_operacion) AS min_date, max(fecha_operacion) AS max_date,
       count(*) FILTER (WHERE fecha_operacion >= :'WINDOW_START') AS in_window,
       count(*) FILTER (WHERE fecha_operacion <  :'WINDOW_START') AS before_window
  FROM pedidos
UNION ALL
SELECT 'pagos', min(fecha_pago), max(fecha_pago),
       count(*) FILTER (WHERE fecha_pago >= :'WINDOW_START'),
       count(*) FILTER (WHERE fecha_pago <  :'WINDOW_START')
  FROM pagos
UNION ALL
SELECT 'movimientos_caja', min(fecha_operacion), max(fecha_operacion),
       count(*) FILTER (WHERE fecha_operacion >= :'WINDOW_START'),
       count(*) FILTER (WHERE fecha_operacion <  :'WINDOW_START')
  FROM movimientos_caja
UNION ALL
SELECT 'producciones', min(fecha), max(fecha),
       count(*) FILTER (WHERE fecha >= :'WINDOW_START'),
       count(*) FILTER (WHERE fecha <  :'WINDOW_START')
  FROM producciones
UNION ALL
SELECT 'recuentos_lote', min(fecha_recuento), max(fecha_recuento),
       count(*) FILTER (WHERE fecha_recuento >= :'WINDOW_START'),
       count(*) FILTER (WHERE fecha_recuento <  :'WINDOW_START')
  FROM recuentos_lote
UNION ALL
SELECT 'cheques', min(fecha_emision), max(fecha_emision),
       count(*) FILTER (WHERE fecha_emision >= :'WINDOW_START'),
       count(*) FILTER (WHERE fecha_emision <  :'WINDOW_START')
  FROM cheques
 ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 2. ENUM-LIKE DISTRIBUTIONS — every legacy value must map to a frozen value
-- ---------------------------------------------------------------------------

-- perfiles.rol: 3 legacy values → 2 target roles (needs owner confirmation per user)
SELECT rol, count(*), count(*) FILTER (WHERE activo) AS active FROM perfiles GROUP BY rol ORDER BY 2 DESC;

-- pedidos.estado → order_estado
SELECT estado, count(*) FROM pedidos GROUP BY estado ORDER BY 2 DESC;

-- pedidos.rectificado: G-11, orders whose prior version is unrecoverable
SELECT rectificado, count(*) FROM pedidos GROUP BY rectificado;

-- pagos.metodo_pago: 7 legacy values vs 4 target; cheque/echeq must NOT become collections (G-10)
SELECT metodo_pago, count(*), sum(monto) AS total FROM pagos GROUP BY metodo_pago ORDER BY 2 DESC;

-- movimientos_caja.forma_pago: legacy set lacks 'cheque' although cheques link to movimientos
SELECT forma_pago, count(*) FROM movimientos_caja GROUP BY forma_pago ORDER BY 2 DESC;

-- movimientos_caja.naturaleza_gasto: G-9, two values are NOT purchases
SELECT naturaleza_gasto, tipo, count(*), sum(monto) AS total
  FROM movimientos_caja GROUP BY naturaleza_gasto, tipo ORDER BY 3 DESC;

-- movimientos_caja.estado
SELECT estado, count(*) FROM movimientos_caja GROUP BY estado ORDER BY 2 DESC;

-- cuentas_caja.tipo: 2 legacy values vs 3 target account_type
SELECT tipo, count(*), count(*) FILTER (WHERE activa) AS active FROM cuentas_caja GROUP BY tipo;

-- cheques.estado: 4 legacy values, no direction column (OD-3)
SELECT estado, count(*), sum(monto) AS total FROM cheques GROUP BY estado ORDER BY 2 DESC;

-- lotes.estado: 'Planificado' has no target state (G-14)
SELECT estado, count(*) FROM lotes GROUP BY estado;

-- clientes.categoria: 'feria municipal' is a tag, not a session
SELECT categoria, count(*), count(*) FILTER (WHERE activo) AS active
  FROM clientes GROUP BY categoria ORDER BY 2 DESC;

-- productos.categoria: 'alimento' is the only feed-adjacent legacy data (G-13)
SELECT categoria, count(*) FROM productos GROUP BY categoria ORDER BY 2 DESC;

-- ---------------------------------------------------------------------------
-- 3. NULL RATES on columns the target makes mandatory
-- ---------------------------------------------------------------------------
SELECT 'pedidos.cliente_id'        AS col, count(*) FILTER (WHERE cliente_id IS NULL) AS nulls, count(*) AS total FROM pedidos
UNION ALL SELECT 'pedidos.fecha_operacion',  count(*) FILTER (WHERE fecha_operacion IS NULL), count(*) FROM pedidos
UNION ALL SELECT 'pedidos.monto_total',      count(*) FILTER (WHERE monto_total IS NULL),     count(*) FROM pedidos
UNION ALL SELECT 'producciones.lote_id',     count(*) FILTER (WHERE lote_id IS NULL),         count(*) FROM producciones  -- G-6
UNION ALL SELECT 'producciones.galpon',      count(*) FILTER (WHERE galpon IS NULL),          count(*) FROM producciones
UNION ALL SELECT 'producciones.mortandad',   count(*) FILTER (WHERE mortandad IS NULL),       count(*) FROM producciones
UNION ALL SELECT 'lotes.galpon',             count(*) FILTER (WHERE galpon IS NULL),          count(*) FROM lotes
UNION ALL SELECT 'lotes.aves_iniciales',     count(*) FILTER (WHERE aves_iniciales_postura IS NULL), count(*) FROM lotes
UNION ALL SELECT 'lotes.linea',              count(*) FILTER (WHERE linea IS NULL),           count(*) FROM lotes
UNION ALL SELECT 'movimientos_caja.cuenta_origen',  count(*) FILTER (WHERE cuenta_origen IS NULL),  count(*) FROM movimientos_caja  -- G-8
UNION ALL SELECT 'movimientos_caja.cuenta_destino', count(*) FILTER (WHERE cuenta_destino IS NULL), count(*) FROM movimientos_caja
UNION ALL SELECT 'movimientos_caja.categoria',      count(*) FILTER (WHERE categoria IS NULL),      count(*) FROM movimientos_caja
UNION ALL SELECT 'movimientos_caja.naturaleza',     count(*) FILTER (WHERE naturaleza_gasto IS NULL), count(*) FROM movimientos_caja
UNION ALL SELECT 'cheques.girador',          count(*) FILTER (WHERE girador IS NULL OR btrim(girador) = ''), count(*) FROM cheques
UNION ALL SELECT 'cheques.movimiento_caja_id', count(*) FILTER (WHERE movimiento_caja_id IS NULL), count(*) FROM cheques
 ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 4. FREE-TEXT REFERENCES that must resolve to a target FK (G-7, G-8, OD-3)
-- ---------------------------------------------------------------------------

-- galpon: distinct spellings, including tilde variants → sheds normalisation map
SELECT galpon, count(*) AS uses, 'lotes' AS src FROM lotes GROUP BY galpon
UNION ALL
SELECT galpon, count(*), 'producciones' FROM producciones GROUP BY galpon
 ORDER BY 1, 3;

-- Same shed spelled differently: collapses accents/case/space to expose variants
SELECT lower(translate(btrim(galpon), 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) AS normalised,
       count(DISTINCT galpon)                                      AS spellings,
       string_agg(DISTINCT galpon, ' | ')                          AS variants
  FROM (SELECT galpon FROM lotes UNION ALL SELECT galpon FROM producciones) s
 WHERE galpon IS NOT NULL
 GROUP BY 1 HAVING count(DISTINCT galpon) > 1
 ORDER BY 2 DESC;

-- cuenta_origen / cuenta_destino vs cuentas_caja.nombre → text→account map
SELECT v AS account_text, count(*) AS uses,
       EXISTS (SELECT 1 FROM cuentas_caja c WHERE c.nombre = v) AS matches_cuentas_caja
  FROM (SELECT cuenta_origen AS v FROM movimientos_caja WHERE cuenta_origen IS NOT NULL
        UNION ALL
        SELECT cuenta_destino FROM movimientos_caja WHERE cuenta_destino IS NOT NULL) s
 GROUP BY v ORDER BY 3, 2 DESC;

-- cheques.girador vs clientes.nombre: evidence for OD-3, NOT a mapping rule.
-- An exact-name hit is a candidate to confirm, never an automatic assignment.
SELECT ch.girador,
       count(*)                                                        AS cheques,
       EXISTS (SELECT 1 FROM clientes cl WHERE cl.nombre = ch.girador)  AS exact_client_match
  FROM cheques ch
 WHERE ch.girador IS NOT NULL
 GROUP BY ch.girador ORDER BY 3, 2 DESC;

-- ---------------------------------------------------------------------------
-- 5. DUPLICATE CANDIDATE KEYS — target uniqueness must hold after migration
-- ---------------------------------------------------------------------------

-- daily_production target: partial UNIQUE (flock_id, production_date) WHERE is_current
SELECT lote_id, fecha, count(*) AS rows
  FROM producciones WHERE lote_id IS NOT NULL
 GROUP BY lote_id, fecha HAVING count(*) > 1 ORDER BY 3 DESC;

-- Same, keyed by the text galpon, since lote_id is optional
SELECT galpon, fecha, count(*) AS rows
  FROM producciones GROUP BY galpon, fecha HAVING count(*) > 1 ORDER BY 3 DESC;

-- flocks target: one ACTIVE flock per shed
SELECT galpon, count(*) AS active_flocks
  FROM lotes WHERE estado = 'Activo' GROUP BY galpon HAVING count(*) > 1;

-- collections target: receipt_id is UNIQUE and derived from pagos.id, so pagos.id
-- must be unique (it is the PK) — this checks for same-client same-day same-amount
-- rows that a naive dedup might collapse and must not
SELECT cliente_id, fecha_pago, monto, count(*) AS rows
  FROM pagos GROUP BY cliente_id, fecha_pago, monto HAVING count(*) > 1 ORDER BY 4 DESC;

-- cheques: same number reused (target allows this, so confirm it happens)
SELECT numero, count(*) AS rows, count(DISTINCT banco) AS banks
  FROM cheques GROUP BY numero HAVING count(*) > 1 ORDER BY 2 DESC;

-- flock_weighing / temperature_record targets have UNIQUE natural keys but no legacy source.

-- ---------------------------------------------------------------------------
-- 6. ORPHAN REFERENCES — must be zero, or the row is not migrated (G-6, G-8)
-- ---------------------------------------------------------------------------
SELECT 'pedidos→clientes'            AS ref, count(*) AS orphans
  FROM pedidos p LEFT JOIN clientes c ON c.id = p.cliente_id WHERE c.id IS NULL
UNION ALL
SELECT 'pedido_lineas→pedidos', count(*)
  FROM pedido_lineas l LEFT JOIN pedidos p ON p.id = l.pedido_id WHERE p.id IS NULL
UNION ALL
SELECT 'pagos→clientes', count(*)
  FROM pagos g LEFT JOIN clientes c ON c.id = g.cliente_id WHERE c.id IS NULL
UNION ALL
SELECT 'pago_en_caja→pagos', count(*)
  FROM pago_en_caja pc LEFT JOIN pagos g ON g.id = pc.pago_id WHERE g.id IS NULL
UNION ALL
SELECT 'producciones→lotes', count(*)
  FROM producciones pr LEFT JOIN lotes lo ON lo.id = pr.lote_id
 WHERE pr.lote_id IS NOT NULL AND lo.id IS NULL
UNION ALL
SELECT 'recuentos_lote→lotes', count(*)
  FROM recuentos_lote r LEFT JOIN lotes lo ON lo.id = r.lote_id WHERE lo.id IS NULL
UNION ALL
SELECT 'cheques→movimientos_caja', count(*)
  FROM cheques ch LEFT JOIN movimientos_caja m ON m.id = ch.movimiento_caja_id
 WHERE ch.movimiento_caja_id IS NOT NULL AND m.id IS NULL           -- RISK 4 of the register
UNION ALL
SELECT 'comisiones→movimientos_caja', count(*)
  FROM comisiones co LEFT JOIN movimientos_caja m ON m.id = co.movimiento_caja_id
 WHERE co.movimiento_caja_id IS NOT NULL AND m.id IS NULL
 ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 7. OD-1 EVIDENCE — mortality: producciones.mortandad vs recuentos_lote
--    Quantifies how far the two sources disagree. It does NOT pick a winner.
-- ---------------------------------------------------------------------------
WITH counted AS (
  SELECT r.lote_id, r.fecha_recuento, r.aves_contadas, r.mortandad_esperada, r.diferencia,
         lag(r.fecha_recuento) OVER (PARTITION BY r.lote_id ORDER BY r.fecha_recuento) AS prev_count_date
    FROM recuentos_lote r
),
mortality_between AS (
  SELECT c.lote_id, c.fecha_recuento, c.aves_contadas, c.mortandad_esperada, c.diferencia,
         c.prev_count_date,
         (SELECT coalesce(sum(p.mortandad), 0)
            FROM producciones p
           WHERE p.lote_id = c.lote_id
             AND p.fecha > coalesce(c.prev_count_date, '1900-01-01'::date)
             AND p.fecha <= c.fecha_recuento) AS daily_mortality_sum
    FROM counted c
)
SELECT lote_id, prev_count_date, fecha_recuento,
       daily_mortality_sum        AS from_producciones,
       mortandad_esperada         AS expected_in_recuento,
       diferencia                 AS recuento_diferencia,
       aves_contadas,
       daily_mortality_sum - coalesce(mortandad_esperada, 0) AS disagreement
  FROM mortality_between
 ORDER BY abs(daily_mortality_sum - coalesce(mortandad_esperada, 0)) DESC NULLS LAST;

-- Derived population vs physical count, per flock at its latest count
WITH latest AS (
  SELECT DISTINCT ON (lote_id) lote_id, fecha_recuento, aves_contadas
    FROM recuentos_lote ORDER BY lote_id, fecha_recuento DESC
)
SELECT l.id AS lote_id, l.galpon, l.aves_iniciales_postura,
       (SELECT coalesce(sum(p.mortandad), 0) FROM producciones p
         WHERE p.lote_id = l.id AND p.fecha <= la.fecha_recuento) AS mortality_to_date,
       l.aves_iniciales_postura
         - (SELECT coalesce(sum(p.mortandad), 0) FROM producciones p
             WHERE p.lote_id = l.id AND p.fecha <= la.fecha_recuento) AS derived_population,
       la.aves_contadas                                            AS physically_counted,
       la.fecha_recuento
  FROM lotes l JOIN latest la ON la.lote_id = l.id
 ORDER BY abs(
   l.aves_iniciales_postura
     - (SELECT coalesce(sum(p.mortandad), 0) FROM producciones p
         WHERE p.lote_id = l.id AND p.fecha <= la.fecha_recuento)
     - la.aves_contadas) DESC;

-- ---------------------------------------------------------------------------
-- 8. OD-2 EVIDENCE — can pagos + pedidos demonstrate each client's real balance?
--    Reports the computable position per client and how complete its inputs are.
--    It does NOT assert that the result is the true balance.
-- ---------------------------------------------------------------------------
SELECT c.id AS cliente_id, c.nombre, c.activo,
       (SELECT count(*) FROM pedidos p
         WHERE p.cliente_id = c.id AND p.estado = 'entregado'
           AND p.fecha_operacion >= :'WINDOW_START')                       AS delivered_in_window,
       (SELECT count(*) FROM pedidos p
         WHERE p.cliente_id = c.id AND p.estado = 'entregado'
           AND p.fecha_operacion <  :'WINDOW_START')                       AS delivered_before_window,
       (SELECT coalesce(sum(p.monto_total), 0) FROM pedidos p
         WHERE p.cliente_id = c.id AND p.estado = 'entregado'
           AND p.fecha_operacion >= :'WINDOW_START')                       AS sales_in_window,
       (SELECT coalesce(sum(g.monto), 0) FROM pagos g
         WHERE g.cliente_id = c.id AND g.fecha_pago >= :'WINDOW_START')    AS payments_in_window,
       (SELECT coalesce(sum(p.monto_total), 0) FROM pedidos p
         WHERE p.cliente_id = c.id AND p.estado = 'entregado'
           AND p.fecha_operacion >= :'WINDOW_START')
     - (SELECT coalesce(sum(g.monto), 0) FROM pagos g
         WHERE g.cliente_id = c.id AND g.fecha_pago >= :'WINDOW_START')    AS computable_window_position
  FROM clientes c
 ORDER BY abs(
   (SELECT coalesce(sum(p.monto_total), 0) FROM pedidos p
     WHERE p.cliente_id = c.id AND p.estado = 'entregado' AND p.fecha_operacion >= :'WINDOW_START')
 - (SELECT coalesce(sum(g.monto), 0) FROM pagos g
     WHERE g.cliente_id = c.id AND g.fecha_pago >= :'WINDOW_START')) DESC;

-- A client with activity before the window cannot have its balance demonstrated
-- from in-window documents alone. This count is the core OD-2 input.
SELECT count(*) AS clients_with_pre_window_activity
  FROM clientes c
 WHERE EXISTS (SELECT 1 FROM pedidos p WHERE p.cliente_id = c.id AND p.fecha_operacion < :'WINDOW_START')
    OR EXISTS (SELECT 1 FROM pagos  g WHERE g.cliente_id = c.id AND g.fecha_pago      < :'WINDOW_START');

-- ---------------------------------------------------------------------------
-- 9. OD-3 EVIDENCE — open instruments needing a direction and counterparty
-- ---------------------------------------------------------------------------
SELECT ch.id, ch.numero, ch.banco, ch.monto, ch.estado,
       ch.fecha_emision, ch.fecha_vencimiento, ch.girador,
       EXISTS (SELECT 1 FROM clientes cl WHERE cl.nombre = ch.girador) AS girador_matches_client,
       ch.movimiento_caja_id IS NOT NULL                               AS linked_to_movimiento
  FROM cheques ch
 WHERE ch.estado NOT IN ('cobrado', 'cancelado')   -- still open at profiling time
 ORDER BY ch.fecha_vencimiento NULLS LAST;

-- ---------------------------------------------------------------------------
-- 10. ORDER-LINE SHAPES — G-12: three coexisting representations
-- ---------------------------------------------------------------------------
SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM pedido_lineas l WHERE l.pedido_id = p.id)) AS has_rows_in_table,
       count(*) FILTER (WHERE p.lineas IS NOT NULL AND jsonb_typeof(p.lineas::jsonb) = 'array')  AS lineas_is_array,
       count(*) FILTER (WHERE p.lineas IS NOT NULL AND jsonb_typeof(p.lineas::jsonb) = 'object') AS lineas_is_object,
       count(*) FILTER (WHERE p.lineas IS NULL
                          AND NOT EXISTS (SELECT 1 FROM pedido_lineas l WHERE l.pedido_id = p.id)) AS no_lines_at_all,
       count(*) AS total_pedidos
  FROM pedidos p;

-- V-10 / V-12 precondition: stored monto_total vs the sum of its lines
SELECT p.id, p.monto_total,
       (SELECT coalesce(sum(l.cantidad * l.precio_unitario), 0) FROM pedido_lineas l WHERE l.pedido_id = p.id) AS line_sum,
       p.monto_total
         - (SELECT coalesce(sum(l.cantidad * l.precio_unitario), 0) FROM pedido_lineas l WHERE l.pedido_id = p.id) AS difference
  FROM pedidos p
 WHERE EXISTS (SELECT 1 FROM pedido_lineas l WHERE l.pedido_id = p.id)
 ORDER BY abs(p.monto_total
   - (SELECT coalesce(sum(l.cantidad * l.precio_unitario), 0) FROM pedido_lineas l WHERE l.pedido_id = p.id)) DESC;

-- ---------------------------------------------------------------------------
-- 11. G-4 EVIDENCE — how many expenses clear the purchase evidence threshold
--     Reports what is determinable. The threshold is applied afterwards.
-- ---------------------------------------------------------------------------
SELECT tipo, naturaleza_gasto,
       count(*)                                                       AS rows,
       count(*) FILTER (WHERE categoria IS NOT NULL)                  AS has_category,
       count(*) FILTER (WHERE fecha_operacion >= :'WINDOW_START')      AS in_window,
       count(*) FILTER (WHERE monto > 0)                              AS positive_amount,
       sum(monto)                                                     AS total
  FROM movimientos_caja
 WHERE tipo = 'egreso'
 GROUP BY tipo, naturaleza_gasto
 ORDER BY 3 DESC;

-- Free-text concepts, to judge whether a supplier is identifiable at all (G-4)
SELECT concepto, count(*) AS uses, sum(monto) AS total
  FROM movimientos_caja WHERE tipo = 'egreso'
 GROUP BY concepto ORDER BY 2 DESC LIMIT 200;

-- ---------------------------------------------------------------------------
-- 12. G-3 EVIDENCE — facturas has no type definition in the app; describe it
-- ---------------------------------------------------------------------------
SELECT column_name, data_type, is_nullable, character_maximum_length
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'facturas'
 ORDER BY ordinal_position;

SELECT count(*) AS facturas_rows FROM facturas;

-- ---------------------------------------------------------------------------
-- 13. MP COVERAGE — V-13 precondition
-- ---------------------------------------------------------------------------
SELECT date_trunc('month', occurred_at)::date AS month, count(*) AS source_rows
  FROM mp_source_record GROUP BY 1 ORDER BY 1;

SELECT count(*) AS total, count(DISTINCT external_id) AS distinct_external_ids
  FROM mp_source_record;

-- ============================================================================
-- END. Every statement above is a SELECT: this file cannot modify the database.
-- Column names assume the legacy schema described in MIGRATION_STRATEGY_V1.md §3,
-- which is itself derived from application code. Confirm them against the schema
-- snapshot (G-1) before the first run and adjust any that differ.
-- ============================================================================
