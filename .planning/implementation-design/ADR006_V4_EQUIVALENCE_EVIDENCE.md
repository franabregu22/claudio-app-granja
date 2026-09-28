# ADR-006 — V-4 Equivalence Evidence

## 1. STATUS

**V-4 EQUIVALENCE GATE: VERIFIED** (updated 2026-09-28 after the V-4 direction correction `c0e19dc` and the owner evidence, §15).

- The first status (PARTIAL) was held only because the §8 mapping would have treated outbound payment rows as receipts. The direction correction resolved that at design level.
- The remaining items are **not** part of the V-4 gate: `account_fund` attribution, refunds, chargebacks and `payer.id` are V-2 / V-3 feature gaps.
- The gate's evidence is complete.
- **Enabling** it (`mp_v4_verified()` → true, Step 19) still waits for the direction-aware parser to be **implemented**. That is an implementation precondition, not missing evidence (§13).

Original findings:

- **`SOURCE_ID == payment.id` is PROVEN for `payment` rows in both reports.**
  - Liberaciones `payment` rows: 7/7.
  - Account Money K1 / K2 rows: 8/8.
  - Every lookup returned the same id, and there were zero contradictions.
- **The id is REFUTED as a payment id** for Liberaciones `asset_management` / `payout` and Account Money K3 / K4 / K5. They return 404 "Payment not found".
- **`mp_v4_verified()` must NOT become true yet** (§13). The evidence shows that `payment` rows include payments made **by** the account (the API `collector_id` is not the account). For those rows the ADR-006 §8 step-2 mapping `('payment', SOURCE_ID, 'APPROVAL')` does not describe a receipt.

## 2. AUTHORIZATION / SAFETY

- **Date:** 2026-09-28.
- **Authorization:** the owner explicitly authorized read-only Mercado Pago production API contact for V-4 only.
- **Read-only check:** `GET /v1/payments/{id}` is the documented read-only "Get payment" endpoint. It was confirmed on 2026-09-28 in V-2 (ADR006_V2_PAYMENT_FIELD_EVIDENCE §3, R1).
- **Requests:** **20 × `GET /v1/payments/{id}`** in total.
  - Outcomes: 15 × HTTP 200, 5 × HTTP 404.
  - **0 × `/v1/payments/search`.**
  - No other method or endpoint was used.
- **Why 20, not 15:**
  - 15 lookups were planned (11 Account Money + 4 Liberaciones).
  - **5 more Liberaciones lookups were explicitly justified.** The Step-19 gate depends on Liberaciones, the first 4 rows had shown only 2 `payment` rows, and the export contains 38 `payment` rows in **debit**, a shape no sample covered.
  - The first extension run stopped on a local print error after one lookup (LB5). LB5 was recorded from its sanitized printed output and **not re-fetched**. The remaining 4 were then run, so the total is exactly 20.
- **Zero writes.** No refund, chargeback, webhook or application action. No Supabase contact.
- **Credential:** `MP_ACCESS_TOKEN` was read from the process environment only, never printed or persisted.
- **Raw data:**
  - Raw API payloads were processed in memory. Only sanitized comparison rows were written, to the scratch directory and to the fixture.
  - The report CSVs were read in place, read-only, and not copied into the repository.

## 3. INPUT SOURCES

| Source | Use |
|---|---|
| V-2 evidence | `ADR006_V2_PAYMENT_FIELD_EVIDENCE.md`, commit 74caa01: API field semantics |
| V-3 evidence | `ADR006_V3_ACCOUNT_MONEY_ADDENDUM.md`, commit e42ecc3: K1–K5 classes |
| Account Money report | `Reporte_movimientos_mercadopago-manual-2026-09-23-134934.csv` (294 rows, 2026-09-11 → 2026-09-23), owner file outside the repository |
| Liberaciones report | `data/mercadopago/Liberaciones3.csv`: raw export, 1 472 rows with `SOURCE_ID`, 2026-07-04 → 2026-09-04, untracked. Phase 26 evidence was not modified |

The two reports do not overlap in time. **The two equivalences (A. Liberaciones, B. Account Money) were tested separately.**

## 4. ACCOUNT MONEY DIRECT-ID SAMPLE

Rows were selected deterministically, in file order, by class.

