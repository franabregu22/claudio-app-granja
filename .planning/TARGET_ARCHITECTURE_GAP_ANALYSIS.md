# TARGET ARCHITECTURE GAP ANALYSIS

**Date:** 2026-09-24  
**Objective:** Attack the proposed target architecture against the ACTUAL repository state.  
**Methodology:** FACT → INFERENCE → RECOMMENDATION for every finding

---

## A. DOMAIN MODEL CHALLENGES

### Challenge 1: Pedido → Venta Mapping

**PRINCIPLE:** "Toda venta nace de un Pedido. Cuando el Pedido pasa a delivered, se convierte económicamente en venta."

**FACTS FOUND:**
- Table `pedidos` has estados: 'pendiente', 'entregado', 'cancelado' (schema 001_schema.sql)
- No separate `ventas` table
- Delivery is marked by `marcarEntregado(pedido_id)` → updates `estado='entregado'`, sets `entregado_en` and `entregado_por`
- Once delivered, pedido cannot be partially invoiced or split

**INFERENCE:**
- Current system treats delivered pedido AS the economic event
- All downstream consequences (debt, revenue recognition, fiscal) trigger off pedido.estado

**PROBLEM:** 
- Code allows `marcarEntregado()` to be called, then `rectificarPedido()` (change lines) can still be called
- If you deliver, then rectify, does the economic event recalculate retroactively?
- Who owns the "economic date" vs "delivery date" vs "invoice date"?
- If a customer disputes after delivery, can we reverse/cancel the pedido or must we create credit note?

**RECOMMENDATION:**
- Define: is `entregado_en` the ECONOMIC DATE or just delivery proof?
- If they differ, need a separate `fecha_economica` or `fecha_venta`
- Clarify: after `estado='entregado'`, what operations are allowed?
  - rectification?
  - cancellation?
  - partial credit?
- Propose: once `entregado`, create immutable `economic_event` record; only allow reversals via credit note

**MIGRATION RISK:** HIGH  
If we need to separate economic date from delivery date, historical pedidos must be interpreted under old rules.

---

### Challenge 2: Customer Ledger — No Mandatory Assignment

**PRINCIPLE:** "CC cliente: no se asignan obligatoriamente cobros a facturas/pedidos específicos."

**FACTS FOUND:**
- Table `pagos` (cliente_id, monto, fecha_pago)
- No table `customer_ledger`
- `crearPago()` auto-creates `movimientos_caja` with `vinculado_a='pago'`, `vinculado_id=pago.id`
- No linking table between pagos and pedidos
- Balance calculated as `SUM(pedidos.monto_total) - SUM(pagos.monto)` ← ad-hoc, no audit trail

**INFERENCE:**
- Current system treats it as implicit ledger
- A pago is simply a cash inflow; it doesn't close against specific pedidos
- No FIFO, no specific invoice matching

**PROBLEM:**
1. **No formal CC table:** If we query customer balance on 2026-09-23, we're querying SUM() dynamically. No historical snapshot.
2. **Pedidos as debt source:** Assumption that `estado='entregado'` immediately creates debt is nowhere explicit.
3. **Pago reversal unclear:** If a pago is reversed (say, cheque bounced), does deuda go back up? No code path for this.
4. **Multi-currency/multi-period:** If we add foreign currency later, which rate applies to historical transactions?

**RECOMMENDATION:**
- Create `client_ledger` table to audit every CC movement:
  ```
  client_ledger {
    id, client_id, movement_type ('pedido_posted', 'pago_received', 'adjustment'),
    reference_id (pedido_id / pago_id / adjustment_id),
    movement_date, amount_signed, running_balance,
    created_at, created_by
  }
  ```
- Triggers on pedido delivery + pago creation to populate this
- CC balance = SELECT SUM(amount_signed) FROM client_ledger WHERE client_id = X [AND movement_date <= Y]
- Allows historical queries and audit trail

**MIGRATION RISK:** MEDIUM  
- Need to backfill client_ledger from existing pedidos + pagos
- Must correctly assign `movement_date` (use `entregado_en` for pedidos, `fecha_pago` for pagos)

---

### Challenge 3: Feria Model — Anonymous Retail + Aggregated Order

**PRINCIPLE:** "Feria se modela como jornada de venta. Toda venta debe terminar pasando por Pedido. Para minoristas anónimos se propone un pedido agregado a 'Consumidor Final'."

**FACTS FOUND:**
- No `sales_sessions` or `feria` table
- Venta minorista currently goes directly to pedidos with `cliente_id` to a real cliente
- No aggregation concept

**INFERENCE:**
- Current system requires an explicit cliente for every pedido
- Cannot model truly anonymous retail

**PROBLEM:**
1. **If we create "Consumidor Final" cliente, how do we split it later?**
   - Feria jornada might have 50 anonymous sales
   - If we aggregate them into ONE pedido for "Consumidor Final", we lose itemization
   - Revenue attribution becomes impossible
   - Later if customer returns a product, which "sub-order" do we reverse?

2. **Feria jornada coordination:**
   - Need to track: opening cash, cash received (by channel), cash withdrawn, expenses, closing count
   - A single aggregated pedido doesn't represent this
   - Need separate `sales_sessions` + `sales_session_transactions`

3. **MP reconciliation at feria level:**
   - Principle says: "muchos cobros MP pequeños pueden reconciliarse contra una única jornada de Feria agregada"
   - Current MP architecture reconciles to `mp_financial_movement` + `ledger_entry`
   - No way to link those to a feria jornada

**RECOMMENDATION:**
- DO NOT use a single aggregated Pedido for anonymous retail
- Create `sales_sessions` table:
  ```
  sales_sessions {
    id, session_date, session_type ('feria_municipal', 'local_retail'),
    opening_cash, closing_count, variance, closed_by, closed_at,
    notes, created_at
  }
  ```
- Create `sales_session_items` (each retail sale):
  ```
  sales_session_items {
    id, session_id, product_id, quantity, price_unit, customer_name (nullable),
    created_at
  }
  ```
- At close of session, generate ONE aggregated Pedido to "Consumidor Final" with the SUM
- Link feria session to that pedido for reconciliation
- This allows:
  - Detailed retail itemization within session
  - Aggregation into one economic event (pedido)
  - Late MP reconciliation at session level

**MIGRATION RISK:** HIGH  
- Must invent sales_session concept
- Requires UI for session opening/closing
- Affects how cash counts interact with revenue

---

### Challenge 4: Cheques y eCheqs — Lifecycle Implications

**PRINCIPLE:**  
"Cheque recibido: reduce CC cliente al recibirse, queda en cartera, recién afecta banco cuando se deposita.  
eCheq emitido: reduce deuda proveedor al emitirse, recién debita banco cuando se procesa."

**FACTS FOUND:**
- Table `cheques` exists: número, banco, monto, fecha_emision, fecha_vencimiento, estado ('emitido', 'cobrado', 'rechazado', 'cancelado')
- Link to `movimientos_caja` via `movimiento_caja_id`
- When `crearCheque()`, it creates a movimientos_caja record BUT the tipo/monto/concepto logic is unclear

**INFERENCE:**
- Cheques are modeled as a separate instrument
- But how does a received cheque reduce CC?
- Code shows cheques can be created, but flow for "received cheque" vs "issued cheque" not clear

**PROBLEMS:**
1. **Received cheque flow broken:**
   - When customer gives cheque in payment, what happens?
   - Currently: `crearPago()` with `metodo_pago='cheque'` creates a pago + movimientos_caja
   - But where is the cheque record created?
   - Is there atomic coordination between pago + cheque creation?
   - If cheque creation fails, is pago rolled back?

2. **Rejection handling missing:**
   - If a cheque bounces (estado='rechazado'), who reverses the original CC reduction?
   - No code found for cheque bouncing → re-opening deuda

3. **Endosoment not modeled:**
   - Principle mentions "puede endosarse a proveedor"
   - No field for endosing in cheques table
   - No link to supplier_payment

4. **Temporal confusion:**
   - fecha_emision vs fecha_vencimiento vs fecha_deposito
   - Deposito date NOT in cheques table
   - How do we know when it actually hit the bank?

5. **eCheq not in schema:**
   - FormMovimiento.tsx has `urlEcheq` field
   - But no separate eCheq table
   - How is eCheq lifecycle tracked?

**RECOMMENDATION:**
- Distinguish financial instruments as separate concept:
  ```
  financial_instruments {
    id, type ('check', 'echeck'), status,
    
    # Issued by us or received from customer
    direction ('issued', 'received'),
    
    # Check-specific
    number, bank, issue_date, due_date,
    issued_by (supplier_id or us), amount,
    
    # Received check
    received_from (client_id), received_date,
    deposited_date, deposited_to_account_id (optional),
    
    # eCheq
    echeck_id (external), echeck_url, platform,
    
    # Endosement
    endorsed_to (supplier_id, if applicable),
    
    rejection details (rejection_date, reason, reimburse_date)
  }
  ```
- Create explicit state machine:
  ```
  ISSUED CHEQUE:
    created → sent_to_bank → processed → cleared
    alternative paths: → rejected → reversed
  
  RECEIVED CHEQUE:
    received → held_in_portfolio → deposited → cleared
    alternative paths: → rejected → reversed
  ```
- Transactions must be ATOMIC:
  ```
  receive_cheque_from_client(client_id, check_data):
    1. INSERT financial_instrument
    2. UPDATE client_ledger (type='check_received', amount=-check_amount)
    3. (transactional)
  
  deposit_cheque(check_id, account_id):
    1. UPDATE financial_instrument (deposited_date, deposited_to_account)
    2. INSERT financial_transaction (account, +amount, type='check_deposit')
    3. (transactional)
  
  bounce_cheque(check_id):
    1. UPDATE financial_instrument (status='rejected')
    2. UPDATE client_ledger (type='check_reversal', amount=+check_amount)
    3. (transactional)
  ```

**MIGRATION RISK:** CRITICAL  
- Current cheque usage is unclear
- Must audit actual workflows before modeling
- eCheq not even in schema yet

---

### Challenge 5: Population as Sum of Events

**PRINCIPLE:** "Población: initial_population + SUM(population_events.delta)"

**FACTS FOUND:**
- Table `lotes`: fecha_entrada, fecha_salida, aves_iniciales_postura
- Table `producciones`: mortandad field
- Table `recuentos_lote`: poblacion field
- No `population_events` table
- No immutable event log for population changes

**INFERENCE:**
- Current system stores initial population in lotes
- Death/mortality captured in daily producciones.mortandad
- Recuentos are checkpoints, not events

**PROBLEMS:**
1. **Mortality source unclear:**
   - Is `producciones.mortandad` observed daily or calculated?
   - Can it be negative (bird recovery)? Code doesn't prevent it.
   - Is there an audit trail who entered it and when?

2. **Recuentos as source of truth?**
   - `recuentos_lote` has a poblacion field
   - If recount says 450 birds but calculation (initial - sum(mortandad)) says 455, which wins?
   - No reconciliation logic

3. **No population snapshots:**
   - Cannot easily answer: "How many birds were in Galpon 1 on 2026-08-15?"
   - Must calculate: initial - sum(deaths) WHERE date <= 2026-08-15
   - If data is sparse, error-prone

4. **Flock retirement unclear:**
   - When lote.fecha_salida is set, what happens to poblacion?
   - Does it go to 0 or does it carry forward?

**RECOMMENDATION:**
- Create immutable `population_events` table:
  ```
  population_events {
    id, flock_id, event_type ('initial', 'death', 'adjustment', 'recount'),
    delta INT (negative for death), count_date, event_date,
    recorded_date, recorded_by,
    source ('daily_production', 'recount', 'manual_adjustment'),
    reason (nullable),
    created_at
  }
  ```
- Business logic:
  ```
  current_population(flock_id, as_of_date) =
    SELECT SUM(delta) FROM population_events
    WHERE flock_id = X AND count_date <= as_of_date
  
  daily_mortality_check(flock_id, date):
    IF this_day_events.sum(delta) < -5% of population:
      FLAG for manual review
  ```
- Recuentos become VALIDATION, not source:
  ```
  ON INSERT recount:
    calculated = current_population(flock_id, recount_date)
    IF ABS(calculated - recount.poblacion) > threshold:
      INSERT population_events (type='adjustment', delta=difference)
      ADD audit note about discrepancy
  ```
- Retire flock cleanly:
  ```
  retire_flock(flock_id, retirement_date):
    final_count = current_population(flock_id, retirement_date)
    IF final_count > 0:
      INSERT population_events (delta=-final_count, reason='flock_retirement')
    UPDATE flock (status='retired', retire_date=...)
  ```

**MIGRATION RISK:** MEDIUM  
- Must convert historical mortandad records into population_events
- Recuentos must be reinterpreted as validation checkpoints

---

### Challenge 6: Producción Diaria + Clasificación Separation

**PRINCIPLE:** "Clasificación NO debe tener lote_id. Los huevos de distintos lotes se mezclan antes de clasificarse."

**FACTS FOUND:**
- Table `producciones`: fecha, galpon, lote_id, huevos_totales, huevos_cachados, etc.
- No `classifications` table
- No `classification_sessions`
- No egg pooling/mixing logic

**INFERENCE:**
- Current system records production by lote
- Assumption: each lote's output goes to a separate bucket
- No merging/pooling before classification

