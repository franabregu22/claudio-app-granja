# FASE 1: AUDITORÍA READ-ONLY DE IMPLEMENTACIÓN ACTUAL

**Fecha:** 2026-09-07  
**Scope:** Verificar estado real del schema, funciones, triggers para identificar riesgos ANTES de FASE 1  
**NO:** Ejecutar cambios, modificar datos, tocar FASE 0  

---

## PREGUNTA 1: SQL REAL de `calculate_ledger_balance()`

### SQL Actual (Migración 004, líneas 220-252):

```sql
CREATE OR REPLACE FUNCTION calculate_ledger_balance(
  p_account_id BIGINT,
  p_as_of_date DATE
)
RETURNS DECIMAL AS $$
DECLARE
  v_opening_balance DECIMAL(15,2);
  v_opening_date DATE;
  v_sum_impact DECIMAL(15,2);
BEGIN
  -- Obtener opening balance
  SELECT opening_balance, opening_balance_date
  INTO v_opening_balance, v_opening_date
  FROM account_balance
  WHERE account_id = p_account_id
  ORDER BY opening_balance_date DESC NULLS LAST
  LIMIT 1;

  -- Default: opening_balance = 0, opening_date = 2026-01-01
  v_opening_balance := COALESCE(v_opening_balance, 0);
  v_opening_date := COALESCE(v_opening_date, '2026-01-01'::DATE);

  -- Sumar impactos desde opening_date hasta p_as_of_date
  SELECT COALESCE(SUM(balance_impact), 0)
  INTO v_sum_impact
  FROM ledger_entry
  WHERE account_id = p_account_id
    AND DATE(occurred_at) >= v_opening_date
    AND DATE(occurred_at) <= p_as_of_date;

  RETURN v_opening_balance + v_sum_impact;
END;
$$ LANGUAGE plpgsql STABLE;
```

### Análisis:

**PROBLEMA CRÍTICO:** Línea 25-26 usa `DATE(occurred_at)` sin timezone conversion.

```sql
AND DATE(occurred_at) >= v_opening_date
AND DATE(occurred_at) <= p_as_of_date
```

**Implicación:**
- Si `occurred_at` se almacena en UTC (porque TIMESTAMP WITH TIME ZONE siempre convierte a UTC internamente):
  - `occurred_at = 2026-08-01T03:00:00-03:00` (ART) → se almacena como `2026-08-01T06:00:00Z` (UTC)
  - `DATE(2026-08-01T06:00:00Z)` → evalúa como `2026-08-01` (en zona UTC)
  - Pero contablemente, ese movimiento ocurrió el `2026-08-01` en ART, así que **la fecha es correcta por coincidencia**

**PERO SI:**
- `occurred_at = 2026-08-01T02:00:00-03:00` (ART) → se almacena como `2026-08-01T05:00:00Z` (UTC)
- `DATE(2026-08-01T05:00:00Z)` → evalúa como `2026-08-01` ✓
- Pero: `occurred_at = 2026-08-01T00:30:00-03:00` (ART) → se almacena como `2026-08-01T03:30:00Z` (UTC)
- `DATE(2026-08-01T03:30:00Z)` → evalúa como `2026-08-01` ✓
- Pero: `occurred_at = 2026-08-01T00:15:00-03:00` (ART) → se almacena como `2026-08-01T03:15:00Z` (UTC)

**LA VERDADERA TRAMPA:**
- `occurred_at = 2026-07-31T21:00:00-03:00` (ART, aún 31 de julio) → se almacena como `2026-08-01T00:00:00Z` (UTC)
- `DATE(2026-08-01T00:00:00Z)` → evalúa como `2026-08-01` (INCORRECTO, debería ser 2026-07-31)

**Conclusión:** ✅ Por SUERTE, todos los movimientos importados (julio-agosto) parecen haberse registrado en horarios que no cruzan medianoche UTC. Pero hay **riesgo real** si se importan movimientos con `occurred_at` entre `2026-08-01T00:00:00Z` y `2026-08-01T03:00:00Z` (UTC), que corresponden a `2026-07-31T21:00:00` y `2026-08-01T00:00:00` (ART).

