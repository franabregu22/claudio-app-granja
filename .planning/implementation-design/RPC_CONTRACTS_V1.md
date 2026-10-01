# RPC CONTRACTS V1

**STATUS:** **FROZEN** — Fase 9 (Implementation Design) closed 2026-09-24. Implementation-ready transactional contracts.  
**AMENDMENTS:** ADR-001 (`.planning/adr/ADR-001_ISSUED_INSTRUMENT_CANCELLATION.md`, ACCEPTED 2026-09-25) — issued-instrument cancellation: RPC 42 `cancel_supplier_instrument`, `financial_instrument.cancelled_date`, `chk_instrument_cancelled_coherent`. Amended passages are marked **[ADR-001]**. Nothing else changed.  
**AMENDMENTS:** ADR-002 (`.planning/adr/ADR-002_PURCHASE_RECTIFICATION_VERSION_KEY.md`, ACCEPTED 2026-09-25) — bounded rectified-purchase version key (`'RECTIFY:' || <predecessor purchase id> || ':v' || version`) and the reserved `RECTIFY:` idempotency-key prefix. Amended passages are marked **[ADR-002]**. Nothing else changed.  
**AMENDMENTS:** ADR-007 (`.planning/adr/ADR-007_FLOCK_LIFECYCLE.md`, ACCEPTED 2026-09-29) — V1 flock lifecycle: RPC 44 `register_flock`, RPC 45 `close_flock` (ADMIN, SECURITY DEFINER; the SECURITY DEFINER set 60 → 62) and invariant 29 (no dated flock activity after `flocks.exit_date`, enforced in RPCs 18–22, 29 and 45). No schema change. Amended sections are marked **[ADR-007]**.  
**AMENDMENTS:** ADR-008 (`.planning/adr/ADR-008_PURCHASE_ATTACHMENT_STORAGE.md`, ACCEPTED 2026-09-30) — RPC 13 `register_purchase`: the attachment objects live in the private Storage bucket `purchase-attachments` and are uploaded by the caller before the call (removed by the caller if the call fails). The RPC itself is unchanged. Amended passage is marked **[ADR-008]**.  
**AMENDMENTS:** ADR-009 (`.planning/adr/ADR-009_FERIA_ADMIN_ONLY_V1.md`, ACCEPTED 2026-09-30) — Feria is ADMIN-only in V1: RPC 31 `register_session_movement` gets the ADMIN guard (migration 0059); OPERATOR has no Feria capability. Amended passages are marked **[ADR-009]**.  
**AMENDMENTS:** ADR-010 (`.planning/adr/ADR-010_OPTIONAL_PURCHASE_ATTACHMENTS.md`, ACCEPTED 2026-09-30) — purchase attachments are optional: RPC 13 accepts NULL / `[]` (INVALID_ATTACHMENTS for a non-array), RPC 14 no longer requires an attachment to carry forward (migration 0061). Amended passages are marked **[ADR-010]**.  
**AMENDMENTS:** ADR-011 (`.planning/adr/ADR-011_BANK_TAX.md`, ACCEPTED 2026-09-30) — RPC 46 `register_bank_tax` (migration 0062); the inventory grows 45 → 46. Amended passages are marked **[ADR-011]**.
**AMENDMENTS:** ADR-012 (`.planning/adr/ADR-012_CLASSIFICATION_UNITS_RECTIFICATION.md`, ACCEPTED 2026-10-01) — RPC 25 line format `{classification_grade_id, quantity, unit}` with backend MAPLE conversion; RPC 47 `rectify_classification` (migration 0063). ADR-013 (`.planning/adr/ADR-013_FEED_FORMULA_PUBLICATION.md`, ACCEPTED 2026-10-01) — RPC 48 `publish_feed_formula_version`; RPC 26 refuses an empty version (migration 0064). The inventory grows 46 → 48. Amended passages are marked **[ADR-012]** / **[ADR-013]**.
**AMENDMENTS:** ADR-014 (`.planning/adr/ADR-014_FEED_MANUFACTURING_RECTIFICATION.md`, ACCEPTED 2026-10-01) — RPC 49 `rectify_feed_manufacturing` (migration 0065); classification grade Rotos inactive for new entries (RPCs 25 / 47 refuse it as any inactive grade). The inventory grows 48 → 49. Amended passages are marked **[ADR-014]**.
**AMENDMENTS:** ADR-015 (`.planning/adr/ADR-015_FISCAL_POSITION_AND_PURCHASE_FISCAL.md`, ACCEPTED 2026-10-01) — RPC 50 `register_purchase_with_fiscal_document` (migration 0068): RPC 34 + RPC 13 in one transaction; RPCs 13 / 34 unchanged. The inventory grows 49 → 50. Amended passages are marked **[ADR-015]**.  
Changes from here require an explicit ADR, as with the target architecture.  
**DATE:** 2026-09-24  
**AUTHORITY:** TARGET_ARCHITECTURE_V2_FROZEN.md (frozen)  
**SCHEMA:** every table/column referenced here is defined in `POSTGRES_SCHEMA_SPEC_V1.md`

**RPC COUNT: 45** (exact inventory at the end of this document) **[ADR-001]**: RPC 42 appended; 1–41 unchanged and not renumbered. **[ADR-007]**: RPCs 44 / 45 appended; 1–43 unchanged and not renumbered (RPC 43 is `register_management_event`, specified by ADR-004 D9)

---

## PSEUDOCODE STANDARD (READ FIRST)

The `EXECUTION` blocks below are **specification pseudocode, not executable SQL**.

1. Pseudocode maps 1:1 onto PL/pgSQL; it is not copy-paste SQL.
2. Every variable is declared conceptually (`x = <expression>`) before use. No undeclared identifier appears.
3. Table and column names are the exact identifiers from `POSTGRES_SCHEMA_SPEC_V1.md`.
4. `BEGIN … END` delimits a **logical block only**. There is **no `COMMIT` and no `BEGIN TRANSACTION` inside any RPC**. A Supabase RPC call already runs inside one PostgreSQL transaction.
5. Any raised exception rolls the whole call back. There is no partial application.
6. `SELECT … FOR UPDATE` marks the rows that must be locked to serialise concurrent callers.
7. `auth.uid()` is the caller. No RPC accepts a caller-supplied actor or role.

### Canonical period guard

Every period-sensitive RPC begins with this guard. `business_date` is always an explicit `DATE`.

```
ASSERT_PERIOD_OPEN(business_date):
  period = SELECT * FROM management_period
           WHERE periodo_fecha = date_trunc('month', business_date)::DATE
           FOR UPDATE
  IF period NOT FOUND
    RAISE 'PERIOD_NOT_FOUND: no management_period for %', business_date
  IF period.status <> 'OPEN'
    RAISE 'PERIOD_CLOSED: period % is CLOSED; reopen it first', period.periodo_fecha
```

Locking the period row `FOR UPDATE` also serialises against `close_management_period`, so a fact can never slip in while a period is being closed.

### Converting an instant to a business date

When a caller supplies a `TIMESTAMPTZ` and the business date must be derived:

```
business_date = (instant AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
```

The zone is fixed and explicit. Session timezone is never used. Bare `timestamptz::DATE` never appears.

### SECURITY DEFINER hardening (applies to every RPC below)

```sql
CREATE OR REPLACE FUNCTION <rpc_name>(…)
RETURNS <type>
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public          -- fixed, safe search_path
AS $$ … $$;

REVOKE ALL ON FUNCTION <rpc_name>(…) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION <rpc_name>(…) TO authenticated;
```

Every RPC: derives the actor internally from `auth.uid()`; resolves the business role internally via `current_app_role()`; revokes PUBLIC execute; grants execute only to `authenticated` (or `service_role` where marked); never trusts a caller-provided user id or role. `SECURITY DEFINER` is required because period-sensitive tables grant no direct write privilege to any application role — the function owner is the sole writer.

---

## COMMERCIAL

### 1. deliver_order

**Signature:** `deliver_order(p_order_id UUID, p_delivered_at TIMESTAMPTZ, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **Authorization:** `current_app_role() = 'ADMIN'` · **SECURITY DEFINER:** yes  
**Period determinant:** `pedidos.delivered_date`

**Validation:** order exists; `estado='PENDING'`; at least one current line; client `activo=true`.  
**Locks:** `pedidos` row, then period row.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'

  order = SELECT * FROM pedidos WHERE id = p_order_id FOR UPDATE
  IF order NOT FOUND            RAISE 'ORDER_NOT_FOUND'
  IF order.estado <> 'PENDING'  RAISE 'ORDER_NOT_PENDING: current state is %', order.estado

  delivered_date = (p_delivered_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
  ASSERT_PERIOD_OPEN(delivered_date)

  order_total = SELECT COALESCE(SUM(subtotal),0) FROM pedido_lineas
                WHERE pedido_id = p_order_id AND is_current = true
  IF order_total <= 0 RAISE 'ORDER_HAS_NO_LINES'

  client_name = SELECT nombre FROM clients WHERE id = order.cliente_id

  UPDATE pedidos SET estado='DELIVERED', delivered_at=p_delivered_at,
         delivered_date=delivered_date, updated_at=NOW(), updated_by=auth.uid()
   WHERE id = p_order_id

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (order.cliente_id, 'SALE_DELIVERY', order_total, delivered_date,
          client_name, 'pedido', p_order_id::TEXT, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('pedido', p_order_id::TEXT, 'DELIVER',
          jsonb_build_object('estado','PENDING'),
          jsonb_build_object('estado','DELIVERED','delivered_date',delivered_date,'total',order_total),
          p_reason, auth.uid())
END
```

**client_ledger:** `+order_total` SALE_DELIVERY. **financial:** none — a credit sale moves no cash.  
**supplier_ledger / instrument:** none. **audit:** DELIVER.  
**Idempotency:** state guard — a second call fails `ORDER_NOT_PENDING`.  
**Errors:** `FORBIDDEN`, `ORDER_NOT_FOUND`, `ORDER_NOT_PENDING`, `ORDER_HAS_NO_LINES`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`.  
**Returns:** `{id, estado, delivered_at, delivered_date, order_total}`.

---

### 2. rectify_delivered_order

**Signature:** `rectify_delivered_order(p_order_id UUID, p_new_lines JSONB, p_reason TEXT) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes (sole authorised writer of `pedido_lineas.is_current`)  
**Period determinant:** `pedidos.delivered_date` (the ORIGINAL delivery date — a rectification never re-dates the sale)

`p_new_lines` is a JSONB array of `{producto_id, cantidad, precio_unitario}`. `p_reason` is mandatory.

**Correct for N rectifications:** the reversal always cancels the **current** version's total, never the first historical version. After the Nth rectification the ledger nets to the Nth total.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 RAISE 'REASON_REQUIRED'
  IF jsonb_array_length(p_new_lines) = 0 RAISE 'EMPTY_LINE_SET'

  order = SELECT * FROM pedidos WHERE id = p_order_id FOR UPDATE
  IF order NOT FOUND             RAISE 'ORDER_NOT_FOUND'
  IF order.estado <> 'DELIVERED' RAISE 'ORDER_NOT_DELIVERED: current state is %', order.estado

  delivered_date = order.delivered_date          -- period follows the original economic date
  ASSERT_PERIOD_OPEN(delivered_date)

  -- 1. current version (the one being replaced)
  current_version = order.rectification_seq
  current_total   = SELECT COALESCE(SUM(subtotal),0) FROM pedido_lineas
                    WHERE pedido_id = p_order_id AND is_current = true
  current_count   = SELECT COUNT(*) FROM pedido_lineas
                    WHERE pedido_id = p_order_id AND is_current = true
  IF current_count = 0 RAISE 'NO_CURRENT_LINES'

  -- 2. validate the replacement set COMPLETELY before mutating anything
  FOR EACH line IN p_new_lines:
    IF line.cantidad <= 0        RAISE 'INVALID_QUANTITY'
    IF line.precio_unitario < 0  RAISE 'INVALID_PRICE'
    IF NOT EXISTS (SELECT 1 FROM products WHERE id = line.producto_id)
      RAISE 'PRODUCT_NOT_FOUND: %', line.producto_id

  -- 3. compute the new version number
  new_version = current_version + 1

  -- 4. RETIRE the previous version FIRST. Technical metadata only: is_current flips.
  --    Business snapshot fields are never touched — prior rows keep
  --    cantidad / precio_unitario / producto_nombre forever.
  --    After this statement the order transiently has ZERO current lines, which is a legal
  --    state for excl_pedido_lineas_single_current_version.
  UPDATE pedido_lineas SET is_current = false
   WHERE pedido_id = p_order_id AND is_current = true AND version_seq = current_version

  -- 5. THEN insert the new current version. All inserted rows share version_seq = new_version,
  --    so the exclusion constraint is satisfied at every point.
  FOR EACH line IN p_new_lines:
    INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario,
           producto_nombre, version_seq, is_current, created_by)
    VALUES (p_order_id, line.producto_id, line.cantidad, line.precio_unitario,
            (SELECT nombre FROM products WHERE id = line.producto_id),
            new_version, true, auth.uid())

  -- 6. compute the new total from the version just written
  new_total = SELECT COALESCE(SUM(subtotal),0) FROM pedido_lineas
              WHERE pedido_id = p_order_id AND is_current = true AND version_seq = new_version

  -- 7. advance the order's version pointer
  UPDATE pedidos SET rectification_seq = new_version, updated_at = NOW(), updated_by = auth.uid()
   WHERE id = p_order_id

  -- 8. compensating entries, both dated at the original delivered_date
  client_name = SELECT nombre FROM clients WHERE id = order.cliente_id

  reversal_id = INSERT INTO client_ledger (cliente_id, movement_type, signed_amount,
                effective_date, ledger_client_name, source_entity_type, source_entity_id,
                reason, created_by)
                VALUES (order.cliente_id, 'REVERSAL', -current_total, delivered_date,
                        client_name, 'pedido', p_order_id::TEXT, p_reason, auth.uid())
                RETURNING id

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reversal_of_id,
         reason, created_by)
  VALUES (order.cliente_id, 'SALE_DELIVERY', new_total, delivered_date,
          client_name, 'pedido', p_order_id::TEXT, reversal_id, p_reason, auth.uid())

  -- 9. audit
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('pedido', p_order_id::TEXT, 'RECTIFY_DELIVERED_ORDER',
          jsonb_build_object('version',current_version,'total',current_total,'line_count',current_count),
          jsonb_build_object('version',new_version,'total',new_total,
                             'line_count',jsonb_array_length(p_new_lines)),
          p_reason, auth.uid())
END
```

**Mutation order is mandatory, not stylistic.** Steps 4 and 5 must run in that order — retire the old
version, then insert the new one. The reverse order makes two `version_seq` values current at the same
time, and `excl_pedido_lineas_single_current_version` rejects exactly that, so a wrong-order
implementation fails immediately rather than persisting an ambiguous order. Retiring first passes
through a transient zero-current-rows state, which the constraint permits.

Steps 1–3 read and validate everything *before* the first mutation, so an invalid `p_new_lines`
payload aborts the call while the order is still intact.

**Atomicity closes the transient window.** The whole RPC is one PostgreSQL transaction. The
zero-current-rows state between steps 4 and 5 is never visible to any other session, and if any later
step fails — the insert, the total, the ledger entries, the audit row — the entire call rolls back and
the previous version stays current. No order is ever persisted without a current version.

**Why no per-line `superseded_by`:** replacement is set-to-set (3 lines may become 2, or 1 may become 5). A per-line pointer cannot express N:M, so supersession is carried by `version_seq` + `is_current` at the set level. Old rows are never duplicated to mark them obsolete; only the flag changes.

**client_ledger:** `-current_total` REVERSAL then `+new_total` SALE_DELIVERY, both at `delivered_date`.  
**financial / supplier_ledger / instrument:** none. **audit:** before/after totals, versions, reason, actor, time.  
**Idempotency:** not idempotent by design — each call is a distinct economic correction and increments `rectification_seq`. Replay protection is the caller's responsibility.  
**Errors:** `FORBIDDEN`, `REASON_REQUIRED`, `EMPTY_LINE_SET`, `ORDER_NOT_FOUND`, `ORDER_NOT_DELIVERED`, `NO_CURRENT_LINES`, `INVALID_QUANTITY`, `INVALID_PRICE`, `PRODUCT_NOT_FOUND`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`.  
**Returns:** `{id, version_seq, previous_total, new_total, adjustment}`.

