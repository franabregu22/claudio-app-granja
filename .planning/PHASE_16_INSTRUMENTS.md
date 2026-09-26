# PHASE 16 — CHEQUES / eCHEQS (INSTRUMENTS)

**STATUS:** **COMPLETE**, from mechanical evidence (§29, §30). The only blocker, ISSUED → CANCELLED, is resolved by **ADR-001 (ACCEPTED)**, implemented by migration 0018 and FROZEN amendments marked **[ADR-001]**. MASTER_ROADMAP.md is unchanged: Phase 16 = **CURRENT** until the final external review, Phase 17 = PENDING.
**DATE:** 2026-09-25
**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, container `supabase_db_Claudio_app_Granja`, PostgreSQL 17.6)
**AUTHORITIES:** MASTER_ROADMAP.md (sequence), TARGET_ARCHITECTURE_V2_FROZEN.md, RPC_CONTRACTS_V1 §5–§12, POSTGRES_SCHEMA_SPEC_V1 Domains E/F, DATABASE_INVARIANTS_V1 §7, §12, §18, §19, §20, RLS_IMPLEMENTATION_SPEC_V1 §4, §7, §10, IMPLEMENTATION_DEPENDENCY_ORDER_V1 steps 37, 41, 42. All FROZEN. Modified only by the ADR-001 amendments (marked **[ADR-001]** in RPC_CONTRACTS_V1, POSTGRES_SCHEMA_SPEC_V1, DATABASE_INVARIANTS_V1, IMPLEMENTATION_DEPENDENCY_ORDER_V1 and RLS_IMPLEMENTATION_SPEC_V1; TARGET_ARCHITECTURE_V2_FROZEN already states "with cancellation/rejection when necessary" and was not changed).

---

## 1. Exact exit criterion

> Received and issued lifecycles complete. Reception reduces client debt without touching the bank; only clearing credits it; endorsement reduces supplier debt and leaves the client paid; every rejection path compensates according to the stage actually reached.

## 2. Scope

**RPCs 5–12 and 42**, as assigned by dependency order §5.1 (RPC 42 added by ADR-001):

| Direction | RPCs |
|---|---|
| Received | 5 `receive_cheque`, 6 `deposit_cheque`, 7 `clear_cheque`, 8 `endorse_cheque`, 9 `reject_cheque` |
| Issued | 10 `issue_supplier_instrument`, 11 `mark_supplier_instrument_debited`, 12 `reject_supplier_instrument`, **42 `cancel_supplier_instrument` (ADR-001)** |

**Tables:** `financial_instrument` (step 41) and `financial_instrument_event` (step 42).

**`supplier_ledger` (step 37) is built here as the minimal structural dependency.** The roadmap lists it under Slice 2 (Phase 17), but the Phase 16 exit criterion ("endorsement reduces supplier debt") cannot be met without it. RPCs 8, 9, 10 and 12 write it. It is created exactly as frozen, and its FK targets (suppliers, perfiles) already exist.

**Reused as-is:**

- `client_ledger`, `financial_operation`, `financial_posting`, `financial_account`
- `audit_events`, `management_period`
- `current_app_role()`, `assert_period_open()`

**Not built:** purchases, `pay_supplier`, freight, feria, fiscal, MP, and any UI.

## 3. Migrations

| Version | File | Content | sha256 |
|---|---|---|---|
| 0015 | `0015_instrument_tables.sql` | `supplier_ledger`, `financial_instrument`, `financial_instrument_event` + constraints/indexes, in FK order | `b8f9e13c…297a` |
| 0016 | `0016_instrument_rpcs.sql` | RPCs 5–12, owner postgres, EXECUTE perimeter | `5c7c58be…3ff2` |
| 0017 | `0017_instrument_privileges_rls.sql` | explicit reset + SELECT grant + 3 ADMIN policies | `28cc23f2…048e` |
| 0018 | `0018_issued_instrument_cancellation.sql` | **ADR-001:** `cancelled_date` column, bidirectional `chk_instrument_cancelled_coherent`, RPC 42 with owner and EXECUTE perimeter | `016b6110…78fe` |

