# ADR-012 — Classification entry units (UNIDAD / MAPLE) and session rectification

**STATUS:** **ACCEPTED** (owner decisions D-CLS-1…5, 2026-10-01, Phase 27 manual walkthrough block 4). Implemented by migration `0063_classification_units_rectification.sql`; recorded as part of the "Phase 27 acceptance fixes".
**DATE:** 2026-10-01
**RAISED BY:** the owner walkthrough. The form did not say what unit a number meant, and a wrong session could not be corrected.
**AFFECTS (FROZEN):**
- TARGET_ARCHITECTURE_V2_FROZEN Part 14 (amendment note);
- POSTGRES_SCHEMA_SPEC_V1: `classification` and `classification_line` columns;
- RPC_CONTRACTS_V1: RPC 25 `register_classification` (line format) and the new RPC 47 `rectify_classification`; the inventory goes 47 → 48 with ADR-013;
- DATABASE_INVARIANTS_V1: new invariant 30;
- the SECURITY DEFINER set (+1);
- `report_classification_day` (current versions only).

**NOT AFFECTED:**
- Classification still references no flock (Part 14);
- the grades (the seven frozen grades; none added);
- RLS: ADMIN reads all sessions, OPERATOR reads its own;
- there is no direct write path.

---

## 1. Decision

| Id | Decision |
|---|---|
| U-1 | Entry units are `UNIDAD` and `MAPLE` (enum `classification_entry_unit`). No CAJA/BOX. |
| U-2 | Canonical quantity = individual eggs (`classification_line.quantity`, unchanged meaning). |
| U-3 | Conversion is done **by the backend only**: UNIDAD = 1; MAPLE = **20** for grade `XL`, **30** for every other grade. The grade is identified by its frozen name (`classification_grade.nombre = 'XL'`, Part 14 grade list). The frontend never converts. |
| U-4 | The entry is stored as typed: `entered_quantity`, `entered_unit`. Pre-0063 lines were entered as eggs (the form had no unit), so they are back-filled as `UNIDAD`. |
| S-1 | Multiple sessions per day stay append-only at registration (Part 14). Each session is listed and inspectable on its own. |
| R-1 | RPC 47 `rectify_classification` replaces **one whole current session** with a new version (`version_seq + 1`, `supersedes_id`, mandatory `rectification_reason`). The prior version stays exactly as it was and only stops being current (`is_current = false`). |
| R-2 | Who may rectify: ADMIN any current session; OPERATOR only a current session it created (the sessions its RLS shows it). The period of the session's date must be open. The date and location are inherited. |
| R-3 | `report_classification_day` counts current versions only, so a rectified session is never double-counted. |

## 2. Schema (0063)

- `classification`:
  - `+ version_seq INTEGER NOT NULL DEFAULT 0`, `+ is_current BOOLEAN NOT NULL DEFAULT true`, `+ supersedes_id UUID UNIQUE REFERENCES classification(id)`, `+ rectification_reason TEXT`;
  - `chk_classification_version_chain`: a version has a predecessor iff `version_seq > 0`, iff it has a reason;
  - partial index on `classification_date` WHERE `is_current`.
- `classification_line`:
  - `+ entered_quantity INTEGER NOT NULL (>= 0)`, `+ entered_unit classification_entry_unit NOT NULL`;
  - `chk_classification_line_unidad`: a UNIDAD line stores `quantity = entered_quantity`.

## 3. RPCs

- **RPC 25 `register_classification`:**
  - `p_lines` = `[{classification_grade_id, quantity, unit}]`, where `quantity` is the number typed and `unit` is `UNIDAD | MAPLE` (absent = `UNIDAD`);
  - validates the unit (`INVALID_UNIT`) and the converted range (`INVALID_QUANTITY`);
  - returns the canonical `total_quantity`.
- **RPC 47 `rectify_classification(p_idempotency_key UUID, p_classification_id UUID, p_lines JSONB, p_reason TEXT)`:**
  - SECURITY DEFINER; EXECUTE for authenticated only;
  - errors: `REASON_REQUIRED`, `EMPTY_LINE_SET`, `DUPLICATE_CLASSIFICATION`, `CLASSIFICATION_NOT_FOUND`, `CLASSIFICATION_SUPERSEDED`, `PERIOD_CLOSED`, plus the line errors of RPC 25;
  - audit `RECTIFY` with before / after totals and the reason;
  - returns `{classification_id, superseded_id, version_seq, total_quantity}`.

## 4. Verification

- `scripts/target-db/classification_units.test.mjs` (29 checks):
  - conversion per grade, mixed units, entry preserved, and the UNIDAD backstop;
  - append-only sessions;
  - rectification: reason, chain, preserved original, the report counts only the effective version, re-rectification, idempotency, audit, OPERATOR scope, closed period;
  - perimeter, no direct writes, no flock column.
- `scripts/target-db/classification.test.mjs`: frozen-structure checks amended to the 0063 columns.
- `tests/unit/block4-classification-feed.test.ts` (payload as typed, no factor in the frontend, detail text) and `tests/integration/block4-classification-feed.test.ts`.
