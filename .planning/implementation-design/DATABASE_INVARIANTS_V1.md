# DATABASE INVARIANTS V1

**STATUS:** Implementation-ready; consolidated from Agents A, D (Schema/Temporal)  
**DATE:** 2026-09-24  
**PURPOSE:** Central registry of invariants that the database must guarantee at all times

---

## CRITICAL INVARIANTS (20 TOTAL)

### 1. One ACTIVE Flock Per Shed

**Invariant:** At most one flock per shed has estado='ACTIVE'

**Enforced by:** `UNIQUE(shed_id) WHERE estado='ACTIVE'` on flocks table

**Verification:** Before inserting/updating flock to ACTIVE, check no other ACTIVE exists for shed_id

**Consequence of violation:** Data corruption; production records ambiguous

---

### 2. Max ONE MORTALITY Per (Flock, Date)

**Invariant:** Only one MORTALITY event per (flock_id, event_date) has is_current=true

**Enforced by:** `CREATE UNIQUE INDEX idx_population_events_mortality ON population_events(flock_id, event_date) WHERE event_type='MORTALITY' AND is_current=true` (partial unique index)

**Multiple COUNT_ADJUSTMENT events allowed:** UNIQUE constraint applies to MORTALITY type only

**Rectification:** Insert new event with is_current=true; update original superseded_by via SECURITY DEFINER function (APPEND_ONLY at RLS; metadata-only UPDATE via privileged function)

**Verification:** Queries use `WHERE event_type='MORTALITY' AND is_current=true`

---

### 3. Order Subtotal = Quantity × Unit Price

**Invariant:** pedido_lineas.subtotal = cantidad * precio_unitario (always)

**Enforced by:** `GENERATED ALWAYS AS (cantidad * precio_unitario) STORED`

**Immutability:** Once generated, subtotal cannot be changed (DB-computed)

**Consequence of violation:** Order total would be wrong; ledger amounts incorrect

---

### 4. Delivered Order Is Immutable

**Invariant:** Once pedidos.estado='DELIVERED', no field in that order row can be modified

**Enforced by:** RLS policy `UPDATE ... WHERE estado != 'DELIVERED'` (allows UPDATE only while PENDING)

**Rectification:** Via rectify_delivered_order RPC (creates reversal + new entries, never modifies original)

**Consequence of violation:** Delivery ledger would be out of sync; audit trail broken

---

### 5. Client Balance = SUM(client_ledger)

**Invariant:** Client debt = sum of all client_ledger entries for that cliente_id (no stored balance)

**Enforced by:** NO balance column in clients table; computed in queries

**Consequence of violation:** Stored balance and actual sum diverge; invisible corruption

---

### 6. Account Balance = SUM(financial_posting)

**Invariant:** Financial account balance = sum of all financial_posting entries for that account (no stored balance)

**Enforced by:** NO balance column in financial_account table; computed in queries

**Consequence of violation:** Hidden discrepancy between stored and actual balance

---

### 7. Financial Posting Belongs to Operation

**Invariant:** Every financial_posting.financial_operation_id references an existing financial_operation row

**Enforced by:** FK constraint on financial_operation_id (NOT NULL + REFERENCES)

**Consequence of violation:** Orphaned posting; GL trace broken

---

### 8. Transfer Posts Exactly 2x (Opposite Signs)

**Invariant:** Every TRANSFER operation has exactly 2 postings (one debit, one credit) with opposite signs

**Enforced by:** RPC atomicity (both postings inserted together) + operation_id shared + RPC validation

**Consequence of violation:** Account balances diverge permanently; money vanishes or appears

---

### 9. Ledger Entry Is APPEND_ONLY

**Invariant:** No UPDATE or DELETE on: client_ledger, financial_posting, population_events, supplier_ledger, audit_events, feed_inventory_count

**Enforced by:** RLS policies `UPDATE USING FALSE; DELETE USING FALSE` on each table (business-level immutability)

**Exceptions:** 
- population_events: metadata fields (is_current, superseded_by) updatable ONLY via SECURITY DEFINER function with strict internal authorization (business fields delta/event_date/flock_id remain immutable)
- Rectification: creates new record (INSERT), never updates business fields

**Consequence of violation:** Audit trail destroyed; financial records rewriteable

---

### 10. Period OPEN Determines Editability

**Invariant:** No INSERT/UPDATE with effective_date in a CLOSED period (unless period reopened by ADMIN)

**Enforced by:** RPC validation before INSERT/UPDATE (SELECT period FOR UPDATE; IF status='CLOSED' RAISE ERROR)

**Consequence of violation:** Facts post silently to closed periods; period integrity broken

---

### 11. Fact's Period = effective_date, NOT created_at

**Invariant:** Period determination is ALWAYS via effective_date (or delivered_at, event_date, economic_date per entity), NEVER created_at

**Enforced by:** RPC uses effective_date for period lookup; schema design ensures effective_date exists; created_at is metadata only

**Consequence of violation:** Period closure could be bypassed; facts post to wrong periods

