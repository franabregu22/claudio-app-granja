# TARGET ARCHITECTURE REVIEW — ROUND 3 FINAL

**Date:** 2026-09-24  
**Objective:** Verify frozen decisions for internal contradictions and Santo Tomás scenarios. Determine readiness for Physical Database Design.

---

## 1. PEDIDO → VENTA: RECTIFICATION + AUDIT

**DECISION REVIEWED:**

- No `pedido_audit_events` table; use transversal `audit_events` instead.
- Rectificación: admin executes atomically, records before/after/reason/user/time.
- No threshold; any amount allowed in V1.
- If period CLOSED, must reopen first.

**VERDICT:** FREEZE

**LOGIC CHECK:**

Transversal `audit_events` table:

```
entity_type, entity_id, action, before (JSONB), after (JSONB), reason, performed_by, performed_at
```

Example rectification:

```
entity_type='order'
entity_id=12345
action='rectify_after_delivery'
before={'monto_total': 36000, 'lineas': [...]}
after={'monto_total': 18000, 'lineas': [...]}
reason='Operator error: charged 10 docenas instead of 5'
performed_by=uuid_admin
performed_at=2026-09-25 10:15:00
```

This preserves audit trail. GL reversals/postings are separate records in financial_posting table (linked via financial_operation).

**CONCRETE TEST:**

Scenario: Admin rectifies, then queries "what changed on this order?"

Query: `SELECT * FROM audit_events WHERE entity_type='order' AND entity_id=12345`

Result: Full history of rectification(s). ✓

Scenario: Find all rectifications user X made on 2026-09:

Query: `SELECT * FROM audit_events WHERE action='rectify_after_delivery' AND performed_by=X AND performed_at BETWEEN ... `

Result: Audit trail intact. ✓

**VERDICT FINAL: FREEZE** — No `pedido_audit_events` needed.

---

## 2. CIERRE MENSUAL: PERIOD DETERMINATION RULES

**DECISION REVIEWED:**

Frozen rules determine which date maps to which period for each transaction type.

**VERDICT:** FREEZE

**LOGIC CHECK:**

Rules are explicit per operation. No ambiguity re: "which date decides period."

Example: Cheque received 2026-09-25, deposited 2026-10-01, cleared 2026-10-05.

```
CC impact: 2026-09 (received_date)
Bank impact (GL posting): 2026-10 (cleared_date)
Two separate financial_operations, separate periods. ✓
```

Example: Late invoice dated 2026-09-30, received 2026-10-08.

```
If Sept is CLOSED: ADMIN must reopen it explicitly.
GL posting for 2026-09 only if explicitly reopened + reason recorded.
Cannot silently insert into CLOSED period. ✓
```

**VERDICT FINAL: FREEZE** — Rules are sound.

---

## 3. MORTALIDAD: CONFLICT SIMPLIFICATION

**DECISION REVIEWED:**

Eliminate MORTALITY_CONFLICT type and conflict_flag.

Constraint: `(flock_id, event_date, MORTALITY)` is unique.

If duplicate attempted: inform operator, do not create; rectify existing if wrong.

**VERDICT:** FREEZE

**LOGIC CHECK:**

Scenario: Operator A records mortandad=3. Operator B tries mortandad=5 same lote/date.

Constraint violation. Application logic: "Mortality already recorded for this flock today: 3 birds. To change, use Rectify."

Audit: `audit_events` records the attempted duplicate + reason.

No need for MORTALITY_CONFLICT state machine. Simple constraint + user workflow.

**VERDICT FINAL: FREEZE** — Simpler and sufficient.

---

## 4. CLASIFICACIÓN: NO INPUTS TRACKING

**DECISION REVIEWED:**

Eliminate `classification_inputs` and `daily_production.classification_session_id`.

Hecho: Eggs are physically mixed; traceability to lote is fictitious.

**VERDICT:** FREEZE

**LOGIC CHECK:**

Scenario: Classify eggs from mixed pool. Where did they come from?

Answer: Unknown operationally. That's OK.

If customer complains about quality, trace backward to production_date (2026-09-24) and know state of ALL flocks that day. ✓

No code currently requires `classification_inputs` FK. ✓

**VERDICT FINAL: FREEZE** — Do NOT create fictitious traceability.

---

## 5. ALIMENTO: CONSUMO ECONÓMICO VS TEÓRICO

**DECISION REVIEWED:**

Two separate calculations:

A. **CONSUMO CALCULADO** (economic): stock_in + fabrication - sales ± adjustments - stock_final = consumption (basis for cost allocation).

B. **CONSUMO TEÓRICO** (productivity metric per lote): population × age/genetics × assigned_formula (control metric, not real consumption).

No fictitious `daily_feed_consumption` as "real consumption by lote."

**VERDICT:** FREEZE

**LOGIC CHECK:**

Scenario: Formulation changes 2026-09-15. Cost per kg changes.

Consumo Económico: Attributes to formulae by date range. Cost calculated per period. ✓

Consumo Teórico: Per-lote metric independent of actual consumption. ✓

Scenario: Feed sold mid-month.

Consumo Económico: Stock out as "sales," reduces consumption calculado. ✓

