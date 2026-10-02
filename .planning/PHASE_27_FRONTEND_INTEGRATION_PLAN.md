# PHASE 27 — FRONTEND V1 INTEGRATION PLAN

**Status:** LIVE. This is the planning pass: an inventory and an implementation plan. No frontend code was changed.

**Exit criterion (MASTER_ROADMAP, unchanged):** the frontend operates against the target schema for the V1 business flows and reporting surfaces, respects ADMIN/OPERATOR permissions, and contains no duplicated business/accounting authority.

**Authority:**
- `MASTER_ROADMAP.md` (Phase 27);
- `ADR-005-REPORTING-AND-FRONTEND-SCOPE.md` (D1 laying %, D2 OPERATOR metrics, D4);
- `implementation-design/RPC_CONTRACTS_V1.md` and `RLS_IMPLEMENTATION_SPEC_V1.md` (FROZEN);
- `PHASE_25_REPORTING.md` (views 0046);
- `implementation-design/ADR006_PHASE27_MP_FRONTEND_CONTRACT_V1.md` (ACCEPTED, Step 14).

**Constraints:**
- The backend is FROZEN: no migration, no RPC, RLS or view change.
- Production is not contacted.
- ADR-006 steps 15 / 16 / 19 are not started.

---

## 1. Current frontend architecture (inventory)

| Aspect | Current state |
|---|---|
| Stack | React 19, TypeScript ~6.0, Vite 8, Tailwind 4, TanStack Query 5, zod 4, recharts, lucide, vite-plugin-pwa. About 14.5 k lines of TS/TSX in `src/` |
| Structure | `src/api/*` (Supabase queries and mutations) → `src/hooks/*` (TanStack Query hooks) → `src/features/<module>/*` (screens). Shared: `components/`, `types/domain.ts`, `validation/schemas.ts`, `constants/`, `utils/` |
| Routing | No router. `App.tsx` holds a `useState<Tab>` sidebar with the tabs `dashboard_produccion`, `produccion`, `pedidos`, `cobros`, `caja`, `mercadopago`, `finanzas` and `admin`. Each module has internal sub-views through local state |
| Supabase client | `lib/supabase.ts`: `createClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)`, a single client with the anon key plus the user session |
| Auth | `auth/AuthProvider.tsx`: `signInWithPassword`. The role comes from legacy `perfiles.rol` ∈ {`dueño`, `colaborador`, `repartidor`}. `LoginScreen` rate limit calls `api.ipify.org` |
| Role / navigation | `dueño` sees everything. `colaborador` sees only Producción. `repartidor` sees nothing specific. Checks are client-side only |
| Data access | Direct PostgREST `.from(<legacy table>)` reads **and writes** on 21 legacy tables. The only RPC is the legacy `marcar_pedido_entregado`. External `fetch` to Netlify functions (`sync-mercadopago`) with a bearer secret |
| Legacy dependencies | The legacy tables (`pedidos`, `pedido_lineas`, `clientes`, `pagos`, `pago_en_caja`, `movimientos_caja`, `cheques`, `comisiones`, `facturas`, `arqueos_caja`, `cuentas_caja`, `categorias_finanzas`, `lotes`, `producciones`, `recuentos_lote`, `precios_actuales`, `precios_historial`, `productos`, `perfiles.rol`) and the ADR-003-era MP legacy (`ledger_entry`, `account_balance`, `mercadopago_raw`, `mp_financial_movement` UPDATE); Netlify MP sync functions; the Google Sheets hook (dead code, not imported) |

**Target contract available:**
- 60 SECURITY DEFINER RPCs; the ADMIN / OPERATOR-executable ones are listed per slice below;
- views: `report_sales_line`, `report_balance_period`, `report_mp_movement_status`, `report_feria_session_cash`, `report_flock_day`, `report_feed_consumption_interval`, `report_classification_day`, `pnl_summary`, `pnl_line_item`, `feed_formula_line_safe`, and the three ADR-006 MP views;
- the **only** direct writes allowed to `authenticated` (masters, plus PENDING orders): `clients`, `products`, `price_history`, `expense_category`, `financial_account`, `sheds`, `suppliers`, `projects`, `operator_assignments`, `classification_grade`, `feed_type`, `feed_ingredient`, `feed_formula_version`, `feed_formula_line`, `genetics_consumption_curve`, `purchase_attachment`, `pedidos` (INSERT / UPDATE, PENDING only by policy) and `pedido_lineas` (INSERT / DELETE).

## 2. Screen inventory → target mapping

