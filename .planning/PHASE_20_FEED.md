# PHASE 20 — FEED

**STATUS:** COMPLETE, from mechanical evidence (§28–§30, §35). MASTER_ROADMAP.md is unchanged: Phase 20 stays **CURRENT** until the external review.
**DATE:** 2026-09-25
**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, container `supabase_db_Claudio_app_Granja`, PostgreSQL 17.6)
**AUTHORITIES:**

- MASTER_ROADMAP.md (sequence)
- TARGET_ARCHITECTURE_V2_FROZEN.md (Parts 15, 20, 24, 26)
- RPC_CONTRACTS_V1 §26–§29
- POSTGRES_SCHEMA_SPEC_V1 Domain I
- RLS_IMPLEMENTATION_SPEC_V1 §4, §5, §8, §10
- DATABASE_INVARIANTS_V1 §12, §17

All of them are FROZEN, as amended by ADR-001 and ADR-002. None was modified in this phase.

---

## 1. Exact exit criterion

> Formula versions immutable once used; manufacturing references the exact version; consumo interno derives from the stock equation; consumo teórico derives from the curve. No per-flock real consumption is stored.

## 2. Scope

**Built:**

- Tables: `feed_formula_version`, `feed_formula_line`, `feed_manufacturing`, `feed_movement`, `feed_inventory_count`, `flock_feed_assignment`.
- The safe view `feed_formula_line_safe`.
- RPCs 26–29.
- The trigger guard that makes a used formula version immutable.

**Reused:** `feed_type`, `feed_ingredient`, `genetics_consumption_curve`, `flocks`, `perfiles`, `pedidos`, `management_period`, `audit_events`, `population_events` (read-only, for population), `operator_assignments`, `current_app_role()`, `assert_period_open()`.

**Not built:**

- `daily_feed_consumption` or any per-flock consumption fact;
- any stored internal or theoretical consumption;
- a formula-management RPC (none is frozen);
- a count-correction RPC (none is frozen);
- Feria;
- UI;
- RPC 23/24.

## 3. Migrations

| Version | File | Content | sha256 |
|---|---|---|---|
| 0029 | `0029_feed_tables.sql` | the 6 tables, CHECK/UNIQUE/FKs, 3 indexes, the used-version trigger guard | `dbf7c09e…42f0` |
| 0030 | `0030_feed_rpcs.sql` | RPCs 26–29, owner postgres, EXECUTE perimeter | `34195efb…259d` |
| 0031 | `0031_feed_privileges_rls.sql` | explicit reset, grants, 12 policies, safe view | `1e359fbd…ee50` |

0001–0028 are unchanged: checksums were verified by the runner, and 0026–0028 were re-hashed identically. The legacy migrations are untouched. No migration is empty.

## 4. Reused masters and reference data

`feed_type`, `feed_ingredient` and `genetics_consumption_curve` have existed since 0004, with the 0007/0013 policies and grants. They were reused unchanged (A1).

No business data is seeded. Tests create `P20-TEST …` fixtures through the ADMIN master path (INSERT policies) and remove them at the end (Z1).

## 5. Tables

All six tables are exactly as in POSTGRES_SCHEMA_SPEC_V1 Domain I:

- columns (A2);
- precision: `DECIMAL(15,3)`, `NUMERIC(15,2)`, `VARCHAR(100)` (A3);
- UNIQUE/CHECK constraints (A4);
- FKs, all RESTRICT (A5);
- indexes `idx_feed_manufacturing_date`, `idx_feed_movement_type_date` and the unique partial `idx_flock_feed_current` (A6);
- RLS enabled on all six (A7).

**One structural addition:** `trg_feed_formula_line_used_version` with its function `reject_line_on_used_formula_version()` (§7).

## 6. RPCs 26–29

Each RPC transcribes RPC_CONTRACTS_V1 line by line, with the exact frozen signature (L3):

