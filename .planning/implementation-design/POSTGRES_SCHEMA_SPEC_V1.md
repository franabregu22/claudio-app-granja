# POSTGRES SCHEMA SPECIFICATION V1

**STATUS:** **FROZEN** — Fase 9 (Implementation Design) closed 2026-09-24. Implementation-ready physical schema.  
**AMENDMENTS:** ADR-001 (`.planning/adr/ADR-001_ISSUED_INSTRUMENT_CANCELLATION.md`, ACCEPTED 2026-09-25) — issued-instrument cancellation: RPC 42 `cancel_supplier_instrument`, `financial_instrument.cancelled_date`, `chk_instrument_cancelled_coherent`. Amended passages are marked **[ADR-001]**. Nothing else changed.  
**AMENDMENTS:** ADR-002 (`.planning/adr/ADR-002_PURCHASE_RECTIFICATION_VERSION_KEY.md`, ACCEPTED 2026-09-25) — bounded rectified-purchase version key (`'RECTIFY:' || <predecessor purchase id> || ':v' || version`) and the reserved `RECTIFY:` idempotency-key prefix. Amended passages are marked **[ADR-002]**. Nothing else changed.  
**AMENDMENTS:** ADR-008 (`.planning/adr/ADR-008_PURCHASE_ATTACHMENT_STORAGE.md`, ACCEPTED 2026-09-30) — `purchase_attachment.storage_path` refers to an object in the private Storage bucket `purchase-attachments` (migration 0058 creates the bucket and its policies in the `storage` schema). No public-schema change. Amended passage is marked **[ADR-008]**.
**AMENDMENTS:** ADR-012 (`.planning/adr/ADR-012_CLASSIFICATION_UNITS_RECTIFICATION.md`, ACCEPTED 2026-10-01) — `classification` version chain (`version_seq`, `is_current`, `supersedes_id`, `rectification_reason`) and `classification_line` original entry (`entered_quantity`, `entered_unit classification_entry_unit`) (migration 0063). ADR-013 (`.planning/adr/ADR-013_FEED_FORMULA_PUBLICATION.md`, ACCEPTED 2026-10-01) — `excl_feed_formula_version_no_overlap` (migration 0064). No table added. Amended passages are marked **[ADR-012]** / **[ADR-013]**.
**AMENDMENTS:** ADR-014 (`.planning/adr/ADR-014_FEED_MANUFACTURING_RECTIFICATION.md`, ACCEPTED 2026-10-01) — `feed_manufacturing` version chain (migration 0065); the seed grade Rotos set inactive (no row removed). Amended passages are marked **[ADR-014]**.
Changes from here require an explicit ADR, as with the target architecture.  
**DATE:** 2026-09-24  
**AUTHORITY:** TARGET_ARCHITECTURE_V2_FROZEN.md (frozen). This document translates it; it does not reinterpret it.

**TABLE COUNT: 54** (exact inventory in section INVENTORY below)

**RLS:** This document declares only that RLS is enabled per table and states the security intent.
Canonical policy definitions live ONLY in `RLS_IMPLEMENTATION_SPEC_V1.md`. No `CREATE POLICY` statements appear here, to prevent drift.

---

## CONVENTIONS

**Keys**
- UUID PK for masters and entities referenced from the UI.
- BIGSERIAL PK for append-only ledger/event streams (dense, naturally ordered).

**Types**
- `NUMERIC(15,2)` money (signed).
- `NUMERIC(7,4)` tax rates (snapshot; never hardcoded).
- `INTEGER` discrete countable units (eggs, cartons).
- `BIGINT` bird populations.
- `DECIMAL(15,3)` feed mass (kg).
- `DECIMAL(10,3)` bird weight (kg).
- `DATE` business/economic date (period determinant).
- `TIMESTAMPTZ` exact instants (UTC) and `created_at` metadata.

**Business date rule (canonical)**
- Every period-sensitive fact carries an explicit `DATE` column that determines its period.
- `created_at` NEVER determines a period.
- When a business date derives from an instant, the derivation is explicit and fixed:
  `(<instant> AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`
  Session timezone is never relied upon. No bare `timestamptz::DATE` for period logic.

**FKs**
- All FKs: `ON DELETE RESTRICT ON UPDATE CASCADE` unless stated. Historical facts are never deleted.

**Immutability**
- Append-only tables have no write path for application roles (see RLS spec).
- Corrections are rectifications: new current row + compensating ledger entries + audit. Never in-place edits of business fields.

---

## ENUM TYPES

```sql
CREATE TYPE rol_type                    AS ENUM ('ADMIN','OPERATOR');
CREATE TYPE order_estado                AS ENUM ('PENDING','DELIVERED','CANCELLED');
CREATE TYPE product_type                AS ENUM ('VENDIBLE','INPUT','BOTH');
CREATE TYPE price_list_type             AS ENUM ('MAYORISTA','MINORISTA');
CREATE TYPE account_type                AS ENUM ('CASH','BANK_ACCOUNT','EXTERNAL_SERVICE');

CREATE TYPE financial_operation_type    AS ENUM (
  'TRANSFER','FEE','COLLECTION','CHEQUE_CLEAR','CHEQUE_REJECTION',
  'SUPPLIER_PAYMENT','INSTRUMENT_DEBIT','INSTRUMENT_DEBIT_REVERSAL',
  'FREIGHT_PAYMENT','FISCAL_PAYMENT','SESSION_CASH','MP_SETTLEMENT','ADJUSTMENT');

CREATE TYPE financial_instrument_type   AS ENUM ('CHEQUE','ECHEQ');
CREATE TYPE instrument_direction        AS ENUM ('RECEIVED','ISSUED');
CREATE TYPE instrument_estado           AS ENUM (
  'RECEIVED','DEPOSITED','CLEARED','ENDORSED',   -- received lifecycle
  'ISSUED','DEBITED',                            -- issued lifecycle
  'REJECTED','CANCELLED');                       -- terminal, both directions

CREATE TYPE client_ledger_movement_type AS ENUM (
  'SALE_DELIVERY','COLLECTION','CHEQUE_RECEIVED','CHEQUE_REJECTED',
  'ADJUSTMENT','REVERSAL','OPENING_BALANCE');

CREATE TYPE supplier_ledger_movement_type AS ENUM (
  'PURCHASE','PAYMENT','CHEQUE_ENDORSED','INSTRUMENT_ISSUED','INSTRUMENT_REJECTED',
  'FREIGHT','ADJUSTMENT','REVERSAL','OPENING_BALANCE');

CREATE TYPE payment_method              AS ENUM ('CASH','CHEQUE','TRANSFER','MERCADOPAGO');
CREATE TYPE purchase_nature             AS ENUM ('OPERATING','REINVESTMENT','INVESTMENT');

CREATE TYPE population_event_type       AS ENUM ('MORTALITY','COUNT_ADJUSTMENT');
CREATE TYPE flock_estado                AS ENUM ('ACTIVE','RETIRED','ARCHIVED');

CREATE TYPE feed_category               AS ENUM ('LAYER','BROILER','PULLET','INPUT');
CREATE TYPE unit_type                   AS ENUM ('KG','TON','LITER','UNIT','CARTON');
CREATE TYPE feed_movement_type          AS ENUM (
  'EXTERNAL_SALE','ADJUSTMENT_POSITIVE','ADJUSTMENT_NEGATIVE','LOSS');

CREATE TYPE session_estado              AS ENUM ('OPEN','CLOSED');
CREATE TYPE session_movement_type       AS ENUM ('DISPATCH','RETURN','LOSS','ADJUSTMENT');
CREATE TYPE session_cash_event_type     AS ENUM (
  'OPENING_FUND','EXPENSE','WITHDRAWAL','TRANSFER_OUT','COUNT');

CREATE TYPE fiscal_document_type        AS ENUM (
  'INVOICE_A','INVOICE_B','INVOICE_C','CREDIT_NOTE','DEBIT_NOTE','RECEIPT','OTHER');
CREATE TYPE fiscal_direction            AS ENUM ('DEBITO','CREDITO');
CREATE TYPE tax_kind                    AS ENUM (
  'IVA','IIBB','GANANCIAS','RETENTION','PERCEPTION','OTHER');
CREATE TYPE fiscal_obligation_status    AS ENUM ('PENDING','PARTIALLY_PAID','PAID','CANCELLED');

CREATE TYPE management_period_status    AS ENUM ('OPEN','CLOSED');
CREATE TYPE project_status              AS ENUM ('ACTIVE','PAUSED','CLOSED');
CREATE TYPE mp_processing_status        AS ENUM (
  'PENDING','NORMALIZED','RECONCILED','IGNORED','ERROR');
```

