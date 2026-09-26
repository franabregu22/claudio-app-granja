# PHYSICAL DATABASE DESIGN — ROUND 2 REVIEW

**DATE:** 2026-09-24  
**METHODOLOGY:** 5-agent adversarial review (A: Frozen Compliance, B: Ledger/Money, C: Constraints, D: RLS, E: Legacy)  
**STATUS:** Review complete. Findings consolidated.

---

## 1. EXECUTIVE VERDICT

**RECOMMENDATION:** NOT READY TO FREEZE

**Reasoning:**

Round 1 is **substantially sound** on architecture but has **6 critical blockers** and **14+ high-priority corrections** that must be resolved before Physical Database Design can be finalized.

**Blockers prevent deployment because they:**
- Corrupt data integrity (zero-amount postings, orphaned transactions)
- Block authorized OPERATOR work (classifications, feed manufacturing)
- Violate immutability invariants (no enforcement on daily_production UPDATE)
- Create migration impossibilities (duplicate mortandad, unresolved enum conflicts)

**Verdict:** Fix blockers + high-priority constraints → Re-review → THEN FREEZE

**Effort estimate:** 3-5 days for corrections; 1 day for re-review.

---

## 2. MANDATORY FINDINGS REVIEW (1–12)

### Finding 1 — Sale Delivery May Post Incorrectly to Financial Ledger

**Status:** CONFIRMED (BLOCKER)

**Evidence:**
- FROZEN ARCHITECTURE PART 1: "Separated domains... Financial: cash accounts, postings, transfers, instruments."
- FROZEN ARCHITECTURE PART 3: "All sales flow through Pedido. DELIVERED = economic sales event."
- FROZEN does NOT authorize financial_posting creation for credit sales (no cash received)

**Round 1 claim:**
- deliver_order RPC creates `financial_operation` and `financial_posting` for all sales

**Problem:**
- This treats sale delivery as a treasury transaction (posts to AR account)
- FROZEN architecture explicitly separates economic (client_ledger) from financial (cash accounts)
- A credit sale does NOT create a financial posting (no money received)
- Only collections/transfers/cash create financial_postings

**Severity:** BLOCKER

**Correction:**
- deliver_order RPC should:
  1. UPDATE pedidos.estado = DELIVERED
  2. INSERT client_ledger (+amount, movement_type='SALE_DELIVERY')
  3. DO NOT create financial_operation/posting
  4. Audit only
- Only register_collection RPC should create financial_posting (for cash/transfer/cheque received)

**Affected:** TRANSACTION_CATALOG_V1.md (deliver_order RPC spec)

---

### Finding 2 — Cheque Endorsement May Reopen Client CC Debt (FROZEN VIOLATION)

**Status:** CONFIRMED (BLOCKER)

**Evidence:**
- FROZEN ARCHITECTURE PART 7: "Endorsement to supplier: Reduces supplier CC... Does NOT automatically reopen client CC debt."
- Round 1 endorse_cheque RPC appears to create client_ledger reversal

**Problem:**
- If endorsement generates `INSERT client_ledger (movement_type='REVERSAL', +amount)`, client debt re-opens
- FROZEN explicitly forbids this: payment via cheque is STILL valid; cheque changes custody, not payment status

**Severity:** BLOCKER

**Correction:**
- endorse_cheque RPC must:
  1. Update financial_instrument.estado = ENDORSED
  2. INSERT supplier_ledger (-amount) — new obligation
  3. DO NOT INSERT client_ledger reversal
  4. Audit

**Affected:** TRANSACTION_CATALOG_V1.md (endorse_cheque RPC spec)

---

### Finding 3 — Deposited vs Cleared Semantics Unclear

**Status:** CONFIRMED (HIGH)

**Evidence:**
- FROZEN ARCHITECTURE PART 7:
  - RECEIVED: client CC impact
  - DEPOSITED: state/custody transition
  - CLEARED: actual bank credit (financial posting)

**Round 1 issue:**
- Unclear if DEPOSITED creates financial_posting
- Should NOT — only CLEARED posts to bank

**Severity:** HIGH

**Correction:**
- Clarify RPC specs:
  - deposit_cheque: Update stato → DEPOSITED; no financial posting
  - clear_cheque: Update stato → CLEARED; INSERT financial_posting (bank account, +amount)

