# RLS POLICY SPECIFICATION V1

**STATUS:** Specification  
**DATE:** 2026-09-24  
**BASIS:** TARGET_ARCHITECTURE_V2_FROZEN.md + RLS_MATRIX_V2_CANDIDATE.md  

---

## OVERVIEW

This document specifies Supabase RLS (Row-Level Security) policies for all ~35 tables in Granja Santo Tomás.

**Role Definitions (Frozen):**
- **ADMIN:** Full access; write via RPC only (immutability enforced)
- **OPERATOR:** Production operations only (daily_production, mortality, classifications, weighings, temperature, feed_manufacturing, authorized flocks)
- **SERVICE_ROLE:** Backend service for MP reconciliation, period closure, advanced financial operations
- **PUBLIC:** Minimal/none (reserved for future auth integration)

**Key Principles:**
1. Immutable facts committed to database never silently UPDATE/DELETE
2. Cost data NEVER visible to OPERATOR (column-level RLS + safe views)
3. Ownership-based access via `created_by = auth.uid()`
4. Assignment-based access via `operator_assignments` table
5. Direct INSERT allowed ONLY for single-user append-only operations with RLS WHERE clause
6. Complex multi-table operations via RPC (backend enforces atomicity)

**Security Boundaries:**
- RLS enforces row-level access control; business logic (period closure, duplicate prevention) in RPC
- Views used for cost-hiding (e.g., feed_formula_line_safe_view)
- No privilege escalation: OPERATOR cannot invoke admin RPCs

---

## TABLE 1: flocks

**Purpose:** Flock (lote) master; one active per shed.

**Ownership:** None (system master). Visibility via operator_assignments.

**RLS Policies:**

