# PHASE 18 — PRODUCTION (SLICE 3)

**STATUS:** COMPLETE, from mechanical evidence (§32, §33). MASTER_ROADMAP.md is unchanged: Phase 18 stays **CURRENT** until the external review.
**DATE:** 2026-09-25
**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, container `supabase_db_Claudio_app_Granja`, PostgreSQL 17.6)
**AUTHORITIES:**

- MASTER_ROADMAP.md (sequence)
- TARGET_ARCHITECTURE_V2_FROZEN.md (Parts 11, 12, 26)
- RPC_CONTRACTS_V1 §18–§22
- POSTGRES_SCHEMA_SPEC_V1 Domain G
- DATABASE_INVARIANTS_V1 §1, §2, §12, §16
- RLS_IMPLEMENTATION_SPEC_V1 §4, §8, §10

The five implementation-design documents are FROZEN, as amended by ADR-001 and ADR-002. None was modified in this phase.

---

## 1. Exact exit criterion

> **Slice 3** runs end to end. Population derives from initial population plus current events. One current mortality per flock per date, with rectification. OPERATOR limited to assigned flocks and to correcting its own production.

The roadmap's Slice 3 definition assigns exactly RPCs 18–22 over `sheds`, `flocks`, `operator_assignments`, `daily_production` and `population_events`. RPCs 23 and 24 (weighing, temperature) are not in the Phase 18 exit scope, so there is no contradiction and they were not built.

## 2. Scope

**Slice 3:** `SHED → FLOCK → DAILY PRODUCTION → MORTALITY / COUNT ADJUSTMENT → DERIVED POPULATION`.

**Built:**

- Tables: `daily_production`, `population_events`.
- RPCs 18–22.

**Reused:** `sheds`, `flocks`, `operator_assignments`, `perfiles`, `management_period`, `audit_events`, `current_app_role()`, `assert_period_open()`.

**Not built:**

- `flock_weighing` / `temperature_record` (RPCs 23 and 24);
- classification, feed, feria;
- any stored metric or stored population;
- a flock create/close RPC (none exists in the frozen inventory; flocks come through the privileged owner path);
- any UI.

## 3. Migrations

| Version | File | Content | sha256 |
|---|---|---|---|
| 0023 | `0023_production_tables.sql` | `population_events`, `daily_production`, CHECKs, self-FKs, 2 partial unique + 2 lookup indexes | `329fc8e1…b9bf` |
| 0024 | `0024_production_rpcs.sql` | RPCs 18–22, owner postgres, EXECUTE perimeter | `65e3d74e…d4d6` |
| 0025 | `0025_production_privileges_rls.sql` | explicit reset, SELECT grant, 4 policies | `d0b2fbbd…f906` |

0001–0022 are unchanged: checksums were verified by the runner, and 0019–0022 were re-hashed identically. The legacy `supabase/migrations/` directory is untouched.

## 4. Reused flocks / operator_assignments

`flocks` and `operator_assignments` from 0005 are reused with their exact columns (A9, A10) and their 0007 policies (T10). The following still hold:

- one ACTIVE flock per shed (S1);
- `initial_population`, `entry_date`, `birth_date`, `exit_date`, supplier and purchase links.

Nothing was added to `flocks`.

The frozen design gives flock creation no application RPC ("created through a privileged path"), so test flocks are created by the table owner.

Assignments are managed through the existing ADMIN path, `operator_assignments` INSERT/UPDATE under RLS.

## 5. New tables

Both tables are exactly as in POSTGRES_SCHEMA_SPEC_V1 Domain G (A1–A7).

**`population_events`:**

- `delta <> 0`;
- `event_type` MORTALITY or COUNT_ADJUSTMENT;
- 1:1 self-FK `superseded_by`;
- `idx_population_events_mortality_current` UNIQUE on `(flock_id, event_date)` WHERE MORTALITY and current.

**`daily_production`:**

- eggs total, broken and dirty ≥ 0;
- self-FK `superseded_by`;
- `idx_daily_production_current` UNIQUE on `(flock_id, production_date)` WHERE current;
- no `classification_session_id`.

**Absent (A8, A11):** stored current population, birds alive, mortality totals, conflict tables, flags or types.

## 6. RPCs 18–22

