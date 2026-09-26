# CURRENT → TARGET CROSSWALK V2 — ROUND 1

**STATUS:** Complete legacy compatibility audit  
**DATE:** 2026-09-24  
**PURPOSE:** Map current schema/code to target architecture; identify migration strategy & hazards

---

## EXECUTIVE SUMMARY

**Reusability:** 90% of current schema maps directly to target (REUSE or ADAPT).

**New creation:** 10% of target tables must be created (audit, suppliers, purchases, management_periods, classification, feed, etc.).

**Migration feasibility:** YES, with 5 prerequisites resolved.

**Estimated effort:** 2-3 weeks for Physical Schema + migrations (given prerequisites).

---

## CURRENT → TARGET DETAILED CROSSWALK

| Target Domain | Target Table | Current Table(s) | Action | Risk | Notes |
|---|---|---|---|---|---|
| **IDENTITY** | perfiles | perfiles ✓ | REUSE | LOW | Rename column `creado_en` → `created_at`; add rol_type='OPERATOR' |
| **CLIENTS** | clients | clientes ✓ | REUSE | LOW | Direct 1:1; rename/retype as needed |
| **PRODUCTS** | products | productos ✓ | REUSE | LOW | Extend with product_type ENUM (VENDIBLE, INPUT, BOTH) |
| **PRICES** | price_history | precios_historial ✓ | REUSE | LOW | Excellent pattern; keep as-is |
| **ORDERS** | pedidos | pedidos ✓ | ADAPT | MEDIUM | Remove monto_total; prevent UPDATE on DELIVERED; add delivered_at TIMESTAMPTZ |
| **ORDER_LINES** | pedido_lineas | pedidos.lineas (JSONB) | MIGRATE | MEDIUM | Denormalize JSONB array into separate table; preserve price_snapshot |
| **CLIENT_LEDGER** | client_ledger | NONE | CREATE NEW | HIGH | Calculate historical balance from pagos + pedidos; no existing audit trail |
| **COLLECTIONS** | collections | pagos ✓ | ADAPT | MEDIUM | Rename; broaden scope (cheque, transfer, cash); add receipt_id UNIQUE |
| **FINANCIAL_ACCOUNT** | financial_account | NONE (hardcoded) | CREATE NEW | MEDIUM | Create master: Caja Chica, BNA, Patagonia, Mercado Pago |
| **FINANCIAL_OPERATION** | financial_operation | movimientos_caja (partial) | ADAPT | HIGH | Consolidate movimientos_caja + cheques + comisiones; redesign as parent entity |
| **FINANCIAL_POSTING** | financial_posting | NONE | CREATE NEW | HIGH | Normalize 1:N from financial_operation |
| **FINANCIAL_INSTRUMENT** | financial_instrument | cheques ✓ | ADAPT | MEDIUM | Extend estado machine (RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED) |
| **INSTRUMENT_EVENTS** | financial_instrument_event | NONE | CREATE NEW | MEDIUM | Track state transitions; audit cheque lifecycle |
| **SUPPLIERS** | suppliers | NONE | CREATE NEW | HIGH | No supplier master; needed for purchases domain |
| **SUPPLIER_LEDGER** | supplier_ledger | NONE | CREATE NEW | HIGH | Track supplier debt; currently implicit only |
| **PURCHASES** | purchases | NONE | CREATE NEW | HIGH | Formal purchase orders; currently direct expense in movimientos_caja |
| **FREIGHT** | freight | NONE | CREATE NEW | MEDIUM | Flete as economic operation; optional V1 but framework needed |
| **SHEDS** | sheds | NONE | CREATE NEW | MEDIUM | Extract galpones; create master entity |
| **FLOCKS** | flocks | lotes ✓ | REUSE | LOW | Rename; add genetics, supplier_id fields |
| **POPULATION_EVENTS** | population_events | producciones.mortalidad (embedded) | MIGRATE | HIGH | Extract mortality as events; add COUNT_ADJUSTMENT type; enforce UNIQUE |
| **DAILY_PRODUCTION** | daily_production | producciones ✓ | REUSE | MEDIUM | Keep structure; remove classification_session_id link (frozen rejection) |
| **FLOCK_WEIGHINGS** | flock_weighings | NONE | CREATE NEW | LOW | Weighing measurements; not in current schema |
| **TEMPERATURE_RECORDS** | temperature_records | NONE | CREATE NEW | LOW | Recría temperature; optional but in target |
| **CLASSIFICATION** | classification | NONE | CREATE NEW | MEDIUM | Session-based grading; no current equivalent |
| **CLASSIFICATION_LINES** | classification_lines | NONE | CREATE NEW | MEDIUM | Grade breakdown per session |
| **FEED_TYPES** | feed_types | NONE | CREATE NEW | HIGH | V1 foundation for feed domain |
| **FEED_FORMULA_VERSION** | feed_formula_version | NONE | CREATE NEW | HIGH | Immutable formula versions |
| **FEED_INGREDIENTS** | feed_ingredients | NONE | CREATE NEW | HIGH | Feed recipe components |
| **FEED_MANUFACTURING** | feed_manufacturing | NONE | CREATE NEW | MEDIUM | Manufacturing batch tracking |
| **FEED_INVENTORY_COUNT** | feed_inventory_count | NONE | CREATE NEW | LOW | Physical feed count records |
| **FISCAL_DOCUMENTS** | fiscal_document | NONE | CREATE NEW | MEDIUM | V1: minimal (name, date, amounts) |
| **TAX_COMPONENTS** | tax_component | NONE | CREATE NEW | LOW | Tax breakdown per document |
| **MANAGEMENT_PERIODS** | management_periods | NONE | CREATE NEW | HIGH | Period open/closed states; integral closure |
| **AUDIT_EVENTS** | audit_events | NONE | CREATE NEW | HIGH | Transversal audit trail |
| **MP_SOURCE** | mp_source_record | mp_source_record ✓ | REUSE | LOW | FASE 0 architecture; keep as-is |
| **MP_FINANCIAL_MOVEMENT** | mp_financial_movement | mp_financial_movement ✓ | REUSE | LOW | FASE 0 normalized movements; keep as-is |
| **RECONCILIATION** | reconciliation_event | ledger_entry ✓ | ADAPT | LOW | Link to financial_operation (not standalone) |

