# TESTING

**STATUS:** Testing infrastructure is MINIMAL; no test suite found

---

## CURRENT STATE

**Test Files Found:** 0 in project source (`src/`, `lib/`, `components/`, etc.)

**Testing Framework:** NOT INSTALLED

**Coverage:** Unknown (likely 0%)

---

## TESTING INFRASTRUCTURE

### Installed Testing Tools

**Package.json Analysis:**
- No `jest`, `vitest`, `mocha`, `playwright`, or similar test runners present
- No `testing-library` or `@testing-library/react` installed
- No assertion libraries like `expect.js` or `chai`
- Linting only: `oxlint` (static analysis, not testing)

---

## GAPS & RISKS

### CRITICAL (Production Risk)

| Component | Status | Risk |
|---|---|---|
| API/RPC functions | Untested | Financial operations may fail silently |
| Financial calculations | Untested | Incorrect sums, ledger corruption possible |
| Cobro workflow | Untested | Payment reconciliation broken |
| Cheque lifecycle | Untested | State machine transitions unchecked |
| MP reconciliation | Untested | Undetected sync failures |
| RLS policies | Untested | Unauthorized access possible |
| Pedido delivery → ledger | Untested | Atomicity not verified |

### HIGH

| Component | Status | Risk |
|---|---|---|
| Form validation (Zod) | Untested | Invalid data may submit |
| Date calculations | Untested | Period logic may be wrong |
| Classification aggregation | Untested | Wrong totals possible |
| Flock/production state | Untested | Inconsistent data |

### MEDIUM

| Component | Status | Risk |
|---|---|---|
| UI Components | Untested | Rendering errors not caught |
| React hooks | Untested | Stale closures, memory leaks |
| Navigation/routing | Untested | Links may be broken |

---

## AREAS MOST NEEDING TESTS

### 1. Financial Operations (HIGHEST PRIORITY)

**Function:** Any operation that touches `financial_posting` or `client_ledger`

**Examples:**
- `deliver_order()` → Creates ledger entry
- `register_collection()` → Reduces CC balance
- `transfer_between_accounts()` → Posts to 2 accounts
- `reconcile_mp()` → Classifies external transactions

**Test Type:** Integration tests (need real DB or seeded test DB)

**Critical Scenarios:**
- ✗ Concurrent payments to same client
- ✗ Collection applied before order delivered
- ✗ MP webhook arrives out of order
- ✗ Partial payment + subsequent payment
- ✗ Collection reversal

---

### 2. State Machines (NEXT PRIORITY)

**Function:** Cheque/eCheq lifecycle, Order status, Period closing

**Examples:**
- Cheque: RECEIVED → DEPOSITED → CLEARED vs REJECTED
- eCheq: ISSUED → DEBITED vs REJECTED/CANCELLED
- Order: PENDING → DELIVERED vs CANCELLED
- Period: OPEN → CLOSED (with reopen)

**Test Type:** Unit tests (state transition validation)

**Critical Scenarios:**
- ✗ Invalid transition rejected
- ✗ Rejection creates reversal entry
- ✗ Cheque endorse blocks deposit
- ✗ Closed period rejects new orders

---

### 3. Production Integrity (NEXT PRIORITY)

**Function:** Population tracking, Mortality recording, Flock state

**Examples:**
- Population = initial + SUM(events)
- Max 1 ACTIVE flock per shed
- Mortality recorded separately from production
- Recuento contradictions detected

**Test Type:** Integration tests (schema constraints + RLS)

**Critical Scenarios:**
- ✗ Two mortalities same flock/date rejected
- ✗ Two active flocks in shed rejected
- ✗ Population goes negative
- ✗ Recuento contradicts production

---

### 4. Period Closing (NEXT PRIORITY)

**Function:** Monthly close, period OPEN/CLOSED logic

**Examples:**
- Cannot INSERT order with delivery_date in CLOSED period
- Cannot INSERT financial_posting with effective_date in CLOSED period
- Reopen allowed with motivo + audit
- Period-dependent calculations recomputed

**Test Type:** Integration tests (RPC + RLS)

**Critical Scenarios:**
- ✗ Late freight can modify closed month cost
- ✗ Period reopened, closed again preserves history
- ✗ Costs don't recalculate after lock
- ✗ MP data reconciled for closed period

---

### 5. MercadoPago Reconciliation (NEXT PRIORITY)

**Function:** External payments → internal ledger

**Examples:**
- Webhook deduplication (duplicate payment received)
- N:N mapping (many MP payments → one order)
- Settlement discrepancy detection
- Unreconciled transactions aging

**Test Type:** Integration tests (MP fixture data + DB)

**Critical Scenarios:**
- ✗ Same webhook delivered twice → single posting
- ✗ Comisión calculated correctly
- ✗ Rendimiento matches expected
- ✗ Discrepancy flagged for manual review

---

## TESTING STRATEGY (RECOMMENDED)

### Phase 1: Smoke Tests (Immediate)
- 10-20 critical path tests
- Focus: Financial operations, state machines
- Framework: Vitest (fits Vite setup)
- Expected time: 2-3 days

### Phase 2: Integration Tests (Week 2)
- RPC functions with seeded data
- Period closing logic
- MP reconciliation with fixtures
- Framework: Supabase local dev + Vitest

### Phase 3: E2E Tests (Week 3+)
- Full workflows (order → delivery → collection → close)
- UI navigation, form submission
- Framework: Playwright
- Run against staging Supabase

---

## TEST STRUCTURE RECOMMENDATION

```
src/
  __tests__/
    unit/
      validations.test.ts    — Zod schemas
      calculations.test.ts   — Financial math
      state-machines.test.ts — Cheque/order states
    
    integration/
      ledger.test.ts         — Financial operations
      production.test.ts     — Flock/population
      collections.test.ts    — Payments
      mp-reconciliation.test.ts
    
    fixtures/
      mp-payments.json       — Test MP data
      seeded-db.sql          — Initial state
```

---

## LINTING

**Tool:** oxlint (v1.75.0)

**Command:** `npm run lint`

**Status:** Configured but NO test suite

**Note:** Linting catches style issues, not logic errors

---

## BUILD VERIFICATION

**Command:** `npm run build`

**Checks:**
- TypeScript compilation (`tsc -b`)
- Vite bundling

**Status:** Builds succeed but no runtime guarantees

---

## RISK SUMMARY

| Risk Level | Count | Examples |
|---|---|---|
| CRITICAL | 7+ | Financial operations, RLS, MP sync |
| HIGH | 5+ | Form validation, dates, state machines |
| MEDIUM | 3+ | UI, hooks, routing |

**Total Untested Paths:** 50+ (estimated)

**Estimated Effort to Add Tests:** 3-4 weeks full-time

---

**Conclusion:** Testing is a MAJOR gap. Start with financial operations and state machines.
