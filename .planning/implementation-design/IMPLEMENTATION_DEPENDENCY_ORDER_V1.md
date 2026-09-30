# IMPLEMENTATION DEPENDENCY ORDER V1

**STATUS:** **FROZEN** — Fase 9 (Implementation Design) closed 2026-09-24. Technical sequencing for the Physical Schema Implementation phase.  
**AMENDMENTS:** ADR-001 (`.planning/adr/ADR-001_ISSUED_INSTRUMENT_CANCELLATION.md`, ACCEPTED 2026-09-25) — issued-instrument cancellation: RPC 42 `cancel_supplier_instrument`, `financial_instrument.cancelled_date`, `chk_instrument_cancelled_coherent`. Amended passages are marked **[ADR-001]**. Nothing else changed.  
**AMENDMENTS:** ADR-007 (`.planning/adr/ADR-007_FLOCK_LIFECYCLE.md`, ACCEPTED 2026-09-29) — V1 flock lifecycle: RPC 44 `register_flock`, RPC 45 `close_flock` (ADMIN, SECURITY DEFINER; the SECURITY DEFINER set 60 → 62) and invariant 29 (no dated flock activity after `flocks.exit_date`, enforced in RPCs 18–22, 29 and 45). No schema change. Amended sections are marked **[ADR-007]**.  
Changes from here require an explicit ADR, as with the target architecture.  
**DATE:** 2026-09-24  
**AUTHORITY:** TARGET_ARCHITECTURE_V2_FROZEN.md (frozen)  
**SOURCES:** `POSTGRES_SCHEMA_SPEC_V1.md` (54 tables) · `RPC_CONTRACTS_V1.md` (45 RPCs — RPC 42 by ADR-001, RPC 43 by ADR-004, RPCs 44 / 45 by ADR-007) · `RLS_IMPLEMENTATION_SPEC_V1.md` · `DATABASE_INVARIANTS_V1.md` (29 invariants — invariant 29 by ADR-007)

**THIS IS NOT A MIGRATION.** It specifies the ORDER in which objects must be created so that every
dependency resolves. No data moves. No timeline, no effort estimate.

---

## TWO CIRCULAR FK DEPENDENCIES — READ BEFORE ORDERING

The frozen model contains two legitimate mutual references. Neither table can carry its FK at
`CREATE TABLE` time, so in both cases the FK is added afterwards with `ALTER TABLE`.

**Cycle 1 — pedidos ↔ sales_session**
- `pedidos.sales_session_id → sales_session(id)` (an order belongs to a feria session)
- `sales_session.aggregated_pedido_id → pedidos(id)` (a session names its aggregated retail order)

**Cycle 2 — flocks ↔ purchases**
- `flocks.purchase_id → purchases(id)` (the pullet purchase that originated the flock)
- `purchases.flock_id → flocks(id)` (a purchase optionally attributed to a flock)

Both columns are nullable on both sides, so the deferred FK creates no insertion problem: the first
row is written with `NULL` and the link is set afterwards by the owning RPC.

Resolution: create all four tables without the cyclic columns' FK constraints, then add the four
constraints in step 3.6.

---

## PHASE 0 — EXTENSIONS

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

Required by `excl_pedido_lineas_single_current_version` (step 3.1b), which needs the GiST `<>` search
strategy for `uuid` and `int4`. Must exist before that constraint is added.

---

## PHASE 1 — ENUM TYPES

All 28 enum types from `POSTGRES_SCHEMA_SPEC_V1.md` must exist before any table.

```
rol_type, order_estado, product_type, price_list_type, account_type,
financial_operation_type, financial_instrument_type, instrument_direction, instrument_estado,
client_ledger_movement_type, supplier_ledger_movement_type, payment_method, purchase_nature,
population_event_type, flock_estado,
feed_category, unit_type, feed_movement_type,
session_estado, session_movement_type, session_cash_event_type,
fiscal_document_type, fiscal_direction, tax_kind, fiscal_obligation_status,
management_period_status, project_status, mp_processing_status
```

**Dependency:** every table depends on this phase.

---

## PHASE 2 — TABLES

### 2.1 Identity and period control (no outbound FKs except within this group)

1. `perfiles`
2. `management_period`
3. `audit_events` → perfiles

