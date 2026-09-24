# IMPLEMENTATION DEPENDENCY ORDER V1

**STATUS:** Technical sequencing for Physical Schema Implementation  
**DATE:** 2026-09-24  
**PURPOSE:** Specify the order in which PostgreSQL/Supabase components must be created to satisfy dependencies

**THIS IS NOT A MIGRATION.** This is a sequencing guide for the next phase (Physical Schema Implementation). No data moves yet.

---

## PHASE 1: SCHEMA FOUNDATIONS

### Step 1.1: Create ENUMs (must precede table creation)

```sql
CREATE TYPE rol_type AS ENUM ('ADMIN', 'OPERATOR');
CREATE TYPE order_estado AS ENUM ('PENDING', 'DELIVERED', 'CANCELLED');
CREATE TYPE product_type AS ENUM ('VENDIBLE', 'INPUT', 'BOTH');
CREATE TYPE financial_operation_type AS ENUM ('TRANSFER', 'FEE', 'CHEQUE_CLEAR', 'COLLECTION', 'ADJUSTMENT', 'CHEQUE_REJECTION');
CREATE TYPE financial_instrument_type AS ENUM ('CHEQUE', 'ECHEQ');
CREATE TYPE instrument_estado AS ENUM ('RECEIVED', 'DEPOSITED', 'CLEARED', 'ENDORSED', 'REJECTED');
CREATE TYPE account_type AS ENUM ('CASH', 'BANK_ACCOUNT', 'EXTERNAL_SERVICE');
CREATE TYPE population_event_type AS ENUM ('MORTALITY', 'COUNT_ADJUSTMENT');
CREATE TYPE flock_estado AS ENUM ('ACTIVE', 'RETIRED', 'ARCHIVED');
CREATE TYPE management_period_status AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE client_ledger_movement_type AS ENUM ('SALE_DELIVERY', 'COLLECTION', 'CHEQUE_RECEIVED', 'ADJUSTMENT', 'REVERSAL', 'CHEQUE_REJECTED', 'OPENING_BALANCE');
CREATE TYPE supplier_ledger_movement_type AS ENUM ('PURCHASE', 'PAYMENT', 'CHEQUE_ENDORSED', 'ADJUSTMENT', 'REVERSAL');
CREATE TYPE payment_method AS ENUM ('CASH', 'CHEQUE', 'TRANSFER', 'MERCADOPAGO');
CREATE TYPE feed_category AS ENUM ('LAYER', 'BROILER', 'PULLET', 'INPUT');
CREATE TYPE unit_type AS ENUM ('KG', 'LITER', 'UNIT');
```

**Dependency:** All tables depend on these.

---

### Step 1.2: Create Master/Identity Tables (no FKs to other targets yet)

**Create in order:**
1. perfiles (users, roles)
2. sheds (facilities)
3. clients (sales)
4. products (inventory)
5. suppliers (purchases)
6. financial_account (GL accounts)
7. management_period (period control)
8. feed_type (feed catalog)
9. expense_category (lookup, for future use)
10. classification_grade (lookup, for classification.grade values)

**Rationale:** These are referenced by everything else. No FK dependencies within this group.

---

### Step 1.3: Create Domain-Specific Tables (with FKs to masters)

**Commercial domain:**
1. pedidos (FK: cliente_id → clients)
2. pedido_lineas (FK: pedido_id → pedidos; producto_id → products)
3. price_history (lookup)

**Client ledger:**
1. client_ledger (FK: cliente_id → clients) [APPEND_ONLY]
2. collections (FK: cliente_id → clients)

**Financial:**
1. financial_operation (no external FK)
2. financial_posting (FK: financial_operation_id, financial_account_id)
3. financial_instrument (no external FK)
4. financial_instrument_event (FK: financial_instrument_id)

**Suppliers:**
1. supplier_ledger (FK: supplier_id → suppliers) [APPEND_ONLY]
2. purchases (FK: supplier_id → suppliers)

**Production:**
1. flocks (FK: shed_id → sheds; supplier_id → suppliers)
2. operator_assignments (FK: operator_id → perfiles; flock_id → flocks) [Authorization matrix]
3. population_events (FK: flock_id → flocks) [APPEND_ONLY]
4. daily_production (FK: flock_id → flocks) [APPEND_ONLY]
5. flock_weighing (FK: flock_id → flocks)
6. temperature_record (FK: shed_id → sheds)