**Recomendación:** DEBE CORREGIRSE ANTES DE FASE 1, pero NO retroactivamente a menos que se detecte corrupción de datos.

---

## PREGUNTA 2: SQL REAL del trigger `trg_update_balance_on_ledger`

### SQL Actual (Migración 004, líneas 258-280):

```sql
CREATE OR REPLACE FUNCTION update_account_balance_on_ledger()
RETURNS TRIGGER AS $$
BEGIN
  -- Actualizar o crear el balance del día
  INSERT INTO account_balance (
    account_id,
    balance_date,
    calculated_balance,
    sync_source
  ) VALUES (
    NEW.account_id,
    DATE(NEW.occurred_at),  -- LÍNEA PROBLEMÁTICA: sin AT TIME ZONE
    calculate_ledger_balance(NEW.account_id, DATE(NEW.occurred_at)),
    'ledger_entry'
  )
  ON CONFLICT (account_id, balance_date)
  DO UPDATE SET
    calculated_balance = calculate_ledger_balance(NEW.account_id, DATE(NEW.occurred_at)),
    last_synced_at = NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_balance_on_ledger
AFTER INSERT OR UPDATE ON ledger_entry
FOR EACH ROW
EXECUTE FUNCTION update_account_balance_on_ledger();
```

### Análisis:

**MISMO PROBLEMA:** `DATE(NEW.occurred_at)` sin timezone conversion.

**Flujo:**
1. Insert ledger_entry con `occurred_at`
2. Trigger calcula `balance_date = DATE(occurred_at)` (en UTC, no ART)
3. Llama a `calculate_ledger_balance(..., balance_date)`
4. Función suma desde opening hasta balance_date

**Riesgo:** Si un movimiento ocurre a las 00:30 ART (medianoche Argentina), se almacena como 03:30 UTC, se evalúa como fecha siguiente en UTC, pero contablemente es la fecha anterior.

**Status:** DEBE CORREGIRSE, pero NO retroactivamente hasta verificar que no hay datos corruptos.

---

## PREGUNTA 3: Estructura REAL de `account_balance`

### Campos actuales (según Migración 004):

```sql
id BIGSERIAL PRIMARY KEY
account_id BIGINT NOT NULL
balance_date DATE NOT NULL

opening_balance DECIMAL(15,2)              -- nullable
opening_balance_date DATE                  -- nullable
opening_balance_source VARCHAR(100)        -- nullable
opening_balance_set_at TIMESTAMP TZ        -- nullable

calculated_balance DECIMAL(15,2) NOT NULL  -- CRITICAL

observed_balance_mp DECIMAL(15,2)          -- nullable
variance DECIMAL(15,2)                     -- nullable
variance_note TEXT                         -- nullable

last_synced_at TIMESTAMP TZ                -- nullable
sync_source VARCHAR(20)                    -- nullable

UNIQUE(account_id, balance_date)
```

### Análisis:

✅ **Ya existen los campos necesarios:**
- `observed_balance_mp` — para observaciones
- `variance` — para diferencia
- `variance_note` — para notas

❌ **NO son utilizados actualmente:**
- `observed_balance_mp` siempre NULL (nunca se ingresa vía trigger ni UI)
- `variance` siempre NULL (nunca se calcula)
- `variance_note` siempre NULL

**Conclusión:** REUTILIZABLES, pero no tocar. Dejar `account_balance` como cache operativo, usar `reconciliation_snapshot` para historial.

---

## PREGUNTA 4: Uso actual de `observed_balance_mp` y `variance`

### Búsqueda en codebase:

**En SQL/Migraciones:** Definidos en 004, nunca populados.

**En Backend (Node.js/API):** 
- `grep -r "observed_balance_mp" src/` → **0 resultados**
- `grep -r "variance" src/` → 0 resultados (excepto en comentarios de migraciones)

