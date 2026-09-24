# TARGET ARCHITECTURE REVIEW — ROUND 2

**Date:** 2026-09-24  
**Methodology:** Attempt to break each refinement decision using real Santo Tomás scenarios and repository evidence.

---

## 1. LEDGER FINANCIERO: financial_operation + financial_posting

**DECISION REVIEWED:**

Architecture separates:
- `financial_operation` (the business fact)
- `financial_posting` (impact on account, signed)

Transfers: two postings linked to same operation
Payments: one posting per account affected

**VERDICT:** SOLID WITH CHANGE

**REPOSITORY EVIDENCE:**

Current code:
```sql
-- movimientos_caja
CREATE TABLE movimientos_caja (
  tipo ('ingreso', 'egreso'),
  monto NUMERIC,
  cuenta_origen TEXT,
  cuenta_destino TEXT,
  vinculado_a ('pedido', 'pago', 'ninguno'),
  ...
)
```

Facts:
1. Account fields are TEXT, not FK (weak referential integrity)
2. Transfer modeled as TWO separate movimientos (one ingreso, one egreso)
3. No linking between the two (race condition: one created, other fails)
4. vinculado_a is free-text (no enum constraint)

**CONCRETE COUNTEREXAMPLE:**

Transfer Mercado Pago → BNA (500k)

Current flow:
```
1. INSERT movimientos_caja (tipo='egreso', monto=500k, cuenta_origen='Mercado Pago', ...)
2. INSERT movimientos_caja (tipo='ingreso', monto=500k, cuenta_destino='BNA', ...)
```

Scenario: Between step 1 and 2, app crashes.

Result: 
- MP account shows -500k debit
- BNA account shows no credit
- Transfer is incomplete, orphaned
- Arithmetic: MP = -500k, BNA = 0 → total cash is -500k (wrong!)

With proposed financial_operation model:
```
1. INSERT financial_operation (type='transfer', reference='TRANSFER-001')
2. INSERT financial_posting (account='MP', amount=-500k, op_id=1)
3. INSERT financial_posting (account='BNA', amount=+500k, op_id=1)
```

IF DB enforces FK operation_id → both postings must belong to same operation.
IF either insert fails, both must rollback (transactional).
THEN orphaned postings impossible.

**REQUIRED CHANGE:**

Add `operation_id` FK to financial_postings.

Enforce at DB level:
```
UNIQUE (operation_id) if operation is single-impact (payment)
or
Allow multiple postings per operation if multi-impact (transfer)
```

**SCHEMA CONSEQUENCE:**

```
financial_operation
  id BIGSERIAL PK
  operation_type ('payment_in', 'payment_out', 'transfer', 'fee', 'interest', ...)
  reference_code VARCHAR (TRANSFER-001, PAYMENT-001, etc.)
  effective_date DATE
  created_at TIMESTAMP

financial_posting
  id BIGSERIAL PK
  operation_id BIGINT FK financial_operation NOT NULL
  account_id BIGINT FK financial_accounts
  amount NUMERIC (signed)
  occurred_at TIMESTAMP
  created_at TIMESTAMP
  
CONSTRAINT: DELETE operation CASCADE delete postings
            (or disallow if period closed)
```

**MIGRATION CONSEQUENCE:**

Must rebuild all movimientos_caja:
- Identify paired transfers (matching monto, opposite tipo, same date range)
- Group into financial_operation records
- Create two financial_postings per transfer

Risk: If pairing heuristic is wrong, false transfers created.

Mitigation: Manual audit + flag pairs for admin review.

**VERDICT FINAL: SOLID**

This solves the orphaning problem. Implementation adds complexity but safety benefit justified.

---

## 2. CLIENT LEDGER / SUPPLIER LEDGER

**DECISION REVIEWED:**

Formalize CC movements; calculate balance as SUM(movements).

No `running_balance` persistence.

Movements are signed: + increases debt, - decreases debt.

**VERDICT:** SOLID

**REPOSITORY EVIDENCE:**

Current system:
- `pagos` table (cliente_id, monto, fecha_pago)
- No formal ledger
- CC balance calculated ad-hoc: SUM(pedidos.monto_total) - SUM(pagos.monto)

Code in archivos.ts (arqueos):
```typescript
export async function calcularSaldoEfectivoRegistrado(hastaFecha: string): Promise<number> {
  // Cálculo ad-hoc, no persistent balance
}
```

**CONCRETE COUNTEREXAMPLE TESTED:**

Scenario A: Anticipos

Customer pays 100k upfront (no pedido yet).

Current system:
- `INSERT pago (cliente_id=X, monto=100k)`
- No corresponding pedido
- Balance = SUM(pedidos) - SUM(pagos) = 0 - 100k = -100k (saldo a favor, OK)

With client_ledger:
```
INSERT client_ledger (client_id=X, movement_type='advance_payment', amount=-100k)
balance = SUM() = -100k ✓
```

Scenario B: Cheque Rejected After Period Close

Cheque accepted 2026-09-15: balance reduced by 100k.
Period closed 2026-10-01.
Cheque bounces 2026-10-05.

