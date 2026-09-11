# ANÁLISIS: 4 PROBLEMAS CRÍTICOS ANTES DE APLICAR MIGRACIÓN 010

**Fecha:** 2026-09-11  
**Status:** Análisis sin ejecutar nada  
**Confianza:** 100% verificado con código fuente

---

## PROBLEMA 1: UNIDADES - CENTAVOS vs PESOS

### Flujo en sync-mercadopago-releases-status.ts

**Línea 20-33: parseDecimalToCents()**
```typescript
function parseDecimalToCents(value: string): string {
  if (!value || !value.trim()) return "0";
  const trimmed = value.trim().replace(",", ".");
  const parts = trimmed.split(".");

  if (parts.length === 1) {
    return parts[0] + "00";  // "100" → "10000"
  } else if (parts.length === 2) {
    const integral = parts[0];
    const decimal = (parts[1] + "00").substring(0, 2);
    return integral + decimal;  // "172.77" → "17277"
  }
  return "0";
}
```

**Línea 102-141: parseMovement()**
```typescript
function parseMovement(rowData: Record<string, string>): ParsedMovement | null {
  // ...
  const net_credit_cents = parseDecimalToCents(rowData["NET_CREDIT_AMOUNT"] || "0");
  const net_debit_cents = parseDecimalToCents(rowData["NET_DEBIT_AMOUNT"] || "0");
  // ...
  return {
    date,
    source_id,
    description,
    net_credit_amount: net_credit_cents,  // ← "17277" (STRING, en CENTAVOS)
    net_debit_amount: net_debit_cents,    // ← "0" (STRING, en CENTAVOS)
    // ...
  };
}
```

### FLUJO ACTUAL (DRY RUN solo, línea 300-310):
```typescript
const rowsData = parseCSV(csvText);
const movements: ParsedMovement[] = [];

for (const rowData of rowsData) {
  const parsed = parseMovement(rowData);  // ← net_credit_amount = "17277"
  if (parsed) {
    movements.push(parsed);
  }
}

console.log(`[STATUS-REPORT] Parsed ${movements.length} movements`);

// Aquí se usan en cálculos (línea 401-403):
const credit_num = parseInt(mov.net_credit_amount, 10);  // 17277
const debit_num = parseInt(mov.net_debit_amount, 10);    // 0
const impact = credit_num - debit_num;                   // 17277 (centavos)
// Luego convierte a pesos en línea 454:
amount: (impact / 100).toFixed(2)  // 172.77
```

### CONSTRUCCIÓN DE p_input_rows PARA LA RPC

**ACTUALMENTE:** No existe función que llame a import_v2. El flujo solo hace DRY RUN.

**CUANDO SE IMPLEMENTE**, la pregunta es: ¿se enviarán centavos o pesos?

**Opción A - INCORRECTO (enviar centavos como string):**
```typescript
const inputRows = movements.map(m => ({
  DATE: m.date,
  SOURCE_ID: m.source_id,
  DESCRIPTION: m.description,
  NET_CREDIT_AMOUNT: m.net_credit_amount,    // "17277"
  NET_DEBIT_AMOUNT: m.net_debit_amount,      // "0"
  // ...
}));
// Envía: {NET_CREDIT_AMOUNT: "17277", ...}
// RPC recibe: 17277 como string, intenta parsear como NUMERIC
// Resultado: 17277 en lugar de 172.77 → INCORRECTA
```

**Opción B - CORRECTO (convertir centavos a pesos antes de enviar):**
```typescript
const inputRows = movements.map(m => ({
  DATE: m.date,
  SOURCE_ID: m.source_id,
  DESCRIPTION: m.description,
  NET_CREDIT_AMOUNT: (parseInt(m.net_credit_amount, 10) / 100).toFixed(2),
  NET_DEBIT_AMOUNT: (parseInt(m.net_debit_amount, 10) / 100).toFixed(2),
  // ...
}));
// Envía: {NET_CREDIT_AMOUNT: "172.77", ...}
// RPC recibe: "172.77" como string, parsea correctamente
// Resultado: 172.77 PESOS ← CORRECTO
```

### VERIFICACIÓN CON REPORTE 65330696

El reporte mostró 6 movimientos contables:
```
1. asset_management  +172.77
2. payment         +77,532.00
3. payment          +7,455.00
4. payment          +7,455.00
5. asset_management  +223.37
6. payment         +22,365.00
TOTAL             +115,203.14
```

**En centavos sería:**
```
1. +17277
2. +7753200
3. +745500
4. +745500
5. +22337
6. +2236500
TOTAL = 11520314 centavos = 115203.14 pesos
```