---

### 3. cancel_order

**Signature:** `cancel_order(p_order_id UUID, p_cancelled_at TIMESTAMPTZ, p_reason TEXT) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** none — a PENDING order is not an economic fact and touches no ledger.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'

  order = SELECT * FROM pedidos WHERE id = p_order_id FOR UPDATE
  IF order NOT FOUND           RAISE 'ORDER_NOT_FOUND'
  IF order.estado <> 'PENDING' RAISE 'ONLY_PENDING_CAN_CANCEL: current state is %', order.estado

  cancelled_date = (p_cancelled_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE

  UPDATE pedidos SET estado='CANCELLED', cancelled_at=p_cancelled_at,
         cancelled_date=cancelled_date, updated_at=NOW(), updated_by=auth.uid()
   WHERE id = p_order_id

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('pedido', p_order_id::TEXT, 'CANCEL', jsonb_build_object('estado','PENDING'),
          jsonb_build_object('estado','CANCELLED'), p_reason, auth.uid())
END
```

A DELIVERED order is never cancelled — use `rectify_delivered_order`. No ledger consequence.  
**Idempotency:** state guard. **Returns:** `{id, estado, cancelled_date}`.

---

## COLLECTIONS

### 4. register_collection

**Signature:** `register_collection(p_cliente_id UUID, p_amount NUMERIC, p_payment_method payment_method, p_receipt_id VARCHAR, p_effective_date DATE, p_financial_account_id UUID, p_sales_session_id UUID DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `collections.effective_date`

**CHEQUE is rejected here.** Cheque reception is owned solely by `receive_cheque` (5). The schema also blocks it via `chk_collections_no_cheque`.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_payment_method = 'CHEQUE'
    RAISE 'USE_RECEIVE_CHEQUE: cheque reception is handled by receive_cheque, not register_collection'
  IF p_amount <= 0 RAISE 'INVALID_AMOUNT'
  IF p_financial_account_id IS NULL RAISE 'ACCOUNT_REQUIRED'

  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = p_cliente_id AND activo = true)
    RAISE 'CLIENT_NOT_FOUND_OR_INACTIVE'
  IF EXISTS (SELECT 1 FROM collections WHERE receipt_id = p_receipt_id)
    RAISE 'DUPLICATE_RECEIPT: collection with receipt_id % already exists', p_receipt_id

  ASSERT_PERIOD_OPEN(p_effective_date)

  client_name = SELECT nombre FROM clients WHERE id = p_cliente_id

  collection_id = INSERT INTO collections (cliente_id, amount, payment_method, receipt_id,
                  effective_date, financial_account_id, sales_session_id, created_by)
                  VALUES (p_cliente_id, p_amount, p_payment_method, p_receipt_id,
                          p_effective_date, p_financial_account_id, p_sales_session_id, auth.uid())
                  RETURNING id

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_cliente_id, 'COLLECTION', -p_amount, p_effective_date, client_name,
          'collections', collection_id::TEXT, p_reason, auth.uid())

  operation_id = INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                 source_entity_type, source_entity_id, reason, created_by)
                 VALUES ('COLLECTION', p_effective_date, p_receipt_id,
                         'collections', collection_id::TEXT, p_reason, auth.uid())
                 RETURNING id

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (operation_id, p_financial_account_id, p_amount, p_effective_date, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('collections', collection_id::TEXT, 'CREATE',
          jsonb_build_object('amount',p_amount,'method',p_payment_method,
                             'effective_date',p_effective_date), p_reason, auth.uid())
END
```

**client_ledger:** `-amount` COLLECTION. **financial:** COLLECTION operation + `+amount` posting on the receiving account. **audit:** CREATE.  
**Idempotency:** `collections.receipt_id` UNIQUE and reused as `financial_operation.external_ref`.  
**Errors:** `FORBIDDEN`, `USE_RECEIVE_CHEQUE`, `INVALID_AMOUNT`, `ACCOUNT_REQUIRED`, `CLIENT_NOT_FOUND_OR_INACTIVE`, `DUPLICATE_RECEIPT`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`.  
**Returns:** `{collection_id, financial_operation_id, client_ledger_id}`.

---

## RECEIVED INSTRUMENTS (CHEQUE / eCHEQ FROM CLIENTS)

Frozen economics: reception reduces client debt and does **not** touch the bank; deposit is a state change only; clearing credits the bank; endorsement reduces supplier debt and leaves the client paid; rejection compensates according to the stage reached.

### 5. receive_cheque

**Signature:** `receive_cheque(p_cliente_id UUID, p_instrument_type financial_instrument_type, p_cheque_number VARCHAR, p_amount NUMERIC, p_maturity_date DATE, p_received_at TIMESTAMPTZ, p_receipt_id VARCHAR, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_instrument.received_date`  
**Sole owner of instrument creation in the RECEIVED direction.**

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_amount <= 0 RAISE 'INVALID_AMOUNT'
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = p_cliente_id AND activo = true)
    RAISE 'CLIENT_NOT_FOUND_OR_INACTIVE'
  IF EXISTS (SELECT 1 FROM financial_instrument WHERE receipt_id = p_receipt_id)
    RAISE 'DUPLICATE_RECEIPT: instrument with receipt_id % already exists', p_receipt_id

  received_date = (p_received_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
  ASSERT_PERIOD_OPEN(received_date)

  client_name = SELECT nombre FROM clients WHERE id = p_cliente_id

  instrument_id = INSERT INTO financial_instrument (instrument_type, direction, estado,
                  cheque_number, amount, maturity_date, cliente_id, receipt_id,
                  received_date, created_by)
                  VALUES (p_instrument_type, 'RECEIVED', 'RECEIVED', p_cheque_number,
                          p_amount, p_maturity_date, p_cliente_id, p_receipt_id,
                          received_date, auth.uid())
                  RETURNING id

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         reason, created_by)
  VALUES (instrument_id, 'RECEIVED', received_date, p_reason, auth.uid())

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_cliente_id, 'CHEQUE_RECEIVED', -p_amount, received_date, client_name,
          'financial_instrument', instrument_id::TEXT, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('financial_instrument', instrument_id::TEXT, 'RECEIVE',
          jsonb_build_object('amount',p_amount,'cheque_number',p_cheque_number,
                             'received_date',received_date), p_reason, auth.uid())
END
```

**client_ledger:** `-amount` CHEQUE_RECEIVED. **financial:** none — the bank is untouched at reception.  
**Note:** `cheque_number` is business data and is deliberately NOT unique. Identity is `id`; idempotency is `receipt_id`.  
**Errors:** `FORBIDDEN`, `INVALID_AMOUNT`, `CLIENT_NOT_FOUND_OR_INACTIVE`, `DUPLICATE_RECEIPT`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`.  
**Returns:** `{instrument_id, estado, received_date}`.

---

### 6. deposit_cheque

**Signature:** `deposit_cheque(p_instrument_id UUID, p_deposited_date DATE, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_instrument.deposited_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'

  inst = SELECT * FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE
  IF inst NOT FOUND                RAISE 'INSTRUMENT_NOT_FOUND'
  IF inst.direction <> 'RECEIVED'  RAISE 'WRONG_DIRECTION: deposit applies to received instruments'
  IF inst.estado <> 'RECEIVED'     RAISE 'INVALID_STATE: expected RECEIVED, found %', inst.estado

  ASSERT_PERIOD_OPEN(p_deposited_date)

  UPDATE financial_instrument SET estado='DEPOSITED', deposited_date=p_deposited_date
   WHERE id = p_instrument_id

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         reason, created_by)
  VALUES (p_instrument_id, 'DEPOSITED', p_deposited_date, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'DEPOSIT',
          jsonb_build_object('estado','RECEIVED'),
          jsonb_build_object('estado','DEPOSITED','deposited_date',p_deposited_date),
          p_reason, auth.uid())
END
```

**No ledger and no posting.** Deposit is a custody state change; the bank is credited only at clearing.  
**Idempotency:** state guard + `idx_instrument_event_unique` blocks a duplicate DEPOSITED event.  
**Returns:** `{instrument_id, estado, deposited_date}`.

---

### 7. clear_cheque

**Signature:** `clear_cheque(p_instrument_id UUID, p_cleared_date DATE, p_bank_account_id UUID, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_instrument.cleared_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'

  inst = SELECT * FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE
  IF inst NOT FOUND                RAISE 'INSTRUMENT_NOT_FOUND'
  IF inst.direction <> 'RECEIVED'  RAISE 'WRONG_DIRECTION'
  IF inst.estado <> 'DEPOSITED'    RAISE 'INVALID_STATE: expected DEPOSITED, found %', inst.estado
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_bank_account_id AND activo = true)
    RAISE 'ACCOUNT_NOT_FOUND_OR_INACTIVE'

  ASSERT_PERIOD_OPEN(p_cleared_date)

  -- bank_account_id is persisted so a later rejection reverses the correct account
  UPDATE financial_instrument SET estado='CLEARED', cleared_date=p_cleared_date,
         bank_account_id=p_bank_account_id
   WHERE id = p_instrument_id

  operation_id = INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                 source_entity_type, source_entity_id, reason, created_by)
                 VALUES ('CHEQUE_CLEAR', p_cleared_date,
                         'CLEAR:' || p_instrument_id::TEXT,
                         'financial_instrument', p_instrument_id::TEXT, p_reason, auth.uid())
                 RETURNING id

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (operation_id, p_bank_account_id, inst.amount, p_cleared_date, auth.uid())

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'CLEARED', p_cleared_date, operation_id, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'CLEAR',
          jsonb_build_object('estado','DEPOSITED'),
          jsonb_build_object('estado','CLEARED','cleared_date',p_cleared_date,
                             'bank_account_id',p_bank_account_id), p_reason, auth.uid())
END
```

**financial:** CHEQUE_CLEAR operation + `+amount` posting. **client_ledger:** none — the client was already credited at reception. **Only clearing moves the bank.**  
**Idempotency:** state guard + unique CLEARED event + unique `external_ref`.  
**Returns:** `{instrument_id, estado, cleared_date, financial_operation_id}`.

---

### 8. endorse_cheque

**Signature:** `endorse_cheque(p_instrument_id UUID, p_supplier_id UUID, p_endorsed_date DATE, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_instrument.endorsed_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'

  inst = SELECT * FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE
  IF inst NOT FOUND                RAISE 'INSTRUMENT_NOT_FOUND'
  IF inst.direction <> 'RECEIVED'  RAISE 'WRONG_DIRECTION'
  IF inst.estado <> 'RECEIVED'     RAISE 'INVALID_STATE: only an in-portfolio instrument can be endorsed, found %', inst.estado
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo = true)
    RAISE 'SUPPLIER_NOT_FOUND_OR_INACTIVE'

  ASSERT_PERIOD_OPEN(p_endorsed_date)

  UPDATE financial_instrument SET estado='ENDORSED', endorsed_date=p_endorsed_date,
         endorsed_to_supplier_id=p_supplier_id
   WHERE id = p_instrument_id

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         reason, created_by)
  VALUES (p_instrument_id, 'ENDORSED', p_endorsed_date, p_reason, auth.uid())

  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_supplier_id, 'CHEQUE_ENDORSED', -inst.amount, p_endorsed_date,
          'financial_instrument', p_instrument_id::TEXT, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'ENDORSE',
          jsonb_build_object('estado','RECEIVED'),
          jsonb_build_object('estado','ENDORSED','supplier_id',p_supplier_id,
                             'endorsed_date',p_endorsed_date), p_reason, auth.uid())
END
```

**supplier_ledger:** `-amount` CHEQUE_ENDORSED. **client_ledger:** untouched — the client's payment is final. **financial:** none — no bank movement; the instrument simply leaves the portfolio. ENDORSED is terminal except for rejection.  
**Returns:** `{instrument_id, estado, endorsed_date, supplier_id}`.

---

### 9. reject_cheque

**Signature:** `reject_cheque(p_instrument_id UUID, p_rejected_date DATE, p_reason TEXT) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_instrument.rejected_date`

Consequences depend deterministically on the stage reached, which is why provenance is persisted.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 RAISE 'REASON_REQUIRED'

  inst = SELECT * FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE
  IF inst NOT FOUND               RAISE 'INSTRUMENT_NOT_FOUND'
  IF inst.direction <> 'RECEIVED' RAISE 'WRONG_DIRECTION: use reject_supplier_instrument'
  IF inst.estado = 'REJECTED'     RAISE 'ALREADY_REJECTED'

  prior_estado = inst.estado
  ASSERT_PERIOD_OPEN(p_rejected_date)

  UPDATE financial_instrument SET estado='REJECTED', rejected_date=p_rejected_date
   WHERE id = p_instrument_id

  operation_id = NULL

  IF prior_estado IN ('RECEIVED','DEPOSITED'):
    -- client debt reopens; no bank movement ever occurred
    client_name = SELECT nombre FROM clients WHERE id = inst.cliente_id
    INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
           ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
    VALUES (inst.cliente_id, 'CHEQUE_REJECTED', inst.amount, p_rejected_date, client_name,
            'financial_instrument', p_instrument_id::TEXT, p_reason, auth.uid())

  ELSIF prior_estado = 'CLEARED':
    -- client debt reopens AND the bank credit is reversed on the same account
    client_name = SELECT nombre FROM clients WHERE id = inst.cliente_id
    INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
           ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
    VALUES (inst.cliente_id, 'CHEQUE_REJECTED', inst.amount, p_rejected_date, client_name,
            'financial_instrument', p_instrument_id::TEXT, p_reason, auth.uid())

    operation_id = INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                   source_entity_type, source_entity_id, reason, created_by)
                   VALUES ('CHEQUE_REJECTION', p_rejected_date,
                           'REJECT:' || p_instrument_id::TEXT,
                           'financial_instrument', p_instrument_id::TEXT, p_reason, auth.uid())
                   RETURNING id
    INSERT INTO financial_posting (financial_operation_id, financial_account_id,
           signed_amount, effective_date, created_by)
    VALUES (operation_id, inst.bank_account_id, -inst.amount, p_rejected_date, auth.uid())

  ELSIF prior_estado = 'ENDORSED':
    -- the endorsed instrument bounced: supplier debt reopens. The client stays paid,
    -- because the endorsement settled that obligation independently.
    INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
           source_entity_type, source_entity_id, reason, created_by)
    VALUES (inst.endorsed_to_supplier_id, 'INSTRUMENT_REJECTED', inst.amount, p_rejected_date,
            'financial_instrument', p_instrument_id::TEXT, p_reason, auth.uid())

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'REJECTED', p_rejected_date, operation_id, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'REJECT',
          jsonb_build_object('estado',prior_estado),
          jsonb_build_object('estado','REJECTED','rejected_date',p_rejected_date),
          p_reason, auth.uid())
END
```

