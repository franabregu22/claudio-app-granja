# PHASE 25 — DASHBOARD / REPORTS: PRE-CONSTRUCTION REPORTING CONTRACT REVIEW

**STATUS:** COMPLETE on mechanical evidence (§16). §1–§15 are the pre-construction review, kept as written. The owner answered OD-1 to OD-3 in **ADR-005**, and the reporting layer was then built as migration 0046. MASTER_ROADMAP.md keeps Phase 25 **CURRENT** until external review.

**Authorities read:**
- Roadmap and project rules: CLAUDE.md, MASTER_ROADMAP.md.
- Architecture: TARGET_ARCHITECTURE_V2_FROZEN.md.
- Implementation specs: POSTGRES_SCHEMA_SPEC_V1, RLS_IMPLEMENTATION_SPEC_V1, DATABASE_INVARIANTS_V1, RPC_CONTRACTS_V1.
- ADRs: ADR-001, ADR-002, ADR-003 and ADR-004.
- Phase docs: PHASE_18 to PHASE_21, PHASE_23 and PHASE_24.
- Migrations 0001–0045, with every policy, grant and view.
- For the frontend facts only: the repository's `src/` and `package.json`.

---

## 1. Exit criterion

> Reporting reads derived values only, respects RLS, and exposes no cost data to OPERATOR.

## 2. Existing views (complete inventory)

| View | Migration | Mode | Grants | Role behaviour | Status |
|---|---|---|---|---|---|
| `feed_formula_line_safe` | 0031 | `security_invoker = false`, owner `postgres` (FROZEN RLS spec, cost layer 2) | authenticated only | Formula composition without `unit_cost_snapshot`, for both roles | Reused unchanged. It is the only frozen definer-style view, and its safety rests on the cost-free projection. |
| `pnl_line_item` | 0045 | `security_invoker = true` + ADMIN predicate | authenticated only | ADMIN: every contribution. OPERATOR: 0 rows. | Reused unchanged |
| `pnl_summary` | 0045 | `security_invoker = true` + ADMIN predicate | authenticated only | ADMIN: subtotals per period. OPERATOR: 0 rows. | Reused unchanged |

There are no materialized views, no reporting functions and no stored balance, total or variance columns. These absences are already tested by the foundations, feria and pnl suites.

## 3. Principle applied

Phase 25 adds **projections only**. Every amount in this document is one of the following:
- a frozen derivation, such as a balance = `SUM(signed_amount)` (Invariants 5, 6 and 7);
- a derivation already ratified by the owner: consumption (Phase 20 §14–15), Feria expectation (Phase 21 K2), MP `remaining_unassigned` (ADR-003 D4), P&L (ADR-004);
- a plain sum or count of authoritative rows.

The one metric whose formula is not frozen is laying rate (§14 OD-1). It is not built until the owner decides.

---

## 4. Metric inventory

Legend for the columns:
- **Role:** A = ADMIN, O = OPERATOR.
- **Cost:** whether the metric is cost-sensitive.
- **Existing:** whether a view already exposes it.
- **New view?:** whether a new view is needed.

### 4.1 Financial / commercial (all ADMIN only; RLS gives OPERATOR no policy on any source)

| Metric | Source | Derivation | Date basis | Dimensions | Cost | Existing | New view? | Drill-down |
|---|---|---|---|---|---|---|---|---|
| Sales accrued by month | `pedidos` DELIVERED + current `pedido_lineas` | Σ subtotal | `delivered_date` | month | yes (price) | `pnl_summary.ventas_netas_devengadas` | no | `pnl_line_item` → Pedido |
| Sales by client | same | Σ subtotal per `cliente_id` | `delivered_date` | client, month | yes | `pnl_line_item` is one row per Pedido (description = client name, but there is no `cliente_id` column) | covered by `report_sales_line` | Pedido |
| Sales by product | same, at line level | Σ subtotal and Σ quantity per `producto_id` | `delivered_date` | product, client, month, Feria vs identified | yes | **no:** `pnl_line_item` has no product dimension | **yes, `report_sales_line`** | Pedido → line |
| Client balance / receivables | `client_ledger` | `SUM(signed_amount)` (Inv. 5) | `effective_date` | client, month | yes | no | **yes, `report_balance_period`** | `client_ledger` → source |
| Supplier balance | `supplier_ledger` | `SUM(signed_amount)` (Inv. 7) | `effective_date` | supplier, month | yes | no | same view | `supplier_ledger` → source |
| Financial account balance | `financial_posting` | `SUM(signed_amount)` (Inv. 6) | `effective_date` | account, month | yes | no | same view | `financial_posting` → `financial_operation` |
| Collections | `collections` | row list | `effective_date` | client, account, month | yes | base table (ADMIN RLS) | no: list and filter the base table | collection → ledger / posting |
| Purchases by category / nature | current `purchases` | Σ contribution | `economic_date` | category, nature, project, cost class | yes | `pnl_line_item` (`source_entity_type = 'purchases'`, with `expense_category_id`, `nature`, `project_id`) | no | `purchases` |
| Freight (allocated / unallocated) | `freight`, `freight_allocation` | as in ADR-004 | `freight.economic_date` | category, nature | yes | `pnl_line_item` (`freight`, `freight_allocation`) | no | freight / allocation |
| P&L summary / drill-down | ADR-004 | — | `business_date` / `period` | bucket, period | yes | `pnl_summary`, `pnl_line_item` | **no, reused** | `source_entity_type` / `source_entity_id` |
| MP reconciliation status | `mp_source_record`, `mp_financial_movement`, `mp_reconciliation` | assigned = Σ `assigned_amount`; `remaining_unassigned = net_amount − assigned` (ADR-003 D4, derived, never stored) | `occurred_date` | kind, processing status, month | yes (fee / tax) | no | **yes, `report_mp_movement_status`** | movement → source → reconciliation → operation |