**PROBLEMS:**
1. **Pooling not implemented:**
   - Principle says eggs are mixed before classifying
   - But what does "mixed" mean operationally?
   - Are all eggs from all active flocks pooled each morning?
   - Or can an operator choose which flocks to pool on a given day?

2. **Classification timing:**
   - If classification happens days AFTER production, which production date do eggs belong to?
   - If we classify eggs on 2026-09-30, are they from 2026-09-28?
   - Implication: revenue date ≠ production date ≠ classification date

3. **Quality mapping:**
   - Current producciones has: huevos_totales, huevos_cachados
   - Does "total" mean "counted"? Does it include broken/dirty?
   - Classifications should have: XL, N1, N2, N3, grade_B (second quality)
   - How does "cachados" map to grades?

4. **Traceability lost:**
   - If a customer complains about egg quality, can we trace which flock it came from?
   - With pooling, traceability is lost (by design?)

**RECOMMENDATION:**
- Create explicit `classifications` table WITHOUT lote_id:
  ```
  classifications {
    id, classification_date, classified_by, session_notes,
    total_eggs_classified,
    created_at
  }
  ```
- Create `classification_lines`:
  ```
  classification_lines {
    id, classification_id, grade ('XL', 'N1', 'N2', 'N3', 'B'),
    quantity, price_unit, notes,
    created_at
  }
  ```
- Create `classification_inputs` to track which production records fed into a classification:
  ```
  classification_inputs {
    id, classification_id, production_id,
    eggs_contribution_count,
    created_at
  }
  ```
- Workflow:
  ```
  classify_session(session_date, collected_production_ids):
    1. INSERT classifications
    2. FOR EACH grade:
         INSERT classification_lines (grade, quantity, ...)
    3. FOR EACH production_id:
         INSERT classification_inputs
    4. Link to a pedido aggregate (for costing)
  ```
- This allows:
  - Revenue to flow from classifications, not from production
  - Traceability backward (classification → production → flock)
  - Multiple sessions per day if needed
  - Eggs held in inventory between production and classification

**MIGRATION RISK:** MEDIUM  
- Current system doesn't track pooling; must infer from operational workflow
- Historical productions must be rebundled into classification sessions

---

### Challenge 7: Fiscal vs Economic vs Management Dates

**PRINCIPLE:** (Implicit) Need to distinguish multiple date concepts

**FACTS FOUND:**
- Tables have: fecha_pedido, fecha_operacion, fecha_pago, creado_en, actualizado_en
- Sometimes confusing which is which
- Producciones.fecha (production date)
- Cheques.fecha_emision, fecha_vencimiento, but NO fecha_deposito

**PROBLEMS:**
1. **Revenue recognition date undefined:**
   - Is it entregado_en (delivery), fecha_pago (receipt of cash), or some economic date?
   - Fiscal rules may require delivery date, cash date, or invoice date
   - Cannot answer without clarity

2. **Expense recognition date undefined:**
   - Is it fecha_operacion (when purchased), fecha_pago (when paid), or fecha_factura?
   - Accrual accounting requires one answer, cash requires another
   - Currently conflated

3. **Period closing ambiguous:**
   - If close period on 2026-09-30, do pending cheques affect it?
   - Do pending purchases with late invoices affect it?
   - No rule provided

**RECOMMENDATION:**
- Define date semantics explicitly:
  ```
  CREATED_AT:        When record entered in system (system audit)
  EFFECTIVE_DATE:    When economic fact occurred (e.g., order placed)
  ECONOMIC_DATE:     When impact recognized for P&L (may differ from effective)
  FISCAL_DATE:       For tax purposes (may differ from accounting)
  DOCUMENT_DATE:     Date on the invoice/receipt
  PAYMENT_DATE:      When cash/check was exchanged
  ```
- For pedidos (customer orders):
  ```
  created_at: today (when entered in system)
  effective_date: fecha_pedido (when customer ordered)
  economic_date: entregado_en (when economic obligation created)
  document_date: would be invoice_date (if we track invoices)
  ```
- For purchases:
  ```
  created_at: today
  effective_date: fecha_operacion
  document_date: invoice_date
  economic_date: document_date (for accrual)
  payment_date: when cheque sent
  ```
- Store all of these; query logic determines which to use

**MIGRATION RISK:** MEDIUM  
- Must backfill historical dates where missing
- Some inference required (e.g., if no invoice_date, use purchase_date)

---

## B. ENTITY CHALLENGES

### Revisiting Each Proposed Entity

#### Identity/Config

**profiles, products, product_prices, categories, projects**

| Entity | Current | Status | Issues |
|--------|---------|--------|--------|
| profiles | ✅ perfiles | KEEP | Add `primer_nombre`, `apellido` fields (already in code); add `category` field? |
| products | ✅ productos | ADAPT | Currently tiene `categoria` TEXT; must enforce enum. Add `type` field (sellable/input/both) |
| product_prices | ⚠️ precios_actuales + precios_historial | KEEP | OK but prices are global, not per-product-variant. Add `valid_from`, `valid_to` |
| categories | ⚠️ categories_finanzas | MERGE | Exists but ONLY for financial categorization. Need product categories too. No schema conflict, just need fields |
| projects | ❌ NOT FOUND | CREATE | Proposed but not in repo. Clarify if needed (maybe multi-granja future?) |

**RECOMMENDATION:**
- ADAPT products: add product_type enum ('input', 'sellable', 'both')
- KEEP product_prices but rename to `product_price_history`; add `active_from`, `active_to`
- MERGE categories: one table with `category_type` ('financial', 'product') or two separate tables?
- CREATE projects IF multi-granja is imminent; otherwise SKIP for now

---

#### Commercial

**clients, orders, order_lines, collections, client_ledger**

| Entity | Current | Status | Issues |
|--------|---------|--------|--------|
| clients | ✅ clientes | KEEP | Rename to clients; add phone, email, invoice_address, billing_address |
| orders | ✅ pedidos | ADAPT | See Challenge 1 (economic date, etc.) |
| order_lines | ✅ pedido_lineas | KEEP | OK; verify all products have producto_id |
| collections | ❌ NOT FOUND | CREATE | Currently no formal colecciones/cobros; uses pagos + movimientos_caja. Must design properly. |
| client_ledger | ❌ NOT FOUND | CREATE | See Challenge 2; audit trail for CC movements |

**RECOMMENDATION:**
- KEEP clientes, rename to clients in new schema
- ADAPT pedidos with economic_date field
- KEEP pedido_lineas
- CREATE collections (cobros) with proper state machine:
  ```
  collections {
    id, client_id, order_id (optional, nullable),
    amount, collection_method ('cash', 'cheque', 'echeck', 'bank_transfer'),
    collection_date, recorded_date, recorded_by,
    status ('pending', 'received', 'reversal_pending'),
    notes
  }
  ```
  This replaces current `pagos` + some of `movimientos_caja` logic
- CREATE client_ledger (see Challenge 2)

---

#### Fair/Sales Sessions

**sales_sessions, sales_session_dispatches, sales_session_returns, sales_session_losses**

| Entity | Current | Status | Issues |
|--------|---------|--------|--------|
| sales_sessions | ❌ NOT FOUND | CREATE | Not in current system; needed for feria/retail aggregation (Challenge 3) |
| sales_session_dispatches | ❌ NOT FOUND | CREATE | Sales transactions within session |
| sales_session_returns | ❌ NOT FOUND | CREATE | Product returns within session |
| sales_session_losses | ❌ NOT FOUND | CREATE | Broken eggs, waste within session |

**RECOMMENDATION:**
- CREATE all of these; vital for feria model
- See Challenge 3 for detailed spec

---

#### Purchasing

**suppliers, purchases, purchase_lines, supplier_payments, supplier_ledger, fiscal_documents, fiscal_document_taxes, purchase_cost_allocations**

| Entity | Current | Status | Issues |
|--------|---------|--------|--------|
| suppliers | ❌ NOT FOUND | CREATE | Not in current system |
| purchases | ❌ NOT FOUND | CREATE | Currently uses movimientos_caja + comisiones; no formal purchase model |
| purchase_lines | ❌ NOT FOUND | CREATE | Missing |
| supplier_payments | ❌ NOT FOUND | CREATE | Missing; currently pago_en_caja or implicit |
| supplier_ledger | ❌ NOT FOUND | CREATE | Like client_ledger but for suppliers |
| fiscal_documents | ⚠️ FormMovimiento has invoice upload | ADAPT | Upload mechanism exists; need formal table |
| fiscal_document_taxes | ⚠️ FormMovimiento calculates IVA | ADAPT | Stored in movimientos_caja as fields; need normalization |
| purchase_cost_allocations | ❌ NOT FOUND | CREATE | Needed to allocate freight to purchases |

**RECOMMENDATION:**
- CREATE suppliers table
- CREATE purchases + purchase_lines (replacing ad-hoc movimientos_caja usage)
- CREATE supplier_payments (explicit payment tracking)
- CREATE supplier_ledger (audit trail like client_ledger)
- ADAPT fiscal_documents: create formal table to replace file uploads
- ADAPT fiscal_document_taxes: normalize from movimientos_caja fields
- CREATE purchase_cost_allocations (for freight → purchase_cost)

---

#### Treasury

**financial_accounts, financial_transactions, transfers, financial_instruments, cash_counts**

| Entity | Current | Status | Issues |
|--------|---------|--------|--------|
| financial_accounts | ❌ NOT FOUND | CREATE | Caja chica, MP, CC BNA, CC Patagonia implied but not formalized |
| financial_transactions | ⚠️ movimientos_caja + mp_financial_movement | MERGE | Two separate ledgers; must merge into one |
| transfers | ❌ IMPLICIT | CREATE | Transfers between accounts modeled as two separate movimientos; need explicit concept |
| financial_instruments | ⚠️ cheques | ADAPT | See Challenge 4; eCheq missing |
| cash_counts | ⚠️ Arqueos | KEEP | Table exists; rename to cash_counts |

**RECOMMENDATION - CRITICAL:**
- CREATE financial_accounts with saldo derived only from ledger
- REDESIGN ledger (see Section D below for deep analysis)
- CREATE transfers concept (atomic A→B) instead of two separate movements
- ADAPT financial_instruments (see Challenge 4)
- KEEP cash_counts (rename to financial_account_counts)

---

#### Production

**sheds, flocks, daily_production, population_events, flock_weighings, flock_weighing_samples, temperature_records, classifications, classification_lines**

| Entity | Current | Status | Issues |
|--------|---------|--------|--------|
| sheds | ⚠️ IMPLICIT | CREATE | galpones stored as TEXT in producciones; need formal table |
| flocks | ✅ lotes | KEEP | Rename to flocks; clarify shed ↔ flock cardinality (1:1?) |
| daily_production | ✅ producciones | ADAPT | See Challenge 5 & 6; add classification_session reference |
| population_events | ❌ NOT FOUND | CREATE | See Challenge 5; replace implicit mortality |
| flock_weighings | ❌ NOT FOUND | CREATE | Not tracked currently |
| flock_weighing_samples | ❌ NOT FOUND | CREATE | Not tracked currently |
| temperature_records | ❌ NOT FOUND | CREATE | Not tracked currently |
| classifications | ❌ NOT FOUND | CREATE | See Challenge 6 |
| classification_lines | ❌ NOT FOUND | CREATE | See Challenge 6 |

**RECOMMENDATION:**
- CREATE sheds with galpón_id, name, capacity
- KEEP lotes, rename to flocks; add shed_id FK (not nullable if 1:1)
- ADAPT producciones (add classification_session_id reference)
- CREATE population_events (see Challenge 5)
- DEFER flock_weighings, temperature_records (can add later if operational need)
- CREATE classifications + classification_lines (see Challenge 6)

---

#### Feed

**feed_types, feed_formulations, feed_formula_ingredients, feed_manufacturing, feed_inventory_counts, flock_feed_assignments**

| Entity | Current | Status | Issues |
|--------|---------|--------|--------|
| feed_types | ❌ NOT FOUND | CREATE | Alimento type: maize, soja expeller, balanced feed, etc. |
| feed_formulations | ❌ NOT FOUND | CREATE | Version history of recipes |
| feed_formula_ingredients | ❌ NOT FOUND | CREATE | What goes into each recipe |
| feed_manufacturing | ❌ NOT FOUND | CREATE | Production run of balanced feed |
| feed_inventory_counts | ❌ NOT FOUND | CREATE | Physical counts (not ledger) |
| flock_feed_assignments | ❌ NOT FOUND | CREATE | Which feed is assigned to which flock |

**RECOMMENDATION:**
- CREATE all; no current tracking of feed beyond daily consumption entries in producciones
- High operational complexity (formulations, costing, wastage)
- Recommend DEFER detailed design until operations provide spec
- For now, accept that producciones.alimento is a simple consumption tracker

---

#### Fiscal

**tax_components, tax_obligations, tax_installments**

| Entity | Current | Status | Issues |
|--------|---------|--------|--------|
| tax_components | ⚠️ IMPLICIT | CREATE | IVA débito/crédito, retenciones tracked ad-hoc in FormMovimiento |
| tax_obligations | ❌ NOT FOUND | CREATE | AFIP obligations, periodic filings |
| tax_installments | ❌ NOT FOUND | CREATE | Quota tracking for payments |

