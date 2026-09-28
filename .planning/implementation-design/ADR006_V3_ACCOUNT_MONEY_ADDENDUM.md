# ADR-006 — V-3 Account Money Report Addendum

## 1. STATUS

**VERIFIED for the five observed row classes (updated 2026-09-28 with owner evidence, §15).** Scope: the parser contract (§13) for K1–K5. Every unobserved `TRANSACTION_TYPE` is rejected fail-closed (ERROR).

Proven:
- the layout, amounts, signs, arithmetic, fee / tax fields, row identity and occurrence date;
- the business meaning of every observed class:
  - K1: inbound candidate;
  - K2: outbound payment made by the account;
  - K3: yield;
  - K4 / K5 `PAYOUTS`: heterogeneous outbound treasury movements that require ADMIN classification.

The first status (PARTIAL) listed three classes without a proven meaning. §15 resolves them.

**Remaining V-3 feature gaps** (they do not affect the observed-class parser contract):
- **no balance column:** R4 does not apply to this layout;
- **no coverage metadata:** the §10 INTERNAL_POLICY applies;
- **unobserved types** `REFUND`, `CHARGEBACK`, `DISPUTE`, `WITHDRAWAL`, … are ERROR until observed. R-8 (chargeback via report) stays blocked;
- **a non-zero fee's sign** is unobserved;
- **cross-report identity of report-only kinds** (§15.4).

## 2. SOURCE

| Item | Value |
|---|---|
| File | `Reporte_movimientos_mercadopago-manual-2026-09-23-134934.csv`, owner-provided, read locally in place |
| In git | no; never copied into the repository |
| Export generation | 2026-09-23 13:49:34, from the file name |
| Rows | **294** data rows plus 1 header row |
| Columns | **60** |
| Encoding | UTF-8, no BOM |
| Separator | `;` |
| Line endings | LF, with a trailing newline |
| Quoting | `"` (for example `SALE_DETAIL`) |
| Column count | every row has exactly 60 fields |
| Contact | no Mercado Pago API and no Supabase contact in this step |

Official documentation, fetched 2026-09-28:

| # | Page | URL |
|---|---|---|
| D1 | Account money report — introduction | https://www.mercadopago.com.ar/developers/es/docs/reports/account-money/introduction |
| D2 | Report uses (transaction types, `SETTLEMENT_NET_AMOUNT`) | https://www.mercadopago.com.ar/developers/es/docs/reports/account-money/how-to-use |
| D3 | Glossary / report fields | https://www.mercadopago.com.ar/developers/es/docs/reports/account-money/report-fields |

## 3. EXACT LAYOUT

**Ordered header (60):**

```
TRANSACTION_DATE;SETTLEMENT_DATE;MONEY_RELEASE_DATE;EXTERNAL_REFERENCE;SOURCE_ID;USER_ID;PAYMENT_METHOD_TYPE;PAYMENT_METHOD;SITE;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_CURRENCY;FEE_AMOUNT;SETTLEMENT_NET_AMOUNT;SETTLEMENT_CURRENCY;REAL_AMOUNT;COUPON_AMOUNT;METADATA;MKP_FEE_AMOUNT;FINANCING_FEE_AMOUNT;SHIPPING_FEE_AMOUNT;TAXES_AMOUNT;INSTALLMENTS;TAX_DETAIL;TAXES_DISAGGREGATED;SELLER_AMOUNT;CARD_INITIAL_NUMBER;OPERATION_TAGS;BUSINESS_UNIT;SUB_UNIT;PRODUCT_SKU;SALE_DETAIL;INVOICING_PERIOD;TRANSACTION_INTENT_ID;FRANCHISE;ISSUER_NAME;LAST_FOUR_DIGITS;ORDER_MP;TOTAL_COUPON_AMOUNT;IS_RELEASED;PAY_BANK_TRANSFER_ID;POS_ID;STORE_ID;STORE_NAME;EXTERNAL_POS_ID;POS_NAME;EXTERNAL_STORE_ID;POI_ID;SHIPPING_ID;SHIPMENT_MODE;ORDER_ID;PACK_ID;POI_WALLET_NAME;POI_BANK_NAME;PAYER_ID_TYPE;PAYER_ID_NUMBER;PAYER_NAME;PURCHASE_ID;SHIPPING_ORDER_ID;TIP_AMOUNT
```