### 4.2 Production (FROZEN Parts 10–12; Phase 18)

| Metric | Role | Source | Derivation | Date basis | Cost | New view? | Drill-down |
|---|---|---|---|---|---|---|---|
| Eggs / production by date | A, O (assigned) | current `daily_production` | eggs_total, broken, dirty | `production_date` | no | in `report_flock_day` | `daily_production` |
| Production by flock / shed | A, O (assigned) | `daily_production.flock_id` → `flocks.shed_id` | per flock; shed via the flock | `production_date` | no | same | same |
| Laying rate | A, O (assigned) | production + population(D) | **not frozen → OD-1** | `production_date` | no | column pending OD-1 / OD-2 | same |
| Mortality | A, O (assigned) | current `population_events` MORTALITY | Σ \|delta\| | `event_date` | no | same | `population_events` |
| Broken / dirty | A, O | `daily_production` | counts, with ratios pending OD-1 | `production_date` | no | same | `daily_production` |
| Discarded | A, O (own) | `classification_line`, grade Descarte | Σ quantity | `classification_date` | no | in `report_classification_day` | classification |
| Current population | A, O (assigned) | `flocks.initial_population + Σ current population_events.delta` (FROZEN Part 11) | same-day rule (Phase 20 §15) | day D | no | same view, row D = today | events |
| Age | A, O | `flocks.birth_date` | `(D − birth_date)/7.0`, curve week = floor (Phase 20 §15) | day D | no | same | flock |
| Flock trends | A, O | the same daily rows | series over D | D | no | same | same |

Production is **per flock only**. It is not linked to classification (FROZEN Part 12 / 14).

### 4.3 Classification (FROZEN Part 14; Phase 19)

| Metric | Role | Source | Derivation | Date basis | New view? |
|---|---|---|---|---|---|
| Quantities by grade | A, O | `classification_line` | Σ quantity per grade | `classification_date` | **`report_classification_day`** |
| Sessions by date | A, O | `classification` | count | `classification_date` | same |
| Grade mix % | A, O | same | quantity / Σ quantity of the same date | `classification_date` | same |

There is no flock column and no link back to daily production.

**OPERATOR scope:** OPERATOR sees **only the sessions it created**. This is RLS 0028, `created_by = auth.uid()`, so OPERATOR totals are totals of its own sessions. The report states this; it never widens access.

### 4.4 Feed (FROZEN Part 15; Phase 20 §14–15)

| Metric | Role | Source | Derivation | Date basis | Cost | New view? |
|---|---|---|---|---|---|---|
| Manufacturing | A, O | `feed_manufacturing` | quantity per version / type | `manufacturing_date` | no (no cost column) | no: base table |
| Movements (sale / loss / adjustments) | **A only** | `feed_movement` (no OPERATOR policy) | quantities | `movement_date` | carries `pedido_id` (commercial) | no: base table |
| Inventory counts | A, O | `feed_inventory_count` | observation | `count_date` | no | no: base table |
| Formula composition | A, O | `feed_formula_line_safe` | kg per ingredient | version | **cost excluded** | no: reused |
| Internal consumption | **A only** | counts + manufacturing + movements | the Phase 20 §14 equation, per feed type, between consecutive counts (d0, d1] (count-day rule) | count interval | no | **`report_feed_consumption_interval`** |
| Theoretical consumption | A, O (assigned) | population(D) × curve(floor(age)) × assignment | Phase 20 §15 | day D | no | in `report_flock_day` |
| Real vs theoretical variance | **A only** | the two derivations above | internal(d0, d1] − Σ theoretical(D ∈ (d0, d1], same feed type) | count interval | no | in `report_feed_consumption_interval` |

