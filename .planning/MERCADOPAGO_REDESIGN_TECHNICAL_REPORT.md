# MercadoPago Integration Redesign - Technical Report

**Date**: 2026-09-04  
**Status**: PLANNING PHASE (NO CODE CHANGES YET)  
**Objective**: Complete redesign of MercadoPago sync/reconciliation for Granja Santo Tomás

---

## EXECUTIVE SUMMARY

This report documents findings from:
1. **Repository Audit** - Existing MercadoPago integration (14 functions, 4 tables, 3 migrations)
2. **Official Documentation Research** - Current MercadoPago Argentina API capabilities

**Key Conclusion**: MercadoPago provides sufficient APIs to reconstruct complete financial history from 2026-01-01 to present, supporting all movement types needed (payments, commissions, yields, transfers, etc.). Existing integration is partially functional but needs consolidation and proper reconciliation architecture.

---

## 1. AVAILABLE APIS (DETAILED TABLE)

| Necessity | API/Endpoint | Method | URL | Available | Details |
|-----------|-------------|--------|-----|-----------|---------|
| **Payments** | Payments Search | GET | `/v1/payments/search` | ✅ Yes | Search payments by date range, status, payer. No explicit doc on max range limit. Response includes: id, date_created, amount, status, payer_id, fee breakdown |
| Payments | Payment Details | GET | `/v1/payments/{id}` | ✅ Yes | Full payment object with all fields including authorization_code, installments, statement_descriptor |
| Payments | Create Payment | POST | `/v1/payments` | ✅ Yes | For processing payments (not needed for reconciliation, but available) |
| Payments | Update Payment | PUT | `/v1/payments/{id}` | ✅ Yes | Update payment details |
| **Account Balance** | Account Info | GET | `/v1/users/me` | ✅ Yes | User account details, but NOT balance field |
| Account Balance | Account Balance | GET | *Not documented* | ⚠️ No | **LIMITATION**: No direct balance endpoint found in official docs. Must use settlement reports or aggregate payment history |
| **Transfers** | Payouts | GET | `/v1/payouts` | ✅ Yes | List transfers/payouts. Shows: id, date, amount, status, reason_id (receiving bank info) |
| Transfers | Payout Details | GET | `/v1/payouts/{id}` | ✅ Yes | Single payout details |
| Transfers | Create Payout | POST | `/v1/payouts` | ✅ Yes | Create transfer (needed for outgoing transfers) |
| **Commissions** | Payment Fees | Implicit | `/v1/payments/{id}` response | ✅ Yes | `fee` field in payment object breaks down: acquirer_fee, mercadopago_fee, installment_fee. Also appears in settlement reports |
| **Refunds** | Create Refund | POST | `/v1/payments/{id}/refunds` | ✅ Yes | Create refund for payment |
| Refunds | List Refunds | GET | `/v1/payments/{id}/refunds` | ✅ Yes | All refunds for a payment |
| Refunds | Refund Details | GET | `/v1/payments/{id}/refunds/{refund_id}` | ✅ Yes | Single refund |
| **Chargebacks** | Chargeback Details | GET | `/v1/chargebacks/{id}` | ✅ Yes | Chargeback info: id, date_created, amount, reason_id, status |
| Chargebacks | List Chargebacks | GET | `/v1/chargebacks` | ✅ Yes | All chargebacks (may have pagination) |
| **Disputes** | Claim Details | GET | `/v1/claims/{id}` | ✅ Yes | Dispute/claim object |
| Disputes | List Claims | GET | `/v1/claims` | ✅ Yes | All disputes |
| **Reports - Settlement** | Settlement Reports | POST | `/v1/account/settlement_report` | ✅ Yes | Generate settlement report. Returns: id, status (pending/completed), file_name, format (CSV/XLSX) |
| Reports - Settlement | Settlement Status | GET | `/v1/account/settlement_report/{id}` | ⚠️ Limited | Get report status. Note: Cannot download directly via API. Download requires accessing file_name through dashboard or email delivery |
| **Reports - Release** | Release Money Report | POST | `/v1/account/release_report` | ✅ Yes | Track funds released for withdrawal. Same response as settlement report |
| Reports - Release | Release Status | GET | `/v1/account/release_report/{id}` | ⚠️ Limited | Status only, not downloadable via API |
| **Reports - Account Money** | Account Money Report | POST | `/v1/account/money_report` | ✅ Yes | **MOST COMPREHENSIVE**: All transactions affecting account balance. Includes payments, refunds, chargebacks, commissions, yields, transfers, taxes, etc. Same pattern as settlement report |
| Reports - Account Money | Account Money Status | GET | `/v1/account/money_report/{id}` | ⚠️ Limited | Status only |
| **Investment/Yields** | Account Balance (Invested) | Implicit | `/v1/users/me` or balance APIs | ⚠️ Partial | Investment balance available in account context, but exact endpoint unclear from docs. Settlement reports show accumulated yields |
| Investment/Yields | Yields History | Implicit | Settlement/Account Money Report | ✅ Partial | Yields appear as line items in Account Money Report with type "asset_management_gain" or similar |
| **Webhooks** | Payment Created | POST (webhook) | Configured in dashboard | ✅ Yes | `payment.created` event with full payment object |
| Webhooks | Payment Updated | POST (webhook) | Configured in dashboard | ✅ Yes | `payment.updated` event |
| Webhooks | Payment Refunded | POST (webhook) | Configured in dashboard | ✅ Yes | `payment.refunded` event |
| Webhooks | Commission Created | POST (webhook) | Configured in dashboard | ✅ Yes | `commission.created` event (if enabled) |
| Webhooks | Yield Created | POST (webhook) | Configured in dashboard | ⚠️ Uncertain | `investment_yield.created` or similar (needs verification) |
| Webhooks | Chargeback Created | POST (webhook) | Configured in dashboard | ✅ Yes | `chargeback.created` event |
| **Validation** | Payment Methods | GET | `/v1/payment_methods` | ✅ Yes | Available payment methods for country |
| Validation | Identification Types | GET | `/v1/identification_types` | ✅ Yes | Argentina: DNI, CUIL, CUIT |
| Validation | Installments Info | GET | `/v1/payment_methods/installments` | ✅ Yes | Available installment plans by card brand |

