# DATABASE INVARIANTS V1

**STATUS:** **FROZEN** — Fase 9 (Implementation Design) closed 2026-09-24. Implementation-ready invariant registry.  
**AMENDMENTS:** ADR-001 (`.planning/adr/ADR-001_ISSUED_INSTRUMENT_CANCELLATION.md`, ACCEPTED 2026-09-25) — issued-instrument cancellation: RPC 42 `cancel_supplier_instrument`, `financial_instrument.cancelled_date`, `chk_instrument_cancelled_coherent`. Amended passages are marked **[ADR-001]**. Nothing else changed.  
**AMENDMENTS:** ADR-002 (`.planning/adr/ADR-002_PURCHASE_RECTIFICATION_VERSION_KEY.md`, ACCEPTED 2026-09-25) — bounded rectified-purchase version key (`'RECTIFY:' || <predecessor purchase id> || ':v' || version`) and the reserved `RECTIFY:` idempotency-key prefix. Amended passages are marked **[ADR-002]**. Nothing else changed.  
**AMENDMENTS:** ADR-007 (`.planning/adr/ADR-007_FLOCK_LIFECYCLE.md`, ACCEPTED 2026-09-29) — V1 flock lifecycle: RPC 44 `register_flock`, RPC 45 `close_flock` (ADMIN, SECURITY DEFINER; the SECURITY DEFINER set 60 → 62) and invariant 29 (no dated flock activity after `flocks.exit_date`, enforced in RPCs 18–22, 29 and 45). No schema change. Amended sections are marked **[ADR-007]**.  
**AMENDMENTS:** ADR-016 (`.planning/adr/ADR-016_FERIA_V1_SUMMARIZED_CLOSING.md`, ACCEPTED 2026-10-01) — new invariant 33 (a Feria closing counts once, in its current version).
**AMENDMENTS:** ADR-017 (`.planning/adr/ADR-017_MP_CUTOVER_BOUNDARY.md`, ACCEPTED 2026-10-02) — new invariant 34 (pre-cutover MP activity is never applied again in the target).
Changes from here require an explicit ADR, as with the target architecture.  
**DATE:** 2026-09-24  
**AUTHORITY:** TARGET_ARCHITECTURE_V2_FROZEN.md (frozen)  
**COMPANIONS:** `POSTGRES_SCHEMA_SPEC_V1.md` (54 tables) · `RPC_CONTRACTS_V1.md` (45 RPCs — RPC 42 by ADR-001, RPC 43 by ADR-004, RPCs 44 / 45 by ADR-007) · `RLS_IMPLEMENTATION_SPEC_V1.md`

Every invariant below names its enforcement mechanism and the exact identifiers involved. Where a
mechanism is "absent privilege", that is deliberate and explained in invariant 9.

**COUNT: 29 invariants.** **[ADR-007]** (invariant 29 added)

---

## 1. One ACTIVE flock per shed

**Rule:** at most one `flocks` row per `shed_id` has `estado='ACTIVE'`.  
**Enforced by:** `CREATE UNIQUE INDEX idx_flocks_shed_active ON flocks(shed_id) WHERE estado='ACTIVE'`.  
**[ADR-007]** A flock enters ACTIVE only through RPC 44 `register_flock` (shed row locked; a second ACTIVE flock is `SHED_OCCUPIED`) and leaves it only through RPC 45 `close_flock`.  
**Why an index:** PostgreSQL has no partial UNIQUE *constraint*; `ALTER TABLE ADD CONSTRAINT UNIQUE … WHERE` does not exist.  
**Violation:** production records become ambiguous between two concurrent flocks.

---

## 2. One current MORTALITY per (flock, date)

**Rule:** at most one `population_events` row with `event_type='MORTALITY'` and `is_current=true` per `(flock_id, event_date)`. `COUNT_ADJUSTMENT` is intentionally unconstrained — multiple adjustments per date are legitimate.  
**Enforced by:** `CREATE UNIQUE INDEX idx_population_events_mortality_current ON population_events(flock_id, event_date) WHERE event_type='MORTALITY' AND is_current=true`.  
**Rectification:** `rectify_mortality` (RPC 21) sets `is_current=false` on the old row *before* inserting the replacement, so the index never sees two current rows inside the transaction.  
**Duplicate attempt:** `register_mortality` raises `MORTALITY_ALREADY_RECORDED` and reports the existing value. No `MORTALITY_CONFLICT` type, no `conflict_flag` (frozen Part 26).

---

## 3. Order subtotal = cantidad × precio_unitario

**Rule:** `pedido_lineas.subtotal` always equals `cantidad * precio_unitario`.  
**Enforced by:** `subtotal NUMERIC(15,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED`.  
The column cannot be written by anyone, including RPCs.  
Same mechanism on `purchase_line.subtotal`.

---

## 4. A DELIVERED order is immutable

**Rule:** once `pedidos.estado='DELIVERED'`, no column of that row and no business column of its lines may change.  
**Enforced by:** the single UPDATE policy `pedidos_admin_update_pending` has `USING (… estado='PENDING')`, so a delivered row matches no UPDATE policy; `pedido_lineas` has no UPDATE policy and no UPDATE privilege at all.  
**Correction path:** `rectify_delivered_order` (RPC 2) only — reversal + new version + audit.  
**Note:** exactly one UPDATE policy exists on `pedidos`; a second broad policy would be OR-ed and would silently defeat this.