### 2.2 Independent masters

4. `sheds`
5. `clients`
6. `products`
7. `suppliers`
8. `financial_account`
9. `expense_category`
10. `classification_grade`
11. `projects`
12. `feed_type`
13. `genetics_consumption_curve`

### 2.3 Masters with FKs to 2.2

14. `price_history` → products, perfiles
15. `feed_ingredient` → suppliers, perfiles
16. `feed_formula_version` → feed_type, perfiles
17. `feed_formula_line` → feed_formula_version, feed_ingredient

### 2.4 Fiscal layer (referenced by purchases and freight)

18. `fiscal_document` → suppliers, clients, perfiles
19. `fiscal_document_component` → fiscal_document
20. `fiscal_obligation` → perfiles
21. `fiscal_obligation_installment` → fiscal_obligation

### 2.5 Feria session shell — **`aggregated_pedido_id` created WITHOUT its FK** (cycle 1)

22. `sales_session` → perfiles  
    column `aggregated_pedido_id UUID` present, FK deferred to 3.6

### 2.6 Commercial — **`sales_session_id` created WITHOUT its FK** (cycle 1)

23. `pedidos` → clients, perfiles  
    column `sales_session_id UUID` present, FK deferred to 3.6
24. `pedido_lineas` → pedidos, products, perfiles

### 2.7 Purchases — **`flock_id` created WITHOUT its FK** (cycle 2)

25. `purchases` → suppliers, expense_category, projects, fiscal_document, perfiles  
    column `flock_id UUID` present, FK deferred to 3.6
26. `purchase_line` → purchases, products, feed_ingredient
27. `purchase_attachment` → purchases, perfiles

### 2.8 Production — **`purchase_id` created WITHOUT its FK** (cycle 2)

28. `flocks` → sheds, suppliers, perfiles  
    column `purchase_id UUID` present, FK deferred to 3.6
29. `operator_assignments` → perfiles, flocks
30. `population_events` → flocks, perfiles (self-FK `superseded_by`)
31. `daily_production` → flocks, perfiles (self-FK `superseded_by`)
32. `flock_weighing` → flocks, perfiles
33. `temperature_record` → sheds, perfiles

### 2.9 Freight

34. `freight` → suppliers, fiscal_document, expense_category, perfiles
35. `freight_allocation` → freight, purchases, perfiles

### 2.10 Ledgers and treasury

36. `client_ledger` → clients, perfiles (self-FK `reversal_of_id`)
37. `supplier_ledger` → suppliers, perfiles (self-FK `reversal_of_id`)
38. `financial_operation` → perfiles
39. `financial_posting` → financial_operation, financial_account, perfiles
40. `collections` → clients, financial_account, sales_session, perfiles
41. `financial_instrument` → clients, suppliers, financial_account, collections, perfiles
42. `financial_instrument_event` → financial_instrument, financial_operation, perfiles

### 2.11 Classification

43. `classification` → perfiles
44. `classification_line` → classification, classification_grade

### 2.12 Feed operations

45. `feed_manufacturing` → feed_formula_version, perfiles
46. `feed_movement` → feed_type, pedidos, perfiles
47. `feed_inventory_count` → feed_type, perfiles
48. `flock_feed_assignment` → flocks, feed_type, perfiles

### 2.13 Feria operations

49. `sales_session_movement` → sales_session, products, perfiles
50. `sales_session_cash_event` → sales_session, financial_account, expense_category, financial_operation, perfiles

### 2.14 Fiscal payments

51. `fiscal_payment` → fiscal_obligation, fiscal_obligation_installment, financial_account, financial_operation, perfiles

### 2.15 Mercado Pago

52. `mp_source_record` (no outbound FK)
53. `mp_financial_movement` → mp_source_record
54. `mp_reconciliation` → mp_financial_movement, financial_operation, perfiles

**Total: 54 tables.** Every FK target appears earlier in this list, except the four cyclic columns
handled in 3.6.

---

## PHASE 3 — CONSTRAINTS, INDEXES, TRIGGERS

### 3.1 Partial UNIQUE indexes (uniqueness that a constraint cannot express)