Current system:
- No reversal mechanism
- CC balance remains incorrectly reduced
- Must manually correct or create fake "negative pago"

With client_ledger + immutable:
```
Movement 1: type='check_received', amount=-100k, date='2026-09-15'
Balance = -100k

[Period closed]

Movement 2: type='check_reversal', amount=+100k, date='2026-10-05'
Balance = 0 ✓
```

Reversal is explicit, post-close, auditable.

**EDGE CASE FOUND: Rectificación after CC movement**

Pedido original: 300k
Customer pays 150k (CC = -150k, debt remains 150k)
Pedido rectified down to 250k

Question: Should CC movement be recalculated retroactively?

Decision: NO. CC movements are immutable. Pedido rectification creates NEW ledger entry (adjustment).

```
Pedido: 300k → 250k (difference -50k)
  ↓
  CREATE client_ledger (type='order_adjustment', amount=+50k)
  ↓
  New balance = -150k + 50k = -100k (debt reduced)
```

This keeps CC movements as audit trail, not rewritable.

**CONCRETE COUNTEREXAMPLE FOUND: None**

No scenario breaks this model if applied consistently.

**VERDICT FINAL: SOLID**

---

## 3. PEDIDO → VENTA

**DECISION REVIEWED:**

Toda venta pasa por Pedido.

Estados: PENDING → DELIVERED → CANCELLED

No entrega parcial.

Rectificación post-delivery: admin can revert/recalculate consequences without creating CC credit note (internal operation).

**VERDICT:** BROKEN

**REPOSITORY EVIDENCE:**

Current code: `rectificarPedido()` in src/api/pedidos.ts

```typescript
export async function rectificarPedido(id: number, lineas, fechaPedido, clienteId, clienteNombre, observaciones) {
  // Updates pedido directly
  // Does NOT revert GL entries
  // Does NOT audit what changed
}
```

Code allows:
1. Deliver order (estado='entregado', economic event recognized)
2. Rectify lines (cambiar cantidad, precio, etc.)
3. Monto total changes retroactively

**CONCRETE COUNTEREXAMPLE:**

Scenario: CC affected by unaudited change

```
Timeline:
2026-09-24: Pedido 1 created: 10 docenas × 3600 = 36k
2026-09-24: marcarEntregado() → estado='entregado'
            CC impact: client owes 36k

2026-09-25: Operator realizes error: should be 5 docenas (only half order)
            rectificarPedido(pedido_id=1, cantidad=5)
            → UPDATE pedidos SET lineas=..., monto_total=18k
            
2026-09-26: Check client CC: shows 18k owed (CORRECT by accident)
            But NO audit trail of change
            Client doesn't know they were overcharged then auto-corrected
```

Problem:
- No reversal GL entry created for the 18k overcharge
- No CC adjustment recorded
- No timestamp of when correction occurred
- If this happens in CLOSED period, system allows it anyway

Expected by decision owner:
- Admin uses "Rectificar venta" UI
- System prompts for reason
- Reverses old state consequences atomically
- Applies new state consequences
- Records audit trail
- Requires period reopening if CLOSED

Current system:
- Simple SQL UPDATE, no enforcement

**REQUIRED CHANGE:**

Disallow direct UPDATE on estado='entregado' pedidos.

Instead:

```
rectify_order_post_delivery(order_id, new_details, reason):
  1. Fetch old pedido state (snapshots its consequences)
  2. Check if period is CLOSED
     → IF CLOSED, require reopen_period action first
  3. BEGIN TRANSACTION
  4. Revert old GL entries (create compensating postings)
  5. Revert old CC ledger entry (add adjustment)
  6. UPDATE pedido with new values
  7. Create NEW GL entries for new amount
  8. Create NEW CC ledger entry for difference
  9. INSERT audit_event (who, when, reason, before/after)
  10. COMMIT
```

**SCHEMA CONSEQUENCE:**

```
pedido_audit_events
  id, pedido_id, event_type ('created', 'delivered', 'rectified', 'cancelled'),
  state_before JSONB (full old pedido + consequences),
  state_after JSONB,
  reason TEXT,
  executed_by UUID,
  executed_at TIMESTAMP
```

**MIGRATION CONSEQUENCE:**

Current pedidos have NO audit trail.

For historical records:
- Assume rectifications never occurred (if we find conflicting data, flag for manual review)
- OR: Create audit events with event_type='unknown_change' if data seems modified

**VERDICT FINAL: BROKEN → FIXABLE**

The decision is sound in PRINCIPLE but current implementation allows silent modification.

Must enforce via:
1. DB trigger (disallow UPDATE on estado='entregado')
2. Dedicated RPC for rectification
3. Audit trail logging

---

## 4. FERIA — SALES SESSION MODEL

**DECISION REVIEWED:**

One aggregated Pedido to "Consumidor Final" with order_lines itemization.

No individual minorista records if not captured operationally.

Multiple sales sessions per day allowed.

**VERDICT:** SOLID

**REPOSITORY EVIDENCE:**

