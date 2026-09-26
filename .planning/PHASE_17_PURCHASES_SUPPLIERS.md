# PHASE 17 — PURCHASES / SUPPLIERS (SLICE 2)

**STATUS:** **COMPLETE**, from mechanical evidence (§36, §37). The only external blocker was resolved by **ADR-002 (ACCEPTED)**, implemented by migration 0022 and FROZEN amendments marked **[ADR-002]**. MASTER_ROADMAP.md is unchanged: Phase 17 = **CURRENT** until the final external review.
**DATE:** 2026-09-25
**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, container `supabase_db_Claudio_app_Granja`, PostgreSQL 17.6)
**AUTHORITIES:**

- MASTER_ROADMAP.md (sequence)
- TARGET_ARCHITECTURE_V2_FROZEN.md (Parts 8, 9, 20)
- RPC_CONTRACTS_V1 §13–§17
- POSTGRES_SCHEMA_SPEC_V1 Domain F
- DATABASE_INVARIANTS_V1 §7, §12, §22–§25
- RLS_IMPLEMENTATION_SPEC_V1 §4, §7, §10
- IMPLEMENTATION_DEPENDENCY_ORDER_V1 §2.7, §2.9, §3.6

All five implementation-design documents are FROZEN, as amended by ADR-001. In this phase they were modified only by the ADR-002 amendments: `RPC_CONTRACTS_V1` §13 and §14, `DATABASE_INVARIANTS_V1` §16, and a note in `POSTGRES_SCHEMA_SPEC_V1` on `purchases`, each marked **[ADR-002]**.

---

## 1. Exact exit criterion

> **Slice 2** runs end to end. Liability recognised at `economic_date` on the global supplier account. Attachment mandatory. Payments unallocated to invoices. Freight recognised once and allocated without double counting; landed cost derives correctly.

## 2. Scope

**Slice 2:** `SUPPLIER → PURCHASE → SUPPLIER LEDGER → PAYMENT → FINANCIAL OPERATION → FINANCIAL POSTING`, plus `FREIGHT → FREIGHT ALLOCATION → DERIVED LANDED COST`.

**Built:**

- Tables: `purchases`, `purchase_line`, `purchase_attachment`, `freight`, `freight_allocation`.
- RPCs 13–17.
- The frozen step-3.6 foreign keys for cycle 2 (`flocks ↔ purchases`).

**Reused:**

- `suppliers`, `expense_category`, `projects`, `products`, `feed_ingredient`, `financial_account`
- `supplier_ledger` (from Phase 16; not recreated)
- `financial_operation`, `financial_posting`, `audit_events`, `management_period`, `perfiles`
- `current_app_role()`, `assert_period_open()`

**Not built:**

- purchase orders, invoice allocation, a parallel AP structure;
- stored supplier balance, stored landed cost;
- fiscal documents, VAT, inventory costing, weighted-average cost;
- Production;
- any frontend.

## 3. Migrations

| Version | File | Content | sha256 |
|---|---|---|---|
| 0019 | `0019_purchase_freight_tables.sql` | 5 tables, constraints and indexes; cycle-2 FKs `fk_flocks_purchase` / `fk_purchases_flock`; 2 fiscal deferred-FK stand-ins | `db2b657b…e4b1` |
| 0020 | `0020_purchase_supplier_rpcs.sql` | RPCs 13–17, owner postgres, EXECUTE perimeter | `ba249955…3dd5` |
| 0021 | `0021_purchase_supplier_privileges_rls.sql` | explicit reset, frozen grants, 6 policies | `67db5086…0762` |
| 0022 | `0022_purchase_rectification_version_key.sql` | **ADR-002:** `register_purchase` reserves the `RECTIFY:` prefix; `rectify_purchase` uses the bounded version key. Same signatures, owner and perimeter | `de5c6db7…a22c` |

0001–0021 are unchanged (checksums verified by the runner; 0019–0021 re-hashed identically after ADR-002), and the legacy `supabase/migrations/` directory is untouched.

## 4. Tables