```sql
-- ADMIN SELECT: all flocks
CREATE POLICY "flocks_admin_select"
  ON flocks FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- ADMIN INSERT/UPDATE/DELETE via RPC only (no direct write)
-- [Application enforces RPC-only; RLS not required]

-- OPERATOR SELECT: authorized flocks only
CREATE POLICY "flocks_operator_select"
  ON flocks FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND id IN (
      SELECT flock_id FROM operator_assignments 
      WHERE operator_id = auth.uid() 
      AND assignment_status = 'ACTIVE'
    )
  );

-- OPERATOR cannot insert/update/delete
CREATE POLICY "flocks_operator_deny_write"
  ON flocks FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "flocks_operator_deny_update"
  ON flocks FOR UPDATE
  USING (FALSE);

CREATE POLICY "flocks_operator_deny_delete"
  ON flocks FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Shed visibility depends on `operator_assignments`. Sheds table should NOT be directly queried by OPERATOR; if needed, expose via VIEW on assigned flocks.
- If shed has cost_history columns, do NOT expose shed_id to OPERATOR.

---

## TABLE 2: daily_production

**Purpose:** Per-flock daily egg production measurements.

**Ownership:** `created_by` (OPERATOR records own production).

**Immutability:** Once posted, NEVER updateable (RLS enforced).

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "daily_production_admin_select"
  ON daily_production FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- ADMIN INSERT: via RPC only (application layer)
-- [Atomic, transactional, includes population_events validation]

-- OPERATOR SELECT: own + assigned flocks
CREATE POLICY "daily_production_operator_select"
  ON daily_production FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND (
      created_by = auth.uid()
      OR flock_id IN (
        SELECT flock_id FROM operator_assignments
        WHERE operator_id = auth.uid()
        AND assignment_status = 'ACTIVE'
      )
    )
  );

-- OPERATOR INSERT: own entries only (direct allowed; RLS enforces ownership)
CREATE POLICY "daily_production_operator_insert"
  ON daily_production FOR INSERT
  WITH CHECK (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND created_by = auth.uid()
    AND flock_id IN (
      SELECT flock_id FROM operator_assignments
      WHERE operator_id = auth.uid()
      AND assignment_status = 'ACTIVE'
    )
  );

-- IMMUTABLE: no updates ever
CREATE POLICY "daily_production_immutable"
  ON daily_production FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "daily_production_no_delete"
  ON daily_production FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- `production_date` determines period assignment (not `created_at`).
- Unique constraint: `(flock_id, production_date)` — duplicates rejected.
- No rectification via UPDATE; corrections via new production_event table (future).
- Immutability enforced at RLS; application cannot circumvent.

---

## TABLE 3: population_events

**Purpose:** Mortality and count adjustment events (append-only).

**Ownership:** `created_by` (OPERATOR records own events).

**Immutability:** Append-only; corrections via new event + audit.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "population_events_admin_select"
  ON population_events FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- ADMIN INSERT: via RPC (atomicity; UNIQUE enforcement on mortality)

-- OPERATOR SELECT: assigned flocks only
CREATE POLICY "population_events_operator_select"
  ON population_events FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND flock_id IN (
      SELECT flock_id FROM operator_assignments
      WHERE operator_id = auth.uid()
      AND assignment_status = 'ACTIVE'
    )
  );

-- OPERATOR INSERT: direct (RLS allows; UNIQUE constraint prevents duplicates)
CREATE POLICY "population_events_operator_insert"
  ON population_events FOR INSERT
  WITH CHECK (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND created_by = auth.uid()
    AND flock_id IN (
      SELECT flock_id FROM operator_assignments
      WHERE operator_id = auth.uid()
      AND assignment_status = 'ACTIVE'
    )
    AND event_type IN ('MORTALITY', 'COUNT_ADJUSTMENT')
  );

-- IMMUTABLE: no updates
CREATE POLICY "population_events_immutable"
  ON population_events FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "population_events_no_delete"
  ON population_events FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- **Constraint:** `UNIQUE (flock_id, event_date, event_type)` for MORTALITY events only. COUNT_ADJUSTMENT allows multiple per day.
- Duplicate MORTALITY detection: DB rejects silently; app informs operator of existing value.
- Rectification: INSERT new event (COUNT_ADJUSTMENT) with opposite delta or RECTIFICATION type.

---

## TABLE 4: flock_weighing

**Purpose:** Flock weighing samples (weight, count, date).

**Ownership:** `created_by`.

**Immutability:** Append-only.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "flock_weighing_admin_select"
  ON flock_weighing FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: own + assigned flocks
CREATE POLICY "flock_weighing_operator_select"
  ON flock_weighing FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND (
      created_by = auth.uid()
      OR flock_id IN (
        SELECT flock_id FROM operator_assignments
        WHERE operator_id = auth.uid()
        AND assignment_status = 'ACTIVE'
      )
    )
  );

-- OPERATOR INSERT: own entries
CREATE POLICY "flock_weighing_operator_insert"
  ON flock_weighing FOR INSERT
  WITH CHECK (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND created_by = auth.uid()
    AND flock_id IN (
      SELECT flock_id FROM operator_assignments
      WHERE operator_id = auth.uid()
      AND assignment_status = 'ACTIVE'
    )
  );

-- IMMUTABLE: no updates
CREATE POLICY "flock_weighing_immutable"
  ON flock_weighing FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "flock_weighing_no_delete"
  ON flock_weighing FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Multiple weighing records per flock allowed (sampling events).
- `weighing_date` determines period.

---

## TABLE 5: temperature_record

**Purpose:** Temperature measurements (recría/facility monitoring).

**Ownership:** `created_by`.

**Immutability:** Append-only.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "temperature_record_admin_select"
  ON temperature_record FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: assigned facilities only
CREATE POLICY "temperature_record_operator_select"
  ON temperature_record FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND facility_id IN (
      SELECT DISTINCT shed_id FROM operator_assignments
      WHERE operator_id = auth.uid()
      AND assignment_status = 'ACTIVE'
    )
  );

-- OPERATOR INSERT: own entries (assigned facility)
CREATE POLICY "temperature_record_operator_insert"
  ON temperature_record FOR INSERT
  WITH CHECK (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND created_by = auth.uid()
    AND facility_id IN (
      SELECT DISTINCT shed_id FROM operator_assignments
      WHERE operator_id = auth.uid()
      AND assignment_status = 'ACTIVE'
    )
  );

-- IMMUTABLE: no updates
CREATE POLICY "temperature_record_immutable"
  ON temperature_record FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "temperature_record_no_delete"
  ON temperature_record FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Facility_id = shed_id (temperature monitoring per physical location).
- Timestamp records precise measurement time.

---

## TABLE 6: classification

**Purpose:** Egg grading session (date, operator, grades produced).

**Ownership:** `created_by`.

**Immutability:** Append-only; no direct UPDATE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "classification_admin_select"
  ON classification FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: own sessions + recent (past 7 days)
CREATE POLICY "classification_operator_select"
  ON classification FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND (
      created_by = auth.uid()
      OR classification_date > (CURRENT_DATE - 7)
    )
  );

-- OPERATOR INSERT: own sessions (direct)
CREATE POLICY "classification_operator_insert"
  ON classification FOR INSERT
  WITH CHECK (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND created_by = auth.uid()
  );

-- IMMUTABLE: no updates
CREATE POLICY "classification_immutable"
  ON classification FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "classification_no_delete"
  ON classification FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- `classification_date` determines period.
- Multiple sessions per day allowed (morning/afternoon batches).
- Do NOT link to specific flocks (eggs mix; no traceability).
- V2 Correction: OPERATOR fully authorized (was incorrectly blocked in V1).

---

## TABLE 7: classification_line

**Purpose:** Grade breakdown within classification (XL, N1, N2, N3, Rotos, Sucios, Descarte).

**Ownership:** Via parent classification.

**Immutability:** Append-only.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "classification_line_admin_select"
  ON classification_line FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: via parent classification (own or recent)
CREATE POLICY "classification_line_operator_select"
  ON classification_line FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND classification_id IN (
      SELECT id FROM classification
      WHERE created_by = auth.uid()
      OR classification_date > (CURRENT_DATE - 7)
    )
  );

-- OPERATOR INSERT: none (via RPC only)
CREATE POLICY "classification_line_operator_deny_insert"
  ON classification_line FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "classification_line_immutable"
  ON classification_line FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "classification_line_no_delete"
  ON classification_line FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- INSERT via RPC only (ensures consistency with parent classification).
- Each grade appears once per session (unique grade per session).

---

## TABLE 8: classification_grade

**Purpose:** Lookup table: grade names (XL, N1, N2, N3, Rotos, Sucios, Descarte).

**Ownership:** None (system master).

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "classification_grade_admin_select"
  ON classification_grade FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: all (lookup; no write)
CREATE POLICY "classification_grade_operator_select"
  ON classification_grade FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR');

-- ADMIN ONLY: insert/update/delete (via RPC)
CREATE POLICY "classification_grade_operator_deny_write"
  ON classification_grade FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "classification_grade_operator_deny_update"
  ON classification_grade FOR UPDATE
  USING (FALSE);

CREATE POLICY "classification_grade_operator_deny_delete"
  ON classification_grade FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Read-only lookup table; no cost data.

---

## TABLE 9: feed_type

**Purpose:** Feed type master (names, descriptions).

**Ownership:** None (system master).

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "feed_type_admin_select"
  ON feed_type FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: names/IDs only (no costs)
CREATE POLICY "feed_type_operator_select"
  ON feed_type FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR');

-- OPERATOR cannot write
CREATE POLICY "feed_type_operator_deny_write"
  ON feed_type FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "feed_type_operator_deny_update"
  ON feed_type FOR UPDATE
  USING (FALSE);

CREATE POLICY "feed_type_operator_deny_delete"
  ON feed_type FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Lookup table; OPERATOR needs visibility for manufacturing records.

---

## TABLE 10: feed_ingredient

**Purpose:** Feed ingredient master (maize, soy, minerals, etc.).

**Ownership:** None (system master).

**RLS Policies:**

```sql
-- ADMIN SELECT: all (including costs)
CREATE POLICY "feed_ingredient_admin_select"
  ON feed_ingredient FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: names/IDs only (no costs, sourcing, prices)
