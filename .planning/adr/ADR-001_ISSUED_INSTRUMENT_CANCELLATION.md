# ADR-001 — Cancellation of issued instruments (ISSUED → CANCELLED)

**STATUS:** **ACCEPTED** (owner approval, 2026-09-25). D1, D2 and D3 are approved, with the clarifications recorded in §10. It is implemented by the FROZEN amendments listed in §8 (each marked **[ADR-001]**) and by migration `0018_issued_instrument_cancellation.sql`.
**HISTORY:** PROPOSED 2026-09-25 → ACCEPTED 2026-09-25.
**DATE:** 2026-09-25
**RAISED BY:** external review of Phase 16. This is the only blocker for closing Phase 16.
**AFFECTS (FROZEN):** RPC_CONTRACTS_V1, DATABASE_INVARIANTS_V1, POSTGRES_SCHEMA_SPEC_V1, IMPLEMENTATION_DEPENDENCY_ORDER_V1, RLS_IMPLEMENTATION_SPEC_V1

---

## 1. Context — the contradiction

The FROZEN authorities disagree on whether an issued instrument can be cancelled.

**Frozen sources that define the transition:**

| Source | Text |
|---|---|
| `TARGET_ARCHITECTURE_V2_FROZEN.md`, "Issued Cheque" | States `ISSUED → DEBITED` "**With cancellation/rejection when necessary.**" |
| `DATABASE_INVARIANTS_V1.md` §18, line 277 | Issued direction: `ISSUED → CANCELLED` |
| `POSTGRES_SCHEMA_SPEC_V1.md` line 66 | `instrument_estado` includes `'CANCELLED'` ("terminal, both directions") |
| `POSTGRES_SCHEMA_SPEC_V1.md` line 589 | `chk_instrument_estado_direction` allows `CANCELLED` for `direction = 'ISSUED'` |

**Frozen sources that provide no way to execute it:**

| Source | Text |
|---|---|
| `RPC_CONTRACTS_V1.md` | "**RPC COUNT: 41**" and "RPC INVENTORY (EXACT)", rows 1–41. No RPC writes `CANCELLED` to `financial_instrument`. The only `'CANCELLED'` literals in the document belong to `cancel_order` (pedidos) and fiscal obligations. |
| `IMPLEMENTATION_DEPENDENCY_ORDER_V1.md` §5.1 | "Issued instruments \| 10 · 11 · 12" and "**Total: 41.**" |
| `RLS_IMPLEMENTATION_SPEC_V1.md` §4, §10 | Instrument tables are writable by "RPC 5–12 only". Application roles hold no write privilege, so no other path exists. |

**Why it blocks Phase 16:** `MASTER_ROADMAP.md` Phase 16 requires "Received and **issued lifecycles complete**". The issued state machine has a transition that nothing can execute, so that part of the exit criterion cannot be met as frozen. Phase 16 correctly implemented only RPCs 10–12 and did not invent a transition.

**Second gap found while confirming the first:**

- `financial_instrument` has one business-date column per lifecycle step (`received_date`, `deposited_date`, `cleared_date`, `endorsed_date`, `issued_date`, `debited_date`, `rejected_date`), but **no `cancelled_date`**. (The `cancelled_date` at `POSTGRES_SCHEMA_SPEC_V1.md` line 369 belongs to `pedidos`.)
- The period matrix (`DATABASE_INVARIANTS_V1.md` §12) has no row for an instrument cancellation.
- A cancellation therefore has no frozen period determinant column. This ADR resolves that as decision D3.

## 2. Decision summary (ACCEPTED)

| # | Decision | Recommendation |
|---|---|---|
| D1 | How the transition becomes executable | Add **RPC 42 `cancel_supplier_instrument`**. RPCs 1–41 stay exactly as they are. |
| D2 | Supplier-ledger movement type | Reuse the existing **`REVERSAL`** with `reversal_of_id` → the instrument's `INSTRUMENT_ISSUED` row. **No new enum value.** |
| D3 | Where the cancellation date lives | Add **`financial_instrument.cancelled_date DATE`**, following the per-step date pattern, plus a coherence CHECK. |

## 3. D1 — RPC 42 `cancel_supplier_instrument`

**Why RPC 42 and not a renumbering:**