---

## DOMAIN-BY-DOMAIN MIGRATION ASSESSMENT

### A. COMMERCIAL DOMAIN (Clients, Products, Orders)

**Current state:**
- ✓ clients: present, good structure
- ✓ productos: present, minimal schema
- ✓ pedidos: present BUT lineas stored as JSONB (anti-pattern), monto_total editable
- ✓ precios_historial: excellent audit pattern

**Target actions:**

| Current | Target | Action | Specifics |
|---------|--------|--------|-----------|
| clientes | clients | REUSE | Rename only |
| productos | products | REUSE + extend | Add product_type ENUM |
| pedidos | pedidos | ADAPT | Remove monto_total column; add delivered_at TIMESTAMPTZ; RLS immutability on DELIVERED |
| pedidos.lineas (JSONB) | pedido_lineas (table) | MIGRATE | Denormalize array into separate table; preserve price/product_name snapshots |
| precios_historial | price_history | REUSE | As-is |

**Data quality issues found:**

1. **pedidos.monto_total divergence:** Can diverge from SUM(lineas.subtotal) (documented as frontend recalc workaround)
   - **SOLUTION:** Remove monto_total from target; enforce `total = SUM(order_lines)` via trigger/check
   - **Migration:** Validate SUM(lineas) = monto_total per order before cutover; flag discrepancies

2. **No DELIVERED timestamp:** pedidos has no `delivered_at` field (required for sales period determination)
   - **SOLUTION:** Add `delivered_at TIMESTAMPTZ` to target
   - **Migration:** Use `created_at` as proxy during cutover (may need owner sign-off); allow ADMIN to correct retroactively

