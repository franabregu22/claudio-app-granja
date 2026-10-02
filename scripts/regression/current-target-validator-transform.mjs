/**
 * ADR-006 Step 13 — the ONLY differences between the historical Phase 26 validator
 * (scripts/phase26/validate-clean-cutover.sql, read-only) and the current-target validator
 * (scripts/regression/validate-current-target.sql). ADR006_TEST_MATRIX_V1 CT-3:
 *   - C01: "ledger = 46" becomes "ledger = migration files present" (psql variable, derived at run time);
 *   - C16: extended with the six ADR-006 tables (0 rows: the clean cutover loads no MP history);
 *   - [ADR-016] every read of `products` / `expense_category` excludes the two reference rows seeded by
 *     migration 0070 (the system product "Venta Feria (resumen)" and the category "Gastos de Feria"),
 *     exactly as C05 already counts the seeded CONSUMIDOR FINAL apart from the migrated clients.
 * Every other check and the canonical DIGEST query are carried verbatim. The CT harness re-derives the
 * current validator from the historical file with this function and requires byte equality.
 */
export const HEADER_HISTORICAL_END = '-- ============================================================================\n\nWITH e AS';
export const ADR006_TABLES = ['mp_webhook_delivery', 'mp_transition_identity', 'mp_report_match', 'mp_client_allocation', 'mp_payer_client_map', 'mp_attribution_flag'];

const HEADER = `-- ============================================================================
-- ADR-006 STEP 13 — CURRENT-TARGET CLEAN-CUTOVER VALIDATION (read-only, repeatable)
--
-- Derived mechanically from the historical Phase 26 validator
-- scripts/phase26/validate-clean-cutover.sql (never modified), per ADR006_TEST_MATRIX_V1 CT-3:
--   C01  ledger = the number of migration files present (psql variable :expected_migrations,
--        derived at run time by scripts/regression/clean-cutover-current-target.mjs; not hard-coded)
--   C16  extended with the six ADR-006 tables (${ADR006_TABLES.join(', ')}) = 0 rows
--   [ADR-016] products / expense_category are read without the two rows seeded by 0070
--        ("Venta Feria (resumen)", is_system; "Gastos de Feria"), so the migrated state compares as in Phase 26
-- Every other check (C02–C24) and the canonical DIGEST query are identical to the historical file.
-- Emits CHECK|<id>|PASS or FAIL|<detail> and DIGEST|<table>|<md5>|<rows>, exactly as Phase 26.
-- ============================================================================

WITH e AS`;

const C01_OLD = `  SELECT 'C01_migrations_applied', (SELECT count(*) FROM migration_ledger.applied) = 46,
         'ledger=' || (SELECT count(*) FROM migration_ledger.applied)`;
const C01_NEW = `  SELECT 'C01_migrations_applied', (SELECT count(*) FROM migration_ledger.applied) = :expected_migrations,
         'ledger=' || (SELECT count(*) FROM migration_ledger.applied) || ' migration_files=' || :expected_migrations`;
const C16_OLD = `       + (SELECT count(*) FROM classification) + (SELECT count(*) FROM fiscal_document) + (SELECT count(*) FROM management_event) = 0,
         'historical/operational fact rows = 0'`;
const C16_NEW = `       + (SELECT count(*) FROM classification) + (SELECT count(*) FROM fiscal_document) + (SELECT count(*) FROM management_event)
       + ${ADR006_TABLES.map((t) => `(SELECT count(*) FROM ${t})`).join(' + ')} = 0,
         'historical/operational fact rows = 0; ADR-006 ' || ${ADR006_TABLES.map((t) => `'${t}=' || (SELECT count(*) FROM ${t})`).join(" || ' ' || ")}`;

/** [ADR-016] the reference rows seeded by 0070 are not migrated data: read the two masters without them. */
export const ADR016_PRODUCTS = '(SELECT * FROM products WHERE NOT is_system)';
export const ADR016_CATEGORIES = "(SELECT * FROM expense_category WHERE nombre <> 'Gastos de Feria')";
function excludeAdr016Seeds(body) {
  return body
    .replace(/FROM products( [a-z]\b)?/g, (_, alias) => `FROM ${ADR016_PRODUCTS}${alias ?? ' products'}`)
    .replace(/FROM expense_category( [a-z]\b)?/g, (_, alias) => `FROM ${ADR016_CATEGORIES}${alias ?? ' expense_category'}`);
}

export function deriveCurrentValidator(historical) {
  const text = historical.replace(/\r\n/g, '\n');
  const i = text.indexOf(HEADER_HISTORICAL_END);
  if (i < 0) throw new Error('historical header marker not found');
  let body = HEADER + text.slice(i + HEADER_HISTORICAL_END.length);
  for (const [a, b] of [[C01_OLD, C01_NEW], [C16_OLD, C16_NEW]]) {
    if (body.split(a).length !== 2) throw new Error(`expected exactly one occurrence of: ${a.split('\n')[0].trim()}`);
    body = body.replace(a, () => b);
  }
  return excludeAdr016Seeds(body);
}