CREATE POLICY "feed_ingredient_operator_select"
  ON feed_ingredient FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR');

-- OPERATOR cannot write
CREATE POLICY "feed_ingredient_operator_deny_write"
  ON feed_ingredient FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "feed_ingredient_operator_deny_update"
  ON feed_ingredient FOR UPDATE
  USING (FALSE);

CREATE POLICY "feed_ingredient_operator_deny_delete"
  ON feed_ingredient FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- If feed_ingredient contains cost/sourcing columns, use column-level RLS or separate table.

---

## TABLE 11: feed_formula_version

**Purpose:** Immutable feed formulation (recipe) versions.

**Ownership:** None (system master).

**Immutability:** Once created, NEVER updated (version-based only).

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "feed_formula_version_admin_select"
  ON feed_formula_version FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: names/IDs only (no costs, effective_date logic)
CREATE POLICY "feed_formula_version_operator_select"
  ON feed_formula_version FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR');

-- OPERATOR cannot write
CREATE POLICY "feed_formula_version_operator_deny_write"
  ON feed_formula_version FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "feed_formula_version_operator_deny_update"
  ON feed_formula_version FOR UPDATE
  USING (FALSE);

CREATE POLICY "feed_formula_version_operator_deny_delete"
  ON feed_formula_version FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Versions are immutable; new formula = new version.
- OPERATOR cannot determine which version is "current"; application manages.

---

## TABLE 12: feed_formula_line

**Purpose:** Formula component lines (ingredient + quantity + cost).

**Ownership:** Via parent feed_formula_version.

**Strategy:** OPERATOR sees safe view only (no costs).

**RLS Policies:**

```sql
-- ADMIN SELECT: all (including cost_per_unit)
CREATE POLICY "feed_formula_line_admin_select"
  ON feed_formula_line FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: use safe view instead (see below)
-- Direct table access denied
CREATE POLICY "feed_formula_line_operator_deny_select"
  ON feed_formula_line FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "feed_formula_line_operator_deny_write"
  ON feed_formula_line FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "feed_formula_line_operator_deny_update"
  ON feed_formula_line FOR UPDATE
  USING (FALSE);

CREATE POLICY "feed_formula_line_operator_deny_delete"
  ON feed_formula_line FOR DELETE
  USING (FALSE);
```

**Safe View for OPERATOR:**

```sql
CREATE VIEW feed_formula_line_safe AS
  SELECT
    f.id,
    f.formula_version_id,
    i.id as ingredient_id,
    i.name as ingredient_name,
    f.quantity_kg
    -- NO cost_per_unit, total_cost, etc.
  FROM feed_formula_line f
  JOIN feed_ingredient i ON f.ingredient_id = i.id;

-- OPERATOR SELECT via view
CREATE POLICY "feed_formula_line_safe_view_operator_select"
  ON feed_formula_line_safe FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR');
```

**CRITICAL NOTES:**
- V2 Correction: OPERATOR needs to know formula composition (quantities) for manufacturing verification.
- Cost columns NEVER exposed to OPERATOR.

---

## TABLE 13: feed_manufacturing

**Purpose:** Manufacturing batch records (what was produced, when, how much).

**Ownership:** `created_by` (operator records batch).

**Strategy:** Separate cost table; manufacturing table = operational facts only.

**RLS Policies (feed_manufacturing — operational):**

```sql
-- ADMIN SELECT: all
CREATE POLICY "feed_manufacturing_admin_select"
  ON feed_manufacturing FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: all manufacturing facts (no costs)
CREATE POLICY "feed_manufacturing_operator_select"
  ON feed_manufacturing FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR');

-- OPERATOR INSERT: none (via RPC only)
CREATE POLICY "feed_manufacturing_operator_deny_insert"
  ON feed_manufacturing FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "feed_manufacturing_immutable"
  ON feed_manufacturing FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "feed_manufacturing_no_delete"
  ON feed_manufacturing FOR DELETE
  USING (FALSE);
```

