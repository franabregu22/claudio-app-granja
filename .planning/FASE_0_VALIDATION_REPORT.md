# FASE 0 — VALIDATION REPORT
## Mercado Pago Integration Redesign

**Date**: 2026-09-04  
**Status**: ANALYSIS COMPLETE — NO CODE CHANGES YET  
**Objective**: Validate architecture design against real project state and official MercadoPago APIs

---

## A. CURRENT PROJECT STATE

### Stack Confirmed

**Frontend**:
- React 19.2.8 + TypeScript 6.0
- Vite 8.2.0 build tool
- Tailwind CSS 4.3.3
- TanStack React Query 5.101.4 (server state)
- Supabase SDK 2.112.2
- PWA support (Service Worker + offline capability)

**Backend**:
- **Netlify Functions** (primary): 24 TypeScript functions
- **Supabase Edge Functions** (supplementary): 2 Deno functions
- **Scheduled Jobs**: GitHub Actions (every 4 hours)
- **Authentication**: Supabase Auth (email/password + Google OAuth)

**Database**:
- **Supabase PostgreSQL**
- **21+ tables** confirmed
- **47 SQL migrations** (organized, ordered)
- **Row-Level Security (RLS)**: 71 policies across tables
- **Scheduled Jobs at DB Level**: Possible via `pg_cron` (not confirmed if enabled)

