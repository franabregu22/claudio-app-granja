# TRANSACTION CATALOG V1 — ROUND 1

**STATUS:** Complete analysis; ready for RPC boundary definition  
**DATE:** 2026-09-24  
**PURPOSE:** Define atomic operation boundaries and concurrency protection

---

## TRANSACTION DECISION TABLE

| **Operation** | **Direct writes allowed?** | **Atomic boundary** | **Main affected tables** | **Audit?** | **Period check?** | **Idempotency needed?** | **Concurrency protection** |
|---|---|---|---|---|---|---|---|
| **deliver_order** | NO | RPC: pedido + GL postings + CC movement | pedidos, financial_postings, client_ledger, audit_events | YES | YES | YES (receipt ID) | Atomic RPC + idempotency key |
| **rectify_delivered_order** | NO | RPC: reverse GL + reverse CC + apply new + audit | financial_postings, client_ledger, audit_events | YES | YES (must open period) | NO (ADMIN action) | Atomic RPC + version check |
| **cancel_order** | NO | RPC: if PENDING update state; if DELIVERED reverse GL + CC | pedidos, financial_postings, client_ledger, audit_events | YES | YES | YES | Atomic RPC + state check |
| **register_collection** | NO | RPC: create collection + CC movement ± instrument event | collections, client_ledger, financial_instrument_events, audit_events | YES | YES | YES (receipt_id UNIQUE) | Atomic RPC + idempotency key |
| **reverse_collection** | NO | RPC: reverse collection + CC + instrument state | collections, client_ledger, financial_instrument_events, audit_events | YES | YES | YES | Atomic RPC |
| **register_purchase** | NO | RPC: create purchase + supplier ledger | purchases, supplier_ledger, audit_events | YES | YES | YES (invoice_num UNIQUE) | Atomic RPC + idempotency key |
| **rectify_purchase** | NO | RPC: reverse + re-issue + audit | purchases, supplier_ledger, audit_events | YES | YES | NO (ADMIN) | Atomic RPC |
| **transfer_between_accounts** | NO | RPC: both postings atomically | financial_operations, financial_postings, audit_events | YES | YES | YES (transfer_id UNIQUE) | Atomic RPC: BOTH postings or BOTH fail |
| **register_financial_adjustment** | NO | RPC: create operation + posting + audit | financial_operations, financial_postings, audit_events | YES | YES | YES | Atomic RPC |
| **receive_cheque** | NO | RPC: create instrument + reduce CC | financial_instrument, financial_instrument_events, client_ledger, audit_events | YES | YES | YES (cheque_number UNIQUE) | Atomic RPC + state transition |
| **deposit_cheque** | NO | RPC: state transition + GL posting | financial_instrument, financial_instrument_events, financial_postings, audit_events | YES | YES | YES | Atomic RPC + state check |
| **clear_cheque** | NO | RPC: DEPOSITED→CLEARED + GL posting | financial_instrument, financial_instrument_events, financial_postings, audit_events | YES | YES | YES | Atomic RPC |
| **endorse_cheque** | NO | RPC: state transition + CC reverse + supplier CC open | financial_instrument, financial_instrument_events, client_ledger, supplier_ledger, audit_events | YES | YES | YES | Atomic RPC |
| **reject_cheque** | NO | RPC: state transition + reversal consequences | financial_instrument, financial_instrument_events, client_ledger, audit_events | YES | YES | YES | Atomic RPC |
| **register_daily_production** | YES (OPERATOR) | Direct insert (RLS scoped to own entry) | daily_production, audit_events | Auto-audit | YES | YES (flock_id + date UNIQUE) | RLS restricts to creator; UNIQUE constraint |
| **register_mortality** | NO (needs unique constraint check) | RPC OR constraint: UNIQUE(flock_id, event_date) per frozen rule | population_events, audit_events | YES | YES | NO (enforced by UNIQUE) | Unique constraint BEFORE insert; constraint violation informs operator |
| **rectify_mortality** | NO | RPC: DELETE old + INSERT new + audit | population_events, audit_events | YES | YES | NO (ADMIN only) | Atomic RPC |
| **register_population_count_adjustment** | NO | RPC: INSERT adjustment event + audit | population_events, audit_events | YES | YES | YES | Atomic RPC |
| **register_classification** | MAYBE (session creation safe) | RPC (lightweight): create session + insert lines atomically | classifications, classification_lines, audit_events | YES | YES | YES (session_date + location UNIQUE) | Atomic RPC (lightweight) |
| **close_management_period** | NO | RPC: integral check (no PENDING facts) + update status + audit | management_periods, audit_events | YES | N/A (period close itself) | NO (ADMIN, once only) | Atomic RPC + FOR UPDATE lock |
| **reopen_management_period** | NO | RPC (rare): change CLOSED→OPEN + audit reason | management_periods, audit_events | YES | N/A | NO (ADMIN, rare) | Atomic RPC + FOR UPDATE lock |
| **MP reconciliation** | NO | RPC (backend service-role): validate + link → financial_operation | mp_source_record, mp_financial_movement, reconciliation_event, financial_operations, financial_postings | YES | YES | YES | Atomic RPC (complex N:N matching) |