**RLS Policies (feed_manufacturing_cost — hidden):**

```sql
-- ADMIN SELECT: all
CREATE POLICY "feed_manufacturing_cost_admin_select"
  ON feed_manufacturing_cost FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "feed_manufacturing_cost_operator_deny_all"
  ON feed_manufacturing_cost FOR SELECT
  USING (FALSE);
```

**CRITICAL NOTES:**
- V2 Correction: OPERATOR needs to see manufacturing facts (not costs).
- `manufacturing_date` determines period.
- Separate cost table ensures cost protection.

---

## TABLE 14: feed_inventory_count

**Purpose:** Physical feed count records (stock-on-hand snapshots).

**Ownership:** `created_by`.

**Immutability:** Append-only.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "feed_inventory_count_admin_select"
  ON feed_inventory_count FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: none (via RPC aggregates for operational need)
CREATE POLICY "feed_inventory_count_operator_deny_select"
  ON feed_inventory_count FOR SELECT
  USING (FALSE);

-- OPERATOR INSERT: none (via RPC only)
CREATE POLICY "feed_inventory_count_operator_deny_insert"
  ON feed_inventory_count FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "feed_inventory_count_immutable"
  ON feed_inventory_count FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "feed_inventory_count_no_delete"
  ON feed_inventory_count FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- OPERATOR inserts via RPC (backend validates, records count atomically).
- RPC returns aggregated summary; OPERATOR never sees raw cost data.

---

## TABLE 15: clients

**Purpose:** Customer master (name, contact, tax ID, credit status).

**Ownership:** None (system master).

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "clients_admin_select"
  ON clients FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "clients_operator_deny_all"
  ON clients FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "clients_operator_deny_write"
  ON clients FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "clients_operator_deny_update"
  ON clients FOR UPDATE
  USING (FALSE);

CREATE POLICY "clients_operator_deny_delete"
  ON clients FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Commercial domain; fully restricted from OPERATOR.

---

## TABLE 16: pedidos (Orders)

**Purpose:** Sales orders (PENDING → DELIVERED → CANCELLED).

**Ownership:** System (created via RPC: deliver_order, etc.).

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "pedidos_admin_select"
  ON pedidos FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "pedidos_operator_deny_all"
  ON pedidos FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "pedidos_operator_deny_write"
  ON pedidos FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "pedidos_operator_deny_update"
  ON pedidos FOR UPDATE
  USING (FALSE);

CREATE POLICY "pedidos_operator_deny_delete"
  ON pedidos FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Economic domain; fully restricted.

---

## TABLE 17: pedido_lineas (Order Lines)

**Purpose:** Per-line items (product, quantity, price used at order time).

**Ownership:** Via parent pedido.

**Restriction:** OPERATOR sees NONE (includes price data).

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "pedido_lineas_admin_select"
  ON pedido_lineas FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "pedido_lineas_operator_deny_all"
  ON pedido_lineas FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "pedido_lineas_operator_deny_write"
  ON pedido_lineas FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "pedido_lineas_operator_deny_update"
  ON pedido_lineas FOR UPDATE
  USING (FALSE);

CREATE POLICY "pedido_lineas_operator_deny_delete"
  ON pedido_lineas FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Price data (`precio_unitario`) must NEVER be visible to OPERATOR.
- Immutable once DELIVERED (only ADMIN can rectify via RPC).

---

## TABLE 18: client_ledger

**Purpose:** Immutable CC (account payable) movements.

**Ownership:** System (created via RPC: register_sale, register_collection, etc.).

**Immutability:** Append-only; no UPDATE/DELETE.

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "client_ledger_admin_select"
  ON client_ledger FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "client_ledger_operator_deny_all"
  ON client_ledger FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write (system only via RPC)
CREATE POLICY "client_ledger_operator_deny_write"
  ON client_ledger FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "client_ledger_immutable"
  ON client_ledger FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "client_ledger_no_delete"
  ON client_ledger FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Financial domain; fully restricted.

---

## TABLE 19: collections

**Purpose:** Cash/instrument collection records (fact of receipt).

**Ownership:** System (created via RPC).

**Immutability:** Append-only.

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "collections_admin_select"
  ON collections FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "collections_operator_deny_all"
  ON collections FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "collections_operator_deny_write"
  ON collections FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "collections_immutable"
  ON collections FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "collections_no_delete"
  ON collections FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Financial domain; fully restricted.

---

## TABLE 20: financial_account

**Purpose:** Account master (Caja chica, MP, BNA, Patagonia).

**Ownership:** None (system master).

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "financial_account_admin_select"
  ON financial_account FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "financial_account_operator_deny_all"
  ON financial_account FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "financial_account_operator_deny_write"
  ON financial_account FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "financial_account_operator_deny_update"
  ON financial_account FOR UPDATE
  USING (FALSE);

CREATE POLICY "financial_account_operator_deny_delete"
  ON financial_account FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Treasury domain; fully restricted.

---

## TABLE 21: financial_operation

**Purpose:** Multi-posting operation (e.g., transfer MP → BNA).

**Ownership:** System (created via RPC).