All five tables are exactly as in POSTGRES_SCHEMA_SPEC_V1 Domain F (tests A1–A9). They have:

- the frozen CHECK constraints;
- `purchase_line.subtotal`, a GENERATED ALWAYS column;
- the frozen UNIQUE constraints: `purchases.idempotency_key`, `freight.idempotency_key`, `(purchase_id, storage_path)` and `(freight_id, purchase_id)`;
- the partial unique index `idx_purchases_supplier_invoice`;
- 8 indexes;
- foreign keys that are all `ON DELETE RESTRICT`;
- RLS enabled.

**Deferred references**, following the frozen dependency order:

- **Cycle 2 (flocks ↔ purchases):** `flocks` has existed since 0005 with `purchase_id` created without its FK. Once `purchases` exists both sides are present, so step 3.6 for cycle 2 runs in 0019. Both FKs exist and are validated (A10). A purchase can reference an existing flock (B9), and an unknown flock is rejected (D). No flock was invented.
- **`fiscal_document`** belongs to Phase 22 and does not exist. `purchases.fiscal_document_id` and `freight.fiscal_document_id` are plain UUID columns with stand-ins `chk_purchases_fiscal_document_fk_deferred` and `chk_freight_fiscal_document_fk_deferred` (`IS NULL`). This is the same pattern as the `sales_session` references: exactly what an FK to an empty table would enforce (A5, A11, D, Q). **The Fiscal migration must drop both CHECKs and add the frozen FKs.**

## 5. Reused supplier_ledger

`supplier_ledger` from 0015 is reused unchanged. It is the only supplier ledger/balance/account table (A13), and there is no stored balance (A14).

Phases 16 and 17 write into the same global ledger:

| Phase | Movement types |
|---|---|
| 16 | CHEQUE_ENDORSED, INSTRUMENT_ISSUED, INSTRUMENT_REJECTED, REVERSAL (ADR-001) |
| 17 | PURCHASE, PAYMENT, FREIGHT, purchase REVERSAL |

## 6. RPCs 13–17

Each RPC is a line-by-line transcription of RPC_CONTRACTS_V1 §13–§17, with the same check order, error codes, writes and return shape.

**Technical completions** (contract behaviour unchanged; each is tested):

- **NULL amounts** raise the contract's `INVALID_AMOUNT`.
- **Invalid JSON inputs:**
  - a NULL or non-array `p_attachments` raises `ATTACHMENT_REQUIRED`;
  - a NULL or non-array `p_new_lines` raises `EMPTY_LINE_SET`;
  - a NULL line quantity or price raises `INVALID_QUANTITY` / `INVALID_PRICE`.
- **Concurrent duplicates** can pass the EXISTS pre-checks and then hit a UNIQUE index. The resulting `unique_violation` is reported with the contract's own code: `DUPLICATE_PURCHASE`, `DUPLICATE_SUPPLIER_INVOICE` (mapped by constraint name), `DUPLICATE_PAYMENT` or `DUPLICATE_FREIGHT` (AA1, AA2, AA6, AA7).
- **`assign_freight_to_purchase` reads the purchase `FOR SHARE`.** Without it, an allocation racing a rectification could attach freight to a version being retired. With it, the allocation waits and then sees `PURCHASE_SUPERSEDED` (AA5).

## 7. Purchase semantics

- **Recognition:** `register_purchase` recognises the obligation at `economic_date`: one `PURCHASE +amount_total` row on the global supplier account, source `purchases/<id>` (B5, B6).
- **No money:** there is no financial operation or posting, because buying is not paying (B7).
- **Required classification:** `expense_category` and `nature` are mandatory (D).
- **Lines:** they carry a derived subtotal (B3).
- **Contract as written:** `register_purchase` does not require lines, so a service purchase with 0 lines and ≥1 attachment is accepted (B10). Line-shape rules are schema-enforced: `cantidad > 0`, `precio ≥ 0`, product/ingredient FKs, `descripcion` NOT NULL and a valid `unit_type` (D, 10 cases).
- **Audit:** `CREATE` (B8).

## 8. Attachment invariant