- D3 documents a superset, which includes `DESCRIPTION`, `APPLICATION_ID`, `AUTHORIZATION_CODE`, `*_SHORT` dates and others. The export is configurable ("the default version will show an extended view", D2).
- **The parser must require an exact header**, as ADR-003 D1 does. A different column set is an ERROR, not a guess.

**Relevant columns:**

| Column | Observed format | Blank rows (of 294) | D3 type | Required for Step 16 |
|---|---|---|---|---|
| `TRANSACTION_DATE` | `yyyy-MM-ddTHH:mm:ss.SSS-03:00` | 0 | "Numeric (17)" (**conflicts** with the observed ISO datetime) | yes (validated, not the period determinant) |
| `SETTLEMENT_DATE` | `yyyy-MM-ddTHH:mm:ss.SSS-03:00` | 0 | DateTime `yyyy-MM-dd'T'HH:mm:ssZ` (observed adds `.SSS`) | **yes** |
| `MONEY_RELEASE_DATE` | same | 13 | DateTime | no (informational) |
| `SOURCE_ID` | 12 or 13 digits | 0 | String (100) | **yes** |
| `USER_ID` | 10 digits, 1 distinct value | 0 | String (19) | yes (account check) |
| `TRANSACTION_TYPE` | enum | 0 | String | **yes** |
| `TRANSACTION_AMOUNT` | `-?N.dd` | 0 | Numeric (17,2) | **yes** |
| `FEE_AMOUNT` | `N.dd` | 0 | Numeric (17,2) | **yes** |
| `MKP_FEE_AMOUNT`, `FINANCING_FEE_AMOUNT`, `SHIPPING_FEE_AMOUNT`, `COUPON_AMOUNT` | `N.dd` | 0 | Numeric (17,2) | yes (must be 0, see §6) |
| `TAXES_AMOUNT` | `-?N.dd` | 0 | Numeric (17,2) | **yes** |
| `TAXES_DISAGGREGATED` | `[]` or `[{financial_entity:…,amount:-N.dd,detail:…}]` | 0 | "String (255), JSON" (**not valid JSON**: unquoted keys and values) | **yes** |
| `SETTLEMENT_NET_AMOUNT` | `-?N.dd` | 0 | Numeric (17,2) | **yes** |
| `REAL_AMOUNT` | `-?N.dd` | 0 | Numeric (17,2) | yes (consistency check) |
| `TRANSACTION_CURRENCY`, `SETTLEMENT_CURRENCY` | `ARS` | 0 | String (10) | yes |
| `SITE` | `MLA` | 0 | String | yes |
| `PAYMENT_METHOD_TYPE` | enum | 13 | String | yes (classification input only) |
| `IS_RELEASED` | `true` / `false` | 0 | Boolean | no |
| `TAX_DETAIL` | `tax_debitos_creditos` or blank | 20 | String, documented values are **provinces** | no (see §7) |

Always blank in this export:
- `OPERATION_TAGS`, `PRODUCT_SKU`, `INVOICING_PERIOD`, `ORDER_MP`, `STORE_ID`, `STORE_NAME`, `EXTERNAL_STORE_ID`, `POI_ID`;
- `SHIPPING_ID`, `SHIPMENT_MODE`, `PACK_ID`, `POI_WALLET_NAME`, `POI_BANK_NAME`, `PURCHASE_ID`, `SHIPPING_ORDER_ID`.

Always `0.00`: `SELLER_AMOUNT`, `TOTAL_COUPON_AMOUNT`, `TIP_AMOUNT`.

Always `1`: `INSTALLMENTS`.

## 4. OBSERVED TRANSACTION TYPES

| TRANSACTION_TYPE | Count | Documented? (D2 / D3) |
|---|---|---|
| `SETTLEMENT` | 290 | yes: "Approved payment" |
| `PAYOUTS` | 4 | **no.** D3 lists `PAYOUT` ("cash withdrawal"), `WITHDRAWAL` ("transfer to a bank account") and `WITHDRAWAL_CANCEL`. `PAYOUTS` (plural) is not a documented value |