**Errors:** `FORBIDDEN`, `REASON_REQUIRED`, `INSTRUMENT_NOT_FOUND`, `WRONG_DIRECTION`, `ALREADY_REJECTED`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`.  
**Returns:** `{instrument_id, prior_estado, estado, rejected_date, financial_operation_id}`.

---

## ISSUED INSTRUMENTS (CHEQUE / eCHEQ TO SUPPLIERS)

Frozen economics: issuing reduces supplier debt immediately and does not touch the bank; debit moves the bank; rejection reopens supplier debt and reverses whatever actually happened. **[ADR-001]** Cancellation before any debit (RPC 42) reopens supplier debt and moves no money.

### 10. issue_supplier_instrument

**Signature:** `issue_supplier_instrument(p_supplier_id UUID, p_instrument_type financial_instrument_type, p_cheque_number VARCHAR, p_amount NUMERIC, p_maturity_date DATE, p_issued_date DATE, p_bank_account_id UUID, p_external_ref VARCHAR, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_instrument.issued_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_amount <= 0 RAISE 'INVALID_AMOUNT'
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo = true)
    RAISE 'SUPPLIER_NOT_FOUND_OR_INACTIVE'
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_bank_account_id AND activo = true)
    RAISE 'ACCOUNT_NOT_FOUND_OR_INACTIVE'
  IF EXISTS (SELECT 1 FROM financial_instrument WHERE external_ref = p_external_ref)
    RAISE 'DUPLICATE_EXTERNAL_REF'

  ASSERT_PERIOD_OPEN(p_issued_date)

  instrument_id = INSERT INTO financial_instrument (instrument_type, direction, estado,
                  cheque_number, amount, maturity_date, supplier_id, bank_account_id,
                  external_ref, issued_date, created_by)
                  VALUES (p_instrument_type, 'ISSUED', 'ISSUED', p_cheque_number, p_amount,
                          p_maturity_date, p_supplier_id, p_bank_account_id,
                          p_external_ref, p_issued_date, auth.uid())
                  RETURNING id

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         reason, created_by)
  VALUES (instrument_id, 'ISSUED', p_issued_date, p_reason, auth.uid())

  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_supplier_id, 'INSTRUMENT_ISSUED', -p_amount, p_issued_date,
          'financial_instrument', instrument_id::TEXT, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('financial_instrument', instrument_id::TEXT, 'ISSUE',
          jsonb_build_object('amount',p_amount,'supplier_id',p_supplier_id,
                             'issued_date',p_issued_date), p_reason, auth.uid())
END
```

**supplier_ledger:** `-amount` INSTRUMENT_ISSUED at issue. **financial:** none until debit.  
**Idempotency:** `external_ref` UNIQUE. **Returns:** `{instrument_id, estado, issued_date}`.

---

### 11. mark_supplier_instrument_debited

**Signature:** `mark_supplier_instrument_debited(p_instrument_id UUID, p_debited_date DATE, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_instrument.debited_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'

  inst = SELECT * FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE
  IF inst NOT FOUND              RAISE 'INSTRUMENT_NOT_FOUND'
  IF inst.direction <> 'ISSUED'  RAISE 'WRONG_DIRECTION'
  IF inst.estado <> 'ISSUED'     RAISE 'INVALID_STATE: expected ISSUED, found %', inst.estado

  ASSERT_PERIOD_OPEN(p_debited_date)

  UPDATE financial_instrument SET estado='DEBITED', debited_date=p_debited_date
   WHERE id = p_instrument_id

  operation_id = INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                 source_entity_type, source_entity_id, reason, created_by)
                 VALUES ('INSTRUMENT_DEBIT', p_debited_date,
                         'DEBIT:' || p_instrument_id::TEXT,
                         'financial_instrument', p_instrument_id::TEXT, p_reason, auth.uid())
                 RETURNING id

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (operation_id, inst.bank_account_id, -inst.amount, p_debited_date, auth.uid())

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'DEBITED', p_debited_date, operation_id, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'DEBIT',
          jsonb_build_object('estado','ISSUED'),
          jsonb_build_object('estado','DEBITED','debited_date',p_debited_date),
          p_reason, auth.uid())
END
```

**financial:** `-amount` posting on the issuing account. **supplier_ledger:** none — the debt was already reduced at issue.  
**Returns:** `{instrument_id, estado, debited_date, financial_operation_id}`.

---

### 12. reject_supplier_instrument

**Signature:** `reject_supplier_instrument(p_instrument_id UUID, p_rejected_date DATE, p_reason TEXT) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_instrument.rejected_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 RAISE 'REASON_REQUIRED'

  inst = SELECT * FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE
  IF inst NOT FOUND              RAISE 'INSTRUMENT_NOT_FOUND'
  IF inst.direction <> 'ISSUED'  RAISE 'WRONG_DIRECTION: use reject_cheque'
  IF inst.estado NOT IN ('ISSUED','DEBITED')
    RAISE 'INVALID_STATE: expected ISSUED or DEBITED, found %', inst.estado

  prior_estado = inst.estado
  ASSERT_PERIOD_OPEN(p_rejected_date)

  UPDATE financial_instrument SET estado='REJECTED', rejected_date=p_rejected_date
   WHERE id = p_instrument_id

  -- supplier debt reopens in both cases: the obligation was never actually settled
  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (inst.supplier_id, 'INSTRUMENT_REJECTED', inst.amount, p_rejected_date,
          'financial_instrument', p_instrument_id::TEXT, p_reason, auth.uid())

  operation_id = NULL
  IF prior_estado = 'DEBITED':
    -- the bank had already been debited; reverse it on the same account
    operation_id = INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                   source_entity_type, source_entity_id, reason, created_by)
                   VALUES ('INSTRUMENT_DEBIT_REVERSAL', p_rejected_date,
                           'DEBIT_REV:' || p_instrument_id::TEXT,
                           'financial_instrument', p_instrument_id::TEXT, p_reason, auth.uid())
                   RETURNING id
    INSERT INTO financial_posting (financial_operation_id, financial_account_id,
           signed_amount, effective_date, created_by)
    VALUES (operation_id, inst.bank_account_id, inst.amount, p_rejected_date, auth.uid())

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'REJECTED', p_rejected_date, operation_id, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'REJECT_ISSUED',
          jsonb_build_object('estado',prior_estado),
          jsonb_build_object('estado','REJECTED','rejected_date',p_rejected_date),
          p_reason, auth.uid())
END
```

**Returns:** `{instrument_id, prior_estado, estado, rejected_date, financial_operation_id}`.

---

### 42. cancel_supplier_instrument **[ADR-001]**

**Signature:** `cancel_supplier_instrument(p_instrument_id UUID, p_cancelled_date DATE, p_reason TEXT) RETURNS JSONB`
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_instrument.cancelled_date`

Voids an issued instrument that was never debited. Distinct from `reject_supplier_instrument` (12):
a rejection is a refusal by the bank/counterparty and is valid after DEBITED; a cancellation is the
issuer's void before any debit.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 RAISE 'REASON_REQUIRED'

  inst = SELECT * FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE
  IF inst NOT FOUND             RAISE 'INSTRUMENT_NOT_FOUND'
  IF inst.direction <> 'ISSUED' RAISE 'WRONG_DIRECTION: cancellation applies to issued instruments'
  IF inst.estado <> 'ISSUED'    RAISE 'INVALID_STATE: only an ISSUED (not yet debited) instrument can be cancelled, found %', inst.estado

  ASSERT_PERIOD_OPEN(p_cancelled_date)

  -- provenance resolved BEFORE any write: exactly one original issuance entry
  issued_count = SELECT COUNT(*) FROM supplier_ledger
                 WHERE supplier_id = inst.supplier_id AND movement_type = 'INSTRUMENT_ISSUED'
                   AND source_entity_type = 'financial_instrument'
                   AND source_entity_id = p_instrument_id::TEXT
  IF issued_count <> 1 RAISE 'ISSUANCE_LEDGER_INCONSISTENT'
  issued_entry_id = SELECT id FROM supplier_ledger WHERE <same predicate>

  UPDATE financial_instrument SET estado='CANCELLED', cancelled_date=p_cancelled_date
   WHERE id = p_instrument_id

  -- the issuance never settled the obligation: supplier debt reopens by reversing it
  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reversal_of_id, reason, created_by)
  VALUES (inst.supplier_id, 'REVERSAL', inst.amount, p_cancelled_date,
          'financial_instrument', p_instrument_id::TEXT, issued_entry_id, p_reason, auth.uid())

  -- no financial_operation, no financial_posting: the bank was never debited

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'CANCELLED', p_cancelled_date, NULL, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'CANCEL_ISSUED',
          jsonb_build_object('estado','ISSUED'),
          jsonb_build_object('estado','CANCELLED','cancelled_date',p_cancelled_date),
          p_reason, auth.uid())
END
```

**supplier_ledger:** `+amount` REVERSAL with `reversal_of_id` → the instrument's single `INSTRUMENT_ISSUED` entry, at `cancelled_date`. **financial:** none. **client_ledger:** none.
**Idempotency:** state guard under the row lock + `idx_instrument_event_unique` (one CANCELLED event). CANCELLED is terminal; RPCs 11 and 12 already refuse it (`estado` must be ISSUED / ISSUED|DEBITED).
**Errors:** `FORBIDDEN`, `REASON_REQUIRED`, `INSTRUMENT_NOT_FOUND`, `WRONG_DIRECTION`, `INVALID_STATE`, `ISSUANCE_LEDGER_INCONSISTENT`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`.
**Returns:** `{instrument_id, estado, cancelled_date}`.

---

## PURCHASES & SUPPLIERS

### 13. register_purchase

**Signature:**
```
register_purchase(
  p_supplier_id UUID, p_economic_date DATE,
  p_amount_net NUMERIC, p_amount_total NUMERIC,
  p_expense_category_id UUID, p_subcategory VARCHAR, p_nature purchase_nature,
  p_lines JSONB,                -- [{producto_id?, feed_ingredient_id?, descripcion, cantidad, unit_type, precio_unitario}]
  p_attachments JSONB,          -- [{storage_path, file_name, content_type, byte_size}] — OPTIONAL: NULL or [] allowed [ADR-010]
  p_idempotency_key VARCHAR,
  p_project_id UUID DEFAULT NULL, p_fiscal_document_id UUID DEFAULT NULL,
  p_supplier_invoice_number VARCHAR DEFAULT NULL, p_flock_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
```
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `purchases.economic_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_amount_total <= 0 RAISE 'INVALID_AMOUNT'
  IF p_nature IS NULL    RAISE 'NATURE_REQUIRED'
  IF p_expense_category_id IS NULL RAISE 'CATEGORY_REQUIRED'
  -- [ADR-010] attachments are optional; a supplied value must be an array
  IF p_attachments IS NOT NULL AND jsonb_typeof(p_attachments) <> 'array'
    RAISE 'INVALID_ATTACHMENTS: attachments must be an array'

  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo = true)
    RAISE 'SUPPLIER_NOT_FOUND_OR_INACTIVE'
  -- [ADR-002] the prefix 'RECTIFY:' (exact, case-sensitive) is reserved for system-generated version keys
  IF left(p_idempotency_key, 8) = 'RECTIFY:' RAISE 'RESERVED_IDEMPOTENCY_KEY'
  IF EXISTS (SELECT 1 FROM purchases WHERE idempotency_key = p_idempotency_key)
    RAISE 'DUPLICATE_PURCHASE'
  -- invoice number is unique per supplier only, never globally
  IF p_supplier_invoice_number IS NOT NULL
     AND EXISTS (SELECT 1 FROM purchases
                 WHERE supplier_id = p_supplier_id
                   AND supplier_invoice_number = p_supplier_invoice_number
                   AND is_current = true)
    RAISE 'DUPLICATE_SUPPLIER_INVOICE: % already recorded for this supplier', p_supplier_invoice_number

  ASSERT_PERIOD_OPEN(p_economic_date)

  purchase_id = INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total,
                expense_category_id, subcategory, nature, project_id, fiscal_document_id,
                supplier_invoice_number, flock_id, is_current, version_seq,
                idempotency_key, created_by)
                VALUES (p_supplier_id, p_economic_date, p_amount_net, p_amount_total,
                        p_expense_category_id, p_subcategory, p_nature, p_project_id,
                        p_fiscal_document_id, p_supplier_invoice_number, p_flock_id,
                        true, 0, p_idempotency_key, auth.uid())
                RETURNING id

  FOR EACH line IN p_lines:
    INSERT INTO purchase_line (purchase_id, producto_id, feed_ingredient_id, descripcion,
           cantidad, unit_type, precio_unitario)
    VALUES (purchase_id, line.producto_id, line.feed_ingredient_id, line.descripcion,
            line.cantidad, line.unit_type, line.precio_unitario)

  FOR EACH att IN p_attachments:
    INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type,
           byte_size, uploaded_by)
    VALUES (purchase_id, att.storage_path, att.file_name, att.content_type,
            att.byte_size, auth.uid())

  -- liability recognised at economic_date, on the global supplier account
  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_supplier_id, 'PURCHASE', p_amount_total, p_economic_date,
          'purchases', purchase_id::TEXT, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('purchases', purchase_id::TEXT, 'CREATE',
          jsonb_build_object('amount_total',p_amount_total,'nature',p_nature,
                             'economic_date',p_economic_date,
                             'attachments',jsonb_array_length(p_attachments)),
          p_reason, auth.uid())
END
```

**supplier_ledger:** `+amount_total` PURCHASE. **financial:** none — payment is a separate act (`pay_supplier`). Immediate-payment purchases are two RPC calls, never one netted row.  
**Idempotency:** `purchases.idempotency_key` UNIQUE.  
**Errors:** `FORBIDDEN`, `INVALID_AMOUNT`, `NATURE_REQUIRED`, `CATEGORY_REQUIRED`, `INVALID_ATTACHMENTS` **[ADR-010]** (was `ATTACHMENT_REQUIRED`), `SUPPLIER_NOT_FOUND_OR_INACTIVE`, `RESERVED_IDEMPOTENCY_KEY` **[ADR-002]**, `DUPLICATE_PURCHASE`, `DUPLICATE_SUPPLIER_INVOICE`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`.  
**Returns:** `{purchase_id, supplier_ledger_id, line_count, attachment_count}`.  
**Attachment objects [ADR-008]:** each `storage_path` is the key of an object the caller has already uploaded to the private bucket `purchase-attachments` (ADMIN-only, 10 MB, PDF / JPEG / PNG / WebP; key `<auth-user-id>/<uuid>.<ext>`; the original name goes in `file_name`). The RPC does not read Storage and is unchanged. Caller sequencing: upload → call; on an upload failure the RPC is not called; if the call fails the caller deletes the objects it uploaded and reports the RPC's original error.

---

### 14. rectify_purchase

**Signature:** `rectify_purchase(p_purchase_id UUID, p_new_amount_net NUMERIC, p_new_amount_total NUMERIC, p_new_lines JSONB, p_reason TEXT) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** the ORIGINAL `purchases.economic_date`

Same version-set discipline as `rectify_delivered_order` (RPC 2): the reversal cancels the **current**
version, and the current version is **retired before** the replacement is inserted.

