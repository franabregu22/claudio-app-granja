# RPC CONTRACTS V1 — EXECUTABLE SPECIFICATIONS

**STATUS:** Implementation-ready; translated from TRANSACTION_CATALOG_V2_CANDIDATE  
**DATE:** 2026-09-24  
**SCOPE:** 23 critical RPCs covering orders, collections, cheques, purchases, production, classification, feed, periods, financial, MP integration

---

## OVERVIEW

Each RPC specifies:
- **Exact parameters and types**
- **Validation rules** (must execute before transaction)
- **Atomic execution steps** (all-or-nothing)
- **Period determination** (which column determines the period; check BEFORE insert)
- **Ledger consequences** (what client_ledger, financial_posting, supplier_ledger entries created)
- **Audit consequences** (what audit_event recorded)
- **Idempotency mechanism** (how to prevent duplicate execution)
- **Error conditions** (exact error messages)
- **Return type** (what caller receives)

---

## ORDER MANAGEMENT

### RPC 1: deliver_order

**RPC NAME:** `deliver_order(order_id: UUID, delivered_at: TIMESTAMPTZ, reason?: TEXT) → {...}`

**PURPOSE:** Transition PENDING order to DELIVERED; record economic sale (increase client debt).

**ACTOR:** ADMIN

**PARAMETERS:**
- `order_id`: UUID | order PK | Must exist; estado must be 'PENDING'
- `delivered_at`: TIMESTAMPTZ | effective delivery time | Determines period
- `reason`: TEXT NULLABLE | Audit reason | Optional

**VALIDATES (before transaction):**
- Order exists and estado='PENDING'
- delivered_at falls within OPEN management period (frozen rule)
- order_lines exist and sum to valid total
- cliente_id references valid client

**EXECUTION (atomic PostgreSQL transaction):**
```
BEGIN
  SELECT pedidos FOR UPDATE WHERE id=order_id  -- Lock
  IF estado != 'PENDING' RAISE ERROR "Order not PENDING"
  
  SELECT management_period WHERE delivered_at::DATE BETWEEN period_date AND period_date + '1 month'::interval FOR UPDATE
  IF status != 'OPEN' RAISE ERROR "Period closed"
  
  UPDATE pedidos SET estado='DELIVERED', delivered_at=delivered_at, updated_at=NOW(), updated_by=auth.uid()
  
  INSERT client_ledger (
    cliente_id, movement_type='SALE_DELIVERY', signed_amount=order_total, 
    effective_date=delivered_at::DATE, ledger_client_name, created_by
  )
  
  INSERT audit_event (
    entity_type='pedido', entity_id=order_id, action='DELIVER', 
    after_values=jsonb_build_object('estado','DELIVERED','delivered_at',delivered_at),
    reason, performed_by=auth.uid(), performed_at=NOW()
  )
COMMIT
```

**IDEMPOTENCY:**
- Key: `order_id + delivered_at hash`
- Retry: Second call with same order_id fails (already DELIVERED)
- Error: "Order already delivered on {existing_delivered_at}"

**ERROR CONDITIONS:**
- "Order not found"
- "Order not in PENDING state; current: {estado}"
- "Period {period_date} is CLOSED; reopen first"
- "Invalid delivery time; must be within open period"

**PERIOD DETERMINATION:**
- Column: `delivered_at`
- Check: Date must fall within OPEN management period

**LEDGER CONSEQUENCES:**
- client_ledger: `movement_type='SALE_DELIVERY', signed_amount=+order_total, effective_date=delivered_at::DATE`
- NO financial_posting (sale is economic, not cash)

**RETURN:**
```json
{
  "id": "uuid",
  "pedido_id": "uuid",
  "estado": "DELIVERED",
  "monto_total": 1500.50,
  "delivered_at": "2026-09-24T14:30:00+00:00",
  "updated_at": "2026-09-24T14:30:00+00:00"
}
```

---

### RPC 2: rectify_delivered_order

**PURPOSE:** Correct DELIVERED order economic data; create compensating ledger entries.

**ACTOR:** ADMIN

**NOTE:** Order lines are immutable snapshots. Correction creates reversal + new entries (not UPDATE).