Current system: No sales_sessions table at all.

Retail would go to individual pedidos.

No aggregation concept exists.

**CONCRETE COUNTEREXAMPLE TESTED:**

Scenario: Feria with mixed prices

Morning: sell 10 docenas at 3600 (discounted)
Afternoon: sell 5 docenas at 3800 (regular price)

Average: (10×3600 + 5×3800) / 15 = 3733.33

If aggregated Pedido uses ONE price_unit for docenas, average is invisible.

Solution: order_lines preserves all.

```
order_line 1: 10 docenas × 3600 = 36k
order_line 2: 5 docenas × 3800 = 19k
Total: 55k
```

Revenue analytics can then query by price_unit.

**CONCRETE COUNTEREXAMPLE TESTED:**

Scenario: Feria with returns

Evening: customer returns 2 broken docenas (bought in morning).

Option A: Negative order_line (current industry standard)
```
order_line 1: 10 docenas × 3600 (morning sales)
order_line 2: -2 docenas × -3600 (return)
Net: 8 docenas = 28.8k
```

Option B: Separate sales_session_returns table
```
sales_session_items: 10 docenas × 3600
sales_session_returns: 2 docenas × 3600
```

Decision model allows Option A (negative lines).

Query correctness:
```
SELECT SUM(cantidad * precio) FROM order_lines WHERE order_id = feria_pedido
= (10*3600) + (-2*-3600) = 36k - 7.2k = 28.8k ✓
```

Both approaches work if implemented consistently.

**CONCRETE COUNTEREXAMPLE FOUND: None**

Sales session model with aggregated Pedido + itemized lines is sound.

**VERDICT FINAL: SOLID**

---

## 5. CLASIFICACIÓN — NO LOTE ATTRIBUTION

**DECISION REVIEWED:**

Huevos se mezclan antes de clasificar.

Classification does NOT reference lote_id.

Cannot trace "this classified egg came from flock #7".

**VERDICT:** SOLID

**REPOSITORY EVIDENCE:**

Current schema:
- `producciones` table has lote_id
- NO `classifications` table (doesn't exist)
- Daily production is per lote

Code flow: producciones record production, then... silent.
No classification table to represent the post-pooling output.

**CHECKING REPOSITORY FOR DEPENDENCIES:**

Grep for any code that tries to link classification to lote:

Found: NO such code (because classifications table doesn't exist).

**CONCRETE COUNTEREXAMPLE TESTED:**

Scenario: Traceability requirement

Flock A (genetic line X) produces 500 eggs 2026-09-24
Flock B (genetic line Y) produces 300 eggs 2026-09-24

Both mixed, classified together.

Result:
- 200 XL
- 350 N1
- 250 N2

Question: How many XL came from flock A?

Answer: UNKNOWABLE and that's OK.

If a customer complains about XL quality, we cannot trace to flock.

But we CAN trace back to production_date (2026-09-24) and know general state of both flocks.

This is acceptable operational tradeoff (production tracking vs per-egg traceability).

**VERIFICATION AGAINST REPO:**

Found NO code that requires classification-to-lote linkage.

**VERDICT FINAL: SOLID**

No repository evidence contradicts this. Decision is sound AND reflects actual operations.

---

## 6. POBLACIÓN Y MORTALIDAD

**DECISION REVIEWED:**

population_events as immutable event log.

Types: MORTALITY, COUNT_ADJUSTMENT.

No arbitrary 7-day lock; depends on period close.

**VERDICT:** SOLID WITH CHANGE

**REPOSITORY EVIDENCE:**

Current code:
```sql
producciones.mortandad (INT, editable)
recuentos_lote.mortalidad (INT, editable)
recuentos_lote.poblacion (INT, explicit count)
```

Both tables allow UPDATE (mutable).

No constraints preventing:
- Negative mortality
- Impossible population changes
- Misalignment between tables

**CONCRETE COUNTEREXAMPLE:**

Scenario: Concurrent operators

Operator A records: 2026-09-24, flock #5, mortandad=3
Operator B records same: 2026-09-24, flock #5, mortandad=5 (different count)

Current system: Last-write-wins, no conflict detection.

With population_events (immutable):
```
CREATE population_event (flock#5, date=2026-09-24, type=MORTALITY, delta=-3, source='operator_A')
CREATE population_event (flock#5, date=2026-09-24, type=MORTALITY, delta=-5, source='operator_B')
```

Population now shows BOTH events (total -8 mortality).

This is wrong if only ONE is correct.

Solution: Require REASON field + manual resolution.

```
population_event {
  ..., type=MORTALITY_CONFLICT,
  delta=-3 (original), delta_conflict=-5 (conflicting),
  reason='Discrepancy detected: two operators recorded different counts',
  resolved_by NULL (pending resolution)
}
```

**REQUIRED CHANGE:**

Add conflict detection:

```
CONSTRAINT: if ((flock_id, event_date, type) exists), 
            then new event must have type=COUNT_ADJUSTMENT or MORTALITY_CONFLICT
            not another MORTALITY event same date
```

Or:

```
CONSTRAINT: No two MORTALITY events for same (flock_id, event_date)
UNLESS one has reason='correction' or 'conflict_resolution'
```

**SCHEMA CONSEQUENCE:**

```
population_events {
  ...,
  conflict_flag BOOLEAN DEFAULT FALSE,
  conflicting_event_id BIGINT FK population_events (nullable),
  resolved BOOLEAN DEFAULT FALSE,
  resolved_by UUID,
  ...
}
```

**MIGRATION CONSEQUENCE:**

Current producciones.mortandad with multiple records per day per lote must be deduplicated.

If conflicts found: create CONFLICT records for audit.

**VERDICT FINAL: SOLID WITH CHANGE**

Add conflict detection to prevent silent overwrites of mortality data.

---

## 7. CIERRE MENSUAL — INTEGRAL LOCK

**DECISION REVIEWED:**

Period CLOSED locks all domain operations.

Protects commercial, economic, financial, productive, cost, fiscal.

Also locks production.

Late data (invoices, MP) must happen BEFORE close.

NO soft-close with selective locking.

**VERDICT:** BROKEN

**REPOSITORY EVIDENCE:**

Current system: No period concept at all.

No OPEN/CLOSED mechanism.

All operations always allowed.

**CONCRETE COUNTEREXAMPLE:**

Scenario: MP reconciliation timing

Mercado Pago processes settlements with 24-48 hour lag.

Workflow:
```
2026-09-30: End of month
            Close period for September

2026-10-01 09:00: MP batch report arrives
                  (dated 2026-09-30, but received 2026-10-01)
                  reconciliation needed
```

Question: Should September be kept OPEN until MP batch arrives?

If YES: Management cannot close books until uncertain of MP complete.

If NO: MP data arrives after close → must reopen September.

Current decision: INTEGRAL LOCK requires reopen.

Problem: No definition of "when is MP complete?"

MP can send corrections days/weeks later.

**CONCRETE COUNTEREXAMPLE:**

Scenario: Cheque-deposit timing

Cheque received 2026-09-25, vencimiento 2026-10-15.

Deposited 2026-10-01 (after period close).

Clears 2026-10-05.

When does this affect which period?

Decisions:
A) CC reduced when received (2026-09 period)
   Bank impact in 2026-10 period
   Temporal mismatch

B) CC reduced when deposited (2026-10 period)
   But then customer thinks they owe past amount unnecessarily