---

## 5. Client balance = SUM(client_ledger)

**Rule:** client debt is `SUM(client_ledger.signed_amount)` for that `cliente_id`. No stored balance exists.  
**Enforced by:** `clients` has no balance column. Frozen Part 26 rejects editable running balances.  
**Sign convention:** `+` increases debt, `-` reduces it. A negative total is a credit in favour of the client and is valid.

---

## 6. Account balance = SUM(financial_posting)

**Rule:** account balance is `SUM(financial_posting.signed_amount)` for that `financial_account_id`. No stored balance exists.  
**Enforced by:** `financial_account` has no balance column.

---

## 7. Supplier balance = SUM(supplier_ledger)

**Rule:** supplier debt is `SUM(supplier_ledger.signed_amount)` for that `supplier_id`. No stored balance exists, and payments are never allocated to specific invoices (frozen Part 8).  
**Enforced by:** `suppliers` has no balance column; `supplier_ledger` has no invoice-allocation column.

---

## 8. Every posting belongs to an operation

**Rule:** `financial_posting.financial_operation_id` always references an existing `financial_operation`.  
**Enforced by:** `NOT NULL` + FK `ON DELETE RESTRICT`.  
**Type note:** the FK column is `BIGINT` referencing a `BIGSERIAL` PK. `BIGSERIAL` is a PK-only declaration, never a FK column type.

---

## 9. Append-only tables are protected by absent privileges

**Rule:** no application role may `UPDATE` or `DELETE` these tables:
`client_ledger`, `collections`, `financial_operation`, `financial_posting`,
`financial_instrument_event`, `supplier_ledger`, `purchases`, `purchase_line`,
`freight`, `freight_allocation`, `population_events`, `daily_production`,
`flock_weighing`, `temperature_record`, `classification`, `classification_line`,
`feed_manufacturing`, `feed_movement`, `feed_inventory_count`,
`sales_session_movement`, `sales_session_cash_event`,
`fiscal_document`, `fiscal_document_component`, `fiscal_obligation_installment`,
`fiscal_payment`, `audit_events`, `mp_financial_movement`, `mp_reconciliation`.

**Enforced by:** `REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM anon, authenticated`, with narrow re-grants that exclude every table above.

**Why not `UPDATE USING FALSE`:** PostgreSQL RLS is permissive — policies for one command are OR-ed. A `USING FALSE` policy grants nothing and **denies nothing**; it is a no-op that only looks protective, and it becomes actively misleading next to a broad `FOR ALL` policy, whose branch would win. Absent privilege is the real guarantee.

**Controlled exceptions (metadata only, via SECURITY DEFINER RPCs owned by `postgres`):**
- `pedido_lineas.is_current` — flipped by RPC 2.
- `population_events.is_current`, `.superseded_by` — RPC 21. Business fields `delta`, `event_date`, `flock_id` never change.
- `daily_production.is_current`, `.superseded_by` — RPC 19.
- `purchases.is_current` — RPC 14.
- `freight_allocation.purchase_id` — RPC 14, when a rectified purchase carries its allocations forward.
- `mp_source_record.processing_status`, `.processed_at`, `.processing_note` — RPCs 40/41 (see invariant 21).
- `fiscal_obligation.status` — RPC 36.

---

## 10. No period-sensitive write into a CLOSED period

**Rule:** no fact may be created, rectified or economically altered when its business date falls in a `management_period` whose `status='CLOSED'`.  
**Enforced by:** two cooperating mechanisms —
1. application roles hold no write privilege on any period-sensitive table, so the only path is an RPC;
2. all 38 period-sensitive RPCs begin with `ASSERT_PERIOD_OPEN(business_date)`, which does
   `SELECT … FROM management_period WHERE periodo_fecha = date_trunc('month', business_date)::DATE FOR UPDATE`
   and raises `PERIOD_CLOSED` unless `status='OPEN'`.

The `FOR UPDATE` lock also serialises against `close_management_period`, so a fact cannot slip in while a period is being closed.  
**Late data:** if the period is OPEN the fact belongs to its real date; if CLOSED it must be reopened first (frozen Part 20). Nothing is silently re-dated.

---

## 11. created_at NEVER determines a period

**Rule:** period assignment always uses the entity's explicit business `DATE` column, never `created_at`.  
**Enforced by:** every period-sensitive table carries a dedicated `DATE` column (invariant 12); `created_at` is metadata.  
**Single documented exception, non-determinant:** `close_management_period` counts PENDING orders by `created_at` purely as an informational warning. It assigns no period and blocks nothing.

---

## 12. Period determinant matrix (canonical)