Internal consumption is ADMIN only because its equation needs `feed_movement`, which OPERATOR cannot read. For OPERATOR, an invoker view would silently drop the movements and return a **wrong** number. The view therefore carries an ADMIN predicate, and OPERATOR gets 0 rows, not a partial figure.

It is reported **per count interval, never pro-rated into months**. Pro-rating would invent precision (FROZEN Part 1 §7).

### 4.5 Feria (FROZEN Part 16; Phase 21)

| Metric | Role | Source | Derivation | Date basis | Cost | New view? |
|---|---|---|---|---|---|---|
| Sessions | A (O: OPEN only) | `sales_session` | list | `session_date` | no | no: base table |
| Dispatched / returned / loss / adjustments | A (O: OPEN sessions, product id only) | `sales_session_movement` | Σ `cantidad` per type and product | **`sales_session.session_date`**: the movement has no business date, and `created_at` is never used | no | in `report_feria_session_cash`, ADMIN |
| Aggregate retail vs identified sales | A | `pedidos.sales_session_id` + `sales_session.aggregated_pedido_id` | from `report_sales_line` | `delivered_date` | yes | `report_sales_line` flags |
| Opening fund / expenses / withdrawals / transfers | A | `sales_session_cash_event` | Σ per type | `event_date` | yes | **`report_feria_session_cash`** |
| Reconciliation variance | A | same | expected = OPENING_FUND − EXPENSE − WITHDRAWAL − TRANSFER_OUT (Phase 21 K2, exactly); variance = each COUNT − expected | session | yes | same |

**OPERATOR:** Feria reporting is not part of the OPERATOR dashboard.
- OPERATOR already reads movements of OPEN sessions for capture, but `products` has no OPERATOR policy (RLS spec §6). A quantity report would show bare product ids.
- Showing product names would need a new policy, which is out of scope and not requested.

**Several COUNTs in one session:** each one is shown as its own observation with its own variance. None is picked, summed or averaged.

### 4.6 Mercado Pago (ADR-003)

`report_mp_movement_status` gives one row per movement with:
- `occurred_date`, `movement_kind`, gross / fee / tax / net;
- assigned = Σ `mp_reconciliation.assigned_amount`;
- `remaining_unassigned` = net − assigned;
- the source `processing_status`.

The RECONCILED equivalence stays owned by RPC 41; the view only displays it. ADMIN only.

### 4.7 P&L (ADR-004)

`pnl_summary` and `pnl_line_item` are consumed **as they are**. Phase 25 recomputes no bucket and no subtotal.

Sales by product (`report_sales_line`) uses the identical source predicate: DELIVERED, current lines, `delivered_date`. Its test asserts Σ = `pnl_summary.ventas_netas_devengadas` per period, which proves it is not a second formula. OPERATOR gets 0 rows (already tested, X2).

---

## 5. Cost-sensitive data inventory

| Data | Location | Classification | Enforcement today |
|---|---|---|---|
| purchase `amount_net` / `amount_total` | `purchases` | ADMIN ONLY | no OPERATOR policy |
| purchase line unit price | `purchase_line.precio_unitario` | ADMIN ONLY | no OPERATOR policy |
| freight amount / allocations | `freight`, `freight_allocation` | ADMIN ONLY | no OPERATOR policy |
| feed `unit_cost_snapshot` | `feed_formula_line` | ADMIN ONLY | no OPERATOR policy; OPERATOR reads `feed_formula_line_safe` (column absent) |
| feed batch cost | derived only (snapshot × kg) | ADMIN ONLY | no object computes it for OPERATOR |
| supplier balances | `supplier_ledger` | ADMIN ONLY | no OPERATOR policy |
| client balances, sales prices, sales | `client_ledger`, `pedido_lineas`, `price_history`, `pedidos` | ADMIN ONLY | no OPERATOR policy |
| treasury / account balances | `financial_posting`, `financial_operation`, `financial_account` | ADMIN ONLY | no OPERATOR policy |
| expense category and cost class | `expense_category.pnl_cost_class` | ADMIN ONLY | no OPERATOR policy |
| MP fee / tax / net amounts | `mp_*` | ADMIN ONLY | ADMIN / service policies only |
| Feria cash amounts | `sales_session_cash_event` | ADMIN ONLY | no OPERATOR policy |
| P&L | `pnl_*` views | ADMIN ONLY | ADMIN predicate |
| management results | `management_event` | ADMIN ONLY | ADMIN policy (0045) |
| fiscal | `fiscal_*` | ADMIN ONLY | no OPERATOR policy |

