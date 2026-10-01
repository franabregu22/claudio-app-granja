# TARGET ARCHITECTURE V2: FROZEN

**STATUS:** FROZEN  
**VERSION:** V2  
**DATE:** 2026-09-24

This document is the authoritative target architecture for Granja Santo Tomás V1.

Earlier architecture reviews (Gap Analysis, Round 2, Round 3) are historical analysis and research.

**When an earlier document conflicts with this document, this document takes precedence.**

Changes to this frozen architecture require an explicit Architecture Decision Record (ADR).

---

## PART 1: CORE PRINCIPLES

### 1. Single Source of Truth

One business fact has one authoritative source.

Do NOT maintain two editable representations of the same fact.

Derived facts are computed from their source, never stored as independent editable fields.

Example:
```
Order total = SUM(order_lines.subtotal)    ← source
NOT
order.monto_total edited independently     ✗ (secondary, can diverge)
```

### 2. Domain Separation

Distinguish:

* **Physical/Productive:** galpones, flocks, population, production.
* **Economic:** orders, sales, purchase obligations, costs.
* **Financial:** cash accounts, postings, transfers, instruments.
* **Fiscal:** invoices, tax components, obligations, payments.
* **External Integration:** MP sources, reconciliation.
* **Audit:** who changed what, when, why.

One event may generate consequences in multiple domains, but they are not the same fact.

### 3. Fact vs. Consequence

Fact = the business event (e.g., customer payment received).

Consequences = derived impacts (CC movement, financial posting, instrument state change).

Do NOT collapse these into generic "movement" tables.

Example structure:

```
Collection (fact)
  └─ client_ledger entry (consequence)
  └─ financial_operation + posting (consequence)
  └─ financial_instrument_event (consequence if cheque)
```

### 4. Immutability

Facts committed/posted do NOT rewrite silently.

Corrections via:

* **Rectification:** controlled reversal + new state + audit.
* **Reversal:** compensating entry linking to original.
* **New consequence:** explicit adjustment recorded.
* **Audit trail:** before/after/reason/user/time.

### 5. Atomicity

Any operation affecting multiple sources of truth must execute transactionally in backend/DB.

Do NOT depend on sequences of INSERTs from React UI.

Example: Transfer MP → BNA must be atomic or both fail; no orphaned postings.

### 6. Historical Integrity

Future changes to master data do NOT alter the meaning of historical facts.

Preserve via:

* **Immutable versions** (e.g., formula versions).
* **Selective snapshots** (e.g., price on order_line).
* **Events** (immutable state transitions).
* **Audit trail** (before/after).

Choose per entity during Physical Database Design.

### 7. No Invented Precision

If Santo Tomás does NOT physically record data operationally, the system does NOT fabricate it.

Example: REJECT fictitious traceability of classified eggs to source flocks.

---

## PART 2: IDENTITY & PERMISSIONS

### Roles (V1)

**ADMIN:** Full management access.

**OPERATOR:** Production operations only:
* Lotes
* Daily production
* Mortality events
* Classifications
* Weighings
* Feed manufacturing
* Feed inventory counts
* Temperature records
* Authorized production history

OPERATOR CANNOT access:
* Clients
* Orders
* Sales
* Commercial prices
* Collections
* Client ledger
* Purchases/expenses
* Supplier accounts
* Financial accounts
* Costs
* P&L
* Unauthorized population/productivity data

**Security:** Must exist in DB/RLS, NOT just UI hiding.

---

## PART 3: COMMERCIAL DOMAIN

### Clients

Entity: `clients` (name, contact info, fiscal status history)

Saldo client:

`SUM(client_ledger movements)`

No stored running_balance as authority.

Can have negative balance = credit in favor.

### Products

Catalog: configurable.

A product may be:
* Vendible (sold to clients)
* Input (consumed internally)
* Both (e.g., maize)

Core V1 products:
* Eggs: XL, N1, N2, N3, Docena
* Feed: types and formulations
* Raw materials
* Other (future)

Do NOT hard-delete historical masters; deactivate.

### Prices

Lists:
* Mayorista
* Minorista