---

## CRITICAL ATOMIC OPERATIONS (MUST BE TRANSACTIONAL)

### 1. **deliver_order** (PENDING → DELIVERED)

**Why atomic:**
- Move order state
- Create GL posting (revenue recognition)
- Create CC movement (invoice client)
- If GL fails but order state changes → GL orphaned
- If order update fails but GL posts → order state lies

**Frozen inputs:**
- order_id, new_estado='DELIVERED', delivered_at

**Transaction steps:**
```
BEGIN TRANSACTION
  SELECT pedidos FOR UPDATE (lock row)
  IF estado ≠ 'PENDING' RAISE ERROR
  
  INSERT financial_operation (type='SALE_DELIVERY')
  INSERT financial_posting (account=AR, amount=+total, effective_date=delivered_at)
  INSERT client_ledger (movement_type='SALE', signed_amount=+total, effective_date=delivered_at)
  
  UPDATE pedidos SET estado='DELIVERED', delivered_at=NOW()
  
  INSERT audit_event (entity='pedido', action='UPDATE', before/after/reason/user/time)
COMMIT
```

**Idempotency:** receipt_id or (order_id, delivered_at) unique constraint

**Period check:** Validate effective_date period OPEN before INSERT financial_posting

---

### 2. **register_collection** (Payment received)

**Why atomic:**
- Create collection record
- Reduce client CC
- Possibly create/update financial instrument state (cheque received)
- If collection inserts but CC doesn't reduce → client debt wrong

**Frozen inputs:**
- client_id, amount, payment_method, receipt_id (UNIQUE)

**Transaction steps:**
```
BEGIN TRANSACTION
  SELECT management_periods WHERE effective_date period FOR UPDATE
  IF period CLOSED RAISE ERROR "Period closed"
  
  INSERT collection (client_id, amount, receipt_id, ...)
  INSERT client_ledger (client_id, movement_type=COLLECTION, signed_amount=-amount, effective_date)
  
  IF payment_method='CHEQUE':
    INSERT financial_instrument (...)
    INSERT financial_instrument_event (event=RECEIVED, ...)
  
  IF payment_method='CASH' OR 'TRANSFER':
    INSERT financial_operation (type=COLLECTION)
    INSERT financial_posting (account=target, amount=+amount, effective_date)
  
  INSERT audit_event
COMMIT
```

**Idempotency:** receipt_id UNIQUE (duplicate receipt fails)

---

### 3. **transfer_between_accounts** (MP → BNA)

**Why atomic:**
- Create posting from source (negative)
- Create posting to destination (positive)
- If only one posts, account balance permanently diverged

**Frozen inputs:**
- source_account_id, dest_account_id, amount, transfer_id (UNIQUE)

**Transaction steps:**
```
BEGIN TRANSACTION
  SELECT management_periods WHERE effective_date period FOR UPDATE
  IF period CLOSED RAISE ERROR
  
  INSERT financial_operation (type='TRANSFER', transfer_id)
  INSERT financial_posting (account=source, amount=-amount, operation_id)
  INSERT financial_posting (account=dest, amount=+amount, operation_id)
  
  INSERT audit_event (both postings or neither)
COMMIT
```

**Idempotency:** transfer_id UNIQUE

**Invariant:** Both postings must have same operation_id; FK enforces atomic group

---

### 4. **register_mortality** (With unique constraint)

**Why atomic:**
- Check uniqueness
- Insert event
- If duplicate exists, reject clearly

**Frozen rule:** Max ONE MORTALITY per (flock_id, event_date)

**Options:**

**Option A: Direct INSERT + constraint**
```sql
BEGIN TRANSACTION
  SELECT management_periods WHERE production_date period FOR UPDATE
  IF period CLOSED RAISE ERROR
  
  INSERT INTO population_events (flock_id, event_date, type='MORTALITY', delta=-count)
    ON CONFLICT (flock_id, event_date) WHERE type='MORTALITY'
    DO UPDATE SET delta=EXCLUDED.delta RETURNING id
COMMIT
```
→ Idempotent; duplicate updates value if different