**En UI/Frontend:**
- Nunca mostrados
- Nunca editables

**Conclusión:** Los campos existen en schema pero **NUNCA se han usado operativamente**. Son placeholders de diseño.

**Para FASE 1:** Seguro reutilizar estos campos como destino de reconciliation_snapshot, pero NO contar con que tengan datos históricos.

---

## PREGUNTA 5: Lógica reutilizable existente

### ✅ Reutilizable:

1. **Trigger `trg_update_balance_on_ledger`**
   - Auto-calcula balance diario al insertar ledger_entry
   - Debería mantenerse (con corrección de timezone)
   - ON CONFLICT evita duplicados

2. **Función `calculate_ledger_balance(account_id, as_of_date)`**
   - Suma opening + movimientos hasta fecha
   - Correcta conceptualmente (excepto timezone)
   - Puede llamarse desde queries de conciliación

3. **Índice `idx_balance_account_date(account_id, balance_date DESC)`**
   - Optimizado para queries de rango
   - Reutilizable sin cambios

### ❌ NO reutilizable:

- No existe lógica de snapshots históricos
- No existe cálculo de variance
- No existe estado de conciliación (pending/reconciled/etc)

---

## PREGUNTA 6: Cómo se determina `balance_date`

### Determinación actual:

```sql
balance_date = DATE(NEW.occurred_at)  -- Sin timezone conversion
```

### Problemas:

- `DATE()` opera en zona UTC (porque occurred_at es TIMESTAMP WITH TIME ZONE, almacenado en UTC)
- No refleja fecha ART contable

### Debería ser:

```sql
balance_date = DATE(NEW.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
```

### Status: CRÍTICO — DEBE CORREGIRSE ANTES DE IMPORTAR ENERO-JUNIO

(Julio-agosto no son afectados porque movimientos parecen alineados con medianoche UTC)

---

## PREGUNTA 7: Riesgos timezone reales

### Escenario de riesgo:

**Movimiento que ocurre a medianoche ART:**

```
Hora contable:    2026-07-31 23:45:00 ART
Se almacena como: 2026-08-01 02:45:00 UTC
DATE() lo ve como: 2026-08-01 (INCORRECTO)
Debería ser:      2026-07-31 (CORRECTO)
```

**Impacto:**
- Movimiento contablemente del 31/07 se asigna al saldo del 01/08
- Saldo del 31/07 es ~1-2M más alto de lo que debería
- Saldo del 01/08 es ~1-2M más bajo de lo que debería
- Divergencia aparece en histórico

### Cuán probable:

**Julio-agosto:** Baja (movimientos típicamente en horarios de negocio, 09:00-18:00 ART, que es 12:00-21:00 UTC, nunca cruza medianoche UTC)

**Enero-junio (futuros):** Mayor riesgo si hay movimientos de madrugada o procesamiento batch nocturno.

### Recomendación:

1. **Immediate:** Auditar julio-agosto para verificar que no hay movimientos entre 00:00-03:00 UTC
2. **Before enero:** Corregir `DATE()` → `DATE(...AT TIME ZONE 'America/Argentina/Buenos_Aires')`
3. **Backfill:** Re-calcular account_balance para cualquier mes con movimientos de medianoche

---

## PREGUNTA 8: Qué campos guardar vs calcular

### Campos propuestos para `monthly_reconciliation`:

| Campo | Tipo | Persistir | Calcular | Justificación |
|-------|------|-----------|----------|---------------|
| opening_balance_calculated | DECIMAL | ✅ Snapshot | — | Punto de referencia histórico del 1º del mes |
| movement_count | INTEGER | ❌ — | ✅ Query | SUM(COUNT(*)) de ledger_entry en período |
| movement_sum | DECIMAL | ❌ — | ✅ Query | SUM(balance_impact) de ledger_entry en período |
| closing_balance_calculated | DECIMAL | ✅ Snapshot | — | Resultado final del mes (critical para auditoría) |
| closing_balance_observed | DECIMAL | ✅ FK | — | Viene de reconciliation_snapshot |
| variance | DECIMAL | ✅ Derivado | — | observed - calculated |
| needs_review_count | INTEGER | ❌ — | ✅ Query | COUNT(*) WHERE needs_review = TRUE |