```sql
CREATE UNIQUE INDEX idx_flocks_shed_active
  ON flocks(shed_id) WHERE estado = 'ACTIVE';

CREATE UNIQUE INDEX idx_population_events_mortality_current
  ON population_events(flock_id, event_date)
  WHERE event_type = 'MORTALITY' AND is_current = true;

CREATE UNIQUE INDEX idx_daily_production_current
  ON daily_production(flock_id, production_date) WHERE is_current = true;

CREATE UNIQUE INDEX idx_purchases_supplier_invoice
  ON purchases(supplier_id, supplier_invoice_number)
  WHERE supplier_invoice_number IS NOT NULL AND is_current = true;

CREATE UNIQUE INDEX idx_price_history_current
  ON price_history(producto_id, price_list_type) WHERE effective_to IS NULL;

CREATE UNIQUE INDEX idx_flock_feed_current
  ON flock_feed_assignment(flock_id) WHERE effective_to IS NULL;

CREATE UNIQUE INDEX idx_fiscal_document_supplier_number
  ON fiscal_document(supplier_id, external_number)
  WHERE supplier_id IS NOT NULL AND external_number IS NOT NULL;

CREATE UNIQUE INDEX idx_instrument_event_unique
  ON financial_instrument_event(financial_instrument_id, event_type);
```

**Not in this group:** `idx_pedido_lineas_current` is a **non-unique** partial index and belongs to
section 3.4. An order legitimately has several current lines, so making it UNIQUE would restrict
every order to a single line. It guarantees nothing; the guarantee for that table is 3.1b below.

**PostgreSQL note:** `ALTER TABLE … ADD CONSTRAINT UNIQUE (…) WHERE …` does not exist. Partial
uniqueness is always an index.

### 3.1b Exclusion constraint — one current line version per order

```sql
-- requires Phase 0 (btree_gist)
ALTER TABLE pedido_lineas
  ADD CONSTRAINT excl_pedido_lineas_single_current_version
  EXCLUDE USING gist (pedido_id WITH =, version_seq WITH <>)
  WHERE (is_current);
```

Rejects two current rows of one order that carry different `version_seq`, while allowing any number
of current rows sharing one `version_seq`. No unique index can express this: keyed on `(pedido_id)` it
would cap an order at one line, keyed on `(pedido_id, version_seq)` it would cap a version at one
line.

Being `IMMEDIATE`, it also enforces the mutation order inside `rectify_delivered_order` (RPC 2):
the old version must be retired *before* the new one is inserted. See invariant 16.

### 3.2 Full UNIQUE constraints

Declared inline in `CREATE TABLE` (see schema spec): `perfiles.email`, `management_period.periodo_fecha`,
`clients.nombre`, `products.nombre`, `suppliers.nombre`, `financial_account.nombre`,
`expense_category.nombre`, `classification_grade.nombre`, `projects.nombre`, `feed_type.nombre`,
`feed_ingredient.nombre`, `pedidos.numero_pedido`, `collections.receipt_id`,
`financial_operation.external_ref`, `financial_instrument.receipt_id`,
`financial_instrument.external_ref`, `purchases.idempotency_key`, `freight.idempotency_key`,
`feed_manufacturing.idempotency_key`, `classification.idempotency_key`,
`sales_session.idempotency_key`, `fiscal_payment.idempotency_key`,
`mp_source_record(source_type, external_id)`, and the composite keys on
`operator_assignments`, `feed_formula_version`, `feed_formula_line`, `flock_weighing`,
`temperature_record`, `classification_line`, `feed_inventory_count`, `freight_allocation`,
`purchase_attachment`, `fiscal_obligation`, `fiscal_obligation_installment`,
`mp_financial_movement`, `mp_reconciliation`, `genetics_consumption_curve`.

### 3.3 CHECK constraints

Declared inline in `CREATE TABLE`. The ones that carry business meaning:

```
financial_posting.signed_amount <> 0
client_ledger.signed_amount  <> 0
supplier_ledger.signed_amount <> 0
management_period.periodo_fecha = date_trunc('month', periodo_fecha)::DATE
fiscal_document.fiscal_period  = date_trunc('month', fiscal_period)::DATE
fiscal_obligation.fiscal_period = date_trunc('month', fiscal_period)::DATE
collections.payment_method <> 'CHEQUE'            -- single ownership of cheque reception
collections.financial_account_id IS NOT NULL
pedidos: delivered/cancelled coherence
financial_instrument: received/issued provenance + estado↔direction coherence + CANCELLED⇔cancelled_date coherence **[ADR-001]**
sales_session_cash_event: EXPENSE requires expense_category_id
```

