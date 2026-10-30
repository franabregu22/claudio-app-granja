# ADR-019 — Optional supplier: casual purchases

**STATUS:** **ACCEPTED** (owner decision "option A", 2026-10-15; approved in principle and amended the same day: fiscal evidence without a recurring supplier, optional counterparty name, one payment per casual purchase, one economic classification per MP SOURCE_ID, amount-locked rectification). Not implemented yet: migrations 0088 (model) and 0089 (MP classification) follow under their own GO.
**DATE:** 2026-10-15
**RAISED BY:** META A — classifying Mercado Pago outflows. The 13/10 payout (SOURCE_ID 183984533002, 759,702.86) is a real purchase paid to a counterparty that is not, and should not be, a registered supplier. Today `purchases.supplier_id` is `NOT NULL` (0019) and every purchase writes the supplier current account, so the only way to record it would be a fictitious supplier.
**AFFECTS (FROZEN):**
- POSTGRES_SCHEMA_SPEC_V1 `purchases` (supplier_id nullability, new columns, constraints) and `fiscal_document` (issuer identity for a document without a recurring supplier);
- RPC_CONTRACTS_V1 RPC 13 `register_purchase` (unchanged — §4), RPC 14 `rectify_purchase` (casual branch), RPC 34 `register_fiscal_document` (optional issuer fields, appended), new RPC `register_casual_purchase`;
- DATABASE_INVARIANTS_V1: "every purchase recognises a supplier liability" becomes "every purchase WITH a supplier recognises a supplier liability; a casual purchase is born paid by exactly one payment operation"; invariant 25 (fiscal number unique per supplier) gains the issuer-tax-id form;
- `financial_operation_type` (new value `PURCHASE_PAYMENT`);
- the not-yet-deployed MP outflow classification (current 0088), re-planned as 0089 (§9).

**NOT AFFECTED:**
- purchases WITH a supplier: register, rectify, supplier ledger, `pay_supplier`, partial / total payments, advances (negative supplier balance), instruments, cheques, freight debt — same contracts;
- the P&L model: `pnl_line_item` reads `purchases` (current version, `amount_total`, `economic_date`, category / nature) and never reads the supplier;
- the IVA computation: `report_fiscal_period` aggregates `fiscal_document_component` by period / tax kind / direction and never reads the supplier;
- `purchase_attachment` (ADR-008 / ADR-010), versioning (ADR-002 keys), the period guard.

---

## 1. Decision (owner)

1. `purchases` stays the ONLY general source of purchases / expenses for the P&L. No second "direct expense" table or P&L source.
2. Two modalities:
   - **Registered (recurring) supplier** — `supplier_id = <supplier>`; current-account semantics exactly as today (debt, payment, advance).
   - **Casual purchase** — `supplier_id IS NULL`; never touches the supplier current account; optional free counterparty name; **born paid** from a financial account in the same transaction.
3. Two concepts are kept apart:
   - **recurring supplier** (`supplier_id`): a current-account counterparty;
   - **counterparty / fiscal evidence**: who issued the purchase and its fiscal document. A casual purchase MAY have a valid invoice; nobody is forced to create a recurring supplier only to record an invoice.
4. No fictitious supplier is ever created.

## 2. Schema — purchases (migration 0088)

```sql
ALTER TABLE purchases ALTER COLUMN supplier_id DROP NOT NULL;
ALTER TABLE purchases ADD COLUMN counterparty_name VARCHAR(120);
ALTER TABLE purchases ADD COLUMN paid_operation_id BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- optional free name: only on a casual purchase; when present it is trimmed and non-empty
ALTER TABLE purchases ADD CONSTRAINT chk_purchases_counterparty
  CHECK (counterparty_name IS NULL OR (supplier_id IS NULL AND counterparty_name = btrim(counterparty_name) AND counterparty_name <> ''));
-- a casual purchase is born paid; a supplier purchase is paid through the current account, never through this link
ALTER TABLE purchases ADD CONSTRAINT chk_purchases_casual_paid
  CHECK ((supplier_id IS NULL) = (paid_operation_id IS NOT NULL));
-- one payment operation finances at most one casual purchase (its versions share the link; only one is current)
CREATE UNIQUE INDEX uq_purchases_paid_operation_current ON purchases(paid_operation_id) WHERE paid_operation_id IS NOT NULL AND is_current;

ALTER TYPE financial_operation_type ADD VALUE 'PURCHASE_PAYMENT';
```