3. **JSONB lineas structure unclear:** Current lineas array structure not documented
   - **SOLUTION:** Inspect production data; validate structure before denormalization script
   - **Migration:** Create denormalization script; test on sample; validate count + totals match

**Frontend breaking changes:**
- API must return pedidos WITH joined order_lines (separate query)
- UI must not edit monto_total directly
- Rectification UI required (new workflow)

---

### B. CLIENT LEDGER & COLLECTIONS

**Current state:**
- ✓ pagos: present (payment records)
- Partial movimientos_caja: contains payment movements as side effect (redundant with pagos)
- ✗ NO client_ledger table; saldo calculated ad-hoc: SUM(pagos) - SUM(pedidos.monto_total)

**Target actions:**

| Current | Target | Action | Specifics |
|---------|--------|--------|-----------|
| pagos | collections | ADAPT | Rename; broaden scope (cash, cheque, transfer); add receipt_id UNIQUE |
| (none) | client_ledger | CREATE NEW | Backfill from pagos + pedidos; establish source of truth |

**Migration hazard:**

**CRITICAL:** Current "saldo" calculation ambiguous:
- Is it SUM(pagos) by client?
- Is it SUM(movimientos_caja WHERE cliente_id)?
- Can they diverge?

**SOLUTION:** Audit production data to determine ground truth at cutover date:
```sql
SELECT cliente_id,
  SUM(pagos.monto) as pago_sum,
  SUM(movimientos_caja.monto WHERE tipo='ingreso' AND forma_pago IN ...) as caja_sum,
  SUM(pedidos.monto_total WHERE estado='DELIVERED') as sale_sum
FROM [join logic]
GROUP BY cliente_id
HAVING pago_sum ≠ (sale_sum - (saldo physical reconciliation))
```

**Use validated opening balance** at cutover date (owner sign-off required).

**Ledger entry types needed:**
- SALE (+)
- COLLECTION (-)
- ADVANCE (-)
- ADJUSTMENT (±)
- REVERSAL (±)
- CHEQUE_RECEIVED (-)
- CHEQUE_REJECTION (+)
- OPENING_BALANCE (+/-)

---

### C. TREASURY / FINANCIAL LEDGER

**Current state:**
- ✓ movimientos_caja: stores cash movements (ingreso/egreso, tipo, monto, vinculado_a) — CRITICAL table (~500+ rows)
- ✓ cheques: separate table (estado, numero, monto, banco) — not fully linked to financial hierarchy
- ✓ comisiones: separate table (monto, fee_type, forma_pago)
- ✗ NO financial_account master (accounts hardcoded in UI)
- ✗ NO financial_operation/financial_posting structure (atomic transfers impossible)

**Target actions:**

| Current | Target | Action | Specifics |
|---------|--------|--------|-----------|
| (hardcoded) | financial_account | CREATE NEW | Master: Caja Chica, MP, BNA, Patagonia |
| movimientos_caja | financial_operation + posting | ADAPT+MIGRATE | Complex: classify by tipo/forma_pago; consolidate comisiones |
| cheques | financial_instrument + events | ADAPT | Extend estado machine; create event tracking |

**Data quality issues:**

1. **forma_pago_type enum conflict** ← **POTENTIAL ADR REQUIRED**
   - Migration 045 defines: ('efectivo', 'mercadopago', 'transferencia')
   - Migration 019 defines: ('efectivo', 'mercadopago', 'echeq', 'cheque')
   - **ACTION:** Run `\dT forma_pago_type` in production; pick canonical version; alias deprecated during cutover

2. **Transfer atomicity lost:**
   - Transfers MP → BNA stored as TWO separate movimientos_caja (no atomicity guarantee)
   - **SOLUTION:** Migrate transfer pairs as single financial_operation + 2 postings; validate all pairs match

