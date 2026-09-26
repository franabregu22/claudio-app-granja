# PHYSICAL DATABASE DESIGN V1 — ROUND 1

**STATUS:** Ready for Physical Design Review  
**DATE:** 2026-09-24  
**BASED ON:** TARGET_ARCHITECTURE_V2_FROZEN.md + 4-agent analysis

This document translates the frozen business architecture into a concrete PostgreSQL/Supabase schema design.

---

## PART 0: DESIGN DECISIONS

### Primary Key Strategy

**DECISION:** UUID for masters (business entities); BIGSERIAL for ledgers/append-only facts.

**Rationale:**
- **UUID for masters** (clients, products, flocks, sheds, suppliers, financial_account): Global references, offline-safe, federation-ready
- **BIGSERIAL for ledgers** (client_ledger, financial_posting, population_event, audit_event): Dense integer keys, natural ordering, performance-optimal for range queries

**Exceptions:** None planned for V1.

### Money / Quantity Strategy

**DECISION:** NUMERIC(15,2) for money (signed amounts); DECIMAL(15,4) for quantities (fractional kg, eggs per unit).

**Rationale:**
- No floating-point for money (precision loss)
- Signed amounts for debits/credits (- = out; + = in)
- Currency: Argentine Peso (ARS) assumed; no multi-currency V1

**Examples:**
```sql
financial_posting.signed_amount NUMERIC(15,2)   -- -500000.50 = debit
collection.amount NUMERIC(15,2)
order_lines.subtotal NUMERIC(15,2)

daily_production.eggs_total DECIMAL(15,4)        -- 1234.5678 docenas
population_event.delta BIGINT                    -- birds (count, not decimal)
flock_weighing.average_weight DECIMAL(10,3)     -- kg per bird
```

### Date/Time Strategy

**DECISION:** 
- Business dates: `DATE` (no timezone)
- Effective timestamps: `TIMESTAMPTZ` (immutable, audit)
- Metadata: `TIMESTAMPTZ` (created_at, updated_at)
- External occurrences: `TIMESTAMPTZ` (MP occurred_at, cheque clearing_at)

**Timezone handling:** Argentina (UTC-3 / UTC-3:30). Stored as UTC; displayed in local TZ by app layer.

**Key invariant:** `created_at` NEVER determines a fact's period. Use `effective_date` per frozen rules.

**Examples:**
```sql
pedidos.delivered_at TIMESTAMPTZ         -- when order economically posted
population_event.event_date DATE         -- production date (no time needed)
management_periods.period_date DATE      -- start of month
financial_posting.effective_date DATE    -- GL posting date (period determinant)
audit_event.performed_at TIMESTAMPTZ     -- audit trail timestamp
```

### Enum vs. Lookup Strategy

**DECISION:** PostgreSQL enums for stable technical states; lookup tables for user-configurable catalogs.

| Concept | Strategy | Reason |
|---------|----------|--------|
| order status (PENDING, DELIVERED, CANCELLED) | ENUM | Frozen, immutable business states |
| management period status (OPEN, CLOSED) | ENUM | Frozen states |
| population event type (MORTALITY, COUNT_ADJUSTMENT) | ENUM | Frozen business logic |
| financial operation type (TRANSFER, FEE, CHEQUE_CLEAR, COLLECTION, ADJUSTMENT) | ENUM | Frozen + adds new as needed |
| financial instrument type (CHEQUE, ECHEQ, ...) | ENUM | Frozen |
| instrument state (RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED) | ENUM | Frozen state machine |
| product type (VENDIBLE, INPUT, BOTH) | ENUM | Frozen |
| role type (ADMIN, OPERATOR) | ENUM | Frozen |
| product (eggs XL, N1, feed types, raw materials) | LOOKUP TABLE (products) | User-configurable catalog |
| price list (Mayorista, Minorista, ...) | LOOKUP TABLE (price_lists) | User-configurable |
| feed formulation (names, recipes) | LOOKUP TABLE (feed_formula_version) | User-configurable, versioned |
| classification grade (XL, N1, N2, N3, Rotos, Sucios, Descarte) | LOOKUP TABLE (classification_grade) | Configurable per Santo Tomás |
| expense category (OPERATING, REINVESTMENT, INVESTMENT) | LOOKUP TABLE (expense_category) | Configurable |
| fiscal document type (INVOICE, CREDIT_NOTE, ...) | LOOKUP TABLE | Configurable |

### Delete / Immutability Strategy

**DECISION:** RESTRICT for all historical facts; soft-delete (activo flag) for masters; reversals/compensations for corrections.