- Numbers 1–41 are cited in every FROZEN document: the inventory table, dependency order §5.1, RLS §4/§10 ("RPC 5–12"), the invariants, and the Phase 13–16 evidence and tests.
- Renumbering would silently change what "RPC 12" or "RPC 13" means in all of them.
- Appending 42 changes no existing reference. It also groups naturally with 10–12 by domain ("Issued instruments").

**Why not reuse `reject_supplier_instrument`:** a rejection and a cancellation are different business facts.

- A **rejection** means the instrument was presented and refused by the bank or counterparty. It is valid from ISSUED **or** DEBITED and can reverse a debit.
- A **cancellation** means the issuer voids an instrument that was never presented or debited, for example because it was not delivered or was annulled by agreement.

Using rejection for both would make the recorded fact false, and it would allow "cancelling" something already debited.

**Name:** `cancel_supplier_instrument` follows the existing convention for issued-instrument RPCs: `issue_supplier_instrument`, `mark_supplier_instrument_debited`, `reject_supplier_instrument`.

### Proposed contract (RPC_CONTRACTS_V1 style)

**Signature:** `cancel_supplier_instrument(p_instrument_id UUID, p_cancelled_date DATE, p_reason TEXT) RETURNS JSONB`
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_instrument.cancelled_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 RAISE 'REASON_REQUIRED'

  inst = SELECT * FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE
  IF inst NOT FOUND             RAISE 'INSTRUMENT_NOT_FOUND'
  IF inst.direction <> 'ISSUED' RAISE 'WRONG_DIRECTION: cancellation applies to issued instruments'
  IF inst.estado <> 'ISSUED'    RAISE 'INVALID_STATE: only an ISSUED (not yet debited) instrument can be cancelled, found %', inst.estado

  ASSERT_PERIOD_OPEN(p_cancelled_date)

  -- provenance resolved BEFORE any write: exactly one original issuance entry
  issued_count = SELECT COUNT(*) FROM supplier_ledger
                 WHERE supplier_id = inst.supplier_id
                   AND movement_type = 'INSTRUMENT_ISSUED'
                   AND source_entity_type = 'financial_instrument'
                   AND source_entity_id = p_instrument_id::TEXT
  IF issued_count <> 1 RAISE 'ISSUANCE_LEDGER_INCONSISTENT'
  issued_entry_id = SELECT id FROM supplier_ledger WHERE <same predicate>

  UPDATE financial_instrument SET estado='CANCELLED', cancelled_date=p_cancelled_date
   WHERE id = p_instrument_id

  -- the issuance never settled the obligation: supplier debt reopens by reversing it
  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reversal_of_id, reason, created_by)
  VALUES (inst.supplier_id, 'REVERSAL', inst.amount, p_cancelled_date,
          'financial_instrument', p_instrument_id::TEXT, issued_entry_id, p_reason, auth.uid())

  -- no financial_operation, no financial_posting: the bank was never debited

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'CANCELLED', p_cancelled_date, NULL, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'CANCEL_ISSUED',
          jsonb_build_object('estado','ISSUED'),
          jsonb_build_object('estado','CANCELLED','cancelled_date',p_cancelled_date),
          p_reason, auth.uid())
END
```

**supplier_ledger:** `+amount` REVERSAL at `cancelled_date`, with `reversal_of_id` pointing to the **single** matching `INSTRUMENT_ISSUED` entry. If the count is not exactly 1, the call raises `ISSUANCE_LEDGER_INCONSISTENT` before writing anything; a REVERSAL is never created without provenance.
**financial:** none, because the bank was never debited. **client_ledger:** none.
**Idempotency:** a state guard under the row lock, plus `idx_instrument_event_unique`, which blocks a second CANCELLED event.
**Concurrency:** two concurrent cancels, or a cancel racing a debit or reject, are serialised by `FOR UPDATE`. The loser sees a non-ISSUED `estado` and raises `INVALID_STATE`.
**Errors:** `FORBIDDEN`, `REASON_REQUIRED`, `INSTRUMENT_NOT_FOUND`, `WRONG_DIRECTION`, `INVALID_STATE`, `ISSUANCE_LEDGER_INCONSISTENT`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`.
**Returns:** `{instrument_id, estado: 'CANCELLED', cancelled_date}`.
**Hardening:** as for every RPC: `SET search_path = public`, owner postgres, `REVOKE ALL … FROM PUBLIC`, and EXECUTE for `authenticated` only (anon and service_role get none).