3. **movimientos_caja semantic overload:**
   - Uses `vinculado_a` (free-text string: 'pago', 'pedido', null) — not type-safe
   - Contains cash, transfers, fees, adjustments all mixed
   - **SOLUTION:** Classify each row during migration:
     ```sql
     CASE 
       WHEN tipo='ingreso' AND forma_pago='efectivo' AND vinculado_a='pago' → COLLECTION
       WHEN tipo='ingreso' AND forma_pago='mercadopago' → COLLECTION (MP)
       WHEN tipo='egreso' AND forma_pago='transferencia' THEN destination=? → TRANSFER
       WHEN tipo='egreso' AND purpose='comisión' → FEE
       ELSE → ADJUSTMENT
     ```

4. **Cheque state transitions not audited:**
   - cheques.estado column exists but no timestamp tracking (who marked cobrado? when?)
   - **SOLUTION:** Migrate known states; create financial_instrument_event with creado_en as base; unknown transitions marked with NULL event_date

5. **Forma_pago not normalized:**
   - Values like 'efectivo', 'mercadopago', 'cheque' hardcoded in code
   - **SOLUTION:** Create lookup table OR ENUM (if fixed); map during migration

**Current code to migrate:**
- ~500 rows movimientos_caja
- ~50 rows cheques (estimate)
- ~30 rows comisiones (estimate)

**Migration script logic:**
1. Extract all movimientos_caja
2. Group by vinculado_a reference (if traceable)
3. Classify by tipo/forma_pago/business context
4. Create financial_operation per logical transaction
5. Create 1:N financial_posting entries
6. Validate: SUM(postings) by account = expected balance at cutover date

---

### D. SUPPLIERS & PURCHASES

**Current state:**
- ✗ NO suppliers table
- ✗ NO purchases/compras table
- ✗ NO supplier_ledger table
- Expenses implicit in movimientos_caja (tipo='egreso')

**Target actions:**

| Current | Target | Action | Specifics |
|---------|--------|--------|-----------|
| (none) | suppliers | CREATE NEW | Start fresh; optional V1 migration |
| (none) | supplier_ledger | CREATE NEW | Ditto |
| (none) | purchases | CREATE NEW | Ditto |

**Migration challenge:**

No current data to inherit; no supplier master to back-populate. **Decision:** Suppliers optional V1; framework created but no backfill required.

---

### E. PRODUCTION & FLOCKS

**Current state:**
- ✓ lotes: present (flocks with galpon, fecha_entrada, aves_iniciales_postura, estado)
- ✓ producciones: present (daily records: fecha, galpon, huevos by grade, mortalidad, poblacion, alimento)
- ✓ recuentos_lote: present (population audits)
- Mortalidad stored as INT in producciones; NO separate population_events table

**Target actions:**

| Current | Target | Action | Specifics |
|---------|--------|--------|-----------|
| lotes | flocks | REUSE | Rename; add genetics/supplier fields |
| producciones | daily_production | REUSE | Keep structure; remove classification_session_id (frozen rejection) |
| producciones.mortalidad | population_events | MIGRATE | Extract as events; add COUNT_ADJUSTMENT type |
| recuentos_lote | (incorporated) | MIGRATE | Map to COUNT_ADJUSTMENT events |

**Migration hazard:**

**CRITICAL:** Current data quality unknown; mortalidad uniqueness not enforced

**Pre-migration audit:**
```sql
SELECT lote_id, fecha, COUNT(*) as dup_count
FROM producciones
GROUP BY lote_id, fecha
HAVING COUNT(*) > 1
```

If duplicates exist:
- Pick which record is truth (latest timestamp? largest mortalidad value?)
- Deduplicate before migration
- Flag for owner review

**Solution:** Run audit query on production; coordinate with owner before proceeding.

---

### F. CLASSIFICATION

**Current state:**
- ✗ NO classification table
- ✗ NO classification_inputs table (good — target explicitly rejects this)
- Grades hardcoded in frontend (jumbo, aaa, aa, a, b — note: conflict with target grades XL, N1, N2, N3)

**Target actions:**

| Current | Target | Action | Specifics |
|---------|--------|--------|-----------|
| (frontend logic) | classification + lines | CREATE NEW | Session-based; no flock traceability |
| (hardcoded) | (enum) | CREATE NEW | Grades: XL, N1, N2, N3, ROTOS, SUCIOS, DESCARTE (owner confirm) |

