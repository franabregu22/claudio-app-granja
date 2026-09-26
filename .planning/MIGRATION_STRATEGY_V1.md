# MIGRATION STRATEGY V1

**PHASE:** 11 — Migration Strategy (per `MASTER_ROADMAP.md`)  
**STATUS:** Design only. No migration executed, no SQL run, no Supabase change, no data moved.  
**AUTHORITIES:** `TARGET_ARCHITECTURE_V2_FROZEN.md` · the five FROZEN documents of `implementation-design/` · `MASTER_ROADMAP.md` · the real current schema and data observed in this repository.

Historical reports were read as context only. Where `CURRENT_TARGET_CROSSWALK_V2.md` disagrees with what this repository actually contains, the repository wins; two such corrections are recorded in §3.

---

## 1. Scope and non-goals

### In scope

Deciding, per target entity: what is migrated, what is not, from which date, from which source, with what confidence, what is reconstructed, what enters as an opening balance, what is kept only as evidence, how lineage is preserved, and how the migration will later be validated.

### Non-goals

- No migration is executed. No SQL is run. Supabase is untouched. No data is moved or transformed.
- No values are produced: no balance, no opening position, no count is stated as a figure anywhere in this document.
- No FROZEN document is modified. No architecture, business rule, permission or data authority is changed.
- No table is added to the target schema. Where migration tooling needs its own storage, it is specified as **external tooling**, not as new production architecture (§12).
- Data profiling is not performed here. This phase names what must be profiled and when (§13, Phase 12).

### Hard boundary on confidence

The live database was not queried: the Supabase connector is unauthenticated in this session, and touching it is outside this phase regardless. Therefore **no row-level data quality claim is made about any live table**. Every live source carries `REQUIRES DATA PROFILING`. Only local files in `data/` and `supabase/migrations/` were read directly, and only their structure and row counts are asserted.

Structure available ≠ data reliable. That distinction is held throughout.

---

## 2. Migration principles

1. **Useful history starts 2026-01-01.** Nothing before it becomes a target fact. Earlier data may survive as legacy evidence only.
2. **Never invent traceability the old system does not have.** If a legacy row cannot demonstrate a link, the link is not created.
3. **No reconstruction without evidence.** "Reconstruct" is not a method. A derived fact is only migrated when the source rows can demonstrate it; otherwise the position enters as a validated opening balance.
4. **Opening balance over fabricated history.** When history cannot demonstrate a real balance, a single validated opening position is used and the history stays evidence.
5. **No silent reconciliation.** Every difference between source and target is explained and recorded. A difference that cannot be explained blocks cutover.
6. **Lineage on every migrated row.** A migrated fact always records where it came from, so the migration can be repeated and audited.
7. **Idempotent by construction.** Re-running the migration in a test environment must not duplicate anything.
8. **The old P&L is not an authority.** Results are derived in the target from ledgers and postings; no legacy result figure is imported or used to validate one.
9. **Hard cut.** After cutover the previous system is read-only. No dual-write, no partial operation across both systems.
10. **Period integrity applies to the migration too.** Every migrated fact carries the business date its frozen determinant requires, and lands in the period that date implies. `created_at` never determines a migrated fact's period.
11. **Observed is not calculated.** A measured value and a computed value never share a column. Feed makes this explicit (§10).

---

## 3. Source inventory

### 3.1 Live operational tables (created directly in Supabase, **not** versioned in this repository)

`supabase/migrations/` contains 12 migrations and they are **all MercadoPago**. None of the operational tables appear there. Their DDL is not in the repo; their existence and shape were established from `src/api/*`, `src/features/*` and `src/types/domain.ts`.

**Consequence for migration:** the authoritative DDL of the operational legacy schema exists only in the live database. Extracting it is a Phase 12 prerequisite — the schema must be dumped and profiled before any mapping is finalised.

| Source | Type | Entities | Observable window | Known quality | Identifiers | Limitations |
|---|---|---|---|---|---|---|
| `perfiles` | live table | users, roles | unknown | REQUIRES DATA PROFILING | `id` (UUID, = auth user) | legacy `Rol` = `dueño` \| `repartidor` \| `colaborador` (3 values) vs target 2; column `creado_en` not `created_at` |
| `clientes` | live table | clients | unknown | REQUIRES DATA PROFILING | `id` (UUID) | `ClienteCategoria` includes `feria municipal`; no fiscal id observed in the type |
| `productos` | live table | products | unknown | REQUIRES DATA PROFILING | `id` | `ProductoCategoria` = `huevos\|cereales\|alimento\|subproducto\|otro`; no VENDIBLE/INPUT/BOTH distinction |
| `precios_historial` | live table | price history | unknown | REQUIRES DATA PROFILING | `id` | pattern matches target intent |
| `precios_actuales` | live table | current prices | unknown | REQUIRES DATA PROFILING | `id` | derived/current view of the above; not an independent authority |
| `pedidos` | live table | orders | unknown | REQUIRES DATA PROFILING | `id` (**integer**) | stores `monto_total` (target forbids); `estado` = `pendiente\|entregado\|cancelado`; `rectificado` boolean with **no prior-version history**; both `fecha_pedido` (legacy) and `fecha_operacion`; `entregado_por` present |
| `pedido_lineas` | live table | order lines | unknown | REQUIRES DATA PROFILING | `id` | **three historical shapes coexist**: this table, `pedidos.lineas` as a `Lineas` object (old), and `pedidos.lineas` as a `LineaPedido[]` array; also `precios_snapshot` and `lineas_generic` |
| `pagos` | live table | collections | unknown | REQUIRES DATA PROFILING | `id` (UUID), `cliente_id` | `MetodoPago` = `efectivo\|transferencia\|tarjeta\|mercadopago\|otro\|cheque\|echeq` (7 values) vs target 4; no receipt id |
| `pago_en_caja` | live table | payment↔cash link | unknown | REQUIRES DATA PROFILING | `id`, `pago_id` | links a payment to its cash register entry |
| `movimientos_caja` | live table | cash movements, expenses | unknown | REQUIRES DATA PROFILING | `id` (**integer**) | `forma_pago` = `efectivo\|mercadopago\|transferencia` (**no cheque**); `cuenta_origen`/`cuenta_destino` are **text, not FKs**; `naturaleza_gasto` has 5 values incl. `distribucion_ganancias` and `ajuste_contable` which are **not** purchases; `impuesto_cheque` column |
| `cuentas_caja` | live table | financial accounts | unknown | REQUIRES DATA PROFILING | `id` (UUID) | `TipoCuenta` = `efectivo\|digital` (2) vs target 3 account types |
| `arqueos_caja` | live table | cash counts | unknown | REQUIRES DATA PROFILING | `id` | observation records |
| `categorias_finanzas` | live table | expense categories | unknown | REQUIRES DATA PROFILING | `id` | analog of target `expense_category` |
| `cheques` | live table | cheques | unknown | REQUIRES DATA PROFILING | `id` (**integer**), `numero` | **no direction column**; `ChequeEstado` = `emitido\|cobrado\|rechazado\|cancelado` (4) vs target 8 across two directions; **`girador` is free text**, there is no client or supplier FK; `movimiento_caja_id` optional |
| `comisiones` | live table | fees | unknown | REQUIRES DATA PROFILING | `id`, `movimiento_caja_id` | `concepto`, `monto`, `porcentaje`, `base_monto` |
| `facturas` | live table | invoices | unknown | REQUIRES DATA PROFILING | unknown | **used by the app but has no type definition** in `src/types/domain.ts`; structure unknown |
| `lotes` | live table | flocks | unknown | REQUIRES DATA PROFILING | `id` (UUID), `lote_id` (optional business code) | `galpon` is **text**, not an FK; `aves_iniciales_postura`; `LoteEstado` = `Activo\|Retirado\|Planificado` (3) vs target 3 but different names |
| `producciones` | live table | daily production + mortality | unknown | REQUIRES DATA PROFILING | `id` (UUID) | keyed by `fecha` + `galpon`, `lote_id` **optional**; split columns `huevos_totales_mediodia/tarde`, `huevos_cachados_mediodia/tarde`; carries `mortandad` embedded; **no dirty-egg column** |
| `recuentos_lote` | live table | flock recounts | unknown | REQUIRES DATA PROFILING | `id`, `lote_id` | `aves_contadas`, `mortandad_esperada`, `diferencia` |