---

## DOMAIN A — IDENTITY, PERIODS, AUDIT

### perfiles
```sql
CREATE TABLE perfiles (
  id          UUID PRIMARY KEY,                -- equals auth.users.id
  email       VARCHAR(255) UNIQUE NOT NULL,
  rol_type    rol_type NOT NULL DEFAULT 'OPERATOR',
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE perfiles ENABLE ROW LEVEL SECURITY;
```
`perfiles.rol_type` is the ONLY source of business role. `id` equals `auth.uid()`.
Security intent: ADMIN manages; a user may read own row. No self-escalation (see RLS spec).

### management_period
```sql
CREATE TABLE management_period (
  id             BIGSERIAL PRIMARY KEY,
  periodo_fecha  DATE UNIQUE NOT NULL,         -- first day of month (YYYY-MM-01)
  status         management_period_status NOT NULL DEFAULT 'OPEN',
  closed_at      TIMESTAMPTZ,
  closed_by      UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_periodo_fecha_is_month_start
    CHECK (periodo_fecha = date_trunc('month', periodo_fecha)::DATE)
);
ALTER TABLE management_period ENABLE ROW LEVEL SECURITY;
```
**Period boundary semantics (canonical):** a business date `d` belongs to the period whose
`periodo_fecha = date_trunc('month', d)::DATE`. Equivalent half-open interval
`[periodo_fecha, periodo_fecha + INTERVAL '1 month')`. Monthly granularity only.

Security intent: `status` changes ONLY through `close_management_period` / `reopen_management_period`. No direct write path for any application role.

### audit_events
```sql
CREATE TABLE audit_events (
  id             BIGSERIAL PRIMARY KEY,
  entity_type    VARCHAR(100) NOT NULL,
  entity_id      VARCHAR(100) NOT NULL,
  action         VARCHAR(50)  NOT NULL,
  before_values  JSONB,
  after_values   JSONB,
  reason         TEXT,
  performed_by   UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  performed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_events_actor  ON audit_events(performed_by, performed_at);
```
Single transversal audit architecture (frozen Part 21). No per-entity audit tables.
APPEND_ONLY: no UPDATE/DELETE path for any role. Written exclusively by RPCs.

### operator_assignments
```sql
CREATE TABLE operator_assignments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id  UUID NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  flock_id     UUID NOT NULL REFERENCES flocks(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  activo       BOOLEAN NOT NULL DEFAULT true,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by  UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(operator_id, flock_id)
);
ALTER TABLE operator_assignments ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_operator_assignments_operator ON operator_assignments(operator_id) WHERE activo = true;
```
Authorization matrix: which flocks an OPERATOR may work on.

---

## DOMAIN B — MASTERS

### sheds
```sql
CREATE TABLE sheds (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     VARCHAR(100) UNIQUE NOT NULL,
  capacidad  BIGINT,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE sheds ENABLE ROW LEVEL SECURITY;
```

### clients
```sql
CREATE TABLE clients (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     TEXT UNIQUE NOT NULL,
  fiscal_id  TEXT,
  contacto   TEXT,
  activo     BOOLEAN NOT NULL DEFAULT true,     -- deactivate, never hard-delete
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
```
No stored balance. Client debt = `SUM(client_ledger.signed_amount)`. Negative = credit in favor.

### products
```sql
CREATE TABLE products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre       VARCHAR(255) UNIQUE NOT NULL,
  product_type product_type NOT NULL,
  unit_type    unit_type NOT NULL DEFAULT 'UNIT',
  activo       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
```

### price_history
```sql
CREATE TABLE price_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id     UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  price_list_type price_list_type NOT NULL,
  precio          NUMERIC(15,2) NOT NULL CHECK (precio >= 0),
  effective_from  DATE NOT NULL,
  effective_to    DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_price_history_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX idx_price_history_current
  ON price_history(producto_id, price_list_type)
  WHERE effective_to IS NULL;
```
Frozen Part 3: price history maintained. The price actually used is snapshotted on `pedido_lineas.precio_unitario`; this table is never the authority for a historical order.

### suppliers
```sql
CREATE TABLE suppliers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     VARCHAR(255) UNIQUE NOT NULL,
  fiscal_id  TEXT,
  contacto   TEXT,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
```

### financial_account
```sql
CREATE TABLE financial_account (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre       VARCHAR(100) UNIQUE NOT NULL,
  account_type account_type NOT NULL,
  activo       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE financial_account ENABLE ROW LEVEL SECURITY;
```
V1 accounts: Caja chica, Mercado Pago, BNA, Patagonia. No stored balance.

### expense_category
```sql
CREATE TABLE expense_category (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE expense_category ENABLE ROW LEVEL SECURITY;
```
**In scope and required.** Referenced by `purchases.expense_category_id` (NOT NULL) and by
`sales_session_cash_event.expense_category_id` for session expenses.

### classification_grade

**[ADR-014]** Seed grade `Rotos` is `activo = false` (inactive for new entries, rows and history kept).
```sql
CREATE TABLE classification_grade (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     VARCHAR(50) UNIQUE NOT NULL,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE classification_grade ENABLE ROW LEVEL SECURITY;
```
V1 grades: XL, N1, N2, N3, Rotos, Sucios, Descarte.

### projects
```sql
CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(150) UNIQUE NOT NULL,
  descripcion TEXT,
  status      project_status NOT NULL DEFAULT 'ACTIVE',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
```
Frozen Part 17: optional analytic dimension only (name, description, status). No budgets/tasks/Gantt.

### feed_type
```sql
CREATE TABLE feed_type (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        VARCHAR(100) UNIQUE NOT NULL,
  feed_category feed_category NOT NULL,
  activo        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE feed_type ENABLE ROW LEVEL SECURITY;
```

### feed_ingredient
```sql
CREATE TABLE feed_ingredient (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(100) UNIQUE NOT NULL,
  unit_type   unit_type NOT NULL DEFAULT 'KG',
  supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE feed_ingredient ENABLE ROW LEVEL SECURITY;
```
Raw materials catalog. Ingredient cost is NOT stored here; historical cost enters through
`purchase_line` and is frozen per formula version (frozen Part 9/15).

### genetics_consumption_curve
```sql
CREATE TABLE genetics_consumption_curve (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  genetics_line            VARCHAR(100) NOT NULL,
  age_weeks                INTEGER NOT NULL CHECK (age_weeks >= 0),
  expected_g_per_bird_day  DECIMAL(10,3) NOT NULL CHECK (expected_g_per_bird_day >= 0),
  expected_laying_pct      DECIMAL(5,2)  CHECK (expected_laying_pct BETWEEN 0 AND 100),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(genetics_line, age_weeks)
);
ALTER TABLE genetics_consumption_curve ENABLE ROW LEVEL SECURITY;
```
Reference data for **consumo teórico** (frozen Part 15). It is a control metric input, never a
record of measured consumption. No `daily_feed_consumption` table exists (frozen Part 26).

---

## DOMAIN C — COMMERCIAL