Each RPC is a line-by-line transcription of RPC_CONTRACTS_V1 §18–§22, with the same authorization, checks, order, error codes, writes and return shapes.

**Technical completions** (business semantics unchanged; each is tested):

- **NULL quantities** raise the contract's `INVALID_QUANTITY`: eggs total, broken and dirty; deaths; adjustment delta (E, I, L, O, Q).
- **`register_daily_production` also rejects negative or NULL broken/dirty** with `INVALID_QUANTITY`, the same code RPC 19 uses. The schema CHECKs reject negatives either way; only the error code is aligned (E3 shows the physical backstop).
- **Concurrent duplicates** that pass the EXISTS pre-check and hit the partial unique index are reported as `DUPLICATE_PRODUCTION` / `MORTALITY_ALREADY_RECORDED`. The mortality message still reports the existing value, re-read after the winner commits (V1, V2).

## 7. Production semantics

`register_daily_production` handles ADMIN, or an OPERATOR on an assigned, active flock (C1, C2).

- It requires the flock to be ACTIVE (`FLOCK_NOT_ACTIVE` for a RETIRED or missing flock, D1, D2).
- It stores the exact values as the current version 0 with `created_by` = the real actor (B2).
- It audits `CREATE` (B3).
- It has no ledger, operation or posting (B4).
- A second current production for the same flock/date raises `DUPLICATE_PRODUCTION` (E1), backed by the index (E4). The uniqueness is per flock/date, not global (E5).

## 8. Production rectification

Mandatory order: lock → authorize → validate → original period → **retire** → insert → `superseded_by` → audit.

- **Old row (G2):** retired, with its business values untouched and pointing to the new row.
- **New row (G3):** same flock and **original** date, the new values, version +1, authored by the real actor.
- **Audit `RECTIFY` (G4):** before-values (including the original author), after-values (including `new_id` and `actor_role`) and the reason. There is no economic effect (G5).
- **Rejections (I):** superseded, missing, reason, and negative/NULL values, all before any mutation. A CLOSED original period is refused for ADMIN too (I2).

## 9. OPERATOR own-record authorization

Authorization lives inside `rectify_daily_production`, and no table privilege or policy was widened:

| Case | Result | Test |
|---|---|---|
| Operator A rectifies its own row on an assigned flock | allowed; the new version is authored by A, and audit records `OPERATOR` | H1, H2 |
| Operator B, assigned to the same flock, rectifies A's row | `NOT_OWN_RECORD` | H3 |
| A rectifies an ADMIN-authored row | `NOT_OWN_RECORD` | H4 |
| A, with its assignment inactive, rectifies its own row | `FLOCK_NOT_ASSIGNED` | H5 |
| A, with its assignment inactive, registers production | `FLOCK_NOT_ASSIGNED` | H6 |
| ADMIN rectifies any current row, regardless of author | allowed | H7, G1 |
| A, after being assigned to Y, rectifies B's production on Y | `NOT_OWN_RECORD` | AUTH4 |

## 10. Mortality semantics

`register_mortality` (ADMIN, or an assigned OPERATOR, L4):

- requires deaths > 0; 0, negative and NULL raise `INVALID_QUANTITY`;
- stores MORTALITY with a **negative** delta (L2);
- audits `MORTALITY` (L3);
- has no economic effect (L5).

## 11. Mortality uniqueness

- **One current MORTALITY per flock/date:** a duplicate raises `MORTALITY_ALREADY_RECORDED`, and the message reports the existing value ("10 deaths already recorded"). No second row survives (M1, M2).
- **Physical backstop:** the partial unique index, even for the owner (M3).
- **COUNT_ADJUSTMENT is not covered:** adjustments on the same flock/date are allowed (M4).
- There is no conflict record.

## 12. Mortality rectification

`rectify_mortality` is **ADMIN only**; OPERATOR gets `FORBIDDEN` with no effect (P1).

- **Order:** validate → lock → original period → retire → insert → `superseded_by` → audit.
- **Old row:** its flock, date and delta (−10) are **never modified**; only `is_current` and `superseded_by` change (O2).
- **New row:** same flock and date, `delta −8`, version 1 (O3).
- **Audit:** `RECTIFY_MORTALITY` (O4).
- **Errors:** superseded, count-adjustment target (`NOT_A_MORTALITY_EVENT`), missing, deaths, reason and CLOSED original period are all refused without effect (O5, O6).

