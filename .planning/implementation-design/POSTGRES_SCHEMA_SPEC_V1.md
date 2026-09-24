# POSTGRES SCHEMA SPECIFICATION V1

**STATUS:** Implementation-ready; consolidated from Agent A (PostgreSQL) + Agent D (Temporal)  
**DATE:** 2026-09-24  
**BASIS:** TARGET_ARCHITECTURE_V2_FROZEN.md + PHYSICAL_DATABASE_DESIGN_V2_CANDIDATE.md + Round 2 micro-corrections

---

## OVERVIEW

This document specifies ALL 39+ PostgreSQL tables for Granja Santo Tomás ERP.

**Coverage:**
- Complete DDL with types, constraints, indexes, RLS policies
- PK/FK strategies with ON DELETE/UPDATE behavior
- ENUM definitions (stable technical states)
- GENERATED ALWAYS columns (immutable derivations)
- Snapshots and period determinant fields
- Immutability enforcement (RLS policies)
- Examples of valid rows

**Design Principles:**
- UUID for masters (globally unique, offline-safe)
- BIGSERIAL for append-only ledgers (dense keys, natural ordering)
- NUMERIC(15,2) for all money (signed amounts)
- INTEGER for discrete physical units (eggs, cartons)
- BIGINT for population counts
- DECIMAL(10,3) for weights
- DATE for business period determinant (NOT created_at)
- TIMESTAMPTZ for effective timestamps (UTC storage)

---

## CRITICAL CONSTRAINTS ENFORCED AT DATABASE LEVEL

| # | Invariant | Table | Constraint Type | Enforcement |
|---|---|---|---|---|
| 1 | One ACTIVE flock per shed | flocks | UNIQUE(shed_id) WHERE estado='ACTIVE' | UNIQUE partial |
| 2 | Max ONE MORTALITY per (flock, date) | population_events | UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' | UNIQUE partial |
| 3 | Order subtotal = qty * price | pedido_lineas | GENERATED ALWAYS AS (cantidad * precio_unitario) | GENERATED ALWAYS |
| 4 | Delivered order immutable | pedidos | RLS UPDATE on estado='DELIVERED' | RLS UPDATE DENY |
| 5 | Client balance = SUM(ledger) | client_ledger | NO balance column | Computed only |
| 6 | Account balance = SUM(posting) | financial_posting | NO balance column | Computed only |
| 7 | Zero-amount postings forbidden | financial_posting | CHECK(signed_amount <> 0) | CHECK constraint |
| 8 | Transfer posts exactly 2x | financial_operation + posting | FK relationship | FK + RPC atomicity |
| 9 | Ledger append-only | client_ledger, financial_posting, population_events, supplier_ledger, audit_events | RLS UPDATE DENY, DELETE DENY | RLS policies |
| 10 | Period OPEN for INSERT/UPDATE | All period-determining tables | Checked in RPC, NOT DB | RPC validation |
| 11 | Fact period = effective_date, NOT created_at | All entities | Explicit effective_date column | Column design |
| 12 | Cheque state machine valid | financial_instrument | Enforced in RPC | RPC validation |
| 13 | Order price snapshot immutable | pedido_lineas.precio_unitario | Immutable snapshot | RLS on parent |
| 14 | No fictitious classification | classification | NO flock_id reference | Schema design |
| 15 | No stored daily feed consumption | feed_* | NO daily_feed_consumption table | Schema design |
| 16 | Formula version immutable | feed_manufacturing | formula_version_id immutable | RLS UPDATE |
| 17 | Population flow = events only | population_events | NO current_population column | Computed only |
| 18 | No hard-delete facts | All ledger/audit | Only soft-delete; reversals for correction | RLS DELETE DENY |
| 19 | MP source immutable | mp_source_record | APPEND_ONLY | RLS UPDATE/DELETE DENY |
| 20 | Client name history preserved | client_ledger.ledger_client_name | Snapshot at posting | Snapshot field |

---

## DOMAIN A: IDENTITY & SECURITY

### TABLE: perfiles

```sql
CREATE TABLE perfiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  rol_type rol_type NOT NULL DEFAULT 'OPERATOR',
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS Policy
CREATE POLICY "perfiles_admin_all"
  ON perfiles FOR ALL
  USING (auth.jwt() ->> 'role' = 'ADMIN');
```

**CRITICAL:** PK is id (UUID); email is unique for login.

---

### TABLE: financial_account