### 3.4 Performance indexes

```sql
CREATE INDEX idx_audit_events_entity          ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_events_actor           ON audit_events(performed_by, performed_at);
CREATE INDEX idx_operator_assignments_operator ON operator_assignments(operator_id) WHERE activo = true;
CREATE INDEX idx_pedidos_cliente              ON pedidos(cliente_id);
CREATE INDEX idx_pedidos_delivered_date       ON pedidos(delivered_date) WHERE estado = 'DELIVERED';
CREATE INDEX idx_pedidos_session              ON pedidos(sales_session_id) WHERE sales_session_id IS NOT NULL;
CREATE INDEX idx_pedido_lineas_current        ON pedido_lineas(pedido_id) WHERE is_current = true;
CREATE INDEX idx_pedido_lineas_version        ON pedido_lineas(pedido_id, version_seq);
CREATE INDEX idx_client_ledger_cliente_date   ON client_ledger(cliente_id, effective_date);
CREATE INDEX idx_client_ledger_source         ON client_ledger(source_entity_type, source_entity_id);
CREATE INDEX idx_collections_cliente_date     ON collections(cliente_id, effective_date);
CREATE INDEX idx_financial_operation_date     ON financial_operation(effective_date);
CREATE INDEX idx_financial_posting_account_date ON financial_posting(financial_account_id, effective_date);
CREATE INDEX idx_financial_posting_operation  ON financial_posting(financial_operation_id);
CREATE INDEX idx_instrument_estado            ON financial_instrument(direction, estado);
CREATE INDEX idx_instrument_cliente           ON financial_instrument(cliente_id)  WHERE cliente_id IS NOT NULL;
CREATE INDEX idx_instrument_supplier          ON financial_instrument(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_instrument_maturity          ON financial_instrument(maturity_date);
CREATE INDEX idx_instrument_event_date        ON financial_instrument_event(event_date);
CREATE INDEX idx_supplier_ledger_supplier_date ON supplier_ledger(supplier_id, effective_date);
CREATE INDEX idx_purchases_economic_date      ON purchases(economic_date) WHERE is_current = true;
CREATE INDEX idx_purchases_supplier           ON purchases(supplier_id);
CREATE INDEX idx_purchases_project            ON purchases(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_purchase_line_purchase       ON purchase_line(purchase_id);
CREATE INDEX idx_purchase_attachment_purchase ON purchase_attachment(purchase_id);
CREATE INDEX idx_freight_economic_date        ON freight(economic_date) WHERE is_current = true;
CREATE INDEX idx_freight_allocation_purchase  ON freight_allocation(purchase_id);
CREATE INDEX idx_population_events_flock_date ON population_events(flock_id, event_date);
CREATE INDEX idx_daily_production_flock_date  ON daily_production(flock_id, production_date);
CREATE INDEX idx_classification_date          ON classification(classification_date);
CREATE INDEX idx_feed_manufacturing_date      ON feed_manufacturing(manufacturing_date);
CREATE INDEX idx_feed_movement_type_date      ON feed_movement(feed_type_id, movement_date);
CREATE INDEX idx_sales_session_date           ON sales_session(session_date);
CREATE INDEX idx_session_movement_session     ON sales_session_movement(sales_session_id);
CREATE INDEX idx_session_cash_session         ON sales_session_cash_event(sales_session_id);
CREATE INDEX idx_fiscal_document_period       ON fiscal_document(fiscal_period);
CREATE INDEX idx_fiscal_component_document    ON fiscal_document_component(fiscal_document_id);
CREATE INDEX idx_fiscal_payment_obligation    ON fiscal_payment(fiscal_obligation_id);
CREATE INDEX idx_mp_source_status             ON mp_source_record(processing_status);
CREATE INDEX idx_mp_source_date               ON mp_source_record(occurred_date);
CREATE INDEX idx_mp_movement_date             ON mp_financial_movement(occurred_date);
```

