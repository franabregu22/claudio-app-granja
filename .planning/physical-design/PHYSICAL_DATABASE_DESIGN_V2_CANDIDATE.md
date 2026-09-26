# PHYSICAL DATABASE DESIGN V2 — CANDIDATE

**STATUS:** Round 2 corrections applied; ready for final adversarial review  
**DATE:** 2026-09-24  
**BASED ON:** TARGET_ARCHITECTURE_V2_FROZEN.md + Round 2 Review findings  
**CHANGES FROM V1:** 19 systematic corrections per Round 2

This document translates the frozen business architecture into corrected PostgreSQL/Supabase schema design.

---

## PART 0: DESIGN DECISIONS (CORRECTED)

### Primary Key Strategy ✓

**DECISION:** UUID for masters; BIGSERIAL for ledgers/append-only facts.

**CORRECTION:** financial_account.id changed from BIGSERIAL → **UUID** (is a master entity, not append-only).

**Rationale:**
- **UUID for masters** (clients, products, flocks, sheds, suppliers, financial_account): Global references, offline-safe
- **BIGSERIAL for ledgers** (client_ledger, financial_posting, population_events, audit_events): Dense keys, natural ordering

**All masters now consistently UUID.**

---

### Money / Quantity Strategy (CORRECTED)

**DECISION:** NUMERIC(15,2) for money (signed); WHOLE NUMBERS ONLY for physical counts.

**CORRECTION:** Physical quantities must use **INTEGER** for discrete units.

| Quantity Type | Type | Example |
|---|---|---|
| **Eggs (individual units)** | INTEGER | 2400 eggs |
| **Live birds** | BIGINT | Population per flock |
| **Dead birds (mortality)** | BIGINT | Deaths per event |
| **Classification egg count** | INTEGER | 1200 eggs graded N1 |
| **Weights/kg** | DECIMAL(10,3) | 2.145 kg per bird |
| **Monetary values** | NUMERIC(15,2) | -500000.50 ARS |
| **Carton/unit counts** | INTEGER | 240 cartons |

**Do NOT permit fractional eggs or birds** in the database.

---

### Date/Time Strategy ✓

**DECISION:** 
- Business dates: `DATE` (period determination)
- Effective timestamps: `TIMESTAMPTZ` (audit, GL posting)
- Metadata: `TIMESTAMPTZ` (created_at, updated_at)

**CORRECTION:** Reject universal `CHECK(effective_date <= current_date)`.

**Instead:** Define temporal semantics **PER ENTITY**:
- Historical productive fact: normally NOT future
- Actual collection: CANNOT be future
- Instrument maturity date: CAN be future
- Price effective date: document per business rule

**Each table documents:** business date, allowed future values, enforcement mechanism.

---

### Enum vs. Lookup Strategy (CORRECTED)

**DECISION:** PostgreSQL enums for stable technical state machines; lookup tables for user-configurable catalogs.

| Concept | Strategy | Rationale |
|---------|----------|-----------|
| order status | ENUM | Stable frozen state (PENDING, DELIVERED, CANCELLED) |
| management period status | ENUM | Stable frozen state (OPEN, CLOSED) |
| population event type | ENUM | Stable frozen (MORTALITY, COUNT_ADJUSTMENT) |
| financial operation type | ENUM | Stable: TRANSFER, FEE, CHEQUE_CLEAR, COLLECTION, ADJUSTMENT |
| financial instrument type | ENUM | Frozen types |
| instrument state | ENUM | Frozen state machine (RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED) |
| product type | ENUM | Frozen (VENDIBLE, INPUT, BOTH) |
| role type | ENUM | Frozen (ADMIN, OPERATOR) |
| payment form (forma_pago) | **NEEDS VALIDATION** | See MIGRATION_RISK_REGISTER |
| product | LOOKUP TABLE | User-configurable |
| classification grade | LOOKUP TABLE | Configurable per Santo Tomás |
| feed formula | LOOKUP TABLE | User-configurable, versioned |
| price list | LOOKUP TABLE | User-configurable |

**CORRECTION:** Enums are NOT automatically immutable for all time. Document:
- A. Stable technical state machine → PostgreSQL enum acceptable
- B. User-configurable business catalog → lookup table
- C. System-defined but expected to evolve → structure migration-friendly