### pedidos
```sql
CREATE TABLE pedidos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_pedido      BIGINT UNIQUE,
  cliente_id         UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  estado             order_estado NOT NULL DEFAULT 'PENDING',
  sales_session_id   UUID REFERENCES sales_session(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  is_aggregated_retail BOOLEAN NOT NULL DEFAULT false,
  delivered_at       TIMESTAMPTZ,
  delivered_date     DATE,          -- period determinant; = (delivered_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
  cancelled_at       TIMESTAMPTZ,
  cancelled_date     DATE,
  rectification_seq  INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_pedidos_delivered_coherent CHECK (
    (estado = 'DELIVERED' AND delivered_at IS NOT NULL AND delivered_date IS NOT NULL)
    OR (estado <> 'DELIVERED')),
  CONSTRAINT chk_pedidos_cancelled_coherent CHECK (
    (estado = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_date IS NOT NULL)
    OR (estado <> 'CANCELLED'))
);
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_pedidos_cliente        ON pedidos(cliente_id);
CREATE INDEX idx_pedidos_delivered_date ON pedidos(delivered_date) WHERE estado = 'DELIVERED';
CREATE INDEX idx_pedidos_session        ON pedidos(sales_session_id) WHERE sales_session_id IS NOT NULL;
```
No `monto_total`. Order total = `SUM(pedido_lineas.subtotal) WHERE is_current = true`.
`delivered_date` is the period determinant (frozen Part 20). `created_at` is metadata only.
`sales_session_id` + `is_aggregated_retail` implement the feria aggregated Pedido (frozen Part 16);
no individual anonymous retail sale rows exist.

Security intent: while `estado='PENDING'` ADMIN may edit freely. The transition to DELIVERED or
CANCELLED and any post-delivery correction occur ONLY through RPCs; no application role holds
UPDATE on this table.

### pedido_lineas
```sql
CREATE TABLE pedido_lineas (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id        UUID NOT NULL REFERENCES pedidos(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
  producto_id      UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cantidad         DECIMAL(15,4) NOT NULL CHECK (cantidad > 0),
  precio_unitario  NUMERIC(15,2) NOT NULL CHECK (precio_unitario >= 0),  -- SNAPSHOT, immutable
  producto_nombre  VARCHAR(255)  NOT NULL,                               -- SNAPSHOT, immutable
  subtotal         NUMERIC(15,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
  version_seq      INTEGER NOT NULL DEFAULT 0,   -- version-set: 0 = original, N = Nth rectification
  is_current       BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE pedido_lineas ENABLE ROW LEVEL SECURITY;

-- Physical guarantee: at most ONE distinct current version_seq per order,
-- while still allowing many current lines within that one version.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE pedido_lineas
  ADD CONSTRAINT excl_pedido_lineas_single_current_version
  EXCLUDE USING gist (pedido_id WITH =, version_seq WITH <>)
  WHERE (is_current);

CREATE INDEX idx_pedido_lineas_current ON pedido_lineas(pedido_id) WHERE is_current = true;
CREATE INDEX idx_pedido_lineas_version ON pedido_lineas(pedido_id, version_seq);
```
**Version-set supersession (physical mechanism).** Rectification replaces a *set* of lines with a
new *set*. A per-line `superseded_by` pointer cannot express N:M replacement, so it is deliberately
absent. Instead every line carries `version_seq`:

- Original lines: `version_seq = 0`, `is_current = true`.
- The Nth rectification first flips the previous version's rows to `is_current = false`, then
  inserts the replacement lines with `version_seq = N` and `is_current = true`. That order is
  mandatory — see below.
- `pedidos.rectification_seq` holds the highest existing `version_seq` for the order.
- Historical versions keep their business snapshot fields unchanged forever.

**What guarantees "exactly one current version".** `idx_pedido_lineas_current` is a plain
non-unique index; it is a lookup accelerator and guarantees nothing. The guarantee is the
`excl_pedido_lineas_single_current_version` EXCLUDE constraint, which rejects any pair of current
rows that share a `pedido_id` but differ in `version_seq`:

| Situation | Allowed? |
|---|---|
| 5 current lines, all `version_seq = 2` | yes — `version_seq WITH <>` is not satisfied |
| 1 current line `version_seq = 1` + 1 current line `version_seq = 2` | **rejected** |
| 0 current lines (mid-rectification, between the flip and the insert) | yes |

A plain or unique btree index cannot express this: `UNIQUE (pedido_id) WHERE is_current` would cap
every order at a single line, and `UNIQUE (pedido_id, version_seq) WHERE is_current` would cap every
version at a single line. The exclusion constraint is the only formulation that constrains the
*version* without constraining the *number of lines*. It needs `btree_gist`, which supplies the GiST
`<>` search strategy for `uuid` and `int4`.

The constraint is `IMMEDIATE` (the default), so it also *enforces* the mutation order: retiring the
old version first passes through a legal zero-current-rows state, whereas inserting the new version
while the old one is still current violates the constraint on the spot. A wrong-order implementation
therefore fails loudly instead of persisting two current versions.

Only `rectify_delivered_order` (SECURITY DEFINER) flips `is_current`. No application role holds
UPDATE/DELETE on this table. The transient zero-current-rows state is never observable outside the
transaction, and if any later step of the RPC fails PostgreSQL rolls the whole call back, so an
order is never left without a current version.

---

## DOMAIN D — CLIENT LEDGER & COLLECTIONS

### client_ledger
```sql
CREATE TABLE client_ledger (
  id                 BIGSERIAL PRIMARY KEY,
  cliente_id         UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_type      client_ledger_movement_type NOT NULL,
  signed_amount      NUMERIC(15,2) NOT NULL CHECK (signed_amount <> 0),
  effective_date     DATE NOT NULL,                     -- period determinant
  ledger_client_name VARCHAR(255) NOT NULL,             -- SNAPSHOT of clients.nombre at posting
  source_entity_type VARCHAR(50),                       -- 'pedido' | 'collections' | 'financial_instrument'
  source_entity_id   VARCHAR(100),
  reversal_of_id     BIGINT REFERENCES client_ledger(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE client_ledger ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_client_ledger_cliente_date ON client_ledger(cliente_id, effective_date);
CREATE INDEX idx_client_ledger_source       ON client_ledger(source_entity_type, source_entity_id);
```
Sign convention: `+` increases client debt, `-` reduces it. No stored balance.
APPEND_ONLY. Written exclusively by RPCs. Collections are never assigned to specific orders.

### collections
```sql
CREATE TABLE collections (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id           UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount               NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_method       payment_method NOT NULL,
  receipt_id           VARCHAR(100) UNIQUE NOT NULL,     -- idempotency key
  effective_date       DATE NOT NULL,                    -- period determinant
  financial_account_id UUID REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  sales_session_id     UUID REFERENCES sales_session(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_collections_no_cheque CHECK (payment_method <> 'CHEQUE'),
  CONSTRAINT chk_collections_account_required CHECK (financial_account_id IS NOT NULL)
);
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_collections_cliente_date ON collections(cliente_id, effective_date);
```
`chk_collections_no_cheque` enforces single ownership at schema level: cheque receipt is created
ONLY by `receive_cheque`, never by `register_collection`. Split payments are separate rows.

---

## DOMAIN E — TREASURY / FINANCIAL LEDGER

### financial_operation
```sql
CREATE TABLE financial_operation (
  id                 BIGSERIAL PRIMARY KEY,
  operation_type     financial_operation_type NOT NULL,
  effective_date     DATE NOT NULL,                      -- period determinant
  external_ref       VARCHAR(100) UNIQUE,                -- idempotency key (bank ref, receipt, transfer id)
  source_entity_type VARCHAR(50),
  source_entity_id   VARCHAR(100),
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE financial_operation ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_financial_operation_date ON financial_operation(effective_date);
```
Parent of 1..N postings. Fees/differences are separate explicit operations, never netted.