Legend:
- **R** = reuse the UI shell, **A** = adapt it (same UX, new data layer), **X** = replace or retire;
- visibility = target (ADMIN / OPERATOR per the RLS spec §8: OPERATOR's working set is production, classification, feed and feria, for assigned flocks only).

| # | Legacy screen (file) | Legacy read → write | Target read | Target write | Visibility | Fate |
|---|---|---|---|---|---|---|
| 1 | Login (`auth/LoginScreen`, `AuthProvider`) | `perfiles.rol` | `perfiles.rol_type` / `current_app_role()` | Supabase Auth only | all | **A — done in F27-A** (ipify removed) |
| 2 | Sidebar / tabs (`App.tsx`) | client role checks | `current_app_role()` | — | ADMIN full; OPERATOR working set | **A** |
| 3 | Dashboard producción (`ProductionDashboard`, `DashboardProduccion`) | `producciones`, `lotes`, `recuentos_lote` + client calcs | `report_flock_day` (laying_pct, population, quality_data_warning) | — | ADMIN all; OPERATOR assigned flocks only | **A** (calculations removed, §4) |
| 4 | Producción entry / list (`ProductionApp`, `FormProduccion`, `ListaProducciones`) | `producciones` → insert / update | `report_flock_day` / `daily_production` (RLS) | `register_daily_production`, `rectify_daily_production`, `register_mortality`, `rectify_mortality`, `register_management_event` | ADMIN; OPERATOR assigned | **A** |
| 5 | Lotes admin (`LotesAdmin`) | `lotes` → insert / update / **delete** | `flocks`, `sheds` | direct `sheds` (master); flocks per the frozen contract (no delete) | ADMIN | **A** (delete removed) |
| 6 | Recuentos (via `useRecuentos`) | `recuentos_lote` → insert / update / delete | `population_events` (via report_flock_day) | `register_mortality` / count adjustment per the contract | ADMIN; OPERATOR assigned | **X** (the recount concept maps to population events) |
| 7 | Pedidos list / form / card (`PedidosApp`, `FormPedido`, `ListaPedidos`, `PedidoCard`) | `pedidos`, `pedido_lineas` → insert / update / delete; RPC `marcar_pedido_entregado` | `pedidos`, `pedido_lineas`, `report_sales_line` | direct INSERT / UPDATE of **PENDING** pedidos and lines; `deliver_order`, `cancel_order`, `rectify_delivered_order` | ADMIN | **A** |
| 8 | Dashboard pedidos (`DashboardPedidos`, `pedidosCalculos`) | `pedidos` + client metrics | `report_sales_line` | — | ADMIN | **A** (presentation sums only) |
| 9 | Cuentas a cobrar (`CobrosApp`, `ListaClientes*`, `ListaFinalizados`, `RegistroPagoModal`) | `pedidos` − `pagos` computed client-side; `pagos` insert / delete; `pago_en_caja`; `movimientos_caja` update | `report_balance_period` (client balances from `client_ledger`) | `register_collection` (cash / transfer / instrument per contract), `receive_cheque` | ADMIN | **A** (balance computation removed) |
| 10 | Caja: movements (`CajaApp`, `ListaMovimientos`, `FormMovimiento`, `ModalEditar*`) | `movimientos_caja` insert / update / delete; `comisiones`; `facturas`; `pagos` update | `report_balance_period` (accounts), purchases / operations via views / RLS | `register_purchase` / `rectify_purchase` (expenses), `pay_supplier`, `transfer_between_accounts`, `register_freight`, `assign_freight_to_purchase` | ADMIN | **X** (no free-form movement CRUD in the target) |
| 11 | Caja: saldos / flujo / tendencia (`ResumenSaldos`, `ResumenFlujoCaja`, `TendenciaMeses`) | client sums of `movimientos_caja` | `report_balance_period`, `pnl_summary` | — | ADMIN | **A / X** (see P27-D2) |
| 12 | Caja: cuentas a pagar (`CuentasAPagar`) | client calc over `movimientos_caja` | `report_balance_period` (supplier ledger) | `pay_supplier` | ADMIN | **A** |
| 13 | Caja: arqueos (`ArqueoCard`, `FormArqueo`, `HistorialArqueos`) | `arqueos_caja` insert, `cuentas_caja` | — | — | — | **X — retired (P27-D1)** |
| 14 | Cheques (inside Caja via `api/caja.ts`) | `cheques` insert / update | instruments (RLS) | `receive_cheque`, `deposit_cheque`, `endorse_cheque`, `clear_cheque`, `reject_cheque`, `issue_supplier_instrument`, `mark_supplier_instrument_debited`, `cancel_supplier_instrument`, `reject_supplier_instrument` | ADMIN | **X** (new instrument screens) |
| 15 | Categorías (`CategoriasAdmin`, `api/categorias`) | `categorias_finanzas` insert / update; **re-classifies** `movimientos_caja` (update) | `expense_category` | direct `expense_category` (master: name / active / class); no re-classification of posted facts | ADMIN | **A** (the re-classification path is removed) |
| 16 | Finanzas P&L (`FinanzasApp` → `PyLProesional`; `PyL`) | client P&L over `movimientos_caja` + `pedidos` | `pnl_summary`, `pnl_line_item` | — | ADMIN | **A** (all calculations removed) |
| 17 | Mercado Pago (`MercadoPagoApp`, `SummaryCards`, `MovementsTable`, `MonthlyReport`, `UnclassifiedMovements`, `DateFilter`, `TypeFilter`) | `ledger_entry`, `account_balance`, `mp_financial_movement` (read + **UPDATE**), `mercadopago_raw`, Netlify sync | only the ADR-006 contract: 3 views + lookups L-C3 / L-C7 / L-S7 | C1, C3–C7, R1, S5, S6, S7 (R2 disabled until step 19) | ADMIN only | **X** (rebuilt on screens S-A…S-I) |
| 18 | MP debug / sync (`MercadoPagoDebug` in Caja; `useMercadoPago`) | Netlify `sync-mercadopago` with a bearer secret (**hard-coded token in source**; localStorage secret) | — | — (ingestion is backend: webhook + worker + cron) | none | **X** (removed; see S-1) |
| 19 | Admin clientes (`ClientesAdmin`) | `clientes` insert / update | `clients` | direct `clients` (master) | ADMIN | **A** |
| 20 | Admin precios (`PreciosAdmin`, `usePrecios`) | `precios_actuales` update + `precios_historial` insert | `products`, `price_history` | direct `price_history` (append) / `products` | ADMIN | **A** |
| 21 | Productos (`useProductos`) | `productos` | `products` | direct `products` | ADMIN | **A** |
| — | **Missing target surfaces** (no legacy screen) | — | per domain | classification (`register_classification`; `report_classification_day`); feed (`register_feed_manufacturing`, `register_feed_movement`, `register_feed_inventory_count`, `register_count_adjustment`, `assign_flock_feed`; `report_feed_consumption_interval`, `feed_formula_line_safe`); feria (`open_sales_session`, `register_session_movement`, `register_session_cash_event`, `close_sales_session`; `report_feria_session_cash`); fiscal (`register_fiscal_document`, `register_fiscal_obligation`, `pay_fiscal_obligation`); suppliers / purchases (`register_purchase`, `rectify_purchase`, freight, `pay_supplier`); `operator_assignments`; `projects` | ADMIN (+ OPERATOR working set for classification / feed / feria movements) | **new** |

## 3. Legacy direct writes that must disappear

Every one of these leaves the codebase:
- `movimientos_caja` insert / update / delete, including the categoría re-classification and the "sincronizar pagos" update;
- `pagos` insert / update / delete;
- `pago_en_caja` insert;
- `cheques` insert / update;
- `comisiones` insert;
- `arqueos_caja` insert;
- `categorias_finanzas` insert / update;
- `lotes` insert / update / **delete**;
- `recuentos_lote` insert / update / delete;
- `producciones` insert / update;
- `precios_actuales` update and `precios_historial` insert;
- `clientes` insert / update, and `pedidos` / `pedido_lineas` on legacy tables;
- `mp_financial_movement` **update** (MP classification);
- legacy RPC `marcar_pedido_entregado`;
- the Netlify `sync-mercadopago` calls.

After Phase 27, the only direct writes allowed are the target's authorized master writes and PENDING-order writes (§1). Everything else goes through an RPC.

## 4. Duplicated business / accounting authority to remove

| Location | What it computes | Target authority |
|---|---|---|
| `hooks/useClientesSaldo` | client balance = delivered orders − payments; "con crédito" / "finalizados" lists | `client_ledger` → `report_balance_period` |
| `features/caja/PyL`, `PyLProesional` | P&L by categoría / cost class from cash movements and orders | `pnl_summary`, `pnl_line_item` (ADR-004) |
| `features/caja/ResumenSaldos` | account balances from movement sums | Σ `financial_posting` → `report_balance_period` |
| `features/caja/ResumenFlujoCaja`, `TendenciaMeses` | cash flow, margins, monthly trends | `pnl_summary` / `report_balance_period` (P27-D2) |
| `features/caja/CuentasAPagar` | payables from movements | `supplier_ledger` → `report_balance_period` |
| `features/production/produccionCalculos`, `produccionHelpers`, `DashboardProduccion` | current hens, laying % (using "huevos sanos": **contradicts ADR-005 D1**, which uses `eggs_total` / `population(D)`), mortality aggregates, alerts | `report_flock_day` (`laying_pct`, population, `quality_data_warning`) |
| `features/pedidos/pedidosCalculos`, `DashboardPedidos` | period metrics, weekly series | `report_sales_line`. Presentation-only sums over view rows are allowed; no pricing or status rules |
| `features/pedidos/helpers` (`totalPedidoGeneric`, subtotal = cantidad × precio in `FormPedido`) | order total | the backend (the order total derives from current lines). A form preview may be shown as non-authoritative; the displayed saved total comes from the backend |
| `api/categorias` | re-classifying posted movements | expense category is a purchase-time fact; there is no retroactive re-classification |
| `lib/mercadopago-calculations`, `api/mercadopago-monthly`, `MercadoPagoApp` balances | MP income / expense / balance from `ledger_entry` | ADR-006 contract (axis A / B from the views); MP balance = Σ postings (`report_balance_period`) |
| `hooks/usePagos` + `pago_en_caja` | cash-register side effects of a payment | `register_collection` (single RPC, posting included) |

## 5. Reporting surfaces → Phase-25 views

| Surface | View | Visibility |
|---|---|---|
| Ventas / pedidos dashboard | `report_sales_line` | ADMIN |
| Saldos (clientes, proveedores, cuentas) | `report_balance_period` | ADMIN |
| P&L | `pnl_summary`, `pnl_line_item` | ADMIN |
| Producción por lote / día (laying %, population, warnings) | `report_flock_day` | ADMIN all; OPERATOR assigned flocks (ADR-005 D2, no monetary data) |
| Clasificación | `report_classification_day` | ADMIN; OPERATOR per RLS |
| Consumo de alimento | `report_feed_consumption_interval`, `feed_formula_line_safe` (no cost for OPERATOR) | ADMIN; OPERATOR per RLS |
| Feria caja | `report_feria_session_cash` | ADMIN |
| MP treasury movements (ADR-003 manual reconciliation) | `report_mp_movement_status` | ADMIN, **outside** the ADR-006 MP screens (the Step-14 contract forbids it there) |

## 6. Mercado Pago screens → accepted Step-14 contract

The MP module is rebuilt exactly as `ADR006_PHASE27_MP_FRONTEND_CONTRACT_V1`:
- screens S-A…S-I;
- the three views as the only state source;
- lookups L-C3 / L-C7 / L-S7 for identifiers only;
- actions C1, C3–C7, R1, S5, S6, S7; R2 disabled until ADR-006 step 19;
- two separate badges, with axis B labels "Sin cliente asignado" / "Asignación parcial" / "Cliente asignado" / "Asignación solicitada por ADMIN".

Every legacy MP code path (§2 rows 17–18) is removed. `scripts/regression/adr006-frontend-contract.check.mjs` stays green.

## 7. Implementation slices (dependency order; each gate must pass before the next starts)

| Slice | Content | Acceptance gate |
|---|---|---|
| **F27-A Foundation** | Point the client at the target (local stack for development); role from `current_app_role()` / `perfiles.rol_type`; role-based navigation (ADMIN / OPERATOR working set, legacy roles removed per P27-D3); a typed data-access layer over target views / RPCs (thin calls, no invented wrappers); a DB error-code → message map; **remove the hard-coded token, the MP debug / sync and the localStorage secret (S-1)**; remove dead code (Google Sheets) and the ipify call (unless the owner keeps it); add the test tooling (P27-D4) and the static gate script | `tsc -b` 0 errors; the static gate runs (legacy-table / forbidden-path scan, with a baseline list of what remains); ADMIN and OPERATOR logins against the local target show the correct navigation; the S-1 token is no longer in `src/` |
| **F27-B Masters / Admin** | clients, products + price_history, expense_category, sheds / flocks, suppliers, financial_account, operator_assignments, projects | only authorized master writes; no delete paths; integration tests per form (ADMIN ok, OPERATOR denied) |
| **F27-C Commercial** | pedidos (PENDING direct writes + lines), deliver / cancel / rectify RPCs, cuentas a cobrar via `register_collection` + `report_balance_period`, sales dashboard via `report_sales_line` | `useClientesSaldo`, `pedidosCalculos` business logic, `marcar_pedido_entregado` and `pagos` writes gone; integration: a PENDING order is created, delivered, collected, and the balance comes from the view |
| **F27-D Treasury, suppliers, purchases, instruments** | replaces Caja: account balances, transfers, purchases / expenses, freight, supplier payments and payables, the cheque / eCheq lifecycle | no `movimientos_caja` / `cheques` / `comisiones` / `arqueos_caja` reference; balances only from views; integration for each RPC path |
| **F27-E Production, classification, feed** (OPERATOR working set) | daily production, mortality and management events, classification, feed manufacturing / movements / counts / assignments; dashboards on `report_flock_day`, `report_classification_day`, `report_feed_consumption_interval` | the production calculation modules are removed; laying % only from `report_flock_day` (ADR-005 D1); OPERATOR integration sees assigned flocks only, with no monetary / cost field |
| **F27-F Feria + fiscal** | sales-session flow and cash events; fiscal documents / obligations / payments | RPC-only writes; `report_feria_session_cash` rendering; OPERATOR restricted to session movements per RLS |
| **F27-G Reporting / P&L** | P&L, saldos and trends on `pnl_*` / `report_balance_period` (per P27-D2) | `PyL*`, `ResumenSaldos`, `ResumenFlujoCaja`, `TendenciaMeses` calculations removed; screens render view values only |
| **F27-H Mercado Pago** | the Step-14 contract screens S-A…S-I | contract check green; the static gate proves no MP table read except L-C3 / L-C7 / L-S7, no `register_collection` from MP, no legacy MP path |
| **F27-I Integrated validation** | full legacy-reference purge, build, role end-to-end | §9 DONE criteria all mechanically true |

## 8. Test strategy (per slice)

1. **Static gate.** A new Node script under `scripts/regression/`, run on every slice. It scans `src/` and fails on:
   - any legacy table name;
   - `.insert/.update/.delete/.upsert` on a non-authorized table;
   - any RPC outside the frozen executable set;
   - `register_collection` reachable from MP code;
   - a hard-coded secret.

   The allowed-remaining list shrinks slice by slice and is empty at F27-I.
2. **Type check.** `tsc -b` stays at 0 errors.
3. **Integration tests.** Against the local target stack (guarded 127.0.0.1): each slice's data calls run as ADMIN and as OPERATOR through PostgREST with test JWTs. The tests assert the RPC outcomes and view rows the screen depends on, plus permission denials. The tooling is chosen in F27-A (P27-D4).
4. **Component tests.** Only for label / state rules with no DB, for example the axis B wording and CLIENT_UNASSIGNED never shown as a work item.
5. **Backend guard.** Each slice re-runs the frozen-backend checks it depends on (`adr006-frontend-contract.check.mjs` for F27-H). No backend suite needs to change.
6. **Manual smoke.** The owner walks through each slice against the local target. UAT proper is Phase 29.

## 9. Definition of Phase 27 DONE

All of the following must hold, mechanically where possible:
1. `src/` references **no** legacy table, legacy RPC or Netlify MP function (static gate: empty remaining list).
2. Every write is a frozen RPC or one of the authorized direct master / PENDING-order writes (static gate).
3. The role comes from the target (`current_app_role()` / `rol_type`). Navigation and screens respect ADMIN / OPERATOR, and OPERATOR integration tests see only the working set: assigned flocks, no monetary or cost data.
4. Every reporting surface reads Phase-25 views. Every MP surface follows the Step-14 contract, and its check is green.
5. None of the §4 duplicated-authority computations remain.
6. `tsc -b` = 0 errors, the production build succeeds (in an environment configured by the owner), and every slice's integration tests are green.
7. No secret in `src/` or in the built bundle beyond the public anon key. S-1 is closed: the token was removed and rotated by the owner.
8. The owner confirms the V1 flows in a local walkthrough, which hands over to Phase 28 (Integral QA).

## 9a. Slice status

| Slice | Status | Evidence |
|---|---|---|
| F27-A Foundation | **COMPLETE** | `src/target/{roles,role,db}.ts`; the role from `current_app_role()`; role navigation plus a "Sin acceso" screen; S-1, MP debug / sync, `localStorage` secret, ipify and dead Google Sheets code removed. Checks: `phase27-frontend-static.check.mjs` (8/0; baseline 24 files / 109 legacy references), `npm test` 5/5, `npm run test:integration` 4/4, `tsc -b` 0, safe build + dist scan 0 findings |
| F27-B Masters / Admin | **COMPLETE** | Two commits: `50c83b3` (masters / admin) and the ADR-007 completion commit (flock lifecycle). Admin screens on the target masters through `src/target/masters.ts` (authorized INSERT / UPDATE only, no delete path; an RLS-filtered UPDATE is reported as NOT_UPDATED): clients, products + price_history (a change closes the current row the day before and appends the new one), expense_category (`pnl_cost_class` set on creation only, D-F27B-2), sheds, suppliers, financial_account, operator_assignments, projects. **Flocks (D-F27B-1, ADR-007):** "Nuevo lote" and "Marcar salida" in LotesAdmin through RPC 44 `register_flock` / RPC 45 `close_flock` only (no direct flock write grant); the pullet `purchase_id` stays optional in the RPC and is not offered in the form (purchase selection belongs to F27-D). Unused legacy `usePrecios` / `api/precios` removed; legacy hooks still used by later slices (`useClientes`, `useProductos` → F27-C; `useLotes` → F27-E; `useCategorias` → F27-D) stay in the baseline. Checks: static gate 8/0 (C-1 verifies RPC 44 / 45 in the live executable set), baseline 24 files / 109 → 20 files / 97 references; `npm test` 25/25; `npm run test:integration` 23/23; backend `flock_lifecycle.test.mjs` 46/46 plus the production, feed and perimeter suites at 62 SECURITY DEFINER; `tsc -b` 0; safe build + dist scan 0 findings |
| F27-C Commercial | **COMPLETE** | Commit "phase27: F27-C migrate commercial flows to target". `src/target/commercial.ts` + `features/pedidos/useCommercial.ts`:
- Pedidos: PENDING order + lines are direct writes (INSERT / UPDATE of the order while PENDING; lines are inserted, then the previous version deleted). The subtotal is the generated column. The line price is the snapshot of the current `price_history` of the list chosen in the form. A rejected line set cancels the half-created order through `cancel_order`.
- Deliver / cancel / rectify only through RPC 1 / 3 / 2. Rectification requires a reason.
- Cuentas a cobrar: the balance is the latest client `closing_balance` of `report_balance_period`. Collections go only through `register_collection` (CASH / TRANSFER / MERCADOPAGO, financial account required). Cheques stay with the instruments flow (F27-D). The receipt id is the idempotency key.
- The sales dashboard reads `report_sales_line` only.
- Removed: `useClientesSaldo`, `pedidosCalculos`, `usePagos`, `useClientes`, `useProductos`, `api/clientes`, the legacy order / collection lists and cards. No `marcar_pedido_entregado` and no `pagos` write remain in commercial code.
- Kept for later slices (baselined): `api/pedidos.listarPedidos` / `usePedidos` read for `caja/PyLProesional` (F27-G; the table names coincide with target tables, so the gate cannot see that it reads the legacy row shape); `api/pagos.agregarPagoAlaCaja` and the `pagos` update in `api/caja.ts` for Caja (F27-D).
- UX without a target column, dropped: order date and observations; the "Total de huevos" metric (a units-per-product conversion with no authority); linking a Caja movement to a collection; the client-side overpayment block (the backend decides). Delivery uses the current time.

Checks:
- static gate 8/0; baseline 20 files / 97 → 15 files / 70 references (no `--allow-grow`);
- `npm test` 43/43 (F27-C 19);
- `npm run test:integration` 35/35 (F27-A 4, F27-B 19, F27-C 12). Across 11 full runs, 1 run failed 2 F27-B `clients` cases that pass in isolation. It was not reproducible in 10 reruns; the cause is not identified. Recorded as an observed cross-file flake;
- backend commercial 147/0, reporting 63/0, treasury 107/0, instruments 200/0, foundations 96/0;
- `tsc -b` 0; safe build + dist scan 0 findings |
| F27-D Treasury, suppliers, purchases, instruments | **COMPLETE** (owner decision on E-F27D-2, option (a), 2026-09-30). Commit "phase27: F27-D migrate treasury purchases and instruments". The Storage-API and end-to-end "Nueva compra" verification is deferred to MANDATORY pre-cutover verification, not waived: those tests are SKIPPED, not passed | `src/target/treasury.ts` + `features/caja/useTreasury.ts`; Caja rebuilt as tabs (Saldos, Cuentas a pagar, Compras y fletes, Cheques, Tendencia meses):
- Account and supplier balances: the latest closing balance of `report_balance_period` (ACCOUNT / SUPPLIER); no balance computed in React.
- RPC-only: `transfer_between_accounts`; `pay_supplier` (CASH / TRANSFER / MERCADOPAGO); paying by cheque / eCheq = `issue_supplier_instrument`; `rectify_purchase` (reason required, attachments carried forward by the backend); `register_freight`, `assign_freight_to_purchase`.
- Instruments: `receive_cheque` (the cheque collection deferred from F27-C), `deposit_cheque`, `clear_cheque`, `endorse_cheque`, `reject_cheque`, `mark_supplier_instrument_debited`, `cancel_supplier_instrument`, `reject_supplier_instrument`. The buttons per state mirror the contract; no instrument state is written by the frontend.
- "Tendencia meses" (P27-D2): `pnl_summary` columns as reported (accrued net sales, operating result, result after investments), last 6 periods; the legacy margin and ingresos − egresos formulas are not recreated.
- Removed: free-form movement CRUD (`ListaMovimientos`, `FormMovimiento`, `ModalEditarMovimiento`), the category re-classification (`ModalEditarCategoria`, `api/categorias`, `useCategorias`), "Sincronizar pagos" / `agregarPagoAlaCaja` / `api/pagos`, the general flujo de caja (`ResumenFlujoCaja`, P27-D2), the general arqueos (`ArqueoCard`, `FormArqueo`, `HistorialArqueos`, `api/arqueos`, `useArqueos`, P27-D1), `constants/categorias-caja`. No `pagos`, `cheques`, `comisiones`, `facturas`, `arqueos_caja` or `cuentas_caja` reference remains in `src/`.
- Kept for F27-G (baselined, read-only): `api/caja.listarMovimientosCaja` / `useMovimientosCaja`, the source of the Finanzas P&L (`PyLProesional`; `PyL` is unimported). This is the only remaining `movimientos_caja` reference.

**D-F27D-1 — RESOLVED (owner, 2026-09-30) → ADR-008.** Purchase attachments live in the PRIVATE Storage bucket `purchase-attachments`: ADMIN-only upload / read / delete through `current_app_role()`, 10 MB, PDF / JPEG / PNG / WebP, generated key `<auth-user-id>/<uuid>.<ext>`, no UPDATE, no public URL. Migration `0058_purchase_attachment_storage.sql` (applied locally; ledger 58). "Nueva compra" (`src/target/attachments.ts`): validate → upload → `register_purchase`; upload failure = no RPC call; RPC failure = uploaded objects removed and the original error shown; a failed cleanup is reported with object keys only.

**E-F27D-2 (environment) — DEFERRED to mandatory pre-cutover verification (owner, option (a)):** the local stack runs without the Storage service (its container is started by the Supabase CLI, which Windows Application Control blocks). The RLS perimeter of 0058 is verified in the database as the roles the Storage service uses. Not executable here, and written as tests that run automatically once the service is up:
- the Storage-API layer: MIME refusal, 10 MB refusal, signed / public URL, real upload / download / delete;
- the end-to-end "Nueva compra" upload → RPC.

Checks:
- static gate 8/0, baseline 15 files / 70 → 10 files / 31 references (no `--allow-grow`);
- `npm test` 67/67 (F27-D 24, including the upload / compensation sequence);
- `npm run test:integration` 53 passed / 5 skipped. The skipped 5 are the 2 Storage-API + 3 end-to-end tests of E-F27D-2. The files are F27-A 4, F27-B 19, F27-C 12, F27-D 11 (+3 skipped), Storage perimeter 7 (+2 skipped);
- backend treasury, purchases, instruments, commercial, reporting, pnl green (counts in the F27-D report); ADR-006 frontend contract 28/0;
- `tsc -b` 0; safe build + dist scan 0 findings |
| F27-E Production, classification, feed | **COMPLETE** | Commit "phase27: F27-E migrate production classification and feed". `src/target/{production,classification,feed}.ts` + `features/production/useProduction.ts`:
- **Production:** register / rectify through RPCs 18 / 19. The daily form (flock, business date by default, eggs total / broken / dirty, optional deaths, notes) records production and, when entered, mortality: two contract facts. The history is `report_flock_day`, with eggs, laying % and expected curve, mortality, population and the quality warning as reported.
- **Mortality and population:** register mortality (RPC 20); mortality rectification (RPC 21, ADMIN only); count adjustment with reason (RPC 22). Population comes only from `report_flock_day`. The ADR-007 exit-date rule is enforced by the backend: activity dated after the exit is refused, a correction on or before it is accepted.
- **Classification:** one idempotent `register_classification` session per form. The grades come from the `classification_grade` reference data, with no frontend constants. The daily summary is `report_classification_day`.
- **Feed:** manufacturing (effective formula version) and physical counts (ADMIN and OPERATOR); loss / adjustment movements and flock feed assignment (ADMIN only). Consumption is the count-to-count `report_feed_consumption_interval` in kg; no cost is read.
- **Roles:** OPERATOR modules are production dashboard, production, classification and feed, for assigned flocks only (RLS). The production dashboard moved from ADMIN-only to the OPERATOR working set per §2 row 3.
- **Removed:** the legacy production screens and calculations (`produccionCalculos`, `produccionHelpers`, `DashboardProduccion`, `ListaProducciones`, including the "huevos sanos"-based laying % that contradicted ADR-005 D1); `api/{lotes,producciones,recuentos}`; `hooks/{useLotes,useProducciones,useRecuentos}` with their realtime subscriptions.
- **Not in F27-E (reported):**
  - `register_management_event` is an ADR-004 monetary P&L event (RETIRO / RESERVA_INTERNA, ADMIN only), so it moves to F27-G with the P&L. §2 row 4 listed it under production;
  - an external feed sale (`EXTERNAL_SALE`) needs its Pedido (`PEDIDO_REQUIRED`); the Pedido link is not offered, so the movement form offers loss and adjustments only;
  - the legacy mid-day / afternoon split has no target field: the day's totals are entered.
- `writeTable` now refuses a table outside `DIRECT_WRITES` with `DIRECT_WRITE_NOT_ALLOWED` instead of a TypeError.

Checks:
- static gate 8/0, baseline 10 files / 31 → 4 files / 13 references (no `--allow-grow`);
- `npm test` 83/83 (F27-E 16);
- `npm run test:integration` 63 passed / 5 skipped, 3 consecutive runs (F27-E 10; the 5 skipped are the E-F27D-2 Storage tests);
- backend suites green (counts in the F27-E report); `tsc -b` 0; safe build + dist scan 0 findings |
| F27-F Feria + fiscal | **COMPLETE** | Commit "phase27: F27-F migrate feria and fiscal to target". New target surfaces; there was no legacy Feria or fiscal screen, so nothing is removed and the baseline stays at 4 files / 13 references. The remaining references are owned by F27-G (`api/caja.ts`, the P&L source) and F27-H (the three Mercado Pago files). Implementation: `src/target/{feria,fiscal}.ts`, `features/feria/{useFeriaFiscal.ts,FeriaApp.tsx}`, `features/fiscal/FiscalApp.tsx`.
- **Feria (ADMIN):**
  - RPC 30–33 only. Open (an opening fund needs a cash account); goods movements; cash events (expense, withdrawal, transfer out); the physical COUNT, an observation with no posting.
  - Close with the aggregated retail lines, which become the CONSUMIDOR FINAL Pedido; the price starts from the current MINORISTA price and stays editable. A closed session takes nothing more.
  - The reconciliation is `report_feria_session_cash` as reported: expected cash = fund − expenses − withdrawals − transfers, and each count's variance stays visible, never auto-corrected.
  - There is no rectification RPC for sessions. This is the Feria session count, not the retired general arqueo (P27-D1).
- **Fiscal (ADMIN):** record documents with their tax components, obligations (optional installments, each with a due date) and payments, through the fiscal RPCs only. The target does not issue documents to AFIP / ARCA and nothing calls an external fiscal service.

**D-F27F-1 — RESOLVED (owner, 2026-09-30): Feria is ADMIN-only in V1 → ADR-009.**
- The gap: RPC 31 accepted OPERATOR while RLS §6 gives OPERATOR no product catalogue.
- The owner rejected granting OPERATOR product access. OPERATOR has no Feria capability, and fiscal stays ADMIN-only.
- Migration `0059_feria_admin_only.sql` gives RPC 31 the standard ADMIN guard. The audit found RPCs 30 / 32 / 33 already ADMIN-only and no other Feria writer. No schema, grant or policy change; `products` / `price_history` RLS unchanged.
- The Phase 21 backend suite encoded the old OPERATOR permission. It was amended (C0, C1–C7, G9, H2, J2 / J3) and is green.
- Owner follow-up: Feria is completely ADMIN-only in V1, including reads. Migration `0060_feria_admin_only_reads.sql` drops the OPERATOR read policies on `sales_session` / `sales_session_movement` and removes the Feria entity from `audit_events_operator_own`. OPERATOR now reads no session, movement, cash event, Feria audit row or `report_feria_session_cash` row; ADMIN keeps full access. The Phase 21 suite was amended again (G1, G2, G3b, G6, G9b, O1).

Checks:
- static gate 8/0 (4 files / 13, unchanged);
- `npm test` 95/95 (F27-F 12);
- `npm run test:integration` 72 passed / 5 skipped (F27-F 9), 3 consecutive clean runs. An earlier pre-ADR-009 run hit the known post-login `JWT issued at future` intermittent at `f27c-commercial.test.ts:95` (not reproduced in 5 reruns);
- backend suites green (counts in the F27-F report); `tsc -b` 0; safe build + dist scan 0 findings |
| F27-G Reporting / P&L | **COMPLETE** | Commit "phase27: F27-G migrate reporting and pnl to target". `src/target/pnl.ts`; Finanzas rebuilt (ADMIN):
- **P&L:** `pnl_summary` for 3 / 6 / 12 months, all 14 ADR-004 cascade lines exactly as reported. Per-month drill-down lists the `pnl_line_item` rows by bucket, never summed: bucket totals are the summary columns.
- **Management events** (deferred from F27-E): retiros and reservas internas, with optional compensation, through `register_management_event` (RPC 43, ADMIN) only. `management_event` was added to the frontend read list (SELECT grant and ADMIN RLS already exist).
- **Tendencia meses** (P27-D2): the single `TendenciaMeses` component over `pnl_summary` moved from Caja to Finanzas; there is no other trend logic.
- **Removed** (all frontend accounting authority):
  - `PyLProesional`, with its hard-coded category buckets, revenue from legacy `pedidos` and cost sums over `movimientos_caja`;
  - the unimported `PyL`;
  - `api/caja` / `useCaja` (the last `movimientos_caja` read);
  - `api/pedidos` / `usePedidos` (the legacy pedidos read and its realtime subscription).
- **Not reproduced:** the legacy "ventas facturadas / no facturadas" split and the per-category cost columns (alimento, cartones, sueldos, electricidad, …). The target P&L has no such authority: the cost breakdown is the drill-down rows with their expense category.

Checks:
- static gate 8/0, baseline 4 files / 13 → 3 files / 11 references (`api/caja.ts` removed; `api/pedidos.ts` / `usePedidos.ts` were never visible to the gate and are removed too). The remaining 11 references are the three Mercado Pago files owned by F27-H;
- `npm test` 103/103 (F27-G 8);
- `npm run test:integration` F27-G 5/5;
- backend suites green (counts in the F27-G report); `tsc -b` 0; safe build + dist scan 0 findings |
| F27-H Mercado Pago | **COMPLETE** | Commit "phase27: F27-H migrate Mercado Pago frontend to target". `src/target/mp.ts` + `features/mercadopago/{useMP.ts,CobrosMP.tsx,OperacionesMP.tsx,MercadoPagoApp.tsx}`, exactly the accepted Step-14 contract (ADMIN only):
- **Screens:** S-A / S-B cobros (list with server-side filters on the two axes + detail with inline open exceptions); S-C / S-D; S-E banner and panel; S-G recovery; S-H chargeback signals; S-F report exceptions; S-I payer mappings.
- **State:** only `report_mp_receipt_status`, `report_mp_delivery_health` and `report_mp_report_exceptions`, each with the §10 field list. Axis A and axis B are two separate badges; `CLIENT_UNASSIGNED` is a valid state, never a work item. No state, balance or remaining amount is computed.
- **Lookups:** exactly L-C3 / L-C7 / L-S7 with the §5a predicate and allow-listed columns, used only for the C3 / C7 / S7 identifiers.
- **Actions:** C1, C3, C4, C5, C6, C7, R1, S5, S6, S7 through their RPCs, each with a required reason; `ui:<uuid>` keys for C1 / C3. R2 is shown disabled (`DISABLED_UNTIL_STEP_19`) and has no call. There is no `register_collection` for an MP receipt and no MP table write.
- **Removed:** the legacy MP frontend (`api/mercadopago`, `api/mercadopago-monthly`, `UnclassifiedMovements` with its `mp_financial_movement` UPDATE, `MonthlyReport`, `MovementsTable`, `SummaryCards`, `DateFilter`, `TypeFilter`; the `ledger_entry` / `account_balance` reads).
- **Kept:** `src/lib/mercadopago-calculations.ts`. No frontend file imports it any more, but the legacy Netlify function `sync-mercadopago-releases-status` (N-1: stays until cutover) and its old node test do.

Checks:
- static gate 8/0, baseline 3 files / 11 → **0 files / 0 references**;
- `npm test` 113/113 (F27-H 10, checked against the §10 block);
- `npm run test:integration` F27-H 10/10. Fixtures go through the backend's own service pipeline, as in `mp_views`, with no real MP API;
- MP backend suites and ADR-006 frontend contract green (counts in the F27-H report); `tsc -b` 0; safe build + dist scan 0 findings |
| F27-I Integrated validation | **COMPLETE** | Commit "phase27: F27-I integrated validation and frontend closure".
- **Audit of the whole of `src/`** (beyond the gate), `tests/unit/f27i-audit.test.ts`:
  - no legacy relation or RPC, legacy role name, sync / debug / ipify / service-role surface, or secret in browser storage;
  - every PostgREST read / write / RPC goes through `src/target/db.ts`;
  - no orphaned module except the N-1 helper.
- **Target inventory** (mechanical):
  - 11 views, 17 read tables, 39 RPCs;
  - direct writes only where `DIRECT_WRITES` authorizes them: F27-B masters, `price_history`, `operator_assignments`, PENDING `pedidos` / `pedido_lineas`, plus Storage objects under ADR-008;
  - no write outside `DIRECT_WRITES`, no RPC outside `TARGET_RPCS`;
  - `TARGET_RPCS` without UI by design: `assert_period_open` (helper), `mp_reconcile_movement` (RPC 41, forbidden in the MP screens by Step 14), `mp_normalize_report_fallback` (R2, until Step 19).
- **Cleanup** (proven unused, superseded by the target):
  - `components/Modal.tsx` and `components/Pagination.tsx` (legacy, unimported);
  - `constants/categorias.ts`;
  - the legacy calculation helpers of `features/pedidos/helpers.ts`, including `totalPedidoGeneric` (plan §4); only `formatoPesos` remains;
  - the legacy row types of `types/domain.ts`; only `User` / `Rol` remain;
  - the legacy form schemas of `validation/schemas.ts`; only `loginSchema` remains.
- **Cross-slice flows**, `tests/integration/f27i-e2e.test.ts`, 8/8:
  - A + F: sale → `report_sales_line` + `pnl_summary` + client balance → collection;
  - B + F: purchase → supplier debt + direct cost → payment;
  - C: flock → assignment → production / mortality / adjustment → classification → feed → close → ADR-007 protection;
  - D: Feria ADMIN-only, reads included;
  - E: fiscal;
  - G: MP pipeline receipt → `CLIENT_UNASSIGNED` → C1 → client balance;
  - the role matrix, including a user without a profile (former repartidor).

**Phase 27 DONE (§9):**
1. Static gate 8/0 with baseline 0 files / 0 references, plus the whole-`src/` audit.
2. Writes limited to RPCs and authorized direct writes (gate C-4 and the inventory).
3. Role from `current_app_role()`; ADMIN / OPERATOR / no-profile matrix in integration; OPERATOR sees assigned flocks only and no monetary or cost data.
4. Reporting surfaces on Phase-25 views; MP on the Step-14 contract (check 28/0).
5. None of the §4 duplicated computations remain.
6. `tsc -b` 0; safe build OK; every slice's integration green.
7. No secret in `src/`, in tracked files or in a freshly built bundle; the only JWT is the public local anon key; S-1 closed.
8. **Not claimed:** the owner's local walkthrough of the V1 flows is the owner's hand-over step to Phase 28.

Items 1–7 are mechanically true. |

## 9b. Pre-cutover checklist (consolidated at F27-I; mandatory before cutover, Phase 31; none executed here)

Environment verification debt: SKIPPED / PRE-CUTOVER REQUIRED, never counted as passed.
1. Canonical `supabase db reset` from 0001–0060 on the canonical local stack, then the full target suite.
2. ADR-008 Storage API against the canonical stack with the Storage service:
   - ADMIN upload, authenticated download and delete;
   - MIME rejection and > 10 MB rejection;
   - signed URL works, public URL gives no access
   (`tests/integration/f27d-storage.test.ts` "ADR-008 Storage API").
3. "Nueva compra" real Storage end-to-end: upload → `register_purchase` → attachment metadata; compensation on RPC failure (`tests/integration/f27d-treasury.test.ts`).
4. `scripts/target-db/mp_audit_security.test.mjs` (needs the Supabase CLI).
5. `scripts/target-db/mp_scheduler.test.mjs` (needs the Supabase CLI).
6. `scripts/target-db/mp_webhook.test.mjs` (needs the Supabase CLI).
7. ADR-006 X-7 (needs the Supabase CLI).
8. Post-login JWT first-request stability:
   - `JWT issued at future` seen twice at `f27c-commercial.test.ts:95` and once in F27-B `clients`, the first PostgREST call right after sign-in with all integration files running in parallel;
   - never reproduced in isolation (230 probes, 5 + 5 reruns);
   - to verify on the canonical stack.

Cutover cleanup already recorded (N-1 / L-1 / D-DEPLOY):
- **N-1:** the legacy Netlify functions (`netlify/functions/*`) and the legacy MP tables stay until cutover. `src/lib/mercadopago-calculations.ts` stays with them: it is imported by `netlify/functions/sync-mercadopago-releases-status.ts` and its node test, not by the frontend. Remove them at cutover.
- **L-1:** the legacy Netlify MP function exposure (`sync-mercadopago`, `sync-settlement-csv`) is OPEN pending the owner's mitigation decision (§10).
- **D-DEPLOY:** Phase-27 commits do not reach production before cutover or an explicit deployment decision. `phase27-frontend` is not pushed; local `main` is not pushed.
- The local `dist/` folder is a stale pre-Phase-27 build (2026-09-23, gitignored, contains legacy code). It is not produced by the safe build, which builds in a temporary directory. Rebuild before any deployment.

**Pre-cutover verification debt (recorded, not a blocker):**
- the canonical `supabase db reset` and the CLI-dependent suites `mp_audit_security`, `mp_scheduler`, `mp_webhook` and ADR-006 X-7 cannot run while Windows Application Control blocks the Supabase CLI. They must be re-run green once the CLI is available and before cutover (Phase 31);
- the F27-B `clients` integration flake observed once in F27-C (1 of 11 full runs; not reproduced in 10 F27-C reruns nor in 3 F27-D full runs) must be re-checked for stability before cutover;
- a second intermittent of the same shape, seen once in F27-D (1 of 3 full runs): the first PostgREST call after sign-in in `f27c-commercial` failed with `JWT issued at future`. The cause is a token used within the second it was issued, rejected by PostgREST's time check. It was not reproduced in 5 reruns of that file nor in 230 sign-in → request probes, including 200 concurrent ones. It is probably the same cause as the F27-B flake, which also failed on the first write after sign-in;
- E-F27D-2, **SKIPPED / PRE-CUTOVER REQUIRED** (never counted as PASS). They must run green against the canonical local stack with the Storage service:
  - `tests/integration/f27d-storage.test.ts` "ADR-008 Storage API": ADMIN upload, authenticated download and delete; unsupported MIME rejected; > 10 MB rejected; signed URL works; public access does not work;
  - `tests/integration/f27d-treasury.test.ts` "Nueva compra": real upload to `purchase-attachments` → `register_purchase` → persisted attachment metadata; cleanup compensation on RPC failure; OPERATOR upload refused without calling the RPC.

## 9c. Pre-cutover technical validation run (2026-10-01, HEAD 4a7b7ed + test/doc fixes)

**Result: PRE-CUTOVER BLOCKED.** Every blocked item depends on the Supabase CLI, which Windows Smart App Control blocks ("Una directiva de Control de aplicaciones bloqueó este archivo"; CodeIntegrity events 3077 / 3118). No workaround was used.

| Item | Status | Evidence |
|---|---|---|
| Canonical `supabase db reset` (0001–0068) | BLOCKED | the CLI binary does not start |
| Backend suites on the local DB (migration runner, 68 migrations) | PASS | 33 runnable suites green when run in series, each after a clean DB. Runs in parallel with the ADR-006 matrix contaminated global-count checks; a series rerun was green |
| mp_audit_security / mp_scheduler / mp_webhook / mp_worker_http | BLOCKED | `spawn UNKNOWN` (CLI). Their partial fixtures are left behind and were cleaned. mp_webhook also requires `MP_ACCESS_TOKEN` to be absent from the environment |
| ADR-006 matrix | 12 PASS / X-7 BLOCKED | X-7 needs the anon key from `supabase status` (CLI). X-1 was updated to the 67-function inventory |
| ADR-008 Storage API + "Nueva compra" real upload (5 tests) | BLOCKED | no Storage container; `/storage/v1` answers 503; starting it needs the CLI |
| "Nueva compra" without a file (ADR-010) | PASS | integration |
| Frontend unit / integration / static gate / ADR-006 frontend contract / tsc / safe build | PASS | unit 211/0; integration 108 + 5 skipped (Storage); gate 8/0; contract 28/0; tsc 0 errors; build with 0 findings |
| JWT `issued at future` | INTERMITTENT | 1 of 3 full parallel runs (f27b, the first write after sign-in); host and containers on the same second; no code change justified |
| instruments R7 | INTERMITTENT | 3/3 focused PASS |
| MP parallel interference | NOT REPRODUCED | 3 full integration runs |
| `dist/` | PENDING | stale 2026-09-23 build (production host, ipify, legacy sync endpoints); not regenerated while prerequisites are blocked |

**Cutover cleanup inventory** (nothing deleted):
- **already removed (F27-A…I):** frontend legacy MP sync / debug, the hard-coded token and localStorage secret, ipify, and the legacy calculations / screens (legacy baseline 0);
- **keep until cutover:** `netlify/functions/*` (6 MP functions + `lib/mp-release-identity.ts`), the `netlify.toml` scheduled function `sync-mercadopago-releases`, `src/lib/mercadopago-calculations.ts` and `tests/mercadopago-calculations.test.mjs`, the legacy MP tables, `supabase/migrations/*` (legacy, 12 files);
- **remove at cutover:** the same items, plus `.netlify/functions-serve` (stale local build) and the legacy MP scripts `scripts/consolidate-mp-duplicates.mjs`, `repair-mp-balance-cache.mjs`, `verify-mp-api.mjs`;
- **unclear / owner decision:**
  - legacy `supabase/migrations/001–003` create `mp_source_record` and `mp_financial_movement`, the **same names** as target tables. The cutover must state whether the target goes into a new project or the legacy MP tables are dropped / renamed first;
  - L-1 (Netlify MP function exposure) stays OPEN.

Feria remains PARTIAL / DEFERRED.

## 9d. Pre-cutover validation on the canonical stack (2026-10-01, Ubuntu WSL2 + official Supabase CLI 2.119.0)

**Result: PRE-CUTOVER BLOCKED.**
- The canonical rebuild, Storage, the ADR-006 matrix and the clean-cutover contract are green.
- Remaining blockers:
  - B-1, a real privilege defect;
  - B-2 / B-3, environment items;
  - Feria.

Backend / CLI ran in Ubuntu; frontend / tsc / build ran in Windows, against the same Docker Desktop stack.

| Item | Status | Evidence |
|---|---|---|
| Canonical `supabase db reset` + `apply.mjs` 0001→0068 | **PASS** | ledger 68; 67 SECURITY DEFINER; 33 enums; 60 tables; 15 views; private bucket `purchase-attachments`; cron `mp_worker_every_minute` |
| Clean-cutover contract CT-1…CT-5 | **PASS** | 21/0, including CT-1b (ledger = files) and CT-1c (sha256 = file). The DB was then restored to canonical clean (reset + apply, ledger 68) |
| Backend suites, in series | 30 PASS | no business residue after any suite |
| commercial H15 / I4, mp_privileges S-1b | **FAIL — B-1** | anon holds EXECUTE on 6 SECURITY DEFINER functions: `assert_period_open`, `current_app_role`, `cancel_order`, `deliver_order`, `rectify_delivered_order`, `register_collection` |
| mp_worker_http (11/6), mp_scheduler (26/7), mp_audit_security L-W1 / L-K1 / L-K2 | **BLOCKED — B-2 (environment)** | the edge runtime reaches `host.docker.internal` = the Windows host, not the WSL distro where the suites' MP mock listens (verified both ways). L-K1 / L-K2 passed once |
| mp_webhook | **BLOCKED — B-3 (environment)** | imports `.ts` directly: needs Node ≥ 22.18 / 24 in Ubuntu (Node 20 installed); it also needs B-2 |
| mp_worker, verifySignature | PASS | run on Windows Node 24 (no CLI needed): 78/0, 95/0 |
| mp_audit_security K-2 | FAIL (scan scope) | (1) `tests/unit/block4-classification-feed.test.ts` used `x.invalid`: fixed to `example.invalid`. (2) `package-lock.json`: public npm author metadata (`@izs.me`), not PII; the scan reads every file changed since `81e0a6a`. Pending an owner decision on excluding lockfiles |
| ADR-006 matrix | **PASS** | 13/0, X-1…X-7 (X-7 with `supabase status`) |
| ADR-008 Storage + "Nueva compra" with a file | **PASS** | 23/23, nothing skipped: upload, download, signed URL, delete, MIME, > 10 MB, OPERATOR / anon denied, own-folder path, compensation |
| "Nueva compra" without a file (ADR-010) | PASS | integration |
| Frontend unit / static gate / ADR-006 frontend contract / tsc / safe build | PASS | 211/0; 8/0; 28/0; 0 errors; 0 findings |
| Frontend integration ×3 | 2 PASS (113/113), 1 with 2 FAIL | f27h S7 + f27i FLOW G: both call `mp_claim_deliveries(50,120)` on the shared queue, so a concurrent file claims the other's delivery. A deterministic **test-isolation collision** under file parallelism; not an application defect |
| JWT `issued at future` | NOT REPRODUCED | 0 / 3 integration runs |
| instruments R7 | NOT REPRODUCED | 3 / 3 PASS |
| `dist/` regeneration | PENDING | not every mandatory item is green |

**Owner decisions needed:**
- **B-1:** a new migration (0069) that revokes EXECUTE from anon on the 6 functions. Today 0006 / 0011 revoke only PUBLIC, and 0013 removes only the table / sequence default privileges. The current Supabase image grants anon EXECUTE by default, so a fresh project would inherit the drift. Impact is low (the functions refuse without an app role), but the frozen privilege contract is broken.
- **B-2:** WSL mirrored networking (`%USERPROFILE%.wslconfig`: `[wsl2] networkingMode=mirrored`, then `wsl --shutdown`), or another accepted way for the edge runtime to reach the test MP mock.
- **B-3:** `nvm install 24` in Ubuntu.
- **K-2:** exclude lockfiles from the scan scope.
- **Integration isolation:** run f27h / f27i serially.

Feria remains PARTIAL / DEFERRED. The system is not CUTOVER_READY.

## 9e. Pre-cutover technical validation — GREEN (2026-10-01, after B-1 / B-2 / B-3 / K-2)

**Result: TECHNICAL PRE-CUTOVER GREEN. NOT CUTOVER_READY: Feria is PARTIAL / DEFERRED.**

Environment:
- Ubuntu WSL2 with mirrored networking;
- Node 24.21.0 for the suites;
- the official Supabase CLI 2.119.0 (Linux);
- frontend / tsc / build on Windows against the same Docker Desktop stack.

Fixes in this pass:
- **B-1:** migration `0069_revoke_anon_execute_early_definers.sql` revokes anon EXECUTE on the 6 early SECURITY DEFINER functions; authenticated is unchanged. Regression: `scripts/target-db/privileges_anon.test.mjs`.
- **K-2:** `mp_audit_security` excludes dependency lockfiles from the e-mail check only; the K-1 secret scan still reads every tracked file.
- **f27h / f27i:** run serially (they share the MP delivery queue claimed by `mp_claim_deliveries`); every other integration file runs in parallel.

| Item | Status | Evidence |
|---|---|---|
| Platform reset (`supabase db reset`) + `apply.mjs` 0001→0069 | PASS | ledger 69 = files (version, filename, sha256 identical); 67 SECURITY DEFINER; 33 enums; 60 tables; 15 views; 0 SECURITY DEFINER executable by anon |
| Clean-cutover contract CT-1…CT-5 | PASS | 21/0. The DB was then restored to canonical clean (69) |
| Backend suites, serial (40, including mp_audit_security / mp_scheduler / mp_webhook / mp_worker_http / privileges_anon) | PASS | all green; residue after every suite: 0 MP deliveries, 0 operations, only the seed client |
| commercial H15 / I4, mp_privileges S-1b | PASS | 147/0, 47/0 |
| mp_audit_security / mp_scheduler / mp_webhook / mp_worker_http | PASS | 66/0, 33/0, 41/0, 17/0 (edge runtime reaches the local MP mock under mirrored networking; no real MP call) |
| ADR-006 matrix | PASS | 13/0, X-1…X-7 |
| ADR-008 Storage + "Nueva compra" with / without a file | PASS | inside the integration runs, nothing skipped |
| Frontend unit / integration (×3, safe order) | PASS | 211/0; 113/113 three times |
| JWT `issued at future` | NOT REPRODUCED | 0 in 3 runs |
| instruments R7 | NOT REPRODUCED | 3/3 |
| MP test interference | RESOLVED BY ORDER | 0 with f27h / f27i serial |
| Static gate / ADR-006 frontend contract / tsc / safe build | PASS | 8/0; 28/0; 0 errors; 0 findings |
| Secret scan | PASS | the only JWT-shaped string in tracked files is an illustrative placeholder in `IMPORTADOR_MP_REPORTS.md`: ref = the fake project `abc123def`, no iat / exp, empty signature |
| PII scan | PASS | the only non-synthetic-domain matches are fake connection strings in `guard.test.mjs` |
| `dist/` | REGENERATED, scanned | built with the local target env (repository `.env*` not loaded): 0 hits for ipify, sync-mercadopago / settlement, Netlify functions, MercadoPagoDebug / useMercadoPago, mercadopago-calculations, legacy MP tables, APP_USR / sk_live / service_role / MP_ACCESS_TOKEN; only JWT = the local demo anon key. **Not deployable**: it points at the local stack. The new target project URL / anon key are set at cutover (D-PC-3) |

Feria remains PARTIAL / DEFERRED (D-PC-6). L-1 remains OPEN until the cutover removal is validated.

## 10. Decisions and findings

| Id | Item | Owner of the decision |
|---|---|---|
| **S-1** | **Security, treated as COMPROMISED.** `MercadoPagoDebug.tsx` held a hard-coded bearer token for the legacy Netlify MP sync, tracked on `origin/main` since 2026-09-03 and shipped in the production bundle; `useMercadoPago` kept a secret in `localStorage`.

**F27-A (done):**
- the literal, the debug / sync UI, the `localStorage` path, every frontend call to `sync-mercadopago` and the static `sync-settlement.html` page are removed;
- the static gate fingerprints the literal (SHA-256, the value is never stored) and detects lower-case secret assignments.

**Owner:** `SYNC_MERCADOPAGO_TOKEN` rotated in Netlify. **Rotation CONFIRMED** (owner, 2026-09-29).

S-1 is CLOSED. The separate legacy-function exposure is tracked as L-1 | owner (rotation: done); F27-A (removal: done) |
| **L-1** | **Legacy Netlify MP functions — OPEN, pending an owner decision.** Code read on 2026-09-29, read-only; nothing modified or deployed.

(a) `sync-mercadopago`:
- it only requires a non-empty `Authorization` header, never compares it with `SYNC_MERCADOPAGO_TOKEN` (it does not read it), and sends CORS `*`;
- anyone can trigger a full MP history fetch with the MP client credentials, plus a service-role upsert into `mercadopago_raw` / `sync_metadata`;
- the response exposes counts only;
- `MP_SYNC_WRITE_ENABLED` does **not** apply to it.

(b) `sync-settlement-csv`:
- **no authentication at all**; it accepts request-body CSV and upserts, by `id` (so existing rows are overwritten), into `mercadopago_raw` and `mercadopago_movements` with the service role;
- it is reachable from the upload page served by the `sync-page` function.

(c) By contrast, `sync-mercadopago-movements` and `sync-mercadopago-releases-status` validate `Bearer` exactly against `SYNC_MERCADOPAGO_TOKEN` and fail closed. `MP_SYNC_WRITE_ENABLED` gates only `sync-mercadopago-releases` (the scheduled 02:00 job, which passes `commit`) and `sync-mercadopago-releases-status`.

Deployed frontend dependency (`origin/main`): only the "Sincronizar" button of the Caja → "MP Debug" view calls `sync-mercadopago`; the `useSyncMercadoPago` hook is defined but unused. No React screen reads `mercadopago_movements`.

Not resolved until the owner chooses a mitigation (see the checkpoint report) | owner |
| **D-DEPLOY** | **Phase-27 commits must not reach production before cutover (Phase 31) or an explicit deployment decision.**
- Development continues on the local branch `phase27-frontend` (no upstream).
- Local `main` (44 commits ahead of `origin/main`, tracking it) **must not be pushed**: the Phase-27 frontend needs the target schema (`current_app_role()`), which the legacy production database lacks.
- `netlify.toml` builds `npm run build` → `dist`. The production branch is not declared in the repository (it is a Netlify site setting), so assume `main` | owner / all |

| P27-D1 | **RESOLVED (owner):** the general `arqueos_caja` screen is retired from V1 and not recreated. Feria session counts remain | owner |
| P27-D2 | **RESOLVED (owner):** "Flujo de caja" is retired. "Tendencia meses" is kept only as presentation over `pnl_summary` / `report_balance_period` values, with no new accounting or business formula | owner |
| P27-D3 | **RESOLVED (owner):** `dueño` → ADMIN; `colaborador` → OPERATOR; `repartidor` → **no application access in V1**.

The frontend role type is only `ADMIN | OPERATOR`, from `current_app_role()`. A user with no active target profile gets the "Sin acceso" screen. The legacy → target mapping is applied by the data migration, not by the frontend | owner |
| P27-D4 | **RESOLVED:** Vitest 5 (Vite 8 compatible) is the runner.
- `npm test` runs `tests/unit`.
- `npm run test:integration` runs `tests/integration` against the guarded local stack only, using the `guard.mjs` checks, the local demo keys from the running local container, and a fixed `127.0.0.1` URL.
- `vitest.config.ts` points `envDir` at an empty directory, so tests never load the repository's `.env*`.
- `scripts/regression/phase27-safe-build.mjs` builds with an empty env dir plus the local URL / anon key, and scans the bundle | technical |
| B-1 | Baseline:
- `tsc -b` = 0 errors.
- `oxlint` is blocked by Windows Application Control (an environment limitation, not weakened or replaced).
- The Supabase CLI binary is also blocked since F27-A, so the local keys are read from the running local container.
- `fast-uri` (a transitive dependency of vite-plugin-pwa → workbox-build → ajv) has a pre-existing high advisory, not addressed in Phase 27 | recorded |
| N-1 | The legacy Netlify functions (`netlify/functions/*`) and the legacy MP tables stay until cutover (Phase 31). Phase 27 removes only the frontend's dependency on them | — |

---

## 10. Phase 27 acceptance fixes (owner manual walkthrough, block 2/3)

The fixes come from owner decisions D-WALK-1…7 (2026-09-30). This is not a new phase and Phase 28 has not started.

| Id | Fix | Where |
|---|---|---|
| D-WALK-1 | The technical `COBRO-<uuid>` collection key is hidden. A receipt the user typed is still shown. No backend change. | `src/features/cobros/ListaSaldosClientes.tsx` |
| D-WALK-2 | Read-only transfer history in Caja. Origin and destination come from the operation's own postings; no balance is derived. | `src/target/treasury.ts` `listTransfers`; `ResumenSaldos.tsx` |
| D-WALK-3 | The purchase form shows by default: Proveedor, Fecha, Nº comprobante, Categoría, Total, Notas, Comprobante. "Más datos" holds the nature (default Operativa) and the net. The net equals the total unless typed. The subcategory is hidden. | `Compras.tsx` |
| D-WALK-4 | "Detalle de ítems (opcional)" is collapsed and zero lines are allowed. A purchase without items is rectified with one default line: "Compra" × 1 at the total. RPC 14 unchanged. | `Compras.tsx` |
| D-WALK-5 | Attachments are optional (ADR-010, migration 0061). With no file, `register_purchase` is called directly; with a file, the ADR-008 sequence applies. | `attachments.ts`, `Compras.tsx` |
| D-WALK-6 | Primary action "Nueva compra", secondary "Registrar flete"; "Asignar flete" sits in the purchase detail. No backend change. | `Compras.tsx` |
| D-WALK-7 | ADR-011 (migration 0062): RPC 46 `register_bank_tax`, `bank_tax_charge`, `report_bank_tax_period`. The tax is optional in the transfer form; a failure is shown as a partial success and a retry registers only the tax. The history shows the related tax; a tax can be added later. Not in the P&L. | `treasury.ts`, `ResumenSaldos.tsx` |

The ADR-008 Storage-API tests and the real-Storage "Nueva compra" end-to-end test stay **SKIPPED / PRE-CUTOVER REQUIRED** (§9b) for the with-file path.

### 10.1 Block 4 — Classification and Feed (owner D-CLS-1…5, D-FEED-1…6; 2026-10-01)

| Id | Fix | Where |
|---|---|---|
| D-CLS-1 | Lines are entered as UNIDAD or MAPLE. The backend converts to eggs (MAPLE = 20 for XL, 30 otherwise) and keeps the entry as typed (ADR-012, migration 0063). | `classification.ts`, `ClasificacionApp.tsx` |
| D-CLS-2 / 4 | Each save is an independent session. "Sesiones del día" lists them collapsed (`hh:mm · Total N huevos`); the detail shows the exact entry ("N1 — 3 maples (90 huevos)") and, if rectified, the reason and the prior versions. | `ClasificacionApp.tsx` |
| D-CLS-3 / 5 | RPC 47 `rectify_classification`: a whole-session new version with a mandatory reason; the original is kept. The daily report counts current versions only. | 0063, `ClasificacionApp.tsx` |
| D-FEED-1 / 2 | RPC 48 `publish_feed_formula_version`: atomic; the prior version closes at D − 1; one effective version per feed type (EXCLUDE). The direct INSERT path on versions and lines is removed. An empty version is not manufacturable (ADR-013, migration 0064). | 0064, `feed.ts`, `db.ts` |
| D-FEED-3 / 4 | Administración → Alimento: Tipos de alimento, Ingredientes, Fórmulas / Recetas (effective version, validity, composition, history, "Nueva versión"). | `AlimentoAdmin.tsx`, `AdminApp.tsx` |
| D-FEED-5 | Fabricación offers only the versions effective on the chosen date (`<tipo> · vN`); otherwise "No hay fórmula vigente para esta fecha. Cargala en Administración → Alimento." | `AlimentoApp.tsx` |
| D-FEED-6 | Test feed data is created manually through the UI in the local walkthrough only; no seed and no production. | — |

### 10.2 Block 4 follow-up — Manufacturing history / rectification, grade Rotos (owner D-FEED-7…9, D-CLS-6; 2026-10-01)

| Id | Fix | Where |
|---|---|---|
| D-FEED-7 | Alimento → "Fabricaciones": a read-only history with date filter. Row: `dd/mm hh:mm · tipo · vN · kg · autor`. The detail shows the exact stored version and its composition, the batch, the registration time and the author. Authors appear as email for ADMIN and as "Vos" / "Otro usuario" for OPERATOR. | `FabricacionesHistorial.tsx`, `feed.ts` |
| D-FEED-8 | RPC 49 `rectify_feed_manufacturing`: a whole-record new version with a mandatory reason; the original is kept. ADMIN can rectify any record, OPERATOR only its own chain. The consumption report counts current versions only, and no compensating movement is generated (ADR-014, migration 0065). | 0065 |
| D-FEED-9 | "Rectificar" appears on current rows when allowed. A row shows "Rectificada", and the detail shows the prior versions and the reason. | `FabricacionesHistorial.tsx` |
| D-CLS-6 | Classification grade Rotos is inactive for new entries (merged forward into Descarte); history is unchanged. The Production metric "Rotos" is untouched. | 0065 |
| — | Two OPERATOR read gaps found during implementation and closed. 0066 lets OPERATOR read inactive grade names for history. 0067 lets OPERATOR read historical formula versions (no cost). Both are ADR-014 §1 / §3. | 0066, 0067 |

### 10.3 Feria — FERIA LOGIC REVIEW — DEFERRED / STANDBY (owner, 2026-10-01)

Feria manual acceptance is **PARTIAL / DEFERRED**: the session-cash model and the movement history need an owner-approved redesign. This does not block the walkthrough of the other modules, which continue to be validated independently. The current Feria implementation stays unchanged (no backend, frontend, accounting or migration change) until the owner resumes the topic.

Deferred findings:
1. **Movement history:** session movements are not visibly traceable. A history is needed of dispatches / deliveries, expenses, withdrawals, session movements and closing movements, visible while the session is open and after it closes.
2. **Expenses:** Feria expenses currently ask for a general financial account. Owner model: they reduce the cash held inside the Feria session.
3. **Withdrawals:** same issue. A withdrawal is a movement of the Feria session cash, not an ordinary treasury movement.
4. **Closing:** Feria keeps its own temporary session cash (cash sales increase it; expenses and withdrawals reduce it). At closing the session is reconciled and its net cash determined, and only then is the amount registered into Caja Chica or another destination account. The accounting implementation is not decided.

### 10.4 Fiscal + Finance (owner D-FISCAL-1…8, D-FIN-1…2; 2026-10-01; ADR-015)

| Id | Fix | Where |
|---|---|---|
| D-FISCAL-1 / 7 | Fiscal is report-first: Resumen fiscal (IVA débito / crédito / "Diferencia del período"; other tax kinds as loaded), Obligaciones, Pagos, Comprobantes. "Registrar comprobante manual" is a secondary link. | `FiscalApp.tsx`, `fiscal.ts` |
| D-FISCAL-2 / 3 | `report_fiscal_period` (ADMIN): by document direction; credit notes reversed; the difference is informational, with no carry-forward and no P&L effect (migration 0068). | 0068 |
| D-FISCAL-4 / 5 | Nueva compra → "Datos fiscales (opcional)": type, period, net, total, components (typed, never derived). With data, RPC 50 saves the purchase and its document atomically; without data, RPC 13 as before. | `Compras.tsx`, `treasury.ts`, `attachments.ts`, 0068 |
| D-FISCAL-6 | **Deferred:** the sales (pedido) ↔ fiscal document link, pending the invoicing lifecycle definition. Sales documents are registered manually in Fiscal meanwhile. | — |
| D-FISCAL-8 | Future document recognition: schema compatible, not implemented (ADR-015 §5). | — |
| D-FIN-1 | "Retiro de socios" lives in Caja → Más acciones; the ADR-004 P&L treatment is unchanged. | `CajaApp.tsx`, `EventoGestionModal.tsx` |
| D-FIN-2 | "Reserva interna" lives in Finanzas → Más acciones; backend and P&L line unchanged. | `FinanzasApp.tsx` |

### 10.5 Manual acceptance walkthrough — CLOSED (owner, 2026-10-01)

| Block | Result |
|---|---|
| 1 — Administration / masters | PASS |
| 2 — Orders / delivery / collections | PASS |
| 3 — Treasury / purchases / transfers / freight | PASS |
| 4 — Production / Classification / Feed | PASS |
| Fiscal | PASS |
| Finance | PASS |
| Mercado Pago | PASS FUNCTIONAL — future UX simplification: reduce technical density, prioritize actionable states, move IDs / technical diagnostics into expandable details |
| Feria | **PARTIAL / DEFERRED** (§10.3): the session-cash model and the movement history need an owner-approved redesign. Not accepted. → Superseded by §10.6 (ADR-016 implemented; pending the owner's manual acceptance). |

The local walkthrough dataset was removed with a narrow, explicit cleanup in one transaction (no `db reset`, no production):
- the `admin.walkthrough` profile and auth user;
- the business rows it created or that hang from its masters: order, collection, client ledger, transfer, production, mortality, flock and shed, classification sessions, feed type / ingredient / formula / manufacturing, the Feria session, prices / product / client / supplier / category, and its audit rows;
- the synthetic MP fixture (`node scripts/walkthrough/mp-walkthrough-fixture.mjs cleanup`).

After the cleanup, the previously contaminated checks pass: commercial J3; foundations profiles and flocks.

The pre-cutover checklist (§9b) is **not** complete: the canonical `supabase db reset` rehearsal, cutover, deploy and production artifacts have not been run.

### 10.6 Feria V1 — summarized closing (owner D-FER-1…5; 2026-10-01; ADR-016) — IMPLEMENTED, PENDING OWNER MANUAL ACCEPTANCE

This replaces the §10.3 standby. The worksheet is the detailed record; the app keeps one summarized closing per Feria.

**Backend (migration `0070_feria_summary_closing.sql`):**
- `sales_session_closing`, versioned;
- `products.is_system` with the system product "Venta Feria (resumen)";
- the category "Gastos de Feria";
- RPC 51 `close_feria_summary` and RPC 52 `rectify_feria_closing`;
- `report_feria_closing`;
- P&L: "Gastos de Feria" and the new line "Diferencia de caja" (`pnl_summary.diferencia_caja`);
- private bucket `feria-worksheets`.

**Inventory after 0070:**

| Item | Count |
|---|---|
| Ledger | 70 |
| SECURITY DEFINER | 69 |
| Tables | 61 |
| Views | 16 |
| RPC_CONTRACTS | 52 |

**Frontend:**
- "Cierre de Feria" form (main fields, "Más datos", planilla);
- backend-returned total / expected / difference;
- history with versions and rectification;
- open sessions closable;
- detailed-mode sessions read-only.

The granular actions and the product-line closing form are not offered. The system product is hidden from product lists.

**Not CUTOVER_READY** until the owner manually accepts the new Feria flow.

**Validation (2026-10-01, canonical WSL stack: `supabase db reset` + `apply.mjs` 0001→0070):**

| Check | Result |
|---|---|
| Ledger / checksum | 70 = files; version / filename / sha256 IDENTICAL; definers 69, enums 33, tables 61, views 16, anon-executable definers 0 |
| Clean-cutover CT-1…CT-5 | 21/0. The current-target validator excludes the two 0070 reference rows ("Venta Feria (resumen)", "Gastos de Feria"), following the CONSUMIDOR FINAL precedent; the derivation transform records it. |
| Backend suites | every suite PASS, including `feria_summary` 45/0, `feria` 146/0 and `mp_webhook` 41/0 / `mp_audit_security` 66/0, **except `mp_worker_http` and `mp_scheduler`** (see below) |
| ADR-006 matrix | 13/0 |
| Frontend unit / integration | 228/0 / 119/119 (14 files, including `adr016-feria` against the real Storage API) |
| Static gate / ADR-006 frontend contract / tsc / build | 8/0 / 28/0 / 0 errors / OK |
| Secret / PII scan of new files | clean (only `@example.invalid`) |

**OPEN (environment):** `mp_worker_http` and `mp_scheduler` fail on this run.
- The mock MP host is not reached from the edge runtime: E-2 records no call; the results show `FAILED_RETRYABLE` / `auth_circuit`.
- The failing checks changed between three runs (8 → 5 and 5 → 7, different ids).
- Neither suite touches Feria.
- They were 17/17 and 33/33 at the §9e GREEN record. They must be re-run green once edge→host networking is stable, before any GREEN claim.