| Entity Type | Strategy | Reason |
|---|---|---|
| Masters (clients, products, suppliers) | SOFT-DELETE (activo=false) | Historical reference must survive |
| Ledger entries (client_ledger, financial_posting, population_event) | APPEND_ONLY | Immutable audit trail |
| Committed facts (DELIVERED pedidos, CLOSED cheques) | RESTRICT + immutability constraint | Cannot delete; rectify instead |
| Draft/pending facts (PENDING pedidos, DRAFT purchases) | RESTRICT (may be cancelled) | No hard-delete; transition to CANCELLED |
| Audit events | APPEND_ONLY immutable | Forensic evidence |
| Raw MP data (mp_source_record) | APPEND_ONLY | Immutable source |

---

## PART 1: CRITICAL PHYSICAL INVARIANTS

**20 database-level invariants** the schema must protect:

| # | Invariant | Enforcement | Why |
|---|-----------|-------------|-----|
| 1 | One ACTIVE flock per shed | UNIQUE(shed_id) WHERE estado='ACTIVE' + trigger | Operational requirement |
| 2 | Max ONE MORTALITY per (flock_id, event_date) | UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' | Frozen rule: no duplicates |
| 3 | Order total = SUM(order_lines.subtotal) | Computed (no stored monto_total); trigger validates | Single source of truth |
| 4 | Delivered order is IMMUTABLE | CHECK + RLS (UPDATE forbidden on DELIVERED) | Frozen: immutability post-posting |
| 5 | Client balance = SUM(client_ledger) | No stored balance column; computed only | Single source of truth |
| 6 | Account balance = SUM(financial_posting) | No stored balance column; computed only | Single source of truth |
| 7 | Financial posting belongs to operation | financial_posting.financial_operation_id NOT NULL | Atomicity: no orphaned postings |
| 8 | Transfer posts exactly 2x (opposite signs) | Trigger + RPC validation | Atomic: both or neither |
| 9 | Ledger entry is APPEND_ONLY | No UPDATE/DELETE on ledger tables; RLS enforces | Immutable audit |
| 10 | Period OPEN determines editability | RPC checks period status BEFORE INSERT/UPDATE | Period closure protection |
| 11 | Fact's period = effective_date, NOT created_at | CHECK constraint + RPC validation | Period determination (frozen rule) |
| 12 | Cheque state transitions valid | CHECK/trigger (RECEIVED→DEPOSITED→CLEARED or ENDORSED) | State machine integrity |
| 13 | Order price snapshot IMMUTABLE | order_lines.precio_unitario never null, never changes | Historical accuracy |
| 14 | No fictitious classification traceability | NO classification_inputs table; NO daily_production.classification_session_id | Frozen rule |
| 15 | No stored daily feed consumption by flock | NO daily_feed_consumption table | Only real/calculated data |
| 16 | Formula version IMMUTABLE | formula_version UNIQUE(formula_id, version); feed_manufacturing.formula_version_id immutable | Version control |
| 17 | Population flow = events-only | No current_population column; computed via SUM(population_event.delta) | Single source |
| 18 | No hard-delete of posted facts | Only soft-delete (activo) for masters; ledger reversals for corrections | Auditability |
| 19 | MP source record IMMUTABLE | mp_source_record APPEND_ONLY; processing_status tracks reconciliation state | Raw data integrity |
| 20 | Client name change doesn't alter history | client_ledger stores ledger_client_name at posting time; order_lines stores product_name snapshot | Historical semantics |

---

## PART 2: DOMAIN-BY-DOMAIN SCHEMA OUTLINE

### A. IDENTITY & CONFIGURATION

```
perfiles (existing, REUSE)
  └─ id (UUID)
  └─ email
  └─ rol_type ENUM (ADMIN, OPERATOR)
  └─ activo BOOLEAN
  └─ created_at, updated_at

financial_account (NEW)
  └─ id (BIGSERIAL)
  └─ nombre VARCHAR(100)
  └─ account_type ENUM (CASH, BANK_ACCOUNT, EXTERNAL_SERVICE)
  └─ activo BOOLEAN
  └─ created_at
```

### B. COMMERCIAL

```
clients (existing, REUSE)
  └─ id (UUID)
  └─ nombre TEXT
  └─ fiscal_id TEXT (CUIT/CUIL)
  └─ activo BOOLEAN
  └─ created_at, updated_at

products (existing, REUSE + extend)
  └─ id (UUID)
  └─ nombre VARCHAR(255)
  └─ product_type ENUM (VENDIBLE, INPUT, BOTH)
  └─ activo BOOLEAN

pedidos (existing, ADAPT)
  └─ id (UUID)
  └─ numero_pedido BIGINT UNIQUE (optional)
  └─ cliente_id UUID FK
  └─ estado ENUM (PENDING, DELIVERED, CANCELLED)
  └─ delivered_at TIMESTAMPTZ (period determinant)
  └─ created_at, created_by

pedido_lineas (NEW from JSONB denormalization)
  └─ id (UUID)
  └─ pedido_id UUID FK
  └─ producto_id UUID FK
  └─ cantidad DECIMAL(15,4)
  └─ precio_unitario NUMERIC(15,2) SNAPSHOT
  └─ producto_nombre VARCHAR(255) SNAPSHOT
  └─ subtotal NUMERIC(15,2) COMPUTED

price_history (existing, REUSE)
  └─ tracks historical prices by list/product/date
```

