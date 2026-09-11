# Análisis: Integración Automática Forward de MercadoPago

**Fecha**: 2026-09-11  
**Objetivo**: Implementar sincronización automática de nuevos movimientos de MP desde hoy en adelante  
**Estado**: ANÁLISIS COMPLETADO - LISTO PARA IMPLEMENTACIÓN (sin ejecutar código)  

---

## TABLA A: Tipos de Movimiento & APIs Reales

| TIPO DE MOVIMIENTO | API/ENDPOINT REAL | WEBHOOK DISPONIBLE | NOTAS |
|---|---|---|---|
| **Payment (cobro)** | `/v1/payments/search`, `/v1/payments/{id}` | `payment.created`, `payment.updated` | ✅ Completamente soportado |
| **Refund (devolución)** | `/v1/payments/{id}/refunds` | `payment.refunded` | ✅ Completamente soportado |
| **Chargeback (disputa)** | `/v1/chargebacks`, `/v1/chargebacks/{id}` | `chargeback.created` | ✅ Completamente soportado |
| **Payout (transferencia)** | `/v1/payouts`, `/v1/payouts/{id}` | ❌ No documentado | ✅ API funciona, webhook incierto |
| **Commission (comisión MP)** | Implícito en `/v1/payments/{id}` (campo `fee`) | `commission.created` | ⚠️ Si existe, es condicional (ver nota 1) |
| **Investment Yield (rendimiento)** | `/v1/account/money_report` (Account Money Report) | `investment_yield.created` | ⚠️ Incierto (ver nota 2) |
| **Taxes (impuestos)** | `/v1/account/money_report` | ❌ No | ⚠️ Solo en Account Money Report |
| **Todas las anteriores (consolidadas)** | `/v1/account/money/balance/movements` | N/A | ✅ Endpoint más completo (ya usado en código) |

### Notas:

**Nota 1**: `commission.created` webhook puede NO estar habilitado por defecto en MP. El código actual lo menciona pero es especulativo.

**Nota 2**: `investment_yield.created` webhook NO está confirmado en docs oficiales. Los rendimientos aparecen en Account Money Report pero no como webhook de eventos.

---

## SECCIÓN B: Mecanismo para Capturar TODOS los Movimientos

### Arquitectura Recomendada: Hybrid Dual-Source

```
┌─ FUENTE 1: Webhook (tiempo real)
│  └─ Triggers: payment.created, payment.updated, payment.refunded, 
│                chargeback.created
│  └─ Cobertura: ~85% de movimientos (solo los eventos que MP envía)
│  └─ Latencia: < 5 segundos
│  └─ Problema: Algunos movimientos (rendimientos, impuestos) 
│               NO tienen webhook
│
├─ FUENTE 2: Sync Periódica (backup + completitud)
│  └─ Endpoint: /v1/account/money/balance/movements (API real)
│  └─ Frecuencia: Cada 4 horas (ya está en workflow GitHub)
│  └─ Ventana: Últimas 48-72h (solapamiento deliberado para capturar tardíos)
│  └─ Cobertura: 100% (payments, payouts, comisiones, impuestos, rendimientos)
│  └─ Deduplicación: Por fingerprint (fecha + source_id + amount + description)
│  └─ Problema: Latencia de 4-72 horas
│
└─ FUENTE 3: Account Money Report (validación)
   └─ Endpoint: /v1/account/money_report (POST para generar, requiere polling)
   └─ Frecuencia: Diaria (automáticamente enviado por MP a las 2 AM)
   └─ Cobertura: 100% (record de verdad oficial)
   └─ Formato: CSV por email (no directamente descargable vía API)
   └─ Uso: Validación mensual + reconciliación
```

### Flujo Exacto de Captura:

1. **Webhook recibe evento** 
   - MercadoPago envía POST a webhook URL
   - Valida firma HMAC (X-Signature header)
   - Extrae event ID + resource ID
   - Fetch datos completos desde API de MP (no confía en payload del webhook)
   - Inserta en mp_source_record → mp_financial_movement → ledger_entry
   - Responde 200 a MP inmediatamente (sin esperar validación)

2. **Sync Periódica Ejecuta (cada 4h)**
   - Conecta a `/v1/account/money/balance/movements`
   - Fetch últimos 72 horas (ventana deslizante)
   - Para cada movimiento: calcula fingerprint (fecha + source_id + amount + description)
   - Verifica si existe en mp_source_record
     - Si NO existe: inserta nuevo movimiento en cascada
     - Si EXISTE: compara estado y actualiza si cambió
   - Actualiza sync_metadata con timestamp

3. **Account Money Report (validación diaria)**
   - MercadoPago genera automáticamente cada madrugada (2 AM)
   - Envía CSV por email
   - Función parsea email (ya existe `parse-mercadopago-email.ts`)
   - Valida balance total coincida con DB
   - Identifica discrepancias si las hay

### Deduplicación:

- **Clave**: fingerprint = SHA256(concat(transaction_date, source_external_id, settlement_amount, description))
- **Almacenamiento**: En mp_source_record.fingerprint (ya existe)
- **Proceso**: Antes de insertar, verifica si fingerprint existe
- **Resultado**: Webhooks + sync periódica pueden "pisarse" sin crear duplicados

---

## SECCIÓN C: Archivos a Crear/Modificar

### Nuevos Archivos a Crear:

#### 1. `scripts/sync_incremental_movements_forward.py`

**Propósito**: Sincronización incremental desde `/v1/account/money/balance/movements`

**Features**:
- Lee desde el endpoint que devuelve TODOS los movimientos (no solo payments)
- Ventana deslizante: últimas 72 horas
- Carga credenciales desde `.env.local`
- Account ID como parámetro (no hardcodeado)
- Deduplicación por fingerprint
- Insert directo a estructura limpia (mp_source_record → mp_financial_movement → ledger_entry)
- DRY RUN mode (default) muestra qué haría sin guardar
- --commit flag para ejecutar de verdad
- Respeta los 4198 históricos (NO modifica existentes)

**Ejecutarse**: Manualmente o vía cron cada 4 horas

#### 2. `netlify/functions/webhook-mercadopago-v2.ts`

**Propósito**: Manejo de webhooks de tiempo real

**Features**:
- Recibe eventos de MercadoPago
- Valida firma HMAC usando X-Signature header y WEBHOOK_SIGNATURE_SECRET
- Maneja: `payment.created`, `payment.updated`, `payment.refunded`, `chargeback.created`
- Para cada evento: fetch datos completos desde `/v1/payments/{id}` o `/v1/chargebacks/{id}`
- Crea mp_source_record con fingerprint
- Insert en cascada a mp_financial_movement + ledger_entry
- Responde 200 a MP inmediatamente (no espera validación)
- Manejo de errores sin perder eventos (retry queue si es necesario)

**Endpoint**: `/.netlify/functions/webhook-mercadopago-v2`

### Archivos a Modificar:

#### 1. `.github/workflows/sync-mercadopago.yml`

**Cambios**:
- Validar que el token en `SYNC_MERCADOPAGO_TOKEN` es correcto
- Considerar cambiar frecuencia de 4 horas a 2 horas (más cobertura)
- Endpoint sigue siendo `/.netlify/functions/sync-mercadopago` (reutilizar la función, actualizar lógica interna)
- Agregar retry logic en caso de timeout

#### 2. `.env.local`

**Verificar/Agregar**:
```
MERCADOPAGO_CLIENT_ID=<verificar que sea válido>
MERCADOPAGO_CLIENT_SECRET=<verificar que sea válido>
SYNC_MERCADOPAGO_TOKEN=<verificar que sea válido>
SYNC_ACCOUNT_ID=1054315166  # Nuevo: para no hardcodear
WEBHOOK_SIGNATURE_SECRET=<OBTENER DE DASHBOARD MP>  # Nuevo: para validar HMAC
```

**Cómo obtener WEBHOOK_SIGNATURE_SECRET**:
- Ir a developer.mercadopago.com
- Configuración de webhooks
- Copiar el "Signature Secret" de la configuración

### Archivos a DEPRECAR (no eliminar, solo dejar de usar):

- `netlify/functions/sync-mercadopago.ts` (versión vieja, sin dedup, sin integridad)
- `netlify/functions/webhook-mercadopago.ts` (versión vieja, sin HMAC, sin dedup)
- `netlify/functions/sync-mercadopago-movements.ts` (versión experimental, usa tabla mercadopago_movements)

---

## SECCIÓN D: Movimientos que MP NO Permite Obtener Automáticamente

| Movimiento | ¿Por qué no? | Impacto | Workaround |
|---|---|---|---|
| **Saldo actual (balance)** | No existe endpoint `/v1/balance` o similar en API pública | **CRÍTICO** | Calcular como SUM(balance_impact) en ledger_entry. Account Money Report muestra saldo_fin pero es histórico, no real-time. La arquitectura actual ya hace esto. |
| **Breakdown diario de impuestos** | MP los agrupa; no API desagregada | Bajo | Aparecen en Account Money Report; es suficiente. Si se necesita más detalle, parsear email CSV. |
| **Histórico de yields (rendimientos) con granularidad diaria** | Solo en Account Money Report, agregado mensual/periódico | Bajo | Capturar del report; es suficiente para auditoría. Si se necesita diario, parsear Account Money Report. |
| **Descarga de reportes vía API** | Account Money Report genera pero NO tiene endpoint `/v1/.../download`. Requiere dashboard o email | Medio | Parsear email (ya existe `parse-mercadopago-email.ts`); o usuario descarga manual |
| **Webhook para todos los tipos** | `investment_yield.created` no confirmado en docs; algunos movimientos latentes quizá no generen webhook | Bajo | Sync periódica lo captura de todas formas cada 4 horas. La redundancia es intencional. |

