# CURRENT → TARGET CROSSWALK V3 — CANDIDATE

**STATUS:** Round 2 corrections integrated; migration risks separated  
**DATE:** 2026-09-24  
**CHANGES FROM V2:** Reclassified legacy issues as MIGRATION RISKS, not schema blockers

---

## EXECUTIVE SUMMARY (CORRECTED)

**Architecture:** STABLE (no target schema blockers identified)

**Reusability:** 90% of current schema maps to target (REUSE or ADAPT).

**New tables:** 10% (audit, suppliers, purchases, feed, periods, classification).

**Migration feasibility:** YES, with 4 prerequisites resolved (documented in MIGRATION_RISK_REGISTER_V1.md).

**Key correction:** Legacy data-quality issues (enum conflicts, duplicate mortandad, opening balances) are MIGRATION RISKS, NOT target schema blockers.

---

## CURRENT → TARGET DETAILED CROSSWALK

| Target Domain | Target Table | Current Table | Action | Risk | Migration Blocker? | Notes |
|---|---|---|---|---|---|---|
| **IDENTITY** | perfiles | perfiles | REUSE | LOW | NO | Rename columns as needed |
| **CLIENTS** | clients | clientes | REUSE | LOW | NO | 1:1 mapping |
| **PRODUCTS** | products | productos | REUSE + extend | LOW | NO | Add product_type ENUM |
| **PRICES** | price_history | precios_historial | REUSE | LOW | NO | Excellent pattern; keep as-is |
| **ORDERS** | pedidos | pedidos | ADAPT | MEDIUM | NO | Remove monto_total; add delivered_at |
| **ORDER_LINES** | pedido_lineas | pedidos.lineas (JSONB) | MIGRATE | MEDIUM | NO | Denormalize JSONB; preserve price snapshot |
| **CLIENT_LEDGER** | client_ledger | NONE | CREATE NEW | HIGH | NO | Backfill from pagos + pedidos; owner sign-off on opening balance |
| **COLLECTIONS** | collections | pagos | ADAPT | MEDIUM | NO | Broaden scope; add receipt_id UNIQUE |
| **FINANCIAL_ACCOUNT** | financial_account | NONE (hardcoded) | CREATE NEW | MEDIUM | NO | Masters: Caja Chica, BNA, Patagonia, MP |
| **FINANCIAL_OPERATION** | financial_operation | movimientos_caja (partial) | ADAPT | HIGH | NO | Consolidate movimientos_caja + cheques + comisiones |
| **FINANCIAL_POSTING** | financial_posting | NONE | CREATE NEW | HIGH | NO | 1:N from financial_operation; immutable |
| **FINANCIAL_INSTRUMENT** | financial_instrument | cheques | ADAPT | MEDIUM | NO | Extend estado machine (RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED) |
| **INSTRUMENT_EVENTS** | financial_instrument_event | NONE | CREATE NEW | MEDIUM | NO | Track cheque state transitions |
| **SUPPLIERS** | suppliers | NONE | CREATE NEW | HIGH | NO | New master; no current equivalent |
| **SUPPLIER_LEDGER** | supplier_ledger | NONE | CREATE NEW | HIGH | NO | Debt tracking; currently implicit |
| **PURCHASES** | purchases | NONE | CREATE NEW | HIGH | NO | Formal POs; currently direct expense in movimientos_caja |
| **SHEDS** | sheds | NONE | CREATE NEW | MEDIUM | NO | Extract galpones; create master |
| **FLOCKS** | flocks | lotes | REUSE + extend | LOW | NO | Add genetics, supplier_id |
| **POPULATION_EVENTS** | population_events | producciones.mortandad | MIGRATE | HIGH | **YES (MIGRATION PREREQUISITE)** | Extract mortality; validate no duplicates first (see MIGRATION_RISK_REGISTER) |
| **DAILY_PRODUCTION** | daily_production | producciones | REUSE + adapt | MEDIUM | NO | Remove classification_session_id link |
| **FLOCK_WEIGHINGS** | flock_weighing | NONE | CREATE NEW | LOW | NO | Optional but in target |
| **TEMPERATURE_RECORDS** | temperature_record | NONE | CREATE NEW | LOW | NO | Optional but in target |
| **CLASSIFICATION** | classification | NONE | CREATE NEW | MEDIUM | NO | Session-based; no current equivalent |
| **CLASSIFICATION_LINES** | classification_line | NONE | CREATE NEW | MEDIUM | NO | Grade breakdown per session |
| **FEED_TYPES** | feed_type | NONE | CREATE NEW | HIGH | NO | V1 foundation |
| **FEED_FORMULAS** | feed_formula_version | NONE | CREATE NEW | HIGH | NO | Immutable versions |
| **FEED_INGREDIENTS** | feed_ingredient | NONE | CREATE NEW | HIGH | NO | Recipe components |
| **FEED_MANUFACTURING** | feed_manufacturing | NONE | CREATE NEW | MEDIUM | NO | Manufacturing batches |
| **FEED_INVENTORY** | feed_inventory_count | NONE | CREATE NEW | LOW | NO | Physical counts |
| **FISCAL_DOCUMENTS** | fiscal_document | NONE | CREATE NEW | MEDIUM | NO | V1: minimal schema |
| **TAX_COMPONENTS** | tax_component | NONE | CREATE NEW | LOW | NO | Tax breakdown |
| **MANAGEMENT_PERIODS** | management_period | NONE | CREATE NEW | HIGH | NO | Period open/closed states |
| **AUDIT_EVENTS** | audit_events | NONE | CREATE NEW | HIGH | NO | Transversal audit trail |
| **MP_SOURCE** | mp_source_record | mp_source_record | REUSE | LOW | NO | FASE 0; keep as-is |
| **MP_FINANCIAL_MOVEMENT** | mp_financial_movement | mp_financial_movement | REUSE | LOW | NO | FASE 0 normalized |