### C. CLIENT LEDGER & COLLECTIONS

```
client_ledger (NEW)
  └─ id (BIGSERIAL)
  └─ cliente_id UUID FK
  └─ movement_type ENUM (SALE, COLLECTION, CHEQUE_RECEIVED, ADJUSTMENT, REVERSAL, ...)
  └─ signed_amount NUMERIC(15,2)
  └─ effective_date DATE (period determinant)
  └─ created_at, created_by

collections (existing pagos, ADAPT)
  └─ id (UUID)
  └─ cliente_id UUID FK
  └─ amount NUMERIC(15,2)
  └─ receipt_id VARCHAR(100) UNIQUE (idempotency)
  └─ receipt_date DATE
  └─ payment_method VARCHAR(50)
  └─ effective_date TIMESTAMPTZ (period determinant)
  └─ created_at, created_by
```

### D. TREASURY / FINANCIAL LEDGER

```
financial_account (NEW)
  └─ master: Caja, MP, BNA, Patagonia

financial_operation (new, FROM movimientos_caja consolidation)
  └─ id (BIGSERIAL)
  └─ operation_type ENUM (TRANSFER, FEE, CHEQUE_CLEAR, COLLECTION, CORRECTION, ...)
  └─ description TEXT
  └─ created_at

financial_posting (NEW)
  └─ id (BIGSERIAL)
  └─ financial_operation_id BIGINT FK (NOT NULL)
  └─ account_id BIGINT FK
  └─ signed_amount NUMERIC(15,2)
  └─ effective_date DATE (period determinant)
  └─ created_at
  └─ INVARIANT: Belongs to operation, no orphaned postings
```

### E. FINANCIAL INSTRUMENTS

```
financial_instrument (existing cheques, ADAPT)
  └─ id (UUID)
  └─ instrument_type ENUM (CHEQUE, ECHEQ)
  └─ cheque_number VARCHAR(50)
  └─ amount NUMERIC(15,2)
  └─ bank VARCHAR(100)
  └─ estado ENUM (RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED)
  └─ received_date DATE
  └─ created_at

financial_instrument_event (NEW)
  └─ id (BIGSERIAL)
  └─ instrument_id UUID FK
  └─ event_type ENUM (RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED)
  └─ event_date TIMESTAMPTZ
  └─ related_operation_id BIGINT FK (financial_operation, if posting created)
```

### F. SUPPLIERS & PURCHASES

```
suppliers (NEW)
  └─ id (UUID)
  └─ nombre VARCHAR(255)
  └─ fiscal_id TEXT
  └─ activo BOOLEAN

supplier_ledger (NEW)
  └─ id (BIGSERIAL)
  └─ supplier_id UUID FK
  └─ movement_type ENUM (PURCHASE, PAYMENT, ADJUSTMENT, CHEQUE_ENDORSED, ...)
  └─ signed_amount NUMERIC(15,2)
  └─ effective_date DATE

purchases (NEW)
  └─ id (UUID)
  └─ supplier_id UUID FK
  └─ document_number VARCHAR(50)
  └─ amount NUMERIC(15,2)
  └─ economic_date DATE (period determinant)
  └─ estado ENUM (PENDING, POSTED, PAID, CANCELLED)

freight (NEW)
  └─ id (UUID)
  └─ supplier_id UUID FK (flete provider)
  └─ purchase_id UUID FK (assigned to, if applicable)
  └─ amount NUMERIC(15,2)
  └─ economic_date DATE
```

### G. PRODUCTION & FLOCKS

```
sheds (NEW)
  └─ id (UUID)
  └─ nombre VARCHAR(100)
  └─ capacity BIGINT
  └─ activo BOOLEAN

flocks (existing lotes, REUSE)
  └─ id (UUID)
  └─ shed_id UUID FK
  └─ lote_id_text VARCHAR(50) (operator reference)
  └─ genetics_line VARCHAR(100)
  └─ birth_date DATE
  └─ entry_date DATE
  └─ initial_population BIGINT
  └─ exit_date DATE (retirement)
  └─ estado ENUM (ACTIVE, RETIRED, PLANNED)
  └─ INVARIANT: UNIQUE(shed_id) WHERE estado='ACTIVE'

daily_production (existing producciones, REUSE)
  └─ id (UUID)
  └─ flock_id UUID FK
  └─ production_date DATE (period determinant)
  └─ eggs_total DECIMAL(15,4)
  └─ created_at, created_by

population_event (NEW, FROM producciones.mortalidad extraction)
  └─ id (BIGSERIAL)
  └─ flock_id UUID FK
  └─ event_type ENUM (MORTALITY, COUNT_ADJUSTMENT)
  └─ delta BIGINT (signed: negative for deaths)
  └─ event_date DATE
  └─ created_at, created_by
  └─ INVARIANT: UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY'

flock_weighing (NEW)
  └─ id (BIGSERIAL)
  └─ flock_id UUID FK
  └─ measurement_date DATE
  └─ average_weight DECIMAL(10,3)
  └─ sample_size BIGINT

temperature_record (NEW)
  └─ id (BIGSERIAL)
  └─ facility_id UUID (recría location)
  └─ measured_at TIMESTAMPTZ
  └─ temperature DECIMAL(5,1)
```