### 3.2 MercadoPago tables (versioned in `supabase/migrations/`, 12 files)

`mercadopago_raw`, `mercadopago_movements`, `mercadopago_settlement`, `mp_source_record`, `mp_financial_movement`, `mp_financial_cycle`, `mp_import_exception`, `mp_movement_source_link`, `mp_source_link_resolution`, `ledger_entry`, `account_balance`, `monthly_reconciliation`, `reconciliation_snapshot`, `period_flow_observation`, `import_period_coverage`, `sync_metadata`.

| Property | Observation |
|---|---|
| Window | Migrations and import scripts reference Feb–Sep 2026; `import_period_coverage` exists to record coverage explicitly |
| Quality | REQUIRES DATA PROFILING for row content; structure is versioned and readable |
| Identifiers | `SOURCE_ID` from MP, plus a `fingerprint` column added in migration `010` |
| Limitations | `ledger_entry` and `account_balance` are legacy MP-local constructs; frozen Part 26 rejects MP `ledger_entry` as a general ledger |

### 3.3 Local files (read directly; structure and row counts asserted)

| File | Rows of data | Header | Use |
|---|---|---|---|
| `data/clientes.csv` | 10 | `nombre,activo` | client seed, names only |
| `data/precios.csv` | 5 | `categoria,precio` | price seed by category |
| `data/mercadopago/Liberaciones1.csv` | 1 645 | `DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;MP_FEE_AMOUNT;TAXES_AMOUNT;PAYMENT_METHOD;TRANSACTION_APPROVAL_DATE;BUSINESS_UNIT;SUB…` | MP settlement source, gross/fee/tax/net preserved |
| `data/mercadopago/BASECSV.csv` | 8 582 | `Fecha de Pago,Tipo de Operación,Número de Movimiento,Operación Relacionada,Importe` | MP movement source |
| `data/mercadopago/Liberaciones2.csv`, `Liberaciones3.csv`, `Liberaciones3_julio_2026.csv`, `Liberaciones3_agosto_2026.csv`, `arch1–arch5.csv`, `data11sept-23-sept.csv`, `Reporte_movimientos…2026-09-04.csv` | not counted individually | MP exports | same family; per-file coverage must be established during profiling |
| `scripts/import_prep_feb_jun_2026/LIBERACIONES_{FEB,MAR,APR,MAY,JUN}_2026_IMPORT.csv` | not counted individually | prepared monthly MP imports | evidence that Feb–Jun 2026 was prepared for import |

`Liberaciones*.csv` is semicolon-delimited and preserves gross, MP fee, taxes and net separately — which is what frozen Part 22 requires be preserved.

### 3.4 Documentation sources (context, not target authority)

`.planning/codebase/` (`ARCHITECTURE.md`, `STRUCTURE.md`, `CONVENTIONS.md`, `INTEGRATIONS.md`, `CONCERNS.md`, `TESTING.md`, `STACK.md`), `.planning/physical-design/CURRENT_TARGET_CROSSWALK_V2.md`, `.planning/physical-design/MIGRATION_RISK_REGISTER_V1.md` (4 open risks), plus the MP analysis documents at repository root.

### 3.5 Two corrections to `CURRENT_TARGET_CROSSWALK_V2.md`

Recorded because the crosswalk is widely referenced and both errors would change a migration method:

1. It states `financial_account` ← *"NONE (hardcoded)"*. **`cuentas_caja` exists** as a live table with `id, nombre, tipo, descripcion, activa`. `financial_account` therefore has a real legacy source.
2. It states `pedido_lineas` ← *"pedidos.lineas (JSONB)"*. A real **`pedido_lineas` table exists** and is used by `src/api/pedidos.ts`. The JSONB forms also exist as older shapes. The true situation is three coexisting shapes, not one.

Neither correction changes the target. Both change how the source must be read.

---

## 4. Evidence hierarchy

There is no single global hierarchy, because authority genuinely differs by domain. The general ordering from frozen Part 23 applies, and each domain then names its own winner.

**General ordering (frozen Part 23):** external trusted evidence → verifiable physical count or balance → balance validated by the owner → reliable legacy data → calculation reconstructed from evidence → unknown.

| Domain | Authority when sources conflict | Reason |
|---|---|---|
| Financial account balances | Real-world balance validated by the owner at the zero point | Frozen rule 6; a legacy figure never overrides reality |
| MercadoPago | MP's own export files (`Liberaciones*`, `BASECSV`) over any derived MP table | The export is external trusted evidence; `ledger_entry`/`account_balance` are internal derivations |
| Client current account | Owner-validated opening balance, unless profiling proves `pagos` + `pedidos` demonstrate the real balance | Frozen rule 3 and 4 |
| Supplier current account | Owner-validated opening balance | No legacy source exists at all |
| Open instruments | The physical instrument and its real current situation | Legacy `cheques.estado` has 4 values and no direction; reality decides |
| Flock population | Physical count (`recuentos_lote.aves_contadas`) over any computed figure | A count is direct observation |
| Production | `producciones` rows as recorded | Operational measurement, no better source exists |
| Prices used on an order | The order's own price snapshot over any price master | Frozen Part 3 and Part 24 |
| Feed | Observed count or purchase document over any calculated figure | §10 keeps observed and calculated apart |
| Results / P&L | Never a source | Frozen rule 11: derived only |

When two sources disagree and neither is authoritative, the fact is not migrated: it becomes a recorded gap (§15), never an averaged or guessed value.

---

## 5. Entity migration matrix

Methods: **A DIRECT** · **B TRANSFORM** · **C OPENING_BALANCE** · **D CURRENT_STATE** · **E HISTORICAL_EVIDENCE_ONLY** · **F DO_NOT_MIGRATE** · **NEW** (no legacy source; created in the target, not migrated).

Window `2026-01-01→cutover` is shortened to **2026+**. Confidence `RDP` = REQUIRES DATA PROFILING.