**Classification:**
1. classification (no FK)
2. classification_line (FK: classification_id → classification)

**Feed:**
1. feed_ingredient (FK: supplier_id → suppliers, nullable)
2. feed_formula_version (FK: feed_type_id → feed_type)
3. feed_formula_line (FK: formula_version_id → feed_formula_version; ingredient_id → feed_ingredient)
4. feed_manufacturing (FK: formula_version_id → feed_formula_version) [APPEND_ONLY]
5. feed_inventory_count (FK: feed_type_id → feed_type) [APPEND_ONLY]

**Audit:**
1. audit_events (FK: performed_by → perfiles) [APPEND_ONLY]

**MP Integration (FASE 0, reuse):**
1. mp_source_record [APPEND_ONLY]
2. mp_financial_movement

---

## PHASE 2: CONSTRAINTS & INDEXES

### Step 2.1: Add UNIQUE Constraints via Indexes (after all table data integrity checked)

```sql
-- Partial uniqueness (with WHERE condition) — PostgreSQL syntax: CREATE UNIQUE INDEX
CREATE UNIQUE INDEX idx_flock_shed_active ON flocks(shed_id) WHERE estado='ACTIVE';
CREATE UNIQUE INDEX idx_population_events_mortality ON population_events(flock_id, event_date) WHERE event_type='MORTALITY' AND is_current=true;

-- Full uniqueness
ALTER TABLE pedidos ADD CONSTRAINT uk_numero_pedido UNIQUE(numero_pedido);
ALTER TABLE collections ADD CONSTRAINT uk_receipt_id UNIQUE(receipt_id);
ALTER TABLE feed_formula_version ADD CONSTRAINT uk_formula_version UNIQUE(feed_type_id, version);
-- etc.
```

### Step 2.2: Add CHECK Constraints

```sql
ALTER TABLE financial_posting ADD CONSTRAINT chk_posting_nonzero CHECK(signed_amount <> 0);
-- etc.
```

### Step 2.3: Create Indexes (for performance)

```sql
CREATE INDEX idx_management_period_status ON management_period(status);
CREATE INDEX idx_client_ledger_cliente_date ON client_ledger(cliente_id, effective_date);
CREATE INDEX idx_financial_posting_account_date ON financial_posting(financial_account_id, effective_date);
CREATE INDEX idx_population_events_flock_date ON population_events(flock_id, event_date);
-- etc.
```

---

## PHASE 3: ENABLE RLS & ATTACH POLICIES

### Step 3.1: Enable RLS on all tables

```sql
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ledger ENABLE ROW LEVEL SECURITY;
-- etc.
```

**Rationale:** RLS must be enabled before policies can work.

### Step 3.2: Attach RLS Policies (per RLS_IMPLEMENTATION_SPEC_V1.md)

For each table, create policies:
- ADMIN SELECT/INSERT/UPDATE/DELETE (usually broad)
- OPERATOR SELECT/INSERT/UPDATE/DELETE (usually restricted)
- SERVICE_ROLE SELECT/INSERT for backend services

**Order doesn't matter, but do all for a table before moving to next.**

### Step 3.3: Create Safe Views (if needed)

```sql
CREATE VIEW feed_formula_line_safe AS
  SELECT formula_version_id, ingredient_id, quantity
  FROM feed_formula_line;
-- No cost columns exposed
```

---

## PHASE 4: VERIFY INVARIANTS

### Step 4.1: Schema Verification

```sql
-- Verify no stored balances
SELECT * FROM clients WHERE balance IS NOT NULL LIMIT 1;
→ expect 0 rows

-- Verify GENERATED ALWAYS on subtotal
SELECT column_default FROM information_schema.columns 
WHERE table_name='pedido_lineas' AND column_name='subtotal';
→ expect GENERATED ... AS ...

-- Verify RLS enabled
SELECT schemaname, tablename, rowsecurity 
FROM pg_tables WHERE schemaname='public' AND rowsecurity=true 
ORDER BY tablename;
→ expect all target tables with rowsecurity=true
```

### Step 4.2: RLS Verification (as each role)

```sql
-- As OPERATOR role:
SELECT COUNT(*) FROM daily_production;  -- should work
SELECT COUNT(*) FROM clients;  -- should return 0 (blocked)
UPDATE daily_production SET eggs_total=100 WHERE id='xxx';  -- should fail
```

### Step 4.3: Constraint Verification