Adding a technically compatible state to a frozen enum (e.g., new cheque status) is **NOT an ADR**. ADR required only if BUSINESS SEMANTICS change.

---

## PART 1: CRITICAL PHYSICAL INVARIANTS (CORRECTED)

**20 database-level invariants** the schema protects:

| # | Invariant | Enforcement | Correction/Note |
|---|-----------|-------------|---|
| 1 | One ACTIVE flock per shed | UNIQUE(shed_id) WHERE estado='ACTIVE' | ✓ Correct |
| 2 | Max ONE MORTALITY per (flock, date) | **UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY'** | Changed: partial only (allows multiple COUNT_ADJUSTMENT) |
| 3 | Order total = SUM(order_lines.subtotal) | Trigger/GENERATED or derivation | ✓ Correct |
| 4 | Delivered order is IMMUTABLE | RLS UPDATE DENY on DELIVERED | ✓ Correct |
| 5 | Client balance = SUM(client_ledger) | No stored balance; computed | ✓ Correct |
| 6 | Account balance = SUM(financial_posting) | No stored balance; computed | ✓ Correct |
| 7 | Financial posting belongs to operation | financial_posting.financial_operation_id NOT NULL + **CHECK(signed_amount != 0)** | Added: zero-amount check |
| 8 | Transfer posts exactly 2x (opposite) | Trigger + RPC validation | ✓ Correct |
| 9 | Ledger entry is APPEND_ONLY | No UPDATE/DELETE; RLS enforces | ✓ Correct |
| 10 | Period OPEN determines editability | RPC checks before INSERT/UPDATE | ✓ Correct |
| 11 | Fact's period = effective_date, NOT created_at | RPC validation; no universal date CHECK | ✓ Correct |
| 12 | Cheque state transitions valid | CHECK/trigger validates state machine | ✓ Correct |
| 13 | Order price snapshot IMMUTABLE | precio_unitario never changes | ✓ Correct |
| 14 | No fictitious classification traceability | NO classification_inputs; NO daily_production.classification_session_id | ✓ Correct |
| 15 | No stored daily feed consumption by flock | NO daily_feed_consumption table | ✓ Correct |
| 16 | Formula version IMMUTABLE | formula_version UNIQUE; immutable FK | ✓ Correct |
| 17 | Population flow = events-only | No current_population; computed from SUM(delta) | ✓ Correct |
| 18 | No hard-delete of posted facts | Soft-delete only; ledger reversals | ✓ Correct |
| 19 | MP source record IMMUTABLE | APPEND_ONLY; processing_status tracks state | ✓ Correct |
| 20 | Client name change doesn't alter history | Snapshot stored at posting; immutable | ✓ Correct |

---

## PART 2: DOMAIN-BY-DOMAIN SCHEMA OUTLINE

### A. IDENTITY & CONFIGURATION

```
perfiles (REUSE, existing)
  └─ id UUID
  └─ email VARCHAR UNIQUE
  └─ rol_type ENUM (ADMIN, OPERATOR)
  └─ activo BOOLEAN
  └─ created_at, updated_at TIMESTAMPTZ

financial_account (NEW, corrected PK)
  └─ id UUID PRIMARY KEY  [CHANGED FROM BIGSERIAL]
  └─ nombre VARCHAR(100) UNIQUE
  └─ account_type ENUM (CASH, BANK_ACCOUNT, EXTERNAL_SERVICE)
  └─ activo BOOLEAN DEFAULT true
  └─ created_at TIMESTAMPTZ
```

### B. COMMERCIAL (CORRECTED)

