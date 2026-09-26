# RLS MATRIX V1 — ROUND 1

**STATUS:** Complete security policy design  
**DATE:** 2026-09-24  
**PURPOSE:** Define row-level security boundaries to enforce frozen ADMIN/OPERATOR roles

---

## FROZEN ROLE DEFINITIONS

**ADMIN:** Full management access across all domains.

**OPERATOR:** Production operations ONLY:
- Lotes / flocks
- Daily production
- Mortality events
- Classifications (read aggregates only)
- Weighings
- Feed manufacturing (read-only forward plan via RPC)
- Feed inventory counts
- Temperature records
- Authorized production history

**OPERATOR CANNOT:**
- Clients, Orders, Sales, Commercial prices
- Collections, Client ledger
- Purchases, Expenses, Supplier accounts
- Financial accounts, Transfers, Cheques
- Costs, P&L
- Unauthorized population/productivity data
- Audit trail (except own actions)

**Security:** Must exist in DB/RLS, NOT just UI hiding.

---

## RLS MATRIX TABLE

| Domain/Table | ADMIN SELECT | ADMIN WRITE | OPERATOR SELECT | OPERATOR WRITE | Direct vs RPC | Notes |
|---|---|---|---|---|---|---|
| **flocks** | ALL | ALL (lifecycle via RPC) | Authorized flocks + metadata | None | RPC for ACTIVE creation | Shed ID hidden from OPERATOR |
| **daily_production** | ALL | ALL (RPC: rectify) | Own entries + authorized flocks | Own insert | DIRECT (INSERT) or RPC | RLS: WHERE created_by=auth.uid() OR assigned_flock |
| **population_events (mortality)** | ALL | ALL (RPC: rectify) | Own entries + authorized flocks | Own insert | DIRECT (INSERT own) or RPC | UNIQUE constraint enforced |
| **flock_weighings** | ALL | ALL (RPC: rectify) | Own entries + authorized flocks | Own insert | DIRECT (INSERT own) | RLS scoped |
| **temperature_records** | ALL | ALL | Own facility + authorized | Own insert | DIRECT (INSERT own) | RLS scoped |
| **classifications** | ALL | ALL (RPC: post) | None (dashboard via RPC only) | None | RPC aggregates only | Cost data hidden |
| **classification_lines** | ALL | ALL (via RPC) | None | None | RPC only | Immutable once session posted |
| **feed_types** | ALL | ALL (master config) | View available (names/IDs) | None | RPC read-only discovery | No cost exposure |
| **feed_formulation_version** | ALL | ALL (config) | View available versions (names/IDs only) | None | RPC read-only (no costs) | Cost data hidden |
| **feed_manufacturing** | ALL | ALL (RPC: post) | None (forward plan via RPC only) | None | RPC only | Cost data, formula versions hidden |
| **feed_inventory_count** | ALL | ALL | None | None | RPC only (summary aggregates) | Quantities exposed via safe RPC |
| **clients** | ALL | ALL (RPC: register) | None | None | RPC only (via collection register) | Commercial data blocked |
| **pedidos** | ALL | ALL (RPC: deliver/rectify) | None | None | RPC only (aggregates at app level) | All order data blocked |
| **pedido_lineas** | ALL | ALL (RPC) | None | None | RPC only | Prices blocked |
| **client_ledger** | ALL | ALL (RPC: collection register) | None | None | RPC only (SERVICE ROLE) | CC data immutable |
| **collections** | ALL | ALL (RPC: register) | None | None | RPC only (SERVICE ROLE) | Payments handled by backend |
| **financial_postings** | ALL | ALL (RPC: operation) | None | None | RPC only (SERVICE ROLE) | Cash hidden |
| **financial_account** | ALL | ALL (config) | None | None | RPC only (read account names) | Balance hidden |
| **financial_operation** | ALL | ALL (RPC) | None | None | RPC only (SERVICE ROLE) | Transfers hidden |
| **financial_instrument** | ALL | ALL (RPC: lifecycle) | None | None | RPC only (SERVICE ROLE) | Cheque data hidden |
| **financial_instrument_event** | ALL | ALL (RPC) | None | None | RPC only | State transitions hidden |
| **suppliers** | ALL | ALL | None | None | RPC only | Commercial hidden |
| **supplier_ledger** | ALL | ALL (RPC) | None | None | RPC only (SERVICE ROLE) | Supplier debt hidden |
| **purchases** | ALL | ALL (RPC) | None | None | RPC only (SERVICE ROLE) | Cost structure hidden |
| **freight** | ALL | ALL | None | None | RPC only | Logistics costs hidden |
| **projects** | ALL | ALL | None (if authorized) | None | RPC only | Project allocation hidden |
| **audit_events** | ALL | None (immutable) | Own actions only (WHERE performed_by=auth.uid() AND entity_type IN allowed) | None | READ only for OPERATOR own actions | Audit trail selectively visible |
| **management_periods** | ALL | ALL (RPC: close/reopen) | Status/date only via RPC | None | RPC only (dashboard) | Closure details hidden |
| **mp_source_record** | ALL | None (immutable) | None | None | RPC only (SERVICE ROLE) | Raw MP data protected |
| **mp_financial_movement** | ALL | None (immutable) | None | None | RPC only (SERVICE ROLE) | MP movements protected |