C) CC reduced when cleared (2026-10 period)
   But cheque is 2026-09 financial fact

**REQUIRED CHANGE:**

Define EXACT rules per transaction type:

```
PERIOD DETERMINATION RULES:

Sales/Pedidos:
  Period = delivered_at date (economic event)
  Even if payment arrives later

Purchases:
  Period = document_date
  (economic event = invoice date, not payment date)

Collections:
  Period = receipt_date
  (when cash/check/MP confirmed, not when cleared)

Bank/MP clearance:
  Period = settlement_date
  (separate from economic event period)

Production/Mortality:
  Period = event_date
  (when it actually occurred)

Cheques:
  Received: CC impacted in receipt period
  Deposited: separate financial transaction, deposit period
  Cleared: another financial transaction, clearing period
```

**SCHEMA CONSEQUENCE:**

```
CLOSED period prevents INSERT/UPDATE on entities WHERE effective_date IN [period_start, period_end]

Exceptions (allowed to post-close):
- Clearing events (bank reconciliation)
- Corrections (marked as corrections)
- Adjustments (marked as adjustments)
  (But these require reason + approval)

Additions after close:
- Must have audit trail
- Cannot recalculate prior period P&L (frozen snapshot)
```

**MIGRATION CONSEQUENCE:**

Must define "effective_date" for every operation type.

Historical data must be assigned to correct period.

**VERDICT FINAL: BROKEN → NEEDS SPECIFICATION**

Decision is correct in principle (lock periods) but lacks definition of WHICH DATE determines period membership for each transaction type.

---

## 8. FECHAS — MINIMAL APPROACH

**DECISION REVIEWED:**

Each entity only stores dates it needs semantically.

Pedido: order_date, delivered_at, economic_date, created_at
Purchase: economic_date, document_date, created_at
etc.

**VERDICT:** SOLID

**REPOSITORY EVIDENCE:**

Current system:
```sql
pedidos: fecha_pedido, fecha_pago?, fecha_operacion, entregado_en, creado_en, actualizado_en
producciones: fecha (production date)
cheques: fecha_emision, fecha_vencimiento (no fecha_deposito, fecha_cobrada)
```

Inconsistency: pedidos has 5+ date fields; cheques missing deposit/clear dates.

**CONCRETE COUNTEREXAMPLE:** None

The principle (minimal dates, semantic naming) is sound.

Current implementation is messy because names are inconsistent (fecha_pedido vs fecha_operacion vs fecha_pago).

Solution: Standardize names per Decision 8, not add more.

**VERDICT FINAL: SOLID**

---

## 9. CHEQUES / ECHEQS — STATE MACHINE

**DECISION REVIEWED:**

