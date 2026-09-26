# PHASE 22 — FISCAL

**STATUS:**
- The exit criterion is **MET** on mechanical evidence (§30–§32, §37).
- Both open design points were resolved by owner decisions on 2026-09-25:
  - Pedido ↔ fiscal_document: no direct link in V1 (§22, §36.1);
  - installment ownership, applied by migration 0038 (§19, §36.2).
- MASTER_ROADMAP.md is unchanged, and Phase 22 stays **CURRENT** until external review.

**DATE:** 2026-09-25

**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, container `supabase_db_Claudio_app_Granja`, PostgreSQL 17.6).

**AUTHORITIES:** all FROZEN, as amended by ADR-001 and ADR-002. None was modified.
- MASTER_ROADMAP.md (sequence)
- TARGET_ARCHITECTURE_V2_FROZEN.md: Parts 18, 20, 24
- RPC_CONTRACTS_V1: §13, §16 (purchase / freight fiscal reference) and §34–§36
- POSTGRES_SCHEMA_SPEC_V1: Domains F and K
- RLS_IMPLEMENTATION_SPEC_V1: §4, §9, §10
- DATABASE_INVARIANTS_V1: §12, §17, §25
- IMPLEMENTATION_DEPENDENCY_ORDER_V1: steps 2.4, 2.14

---

## 1. Exact exit criterion

> Fiscal documents with tax components at snapshotted rates, obligations, installments and payments — without duplicating any economic operation.

## 2. Scope

**Built:**
- tables `fiscal_document`, `fiscal_document_component`, `fiscal_obligation`, `fiscal_obligation_installment`, `fiscal_payment`;
- RPCs 34–36;
- the frozen FKs `purchases.fiscal_document_id` and `freight.fiscal_document_id`.

**Reused:**
- tables: `suppliers`, `clients`, `financial_account`, `financial_operation`, `financial_posting`, `purchases`, `freight`, `pedidos` (read-only check), `perfiles`, `management_period`, `audit_events`;
- functions: `current_app_role()`, `assert_period_open()`, and `register_purchase` / `register_freight` (for the links).

**Not built:**
- Mercado Pago, ARCA integration, automatic rate lookup, legal filing;
- frontend, tax engine, parallel ledger, manual P&L;
- RPC 23/24;
- a Pedido → fiscal_document link: the owner decision says V1 has none (§22).

## 3. Migrations

| Version | File | Content | sha256 |
|---|---|---|---|
| 0035 | `0035_fiscal_tables.sql` | 5 tables, CHECKs / UNIQUEs / FKs / 4 indexes (incl. the frozen partial UNIQUE per supplier); drops the two 0019 stand-ins; adds `purchases_fiscal_document_id_fkey` and `freight_fiscal_document_id_fkey` | `f3c9bac7…bb7d` |
| 0036 | `0036_fiscal_rpcs.sql` | RPCs 34–36, owner postgres, EXECUTE perimeter | `3028c383…071f` |
| 0037 | `0037_fiscal_privileges_rls.sql` | explicit reset, SELECT grant, 5 ADMIN policies | `894a263d…064a` |
| 0038 | `0038_fiscal_installment_ownership.sql` | owner decision: RPC 36 redefined with the installment ownership check; the only change from 0036 | `6393671d…5e65` |

- 0001–0037 are unchanged: the runner verified their checksums, and 0032–0037 re-hash identically.
- Applied migrations are immutable, so the correction of RPC 36 enters as the new migration 0038, the same pattern as ADR-001 → 0018 and ADR-002 → 0022. 0036 was not edited.
- Legacy migrations are untouched.
- No migration is empty.

## 4. Reused objects

- **Master data:** suppliers and clients must already exist; no master is ever created (B7).
- **Economic links:** purchases and freight reference fiscal documents through their existing frozen RPCs (`p_fiscal_document_id`, L2, L5).
- **Money:** fiscal payments use `financial_operation` / `financial_posting` with type `FISCAL_PAYMENT` (F1).

## 5. Tables

All five tables match frozen Domain K exactly:
- columns (A2);
- CHECK / UNIQUE constraints (A3): fiscal period is a month start, the counterparty matches the direction, amounts ≥ 0, rates ≥ 0, installment number > 0, idempotency key unique;
- FKs, all RESTRICT (A4);
- indexes (A5);
- RLS enabled (A6).

There is no tax-rate table; the only rate column is `rate_applied` (A8).