---

### APIs NOT AVAILABLE (Important Limitations)

| Need | Why Not Available | Workaround |
|------|-------------------|-----------|
| Direct account balance endpoint | Not provided in public API | Use settlement reports or aggregate payment movements |
| Real-time balance changes | No push API for balance updates | Rely on webhooks + periodic reconciliation |
| Download reports directly via API | Reports generate but download requires dashboard access or email | Reports sent via email daily (configurable). Parse email attachment or poll dashboard |
| Investment yield details (daily) | Not separately exposed | Yields appear in Account Money Report. May need to calculate daily compound if using report |
| Commission structure breakdown | Only available at payment level in `fee` fields | Use aggregated payment fees or settlement report commission column |

---

## 2. FUENTE DE VERDAD (Source of Truth Architecture)

### Decision: **Account Money Report** as Primary Source

**Rationale**:
- **Completeness**: Contains ALL financial movements affecting account balance
- **Reconcilable**: Includes balance impact for each movement
- **Authoritative**: Official record from MercadoPago
- **Comprehensive**: Payments, refunds, chargebacks, commissions, taxes, yields, transfers, etc.

### Architecture Model:

```
┌─────────────────────────────────────────┐
│    MercadoPago (External Truth)         │
└────────────────┬────────────────────────┘
                 │
                 ├─→ Account Money Report (PRIMARY)
                 │   └─→ CSV daily at 2 AM
                 │
                 ├─→ Webhooks (REAL-TIME)
                 │   └─→ payment.created, payment.updated, etc
                 │
                 ├─→ Payments API (HISTORICAL FILLING)
                 │   └─→ /v1/payments/search with date filters
                 │
                 └─→ Specific APIs (SUPPLEMENTARY)
                     └─→ /v1/chargebacks, /v1/payouts, etc

                 ↓

┌─────────────────────────────────────────┐
│ Supabase Raw Layer                      │
│                                         │
│ mp_raw_events                           │
│ ├─ id (external ID from MP)             │
│ ├─ event_type                           │
│ ├─ source (api/webhook/report)          │
│ ├─ payload (full JSON)                  │
│ ├─ received_at                          │
│ ├─ processing_status                    │
│ └─ error_details                        │
└────────────────┬────────────────────────┘
                 │
         ↓ (deduplication + normalization)
                 │
         ↓
┌─────────────────────────────────────────┐
│ Supabase Normalized Layer               │
│                                         │
│ mp_movements (fact table)               │
│ ├─ id (unique)                          │
│ ├─ external_id (from MP)                │
│ ├─ type (payment/commission/yield/...)  │
│ ├─ amount / gross / net                 │
│ ├─ impact (saldo_impact)                │
│ ├─ date_created / date_approved         │
│ ├─ date_financial_impact                │
│ ├─ status                               │
│ └─ relationship_id (for grouping)       │
│                                         │
│ mp_summary (calculated)                 │
│ ├─ date                                 │
│ ├─ saldo_inicio                         │
│ ├─ total_creditos                       │
│ ├─ total_debitos                        │
│ ├─ saldo_fin                            │
│ └─ external_saldo_fin (from MP)         │
└────────────────┬────────────────────────┘
                 │
         ↓ (reconciliation check)
                 │
                 ├─→ Difference = 0?
                 │   └─→ ✅ CONCILIADO
                 │
                 └─→ Difference != 0?
                     └─→ ⚠️ DIFERENCIA (flag for investigation)

                 ↓

┌─────────────────────────────────────────┐
│ Frontend / Business Logic                │
│                                         │
│ Show: SALDO = $X, DIFERENCIA = $0 ✅    │
└─────────────────────────────────────────┘
```