| Target | Source | Window | Method | Confidence | Lineage | Validation | Gap |
|---|---|---|---|---|---|---|---|
| `perfiles` | `perfiles` | current | **D CURRENT_STATE** | RDP | keep `id` (= `auth.uid()`), so no remap | every active user resolves to exactly one `rol_type`; `current_app_role()` returns a role for each | 3 legacy roles → 2 target roles; per-user mapping needs owner confirmation |
| `clients` | `clientes` + `data/clientes.csv` | current | **D CURRENT_STATE** | RDP (CSV: 10 rows, names only) | `source_system='legacy'`, `source_id=clientes.id` | count matches active legacy clients; a `CONSUMIDOR FINAL` row exists for feria | no `fiscal_id` observed; `categoria='feria municipal'` has no target column and is not migrated as such |
| `products` | `productos` + `data/precios.csv` | current | **B TRANSFORM** | RDP | `source_id=productos.id` | every product has a `product_type`; every order line's product resolves | `ProductoCategoria` (5 values) does not carry VENDIBLE/INPUT/BOTH; assignment is a mapping rule, not data |
| `price_history` | `precios_historial` | 2026+ | **A DIRECT** | RDP | `source_id` | at most one open row per (product, list); no overlapping ranges | `precios_actuales` is derived and is **F DO_NOT_MIGRATE** |
| `suppliers` | — | — | **NEW** | n/a | none | master exists before any purchase is migrated | no legacy supplier master; created from purchase evidence and owner input |
| `financial_account` | `cuentas_caja` | current | **B TRANSFORM** | RDP | `source_id=cuentas_caja.id` | the four frozen accounts exist (Caja chica, Mercado Pago, BNA, Patagonia) | legacy `tipo` has 2 values vs 3 target `account_type`; mapping rule required |
| `expense_category` | `categorias_finanzas` | current | **B TRANSFORM** | RDP | `source_id` | every migrated purchase resolves a category | legacy `categoria`/`subcategoria`/`categoria_tecnica`/`categoria_analisis` on `movimientos_caja` are free-form; consolidation rule required |
| `projects` | — | — | **NEW** | n/a | none | optional dimension; empty is valid | no legacy source |
| `sheds` | distinct `lotes.galpon` and `producciones.galpon` (text) | current | **B TRANSFORM** | RDP | record the originating text value as `source_id` | every `flocks.shed_id` and `temperature_record.shed_id` resolves | `galpon` is free text with known tilde variants (`NORMALIZACION_GALPON_TILDE.sql`); normalisation must be deterministic and recorded |
| `flocks` | `lotes` | 2026+ and any still ACTIVE | **B TRANSFORM** | RDP | `source_id=lotes.id`, keep `lote_id` business code | one ACTIVE flock per shed holds; `initial_population` present for every flock | `LoteEstado='Planificado'` has no target state; `genetics_line`, `birth_date`, `supplier_id`, `purchase_id` mostly unavailable |
| `operator_assignments` | — | — | **NEW** | n/a | none | every OPERATOR who must record production has an assignment | no legacy authorization matrix; without it operators cannot write |
| `pedidos` | `pedidos` | 2026+ | **B TRANSFORM** | RDP | `source_id=pedidos.id` (**integer → UUID remap required**) | DELIVERED count and totals match legacy for the window; every pending order carried over | `monto_total` must be dropped (target derives it) and must **reconcile** with line sums before it is dropped; `rectificado=true` orders have **no prior version** recoverable |
| `pedido_lineas` | `pedido_lineas` table + `pedidos.lineas` object + `pedidos.lineas` array | 2026+ | **B TRANSFORM** | RDP | `source_id` + which of the three shapes it came from | `SUM(subtotal)` per order equals legacy `monto_total`, or the difference is explained | three coexisting shapes; all migrate as `version_seq=0, is_current=true`; `precio_unitario` and `producto_nombre` must come from the order's own snapshot, never from a price master |
| `client_ledger` | `pagos` + `pedidos`, or owner-validated position | see §6 | **C OPENING_BALANCE**, optionally + **B TRANSFORM** | RDP | opening row flagged as such; movements carry their source | per client: `SUM(signed_amount)` equals the validated balance | conditional on profiling — see Owner Decision OD-2; frozen rule 3 forbids reconstructing from orders that cannot demonstrate the balance |
| `collections` | `pagos` (+ `pago_en_caja`) | 2026+ | **B TRANSFORM** | RDP | `source_id=pagos.id` | count and sum per client per month match legacy | no `receipt_id` in legacy → a deterministic one must be derived from `source_id` (idempotency key, §12); `metodo_pago` has 7 values vs 4, and `cheque`/`echeq` payments must route to `financial_instrument`, not `collections` (schema CHECK forbids it) |
| `financial_operation` | `movimientos_caja` + `comisiones` | 2026+ | **B TRANSFORM** | RDP | `source_id` + source table name | every posting has a parent; fees are separate operations | legacy `cuenta_origen`/`cuenta_destino` are **text**, so account resolution may fail per row; `forma_pago` lacks `cheque` although `cheques.movimiento_caja_id` exists |
| `financial_posting` | derived from `movimientos_caja` | 2026+ | **B TRANSFORM** | RDP | inherits the operation's lineage | account balance equals the sum of postings, and matches the owner-validated real balance | transfers must produce exactly two opposite postings; legacy text accounts make this per-row verifiable only after profiling |
| `financial_instrument` | `cheques` | open at cutover; 2026+ if closed and reliable | **D CURRENT_STATE** | RDP | `source_id=cheques.id` (**integer → UUID remap**) | every open instrument matches the physical instrument | **no direction column**; `girador` is free text with no client/supplier FK; target CHECKs require `cliente_id` for RECEIVED and `supplier_id` + `bank_account_id` for ISSUED — see Owner Decision OD-3 |
| `financial_instrument_event` | `cheques.estado` + `fecha_emision`/`fecha_vencimiento` | only events actually evidenced | **D CURRENT_STATE** | RDP | inherits the instrument's lineage | event count never exceeds what evidence supports | a full lifecycle must **not** be fabricated; see §7 |
| `purchases` | `movimientos_caja` where `tipo='egreso'` **and the row clears the G-4 evidence threshold** | 2026+ | **B TRANSFORM** (rows clearing the threshold) · **E HISTORICAL_EVIDENCE_ONLY** (rows that do not) | RDP | `source_id=movimientos_caja.id` | every migrated row has a determinable `supplier_id`, `economic_date`, `amount_net`, `amount_total`, `expense_category_id` and `nature`; **no `supplier_ledger` PURCHASE movement is written for migrated history** — the supplier position comes from the opening balance (V-4) | `supplier_id` is NOT NULL in the target, so a row with no determinable supplier **cannot** become a purchase; `naturaleza_gasto` values `distribucion_ganancias` and `ajuste_contable` are not purchases (G-9); no supplier, invoice or attachment is ever invented — see **G-4 in full** |
| `purchase_line` | `movimientos_caja.concepto` of the migrated purchase | 2026+ | **B TRANSFORM** — derived technical representation | RDP | `source_id` = the **same** `movimientos_caja.id` as its parent purchase, flagged as a derived single-line | exactly one line per migrated historical purchase; `subtotal` equals the parent's `amount_total` | legacy expenses have **no line detail**: `cantidad`, `unit_type` and `precio_unitario` are structural placeholders required by NOT NULL, **not observed data** — see the purchase_line rule in §15 |
| `purchase_attachment` | — | — | **NEW** | n/a | none | every purchase created after cutover has one | migrated historical purchases cannot satisfy the attachment rule — see Gap G-4 |
| `supplier_ledger` | — | see §6 | **C OPENING_BALANCE** | n/a | opening row flagged | per supplier: sum equals the validated position | no legacy supplier account exists in any form |
| `freight` | — (`flete` appears once in code, no table) | — | **NEW** | n/a | none | empty is valid at cutover | no legacy freight entity |
| `freight_allocation` | — | — | **NEW** | n/a | none | empty is valid at cutover | none |
| `population_events` | `producciones.mortandad` (MORTALITY) + `recuentos_lote` (COUNT_ADJUSTMENT) | 2026+ | **B TRANSFORM** | RDP | `source_id` + source table | derived population equals `recuentos_lote.aves_contadas` at each count date, or the difference is explained | mortality appears in **two** sources — Risk 2 of the register and Owner Decision OD-1; at most one current MORTALITY per (flock, date) must hold after transformation |
| `daily_production` | `producciones` | 2026+ | **B TRANSFORM** | RDP | `source_id=producciones.id` | per flock per month, egg totals match legacy sums | `eggs_total` = mediodía + tarde totals; `eggs_broken` = cachados sums; **`eggs_dirty` has no legacy source** and stays 0 rather than invented; `lote_id` is optional, so rows without a flock cannot be migrated as-is |
| `flock_weighing` | — | — | **NEW** | n/a | none | empty is valid at cutover | no legacy weighings (`pesaje` appears nowhere) |
| `temperature_record` | — | — | **NEW** | n/a | none | empty is valid at cutover | no legacy temperature records |
| `classification` | — | — | **NEW** | n/a | none | empty is valid at cutover | no legacy classification sessions; legacy `Categoria` (xl/n1/n2/n3/docena) is a **price/product** category, not a grading session, and must not be converted into one |
| `classification_line` | — | — | **NEW** | n/a | none | empty is valid at cutover | as above; frozen rule 8 requires "sin dato" rather than fabricated flock↔classification correspondence |
| `classification_grade` | legacy `Categoria` values, extended | current | **B TRANSFORM** | RDP | none needed (master) | the seven frozen grades exist | legacy has 5 sale categories; target adds Rotos, Sucios, Descarte |
| `feed_type`, `feed_ingredient` | `productos` where `categoria='alimento'`; feed/price spreadsheets if produced | current | **B TRANSFORM** | RDP | `source_id=productos.id` where applicable | every formula and manufacturing row resolves its type and ingredients | no feed master exists; spreadsheets named in frozen rule 10 were not found in the repository and must be supplied to be used |
| `feed_formula_version`, `feed_formula_line` | spreadsheets if supplied | as evidenced | **B TRANSFORM** else **NEW** | UNKNOWN — source not present in repo | `source_id` = sheet and row reference | a version exists for every migrated manufacturing row | `unit_cost_snapshot` requires a historical ingredient cost that only a purchase document or dated sheet can evidence |
| `feed_manufacturing`, `feed_movement`, `feed_inventory_count` | spreadsheets if supplied | 2026+ if evidenced | **B TRANSFORM** else **NEW** | UNKNOWN — source not present in repo | `source_id` = sheet and row reference | stock equation closes per period, or the difference is explained | if no dated evidence exists, these start empty; consumo interno is **derived**, never imported |
| `genetics_consumption_curve` | breeder/genetics reference if supplied | n/a | **NEW** | n/a | none | present before consumo teórico is reported | reference data, not history |
| `sales_session` + movements + cash events (feria) | `clientes.categoria='feria municipal'` only | — | **NEW** | n/a | none | empty is valid at cutover | legacy has no sessions, no dispatch/return/loss records and no session cash management; only a client tag exists, which is not a session |
| `fiscal_document`, `fiscal_document_component`, `fiscal_obligation`, `fiscal_obligation_installment`, `fiscal_payment` | `facturas` | to be determined after profiling | **E HISTORICAL_EVIDENCE_ONLY** pending profiling | UNKNOWN — table used by the app but has **no type definition**; structure unknown | `source_id=facturas.id` if adopted | tax components never duplicate an economic operation | until `facturas` is profiled, no fiscal fact is migrated; frozen Part 18 forbids hardcoded rates, so any migrated component must carry the rate actually used |
| `mp_source_record` | `mercadopago_raw`, `mp_source_record`, and the `Liberaciones*`/`BASECSV` exports | 2026+ | **A DIRECT** | RDP for tables; structure verified for files | `source_type`, MP `SOURCE_ID` as `external_id`, `fingerprint` from migration 010 | count per month matches `import_period_coverage`; raw columns immutable after load | see §8 |
| `mp_financial_movement` | `mp_financial_movement`, `mercadopago_movements`, `mercadopago_settlement` | 2026+ | **B TRANSFORM** | RDP | `mp_source_record_id` | gross − fee − tax = net per movement | legacy splits differ across three tables; normalisation rule required |
| `mp_reconciliation` | `mp_movement_source_link`, `mp_source_link_resolution`, `monthly_reconciliation`, `reconciliation_snapshot` | 2026+ where a real assignment exists | **B TRANSFORM** | RDP | movement id + operation id | assigned amounts never exceed the movement net; unreconciled is a valid state | no correspondence may be invented; frozen Part 22 |
| `ledger_entry`, `account_balance` (legacy MP) | live MP tables | historical | **E HISTORICAL_EVIDENCE_ONLY** | RDP | kept read-only in the old system | not loaded into the target | frozen Part 26 rejects MP `ledger_entry` as a general ledger |
| `mp_financial_cycle`, `mp_import_exception`, `period_flow_observation`, `import_period_coverage`, `sync_metadata`, `mercadopago_settlement` | live MP tables | historical | **E HISTORICAL_EVIDENCE_ONLY** | RDP | kept read-only | used to prove coverage during validation, not migrated as facts | tooling and bookkeeping of the old importer |
| `management_period` | — | — | **NEW** | n/a | none | a period row exists for every month that will receive a migrated fact | `ASSERT_PERIOD_OPEN` raises `PERIOD_NOT_FOUND` if missing — periods must be created **and left OPEN** during migration, then closed afterwards |
| `audit_events` | legacy `creado_por` / `creado_en` / `actualizado_en` columns | 2026+ | **B TRANSFORM**, minimal | RDP | source table and row id | every migrated fact is attributable | legacy has no before/after values; migration writes one creation-attribution event per migrated fact and **does not fabricate** change history |
| legacy `pedidos.monto_total` | `pedidos` | — | **F DO_NOT_MIGRATE** | n/a | — | used only to reconcile line sums, then dropped | target derives the total; keeping it would violate single source of truth |
| legacy P&L figures and reports | any | — | **F DO_NOT_MIGRATE** | n/a | — | never used to validate a target result | frozen rule 11 |
| data before 2026-01-01 | any | pre-2026 | **F DO_NOT_MIGRATE** / **E** | n/a | stays in the read-only old system | not loaded | frozen rule 1 |