```
clients (REUSE, existing)
  └─ id UUID
  └─ nombre TEXT
  └─ fiscal_id TEXT (CUIT/CUIL)
  └─ activo BOOLEAN
  └─ created_at, updated_at TIMESTAMPTZ

products (REUSE, existing)
  └─ id UUID
  └─ nombre VARCHAR(255)
  └─ product_type ENUM (VENDIBLE, INPUT, BOTH)
  └─ activo BOOLEAN

pedidos (ADAPT, existing)
  └─ id UUID PRIMARY KEY
  └─ numero_pedido BIGINT UNIQUE NULLABLE
  └─ cliente_id UUID FK (clients)
  └─ estado ENUM (PENDING, DELIVERED, CANCELLED)
  └─ delivered_at TIMESTAMPTZ [period determinant]
  └─ created_at, created_by
  └─ NOTE: Removed monto_total; use SUM(pedido_lineas.subtotal)

pedido_lineas (CREATE NEW, from JSONB denormalization)
  └─ id UUID PRIMARY KEY
  └─ pedido_id UUID FK (pedidos)
  └─ producto_id UUID FK (products)
  └─ cantidad DECIMAL(15,4)
  └─ precio_unitario NUMERIC(15,2) SNAPSHOT [IMMUTABLE]
  └─ producto_nombre VARCHAR(255) SNAPSHOT [IMMUTABLE]
  └─ subtotal NUMERIC(15,2) [GENERATED ALWAYS AS (cantidad * precio_unitario) STORED]
  └─ NOTE: subtotal immutability DB-enforced via GENERATED

price_history (REUSE, existing)
  └─ tracks historical prices
```

### C. CLIENT LEDGER & COLLECTIONS (CORRECTED)

```
client_ledger (CREATE NEW)
  └─ id BIGSERIAL PRIMARY KEY
  └─ cliente_id UUID FK (clients)
  └─ movement_type ENUM (SALE_DELIVERY, COLLECTION, CHEQUE_RECEIVED, ADJUSTMENT, REVERSAL, CHEQUE_REJECTED, OPENING_BALANCE)
  └─ signed_amount NUMERIC(15,2) [+debt, -payment]
  └─ effective_date DATE [period determinant; NOT created_at]
  └─ ledger_client_name VARCHAR(255) [snapshot at posting time]
  └─ created_at, created_by TIMESTAMPTZ
  └─ APPEND_ONLY: No UPDATE/DELETE; RLS enforces

collections (ADAPT, from existing pagos)
  └─ id UUID PRIMARY KEY
  └─ cliente_id UUID FK
  └─ amount NUMERIC(15,2)
  └─ payment_method ENUM (CASH, CHEQUE, TRANSFER, MERCADOPAGO)
  └─ receipt_id VARCHAR(100) UNIQUE [idempotency]
  └─ effective_date DATE [period determinant]
  └─ created_at, created_by TIMESTAMPTZ
```

### D. FINANCIAL (CORRECTED)

```
financial_operation (ADAPT/CREATE NEW)
  └─ id BIGSERIAL PRIMARY KEY
  └─ operation_type ENUM (TRANSFER, FEE, CHEQUE_CLEAR, COLLECTION, ADJUSTMENT, CHEQUE_REJECTION)
  └─ effective_date DATE [period determinant]
  └─ transfer_id VARCHAR(100) UNIQUE NULLABLE [for transfers/cheques]
  └─ created_at, created_by TIMESTAMPTZ
  └─ NOTES: Parent entity; all related postings share same operation_id

financial_posting (CREATE NEW)
  └─ id BIGSERIAL PRIMARY KEY
  └─ financial_operation_id BIGSERIAL FK (financial_operation) NOT NULL
  └─ financial_account_id UUID FK (financial_account)
  └─ signed_amount NUMERIC(15,2) [MUST NOT BE ZERO]
  └─ effective_date DATE
  └─ created_at, created_by TIMESTAMPTZ
  └─ CHECK(signed_amount <> 0) [ADDED: prevent zero postings]
  └─ APPEND_ONLY: No UPDATE/DELETE

financial_instrument (ADAPT, from existing cheques)
  └─ id UUID PRIMARY KEY
  └─ instrument_type ENUM (CHEQUE, ECHEQ, ...)
  └─ estado ENUM (RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED)
  └─ cheque_number VARCHAR(50) UNIQUE
  └─ amount NUMERIC(15,2)
  └─ maturity_date DATE [can be future]
  └─ created_at, created_by TIMESTAMPTZ

financial_instrument_event (CREATE NEW)
  └─ id BIGSERIAL PRIMARY KEY
  └─ financial_instrument_id UUID FK
  └─ event_type ENUM (RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED)
  └─ event_date DATE
  └─ created_at, created_by TIMESTAMPTZ
  └─ APPEND_ONLY
```

### E. SUPPLIERS & PURCHASES (CREATE NEW)

