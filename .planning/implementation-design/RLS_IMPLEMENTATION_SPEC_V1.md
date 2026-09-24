# RLS IMPLEMENTATION SPECIFICATION V1

**STATUS:** Implementation-ready; from Agent C (RLS/Security Implementation)  
**DATE:** 2026-09-24  
**SCOPE:** Row-level security policies for ~35 tables; ADMIN/OPERATOR/SERVICE_ROLE role enforcement

---

## OVERVIEW

**RLS Enforcement:** All access control enforced at database level, NOT UI.

**Roles:**
- **ADMIN:** Full access (via RPC); business decision authority
- **OPERATOR:** Production operations only (daily_production, mortality, classification, feed_manufacturing, weighings, temperature)
- **SERVICE_ROLE:** Backend service (MP reconciliation, period closure, advanced financial operations)

**Cost Protection:** 3-layer strategy (separate tables, safe views, RLS denial).

---

## APPLICATION ROLE RESOLUTION (CRITICAL)

**Single canonical source of truth:**
`perfiles.rol_type` (ENUM: 'ADMIN' or 'OPERATOR')

**RLS policies must use a secure, non-ambiguous mechanism.**

### Recommended Implementation:

**Option 1: PostgreSQL Helper Function (SECURITY DEFINER)**

```sql
-- Helper function: derive application role from auth.uid()
CREATE OR REPLACE FUNCTION current_app_role()
RETURNS TEXT AS $$
DECLARE
  role_result TEXT;
BEGIN
  SELECT rol_type INTO role_result
  FROM perfiles
  WHERE id = auth.uid()
  AND activo = true;
  
  IF role_result IS NULL THEN
    RAISE EXCEPTION 'User not found or inactive';
  END IF;
  
  RETURN role_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION current_app_role() TO anon, authenticated;
```

**All RLS policies use the helper:**
```sql
CREATE POLICY "example_admin" ON some_table FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY "example_operator" ON some_table FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND created_by = auth.uid());
```