**Reconstruction check.** None of the tables OPERATOR can read has a monetary column. They are:
- `flocks`, `sheds`, `daily_production`, `population_events`;
- `classification`, `classification_line`, `classification_grade`;
- `feed_manufacturing`, `feed_inventory_count`, `flock_feed_assignment`, `feed_formula_version`, `feed_formula_line_safe`;
- `feed_type`, `feed_ingredient`, `genetics_consumption_curve`;
- `sales_session`, `sales_session_movement`;
- own `audit_events`, own `operator_assignments`, `management_period`.

So no combination of what OPERATOR can read yields a cost, a price, a margin or a result.

The only foreign keys that point at money objects are opaque ids, and their targets have no OPERATOR policy:
- `flocks.supplier_id` / `purchase_id`;
- `sales_session.aggregated_pedido_id`.

The proposed OPERATOR-visible views never project those ids. Test Y4 (§13) also scans the audit payloads OPERATOR can read for monetary keys.

## 6. Safe operational inventory (OPERATOR)

| Metric | Base tables OPERATOR reads (policy) | Complete for OPERATOR? |
|---|---|---|
| Daily production, broken, dirty per assigned flock | `daily_production` (assigned, 0025) | yes |
| Mortality, adjustments, population(D), current population | `population_events` (assigned, 0025) + `flocks` (assigned, 0007) | yes |
| Age | `flocks.birth_date` (assigned) | yes (NULL when `birth_date` is NULL, never invented) |
| Expected laying % / g per bird day (curve) | `genetics_consumption_curve` (all rows, 0007) | yes |
| Laying rate | inputs above | pending OD-1 / OD-2 |
| Theoretical consumption per assigned flock | + `flock_feed_assignment` (assigned, 0031) | yes |
| Classification by grade / sessions / mix | `classification`, `classification_line` (own, 0028) | yes, own sessions (stated) |
| Feed manufacturing, counts, composition | `feed_manufacturing`, `feed_inventory_count` (0031), `feed_formula_line_safe` | yes |
| Feria | — | excluded (§4.5) |

**Partial-master rule.** OPERATOR reads only **active** rows of `sheds`, `feed_type` and `classification_grade`. Views therefore LEFT JOIN those masters for labels, and aggregate by the fact's own id, so a deactivated master can never drop an OPERATOR fact row.

---

## 7. New views proposed (the minimum for V1)

Every view follows the same rules:
- `security_invoker = true`, owner `postgres`;
- `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`, then `GRANT SELECT TO authenticated`;
- no SECURITY DEFINER, no function, no table, no materialized view.

ADMIN-only views also carry `WHERE (SELECT current_app_role()) = 'ADMIN'`, the pattern of `pnl_line_item`.

### V1 `report_sales_line`
- **Purpose:** sales at line level.
- **Roles:** ADMIN.
- **Source:** `pedidos` DELIVERED + current `pedido_lineas` (+ `clients`, `products` labels).
- **Derived fields:** `period` = month of `delivered_date`; `is_feria_aggregate` = (`pedido.id = sales_session.aggregated_pedido_id`).
- **Dimensions:** client, product, month, `sales_session_id`.
- **Drill-down:** `pedido_id`, line id.
- **Cost-sensitive:** yes.
- **Why the existing source is insufficient:** `pnl_line_item` has no product dimension or `cliente_id`. Σ per period = `pnl_summary.ventas_netas_devengadas` (tested).

### V2 `report_balance_period`
- **Purpose:** balances of the three frozen ledgers.
- **Roles:** ADMIN.
- **Source:** `client_ledger`, `supplier_ledger`, `financial_posting` (UNION, with `ledger` = CLIENT / SUPPLIER / ACCOUNT).
- **Derived fields:** per entity and month: debits, credits, net, and `closing_balance` = running `SUM(signed_amount)` over months (window; Invariants 5–7).
- **Dimensions:** ledger, entity, month.
- **Drill-down:** the ledger or posting rows of that entity and month.
- **Cost-sensitive:** yes.
- **Why the existing source is insufficient:** no object derives balances today. PostgREST aggregates are disabled, and a balance needs the full history.

### V3 `report_mp_movement_status`
- **Purpose:** MP reconciliation state.
- **Roles:** ADMIN.
- **Source:** `mp_financial_movement` ⟕ Σ `mp_reconciliation`, joined to `mp_source_record`.
- **Derived fields:** assigned, `remaining_unassigned` (ADR-003 D4), `processing_status`.
- **Dimensions:** kind, status, month (`occurred_date`).
- **Drill-down:** movement → source → reconciliations → operation.
- **Cost-sensitive:** yes.
- **Why the existing source is insufficient:** `remaining_unassigned` is defined as derived and exists nowhere.

### V4 `report_feria_session_cash`
- **Purpose:** session cash and physical summary.
- **Roles:** ADMIN.
- **Source:** `sales_session`, `sales_session_cash_event`, `sales_session_movement`.
- **Derived fields:** Σ per cash type; expected (Phase 21 K2 formula); one row per COUNT with its variance; Σ quantities per movement type and product.
- **Dimensions:** session, date, location.
- **Drill-down:** the cash events and movements.
- **Cost-sensitive:** yes.
- **Why the existing source is insufficient:** the expectation and variance exist only as test queries (Phase 21 carry-forward).