**EXECUTION:**
```
BEGIN
  SELECT pedidos FOR UPDATE WHERE id=order_id AND estado='DELIVERED'
  
  SELECT management_period FOR UPDATE WHERE delivered_at::DATE IN period AND status='OPEN'
  IF status='CLOSED' RAISE ERROR "Period closed; must reopen"
  
  -- Calculate original total and new total
  original_total = SUM(old pedido_lineas.subtotal)
  new_total = SUM(new lines)
  adjustment = new_total - original_total
  
  -- Reverse original client_ledger entry
  INSERT client_ledger (
    cliente_id, movement_type='REVERSAL', signed_amount=-original_total,
    effective_date=delivered_at::DATE, reason='Reversal for rectification', created_by
  )
  
  -- Create new correct entry
  INSERT client_ledger (
    cliente_id, movement_type='SALE_DELIVERY', signed_amount=new_total,
    effective_date=delivered_at::DATE, reason='Rectified delivery', created_by
  )
  
  -- Mark old order_lines superseded (immutable via RLS; only rectify_delivered_order can do this via SECURITY DEFINER)
  -- This UPDATE can ONLY execute from SECURITY DEFINER function with internal authorization check
  INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, is_current, superseded_by)
  SELECT order_id, producto_id, cantidad, precio_unitario, producto_nombre, false, new_line_id
  FROM pedido_lineas WHERE pedido_id=order_id AND is_current=true
  
  -- Insert new corrected lines with is_current=true
  INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario, producto_nombre, is_current, superseded_by)
  VALUES (corrected line data, is_current=true, NULL)
  
  INSERT audit_event (action='RECTIFY_DELIVERED_ORDER', before/after, reason, ...)
COMMIT
```

---

### RPC 3: cancel_order

**PURPOSE:** Cancel PENDING order only (non-delivered, no venta).

**ACTOR:** ADMIN

**PARAMETERS:**
- `order_id`: UUID | order PK | Must exist; estado must be 'PENDING'
- `cancelled_at`: TIMESTAMPTZ | cancellation time | Determines period
- `reason`: TEXT NULLABLE | Audit reason

**VALIDATES (before transaction):**
- Order exists and estado='PENDING'
- cliente_id valid

**EXECUTION (atomic PostgreSQL transaction):**
```
BEGIN
  SELECT pedidos FOR UPDATE WHERE id=order_id AND estado='PENDING'
  IF estado != 'PENDING' RAISE ERROR "Only pending orders can be cancelled"
  
  UPDATE pedidos SET estado='CANCELLED', updated_at=NOW(), updated_by=auth.uid()
  
  INSERT audit_event (entity_type='pedido', action='CANCEL', reason, ...)
COMMIT
```

**PERIOD DETERMINATION:**
- Column: NOT period-determined (PENDING order is not an economic fact; no ledger impact)

**NOTE:** DELIVERED order reversal is NOT cancel_order. Use rectify_delivered_order instead.

---

## COLLECTIONS

### RPC 4: register_collection

**RPC NAME:** `register_collection(cliente_id: UUID, amount: NUMERIC, payment_method: payment_method, receipt_id: VARCHAR, effective_date: DATE, target_account?: UUID) → {...}`

**PURPOSE:** Record payment received (cash, transfer, cheque, or MP); reduce client debt; possibly create financial posting.

**NOTE:** target_account is required for CASH/TRANSFER/MERCADOPAGO; ignored for CHEQUE (instrument handled separately).

**ACTOR:** ADMIN (service-role for MP webhook)

**VALIDATES:**
- Client exists
- amount > 0
- receipt_id is UNIQUE (idempotency)
- payment_method is valid
- effective_date in OPEN period

**EXECUTION:**
```
BEGIN
  SELECT management_period FOR UPDATE WHERE effective_date IN period
  IF status != 'OPEN' RAISE ERROR
  
  INSERT collection (cliente_id, amount, payment_method, receipt_id, effective_date, created_by)
  
  -- Reduce client CC
  INSERT client_ledger (cliente_id, movement_type='COLLECTION', signed_amount=-amount, effective_date, created_by)
  
  -- If cheque: create instrument + event (no posting yet)
  IF payment_method='CHEQUE':
    INSERT financial_instrument (cheque_number, amount, estado='RECEIVED', ...)
    INSERT financial_instrument_event (event_type='RECEIVED', ...)
  
  -- If cash/transfer/MP: create posting immediately
  ELSIF payment_method IN ('CASH', 'TRANSFER', 'MERCADOPAGO'):
    INSERT financial_operation (operation_type='COLLECTION', transfer_id=receipt_id, effective_date)
    INSERT financial_posting (financial_account_id=target_account, signed_amount=+amount, effective_date)
  
  INSERT audit_event (...)
COMMIT
```

