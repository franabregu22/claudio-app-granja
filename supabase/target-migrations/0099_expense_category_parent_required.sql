-- ============================================================================
-- TARGET V1 — 0099 EXPENSE SUBCATEGORY: EXPLICIT PARENT REQUIRED (ADR-024 phase 2, owner GO 2026-10-20)
--
-- 0096 let a subcategory inserted without a parent fall back to "Otros" — temporary compatibility for the pre-ADR-024
-- master editor during the cutover. The ADR-024 frontend (live since 8d15a1c) always sends the parent, so the fallback is
-- removed: a new subcategory without group_id is refused (EXPENSE_CATEGORY_PARENT_REQUIRED). Only expense_category_defaults
-- changes; the legacy-class default (siblings' class, else INDIRECT) is unchanged. No row is touched: every existing
-- subcategory keeps its id, parent, nature and class. No financial operation, no P&L change, no privilege change
-- (CREATE OR REPLACE keeps owner and ACL). SECURITY DEFINER set unchanged (94).
-- ============================================================================

CREATE OR REPLACE FUNCTION expense_category_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.group_id IS NULL THEN
    RAISE EXCEPTION 'EXPENSE_CATEGORY_PARENT_REQUIRED: subcategory "%" needs its category (group_id)', NEW.nombre
      USING ERRCODE = 'not_null_violation';
  END IF;
  IF NEW.pnl_cost_class IS NULL THEN
    SELECT c.pnl_cost_class INTO NEW.pnl_cost_class FROM expense_category c
     WHERE c.group_id = NEW.group_id AND c.group_id IS NOT NULL
     GROUP BY c.pnl_cost_class ORDER BY count(*) DESC, c.pnl_cost_class LIMIT 1;
    NEW.pnl_cost_class := coalesce(NEW.pnl_cost_class, 'INDIRECT');
  END IF;
  RETURN NEW;
END;
$$;