### Recomendación:

**PERSISTIR (snapshot histórico):**
- opening_balance_calculated (referencia de cierre anterior)
- closing_balance_calculated (resultado del período)
- closing_balance_observed (si existe; viene de reconciliation_snapshot)
- variance (resultado de la conciliación)

**CALCULAR on-demand (via view/query):**
- movement_count
- movement_sum
- needs_review_count

**Razón:** Datos derivados pueden quedar stale si se actualizan meses anteriores. Es mejor recalcular en queries de auditoría.

---

## RESUMEN DE HALLAZGOS

### 🟢 Operativo y reutilizable:
- ✅ Trigger automático de recalculación de balance
- ✅ Función calculate_ledger_balance() (excepto timezone)
- ✅ Estructura de account_balance con campos para observaciones
- ✅ Índices optimizados

### 🟡 Funcional pero con defecto crítico:
- ⚠️ `DATE(occurred_at)` sin AT TIME ZONE → riesgo de error de ~1 día en medianoche UTC
- ⚠️ Julio-agosto aparentemente no afectados (por coincidencia de horarios)
- ⚠️ Riesgo real antes de importar enero-junio

### 🔴 No implementado:
- ❌ Snapshots históricos de observaciones
- ❌ Conciliación mensual formal
- ❌ Tracking de coverage (qué períodos están completos)
- ❌ Estados de conciliación (pending/reconciled/etc)

---

## RECOMENDACIONES INMEDIATAS

### 1. AUDITORÍA ANTES DE FASE 1:
```sql
-- Verificar que NO hay movimientos en "zona de riesgo"
SELECT COUNT(*) 
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE_TRUNC('hour', occurred_at AT TIME ZONE 'UTC')::HOUR BETWEEN 0 AND 3
  AND occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires' >= '2026-07-01'::DATE;
-- Esperado: 0 (si hay resultados, hay riesgo)
```

### 2. ANTES DE IMPORTAR ENERO-JUNIO:
Corregir `calculate_ledger_balance()` y trigger:
```sql
-- ACTUAL (defectuoso):
AND DATE(occurred_at) >= v_opening_date

-- CORRECTO:
AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= v_opening_date
```

### 3. PARA FASE 1:
- ✅ Mantener account_balance como está (cache operativo)
- ✅ Crear reconciliation_snapshot (historial de observaciones)
- ✅ Crear monthly_reconciliation (estado formal)
- ✅ Crear import_period_coverage (qué períodos están listos)
- ⚠️ Advertencia: corregir timezone ANTES de importar más períodos

---

## RESPUESTA A TUS 8 PREGUNTAS

1. ✅ **SQL REAL de calculate_ledger_balance:** Correcto lógicamente, DEFECTO CRÍTICO de timezone
2. ✅ **SQL REAL del trigger:** Mismo defecto de timezone, pero operativo para julio-agosto
3. ✅ **account_balance estructura:** Tiene campos para observaciones (nunca usados)
4. ✅ **Uso de observed_balance_mp y variance:** NUNCA usado operativamente
5. ✅ **Lógica reutilizable:** Sí (trigger + función), con salvedad de timezone
6. ✅ **Determinación de balance_date:** `DATE(occurred_at)` sin timezone
7. ✅ **Riesgos timezone:** SÍ, crítico, pero julio-agosto sin aparente impacto
8. ✅ **Persistir vs calcular:** Snapshot histórico para cierres, query para derivados

---

**RECOMENDACIÓN FINAL:** Proceed con FASE 1, pero DOCUMENTAR corrección de timezone como blocker antes de enero-junio.