### Transition table after the ADR

| From | cancel_supplier_instrument |
|---|---|
| ISSUED | → CANCELLED |
| DEBITED | `INVALID_STATE`. After a debit the correct path is `reject_supplier_instrument`, which reverses the bank. |
| REJECTED | `INVALID_STATE` (terminal) |
| CANCELLED | `INVALID_STATE` (terminal; a second cancel is refused) |
| any received-direction state | `WRONG_DIRECTION` |

CANCELLED becomes terminal. It is also added to the issued-direction guards: `mark_supplier_instrument_debited` already requires `estado = 'ISSUED'`, and `reject_supplier_instrument` already requires `estado IN ('ISSUED','DEBITED')`. Both therefore already refuse a CANCELLED instrument, so **RPCs 11 and 12 need no change**.

## 4. D2 — supplier_ledger movement type

The frozen enum `supplier_ledger_movement_type` is: `PURCHASE`, `PAYMENT`, `CHEQUE_ENDORSED`, `INSTRUMENT_ISSUED`, `INSTRUMENT_REJECTED`, `FREIGHT`, `ADJUSTMENT`, `REVERSAL`, `OPENING_BALANCE`.

| Candidate | Assessment |
|---|---|
| `INSTRUMENT_REJECTED` | **Rejected.** It records a bank or counterparty refusal. A voluntary cancellation is a different fact, and reporting "rejected" instruments would count voids. |
| `ADJUSTMENT` | **Rejected.** It denotes a manual correction with no link to the original entry. The reversal would not be traceable to the issuance it undoes. |
| `REVERSAL` + `reversal_of_id` | **Accepted (D2).** A cancellation exactly undoes the `INSTRUMENT_ISSUED −amount` entry. `supplier_ledger` has a frozen `reversal_of_id` self-FK built for this pattern, and it is the same compensating mechanism `client_ledger` already uses for rectifications. The entry nets the issuance to zero and stays linked to it. |

**Conclusion: case A.** The current enum already has a semantically correct value (`REVERSAL`), so **no new enum value is required**. Owner confirmation is still part of this ADR, because it fixes how cancellations appear in supplier reporting.

## 5. D3 — cancellation date and period determinant

**Proposal:** add `financial_instrument.cancelled_date DATE`, plus a coherence CHECK:

```sql
ALTER TABLE financial_instrument ADD COLUMN cancelled_date DATE;
ALTER TABLE financial_instrument ADD CONSTRAINT chk_instrument_cancelled_coherent CHECK (
  (estado = 'CANCELLED' AND cancelled_date IS NOT NULL)
  OR (estado <> 'CANCELLED' AND cancelled_date IS NULL));
```

**Period determinant:** `cancelled_date`. It governs the supplier CC month in which the debt reopens. The `supplier_ledger` REVERSAL and the CANCELLED event both carry it as `effective_date` / `event_date`.

**Why a column and not only `event_date`:** every other lifecycle step persists its business date on the instrument, and the §12 period matrix is keyed on those columns. Keeping the date only in `financial_instrument_event` would make cancellation the single step whose determinant is not on the instrument.

The column is nullable. The CHECK is **bidirectional**: a CANCELLED instrument must carry its date, and no other state may carry one. Existing rows are unaffected because none is CANCELLED and none has a cancellation date. CANCELLED stays ISSUED-only through the existing `chk_instrument_estado_direction`.

## 6. Consequences

- **Exit criterion:** the issued lifecycle becomes complete. Every state in the frozen issued state machine (ISSUED, DEBITED, REJECTED, CANCELLED) is reachable through a contracted RPC.
- **Bank:** untouched by a cancellation. There is no FEE, no posting and no operation.
- **Counts:**
  - RPC count goes from 41 to **42**.
  - Period-sensitive RPCs go from 37 to **38**; the four non-period-sensitive RPCs are unchanged.
  - The SECURITY DEFINER inventory in the local build goes from 15 to **16**.