**RECOMMENDATION:**
- CREATE tax_components (IVA rate, withholding type, etc.)
- CREATE tax_obligations (monthly, quarterly reporting)
- For now, tax_installments can be part of supplier_payments
- Note: tax modeling is COMPLEX and JURISDICTION-DEPENDENT
  - Current system partially tracks IVA in FormMovimiento
  - Recommend DEFER tax formalization until business rules clarified with accountant

---

#### Management/Audit

**management_periods, internal_reserves, audit_events**

| Entity | Current | Status | Issues |
|--------|---------|--------|--------|
| management_periods | ❌ NOT FOUND | CREATE | OPEN/CLOSED month tracking |
| internal_reserves | ❌ NOT FOUND | CREATE | Internal allocation of profits |
| audit_events | ❌ NOT FOUND | CREATE | Immutable log of significant actions |

**RECOMMENDATION:**
- CREATE management_periods for monthly close/reopen (see Challenge 9)
- CREATE internal_reserves for capital allocation
- CREATE audit_events for compliance; for now, trust Supabase RLS audit_log

---

#### Integrations

**MP legacy: mp_source_record, mp_financial_movement, mp_movement_source_link, ledger_entry, account_balance, reconciliation structures**

See **Section D** for deep analysis of ledger architecture.

**RECOMMENDATION:** Do NOT auto-merge MP ledger into global ledger. Design intentionally.

---

## C. CURRENT → TARGET MAPPING MATRIX

| TARGET ENTITY | CURRENT TABLE/CODE | ACTION | RATIONALE | MIGRATION RISK |
|---|---|---|---|---|
| **profiles** | perfiles | ADAPT | Add `primer_nombre`, `apellido` fields; add auth_role field | LOW |
| **products** | productos | ADAPT | Add `product_type` enum; clarify units | MEDIUM |
| **product_prices** | precios_actuales + precios_historial | KEEP | Rename to product_price_history; add `active_from`, `active_to` | LOW |
| **categories (financial)** | categorias_finanzas | KEEP | OK as-is | NONE |
| **categories (product)** | N/A (implicit in productos.categoria) | CREATE | Formal enum or reference table | LOW |
| **clients** | clientes | KEEP | Rename; add contact fields | LOW |
| **orders** | pedidos | ADAPT | Add economic_date, invoice_id fields; clarify state machine | MEDIUM |
| **order_lines** | pedido_lineas | KEEP | OK; ensure FK integrity | LOW |
| **collections** | pagos + partial movimientos_caja | MERGE | Create formal collections table; redesign workflow | HIGH |
| **client_ledger** | N/A (ad-hoc queries) | CREATE | Audit trail for CC movements | MEDIUM |
| **sales_sessions** | N/A | CREATE | Feria/retail aggregation (Challenge 3) | HIGH |
| **sales_session_items** | N/A | CREATE | Line items within session | HIGH |
| **suppliers** | N/A | CREATE | Not in current system | HIGH |
| **purchases** | N/A (implicit in movimientos_caja) | CREATE | Formalize purchasing | HIGH |
| **purchase_lines** | N/A | CREATE | Line items in purchases | HIGH |
| **supplier_payments** | pagos_proveedor? (not found) | CREATE | Track supplier payment lifecycle | HIGH |
| **supplier_ledger** | N/A (ad-hoc queries) | CREATE | Like client_ledger | MEDIUM |
| **financial_accounts** | N/A (hardcoded references) | CREATE | Formalize account structure | HIGH |
| **financial_transactions** | movimientos_caja + mp_financial_movement | MERGE | See Section D | CRITICAL |
| **transfers** | N/A (two separate movimientos_caja) | CREATE | Atomic A→B representation | MEDIUM |
| **financial_instruments** | cheques + partial movimientos_caja | ADAPT | Add eCheq tracking; redesign lifecycle (Challenge 4) | HIGH |
| **cash_counts** | arqueos | KEEP | Rename; ensure FK to financial_accounts | LOW |
| **sheds** | N/A (galpón as TEXT) | CREATE | Formalize shed management | LOW |
| **flocks** | lotes | KEEP | Rename; add shed_id FK | MEDIUM |
| **daily_production** | producciones | ADAPT | Add classification_session_id; refine mortality handling | MEDIUM |
| **population_events** | N/A (implicit in producciones.mortandad) | CREATE | Immutable event log (Challenge 5) | MEDIUM |
| **flock_weighings** | N/A | CREATE | Not tracked currently; DEFER | HIGH |
| **classifications** | N/A | CREATE | Essential for egg grading (Challenge 6) | HIGH |
| **classification_lines** | N/A | CREATE | Grades and quantities | HIGH |
| **feed_types** | N/A | CREATE | Feed ingredient catalog; DEFER detailed design | MEDIUM |
| **feed_formulations** | N/A | CREATE | Recipe versioning; DEFER | MEDIUM |
| **feed_manufacturing** | N/A | CREATE | Production batches; DEFER | MEDIUM |
| **feed_inventory_counts** | N/A | CREATE | Physical counts; DEFER | MEDIUM |
| **tax_components** | N/A (ad-hoc in FormMovimiento) | CREATE | IVA, withholding types; needs accountant input | HIGH |
| **tax_obligations** | N/A | CREATE | AFIP reporting; DEFER pending rules | HIGH |
| **management_periods** | N/A | CREATE | Monthly OPEN/CLOSED (Challenge 9) | MEDIUM |
| **internal_reserves** | N/A | CREATE | Profit allocation; DEFER | LOW |
| **audit_events** | N/A (rely on Supabase audit) | CREATE | Immutable log for compliance; use DB triggers | MEDIUM |

---

## D. DEEP LEDGER ARCHITECTURE ANALYSIS

**This is the MOST CRITICAL section.** Current system has two separate ledgers; target must merge them correctly.

### Current State

**LEDGER 1: movimientos_caja**

```sql
movimientos_caja {
  id BIGINT PK,
  tipo ('ingreso', 'egreso'),
  concepto TEXT,
  monto NUMERIC,
  forma_pago ('efectivo', 'mercadopago', 'echeq', 'cheque'),
  fecha_operacion DATE,
  fecha_pago DATE,
  estado ('pendiente', 'confirmado', 'cancelado'),
  cuenta_origen TEXT,
  cuenta_destino TEXT,
  vinculado_a ('pedido', 'pago', 'ninguno'),
  vinculado_id TEXT (converted to TEXT to hold both BIGINT and UUID),
  categoria_analisis ('GASTOS_OPERATIVOS', 'REINVERSION_OPERATIVA', 'INVERSION'),
  categoria TEXT,
  subcategoria TEXT,
  es_facturada BOOLEAN,
  aliquota_iva NUMERIC,
  monto_iva NUMERIC,
  es_cheque BOOLEAN,
  url_factura TEXT,
  -- timestamps
  created_by UUID,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
}
```

**Issues with movimientos_caja:**
1. Conflates operational + financial:
   - "Ingreso" includes: customer payment, internal transfer, refund, interest
   - Cannot distinguish without parsing concepto TEXT
2. Two-step representation:
   - Customer payment creates BOTH pago record AND movimientos_caja record
   - Redundant; inconsistency risk
3. No audit trail of corrections:
   - If monto is wrong, update overwrites history
4. Weak FK integrity:
   - vinculado_id is TEXT, no FK constraint to multiple possible tables
5. Categorical mess:
   - categoria_analisis, categoria, subcategoria mixed
   - IVA stored as both aliquota_iva and monto_iva (redundant/error-prone)
6. Cheque confusion:
   - es_cheque flag + forma_pago='cheque' is redundant
   - No link to cheques table

**LEDGER 2: mp_financial_movement + ledger_entry**

```sql
mp_source_record {
  id BIGINT PK,
  source_type ('report', 'api', 'webhook'),
  source_external_id VARCHAR,
  payload_hash VARCHAR (SHA256),
  raw_data JSONB,
  observed_at TIMESTAMP,
  processing_status ('pending', 'processed', 'error'),
}

mp_financial_movement {
  id BIGINT PK,
  account_id BIGINT,
  movement_class ('payment_in', 'payment_out', 'yield', 'transfer_in', 'transfer_out', 'unclassified'),
  transaction_amount DECIMAL,
  settlement_amount DECIMAL,
  tax_amount DECIMAL,
  tax_detail JSONB,
  payment_method VARCHAR,
  transaction_date TIMESTAMP,
  settlement_date TIMESTAMP,
  normalized_at TIMESTAMP,
  order_id VARCHAR,
  external_reference VARCHAR,
}

mp_movement_source_link {
  id BIGINT PK,
  movement_id BIGINT FK mp_financial_movement,
  source_record_id BIGINT FK mp_source_record,
  (many-to-one: multiple sources can resolve to one movement)
}

ledger_entry {
  id BIGINT PK,
  financial_movement_id BIGINT FK mp_financial_movement,
  account_id BIGINT,
  balance_impact DECIMAL (signed),
  occurred_at TIMESTAMP,
  imputation_date DATE,
  description TEXT,
  reference_type VARCHAR,
  reference_id VARCHAR,
}

account_balance {
  id BIGINT PK,
  account_id BIGINT,
  balance_date DATE,
  opening_balance DECIMAL,
  ledger_sum DECIMAL,
  closing_balance DECIMAL,
  last_update TIMESTAMP,
}
```

**Issues with mp_financial_movement + ledger_entry:**
1. Separate universe:
   - Only for Mercado Pago
   - Customer payments via check/transfer go to movimientos_caja instead
   - Two sources of financial truth
2. Reconciliation complexity:
   - mp_source_link_resolution exists but appears to be exception handling
   - Many:Many linking suggests deduplication was hard
3. No single account balance:
   - Both movimientos_caja + account_balance claim to track cash
   - Which is correct?
4. No cheque tracking in MP ledger:
   - If customer pays via check, it's in movimientos_caja
   - But MP might also have a transfer when check is deposited
   - How to reconcile?

---

### Three Architecture Options

#### OPTION A: Evolve ledger_entry into Global Ledger

**Premise:** MP team did the hard work (source dedup, classification). Extend it.

**Proposal:**

```sql
financial_transactions {
  id BIGSERIAL PK,
  account_id BIGINT FK financial_accounts,
  transaction_type ('payment_received', 'payment_sent', 'transfer_out', 'transfer_in', 
                    'interest_received', 'fee', 'cheque_deposited', 'correction'),
  description TEXT,
  amount SIGNED NUMERIC,
  balance_impact NUMERIC (derived? or stored?),
  
  # Transaction semantics
  effective_date DATE (when it economically occurred),
  recorded_date TIMESTAMP (when entered in system),
  reference_type VARCHAR ('order', 'purchase', 'collection', 'supplier_payment', 'cheque', 'transfer', 'mp_movement'),
  reference_id VARCHAR (UUID or BIGINT as string),
  
  # For MP transactions
  mp_movement_id BIGINT FK mp_financial_movement (nullable),
  mp_source_records BIGINT[] (array of source IDs for audit),
  
  # For cheques
  financial_instrument_id BIGINT FK financial_instruments (nullable),
  
  # Corrections / audit
  status ('posted', 'pending', 'reversed'),
  reversal_of_transaction_id BIGINT FK financial_transactions (nullable),
  reversal_date DATE (nullable),
  reversal_reason TEXT,
  
  created_at TIMESTAMP,
  created_by UUID,
  updated_at TIMESTAMP,
}
```

**Advantages:**
- Single authoritative ledger
- MP classification logic reused
- Clear audit trail (status + reversals)

**Disadvantages:**
- Requires significant ETL: convert all movimientos_caja → financial_transactions
- MP architecture was designed for dedup/reconciliation of external data
  - Extending it to internal transactions may introduce new complexity
- Questions:
  - Is balance_impact calculated or stored? (if calculated, any error breaks balance)
  - How to handle pending transactions? (e.g., cheque not yet cleared)
  - How to query "cash available today" vs "cash on books"?

**Migration Effort:** VERY HIGH  
- Must transform ~1000s of movimientos_caja records
- Must validate balance = SUM(financial_transactions WHERE account_id = X)
- Risk of off-by-penny errors

---

#### OPTION B: Create New Global Ledger, Bridge MP

**Premise:** MP ledger is specialized for external reconciliation. Create a simpler, cleaner global ledger. Bridge MP into it.

**Proposal:**

```sql
general_ledger {
  id BIGSERIAL PK,
  account_id BIGINT FK financial_accounts,
  
  # Core attributes
  debit_amount NUMERIC (only credit side used, or only debit side)
  credit_amount NUMERIC
  net_amount NUMERIC (signed, for easier querying),
  
  ledger_date DATE,
  description TEXT,
  
  # Operational/semantic
  operation_type ('payment_received_customer', 'payment_sent_supplier', 'transfer_between_accounts',
                  'fee', 'interest', 'cheque_received', 'cheque_bounced', 'mp_reconciliation',
                  'correction', 'period_close_adjustment'),
  
  # References
  order_id BIGINT FK orders (nullable),
  collection_id BIGINT FK collections (nullable),
  purchase_id BIGINT FK purchases (nullable),
  supplier_payment_id BIGINT FK supplier_payments (nullable),
  transfer_id BIGINT FK transfers (nullable),
  cheque_id BIGINT FK financial_instruments (nullable),
  mp_reconciliation_batch_id BIGINT FK mp_reconciliation_batches (nullable),
  
  # Audit
  posted_at TIMESTAMP,
  posted_by UUID,
  period_id BIGINT FK management_periods,
  
  # Reversals
  status ('posted', 'reversed'),
  reversed_by_entry_id BIGINT FK general_ledger (nullable),
  reversal_reason TEXT,
}

mp_reconciliation_batches {
  id BIGSERIAL PK,
  account_id BIGINT FK financial_accounts,
  batch_date DATE,
  
  # Mapping MP → GL
  mp_movements_count INT,
  gl_entries_created INT,
  mapping_logic ('direct_1to1', 'aggregated_session', 'manual_assignment'),
  
  # Audit
  reconciled_by UUID,
  reconciled_at TIMESTAMP,
  notes TEXT,
}
```