### H. CLASSIFICATION

```
classification (NEW)
  └─ id (UUID)
  └─ session_date DATE
  └─ location VARCHAR(100)
  └─ created_at

classification_line (NEW)
  └─ id (BIGSERIAL)
  └─ classification_id UUID FK
  └─ grade ENUM (XL, N1, N2, N3, ROTOS, SUCIOS, DESCARTE)
  └─ quantity DECIMAL(15,4)
  └─ precio_unitario NUMERIC(15,2) (optional, for tracking)
```

### I. FEED

```
feed_type (NEW)
  └─ id (UUID)
  └─ nombre VARCHAR(100)
  └─ description TEXT

feed_ingredient (NEW)
  └─ id (UUID)
  └─ nombre VARCHAR(100)
  └─ unit VARCHAR(20) (kg, L, ...)

feed_formula_version (NEW)
  └─ id (UUID)
  └─ formula_id UUID (parent formula group)
  └─ version_number BIGINT
  └─ created_date DATE
  └─ INVARIANT: IMMUTABLE once used in manufacturing

formula_ingredient (NEW)
  └─ id (UUID)
  └─ formula_version_id UUID FK
  └─ ingredient_id UUID FK
  └─ quantity_per_unit DECIMAL(15,4)
  └─ cost_per_unit NUMERIC(15,2) (at formula creation time)

feed_manufacturing (NEW)
  └─ id (UUID)
  └─ formula_version_id UUID FK (IMMUTABLE)
  └─ batch_date DATE
  └─ quantity_produced DECIMAL(15,4)
  └─ cost_total NUMERIC(15,2) (calculated or actual)
  └─ created_at

feed_inventory_count (NEW)
  └─ id (BIGSERIAL)
  └─ count_date DATE
  └─ feed_type_id UUID FK
  └─ quantity_on_hand DECIMAL(15,4)
```

### J. FERIA / SALES SESSIONS

```
sales_session (NEW)
  └─ id (UUID)
  └─ session_date DATE
  └─ location VARCHAR(100)
  └─ opening_cash NUMERIC(15,2)
  └─ closing_count NUMERIC(15,2)
  └─ estado ENUM (OPEN, CLOSED)
  └─ created_at

sales_session_movement (NEW)
  └─ id (BIGSERIAL)
  └─ session_id UUID FK
  └─ movement_type ENUM (DISPATCH, RETURN, LOSS, ADJUSTMENT)
  └─ quantity DECIMAL(15,4)
  └─ reason TEXT
```

### K. FISCAL

```
fiscal_document (NEW)
  └─ id (UUID)
  └─ document_type ENUM (INVOICE, CREDIT_NOTE, DEBIT_NOTE)
  └─ document_number VARCHAR(50) UNIQUE
  └─ document_date DATE
  └─ economic_date DATE (if different)
  └─ cliente_id UUID FK (optional)
  └─ supplier_id UUID FK (optional)
  └─ total NUMERIC(15,2)
  └─ created_at

tax_component (NEW)
  └─ id (BIGSERIAL)
  └─ fiscal_document_id UUID FK
  └─ tax_type ENUM (IVA, PERCEPTION, RETENTION, ...)
  └─ rate NUMERIC(5,2) (SNAPSHOT: immutable)
  └─ amount NUMERIC(15,2)
```

### L. MANAGEMENT PERIODS

```
management_period (NEW)
  └─ id (BIGSERIAL)
  └─ period_date DATE (start of month)
  └─ status ENUM (OPEN, CLOSED)
  └─ closed_at TIMESTAMPTZ (when closed)
  └─ closed_by UUID FK (perfiles)
  └─ close_reason TEXT
  └─ closed_at TIMESTAMPTZ
```

### M. AUDIT

```
audit_event (NEW, TRANSVERSAL)
  └─ id (BIGSERIAL)
  └─ entity_type VARCHAR(50)
  └─ entity_id VARCHAR(100)
  └─ action VARCHAR(20) (CREATE, UPDATE, RECTIFY, DELETE, ...)
  └─ before_state JSONB (for UPDATE/DELETE)
  └─ after_state JSONB (for CREATE/UPDATE)
  └─ reason TEXT (required for RECTIFY)
  └─ performed_by UUID FK (perfiles)
  └─ performed_at TIMESTAMPTZ
```