At least one attachment is required. A NULL, empty or non-array value raises `ATTACHMENT_REQUIRED` with nothing written (C).

- **Atomicity:** a malformed attachment that fails *after* the purchase insert rolls everything back (C2).
- **No bypass:** no application role can insert a purchase directly (C3).
- **Invariant holds:** every purchase in the database has ≥1 attachment (C4), including every rectified version (I5).
- **Rectification:** it refuses a current version with no attachment to carry forward (`ATTACHMENT_REQUIRED`, K3, via owner-only synthetic corruption).
- **Deletion:** no attachment can be deleted by any application role (Y6).
- **Storage upload itself** is outside the database contract. Only metadata is recorded.

## 9. Invoice scoping

`supplier_invoice_number` is unique per `(supplier_id, invoice)` among current versions only (A7):

- same invoice, same supplier: `DUPLICATE_SUPPLIER_INVOICE` (F1);
- same invoice, different supplier: allowed (F2);
- NULL invoices: unrestricted (F3);
- after rectification, the invoice stays with the current version (H11). The rectification of a purchase that carries an invoice succeeds only because the old version is retired first (H1–H3).

The invoice number is never the idempotency key; that remains `purchases.idempotency_key`.

## 10. Purchase rectification / versioning

Mandatory order: validate → capture → **retire** the old version → insert the new version → lines → copy attachments → re-point freight allocations → REVERSAL → new PURCHASE → audit.

- **Old version:** retired with its business fields untouched (H2).
- **New version (H3):**
  - inherits supplier, the **original** `economic_date`, category, subcategory, nature, project, invoice, flock and fiscal link;
  - the bounded key `RECTIFY:<v0 id>:v1` (ADR-002);
  - exactly the replacement lines (H4), while the old lines stay on the old version (H5);
  - the attachments carried forward (H6).
- **Ledger:** `REVERSAL −old` (source old id) and `PURCHASE +new` (source new id), both at the original date (H7). The net equals the new amount (H8), no money moves (H9), and the audit records `RECTIFY` (H10).
- **Rejections:** superseded, missing, reason, amounts, empty or NULL line set, quantity, price, product (in the second line) and ingredient all raise their contract errors before any mutation (K, 12 cases). A CLOSED original period raises `PERIOD_CLOSED` (K2).

## 11. N-pass rectification

**Evidence after ADR-002** (group IB): a purchase registered with an initial key of **exactly 100 characters** is rectified **32 times** in a row.

- The first rectification succeeds (IB1, IB2), and so do all 32 passes (IB3).
- Exactly one version is current (IB4), and `version_seq` runs 0..32 (IB5).
- **Keys:**
  - every generated key is ≤ 56 characters (IB6) and matches `^RECTIFY:<uuid>:v<n>$` (IB7);
  - each key equals `RECTIFY:<id of the previous version>:v<n>` (determinism, IB8);
  - all keys are distinct (IB9).
- **Ledger:** it telescopes to the last amount, with one REVERSAL per pass cancelling the then-current total (IB10).
- **Carry-forwards:** attachments are preserved on every version (IB11), and the invoice stays unique among current versions (IB12).

This covers the limit that failed before: under the old recursive rule, a 100-character key failed on pass 1 and a 36-character key on pass 19 (ADR-002 §2).

The original test (group I) also still holds. Three sequential passes: 100000 → 120000 → 90000 → 110000.

- Four versions (0–3), exactly one current (I1), `version_seq` +1 per pass (I2).
- Each REVERSAL cancels the then-current version: −100000, −120000, −90000. There is no double correction (I3).
- The ledger telescopes to 110000.00 (I4).
- Every version keeps ≥1 attachment (I5), and the version keys are deterministic and non-recursive: K, `RECTIFY:<v0 id>:v1`, `RECTIFY:<v1 id>:v2`, `RECTIFY:<v2 id>:v3` (I6).

## 12. Supplier ledger semantics

Signed and append-only: `+` means more debt, `−` means less. Balance = `SUM(signed_amount)`, and nothing is stored.