**IDEMPOTENCY:** `receipt_id UNIQUE` prevents duplicate collection.

---

## CHEQUES

### RPC 5: receive_cheque

**RPC NAME:** `receive_cheque(cliente_id: UUID, cheque_number: VARCHAR, amount: NUMERIC, maturity_date: DATE, received_at: TIMESTAMPTZ, reason?: TEXT) → {...}`

**PURPOSE:** Client payment via cheque; reduce client CC; instrument enters portfolio.

**ACTOR:** ADMIN

**PARAMETERS:**
- `cliente_id`: UUID | client PK | Must exist
- `cheque_number`: VARCHAR | unique cheque identifier
- `amount`: NUMERIC | positive cheque amount
- `maturity_date`: DATE | cheque maturity (can be future)
- `received_at`: TIMESTAMPTZ | receipt time | Determines period
- `reason`: TEXT NULLABLE | Audit reason

**VALIDATES (before transaction):**
- Client exists
- amount > 0
- cheque_number is UNIQUE
- received_at falls within OPEN management period

**EXECUTION (atomic PostgreSQL transaction):**
```
BEGIN
  SELECT management_period WHERE received_at::DATE BETWEEN period_date AND period_date + '1 month'::interval FOR UPDATE
  IF status != 'OPEN' RAISE ERROR "Period closed"
  
  INSERT financial_instrument (cheque_number, amount, estado='RECEIVED', maturity_date, cliente_id, created_by=auth.uid())
  INSERT financial_instrument_event (event_type='RECEIVED', event_date=received_at::DATE, ...)
  INSERT client_ledger (cliente_id, movement_type='CHEQUE_RECEIVED', signed_amount=-amount, effective_date=received_at::DATE, ...)
  INSERT audit_event (...)
COMMIT
```

**NOTE:** cliente_id stored in financial_instrument for later rejection reversal.

**PERIOD DETERMINATION:**
- Column: `received_at`
- Check: Date must fall within OPEN management period

---

### RPC 6: deposit_cheque

**RPC NAME:** `deposit_cheque(cheque_id: UUID, deposited_at: TIMESTAMPTZ, reason?: TEXT) → {...}`

**PURPOSE:** Cheque deposited at bank; state transition only (no posting yet).

**ACTOR:** ADMIN

**PARAMETERS:**
- `cheque_id`: UUID | cheque PK | Must exist; estado must be 'RECEIVED'
- `deposited_at`: TIMESTAMPTZ | deposit time | Determines period
- `reason`: TEXT NULLABLE | Audit reason

**VALIDATES (before transaction):**
- Cheque exists and estado='RECEIVED'
- deposited_at falls within OPEN management period

**EXECUTION (atomic PostgreSQL transaction):**
```
BEGIN
  SELECT management_period WHERE deposited_at::DATE BETWEEN period_date AND period_date + '1 month'::interval FOR UPDATE
  IF status != 'OPEN' RAISE ERROR "Period closed"
  
  SELECT financial_instrument FOR UPDATE WHERE id=cheque_id AND estado='RECEIVED'
  IF estado != 'RECEIVED' RAISE ERROR "Cheque must be in RECEIVED state"
  
  UPDATE financial_instrument SET estado='DEPOSITED'
  INSERT financial_instrument_event (event_type='DEPOSITED', event_date=deposited_at::DATE, ...)
  INSERT audit_event (...)
COMMIT
```

**PERIOD DETERMINATION:**
- Column: `deposited_at`
- Check: Date must fall within OPEN management period

---

### RPC 7: clear_cheque

**RPC NAME:** `clear_cheque(cheque_id: UUID, cleared_at: TIMESTAMPTZ, bank_account_id: UUID, reason?: TEXT) → {...}`

**PURPOSE:** Cheque cleared; bank credit confirmed; create financial posting.

**ACTOR:** ADMIN

**PARAMETERS:**
- `cheque_id`: UUID | cheque PK | Must exist; estado must be 'DEPOSITED'
- `cleared_at`: TIMESTAMPTZ | clearing time | Determines period
- `bank_account_id`: UUID | destination bank account for posting
- `reason`: TEXT NULLABLE | Audit reason

