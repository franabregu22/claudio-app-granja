# PHASE 19 — CLASSIFICATION

**STATUS:** COMPLETE, from mechanical evidence (§30, §31). MASTER_ROADMAP.md is unchanged: Phase 19 stays **CURRENT** until the external review.
**DATE:** 2026-09-25
**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, container `supabase_db_Claudio_app_Granja`, PostgreSQL 17.6)
**AUTHORITIES:**

- MASTER_ROADMAP.md (sequence)
- TARGET_ARCHITECTURE_V2_FROZEN.md (Parts 14, 20, 26)
- RPC_CONTRACTS_V1 §25
- POSTGRES_SCHEMA_SPEC_V1 Domain H
- RLS_IMPLEMENTATION_SPEC_V1 §4, §8, §10
- DATABASE_INVARIANTS_V1 §12

All of them are FROZEN, as amended by ADR-001 and ADR-002. None was modified in this phase.

---

## 1. Exact exit criterion

> Sessions with graded lines, multiple sessions per day, no flock reference and no invented traceability.

## 2. Scope

**Flow:** `CLASSIFICATION SESSION → CLASSIFICATION LINES → CLASSIFICATION GRADE`.

**Built:**

- Tables: `classification`, `classification_line`.
- RPC 25 `register_classification`.

**Reused:** `classification_grade`, `perfiles`, `management_period`, `audit_events`, `current_app_role()`, `assert_period_open()`.

**Not built:**

- any flock, shed or production reference;
- any traceability or allocation;
- a correction or delete RPC (none is frozen);
- sales or stock consequences;
- Feed;
- UI.

## 3. Migrations

| Version | File | Content | sha256 |
|---|---|---|---|
| 0026 | `0026_classification_tables.sql` | `classification`, `classification_line`, UNIQUE/CHECK/FKs, `idx_classification_date` | `2775eed7…15a7` |
| 0027 | `0027_classification_rpc.sql` | RPC 25, owner postgres, EXECUTE perimeter | `44105d1b…ba98` |
| 0028 | `0028_classification_privileges_rls.sql` | explicit reset, SELECT grant, 4 policies | `395a6e85…b538` |

0001–0025 are unchanged: checksums were verified by the runner, and 0023–0025 were re-hashed identically. The legacy migrations are untouched.

## 4. Reused classification_grade

`classification_grade` has existed since 0004, seeded in 0008 with XL, N1, N2, N3, Rotos, Sucios and Descarte. It is reused, and the seed catalog stays intact with 7 active grades (A9, Z1).

The only master fixture is one extra **inactive** grade, `P19-TEST inactiva`, created through the ADMIN master path. It is used for the inactive-grade test and removed at the end.

## 5. Tables

Both tables are exactly as in POSTGRES_SCHEMA_SPEC_V1 Domain H (A1–A6):

| Table | Content |
|---|---|
| `classification` | `id`, `idempotency_key UUID UNIQUE NOT NULL`, `classification_date`, `location` (optional), `created_at`, `created_by`, and `idx_classification_date` |
| `classification_line` | `id`, `classification_id` FK, `classification_grade_id` FK to the master, `quantity INTEGER CHECK >= 0`, `created_at`, and `UNIQUE(classification_id, classification_grade_id)` |

**Absent:**

- any uniqueness by date or by (date, location) (A7);
- any stored total (A8);
- any flock, shed, production or origin column (M1).

## 6. RPC 25

`register_classification(p_idempotency_key UUID, p_classification_date DATE, p_lines JSONB, p_location VARCHAR DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`. It is a line-by-line transcription of RPC_CONTRACTS_V1 §25, with the exact signature (K3).

- **Actor:** OPERATOR or ADMIN.
- **No flock parameter**, and no `operator_assignments` check: classification has no flock (C0).

**Technical completions** (contract behaviour unchanged; each is tested):

- A NULL or non-array `p_lines` raises `EMPTY_LINE_SET`.
- A NULL quantity raises `INVALID_QUANTITY`.
- A NULL grade raises `GRADE_NOT_FOUND`.
- **A grade repeated inside one `p_lines`** is rejected before any write with `DUPLICATE_GRADE_IN_SESSION`. The frozen schema already rejects it via `UNIQUE(classification_id, classification_grade_id)`; this only replaces the raw unique violation with a clear error. Quantities are never merged (F).
- **A concurrent retry with the same key** that passes the pre-check is reported as `DUPLICATE_CLASSIFICATION` (S1).
- **Other NULL inputs:** a NULL `idempotency_key` is rejected by the frozen NOT NULL column, and a NULL `classification_date` by the Foundation guard (`BUSINESS_DATE_REQUIRED`) (F).

## 7. Classification semantics

A session is a physical operational fact:

- a date (the period determinant);
- an optional location;
- the real author (`created_by`);
- graded quantities.