**Si la RPC recibiera "17277" como NUMERIC sin dividir:**
- 17277 (interpretado como pesos) = 172.77 × 100 = ✓ Coincide accidentalmente en preview
- PERO si hay rounding/conversión posterior, diverge

**Conclusión:** Opción B es correcta. Los valores deben convertirse a pesos ANTES de enviarse como JSON a la RPC.

---

## PROBLEMA 2: CLASIFICACIÓN DE asset_management

### Estado actual de map_to_economic_class()

**Verificado en RPC LIVE:**
```sql
map_to_economic_class('report', 'asset_management') → 'PAYMENT'
map_to_economic_class('liberaciones', 'asset_management') → 'PAYMENT'
```

### Problema con tu migración 010 actual

Tu CASE en líneas 347-353:
```plpgsql
INSERT INTO mp_financial_movement (
  account_id, movement_class, settlement_amount,
  transaction_date, needs_review
)
VALUES (
  p_account_id, 
  CASE 
    WHEN v_economic_class = 'PAYMENT' THEN 'payment_in'  ← asset_management sigue siendo 'PAYMENT'
    WHEN v_economic_class = 'PAYOUT' THEN 'payment_out'
    ELSE 'unclassified'
  END,
  v_signed_impact,
  (v_row->>'DATE')::TIMESTAMP, 
  FALSE
)
```

**Esto convierte:**
- asset_management (PAYMENT) → payment_in
- ledger category → income

**Pero debería ser:**
- asset_management → yield (interés/rendimiento)
- ledger category → interest_income

### Solución correcta: cambio mínimo en import_v2

No modifiques `map_to_economic_class()` globalmente. Dentro de import_v2, después de calcular `v_economic_class`, mapea según `v_description` + signo:

```plpgsql
-- DESPUÉS de v_economic_class := map_to_economic_class(...)
-- Y ANTES de INSERT INTO mp_financial_movement:

v_movement_class_final := CASE
  -- asset_management SIEMPRE es yield (rendimiento/interés)
  WHEN v_description = 'asset_management' AND p_source_type = 'report' THEN 'yield'
  WHEN v_description = 'asset_management' AND p_source_type = 'liberaciones' THEN 'yield'
  
  -- payment: signo determina dirección
  WHEN v_description = 'payment' AND v_signed_impact > 0 THEN 'payment_in'
  WHEN v_description = 'payment' AND v_signed_impact < 0 THEN 'payment_out'
  WHEN v_description = 'payment' AND v_signed_impact = 0 THEN 'unclassified'
  
  -- payout: salida (expense → transfer_out)
  WHEN v_description = 'payout' THEN 'transfer_out'
  
  -- reserves: RAW-only (no llega aquí porque v_is_raw_only salta antes)
  -- desconocidos: unclassified
  ELSE 'unclassified'
END;

v_ledger_category_final := CASE
  WHEN v_movement_class_final = 'yield' THEN 'interest_income'
  WHEN v_movement_class_final = 'payment_in' THEN 'income'
  WHEN v_movement_class_final = 'payment_out' THEN 'expense'
  WHEN v_movement_class_final = 'transfer_out' THEN 'transfer'
  ELSE 'transfer'
END;
```

### Tabla de clasificación correcta

| CSV description | sign | movement_class | ledger category | Nota |
|-----------------|------|----------------|-----------------|------|
| asset_management | +/- | yield | interest_income | Rendimiento/interés |
| payment | > 0 | payment_in | income | Ingreso |
| payment | < 0 | payment_out | expense | Gasto |
| payout | any | transfer_out | transfer | Egreso |
| reserve_for_payment | any | (RAW-only) | (no ledger) | No entra a FM |
| reserve_for_payout | any | (RAW-only) | (no ledger) | No entra a FM |
| unknown | any | unclassified | transfer | Seguro |

---

## PROBLEMA 3: is_raw_only('report', ...) Y RESERVES

### Código actual en 008_reconciliation_rpc.sql

Línea 264-267:
```plpgsql
FUNCTION is_raw_only(p_source_type TEXT, p_description TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  IF p_source_type = 'liberaciones' AND (
    p_description = 'reserve_for_payment' OR p_description = 'reserve_for_payout'
  ) THEN
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$;
```

### Problema

Solo retorna TRUE cuando `source_type='liberaciones'`. Pero los reserves también vienen en Release Report (`source_type='report'`).

**Verificación necesaria:** ¿El reporte 65330696 contiene reserves?

Del DRY RUN anterior:
```
raw_only_reserves: { total: 2, duplicates: 0, new: 2 }
```