| Fact | Table | Determinant column | Frozen Part 20 reference |
|---|---|---|---|
| Sale delivery | pedidos | `delivered_date` | delivered_at → delivery month |
| Order cancellation | pedidos | `cancelled_date` (no ledger effect) | n/a |
| Collection | collections | `effective_date` | receipt month |
| Client ledger movement | client_ledger | `effective_date` | — |
| Cheque received | financial_instrument | `received_date` | CC impact month |
| Cheque deposited | financial_instrument | `deposited_date` | custody only |
| Cheque cleared | financial_instrument | `cleared_date` | bank impact month |
| Cheque endorsed | financial_instrument | `endorsed_date` | supplier CC month |
| Instrument rejected | financial_instrument | `rejected_date` | reversal month |
| Instrument issued | financial_instrument | `issued_date` | CC impact month |
| Instrument debited | financial_instrument | `debited_date` | bank impact month |
| Instrument cancelled **[ADR-001]** | financial_instrument | `cancelled_date` | supplier CC month |
| Instrument event | financial_instrument_event | `event_date` | — |
| Purchase | purchases | `economic_date` | economic month |
| Supplier payment | supplier_ledger | `effective_date` | payment month |
| Freight | freight | `economic_date` | event month |
| Freight allocation | freight_allocation | parent `freight.economic_date` | cost attribution |
| Transfer / any posting | financial_posting | `effective_date` | impact month |
| Production | daily_production | `production_date` | event month |
| Mortality / adjustment | population_events | `event_date` | event month |
| Weighing | flock_weighing | `weighing_date` | event month |
| Temperature | temperature_record | `record_date` | event month |
| Classification | classification | `classification_date` | session month |
| Feed manufacturing | feed_manufacturing | `manufacturing_date` | event month |
| Feed movement | feed_movement | `movement_date` | event month |
| Feed count | feed_inventory_count | `count_date` | event month |
| Sales session | sales_session | `session_date` | event month |
| Session cash event | sales_session_cash_event | `event_date` | event month |
| Fiscal document | fiscal_document | `document_date` + `fiscal_period` | tax period |
| Fiscal obligation | fiscal_obligation | `fiscal_period` | tax period |
| Fiscal payment | fiscal_payment | `effective_date` | payment month |
| MP external movement | mp_source_record / mp_financial_movement | `occurred_date` (MP's own date) | event month |
| MP reconciliation | mp_reconciliation | none — does not change the source fact's period | frozen Part 20 |

---

## 13. Period boundary semantics

**Rule:** a business date `d` belongs to exactly one period: the row with
`periodo_fecha = date_trunc('month', d)::DATE`. Equivalently the half-open interval
`[periodo_fecha, periodo_fecha + INTERVAL '1 month')`. Granularity is monthly only.  
**Enforced by:** `management_period.periodo_fecha` is `UNIQUE` with
`CHECK (periodo_fecha = date_trunc('month', periodo_fecha)::DATE)`; every RPC resolves the period with the same `date_trunc` expression.  
No `BETWEEN` form appears anywhere, since `BETWEEN` would include the next month's first day.

---

## 14. Business dates are timezone-explicit

**Rule:** when a business `DATE` derives from a `TIMESTAMPTZ`, the conversion is always
`(instant AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`. A bare `timestamptz::DATE` is never used for period logic, because it silently depends on the session timezone.  
**Enforced by:** derived dates are stored in their own columns (`pedidos.delivered_date`, `pedidos.cancelled_date`, `financial_instrument.received_date`) and written only by RPCs that apply the fixed zone.  
**Applies to:** RPC 1, 2, 3, 5 — the only RPCs accepting a `TIMESTAMPTZ` for a period-bearing fact. All other RPCs take a `DATE` directly, so no conversion exists to get wrong.

---

## 15. Order total is derived

**Rule:** an order's total is `SUM(pedido_lineas.subtotal) WHERE pedido_id = … AND is_current = true`. No `monto_total` column exists.  
**Enforced by:** absent column (frozen Part 1 and Part 26).  
Only the current version participates, which is what makes invariant 16 correct across repeated rectifications.

---

## 16. Rectification is set-versioned and correct for N passes

**Rule:** rectifying a delivered order replaces the *current set* of lines with a *new set*, and the compensating reversal always cancels the **current** total — never the first historical total.

**Mechanism (`pedido_lineas`):**
- `version_seq` — 0 for the original set, N for the Nth rectification.
- `is_current` — marks the rows of the one version in force.
- `pedidos.rectification_seq` — the highest existing `version_seq`.
- there is deliberately **no per-line `superseded_by`**: replacement is N:M (3 lines may become 2, or 1 may become 5) and a per-line pointer cannot express that.

**Enforced by:** `excl_pedido_lineas_single_current_version`, an EXCLUDE constraint
`EXCLUDE USING gist (pedido_id WITH =, version_seq WITH <>) WHERE (is_current)` (requires the
`btree_gist` extension). It rejects any two current rows of the same order that carry different
`version_seq` values, while permitting any number of current rows that share one `version_seq`.

`idx_pedido_lineas_current` is a plain **non-unique** index and guarantees nothing — it only
accelerates the lookup. Neither could a unique index do this job: `UNIQUE (pedido_id) WHERE
is_current` would cap each order at one line, and `UNIQUE (pedido_id, version_seq) WHERE is_current`
would cap each version at one line. The exclusion constraint is the only formulation that constrains
the *version* without constraining the *number of lines per version*.

**Mandatory mutation order (RPC 2):** read and validate everything, then (a) flip the previous
version's rows to `is_current = false`, then (b) insert the new version's rows. The constraint is
`IMMEDIATE`, so the reverse order — inserting the new version while the old one is still current —
raises on the spot. Retiring first passes through a transient zero-current-rows state, which the
constraint permits and which is invisible outside the transaction. If any later step of the RPC
fails, the whole call rolls back and the previous version remains current, so an order is never
persisted without a current version.

**Ledger effect of the Nth rectification:** `-total(version N-1)` REVERSAL then `+total(version N)` SALE_DELIVERY, both dated at the original `delivered_date`. Telescoping across N passes leaves exactly `+total(version N)`, which is the correct economic outcome.

**Preserved:** every historical version keeps `cantidad`, `precio_unitario`, `producto_nombre` unchanged forever. Old rows are never duplicated to mark them obsolete — only `is_current` flips.

`purchases` uses the same discipline through `is_current` + `version_seq` (RPC 14). **[ADR-002]** Each rectified purchase version gets the bounded, deterministic key `'RECTIFY:' || <predecessor purchase id> || ':v' || version_seq` (≤ 56 characters), so correctness holds for N passes without approaching `VARCHAR(100)`; `daily_production` and `population_events` use `is_current` + `superseded_by`, which is valid there because their replacement is strictly 1:1.

**The retire-then-insert order applies to all four rectification RPCs** (2, 14, 19, 21), and in three
of them an existing unique index enforces it rather than merely documenting it:

| RPC | Table | What rejects the reverse order |
|---|---|---|
| 2 `rectify_delivered_order` | pedido_lineas | `excl_pedido_lineas_single_current_version` |
| 14 `rectify_purchase` | purchases | `idx_purchases_supplier_invoice` (when an invoice number is present) |
| 19 `rectify_daily_production` | daily_production | `idx_daily_production_current` |
| 21 `rectify_mortality` | population_events | `idx_population_events_mortality_current` |

Each of these RPCs also captures the values it needs from the current version *before* retiring it, so
the insert never depends on reading a row it has already altered.

---

## 17. Snapshot fields are immutable

| Column | Table | Captured at | Reason |
|---|---|---|---|
| `precio_unitario` | pedido_lineas | line creation | the price actually charged; master price must never restate history |
| `producto_nombre` | pedido_lineas | line creation | historical display name |
| `ledger_client_name` | client_ledger | posting | client renames must not re-attribute history |
| `formula_version_id` | feed_manufacturing | manufacturing | the exact recipe applied |
| `unit_cost_snapshot` | feed_formula_line | version creation | historical ingredient cost for that version |
| `rate_applied` | fiscal_document_component | document registration | the tax rate actually used; rates change and are never hardcoded |
| `precio_unitario` | purchase_line | line creation | historical input cost |

**Enforced by:** no UPDATE privilege on any of these tables for any application role, plus invariant 4 for order lines.  
Snapshots are applied only where a future master change would alter historical meaning (frozen Part 24), not by default.

---

## 18. Cheque state machine

**Received direction** (`direction='RECEIVED'`):
```
RECEIVED → DEPOSITED → CLEARED
RECEIVED → ENDORSED
RECEIVED | DEPOSITED | CLEARED | ENDORSED → REJECTED
```
**Issued direction** (`direction='ISSUED'`):
```
ISSUED → DEBITED
ISSUED | DEBITED → REJECTED
ISSUED → CANCELLED              (RPC 42 cancel_supplier_instrument — ADR-001)
```
**Enforced by:** each RPC locks the row `FOR UPDATE` and validates the current `estado` before transitioning; `chk_instrument_estado_direction` prevents any state belonging to the wrong direction; `idx_instrument_event_unique(financial_instrument_id, event_type)` prevents duplicate lifecycle events on one instrument. **[ADR-001]** `chk_instrument_cancelled_coherent` binds `estado = 'CANCELLED'` ⇔ `cancelled_date IS NOT NULL`; CANCELLED is terminal.

---

## 19. Instrument economic semantics

| Event | client_ledger | supplier_ledger | financial_posting |
|---|---|---|---|
| Received (RPC 5) | `-amount` | — | **none** |
| Deposited (RPC 6) | — | — | **none** |
| Cleared (RPC 7) | — | — | `+amount` on `bank_account_id` |
| Endorsed (RPC 8) | **untouched** | `-amount` | none |
| Rejected after RECEIVED/DEPOSITED (RPC 9) | `+amount` | — | none |
| Rejected after CLEARED (RPC 9) | `+amount` | — | `-amount` on the same `bank_account_id` |
| Rejected after ENDORSED (RPC 9) | **untouched** | `+amount` | none |
| Issued (RPC 10) | — | `-amount` | **none** |
| Debited (RPC 11) | — | — | `-amount` on `bank_account_id` |
| Rejected after ISSUED (RPC 12) | — | `+amount` | none |
| Rejected after DEBITED (RPC 12) | — | `+amount` | `+amount` reversal |
| Cancelled before debit (RPC 42) **[ADR-001]** | — | `+amount` REVERSAL (`reversal_of_id` → the single INSTRUMENT_ISSUED entry) | none |

**Why reversal is deterministic:** `cliente_id` is persisted at reception, `bank_account_id` at clearing (received) or at issuance (issued), and `endorsed_to_supplier_id` at endorsement. `reject_cheque` branches on the prior `estado` and always has the counterparty it needs.  
**Frozen rule preserved:** endorsement does not reopen client debt — the client's payment is final and the endorsement settles the supplier obligation independently.

---

## 20. cheque_number is business data, not identity

**Rule:** `financial_instrument.cheque_number` is **not** unique. The same printed number legitimately recurs across banks, suppliers and years.  
**Identity:** `financial_instrument.id` (UUID).  
**Idempotency:** `receipt_id` UNIQUE for received instruments, `external_ref` UNIQUE for issued ones; `chk_instrument_received_provenance` / `chk_instrument_issued_provenance` make the right key mandatory per direction.  
A global UNIQUE on `cheque_number` would reject valid data.

---

## 21. MP raw source is immutable; processing metadata is controlled

**Rule, stated as a split rather than a contradiction:**

| Columns | Status |
|---|---|
| `source_type, external_id, event_data, occurred_at, occurred_date, ingested_at` | immutable forever |
| `processing_status, processed_at, processing_note` | controlled mutable metadata |

**Enforced by:**
- no application or service role holds `UPDATE` on `mp_source_record`;
- the only writers of metadata are `mp_normalize_source` / `mp_reconcile_movement` (SECURITY DEFINER, owner `postgres`);
- `trg_mp_source_raw_guard` (BEFORE UPDATE) raises if any raw column changes — it protects the raw data even against the privileged path;
- no `UPDATE USING FALSE` policy exists, because it would be a no-op and would also contradict the fact that `processing_status` must legitimately advance.

**Period:** `occurred_date` (MP's own date) determines the period. The reconciliation timestamp never changes the original fact's period. There is no artificial MP deadline.

---

## 22. Freight is recognised once and never double-counted

**Rule:** the freight expense is recognised exactly once, in `register_freight` (RPC 16), which creates one `supplier_ledger` FREIGHT row when a freight supplier exists. Allocating freight to a purchase creates **no** second economic effect.  
**Enforced by:** `assign_freight_to_purchase` (RPC 17) writes only a `freight_allocation` row — no `supplier_ledger`, no `financial_operation`, no `financial_posting`, no `fiscal_document_component`.  
**Cap:** the RPC raises `OVER_ALLOCATION` unless `SUM(allocated_amount) <= freight.amount`; `UNIQUE(freight_id, purchase_id)` blocks duplicate allocation of the same freight to the same purchase.  
**Landed cost (derived, never stored):**
`purchases.amount_total + COALESCE(SUM(freight_allocation.allocated_amount), 0)`.  
**Reporting rule:** P&L reads freight either as an unallocated expense or through allocation as part of landed cost — never both. Duplication is thereby prevented across P&L, input cost, IVA, supplier account and treasury (frozen Part 9).  
**Historical cost correction:** allowed only while the freight's own period is OPEN, which RPC 17 checks against `freight.economic_date`.

---

## 23. A purchase always has an attachment — SUPERSEDED **[ADR-010]**

**[ADR-010]** Superseded by owner decision D-WALK-5 (2026-09-30): a purchase may have zero attachments. RPC 13 accepts NULL / `[]` and RPC 14 carries forward whatever exists (migration 0061). The original text is kept below as history.


**Rule:** no `purchases` row can exist without at least one `purchase_attachment` row.  
**Enforced by:** `authenticated` holds no INSERT privilege on `purchases`, so the only creation path is `register_purchase` (RPC 13), which raises `ATTACHMENT_REQUIRED` when `p_attachments` is empty and inserts the purchase plus its attachments in one transaction. `purchase_attachment` has no DELETE policy, so the attachment cannot be removed afterwards. `rectify_purchase` copies attachments to the new version.  
This is a frozen requirement (frozen Part 8 / owner rule), not a soft convention.

---

## 24. Purchase classification is mandatory

**Rule:** every purchase carries `expense_category_id` (NOT NULL) and `nature ∈ {OPERATING, REINVESTMENT, INVESTMENT}` (NOT NULL). `subcategory` and `project_id` are optional.  
**Enforced by:** `NOT NULL` columns + FK to `expense_category`; RPC 13 raises `CATEGORY_REQUIRED` / `NATURE_REQUIRED`.  
`expense_category` is in active scope — it is referenced by `purchases`, `freight` and `sales_session_cash_event`, and is not "future use".

---

## 25. Invoice numbers are unique per supplier, never globally

**Rule:** `supplier_invoice_number` may repeat across suppliers; two different suppliers can legitimately issue invoice `0001`.  
**Enforced by:** `CREATE UNIQUE INDEX idx_purchases_supplier_invoice ON purchases(supplier_id, supplier_invoice_number) WHERE supplier_invoice_number IS NOT NULL AND is_current = true`.  
The same scoping applies to `fiscal_document(supplier_id, external_number)`. No global uniqueness exists on either.  
Technical idempotency is carried separately by `purchases.idempotency_key`.

---

## 26. Structural prohibitions (frozen Part 26)

| Prohibited | Enforced by |
|---|---|
| `ventas` table | absent — all sales are `pedidos` with `estado='DELIVERED'` |
| stored running balances | no balance column on clients / suppliers / financial_account |
| `MORTALITY_CONFLICT`, `conflict_flag`, `conflicting_event_id` | absent — invariant 2 covers it |
| `classification.flock_id` | absent — eggs mix before classification |
| `classification_inputs` | absent |
| `daily_production.classification_session_id` | absent |
| `daily_feed_consumption` as real per-flock consumption | absent; consumo económico is derived (invariant 27), consumo teórico uses `genetics_consumption_curve` |
| `pedido_audit_events` / per-entity audit tables | absent — single transversal `audit_events` |
| hard-delete of committed facts | no DELETE privilege on fact tables; all FKs `ON DELETE RESTRICT` |
| silent modification of closed periods | invariant 10 |
| full double-entry debit/credit | absent — signed amounts only |
| individual anonymous retail sale rows | absent — one aggregated Pedido per session (invariant 28) |
| manual P&L results table | absent — P&L is derived |

---

## 27. Derived values are never stored

| Value | Derivation |
|---|---|
| client balance | `SUM(client_ledger.signed_amount)` per cliente_id |
| supplier balance | `SUM(supplier_ledger.signed_amount)` per supplier_id |
| account balance | `SUM(financial_posting.signed_amount)` per account |
| order total | `SUM(pedido_lineas.subtotal) WHERE is_current` |
| flock population | `flocks.initial_population + SUM(population_events.delta WHERE is_current)` |
| classified total | `SUM(classification_line.quantity)` per session |
| consumo interno | `opening_count + manufacturing − external_output ± adjustments − closing_count` |
| consumo teórico | population × age × `genetics_consumption_curve` × assigned formula |
| landed cost | `purchases.amount_total + SUM(freight_allocation.allocated_amount)` |
| P&L | derived from ledgers and postings |

**Enforced by:** the corresponding columns and tables do not exist.  
**Consumo interno vs teórico:** the first is an inventory equation over a period; the second is a productive control metric. Neither claims to be measured daily per flock, because Santo Tomás does not measure that (frozen Part 15).

---

## 28. Feria aggregation

**Rule:** anonymous retail sales are never individual rows. One `sales_session` produces at most one aggregated Pedido (`pedidos.is_aggregated_retail = true`) whose `pedido_lineas` itemise the retail total. Several lines for the same product are allowed when different prices were charged. Identified wholesale clients get normal Pedidos carrying `pedidos.sales_session_id`.  
**Enforced by:** `close_sales_session` (RPC 33) creates the aggregated Pedido and routes it through `deliver_order`, so the retail sale becomes economic through the normal path; `sales_session.aggregated_pedido_id` records the link.  
**Separation:** `sales_session_movement` holds physical movements only (DISPATCH / RETURN / LOSS / ADJUSTMENT) with no economic effect; `sales_session_cash_event` holds cash management. The session is the operational event; the Pedido is the economic fact.  
**Reconciliation:** cash `COUNT` observations are compared against session postings, MP through `mp_reconcile_movement`, CC through the identified clients' Pedidos. Variances become explicit adjustments; no correspondence is invented.

---

## 29. No dated flock activity after the flock's exit **[ADR-007]**

**Rule:** when `flocks.exit_date IS NOT NULL`, no dated flock activity may be created or rectified with an effective date
after it: `daily_production.production_date`, `population_events.event_date` (MORTALITY and COUNT_ADJUSTMENT) and
`flock_feed_assignment.effective_from` must be `<= exit_date`. The rule is about the effective date, not the flock's
current state: activity dated on or before the exit stays valid, and correctable, on a RETIRED flock.
**Enforced by:** the owner-only INVOKER helper `assert_flock_activity_date(flock_id, date)` (`ACTIVITY_AFTER_FLOCK_EXIT`),
called by RPCs 18–22 and 29; RPC 45 `close_flock` refuses an exit date before existing current activity
(`EXIT_BEFORE_RECORDED_ACTIVITY`). The helper reads the flock `FOR KEY SHARE`, so a dated write concurrent with a close
waits for it and sees the committed exit date. No write privilege on `flocks` exists for any API role.
**Violation:** activity after the exit falls outside `report_flock_day` (which stops at `exit_date`) and describes birds that
are no longer housed.

## 30. A classification session counts once, in its current version **[ADR-012]**

**Rule:** a session's lines store the entry as typed (`entered_quantity`, `entered_unit`) and the canonical egg count (`quantity`), converted by the backend (UNIDAD = 1; MAPLE = 20 for XL, 30 otherwise). A rectification creates a new version and marks the prior one not current; the prior version is never changed or deleted. Daily totals count `is_current` versions only.
**Enforced by:** RPC 25 / RPC 47 (conversion, chain), `chk_classification_line_unidad`, `chk_classification_version_chain`, `UNIQUE (supersedes_id)`, no write privilege for API roles, `report_classification_day` filtering `is_current`.
**Violation:** a rectified session double-counted, or a canonical total that cannot be traced to the entry.

## 31. One effective formula version per feed type **[ADR-013]**

**Rule:** for a feed type, the validity windows of its versions never overlap; versions are created only by RPC 48 (atomic, prior version closed at D − 1); a version without lines is never manufactured; a used version is immutable.
**Enforced by:** `excl_feed_formula_version_no_overlap`, RPC 48, RPC 26 (`FORMULA_VERSION_EMPTY`), `reject_line_on_used_formula_version`, no INSERT / UPDATE / DELETE for API roles.
**Violation:** two recipes valid on the same day for the same feed, or manufacturing with an empty or rewritten recipe.

## 32. A manufacturing counts once, in its current version **[ADR-014]**

**Rule:** a manufacturing record is corrected only by a new version (RPC 49); the prior version is never changed or deleted and stops being current; consumption reporting counts `is_current` versions only. Each version keeps its exact formula version.
**Enforced by:** RPC 49, `chk_feed_manufacturing_version_chain`, `UNIQUE (supersedes_id)`, no write privilege for API roles, `report_feed_consumption_interval` filtering `is_current`.
**Violation:** a corrected manufacturing double-counted, or a historical record rewritten.

## 33. A Feria closing counts once, in its current version **[ADR-016]**

**Rule:**
- A summarized Feria closing is corrected only by a new version (RPC 52); the prior version is never changed (except `is_current`) or deleted.
- Its treasury effects are compensated by new rows (client_ledger REVERSAL, opposite postings).
- Sales count once, through the single aggregated pedido (corrected by RPC 2).
- "Gastos de Feria" and "Diferencia de caja" count once, from the current version.
- MP sales are never collected manually (ADR-006 is the only MP money authority).
- The opening float is never revenue and has no posting.
- Total, expected cash and difference are never stored.

**Enforced by:** RPCs 51 / 52, `chk_feria_closing_version_chain`, `UNIQUE (supersedes_id)`, `uq_feria_closing_current`, no write privilege, `pnl_line_item` / `report_feria_closing` filtering `is_current`.
**Violation:** a rectified Feria double-counted in sales, expenses, difference or treasury, or an MP sale collected twice.


## 34. Pre-cutover Mercado Pago activity is never applied again **[ADR-017]**

**Rule:** the owner-validated MP opening balance is the authority for everything before `mp_cutover_boundary.cutover_at`. An approved payment (`date_approved`) or a report row (`occurred_at`) strictly before the boundary creates no movement and no posting in the target; at or after the boundary it is processed normally. Without a boundary, no MP source is normalized. Refund / chargeback evidence is never classified as pre-cutover.
**Enforced by:** RPC 40 guard (0071), the singleton owner-only `mp_cutover_boundary`, the cutover runner (written once, validate C25).
**Violation:** pre-cutover money counted twice (opening + receipt), or a post-cutover adverse event discarded as pre-cutover.
---

## COMPLIANCE MATRIX

| # | Invariant | Schema | Privileges | RPC | Trigger |
|---|---|---|---|---|---|
| 1 | one ACTIVE flock/shed | partial unique index | no write on flocks | RPC 44 / 45 **[ADR-007]** | — |
| 2 | one current MORTALITY/date | partial unique index | — | RPC 20/21 | — |
| 3 | subtotal derived | GENERATED ALWAYS | — | — | — |
| 4 | delivered order immutable | — | no UPDATE on lines | RPC 2 | — |
| 5 | client balance derived | no column | — | — | — |
| 6 | account balance derived | no column | — | — | — |
| 7 | supplier balance derived | no column | — | — | — |
| 8 | posting belongs to operation | NOT NULL + FK | — | — | — |
| 9 | append-only | — | REVOKE | metadata only | — |
| 10 | no write to CLOSED period | — | REVOKE | ASSERT_PERIOD_OPEN ×37 | — |
| 11 | created_at never determines period | explicit DATE columns | — | all | — |
| 12 | determinant matrix | DATE columns | — | all | — |
| 13 | boundary semantics | CHECK + UNIQUE | — | date_trunc | — |
| 14 | timezone-explicit dates | derived DATE columns | — | RPC 1,2,3,5 | — |
| 15 | order total derived | no column | — | — | — |
| 16 | set-versioned rectification | version_seq + is_current + EXCLUDE constraint | no UPDATE | RPC 2,14,19,21 | — |
| 17 | snapshots immutable | snapshot columns | no UPDATE | at insert | — |
| 18 | cheque state machine | CHECK + unique event index | — | RPC 5–12, 42 **[ADR-001]** | — |
| 19 | instrument semantics | provenance columns | — | RPC 5–12, 42 **[ADR-001]** | — |
| 20 | cheque_number not identity | no UNIQUE + CHECKs | — | — | — |
| 21 | MP raw immutable | column split | no UPDATE | RPC 40/41 | raw guard |
| 22 | freight no double count | allocation table | no UPDATE | RPC 16/17 | — |
| 23 | ~~attachment required~~ superseded **[ADR-010]** | — | no INSERT | RPC 13 | — |
| 24 | purchase classification | NOT NULL + FK | — | RPC 13 | — |
| 25 | invoice unique per supplier | scoped partial index | — | RPC 13 | — |
| 26 | structural prohibitions | absent tables/columns | no DELETE | — | — |
| 27 | derived never stored | absent columns | — | — | — |
| 28 | feria aggregation | is_aggregated_retail | — | RPC 33 | — |
| 29 | no flock activity after exit **[ADR-007]** | — | no write on flocks | RPC 18–22, 29, 45 (assert_flock_activity_date) | — |
| 30 | classification counts once, current version **[ADR-012]** | chain / entry CHECKs, UNIQUE supersedes_id | no write on classification | RPC 25, 47 | — |
| 32 | manufacturing counts once, current version **[ADR-014]** | chain CHECK, UNIQUE supersedes_id | no write on feed_manufacturing | RPC 26, 49 | — |
| 31 | one effective formula version per feed type **[ADR-013]** | EXCLUDE no_overlap | no write on versions / lines | RPC 48, 26 | reject_line_on_used_formula_version |
| 33 | Feria closing counts once, current version **[ADR-016]** | chain CHECK, UNIQUE supersedes_id, partial unique current | no write on sales_session_closing | RPC 51, 52 | — |
| 34 | pre-cutover MP activity never reapplied **[ADR-017]** | singleton boundary, no default | no API privilege on the boundary | RPC 40 | — |

---

## VERIFICATION QUERIES

```sql
-- 1 one ACTIVE flock per shed (expect 0)
SELECT shed_id FROM flocks WHERE estado='ACTIVE' GROUP BY shed_id HAVING COUNT(*) > 1;

-- 2 one current mortality per (flock, date) (expect 0)
SELECT flock_id, event_date FROM population_events
 WHERE event_type='MORTALITY' AND is_current=true
 GROUP BY flock_id, event_date HAVING COUNT(*) > 1;

-- 3 generated subtotal (expect 0)
SELECT id FROM pedido_lineas WHERE subtotal <> cantidad * precio_unitario;

-- 5/6/7 no stored balance columns (expect 0)
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema='public' AND column_name IN
   ('balance','saldo','running_balance','client_balance','supplier_balance','account_balance');

-- 8 no orphaned postings (expect 0)
SELECT p.id FROM financial_posting p
  LEFT JOIN financial_operation o ON o.id = p.financial_operation_id
 WHERE o.id IS NULL;

-- 15 no monto_total (expect 0)
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='pedidos' AND column_name='monto_total';

-- 16 exactly one current line version per order (expect 0; the EXCLUDE constraint makes this
--    unreachable, so a non-empty result means the constraint is missing)
SELECT pedido_id FROM pedido_lineas WHERE is_current=true
 GROUP BY pedido_id HAVING COUNT(DISTINCT version_seq) > 1;

-- 16 the constraint that guarantees the above actually exists (expect 1)
SELECT conname FROM pg_constraint
 WHERE conname = 'excl_pedido_lineas_single_current_version' AND contype = 'x';

-- 16 rectified orders net to the current version's total (expect 0)
SELECT p.id FROM pedidos p
 WHERE p.estado='DELIVERED'
   AND (SELECT COALESCE(SUM(signed_amount),0) FROM client_ledger
         WHERE source_entity_type='pedido' AND source_entity_id = p.id::TEXT
           AND movement_type IN ('SALE_DELIVERY','REVERSAL'))
     <> (SELECT COALESCE(SUM(subtotal),0) FROM pedido_lineas
          WHERE pedido_id = p.id AND is_current = true);

-- 18 no state belonging to the wrong direction (expect 0)
SELECT id FROM financial_instrument
 WHERE (direction='RECEIVED' AND estado IN ('ISSUED','DEBITED','CANCELLED'))
    OR (direction='ISSUED'   AND estado IN ('RECEIVED','DEPOSITED','CLEARED','ENDORSED'));

-- 19 every CLEARED received instrument knows its bank account (expect 0)
SELECT id FROM financial_instrument
 WHERE direction='RECEIVED' AND estado IN ('CLEARED') AND bank_account_id IS NULL;

-- 20 cheque_number carries no global unique index (expect 0)
SELECT indexname FROM pg_indexes
 WHERE tablename='financial_instrument' AND indexdef ILIKE '%UNIQUE%'
   AND indexdef ILIKE '%cheque_number%';

-- 22 freight never over-allocated (expect 0)
SELECT f.id FROM freight f
 WHERE (SELECT COALESCE(SUM(allocated_amount),0) FROM freight_allocation
         WHERE freight_id = f.id) > f.amount;

-- 23 SUPERSEDED [ADR-010]: purchases without attachments are valid (query kept only as information)
SELECT p.id FROM purchases p
 WHERE NOT EXISTS (SELECT 1 FROM purchase_attachment a WHERE a.purchase_id = p.id);

-- 25 invoice numbers unique per supplier only (expect 0)
SELECT supplier_id, supplier_invoice_number FROM purchases
 WHERE supplier_invoice_number IS NOT NULL AND is_current=true
 GROUP BY supplier_id, supplier_invoice_number HAVING COUNT(*) > 1;

-- 26 prohibited tables absent (expect 0)
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_name IN
   ('ventas','classification_inputs','daily_feed_consumption','pedido_audit_events');

-- 28 at most one aggregated Pedido per session (expect 0)
SELECT sales_session_id FROM pedidos
 WHERE is_aggregated_retail=true AND sales_session_id IS NOT NULL
 GROUP BY sales_session_id HAVING COUNT(*) > 1;

-- 29 no current flock activity after the flock's exit date (expect 0)   [ADR-007]
SELECT f.id FROM flocks f
 WHERE f.exit_date IS NOT NULL AND (
   EXISTS (SELECT 1 FROM daily_production d WHERE d.flock_id = f.id AND d.is_current AND d.production_date > f.exit_date)
   OR EXISTS (SELECT 1 FROM population_events e WHERE e.flock_id = f.id AND e.is_current AND e.event_date > f.exit_date)
   OR EXISTS (SELECT 1 FROM flock_feed_assignment a WHERE a.flock_id = f.id AND a.effective_from > f.exit_date));
```

---

**STATUS: FROZEN — 29 INVARIANTS SPECIFIED, EACH WITH A NAMED ENFORCEMENT MECHANISM** (invariant 29 by ADR-007)

No invariant contradicts the schema, the RPC contracts or the security model.