A valid session returns `{classification_id, line_count, total_quantity}` (B1), with the exact row (B2) and lines (B3).

## 8. Line semantics

- The grade is an FK to `classification_grade`, never free text (A5).
- Each grade appears at most once per session: a duplicate is refused by the RPC (F) and by the physical UNIQUE constraint, even for the owner (F2).
- `quantity >= 0` is enforced by the RPC and by the CHECK (F3).
- Validation of the whole line set happens before the first write, so an invalid *later* line aborts with nothing written (F).

## 9. Multiple sessions per day

- Same date, same location "Clasificadora", different keys: both sessions succeed and persist independently with their own lines (D1, D2).
- Concurrently, two different keys for the same date and location both succeed (S2).
- An OPEN month accepts several sessions on the same day (I3).

## 10. No flock reference

- **Structure:**
  - no flock, lote, shed, galpón, production, origin or source column in either table (M1);
  - no FK to `flocks`, `sheds`, `daily_production` or `population_events` (M2);
  - no join or allocation table (M3);
  - nothing else references `classification` (M4).
- **The RPC:** it has no such parameter (K3). An extra `flock_id` / `shed_id` inside a line is stored nowhere (M5).

## 11. No invented traceability

The session carries only its date, location, author and graded quantities (E6). Nothing infers origin from date, operator, shed, production quantities or assignments:

- no column can hold an inferred origin;
- no downstream table references a session (M4).

Classification also has no productive or economic side effect (B6, N1).

## 12. Idempotency

- **Mechanism:** `idempotency_key` UNIQUE.
- **Sequential retry:** `DUPLICATE_CLASSIFICATION`, with no second session, line set or audit (H1, H2).
- **Concurrent retry:** exactly one session and one line set survive (S1).

## 13. Total quantity derivation

`total_quantity = SUM(classification_line.quantity)`, computed from the inserted lines and never stored (A8).

| Test | Lines | Total |
|---|---|---|
| B1, B4 | 100 + 200 + 50 | 350 |
| E1 | four grades | 500 |
| E2 | two grades | 200 |

## 14. Zero quantity

A quantity of 0 is accepted, as the schema and contract (`>= 0`) allow. For example, XL 0 + N1 12 gives a total of 12 (G1). The rule was not tightened to `> 0`.

## 15. Periods

The determinant is `classification_date`.

- **CLOSED month:** `PERIOD_CLOSED` for both ADMIN and OPERATOR, with nothing written (I1).
- **Missing month:** `PERIOD_NOT_FOUND` (I2).
- **`created_at` is irrelevant:** with the current month CLOSED, two sessions dated in OPEN May are accepted (I3).

## 16. Atomicity

Test-only triggers inject real failures (L):

1. after the session insert, the **first** line fails;
2. after two lines, a **later** line fails;
3. after all lines, the audit fails.

Each case leaves no session, no line and no audit, and the harness is then removed (L1). Every validation rejection is also atomic (F1).

## 17. Concurrency

Real independent PostgreSQL sessions were used:

| Test | Race | Outcome |
|---|---|---|
| S1 | same `idempotency_key` | B waited on a lock, then `DUPLICATE_CLASSIFICATION`; exactly one session and one line |
| S2 | different keys, same date and location | both succeed |

The period-row lock taken by `assert_period_open`, part of the frozen canonical guard, orders writers within a month. It never makes a second session fail: there is no uniqueness by date or location.

## 18. RLS

Exactly as frozen in RLS §8 and §10 (J9):

| Table | ADMIN | OPERATOR |
|---|---|---|
| `classification` | SELECT all | SELECT `created_by = auth.uid()` |
| `classification_line` | SELECT all | SELECT only lines of the operator's own sessions |

There is no write policy.

- ADMIN sees every session and line (J1, E5).
- Operator A sees exactly its own sessions and lines (J2, E3), and none of B's (J3).
- Operator B is symmetric: it sees its own, not A's, not ADMIN's (J4, E4).

## 19. Privileges

- **Exact ACLs (J8):** `authenticated` has SELECT only; there are no sequences (UUID keys).
- **No direct DML:** INSERT, UPDATE, DELETE and TRUNCATE are refused for OPERATOR *and* ADMIN; RPC 25 is the only writer (J5).
- **anon and service_role:** no SELECT and no EXECUTE (J6, J7).
- **Default privileges:** clean since 0013. 0028 still resets explicitly.

## 20. SECURITY DEFINER

- **Inventory:** 27 functions, i.e. the previous 26 plus `register_classification` (K1).
- **Hardening:** SECURITY DEFINER, `search_path = public`, owner postgres, no PUBLIC entry; EXECUTE for authenticated only, not anon or service_role (K2).
- **Signature:** exactly the frozen one, with no actor, role, user, flock, shed or production parameter (K3).

## 21. Audit