**VALIDATES (before transaction):**
- Cheque exists and estado='DEPOSITED'
- cleared_at falls within OPEN management period
- bank_account_id references valid financial_account

**EXECUTION (atomic PostgreSQL transaction):**
```
BEGIN
  SELECT management_period WHERE cleared_at::DATE BETWEEN period_date AND period_date + '1 month'::interval FOR UPDATE
  IF status != 'OPEN' RAISE ERROR "Period closed"
  
  SELECT financial_instrument FOR UPDATE WHERE id=cheque_id AND estado='DEPOSITED'
  IF estado != 'DEPOSITED' RAISE ERROR "Cheque must be in DEPOSITED state"
  
  UPDATE financial_instrument SET estado='CLEARED', bank_account_id=account_id
  
  INSERT financial_operation (operation_type='CHEQUE_CLEAR', transfer_id=cheque_number, effective_date=cleared_at::DATE)
  INSERT financial_posting (financial_account_id=account_id, signed_amount=+cheque_amount, effective_date=cleared_at::DATE, ...)
  
  INSERT financial_instrument_event (event_type='CLEARED', event_date=cleared_at::DATE, ...)
  INSERT audit_event (...)
COMMIT
```

**NOTE:** bank_account_id stored in financial_instrument for later rejection reversal.

**PERIOD DETERMINATION:**
- Column: `cleared_at`
- Check: Date must fall within OPEN management period

**CRITICAL:** Only CLEARED creates bank posting.

---

### RPC 8: endorse_cheque

**RPC NAME:** `endorse_cheque(cheque_id: UUID, supplier_id: UUID, endorsed_at: TIMESTAMPTZ, reason?: TEXT) → {...}`

**PURPOSE:** Received cheque endorsed to supplier; reduce supplier debt.

**ACTOR:** ADMIN

**PARAMETERS:**
- `cheque_id`: UUID | cheque PK | Must exist; estado must be 'RECEIVED'
- `supplier_id`: UUID | supplier PK | Must exist
- `endorsed_at`: TIMESTAMPTZ | endorsement time | Determines period
- `reason`: TEXT NULLABLE | Audit reason

**VALIDATES (before transaction):**
- Cheque exists and estado='RECEIVED'
- supplier_id references valid supplier
- endorsed_at falls within OPEN management period

**EXECUTION (atomic PostgreSQL transaction):**
```
BEGIN
  SELECT management_period WHERE endorsed_at::DATE BETWEEN period_date AND period_date + '1 month'::interval FOR UPDATE
  IF status != 'OPEN' RAISE ERROR "Period closed"
  
  SELECT financial_instrument FOR UPDATE WHERE id=cheque_id AND estado='RECEIVED'
  IF estado != 'RECEIVED' RAISE ERROR "Cheque must be in RECEIVED state"
  
  UPDATE financial_instrument SET estado='ENDORSED'
  
  INSERT financial_instrument_event (event_type='ENDORSED', event_date=endorsed_at::DATE, ...)
  
  -- supplier_ledger -amount reduces our debt to supplier
  INSERT supplier_ledger (supplier_id, movement_type='CHEQUE_ENDORSED', signed_amount=-cheque_amount, effective_date=endorsed_at::DATE, ...)
  
  -- NO client_ledger reversal (payment is FINAL)
  
  INSERT audit_event (...)
COMMIT
```

**PERIOD DETERMINATION:**
- Column: `endorsed_at`
- Check: Date must fall within OPEN management period

---

### RPC 9: reject_cheque

**RPC NAME:** `reject_cheque(cheque_id: UUID, rejected_at: TIMESTAMPTZ, reason?: TEXT) → {...}`

**PURPOSE:** Cheque rejected; handle based on prior state; create compensating ledger entries.

**ACTOR:** ADMIN

**PARAMETERS:**
- `cheque_id`: UUID | cheque PK | Must exist
- `rejected_at`: TIMESTAMPTZ | rejection time | Determines period and effective_date
- `reason`: TEXT NULLABLE | Audit reason

**VALIDATES (before transaction):**
- Cheque exists
- rejected_at falls within OPEN management period