- **counterparty_name is OPTIONAL.** `supplier_id = NULL, counterparty_name = NULL` is a valid casual purchase: category + concept + nature + amount + date (+ the payment and, for MP, its SOURCE_ID) identify it.
- **paid_operation_id** links the purchase to its single `PURCHASE_PAYMENT` operation. The partial unique index forbids two current purchases on one payment; rectified versions of the same purchase carry the same link but only one version is current. In addition, `register_casual_purchase` creates the payment operation itself inside the same transaction (it never accepts an existing operation id), so a payment can never be attached to a second purchase through the API.
- `PURCHASE_PAYMENT` (not `SUPPLIER_PAYMENT`): `SUPPLIER_PAYMENT` means "money against a supplier's current account" (`source_entity_type = 'suppliers'` + a supplier_ledger PAYMENT). A casual payment has neither.
- `ADD VALUE` inside the runner's transaction is safe as in 0043 / 0062: the value is only referenced inside PL/pgSQL bodies.
- `idx_purchases_supplier_invoice (supplier_id, supplier_invoice_number)`: unchanged; NULL-supplier rows never collide.

## 3. Fiscal evidence without a recurring supplier

**Existing model (0035 / 0036 / 0068):**
- `fiscal_document` holds `supplier_id` (nullable column) and `chk_fiscal_counterparty`: `CREDITO ⇒ supplier_id IS NOT NULL`;
- `idx_fiscal_document_supplier_number` deduplicates `(supplier_id, external_number)`;
- `register_fiscal_document` (RPC 34) refuses CREDITO without a supplier;
- `report_fiscal_period` (IVA débito / crédito by period) **does not read the supplier**: it sums the components.

**Exact blocker today:** only the identity of the issuer. Nothing in the IVA computation needs `supplier_id`; the CHECK and the per-supplier uniqueness assume that the issuer of a received invoice is always a recurring supplier.

**Minimal extension (0088, same migration as §2):**
```sql
ALTER TABLE fiscal_document ADD COLUMN issuer_tax_id VARCHAR(13);   -- CUIT of a non-recurring issuer (digits, normalized)
ALTER TABLE fiscal_document ADD COLUMN issuer_name VARCHAR(120);
ALTER TABLE fiscal_document DROP CONSTRAINT chk_fiscal_counterparty;
ALTER TABLE fiscal_document ADD CONSTRAINT chk_fiscal_counterparty CHECK (
     (direction = 'CREDITO' AND (supplier_id IS NOT NULL OR issuer_tax_id IS NOT NULL))
  OR (direction = 'DEBITO' AND cliente_id IS NOT NULL));
ALTER TABLE fiscal_document ADD CONSTRAINT chk_fiscal_issuer CHECK (
     (issuer_tax_id IS NULL AND issuer_name IS NULL)
  OR (supplier_id IS NULL AND direction = 'CREDITO' AND issuer_tax_id ~ '^[0-9]{11}$'));
-- invariant 25, issuer form: the number is unique per issuer CUIT when there is no recurring supplier
CREATE UNIQUE INDEX idx_fiscal_document_issuer_number ON fiscal_document(issuer_tax_id, external_number)
  WHERE supplier_id IS NULL AND issuer_tax_id IS NOT NULL AND external_number IS NOT NULL;
```
- RPC 34 gains two trailing optional parameters (`p_issuer_tax_id`, `p_issuer_name`, default NULL; the function is re-created with the appended parameters so positional callers such as `register_purchase_with_fiscal_document` keep working). CREDITO requires a supplier OR an issuer CUIT (11 digits).
- `purchases`: a casual purchase MAY link a fiscal document whose `supplier_id IS NULL` (issuer form); a supplier purchase keeps linking documents of its own supplier. Consistency check in the RPCs: `purchase.supplier_id IS NOT DISTINCT FROM document.supplier_id`.
- `register_casual_purchase` accepts an optional fiscal payload (type, date, period, number, components, issuer CUIT / name) and calls RPC 34 in the same transaction, exactly as `register_purchase_with_fiscal_document` does for suppliers. The document's components feed `report_fiscal_period` unchanged → **IVA crédito of a casual purchase is computed**.
- A ticket / receipt without a computable IVA credit is evidence only: an attachment (ADR-010), not a `fiscal_document`.
- **Implementation note (0088):** RPC 34 keeps its exact signature (no DEFINER identity change). Its body delegates to the
  internal helper `fiscal_document_insert` (INVOKER, owner-only), which also accepts the issuer CUIT / name; the issuer form
  is reached through `register_casual_purchase` (`p_fiscal`). Extending RPC 34's own parameters remains possible later.
- Not changed: DEBITO documents, components, obligations, payments, the fiscal report.

## 4. Backward compatibility