### N. MERCADO PAGO INTEGRATION

```
mp_source_record (existing FASE 0, REUSE)
  └─ immutable raw data from MP API

mp_financial_movement (existing FASE 0, REUSE)
  └─ normalized movements, tracks reconciliation state

reconciliation_event (existing, ADAPT)
  └─ links to financial_operation (not standalone)
```

---

## PART 3: TABLE SPECIFICATIONS (CRITICAL 15 TABLES)

### Table 1: `clients`

**Purpose:** Master of client entities; supports sale ledger and collections.

**Primary Key:** `id (UUID)` — global reference across domains.

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | UUID | N | gen_random_uuid() | PK |
| nombre | TEXT | N | — | Client name (business/person) |
| fiscal_id | TEXT | Y | — | CUIT/CUIL |
| fiscal_id_type | VARCHAR(10) | Y | — | CUIT, CUIL |
| contact_info | JSONB | Y | — | {phone, email, address} |
| activo | BOOLEAN | N | true | Soft-delete |
| created_at | TIMESTAMPTZ | N | now() | Audit |
| updated_at | TIMESTAMPTZ | N | now() | Audit |

**Constraints:**
- UNIQUE(nombre)
- CHECK(activo IS TRUE OR updated_at IS NOT NULL)

**Mutability:** MASTER_MUTABLE

**RLS:** ADMIN full; OPERATOR none

---

### Table 2: `pedidos`

**Purpose:** Economic sale fact; single source (no separate Ventas table).

**Primary Key:** `id (UUID)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | UUID | N | gen_random_uuid() | PK |
| numero_pedido | BIGINT | Y | — | Sequential (optional) |
| cliente_id | UUID | N | — | FK clients |
| estado | VARCHAR(20) | N | 'PENDING' | PENDING / DELIVERED / CANCELLED |
| delivered_at | TIMESTAMPTZ | Y | — | **PERIOD DETERMINANT** |
| created_at | TIMESTAMPTZ | N | now() | |
| created_by | UUID | Y | — | FK perfiles |
| updated_at | TIMESTAMPTZ | N | now() | |

**Constraints:**
- FK cliente_id → clients(id)
- CHECK(estado IN ('PENDING', 'DELIVERED', 'CANCELLED'))
- CHECK(IF estado='DELIVERED' THEN delivered_at IS NOT NULL)
- UNIQUE(numero_pedido) IF numero_pedido IS NOT NULL
- Partial UNIQUE(cliente_id, delivered_at) IF estado='DELIVERED'

**Derived (NOT stored):**
- total = SUM(order_lines.subtotal)

**Mutability:** PENDING=editable; DELIVERED=immutable (rectification only)

**Indexes:**
- idx_pedidos_estado: (estado)
- idx_pedidos_cliente: (cliente_id, estado)
- idx_pedidos_delivered: (delivered_at DESC) WHERE estado='DELIVERED'

**RLS:** OPERATOR none; ADMIN full

---

### Table 3: `pedido_lineas`

**Purpose:** Immutable economic line items; price snapshot.

**Primary Key:** `id (UUID)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | UUID | N | gen_random_uuid() | |
| pedido_id | UUID | N | — | FK pedidos |
| producto_id | UUID | N | — | FK products |
| cantidad | DECIMAL(15,4) | N | — | Ordered quantity |
| precio_unitario | NUMERIC(15,2) | N | — | **SNAPSHOT:** price at order time |
| producto_nombre | VARCHAR(255) | Y | — | **SNAPSHOT:** product name at time |
| subtotal | NUMERIC(15,2) | N | — | cantidad * precio_unitario (immutable) |
| created_at | TIMESTAMPTZ | N | now() | |

**Constraints:**
- FK pedido_id → pedidos(id) ON DELETE CASCADE
- FK producto_id → products(id)
- CHECK(cantidad > 0 AND precio_unitario >= 0 AND subtotal >= 0)
- UNIQUE(pedido_id, producto_id)

**Mutability:** IMMUTABLE_AFTER_POSTED

**Indexes:**
- idx_order_lines_pedido: (pedido_id)
- idx_order_lines_producto: (producto_id)

---

### Table 4: `client_ledger`

**Purpose:** Immutable audit trail of CC movements.

