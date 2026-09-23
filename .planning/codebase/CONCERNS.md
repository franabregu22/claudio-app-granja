# Technical Debt & Risk Analysis: Claudio App Granja

**Analysis Date:** 2026-09-23  
**Codebase:** React 19 + Vite + TypeScript + Supabase + MercadoPago Integration  
**Status:** High-risk production codebase with significant technical debt

---

## 1. DATA INTEGRITY RISKS

### 1.1 Multiple Sources of Truth - Pedidos Total Amount (HIGH)
**Location:** src/api/pedidos.ts lines 56-78

**Issue:** The monto_total field is always recalculated from line items instead of being trusted. This indicates known divergence between stored and calculated totals.

**Risk:**
- Stored values become stale/unreliable
- No automatic sync when lineas change
- Data quality issues evident from NaN/invalid checks
- Inconsistency if lineas deleted without total update

**Impact:** MEDIUM - Reports may be incorrect

---

### 1.2 Ledger Entry Balance Validation Failures (HIGH)
**Location:** src/api/mercadopago.ts lines 38-44

**Issue:** Code validates each mp_financial_movement has exactly 1 ledger_entry with matching balance_impact. Throws error if mismatch found, making entire query fail.

**Risk:**
- System encounters records with mismatched ledger entries
- No graceful degradation - dashboards become unavailable
- Root cause not addressed, only error detection
- Unknown how often this occurs

**Impact:** HIGH - System can become unusable during inconsistencies

---

### 1.3 Movement Classification Mapping Issues (HIGH)
**Location:** Netlify functions, documented in ANALISIS_4_PROBLEMAS_CRITICOS.md

**Issue:** Movement classification differs incorrectly:
- asset_management mapped to PAYMENT instead of yield
- Net amounts inconsistently handled (centavos vs pesos)
- Reserve movements may be classified wrong

**Risk:**
- Income categorization incorrect in reports
- Historical data has wrong classifications
- Webhook-triggered movements diverge from CSV imports

**Impact:** HIGH - Financial reporting unreliable

---

### 1.4 Webhook Duplicate Processing Risk (HIGH)
**Location:** 
etlify/functions/webhook-mercadopago.ts lines 156-289

**Issue:** No idempotency guarantee:
- Only checks if movement exists AFTER receiving webhook
- No request-level deduplication
- Multi-step creation (source → movement → link → ledger) not transactional
- Failure between steps causes inconsistent state

**Risk:**
- Duplicate webhook events create duplicate ledger entries
- Balance calculations become wrong
- MercadoPago may retry on timeout

**Impact:** MEDIUM - Financial records duplicated, balances wrong

---

## 2. CODE ARCHITECTURE ISSUES

### 2.1 Production Debug Code (MEDIUM)
**Location:** 150+ console.log/error/warn calls throughout codebase

**Examples:** 
- webhook-mercadopago.ts: 20+ console.logs
- sync-mercadopago-releases-status.ts: 25+ console.logs
- 10+ debug-*.ts files with debug code

**Risk:**
- Console noise makes debugging difficult
- Possible sensitive data in logs
- Performance overhead
- Indicates incomplete development

**Impact:** LOW - Operational

---

### 2.2 Multiple Mercadopago Sync Implementations (HIGH)
**Location:** 29 Netlify functions for MercadoPago sync

**Different implementations:**
- sync-mercadopago.ts
- sync-mercadopago-movements.ts
- sync-mercadopago-releases-status.ts
- sync-mercadopago-period.ts
- quick-sync.ts
- And 24 more variants...

**Risk:**
- Unclear which is current/recommended
- Code duplication, inconsistent error handling
- Difficult to maintain and test
- Data sync reliability unknown

**Impact:** HIGH - Core business function unreliable

---

### 2.3 Legacy + New Data Structures (MEDIUM)
**Location:** src/types/domain.ts lines 8-14, 59-62

**Issue:** Supporting both old and new formats:
- Old: Lineas object structure
- New: LineaPedido array structure
- Both exist in database and code