---

## 6. Opening balances

An opening balance is a single validated position that replaces history which cannot demonstrate a real balance. It is a **mechanism**, defined here; **no value is produced in this phase**.

### Common rules

| Aspect | Rule |
|---|---|
| Opening date | One single zero point, the cutover date. Every opening row carries that date as its business date, and it must fall in an OPEN period. |
| Representation | An ordinary ledger row using the frozen movement type `OPENING_BALANCE` (`client_ledger_movement_type` and `supplier_ledger_movement_type` both define it). No new table, no new column. |
| Financial accounts | There is no `OPENING_BALANCE` posting type; an opening account position is one `financial_operation` of type `ADJUSTMENT` with one posting per account, flagged by its lineage as the opening load. |
| Evidence required | A figure the owner can demonstrate against reality: a physical cash count for Caja chica, a bank statement for BNA and Patagonia, the MP account position for Mercado Pago, and a per-counterparty statement the owner confirms for clients and suppliers. |
| Sign | Follows the frozen convention: `+` increases what the counterparty owes us (client) or what we owe (supplier); `-` is the opposite. A client credit is a legitimate negative. For accounts, the posting sign carries the real balance. |
| Who validates | The owner. No opening figure enters the system on the strength of a legacy query alone. |
| Lineage | Every opening row is marked as the opening load with its evidence reference, so it is distinguishable from a migrated movement forever. |
| Double-count prevention | **An account or counterparty gets either an opening balance or migrated history for the same window — never both.** The choice is recorded per counterparty before loading, and validation (§13) asserts exactly one opening row per counterparty per ledger. |
| Period | Opening rows are loaded while their period is OPEN; the period is closed afterwards, never before. |

### Per ledger

**Client ledger.** Default is an opening balance per client at the zero point, because frozen rules 3 and 4 forbid reconstructing a balance from orders that cannot demonstrate it. If profiling shows `pagos` + `pedidos` for 2026+ *do* demonstrate the real balance for a given client, that client's history may be migrated instead of an opening row — this is Owner Decision **OD-2**, and it is decided per the whole client set, not silently per row.

**Supplier ledger.** Opening balance only. No legacy supplier account exists in any form, so there is nothing to migrate and nothing to reconstruct. Each supplier's position comes from an owner-validated statement.

**Financial accounts.** Opening position for all four accounts, validated against reality per frozen rule 6. Migrated 2026+ `movimientos_caja` postings and an opening position for the same account would double-count, so the opening position is the balance **at the zero point** and migrated postings stop before it — or, if postings are migrated for the window, the opening position is the balance at 2026-01-01 instead. Whichever is chosen is recorded per account and asserted by validation.

---

## 7. Open instruments at cutover

Legacy `cheques` carries `numero`, `banco`, `monto`, `fecha_emision`, `fecha_vencimiento`, `girador` (free text), `estado` ∈ {`emitido`,`cobrado`,`rechazado`,`cancelado`}, and an optional `movimiento_caja_id`. The target needs a direction, a typed counterparty, per-step business dates and a lifecycle.

