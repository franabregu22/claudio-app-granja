/**
 * ADR-006 Step 13 — the ONLY differences between the historical Phase 26 validator
 * (scripts/phase26/validate-clean-cutover.sql, read-only) and the current-target validator
 * (scripts/regression/validate-current-target.sql). ADR006_TEST_MATRIX_V1 CT-3:
 *   - C01: "ledger = 46" becomes "ledger = migration files present" (psql variable, derived at run time);
 *   - C16: extended with the six ADR-006 tables (0 rows: the clean cutover loads no MP history).
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

export function deriveCurrentValidator(historical) {
  const text = historical.replace(/\r\n/g, '\n');
  const i = text.indexOf(HEADER_HISTORICAL_END);
  if (i < 0) throw new Error('historical header marker not found');
  let body = HEADER + text.slice(i + HEADER_HISTORICAL_END.length);
  for (const [a, b] of [[C01_OLD, C01_NEW], [C16_OLD, C16_NEW]]) {
    if (body.split(a).length !== 2) throw new Error(`expected exactly one occurrence of: ${a.split('\n')[0].trim()}`);
    body = body.replace(a, () => b);
  }
  return body;
}