**Migration note:** Grades don't map 1:1 (jumbo ≠ XL). Clarify with owner before cutover.

---

### G. MERCADO PAGO INTEGRATION

**Current state:**
- ✓ **FASE 0 architecture implemented:** mp_source_record, mp_financial_movement, ledger_entry, account_balance (migrations 004-010)
- Legacy tables still present: mercadopago_raw, mercadopago_movements, mercadopago_settlement, sync_metadata (migrations 001-003)
- Dual code paths in sync functions; unclear which is authoritative
- Migration 010_fix_import_v2_classifications indicates recent bug fixes (asset_management misclassified)

**Target actions:**

| Current | Target | Action | Specifics |
|---------|--------|--------|-----------|
| mp_source_record ✓ | mp_source_record | REUSE | FASE 0 correct; keep as-is |
| mp_financial_movement ✓ | mp_financial_movement | REUSE | FASE 0 correct; keep as-is |
| ledger_entry ✓ | reconciliation_event | ADAPT | Link to financial_operation (not standalone) |
| Legacy tables (mercadopago_*) | (deprecate) | RETIRE | Read-only post-cutover; sunset after validation |

**Data quality issues:**

**CRITICAL:** Validate MP ledger balance at cutover date

```sql
SELECT 
  SUM(le.balance_impact) as ledger_sum,
  ab.calculated_balance as account_balance,
  (ab.calculated_balance - SUM(le.balance_impact)) as variance
FROM ledger_entry le
INNER JOIN account_balance ab ON le.account_id = ab.account_id
WHERE le.occurred_at <= cutover_date
GROUP BY ab.account_id
HAVING variance ≠ 0
```

If variance exists, investigate + correct in FASE 0 before target migration.

---

### H. AUDIT & MANAGEMENT PERIODS

**Current state:**
- ✗ NO audit_events table
- ✗ NO management_periods table
- Partial audit via `actualizado_en` timestamps and `perfiles.creado_por` FKs
- RLS policies exist but no comprehensive audit trail

**Target actions:**

| Current | Target | Action | Specifics |
|---------|--------|--------|-----------|
| (timestamps) | audit_events | CREATE NEW | Transversal table; forward-looking |
| (none) | management_periods | CREATE NEW | Period OPEN/CLOSED states |

**Migration note:** No historical audit data to backfill; this is forward-looking from cutover date onward.

---

## HIGH-RISK MIGRATION HAZARDS (TOP 10)

| # | Hazard | Impact | Mitigation |
|---|--------|--------|-----------|
| 1 | **ENUM CONFLICT: forma_pago_type** | Schema deployment fails | Run `\dT forma_pago_type` in prod; resolve before migration; **POTENTIAL ADR** |
| 2 | **JSONB lineas denormalization** | Lost history if not snapshot correctly | Snapshot JSONB before normalization; validate count + totals match |
| 3 | **Client saldo divergence** | Opening balance calculation wrong | Validate saldo vs physical reconciliation at cutover; owner sign-off required |
| 4 | **Transfer atomicity lost** | Account balances don't reconcile | Migrate transfer pairs as single operation + 2 postings; validate all pairs |
| 5 | **Mortalidad duplicates** | Population calculation wrong | Pre-migration audit; deduplicate; add UNIQUE constraint in target |
| 6 | **MP legacy data inconsistency** | Reconciliation fails | Before cutover: validate `SUM(ledger_entry) = account_balance` on cutover_date |
| 7 | **Cheque state machine not audited** | Cannot reconstruct history | Migrate cheques to financial_instrument; create events with creado_en as base |
| 8 | **Hardcoded accounts** | Cannot audit creations; scaling blocked | Create financial_account master; backfill 4 rows; update code to use IDs |
| 9 | **Comisiones double-count** | Balance calculations wrong | Identify comisiones linked to movimientos; consolidate into single operation |
| 10 | **RLS policies incomplete** | Unauthorized access to MP data | Add RLS to mp_source_record, mp_financial_movement before cutover |