---

## TABLE-BY-TABLE RLS POLICIES (CRITICAL 15)

### 1. flocks

**Purpose:** Flock master; one active per shed.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;                    -- all rows
INSERT, UPDATE, DELETE via RPC only     -- controlled lifecycle
```

**OPERATOR:**
```sql
SELECT * WHERE 
  (estado = 'ACTIVE' OR estado = 'RETIRED') 
  AND shed_id IN (SELECT authorized_shed_ids FROM operator_assignments);
  
INSERT, UPDATE: None directly (via RPC only)
DELETE: None
```

**Risk if permissive:** OPERATOR queries flocks, joins to shed (has cost_history context) → cost inference.

**Mitigation:** Exclude shed.cost_* fields from OPERATOR SELECT; use RPC for authorization checks.

---

### 2. daily_production

**Purpose:** Per-flock production measurements.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE, DELETE via RPC only
```

**OPERATOR:**
```sql
SELECT * WHERE 
  created_by = auth.uid()                                    -- own entries
  OR flock_id IN (SELECT authorized_flocks FROM assignments); -- authorized
  
INSERT: 
  WHERE auth.role() = 'OPERATOR' 
  AND flock_id IN (authorized_flocks)
  AND created_by = auth.uid();
  
UPDATE: None (immutable after posting)
DELETE: None
```

**Risk if permissive:** OPERATOR sees all flocks' production → infers comparative yield/performance.

**Mitigation:** RLS restricts to assigned flocks + own entries; dashboard aggregates via controlled RPC.

---

### 3. population_events (mortality)

**Purpose:** Population changes; unique per (flock, date).

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE via RPC only; DELETE never
```

**OPERATOR:**
```sql
SELECT * WHERE 
  created_by = auth.uid()
  OR flock_id IN (authorized_flocks);
  
INSERT: 
  WHERE flock_id IN (authorized_flocks)
  AND created_by = auth.uid();
  
UPDATE: None (immutable; rectify via RPC only)
DELETE: None
```

**Risk if permissive:** OPERATOR sees all flock mortality → infers health/genetics quality.

**Mitigation:** RLS scopes to authorized flocks + own entries.

---

### 4. classifications

**Purpose:** Yield grading; session-based (no flock traceability).

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE via RPC only
```

**OPERATOR:**
```sql
SELECT: None (BLOCKED)
  -- Grades are commercial/pricing sensitive
  -- Visibility only via aggregated RPC: "Total yield: X XL, Y N1, Z N2 ..."
  
INSERT, UPDATE, DELETE: None
```

**Risk if permissive:** OPERATOR sees daily yield by grade → infers profitability/pricing.

**Mitigation:** Complete SELECT block; safe RPC exposes only aggregates (by day/week, not per-session detail).

---

### 5. feed_manufacturing

**Purpose:** Feed batch recipes, costs, formulation versions.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE via RPC only
```

**OPERATOR:**
```sql
SELECT: None (BLOCKED)
  -- Cost data embedded; formula versions with ingredients
  
