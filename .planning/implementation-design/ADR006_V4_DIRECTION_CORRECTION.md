# ADR-006 — V-4 Direction Correction: Inbound vs Outbound Payment

## 1. Status and authority

**Owner-directed bounded architecture correction, 2026-09-28.** It is design only: no migration, parser, worker or `mp_v4_verified()` change.

- **Evidence:** `ADR006_V4_EQUIVALENCE_EVIDENCE.md` (commit `6720286`).
- **Preserved:**
  - ADR-003 D1 (parser, `movement_kind` mapping) and D4–D7 (RPC 41 Mode 1 / Mode 2 and operation-type ownership);
  - ADR-004 D10 / D13;
  - every domain RPC's ownership (`pay_supplier`, `transfer_between_accounts`, `pay_fiscal_obligation`, `register_collection`, …).
- **No new `financial_operation_type`** is introduced.

## 2. Contradiction resolved

The previous wording treated every approved payment resource, and every report `payment` row, as a receipt:
- ADR-006 §5 classification: "Payment approved (any payer…) → `payment`, §5.1 automatic";
- ADR-006 §8 step 2, ADR006_RPC_CONTRACTS_V1 §40: "`csv_import` payment row → `('payment', SOURCE_ID, 'APPROVAL', '')`".

V-4 proved that `SOURCE_ID == payment.id` also holds for payments **made by** the account (collector ≠ account; 4/4 samples). "A payment resource exists" therefore does **not** make a row an inbound receipt. The contradiction is resolved by the direction rule below.

## 3. Direction rule (FROZEN)

| Source | Inbound (receipt) | Outbound (made by the account) | Evidence |
|---|---|---|---|
| API payment snapshot | `String(collector_id) == MP_COLLECTOR_ID` | any other collector. It is never ingested as an API receipt: `FAILED_PERMANENT COLLECTOR_MISMATCH` in the worker, ERROR in RPC 40 (existing design, unchanged) | V-2, V-4 |
| Liberaciones `payment` row | direction **C** (`NET_CREDIT_AMOUNT > 0`) | direction **D** (`NET_DEBIT_AMOUNT > 0`) | V-4: C 5/5 collector = account; D 2/2 collector ≠ account |
| Account Money `SETTLEMENT` row with a payment method (K1 / K2) | `SETTLEMENT_NET_AMOUNT > 0` (K1) | `SETTLEMENT_NET_AMOUNT < 0` (K2) | V-4: K1 6/6 collector = account; K2 2/2 collector ≠ account |

The report direction is a **precondition**, not a substitute for the API.

- A report row becomes an **inbound candidate** only.
- `('payment', id, 'APPROVAL', '')` is claimed only by:
  - an API snapshot whose collector is the account; or
  - the ADMIN report fallback (R2), for an inbound-candidate row.
- If the back-fill of an inbound-candidate row returns a foreign collector, the direction evidence contradicts itself:
  - the delivery ends `FAILED_PERMANENT COLLECTOR_MISMATCH`;
  - the fallback is refused (`DIRECTION_CONFLICT`);
  - the row stays REVIEW_REQUIRED.
- The fallback never applies to an outbound row.

## 4. INBOUND payment

- **Classification:** `movement_kind = 'payment'`, transition `APPROVAL`, **only** when the account is proven to be the receiver (§3).
- **Application:**
  - auto-applicable by `mp_apply_transition` (A1);
  - the MP treasury effect follows gross / fee / tax / net exactly as in ADR-006 §5.1.
- **Attribution:** client attribution stays optional (OD-2). `operation_type` (`money_transfer`, `account_fund`, …) never decides client identity.

## 5. OUTBOUND payment (made by the account)

- **Never** `APPROVAL`, **never** auto-applied, **never** attributed. It creates no `MP_SETTLEMENT` receipt and no supplier / fiscal / transfer effect automatically.
- **Owner-confirmed 2026-09-28:** all 7 Account Money K2 rows are payments made by the account: QR purchases / payments, and a transfer for an input (V-3 §15.3). Being outbound does **not** make it a supplier payment. The ADMIN chooses the flow.
- **Report parser outcome, after V-4 enablement:**
  - The row is validated (ADR-003 D1 / V-3) and claims the identity `('payment', SOURCE_ID, 'OUTBOUND_PAYMENT', '')`.
  - A movement is created with `movement_kind = 'payment'`, per the ADR-003 D1 `payment → payment` mapping, which is unchanged, with the negative gross / tax / net as exported.
  - It gets a `mp_report_match` REPORT_ONLY row.
  - The identity de-duplicates the same outbound payment across report types (Liberaciones D and Account Money K2). A second claimant follows ADR-006 §8 step 3: IGNORED + MATCHED / DISCREPANCY.
  - **No back-fill**, and no MISSING_IN_REPORT for outbound payments (they have no API-side transition).
- **Schema consequence, for a later migration** (the Step-19 migration, or Step 16 if earlier): `chk_transition_kind` gains `'OUTBOUND_PAYMENT'`.
  - It is **not** added to `mp_is_auto_applicable`, so A1 cannot apply it.
  - C1 / C2 already refuse it: the identity is not APPROVAL, so `NOT_A_RECEIPT`.