With mixed Phase 16 and Phase 17 history, one supplier nets to the signed sum (BB, §28).

## 13. Supplier payment semantics

A payment lands on the **global supplier account**; it is never allocated to an invoice. Paying 40000 (L1–L8) produces:

| Record | Effect |
|---|---|
| `supplier_ledger` | one `PAYMENT −40000` row, source `payment/<operation id>` |
| `financial_operation` | one `SUPPLIER_PAYMENT` operation, external_ref, source `suppliers/<id>` |
| `financial_posting` | one `−40000` posting on the chosen account |
| `audit_events` | `PAY` |

All rows share the same `effective_date`.

The purchase row is untouched (same `xmin`), and no payment references a purchase (L6, L7, E7).

## 14. Overpayment / credit

- A partial payment leaves a positive balance (M1).
- A payment larger than the debt is accepted. The balance becomes negative (−40000.00), which is a supplier credit; nothing is rejected on balance grounds (N1).

## 15. Cheque payment boundary

`pay_supplier` with CHEQUE raises `USE_ISSUE_SUPPLIER_INSTRUMENT` and writes nothing (O).

The cheque route is the Phase 16 issued instrument: `issue_supplier_instrument` reduces the same supplier's debt without moving the bank (O2).

## 16. Freight recognition

`register_freight` is the only place freight debt is recognised.

- **With a supplier:** one `FREIGHT +amount` row at `economic_date`, source `freight/<id>`. No money moves, and the audit records `CREATE` (Q1–Q5).
- **Without a supplier:** a freight row only, with no ledger entry and no posting (Q6).

## 17. Freight allocation

`assign_freight_to_purchase` creates exactly one `freight_allocation` and nothing else: no supplier_ledger, no operation, no posting (S1–S4). It returns `freight_remaining`.

- **Cap:** partial allocations up to the exact cap are allowed. One cent over raises `OVER_ALLOCATION`, atomically (T1–T3).
- **Duplicates:** a duplicate pair raises `ALREADY_ALLOCATED`, backed by UNIQUE (U1, U2).
- **Other checks:** superseded/missing purchase, missing freight and invalid amount are rejected (T).

## 18. Landed cost

Landed cost is **derived, never stored**:

```
landed_cost(purchase) = purchases.amount_total + SUM(freight_allocation.allocated_amount)
```

- 100000 + 15000 = 115000.00 (V1).
- Several freights to one purchase sum correctly: 117500.00 (V3).
- There is no landed or unit-cost column (V4, A14).
- After rectification, it follows the current version: 135000.00, then 105000.00 (W3, W5).

## 19. No-double-counting proof

1. **Purchase:** supplier purchase debt +amount (B5).
2. **Freight:** freight supplier debt +amount, once (Q3).
3. **Allocation:** neither liability changes and no money moves (V2, S3).
4. **Rectification:** carries the allocation forward without any new FREIGHT row, and the retired version has no allocation (W1–W4).
5. **End to end:** exactly one FREIGHT ledger row per freight (E9).

## 20. Period determinants

| RPC | Determinant | Evidence |
|---|---|---|
| register_purchase | `economic_date` | G1 (CLOSED), G2 (NOT_FOUND), G3 (`created_at` irrelevant) |
| rectify_purchase | the **original** `economic_date` | K2 |
| pay_supplier | `effective_date` | O1b (CLOSED), O1c (NOT_FOUND) |
| register_freight | `freight.economic_date` | Q7 |
| assign_freight_to_purchase | `freight.economic_date` | X1: CLOSED freight month refused although the purchase month is OPEN |

`created_at` never decides (G3).

## 21. Atomicity

In **J**, test-only triggers inject real failures into `rectify_purchase` at every intermediate point:

1. after the old version is retired;
2. after the new version is inserted;
3. after the lines;
4. after the copied attachments;
5. after the allocation re-point;
6. after the REVERSAL;
7. after the new PURCHASE ledger row (the audit fails).

Every case restores the original state completely: the old version is current, the ledger is intact and the allocation is on the old version. The harness is then removed.