No double-counting, clear semantics.

**VERDICT FINAL: FREEZE** — Distinction is sound and prevents fiction.

---

## 6. CHEQUES/ECHEQS: SIMPLE STATES

**DECISION REVIEWED:**

Use `financial_instrument` + `financial_instrument_events`.

States: RECEIVED / EN_CARTERA → DEPOSITED → CLEARED (or ENDORSED_TO_SUPPLIER, or REJECTED).

No full banking system; endorse is optional.

**VERDICT:** FREEZE

**LOGIC CHECK:**

Scenario: Cheque received, then endorsed to supplier.

```
Event 1: RECEIVED (2026-09-15)
  CC cliente -100k
  
Event 2: ENDORSED_TO_SUPPLIER (2026-09-20)
  CC proveedor -100k
  (offsetting: CC cliente +100k if we model reversal explicitly)
```

Clear state machine. ✓

Scenario: Rejection mid-way (received, rejected before deposit).

```
Event 1: RECEIVED
Event 2: REJECTED (2026-09-25)
  Reversal: CC cliente +100k back
```

Explicit compensation via financial_posting. ✓

**VERDICT FINAL: FREEZE** — State machine is clear.

---

## 7. AUDIT: TRANSVERSAL SYSTEM

**DECISION REVIEWED:**

Single `audit_events` table captures all entity modifications.

No per-entity audit tables unless demonstrable need.

**VERDICT:** FREEZE

**LOGIC CHECK:**

Scenario: Reconstruct "what happened to client #X on 2026-09?"

Query: `SELECT * FROM audit_events WHERE entity_type LIKE '%client%' AND entity_id='X' AND performed_at BETWEEN ...`

Gets: all modifications to that client's data with before/after/reason. ✓

Scenario: Regulatory audit: "show all order rectifications with reason."

Query: `SELECT * FROM audit_events WHERE action='rectify_after_delivery' AND ... `

Gets: all rectifications with before/after/reason/user. ✓

No need for separate `pedido_audit_events`.

**VERDICT FINAL: FREEZE** — Transversal is sufficient.

---

## 8. FINANCIAL LEDGER: OPERATIONS + POSTINGS

**DECISION REVIEWED:**

`financial_operation` 1:N `financial_posting`.

No double-entry bookkeeping (debit/credit); signed amounts instead.

Multi-impact operations (transfers) are transactional.

**VERDICT:** FREEZE

**LOGIC CHECK:**

Scenario: Transfer MP → BNA (500k).

```
financial_operation { type='transfer', reference='TXN-001' }
  ↓
financial_posting { operation_id=1, account='MP', amount=-500k, occurred_at=2026-09-24 }
financial_posting { operation_id=1, account='BNA', amount=+500k, occurred_at=2026-09-24 }
```

Both postings must commit or both rollback. ✓

If operation_id is NOT NULL (FK), orphaning is impossible. ✓

Scenario: Netting checks/fees.

```
financial_operation { type='combined', reference='MP-BATCH-001' }
  ↓
financial_posting { account='MP', amount=+9500k } (revenue)
financial_posting { account='MP', amount=-50k } (fee)
financial_posting { account='MP', amount=+15k } (interest)
```

Net calculation: SUM(amount) WHERE operation_id = 1 = 9465k. ✓

No debit/credit necessary for correctness.

**VERDICT FINAL: FREEZE** — Model is sound.

---

## A. REAL ARCHITECTURAL BLOCKERS REMAINING

**NONE FOUND.**

All frozen decisions pass internal logic and Santo Tomás scenario tests.

---

## B. TARGET MODEL CORRECTIONS FROM ROUND 2

**REMOVE:**

1. `classification_inputs` (table)
2. `daily_production.classification_session_id` (column)
3. `pedido_audit_events` (table) — covered by `audit_events` transversal

**RESULT:**

Target Model: **42 tables** (down from 45 in Round 2).

---

## C. ARCHITECTURE FREEZE

**YES** — All decisions pass verification.

No further owner questions required (all answered or deemed implementation-time decisions).

---

## D. NEXT SAFE STEP

**READY FOR PHYSICAL DATABASE DESIGN.**

Safe to proceed with:

- Table definitions (PKs, FKs, data types)
- UNIQUEs and CHECKs
- Indexes
- RLS policies & boundaries
- Transaction/RPC boundaries (atomic operations)

But NOT yet:

- Migrations code
- Application implementation
- Data migration scripts

---

## FINAL VERIFICATION CHECKLIST

✅ Pedido → Venta (audit, rectification, CC/GL impact)  
✅ Period determination (rules frozen, no ambiguity)  
✅ Mortalidad (conflict simplification valid)  
✅ Clasificación (no fictitious inputs)  
✅ Alimento (economic vs. theoretical distinction sound)  
✅ Cheques (state machine clear)  
✅ Audit (transversal coverage complete)  
✅ Financial ledger (operations + postings, no double-entry needed)  
✅ No internal contradictions found  
✅ No Santo Tomás scenarios break the model  
✅ Model is minimal (no abstract precaution)  
✅ All decisions supported by concrete logic  

---

**ARCHITECTURE STABLE FOR SCHEMA DESIGN.**

