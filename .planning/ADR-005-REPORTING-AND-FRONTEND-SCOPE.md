# ADR-005 — Reporting Contract and Frontend Scope

**STATUS:** **ACCEPTED** by the owner on 2026-09-25 ("PHASE 25 — OWNER DECISIONS RATIFIED").

**Context:** the Phase 25 pre-construction review (`PHASE_25_REPORTING.md` §14) stopped on three open points, OD-1 to OD-3. This ADR records the owner's decisions and the roadmap amendment they require.

**Scope:** this ADR amends no FROZEN document text. Where it interprets a FROZEN sentence, the interpretation is recorded here and prevails for implementation.

---

## 1. Decision D1 — laying % (OD-1)

```
laying_pct(flock, D) = eggs_total(flock, D) / population(flock, D) × 100
```

- **Numerator:** `eggs_total` of the current `daily_production` row of that flock and day.
- **Broken and dirty eggs:** `eggs_broken` and `eggs_dirty` are **subsets / descriptors** of `eggs_total`. They are never added on top of it.
- **Denominator:** `population(D)` follows the frozen same-day rule (Phase 20 §15). It is `initial_population + Σ current population_events.delta` with `event_date <= D`, so a mortality or adjustment dated D already counts on D.
- **When laying_pct is NULL:**
  - **no production row** exists for that flock and day;
  - **`population(D) <= 0`**.
- **No division by zero.**
- **Never stored:** `laying_pct` exists only in the reporting view.
- **Quality warning:** a derived, **non-authoritative** `quality_data_warning` flag is true when `eggs_broken > eggs_total` or `eggs_dirty > eggs_total`.
  - It is a reporting signal only.
  - The production write contracts (RPCs 18 and 19) are **not** changed for it.

## 2. Decision D2 — OPERATOR productive metrics (OD-2)

**What OPERATOR may see.** OPERATOR may see derived productive metrics **only for flocks currently assigned to it**:
- eggs_total, broken and dirty;
- mortality and population;
- age;
- `laying_pct` and the curve's expected laying %;
- theoretical feed consumption.

**RLS stays the authority.** The existing base-table policies decide which rows OPERATOR sees:
- `flocks_operator_assigned`;
- `daily_production_operator_select`;
- `population_events_operator_select`;
- `flock_feed_assignment_operator_select`.

The reporting views are `security_invoker = true`, and they add no access of their own.

**What OPERATOR never gets:**
- a global or farm-wide laying aggregate;
- any unassigned flock;
- any monetary or cost data.

**Interpretation of RPC_CONTRACTS_V1 §19.** The sentence "population (`population_events`) … and aggregated-laying data remain unreachable" means that OPERATOR cannot see **global or non-assigned** aggregated laying or population data. It does **not** prohibit derived productive metrics for OPERATOR's own assigned flocks.

This is consistent with FROZEN Part 2, which forbids only "unauthorized population/productivity data", and with RLS spec §8 / §10. It also matches the Phase 18 reading of that sentence. The FROZEN file is not rewritten.

## 3. Decision D3 — Phase 25 scope (OD-3)

**Phase 25 = the database reporting contract only.**
- It adds read-only reporting views with their grants.
- It adds no table, materialized view, RPC or SECURITY DEFINER function.
- It adds **no React / frontend implementation**, and `src/` is not touched.

## 4. Decision D4 — roadmap amendment: Frontend V1 Integration

**The gap.**
- UAT requires the owner to operate the target system, but no phase in the roadmap owns a frontend on the target schema.
- The existing React app reads only legacy tables.

**The amendment.** A dedicated phase is inserted **after Migration Rehearsal and before Integral QA / UAT**:

| # | Phase | Exit criterion |
|---|---|---|
| **27** | **Frontend V1 Integration** | Frontend operates against the target schema for the V1 business flows and reporting surfaces, respects ADMIN/OPERATOR permissions, and contains no duplicated business/accounting authority. |

The transition phases are renumbered explicitly:

| Phase | Before | After |
|---|---|---|
| Migration Rehearsal | 26 | 26 (unchanged) |
| Frontend V1 Integration | — | **27 (new)** |
| Integral QA | 27 | **28** |
| UAT | 28 | **29** |
| Cutover Rehearsal | 29 | **30** |
| Cutover | 30 | **31** |
| Hypercare | 31 | **32** |
| V1 Project Close | 32 | **33** |

**Consequences in MASTER_ROADMAP.md:**
- The phase count goes from 33 phases (0–32) to **34 phases (0–33)**.
- The pre-cutover checklist gate becomes the **Phase 31** gate (Cutover).
- No exit criterion of an existing phase changes, and no status changes. Phase 25 stays **CURRENT**.

**Sequence references checked before the change:**

| Reference | Effect of the renumber |
|---|---|
| MASTER_ROADMAP.md (rows 26–32, "PHASE 30 GATE", "33 PHASES (0–32)") | updated by this amendment |
| MIGRATION_STRATEGY_V1.md "Phase 26" (twice) | still correct: Migration Rehearsal keeps number 26 |
| Other `.planning` documents, AGENTS.md, CLAUDE.md, migrations, test suites | contain no reference to phases 27–32 |
| PHASE_25_REPORTING.md §14 ("UAT (28)") | a pre-construction record, left as written. UAT is now Phase 29. |

## 5. Consequences

- **Migration 0046** creates the seven views of `PHASE_25_REPORTING.md` §7:
  - `report_flock_day` carries D1 and D2;
  - the ADMIN-only views carry the explicit ADMIN predicate.
- RPCs 23 and 24 remain **UNASSIGNED**.
- The frontend work (screens, including the dashboard surfaces over these views) belongs to **Phase 27 — Frontend V1 Integration**.
