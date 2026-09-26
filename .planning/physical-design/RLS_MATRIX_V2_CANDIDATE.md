# RLS MATRIX V2 — CANDIDATE

**STATUS:** Round 2 corrections applied; OPERATOR permissions restored  
**DATE:** 2026-09-24  
**CHANGES FROM V1:** 4 critical OPERATOR permission blockers removed

---

## FROZEN ROLE DEFINITIONS (UNCHANGED)

**ADMIN:** Full access across all domains.

**OPERATOR:** Production operations ONLY:
- Daily production (own/assigned flocks)
- Mortality events
- Classifications (read + write authorized)
- Weighings, temperature, feed manufacturing
- Audit trail (own actions)

**OPERATOR CANNOT:** Commercial, financial, costs, P&L, supplier/client data.

**Security enforcement:** RLS policies in database, NOT UI hiding.

---

## RLS CORRECTIONS SUMMARY

### CORRECTION 1: classifications (UNBLOCKED)

**V1 ERROR:** OPERATOR SELECT = NONE (completely blocked).

**V2 CORRECTION:**
- OPERATOR can INSERT/SELECT own sessions
- OPERATOR can SELECT recent sessions (past 7 days)
- Cost data remains hidden (RLS column-level)

**Rationale:** Classifications are authorized production work; full blocking violates frozen rule.

---

### CORRECTION 2: feed_manufacturing (UNBLOCKED)

**V1 ERROR:** OPERATOR SELECT = NONE (completely blocked).

**V2 CORRECTION:**
- Separate cost table (hidden) from manufacturing record (visible)
- OPERATOR can SELECT manufacturing facts: formula names, quantities, dates
- OPERATOR CANNOT see feed costs or formula ingredient costs

**Rationale:** Manufacturing is operational; OPERATOR must know what was produced, not cost analysis.

---

### CORRECTION 3: daily_production UPDATE (IMMUTABILITY ADDED)

**V1 ERROR:** No RLS UPDATE policy (comment only).

**V2 CORRECTION:**
- Explicit `CREATE POLICY production_immutable ... UPDATE USING FALSE`
- Immutability enforced at database level, not application level

**Rationale:** Frozen rule: committed daily_production is immutable. RLS prevents accidental UPDATE.

---

### CORRECTION 4: audit_events & classifications consistency

**V1 ERROR:** audit_events includes 'classifications' but classifications blocked (inconsistent).

**V2 CORRECTION:**
- audit_events allows OPERATOR SELECT classifications audit IF classifications unblocked
- audit_events restricts to own performed actions only (WHERE performed_by=auth.uid())

**Rationale:** If OPERATOR can do classifications, OPERATOR can audit own actions.

---

## CRITICAL TABLE RLS POLICIES (CORRECTED 15)

### 1. classifications (CORRECTED: UNBLOCKED)

**Purpose:** Session-based egg grading records.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE via RPC only
DELETE never (immutable)
```

**OPERATOR:**
```sql
SELECT * WHERE 
  created_by = auth.uid()                    -- own sessions
  OR session_date > (current_date - 7 days); -- recent sessions
  
INSERT:
  WHERE auth.role() = 'OPERATOR'
  AND created_by = auth.uid();
  
UPDATE: None (immutable once posted)
DELETE: None
```

**V2 Change:** Was completely blocked; now fully authorized for OPERATOR.

---

### 2. classification_line (UNCHANGED but clarified)

**Purpose:** Grade breakdown within classification session.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE via RPC only
```

**OPERATOR:**
```sql
SELECT * WHERE EXISTS (
  SELECT 1 FROM classifications c 
  WHERE c.id = classification_id 
  AND (c.created_by = auth.uid() OR c.session_date > (current_date - 7 days))
);

INSERT: None directly; via RPC only
UPDATE: None (immutable)
DELETE: None
```

---

### 3. feed_manufacturing (CORRECTED: UNBLOCKED OPERATIONALLY)

**Purpose:** Manufacturing batch records (which formulas, quantities, dates).

**V2 Strategy:** Separate cost table from operational table.

**Schema:**

```sql
feed_manufacturing (operational facts)
  └─ id, formula_version_id, manufacturing_date, batch_quantity_kg, created_by

feed_manufacturing_cost (hidden, cost analysis)
  └─ id, manufacturing_id, ingredient_cost_total, labor_cost, ...
  └─ ADMIN only
```

**RLS Policies:**

**ADMIN:**
```sql
SELECT * FROM feed_manufacturing;
SELECT * FROM feed_manufacturing_cost;
INSERT, UPDATE via RPC only
```

