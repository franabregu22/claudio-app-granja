-- ============================================================================
-- TARGET V1 — 0031 FEED PRIVILEGE PERIMETER, RLS AND SAFE VIEW (Phase 20)
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md §4, §8 (feed working set and the
--            three cost-protection layers), §10 coverage matrix:
--              feed_formula_version   S,I | S effective    | ADMIN
--              feed_formula_line      S,I | — (safe view)   | ADMIN
--              feed_manufacturing     S   | S               | RPC 26 only
--              feed_movement          S   | —               | RPC 28 only
--              feed_inventory_count   S   | S               | RPC 27 only
--              flock_feed_assignment  S   | S assigned      | RPC 29 only
--            DATABASE_INVARIANTS_V1.md 17 (no UPDATE privilege on snapshot
--            tables for any application role)
--
-- The two formula tables receive SELECT + INSERT only (matrix §10, invariant
-- 17). No UPDATE and no DELETE privilege exists on them for any application
-- role, and §8 defines no UPDATE/DELETE policy: formula versions and their
-- composition are insert-only for the application.
-- Since 0013 new objects are born owner-only; the explicit reset keeps this
-- migration correct on its own.
-- ============================================================================

REVOKE ALL ON feed_formula_version, feed_formula_line, feed_manufacturing, feed_movement,
              feed_inventory_count, flock_feed_assignment
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE feed_movement_id_seq, feed_inventory_count_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

-- rows still filtered by RLS
GRANT SELECT ON feed_formula_version, feed_formula_line, feed_manufacturing, feed_movement,
                feed_inventory_count, flock_feed_assignment
  TO authenticated;

-- master path for formulas: ADMIN-only via the INSERT policies below
GRANT INSERT ON feed_formula_version, feed_formula_line TO authenticated;

-- ── operational facts (RPC-written) ────────────────────────────────────────
CREATE POLICY feed_manufacturing_admin_select ON feed_manufacturing FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY feed_manufacturing_operator_select ON feed_manufacturing FOR SELECT
  USING (current_app_role() = 'OPERATOR');          -- operational facts only; no cost columns exist here

CREATE POLICY feed_inventory_count_admin_select ON feed_inventory_count FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY feed_inventory_count_operator_select ON feed_inventory_count FOR SELECT
  USING (current_app_role() = 'OPERATOR');          -- operators perform the physical counts

CREATE POLICY feed_movement_admin_select ON feed_movement FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY flock_feed_assignment_admin_select ON flock_feed_assignment FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY flock_feed_assignment_operator_select ON flock_feed_assignment FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND flock_id IN (SELECT flock_id FROM operator_assignments
                     WHERE operator_id = auth.uid() AND activo = true)
  );

-- ── cost protection, layer 1: formula tables ───────────────────────────────
CREATE POLICY feed_formula_version_admin_select ON feed_formula_version FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY feed_formula_version_admin_insert ON feed_formula_version FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY feed_formula_version_operator_select ON feed_formula_version FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND effective_from <= CURRENT_DATE
    AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  );

-- ADMIN only: this table carries unit_cost_snapshot. OPERATOR gets NO policy.
CREATE POLICY feed_formula_line_admin_select ON feed_formula_line FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY feed_formula_line_admin_insert ON feed_formula_line FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');

-- ── cost protection, layer 2: composition without cost ─────────────────────
-- security_invoker = false: the view runs as its owner, bypassing the ADMIN-only
-- base policy; the cost-free projection is what makes it safe.
CREATE VIEW feed_formula_line_safe
WITH (security_invoker = false)
AS
  SELECT ffl.formula_version_id,
         ffl.ingredient_id,
         fi.nombre AS ingredient_name,
         ffl.quantity_kg
    FROM feed_formula_line ffl
    JOIN feed_ingredient   fi ON fi.id = ffl.ingredient_id;
-- unit_cost_snapshot is deliberately absent from the projection

ALTER VIEW feed_formula_line_safe OWNER TO postgres;
REVOKE ALL  ON feed_formula_line_safe FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON feed_formula_line_safe TO authenticated;

-- ── cost protection, layer 3 ───────────────────────────────────────────────
-- no UPDATE / DELETE / TRUNCATE on any feed table for any application role.