## 6. Document semantics

- **Direction:** CREDITO = received, which requires a supplier; DEBITO = issued, which requires a client (B1, B2, B5). The counterparty is never inferred from the document type.
- **Rejections:**
  - OPERATOR → `FORBIDDEN` (B4);
  - a negative amount fails the frozen CHECK (B6);
  - a nonexistent supplier fails the FK (B7).
- **Storage:** the document is stored exactly as supplied (B1).
- **Components:** no component count is invented; `[]` is accepted, giving `component_count` 0 (B11).

## 7. Component snapshots

- **Exact storage:** components are stored as supplied, several tax kinds per document (C1).
- **Historical rates:** IVA **10.5000** (document A) and IVA **21.0000** (document B) coexist, and neither is "corrected" (C2). Document A still holds 10.5000 after later documents with other rates (C6).
- **No recomputation:** `tax_amount` is the recorded value. For example, 1000 × 21 % = 210, but a recorded 209.99 stays 209.99 (C3). The FROZEN set defines no arithmetic invariant, so none was invented.
- **Checks:** base, rate or tax below zero fails the frozen CHECK, and the whole document rolls back (C4). An unknown `tax_kind` is rejected by the enum (C5).

## 8. RPC 34 `register_fiscal_document`

The contract is transcribed line by line, with the exact signature (M3).

- **Actor and validation:** ADMIN only. `SUPPLIER_REQUIRED` / `CLIENT_REQUIRED` / `INVALID_FISCAL_PERIOD`, then `assert_period_open(document_date)`, then the duplicate pre-check.
- **Writes:** the document, then its components exactly as supplied, then the audit.
- **Returns:** `{fiscal_document_id, component_count}`.

**Technical completions** (behaviour unchanged):
- a NULL `fiscal_period` → `INVALID_FISCAL_PERIOD`;
- a concurrent duplicate that hits the frozen UNIQUE index → `DUPLICATE_FISCAL_DOCUMENT` (K2).

## 9. No economic duplication

**What the fiscal layer does not create:**
- RPC 34 and RPC 35 create no purchase, freight, Pedido, supplier or client ledger movement, collection, operation or posting (B3, D2, E2, L1, L6).
- The economic snapshot compares row counts and ledger sums before and after.

**Purchase E2E:**
- The purchase (242000) references the fiscal document.
- The supplier ledger has **exactly one** +242000 entry, from the purchase (L3, N1, N6).
- Fiscal tables hold no economic columns, and nothing references a component (L7).

The only fiscal money movement is RPC 36 (§15).

## 10. Duplicate document rule

**Frozen rule:** `(supplier_id, external_number)` must be unique when both are non-NULL. It is **per supplier, never global** (invariant 25).

- **Sequential duplicate** → `DUPLICATE_FISCAL_DOCUMENT` (B5).
- **Allowed:** the same number for another supplier, and documents without an external number (B9).
- **Concurrent duplicate:** the frozen partial UNIQUE index `idx_fiscal_document_supplier_number` is the physical backstop. Two documents with document dates in different months (so no shared period lock) both pass the pre-check; B waits on the index, then gets `DUPLICATE_FISCAL_DOCUMENT`, and one document survives (K2).
- No uniqueness beyond the contract was added.

## 11. Obligation semantics

- A fiscal obligation is the tax payable for `(tax_kind, fiscal_period)`: `amount > 0`, `UNIQUE(tax_kind, fiscal_period)`, fiscal period is a month start (A3).
- It is created as `PENDING` (D1).
- `status` is materialised bookkeeping that **only** RPC 36 changes. No application role holds UPDATE (F11, H3).

## 12. RPC 35 `register_fiscal_obligation`

- **Actor:** ADMIN only (D3).
- **Rejections:** `INVALID_AMOUNT` (0, negative, NULL); `INVALID_FISCAL_PERIOD` (15th of the month, NULL); `DUPLICATE_OBLIGATION` (D4). All rejections are atomic (D5).
- **Allowed:** the same period for another tax kind (D6).
- **Audit:** CREATE (D7).
- **Returns:** `{obligation_id, installment_count}`.
- **Concurrent duplicate:** the loser waits on the period lock, then gets `DUPLICATE_OBLIGATION`; the unique violation is mapped to that code (K1).

## 13. Installments

An installment plan splits the obligation; it creates no posting or other liability (E2). Three installments that sum exactly are accepted (E1).

