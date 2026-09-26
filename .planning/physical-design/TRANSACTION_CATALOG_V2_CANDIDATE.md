# TRANSACTION CATALOG V2 — CANDIDATE

**STATUS:** Round 2 corrections applied; corrected RPC semantics  
**DATE:** 2026-09-24  
**CHANGES FROM V1:** 3 critical fixes (deliver_order, endorse_cheque, rectify patterns)

---

## EXECUTIVE SUMMARY OF CORRECTIONS

### Finding 1: deliver_order (CORRECTED)

**V1 ERROR:** Created financial_posting for all orders (including credit sales).

**V2 CORRECTION:**
- **NO financial_operation creation**
- **NO financial_posting creation** (credit sale is NOT cash/treasury event)
- Only client_ledger debt entry + audit
- Only register_collection RPC creates financial_posting (when payment received)

**Rationale:** Frozen architecture separates economic (client_ledger) from financial (cash accounts). Sale delivery is economic; collection is financial.

---

### Finding 2: endorse_cheque (CORRECTED)

**V1 ERROR:** Created client_ledger reversal (reopened client debt).

**V2 CORRECTION:**
- **NO client_ledger reversal entry**
- Client debt stays PAID (cheque is valid payment)
- Only supplier_ledger -amount (new obligation to supplier)
- Instrument state transition only
- Audit only

**Rationale:** Frozen rule: "Endorsement does NOT reopen client CC debt." Payment is still valid; cheque custody changes to supplier.

---

### Finding 3: Mortality & Rectification (CLARIFIED)

**V1:** Unclear if duplicate registration allowed.

**V2 CLARIFICATION:**
- **register_mortality RPC:** Validate UNIQUE(flock_id, event_date) BEFORE insert; REJECT on duplicate (not silent UPDATE)
- **rectify_mortality RPC:** DELETE old + INSERT new + audit (append-only pattern)

---

## TRANSACTION DECISION TABLE (CORRECTED)

| **Operation** | **Direct writes?** | **Atomic boundary** | **Main tables** | **Period check?** | **Idempotency** | **Status** |
|---|---|---|---|---|---|---|
| **deliver_order** | NO | RPC: pedido + CC movement | pedidos, client_ledger, audit_events | YES | receipt_id | ✓ CORRECTED |
| **register_collection** | NO | RPC: collection + CC + instrument | collections, client_ledger, financial_instrument_event, financial_posting | YES | receipt_id | ✓ CORRECT |
| **transfer_between_accounts** | NO | RPC: both postings atomic | financial_operation, financial_posting | YES | transfer_id | ✓ CORRECT |
| **receive_cheque** | NO | RPC: instrument + CC movement | financial_instrument, client_ledger, audit_events | YES | cheque_number | ✓ CORRECT |
| **deposit_cheque** | NO | RPC: state transition only | financial_instrument, financial_instrument_event | YES | cheque_number+date | ✓ CORRECT |
| **clear_cheque** | NO | RPC: state + posting | financial_instrument, financial_posting | YES | cheque_number+date | ✓ CORRECT |
| **endorse_cheque** | NO | RPC: state + supplier ledger | financial_instrument, supplier_ledger, audit_events | YES | cheque_number | ✓ CORRECTED |
| **reject_cheque** | NO | RPC: state + reversal | financial_instrument, client_ledger, audit_events | YES | cheque_number | ✓ CLARIFIED |
| **register_mortality** | NO | CONSTRAINT or RPC | population_events | YES | UNIQUE prevents | ✓ CLARIFIED |
| **rectify_mortality** | NO | RPC: old DELETE + new INSERT | population_events, audit_events | YES | admin-only | ✓ CORRECT |
| **register_classification** | MAYBE | RPC (lightweight) | classification, classification_line | YES | idempotency_key UNIQUE (technical) | ✓ CORRECTED |
| **register_purchase** | NO | RPC: purchase + supplier ledger | purchases, supplier_ledger, audit_events | YES | invoice_num | ✓ CORRECT |
| **close_management_period** | NO | RPC: integral check + update | management_period, audit_events | N/A | once-only | ✓ CORRECT |

---

## CRITICAL ATOMIC OPERATIONS

### 1. deliver_order (CORRECTED)

**Purpose:** Transition PENDING → DELIVERED; record economic sale (client debt).

**Frozen inputs:**
- order_id, delivered_at

**V2 RPC transaction:**

