# ADR-007 — V1 flock lifecycle (register / close) and no dated flock activity after exit

**STATUS:** **ACCEPTED** (owner approval, 2026-09-29: D-F27B-1, D-F27B-3, D-F27B-4, D-F27B-5, D-F27B-6). It is implemented by the FROZEN amendments listed in §8 (each marked **[ADR-007]**) and by migration `0057_flock_lifecycle_rpcs.sql`.
**HISTORY:** raised by the owner review of F27-B (commit `50c83b3`) → design pass 2026-09-29 → ACCEPTED 2026-09-29.
**DATE:** 2026-09-29
**RAISED BY:** Phase 27 slice F27-B (masters / admin). The frozen backend gives the frontend no way to register or close a flock, and the owner requires both in V1 (D-F27B-1).
**AFFECTS (FROZEN):** RPC_CONTRACTS_V1, RLS_IMPLEMENTATION_SPEC_V1, DATABASE_INVARIANTS_V1, IMPLEMENTATION_DEPENDENCY_ORDER_V1. The ADR-006 SECURITY DEFINER perimeter literal (60 → 62) and every test that encodes it.
**NOT AFFECTED:** POSTGRES_SCHEMA_SPEC_V1 (no table, column, enum, index or constraint changes), TARGET_ARCHITECTURE_V2_FROZEN (Part 10 already lists entry and exit / retirement dates).

---

## 1. Context — the gap

**What the frozen design already says:**

| Source | Text |
|---|---|
| `TARGET_ARCHITECTURE_V2_FROZEN.md` Part 10 | One shed has at most one active flock. A flock preserves genetics, birth date, entry date, initial population, origin / supplier, historical data and its exit / retirement date. |
| `POSTGRES_SCHEMA_SPEC_V1.md` Domain G `flocks` | `shed_id`, `entry_date`, `initial_population` (≥ 0) required; `estado` (`ACTIVE` / `RETIRED` / `ARCHIVED`, default `ACTIVE`); optional `genetics_line`, `birth_date`, `supplier_id`, `purchase_id`, `exit_date`; `created_by`. Period determinant: `entry_date` (inventory row 31). |
| `DATABASE_INVARIANTS_V1.md` invariant 1 | At most one ACTIVE flock per shed (`idx_flocks_shed_active`). |
| `RLS_IMPLEMENTATION_SPEC_V1.md` §flocks | "`flocks` has no write privilege in section 4: creating or retiring a flock is an ADMIN action through a privileged path, which keeps the one-ACTIVE-flock-per-shed index safe from races." Matrix row: `flocks … ADMIN (privileged)`. |

**What is missing:** no RPC implements that privileged path. `PHASE_18_PRODUCTION.md` records it ("a flock create/close RPC — none exists in the frozen inventory; flocks come through the privileged owner path"). Test flocks and migrated flocks are written by the table owner. The legacy application allowed creating a lot and marking its exit; the target frontend cannot.

**Second gap found during the design pass:** only `register_daily_production` requires an ACTIVE flock. Mortality, count adjustments and the rectifications accept any date, so activity could be recorded after a flock's exit. `report_flock_day` iterates `entry_date … COALESCE(exit_date, CURRENT_DATE)`, so such activity would silently fall outside the report.

## 2. Decisions (ACCEPTED)

| Id | Decision |
|---|---|
| D-F27B-1 | The flock lifecycle is V1 scope: register a flock in a shed with its initial fields, and mark its exit. No broad frontend table authority on `flocks`, no legacy implementation, no bypass of invariants / RLS. |
| D-F27B-2 | (recorded for completeness; not part of this amendment) `expense_category.pnl_cost_class` is chosen at creation and not edited afterwards. |
| D-F27B-3 | Add RPC 44 `register_flock` and RPC 45 `close_flock`. The SECURITY DEFINER perimeter changes explicitly from 60 to 62. Existing RPCs are not renumbered. **Numbering note (implementation):** the design pass proposed numbers 43 / 44, but RPC 44 is already `register_management_event` (ADR-004 D9, migration 0044; it was never added to the `RPC_CONTRACTS_V1.md` inventory). To keep "no existing RPC renumbered", the two RPCs take the next free numbers **44 / 45**; names and behaviour are exactly as approved. The inventory now lists RPC 43 as a pointer to ADR-004. |
| D-F27B-4 | `register_flock` rejects `entry_date > business_today` with `INVALID_DATE`, using the backend's canonical business date `(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`. `entry_date ≤ business_today` is valid, subject to `assert_period_open(entry_date)`. |
| D-F27B-5 | `close_flock`, in the same transaction, sets `estado = 'RETIRED'`, `exit_date = p_exit_date` and deactivates (`activo = false`) every active `operator_assignments` row of the flock. The rows are kept as history. The audit records which assignments were deactivated. |
| D-F27B-6 | New invariant 29: when a flock has an exit date, no dated flock activity may be created or rectified with an effective date after it. The rule is about the effective event date, not the flock's current state: historical corrections dated on or before the exit remain valid on a RETIRED flock. Existing ACTIVE requirements are kept. |