Each of these is rejected, leaving **no obligation and no partial plan** (E3):
- `INSTALLMENT_MISMATCH`: the sum differs from the amount, or the list is empty (sum 0);
- the frozen UNIQUE on `(obligation, installment_number)`;
- the CHECK on the amount;
- the CHECK on `installment_number`;
- the NOT NULL on `due_date`.

## 14. Payment semantics

Each payment is one real money outflow:
- one `FISCAL_PAYMENT` operation (`external_ref` = idempotency key, source `fiscal_obligation`/id, dated `effective_date`);
- **one** −amount posting on the chosen account;
- one `fiscal_payment` row (F1, F2).

BNA moved by exactly the payments, and the supplier and client ledgers were untouched (F9).

## 15. RPC 36 `pay_fiscal_obligation`

Transcribed with the exact signature. The order of operations is:
1. ADMIN check, `INVALID_AMOUNT`, `DUPLICATE_PAYMENT` pre-check.
2. Obligation row lock (`FOR UPDATE`): `OBLIGATION_NOT_FOUND` / `ALREADY_PAID` / `OBLIGATION_CANCELLED`.
3. Period check.
4. Paid-so-far read and `OVERPAYMENT` check.
5. **Owner decision (0038):** if `p_installment_id` is supplied, it must belong to `p_obligation_id`, else `INSTALLMENT_NOT_FOUND_OR_MISMATCH`. This check runs before any write.
6. Operation, then posting, then payment, then status update, then audit.

**Returns:** `{payment_id, financial_operation_id, obligation_status}`.

**Other rejections**, all with nothing written: OPERATOR, missing account (FK), NULL date (`BUSINESS_DATE_REQUIRED`), NULL key (NOT NULL) (F8).

## 16. Payment idempotency

`fiscal_payment.idempotency_key VARCHAR(100) UNIQUE NOT NULL`.
- A sequential retry → `DUPLICATE_PAYMENT`, with nothing written (F6).
- A concurrent retry: B waits on the obligation lock, then gets `DUPLICATE_PAYMENT`. Exactly **1** payment, **1** operation and **1** posting remain (K3).

The unique violation on `financial_operation.external_ref` or `fiscal_payment.idempotency_key` maps to `DUPLICATE_PAYMENT`.

## 17. Overpayment

`paid_so_far = SUM(fiscal_payment.amount)`, read after the obligation lock.

**Sequential cases:**
- obligation 100000: pay 40000 → `PARTIALLY_PAID` (F1); pay 60000 → `PAID` (F3); a third payment → `ALREADY_PAID` (F4);
- 70000 then 40000 → `OVERPAYMENT`, nothing written, status stays `PARTIALLY_PAID` (F5).

**Concurrent cases:**
- 50000 + 30000 → both applied in order, 90000 paid, `PARTIALLY_PAID` (K4);
- two final payments → A sets `PAID`, B gets `ALREADY_PAID` (K5);
- two payments whose sum would exceed the remainder → B gets `OVERPAYMENT`; postings equal payments, 90000 (K6).

## 18. Status lifecycle

`PENDING → PARTIALLY_PAID → PAID`, changed only inside RPC 36 (F1, F3, F11).

- `CANCELLED` blocks payment (`OBLIGATION_CANCELLED`, F7). No frozen RPC sets CANCELLED; the test uses an owner fixture.
- `created_at` never decides the status.

## 19. Installment linking — RESOLVED BY OWNER DECISION

**Owner decision (2026-09-25).** If RPC 36 receives `p_installment_id IS NOT NULL`, that installment **must belong to** `p_obligation_id`:
`SELECT fiscal_obligation_id FROM fiscal_obligation_installment WHERE id = p_installment_id` must equal `p_obligation_id`.
A payment for obligation A that carries an installment of obligation B is not allowed. The rule protects integrity and traceability.

**Implementation (0038):** RPC 36 raises `INSTALLMENT_NOT_FOUND_OR_MISMATCH` for a nonexistent installment or one that belongs to another obligation. The check runs before any operation, posting, payment, status change or audit.

**Deliberately not added**, per the owner decision:
- installment status;
- installment balance;
- a per-installment overpayment rule;
- an obligation to pay a full installment;
- a required installment order.

The amount control stays **only at obligation level**.

**Evidence:**