### financial_posting
```sql
CREATE TABLE financial_posting (
  id                     BIGSERIAL PRIMARY KEY,
  financial_operation_id BIGINT NOT NULL REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_account_id   UUID   NOT NULL REFERENCES financial_account(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
  signed_amount          NUMERIC(15,2) NOT NULL CHECK (signed_amount <> 0),
  effective_date         DATE NOT NULL,                  -- period determinant
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE financial_posting ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_financial_posting_account_date ON financial_posting(financial_account_id, effective_date);
CREATE INDEX idx_financial_posting_operation    ON financial_posting(financial_operation_id);
```
`financial_operation_id` is BIGINT (FK to a BIGSERIAL PK). Account balance = `SUM(signed_amount)`.
APPEND_ONLY; corrections are compensating postings.

### financial_instrument
```sql
CREATE TABLE financial_instrument (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_type      financial_instrument_type NOT NULL,
  direction            instrument_direction NOT NULL,
  estado               instrument_estado NOT NULL,
  cheque_number        VARCHAR(50) NOT NULL,             -- business data; NOT globally unique
  amount               NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  maturity_date        DATE,
  -- provenance
  cliente_id           UUID REFERENCES clients(id)           ON DELETE RESTRICT ON UPDATE CASCADE,
  supplier_id          UUID REFERENCES suppliers(id)         ON DELETE RESTRICT ON UPDATE CASCADE,
  bank_account_id      UUID REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  source_collection_id UUID REFERENCES collections(id)       ON DELETE RESTRICT ON UPDATE CASCADE,
  endorsed_to_supplier_id UUID REFERENCES suppliers(id)      ON DELETE RESTRICT ON UPDATE CASCADE,
  -- idempotency
  receipt_id           VARCHAR(100) UNIQUE,               -- set on RECEIVED (reception receipt)
  external_ref         VARCHAR(100) UNIQUE,               -- set on ISSUED (issuance reference)
  -- business dates (period determinants per lifecycle step)
  received_date        DATE,
  deposited_date       DATE,
  cleared_date         DATE,
  endorsed_date        DATE,
  issued_date          DATE,
  debited_date         DATE,
  rejected_date        DATE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_instrument_received_provenance CHECK (
    direction <> 'RECEIVED'
    OR (cliente_id IS NOT NULL AND received_date IS NOT NULL AND receipt_id IS NOT NULL)),
  CONSTRAINT chk_instrument_issued_provenance CHECK (
    direction <> 'ISSUED'
    OR (supplier_id IS NOT NULL AND issued_date IS NOT NULL AND bank_account_id IS NOT NULL)),
  CONSTRAINT chk_instrument_estado_direction CHECK (
    (direction = 'RECEIVED' AND estado IN ('RECEIVED','DEPOSITED','CLEARED','ENDORSED','REJECTED'))
    OR (direction = 'ISSUED' AND estado IN ('ISSUED','DEBITED','REJECTED','CANCELLED')))
);
ALTER TABLE financial_instrument ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_instrument_estado   ON financial_instrument(direction, estado);
CREATE INDEX idx_instrument_cliente  ON financial_instrument(cliente_id)  WHERE cliente_id IS NOT NULL;
CREATE INDEX idx_instrument_supplier ON financial_instrument(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_instrument_maturity ON financial_instrument(maturity_date);
```
Technical identity is `id` (UUID). `cheque_number` is business data and is NOT unique — the same
printed number legitimately recurs across banks, suppliers and years. Idempotency is carried by
`receipt_id` (received) / `external_ref` (issued).

`bank_account_id` is recorded at CLEARED (received) or at ISSUED (issued), so a later rejection can
reverse the correct account deterministically.

**[ADR-001] Issued-instrument cancellation.** Added by amendment, applied as an `ALTER` so earlier
migrations stay untouched:
```sql
ALTER TABLE financial_instrument ADD COLUMN cancelled_date DATE;   -- period determinant of RPC 42
ALTER TABLE financial_instrument ADD CONSTRAINT chk_instrument_cancelled_coherent CHECK (
  (estado = 'CANCELLED' AND cancelled_date IS NOT NULL)
  OR (estado <> 'CANCELLED' AND cancelled_date IS NULL));
```
Bidirectional: a CANCELLED instrument always carries its cancellation date, and no other state can.
CANCELLED remains ISSUED-only through `chk_instrument_estado_direction`.

### financial_instrument_event
```sql
CREATE TABLE financial_instrument_event (
  id                     BIGSERIAL PRIMARY KEY,
  financial_instrument_id UUID NOT NULL REFERENCES financial_instrument(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_type             instrument_estado NOT NULL,
  event_date             DATE NOT NULL,                   -- period determinant
  financial_operation_id BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason                 TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE financial_instrument_event ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX idx_instrument_event_unique
  ON financial_instrument_event(financial_instrument_id, event_type);
CREATE INDEX idx_instrument_event_date ON financial_instrument_event(event_date);
```
Append-only lifecycle trail. The unique index prevents duplicate state events on one instrument,
which also removes the event_date duplication risk.

---

## DOMAIN F — SUPPLIERS, PURCHASES, FREIGHT

### supplier_ledger
```sql
CREATE TABLE supplier_ledger (
  id                 BIGSERIAL PRIMARY KEY,
  supplier_id        UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_type      supplier_ledger_movement_type NOT NULL,
  signed_amount      NUMERIC(15,2) NOT NULL CHECK (signed_amount <> 0),
  effective_date     DATE NOT NULL,                        -- period determinant
  source_entity_type VARCHAR(50),                          -- 'purchases' | 'freight' | 'financial_instrument' | 'payment'
  source_entity_id   VARCHAR(100),
  reversal_of_id     BIGINT REFERENCES supplier_ledger(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE supplier_ledger ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_supplier_ledger_supplier_date ON supplier_ledger(supplier_id, effective_date);
```
Sign convention: `+` increases supplier debt, `-` reduces it. Global supplier current account:
payments are NOT allocated to specific invoices (frozen Part 8).

### purchases
```sql
CREATE TABLE purchases (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id            UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  economic_date          DATE NOT NULL,                     -- period determinant (frozen Part 20)
  amount_net             NUMERIC(15,2) NOT NULL CHECK (amount_net >= 0),
  amount_total           NUMERIC(15,2) NOT NULL CHECK (amount_total > 0),
  -- management classification (required)
  expense_category_id    UUID NOT NULL REFERENCES expense_category(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  subcategory            VARCHAR(100),
  nature                 purchase_nature NOT NULL,
  project_id             UUID REFERENCES projects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- optional fiscal linkage
  fiscal_document_id     UUID REFERENCES fiscal_document(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  supplier_invoice_number VARCHAR(100),
  -- optional productive linkage (e.g. pullet purchase)
  flock_id               UUID REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- versioning
  is_current             BOOLEAN NOT NULL DEFAULT true,
  version_seq            INTEGER NOT NULL DEFAULT 0,
  idempotency_key        VARCHAR(100) UNIQUE NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;

-- Invoice number uniqueness is scoped BY SUPPLIER, never global.
CREATE UNIQUE INDEX idx_purchases_supplier_invoice
  ON purchases(supplier_id, supplier_invoice_number)
  WHERE supplier_invoice_number IS NOT NULL AND is_current = true;

CREATE INDEX idx_purchases_economic_date ON purchases(economic_date) WHERE is_current = true;
CREATE INDEX idx_purchases_supplier      ON purchases(supplier_id);
CREATE INDEX idx_purchases_project       ON purchases(project_id) WHERE project_id IS NOT NULL;
```
Purchase = economic obligation recognised at `economic_date`. Immediate, pending or partial payment
is a property of the supplier ledger, not of this row. Fiscal data is optional; management
classification (`expense_category_id`, `nature`) is mandatory.