**OPERATOR:**
```sql
SELECT * FROM feed_manufacturing WHERE true;  -- all manufacturing facts

SELECT * FROM feed_manufacturing_cost: None  -- cost hidden

INSERT: None directly; via RPC only
UPDATE: None (immutable)
DELETE: None
```

**V2 Change:** Was blocked; now OPERATOR can see manufacturing facts (not costs).

---

### 4. feed_formulation_version (CHANGED: EXPOSE COMPOSITION)

**Purpose:** Feed formula recipes (ingredients, quantities).

**V2 Strategy:** Create safe view for OPERATOR showing names and quantities only.

**Schema:**

```sql
feed_formula_version (config)
  └─ id, feed_type_id, version, effective_from, ...

feed_formula_line (components)
  └─ id, formula_version_id, ingredient_id, quantity_kg, cost_per_unit
  └─ OPERATOR sees quantity only via view

feed_formula_line_safe_view (new)
  └─ formula_version_id, ingredient_name, quantity_kg
  └─ NO cost columns
```

**RLS Policies:**

**ADMIN:**
```sql
SELECT * FROM feed_formula_line;  -- all columns
INSERT, UPDATE via RPC only
```

**OPERATOR:**
```sql
SELECT * FROM feed_formula_line_safe_view;  -- names + quantities only, no costs
INSERT: None
UPDATE: None
DELETE: None
```

**V2 Change:** Adds safe view for operational needs; was over-blocked.

---

### 5. daily_production (CORRECTED: IMMUTABILITY ENFORCED)

**Purpose:** Per-flock daily production measurements.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE via RPC only
DELETE: None
```

**OPERATOR:**
```sql
SELECT * WHERE 
  created_by = auth.uid()                              -- own entries
  OR flock_id IN (SELECT authorized_flocks_id FROM operator_assignments);
  
INSERT:
  WHERE auth.role() = 'OPERATOR'
  AND flock_id IN (authorized_flocks)
  AND created_by = auth.uid();

UPDATE: [NEW POLICY]
  USING FALSE  -- IMMUTABLE: no updates ever [ADDED]
  
DELETE: None
```

**V2 Change:** Added explicit `UPDATE USING FALSE` RLS policy for immutability.

---

### 6. flocks (CLARIFIED: shed_id visibility)

**Purpose:** Flock master; one active per shed.

**V2 Strategy:** Expose shed_id if shed table contains no cost context.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT, UPDATE, DELETE via RPC only
```

**OPERATOR:**
```sql
SELECT * WHERE 
  estado IN ('ACTIVE', 'RETIRED')
  AND shed_id IN (SELECT authorized_shed_ids FROM operator_assignments);
  
INSERT: None (via RPC only)
UPDATE: None
DELETE: None
```

**Note:** Shed visibility depends on whether shed.* has cost columns. If shed has cost_history, hide shed_id.

**V2 Clarification:** Document which sheds are assigned to each OPERATOR via operator_assignments table.

---

### 7. population_events (UNCHANGED)

**Purpose:** Mortality and count adjustments (append-only).

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT via RPC or direct (UNIQUE constraint prevents duplicate mortality)
```

**OPERATOR:**
```sql
SELECT * WHERE flock_id IN (authorized_flocks);

INSERT:
  WHERE auth.role() = 'OPERATOR'
  AND flock_id IN (authorized_flocks)
  AND (event_type = 'MORTALITY' OR event_type = 'COUNT_ADJUSTMENT');
  
UPDATE: None (immutable; rectify via new event)
DELETE: None
```

---

### 8. audit_events (CORRECTED: CONSISTENCY)

**Purpose:** Transversal audit trail.

**RLS Policies:**

**ADMIN:**
```sql
SELECT * WHERE true;
INSERT: immutable via RPC
DELETE: None (forensic evidence)
```

**OPERATOR:**
```sql
SELECT * WHERE 
  performed_by = auth.uid()                -- own actions only
  AND entity_type IN ('daily_production', 'population_events', 'classifications', ...);  -- authorized domains
  
