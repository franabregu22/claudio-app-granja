# VEREDICTO FINAL: import_v2 NO APTA PARA PRODUCCIÓN

**Fecha:** 2026-09-11  
**Status:** ❌ BLOQUEADO - BUG CRÍTICO ENCONTRADO  
**Confianza:** 100% (verificado con test real)

---

## HALLAZGO CRÍTICO

### Test Comparativo: preview_v2 vs import_v2

**Test data:** 1 fila con SOURCE_ID='test_source_001'

#### preview_v2 (READ-ONLY):
```
Status: ✓ SUCCESS
Result: new_source_records: 1
Conclusion: Funciona correctamente
```

#### import_v2 (WRITE):
```
Status: ❌ FAILED
Error: null value in column "source_external_id" of relation "mp_source_record" 
       violates not-null constraint

Failing row: (11055, report, null, [payload_hash], {...}, null, ..., pending, 
             null, 1054315166, ...)

Conclusion: import_v2 NO extrae correctamente SOURCE_ID del JSON
```

---

## ANÁLISIS DEL BUG

### Lo que está pasando:

```
1. preview_v2 recibe JSON con "SOURCE_ID": "test_source_001"
   ✓ Extrae correctamente el valor
   ✓ Predice 1 SR nuevo

2. import_v2 recibe el MISMO JSON con "SOURCE_ID": "test_source_001"
   ✗ Intenta INSERT en mp_source_record
   ✗ source_external_id = NULL (valor no extraído)
   ✗ Constraint NOT NULL viola
   ✗ INSERT falla
```

### Root cause probable:

La RPC import_v2 instalada en Supabase tiene un bug en la extracción de SOURCE_ID:

```
-- CÓDIGO PROBABLE QUE FALLA:
v_source_id := v_row->>'SOURCE_ID';  -- Esto funciona en preview_v2

-- PERO en insert:
INSERT INTO mp_source_record(
  ..., source_external_id, ...
)
VALUES(
  ..., v_source_id, ...  -- ← SI v_source_id NO se asignó correctamente, es NULL
)
```

**Problema:** El nombre de la variable puede estar mal, o la lógica de extracción falla bajo ciertas condiciones en import_v2 pero no en preview_v2.

---

## IMPLICACIONES

### Para el report 65330696:

Aunque preview_v2 predijo correctamente 6 SR + 6 FM + 6 LE:

**import_v2 fallará exactamente igual** al intentar:
1. Extraer SOURCE_ID de cada fila
2. Insertarlo en source_external_id
3. La columna será NULL
4. Violation de NOT NULL constraint

**Resultado esperado:** TRANSACCIÓN ABORTADA, 0 registros creados

### Para forward-looking automático:

**NO PUEDE IMPLEMENTARSE** hasta que import_v2 sea corregida.

---

## VEREDICTO

### ❌ NO APTA PARA PRIMER COMMIT CONTROLADO

**Razones:**

1. ✗ Bug confirmado: source_external_id = NULL en insert
2. ✗ preview_v2 y import_v2 tienen diferencias críticas
3. ✗ Migración 009 NO corrigió este bug (contrario a lo asumido)
4. ✗ Riesgo: Intenta escribir en BD pero fallará
5. ✗ Atomicidad: Fallo en SR → aborta FM/LE/LINK (correcto), pero RPC no es usable

**Evidencia:**
- Test 1: preview_v2 SUCCESS
- Test 2: import_v2 FAILED (source_external_id NULL)
- Diferencia: Las funciones NO son equivalentes

---

## QUAT A HACER

### OPCIÓN 1: Reparar import_v2

Necesaria auditoría del código de import_v2 para:
1. Verificar extracción de SOURCE_ID
2. Confirmar asignación a source_external_id
3. Revisar diferencias vs preview_v2
4. Aplicar fix en migración nueva (ej: 010)
5. Re-testear

**Tiempo:** 1-2 horas

### OPCIÓN 2: Crear RPC nueva

Basarse en preview_v2 pero con WRITES:
- Mantener lógica de lectura de preview_v2 (que funciona)
- Agregar INSERT statements correctos
- Testear thoroughly

**Tiempo:** 2-4 horas

### OPCIÓN 3: Usar preview_v2 + script Python

- Ejecutar preview_v2 para validación
- Python script que reciba JSON de preview
- Python script inserta directamente en Supabase
- Evita confiar en import_v2

**Tiempo:** 2-3 horas

---

## CÓMO NO LLEGAMOS ACÁ

### Mi error en auditoría anterior:

1. ✓ Probé preview_v2 y funcionó
2. ✓ Asumí que migración 009 corrigió ambas funciones
3. ✗ NO probé import_v2 con datos que gatillen INSERT real
4. ✗ Confié en que "preview_v2 funciona" = "import_v2 funciona"

**Lección:** preview y write pueden divergir. Ambas deben auditarse.

---

## EVIDENCIA FINAL

```
Timestamp: 2026-09-11 18:00:00Z
Test data: {"DATE": "...", "SOURCE_ID": "test_source_001", ...}

preview_v2 call:
  → Input: same JSON
  → Output: new_source_records = 1 ✓
  
import_v2 call:
  → Input: same JSON
  → Output: source_external_id NOT NULL VIOLATION ✗
  
Conclusión: import_v2 tiene bug de extracción de SOURCE_ID
```

---

## PRÓXIMOS PASOS

**NO ejecutar ningún commit hasta que import_v2 sea reparada.**

Opciones:
1. Investigar código de import_v2 (si es accesible)
2. Crear fix en nueva migración
3. Testear fix con test data
4. Re-auditar

**Sin corrección:** Forward-looking automático NO es viable.

---

**Generado:** 2026-09-11 18:05:00Z  
**Auditor:** Claude Code  
**Veredicto:** BLOQUEADO POR BUG CRÍTICO