## 13. Count adjustments

`register_count_adjustment` (ADMIN, or an assigned OPERATOR):

- stores the delta exactly as supplied, positive or negative (Q1);
- a delta of 0 or NULL raises `INVALID_QUANTITY`;
- the reason is mandatory;
- multiple adjustments per flock/date are allowed (Q2);
- it is audited with delta and reason (Q3);
- it never overwrites mortality.

## 14. Derived population

`current_population = flocks.initial_population + SUM(population_events.delta WHERE is_current)`. It is never stored.

| Step | Population | Test |
|---|---|---|
| Initial | 1000 | R1 |
| Mortality 10 | 990 | R2 |
| Adjustment −5 | 985 | R3 |
| Adjustment +2, same day | 987 | R4 |
| Rectify mortality 10 → 8 | **989** | R5 |
| Further rectifications 8 → 7 → 6 | 991 | R6 |

- Historical rows stay queryable: 4 mortality rows, 1 current (R7).
- Summing *all* rows would wrongly give 966, which proves superseded rows are excluded (R8).

## 15. N-pass behaviour

**Production** (J1–J4), four sequential rectifications:

- exactly one current row, the latest;
- `version_seq` runs 0..4;
- the supersession chain is exact (`v(i).superseded_by = v(i+1)`);
- history is kept.

**Mortality:** three sequential rectifications leave only the final current row contributing to the population (R6, R7).

Production and mortality keys are UUID / BIGSERIAL identities, so there is no version-key growth problem of the kind ADR-002 fixed for purchases.

## 16. Period determinants

| RPC | Determinant | Evidence |
|---|---|---|
| 18 register_daily_production | `production_date` | F1–F4 (CLOSED, OPERATOR also blocked, NOT_FOUND, `created_at` irrelevant) |
| 19 rectify_daily_production | **original** `production_date` | I2 |
| 20 register_mortality | `event_date` | Q5 |
| 21 rectify_mortality | **original** `event_date` | O6 |
| 22 register_count_adjustment | `event_date` | Q4 |

- OPERATOR has no way to reopen a period. RPC 38 is not built and belongs to its own phase.
- `created_at` never decides (F4).

## 17. Atomicity

**K:** test-only triggers inject real failures into both rectifications at every intermediate point:

1. after the old row is retired, the new version's insert fails;
2. after the new version is inserted, the `superseded_by` update fails;
3. after `superseded_by` is set, the audit fails.

This is done for production and for mortality (6 cases). Every case restores the original state completely: the old row is current, there is no pointer, no new row and no audit. The harness is then removed (K1).

## 18. Concurrency

Real independent PostgreSQL sessions were used. In each case B was observed waiting on a lock, and the final state stayed valid:

| Test | Race | Outcome |
|---|---|---|
| V1 | duplicate production (operator A, same flock/date) | `DUPLICATE_PRODUCTION`; exactly one current row |
| V2 | duplicate mortality | `MORTALITY_ALREADY_RECORDED`, reporting A's value (4); exactly one current row |
| V3 | two rectifications of the same production | `ALREADY_SUPERSEDED`; one current, version 1 |
| V4 | two rectifications of the same mortality | `ALREADY_SUPERSEDED`; one current MORTALITY (−3) |

## 19. RLS

Exactly as frozen in RLS §8: ADMIN SELECT on all rows, and OPERATOR SELECT limited to flocks with an active assignment, on both tables. There are no write policies (T9).

| Reader | Result | Test |
|---|---|---|
| ADMIN | reads all flocks | T1 |
| Operator A | reads assigned flock X fully | T2 |
| Operator A | reads nothing of unassigned Y | T3, AUTH3 |
| Operator B | reads Y, and nothing of X once its X assignment is inactive | T4 |
| Operator A | reads Y after being assigned (reads follow the active assignment) | AUTH5 |

The `flocks` and `operator_assignments` policies are unchanged (T10).

**Documentation note (not blocking):** RPC_CONTRACTS_V1 §19 says, in prose, that "population (`population_events`) … remain unreachable" to OPERATOR through that RPC. RLS_IMPLEMENTATION_SPEC_V1 §8 and the §10 coverage matrix (`population_events | S | S assigned`) explicitly grant OPERATOR SELECT on assigned flocks, and RPCs 20 and 22 let OPERATOR write mortality and adjustments. The RLS spec is the authority for read access and is implemented as written. The §19 sentence is read as "RPC 19 grants no new access, and mortality *correction* stays ADMIN-only", which holds (P1).