**Advantages:**
- Debit/Credit model (simpler for accountants)
- Flexible references (no need to FK to 10 different tables; use operation_type + reference_id pattern)
- MP batches are explicit; easy to audit
- Simpler to query ("what accounts for this payment?")

**Disadvantages:**
- Debit/Credit adds UI complexity for non-accountants
- Still requires migration of movimientos_caja
- MP reconciliation requires explicit batch-creation logic

**Migration Effort:** HIGH  
- Transform movimientos_caja to GL (simpler than Option A)
- Create MP reconciliation logic

---

#### OPTION C: Hybrid — Two Ledgers, Clear Isolation

**Premise:** Keep mp ledger as external data hub. Keep a separate operational ledger for internal transactions. Reconcile at will.

**Proposal:**

```sql
operational_ledger {
  id BIGSERIAL PK,
  account_id BIGINT FK financial_accounts,
  
  amount NUMERIC (signed),
  operation_type ('customer_payment', 'supplier_payment', 'internal_transfer', 'cheque_deposit', 'fee', 'correction'),
  operation_date DATE,
  recorded_at TIMESTAMP,
  
  # References (keep it flat, no FKs)
  reference_code VARCHAR (e.g., "ORD-12345", "SUPP-67", "CHK-001"),
  reference_description TEXT,
  
  status ('pending', 'posted', 'reversed'),
  reversed_by_entry_id BIGINT (nullable),
  
  created_by UUID,
  account_id BIGINT,
}

# MP ledger: keep separate, reference it via:

mp_to_operational_reconciliation {
  id BIGINT PK,
  mp_movement_id BIGINT FK mp_financial_movement,
  operational_ledger_id BIGINT FK operational_ledger,
  reconciled_date DATE,
  reconciled_by UUID,
  notes TEXT,
}
```

**Advantages:**
- Minimal disruption: can run both in parallel
- MP stays as external data hub
- Operational ledger is simple and operator-friendly
- Easy to audit differences

**Disadvantages:**
- Two sources of truth during transition (error-prone)
- Reconciliation is a MANUAL process, not automated
- Queries must check both ledgers

**Migration Effort:** MEDIUM  
- Can keep movimientos_caja largely as-is, rename to operational_ledger
- MP remains untouched
- Build reconciliation UI

---

### RECOMMENDATION: OPTION B (New Global Ledger, Bridge MP)

**Reasoning:**
1. **Clarity:** Debit/credit model is standard for financial systems
2. **Extensibility:** References by operation_type, not FKs, allows new operation types without schema changes
3. **Auditability:** Explicit reconciliation batches make MP integration traceable
4. **Migration:** Feasible without rewriting MP architecture

**Caveats:**
- Requires UI training for non-accountants (debit/credit)
- Reconciliation is not fully automatic; requires explicit batching
- Still requires ~1000s of records to migrate/validate

**Detailed Schema** (for design phase):

```sql
financial_accounts {
  id BIGSERIAL PK,
  name VARCHAR ('Caja Chica', 'Mercado Pago', 'CC BNA', 'CC Patagonia'),
  account_type ('cash', 'bank', 'mp_account'),
  currency VARCHAR ('ARS'),
  status ('active', 'inactive'),
  created_at TIMESTAMP,
}

general_ledger {
  id BIGSERIAL PK,
  account_id BIGINT FK financial_accounts,
  ledger_date DATE,
  
  # Ledger accounts (single side per entry)
  debit_amount NUMERIC DEFAULT 0,
  credit_amount NUMERIC DEFAULT 0,
  
  description TEXT,
  operation_type VARCHAR,
  
  reference_id VARCHAR,
  
  posted_at TIMESTAMP,
  posted_by UUID,
  
  period_id BIGINT FK management_periods,
  reconciliation_batch_id BIGINT FK mp_reconciliation_batches (nullable),
  
  status VARCHAR ('posted', 'reversed'),
  reversed_by_entry_id BIGINT FK general_ledger (nullable),
  reversal_reason TEXT,
  
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  
  CONSTRAINT debit_xor_credit CHECK ((debit_amount > 0 AND credit_amount = 0) OR (debit_amount = 0 AND credit_amount > 0))
}

mp_reconciliation_batches {
  id BIGSERIAL PK,
  account_id BIGINT FK financial_accounts,
  reconciliation_date DATE,
  
  mp_movements_included BIGINT[],
  gl_entries_created INT,
  total_amount NUMERIC,
  
  reconciled_by UUID,
  reconciled_at TIMESTAMP,
  notes TEXT,
  
  status VARCHAR ('draft', 'posted', 'reversed'),
}
```

---

## E. TRANSACTION BOUNDARIES

### Operations Requiring ACID Guarantees

| Operation | Records Read | Records Created/Updated | Race Conditions | Constraint/Lock | Retry Idempotency |
|---|---|---|---|---|---|
| **Deliver Order** | pedidos(1), pedido_lineas(N) | pedidos(1), client_ledger(1) | Customer queries balance while delivery is partial | `pedidos.estado` must go from pending→delivered atomically | Idempotent: check if already delivered before re-applying |
| **Receive Collection** | clients(1), pagos(0-1) | collections(1), client_ledger(1), financial_transaction(1) | Partial CC update; customer sees old balance | Multiple constraints: CC movement + financial + instrument updates | Idempotent: check collection_id exists before re-creating |
| **Deposit Cheque** | financial_instruments(1), financial_accounts(1) | general_ledger(1), financial_instruments(1) | Cheque deposited twice; balance counted twice | FK constraints + temporal sequence | Idempotent: check if already deposited (timestamp field) |
| **Bounce Cheque** | financial_instruments(1), collections(1) | client_ledger(1), general_ledger(1), financial_instruments(1) | CC reopens while payment still pending elsewhere | Must atomically reverse related entries | Idempotent: check if already reversed |
| **Complete Purchase** | purchases(1), purchase_lines(N), suppliers(1) | purchases(1), supplier_ledger(1), general_ledger(1) | Supplier CC updated mid-transaction | Multiple ledger entries must be consistent | Idempotent: check if already posted |
| **Pay Supplier** | suppliers(1), supplier_payments(0-1), financial_instruments(0-1) | supplier_payments(1), supplier_ledger(1), general_ledger(1), financial_instruments(0-1) | Partial update of ledger; instrument not created | If cheque: FK to financial_instruments | Idempotent: check payment_id exists |
| **Transfer Between Accounts** | financial_accounts(2), general_ledger | general_ledger(2), financial_transactions(1) | A decreases, B doesn't increase; orphaned transfer | Must be atomic pair or link to transfers table | Idempotent: check if transfer_id already posted |
| **Close Feria Session** | sales_sessions(1), sales_session_items(N), classifications(1), pedidos(1) | pedidos(1), general_ledger(1), sales_sessions(1) | Partial order creation; session count mismatch | Multiple FKs must align | Idempotent: check if session already closed |
| **Reopen Period** | management_periods(1) | general_ledger(0), audit_events(1) | Concurrent edits in period being reopened | Lock period during reopen; disallow new edits | Idempotent: check if already reopened |
| **MP Reconciliation Batch** | mp_financial_movement(N), general_ledger | general_ledger(N), mp_reconciliation_batches(1) | Partial reconciliation; missing GL entries | All movements must be classified before GL creation | Idempotent: check if batch_id already posted |
| **Classify Eggs** | producciones(N), classifications(1), classification_lines(M) | classifications(1), classification_lines(M), classification_inputs(N) | Production allocated to multiple classifications | Must lock productions during classification | Idempotent: check if classification_id already exists |

**CRITICAL FINDINGS:**

1. **Current system lacks transaction boundaries:**
   - `crearPago()` does INSERT pago + INSERT movimientos_caja
   - If second fails, first is orphaned
   - No rollback
   - No idempotency key

2. **Multi-step operations without locks:**
   - Cheque deposit should be atomic with GL posting
   - Currently separate, race condition possible

3. **Cross-table consistency:**
   - If cheque bounces, must reopen client CC AND reverse GL AND update cheque status
   - If any step fails, system is inconsistent

**RECOMMENDATIONS:**

```sql
-- Example: Atomic delivery + ledger posting

BEGIN TRANSACTION;

UPDATE pedidos 
SET estado = 'delivered', entregado_en = now(), entregado_por = ? 
WHERE id = ? AND estado = 'pending';

-- Check if update succeeded (1 row affected)
IF NOT FOUND THEN RAISE EXCEPTION 'pedido not found or already delivered'; END IF;

-- Get pedido details
SELECT monto_total INTO p_monto FROM pedidos WHERE id = ?;

-- Create ledger entry
INSERT INTO client_ledger (client_id, movement_type, reference_id, amount, movement_date)
VALUES (?, 'pedido_delivered', ?, p_monto, now());

-- Save point and verify
COMMIT;
-- If this session is client, return success

-- If anything failed, entire transaction rolls back
```

**For distributed systems (multiple app servers):**
- Use PostgreSQL advisory locks or idempotency keys
- Idempotency key example: `UNIQUE(operation_type, reference_id, operation_date)`

---

## F. TEMPORAL MODEL CHALLENGES

### Date Attribute Proliferation

**PROBLEM:** Target principles use multiple date concepts; current schema conflates them.

**FACTS FOUND:**

Current system stores:
- `created_at` (system audit)
- `updated_at` (system audit, overwritten)
- `fecha_operacion` (operation date, possibly not business date)
- `fecha_pago` (payment date, possibly not receipt date)
- `entregado_en` (delivery proof timestamp)
- For cheques: `fecha_emision`, `fecha_vencimiento`
- No: invoice_date, document_date, economic_date, fiscal_date, service_period_start/end

**INFERENCES:**

1. **Revenue Recognition Date Undefined:**
   - P&L should recognize revenue on delivery (economic event), not payment
   - But which timestamp? `entregado_en` is used, but not explicitly called "economic_date"
   - If customer disputes after delivery, revenue already recognized; credit note needed

2. **Expense Recognition Date Undefined:**
   - When does an invoice accrue expense? Purchase date or invoice date?
   - MP shows movement_date but doesn't distinguish when cash was received

3. **Period Closing Ambiguous:**
   - If close period on 2026-09-30, do invoices received 10/2 with 9/30 document date count?
   - Current system offers no date hierarchy

**PROBLEMS WITH TARGET MODEL:**

The target doesn't explicitly address temporal conflicts:

- If `created_at` ≠ `effective_date` ≠ `economic_date`, which is authoritative for:
  - Revenue recognition?
  - Period close cutoff?
  - Tax reporting date?
  - Cash flow analysis?

**SCENARIOS:**

1. **Order placed 2026-09-25, delivered 2026-09-28, invoice 2026-10-02, payment 2026-10-15**
   - Revenue recognition: 09-28 (delivery)?
   - But invoice date is 10-02 (fiscal reality)
   - Must system support 3 different dates?

2. **Purchase invoice 2026-09-29, received 2026-10-05, paid 2026-10-20**
   - Accrual: 09-29 (invoice date)
   - Expense recognition: 09-29 or 10-05?
   - Cash outflow: 10-20
   - Three separate concerns; target conflates them

3. **Cheque dated 2026-09-30, deposited 2026-10-05, cleared 2026-10-10**
   - CC impact: 09-30 (receipt date)
   - Bank impact: 10-10 (clear date)
   - Which period does it belong to?

**RECOMMENDATION:**

Define explicit date semantics:

```sql
-- Generic pattern for all economic entities

created_at TIMESTAMP        -- System audit: when entered
created_by UUID             -- System audit: who entered

document_date DATE          -- Date on the document (invoice, receipt)
effective_date DATE         -- When the economic fact occurred (order placed, service delivered)
economic_date DATE          -- When impact recognized for P&L (may differ from effective)
fiscal_date DATE            -- Tax jurisdiction date (may differ from economic)
service_period_start DATE   -- For subscription/recurring items
service_period_end DATE     -- For subscription/recurring items

-- Examples:

-- Pedido (customer order):
created_at: now() (system audit)
document_date: order_date (what customer sees)
effective_date: order_date (when committed)
economic_date: entregado_en (when obligation created → revenue recognizes)
fiscal_date: invoice_date (invoice sent to customer)
service_period_start: NULL (not applicable)
service_period_end: NULL (not applicable)

-- Purchase (supplier invoice):
created_at: now()
document_date: invoice_date (on the invoice)
effective_date: invoice_date (when obligation created)
economic_date: invoice_date (accrual: expense recognizes)
fiscal_date: invoice_date (tax event)
service_period_start: may be different (services rendered over time)
service_period_end: may be different

-- Cheque (received):
created_at: now()
document_date: cheque_date (on the cheque)
effective_date: cheque_received_date (when obligation reduced)
economic_date: cheque_received_date (CC impact)
fiscal_date: cheque_received_date (tax event, usually)
service_period_start: NULL
service_period_end: NULL
-- ADDITIONAL:
bank_impact_date: cheque_cleared_date (when bank actually moved money)
```

