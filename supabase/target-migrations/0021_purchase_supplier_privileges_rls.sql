-- ============================================================================
-- TARGET V1 — 0021 PURCHASES / FREIGHT PRIVILEGE PERIMETER AND RLS (Phase 17)
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md section 4 (table privileges),
--            section 7 (ADMIN SELECT only; purchase_attachment ADMIN insert;
--            OPERATOR no policy), section 10 coverage matrix:
--              purchases           S | RPC 13/14 only
--              purchase_line       S | RPC 13/14 only
--              purchase_attachment S,I | RPC 13 + ADMIN adds
--              freight             S | RPC 16 only
--              freight_allocation  S | RPC 17 only
--
-- Since 0013 new tables are born owner-only; the explicit reset keeps this
-- migration correct on its own. All five tables use UUID keys: no sequences.
-- supplier_ledger (0015/0017) keeps its existing perimeter unchanged.
-- ============================================================================

REVOKE ALL ON purchases, purchase_line, purchase_attachment, freight, freight_allocation
       FROM PUBLIC, anon, authenticated, service_role;

-- rows still filtered by RLS
GRANT SELECT ON purchases, purchase_line, purchase_attachment, freight, freight_allocation
      TO authenticated;

-- frozen narrow exception (section 4): ADMIN may add attachments to an existing
-- purchase. UPDATE is granted by the frozen list but no UPDATE policy exists, so
-- no row can be updated; there is no DELETE privilege at all.
GRANT INSERT, UPDATE ON purchase_attachment TO authenticated;

-- ── purchases / purchase_line / freight / freight_allocation: ADMIN SELECT only

CREATE POLICY purchases_admin_select ON purchases FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY purchase_line_admin_select ON purchase_line FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY freight_admin_select ON freight FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY freight_allocation_admin_select ON freight_allocation FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- ── purchase_attachment (section 7): ADMIN SELECT + ADMIN INSERT, no DELETE ──

CREATE POLICY purchase_attachment_admin_select ON purchase_attachment FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY purchase_attachment_admin_insert ON purchase_attachment FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');
