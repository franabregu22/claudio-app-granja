-- ============================================================================
-- TARGET V1 — 0013 FOUNDATION PRIVILEGE HARDENING
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md section 3 (service_role),
--                                          section 4 (table privileges)
--
-- Finding (Phase 14 review): the Foundation tables created in 0003–0005 kept
-- Supabase's default privileges for objects created by `postgres` in `public`:
--     authenticated : REFERENCES, TRIGGER, MAINTAIN        (x t m)
--     service_role  : TRUNCATE, REFERENCES, TRIGGER, MAINTAIN (D x t m)
--     sequences     : service_role UPDATE                    (w)
-- 0007 revoked only INSERT/UPDATE/DELETE/TRUNCATE from authenticated and ALL
-- from anon; it never addressed service_role or the remaining default bits.
-- None of these privileges is part of the frozen perimeter. TRUNCATE in
-- particular is not subject to RLS.
--
-- This migration (1) resets every Foundation table and sequence to zero for
-- the application roles and rebuilds exactly the frozen grants, and (2) removes
-- the same broad grants from the DEFAULT PRIVILEGES of `postgres` in `public`,
-- so tables and sequences of later phases are born with no application-role
-- privilege and receive only what their own migration grants explicitly.
--
-- Scope limits:
--   * Only the `postgres`-owned default ACL for schema `public` is changed.
--     The `supabase_admin` defaults and the `storage` schema defaults belong to
--     Supabase internals and are left untouched. No role is altered.
--   * RLS policies are unchanged.
--   * Commercial tables (0012) already hold exactly the frozen grants.
-- ============================================================================

-- ── 1. Foundation tables: reset to zero for every application role ─────────

REVOKE ALL ON perfiles, management_period, audit_events,
              sheds, clients, products, suppliers, financial_account, expense_category,
              classification_grade, projects, feed_type, genetics_consumption_curve,
              price_history, feed_ingredient, flocks, operator_assignments
       FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. Rebuild exactly the frozen grants ───────────────────────────────────

-- baseline read; rows still filtered by RLS (spec section 4)
GRANT SELECT ON perfiles, management_period, audit_events,
                sheds, clients, products, suppliers, financial_account, expense_category,
                classification_grade, projects, feed_type, genetics_consumption_curve,
                price_history, feed_ingredient, flocks, operator_assignments
      TO authenticated;

-- narrow master-data writes, ADMIN-only via RLS (same list as 0007)
GRANT INSERT, UPDATE ON clients, products, price_history, suppliers, sheds,
                        financial_account, expense_category, classification_grade,
                        projects, feed_type, feed_ingredient, genetics_consumption_curve,
                        operator_assignments
      TO authenticated;

-- service_role: only the read the spec assigns in Foundations (as 0009)
GRANT SELECT ON financial_account TO service_role;

-- anon: nothing.

-- ── 3. Foundation sequences: no application role needs them ────────────────

REVOKE ALL ON SEQUENCE management_period_id_seq, audit_events_id_seq
       FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. Default privileges for future objects created by postgres in public ─
-- Before: tables  -> anon/authenticated/service_role = Dxtm
--         sequences -> anon/authenticated/service_role = w
-- After:  no application-role privilege by default; every later-phase
--         migration grants its frozen set explicitly (as 0012 already does).

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
