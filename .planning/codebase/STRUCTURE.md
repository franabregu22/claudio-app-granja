# Claudio App Granja - Project Structure

## Directory Overview

```
.
├── src/                          # Main React application source
│   ├── auth/                     # Authentication layer
│   ├── api/                      # API client layer for Supabase
│   ├── hooks/                    # Custom React hooks for data fetching
│   ├── lib/                      # Shared libraries and utilities
│   ├── components/               # Reusable UI components
│   ├── features/                 # Feature modules (major functionality)
│   ├── types/                    # TypeScript domain types
│   ├── utils/                    # Utility functions
│   ├── constants/                # App constants
│   ├── validation/               # Zod validation schemas
│   ├── App.tsx                   # Main App component with routing
│   ├── main.tsx                  # React DOM entry point
│   └── index.css                 # Global styles
│
├── supabase/                     # Database and backend functions
│   ├── functions/                # Supabase Edge Functions / Netlify Functions
│   ├── migrations/               # Database schema migrations
│   ├── sql/                      # SQL scripts and queries
│   └── tests/                    # Database test queries
│
├── public/                       # Static assets (images, icons)
├── dist/                         # Vite build output (excluded from git)
├── node_modules/                 # Dependencies (excluded from git)
│
├── package.json                  # npm dependencies and scripts
├── vite.config.ts                # Vite build configuration
├── tailwind.config.ts            # Tailwind CSS configuration
├── tsconfig.json                 # TypeScript configuration
├── netlify.toml                  # Netlify build and function config
└── .env.example                  # Environment variables template
```

## Source Directory (`/src`) Detail

### `/src/auth` - Authentication Management
- **LoginScreen.tsx** - Google OAuth login form
- **AuthProvider.tsx** - React context for auth state (user, rol, loading)
- **useAuth.ts** - Hook to consume auth context

**Pattern:** Auth state is centralized and provides role-based access control (dueño, colaborador, repartidor)

### `/src/api` - Data Access Layer
Abstracts all Supabase queries. One module per domain entity:

- **pedidos.ts** - Order CRUD operations
- **clientes.ts** - Customer management
- **precios.ts** - Price management
- **caja.ts** - Cash box (treasury) operations
- **mercadopago.ts** - MercadoPago payment data
- **producciones.ts** - Production records
- **arqueos.ts** - Cash reconciliation (arqueo)
- **lotes.ts** - Batch management for egg production
- **categorias.ts** - Product categories
- **recuentos.ts** - Inventory counts
- **pagos.ts** - Payment records

**Pattern:** Each file exports async functions. API methods call Supabase directly; hooks handle React Query integration.

### `/src/hooks` - Data Fetching & Mutations
Custom hooks built on React Query for state management:

- **usePedidos.ts** - Order list, create, update, cancel mutations
- **useCaja.ts** - Cash movements, checks, commissions
- **useMercadoPago.ts** - MercadoPago data queries
- **useProducciones.ts** - Production record management
- **useArqueos.ts** - Cash reconciliation queries
- **useClientes.ts** - Customer queries
- **usePrecios.ts** - Price queries
- **usePagos.ts** - Payment queries
- **useClientesSaldo.ts** - Customer balance (accounts receivable)
- **useRateLimit.ts** - Rate limiting wrapper

**Pattern:** Each hook exports typed queries and mutations; mutations invalidate related query keys for cache coherence.

### `/src/lib` - Shared Libraries
- **supabase.ts** - Supabase client initialization
- **mercadopago-calculations.ts** - Period analysis, ledger summarization, balance calculations
- Utilities for common operations

### `/src/components` - Reusable UI
- **Modal.tsx** - Dialog wrapper
- **Pagination.tsx** - Table pagination control

### `/src/features` - Feature Modules
Each feature is a self-contained module with layout, forms, lists:

- **`/features/pedidos`** - Order management
  - PedidosApp.tsx - Main layout
  - FormPedido.tsx - Order creation/editing form
  - PedidoCard.tsx - Order display component
  - ListaPedidos.tsx - Orders list view
  - DashboardPedidos.tsx - Orders dashboard
  - pedidosCalculos.ts - Order total calculations
  - helpers.ts - Format helpers

- **`/features/cobros`** - Accounts Receivable
  - CobrosApp.tsx - Main layout
  - ListaClientes.tsx - Customers list
  - ListaClientesConCredito.tsx - Customers with credit
  - ListaFinalizados.tsx - Completed payments
  - RegistroPagoModal.tsx - Payment recording modal

- **`/features/caja`** - Cash Box / Treasury
  - CajaApp.tsx - Main layout
  - FormMovimiento.tsx - Cash movement form
  - ListaMovimientos.tsx - Movements list
  - ResumenSaldos.tsx - Balance summary
  - ResumenFlujoCaja.tsx - Cash flow summary
  - CuentasAPagar.tsx - Accounts payable
  - ArqueoCard.tsx - Reconciliation card
  - FormArqueo.tsx - Reconciliation form
  - HistorialArqueos.tsx - Reconciliation history
  - PyL.tsx & PyLProesional.tsx - P&L statement
  - TendenciaMeses.tsx - Trend analysis
  - ModalEditarMovimiento.tsx - Edit movement modal
  - ModalEditarCategoria.tsx - Edit category modal

- **`/features/production`** - Egg Production Tracking
  - ProductionApp.tsx - Main layout
  - DashboardProduccion.tsx - Production dashboard
  - FormProduccion.tsx - Production record form
  - ListaProducciones.tsx - Production history
  - ProductionDashboard.tsx - Analytics dashboard
  - produccionCalculos.ts - Production calculations
  - produccionHelpers.ts - Production helpers

- **`/features/finanzas`** - Financial Analysis
  - FinanzasApp.tsx - Main layout with KPIs and charts

