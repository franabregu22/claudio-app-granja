# ADR-003 — Mercado Pago definitive contract

**STATUS:** **ACCEPTED** by the owner on 2026-09-25 ("ADR-003 RATIFIED / RESUME CONSTRUCTION"), then **updated** the same day ("CORRECCIÓN FINAL ACOTADA").
It is implemented by migrations `0039_mp_tables_guard.sql`, `0040_mp_rpcs.sql`, `0041_mp_privileges_rls.sql` and `0042_mp_contract_hardening.sql`.
**HISTORY:**

1. Proposed 2026-09-25 (PHASE_23_MP.md §31b).
2. Accepted 2026-09-25.
3. Updated 2026-09-25: IGNORED only after common validation (D1 / D3), and the Mode 1 operation-type ownership rule (D7). See §10.
**DATE:** 2026-09-25
**SCOPE:** Domain L (Mercado Pago) and RPCs 40 `mp_normalize_source` and 41 `mp_reconcile_movement`.
**AMENDS:**

- POSTGRES_SCHEMA_SPEC_V1 Domain L;
- RPC_CONTRACTS_V1 §40–§41;
- RLS_IMPLEMENTATION_SPEC_V1 §9, unchanged in substance.

It follows the precedent of ADR-001 and ADR-002. Per the owner's instruction, the FROZEN files themselves are **not rewritten**: this ADR is the authoritative amendment, and it prevails over §40–§41 and Domain L wherever they differ.

---

## 1. Context

The Phase 23 pre-construction review (PHASE_23_MP.md §7–§14, §24) found five gaps in the frozen contract:

1. `parse_mp_payload` is called but never specified.
2. RPC 41 marks the source `RECONCILED` after any assignment.
3. RPC 41 is not request-idempotent, and its cumulative `external_ref` collides after counter-assignments.
4. RPC 41 always creates an operation, so "N:N" was mechanically only 1:N.
5. The legacy retirement condition cannot be proven without touching production.

The owner resolved all five. The parser was ratified from repository evidence (the committed `Liberaciones*` exports and the legacy rebuild).

## 2. Decision D1 — parser contract (`parse_mp_payload`)

**Supported in V1:** only `source_type = 'csv_import'` in the Mercado Pago **Liberaciones** layout.

**event_data** is one CSV row stored as a JSON object with **exactly** these 15 keys:

- `DATE`, `SOURCE_ID`, `DESCRIPTION`;
- `NET_CREDIT_AMOUNT`, `NET_DEBIT_AMOUNT`, `GROSS_AMOUNT`, `MP_FEE_AMOUNT`, `TAXES_AMOUNT`;
- `PAYMENT_METHOD`, `TRANSACTION_APPROVAL_DATE`, `BUSINESS_UNIT`, `SUB_UNIT`, `BALANCE_AMOUNT`, `PAYMENT_METHOD_TYPE`, `PURCHASE_ID`.

Every value is a raw string, exactly as exported.

**Field rules:**

| Item | Rule |
|---|---|
| external_id | `SOURCE_ID || ':' || DESCRIPTION || ':' || direction`, where direction is `C` if the row's net > 0 and `D` if net < 0 |
| ingestion | rows without `SOURCE_ID` or `DATE` are not source events and are not ingested |
| occurred_at | the `DATE` field with its exported offset |
| occurred_date | `(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`, the period determinant |
| movement_kind | `payment` → `payment`; `asset_management` → `yield`; `payout` → `transfer`. `reserve_for_payment` / `reserve_for_payout` → **IGNORED**, but only after passing every validation below. Any other DESCRIPTION → **ERROR**. |
| movements per supported source | exactly one |
| amounts | gross = `GROSS_AMOUNT`, fee = `MP_FEE_AMOUNT`, tax = `TAXES_AMOUNT`, net = `NET_CREDIT_AMOUNT − NET_DEBIT_AMOUNT`, all signed as exported |

**Validation.** Any failure → ERROR:

- the amounts are numeric with at most 2 decimals (NUMERIC(15,2) precision, no rounding tolerance);
- exactly one of credit or debit is non-zero, and net is non-zero;
- fee ≤ 0 and tax ≤ 0;
- gross + fee + tax = net exactly;
- the raw `external_id`, `occurred_at` and `occurred_date` equal the values this contract derives from the row.

**Sign:** net > 0 is money into Mercado Pago; net < 0 is money out.