Maintain price history.

Order line PRESERVES the price actually used at time of order.

Do NOT use live master price as authority for historical orders.

### Pedido (Order)

**All sales flow through Pedido. There is NO separate Ventas table.**

States (V1):
* PENDING
* DELIVERED
* CANCELLED

**DELIVERED = economic sales event.**

No partial delivery in V1.

**Total derives from lines.**

Do NOT treat `monto_total` as independent editable field.

Preserve: `total = SUM(order_lines.subtotal)` invariant.

### Rectification (Post-Delivery)

PENDING orders: edit freely.

DELIVERED orders: no direct UPDATE of economic data.

ADMIN only: execute `Rectify sale` while period OPEN.

Requires reason; no additional threshold/approval V1.

Must:
1. Preserve prior state
2. Generate compensating GL entries
3. Apply corrected state
4. Generate new consequential entries
5. Audit: before/after/reason/user/time
6. Execute atomically

If period CLOSED: reopen first.

---

## PART 4: CLIENT LEDGER

Entity: `client_ledger`

Immutable audit trail of CC movements.

Convention:
* `+` increases client debt
* `-` reduces client debt

No stored running_balance authority.

Balance = SUM active/posted movements.

Supports:
* Sale
* Collection
* Advance payment
* Adjustment
* Reversal
* Cheque received
* Cheque rejection
* Opening balance

Collections do NOT require assignment to specific orders.

---

## PART 5: COLLECTIONS

Distinct from sales.

Can exist without specific Pedido.

Produces:
* Client ledger movement
* Financial consequence (if cash/transfer/instrument)

Split payment = separate collection records.

No hard-delete of committed collections.

---

## PART 6: TREASURY / FINANCIAL LEDGER

### Accounts (V1)

* Caja chica
* Mercado Pago
* BNA
* Patagonia

No editable stored balance.

Architecture:

```
financial_operation (1)
        |
        | (1:N)
        |
    financial_posting (N)
```

### Financial Posting

Each posting:
* Belongs to one operation (NOT NULL FK)
* References one financial_account
* Has signed amount
* Has effective date/time
* IMMUTABLE once posted
* Version control via compensating entries

Balance:

`SUM(financial_posting.amount WHERE account_id = X)`

### Operations

Multi-impact operations (e.g., transfer) are atomic:

```
Transfer MP → BNA (500k)
  financial_operation { type='transfer' }
    ├─ posting { account='MP', amount=-500k }
    └─ posting { account='BNA', amount=+500k }
  (both commit or both rollback)
```

Fees/differences are explicit separate operations.

Do NOT use debit/credit accounting as V1 requirement.

Signed amounts sufficient.

---

## PART 7: CHEQUES & ECHEQS

NOT financial accounts.

Entity: `financial_instrument` + `financial_instrument_events`

### Received Cheque

States:
```
RECEIVED / EN_CARTERA
  → DEPOSITED
  → CLEARED
```

Alternative:
```
EN_CARTERA
  → ENDORSED_TO_SUPPLIER
```

Or rejection at any point.

**Reception:**
* Reduces client CC
* Does NOT immediately increase bank account

**Endorsement to supplier:**
* Reduces supplier CC (opens obligation payment channel)
* Removes instrument from cartera
* Does NOT automatically reopen client CC debt

**Clearing/acreditación:**
* Generates bank impact (financial posting)

**Rejection:**
* Generates compensating consequences per stage

### Issued Cheque

States:
```
ISSUED
  → DEBITED
```

With cancellation/rejection when necessary.

Keep V1 simple.

---

## PART 8: PURCHASES & SUPPLIERS

Entity: `suppliers` (name, contact, fiscal status history, tax ID)

Entity: `supplier_ledger`

Convention:
* `+` increases supplier debt
* `-` reduces supplier debt

Balance = SUM ledger movements.

### Purchase/Expense

Represents economic obligation.

Naturaleza (nature):
* OPERATING
* REINVESTMENT
* INVESTMENT

Classification: direct/indirect per management needs.

Can be:
* Immediate payment
* Pending
* Partial