0001–0017 are unchanged, and the runner verified their checksums. ADR-001 was applied by `ALTER` in 0018, not by editing 0015. The legacy `supabase/migrations/` directory is untouched.

## 4. Tables / enums

**Tables, exactly as frozen (tests A1–A10):**

- **`financial_instrument`:** 24 columns (A2), including `cancelled_date`, which 0018 added under ADR-001.
  - CHECKs: `amount > 0`, `chk_instrument_received_provenance`, `chk_instrument_issued_provenance`, `chk_instrument_estado_direction`, and **`chk_instrument_cancelled_coherent`** (bidirectional: CANCELLED ⇔ `cancelled_date IS NOT NULL`, ADR-001).
  - UNIQUE on `receipt_id` and `external_ref` only. **`cheque_number` is not unique** (A5, B9).
  - Indexes: `idx_instrument_estado`, `_cliente`, `_supplier`, `_maturity`.
- **`financial_instrument_event`:**
  - UNIQUE index `idx_instrument_event_unique(financial_instrument_id, event_type)`
  - index `idx_instrument_event_date`
- **`supplier_ledger`:**
  - signed and append-only
  - `signed_amount <> 0`
  - self-FK `reversal_of_id`
  - index `idx_supplier_ledger_supplier_date`
- **FKs:** 12, all `ON DELETE RESTRICT` (A6).

**Enums (from 0002, unchanged):**

- `financial_instrument_type`: CHEQUE, ECHEQ
- `instrument_direction`: RECEIVED, ISSUED
- `instrument_estado`: 8 values
- `supplier_ledger_movement_type`

## 5. RPCs

Each RPC is a line-by-line transcription of RPC_CONTRACTS_V1 §5–§12 and §42 (ADR-001), with the same check order, error codes, writes and return shape.

**Technical completions** (contract behaviour unchanged; all tested):

- A NULL `p_amount` raises `INVALID_AMOUNT` (B8, I0).
- A duplicate `receipt_id` or `external_ref` can race past the EXISTS pre-check. The resulting UNIQUE violation is reported as the contract's `DUPLICATE_RECEIPT` / `DUPLICATE_EXTERNAL_REF` (R7).

## 6. Received lifecycle

| Step | Effect |
|---|---|
| RECEIVE | Instrument enters the portfolio (RECEIVED). Client `CHEQUE_RECEIVED −amount` at `received_date` (Buenos Aires date of `p_received_at`). **No operation, no posting.** (B1–B7) |
| DEPOSIT | RECEIVED → DEPOSITED, custody only. **No ledger, no posting.** (C1–C5) |
| CLEAR | DEPOSITED → CLEARED. `bank_account_id` persisted. One `CHEQUE_CLEAR` operation (`CLEAR:<id>`) + one `+amount` posting on the real account. **No second client reduction.** (D1–D6) |
| ENDORSE | RECEIVED → ENDORSED. Supplier `CHEQUE_ENDORSED −amount`. **Client untouched. No bank movement.** (E1–E6) |

## 7. Issued lifecycle

| Step | Effect |
|---|---|
| ISSUE | ISSUED. Supplier `INSTRUMENT_ISSUED −amount`. Bank account and `external_ref` persisted. **No bank movement.** (I1–I6) |
| DEBIT | ISSUED → DEBITED. One `INSTRUMENT_DEBIT` operation (`DEBIT:<id>`) + one `−amount` posting on the issuing account. **Supplier untouched.** (J1–J5) |
| REJECT | ISSUED or DEBITED → REJECTED. Supplier `INSTRUMENT_REJECTED +amount`; the bank is reversed only after DEBITED. (K, L) |
| **CANCEL (RPC 42, ADR-001)** | ISSUED → CANCELLED, before any debit. Supplier `REVERSAL +amount` with `reversal_of_id` → the single `INSTRUMENT_ISSUED` entry; `cancelled_date` persisted. **No operation, no posting, bank untouched.** (V1–V9) |