---

### 12. Cheque State Transitions Valid

**Invariant:** financial_instrument.estado transitions only via allowed paths:
- RECEIVED → DEPOSITED, ENDORSED, or REJECTED
- DEPOSITED → CLEARED or REJECTED
- CLEARED → REJECTED (if bounced post-clearing)
- ENDORSED → (terminal state)

**Enforced by:** RPC validation (SELECT FOR UPDATE; IF estado NOT IN allowed RAISE ERROR)

**Consequence of violation:** Cheque lifecycle corrupted; payment status ambiguous

---

### 13. Order Price Snapshot IMMUTABLE

**Invariant:** pedido_lineas.precio_unitario and producto_nombre are snapshots captured at order creation; never change

**Enforced by:** RLS policy on pedido_lineas parent (UPDATE forbidden); GENERATED ALWAYS on subtotal depends on immutable price

**Consequence of violation:** Historical pricing lost; order totals become meaningless

---

### 14. No Fictitious Classification Traceability

**Invariant:** classification table has NO flock_id field (eggs are mixed before classification; no fictitious assignment)

**Enforced by:** Schema design (no flock_id column)

**Consequence of violation:** Invented data; cost allocation to wrong flocks

---

### 15. No Stored Daily Feed Consumption Per Flock

**Invariant:** No daily_feed_consumption_per_flock table exists; feed consumption is CALCULATED via stock equation only

**Enforced by:** Schema design (table does not exist)

**Consequence of violation:** Fictitious precision; unmeasured consumption claimed as fact

---

### 16. Formula Version & Composition IMMUTABLE

**Invariant:** Once feed_manufacturing references a formula_version_id, that reference never changes. Once a formula_version_id has composition (feed_formula_line rows), that composition is immutable (no UPDATE/DELETE on feed_formula_line).

**Enforced by:** 
- RLS policy `UPDATE ... formula_version_id` forbidden on feed_manufacturing
- RLS policy `UPDATE/DELETE DENY` on feed_formula_line (APPEND_ONLY)
- formula_version itself immutable via VERSION column

**Consequence of violation:** Manufacturing recipe could change retroactively; cost basis unknown; historical composition lost

---

### 17. Population Flow = Events-Only

**Invariant:** No current_population column; population at any date = SUM(population_events.delta) from creation to that date

**Enforced by:** Schema design (no current_population column); computed in queries

**Consequence of violation:** Stored population could diverge from actual; hidden inconsistency

---

### 18. No Hard-Delete of Posted Facts

**Invariant:** Once a fact is committed (ledger entry inserted, order delivered, etc.), only soft-delete (activo=false) or reversal (INSERT opposite entry) allowed

**Enforced by:** RLS `DELETE USING FALSE` on all ledger/audit tables; only UPDATE available for masters (soft-delete via activo flag)

**Consequence of violation:** Forensic evidence destroyed; audit trail incomplete

---

### 19. MP Source Record IMMUTABLE

**Invariant:** mp_source_record is APPEND_ONLY; processing_status tracks reconciliation state; raw event_data never modified

**Enforced by:** RLS `UPDATE USING FALSE; DELETE USING FALSE`; processing_status is only mutable field

**Consequence of violation:** Raw source data rewriteable; audit of MP movements lost

---

### 20. Client Name Change Doesn't Alter History

**Invariant:** client_ledger.ledger_client_name is snapshot of client.nombre at posting time; if client renamed later, ledger reflects original name

**Enforced by:** Snapshot field captured at INSERT; immutable thereafter

**Consequence of violation:** Historical ledger misattributed; audit confusion

---

## PERIOD DETERMINATION RULES

**Frozen rule:** created_at NEVER determines period.

**Determinant columns per entity:**
- **pedidos:** delivered_at (TIMESTAMPTZ, required after delivery; cast to DATE for period check)
- **client_ledger:** effective_date (DATE)
- **financial_posting:** effective_date (DATE)
- **financial_operation:** effective_date (DATE)
- **financial_instrument_event:** event_date (DATE; cheque operations use this for period)
- **population_events:** event_date (DATE)
- **daily_production:** production_date (DATE)
- **classification:** session_date (DATE)
- **feed_manufacturing:** manufacturing_date (DATE)
- **purchases:** economic_date (DATE)
- **collections:** effective_date (DATE)
- **management_period:** periodo_fecha (DATE, first of month)

**Validation:** RPC checks that period status='OPEN' BEFORE INSERT/UPDATE with effective_date in that period.

---

## SNAPSHOT FIELDS (IMMUTABLE)

| Field | Table | Captured At | Reason |
|---|---|---|---|
| precio_unitario | pedido_lineas | order creation | Historical accuracy (price was this at order time) |
| producto_nombre | pedido_lineas | order creation | Name was this at order time |
| ledger_client_name | client_ledger | ledger posting | Client name was this when debt recorded |
| formula_version_id | feed_manufacturing | manufacturing creation | Formula was this version during batch |

---

## APPEND-ONLY TABLES (RLS ENFORCES)