- `register_purchase` (RPC 13) is **NOT changed**: it still requires an active supplier and still writes the supplier ledger; all current callers (Compras UI, `register_purchase_with_fiscal_document`, tests) keep working. A NULL supplier is still refused, so no unpaid casual purchase can be created through it.
- New RPC `register_casual_purchase` (SECURITY DEFINER, ADMIN, idempotent) is the only way to create a casual purchase:
  ```
  register_casual_purchase(p_economic_date DATE, p_amount_net NUMERIC, p_amount_total NUMERIC,
    p_expense_category_id UUID, p_concept VARCHAR(100), p_nature purchase_nature,
    p_paid_from_account_id UUID, p_payment_method payment_method, p_idempotency_key VARCHAR,
    p_counterparty_name VARCHAR DEFAULT NULL, p_lines JSONB DEFAULT '[]', p_attachments JSONB DEFAULT '[]',
    p_fiscal JSONB DEFAULT NULL, p_project_id UUID DEFAULT NULL, p_flock_id UUID DEFAULT NULL,
    p_mp_source_id TEXT DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB
  ```
  One transaction: `assert_period_open` → (MP gateway, §6) → `PURCHASE_PAYMENT` operation (source `purchases` / purchase id) with ONE posting `−amount_total` on the paying account → `purchases` row (supplier NULL, `subcategory = concept`, trimmed optional `counterparty_name`, `paid_operation_id`) → lines / attachments as RPC 13 → optional fiscal document (§3) → audit. No supplier_ledger row. Category, concept and nature are mandatory; `CHEQUE` is refused (a cheque is an instrument to a supplier). Replay with the same key returns the existing purchase (`replayed = true`) and writes nothing.
- Read models that assume a supplier (Compras list joins `suppliers(nombre)`) fall back to `counterparty_name`, else "Sin proveedor registrado"; `PurchaseRow.supplier_id: string | null`.

## 5. Supplier current-account impact

- **Zero** for casual purchases: no `supplier_ledger` row is ever written for `supplier_id IS NULL` (RPC 13 is unreachable with NULL; the casual RPC never writes the ledger; the casual branch of RPC 14 never compensates). `report_balance_period` (SUPPLIER) and Cuentas a pagar read only `supplier_ledger`: a casual purchase never appears as supplier debt or advance.
- Registered-supplier flows (debt, partial / total `pay_supplier`, advances, instruments, freight debt): unchanged.

## 6. Payment semantics and one classification per MP SOURCE_ID

- Casual = purchase + payment in ONE transaction: the cost is recognised by the purchase (P&L), the cash leaves the paying account once through the `PURCHASE_PAYMENT` posting. 13/10: purchase 759,702.86 (supplier NULL) + `PURCHASE_PAYMENT` Mercado Pago −759,702.86. No `pay_supplier`, no supplier debt.
- A casual purchase is never unpaid: with no supplier there is no holder for a liability. Credit purchases need a registered supplier.
- **Single gateway for Mercado Pago money (cross-entry idempotency).** An MP outflow is evidenced by a report movement (payout, SOURCE_ID). It may receive exactly ONE economic classification:
  1. `register_casual_purchase` with `p_paid_from_account_id = Mercado Pago` REQUIRES `p_mp_source_id`; without it → `MP_SOURCE_REQUIRED` (no free-standing MP purchase from Compras).
  2. With it, the RPC takes the same lock as the MP classification (`'mp_payout_outflow:' || SOURCE_ID`), resolves the payout movement, refuses it if it already has any reconciliation (own transfer 0087, any 0089 classification, a previous casual purchase) → `PAYOUT_ALREADY_APPLIED`, requires the amount to equal |net| (the server amount; the client amount must match or the call is refused), reconciles the movement to the `PURCHASE_PAYMENT` operation and records the `mp_outflow_classification` row (`CASUAL_PURCHASE`, UNIQUE source_id / movement).
  3. The MP activity path (0089) calls the same RPC with the same SOURCE_ID: either entry point produces the SAME single classification; the second one is refused (or replayed when it is the same call with the same idempotency key `MP-OUTFLOW-PURCHASE:<SOURCE_ID>`).
  4. Guarantees: `mp_reconciliation` over-assignment guard (a movement is reconciled at most to its net), `mp_outflow_classification` UNIQUE(source_id) and UNIQUE(movement), purchase `idempotency_key` UNIQUE, payment `external_ref` UNIQUE (`MP-OUTFLOW:<SOURCE_ID>`).
- Other accounts (BNA, Caja, Patagonia): the payment is created by the casual RPC; a later bank statement line is matched (fin_statement_match) to the `PURCHASE_PAYMENT` posting — matching never creates money, so it cannot double the expense.

## 7. Rectification