- **No change** to RPCs 1–41, to existing tables beyond one nullable column, or to any enum.

## 7. Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Implement ISSUED → CANCELLED inside `reject_supplier_instrument` | It conflates two business facts, and it would allow a "cancel" after DEBITED. |
| Remove `ISSUED → CANCELLED` from the invariants and the enum | It contradicts the frozen architecture ("with cancellation/rejection when necessary"), and enum values cannot be dropped cleanly. |
| Renumber the RPC inventory to slot the new RPC in after 12 | It breaks every existing reference to RPCs 13–41 across the FROZEN documents and the evidence. |
| Leave CANCELLED unreachable and close Phase 16 anyway | The roadmap exit criterion ("issued lifecycles complete") would be false. |

## 8. Implementation plan (executed after approval)

**1. Amend the FROZEN documents under this ADR, adding a reference line to each:**

- `RPC_CONTRACTS_V1.md`:
  - add §42 `cancel_supplier_instrument` under "ISSUED INSTRUMENTS";
  - update the inventory row and totals (42 total; 38 period-sensitive).
- `IMPLEMENTATION_DEPENDENCY_ORDER_V1.md` §5.1: change "Issued instruments" to "10 · 11 · 12 · 42", and "Total: 42".
- `DATABASE_INVARIANTS_V1.md`:
  - §12: add the row "Instrument cancelled | financial_instrument | `cancelled_date` | supplier CC month";
  - §18: `ISSUED → CANCELLED (RPC 42)`;
  - §19: add the row "Cancelled (RPC 42) | — | `+amount` REVERSAL | none".
- `POSTGRES_SCHEMA_SPEC_V1.md`: add the `cancelled_date` column and `chk_instrument_cancelled_coherent`.
- `RLS_IMPLEMENTATION_SPEC_V1.md`: change "RPC 5–12" to "RPC 5–12, 42" (§10), and the "all 41 RPCs" ownership note to 42 (§4).

**2. Migration `0018_issued_instrument_cancellation.sql`:** the column, the CHECK, the RPC, owner, `REVOKE PUBLIC/anon/service_role` and `GRANT EXECUTE TO authenticated`.

**3. `instruments.test.mjs` group for RPC 42:**

- the happy path: supplier +amount REVERSAL linked to INSTRUMENT_ISSUED, no operation or posting, bank unchanged, event and audit;
- `REASON_REQUIRED`, and `INVALID_STATE` after DEBITED, REJECTED or CANCELLED, and `WRONG_DIRECTION`;
- CLOSED period, with full rollback;
- injected-failure atomicity;
- concurrency with independent sessions (cancel vs cancel, cancel vs debit);
- the security and definer inventory;
- a row for CANCELLED in the rejection/termination matrix.

**4. Regression and clean rebuild** of all five suites, and an update of PHASE_16_INSTRUMENTS.md.

## 9. Owner decisions — APPROVED 2026-09-25

- **D1 — APPROVED:** RPC 42 `cancel_supplier_instrument(p_instrument_id UUID, p_cancelled_date DATE, p_reason TEXT) RETURNS JSONB`, with RPCs 1–41 not renumbered.
- **D2 — APPROVED:** `movement_type = 'REVERSAL'`, `signed_amount = +amount`, and `reversal_of_id` pointing to the single original `INSTRUMENT_ISSUED` row. No new enum value.
- **D3 — APPROVED:** `financial_instrument.cancelled_date DATE NULL` as the period determinant, plus the bidirectional `chk_instrument_cancelled_coherent`.

## 10. Clarifications recorded at acceptance

1. **Exact cardinality.** The original `INSTRUMENT_ISSUED` row is resolved on all four of `supplier_id = instrument.supplier_id`, `movement_type = 'INSTRUMENT_ISSUED'`, `source_entity_type = 'financial_instrument'` and `source_entity_id = instrument.id::TEXT`. If the count is not exactly 1, the call raises `ISSUANCE_LEDGER_INCONSISTENT`. This happens before any write.
2. **Bidirectional CHECK.** CANCELLED ⇒ `cancelled_date IS NOT NULL`, and not CANCELLED ⇒ `cancelled_date IS NULL`.
3. **Return shape.** `{instrument_id, estado, cancelled_date}`.
