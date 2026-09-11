# Arquitectura del Importador MP Reports

## 📐 Flujo de datos

```
CSV en data/mercadopago/
        ↓
  Lectura y validación de estructura
        ↓
  Para cada fila:
    • Construir mp_source_record (RAW)
    • Clasificar movement_class
    • Construir mp_financial_movement
    • Construir ledger_entry
        ↓
  Agrupar en lotes (batch)
        ↓
  Insertar en Supabase con ON CONFLICT DO NOTHING
        ↓
  (El trigger automático en BD crea account_balance)
        ↓
  Mostrar resumen
```

---

## 🔑 Deduplicación automática

### Clave única: `(source_type, source_external_id, payload_hash)`

Cada archivo CSV se procesa como `source_type='report'`.

Para cada movimiento en el CSV:
- **source_external_id** = Valor de columna `SOURCE_ID`
- **payload_hash** = SHA256 del contenido completo del movimiento

**Escenario: Dos CSVs con períodos superpuestos**

```
CSV1: Agosto 01-15 (500 mov)
  SOURCE_ID=123 → payload_hash=abc123
  SOURCE_ID=124 → payload_hash=abc124
  ...

CSV2: Agosto 10-31 (400 mov)
  SOURCE_ID=123 → payload_hash=abc123  (DUPLICADO)
  SOURCE_ID=124 → payload_hash=abc124  (DUPLICADO)
  SOURCE_ID=500 → payload_hash=xyz500  (NUEVO)
  ...
```

**Al ejecutar:**
1. Primera importación CSV1: Inserta 500 registros ✓
2. Primera importación CSV2: 
   - Intenta insertar 400
   - Detecta 200 duplicados (SOURCE_ID 123-322)
   - Inserta solo 200 nuevos
   - Los 200 duplicados se ignoran silenciosamente (ON CONFLICT DO NOTHING)

**Resultado:** 700 registros totales (no 900)

---

## 🔗 Identificación de movimientos entre CSVs

### Problem: ¿Cómo sé si un movimiento en CSV1 es el mismo que en CSV2?

**Respuesta: SOURCE_ID + payload_hash**

El SOURCE_ID es asignado por Mercado Pago de forma única para cada transacción. Si aparece en 2 CSVs:
- Si `payload_hash` es IGUAL → Mismo movimiento, misma observación
- Si `payload_hash` es DIFERENTE → Mismo movimiento, contenido cambió

**Ejemplo:**

```sql
-- Archivo 1 (2026-01-15)
INSERT INTO mp_source_record (source_external_id, payload_hash, raw_data)
VALUES ('MP-001234', 'hash_aaa...', {...})

-- Archivo 2 (2026-02-15, misma transacción pero Mercado Pago actualizó fee)
INSERT INTO mp_source_record (source_external_id, payload_hash, raw_data)
VALUES ('MP-001234', 'hash_bbb...', {...})  -- DISTINTO HASH
-- ↑ Esto se inserta como nueva versión (diferente hash)
-- La relación (mp_financial_movement) sigue siendo la misma

-- Archivo 3 (2026-03-15, duplicado accidental)
INSERT INTO mp_source_record (source_external_id, payload_hash, raw_data)
VALUES ('MP-001234', 'hash_aaa...', {...})  -- MISMO HASH QUE ARCHIVO 1
-- ↑ Esto se ignora (ON CONFLICT DO NOTHING)
```

---

## 🚨 Manejo de interrupciones

### Escenario: Script se corta a la mitad

```
[2026-09-04 14:30:15] Insertando 234 source records... (archivo 1 de 3)
[2026-09-04 14:30:20] ✓ Archivo 1 completado
[2026-09-04 14:30:25] Insertando 456 source records... (archivo 2 de 3)
[2026-09-04 14:30:30] ERROR: Connection lost
← Script se detiene
```

### Qué pasó en la BD:
- Archivo 1: 234 registros ✓ insertados
- Archivo 2: Algunos lotes insertados, otros NO