| Test | Case | Result |
|---|---|---|
| G1 (A) | installment of the same obligation | success; link stored, status computed at obligation level |
| G2 (B) | installment of another obligation | `INSTALLMENT_NOT_FOUND_OR_MISMATCH`; no operation, posting, payment, status change or audit; balance and both obligations intact |
| G3 (C) | nonexistent installment | `INSTALLMENT_NOT_FOUND_OR_MISMATCH`, raised before any write (no longer the FK); full rollback |
| G4 | 40000 against a 30000 installment of the same obligation | accepted, because 70000 ≤ 90000 (amount control stays obligation-level); no installment status or balance column exists |
| G5 | valid link, but over the obligation cap | `OVERPAYMENT` |
| G6 (D) | `p_installment_id` NULL | still allowed; the remainder is paid and the obligation becomes `PAID` |

Partial payments, `PENDING → PARTIALLY_PAID → PAID`, idempotency and concurrency are unchanged: groups F and K pass unmodified.

## 20. Periods

| RPC | Write determinant | CLOSED | Missing |
|---|---|---|---|
| 34 | `document_date` | `PERIOD_CLOSED` (I1) | `PERIOD_NOT_FOUND` (I4) |
| 35 | `fiscal_period` | `PERIOD_CLOSED` (I1) | `PERIOD_NOT_FOUND` (I4) |
| 36 | `effective_date` | `PERIOD_CLOSED` (I1) | `PERIOD_NOT_FOUND` (I4) |

- Rejections write nothing (I2).
- For RPC 34, `fiscal_period` is the tax-reporting period, not the write determinant. A May document for the CLOSED March tax period is accepted and stored with `fiscal_period` 2026-03-01 (I3).
- `created_at` is irrelevant: with the current month CLOSED, dates in OPEN months are accepted (I5).

## 21. Fiscal period

- Always a month start: `2026-05-15` → `INVALID_FISCAL_PERIOD` (B5, D4). The frozen CHECKs back this up.
- Stored exactly as supplied and never inferred from `document_date`.
- It may differ from the document month: a document dated 2026-05-03 with fiscal period 2026-04-01 is valid (B10).

## 22. Economic-fact linking

**Purchases and freight — resolved.** They were scheduled for this phase by 0019 and the dependency order:
- the stand-ins are dropped and the frozen FKs added (A7);
- the link is made through the frozen RPCs `register_purchase` / `register_freight` via `p_fiscal_document_id` (L2, L5, N1);
- a dangling reference is impossible (L4, L5);
- no join table was created.

The frozen model has **no** post-hoc linking path: `purchases` / `freight` have no UPDATE privilege, and `rectify_purchase` carries the old value forward. The fiscal document is therefore registered first and referenced when the purchase or freight is recorded, as in the E2E.

**Pedidos — RESOLVED BY OWNER DECISION (2026-09-25): no direct link in V1.**
- V1 has **no** `pedidos.fiscal_document_id` → `fiscal_document` relation. No column, FK, join table or linking RPC was added (A9).
- The V1 rule:
  - `purchases` may reference `fiscal_document`;
  - `freight` may reference `fiscal_document`;
  - `pedidos` has no `fiscal_document_id`.
- The RPC_CONTRACTS_V1 §34 sentence "the economic obligation lives in purchases / pedidos, which merely reference fiscal_document_id" is **documentation drift** as far as `pedidos` is concerned. POSTGRES_SCHEMA_SPEC_V1, IMPLEMENTATION_DEPENDENCY_ORDER_V1 and the RPC interfaces are consistent with each other and contain no such link. The FROZEN text was not edited now.
- A client's DEBITO fiscal document is still valid through `fiscal_document.cliente_id` (B2, L6). It is not associated directly with a Pedido in V1.
- Any future Pedido ↔ fiscal document relation will be designed explicitly in a later version, not improvised in Phase 22.

## 23. RLS

Exactly as in RLS §9: one ADMIN SELECT policy per table (H5).
- ADMIN reads all five tables (H1).
- OPERATOR sees nothing (H2).

## 24. Privileges

- `authenticated` has SELECT only (H4).
- No direct INSERT / UPDATE / DELETE / TRUNCATE for ADMIN or OPERATOR (H3).
- `anon` and `service_role` get no SELECT and no EXECUTE (H6).
- UUID keys only, so there are no sequences.

## 25. SECURITY DEFINER