Documented but **not observed**:
- `REFUND`, `CHARGEBACK`, `DISPUTE`;
- `WITHDRAWAL`, `WITHDRAWAL_CANCEL`, `PAYOUT`, `CASHBACK`;
- `SETTLEMENT_SHIPPING`, `REFUND_SHIPPING`, `CHARGEBACK_SHIPPING`, `DISPUTE_SHIPPING`.

Observed row classes. The classification is structural, from report fields only:

| Class | Count | TRANSACTION_TYPE | PAYMENT_METHOD_TYPE / PAYMENT_METHOD | Signs TA / TAX / NET | TAXES_DISAGGREGATED | Other traits |
|---|---|---|---|---|---|---|
| **K1** | 274 | SETTLEMENT | `available_money` (213), `bank_transfer` (`cvu` 49, `debin_transfer` 10), `credit_card` (`naranja` 1, `visa` 1) | + / − / + | `financial_entity:debitos_creditos`, `detail:tax_withholding_collector` | `TAX_DETAIL = tax_debitos_creditos`; `IS_RELEASED = true` |
| **K2** | 7 | SETTLEMENT | `available_money` | − / − / − | `financial_entity:tax_withholding_payer`, `detail:tax_withholding_payer` | payer fields present; 4 with `EXTERNAL_REFERENCE`, `BUSINESS_UNIT = Mercado Pago`, `SUB_UNIT = QR`, POS / ORDER ids |
| **K3** | 9 | SETTLEMENT | blank / blank | + / 0 / + | `[]` | 13-digit `SOURCE_ID`; `IS_RELEASED = false`; no `MONEY_RELEASE_DATE`; no payer; `TRANSACTION_DATE = SETTLEMENT_DATE`; small amounts (146.50 – 1142.58) |
| **K4** | 2 | PAYOUTS | blank / blank | − / − / − | `financial_entity:tax_withholding_payout`, `detail:tax_withholding_payout` | `IS_RELEASED = false`; no `MONEY_RELEASE_DATE` |
| **K5** | 2 | PAYOUTS | blank / blank | − / 0 / − | `[]` | as K4, without tax |

## 5. AMOUNT / SIGN CONTRACT

Amounts are exported as plain decimals: `.` decimal separator, exactly 2 decimals, a leading `-` for negatives, no thousands separator. Signs are **frozen as exported**:

| Field | Observed sign | Evidence |
|---|---|---|
| `TRANSACTION_AMOUNT` | + for K1 / K3; − for K2 / K4 / K5; never 0 | 283 +, 11 − |
| `FEE_AMOUNT` | always 0.00 | sign unobserved |
| `MKP_FEE_AMOUNT`, `FINANCING_FEE_AMOUNT`, `SHIPPING_FEE_AMOUNT`, `COUPON_AMOUNT` | always 0.00 | — |
| `TAXES_AMOUNT` | ≤ 0: 283 negative, 11 zero, **never positive**, including on the money-out rows | — |
| `SETTLEMENT_NET_AMOUNT` | same sign as `TRANSACTION_AMOUNT` in 294/294; never 0 | — |
| `REAL_AMOUNT` | equals `SETTLEMENT_NET_AMOUNT` in 294/294 | — |

**Direction:** `SETTLEMENT_NET_AMOUNT > 0` is money into the Mercado Pago balance; `< 0` is money out. D2: "in the `SETTLEMENT_NET_AMOUNT` column you will find the real impact on your account money balance." **FROZEN.**

## 6. FEE CONTRACT

- **Mercado Pago fee:** `FEE_AMOUNT`. D3: "Sum of the processing, shipping, installments and coupon fees if it was at seller's expense. Includes VAT."
  - DOCUMENTED; observed as 0.00 in 294/294.
  - A non-zero fee's sign is **NOT OBSERVED**. The Step-16 rule stays `fee ≤ 0`, as in ADR-003 D1. It is consistent with the zero observations but still unproven for a non-zero fee.
- **Marketplace fee:** `MKP_FEE_AMOUNT` ("Mercado Libre fee, includes VAT"). DOCUMENTED; 0.00 in 294/294.
- **Other fee components:** `FINANCING_FEE_AMOUNT`, `SHIPPING_FEE_AMOUNT`, `COUPON_AMOUNT`: DOCUMENTED, all 0.00. D3 says `FEE_AMOUNT` already sums processing, shipping, installments and coupon fees at the seller's expense. Their additive role in the identity is therefore **not frozen**.
- **Step 16 rule:** a non-zero value in any of them is an ERROR, not a guess.