**Option B: RPC with friendly error**
```
RPC register_mortality(flock_id, event_date, count, reason)
  SELECT FROM population_events WHERE (flock_id, event_date, type) = (...) 
    FOR UPDATE
  IF EXISTS:
    RAISE ERROR 'Mortality already recorded: ' || existing.delta || ' birds. To change, use Rectify workflow.'
  ELSE:
    INSERT population_events
    INSERT audit_event
```

**Recommendation:** Option B (RPC) for better UX; inform operator of existing value + offer rectification workflow

---

### 5. **receive_cheque** (Instrument + CC impact)

**Why atomic:**
- Create instrument record
- Record state (RECEIVED)
- Reduce client CC
- If state changes but CC doesn't reduce → ledger incorrect

**Transaction steps:**
```
BEGIN TRANSACTION
  SELECT management_periods WHERE received_date period FOR UPDATE
  IF period CLOSED RAISE ERROR
  
  INSERT financial_instrument (cheque_number, amount, received_date, estado='RECEIVED')
  INSERT financial_instrument_event (instrument_id, event='RECEIVED', event_date=received_date)
  
  INSERT client_ledger (movement_type='CHEQUE_RECEIVED', signed_amount=-amount, effective_date=received_date)
  
  INSERT audit_event
COMMIT
```

**Idempotency:** cheque_number UNIQUE (per bank)

---

### 6. **close_management_period** (Integral closure)

**Why atomic:**
- Check that no PENDING/OPEN facts exist in period
- Lock period
- Mark CLOSED
- Record reason/user/time
- Audit

**Frozen requirement:** Integral closure protects commercial + economic + financial + productive + cost + fiscal

**Transaction steps:**
```
BEGIN TRANSACTION
  SELECT management_periods WHERE period_date FOR UPDATE (lock)
  
  IF status='CLOSED' RAISE ERROR 'Period already closed'
  
  -- Verify no PENDING facts in this period
  SELECT COUNT(*) FROM pedidos WHERE estado='PENDING' AND EXTRACT MONTH FROM delivered_at = period_month
  IF count > 0 RAISE ERROR 'Cannot close; pending orders exist'
  
  SELECT COUNT(*) FROM purchases WHERE estado='PENDING' AND EXTRACT MONTH FROM economic_date = period_month
  IF count > 0 RAISE ERROR 'Cannot close; pending purchases exist'
  
  -- (Similar checks for financial operations, etc.)
  
  UPDATE management_periods SET status='CLOSED', closed_at=NOW(), closed_by=auth.uid(), close_reason=reason
  
  INSERT audit_event (action='CLOSE_PERIOD', reason=close_reason)
COMMIT
```

**Locks:** FOR UPDATE to prevent concurrent closes

---

## RACE CONDITION SCENARIOS & MITIGATIONS

### Scenario 1: Concurrent Collections (Double CC Deduction)

**Users:** OPERATOR A + OPERATOR B both receive payment from Client X, same amount, same time

**Without atomicity:**
```
A: crearPago() → inserts pago record (id=1)
B: crearPago() → inserts pago record (id=2) [concurrent]
A: crearMovimientoCaja() → client CC reduced once
B: crearMovimientoCaja() → client CC reduced AGAIN
Result: Two pago records (correct), CC reduced twice (WRONG)
```

**With atomic RPC:**
```
RPC register_collection(client, amount, receipt_id)
  BEGIN TRANSACTION
    INSERT collection (receipt_id UNIQUE, ...)
    INSERT client_ledger movement
  COMMIT
→ If concurrent, one succeeds; other fails with "duplicate receipt_id"
→ CC always correct; operator informed: "This receipt already recorded"
```

---

### Scenario 2: Mortality Duplicate (Violates Frozen Rule)

**Users:** OPERATOR A + OPERATOR B enter mortality for Shed 1, same date

**Without UNIQUE constraint:**
```
A: INSERT INTO population_events (flock_id=1, event_date='2026-09-24', type='MORTALITY', delta=-5)
B: INSERT INTO population_events (flock_id=1, event_date='2026-09-24', type='MORTALITY', delta=-8) [concurrent]
Result: TWO mortality records ← VIOLATES frozen constraint
Population: -5 + -8 = -13 (inconsistent; no single source of truth)
```