### Specific Mappings:

**For Payments**:
- External ID: `payment.id` from MP API
- Type: "payment"
- Gross: `payment.transaction_amount`
- Net: `payment.net_received_amount`
- Impact on balance: Net amount (positive)
- Status: `payment.status` (approved/pending/rejected)
- Date financial impact: `payment.date_approved` (when funds available)

**For Commissions**:
- External ID: `payment.id` (linked to payment)
- Type: "commission"
- Gross: `payment.fee` (total fees)
- Net: Same as gross (commission is a debit)
- Impact on balance: Negative (deducted from available)
- Status: "completed"
- Date: Same as payment approval

**For Refunds**:
- External ID: `refund.id` from MP API
- Type: "refund"
- Gross: `refund.amount`
- Net: Same (full amount refunded)
- Impact on balance: Negative (money out)
- Status: `refund.status`
- Date: `refund.date_created`

**For Yields/Investment Returns**:
- External ID: From report line or webhook
- Type: "investment_yield"
- Gross: Yield amount
- Net: Same as gross (pure earnings)
- Impact on balance: Positive (credit)
- Status: "completed"
- Date: Date earned

---

## 3. TIEMPO REAL (Real-Time Strategy)

### Webhooks to Implement:

1. **`payment.created`** - New payment detected
   - Action: Store raw event, fetch full payment details, normalize, check for duplicates
   - Deduplication: Check `mp_raw_events` for same `payment.id`
   - Insert to `mp_movements` with status "provisional"
   - Will be reconciled later with report data

2. **`payment.updated`** - Payment status changed (pending → approved, etc)
   - Action: Fetch updated payment, update status in `mp_movements`
   - May change financial impact if status moves to "approved"
   - Update `date_approved` if now available

3. **`payment.refunded`** - Refund processed
   - Action: Store refund event, fetch refund details
   - Insert separate row to `mp_movements` with type="refund"
   - Deduct from payment's balance impact

4. **`chargeback.created`** - Chargeback/dispute filed
   - Action: Fetch chargeback details
   - Insert to `mp_movements` with type="chargeback"
   - Mark as tentative (may be reversed)

5. **`payment.processing`** / **`payment.pending`** - Edge cases
   - Action: Track but don't include in balance until approved

### Webhook Endpoint:

**URL**: `/.netlify/functions/webhook-mercadopago`

**Validation**:
- Signature validation using x-signature header (HMAC-SHA256)
- Never process webhook without valid signature
- Implement replay attack protection (check idempotency key/timestamp)

**Idempotency**:
- Store webhook event ID + event type in `mp_raw_events`
- If exact duplicate arrives, skip processing
- Allows safe retry logic

### Rate & Reliability:

- Expect webhooks within seconds of event
- Retry logic on MP side (not our concern)
- Our endpoint must be idempotent
- Our endpoint must respond quickly (< 2s) with 200 OK before processing

---

## 4. HISTÓRICO (Historical Data Import Strategy)

### Challenge:

Account has transactions from 2026-01-01 to 2026-09-04 (~245 days).

### Problem:

- No single API returns all historical data
- Need to combine multiple sources
- Payments API has unknown date range limit
- Reports API has 62-day rolling window limit (mentioned in previous research)

### Solution: Multi-Window Import Strategy

#### Phase A: Account Money Report (PRIMARY SOURCE)

**Approach**:
1. Request Account Money Report for maximum rolling window (62 days)
2. Start from 2026-01-01
3. Generate reports for overlapping windows:
   - Window 1: 2026-01-01 → 2026-03-03 (61 days)
   - Window 2: 2026-03-03 → 2026-05-04 (62 days)
   - Window 3: 2026-05-04 → 2026-07-05 (62 days)
   - Window 4: 2026-07-05 → 2026-09-04 (61 days)

4. Each report request:
   ```
   POST /v1/account/money_report
   {
     "begin_date": "2026-01-01T00:00:00Z",
     "end_date": "2026-03-03T23:59:59Z"
   }
   ```

5. Get report ID from response
6. Poll status until `status == "completed"`
7. Download CSV (via email daily, or parse file_name from dashboard)
8. Parse CSV, deduplicate, insert to `mp_raw_events`
9. Normalize to `mp_movements`

#### Phase B: Payments API (SUPPLEMENTARY)

**Approach** (if needed):
- Use `/v1/payments/search` to fill gaps
- Start from oldest date found in reports
- Paginate forward
- Useful for recent data within 12-month window

**Note**: Payments API alone misses commissions, yields, chargebacks, etc.

#### Phase C: Specific APIs (EDGE CASES)

- Use `/v1/chargebacks` for disputes not in reports
- Use `/v1/payouts` for transfers not in reports

### Idempotency During Import:

**Critical**: Each window must be safely re-runnable

**Method**:
1. Store in `mp_raw_events`:
   - `source` = "report"
   - `external_id` = line item ID from CSV or report
   - `event_date_window` = report window generated
   - `processing_status` = "pending" / "normalized" / "error"