## 7. TAX CONTRACT

- **Total tax:** `TAXES_AMOUNT`.
  - D3: "Tax collected for withholdings of Gross Income, VAT, Profits; and taxes on Credits and Debits, among others."
  - DOCUMENTED and OBSERVED. Always ≤ 0. **FROZEN** as the tax component.
- **Disaggregated tax:** `TAXES_DISAGGREGATED`.
  - D3 says "Detailed taxes in the JSON format". **Observed: not JSON.** Keys and values are unquoted, for example `[{financial_entity:debitos_creditos,amount:-90.00,detail:tax_withholding_collector}]`.
  - Structure (294/294):
    - either `[]` (11 rows) or exactly one object (283 rows);
    - keys always in the order `financial_entity, amount, detail`;
    - `amount` formatted `-N.dd`.
  - **Σ `amount` = `TAXES_AMOUNT` in 294/294.**
  - Observed `financial_entity` / `detail` pairs, preserved exactly:

| `financial_entity` | `detail` | Rows |
|---|---|---|
| `debitos_creditos` | `tax_withholding_collector` | 274 (K1) |
| `tax_withholding_payer` | `tax_withholding_payer` | 7 (K2) |
| `tax_withholding_payout` | `tax_withholding_payout` | 2 (K4) |

  - The key names and values are **not documented**. The documentation-versus-observation conflict (JSON versus non-JSON) makes the **semantic labels AMBIGUOUS**.
  - Only the structural parse and `Σ amount = TAXES_AMOUNT` are frozen, as a validation.
- **Tax detail:** `TAX_DETAIL`.
  - D3 lists only **province** values (`cordoba`, `santa_fe`, …). Observed values: `tax_debitos_creditos` (274) or blank (20). This conflicts with D3.
  - **AMBIGUOUS.** Not an input to Step 16.
- **Rate observation (not frozen):** `|TAXES_AMOUNT| / |TRANSACTION_AMOUNT|` = 0.60 % in 283/283 non-zero rows.

## 8. NET CONTRACT

**Identity, exact to the cent over all 294 rows:**

```
TRANSACTION_AMOUNT + FEE_AMOUNT + MKP_FEE_AMOUNT + TAXES_AMOUNT = SETTLEMENT_NET_AMOUNT
```

It still holds when `FINANCING_FEE_AMOUNT`, `SHIPPING_FEE_AMOUNT` and `COUPON_AMOUNT` are added, because they are all 0. `REAL_AMOUNT = SETTLEMENT_NET_AMOUNT` in 294/294.

**`TRANSACTION_AMOUNT`:**
- D3 labels it both "Purchase amount" and, in its description, "Transaction net amount".
- D2 says each type carries "the gross amount of the operation".
- The arithmetic proves it is the amount **before** fees and taxes, which is D2's reading.
- The internal inconsistency in D3 is recorded. **FROZEN as gross**, per D2 and the arithmetic.

**Frozen for Step 16:**

| Component | Field |
|---|---|
| gross | `TRANSACTION_AMOUNT` |
| fee | `FEE_AMOUNT` + `MKP_FEE_AMOUNT` |
| tax | `TAXES_AMOUNT` |
| net | `SETTLEMENT_NET_AMOUNT` |

All are signed as exported. The validation is `gross + fee + tax = net` exactly, with no rounding tolerance and NUMERIC(15,2). `REAL_AMOUNT = net` is also required.

Gross and net are derived **only from documented report fields**; no API field is needed.

## 9. IDENTITY / IDEMPOTENCY CONTRACT

| Candidate | Documented | Populated | Unique in file | Notes |
|---|---|---|---|---|
| `SOURCE_ID` | "Mercado Pago transaction ID (e.g. an order payment)", String (100) | 294/294 | yes (0 duplicates, including across types) | 12 digits (285 rows), 13 digits (9 rows, all K3) |
| `EXTERNAL_REFERENCE` | yes; "might be empty…" | 4/294 (K2 only) | yes | not an identity |
| `TRANSACTION_INTENT_ID` | "Transaction intent identifier" | 228/294 | yes | not universal |
| `PAY_BANK_TRANSFER_ID` | yes | 59/294 | yes | bank transfers only |
| `ORDER_ID` | yes | 4/294 | yes | QR only |