**[ADR-002] `idempotency_key` semantics (no DDL change).** Version 0 carries the caller's key, which may not start with the reserved prefix `RECTIFY:`. Every rectified version carries the system key `'RECTIFY:' || <predecessor purchase id> || ':v' || version_seq`, at most 56 characters. The column stays `VARCHAR(100) UNIQUE NOT NULL`.

**Attachment is REQUIRED** — enforced by `register_purchase`, which inserts the purchase and at
least one `purchase_attachment` in the same transaction. No application role can insert a purchase
directly, so a purchase without an attachment cannot exist.

### purchase_line
```sql
CREATE TABLE purchase_line (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id        UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  producto_id        UUID REFERENCES products(id)         ON DELETE RESTRICT ON UPDATE CASCADE,
  feed_ingredient_id UUID REFERENCES feed_ingredient(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
  descripcion        VARCHAR(255) NOT NULL,
  cantidad           DECIMAL(15,4) NOT NULL CHECK (cantidad > 0),
  unit_type          unit_type NOT NULL,
  precio_unitario    NUMERIC(15,2) NOT NULL CHECK (precio_unitario >= 0),
  subtotal           NUMERIC(15,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE purchase_line ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_purchase_line_purchase ON purchase_line(purchase_id);
```
Carries input quantity / unit / unit price. `unit_type='CARTON'` covers carton purchases.
This is the historical cost source for inputs; master prices never restate it.

### purchase_attachment
```sql
CREATE TABLE purchase_attachment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id   UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  storage_path  TEXT NOT NULL,                    -- Supabase Storage object path
  file_name     VARCHAR(255) NOT NULL,
  content_type  VARCHAR(100) NOT NULL,
  byte_size     BIGINT CHECK (byte_size > 0),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by   UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(purchase_id, storage_path)
);
ALTER TABLE purchase_attachment ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_purchase_attachment_purchase ON purchase_attachment(purchase_id);
```
**[ADR-008]** `storage_path` is the key of an object in the private Storage bucket `purchase-attachments`
(generated as `<auth-user-id>/<uuid>.<ext>`; ADMIN-only; 10 MB; PDF / JPEG / PNG / WebP). `file_name` keeps the
user's original file name as metadata only. The table itself is unchanged.

### freight
```sql
CREATE TABLE freight (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id        UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  economic_date      DATE NOT NULL,                       -- period determinant (frozen Part 20)
  amount             NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  document_ref       VARCHAR(100),
  fiscal_document_id UUID REFERENCES fiscal_document(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  expense_category_id UUID NOT NULL REFERENCES expense_category(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  is_current         BOOLEAN NOT NULL DEFAULT true,
  version_seq        INTEGER NOT NULL DEFAULT 0,
  idempotency_key    VARCHAR(100) UNIQUE NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE freight ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_freight_economic_date ON freight(economic_date) WHERE is_current = true;
```
Freight is an **independent economic operation** (frozen Part 9) with its own supplier, document,
fiscal components and payment. Recognising it creates supplier debt exactly once.

### freight_allocation
```sql
CREATE TABLE freight_allocation (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  freight_id       UUID NOT NULL REFERENCES freight(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  purchase_id      UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  allocated_amount NUMERIC(15,2) NOT NULL CHECK (allocated_amount > 0),
  allocated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  allocated_by     UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(freight_id, purchase_id)
);
ALTER TABLE freight_allocation ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_freight_allocation_purchase ON freight_allocation(purchase_id);
```
**No double counting.** Allocation is a *cost attribution only*: it creates NO supplier_ledger row,
NO financial_posting and NO fiscal component. The economic recognition already happened in `freight`.

Landed cost of a purchase (derived, never stored):
```
landed_cost(purchase) = purchases.amount_total
                      + COALESCE((SELECT SUM(allocated_amount)
                                  FROM freight_allocation
                                  WHERE purchase_id = purchases.id), 0)
```
P&L reads freight through allocation when the purchase is consumed as cost; it must not also read
`freight.amount` as an independent expense line. Over-allocation is blocked by
`assign_freight_to_purchase`, which enforces
`SUM(allocated_amount) <= freight.amount`.

---

## DOMAIN G — PRODUCTION

### flocks
```sql
CREATE TABLE flocks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shed_id            UUID NOT NULL REFERENCES sheds(id)     ON DELETE RESTRICT ON UPDATE CASCADE,
  estado             flock_estado NOT NULL DEFAULT 'ACTIVE',
  genetics_line      VARCHAR(100),
  birth_date         DATE,
  entry_date         DATE NOT NULL,
  initial_population BIGINT NOT NULL CHECK (initial_population >= 0),
  supplier_id        UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  purchase_id        UUID REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  exit_date          DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE flocks ENABLE ROW LEVEL SECURITY;

-- One ACTIVE flock per shed (partial UNIQUE INDEX; partial constraints are not supported by ALTER TABLE)
CREATE UNIQUE INDEX idx_flocks_shed_active ON flocks(shed_id) WHERE estado = 'ACTIVE';
```
No `current_population` column. Population = `initial_population + SUM(population_events.delta)`
over current events. `purchase_id` optionally links the pullet purchase.

### population_events
```sql
CREATE TABLE population_events (
  id            BIGSERIAL PRIMARY KEY,
  flock_id      UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_type    population_event_type NOT NULL,
  delta         BIGINT NOT NULL CHECK (delta <> 0),
  event_date    DATE NOT NULL,                        -- period determinant
  is_current    BOOLEAN NOT NULL DEFAULT true,
  superseded_by BIGINT REFERENCES population_events(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version_seq   INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE population_events ENABLE ROW LEVEL SECURITY;

-- Max ONE current MORTALITY per (flock, date). COUNT_ADJUSTMENT is intentionally unconstrained.
CREATE UNIQUE INDEX idx_population_events_mortality_current
  ON population_events(flock_id, event_date)
  WHERE event_type = 'MORTALITY' AND is_current = true;

CREATE INDEX idx_population_events_flock_date ON population_events(flock_id, event_date);
```
Mortality is 1:1 replaceable, so `superseded_by` is meaningful here (unlike order lines).
No MORTALITY_CONFLICT type, no conflict_flag (frozen Part 26).

### daily_production
```sql
CREATE TABLE daily_production (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flock_id        UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  production_date DATE NOT NULL,                       -- period determinant
  eggs_total      INTEGER NOT NULL CHECK (eggs_total >= 0),
  eggs_broken     INTEGER NOT NULL DEFAULT 0 CHECK (eggs_broken >= 0),
  eggs_dirty      INTEGER NOT NULL DEFAULT 0 CHECK (eggs_dirty  >= 0),
  is_current      BOOLEAN NOT NULL DEFAULT true,
  superseded_by   UUID REFERENCES daily_production(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version_seq     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE daily_production ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX idx_daily_production_current
  ON daily_production(flock_id, production_date)
  WHERE is_current = true;

CREATE INDEX idx_daily_production_flock_date ON daily_production(flock_id, production_date);
```
Production and mortality are separate facts even though one operator screen captures both
(frozen Part 12). There is no `classification_session_id` here (frozen Part 26).

### flock_weighing
```sql
CREATE TABLE flock_weighing (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flock_id          UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  weighing_date     DATE NOT NULL,                     -- period determinant
  sample_size       INTEGER NOT NULL CHECK (sample_size > 0),
  average_weight_kg DECIMAL(10,3) NOT NULL CHECK (average_weight_kg > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(flock_id, weighing_date)
);
ALTER TABLE flock_weighing ENABLE ROW LEVEL SECURITY;
```