## 20. Privileges

- **Exact ACLs (T8):** `authenticated` has SELECT only on both tables; the `population_events` sequence is owner-only.
- **No direct DML:** INSERT, UPDATE, DELETE and TRUNCATE are refused for OPERATOR *and* ADMIN; writes go through RPCs only (T5).
- **anon and service_role:** no SELECT and no EXECUTE (T6, T7).
- **Default privileges:** clean since 0013. 0025 still resets explicitly.

## 21. SECURITY DEFINER

- **Inventory:** 26 functions, i.e. the previous 21 plus RPCs 18–22 (U1).
- **Hardening of each RPC:** SECURITY DEFINER, `search_path = public`, owner postgres, no PUBLIC entry; EXECUTE for authenticated only, not anon or service_role (U2).
- **Actor, role and operator:** no parameter names any of them (U3).
- **RPC 21** rejects OPERATOR internally with `FORBIDDEN` (P1). OPERATOR can execute RPCs 18/19/20/22 only because the functions authorize internally.

## 22. Audit

| RPC | Audit action | Evidence |
|---|---|---|
| register_daily_production | `CREATE` (daily_production) | B3 |
| rectify_daily_production | `RECTIFY`, with before, after, `actor_role` and original author | G4, H2 |
| register_mortality | `MORTALITY` | L3 |
| rectify_mortality | `RECTIFY_MORTALITY` | O4 |
| register_count_adjustment | `COUNT_ADJUSTMENT` | Q3 |

All go into the transversal `audit_events`; there is no parallel audit table. Failed calls leave no audit row (snapshots and K).

## 23. No economic effects

No Phase 18 RPC writes a financial operation, a posting, a client ledger entry or a supplier ledger entry (B4, G5, L5, E7).

## 24. Phase 17 integration

The Phase 17 cycle-2 FKs `fk_flocks_purchase` / `fk_purchases_flock` still exist and are validated (W1). A purchase is not mandatory: every Phase 18 flock has `purchase_id` NULL (W2). The FKs were not recreated.

## 25. E2E

**Slice 3:** flock with initial population 2700, operator A assigned.

| Step | Population | Test |
|---|---|---|
| Day 1: operator records production 2400/20/30 and mortality 5 | 2695 | E1 |
| Day 2: production 2420 and adjustment −3 | 2692 | E2 |
| ADMIN rectifies day-1 mortality 5 → 4 | 2693 | E3 |
| Operator A (still assigned) rectifies its day-1 production 2400 → 2410 | 2693 | E4 |

- The old production and old mortality remain historical (E5).
- The current state is MORTALITY −4 and COUNT_ADJUSTMENT −3, population 2693 (E6).
- No ledger, posting or financial operation was created (E7).

**Authorization end to end:** A → X and B → Y.

- A registers production, mortality and an adjustment on X, and rectifies its own production (AUTH1).
- A cannot write Y (AUTH2) or read Y (AUTH3).
- After being assigned to Y, A still cannot rectify B's production (AUTH4).
- ADMIN rectifies A's and B's production and rectifies mortality (AUTH6).

## 26. Automated tests

`scripts/target-db/production.test.mjs` has **149 assertions**:

| Group | Assertions |
|---|---|
| A structure | 11 |
| B admin production | 4 |
| C operator production | 3 |
| D flock state | 2 |
| E validation | 11 |
| F period | 4 |
| G admin rectify | 5 |
| H operator own-record | 7 |
| I rectify errors | 10 |
| J N-pass | 4 |
| K atomicity | 7 |
| L mortality | 10 |
| M uniqueness | 4 |
| O rectify mortality | 12 |
| P operator vs RPC 21 | 1 |
| Q adjustments | 11 |
| R population | 8 |
| S one ACTIVE flock | 1 |
| T RLS/privileges | 10 |
| U definer | 3 |
| V concurrency | 4 |
| W Phase 17 integration | 2 |
| E2E | 7 |
| AUTH | 6 |
| Z cleanup | 2 |