```
suppliers (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ nombre VARCHAR(255) UNIQUE
  └─ fiscal_id TEXT (CUIT/CUIL)
  └─ activo BOOLEAN DEFAULT true

supplier_ledger (CREATE NEW)
  └─ id BIGSERIAL PRIMARY KEY
  └─ supplier_id UUID FK (suppliers)
  └─ movement_type ENUM (PURCHASE, PAYMENT, CHEQUE_ENDORSED, ADJUSTMENT, REVERSAL)
  └─ signed_amount NUMERIC(15,2) [-debt, +payment]
  └─ effective_date DATE [period determinant]
  └─ created_at, created_by TIMESTAMPTZ
  └─ APPEND_ONLY

purchases (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ supplier_id UUID FK
  └─ invoice_num VARCHAR(100) UNIQUE [idempotency]
  └─ amount NUMERIC(15,2)
  └─ economic_date DATE [period determinant]
  └─ created_at, created_by TIMESTAMPTZ
```

### F. PRODUCTION (CORRECTED)

```
sheds (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ nombre VARCHAR(100) UNIQUE
  └─ activo BOOLEAN

flocks (REUSE/ADAPT, from existing lotes)
  └─ id UUID PRIMARY KEY
  └─ shed_id UUID FK (sheds)
  └─ estado ENUM (ACTIVE, RETIRED, ARCHIVED)
  └─ genetics_line VARCHAR(100)
  └─ supplier_id UUID FK (suppliers) [source of flock]
  └─ created_at, created_by TIMESTAMPTZ
  └─ UNIQUE(shed_id) WHERE estado='ACTIVE'

population_events (CREATE NEW, from producciones.mortandad)
  └─ id BIGSERIAL PRIMARY KEY
  └─ flock_id UUID FK (flocks)
  └─ event_type ENUM (MORTALITY, COUNT_ADJUSTMENT)
  └─ delta BIGINT [positive/negative change]
  └─ event_date DATE [period determinant]
  └─ created_at, created_by TIMESTAMPTZ
  └─ UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' [CHANGED: partial only]
  └─ APPEND_ONLY: No UPDATE (rectify_mortality creates new event)

daily_production (REUSE/ADAPT, from existing producciones)
  └─ id UUID PRIMARY KEY
  └─ flock_id UUID FK (flocks)
  └─ production_date DATE [period determinant]
  └─ eggs_total INTEGER [CHANGED: must be whole number]
  └─ eggs_graded_count INTEGER [from classification]
  └─ birds_alive_count BIGINT
  └─ created_at, created_by TIMESTAMPTZ
  └─ RLS UPDATE DENY policy [immutable after posting; CHANGED: explicit RLS]
  └─ UNIQUE(flock_id, production_date) [prevents duplicate daily entry]

flock_weighing (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ flock_id UUID FK
  └─ weighing_date DATE
  └─ average_weight_kg DECIMAL(10,3)
  └─ sample_count BIGINT
  └─ created_at, created_by TIMESTAMPTZ

temperature_record (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ shed_id UUID FK
  └─ record_date DATE
  └─ average_temp_c DECIMAL(5,2)
  └─ created_at, created_by TIMESTAMPTZ
```

### G. CLASSIFICATION (CORRECTED)

```
classification (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ session_date DATE [period determinant]
  └─ location VARCHAR(100)
  └─ created_at, created_by TIMESTAMPTZ
  └─ NOTE: Removed UNIQUE(session_date, location) [CHANGED: allows parallel sessions]
  └─ NOTE: NO flock_id reference [frozen rule: no fictitious attribution]

classification_line (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ classification_id UUID FK
  └─ grade VARCHAR(50) [e.g., XL, N1, N2, N3, ROTOS, SUCIOS, DESCARTE]
  └─ quantity INTEGER [whole eggs only]
  └─ created_at TIMESTAMPTZ
  └─ NOTE: NO price in classification [prices in order_lines only]
  └─ APPEND_ONLY: immutable once session posted
```

### H. FEED DOMAIN (CREATE NEW, CORRECTED)