- 38 functions: the previous 35 plus RPCs 34–36 (M1).
- Each is DEFINER, `search_path=public`, owner postgres, no PUBLIC grant, EXECUTE for authenticated only (M2).
- Signatures are exact, with no actor parameters (M3).

## 26. Atomicity

Test-only triggers (schema `p22_harness`) inject 14 failures (J1).

| RPC | Injection points |
|---|---|
| 34 | after the document insert; first component; later component; audit |
| 35 | after the obligation insert; first installment; later installment; mismatch; audit |
| 36 | at the operation; after the operation, at the posting; at the payment row; at the status update; at the audit |

- Each rolls back fully: no partial document, plan or payment, and **no money movement without a payment/status, nor a payment/status without money** (J1, J2).
- The harness is removed afterwards (J3).

## 27. Concurrency

Real independent PostgreSQL sessions (K1–K6):

| Race | Outcome |
|---|---|
| duplicate obligation | loser gets `DUPLICATE_OBLIGATION` |
| duplicate document (via the UNIQUE backstop) | loser gets `DUPLICATE_FISCAL_DOCUMENT` |
| same payment key | loser gets `DUPLICATE_PAYMENT`, 1 / 1 / 1 |
| two payments | serialised, 90000 `PARTIALLY_PAID` |
| two final payments | `PAID` then `ALREADY_PAID` |
| sum over the remainder | loser gets `OVERPAYMENT` |

## 28. Audit

| Entity | Action | after_values |
|---|---|---|
| fiscal_document | CREATE | document_type, direction, fiscal_period, total_amount (B12) |
| fiscal_obligation | CREATE | tax_kind, fiscal_period, amount (D7) |
| fiscal_obligation | PAY | before: status, paid_so_far; after: status, payment (F10) |

Every event records the reason and the real actor. Failed calls leave no audit (J).

## 29. E2E

1. **Supplier invoice registered first.** Invoice A-0009-00000001, July 2026, net 200000, total 242000, IVA crédito 21.0000 = 42000 (N2).
2. **Economic purchase recorded** (242000), referencing the fiscal document through `register_purchase`. The supplier ledger shows exactly one +242000, from the purchase (N1).
3. **July IVA obligation.** 30000, `PENDING`, with a 2-installment plan of 18000 + 12000 (N3).
4. **Installment 1 paid** from BNA (18000) → `PARTIALLY_PAID`.
5. **Installment 2 paid** (12000) → `PAID` (N4).
6. **BNA** moved exactly −30000, in two `FISCAL_PAYMENT` operations (N5).
7. **No duplicate economic event** (N6).

## 30. Automated tests

`scripts/target-db/fiscal.test.mjs` has **132 assertions**:

| Group | Assertions |
|---|---|
| A structure | 9 |
| B documents | 17 |
| C components | 8 |
| D obligations | 12 |
| E installments | 8 |
| F payments | 17 |
| G installment link (owner decision) | 6 |
| H RLS / privileges | 6 |
| I periods | 9 |
| J atomicity | 16 |
| K concurrency | 6 |
| L no duplication / links | 7 |
| M definer | 3 |
| N E2E | 6 |
| Z cleanup | 2 |

- The suite passes on re-run: 130/0 twice at the first rebuild, then 132/0 twice in the second clean rebuild after the owner-decision tests were added.
- Fixtures are named `P22-TEST …`, and obligations are identified by the test ADMIN as creator. Only this suite writes the fiscal tables.

## 31. Regression

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
| `feed.test.mjs` | 176 / 0 |
| `feria.test.mjs` | 142 / 0 |
| `fiscal.test.mjs` | 132 / 0 (twice) |
| `guard.test.mjs` | 35 / 0 |

Earlier suites changed only in exact structural inventories; no behavioural assertion was weakened:
- **Definer inventory (38)** updated in commercial, treasury, instruments, purchases, production, classification, feed and feria. In foundations, `LATER_PHASE_DEFINERS` +3.
- **Later-phase tables (+5)** in foundations and treasury.
- **purchases:**
  - A5: the two fiscal stand-ins are replaced by the FKs;
  - A9: the FK inventory now includes the 2 fiscal_document FKs;
  - A11: fiscal_document now exists with validated FKs;
  - D / Q cases: same behaviour — a dangling `fiscal_document_id` is still rejected — now asserted through the real frozen FKs.

## 32. Clean rebuild