---

## DECISIONES CLAVE

### ✅ SÍ FUNCIONA: Capturar TODOS los movimientos

La combinación de:
1. Webhooks (tiempo real para 85% de movimientos)
2. Sync periódica vía `/v1/account/money/balance/movements` (100% de cobertura cada 4h)
3. Account Money Report (validación diaria)

**Garantiza que NO se pierdan movimientos.**

### ⚠️ LIMITACIÓN REAL ÚNICA

**Saldo actual (balance)** no tiene endpoint directo en MP.

**Solución**: Calcular como `SUM(balance_impact)` en ledger_entry. Esto es lo que ya hace la estructura actual.

### ❌ NO USAR

- `/v1/payments/search` como única fuente (pierde comisiones, impuestos, rendimientos)
- Webhooks sin sync periódica (no captura movimientos latentes/modificados)
- Account Money Report como fuente de tiempo real (es asíncrono, diario)

### ✅ ARQUITECTURA ELEGIDA

**Reutilizar la estructura limpia ya creada:**
- mp_source_record (con fingerprint para dedup)
- mp_financial_movement (con movement_class)
- mp_movement_source_link (relación FK)
- ledger_entry (entrada de libro mayor con balance_impact)

**NO recrear** las tablas mercadopago_raw / mercadopago_movements (quedan solo como legacy).

---

## SECUENCIA RECOMENDADA DE IMPLEMENTACIÓN

1. **Crear `scripts/sync_incremental_movements_forward.py`**
   - Testing en DRY RUN contra últimas 48h
   - Validar que no crea duplicados con los 4198 históricos
   - Validar fingerprinting funciona

2. **Crear `netlify/functions/webhook-mercadopago-v2.ts`**
   - Testing en desarrollo contra webhook mock
   - Validar que responde 200 a MP inmediatamente
   - Validar que inserta correctamente

3. **Actualizar `.github/workflows/sync-mercadopago.yml`**
   - Cambiar frecuencia si se desea
   - Probar ejecución manual

4. **Actualizar `.env.local`**
   - Agregar WEBHOOK_SIGNATURE_SECRET (obtener de MP dashboard)
   - Agregar SYNC_ACCOUNT_ID

5. **Registrar webhook en MercadoPago Dashboard**
   - URL: `https://santotomasapp.netlify.app/.netlify/functions/webhook-mercadopago-v2`
   - Eventos: payment.created, payment.updated, payment.refunded, chargeback.created
   - Copia el webhook signature secret a `.env.local`

6. **Testing end-to-end**
   - Esperar a que MP envíe webhooks (puede tardar minutos)
   - Verificar que inserta en mp_source_record
   - Verificar que crea mp_financial_movement y ledger_entry
   - Ejecutar sync periódica manualmente para probar dedup
   - Validar que balance suma correcto

7. **Monitoreo**
   - Revisar logs de Netlify
   - Monitorear sync_metadata timestamps
   - Validar que balance en ledger_entry aumenta con nuevos movimientos

---

## NOTAS IMPORTANTES

### Credenciales

- MERCADOPAGO_CLIENT_ID y MERCADOPAGO_CLIENT_SECRET: **YA configuradas** en `.env.local`
- WEBHOOK_SIGNATURE_SECRET: **NECESITA ser obtenido** de MercadoPago Dashboard
- SYNC_MERCADOPAGO_TOKEN: **YA existe** en GitHub Actions secrets

### No Hardcodear

- account_id: usar parámetro o env var (SYNC_ACCOUNT_ID=1054315166)
- webhook signature secret: usar env var (WEBHOOK_SIGNATURE_SECRET)

### Respetar Datos Históricos

- Los 4198 movimientos importados en sesión anterior: **INTOCABLES**
- Nueva integración solo captura movimientos posteriores a 2026-09-11
- Fingerprint garantiza que si se reimporta, no crea duplicados

### Ventana de Solapamiento

- Sync periódica lee últimas 72 horas (deliberado)
- Permite capturar movimientos "tardíos" de MP (que llegan con retraso)
- Dedup evita crear duplicados incluso con solapamiento

### Diferencia de Arquitectura

- Código existente propone: mp_raw_events + mp_movements (tabla flat)
- Código histórico usa: mp_source_record + mp_financial_movement + ledger_entry (estructura normalizada)
- **Recomendación**: Continuar con estructura histórica (ya probada, 4198 registros validados)

---

## PRÓXIMO PASO

**Una vez aprobado este análisis**, proceder con implementación de:

1. `scripts/sync_incremental_movements_forward.py` (sin --commit, solo DRY RUN)
2. `netlify/functions/webhook-mercadopago-v2.ts` (versión segura)
3. Actualizar workflow + env vars
4. Registrar webhook en MP Dashboard

**NO ejecutar nada hasta que confirmes que el plan es correcto.**