**Evidence.** The exports hold 4,528 distinct rows:

- the arithmetic identity holds in 100 % of them;
- no row has both sides non-zero, and no normalized row has net = 0;
- the composite external_id is unique, with 0 collisions;
- the reserve pairs and sets compensate each other economically to 0 as groups. Individual reserve rows are **not** zero-net; they are IGNORED because they are internal reserves, not because their own net is zero.

## 3. Decision D2 — unsupported sources in V1

The following are **not** normalized in V1:

- `webhook`;
- `api`;
- the `BASECSV` layout;
- the settlement-report families (`arch*`, `Reporte_movimientos*`, `data11sept-23-sept.csv`) and any other non-Liberaciones layout.

If such a source reaches RPC 40:

- status → `ERROR`;
- `processed_at` is set;
- `processing_note` explains the unsupported source or format;
- no movement is created;
- a `NORMALIZE` audit is written.

The Mercado Pago API is never fetched, and no remote payload is inferred.

## 4. Decision D3 — ERROR / IGNORED semantics

Both outcomes use the existing `mp_processing_status` values and are written only by RPC 40:

- **ERROR:** the payload was meant to be supported but cannot be parsed or validated deterministically, or its source or format is unsupported in V1.
- **IGNORED:** a **valid, deterministically recognised event** that is deliberately outside the financial-movement scope (the reserve rows). It is not a parse failure.
  - IGNORED is reached only **after the common parser validation**: layout, recognised DESCRIPTION, amounts, credit XOR debit, non-zero net, fee and tax ≤ 0, arithmetic, SOURCE_ID / DATE, external_id, occurred_at / occurred_date.
  - A reserve row failing any of these checks is **ERROR**, never IGNORED.

In both cases:

- the raw columns are unchanged;
- no movement is created;
- `processed_at` is set;
- `processing_note` is required;
- a `NORMALIZE` audit is written with the resulting status and the note.

## 5. Decision D4 — source lifecycle and RECONCILED

**Lifecycle:** `PENDING → NORMALIZED → RECONCILED`, or `PENDING → IGNORED`, or `PENDING → ERROR`.

**Definition:** `RECONCILED` holds **iff** every `mp_financial_movement` of the source satisfies `SUM(mp_reconciliation.assigned_amount) = net_amount`, signed.

- A partial assignment, or an unmatched sibling movement, leaves the source `NORMALIZED`.
- `remaining_unassigned` is always derived and never stored.
- RPC 41 recomputes the status after every successful assignment. A later counter-assignment on a fully reconciled source therefore returns it to `NORMALIZED`, because the definition is an equivalence.
- **Lock order in RPC 41:** movement → existing operation (Mode 2 only) → source. The source lock guarantees that sibling reconciliations cannot miss the transition.

## 6. Decision D5 — RPC 41 request idempotency and external_ref

**New parameter:** `p_idempotency_key VARCHAR`, mandatory, 1–97 characters (else `INVALID_IDEMPOTENCY_KEY`).

**New column:** `mp_reconciliation.idempotency_key VARCHAR(100) UNIQUE NOT NULL`. This is the physical backstop for both modes.

**Mode 1 external_ref:** `'MP:' || p_idempotency_key`. That is at most 100 characters, it is never derived from the cumulative amount, and it cannot collide after counter-assignments.

**Duplicate key:** raises `DUPLICATE_RECONCILIATION`, sequentially or concurrently. There is no second operation, posting, reconciliation, status transition or audit.

## 7. Decision D6 — counter-assignments

Opposite-sign assignments are allowed. The movement-level cap is `abs(total_assigned_after) ≤ abs(net_amount)`. For example, +600, −100, +500 is valid for a +1000 movement.

Previous reconciliation rows are never deleted or rewritten.

## 8. Decision D7 — true N:N, Mode 1 / Mode 2, and operation-side capacity

**Definitive signature:**

```
mp_reconcile_movement(p_movement_id BIGINT, p_assigned_amount NUMERIC, p_idempotency_key VARCHAR,
                      p_financial_account_id UUID,
                      p_operation_type financial_operation_type DEFAULT 'MP_SETTLEMENT',
                      p_existing_financial_operation_id BIGINT DEFAULT NULL,
                      p_reason TEXT DEFAULT NULL) RETURNS JSONB
```

`p_financial_account_id` is required in both modes (`ACCOUNT_REQUIRED`).

**Mode 1 — create** (`p_existing_financial_operation_id IS NULL`):