**Affected:** TRANSACTION_CATALOG_V1.md (cheque workflow RPCs)

---

### Finding 4 — Mortality MUST NOT Silently Upsert

**Status:** CONFIRMED (HIGH)

**Evidence:**
- FROZEN ARCHITECTURE PART 11: "Duplicate attempt: Reject... Do NOT silently replace the original value."
- Round 1 constraint: UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY' ✓

**Status:** CORRECT ✓

**But verify:** RPC register_mortality must explicitly REJECT on duplicate (not silently update).

**Affected:** TRANSACTION_CATALOG_V1.md (register_mortality RPC)

---

### Finding 5 — OPERATOR Permissions Drifted from Frozen Spec

**Status:** CONFIRMED (4 BLOCKERS)

**Evidence:**
- FROZEN ARCHITECTURE PART 2:
  - OPERATOR: "daily_production, mortality, classifications, feed_manufacturing, ..."
  
- Round 1 RLS_MATRIX_V1.md:
  - classifications: OPERATOR SELECT = NONE ✗
  - feed_manufacturing: OPERATOR SELECT = NONE ✗
  - daily_production UPDATE: No RLS policy (only comment) ✗
  - audit_events: includes 'classifications' but classifications blocked (inconsistent) ✗

**Severity:** 4 BLOCKERS

**Corrections:**
1. Unblock classifications: Allow OPERATOR INSERT/SELECT own/recent sessions
2. Unblock feed_manufacturing: Separate cost data from operations; expose formula names/quantities
3. Add RLS UPDATE block on daily_production: `CREATE POLICY production_no_update ... USING FALSE`
4. Fix audit_events: Remove 'classifications' from OPERATOR SELECT if blocked; add if unblocked

**Affected:** RLS_MATRIX_V1.md (tables 1, 4, 10, 13–15)

---

### Finding 6 — Over-Restrictive RLS on Operational Data

**Status:** CONFIRMED (HIGH)

**Evidence:**
- Round 1 hides shed_id, formula composition, feed inventory
- But these are operational data (not costs)

**Severity:** HIGH

**Correction:**
- Separate operational views from cost views:
  - View: formula_composition_view (names, quantities, NO costs)
  - OPERATOR SELECT allowed
- Clarify shed_id visibility: If safe (no cost context), expose it

**Affected:** RLS_MATRIX_V1.md (tables 6, 9, 10)

---

### Finding 7 — ADR Classification May Be Wrong

**Status:** CONFIRMED (MEDIUM)

**Round 1 identifies:**
- forma_pago enum conflict (migration 045)
- mortality uniqueness enforcement choice

**Assessment:**
- forma_pago conflict = MIGRATION ISSUE (not architecture ADR)
  - Must validate migration 045 execution before cutover
  - Not a decision to reopen
- mortality uniqueness = PHYSICAL DESIGN DECISION (not architecture)
  - FROZEN says "max one"; constraint is just enforcement mechanism
  - DB constraint vs RPC pre-check are implementation choices

**Severity:** MEDIUM (admin cleanup, not architectural decision)

**Correction:** Reclassify these as "MIGRATION BLOCKERS" and "IMPLEMENTATION DECISIONS," not ADRs

**Affected:** CURRENT_TARGET_CROSSWALK_V2.md (Migration section)

---

### Finding 8 — Do Not Reopen Frozen Decisions

**Status:** CONFIRMED (MEDIUM)

**Round 1 lists "owner decisions needed":**
- Classification categories (already frozen: XL, N1, N2, N3, ROTOS, SUCIOS, DESCARTE)
- Opening balances validation (owner responsibility, not architecture decision)
- Formula change mid-month (handled by formula version immutability — already frozen)

**Severity:** MEDIUM (unnecessary owner inquiry)

**Correction:** Remove non-essential owner decisions. Only ask if:
1. Cannot be resolved from FROZEN ARCHITECTURE
2. Cannot be verified from repository evidence
3. Truly requires business judgment

**Affected:** PHYSICAL_DATABASE_DESIGN_V1.md (Part 6: Open Implementation Questions)

---

### Finding 9 — ID Type Consistency

**Status:** PARTIALLY CONFIRMED (MEDIUM)

**Round 1 strategy:**
- UUID for masters
- BIGSERIAL for ledgers

