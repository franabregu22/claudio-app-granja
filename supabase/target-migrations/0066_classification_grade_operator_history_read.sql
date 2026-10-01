-- ============================================================================
-- TARGET V1 — 0066 CLASSIFICATION GRADE NAMES READABLE FOR HISTORY
-- (ADR-014 §4, owner decision D-CLS-6, Phase 27 acceptance fixes block 4 follow-up)
--
-- 0065 made the grade "Rotos" inactive for new entries. OPERATOR's grade policy
-- (0007) only showed ACTIVE grades, so an OPERATOR's historical session with a
-- Rotos line could not display its grade name. Grade names are non-sensitive
-- reference data: OPERATOR may now read every grade row.
--
-- Unchanged: an inactive grade cannot be used — RPCs 25 / 47 refuse it
-- (GRADE_NOT_FOUND) and the frontend entry form lists only active grades.
-- No write privilege changes.
-- ============================================================================

DROP POLICY classification_grade_operator_select ON classification_grade;
CREATE POLICY classification_grade_operator_select ON classification_grade FOR SELECT
  USING (current_app_role() = 'OPERATOR');
