# PHASE 15 — TREASURY

**STATUS:** COMPLETE, from mechanical evidence (§24, §25). MASTER_ROADMAP.md was not changed; Phase 15 stays **CURRENT** there until the external review.
**DATE:** 2026-09-25
**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, container `supabase_db_Claudio_app_Granja`, PostgreSQL 17.6)
**AUTHORITIES:** MASTER_ROADMAP.md (sequence), TARGET_ARCHITECTURE_V2_FROZEN.md (Parts 19–20), RPC_CONTRACTS_V1 §39, DATABASE_INVARIANTS_V1 §6/§8, RLS_IMPLEMENTATION_SPEC_V1 §4/§7/§10, IMPLEMENTATION_DEPENDENCY_ORDER_V1 §5.1. All FROZEN, none modified.

---

## 1. Exact roadmap exit criterion

> `financial_account`, `financial_operation`, `financial_posting`, transfers. Account balance equals the sum of postings. A transfer posts exactly twice with opposite signs, atomically, and does not affect results.

## 2. Scope implemented

The dependency order (§5.1, "Treasury") assigns exactly one RPC to this phase: **39 `transfer_between_accounts`**.

- **Tables:** all three already exist and are reused unchanged:
  - `financial_account`: Foundations, 0004;
  - `financial_operation`, `financial_posting`: Phase 14, 0010.
- **RLS and grants** for those tables are already the frozen ones (0012 / 0013). No new policy is needed. The coverage matrix (RLS spec §10) lists `financial_operation` and `financial_posting` as ADMIN SELECT only, written by RPC only.
- **Not implemented:**
  - instruments and cheques (Phase 16);
  - `FEE` operations (created by MP reconciliation, Phase 23);
  - suppliers, feria, fiscal;
  - any frontend.

## 3. Migrations created

| Version | File | Content | sha256 |
|---|---|---|---|
| 0014 | `0014_treasury_transfer_rpc.sql` | RPC 39, owner, EXECUTE perimeter | `2e055b53…e5ed` |

- **Single migration:** there is no table, constraint or policy to add, so no separate migration was created for them.
- **Untouched:** 0001–0013 are unchanged (the runner verifies their checksums), and the legacy `supabase/migrations/` directory is untouched.
- **Runner:** 0014 was applied with the unchanged runner.

## 4. New tables / objects

- **New tables:** none. `public` still holds exactly 23 tables (test A2).
- **New function:** `public.transfer_between_accounts(uuid, uuid, numeric, date, varchar, text) RETURNS jsonb`.
- **No parallel structure:** there is no cash/bank/movement/transfer/balance/journal table (A9) and no balance column in `financial_account` (A8).

## 5. RPCs

The RPC is a line-by-line transcription of the RPC_CONTRACTS_V1 §39 pseudocode.

1. **Checks, in this order:**
   1. `current_app_role()='ADMIN'`, else `FORBIDDEN`
   2. `INVALID_AMOUNT`
   3. `SAME_ACCOUNT`
   4. `SOURCE_ACCOUNT_NOT_FOUND_OR_INACTIVE`
   5. `DEST_ACCOUNT_NOT_FOUND_OR_INACTIVE`
   6. `DUPLICATE_TRANSFER`
   7. `assert_period_open(p_effective_date)`
2. **Writes:**
   - 1 `financial_operation` of type `TRANSFER`
   - posting `−amount` on the source account
   - posting `+amount` on the destination account
   - 1 `audit_events` row
3. **Returns** `{financial_operation_id, posting_ids:[source, dest]}`.

**Technical completions** (contract behaviour unchanged; both are tested):

- A NULL `p_amount` raises `INVALID_AMOUNT`. Without this, `NULL <= 0` would let it pass (test C, "NULL amount").
- Two concurrent calls with the same `external_ref` can both pass the EXISTS pre-check. The later one then hits the UNIQUE index. The RPC catches that `unique_violation` and raises the contract's `DUPLICATE_TRANSFER`, and the whole losing call rolls back (K1–K4).

## 6. financial_operation / financial_posting semantics