### temperature_record
```sql
CREATE TABLE temperature_record (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shed_id             UUID NOT NULL REFERENCES sheds(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  record_date         DATE NOT NULL,                    -- period determinant
  record_time         TIME NOT NULL,
  temperature_celsius DECIMAL(5,1) NOT NULL,
  humidity_pct        DECIMAL(5,2) CHECK (humidity_pct BETWEEN 0 AND 100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(shed_id, record_date, record_time)
);
ALTER TABLE temperature_record ENABLE ROW LEVEL SECURITY;
```

---

## DOMAIN H — CLASSIFICATION

### classification
```sql
CREATE TABLE classification (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key     UUID UNIQUE NOT NULL,
  classification_date DATE NOT NULL,                   -- period determinant (frozen Part 20)
  location            VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE classification ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_classification_date ON classification(classification_date);
```
**No `flock_id`.** Eggs from different flocks mix before classification; inventing traceability is
forbidden (frozen Part 14/26). Multiple sessions per day are allowed, so there is no
UNIQUE(classification_date, location); `idempotency_key` prevents retry duplicates.

**[ADR-012]** `+ version_seq INTEGER NOT NULL DEFAULT 0`, `+ is_current BOOLEAN NOT NULL DEFAULT true`, `+ supersedes_id UUID UNIQUE REFERENCES classification(id) ON DELETE RESTRICT`, `+ rectification_reason TEXT`, `chk_classification_version_chain`, partial index `idx_classification_current_date`. Still no flock reference.

### classification_line
```sql
CREATE TABLE classification_line (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classification_id      UUID NOT NULL REFERENCES classification(id)       ON DELETE RESTRICT ON UPDATE CASCADE,
  classification_grade_id UUID NOT NULL REFERENCES classification_grade(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  quantity               INTEGER NOT NULL CHECK (quantity >= 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(classification_id, classification_grade_id)
);
ALTER TABLE classification_line ENABLE ROW LEVEL SECURITY;
```
Grade is an FK to `classification_grade`, not free text.

---

## DOMAIN I — FEED

**[ADR-012]** `+ entered_quantity INTEGER NOT NULL CHECK (>= 0)`, `+ entered_unit classification_entry_unit NOT NULL` (enum `'UNIDAD','MAPLE'`), `chk_classification_line_unidad` (UNIDAD ⇒ `quantity = entered_quantity`). `quantity` remains the canonical egg count.

### feed_formula_version
```sql
CREATE TABLE feed_formula_version (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_type_id   UUID NOT NULL REFERENCES feed_type(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version        INTEGER NOT NULL CHECK (version > 0),
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(feed_type_id, version),
  CONSTRAINT chk_formula_version_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE feed_formula_version ENABLE ROW LEVEL SECURITY;
```
Immutable once referenced by manufacturing.

**[ADR-013]** `excl_feed_formula_version_no_overlap EXCLUDE USING gist (feed_type_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)`: one effective version per feed type on any date. Versions are written only by RPC 48.

### feed_formula_line
```sql
CREATE TABLE feed_formula_line (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_version_id UUID NOT NULL REFERENCES feed_formula_version(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ingredient_id      UUID NOT NULL REFERENCES feed_ingredient(id)      ON DELETE RESTRICT ON UPDATE CASCADE,
  quantity_kg        DECIMAL(15,3) NOT NULL CHECK (quantity_kg > 0),   -- per 100 kg batch
  unit_cost_snapshot NUMERIC(15,2),                                    -- historical cost frozen at version creation
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(formula_version_id, ingredient_id)
);
ALTER TABLE feed_formula_line ENABLE ROW LEVEL SECURITY;
```
`unit_cost_snapshot` is cost data: OPERATOR must never read it. Operators read the
`feed_formula_line_safe` view (composition without cost) defined in the RLS spec.

### feed_manufacturing

**[ADR-014]** `+ version_seq INTEGER NOT NULL DEFAULT 0`, `+ is_current BOOLEAN NOT NULL DEFAULT true`, `+ supersedes_id UUID UNIQUE REFERENCES feed_manufacturing(id) ON DELETE RESTRICT`, `+ rectification_reason TEXT`, `chk_feed_manufacturing_version_chain`, partial index `idx_feed_manufacturing_current_date`. Written only by RPCs 26 / 49.
```sql
CREATE TABLE feed_manufacturing (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_version_id UUID NOT NULL REFERENCES feed_formula_version(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  manufacturing_date DATE NOT NULL,                     -- period determinant
  quantity_kg        DECIMAL(15,3) NOT NULL CHECK (quantity_kg > 0),
  batch_number       VARCHAR(50),
  idempotency_key    VARCHAR(100) UNIQUE NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE feed_manufacturing ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_feed_manufacturing_date ON feed_manufacturing(manufacturing_date);
```
`formula_version_id` is the exact version applied and is immutable. Batch cost is derived from
`feed_formula_line.unit_cost_snapshot`; it is not stored here.

### feed_movement
```sql
CREATE TABLE feed_movement (
  id            BIGSERIAL PRIMARY KEY,
  feed_type_id  UUID NOT NULL REFERENCES feed_type(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_type feed_movement_type NOT NULL,
  quantity_kg   DECIMAL(15,3) NOT NULL CHECK (quantity_kg > 0),
  movement_date DATE NOT NULL,                          -- period determinant
  pedido_id     UUID REFERENCES pedidos(id) ON DELETE RESTRICT ON UPDATE CASCADE,  -- when EXTERNAL_SALE
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE feed_movement ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_feed_movement_type_date ON feed_movement(feed_type_id, movement_date);
```
External output and adjustments for the stock equation (frozen Part 15). Append-only.

### feed_inventory_count
```sql
CREATE TABLE feed_inventory_count (
  id           BIGSERIAL PRIMARY KEY,
  feed_type_id UUID NOT NULL REFERENCES feed_type(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  count_date   DATE NOT NULL,                           -- period determinant (frozen Part 20)
  quantity_kg  DECIMAL(15,3) NOT NULL CHECK (quantity_kg >= 0),
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(feed_type_id, count_date)
);
ALTER TABLE feed_inventory_count ENABLE ROW LEVEL SECURITY;
```
A physical count is an observation, not a computed balance. **Consumo interno calculado** is derived
per period and never stored:
```
consumo_interno = opening_count + manufacturing - external_output ± adjustments - closing_count
```
where opening/closing come from `feed_inventory_count`, manufacturing from `feed_manufacturing`,
and output/adjustments from `feed_movement`.

### flock_feed_assignment
```sql
CREATE TABLE flock_feed_assignment (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flock_id       UUID NOT NULL REFERENCES flocks(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  feed_type_id   UUID NOT NULL REFERENCES feed_type(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_flock_feed_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE flock_feed_assignment ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX idx_flock_feed_current ON flock_feed_assignment(flock_id) WHERE effective_to IS NULL;
```
Which feed type a flock receives (frozen Part 15). Input to consumo teórico, not to real consumption.

---

## DOMAIN J — FERIA (SALES SESSIONS)

### sales_session
```sql
CREATE TABLE sales_session (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date         DATE NOT NULL,                   -- period determinant
  location             VARCHAR(100) NOT NULL,
  estado               session_estado NOT NULL DEFAULT 'OPEN',
  aggregated_pedido_id UUID REFERENCES pedidos(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  opened_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by            UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  closed_at            TIMESTAMPTZ,
  closed_by            UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  idempotency_key      VARCHAR(100) UNIQUE NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE sales_session ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_sales_session_date ON sales_session(session_date);
```
The session is the **operational/physical** event. The economic fact is the Pedido
(frozen Part 16). `aggregated_pedido_id` points to the single Consumidor Final Pedido whose
`pedido_lineas` itemise the retail total; identified wholesale clients get normal Pedidos carrying
`pedidos.sales_session_id`. No individual anonymous sale rows exist.