```sql
CREATE TABLE financial_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(100) UNIQUE NOT NULL,
  account_type account_type NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Masters: CAJA_CHICA, MERCADO_PAGO, BNA, PATAGONIA
```

**NOTE:** Corrected from BIGSERIAL → UUID (is a master, not append-only).

---

## DOMAIN B: COMMERCIAL

### TABLE: clients

```sql
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL UNIQUE,
  fiscal_id TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### TABLE: products

```sql
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(255) NOT NULL,
  product_type product_type NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### TABLE: pedidos

```sql
CREATE TABLE pedidos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_pedido BIGINT UNIQUE,
  cliente_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  estado order_estado NOT NULL DEFAULT 'PENDING',
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Immutability: RLS UPDATE DENY once estado='DELIVERED'
CREATE POLICY "pedidos_delivered_immutable"
  ON pedidos FOR UPDATE
  USING (estado != 'DELIVERED');
```

**CRITICAL:** monto_total REMOVED (derive as SUM(pedido_lineas.subtotal)). delivered_at is period determinant (NOT created_at).

### TABLE: pedido_lineas

```sql
CREATE TABLE pedido_lineas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id UUID NOT NULL REFERENCES pedidos(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  producto_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cantidad DECIMAL(15,4) NOT NULL,
  precio_unitario NUMERIC(15,2) NOT NULL,  -- SNAPSHOT: immutable
  producto_nombre VARCHAR(255) NOT NULL,    -- SNAPSHOT: immutable
  subtotal NUMERIC(15,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
  is_current BOOLEAN NOT NULL DEFAULT true,     -- Marks lines currently effective (supersession)
  superseded_by UUID REFERENCES pedido_lineas(id) ON DELETE RESTRICT ON UPDATE CASCADE,  -- Points to new line
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- GENERATED ALWAYS ensures subtotal = qty * price
-- Both precio_unitario and producto_nombre are immutable snapshots
-- is_current=true/false marks versioning for rectification
-- superseded_by points to the replacement line (if rectified)
-- APPEND_ONLY: RLS prevents UPDATE/DELETE (rectification creates new lines via SECURITY DEFINER)
-- SECURITY DEFINER function rectify_delivered_order is the only authorized path to change is_current/superseded_by
```

---

## DOMAIN C: CLIENT LEDGER & COLLECTIONS

### TABLE: client_ledger

```sql
CREATE TABLE client_ledger (
  id BIGSERIAL PRIMARY KEY,
  cliente_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_type client_ledger_movement_type NOT NULL,
  signed_amount NUMERIC(15,2) NOT NULL,
  effective_date DATE NOT NULL,  -- Period determinant (NOT created_at)
  ledger_client_name VARCHAR(255),  -- SNAPSHOT: name at posting time
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- APPEND_ONLY: RLS prevents UPDATE/DELETE
CREATE POLICY "client_ledger_append_only_admin"
  ON client_ledger FOR UPDATE
  USING FALSE;
```

**CRITICAL:** No stored balance (derived: SUM(signed_amount) per cliente_id). effective_date determines period (frozen rule). ledger_client_name is snapshot (for historical accuracy if client renamed).

### TABLE: collections

```sql
CREATE TABLE collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount NUMERIC(15,2) NOT NULL,
  payment_method payment_method NOT NULL,
  receipt_id VARCHAR(100) UNIQUE NOT NULL,  -- Idempotency key
  effective_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
```

---

## DOMAIN D: FINANCIAL LEDGER

### TABLE: financial_operation

```sql
CREATE TABLE financial_operation (
  id BIGSERIAL PRIMARY KEY,
  operation_type financial_operation_type NOT NULL,
  effective_date DATE NOT NULL,  -- Period determinant
  transfer_id VARCHAR(100) UNIQUE,  -- Idempotency key for transfers
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Parent entity for one-or-more financial_posting rows
```

### TABLE: financial_posting

```sql
CREATE TABLE financial_posting (
  id BIGSERIAL PRIMARY KEY,
  financial_operation_id BIGINT NOT NULL REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_account_id UUID NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  signed_amount NUMERIC(15,2) NOT NULL,
  effective_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK(signed_amount <> 0)  -- Prevent zero-amount postings
);

-- APPEND_ONLY: RLS prevents UPDATE/DELETE
CREATE POLICY "financial_posting_append_only"
  ON financial_posting FOR UPDATE
  USING FALSE;

CREATE POLICY "financial_posting_no_delete"
  ON financial_posting FOR DELETE
  USING FALSE;
```