**How the suite runs:**

- It passes on re-run.
- Fixtures (`P18-TEST` sheds and flocks, assignments, and the operator B profile) are removed at start and end, so other suites keep their exact counts. Periods closed by the suite are reopened.

## 27. Regression

| Suite | Result |
|---|---|
| `apply.test.mjs` | 27 / 0 |
| `foundations.test.mjs` | 96 / 0 |
| `commercial.test.mjs` | 147 / 0 |
| `treasury.test.mjs` | 107 / 0 |
| `instruments.test.mjs` | 200 / 0 |
| `purchases.test.mjs` | 216 / 0 |
| `production.test.mjs` | 149 / 0 |
| `guard.test.mjs` | 35 / 0 |

Only exact structural inventories changed; no behavioural assertion changed:

- **foundations:** the later-phase tables (+2) and definers (+5).
- **commercial I1, treasury H1, instruments Q1, purchases Z1:** the definer inventory (26).
- **treasury A2:** later-phase tables (+2).

## 28. Clean rebuild

```
before              → public tables=33, ledger=25
guard               → target proven local; cli argv proven local-only → supabase db reset
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0
rebuild             → 25 files, 0 already applied → +0001 … +0025 → ledger holds 25; public tables = 33
re-run apply.mjs    → applied 0 new migration(s); ledger now holds 25
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107,
                      instruments 200/200, purchases 216/216, production 149/149, guard 35/35
```

No manual step or Studio action was needed. At the end, Supabase local was stopped.

## 29. Production isolation

- **Production:** not contacted.
- **Remote project-ref:** not used.
- **Commands never run:** `db push`, `--linked`, `link` and `unlink`.
- **Targets:** every SQL operation was direct-URL against the guarded loopback target, and the reset passed the CLI argv guard.
- **Credentials:** production credentials were unset. No secret was printed.
- **Data:** no production data was used.

## 30. Deferred

- **RPC 23 `register_flock_weighing` / `flock_weighing`, RPC 24 `register_temperature_record` / `temperature_record`:** frozen, but outside the roadmap's Slice 3 exit scope. They are not built and need to be scheduled.
- **Flock create/close RPCs:** none exist in the frozen inventory; the privileged owner path stands. *(Later amended: ADR-007, 2026-09-29, adds RPC 44 `register_flock` / RPC 45 `close_flock` and invariant 29; this phase record is not rewritten.)*
- **RPC 38 `reopen_management_period`:** its own phase.
- **Other phases and carry-forwards:** Classification (19), Feed (20), the transversal financial idempotency key, `source_collection_id`, frontend, and real-data migration.

## 31. Frozen contradictions

None blocking.

- RPCs 23 and 24 are not assigned to Phase 18 by the roadmap's Slice 3 definition (RPCs 18–22), so there is no contradiction.
- The RPC_CONTRACTS_V1 §19 prose about `population_events` being "unreachable" is a wording ambiguity. RLS §8 and §10 explicitly grant OPERATOR assigned-flock SELECT, and they were implemented as written (§19 above).

## 32. Exit criterion evidence

| Part of the criterion | Status | Evidence |
|---|---|---|
| Slice 3 runs end to end | **MET** | E1–E7, AUTH1–AUTH6 |
| Population derives from initial population plus current events | **MET** | R1–R8, E1–E6; no stored population (A8) |
| One current mortality per flock per date | **MET** | M1–M4, V2 |
| …with rectification | **MET** | O1–O6, R5–R7, K (mortality), V4 |
| OPERATOR limited to assigned flocks | **MET** | C2, H5, H6, L, Q, T2–T4, AUTH2, AUTH3 |
| …and to correcting its own production | **MET** | H1–H5, AUTH4; RPC 21 refused (P1) |
| Periods, RLS, privileges, definer | **MET** | F, I2, O6, Q4, Q5, T, U |
| Atomicity, concurrency | **MET** | K, V |
| Regression, clean rebuild, production untouched | **MET** | §27–§29 |

## 33. Phase status

**PHASE 18 — PRODUCTION: COMPLETE** (evidence in §26–§28 and §32).

MASTER_ROADMAP.md was deliberately left unchanged: Phase 18 = **CURRENT** until the external review, and the stale "Construction so far" note was not touched. Phase 19 was not started.