Neither D3 nor D2 documents that `SOURCE_ID` is unique **per report row**. A documented `REFUND` or `CHARGEBACK` row for a payment would plausibly carry that payment's id again; this is not observed. **`SOURCE_ID` is not declared equivalent to an API payment id** (V-4).

**INTERNAL_IDEMPOTENCY_POLICY** (mirrors ADR-003 D1):

```
external_id = 'AM:' || TRANSACTION_TYPE || ':' || SOURCE_ID || ':' || direction
direction   = 'C' if SETTLEMENT_NET_AMOUNT > 0, 'D' if < 0   (a net of 0 is an ERROR)
```

- It is unique over the 294 rows, with 0 collisions.
- Rows without `SOURCE_ID`, `TRANSACTION_TYPE` or `SETTLEMENT_DATE` are ERROR.
- A re-imported row with the same `external_id` but different content is a versioned source conflict: REVIEW, never merged, following the existing raw-guard behaviour.
- Types with possibly repeated ids (for example multiple partial refunds) are not observed. Their identity stays **open**, and the parser rejects them (§13).

## 10. DATE / COVERAGE CONTRACT

| Column | Format | Offset | Documented semantics | Observed |
|---|---|---|---|---|
| `TRANSACTION_DATE` | `yyyy-MM-ddTHH:mm:ss.SSS±hh:mm` | `-03:00` (294) | "Transaction creation date" | ≤ `SETTLEMENT_DATE` always: equal in 123, earlier in 171 |
| `SETTLEMENT_DATE` | same | `-03:00` (294) | "Approval date"; D1: movements enter the report "when the operation is approved" | range 2026-09-11T02:18:29 → 2026-09-23T13:03:39 (-03:00); file ordered by it, **descending** |
| `MONEY_RELEASE_DATE` | same | `-03:00` (281) | "Date in which each installment payment will be released" | blank for K3 / K4 / K5 (13); **earlier than `SETTLEMENT_DATE` in 47 rows**, which is unexplained; not used |

- **Row occurrence (FROZEN):**
  - `occurred_at = SETTLEMENT_DATE` with its exported offset.
  - `occurred_date = (occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`, the period determinant, as in ADR-003 D1.
- **Coverage:**
  - The export carries **no coverage metadata**: no requested from / to and no header line. Only the file-name generation timestamp.
  - `min` / `max` of `SETTLEMENT_DATE` bound the rows present, not the requested period.
  - The first and last days may be partial: the last row is 13:03 on the generation day.
- **INTERNAL_POLICY for R3 (`mp_check_report_coverage`, report type Account Money):**
  - `coverage_from = occurred_date(min SETTLEMENT_DATE) + 1 day`;
  - `coverage_to = occurred_date(max SETTLEMENT_DATE) − 1 day`;
  - that is, only full interior days.
  - This avoids false `MISSING_IN_REPORT` on partial boundary days.
  - If the owner later supplies the exact requested range with each upload, that range replaces this policy.
  - The Liberaciones min / max DATE rule is **not** reused.

## 11. REPORT TRANSITION MAPPING