### V5 `report_feed_consumption_interval`

> **Amendment [ADR-014]** (2026-10-01, migration 0065): manufactured kg counts only current `feed_manufacturing` versions (`is_current`), so a rectified manufacturing is never double-counted. Columns unchanged.
- **Purpose:** internal consumption, and its variance from theoretical consumption.
- **Roles:** ADMIN.
- **Source:** `feed_inventory_count` pairs, `feed_manufacturing` (via version → type), `feed_movement`, and V6 theoretical kg.
- **Derived fields:** per feed type and interval (d0, d1]: opening, manufactured, sold, lost, adj±, closing, internal consumption (Phase 20 §14); theoretical Σ; variance.
- **Dimensions:** feed type, interval.
- **Drill-down:** the counts, manufacturing and movements in the interval.
- **Cost-sensitive:** no, but it needs ADMIN-only `feed_movement` (§4.4).
- **Why the existing source is insufficient:** Phase 20 deferred this view to reporting.

### V6 `report_flock_day`
- **Purpose:** the per-flock daily productive series.
- **Roles:** ADMIN, OPERATOR (assigned flocks, through base RLS).
- **Source:** `flocks`, current `population_events`, current `daily_production`, `genetics_consumption_curve`, `flock_feed_assignment`.
- **Derived fields:**
  - one row per flock and calendar day, from `entry_date` to `coalesce(exit_date, CURRENT_DATE)`;
  - population(D) (same-day rule); mortality(D); count adjustment(D);
  - eggs_total / broken / dirty. These are **NULL, not 0, on days with no production row**: a calculated day, not a fabricated fact;
  - age exact and curve week; expected laying % and g per bird day;
  - assigned `feed_type_id`; theoretical kg;
  - `laying_pct` pending OD-1 / OD-2.
- **Dimensions:** flock, shed, date.
- **Drill-down:** `daily_production.id`, `population_events` of D.
- **Cost-sensitive:** no.
- **Why the existing source is insufficient:** population(D), age and theoretical consumption exist only as test queries (Phase 20 carry-forward).

### V7 `report_classification_day`
- **Purpose:** grade quantities and mix.
- **Roles:** ADMIN, OPERATOR (own sessions, through RLS).
- **Source:** `classification`, `classification_line`, LEFT JOIN `classification_grade`.
- **Derived fields:** per date and grade: session count, quantity, share of the date total.
- **Dimensions:** date, grade.
- **Drill-down:** the `classification.id` values of that date.
- **Cost-sensitive:** no.
- **Why the existing source is insufficient:** the mix % and daily aggregation need grouping, which PostgREST cannot express.

### Objects NOT created
- A dashboard KPI view or table (§9).
- Views for collections, purchases, freight, feed manufacturing, counts or sessions. Their base tables or `pnl_line_item` already serve them, and a view would only rename columns.
- A second P&L.
- A current-balance view separate from V2 (the latest `closing_balance` is the current balance).
- An OPERATOR Feria view.

---

## 8. RLS design

- **Invoker everywhere:** each caller's own base-table RLS applies inside each view, so a join cannot widen access. Aggregates run only over rows the caller can see.
- **ADMIN-only views** (V1–V5) add an explicit ADMIN predicate. OPERATOR gets **0 rows**, never a partial figure. This matters most for V5, where partial visibility would give a wrong number.
- **Shared views** (V6, V7) carry no role predicate. RLS scopes them to assigned flocks or own sessions, so OPERATOR farm-wide aggregates are impossible by construction.
- **anon:** no grant on any view, so access is denied at the privilege level.
- **service_role:** no grant. No reporting consumer runs as service_role.
- **SECURITY DEFINER inventory** stays at 41, unchanged. There is no reporting function.
- `feed_formula_line_safe` stays the only non-invoker view, as frozen.

## 9. Dashboard vs reports

**DASHBOARD** (small sets of KPIs for the current period, read from the views above; no dashboard object is stored):

- **ADMIN:**
  - month sales (V1);
  - month result (`pnl_summary`);
  - account balances (V2, ACCOUNT);
  - receivables total and supplier payables (V2);
  - MP items with `remaining_unassigned` ≠ 0 (V3);
  - month eggs and mortality (V6);
  - latest feed variance (V5).
- **OPERATOR:**
  - today / last 7 days per assigned flock: eggs, broken, dirty, mortality, population, age, expected laying (V6), with laying % pending OD-1 / OD-2;
  - today's classification by grade, own sessions (V7).

**REPORTS** (filterable, drillable):