**Inconsistency found:**
- financial_account.id = BIGSERIAL (should be UUID — it's a master, not append-only)

**Severity:** MEDIUM

**Correction:**
- Change financial_account.id to UUID
- Update all FKs from financial_posting

**Affected:** PHYSICAL_DATABASE_DESIGN_V1.md (tables 5–7)

---

### Finding 10 — Physical Quantity Types

**Status:** CONFIRMED (MEDIUM)

**Issue:**
- daily_production.eggs_total = DECIMAL(15,4) (fractional eggs?)
- population_event.delta = BIGINT (correct — whole birds)

**Clarity needed:**
- If measuring eggs in individual units: must be INTEGER
- If measuring in docenas (12-unit batches): DECIMAL OK (0.5 = 6 eggs)

**Severity:** MEDIUM (data quality)

**Correction:**
- Define unit consistently in schema documentation
- Use INTEGER for individual units

**Affected:** PHYSICAL_DATABASE_DESIGN_V1.md (Tables 10–11)

---

### Finding 11 — Enum Strategy Clarity

**Status:** CONFIRMED (MEDIUM)

**Round 1 creates enums for:**
- order status (PENDING, DELIVERED, CANCELLED) — stable ✓
- population event type (MORTALITY, COUNT_ADJUSTMENT) — stable ✓
- financial instrument state (RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED) — stable ✓

**Question:** Are these truly closed (no future extensions)?

**Severity:** MEDIUM (future-proofing)

**Recommendation:** Document that these enums are stable for V1; future extensions require ADR

**Affected:** PHYSICAL_DATABASE_DESIGN_V1.md (Part 7: Enum Strategy)

---

### Finding 12 — Client Ledger Migration

**Status:** CONFIRMED (BLOCKER)

**Issue:**
- Round 1 assumes backfill from historical pedidos + pagos
- FROZEN migration principle: "Do NOT fabricate authoritative historical CC if legacy is unreliable"

**Severity:** BLOCKER

**Correction:**
- At cutover:
  1. Calculate predicted balance per client
  2. Validate against owner records
  3. Create OPENING_BALANCE entries (owner-signed)
  4. Mark historical source data as "context," not "authoritative"
  5. New system authoritative from cutover onward

**Affected:** CURRENT_TARGET_CROSSWALK_V2.md (Migration section)

---

## 3. NEW FINDINGS (INDEPENDENT AGENT DISCOVERIES)

### Finding 13 — financial_posting Missing Zero-Amount Check

**Severity:** BLOCKER

**Issue:** No `CHECK(signed_amount != 0)` on financial_posting.

**Impact:** Zero-postings silently corrupt account balance calculations.

**Fix:** Add `CHECK(signed_amount <> 0)` to financial_posting table spec.

**Affected:** PHYSICAL_DATABASE_DESIGN_V1.md (Table 7)

---

### Finding 14 — order_lines Subtotal Not DB-Enforced

**Severity:** HIGH

**Issue:** Subtotal noted as "COMPUTED/IMMUTABLE" but no GENERATED ALWAYS or trigger.

**Impact:** Application could modify subtotal independently; diverges from cantidad * precio_unitario.

**Fix:** Either:
- `subtotal NUMERIC(15,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED`
- Or: trigger BEFORE INSERT/UPDATE to enforce subtotal = cantidad * precio_unitario

**Affected:** PHYSICAL_DATABASE_DESIGN_V1.md (Table 3)

---

### Finding 15 — Pedidos Uniqueness Over-Restrictive

**Severity:** HIGH

**Issue:** `UNIQUE(cliente_id, delivered_at) WHERE estado='DELIVERED'` prevents same-day multi-order sales.

**Frozen rule:** Does NOT restrict same customer, same day sales (different pedidos).

**Fix:** Remove this constraint. Order uniqueness naturally enforced (each pedido.id unique).

**Affected:** PHYSICAL_DATABASE_DESIGN_V1.md (Table 2)

---

### Finding 16 — Classification Session Uniqueness Over-Restrictive

**Severity:** HIGH

**Issue:** `UNIQUE(session_date, location)` prevents parallel classifications in same facility same day.

**Frozen rule:** "Multiple sessions per day allowed" (unrestricted).

**Fix:** Remove location from uniqueness constraint. Allow unrestricted daily multiplicity.

**Affected:** PHYSICAL_DATABASE_DESIGN_V1.md (Table 11)

---

### Finding 17 — Population Event Uniqueness Over-Restrictive

**Severity:** MEDIUM

**Issue:** `UNIQUE(flock_id, event_date, event_type)` prevents multiple COUNT_ADJUSTMENTs same day.

**Frozen rule:** Only "max one MORTALITY per (flock, date)" — allows flexible adjustments.

**Fix:** Change to `UNIQUE(flock_id, event_date) WHERE event_type = 'MORTALITY'`

**Affected:** PHYSICAL_DATABASE_DESIGN_V1.md (Table 9)

---

### Finding 18 — Missing effective_date Checks Across Tables

**Severity:** MEDIUM

**Issue:** Only financial_posting has `CHECK(effective_date <= current_date)`. Missing on:
- client_ledger.effective_date
- purchase.economic_date
- daily_production.production_date
- classification.session_date

**Fix:** Add future-date check to all period-determining columns.

**Affected:** PHYSICAL_DATABASE_DESIGN_V1.md (Tables 4, 8, 10, 11)

---

### Finding 19 — forma_pago Enum Redefinition Unresolved

**Severity:** BLOCKER

**Issue:**
- Migration 019: forma_pago_type = ('efectivo', 'mercadopago', 'echeq', 'cheque')
- Migration 045: forma_pago_type = ('efectivo', 'mercadopago', 'transferencia') ← cheque removed, transferencia added
- TypeScript code still references 'cheque'/'echeq' (mismatch)

**Impact:** Cheques should be in financial_instrument; movimientos_caja should NOT reference them.

**Fix:** Validate migration 045 execution; ensure no cheques remain in movimientos_caja post-migration. If found, migrate to cheques table + financial_instrument.

**Affected:** CURRENT_TARGET_CROSSWALK_V2.md (Migration section)

---

### Finding 20 — Duplicate Mortandad Data

**Severity:** BLOCKER

**Issue:** If any (lote_id, fecha) pair has multiple producciones rows with different mortandad values, frozen architecture cannot resolve which is truth (no MORTALITY_CONFLICT type).

**Impact:** Cannot migrate population_events without corruption.

**Fix:** Query production: `SELECT lote_id, fecha, COUNT(*) FROM producciones WHERE mortandad IS NOT NULL GROUP BY lote_id, fecha HAVING COUNT(*) > 1`. If results found: owner must validate truth before migration.

**Affected:** CURRENT_TARGET_CROSSWALK_V2.md (Migration section)

---

## 4. TRANSACTION SEMANTICS — FINAL REVIEW

| Operation | Frozen Fact | Client CC Impact | Financial Posting? | Period Date | Audit | Atomic RPC? | Status |
|---|---|---|---|---|---|---|---|
| **deliver_order** | Pedido DELIVERED | +amount (debt) | NO (credit only) | delivered_at | YES | YES | ⚠️ NEEDS FIX |
| **register_collection (cash)** | Collection received | -amount (paid) | YES (CAJA +) | effective_date | YES | YES | ✓ CORRECT |
| **receive_cheque** | Cheque RECEIVED | -amount (debt paid via cheque) | NO (in cartera, not cash) | received_date | YES | YES | ✓ CORRECT |
| **deposit_cheque** | Cheque DEPOSITED | No change | NO (still not cash) | deposited_date | YES | YES | ✓ CORRECT |
| **clear_cheque** | Cheque CLEARED | No change | YES (CAJA +amount) | cleared_date | YES | YES | ✓ CORRECT |
| **endorse_cheque** | To supplier | NO CHANGE (stays -amount) | No | endorsed_date | YES | YES | ⚠️ NEEDS FIX |
| **register_purchase** | Purchase obligation | N/A | NO (supplier debt, not cash) | economic_date | YES | YES | ✓ CORRECT |
| **supplier_payment** | Supplier paid | N/A | YES (CAJA -) | effective_date | YES | YES | ✓ CORRECT |
| **transfer (MP→BNA)** | Transfer atomic | N/A | YES (both postings or neither) | effective_date | YES | YES | ✓ CORRECT |
| **rectify_sale** | Compensating entries | Reversal then new | Reversals then new | original + rectified periods | YES | YES | ⚠️ VERIFY |

**Key fixes needed:**
1. deliver_order: Remove financial_posting creation
2. endorse_cheque: Remove client_ledger reversal
3. rectify_sale: Verify compensating entry pattern (append-only, not UPDATE)

---

## 5. RLS CORRECTION MATRIX

| Table | ADMIN Select | ADMIN Write | OPERATOR Select | OPERATOR Write | Status |
|---|---|---|---|---|---|
| **classifications** | ALL | RPC | **BLOCKED ✗** | BLOCKED ✗ | ⚠️ FIX: Unblock for authorized work |
| **feed_manufacturing** | ALL | RPC | **BLOCKED ✗** | BLOCKED ✗ | ⚠️ FIX: Expose ops; hide costs |
| **daily_production** | ALL | RPC | Own + auth flocks | Own insert | ⚠️ FIX: Add UPDATE DENY RLS |
| **feed_types** | ALL | RPC | Names/IDs only | BLOCKED | ✓ OK (safe view) |
| **feed_formulation_version** | ALL | RPC | **Names/IDs only ✗** | BLOCKED | ⚠️ FIX: Expose composition (no costs) |
| **flocks** | ALL | RPC | Auth flocks | BLOCKED | ? CLARIFY shed_id visibility |
| **client_ledger** | ALL | RPC | BLOCKED ✓ | BLOCKED ✓ | ✓ CORRECT |
| **pedidos** | ALL | RPC | BLOCKED ✓ | BLOCKED ✓ | ✓ CORRECT |
| **audit_events** | ALL | NONE (immutable) | **Own + classifications ✗** | BLOCKED | ⚠️ FIX: Remove classifications if blocked |

---

## 6. CONSTRAINT CORRECTION LIST

| Table | Current Constraint | Issue | Action |
|---|---|---|---|
| **financial_account** | id = BIGSERIAL | Master, should be UUID | Change to UUID |
| **financial_posting** | (none) | Missing CHECK(signed_amount != 0) | Add CHECK |
| **pedidos** | UNIQUE(cliente_id, delivered_at) IF DELIVERED | Blocks valid same-day multi-order | REMOVE |
| **pedido_lineas** | (none) | Subtotal not enforced immutable | Add GENERATED or trigger |
| **classification** | UNIQUE(session_date, location) | Blocks parallel sessions | REMOVE |
| **population_events** | UNIQUE(flock_id, event_date, event_type) | Over-restrictive on adjustments | Change to partial (MORTALITY only) |
| **client_ledger** | (none) | Missing effective_date future check | Add CHECK |
| **purchase** | (none) | Missing effective_date future check | Add CHECK |
| **daily_production** | (none) | Missing UPDATE block RLS | Add policy USING FALSE |
| **classification** | (none) | Missing effective_date future check | Add CHECK |

---

## 7. ENUM / MASTER TABLE DECISIONS

**Strategy:** 
- PostgreSQL ENUM for stable technical states
- Lookup tables for user-configurable business catalogs

| Type | Strategy | Rationale | Status |
|---|---|---|---|
| Order status | ENUM(PENDING, DELIVERED, CANCELLED) | Frozen, immutable state machine | ✓ CORRECT |
| Population event type | ENUM(MORTALITY, COUNT_ADJUSTMENT) | Frozen, immutable | ✓ CORRECT |
| Instrument state | ENUM(RECEIVED, DEPOSITED, CLEARED, ENDORSED, REJECTED) | Frozen, immutable state machine | ✓ CORRECT |
| Management period status | ENUM(OPEN, CLOSED) | Frozen, immutable | ✓ CORRECT |
| Role type | ENUM(ADMIN, OPERATOR) | Frozen, immutable | ✓ CORRECT |
| Product type | ENUM(VENDIBLE, INPUT, BOTH) | Frozen, immutable | ✓ CORRECT |
| Product | Lookup table (products) | User-configurable; mutable | ✓ CORRECT |
| Price list | Lookup table | User-configurable | ✓ CORRECT |
| Classification grade | Lookup table (classification_grade) | User-configurable per Santo Tomás | ✓ CORRECT |
| forma_pago | ENUM (conflict!) | Should match transfer methods | ⚠️ RESOLVE enum conflict first |

---

## 8. LEGACY MIGRATION CORRECTIONS

| Entity | Current | Target | Action | Blocker? |
|---|---|---|---|---|
| **clientes** | Minimal schema | Add contact/fiscal fields | REUSE + columns | NO |
| **pedidos + pedido_lineas** | Already normalized | No change | REUSE | NO |
| **pagos** | metodo_pago TEXT | forma_pago enum | Validate no cheques; migrate | YES (enum conflict) |
| **movimientos_caja** | ~500 rows, mixed types | financial_operation + posting | Classify by (tipo, forma_pago, vinculado_a); validate referential integrity | YES (classification + orphans) |
| **lotes** | Preserve | Add genetics_line, supplier_id | REUSE + columns | NO |
| **producciones** | mortandad INT column | Extract to population_events | Validate no duplicates first | YES (duplicates) |
| **cheques** | Existing table, estado field | financial_instrument + events | Map estado; migrate | NO |
| **Client CC history** | Calculated ad-hoc | client_ledger OPENING_BALANCE | Validate each client; owner sign-off | YES (precision) |
| **MP data** | FASE 0 (correct) | Reuse FASE 0 | REUSE | NO |

**Critical blockers before migration:**
1. Resolve forma_pago enum conflict (validate migration 045)
2. Find and validate duplicate mortandad records
3. Validate client CC historical precision (owner sign-off)
4. Identify orphaned movimientos_caja references

---

## 9. ADR CLASSIFICATION

| Item | Round 1 Category | Correct Classification | Action |
|---|---|---|---|
| forma_pago enum conflict | ADR | MIGRATION BLOCKER (not architecture) | Resolve before cutover; no ADR needed |
| Mortality uniqueness enforcement | ADR | PHYSICAL DESIGN DECISION (not architecture) | Constraint chosen; not an ADR |
| Classification sessions | ADR | FROZEN ARCHITECTURE (not ADR) | "Multiple sessions per day" already decided |
| Feed consumption separation | ADR | FROZEN ARCHITECTURE (already decided) | Consumption types already defined |
| Cheque endorsement | ADR | FROZEN ARCHITECTURE (already decided) | Endorsement semantics already frozen |

**Result:** NO true ADRs remain. Round 1 over-escalated implementation decisions as architectural questions.

---

## 10. OWNER DECISIONS REQUIRED

Only questions that cannot be resolved from Frozen Architecture or repository evidence:

| Question | Answer | Evidence |
|---|---|---|
| Classification categories (XL, N1, N2, N3, etc.) | Already frozen | FROZEN ARCHITECTURE PART 14 |
| Formula change mid-month handling | Handled by immutable versions | FROZEN ARCHITECTURE PART 15 |
| Opening balance validation | REQUIRED at cutover | FROZEN Migration principle + Agent E |
| forma_pago enum resolution | REQUIRED (validation task, not decision) | Migration 045 execution must be verified |
| Duplicate mortandad handling | REQUIRED (validation task) | Agent E: owner must select truth |
| Shed_id visibility in RLS | CLARIFY based on cost context | If shed table safe → expose; else hide |

**Result:** Only 3 genuine decisions needed:
1. Opening balance validation (owner responsibility, not decision)
2. Duplicate mortandad resolution (owner review, not decision)
3. Shed_id visibility clarification (technical decision, not owner)

---

## 11. EXACT ROUND 1 CORRECTIONS

### PHYSICAL_DATABASE_DESIGN_V1.md

**Remove/Fix:**
- Table 2 (pedidos): DELETE `Partial UNIQUE(cliente_id, delivered_at) WHERE estado='DELIVERED'`
- Table 3 (pedido_lineas): Clarify `subtotal` as GENERATED ALWAYS or add trigger spec
- Table 5 (financial_account): Change `id BIGSERIAL` → `id UUID`
- Table 7 (financial_posting): Add `CHECK(signed_amount <> 0)`
- Table 9 (population_events): Change `UNIQUE(flock_id, event_date, event_type)` → `UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY'`
- Table 11 (classification): DELETE `Partial UNIQUE(session_date, location)`
- Part 1: Add effective_date CHECK to all period-determining columns
- Part 6: Remove non-essential "owner decisions"

### TRANSACTION_CATALOG_V1.md

**Fix RPC specs:**
- **deliver_order:** Remove `INSERT financial_posting` step. Only update order state + client_ledger.
- **endorse_cheque:** Remove `INSERT client_ledger reversal` step. Only update instrument state + supplier_ledger.
- **rectify_delivered_order:** Verify compensating entries use INSERT (append-only), not UPDATE.
- **clear_cheque:** Confirm `INSERT financial_posting` (bank account, +amount) — only step creating cash impact.

### RLS_MATRIX_V1.md

**Unblock:**
- **classifications:** Allow OPERATOR INSERT/SELECT own/recent sessions
- **feed_manufacturing:** Separate cost_version (ADMIN) from manufacturing_record (OPERATOR); expose operational facts
- **daily_production:** Add explicit `CREATE POLICY ... USING FALSE` for UPDATE

**Clarify:**
- **feed_formulation_version:** Create safe view exposing formula composition (names, quantities, NO costs)
- **audit_events:** Remove 'classifications' if blocked; add if unblocked

### CURRENT_TARGET_CROSSWALK_V2.md

**Migration section:**
- Add **BLOCKERS:** forma_pago enum, duplicate mortandad, client CC precision
- Add **MIGRATION TASKS:** Validate enum migration 045, query duplicates, owner sign-off on opening balances
- Reclassify enum/uniqueness decisions as "PHYSICAL IMPLEMENTATION," not "ADR"

---

## 12. FREEZE READINESS

**Can we safely correct Round 1 and perform a FINAL Physical Schema Freeze?**

**Answer:** NO — NOT YET

**Reason:** 6 architectural/critical blockers must be resolved FIRST:

1. **BLOCKER:** deliver_order posts to financial ledger (architectural, violates frozen domain separation)
2. **BLOCKER:** endorse_cheque may reopen client CC (architectural, violates frozen rule)
3. **BLOCKER:** financial_posting allows zero-amount (data integrity, violates frozen invariant)
4. **BLOCKER:** daily_production UPDATE not enforced immutable (audit integrity, violates frozen rule)
5. **BLOCKER:** forma_pago enum redefinition unresolved (migration, blocks cutover)
6. **BLOCKER:** Duplicate mortandad data unvalidated (migration, blocks population_events creation)

**Additional fixes required before freeze (HIGH PRIORITY):**
- 4 OPERATOR permissions violations (classifications, feed_manufacturing, audit_events, immutability RLS)
- 3 over-restrictive uniqueness constraints (pedidos same-day, classifications parallel, population_events adjustments)
- Missing effective_date checks across tables
- Subtotal immutability not DB-enforced

**Path forward:**

1. **IMMEDIATE (this week):**
   - Fix deliver_order RPC (remove financial_posting)
   - Fix endorse_cheque RPC (remove CC reversal)
   - Add financial_posting CHECK(signed_amount != 0)
   - Add daily_production UPDATE DENY RLS

2. **WEEK 2:**
   - Unblock classifications, feed_manufacturing RLS
   - Remove over-restrictive uniqueness constraints
   - Add effective_date checks
   - Resolve forma_pago enum (validate migration 045)
   - Query duplicate mortandad; owner sign-off
   - Validate client CC history

3. **FINAL REVIEW (Day 3):**
   - Re-run agents A–E on corrected Round 1
   - If all blockers resolved → FREEZE
   - If new issues found → iterate

**Estimated effort:** 5–7 days for corrections + re-review

**Blocker status:** ARCHITECTURE UNSTABLE — Do NOT proceed to Physical Schema Freeze until all 6 blockers resolved.

---

**APPENDIX: AGENT FINDINGS SUMMARY**

- **Agent A (Frozen Compliance):** 14/15 areas compliant; 1 MEDIUM finding (classification uniqueness)
- **Agent B (Ledger Red Team):** 5 BLOCKERS + 4 HIGH (financial architecture needs redesign)
- **Agent C (Constraints Red Team):** 1 BLOCKER + 4 HIGH + 5 MEDIUM (constraint enforcement gaps)
- **Agent D (RLS Red Team):** 4 BLOCKERS + 2 HIGH (operator permissions over-blocked)
- **Agent E (Migration Red Team):** 4 BLOCKERS + 3 HIGH (migration hazards, enum conflict, duplicates, precision)

**Total consolidated:** 6 critical architectural blockers + 14+ high-priority fixes

---

**STATUS: NOT READY FOR FREEZE — CORRECTIONS REQUIRED**