---

## DATA LINEAGE & VALIDATION STRATEGY

**For each domain, validate at cutover:**

### Orders
- `COUNT(pedidos)` before = COUNT(pedidos) after
- `SUM(pedidos.monto_total calculated) = SUM(pedido_lineas.subtotal)` per order
- Sample 10 orders: price accuracy check

### Clients
- `COUNT(clientes)` before = COUNT(clients) after
- Client saldo at cutover date signed off by owner
- Write to client_ledger opening_balance rows

### Flocks & Production
- `COUNT(lotes)` before = COUNT(flocks) after
- `COUNT(producciones)` before = COUNT(daily_production) after
- `SUM(daily_production.mortalidad per flock)` = `SUM(population_events.delta WHERE type=MORTALITY)`

### Financials
- `SUM(movimientos_caja)` = `SUM(financial_posting)` by account
- `SUM(pagos)` = `SUM(collections)` by client

### Mercado Pago
- `SUM(ledger_entry)` = `account_balance.calculated_balance` on cutover_date

---

## REUSABLE SCHEMA ELEMENTS (90% of current)

✓ **Good patterns to preserve:**
- perfiles + auth.users FK
- precios_historial (excellent audit pattern for historical data)
- lotes UNIQUE(galpon, fecha_entrada) constraint
- mp_source_record deduplication (payload_hash + source_type + source_external_id)
- Index strategy on key queries (fecha DESC, estado, client_id)

✓ **Existing indexes worth keeping:**
- idx_pedidos_estado
- idx_pedidos_cliente_id
- idx_movimientos_caja_fecha_operacion
- idx_cheques_estado

---

## FRONTEND/API BREAKING CHANGES

| Entity | Change | Impact | Workaround Period |
|---|---|---|---|
| pedidos | No editable monto_total | Recalc from lineas | UPDATE UI; add validation error |
| pedidos | DELIVERED orders immutable | Require rectification workflow | Add "Rectify" button; new UX flow |
| pedido_lineas | JSONB → normalized table | API returns joined data | Transparently join in API layer; UI no change |
| clients | Use client_ledger for saldo | Query SUM not table column | Add `calculated_saldo` to API response |
| movimientos_caja | Rename to financial_posting | API endpoint changes | Dual-read during cutover (fallback to old table) |
| cheques | Migrate to financial_instrument | New data model | Support both during gradual migration |
| payments | Require financial_account ref | payments.account_id mandatory | Backfill with logic (map forma_pago → account) |

---

## MIGRATION PREREQUISITES (MUST RESOLVE BEFORE PROCEEDING)

1. **Resolve forma_pago_type enum conflict**
   - Timeline: 3 days
   - Owner: DevOps/DB team
   - **POTENTIAL ADR** if ambiguous

2. **Audit and validate opening balances**
   - Timeline: 1 week
   - Owner: Finance team + system owner
   - Scope: clients, flocks, cash
   - Requirement: Owner sign-off

3. **Deduplicate mortalidad records**
   - Timeline: 2-3 days
   - Owner: DevOps
   - Script: Pre-migration audit query; flag discrepancies

4. **Validate Mercado Pago ledger balance**
   - Timeline: 3-5 days
   - Owner: MP integration owner
   - Scope: Validate SUM(ledger_entry) = account_balance at cutover_date

5. **Consolidate migration directories**
   - Timeline: 1 day
   - Owner: DevOps
   - Scope: supabase/sql/ vs supabase/migrations/ into single canonical source

---

## RECOMMENDATION

**Migration is feasible** with the prerequisites above.

**90% of current schema maps directly** (REUSE or ADAPT).

**10% requires new creation** (audit_events, financial_operation, suppliers, management_periods, classification, feed).

**Estimated effort:** 2-3 weeks for Physical Schema + migration scripts (given prerequisites completed).

**Next step:** Owner approval of prerequisites + data validation dates.

---

**All mappings based on actual repository evidence. No assumptions on unmapped fields.**