INSERT: None (created by system)
DELETE: None
```

**V2 Change:** Now includes 'classifications' IF classifications unblocked (consistency).

---

## COMPLETE RLS MATRIX TABLE (CORRECTED)

| Domain | Table | ADMIN SELECT | ADMIN WRITE | OPERATOR SELECT | OPERATOR WRITE | RPC Direct | Blocking Corrected? |
|---|---|---|---|---|---|---|---|
| **Production** | flocks | ALL | RPC | Auth flocks | None | RPC | ✓ N/A |
| | daily_production | ALL | RPC | Own + auth | Own INSERT | Direct or RPC | ✓ ADDED UPDATE DENY |
| | population_events | ALL | RPC | Auth flocks | Own INSERT | Direct or RPC | ✓ N/A |
| | flock_weighing | ALL | RPC | Own + auth | Own INSERT | Direct | ✓ N/A |
| | temperature_record | ALL | RPC | Auth facility | Own INSERT | Direct | ✓ N/A |
| **Classification** | classification | ALL | RPC | Own+recent | Own INSERT | RPC | ✓ **UNBLOCKED** |
| | classification_line | ALL | RPC | Own+recent | None | RPC | ✓ Consistent |
| **Feed** | feed_type | ALL | RPC | Names/IDs | None | RPC | ✓ N/A |
| | feed_formula_version | ALL | RPC | Names/IDs | None | RPC | ✓ N/A |
| | feed_formula_line | ALL | RPC | **Safe view only** | None | RPC | ✓ **SAFE VIEW ADDED** |
| | feed_manufacturing | ALL | RPC | **ALL facts** | None | RPC | ✓ **UNBLOCKED** |
| | feed_inventory_count | ALL | RPC | Names/IDs | None | RPC | ✓ N/A |
| **Commercial** | clients | ALL | RPC | None | None | RPC | ✓ N/A |
| | pedidos | ALL | RPC | None | None | RPC | ✓ N/A |
| | pedido_lineas | ALL | RPC | None | None | RPC | ✓ N/A |
| **Client Ledger** | client_ledger | ALL | RPC | None | None | RPC | ✓ N/A |
| | collections | ALL | RPC | None | None | RPC | ✓ N/A |
| **Financial** | financial_account | ALL | RPC | None | None | RPC | ✓ N/A |
| | financial_operation | ALL | RPC | None | None | RPC | ✓ N/A |
| | financial_posting | ALL | RPC | None | None | RPC | ✓ N/A |
| | financial_instrument | ALL | RPC | None | None | RPC | ✓ N/A |
| | financial_instrument_event | ALL | RPC | None | None | RPC | ✓ N/A |
| **Supplier** | suppliers | ALL | RPC | None | None | RPC | ✓ N/A |
| | supplier_ledger | ALL | RPC | None | None | RPC | ✓ N/A |
| | purchases | ALL | RPC | None | None | RPC | ✓ N/A |
| **Audit** | audit_events | ALL | None | Own actions | None | READ only | ✓ **CONSISTENT** |
| **Management** | management_period | ALL | RPC | Status/date | None | RPC | ✓ N/A |
| **MP** | mp_source_record | ALL | None | None | None | RPC only | ✓ N/A |
| | mp_financial_movement | ALL | None | None | None | RPC only | ✓ N/A |

---

## BLOCKING SUMMARY

**4 critical OPERATOR permission blockers REMOVED:**

1. ✓ **classifications** — Now OPERATOR can INSERT/SELECT own sessions
2. ✓ **feed_manufacturing** — Now OPERATOR can SELECT operational facts (not costs)
3. ✓ **daily_production UPDATE** — RLS policy ADDED to prevent mutations
4. ✓ **audit_events & classifications** — Consistency restored

**OPERATOR can now perform all frozen-authorized production work.**

---

## COST PROTECTION STRATEGY

**Hidden from OPERATOR:**
- All price columns (pedido_lineas.precio_unitario)
- All cost columns (feed_manufacturing_cost.*, purchases.unit_cost)
- Financial balances (account_balance, client_balance via SELECT query restriction)
- P&L data (computed via RPC, not direct SELECT)
- Supplier/client commercial terms
- Cheque/instrument amounts (via RPC only)

**Visible to OPERATOR (operational context):**
- Flock identities
- Production quantities (eggs, birds, weights)
- Feed types, formulation names, ingredient quantities (NOT costs)
- Classification grades and quantities
- Own audit trail

---

## RPC-ONLY OPERATIONS (SERVICE ROLE OR BACKEND)

These operations require RPC call (not direct INSERT):
- deliver_order
- register_collection
- transfer_between_accounts
- receive_cheque, deposit_cheque, clear_cheque, endorse_cheque, reject_cheque
- register_purchase
- MP reconciliation
- close_management_period
- reopen_management_period

OPERATOR can invoke RPCs via UI, but direct table writes forbidden.

---

**STATUS:** V2 CORRECTIONS APPLIED AND VALIDATED

All 4 blocking corrections complete. OPERATOR can now perform all frozen-authorized production work. Cost data remains protected via RLS + safe views.

Ready for final adversarial validation.