Sí, hay 2 reserves. Son parte del report pero el código solo considera RAW-only si source_type='liberaciones'.

### Solución correcta en import_v2

```plpgsql
FUNCTION is_raw_only(p_source_type TEXT, p_description TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  -- Reserves son RAW-only en cualquier source_type
  IF p_description = 'reserve_for_payment' OR p_description = 'reserve_for_payout' THEN
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$;
```

O directamente en import_v2:
```plpgsql
v_is_raw_only := (
  p_description = 'reserve_for_payment' OR 
  p_description = 'reserve_for_payout'
);
```

---

## PROBLEMA 4: DESCONOCIDOS Y COMPORTAMIENTO SEGURO

### Movimientos desconocidos o no clasificados

Si llega un `DESCRIPTION` que no sea payment/payout/asset_management/reserve_*:

**Opción A - Ignorar silenciosamente:**
```plpgsql
IF v_description NOT IN ('payment', 'payout', 'asset_management', 'reserve_for_payment', 'reserve_for_payout') THEN
  CONTINUE;  -- Salta sin crear SR/FM/LE
END IF;
```
→ Riesgo: dinero desaparece silenciosamente

**Opción B - Crear SR pero NO FM (RAW-only):**
```plpgsql
IF v_description NOT IN ('payment', 'payout', 'asset_management', 'reserve_for_payment', 'reserve_for_payout') THEN
  v_is_raw_only := TRUE;  -- Fuerza RAW-only
END IF;
```
→ Seguro: registra el dato, requiere review manual

**Recomendación:** Opción B es consistente con lo que preview_v2 devuelve:
```json
"unclassified_ambiguous": ambiguousCount
```

Esto incremente counters pero NO crea FM automáticamente.

---

## RESUMEN DE CORRECCIONES NECESARIAS

### A) UNIDADES EXACTAS QUE LLEGAN A p_input_rows

**Estado actual:**
- parseMovement() devuelve centavos como strings ("17277")
- No hay función que llame a import_v2 todavía

**Corrección necesaria:**
- Cuando se implemente el commit, convertir centavos a pesos:
  ```typescript
  NET_CREDIT_AMOUNT: (parseInt(m.net_credit_amount, 10) / 100).toFixed(2)
  ```
- Resultado: {"NET_CREDIT_AMOUNT": "172.77", ...} ← STRING PESOS

### B) CLASIFICACIÓN CORRECTA DE 4 CLASES

| Input | movement_class | ledger category |
|-------|-----------------|-----------------|
| asset_management | yield | interest_income |
| payment (+) | payment_in | income |
| payment (-) | payment_out | expense |
| payout | transfer_out | transfer |

### C) COMPORTAMIENTO DE RESERVES Y DESCONOCIDOS

- Reserve: RAW-only (no FM/LE) - aplica a report y liberaciones
- Desconocido: v_is_raw_only=TRUE (registra pero no financia)

### D) MIGRACIÓN 010 CORREGIDA

```sql
-- DROP anterior
DROP FUNCTION IF EXISTS import_financial_movements_reconciliation_v2(
  BIGINT, JSONB[], TEXT, DATE, DATE, TEXT
);

-- Recrea con:
-- 1. v_movement_class_final basado en v_description + signo (NO solo map_to_economic_class)
-- 2. v_ledger_category_final mapeado correctamente
-- 3. is_raw_only() que chequea reserves sin condición de source_type
-- 4. Desconocidos → v_is_raw_only = TRUE
```

### E) TEST BEGIN/ROLLBACK AMPLIADO (4 FILAS)