| RPC | Actor | Period determinant | Returns |
|---|---|---|---|
| 26 `register_feed_manufacturing` | OPERATOR/ADMIN | `manufacturing_date` | `{manufacturing_id, quantity_kg}` |
| 27 `register_feed_inventory_count` | OPERATOR/ADMIN | `count_date` | `{count_id}` |
| 28 `register_feed_movement` | ADMIN | `movement_date` | `{movement_id}` |
| 29 `assign_flock_feed` | ADMIN | none (master assignment) | `{assignment_id}` |

**Technical completions** (contract behaviour unchanged; each is tested):

- A NULL quantity raises `INVALID_QUANTITY` (D5, E3, F3).
- A concurrent retry that hits the UNIQUE backstop gets the contract code, `DUPLICATE_MANUFACTURING` or `DUPLICATE_COUNT` (N1, N2).
- **RPC 26 takes the per-version advisory lock** shared with the immutability guard (N5).
- **RPC 29 locks the flock row** with `FOR NO KEY UPDATE`, which does not block the FK KEY SHARE locks of production writers. Concurrent reassignments therefore apply one after the other, exactly as sequential calls (N3, N4).
- **Other NULL or missing inputs** are rejected by the frozen constraints:
  - a NULL key by NOT NULL (D6);
  - a NULL date by the Foundation guard, `BUSINESS_DATE_REQUIRED` (D5, E3, F3);
  - a missing feed type or Pedido by the FK (E4, F5).

## 7. Formula version semantics

**Shape:** `version > 0`, `UNIQUE(feed_type_id, version)`, and `effective_to >= effective_from` when present (B2–B4). Versions are history: v1 and v2 live side by side (B6).

**Immutable once used.** Every path an application role could use to change a used version is closed:

| Path | Closed by | Test |
|---|---|---|
| UPDATE / DELETE / TRUNCATE on versions or lines | no privilege for ADMIN or OPERATOR, used or unused (matrix §10 `S,I`; invariant 17) | V3 |
| repointing `feed_manufacturing.formula_version_id` | no UPDATE privilege | V4 |
| deleting a used version | FK RESTRICT from `feed_manufacturing`, even for the owner | V5 |
| **the ADMIN INSERT policy on `feed_formula_line`** | the trigger guard: adding a line to a version already referenced by manufacturing raises `FORMULA_VERSION_IN_USE`, for every role including the owner | V1, V2 |

The INSERT policy was the only remaining path: adding a line to a used version would rewrite the recipe a past batch was made with.

**Race safety.** RPC 26 and the guard serialise on a transaction-level advisory lock per version. A row lock cannot be used here, because `SELECT … FOR SHARE` requires UPDATE privilege, which no application role holds. When a first manufacturing and a concurrent line insert race, the insert waits and is then rejected (N5).

**Unused versions** are still built through the master INSERT path: composition is added before first use (V6).

**History is exact:** the 2026-02-01 manufacturing still points to v1, and v1's composition, including cost, is byte-identical (V7).

## 8. Formula composition

- Composition is `quantity_kg` per 100 kg batch, keyed by an ingredient FK (C1, C4).
- `quantity_kg > 0` (C2) and `UNIQUE(formula_version_id, ingredient_id)` (C3).
- `unit_cost_snapshot` is stored as given, NULL allowed (C1).
- OPERATOR cannot insert composition (C5).

## 9. Cost snapshot protection

The three layers of RLS §8 are applied exactly.

**Layer 1: the base table.**

- OPERATOR has no policy on `feed_formula_line` and reads **0 rows** for every version (J2).
- ADMIN reads the cost (J1).

**Layer 2: `feed_formula_line_safe`.**

- `security_invoker = false`, owner postgres (A8).
- The projection is exactly `formula_version_id, ingredient_id, ingredient_name, quantity_kg` (A8).
- OPERATOR reads the composition through it (J3).
- Selecting `unit_cost_snapshot` from it fails (J4).
- The view definition does not mention cost at all (J5).
- ADMIN can read it too (J6).

**Layer 3: no write privilege** on either table (V3).

