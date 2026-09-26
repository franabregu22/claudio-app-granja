-- ============================================================================
-- TARGET V1 — 0007 PRIVILEGE PERIMETER AND FOUNDATION RLS
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md sections 1, 3, 4, 5, 6
--
-- Three mechanisms, three jobs, never conflated:
--   table privileges  -> may a role attempt a write at all
--   RLS policies      -> which rows it may read, and write where writes exist
--   SECURITY DEFINER  -> performs period-sensitive writes after validating
--
-- RLS is permissive: policies for one command are OR-ed. Therefore
--   * no `USING (FALSE)` / `AND FALSE` policy appears here -- it grants nothing
--     and denies nothing, and would only look like protection;
--   * absence of a policy IS the denial;
--   * immutability comes from absent privileges, not from a deny policy.
--
-- ADMIN and OPERATOR are BUSINESS roles resolved by current_app_role().
-- They are not PostgreSQL roles. SERVICE_ROLE is a Supabase backend privilege
-- tested with auth.role(), never a business role.
-- ============================================================================

-- ── 1. Baseline: application roles may never write directly ────────────────

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
GRANT  SELECT ON ALL TABLES IN SCHEMA public TO authenticated;   -- rows still filtered by RLS

-- Sequences: append-only ledgers own their keys; no application role needs them.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- ── 2. Narrow re-grants: master data, which is not a period-sensitive fact ──
-- Foundations subset of the frozen grant list. Tables from later phases are
-- absent because they do not exist yet.

GRANT INSERT, UPDATE ON clients, products, price_history, suppliers, sheds,
                        financial_account, expense_category, classification_grade,
                        projects, feed_type, feed_ingredient, genetics_consumption_curve,
                        operator_assignments
      TO authenticated;                                          -- ADMIN-only via RLS

-- Deliberately NOT granted to any application role:
--   perfiles            -> no self-escalation (see section 2 of the RLS spec)
--   management_period   -> status changes only via close/reopen RPCs
--   audit_events        -> written only inside RPCs, never altered
--   flocks              -> created through a privileged path
-- These stay writable only by the function owner.

-- ── 3. IDENTITY ────────────────────────────────────────────────────────────

CREATE POLICY perfiles_admin_select ON perfiles FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- Any authenticated user may read ONLY their own row (UI bootstrapping).
CREATE POLICY perfiles_self_select ON perfiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY perfiles_admin_insert ON perfiles FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');

CREATE POLICY perfiles_admin_update ON perfiles FOR UPDATE
  USING (current_app_role() = 'ADMIN')
  WITH CHECK (current_app_role() = 'ADMIN');

-- ── 4. PERIOD CONTROL ──────────────────────────────────────────────────────
-- SELECT only, deliberately. No INSERT/UPDATE policy and no privilege, so
-- `status` can change only through close_management_period / reopen_management_period.

CREATE POLICY management_period_read ON management_period FOR SELECT
  USING (current_app_role() IN ('ADMIN','OPERATOR'));

-- ── 5. AUDIT ───────────────────────────────────────────────────────────────

CREATE POLICY audit_events_admin_select ON audit_events FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY audit_events_operator_own ON audit_events FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND performed_by = auth.uid()
    AND entity_type IN ('daily_production','population_events','classification',
                        'flock_weighing','temperature_record','feed_manufacturing',
                        'feed_inventory_count','sales_session_movement')
  );

-- ── 6. AUTHORIZATION MATRIX ────────────────────────────────────────────────

CREATE POLICY operator_assignments_admin_select ON operator_assignments FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY operator_assignments_admin_insert ON operator_assignments FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY operator_assignments_admin_update ON operator_assignments FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

CREATE POLICY operator_assignments_operator_own ON operator_assignments FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND operator_id = auth.uid());

-- ── 7. MASTERS: ADMIN full, OPERATOR read-only on active rows ──────────────

CREATE POLICY sheds_admin_select ON sheds FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY sheds_admin_insert ON sheds FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY sheds_admin_update ON sheds FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY sheds_operator_select ON sheds FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND activo = true);

CREATE POLICY feed_type_admin_select ON feed_type FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY feed_type_admin_insert ON feed_type FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY feed_type_admin_update ON feed_type FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY feed_type_operator_select ON feed_type FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND activo = true);

CREATE POLICY feed_ingredient_admin_select ON feed_ingredient FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY feed_ingredient_admin_insert ON feed_ingredient FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY feed_ingredient_admin_update ON feed_ingredient FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY feed_ingredient_operator_select ON feed_ingredient FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND activo = true);

CREATE POLICY classification_grade_admin_select ON classification_grade FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY classification_grade_admin_insert ON classification_grade FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY classification_grade_admin_update ON classification_grade FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY classification_grade_operator_select ON classification_grade FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND activo = true);

CREATE POLICY genetics_curve_admin_select ON genetics_consumption_curve FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY genetics_curve_admin_insert ON genetics_consumption_curve FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY genetics_curve_admin_update ON genetics_consumption_curve FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY genetics_curve_operator_select ON genetics_consumption_curve FOR SELECT
  USING (current_app_role() = 'OPERATOR');

-- ── 8. MASTERS: ADMIN only. OPERATOR gets NO policy, therefore NO access ───
-- Frozen Part 2 forbids OPERATOR access to clients, prices, suppliers,
-- financial accounts and cost categories.

CREATE POLICY clients_admin_select ON clients FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY clients_admin_insert ON clients FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY clients_admin_update ON clients FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

CREATE POLICY products_admin_select ON products FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY products_admin_insert ON products FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY products_admin_update ON products FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

CREATE POLICY price_history_admin_select ON price_history FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY price_history_admin_insert ON price_history FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY price_history_admin_update ON price_history FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

CREATE POLICY suppliers_admin_select ON suppliers FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY suppliers_admin_insert ON suppliers FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY suppliers_admin_update ON suppliers FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

CREATE POLICY financial_account_admin_select ON financial_account FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY financial_account_admin_insert ON financial_account FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY financial_account_admin_update ON financial_account FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

CREATE POLICY financial_account_service_select ON financial_account FOR SELECT
  USING (auth.role() = 'service_role');

CREATE POLICY expense_category_admin_select ON expense_category FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY expense_category_admin_insert ON expense_category FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY expense_category_admin_update ON expense_category FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

CREATE POLICY projects_admin_select ON projects FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY projects_admin_insert ON projects FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY projects_admin_update ON projects FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

-- ── 9. flocks: read-only for application roles ─────────────────────────────

CREATE POLICY flocks_admin_select ON flocks FOR SELECT USING (current_app_role() = 'ADMIN');

CREATE POLICY flocks_operator_assigned ON flocks FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND id IN (SELECT flock_id FROM operator_assignments
               WHERE operator_id = auth.uid() AND activo = true)
  );
