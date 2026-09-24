# Code Conventions & Standards

## Project Overview
- **Type**: React 19 + TypeScript 6 Frontend (Vite)
- **Backend**: Supabase (PostgreSQL)
- **Total Source Files**: 89 (src/*.ts, src/*.tsx)
- **Linting**: oxlint (React, TypeScript, oxc plugins)
- **Build Tool**: Vite with TypeScript compilation

---

## File Naming Conventions

### Component Files (*.tsx)
- **PascalCase**: `FormPedido.tsx`, `RegistroPagoModal.tsx`, `ListaPedidos.tsx`
- **App Components**: `PedidosApp.tsx`, `CajaApp.tsx`, `MercadoPagoApp.tsx`
- **Dashboard Components**: `DashboardPedidos.tsx`, `DashboardProduccion.tsx`, `ProductionDashboard.tsx`
- **Feature Organization**: `/src/features/{module}/{ComponentName}.tsx`
  - `features/pedidos/`, `features/caja/`, `features/cobros/`, `features/production/`, `features/mercadopago/`, `features/admin/`, `features/finanzas/`

### Non-Component TypeScript Files
- **Hooks**: `use{Feature}.ts` (camelCase with "use" prefix)
  - `useClientes.ts`, `usePedidos.ts`, `useCaja.ts`, `useMercadoPago.ts`
  - Consistently use React Query `useQuery()` and `useMutation()` patterns
- **API/Service Functions**: `{entity}.ts` (lowercase)
  - `clientes.ts`, `pedidos.ts`, `caja.ts`, `mercadopago.ts`
  - Export async functions without wrapper class
- **Utilities**: `{purpose}Utils.ts` or `{purpose}Calculos.ts`
  - `dateUtils.ts`, `pedidosCalculos.ts`, `produccionCalculos.ts`, `pedidosHelpers.ts`
- **Constants**: `{entity}.ts` or `{entity}-{type}.ts` (lowercase)
  - `categorias.ts`, `categorias-caja.ts`
- **Types/Domain**: `domain.ts` (centralized in `types/domain.ts`)
- **Validation**: `schemas.ts` (Zod validation schemas)
- **Auth**: `AuthProvider.tsx`, `useAuth.ts`, `LoginScreen.tsx`
- **Library**: `supabase.ts` (singleton client)

### Directory Structure
```
src/
├── api/              # API/database service functions
├── auth/             # Authentication components and hooks
├── components/       # Shared/reusable components
├── constants/        # Application constants
├── features/         # Feature modules (each with own subdirectory)
├── hooks/            # Custom React hooks
├── lib/              # Library clients (Supabase)
├── types/            # TypeScript type definitions
├── utils/            # Utility functions
├── validation/       # Zod validation schemas
├── App.tsx           # Root application component
├── main.tsx          # Vite entry point
└── index.css         # Global styles
```

---

## Function & Variable Naming

### Naming Patterns
- **Spanish Domain Language**: Business logic uses Spanish names for domain entities
  - `cliente`, `pedido`, `caja`, `movimiento`, `lote`, `produccion`, `mortandad`
  - `formatoPesos()`, `resumenLineas()`, `agregarLineaPedido()`, `calcularDiasEntre()`
- **English for Technical Names**: Utilities and generic functions use English
  - `parseLocalDate()`, `getTodayDate()`, `isLoading`, `isOpen`, `isSaving`
- **Handler Functions**: `handle{Action}` (camelCase)
  - `handleGuardar()`, `handleAgregarProducto()`, `handleCambiarCantidad()`, `handleResize()`
- **Query Keys**: Array literals for React Query
  - `['clientes']`, `['pedidos']`, `['caja']` (lowercase, plural where appropriate)

### Variable Naming
- **State Variables**: descriptive, prefixed with `is`/`set` for React useState
  - `const [isSaving, setIsSaving] = useState(false)`
  - `const [sidebarOpen, setSidebarOpen] = useState(true)`
  - `const [tab, setTab] = useState<Tab>('pedidos')`
- **Boolean Flags**: `is{State}`, `has{Trait}`, `can{Action}`
  - `isLoading`, `isOpen`, `hasError`, `canDelete`, `isMobile`
- **Derived Values**: straightforward names
  - `const total = totalUnidadesGeneric(lineas)`
  - `const puedeGuardar = (clienteSel || clienteNuevo.trim()) && total > 0`
- **Query/API Results**: destructure with explicit names
  - `const { data: clientes = [], isLoading } = useClientes()`
  - `const { data, error } = await supabase.from('table').select()`

---

## Import/Export Patterns

### Import Order
1. React/external libraries
2. Custom hooks
3. Types/domain types
4. API/service functions
5. Constants
6. Utilities
7. Components
8. Icons (lucide-react)

```typescript
// Example from FormPedido.tsx
import { ChevronLeft, Trash2, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Cliente, Rol, LineaPedido } from '../../types/domain';
import {
  totalUnidadesGeneric,
  totalPedidoGeneric,
  formatoPesos,
  agregarLineaPedido,
  removerLineaPedido,
} from './helpers';
import { useProductos } from '../../hooks/useProductos';
```

### Export Patterns
- **Components**: Named exports (not default)
  - `export function Modal({ ... }) { }`
  - Exception: `export default App` in main App.tsx
- **API Functions**: Named exports for each operation
  - `export async function listarClientes() { }`
  - `export async function crearCliente() { }`
  - `export async function actualizarCliente() { }`
- **Hooks**: Named exports
  - `export function useClientes() { }`
  - `export function useCrearCliente() { }`
- **Types**: Named exports with `type` keyword
  - `export type Categoria = 'xl' | 'n1' | 'n2' | 'n3' | 'docena'`
  - `export type PedidoEstado = 'pendiente' | 'entregado' | 'cancelado'`
  - `export interface Cliente { ... }`

---

## TypeScript Usage

### TypeScript Compiler Options (tsconfig.app.json)
- **Target**: ES2023
- **Module**: ESNext with bundler resolution
- **JSX**: react-jsx (automatic runtime)
- **Strict Mode**: Partially enforced
  - `noUnusedLocals: false` (disabled - unused variables allowed)
  - `noUnusedParameters: false` (disabled - unused parameters allowed)
  - `noFallthroughCasesInSwitch: true` (enabled)
- **ESLint Integration**: Enabled via oxlint
  - React hooks rules enforced as error
  - React-only exports with allowConstantExport

### Type Patterns
- **Domain Types**: Centralized in `src/types/domain.ts`
  - Type union literals for enums (not TypeScript enums)
    ```typescript
    export type Categoria = 'xl' | 'n1' | 'n2' | 'n3' | 'docena';
    export type PedidoEstado = 'pendiente' | 'entregado' | 'cancelado';
    export type MetodoPago = 'efectivo' | 'transferencia' | 'tarjeta' | 'mercadopago' | 'otro' | 'cheque' | 'echeq';
    ```
  - Interfaces for complex objects
    ```typescript
    export interface Cliente {
      id: string;
      nombre: string;
      categoria: ClienteCategoria;
      activo: boolean;
      notas?: string;
      created_at: string;
    }
    ```
- **Component Props**: Inline interface definitions or type aliases
  ```typescript
  interface FormPedidoProps {
    modo: 'nuevo' | 'rectificar';
    clientes: Cliente[];
    // ... other props
  }
  export function FormPedido({ ... }: FormPedidoProps) { }
  ```
- **Generic Handling**: Support for legacy and new data structures
  ```typescript
  export interface Pedido {
    lineas?: Lineas | LineaPedido[];      // Support both old and new
    lineas_generic?: LineaPedido[];
    // ...
  }
  ```

### Zod Validation
- **Location**: `src/validation/schemas.ts`
- **Pattern**: One schema per entity type
  ```typescript
  export const clienteSchema = z.object({
    nombre: z.string().min(2).max(100).trim().regex(/regex/),
    activo: z.boolean().optional().default(true),
    notas: z.string().max(500).trim().optional(),
  });
  export type ClienteInput = z.infer<typeof clienteSchema>;
  ```
- **Validation Helper**: `validar()` function
  ```typescript
  export function validar<T>(schema: z.ZodSchema<T>, data: unknown) {
    // Returns { success: true; data: T } | { success: false; errors: Record<string, string> }
  }
  ```

---

## Code Organization Within Files

### Component Files (React)
1. **Imports** at top
2. **Type/Interface definitions** (Props, State types)
3. **Component function**
4. **Internal helper functions** (if any)
5. **Default export** or named export

**Example (FormPedido.tsx)**:
```typescript
import { ... } from 'libraries';
import type { PropType } from 'types';
import { helpers } from './helpers';

interface FormPedidoProps { ... }

export function FormPedido({ ...props }: FormPedidoProps) {
  // Hooks first
  const [state, setState] = useState(...);
  const { data } = useQuery(...);
  
  // Event handlers
  function handleClick() { }
  
  // Derived values
  const computed = calculate(state);
  
  // Render
  return <div>...</div>;
}
```

### Hook Files
1. **Imports**
2. **Hook function definition**
3. **Named exports**

**Example (useClientes.ts)**:
```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as clientesApi from '../api/clientes';

export function useClientes() {
  return useQuery({
    queryKey: ['clientes'],
    queryFn: clientesApi.listarClientes,
  });
}

export function useCrearCliente() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nombre: string) => clientesApi.crearCliente(nombre),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
    },
  });
}
```

### API Files
1. **Imports** (Supabase client)
2. **Type imports**
3. **Async function definitions** (one per operation)

**Example (clientes.ts)**:
```typescript
import { supabase } from '../lib/supabase';
import type { Cliente } from '../types/domain';

export async function listarClientes(): Promise<Cliente[]> {
  const { data, error } = await supabase.from('clientes').select('*');
  if (error) throw error;
  return data || [];
}

export async function crearCliente(...): Promise<Cliente> { ... }
```

### Utility/Helper Files
1. **Imports**
2. **Type imports** (if using domain types)
3. **Exported functions** (no class wrappers)

**Example (pedidosCalculos.ts)**:
```typescript
import type { Pedido } from '../types/domain';

export function calcularMetricasPeriodoPedidos(...): MetricasPeriodoPedidos {
  // calculation logic
}

export function calcularVariacionPorcentaje(...): number {
  // calculation logic
}
```

---

## Common Abstractions & Patterns

### React Query Integration (hooks/)
- **Query Pattern**: `useQuery()` for read operations
  ```typescript
  export function useClientes() {
    return useQuery({
      queryKey: ['clientes'],
      queryFn: clientesApi.listarClientes,
    });
  }
  ```
- **Mutation Pattern**: `useMutation()` with cache invalidation
  ```typescript
  export function useCrearCliente() {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: clientesApi.crearCliente,
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['clientes'] });
      },
    });
  }
  ```

### Form Handling
- **State Management**: Individual useState hooks for form fields
  - `const [clienteSel, setClienteSel] = useState('')`
  - `const [lineas, setLineas] = useState<LineaPedido[]>([])`
- **Zod Validation**: Used for complex validation rules in `schemas.ts`
- **Async Save**: `isSaving` flag prevents duplicate submissions
  ```typescript
  async function handleGuardar() {
    setIsSaving(true);
    try {
      await onGuardar();
    } finally {
      setIsSaving(false);
    }
  }
  ```

### Modal/Dialog Pattern
- **Component**: `Modal.tsx` (generic reusable modal)
- **Props**: `isOpen`, `onClose`, `title`, `children`
- **Usage**: Passed boolean state from parent
  ```typescript
  const [isOpen, setIsOpen] = useState(false);
  <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="...">
    {/* content */}
  </Modal>
  ```

### Authentication Pattern
- **AuthProvider**: Context-based auth state
- **useAuth Hook**: Returns `{ user, rol, loading, signOut }`
- **Role-Based Rendering**: Conditional module access in App.tsx
  ```typescript
  const modules = [
    ...(rol === 'dueño' ? [...admin modules] : []),
    ...(rol === 'dueño' || rol === 'colaborador' ? [...production] : []),
  ];
  ```

### Tab/Route Navigation
- **Type Union**: `type Tab = 'pedidos' | 'cobros' | 'caja' | ...`
- **Current Tab State**: Single `tab` state + `setTab` setter
- **Conditional Rendering**: `{currentTab === 'pedidos' && <PedidosApp />}`
- **Module Registration**: Array of `{ id: Tab, label, icon }` for menu generation

### Data Calculation Patterns
- **Helper Functions**: Separate calculation logic from components
  - `totalUnidadesGeneric()`, `totalPedidoGeneric()`, `resumenLineasGeneric()`
  - Support for legacy and new data structures
- **Formatting Functions**: Applied at display time, not storage
  - `formatoPesos()`, `formatoPedidoId()`, `formatearFecha()`
  - Spanish names reflect business domain

### Date Handling
- **Format**: YYYY-MM-DD (ISO string, no timezone interpretation)
- **Helper Functions**: In `dateUtils.ts`
  - `getTodayDate()`, `agregarDiasAFecha()`, `formatearFechaLocal()`
  - Buenos Aires timezone awareness: `obtenerHoyBA()`, `isoAFechaBA()`
- **Parsing**: `parseLocalDate()` avoids timezone issues

### Styling
- **CSS Framework**: TailwindCSS (v4.3.3)
- **Color Palette**: Custom brand colors (hardcoded hex)
  - Primary brown: `#2C2419` (sidebar), `#A8552E` (accent)
  - Gold accent: `#D4AF37` (logo/highlights)
  - Neutral: `#B8A89F` (muted text), `#4A4338` (borders)