- **Ledger:** `financial_operation` is 1:N `financial_posting`. It is the single Target V1 money ledger.
- **What a posting is:** real money movement on a real account. There is no double-entry accounting, no AR/AP posting, and no zero-sum requirement across the system.
- **Coexistence with Phase 14:**
  - A collection is 1 COLLECTION operation with 1 `+amount` posting.
  - A transfer is 1 TRANSFER operation with 2 postings.
  - `payment_method = 'TRANSFER'` on a client collection is a different fact. It produces a COLLECTION operation sourced from `collections` (I1, I6).
- **Commercial check updated:** Commercial test L5 now asserts that every posting belongs to a collection **or** to a transfer that nets to zero. Collection postings still equal collections in both count and sum.

## 7. Transfer semantics

- **Shape:** ONE `TRANSFER` operation plus exactly TWO postings on it: one negative on the source, one positive on the destination. Both postings use the operation's `effective_date`, and the two accounts are distinct (B3–B7, E5).
- **Sum to zero:** the two postings of a transfer sum to 0 because the same money moves between two accounts. It is not a global double-entry rule.
- **No other ledger:** no client ledger entry, no supplier ledger entry, no result. The RPC body references neither ledger (B10, B11). Total money across all accounts is unchanged (B12).

## 8. Sign convention

A positive `signed_amount` means money enters the account. A negative one means money leaves it.

| Movement | Posting |
|---|---|
| Transfer, source account | `−amount` |
| Transfer, destination account | `+amount` |
| Collection, receiving account | `+amount` |

## 9. Account balance derivation

- **Rule:** account balance = `SUM(financial_posting.signed_amount)` for the account. Nothing is stored (invariant 6).
- **Evidence:**
  - Successive and reverse transfers match start balance + net flows (J1, J2).
  - A negative balance is allowed, because the frozen design does not prohibit it (J3: −5000.00).
  - Transfers never touch the account row: `financial_account.xmin` is unchanged (J4).
  - Concurrent distinct transfers lose no update (K5).

## 10. Period determination

- **Determinant:** `financial_posting.effective_date`, which is the same date for both postings. It is explicit through `p_effective_date` and checked by `assert_period_open` before any write.
- **CLOSED month:** `PERIOD_CLOSED`, with no operation, posting or audit row left behind (D1–D4).
- **Missing month:** `PERIOD_NOT_FOUND` (D5).
- **`created_at` is not the determinant:** an operation whose `created_at` falls in the CLOSED current month (2026-09) is accepted with an effective date in OPEN 2026-04 (D6, D7).
- **No blanket future-date restriction**, as the contract defines none (D8).

## 11. Atomicity

The RPC is one transaction.

- **Failure at the destination posting:** a test-only trigger in a throwaway schema rejects the destination posting of one specific transfer, after the operation and the source posting were already written. The call rolls back completely (E1, E2). The trigger and schema are dropped afterwards (Z1).
- **Failure at the source posting:** an amount of 0.004 passes `> 0`, the operation is written, and the source posting rounds to 0.00 and violates its CHECK. Nothing survives (E3, E4).
- **Global invariants checked:** no transfer with fewer or more than 2 postings, same signs, one account, or a date different from its operation (E5, J5). No TRANSFER operation without postings (E6).

## 12. Idempotency

- **Mechanism:** `financial_operation.external_ref` is UNIQUE. A replay is **rejected** with `DUPLICATE_TRANSFER`, not replayed, and the money is not duplicated (F1–F3).
- **Shared namespace:** the key is unique across all operations, so a collection receipt cannot be reused as a transfer reference (F4).
- **Concurrent same key**, with two real independent sessions:
  - A performs the transfer and holds its transaction open.
  - B is observed in `pg_stat_activity` waiting on a lock (the period row that `assert_period_open` locks FOR UPDATE).
  - After A commits, B fails with `DUPLICATE_TRANSFER`.
  - Result: exactly 1 operation and 2 postings (K1–K4).
- **Contract as written:** a NULL `external_ref` is not deduplicated, because UNIQUE ignores NULL (F5). This is recorded in §22.

## 13. RLS

The policies are unchanged from 0012:

- `financial_operation_admin_select`, `financial_posting_admin_select`;
- `financial_account` ADMIN select, insert and update, plus `financial_account_service_select`.

OPERATOR reads 0 rows from all three tables (G9). RLS is enabled on all three (A7).

## 14. Privilege perimeter

- **Exact ACLs (G12):**
  - `financial_operation` and `financial_posting`: `authenticated` = SELECT only;
  - their sequences: owner-only.
- **Direct DML is denied even to ADMIN:**
  - INSERT on operations or postings (G2, G3);
  - UPDATE or DELETE on postings, UPDATE on operations (G4–G6);
  - TRUNCATE on either table (G7, G8).
- **anon:** no SELECT and no EXECUTE (G10).
- **service_role:** no EXECUTE on RPC 39, no access to operations or postings. It keeps only the frozen `financial_account` SELECT (G11).
- **Default privileges:** still clean since 0013, so new tables would not inherit broad Supabase grants (G13).

## 15. SECURITY DEFINER

- **Inventory:** 7 functions (H1): `assert_period_open`, `cancel_order`, `current_app_role`, `deliver_order`, `rectify_delivered_order`, `register_collection`, `transfer_between_accounts`.
- **RPC 39 hardening:**
  - SECURITY DEFINER with `search_path = public`, owner postgres (H2);
  - explicit ACL with no PUBLIC entry (H3);
  - EXECUTE: anon no (H4), `authenticated` yes, `service_role` no (H5). The spec reserves service_role for MP RPCs 40/41.
- **Actor and role:** no parameter can name the actor or the role (H6).

## 16. Audit

- **Row written:** one `audit_events` row per transfer, with `entity_type='financial_operation'`, `action='TRANSFER'`, `after_values {source, dest, amount, effective_date}`, the reason, the actor and a timestamp (L1).
- **Failed calls** write no audit row. There is exactly one audit row per TRANSFER operation (L2).
- **Protection:** the application can neither update nor delete audit rows (L3), and there is no Treasury-specific audit table (L4).

## 17. Commercial integration

Tested flow (I0–I6):

1. A delivery creates debt and no posting.
2. `register_collection` (method TRANSFER) creates one COLLECTION operation with a `+40000` posting.
3. A transfer of 25000 then moves part of that money from Caja to Banco.

Results:

- the client's debt stays 0.00 before and after the transfer;
- Caja + Banco stay constant;
- the transfer operation carries no source entity and no client ledger entry.

The Phase 14 suite still passes 147/147.

## 18. Automated tests

`scripts/target-db/treasury.test.mjs` has **107 assertions**:

| Group | Assertions |
|---|---|
| A structure | 9 |
| B success | 12 |
| C validation | 13 |
| D period | 9 |
| E atomicity | 6 |
| F idempotency | 5 |
| G security | 15 |
| H definer | 6 |
| I commercial integration | 7 |
| J balances | 5 |
| K concurrency | 5 |
| L audit | 4 |
| S end-to-end | 9 |
| Z cleanup | 2 |

**How the suite runs:**

- Fixtures are synthetic (`P15-TEST`), including dedicated test accounts funded through real collections.
- The suite removes them at start and end and reopens the periods it closed.
- It passes on re-run with identical results.

**Suites run on the rebuilt database:**

| Suite | Result |
|---|---|
| `apply.test.mjs` | 27 / 0 |
| `foundations.test.mjs` | 96 / 0 |
| `commercial.test.mjs` | 147 / 0 |
| `treasury.test.mjs` | 107 / 0 |
| `guard.test.mjs` | 35 / 0 |

**Structural adaptations** (both are needed only because RPC 39 now exists; neither weakens a test):

- `foundations.test.mjs`: the exact SECURITY DEFINER inventory now includes RPC 39.
- `commercial.test.mjs`:
  - I1: the exact inventory now includes RPC 39.
  - L5: still asserts that money enters only through collections, with collection postings equal to collections in both count and sum. It now also requires every transfer to net to zero.

## 19. E2E scenario

Dedicated accounts, funded through real sales and collections:

| Step | Caja | BNA | Other effect |
|---|---|---|---|
| Initial state | 100000.00 | 50000.00 | |
| Transfer Caja → BNA 30000 | 70000.00 | 80000.00 | 1 operation, 2 postings (−30000.00 / +30000.00); net worth change 0 (150000.00 before and after); client ledger unchanged |
| Order delivered, 12000 | 70000.00 | 80000.00 | client debt 12000.00; accounts untouched |
| Collection of 12000 into Caja | 82000.00 | 80000.00 | client debt 0.00 |
| Transfer Caja → BNA 8000 | 74000.00 | 88000.00 | total 162000.00 unchanged; client debt still 0.00 |

This is tests S1–S9.

## 20. Clean rebuild

```
before              → public tables=23, ledger=14
guard               → target proven local; cli argv proven local-only → supabase db reset
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0
rebuild             → 14 files, 0 already applied → +0001 … +0014 → ledger holds 14
re-run apply.mjs    → applied 0 new migration(s); ledger now holds 14
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107 (guard 35/35)
```

No manual step or Studio action was needed. At the end, Supabase local was stopped.

## 21. Production isolation

- **Production:** not contacted.
- **Remote project-ref:** not used.
- **Commands never run:** `db push`, `--linked`, `link` and `unlink`.
- **Targets:** every SQL operation was direct-URL against the guarded loopback target, and the CLI reset passed the argv guard.
- **Credentials:** `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` were unset. No secret was printed.
- **Data:** no production data was used.

## 22. Deferred items

- **`FEE` operations:** created by `mp_reconcile_movement` (Phase 23 — Mercado Pago Definitive), never netted into a transfer.
- **Instrument-related postings:** `CHEQUE_CLEAR`, `INSTRUMENT_DEBIT` and similar belong to Phase 16.
- **`sales_session` FKs:** unchanged from Phase 14 §16; owned by Phase 21.
- **Observation, not blocking:** as written, the contract does not reject a NULL `p_external_ref`, and UNIQUE does not deduplicate NULLs. A transfer without a reference therefore has no replay protection (F5). The implementation follows the contract literally. Making the reference mandatory would change contract behaviour and is an owner decision, not a technical one.
- **CARRY-FORWARD DECISION (owner, recorded 2026-09-25 at the Phase 15 administrative closure; not yet implemented).**
  - **Financial-operation idempotency:** application-initiated financial operations must ultimately have a non-null, internal, system-generated idempotency key. External references and receipts remain optional business metadata and must not be the sole deduplication mechanism.
  - **Scope:** the decision applies across every financial operation. It must be implemented in a later phase through an explicit design change and a new migration.
  - **Not done now:** 0014 is unchanged, and no SQL or schema changed at closure.
  - **Why it is recorded here:** the FROZEN RPC_CONTRACTS_V1 and POSTGRES_SCHEMA_SPEC_V1 were not modified, because changing them requires an ADR. This entry is therefore the carry-forward record, and it resolves the F5 observation above as an owner decision.

## 23. Frozen contradictions

None.

## 24. Exit criterion evidence

| Part of the criterion | Status | Evidence |
|---|---|---|
| `financial_account`, `financial_operation`, `financial_posting` | **MET** | A2–A8; reused, RLS on, frozen ACLs (G12) |
| transfers | **MET** | RPC 39 exact signature (A1); B2–B12 |
| Account balance equals the sum of postings | **MET** | B8, B9, J1–J4, K5, S2, S7, S8; no balance column (A8) |
| A transfer posts exactly twice | **MET** | B4, E5, J5, K4, S3 |
| with opposite signs | **MET** | B5, B6, B7, E5 |
| atomically | **MET** | D1–D4, E1–E6, K3–K4 |
| and does not affect results | **MET** | B10–B12, I4–I6, S4, S5 |
| Regression and rebuild | **MET** | §18, §20 |
| Production isolation | **MET** | §21 |

## 25. Phase status

**PHASE 15 — TREASURY: COMPLETE** (evidence in §18–§20 and §24).

MASTER_ROADMAP.md was deliberately left with Phase 15 = **CURRENT** until the external review. Phase 16 was not started.