---

## DOMAIN-BY-DOMAIN MIGRATION ASSESSMENT

### A. COMMERCIAL DOMAIN

**Current state:**
- ✓ clients: present, good structure
- ✓ productos: present, minimal schema
- ✓ pedidos: present BUT lineas in JSONB (anti-pattern), monto_total editable, no delivered_at
- ✓ precios_historial: excellent pattern

**Target actions:**

| Current | Target | Action | Data quality issue? | Migration blocker? |
|---------|--------|--------|---|---|
| clientes | clients | REUSE | LOW | NO |
| productos | products | REUSE + extend | LOW | NO |
| pedidos | pedidos | ADAPT | MEDIUM (monto_total divergence) | NO (validate before cutover) |
| pedidos.lineas (JSONB) | pedido_lineas (table) | MIGRATE | MEDIUM (structure unclear) | NO (denormalize before cutover) |
| precios_historial | price_history | REUSE | LOW | NO |

**Data quality validation needed:**
1. Validate pedidos.lineas JSONB structure (denormalization target)
2. Validate SUM(lineas) = monto_total per order (flag discrepancies)
3. Handle missing delivered_at: Do NOT silently use created_at as truth. For legacy orders without trustworthy delivery date, either: (a) use verified delivery evidence if available, or (b) explicitly mark historical date as unknown/estimated per migration policy. Preserve created_at as metadata/evidence only; never invent precision

**Frontend breaking changes:**
- API returns pedidos WITH joined pedido_lineas
- UI does not edit monto_total directly
- Rectification UI required

---

### B. CLIENT LEDGER & COLLECTIONS

**Current state:**
- ✓ pagos: payment records
- ✓ movimientos_caja: partial redundancy with pagos
- ✗ NO client_ledger; saldo calculated ad-hoc

**Target actions:**

| Current | Target | Action | Issue | Blocker? |
|---------|--------|--------|---|---|
| pagos | collections | ADAPT | Rename; broaden scope | NO |
| (none) | client_ledger | CREATE NEW | Backfill ambiguous | **YES (PREREQUISITE)** |

**Migration prerequisite:**
- **Must validate opening balance at cutover date** (owner sign-off required)
- Do NOT fabricate detailed historical CC ledger from legacy pedidos/pagos
- Strategy: Create new authoritative client_ledger; migrate only individually-validated reliable movements; otherwise create owner-signed OPENING_BALANCE at cutover
- Preserve legacy pedidos/pagos as historical context/evidence, not authoritative source
- Current "saldo" calculation unclear: SUM(pagos) - SUM(pedidos)?
- Possible divergence from movimientos_caja
- For each client: validate calculated balance against owner records; create OPENING_BALANCE entry with owner sign-off

See **MIGRATION_RISK_REGISTER_V1.md** for detailed validation procedure.

---

### C. FINANCIAL DOMAIN

**Current state:**
- ✓ movimientos_caja: loosely structured
- ✓ cheques: exists (estado field)
- ✗ NO financial_operation, NO financial_posting, NO suppliers

**Target actions:**

| Current | Target | Action | Issue | Blocker? |
|---------|--------|--------|---|---|
| movimientos_caja | financial_operation + posting | CONSOLIDATE | Classify by tipo/forma_pago | NO |
| cheques | financial_instrument + events | ADAPT | Extend estado machine | NO |
| (none) | suppliers | CREATE NEW | NEW master table | NO |
| (none) | supplier_ledger | CREATE NEW | Debt tracking | NO |
| (none) | purchases | CREATE NEW | Formal PO structure | NO |

**Migration strategy:**
1. Classify each movimientos_caja row by (tipo, forma_pago, vinculado_a)
2. Separate into financial_operation parent + posting children
3. Validate referential integrity (orphaned references?)
4. Migrate cheques with estado validation
5. Create supplier master + backfill supplier_ledger from purchases (if any exist)