Separately, a failing attachment rolls back a registration (C2), and every rejected call in B–Y leaves the global fingerprint unchanged.

## 22. Concurrency

Real independent PostgreSQL sessions were used. In each case B was observed waiting on a lock, and the final state stayed valid:

| Test | Race | Outcome |
|---|---|---|
| AA1 | same purchase idempotency key | `DUPLICATE_PURCHASE`; one purchase, one debt |
| AA2 | same supplier invoice | `DUPLICATE_SUPPLIER_INVOICE` |
| AA3 | freight over-allocation: A allocates 70, B allocates 70 of a 100 freight | B waits on the freight row lock, recomputes `already`, and raises `OVER_ALLOCATION`; SUM = 70 |
| AA4 | two rectifications of the same current purchase | `PURCHASE_SUPERSEDED`; one current, version 1 only |
| AA5 | rectify vs allocate | `PURCHASE_SUPERSEDED`; freight never attached to a retired version |
| AA6 | same payment external_ref | `DUPLICATE_PAYMENT`; one operation |
| AA7 | same freight key | `DUPLICATE_FREIGHT` |

## 23. Idempotency

| RPC | Key | Evidence |
|---|---|---|
| Purchase | `idempotency_key`, UNIQUE NOT NULL | E1, AA1 |
| Freight | `idempotency_key`, UNIQUE NOT NULL | Q, AA7 |
| Allocation | `UNIQUE(freight_id, purchase_id)` | U |
| Payment | `financial_operation.external_ref`, UNIQUE | P1, AA6 |

**Rectified versions (ADR-002):**

- The key is `'RECTIFY:' || <predecessor purchase id> || ':v' || version`: deterministic, at most 56 characters and unique (IB6–IB9).
- `register_purchase` rejects any caller key starting exactly with `RECTIFY:` (case-sensitive) with `RESERVED_IDEMPOTENCY_KEY`, and writes nothing (IB13, IB14).
- `rectify:…` and `X-RECTIFY:…` remain ordinary keys (IB15).

**Carry-forward (not changed silently):** the frozen `pay_supplier` contract allows a NULL `p_external_ref`, and a NULL reference is not deduplicated (P2). This is the same case already recorded for transfers (PHASE_15 §22) and for issued instruments (PHASE_16 §17). It does not block Phase 17, and it stays in the owner's transversal idempotency-key decision.

## 24. RLS

- `purchases`, `purchase_line`, `freight`, `freight_allocation`: ADMIN SELECT only.
- `purchase_attachment`: ADMIN SELECT + ADMIN INSERT, and no DELETE policy (Y11).
- OPERATOR has no policy and reads 0 rows from the five tables, `supplier_ledger` and `suppliers` (Y2).

## 25. Privileges

- **Exact ACLs (Y10):** `authenticated` has SELECT on all five tables, plus the frozen INSERT/UPDATE on `purchase_attachment`. UPDATE has no policy, so it affects 0 rows (Y9).
- **Even ADMIN has no direct DML on facts:** INSERT, UPDATE, DELETE and TRUNCATE on purchases, lines, freight, allocations, supplier_ledger, and attachment DELETE/TRUNCATE are all refused (Y6).
- **Frozen exception:** ADMIN may add an attachment (Y7); OPERATOR may not (Y8).
- **anon and service_role:** no access (Y4, Y5).
- **Default privileges** have been clean since 0013. 0021 still resets explicitly.

## 26. SECURITY DEFINER

- **Inventory:** 21 functions, i.e. the previous 16 plus RPCs 13–17 (Z1). 0022 replaces RPCs 13 and 14 in place, so the count is unchanged, and the owner (postgres) and ACL (`postgres`, `authenticated`) are verified unchanged.
- **Hardening of each RPC:** SECURITY DEFINER, `search_path = public`, owner postgres, no PUBLIC entry; EXECUTE for authenticated only, not anon or service_role (Z2).
- **Actor and role:** no parameter names the actor or the role (Z3).

## 27. Audit