| Report | Roles | Source |
|---|---|---|
| Sales | ADMIN | V1 |
| Balances and ledgers | ADMIN | V2 → ledgers |
| Collections | ADMIN | base table |
| Purchases / freight | ADMIN | `pnl_line_item` |
| P&L | ADMIN | `pnl_summary` → `pnl_line_item` |
| MP | ADMIN | V3 |
| Feria | ADMIN | V4 |
| Feed consumption | ADMIN | V5 |
| Production series | ADMIN, OPERATOR | V6 |
| Classification | ADMIN, OPERATOR | V7 |
| Feed manufacturing / counts / composition | ADMIN, OPERATOR | base tables + safe view |

## 10. Period design

Each fact is reported by its own business date, never by `created_at`:

| Fact | Business date |
|---|---|
| Sale | `delivered_date` |
| Purchase, freight | `economic_date` |
| Ledgers, postings, collections | `effective_date` |
| Production | `production_date` |
| Population event | `event_date` |
| Classification | `classification_date` |
| Feed | `manufacturing_date` / `movement_date` / `count_date`; internal consumption uses the count interval |
| Feria cash | `event_date` |
| Feria movement | parent `session_date` |
| MP | `occurred_date` |
| P&L | `business_date` / `period` |

`period` is always `date_trunc('month', business_date)::DATE`, the same expression `pnl_line_item` uses.

## 11. Empty-period design

- The views emit rows **only for facts that exist**, as `pnl_summary` already does. No zero facts are fabricated.
- Explicit zero months are **filled by the consumer**, by left-joining `management_period.periodo_fecha`. That table is the authoritative month calendar: 2026 is seeded, and ADMIN and OPERATOR can both read it.
- V2 balances carry forward the last `closing_balance` into empty months. That is a presentation rule, not a stored value.
- The one per-day series (V6) is a calendar series of **calculated** days, with production NULL on days without a production fact.

## 12. Drill-down and performance

**Drill-down.** Every aggregate row carries the keys of its source rows, as listed per view in §7:
- sales → Pedido → line;
- P&L → `pnl_line_item` → source;
- balance → ledger / posting;
- production → `daily_production` / `population_events`;
- classification → session → line;
- feed interval → counts / manufacturing / movements;
- MP → movement → source → reconciliation → operation;
- Feria → cash events / movements.

No relation is invented: there is none between classification and a flock or production, and internal consumption has no flock.

**Indexes.** Existing indexes cover every report's filters and joins:
- `pedidos(delivered_date)`, `pedido_lineas(pedido_id) current`;
- ledgers `(entity, effective_date)`, `financial_posting(account, effective_date)`;
- `daily_production(flock_id, production_date)`, `population_events(flock_id, event_date)`;
- `classification(classification_date)` + unique `(classification_id, grade)`;
- `feed_movement(feed_type_id, movement_date)`, unique `feed_inventory_count(feed_type_id, count_date)`, `feed_manufacturing(manufacturing_date)`;
- `sales_session(session_date)` and cash / movement per session;
- `mp_financial_movement(occurred_date)` + unique `mp_reconciliation(movement, operation)`.

**No new index and no materialized view** is proposed.

## 13. Test strategy (`scripts/target-db/reporting.test.mjs`)

| Group | Proves |
|---|---|
| A structure | exactly V1–V7 added; all `security_invoker = true`; no table, materialized view or function added; definer inventory still 41; exact grants (authenticated only) |
| N no stored values | no balance / total / variance / KPI column or table; views only |
| M exact math | hand-computed scenario for every view (sales per product / client, balances per month and closing, MP remaining, Feria expected and variance per COUNT, internal consumption per interval, theoretical, variance, population(D) with same-day mortality, age floor, grade mix) |
| P P&L reuse | Σ V1 per period = `pnl_summary.ventas_netas_devengadas`; no Phase 25 view reads `pnl_*` bucket logic |
| B balances derived | V2 closing = `SUM(signed_amount)` of the base ledger for each ledger kind |
| T period correctness | a fact with `created_at` in month X and business date in month Y is reported in Y only; Feria movements follow `session_date`; a feed interval crossing months is not split |
| E empty periods | a month with no facts has no row; `management_period` provides the calendar; no zero fact is created |
| D drill-down | every aggregate re-sums exactly from the keys it exposes |
| R ADMIN access | ADMIN reads all 7 and the reused views |
| O OPERATOR allowed | V6 returns exactly the assigned flocks; V7 exactly own sessions; unassigned flocks and others' sessions are absent (RLS under joins) |
| X OPERATOR denied | V1–V5, `pnl_*`: 0 rows; a deactivated master does not drop OPERATOR fact rows |
| Y no cost reconstruction | V6 / V7 expose no monetary column; the columns OPERATOR can reach through any grant carry no monetary type or name; OPERATOR-visible `audit_events` payloads carry no monetary keys |
| Z anon / service_role | denied on all 7 views |