### sales_session_movement
```sql
CREATE TABLE sales_session_movement (
  id               BIGSERIAL PRIMARY KEY,
  sales_session_id UUID NOT NULL REFERENCES sales_session(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_type    session_movement_type NOT NULL,      -- DISPATCH | RETURN | LOSS | ADJUSTMENT
  producto_id      UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cantidad         DECIMAL(15,4) NOT NULL CHECK (cantidad > 0),
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE sales_session_movement ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_session_movement_session ON sales_session_movement(sales_session_id);
```
Physical movements only. Quantities are physical, never economic.

### sales_session_cash_event
```sql
CREATE TABLE sales_session_cash_event (
  id                     BIGSERIAL PRIMARY KEY,
  sales_session_id       UUID NOT NULL REFERENCES sales_session(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_type             session_cash_event_type NOT NULL,  -- OPENING_FUND | EXPENSE | WITHDRAWAL | TRANSFER_OUT | COUNT
  amount                 NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  financial_account_id   UUID REFERENCES financial_account(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
  expense_category_id    UUID REFERENCES expense_category(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_date             DATE NOT NULL,                     -- period determinant
  reason                 TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_session_expense_category CHECK (
    event_type <> 'EXPENSE' OR expense_category_id IS NOT NULL)
);
ALTER TABLE sales_session_cash_event ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_session_cash_session ON sales_session_cash_event(sales_session_id);
```
Opening change fund, session expenses, withdrawals/transfers and the physical cash count.
`COUNT` events are observations and carry no financial posting; the others do.

---

## DOMAIN K — FISCAL

Separate layer. It does NOT duplicate economic operations (frozen Part 18). Rates are snapshots;
nothing is hardcoded. Final legal reporting stays external (ARCA / professional).

### fiscal_document
```sql
CREATE TABLE fiscal_document (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type   fiscal_document_type NOT NULL,
  direction       fiscal_direction NOT NULL,             -- CREDITO = received, DEBITO = issued
  document_date   DATE NOT NULL,                         -- period determinant (document period)
  fiscal_period   DATE NOT NULL,                         -- tax period, month start
  supplier_id     UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cliente_id      UUID REFERENCES clients(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  external_number VARCHAR(100),                          -- number issued by AFIP/ARCA or supplier
  net_amount      NUMERIC(15,2) NOT NULL CHECK (net_amount >= 0),
  total_amount    NUMERIC(15,2) NOT NULL CHECK (total_amount >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_fiscal_period_month_start
    CHECK (fiscal_period = date_trunc('month', fiscal_period)::DATE),
  CONSTRAINT chk_fiscal_counterparty CHECK (
    (direction = 'CREDITO' AND supplier_id IS NOT NULL)
    OR (direction = 'DEBITO' AND cliente_id IS NOT NULL))
);
ALTER TABLE fiscal_document ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX idx_fiscal_document_supplier_number
  ON fiscal_document(supplier_id, external_number)
  WHERE supplier_id IS NOT NULL AND external_number IS NOT NULL;
CREATE INDEX idx_fiscal_document_period ON fiscal_document(fiscal_period);
```

### fiscal_document_component
```sql
CREATE TABLE fiscal_document_component (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_document_id UUID NOT NULL REFERENCES fiscal_document(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  tax_kind           tax_kind NOT NULL,
  direction          fiscal_direction NOT NULL,          -- IVA débito vs IVA crédito
  base_amount        NUMERIC(15,2) NOT NULL CHECK (base_amount >= 0),
  rate_applied       NUMERIC(7,4)  NOT NULL CHECK (rate_applied >= 0),  -- SNAPSHOT of the rate actually used
  tax_amount         NUMERIC(15,2) NOT NULL CHECK (tax_amount >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE fiscal_document_component ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_fiscal_component_document ON fiscal_document_component(fiscal_document_id);
```
`rate_applied` is the historical rate snapshot. Rates are never read from code constants.

### fiscal_obligation
```sql
CREATE TABLE fiscal_obligation (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_kind      tax_kind NOT NULL,
  fiscal_period DATE NOT NULL,                           -- period determinant (tax period)
  amount        NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  due_date      DATE,
  status        fiscal_obligation_status NOT NULL DEFAULT 'PENDING',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_obligation_period_month_start
    CHECK (fiscal_period = date_trunc('month', fiscal_period)::DATE),
  UNIQUE(tax_kind, fiscal_period)
);
ALTER TABLE fiscal_obligation ENABLE ROW LEVEL SECURITY;
```
`status` is derived-but-materialised bookkeeping maintained ONLY by `pay_fiscal_obligation`.

### fiscal_obligation_installment
```sql
CREATE TABLE fiscal_obligation_installment (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_obligation_id UUID NOT NULL REFERENCES fiscal_obligation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  installment_number  INTEGER NOT NULL CHECK (installment_number > 0),
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  due_date            DATE NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(fiscal_obligation_id, installment_number)
);
ALTER TABLE fiscal_obligation_installment ENABLE ROW LEVEL SECURITY;
```
Payment plans (frozen Part 18: installments).

### fiscal_payment
```sql
CREATE TABLE fiscal_payment (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_obligation_id   UUID NOT NULL REFERENCES fiscal_obligation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  installment_id         UUID REFERENCES fiscal_obligation_installment(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  effective_date         DATE NOT NULL,                  -- period determinant (payment month)
  amount                 NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  financial_account_id   UUID NOT NULL REFERENCES financial_account(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id BIGINT NOT NULL REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  idempotency_key        VARCHAR(100) UNIQUE NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE fiscal_payment ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_fiscal_payment_obligation ON fiscal_payment(fiscal_obligation_id);
```

---

## DOMAIN L — MERCADO PAGO INTEGRATION

Pipeline (frozen Part 22): immutable source → normalized movement → reconciliation (N:N,
amount-assigned) → internal financial operation/postings. MP is NOT a general ledger.

### mp_source_record
```sql
CREATE TABLE mp_source_record (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ── RAW SOURCE DATA: immutable after insert ──
  source_type       VARCHAR(50) NOT NULL,                -- 'webhook' | 'api' | 'csv_import'
  external_id       VARCHAR(100) NOT NULL,               -- MP's own id
  event_data        JSONB NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,                -- MP's timestamp
  occurred_date     DATE NOT NULL,                       -- period determinant, MP's own date
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ── PROCESSING METADATA: controlled mutable ──
  processing_status mp_processing_status NOT NULL DEFAULT 'PENDING',
  processed_at      TIMESTAMPTZ,
  processing_note   TEXT,
  UNIQUE(source_type, external_id)
);
ALTER TABLE mp_source_record ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_mp_source_status ON mp_source_record(processing_status);
CREATE INDEX idx_mp_source_date   ON mp_source_record(occurred_date);
```
**Immutability boundary (explicit).** Raw columns
`source_type, external_id, event_data, occurred_at, occurred_date, ingested_at`
are immutable — nothing may ever rewrite them. The ONLY mutable columns are
`processing_status, processed_at, processing_note`, and the ONLY writer is
`mp_normalize_source` / `mp_reconcile_movement` (SECURITY DEFINER). Raw immutability is enforced by
trigger, because a column-level guarantee cannot be expressed by RLS alone:

```sql
-- Deliberately SECURITY INVOKER (the PostgreSQL default): the guard only compares OLD against NEW
-- and crosses neither RLS nor any privilege, so elevation would add privilege for nothing.
-- It is therefore NOT part of the SECURITY DEFINER inventory in RLS_IMPLEMENTATION_SPEC_V1.md.
-- The trigger fires regardless of the caller's role, so the raw columns stay protected either way.
CREATE OR REPLACE FUNCTION mp_source_raw_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_type   IS DISTINCT FROM OLD.source_type
  OR NEW.external_id   IS DISTINCT FROM OLD.external_id
  OR NEW.event_data    IS DISTINCT FROM OLD.event_data
  OR NEW.occurred_at   IS DISTINCT FROM OLD.occurred_at
  OR NEW.occurred_date IS DISTINCT FROM OLD.occurred_date
  OR NEW.ingested_at   IS DISTINCT FROM OLD.ingested_at THEN
    RAISE EXCEPTION 'mp_source_record raw source data is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mp_source_raw_guard
  BEFORE UPDATE ON mp_source_record
  FOR EACH ROW EXECUTE FUNCTION mp_source_raw_guard();
```
No application role holds UPDATE or DELETE on this table (see RLS spec). `occurred_date` is the
period determinant; the reconciliation timestamp never changes the original fact's period.