| Question | Decision |
|---|---|
| What state is migrated | The **real current situation** of every instrument still open at cutover, verified against the physical instrument — not the legacy `estado` taken on trust. |
| Which historical events are kept | Only those actually evidenced. `fecha_emision` evidences the origin event; `fecha_vencimiento` is a maturity date, not an event. A `cobrado` instrument evidences a clearing or debit having happened, but the legacy row does **not** evidence *when* the intermediate steps occurred. |
| What to do when only the current state is known | Write the instrument in its current `estado` plus **one** `financial_instrument_event` for that state, dated with the best evidenced business date. Intermediate events are **not** created. |
| How a fabricated lifecycle is avoided | The unique index on `(financial_instrument_id, event_type)` prevents duplicates, and the rule above prevents invention: an instrument may legitimately reach cutover with a single event. No RECEIVED→DEPOSITED→CLEARED chain is synthesised to look complete. |
| Closed instruments | Those settled before 2026-01-01 are **E HISTORICAL_EVIDENCE_ONLY**. Those settled inside the window migrate as current state if their evidence is reliable, otherwise they are also evidence only. |
| Economic consequence | An open instrument's migration must not re-create a client or supplier ledger movement that the opening balance already reflects. The opening balance is taken **after** accounting for instruments in portfolio, and validation asserts no double count. |
| Direction and counterparty | Unresolvable from legacy data alone — see Owner Decision **OD-3**. |

---

## 8. Mercado Pago migration

MP is an external integration, not a ledger (frozen Part 22, Part 26). The four layers stay separate.

| Layer | Target | Source | Method | Rule |
|---|---|---|---|---|
| Raw / source | `mp_source_record` | `mercadopago_raw`, existing `mp_source_record`, and the `Liberaciones*` / `BASECSV` exports | **A DIRECT** | Loaded verbatim: `event_data`, `occurred_at`, `occurred_date`, `external_id` (MP `SOURCE_ID`), `source_type`. Immutable after load — the `trg_mp_source_raw_guard` trigger must exist **before** loading begins. `occurred_date` is MP's own date and determines the period. |
| Normalized | `mp_financial_movement` | `mp_financial_movement`, `mercadopago_movements`, `mercadopago_settlement` | **B TRANSFORM** | Preserves gross, MP fee, taxes and net separately, which the `Liberaciones*` header already supplies as distinct columns. One row per `(source_record, movement_kind)`. |
| Reconciliation | `mp_reconciliation` + `financial_operation`/`financial_posting` | `mp_movement_source_link`, `mp_source_link_resolution`, `monthly_reconciliation`, `reconciliation_snapshot` | **B TRANSFORM**, only where a real amount-assigned link exists | N:N and amount-assigned. A movement with no demonstrable internal counterpart stays unreconciled — that is a valid terminal state. No correspondence is invented and there is no artificial deadline. |
| Opening balance | `financial_posting` on the Mercado Pago account | owner-validated MP position | **C OPENING_BALANCE** | Subject to the same either-opening-or-history rule as the other accounts (§6). |
| Legacy MP constructs | none | `ledger_entry`, `account_balance`, `mp_financial_cycle`, `mp_import_exception`, `period_flow_observation`, `import_period_coverage`, `sync_metadata`, `mercadopago_settlement` | **E HISTORICAL_EVIDENCE_ONLY** | Kept read-only in the old system. `import_period_coverage` and `reconciliation_snapshot` are used as *evidence during validation* — they prove which months were covered — but they are not loaded as target facts. |

Deduplication uses MP `SOURCE_ID` plus the `fingerprint` column added in migration `010`; the same identity carries into the target as `mp_source_record(source_type, external_id)`, which is UNIQUE in the frozen schema. The current integration is not discarded for being replaced: it is the source of the raw layer and the evidence of coverage (frozen rule 9).

---

## 9. Productive migration

| Entity | Method | Rule |
|---|---|---|
| `sheds` | **B TRANSFORM** | Extracted from distinct `galpon` text values across `lotes` and `producciones`. Normalisation must be deterministic and recorded, because tilde variants are known to exist (`NORMALIZACION_GALPON_TILDE.sql`). Two spellings of one shed must converge to one row, and the mapping is part of the lineage. |
| `flocks` | **B TRANSFORM** | From `lotes`. `initial_population` ← `aves_iniciales_postura`. `entry_date` ← `fecha_entrada`, `exit_date` ← `fecha_salida`. `estado` mapped from `LoteEstado`; `Planificado` has no target state and such rows are not migrated as flocks. `genetics_line`, `birth_date`, `supplier_id`, `purchase_id` are left null where unknown — never guessed. The one-ACTIVE-flock-per-shed index must hold after migration; a conflict is a gap, not something to resolve by picking one. |
| `initial_population` | **A DIRECT** | Taken from `aves_iniciales_postura` only. It is never back-computed from counts minus mortality, because that would bake a derived figure into the flock's authority. |
| `mortality` | **B TRANSFORM** | `producciones.mortandad` → `population_events` `MORTALITY` with `delta` negative, `event_date` ← `producciones.fecha`. At most one current MORTALITY per (flock, date) must result; legacy duplicates are a gap, not something to sum silently. Subject to Owner Decision **OD-1**. |
| `count_adjustments` | **B TRANSFORM** | `recuentos_lote` → `COUNT_ADJUSTMENT` with `delta` ← `diferencia`, `event_date` ← `fecha_recuento`, and `reason` mandatory in the target, so the legacy `notas` or an explicit "recuento físico" reason must be supplied. `aves_contadas` is the physical observation used to validate derived population; `mortandad_esperada` is a legacy expectation and is **not** migrated as a fact. |
| `daily_production` | **B TRANSFORM** | `eggs_total` ← `huevos_totales_mediodia + huevos_totales_tarde`; `eggs_broken` ← `huevos_cachados_mediodia + huevos_cachados_tarde`; `eggs_dirty` ← **0**, because no legacy column exists — recorded as "sin dato", never estimated. `production_date` ← `fecha`. Rows whose `lote_id` is null cannot be attached to a flock and are a gap, not a candidate for shed-based guessing. |
| `flock_weighing` | **NEW** | No legacy source. Starts empty. |
| `temperature_record` | **NEW** | No legacy source. Starts empty. |
| `classification` / `classification_line` | **NEW** | No legacy sessions exist. Historical classification stays **"sin dato"** per frozen rule 8. The legacy `Categoria` values are sale/price categories and are **not** converted into grading sessions; converting them would fabricate the flock↔classification correspondence that frozen Part 14 and Part 26 forbid. |

Nothing missing is inferred. Where a productive fact cannot be attributed, it is recorded as a gap and left out.

---

## 10. Feed migration

Frozen Part 15 requires the feed architecture; frozen rule 10 allows existing spreadsheets as sources but demands that observed and calculated data stay distinguishable. **No feed spreadsheet was found in this repository**, so every feed source is `UNKNOWN — source not present`.

| Layer | Method | Rule |
|---|---|---|
| Master data (`feed_type`, `feed_ingredient`) | **B TRANSFORM** from `productos` where `categoria='alimento'`, else **NEW** | The product catalogue is the only feed-adjacent legacy data present. |
| Formula versions (`feed_formula_version`, `feed_formula_line`) | **B TRANSFORM** if a dated sheet is supplied, else **NEW** | A version is immutable once referenced. A version is only migrated when its composition is evidenced by a dated document; otherwise formulas start in the target. |
| Historical ingredient prices (`unit_cost_snapshot`) | **B TRANSFORM** only from a purchase document or dated sheet | This is **observed** cost. A master price at migration time is not evidence of a historical cost and must not populate the snapshot. |
| Manufacturing (`feed_manufacturing`) | **B TRANSFORM** if evidenced, else **NEW** | Each row must name the exact formula version applied. Without that, the row is not migrated. |
| Inventory counts (`feed_inventory_count`) | **B TRANSFORM** if evidenced, else **NEW** | A count is an **observation**. It is never computed from the stock equation and written back as if measured. |
| Movements (`feed_movement`) | **B TRANSFORM** if evidenced, else **NEW** | External output and adjustments. Adjustments require a reason in the target. |
| Consumo interno | **F DO_NOT_MIGRATE** | Derived per period from counts + manufacturing ± movements. Never stored, never imported. |
| Consumo teórico / curves (`genetics_consumption_curve`) | **NEW** (reference data) | A control metric input. **Consumo teórico is never written into any consumption or movement table**, which would convert a calculation into a measured fact — exactly what frozen Part 26 rejects. |

