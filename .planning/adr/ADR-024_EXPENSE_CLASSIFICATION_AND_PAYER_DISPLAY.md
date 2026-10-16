# ADR-024 — Expense classification (category → subcategory), fiscal routes and safe Mercado Pago payer display

**STATUS:** **ACCEPTED** (owner decisions, GO "ADR-024 IMPLEMENTATION", 2026-10-16).
**DATE:** 2026-10-16
**AMENDS:** ADR-004 D4 (flat `expense_category`), the Phase 27 category master editor, ADR-006 Step 6 payer evidence handling
(raw Payment API payload API-readable by ADMIN).
**NOT AFFECTED:** every historical financial fact (operations, postings, purchases, supplier / client ledgers, P&L amounts),
existing `expense_category` IDs, DIRECT / INDIRECT (`pnl_cost_class`, in STANDBY), the purchase nature per operation,
the ADR-021 / ADR-022 / ADR-023 Mercado Pago semantics.

---

## 1. Expense model: CATEGORY → SUBCATEGORY

- A new parent table `expense_category_group` (nombre, activo, display_order, kind ∈ {EXPENSE, OWNER_WITHDRAWAL}).
- Every existing `expense_category` row is a SUBCATEGORY and keeps its ID; it gains `group_id` (mandatory after the backfill)
  and `default_nature` (purchase nature pre-filled when the subcategory is chosen; the operation still stores its own nature
  and the user may override it — the master default never changes because of an operation).
- 14 groups: Insumos alimento balanceado · Cartones / envases · Mano de obra · Retiros de socios · Combustible · Servicios ·
  Materiales / Repuestos · Logística / Fletes · Impuestos y tasas · Insumos varios · Otros · Créditos · Recria · Feria.
  "Imputar solo IVA" is NOT a category (§3).
- New subcategory "Afrechillo de trigo" (Insumos alimento balanceado, OPERATING). "Gastos de Feria" (system, used by the feria
  closing by name) → Feria. Master data only, no financial operation.
- Default nature: INVESTMENT — Pollitas BB, Arreglos edilicios; REINVESTMENT — Servicios técnicos, Herramientas, Repuestos;
  OPERATING — every other expense subcategory, including Materiales, Chacra, Compras viejas, Otros, Gastos no clasificados,
  Gastos de Feria and ProPAV (owner simplification: each ProPAV installment is an ordinary expense; principal / interest are
  not split).
- Historical safety: the parent and the default nature are metadata; no historical reference is rewritten; financial delta 0.00.

## 2. Reserved subcategories

- **Retiros de socios** (kind OWNER_WITHDRAWAL): Santi, Fran, Padres are the PERSON dimension of a withdrawal, not expense
  categories. They are never offered in purchase / gasto selectors and the database rejects them for new purchases, freight
  and feria cash expenses (CATEGORY_NOT_SELECTABLE). The canonical route stays "Retiro de socios" (management_event RETIRO →
  P&L RETIROS); it stores an optional socio (`management_event.socio_category_id`).
- **IVA and Ganancias** (`fiscal_reserved`, deactivated): never a new ordinary purchase / gasto; their payments use the Fiscal
  route (obligation + payment: the account decreases, the obligation is settled, no P&L line from the payment). The rows and
  their history are kept. A rectification of a legacy row keeps its own category.

## 3. "Solo crédito fiscal IVA" — a fiscal treatment, not a category

Reuses Fiscal → "Registrar comprobante manual" (`register_fiscal_document`, CREDITO with IVA components): no money movement,
no purchase, no supplier payable, no P&L; the VAT credit enters the fiscal period report. The UI names it explicitly, takes the
issuer by CUIT without a registered supplier (the database already supports the issuer form, 0088) and asks punto de venta and
número separately (stored together as the document number). Attachments for standalone fiscal documents are a follow-up (the
existing attachment model belongs to purchases).

## 4. DIRECT / INDIRECT — STANDBY

`pnl_cost_class` stays mandatory because the P&L reads it; a new subcategory takes it from its siblings (else INDIRECT) without
asking the user. It is not shown in the new UX. No snapshotting in this ADR.

## 5. Category administration

Administración → Categorías de gasto shows the tree (category → subcategories): create category / subcategory, rename,
activate / deactivate, display order, default nature, move a subcategory, group kind. No hard delete (the references are
RESTRICT). ADMIN only; every insert / update of a category or subcategory is audited (audit_events).

## 6. Mercado Pago payer data

Live read-only proof (owner, 11 × GET /v1/payments/{id}, 2 from February): payer.id 11/11, payer.first_name / last_name 0/11,
payer.email 11/11, payer.identification 11/11, card.cardholder.name 2/2 (card), bank_info.payer.long_name 2/2 (DEBIN) and 0/2
(CVU), description 11/11; February lookup PASS; the SOURCE_ID is the payment id.

- Identity: `payer.id` only (the existing `mp_payer_client_map` / `mp_auto_allocate` key). A name is never an identity.
- Display name precedence: `point_of_interaction.transaction_data.bank_info.payer.long_name` → `card.cardholder.name` → the
  payment type / description fallback. Never the email or the document.
- Privacy: the raw provider payload (`mp_source_record.event_data`) is no longer readable by any API role; trusted server paths
  (SECURITY DEFINER functions, service role) keep it. ADMIN reads curated views only; the views that need the payload run with
  the owner's rights and keep their explicit ADMIN filter. "Entradas sin vincular" exposes payer_id, display name and the mapped
  client — never email, document, phone or bank identifiers.
- "Recordar este pagador" reuses `mp_map_payer_to_client`.
- Historical payer enrichment (≈4,589 rows) is deferred: a later server-side, rate-controlled, resumable, idempotent,
  read-only job that stores only the safe normalized fields.
