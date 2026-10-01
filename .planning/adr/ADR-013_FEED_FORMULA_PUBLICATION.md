# ADR-013 — Feed formula publication (one effective version per feed type, atomic RPC)

**STATUS:** **ACCEPTED** (owner decisions D-FEED-1…6, 2026-10-01, Phase 27 manual walkthrough block 4). Implemented by migration `0064_feed_formula_publication.sql`; recorded as part of the "Phase 27 acceptance fixes".
**DATE:** 2026-10-01
**RAISED BY:** the owner walkthrough. The manufacturing formula selector was empty, and there was no way to create formulas.
**AFFECTS (FROZEN):**
- TARGET_ARCHITECTURE_V2_FROZEN Part 15 (amendment note);
- POSTGRES_SCHEMA_SPEC_V1: the `feed_formula_version` exclusion constraint;
- RLS_IMPLEMENTATION_SPEC_V1: the INSERT policies and grants of `feed_formula_version` / `feed_formula_line` are removed;
- RPC_CONTRACTS_V1: the new RPC 48 `publish_feed_formula_version`, and RPC 26 `register_feed_manufacturing` (empty versions refused);
- DATABASE_INVARIANTS_V1: new invariant 31;
- the SECURITY DEFINER set (+1).

**NOT AFFECTED:**
- used-version immutability (trigger `reject_line_on_used_formula_version` of 0029);
- manufacturing still references the exact version used;
- feed types and ingredients remain ADMIN direct-write masters (insert / update, deactivate instead of delete);
- `feed_formula_line_safe`;
- reporting.

---

## 1. Decision

| Id | Decision |
|---|---|
| F-1 | A formula is a **version of a feed type**. At most **one** version of a feed type is effective on any date: EXCLUDE `(feed_type_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)`. |
| F-2 | RPC 48 is the **only** write path for versions and their lines. Direct INSERT on `feed_formula_version` / `feed_formula_line` is revoked from `authenticated` (the two INSERT policies are dropped). |
| F-3 | Publishing a version with `effective_from = D` happens atomically: the version, all its lines and the closure of the prior open version (`effective_to = D − 1`), or nothing. The version number is `max + 1` per feed type. |
| F-4 | Fail closed: if a version of the feed type already starts on or after D, the publication is refused (`FORMULA_VERSION_DATE_CONFLICT`); no replacement rule exists. A prior version manufactured on or after D is never cut (`FORMULA_VERSION_USED_AFTER_DATE`). |
| F-5 | Manufacturing refuses a version with no lines (`FORMULA_VERSION_EMPTY`). The frontend selector offers only the versions effective on the chosen date. |
| F-6 | A published version is never edited in place. A recipe change is a new version. Historical manufacturing keeps pointing to its version. |

## 2. RPC 48 `publish_feed_formula_version`

**Signature:** `publish_feed_formula_version(p_feed_type_id UUID, p_effective_from DATE, p_lines JSONB, p_reason TEXT DEFAULT NULL) RETURNS JSONB`. ADMIN only; SECURITY DEFINER; EXECUTE for authenticated only.

**Line format:** `p_lines` = `[{ingredient_id, quantity_kg, unit_cost_snapshot?}]`. Composition is in kg, the formula-line unit (`quantity_kg NUMERIC(15,3) > 0`); the optional cost has 2 decimals.

**Errors:**
- `FORBIDDEN`, `INVALID_DATE`;
- `FEED_TYPE_NOT_FOUND_OR_INACTIVE`;
- `EMPTY_LINE_SET`, `INGREDIENT_NOT_FOUND` (missing or inactive), `DUPLICATE_INGREDIENT`;
- `INVALID_QUANTITY`, `INVALID_COST`;
- `FORMULA_VERSION_DATE_CONFLICT`, `FORMULA_VERSION_USED_AFTER_DATE`.

**Concurrency:** publications of the same feed type are serialized (`FOR UPDATE` on the feed type).

**Audit:** one `PUBLISH` row (version, line count, closed version).

**Returns:** `{formula_version_id, version, line_count, closed_version_id}`.

## 3. Frontend

- **Administración → Alimento:**
  - "Tipos de alimento" and "Ingredientes" (direct-write masters);
  - "Fórmulas / Recetas": per feed type, the effective version, the validity window, the composition (`feed_formula_line_safe`), the history, and "Nueva versión" (RPC 48 only).
- **Alimento → Fabricación:** shows `<tipo> · vN` only for the versions effective on the selected date. Otherwise: "No hay fórmula vigente para esta fecha. Cargala en Administración → Alimento."

## 4. Verification

- `scripts/target-db/feed_formula.test.mjs` (29 checks):
  - validation and atomicity, version numbering, closure at D − 1;
  - same / earlier start refused, used-after-date refused;
  - overlap impossible (even for the owner), effective-on-date uniqueness, empty version not manufacturable;
  - no direct write path, used-version immutability kept, perimeter.
- `scripts/target-db/feed.test.mjs` and `reporting.test.mjs`: formula fixtures are written by the owner (no application path), the ACL / policy checks are amended, and the RPC list is updated.
- `tests/unit/block4-classification-feed.test.ts` and `tests/integration/block4-classification-feed.test.ts`; `tests/integration/f27e-production.test.ts` publishes its fixture formula through RPC 48.