### Qué hacer:
```bash
python scripts/import_mp_reports.py
```

El script:
1. Descubre los 3 CSVs
2. Intenta insertar archivo 1 → Ya existen → Se ignoran (ON CONFLICT)
3. Intenta insertar archivo 2 → Algunos existen, otros NO → Inserta los nuevos
4. Intenta insertar archivo 3 → No existen → Inserta todos

**Resultado: Cero duplicados, importación continúa donde quedó**

---

## 🎯 Estructura de registros

### `mp_source_record` (RAW)

```json
{
  "source_type": "report",
  "source_external_id": "MP-001234",  // SOURCE_ID del CSV
  "payload_hash": "sha256...",
  "raw_data": {
    "SOURCE_ID": "MP-001234",
    "TRANSACTION_DATE": "2026-01-15T10:30:00-03:00",
    "TRANSACTION_AMOUNT": "1000.00",
    "SETTLEMENT_NET_AMOUNT": "993.20",
    "TAXES_AMOUNT": "-6.80",
    "PAYMENT_METHOD_TYPE": "available_money",
    ...
  },
  "observed_at": "2026-01-15T10:30:00-03:00",
  "received_at": "2026-09-04T14:30:00Z",
  "processing_status": "processed"
}
```

### `mp_financial_movement`

```json
{
  "account_id": 1054315166,
  "movement_class": "payment_in",
  "transaction_amount": 1000.00,
  "settlement_amount": 993.20,     // ← Balance impact real
  "tax_amount": -6.80,
  "tax_detail": {"type": "withholding", ...},
  "payment_method": "available_money",
  ...
  "transaction_date": "2026-01-15T10:30:00-03:00"
}
```

### `ledger_entry`

```json
{
  "account_id": 1054315166,
  "financial_movement_id": 1,     // 1:1 relationship
  "balance_impact": 993.20,         // settlement_amount
  "category": "income",
  "source_reference": "SOURCE_ID=MP-001234 (report)",
  "description": "PAYMENT_IN: Cliente XYZ",
  "occurred_at": "2026-01-15T10:30:00-03:00"
}
```

---

## 🔄 Clasificación de movimientos

### Orden de reglas (se evalúan en orden):

1. **yield** (rendimiento)
   - NO payment_method
   - NO payer
   - NO taxes
   - Amount > 0

2. **transfer_out** (transferencia enviada)
   - Amount < 0
   - Payer = "GRANJA SANTO TOMAS S.A.S."

3. **transfer_in** (transferencia recibida)
   - payment_method = bank_transfer
   - Amount > 0

4. **payment_in** (cobro)
   - payment_method = available_money
   - Amount > 0

5. **payment_out** (pago)
   - payment_method = available_money
   - Amount < 0

6. **digital_currency_payment_in** (créditos de consumidor)
   - payment_method = digital_currency
   - sub_method = consumer_credits
   - Amount > 0

7. **credit_card_payment_in** (tarjeta)
   - payment_method = credit_card
   - Amount > 0

8. **unclassified** (desconocido)
   - Ninguna regla coincide

---

## 📦 Inserts por lotes

### ¿Por qué lotes?

Supongamos 10,000 movimientos:
- **Sin lotes**: 10,000 requests HTTP a Supabase → ✗ Lento (minutos)
- **Con lotes de 100**: 100 requests → ✓ Rápido (~30 segundos)

### Parámetros

```python
batch_insert_records(
    table='mp_source_record',
    records=[...],
    batch_size=100  # 100 registros por request
)
```

### Tamaño de batch

- 100 = Buen balance entre velocidad y seguridad
- Más grande (500+) = Riesgo de timeout
- Más pequeño (10) = Más requests (lento)

---

## 🔐 Transacciones

### ¿Es completamente transaccional?

**Parcialmente:**

1. Cada **lote de 100** se envía como request único (transacción)
   - Si falla un lote: Ese lote entero se revierte
   - Otros lotes se completan