**With UNIQUE constraint + RPC:**
```
RPC register_mortality(flock_id, event_date, count)
  BEGIN TRANSACTION
    SELECT WHERE (flock_id, event_date, type='MORTALITY') FOR UPDATE
    IF EXISTS RAISE ERROR 'Mortality recorded: ' || existing.delta
    ELSE INSERT
  COMMIT
→ A succeeds; B fails with friendly error
→ Operator informed of existing value; offered rectification option
```

---

### Scenario 3: Cheque Endorsement Race (Instrument State Divergence)

**Users:** OPERATOR A endorses cheque to supplier; concurrent OPERATOR B tries to clear it

**Without atomic RPC:**
```
Cheque estado = RECEIVED
A: UPDATE cheques SET estado='ENDORSED_TO_SUPPLIER'
  [succeeds; estado now ENDORSED_TO_SUPPLIER]
  [next: reverse CC, open supplier CC — but fails mid-operation]
  Cheque state ← ENDORSED (but CC reversal incomplete)
B: UPDATE cheques SET estado='CLEARED' [concurrent, succeeds]
  [posts to bank]
  Cheque estado ← CLEARED
Result: ENDORSED + CLEARED state incompatible
  CC never reversed, supplier CC never opened, but bank posting created
  → Ledger consequences diverged from instrument state
```

**With atomic RPC + state validation:**
```
RPC endorse_cheque(cheque_id, supplier_id)
  BEGIN TRANSACTION
    SELECT FROM financial_instrument WHERE id=cheque_id FOR UPDATE
    IF estado ≠ 'RECEIVED' RAISE ERROR 'State must be RECEIVED, got ' || estado
    UPDATE cheques SET estado='ENDORSED'
    INSERT client_ledger reversal
    INSERT supplier_ledger opening
  COMMIT
→ A's transaction locks cheque; B waits for lock
→ B sees estado='ENDORSED', raises "state must be RECEIVED" error
→ Prevents concurrent state transitions on same instrument
```

---

### Scenario 4: Collection + Movement Split (Orphaned Record)

**Current code pattern:** crearPago() (req 1), then crearMovimientoCaja() (req 2)

**Race condition:**
```
OPERATOR A: crearPago(cliente_id, monto=10000)
  → pago inserted (id=456)
  [network timeout]
OPERATOR B (dashboard): queries cash balance for day = 0
  [correct, no cash yet]
OPERATOR A: gives up or retries
Result: pago exists (collection recorded), NO movimiento_caja (cash not registered)
  Client CC reduced? (no, awaiting movimiento)
  Cash balance understated forever (pago orphaned)
```

**With atomic RPC:**
```
RPC register_collection(client_id, amount, receipt_id)
  BEGIN TRANSACTION
    INSERT collections (receipt_id UNIQUE)
    INSERT client_ledger
  COMMIT (or both fail)
→ If network fails mid-transaction, entire operation rolls back
→ Retry-safe: if collection exists with same receipt_id, idempotent
→ Both records always exist together or neither
```

---

### Scenario 5: Period Closure Race (Late Data After Close)

**Users:** ADMIN closes period 2026-09 (9 PM); OPERATOR still entering production (late data)

**Without transaction boundary check:**
```
Period 2026-09 status = OPEN
ADMIN: UPDATE management_periods SET status='CLOSED' WHERE period='2026-09'
OPERATOR: INSERT daily_production (production_date='2026-09-24', ...) [concurrent]
  → INSERT succeeds (no period check in direct table write)
Result: Production record in CLOSED period
  P&L calculated at 9 PM = $X
  P&L recalculated with late data = $X + delta
  Audit unclear: when was data added? After close?
```

**With atomic transaction + period validation:**
```
RPC register_daily_production(flock_id, production_date, quantities)
  BEGIN TRANSACTION
    SELECT FROM management_periods 
      WHERE period_date = DATE_TRUNC('month', production_date)
      FOR UPDATE
    IF status='CLOSED' RAISE ERROR 'Period closed; request reopen if needed'
    INSERT daily_production
  COMMIT
→ INSERT rejected if period CLOSED
→ OPERATOR informed: "Period is closed. Reopen required for late data."
→ Reopen audit trail clear + transparent
```

---

## IDEMPOTENCY REQUIREMENTS

**Operations that need idempotency** (UI may retry on timeout):

| Operation | Idempotency Key | Protection | Risk if not idempotent |
|---|---|---|---|
| deliver_order | (order_id, delivered_at) | Unique index | Double-post GL; duplicate revenue |
| register_collection | receipt_id | UNIQUE constraint | Double-debit client CC |
| register_purchase | (supplier_id, invoice_num, economic_date) | UNIQUE constraint | Double supplier debt |
| transfer_between_accounts | transfer_id | UNIQUE constraint | Orphaned postings |
| receive_cheque | cheque_number | UNIQUE constraint | Duplicate instrument |
| register_daily_production | (flock_id, production_date) | UNIQUE constraint | Double-count eggs |
| register_mortality | (flock_id, event_date) | UNIQUE constraint | Population wrong |
| register_classification | (session_date, location) | UNIQUE or hash | Duplicate batch |