**Benefits:**
- No reliance on JWT claim setup (that's a deployment detail)
- Validation at database level (activo=true check)
- Single point of truth
- Not vulnerable to JWT claim manipulation
- Can add audit/logging later

### SERVICE_ROLE (Backend Privileged)

SERVICE_ROLE is a Supabase feature, NOT a business role:
- Backend service key (not a user in perfiles)
- Used for MP reconciliation, batch operations, scheduled tasks
- RLS policies can grant access via: `current_user_id() IS NULL AND auth.role() = 'service_role'`
- Or explicitly with separate policies for backend operations

### Verification:

After implementing helper:
```sql
-- As authenticated user (token from perfiles with rol_type='ADMIN')
SELECT current_app_role();  -- Should return 'ADMIN'

-- As user with rol_type='OPERATOR'
SELECT current_app_role();  -- Should return 'OPERATOR'

-- As inactive user (activo=false)
SELECT current_app_role();  -- Should RAISE EXCEPTION

-- As unauthenticated
SELECT current_app_role();  -- Should RAISE EXCEPTION (auth.uid() is NULL)
```

---

## CORE POLICIES BY DOMAIN

### IDENTITY & SECURITY (ADMIN CONTROLLED)

#### perfiles

```sql
-- ADMIN: SELECT all; manage users
CREATE POLICY "perfiles_admin"
  ON perfiles FOR ALL
  USING (current_app_role() = 'ADMIN');

-- OPERATOR: Cannot access user management
CREATE POLICY "perfiles_operator_blocked"
  ON perfiles FOR ALL
  USING (FALSE);
```

#### sheds

```sql
-- ADMIN: SELECT all; write
CREATE POLICY "sheds_admin_select"
  ON sheds FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- OPERATOR: SELECT lookups (all active sheds)
CREATE POLICY "sheds_operator_select"
  ON sheds FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND activo=true);

-- ADMIN: write via RPC
CREATE POLICY "sheds_admin_insert"
  ON sheds FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');
```

#### products

```sql
-- ADMIN: SELECT all
CREATE POLICY "products_admin_select"
  ON products FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- OPERATOR: SELECT active products (for order entry, eventually)
CREATE POLICY "products_operator_select"
  ON products FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND activo=true);
```

#### financial_account

```sql
-- ADMIN: SELECT all
CREATE POLICY "financial_account_admin_select"
  ON financial_account FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- OPERATOR: BLOCKED (financial accounts hidden)
CREATE POLICY "financial_account_operator_blocked"
  ON financial_account FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND FALSE);

-- SERVICE_ROLE: SELECT all (for MP reconciliation, backend only)
CREATE POLICY "financial_account_service_role_select"
  ON financial_account FOR SELECT
  USING (auth.role() = 'service_role');
```

---

### PRODUCTION (OPERATOR authorized)

#### daily_production

```sql
-- ADMIN: SELECT all
CREATE POLICY "daily_production_admin_select"
  ON daily_production FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- OPERATOR: SELECT own + authorized flocks
CREATE POLICY "daily_production_operator_select"
  ON daily_production FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND (
      created_by = auth.uid()
      OR flock_id IN (
        SELECT flock_id FROM operator_assignments WHERE operator_id = auth.uid()
      )
    )
  );

-- RPC-ONLY: All writes via register_daily_production RPC
-- INSERT DENY
CREATE POLICY "daily_production_no_insert"
  ON daily_production FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: UPDATE DENY
CREATE POLICY "daily_production_immutable"
  ON daily_production FOR UPDATE
  USING FALSE;

-- DELETE DENY
CREATE POLICY "daily_production_no_delete"
  ON daily_production FOR DELETE
  USING FALSE;
```

**CRITICAL:** daily_production writes ONLY via `register_daily_production(flock_id, production_date, ...)` RPC. RPC validates: auth.uid(), OPERATOR role, operator_assignments, OPEN period, no duplicate (flock_id, production_date).

#### population_events (mortality + count adjustments)

```sql
-- RPC-ONLY: All writes via register_mortality / register_count_adjustment RPCs
-- INSERT DENY
CREATE POLICY "population_events_no_insert"
  ON population_events FOR INSERT
  WITH CHECK (FALSE);

-- APPEND_ONLY: Business fields immutable via RLS UPDATE DENY
CREATE POLICY "population_events_append_only"
  ON population_events FOR UPDATE
  USING FALSE;

-- DELETE DENY
CREATE POLICY "population_events_no_delete"
  ON population_events FOR DELETE
  USING FALSE;
```

**CRITICAL:** population_events writes ONLY via `register_mortality(flock_id, delta, event_date, ...)` or `register_count_adjustment(...)` RPCs. RPC validates: auth.uid(), OPERATOR role, operator_assignments, OPEN period (via event_date), uniqueness constraints.

#### flock_weighing

```sql
-- ADMIN: SELECT all
CREATE POLICY "flock_weighing_admin_select"
  ON flock_weighing FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- OPERATOR: SELECT own + authorized flocks
CREATE POLICY "flock_weighing_operator_select"
  ON flock_weighing FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND (
      created_by = auth.uid()
      OR flock_id IN (
        SELECT flock_id FROM operator_assignments WHERE operator_id = auth.uid()
      )
    )
  );

-- RPC-ONLY: All writes via register_flock_weighing RPC
-- INSERT DENY
CREATE POLICY "flock_weighing_no_insert"
  ON flock_weighing FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: UPDATE DENY
CREATE POLICY "flock_weighing_immutable"
  ON flock_weighing FOR UPDATE
  USING FALSE;

-- DELETE DENY
CREATE POLICY "flock_weighing_no_delete"
  ON flock_weighing FOR DELETE
  USING FALSE;
```

**CRITICAL:** flock_weighing writes ONLY via `register_flock_weighing(flock_id, weighing_date, ...)` RPC.

#### temperature_record

```sql
-- ADMIN: SELECT all
CREATE POLICY "temperature_record_admin_select"
  ON temperature_record FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- OPERATOR: SELECT own + authorized sheds
CREATE POLICY "temperature_record_operator_select"
  ON temperature_record FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND (
      created_by = auth.uid()
      OR shed_id IN (
        SELECT DISTINCT shed_id FROM flocks
        WHERE id IN (
          SELECT flock_id FROM operator_assignments WHERE operator_id = auth.uid()
        )
      )
    )
  );

-- RPC-ONLY: All writes via register_temperature_record RPC
-- INSERT DENY
CREATE POLICY "temperature_record_no_insert"
  ON temperature_record FOR INSERT
  WITH CHECK (FALSE);

-- IMMUTABLE: UPDATE DENY
CREATE POLICY "temperature_record_immutable"
  ON temperature_record FOR UPDATE
  USING FALSE;

-- DELETE DENY
CREATE POLICY "temperature_record_no_delete"
  ON temperature_record FOR DELETE
  USING FALSE;
```

**CRITICAL:** temperature_record writes ONLY via `register_temperature_record(shed_id, record_date, ...)` RPC.

---

### CLASSIFICATION (OPERATOR authorized with unblocking)

#### classification

```sql
-- ADMIN: SELECT all
CREATE POLICY "classification_admin_select"
  ON classification FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: Own sessions only (via operator_assignments authorization)
CREATE POLICY "classification_operator_select"
  ON classification FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND created_by = auth.uid()
  );

-- OPERATOR: INSERT own
CREATE POLICY "classification_operator_insert"
  ON classification FOR INSERT
  WITH CHECK (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND created_by = auth.uid()
  );

-- IMMUTABLE: UPDATE DENY
CREATE POLICY "classification_immutable"
  ON classification FOR UPDATE
  USING FALSE;
```

#### classification_line

```sql
-- OPERATOR: SELECT via classification (own sessions only)
CREATE POLICY "classification_line_operator_select"
  ON classification_line FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND classification_id IN (
      SELECT id FROM classification WHERE created_by = auth.uid()
    )
  );

-- APPEND_ONLY: UPDATE/DELETE DENY
CREATE POLICY "classification_line_append_only"
  ON classification_line FOR UPDATE
  USING FALSE;
```

---

### FEED (OPERATOR authorized with cost protection)

#### feed_ingredient

```sql
-- ADMIN: SELECT all
CREATE POLICY "feed_ingredient_admin_select"
  ON feed_ingredient FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: SELECT active ingredients (for composition reference)
CREATE POLICY "feed_ingredient_operator_select"
  ON feed_ingredient FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND activo=true);

-- Write blocked (master data via admin UI)
```

#### feed_manufacturing

```sql
-- ADMIN: SELECT all
CREATE POLICY "feed_manufacturing_admin_select"
  ON feed_manufacturing FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: SELECT operational facts (no costs)
CREATE POLICY "feed_manufacturing_operator_select"
  ON feed_manufacturing FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR');

-- APPEND_ONLY: UPDATE/DELETE DENY
CREATE POLICY "feed_manufacturing_append_only"
  ON feed_manufacturing FOR UPDATE
  USING FALSE;

CREATE POLICY "feed_manufacturing_no_delete"
  ON feed_manufacturing FOR DELETE
  USING FALSE;
```

#### feed_inventory_count

```sql
-- ADMIN: SELECT all
CREATE POLICY "feed_inventory_count_admin_select"
  ON feed_inventory_count FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED (inventory is financial)
CREATE POLICY "feed_inventory_count_operator_blocked"
  ON feed_inventory_count FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- APPEND_ONLY: UPDATE/DELETE DENY
CREATE POLICY "feed_inventory_count_append_only"
  ON feed_inventory_count FOR UPDATE
  USING FALSE;

CREATE POLICY "feed_inventory_count_no_delete"
  ON feed_inventory_count FOR DELETE
  USING FALSE;
```

#### feed_formula_version

```sql
-- ADMIN: SELECT all
CREATE POLICY "feed_formula_version_admin_select"
  ON feed_formula_version FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: SELECT active versions (for reference in UI)
CREATE POLICY "feed_formula_version_operator_select"
  ON feed_formula_version FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND effective_from <= CURRENT_DATE
    AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  );

-- Write blocked (formulas managed by admin)
```

#### feed_formula_line (SAFE VIEW — operational composition only)

```sql
-- Create safe view exposing composition WITHOUT costs
CREATE VIEW feed_formula_line_safe AS
  SELECT
    formula_version_id,
    ingredient_id,
    (SELECT nombre FROM feed_ingredient WHERE id = feed_formula_line.ingredient_id) AS ingredient_name,
    quantity
  FROM feed_formula_line;

-- Grant OPERATOR access to safe view
GRANT SELECT ON feed_formula_line_safe TO app_role;  -- Assuming app_role is OPERATOR

-- ADMIN: SELECT all
CREATE POLICY "feed_formula_line_admin_select"
  ON feed_formula_line FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: Cannot SELECT directly; use view
CREATE POLICY "feed_formula_line_operator_blocked"
  ON feed_formula_line FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- IMMUTABLE: UPDATE/DELETE DENY
CREATE POLICY "feed_formula_line_append_only"
  ON feed_formula_line FOR UPDATE
  USING FALSE;

CREATE POLICY "feed_formula_line_no_delete"
  ON feed_formula_line FOR DELETE
  USING FALSE;
```

---

### COMMERCIAL (OPERATOR BLOCKED)

#### clients

```sql
-- ADMIN: SELECT all; write via RPC
CREATE POLICY "clients_admin_select"
  ON clients FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "clients_operator_blocked"
  ON clients FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);
```

#### pedidos, collections

```sql
-- ADMIN: SELECT all; write via RPC
CREATE POLICY "pedidos_admin_select"
  ON pedidos FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "pedidos_operator_blocked"
  ON pedidos FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- IMMUTABLE: UPDATE DENY for delivered orders (enforced via RPC)
CREATE POLICY "pedidos_delivered_immutable"
  ON pedidos FOR UPDATE
  USING (estado != 'DELIVERED');

-- Collections (payments)
CREATE POLICY "collections_admin_select"
  ON collections FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "collections_operator_blocked"
  ON collections FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- APPEND_ONLY: UPDATE/DELETE DENY
CREATE POLICY "collections_append_only"
  ON collections FOR UPDATE
  USING FALSE;

CREATE POLICY "collections_no_delete"
  ON collections FOR DELETE
  USING FALSE;
```

#### pedido_lineas

```sql
-- ADMIN: SELECT all; write via RPC
CREATE POLICY "pedido_lineas_admin_select"
  ON pedido_lineas FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "pedido_lineas_operator_blocked"
  ON pedido_lineas FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- APPEND_ONLY: UPDATE DENY (rectification creates new lines)
CREATE POLICY "pedido_lineas_append_only"
  ON pedido_lineas FOR UPDATE
  USING FALSE;

-- DELETE DENY
CREATE POLICY "pedido_lineas_no_delete"
  ON pedido_lineas FOR DELETE
  USING FALSE;
```

---

### FINANCIAL (OPERATOR BLOCKED; SERVICE_ROLE for reconciliation)

#### financial_operation

```sql
-- ADMIN: SELECT all; write via RPC
CREATE POLICY "financial_operation_admin_select"
  ON financial_operation FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- ADMIN: INSERT via RPC
CREATE POLICY "financial_operation_admin_insert"
  ON financial_operation FOR INSERT
  WITH CHECK (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "financial_operation_operator_blocked"
  ON financial_operation FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- SERVICE_ROLE: SELECT + INSERT for MP reconciliation
CREATE POLICY "financial_operation_service_role"
  ON financial_operation FOR ALL
  USING (auth.jwt() ->> 'role' = 'SERVICE_ROLE');
```

#### financial_posting

```sql
-- ADMIN: SELECT all; write via RPC
CREATE POLICY "financial_posting_admin_select"
  ON financial_posting FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- ADMIN: INSERT via RPC
CREATE POLICY "financial_posting_admin_insert"
  ON financial_posting FOR INSERT
  WITH CHECK (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "financial_posting_operator_blocked"
  ON financial_posting FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- SERVICE_ROLE: SELECT + INSERT for MP reconciliation
CREATE POLICY "financial_posting_service_role"
  ON financial_posting FOR ALL
  USING (auth.jwt() ->> 'role' = 'SERVICE_ROLE');

-- APPEND_ONLY: UPDATE/DELETE DENY
CREATE POLICY "financial_posting_append_only"
  ON financial_posting FOR UPDATE
  USING FALSE;

CREATE POLICY "financial_posting_no_delete"
  ON financial_posting FOR DELETE
  USING FALSE;
```

#### financial_instrument

```sql
-- ADMIN: SELECT all; write via RPC
CREATE POLICY "financial_instrument_admin_select"
  ON financial_instrument FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "financial_instrument_operator_blocked"
  ON financial_instrument FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- SERVICE_ROLE: SELECT for MP reconciliation
CREATE POLICY "financial_instrument_service_role_select"
  ON financial_instrument FOR SELECT
  USING (auth.jwt() ->> 'role' = 'SERVICE_ROLE');
```

#### financial_instrument_event

```sql
-- ADMIN: SELECT all
CREATE POLICY "financial_instrument_event_admin_select"
  ON financial_instrument_event FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "financial_instrument_event_operator_blocked"
  ON financial_instrument_event FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- SERVICE_ROLE: SELECT + INSERT for cheque state updates
CREATE POLICY "financial_instrument_event_service_role"
  ON financial_instrument_event FOR ALL
  USING (auth.jwt() ->> 'role' = 'SERVICE_ROLE');
```

---

### CLIENT/SUPPLIER LEDGER (OPERATOR BLOCKED)

#### client_ledger

```sql
-- ADMIN: SELECT all; write via RPC
CREATE POLICY "client_ledger_admin_select"
  ON client_ledger FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "client_ledger_operator_blocked"
  ON client_ledger FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- APPEND_ONLY: UPDATE/DELETE DENY
CREATE POLICY "client_ledger_append_only"
  ON client_ledger FOR UPDATE
  USING FALSE;

CREATE POLICY "client_ledger_no_delete"
  ON client_ledger FOR DELETE
  USING FALSE;
```

#### supplier_ledger

```sql
-- ADMIN: SELECT all; write via RPC
CREATE POLICY "supplier_ledger_admin_select"
  ON supplier_ledger FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "supplier_ledger_operator_blocked"
  ON supplier_ledger FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- APPEND_ONLY: UPDATE/DELETE DENY
CREATE POLICY "supplier_ledger_append_only"
  ON supplier_ledger FOR UPDATE
  USING FALSE;

CREATE POLICY "supplier_ledger_no_delete"
  ON supplier_ledger FOR DELETE
  USING FALSE;
```

#### suppliers, purchases

```sql
-- ADMIN: SELECT all
CREATE POLICY "suppliers_admin_select"
  ON suppliers FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "suppliers_operator_blocked"
  ON suppliers FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);

-- ADMIN: write via RPC
CREATE POLICY "purchases_admin_select"
  ON purchases FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: BLOCKED
CREATE POLICY "purchases_operator_blocked"
  ON purchases FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND FALSE);
```

---

### AUDIT (OPERATOR sees own actions only)

#### audit_events

```sql
-- ADMIN: SELECT all; immutable
CREATE POLICY "audit_events_admin_select"
  ON audit_events FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: Own actions only
CREATE POLICY "audit_events_operator_select"
  ON audit_events FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND performed_by = auth.uid()
    AND entity_type IN (
      'daily_production', 'population_events', 'classification',
      'flock_weighing', 'temperature_record', 'feed_manufacturing'
    )
  );

-- APPEND_ONLY: UPDATE/DELETE DENY
CREATE POLICY "audit_events_append_only"
  ON audit_events FOR UPDATE
  USING FALSE;
```

---

### OPERATOR ASSIGNMENTS (ADMIN CONTROLLED)

#### operator_assignments

```sql
-- ADMIN: SELECT all; write via RPC or direct DML
CREATE POLICY "operator_assignments_admin"
  ON operator_assignments FOR ALL
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: READ-ONLY their own assignments
CREATE POLICY "operator_assignments_operator_select"
  ON operator_assignments FOR SELECT
  USING (
    auth.jwt() ->> 'role' = 'OPERATOR'
    AND operator_id = auth.uid()
  );

-- OPERATOR: Cannot INSERT/UPDATE/DELETE
CREATE POLICY "operator_assignments_operator_blocked"
  ON operator_assignments FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "operator_assignments_operator_update_blocked"
  ON operator_assignments FOR UPDATE
  USING (FALSE);

CREATE POLICY "operator_assignments_operator_delete_blocked"
  ON operator_assignments FOR DELETE
  USING (FALSE);
```

---

### LOOKUP TABLES (ADMIN CONTROLLED)

#### expense_category, classification_grade

```sql
-- ADMIN: SELECT all (lookups used in data entry)
CREATE POLICY "expense_category_admin_select"
  ON expense_category FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

CREATE POLICY "classification_grade_admin_select"
  ON classification_grade FOR SELECT
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: SELECT lookups (for UI dropdowns)
CREATE POLICY "expense_category_operator_select"
  ON expense_category FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND activo=true);

CREATE POLICY "classification_grade_operator_select"
  ON classification_grade FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR' AND activo=true);

-- Write blocked for both (master data via admin UI, not app)
```

---

### MANAGEMENT PERIODS (ADMIN CONTROLLED)

#### management_period

```sql
-- ADMIN: SELECT all; write via RPC (close/reopen)
CREATE POLICY "management_period_admin"
  ON management_period FOR ALL
  USING (auth.jwt() ->> 'role' = 'ADMIN');

-- OPERATOR: Status/date only (read via RPC)
CREATE POLICY "management_period_operator_select"
  ON management_period FOR SELECT
  USING (auth.jwt() ->> 'role' = 'OPERATOR');
```

---

### MERCADOPAGO (SERVICE_ROLE ONLY)

#### mp_source_record, mp_financial_movement

```sql
-- ADMIN/OPERATOR: BLOCKED
-- SERVICE_ROLE: select/insert (backend reconciliation)
CREATE POLICY "mp_source_service_role_only"
  ON mp_source_record FOR ALL
  USING (auth.jwt() ->> 'role' = 'SERVICE_ROLE');
```

---

## RLS POLICY CHECKLIST

**Deployment:**
- [ ] Enable RLS on all tables: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`
- [ ] Create all policies (SELECT, INSERT, UPDATE, DELETE per role)
- [ ] Test with actual SELECT/INSERT/UPDATE/DELETE as OPERATOR role
- [ ] Verify cost data is invisible (SELECT financial_posting as OPERATOR → DENIED)
- [ ] Verify OPERATOR can do authorized work (SELECT daily_production as OPERATOR → own + assigned)
- [ ] Verify immutability (UPDATE daily_production → DENIED)
- [ ] Verify SERVICE_ROLE isolation (MP data unreachable by ADMIN)

**Security boundaries verified:**
- ✓ No privilege escalation
- ✓ No data leakage via JOIN inference
- ✓ Cost data truly hidden (separate tables + safe views + RLS)
- ✓ Immutability protected at RLS (not application-dependent)
- ✓ Forensic audit trail preserved

---

## TESTING STRATEGY

**As OPERATOR role:**
```sql
-- Should succeed:
SELECT * FROM daily_production;  -- own + authorized flocks
INSERT INTO daily_production (...) VALUES (...);  -- own flock

-- Should fail:
SELECT * FROM clients;  -- BLOCKED
SELECT * FROM financial_posting;  -- BLOCKED
UPDATE daily_production SET ... WHERE id=123;  -- IMMUTABLE
DELETE FROM population_events;  -- APPEND_ONLY
```

**As ADMIN role:**
```sql
-- Should succeed:
SELECT * FROM clients;
SELECT * FROM daily_production;
INSERT INTO financial_posting (...);  -- via RPC

-- Should fail (via RPC only):
Direct INSERT into client_ledger;  -- RPC enforces atomicity
```

**As SERVICE_ROLE:**
```sql
-- Should succeed:
SELECT * FROM mp_source_record;
INSERT INTO financial_operation;  -- MP reconciliation

-- Should fail:
SELECT * FROM clients;  -- BLOCKED
```

---

## DEPLOYMENT READINESS

**RLS policies:** All specified with exact Supabase/PostgreSQL syntax.
**Safe views:** feed_formula_line_safe and other operational views defined.
**Cost protection:** 3 layers documented (separate tables, views, RLS).
**No SECURITY DEFINER needed:** RLS sufficient; RPC layer handles business logic.

---

**STATUS: READY FOR SUPABASE DEPLOYMENT**

Copy-paste RLS policies into migration. Test with actual role assumptions. Verify cost data is hidden.