2. **Entre tablas** (source_record → financial_movement → ledger_entry)
   - Usan Foreign Keys + Cascadas
   - Los triggers automáticos mantienen consistencia
   - Si falla una inserción, el resto se mantiene

**Mejora posible (ETAPA posterior):**
- Usar una transacción SQL única para TODOS los lotes
- Esto ralentizaría pero garantizaría atomicidad

---

## 🌍 Validación de columnas

### Requeridas (mínimas):

```python
REQUIRED_COLUMNS = {
    'SOURCE_ID',
    'TRANSACTION_DATE',
    'TRANSACTION_AMOUNT',
    'SETTLEMENT_NET_AMOUNT',
    'TAXES_AMOUNT'
}
```

### Si falta una:

```
ERROR: Columnas faltantes: SETTLEMENT_NET_AMOUNT
CSV inválido Reporte_2026-01.csv
```

### Nuevas columnas:

Si Mercado Pago agrega nuevas columnas, el script:
1. Las incluye en `raw_data` (JSONB)
2. No falla
3. Continúa procesando

Esto permite **evolucionar con Mercado Pago** sin actualizar el script.

---

## 📊 Cálculos

### Rendimientos (`yields_total`)

```python
if movement_class == 'yield':
    stats.yields_total += Decimal(row['SETTLEMENT_NET_AMOUNT'])
```

### Impuestos (`taxes_total`)

```python
stats.taxes_total += Decimal(row['TAXES_AMOUNT'])  # Negativo en CSV
# Ej: TAXES_AMOUNT = -6.80
```

### Balance Impact (`balance_impact_total`)

```python
stats.balance_impact_total += Decimal(row['SETTLEMENT_NET_AMOUNT'])
# Suma algebraica de todos los settlement_amount
# Debe coincidir con:
#   opening_balance + SUM(balance_impact desde opening_date)
```

---

## 🔌 Dependencias

```
supabase         (cliente oficial Supabase)
requests         (HTTP requests)
python-dotenv    (lectura .env.local) — opcional
csv              (built-in)
json             (built-in)
hashlib          (built-in)
pathlib          (built-in)
```

Si `supabase` no está instalado, usa `requests` directamente con API REST.

---

## 🚀 Performance esperado

| Volumen | Tiempo | Notas |
|---------|--------|-------|
| 500 registros | ~5 seg | 1 CSV pequeño |
| 2,000 registros | ~20 seg | 4-5 CSVs medianos |
| 10,000 registros | ~100 seg | Importación histórica completa |

*Tiempos incluyen: lectura CSV + validación + clasificación + inserts en lotes*

---

## 🐛 Debugging

### Habilitar logs detallados:

En `.env.local`:
```
LOG_LEVEL=DEBUG
```

Mostrará:
- Cada batch que se inserta
- Tiempos de ejecución
- Errores específicos

### Revisar BD directamente:

```sql
-- Contar source records por fecha
SELECT 
  DATE(observed_at) as date,
  COUNT(*) as count
FROM mp_source_record
GROUP BY DATE(observed_at)
ORDER BY date DESC;

-- Verificar deduplicación
SELECT 
  source_external_id,
  COUNT(DISTINCT payload_hash) as versions
FROM mp_source_record
GROUP BY source_external_id
HAVING COUNT(DISTINCT payload_hash) > 1;
```

---

## 📝 Resumen

| Aspecto | Implementación |
|---------|-----------------|
| **Deduplicación** | UNIQUE(source_type, source_external_id, payload_hash) |
| **Período superpuesto** | Automáticamente detectado por SOURCE_ID |
| **Interrupciones** | ON CONFLICT DO NOTHING (idempotente) |
| **RAW versionado** | payload_hash diferencia versiones |
| **Batch inserts** | 100 registros por request |
| **Transacciones** | Por lote (no global) |
| **Validación** | Columnas mínimas + flexibilidad |
| **Seguridad** | SERVICE_ROLE_KEY en .env.local (no en git) |
| **Performance** | ~100 ms por 10 registros |