| Sample | Report class | SOURCE_ID shape | GET | id equal | operation_type | status | Collector = account | Gross | Net | Date (instant) | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AM1 | K1 available_money | 12 digits | 200 | yes | money_transfer | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |
| AM2 | K1 available_money | 12 digits | 200 | yes | money_transfer | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |
| AM3 | K1 cvu | 12 digits | 200 | yes | **account_fund** | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |
| AM4 | K1 cvu | 12 digits | 200 | yes | **account_fund** | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |
| AM5 | K1 debin_transfer | 12 digits | 200 | yes | money_transfer | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |
| AM6 | K1 credit_card | 12 digits | 200 | yes | money_transfer | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |
| AM7 | K2 (negative) | 12 digits | 200 | yes | **regular_payment** | approved / accredited | **no** | \|gross\| = | ≠ (see §8) | −1 s | **PAYMENT_RESOURCE_BUT_DIFFERENT_SEMANTICS** |
| AM8 | K2 (negative) | 12 digits | 200 | yes | **regular_payment** | approved / accredited | **no** | \|gross\| = | ≠ (see §8) | = (0 s) | **PAYMENT_RESOURCE_BUT_DIFFERENT_SEMANTICS** |
| AM9 | K3 (yield-like) | 13 digits | **404** | — | — | — | — | — | — | — | **NOT_A_PAYMENT_ID** |
| AM10 | K4 PAYOUTS with tax | 12 digits | **404** | — | — | — | — | — | — | — | **NOT_A_PAYMENT_ID** |
| AM11 | K5 PAYOUTS no tax | 12 digits | **404** | — | — | — | — | — | — | — | **NOT_A_PAYMENT_ID** |

## 5. LIBERACIONES DIRECT-ID SAMPLE

| Sample | Report class | SOURCE_ID shape | GET | id equal | operation_type | status | Collector = account | Gross | Net | Date (instant) | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| LB1 | payment credit, cvu (Sep) | 12 digits | 200 | yes | **account_fund** | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |
| LB2 | payment credit, available_money (Sep) | 12 digits | 200 | yes | money_transfer | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |
| LB3 | asset_management | 13 digits | **404** | — | — | — | — | — | — | — | **NOT_A_PAYMENT_ID** |
| LB4 | payout | 12 digits | **404** | — | — | — | — | — | — | — | **NOT_A_PAYMENT_ID** |
| LB5 | payment **debit** (Jul) | 12 digits | 200 | yes | money_transfer | approved / accredited | **no** | \|gross\| = | ≠ | = (0 s) | **PAYMENT_RESOURCE_BUT_DIFFERENT_SEMANTICS** |
| LB6 | payment **debit** (Aug) | 12 digits | 200 | yes | **regular_payment** | approved / accredited | **no** | \|gross\| = | ≠ (see §8) | = (0 s) | **PAYMENT_RESOURCE_BUT_DIFFERENT_SEMANTICS** |
| LB7 | payment credit, debin_transfer (Jul) | 12 digits | 200 | yes | money_transfer | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |
| LB8 | payment credit, credit_card (Jul) | 12 digits | 200 | yes | money_transfer | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |
| LB9 | payment credit, available_money (Aug) | 12 digits | 200 | yes | money_transfer | approved / accredited | yes | = | = | = (0 s) | **DIRECT_PAYMENT_MATCH** |

The Liberaciones date is compared as API `date_approved` against `TRANSACTION_APPROVAL_DATE`, and also against `DATE`. Both deltas are 0 s in every 200 row.

## 6. EQUIVALENCE CONCLUSION

**A. Liberaciones `SOURCE_ID` == `payment.id`:**
- **PROVEN for `DESCRIPTION = payment` rows** (7/7 id equal).
  - For credit rows the equivalence is full: id, gross, net and approval instant (5/5).
  - For debit rows the id is equal, but the API resource is a payment **made by the account** (2/2).
- **REFUTED** for `asset_management` (1/1) and `payout` (1/1), which are not payment ids.

**B. Account Money `SOURCE_ID` == `payment.id`:**
- **PROVEN for K1** (6/6 full) and **K2** (2/2 id equal, account as payer).
- **REFUTED** for K3 / K4 / K5 (3/3 not payment ids).

Standard A–E (§ prompt) is met for credit / K1 rows:
- 11 independent full matches across two reports, 3 months (Jul–Sep 2026) and 4 payment methods;
- zero contradictions.

Proof rests on the direct id lookup plus cent-exact gross / net and the same approval instant. It never rests on amount, date, identity or `external_reference` alone.

## 7. API OPERATION_TYPE ↔ REPORT CLASS

Observed only:

| Report class | API `operation_type` observed | Payment method (both sources) |
|---|---|---|
| AM K1 credit / LB payment credit, `available_money` | `money_transfer` (AM 2/2, LB 2/2) | account_money |
| AM K1 / LB payment credit, `cvu` | **`account_fund`** (AM 2/2, LB 1/1) | cvu |
| AM K1 / LB payment credit, `debin_transfer` | `money_transfer` (AM 1/1, LB 1/1) | debin_transfer |
| AM K1 / LB payment credit, credit card | `money_transfer` (AM 1/1, LB 1/1) | naranja / master |
| AM K2 / LB payment debit (account is payer) | `regular_payment` (AM 2/2, LB 1/1); `money_transfer` (LB 1/1) | account_money |
| AM K3 / LB asset_management | no payment resource (404) | — |
| AM K4 / K5 PAYOUTS / LB payout | no payment resource (404) | — |

**K1 is mixed:** it contains both `money_transfer` and `account_fund`. Every observed `account_fund` (3/3) is a `cvu` inbound transfer, and every observed `cvu` K1 / credit row (3/3) is `account_fund`.

## 8. AMOUNT EQUIVALENCE

- **Receipts** (collector = account; AM1–AM6, LB1, LB2, LB7–LB9), 11/11, all cent-exact:
  - API `transaction_amount` = report gross (AM `TRANSACTION_AMOUNT`; LB `GROSS_AMOUNT`): difference 0.
  - API `transaction_details.net_received_amount` = report net (AM `SETTLEMENT_NET_AMOUNT`; LB `NET_CREDIT_AMOUNT − NET_DEBIT_AMOUNT`): difference 0.
  - Report `gross + fee (+ MKP) + tax − net` = 0 in every row, including the debit rows.
  - AM: `TRANSACTION_AMOUNT + FEE_AMOUNT + MKP_FEE_AMOUNT + TAXES_AMOUNT` = API net in all 6.