**Other paths checked:**

- `anon` and `service_role` cannot read the view or the tables (J7).
- No cost reaches OPERATOR through the manufacturing audit rows it can read (J8).
- Manufacturing stores, returns and audits no cost (D12).

**Formula versions:** OPERATOR sees only the versions effective today (v1 Jan–Mar hidden, v2 visible); ADMIN sees all (J9).

## 10. Manufacturing: exact-version semantics

- **Exact version:** the `formula_version_id` supplied is persisted (D2). The row itself preserves it; nothing looks up a "current formula".
- **Actors:** ADMIN and OPERATOR can both manufacture, and no flock is involved: operator B, with no assignment, can too (D1, D3). An inactive or missing profile is rejected (D4).
- **Quantity:** must be > 0 (D5).
- **Formula version:** must exist (D5).
- **Effectivity (§7 of the prompt):**
  - v1 on 2026-02-01 is accepted (D1);
  - v1 on 2026-04-01 raises `FORMULA_VERSION_NOT_EFFECTIVE`;
  - v2 on 2026-03-31 raises `FORMULA_VERSION_NOT_EFFECTIVE` (D5);
  - v2 on 2026-04-01 is accepted (D3);
  - the range is inclusive: v1 on its `effective_to` date is accepted (D8).
- **Audit and economics:** audit CREATE (D9); no economic effect (D13).

## 11. Inventory counts

- ADMIN and OPERATOR can both count (E1, E2).
- Zero stock is valid (E2). A negative or NULL quantity raises `INVALID_QUANTITY` (E3).
- There is exactly one count per `(feed_type, count_date)`: `DUPLICATE_COUNT` (E3). Another type on the same date, or the same type on another date, is fine (E6).
- Audit CREATE (E7).
- **A count is an observation:** it alters no manufacturing, movement or other fact (E8). It is not a balance: nothing reconciles automatically.

## 12. Feed movements

- **ADMIN only:** OPERATOR gets `FORBIDDEN` (F1).
- **All four enum types** are stored as a positive quantity with their type (F2).
- **Required fields:**
  - `EXTERNAL_SALE` requires a Pedido: `PEDIDO_REQUIRED`, and a nonexistent Pedido fails the FK (F3, F5);
  - the other types require a non-blank reason: `REASON_REQUIRED` (F3).
- **Rejected values:** a quantity that is 0, negative or NULL (F3); a type outside the enum (F4). All rejections are atomic (F6).
- **Append-only:** no UPDATE or DELETE privilege (K5).
- **Audit and economics:** audit CREATE (F7). The economic sale is the Pedido: the movement leaves the Pedido, its lines and every ledger untouched (F9).

**Sign semantics (determined by the FROZEN set, not guessed).** The frozen schema stores a positive `quantity_kg` and the enum. The signed column does not exist (F8), so the equation takes the sign from the type:

| movement_type | Sign in the stock equation | Basis |
|---|---|---|
| `EXTERNAL_SALE` | − | the "− external_output" term |
| `ADJUSTMENT_POSITIVE` | + | the "± adjustments" term; the sign is named in the enum |
| `ADJUSTMENT_NEGATIVE` | − | the "± adjustments" term; the sign is named in the enum |
| `LOSS` | − | RPC 28 lists losses among the movements "feeding the stock equation", and that equation has no positive term except adjustments. A loss is an outflow, so it subtracts, whether classed as output or as a negative adjustment. |

## 13. Flock feed assignment

- **Actor:** ADMIN only; OPERATOR gets `FORBIDDEN` (G1).
- **Validation:** `FLOCK_NOT_FOUND` (missing or NULL flock) and `FEED_TYPE_NOT_FOUND_OR_INACTIVE` (missing or inactive type), all atomic (G2, G3).
- **History:**
  - Feed A from 2026-01-01 to 2026-02-14, then Feed B from 2026-02-15 onwards: the previous row is closed at `effective_from − 1` and the old row is kept (G4).
  - Exactly one current assignment (G5).
  - Audit ASSIGN (G6).
