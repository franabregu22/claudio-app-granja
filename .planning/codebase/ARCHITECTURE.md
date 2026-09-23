# Claudio App Granja - Architecture

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     BROWSER / PWA CLIENT                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           React Components (features/*)                  │   │
│  │  (Pedidos, Cobros, Caja, Production, etc.)             │   │
│  └────┬──────────────────────────────────┬────────────────┘   │
└───────┼──────────────────────────────────┼──────────────────────┘
        │                                  │
        │ User Actions                    │ User Actions
        │ (onClick, onChange)             │
        │                                  │
        ▼                                  ▼
┌──────────────────┐            ┌──────────────────┐
│ React Query      │            │ Zustand/Context  │
│ (Server State)   │            │ (Local State)    │
│                  │            │                  │
│ - useQuery       │            │ - useAuth        │
│ - useMutation    │            │ - Form state     │
│ - Cache mgmt     │            │                  │
└────────┬─────────┘            └──────────────────┘
         │
         │ API calls via React hooks
         │
         ▼
┌─────────────────────────────────────────────────┐
│         API Layer (/src/api/*)                  │
│  - pedidos.ts, caja.ts, mercadopago.ts, etc.  │
│  Pure async functions calling Supabase         │
└────────┬────────────────────────────────────────┘
         │
         │ HTTP / WebSocket
         │
         ▼
┌─────────────────────────────────────────────────┐
│     SUPABASE CLOUD (Backend as a Service)      │
│  ┌──────────────────────────────────────────┐  │
│  │ PostgreSQL Database                      │  │
│  │ - Tables: pedidos, clientes, caja, etc.  │  │
│  │ - RPC functions for business logic       │  │
│  │ - Triggers for automation                │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ Auth (Google OAuth + JWT)                │  │
│  │ - User sessions                          │  │
│  │ - Role verification via perfiles table   │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ Postgres Changes (Real-time)             │  │
│  │ - Listen to table changes                │  │
│  │ - Notify clients of updates              │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ Edge Functions (Deno runtime)            │  │
│  │ - check-rate-limit                       │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ Storage (Invoices, Documents)            │  │
│  │ - Public URL generation                  │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
         │
         │ HTTP
         │
         ▼
┌─────────────────────────────────────────────────┐
│    EXTERNAL SERVICES                            │
│  ┌──────────────────────────────────────────┐  │
│  │ MercadoPago API                          │  │
│  │ - OAuth token exchange                   │  │
│  │ - Payment search & settlement data       │  │
│  │ - Sync via scheduled Netlify function    │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ Google OAuth                             │  │
│  │ - Authentication                         │  │
│  │ - Google Sheets integration (future)     │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
         │
         │ Scheduled job
         │
         ▼
┌─────────────────────────────────────────────────┐
│    NETLIFY DEPLOYMENT                           │
│  ┌──────────────────────────────────────────┐  │
│  │ Functions (serverless)                   │  │
│  │ - sync-mercadopago-releases (daily 2AM)  │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## Frontend Architecture

### Layer 1: Components (React UI Layer)
**Location:** `/src/features/*/`, `/src/components/`

**Responsibilities:**
- Display data to users
- Capture user input via forms
- Handle component-level state (modals, visibility)
- Call hooks for data operations

**Patterns:**
- Feature modules are self-contained (App > Views > Components)
- Form components use controlled inputs with React state
- Real-time data reflects via React Query invalidation
- Role-based rendering via `useAuth()` hook

**Example (PedidosApp flow):**
```
PedidosApp.tsx
├── Header with role check
├── usePedidos() hook (query)
├── useCrearPedido() hook (mutation)
├── FormPedido (for creation)
├── ListaPedidos (displays pedidos)
└── PedidoCard (individual order display)
```

### Layer 2: Hooks (State Management via React Query)
**Location:** `/src/hooks/`

**Responsibilities:**
- Wrap API calls in React Query for caching
- Manage query keys and invalidation
- Handle mutations with optimistic updates
- Provide TypeScript-safe data access
- Listen to real-time updates

**Patterns:**
```typescript
// Query hook
export function usePedidos(): UseQueryResult<Pedido[], Error> {
  return useQuery({
    queryKey: ['pedidos'],                    // Unique cache key
    queryFn: pedidosApi.listarPedidos,        // API function
  });
}

// Mutation hook
export function useCrearPedido(): UseMutationResult<...> {
  return useMutation({
    mutationFn: pedidosApi.crearPedido,       // API function
    onSuccess: () => {
      queryClient.invalidateQueries({         // Invalidate cache
        queryKey: ['pedidos']
      });
    },
  });
}

// Real-time subscription
useEffect(() => {
  const channel = supabase
    .channel('pedidos-changes')
    .on('postgres_changes', 
      { event: '*', table: 'pedidos' },
      () => queryClient.invalidateQueries({ queryKey: ['pedidos'] })
    )
    .subscribe();
}, [queryClient]);
```

**Key Features:**
- Automatic caching and stale-while-revalidate
- Request deduplication
- Background refetching
- Optimistic mutations
- Automatic garbage collection

### Layer 3: API (Data Access Layer)
**Location:** `/src/api/`

**Responsibilities:**
- Encapsulate all Supabase queries
- Transform raw DB responses to domain types
- Handle errors consistently
- Single source of truth for CRUD operations

**Patterns:**
```typescript
// List with relations
export async function listarPedidos(): Promise<Pedido[]> {
  // Fetch main table
  const { data: pedidos } = await supabase
    .from('pedidos')
    .select('*')
    .neq('estado', 'cancelado')
    .order('creado_en', { ascending: false });
    
  // Fetch relations in parallel
  const { data: lineas } = await supabase
    .from('pedido_lineas')
    .select('*')
    .in('pedido_id', pedidos.map(p => p.id));
    
  // Map relations back
  return pedidos.map(p => ({
    ...p,
    lineas: lineas.filter(l => l.pedido_id === p.id),
  }));
}

// RPC for complex logic
export async function marcarEntregado(id: number): Promise<void> {
  const { error } = await supabase.rpc('marcar_pedido_entregado', {
    pedido_id: id,
  });
  if (error) throw error;
}
```

### Layer 4: Libraries & Utilities
**Location:** `/src/lib/`, `/src/utils/`

**Supabase Client (`/src/lib/supabase.ts`):**
```typescript
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
```

**MercadoPago Calculations (`/src/lib/mercadopago-calculations.ts`):**
- Period parsing (Argentina timezone)
- Ledger summarization
- Balance calculations
- Income/expense categorization

## Authentication & Authorization

### Login Flow
```
1. User navigates to app
   ↓
2. AuthProvider initializes (checks session)
   ↓
3. If no session: show LoginScreen
   ├─ Google OAuth button
   ├─ User clicks → Google consent screen
   ├─ Returns access token
   ├─ Supabase stores session (JWT)
   ↓
4. Fetch user role from perfiles table
   ├─ Query: SELECT rol FROM perfiles WHERE id = user_id
   ├─ Set rol in context (dueño, colaborador, repartidor)
   ↓
5. Render App with role-based module visibility
```

### Role-Based Access Control (RBAC)

**Roles Defined in `/src/types/domain.ts`:**
```typescript
export type Rol = 'dueño' | 'repartidor' | 'colaborador';
```

**Enforcement in `App.tsx`:**
```typescript
const modules = [
  ...(rol === 'dueño' ? [
    { id: 'pedidos', label: 'Pedidos', ... },
    { id: 'caja', label: 'Caja', ... },
    { id: 'admin', label: 'Admin', ... },
  ] : []),
  ...(rol === 'dueño' || rol === 'colaborador' ? [
    { id: 'produccion', label: 'Producción', ... }
  ] : []),
];
```

**Component-Level Guards:**
```typescript
export function CajaApp() {
  const { rol } = useAuth();
  
  if (rol !== 'dueño') {
    return <RestrictedAccessMessage />;
  }
  // ... render module
}
```

## Data Flow for Typical User Action

### Example: Create an Order

```
1. User fills FormPedido (cliente, lineas, fecha)
2. Clicks "Crear Pedido"
3. FormPedido calls mutation.mutate({...})
   │
4. useCrearPedido hook catches mutation
   │
5. pedidosApi.crearPedido(clienteId, lineas, ...) called
   ├─ supabase.from('pedidos').insert({...}).select().single()
   ├─ supabase.from('pedido_lineas').insert([...])
   │
6. On success:
   ├─ queryClient.invalidateQueries(['pedidos'])
   ├─ React Query refetches usePedidos()
   ├─ ListaPedidos re-renders with new order
   │
7. Real-time update via Postgres Changes:
   ├─ Supabase detects INSERT on pedidos table
   ├─ Broadcasts to all connected clients
   ├─ usePedidos listener triggers cache invalidation
   ├─ Other users' screens auto-update
```

## Database Architecture

### Core Tables

**pedidos** - Orders
- id, cliente_id, cliente_nombre, estado, fecha_operacion
- monto_total, creado_por, entregado_por, creado_en, actualizado_en

**pedido_lineas** - Order Line Items
- id, pedido_id, producto_id, producto_nombre, cantidad, precio_unitario, subtotal

**clientes** - Customers
- id, nombre, categoria, activo, notas

**productos** - Products (generic)
- id, nombre, categoria, precio_actual, unidad, activo

**movimientos_caja** - Cash Movements
- id, tipo (ingreso|egreso), concepto, monto, forma_pago
- fecha_operacion, estado (pendiente|confirmado|cancelado)
- categoria, vinculado_a (pedido|pago|ninguno), vinculado_id

**cheques** - Checks
- id, numero, banco, monto, fecha_emision, fecha_vencimiento, girador, estado

**arqueos_caja** - Cash Reconciliations
- id, cuenta_id, fecha_arqueo, monto_fisico, monto_registrado, diferencia

**producciones** - Egg Production Records
- id, fecha, galpon, huevos_totales_mediodia, huevos_cachados_mediodia
- mortandad, observaciones, creado_por

**lotes** - Batches
- id, galpon, fecha_entrada, fecha_salida, aves_iniciales_postura, estado

**MercadoPago Tables:**
- mp_financial_movement - Payment movements
- ledger_entry - Accounting ledger entries
- account_balance - Account closing balances
- mp_movement_source_link - Links movements to source transactions
- mp_source_record - Raw MercadoPago transaction data

**perfiles** - User Profiles
- id, rol, primer_nombre, apellido

### RPC Functions (Stored Procedures)

**marcar_pedido_entregado(pedido_id)**
- Updates pedido.estado to 'entregado'
- Sets pedido.entregado_en to NOW()
- Sets entregado_por to current_user_id
- Atomically updates related cash movements

**Other computed values:**
- balance calculations from ledger_entry joins
- settlement reconciliation via mp_movement_source_link

## Real-Time Capabilities

### Supabase Postgres Changes

**Setup in hooks:**
```typescript
const channel = supabase
  .channel('table-name-changes')
  .on(
    'postgres_changes',
    {
      event: '*',              // INSERT, UPDATE, DELETE
      schema: 'public',
      table: 'pedidos',
    },
    () => {
      queryClient.invalidateQueries({ queryKey: ['pedidos'] });
    }
  )
  .subscribe();
```

**Behavior:**
- Any user creates/updates order → DB notifies all listeners
- React Query cache is invalidated
- Next render fetches fresh data
- All connected users see update within 1-2 seconds

## External Integrations

### MercadoPago Sync

**Flow:**
```
1. Daily scheduled function (Netlify) at 2 AM
   └─ Triggered by netlify.toml: [[scheduled_functions]]
   
2. sync-mercadopago/index.ts (Deno function)
   ├─ Get MercadoPago OAuth token (client credentials)
   ├─ Fetch /v1/payments/search (paginated, all historical)
   ├─ Transform to ledger_entry records
   ├─ Batch insert into database
   ├─ Link to mp_source_record for reconciliation
   
3. Frontend queries mp_financial_movement table
   ├─ Displays movements by date range
   ├─ Calculates summary (ingresos, egresos, balance)
   ├─ Shows unclassified transactions needing review
```

**Data Source:**
- Raw movements: `mp_source_record` (source_external_id from MP API)
- Financial movements: `mp_financial_movement` (normalized, linked to ledger)
- Balance: calculated from ledger_entry + opening_balance config

## Build & Deployment

### Build Process (Vite)

```
npm run build
├─ TypeScript compilation (tsc -b)
├─ Vite bundling
│  ├─ React SWC transformation (fast)
│  ├─ Tailwind CSS extraction
│  ├─ Code splitting by route
│  └─ Asset optimization
├─ PWA manifest generation
├─ Output: dist/
```

### Netlify Deployment

**Configuration (netlify.toml):**
```toml
[build]
  command = "npm run build"
  publish = "dist"
  functions = "netlify/functions"

[[scheduled_functions]]
  name = "sync-mercadopago-releases"
  schedule = "0 2 * * *"
```

**Deployment Steps:**
1. Git push to main
2. Netlify builds from `npm run build`
3. Static output in dist/ deployed to CDN
4. Functions deployed as serverless endpoints
5. Scheduled function triggers at specified cron time

## Performance Characteristics

### Caching Strategy

**React Query:**
- Default stale time: 0 ms (immediate refetch on mount)
- Cache time: 5 minutes (data discarded if unused)
- Background refetch on window focus
- Request deduplication (same query within same render)

**Browser Cache (PWA):**
- Static assets (JS, CSS, images): 1 year
- Google Fonts: 1 year
- API responses: Not cached (real-time via invalidation)

### Network Optimization

- Database queries optimized with indexes (created in migrations)
- Foreign key joins in API layer (N+1 queries batched)
- Pagination for large lists (via Supabase limit/offset)
- Real-time updates only invalidate affected query key

## Error Handling

### API Layer
```typescript
export async function listarPedidos(): Promise<Pedido[]> {
  const { data, error } = await supabase...
  if (error) throw error;  // Propagate to caller
  return data || [];
}
```

### Hook Layer
```typescript
export function usePedidos(): UseQueryResult<Pedido[], Error> {
  return useQuery({
    queryKey: ['pedidos'],
    queryFn: pedidosApi.listarPedidos,  // Error caught by React Query
    // Automatic retry on 5xx or network errors
  });
}
```

### Component Layer
```typescript
export function ListaPedidos() {
  const { data, error, isLoading } = usePedidos();
  
  if (isLoading) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;
  return <List items={data} />;
}
```

## Validation

### Form Validation
- Zod schemas in `/src/validation/schemas.ts`
- Integrated with form components
- Client-side validation before submission
- Example: `schemas.PedidoSchema.parse(formData)`

### Database Constraints
- Primary keys, foreign keys enforced at DB level
- NOT NULL constraints on required fields
- Check constraints for enums (estado IN ('pendiente', 'entregado', ...))
- Triggers for derived fields (e.g., monto_total calculation)

## Monitoring & Debugging

### Available Debug Tools

**MercadoPagoDebug Component:**
- Manual sync trigger
- Unclassified movements display
- Balance reconciliation visualization

**Console Logging:**
- Supabase operations logged in development
- React Query dev tools available via npm package

**Database Inspection:**
- Supabase Studio: Direct table and RPC viewing
- Migrations tracked in version control

## Future Considerations

### Scalability
- Pagination for large result sets already implemented
- Database indexes for common queries (migrations)
- Real-time listeners can support multiple concurrent users

### Security
- Row-level security (RLS) policies enforced by Supabase
- JWT tokens stored securely in httpOnly cookies
- OAuth handles credential exchange securely
- Environment variables for secrets (.env.local not committed)

### Extensibility
- Feature module pattern allows new modules without refactoring
- API layer can be extended with new service modules
- Hooks pattern scales with new data entities
- Database migrations versioned for schema evolution