```sql
-- One active flock per shed
SELECT shed_id, COUNT(*) FROM flocks WHERE estado='ACTIVE' GROUP BY shed_id HAVING COUNT(*) > 1;
→ expect 0 rows

-- Partial UNIQUE on mortality
SELECT flock_id, event_date, COUNT(*) FROM population_events 
WHERE event_type='MORTALITY' AND is_current=true 
GROUP BY flock_id, event_date HAVING COUNT(*) > 1;
→ expect 0 rows
```

---

## PHASE 5: RPC/FUNCTION IMPLEMENTATION

### Step 5.1: Create PostgreSQL Functions (PL/pgSQL or RPC framework)

For each RPC from RPC_CONTRACTS_V1.md:
1. deliver_order(...)
2. register_collection(...)
3. receive_cheque(...)
4. clear_cheque(...)
5. endorse_cheque(...)
6. reject_cheque(...)
7. register_purchase(...)
8. register_daily_production(...) [if not direct insert]
9. register_mortality(...)
10. rectify_mortality(...)
11. register_classification(...)
12. close_management_period(...)
13. reopen_management_period(...)
14. transfer_between_accounts(...)
15. ... (23 total)

**Each function:**
- Takes exact parameters from RPC_CONTRACTS_V1
- Executes atomic transaction (BEGIN/COMMIT)
- Validates period before INSERT
- Locks rows with SELECT FOR UPDATE
- Creates audit_events
- Returns exact result type

### Step 5.2: Assign Function Permissions

```sql
-- ADMIN/APP role can execute these
GRANT EXECUTE ON FUNCTION deliver_order(...) TO app_role;
GRANT EXECUTE ON FUNCTION register_collection(...) TO app_role;
-- etc.

-- SERVICE_ROLE for backend
GRANT EXECUTE ON FUNCTION mp_reconciliation(...) TO service_role;
```

---


## DEPENDENCY GRAPH

```
ENUMs
  ├── Master tables (no internal FKs)
  │   ├── perfiles, sheds, clients, products, suppliers
  │   ├── financial_account, management_period
  │   └── feed_type, expense_category, classification_grade
  │
  ├── Domain tables (FKs to masters)
  │   ├── Commercial: pedidos → pedido_lineas
  │   ├── Ledgers: client_ledger, supplier_ledger
  │   ├── Financial: financial_operation → financial_posting, financial_instrument → financial_instrument_event
  │   ├── Production: flocks → operator_assignments; flocks → population_events, daily_production
  │   ├── Collections: collections (FK: cliente_id)
  │   ├── Classification: classification → classification_line
  │   └── Feed: feed_ingredient; feed_formula_version → feed_formula_line; feed_manufacturing; feed_inventory_count
  │
  ├── Audit: audit_events
  │
  ├── Constraints & Indexes (after all tables exist)
  │   ├── UNIQUE constraints (partial and full)
  │   ├── CHECK constraints
  │   └── Performance indexes
  │
  ├── RLS (enable + attach policies)
  │   ├── Enable RLS on all tables
  │   ├── Attach role-based policies (ADMIN, OPERATOR, SERVICE_ROLE)
  │   └── Create safe views (feed_formula_line_safe)
  │
  ├── Verification (test before moving forward)
  │   ├── Schema verification (no stored balances, GENERATED ALWAYS)
  │   ├── RLS verification (test each role)
  │   └── Constraint verification (partial UNIQUE, FKs)
  │
  └── RPCs (implement transactions)
      └── 23 Functions + permissions + role assignment
```

---

## COMPLETION CRITERIA

- [ ] Phase 1: All ENUMs created; master tables created; domain tables created
- [ ] Phase 2: All UNIQUE/CHECK/INDEX constraints added; no errors
- [ ] Phase 3: RLS enabled on all tables; policies attached; safe views created
- [ ] Phase 4: Schema verified (no stored balances, GENERATED ALWAYS, RLS enabled); RLS tested as each role; constraints verified
- [ ] Phase 5: All 23+ RPCs implemented; permissions assigned; RPCs tested
- [ ] Ready for Phase 10: Physical Schema Implementation Complete

---

## NO EXECUTION YET

This document specifies the ORDER of implementation, not the EXECUTION.

Data migration and cutover are SEPARATE phases and occur AFTER this Physical Schema Implementation is complete and verified.

---

**STATUS: IMPLEMENTATION SEQUENCING DEFINED**

This document specifies the ORDER of implementation, not EXECUTION.

Next phase (Phase 10): Execute this sequence to build the target schema.