**Migration Risk:** MEDIUM  
- Historical data may lack some dates; must infer where possible
- Tax rules may require different date; must coordinate with accountant

---

## G. HISTORICAL IMMUTABILITY & SNAPSHOTS

### The Problem: "What Did X Look Like Then?"

**SCENARIO 1: Product Rename**

Today a product is "N1 - Grande".  
In 2024 it was called "N1 Jumbo".  
A 2024 order displays "N1 Jumbo" today but query asks for product name?  
→ Should order.product_name snapshot be stored at time of order?

**FACTS FOUND:**

Current schema:
- `pedido_lineas` has `producto_nombre` TEXT (snapshot)
- `productos.nombre` is editable (live)
- If product is renamed, historical orders don't update

**INFERENCE:**

System DOES snapshot product name. Good.  
But what about price? `pedido_lineas.precio_unitario` is numeric (snapshot).  
If product price changes, historical orders show different prices. OK.

**But:** What about product CATEGORY?  
If a product changes category (e.g., "Eggs" → "Byproduct"), historical orders show wrong category.

**PROBLEMS:**

1. **Product snapshots incomplete:**
   - Name ✓, price ✓, but not category, unit, type
   - If we later analyze "sales by category", historical data is wrong

2. **Supplier changes:**
   - If supplier name changes, does purchase record show old or new name?
   - No snapshot field found

3. **Tax rates:**
   - If IVA rate changes (21% → 25%), historical invoices must preserve the rate applied
   - MovimientoCaja stores alicuota_iva (good)
   - But if invoice is corrected later, which rate applies to the credit?

4. **Cost allocation:**
   - If freight cost is allocated to a purchase weeks after the fact, must recalculate?
   - Or freeze the cost as originally booked?

**RECOMMENDATIONS:**

```sql
-- For product snapshots (already done):
pedido_lineas {
  ...,
  product_name_snapshot TEXT,
  product_category_snapshot TEXT,
  product_unit_snapshot TEXT,
  price_unit_snapshot NUMERIC,
}

-- For supplier snapshots (missing):
purchases {
  ...,
  supplier_name_snapshot TEXT,
  supplier_tax_id_snapshot VARCHAR,
  supplier_fiscal_status_snapshot VARCHAR,
}

-- For tax snapshots:
purchase_tax_lines {
  id, purchase_id,
  tax_type ('iva_21', 'iva_10.5', 'withholding', 'perception'),
  rate_applied NUMERIC (21.00, not 21),  -- Preserve exact rate
  base_amount NUMERIC,
  tax_amount NUMERIC,
  recorded_date TIMESTAMP,
}

-- For cost allocations (immutable after close):
purchase_cost_allocations {
  id, allocation_date, source_purchase_id, target_purchase_id,
  allocated_amount NUMERIC,
  reason TEXT,
  period_id BIGINT FK management_periods,
  -- Once period is closed, allocations cannot be modified
}
```

**Immutability Rules:**

```
-- After period close, cannot:
1. Edit pedido after delivery
2. Edit purchase after posting
3. Edit GL entry after posting
4. Modify cost allocation
5. Modify tax rate on invoice

-- CAN do (create reversals):
1. Reverse with credit note
2. Post offsetting GL entry
3. Mark instrument as reversed
```

**Migration Risk:** MEDIUM  
- Must decide: do historical records get new snapshot fields (backfill) or leave blank?
- May need to infer historical values where missing

---

## H. CORRECTIONS, REVERSALS, CANCELLATIONS

### Defining the Taxonomy

**Current System:**
- Pedidos can be cancelled (estado='cancelado')
- But no credit note or reversal trail
- Pagos can be marked estado='cancelado'
- But unclear if this reverses CC or just the payment record

**TARGET PRINCIPLES:**

1. **Draft** — Editable in place (unpublished orders)
2. **Posted** — Immutable; reversals only via credit
3. **Reversal** — Explicit compensating entry
4. **Cancellation** — Retroactive invalidation (rare, requires permission)
5. **Correction** — Late amendment (allowed within grace period)

**SCENARIOS & RULES:**

| Scenario | Allowed State Before | Action | Outcome | Audit Trail |
|---|---|---|---|---|
| User types order wrong, saves draft | DRAFT | Edit in place | New order state | updated_at changes |
| Deliver order, customer unhappy | POSTED | Create credit note (negative order) | Original remains, reversal created | Separate order record |
| Deposited cheque bounces | CLEARED (GL posted) | Mark cheque REJECTED; post GL reversal | GL reversal entry created | Cheque.status + GL.reversed_by_entry_id |
| Invoice with wrong tax | POSTED (GL closed) | Submit correction request to admin | Correction GL entry created, marked as type='correction' | GL.operation_type='correction' |
| Accidental duplicate order | POSTED | Cancel with admin approval | Original marked CANCELLED; explanation in audit | GL reversals created; audit_event logged |
| MP double-counted payment | RECONCILED (GL posted) | Detect in reconciliation; post reversal | GL reversal entry; mp_reconciliation_batch revised | mp_reconciliation_batches.status='revised' |

**RECOMMENDATIONS:**

Define immutability by entity state:

```sql
-- Orders
CASE estado:
  DRAFT: fully editable
  PENDING (accepted, not delivered): editable lines, not estado/monto_total
  DELIVERED: read-only; credit notes only
  CANCELLED: read-only; no further action
  
-- Purchases
CASE estado:
  DRAFT: fully editable
  POSTED: read-only; reversals only
  CANCELLED: read-only

-- GL Entries
CASE status:
  POSTED: read-only; reversals only
  REVERSED: read-only

-- Cheques
CASE status:
  CREATED: editable (number, date)
  SENT/DEPOSITED: read-only; rejection only
  REJECTED: read-only; reversal GL created
  CLEARED: read-only

-- Management Periods
CASE status:
  OPEN: editable entities
  CLOSED: no new transactions; corrections only
  REOPENED: editable (admin only)
```

**Migration Risk:** MEDIUM  
- Must determine immutability rules per entity
- Historical records may have ambiguous state (partially updated)
- Some operations currently allowed may need to become restricted

---

## I. PERIOD CLOSING DEEP DIVE

### What OPEN/CLOSED Actually Means

**FACT:** Target principles mention management_periods with OPEN/CLOSED status.

**INFERENCE:** System should allow users to "close" a month, locking certain operations.

**PROBLEMS & EDGE CASES:**

1. **What exactly is locked?**
   - All GL entries? Production records? Just economic transactions?
   - Can operator still enter TOMORROW'S production even if September is closed?

2. **Late data arrival:**
   - Invoice dated 2026-09-30 arrives 2026-10-10 (period already closed)
   - Does it go into October or allow September reopening?
   - What if supplier sends it October but dated September (common)?

3. **MP reconciliation lag:**
   - MP report might include settlements from 2026-09-30
   - But Mercado Pago doesn't send report until 2026-10-02
   - Does September close BEFORE or AFTER MP reconciliation?

4. **Production is different:**
   - Actual eggs produced on 2026-09-30 are recorded on 2026-09-30 (same day)
   - But classification happens 2026-10-01 (next day)
   - When close September, is classification already done?

5. **Fiscal requirements:**
   - Tax authority may require invoices within specific periods
   - Cannot re-invoice September in November

**CURRENT SYSTEM:**
- No period concept
- Everything flows sequentially
- No locking, no protection against edits

**TARGET MODEL:**

Proposed: management_periods with OPEN/CLOSED

**ISSUES WITH SIMPLE BINARY:**

- Some entities should be locked (GL entries, Orders)
- Some entities should be unlocked (Production entering for past dates; late invoices)
- Some entities need soft-close (can reopen but with audit)

**RECOMMENDATION:**

```sql
management_periods {
  id BIGSERIAL PK,
  period_start DATE,
  period_end DATE,
  status VARCHAR ('OPEN', 'CLOSED', 'REOPENED'),
  
  # What's locked in CLOSED state:
  lock_economic_transactions BOOLEAN DEFAULT TRUE,  -- pedidos, purchases, pagos
  lock_production BOOLEAN DEFAULT FALSE,             -- can still enter late production
  lock_gl_entries BOOLEAN DEFAULT TRUE,              -- can't manually edit GL
  lock_tax_submissions BOOLEAN DEFAULT FALSE,        -- can adjust taxes even after close
  
  # MP-specific
  mp_reconciliation_completed BOOLEAN DEFAULT FALSE,
  mp_final_batch_id BIGINT FK mp_reconciliation_batches (nullable),
  
  # Audit
  closed_by UUID (nullable),
  closed_at TIMESTAMP (nullable),
  close_reason TEXT,
  reopened_by UUID (nullable),
  reopened_at TIMESTAMP (nullable),
  reopen_reason TEXT,
}

-- Constraints:
CHECK (status IN ('OPEN', 'CLOSED', 'REOPENED'))
CHECK (closed_at IS NULL OR status IN ('CLOSED', 'REOPENED'))

-- Business logic:

-- When close period:
1. Verify all expected GL entries are posted
2. Lock: economic_transactions, GL entries
3. Unlock: production (can still enter historical records), tax corrections
4. Set status='CLOSED', closed_at=now()

-- To reopen:
1. Require admin + reason
2. Set status='REOPENED'
3. Allow edits to economic transactions (with audit)
4. Prevent re-locking without re-closing (forces re-reconciliation)

-- When MP reconciliation completes:
1. Post all GL entries for period
2. Set mp_reconciliation_completed=TRUE
3. Allow period to close only if this=TRUE OR manual override
```

**Workflow Example:**

```
2026-09-01: Period OPEN for September
2026-09-15: User enters production, orders, etc. (all OK)
2026-09-30: User tries to close September period
  → Check: all expected GL entries posted? (may need manual MP reconciliation)
  → Check: all expected invoices received? (allow manual extension)
  → If OK: set status='CLOSED'
  
2026-10-01: User can still enter SEPTEMBER production (late recording)
            but cannot EDIT September orders or GL
            
2026-10-05: Supplier sends invoice for 2026-09-30
            → Received late; create purchase with document_date=2026-09-30
            → Post GL entry with manual 'correction' flag for September
            → (or: allow adjustment to September if not fully locked)

2026-10-10: Accountant reviews September; finds error
            → Request reopen: set status='REOPENED', reason='tax_correction'
            → Modify GL entry, add audit note
            → Re-close: set status='CLOSED' again
```

**Migration Risk:** MEDIUM  
- Must decide retroactively which historical months to "close"
- Determine cut-off: when can you not go back further? (Usually 12-36 months)
- MP reconciliation logic must be finalized first

---

## J. PRODUCTION INTEGRITY

### Flock, Shed, Daily Production, Mortality

**CURRENT STATE:**

```
lotes (flocks):
  id, galpon (TEXT, not FK!), fecha_entrada, fecha_salida,
  aves_iniciales_postura, estado, ...

producciones (daily_production):
  id, fecha, galpon (TEXT), lote_id (FK but can be NULL!),
  huevos_totales_mediodia, huevos_cachados_mediodia,
  huevos_totales_tarde, huevos_cachados_tarde,
  mortandad, observaciones, ...

recuentos_lote (flock_weighing_checkpoints?):
  id, lote_id, fecha, poblacion, mortalidad, observaciones
```

**PROBLEMS:**

1. **Galpon as TEXT:**
   - Can be misspelled ("Galpón 1" vs "Galpon 1" vs "GALPON 1")
   - No FK to sheds table
   - Difficult to aggregate by shed

2. **Lote can be NULL in producciones:**
   - Production recorded with `lote_id=NULL`
   - Which flock is it? Unknown
   - Cannot reconstruct population or costs accurately

3. **Two mortality sources:**
   - `producciones.mortandad` (daily)
   - `recuentos_lote.mortalidad` (checkpoint)
   - Which is source of truth if they conflict?

4. **No explicit flock lifecycle:**
   - When flock retires (fecha_salida set), what's the final population?
   - If mortandad on 2026-09-30 and fecha_salida='2026-09-30', does it count?

5. **Production timing:**
   - Eggs counted mid-day and after-day
   - Is "total" sum of both or distinct counts?
   - Terminology unclear: "totales" includes broken/dirty or not?

**INFERENCE:**

Current system assumes:
- One active flock per shed at any time
- Daily production record optionally linked to flock
- Mortality recorded daily; recuentos are audits
- No explicit pooling or mixing

**RECOMMENDATION:**

Enforce referential integrity:

```sql
sheds {
  id BIGSERIAL PK,
  shed_name VARCHAR UNIQUE ('Galpón 1', 'Galpón 2', ...),
  shed_number INT,
  capacity_birds INT,
  capacity_eggs_daily INT,
  created_at TIMESTAMP,
}

flocks {
  id UUID PK,
  shed_id BIGINT FK sheds NOT NULL,
  entry_date DATE,
  exit_date DATE (nullable),
  initial_population INT,
  
  genetics_line VARCHAR,
  age_weeks_at_entry INT,
  
  status ('ACTIVE', 'RETIRED'),
  
  -- If one flock per shed, add UNIQUE constraint:
  UNIQUE (shed_id, status) WHERE status='ACTIVE',
  
  created_at TIMESTAMP,
}

daily_production {
  id BIGSERIAL PK,
  flock_id UUID FK flocks NOT NULL,  -- REQUIRED, not nullable
  production_date DATE,
  
  -- Morning count (6-12am)
  eggs_collected_morning INT,
  eggs_damaged_morning INT,
  eggs_dirty_morning INT,
  
  -- Afternoon count (12am-6pm)
  eggs_collected_afternoon INT,
  eggs_damaged_afternoon INT,
  eggs_dirty_afternoon INT,
  
  -- Summary
  total_eggs_collected = SUM(collected_*),
  total_eggs_damaged = SUM(damaged_*),
  total_eggs_dirty = SUM(dirty_*),
  total_eggs_for_sale = total_collected - damaged - dirty,
  
  mortality_events INT (separate from production),
  feed_consumed_kg NUMERIC,
  
  observ_morning TEXT,
  observ_afternoon TEXT,
  
  created_by UUID,
  created_at TIMESTAMP,
  
  UNIQUE (flock_id, production_date),  -- One record per flock per day
}

population_events {
  id BIGSERIAL PK,
  flock_id UUID FK flocks,
  event_type ('initial', 'death', 'adjustment', 'recount'),
  delta INT (negative for death),
  event_date DATE,
  
  source ('daily_production', 'recount', 'manual'),
  source_id VARCHAR (e.g., production_date or recount_id),
  
  reason TEXT,
  recorded_by UUID,
  recorded_at TIMESTAMP,
}

flock_recounts {
  id BIGSERIAL PK,
  flock_id UUID FK flocks,
  recount_date DATE,
  
  counted_by VARCHAR,
  bird_count INT,
  physical_notes TEXT,
  
  calculated_population = SUM(population_events.delta WHERE date <= recount_date),
  variance = bird_count - calculated_population,
  variance_reason TEXT (if > threshold, manual explanation required),
  
  created_by UUID,
  created_at TIMESTAMP,
}

-- Business logic:

-- When record daily production:
1. flock_id is REQUIRED (no nulls)
2. Validate flock is ACTIVE on production_date
3. Create population_event for mortality if > 0
4. Calculate total_for_sale automatically

-- When retire flock:
1. Check: no production_date > exit_date
2. Create population_event (type='retirement', delta=-remaining_population)
3. Set flock.status='RETIRED'

-- When receive recount:
1. Calculate expected population
2. Compare to counted
3. If variance > 3%: require explanation
4. Create population_event (type='adjustment', delta=variance)

-- Query current population:
SELECT SUM(delta) FROM population_events
WHERE flock_id = X AND event_date <= today()
```

**Migration Risk:** MEDIUM-HIGH  
- Historical producciones with `lote_id=NULL` must be backfilled or flagged
- Mortality logic must be extracted from producciones into population_events
- Need to verify eggs/mortandad are not double-counted

---

## K. FEED COSTING COMPLEXITY

### Stock In + Made - Stock Out = Consumed

**FACTS FOUND:**

Current system:
- producciones.alimento (daily consumption, single field)
- No feed types or formulations tracked
- No manufacturing records
- No inventory counts
- No cost tracking

**INFERENCE:**

System does NOT track feed in detail.  
Only daily consumption is recorded (for cost analysis).  
No physical inventory verification.

**EDGE CASES & PROBLEMS:**

1. **Feed inventory counts lag:**
   - Stock count on 2026-09-30 (end of month)
   - But it's physical; doesn't match records until verified next day
   - Does September consumption include estimated count or wait for actual count?

2. **Waste/spoilage:**
   - If feed is stored improperly and spoils, how is it recognized?
   - Is it a production loss? A storage cost?
   - Must be explicitly entered or calculated?

3. **Formulation changes:**
   - If feed recipe changes mid-month, do costs shift?
   - Must track which formula was used for each batch

4. **Feed cost inflation:**
   - If unit cost changes, does historical consumption recalculate at new cost?
   - Or preserve original cost?

5. **Manufacturing vs purchased:**
   - If some feed is self-manufactured (balanceado casero), does it get different cost?
   - Must separate labor + raw materials

6. **Selling feed as byproduct:**
   - Sometimes they might sell excess feed
   - This complicates inventory (is it input or product?)

**RECOMMENDATION:**

For MVP, keep simple:

```sql
feed_purchases {
  id BIGSERIAL PK,
  feed_type VARCHAR ('maize', 'soja_expeller', 'balanceado'),
  purchase_date DATE,
  quantity_kg NUMERIC,
  cost_per_kg NUMERIC,
  total_cost NUMERIC,
  supplier_id BIGINT FK suppliers,
  
  # When counted into inventory
  received_date DATE,
  received_by UUID,
  storage_location VARCHAR,
  
  created_at TIMESTAMP,
}

feed_consumption_log {
  id BIGSERIAL PK,
  flock_id UUID FK flocks,
  date DATE,
  feed_type VARCHAR,
  quantity_used_kg NUMERIC,
  
  # For cost calculation (snapshot)
  cost_per_kg_used NUMERIC (price on that date),
  
  created_by UUID,
  created_at TIMESTAMP,
}

-- Simple monthly calculation:
SELECT
  SUM(quantity_kg) as purchased,
  MAX(received_date) as last_received,
  
  -- For estimated inventory:
  (SELECT SUM(quantity_used_kg) FROM feed_consumption_log 
   WHERE date BETWEEN period_start AND period_end) as consumed,
  
  SUM(quantity_kg) - consumed as estimated_remaining
FROM feed_purchases
WHERE received_date <= period_end
```

**For detailed costing (LATER):**
- FIFO/LIFO for cost accounting
- Scrap/waste tracking
- Manufacturing cost allocation
- Feed efficiency ratios (kg feed per egg, per kilogram of bird)

**Migration Risk:** LOW  
- Current system doesn't track detail; can ignore for now
- If accounting need arises later, can add without breaking existing data

---

## L. FERIA MODEL ATTACK

### "One Aggregated Consumidor Final Pedido" — Sufficient?

**PRINCIPLE:** "Feria se modela como jornada de venta... Para minoristas anónimos se propone un pedido agregado a 'Consumidor Final'."

**PROBLEMS:**

1. **Itemization Lost:**
   ```
   Feria 2026-09-24:
   - 10 docenas a $X
   - 5 XL a $Y
   - 20 N1 a $Z
   - Anonymous customers
   
   Current approach: Create one Pedido to "Consumidor Final"
   with LineaPedido x3 (docena, XL, N1)
   
   PROBLEM: Revenue per item is indistinguishable from regular orders
   ```

2. **Returns and Waste:**
   ```
   Feria closes with:
   - 200 eggs sold
   - 15 eggs returned (broken en route)
   - 5 eggs lost (theft? accident?)
   
   A single aggregated Pedido doesn't capture this granularity
   Must add field to Pedido? Or separate "feria_session_losses"?
   ```

3. **MP Reconciliation at Session Level:**
   ```
   Feria collects €500 via MP
   + €300 cash
   + €100 pending cheque
   
   Later, €50 of MP transactions are chargebacks
   Which item(s) in the Pedido do we reverse?
   ```

4. **Daily Accounting:**
   ```
   Manager wants to know: "How much did we make at Feria on 2026-09-24?"
   With aggregated Pedido, must query:
   - Pedido where cliente='Consumidor Final' and fecha >= 24 and fecha < 25
   - But what if Pedido is created next morning (batch entry)?
   ```

5. **Retail Regulations:**
   ```
   Some jurisdictions require itemized receipt for retail sales
   Even if anonymous, must show: what, how much, price
   A single Pedido to "Consumidor Final" is too abstract for compliance
   ```

**CURRENT SYSTEM:**

- Creates pedidos to real clientes
- No concept of feria jornada
- No session-level aggregation

**RECOMMENDATION (see Challenge 3 for details):**

Do NOT use single aggregated Pedido.

Instead:

```sql
sales_sessions {
  id BIGSERIAL PK,
  session_date DATE,
  session_type ('feria_municipal', 'local_retail', 'wholesale'),
  session_venue VARCHAR ('Plaza Mayor', 'Local Av. Mitre', 'Mayorista ABC'),
  
  # Cash management
  opening_cash NUMERIC,
  closing_cash NUMERIC,
  variance NUMERIC,
  
  # Counters
  total_units_sold INT,
  total_revenue NUMERIC,
  
  # Reconciliation
  mp_transactions_count INT,
  mp_total NUMERIC,
  cheque_count INT,
  cheque_total NUMERIC,
  cash_from_sales NUMERIC,
  
  status ('OPEN', 'CLOSED', 'RECONCILED'),
  closed_by UUID,
  closed_at TIMESTAMP,
  
  notes TEXT,
  created_at TIMESTAMP,
}

sales_session_line_items {
  id BIGSERIAL PK,
  session_id BIGINT FK sales_sessions,
  product_id UUID FK products,
  quantity INT,
  price_unit NUMERIC,
  subtotal NUMERIC,
  customer_name VARCHAR (nullable, for known customers),
  payment_method ('cash', 'mp', 'cheque', 'credit_note'),
  
  created_at TIMESTAMP,
}

sales_session_losses {
  id BIGSERIAL PK,
  session_id BIGINT FK sales_sessions,
  loss_type ('damaged_in_transit', 'spoilage', 'theft', 'correction'),
  product_id UUID FK products,
  quantity INT,
  value_estimate NUMERIC,
  reason TEXT,
  recorded_by UUID,
  recorded_at TIMESTAMP,
}

-- At close of session:
CREATE OR REPLACE PROCEDURE close_sales_session(
  p_session_id BIGINT,
  p_closing_cash NUMERIC,
  p_notes TEXT
) AS $$
BEGIN
  -- 1. Calculate variance
  UPDATE sales_sessions 
  SET closing_cash = p_closing_cash,
      variance = p_closing_cash - opening_cash - total_revenue,
      status = 'CLOSED',
      closed_at = now(),
      notes = p_notes
  WHERE id = p_session_id;
  
  -- 2. Create aggregated Pedido for "Consumidor Final"
  INSERT INTO orders (client_id, estado, monto_total, ...)
  SELECT 
    'consumidor_final_id' as client_id,
    'delivered' as estado,
    (SELECT total_revenue FROM sales_sessions WHERE id = p_session_id),
    'feria_aggregated' as reference,
    now();
  
  -- 3. Create order lines from session items
  INSERT INTO order_lines (order_id, product_id, cantidad, precio_unitario, subtotal)
  SELECT 
    (last inserted order_id),
    product_id,
    SUM(quantity),
    AVG(price_unit),  -- Or use current price
    SUM(subtotal)
  FROM sales_session_line_items
  WHERE session_id = p_session_id
  GROUP BY product_id;
  
  -- 4. Post GL entry for revenue
  INSERT INTO general_ledger (account_id, credit_amount, ledger_date, ...)
  VALUES (caja_chica_account, total_revenue, session_date, 'feria_aggregated_revenue');
  
  UPDATE sales_sessions SET status='RECONCILED' WHERE id = p_session_id;
END;
$$ LANGUAGE plpgsql;
```

**Advantages:**
- Session-level cash management (reconciliation)
- Item-level detail for compliance/analytics
- Losses/returns tracked explicitly
- Revenue recognized at session close, not per transaction
- MP chargebacks can be traced to session

**Migration Risk:** MEDIUM  
- Requires new sales_sessions + sales_session_line_items tables
- Must establish which historical retail transactions aggregate into sessions
- May need to invent sessions retroactively

---

## M. FISCAL LAYER

### Tax Complexity in Neutral Language

**TARGET PRINCIPLES:**

"Fiscal es una capa derivada/asociada a operaciones. Debe distinguir:
* IVA débito;
* IVA crédito;
* retenciones;
* percepciones;
* obligaciones;
* pagos."

**FACTS FOUND:**

Current system:
- FormMovimiento calculates IVA on cash movement
- Stores `alicuota_iva`, `monto_iva` in movimientos_caja
- No separate tax table
- No tax obligation tracking
- No withholding/perception logic

**INFERENCE:**

System is NOT doing formal tax accounting.  
Only rough IVA calculations for individual movements.  
No AFIP reporting infrastructure.

**PROBLEMS:**

1. **IVA Débito vs Crédito:**
   ```
   Sales invoice (2026-09-30): Total 100 + 21 IVA = 121
     → Creates IVA Débito (tax owed to AFIP)
   
   Supplier invoice (2026-09-28): Total 100 + 21 IVA = 121
     → Creates IVA Crédito (can offset débito)
   
   Current system: No linking of these; IVA field on movement
   Target: Need separate tax_components table
   ```

2. **Withholding:**
   ```
   If supplier is unregistered or foreign, we may withhold tax
   Deductions: impuesto a los ingresos brutos, etc.
   Current: No field for withholding
   ```

3. **Tax Obligations:**
   ```
   Monthly: Submit SIRE (ventas) + SICORE (compras) + payment
   Current: No tracking of what's been submitted
   ```

4. **Tax Compliance Period ≠ Accounting Period:**
   ```
   Accounting: Month January
   Tax: Calendar year, also quarterly declarations
   System must allow different closing schedules
   ```