Supplier ledger does NOT require payment assigned to specific invoices.

Attachments per workflow defined.

> **Amendment [ADR-010]** (owner, 2026-09-30): attachments are optional for purchases. A purchase may be recorded with zero attachments; when a real document exists it is stored privately (ADR-008). See `.planning/adr/ADR-010_OPTIONAL_PURCHASE_ATTACHMENTS.md`.

Project optional as analytic dimension.

### No Hard Delete

No hard-delete of committed purchases.

---

## PART 9: FREIGHT / COSTO PUESTO

Freight (flete) is independent economic operation.

May have:
* Supplier
* Document
* Taxes
* Payment

Can be assigned as cost to purchase.

Assignment does NOT create second expense (no double-counting).

Must prevent duplication across:
* P&L
* Insumo cost
* IVA
* Supplier account
* Tesorería

Historical insumo cost preserved.

For formulations use historical cost per formula version, NOT mutable master price.

---

## PART 10: SHEDS & FLOCKS

Entity: `sheds` (name, capacity, etc.)

Entity: `flocks` (lotes)

One shed has maximum ONE active flock.

One flock belongs to ONE shed during productive alojamiento.

Flock preserves:
* Genetics
* Birth date
* Entry date
* Initial population
* Origin/supplier
* Historical data
* Exit/retirement date

Do NOT store `current_flock` duplicated if derivable.

Recría can occur pre-production per defined process.

---

## PART 11: POPULATION & MORTALITY

Population future:

```
initial_population + SUM(population_events.delta)
```

Event types:
* MORTALITY
* COUNT_ADJUSTMENT

**Constraint:** Max ONE MORTALITY per (flock_id, event_date).

Duplicate attempt:
* Reject (already exists)
* Inform operator of existing value
* Rectify if incorrect

Do NOT create:
* MORTALITY_CONFLICT type
* conflict_flag
* conflicting_event_id

Recount preserves observed value.

Variance may generate COUNT_ADJUSTMENT (explicit, audited).

---

## PART 12: PRODUCTION

Entity: `daily_production`

Per flock, per day.

Source: physical productive measurement.

**Keep UX operator simple** (one screen captures production + mortality).

Internally: separate facts.

Do NOT link production directly to classification.

Do NOT create `daily_production.classification_session_id`.

---

## PART 13: WEIGHINGS & TEMPERATURE

Required V1.

Entity: `flock_weighings` (lote, samples/individuals per defined model, date, value).

Entity: `temperature_records` (recría, date/time, value).

Do NOT defer for not existing currently.

---

## PART 14: CLASSIFICATION

Eggs from different flocks mix before classification.

Therefore: Classification does NOT reference flock.

Model:

```
classification (session)
  └─ classification_lines (grade, quantity)
```

Grades (V1):
* XL
* N1
* N2
* N3
* Rotos
* Sucios
* Descarte

> **Amendment [ADR-014]** (owner D-CLS-6, 2026-10-01): **Rotos is inactive for new classification entries** (merged forward into Descarte). The forward grade set is XL, N1, N2, N3, Sucios, Descarte. Historical Rotos lines are kept and displayed as recorded. This grade is unrelated to the Production metric "Rotos" (`daily_production.eggs_broken`), which is unchanged. See `.planning/adr/ADR-014_FEED_MANUFACTURING_RECTIFICATION.md`.

Multiple sessions per day allowed.

> **Amendment [ADR-012]** (owner, 2026-10-01): lines are entered as UNIDAD or MAPLE and converted by the backend to eggs (MAPLE = 20 for XL, 30 for the other grades); the entry is stored as typed. A session can be rectified as a whole with a new version (mandatory reason, original kept); reports count the current version. Classification still does not reference flock. See `.planning/adr/ADR-012_CLASSIFICATION_UNITS_RECTIFICATION.md`.

Do NOT create fictitious traceability.

Do NOT create `classification_inputs`.

Do NOT create `daily_production.classification_session_id`.

---

## PART 15: FEED

V1 architecture includes feed (implementation may be phased).