- **Rejections:** a replacement whose `effective_from` is not after the current one cannot close it validly and is rejected by `chk_flock_feed_range`, with history intact (G7). The physical backstop `idx_flock_feed_current` holds even for the owner (G8).
- **No shortcut column:** `flocks` has no current-feed column (G9).
- **No period guard:** a CLOSED month and a missing month are both accepted (T3, T6).

The assignment is an input to consumo teórico only. It is not evidence of feed consumed.

## 14. Internal consumption derivation

**Owner rule: count day.** A `feed_inventory_count` dated D is the **stock at the close of day D**. Every manufacturing and movement dated D happened before that count. The count of D closes the consumption period up to and including D, and a period between counts opens at the earlier count and closes at the later one. No time or operational timestamp was added to the schema; this is a convention over the existing dates.

The canonical equation from the frozen schema and Part 15, applied per feed type between two physical counts:

```sql
opening count (count_date = d0)
+ Σ feed_manufacturing.quantity_kg           -- via formula_version.feed_type_id, d0 < date <= d1
− Σ feed_movement EXTERNAL_SALE, LOSS, ADJUSTMENT_NEGATIVE   (d0 < date <= d1)
+ Σ feed_movement ADJUSTMENT_POSITIVE                        (d0 < date <= d1)
− closing count (count_date = d1)
```

A flow dated on the opening count day d0 belongs to the earlier period, the one closed by d0.

**Case W** (count day):

- Opening count on 2026-04-01 = 1000.
- On 2026-04-30: manufacturing +500, EXTERNAL_SALE 100, closing count 900.
- Result: 1000 + 500 − 100 − 900 = **500**. The 04-30 flows belong to the period closing on 04-30 (W1).
- A LOSS dated 04-01, the opening count day, is excluded from the period that count opens (W2).
- The 04-30 flows are not counted again in the next period, 04-30 → 05-31 (W3).
- The same manufacturing dated D+1 would leave April at 0 (rolled-back probe, W4).

**Case H**, June, one feed type:

1000 + 500 − 100 (external sale) + 40 − 15 − 5 (loss) − 900 = **520** (H1).

**Checks:**

- Manufacturing before the opening count, and June facts of other feed types, are excluded (H2).
- With a closing count of 800 instead of 900, the result is 620. This was shown in a probe transaction that was rolled back; no correction path was invented (H3, H6).
- Deriving writes nothing (H4).

## 15. Theoretical consumption derivation

Per flock, per day D:

- **population(D):** `initial_population` plus every current `population_events` row with `event_date <= D` (Phase 18 facts, I1).
- **age_weeks_exact** = `(D − birth_date) / 7.0`, a decimal: 2.29 means two weeks completed, in the third.
- **curve_age_weeks** = `floor(age_weeks_exact)`, used to select the INTEGER curve row. Never round, never ceil.
- **curve:** `expected_g_per_bird_day` from `genetics_consumption_curve(genetics_line, curve_age_weeks)`.
- **feed type:** the assignment in force on D (I3, I4).

The result in kg is Σ population(D) × g / 1000, per feed type. It is **theoretical**: not measured consumption, and never a per-flock real consumption fact.

**Owner rule: same-day population.** A mortality or COUNT_ADJUSTMENT dated D affects the population **of the same day D**, for laying, theoretical consumption and every other metric of D. Its effect is not deferred to D+1.

- Population before D = 2700; mortality of 5 on D → population(D) = 2695 (W5).
- A COUNT_ADJUSTMENT of +3 dated D also counts on D (W6).
- The theoretical consumption of D multiplies by 2695, not 2700; D−1 multiplies by 2700 (W7).

**Owner rule: age.** Birth date 2026-09-25 (W8):

| Date | Exact weeks | Curve week |
|---|---|---|
| 2026-09-25 | 0.0000 | 0 |
| 2026-10-01 | 0.8571 | 0 |
| 2026-10-02 | 1.0000 | 1 |
| 2026-10-08 | 1.8571 | 1 |
| 2026-10-09 | 2.0000 | 2 |
| 2026-10-11 | 2.2857 | 2 |
| 2026-10-16 | 3.0000 | 3 |