Plus a full regression and a clean rebuild at build time.

---

## 14. Owner decisions required (construction stops here)

**OD-1 — laying-rate formula and broken / dirty semantics.**

Neither the schema, an RPC nor a frozen document constrains `eggs_broken` / `eggs_dirty` relative to `eggs_total`: no CHECK or validation says they are subsets. What exists:
- Legacy evidence: `MIGRACION_HUEVOS_TOTALES.sql` ("totales = buenos + rotos").
- MIGRATION_STRATEGY maps `eggs_total` ← `totales` and `eggs_broken` ← `cachados`; `eggs_dirty` has no legacy source.
- Phase 20 ratified the **denominator**, population(D), same day, "for laying".

Nothing defines the numerator, or whether broken and dirty are included in or added to `eggs_total`. Computing laying %, broken % or dirty % would invent that rule.

**Recommended:**
- laying % = `eggs_total / population(D) × 100`;
- `eggs_broken` and `eggs_dirty` are **subsets** of `eggs_total`;
- broken % and dirty % = `x / eggs_total × 100`.

**OD-2 — OPERATOR access to laying / productivity of assigned flocks.**

The authorities disagree on whether OPERATOR may see laying:
- FROZEN Part 2 forbids OPERATOR only "*unauthorized* population/productivity data".
- RLS spec §8 / §10 grants OPERATOR SELECT on `daily_production` and `population_events` of assigned flocks.
- RPC_CONTRACTS §19 states that "population and aggregated-laying data remain unreachable" to OPERATOR. Phase 18 read that sentence as "RPC 19 grants no new access", not as a read ban.

A derived laying % reveals nothing the OPERATOR cannot already read, but whether to show it is a permission decision.

**Recommended:** OPERATOR sees laying % for assigned flocks only. Farm-wide aggregates are impossible for OPERATOR under invoker RLS.

**OD-3 — frontend scope of Phase 25.**

- No roadmap phase (25–32) owns a frontend on the target schema.
- Every construction phase deferred "frontend".
- The existing React app (`src/`: Vite, React 19, supabase-js, recharts) reads **only legacy tables** (`movimientos_caja`, `lotes`, `producciones`, `clientes`, `pagos`, …), and no screen targets the new schema.
- No frozen screen specification exists.
- UAT (28) needs the owner to operate the target system, so a target frontend is needed before Phase 28, and no phase covers it.

**Recommended:**
- Phase 25 = **A**, the DB reporting contract (V1–V7). This fully satisfies the exit criterion, which is data-layer verifiable.
- The target-schema frontend, including dashboard screens, is scoped separately by the owner, for example by a roadmap amendment before Phase 26–28.
- Screens are not invented here.

## 15. Readiness

| Area | Ready |
|---|---|
| Views V1–V5, V7 | yes: every formula is frozen or owner-ratified |
| View V6 without `laying_pct` / ratio columns | yes |
| `laying_pct` and broken / dirty ratios | **no** (OD-1, OD-2) |
| Frontend | **no** (OD-3) |

**CONSTRUCTION READY: no.** Construction resumes, without further review, once OD-1, OD-2 and OD-3 are answered.

**Changes required at build time:**
- **Schema:** one migration, 0046, with the 7 views and their grants. No table, column or index.
- **RPCs:** none.
- **Frontend:** per OD-3.

MASTER_ROADMAP.md, FROZEN documents, ADR-001…ADR-004 and migrations 0001–0045 were not modified. Production was not contacted.

---

## 16. Construction (after ADR-005)

**Owner decisions:** ADR-005 records OD-1 to OD-3 and the roadmap amendment.
- **D1 laying %:** `eggs_total / population(D) × 100`. Broken and dirty eggs are subsets of `eggs_total`. The result is NULL without a production row or when population(D) ≤ 0, and it is never stored.
- **D2 OPERATOR access:** OPERATOR sees productive metrics of currently assigned flocks only. The RPC_CONTRACTS §19 sentence is interpreted as a ban on global or non-assigned aggregates only.
- **D3 scope:** Phase 25 is the DB reporting contract only.
- **D4 roadmap:** a new Phase 27, Frontend V1 Integration, is inserted, and 28–33 are renumbered.

**Migration:** `0046_reporting_views.sql` (`0fee172d…b6ba`) creates the seven views of §7 with their grants, and nothing else.

**Deviations from the §7 design:**

| View | Change | Why |
|---|---|---|
| V4 `report_feria_session_cash` | Cash only. The Σ movement quantities per product were left out. | Summing quantities across products would mix units, and ADMIN already reads `sales_session_movement` directly. |
| V6 `report_flock_day` | Adds `quality_data_warning` (ADR-005 D1). `theoretical_feed_kg` is exact at 6 decimals. | Owner decision; exact representation. |
| V5 `report_feed_consumption_interval` | `theoretical_kg` is rounded to 3 decimals. | Same rounding as Phase 20. |