- **Responsive Design**: `md:` breakpoint (768px) for mobile/desktop split
- **Component Classes**: Inline Tailwind, no component class extraction

---

## Duplicate Patterns & Code Smell Observations

### Areas with Duplicated Logic
1. **Data Formatting**: Multiple similar functions for peso formatting across components
   - `formatoPesos()` is defined in helpers but repeated in multiple feature areas
2. **List Rendering**: Similar patterns for rendering lists (pedidos, clientes, movimientos)
   - Could benefit from abstracted list component
3. **Modal Handling**: Repetitive useState + conditional render pattern for modals
   - `isOpen`, `onClose`, `onOpen` pattern duplicated across features
4. **Date Utilities**: Both `dateUtils.ts` and component-level date parsing functions
   - `parseLocalDate()` defined in DashboardPedidos.tsx and in utils
5. **Validation**: Form validation logic mixed into component state
   - Could be more cleanly separated with form library (like React Hook Form)

### Missing Patterns
1. **Error Handling**: Limited error boundary implementations
2. **Loading States**: Loading UI inconsistently handled
3. **Empty States**: Limited empty state messaging

---

## Configuration Patterns

### Environment Variables
- **Pattern**: `import.meta.env.VITE_*` (Vite convention)
- **Location**: `.env.local` (not committed)
- **Template**: `.env.example`
- **Required Variables**:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
- **Runtime Check**: Supabase client throws error if missing

### Build Configuration
- **Tool**: Vite with TypeScript build target ES2023
- **Output**: `dist/` directory
- **PWA Support**: vite-plugin-pwa included
- **TypeScript Output**: Compiled before Vite bundling (`tsc -b && vite build`)

### Linting
- **Tool**: oxlint (v1.75.0)
- **Config**: `.oxlintrc.json`
- **Plugins**: react, typescript, oxc
- **Rules Enforced**:
  - `react/rules-of-hooks: error` (hooks must be at top level)
  - `react/only-export-components: warn` (components should be default exports, allowConstantExport)

---

## Summary

This is a feature-rich React application with:
- **Strong domain model** (Spanish naming for business logic)
- **Consistent hook patterns** using React Query
- **Centralized types** in domain.ts with support for legacy/new structures
- **Feature-based organization** with clear separation of concerns
- **Zod validation** for user input
- **TailwindCSS** for styling with custom brand colors
- **No test coverage** currently
- **Minimal linting enforcement** (unused variables/parameters allowed)
- **Tab-based navigation** for multi-module SPA architecture
