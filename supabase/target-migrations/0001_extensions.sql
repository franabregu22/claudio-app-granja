-- ============================================================================
-- TARGET V1 — 0001 EXTENSIONS
-- Authority: IMPLEMENTATION_DEPENDENCY_ORDER_V1.md, Phase 0
--
-- btree_gist supplies the GiST `<>` search strategy for uuid and int4, required
-- by excl_pedido_lineas_single_current_version (Phase 14, not created here).
-- Installed in Foundations because the dependency order places it before any table.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;