| Class | Parser result (Step 16) | movement_kind candidate | Transition candidate | A1 applies eventually? | ADMIN action required? | V-4 blocks payment interpretation? |
|---|---|---|---|---|---|---|
| K1 `SETTLEMENT` +, with a payment method | parsed and validated; **REPORT_ONLY / DEFERRED** evidence | `payment` (money received) | APPROVAL evidence for an API payment | only after V-4 proves report ↔ API equivalence, or through the R2 report fallback | no, for parsing | **yes** |
| K2 `SETTLEMENT` −, `tax_withholding_payer` | parsed; claim `('payment', SOURCE_ID, 'OUTBOUND_PAYMENT', '')` + movement + REPORT_ONLY; **REVIEW_REQUIRED** | `payment` (outbound) | `OUTBOUND_PAYMENT` (V-4 direction correction; owner-confirmed 7/7, §15) | **never** | **yes**: the owning domain RPC + RPC 41 Mode 2; payer-side tax through Mode 1 `ADJUSTMENT`. No automatic supplier classification | V-4 proven: the id is a payment resource made by the account |
| K3 `SETTLEMENT` +, no payment method, zero tax, 13-digit id | parsed; claim `('report', external_id, 'YIELD', '')` + movement + REPORT_ONLY | **`yield`** (owner-confirmed 9/9, §15) | `YIELD` | **yes**: A1, a single `MP_SETTLEMENT` = net; P&L Otros ingresos financieros; no attribution | no | n/a (not a payment id) |
| K4 / K5 `PAYOUTS` − | parsed; claim `('report', external_id, 'OUTBOUND_PAYMENT', '')` + movement + REPORT_ONLY; **REVIEW_REQUIRED** | `outflow` (heterogeneous outbound treasury movement, §15) | `OUTBOUND_PAYMENT` | **never** | **yes**: `pay_supplier` / `transfer_between_accounts` / `pay_fiscal_obligation` / another supported flow, then RPC 41 Mode 2; the payout withholding through Mode 1 `ADJUSTMENT`. **Not** the Liberaciones `payout` mapping | n/a (not a payment id) |
| Any other `TRANSACTION_TYPE` | **ERROR (unsupported)** | — | — | — | — | — |

- ADR-006's report-only kinds CHARGEBACK and ACCOUNT_TAX are **not observed**.
- Tax exists only attached to rows (collector, payer and payout withholdings); there is **no standalone account-tax row**.

## 12. NON-FINDINGS

- **Not observed:** `REFUND`, `CHARGEBACK`, `DISPUTE`, `WITHDRAWAL`, `WITHDRAWAL_CANCEL`, `PAYOUT`, `CASHBACK`, and all `*_SHIPPING` types.
- **No standalone account-tax row. No fee refund.** Every fee column is 0.
- **No balance column.** The layout has no running balance (no `BALANCE_AMOUNT` equivalent), so **R4 `mp_record_balance_check` has no Account Money field**, and this export cannot check the balance.
- **`PAYOUTS`** is an undocumented type value. Its meaning is now owner-verified as heterogeneous (§15.2).
- ~~The business meaning of K2 / K3 / K4 / K5 is unproven.~~ **Resolved by owner evidence (§15):** K2 outbound payment, K3 yield, K4 / K5 heterogeneous outflow.
- **`TAXES_DISAGGREGATED`** is documented as JSON but is not JSON, and its keys are undocumented.
- **`TAX_DETAIL`** values conflict with D3.
- **`TRANSACTION_DATE`** is documented as numeric but observed as a datetime.
- **`MONEY_RELEASE_DATE` earlier than `SETTLEMENT_DATE`** in 47 rows is unexplained.
- **The file carries no coverage period.**
- **`account_fund` question (V-4):**
  - No report type is named for owner funding.
  - The 49 K1 rows with `PAYMENT_METHOD = cvu`, a `PAY_BANK_TRANSFER_ID`, no payer fields and `SALE_DETAIL = "Bank Transfer"` are structurally consistent with incoming CVU transfers.
  - Whether any of them is an API `account_fund` is **not decided here**.
- **`SOURCE_ID` ↔ API payment id equivalence:** not decided here (V-4).

## 13. STEP-16 PARSER CONTRACT

**Required input** (exact header in §3, all 60 columns present; raw strings):

- `TRANSACTION_TYPE`, `SOURCE_ID`, `USER_ID`, `SITE`, `TRANSACTION_CURRENCY`, `SETTLEMENT_CURRENCY`;
- `TRANSACTION_DATE` (format validation and `≤ SETTLEMENT_DATE`), `SETTLEMENT_DATE`;
- `TRANSACTION_AMOUNT`, `FEE_AMOUNT`, `MKP_FEE_AMOUNT`, `FINANCING_FEE_AMOUNT`, `SHIPPING_FEE_AMOUNT`, `COUPON_AMOUNT`;
- `TAXES_AMOUNT`, `TAXES_DISAGGREGATED` (structural parse; `Σ amount = TAXES_AMOUNT`);
- `SETTLEMENT_NET_AMOUNT`, `REAL_AMOUNT` (must equal net);
- `PAYMENT_METHOD_TYPE`, used only to separate K1 from K3.

**Validation (any failure → ERROR):**