5. **Fiscal Address ≠ Delivery Address:**
   ```
   For tax documentation, need correct fiscal address of supplier/customer
   Current: No separate fields
   ```

**RECOMMENDATION:**

Do NOT build full tax accounting yet.  
Instead, create infrastructure that accountant can fill:

```sql
tax_categories {
  id BIGSERIAL PK,
  tax_type VARCHAR ('iva', 'withholding', 'perception', 'gross_income'),
  category_name VARCHAR ('IVA 21%', 'Withholding 10.5%', ...),
  rate NUMERIC (21.00, not 21),
  applies_to_operations VARCHAR ('sales', 'purchases', 'both'),
  active BOOLEAN,
  created_at TIMESTAMP,
}

purchase_tax_allocation {
  id BIGSERIAL PK,
  purchase_id BIGINT FK purchases,
  tax_category_id BIGINT FK tax_categories,
  
  base_amount NUMERIC,
  tax_amount NUMERIC,
  
  -- For IVA: can it be credited?
  tax_deductible BOOLEAN,
  
  recorded_by UUID,
  recorded_at TIMESTAMP,
}

sales_tax_allocation {
  id BIGSERIAL PK,
  order_id BIGINT FK orders,
  tax_category_id BIGINT FK tax_categories,
  
  base_amount NUMERIC,
  tax_amount NUMERIC,
  tax_payable_date DATE (when AFIP expects payment),
  
  recorded_by UUID,
  recorded_at TIMESTAMP,
}

tax_obligations {
  id BIGSERIAL PK,
  obligation_period DATE,  -- 2026-09 for September
  obligation_type VARCHAR ('iva_monthly', 'ingresos_brutos', 'earnings_withholding'),
  
  total_débito NUMERIC (from sales_tax_allocation),
  total_crédito NUMERIC (from purchase_tax_allocation),
  net_amount NUMERIC (signed, owed to or refund from AFIP),
  
  payment_due_date DATE,
  payment_status VARCHAR ('due', 'paid', 'refund_received'),
  payment_date DATE (nullable),
  payment_amount NUMERIC,
  payment_method VARCHAR,
  
  documentation_submitted BOOLEAN,
  submission_date DATE,
  submission_reference VARCHAR (AFIP acknowledgment),
  
  notes TEXT,
  recorded_by UUID,
  recorded_at TIMESTAMP,
}

-- Query tax position:
SELECT
  SUM(base_amount) as sales_before_tax,
  SUM(tax_amount) as iva_débito,
  (SELECT SUM(tax_amount) FROM purchase_tax_allocation WHERE tax_deductible) as iva_crédito,
  (SUM(tax_amount) FROM sales) - (iva_crédito) as net_iva_payable,
  (SELECT SUM(net_amount) FROM tax_obligations WHERE obligation_type='iva_monthly' AND obligation_period <= today()) as cumulative_iva_paid
FROM sales_tax_allocation
WHERE YEAR(obligation_period) = 2026;
```

**Important Caveat:**

This is NOT tax advice and NOT a replacement for an accountant.  
Business should have accountant review tax logic.  
Tax rules are JURISDICTION-SPECIFIC and CHANGE FREQUENTLY.  
Current design is manageable but requires domain expertise to finalize.

**Migration Risk:** MEDIUM  
- Current system doesn't track tax; can start fresh
- Retroactive tax calculations may be needed (accountant involvement)

---

## N. RLS / SECURITY

### ADMIN vs OPERATOR

**CURRENT STATE:**

RLS policies exist on financial tables:
```
SELECT: auth.role() = 'authenticated'
INSERT/UPDATE/DELETE: is_dueño()
```

**TARGET ROLES:**

- ADMIN: full access
- OPERATOR: limited to operational functions

**PROBLEMS:**

1. **Current RLS is ALL-OR-NOTHING:**
   - Either dueño (full) or not dueño (read-only)
   - No granular per-function permissions

2. **No OPERATOR role defined:**
   - What can operator do?
   - Can operator view financial reports?
   - Can operator reverse payments?

3. **RLS is DB-level but UI hides functions:**
   - Security should NOT rely on UI hiding
   - Must enforce at DB level
   - Current system may have gaps

4. **No audit of who did what:**
   - `created_by` field exists but incomplete
   - Not all tables have `created_by`
   - Not all updates logged

**RECOMMENDATION:**

Define granular RLS:

```sql
-- Roles:
CREATE ROLE admin;
CREATE ROLE operator;
CREATE ROLE viewer; -- read-only

-- Table permissions:

-- ADMIN: full access
GRANT ALL ON ALL TABLES IN SCHEMA public TO admin;

-- OPERATOR: limited
GRANT SELECT ON public.clientes TO operator;
GRANT SELECT ON public.pedidos TO operator;
GRANT INSERT, UPDATE ON public.daily_production TO operator;  -- Can enter production
GRANT SELECT ON public.producciones TO operator;

-- Cannot touch financials:
REVOKE ALL ON public.general_ledger FROM operator;
REVOKE ALL ON public.collections FROM operator;
REVOKE ALL ON public.supplier_payments FROM operator;
REVOKE ALL ON public.financial_instruments FROM operator;

-- VIEWER: read-only
GRANT SELECT ON ALL TABLES IN SCHEMA public TO viewer;

-- Specific RLS policies:

-- Production: operator can enter own, see all
ALTER TABLE daily_production ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_production ON daily_production
  FOR INSERT WITH CHECK (
    auth.uid() = created_by
    AND has_role(auth.uid(), 'operator')
  );
CREATE POLICY operator_view_production ON daily_production
  FOR SELECT USING (
    has_role(auth.uid(), 'operator') OR has_role(auth.uid(), 'admin')
  );

-- Financial: admin only
ALTER TABLE general_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_ledger ON general_ledger
  FOR ALL USING (
    has_role(auth.uid(), 'admin')
  );

-- Audit: log all changes
CREATE TABLE audit_log (
  id BIGSERIAL PK,
  table_name VARCHAR,
  record_id VARCHAR,
  operation VARCHAR ('INSERT', 'UPDATE', 'DELETE'),
  old_values JSONB,
  new_values JSONB,
  changed_by UUID,
  changed_at TIMESTAMP DEFAULT now(),
);

-- Trigger on financial tables:
CREATE OR REPLACE FUNCTION audit_financial_change()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, operation, old_values, new_values, changed_by)
  VALUES (
    TG_TABLE_NAME,
    NEW.id::text,
    TG_OP,
    to_jsonb(OLD),
    to_jsonb(NEW),
    auth.uid()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_general_ledger_changes
AFTER INSERT OR UPDATE ON general_ledger
FOR EACH ROW EXECUTE FUNCTION audit_financial_change();
```

**Migration Risk:** LOW  
- No impact on current data
- RLS additions don't break existing queries (only restrict them)

---

## O. MIGRATION STRATEGY

### From Current → Target (Preview)

**TIMELINE OVERVIEW:**

1. **Phase 0 (1-2 weeks):** Design finalization
   - Resolve ledger architecture (Recommendation: Option B)
   - Clarify domain rules with owner
   - Finalize schema design

2. **Phase 1 (2-4 weeks):** Safe cutover point
   - Select historical cutoff (e.g., 2026-01-01)
   - Migrate clean data from cutover date forward
   - Leave pre-cutoff data in "legacy" read-only schema
   - Establish opening balances (using audited closing from December 2025)

3. **Phase 2 (1-2 weeks):** Data import + validation
   - Convert existing tables (clientes → clients, pedidos → orders, etc.)
   - Backfill snapshots (product names, supplier names)
   - Validate balances: NEW SUM() = OLD SUM()
   - Reconcile to external (bank statements, MP, supplier confirmations)

4. **Phase 3 (ongoing):** Gradual feature rollout
   - Operators use new UI on new data
   - Queries can still hit legacy data (for historical reports)
   - Deprecation window (e.g., 6 months to fully migrate operators)

**VALIDATION CHECKS:**

```
1. Customer CC Balance:
   NEW: SUM(client_ledger WHERE client_id = X)
   OLD: SUM(pedidos) - SUM(pagos)
   → MUST match for each customer

2. Financial Account Saldo:
   NEW: SUM(general_ledger WHERE account_id = X)
   OLD: SUM(movimientos_caja WHERE account_id ~ X)
   → MUST match for each account

3. Revenue (P&L):
   NEW: SUM(gl_entries WHERE operation_type LIKE 'sales%')
   OLD: SUM(pedidos estado='delivered')
   → MUST match

4. Cash:
   NEW: physical count + SUM(gl_entries) for the day
   OLD: physical count + SUM(movimientos_caja)
   → MUST match exactly
```

**Key Risks:**

1. **Missing data:** If historical producciones.lote_id is NULL, cannot match production to flock
   → Solution: Flag records; may need manual assignment

2. **Duplicate data:** If pedido was "delivered" and rectified multiple times, order total is ambiguous
   → Solution: Reconstruct economic event from timestamps

3. **MP reconciliation:** If mp_financial_movement and ledger_entry are inconsistent, cannot know true balance
   → Solution: Audit MP data BEFORE migration; fix contradictions

**Migration Risk:** CRITICAL  
- Must involve owner + accountant + operators
- Validation is mandatory; cannot proceed without sign-off
- Parallel running period (old + new systems) required for confidence

---

## P. MISSING EDGE CASES — 15 Santo Tomás Scenarios

### 1. Order Rectification After Delivery

**SCENARIO:**
Order delivered 2026-09-24. Customer inspects eggs; finds 10 broken (weren't counted as damaged at classification).  
On 2026-09-25, operator changes order: -10 units.

**CURRENT MODEL:** Pedidos allow rectification after delivery. But economic event (CC debt) already recognized.

**PROBLEM:** Reversing the line doesn't automatically reverse the GL entry recognizing revenue.

**PROPOSED RESOLUTION:**
- Disallow rectification after estado='entregado'
- REQUIRE creation of credit note (negative order) if post-delivery change
- Credit note must have reason, approval chain
- Original pedido remains immutable; credit offsets it

---

### 2. MP Double-Counted Transfer

**SCENARIO:**
Seller deposits cheque at MP for $1000.  
MP reports the deposit AND creates a "transfer" transaction (internal MP movement).  
Both are imported into system.

**CURRENT MODEL:** No duplicate detection across source types.

**PROBLEM:** If both are classified as income, balance is +2000 instead of +1000.

**PROPOSED RESOLUTION:**
- MP reconciliation must detect N:M relationships
- Many MP movements can map to one GL entry
- `mp_movement_source_link` must be resolved before GL posting
- Require manual review if multiple movements link to one

---

### 3. Cheque Returned Weeks Later

**SCENARIO:**
Customer pays via cheque on 2026-09-15. Cheque deposited, cleared 2026-09-20.  
On 2026-10-01 (after month close), bank rejects cheque (insufficient funds).

**CURRENT MODEL:** No cheque lifecycle; estado='cobrado' is final.

**PROBLEM:** Period is closed; cannot re-open to reverse GL entry. Customer CC shows artificially low balance.

**PROPOSED RESOLUTION:**
- Cheque rejection can occur in CLOSED periods
- Creates GL reversal entry marked with special flag (post-close_correction)
- Automatically reopens customer CC
- Bank reconciliation includes rejected cheques explicitly
- Allows reopen of month if needed

---

### 4. Feria with Coupons / Store Credit

**SCENARIO:**
Feria session includes customer who pays partially with old coupon (100 pesos, issued pre-2026).

**CURRENT MODEL:** sales_session assumes cash/cheque/MP only.

**PROBLEM:** Internal store credit is not a revenue-generating instrument.

**PROPOSED RESOLUTION:**
- Add payment_method 'store_credit' to sales_session_line_items
- Track redeemed coupons separately
- Store credit reduces "cash" revenue but doesn't create GL entry (it's a liability reversal)
- Coupon expiry must be enforced (cannot use expired coupon)

---

### 5. Production with Shared Feed Between Flocks

**SCENARIO:**
Two flocks share a galpón (either as co-location or after one retires).  
Feed consumption is tracked per galpón, not per flock.

**CURRENT MODEL:** Producciones.lote_id; assumes 1 flock per galpón.

**PROBLEM:** Cannot allocate feed cost accurately between flocks.

**PROPOSED RESOLUTION:**
- Allow multiple active flocks per shed (remove UNIQUE constraint)
- Require operator to manually split feed allocation (20 kg to flock A, 15 kg to flock B) OR
- Allocate proportionally by population
- Create `daily_production.feed_allocation_source` to track method
- Cost report shows variance if split was manual vs calculated

---

### 6. Invoice with Wrong Tax ID

**SCENARIO:**
Supplier's invoice has wrong tax ID (CUIT).  
We pay it but MP reconciliation shows different payer ID.

**CURRENT MODEL:** No validation of tax ID.

**PROBLEM:** Audit trail is broken; cannot reconcile supplier payment to supplier record.