**Primary Key:** `id (BIGSERIAL)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | BIGSERIAL | N | — | PK |
| cliente_id | UUID | N | — | FK clients |
| movement_type | VARCHAR(30) | N | — | SALE, COLLECTION, CHEQUE_RECEIVED, ADJUSTMENT, REVERSAL |
| signed_amount | NUMERIC(15,2) | N | — | + increases debt; - reduces |
| reason | VARCHAR(255) | Y | — | Reference (pedido ID, collection ID) |
| effective_date | DATE | N | — | **PERIOD DETERMINANT** |
| created_at | TIMESTAMPTZ | N | now() | |
| created_by | UUID | Y | — | |

**Constraints:**
- FK cliente_id → clients(id) ON DELETE RESTRICT
- CHECK(movement_type IN (...))
- CHECK(effective_date <= current_date)

**Derived (NOT stored):**
- balance = SUM(signed_amount WHERE cliente_id = X)

**Mutability:** APPEND_ONLY

**Indexes:**
- idx_client_ledger_cliente_date: (cliente_id, effective_date DESC)
- idx_client_ledger_type: (movement_type)

**RLS:** OPERATOR none; ADMIN full

---

### Table 5: `financial_account`

**Purpose:** Master of cash/bank accounts.

**Primary Key:** `id (BIGSERIAL)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | BIGSERIAL | N | — | |
| nombre | VARCHAR(100) | N | — | Caja, BNA, MP, Patagonia |
| account_type | VARCHAR(30) | N | — | CASH, BANK_ACCOUNT, EXTERNAL_SERVICE |
| activo | BOOLEAN | N | true | |
| created_at | TIMESTAMPTZ | N | now() | |

**Constraints:**
- UNIQUE(nombre)
- CHECK(account_type IN (...))

**Mutability:** MASTER_MUTABLE

**RLS:** ADMIN full; OPERATOR none

---

### Table 6: `financial_operation`

**Purpose:** Multi-posting atomic transaction (transfer, fee, collection).

**Primary Key:** `id (BIGSERIAL)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | BIGSERIAL | N | — | |
| operation_type | VARCHAR(30) | N | — | TRANSFER, FEE, CHEQUE_CLEAR, COLLECTION, CORRECTION |
| description | TEXT | Y | — | |
| created_at | TIMESTAMPTZ | N | now() | |
| created_by | UUID | Y | — | |

**Constraints:**
- CHECK(operation_type IN (...))

**Invariant:** Minimum 2 postings for TRANSFER; exactly 1 for COLLECTION_CLEAR; both must commit or both fail.

**RLS:** ADMIN full via RPC; OPERATOR none

---

### Table 7: `financial_posting`

**Purpose:** Atomic unit of financial ledger; immutable once posted.

**Primary Key:** `id (BIGSERIAL)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | BIGSERIAL | N | — | |
| financial_operation_id | BIGINT | N | — | FK (NOT NULL) |
| account_id | BIGINT | N | — | FK financial_account |
| signed_amount | NUMERIC(15,2) | N | — | - debit; + credit |
| effective_date | DATE | N | — | **PERIOD DETERMINANT** |
| created_at | TIMESTAMPTZ | N | now() | |

**Constraints:**
- FK financial_operation_id → financial_operation(id) ON DELETE CASCADE
- FK account_id → financial_account(id) ON DELETE RESTRICT
- CHECK(effective_date <= current_date)

**Invariant:** Belongs to operation; no orphaned postings.

**Mutability:** IMMUTABLE_AFTER_POSTED

**Derived (NOT stored):**
- account_balance = SUM(signed_amount WHERE account_id = X)

**Indexes:**
- idx_financial_posting_operation: (financial_operation_id)
- idx_financial_posting_account_date: (account_id, effective_date DESC)

**RLS:** ADMIN full via RPC; OPERATOR none

---

### Table 8: `flocks`

**Purpose:** Lote master; lifecycle of one bird cohort per shed.

**Primary Key:** `id (UUID)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | UUID | N | gen_random_uuid() | |
| shed_id | UUID | N | — | FK sheds |
| lote_id_text | VARCHAR(50) | Y | — | Operator reference (G01-2501) |
| genetics_line | VARCHAR(100) | Y | — | HY-Line Brown |
| birth_date | DATE | N | — | Genetics cohort birth |
| entry_date | DATE | N | — | Arrival at shed |
| initial_population | BIGINT | N | — | Starting count |
| exit_date | DATE | Y | — | Retirement |
| estado | VARCHAR(20) | N | 'ACTIVE' | ACTIVE / RETIRED / PLANNED |
| created_at | TIMESTAMPTZ | N | now() | |

**Constraints:**
- FK shed_id → sheds(id)
- UNIQUE(shed_id, entry_date)
- CHECK(birth_date <= entry_date AND entry_date <= current_date)
- CHECK(IF estado='RETIRED' THEN exit_date IS NOT NULL)
- Partial UNIQUE(shed_id) WHERE estado='ACTIVE' **← one active flock per shed**

**Derived (NOT stored):**
- current_population = initial_population + SUM(population_event.delta WHERE flock_id=X)

**Mutability:** MASTER_MUTABLE (name, genetics); entry/exit dates immutable once set

**RLS:** OPERATOR can see authorized flocks; ADMIN full

---

### Table 9: `population_event`

**Purpose:** Immutable population change; mortality uniqueness enforced.

**Primary Key:** `id (BIGSERIAL)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | BIGSERIAL | N | — | |
| flock_id | UUID | N | — | FK flocks |
| event_type | VARCHAR(20) | N | — | MORTALITY, COUNT_ADJUSTMENT |
| delta | BIGINT | N | — | Signed change |
| event_date | DATE | N | — | Event date |
| created_at | TIMESTAMPTZ | N | now() | |
| created_by | UUID | Y | — | |