**Risk:**
- Code complexity high
- Migrations incomplete
- Harder to reason about data state

**Impact:** MEDIUM - Code complexity, migration debt

---

## 3. DATABASE CONCERNS

### 3.1 Duplicate Migration Numbers (HIGH)
**Location:** supabase/sql/ directory

**Duplicates found:**
- 008_reconciliation_helpers.sql, reconciliation_rpc.sql, update_clients_and_prices.sql
- 016_cleanup_schema.sql, simplify_schema.sql
- 024_add_categoria_fields.sql, create_lotes_table.sql
- 043_normalize_galpon_tildes_all.sql, tildes_producciones.sql

**Risk:**
- Unclear migration ordering
- Some may overwrite others
- Schema state unknown/unreliable
- Supabase system may not execute all

**Impact:** HIGH - Database schema state is uncertain

---

### 3.2 Missing Foreign Key Constraints (MEDIUM)
**Location:** Database schema

**Issue:** *_id fields lack explicit foreign keys:
- movimientos_caja.cliente_id → clientes
- pago_en_caja.pago_id → pagos
- Various other relationships

**Risk:**
- Orphaned records possible
- No cascade delete/update enforcement
- Data consistency not guaranteed at DB level

**Impact:** MEDIUM - Data integrity not enforced

---

### 3.3 RLS Policy Coverage Gaps (MEDIUM)
**Location:** supabase/sql/003_rls_policies.sql and later

**Issue:** RLS enabled on basic tables but unclear on critical finance tables:
- mp_financial_movement - critical finance data
- ledger_entry - financial ledger
- mercadopago_raw - webhook data
- webhook_events - audit trail

**Risk:**
- Unauthorized users may read financial data
- Webhooks (unauthenticated) have unrestricted access
- Audit trail not protected

**Impact:** MEDIUM - Security and privacy

---

## 4. INTEGRATION RISKS

### 4.1 MercadoPago Sync Reliability (HIGH)
**Location:** 29 Netlify functions for MP synchronization

**Concerns:**
- Multiple competing implementations
- CSV parsing error-prone
- Unit conversions (centavos ↔ pesos) complex
- No retry logic with exponential backoff
- State machine not documented
- Analysis shows 4 critical unresolved problems (ANALISIS_4_PROBLEMAS_CRITICOS.md)

**Risk:**
- Data sync can fail silently
- Partial syncs leave system inconsistent
- Manual intervention required to recover
- Reconciliation issues documented

**Impact:** HIGH - Core business function unreliable

---

### 4.2 Webhook Security/Reliability (MEDIUM)
**Location:** 
etlify/functions/webhook-mercadopago.ts

**Issues:**
- HMAC validation correct but only validates signature
- Idempotency not guaranteed (see section 1.4)
- No rate limiting
- No timeout enforcement
- Fire-and-forget error handling

**Risk:**
- DoS possible via webhook flooding
- Duplicate/partial processing possible
- Some failures silent

**Impact:** MEDIUM - Webhook reliability

---

## 5. TESTING GAPS

### 5.1 No Tests Whatsoever (CRITICAL)
**Location:** src/ directory has 0 test files

**Missing coverage:**
- All 50+ API CRUD functions
- Business logic (calculations, reconciliation)
- Integration flows (payment → caja)
- Financial operations (ledger, balance)
- Webhook processing
- Data migrations/conversions

**Impact:** CRITICAL - No safety net for refactoring, regressions undetected

**Recommendation:** 
- Implement unit tests for all API functions
- Integration tests for critical flows:
  - Pedido creation → Line items → Total sync
  - Payment creation → Caja linking
  - Webhook → Financial movement → Ledger entry

---

## 6. PERFORMANCE CONCERNS

### 6.1 N+1 Query Pattern: Auth System (LOW)
**Location:** src/auth/AuthProvider.tsx lines 21-72

**Issue:** On every auth change:
1. Get session (1 query)
2. Query perfiles by id (1 query)