Includes:
* Raw materials
* Historical costs
* Feed types
* Formulations (recipes)
* Versions (immutable)
* Ingredients (composition)
* Manufacturing
* Sales/external output
* Adjustments
* Physical counts
* Flock assignment (type/formula)
* Productivity curves/theoretical consumption

### Formulations

Can change anytime.

Each version IMMUTABLE once used.

> **Amendment [ADR-013]** (owner, 2026-10-01): one effective formula version per feed type on any date; versions and their lines are published only through the atomic RPC 48 `publish_feed_formula_version`, which closes the prior version at D − 1; a version without lines is never manufactured. See `.planning/adr/ADR-013_FEED_FORMULA_PUBLICATION.md`.

Manufacturing references exact version applied.

> **Amendment [ADR-014]** (owner, 2026-10-01): a manufacturing record is corrected only through RPC 49 `rectify_feed_manufacturing` (whole-record new version, mandatory reason, original kept); consumption reporting counts current versions only. See `.planning/adr/ADR-014_FEED_MANUFACTURING_RECTIFICATION.md`.

### Consumo Económico / Calculado

Do NOT know actual daily real consumption by flock operationally.

Per period:

```
stock_initial
+ manufacturing
- sales/external_output
± adjustments
- stock_final
=
consumo_interno_calculado
```

Basis for monthly feed cost allocation.

### Consumo Teórico

Separate: per flock using:
* Population
* Age
* Genetics/curve
* Assigned type/formula

Productive control metric.

Does NOT represent real measured consumption.

### Architecture Constraint

Do NOT create `daily_feed_consumption` as false source of real consumption.

---

## PART 16: FERIA

Entity: `sales_session` (jornada)

Operational/physical event.

Pedido = economic fact (separate).

Conceptual model:

```
Sales session
  ├─ physical movements (dispatch/return/loss/adjustment)
  ├─ cash management (opening fund, expenses, withdrawals, count)
  ├─ Aggregated Pedido (Consumidor Final)
  ├─ Identified client Pedidos
  └─ Reconciliation (cash, MP, CC, variances)
```

Retail anonymous sale: NOT recorded as individual transaction.

Aggregated Pedido preserves itemization via `order_lines`.

Multiple lines same product OK if different prices used.

Identified wholesale clients: normal Pedidos associated with session.

Physical movements conceptually:
* DISPATCH
* RETURN
* LOSS
* ADJUSTMENT

No individual anon sale registration.

MP reconciled without inventing correspondence.

---

## PART 17: PROJECTS

Optional analytic dimension.

V1: name, description, status.

Optionally linked from expenses/purchases.

No budgets/tasks/Gantt in this system V1.

---

## PART 18: FISCAL

Separate layer.

Do NOT duplicate economic operations.

Supports:
* Fiscal documents
* Tax components
* IVA débito / IVA crédito
* Other taxes/retentions
* Fiscal obligations
* Installments/payment plans
* Payments

**Preserve historical tax rates used.**

Do NOT hardcode rules (they change).

System is MANAGERIAL; final legal reporting via fiscal tools/professional.

---

## PART 19: P&L / MANAGEMENT

**DERIVED, NOT EDITABLE.**

No manual results table.

Structure:

```
Ventas netas devengadas
- Costos directos
- Costos indirectos
= Resultado operativo

- Reinversión
= Resultado post-reinversión

- Retiros
= Disponible post-retiros

- Reservas internas
= Post-reservas

- Inversiones
= Resultado post-inversiones
```

Do NOT confuse financial movement with income/expense.

Transfers do NOT affect results.

Purchases assigned to cost: do NOT duplicate as expense when cost recognized.

Drill-down to source facts.

---

## PART 20: MANAGEMENT PERIODS

Entity: `management_periods`

States: OPEN, CLOSED

**Closure is INTEGRAL:** protects commercial, economic, financial, productive, cost, fiscal.

ADMIN can reopen (requires reason + audit).

**created_at NEVER determines period of fact.**

Fact's date determined by rules below.

### Period Determination Rules

