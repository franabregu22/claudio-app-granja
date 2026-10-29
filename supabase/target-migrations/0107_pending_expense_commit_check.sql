-- ============================================================================
-- TARGET V1 — 0107 GASTOS PENDIENTES: COMMIT-TIME CHECK INDEPENDENT OF THE CALLER (production fix, W-0003 2026-10-29)
--
-- Production symptom: the first pending expense confirmed from WhatsApp (W-0003) answered USER_NOT_FOUND_OR_INACTIVE; nothing
-- was recorded (the whole transaction rolled back; the draft stayed DRAFT).
-- Cause: purchase_casual_settlement_check() (0106) is a DEFERRED constraint trigger, so it runs at COMMIT, after wa_confirm has
-- restored the caller's identity (the gateway user, which has no ERP profile). It was SECURITY INVOKER: its read of
-- expense_payable went through that table's RLS (current_app_role() = 'ADMIN'), which raises for a user without profile.
-- A paid casual purchase never reaches that read (paid_operation_id set), so the paid circuit was unaffected.
-- Fix: the check runs as its owner (SECURITY DEFINER, postgres, BYPASSRLS) — an integrity rule must not depend on who commits.
-- Unchanged: the rule, its message, the trigger (deferred, insert / update on purchases), owner and grants (no EXECUTE to anyone).
-- ============================================================================

ALTER FUNCTION purchase_casual_settlement_check() SECURITY DEFINER;
ALTER FUNCTION purchase_casual_settlement_check() SET search_path = public, pg_temp;