`management_period` needs no extra index: `periodo_fecha` is UNIQUE, and that index already serves
the exact equality lookup `ASSERT_PERIOD_OPEN` performs.

### 3.5 Triggers

```sql
CREATE FUNCTION mp_source_raw_guard() …;      -- body in POSTGRES_SCHEMA_SPEC_V1.md
CREATE TRIGGER trg_mp_source_raw_guard
  BEFORE UPDATE ON mp_source_record
  FOR EACH ROW EXECUTE FUNCTION mp_source_raw_guard();
```

This trigger must exist **before** any MP ingestion runs (invariant 21).

### 3.6 Deferred cyclic FKs — must run after Phase 2 completes

```sql
-- cycle 1: pedidos ↔ sales_session
ALTER TABLE pedidos
  ADD CONSTRAINT fk_pedidos_sales_session
  FOREIGN KEY (sales_session_id) REFERENCES sales_session(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE sales_session
  ADD CONSTRAINT fk_sales_session_aggregated_pedido
  FOREIGN KEY (aggregated_pedido_id) REFERENCES pedidos(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- cycle 2: flocks ↔ purchases
ALTER TABLE flocks
  ADD CONSTRAINT fk_flocks_purchase
  FOREIGN KEY (purchase_id) REFERENCES purchases(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE purchases
  ADD CONSTRAINT fk_purchases_flock
  FOREIGN KEY (flock_id) REFERENCES flocks(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

---

## PHASE 4 — SECURITY

Order matters: privileges first, then RLS, then policies, then the safe view.

### 4.1 Helper function

```sql
CREATE FUNCTION current_app_role() …          -- SECURITY DEFINER, SET search_path = public
REVOKE ALL     ON FUNCTION current_app_role() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION current_app_role() TO authenticated;
```
Must exist before any policy, since every policy calls it.

### 4.2 Privilege perimeter

```sql
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
GRANT  SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
-- then the narrow re-grants listed in RLS_IMPLEMENTATION_SPEC_V1.md section 4
```

### 4.3 Enable RLS on all 54 tables

```sql
ALTER TABLE <each of the 54 tables> ENABLE ROW LEVEL SECURITY;
```

### 4.4 Attach policies

Per `RLS_IMPLEMENTATION_SPEC_V1.md` sections 5–9. Complete one table before moving to the next.

### 4.5 Safe view

```sql
CREATE VIEW feed_formula_line_safe WITH (security_invoker = false) AS …;
ALTER VIEW feed_formula_line_safe OWNER TO postgres;
REVOKE ALL   ON feed_formula_line_safe FROM PUBLIC;
GRANT SELECT ON feed_formula_line_safe TO authenticated;
```

---

## PHASE 5 — RPC FUNCTIONS

All 45 contracts from `RPC_CONTRACTS_V1.md` **[ADR-001]** **[ADR-004]** **[ADR-007]**. Each one:

- exact signature and parameter types from its contract;
- `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public`;
- `OWNER TO postgres` (required: application roles hold no write privilege on fact tables);
- `REVOKE ALL … FROM PUBLIC` then `GRANT EXECUTE … TO authenticated` (RPCs 40/41: `service_role`);
- derives the actor from `auth.uid()` and the role from `current_app_role()`; accepts no caller-supplied actor or role;
- calls `ASSERT_PERIOD_OPEN` when period-sensitive (41 of 45 **[ADR-001]** **[ADR-004]** **[ADR-007]**);
- locks with `SELECT … FOR UPDATE` where its contract says so;
- writes `audit_events`;
- contains no `COMMIT` — the RPC call is already one transaction;
- returns the exact type in its contract.

### 5.1 Creation order

RPCs have no inter-function dependency except one: `close_sales_session` (33) calls `deliver_order`
(1). Create in contract order 1 → 41, then 42 **[ADR-001]** (it needs only `financial_instrument`, `financial_instrument_event`, `supplier_ledger`, `audit_events` and the period guard, all earlier), which satisfies it.

| Group | RPCs |
|---|---|
| Commercial | 1 deliver_order · 2 rectify_delivered_order · 3 cancel_order |
| Collections | 4 register_collection |
| Received instruments | 5 receive_cheque · 6 deposit_cheque · 7 clear_cheque · 8 endorse_cheque · 9 reject_cheque |
| Issued instruments | 10 issue_supplier_instrument · 11 mark_supplier_instrument_debited · 12 reject_supplier_instrument · 42 cancel_supplier_instrument **[ADR-001]** |
| Purchases & suppliers | 13 register_purchase · 14 rectify_purchase · 15 pay_supplier |
| Freight | 16 register_freight · 17 assign_freight_to_purchase |
| Production | 18 register_daily_production · 19 rectify_daily_production · 20 register_mortality · 21 rectify_mortality · 22 register_count_adjustment · 23 register_flock_weighing · 24 register_temperature_record · 44 register_flock · 45 close_flock **[ADR-007]** |
| Classification | 25 register_classification |
| Feed | 26 register_feed_manufacturing · 27 register_feed_inventory_count · 28 register_feed_movement · 29 assign_flock_feed |
| Feria | 30 open_sales_session · 31 register_session_movement · 32 register_session_cash_event · 33 close_sales_session |
| Fiscal | 34 register_fiscal_document · 35 register_fiscal_obligation · 36 pay_fiscal_obligation |
| Periods | 37 close_management_period · 38 reopen_management_period |
| Treasury | 39 transfer_between_accounts |
| Mercado Pago | 40 mp_normalize_source · 41 mp_reconcile_movement |

**Total: 45.** **[ADR-001]** **[ADR-004]** **[ADR-007]** (RPC 43 `register_management_event` by ADR-004; RPCs 44 / 45 are created after 43; they need `sheds`, `flocks`, `suppliers`, `purchases`, `operator_assignments`, the production and feed-assignment tables, `audit_events` and the period guard, all earlier)

### 5.2 Seed data required before RPCs can run

- `management_period` rows for every month that will receive facts — `ASSERT_PERIOD_OPEN` raises
  `PERIOD_NOT_FOUND` when the row is missing.
- `expense_category` rows — `purchases.expense_category_id` is NOT NULL.
- `classification_grade` rows — XL, N1, N2, N3, Rotos, Sucios, Descarte.
- `financial_account` rows — Caja chica, Mercado Pago, BNA, Patagonia.
- a `clients` row named `CONSUMIDOR FINAL` — `close_sales_session` raises
  `CONSUMIDOR_FINAL_MISSING` without it.
- `perfiles` rows for every user, with the correct `rol_type` and `activo = true`.

---

## PHASE 6 — VERIFICATION

Run the mechanical checks already specified, rather than inventing new ones:

- `RLS_IMPLEMENTATION_SPEC_V1.md` section 11 — checks 1–8 (RLS enabled, no JWT authorization, no
  impossible SERVICE_ROLE test, no no-op deny policies, no write privileges on fact tables, pinned
  `search_path`, no PUBLIC execute, raw-guard trigger present) plus the behavioural tests for
  ADMIN / OPERATOR / SERVICE_ROLE.
- `DATABASE_INVARIANTS_V1.md` — the verification queries for invariants 1, 2, 3, 5/6/7, 8, 15, 16,
  18, 19, 20, 22, 23, 25, 26, 28.

Additional structural checks for this phase:

```sql
-- 54 tables exist (expect 54)
SELECT COUNT(*) FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- 45 RPCs exist (expect 45)   [ADR-001] [ADR-004] [ADR-007]
SELECT COUNT(*) FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace AND prosecdef = true
   AND proname NOT IN ('current_app_role','mp_source_raw_guard');