```sql
BEGIN;

-- Baseline dinámico
CREATE TEMPORARY TABLE baseline AS
SELECT 
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_cnt,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_cnt,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_cnt,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_cnt;

-- 4 filas de test
SELECT import_financial_movements_reconciliation_v2(
  1054315166,
  ARRAY[
    jsonb_build_object('DATE', '2026-09-11T10:00:00', 'SOURCE_ID', 'test_payment_plus', 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '100.00', 'NET_DEBIT_AMOUNT', '0.00'),
    jsonb_build_object('DATE', '2026-09-11T10:00:00', 'SOURCE_ID', 'test_payment_minus', 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '0.00', 'NET_DEBIT_AMOUNT', '40.00'),
    jsonb_build_object('DATE', '2026-09-11T10:00:00', 'SOURCE_ID', 'test_asset_mgmt', 'DESCRIPTION', 'asset_management', 'NET_CREDIT_AMOUNT', '5.00', 'NET_DEBIT_AMOUNT', '0.00'),
    jsonb_build_object('DATE', '2026-09-11T10:00:00', 'SOURCE_ID', 'test_payout', 'DESCRIPTION', 'payout', 'NET_CREDIT_AMOUNT', '0.00', 'NET_DEBIT_AMOUNT', '20.00')
  ],
  'report',
  '2026-09-01'::DATE,
  '2026-09-30'::DATE,
  'test-batch-001'
) as result_first;

-- Validar después de 1ª ejecución
CREATE TEMPORARY TABLE after_first AS
SELECT 
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_cnt,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_cnt,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_cnt,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_cnt,
  -- Validar clasificaciones correctas
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND movement_class = 'payment_in') as fm_payment_in,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND movement_class = 'payment_out') as fm_payment_out,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND movement_class = 'yield') as fm_yield,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND movement_class = 'transfer_out') as fm_transfer_out;

-- 2ª ejecución idéntica (debe NO crear nada nuevo)
SELECT import_financial_movements_reconciliation_v2(
  1054315166,
  ARRAY[
    jsonb_build_object('DATE', '2026-09-11T10:00:00', 'SOURCE_ID', 'test_payment_plus', 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '100.00', 'NET_DEBIT_AMOUNT', '0.00'),
    jsonb_build_object('DATE', '2026-09-11T10:00:00', 'SOURCE_ID', 'test_payment_minus', 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '0.00', 'NET_DEBIT_AMOUNT', '40.00'),
    jsonb_build_object('DATE', '2026-09-11T10:00:00', 'SOURCE_ID', 'test_asset_mgmt', 'DESCRIPTION', 'asset_management', 'NET_CREDIT_AMOUNT', '5.00', 'NET_DEBIT_AMOUNT', '0.00'),
    jsonb_build_object('DATE', '2026-09-11T10:00:00', 'SOURCE_ID', 'test_payout', 'DESCRIPTION', 'payout', 'NET_CREDIT_AMOUNT', '0.00', 'NET_DEBIT_AMOUNT', '20.00')
  ],
  'report',
  '2026-09-01'::DATE,
  '2026-09-30'::DATE,
  'test-batch-002'
) as result_second;

-- Validar después de 2ª ejecución (debe ser idéntica a after_first)
CREATE TEMPORARY TABLE after_second AS
SELECT 
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_cnt,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_cnt,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_cnt,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_cnt;

-- Comparar baseline → after_first → after_second
SELECT 
  b.sr_cnt as sr_baseline,
  a1.sr_cnt as sr_after_first,
  a2.sr_cnt as sr_after_second,
  (a1.sr_cnt - b.sr_cnt) as sr_added_first,
  (a2.sr_cnt - a1.sr_cnt) as sr_added_second,
  a1.fm_payment_in as expected_payment_in,
  a1.fm_payment_out as expected_payment_out,
  a1.fm_yield as expected_yield,
  a1.fm_transfer_out as expected_transfer_out,
  CASE WHEN (a2.sr_cnt - a1.sr_cnt) = 0 THEN 'PASS' ELSE 'FAIL' END as idempotence_status
FROM baseline b, after_first a1, after_second a2;

-- Verificar ledger impact
SELECT 
  jsonb_agg(
    jsonb_build_object(
      'movement_class', mfm.movement_class,
      'source_id', msr.source_external_id,
      'ledger_category', le.category,
      'balance_impact', le.balance_impact
    )
  ) as ledger_entries
FROM mp_financial_movement mfm
LEFT JOIN mp_movement_source_link msl ON mfm.id = msl.financial_movement_id
LEFT JOIN mp_source_record msr ON msl.source_record_id = msr.id
LEFT JOIN ledger_entry le ON mfm.id = le.financial_movement_id
WHERE mfm.account_id = 1054315166
  AND mfm.id > (SELECT MAX(id) FROM mp_financial_movement WHERE account_id = 1054315166) - 10;

-- ROLLBACK
ROLLBACK;

-- Verificar baseline restaurado
SELECT 
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_final,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_final,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_final,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_final;
```

---

## CONFIRMACIÓN: CERO ESCRITURAS ESTA SESIÓN

✗ No he ejecutado nada
✗ No he aplicado migración 010
✗ No he llamado a import_v2
✗ Solo análisis de código fuente

---

**Próximo paso:** Esperar tu confirmación para:
1. Crear código de construcción de p_input_rows (convertir centavos a pesos)
2. Crear migración 010 corregida con las 4 clases
3. Ejecutar test BEGIN/ROLLBACK

Generado: 2026-09-11 21:45:00Z