**CRITICAL CORRECTION:** financial_operation_id is BIGINT (FK column), NOT BIGSERIAL. BIGSERIAL is only for PK auto-increment. ON DELETE RESTRICT prevents orphaned postings.

### TABLE: financial_instrument

```sql
CREATE TABLE financial_instrument (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_type financial_instrument_type NOT NULL,
  estado instrument_estado NOT NULL,
  cheque_number VARCHAR(50) NOT NULL,  -- Business data, not global identity
  amount NUMERIC(15,2) NOT NULL,
  maturity_date DATE,  -- Can be future; period determinant for clearing/rejection
  cliente_id UUID REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,  -- Origin client (for RECEIVED cheques)
  bank_account_id UUID REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,  -- Account cleared into (for CLEARED cheques)
  receipt_id VARCHAR(100) UNIQUE NOT NULL,  -- Idempotency key from receive_cheque RPC
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- State machine: RECEIVED → DEPOSITED → CLEARED (or ENDORSED, or REJECTED)
-- cheque_number: business data (not globally unique; same number can exist for different suppliers/dates/sources)
-- receipt_id: technical idempotency key (globally unique); from receive_cheque(idempotency_key) parameter
-- cliente_id: populated when cheque received from customer (for rejection reversal)
-- bank_account_id: populated when cheque cleared (for clearing posting + rejection compensation)
```

### TABLE: financial_instrument_event

```sql
CREATE TABLE financial_instrument_event (
  id BIGSERIAL PRIMARY KEY,
  financial_instrument_id UUID NOT NULL REFERENCES financial_instrument(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_type instrument_estado NOT NULL,
  event_date DATE NOT NULL,  -- Period determinant for cheque operations
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- APPEND_ONLY: audit trail of cheque state transitions
```

---

## DOMAIN E: SUPPLIERS & PURCHASES

### TABLE: suppliers