financial_instrument + financial_instrument_events

Received cheque: RECEIVED → DEPOSITED → CLEARED (or REJECTED at any point)
Issued cheque: ISSUED → DEBITED (or REJECTED)

**VERDICT:** SOLID

**REPOSITORY EVIDENCE:**

Current code:

```sql
cheques {
  estado ('emitido', 'cobrado', 'rechazado', 'cancelado')
}
```

Issues:
- Only 4 states, no intermediate states
- No eventos log (historia)
- No timestamp per state transition
- 'cancelado' means what? (cancelled before depositing? cancelled after clear?)

Proposed events approach:
```
cheque {
  id, number, bank, amount, issue_date, due_date, direction ('received', 'issued'), ...
}

cheque_events {
  cheque_id FK,
  event_type ('RECEIVED', 'DEPOSITED', 'CLEARED', 'REJECTED', 'ENDORSED'),
  event_date,
  recorded_at,
  details JSONB (reject_reason, endorse_to, etc.)
}
```

**CONCRETE COUNTEREXAMPLE:** None

Events approach is strictly better than mutable status.

**VERDICT FINAL: SOLID**

---

## 10. ALIMENTO — NOT DEFERRED

**DECISION REVIEWED:**

Feed architecture must be in target schema, even if implementation is phased.

Includes: types, formulations, manufacturing, inventory, consumption, cost allocation.

**VERDICT:** BROKEN

**REPOSITORY EVIDENCE:**

Current system:
- producciones.alimento (single NUMERIC field)
- No formulations, types, manufacturing tracking
- No cost structure
- No inventory tracking beyond daily consumption record

Code shows: operators record daily alimento consumed, nothing more.

**CONCRETE COUNTEREXAMPLE:**

Scenario: Cost reconciliation

Management asks: "What is actual cost of feed per kg of bird?"

Feed purchased:
- Maize: 500 kg @ 350/kg = 175k
- Soja expeller: 100 kg @ 800/kg = 80k
- Total: 255k

Flock consumption:
- 45 days production
- 450 birds
- Records show ~18 kg/day consumed = 810 kg total

Cost per kg: 255k / 810 = 315/kg

But if formulation CHANGED mid-month:
- Days 1-20: Recipe A (70% maize, 30% soja)
- Days 21-45: Recipe B (60% maize, 40% soja)

Cost per kg shifts:
- Recipe A cost: approx 300/kg
- Recipe B cost: approx 330/kg

Blended: varies by day.

If you want accurate cost per kg RETROSPECTIVELY, you need:
1. Recording of which recipe used which days
2. Formulation cost history
3. Proportional allocation

Current system: Cannot do this analysis.

**REQUIRED CHANGE:**

Must implement formulation model to track costs accurately:

```
feed_types { id, name (Maize, Soja, Balanceado) }

feed_formulations {
  id, version, name ('Recipe A', 'Recipe B'),
  formula_date_from, formula_date_to,
  cost_per_unit DECIMAL (calculated from ingredients),
  ...
}

feed_formula_ingredients {
  formula_id FK,
  feed_type_id FK,
  percentage DECIMAL (70% maize, etc.)
}

flock_feed_assignments {
  flock_id FK,
  formula_id FK,
  assigned_from_date,
  assigned_to_date
}

daily_feed_consumption {
  flock_id, production_date, formula_id, quantity_used,
  cost_unit_applied (snapshot of formula cost that day)
}
```

**SCHEMA CONSEQUENCE:**

Feed module becomes substantial. Cannot omit.

**MIGRATION CONSEQUENCE:**

Historical producciones.alimento → convert to daily_feed_consumption.

But WITHOUT formulation history, cost allocation is WRONG.

Choose:
- Assume single formula for all 2026 (simplifying assumption)
- OR: Cannot calculate accurate historical costs

**VERDICT FINAL: BROKEN**

Cannot defer feed architecture if cost accuracy is required.

Must include in target schema even if implementation is phased.

---

## 11. COSTO PUESTO / FLETE

**DECISION REVIEWED:**

Flete is independent operation.

Can be assigned to a purchase for cost allocation WITHOUT double-counting.

**VERDICT:** SOLID WITH CHANGE

**REPOSITORY EVIDENCE:**

Current system:
- No purchase table
- Flete would go to movimientos_caja as expense
- No cost allocation mechanism

**CONCRETE COUNTEREXAMPLE:**

Scenario: Freight allocation

Purchase: 100 bags alimento @ 8k/bag = 800k (ex-freight)
Freight: 50k

Traditional accounting:
```
Inventory +800k
Expense -50k (freight)
↓
Cost of goods: 800k
Income statement: freight as separate line
```

Alternative (put freight in inventory):
```
Inventory: 800k + 50k = 850k
Cost of goods sold: 850k (when inventory sold/consumed)
Income statement: NO separate freight line
```

Santo Tomás use case:
Feed is bought AND consumed internally (cost center).

Allocating freight to the feed cost is correct.