The issued lifecycle now reaches every frozen state, ISSUED, DEBITED, REJECTED and CANCELLED, each through a contracted RPC (V27).

## 8. State transition matrix

| From \ RPC | deposit | clear | endorse | reject_cheque | debit | reject_supplier | cancel_supplier (42) |
|---|---|---|---|---|---|---|---|
| RECEIVED | → DEPOSITED | INVALID_STATE | → ENDORSED | → REJECTED | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION |
| DEPOSITED | INVALID_STATE | → CLEARED | INVALID_STATE | → REJECTED | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION |
| CLEARED | INVALID_STATE | INVALID_STATE | INVALID_STATE | → REJECTED | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION |
| ENDORSED | INVALID_STATE | INVALID_STATE | INVALID_STATE | → REJECTED | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION |
| REJECTED (received) | INVALID_STATE | INVALID_STATE | INVALID_STATE | ALREADY_REJECTED | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION |
| ISSUED | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION | → DEBITED | → REJECTED | **→ CANCELLED** |
| DEBITED | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION | INVALID_STATE | → REJECTED | INVALID_STATE |
| REJECTED (issued) | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION | INVALID_STATE | INVALID_STATE | INVALID_STATE |
| **CANCELLED** | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION | WRONG_DIRECTION | INVALID_STATE | INVALID_STATE | INVALID_STATE |

**Evidence:**

- 21 illegal transitions are tested (M group), plus 7 invalid cancellations (V group). None changes anything.
- Every transition locks the instrument FOR UPDATE and validates `estado` before any write.
- The physical backstops also hold, even for the table owner:
  - a duplicate lifecycle event is rejected by `idx_instrument_event_unique`;
  - a wrong-direction state is rejected by `chk_instrument_estado_direction`;
  - CANCELLED without a date, or a date without CANCELLED, is rejected by `chk_instrument_cancelled_coherent` (V23–V25).
- ISSUED → CANCELLED is executed only by RPC 42, the single function that writes CANCELLED to an instrument (M, ADR-001). CANCELLED is terminal, and RPCs 11 and 12 refuse it (V26).

## 9. Client ledger effects

Sign convention: `+` means more debt, `−` means less.

| Event | client_ledger |
|---|---|
| Reception | `CHEQUE_RECEIVED −amount` |
| Deposit, clear | none |
| Endorse | none — the client stays paid |
| Rejection after RECEIVED / DEPOSITED / CLEARED | `CHEQUE_REJECTED +amount` at `rejected_date` |
| Rejection after ENDORSED | none |

The client account stays global: there is no allocation to orders and no stored balance.

## 10. Supplier ledger effects

Sign convention: `+` means more debt, `−` means less.

| Event | supplier_ledger |
|---|---|
| Endorse | `CHEQUE_ENDORSED −amount` on the endorsee |
| Issue | `INSTRUMENT_ISSUED −amount` |
| Debit | none |
| Rejection after ENDORSED | `INSTRUMENT_REJECTED +amount` on the endorsee |
| Rejection after ISSUED / DEBITED | `INSTRUMENT_REJECTED +amount` on the supplier |
| **Cancellation (RPC 42, ADR-001)** | `REVERSAL +amount` at `cancelled_date`, with `reversal_of_id` pointing to the **exactly one** matching `INSTRUMENT_ISSUED` row (same supplier_id, movement_type, source type and source id). The pair nets to zero (V6, V7). If the count is not exactly 1, the call raises `ISSUANCE_LEDGER_INCONSISTENT` and writes nothing (V20–V22). |

**Test-fixture note:** no Phase 16 RPC creates supplier debt (purchases are Phase 17). The suite's initial supplier debt is therefore an owner-written `OPENING_BALANCE` row tagged `test_fixture`. Every movement the suite asserts on comes from the RPCs.