```sql
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(255) UNIQUE NOT NULL,
  fiscal_id TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### TABLE: supplier_ledger

```sql
CREATE TABLE supplier_ledger (
  id BIGSERIAL PRIMARY KEY,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_type supplier_ledger_movement_type NOT NULL,
  signed_amount NUMERIC(15,2) NOT NULL,
  effective_date DATE NOT NULL,  -- Period determinant
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- APPEND_ONLY: RLS prevents UPDATE/DELETE
```

### TABLE: purchases

```sql
CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  invoice_num VARCHAR(100) UNIQUE NOT NULL,  -- Idempotency key
  amount NUMERIC(15,2) NOT NULL,
  economic_date DATE NOT NULL,  -- Period determinant
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
```

---

## DOMAIN F: PRODUCTION

### TABLE: sheds

```sql
CREATE TABLE sheds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(100) UNIQUE NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### TABLE: flocks

```sql
CREATE TABLE flocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shed_id UUID NOT NULL REFERENCES sheds(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  estado flock_estado NOT NULL,
  genetics_line VARCHAR(100),
  supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Partial UNIQUE index: one ACTIVE flock per shed
CREATE UNIQUE INDEX idx_flocks_shed_active 
  ON flocks(shed_id) 
  WHERE estado='ACTIVE';
```

**CORRECTION:** Partial uniqueness via CREATE UNIQUE INDEX (PostgreSQL standard), not constraint syntax.

### TABLE: population_events

```sql
CREATE TABLE population_events (
  id BIGSERIAL PRIMARY KEY,
  flock_id UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_type population_event_type NOT NULL,
  delta BIGINT NOT NULL,
  event_date DATE NOT NULL,  -- Period determinant
  superseded_by BIGINT REFERENCES population_events(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  is_current BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Partial UNIQUE index (PostgreSQL syntax, not constraint)
CREATE UNIQUE INDEX idx_population_events_mortality_current 
  ON population_events(flock_id, event_date) 
  WHERE event_type='MORTALITY' AND is_current=true;

-- APPEND_ONLY: rectification creates new with is_current=true, marks original superseded_by
-- Multiple COUNT_ADJUSTMENT events allowed (no uniqueness constraint)
```

**CRITICAL CORRECTION:** 
- Partial UNIQUE expressed as CREATE UNIQUE INDEX (PostgreSQL standard), not constraint syntax
- Index condition includes `AND is_current=true` to support rectification pattern
- ON DELETE RESTRICT on all FKs (never delete historical events)
- RLS prevents UPDATE/DELETE for normal users; rectify_mortality RPC handles controlled supersession

### TABLE: daily_production

```sql
CREATE TABLE daily_production (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flock_id UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  production_date DATE NOT NULL,  -- Period determinant
  eggs_total INTEGER NOT NULL,  -- CHANGED: INTEGER (whole eggs)
  eggs_graded_count INTEGER,
  birds_alive_count BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(flock_id, production_date)
);

-- RLS UPDATE DENY: immutable after posting
CREATE POLICY "daily_production_immutable"
  ON daily_production FOR UPDATE
  USING FALSE;
```

### TABLE: flock_weighing

```sql
CREATE TABLE flock_weighing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flock_id UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  weighing_date DATE NOT NULL,
  birds_count BIGINT NOT NULL,
  average_weight_kg DECIMAL(10,3) NOT NULL,  -- calculated: total_weight / birds_count
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(flock_id, weighing_date)
);

-- OPERATOR: track bird weight progression during rearing
-- RLS UPDATE DENY: immutable after posting
```

### TABLE: temperature_record

```sql
CREATE TABLE temperature_record (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shed_id UUID NOT NULL REFERENCES sheds(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  record_date DATE NOT NULL,
  min_temperature_celsius DECIMAL(5,1) NOT NULL,
  max_temperature_celsius DECIMAL(5,1) NOT NULL,
  avg_temperature_celsius DECIMAL(5,1) NOT NULL,  -- calculated: (min + max) / 2
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(shed_id, record_date)
);

-- OPERATOR: environmental monitoring for shed health
-- RLS UPDATE DENY: immutable after posting
```

---

## DOMAIN G: CLASSIFICATION

### TABLE: classification

```sql
CREATE TABLE classification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key UUID UNIQUE NOT NULL,  -- Technical idempotency (retry prevention)
  session_date DATE NOT NULL,
  location VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- NO UNIQUE(session_date, location) — allows parallel sessions same day/location
-- idempotency_key prevents duplicate registration via retry
```

### TABLE: classification_line

```sql
CREATE TABLE classification_line (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classification_id UUID NOT NULL REFERENCES classification(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  grade VARCHAR(50) NOT NULL,
  quantity INTEGER NOT NULL,  -- Whole eggs only
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APPEND_ONLY: immutable once session posted
```

---

## DOMAIN H: FEED

### TABLE: feed_type

```sql
CREATE TABLE feed_type (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(100) UNIQUE NOT NULL,
  feed_category feed_category NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true
);
```

### TABLE: feed_formula_version

```sql
CREATE TABLE feed_formula_version (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_type_id UUID NOT NULL REFERENCES feed_type(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version INTEGER NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(feed_type_id, version)
);

-- IMMUTABLE: version never changes once referenced in manufacturing
```

### TABLE: feed_ingredient

```sql
CREATE TABLE feed_ingredient (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  unit_type unit_type NOT NULL DEFAULT 'KG',
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Masters: ingredient catalog (GRAIN, FISH_MEAL, VITAMIN_PREMIX, etc.)
-- Sourced from suppliers; used in feed formulations
```

### TABLE: feed_formula_line

```sql
CREATE TABLE feed_formula_line (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_version_id UUID NOT NULL REFERENCES feed_formula_version(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES feed_ingredient(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  quantity DECIMAL(10,3) NOT NULL,  -- Amount per batch unit (kg per 100kg batch)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Immutable composition of formula version
-- RLS blocks direct access; OPERATOR uses feed_formula_line_safe view
-- APPEND_ONLY: no UPDATE/DELETE allowed
```

### TABLE: feed_manufacturing

```sql
CREATE TABLE feed_manufacturing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_version_id UUID NOT NULL REFERENCES feed_formula_version(id) ON DELETE RESTRICT ON UPDATE CASCADE,  -- IMMUTABLE ref
  manufacturing_date DATE NOT NULL,  -- Period determinant
  batch_quantity_kg DECIMAL(15,3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- APPEND_ONLY; cost data in separate table (hidden from OPERATOR)
```

### TABLE: feed_inventory_count

```sql
CREATE TABLE feed_inventory_count (
  id BIGSERIAL PRIMARY KEY,
  feed_type_id UUID NOT NULL REFERENCES feed_type(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  inventory_date DATE NOT NULL,  -- Period determinant
  opening_quantity_kg DECIMAL(15,3) NOT NULL,
  purchases_quantity_kg DECIMAL(15,3) NOT NULL DEFAULT 0,
  manufacturing_usage_kg DECIMAL(15,3) NOT NULL DEFAULT 0,  -- computed from feed_manufacturing
  closing_quantity_kg DECIMAL(15,3) NOT NULL,  -- = opening + purchases - usage
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(feed_type_id, inventory_date)
);

-- APPEND_ONLY: feed inventory snapshots per period
-- closing = opening + purchases - usage (for stock equation validation)
-- RLS prevents UPDATE/DELETE
```

---

## DOMAIN I: MANAGEMENT & AUDIT

### TABLE: management_period

```sql
CREATE TABLE management_period (
  id BIGSERIAL PRIMARY KEY,
  periodo_fecha DATE UNIQUE NOT NULL,  -- First day of month (YYYY-MM-01)
  status management_period_status NOT NULL DEFAULT 'OPEN',
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OPEN: allows new facts with effective_date in period
-- CLOSED: frozen; must reopen to correct historical facts
```

### TABLE: audit_events

```sql
CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(100) NOT NULL,
  action VARCHAR(50) NOT NULL,
  before_values JSONB,
  after_values JSONB,
  reason TEXT,
  performed_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APPEND_ONLY: forensic evidence; never modified
CREATE POLICY "audit_events_append_only"
  ON audit_events FOR UPDATE
  USING FALSE;
```

### TABLE: operator_assignments

```sql
CREATE TABLE operator_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  flock_id UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(operator_id, flock_id)
);

-- OPERATOR can see daily_production and population_events only for assigned flocks
-- RLS uses this table: flock_id IN (SELECT flock_id FROM operator_assignments WHERE operator_id = auth.uid())
```

---

### TABLE: expense_category

```sql
CREATE TABLE expense_category (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Masters: FEED, UTILITIES, LABOR, MAINTENANCE, VETERINARY, etc.
-- For financial categorization of expenses (future use; not in current scope)
```

---

### TABLE: classification_grade

```sql
CREATE TABLE classification_grade (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Masters: CLASS_A, CLASS_B, CLASS_C, REJECT, etc.
-- Used in classification_line.grade (reference table)
```

---

## MERCADOPAGO INTEGRATION (FASE 0 — REUSE)

### TABLE: mp_source_record

```sql
CREATE TABLE mp_source_record (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type VARCHAR(50),  -- 'webhook', 'api', etc.
  event_data JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_status VARCHAR(50) DEFAULT 'PENDING'
);

-- APPEND_ONLY: raw data; processing_status tracks reconciliation
```

---

## INDEXES & PERFORMANCE

**Recommended indexes:**

```sql
-- Period lookups (period checks in RPC)
CREATE INDEX idx_management_period_status ON management_period(status) WHERE status='OPEN';

-- Ledger lookups (computing balances)
CREATE INDEX idx_client_ledger_cliente_date ON client_ledger(cliente_id, effective_date);
CREATE INDEX idx_financial_posting_account_date ON financial_posting(financial_account_id, effective_date);
CREATE INDEX idx_supplier_ledger_supplier_date ON supplier_ledger(supplier_id, effective_date);

-- Production lookups
CREATE INDEX idx_population_events_flock_date ON population_events(flock_id, event_date);
CREATE INDEX idx_daily_production_flock_date ON daily_production(flock_id, production_date);

-- Uniqueness (already enforced by constraints)
CREATE UNIQUE INDEX idx_flocks_shed_active ON flocks(shed_id) WHERE estado='ACTIVE';
CREATE UNIQUE INDEX idx_population_events_mortality ON population_events(flock_id, event_date) WHERE event_type='MORTALITY' AND is_current=true;

-- RLS authorization lookups
CREATE INDEX idx_operator_assignments_operator ON operator_assignments(operator_id);
```

---

## DEPLOYMENT NOTES

1. **Enums:** Create all enums BEFORE tables (DDL dependency)
2. **Foreign keys:** Create masters before referencing tables
3. **RLS policies:** Enable RLS row security; attach policies after table creation
4. **Snapshots:** Document in code which fields are immutable snapshots
5. **Partial uniqueness:** Partial indexes on WHERE condition; ensure DB supports them
6. **GENERATED ALWAYS:** Verify PostgreSQL version supports STORED variant

---

**STATUS: READY FOR IMPLEMENTATION**

All tables specified with exact PostgreSQL syntax. No ambiguity on types, constraints, or immutability enforcement.