**Immutability:** Append-only (version control via new operations).

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "financial_operation_admin_select"
  ON financial_operation FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "financial_operation_operator_deny_all"
  ON financial_operation FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "financial_operation_operator_deny_write"
  ON financial_operation FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "financial_operation_immutable"
  ON financial_operation FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "financial_operation_no_delete"
  ON financial_operation FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Treasury domain; fully restricted.

---

## TABLE 22: financial_posting

**Purpose:** Signed amount movements (account debit/credit).

**Ownership:** Via parent financial_operation.

**Immutability:** Append-only; no UPDATE/DELETE.

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "financial_posting_admin_select"
  ON financial_posting FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "financial_posting_operator_deny_all"
  ON financial_posting FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "financial_posting_operator_deny_write"
  ON financial_posting FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "financial_posting_immutable"
  ON financial_posting FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "financial_posting_no_delete"
  ON financial_posting FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Financial domain; fully restricted; immutable.

---

## TABLE 23: financial_instrument

**Purpose:** Cheque and eCheq records (state machine: RECEIVED → DEPOSITED → CLEARED, etc.).

**Ownership:** System (created via RPC).

**Mutability:** State transitions via RPC (financial_instrument_events).

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "financial_instrument_admin_select"
  ON financial_instrument FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "financial_instrument_operator_deny_all"
  ON financial_instrument FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "financial_instrument_operator_deny_write"
  ON financial_instrument FOR INSERT
  WITH CHECK (FALSE);

-- UPDATE via RPC only (managed via financial_instrument_events)
-- [Application enforces RPC-only]

-- IMMUTABLE: no deletes
CREATE POLICY "financial_instrument_no_delete"
  ON financial_instrument FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Treasury domain; fully restricted.

---

## TABLE 24: financial_instrument_event

**Purpose:** State transitions for instruments (RECEIVED, DEPOSITED, CLEARED, REJECTED, etc.).

**Ownership:** System (created via RPC).

**Immutability:** Append-only; no UPDATE/DELETE.

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "financial_instrument_event_admin_select"
  ON financial_instrument_event FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "financial_instrument_event_operator_deny_all"
  ON financial_instrument_event FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "financial_instrument_event_operator_deny_write"
  ON financial_instrument_event FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "financial_instrument_event_immutable"
  ON financial_instrument_event FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "financial_instrument_event_no_delete"
  ON financial_instrument_event FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Treasury domain; fully restricted; immutable.

---

## TABLE 25: suppliers

**Purpose:** Supplier master (name, contact, tax ID).

**Ownership:** None (system master).

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "suppliers_admin_select"
  ON suppliers FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "suppliers_operator_deny_all"
  ON suppliers FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "suppliers_operator_deny_write"
  ON suppliers FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "suppliers_operator_deny_update"
  ON suppliers FOR UPDATE
  USING (FALSE);

CREATE POLICY "suppliers_operator_deny_delete"
  ON suppliers FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Commercial domain; fully restricted.

---

## TABLE 26: supplier_ledger

**Purpose:** Immutable purchase obligation movements.

**Ownership:** System (created via RPC).

**Immutability:** Append-only.

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "supplier_ledger_admin_select"
  ON supplier_ledger FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "supplier_ledger_operator_deny_all"
  ON supplier_ledger FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "supplier_ledger_operator_deny_write"
  ON supplier_ledger FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "supplier_ledger_immutable"
  ON supplier_ledger FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "supplier_ledger_no_delete"
  ON supplier_ledger FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Financial domain; fully restricted.

---

## TABLE 27: purchases (Expenses)

**Purpose:** Purchase/expense economic obligation records.

**Ownership:** System (created via RPC).

**Immutability:** Append-only; versions via reversal + new.

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "purchases_admin_select"
  ON purchases FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "purchases_operator_deny_all"
  ON purchases FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "purchases_operator_deny_write"
  ON purchases FOR INSERT
  WITH CHECK (FALSE);

-- UPDATE via RPC only (manage via reversals)
-- [Application enforces RPC-only]

-- IMMUTABLE: no deletes
CREATE POLICY "purchases_no_delete"
  ON purchases FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Commercial/financial domain; fully restricted.

---

## TABLE 28: price_history

**Purpose:** Historical price snapshots (mayorista, minorista per product/date range).

**Ownership:** System (created via RPC).

**Immutability:** Append-only.

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "price_history_admin_select"
  ON price_history FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "price_history_operator_deny_all"
  ON price_history FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "price_history_operator_deny_write"
  ON price_history FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "price_history_immutable"
  ON price_history FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "price_history_no_delete"
  ON price_history FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Commercial domain; fully restricted.

---

## TABLE 29: fiscal_document

**Purpose:** Invoice/receipt records (fiscal data).

**Ownership:** System (created via RPC).

**Immutability:** Append-only.

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "fiscal_document_admin_select"
  ON fiscal_document FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "fiscal_document_operator_deny_all"
  ON fiscal_document FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "fiscal_document_operator_deny_write"
  ON fiscal_document FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "fiscal_document_immutable"
  ON fiscal_document FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "fiscal_document_no_delete"
  ON fiscal_document FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Fiscal domain; fully restricted.

---

## TABLE 30: tax_component

**Purpose:** IVA, retentions, other tax breakdowns.

**Ownership:** Via parent fiscal_document.

**Immutability:** Append-only.