The derivation itself uses the floor row: on 2026-10-11, 100 birds × 82 g (week 2) = 8.200 kg, not week 3 (W9).

**Checks:**

- **February, flock Y:** attributed to Feed A for days 01–14 and Feed B for days 15–28. The result equals an independent JS computation (I3).
- **Boundary days:** 02-14 goes only to A and 02-15 only to B (I4).
- **No assignment:** a day without an assignment yields nothing (I5).
- **Nothing written:** deriving writes nothing; the curve is reference data (I6).

## 16. No stored consumption

- The only relation named `*consum*` / `*consumo*` in public is the reference `genetics_consumption_curve` (H5, E2E7).
- No column anywhere in public is a consumption fact (P2).
- Both derivations are read-only queries (H4, I6, E2E7).

## 17. No per-flock real consumption

Structural checks:

- no `daily_feed_consumption` or per-flock consumption table (P1);
- no table combines `flock_id` with a feed quantity (P3);
- `flock_feed_assignment` has no quantity or kg column (P4);
- the inputs to real consumption (counts, manufacturing, movements) carry no flock or shed column (P5);
- `flocks` has no feed column (G9).

Real consumption is an aggregate by feed type. Theoretical consumption is a per-flock control metric.

## 18. Periods

| RPC | Determinant | CLOSED | Missing |
|---|---|---|---|
| 26 | `manufacturing_date` | `PERIOD_CLOSED`, ADMIN and OPERATOR (T1) | `PERIOD_NOT_FOUND` (T4) |
| 27 | `count_date` | `PERIOD_CLOSED`, ADMIN and OPERATOR (T1) | `PERIOD_NOT_FOUND` (T4) |
| 28 | `movement_date` | `PERIOD_CLOSED` (T1) | `PERIOD_NOT_FOUND` (T4) |
| 29 | none | accepted (T3) | accepted (T6) |

- Rejections write nothing (T2, T5).
- **`created_at` never decides:** with the current month CLOSED, facts dated in OPEN May are accepted (T7).

## 19. Idempotency

| Fact | Mechanism | Sequential | Concurrent |
|---|---|---|---|
| Manufacturing | `idempotency_key VARCHAR(100) UNIQUE` | `DUPLICATE_MANUFACTURING`, nothing written (D10) | exactly one survives (N1) |
| Count | `UNIQUE(feed_type_id, count_date)` | `DUPLICATE_COUNT` (E3) | exactly one survives (N2) |

`batch_number` is not an idempotency key: two manufacturings with the same batch number both persist (D11).

## 20. Atomicity

Test-only triggers (schema `p20_harness`) inject real failures (M):

| RPC | Failure injected | Result |
|---|---|---|
| 26 | at the manufacturing insert | nothing written (M1) |
| 26 | at the audit, after the insert | full rollback (M2) |
| 27 | at the audit, after the count | full rollback (M3) |
| 28 | at the audit, after the movement | full rollback (M4) |
| 29 | after closing the previous assignment | previous stays current and unchanged, no new row (M5) |
| 29 | between closing and inserting | previous stays current and unchanged, no new row (M5) |
| 29 | at the audit | previous stays current and unchanged, no new row (M5) |

The harness is removed afterwards (M6).

## 21. Concurrency

Real independent PostgreSQL sessions were used:

| Test | Race | Outcome |
|---|---|---|
| N1 | same manufacturing key | B waited, then `DUPLICATE_MANUFACTURING`; one row, A's |
| N2 | same feed type and date | B waited, then `DUPLICATE_COUNT`; one count, A's |
| N3 | two reassignments of one flock | B waited on the flock lock, then applied after A as a sequential call; history A→B kept, one current |
| N4 | same `effective_from` | B waited, then was rejected by `chk_flock_feed_range`; A current, no silent overwrite |
| N5 | first manufacturing vs line insert | the insert waited, then `FORMULA_VERSION_IN_USE` |