**Tests:** `scripts/target-db/reporting.test.mjs`, **63 assertions**.

| Group | n | Proves |
|---|---|---|
| B scenario | 1 | built through the real RPCs |
| A structure | 6 | exactly 7 `report_*` views, all `security_invoker`, owner postgres; grants to authenticated only; no materialized view, still 53 base tables; definer inventory unchanged (41); `feed_formula_line_safe` is still the only non-invoker view |
| N no stored values | 3 | no stored laying / theoretical / variance / balance / KPI column or table; reading the views writes nothing |
| F flock day | 11 | laying exact (90.4523); broken and dirty not added (930 not used); same-day population (998, 80.1603); NULL on days without production; population 0 and −1 → NULL; age exact and floor; theoretical kg; quality warning; one row per calendar day; drill-down |
| O OPERATOR | 7 | the assigned flock with the same laying % as ADMIN; no unassigned flock; no global aggregate (Σ = assigned flocks only); 0 rows of internal consumption; a deactivated assignment hides the flock; own classification sessions only; a deactivated grade never drops a row |
| C classification | 2 | grade mix and sessions exact; drill-down re-sums; no flock column |
| I feed interval | 4 | internal consumption 520 (opening-day flows excluded); theoretical 350.181, variance 169.819; a month-crossing interval stays one row and matches an independent computation; count drill-down |
| S sales / P&L | 4 | line level at `delivered_date`; by product; Σ per period = `pnl_summary` for **every** period; no report view reads P&L cost sources or bucket logic |
| L balances | 5 | client 1500 → 1650; closing = SUM of the ledger (client, supplier, every account); drill-down |
| M MP | 3 | remaining 480 → 0 with NORMALIZED → RECONCILED; `remaining_unassigned` is stored nowhere |
| K Feria | 3 | expected 350; two COUNTs → two rows (+30, +50), never summed (no 780); no COUNT → NULL row |
| T business dates | 3 | no `created_at` in any view; facts created today report at their business dates; `period = date_trunc(month)` |
| E empty periods | 2 | no fabricated zero month; `management_period` calendar readable by both roles |
| X security | 4 | ADMIN reads all; OPERATOR gets 0 rows from V1–V5 and `pnl_*`; anon and service_role denied on all 7; RLS holds under joins |
| Y cost | 4 | the OPERATOR views have no monetary column; **no monetary column in any relation OPERATOR can read rows from**; `unit_cost_snapshot` hidden; OPERATOR-visible audit payloads have no monetary key |
| Z cleanup | 1 | every R25-TEST fact removed |

**Regression fixes:**
- 13 older checks in 8 suites failed on the first full run: commercial G4, treasury A9, instruments A9, purchases A14, production A8, classification M3, feed H5 / P1 / P2 / P3 / E2E7, and feria A9 / K5.
- Each one is a *stored-object* scan over `information_schema`, which also lists views, so they matched the new derived views by name.
- Each scan now excludes the seven ADR-005 views by exact name, as earlier phases did. Every scan still covers every stored object, and no assertion was weakened for tables.

**Clean rebuild** (stack freshly started):
```
before              → public tables=53, ledger=46
guard               → target proven local; cli argv proven local-only → supabase db reset
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0, views=0
rebuild             → 0001 … 0046 applied → ledger holds 46; public tables = 53
re-run apply.mjs    → applied 0 new migration(s); ledger holds 46 (0001..0046)
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107, instruments 200/200,
                      purchases 216/216, production 149/149, classification 75/75, feed 176/176, feria 142/142,
                      fiscal 132/132, mp 143/143, pnl 84/84, reporting 63/63 (twice), guard 35/35
checksums           → 0039–0045 unchanged; legacy untouched
```
Supabase local was stopped at the end.

**Scope:**
- The frontend was not touched: `src/` is unchanged and belongs to Phase 27.
- RPCs 23 and 24 remain UNASSIGNED.
- No RPC, table or SECURITY DEFINER function was added.
- Production was not contacted.

**Exit criterion:**

| Requirement | Status | Evidence |
|---|---|---|
| Reporting reads derived values only | **MET** | A1–A6, N1–N3, S3–S4, L2–L4, M3, T1 |
| Respects RLS | **MET** | A2–A3, O1–O7, X1–X4 |
| Exposes no cost data to OPERATOR | **MET** | X2, Y1–Y4, O4 |

**PHASE 25 — DASHBOARD / REPORTS: COMPLETE** on mechanical evidence. MASTER_ROADMAP.md stays **CURRENT** for Phase 25 until external review.
