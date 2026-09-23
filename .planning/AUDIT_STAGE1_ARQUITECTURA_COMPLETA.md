# ETAPA 1: Auditoría Arquitectónica Completa — Granja Santo Tomás

**Fecha de Auditoría:** 2026-09-23  
**Estado:** READ-ONLY ANALYSIS — Sin modificaciones  
**Scope:** Análisis completo del stack, BD, módulos, flujos y deuda técnica

---

## A. RESUMEN EJECUTIVO

### Sistema Actual: Estado General

**Claudio App Granja** es un ERP avícola full-stack construido sobre:
- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS
- **Backend:** Supabase (PostgreSQL) + Netlify Functions
- **Integraciones:** MercadoPago (en migración arquitectónica)
- **Estado actual:** Producción con deuda técnica significativa, en transición de arquitectura de Mercado Pago

### Hallazgos Críticos

| Área | Estado | Riesgo |
|------|--------|--------|
| **Data Integrity** | CRÍTICO | Múltiples fuentes de verdad para totales, balances y movimientos |
| **MercadoPago** | EN TRANSICIÓN | Arquitectura nueva parcialmente implementada, código legacy persistente |
| **Testing** | CRÍTICO | 2 test files para 89 archivos, 0 cobertura de componentes |
| **Schema** | CRÍTICO | 2 directorios de migraciones, enum contradictorios, 48 tablas activas |
| **Deuda Técnica** | ALTO | 150+ console.logs, lógica duplicada, ausencia de error monitoring |
| **Production Ready** | PARCIAL | RLS habilitado pero gaps detectadas, validación incompleta |

### Recomendación Inmediata

**ANTES de cualquier rediseño:**
1. Consolidar migraciones (supabase/sql/ vs supabase/migrations/)
2. Resolver esquema actual definitivamente (tabla pagos vs pago_en_caja vs movimientos_caja)
3. Completar auditoría de Mercado Pago (cuál es la fuente de verdad actual)
4. Documentar reglas de negocio financiero explícitamente

---

## B. STACK ACTUAL

### Frontend

| Componente | Versión | Propósito |
|------------|---------|----------|
| React | 19.2.8 | Framework UI principal |
| TypeScript | 6.0 | Type safety |
| Vite | 8.2.0 | Build tool |
| Tailwind CSS | 4.3.3 | Styling |
| TanStack React Query | 5.101.4 | Server state + caching |
| Zod | 4.4.3 | Runtime validation |
| Lucide React | 1.30.0 | Icon library |
| Recharts | 3.10.1 | Charting |
| vite-plugin-pwa | 1.3.0 | PWA support |

### Backend & Database

| Servicio | Tipo | Propósito |
|----------|------|----------|
| Supabase (PostgreSQL) | Managed BaaS | Database + Auth + Real-time |
| Netlify Functions | Serverless | Sync crons, webhooks |
| Supabase Functions (Deno) | Serverless | RPC + business logic |

### External APIs

| Servicio | Método Auth | Funcionalidad |
|----------|-------------|--------------|
| MercadoPago | Bearer Token + OAuth2 | Pagos, movimientos financieros, webhooks |
| Google OAuth | OpenID Connect | Login federado (implementado pero no default) |

### Env Variables Clave

**Frontend (`VITE_` prefix):**
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

**Backend (process.env):**
- `SUPABASE_SERVICE_ROLE_KEY`
- `MERCADOPAGO_ACCESS_TOKEN` (Bearer para API)
- `MERCADOPAGO_WEBHOOK_SECRET` (HMAC-SHA256)
- `MP_SYNC_WRITE_ENABLED` (boolean para dry-run)
- `SYNC_ACCOUNT_ID` (default: 1054315166)

---

## C. MAPA DEL REPOSITORIO

```
/
├── src/
│   ├── api/              # Capa de acceso a datos (Supabase)
│   │   ├── pedidos.ts    # Pedidos + lineas
│   │   ├── pagos.ts      # Pagos con vinculación a movimientos
│   │   ├── caja.ts       # Movimientos, cheques, comisiones
│   │   ├── clientes.ts   # Gestión de clientes
│   │   ├── lotes.ts      # Lotes avícolas
│   │   ├── producciones.ts
│   │   ├── mercadopago.ts # Integración MP (NUEVA)
│   │   ├── mercadopago-monthly.ts
│   │   ├── arqueos.ts    # Arqueos de caja
│   │   ├── recuentos.ts  # Recuentos de producción
│   │   ├── categorias.ts # Categorías de movimientos
│   │   └── [8+ más]
│   │
│   ├── auth/             # AuthContext, LoginScreen
│   ├── components/       # Shared UI (Modal, Pagination, etc.)
│   ├── constants/        # CATEGORIAS_EGRESOS, CATEGORIAS_INGRESOS, etc.
│   ├── features/         # Feature modules con componentes
│   │   ├── pedidos/      # PedidosApp.tsx
│   │   ├── cobros/       # CobrosApp.tsx
│   │   ├── caja/         # CajaApp.tsx
│   │   ├── finanzas/     # FinanzasApp.tsx
│   │   ├── mercadopago/  # MercadoPagoApp.tsx
│   │   ├── produccion/   # ProductionApp.tsx
│   │   └── admin/        # AdminApp.tsx
│   │
│   ├── hooks/            # Custom React Query hooks
│   │   ├── usePedidos.ts
│   │   ├── usePagos.ts
│   │   ├── useCaja.ts
│   │   ├── useMercadoPago.ts
│   │   ├── [8+ más]
│   │
│   ├── lib/
│   │   ├── supabase.ts   # Supabase client (anon key)
│   │   ├── mercadopago.ts # MP calculation helpers
│   │   └── [helpers]
│   │
│   ├── types/
│   │   └── domain.ts     # TypeScript interfaces
│   │
│   ├── validation/
│   │   └── schemas.ts    # Zod schemas
│   │
│   ├── utils/
│   │   ├── dateUtils.ts
│   │   ├── pedidosCalculos.ts
│   │   ├── produccionCalculos.ts
│   │   └── [helpers]
│   │
│   └── App.tsx           # Root with tab-based routing
│
├── netlify/functions/    # Serverless functions
│   ├── sync-mercadopago-releases.ts
│   ├── sync-mercadopago-movements.ts
│   ├── webhook-mercadopago.ts
│   ├── sync-mercadopago-settlement.ts
│   ├── check-rate-limit.ts
│   └── [debug utilities]
│
├── supabase/
│   ├── sql/              # ETAPA 1-2 Migraciones (47 archivos)
│   │   ├── 001_schema.sql
│   │   ├── 019_create_caja_tables.sql
│   │   ├── 031_enable_rls_financial_tables.sql
│   │   └── [044 más]
│   │
│   ├── migrations/       # ETAPA 0 Mercado Pago (10 archivos)
│   │   ├── 001_mercadopago_schema.sql (OLD)
│   │   ├── 004_mp_new_architecture.sql (NEW)
│   │   ├── 007_reconciliation_tables.sql
│   │   └── [7 más]
│   │
│   ├── functions/        # Supabase Functions
│   │   ├── check-rate-limit/
│   │   └── sync-mercadopago/
│   │
│   └── tests/            # SQL-based tests
│
├── scripts/              # Utility scripts (20+ debugging scripts)
│
├── .env.local            # Production secrets
├── netlify.toml          # Deployment config
├── vite.config.ts        # Build config
└── package.json          # Dependencies
```

