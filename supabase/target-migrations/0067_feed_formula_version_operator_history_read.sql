-- ============================================================================
-- TARGET V1 — 0067 FORMULA VERSIONS READABLE FOR MANUFACTURING HISTORY
-- (ADR-014 §4, owner decision D-FEED-7, Phase 27 acceptance fixes block 4 follow-up)
--
-- OPERATOR reads every manufacturing record (0029 policy), but its
-- feed_formula_version policy only showed versions effective TODAY, so the
-- history could not show the exact version used by an older record.
-- A version row holds no cost (feed_type_id, version, validity, author); cost
-- stays in feed_formula_line, which OPERATOR still cannot read (composition
-- without cost through feed_formula_line_safe, unchanged).
-- OPERATOR may now read every version row. No write privilege changes.
-- ============================================================================

DROP POLICY feed_formula_version_operator_select ON feed_formula_version;
CREATE POLICY feed_formula_version_operator_select ON feed_formula_version FOR SELECT
  USING (current_app_role() = 'OPERATOR');