```
before              → public tables=49, ledger=38
guard               → target proven local; cli argv proven local-only → supabase db reset (stack freshly restarted first)
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0, views=0
rebuild             → 38 files, 0 already applied → +0001 … +0038 → ledger holds 38; public tables = 49
re-run apply.mjs    → applied 0 new migration(s); ledger now holds 38 (0001..0038)
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107, instruments 200/200,
                      purchases 216/216, production 149/149, classification 75/75, feed 176/176, feria 142/142,
                      fiscal 132/132 (twice), guard 35/35
checksums           → 0032–0037 unchanged (0035 f3c9bac7…bb7d, 0036 3028c383…071f, 0037 894a263d…064a); 0038 6393671d…5e65; legacy untouched
```

This block is the **second** full clean rebuild, run after migration 0038 for the owner decisions. The first rebuild (0001..0037, fiscal 130/130) also passed.

No manual step and no Studio action. Supabase local was stopped at the end.

## 33. Production isolation

- Production was not contacted, and the remote project-ref was not used.
- No `db push`, `--linked`, `link` or `unlink`.
- All SQL went direct-URL to the guarded loopback target, and the reset passed the CLI argv guard.
- Production credentials were unset, and no secret was printed.
- No production data was used.

## 34. RPC 23/24 deferred

RPC 23 `register_flock_weighing` and RPC 24 `register_temperature_record` remain **UNASSIGNED**. They were not implemented, not assigned to Fiscal, and Phase 18 was not edited.

## 35. Other deferred

- **Future Pedido ↔ fiscal document relation:** out of V1 by owner decision; to be designed explicitly in a later version (§22).
- **Obligation cancellation:** no frozen RPC sets `CANCELLED`, and none was invented.
- **Later phases:** Mercado Pago (23), frontend, real-data migration.
- **Existing carry-forwards:** transversal financial idempotency key, `source_collection_id`.

## 36. Frozen contradictions

**1. Pedido → fiscal_document: RESOLVED BY OWNER DECISION (2026-09-25).**
- Contradiction: RPC_CONTRACTS_V1 §34's prose says `pedidos` reference `fiscal_document_id`, but the schema, the dependency order and the RPC interfaces have no such link.
- Decision: V1 has **no** direct Pedido ↔ fiscal document link. The §34 sentence is documentation drift for `pedidos`.
- No SQL change for this point: no column, FK, join table or RPC. The FROZEN documents were not modified now. A client's DEBITO document stays valid through `cliente_id` (§22).

**2. Installment ↔ obligation ownership: RESOLVED BY OWNER DECISION (2026-09-25).**
- Decision: a supplied installment must belong to the obligation being paid.
- Implemented in RPC 36 by migration 0038 with `INSTALLMENT_NOT_FOUND_OR_MISMATCH`, checked before any write.
- No installment status, balance, per-installment overpayment or ordering rule was added. The amount control stays obligation-level (§19, G1–G6).

**3. No other contradiction.**
- Component arithmetic is not frozen, so none was validated (§7).
- The duplicate-document race has a frozen physical backstop (§10).
- The purchase / freight FK timing is frozen and resolved here (§22).

## 37. Exit criterion evidence

| Requirement | Status | Evidence |
|---|---|---|
| Fiscal documents | **MET** | B1–B12 |
| Tax components at snapshotted rates | **MET** | C1–C6, N2 |
| Obligations | **MET** | D1–D7 |
| Installments | **MET** | E1–E3, N3 |
| Payments (money outflow, idempotent, no overpayment, status) | **MET** | F1–F11, K3–K6, N4, N5 |
| Without duplicating any economic operation | **MET** | B3, D2, E2, L1–L7, N1, N6 |
| Periods / fiscal period | **MET** | I, B5, B10, D4 |
| RLS / privileges / definer | **MET** | H, M |
| Atomicity / concurrency | **MET** | J, K |
| Purchase / freight links | **MET** | A7, L2–L5 |
| Pedido link | **RESOLVED: no link in V1 (owner decision)** | §22, §36.1, A9 |
| Installment ownership | **MET (owner decision, 0038)** | §19, G1–G6 |
| Regression, clean rebuild, production untouched | **MET** | §31–§33 |

## 38. Status

**PHASE 22 — FISCAL: COMPLETE.** The exit criterion is met, and both open design points are resolved by owner decision (§36.1, §36.2).

MASTER_ROADMAP.md was deliberately left unchanged: Phase 22 = **CURRENT** until external review. Phase 23 was not started.