| RPC | Audit action | Evidence |
|---|---|---|
| register_purchase | `CREATE` (purchases) | B8 |
| rectify_purchase | `RECTIFY`, with before/after, new id and reason | H10 |
| pay_supplier | `PAY` (suppliers) | L8 |
| register_freight | `CREATE` (freight) | Q5 |
| assign_freight_to_purchase | `ALLOCATE` (freight_allocation) | S4 |

All go into the transversal `audit_events`; there is no parallel audit table.

## 28. Phase 16 integration

One supplier with mixed history:

| Movement | Amount |
|---|---|
| PURCHASE | +100000 |
| PAYMENT | −30000 |
| INSTRUMENT_ISSUED | −20000 |
| INSTRUMENT_REJECTED | +20000 |
| FREIGHT | +10000 |

These are all in one ledger (BB1), and the balance is the signed sum 80000.00 (BB2). Phase 16 suites still pass: 200/200.

## 29. E2E

**Slice 2** (E1–E7):

| Step | Supplier A | Supplier B | BNA | Landed cost |
|---|---|---|---|---|
| Opening | 0 | — | 0 | — |
| Purchase 100000 | 100000 | — | unchanged | — |
| Pay 40000 | 60000 | — | −40000 | — |
| Freight 15000 (supplier B) | 60000 | 15000 | unchanged | — |
| Allocate 15000 to the purchase | 60000 | 15000 | unchanged | 115000 |
| Pay 60000 | 0 | 15000 | −100000 | — |

The two payments reference the supplier, never the purchase (E7).

**Rectification** (E8–E10): purchase 100000 with 15000 freight allocated → rectify to 120000.

- The liability nets to 120000.00.
- Freight debt is unchanged, with exactly one FREIGHT row.
- The allocation follows the current version, and landed cost is 135000.00.

## 30. Automated tests

`scripts/target-db/purchases.test.mjs` has **216 assertions**:

| Group | Assertions | Group | Assertions |
|---|---|---|---|
| A structure | 15 | Q register freight | 13 |
| B register | 10 | S allocate | 4 |
| C attachment | 7 | T over-allocation | 9 |
| D validation | 19 | U duplicate allocation | 2 |
| E idempotency | 1 | V landed cost | 4 |
| F invoice scope | 3 | W rectification + freight | 5 |
| G period | 3 | X closed freight period | 1 |
| H rectification | 11 | Y security | 17 |
| I N passes | 6 | Z definer | 3 |
| IB ADR-002 bounded key / 32 passes / reserved prefix | 17 | | |
| J atomicity | 8 | AA concurrency | 7 |
| K rectify errors | 15 | BB Phase 16 integration | 2 |
| L pay supplier | 8 | E2E | 10 |
| M / N partial & overpayment | 2 | ZZ cleanup | 2 |
| O cheque boundary + payment validation/period | 10 | | |
| P payment idempotency | 2 | | |

The suite passes on re-run. Its synthetic `P17-TEST` fixtures (including an owner-created shed/flock and owner-only corruption fixtures) are removed at start and end, and the periods it closed are reopened.

## 31. Regression

| Suite | Result |
|---|---|
| `apply.test.mjs` | 27 / 0 |
| `foundations.test.mjs` | 96 / 0 |
| `commercial.test.mjs` | 147 / 0 |
| `treasury.test.mjs` | 107 / 0 |
| `instruments.test.mjs` | 200 / 0 |
| `purchases.test.mjs` | 216 / 0 |
| `guard.test.mjs` | 35 / 0 |

Only exact structural inventories changed; no behavioural assertion changed:

- **foundations:** the later-phase tables (+5) and definers (+5).
- **commercial I1, treasury H1, instruments Q1:** the definer inventory (21).
- **treasury A2:** later-phase tables (+5).

## 32. Clean rebuild

Final rebuild, after ADR-002:

```
before              → public tables=31, ledger=22
guard               → target proven local; cli argv proven local-only → supabase db reset
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0
rebuild             → 22 files, 0 already applied → +0001 … +0022 → ledger holds 22
re-run apply.mjs    → applied 0 new migration(s); ledger now holds 22
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107,
                      instruments 200/200, purchases 216/216, guard 35/35
```