---

## 11. Referential mapping strategy

Legacy keys are heterogeneous: UUIDs (`clientes`, `pagos`, `lotes`, `producciones`, `cuentas_caja`, `perfiles`), **integers** (`pedidos`, `movimientos_caja`, `cheques`, `comisiones`), and **free text** (`galpon`, `cuenta_origen`, `cuenta_destino`, `girador`).

| Case | Rule |
|---|---|
| Legacy UUID → target UUID | Preserve the legacy UUID as the target `id` where the target PK is UUID and the value is unique. This makes the mapping identity and the migration trivially repeatable. |
| `perfiles` | Always preserve `id`, because it equals `auth.uid()` and the entire security model resolves roles through it. Remapping it would break `current_app_role()`. |
| Legacy integer → target UUID | A new UUID is generated and the legacy integer is recorded as `source_id`. The pair must be stored in the migration's own mapping store (§12) so a re-run produces the same target id. |
| Legacy BIGSERIAL targets | `client_ledger`, `supplier_ledger`, `financial_operation`, `financial_posting`, `population_events`, `feed_movement`, `feed_inventory_count`, `financial_instrument_event`, `mp_financial_movement` generate their own keys; identity comes from lineage columns, not from the key. |
| Free-text references | `galpon` → `sheds` resolves through the recorded normalisation map. `cuenta_origen`/`cuenta_destino` → `financial_account` resolves through an explicit text→account map built during profiling. `girador` → client or supplier is **not** resolved by text matching alone (see OD-3). |
| Name as a key | Used **only** where no better identifier exists — which applies to `galpon`, the cash account text fields, and `data/clientes.csv` (whose only columns are `nombre,activo`). Wherever a legacy id exists, the id wins. |
| Unresolvable reference | The row is not migrated and is recorded as a gap. It is never attached to a default, a nearest match or a placeholder. |

Every map built during migration (integer→UUID, galpon→shed, text→account) is persisted and versioned as migration output, so the mapping is reproducible rather than re-derived.

---

## 12. Idempotency and rerun strategy

The migration must be runnable repeatedly in the test environment without duplicating anything.

### Lineage identity

Every migrated row is identified by `(source_system, source_entity, source_id, import_batch)`:

| Component | Meaning |
|---|---|
| `source_system` | the origin system, e.g. the legacy Supabase project, or `mp_export` for a file |
| `source_entity` | the legacy table or file name |
| `source_id` | the legacy primary key, or the file's own identifier (MP `SOURCE_ID`, or file + row for spreadsheets) |
| `import_batch` | the run that loaded the row |

### Where this lives

The frozen schema has **no generic lineage columns**, and this phase adds none. Lineage is therefore carried two ways:

1. **Inside the target, using columns that already exist.** The frozen schema already provides the natural idempotency keys, and the migration derives them deterministically from the source id so a re-run collides instead of duplicating:
   `collections.receipt_id` · `financial_operation.external_ref` · `purchases.idempotency_key` · `freight.idempotency_key` · `feed_manufacturing.idempotency_key` · `classification.idempotency_key` · `sales_session.idempotency_key` · `fiscal_payment.idempotency_key` · `financial_instrument.receipt_id` / `external_ref` · `mp_source_record(source_type, external_id)` · plus the natural keys `daily_production(flock_id, production_date)`, `flock_weighing(flock_id, weighing_date)`, `temperature_record(shed_id, record_date, record_time)`, `feed_inventory_count(feed_type_id, count_date)`.
   A deterministic derivation such as `legacy:<source_entity>:<source_id>` makes each of these reproducible across runs.
   For rows in append-only tables that have no such key — `client_ledger`, `supplier_ledger`, `financial_posting`, `population_events` — the existing `source_entity_type` / `source_entity_id` columns on the two ledgers carry it, and the remaining tables inherit identity from their parent operation or event.

2. **Outside the target, as migration tooling.** The `(source_system, source_entity, source_id, import_batch)` register and the three resolution maps (integer→UUID, galpon→shed, text→account) live in **migration tooling storage**, not in the production schema: a separate staging schema or database used only by the migration. This is explicitly **tooling, not architecture** — it is not part of the target model, it is not covered by the frozen documents, and it does not ship to production.

### Rerun rules

- A re-run reuses the same target ids for the same source rows, via the mapping store.
- Loading is per batch and per entity, in the dependency order of the frozen build sequence.
- Periods must be OPEN while loading and are closed only after validation, because every RPC-mediated write checks the period.
- A partial run is recoverable: because identity is deterministic, re-running skips what already exists rather than duplicating it.
- A re-run never mutates an already-loaded append-only row; it either skips it or the batch is rolled back and reloaded from empty.

---

## 13. Validation and reconciliation

Every check below must be executed after a migration run, in the test environment first (Phase 26). **No difference is ever reconciled silently**: each one is either explained in writing or it blocks cutover.

| # | Check | Assertion |
|---|---|---|
| V-1 | Financial account balances | `SUM(financial_posting.signed_amount)` per account equals the owner-validated real balance for all four accounts. |
| V-2 | Opening balance uniqueness | Exactly one opening row per client, per supplier and per account. No counterparty has both an opening balance and migrated history for the same window. |
| V-3 | Client AR | `SUM(client_ledger.signed_amount)` per client equals the validated position. Total AR equals the sum of per-client positions. |
| V-4 | Supplier AP | `SUM(supplier_ledger.signed_amount)` per supplier equals the validated position. **Zero `supplier_ledger` rows of type `PURCHASE` originate from migrated history** — the position comes from the opening balance alone, so a migrated historical purchase never adds a second liability (G-4). |
| V-4b | Purchase evidence threshold | Every `purchases` row has a non-null `supplier_id`, `expense_category_id` and `nature`. Zero purchases reference a placeholder supplier. Zero `purchase_attachment` rows were generated by the migration. Every migrated purchase has exactly one derived `purchase_line` whose `subtotal` equals the parent `amount_total`, and every such line is flagged as derived so no per-unit analysis consumes it. |
| V-5 | Instruments | Every open instrument matches the physical instrument in number, bank, amount, maturity and state. Portfolio total and pending debits reconcile. No instrument has more lifecycle events than its evidence supports. |
| V-6 | Instrument double-count | No instrument in portfolio is reflected both in an opening balance and in a migrated ledger movement. |
| V-7 | Flock population | `initial_population + SUM(population_events.delta WHERE is_current)` equals `recuentos_lote.aves_contadas` at each count date, or the difference is explained as a recorded adjustment. |
| V-8 | Mortality uniqueness | At most one current MORTALITY per (flock, event_date). Zero rows violate the partial unique index. |
| V-9 | Production totals | Per flock and per month, `eggs_total` and `eggs_broken` equal the legacy sums from `producciones`. `eggs_dirty` is 0 everywhere and is reported as "sin dato", not as zero production. |
| V-10 | Pending orders | Every legacy `pendiente` order in the window exists in the target with its lines and prices, and its line sum matches the legacy `monto_total` — or the difference is explained before `monto_total` is dropped. |
| V-11 | Delivered orders | Count and total of DELIVERED orders in the window match legacy, and each produced exactly one `SALE_DELIVERY` ledger movement. |
| V-12 | Line snapshot integrity | Every `pedido_lineas.precio_unitario` equals the price recorded on the source order, not a current master price. |
| V-13 | MP coverage | `mp_source_record` count per month matches `import_period_coverage` and the row counts of the source exports. No `SOURCE_ID` appears twice. |
| V-14 | MP arithmetic | For every `mp_financial_movement`: gross − fee − tax = net. Assigned amounts in `mp_reconciliation` never exceed the movement net. |
| V-15 | MP unreconciled | Unreconciled movements are listed and explained. An unreconciled movement is acceptable; an invented reconciliation is not. |
| V-16 | Per-entity counts | Row count per target entity equals the expected count derived from its source, per the matrix in §5. Every discrepancy is itemised. |
| V-17 | Referential completeness | Zero unresolved references: every `flocks.shed_id`, `daily_production.flock_id`, `financial_posting.financial_account_id`, `pedido_lineas.producto_id` and `financial_instrument` counterparty resolves. |
| V-18 | Invariant suite | The verification queries of `DATABASE_INVARIANTS_V1.md` return their expected results against migrated data. |
| V-19 | Security suite | Checks 1–8 of `RLS_IMPLEMENTATION_SPEC_V1.md` §11 pass against the migrated database, plus the behavioural tests for ADMIN, OPERATOR and SERVICE_ROLE. |
| V-20 | Period integrity | Every migrated fact sits in the period its business date implies. No fact landed in a period by way of `created_at`. All periods that received facts are closed after validation. |
| V-21 | Economic totals | Where the source is reliable, migrated economic totals match the source for the window. Where it is not, the opening-balance path was used instead and V-2 proves no overlap. |
| V-22 | Rerun idempotency | A second full run in the test environment changes no row count and creates no duplicate. |