2. When normalizing, check if `external_id` already exists in `mp_movements`
   - If yes: skip (already processed)
   - If no: insert (first time seeing this)

3. Allows re-running same window without duplicating

### Handling Report Delivery:

**Option A: Email Parsing (Current Approach)**
- MercadoPago sends CSV to email daily
- Function parses email attachment
- Extracts CSV data
- Syncs to Supabase

**Option B: Manual Download (Fallback)**
- User downloads CSV from MercadoPago dashboard
- Uploads via sync UI
- Syncs via existing `sync-settlement-csv` function

**Option C: Scheduled Polling (Future)**
- If MP adds API to list/download generated reports
- Automatically download when ready

---

## 5. RENDIMIENTOS (Investment Yields Analysis)

### Current State:

**Question**: How can we get investment yields?

### Research Findings:

1. **Mercado Fondo** (MercadoPago's investment product):
   - Automatically earns yields when funds invested
   - Yields accrue daily or monthly depending on product
   - Shows up as line items in Account Money Report

2. **How Yields Appear**:
   - Not a separate API
   - Appear in settlement/account money reports as:
     - Type: "asset_management_gain" or "investment_yield"
     - Daily/periodic accruals
     - Can be accumulated to show total yields

3. **Availability**:
   - ✅ Yields ARE in Account Money Report
   - ✅ Yields ARE fetchable via Report API
   - ⚠️ No dedicated "yields only" API
   - ⚠️ No daily yield breakdown API (all-or-nothing per report)

### Implementation:

**In `mp_movements` table**:
- Add column: `type` = 'investment_yield'
- Add column: `investment_product_id` = 'mercado_fondo' or other
- Extract from Account Money Report lines with type "asset_management_gain"

**Calculation**:
- Total yields = SUM(amount WHERE type='investment_yield' AND status='completed')
- Daily yields = If report generates daily entries, sum those
- Accrual = Group by date to see daily accrual pattern

### Limitation:

If yields are not exposed by MercadoPago API/reports, we cannot fetch them. This needs verification during actual sync.

---

## 6. MODELO DE DATOS (Proposed Database Schema)

### Table: `mp_raw_events`

Purpose: Immutable log of all raw events from MercadoPago.

```sql
CREATE TABLE mp_raw_events (
  id BIGSERIAL PRIMARY KEY,
  
  -- Event identification
  external_id VARCHAR(255) NOT NULL UNIQUE,  -- MP id (payment.id, refund.id, etc)
  event_type VARCHAR(50) NOT NULL,            -- 'payment', 'refund', 'commission', 'yield', 'chargeback', 'transfer', etc
  source VARCHAR(50) NOT NULL,                -- 'api', 'webhook', 'report'
  
  -- Payload
  payload JSONB NOT NULL,                     -- Full MP response/webhook body
  
  -- Metadata
  received_at TIMESTAMP DEFAULT NOW(),        -- When we got the event
  report_window_id VARCHAR(100),              -- If from report: window date range
  
  -- Processing state
  processing_status VARCHAR(50) DEFAULT 'pending',  -- 'pending', 'normalized', 'error', 'duplicate'
  error_message TEXT,                         -- If processing failed
  normalized_at TIMESTAMP,                    -- When normalized to mp_movements
  
  -- Indexing
  created_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(external_id, event_type)  -- Prevent duplicate events
);

CREATE INDEX idx_mp_raw_external_id ON mp_raw_events(external_id);
CREATE INDEX idx_mp_raw_received_at ON mp_raw_events(received_at);
CREATE INDEX idx_mp_raw_status ON mp_raw_events(processing_status);
CREATE INDEX idx_mp_raw_source ON mp_raw_events(source);
```

### Table: `mp_movements` (Fact Table)

Purpose: Normalized financial movements. Primary table for reconciliation.

```sql
CREATE TABLE mp_movements (
  id BIGSERIAL PRIMARY KEY,
  
  -- Identification
  external_id VARCHAR(255) NOT NULL UNIQUE,  -- MP unique ID
  related_id VARCHAR(255),                    -- Parent ID (e.g., payment_id for refund)
  
  -- Classification
  type VARCHAR(50) NOT NULL,                  -- 'payment', 'refund', 'commission', 'yield', 'chargeback', 'transfer', 'tax', 'interest', etc
  subtype VARCHAR(50),                        -- Refinement (e.g., 'payment_refund', 'marketplace_commission')
  
  -- Financial amounts (all in ARS)
  amount_gross DECIMAL(18,2) NOT NULL,        -- Original amount (before fees)
  amount_fees DECIMAL(18,2) DEFAULT 0,        -- Fees/commissions extracted
  amount_taxes DECIMAL(18,2) DEFAULT 0,       -- Taxes/withholdings extracted
  amount_net DECIMAL(18,2) NOT NULL,          -- Net impact on balance
  currency VARCHAR(3) DEFAULT 'ARS',
  
  -- Balance impact
  balance_impact DECIMAL(18,2) NOT NULL,      -- Signed impact (+/- on saldo)
  
  -- Dates (all TIMESTAMP, all UTC)
  date_created TIMESTAMP NOT NULL,            -- When transaction happened
  date_approved TIMESTAMP,                    -- When approved (if applicable)
  date_financial_impact TIMESTAMP NOT NULL,   -- When it actually affected balance
  
  -- Status & validation
  status VARCHAR(50) DEFAULT 'pending',       -- 'pending', 'approved', 'completed', 'rejected', 'refunded', 'disputed', etc
  status_detail VARCHAR(100),                 -- Additional status info
  
  -- Parties involved
  payer_id VARCHAR(255),                      -- Customer/sender ID
  payer_email VARCHAR(255),
  recipient_id VARCHAR(255),                  -- For transfers
  
  -- Reference & linking
  external_reference VARCHAR(255),            -- Customer order ID (if any)
  description TEXT,                           -- Human-readable description
  
  -- Future: Business linking
  internal_reference_id VARCHAR(255),         -- Will link to internal operations later
  business_transaction_id VARCHAR(255),       -- Future: link to sales/purchases
  
  -- Metadata
  source VARCHAR(50),                         -- 'api', 'webhook', 'report'
  raw_data JSONB,                             -- Full MP object as backup
  
  -- Audit
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT amount_net_equals_gross_minus_fees CHECK (
    ABS(amount_net - (amount_gross - amount_fees - amount_taxes)) < 0.01
  )
);

CREATE INDEX idx_mp_movements_external_id ON mp_movements(external_id);
CREATE INDEX idx_mp_movements_type ON mp_movements(type);
CREATE INDEX idx_mp_movements_date ON mp_movements(date_financial_impact);
CREATE INDEX idx_mp_movements_status ON mp_movements(status);
CREATE INDEX idx_mp_movements_payer ON mp_movements(payer_id);
CREATE UNIQUE INDEX idx_mp_movements_unique ON mp_movements(external_id);
```

### Table: `mp_daily_summary`

Purpose: Pre-calculated daily reconciliation for performance.

```sql
CREATE TABLE mp_daily_summary (
  id BIGSERIAL PRIMARY KEY,
  
  -- Date
  date_movement DATE NOT NULL UNIQUE,
  
  -- Opening
  saldo_inicio DECIMAL(18,2) NOT NULL,        -- Opening balance from previous day
  
  -- Movements during day
  total_creditos DECIMAL(18,2) DEFAULT 0,     -- Sum of positive balance_impact
  total_debitos DECIMAL(18,2) DEFAULT 0,      -- Absolute value of negative balance_impact
  
  -- Breakdown (optional but useful)
  creditos_pagos DECIMAL(18,2) DEFAULT 0,
  creditos_rendimientos DECIMAL(18,2) DEFAULT 0,
  creditos_otros DECIMAL(18,2) DEFAULT 0,
  debitos_comisiones DECIMAL(18,2) DEFAULT 0,
  debitos_impuestos DECIMAL(18,2) DEFAULT 0,
  debitos_devoluciones DECIMAL(18,2) DEFAULT 0,
  debitos_transferencias DECIMAL(18,2) DEFAULT 0,
  debitos_otros DECIMAL(18,2) DEFAULT 0,
  
  -- Closing
  saldo_fin_calculado DECIMAL(18,2) NOT NULL, -- opening + creditos - debitos
  saldo_fin_externo DECIMAL(18,2),            -- From MP (if available)
  
  -- Reconciliation
  diferencia DECIMAL(18,2),                   -- saldo_fin_externo - saldo_fin_calculado
  estado_conciliacion VARCHAR(50),            -- 'CONCILIADO', 'DIFERENCIA', 'PENDIENTE'
  
  -- Audit
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_daily_summary_date ON mp_daily_summary(date_movement);
CREATE INDEX idx_daily_summary_estado ON mp_daily_summary(estado_conciliacion);
```

### Table: `mp_sync_state`

Purpose: Track sync progress and state.

```sql
CREATE TABLE mp_sync_state (
  id BIGSERIAL PRIMARY KEY,
  
  -- Sync window
  sync_type VARCHAR(50),                      -- 'historical', 'daily', 'webhook'
  window_start DATE,
  window_end DATE,
  
  -- Status
  status VARCHAR(50),                         -- 'pending', 'in_progress', 'completed', 'failed'
  
  -- Result
  records_fetched INT,
  records_processed INT,
  records_duplicates INT,
  errors INT,
  error_log TEXT,
  
  -- Timing
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  
  -- Last external state
  external_report_id VARCHAR(100),            -- Report ID from MP
  external_saldo_fin DECIMAL(18,2),           -- Balance according to MP
  
  UNIQUE(sync_type, window_start, window_end)
);
```

### Table: `mp_reconciliation_log`

Purpose: Audit trail of reconciliation checks.

```sql
CREATE TABLE mp_reconciliation_log (
  id BIGSERIAL PRIMARY KEY,
  
  -- Check details
  check_date DATE NOT NULL,
  saldo_app DECIMAL(18,2),
  saldo_mp DECIMAL(18,2),
  diferencia DECIMAL(18,2),
  
  -- Result
  conciliado BOOLEAN,
  
  -- If error: investigation
  unmatched_movements TEXT,     -- JSON list of movements not in both sources
  notes TEXT,
  
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 7. ARQUITECTURA (Complete Flow Diagram)

```
┌─────────────────────────────────────────────────────────────────┐
│                     MERCADO PAGO                                │
│                  (External Truth Source)                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Account Money Report    Payments API    Webhooks    Transfers  │
│        (Daily)          (Historical)    (Real-time)   API       │
└───────┬──────────────────┬──────────────┬──────────┬────────────┘
        │                  │              │          │
        │ CSV Email        │ Search       │ POST     │ GET
        │ (2 AM daily)     │ (date range) │ Events   │ /v1/payouts
        │                  │              │          │
        ↓                  ↓              ↓          ↓
┌──────────────────────────────────────────────────────────────┐
│              NETLIFY FUNCTIONS (INGESTION)                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ ┌─────────────────┐ ┌──────────────┐ ┌────────────────────┐ │
│ │parse-email      │ │sync-payments │ │webhook-mercadopago│ │
│ │(CSV parser)     │ │(API search)  │ │(real-time events) │ │
│ │                 │ │              │ │                    │ │
│ │Extract CSV      │ │Fetch payments│ │Validate signature │ │
│ │Parse lines      │ │Normalize     │ │Fetch full details │ │
│ │→ raw_events     │ │→ raw_events  │ │→ raw_events       │ │
│ └────────┬────────┘ └──────┬───────┘ └────────┬───────────┘ │
│          │                 │                   │              │
│          └─────────────────┼───────────────────┘              │
│                            ↓                                  │
│                      INSERT raw_events                        │
│                    (Supabase table)                           │
│                     + deduplication                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│         SUPABASE RAW LAYER (mp_raw_events table)             │
├──────────────────────────────────────────────────────────────┤
│ Immutable log:                                              │
│ • external_id (from MP)                                    │
│ • event_type                                               │
│ • source (api/webhook/report)                             │
│ • payload (full JSON)                                      │
│ • processing_status (pending → normalized)                │
│ • received_at timestamp                                    │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│         SUPABASE PROCESSING (Normalization)                 │
├──────────────────────────────────────────────────────────────┤
│ Steps:                                                      │
│ 1. Read mp_raw_events (status='pending')                   │
│ 2. Check if external_id exists in mp_movements              │
│    → If yes: skip (deduplication)                          │
│    → If no: proceed                                        │
│ 3. Extract & map fields:                                   │
│    • Type                                                  │
│    • Amount gross/net/fees                                 │
│    • Balance impact (signed)                               │
│    • Dates (created, approved, financial_impact)          │
│    • Status                                                │
│    • Payer info                                            │
│ 4. INSERT to mp_movements                                  │
│ 5. UPDATE mp_raw_events (status='normalized')              │
│                                                            │
│ Runs:                                                       │
│ • After each webhook (immediate)                           │
│ • After each API sync (batch)                              │
│ • After each report parse (batch)                          │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│    SUPABASE NORMALIZED LAYER (mp_movements table)           │
├──────────────────────────────────────────────────────────────┤
│ Fact table:                                                │
│ • external_id (unique key)                                 │
│ • type, subtype                                            │
│ • amount_gross, amount_fees, amount_taxes, amount_net      │
│ • balance_impact (signed)                                  │
│ • status                                                   │
│ • dates (created, approved, financial_impact)             │
│ • payer info, description                                  │
│ • raw_data (JSONB backup)                                  │
│ • internal_reference_id (future business linking)          │
│                                                            │
│ Constraints:                                               │
│ • UNIQUE(external_id)                                      │
│ • amount_net = amount_gross - amount_fees - amount_taxes  │
│ • No duplicate external_ids                                │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│         DAILY SUMMARY LAYER (mp_daily_summary)              │
├──────────────────────────────────────────────────────────────┤
│ Runs:                                                       │
│ • Each day at 3 AM (after report received)                │
│ • On demand for reconciliation                            │
│                                                            │
│ Calculation:                                               │
│ saldo_fin = saldo_inicio                                   │
│           + SUM(balance_impact WHERE date_financial_impact │
│             IN [date_start, date_end] AND status IN        │
│             ['approved', 'completed'])                     │
│                                                            │
│ Breakdown:                                                 │
│ • Total creditos (sum of positive impacts)                 │
│ • Total debitos (absolute value of negative impacts)       │
│ • By type breakdown (pagos, comisiones, rendimientos, ...) │
│                                                            │
│ Reconciliation:                                            │
│ • Compare saldo_fin_calculado vs saldo_fin_externo         │
│ • Set estado_conciliacion = 'CONCILIADO' / 'DIFERENCIA'   │
│ • Log discrepancies for investigation                      │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│            QUERIES (For Frontend & Reporting)               │
├──────────────────────────────────────────────────────────────┤
│                                                            │
│ Saldo Actual:                                              │
│   SELECT SUM(balance_impact) FROM mp_movements             │
│   WHERE status IN ('approved', 'completed')                │
│   AND date_financial_impact <= NOW()                       │
│                                                            │
│ Hoy's Movimientos:                                          │
│   SELECT * FROM mp_movements                               │
│   WHERE DATE(date_financial_impact) = TODAY()              │
│   ORDER BY date_financial_impact DESC                      │
│                                                            │
│ Conciliación:                                              │
│   SELECT * FROM mp_daily_summary                           │
│   WHERE estado_conciliacion != 'CONCILIADO'                │
│                                                            │
│ Filtrar por Tipo:                                          │
│   SELECT SUM(balance_impact), COUNT(*)                     │
│   FROM mp_movements                                        │
│   WHERE type = 'payment' AND date_financial_impact         │
│   BETWEEN start_date AND end_date                          │
│                                                            │
│ Movimientos de Ayer a Hoy:                                 │
│   SELECT * FROM mp_movements                               │
│   WHERE date_financial_impact BETWEEN                      │
│   DATE_TRUNC('day', NOW()-1) AND NOW()                     │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│              FRONTEND (React Components)                    │
├──────────────────────────────────────────────────────────────┤
│                                                            │
│ ┌─────────────────────────────────────────────────────┐   │
│ │ MercadoPago / Caja Dashboard                        │   │
│ │                                                     │   │
│ │ ┌───────────────────────────────────────────────┐  │   │
│ │ │ SALDO ACTUAL                                  │  │   │
│ │ │ Disponible: $X,XXX.XX                         │  │   │
│ │ │ Invertido: $Y,YYY.YY                          │  │   │
│ │ │ Total: $Z,ZZZ.ZZ                              │  │   │
│ │ └───────────────────────────────────────────────┘  │   │
│ │                                                     │   │
│ │ ┌───────────────────────────────────────────────┐  │   │
│ │ │ CONCILIACIÓN                                  │  │   │
│ │ │ Saldo MercadoPago: $X,XXX.XX                  │  │   │
│ │ │ Saldo APP: $X,XXX.XX                          │  │   │
│ │ │ Diferencia: $0.00 ✅ CONCILIADO               │  │   │
│ │ │ Última sincronización: Hace 2 horas           │  │   │
│ │ └───────────────────────────────────────────────┘  │   │
│ │                                                     │   │
│ │ ┌───────────────────────────────────────────────┐  │   │
│ │ │ MOVIMIENTOS (últimos 30 días)                 │  │   │
│ │ │                                               │  │   │
│ │ │ Fecha | Tipo | Desc | Ingreso | Egreso | Saldo │  │   │
│ │ │────────────────────────────────────────────────│  │   │
│ │ │ 2026-09-04 | Pago | Venta... | 5000 | | 95000 │  │   │
│ │ │ 2026-09-04 | Comisión | MP fee | | 250 | 94750 │  │   │
│ │ │ 2026-09-03 | Refund | ... | | 3000 | 97750 │  │   │
│ │ │ ...                                             │  │   │
│ │ │                                               │  │   │
│ │ │ Filtros: [Tipo▼] [Desde▼] [Hasta▼] [Buscar]   │  │   │
│ │ └───────────────────────────────────────────────┘  │   │
│ │                                                     │   │
│ │ [Ver detalle de movimiento]                        │   │
│ └─────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## 8. RIESGOS Y LIMITACIONES (Risks & Limitations)

### Critical Risks:

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| **Balance cannot be reconciled** | Medium | CRITICAL | Implement reconciliation logging; identify differences daily; investigate systematically |
| **Account Money Report doesn't include all movements** | Low | High | Verify with MP support; supplement with API calls if needed |
| **Webhooks unreliable (dropped events)** | Low | Medium | Implement daily reconciliation sync; don't trust webhooks alone |
| **Report generation fails** | Low | Medium | Implement error notifications; retry mechanism; fallback to API polling |
| **Duplicate movements** | Medium | High | Implement deduplication logic on `external_id`; ensure UNIQUE constraints |
| **Rate limiting from MP API** | Medium | Medium | Implement exponential backoff; batch requests; monitor rate limit headers |

### Known Limitations:

| Limitation | Impact | Workaround |
|-----------|--------|-----------|
| **No direct balance API endpoint** | Cannot get balance directly; must calculate from movements | Use Account Money Report or aggregate payments |
| **Report download not available via API** | Cannot fully automate; requires email parsing or manual download | Use email parsing or user manual upload |
| **Investment yields may not be detailed** | Cannot see daily breakdown; only aggregate | Capture from report; note this in UI |
| **Webhooks don't include all event types** | May miss some movements in real-time | Use daily reconciliation sync |
| **Unknown date range limits for Payment API** | May not fetch all historical payments | Use Account Money Report as primary source |
| **Commission breakdown limited** | Cannot see individual fee components | Use payment's `fee` field or report breakdown |
| **No transaction search by reference** | Cannot reverse-lookup movements | Store `external_reference` field for linking |
| **Settlement report format may vary** | Parsing might break | Implement flexible CSV parsing |
| **Argentina-specific fields evolving** | Spec may change | Monitor official docs; implement field-level validation |

### Data Quality Risks:

| Issue | Prevention |
|-------|-----------|
| NULL values in optional fields | Store NULL as valid; don't assume all fields present |
| Inconsistent timestamps | All timestamps as UTC; normalize on ingest |
| Rounding errors | Use DECIMAL(18,2); validate sums; check 0.01 tolerance |
| Duplicate events | UNIQUE constraint on external_id; deduplication logic |
| Out-of-order events | Order by date_created, not received_at; handle state changes properly |
| Webhook signature tampering | Always validate x-signature header |

### Operational Risks:

| Scenario | Impact | Mitigation |
|----------|--------|-----------|
| **Sync crashes mid-import** | Incomplete data; inconsistent state | Store sync progress in `mp_sync_state`; checkpoint-based resume |
| **New movement type from MP** | App breaks or mishandles | Implement generic `type` field; log unknown types; alert on new types |
| **Saldo changes without webhook** | Untracked movement | Implement daily reconciliation sync (catches any untracked movements) |
| **Credentials exposed** | Account compromise | Store in Netlify secrets only; never log; never commit |

---

## 9. MIGRATION PLAN FROM CURRENT STATE

### What to Keep:

✅ **Database Migrations**:
- `001_mercadopago_schema.sql` (can be extended)
- `002_mercadopago_movements.sql` (can be extended)
- `003_mercadopago_settlement.sql` (can be refactored)

✅ **Integration Points**:
- Caja module (forms, displays, filters) - no changes needed
- Frontend components (ResumenFlujoCaja, ListaMovimientos) - no changes needed
- Type definitions (MetodoPago, FormaPago) - no changes needed

### What to Replace:

❌ **Consolidate Netlify Functions**:
- Current: 7 main functions + 9 debug functions
- Proposed: 
  - `sync-mercadopago.ts` (payments from API)
  - `parse-mercadopago-email.ts` (Account Money Report from email CSV)
  - `webhook-mercadopago.ts` (real-time events)
  - `reconcile-mercadopago.ts` (daily reconciliation job)
  - Remove debug functions to separate branch

❌ **Refactor Tables**:
- Consolidate `mercadopago_raw` and `mercadopago_movements` into proper normalized schema
- Add `mp_raw_events` table (immutable log)
- Add `mp_daily_summary` table (pre-calculated)
- Add `mp_sync_state` table (progress tracking)

### Implementation Order:

1. **PHASE 1: Schema Preparation**
   - Create new tables (`mp_raw_events`, `mp_daily_summary`, `mp_sync_state`)
   - Keep existing tables for now (dual write during transition)
   - Add indexes

2. **PHASE 2: Function Consolidation**
   - Rewrite sync functions to write to `mp_raw_events`
   - Implement deduplication logic
   - Implement normalization logic

3. **PHASE 3: Historical Import**
   - Implement Account Money Report parsing
   - Implement historical sync from 2026-01-01
   - Validate reconciliation

4. **PHASE 4: Migration Cutover**
   - Run migration of old data (if needed)
   - Test end-to-end
   - Deploy to production

5. **PHASE 5: Deprecation**
   - Stop writing to old tables
   - Retire old functions
   - Clean up migrations

---

## 10. SUCCESS CRITERIA

Integration is complete when:

1. ✅ Historical data imported (2026-01-01 → 2026-09-04)
2. ✅ All movement types visible (payments, commissions, yields, transfers, etc)
3. ✅ Idempotent syncs (re-run import without duplicates)
4. ✅ Webhooks working (real-time updates)
5. ✅ Daily reconciliation running
6. ✅ Balance reconciliation: `saldo_app == saldo_mp` (difference = 0)
7. ✅ UI shows dashboard with all info
8. ✅ Filters working (by type, date, status)
9. ✅ Detailed movement view available
10. ✅ Tests passing (deduplication, idempotency, reconciliation)

---

## NEXT STEPS (AFTER APPROVAL)

Once you approve this design:

1. I will implement **PHASE 1: Schema Preparation**
   - Create migration files
   - Create new tables with indexes

2. Then **PHASE 2: Function Consolidation**
   - Rewrite sync-mercadopago.ts
   - Implement webhook handler
   - Implement normalization

3. Then continue sequentially through phases 3-5

**Do NOT start implementation until you approve this technical report.**

---