The contract does not define loser behaviour for RPC 29. The observed semantics are exactly those of two sequential calls. There is no last-write-wins that breaks history: a later `effective_from` succeeds and keeps the history, and an equal one is rejected.

## 22. RLS

Exactly as in RLS §8 (K8, twelve policies):

| Table | ADMIN | OPERATOR |
|---|---|---|
| `feed_manufacturing` | S all | S all (K1) |
| `feed_inventory_count` | S all | S all (K2) |
| `feed_movement` | S all | — (K3) |
| `flock_feed_assignment` | S all | S of assigned flocks (K4) |
| `feed_formula_version` | S, I | S effective today (J9) |
| `feed_formula_line` | S, I | — (J2); safe view instead |

## 23. Privileges

**ACLs (K6):**

| Object | authenticated |
|---|---|
| four fact tables | SELECT |
| `feed_formula_version`, `feed_formula_line` | SELECT, INSERT |
| `feed_formula_line_safe` | SELECT |

- Sequences grant nothing to application roles (K7).
- No direct DML on the fact tables for ADMIN or OPERATOR (K5).
- `anon` and `service_role` have no SELECT and no EXECUTE (K9).

**Formula tables:** RLS §4's blanket list grants `INSERT, UPDATE` on them. The per-table matrix §10 (`S,I`), the §8 policies (no UPDATE policy) and invariant 17 ("no UPDATE privilege") all specify no UPDATE. 0031 follows the specific texts. The effect is identical either way: with no UPDATE policy, no application UPDATE can reach a row. See §34.

## 24. SECURITY DEFINER

- **Inventory:** 31 functions, the previous 27 plus RPCs 26–29 (L1).
- **Hardening:** DEFINER, `search_path = public`, owner postgres, no PUBLIC, EXECUTE for authenticated only (L2).
- **Signatures:** exact, with no actor parameter (L3).
- **Trigger function:** `reject_line_on_used_formula_version()` is **not** SECURITY DEFINER and is not executable by application roles (L4).

## 25. Audit

| Entity | Action | after_values |
|---|---|---|
| `feed_manufacturing` | CREATE | formula_version_id, manufacturing_date, quantity_kg (D9) |
| `feed_inventory_count` | CREATE | feed_type_id, count_date, quantity_kg (E7) |
| `feed_movement` | CREATE | feed_type_id, movement_type, quantity_kg, movement_date (F7) |
| `flock_feed_assignment` | ASSIGN | flock_id, feed_type_id, effective_from (G6) |

Every event records the reason and the real actor. Failed calls leave no audit (M).

## 26. No economic effect

Across every call of the suite, nothing changed in financial operations, postings, client or supplier ledgers, purchases, orders, collections, production, population or flocks (O1; also D13, F9).

## 27. E2E

**Setup:** feed type "E2E Ponedoras" with v1 (Jan–Mar) and v2 (Apr onwards). Flock X is assigned to it from 2026-01-01; it has 990 birds (1000 − 10 mortality from Phase 18) and genetics W36.

1. **Exact versions:** March manufacturing (800 kg) references v1; April manufacturing (1500 kg) references v2 (E2E1).
2. **Internal, April:** 2000 (opening count, 03-31) + 1500 − 200 (external sale linked to a Pedido) − 50 (loss) − 1800 (closing count, 04-30) = **1450**. March manufacturing is excluded (E2E2).
3. **Theoretical, April, flock X:** 990 × curve(weeks 25–29) = **3175.920 kg**, attributed to the assigned feed type. It equals an independent computation (E2E3).
4. **Separate figures:** both are derived query results and are not assumed equal (E2E4). The internal figure has no flock allocation; the theoretical one is per flock (E2E5).
5. **Operator A's view:** the assignment, the manufacturing and the counts, but not the movements or the costs (E2E6).
6. **Nothing stored:** no consumption stored and no consumption table (E2E7).

