-- ============================================================================
-- TARGET V1 — 0012 COMMERCIAL PRIVILEGE PERIMETER AND RLS (Phase 14, Slice 1)
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md section 4 (table privileges)
--                                          section 7 (Commercial / ledgers / treasury)
--
-- Why an explicit reset first: 0007 applied the baseline REVOKE/GRANT to the
-- tables that existed at that moment. Tables created later by `postgres` in
-- `public` receive Supabase's default privileges instead, which give anon,
-- authenticated and service_role TRUNCATE, REFERENCES, TRIGGER and MAINTAIN
-- (and UPDATE on sequences). TRUNCATE is not subject to RLS, so leaving those
-- defaults would open a direct path around the RPCs. Every new table therefore
-- starts from nothing and receives exactly the frozen grants.
--
-- OPERATOR receives no policy on any table here (frozen Part 2). Absence of a
-- policy is the denial; no USING (FALSE) policy is written.
-- ============================================================================

-- ── 1. Reset to zero, then the frozen baseline ─────────────────────────────

REVOKE ALL ON pedidos, pedido_lineas, client_ledger, collections,
              financial_operation, financial_posting
       FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON SEQUENCE client_ledger_id_seq, financial_operation_id_seq, financial_posting_id_seq
       FROM PUBLIC, anon, authenticated, service_role;

-- rows still filtered by RLS
GRANT SELECT ON pedidos, pedido_lineas, client_ledger, collections,
                financial_operation, financial_posting
      TO authenticated;

-- ── 2. Narrow write exceptions (section 4) ─────────────────────────────────
-- PENDING orders are edited freely; the DELIVERED/CANCELLED transitions and
-- every post-delivery change are RPC-only.
GRANT INSERT, UPDATE ON pedidos       TO authenticated;
GRANT INSERT, DELETE ON pedido_lineas TO authenticated;          -- restricted to PENDING by RLS

-- client_ledger, collections, financial_operation, financial_posting:
-- no write privilege for any application role. Written only by the
-- SECURITY DEFINER RPCs in 0011 (owner postgres, BYPASSRLS).

-- ── 3. pedidos ─────────────────────────────────────────────────────────────

CREATE POLICY pedidos_admin_select ON pedidos FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY pedidos_admin_insert ON pedidos FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN' AND estado = 'PENDING');

-- The row must be PENDING before and after. Exactly one UPDATE policy exists,
-- so no OR-ed branch can widen it; a DELIVERED order is excluded by USING.
CREATE POLICY pedidos_admin_update_pending ON pedidos FOR UPDATE
  USING (current_app_role() = 'ADMIN' AND estado = 'PENDING')
  WITH CHECK (current_app_role() = 'ADMIN' AND estado = 'PENDING');

-- ── 4. pedido_lineas ───────────────────────────────────────────────────────
-- No UPDATE policy and no UPDATE privilege: snapshot columns are immutable and
-- is_current / version_seq change only inside rectify_delivered_order.

CREATE POLICY pedido_lineas_admin_select ON pedido_lineas FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY pedido_lineas_admin_insert ON pedido_lineas FOR INSERT
  WITH CHECK (
    current_app_role() = 'ADMIN'
    AND EXISTS (SELECT 1 FROM pedidos p WHERE p.id = pedido_id AND p.estado = 'PENDING')
  );

CREATE POLICY pedido_lineas_admin_delete ON pedido_lineas FOR DELETE
  USING (
    current_app_role() = 'ADMIN'
    AND EXISTS (SELECT 1 FROM pedidos p WHERE p.id = pedido_id AND p.estado = 'PENDING')
  );

-- ── 5. Ledgers and treasury: ADMIN SELECT only ─────────────────────────────

CREATE POLICY client_ledger_admin_select ON client_ledger FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY collections_admin_select ON collections FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY financial_operation_admin_select ON financial_operation FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY financial_posting_admin_select ON financial_posting FOR SELECT
  USING (current_app_role() = 'ADMIN');