## 11. Financial posting effects

Only real money is posted.

| Event | Operation / posting |
|---|---|
| Clear | `CHEQUE_CLEAR`: `+amount` |
| Rejection after CLEARED | `CHEQUE_REJECTION`: `−amount` on the **same** account |
| Debit | `INSTRUMENT_DEBIT`: `−amount` |
| Rejection after DEBITED | `INSTRUMENT_DEBIT_REVERSAL`: `+amount` on the same account |

Reception, deposit, endorsement, issue and **cancellation** post nothing (V5).

Every instrument operation has exactly one posting with the frozen sign (U6). There is no double-entry, no AR/AP posting and no stored balance.

## 12. Endorsement

- **What it does:** only a RECEIVED (in-portfolio) instrument can be endorsed. Endorsing from DEPOSITED raises `INVALID_STATE`.
- **Effects:**
  - supplier debt is reduced;
  - the client stays paid;
  - the bank is untouched.
- **Rejection after endorsement:** supplier debt reopens on the endorsee, and **the client is not reopened**, as frozen (H1–H4, S8–S9).

## 13. Rejection matrix

One fresh instrument per stage; test group T measures the deltas directly.

| Stage reached | client | supplier | bank | operations |
|---|---|---|---|---|
| RECEIVED | +amount | — | — | 0 |
| DEPOSITED | +amount | — | — | 0 |
| CLEARED | +amount | — | −amount (same account) | 1 `CHEQUE_REJECTION` |
| ENDORSED | — | +amount (endorsee) | — | 0 |
| ISSUED | — | +amount | — | 0 |
| DEBITED | — | +amount | +amount (same account) | 1 `INSTRUMENT_DEBIT_REVERSAL` |

**Cancellation** is not a rejection. It is a separate termination through RPC 42: from ISSUED only, supplier `+amount` (REVERSAL), bank unchanged, 0 operations (V1–V7). After DEBITED the only path is a rejection, which reverses the bank.

`reject_cheque` requires a reason (`REASON_REQUIRED`). A repeated rejection raises `ALREADY_REJECTED` (received) or `INVALID_STATE` (issued), with no double compensation (G5, L4).

## 14. Period determinants

Each step is guarded by `assert_period_open` on its own frozen date, per DATABASE_INVARIANTS_V1 §12:

| Step | Period determinant |
|---|---|
| receive | `received_date` (Buenos Aires date of `p_received_at`) |
| deposit | `deposited_date` |
| clear | `cleared_date` |
| endorse | `endorsed_date` |
| reject | `rejected_date` |
| issue | `issued_date` |
| debit | `debited_date` |
| cancel (RPC 42, ADR-001) | `cancelled_date` |

**Evidence:**

- **CLOSED month:** all 9 RPCs raise `PERIOD_CLOSED`, with full rollback (N group, and V11 for RPC 42). This includes `2026-04-01 02:00 UTC`, which is `2026-03-31` in Buenos Aires.
- **Missing month:** `PERIOD_NOT_FOUND`.
- **Each step uses its own date:** an instrument received in June (then CLOSED) is deposited, cleared and rejected in OPEN July, and the rejection's client entry is dated in July.
- **`created_at` is irrelevant:** an instrument created in the CLOSED current month is accepted with a received date in May.
- **Cancellation uses its own date:** an instrument issued in June (then CLOSED) is cancelled in OPEN July, and the REVERSAL is dated in July (V13). With the current month CLOSED, a cancellation dated in May is accepted (V14).
- There is no blanket future-date restriction (N group).

## 15. Atomicity

Test-only triggers in schema `p16_harness` inject real failures after earlier writes of the same call. Every case rolls back completely, and the triggers are removed afterwards (O7).