## 28. Automated tests

`scripts/target-db/feed.test.mjs` has **176 assertions**:

| Group | Assertions |
|---|---|
| A structure | 8 |
| B versions | 6 |
| C composition | 5 |
| D manufacturing | 20 |
| E counts | 11 |
| F movements | 16 |
| G assignment | 12 |
| T periods | 13 |
| V immutability | 8 |
| H internal | 6 |
| I theoretical | 6 |
| J cost | 9 |
| K RLS/privileges | 9 |
| L definer | 4 |
| M atomicity | 8 |
| N concurrency | 5 |
| W temporal semantics (count day, same-day population, age) | 15 |
| P no per-flock consumption | 5 |
| E2E | 7 |
| O economic | 1 |
| Z cleanup | 2 |

**How the suite runs:**

- It passes on re-run: two consecutive runs gave 161/0 before the temporal closure, and 176/0 twice after it.
- The derivation helpers encode the owner's temporal rules (§14, §15). Under the new count-day window `(d0, d1]`, the earlier H and E2E results are unchanged, because they have no flow on a count date.
- Every fixture is named `P20-TEST …` and removed at the end.
- Operator B (`77777777…`) is a Phase 20 fixture and is deleted, so the foundations profile count stays exact.

## 29. Regression

| Suite | Result |
|---|---|
| `apply.test.mjs` | 27 / 0 |
| `foundations.test.mjs` | 96 / 0 |
| `commercial.test.mjs` | 147 / 0 |
| `treasury.test.mjs` | 107 / 0 |
| `instruments.test.mjs` | 200 / 0 |
| `purchases.test.mjs` | 216 / 0 |
| `production.test.mjs` | 149 / 0 |
| `classification.test.mjs` | 75 / 0 |
| `feed.test.mjs` | 176 / 0 (161 at the rebuild; +15 temporal assertions W, re-run on the same ledger 0001..0031) |
| `guard.test.mjs` | 35 / 0 |

Only exact structural inventories changed; no behavioural assertion changed:

- **foundations:** later-phase tables (+6) and definers (+4).
- **treasury:** later-phase tables (+6) and the definer inventory.
- **commercial, instruments, purchases, production, classification:** the definer inventory (31). The classification K1 label no longer states a total count.

Two name-based structural scans in earlier suites matched objects the FROZEN schema requires. Each now excludes exactly that one object and still catches every other match:

- **treasury A9** (no parallel money ledger): its `movement` pattern matched `feed_movement`, which holds physical feed outflows and adjustments (Domain I), not money. A9 now excludes `feed_movement` by exact name.
- **purchases V4** (landed cost not stored): its `unit_cost` pattern matched `feed_formula_line.unit_cost_snapshot`, the frozen per-version ingredient cost snapshot (invariant 17), not landed cost. V4 now excludes that exact (table, column) pair.

The first rebuild run recorded these two failures (treasury 106/1, purchases 215/1). The table above is the second run, after the exclusions.

## 30. Clean rebuild

```
before              → public tables=41, ledger=31
guard               → target proven local; cli argv proven local-only → supabase db reset
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0, views=0
rebuild             → 31 files, 0 already applied → +0001 … +0031 → ledger holds 31; public tables = 41
re-run apply.mjs    → applied 0 new migration(s); ledger now holds 31 (0001..0031)
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107, instruments 200/200,
                      purchases 216/216, production 149/149, classification 75/75, feed 161/161, guard 35/35
checksums           → 0026–0028 unchanged (2775eed7…15a7, 44105d1b…ba98, 395a6e85…b538); legacy untouched
```

No manual step or Studio action was needed. At the end, Supabase local was stopped.

## 31. Production isolation

- **Production:** not contacted.
- **Remote project-ref:** not used.
- **Commands never run:** `db push`, `--linked`, `link` and `unlink`.
- **Targets:** every SQL operation was direct-URL against the guarded loopback target, and the reset passed the CLI argv guard.
- **Credentials:** production credentials were unset. No secret was printed.
- **Data:** no production data was used.