```
BEGIN
  -- 1. authorize and lock the current version
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 RAISE 'REASON_REQUIRED'

  old = SELECT * FROM purchases WHERE id = p_purchase_id FOR UPDATE
  IF old NOT FOUND          RAISE 'PURCHASE_NOT_FOUND'
  IF old.is_current = false RAISE 'PURCHASE_SUPERSEDED: rectify the current version instead'

  ASSERT_PERIOD_OPEN(old.economic_date)

  -- 2. validate the replacement COMPLETELY before mutating anything
  IF p_new_amount_total <= 0 RAISE 'INVALID_AMOUNT'
  IF p_new_amount_net < 0    RAISE 'INVALID_AMOUNT'
  IF jsonb_array_length(p_new_lines) = 0 RAISE 'EMPTY_LINE_SET'
  FOR EACH line IN p_new_lines:
    IF line.cantidad <= 0       RAISE 'INVALID_QUANTITY'
    IF line.precio_unitario < 0 RAISE 'INVALID_PRICE'
    IF line.producto_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM products WHERE id = line.producto_id)
      RAISE 'PRODUCT_NOT_FOUND: %', line.producto_id
    IF line.feed_ingredient_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM feed_ingredient WHERE id = line.feed_ingredient_id)
      RAISE 'INGREDIENT_NOT_FOUND: %', line.feed_ingredient_id

  -- [ADR-010] the replacement inherits whatever attachments exist (possibly none); no attachment requirement

  -- 3. capture everything needed from the current version BEFORE it is altered
  v_supplier_id          = old.supplier_id
  v_economic_date        = old.economic_date
  v_expense_category_id  = old.expense_category_id
  v_subcategory          = old.subcategory
  v_nature               = old.nature
  v_project_id           = old.project_id
  v_fiscal_document_id   = old.fiscal_document_id
  v_supplier_invoice_num = old.supplier_invoice_number
  v_flock_id             = old.flock_id
  v_old_amount_total     = old.amount_total
  v_old_version          = old.version_seq
  new_version            = v_old_version + 1

  -- 4. RETIRE the current version FIRST. Technical metadata only: is_current flips.
  --    Business fields of the old row are never touched.
  --    This is mandatory, not stylistic: idx_purchases_supplier_invoice is
  --    UNIQUE(supplier_id, supplier_invoice_number) WHERE supplier_invoice_number IS NOT NULL
  --    AND is_current = true, so inserting the new version while the old one is still current
  --    raises a unique violation for every purchase that carries an invoice number.
  UPDATE purchases SET is_current = false WHERE id = p_purchase_id

  -- 5. THEN insert the new current version, reusing the captured values
  new_purchase_id = INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total,
                    expense_category_id, subcategory, nature, project_id, fiscal_document_id,
                    supplier_invoice_number, flock_id, is_current, version_seq,
                    idempotency_key, created_by)
                    VALUES (v_supplier_id, v_economic_date, p_new_amount_net,
                            p_new_amount_total, v_expense_category_id, v_subcategory,
                            v_nature, v_project_id, v_fiscal_document_id,
                            v_supplier_invoice_num, v_flock_id, true, new_version,
                            'RECTIFY:' || p_purchase_id::TEXT || ':v' || new_version,   -- [ADR-002]
                            auth.uid())
                    RETURNING id

  -- 6. lines for the new version
  FOR EACH line IN p_new_lines:
    INSERT INTO purchase_line (purchase_id, producto_id, feed_ingredient_id, descripcion,
           cantidad, unit_type, precio_unitario)
    VALUES (new_purchase_id, line.producto_id, line.feed_ingredient_id, line.descripcion,
            line.cantidad, line.unit_type, line.precio_unitario)

  -- 7. carry the existing attachments forward (none is valid) [ADR-010]
  INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type,
         byte_size, uploaded_by)
  SELECT new_purchase_id, storage_path, file_name, content_type, byte_size, auth.uid()
    FROM purchase_attachment WHERE purchase_id = p_purchase_id

  -- 8. freight already allocated to the old version follows it to the new one.
  --    This re-points the allocation; it creates no new economic effect (invariant 22).
  UPDATE freight_allocation SET purchase_id = new_purchase_id WHERE purchase_id = p_purchase_id

  -- 9. compensating supplier ledger entries, both at the ORIGINAL economic_date
  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_supplier_id, 'REVERSAL', -v_old_amount_total, v_economic_date,
          'purchases', p_purchase_id::TEXT, p_reason, auth.uid())

  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_supplier_id, 'PURCHASE', p_new_amount_total, v_economic_date,
          'purchases', new_purchase_id::TEXT, p_reason, auth.uid())

  -- 10. audit
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('purchases', p_purchase_id::TEXT, 'RECTIFY',
          jsonb_build_object('amount_total',v_old_amount_total,'version',v_old_version),
          jsonb_build_object('amount_total',p_new_amount_total,'version',new_version,
                             'new_id',new_purchase_id), p_reason, auth.uid())
END
```

**[ADR-002] Version key.** A rectified version's `idempotency_key` is `'RECTIFY:' || p_purchase_id || ':v' || new_version`, where `p_purchase_id` is the locked current version being rectified. It is deterministic and non-recursive, and at most 56 characters (8 + 36 + 2 + 10), so N passes never approach `VARCHAR(100)`. It is unique because a version can be rectified only once (afterwards it is superseded). The user's key is used only for the initial purchase, and `register_purchase` reserves the `RECTIFY:` prefix.

**Mutation order is mandatory.** Steps 4 and 5 must run in that order. Besides keeping the version-set
model coherent, the reverse order violates
`idx_purchases_supplier_invoice` whenever the purchase carries a `supplier_invoice_number`, because two
current rows would then share `(supplier_id, supplier_invoice_number)`. Step 3 captures the old row's
values before step 4 so the insert in step 5 does not depend on reading a row it has already altered.

**Atomicity.** The whole RPC is one transaction. Between steps 4 and 5 the purchase transiently has no
current version; that state is invisible to other sessions, and any failure in steps 5–10 rolls the
entire call back, leaving the previous version current. No purchase is ever persisted without a current
version, without lines, or without an attachment.

**Economic semantics unchanged:** `-old_amount_total` REVERSAL then `+new_amount_total` PURCHASE, both
dated at the original `economic_date`, on the global supplier account. No payment, posting or fiscal
component is created or moved.

**Errors:** `FORBIDDEN`, `REASON_REQUIRED`, `PURCHASE_NOT_FOUND`, `PURCHASE_SUPERSEDED`, `INVALID_AMOUNT`, `EMPTY_LINE_SET`, `INVALID_QUANTITY`, `INVALID_PRICE`, `PRODUCT_NOT_FOUND`, `INGREDIENT_NOT_FOUND`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED` (`ATTACHMENT_REQUIRED` removed **[ADR-010]**).  
**Returns:** `{previous_purchase_id, new_purchase_id, version_seq, adjustment}`.

---

### 15. pay_supplier

**Signature:** `pay_supplier(p_supplier_id UUID, p_amount NUMERIC, p_effective_date DATE, p_payment_method payment_method, p_financial_account_id UUID, p_external_ref VARCHAR, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `supplier_ledger.effective_date`

Payment is **not** allocated to invoices — it lands on the global supplier account (frozen Part 8). Partial payments are simply smaller amounts; a payment exceeding the balance leaves a supplier credit (negative balance), which is legitimate.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_amount <= 0 RAISE 'INVALID_AMOUNT'
  IF p_payment_method = 'CHEQUE'
    RAISE 'USE_ISSUE_SUPPLIER_INSTRUMENT: paying by cheque means issuing an instrument'
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo = true)
    RAISE 'SUPPLIER_NOT_FOUND_OR_INACTIVE'
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_financial_account_id AND activo = true)
    RAISE 'ACCOUNT_NOT_FOUND_OR_INACTIVE'
  IF EXISTS (SELECT 1 FROM financial_operation WHERE external_ref = p_external_ref)
    RAISE 'DUPLICATE_PAYMENT'

  ASSERT_PERIOD_OPEN(p_effective_date)

  operation_id = INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                 source_entity_type, source_entity_id, reason, created_by)
                 VALUES ('SUPPLIER_PAYMENT', p_effective_date, p_external_ref,
                         'suppliers', p_supplier_id::TEXT, p_reason, auth.uid())
                 RETURNING id

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (operation_id, p_financial_account_id, -p_amount, p_effective_date, auth.uid())

  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_supplier_id, 'PAYMENT', -p_amount, p_effective_date,
          'payment', operation_id::TEXT, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('suppliers', p_supplier_id::TEXT, 'PAY',
          jsonb_build_object('amount',p_amount,'effective_date',p_effective_date,
                             'method',p_payment_method), p_reason, auth.uid())