Proposed model:
```
purchase_cost_allocations {
  allocation_id,
  source (flete record),
  source_amount (50k),
  target (purchase),
  target_amount (800k),
  allocated_fraction (50k / 800k),
  ...
}

Feed cost per kg then = (800k + 50k) / quantity_kg
```

Validation: Total allocations FROM a flete must = total flete amount.

```
CONSTRAINT: SUM(allocated_fraction) WHERE source_id = flete_id <= 1.0
```

P&L correctness:
```
Expense side:
- Flete amount appears ONCE (either as standalone expense or as part of cost of goods sold)
- NOT both
```

**VERDICT FINAL: SOLID**

Allocation model prevents double-counting if constraints are enforced.

---

## 12. SNAPSHOTS E HISTORIA

**DECISION REVIEWED:**

Include snapshot fields only where future changes would alter historical meaning.

Matrix: FK sufficient? Snapshot required? Why?

**VERDICT:** SOLID

**REPOSITORY EVIDENCE:**

Current code in pedido_lineas:
```sql
pedido_lineas {
  product_id UUID FK products,
  producto_nombre TEXT (snapshot),
  precio_unitario NUMERIC (snapshot)
}
```

Product name and price are snapshots. Good.

But missing:
```
product_category_snapshot
product_type_snapshot (input? sellable? both?)
```

Scenarios tested:

1. **Product renamed:**
   "N1 Grande" → "N1 Jumbo"
   Historical pedido shows "N1 Grande" ✓ (name snapshot preserved)

2. **Product delisted:**
   Product soft-deleted from catálogo
   Historical pedido still references it (via name snapshot) ✓

3. **Product type changes:**
   Feed (alimento): type = 'input'
   Later: type = 'input,sellable' (occasionally sold)
   Historical cost allocation uses OLD type...? ✗

   If type is used in GL account routing (feed expenses → cost center for inputs, revenue → sales for sellables), historical records must preserve type used.

4. **Tax rate changes:**
   IVA rate 21% → 27% (hypothetical)
   Invoice from 2026-06 at 21%
   System must preserve 21% was applied, not recalculate at 27%

5. **Supplier name:**
   Supplier "ABC Grains" → "ABC Grains S.A."
   Purchase invoice dated 2026-08 should still show "ABC Grains", not live name

**REQUIRED CHANGE:**

```
MATRIX:

FIELD                       FK SUFFICIENT?  SNAPSHOT?  WHY?
─────────────────────────────────────────────────────────
product_name                NO              YES        Rename causes confusion
product_price_unit          NO              YES        Rate changes affect cost
product_category            NO              YES        Category mapping affects GL
product_type                NO              YES        Type determines GL account
product_unit                NO              MAYBE      Unlikely to change
supplier_name               NO              YES        Name changes (legal)
supplier_tax_id             NO              YES        Tax ID may update
formula_version             YES*            —          Formula_id already FKs to immutable
tax_rate (aliquota)         NO              YES        Rate changes retroactively wrong
customer_fiscal_status      NO              YES        Status changes affect tax treatment
```

*Formula exception: formula_id FK is sufficient because formulas are versioned (immutable).
Old formula_id points to original version, new formula_id points to new version.

**VERDICT FINAL: SOLID**

Matrix provides clear guidance. Implementation must include these snapshots.

---

## 13. RLS — OPERATOR VS ADMIN

**DECISION REVIEWED:**

ADMIN: total access
OPERATOR: production only (lotes, producciones, recuentos, fabricación, alimento counts, temperatura)

OPERATOR cannot see: clientes, pedidos, vendas, precios, CC, finanzas, compras, costos, P&L.

**VERDICT:** SOLID

**REPOSITORY EVIDENCE:**

Current code:
```sql
-- Simple RLS
SELECT: auth.role() = 'authenticated'
INSERT/UPDATE/DELETE: is_dueño()
```

No distinction between dueño and operator.

Current UI (FormPedido, CajaApp, etc.) hides functions from non-dueño.

But DB RLS doesn't enforce (security through obscurity).

**CONCRETE COUNTEREXAMPLE:** None

RLS proposal is correct. No repository evidence contradicts it.

Implementation via policies on every financial table.

**VERDICT FINAL: SOLID**

---

## 14. MERCADO PAGO

**DECISION REVIEWED:**

MP architecture is evaluated AGAINST target design, not prior.

