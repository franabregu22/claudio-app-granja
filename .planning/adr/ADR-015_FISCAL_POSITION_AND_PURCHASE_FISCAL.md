# ADR-015 — Fiscal position report, purchase fiscal document, finance UX

**STATUS:** **ACCEPTED** (owner decisions D-FISCAL-1…8, D-FIN-1, D-FIN-2, 2026-10-01, Phase 27 manual walkthrough). Implemented by migration `0068_purchase_fiscal_and_fiscal_report.sql`; recorded as part of the "Phase 27 acceptance fixes".
**DATE:** 2026-10-01
**RAISED BY:** the owner walkthrough. Three problems:
- Fiscal was an entry screen, with no consolidated position;
- a purchase invoice had to be re-typed in Fiscal, with no link to the purchase;
- "Retiro" in Finanzas did not read as a partner withdrawal.

**AFFECTS (FROZEN):**
- TARGET_ARCHITECTURE_V2_FROZEN Part 18 (amendment note);
- RPC_CONTRACTS_V1: the new RPC 50; the inventory grows 49 → 50;
- PHASE_25_REPORTING: the new view `report_fiscal_period`;
- the SECURITY DEFINER set (+1).

**NOT AFFECTED:**
- RPC 13 `register_purchase` and RPC 34 `register_fiscal_document` (unchanged; RPC 50 calls them);
- the P&L (ADR-004): purchases still enter by `amount_total`, and no VAT is subtracted from cost;
- RPC 43 `register_management_event` and its P&L lines;
- the fiscal schema (no table or column added).

---

## 1. Fiscal is report-first (D-FISCAL-1 / D-FISCAL-7)

- Fiscal shows, in this order:
  1. the consolidated position (`report_fiscal_period`);
  2. obligations;
  3. payments;
  4. documents.
- Purchase documents originate in **Caja → Compras → Nueva compra → "Datos fiscales (opcional)"**.
- "Registrar comprobante manual" stays as a **secondary** path for sales documents and standalone documents, while no originating module supports them.

## 2. `report_fiscal_period` (D-FISCAL-2 / D-FISCAL-3)

- **Access:** ADMIN only (security_invoker plus an ADMIN predicate; SELECT for `authenticated` only).
- **Columns:** `period, tax_kind, debit_amount, credit_amount, debit_documents, credit_documents, period_difference`.
- **Debit vs credit:** the **document direction** decides: DEBITO = issued to a client (sale), CREDITO = received from a supplier (purchase).
- **Amounts:** each component's `tax_amount` is summed as loaded.
- **Credit notes:** a `CREDIT_NOTE` contributes its amount with the opposite sign, so a customer credit note reduces debit and a supplier credit note reduces credit. Stored amounts are never rewritten. No other tax-law treatment is applied.
- **`period_difference = debit_amount − credit_amount`:**
  - backend-derived and **informational**: shown as "Diferencia del período";
  - **not** a VAT payable, balance in favour or filing amount;
  - **nothing is carried forward** between periods. That rule is pending the accountant.
- **Other tax kinds** (retentions, perceptions, IIBB, Ganancias, other) appear on their own rows, as loaded.

## 3. RPC 50 `register_purchase_with_fiscal_document` (D-FISCAL-4 / D-FISCAL-5)

- **Signature:** `(p_supplier_id, p_economic_date, p_amount_net, p_amount_total, p_expense_category_id, p_nature, p_lines, p_attachments, p_idempotency_key, p_fiscal_document_type, p_fiscal_period, p_fiscal_net_amount, p_fiscal_total_amount, p_fiscal_components, p_subcategory?, p_project_id?, p_supplier_invoice_number?, p_flock_id?, p_reason?) RETURNS JSONB`.
- **Who:** ADMIN; SECURITY DEFINER; EXECUTE for authenticated only.
- **Narrowest safe contract:** a wrapper. In ONE transaction it calls:
  1. RPC 34 with direction `CREDITO`, the purchase supplier, document date = economic date, and number = supplier invoice number;
  2. RPC 13 with the new `fiscal_document_id`.

  Any error rolls back both. A purchase without fiscal data keeps calling RPC 13 alone, so the frozen RPCs 13 / 34 are not amended.
- **Validation added by the wrapper:**
  - ADMIN;
  - `INVALID_DOCUMENT_TYPE`: a credit or debit note does not document a purchase;
  - `INVALID_AMOUNT`;
  - `INVALID_COMPONENTS`: an array, each item with tax_kind, base_amount, rate_applied and tax_amount; direction defaults to CREDITO.

  All other rules are RPC 34's and RPC 13's (`DUPLICATE_FISCAL_DOCUMENT`, `CATEGORY_REQUIRED`, period, …).
- **Amounts:** stored exactly as typed. Nothing is derived (no rate × base, no total − VAT) in the backend or in React.
- **Attachments:** they stay independent and optional (ADR-010). With files, the ADR-008 upload → RPC → compensation sequence is unchanged and calls RPC 50 instead of RPC 13.

## 4. Sales fiscal linkage — DEFERRED (D-FISCAL-6)

- No `pedido` ↔ `fiscal_document` link in V1.
- First the invoicing lifecycle must be defined: when a sale becomes documentable, which entity owns the link, the credit-note lifecycle, and any future invoicing integration.
- Until then, sales documents are registered manually in Fiscal.

## 5. Future document recognition (D-FISCAL-8)

- Not implemented. The schema is compatible: extracted and verified fields map to RPC 34 / RPC 50 inputs, and the purchase links the document.
- Missing for that future, not added now:
  - an attachment owned by the fiscal document (attachments belong to purchases);
  - the provenance / verification status of extracted fields;
  - the sales link (§4).

## 6. Finance (D-FIN-1 / D-FIN-2)

- **RETIRO is shown as "Retiro de socios"** and registered from **Caja → Más acciones**, since it moves money.
  - ADR-004 treatment unchanged: an `OWNER_WITHDRAWAL` treasury operation, and the P&L line "Retiros" below the operating / reinvestment result.
  - It never reduces the operating result, and it is never a purchase or expense category.
- **RESERVA_INTERNA** moves to **Finanzas → Más acciones**. Backend and P&L line unchanged (zero when unused).

## 7. Verification

- `scripts/target-db/fiscal_report.test.mjs` (23 checks):
  - the report: debit / credit, aggregation, customer and supplier credit notes, separate periods, no carry-forward, other tax kinds, columns, ADMIN-only, security_invoker, P&L unchanged;
  - RPC 50: link, exact components, P&L by amount_total, rollback on an invalid component / purchase / type / duplicate, OPERATOR refused, the plain RPC 13 path, invoice without components, perimeter.
- `tests/unit/fiscal-finance.test.ts`:
  - no derivation, payload, routing to RPC 50;
  - no tax formula in the screens;
  - "Retiro de socios" in Caja → Más acciones, reserve as a secondary action, same RPC.
- `tests/integration/fiscal-finance.test.ts`: the report, the atomic purchase and its rollback, and the operating result unchanged by a partner withdrawal.