- **`/features/admin`** - Administration
  - AdminApp.tsx - Main layout
  - CategoriasAdmin.tsx - Product category management
  - ClientesAdmin.tsx - Customer management
  - LotesAdmin.tsx - Batch management
  - PreciosAdmin.tsx - Price management

- **`/features/mercadopago`** - MercadoPago Integration
  - MercadoPagoApp.tsx - Main layout
  - MercadoPagoDebug.tsx - Debug component
  - DateFilter.tsx - Date range filter
  - TypeFilter.tsx - Movement type filter
  - SummaryCards.tsx - Summary statistics
  - MovementsTable.tsx - Movements list table
  - MonthlyReport.tsx - Monthly analysis
  - UnclassifiedMovements.tsx - Unclassified transactions

### `/src/types` - Domain Types
- **domain.ts** - All TypeScript interfaces (Pedido, Cliente, Producto, MovimientoCaja, etc.)

**Pattern:** Single source of truth for data types used across API, hooks, and components.

### `/src/validation` - Input Validation
- **schemas.ts** - Zod schemas for form validation

### `/src/constants` - Configuration
- **categorias.ts** - Product categories (xl, n1, n2, n3, docena)
- **categorias-caja.ts** - Cash movement categories

### `/src/utils` - Helpers
- **dateUtils.ts** - Date formatting and parsing utilities

## Supabase Directory (`/supabase`)

### `/supabase/functions` - Backend Functions
- **sync-mercadopago/index.ts** - Scheduled function to sync MercadoPago settlements
- **check-rate-limit/index.ts** - Rate limiting enforcement

**Pattern:** Deno-based functions; called by Netlify scheduled jobs or HTTP endpoints.

### `/supabase/migrations` - Database Schema
SQL migration files in chronological order (numbered 001, 002, etc.):

- 001_mercadopago_schema.sql - Initial MercadoPago tables
- 002_mercadopago_movements.sql - Movement records
- 003_mercadopago_settlement.sql - Settlement data
- 004_mp_new_architecture.sql - Architecture refactor
- 005_add_needs_review.sql - Review status tracking
- 006_add_liberaciones_source_type.sql - Release sources
- 007_reconciliation_tables.sql - Reconciliation framework
- 008_june_reconciliation_framework.sql - June reconciliation
- 009_reconciliation_v3_2_final.sql - Reconciliation v3.2
- 009_fix_raw_only_counting.sql - Raw count fix
- 010_add_fingerprint_column.sql - Fingerprint tracking
- 010_fix_import_v2_classifications.sql - Import classification fix

**Pattern:** Migrations are applied in order; contain table creation, RPC functions, and indexes.

### `/supabase/sql` - Query Library
Utility SQL scripts for analysis and maintenance (not auto-executed).

### `/supabase/tests` - Test Queries
SQL queries for validating data integrity and testing business logic.

## Configuration Files

### package.json
- React, React DOM, Supabase SDK
- React Query (TanStack Query) for state
- Lucide React for icons
- Recharts for visualizations
- Tailwind CSS for styling
- TypeScript 6.0
- Vite 8.2 for build
- PWA plugin for offline support

### vite.config.ts
- React SWC plugin for fast builds
- PWA manifest and icon configuration
- Workbox for offline caching

### tailwind.config.ts
- Tailwind CSS configuration

### netlify.toml
- Build command: npm run build
- Publish directory: dist (Vite output)
- Functions directory: netlify/functions
- Scheduled function: sync-mercadopago-releases at 2 AM daily

### .env.example
Template for required environment variables:
- VITE_SUPABASE_URL - Supabase project URL
- VITE_SUPABASE_ANON_KEY - Public API key

## File Organization Patterns

### Component Modules
Each feature module follows:
```
/features/[feature]/
├── [Feature]App.tsx           # Main layout (routes internal views)
├── [Component].tsx            # Feature-specific components
├── [helper|calculos|Helpers].ts  # Business logic
└── Modal*.tsx                 # Inline modals
```

### API + Hooks Pattern
For each domain entity:
```
/api/[entity].ts              # Supabase queries
/hooks/use[Entity].ts         # React Query hooks + mutations
```

### Naming Conventions
- **Files:** camelCase (pedidos.ts, usePedidos.ts)
- **Components:** PascalCase (PedidosApp.tsx, FormPedido.tsx)
- **Types:** PascalCase (Pedido, MovimientoCaja)
- **Functions:** camelCase (listarPedidos, crearPedido)

## Data Flow

1. **User Action** → Component event handler
2. **Mutation Hook** → React Query mutation
3. **API Function** → Supabase query/insert/update
4. **Cache Invalidation** → React Query re-fetches (or direct update)
5. **Real-time Update** → Supabase Postgres Changes listener
6. **Component Re-render** → UI updates

## Key Technologies

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend UI | React 19 + TypeScript | Component rendering |
| Build | Vite 8.2 | Fast development & bundling |
| Styling | Tailwind CSS 4.3 | Utility-first CSS |
| State Mgmt | TanStack React Query 5 | Server state caching |
| Database | Supabase PostgreSQL | Data storage |
| Auth | Supabase Auth + Google OAuth | Authentication |
| Real-time | Supabase Postgres Changes | Live updates |
| Backend Functions | Supabase Edge Functions / Netlify | Scheduled tasks |
| Icons | Lucide React | Icon library |
| Charts | Recharts | Data visualization |
| Validation | Zod | Schema validation |
| PWA | Vite PWA Plugin | Offline capability |

## Access Control

Role-based permissions enforced in App.tsx:
- **dueño** (owner) - Full access to all modules
- **colaborador** (collaborator) - Access to production
- **repartidor** (delivery) - Limited view (production only for some)

Each feature component checks role before rendering.