- exact header;
- 60 fields;
- amounts `-?\d+\.\d{2}`;
- currency `ARS`, site `MLA`;
- a single `USER_ID` equal to the configured account;
- `FINANCING_FEE_AMOUNT` = `SHIPPING_FEE_AMOUNT` = `COUPON_AMOUNT` = 0;
- fee ≤ 0 and tax ≤ 0;
- `gross + fee + tax = net`;
- `REAL_AMOUNT = net`;
- net ≠ 0;
- `SOURCE_ID` present;
- `SETTLEMENT_DATE` parses;
- `external_id` (§9) derivable.

**Outputs per class:** as in §11.
- K1: inbound candidate (APPROVAL only through the API / R2).
- K2: `OUTBOUND_PAYMENT`.
- K3: `YIELD`.
- K4 / K5: `OUTBOUND_PAYMENT` (`outflow`).
- Anything else: ERROR.

**The K3 structural contract** (all of these must hold; otherwise the row is not K3):
- `TRANSACTION_TYPE = SETTLEMENT`;
- `PAYMENT_METHOD_TYPE` and `PAYMENT_METHOD` blank;
- `TRANSACTION_AMOUNT > 0`;
- `TAXES_AMOUNT = 0.00` and `TAXES_DISAGGREGATED = []`;
- `FEE_AMOUNT = 0.00`;
- a 13-digit `SOURCE_ID`;
- `IS_RELEASED = false`;
- `MONEY_RELEASE_DATE` blank.

A row that fails any part of this shape is not yield. It becomes ERROR (unclassified).

**Forbidden as business / accounting authority:**

- `PAYER_NAME`, `PAYER_ID_TYPE`, `PAYER_ID_NUMBER`, `SALE_DETAIL`, `METADATA`, `EXTERNAL_REFERENCE`;
- `TRANSACTION_INTENT_ID`, `PAY_BANK_TRANSFER_ID`;
- POS / store / order / shipping / card fields: `CARD_INITIAL_NUMBER`, `LAST_FOUR_DIGITS`, `FRANCHISE`, `ISSUER_NAME`;
- `BUSINESS_UNIT`, `SUB_UNIT`, `TAX_DETAIL`;
- `MONEY_RELEASE_DATE`, `IS_RELEASED`;
- the `TAXES_DISAGGREGATED` labels;
- every other column.

Personal columns (payer, card) must not be stored beyond what ADR-003 already stores verbatim for the raw source row. Whether to strip them at upload is a Step-16 design point.

**Sanitized fixture:** [`scripts/target-db/fixtures/adr006-v3-account-money.json`](../../scripts/target-db/fixtures/adr006-v3-account-money.json). It has 10 rows × 60 columns covering K1 (5 shapes), K2 (2), K3, K4 and K5.

## 14. RELATION TO V-2

**Resolved by V-3:**
- **Documented fee / tax separation.** The report documents `FEE_AMOUNT` (seller-side fees incl. VAT, 0 here) and `TAXES_AMOUNT` (withholdings incl. the credits / debits tax, here 0.6 %) separately. The identity `gross + fee + tax = net` holds on documented fields in 294/294.
  - V-2 could not prove this from the API. There, `fee_details` is empty, `charges_details` is undocumented, and `taxes_amount` is 0 despite the withholding.
- **The API's collector withholding matches the report.** The report shows a collector-side withholding of the same kind (`debitos_creditos` / `tax_withholding_collector`, 0.6 %). This is consistent with V-2's `charges_details` observation, but that does **not** make `charges_details` documented.
- **Seller-side Mercado Pago fee.** It is 0 in every observed row of both sources.

**Still open:**
- linking a report row to an API payment (`SOURCE_ID` ↔ `id`): V-4;
- `payer.id` type ambiguity;
- `external_reference`: 4 report rows only, all money-out (K2);
- refund, chargeback and dispute: unobserved in both;
- the refund transition date;
- the business classification of `account_fund`;
- the API-side component source for Step 6: until V-4, the per-component split has an authoritative documented source only in the report.

## 15. OWNER EVIDENCE ADDENDUM (2026-09-28)

**Source.** The owner inspected each movement manually in the Mercado Pago application and supplied its business meaning. This is owner-observed business evidence, not an inference from field names. The owner supplied 22 real `SOURCE_ID`s. They are **not** reproduced here (no real ids in the repository).