Earlier rebuild (0001→0021, ledger 21, purchases 197/197, then 199/199 after O1b/O1c) is superseded by the one above.

No manual step or Studio action was needed. At the end, Supabase local was stopped.

## 33. Production isolation

- **Production:** not contacted.
- **Remote project-ref:** not used.
- **Commands never run:** `db push`, `--linked`, `link` and `unlink`.
- **Targets:** every SQL operation was direct-URL against the guarded loopback target, and the reset passed the CLI argv guard.
- **Credentials:** production credentials were unset. No secret was printed.
- **Data:** no production data was used.

## 34. Deferred

- **Fiscal (Phase 22):** `fiscal_document`, and replacing the two stand-in CHECKs on `purchases.fiscal_document_id` / `freight.fiscal_document_id` with the frozen FKs.
- **Production (Phase 18):** the RPCs that set `flocks.purchase_id` / `purchases.flock_id` links. The cycle-2 FKs already exist.
- **Transversal internal idempotency key:** the owner's carry-forward. It now also covers `pay_supplier` with a NULL `external_ref`.
- **`financial_instrument.source_collection_id`:** unchanged.
- **Freight / purchase versioning of freight:** there is no frozen RPC that supersedes a freight row, so `FREIGHT_SUPERSEDED` is unreachable by application paths (the contract branch exists).
- Frontend and real-data migration.

## 35. Frozen contradictions

**None open.**

- **Resolved by ADR-002 (ACCEPTED): the rectified-purchase version key.**
  - **Problem:** `POSTGRES_SCHEMA_SPEC_V1` caps `purchases.idempotency_key` at `VARCHAR(100)`, while `RPC_CONTRACTS_V1` §14 concatenated the previous key on every pass. A 100-character key therefore failed on pass 1 and a 36-character key on pass 19.
  - **Decisions:** D1 bounded version key `'RECTIFY:' || <predecessor id> || ':v' || version`; D2 reserved `RECTIFY:` prefix.
  - **Implementation:** migration 0022 and FROZEN amendments marked **[ADR-002]**.
  - **Proof:** test group IB, a 100-character key rectified 32 times.
  - **Unaffected:** the transversal financial-operation idempotency carry-forward (PHASE_15 §22).

- `register_purchase` not requiring lines, and `register_freight` not validating supplier activity, are the contracts as written. They are documented, not changed.
- The cycle-2 FKs were added at the moment both tables exist, exactly as step 3.6 prescribes.

## 36. Exit criterion evidence

| Part of the criterion | Status | Evidence |
|---|---|---|
| Slice 2 runs end to end | **MET** | E1–E10 |
| Liability recognised at `economic_date` on the global supplier account | **MET** | B5, B6, G3, H7, BB |
| Attachment mandatory | **MET** | C1–C4, I5, K3, Y6 |
| Payments unallocated to invoices | **MET** | L6, L7, E7, A15 |
| Freight recognised once | **MET** | Q3, Q6, W2, E9 |
| …and allocated without double counting | **MET** | S3, T, U, V2, W1–W4 |
| Landed cost derives correctly | **MET** | V1, V3, V4, W3, W5, E5, E10 |
| Rectification correct across repeated passes | **MET** | H, I, K, J, W5; **arbitrary N after ADR-002: IB1–IB12** (100-character key, 32 passes, keys ≤ 56, deterministic, unique, ledger telescopes) |
| Security | **MET** | Y, Z |
| Atomicity / concurrency | **MET** | J, AA |
| Regression, clean rebuild, production untouched | **MET** | §31–§33 |

## 37. Phase status

**PHASE 17 — PURCHASES / SUPPLIERS: COMPLETE** (evidence in §30–§32 and §36).

The ADR-002 blocker is withdrawn. N-pass rectification is **MET** again, on the new IB evidence, for a 100-character initial key and 32 passes with bounded keys.

MASTER_ROADMAP.md was deliberately left unchanged, with Phase 17 = **CURRENT** until the external review. Phase 18 was not started.