-- Access via RPC:
RPC get_available_formulations()
  → returns [{ id, name, version }] WITHOUT ingredient costs
  
RPC get_flock_theoretical_consumption(flock_id)
  → returns quantity estimate (no feed cost)
  
INSERT, UPDATE, DELETE: None
```

**Risk if permissive:** OPERATOR learns ingredient costs → reverse-engineers profitability.

**Mitigation:** Complete SELECT block; RPC exposes only formulation names + theoretical consumption.

---

### 6. clients

**Purpose:** Customer master; commercial entity.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE, DELETE via RPC only
```

**OPERATOR:**
```sql
SELECT: None (BLOCKED)
DELETE: None
INSERT, UPDATE: None (via RPC if authorized)
```

**Risk if permissive:** OPERATOR sees client credit lines → infers commercial sensitivity / pricing.

**Mitigation:** Complete SELECT block.

---

### 7. pedidos

**Purpose:** Sales orders; economic facts.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE via RPC only; DELETE never
```

**OPERATOR:**
```sql
SELECT: None (BLOCKED)
INSERT, UPDATE, DELETE: None (via RPC for authorized operations only)
```

**Risk if permissive:** OPERATOR sees order totals, client names, pricing → commercial espionage.

**Mitigation:** Complete SELECT block; RPC only.

---

### 8. pedido_lineas

**Purpose:** Order line items with price snapshot.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE via RPC only
```

**OPERATOR:**
```sql
SELECT: None (BLOCKED)
  -- Prices embedded; commercial details
  
INSERT, UPDATE, DELETE: None
```

**Risk if permissive:** OPERATOR infers price discrimination + margin structure.

**Mitigation:** Complete SELECT block; NEVER expose via any API.

---

### 9. client_ledger

**Purpose:** Immutable CC movements; audit trail.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE: None (immutable, only via RPC);
DELETE: None
```

**OPERATOR:**
```sql
SELECT: None (BLOCKED)
  -- Implies client financial data / payment history
  
INSERT, UPDATE, DELETE: None
```

**Risk if permissive:** OPERATOR infers client debt, payment patterns, defaults.

**Mitigation:** Complete SELECT block; service-role RPC only for collection register.

---

### 10. collections

**Purpose:** Payment receipts (cash, cheque, transfer, etc.).

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT via RPC only; UPDATE/DELETE never
```

**OPERATOR:**
```sql
SELECT: None (BLOCKED)
INSERT: None (via backend RPC only)
UPDATE, DELETE: None
```

**Risk if permissive:** OPERATOR sees payment amounts, methods, timing → infers cash flow.

**Mitigation:** Complete SELECT block; backend RPC (service role) only.

---

### 11. financial_postings

**Purpose:** Cash account movements.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE: None (immutable, via RPC only);
DELETE: None
```

**OPERATOR:**
```sql
SELECT: None (BLOCKED)
  -- Reveals account balances, cash reserves, liquidity
  
INSERT, UPDATE, DELETE: None
```

**Risk if permissive:** OPERATOR learns cash reserves, knows when to embezzle, predicts cash shortages.

**Mitigation:** Complete SELECT block; dashboard cash visibility via controlled RPC (ADMIN only).

---

### 12. financial_instrument

**Purpose:** Cheques / eCheques state machine.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
UPDATE via RPC (state transitions); DELETE never
```

**OPERATOR:**
```sql
SELECT: None (BLOCKED)
INSERT, UPDATE, DELETE: None
```

**Risk if permissive:** OPERATOR learns cheque volumes, clearing timing, fraud patterns.

**Mitigation:** Complete SELECT block; service-role RPC only.

---

### 13. audit_events

**Purpose:** Transversal audit trail (who changed what, when, why).

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;  -- full audit visibility
INSERT, UPDATE, DELETE: None (immutable)
```

**OPERATOR:**
```sql
SELECT * WHERE 
  performed_by = auth.uid()                   -- own actions only
  AND entity_type IN (
    'daily_production',
    'population_events',
    'flock_weighings',
    'temperature_records',
    'classification'  -- if OPERATOR can classify
  );
  
  -- BLOCKED entities for OPERATOR:
  -- 'pedidos', 'client_ledger', 'financial_postings', 'collections'
  