| Test | RPC | Already written | Fails at |
|---|---|---|---|
| O1 | reject | state + client_ledger | event |
| O2 | clear | state + operation | posting |
| O3 | endorse | state + event + supplier_ledger | audit |
| O4 | debit | state + operation | posting |
| O5 | reject after debit | state + supplier_ledger + reversal operation | reversal posting |
| O6 | reject after clear | state + client_ledger + reversal operation + posting + event | audit |
| V15 | cancel | state + supplier REVERSAL | event |
| V16 | cancel | state + supplier REVERSAL + event | audit |

## 16. Concurrency

Real independent PostgreSQL sessions were used. In each case, session B was observed in `pg_stat_activity` waiting on a lock held by A, and exactly one valid transition remained:

- **R1–R2, two clears:** B raises `INVALID_STATE`; 1 operation and 1 posting remain.
- **R3–R4, two rejects:** B raises `ALREADY_REJECTED`; 1 client compensation remains.
- **R5, endorse vs deposit** (both from RECEIVED): the second raises `INVALID_STATE`, and the events show a single transition.
- **R6, two debits:** B raises `INVALID_STATE`; 1 debit remains.
- **R7, two receptions with the same `receipt_id`:** B raises `DUPLICATE_RECEIPT`; 1 instrument remains.
- **V17–V18, two cancels:** B raises `INVALID_STATE`; exactly 1 CANCELLED event, 1 REVERSAL and 0 postings remain.
- **V19, cancel vs debit:** the debit waits, then raises `INVALID_STATE`; there is no bank movement.

## 17. Idempotency

- **Reception:** `receipt_id` is UNIQUE and, by CHECK, required for RECEIVED.
- **Transitions:** protected by the state guard under the row lock, by the unique `(instrument, event_type)` index, and by deterministic system keys `CLEAR:` / `REJECT:` / `DEBIT:` / `DEBIT_REV:` `<id>` on `financial_operation.external_ref`.
- **Issue:** `external_ref` is UNIQUE.
- **Cancel (RPC 42):** protected by the state guard under the row lock and by the unique CANCELLED event. The REVERSAL provenance requires exactly one issuance entry.

**Carry-forward decision** (PHASE_15_TREASURY.md §22): it does **not** block Phase 16. The only path without replay protection is `issue_supplier_instrument` with a NULL `external_ref`, which the contract allows as written (U5). This is the same case as a transfer with a NULL reference. It stays in the carry-forward and is not silently changed here, because that would alter a FROZEN contract/schema.

## 18. RLS

One ADMIN SELECT policy per table: `supplier_ledger_admin_select`, `financial_instrument_admin_select`, `financial_instrument_event_admin_select` (P8).

There is no OPERATOR policy and no write policy. OPERATOR reads 0 rows (P2).

## 19. Privileges

- **Exact ACLs (P7):** `authenticated` has SELECT only; the sequences are owner-only.
- **0017 resets explicitly.** It does so even though, since 0013, new tables are already born owner-only.
- **Even ADMIN has no direct DML:** INSERT, UPDATE (including forcing `estado`, or setting CANCELLED), DELETE and TRUNCATE on instruments, events and supplier_ledger are all refused (P6).
- **anon and service_role:** no EXECUTE and no SELECT (P4, P5).

## 20. SECURITY DEFINER

- **Inventory:** 16 functions (Q1), i.e. the previous 7 plus the 9 instrument RPCs (8 + RPC 42).
- **Hardening of each instrument RPC (Q2):**
  - SECURITY DEFINER with `search_path = public`, owner postgres;
  - explicit ACL with no PUBLIC entry;
  - EXECUTE: authenticated yes, anon no, service_role no.
- **Actor and role:** no parameter names the actor or the role (Q3). The actor is always `auth.uid()` and the role is always `current_app_role()`.

## 21. Audit / events