**Restriction:** OPERATOR sees NONE.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "tax_component_admin_select"
  ON tax_component FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: all
CREATE POLICY "tax_component_operator_deny_all"
  ON tax_component FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write
CREATE POLICY "tax_component_operator_deny_write"
  ON tax_component FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "tax_component_immutable"
  ON tax_component FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "tax_component_no_delete"
  ON tax_component FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Fiscal domain; fully restricted.

---

## TABLE 31: management_period

**Purpose:** Accounting period master (OPEN / CLOSED).

**Ownership:** System (created/updated via RPC: close_management_period, reopen_management_period).

**Restriction:** OPERATOR sees status/dates via RPC only (no direct SELECT).

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "management_period_admin_select"
  ON management_period FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR DENIED: direct SELECT
-- [Expose via RPC: GET /periods/current, GET /periods/status]
CREATE POLICY "management_period_operator_deny_select"
  ON management_period FOR SELECT
  USING (FALSE);

-- OPERATOR cannot write (RPC only)
CREATE POLICY "management_period_operator_deny_write"
  ON management_period FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "management_period_operator_deny_update"
  ON management_period FOR UPDATE
  USING (FALSE);

CREATE POLICY "management_period_operator_deny_delete"
  ON management_period FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Period enforcement is RPC logic, not RLS.
- RPC checks period OPEN before accepting production/classification inserts.
- OPERATOR infers period status implicitly (accept/reject from RPC response).

---

## TABLE 32: mp_source_record

**Purpose:** Immutable raw MP API responses (backup + audit).

**Ownership:** System (created via RPC: sync_mp_data).

**Immutability:** Append-only; no UPDATE/DELETE.

**Restriction:** SERVICE_ROLE only; ADMIN cannot SELECT (security boundary).

**RLS Policies:**

```sql
-- SERVICE_ROLE SELECT: all
CREATE POLICY "mp_source_record_service_role_select"
  ON mp_source_record FOR SELECT
  USING (auth.jwt() ->> 'role' = 'SERVICE_ROLE');

-- ADMIN DENIED: no direct access (security boundary)
CREATE POLICY "mp_source_record_admin_deny_select"
  ON mp_source_record FOR SELECT
  USING (FALSE);

-- SERVICE_ROLE INSERT only (via RPC)
-- [Application enforces atomicity]

-- OPERATOR DENIED: all
CREATE POLICY "mp_source_record_operator_deny_all"
  ON mp_source_record FOR SELECT
  USING (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "mp_source_record_immutable"
  ON mp_source_record FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "mp_source_record_no_delete"
  ON mp_source_record FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- **SECURITY BOUNDARY:** Raw MP data isolated from ADMIN/OPERATOR (prevents manipulation).
- SERVICE_ROLE backend service reads these records to reconcile (via RPC).
- Append-only: immutable source of truth.
- Forensic audit: all MP webhooks preserved.

---

## TABLE 33: mp_financial_movement

**Purpose:** Normalized MP movements (payments, fees, yields, transfers, etc.).

**Ownership:** System (created via RPC: normalize_mp_data).

**Immutability:** Append-only; no UPDATE/DELETE.

**Restriction:** SERVICE_ROLE only (backend reconciliation).

**RLS Policies:**

```sql
-- SERVICE_ROLE SELECT: all
CREATE POLICY "mp_financial_movement_service_role_select"
  ON mp_financial_movement FOR SELECT
  USING (auth.jwt() ->> 'role' = 'SERVICE_ROLE');

-- ADMIN DENIED: no direct access
CREATE POLICY "mp_financial_movement_admin_deny_select"
  ON mp_financial_movement FOR SELECT
  USING (FALSE);

-- OPERATOR DENIED: all
CREATE POLICY "mp_financial_movement_operator_deny_all"
  ON mp_financial_movement FOR SELECT
  USING (FALSE);

-- IMMUTABLE: no updates
CREATE POLICY "mp_financial_movement_immutable"
  ON mp_financial_movement FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes
CREATE POLICY "mp_financial_movement_no_delete"
  ON mp_financial_movement FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Backend service (SERVICE_ROLE) uses these to generate financial_operations + postings.
- Reconciliation timestamp records when matched, NOT when event occurred.

---

## TABLE 34: audit_events

**Purpose:** Transversal audit trail (who changed what, when, why).

**Ownership:** System (created automatically via trigger or RPC).

**Immutability:** Append-only; forensic evidence.

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "audit_events_admin_select"
  ON audit_events FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: own actions only (on authorized domains)
CREATE POLICY "audit_events_operator_select"
  ON audit_events FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND performed_by = auth.uid()
    AND entity_type IN ('daily_production', 'population_events', 'classification', 
                        'classification_line', 'flock_weighing', 'temperature_record', 
                        'feed_manufacturing', 'feed_inventory_count')
  );

-- OPERATOR cannot write
CREATE POLICY "audit_events_operator_deny_write"
  ON audit_events FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: no updates (forensic evidence)
CREATE POLICY "audit_events_immutable"
  ON audit_events FOR UPDATE
  USING (FALSE);

-- IMMUTABLE: no deletes (forensic evidence)
CREATE POLICY "audit_events_no_delete"
  ON audit_events FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- OPERATOR can audit own actions (transparency; accountability).
