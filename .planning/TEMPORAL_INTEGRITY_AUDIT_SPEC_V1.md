# TEMPORAL INTEGRITY & AUDIT SPECIFICATIONS V1

**STATUS:** Ready for implementation  
**DATE:** 2026-09-24  
**BASED ON:** TARGET_ARCHITECTURE_V2_FROZEN.md (Parts 20, 21, 22) + PHYSICAL_DATABASE_DESIGN_V2_CANDIDATE.md + TRANSACTION_CATALOG_V2_CANDIDATE.md

---

## EXECUTIVE SUMMARY

This specification defines how temporal rules and audit mechanisms are enforced across Granja Santo Tomás ERP:

- **10 critical frozen rules** verified for implementability
- **Key tables and RPCs** with explicit temporal and immutability enforcement
- **Audit patterns** for who, what, when, why
- **Rectification semantics** preserving history while ensuring uniqueness
- **Period closure integrity** protecting all domains transversally

**All frozen rules are IMPLEMENTABLE.** No temporal constraints require architecture changes.

---

## PART 1: CRITICAL FROZEN RULES (VERIFICATION MATRIX)

### Rule 1: created_at NEVER determines period

**Frozen Statement:** (PART 20, PART 1)
> Economic period determined by effective_date, delivered_at, event_date, economic_date (per entity)
> created_at is metadata only

**Implementability:** ✓ IMPLEMENTABLE

**Implementation:**

| Table | Period Determinant | RPC Validation | Frozen? |
|-------|-------------------|---|---|
| pedidos | delivered_at | deliver_order | YES |
| client_ledger | effective_date | register_collection | YES |
| financial_posting | effective_date | transfer_between_accounts | YES |
| population_events | event_date | register_mortality | YES |
| daily_production | production_date | register_daily_production | YES |
| classification | session_date | register_classification | YES |
| feed_manufacturing | manufacturing_date | register_feed_manufacturing | YES |
| purchases | economic_date | register_purchase | YES |
| financial_instrument | received_date (event_date varies) | receive_cheque, clear_cheque | YES |

**Constraint:** No CHECK on created_at. Explicit RPC validation required for each operation.

**Implementer guideline:** Period determined per-operation; never use database DEFAULT CURRENT_TIMESTAMP for period determination.

---

### Rule 2: Period OPEN required for new facts

**Frozen Statement:** (PART 20)
> Every INSERT/UPDATE with effective_date in period MUST check period.status = 'OPEN'
> If period is between months (effective_date = Sept 5, but period closes Sept 3): do NOT silently insert
> Error message explicit

**Implementability:** ✓ IMPLEMENTABLE

**RPC Validation Pattern (all RPCs):**

```sql
-- Before any INSERT/UPDATE with period-determining fact:
SELECT management_period 
  WHERE periodo_fecha <= period_date_arg 
    AND periodo_fecha + INTERVAL '1 month' > period_date_arg
  FOR UPDATE;
  
IF NOT FOUND RAISE ERROR "Period not found for date " || period_date_arg;
IF status = 'CLOSED' RAISE ERROR 
  "Period " || periodo_fecha || " is CLOSED. Reopen period to record fact on " || period_date_arg;
```

**Application to operations:**

| Operation | Period-determining field | RPC enforcement | Error message |
|-----------|---|---|---|
| deliver_order | delivered_at | BEGIN RPC | "Cannot deliver order; period [YYYY-MM] closed. Reopen period to record delivery on [YYYY-MM-DD]." |
| register_collection | effective_date | BEGIN RPC | "Cannot record collection; period [YYYY-MM] closed. Reopen period to record on [YYYY-MM-DD]." |
| register_mortality | event_date | BEGIN RPC | "Cannot record mortality; period [YYYY-MM] closed. Reopen period to record event on [YYYY-MM-DD]." |
| register_classification | session_date | BEGIN RPC | "Cannot register classification; period [YYYY-MM] closed. Reopen period for [YYYY-MM-DD]." |
| register_purchase | economic_date | BEGIN RPC | "Cannot record purchase; period [YYYY-MM] closed. Reopen period for economic date [YYYY-MM-DD]." |
| transfer_between_accounts | effective_date | BEGIN RPC | "Cannot transfer; period [YYYY-MM] closed. Reopen period for transfer on [YYYY-MM-DD]." |
| register_feed_manufacturing | manufacturing_date | BEGIN RPC | "Cannot record manufacturing; period [YYYY-MM] closed. Reopen period for [YYYY-MM-DD]." |

**Lock strategy:** SELECT FOR UPDATE on management_period ensures atomicity (prevents race on period status check).

**Implementer guideline:** Every RPC that creates/updates a period-determining fact MUST begin with explicit period validation. This is transversal; no exceptions.

---

### Rule 3: Period CLOSED prevents mutation

**Frozen Statement:** (PART 20)
> No INSERT/UPDATE with effective_date in closed period
> Exception: ADMIN can reopen period (reason + audit)
> Does it automatically close out that period's facts? Or does owner manually reopen, correct fact, and close again?

**Implementability:** ✓ IMPLEMENTABLE

**Answer to frozen question:** Owner manually reopens, corrects fact, and closes again.

**Rationale:** Automatic closure would require complex reconciliation logic and be error-prone. Manual workflow is explicit and auditable.

**Reopen semantics:**

| Step | Action | Audit |
|------|--------|-------|
| 1 | ADMIN calls reopen_management_period(period_id, reason) | INSERT audit_event(entity_type='management_period', action='REOPEN', reason, performed_by) |
| 2 | Check: NO locked/pending facts in that period? (business logic warning) | audit_event documents potential conflicts |
| 3 | UPDATE management_period SET status='OPEN', closed_at=NULL, closed_by=NULL | Immutable: record CLOSED state BEFORE reopen |
| 4 | ADMIN corrects fact (calls appropriate RPC again) | RPC audit captures correction |
| 5 | ADMIN calls close_management_period(period_id, reason) | INSERT audit_event(action='CLOSE', reason, performed_by) |

**Implementer guideline:** Reopening is explicit admin action. No automatic cascade. Reopening does NOT close out facts; it allows further edits.

---

### Rule 4: Immutable snapshots

**Frozen Statement:** (PART 24, PART 2 PART 4)
> precio_unitario: SNAPSHOT at order line creation; NEVER changes
> producto_nombre: SNAPSHOT; NEVER changes
> ledger_client_name: SNAPSHOT in client_ledger; NEVER changes
> formula_version_id in feed_manufacturing: IMMUTABLE reference; NEVER changed mid-batch

**Implementability:** ✓ IMPLEMENTABLE (with specific enforcement per column)

**Enforcement matrix:**