**Risk:** LOW - Supabase caches efficiently, but not optimal

---

### 6.2 Index Strategy Unknown (LOW)
**Location:** Schema shows minimal indexes

**Risk:**
- Frequently queried tables may lack indexes:
  - mp_financial_movement (account_id, transaction_date)
  - ledger_entry (account_id, occurred_at)
  - movimientos_caja (fecha_operacion, tipo)

**Impact:** LOW-MEDIUM - Performance under scale

---

## 7. SECURITY CONCERNS

### 7.1 Environment Variables Validation (MEDIUM)
**Location:** Netlify functions use process.env directly

**Issues:**
- No startup validation of required secrets
- Secret checks happen at runtime
- Misconfiguration not caught early

**Impact:** MEDIUM - Silent failures possible

---

### 7.2 Webhook Rate Limiting Missing (MEDIUM)
**Location:** 
etlify/functions/webhook-mercadopago.ts

**Risk:**
- WebHook could be flooded
- No IP whitelist checking
- No request throttling

**Impact:** MEDIUM - Webhook vulnerability

---

## 8. OPERATIONAL CONCERNS

### 8.1 Unclear Deployment Process (MEDIUM)
**Location:** 
etlify/functions/ and Supabase migrations

**Issues:**
- 29 functions, unclear which are deployed
- Migrations have gaps and duplicates
- No changelog or deployment notes
- Database state management unclear

**Impact:** MEDIUM - Inconsistent production state

---

### 8.2 Error Monitoring Missing (MEDIUM)
**Location:** Throughout codebase

**Issues:**
- No structured error logging system
- No error aggregation/alerting
- No trace correlation for debugging

**Risk:**
- Critical issues may go unnoticed
- Difficult to debug in production

**Impact:** MEDIUM

---

## SUMMARY BY SEVERITY

### CRITICAL (1 issue)
- 5.1: No tests whatsoever

### HIGH (6 issues)
1. 1.1: Pedidos monto_total - Multiple sources of truth
2. 1.2: Ledger validation - Failures throw but don't fix
3. 1.3: Movement classification - Incorrect mappings
4. 1.4: Webhook duplicates - No idempotency
5. 3.1: Duplicate migrations - Schema state uncertain
6. 4.1: MercadoPago sync - Unclear implementations

### MEDIUM (13 issues)
1. 2.1: Production debug code - 150+ console.logs
2. 2.2: Multiple sync implementations - Code duplication
3. 2.3: Legacy data structures - Both formats supported
4. 3.2: Missing FK constraints - No DB enforcement
5. 3.3: RLS policy gaps - Finance tables unprotected
6. 4.2: Webhook reliability - Rate limiting missing
7. 6.1: N+1 queries - Auth system
8. 6.2: Index strategy - Performance under scale
9. 7.1: Environment validation - No startup checks
10. 7.2: Webhook rate limiting - Missing
11. 8.1: Deployment unclear - Migration management
12. 8.2: Error monitoring - No aggregation

### LOW (3 issues)
1. Field naming inconsistencies
2. Offset pagination instead of cursor
3. Some fire-and-forget async operations

---

## IMMEDIATE ACTION ITEMS

**Within 1 week:**
- [ ] Remove all console.logs from production code
- [ ] Document which MercadoPago sync function is "official"
- [ ] Audit webhook for idempotency issues
- [ ] Verify migration execution order
- [ ] Check RLS policies on financial tables

**Within 1 month:**
- [ ] Implement unit tests for API layer (high-value coverage)
- [ ] Resolve pedidos monto_total inconsistency
- [ ] Consolidate duplicate migrations
- [ ] Implement structured error logging system
- [ ] Add deployment documentation

**Within 3 months:**
- [ ] Complete test coverage (aim for 80%+)
- [ ] Refactor MercadoPago sync into single implementation
- [ ] Add database constraints (FK, NOT NULL)
- [ ] Implement error monitoring/alerting
- [ ] Clean up diagnostic/debug functions