INSERT, UPDATE, DELETE: None (via SECURITY DEFINER only)
```

**Risk if permissive:** OPERATOR sees admin financial corrections, policy changes, all commercial events.

**Mitigation:** Granular RLS filter; OPERATOR sees only entity_types in allowed list + own performed_by.

---

### 14. management_periods

**Purpose:** Period open/closed status.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE (status, close_reason) via RPC only;
DELETE: None
```

**OPERATOR:**
```sql
SELECT * WHERE status  -- can see current period status
  OR period_date >= CURRENT_DATE - INTERVAL '90 days';
  -- read-only visibility of recent/current period
  
INSERT, UPDATE, DELETE: None
```

**Risk if permissive:** Minimal (period status is low-sensitivity).

**Mitigation:** RLS allows read-only access; updates via RPC (ADMIN only).

---

### 15. audit_events (Audit itself)

**Purpose:** Change tracking on audit_events (meta-audit).

**RLS Policies:**

**Immutable:** No UPDATE/DELETE on audit_events (enforced by CHECK + TRIGGER, not RLS).

**INSERT:** SECURITY DEFINER trigger only (cannot be called directly).

---

## INFORMATION LEAKAGE SCENARIOS & SOLUTIONS

### 1. Cost Leakage via Flock Joins

**Scenario:**
```sql
-- OPERATOR tries:
SELECT f.lote_id_text, f.cost_per_bird, p.production_date, SUM(p.eggs_total)
FROM flocks f
LEFT JOIN daily_production p ON f.id = p.flock_id
GROUP BY f.lote_id_text, f.cost_per_bird, p.production_date
```

**Attack:** OPERATOR deduces flock acquisition cost by correlating production output + maintenance cost.

**Prevention:**
- Remove cost fields from flocks table (move to separate cost_allocation table, ADMIN only)
- RLS blocks OPERATOR access to cost_allocation
- RPC calculates theoretical consumption (from population + curve, not cost)

---

### 2. Commercial Price Leakage

**Scenario:**
```sql
-- OPERATOR tries (even if pedidos blocked):
SELECT o.cliente_id, ol.precio_unitario, ol.cantidad
FROM pedido_lineas ol
INNER JOIN pedidos o ON ol.pedido_id = o.id
```

**Attack:** OPERATOR learns client prices (negotiated rates).

**Prevention:**
- pedido_lineas RLS: OPERATOR SELECT = NONE
- pedidos RLS: OPERATOR SELECT = NONE
- Dual enforcement: RLS + no API endpoint exposes order prices to OPERATOR

---

### 3. Feed Cost Leakage

**Scenario:**
```sql
-- OPERATOR tries:
SELECT f.formula_id, fi.ingredient_id, fi.cost_per_unit * fi.quantity_per_unit AS ingredient_cost
FROM feed_formula_version f
INNER JOIN formula_ingredient fi ON f.id = fi.formula_version_id
WHERE f.formula_id IN (SELECT formula_id FROM flock_assignments WHERE flock_id IN (...))
```

**Attack:** OPERATOR reverse-engineers ingredient costs + formula profitability.

**Prevention:**
- feed_formula_version RLS: OPERATOR SELECT = NONE (names only via RPC)
- formula_ingredient RLS: OPERATOR SELECT = NONE
- RPC get_available_formulations() returns [{ id, name }] only; no ingredient detail

---

### 4. Supplier Ledger Leakage

**Scenario:**
```sql
-- OPERATOR tries:
SELECT s.nombre, SUM(sl.signed_amount) AS balance
FROM supplier_ledger sl
INNER JOIN suppliers s ON sl.supplier_id = s.id
GROUP BY s.nombre
```

**Attack:** OPERATOR learns supplier payment terms / outstanding debt.

**Prevention:**
- suppliers RLS: OPERATOR SELECT = NONE
- supplier_ledger RLS: OPERATOR SELECT = NONE
- Purchases not visible to OPERATOR

---

### 5. Financial Account Balance Leakage

**Scenario:**
```sql
-- OPERATOR tries (if financial_postings RLS weak):
SELECT account_id, SUM(signed_amount) as balance
FROM financial_postings
GROUP BY account_id
```