```sql
BEGIN TRANSACTION
  SELECT pedidos FOR UPDATE WHERE id=order_id
  IF estado ≠ 'PENDING' RAISE ERROR "Cannot deliver non-pending order"
  
  -- 1. Update order state
  UPDATE pedidos SET estado='DELIVERED', delivered_at=delivered_at WHERE id=order_id
  
  -- 2. Create client ledger entry (debt)
  INSERT client_ledger (
    cliente_id,
    movement_type='SALE_DELIVERY',
    signed_amount=order_total,
    effective_date=delivered_at,
    ledger_client_name=(SELECT cliente.nombre),
    created_by=auth.uid()
  )
  
  -- 3. Validate period OPEN (frozen rule)
  SELECT management_period WHERE delivered_at BETWEEN period_date AND (period_date + INTERVAL 1 MONTH)
  IF status ≠ 'OPEN' RAISE ERROR "Period closed; cannot deliver order"
  
  -- 4. Audit
  INSERT audit_event (entity_type='pedido', entity_id=order_id, action='DELIVER', after_values, reason, performed_by, performed_at)
COMMIT
```

**What changed from V1:**
- **REMOVED:** INSERT financial_operation
- **REMOVED:** INSERT financial_posting
- Sale is NOT cash; posting only happens at collection

**Idempotency:** Delivered order is immutable; second attempt fails on UPDATE (already DELIVERED)

---

### 2. register_collection (UNCHANGED but clarified)

**Purpose:** Record payment received (cash, transfer, or cheque).

**Frozen inputs:**
- client_id, amount, payment_method (CASH | TRANSFER | CHEQUE | MERCADOPAGO), receipt_id (UNIQUE)

**RPC transaction:**

```sql
BEGIN TRANSACTION
  -- Validate period OPEN
  SELECT management_period WHERE effective_date period FOR UPDATE
  IF status ≠ 'OPEN' RAISE ERROR
  
  -- Insert collection fact
  INSERT collection (client_id, amount, payment_method, receipt_id, effective_date, created_by)
  
  -- Reduce client CC (payment)
  INSERT client_ledger (
    cliente_id,
    movement_type='COLLECTION',
    signed_amount=-amount,
    effective_date,
    created_by
  )
  
  -- If cheque: create instrument + event (no posting yet)
  IF payment_method='CHEQUE':
    INSERT financial_instrument (cheque_number, amount, estado='RECEIVED', ...)
    INSERT financial_instrument_event (event_type='RECEIVED', ...)
  
  -- If cash/transfer: create posting immediately (cash received)
  ELSIF payment_method IN ('CASH', 'TRANSFER', 'MERCADOPAGO'):
    INSERT financial_operation (operation_type='COLLECTION', transfer_id=receipt_id)
    INSERT financial_posting (account=target_account, amount=+amount, effective_date)
  
  -- Audit
  INSERT audit_event (...)
COMMIT
```

**Key:** Cheque received = client debt reduced + instrument stored; only CLEARED cheque creates bank posting.

---

### 3. clear_cheque (CLARIFIED)

**Purpose:** Cheque physically clears (touches bank; bank credit confirmed).

**RPC transaction:**

```sql
BEGIN TRANSACTION
  SELECT financial_instrument FOR UPDATE WHERE id=cheque_id
  IF estado ≠ 'DEPOSITED' RAISE ERROR "Can only clear deposited cheque"
  
  -- Update instrument state
  UPDATE financial_instrument SET estado='CLEARED' WHERE id=cheque_id
  
  -- Create financial posting (bank credit confirmed)
  INSERT financial_operation (operation_type='CHEQUE_CLEAR', transfer_id=cheque_number)
  INSERT financial_posting (account=destination_account, amount=+cheque_amount, effective_date=cleared_date)
  
  -- Audit
  INSERT audit_event (...)
COMMIT
```

**Key:** ONLY CLEARED creates posting. RECEIVED/DEPOSITED = no bank entry yet.

---

### 4. endorse_cheque (CORRECTED)

**Purpose:** Endorse received cheque to supplier (transfers cheque custody; reduces supplier debt obligation to Santo Tomás).

**Frozen inputs:**
- cheque_id, supplier_id

**Frozen semantic:** Endorsement to supplier REDUCES our debt TO supplier (not increases).

**V2 RPC transaction:**

```sql
BEGIN TRANSACTION
  SELECT financial_instrument FOR UPDATE WHERE id=cheque_id
  IF estado ≠ 'RECEIVED' RAISE ERROR "Can only endorse received cheque"
  
  -- 1. Update instrument state (custody changes)
  UPDATE financial_instrument SET estado='ENDORSED' WHERE id=cheque_id
  
  -- 2. Create instrument event (custody/state transition)
  INSERT financial_instrument_event (instrument_id, event_type='ENDORSED', event_date)
  
  -- 3. Create supplier ledger entry
  --    signed_amount = -cheque_amount
  --    Meaning: Supplier debt to Santo Tomás REDUCED by cheque_amount
  --    (We gave supplier a cheque; it cancels/reduces our obligation to pay them)
  INSERT supplier_ledger (
    supplier_id,
    movement_type='CHEQUE_ENDORSED',
    signed_amount=-cheque_amount,
    effective_date,
    created_by
  )
  
  -- 4. CRITICAL: NO client_ledger reversal
  --    Client payment via cheque is FINAL and VALID
  --    Endorsement to supplier is SEPARATE fact
  --    Client debt remains PAID
  
  -- 5. Audit
  INSERT audit_event (...)
COMMIT
```