- Audit trail includes: entity_type, entity_id, action (INSERT/UPDATE/DELETE), before (JSONB), after (JSONB), reason, performed_by, performed_at.
- V2 Consistency: Includes 'classifications' now that classification is unblocked.

---

## TABLE 35: operator_assignments

**Purpose:** OPERATOR → flock/shed authorization mapping.

**Ownership:** System (managed by ADMIN via RPC).

**RLS Policies:**

```sql
-- ADMIN SELECT: all
CREATE POLICY "operator_assignments_admin_select"
  ON operator_assignments FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR SELECT: own assignments only
CREATE POLICY "operator_assignments_operator_select"
  ON operator_assignments FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND operator_id = auth.uid()
  );

-- OPERATOR cannot write (ADMIN only via RPC)
CREATE POLICY "operator_assignments_operator_deny_write"
  ON operator_assignments FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "operator_assignments_operator_deny_update"
  ON operator_assignments FOR UPDATE
  USING (FALSE);

CREATE POLICY "operator_assignments_operator_deny_delete"
  ON operator_assignments FOR DELETE
  USING (FALSE);
```

**CRITICAL NOTES:**
- Central authorization source; used by all production table RLS policies.
- Immutable (assignment_status manages active/inactive).
- OPERATOR queries own assignments to determine which flocks/sheds they can access.

---

# SECURITY BOUNDARIES & DESIGN DECISIONS

## 1. Principle: RLS Enforces Row-Level Access Control; Business Logic in RPC

**Decision:** Period closure, duplicate prevention, atomic operations → RPC layer.