- **One of each per successful step:** every successful lifecycle step wrote exactly one `financial_instrument_event` row **and** one `audit_events` row. Failed calls wrote neither (U1).
- **Audit actions:** RECEIVE, DEPOSIT, CLEAR, ENDORSE, REJECT, ISSUE, DEBIT, REJECT_ISSUED, and **CANCEL_ISSUED** (ADR-001; V9). Each row carries the real actor and a time (U2, U3).
- **Two layers:** the event trail is the lifecycle history, and `audit_events` stays the single transversal audit. There is no third audit structure.
- **Protection:** neither can be modified by the application (U4).

## 22. E2E

Scenarios S1–S12. BNA is a dedicated test account.

**Received, cleared and later rejected:**

| Step | Client debt | BNA |
|---|---|---|
| Pedido delivered | 100000 | 0 |
| Receive cheque | 0 | unchanged |
| Deposit | 0 | unchanged |
| Clear into BNA | 0 | +100000 |
| Rejected after clearing | 100000 | back to initial |

**Rejected before clearing:** the client owes 80000 → cheque → debt 0 → rejection → debt 80000. The bank never moves.

**Endorsement:** the client owes 60000 → cheque → client 0 → endorse to a supplier owed 60000 → supplier 0. The client stays 0 and the bank does not move.

**Issued, debited and later rejected:**

| Step | Supplier debt | Bank |
|---|---|---|
| Initial | 50000 | initial |
| Issue eCheq | 0 | unchanged |
| Mark debited | 0 | −50000 |
| Rejected after debit | 50000 | restored |

**Issued, then cancelled before debit** (ADR-001):

| Step | Supplier debt | Bank |
|---|---|---|
| Initial | 50000 | 0 |
| Issue | 0 | unchanged |
| Cancel | 50000 (REVERSAL linked to the issuance) | unchanged, no operation, no posting |

This is tests V1–V5.

## 23. Automated tests

`scripts/target-db/instruments.test.mjs` has **200 assertions**:

| Group | Assertions |
|---|---|
| A structure | 10 |
| B receive | 10 |
| C deposit | 5 |
| D clear | 7 |
| E endorse | 7 |
| F reject before clear | 7 |
| G reject after clear | 5 |
| H endorsed rejection | 4 |
| I issue | 7 |
| J debit | 5 |
| K issued reject before debit | 3 |
| L issued reject after debit | 4 |
| M illegal transitions | 25 |
| N periods | 13 |
| O atomicity | 7 |
| P security | 10 |
| Q definer | 3 |
| R concurrency | 7 |
| S cross-domain E2E | 12 |
| T rejection matrix | 6 |
| V RPC 42 cancel (ADR-001) | 35 |
| U audit/events/idempotency | 6 |
| Z cleanup | 2 |

The suite passes on re-run. Its synthetic `P16-TEST` fixtures are removed at start and end, and the periods it closed are reopened.

## 24. Regression

| Suite | Result |
|---|---|
| `apply.test.mjs` | 27 / 0 |
| `foundations.test.mjs` | 96 / 0 |
| `commercial.test.mjs` | 147 / 0 |
| `treasury.test.mjs` | 107 / 0 |
| `instruments.test.mjs` | 200 / 0 |

Only exact structural inventories were extended to know the new objects; no behavioural assertion changed:

- **foundations:** the later-phase tables list (+3) and the definer list (+8, then +1 for RPC 42).
- **commercial I1:** the definer inventory (now 16 functions, including RPC 42).
- **treasury:**
  - A2: the table count, now 23 + 3 later-phase tables;
  - H1: the definer inventory (16, including RPC 42);
  - B11: was "supplier_ledger does not exist yet", now "no supplier_ledger row references the transfer". The RPC-body check is unchanged.
- **instruments (own suite), for ADR-001:**
  - A2 and A4 now know `cancelled_date` and `chk_instrument_cancelled_coherent`;
  - the M assertion "no RPC produces CANCELLED" became "CANCELLED is written only by RPC 42";
  - U2 includes CANCEL_ISSUED, and P/Q include RPC 42.