**Design pattern:**

```sql
-- Example: receive_cheque
INSERT INTO financial_instrument (cheque_number, amount, ...)
  ON CONFLICT (cheque_number, bank_id) DO UPDATE
  SET updated_at=NOW()
  RETURNING id;
  
-- If cheque_number already exists:
--  - Return existing instrument_id (idempotent)
--  - Update timestamp
--  - Do NOT create duplicate
```

---

## PERIOD CLOSURE PROTECTION

**Every write operation's RPC must:**

1. **Determine effective_date** per frozen rules (delivered_at for sales, economic_date for purchases, etc.)

2. **Within transaction, BEFORE any INSERT/UPDATE:**

```sql
SELECT status FROM management_periods 
  WHERE DATE_TRUNC('month', effective_date) = DATE_TRUNC('month', NOW())
  FOR UPDATE;  -- Lock to prevent concurrent close

IF status = 'CLOSED' THEN
  RAISE EXCEPTION 'Period % is closed. Request reopen to enter late data.', 
    TO_CHAR(effective_date, 'YYYY-MM');
END IF;
```

3. **Proceed with INSERT/UPDATE only if OPEN**

**Current issue:** Zero period validation in current code. Late MP data, late production, late collections all silently insert into closed periods.

**Future improvement:** Add management_period.freeze_date (earlier than status change) to warn operators of imminent closure.

---

## RPC vs DIRECT TABLE WRITE RECOMMENDATIONS

| **Entity** | **OPERATOR Can Write Directly?** | **Reasoning** | **Recommendation** |
|---|---|---|---|
| **daily_production** | YES | Single-entity fact, no cross-table consequences | Direct insert OK (RLS scoped; period check in RPC gateway if strict) |
| **population_events** | NO | Affects population calculation + cost allocation | RPC (needs unique constraint check + period check) |
| **temperature_records** | YES | Monitoring data, no business consequence | Direct insert OK |
| **classification** | MAYBE | Session creation safe; lines should be atomic batch | RPC (lightweight: create session + insert lines in one txn) |
| **flock_weighings** | YES | Measurement data, no consequence | Direct insert OK |
| **pedidos** (PENDING only) | YES | Pending order is local state, no GL/CC yet | Direct insert OK; RPC only for PENDING→DELIVERED |
| **pedido_lineas** | YES (if PENDING pedido) | Read-only consequence of pedido line | Direct insert OK; DELETE only via pedido rectification RPC |
| **collections** | NO | Reduces client debt immediately | RPC (atomic collection + CC movement) |
| **movimientos_caja** | NO | Financial consequence; must sync with source operation | RPC (never solo direct insert) |
| **financial_postings** | NO | Core ledger; MUST be atomic paired (transfer) or paired with origin (collection→posting) | **RPC ONLY** (never direct table write) |
| **financial_instrument** | NO | State machine; state+consequence must be atomic | RPC for state transitions (receive, endorse, clear, reject) |
| **cheques** | NO | Instrument state; ledger consequences | RPC for state transitions |
| **purchases** | NO | Creates supplier debt obligation | RPC (atomic purchase + supplier_ledger) |
| **supplier_ledger** | NO | Derived consequence of purchase/payment | RPC (never direct; only via purchase/payment RPCs) |
| **client_ledger** | NO | Immutable ledger fact; audit trail | RPC (never direct) |

---

## MARKED AS POTENTIAL ADR REQUIRED

**Frozen rule creates concurrency concern:**

> "PART 11: Constraint: Max ONE MORTALITY per (flock_id, event_date). Duplicate attempt: Reject (already exists). Operator informed; rectify if wrong."

**Implementation choice needed:**

**Option A: Database constraint + error handling**
- UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY'
- Duplicate INSERT → constraint violation error
- Application catches error, queries existing value, informs operator

**Option B: RPC pre-check + insert**
- RPC queries existing before insert
- If exists: RAISE ERROR with current value
- If not exists: INSERT

**Recommendation:** Option B (RPC) provides better UX + audit trail. Schema should still have UNIQUE constraint as backup.

---

**Status:** Ready for RPC implementation design. All atomic boundaries defined; no unresolved concurrency issues.