## 3. RPC 44 — `register_flock`

**Signature:** `register_flock(p_shed_id UUID, p_entry_date DATE, p_initial_population BIGINT, p_genetics_line VARCHAR DEFAULT NULL, p_birth_date DATE DEFAULT NULL, p_supplier_id UUID DEFAULT NULL, p_purchase_id UUID DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `flocks.entry_date`

Order: authorize → validate → period → lock shed → shed checks → references → insert → audit.

1. `current_app_role() = 'ADMIN'`, else `FORBIDDEN` (`current_app_role()` itself raises `NOT_AUTHENTICATED` / `USER_NOT_FOUND_OR_INACTIVE`).
2. `p_initial_population` not NULL and ≥ 0 (frozen CHECK), else `INVALID_QUANTITY`.
3. `p_entry_date` not NULL and ≤ business today; `p_birth_date`, when given, ≤ `p_entry_date`; else `INVALID_DATE`.
4. `assert_period_open(p_entry_date)` (`PERIOD_CLOSED` / `PERIOD_NOT_FOUND`).
5. Shed row `FOR UPDATE`: `SHED_NOT_FOUND`, `SHED_INACTIVE`. An ACTIVE flock already in the shed → `SHED_OCCUPIED`. The shed lock serialises concurrent registrations; the partial unique index is the backstop and its `unique_violation` is reported as `SHED_OCCUPIED`.
6. `p_supplier_id` / `p_purchase_id`, when given, must exist: `SUPPLIER_NOT_FOUND`, `PURCHASE_NOT_FOUND`.
7. Insert with `estado = 'ACTIVE'`, `exit_date = NULL`, `created_by = auth.uid()` (server-set); the genetics line is trimmed, empty → NULL.
8. `audit_events`: `entity_type 'flocks'`, action `CREATE`, the shed, entry date, initial population and state.

**Returns:** `{flock_id, shed_id, entry_date, initial_population, estado}`.
**Errors:** `NOT_AUTHENTICATED`, `USER_NOT_FOUND_OR_INACTIVE`, `FORBIDDEN`, `INVALID_QUANTITY`, `INVALID_DATE`, `PERIOD_CLOSED`, `PERIOD_NOT_FOUND`, `SHED_NOT_FOUND`, `SHED_INACTIVE`, `SHED_OCCUPIED`, `SUPPLIER_NOT_FOUND`, `PURCHASE_NOT_FOUND`.

## 4. RPC 45 — `close_flock`

**Signature:** `close_flock(p_flock_id UUID, p_exit_date DATE, p_reason TEXT DEFAULT NULL) RETURNS JSONB`
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `flocks.exit_date`

1. ADMIN, else `FORBIDDEN`. `p_exit_date` not NULL, else `INVALID_DATE`.
2. Flock row `FOR UPDATE`: `FLOCK_NOT_FOUND`; not ACTIVE → `FLOCK_NOT_ACTIVE` (a second close is rejected and audits nothing).
3. `p_exit_date ≥ entry_date` and `≤` business today, else `INVALID_DATE`.
4. Invariant 29: no current `daily_production.production_date`, no current `population_events.event_date` and no `flock_feed_assignment.effective_from` after `p_exit_date`, else `EXIT_BEFORE_RECORDED_ACTIVITY`.
5. `assert_period_open(p_exit_date)`.
6. `estado = 'RETIRED'`, `exit_date = p_exit_date`. The shed is free for a new flock (the unique index covers ACTIVE only).
7. D-F27B-5: `operator_assignments.activo = false` for every active assignment of the flock (no row deleted).
8. `audit_events`: `entity_type 'flocks'`, action `CLOSE`, `before_values {estado, exit_date}`, `after_values {estado, exit_date, deactivated_assignment_ids}`, `reason = p_reason` (the schema has no exit-reason column; the reason lives in the audit).

**Returns:** `{flock_id, shed_id, exit_date, estado, deactivated_assignments}`.
**Errors:** `NOT_AUTHENTICATED`, `USER_NOT_FOUND_OR_INACTIVE`, `FORBIDDEN`, `INVALID_DATE`, `FLOCK_NOT_FOUND`, `FLOCK_NOT_ACTIVE`, `EXIT_BEFORE_RECORDED_ACTIVITY`, `PERIOD_CLOSED`, `PERIOD_NOT_FOUND`.

Closing writes no population event: the population at exit stays derived (`initial_population + Σ current population_events`), and there is no exit event type in the frozen enum. The final disposition of the birds is outside this amendment.

## 5. Invariant 29 — no dated flock activity after the exit (D-F27B-6)

**Rule:** if `flocks.exit_date IS NOT NULL`, the effective date of any dated flock activity created or rectified must be `≤ exit_date`, else `ACTIVITY_AFTER_FLOCK_EXIT`.

**Mechanism:** one INVOKER, owner-only helper `assert_flock_activity_date(p_flock_id, p_activity_date)` (not executable by `anon`, `authenticated` or `service_role`, so the SECURITY DEFINER count is unaffected). It reads the flock `FOR KEY SHARE`, which conflicts only with `close_flock`'s `FOR UPDATE`: a dated write concurrent with a close waits for it and then sees the committed exit date, while production writers still never block on `assign_flock_feed`'s `FOR NO KEY UPDATE`.

**RPC audit (every function whose body references a flock and writes):**

| RPC | Dated activity | Effective date checked | Changed |
|---|---|---|---|
| 18 `register_daily_production` | yes | `p_production_date` | **yes** (+1 line). Its `FLOCK_NOT_ACTIVE` check is kept. |
| 19 `rectify_daily_production` | yes | the original `production_date` (a rectification keeps the date) | **yes** (+1 line) |
| 20 `register_mortality` | yes | `p_event_date` | **yes** (+1 line) |
| 21 `rectify_mortality` | yes | the original `event_date` | **yes** (+1 line) |
| 22 `register_count_adjustment` | yes | `p_event_date` | **yes** (+1 line) |
| 29 `assign_flock_feed` | yes (a feed assignment effective from a date) | `p_effective_from` | **yes** (+1 line) |
| 13 `register_purchase` / 14 `rectify_purchase` | no: `purchases.flock_id` attributes a financial fact (for example a pullet purchase or a later invoice) to a flock; it is not a productive event of the flock, and settling a flock's costs after its exit is legitimate | — | no |
| 23 `register_flock_weighing` / 24 `register_temperature_record` | would be dated activity | — | not built (Phase 18 note); when built they must call the same helper |
| classification, feed manufacturing / movements / counts, feria, fiscal, MP | no flock reference | — | no |

Each changed function receives exactly one line, `PERFORM assert_flock_activity_date(<flock>, <effective date>);`, before its period guard (after the flock lock in `assign_flock_feed`). Nothing else in their bodies, signatures, owners or grants changes.

## 6. Security

- No table grant changes: `flocks` keeps SELECT only for `authenticated`; no INSERT / UPDATE / DELETE for any API role.
- RPC 44 / 45: owner `postgres`, `SECURITY DEFINER`, `SET search_path = public`, EXECUTE revoked from `PUBLIC`, `anon`, `service_role`, granted to `authenticated`; ADMIN is enforced in the body.
- SECURITY DEFINER set in `public`: **62** (the 60 of ADR-006 + `register_flock`, `close_flock`).
- RLS unchanged: ADMIN reads every flock; OPERATOR reads its assigned, active flocks. After a close the flock's assignments are inactive, so it leaves the OPERATOR working set.

## 7. Migration

`0057_flock_lifecycle_rpcs.sql` (append-only; 0001–0056 unchanged and verified by the ledger checksum). It creates the helper and RPCs 44 / 45, and re-defines the six functions of §5 with their single added line.

## 8. Frozen amendments

| Document | Amendment **[ADR-007]** |
|---|---|
| `RPC_CONTRACTS_V1.md` | AMENDMENTS header; RPC COUNT 42 → 45 (RPC 44 = ADR-004 pointer row); RPC 44 `register_flock` and RPC 45 `close_flock` appended; invariant-29 note on RPCs 18–22 and 29; inventory rows 43 and 44 |
| `RLS_IMPLEMENTATION_SPEC_V1.md` | AMENDMENTS header; §flocks: the privileged path is RPC 44 / 45; matrix row `flocks`; executable set |
| `DATABASE_INVARIANTS_V1.md` | AMENDMENTS header; COUNT 28 → 29; invariant 1 enforcement names RPC 44; invariant 29 added; compliance matrix and verification query |
| `IMPLEMENTATION_DEPENDENCY_ORDER_V1.md` | AMENDMENTS header; Production RPC group includes 43 / 44; totals |
| `PHASE_18_PRODUCTION.md` | historical pointer to this ADR (the phase record itself is not rewritten) |
| perimeter tests | the exact SECURITY DEFINER literal and count (ADR-006 X-1, P-7, P-8, S-7a/b, V-5) and every suite's executable-RPC literal include RPC 44 / 45 |

## 9. Verification

`scripts/target-db/flock_lifecycle.test.mjs`: perimeter (count 62, grants, no direct write), every RPC 44 / 45 error, the shed race, the close / dated-write race, assignment deactivation without deletion, audit once, the shed freed after a close, and invariant 29 on each of the six changed RPCs (post-exit rejected; on / before exit allowed on a RETIRED flock; the ACTIVE requirement of RPC 18 kept).