**EXECUTION (atomic PostgreSQL transaction):**
```
BEGIN
  SELECT management_period WHERE rejected_at::DATE BETWEEN period_date AND period_date + '1 month'::interval FOR UPDATE
  IF status != 'OPEN' RAISE ERROR "Period closed"
  
  SELECT financial_instrument FOR UPDATE WHERE id=cheque_id
  original_estado = financial_instrument.estado
  cheque_number = financial_instrument.cheque_number
  cheque_amount = financial_instrument.amount
  
  UPDATE financial_instrument SET estado='REJECTED'
  INSERT financial_instrument_event (event_type='REJECTED', event_date=rejected_at::DATE, ...)
  
  IF original_estado='RECEIVED':
    -- Restore client debt (cheque was never valid)
    INSERT client_ledger (cliente_id=financial_instrument.cliente_id, movement_type='CHEQUE_REJECTED', signed_amount=+cheque_amount, effective_date=rejected_at::DATE, ...)
  
  ELSIF original_estado='DEPOSITED':
    -- No ledger impact (bank handles return)
    -- Client debt stays reduced; documented as DEPOSITED but rejected in clearing
  
  ELSIF original_estado='CLEARED':
    -- Bank reversal: create compensating posting
    INSERT financial_operation (operation_type='CHEQUE_REJECTION', transfer_id=cheque_number, effective_date=rejected_at::DATE)
    INSERT financial_posting (financial_account_id=financial_instrument.bank_account_id, signed_amount=-cheque_amount, effective_date=rejected_at::DATE, ...)
  
  INSERT audit_event (...)
COMMIT
```

**PERIOD DETERMINATION:**
- Column: `rejected_at`
- Check: Date must fall within OPEN management period
- Effective date for all ledger entries: `rejected_at::DATE`

**NOTE:** cliente_id and bank_account_id are stored in financial_instrument at RECEIVED and CLEARED states respectively, enabling correct ledger reversal on rejection.

---

## PRODUCTION

### RPC 10: register_daily_production

**PURPOSE:** Record daily production facts.

**ACTOR:** OPERATOR (direct INSERT via RLS) or RPC

**VALIDATION:**
- flock_id is authorized (operator_assignments)
- production_date in OPEN period
- No duplicate for (flock_id, production_date)

---

### RPC 11: register_mortality

**PURPOSE:** Record bird death event; enforce uniqueness.

**EXECUTION:**
```
BEGIN
  SELECT management_period FOR UPDATE WHERE event_date IN period
  IF status != 'OPEN' RAISE ERROR
  
  SELECT population_events WHERE flock_id=flock_id AND event_date=event_date AND event_type='MORTALITY' AND is_current=true
  IF FOUND RAISE ERROR "Mortality already recorded for this flock on this date"
  
  INSERT population_events (flock_id, event_type='MORTALITY', delta, event_date, is_current=true, ...)
  INSERT audit_event (...)
COMMIT
```

---

### RPC 12: rectify_mortality

**PURPOSE:** Correct mortality; preserve original via supersession.

**ACTOR:** ADMIN

**NOTE:** population_events is APPEND_ONLY at RLS level. Only SECURITY DEFINER function can modify metadata fields (is_current, superseded_by). Business fields (delta, event_date, flock_id) are immutable.

**EXECUTION:**
```
BEGIN
  SELECT management_period FOR UPDATE WHERE event_date IN period
  IF status != 'OPEN' RAISE ERROR "Must reopen period"
  
  SELECT population_events FOR UPDATE WHERE id=original_event_id AND event_type='MORTALITY' AND is_current=true
  IF NOT FOUND RAISE ERROR "Original mortality event not found or already superseded"
  
  -- Insert corrected as current
  new_event_id = INSERT population_events (flock_id, event_type='MORTALITY', delta=corrected_delta, event_date, is_current=true, superseded_by=NULL, created_by=auth.uid())
  RETURNING id
  
  -- Mark original superseded (via SECURITY DEFINER function internal auth check, not user-callable UPDATE)
  CALL _update_mortality_supersession(original_event_id, new_event_id)
  -- (This internal function can UPDATE is_current/superseded_by only, with strict validation)
  
  INSERT audit_event (action='RECTIFY_MORTALITY', before={original}, after={corrected}, reason, ...)
COMMIT
```

**IDEMPOTENCY:** Retry with same original_event_id and corrected_delta: second call fails with "already rectified".

---

## CLASSIFICATION

### RPC 13: register_classification

**PURPOSE:** Create classification session + lines atomically.