**Attack:** OPERATOR learns cash reserves, liquidity state.

**Prevention:**
- financial_postings RLS: OPERATOR SELECT = NONE
- Dashboard cash visibility: ADMIN only via controlled RPC
- RPC get_cash_position() requires ADMIN role

---

### 6. Audit Trail Forensics

**Scenario:**
```sql
-- OPERATOR tries:
SELECT * FROM audit_events
WHERE entity_type = 'client_ledger'
ORDER BY performed_at DESC
```

**Attack:** OPERATOR sees financial corrections, cheque rejections, fraud investigations.

**Prevention:**
- audit_events RLS: OPERATOR SELECT only WHERE performed_by=auth.uid() AND entity_type IN allowed_list
- Blocked entity_types: pedidos, client_ledger, financial_postings, collections, suppliers, purchases, etc.
- OPERATOR sees only own production/classification audit

---

## SECURITY AUDIT FINDINGS (CURRENT IMPLEMENTATION)

### CRITICAL GAPS FOUND

1. **⚠️ No OPERATOR role in schema**
   - Current: `rol_type` enum (dueño, repartidor) defined
   - Target: ADMIN, OPERATOR required
   - **ACTION:** Add OPERATOR to enum; update RLS functions

2. **⚠️ Production tables have NO RLS enabled**
   - Current: lotes, producciones, recuentos_lote, temperature_records exist but NO RLS policies
   - Target: RLS with OPERATOR scoping
   - **ACTION:** Deploy RLS on all production tables

3. **⚠️ Classification tables missing**
   - Current: NO classifications, classification_lines tables
   - Target: Session-based classification (immutable)
   - **ACTION:** Create tables + RLS

4. **⚠️ Feed tables missing**
   - Current: NO feed_*, formula_* tables
   - Target: Feed formulations, manufacturing, inventory
   - **ACTION:** Create tables + restrict OPERATOR access

5. **⚠️ Financial postings lack immutability enforcement**
   - Current: RLS allows UPDATE (via RPC); should be append-only
   - Target: APPEND_ONLY immutable
   - **ACTION:** Remove UPDATE policy; INSERT only via service-role RPC

6. **⚠️ No audit_events table**
   - Current: Partial audit via timestamps; no transversal audit_events
   - Target: APPEND_ONLY audit_events with RLS
   - **ACTION:** Create table + SECURITY DEFINER audit trigger

---

## RPC GATES (SERVICE-ROLE ONLY)

Operations that MUST execute as `service_role` (backend), NEVER by client/OPERATOR:

1. **MP reconciliation** — External data validation; atomic N:N matching
2. **Collection register** — Multi-table atomic: collection + client_ledger + instrument
3. **Rectify sale** — Compensating GL entries + audit
4. **Close/reopen management_period** — System-wide integral closure
5. **Cheque state transitions** — Instrument state + ledger consequences
6. **Transfer between accounts** — Atomic dual-posting
7. **Financial adjustment** — Operation + posting + audit
8. **Fiscal invoice generation** — Links economic + tax + compliance
9. **Feed cost allocation** — Inventory equation; month-closed protection
10. **Supplier payment register** — Supplier ledger + financial posting

---

## OPEN QUESTIONS (RLS SPECIFICS)

**Q1:** Should OPERATOR ever view classification aggregates (e.g., "Today: 500 XL, 300 N1")? Or complete blindness to grades?

**A1 (Recommendation):** Yes, aggregate view allowed via RPC. Operators need feedback on session yield to adjust process. Block individual session detail (cost/pricing sensitive).

**Q2:** Can OPERATOR see theoretical feed consumption (productivity metric)?

**A2 (Recommendation):** Yes; expose via safe RPC. Separated from actual costs. Helps operators understand dietary efficiency.

**Q3:** Flock "shed ID" — expose or hide?

**A3 (Recommendation):** Expose flock_name + production_date; hide shed_id if it carries cost context. Use authorization table (operator_assignments) for shed access control.

---

**Status:** Ready for RLS implementation. All policies defined; no conflicting requirements with frozen architecture.