-- every FK target resolves (expect 0)
SELECT conrelid::regclass AS child, conname FROM pg_constraint
 WHERE contype = 'f' AND NOT convalidated;

-- the four deferred cyclic FKs exist (expect 4)
SELECT conname FROM pg_constraint
 WHERE conname IN ('fk_pedidos_sales_session','fk_sales_session_aggregated_pedido',
                   'fk_flocks_purchase','fk_purchases_flock');

-- GENERATED ALWAYS columns present (expect 2)
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema='public' AND is_generated = 'ALWAYS';

-- btree_gist installed and the exclusion constraint in place (expect 1 each)
SELECT extname FROM pg_extension WHERE extname = 'btree_gist';
SELECT conname FROM pg_constraint
 WHERE conname = 'excl_pedido_lineas_single_current_version' AND contype = 'x';
```

---

## DEPENDENCY GRAPH

```
ENUM TYPES (28)
  │
  ├─ Identity / periods / audit: perfiles → management_period, audit_events
  │
  ├─ Independent masters: sheds, clients, products, suppliers, financial_account,
  │    expense_category, classification_grade, projects, feed_type,
  │    genetics_consumption_curve
  │
  ├─ Dependent masters: price_history, feed_ingredient,
  │    feed_formula_version → feed_formula_line
  │
  ├─ Fiscal: fiscal_document → fiscal_document_component
  │          fiscal_obligation → fiscal_obligation_installment
  │
  ├─ Feria shell: sales_session            ⟵ cycle 1 column, FK deferred
  ├─ Commercial:  pedidos → pedido_lineas  ⟵ cycle 1 column, FK deferred
  ├─ Purchases:   purchases → purchase_line, purchase_attachment
  │                                         ⟵ cycle 2 column, FK deferred
  ├─ Production:  flocks → operator_assignments, population_events,
  │                        daily_production, flock_weighing
  │               sheds  → temperature_record
  │                                         ⟵ cycle 2 column, FK deferred
  ├─ Freight:     freight → freight_allocation
  │
  ├─ Ledgers/treasury: client_ledger, supplier_ledger,
  │    financial_operation → financial_posting,
  │    collections, financial_instrument → financial_instrument_event
  │
  ├─ Classification: classification → classification_line
  ├─ Feed ops: feed_manufacturing, feed_movement, feed_inventory_count,
  │            flock_feed_assignment
  ├─ Feria ops: sales_session_movement, sales_session_cash_event
  ├─ Fiscal payment: fiscal_payment
  └─ MP: mp_source_record → mp_financial_movement → mp_reconciliation
  │
  ├─ CONSTRAINTS & INDEXES (partial unique, full unique, CHECK, performance)
  ├─ TRIGGER trg_mp_source_raw_guard
  ├─ DEFERRED CYCLIC FKs (4)
  │
  ├─ SECURITY: current_app_role() → privileges → ENABLE RLS → policies → safe view
  │
  └─ RPCs (45, contract order 1→41 then 42 [ADR-001], 43 [ADR-004], then 44 / 45 [ADR-007]; 33 depends on 1)