**Constraints:**
- FK flock_id → flocks(id) ON DELETE RESTRICT
- CHECK(event_type IN ('MORTALITY', 'COUNT_ADJUSTMENT'))
- CHECK(delta < 0 OR (event_type='COUNT_ADJUSTMENT'))
- **UNIQUE(flock_id, event_date, event_type) ← MAX ONE MORTALITY per (flock, date)**

**Mutability:** APPEND_ONLY

**Indexes:**
- idx_population_event_flock_date: (flock_id, event_date DESC)
- idx_population_event_type: (event_type)

**RLS:** OPERATOR can INSERT/SELECT own flock entries; ADMIN full

---

### Table 10: `daily_production`

**Purpose:** Per-flock production measurements.

**Primary Key:** `id (UUID)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | UUID | N | gen_random_uuid() | |
| flock_id | UUID | N | — | FK flocks |
| production_date | DATE | N | — | **PERIOD DETERMINANT** |
| eggs_total | DECIMAL(15,4) | N | — | Total eggs (docenas or count) |
| created_at | TIMESTAMPTZ | N | now() | |
| created_by | UUID | Y | — | |

**Constraints:**
- FK flock_id → flocks(id)
- UNIQUE(flock_id, production_date) ← one record per flock/date
- CHECK(eggs_total >= 0)

**Mutability:** APPEND_ONLY (no EDIT after posting)

**Indexes:**
- idx_daily_production_flock_date: (flock_id, production_date DESC)

**RLS:** OPERATOR can INSERT own; SELECT authorized flocks

---

### Table 11: `classification`

**Purpose:** Session-based egg classification; no flock traceability.

**Primary Key:** `id (UUID)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | UUID | N | gen_random_uuid() | |
| session_date | DATE | N | — | Classification date |
| location | VARCHAR(100) | Y | — | Facility name |
| created_at | TIMESTAMPTZ | N | now() | |
| created_by | UUID | Y | — | |

**Constraints:**
- Partial UNIQUE(session_date, location)

**Mutability:** IMMUTABLE once posted

**RLS:** OPERATOR none (RPC aggregates only); ADMIN full

---

### Table 12: `classification_line`

**Purpose:** Grade breakdown for session.

**Primary Key:** `id (BIGSERIAL)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | BIGSERIAL | N | — | |
| classification_id | UUID | N | — | FK classification |
| grade | VARCHAR(20) | N | — | XL, N1, N2, N3, ROTOS, SUCIOS, DESCARTE |
| quantity | DECIMAL(15,4) | N | — | Eggs of this grade |
| created_at | TIMESTAMPTZ | N | now() | |

**Constraints:**
- FK classification_id → classification(id) ON DELETE CASCADE
- CHECK(quantity >= 0)
- UNIQUE(classification_id, grade)

**Mutability:** IMMUTABLE_AFTER_POSTED

---

### Table 13: `audit_event` (TRANSVERSAL)

**Purpose:** Immutable audit trail covering all domain changes.

**Primary Key:** `id (BIGSERIAL)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | BIGSERIAL | N | — | |
| entity_type | VARCHAR(50) | N | — | pedido, client_ledger, flock, etc. |
| entity_id | VARCHAR(100) | N | — | UUID or BIGINT as string |
| action | VARCHAR(20) | N | — | CREATE, UPDATE, RECTIFY, DELETE |
| before_state | JSONB | Y | — | Previous values |
| after_state | JSONB | Y | — | New values |
| reason | TEXT | Y | — | Why (required for RECTIFY) |
| performed_by | UUID | Y | — | FK perfiles |
| performed_at | TIMESTAMPTZ | N | now() | |

**Mutability:** APPEND_ONLY

**Indexes:**
- idx_audit_entity: (entity_type, entity_id, performed_at DESC)
- idx_audit_performed_at: (performed_at DESC)

**RLS:** ADMIN full; OPERATOR sees own actions only

---

### Table 14: `management_period`

**Purpose:** Period open/closed status for integral closure.