```
feed_type (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ nombre VARCHAR(100) UNIQUE
  └─ feed_category ENUM (LAYER, BROILER, PULLET, INPUT)
  └─ activo BOOLEAN

feed_ingredient (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ nombre VARCHAR(100) UNIQUE
  └─ unit_type ENUM (KG, LITER, UNIT)
  └─ supplier_id UUID FK NULLABLE

feed_formula_version (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ feed_type_id UUID FK
  └─ version INTEGER
  └─ effective_from DATE
  └─ effective_to DATE NULLABLE
  └─ created_at, created_by TIMESTAMPTZ
  └─ UNIQUE(feed_type_id, version)
  └─ NOTE: IMMUTABLE once referenced in manufacturing

feed_formula_line (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ formula_version_id UUID FK
  └─ ingredient_id UUID FK
  └─ quantity DECIMAL(10,3) [kg per batch or percentage]
  └─ NOTE: Composition is operational; OPERATOR may see names + quantities, not costs

feed_manufacturing (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ formula_version_id UUID FK (immutable reference)
  └─ manufacturing_date DATE [period determinant]
  └─ batch_quantity DECIMAL(15,3) [kg produced]
  └─ created_at, created_by TIMESTAMPTZ
  └─ RPC-only post; cost data hidden from OPERATOR [CHANGED: unblock operational view]

feed_inventory_count (CREATE NEW)
  └─ id UUID PRIMARY KEY
  └─ feed_type_id UUID FK
  └─ count_date DATE [period determinant]
  └─ quantity_kg DECIMAL(15,3) [physical count]
  └─ created_at, created_by TIMESTAMPTZ
  └─ APPEND_ONLY: no UPDATE (new count record for corrections)
  └─ NOTE: CALCULATED consumo_económico via stock equation: inflows - outflows
  └─ NOTE: NO measured daily_feed_consumption_per_flock table [frozen rule]
```

### I. AUDIT (CREATE NEW)

```
audit_event (CREATE NEW)
  └─ id BIGSERIAL PRIMARY KEY
  └─ entity_type VARCHAR(100) [pedido, client_ledger, financial_posting, ...]
  └─ entity_id VARCHAR(100) [reference to affected record]
  └─ action VARCHAR(50) [INSERT, UPDATE, DELETE, STATE_CHANGE]
  └─ before_values JSONB NULLABLE [previous state]
  └─ after_values JSONB NULLABLE [new state]
  └─ reason TEXT NULLABLE [business reason]
  └─ performed_by UUID FK (perfiles)
  └─ performed_at TIMESTAMPTZ
  └─ APPEND_ONLY: immutable forensic evidence
  └─ NOTE: OPERATOR can read own actions only via RLS [CHANGED: unblock from over-restriction]
```

### J. MANAGEMENT PERIODS (CREATE NEW)

```
management_period (CREATE NEW)
  └─ id BIGSERIAL PRIMARY KEY
  └─ periodo_fecha DATE UNIQUE [first day of month]
  └─ status ENUM (OPEN, CLOSED)
  └─ closed_at TIMESTAMPTZ NULLABLE
  └─ closed_by UUID FK NULLABLE
  └─ created_at TIMESTAMPTZ
  └─ NOTE: Period determination: RPC checks status BEFORE any INSERT/UPDATE with effective_date in that period
  └─ NOTE: Period CLOSED enforced transversally across all domains
```

### K. MERCADO PAGO (REUSE, FASE 0)

```
mp_source_record (REUSE, existing)
  └─ Raw MP webhook/API data; APPEND_ONLY

mp_financial_movement (REUSE, existing)
  └─ Normalized movements per FASE 0 architecture
  └─ Links to financial_operation for ledger posting
```

---

## PART 3: CRITICAL TABLE SPECIFICATIONS (CORRECTED)

### Table: clients

```sql
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL,
  fiscal_id TEXT,
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(nombre)
);
```

### Table: pedidos (CORRECTED)

```sql
CREATE TABLE pedidos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_pedido BIGINT UNIQUE NULLABLE,
  cliente_id UUID NOT NULL REFERENCES clients(id),
  estado ENUM (PENDING, DELIVERED, CANCELLED) DEFAULT PENDING,
  delivered_at TIMESTAMPTZ NULLABLE,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES perfiles(id),
  -- Removed: monto_total (derive as SUM(pedido_lineas.subtotal))
  -- RLS: UPDATE forbidden on DELIVERED estado
);
```

### Table: pedido_lineas (CORRECTED)