- **State:** the movement is **REVIEW_REQUIRED (classification required)** until it is fully assigned (Σ assigned = net).
- **ADMIN resolution** reuses existing domain RPCs only:
  1. the owning domain RPC, with the Mercado Pago account as the paying account:
     - supplier payment → `pay_supplier(…)`;
     - own-account transfer → `transfer_between_accounts(…)`;
     - fiscal payment → `pay_fiscal_obligation(…)`;
     - another existing supported domain flow.

     That RPC writes the business ledger and the negative MP posting.
  2. `mp_reconcile_movement` **Mode 2** links the movement to that operation's MP posting. It creates no operation and no posting, and the operation-side cap applies (ADR-003 D7).
  3. The payer-side withholding carried by the report (for example `tax_withholding_payer`; report net = −API `total_paid_amount`, V-4 §8) is assigned with **Mode 1 `ADJUSTMENT`**, an ADR-003 D7 allowed type.
- Result: no duplicate MP posting, and no generic type absorbing unknown outflows.

## 6. PAYOUT (unchanged)

- Liberaciones `payout` → `movement_kind = 'transfer'` (ADR-003 D1), identity `('report', external_id, 'PAYOUT', '')`, REPORT_ONLY. It is **not** auto-applicable.
- The ADMIN links it with Mode 2 to `transfer_between_accounts`.
- V-4: its `SOURCE_ID` is not a payment id (404).
- **Account Money `PAYOUTS` (K4 / K5): owner-verified 2026-09-28 as a heterogeneous outbound treasury class.** Of 4 rows, 2 are supplier payments by transfer and 2 are withdrawals to an own account (V-3 §15.2).
  - It is **not** the Liberaciones `payout` mapping.
  - Freeze:
    - `movement_kind = 'outflow'`;
    - identity `('report', external_id, 'OUTBOUND_PAYMENT', '')`, REPORT_ONLY;
    - **REVIEW_REQUIRED**;
    - never auto-applied;
    - never attributed.
  - ADMIN resolution as in §5:
    - `pay_supplier` / `transfer_between_accounts` / `pay_fiscal_obligation` / another supported flow;
    - then RPC 41 Mode 2;
    - payout withholding through Mode 1 `ADJUSTMENT`.
  - No automatic business mapping from K4 / K5 (the tax / no-tax observation is 2 + 2 rows, not a rule).

## 7. ACCOUNT_FUND

Frozen from V-4 only:
- `account_fund` was observed on inbound K1 / Liberaciones C rows received through `cvu` (3/3), with collector = account.
- It **may** be an inbound treasury receipt (§4) when the receiver direction is proven.
- It is **not** evidence of client identity. Attribution stays **CLIENT_UNASSIGNED** (NONE) unless deterministic client evidence exists (C2).
- Not every `account_fund` is a client collection. Whether a given one is an own-funds transfer is an ADMIN / owner classification, made through the existing flows.

## 8. K3

- Account Money K3 is **NOT_A_PAYMENT_ID** (V-4: 404).
- **Updated 2026-09-28:** owner-verified as **investment yield**. That is 9/9, all K3 rows (V-3 §15.1).
  - For the exact V-3 §13 K3 structural shape only: `movement_kind = 'yield'`, `('report', external_id, 'YIELD', '')`, REPORT_ONLY.
  - A1 applies it: a single `MP_SETTLEMENT` = net; P&L Otros ingresos financieros; no attribution.
  - A row outside that shape is not yield (ERROR).
- Cross-report de-duplication with Liberaciones `asset_management` is **unproven** (V-3 §15.4). Both report types must not be ingested for yield over the same period.
- Liberaciones `asset_management` → `yield` is unchanged (ADR-003 D1). V-4 confirms that its id is not a payment id either, which is consistent with a report-only kind.
- K3 ↔ `asset_management` equivalence is not asserted.

## 9. V-4 gate

- "Report `SOURCE_ID` == `payment.id`" is **proven** for payment-resource rows.
- `mp_v4_verified()` may become true **only after** the report parser / normalizer implements §3 and §5:
  - direction-aware claims;
  - `OUTBOUND_PAYMENT` identity;
  - back-fill and fallback restricted to inbound candidates.
- Step 19 must never reinterpret outbound (debit) payment rows as inbound receipts. The `DEFERRED_V4` re-run applies the direction rule.

## 10. Documents aligned by this correction

- ADR-006 §5 classification table, §8 steps 2 and 4, the §12 V-4 row, and a correction note in the header.
- ADR006_RPC_CONTRACTS_V1: §40 transition resolution, §40.4 back-fill, R2 fallback preconditions.
- ADR006_IMPLEMENTATION_ORDER_V1: steps 16 and 19, and the V-4 gate row.
- ADR006_WEBHOOK_WORKER_DESIGN_V1: §6 report flow.
- ADR006_TEST_MATRIX_V1: the new DIRECTION block (DIRECTION-1 … DIRECTION-8; DIRECTION-5 revised and DIRECTION-8 added on 2026-09-28 after the owner evidence).

ADR006_IDEMPOTENCY_AND_STATE_V1 needs no change. `OUTBOUND_PAYMENT` is one more transition identity under the existing uniqueness rule.
