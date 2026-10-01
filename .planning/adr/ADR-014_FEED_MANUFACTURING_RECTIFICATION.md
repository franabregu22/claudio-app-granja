# ADR-014 — Feed manufacturing history and rectification; classification grade "Rotos" inactive

**STATUS:** **ACCEPTED** (owner decisions D-FEED-7 / D-FEED-8 / D-FEED-9 / D-CLS-6, 2026-10-01, Phase 27 manual walkthrough block 4 follow-up). Implemented by migrations `0065_feed_manufacturing_rectification.sql`, `0066_classification_grade_operator_history_read.sql` and `0067_feed_formula_version_operator_history_read.sql`; recorded as part of the "Phase 27 acceptance fixes".
**DATE:** 2026-10-01
**RAISED BY:** the owner walkthrough. Three gaps:
- the manufacturing entries had no visible history;
- a manufacturing entered wrong (500 kg instead of 50) could not be corrected without a misleading negative adjustment;
- having two classification grades "Rotos" and "Descarte" was ambiguous next to the separate Production metric "Rotos".

**AFFECTS (FROZEN):**
- TARGET_ARCHITECTURE_V2_FROZEN Part 14 (grade list state) and Part 15 (manufacturing correction);
- POSTGRES_SCHEMA_SPEC_V1: `feed_manufacturing` version chain;
- RPC_CONTRACTS_V1: the new RPC 49; the inventory grows 48 → 49;
- RLS_IMPLEMENTATION_SPEC_V1: OPERATOR read policies on `classification_grade` and `feed_formula_version`;
- DATABASE_INVARIANTS_V1: new invariant 32;
- PHASE_25_REPORTING: V5 `report_feed_consumption_interval`;
- the SECURITY DEFINER set (+1).

**NOT AFFECTED:**
- the Production metric `daily_production.eggs_broken` ("Rotos" in Producción);
- historical classification lines;
- ADR-012 conversion (MAPLE = 30 for every non-XL grade, including historical Rotos lines);
- formula immutability;
- direct-write privileges.

---

## 1. Manufacturing history (D-FEED-7)

- **Source:** `feed_manufacturing` (ADMIN and OPERATOR read every row, as before) with its **stored** `formula_version_id` → `feed_formula_version` → `feed_type`.
- **Composition:** the composition shown is `feed_formula_line_safe` for that exact version id, never the current recipe. A used version's lines are immutable (trigger of 0029), so the historical composition cannot drift.
- **Author:** resolved within the caller's permissions:
  - ADMIN reads every profile;
  - OPERATOR reads only its own, so another user is shown as "Otro usuario" and the caller as "Vos";
  - no profile permission is broadened.
- **0067:** the OPERATOR policy on `feed_formula_version` showed only versions effective today, so an older record's exact version was invisible to OPERATOR. A version row holds no cost (cost is in `feed_formula_line`, still unreadable to OPERATOR), so OPERATOR may now read every version row.

## 2. Manufacturing rectification (D-FEED-8)

| Id | Decision |
|---|---|
| M-1 | `feed_manufacturing` gets `version_seq`, `is_current`, `supersedes_id` (UNIQUE FK) and `rectification_reason`, with `chk_feed_manufacturing_version_chain`. |
| M-2 | RPC 49 `rectify_feed_manufacturing(p_idempotency_key, p_manufacturing_id, p_quantity_kg, p_reason, p_batch_number?, p_formula_version_id?)` replaces the **whole current record** with a new version. The date is kept (period determinant). The quantity, batch and formula version may change; the version must be effective on that date and have composition. The reason is mandatory. The period must be open. |
| M-3 | Who may rectify: ADMIN any current record; OPERATOR a current record of a chain **it started** (the author of the chain's first version). The OPERATOR stays the owner of the chain after an ADMIN correction. |
| M-4 | The original is never changed or deleted; it only stops being current. History is inspectable through the chain. Audit `RECTIFY` stores who, when, before / after quantity and version, and the reason. |
| M-5 | **Inventory / reporting mechanism:** feed stock is never stored; stock is the physical count (`feed_inventory_count`). The only consumer of manufactured kg is `report_feed_consumption_interval`, which now counts **current versions only**. The correction is therefore the version filter; **no compensating movement is generated**. With 500 → 50 kg, the interval shows manufactured 50 kg and the internal consumption follows. The 500 kg record remains as the superseded version. |

## 3. Classification grade "Rotos" inactive (D-CLS-6)

- Merge forward into "Descarte":
  - 0065 sets `classification_grade.activo = false` for `Rotos`, the reference-data mechanism used by the seed (0008), so it is reproducible at cutover;
  - no row is deleted and no historical line is reassigned.
- **New entries:** RPCs 25 / 47 already refuse an inactive grade (`GRADE_NOT_FOUND`), and the entry form lists only active grades. The forward grade set is XL, N1, N2, N3, Sucios, Descarte.
- **History:**
  - historical Rotos lines keep their grade, their entry and their ADR-012 conversion, and `report_classification_day` still shows them as "Rotos";
  - **0066:** the OPERATOR grade policy showed only active grades, so an OPERATOR's historical Rotos line could not show its name. Grade names are non-sensitive reference data, so OPERATOR may now read every grade row.
- The Production metric "Rotos" (`daily_production.eggs_broken`) is a different concept and is unchanged.

## 4. Verification

- `scripts/target-db/feed_manufacturing.test.mjs` (24 checks):
  - history: exact version, unchanged composition after a newer version, OPERATOR reads every record and the historical version but no cost or other profile;
  - rectification: reason, quantity, OPERATOR scope (own / other operator), chain, preserved original, report not double-counted (manufactured 50, internal 10), audit, superseded, ADMIN, chain owner after ADMIN, idempotency, version not found / not effective, one current per chain;
  - closed period, no direct writes, perimeter.
- `scripts/target-db/classification_units.test.mjs` section E:
  - Rotos inactive and Descarte active, both kept;
  - a new session with Rotos is refused;
  - a historical Rotos line stays readable (ADMIN and OPERATOR), keeps its maple conversion and is reported as Rotos;
  - rectifiable onto active grades;
  - Production `eggs_broken` unchanged.
- `classification.test.mjs` / `reporting.test.mjs` / `feed.test.mjs`: amended to 6 active grades, "Descarte" in new fixtures, and the `feed_manufacturing` structure.
- `tests/unit/block4-classification-feed.test.ts` and `tests/integration/block4-classification-feed.test.ts`.