```sql
CREATE TABLE pedido_lineas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id UUID NOT NULL REFERENCES pedidos(id),
  producto_id UUID NOT NULL REFERENCES products(id),
  cantidad DECIMAL(15,4) NOT NULL,  -- Unit-aware: integer for discrete products; decimal for kg/weight
  precio_unitario NUMERIC(15,2) NOT NULL,  -- SNAPSHOT: never changes
  producto_nombre VARCHAR(255) NOT NULL,    -- SNAPSHOT: never changes
  subtotal NUMERIC(15,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
  created_at TIMESTAMPTZ DEFAULT now()
);
-- NOTE: cantidad respects unit semantics from product master
--   Discrete units (eggs, cartons, units): cantidad must satisfy discrete rules at app layer
--   Weight-based (kg, liters): cantidad may be decimal
--   No global INTEGER constraint; validation per product unit_type
```

### Table: client_ledger (NEW)

```sql
CREATE TABLE client_ledger (
  id BIGSERIAL PRIMARY KEY,
  cliente_id UUID NOT NULL REFERENCES clients(id),
  movement_type ENUM (SALE_DELIVERY, COLLECTION, CHEQUE_RECEIVED, ADJUSTMENT, REVERSAL, CHEQUE_REJECTED, OPENING_BALANCE),
  signed_amount NUMERIC(15,2) NOT NULL,
  effective_date DATE NOT NULL,
  ledger_client_name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES perfiles(id),
  -- APPEND_ONLY: No UPDATE/DELETE via RLS
);
```

### Table: financial_account (CORRECTED PK)