**Primary Key:** `id (BIGSERIAL)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | BIGSERIAL | N | — | |
| period_date | DATE | N | — | First day of month (YYYY-MM-01) |
| status | VARCHAR(10) | N | 'OPEN' | OPEN, CLOSED |
| closed_at | TIMESTAMPTZ | Y | — | When period closed |
| closed_by | UUID | Y | — | FK perfiles (ADMIN who closed) |
| close_reason | TEXT | Y | — | Why closed |

**Constraints:**
- UNIQUE(period_date)
- CHECK(status IN ('OPEN', 'CLOSED'))
- CHECK(IF status='CLOSED' THEN closed_at IS NOT NULL AND closed_by IS NOT NULL)

**Mutability:** OPEN → CLOSED (one-way); ADMIN can reopen (rare, requires reason + audit)

**Indexes:**
- idx_management_period_status: (status)
- idx_management_period_date: (period_date DESC)

**RLS:** ADMIN full; OPERATOR none (read via RPC)

---

### Table 15: `financial_instrument`

**Purpose:** Cheques/eCheques state machine.

**Primary Key:** `id (UUID)`

| Column | Type | Null | Default | Meaning |
|--------|------|------|---------|---------|
| id | UUID | N | gen_random_uuid() | |
| instrument_type | VARCHAR(20) | N | — | CHEQUE, ECHEQ |
| cheque_number | VARCHAR(50) | N | — | Bank cheque number |
| amount | NUMERIC(15,2) | N | — | Face value |
| bank | VARCHAR(100) | Y | — | Issuing bank |
| estado | VARCHAR(20) | N | 'RECEIVED' | RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED |
| received_date | DATE | N | — | When received (for CC impact) |
| created_at | TIMESTAMPTZ | N | now() | |

**Constraints:**
- UNIQUE(cheque_number, bank)
- CHECK(estado IN ('RECEIVED', 'DEPOSITED', 'CLEARED', 'ENDORSED', 'REJECTED'))

**State machine:**
```
RECEIVED → DEPOSITED → CLEARED
        → ENDORSED → (removed from cartera)
        → REJECTED
```

**Mutability:** State transitions via RPC (not direct UPDATE)

**RLS:** ADMIN full via RPC; OPERATOR none

---

## PART 4: DERIVED DATA (NEVER STORE THESE)

| Concept | How Computed | Why NOT stored |
|---------|--------------|-----------------|
| Client balance | SUM(client_ledger WHERE cliente_id=X) | Single source: ledger movements |
| Supplier balance | SUM(supplier_ledger WHERE supplier_id=X) | Single source: ledger movements |
| Financial account balance | SUM(financial_posting WHERE account_id=X) | Single source: postings |
| Order total | SUM(order_lines.subtotal) | Single source: line items |
| Current flock population | initial_population + SUM(population_event.delta WHERE flock_id=X) | Single source: events |
| P&L | SUM(sales) - SUM(costs) by period | Derived from sources |
| Feed consumo_económico | stock_init + fabr - sales ± adj - stock_final | Inventory equation (period) |
| Feed consumo_teórico | population × age × curve × formula | Productivity control metric |
| Cost per egg | (feed_cost + labor + amort) / eggs_produced | Derived for analysis |
| Posture percentage | birds_in_production / total_birds | Derived metric |

---

## PART 5: SNAPSHOT MATRIX

| Entity | Snapshot Field | Source Master | Why Necessary |
|--------|---|---|---|
| order_line | precio_unitario | products.precio_actual | Price retroactively changes; line must show price used at order time |
| order_line | producto_nombre | products.nombre | Product renamed; line shows name at order time for clarity |
| financial_posting | account_nombre | financial_account.nombre | Account renamed; posting preserves label for historical reports |
| feed_manufacturing | formula_version_id | formula_version | Formula changes; manufacturing must cite exact version applied |
| fiscal_document | tax_rate | tax_rules(rate) | Tax rate changes; document must show rate applied at issuance |
| collection | payment_method | (inline enum) | Payment method may be retired; record must show method used |

---

## PART 6: OPEN IMPLEMENTATION QUESTIONS

**Technical questions for Physical Design next steps:**

### PK Strategy per Entity
- **Decision made:** UUID for masters, BIGSERIAL for ledgers
- **Open:** Any entity requiring BIGINT instead of UUID? (Keep as-is; UUID is safer)

### Enum Definitions Conflict
- **CURRENT ISSUE:** forma_pago_type defined twice in different migrations (conflicting values)
- **ACTION REQUIRED:** Pick canonical version; alias deprecated values during migration
- **POTENTIAL ADR**

### RLS Policy Specifics
- Which operations should go through RPC-only gates vs. direct table INSERT?
- (Mostly resolved: see TRANSACTION_CATALOG and RLS_MATRIX)

### Index Strategy
- Full-text search on client.nombre needed?
- Advanced range query patterns for financial_posting by date range?
- (Default indexes defined above; optimize per query patterns during implementation)

### Soft-Delete Strategy Detail
- Use `activo` flag (defined above) consistently across all masters
- Views to auto-filter? (Recommended: keep explicit in WHERE clauses for clarity)

---

## PART 7: IMPLEMENTATION READINESS

**Status:** Ready for Physical Database Design review

**No architectural blockers identified.**

**Next step:** Review by code-reviewer agent + owner approval before migration/RPC implementation begins.

---

**All table specifications follow frozen business rules. No business compromise in physical design.**