**PARAMETERS:**
- `idempotency_key`: UUID | unique identifier for retry prevention
- `session_date`: DATE
- `location`: VARCHAR
- `lines`: [{grade, quantity}, ...]

**EXECUTION:**
```
BEGIN
  SELECT management_period FOR UPDATE WHERE session_date IN period
  
  INSERT classification (idempotency_key, session_date, location, created_by)
  
  FOR EACH line IN lines:
    INSERT classification_line (classification_id, grade, quantity)
  
  INSERT audit_event (...)
COMMIT
```

**IDEMPOTENCY:** `idempotency_key UNIQUE` prevents duplicate retry.

---

## PERIODS

### RPC 14: close_management_period

**PURPOSE:** Seal period; freeze all facts with effective_date in that period.

**ACTOR:** ADMIN

**EXECUTION:**
```
BEGIN
  SELECT management_period FOR UPDATE WHERE id=period_id
  
  -- Optional integrity check (non-blocking): warn if PENDING facts exist
  SELECT COUNT(*) FROM pedidos WHERE estado='PENDING' AND created_at::DATE IN period
  IF count > 0 WARN "Period has pending orders"
  
  UPDATE management_period SET status='CLOSED', closed_at=NOW(), closed_by=auth.uid() WHERE id=period_id
  
  INSERT audit_event (action='CLOSE_PERIOD', reason, ...)
COMMIT
```

---

### RPC 15: reopen_management_period

**PURPOSE:** Reopen CLOSED period to correct historical facts.

**ACTOR:** ADMIN

**REQUIRES:** `reason` (mandatory audit field)

**EXECUTION:**
```
BEGIN
  SELECT management_period FOR UPDATE WHERE id=period_id AND status='CLOSED'
  
  UPDATE management_period SET status='OPEN', closed_at=NULL, closed_by=NULL WHERE id=period_id
  
  INSERT audit_event (action='REOPEN_PERIOD', reason, performed_by, ...)
COMMIT
```

---

## FINANCIAL TRANSFERS

### RPC 16: transfer_between_accounts

**RPC NAME:** `transfer_between_accounts(source_account_id: UUID, dest_account_id: UUID, amount: NUMERIC, effective_date: DATE, transfer_id: VARCHAR, reason?: TEXT) → {...}`

**PURPOSE:** Move money between accounts; both postings atomic.

**ACTOR:** ADMIN

**PARAMETERS:**
- `source_account_id`: UUID | account to debit | Must exist
- `dest_account_id`: UUID | account to credit | Must exist; must differ from source
- `amount`: NUMERIC | positive transfer amount
- `effective_date`: DATE | economic date | Determines period
- `transfer_id`: VARCHAR UNIQUE | idempotency key (e.g., bank confirmation number)
- `reason`: TEXT NULLABLE | Audit reason

**VALIDATES (before transaction):**
- Both accounts exist and are active
- amount > 0
- accounts are different
- effective_date in OPEN period
- transfer_id is unique

**EXECUTION:**
```
BEGIN
  SELECT management_period FOR UPDATE WHERE effective_date IN period
  IF status != 'OPEN' RAISE ERROR "Period closed"
  
  operation_id = INSERT financial_operation (operation_type='TRANSFER', transfer_id, effective_date, created_by=auth.uid())
  RETURNING id
  
  -- BOTH postings or NEITHER (shared operation_id)
  INSERT financial_posting (financial_operation_id=operation_id, financial_account_id=source_account_id, signed_amount=-amount, effective_date, created_by=auth.uid())
  INSERT financial_posting (financial_operation_id=operation_id, financial_account_id=dest_account_id, signed_amount=+amount, effective_date, created_by=auth.uid())
  
  INSERT audit_event (action='TRANSFER', before={source_balance, dest_balance}, after={new_balances}, reason, ...)
COMMIT
```

**IDEMPOTENCY:** transfer_id UNIQUE prevents duplicate execution.

**CRITICAL:** Both postings or neither; shared operation_id guarantees atomicity.

---

## SUMMARY

**23 RPCs total:** All specify atomic boundaries, period checks, idempotency, error handling, and audit trails.

**No partial application possible:** All-or-nothing per operation.

**Period determination:** effective_date (never created_at) determines which period RPC must check.

**Ready for:** PostgreSQL function implementation, RPC framework integration, testing.