## 32. RPC 23/24 deferred

RPC 23 `register_flock_weighing` and RPC 24 `register_temperature_record` are still **UNASSIGNED**. They were not implemented, not assigned to Feed, and Phase 18 was not edited.

## 33. Other deferred

- **Formula-management RPC:** none is frozen; fixtures use the master INSERT path.
- **Count correction or supersede:** no frozen RPC exists; nothing was invented.
- **Reporting views or functions for the two consumption derivations:** in this phase they live only as read-only queries in the suite and here, and nothing stored depends on them. When they are built, they must apply the owner's temporal rules of §14 and §15 exactly.
- **Frontend requirement (not implemented now):** the feed inventory count screen must show this exact disclaimer:

  > "El stock informado se toma como cierre del día. Los movimientos registrados con esta misma fecha se consideran anteriores a este conteo."
- **Other phases and carry-forwards:** Feria (21) and the later phases, the transversal financial idempotency key, `source_collection_id`, frontend, and real-data migration.

## 34. Frozen contradictions

None that changes the domain.

1. **RLS §4 vs §8/§10/invariant 17 on formula-table UPDATE.** §4's blanket grant includes UPDATE on `feed_formula_version` and `feed_formula_line`. The specific texts (matrix `S,I`, no UPDATE policy, invariant 17) give no UPDATE. 0031 follows the specific texts, so there is no behavioural difference. Recommended: align §4's list in a future documentation pass (not done here; FROZEN untouched).
2. **Used-version immutability vs the ADMIN INSERT policy on lines.** The frozen policy allows ADMIN to INSERT lines without restriction, while schema Domain I and Part 15 make a used version immutable. The trigger guard enforces the frozen invariant without changing any policy text (§7).
3. **Derivation conventions the FROZEN set did not state: RESOLVED by owner decision** (temporal-semantics closure, 2026-09-25):
   - **Count day:** a count dated D is the stock at the close of D, and flows dated D precede it (§14).
   - **Same-day population:** events dated D count in D's population (§15).
   - **Age:** `age_weeks_exact = (D − birth_date) / 7.0`, and the curve row is `floor(age_weeks_exact)` (§15).

   None of these contradicts the FROZEN set. Part 15 and Domain I define the equation and the inputs but not intra-day order or the age rounding, and the curve's `age_weeks INTEGER CHECK >= 0` domain is consistent with floor. No schema, migration or FROZEN document changed.

## 35. Exit criterion evidence

| Requirement | Status | Evidence |
|---|---|---|
| Formulas versioned | **MET** | B1–B6 |
| Manufacturing keeps the exact version | **MET** | D2, D3, V4, V7, E2E1 |
| Historical composition immutable | **MET** | V1–V7, N5 |
| OPERATOR cannot see the cost snapshot | **MET** | J2–J8 |
| Manufacturing works | **MET** | D |
| Inventory observations work | **MET** | E |
| Feed movements work | **MET** | F |
| Assignment history works | **MET** | G, N3, N4 |
| Internal consumption comes from the stock equation | **MET** | H1–H4, E2E2 |
| Theoretical consumption comes from curve + population + assignment | **MET** | I1–I6, E2E3 |
| Owner temporal rules (count day, same-day population, floor age) | **MET** | W1–W9 |
| No stored consumption | **MET** | H5, P2, E2E7 |
| No per-flock real consumption | **MET** | P1–P5 |
| Periods | **MET** | T |
| Idempotency and concurrency | **MET** | D10, E3, N |
| RLS | **MET** | J, K |
| Atomicity | **MET** | M |
| Regression, clean rebuild, production untouched | **MET** | §29–§31 |

## 36. Phase status

**PHASE 20 — FEED: COMPLETE** (evidence in §28–§30 and §35).

MASTER_ROADMAP.md was deliberately left unchanged, with Phase 20 = **CURRENT** until the external review. Phase 21 was not started.