**Deployment**:
- **Netlify** (confirmed by netlify.toml + live URL: https://santotomasapp.netlify.app)
- Auto-deploy on push to main
- Environment variables via Netlify dashboard

### Key Existing Tables (Relevant to Reconciliation)

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `movimientos_caja` | Cash box movements | tipo, concepto, monto, forma_pago ('mercadopago', 'efectivo', 'echeq', 'cheque'), estado, fecha_operacion, fecha_pago |
| `pagos` | Customer payments received | cliente_id, monto, metodo_pago ('mercadopago', 'transferencia', 'efectivo', 'tarjeta'), fecha_pago, estado |
| `mercadopago_raw` | Raw MP payment data | id (TEXT), transaction_amount, net_received_amount, status, date_created, date_approved, money_release_date, payer_id, raw_data (JSONB) |
| `sync_metadata` | Sync tracking | sync_type, last_sync_date, last_sync_count |

### Existing Mercado Pago Integration

**Status**: Partial, working but not optimized for full reconciliation

**Implemented**:
- ✅ Payment sync via `/v1/payments/search` (every 4 hours)
- ✅ Webhook handler (`payment.created`, `payment.updated`)
- ✅ Settlement report generation + CSV parsing
- ✅ Raw data storage (JSONB backup)
- ✅ Sync metadata tracking
- ✅ Manual sync UI (`sync-settlement.html`)
- ✅ Email CSV parser (`parse-mercadopago-email.ts`)

**Limitations Identified**:
- ❌ No explicit reconciliation logic (saldo app vs saldo MP)
- ❌ No daily summary/snapshot tables
- ❌ Settlement report download not automated (requires email parsing or manual download)
- ❌ No webhook signature validation (commented out)
- ❌ `processed` flag in `mercadopago_raw` created but never updated
- ❌ `webhook_events` table referenced but may not exist
- ❌ No clear handling of commission/tax breakdown
- ❌ No explicit yield/investment tracking
- ❌ Duplicate prevention relies on `id` uniqueness only
- ❌ No transaction type categorization (all treated as payments)

**Functions to Keep/Reuse**:
- `sync-mercadopago.ts` - Core logic can be adapted
- `webhook-mercadopago.ts` - Foundation for real-time events
- `sync-settlement-csv.ts` - CSV parsing logic reusable
- Database migrations - Schema foundation solid

**Functions to Consolidate/Remove**:
- Multiple debug functions (`debug-*.ts`, `explore-mp-api.ts`, `find-statement-endpoint.ts`, `try-settlement.ts`, `setup-settlement-config.ts`, `check-data.ts`) → Move to separate branch or remove
- Duplicate sync functions (`sync-settlement-proper.ts`, `settlement-full-flow.ts`, `test-small-report.ts`) → Consolidate into one

---

## B. PROBLEMS FOUND IN PREVIOUS DESIGN

### Critical Issues

1. **`external_id UNIQUE` Over-Simplified**
   - Problem: Same economic transaction can appear from 3 sources (Report + API + Webhook)
   - Consequence: Would create 3 rows for same payment or forced deduplication logic
   - Fix Needed: Distinguish between "source records" and "financial movements"

2. **Assumed Balance Calculation**
   - Problem: Design proposed `SUM(balance_impact)` = `observed_balance` without validation
   - Consequence: Silent discrepancies if MP uses different balance definition
   - Fix Needed: Verify exact definition of "balance" in MP + validate against real account

3. **Webhook Reliability Unexamined**
   - Problem: Design relied on webhooks as supplementary without testing retry behavior
   - Consequence: Dropped webhook events could silently create gaps
   - Fix Needed: Implement reconciliation sync to catch missed events

4. **Amount Structure Oversimplified**
   - Problem: Assumed all movements follow `gross = net + fees + taxes`
   - Consequence: Yields, transfers, adjustments may not fit this model
   - Fix Needed: Flexible amount structure per movement type

5. **Yield/Investment Representation Invented**
   - Problem: Assumed webhooks like `investment_yield.created` exist without confirmation
   - Consequence: Architecture designed for non-existent events
   - Fix Needed: Verify how yields actually appear in data

6. **Report Download Not Automated**
   - Problem: Design assumed direct API download of reports (doesn't exist)
   - Consequence: Cannot fully automate without email parsing or manual intervention
   - Fix Needed: Implement email parsing or polling for completed reports

---

## C. MERCADO PAGO CAPABILITIES — CONFIRMED VS PENDING

### CONFIRMED (By Official Documentation)

#### Account Money Report
- ✅ Exists: POST/GET `/v1/reports/account_money`
- ✅ Generates CSV/XLSX with all financial movements
- ✅ Parameters: `date_begin`, `date_end`, `columns` array
- ✅ Returns: Report ID + status (pending/completed)
- ✅ Downloadable: Yes, via file URL in response
- ✅ Date range: Customizable
- ✅ Columns available: TRANSACTION_TYPE, SETTLEMENT_NET_AMOUNT, NET_CREDIT, NET_DEBIT, TRANSACTION_DATE, SOURCE_ID, EXTERNAL_REFERENCE, +others
- ✅ TRANSACTION_TYPE values confirmed: SETTLEMENT, REFUND, CHARGEBACK, DISPUTE, WITHDRAWAL

#### Payment Status
- ✅ Webhook events: `payment.created`, `payment.updated`
- ✅ Payment ID: Unique, guaranteed (`id` field)
- ✅ Status values: `approved`, `pending`, `in_process`, `rejected`, `cancelled`, `refunded`, `in_mediation`
- ✅ Date fields: `date_created`, `date_approved`, `money_release_date`
- ✅ Fee fields: `fee` (MP commission), `commission` (marketplace fee)
- ✅ Webhook validation: HMAC-SHA256 via `x-signature` header

#### Transfers/Refunds
- ✅ Refund API: POST/GET `/v1/payments/{id}/refunds`
- ✅ Refund ID: Unique
- ✅ Payout history: Available (WITHDRAWAL in Account Money Report)
- ✅ Idempotency: Required `X-Idempotency-Key` header

#### Argentina-Specific
- ✅ Currency: ARS only
- ✅ Identification: DNI, CUIL, CUIT supported
- ✅ Payment methods: Bank transfers (CBU), debit cards, cash deposits

#### Security
- ✅ Bearer token authentication
- ✅ x-signature header for webhook validation
- ✅ Service role key for backend-only access

---

### PARTIAL / INFERRED (Not Explicitly Documented)

⚠️ **Transfers API**:
- Endpoint `/v1/transfers` or `/v1/payouts` not explicitly confirmed
- May only be accessible via `/v1/payouts` for retrieving history
- Bank transfer initiation may be dashboard-only

⚠️ **Balance Endpoint**:
- Reference to `/users/{USER_ID}/mercadopago_account/balance` found
- Exact response structure not confirmed
- Available/unavailable split not clarified

⚠️ **Webhook Event List**:
- Only `payment.created` and `payment.updated` confirmed
- "Other events" mentioned but not listed
- Commission webhooks not mentioned

⚠️ **Report Maximum Date Range**:
- Customizable range mentioned
- Maximum days not specified in docs (need validation)

⚠️ **Yield/Investment Representation**:
- Mercado Fondo exists (investment product)
- Daily yields mentioned
- **How yields appear in API/reports**: NOT DOCUMENTED

---

### PENDING VALIDATION (Cannot Confirm — Needs Real Data)

❌ **Complete TRANSACTION_TYPE List**:
- Documented: SETTLEMENT, REFUND, CHARGEBACK, DISPUTE, WITHDRAWAL
- Unknown: Yield/investment type, fees type, taxes type, adjustments, cashback, interest, other debits/credits

❌ **Yield Representation**:
- How do investment yields appear in Account Money Report?
- What is the TRANSACTION_TYPE value for yields?
- Is there a separate yields API?
- Can yields be queried programmatically?

❌ **Balance Definition**:
- What exactly does MercadoPago report as "balance"?
- Available + Unavailable = Total?
- Does it include unavailable pending funds?
- Does it include invested funds separately?

❌ **Settlement Report Date Limits**:
- Is there a maximum number of days per report?
- If yes, what's the limit? (60 days? 90 days?)

❌ **How to Correlate Across Sources**:
- Same payment from Report + API + Webhook: guaranteed same ID?
- Can a payment appear multiple times?
- How to detect duplicates if IDs differ?

❌ **Webhook Behavior**:
- What's the exact retry policy? (4 days mentioned, but exact schedule?)
- Can webhook payload differ from API response?
- Which events include commission/tax details?

❌ **Transfers Complete Structure**:
- Transfer/Payout object fields not fully documented
- How to distinguish transfer types programmatically?
- Status values for transfers?

❌ **Pending Transactions in Report**:
- Do pending payments appear in Account Money Report?
- With what TRANSACTION_TYPE?
- At what state do they transition to final type?

❌ **Fee Breakdown Detail**:
- Can you see MercadoPago fee separate from acquirer fee?
- Commission breakdown (marketplace % vs MP %)?
- Tax/withholding details?

❌ **Refund Dates**:
- Refund object has same date fields as payment?
- When does refund actually impact balance (date_approved vs money_release_date)?

---

## D. ACCOUNT MONEY REPORT — CRITICAL POINTS

### How to Use It

**Generation**:
```
POST /v1/reports/account_money
{
  "date_begin": "2026-01-01T00:00:00Z",
  "date_end": "2026-03-01T23:59:59Z",
  "columns": ["TRANSACTION_TYPE", "SETTLEMENT_NET_AMOUNT", "NET_CREDIT", "NET_DEBIT", ...]
}
```

**Response**:
```json
{
  "id": "report_id_12345",
  "status": "pending|completed",
  "file_name": "report_file.csv",
  "download_url": "https://..."
}
```

**Polling for Completion**:
```
GET /v1/reports/account_money/report_id_12345
→ Response: {status: "completed", file_name: "..."}
```

**Download**: Use `file_name` to download via provided URL

### As Source of Truth for This Integration

**Why Account Money Report**:
- Contains ALL movements affecting balance (not just payments)
- Official MercadoPago record of account state
- Can be generated for any historical period
- CSV format easy to parse and audit

**What We Know It Contains**:
- Payments (TRANSACTION_TYPE = "SETTLEMENT")
- Refunds (TRANSACTION_TYPE = "REFUND")
- Chargebacks (TRANSACTION_TYPE = "CHARGEBACK")
- Disputes (TRANSACTION_TYPE = "DISPUTE")
- Bank transfers (TRANSACTION_TYPE = "WITHDRAWAL")
- Net amounts (after commission/fees)
- Settlement information
- External references
- Dates (created, processing, settlement)

**What We DON'T Know Yet**:
- Whether yields appear in this report
- What TRANSACTION_TYPE value for yields
- Maximum date range per report
- Whether pending transactions appear
- Exact column names for all available data
- Fee breakdown detail level
- Tax withholding representation

---

## E. YIELDS/INVESTMENT INCOME — RESEARCH FINDINGS

### What We Know

✅ **Mercado Fondo Exists**:
- Investment product for MercadoPago
- Automatic yield generation on held funds
- Daily/periodic deposits of earnings
- Conservative and variable fund options

✅ **Yields Are Real**:
- Your account generates daily investment returns
- These affect your actual balance

### What We DON'T Know

❌ **API Access**:
- Is there a dedicated Mercado Fondo API?
- No official endpoint found in documentation

❌ **Report Representation**:
- Do yields appear in Account Money Report?
- What column/TRANSACTION_TYPE represents them?
- As individual transactions or aggregated?

❌ **Programmable Access**:
- Can yield data be obtained via API?
- Must we use report + manual dashboard checks?
- Real-time vs batch reporting?

### Decision for Now

**PENDING VALIDATION**: Must inspect real Account Money Report to see how yields actually appear.

If yields appear in report → Use report as source
If yields dashboard-only → Note as limitation, design for future enhancement

---

## F. BALANCE — EXACT DEFINITION NEEDED

### The Problem

Previous design assumed:
```
SUM(all_movements WHERE status='approved') = mercadopago_balance
```

### Reality Check Needed

MercadoPago likely distinguishes:
- **Available balance**: Money released and ready to withdraw
- **Unavailable balance**: Money in settlement period
- **Invested balance**: Money in Mercado Fondo
- **Total balance**: Available + Unavailable + Invested (?)

### What We Must Confirm

❌ **Which is the "main" balance shown in MP dashboard?**
❌ **API endpoint to fetch current balance?**
❌ **Exact field names and structure?**
❌ **Does Account Money Report show balance?**
❌ **Or must we recalculate from movements?**

### Our Approach

We'll define:
- `observed_balance`: Value directly from MP (if available)
- `ledger_balance`: Calculated from our movements
- `difference`: observed - ledger (must be 0 for reconciliation)

---

## G. IDENTITY & DEDUPLICATION STRATEGY

### Previous Design Flaw

Simple UNIQUE on `external_id` assumes:
- Each movement = 1 row
- No duplicates possible

### Real Problem

Same transaction can appear in:

1. **Account Money Report** (daily batch):
   - Source ID: Payment ID or internal reference
   - Appears once per day

2. **Payments API** (real-time query):
   - `/v1/payments/search` for same date range
   - Returns same payment.id

3. **Webhooks** (event-driven):
   - `payment.created` and `payment.updated`
   - Same payment.id

### Solution: Source-Record Model

Don't make `external_id` the unique constraint globally.

Instead:

```
mp_source_records (immutable audit log)
├── id (primary key)
├── external_id (from MP: payment.id, refund.id, etc)
├── source (webhook, api_search, report_line)
├── received_at
├── payload (JSONB - raw)
└── correlation_id (computed field: might link multiple records)

financial_movements (normalized fact table)
├── id (primary key)
├── external_id (deduplicated from sources above)
├── type, amount, balance_impact, etc.
└── source_record_ids (array of linked source records)
```

**Benefits**:
- Source records immutable (audit trail)
- Can receive same payment from 3 sources without duplication
- Can correlate them via `correlation_id` (e.g., payment.id + transaction date)
- Financial movement created once, linked to all sources

**Deduplication Logic**:
- When receiving new source record, check if `correlation_id` exists
- If yes: Link to existing movement
- If no: Create new movement

---

## H. RAW DATA STRATEGY

### Storage

`mp_raw_events` table (immutable):

```
id BIGSERIAL PRIMARY KEY
external_id VARCHAR (from MP)
source VARCHAR ('webhook' | 'api' | 'report')
event_type VARCHAR ('payment_created', 'payment_updated', ...)
payload JSONB (complete original response)
received_at TIMESTAMP
report_window_id VARCHAR (if from report: which batch)
processing_status VARCHAR ('pending' | 'normalized' | 'error')
error_log TEXT
normalized_at TIMESTAMP
created_at TIMESTAMP
```

### Purpose

- Never lose original data
- Reprocess if rules change
- Audit trail for compliance
- Easier debugging

### Processing Pipeline

```
Raw Event Received
    ↓
Store in mp_raw_events (processing_status='pending')
    ↓
Validate & Extract
    ↓
Check if movement already exists (by external_id + source)
    ↓
If exists: Link as additional source
If new: Create financial_movement
    ↓
Update mp_raw_events (processing_status='normalized')
```

---

## I. ARQUITECTURA PROPUESTA (CONCEPTUAL)

```
SOURCES
├── Account Money Report (BATCH daily)
├── Payments API (POLLING on demand)
├── Webhooks (REAL-TIME events)
└── Specific APIs (refunds, transfers, etc.)
      ↓
┌─────────────────────────────────────┐
│ Layer 1: RAW / SOURCE RECORDS       │
│ mp_raw_events (immutable log)        │
│ ├── event_type                       │
│ ├── source (webhook/api/report)     │
│ ├── payload (full JSON)              │
│ ├── received_at                      │
│ └── processing_status (pending/...)  │
└────────────┬────────────────────────┘
             ↓
    [Deduplication Logic]
    [Correlation via external_id + date]
             ↓
┌─────────────────────────────────────┐
│ Layer 2: NORMALIZED MOVEMENTS       │
│ mp_movements (fact table)            │
│ ├── external_id (unique)             │
│ ├── type (payment/refund/commission) │
│ ├── amount (gross/net/fees)          │
│ ├── balance_impact (signed)          │
│ ├── status (pending/approved)        │
│ ├── date_created / date_approved     │
│ ├── date_financial_impact            │
│ ├── parties (payer, recipient)       │
│ └── source_record_ids (linked)       │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Layer 3: DAILY SUMMARY              │
│ mp_daily_summary                     │
│ ├── date                             │
│ ├── saldo_inicio                     │
│ ├── creditos_total                   │
│ ├── debitos_total                    │
│ ├── saldo_fin_calculated             │
│ ├── saldo_fin_external (from MP)     │
│ ├── diferencia (external - calculated)
│ └── estado_conciliacion              │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Layer 4: RECONCILIATION VALIDATION   │
│ mp_reconciliation_log                │
│ ├── check_date                       │
│ ├── saldo_app                        │
│ ├── saldo_mp                         │
│ ├── diferencia                       │
│ ├── status (conciliado/diferencia)   │
│ └── investigation_notes              │
└─────────────────────────────────────┘
```

---

## J. HISTÓRICO (IMPORT STRATEGY)

### Date Range

Target: 2026-01-01 to 2026-09-04 (245 days, ~8 months)

### Challenge

- Some APIs limited to 12 months
- Report may have date range limits (unknown: 60? 90? days?)
- Need to partition if limit < 245 days

### Proposed Windowing

**If limit = 62 days** (common for financial reports):

```
Window 1: 2026-01-01 → 2026-03-03 (61 days)
Window 2: 2026-03-03 → 2026-05-04 (62 days)
Window 3: 2026-05-04 → 2026-07-05 (62 days)
Window 4: 2026-07-05 → 2026-09-04 (61 days)
```

Each window:
1. Request Account Money Report
2. Poll until completion
3. Download & parse CSV
4. Store source records
5. Normalize movements
6. Check for duplicates from prior windows
7. Track sync state (success/error/partial)

### Idempotency

Each window stored with:
- `report_window_id` (date range)
- `processing_status` (pending/completed/error)
- Record count
- Error log

Re-running same window:
- Checks if source records already exist
- Skips if all present
- Reprocesses if new rules applied

---

## K. TIEMPO REAL (Real-Time Strategy)

### Webhooks

**Events to Implement**:
- `payment.created` → New payment detected
- `payment.updated` → Status changed
- More to discover (TBD)

### Webhook Handler

```
Receive webhook event
    ↓
Validate x-signature header (HMAC-SHA256)
    ↓
Store raw event in mp_raw_events
    ↓
Respond immediately 200 OK to MP
    ↓
(Async) Fetch full payment details from API
    ↓
Normalize to financial_movement
    ↓
Update reconciliation if needed
```

### Fallback: Periodic Sync

Even with webhooks, run daily reconciliation:
- Fetch movements from last N days
- Compare with local data
- Flag any discrepancies
- Re-sync if gaps found

---

## L. RIESGOS Y DUDAS PENDIENTES

### Critical Unknowns

| Unknown | Impact | How to Resolve |
|---------|--------|----------------|
| **Yield representation in API** | Impossible to capture investment returns | Inspect real Account Money Report |
| **Report max date range** | Must partition import into windows | Test with API: try 90 days, observe response |
| **Balance endpoint structure** | Cannot validate reconciliation | Query `/users/{id}/mercadopago_account/balance` with real account |
| **Webhook event completeness** | May miss certain transaction types | Enable all webhook types in MP panel + monitor logs |
| **Transfers/Payouts API** | Cannot automate outgoing transfers | Contact MP support or check updated docs |
| **Settlement timing** | Affects when balance reconciles | Compare dates: date_approved vs money_release_date |
| **Pending txn handling** | Affects historical data accuracy | Check if pending appears in Account Money Report |

### Risk Mitigations

1. **Implement comprehensive logging**
   - Log all API responses (raw)
   - Log all webhook events
   - Log all parsing errors
   - Revisable decision logs

2. **Build in monitoring**
   - Daily reconciliation check
   - Alert if difference > $1
   - Track sync health metrics

3. **Make it testable**
   - Unit tests for parsing logic
   - Integration tests against real MP sandbox
   - Re-run import multiple times (detect duplicates)

---

## M. PRÓXIMO PASO

### What We Need From You

To finalize the architecture design, we need **real data from your account**:

### Step 1: Generate and Share an Account Money Report

**How**:
1. Go to MercadoPago dashboard
2. Navigate to Reportes (Reports)
3. Select "Reporte de Dinero en Cuenta" (Account Money Report)
4. Choose a date range with active transactions (recommend: last 30 days)
5. Generate CSV
6. Share the **CSV file content** (can be anonymized/truncated but need to see structure)

**Why**:
- Exact column names and data types
- Real TRANSACTION_TYPE values (especially yield/commission/tax types)
- How refunds, chargebacks appear
- How transfers/withdrawals appear
- Example values for all fields

### Step 2: Verify Balance Endpoint

**Query**:
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://api.mercadopago.com/v1/users/me/mercadopago_account/balance
```

Share the response (redact token). This shows us the balance structure.

### Step 3: List Webhook Events Enabled

In MercadoPago panel:
- Go to Integrations → Webhooks
- List all event types configured
- Share list of available/enabled events

### Step 4: Try Historical Import

If you're willing, we can try importing first few days (2026-01-01 to 2026-01-10) to validate:
- Report generation works
- Date range limits
- Parsing correctness
- Deduplication logic

---

## N. CRITERIO DE CONCLUSIÓN

This FASE 0 is complete when we have:

✅ Project audit (DONE)
✅ MercadoPago API documentation review (DONE)
✅ List of confirmed vs pending capabilities (DONE)
✅ Real data samples from user's account (PENDING)
✅ Architectural design document (READY to write after data received)

---

## NEXT PHASE (After Approval)

Once you provide real data + we resolve pending unknowns:

1. **Write FINAL ARCHITECTURE DESIGN** (addresses all unknowns)
2. **Define exact SQL schema** (with sample data)
3. **Specify function contracts** (input/output)
4. **Write reconciliation algorithm** (with examples)
5. **Get your approval** (on final design)
6. **Begin PHASE 1 — Implementation** (schema creation)

---

## IMPORTANT REMINDERS

🚫 **Still NO code changes**
🚫 **Still NO database modifications**
🚫 **Still NO function rewrites**
🚫 **Still NO migrations created**

All of those happen AFTER we finalize the design with real data.

---

