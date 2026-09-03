# MercadoPago Sync - Guía de Configuración

## Cambios Realizados

### 1. Función de Sync Mejorada (`netlify/functions/sync-mercadopago.ts`)

**Cambios principales:**
- ✅ Elimina el límite de 10,000 registros (ahora soporta hasta 50,000 máximo)
- ✅ Implementa **mapeo de campos** limpio desde JSON bruto de MercadoPago
- ✅ Guarda datos **normalizados** en columnas específicas
- ✅ Mantiene **raw_data** como respaldo en JSONB
- ✅ Rastrea **último sync** en tabla `sync_metadata`
- ✅ Implementa retry logic para resiliencia

### 2. Campos Mapeados

Desde el JSON de MercadoPago, ahora se mapean:

```
transaction_amount       -> Monto de la transacción
currency_id             -> Moneda (ARS, etc)
status                  -> Estado (approved, rejected, etc)
status_detail           -> Detalle del estado (accredited, etc)
date_created            -> Fecha de creación
date_approved           -> Fecha de aprobación
money_release_date      -> Fecha de liberación de dinero

payer_id                -> ID del pagador
payer_email             -> Email del pagador
payer_identification    -> CUIT/DNI del pagador
collector_id            -> ID del cobrador
issuer_id               -> ID del emisor (banco/wallet)

payment_method          -> Tipo de pago (account_money, master, etc)
payment_type_id         -> Tipo de pago ID
authorization_code      -> Código de autorización
statement_descriptor    -> Descripción en estado de cuenta

operation_type          -> Tipo de operación (money_transfer, etc)
description             -> Descripción del pago
installments            -> Cuotas
captured                -> Capturado (true/false)

net_received_amount     -> Monto neto recibido
total_paid_amount       -> Monto total pagado

raw_data                -> JSON completo (respaldo)
```

### 3. Nuevas Tablas en Supabase

#### `mercadopago_raw`
Tabla principal de sincronización con campos mapeados:
- `id` (TEXT, PRIMARY KEY)
- `transaction_amount` (DECIMAL)
- `currency_id` (VARCHAR)
- `status` (VARCHAR)
- `date_created` (TIMESTAMP)
- `payer_id`, `payer_email`, `payer_identification`
- `payment_method`, `payment_type_id`
- `raw_data` (JSONB)
- `processed` (BOOLEAN) - Marca si fue procesado
- `created_at`, `updated_at`

**Índices creados:**
- `idx_mercadopago_payer_id` - Para consultas por pagador
- `idx_mercadopago_date_created` - Para ordenar por fecha
- `idx_mercadopago_status` - Para filtrar por estado
- `idx_mercadopago_processed` - Para ver qué falta procesar

#### `sync_metadata`
Tabla para rastrear sincronizaciones:
- `sync_type` (VARCHAR, PRIMARY KEY) = 'mercadopago'
- `last_sync_date` (TIMESTAMP) - Última sincronización
- `last_sync_count` (INTEGER) - Cuántos se guardaron

### 4. Proceso de Sincronización

**Primera ejecución (Histórico completo):**
1. GitHub Actions dispara a las `0, 4, 8, 12, 16, 20 UTC` (cada 4 horas)
2. Obtiene token de MercadoPago
3. Trae TODOS los pagos usando paginación (hasta 50k)
4. Mapea y normaliza los campos
5. Guarda en `mercadopago_raw` (solo si no existe ese ID)
6. Actualiza `sync_metadata` con fecha/cantidad

**Ejecutar manualmente:**
```bash
# Desde GitHub Actions UI, en "Sync MercadoPago to Caja"
# Click en "Run workflow"
```

O con curl:
```bash
curl -X POST \
  -H "Authorization: Bearer $SYNC_MERCADOPAGO_TOKEN" \
  -H "Content-Type: application/json" \
  "https://tu-site.netlify.app/.netlify/functions/sync-mercadopago" \
  -d '{}'
```

### 5. Setup en Supabase

#### Paso 1: Ejecutar la migración SQL
```sql
-- Copiar contenido de: supabase/migrations/001_mercadopago_schema.sql
-- Ejecutar en SQL Editor de Supabase
```

#### Paso 2: Verificar tablas
```sql
-- Ver estructura
\d mercadopago_raw
\d sync_metadata

-- Ver estadísticas
SELECT COUNT(*) FROM mercadopago_raw;
SELECT * FROM sync_metadata;
```

#### Paso 3: Ejecutar primer sync
Desde GitHub Actions > "Sync MercadoPago to Caja" > "Run workflow"

#### Paso 4: Verificar sincronización
```sql
-- Ver últimos pagos
SELECT 
  id, 
  transaction_amount, 
  payer_email, 
  status, 
  date_created
FROM mercadopago_raw
ORDER BY date_created DESC
LIMIT 10;

-- Ver estadísticas de sync
SELECT * FROM sync_metadata WHERE sync_type = 'mercadopago';
```

### 6. Seguridad

**Tokens necesarios:**

En Netlify (Environment Variables):
```
SYNC_MERCADOPAGO_TOKEN      # Token para autorizar el webhook
MERCADOPAGO_CLIENT_ID       # Credenciales MercadoPago
MERCADOPAGO_CLIENT_SECRET   
SUPABASE_URL                # Supabase
SUPABASE_SERVICE_ROLE_KEY   # Clave de administrador (no de anon)
```

**Validación:**
- Se valida token Bearer en cada request
- Se usa `SUPABASE_SERVICE_ROLE_KEY` (permisos totales) solo en Netlify Function
- Desde el frontend se usa `SUPABASE_ANON_KEY` (permisos limitados)

### 7. Solución de Problemas

**Problema: "510 records pero esperaba menos"**
- Es normal. La función trae TODO el histórico de MercadoPago
- Primera ejecución descarga todos, luego solo nuevos
- Si quieres limpiar: `DELETE FROM mercadopago_raw;` y resincronizar

**Problema: Sincronización se detiene en X registros**
- Check logs en Netlify Functions
- Verifíca que MercadoPago token sea válido
- Revisa límites de rate limiting de MercadoPago

**Problema: Campos vacíos**
- Los campos opcionales de MercadoPago aparecen como NULL
- Revisa `raw_data` JSONB para ver estructura completa

### 8. Próximos Pasos

Después que todo el histórico esté sincronizado:

1. **Procesar registros** - Crear tabla `movimientos` o similar
2. **Validar campos** - Mapeo 1:1 a estructura de negocio
3. **Cambiar a sync incremental** - Solo nuevos (puede ser automatizado)
4. **Dashboard** - Consultas SQL para reportes

### 9. Queries Útiles

```sql
-- Ingresos totales por mes
SELECT 
  DATE_TRUNC('month', date_created)::DATE AS mes,
  SUM(transaction_amount) AS total,
  COUNT(*) AS cantidad
FROM mercadopago_raw
WHERE status = 'approved'
GROUP BY DATE_TRUNC('month', date_created)
ORDER BY mes DESC;

-- Por método de pago
SELECT 
  payment_method,
  COUNT(*) AS cantidad,
  SUM(transaction_amount) AS total
FROM mercadopago_raw
WHERE status = 'approved'
GROUP BY payment_method;

-- Por pagador
SELECT 
  payer_email,
  COUNT(*) AS cantidad,
  SUM(transaction_amount) AS total
FROM mercadopago_raw
WHERE status = 'approved'
GROUP BY payer_email
ORDER BY total DESC;

-- Registros sin procesar
SELECT COUNT(*) FROM mercadopago_raw WHERE processed = false;
```