They were cross-checked locally against the export:

| Owner classification | Ids given | Found in export | V-3 class | Class coverage |
|---|---|---|---|---|
| Investment return / rendimiento | 9 | 9 | K3: 9/9 | **all** 9 K3 rows |
| Outbound payment made by the account (QR purchases / payments, a transfer payment for an input) | 7 | 7 | K2: 7/7 | **all** 7 K2 rows |
| `PAYOUTS`: payment to a supplier by transfer | 2 | 2 | K4: 2/2 | 4 PAYOUTS rows in total, **all** classified |
| `PAYOUTS`: withdrawal / transfer to the owner's own account | 2 | 2 | K5: 2/2 | (same) |

### 15.1 K3: VERIFIED yield

- The K3 structural class (§13) is **yield**: `movement_kind = 'yield'`, transition `YIELD`, identity `('report', external_id, 'YIELD', '')`.
- Treatment (existing ADR-006):
  - report-only;
  - A1 applies a single `MP_SETTLEMENT` equal to net;
  - no client attribution;
  - P&L Otros ingresos financieros (ADR-004 D10).
- Evidence:
  - the structural pattern;
  - 9 independent rows;
  - owner verification;
  - V-4: not a payment id.
- Not generalized beyond the §13 K3 shape.

### 15.2 PAYOUTS: VERIFIED heterogeneous outbound treasury class

- Account Money `PAYOUTS` is **not one business type**. The same `TRANSACTION_TYPE` covers supplier payments and own-account withdrawals.
- **Freeze:**
  - a confirmed outbound treasury movement;
  - `movement_kind = 'outflow'`;
  - identity `('report', external_id, 'OUTBOUND_PAYMENT', '')`, REPORT_ONLY;
  - **REVIEW_REQUIRED**;
  - never auto-applied (`OUTBOUND_PAYMENT` is not in `mp_is_auto_applicable`);
  - never client-attributed (not APPROVAL → `NOT_A_RECEIPT`).
- **ADMIN resolution** (existing domain ownership):
  - supplier → `pay_supplier(…, p_financial_account_id = MP account)`;
  - own account → `transfer_between_accounts(…)`;
  - fiscal → `pay_fiscal_obligation(…)`;
  - otherwise, another supported domain flow, or the row stays in review.

  Then RPC 41 **Mode 2** links the movement to the domain operation's MP posting (no duplicate posting). The `tax_withholding_payout` component, if any, goes through Mode 1 `ADJUSTMENT`.
- **Observation, not a rule:**
  - both supplier payments carried `tax_withholding_payout` (K4);
  - both own-account withdrawals carried no tax (K5).
  - With 2 + 2 rows this is **not** a classification rule. Neither K4 nor K5 is auto-mapped to a business flow.
- **Not** reinterpreted as the Liberaciones `payout` (`transfer`, ADR-003 D1). That mapping is unchanged.

### 15.3 K2: VERIFIED outbound payment

- All 7 K2 rows are payments made by the account. This confirms the V-4 direction correction:
  - `OUTBOUND_PAYMENT`, REPORT_ONLY / REVIEW_REQUIRED;
  - not auto-applicable;
  - not a receipt;
  - not client-attributable.
- An outbound payment is **not** automatically a supplier payment. The ADMIN chooses the flow.

### 15.4 Open: cross-report identity of report-only kinds

- Liberaciones report-only identities use the ADR-003 composite `SOURCE_ID:DESCRIPTION:C/D`. Account Money uses `AM:TRANSACTION_TYPE:SOURCE_ID:C/D` (§9).
- If the same yield or outflow appears in **both** reports, the two keys differ, so the transition identity would **not** de-duplicate it.
- The available exports do not overlap in time (Liberaciones ≤ 2026-09-04; Account Money ≥ 2026-09-11), so whether both reports carry the same `SOURCE_ID` for these kinds is **unproven**.
- Until an overlapping Liberaciones + Account Money pair proves a shared `SOURCE_ID`, and the report-only identity is keyed on it, the two report types must **not** both be ingested for report-only kinds over the same period.
- This is a precondition for enabling the Account Money report-only claims (Step 16). Payment rows are not affected: their identity is keyed on the payment id (V-4).