FASE 0 migration completion is PRE-CUTOVER (doesn't block schema design).

Immutable source → normalized movement → reconciliation → internal postings.

**VERDICT:** SOLID WITH CHANGE

**REPOSITORY EVIDENCE:**

Current system:
- mp_source_record (new, FASE 0)
- mp_financial_movement (new, FASE 0)
- ledger_entry (new, FASE 0)
- account_balance (new, FASE 0)
- reconciliation_snapshot, mp_source_link_resolution, etc. (FASE 0)

Plus LEGACY:
- mercadopago_raw (old)
- mercadopago_movements (old)
- mercadopago_settlement (old)

FASE 0 is PARTIALLY complete. Legacy still present.

**CONCRETE COUNTEREXAMPLE:**

Scenario: Dual-ledger ambiguity

Current code in mercadopago.ts:
```typescript
export async function getMPSummary(startDate, endDate) {
  // Queries mp_financial_movement + ledger_entry
  // Doesn't query old tables
}
```

But old tables STILL EXIST and could theoretically be queried elsewhere.

If system accidentally reads from both:
- Old summary ≠ New summary
- Reconciliation fails
- Which is source of truth?

**REQUIRED CHANGE:**

Before schema cutover:
1. Audit: are old MP tables EVER queried by production code?
2. If YES: must migrate those queries to FASE 0 architecture
3. If NO: can safely deprecate old tables (mark as LEGACY, optional for migration)

Decision decision: FASE 0 is source of truth post-cutover. Old tables available for audit but not queries.

**SCHEMA CONSEQUENCE:**

MP ledger_entry flows into target financial_posting model:

```
mp_source_record (immutable, raw) [KEPT]
  ↓
mp_financial_movement (normalized) [ADAPTED/REUSED]
  ↓
general_ledger postings (NEW, target model) [CREATED]
  ↓
financial_account balance
```

**MIGRATION CONSEQUENCE:**

Reconcile old vs new MP data.

If sums match: old tables can be archived.

If divergence: investigate and correct before cutover.

**VERDICT FINAL: SOLID WITH CHANGE**

Decision is sound. Implementation must complete FASE 0 migration + deprecate legacy.

---

## 15. MIGRACIÓN

**DECISION REVIEWED:**

Keep useful history from 2026-01-01.

Establish clean opening balances at cutover.

No requirement: OLD SUM = NEW SUM.

Instead: External evidence > Validated balance > Recalculated.

**VERDICT:** SOLID

**REPOSITORY EVIDENCE:**

No historical validation in current system.

Saldos are calculated ad-hoc, never formally closed.

**CONCRETE COUNTEREXAMPLE:** None

Approach (trust external evidence over legacy reconstruction) is sound.

Prevents propagating old errors into new system.

**VERDICT FINAL: SOLID**

---

## SUMMARY

| # | Area | Verdict | Status |
|---|------|---------|--------|
| 1 | Ledger: Op + Posting | SOLID WITH CHANGE | Add operation_id FK for atomicity |
| 2 | CC Ledger | SOLID | No changes needed |
| 3 | Pedido → Venta | BROKEN | Enforce immutability + audit trail |
| 4 | Feria | SOLID | Design is sound |
| 5 | Clasificación | SOLID | No lote attribution is correct |
| 6 | Población | SOLID WITH CHANGE | Add conflict detection |
| 7 | Período Cierre | BROKEN | Specify effective_date rules per type |
| 8 | Fechas | SOLID | Minimal approach is good |
| 9 | Cheques | SOLID | Events approach is better |
| 10 | Alimento | BROKEN | Cannot defer; needed for cost |
| 11 | Flete/Costo | SOLID | Allocation constraints prevent double-count |
| 12 | Snapshots | SOLID | Matrix is clear; implement snapshots |
| 13 | RLS | SOLID | DB enforcement needed, not just UI hiding |
| 14 | MP | SOLID WITH CHANGE | Complete FASE 0; deprecate legacy |
| 15 | Migración | SOLID | Trust external evidence, not recalc |

---

## A. REMAINING BLOCKERS

1. **Period Determination Rules** (from Decision 7)
   - EXACT mapping: transaction_type → effective_date field
   - Until specified: period_close ambiguity remains
   - BLOCKER: Cannot design period-closing constraints

2. **Pedido Rectification Enforcement** (from Decision 3)
   - Current system allows silent UPDATE on delivered pedidos
   - Target requires atomic reversion + audit
   - BLOCKER: GL design depends on how pedido changes propagate

3. **Feed Architecture** (from Decision 10)
   - Must be included (not deferred)
   - Formulation + ingredient modeling required for costs
   - BLOCKER: Cost allocation P&L cannot be correct without it

---

## B. OWNER DECISIONS STILL REQUIRED

1. **MP Reconciliation Timing**
   - When MUST MP batch be received to stay in-period?
   - Can period close wait for MP, or does it proceed + reopen?
   - (No repository evidence guides this)

2. **Cheque Deposit Period Attribution**
   - If cheque received 2026-09 but deposited 2026-10:
     - Does CC impact 2026-09 or 2026-10?
     - Does bank impact follow receipt or deposit date?

3. **Feed Formulation History**
   - Do you change formulas mid-month?
   - If yes: must track versions + assignment dates
   - If no: can assume single formula (simpler)

4. **Rectification Scope**
   - Can admin rectify ANY order amount? Or only within percentage threshold?
   - What requires approval vs. self-service?

5. **Cheque Endorsement**
   - Do you endorse cheques to suppliers? (Enable/disable feature)
   - Affects financial_instrument state machine complexity

---

## C. ARCHITECTURAL DECISIONS NOW SAFE TO FREEZE

✅ **ACCEPTED AS FINAL:**

1. financial_operation + financial_posting model (adds operation_id FK for atomicity)
2. client_ledger as immutable audit trail (SUM-based balance)
3. supplier_ledger as immutable audit trail (SUM-based balance)
4. Pedido as sole revenue entity (with rectification audit + atomicity)
5. sales_sessions for feria/retail aggregation
6. No lote attribution to classifications (operational reality)
7. population_events for immutable mortality tracking (with conflict detection)
8. Minimal date fields per entity (semantic naming)
9. State machines for cheques/eCheqs (events, not mutable status)
10. Snapshot fields where future changes alter meaning
11. DB-enforced RLS (ADMIN vs OPERATOR separation)
12. Snapshots required for: product_name, product_category, product_type, supplier_name, supplier_tax_id, tax_rate, customer_fiscal_status
13. Period close is integral (locks all domains once CLOSED)
14. MP architecture uses FASE 0 (deprecate legacy) + flows into general ledger
15. Migration validates against external evidence, not legacy reconstruction

✅ **AWAITING SPECIFICATION (but conceptually sound):**

- Period determination rules per transaction type
- Rectification enforcement + audit trail
- Feed formulation + cost allocation model

---

## D. MINIMAL TARGET MODEL V2

**Entidades de Base:**

### Identity/Config
- profiles (add: primer_nombre, apellido, auth_role)
- products (add: type enum, snapshots for category/type)
- product_price_history (active_from, active_to)
- financial_accounts (caja, MP, BNA, Patagonia)
- management_periods (OPEN/CLOSED with reopening audit)

### Commercial
- clients (with fiscal_status_history)
- orders (add: economic_date, snapshots for rectification audit)
- order_lines (keep: product_name, price, category snapshots)
- client_ledger (immutable audit trail, SUM-based balance)

### Retail/Feria
- sales_sessions (jornada)
- sales_session_line_items (itemized retail)
- sales_session_inventory_movements (DISPATCH, RETURN, LOSS, ADJUSTMENT)

### Purchasing
- suppliers (with fiscal_status_history, snapshots)
- purchases (add: economic_date, document_date)
- purchase_lines (with cost allocation snapshots)
- supplier_ledger (immutable audit trail, SUM-based balance)
- purchase_cost_allocations (flete → purchase, atomic)

### Treasury
- financial_operation (TRANSFER, PAYMENT_IN, PAYMENT_OUT, FEE, INTEREST, CHEQUE_DEPOSIT, CORRECTION)
- financial_posting (amount signed, FK operation_id for atomicity)
- financial_instruments (type: cheque/echeck, direction: issued/received)
- financial_instrument_events (immutable state transitions)
- financial_account_counts (arqueos)

### Production
- sheds (formalized, not TEXT)
- flocks (add: shed_id FK, not nullable)
- daily_production (add: classification_session_id reference)
- population_events (immutable, MORTALITY/COUNT_ADJUSTMENT, conflict detection)
- flock_recounts (validation checkpoints against population_events)

### Feed
- feed_types (maize, soja, balanceado, etc.)
- feed_formulations (versioned recipes, immutable)
- feed_formula_ingredients (% composition)
- flock_feed_assignments (which formula, which date range)
- daily_feed_consumption (per flock, formula, quantity, cost_unit_applied)
- feed_inventory_counts (physical counts)

### Classifications
- classifications (session, no lote_id)
- classification_lines (grade, quantity, price_unit)
- classification_inputs (backward traceability to daily_production)

### Fiscal
- tax_components (rate, type, aliquota snapshot)
- tax_obligations (monthly tracking, IVA débito/crédito)
- purchase_tax_allocation (per purchase, snapshot of rate)
- sales_tax_allocation (per order, snapshot of rate)

### Management/Audit
- audit_events (who, when, what changed, before/after, reason)
- internal_reserves (allocation of profits)
- pedido_audit_events (rectifications, state snapshots)

### Integrations/MP
- mp_source_record (FASE 0, immutable raw)
- mp_financial_movement (FASE 0, normalized)
- mp_movement_source_link (N:N reconciliation)
- mp_reconciliation_batches (explicit batching, links to financial_posting)

**TOTAL ENTITIES: ~45 tables**

**PREVIOUSLY APPROVED / NOT CHANGING:**

- Mantener cuentas iniciales (Caja, MP, BNA, Patagonia)
- Transferencias entre cuentas
- Arqueos manuales
- 1 lote per galpón
- Mortalidad observada daily
- Producción per lote
- Feed fabricación interna
- Feed venta ocasional
- Pesajes + temperatura requeridos
- IVA análisis mensual
- Historia desde 01/01/2026
- Sistema anterior read-only post-cutover

---

**CONVERGENCE ASSESSMENT:**

Target model has grown from initial 30 entities to 45.

Growth drivers:
- Feed (not deferred): +7 tables
- Formal audit trails: +4 tables
- Snapshots: +0 tables (fields only)
- Conflict detection: +0 tables
- State events: +0 tables (event_type column only)

Growth is JUSTIFIED (no abstract precaution, all solve real problems).

Model is now STABLE enough for schema design.

---

**END OF ROUND 2 REVIEW**