| Fact Type | Effective Date Field | Period |
|-----------|----------------------|--------|
| Sale (Pedido) | delivered_at | Delivery month |
| Purchase/Expense | economic_date | Economic month |
| Fiscal document | document_date / fiscal_period | Tax period |
| Collection (cash/transfer) | effective_date | Receipt month |
| Cheque received | received_date | CC impact month |
| Cheque clearing | cleared_date | Bank impact month |
| Cheque rejection | rejection_date | Reversal month |
| Supplier payment | effective_date | Payment month |
| eCheq issued | issue_date | CC impact month |
| eCheq debited | debit_date | Bank impact month |
| Transfer | effective_date per posting | Impact month |
| MP external | occurred_at (MP's date) | Event month |
| Reconciliation timestamp | — | Does NOT change original fact's period |
| Production | production_date | Event month |
| Mortality | event_date | Event month |
| Classification | classification_date | Session month |
| Feed manufacturing | manufacturing_date | Event month |
| Feed count | count_date | Event month |
| Freight | economic_date | Event month |
| Fiscal obligation | fiscal_period | Tax period |
| Fiscal payment | effective_date | Payment month |

**Late data:**

If period OPEN: belongs to its real date.

If CLOSED: do NOT silently insert/modify in that period. **Reopen when correction needs that period.**

No artificial MP deadline.

---

## PART 21: AUDIT

Single architecture: `audit_events`

Conceptually:
* entity_type
* entity_id
* action
* before (JSONB)
* after (JSONB)
* reason
* performed_by
* performed_at

Do NOT create per-entity audit tables (may change via future ADR).

**Audit does NOT replace business ledgers/events.**

Real consequences live in their domains.

Audit serves: reconstruct who changed what, when, why.

---

## PART 22: MERCADO PAGO INTEGRATION

MP is external integration, NOT global financial ledger.

Pipeline:

```
immutable source (physical data)
  → normalized external movement
  → reconciliation (N:N, amount-assigned)
  → internal financial operation/postings
```

Preserve:
* Gross
* Fees
* Taxes/retentions
* Net
* Yields
* Transfers
* Metadata necessary

FASE 0 (current architecture) evaluated against this target.

Legacy MP can stay read-only/audit until retired.

Do NOT complete transitional architecture before defining target.

---

## PART 23: MIGRATION STRATEGY

Useful history: `2026-01-01 onward` when reliable.

Do NOT invent missing data.

Evidence hierarchy:
1. External trusted evidence
2. Verifiable physical count/balance
3. Balance validated by owner
4. Reliable legacy data
5. Reconstructed calculation
6. Unknown / no data

Do NOT enforce `NEW SUM = OLD SUM` if OLD is wrong.

For CC/accounts: use validated opening balances at cutover.

Preserve lineage:
* Source system
* Legacy ID
* Import batch

System prior to cutover stays read-only.

---

## PART 24: SNAPSHOTS & VERSIONS

Apply snapshots ONLY when future master change would alter historical meaning.

Mandatory examples:
* Actual price used on order_line
* Product name (when historical display matters)
* Tax rate applied
* Fiscal document data
* Immutable formula version

Do NOT default-snapshot all masters.

Definitive matrix created during Physical Database Design.

---

## PART 25: SOURCE OF TRUTH MATRIX

| Concept | Authoritative Source |
|---------|----------------------|
| Sale | Pedido (DELIVERED) |
| Sale line & price | order_lines |
| Client debt | client_ledger SUM |
| Collection | collection record |
| Financial account balance | SUM financial_postings |
| Transfer | financial_operation + 2+ postings |
| Cheque / eCheq | financial_instrument + events |
| Supplier debt | supplier_ledger SUM |
| Purchase / Expense | purchase (economic_date) |
| Production | daily_production |
| Population | initial_population + population_events SUM |
| Classification | classification + classification_lines |
| Formulation | immutable formula version |
| Feed manufacturing | manufacturing |
| Consumo interno alimento | inventory equation (stock_in + fabrication - sales ± adj - stock_final) |
| Consumo teórico | derived productivity calculation |
| Feria | sales_session + related facts |
| P&L | derived |
| Fiscal facts | fiscal components |
| MP original | immutable MP source record |
| Audit trail | audit_events |

---

## PART 26: EXPLICITLY REJECTED DESIGNS

### Table: Ventas (duplicate of Pedido)

**Status:** REJECTED  
**Why:** Duplicates Pedido (DELIVERED). Violates single source of truth. Increases data consistency risk.

### Editable Running Balances

**Status:** REJECTED (client_balance, supplier_balance, account_balance columns)  
**Why:** Violates immutability and calculated-not-stored principle. Risk of divergence from source.

### MORTALITY_CONFLICT Type

**Status:** REJECTED  
**Why:** Simplification valid: unique constraint + rectification sufficient. Conflict tracking unnecessary complexity.

### conflict_flag / conflicting_event_id (mortality)

**Status:** REJECTED  
**Why:** Duplicate of MORTALITY_CONFLICT. Not needed for V1.

### classification_inputs Table

**Status:** REJECTED  
**Why:** Invents fictitious traceability (eggs mixed before classification; origin unknown). Violates "no invented precision."

### daily_production.classification_session_id

**Status:** REJECTED  
**Why:** Implies traceability from production to classification. Not operationally accurate. Removed during Round 3.

### daily_feed_consumption (as real consumption by flock)

**Status:** REJECTED (as source)  
**Why:** Santo Tomás does NOT track actual daily consumption by flock. Model distinguishes: consumo_económico (stock equation) vs. consumo_teórico (control metric). Do NOT create fictitious per-lote real consumption.

### pedido_audit_events Table

**Status:** REJECTED  
**Why:** Covered by transversal audit_events. Unnecessary per-entity audit table.

### Hard-Delete of Committed Facts

**Status:** REJECTED  
**Why:** Violates audit and history integrity. Use reversals/compensating entries instead.

### Silent Modification of Closed Periods

**Status:** REJECTED  
**Why:** Violates period integrity. Reopening required explicitly.

### Debit/Credit (Full Double-Entry Accounting)

**Status:** REJECTED (not required V1)  
**Why:** Signed amounts sufficient for cash/financial accounting. Can add formal D/C later if needed. No requirement V1.

### Per-Entity Audit Tables

**Status:** REJECTED (except via future ADR)  
**Why:** Transversal audit_events sufficient. Keep single audit architecture.

### Individual Anonymous Retail Sale Records (Feria)

**Status:** REJECTED  
**Why:** Santo Tomás does NOT operationally register each anon sale. Aggregated Pedido with itemization sufficient.

### MP ledger_entry as Global Ledger

**Status:** REJECTED  
**Why:** MP is external source. Reconciliation bridges to internal financial operations. Do NOT assume ledger_entry auto-feeds general ledger.

---

## PART 27: OPEN IMPLEMENTATION QUESTIONS

These questions belong to Physical Database Design, NOT architectural decisions.

* UUID vs. BIGINT per entity?
* Enum vs. lookup table strategy?
* Exact FK delete behavior (CASCADE, SET NULL, RESTRICT)?
* Index strategy per query patterns?
* Exact snapshot columns per entity?
* RPC function signatures?
* RLS policy implementation strategy?
* Atomic operation/transaction boundary RPC signatures?
* Soft-delete vs. hard-delete per entity type?
* Timezone handling (stored as timestamp with tz, or UTC + local conversion)?

Do NOT reopen architectural decisions here.

---

## PART 28: NEXT PHASE

**ARCHITECTURE STATUS: FROZEN**

**REAL ARCHITECTURAL BLOCKERS: NONE**

**No additional owner decisions required.**

**NEXT PHASE: PHYSICAL DATABASE DESIGN**

Activities:
1. Define table schema (columns, types, constraints)
2. Define PKs, FKs, UNIQUEs, CHECKs
3. Define index strategy
4. Define RLS policies
5. Define atomic operation boundaries (RPC/transaction)
6. Resolve open implementation questions
7. Freeze Physical Database Design

---

**NO MIGRATIONS OR APPLICATION IMPLEMENTATION SHOULD BEGIN UNTIL PHYSICAL DATABASE DESIGN HAS BEEN REVIEWED AND FROZEN.**