**Responsabilidades Principales:**
- **src/api/** → Consultas directas a Supabase, retorna DTOs tipados
- **src/hooks/** → React Query wrappers, caching + refetch logic
- **src/features/** → UI Components, user interactions, tab-based routing
- **netlify/functions/** → Async jobs (MP sync), webhooks, rate limiting
- **supabase/sql/** → Schema core (pedidos, clientes, caja)
- **supabase/migrations/** → Schema Mercado Pago (nueva arquitectura FASE 0)

---

## D. MAPA COMPLETO DE BASE DE DATOS

### Directorio 1: supabase/sql/ (47 archivos) — Esquema Core

**Tablas Principales:**

#### Entidad: Organización & Usuarios
| Tabla | Columnas Clave | Descripción | Estado |
|-------|---|---|---|
| **perfiles** | id (FK auth.users), nombre, rol, created_at | Usuarios del sistema | ACTIVA |
| **rol_type** (enum) | 'dueño', 'repartidor' | Roles de acceso | ACTIVA |

#### Entidad: Clientes & Pedidos
| Tabla | Columnas Clave | Descripción | Estado |
|-------|---|---|---|
| **clientes** | id (UUID), nombre (UNIQUE), activo, created_at | Clientes del negocio | ACTIVA |
| **pedidos** | id (UUID), cliente_id (FK), lineas (JSONB), estado, monto_total, creado_en | Órdenes de venta | ACTIVA |
| **pedido_lineas** | id (SERIAL), pedido_id (FK), producto_id, cantidad, precio_unitario, subtotal | Líneas de detalle | ACTIVA |
| **categoria** (enum) | 'jumbo', 'aaa', 'aa', 'a', 'b' | Clasificación de huevos | ACTIVA |
| **pedido_estado** (enum) | 'pendiente', 'entregado', 'cancelado' | Estados de pedido | ACTIVA |

#### Entidad: Productos
| Tabla | Columnas Clave | Descripción | Estado |
|-------|---|---|---|
| **productos** | id, nombre, categoria, precio, activo | Catálogo de productos | ACTIVA |
| **precios_actuales** | categoria (PK), precio, actualizado_por, actualizado_en | Precios por categoría | ACTIVA |
| **precios_historial** | id, categoria, precio, vigente_desde, vigente_hasta | Auditoría de cambios | ACTIVA |

#### Entidad: Caja (Finanzas)
| Tabla | Columnas Clave | Descripción | Estado |
|-------|---|---|---|
| **movimientos_caja** | id (SERIAL), tipo (ingreso/egreso), monto, forma_pago, fecha_operacion, estado, vinculado_a, vinculado_id, cliente_id | Movimientos financieros diarios | ACTIVA |
| **movimiento_tipo** (enum) | 'ingreso', 'egreso' | Tipos de movimiento | ACTIVA |
| **movimiento_estado** (enum) | 'pendiente', 'confirmado', 'cancelado' | Estados | ACTIVA |
| **forma_pago_type** (enum) | ⚠️ **CONTRADICCIÓN:** Ver sección L | Formas de pago | ⚠️ INCONSISTENTE |
| **pagos** | id (SERIAL), cliente_id (FK), monto, metodo_pago, fecha_pago, estado | Pagos de clientes | ACTIVA |
| **pago_en_caja** | id (SERIAL), pago_id (FK), creado_en | Confirmación de pago en caja | DUPLICADA (?) |
| **cheques** | id, numero (UNIQUE), banco, monto, fecha_emision, estado | Cheques emitidos/recibidos | ACTIVA |
| **cheque_estado** (enum) | 'emitido', 'cobrado', 'rechazado', 'cancelado' | Estados | ACTIVA |
| **comisiones** | id, concepto, monto, porcentaje, fecha_operacion, movimiento_caja_id | Comisiones y deducciones | ACTIVA |

#### Entidad: Producción Avícola
| Tabla | Columnas Clave | Descripción | Estado |
|-------|---|---|---|
| **lotes** | id (UUID), galpon, fecha_ingreso, poblacion_inicial, estado, creado_por | Lotes de aves | ACTIVA |
| **lote_estado** (enum) | 'Activo', 'Retirado', 'Planificado' | Estados de lote | ACTIVA |
| **producciones** | id (SERIAL), fecha, galpon, lote_id, huevos_sanos, huevos_rotos, huevos_cachados, huevos_sucios, descartados, poblacion, mortalidad, alimento, notas | Registro diario de producción | ACTIVA |
| **recuentos_lote** | id (SERIAL), lote_id, fecha, poblacion, mortalidad, observaciones | Auditoría de población | ACTIVA |

#### Entidad: Configuración
| Tabla | Columnas Clave | Descripción | Estado |
|-------|---|---|---|
| **categorias_finanzas** | id, nombre, tipo (ingreso/egreso), activo | Categorías de movimientos | ACTIVA |
| **login_attempts** | id, email, ip, timestamp, exitoso | Rate limiting | ACTIVA |

### Directorio 2: supabase/migrations/ (10 archivos) — ETAPA 0 Mercado Pago

**Tablas Nueva Arquitectura:**

#### FASE 0: Normalización de Mercado Pago
| Tabla | Propósito | Estado |
|-------|----------|--------|
| **mp_source_record** | RAW data versionada (CSV, API, webhook) con deduplicación payload_hash | NUEVA |
| **mp_financial_movement** | Movimiento normalizado (ONE per economic event) con clasificación | NUEVA |
| **mp_movement_source_link** | Relación many-to-one (source_records → financial_movement) | NUEVA |
| **ledger_entry** | Impacto en balance por movimiento (linking a mp_financial_movement) | NUEVA |
| **account_balance** | Saldo acumulado por día (calculated from ledger) | NUEVA |

**Tablas Legacy (Aparentemente No Usadas en Nueva Arquitectura):**
- `mercadopago_raw` (migration 001)
- `mercadopago_movements` (migration 002)
- `mercadopago_settlement` (migration 003)
- `sync_metadata` (migration 001)

**Tablas de Reconciliación:**
| Tabla | Propósito | Estado |
|-------|----------|--------|
| **import_period_coverage** | Qué períodos han sido importados | ACTIVA |
| **reconciliation_snapshot** | Snapshots de auditoría | ACTIVA |
| **period_flow_observation** | Observaciones por período | ACTIVA |
| **monthly_reconciliation** | Reconciliación mensual | ACTIVA |
| **mp_source_link_resolution** | Resolución de conflictos de deduplicación | ACTIVA |
| **mp_import_exception** | Excepciones durante import | ACTIVA |
| **mp_financial_cycle** | Ciclos financieros | ACTIVA |

### Relaciones Clave Detectadas

```
perfiles (auth.users)
    ↓
clientes → pedidos ↔ pedido_lineas → productos ↔ precios_actuales
    ↓
pagos → movimientos_caja → (cheques, comisiones)
    ↓
pago_en_caja (?)

lotes → producciones
    ↓
recuentos_lote

mercadopago (EXTERNA) → mp_source_record
                     ↓
              mp_financial_movement ← ledger_entry
                     ↓
              account_balance
```

### Índices Importantes

**Presentes:**
- `idx_pedidos_estado`, `idx_pedidos_cliente_id`, `idx_pedidos_creado_en`
- `idx_movimientos_caja_fecha_operacion`, `idx_movimientos_caja_vinculado`
- `idx_cheques_fecha_vencimiento`, `idx_cheques_estado`
- `idx_mp_source_type_id`, `idx_mp_source_payload_hash`, `idx_mp_source_observed_at`

**Ausentes (Posible problema de performance):**
- FK sin índices en movimientos_caja.cliente_id
- FK sin índices en pagos.cliente_id
- Posibles N+1 queries en hooks

### RLS Policies

**Habilitadas en:**
- movimientos_caja, pagos, cheques, comisiones (migration 031_enable_rls_financial_tables.sql)
- Toda tabla financiera debería tener RLS

**Patrón:**
```sql
SELECT: auth.role() = 'authenticated'
INSERT/UPDATE/DELETE: is_dueño()  -- Custom function
```

**⚠️ GAP DETECTADO:** `is_dueño()` function debe estar definida en migration 002_functions.sql

---

## E. MAPA DE MÓDULOS FUNCIONALES

### 1. PEDIDOS

| Funcionalidad | Implementación | Estado |
|---|---|---|
| Crear pedido | `crearPedido()` en src/api/pedidos.ts | ✅ COMPLETO |
| Listar pedidos | `listarPedidos()` con cálculo dinámico de total | ✅ COMPLETO |
| Marcar entregado | `marcarEntregado()` | ✅ COMPLETO |
| Rectificar (cambiar líneas) | `rectificarPedido()` | ✅ COMPLETO |
| Cancelar pedido | `cancelarPedido()` | ✅ COMPLETO |
| UI | `<PedidosApp />` en features/pedidos/ | ✅ COMPLETO |

**Regla Crítica:** Monto total se calcula dinámicamente desde lineas, no se confía en stored value
```typescript
const calculatedTotal = lineas.reduce((sum, linea) => sum + Number(linea.subtotal), 0);
```

### 2. PAGOS & COBROS

| Funcionalidad | Implementación | Estado |
|---|---|---|
| Crear pago | `crearPago()` crea pago + movimiento_caja automáticamente | ✅ COMPLETO |
| Listar pagos por cliente | `listarPagosCliente()` | ✅ COMPLETO |
| Listar todos pagos | `listarTodosPagos()` | ✅ COMPLETO |
| Vincular a movimiento caja | Automático en crearPago() | ✅ COMPLETO |
| UI | `<CobrosApp />` | ✅ COMPLETO |
| Verificar si pago en caja | `verificarPagoEnCaja()` | ✅ COMPLETO |

**Flujo Actual:**
```
crearPago() 
  → INSERT pagos 
  → INSERT/UPDATE movimientos_caja 
     (vinculado_a='pago', vinculado_id=pago.id)
  → vincular opcionalmente a cheque/comisión
```

### 3. CAJA (Tesorería)

| Funcionalidad | Implementación | Estado |
|---|---|---|
| Crear movimiento manual | `crearMovimientoCaja()` | ✅ COMPLETO |
| Listar movimientos | `listarMovimientosCaja()` con paginación | ✅ COMPLETO |
| Actualizar movimiento | `actualizarMovimientoCaja()` | ✅ COMPLETO |
| Crear cheque | `crearCheque()` | ✅ COMPLETO |
| Crear comisión | `crearComision()` | ✅ COMPLETO |
| Anular movimiento | `anularMovimiento()` | ✅ COMPLETO |
| Resumen de caja | `obtenerResumenCaja()` por fecha | ✅ COMPLETO |
| Arqueos (auditoría) | `crearArqueo()`, `listarArqueos()` | ✅ COMPLETO |
| Sincronizar pagos con caja | `sincronizarPagosConCaja()` | ⚠️ EXISTE pero sin docs |
| UI | `<CajaApp />` | ✅ COMPLETO |

### 4. MERCADO PAGO

| Funcionalidad | Implementación | Estado |
|---|---|---|
| Sincronizar reportes | `sync-mercadopago-releases.ts` (Netlify cron) | ✅ IMPLEMENTADO |
| Procesar webhooks | `webhook-mercadopago.ts` | ✅ IMPLEMENTADO |
| Sincronizar movimientos | `sync-mercadopago-movements.ts` | ✅ IMPLEMENTADO |
| Sincronizar settlement | `sync-mercadopago-settlement.ts` | ✅ IMPLEMENTADO |
| Obtener resumen MP | `getMPSummary()`, `getMPPeriod()` | ✅ IMPLEMENTADO |
| Reporte mensual MP | `getMPMonthlyReport()` | ✅ IMPLEMENTADO |
| Cálculos de ledger | `mercadopago.ts` utilities | ✅ IMPLEMENTADO |
| UI | `<MercadoPagoApp />` | ✅ IMPLEMENTADO |

**Estado:** EN TRANSICIÓN
- Nueva arquitectura (mp_source_record → mp_financial_movement) IMPLEMENTADA
- Código de sincronización usa ambas arquitecturas (OLD y NEW)
- Reconciliación complex con múltiples source types (report, api, webhook)

### 5. PRODUCCIÓN AVÍCOLA

| Funcionalidad | Implementación | Estado |
|---|---|---|
| Crear lote | `crearLote()` | ✅ COMPLETO |
| Listar lotes | `listarLotes()`, `listarLotesActivos()` | ✅ COMPLETO |
| Registrar producción diaria | `crearProduccion()` | ✅ COMPLETO |
| Actualizar producción | `actualizarProduccion()` | ✅ COMPLETO |
| Registrar recuento | `crearRecuento()` | ✅ COMPLETO |
| Cálculos de métricas | `produccionCalculos.ts` | ✅ IMPLEMENTADO |
| UI | `<ProductionApp />` (819 líneas, muy grande) | ✅ COMPLETO |

**Flujo:**
```
Lote (ingreso aves)
  ↓
Producción diaria (fecha, galpon, huevos, mortalidad)
  ↓
Recuentos (auditoría de población)
```

### 6. FINANZAS & REPORTES

| Funcionalidad | Implementación | Estado |
|---|---|---|
| Dashboard de categorías | Lectura de categorias_finanzas | ✅ EXISTE |
| Crear categoría | `crearCategoria()` | ✅ EXISTE |
| Actualizar categoría | `actualizarCategoria()` | ✅ EXISTE |
| Asignar categoría a movimiento | `actualizarMovimientoCategoria()` | ✅ EXISTE |
| Reportes por período | Múltiples helpers | ⚠️ PARCIAL |
| Rentabilidad | No encontrado en búsqueda | ❌ NO VERIFICADO |
| UI | `<FinanzasApp />` | ✅ EXISTE |

### 7. ADMINISTRACIÓN

| Funcionalidad | Implementación | Estado |
|---|---|---|
| Gestión de usuarios | Lectura de perfiles tabla | ✅ PARCIAL |
| Gestión de clientes | `listarClientes()`, `crearCliente()`, `actualizarCliente()` | ✅ COMPLETO |
| Gestión de productos | Lectura de productos, precios | ✅ COMPLETO |
| Configuración de precios | `actualizarPrecio()` | ✅ COMPLETO |
| UI | `<AdminApp />` | ✅ EXISTE |

### RESUMEN ESTADO MÓDULOS

| Módulo | Implementado | Parcial | No Verificado |
|--------|---|---|---|
| Pedidos | ✅ | | |
| Pagos/Cobros | ✅ | | |
| Caja | ✅ | | |
| Producción | ✅ | | |
| MercadoPago | ✅ | | (EN TRANSICIÓN) |
| Finanzas | | ✅ | |
| Admin | ✅ | ✅ | |

---

## F. FLUJO FINANCIERO ACTUAL

### Flujo A: VENTA → COBRO → SALDO

```
[VENTA]
  └─→ crearPedido(cliente_id, lineas)
        ├─→ INSERT pedidos (monto_total = 0, será calculado luego)
        ├─→ INSERT pedido_lineas (x N líneas)
        └─→ Pedido creado, PENDIENTE

[ENTREGA]
  └─→ marcarEntregado(pedido_id)
        └─→ UPDATE pedidos (estado='entregado', entregado_en, entregado_por)

[COBRO]
  └─→ crearPago(cliente_id, monto, metodo_pago, fecha_pago)
        ├─→ INSERT pagos (monto, metodo_pago, fecha_pago)
        ├─→ INSERT movimientos_caja 
        │    (tipo='ingreso', concepto=f"Cobro - {cliente}",
        │     monto, forma_pago, vinculado_a='pago', vinculado_id=pago.id)
        ├─→ ✓ Pago registrado
        └─→ ✓ Movimiento caja creado automáticamente

[CONSULTA DE SALDO]
  └─→ SUM(movimientos_caja WHERE cliente_id = X AND tipo = 'ingreso')
        ├─→ No existe tabla separada de "saldo_cliente"
        ├─→ Se calcula ad-hoc desde movimientos
        └─→ ⚠️ FUENTE DE VERDAD UNCLEAR
```

**⚠️ PROBLEMA DETECTADO:**
- Aunque crearPago() automáticamente crea movimiento_caja
- La tabla `pagos` también almacena el monto
- **Redundancia:** El mismo cobro está en dos lugares
  - pagos.monto
  - movimientos_caja (tipo='ingreso', vinculado_a='pago')

### Flujo B: COMPRA/GASTO

```
[GASTO / COMPRA]
  └─→ crearMovimientoCaja(tipo='egreso', monto, forma_pago, ...)
        ├─→ INSERT movimientos_caja (tipo='egreso')
        ├─→ Opcionalmente vincular a proveedor (no implementado)
        └─→ ✓ Movimiento registrado

[PAGO A PROVEEDOR]
  └─→ También via crearMovimientoCaja (tipo='egreso')
        └─→ vinculado_a= null o 'proveedor'?
```

**⚠️ PROBLEMA DETECTADO:**
- No hay tabla separada de `proveedores`
- No hay tabla de `compras` o `órdenes`
- Los gastos se registran directamente en movimientos_caja
- No hay vinculación formal compra → pago

### Flujo C: TRANSFERENCIA ENTRE CUENTAS

```
[TRANSFERENCIA BANCARIA]
  └─→ crearMovimientoCaja (tipo='egreso', cuenta_origen, cuenta_destino)
  └─→ crearMovimientoCaja (tipo='ingreso', cuenta_destino)
        ├─→ DOS movimientos separados
        └─→ ⚠️ NO hay atomicidad garantizada
```

### Cálculo de Saldos Actual

**Quién calcula:**
- FRONTEND: Ad-hoc queries en componentes (FinanzasApp, etc.)
- SUPABASE: No hay MATERIALIZED VIEW de saldo

**Cómo:**
```sql
-- Saldo efectivo (cash)
SELECT SUM(CASE 
  WHEN tipo='ingreso' THEN monto 
  WHEN tipo='egreso' THEN -monto 
  END)
FROM movimientos_caja
WHERE fecha_operacion <= ?

-- Saldo por cliente (deuda)
SELECT SUM(monto) FROM pagos WHERE cliente_id = ?
```

**⚠️ PROBLEMAS:**
1. No hay tabla audit de "saldo_diario"
2. Cálculos distribuidos en frontend (múltiples queries)
3. Sin transacciones garantizadas para operaciones de 2+ pasos
4. Saldo de cliente: ¿es SUM(pagos) o SUM(movimientos_caja)?

### Estado de Deuda Actual

**Tabla Ausente:** No existe tabla `deudas` o `cuentas_corrientes` formal

**Cómo se representa:**
- Implícitamente en pedidos + pagos
- Deuda = SUM(pedido.monto_total) - SUM(pagos.monto)
- **Cálculo manual, no persistido**

---

## G. FLUJO MERCADO PAGO ACTUAL

### Arquitectura: Dual (Legacy + Nueva)

**LEGACY** (No recomendado, aparentemente en desuso):
- mercadopago_raw (CSV import)
- mercadopago_movements
- mercadopago_settlement
- sync_metadata

**NUEVA ARQUITECTURA** (FASE 0 — Implementada):
```
MP DATA (external)
  ↓
[sync-mercadopago-releases.ts] cron (02:00 UTC daily)
  ↓
mp_source_record (SHA256 payload dedup)
  ↓
[import_financial_movements_reconciliation_v2] PostgreSQL RPC
  ├─→ Classification logic (payment_in, payment_out, yield, transfer_in, transfer_out, unclassified)
  ├─→ Handling of duplicates (payload_hash)
  ├─→ Reserve movements (RAW-only)
  └─→ Conflict resolution
  ↓
mp_financial_movement (normalized)
  ↓
ledger_entry (impact on account balance)
  ↓
account_balance (calculated daily balance)
```

### Fuentes de Datos

| Fuente | Endpoint | Frecuencia | Handler |
|--------|----------|-----------|---------|
| Account Money Report | `/v1/account/release_report` | Daily 02:00 UTC | sync-mercadopago-releases.ts |
| Webhook | POST /webhooks/mercadopago | Real-time | webhook-mercadopago.ts |
| Settlement API | `/v1/account/settlement` | Manual query | sync-mercadopago-settlement.ts |

### Movimientos MP Clasificados

| Clase | Ejemplo | Impacto |
|-------|---------|--------|
| **payment_in** | Transferencia recibida de MP por ventas | +balance |
| **payment_out** | Retiro de fondos | -balance |
| **yield** | Intereses, rendimientos | +balance |
| **transfer_in** | Transferencia entre cuentas | +balance |
| **transfer_out** | Transferencia saliente | -balance |
| **unclassified** | Unknown/error | pending review |

### Deduplicación

```
NIVEL 1: source_external_id (SOURCE_ID del CSV)
NIVEL 2: payload_hash (SHA256 del raw_data)
         → Permite versionado (mismo objeto, diferentes observaciones)

RESULTADO: Tabla mp_source_link_resolution 
           para conflictos donde múltiples sources apuntan a mismo movement
```

### Reconciliación

**Tablas Clave:**
- `import_period_coverage` — Qué períodos han sido importados
- `reconciliation_snapshot` — Estado de ledger en punto de tiempo
- `monthly_reconciliation` — Cierre mensual
- `mp_import_exception` — Errores durante import

**Proceso:**
1. Import batch de source records
2. Normalización a financial movements
3. Detección de conflictos/duplicados
4. Resolución automática (si posible)
5. Registro de excepciones
6. Ledger balance verification

### ⚠️ RIESGO CRÍTICO DETECTADO

**Migración En Proceso:**
- Código actual usa AMBAS arquitecturas
- No claro cuál es la "source of truth"
- Migration 010_fix_import_v2_classifications indica fixes recientes
- Posibles datos inconsistentes entre tablas OLD y NEW

---

## H. FLUJO PRODUCTIVO ACTUAL

### Flujo Base

```
[ENTRADA LOTE]
  └─→ crearLote(galpon, poblacion_inicial, ...)
        ├─→ INSERT lotes (estado='Activo', poblacion_inicial)
        └─→ Lote creado

[PRODUCCIÓN DIARIA]
  └─→ crearProduccion(fecha, galpon, huevos_sanos, huevos_rotos, ...)
        ├─→ INSERT producciones (todas las categorías de huevos)
        ├─→ Cálculo: huevos_totales = sanos + rotos + cachados + sucios - descartados
        ├─→ Cálculo: postura = huevos_sanos / poblacion * 100
        └─→ Registro creado

[AUDITORÍA DE POBLACIÓN]
  └─→ crearRecuento(lote_id, fecha, poblacion, mortalidad, ...)
        ├─→ INSERT recuentos_lote
        └─→ Auditoría de poblacion_actual vs initial
```

### Tabla Producciones — Columnas

```
producciones {
  id SERIAL PK
  fecha DATE
  galpon TEXT              -- 'Galpon 1', 'Galpon 2', etc
  lote_id UUID FK lotes
  huevos_sanos INT
  huevos_rotos INT
  huevos_cachados INT
  huevos_sucios INT
  descartados INT
  poblacion INT            -- Población en esa fecha
  mortalidad INT           -- Aves muertas
  alimento NUMERIC         -- Kg alimento consumido
  notas TEXT
  creado_por UUID FK
  creado_en TIMESTAMP
}
```

### Cálculos Derivados

```
huevos_totales = huevos_sanos + huevos_rotos + huevos_cachados + huevos_sucios
postura = (huevos_sanos / poblacion) * 100
mortalidad_pct = (mortalidad / poblacion_inicial) * 100
poblacion_actual = poblacion_inicial - SUM(mortalidad)
alimento_por_ave = alimento / poblacion
```

**⚠️ ALMACENAMIENTO:** Los cálculos derivados (`huevos_totales`, `postura`) se CALCULAN en frontend, no persistidos

### Métricas por Período

Archivo: `src/utils/produccionCalculos.ts`

```typescript
// Agrega producciones por período
export function calcularMetricasPeriodoPedidos(
  producciones: Produccion[],
  startDate: string,
  endDate: string
): MetricasPeriodo {
  return {
    huevos_totales_periodo,
    postura_promedio,
    mortalidad_promedio,
    alimento_total,
    // ...
  };
}
```

### UI: ProductionApp (819 líneas)

- Muy grande (debería dividirse)
- Contiene formularios, tablas, cálculos, lógica
- Múltiples hooks: useProducciones, useLotes, useRecuentos

---

## I. FLUJO DE STOCK ACTUAL

### Representación de Stock

**Tablas:**
- `productos` (catálogo)
- `pedido_lineas` (salidas de stock implícitas)
- **No existe tabla separada `movimientos_stock`**
- **No existe tabla `ubicaciones`**

### Cómo Funciona Actualmente

```
ENTRADA: 
  └─→ Mercado Pago transfer (ingreso de $ == ingreso de huevos)
  └─→ Producción diaria (genera stock de huevos)

SALIDA:
  └─→ pedido_lineas (cuando se vende)
        ├─→ Línea vinculada a pedido
        ├─→ pero NO hay validación de "hay stock disponible"
        └─→ NO hay movimiento_stock que lo registre

CONSULTA:
  └─→ SUM(producciones WHERE fecha BETWEEN X AND Y)
        ├─→ Calcula huevos generados
  └─→ SUM(pedido_lineas WHERE categoria = 'jumbo')
        ├─→ Calcula huevos vendidos
  └─→ STOCK = producido - vendido (cálculo ad-hoc, no persistido)
```

### ⚠️ PROBLEMAS

1. **Sin tabla de stock:** No existe `inventario` o `stock_diario`
2. **Sin movimientos:** No hay auditoría de entradas/salidas
3. **Sin validación:** Puedo vender más de lo que produjo
4. **Sin ubicaciones:** Todos los huevos van a una "caja"
5. **Sin expiración:** Productos perecederos sin fecha de vencimiento

---

## J. REGLAS DE NEGOCIO ENCONTRADAS

### Pedidos

| Regla | Ubicación | Implementación |
|-------|-----------|---|
| Monto total de pedido = SUM(linea.subtotal) | src/api/pedidos.ts:59 | Cálculo dinámico, no confía en stored |
| Estado ciclo: pendiente → entregado → ? | Componentes UI | Solo 2 estados activos |
| Cancelar pedido es permitido siempre | pedidos.ts:189 | Cambio estado a 'cancelado' |
| Rectificar pedido permite cambiar líneas | pedidos.ts:128 | Recalcula monto_total |

### Pagos

| Regla | Ubicación | Implementación |
|-------|-----------|---|
| Crear pago AUTO genera movimiento_caja | src/api/pagos.ts:56-96 | INSERT + UPDATE en transacción implícita |
| Métodos: efectivo, mercadopago, transferencia, cheque, echeq | src/types/domain.ts | Enum MetodoPago |
| Forma pago mapeada: tarjeta→mercadopago, cheque→transferencia | pagos.ts:44 | Record de mapeo |
| Pago sin vinculación es permitido | No requerido | NULL movimientoCajaId |

### Caja

| Regla | Ubicación | Implementación |
|-------|-----------|---|
| Movimiento tipo: ingreso o egreso | movimiento_tipo enum | Binary choice |
| Movimiento estado: pendiente, confirmado, cancelado | movimiento_estado enum | Enum de 3 valores |
| Movimiento puede vincularse a: pedido, pago, ninguno | vinculado_a VARCHAR | Free-form string |
| Anular movimiento requiere motivo | caja.ts:204 | motivo? parameter |
| Resumen caja incluye: movimientos + saldo efectivo | caja.ts:240 | GROUP BY + SUM |

### Producción

| Regla | Ubicación | Implementación |
|-------|-----------|---|
| Huevos totales = sanos + rotos + cachados + sucios | produccionCalculos.ts | Cálculo |
| Postura = huevos_sanos / poblacion * 100 | Mismo archivo | Cálculo |
| Mortalidad se registra independientemente | producciones.ts | Campo separado |
| Lote estado: Activo, Retirado, Planificado | lote_estado enum | Enum de 3 |
| Galpones son strings: "Galpon 1", etc | Hardcoded en constants | CATEGORIAS_GALPONES |

### Mercado Pago

| Regla | Ubicación | Implementación |
|-------|-----------|---|
| Deduplicación by source_external_id + payload_hash | 010_fix_import_v2_classifications.sql | UNIQUE constraint |
| Reservas son "RAW-only" siempre | Mismo archivo:22 | is_raw_only() function |
| Clasificación: +amount = payment_in, -amount = payment_out | Mismo archivo:line 80+ | Custom logic |
| asset_management = yield (no payment_in) | Mismo archivo:comment | Fixed in v2 |

### Configuración

| Regla | Ubicación | Implementación |
|-------|-----------|---|
| Roles: dueño (acceso completo), repartidor (lectura?) | perfiles table | rol_type enum |
| RLS: solo dueño puede modificar finanzas | 031_enable_rls_financial_tables.sql | is_dueño() policy |
| Precios por categoría (jumbo, aaa, aa, a, b) | precios_actuales | Enum categoria PK |
| Precio histórico se mantiene | precios_historial | Audit table |

---

## K. DEUDA TÉCNICA

### CRÍTICA (1 semana)

| Problema | Ubicación | Impacto | Solución |
|----------|-----------|--------|----------|
| **Dos directorios de migraciones** | supabase/sql/ vs supabase/migrations/ | Schema unclear, deployment confusing | Consolidar en uno |
| **Enum forma_pago_type duplicado** | 019_create_caja_tables.sql + ?? | DDL error, unknown which is active | Unify enum definition |
| **Ledger balance validation falla** | mercadopago.ts:38-44 | System becomes unavailable if divergence | Remove validation block, log error instead |
| **Múltiples fuentes de verdad MP** | Old+New architecture coexist | Data inconsistency, reconciliation unclear | Complete migration FASE 0 |
| **Tabla pagos vs pago_en_caja** | pagos.ts + sql/ | Is pago_en_caja ever used? | Audit usage, consolidate |

### ALTO (1 mes)

| Problema | Ubicación | Impacto |
|----------|-----------|--------|
| **150+ console.log statements** | Throughout src/ | Production noise, perf, bloat |
| **No tests for 50+ API functions** | src/api/*.ts | Zero coverage, regressions hidden |
| **Missing FK constraints** | Schema | Orphaned records possible |
| **RLS gaps on MP tables** | supabase/migrations/ | Unauthorized data access possible |
| **No error monitoring/logging system** | Entire app | Silent failures, debugging nightmare |
| **Large components** | ProductionApp 819 lines | Unmaintainable, hard to test |
| **Duplicate date formatting logic** | Multiple files | DRY violation |
| **Duplicate line extraction pattern** | pedidosCalculos.ts, otros | Code smells |
| **Webhook no idempotency keys** | webhook-mercadopago.ts | Duplicates possible |
| **Fire-and-forget async ops** | Various | Race conditions, partial updates |
| **Migration number conflicts** | 009_*, 010_* | Which is applied? |

### MEDIO (3 meses)

| Problema | Ubicación | Impacto |
|----------|-----------|--------|
| **Offset-based pagination** | Most API calls | Inconsistent across changes |
| **No stored procedures for complex queries** | All in API layer | N+1 queries, perf issues |
| **Calculated fields not cached** | Frontend calculations | Repeated computation |
| **No saldo_diario table** | Finance flows | Auditing difficult |
| **No accounts table** | All hardcoded | Scaling to multi-tenant blocked |
| **No provider/supplier table** | Only implicit via movimientos | Expense tracking weak |
| **TypeScript not strict** | tsconfig | Unused variables allowed |
| **Missing @types packages** | package.json | Type safety gaps |

---

## L. POSIBLES MÚLTIPLES FUENTES DE VERDAD

### 1. FORMA_PAGO_TYPE — CONTRADICCIÓN DETECTADA

**Versión 1** (presumiblemente vieja):
```sql
CREATE TYPE forma_pago_type AS ENUM ('efectivo', 'mercadopago', 'transferencia');
```

**Versión 2** (019_create_caja_tables.sql):
```sql
create type forma_pago_type as enum ('efectivo', 'mercadopago', 'echeq', 'cheque');
```

**Discrepancia:** v1 tiene 'transferencia', v2 no. v2 tiene 'echeq', v1 no.
**Estado:** ⚠️ UNKNOWN WHICH IS ACTIVE

### 2. TOTAL PEDIDO — CALCULATED vs STORED

**Stored:** `pedidos.monto_total` (columna)
**Calculated:** `SUM(pedido_lineas.subtotal)` (frontend)

```typescript
// Línea 56-66 en pedidos.ts:
const calculatedTotal = lineas.reduce((sum, linea) => sum + (Number(linea.subtotal) || 0), 0);
const storedTotal = Number(p.monto_total);
const finalTotal = lineas.length > 0 ? calculatedTotal : validStoredTotal;
```

**Decisión:** Prefer calculated if lineas exist
**Risk:** If lineas are deleted without updating monto_total, orphaned stored value

### 3. SALDO CLIENTE — NO TABLA AUDIT

**Definición en Código:**
```typescript
// Implícito en múltiples places
saldo = SUM(pagos.monto) - SUM(pedidos.monto_total) // ???
// O:
saldo = SUM(movimientos_caja WHERE cliente_id = X AND tipo='ingreso')
```

**No tabla:** `saldo_cliente` o `cuentas_corrientes`
**Calcular Ad-hoc:** En cada query
**Risk:** Inconsistent calculations, no audit trail

### 4. MERCADO PAGO — OLD vs NEW ARCHITECTURE

**Old tables:**
- mercadopago_raw
- mercadopago_movements
- mercadopago_settlement
- sync_metadata

**New tables:**
- mp_source_record
- mp_financial_movement
- ledger_entry
- account_balance
- reconciliation_snapshot
- etc.

**Question:** Are old tables still populated? Are they used?
**Risk:** Divergence between old and new data

### 5. PAGOS — STORED IN TWO PLACES

**Table 1:** `pagos` (cliente_id, monto, fecha_pago, metodo_pago)
**Table 2:** `movimientos_caja` (vinculado_a='pago', vinculado_id=pago.id, monto, tipo='ingreso')

**Redundancy:** Same pago amount stored twice
**Risk:** Update one but not the other → divergence

### 6. STOCK — CALCULATED NOWHERE

**No table:** No `inventario` or `stock_actual`
**Calculated:** Ad-hoc as `SUM(producciones) - SUM(pedido_lineas)`
**Risk:** Impossible to audit historical stock

---

## M. RIESGOS DE MIGRACIÓN

### Riesgos Arquitectónicos

1. **Dual Migration Systems** — supabase/sql/ and supabase/migrations/ must be unified before ANY major change

2. **Mercado Pago Reconciliation** — Incomplete FASE 0 migration means financial data integrity unclear

3. **Saldo Calculation** — No centralized authority for balance; frontend does ad-hoc queries

4. **No multi-tenancy** — All organization data mixed; scaling to multiple farms blocked

### Riesgos de Performance

1. **N+1 queries** — Probable in listarPedidos() (fetches user names separately)

2. **No pagination for large datasets** — Offset-based, inconsistent with edits

3. **No materialized views** — Repeated expensive calculations (postura, mortalidad, saldo)

### Riesgos de Data Loss

1. **Fire-and-forget async** — If crearPago() webhook fails mid-execution, movimiento_caja may not be created

2. **No transactions** — Multi-step operations (pago + movimiento) not ACID guaranteed at DB level

3. **RLS gaps** — Someone could bypass policies and delete financial records

### Riesgos de Consistency

1. **No constraints** — FK missing, allowing orphaned records

2. **Null inconsistencies** — vinculado_id can be null unpredictably

3. **Enum conflicts** — forma_pago_type duplicated, unclear which is live

### Riesgos de Compliance

1. **No audit trail** — Cannot prove who changed what when for financial records

2. **Webhook signature not validated** — MercadoPago webhooks accepted without HMAC check (FIXED in recent commit)

3. **No encryption for sensitive data** — Stored plainly in DB

---

## N. INFORMACIÓN QUE NO PUDISTE DETERMINAR

### Funcionalidades Mencionadas pero No Verificadas

- [ ] **Cuentas corrientes** — ¿Existe implementación? ¿Dónde?
- [ ] **Rentabilidad** — ¿Cómo se calcula? ¿Dónde?
- [ ] **Proveedores** — ¿Tabla separada o integrada en movimientos?
- [ ] **Compras formales** — ¿Existe tabla `compras` o `órdenes`?
- [ ] **Alimento (costos)** — ¿Cómo se relaciona con gastos?
- [ ] **Reportes** — ¿Qué reportes existente realmente?
- [ ] **Métricas avanzadas** — ¿Eficiencia de conversión, índices de postura históricos?
- [ ] **Alertas** — ¿Hay notificaciones por baja población, mortalidad alta?

### Tablas/Funciones Encontradas pero No Documentadas

- [ ] `pago_en_caja` — ¿Se usa? ¿Cuál es su propósito vs `pagos`?
- [ ] `login_attempts` — ¿Funciona el rate limiting?
- [ ] `import_period_coverage` — ¿Cómo se usa? ¿Quién mantiene?
- [ ] `mp_source_link_resolution` — ¿Cuándo se activa?
- [ ] `monthly_reconciliation` — ¿Se ejecuta automáticamente?

### Código Probablemente Legacy

- mercadopago_raw table — ¿Por qué sigue existiendo?
- mercadopago_movements table — ¿Por qué no deletear si es viejo?
- sync_metadata table — ¿Cuándo fue usado último?

### Incertidumbres en Reglas de Negocio

- ¿Un pedido cancelado puede reembolsarse?
- ¿Se pueden rectificar pagos?
- ¿Cómo se manejan devoluciones (huevos rotos de cliente)?
- ¿Qué sucede si mortalidad sube de 5% a 20% en un día?
- ¿Se puede cambiar el lote de una producción después de registrada?

---

## O. PREGUNTAS PARA EL DUEÑO DEL SISTEMA

### Sobre Stack & Infraestructura

1. ¿Por qué dos directorios de migraciones (sql/ vs migrations/)? ¿Cuál es la "canonical" versión?
2. ¿Se planea migrar de Netlify Functions a Supabase Functions para todo?
3. ¿Es PWA (offline-first) un requisito actual o aspiracional?

### Sobre Mercado Pago

4. ¿Cuál es el estado actual de FASE 0? ¿Se completó la migración?
5. ¿Siguen siendo usadas las tablas `mercadopago_raw`, `mercadopago_movements`, `sync_metadata`?
6. ¿Hay un plan para eliminar el código legacy de MP?
7. ¿Qué nivel de exactitud esperas en la reconciliación (±$1, exacto)?

### Sobre Datos Financieros

8. ¿Es `pagos.monto` la fuente de verdad para dinero recibido, o `movimientos_caja`?
9. ¿Cuándo se considera un pedido "pagado"? ¿Es automático cuando se crea pago?
10. ¿Puede un cliente tener saldo negativo (anticipo)?
11. ¿Cómo se manejan devoluciones de dinero?
12. ¿Necesitas reporte de "cuentas por cobrar" o histórico de deudas?

### Sobre Producción Avícola

13. ¿El campo `alimento` es dato observado o cálculo (poblacion * consumo_diario)?
14. ¿Qué niveles de mortalidad/postura disparan alertas?
15. ¿Se necesita historial de trazabilidad (qué ave de qué lote produjo qué huevo)?
16. ¿Los galpones son siempre "Galpon 1, 2, 3..." o variable?

### Sobre Stock

17. ¿Hay diferenciación de ubicación dentro del galpón (bandejas, cajas)?
18. ¿Se necesita expiración/vencimiento para huevos producidos?
19. ¿Se pueden transferir huevos entre galpones?
20. ¿Cómo se registra merma/rotura post-venta?

### Sobre Usuarios & Permisos

21. ¿Repartidor debe poder ver finanzas o solo entregar?
22. ¿Hay super-admin vs admin de granja?
23. ¿Se necesita auditoría completa (quién cambió qué cuándo)?
24. ¿Es multi-granja en roadmap?

### Sobre Testing & Deployment

25. ¿Hay ambiente staging? ¿Cómo se prueban cambios antes de producción?
26. ¿Cuál es el process de backup de Supabase?
27. ¿Hay SLA o ventana de mantenimiento?

---

## P. ARCHIVOS CRÍTICOS QUE DEBEMOS CONSERVAR/REVISAR

### Si Hacemos Refactoring

**CRÍTICOS (No tocar sin plan):**
- `supabase/sql/001_schema.sql` — Core tables
- `supabase/sql/019_create_caja_tables.sql` — Financial schema
- `supabase/sql/031_enable_rls_financial_tables.sql` — Security policies
- `supabase/migrations/004_mp_new_architecture.sql` — New MP architecture
- `netlify/functions/sync-mercadopago-releases.ts` — Daily sync cron
- `netlify/functions/webhook-mercadopago.ts` — Real-time webhooks
- `src/api/pedidos.ts` — Monto total calculation logic
- `src/api/pagos.ts` — Payment creation with auto-movement
- `src/api/caja.ts` — Movement creation and summary

**IMPORTANT (Review before changes):**
- `supabase/migrations/010_fix_import_v2_classifications.sql` — Recent fixes
- `src/types/domain.ts` — Type definitions (single source of truth?)
- `src/features/produccion/ProductionApp.tsx` — 819 lines, needs breakup
- `src/utils/produccionCalculos.ts` — Business logic for metrics

**LEGACY (Audit usage before deleting):**
- `supabase/migrations/001_mercadopago_schema.sql` — Old MP tables
- `supabase/migrations/002_mercadopago_movements.sql` — Old MP tables
- `supabase/migrations/003_mercadopago_settlement.sql` — Old MP tables
- Any file with "mercadopago_raw" or "mercadopago_movements" references

### Configuration Files

- `vite.config.ts` — Build settings, PWA manifest
- `netlify.toml` — Deployment, redirect rules, environment
- `.env.local` — Production secrets (READ-ONLY)
- `package.json` — Dependencies (watch for outdated)

---

## Q. DIAGRAMA TEXTUAL GENERAL DEL SISTEMA ACTUAL

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          BROWSER / PWA CLIENT (React 19 + TypeScript)    │
│                                                                           │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐      │
│  │  PedidosApp      │  │  CajaApp         │  │  ProductionApp   │      │
│  │  (819 lines)     │  │  (Movimientos)   │  │  (Producciones)  │      │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐      │
│  │  CobrosApp       │  │  FinanzasApp     │  │  MercadoPagoApp  │      │
│  │  (Pagos)         │  │  (Reportes)      │  │  (Integration)   │      │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘      │
│           │                     │                     │                 │
│           ├─────────────────────┴─────────────────────┤                 │
│           ▼                                             ▼                 │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │  React Query + Custom Hooks (usePedidos, useCaja, etc.)      │      │
│  │  State Management: TanStack Query (server), Context (auth)   │      │
│  └──────────────────────────────────────────────────────────────┘      │
│           │                                                              │
│           ▼                                                              │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │  API Layer (src/api/*.ts)                                    │      │
│  │  - pedidos.ts, caja.ts, pagos.ts, mercadopago.ts, etc.      │      │
│  │  - Direct Supabase queries, return typed DTOs               │      │
│  └──────────────────────────────────────────────────────────────┘      │
└───────────────┬──────────────────────────────────────────────────────────┘
                │
                │ HTTP / PostgREST / Real-time WebSocket
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│               SUPABASE CLOUD (BaaS — PostgreSQL + Auth)                 │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │  AUTHENTICATION                                               │      │
│  │  - Email/Password (primary)                                  │      │
│  │  - Google OAuth (implemented, not default)                   │      │
│  │  - JWT tokens, RLS policies                                  │      │
│  └──────────────────────────────────────────────────────────────┘      │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │  CORE DATABASE SCHEMA (supabase/sql/ — 47 migrations)         │    │
│  │                                                                 │    │
│  │  PEDIDOS TIER:                                                 │    │
│  │    perfiles ← FK ← pedidos ← FK ← pedido_lineas              │    │
│  │    clientes ← FK ← pedidos                                    │    │
│  │    precios_actuales ← referenced by pedido_lineas            │    │
│  │    productos ← referenced by pedido_lineas                   │    │
│  │                                                                 │    │
│  │  FINANCIAL TIER:                                               │    │
│  │    pagos ← FK ← cliente_id                                    │    │
│  │    movimientos_caja ← can reference pagos (vinculado_id)     │    │
│  │    cheques ← FK ← movimientos_caja                            │    │
│  │    comisiones ← FK ← movimientos_caja                         │    │
│  │                                                                 │    │
│  │  PRODUCTION TIER:                                              │    │
│  │    lotes ← FK ← producciones                                  │    │
│  │    producciones ← referenced by recuentos_lote               │    │
│  │                                                                 │    │
│  │  CONFIGURATION TIER:                                           │    │
│  │    categorias_finanzas                                         │    │
│  │    login_attempts                                              │    │
│  │                                                                 │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │  MERCADO PAGO INTEGRATION (supabase/migrations/ — 10 files)   │    │
│  │                                                                 │    │
│  │  ARQUITECTURA NUEVA (FASE 0):                                 │    │
│  │    mp_source_record                                           │    │
│  │      (dedup: source_type + source_external_id + payload_hash)│    │
│  │      ↓                                                          │    │
│  │    import_financial_movements_reconciliation_v2() [RPC]       │    │
│  │      (classification, conflict resolution)                    │    │
│  │      ↓                                                          │    │
│  │    mp_financial_movement                                      │    │
│  │      (payment_in, payment_out, yield, transfer_*, unclassified)│   │
│  │      ↓                                                          │    │
│  │    ledger_entry                                               │    │
│  │      (balance_impact per movement)                            │    │
│  │      ↓                                                          │    │
│  │    account_balance (daily calculated)                         │    │
│  │                                                                 │    │
│  │  SUPPORT TABLES:                                               │    │
│  │    import_period_coverage, reconciliation_snapshot            │    │
│  │    period_flow_observation, monthly_reconciliation            │    │
│  │    mp_source_link_resolution, mp_import_exception             │    │
│  │    mp_financial_cycle                                          │    │
│  │                                                                 │    │
│  │  LEGACY TABLES (status unclear):                              │    │
│  │    mercadopago_raw, mercadopago_movements, mercadopago_settlement
│  │                                                                 │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │  RLS POLICIES                                                   │    │
│  │  - Financial tables (movimientos_caja, pagos, etc.): dueño only│   │
│  │  - All tables readable by authenticated users                 │    │
│  │  - is_dueño() custom function for permission check            │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                           │
└──────────┬─────────────────────────────────────────────────────────────┘
           │
           │ (Real-time PostgreSQL Changes subscription)
           │
           ├─ Service Role Key (admin operations)
           │
           ├─ Anon Key (browser client)
           │
           └─ WEBHOOKS (inbound — from MercadoPago)
                ▼
        ┌──────────────────────────────────────────┐
        │  Netlify Functions (Serverless)           │
        │  - sync-mercadopago-releases.ts (daily)  │
        │  - sync-mercadopago-movements.ts          │
        │  - sync-mercadopago-settlement.ts         │
        │  - webhook-mercadopago.ts (real-time)    │
        │  - check-rate-limit.ts                    │
        └──────────────────────────────────────────┘
                │
                ├─ Supabase Functions (Deno)
                │  - check-rate-limit
                │  - sync-mercadopago (RPC trigger)
                │
                ├─ Scheduled Cron (02:00 UTC daily)
                │  └─> MP Release Report creation
                │
                └─ Inbound Webhooks
                   └─> MercadoPago events
                       ├─ Payment received
                       ├─ Settlement
                       └─ Comisiones, rendimientos

┌─────────────────────────────────────────────────────────────────────────┐
│                    EXTERNAL APIs                                          │
│                                                                           │
│  ┌──────────────────────────────────┐  ┌──────────────────────────┐    │
│  │  MercadoPago API                  │  │  Google OAuth            │    │
│  │  /v1/account/release_report       │  │  (OpenID Connect)        │    │
│  │  /v1/account/settlement           │  │                          │    │
│  │  Webhooks (real-time)             │  │  (Federaterd login)      │    │
│  │                                   │  │  (Not default path)      │    │
│  │  Auth: Bearer + HMAC-SHA256       │  │  Auth: JWT               │    │
│  └──────────────────────────────────┘  └──────────────────────────┘    │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## RESUMEN FINAL

### Fortalezas Actuales

✅ Stack moderno (React 19, TypeScript, Vite)  
✅ Supabase proporciona BaaS integrado  
✅ RLS policies habilitadas para seguridad  
✅ Mercado Pago integración funcional (aunque en transición)  
✅ Modularidad básica (features por módulo)  
✅ Producción en vivo (santotomasapp.netlify.app)

### Debilidades Críticas

❌ Dos directorios de migraciones incompatibles  
❌ Múltiples fuentes de verdad para totales, saldos, stocks  
❌ Deuda técnica alta (150+ console.logs, cero tests de componentes)  
❌ Mercado Pago en migración incompleta (old + new architecture)  
❌ No hay error monitoring, auditoría de datos incompleta  
❌ Escalabilidad bloqueada (no multi-tenant ready)

### Recomendación para ETAPA 2

**NO rediseñes todavía.** Primero:

1. **Consolidar migrations** (7 días)
   - Elegir canonical migration system
   - Rename/merge conflicting files
   - Test en staging

2. **Completar FASE 0 MP** (14 días)
   - Validar arquitectura nueva
   - Deletear tablas legacy
   - Audit ledger consistency

3. **Documentar reglas de negocio** (7 días)
   - Qué es "deuda" de verdad
   - Cómo se calcula saldo
   - Quién tiene autoridad para cada dato

4. **Entonces:** Ya estarás listo para V4 arquitectura

---

**FIN DE AUDITORÍA — ETAPA 1 COMPLETADA**  
**Fecha:** 2026-09-23  
**Auditor:** Claude Haiku 4.5 (read-only analysis)  
**Próximo paso:** Esperá instrucciones para ETAPA 2
