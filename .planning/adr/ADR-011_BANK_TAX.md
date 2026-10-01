# ADR-011 — Bank tax (Impuesto a los Débitos y Créditos) as its own treasury operation

**STATUS:** **ACCEPTED** (owner decision D-WALK-7, 2026-09-30, Phase 27 manual walkthrough). Implemented by migration `0062_bank_tax.sql`; recorded as part of the "Phase 27 acceptance fixes".
**DATE:** 2026-09-30
**RAISED BY:** the owner walkthrough. A bank transfer is charged the Débitos/Créditos tax, and the target had no place to record it.
**AFFECTS (FROZEN):** RPC_CONTRACTS_V1 (new RPC 46; inventory 45 → 46); the SECURITY DEFINER set (62 → 63); `financial_operation_type` (+ `BANK_TAX`); `tax_kind` (+ `DEBITOS_CREDITOS`); a new table `bank_tax_charge`; a new view `report_bank_tax_period`.
**NOT AFFECTED:**
- `transfer_between_accounts` (RPC 39), unchanged;
- the P&L (`pnl_line_item`, `pnl_summary`): BANK_TAX does not enter it;
- the Mercado Pago `tax_amount` treatment, and MP `account_tax` (V-3, still deferred).

---

## 1. Decision (owner, D-WALK-7)

| Id | Decision |
|---|---|
| BT-1 | The tax is a **separate** `financial_operation` of type `BANK_TAX`, with **one negative posting** on the taxed account. It is never folded into the transfer's postings. |
| BT-2 | It can be related to the TRANSFER it belongs to. The relation is authoritative: `bank_tax_charge.related_operation_id` is an FK to `financial_operation`, and the target must be a TRANSFER. The relation is optional. `financial_operation.source_entity_type / source_entity_id` mirror it. |
| BT-3 | `tax_kind = DEBITOS_CREDITOS`; it is the only kind recorded manually. |
| BT-4 | It is manual only for non-MP accounts. The Mercado Pago account (identity rule of 0048 / 0051) is refused: `MP_ACCOUNT_NOT_ALLOWED`. |
| BT-5 | **Not in the P&L (fail-closed).** No P&L view reads `financial_operation`, `financial_posting` or `bank_tax_charge`. Any future P&L treatment needs its own owner decision. |
| BT-6 | The report shows period, tax kind, account and amount paid. It shows no computability percentage. |
| BT-7 | Transfer and tax are **not** one atomic call. The UI runs the transfer and then the tax. If the tax fails, the user sees a clear partial success. A retry registers only the tax (never a second transfer); the tax is idempotent by `external_ref` (`<transfer ref>-IDC`). A tax can also be added later from the transfer history. |

## 2. RPC 46 `register_bank_tax`

**Signature:**
```
register_bank_tax(p_account_id UUID, p_amount NUMERIC, p_effective_date DATE, p_tax_kind tax_kind,
                  p_external_ref VARCHAR, p_related_operation_id BIGINT DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB
```

- **Actor:** ADMIN only. SECURITY DEFINER; EXECUTE for `authenticated` only.
- **Period determinant:** `p_effective_date`, checked with `assert_period_open`.

**Validation, in order:**
1. `FORBIDDEN`;
2. `INVALID_AMOUNT`: the amount must be > 0 with at most 2 decimals;
3. `INVALID_DATE`;
4. `INVALID_TAX_KIND`: only `DEBITOS_CREDITOS`;
5. `EXTERNAL_REF_REQUIRED`;
6. idempotency:
   - an exact replay (same reference, account, amount, date, kind and related operation) returns `{financial_operation_id, replayed: true}` and writes nothing;
   - any other use of the reference → `DUPLICATE_BANK_TAX`;
7. `ACCOUNT_NOT_FOUND_OR_INACTIVE`;
8. `MP_ACCOUNT_NOT_ALLOWED`;
9. `RELATED_TRANSFER_NOT_FOUND`;
10. `PERIOD_NOT_FOUND` / `PERIOD_CLOSED`.

**Atomic steps:**
- one `financial_operation` row (`BANK_TAX`);
- one `financial_posting` row (`−amount` on the account);
- one `bank_tax_charge` row;
- one `audit_events` row (`BANK_TAX`).

**Returns:** `{financial_operation_id, posting_id, replayed: false}`.

## 3. Storage and report (0062)

- **`bank_tax_charge`:**
  - columns: `financial_operation_id` PK/FK, `tax_kind`, `financial_account_id` FK, `amount > 0`, `related_operation_id` FK nullable, `created_at`, `created_by`;
  - RLS with an ADMIN SELECT policy; `authenticated` has SELECT only; no direct write.
- **`report_bank_tax_period`:**
  - `security_invoker`, with an ADMIN predicate;
  - columns: `period, tax_kind, financial_account_id, account_name, amount_paid, charges`;
  - SELECT for `authenticated` only.
- **Enums:** `ALTER TYPE … ADD VALUE` (precedent: 0043). The new values appear only inside the function body, or compared as text, so they are safe inside the runner's transaction.

## 4. Verification

- `scripts/target-db/bank_tax.test.mjs`:
  - perimeter, validation, the single posting and the FK relation;
  - idempotency, the MP refusal and the closed period;
  - the report, OPERATOR access, an unchanged P&L fingerprint, and that no P&L view reads the treasury tables;
  - `transfer_between_accounts` unchanged.
- `tests/unit/walk-acceptance.test.ts`: transfer + tax ordering, partial success, and a retry without a second transfer.
- `tests/integration/walk-acceptance.test.ts`: the history with the related tax, partial success and retry against the local API, the report, and OPERATOR refusal.
- The SECURITY DEFINER inventories of the backend suites are updated 62 → 63.