**PROPOSED RESOLUTION:**
- Supplier record stores primary_tax_id + alternate_tax_ids
- Purchase creation validates tax ID against supplier
- If mismatch, flag for manual review (don't block, but require reason)
- GL entry includes both supplier_id (our record) and tax_id_on_invoice (audit)

---

### 7. Product That's Both Input and Output

**SCENARIO:**
Maize is bought as feed input (cost center) but sometimes sold as byproduct (revenue).

**CURRENT MODEL:** products.tipo would be 'input' OR 'sellable'.

**PROBLEM:** Single product cannot have both roles; would need two product records.

**PROPOSED RESOLUTION:**
- Change productos.tipo to `product_type_flags` (ARRAY of 'input', 'sellable', 'byproduct')
- When used in order, system determines context (if order line, it's a sale; if feed consumption, it's an input)
- GL posting uses product_type + context to determine account

---

### 8. Late Purchase Invoice (dated prior period)

**SCENARIO:**
Supplier sends invoice on 2026-10-08 dated 2026-09-25.  
September is closed.

**CURRENT MODEL:** No distinction between document_date and received_date.

**PROBLEM:** Must enter expense in September (accrual) but system won't accept it (period closed).

**PROPOSED RESOLUTION:**
- Period close allows "late corrections" if document_date is in closed period
- Require explanation + approval
- Create GL entry marked with operation_type='late_correction', flag in reports
- Allow accountant to query all late corrections for audit

---

### 9. Flock Dies Suddenly (All Mortality)

**SCENARIO:**
Environmental issue (heat, predator, disease) kills 90% of flock in one day.

**CURRENT MODEL:** producciones.mortandad per day.

**PROBLEM:** If daily limit is 5%, system might flag as anomaly and reject.

**PROPOSED RESOLUTION:**
- Daily mortality record with no artificial ceiling
- But system must flag unusual events (>10% in single day)
- Operator enters explanation (must be substantive, not just "yes, it happened")
- GL costing automatically adjusts (cost per kg bird increases)
- Insurance claim reference can be linked (if applicable)

---

### 10. MP Commission Deduction (Separate from Settlement)

**SCENARIO:**
MP shows:
- Settlement amount: 1000
- Less commission: 50
- Plus refund: 10
- Net to deposit: 960

**CURRENT MODEL:** Treats as single `mp_financial_movement`.

**PROBLEM:** Cannot separately track commission (for expense reporting) vs net revenue.

**PROPOSED RESOLUTION:**
- mp_financial_movement.transaction_amount vs settlement_amount must be preserved
- GL posting creates:
  - Debit: Cash (960)
  - Credit: Revenue (1000)
  - Credit: Refunds (10)
  - Debit: MP Commission Expense (50)
- Allows separate tracking of commission burn rate

---

### 11. Customer Changes Fiscal Status Mid-Month

**SCENARIO:**
Customer was registered for IVA; stops being so.  
Orders before change: tax applicable.  
Orders after: tax exempt.

**CURRENT MODEL:** No tax classification per customer per order.

**PROBLEM:** GL posting must use correct tax treatment per transaction date.

**PROPOSED RESOLUTION:**
- customers table: fiscal_status_history (effective_date_from, effective_date_to, status)
- When posting order revenue, query customer status on order_date
- GL entry includes customer_fiscal_status snapshot
- Tax compliance report shows transition clearly

---

### 12. Retroactive Correction of Production (Mortality Count Error)

**SCENARIO:**
Production recorded on 2026-09-15: 5 birds dead.  
On 2026-09-28, operator realizes count was wrong; should be 8.

**CURRENT MODEL:** Producciones.mortandad is editable.

**PROBLEM:** Editing changes history without audit trail.

**PROPOSED RESOLUTION:**
- Producciones.mortandad is immutable after 7 days (configurable)
- After 7 days, cannot edit; must post correction via population_events
- Correction entry is explicit (operation_type='correction', reason=...)
- Historical cost calculations CAN recalculate or REMAIN fixed (per period close rules)

---

### 13. Cheque Returned Then Re-deposited (Twice)

**SCENARIO:**
Cheque bounces 2026-10-01.  
Customer gives replacement 2026-10-05.  
System must track both cheque records + the correction.

**CURRENT MODEL:** One cheque record per cheque.

**PROBLEM:** Cannot represent "original cheque # 12345 replaced by cheque # 12346".

**PROPOSED RESOLUTION:**
- financial_instruments.superseded_by_instrument_id (nullable)
- When rejection occurs:
  1. Mark original as status='rejected'
  2. Create reversal GL entry
  3. Open new cheque record
  4. Link via superseded_by field
- Audit trail shows full history

---

### 14. Sales Session with Mixed Wholesale + Retail

**SCENARIO:**
Same feria session includes:
- 100 eggs to anonymous retail customers
- 50 eggs to known wholesale buyer at bulk price

**CURRENT MODEL:** Aggregates all as "Consumidor Final".

**PROBLEM:** Revenue per unit differs; must track separately for margin analysis.

**PROPOSED RESOLUTION:**
- sales_session_line_items includes customer_type field ('retail', 'wholesale', 'b2b')
- GL posting creates separate revenue lines by type
- Allows analysis of channel profitability
- Wholesale customer can still be "Consumidor Final" (aggregated) or linked to known customer

---

### 15. Multi-Year Feed Depreciation (Grain Storage Rot)

**SCENARIO:**
Maize purchased 2025-11 stored for slow consumption through 2026-Q3.  
In 2026-08, discover portion is spoiled.

**CURRENT MODEL:** No tracking of spoilage by vintage.

**PROBLEM:** Cost allocation to which production periods?

**PROPOSED RESOLUTION:**
- feed_inventory tracks vintage (purchase_date)
- When spoilage discovered, create inventory adjustment:
  ```
  feed_spoilage_record {
    id, feed_purchase_id, quantity_spoiled, discovery_date, reason
  }
  ```
- System can allocate spoilage retroactively across production periods
  - Option A: Allocate to current period only (conservative)
  - Option B: Allocate across storage period (accrual)
  - Choose per policy, audit decision

---

## Q. FINAL VERDICT

### BLOCKERS — Must Resolve Before Schema Design

1. **Ledger Architecture Decision**
   - CRITICAL: Two separate ledgers (movimientos_caja + mp_financial_movement) cannot coexist
   - Recommendation: Build new global ledger (Option B) and bridge MP into it
   - Cannot proceed with DB design until this is final

2. **Feria Model Clarification**
   - CRITICAL: "Aggregated Pedido" approach insufficient for operations
   - Recommendation: Create sales_sessions concept
   - Must have owner validation that this matches real workflow

3. **Production Immutability Rules**
   - CRITICAL: Must define when producciones fields become immutable
   - Current: fully editable always (error-prone)
   - Recommendation: Lock after N days or period close
   - Must codify exact rules

4. **Period Close Rules**
   - CRITICAL: Unclear what "CLOSED" actually prevents
   - Recommendation: Define precisely per entity (see Section I)
   - Must clarify MP reconciliation timing vs period close

5. **MP Reconciliation Completion**
   - CRITICAL: FASE 0 architecture partially implemented; legacy tables still present
   - Recommendation: Complete MP migration before schema redesign
   - Cannot have two parallel MP ledgers

### IMPORTANT — Should Resolve, But Don't Block Schema Design

6. **Cheque Lifecycle Implementation**
   - Current: cheques table exists but flow is unclear
   - Recommendation: Formalize state machine (see Section H)
   - Can be added incrementally

7. **Supplier/Purchasing Model**
   - Current: absent entirely
   - Recommendation: Design before implementin (see B)
   - Can defer to Phase 2 if prioritizing customer/revenue side first

8. **Tax Tracking Formalization**
   - Current: ad-hoc in FormMovimiento
   - Recommendation: Create tax_components + tax_obligations tables
   - Can be augmented iteratively; recommend involving accountant

9. **Feed Costing Detail**
   - Current: simple daily consumption tracking
   - Recommendation: Defer to Phase 2 (see K)
   - Can operate with current simplicity for now

10. **Temporal Attributes (Multiple Dates)**
    - Current: conflated (created_at, fecha_operacion, fecha_pago, etc.)
    - Recommendation: Define semantics (see Section F)
    - Critical for correctness but can be added to initial schema

### LATER — Safe to Defer

11. **Flock Weighings + Temperature Records**
    - Not currently tracked
    - Operational value unclear; defer until operators request

12. **Detailed Feed Formulations**
    - Complex; requires ops input
    - Can operate with simple tracking initially

13. **Internal Reserves + Dividends**
    - Nice-to-have for P&L; not essential
    - Can add in Phase 3

14. **Advanced Tax Reporting**
    - Jurisdiction-specific; accountant domain
    - Defer until formal tax requirements codified

### QUESTIONS FOR THE OWNER

**Must be answered before schema finalization:**

1. **Feria Operations:**
   - How many feria sessions per week?
   - Do you track them today (by day, by location)?
   - Should retail + wholesale be separate or merged?
   - How do you currently record feria cash counts?

2. **Cheque Handling:**
   - Cheques received from customers: how often? What % of payments?
   - Cheques issued to suppliers: how often?
   - Current process: when do you know a cheque is deposited/cleared?
   - Do you ever endorse cheques to suppliers?

3. **Production:**
   - Mortality: is it observed daily or calculated from recuentos?
   - Can one flock span multiple galpónes, or is 1 flock = 1 galpón always?
   - Can multiple flocks share a galpón?
   - When a flock retires, what happens to eggs in progress?

4. **Suppliers:**
   - How many active suppliers?
   - Purchase frequency (daily, weekly, monthly)?
   - How do you currently track who owes whom?
   - Do you need detailed purchase line items or just totals?

5. **Financial:**
   - How many bank/MP accounts should system track?
   - Do you ever transfer between accounts? Frequency?
   - Current cash management: when do you physically count cash?
   - How does MP reconciliation happen (manual or automatic)?

6. **Fiscal:**
   - Do you file monthly IVA? Quarterly? Annually?
   - Are you registered for IVA?
   - Do you have customers that are exempt?
   - Do suppliers withhold income tax?
   - Would you like tax estimates/projections, or just tracking?

7. **Period Closing:**
   - Do you close months currently? How often?
   - Who can close periods (admin only)?
   - Can/should periods be reopened?
   - What happens to transactions received after period close?

8. **Historical Data:**
   - Should we preserve 2026-01 through 2026-08 as legacy read-only?
   - When do you want the new system to start (2026-09-01, 2026-10-01)?
   - Can you provide bank/MP statements for 2026 for reconciliation?

### RISKS: Five Biggest Architectural Concerns

1. **LEDGER AMBIGUITY (CRITICAL)**
   - Two parallel ledger systems create data integrity nightmare
   - Risk: balance discrepancies undetectable; corrections cascade
   - Mitigation: Resolve ledger architecture FIRST; complete MP migration

2. **TRANSACTION ATOMICITY (CRITICAL)**
   - Multi-step operations (payment creation, cheque linking, GL posting) not atomic
   - Risk: system corruption if app crashes mid-operation
   - Mitigation: Enforce transaction boundaries; use DB-level locks; implement idempotency

3. **IMMUTABILITY LACK (HIGH)**
   - Editable-after-delivery pedidos, production records allow retroactive changes
   - Risk: historical cost/revenue/population calculations become unreliable
   - Mitigation: Define immutability rules per entity; enforce in schema + UI

4. **FERIA AGGREGATION (HIGH)**
   - Single aggregated "Consumidor Final" pedido insufficient for retail + revenue tracking
   - Risk: itemization lost; MP reconciliation at session level impossible
   - Mitigation: Implement sales_sessions + session items; aggregate at end

5. **MIGRATION VALIDATION (HIGH)**
   - Current data has quality issues (nulls, duplicates, inconsistencies)
   - Risk: migrating dirty data perpetuates errors
   - Mitigation: Audit current data BEFORE migration; establish clean opening balances; validate on both sides

---

## SUMMARY TABLE: Action Items by Category

| Category | Item | Priority | Effort | Blocker? |
|---|---|---|---|---|
| **Ledger** | Resolve architecture (Option A/B/C) | P0 | 2w | YES |
| **Ledger** | Complete MP FASE 0 migration; delete legacy tables | P0 | 2w | YES |
| **Domain** | Define Feria model (sales_sessions vs aggregation) | P0 | 1w | YES |
| **Domain** | Define production immutability rules | P1 | 3d | NO |
| **Domain** | Define period close semantics | P1 | 3d | NO |
| **Domain** | Formalize cheque lifecycle | P1 | 5d | NO |
| **Domain** | Design supplier/purchasing model | P1 | 1w | NO |
| **Implementation** | Schema: financial_accounts + general_ledger | P0 | 1w | — |
| **Implementation** | Schema: orders + order_lines (with economic_date) | P0 | 5d | — |
| **Implementation** | Schema: collections (replace pagos + movimientos_caja design) | P1 | 1w | — |
| **Implementation** | Schema: client_ledger (audit trail) | P1 | 3d | — |
| **Implementation** | Schema: sales_sessions + items | P1 | 1w | — |
| **Implementation** | Schema: population_events (replace implicit mortality) | P1 | 5d | — |
| **Implementation** | RLS: granular operator vs admin policies | P2 | 5d | — |
| **Implementation** | Tax tables: tax_components + tax_obligations | P2 | 1w | — |
| **Migration** | Audit current data for quality | P1 | 2w | — |
| **Migration** | Establish 2026-01-01 cutoff point | P1 | — | — |
| **Migration** | Validate opening balances (CC, cash, etc.) | P1 | 2w | — |

---

**END OF GAP ANALYSIS**