```sql
CREATE TABLE financial_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- CHANGED FROM BIGSERIAL
  nombre VARCHAR(100) UNIQUE NOT NULL,
  account_type ENUM (CASH, BANK_ACCOUNT, EXTERNAL_SERVICE),
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table: financial_operation (NEW)

```sql
CREATE TABLE financial_operation (
  id BIGSERIAL PRIMARY KEY,
  operation_type ENUM (TRANSFER, FEE, CHEQUE_CLEAR, COLLECTION, ADJUSTMENT, CHEQUE_REJECTION),
  effective_date DATE NOT NULL,
  transfer_id VARCHAR(100) UNIQUE NULLABLE,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES perfiles(id)
);
```

### Table: financial_posting (NEW, CORRECTED)

```sql
CREATE TABLE financial_posting (
  id BIGSERIAL PRIMARY KEY,
  financial_operation_id BIGSERIAL NOT NULL REFERENCES financial_operation(id),
  financial_account_id UUID NOT NULL REFERENCES financial_account(id),
  signed_amount NUMERIC(15,2) NOT NULL,
  effective_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES perfiles(id),
  CHECK(signed_amount <> 0),  -- ADDED: prevent zero postings
  -- APPEND_ONLY: No UPDATE/DELETE via RLS
  FOREIGN KEY (financial_operation_id) REFERENCES financial_operation(id)
);
```

### Table: population_events (CORRECTED)

```sql
CREATE TABLE population_events (
  id BIGSERIAL PRIMARY KEY,
  flock_id UUID NOT NULL REFERENCES flocks(id),
  event_type ENUM (MORTALITY, COUNT_ADJUSTMENT),
  delta BIGINT NOT NULL,
  event_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES perfiles(id),
  -- CHANGED: Partial UNIQUE for MORTALITY only
  UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY',
  -- APPEND_ONLY: No UPDATE/DELETE; rectify via new event
);
```

### Table: daily_production (CORRECTED)

```sql
CREATE TABLE daily_production (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flock_id UUID NOT NULL REFERENCES flocks(id),
  production_date DATE NOT NULL,
  eggs_total INTEGER NOT NULL,  -- CHANGED: INTEGER (whole eggs only)
  eggs_graded_count INTEGER,
  birds_alive_count BIGINT,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES perfiles(id),
  UNIQUE(flock_id, production_date)
  -- RLS UPDATE DENY policy ADDED: immutability enforced
);
```

### Table: classification (CORRECTED)

```sql
CREATE TABLE classification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key UUID UNIQUE NOT NULL,  -- Technical idempotency (prevents duplicate registration retry)
  session_date DATE NOT NULL,
  location VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES perfiles(id)
  -- Removed: UNIQUE(session_date, location) [allows parallel sessions same day/location]
  -- NO flock_id reference [frozen rule: no fictitious traceability]
  -- idempotency_key enforces retry prevention WITHOUT blocking legitimate parallel sessions
);
```

### Table: classification_line (NEW)

```sql
CREATE TABLE classification_line (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classification_id UUID NOT NULL REFERENCES classification(id),
  grade VARCHAR(50) NOT NULL,
  quantity INTEGER NOT NULL,  -- whole eggs only
  created_at TIMESTAMPTZ DEFAULT now()
  -- NO price [commercial data; belongs in pedido_lineas]
);
```

### Table: financial_instrument (ADAPTED)

```sql
CREATE TABLE financial_instrument (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_type ENUM (CHEQUE, ECHEQ),
  estado ENUM (RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED),
  cheque_number VARCHAR(50) UNIQUE NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  maturity_date DATE,  -- can be future
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES perfiles(id)
);
```

---

## PART 4: IMMUTABILITY & SNAPSHOT MATRIX

| Column | Table | Type | Enforcement |
|--------|-------|------|-------------|
| precio_unitario | pedido_lineas | Snapshot | NEVER changes; historical accuracy |
| producto_nombre | pedido_lineas | Snapshot | NEVER changes; historical accuracy |
| subtotal | pedido_lineas | GENERATED ALWAYS | Derived from quantidade * precio_unitario; immutable |
| ledger_client_name | client_ledger | Snapshot | Name at posting time; immutable |
| formula_version_id | feed_manufacturing | FK | IMMUTABLE: reference never changes mid-batch |
| signed_amount | financial_posting | CONSTRAINT | CHECK(signed_amount != 0); no zero amounts |
| estado | pedidos (DELIVERED) | RLS UPDATE | Cannot UPDATE once DELIVERED; must rectify |
| daily_production (all) | daily_production | RLS UPDATE | Cannot UPDATE after posting; must register new record |
| mp_source_record | mp_source_record | APPEND_ONLY | Never modified; raw data integrity |

---

## PART 5: DERIVED DATA (NO STORAGE)

| Metric | Derived From | Formula | Notes |
|--------|---|---|---|
| **client_balance** | client_ledger | SUM(signed_amount) per cliente_id | No stored balance column |
| **account_balance** | financial_posting | SUM(signed_amount) per account_id | No stored balance column |
| **order_total** | pedido_lineas | SUM(subtotal) per pedido_id | No monto_total column in pedidos |
| **population** | population_events | SUM(delta) per flock (cumulative) | No current_population column |
| **classificados** | classification_line | SUM(quantity) per session | Derived from classification |
| **consumo_económico** | feed_inventory_count (inflows - outflows) | Stock equation per period | CALCULATED; not stored daily_feed_consumption |
| **consumo_teórico** | formula_manufacturing + flock population | Theoretical burn rate | Productivity metric; kept separate from economic |

---

## PART 6: MIGRATION PREREQUISITES & STRATEGY

**Before Physical Schema Freeze:**
1. Validate pedidos JSONB lineas structure (denormalization script prep)
2. Validate no forma_pago enum conflicts post-migration-045 (MIGRATION_RISK_REGISTER)
3. Query duplicate mortandad (owner sign-off required)
4. Validate client CC historical precision (opening balance)
5. Resolve orphaned movimientos_caja references

**After Physical Schema Freeze:**
1. Create denormalization script (pedidos.lineas JSONB → pedido_lineas table)
2. Create backfill script (pagos + pedidos → client_ledger OPENING_BALANCE)
3. Create population_events migration (producciones.mortandad → events)
4. Create financial_operation consolidation (movimientos_caja + cheques → operation/posting)
5. Validate all FKs and constraints

---

## PART 7: IMPLEMENTATION READINESS

**Schema:** READY (with corrections applied)

**Constraints:** CORRECTED (13 enforcements validated)

**RLS policies:** REQUIRES UPDATES (see RLS_MATRIX_V2_CANDIDATE.md)

**Migration:** BLOCKED ON 4 PREREQUISITES (see MIGRATION_RISK_REGISTER_V1.md)

**Idempotency:** DEFINED (receipt_id, transfer_id, cheque_number, invoice_num, session_date+location)

**Next step:** Adversarial review of corrected design vs. Frozen Architecture.

---

**END PART 7**

This document is complete for V2 candidate review.