## 25. Clean rebuild

```
before              → public tables=26, ledger=18
guard               → target proven local; cli argv proven local-only → supabase db reset
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0
rebuild             → 18 files, 0 already applied → +0001 … +0018 → ledger holds 18
re-run apply.mjs    → applied 0 new migration(s); ledger now holds 18
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107, instruments 200/200 (guard 35/35)
```

No manual step or Studio action was needed. At the end, Supabase local was stopped.

## 26. Production isolation

- **Production:** not contacted.
- **Remote project-ref:** not used.
- **Commands never run:** `db push`, `--linked`, `link` and `unlink`.
- **Targets:** every SQL operation was direct-URL against the guarded loopback target, and the reset passed the CLI argv guard.
- **Credentials:** production credentials were unset. No secret was printed.
- **Data:** no production data was used.

## 27. Deferred

- **Rest of Phase 17:** purchases, `pay_supplier` (supplier PAYMENT), freight, and Slice 2 end to end. `supplier_ledger` already exists, so Phase 17 must reuse it and not recreate it.
- **ISSUED → CANCELLED:** **resolved** by ADR-001 (RPC 42, migration 0018).
- **MASTER_ROADMAP.md text:** it still describes the implementation design as "41 RPCs" (lines 36, 60, 111). This is historical/descriptive text, left for the administrative closure because this task forbade roadmap edits.
- **Idempotency carry-forward** (PHASE_15 §22): still open; it now also covers `issue_supplier_instrument` with a NULL `external_ref`.
- **`financial_instrument.source_collection_id`:** a frozen column that no RPC in §5–§12 or §42 writes. It stays NULL, and nothing was invented for it.

## 28. Contradictions

**None open.**

- **Resolved: ISSUED → CANCELLED.** The contradiction, confirmed by the external review, was that the transition was defined in the invariants, the enum and the architecture, but no RPC existed for it and no `cancelled_date` column existed.
- **Resolution:** ADR-001 was **ACCEPTED** with D1 (RPC 42), D2 (REVERSAL with exact-cardinality provenance) and D3 (`cancelled_date` plus a bidirectional CHECK). It is implemented by FROZEN amendments marked **[ADR-001]** and by migration 0018, and proven by test group V.
- `supplier_ledger` being needed before Phase 17 is a dependency the frozen dependency order already satisfies (step 37 comes before 41). The roadmap's slice grouping does not forbid it.

## 29. Exit evidence

| Part of the criterion | Status | Evidence |
|---|---|---|
| Received lifecycle complete | **MET** | B, C, D, E, F, G, H; state matrix §8 |
| Issued lifecycle complete | **MET** | ISSUE (I), DEBIT (J), REJECT before and after debit (K, L), and CANCEL (V1–V27, ADR-001). Every frozen issued state is reachable (V27). |
| Reception reduces client debt without touching the bank | **MET** | B3, B4, B6, S2 |
| Only clearing credits the bank | **MET** | C4 (deposit posts nothing), D2–D4, S3–S4, U6 |
| Endorsement reduces supplier debt and leaves the client paid | **MET** | E3–E5, S9 |
| Every rejection path compensates according to the stage actually reached | **MET** | F, G, H, K, L, the T matrix (6/6 stages), S5, S7, S12 |
| Atomic, concurrency-safe, secured | **MET** | O, R, P, Q; V15–V19 for RPC 42 |
| Regression and clean rebuild | **MET** | §24, §25 |
| Production isolation | **MET** | §26 |

## 30. Phase status

**PHASE 16 — CHEQUES / eCHEQS: COMPLETE** (evidence in §23–§25 and §29).

The ADR-001 blocker is withdrawn. Received and issued lifecycles are complete: the issued lifecycle covers ISSUE, DEBIT, REJECT and CANCEL.

MASTER_ROADMAP.md is unchanged: Phase 16 = **CURRENT** until the final external review, Phase 17 = PENDING. Phase 17 was not started.