- **Allowed operation types:** only `MP_SETTLEMENT`, `FEE` and `ADJUSTMENT`.
  - Any other `p_operation_type` raises `INVALID_MP_OPERATION_TYPE` before any operation, posting, reconciliation or audit is written.
  - Cross-domain operation types remain owned by their existing RPCs: `TRANSFER` (`transfer_between_accounts`, exactly 2 postings); `COLLECTION` (`register_collection`); the cheque and instrument types (instrument RPCs); `SUPPLIER_PAYMENT` / `FREIGHT_PAYMENT` (purchases and suppliers); `FISCAL_PAYMENT` (fiscal); `SESSION_CASH` (Feria).
  - RPC 41 never fabricates those semantics partially.

- one operation (`p_operation_type`, dated `movement.occurred_date`, `external_ref = 'MP:' || key`);
- one posting of `p_assigned_amount` on the account;
- one reconciliation row.

**Mode 2 — link existing** (the caller supplies the operation; no automatic matching):

- **`p_operation_type` is ignored.** It is not validated and never applied: Mode 2 creates no operation and does not govern the existing one.

- The operation must exist (`OPERATION_NOT_FOUND`).
- It must have **exactly one** posting on `p_financial_account_id`: zero → `OPERATION_ACCOUNT_POSTING_NOT_FOUND`; more than one → `OPERATION_ACCOUNT_POSTING_AMBIGUOUS`.
- `operation_capacity` is that posting's `signed_amount`.
- `already_linked` is `SUM(assigned_amount)` over the reconciliations of `(operation, account)`.
- Invariant: `abs(already_linked + p_assigned_amount) ≤ abs(operation_capacity)`, else `OPERATION_OVER_ASSIGNMENT`.
- No operation and no posting is created.
- The movement-level cap applies independently.
- A same-pair `(movement, operation)` repeat → `DUPLICATE_LINK`, independently of request idempotency.

**Account traceability, resolved mechanically.** Without an account column, a reconciliation row against a multi-posting operation (for example a transfer with −X on Caja and +X on MP) cannot say which posting it consumed, so the operation-side cap would be ambiguous forever.

ADR-003 therefore adds `mp_reconciliation.financial_account_id UUID NOT NULL REFERENCES financial_account(id)`:

- Mode 1 stores the posting account;
- Mode 2 stores the selected posting account;
- the cap groups by `(financial_operation_id, financial_account_id)`, served by the index `idx_mp_reconciliation_operation_account`.

## 9. Decision D8 — legacy MP (cutover carry-forward)

- Phase 23 does not touch production.
- The target MP model is authoritative for V1.
- Legacy MP remains the migration and historical source until cutover.
- No legacy table exists or is authoritative in the target DB.
- No target feature depends on the legacy `ledger_entry` / `account_balance` model.

**Carry-forward to Cutover:** "At Cutover, disable legacy MP writers/webhook path or make legacy MP read-only after the new ingestion path is activated and validated." Production legacy is **not** claimed to be read-only.

## 10. Update 2026-09-25 — contract hardening (migration 0042)

**Validation order of RPC 40:**

1. source_type, Liberaciones layout, raw-string values;
2. DESCRIPTION recognised (payment, asset_management, payout, reserve_for_payment, reserve_for_payout; otherwise ERROR);
3. amounts;
4. credit XOR debit;
5. net non-zero;
6. fee and tax ≤ 0;
7. gross + fee + tax = net;
8. SOURCE_ID and DATE present;
9. external_id;
10. timestamp and occurred_date;
11. only then classify: reserve → IGNORED; payment / asset_management / payout → NORMALIZED.

**RPC 41:** the Mode 1 operation-type rule of §8.

**Implementation:** both functions are redefined in `0042_mp_contract_hardening.sql` with CREATE OR REPLACE, keeping the same signatures and grants. `0040` is not modified.

## 11. Consequences

- **Schema:** `mp_reconciliation` gains two columns, `idempotency_key` and `financial_account_id`. The other Domain L objects are exactly as frozen.
- **RPC 40:** the signature is unchanged. Its behaviour is the D1–D3 parser with the ERROR / IGNORED outcomes.
- **RPC 41:** the new signature per D7, with D4–D6 semantics.
- **Evidence:** PHASE_23_MP.md, and `scripts/target-db/mp.test.mjs` with 143 assertions (127 at acceptance, plus 16 for the §10 update).