```

---

## COMPLETION CRITERIA

- [ ] Phase 0: `btree_gist` extension installed.
- [ ] Phase 1: 28 enum types created.
- [ ] Phase 2: 54 tables created, four cyclic FK columns present without constraints.
- [ ] Phase 3: partial unique indexes, the `pedido_lineas` exclusion constraint, full unique
      constraints, CHECK constraints, performance indexes, MP raw-guard trigger, and the four
      deferred cyclic FKs — all created without error.
- [ ] Phase 4: `current_app_role()` created and hardened; write privileges revoked from `anon` and
      `authenticated` with only the documented re-grants; RLS enabled on all 54 tables; policies
      attached per the RLS spec; `feed_formula_line_safe` created, owned by `postgres`, granted.
- [ ] Phase 5: 45 RPCs created **[ADR-001]** **[ADR-004]** **[ADR-007]**, each `SECURITY DEFINER` with pinned `search_path`, owned by
      `postgres`, PUBLIC execute revoked; seed data loaded.
- [ ] Phase 6: RLS checks 1–8 return their expected results; invariant queries return 0 rows;
      structural counts return 54 tables and 45 RPCs **[ADR-001]** **[ADR-004]** **[ADR-007]**; behavioural tests pass for ADMIN, OPERATOR and
      SERVICE_ROLE.

---

## SCOPE BOUNDARY

This document orders **schema construction only**.

Data migration, opening balances, legacy lineage and cutover are separate later phases and are
deliberately absent here. The system prior to cutover stays read-only (frozen Part 23).

---

**STATUS: FROZEN — SEQUENCING DEFINED, 28 ENUMS, 54 TABLES, 4 DEFERRED CYCLIC FKs, 45 RPCs** (RPC 42 by ADR-001; RPC 43 by ADR-004; RPCs 44 / 45 by ADR-007)