END
```

**supplier_ledger:** `-amount` PAYMENT. **financial:** `-amount` posting. **Idempotency:** `external_ref` UNIQUE.  
**Returns:** `{financial_operation_id, supplier_ledger_id}`.

---

## FREIGHT / LANDED COST

### 16. register_freight

**Signature:** `register_freight(p_economic_date DATE, p_amount NUMERIC, p_expense_category_id UUID, p_idempotency_key VARCHAR, p_supplier_id UUID DEFAULT NULL, p_document_ref VARCHAR DEFAULT NULL, p_fiscal_document_id UUID DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `freight.economic_date`

Freight is an independent economic operation. This is the **only** place freight debt is recognised.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_amount <= 0 RAISE 'INVALID_AMOUNT'
  IF EXISTS (SELECT 1 FROM freight WHERE idempotency_key = p_idempotency_key)
    RAISE 'DUPLICATE_FREIGHT'

  ASSERT_PERIOD_OPEN(p_economic_date)

  freight_id = INSERT INTO freight (supplier_id, economic_date, amount, document_ref,
               fiscal_document_id, expense_category_id, is_current, version_seq,
               idempotency_key, created_by)
               VALUES (p_supplier_id, p_economic_date, p_amount, p_document_ref,
                       p_fiscal_document_id, p_expense_category_id, true, 0,
                       p_idempotency_key, auth.uid())
               RETURNING id

  IF p_supplier_id IS NOT NULL:
    INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
           source_entity_type, source_entity_id, reason, created_by)
    VALUES (p_supplier_id, 'FREIGHT', p_amount, p_economic_date,
            'freight', freight_id::TEXT, p_reason, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('freight', freight_id::TEXT, 'CREATE',
          jsonb_build_object('amount',p_amount,'economic_date',p_economic_date),
          p_reason, auth.uid())
END
```

**supplier_ledger:** `+amount` FREIGHT (only when a freight supplier exists). **financial:** none — payment goes through `pay_supplier`.  
**Returns:** `{freight_id, economic_date, amount}`.

---

### 17. assign_freight_to_purchase

**Signature:** `assign_freight_to_purchase(p_freight_id UUID, p_purchase_id UUID, p_allocated_amount NUMERIC, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `freight.economic_date` (cost attribution may only change while that period is OPEN)

**Creates no second expense.** This RPC writes exactly one `freight_allocation` row: no supplier_ledger row, no financial_posting, no fiscal component. The expense was recognised once in `register_freight`; allocation only attributes it to a purchase for landed-cost purposes.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_allocated_amount <= 0 RAISE 'INVALID_AMOUNT'

  fr = SELECT * FROM freight WHERE id = p_freight_id FOR UPDATE
  IF fr NOT FOUND        RAISE 'FREIGHT_NOT_FOUND'
  IF fr.is_current = false RAISE 'FREIGHT_SUPERSEDED'

  pu = SELECT * FROM purchases WHERE id = p_purchase_id
  IF pu NOT FOUND        RAISE 'PURCHASE_NOT_FOUND'
  IF pu.is_current = false RAISE 'PURCHASE_SUPERSEDED'

  -- historical cost correction is allowed only while the freight period is OPEN
  ASSERT_PERIOD_OPEN(fr.economic_date)

  already = SELECT COALESCE(SUM(allocated_amount),0) FROM freight_allocation
            WHERE freight_id = p_freight_id
  IF already + p_allocated_amount > fr.amount
    RAISE 'OVER_ALLOCATION: allocating % exceeds freight amount % (already allocated %)',
          p_allocated_amount, fr.amount, already

  IF EXISTS (SELECT 1 FROM freight_allocation
             WHERE freight_id = p_freight_id AND purchase_id = p_purchase_id)
    RAISE 'ALREADY_ALLOCATED: this freight is already allocated to this purchase'

  allocation_id = INSERT INTO freight_allocation (freight_id, purchase_id, allocated_amount,
                  allocated_by)
                  VALUES (p_freight_id, p_purchase_id, p_allocated_amount, auth.uid())
                  RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('freight_allocation', allocation_id::TEXT, 'ALLOCATE',
          jsonb_build_object('freight_id',p_freight_id,'purchase_id',p_purchase_id,
                             'allocated_amount',p_allocated_amount), p_reason, auth.uid())
END
```

**No double counting, restated:** P&L reads freight either as an unallocated expense or through allocation as part of landed cost — never both. `OVER_ALLOCATION` caps total allocation at `freight.amount`.  
**Idempotency:** `UNIQUE(freight_id, purchase_id)`.  
**Returns:** `{allocation_id, freight_remaining}`.

---

## PRODUCTION

**[ADR-007] Invariant 29 (no dated flock activity after exit):** RPCs 18–22 and 29 call the owner-only helper
`assert_flock_activity_date(flock_id, effective_date)` before their period guard: when the flock has an `exit_date`,
an effective date after it raises `ACTIVITY_AFTER_FLOCK_EXIT`. Rectifications check the original date they keep.
Historical activity dated on or before the exit stays valid on a RETIRED flock; RPC 18 keeps its `FLOCK_NOT_ACTIVE` check.

### 18. register_daily_production

**Signature:** `register_daily_production(p_flock_id UUID, p_production_date DATE, p_eggs_total INTEGER, p_eggs_broken INTEGER DEFAULT 0, p_eggs_dirty INTEGER DEFAULT 0, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** OPERATOR (assigned flocks) or ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `daily_production.production_date`

```
BEGIN
  role = current_app_role()                      -- raises if the user is unknown or inactive
  IF role = 'OPERATOR'
     AND NOT EXISTS (SELECT 1 FROM operator_assignments
                     WHERE operator_id = auth.uid() AND flock_id = p_flock_id AND activo = true)
    RAISE 'FLOCK_NOT_ASSIGNED: operator is not assigned to this flock'

  IF p_eggs_total < 0 RAISE 'INVALID_QUANTITY'
  IF NOT EXISTS (SELECT 1 FROM flocks WHERE id = p_flock_id AND estado = 'ACTIVE')
    RAISE 'FLOCK_NOT_ACTIVE'

  ASSERT_PERIOD_OPEN(p_production_date)

  IF EXISTS (SELECT 1 FROM daily_production
             WHERE flock_id = p_flock_id AND production_date = p_production_date
               AND is_current = true)
    RAISE 'DUPLICATE_PRODUCTION: production already recorded for this flock on %; rectify it instead',
          p_production_date

  production_id = INSERT INTO daily_production (flock_id, production_date, eggs_total,
                  eggs_broken, eggs_dirty, is_current, version_seq, created_by)
                  VALUES (p_flock_id, p_production_date, p_eggs_total, p_eggs_broken,
                          p_eggs_dirty, true, 0, auth.uid())
                  RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('daily_production', production_id::TEXT, 'CREATE',
          jsonb_build_object('flock_id',p_flock_id,'production_date',p_production_date,
                             'eggs_total',p_eggs_total), p_reason, auth.uid())
END
```

No ledger consequence — production is a physical fact. Production and mortality stay separate facts even when one screen captures both.  
**Idempotency:** partial unique index on `(flock_id, production_date) WHERE is_current`.  
**Returns:** `{production_id, production_date, eggs_total}`.

---

### 19. rectify_daily_production

**Signature:** `rectify_daily_production(p_production_id UUID, p_new_eggs_total INTEGER, p_new_eggs_broken INTEGER, p_new_eggs_dirty INTEGER, p_reason TEXT) RETURNS JSONB`  
**Actor:** OPERATOR (own records only) or ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** original `production_date`

One RPC serves both actors; the distinction is internal authorization, not a second function.

| | OPERATOR | ADMIN |
|---|---|---|
| whose record | only rows where `created_by = auth.uid()` | any current row |
| which flock | only flocks currently assigned and `activo = true` | any flock |
| period | must be OPEN | must be OPEN |
| reopening a CLOSED period | not permitted (no execute on RPC 38) | permitted via RPC 38, then rectify |
| reason | mandatory | mandatory |

The frozen split is preserved exactly by that last row: both actors need an OPEN period, and only
ADMIN can reopen one. So an OPERATOR corrects its own recent production, while historical correction
remains an ADMIN capability — without granting OPERATOR any new table access.

```
BEGIN
  -- 1. authorize: resolve the role internally, never from a parameter
  role = current_app_role()                   -- raises if unknown or inactive
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 RAISE 'REASON_REQUIRED'

  old = SELECT * FROM daily_production WHERE id = p_production_id FOR UPDATE
  IF old NOT FOUND          RAISE 'PRODUCTION_NOT_FOUND'
  IF old.is_current = false RAISE 'ALREADY_SUPERSEDED'

  IF role = 'OPERATOR':
    -- own record only
    IF old.created_by IS DISTINCT FROM auth.uid()
      RAISE 'NOT_OWN_RECORD: an operator may only rectify production it recorded'
    -- flock must still be assigned to this operator
    IF NOT EXISTS (SELECT 1 FROM operator_assignments
                   WHERE operator_id = auth.uid() AND flock_id = old.flock_id AND activo = true)
      RAISE 'FLOCK_NOT_ASSIGNED: operator is not currently assigned to this flock'

  -- ADMIN needs no extra predicate: any current row is rectifiable.

  -- 2. validate the replacement COMPLETELY before mutating anything
  IF p_new_eggs_total  < 0 RAISE 'INVALID_QUANTITY'
  IF p_new_eggs_broken < 0 RAISE 'INVALID_QUANTITY'
  IF p_new_eggs_dirty  < 0 RAISE 'INVALID_QUANTITY'

  -- 3. period guard: identical for both actors. Only ADMIN can reopen a closed period (RPC 38).
  ASSERT_PERIOD_OPEN(old.production_date)

  new_version = old.version_seq + 1

  -- 4. RETIRE the current row FIRST, then insert: idx_daily_production_current is
  --    UNIQUE(flock_id, production_date) WHERE is_current = true, so the reverse order
  --    raises a unique violation.
  UPDATE daily_production SET is_current = false WHERE id = p_production_id

  -- 5. THEN insert the corrected version
  new_id = INSERT INTO daily_production (flock_id, production_date, eggs_total, eggs_broken,
           eggs_dirty, is_current, version_seq, created_by)
           VALUES (old.flock_id, old.production_date, p_new_eggs_total, p_new_eggs_broken,
                   p_new_eggs_dirty, true, new_version, auth.uid())
           RETURNING id

  -- 6. supersession pointer (replacement here is strictly 1:1, so a pointer is meaningful)
  UPDATE daily_production SET superseded_by = new_id WHERE id = p_production_id

  -- 7. audit: records the actor and the role that authorized the correction
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('daily_production', p_production_id::TEXT, 'RECTIFY',
          jsonb_build_object('eggs_total',old.eggs_total,'eggs_broken',old.eggs_broken,
                             'eggs_dirty',old.eggs_dirty,'version',old.version_seq,
                             'created_by',old.created_by),
          jsonb_build_object('eggs_total',p_new_eggs_total,'eggs_broken',p_new_eggs_broken,
                             'eggs_dirty',p_new_eggs_dirty,'version',new_version,
                             'new_id',new_id,'actor_role',role),
          p_reason, auth.uid())
END
```

**No widening of OPERATOR scope.** This adds no table privilege and no policy. OPERATOR still reaches
`daily_production` only through RPCs 18/19 and still reads only assigned flocks. Commercial,
financial, cost, population (`population_events`) and aggregated-laying data remain unreachable:
mortality correction stays ADMIN-only in `rectify_mortality` (RPC 21), and nothing here touches a
ledger, a posting or a price.

**No economic consequence.** Production is a physical fact; this RPC writes no ledger and no posting.

**Atomicity.** One transaction. The transient state between steps 4 and 5 is invisible outside it, and
any failure rolls the whole call back, leaving the previous version current.

**Idempotency:** not idempotent by design — each call is a distinct correction and increments
`version_seq`. `ALREADY_SUPERSEDED` prevents rectifying a retired row.  
**Errors:** `NOT_AUTHENTICATED`, `USER_NOT_FOUND_OR_INACTIVE`, `REASON_REQUIRED`, `PRODUCTION_NOT_FOUND`, `ALREADY_SUPERSEDED`, `NOT_OWN_RECORD`, `FLOCK_NOT_ASSIGNED`, `INVALID_QUANTITY`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`.  
**Returns:** `{previous_id, new_id, version_seq}`.

---

### 20. register_mortality

**Signature:** `register_mortality(p_flock_id UUID, p_event_date DATE, p_deaths BIGINT, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** OPERATOR (assigned) or ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `population_events.event_date`

```
BEGIN
  role = current_app_role()
  IF role = 'OPERATOR'
     AND NOT EXISTS (SELECT 1 FROM operator_assignments
                     WHERE operator_id = auth.uid() AND flock_id = p_flock_id AND activo = true)
    RAISE 'FLOCK_NOT_ASSIGNED'

  IF p_deaths <= 0 RAISE 'INVALID_QUANTITY: deaths must be positive'
  ASSERT_PERIOD_OPEN(p_event_date)

  existing = SELECT * FROM population_events
             WHERE flock_id = p_flock_id AND event_date = p_event_date
               AND event_type = 'MORTALITY' AND is_current = true
  IF existing FOUND
    RAISE 'MORTALITY_ALREADY_RECORDED: % deaths already recorded for this flock on %; rectify instead',
          -existing.delta, p_event_date

  event_id = INSERT INTO population_events (flock_id, event_type, delta, event_date,
             is_current, version_seq, reason, created_by)
             VALUES (p_flock_id, 'MORTALITY', -p_deaths, p_event_date, true, 0,
                     p_reason, auth.uid())
             RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('population_events', event_id::TEXT, 'MORTALITY',
          jsonb_build_object('flock_id',p_flock_id,'event_date',p_event_date,'deaths',p_deaths),
          p_reason, auth.uid())
END
```

`delta` is stored negative for mortality. The duplicate message reports the existing value to the operator (frozen Part 11) rather than creating a conflict record.  
**Idempotency:** partial unique index on `(flock_id, event_date) WHERE event_type='MORTALITY' AND is_current`.  
**Returns:** `{event_id, event_date, deaths}`.

---

### 21. rectify_mortality

**Signature:** `rectify_mortality(p_event_id BIGINT, p_new_deaths BIGINT, p_reason TEXT) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** original `event_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 RAISE 'REASON_REQUIRED'
  IF p_new_deaths <= 0 RAISE 'INVALID_QUANTITY'

  old = SELECT * FROM population_events WHERE id = p_event_id FOR UPDATE
  IF old NOT FOUND                  RAISE 'EVENT_NOT_FOUND'
  IF old.event_type <> 'MORTALITY'   RAISE 'NOT_A_MORTALITY_EVENT'
  IF old.is_current = false          RAISE 'ALREADY_SUPERSEDED'

  ASSERT_PERIOD_OPEN(old.event_date)

  new_version = old.version_seq + 1

  -- retire first so the partial unique index never sees two current rows
  UPDATE population_events SET is_current = false WHERE id = p_event_id

  new_id = INSERT INTO population_events (flock_id, event_type, delta, event_date,
           is_current, version_seq, reason, created_by)
           VALUES (old.flock_id, 'MORTALITY', -p_new_deaths, old.event_date, true,
                   new_version, p_reason, auth.uid())
           RETURNING id

  UPDATE population_events SET superseded_by = new_id WHERE id = p_event_id

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('population_events', p_event_id::TEXT, 'RECTIFY_MORTALITY',
          jsonb_build_object('deaths',-old.delta,'version',old.version_seq),
          jsonb_build_object('deaths',p_new_deaths,'version',new_version,'new_id',new_id),
          p_reason, auth.uid())
END
```

Business fields of the old row (`delta`, `event_date`, `flock_id`) are never modified — only `is_current` and `superseded_by`. Mortality replacement is 1:1, so a pointer is meaningful here.  
**Returns:** `{previous_id, new_id, version_seq}`.

---

### 22. register_count_adjustment

**Signature:** `register_count_adjustment(p_flock_id UUID, p_event_date DATE, p_delta BIGINT, p_reason TEXT) RETURNS JSONB`  
**Actor:** OPERATOR (assigned) or ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `population_events.event_date`

```
BEGIN
  role = current_app_role()
  IF role = 'OPERATOR'
     AND NOT EXISTS (SELECT 1 FROM operator_assignments
                     WHERE operator_id = auth.uid() AND flock_id = p_flock_id AND activo = true)
    RAISE 'FLOCK_NOT_ASSIGNED'

  IF p_delta = 0 RAISE 'INVALID_QUANTITY: delta must be non-zero'
  IF p_reason IS NULL OR length(trim(p_reason)) = 0
    RAISE 'REASON_REQUIRED: a count adjustment must be explained'

  ASSERT_PERIOD_OPEN(p_event_date)

  event_id = INSERT INTO population_events (flock_id, event_type, delta, event_date,
             is_current, version_seq, reason, created_by)
             VALUES (p_flock_id, 'COUNT_ADJUSTMENT', p_delta, p_event_date, true, 0,
                     p_reason, auth.uid())
             RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('population_events', event_id::TEXT, 'COUNT_ADJUSTMENT',
          jsonb_build_object('flock_id',p_flock_id,'event_date',p_event_date,'delta',p_delta),
          p_reason, auth.uid())
END
```

Multiple COUNT_ADJUSTMENT rows per date are allowed by design — the partial unique index covers MORTALITY only. A recount never overwrites the observed mortality value; the variance becomes an explicit audited adjustment.  
**Returns:** `{event_id, delta}`.

---

### 23. register_flock_weighing

**Signature:** `register_flock_weighing(p_flock_id UUID, p_weighing_date DATE, p_sample_size INTEGER, p_average_weight_kg DECIMAL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** OPERATOR (assigned) or ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `flock_weighing.weighing_date`

```
BEGIN
  role = current_app_role()
  IF role = 'OPERATOR'
     AND NOT EXISTS (SELECT 1 FROM operator_assignments
                     WHERE operator_id = auth.uid() AND flock_id = p_flock_id AND activo = true)
    RAISE 'FLOCK_NOT_ASSIGNED'

  IF p_sample_size <= 0        RAISE 'INVALID_SAMPLE_SIZE'
  IF p_average_weight_kg <= 0  RAISE 'INVALID_WEIGHT'

  ASSERT_PERIOD_OPEN(p_weighing_date)

  IF EXISTS (SELECT 1 FROM flock_weighing
             WHERE flock_id = p_flock_id AND weighing_date = p_weighing_date)
    RAISE 'DUPLICATE_WEIGHING'

  weighing_id = INSERT INTO flock_weighing (flock_id, weighing_date, sample_size,
                average_weight_kg, created_by)
                VALUES (p_flock_id, p_weighing_date, p_sample_size, p_average_weight_kg,
                        auth.uid())
                RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('flock_weighing', weighing_id::TEXT, 'CREATE',
          jsonb_build_object('flock_id',p_flock_id,'weighing_date',p_weighing_date,
                             'average_weight_kg',p_average_weight_kg), p_reason, auth.uid())
END
```

**Idempotency:** `UNIQUE(flock_id, weighing_date)`. **Returns:** `{weighing_id}`.

---

### 24. register_temperature_record

**Signature:** `register_temperature_record(p_shed_id UUID, p_record_date DATE, p_record_time TIME, p_temperature_celsius DECIMAL, p_humidity_pct DECIMAL DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** OPERATOR or ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `temperature_record.record_date`

```
BEGIN
  role = current_app_role()
  IF role = 'OPERATOR'
     AND NOT EXISTS (SELECT 1 FROM operator_assignments oa
                     JOIN flocks f ON f.id = oa.flock_id
                     WHERE oa.operator_id = auth.uid() AND oa.activo = true
                       AND f.shed_id = p_shed_id)
    RAISE 'SHED_NOT_ASSIGNED'

  IF NOT EXISTS (SELECT 1 FROM sheds WHERE id = p_shed_id AND activo = true)
    RAISE 'SHED_NOT_FOUND_OR_INACTIVE'

  ASSERT_PERIOD_OPEN(p_record_date)

  IF EXISTS (SELECT 1 FROM temperature_record
             WHERE shed_id = p_shed_id AND record_date = p_record_date
               AND record_time = p_record_time)
    RAISE 'DUPLICATE_TEMPERATURE_RECORD'

  record_id = INSERT INTO temperature_record (shed_id, record_date, record_time,
              temperature_celsius, humidity_pct, created_by)
              VALUES (p_shed_id, p_record_date, p_record_time, p_temperature_celsius,
                      p_humidity_pct, auth.uid())
              RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('temperature_record', record_id::TEXT, 'CREATE',
          jsonb_build_object('shed_id',p_shed_id,'record_date',p_record_date,
                             'temperature_celsius',p_temperature_celsius), p_reason, auth.uid())
END
```

**Idempotency:** `UNIQUE(shed_id, record_date, record_time)`. **Returns:** `{record_id}`.

---

### 44. register_flock **[ADR-007]**

**Signature:** `register_flock(p_shed_id UUID, p_entry_date DATE, p_initial_population BIGINT, p_genetics_line VARCHAR DEFAULT NULL, p_birth_date DATE DEFAULT NULL, p_supplier_id UUID DEFAULT NULL, p_purchase_id UUID DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `flocks.entry_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_initial_population IS NULL OR p_initial_population < 0 RAISE 'INVALID_QUANTITY'
  IF p_entry_date IS NULL OR p_entry_date > business_today RAISE 'INVALID_DATE'
      -- business_today = (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
  IF p_birth_date IS NOT NULL AND p_birth_date > p_entry_date RAISE 'INVALID_DATE'
  ASSERT_PERIOD_OPEN(p_entry_date)
  shed = SELECT * FROM sheds WHERE id = p_shed_id FOR UPDATE      -- serialises registrations per shed
  IF shed NOT FOUND RAISE 'SHED_NOT_FOUND'
  IF NOT shed.activo RAISE 'SHED_INACTIVE'
  IF EXISTS (SELECT 1 FROM flocks WHERE shed_id = p_shed_id AND estado = 'ACTIVE') RAISE 'SHED_OCCUPIED'
  IF p_supplier_id given AND not found in suppliers RAISE 'SUPPLIER_NOT_FOUND'
  IF p_purchase_id given AND not found in purchases RAISE 'PURCHASE_NOT_FOUND'
  flock_id = INSERT INTO flocks (shed_id, estado, genetics_line, birth_date, entry_date, initial_population,
                                 supplier_id, purchase_id, created_by)
             VALUES (p_shed_id, 'ACTIVE', NULLIF(trim(p_genetics_line), ''), p_birth_date, p_entry_date,
                     p_initial_population, p_supplier_id, p_purchase_id, auth.uid())
      -- unique_violation on idx_flocks_shed_active → 'SHED_OCCUPIED'
  INSERT INTO audit_events ('flocks', flock_id, 'CREATE', after {shed_id, entry_date, initial_population, estado}, p_reason)
  RETURN {flock_id, shed_id, entry_date, initial_population, estado: 'ACTIVE'}
COMMIT
```
**Idempotency:** not idempotent by key; a repeated call for the same shed is `SHED_OCCUPIED` while the first flock is ACTIVE.
**Errors:** `NOT_AUTHENTICATED`, `USER_NOT_FOUND_OR_INACTIVE`, `FORBIDDEN`, `INVALID_QUANTITY`, `INVALID_DATE`, `PERIOD_CLOSED`, `PERIOD_NOT_FOUND`, `SHED_NOT_FOUND`, `SHED_INACTIVE`, `SHED_OCCUPIED`, `SUPPLIER_NOT_FOUND`, `PURCHASE_NOT_FOUND`.

### 45. close_flock **[ADR-007]**

**Signature:** `close_flock(p_flock_id UUID, p_exit_date DATE, p_reason TEXT DEFAULT NULL) RETURNS JSONB`
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `flocks.exit_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_exit_date IS NULL RAISE 'INVALID_DATE'
  flock = SELECT * FROM flocks WHERE id = p_flock_id FOR UPDATE
  IF flock NOT FOUND RAISE 'FLOCK_NOT_FOUND'
  IF flock.estado <> 'ACTIVE' RAISE 'FLOCK_NOT_ACTIVE'
  IF p_exit_date < flock.entry_date OR p_exit_date > business_today RAISE 'INVALID_DATE'
  IF a current daily_production.production_date, a current population_events.event_date or a
     flock_feed_assignment.effective_from of the flock is > p_exit_date RAISE 'EXIT_BEFORE_RECORDED_ACTIVITY'
  ASSERT_PERIOD_OPEN(p_exit_date)
  UPDATE flocks SET estado = 'RETIRED', exit_date = p_exit_date WHERE id = p_flock_id   -- the shed is free again
  ids = UPDATE operator_assignments SET activo = false
         WHERE flock_id = p_flock_id AND activo = true RETURNING id                     -- rows kept as history
  INSERT INTO audit_events ('flocks', p_flock_id, 'CLOSE', before {estado, exit_date},
                            after {estado, exit_date, deactivated_assignment_ids: ids}, p_reason)
  RETURN {flock_id, shed_id, exit_date, estado: 'RETIRED', deactivated_assignments: count(ids)}
COMMIT
```
**Idempotency:** a second close is `FLOCK_NOT_ACTIVE` and writes nothing.
**Errors:** `NOT_AUTHENTICATED`, `USER_NOT_FOUND_OR_INACTIVE`, `FORBIDDEN`, `INVALID_DATE`, `FLOCK_NOT_FOUND`, `FLOCK_NOT_ACTIVE`, `EXIT_BEFORE_RECORDED_ACTIVITY`, `PERIOD_CLOSED`, `PERIOD_NOT_FOUND`.
No population event is written: the population at exit stays derived. The exit reason lives in `audit_events.reason`.

## CLASSIFICATION

### 25. register_classification

**Signature:** `register_classification(p_idempotency_key UUID, p_classification_date DATE, p_lines JSONB, p_location VARCHAR DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** OPERATOR or ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `classification.classification_date`

`p_lines` is `[{classification_grade_id, quantity}]`. No flock reference exists or is accepted.

**[ADR-012]** `p_lines` is `[{classification_grade_id, quantity, unit}]`: `quantity` is the number typed, `unit` is `UNIDAD | MAPLE` (absent = `UNIDAD`). The backend stores `entered_quantity` / `entered_unit` and the canonical egg count `quantity = entered × (1 | MAPLE: 20 for XL, 30 otherwise)`. New errors `INVALID_UNIT`; `INVALID_QUANTITY` also covers a conversion beyond the integer range.

```
BEGIN
  role = current_app_role()
  IF jsonb_array_length(p_lines) = 0 RAISE 'EMPTY_LINE_SET'

  IF EXISTS (SELECT 1 FROM classification WHERE idempotency_key = p_idempotency_key)
    RAISE 'DUPLICATE_CLASSIFICATION'

  ASSERT_PERIOD_OPEN(p_classification_date)

  FOR EACH line IN p_lines:
    IF line.quantity < 0 RAISE 'INVALID_QUANTITY'
    IF NOT EXISTS (SELECT 1 FROM classification_grade
                   WHERE id = line.classification_grade_id AND activo = true)
      RAISE 'GRADE_NOT_FOUND: %', line.classification_grade_id

  classification_id = INSERT INTO classification (idempotency_key, classification_date,
                      location, created_by)
                      VALUES (p_idempotency_key, p_classification_date, p_location, auth.uid())
                      RETURNING id

  FOR EACH line IN p_lines:
    INSERT INTO classification_line (classification_id, classification_grade_id, quantity)
    VALUES (classification_id, line.classification_grade_id, line.quantity)

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('classification', classification_id::TEXT, 'CREATE',
          jsonb_build_object('classification_date',p_classification_date,
                             'line_count',jsonb_array_length(p_lines)), p_reason, auth.uid())
END
```

Multiple sessions per day are allowed. **Idempotency:** `classification.idempotency_key` UNIQUE.  
**Returns:** `{classification_id, line_count, total_quantity}`.

---

## FEED

### 26. register_feed_manufacturing

**[ADR-013]** A formula version with no `feed_formula_line` is refused: `FORMULA_VERSION_EMPTY` (checked after `FORMULA_VERSION_NOT_EFFECTIVE`).

**Signature:** `register_feed_manufacturing(p_formula_version_id UUID, p_manufacturing_date DATE, p_quantity_kg DECIMAL, p_idempotency_key VARCHAR, p_batch_number VARCHAR DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** OPERATOR or ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `feed_manufacturing.manufacturing_date`

```
BEGIN
  role = current_app_role()
  IF p_quantity_kg <= 0 RAISE 'INVALID_QUANTITY'
  IF EXISTS (SELECT 1 FROM feed_manufacturing WHERE idempotency_key = p_idempotency_key)
    RAISE 'DUPLICATE_MANUFACTURING'

  fv = SELECT * FROM feed_formula_version WHERE id = p_formula_version_id
  IF fv NOT FOUND RAISE 'FORMULA_VERSION_NOT_FOUND'
  IF p_manufacturing_date < fv.effective_from
     OR (fv.effective_to IS NOT NULL AND p_manufacturing_date > fv.effective_to)
    RAISE 'FORMULA_VERSION_NOT_EFFECTIVE: version is not effective on %', p_manufacturing_date

  ASSERT_PERIOD_OPEN(p_manufacturing_date)

  manufacturing_id = INSERT INTO feed_manufacturing (formula_version_id, manufacturing_date,
                     quantity_kg, batch_number, idempotency_key, created_by)
                     VALUES (p_formula_version_id, p_manufacturing_date, p_quantity_kg,
                             p_batch_number, p_idempotency_key, auth.uid())
                     RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('feed_manufacturing', manufacturing_id::TEXT, 'CREATE',
          jsonb_build_object('formula_version_id',p_formula_version_id,
                             'manufacturing_date',p_manufacturing_date,
                             'quantity_kg',p_quantity_kg), p_reason, auth.uid())
END
```

`formula_version_id` records the exact version applied and is immutable thereafter. Batch cost is derived from `feed_formula_line.unit_cost_snapshot`, never stored here.  
**Returns:** `{manufacturing_id, quantity_kg}`.

---

### 27. register_feed_inventory_count

**Signature:** `register_feed_inventory_count(p_feed_type_id UUID, p_count_date DATE, p_quantity_kg DECIMAL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** OPERATOR or ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `feed_inventory_count.count_date`

```
BEGIN
  role = current_app_role()
  IF p_quantity_kg < 0 RAISE 'INVALID_QUANTITY'
  ASSERT_PERIOD_OPEN(p_count_date)

  IF EXISTS (SELECT 1 FROM feed_inventory_count
             WHERE feed_type_id = p_feed_type_id AND count_date = p_count_date)
    RAISE 'DUPLICATE_COUNT: a count already exists for this feed type on %', p_count_date

  count_id = INSERT INTO feed_inventory_count (feed_type_id, count_date, quantity_kg,
             reason, created_by)
             VALUES (p_feed_type_id, p_count_date, p_quantity_kg, p_reason, auth.uid())
             RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('feed_inventory_count', count_id::TEXT, 'CREATE',
          jsonb_build_object('feed_type_id',p_feed_type_id,'count_date',p_count_date,
                             'quantity_kg',p_quantity_kg), p_reason, auth.uid())
END
```

A count is an observation. `consumo_interno` is derived per period from counts + manufacturing + movements; it is never stored.  
**Idempotency:** `UNIQUE(feed_type_id, count_date)`. **Returns:** `{count_id}`.

---

### 28. register_feed_movement

**Signature:** `register_feed_movement(p_feed_type_id UUID, p_movement_type feed_movement_type, p_quantity_kg DECIMAL, p_movement_date DATE, p_pedido_id UUID DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `feed_movement.movement_date`

Records external output, losses and explicit adjustments feeding the stock equation.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_quantity_kg <= 0 RAISE 'INVALID_QUANTITY'
  IF p_movement_type = 'EXTERNAL_SALE' AND p_pedido_id IS NULL
    RAISE 'PEDIDO_REQUIRED: an external sale must reference its Pedido'
  IF p_movement_type <> 'EXTERNAL_SALE' AND (p_reason IS NULL OR length(trim(p_reason)) = 0)
    RAISE 'REASON_REQUIRED: adjustments and losses must be explained'

  ASSERT_PERIOD_OPEN(p_movement_date)

  movement_id = INSERT INTO feed_movement (feed_type_id, movement_type, quantity_kg,
                movement_date, pedido_id, reason, created_by)
                VALUES (p_feed_type_id, p_movement_type, p_quantity_kg, p_movement_date,
                        p_pedido_id, p_reason, auth.uid())
                RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('feed_movement', movement_id::TEXT, 'CREATE',
          jsonb_build_object('feed_type_id',p_feed_type_id,'movement_type',p_movement_type,
                             'quantity_kg',p_quantity_kg,'movement_date',p_movement_date),
          p_reason, auth.uid())
END
```

The economic sale itself is the Pedido; this row is the physical feed outflow. No ledger consequence here.  
**Returns:** `{movement_id}`.

---

### 29. assign_flock_feed

**[ADR-007]** `p_effective_from` is checked against the flock exit date (invariant 29, `ACTIVITY_AFTER_FLOCK_EXIT`).

**Signature:** `assign_flock_feed(p_flock_id UUID, p_feed_type_id UUID, p_effective_from DATE, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** none (a master assignment, not an economic fact)

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF NOT EXISTS (SELECT 1 FROM flocks WHERE id = p_flock_id) RAISE 'FLOCK_NOT_FOUND'
  IF NOT EXISTS (SELECT 1 FROM feed_type WHERE id = p_feed_type_id AND activo = true)
    RAISE 'FEED_TYPE_NOT_FOUND_OR_INACTIVE'

  -- close the open assignment, then open the new one (one current row per flock)
  UPDATE flock_feed_assignment SET effective_to = p_effective_from - 1
   WHERE flock_id = p_flock_id AND effective_to IS NULL

  assignment_id = INSERT INTO flock_feed_assignment (flock_id, feed_type_id, effective_from,
                  created_by)
                  VALUES (p_flock_id, p_feed_type_id, p_effective_from, auth.uid())
                  RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('flock_feed_assignment', assignment_id::TEXT, 'ASSIGN',
          jsonb_build_object('flock_id',p_flock_id,'feed_type_id',p_feed_type_id,
                             'effective_from',p_effective_from), p_reason, auth.uid())
END
```

Input to consumo teórico only. **Returns:** `{assignment_id}`.

---

## FERIA (SALES SESSIONS)

### 30. open_sales_session

**Signature:** `open_sales_session(p_session_date DATE, p_location VARCHAR, p_idempotency_key VARCHAR, p_opening_fund NUMERIC DEFAULT 0, p_cash_account_id UUID DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `sales_session.session_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF EXISTS (SELECT 1 FROM sales_session WHERE idempotency_key = p_idempotency_key)
    RAISE 'DUPLICATE_SESSION'
  IF p_opening_fund > 0 AND p_cash_account_id IS NULL
    RAISE 'ACCOUNT_REQUIRED: an opening fund needs a cash account'

  ASSERT_PERIOD_OPEN(p_session_date)

  session_id = INSERT INTO sales_session (session_date, location, estado, opened_by,
               idempotency_key)
               VALUES (p_session_date, p_location, 'OPEN', auth.uid(), p_idempotency_key)
               RETURNING id

  IF p_opening_fund > 0:
    operation_id = INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                   source_entity_type, source_entity_id, created_by)
                   VALUES ('SESSION_CASH', p_session_date,
                           'SESSION_FUND:' || session_id::TEXT,
                           'sales_session', session_id::TEXT, auth.uid())
                   RETURNING id
    INSERT INTO sales_session_cash_event (sales_session_id, event_type, amount,
           financial_account_id, financial_operation_id, event_date, created_by)
    VALUES (session_id, 'OPENING_FUND', p_opening_fund, p_cash_account_id, operation_id,
            p_session_date, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, performed_by)
  VALUES ('sales_session', session_id::TEXT, 'OPEN',
          jsonb_build_object('session_date',p_session_date,'location',p_location,
                             'opening_fund',p_opening_fund), auth.uid())
END
```

The opening fund is a cash *transfer into the session*, not income. **Returns:** `{session_id, estado}`.

---

### 31. register_session_movement

**Signature:** `register_session_movement(p_session_id UUID, p_movement_type session_movement_type, p_producto_id UUID, p_cantidad DECIMAL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN **[ADR-009]** (the former OPERATOR permission is superseded) · **SECURITY DEFINER:** yes · **Period determinant:** session's `session_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'   -- [ADR-009] Feria is ADMIN-only in V1
  IF p_cantidad <= 0 RAISE 'INVALID_QUANTITY'

  session = SELECT * FROM sales_session WHERE id = p_session_id FOR UPDATE
  IF session NOT FOUND        RAISE 'SESSION_NOT_FOUND'
  IF session.estado <> 'OPEN' RAISE 'SESSION_CLOSED: reopen the session to add movements'

  ASSERT_PERIOD_OPEN(session.session_date)

  IF p_movement_type IN ('LOSS','ADJUSTMENT') AND (p_reason IS NULL OR length(trim(p_reason)) = 0)
    RAISE 'REASON_REQUIRED: losses and adjustments must be explained'

  movement_id = INSERT INTO sales_session_movement (sales_session_id, movement_type,
                producto_id, cantidad, reason, created_by)
                VALUES (p_session_id, p_movement_type, p_producto_id, p_cantidad,
                        p_reason, auth.uid())
                RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('sales_session_movement', movement_id::TEXT, 'CREATE',
          jsonb_build_object('session_id',p_session_id,'movement_type',p_movement_type,
                             'producto_id',p_producto_id,'cantidad',p_cantidad),
          p_reason, auth.uid())
END
```

Physical only: DISPATCH / RETURN / LOSS / ADJUSTMENT. No economic consequence — the sale is the Pedido.  
**Returns:** `{movement_id}`.

---

### 32. register_session_cash_event

**Signature:** `register_session_cash_event(p_session_id UUID, p_event_type session_cash_event_type, p_amount NUMERIC, p_financial_account_id UUID DEFAULT NULL, p_expense_category_id UUID DEFAULT NULL, p_destination_account_id UUID DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** session's `session_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_amount <= 0 RAISE 'INVALID_AMOUNT'

  session = SELECT * FROM sales_session WHERE id = p_session_id FOR UPDATE
  IF session NOT FOUND        RAISE 'SESSION_NOT_FOUND'
  IF session.estado <> 'OPEN' RAISE 'SESSION_CLOSED'

  event_date = session.session_date
  ASSERT_PERIOD_OPEN(event_date)

  IF p_event_type = 'EXPENSE' AND p_expense_category_id IS NULL
    RAISE 'CATEGORY_REQUIRED: a session expense needs an expense category'
  IF p_event_type IN ('EXPENSE','WITHDRAWAL','TRANSFER_OUT') AND p_financial_account_id IS NULL
    RAISE 'ACCOUNT_REQUIRED'
  IF p_event_type = 'TRANSFER_OUT' AND p_destination_account_id IS NULL
    RAISE 'DESTINATION_REQUIRED'

  operation_id = NULL

  IF p_event_type = 'COUNT':
    -- a physical cash count is an observation; it creates no posting
    operation_id = NULL

  ELSE:
    operation_id = INSERT INTO financial_operation (operation_type, effective_date,
                   source_entity_type, source_entity_id, reason, created_by)
                   VALUES ('SESSION_CASH', event_date, 'sales_session',
                           p_session_id::TEXT, p_reason, auth.uid())
                   RETURNING id

    INSERT INTO financial_posting (financial_operation_id, financial_account_id,
           signed_amount, effective_date, created_by)
    VALUES (operation_id, p_financial_account_id, -p_amount, event_date, auth.uid())

    IF p_event_type = 'TRANSFER_OUT':
      -- money moves to another account: both legs share one operation
      INSERT INTO financial_posting (financial_operation_id, financial_account_id,
             signed_amount, effective_date, created_by)
      VALUES (operation_id, p_destination_account_id, p_amount, event_date, auth.uid())

  event_id = INSERT INTO sales_session_cash_event (sales_session_id, event_type, amount,
             financial_account_id, expense_category_id, financial_operation_id,
             event_date, reason, created_by)
             VALUES (p_session_id, p_event_type, p_amount, p_financial_account_id,
                     p_expense_category_id, operation_id, event_date, p_reason, auth.uid())
             RETURNING id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('sales_session_cash_event', event_id::TEXT, 'CREATE',
          jsonb_build_object('session_id',p_session_id,'event_type',p_event_type,
                             'amount',p_amount), p_reason, auth.uid())
END
```

WITHDRAWAL is a distribution, not an expense — P&L treats it below the operating result (frozen Part 19).  
**Returns:** `{event_id, financial_operation_id}`.

---

### 33. close_sales_session

**Signature:** `close_sales_session(p_session_id UUID, p_aggregated_lines JSONB, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** session's `session_date`

Closing creates the single aggregated Consumidor Final Pedido and delivers it. Individual anonymous sales are never recorded. `p_aggregated_lines` is `[{producto_id, cantidad, precio_unitario}]`; several lines for the same product are allowed when different prices were charged.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'

  session = SELECT * FROM sales_session WHERE id = p_session_id FOR UPDATE
  IF session NOT FOUND        RAISE 'SESSION_NOT_FOUND'
  IF session.estado <> 'OPEN' RAISE 'SESSION_ALREADY_CLOSED'

  ASSERT_PERIOD_OPEN(session.session_date)

  aggregated_pedido_id = NULL

  IF jsonb_array_length(p_aggregated_lines) > 0:
    cf_client_id = SELECT id FROM clients WHERE nombre = 'CONSUMIDOR FINAL' AND activo = true
    IF cf_client_id IS NULL
      RAISE 'CONSUMIDOR_FINAL_MISSING: the aggregated retail client master is not configured'

    aggregated_pedido_id = INSERT INTO pedidos (cliente_id, estado, sales_session_id,
                           is_aggregated_retail, created_by, updated_by)
                           VALUES (cf_client_id, 'PENDING', p_session_id, true,
                                   auth.uid(), auth.uid())
                           RETURNING id

    FOR EACH line IN p_aggregated_lines:
      INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario,
             producto_nombre, version_seq, is_current, created_by)
      VALUES (aggregated_pedido_id, line.producto_id, line.cantidad, line.precio_unitario,
              (SELECT nombre FROM products WHERE id = line.producto_id), 0, true, auth.uid())

    -- the retail sale becomes economic through the normal delivery path
    CALL deliver_order(aggregated_pedido_id,
                       (session.session_date + TIME '23:59')
                         AT TIME ZONE 'America/Argentina/Buenos_Aires',
                       'Feria aggregated retail sale')

  UPDATE sales_session SET estado='CLOSED', closed_at=NOW(), closed_by=auth.uid(),
         aggregated_pedido_id=aggregated_pedido_id
   WHERE id = p_session_id

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('sales_session', p_session_id::TEXT, 'CLOSE',
          jsonb_build_object('estado','OPEN'),
          jsonb_build_object('estado','CLOSED','aggregated_pedido_id',aggregated_pedido_id),
          p_reason, auth.uid())
END
```

**Reconciliation:** cash is reconciled by comparing `sales_session_cash_event` COUNT observations with the session's postings; MP is reconciled through `mp_reconcile_movement`; CC sales are the identified clients' own Pedidos. Variances surface as explicit adjustments — no correspondence is invented.  
**Idempotency:** state guard (`SESSION_ALREADY_CLOSED`). **Returns:** `{session_id, estado, aggregated_pedido_id, aggregated_total}`.

---

## FISCAL

### 34. register_fiscal_document

**Signature:** `register_fiscal_document(p_document_type fiscal_document_type, p_direction fiscal_direction, p_document_date DATE, p_fiscal_period DATE, p_net_amount NUMERIC, p_total_amount NUMERIC, p_components JSONB, p_supplier_id UUID DEFAULT NULL, p_cliente_id UUID DEFAULT NULL, p_external_number VARCHAR DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `fiscal_document.document_date` (and `fiscal_period` for tax reporting)

`p_components` is `[{tax_kind, direction, base_amount, rate_applied, tax_amount}]`. Rates are supplied per document and stored as snapshots; no rate is ever read from code.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_direction = 'CREDITO' AND p_supplier_id IS NULL RAISE 'SUPPLIER_REQUIRED'
  IF p_direction = 'DEBITO'  AND p_cliente_id  IS NULL RAISE 'CLIENT_REQUIRED'
  IF p_fiscal_period <> date_trunc('month', p_fiscal_period)::DATE
    RAISE 'INVALID_FISCAL_PERIOD: must be the first day of a month'

  ASSERT_PERIOD_OPEN(p_document_date)

  IF p_supplier_id IS NOT NULL AND p_external_number IS NOT NULL
     AND EXISTS (SELECT 1 FROM fiscal_document
                 WHERE supplier_id = p_supplier_id AND external_number = p_external_number)
    RAISE 'DUPLICATE_FISCAL_DOCUMENT'

  document_id = INSERT INTO fiscal_document (document_type, direction, document_date,
                fiscal_period, supplier_id, cliente_id, external_number, net_amount,
                total_amount, created_by)
                VALUES (p_document_type, p_direction, p_document_date, p_fiscal_period,
                        p_supplier_id, p_cliente_id, p_external_number, p_net_amount,
                        p_total_amount, auth.uid())
                RETURNING id

  FOR EACH comp IN p_components:
    INSERT INTO fiscal_document_component (fiscal_document_id, tax_kind, direction,
           base_amount, rate_applied, tax_amount)
    VALUES (document_id, comp.tax_kind, comp.direction, comp.base_amount,
            comp.rate_applied, comp.tax_amount)

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('fiscal_document', document_id::TEXT, 'CREATE',
          jsonb_build_object('document_type',p_document_type,'direction',p_direction,
                             'fiscal_period',p_fiscal_period,'total_amount',p_total_amount),
          p_reason, auth.uid())
END
```

**No economic duplication:** this creates no supplier_ledger row and no posting. The economic obligation lives in `purchases` / `pedidos`, which merely reference `fiscal_document_id`.  
**Returns:** `{fiscal_document_id, component_count}`.

---

### 35. register_fiscal_obligation

**Signature:** `register_fiscal_obligation(p_tax_kind tax_kind, p_fiscal_period DATE, p_amount NUMERIC, p_due_date DATE DEFAULT NULL, p_installments JSONB DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `fiscal_obligation.fiscal_period`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_amount <= 0 RAISE 'INVALID_AMOUNT'
  IF p_fiscal_period <> date_trunc('month', p_fiscal_period)::DATE
    RAISE 'INVALID_FISCAL_PERIOD'
  IF EXISTS (SELECT 1 FROM fiscal_obligation
             WHERE tax_kind = p_tax_kind AND fiscal_period = p_fiscal_period)
    RAISE 'DUPLICATE_OBLIGATION'

  ASSERT_PERIOD_OPEN(p_fiscal_period)

  obligation_id = INSERT INTO fiscal_obligation (tax_kind, fiscal_period, amount, due_date,
                  status, created_by)
                  VALUES (p_tax_kind, p_fiscal_period, p_amount, p_due_date, 'PENDING',
                          auth.uid())
                  RETURNING id

  IF p_installments IS NOT NULL:
    installment_sum = 0
    FOR EACH inst IN p_installments:
      INSERT INTO fiscal_obligation_installment (fiscal_obligation_id, installment_number,
             amount, due_date)
      VALUES (obligation_id, inst.installment_number, inst.amount, inst.due_date)
      installment_sum = installment_sum + inst.amount
    IF installment_sum <> p_amount
      RAISE 'INSTALLMENT_MISMATCH: installments total % but obligation is %',
            installment_sum, p_amount

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('fiscal_obligation', obligation_id::TEXT, 'CREATE',
          jsonb_build_object('tax_kind',p_tax_kind,'fiscal_period',p_fiscal_period,
                             'amount',p_amount), p_reason, auth.uid())
END
```

**Returns:** `{obligation_id, installment_count}`.

---

### 36. pay_fiscal_obligation

**Signature:** `pay_fiscal_obligation(p_obligation_id UUID, p_effective_date DATE, p_amount NUMERIC, p_financial_account_id UUID, p_idempotency_key VARCHAR, p_installment_id UUID DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `fiscal_payment.effective_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_amount <= 0 RAISE 'INVALID_AMOUNT'
  IF EXISTS (SELECT 1 FROM fiscal_payment WHERE idempotency_key = p_idempotency_key)
    RAISE 'DUPLICATE_PAYMENT'

  ob = SELECT * FROM fiscal_obligation WHERE id = p_obligation_id FOR UPDATE
  IF ob NOT FOUND          RAISE 'OBLIGATION_NOT_FOUND'
  IF ob.status = 'PAID'    RAISE 'ALREADY_PAID'
  IF ob.status = 'CANCELLED' RAISE 'OBLIGATION_CANCELLED'

  ASSERT_PERIOD_OPEN(p_effective_date)

  paid_so_far = SELECT COALESCE(SUM(amount),0) FROM fiscal_payment
                WHERE fiscal_obligation_id = p_obligation_id
  IF paid_so_far + p_amount > ob.amount
    RAISE 'OVERPAYMENT: paying % exceeds the outstanding balance', p_amount

  operation_id = INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                 source_entity_type, source_entity_id, reason, created_by)
                 VALUES ('FISCAL_PAYMENT', p_effective_date, p_idempotency_key,
                         'fiscal_obligation', p_obligation_id::TEXT, p_reason, auth.uid())
                 RETURNING id

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (operation_id, p_financial_account_id, -p_amount, p_effective_date, auth.uid())

  payment_id = INSERT INTO fiscal_payment (fiscal_obligation_id, installment_id,
               effective_date, amount, financial_account_id, financial_operation_id,
               idempotency_key, created_by)
               VALUES (p_obligation_id, p_installment_id, p_effective_date, p_amount,
                       p_financial_account_id, operation_id, p_idempotency_key, auth.uid())
               RETURNING id

  new_status = CASE WHEN paid_so_far + p_amount = ob.amount THEN 'PAID'
                    ELSE 'PARTIALLY_PAID' END
  UPDATE fiscal_obligation SET status = new_status WHERE id = p_obligation_id

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('fiscal_obligation', p_obligation_id::TEXT, 'PAY',
          jsonb_build_object('status',ob.status,'paid_so_far',paid_so_far),
          jsonb_build_object('status',new_status,'payment',p_amount), p_reason, auth.uid())
END
```

**financial:** `-amount` posting. **Idempotency:** `fiscal_payment.idempotency_key` UNIQUE.  
**Returns:** `{payment_id, financial_operation_id, obligation_status}`.

---

## MANAGEMENT PERIODS

### 37. close_management_period

**Signature:** `close_management_period(p_period_id BIGINT, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Sole writer of `management_period.status` → CLOSED**

Closure is integral: it freezes commercial, economic, financial, productive, cost and fiscal facts of that month, because every period-sensitive RPC consults this row.

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'

  period = SELECT * FROM management_period WHERE id = p_period_id FOR UPDATE
  IF period NOT FOUND          RAISE 'PERIOD_NOT_FOUND'
  IF period.status = 'CLOSED'  RAISE 'ALREADY_CLOSED'

  -- non-blocking integrity signal, reported but never auto-corrected
  pending_orders = SELECT COUNT(*) FROM pedidos
                   WHERE estado = 'PENDING'
                     AND created_at >= period.periodo_fecha
                     AND created_at <  period.periodo_fecha + INTERVAL '1 month'

  UPDATE management_period SET status='CLOSED', closed_at=NOW(), closed_by=auth.uid()
   WHERE id = p_period_id

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('management_period', p_period_id::TEXT, 'CLOSE',
          jsonb_build_object('status','OPEN'),
          jsonb_build_object('status','CLOSED','periodo_fecha',period.periodo_fecha,
                             'pending_orders',pending_orders), p_reason, auth.uid())
END
```

The pending-order count uses `created_at` **only as an informational signal**; it never determines any period. **Returns:** `{period_id, periodo_fecha, status, pending_orders_warning}`.

---

### 38. reopen_management_period

**Signature:** `reopen_management_period(p_period_id BIGINT, p_reason TEXT) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · `p_reason` is **mandatory**

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_reason IS NULL OR length(trim(p_reason)) = 0
    RAISE 'REASON_REQUIRED: reopening a closed period must be justified'

  period = SELECT * FROM management_period WHERE id = p_period_id FOR UPDATE
  IF period NOT FOUND        RAISE 'PERIOD_NOT_FOUND'
  IF period.status = 'OPEN'  RAISE 'ALREADY_OPEN'

  UPDATE management_period SET status='OPEN', closed_at=NULL, closed_by=NULL
   WHERE id = p_period_id

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('management_period', p_period_id::TEXT, 'REOPEN',
          jsonb_build_object('status','CLOSED','closed_at',period.closed_at,
                             'closed_by',period.closed_by),
          jsonb_build_object('status','OPEN'), p_reason, auth.uid())
END
```

The prior closure (who closed it and when) is preserved in `before_values`. **Returns:** `{period_id, periodo_fecha, status}`.

---

## TREASURY

### 39. transfer_between_accounts

**Signature:** `transfer_between_accounts(p_source_account_id UUID, p_dest_account_id UUID, p_amount NUMERIC, p_effective_date DATE, p_external_ref VARCHAR, p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `financial_posting.effective_date`

```
BEGIN
  IF current_app_role() <> 'ADMIN' RAISE 'FORBIDDEN: ADMIN required'
  IF p_amount <= 0 RAISE 'INVALID_AMOUNT'
  IF p_source_account_id = p_dest_account_id RAISE 'SAME_ACCOUNT'
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_source_account_id AND activo = true)
    RAISE 'SOURCE_ACCOUNT_NOT_FOUND_OR_INACTIVE'
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_dest_account_id AND activo = true)
    RAISE 'DEST_ACCOUNT_NOT_FOUND_OR_INACTIVE'
  IF EXISTS (SELECT 1 FROM financial_operation WHERE external_ref = p_external_ref)
    RAISE 'DUPLICATE_TRANSFER'

  ASSERT_PERIOD_OPEN(p_effective_date)

  operation_id = INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                 reason, created_by)
                 VALUES ('TRANSFER', p_effective_date, p_external_ref, p_reason, auth.uid())
                 RETURNING id

  -- exactly two postings, opposite signs, one shared operation: both or neither
  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (operation_id, p_source_account_id, -p_amount, p_effective_date, auth.uid())

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (operation_id, p_dest_account_id, p_amount, p_effective_date, auth.uid())

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('financial_operation', operation_id::TEXT, 'TRANSFER',
          jsonb_build_object('source',p_source_account_id,'dest',p_dest_account_id,
                             'amount',p_amount,'effective_date',p_effective_date),
          p_reason, auth.uid())
END
```

A transfer never affects results (frozen Part 19). Fees are a separate `FEE` operation, never netted into the transfer.  
**Idempotency:** `external_ref` UNIQUE. **Returns:** `{financial_operation_id, posting_ids}`.

---

## MERCADO PAGO

### 40. mp_normalize_source

**Signature:** `mp_normalize_source(p_source_record_id UUID) RETURNS JSONB`  
**Actor:** SERVICE_ROLE (backend) · **SECURITY DEFINER:** yes · **Grant:** `service_role` only  
**Period determinant:** `mp_source_record.occurred_date` (MP's own date), carried to the movement

```
BEGIN
  IF auth.role() <> 'service_role'
    RAISE 'FORBIDDEN: backend service role required'

  src = SELECT * FROM mp_source_record WHERE id = p_source_record_id FOR UPDATE
  IF src NOT FOUND RAISE 'SOURCE_NOT_FOUND'
  IF src.processing_status <> 'PENDING'
    RAISE 'ALREADY_PROCESSED: status is %', src.processing_status

  -- raw columns are never touched here; the raw-guard trigger would reject any attempt
  components = parse_mp_payload(src.event_data)   -- gross / fee / tax / net per movement_kind

  FOR EACH c IN components:
    INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount,
           fee_amount, tax_amount, net_amount, occurred_date)
    VALUES (p_source_record_id, c.movement_kind, c.gross_amount, c.fee_amount,
            c.tax_amount, c.net_amount, src.occurred_date)
    ON CONFLICT (mp_source_record_id, movement_kind) DO NOTHING

  -- ONLY processing metadata is updated
  UPDATE mp_source_record SET processing_status='NORMALIZED', processed_at=NOW()
   WHERE id = p_source_record_id

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         performed_by)
  VALUES ('mp_source_record', p_source_record_id::TEXT, 'NORMALIZE',
          jsonb_build_object('processing_status','PENDING'),
          jsonb_build_object('processing_status','NORMALIZED',
                             'movements',jsonb_array_length(components)), NULL)
END
```

**Immutability boundary honoured:** raw fields (`event_data`, `occurred_at`, `occurred_date`,
`external_id`, `source_type`, `ingested_at`) are read-only; only
`processing_status`, `processed_at`, `processing_note` change, and only through this privileged path.  
**Idempotency:** status guard + `UNIQUE(mp_source_record_id, movement_kind)`.  
**Returns:** `{source_record_id, processing_status, movements_created}`.

---

### 41. mp_reconcile_movement

**Signature:** `mp_reconcile_movement(p_movement_id BIGINT, p_financial_account_id UUID, p_assigned_amount NUMERIC, p_operation_type financial_operation_type DEFAULT 'MP_SETTLEMENT', p_reason TEXT DEFAULT NULL) RETURNS JSONB`  
**Actor:** SERVICE_ROLE or ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `mp_financial_movement.occurred_date`

Bridges a normalized external movement to internal postings. N:N and amount-assigned.

```
BEGIN
  IF auth.role() <> 'service_role' AND current_app_role() <> 'ADMIN'
    RAISE 'FORBIDDEN: ADMIN or backend service role required'
  IF p_assigned_amount = 0 RAISE 'INVALID_AMOUNT'

  mv = SELECT * FROM mp_financial_movement WHERE id = p_movement_id FOR UPDATE
  IF mv NOT FOUND RAISE 'MOVEMENT_NOT_FOUND'

  -- the reconciliation timestamp never changes the original fact's period
  ASSERT_PERIOD_OPEN(mv.occurred_date)

  already = SELECT COALESCE(SUM(assigned_amount),0) FROM mp_reconciliation
            WHERE mp_financial_movement_id = p_movement_id
  IF abs(already + p_assigned_amount) > abs(mv.net_amount)
    RAISE 'OVER_ASSIGNMENT: assigning % exceeds movement net % (already %)',
          p_assigned_amount, mv.net_amount, already

  operation_id = INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                 source_entity_type, source_entity_id, reason, created_by)
                 VALUES (p_operation_type, mv.occurred_date,
                         'MP:' || p_movement_id::TEXT || ':' || (already + p_assigned_amount)::TEXT,
                         'mp_financial_movement', p_movement_id::TEXT, p_reason, auth.uid())
                 RETURNING id

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (operation_id, p_financial_account_id, p_assigned_amount, mv.occurred_date, auth.uid())

  reconciliation_id = INSERT INTO mp_reconciliation (mp_financial_movement_id,
                      financial_operation_id, assigned_amount, reconciled_by)
                      VALUES (p_movement_id, operation_id, p_assigned_amount, auth.uid())
                      RETURNING id

  UPDATE mp_source_record SET processing_status='RECONCILED', processed_at=NOW()
   WHERE id = mv.mp_source_record_id

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_reconciliation', reconciliation_id::TEXT, 'RECONCILE',
          jsonb_build_object('movement_id',p_movement_id,'assigned_amount',p_assigned_amount,
                             'financial_operation_id',operation_id), p_reason, auth.uid())
END
```

A movement may legitimately remain unreconciled — no correspondence is invented, and there is no artificial MP deadline.  
**Idempotency:** `UNIQUE(mp_financial_movement_id, financial_operation_id)` + `OVER_ASSIGNMENT` cap.  
**Returns:** `{reconciliation_id, financial_operation_id, remaining_unassigned}`.

---

### 46. register_bank_tax **[ADR-011]**

**Signature:** `register_bank_tax(p_account_id UUID, p_amount NUMERIC, p_effective_date DATE, p_tax_kind tax_kind, p_external_ref VARCHAR, p_related_operation_id BIGINT DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** effective_date
**Validation:**
- `FORBIDDEN`;
- `INVALID_AMOUNT` (the amount must be > 0 with at most 2 decimals);
- `INVALID_DATE`;
- `INVALID_TAX_KIND` (only DEBITOS_CREDITOS);
- `EXTERNAL_REF_REQUIRED`;
- idempotency by external_ref: an exact replay returns the original with `replayed: true`; any other use → `DUPLICATE_BANK_TAX`;
- `ACCOUNT_NOT_FOUND_OR_INACTIVE`;
- `MP_ACCOUNT_NOT_ALLOWED` (the Mercado Pago account; its account_tax stays V-3);
- `RELATED_TRANSFER_NOT_FOUND` (when given, the related operation must be a TRANSFER);
- `ASSERT_PERIOD_OPEN(effective_date)`.

**Atomic steps:**
- one financial_operation BANK_TAX (source_entity = the related transfer, if any);
- ONE financial_posting `−amount` on the account;
- one bank_tax_charge row (tax_kind, account, amount, FK related_operation_id);
- one audit_events row `BANK_TAX`.

**Consequences:** the account balance decreases. **No P&L effect** (fail-closed). transfer_between_accounts is unchanged; the transfer and the tax are two calls, and the UI reports a partial success.
**Errors:** `FORBIDDEN`, `INVALID_AMOUNT`, `INVALID_DATE`, `INVALID_TAX_KIND`, `EXTERNAL_REF_REQUIRED`, `DUPLICATE_BANK_TAX`, `ACCOUNT_NOT_FOUND_OR_INACTIVE`, `MP_ACCOUNT_NOT_ALLOWED`, `RELATED_TRANSFER_NOT_FOUND`, `PERIOD_NOT_FOUND`, `PERIOD_CLOSED`.
**Returns:** `{financial_operation_id, posting_id, replayed}`.

### 47. rectify_classification **[ADR-012]**

**Signature:** `rectify_classification(p_idempotency_key UUID, p_classification_id UUID, p_lines JSONB, p_reason TEXT) RETURNS JSONB`
**Actor:** ADMIN (any current session) or OPERATOR (a current session it created) · **SECURITY DEFINER:** yes · **Period determinant:** the session's `classification_date`
**Validation:** `REASON_REQUIRED` · `EMPTY_LINE_SET` · `DUPLICATE_CLASSIFICATION` (idempotency key) · `CLASSIFICATION_NOT_FOUND` (missing, or not the OPERATOR's) · `CLASSIFICATION_SUPERSEDED` (not current) · `ASSERT_PERIOD_OPEN` · line validation and conversion as RPC 25.
**Atomic steps:** lock the session; mark it `is_current = false`; insert the new version (same date and location, `version_seq + 1`, `supersedes_id`, `rectification_reason`); insert its lines; audit `RECTIFY` (before / after totals, reason).
**Consequences:** the prior version stays unchanged and readable; `report_classification_day` counts current versions only.
**Returns:** `{classification_id, superseded_id, version_seq, total_quantity}`.

### 48. publish_feed_formula_version **[ADR-013]**

**Signature:** `publish_feed_formula_version(p_feed_type_id UUID, p_effective_from DATE, p_lines JSONB, p_reason TEXT DEFAULT NULL) RETURNS JSONB`
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** none (master data; manufacturing carries the period)
**Validation:** `FORBIDDEN` · `INVALID_DATE` · `FEED_TYPE_NOT_FOUND_OR_INACTIVE` · `EMPTY_LINE_SET` · `INGREDIENT_NOT_FOUND` (missing or inactive) · `DUPLICATE_INGREDIENT` · `INVALID_QUANTITY` (kg > 0, ≤ 3 decimals) · `INVALID_COST` · `FORMULA_VERSION_DATE_CONFLICT` (a version already starts on or after D) · `FORMULA_VERSION_USED_AFTER_DATE` (the version to close is manufactured on or after D).
**Atomic steps:** lock the feed type; close the open prior version at D − 1; insert version `max + 1` from D (open); insert every line; audit `PUBLISH`.
**Returns:** `{formula_version_id, version, line_count, closed_version_id}`.

### 49. rectify_feed_manufacturing **[ADR-014]**

**Signature:** `rectify_feed_manufacturing(p_idempotency_key VARCHAR, p_manufacturing_id UUID, p_quantity_kg DECIMAL, p_reason TEXT, p_batch_number VARCHAR DEFAULT NULL, p_formula_version_id UUID DEFAULT NULL) RETURNS JSONB`
**Actor:** ADMIN (any current record) or OPERATOR (a current record of a chain it started) · **SECURITY DEFINER:** yes · **Period determinant:** the record's `manufacturing_date` (kept)
**Validation:** `REASON_REQUIRED` · `INVALID_QUANTITY` · `EXTERNAL_REF_REQUIRED` · `DUPLICATE_MANUFACTURING` (idempotency key) · `MANUFACTURING_NOT_FOUND` (missing, or not the OPERATOR's chain) · `MANUFACTURING_SUPERSEDED` · `FORMULA_VERSION_NOT_FOUND` / `FORMULA_VERSION_NOT_EFFECTIVE` / `FORMULA_VERSION_EMPTY` (version = given or kept) · `ASSERT_PERIOD_OPEN`.
**Atomic steps:** lock the record; mark it `is_current = false`; insert the new version (same date, `version_seq + 1`, `supersedes_id`, `rectification_reason`, batch given or kept); audit `RECTIFY` (before / after quantity and version, reason).
**Consequences:** the original stays unchanged; `report_feed_consumption_interval` counts current versions only; no stock movement is generated (stock is the physical count).
**Returns:** `{manufacturing_id, superseded_id, version_seq, quantity_kg}`.

### 50. register_purchase_with_fiscal_document **[ADR-015]**

**Signature:** `register_purchase_with_fiscal_document(p_supplier_id UUID, p_economic_date DATE, p_amount_net NUMERIC, p_amount_total NUMERIC, p_expense_category_id UUID, p_nature purchase_nature, p_lines JSONB, p_attachments JSONB, p_idempotency_key VARCHAR, p_fiscal_document_type fiscal_document_type, p_fiscal_period DATE, p_fiscal_net_amount NUMERIC, p_fiscal_total_amount NUMERIC, p_fiscal_components JSONB, p_subcategory VARCHAR DEFAULT NULL, p_project_id UUID DEFAULT NULL, p_supplier_invoice_number VARCHAR DEFAULT NULL, p_flock_id UUID DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`
**Actor:** ADMIN · **SECURITY DEFINER:** yes · **Period determinant:** `economic_date` (= the document date)
**Validation:** `FORBIDDEN` · `INVALID_DOCUMENT_TYPE` (CREDIT_NOTE / DEBIT_NOTE) · `INVALID_AMOUNT` · `INVALID_COMPONENTS` (array; tax_kind, base_amount, rate_applied, tax_amount required; direction defaults to CREDITO), then every rule of RPC 34 and RPC 13.
**Atomic steps:** RPC 34 `register_fiscal_document` (CREDITO, the purchase supplier, document date = economic date, number = supplier invoice number); RPC 13 `register_purchase` with the new `fiscal_document_id`. One transaction: an error in either rolls back both. Amounts stored as typed; nothing derived.
**Returns:** RPC 13's result plus `{fiscal_document_id, component_count}`.

## RPC INVENTORY (EXACT)

| # | RPC | Domain | Actor | SEC.DEF | Period determinant |
|---|---|---|---|---|---|
| 1 | deliver_order | Commercial | ADMIN | yes | pedidos.delivered_date |
| 2 | rectify_delivered_order | Commercial | ADMIN | yes | pedidos.delivered_date (original) |
| 3 | cancel_order | Commercial | ADMIN | yes | none (no economic fact) |
| 4 | register_collection | Collections | ADMIN | yes | collections.effective_date |
| 5 | receive_cheque | Received instr. | ADMIN | yes | received_date |
| 6 | deposit_cheque | Received instr. | ADMIN | yes | deposited_date |
| 7 | clear_cheque | Received instr. | ADMIN | yes | cleared_date |
| 8 | endorse_cheque | Received instr. | ADMIN | yes | endorsed_date |
| 9 | reject_cheque | Received instr. | ADMIN | yes | rejected_date |
| 10 | issue_supplier_instrument | Issued instr. | ADMIN | yes | issued_date |
| 11 | mark_supplier_instrument_debited | Issued instr. | ADMIN | yes | debited_date |
| 12 | reject_supplier_instrument | Issued instr. | ADMIN | yes | rejected_date |
| 13 | register_purchase | Purchases | ADMIN | yes | purchases.economic_date |
| 14 | rectify_purchase | Purchases | ADMIN | yes | economic_date (original) |
| 15 | pay_supplier | Suppliers | ADMIN | yes | supplier_ledger.effective_date |
| 16 | register_freight | Freight | ADMIN | yes | freight.economic_date |
| 17 | assign_freight_to_purchase | Freight | ADMIN | yes | freight.economic_date |
| 18 | register_daily_production | Production | OPERATOR/ADMIN | yes | production_date |
| 19 | rectify_daily_production | Production | OPERATOR (own) / ADMIN | yes | production_date (original) |
| 20 | register_mortality | Production | OPERATOR/ADMIN | yes | event_date |
| 21 | rectify_mortality | Production | ADMIN | yes | event_date (original) |
| 22 | register_count_adjustment | Production | OPERATOR/ADMIN | yes | event_date |
| 23 | register_flock_weighing | Production | OPERATOR/ADMIN | yes | weighing_date |
| 24 | register_temperature_record | Production | OPERATOR/ADMIN | yes | record_date |
| 25 | register_classification | Classification | OPERATOR/ADMIN | yes | classification_date |
| 26 | register_feed_manufacturing | Feed | OPERATOR/ADMIN | yes | manufacturing_date |
| 27 | register_feed_inventory_count | Feed | OPERATOR/ADMIN | yes | count_date |
| 28 | register_feed_movement | Feed | ADMIN | yes | movement_date |
| 29 | assign_flock_feed | Feed | ADMIN | yes | none (master assignment) |
| 30 | open_sales_session | Feria | ADMIN | yes | session_date |
| 31 | register_session_movement | Feria | ADMIN **[ADR-009]** | yes | session_date |
| 32 | register_session_cash_event | Feria | ADMIN | yes | session_date |
| 33 | close_sales_session | Feria | ADMIN | yes | session_date |
| 34 | register_fiscal_document | Fiscal | ADMIN | yes | document_date / fiscal_period |
| 35 | register_fiscal_obligation | Fiscal | ADMIN | yes | fiscal_period |
| 36 | pay_fiscal_obligation | Fiscal | ADMIN | yes | fiscal_payment.effective_date |
| 37 | close_management_period | Periods | ADMIN | yes | n/a (controls periods) |
| 38 | reopen_management_period | Periods | ADMIN | yes | n/a (controls periods) |
| 39 | transfer_between_accounts | Treasury | ADMIN | yes | effective_date |
| 40 | mp_normalize_source | MP | SERVICE_ROLE | yes | occurred_date |
| 41 | mp_reconcile_movement | MP | SERVICE_ROLE/ADMIN | yes | occurred_date |
| 42 | cancel_supplier_instrument **[ADR-001]** | Issued instr. | ADMIN | yes | cancelled_date |
| 43 | register_management_event **[ADR-004]** (contract: ADR-004 D9) | P&L | ADMIN | yes | event_date |
| 44 | register_flock **[ADR-007]** | Production | ADMIN | yes | entry_date |
| 45 | close_flock **[ADR-007]** | Production | ADMIN | yes | exit_date |
| 46 | register_bank_tax **[ADR-011]** | Treasury | ADMIN | yes | effective_date |
| 47 | rectify_classification **[ADR-012]** | Classification | OPERATOR or ADMIN | yes | classification_date (original) |
| 48 | publish_feed_formula_version **[ADR-013]** | Feed | ADMIN | yes | none (master data) |
| 49 | rectify_feed_manufacturing **[ADR-014]** | Feed | OPERATOR or ADMIN | yes | manufacturing_date (original) |
| 50 | register_purchase_with_fiscal_document **[ADR-015]** | Purchases / Fiscal | ADMIN | yes | economic_date |

**TOTAL: 50 RPCs** **[ADR-001]** (41 + RPC 42) · RPC 43 by ADR-004 · **[ADR-007]** (+ RPCs 44 / 45) · **[ADR-011]** (+ RPC 46) · **[ADR-012]** (+ RPC 47) · **[ADR-013]** (+ RPC 48) · **[ADR-014]** (+ RPC 49) · **[ADR-015]** (+ RPC 50). 45 are period-sensitive and call `ASSERT_PERIOD_OPEN`. Five are not (the four below, and `publish_feed_formula_version` (48), which writes master data):
`cancel_order` (3) and `assign_flock_feed` (29) create no economic fact, and
`close_management_period` (37) / `reopen_management_period` (38) control periods themselves.

No stub, no TBD, no "etc." Every contract above states signature, actor, authorization,
SECURITY DEFINER status, validation, locks, period determinant, atomic steps, ledger/instrument/audit
consequences, idempotency, errors and return type.

---

**STATUS: FROZEN — 50 TRANSACTIONAL CONTRACTS SPECIFIED** (RPC 42 by ADR-001; RPC 43 by ADR-004 D9; RPCs 44 / 45 by ADR-007; RPC 46 by ADR-011; RPC 47 by ADR-012; RPC 48 by ADR-013; RPC 49 by ADR-014; RPC 50 by ADR-015)