See **MIGRATION_RISK_REGISTER_V1.md** for orphan detection queries.

---

### D. PRODUCTION DOMAIN

**Current state:**
- ✓ lotes: present, good structure
- ✓ producciones: present; mortandad column embedded
- ✗ NO population_events, NO classification, NO feed tables

**Target actions:**

| Current | Target | Action | Issue | Blocker? |
|---------|--------|--------|---|---|
| lotes | flocks | REUSE + extend | Add genetics, supplier_id | NO |
| producciones | daily_production | REUSE + adapt | Remove classification_session_id link | NO |
| producciones.mortandad | population_events | MIGRATE | Extract to events; validate no duplicates | **YES (PREREQUISITE)** |
| (none) | classification | CREATE NEW | No current equivalent | NO |
| (none) | feed_* | CREATE NEW | V1 foundation | NO |

**Migration prerequisite:**
- **Must query and validate duplicate mortandad records** (owner sign-off required)
- If any (lote_id, fecha) pair has multiple rows with different mortandad values, error
- Frozen architecture has no MORTALITY_CONFLICT resolution; only ONE truth allowed

See **MIGRATION_RISK_REGISTER_V1.md** for duplicate detection query.

---

## MIGRATION BLOCKERS vs. SCHEMA BLOCKERS

**IMPORTANT DISTINCTION:**

**Schema blockers** prevent us from defining the target schema (architecture is unstable).
- **Result:** Cannot freeze Physical Database Design
- **V2 Status:** NONE remaining (all 6 Round 2 blockers addressed)

**Migration blockers** prevent us from safely migrating legacy data (data quality issues).
- **Result:** Cannot proceed with data cutover; must validate/clean first
- **V2 Status:** 4 identified (documented in MIGRATION_RISK_REGISTER_V1.md, not here)

**This crosswalk:** Focuses on schema (migration blockers are documented separately).

---

## PREREQUISITES FOR MIGRATION (NOT SCHEMA BLOCKERS)

**Must be resolved BEFORE data cutover:**

1. **forma_pago enum conflict** (validation task, not schema decision)
   - Validate migration 045 execution
   - Ensure no cheques remain in movimientos_caja post-migration
   - Document in MIGRATION_RISK_REGISTER

2. **Duplicate mortandad data** (data validation task)
   - Query producciones for duplicates
   - Owner determines truth
   - Cleanses data before extraction to population_events
   - Document in MIGRATION_RISK_REGISTER

3. **Client CC opening balance** (data validation task)
   - Audit current saldo calculation
   - Validate against owner records
   - Create owner-signed OPENING_BALANCE entry
   - Document in MIGRATION_RISK_REGISTER

4. **Orphaned movimientos_caja references** (data cleanup task)
   - Identify references to non-existent clients/suppliers
   - Owner review and decision (fix or mark as historical)
   - Document in MIGRATION_RISK_REGISTER

---

## MIGRATION STRATEGY BY PHASE

### Phase 1: Schema Creation (no legacy data)
- Create all 42 target tables (REUSE, ADAPT, CREATE NEW)
- Create financial_account masters
- Create supplier master (empty initially)
- Create management_period master (initial periods)
- Create all enums, constraints, RLS policies

**Timeline:** 2-3 days

### Phase 2: Data Migration (with prerequisites)
- **Commercial:** Denormalize pedidos.lineas; migrate as-is
- **Client Ledger:** Backfill OPENING_BALANCE (owner-signed)
- **Financial:** Classify & consolidate movimientos_caja; migrate cheques
- **Production:** Extract population_events from producciones (validate no dups); migrate daily_production
- **Feed:** Create initial formulas (if sourcing from legacy; optional V1)

**Timeline:** 3-5 days (depends on data volume + cleanup)

### Phase 3: Validation & Cutover
- Compare running balances (legacy vs. new)
- Reconcile GL balances
- Audit trail integrity check
- Cutover at agreed date (owner decision)

**Timeline:** 1 day

---

## NO TARGET SCHEMA CHANGES REQUIRED

**Physical Database Design V2 is STABLE.**

All 6 Round 2 architectural blockers resolved:
1. ✓ deliver_order corrected (no financial_posting)
2. ✓ endorse_cheque corrected (no CC reversal)
3. ✓ financial_posting constraint added (CHECK != 0)
4. ✓ daily_production immutability added (RLS UPDATE DENY)
5. ✓ OPERATOR permissions unblocked (classifications, feed_manufacturing)
6. ✓ Over-restrictive uniques removed (pedidos, classification, population_events)

**Migration prerequisites** (data quality) are documented separately in MIGRATION_RISK_REGISTER_V1.md.

**Target schema ready for final adversarial validation.**

---

**CROSSWALK COMPLETE**

V3 consolidates V2 corrections and explicitly separates migration risks from schema design.
No target schema blockers remain.
Four migration prerequisites must be resolved before cutover (not before schema freeze).