| Column | Table | Enforcement | Mechanism | Error/Constraint |
|--------|-------|---|---|---|
| precio_unitario | pedido_lineas | SNAPSHOT + GENERATED | Immutable on INSERT; subtotal GENERATED ALWAYS AS (cantidad * precio_unitario) | DB-enforced: NOT NULL, NEVER UPDATE |
| producto_nombre | pedido_lineas | SNAPSHOT + Denormalized | Captured at order creation; NOT updated even if product master changes | RLS UPDATE DENY on pedido_lineas |
| subtotal | pedido_lineas | GENERATED ALWAYS | NUMERIC(15,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED | DB-enforced: cannot be modified directly |
| ledger_client_name | client_ledger | SNAPSHOT | VARCHAR(255) captured from clients.nombre at posting time | RLS UPDATE/DELETE DENY on client_ledger (append-only) |
| formula_version_id | feed_manufacturing | FK IMMUTABLE | UUID FK → feed_formula_version (IMMUTABLE once manufacturing starts) | RPC validates: cannot UPDATE manufacturing.formula_version_id |

**Immutability enforcement rules:**

1. **precio_unitario & producto_nombre:** No UPDATE via RLS. Once DELIVERED, entire pedido is immutable except via rectification RPC.
2. **subtotal:** GENERATED ALWAYS AS ensures mathematical correctness; immutable by definition.
3. **ledger_client_name:** Captured at INSERT; ledger is append-only (no UPDATE/DELETE).
4. **formula_version_id:** Immutable once feed_manufacturing record created. No UPDATE allowed. RPC check: IF formula_version_id != stored_id RAISE ERROR "Cannot change formula mid-batch."

**Implementer guideline:** Immutability must be enforced at DB layer (RLS or GENERATED), not application layer.

---

### Rule 5: Append-only ledger tables

**Frozen Statement:** (PART 21, PART 4)
> No UPDATE/DELETE on: client_ledger, financial_posting, population_events, supplier_ledger, audit_events, feed_inventory_count, mp_source_record
> Implemented via RLS UPDATE USING FALSE; DELETE USING FALSE
> No triggers needed (RLS sufficient)
> What about accidental INSERT of duplicate? (UNIQUE constraint or RPC check?)

**Implementability:** ✓ IMPLEMENTABLE

**RLS policies for append-only tables:**

```sql
CREATE POLICY append_only_no_update ON <table> FOR UPDATE USING FALSE;
CREATE POLICY append_only_no_delete ON <table> FOR DELETE USING FALSE;
```

**Applied to:**

| Table | RLS Policy | UNIQUE/FK for duplicates |
|-------|---|---|
| client_ledger | UPDATE DENY; DELETE DENY | APPEND_ONLY; FK (cliente_id); no duplicate constraint (multiple movements per client OK) |
| financial_posting | UPDATE DENY; DELETE DENY | APPEND_ONLY; FK (financial_operation_id, financial_account_id); CHECK(signed_amount != 0) |
| population_events | UPDATE DENY; DELETE DENY | APPEND_ONLY; UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' (allows multiple COUNT_ADJUSTMENT) |
| supplier_ledger | UPDATE DENY; DELETE DENY | APPEND_ONLY; FK (supplier_id); no duplicate constraint |
| audit_events | UPDATE DENY; DELETE DENY | APPEND_ONLY; Forensic immutability; no duplicates possible (unique action per timestamp) |
| feed_inventory_count | UPDATE DENY; DELETE DENY | APPEND_ONLY; UNIQUE(feed_type_id, count_date) — prevents double-count same day, not same-feed across days |
| mp_source_record | UPDATE DENY; DELETE DENY | APPEND_ONLY; UNIQUE(mp_transaction_id) via FASE 0 design |

**Duplicate handling:**

| Scenario | Prevention | Error handling |
|----------|------------|---|
| Duplicate collection receipt | receipt_id UNIQUE on collections table | RPC pre-check: IF receipt_id exists RAISE ERROR "Receipt already recorded" |
| Duplicate transfer | transfer_id UNIQUE on financial_operation | RPC pre-check: IF transfer_id exists RAISE ERROR "Transfer already recorded" |
| Duplicate mortality on (flock, date) | UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' | RPC pre-check: REJECT on duplicate; inform operator of existing mortality + value |
| Duplicate purchase invoice | invoice_num UNIQUE on purchases | RPC pre-check: IF invoice exists RAISE ERROR "Invoice already recorded" |
| Duplicate classification session | idempotency_key UNIQUE on classification | RPC pre-check: IF idempotency_key exists RAISE ERROR (silent retry OK; session already recorded) |

**Implementer guideline:** RLS enforces immutability; RPC checks enforce idempotency. No triggers needed for immutability; triggers would be redundant.

---

### Rule 6: No silent mutation of posted facts

**Frozen Statement:** (PART 20, PART 21)
> delivered_order.estado = DELIVERED: cannot UPDATE
> financial_posting: cannot UPDATE
> daily_production: cannot UPDATE (immutable after posting)
> What "posting" means per entity? (economic posting via RPC completion? manual flag? timestamp-based?)

**Implementability:** ✓ IMPLEMENTABLE

**"Posted" definition per entity:**

| Entity | "Posted" means | Enforcement | RLS/Trigger |
|--------|---|---|---|
| pedidos (DELIVERED) | deliver_order RPC successfully executed; estado='DELIVERED' | Cannot UPDATE estado; cannot UPDATE total | RLS UPDATE DENY on DELIVERED rows |
| financial_posting | financial_operation confirmed (INSERT financial_posting = posted) | Cannot UPDATE signed_amount or effective_date | RLS UPDATE DENY on financial_posting |
| daily_production | INSERT daily_production record (same-day or end-of-day snapshot) | Cannot UPDATE after production_date passed | RLS UPDATE DENY if production_date <= current_date |
| client_ledger | INSERT client_ledger entry (economic event recorded) | Cannot UPDATE amount, effective_date, or type | RLS UPDATE DENY on client_ledger (append-only) |
| classification | classification session posted (INSERT classification_line records complete) | Cannot UPDATE classification_line once session complete | RLS UPDATE DENY once session_date closed (status check) |
| population_events | INSERT population_events record (mortality/adjustment recorded) | Cannot UPDATE delta or event_date | RLS UPDATE DENY on population_events |

**Immutability enforcement:**

1. **pedidos (DELIVERED):** RLS policy on pedidos: `UPDATE ... WHERE estado != 'DELIVERED'`
2. **financial_posting:** RLS policy: UPDATE USING FALSE (pure append-only)
3. **daily_production:** RLS policy: UPDATE USING FALSE after production_date closed (period-based)
4. **client_ledger:** RLS policy: UPDATE USING FALSE (pure append-only)
5. **classification:** RLS policy: UPDATE USING FALSE once session complete (period-based)
6. **population_events:** RLS policy: UPDATE USING FALSE (pure append-only)

**Implementer guideline:** "Posted" = data committed via RPC; no explicit flag needed. Immutability enforced via RLS based on estado, table append-only status, or period closure.

---

### Rule 7: Rectification patterns (preserve history)

**Frozen Statement:** (PART 3, PART 11, PART 20)
> deliver_order → rectify_delivered_order: create reversals + new entry + audit
> mortality → rectify_mortality: preserve original via supersession; mark superseded_by; insert new marked is_current
> classification: immutable once session posted (no rectification in V1)
> purchase → rectify_purchase: reverse + new entry + audit
> How is "supersession" tracked for queries? (is_current=true in WHERE for current facts; LEFT JOIN to find original?)

**Implementability:** ✓ IMPLEMENTABLE

**Rectification patterns per entity:**

#### Pattern A: Compensating Entry (Sales, Purchases, Collections)

**Entities:** deliver_order rectification, register_purchase rectification, collection reversal

**Pattern:**

```
1. Create REVERSAL/COMPENSATING entry with opposite amount
2. Create NEW entry with corrected amount
3. Preserve both in history via append-only
4. Audit captures before/after + reason
5. NO UPDATE of original (immutable)
```

**Example: rectify_delivered_order**

```sql
BEGIN TRANSACTION
  -- 1. Create compensating client_ledger entry (reverse original debt)
  INSERT client_ledger (
    cliente_id, 
    movement_type='REVERSAL', 
    signed_amount=-original_order_total,
    effective_date=original_delivered_at,
    ledger_client_name,
    created_by
  )
  
  -- 2. Create new client_ledger entry (record corrected debt)
  INSERT client_ledger (
    cliente_id,
    movement_type='SALE_DELIVERY',
    signed_amount=corrected_order_total,
    effective_date=original_delivered_at,
    ledger_client_name,
    created_by
  )
  
  -- 3. Audit complete before/after
  INSERT audit_event (
    entity_type='pedido',
    entity_id=order_id,
    action='RECTIFY',
    before_values={original_total, estado},
    after_values={corrected_total, estado},
    reason=rectification_reason,
    performed_by,
    performed_at
  )
COMMIT
```

**Query for current balance:**

```sql
SELECT cliente_id, SUM(signed_amount) as balance
FROM client_ledger
WHERE cliente_id = ?
GROUP BY cliente_id
```

No is_current flag needed; balance is cumulative SUM.

---

#### Pattern B: Supersession (Mortality, Population Events)

**Entities:** rectify_mortality, register_mortality (duplicate rejection)

**Pattern:**

```
1. Original event remains immutable in DB
2. New event created with is_current=true
3. superseded_by links new→old
4. Queries filter to is_current=true for effective population
5. Audit captures before/after + reason
```

**Schema additions (optional but recommended):**

```sql
ALTER TABLE population_events ADD COLUMN (
  superseded_by BIGINT REFERENCES population_events(id) NULLABLE,
  is_current BOOLEAN DEFAULT true,
  superseded_at TIMESTAMPTZ NULLABLE
);

-- Uniqueness enforces only ONE current mortality per (flock, date)
CREATE UNIQUE INDEX mortality_unique_current 
  ON population_events(flock_id, event_date) 
  WHERE event_type='MORTALITY' AND is_current=true;
```

**Example: rectify_mortality**

```sql
BEGIN TRANSACTION
  -- 1. Mark original as superseded
  UPDATE population_events 
    SET superseded_by=new_event_id, is_current=false, superseded_at=NOW()
    WHERE id=original_event_id
  
  -- 2. Insert new corrected event
  INSERT population_events (
    flock_id,
    event_type='MORTALITY',
    delta=corrected_delta,
    event_date=original_event_date,
    is_current=true,
    created_by
  )
  
  -- 3. Audit
  INSERT audit_event (
    entity_type='population_event',
    entity_id=original_event_id,
    action='RECTIFY',
    before_values={original_delta},
    after_values={corrected_delta},
    reason,
    performed_by,
    performed_at
  )
COMMIT
```

**Query for current population:**

```sql
SELECT flock_id, SUM(delta) as current_population
FROM population_events
WHERE flock_id = ? AND is_current = true
GROUP BY flock_id
```

**Query for history:**

```sql
SELECT *
FROM population_events
WHERE flock_id = ?
ORDER BY event_date, created_at
-- Shows original + all supersessions with audit trail
```

---

### Rule 8: Reversal vs Rectification

**Frozen Statement:** (PART 3)
> REVERSAL: create opposite-sign ledger entry (e.g., CHEQUE_REJECTED creates +amount reversal)
> RECTIFICATION: replace original (mortality: supersedes original; purchase: reverse + new)
> Both preserve history via audit
> Are these mechanically different or conceptually?

**Implementability:** ✓ IMPLEMENTABLE

**Distinction:**

| Aspect | Reversal | Rectification |
|--------|----------|---|
| **When used** | Unplanned event (cheque bounces, payment rejected) | Planned correction (wrong number recorded, incorrect price) |
| **Mechanism** | Compensating entry opposite-sign | Compensating entry + new entry |
| **History** | Original + reversal both visible in ledger | Original (superseded) + new both visible |
| **Client/supplier impact** | Debt restored (if applicable) | Debt corrected |
| **Approval** | May not require ADMIN (payment rejection is auto) | Requires ADMIN authorization |
| **Audit reason** | Describes reversal reason | Describes original error + correction |
| **Example** | Cheque rejected → INSERT client_ledger(CHEQUE_REJECTED, +amount) | Mortality recorded as 5 but actually 7 → supersede + new record |

**Mechanical difference:**

- **Reversal:** Single INSERT ledger entry with opposite sign; type = REVERSAL/CHEQUE_REJECTED/etc.
- **Rectification:** INSERT ledger reversal + INSERT ledger new value; tracked via supersession or double-entry.

**Implementer guideline:** Both are append-only (no UPDATE of original). Reversal is unidirectional; rectification is bidirectional (reversal + new).

---

### Rule 9: Audit trail

**Frozen Statement:** (PART 21)
> Every INSERT/UPDATE/DELETE recorded in audit_events
> Columns: entity_type, entity_id, action, before_values (JSONB), after_values (JSONB), reason, performed_by, performed_at
> Who populates audit_events? (RPC? trigger? application?)
> Transactional consistency: is audit_event INSERT part of the RPC transaction?

**Implementability:** ✓ IMPLEMENTABLE

**Answer:** RPC populates audit_events as part of transaction.

**Audit event schema:**

```sql
CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(100) NOT NULL,  -- 'pedido', 'client_ledger', 'population_event', etc.
  entity_id VARCHAR(100) NOT NULL,    -- UUID or BIGINT of affected record
  action VARCHAR(50) NOT NULL,        -- 'INSERT', 'UPDATE', 'DELETE', 'RECTIFY', 'REJECT', 'REOPEN'
  before_values JSONB NULLABLE,       -- Previous state (only for UPDATE/DELETE/RECTIFY)
  after_values JSONB NULLABLE,        -- New state (only for INSERT/UPDATE/RECTIFY)
  reason TEXT NULLABLE,               -- Business reason (for RECTIFY, REJECT, REOPEN)
  performed_by UUID NOT NULL REFERENCES perfiles(id),
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  APPEND_ONLY: No UPDATE/DELETE via RLS
);
```

**Audit capture per operation:**

| Operation | entity_type | action | before_values | after_values | reason | Timing |
|-----------|---|---|---|---|---|---|
| deliver_order | pedido | INSERT | NULL | {estado, delivered_at} | NULL | End of RPC (commit) |
| register_collection | collection | INSERT | NULL | {amount, method, receipt_id} | NULL | End of RPC |
| register_mortality | population_event | INSERT | NULL | {delta, event_date} | NULL | End of RPC |
| rectify_mortality | population_event | RECTIFY | {original delta} | {corrected delta} | "Recounted; was 5, actually 7" | End of RPC |
| reject_cheque (RECEIVED→REJECTED) | financial_instrument | REJECT | {RECEIVED} | {REJECTED} | "Cheque returned NSF" | End of RPC |
| reject_cheque (CLEARED→REJECTED) | financial_instrument | REJECT | {CLEARED, amount} | {REJECTED, amount} | "Bank reversal" | End of RPC |
| reopen_management_period | management_period | REOPEN | {status=CLOSED, closed_at} | {status=OPEN, closed_at=NULL} | "Need to record late delivery" | End of RPC |
| close_management_period | management_period | CLOSE | {status=OPEN} | {status=CLOSED, closed_at} | "Monthly closing" | End of RPC |
| rectify_delivered_order | pedido | RECTIFY | {delivered_amount} | {corrected_amount} | "Price recalculation" | End of RPC |

**Transactional consistency:**

- Audit INSERT is **PART OF RPC TRANSACTION**
- If RPC fails → no audit entry (audit is inside BEGIN/COMMIT boundary)
- If RPC succeeds → audit entry committed atomically with data

**Implementer guideline:** Audit is never optional. Every state-changing RPC MUST insert audit_event before COMMIT.

---

### Rule 10: Management period lifecycle

**Frozen Statement:** (PART 20)
> created: INSERT management_period (id, periodo_fecha, status='OPEN')
> OPEN: allows new facts with effective_date in that period
> CLOSED: status='CLOSED', closed_at, closed_by
> Closure integrity: RPC checks that NO PENDING/DRAFT facts remain?
> Reopen: ADMIN, reason mandatory, audit entry
> How is periodo_fecha determined? (first day of month? explicit?)

**Implementability:** ✓ IMPLEMENTABLE

**Period lifecycle:**

| Step | Action | Validation | Audit | RPC |
|------|--------|---|---|---|
| **Create** | INSERT period (periodo_fecha=YYYY-MM-01, status='OPEN') | periodo_fecha must be first of month | audit_events: action='CREATE' | create_management_period |
| **OPEN** | Period active; allows INSERT/UPDATE for facts with effective_date in [periodo_fecha, periodo_fecha+1 month) | Period must exist (SELECT period FOR UPDATE) | N/A (no action during OPEN) | N/A |
| **Close** | ADMIN calls close_management_period(period_id, reason) | All period-determining facts with effective_date in that period must be complete (no DRAFT/PENDING) | audit_events: action='CLOSE', reason, closed_by, closed_at | close_management_period RPC |
| **CLOSED** | Period locked; no INSERT/UPDATE allowed for facts in this period | (See Rule 2 enforcement) | N/A | N/A |
| **Reopen** | ADMIN calls reopen_management_period(period_id, reason) | Only ADMIN; reason mandatory; must exist prior closure | audit_events: action='REOPEN', reason, performed_by | reopen_management_period RPC |
| **OPEN again** | Period available for correction/new facts | Period check passes (status='OPEN') | N/A | N/A |

**Period determination:**

```
periodo_fecha = YYYY-MM-01 (first day of month)
Effective date range: [periodo_fecha, periodo_fecha + INTERVAL '1 month')

Example:
  Management period: 2026-09-01 (September)
  Effective dates belonging to Sept 2026: 2026-09-01 through 2026-09-30
  Late September fact (e.g., delivered on 2026-09-25): belongs to Sept 2026 period
  October fact (2026-10-05): belongs to Oct 2026 period; Sept period cannot accept it
```

**Closure integrity check:**

```sql
-- Before closing period, warn about unfinalized facts (non-enforcement, just notification)
SELECT entity_type, COUNT(*) as count
FROM (
  SELECT 'pedido' as entity_type FROM pedidos WHERE estado='PENDING' AND created_at BETWEEN period_date AND period_date+INTERVAL '1 month'
  UNION ALL
  SELECT 'financial_posting' FROM financial_posting WHERE status='DRAFT' AND effective_date BETWEEN period_date AND period_date+INTERVAL '1 month'
) as unfinalized
GROUP BY entity_type;

-- If results found: admin gets warning (business logic; RPC does NOT refuse closure)
-- Admin may choose to defer closure or manually finalize remaining facts
```

**Implementer guideline:** Closure does NOT auto-finalize facts. It prevents NEW facts. Unfinalized facts are admin's responsibility.

---

## PART 2: TEMPORAL RULES ENFORCEMENT MATRIX (BY TABLE)

### A. COMMERCIAL DOMAIN

#### Table: pedidos (Orders)

**EFFECTIVE_DATE_RULE:**

| Rule | Value | Enforcement |
|------|-------|---|
| **Period determinant** | delivered_at | deliver_order RPC validates period OPEN |
| **Allow future date?** | NO (frozen: sales are economic events, not forecasts) | CHECK(delivered_at <= current_date) OR RPC rejects |
| **Null allowed?** | YES (PENDING orders don't have delivered_at yet) | CHECK(delivered_at IS NOT NULL IF estado='DELIVERED') via RPC |
| **What RPC validates it?** | deliver_order | Begins with: SELECT period FOR UPDATE WHERE ... IF CLOSED RAISE ERROR |
| **Error message** | "Cannot deliver order; period [YYYY-MM] closed. Reopen period to deliver [YYYY-MM-DD]." | RPC raises |

**IMMUTABILITY_RULE:**

| Column | Immutable? | Enforcement |
|--------|---|---|
| id | YES (PK) | PRIMARY KEY |
| estado | IMMUTABLE once DELIVERED | RLS UPDATE WHERE estado != 'DELIVERED' |
| delivered_at | IMMUTABLE once DELIVERED | RLS UPDATE WHERE estado != 'DELIVERED' |
| monto_total | NOT STORED (computed) | No column; derives SUM(pedido_lineas.subtotal) |
| cliente_id | NEVER changes | RLS UPDATE WHERE estado != 'DELIVERED' |

**APPEND_ONLY_RULE:**

| Rule | Value |
|------|-------|
| **Applies?** | NO (pedidos allows UPDATE for PENDING orders) |
| **Exception** | Once DELIVERED, immutable (RLS) |

**AUDIT_RULE:**

| Rule | Value |
|------|-------|
| **Action on INSERT** | deliver_order RPC: action='DELIVER', after_values={estado, delivered_at, lineas} |
| **Action on RECTIFY** | rectify_delivered_order RPC: action='RECTIFY', before_values={prior total}, after_values={corrected total}, reason |
| **Who inserts** | RPC transaction (not trigger) |

**PERIOD_ENFORCEMENT:**

| Rule | Value |
|------|-------|
| **Can period be reopened?** | YES (ADMIN only) |
| **If reopened, can facts be corrected?** | YES (rectify_delivered_order RPC callable with period OPEN) |
| **Reopen RPC** | reopen_management_period(period_id, reason) |

---

#### Table: pedido_lineas (Order Lines)

**EFFECTIVE_DATE_RULE:**

| Rule | Value | Enforcement |
|------|-------|---|
| **Period determinant** | NO — inherited from pedidos.delivered_at | (Not independently period-checked) |
| **Null allowed?** | NO | NOT NULL cantidad, precio_unitario |
| **Immutable after order DELIVERED** | YES | RLS UPDATE DENY once parent pedido.estado='DELIVERED' |

**IMMUTABILITY_RULE:**

| Column | Immutable? | Enforcement |
|--------|---|---|
| precio_unitario | YES (SNAPSHOT) | NEVER UPDATE; RLS UPDATE DENY on pedido (parent) |
| producto_nombre | YES (SNAPSHOT) | NEVER UPDATE; RLS UPDATE DENY on pedido (parent) |
| subtotal | YES (GENERATED ALWAYS) | NUMERIC(15,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED |
| cantidad | IMMUTABLE once DELIVERED | RLS UPDATE DENY on parent pedido |

**APPEND_ONLY_RULE:**

| Rule | Value |
|------|-------|
| **Applies?** | NO (immutable via parent RLS, not append-only) |
| **Exception** | Once parent DELIVERED, no UPDATE allowed |

**AUDIT_RULE:**

| Rule | Value |
|------|-------|
| **Captured in** | parent pedidos audit_event (before/after_values includes lineas JSONB array) |
| **Action** | DELIVER (captures all lines atomically) |

---

#### Table: client_ledger (Client Movements)

**EFFECTIVE_DATE_RULE:**

| Rule | Value | Enforcement |
|------|-------|---|
| **Period determinant** | effective_date | register_collection, deliver_order, register_cheque_receipt RPCs |
| **Allow future date?** | NO (frozen: all client movements are historical events) | CHECK(effective_date <= current_date) OR RPC validates |
| **Null allowed?** | NO | NOT NULL effective_date |
| **What RPC validates it?** | register_collection | Begins with: SELECT period WHERE effective_date period FOR UPDATE |
| **Error message** | "Cannot record collection; period [YYYY-MM] closed. Reopen period to record on [YYYY-MM-DD]." | RPC raises |

**IMMUTABILITY_RULE:**

| Column | Immutable? | Enforcement |
|--------|---|---|
| ALL | YES (ledger is append-only) | RLS UPDATE DENY (no UPDATE allowed) |
| signed_amount | YES | RLS DELETE DENY; no UPDATE |
| ledger_client_name | YES (SNAPSHOT) | Captured at INSERT; immutable |

**APPEND_ONLY_RULE:**

| Rule | Value |
|------|-------|
| **Applies?** | YES |
| **Enforcement** | RLS UPDATE USING FALSE; DELETE USING FALSE |
| **Exception for ADMIN rectification** | NO — rectification creates new ledger entries (INSERT), not UPDATE old |

**AUDIT_RULE:**

| Rule | Value |
|------|-------|
| **Action** | deliver_order: INSERT, after_values={movement_type=SALE_DELIVERY, signed_amount, effective_date} |
| **Action** | register_collection: INSERT, after_values={movement_type=COLLECTION, signed_amount, payment_method} |
| **Action** | receive_cheque: INSERT, after_values={movement_type=CHEQUE_RECEIVED, signed_amount, cheque_number} |
| **Action** | reject_cheque (RECEIVED→REJECTED): INSERT, after_values={movement_type=CHEQUE_REJECTED, signed_amount} (reversal entry) |

**PERIOD_ENFORCEMENT:**

| Rule | Value |
|------|-------|
| **Can period be reopened?** | YES (ADMIN) |
| **If reopened, can ledger be corrected?** | YES (via INSERT new entries; originals remain immutable) |

**QUERY PATTERNS:**

```sql
-- Current client balance
SELECT cliente_id, SUM(signed_amount) as saldo
FROM client_ledger
WHERE cliente_id = ?
GROUP BY cliente_id;

-- History for specific client
SELECT * FROM client_ledger WHERE cliente_id = ? ORDER BY effective_date;

-- Ledger movement between dates
SELECT * FROM client_ledger 
WHERE cliente_id = ? AND effective_date BETWEEN start_date AND end_date
ORDER BY effective_date;
```

---

#### Table: financial_posting (Financial Ledger)

**EFFECTIVE_DATE_RULE:**

| Rule | Value | Enforcement |
|------|-------|---|
| **Period determinant** | effective_date | register_collection (cash), transfer_between_accounts, clear_cheque RPCs |
| **Allow future date?** | NO (frozen: postings are confirmations of realized cash movements) | CHECK(effective_date <= current_date) OR RPC validates |
| **Null allowed?** | NO | NOT NULL effective_date |
| **What RPC validates it?** | transfer_between_accounts, clear_cheque, register_collection (cash) | Begins with: SELECT period FOR UPDATE WHERE effective_date period |
| **Error message** | "Cannot post; period [YYYY-MM] closed. Reopen period to record transfer on [YYYY-MM-DD]." | RPC raises |

**IMMUTABILITY_RULE:**

| Column | Immutable? | Enforcement |
|--------|---|---|
| ALL | YES (ledger is append-only) | RLS UPDATE DENY |
| signed_amount | YES | RLS DELETE DENY; CHECK(signed_amount != 0) prevents zero entries |
| financial_account_id | YES | RLS UPDATE DENY; parent operation immutable |

**APPEND_ONLY_RULE:**

| Rule | Value |
|------|-------|
| **Applies?** | YES (pure append-only) |
| **Enforcement** | RLS UPDATE USING FALSE; DELETE USING FALSE |
| **Exception for ADMIN rectification** | NO — rectification uses INSERT compensating entries, not UPDATE |

**AUDIT_RULE:**

| Rule | Value |
|------|-------|
| **Action** | transfer_between_accounts: INSERT 2 postings atomically; parent financial_operation captures operation_type='TRANSFER' |
| **Action** | clear_cheque: INSERT posting (bank account +amount); parent financial_operation captures operation_type='CHEQUE_CLEAR' |
| **Action** | register_collection (cash): INSERT posting (caja +amount) |
| **Rejection reversal** | reject_cheque (CLEARED→REJECTED): INSERT compensating posting (bank account -amount) |

**PERIOD_ENFORCEMENT:**

| Rule | Value |
|------|-------|
| **Can period be reopened?** | YES (ADMIN) |
| **If reopened, can posting be corrected?** | YES (insert compensating entries; originals immutable) |

**QUERY PATTERNS:**

```sql
-- Account balance
SELECT financial_account_id, SUM(signed_amount) as balance
FROM financial_posting
WHERE financial_account_id = ?
GROUP BY financial_account_id;

-- Operation trace (all postings for a transfer)
SELECT fp.* FROM financial_posting fp
JOIN financial_operation fo ON fo.id = fp.financial_operation_id
WHERE fo.operation_type = 'TRANSFER' AND fo.transfer_id = ?;
```

---

#### Table: population_events (Mortality & Adjustments)

**EFFECTIVE_DATE_RULE:**

| Rule | Value | Enforcement |
|------|-------|---|
| **Period determinant** | event_date | register_mortality, register_count_adjustment RPCs |
| **Allow future date?** | NO (frozen: population events are historical) | CHECK(event_date <= current_date) OR RPC validates |
| **Null allowed?** | NO | NOT NULL event_date |
| **What RPC validates it?** | register_mortality | SELECT period FOR UPDATE WHERE event_date period; IF CLOSED RAISE ERROR |
| **Error message** | "Cannot record mortality; period [YYYY-MM] closed. Reopen period to record event on [YYYY-MM-DD]." | RPC raises |

**IMMUTABILITY_RULE:**

| Column | Immutable? | Enforcement |
|--------|---|---|
| delta | YES (after INSERT) | RLS UPDATE DENY; rectify via new event |
| event_date | YES | RLS UPDATE DENY |
| event_type | YES | RLS UPDATE DENY |
| is_current | MUTABLE (only by rectify RPC) | UPDATE only when superseding (set is_current=false, superseded_by set) |

**APPEND_ONLY_RULE:**

| Rule | Value |
|------|-------|
| **Applies?** | YES (immutable via RLS) |
| **Enforcement** | RLS UPDATE USING FALSE; DELETE USING FALSE (except is_current mutation by RPC) |
| **Exception for ADMIN rectification** | UPDATE is_current, superseded_by for original; INSERT new record |

**AUDIT_RULE:**

| Rule | Value |
|------|-------|
| **Action on INSERT** | register_mortality: action='INSERT', after_values={delta, event_date, flock_id} |
| **Action on RECTIFY** | rectify_mortality: action='RECTIFY', before_values={original delta}, after_values={corrected delta}, reason |
| **Rejection on duplicate** | register_mortality: REJECT if UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' already exists; error = "Mortality already recorded [delta]; use rectify_mortality to correct" |

**PERIOD_ENFORCEMENT:**

| Rule | Value |
|------|-------|
| **Can period be reopened?** | YES (ADMIN) |
| **If reopened, can event be corrected?** | YES (rectify_mortality RPC creates new is_current=true event; original preserved) |

**QUERY PATTERNS:**

```sql
-- Current population (only is_current events)
SELECT flock_id, SUM(delta) as population
FROM population_events
WHERE flock_id = ? AND is_current = true
GROUP BY flock_id;

-- Population history (all events including superseded)
SELECT * FROM population_events
WHERE flock_id = ?
ORDER BY event_date, created_at;

-- Find superseded event
SELECT * FROM population_events
WHERE id = (SELECT superseded_by FROM population_events WHERE id = ?)
```

---

#### Table: daily_production (Production Record)

**EFFECTIVE_DATE_RULE:**

| Rule | Value | Enforcement |
|------|-------|---|
| **Period determinant** | production_date | register_daily_production RPC |
| **Allow future date?** | NO (frozen: production is historical measurement) | CHECK(production_date <= current_date) OR RPC validates |
| **Null allowed?** | NO | NOT NULL production_date |
| **What RPC validates it?** | register_daily_production | SELECT period FOR UPDATE WHERE production_date period; IF CLOSED RAISE ERROR |
| **Error message** | "Cannot register production; period [YYYY-MM] closed. Reopen period to register [YYYY-MM-DD]." | RPC raises |

**IMMUTABILITY_RULE:**

| Column | Immutable? | Enforcement |
|--------|---|---|
| eggs_total | IMMUTABLE after production_date closes (period-based) | RLS UPDATE DENY if production_date <= current_date (period CLOSED) |
| birds_alive_count | IMMUTABLE after production_date closes | RLS UPDATE DENY if period CLOSED |
| ALL | IMMUTABLE once period CLOSED | RLS enforced per management_period.status |

**APPEND_ONLY_RULE:**

| Rule | Value |
|------|-------|
| **Applies?** | YES (immutable after period closes) |
| **Enforcement** | RLS UPDATE DENY once production_date period CLOSED |
| **Exception** | Period can be REOPENED (ADMIN); then UPDATE allowed for correction |

**AUDIT_RULE:**

| Rule | Value |
|------|-------|
| **Action** | register_daily_production: INSERT + audit_event(action='INSERT', after_values={eggs_total, birds_alive}) |

**PERIOD_ENFORCEMENT:**

| Rule | Value |
|------|-------|
| **Can period be reopened?** | YES (ADMIN) |
| **If reopened, can production be corrected?** | YES (UPDATE allowed; audit captures before/after) |

---

#### Table: classification (Session)

**EFFECTIVE_DATE_RULE:**

| Rule | Value | Enforcement |
|------|-------|---|
| **Period determinant** | session_date | register_classification RPC |
| **Allow future date?** | NO (frozen: classification is physical event) | CHECK(session_date <= current_date) OR RPC validates |
| **Null allowed?** | NO | NOT NULL session_date |
| **What RPC validates it?** | register_classification | SELECT period FOR UPDATE WHERE session_date period; IF CLOSED RAISE ERROR |
| **Error message** | "Cannot register classification; period [YYYY-MM] closed. Reopen period for [YYYY-MM-DD]." | RPC raises |

**IMMUTABILITY_RULE:**

| Column | Immutable? | Enforcement |
|--------|---|---|
| session_date | YES | RLS UPDATE DENY once posted |
| location | YES | RLS UPDATE DENY once posted |
| classification_line.grade | YES | RLS UPDATE DENY once session complete |
| classification_line.quantity | YES | RLS UPDATE DENY once session complete |

**APPEND_ONLY_RULE:**

| Rule | Value |
|------|-------|
| **Applies?** | YES (classification_line is append-only) |
| **Enforcement** | RLS UPDATE DENY; DELETE DENY on classification_line |

**AUDIT_RULE:**

| Rule | Value |
|------|-------|
| **Action** | register_classification: INSERT classification + N classification_lines; audit_event(action='INSERT', after_values={session_date, grades}) |
| **No rectification** | Frozen: "classification immutable once session posted (no rectification in V1)" |

**PERIOD_ENFORCEMENT:**

| Rule | Value |
|------|-------|
| **Can period be reopened?** | YES (ADMIN) |
| **If reopened, can classification be corrected?** | NO (V1 frozen: no rectification; must create new session instead) |

---

#### Table: feed_manufacturing (Manufacturing Batch)

**EFFECTIVE_DATE_RULE:**

| Rule | Value | Enforcement |
|------|-------|---|
| **Period determinant** | manufacturing_date | register_feed_manufacturing RPC |
| **Allow future date?** | NO (frozen: manufacturing is historical event) | CHECK(manufacturing_date <= current_date) OR RPC validates |
| **Null allowed?** | NO | NOT NULL manufacturing_date |
| **What RPC validates it?** | register_feed_manufacturing | SELECT period FOR UPDATE WHERE manufacturing_date period; IF CLOSED RAISE ERROR |
| **Error message** | "Cannot record manufacturing; period [YYYY-MM] closed. Reopen period for [YYYY-MM-DD]." | RPC raises |

**IMMUTABILITY_RULE:**

| Column | Immutable? | Enforcement |
|--------|---|---|
| formula_version_id | YES (IMMUTABLE reference; frozen rule) | RPC validates: IF formula_version_id != stored RAISE ERROR "Cannot change formula mid-batch" |
| manufacturing_date | YES | RLS UPDATE DENY |
| batch_quantity | IMMUTABLE after manufacturing_date closes | RLS UPDATE DENY if period CLOSED |

**APPEND_ONLY_RULE:**

| Rule | Value |
|------|-------|
| **Applies?** | YES (immutable after period closes) |
| **Enforcement** | RLS UPDATE DENY once manufacturing_date period CLOSED |

**AUDIT_RULE:**

| Rule | Value |
|------|-------|
| **Action** | register_feed_manufacturing: INSERT manufacturing + audit_event(action='INSERT', after_values={formula_version_id, batch_quantity}) |

**PERIOD_ENFORCEMENT:**

| Rule | Value |
|------|-------|
| **Can period be reopened?** | YES (ADMIN) |
| **If reopened, can manufacturing be corrected?** | YES (UPDATE batch_quantity; formula_version_id IMMUTABLE even if period reopens) |

---

## PART 3: RPC SPECIFICATIONS (TEMPORAL & AUDIT)

### 1. deliver_order

**Purpose:** Transition PENDING → DELIVERED; record economic sale (client debt).

**Temporal rule:**

- Period determinant: delivered_at
- Period must be OPEN
- No future delivery allowed

**RPC signature:**

```sql
deliver_order(
  order_id UUID,
  delivered_at DATE,
  auth_user UUID  -- performed_by
)
```

**RPC transaction:**

```sql
BEGIN TRANSACTION

  -- 1. Validate period OPEN
  SELECT id, status FROM management_period 
    WHERE periodo_fecha <= delivered_at 
      AND periodo_fecha + INTERVAL '1 month' > delivered_at
    FOR UPDATE;
  
  IF NOT FOUND RAISE ERROR 'Period not found for ' || delivered_at;
  IF status != 'OPEN' RAISE ERROR 'Period ' || periodo_fecha || ' closed; cannot deliver order on ' || delivered_at;
  
  -- 2. Fetch order; validate PENDING
  SELECT id, cliente_id, estado FROM pedidos WHERE id = order_id FOR UPDATE;
  IF estado != 'PENDING' RAISE ERROR 'Order already delivered or cancelled';
  
  -- 3. Calculate order total
  SELECT SUM(subtotal) as total FROM pedido_lineas WHERE pedido_id = order_id;
  
  -- 4. Update order state
  UPDATE pedidos SET estado = 'DELIVERED', delivered_at = delivered_at WHERE id = order_id;
  
  -- 5. Create client_ledger entry (debt)
  INSERT client_ledger (
    cliente_id,
    movement_type = 'SALE_DELIVERY',
    signed_amount = order_total,
    effective_date = delivered_at,
    ledger_client_name = (SELECT nombre FROM clients WHERE id = cliente_id),
    created_by = auth_user
  );
  
  -- 6. Audit
  INSERT audit_events (
    entity_type = 'pedido',
    entity_id = order_id,
    action = 'DELIVER',
    after_values = {estado: 'DELIVERED', delivered_at, total},
    performed_by = auth_user,
    performed_at = NOW()
  );

COMMIT;
```

**Idempotency:** Already DELIVERED → error (not silent retry).

**Immutability post-delivery:** Delivered order immutable; rectification via rectify_delivered_order RPC.

---

### 2. register_collection

**Purpose:** Record payment received (cash, transfer, or cheque).

**Temporal rule:**

- Period determinant: effective_date
- Period must be OPEN
- No future collection date allowed

**RPC signature:**

```sql
register_collection(
  client_id UUID,
  amount NUMERIC(15,2),
  payment_method ENUM (CASH, CHEQUE, TRANSFER, MERCADOPAGO),
  receipt_id VARCHAR(100) UNIQUE,
  effective_date DATE,
  auth_user UUID
)
```

**RPC transaction:**

```sql
BEGIN TRANSACTION

  -- 1. Validate period OPEN
  SELECT id, status FROM management_period 
    WHERE periodo_fecha <= effective_date 
      AND periodo_fecha + INTERVAL '1 month' > effective_date
    FOR UPDATE;
  
  IF status != 'OPEN' RAISE ERROR 'Period ' || periodo_fecha || ' closed; cannot record collection on ' || effective_date;
  
  -- 2. Validate receipt_id unique
  SELECT 1 FROM collections WHERE receipt_id = receipt_id;
  IF FOUND RAISE ERROR 'Receipt ' || receipt_id || ' already recorded';
  
  -- 3. Create collection record
  INSERT collections (
    client_id,
    amount,
    payment_method,
    receipt_id,
    effective_date,
    created_by
  );
  
  -- 4. Reduce client debt
  INSERT client_ledger (
    cliente_id,
    movement_type = 'COLLECTION',
    signed_amount = -amount,
    effective_date,
    created_by
  );
  
  -- 5. If CHEQUE: create instrument (no posting yet)
  IF payment_method = 'CHEQUE':
    INSERT financial_instrument (
      instrument_type = 'CHEQUE',
      estado = 'RECEIVED',
      cheque_number,
      amount,
      maturity_date
    );
    INSERT financial_instrument_event (
      financial_instrument_id,
      event_type = 'RECEIVED',
      event_date = effective_date
    );
  
  -- 6. Else if CASH/TRANSFER: create posting (cash received)
  ELSIF payment_method IN ('CASH', 'TRANSFER', 'MERCADOPAGO'):
    INSERT financial_operation (
      operation_type = 'COLLECTION',
      effective_date,
      transfer_id = receipt_id
    );
    INSERT financial_posting (
      financial_operation_id,
      financial_account_id,  -- target account (CAJA, MP, BNA)
      signed_amount = +amount,
      effective_date
    );
  
  -- 7. Audit
  INSERT audit_events (
    entity_type = 'collection',
    entity_id = collection_id,
    action = 'INSERT',
    after_values = {client_id, amount, payment_method, effective_date},
    performed_by = auth_user,
    performed_at = NOW()
  );

COMMIT;
```

---

### 3. register_mortality

**Purpose:** Record bird death event; enforce uniqueness per (flock, date).

**Temporal rule:**

- Period determinant: event_date
- Period must be OPEN
- Max ONE MORTALITY per (flock, date)

**RPC signature:**

```sql
register_mortality(
  flock_id UUID,
  delta BIGINT,  -- Number of birds dead
  event_date DATE,
  auth_user UUID
)
```

**RPC transaction:**

```sql
BEGIN TRANSACTION

  -- 1. Validate period OPEN
  SELECT id, status FROM management_period 
    WHERE periodo_fecha <= event_date 
      AND periodo_fecha + INTERVAL '1 month' > event_date
    FOR UPDATE;
  
  IF status != 'OPEN' RAISE ERROR 'Period closed; reopen to record mortality on ' || event_date;
  
  -- 2. Check UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY'
  SELECT delta FROM population_events 
    WHERE flock_id = flock_id 
      AND event_date = event_date 
      AND event_type = 'MORTALITY'
      AND is_current = true;
  
  IF FOUND RAISE ERROR 'Mortality already recorded for this flock on ' || event_date || ': ' || delta || ' birds; use rectify_mortality to correct';
  
  -- 3. Insert event
  INSERT population_events (
    flock_id,
    event_type = 'MORTALITY',
    delta = -delta,  -- Negative: population decreases
    event_date,
    is_current = true,
    created_by = auth_user
  );
  
  -- 4. Audit
  INSERT audit_events (
    entity_type = 'population_event',
    entity_id = event_id,
    action = 'INSERT',
    after_values = {delta, event_date, flock_id},
    performed_by = auth_user,
    performed_at = NOW()
  );

COMMIT;
```

---

### 4. rectify_mortality

**Purpose:** Correct previous mortality record; preserve history via supersession.

**Temporal rule:**

- Period must be OPEN for original event_date
- ADMIN only
- Reason mandatory

**RPC signature:**

```sql
rectify_mortality(
  original_event_id BIGINT,
  corrected_delta BIGINT,
  reason TEXT,
  auth_user UUID
)
```

**RPC transaction:**

```sql
BEGIN TRANSACTION

  -- 1. Fetch original event
  SELECT flock_id, event_date, delta as original_delta FROM population_events 
    WHERE id = original_event_id FOR UPDATE;
  
  -- 2. Validate period OPEN for original event_date
  SELECT id, status FROM management_period 
    WHERE periodo_fecha <= event_date 
      AND periodo_fecha + INTERVAL '1 month' > event_date
    FOR UPDATE;
  
  IF status != 'OPEN' RAISE ERROR 'Period closed; reopen to rectify mortality on ' || event_date;
  
  -- 3. Mark original as superseded
  UPDATE population_events 
    SET is_current = false, superseded_at = NOW(), superseded_reason = reason 
    WHERE id = original_event_id;
  
  -- 4. Insert new corrected event
  INSERT population_events (
    flock_id,
    event_type = 'MORTALITY',
    delta = -corrected_delta,
    event_date = original_event_date,
    is_current = true,
    supersedes = original_event_id,
    created_by = auth_user
  );
  
  -- 5. Audit
  INSERT audit_events (
    entity_type = 'population_event',
    entity_id = original_event_id,
    action = 'RECTIFY',
    before_values = {delta: original_delta},
    after_values = {delta: corrected_delta},
    reason,
    performed_by = auth_user,
    performed_at = NOW()
  );

COMMIT;
```

**Immutability enforced:** Original event row immutable (superseded_by marks history); new is_current=true.

---

### 5. clear_cheque

**Purpose:** Cheque physically clears; bank credit confirmed; create financial posting.

**Temporal rule:**

- Period determinant: cleared_date
- Period must be OPEN
- Only DEPOSITED cheques can be cleared

**RPC signature:**

```sql
clear_cheque(
  cheque_id UUID,
  cleared_date DATE,
  destination_account_id UUID,  -- bank account receiving credit
  auth_user UUID
)
```

**RPC transaction:**

```sql
BEGIN TRANSACTION

  -- 1. Validate period OPEN
  SELECT id, status FROM management_period 
    WHERE periodo_fecha <= cleared_date 
      AND periodo_fecha + INTERVAL '1 month' > cleared_date
    FOR UPDATE;
  
  IF status != 'OPEN' RAISE ERROR 'Period closed; cannot clear cheque on ' || cleared_date;
  
  -- 2. Fetch cheque; validate DEPOSITED
  SELECT id, amount, cheque_number, estado FROM financial_instrument 
    WHERE id = cheque_id FOR UPDATE;
  
  IF estado != 'DEPOSITED' RAISE ERROR 'Cheque must be DEPOSITED before clearing; current state: ' || estado;
  
  -- 3. Update instrument state
  UPDATE financial_instrument SET estado = 'CLEARED' WHERE id = cheque_id;
  
  -- 4. Create instrument event
  INSERT financial_instrument_event (
    financial_instrument_id = cheque_id,
    event_type = 'CLEARED',
    event_date = cleared_date
  );
  
  -- 5. Create financial posting (bank credit confirmed)
  INSERT financial_operation (
    operation_type = 'CHEQUE_CLEAR',
    effective_date = cleared_date,
    transfer_id = cheque_number
  );
  
  INSERT financial_posting (
    financial_operation_id,
    financial_account_id = destination_account_id,
    signed_amount = +amount,
    effective_date = cleared_date
  );
  
  -- 6. Audit
  INSERT audit_events (
    entity_type = 'financial_instrument',
    entity_id = cheque_id,
    action = 'CLEAR',
    after_values = {estado: 'CLEARED'},
    performed_by = auth_user,
    performed_at = NOW()
  );

COMMIT;
```

**Key:** Only CLEARED creates bank posting. RECEIVED/DEPOSITED = no bank impact yet.

---

### 6. reject_cheque

**Purpose:** Cheque rejected (bounced or returns unpaid); state-specific reversal consequences.

**Temporal rule:**

- Period determinant: rejection_date
- Period must be OPEN
- Consequences vary by prior cheque state

**RPC signature:**

```sql
reject_cheque(
  cheque_id UUID,
  rejection_date DATE,
  reason TEXT,
  auth_user UUID
)
```

**RPC transaction:**

```sql
BEGIN TRANSACTION

  -- 1. Fetch cheque; store prior state
  SELECT id, amount, cheque_number, estado, cliente_id FROM financial_instrument 
    WHERE id = cheque_id FOR UPDATE;
  
  original_estado = estado;
  
  -- 2. Validate period OPEN
  SELECT id, status FROM management_period 
    WHERE periodo_fecha <= rejection_date 
      AND periodo_fecha + INTERVAL '1 month' > rejection_date
    FOR UPDATE;
  
  IF status != 'OPEN' RAISE ERROR 'Period closed; cannot reject cheque on ' || rejection_date;
  
  -- 3. Update instrument state
  UPDATE financial_instrument SET estado = 'REJECTED' WHERE id = cheque_id;
  
  -- 4. Create instrument event
  INSERT financial_instrument_event (
    financial_instrument_id = cheque_id,
    event_type = 'REJECTED',
    event_date = rejection_date
  );
  
  -- 5. Handle consequences based on ORIGINAL state
  
  IF original_estado = 'RECEIVED':
    -- Cheque was in portfolio; client debt was reduced when received
    -- Restore client debt (cheque invalid)
    INSERT client_ledger (
      cliente_id,
      movement_type = 'CHEQUE_REJECTED',
      signed_amount = +amount,
      effective_date = rejection_date,
      created_by = auth_user
    );
    -- NO financial posting to reverse (never created)
  
  ELSIF original_estado = 'DEPOSITED':
    -- Cheque deposited but not cleared
    -- No financial posting exists
    -- Client debt stays reduced; no reversal
    -- Bank will handle return; no internal consequence
  
  ELSIF original_estado = 'CLEARED':
    -- Cheque was cleared; financial posting EXISTS
    -- Bank revoking credit
    -- Create compensating financial posting
    INSERT financial_operation (
      operation_type = 'CHEQUE_REJECTION',
      effective_date = rejection_date,
      transfer_id = cheque_number
    );
    
    INSERT financial_posting (
      financial_operation_id,
      financial_account_id,  -- same bank account (restore debit)
      signed_amount = -amount,  -- reverse credit
      effective_date = rejection_date
    );
    -- Client debt CANNOT be restored; payment already accepted
  
  -- 6. Audit
  INSERT audit_events (
    entity_type = 'financial_instrument',
    entity_id = cheque_id,
    action = 'REJECT',
    before_values = {estado: original_estado, amount},
    after_values = {estado: 'REJECTED', amount},
    reason,
    performed_by = auth_user,
    performed_at = NOW()
  );

COMMIT;
```

**Key:** Different reversals per state (no blanket rule; explicit logic per original state).

---

### 7. close_management_period

**Purpose:** Seal period; prevent new facts in that period.

**Temporal rule:**

- Period must be OPEN
- Closure integrity check (warnings only, no enforcement)
- Reason mandatory

**RPC signature:**

```sql
close_management_period(
  period_id BIGINT,
  reason TEXT,
  auth_user UUID
)
```

**RPC transaction:**

```sql
BEGIN TRANSACTION

  -- 1. Fetch period; validate OPEN
  SELECT id, status, periodo_fecha FROM management_period 
    WHERE id = period_id FOR UPDATE;
  
  IF status != 'OPEN' RAISE ERROR 'Period already closed on ' || closed_at;
  
  -- 2. Warn about unfinalized facts (non-enforcement; admin decision)
  SELECT 'pedido' as entity, COUNT(*) as count 
    FROM pedidos 
    WHERE estado = 'PENDING' 
      AND created_at BETWEEN periodo_fecha AND periodo_fecha + INTERVAL '1 month'
  UNION ALL
  SELECT 'population_event' as entity, COUNT(*) as count
    FROM population_events
    WHERE created_at BETWEEN periodo_fecha AND periodo_fecha + INTERVAL '1 month'
      AND event_type = 'MORTALITY'
      AND is_current = true
  -- (Return warning but allow closure)
  
  -- 3. Close period
  UPDATE management_period 
    SET status = 'CLOSED', closed_at = NOW(), closed_by = auth_user
    WHERE id = period_id;
  
  -- 4. Audit
  INSERT audit_events (
    entity_type = 'management_period',
    entity_id = period_id,
    action = 'CLOSE',
    before_values = {status: 'OPEN'},
    after_values = {status: 'CLOSED', closed_at},
    reason,
    performed_by = auth_user,
    performed_at = NOW()
  );

COMMIT;
```

---

### 8. reopen_management_period

**Purpose:** ADMIN reopens period for corrections; reason mandatory.

**Temporal rule:**

- ADMIN only
- Reason mandatory
- Transactional with audit

**RPC signature:**

```sql
reopen_management_period(
  period_id BIGINT,
  reason TEXT,
  auth_user UUID
)
```

**RPC transaction:**

```sql
BEGIN TRANSACTION

  -- 1. Fetch period; validate CLOSED
  SELECT id, status, closed_at, closed_by FROM management_period 
    WHERE id = period_id FOR UPDATE;
  
  IF status != 'CLOSED' RAISE ERROR 'Period is already OPEN';
  
  -- 2. Authorize ADMIN only
  SELECT rol_type FROM perfiles WHERE id = auth_user;
  IF rol_type != 'ADMIN' RAISE ERROR 'Only ADMIN can reopen periods';
  
  -- 3. Reopen period
  UPDATE management_period 
    SET status = 'OPEN', closed_at = NULL, closed_by = NULL
    WHERE id = period_id;
  
  -- 4. Audit
  INSERT audit_events (
    entity_type = 'management_period',
    entity_id = period_id,
    action = 'REOPEN',
    before_values = {status: 'CLOSED', closed_at},
    after_values = {status: 'OPEN', closed_at: NULL},
    reason,
    performed_by = auth_user,
    performed_at = NOW()
  );

COMMIT;
```

---

## PART 4: PERIOD CLOSURE PROTECTION (TRANSVERSAL)

**Blanket rule:** All period-determining facts checked at INSERT/UPDATE.

```sql
-- Template pattern used in ALL RPCs:

DECLARE period_row management_period;

SELECT * INTO period_row FROM management_period 
  WHERE periodo_fecha <= period_date_arg 
    AND periodo_fecha + INTERVAL '1 month' > period_date_arg
  FOR UPDATE;

IF NOT FOUND THEN
  RAISE EXCEPTION 'Period not found for date %', period_date_arg;
END IF;

IF period_row.status = 'CLOSED' THEN
  RAISE EXCEPTION 'Period % is closed; cannot record fact on %. Reopen period to continue.',
    period_row.periodo_fecha, period_date_arg;
END IF;

-- (Continue with INSERT/UPDATE)
```

**Lock strategy:** SELECT FOR UPDATE ensures atomicity. No race between period closure and fact insertion.

---

## PART 5: IMMUTABILITY ENFORCEMENT SUMMARY

| Type | Enforcement | Tables |
|------|---|---|
| **Append-only** (no UPDATE, no DELETE) | RLS UPDATE DENY; RLS DELETE DENY | client_ledger, financial_posting, population_events, supplier_ledger, audit_events, feed_inventory_count, mp_source_record |
| **State-immutable** (no UPDATE once DELIVERED) | RLS UPDATE WHERE estado != 'DELIVERED' | pedidos |
| **Period-immutable** (no UPDATE after period CLOSED) | RLS UPDATE IF period.status = 'OPEN' | daily_production, classification (session), feed_manufacturing |
| **Generated immutable** | GENERATED ALWAYS AS (...) STORED | pedido_lineas.subtotal |
| **Snapshot immutable** | Captured at INSERT; immutable via parent RLS | pedido_lineas.precio_unitario, pedido_lineas.producto_nombre, client_ledger.ledger_client_name |
| **FK immutable** (no UPDATE after INSERT) | RPC validates; no DB constraint | feed_manufacturing.formula_version_id |

---

## PART 6: AUDIT EVENT PATTERNS

**All audit events include:**

| Field | Rules |
|-------|-------|
| entity_type | VARCHAR(100) — fully qualified (e.g., 'pedido', 'population_event', 'management_period') |
| entity_id | VARCHAR(100) — either UUID or BIGINT as string |
| action | INSERT, UPDATE, DELETE, RECTIFY, REJECT, REOPEN, CLOSE, DELIVER, CLEAR, etc. |
| before_values | JSONB (NULL if INSERT) — prior state |
| after_values | JSONB (NULL if DELETE) — new state |
| reason | TEXT (mandatory for RECTIFY, REOPEN, CLOSE, REJECT; NULL otherwise) |
| performed_by | UUID — references perfiles.id (auth_user) |
| performed_at | TIMESTAMPTZ — NOW() at RPC execution |

**Audit is IMMUTABLE:** RLS UPDATE DENY; DELETE DENY.

---

## PART 7: FROZEN RULE IMPLEMENTABILITY SUMMARY

| Rule | Frozen Statement | Implementability | Solution |
|------|---|---|---|
| 1 | created_at NEVER determines period | ✓ IMPLEMENTABLE | RPC validation per-operation; no DB-level default |
| 2 | Period OPEN required | ✓ IMPLEMENTABLE | SELECT period FOR UPDATE; IF CLOSED RAISE in all RPCs |
| 3 | Period CLOSED prevents mutation | ✓ IMPLEMENTABLE | RPC check transversally; manual reopen by ADMIN |
| 4 | Immutable snapshots | ✓ IMPLEMENTABLE | RLS UPDATE DENY for pedidos/parent; GENERATED for subtotal; RPC check for formula_version_id |
| 5 | Append-only ledger | ✓ IMPLEMENTABLE | RLS UPDATE USING FALSE; DELETE USING FALSE |
| 6 | No silent mutation of posted | ✓ IMPLEMENTABLE | RLS policies per entity; "posted" = periodo/estado-based |
| 7 | Rectification preserves history | ✓ IMPLEMENTABLE | Pattern A (compensating entries) + Pattern B (supersession) + audit |
| 8 | Reversal vs Rectification | ✓ IMPLEMENTABLE | Single INSERT (reversal) vs INSERT + INSERT (rectification); both append-only |
| 9 | Audit trail | ✓ IMPLEMENTABLE | RPC-inserted audit_events within transaction boundary |
| 10 | Period lifecycle | ✓ IMPLEMENTABLE | periodo_fecha=YYYY-MM-01; status=(OPEN/CLOSED); reopen manual |

**Conclusion:** All frozen rules are implementable. No architectural changes required.

---

## PART 8: CONSTRAINTS & EDGE CASES

### Q: What if period is "between" (e.g., fact effective_date Sept 5, but period closes Sept 3)?

**Answer:** Period does NOT close mid-month in normal operations.

Period model: One period = one calendar month (periodo_fecha = first day of month).

If fact is Sept 5 and Sept period is OPEN, it belongs to Sept and can be recorded.

If Sept period is CLOSED before Sept 5 arrives, admin MUST reopen to record Sept 5 fact.

**Design assumption:** Monthly closures happen end-of-month; no mid-month closures.

---

### Q: If period reopened, can historical facts be corrected?

**Answer:** YES (via rectification RPCs).

Example: Sept period closed; Oct period OPEN. Admin realizes Sept 5 delivery was mispricied.
- Reopen Sept period
- Call rectify_delivered_order(order_id, corrected_amount)
- rectify_delivered_order validates Sept period OPEN; creates reversals + new entries
- Close Sept period again

---

### Q: What prevents accidental INSERT duplicate (e.g., two mortalities same flock/date)?

**Answer:**

1. **UNIQUE constraint:** `UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' AND is_current=true`
2. **RPC pre-check:** register_mortality queries existing event; if found, RAISES ERROR (not silent UPDATE).
3. **Idempotency via receipt_id/transfer_id:** Collections, transfers use UNIQUE receipt_id/transfer_id to prevent duplicate registration.

---

### Q: Are supplementary rectification RPCs needed for collections, classifications, feed ops?

**Answer per frozen architecture:**

| Entity | Rectification | Status |
|--------|---|---|
| Sales (pedidos) | YES — rectify_delivered_order RPC | Frozen |
| Purchases | YES — rectify_purchase RPC | Implied frozen |
| Collections | NO explicit RPC; handled via reversals | Implicit in Rule 7 |
| Mortality | YES — rectify_mortality RPC | Explicit frozen |
| Classification | NO (V1 frozen: "immutable once posted") | Frozen |
| Feed manufacturing | NO explicit; period reopen allows UPDATE | Implicit |
| Daily production | NO explicit; period reopen allows UPDATE | Implicit |

**Implementer note:** Explicit rectification RPCs (like rectify_delivered_order, rectify_mortality) are preferred for audit clarity and business logic.

---

## PART 9: IMPLEMENTATION READINESS CHECKLIST

**Database Schema:**

- [ ] All tables created with correct PKs (UUID for masters; BIGSERIAL for ledgers)
- [ ] All period-determining columns defined (delivered_at, effective_date, event_date, etc.)
- [ ] Immutability constraints in place (GENERATED ALWAYS, RLS UPDATE DENY)
- [ ] Append-only RLS policies on ledger tables
- [ ] CHECK(signed_amount != 0) on financial_posting
- [ ] UNIQUE constraints per entity (receipt_id, transfer_id, cheque_number, etc.)
- [ ] UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' AND is_current=true

**RPC Implementation:**

- [ ] All RPCs begin with period validation (SELECT period FOR UPDATE; IF CLOSED RAISE)
- [ ] All RPCs include audit_events INSERT before COMMIT
- [ ] All RPCs atomic (BEGIN/COMMIT boundary)
- [ ] Idempotency checks (duplicate receipt_id, transfer_id, mortality unique constraint)
- [ ] Error messages explicit per frozen rule (e.g., "Period [YYYY-MM] closed...")

**RLS Policies:**

- [ ] Append-only tables: UPDATE DENY; DELETE DENY
- [ ] State-immutable tables: UPDATE WHERE condition
- [ ] Period-based immutability: UPDATE IF period.status = 'OPEN'
- [ ] OPERATOR permissions: Unblocked for classifications, feed_manufacturing

**Audit Trail:**

- [ ] audit_events table created; append-only
- [ ] All state-changing RPCs populate audit_events
- [ ] before_values, after_values, reason fields captured correctly
- [ ] performed_by, performed_at captured
- [ ] Audit IS PART OF RPC TRANSACTION (no orphaned audits)

**Period Management:**

- [ ] management_period table created (periodo_fecha UNIQUE, status ENUM)
- [ ] create_management_period RPC (periodo_fecha = first day of month)
- [ ] close_management_period RPC (ADMIN only, reason mandatory)
- [ ] reopen_management_period RPC (ADMIN only, reason mandatory)

**Testing:**

- [ ] Period closure blocks new facts (period check enforces)
- [ ] Period reopening allows corrections
- [ ] Rectification creates reversals + new entries; original immutable
- [ ] Duplicate registration rejected with clear error
- [ ] Audit trail complete (all state changes logged)

---

## CONCLUSION

All 10 frozen temporal and audit rules are **IMPLEMENTABLE** with the schema, RLS policies, and RPC patterns specified above.

**No temporal constraints require architecture changes.** Implementation follows straightforward patterns:

1. **Period validation** in every RPC (transversal)
2. **Immutability via RLS** (append-only tables; state/period-based updates)
3. **Rectification via INSERT** (never UPDATE original; append-only audit)
4. **Audit inside transactions** (atomic with data changes)
5. **Supersession for history** (is_current flag + audit trail)

**Implementer can use this spec as a reference for:**
- Exact columns immutable and how enforced
- Which RPC validates period for each operation
- How supersession/reversals work
- How audit events populated
- What "posted" means per entity

All mechanisms preserve historical integrity while maintaining current-state accuracy.

---

**END OF SPECIFICATION**