- Kept **amount-locked** for a paid casual purchase: `rectify_purchase` casual branch refuses a different `amount_total` (`CASUAL_PURCHASE_AMOUNT_LOCKED`). Changing the amount of money that already left an account requires a FUTURE explicit reversal / refund flow (a compensating operation and, for MP, the corresponding evidence) — never a destructive UPDATE.
- What may change, by the usual versioned rectification (new version, previous version kept, ADR-002 keys): lines / net amount / attachments today; **concept, category and nature** under the same versioned rules — RPC 14 currently carries category / nature / subcategory forward unchanged for every purchase, so the casual branch gains optional `p_new_expense_category_id / p_new_nature / p_new_concept` (same amount, new version, P&L follows the current version). Supplier purchases keep RPC 14 exactly as today.
- The casual branch never writes supplier-ledger compensations; the new version keeps `supplier_id NULL`, `counterparty_name`, `paid_operation_id` and the fiscal link.
- Note: a purchase with zero lines cannot be rectified by today's RPC 14 (`EMPTY_LINE_SET`); the casual branch accepts an empty line set when the total is unchanged.

## 8. P&L, reporting, freight, flocks

- **P&L:** unchanged model and source (`purchases` → `pnl_line_item`, by category class / nature, at `economic_date`; description = concept or category). Payments (`PURCHASE_PAYMENT`, `SUPPLIER_PAYMENT`) never reach the P&L.
- **Reporting:** supplier balances unaffected (ledger-based). Purchase lists / filters gain "Sin proveedor registrado" / the counterparty name.
- **IVA:** casual purchases with an issuer-form fiscal document contribute IVA crédito through the unchanged `report_fiscal_period`.
- **Freight:** may be allocated to a casual purchase (allocation never reads the supplier); the freight's own supplier debt is unchanged. **Flocks / feed:** unaffected.

## 9. Migration and 0089 (MP classification)

- **0088 `optional_supplier_casual_purchases`:** §2 + §3 + `register_casual_purchase` (with the MP gateway, which needs the outflow classification table — it is created here, see below) + RPC 14 casual branch + RPC 34 issuer parameters; DEFINER +1.
  - `mp_outflow_classification` moves to 0088 (it is the single-classification ledger for MP outflows used by the gateway); classification values: `EXPENSE`, `SUPPLIER_PAYMENT`, `OWNER_WITHDRAWAL`, `CASUAL_PURCHASE`.
- **0089 `mp_classify_inflows_outflows`** (the current, undeployed 0088, reworked): `mp_classify_payout_outflow` (Compra / gasto: supplier → EXPENSE / SUPPLIER_PAYMENT as today; no supplier → `register_casual_purchase(…, p_mp_source_id)`; Retiro de socios), `mp_inflow_classification` + `mp_classify_inflow_as_collection`, activity view; DEFINER +2.
- UX: "Clasificar salida" → **Compra / gasto** (Proveedor: registrado | Sin proveedor registrado; Comercio / nombre optional; Categoría, Concepto, Naturaleza mandatory; optional fiscal document) | **Retiro de socios**. Own transfers keep 0087.
- 13/10: Compra / gasto → Sin proveedor registrado → category + concept + nature → Confirmar: MP −759,702.86 once, cost in the P&L, no supplier, no supplier debt, one classification for SOURCE_ID 183984533002.
- Then: frontend (Compras casual mode with "Pagado desde" and, for MP, the choice of an unclassified MP outflow), unit tests, DB tests, POST_0088 / POST_0089 profiles; deploy only with an owner GO.

## 10. Risks

- **Invariant change:** code that assumes `purchases.supplier_id` is non-null must handle NULL — mitigated by the CHECKs and by keeping RPC 13 supplier-only.
- **Amount corrections:** a wrong casual amount waits for the future reversal / refund flow; the MP path uses the server amount, so the risk is limited to manual non-MP entries.
- **Issuer identity quality:** a CUIT typed by hand can be wrong; it is validated as 11 digits only (no AFIP lookup).
- **Pre-existing gap, outside this ADR:** `pay_supplier` from the Mercado Pago account (Cuentas a pagar) is not anchored to an MP SOURCE_ID, so it could duplicate an outflow later classified from the MP activity. A follow-up should apply the same gateway to supplier payments from MP.
- **New operation type:** reports that enumerate operation types must include `PURCHASE_PAYMENT`.

---

## AMENDMENT — Lote 4 (owner GO "opción A", 2026-10-30; migration 0111)

The casual-purchase invariant (already widened by ADR-026 / 0106) reads:

> a casual purchase is born paid by exactly one payment operation, **or** pending (ADR-026, `expense_payable`), **or** paid by
> Mercado Pago awaiting its movement (`purchase_mp_link`, settled once by the ADR-021 §2.3(c) route `PURCHASE_MP_LINK`);
> never more than one of these.

Enforced at commit by `purchase_casual_settlement_check` (`CASUAL_PURCHASE_UNSETTLED` / `CASUAL_PURCHASE_AMBIGUOUS`). A
purchase paid with Mercado Pago awaiting its movement has no `paid_operation_id`; once linked, its payment operation is
recorded in `purchase_mp_settlement` (the purchase row is never rewritten). It never touches the supplier current account.