**What changed from V1:**
- **REMOVED:** INSERT client_ledger reversal
- Client remains PAID (cheque is valid payment; custody change doesn't reopen debt)
- **CLARIFIED:** supplier_ledger -amount CANCELS/REDUCES existing supplier debt, not creates new obligation

**Key:** Endorsement transfers cheque to supplier as payment for THEIR debt to us. It's a custody event AND a supplier payment, not a client payment reversal.

---

### 5. reject_cheque (STATE-SPECIFIC SEMANTICS)

**Purpose:** Cheque rejected (bounced or returns unpaid).

**Frozen requirement:** Rejection consequences depend on which state cheque was in when rejected.

**V2 RPC transaction:**

```sql
BEGIN TRANSACTION
  SELECT financial_instrument FOR UPDATE WHERE id=cheque_id
  original_estado = financial_instrument.estado
  
  -- 1. Update instrument state to REJECTED
  UPDATE financial_instrument SET estado='REJECTED' WHERE id=cheque_id
  
  -- 2. Create instrument event
  INSERT financial_instrument_event (instrument_id, event_type='REJECTED', event_date)
  
  -- 3. Handle consequences based on ORIGINAL state
  
  IF original_estado='RECEIVED':
    -- Cheque was in portfolio; never touched bank
    -- Client debt was reduced when cheque received
    -- Rejection invalidates the cheque; restore client debt
    INSERT client_ledger (
      cliente_id,
      movement_type='CHEQUE_REJECTED',
      signed_amount=+cheque_amount,
      effective_date=rejection_date,
      created_by
    )
    -- No financial posting to reverse (never created)
  
  ELSIF original_estado='DEPOSITED':
    -- Cheque was deposited but not yet cleared
    -- No financial posting exists (posting only on CLEARED)
    -- Client debt was reduced when received; stays reduced
    -- Rejection is terminal state; no client consequence yet
    -- Bank must handle actual return
    -- No financial posting to reverse (never created)
  
  ELSIF original_estado='CLEARED':
    -- Cheque was cleared (bank credit received)
    -- Financial posting EXISTS (bank account was increased)
    -- Bank is revoking the credit (check bounced post-clearing)
    -- Create COMPENSATING financial posting to reverse bank credit
    INSERT financial_operation (operation_type='CHEQUE_REJECTION', cheque_id)
    INSERT financial_posting (account=same_bank_account, amount=-cheque_amount, effective_date=rejection_date)
    -- Client debt CANNOT be restored; payment already accepted
    -- Cheque rejection is bank problem; client responsibility is separate issue (may require manual collections)
  
  -- 4. Audit with full before/after
  INSERT audit_event (
    entity_type='financial_instrument',
    entity_id=cheque_id,
    action='REJECT',
    before_values={estado, amount},
    after_values={REJECTED, amount},
    reason,
    performed_by,
    performed_at
  )
COMMIT
```

**Key:**
- **RECEIVED→REJECTED:** Restore client debt (cheque never valid)
- **DEPOSITED→REJECTED:** Client debt stays reduced; bank handles return
- **CLEARED→REJECTED:** Create compensating financial posting (bank reversal); client debt NOT restored
- No silent reversals; explicit state-based consequences; complete audit trail

---

### 6. register_mortality (CLARIFIED)

**Purpose:** Record bird death event; enforce uniqueness.

**Frozen rule:** Max ONE MORTALITY per (flock_id, event_date).

**V2 RPC transaction:**

```sql
BEGIN TRANSACTION
  -- Validate uniqueness BEFORE insert
  SELECT population_events 
    WHERE flock_id=flock_id 
      AND event_date=event_date 
      AND event_type='MORTALITY'
  
  IF found RAISE ERROR "Mortality already recorded for this flock on this date; use rectify_mortality to correct"
  
  -- Insert event
  INSERT population_events (
    flock_id,
    event_type='MORTALITY',
    delta=-delta,
    event_date,
    created_by
  )
  
  -- Audit
  INSERT audit_event (...)
COMMIT
```

**Key:** REJECT on duplicate; never silent UPDATE.

---

### 7. rectify_mortality (SUPERSESSION WITH HISTORY PRESERVED)

**Purpose:** Correct previous mortality record while preserving complete history.

**Frozen requirement:** Original mortality fact must remain historically preserved; only ONE mortality is CURRENT/EFFECTIVE for (flock_id, event_date); rectification is ADMIN-only; period OPEN applies.

**V2 RPC transaction:**

```sql
BEGIN TRANSACTION
  SELECT management_period WHERE event_date period
  IF status ≠ 'OPEN' RAISE ERROR "Must reopen period to rectify historical mortality"
  
  SELECT population_events WHERE id=original_event_id FOR UPDATE
  
  -- Mark original as superseded (not deleted)
  UPDATE population_events SET superseded_by=new_event_id, superseded_at=NOW(), superseded_reason=reason WHERE id=original_event_id
  
  -- Insert new corrected event
  INSERT population_events (
    flock_id, 
    event_type='MORTALITY', 
    delta=corrected_delta, 
    event_date, 
    supersedes=original_event_id,
    is_current=true,
    created_by
  )
  
  -- Audit: complete before/after + reason
  INSERT audit_event (
    entity_type='population_event', 
    entity_id=original_event_id,
    action='RECTIFY',
    before_values={original delta},
    after_values={corrected delta},
    reason=rectification_reason,
    performed_by,
    performed_at
  )
COMMIT
```

**Uniqueness enforcement:** UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' AND is_current=true

This allows:
- ✓ Original mortality preserved (superseded_by tracks history)
- ✓ Only one CURRENT/EFFECTIVE mortality per (flock, date) 
- ✓ Duplicate normal registration still rejected (no is_current=true yet)
- ✓ Rectification explicit with before/after audit
- ✓ No hard DELETE; immutable history

**Key:** Supersession semantics preserve history while maintaining uniqueness of CURRENT effective fact.

---

### 8. transfer_between_accounts (UNCHANGED)

**Purpose:** Move money between bank accounts; both postings atomic.

**RPC transaction:**

```sql
BEGIN TRANSACTION
  -- Validate period OPEN
  SELECT management_period WHERE effective_date period FOR UPDATE
  
  -- Create operation parent
  INSERT financial_operation (operation_type='TRANSFER', transfer_id=transfer_id, effective_date)
  
  -- Create both postings atomically
  INSERT financial_posting (account=source, amount=-transfer_amount, operation_id=op_id)
  INSERT financial_posting (account=dest, amount=+transfer_amount, operation_id=op_id)
  
  -- Audit
  INSERT audit_event (...)
COMMIT
```

**Key:** Both postings or neither. Shared operation_id ensures atomicity.

---

## PERIOD CLOSURE PROTECTION

**Transversal rule:** All period-determining facts checked at INSERT/UPDATE.

| Operation | Period check | Enforcement |
|---|---|---|
| **deliver_order** | delivered_at period | SELECT period FOR UPDATE; IF CLOSED RAISE |
| **register_collection** | effective_date period | SELECT period FOR UPDATE; IF CLOSED RAISE |
| **register_mortality** | event_date period | SELECT period FOR UPDATE; IF CLOSED RAISE |
| **register_classification** | session_date period | SELECT period FOR UPDATE; IF CLOSED RAISE |
| **financial posting** | effective_date period | SELECT period FOR UPDATE; IF CLOSED RAISE |
| **register_purchase** | economic_date period | SELECT period FOR UPDATE; IF CLOSED RAISE |

**Exception:** Rectification may reopen period (ADMIN only; explicit audit trail).

---

## CONCURRENCY PROTECTION MATRIX

| Operation | Primary unique constraint | Duplicate handling |
|---|---|---|
| **deliver_order** | (pedido_id, DELIVERED estado) | Already delivered → ERROR |
| **register_collection** | receipt_id UNIQUE | Duplicate receipt → ERROR |
| **transfer_between_accounts** | transfer_id UNIQUE | Duplicate transfer → ERROR |
| **receive_cheque** | cheque_number UNIQUE | Duplicate number → ERROR |
| **register_mortality** | UNIQUE(flock_id, event_date) WHERE event_type=MORTALITY | Duplicate → ERROR |
| **register_purchase** | invoice_num UNIQUE | Duplicate invoice → ERROR |
| **register_classification** | (session_date, location) now allows parallel | No longer unique |

---

## IMMUTABILITY ENFORCEMENT

**Append-only tables (RLS UPDATE DENY):**
- client_ledger
- financial_posting
- population_events
- audit_events
- mp_source_record

**Immutable rows (RLS UPDATE on condition):**
- daily_production: Cannot UPDATE after posting (period already passed)
- pedidos: Cannot UPDATE estado once DELIVERED
- classification_line: Cannot UPDATE once session posted
- financial_instrument: State machine validates transitions only

---

**STATUS:** CORRECTED AND READY FOR VALIDATION

All 3 critical corrections applied (deliver_order, endorse_cheque, clarifications).
Period protection defined transversally.
Concurrency protection explicit per operation.
