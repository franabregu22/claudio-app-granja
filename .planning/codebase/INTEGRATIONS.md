# INTEGRATIONS

**STATUS:** Mapping of external services and API integrations

---

## EXTERNAL SERVICES

### MercadoPago API

**Purpose:** Payment collection, transaction reconciliation, webhook events

**Integration Pattern:**
- Webhooks: Receive payment notifications via POST
- REST API: Query transactions, movements, rendimientos
- Authentication: Bearer token (stored in environment)

**Environment Variables:**
- `VITE_MP_ACCESS_TOKEN` — Production MP API token
- `VITE_MP_PUBLIC_KEY` — Public key (if client-side validation needed)

**Key Endpoints:**
- `/users/me` — Account info
- `/v1/payments` — Payment queries
- `/v1/merchant_orders` — Order tracking
- `/v1/account/bank_accounts` — Account movement/balance
- `/v1/account/settlement_report` — Settlement (rendimiento) data

**Webhook Configuration:**
- Topics: `payment.created`, `payment.updated`, `mp.account.resciption`
- Handler: Netlify Function (location: TBD in functions/)
- Deduplication: Via SOURCE_ID field

**Data Flow:**
```
MP Webhook
  → Netlify Function
  → Validate signature (HMAC-SHA256)
  → Parse payment event
  → INSERT mp_source_record (immutable)
  → Trigger reconciliation logic
  → INSERT mp_financial_movement (classification)
  → Sync to general ledger
```

**Status:** PHASE 0 (MP architecture partially migrated; legacy + new coexist)

---

### Supabase

**Purpose:** Database, authentication, RLS, real-time subscriptions

**Integration Pattern:**
- Client SDK: `@supabase/supabase-js` (v2.112.2)
- Authentication: Google OAuth + Supabase Auth
- Database: PostgreSQL with RLS policies
- Real-time: Subscriptions to changes (not currently used)

**Environment Variables:**
- `VITE_SUPABASE_URL` — Project URL
- `VITE_SUPABASE_ANON_KEY` — Public anon key (client-side)

**Key Features Used:**
- RLS: Financial tables protected (perfiles, client_ledger, financial_posting)
- Functions: RPC calls for atomic transactions
- Storage: Not currently used (static assets only)

**Authentication Flow:**
```
User (Google OAuth)
  → Supabase Auth provider
  → JWT token stored in browser
  → Each request includes Authorization header
  → RLS policies evaluated per user role
```

**Data Access Pattern:**
- Client queries via `supabase.from().select()` with RLS enforcement
- RPC functions for transactional writes (atomic)
- Real-time subscriptions disabled (performance)

---

### Google OAuth

**Purpose:** User authentication (OIDC provider)

**Library:** `@react-oauth/google` (v0.13.5)

**Configuration:**
- Client ID: Stored in environment
- Callback: Supabase OAuth provider
- Scopes: Default (email, profile)

**Status:** Active, works with Supabase Auth

---

### Netlify (Deployment & Functions)

**Purpose:** Hosting, build/deploy pipeline, serverless functions

**Integration Pattern:**
- Framework: Vite-based SPA
- Build: `npm run build` → Static files to `dist/`
- Functions: Serverless functions in `/netlify/functions/` (if present)
- Environment: Netlify environment variables for API keys

**Known Functions:**
- TBD: Check for MP webhook handler, reconciliation logic

**Deployment:**
- Git trigger on `main` branch
- Build command: `tsc -b && vite build`
- Publish directory: `dist/`

---

## CLIENT-SIDE API CALLS

### Data Fetching

**Library:** TanStack React Query (v5.101.4)

**Pattern:**
```typescript
useQuery({
  queryKey: ['pedidos'],
  queryFn: () => supabase.from('pedidos').select()
})
```

**Caching:** TanStack Query handles client-side caching and invalidation

---

## STATE MANAGEMENT

**Library:** React Context (no Redux/Zustand)

**Pattern:** Provider pattern for authentication context and role-based access

**Risk:** Global state changes may trigger unnecessary re-renders

---

## FORM VALIDATION

**Library:** Zod (v4.4.3)

**Pattern:** Schema-based validation for form inputs before submission

**Example:**
```typescript
const formSchema = z.object({
  email: z.string().email(),
  cantidad: z.number().positive()
})
```

---

## CHARTING & VISUALIZATION

**Library:** Recharts (v3.10.1)

**Used for:** Financial dashboards, production reports

**Typical Usage:** BarChart, LineChart, PieChart components

---

## UI COMPONENTS

**Styling:** Tailwind CSS (v4.3.3) + PostCSS

**Icons:** Lucide React (v1.30.0)

**Custom Components:** Located in `src/components/`

---

## ENVIRONMENT VARIABLES

| Variable | Purpose | Used In |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL | Client auth, DB access |
| `VITE_SUPABASE_ANON_KEY` | Public auth key | Supabase client init |
| `VITE_MP_ACCESS_TOKEN` | MercadoPago API token | MP API calls, webhooks |
| `VITE_MP_PUBLIC_KEY` | MP public key (if needed) | TBD |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client ID | Google auth provider |

**Note:** `VITE_` prefix indicates these are exposed to client (safe for public keys only)

---

## MISSING / UNCERTAIN

- Netlify Functions webhook handler location/implementation
- MP reconciliation function endpoint
- Rate limiting strategy for API calls
- Error handling for failed MP webhook deliveries
- Retry logic for failed Supabase queries
- Monitoring/alerting setup

---

**Status:** UNCERTAIN on several integration details; full audit needed after Phase 0 MP completion.