- **Account as payer** (AM7, AM8, LB5, LB6):
  - API `transaction_amount` = **|report gross|** (4/4). The report gross is negative.
  - The API `net_received_amount` is the **counterparty's** net, so it differs from the report.
  - **Report net = −API `transaction_details.total_paid_amount`** (3/3 checked: AM7, AM8, LB6; LB5's total was not retained).
  - The report's payer-side tax (`tax_withholding_payer`) is the difference between the two.

## 9. DATE EQUIVALENCE

- API `date_approved` is formatted `…-04:00`. The report dates are formatted `…-03:00`.
- **Compared as instants:**
  - receipts: 11/11 identical (0 s);
  - account-as-payer: 3/4 identical, AM7 is −1 s.
  - The offset difference is systematic formatting, not a time difference.
- Also observed:
  - API `date_created` = AM `TRANSACTION_DATE` (AM1–AM8, 0 s).
  - For Liberaciones, `DATE` = `TRANSACTION_APPROVAL_DATE` = API `date_approved` in every 200 row. The release lag is 0.

## 10. EXTERNAL_REFERENCE OBSERVATIONS

- **Receipts (11):** API `external_reference` is null and the report `EXTERNAL_REFERENCE` is blank or absent in every row. Both are absent.
- **Account as payer:**
  - AM7 and AM8 have a present value in both sources, and it is **equal** (2/2).
  - LB6 has a present API value; Liberaciones has no such column.
  - LB5 is null.
- Not part of the identity proof.

## 11. ACCOUNT_FUND EVIDENCE

Observed facts only:
- `account_fund` API payments are approved `cvu` bank-transfer receipts with collector = account (3/3).
- In the Account Money report they appear as ordinary **K1 `SETTLEMENT`** rows (2/2). In Liberaciones they appear as ordinary **`payment`** credit rows (1/1).
- Neither report distinguishes them from other receipts, except through `PAYMENT_METHOD = cvu`.
- Their gross, net and tax (0.6 % collector withholding) behave exactly like other receipts.

**BUSINESS CLASSIFICATION REQUIRES OWNER DECISION:** whether an `account_fund` is a customer receipt or an own-funds transfer. The documentation (V-2 R1: "Deposit of money into the user's account") does not settle it for this account.

## 12. NON-PAYMENT REPORT CLASSES

| Class | Outcome |
|---|---|
| **K2** (AM negative SETTLEMENT) and LB `payment` debit | **PAYMENT_RESOURCE_BUT_DIFFERENT_SEMANTICS.** The id is a real payment where the **account is the payer** (collector ≠ account). `operation_type` is `regular_payment` (3) or `money_transfer` (1). This is money out: a payment made by the account |
| **K3** (AM) / LB `asset_management` | **NOT_A_PAYMENT_ID** (404). The 13-digit id is not a payment resource. The yield meaning stays undocumented |
| **K4** (AM PAYOUTS with tax) | **NOT_A_PAYMENT_ID** (404) |
| **K5** (AM PAYOUTS without tax) / LB `payout` | **NOT_A_PAYMENT_ID** (404) |

## 13. V-4 GATE DECISION

**May `mp_v4_verified()` become true? NO — not yet.**

What is proven: a Liberaciones `payment` row's `SOURCE_ID` is the API payment id (7/7). For receipt rows the full economic and time equivalence also holds.

Why the gate stays closed:
- Step 19 would re-run RPC 40 on **all** `DEFERRED_V4` `payment` rows.
- ADR-006 §8 step 2 maps every `payment` row to `('payment', SOURCE_ID, 'APPROVAL', '')`, then back-fills `GET /v1/payments/{SOURCE_ID}`.
- The evidence shows that some `payment` rows are **payments made by the account**: 38 debit rows in this export, sampled 2/2.
- For those rows the API resource belongs to another collector. The worker's collector check would make them `FAILED_PERMANENT COLLECTOR_MISMATCH`, and an "APPROVAL" of a receipt misdescribes them.

The gate can become YES once the design decides how `payment` debit rows (account as payer) are handled. For example:
- restrict the V-4 mapping to credit rows whose API collector is the account; and/or
- define a separate transition kind for outgoing payments.

That is an owner / architecture decision. The id equivalence itself does not need more evidence.

**Update 2026-09-28: decision taken.** `ADR006_V4_DIRECTION_CORRECTION.md` (commit `c0e19dc`) freezes this:
- inbound rows only → APPROVAL candidates;
- outbound rows → `OUTBOUND_PAYMENT`;
- back-fill and fallback only for inbound rows.

**Revised answer:** `mp_v4_verified()` **may eventually become true: YES**. It becomes true in Step 19, and only after that direction-aware parser / normalizer is implemented and DIRECTION-1…8 pass. No further V-4 evidence is required.

## 14. IMPACT ON V-2 / V-3

**V-2 resolved:**
- For receipts, the API gross and net equal the report's documented gross and net, cent-exact.
- So the report's documented fee / tax split (V-3 §6–§7) is linkable to the API payment through `SOURCE_ID == payment.id`. V-2 lacked a documented API-side component source.
- `account_fund` is identified structurally: `cvu` inbound receipts, reported as ordinary receipts.
- `external_reference` is observed with a value only on payments made by the account.

**V-3 resolved:**
- **K2** = payments made by the account: a real payment resource, account as payer. Report net = −`total_paid_amount`.
- **K3 / K4 / K5** are not payment ids.
- **K1** `SOURCE_ID` = API payment id.

**Still open:**
- **Business meaning:** K3 (yield-like), PAYOUTS (undocumented type), outgoing payments (K2 / LB debit) and `account_fund`.
- **Refunds, chargebacks and disputes:** not observed.
- **`payer.id` type ambiguity.**
- **The design of debit `payment` rows before Step 19** (§13).

**Sanitized fixture:** [`scripts/target-db/fixtures/adr006-v4-equivalence.json`](../../scripts/target-db/fixtures/adr006-v4-equivalence.json). It has 20 comparison rows with no ids, no personal data and no raw payloads.

## 15. OWNER EVIDENCE AND FINAL SEPARATION (2026-09-28)

Owner manual verification in the Mercado Pago application (ADR006_V3_ACCOUNT_MONEY_ADDENDUM §15; ids cross-checked locally, not reproduced):
- **K2:** all 7 rows are payments made by the account. This confirms the V-4 direction finding (API: collector ≠ account, 2/2) on the full class.
- **K3:** all 9 rows are investment yield. This is consistent with V-4 NOT_A_PAYMENT_ID (404), and K3 is now independently confirmed as yield.
- **Account Money PAYOUTS:** all 4 rows. Two are supplier payments by transfer and two are withdrawals to an own account: heterogeneous, not payment ids (404).

**V-4 equivalence gate: VERIFIED.**
- Payment `SOURCE_ID == API payment.id` is proven:
  - Liberaciones `payment` 7/7;
  - Account Money K1 / K2 8/8.
- Inbound versus outbound direction is proven, and the design is corrected (`c0e19dc`).
- The K2 business direction is confirmed manually.
- Non-payment classes are proven not to be payment ids.

**Not V-4 (remaining V-2 / V-3 feature evidence gaps):**
- the business classification of `account_fund` (no owner decision; CLIENT_UNASSIGNED by default);
- refunds, chargebacks and disputes (not observed);
- the refund transition date;
- the `payer.id` type;
- the undocumented `charges_details`;
- the Account Money balance column, coverage metadata and unobserved types;
- ~~the cross-report identity of report-only kinds (V-3 §15.4)~~: resolved for yield and payout (V-3 §16).