The old P&L is not used in any of these checks (frozen rule 11).

---

## 14. Cutover data classes

| Class | Contents |
|---|---|
| **Migrated history** (2026+) | `price_history`; `pedidos` and `pedido_lineas`; `collections`; `financial_operation` and `financial_posting` from `movimientos_caja` and `comisiones`; `purchases` **and their derived `purchase_line`**, for the expense rows that clear the G-4 evidence threshold, as cost history without a supplier liability movement; `daily_production`; `population_events` (mortality and count adjustments); `mp_source_record`, `mp_financial_movement`, `mp_reconciliation`; minimal creation-attribution `audit_events`. Client ledger history only if OD-2 selects it. |
| **Opening position** | `client_ledger` (default), `supplier_ledger` (always), and the four `financial_account` positions. |
| **Current state** | `perfiles`; `clients`; `products`; `financial_account`; `expense_category`; `sheds`; `flocks`; `classification_grade`; open `financial_instrument` rows with their evidenced events. |
| **Legacy evidence only** | Everything before 2026-01-01; `ledger_entry` and `account_balance`; `mp_financial_cycle`, `mp_import_exception`, `period_flow_observation`, `import_period_coverage`, `sync_metadata`, `mercadopago_settlement`; `facturas` pending profiling; legacy reports and P&L; `precios_actuales`; `pedidos.monto_total`; `recuentos_lote.mortandad_esperada`; the entire old application, read-only after cutover. |
| **New-system only** | `suppliers`; `purchase_attachment`; `freight` and `freight_allocation`; `projects`; `operator_assignments`; `management_period`; `flock_weighing`; `temperature_record`; `classification` and `classification_line`; the whole feed domain unless dated sheets are supplied; the whole feria domain; the whole fiscal domain unless `facturas` proves usable; `genetics_consumption_curve`. `purchase_line` is new-system-only **for captured line detail**; the derived single lines of migrated purchases are migrated history (G-4b). |

---

## 15. Known gaps and owner decisions

### Gaps — technical, resolved technically

| ID | Gap | Resolution path |
|---|---|---|
| G-1 | Operational legacy DDL is not in the repository; only MP migrations are versioned | Dump and profile the live schema in Phase 12 before finalising any mapping. Nothing in §5 is confirmed until then. |
| G-2 | No row-level data quality is known for any live table | Data profiling in Phase 12: row counts, null rates, orphan references, duplicate keys, value distributions for every enum-like column, and the 2026+ window boundaries. |
| G-3 | `facturas` is used by the app but has no type definition and unknown structure | Profile it. Until then the fiscal domain stays evidence-only; it is not a blocker because the fiscal domain can start empty. |
| G-4 | Legacy expenses carry no supplier, no document and no attachment, so most of them cannot become `purchases` rows | Resolved by an evidence threshold, not by a privilege. See **G-4 in full** below. |
| G-5 | `eggs_dirty` has no legacy source | Stays 0 and is reported as "sin dato". Not inferred. |
| G-6 | `producciones` rows with null `lote_id` cannot be attached to a flock | Not migrated; itemised in V-16. Shed-based guessing is forbidden. |
| G-7 | `galpon` free text with known tilde variants | Deterministic normalisation map, recorded as migration output and asserted by V-17. |
| G-8 | `cuenta_origen`/`cuenta_destino` are text, not FKs | Explicit text→account map built during profiling; unresolved rows are not migrated. |
| G-9 | `naturaleza_gasto` has 5 legacy values; `distribucion_ganancias` and `ajuste_contable` are not purchases | Those rows migrate as `financial_operation` (withdrawal / adjustment), not as `purchases`. Frozen Part 19 already places withdrawals below the operating result. |
| G-10 | `metodo_pago` has 7 legacy values vs 4 target; `cheque`/`echeq` cannot become `collections` | Cheque payments route to `financial_instrument`; `tarjeta` and `otro` need an explicit mapping rule decided during profiling from their actual distribution. |
| G-11 | `rectificado=true` orders have no recoverable prior version | Migrate the current state as `version_seq=0`. The pre-rectification version is genuinely lost and is recorded as such; it is not reconstructed. |
| G-12 | Three coexisting shapes of order lines | Reader handles all three; the shape each row came from is recorded in lineage. |
| G-13 | No feed spreadsheet present in the repository | If supplied, §10 applies. If not, the feed domain starts empty. Not a blocker. |
| G-14 | `LoteEstado='Planificado'` has no target state | Those rows are not migrated as flocks. |
| G-15 | `management_period` rows must exist and be OPEN before loading | Migration creates the month rows for the window first; closure happens after validation. |

None of these can produce an invented balance or state: each either excludes the row, records "sin dato", or resolves through a recorded deterministic map.

### G-4 in full — historical expenses and the purchase evidence threshold

Two rules apply to attachments and they are not the same rule. Conflating them is what made the earlier wording wrong.

**A — Target operational rule (unchanged).** `register_purchase` (RPC 13) requires at least one attachment, raises `ATTACHMENT_REQUIRED` without one, and inserts the purchase and its attachments in the same transaction. `purchase_attachment` has no DELETE policy, so the attachment cannot be removed afterwards. **This is not relaxed, narrowed or made conditional for any purchase created in the new system.** Invariant 23 stands exactly as frozen.

**B — Migration rule (the actual criterion).** A legacy row becomes a `purchases` row **only if the legacy evidence is sufficient to assert two things**:

1. that the row really represents an economic purchase or expense — not a withdrawal, a transfer, an accounting adjustment or a cash reclassification; and
2. that every field the target makes mandatory can be **determined from that evidence**, namely `supplier_id`, `economic_date`, `amount_net`, `amount_total`, `expense_category_id` and `nature`.

The earlier justification — that migration tooling owns the schema and is therefore not bound by the RPC's check — is **withdrawn**. It described a technical possibility and offered it as a reason, which it is not. Being able to write a row is not evidence that the row is true. The threshold above is the criterion; the tooling's privileges are irrelevant to it.

The binding constraint is stronger than the attachment rule anyway: `purchases.supplier_id` is **NOT NULL in the frozen schema**. A legacy expense whose supplier cannot be determined therefore cannot become a purchase at all, no matter who writes it.

**When the evidence is insufficient.** Nothing is invented — specifically:

- **no invented supplier.** No placeholder supplier, no "Proveedor desconocido" master, no nearest-name match on `concepto`.
- **no invented invoice or document.** `supplier_invoice_number` and `fiscal_document_id` stay null rather than synthesised.
- **no invented attachment.** No empty, generated or stand-in `purchase_attachment` row is ever created to satisfy a shape.
- **no invented quantity, unit or unit price.** See the purchase_line rule below.

The row is then handled by the strategy already defined elsewhere in this document, with no new mechanism:

- the legacy row stays **E HISTORICAL_EVIDENCE_ONLY** in the read-only old system, and is excluded from `purchases`;
- its **cash effect is still preserved**, because `movimientos_caja` also migrates to `financial_operation` + `financial_posting` (§5). The money movement is not lost — only the supplier liability interpretation is withheld, because that is the part the evidence does not support;
- any effect such a row would have had on a **supplier position is absorbed by that supplier's opening balance** (§6), which is owner-validated. Since the supplier position comes from the opening balance and not from migrated purchase liabilities, excluding the row cannot leave the position wrong.

**When the evidence is sufficient.** If a given row's genuinely available fields — `concepto`, `categoria`/`subcategoria`/`categoria_tecnica`, `naturaleza_gasto`, `fecha_operacion`, `monto`, and a supplier identifiable from that evidence — satisfy both conditions of rule B, the row migrates under a **deterministic rule documented before the run**: which legacy values map to which `expense_category_id`, how `naturaleza_gasto` maps to `nature` (excluding `distribucion_ganancias` and `ajuste_contable` per G-9), and how `amount_net` relates to `amount_total` when no tax breakdown exists. The rule is written down, applied uniformly, and recorded in lineage. It is not decided row by row by judgement.

**No double counting with the supplier opening balance.** Migrated historical purchases are **cost history**, not open liabilities. The migration therefore writes the `purchases` row and its derived line and does **not** write a `supplier_ledger` `PURCHASE` movement for it, because the supplier's position at the zero point already comes from the owner-validated opening balance (§6, supplier ledger is opening-balance only). Writing both would count the same obligation twice. This is asserted by V-4.

**Timing.** The per-row outcome is determined **after profiling** (Phase 12), which is what will show how many rows clear the threshold. This phase fixes the criterion, not the per-row result. No owner decision is required: the criterion is derived from the frozen schema's own mandatory fields, and the fallback path was already defined.

### G-4b — `purchase_line` for a migrated historical purchase

A migrated historical purchase needs a line, because `purchase_line` is where the target holds what was bought. Legacy `movimientos_caja` has no line detail at all: it has a free-text `concepto` and a single `monto`.

**Classification.** This line is **B TRANSFORM — a derived technical representation**, not `NEW`. It is derived from a real legacy row and carries lineage to that row: `source_id` is the **same** `movimientos_caja.id` as its parent purchase, flagged as a derived single-line so it is never mistaken for captured detail.

**What the representation may assert.** Only what the legacy evidence supports:

| Target column | Value | Status |
|---|---|---|
| `descripcion` | legacy `concepto`, verbatim | **observed** — this is what the legacy row actually says |
| `precio_unitario` | the purchase's `amount_total` | **structural** — the target requires a NOT NULL price; this is the total, not a unit price |
| `cantidad` | `1` | **structural placeholder** — required NOT NULL and CHECK > 0; it is not a measured quantity |
| `unit_type` | `'UNIT'` | **structural placeholder** — the legacy row names no unit |
| `subtotal` | GENERATED = `1 × amount_total` = `amount_total` | arithmetically consistent with the parent by construction |
| `producto_id`, `feed_ingredient_id` | null | not determinable from a free-text concept |

**Rule.** `cantidad`, `unit_type` and `precio_unitario` on these lines are **not historical observations** and must never be read as such. They exist because the schema requires them, they are marked as derived in lineage, and **no per-unit or per-quantity analysis may use them** — unit cost, consumption per unit and price-per-kg reporting must exclude derived legacy lines. Where a real quantity or unit is genuinely present in the legacy `concepto`, it is **not** parsed out of free text: extracting it would turn a guess into data.

This keeps `purchases` and `purchase_line` coherent — both are **B TRANSFORM** from the same source row for the rows that clear the threshold, and neither exists for the rows that do not.

### Owner decisions required

Only three, each because two functionally valid alternatives exist **and** the choice changes which data becomes authority in the new system.

**OD-1 — Which source is the authority for mortality.**
`producciones.mortandad` records mortality per day; `recuentos_lote` records a physical count with `mortandad_esperada` and `diferencia`. Risk 2 of `MIGRATION_RISK_REGISTER_V1.md` flags this as unvalidated.
- *Alternative A:* `producciones.mortandad` is the MORTALITY authority and `recuentos_lote.diferencia` becomes COUNT_ADJUSTMENT.
- *Alternative B:* the physical count is the authority and daily mortality is treated as an estimate.
Choosing changes which rows become `population_events` facts and therefore what derived population means. Cannot be decided technically; profiling will quantify how far the two disagree, but not which one is true.

**OD-2 — Depth of client current-account history.**
- *Alternative A:* an owner-validated opening balance per client at the zero point; `pagos` and `pedidos` remain evidence.
- *Alternative B:* if profiling shows the 2026+ documents demonstrate each client's real balance, migrate them as ledger movements.
A makes the owner's declared figure the authority; B makes the legacy documents the authority. Frozen rules 3 and 4 permit B only where the balance is demonstrable, so this decision is taken **after** profiling and for the client set as a whole.

**OD-3 — Direction and counterparty of legacy cheques.**
Legacy `cheques` has no direction column and `girador` is free text with no client or supplier FK, while the target requires `cliente_id` for RECEIVED and `supplier_id` + `bank_account_id` for ISSUED.
- *Alternative A:* the owner classifies each open instrument's direction and names the counterparty, creating the missing client or supplier master where needed.
- *Alternative B:* instruments whose counterparty cannot be identified are excluded from migration and handled manually outside the system.
A makes the owner's classification the authority and may add master records; B leaves real open instruments outside the system. Text matching on `girador` is explicitly not a substitute, since a wrong match would misattribute a real debt.

---

## 16. Exit criteria

| Criterion | Status |
|---|---|
| Every target entity has an explicit strategy | **Met** — §5 covers all entities listed for this phase, with one method each and no entity left implicit. |
| Every real source is identified | **Met** — §3: 19 live operational tables, 16 MP tables across 12 versioned migrations, 20+ local data files, and the documentation set. Two errors in the existing crosswalk corrected. |
| Opening balances have a rule | **Met** — §6: date, evidence, sign, validator, lineage and the either-opening-or-history rule that prevents double counting. No value produced. |
| Lineage is defined | **Met** — §11 and §12: identity per key type, `(source_system, source_entity, source_id, import_batch)`, and the three resolution maps as recorded migration output. |
| Idempotency is defined | **Met** — §12: deterministic derivation of the frozen idempotency keys, plus tooling-side mapping store; rerun rules stated. |
| MP is conceptually resolved | **Met** — §8: four layers separated, raw immutable, no invented correspondence, legacy MP constructs kept as evidence only. |
| Open instruments are resolved | **Met** — §7: current state migrated, only evidenced events written, no fabricated lifecycle. Counterparty identification is OD-3. |
| Production and feed are resolved | **Met** — §9 and §10: nothing inferred; observed and calculated kept apart; classification stays "sin dato". |
| No reconstruction without evidence | **Met** — "reconstruct" is not used as a method; every derived fact requires demonstrable source rows, otherwise the opening-balance path applies. |
| No gap can produce an invented balance or state | **Met** — each of G-1…G-15 excludes the row, records "sin dato", or resolves through a recorded deterministic map. |
| Real owner decisions identified | **Met** — exactly three (OD-1, OD-2, OD-3), each with two valid alternatives that change data authority. Everything else is technical. |

### Phase 11 status

**PHASE 11 STATUS: COMPLETE**

The strategy is designed. It is not executed: no SQL was run, Supabase was untouched, no data moved, and no FROZEN document was modified.

Three dependencies carry forward, none of which blocks this phase:
- **Phase 12** must dump and profile the live schema (G-1, G-2) and profile `facturas` (G-3). Every `REQUIRES DATA PROFILING` entry in §5 is confirmed or corrected there.
- **OD-1, OD-2 and OD-3** need owner answers before a migration run; OD-2 is answerable only after profiling.
- **Phase 26** executes this strategy against a realistic copy and runs V-1…V-22.

`MASTER_ROADMAP.md` is not updated by this document; phase state changes after review.