Every session writes `audit_events` action `CREATE`, entity `classification`, with `after_values {classification_date, line_count}`, the exact reason and the real actor (B5). Failed calls leave no audit (F1, H2, L). There is no parallel audit table.

## 22. No economic effect

RPC 25 creates no financial operation, posting, client or supplier ledger entry, purchase or order, and no production, population or flock change. This holds per call (B6) and across every call in the suite (N1).

## 23. E2E

1. Operator A, session 1, 2026-05-20 "Mesa 1": XL 100, N1 200, N2 150, N3 50. Result: `line_count` 4, `total_quantity` 500 (E1).
2. Session 2, same date and location, different key: XL 80, N1 120. Result: an independent session with total 200 (E2).
3. Visibility:
   - A sees both sessions (E3);
   - B sees neither (E4);
   - ADMIN sees both, with 6 lines (E5).
4. No flock can be derived or attached (E6).

## 24. Automated tests

`scripts/target-db/classification.test.mjs` has **75 assertions**:

| Group | Assertions |
|---|---|
| A structure | 9 |
| B ADMIN | 6 |
| C OPERATOR | 3 |
| D multiple sessions/day | 2 |
| E locations | 2 |
| F line validation | 15 |
| G zero quantity | 1 |
| H idempotency | 2 |
| I period | 3 |
| J RLS/privileges | 9 |
| K definer | 3 |
| L atomicity | 4 |
| M no traceability | 5 |
| S concurrency | 2 |
| E2E | 6 |
| N no economic effect | 1 |
| Z cleanup | 2 |

**How the suite runs:**

- It passes on re-run.
- Every session uses a reserved test key range (`d19e0000-0000-4000-8000-…`), so cleanup is exact.
- The inactive-grade fixture and the operator B profile are removed at the end, and the seed grades are untouched.

## 25. Regression

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
| `guard.test.mjs` | 35 / 0 |

Only exact structural inventories changed; no behavioural assertion changed:

- **foundations:** the later-phase tables (+2) and definers (+1).
- **commercial I1, treasury H1, instruments Q1, purchases Z1, production U1:** the definer inventory (27).
- **treasury A2:** later-phase tables (+2).

## 26. Clean rebuild

```
before              → public tables=35, ledger=28
guard               → target proven local; cli argv proven local-only → supabase db reset
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0
rebuild             → 28 files, 0 already applied → +0001 … +0028 → ledger holds 28; public tables = 35
re-run apply.mjs    → applied 0 new migration(s); ledger now holds 28
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107, instruments 200/200,
                      purchases 216/216, production 149/149, classification 75/75, guard 35/35
```

No manual step or Studio action was needed. At the end, Supabase local was stopped.

## 27. Production isolation

- **Production:** not contacted.
- **Remote project-ref:** not used.
- **Commands never run:** `db push`, `--linked`, `link` and `unlink`.
- **Targets:** every SQL operation was direct-URL against the guarded loopback target, and the reset passed the CLI argv guard.
- **Credentials:** production credentials were unset. No secret was printed.
- **Data:** no production data was used.

## 28. Deferred

- **RPC 23 `register_flock_weighing` / `flock_weighing`, RPC 24 `register_temperature_record` / `temperature_record`:** still **UNASSIGNED**, awaiting an owner scheduling decision. They are not implemented here, and Phase 18 was not edited.
- **Classification correction or deletion:** no frozen RPC exists for it; nothing was invented.
- **Other phases and carry-forwards:** Feed (20), the transversal financial idempotency key, `source_collection_id`, frontend, and real-data migration.

## 29. Frozen contradictions

None.

The frozen contract does not define an error code for a grade repeated inside one session. The frozen schema already rejects it (UNIQUE), so the RPC only surfaces that same rejection earlier, as `DUPLICATE_GRADE_IN_SESSION`, without changing semantics. It does not merge quantities. This is documented in §6.

## 30. Exit criterion evidence

| Part of the criterion | Status | Evidence |
|---|---|---|
| Sessions with graded lines | **MET** | B1–B5, E1, E2; grades are FK masters (A5, F) |
| Multiple sessions per day | **MET** | D1, D2, E2, I3, S2; no date or location uniqueness (A7) |
| No flock reference | **MET** | M1–M5, K3, A1, A2 |
| No invented traceability | **MET** | M3, M4, E6, N1 |
| Idempotency, period, RLS, atomicity, concurrency | **MET** | H, S1, I, J, L |
| No economic effect | **MET** | B6, N1 |
| Regression, clean rebuild, production untouched | **MET** | §25–§27 |

## 31. Phase status

**PHASE 19 — CLASSIFICATION: COMPLETE** (evidence in §24–§26 and §30).

MASTER_ROADMAP.md was deliberately left unchanged, with Phase 19 = **CURRENT** until the external review. Phase 20 was not started.