### mp_financial_movement
```sql
CREATE TABLE mp_financial_movement (
  id                  BIGSERIAL PRIMARY KEY,
  mp_source_record_id UUID NOT NULL REFERENCES mp_source_record(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_kind       VARCHAR(50) NOT NULL,              -- payment | fee | tax | settlement | yield | transfer
  gross_amount        NUMERIC(15,2) NOT NULL,
  fee_amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  net_amount          NUMERIC(15,2) NOT NULL,
  occurred_date       DATE NOT NULL,                     -- inherited from source; period determinant
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(mp_source_record_id, movement_kind)
);
ALTER TABLE mp_financial_movement ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_mp_movement_date ON mp_financial_movement(occurred_date);
```
Normalized external movement preserving gross / fees / taxes / net.

### mp_reconciliation
```sql
CREATE TABLE mp_reconciliation (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mp_financial_movement_id BIGINT NOT NULL REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id   BIGINT NOT NULL REFERENCES financial_operation(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  assigned_amount          NUMERIC(15,2) NOT NULL CHECK (assigned_amount <> 0),
  reconciled_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reconciled_by            UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(mp_financial_movement_id, financial_operation_id)
);
ALTER TABLE mp_reconciliation ENABLE ROW LEVEL SECURITY;
```
N:N amount-assigned bridge. No invented correspondence: a movement may stay unreconciled.

---

## INVENTORY (EXACT)

| # | Table | Domain | Append-only | Period determinant |
|---|---|---|---|---|
| 1 | perfiles | Identity | no | — |
| 2 | management_period | Periods | no (RPC-only status) | periodo_fecha |
| 3 | audit_events | Audit | yes | — |
| 4 | operator_assignments | Identity | no | — |
| 5 | sheds | Masters | no | — |
| 6 | clients | Masters | no | — |
| 7 | products | Masters | no | — |
| 8 | price_history | Masters | no | effective_from |
| 9 | suppliers | Masters | no | — |
| 10 | financial_account | Masters | no | — |
| 11 | expense_category | Masters | no | — |
| 12 | classification_grade | Masters | no | — |
| 13 | projects | Masters | no | — |
| 14 | feed_type | Masters | no | — |
| 15 | feed_ingredient | Masters | no | — |
| 16 | genetics_consumption_curve | Masters | no | — |
| 17 | pedidos | Commercial | no (RPC-only transitions) | delivered_date |
| 18 | pedido_lineas | Commercial | yes | via pedidos |
| 19 | client_ledger | Client ledger | yes | effective_date |
| 20 | collections | Collections | yes | effective_date |
| 21 | financial_operation | Treasury | yes | effective_date |
| 22 | financial_posting | Treasury | yes | effective_date |
| 23 | financial_instrument | Instruments | no (RPC-only transitions) | per-step date columns (incl. `cancelled_date` **[ADR-001]**) |
| 24 | financial_instrument_event | Instruments | yes | event_date |
| 25 | supplier_ledger | Suppliers | yes | effective_date |
| 26 | purchases | Purchases | yes (versioned) | economic_date |
| 27 | purchase_line | Purchases | yes | via purchases |
| 28 | purchase_attachment | Purchases | no (add/remove by ADMIN) | — |
| 29 | freight | Freight | yes (versioned) | economic_date |
| 30 | freight_allocation | Freight | yes | via freight |
| 31 | flocks | Production | no | entry_date |
| 32 | population_events | Production | yes | event_date |
| 33 | daily_production | Production | yes (versioned) | production_date |
| 34 | flock_weighing | Production | yes | weighing_date |
| 35 | temperature_record | Production | yes | record_date |
| 36 | classification | Classification | yes | classification_date |
| 37 | classification_line | Classification | yes | via classification |
| 38 | feed_formula_version | Feed | no | effective_from |
| 39 | feed_formula_line | Feed | yes | via version |
| 40 | feed_manufacturing | Feed | yes | manufacturing_date |
| 41 | feed_movement | Feed | yes | movement_date |
| 42 | feed_inventory_count | Feed | yes | count_date |
| 43 | flock_feed_assignment | Feed | no | effective_from |
| 44 | sales_session | Feria | no (RPC-only transitions) | session_date |
| 45 | sales_session_movement | Feria | yes | via session |
| 46 | sales_session_cash_event | Feria | yes | event_date |
| 47 | fiscal_document | Fiscal | yes | document_date / fiscal_period |
| 48 | fiscal_document_component | Fiscal | yes | via document |
| 49 | fiscal_obligation | Fiscal | no (RPC-only status) | fiscal_period |
| 50 | fiscal_obligation_installment | Fiscal | yes | due_date |
| 51 | fiscal_payment | Fiscal | yes | effective_date |
| 52 | mp_source_record | MP | raw immutable / metadata controlled | occurred_date |
| 53 | mp_financial_movement | MP | yes | occurred_date |
| 54 | mp_reconciliation | MP | yes | — (does not change source period) |

**TOTAL: 54 tables.**

---

## DERIVED DATA — NEVER STORED

| Value | Derivation |
|---|---|
| client balance | `SUM(client_ledger.signed_amount)` per cliente_id |
| supplier balance | `SUM(supplier_ledger.signed_amount)` per supplier_id |
| account balance | `SUM(financial_posting.signed_amount)` per financial_account_id |
| order total | `SUM(pedido_lineas.subtotal) WHERE is_current = true` |
| flock population | `flocks.initial_population + SUM(population_events.delta WHERE is_current = true)` |
| classified total | `SUM(classification_line.quantity)` per session |
| consumo interno | opening_count + manufacturing − external_output ± adjustments − closing_count |
| consumo teórico | population × age × `genetics_consumption_curve` × assigned formula |
| landed cost | `purchases.amount_total + SUM(freight_allocation.allocated_amount)` |
| P&L | derived from ledgers/postings; no results table exists |

No table in this schema stores any of the above.

---

## TABLES EXPLICITLY ABSENT (frozen Part 26)

`ventas`, `client_balance` / `supplier_balance` / `account_balance` columns,
`MORTALITY_CONFLICT` / `conflict_flag` / `conflicting_event_id`, `classification_inputs`,
`daily_production.classification_session_id`, `daily_feed_consumption`, `pedido_audit_events`,
per-entity audit tables, any manual P&L results table.

---

## DEPLOYMENT NOTES

1. Create ENUMs before tables.
2. Create masters before referencing tables. `operator_assignments` references `flocks`;
   `pedidos` references `sales_session`; `purchases` references `fiscal_document`;
   create in the order given in `IMPLEMENTATION_DEPENDENCY_ORDER_V1.md`.
3. Partial uniqueness is always `CREATE UNIQUE INDEX ... WHERE ...`; `ALTER TABLE ADD CONSTRAINT
   UNIQUE ... WHERE ...` does not exist in PostgreSQL.
4. Enable RLS on every table, then attach the policies from `RLS_IMPLEMENTATION_SPEC_V1.md`.
5. `GENERATED ALWAYS AS ... STORED` requires PostgreSQL 12+.
6. Verify the `mp_source_record` raw-guard trigger exists before any MP ingestion runs.

---

**STATUS: FROZEN — PHYSICAL SCHEMA SPECIFIED, 54 TABLES, ALL FROZEN DOMAINS REPRESENTED**