**Why:** RLS cannot prevent period-based mutations (that's business logic, not a row filter). Period enforcement checked at RPC entry, not in RLS. If period CLOSED, RPC rejects INSERT with error; RLS cannot selectively allow/deny based on period.

**Implementation:**
```sql
-- RLS Policy (what OPERATOR can access):
CREATE POLICY "daily_production_operator_insert"
  ON daily_production FOR INSERT
  WITH CHECK (auth.role() = 'OPERATOR' AND created_by = auth.uid() ...);

-- RPC Function (business logic):
CREATE FUNCTION create_daily_production(...)
AS $$
  -- Check period OPEN
  IF (SELECT status FROM management_period WHERE ...) != 'OPEN' THEN
    RAISE EXCEPTION 'Period closed; cannot record production';
  END IF;
  -- Check unique (flock_id, production_date)
  -- Then INSERT
$$;
```

**Exception:** RLS DOES enforce immutability (UPDATE USING FALSE), ownership (created_by = auth.uid()), and domain separation (OPERATOR cannot SELECT commercial tables) — these are row-level access decisions, not business logic.

---

## 2. Cost Data Protection: Multiple Strategies

**Decision:** Cost columns hidden from OPERATOR via column-level RLS + separate tables + safe views.

**Strategy A: Separate Cost Table (feed_manufacturing)**
- `feed_manufacturing` (operational facts) — visible to OPERATOR
- `feed_manufacturing_cost` (cost analysis) — ADMIN only
- Both linked via FK

**Strategy B: Safe View (feed_formula_line)**
- `feed_formula_line` (full data + costs) — ADMIN only
- `feed_formula_line_safe` (VIEW) — ingredients + quantities, no costs — visible to OPERATOR
- OPERATOR queries view, not table

**Strategy C: RLS Denial (price_history, client_ledger, purchases)**
- `price_history` — OPERATOR SELECT USING FALSE
- OPERATOR has no business need; fully blocked

**Test:** Query as OPERATOR role:
```sql
SELECT * FROM feed_manufacturing_cost;  -- Should fail (0 rows; RLS blocks)
SELECT * FROM feed_formula_line_safe;   -- Should succeed (composition only)
SELECT total_amount FROM client_ledger; -- Should fail (OPERATOR cannot SELECT)
```

---

## 3. Immutability Enforcement: RLS vs. Triggers vs. Application

**Decision:** RLS enforces via UPDATE/DELETE USING FALSE.

**Why:** Database-level enforcement prevents accidental mutations (e.g., ORM bug, direct SQL bypass).

**Example:**
```sql
CREATE POLICY "daily_production_immutable"
  ON daily_production FOR UPDATE
  USING (FALSE);  -- No one can UPDATE (ADMIN, OPERATOR, or app bug)
```

**Version Control:** Corrections via new records + audit:
- Mortality conflict → new COUNT_ADJUSTMENT event
- Classification error → new session (next batch)
- Daily production → no correction (permanent record)

---

## 4. Ownership-Based Access: auth.uid() Consistency

**Decision:** All owner checks use `created_by = auth.uid()`.

**Why:** Consistent, auditable, simple.

**Implementation:**
```sql
CREATE POLICY "daily_production_operator_select"
  ON daily_production FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND (
      created_by = auth.uid()                -- own entries
      OR flock_id IN (SELECT ...)            -- assigned entries
    )
  );
```

**Auth Context:** Assumes Supabase JWT contains:
- `sub` (user ID) — extracted as `auth.uid()`
- `role` (user role) — extracted as `auth.jwt() ->> 'role'`

---

## 5. Assignment-Based Access: operator_assignments

**Decision:** All fleet/shed authorization via `operator_assignments` table.

**Why:** Dynamic; changes at runtime without schema migration.

**Implementation:**
```sql
flock_id IN (
  SELECT flock_id FROM operator_assignments
  WHERE operator_id = auth.uid()
  AND assignment_status = 'ACTIVE'
)
```

**Performance:** Index on `(operator_id, assignment_status, flock_id)` for fast lookup.

---

## 6. No Inference of Unauthorized Data via JOIN

**Decision:** RLS policies do NOT assume OPERATOR can infer restricted data via JOIN.

**Why:** If OPERATOR can SELECT daily_production, RLS must prevent:
```sql
SELECT d.*, p.* FROM daily_production d
JOIN pedidos p ON d.production_date = p.delivered_at;  -- No! OPERATOR cannot SELECT pedidos
```

**Implementation:** RLS on pedidos denies OPERATOR SELECT entirely (no JOIN possible).

---

## 7. SERVICE_ROLE Isolation (MP Reconciliation)

**Decision:** MP backend service (SERVICE_ROLE) has isolated access to raw MP data.

**Why:** Prevents ADMIN data manipulation; enforces data lineage.

**Example:**
```sql
-- ADMIN cannot query:
SELECT * FROM mp_source_record;  -- Denied (RLS policy)

-- SERVICE_ROLE backend queries:
SELECT * FROM mp_source_record WHERE occurred_at > NOW() - '1 day'::interval;
-- [Normalizes into mp_financial_movement]
-- [Generates financial_operation + postings]
```

**Why Isolation:** Raw MP data is immutable source of truth. If ADMIN could modify it, audit trail breaks.

---

## 8. RPC-Only Operations: Backend Atomicity

**Decision:** Complex multi-table operations ONLY via RPC (backend enforces atomicity).

**Operations (RPC-only):**
- `deliver_order` — creates pedido DELIVERED + client_ledger + financial posting (if cash)
- `register_collection` — creates collection + client_ledger + financial posting
- `transfer_between_accounts` — creates financial_operation + 2 postings (atomic)
- `receive_cheque`, `deposit_cheque`, etc. — state machine transitions
- `register_purchase` — creates purchase + supplier_ledger + financial postings
- `close_management_period` — validates period, marks CLOSED, records audit
- `reopen_management_period` — ADMIN only, requires reason

**Example RPC (deliver_order):**
```sql
CREATE FUNCTION deliver_order(pedido_id UUID, delivery_date TIMESTAMP)
RETURNS delivery_result AS $$
BEGIN
  -- Check period OPEN
  -- Check pedido exists + PENDING
  -- START TRANSACTION
    UPDATE pedidos SET status='DELIVERED', delivered_at=delivery_date;
    INSERT INTO client_ledger VALUES (generated values);
    IF payment_method='CASH' THEN
      INSERT INTO financial_operation ...
      INSERT INTO financial_posting ...
    END IF;
    INSERT INTO audit_events ...
  -- COMMIT or ROLLBACK
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**SECURITY DEFINER:** Backend service executes in elevated context (bypasses RLS). Application code validates OPERATOR authorization before invoking.

---

# POLICY DEPLOYMENT CHECKLIST

- [ ] Define JWT claims (role, sub) in Supabase authentication
- [ ] Create operator_assignments table + indexes
- [ ] Create all 35 table RLS policies (copy-paste SQL above)
- [ ] Create safe views (feed_formula_line_safe)
- [ ] Create separate cost tables (feed_manufacturing_cost)
- [ ] Create RPC functions (SECURITY DEFINER)
- [ ] Test as each role:
  - [ ] ADMIN SELECT all tables
  - [ ] ADMIN INSERT/UPDATE via RPC (direct table writes denied)
  - [ ] OPERATOR SELECT authorized production tables only
  - [ ] OPERATOR INSERT append-only tables with RLS WHERE
  - [ ] OPERATOR cannot access commercial/financial tables
  - [ ] OPERATOR cannot see cost data
  - [ ] SERVICE_ROLE access to MP tables
  - [ ] PUBLIC/unauthenticated denied all
- [ ] Adversarial test:
  - [ ] OPERATOR tries SELECT clients — denied
  - [ ] OPERATOR tries SELECT feed_manufacturing_cost — denied
  - [ ] OPERATOR tries SELECT pedido_lineas.precio_unitario — denied
  - [ ] OPERATOR tries INSERT daily_production with unassigned flock_id — denied
  - [ ] OPERATOR tries UPDATE daily_production — denied
  - [ ] ADMIN tries direct INSERT pedidos (not via RPC) — accepted (RLS allows)
    - Application layer should reject; recommend RPC path
  - [ ] Privilege escalation: OPERATOR cannot invoke admin RPCs
    - SECURITY DEFINER function checks `auth.jwt() ->> 'role'` before executing

---

# NEXT STEPS

1. **Physical Database Design V2:** Finalize table schemas + constraints
2. **Transaction Catalog V2:** Define RPC function signatures + atomicity
3. **Supabase Configuration:** Deploy RLS policies + functions to staging
4. **Integration Testing:** Verify RPC × RLS enforcement end-to-end
5. **Adversarial Security Review:** Confirm no privilege escalation paths

---

**STATUS:** Specification Complete (Ready for Supabase Deployment)

All ~35 tables covered. RLS policies follow frozen architecture + V2 corrections. Cost protection via multiple strategies. Immutability enforced at RLS. Business logic (period closure, duplicates) in RPC layer.