- client_ledger
- financial_posting
- population_events
- supplier_ledger
- audit_events
- feed_inventory_count (new count record for corrections, not UPDATE)
- mp_source_record

**Enforcement:** RLS policy `UPDATE USING FALSE; DELETE USING FALSE`

**Rectification:** INSERT new record (with prior = old reference or supersession tracking), never UPDATE

---

## DERIVED/COMPUTED DATA (NO STORAGE)

| Metric | Derived From | Formula | Never Stored |
|---|---|---|---|
| client_balance | client_ledger | SUM(signed_amount) per cliente_id | ✓ |
| account_balance | financial_posting | SUM(signed_amount) per account_id | ✓ |
| order_total | pedido_lineas | SUM(subtotal) per pedido_id | ✓ (monto_total removed) |
| population | population_events | SUM(delta) per flock (cumulative) | ✓ |
| classificados | classification_line | SUM(quantity) per session | ✓ |
| consumo_económico | feed_inventory_count | inflows - outflows per period | ✓ Calculated |

---

## CONSTRAINT SPECIFICATIONS

**Type-level constraints (CHECK, UNIQUE, FK):**
- financial_posting: CHECK(signed_amount <> 0) — prevent zero amounts
- population_events: UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' AND is_current=true — partial; allow adjustments
- flocks: UNIQUE(shed_id) WHERE estado='ACTIVE' — one active per shed
- financial_operation + financial_posting: FK ensures posting belongs to operation

**RLS-level constraints (UPDATE/DELETE policies):**
- daily_production: UPDATE USING FALSE — immutable
- client_ledger: UPDATE USING FALSE, DELETE USING FALSE — append-only
- financial_posting: UPDATE USING FALSE, DELETE USING FALSE — append-only
- population_events: UPDATE USING FALSE, DELETE USING FALSE — append-only
- audit_events: UPDATE USING FALSE, DELETE USING FALSE — forensic

**RPC-level constraints (business logic):**
- Period open check: SELECT period FOR UPDATE; IF status != 'OPEN' RAISE ERROR
- Cheque state machine: RPC validates transitions only
- Delivery immutability: RPC checks estado before allowing rectification
- Duplicate mortality: RPC queries UNIQUE constraint result; rejects on duplicate

---

## TESTING INVARIANTS

**Before deployment, verify each invariant:**

1. One flock per shed: `SELECT shed_id, COUNT(*) FROM flocks WHERE estado='ACTIVE' GROUP BY shed_id HAVING COUNT(*) > 1` → expect 0 rows
2. One mortality per date: `SELECT flock_id, event_date, COUNT(*) FROM population_events WHERE event_type='MORTALITY' AND is_current=true GROUP BY flock_id, event_date HAVING COUNT(*) > 1` → expect 0 rows
3. Subtotal correctness: `SELECT COUNT(*) FROM pedido_lineas WHERE subtotal != cantidad * precio_unitario` → expect 0 rows (or confirm GENERATED ALWAYS)
4. No stored balances: `SELECT * FROM clients WHERE balance IS NOT NULL LIMIT 1` → expect 0 rows
5. Order price immutability: Attempt UPDATE on delivered order → RLS blocks
6. Ledger append-only: Attempt UPDATE on client_ledger → RLS blocks
7. Period closure enforced: Attempt insert with closed period → RPC error

---

## COMPLIANCE MATRIX

| # | Invariant | Schema | RLS | RPC | Test |
|---|---|---|---|---|---|
| 1 | One flock/shed | UNIQUE | — | — | Query |
| 2 | One mortality/date | UNIQUE partial | — | RPC check | Query |
| 3 | Subtotal derived | GENERATED | — | — | Query |
| 4 | Order immutable | — | UPDATE DENY | — | RLS |
| 5 | Balance = SUM | No column | — | — | Query |
| 6 | Account = SUM | No column | — | — | Query |
| 7 | Posting FK | FK constraint | — | — | Insert |
| 8 | Transfer 2x | — | — | RPC atomic | RPC |
| 9 | Append-only | — | UPDATE/DELETE DENY | — | RLS |
| 10 | Period OPEN | — | — | RPC check | RPC |
| 11 | Period=effective_date | Column design | — | RPC use | RPC |
| 12 | Cheque state machine | — | — | RPC validate | RPC |
| 13 | Price snapshot | — | — | At insert | Update |
| 14 | No classification flock | No column | — | — | Schema |
| 15 | No daily consumption | No table | — | — | Schema |
| 16 | Formula immutable | FK | — | RPC prevent | RPC |
| 17 | Population = events | No column | — | — | Query |
| 18 | No hard-delete | — | RLS restrict | — | RLS |
| 19 | MP immutable | — | UPDATE DENY | — | RLS |
| 20 | Name snapshot | Snapshot | — | At insert | Query |

---

**STATUS: ALL 20 INVARIANTS IMPLEMENTABLE**

No contradictions between schema, RLS, and RPC logic. Database can guarantee all invariants.
