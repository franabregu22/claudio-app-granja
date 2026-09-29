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
| F27-B…F27-I | pending | — |

## 10. Decisions and findings

| Id | Item | Owner of the decision |
|---|---|---|
| **S-1** | **Security, treated as COMPROMISED.** `MercadoPagoDebug.tsx` held a hard-coded bearer token for the legacy Netlify MP sync, tracked on `origin/main` since 2026-09-03 and shipped in the production bundle; `useMercadoPago` kept a secret in `localStorage`.

**F27-A (done):**
- the literal, the debug / sync UI, the `localStorage` path, every frontend call to `sync-mercadopago` and the static `sync-settlement.html` page are removed;
- the static gate fingerprints the literal (SHA-256, the value is never stored) and detects lower-case secret assignments.

**Owner (open):** rotate the Netlify environment variable **`SYNC_MERCADOPAGO_TOKEN`**. Also, the legacy function `sync-mercadopago` does not validate the header value at all (any non-empty `Authorization` is accepted), so the owner should disable or protect it in Netlify. It stays until cutover (N-1) and is not modified in Phase 27.

**Rotation confirmed:** no | owner (rotation / function access); F27-A (removal: done) |
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
