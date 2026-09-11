# REVISIÓN ESTÁTICA FINAL: Código Liberaciones v2
## Verificación contra 7 puntos críticos + schema real

**Fecha**: 2026-09-05  
**Estado**: REVISIÓN EN PROGRESO

---

## [1] VALIDACIÓN ECONÓMICA DE 716 FM REUTILIZADOS

### Hallazgo
❌ **INCORRECTO**: RPC comenta validación pero NO la implementa.

```sql
-- Validar que balance_impact Liberaciones == settlement_amount existente
-- (código comenta pero no hace nada)
```

### Corrección requerida
✅ Implementar comparación NUMÉRICA antes de crear LINK:

```sql
-- PASO 4.5: Obtener settlement_amount del FM existente
DECLARE v_existing_settlement DECIMAL(15,2);
BEGIN
  SELECT settlement_amount INTO v_existing_settlement
  FROM mp_financial_movement
  WHERE id = v_existing_fm_id;
  
  -- Validación económica
  IF ABS(v_balance_impact - v_existing_settlement) > 0.01 THEN
    RAISE EXCEPTION '[Fila %] Monto discrepante: Lib=% vs FM existente=%', 
      v_idx, v_balance_impact, v_existing_settlement;
  END IF;
END;
```

### Riesgo mitigado
✓ Sin esto, un SOURCE_ID con monto incorrecto en Liberaciones crearía correlación falsa

---

## [2] RESERVAS: DESCRIPTION-FIRST, no balance_impact-first

### Hallazgo
❌ **INCORRECTO**: Lógica actual usa `ABS(balance_impact) < 0.01` como criterio general.

```sql
IF ABS(v_balance_impact) < 0.01 THEN
  -- RESERVAS: solo guardar RAW, sin FM/LE
  v_sr_raw_only := v_sr_raw_only + 1;
  CONTINUE;
END IF;
```

**Problema**: Un DESCRIPTION futuro con $0.00 quedaría mal clasificado.

### Corrección requerida
✅ DESCRIPTION-first, balance_impact-second:

```sql
-- PASO 2: Whitelist por DESCRIPTION (determinístico)
IF v_description IN ('reserve_for_payment', 'reserve_for_payout') THEN
  -- Reservas por definición: RAW only, sin FM/LE
  v_sr_raw_only := v_sr_raw_only + 1;
  CONTINUE;  -- Ir al siguiente registro
ELSIF v_description NOT IN ('payment', 'asset_management', 'payout') THEN
  -- Desconocido: RAW only
  v_sr_raw_only := v_sr_raw_only + 1;
  CONTINUE;
END IF;

-- PASO 3: Ahora sí, validar balance_impact para payment/payout/asset_management
IF ABS(v_balance_impact) < 0.01 THEN
  -- Movimiento definitivo sin impacto = extraño, pero procesar (puede ser ajuste)
  -- No es suficiente para descartarlo
  NULL;  -- continuar
END IF;
```

### Riesgo mitigado
✓ Reservas se clasifican por nombre, no por monto
✓ Futuros DESCRIPTION desconocidos siempre van a RAW only
✓ No perder transacciones legítimas de $0.00

---

## [3] CONTADOR total_sr: NO duplicar raw_only

### Hallazgo
❌ **INCORRECTO** en importer:

```python
total_sr = total_sr_created + total_sr_existing + total_sr_raw_only  # INCORRECTO
```

Duplica las 72 reservas.

### Corrección requerida
✅ Separar totales:

```python
# Totales reales
total_sr = total_sr_created + total_sr_existing  # 798 en primera ejecución

print(f"Source Records:")
print(f"  Creados: {total_sr_created}")
print(f"  Existentes: {total_sr_existing}")
print(f"  Raw-only (reservas + desconocidos): {total_sr_raw_only}")
print(f"  TOTAL SR: {total_sr}")  # Sin contar raw_only
print(f"  ESPERADO: 798")
print(f"  {'PASS' if total_sr == 798 else 'FAIL'}")
```

**Primera ejecución**:
```
created = 798
existing = 0
raw_only = 72
total = 798 ✓
```

**Segunda ejecución** (idempotencia):
```
created = 0
existing = 798
raw_only = 72
total = 798 ✓
```

### Riesgo mitigado
✓ Contadores reflejan realidad (726 links = 696+20 payment/asset + 10 payout)

---

## [4] load_dotenv(): Cargar .env.local explícitamente

### Hallazgo
❌ **INCORRECTO**: `load_dotenv()` busca `.env` por defecto, no `.env.local`.

```python
load_dotenv()  # Busca .env, no .env.local
```

### Corrección requerida
✅ Especificar ruta explícita:

```python
from dotenv import load_dotenv
from pathlib import Path

# Cargar .env.local explícitamente
env_path = Path('.env.local')
if not env_path.exists():
    print("ERROR: .env.local no encontrado. Crear a partir de .env.template")
    sys.exit(1)

load_dotenv(dotenv_path=env_path)

# Verificar que las claves se cargaron
if not os.getenv('SUPABASE_URL') or not os.getenv('SUPABASE_SERVICE_ROLE_KEY'):
    print("ERROR: Credenciales no configuradas en .env.local")
    sys.exit(1)

# NUNCA imprimir la service role
print(f"OK - Conectando a Supabase ({SUPABASE_URL[:30]}...)")
```

### Riesgo mitigado
✓ No se hardcodean credenciales
✓ No se imprime la service role
✓ Cargar archivo correcto (.env.local)

---

## [5] QUERIES DE VALIDACIÓN: Multi-período no-safe

### Hallazgo
⚠️ **ADVERTENCIA**: Queries actuales usan:

```sql
DATE(sr.observed_at) = (SELECT MAX(DATE(observed_at)) 
                        FROM mp_source_record 
                        WHERE source_type='liberaciones')
```

**Problema**: Si importamos Liberaciones2 (mayo) el mismo día que Liberaciones3 (agosto), las queries se confunden.

### Corrección requerida
✅ Para validación INMEDIATA post-import:

Usar los IDs guardados en `liberaciones_import_result.json`:

```sql
-- Validación POST-IMPORT INMEDIATA (para esta ejecución)
-- Usar IDs reales generados por el importer

WITH created_sr AS (
  SELECT UNNEST(ARRAY[3001, 3002, 3003, ...]) as id
),
created_fm AS (
  SELECT UNNEST(ARRAY[1001, 1002, ..., 1010]) as id
),
created_le AS (
  SELECT UNNEST(ARRAY[2001, 2002, ..., 2010]) as id
)

SELECT 'SR_created' as check,
       COUNT(*) as total
FROM mp_source_record
WHERE id = ANY(SELECT id FROM created_sr);
-- Esperado: 798
```

✅ Para validación FUTURA (multi-período):

```sql
-- Validación genérica (funciona con múltiples importaciones)
SELECT 'SR_by_period' as metric,
       COUNT(*) FILTER (WHERE DATE(observed_at) = '2026-08-31') as august,
       COUNT(*) FILTER (WHERE DATE(observed_at) = '2026-05-31') as may
FROM mp_source_record
WHERE source_type='liberaciones';
```

### Riesgo mitigado
✓ Validación inmediata: confiable (IDs exactos)
✓ Validación futura: agregar `period_tag` en source_record.raw_data si se necesita

---

## [6] ROLLBACK: Orden correcto según FK reales

### Schema FK verification
✓ **Verificado en 004_mp_new_architecture.sql**:

```
ledger_entry.financial_movement_id -> mp_financial_movement.id (FK)
mp_movement_source_link.financial_movement_id -> mp_financial_movement.id (FK)
mp_movement_source_link.source_record_id -> mp_source_record.id (FK)
```

### Orden seguro de DELETE
✅ Respetar cascada (de más dependiente a menos):

```sql
-- PASO 1: Eliminar LE creadas (FK a FM)
DELETE FROM ledger_entry
WHERE id = ANY(@created_le_ids);

-- PASO 2: Eliminar LINK creadas (FK a FM y SR)
DELETE FROM mp_movement_source_link
WHERE id = ANY(@created_link_ids);

-- PASO 3: Eliminar FM creadas (luego de sus dependientes)
DELETE FROM mp_financial_movement
WHERE id = ANY(@created_fm_ids);

-- PASO 4: Eliminar SR creadas (luego de sus dependientes)
DELETE FROM mp_source_record
WHERE id = ANY(@created_sr_ids);
```

### Riesgo mitigado
✓ Orden respeta FK constraints
✓ No genera "violación de FK" durante rollback
✓ Multi-período: solo toca IDs creados por ESTA importación

---

## [7] NO EJECUTAR: Checklist de bloqueos pre-ejecución

### ❌ Bloqueadores encontrados

| Punto | Status | Crítica |
|-------|--------|---------|
| [1] Validación económica | No implementada | **CRÍTICA** |
| [2] Reservas por DESCRIPTION | No implementada | **CRÍTICA** |
| [3] total_sr duplica raw_only | Código incorrecto | **CRÍTICA** |
| [4] load_dotenv(.env.local) | No especificado | **ALTA** |
| [5] Queries multi-período | No seguras | MEDIA |
| [6] Rollback FK order | Verificado OK | ✓ |

---

## RESUMEN: CORRECCIONES NECESARIAS

### Archivos a corregir

**[B] RPC: import_liberaciones_primary.sql**
- [ ] Agregar PASO 4.5: Validación económica (comparar settlement_amount)
- [ ] Reorganizar PASO 2: DESCRIPTION-first whitelist
- [ ] Eliminar lógica de `ABS(balance_impact) < 0.01` como criterio general

**[C] Importer: import_liberaciones.py**
- [ ] Corregir `total_sr = created + existing` (sin raw_only)
- [ ] Cambiar `load_dotenv()` a `load_dotenv(dotenv_path=Path('.env.local'))`
- [ ] Verificar .env.local existe
- [ ] NO imprimir SUPABASE_SERVICE_ROLE_KEY jamás

**[E] Queries: validacion_liberaciones_import_v2.sql**
- [ ] Marcar como "PARA PRUEBA INMEDIATA" (dependen de MAX DATE)
- [ ] Agregar nota: "Para multi-período, usar IDs de .json"

**[F] Rollback: rollback_liberaciones_import.sql**
- [ ] Reordenar DELETE: LE → LINK → FM → SR
- [ ] Generar SQL real con IDs de liberaciones_import_result.json
- [ ] Documentar que solo afecta esta importación

---

## HALLAZGOS DE REVISIÓN ESTÁTICA

✓ **OK**: Schema FK order verificado  
✓ **OK**: Nombres de columnas concordantes  
✓ **OK**: ON CONFLICT clauses correctos  
✓ **OK**: .env.template correcto  
✓ **OK**: Invariantes 798/726/10 conceptualmente válidos  

❌ **FALLOS**: 3 implementaciones faltantes  
⚠️ **ADVERTENCIAS**: 2 validaciones inseguras  

---

## RIESGOS PENDIENTES

1. **Si no se implementa validación económica**: Monto incorrecto en Liberaciones = correlación falsa
2. **Si balance_impact decide reservas**: DESCRIPTION='payout' con $0.00 = mal clasificado
3. **Si total_sr suma raw_only**: Contadores mienten (798 = 798+72, incorrecto)
4. **Si load_dotenv() busca .env**: Service role va a .env, .env.local ignorado
5. **Si queries usan MAX(DATE)**: Segunda importación mismo día = resultados errados

---

## ¿LISTO PARA EJECUTAR?

### RESPUESTA: **NO**

**Razón**: 3 bloqueadores críticos impiden ejecución segura.

**Acciones requeridas ANTES de ejecución**:

1. ✏️ Corregir RPC: Agregar validación económica + DESCRIPTION-first lógica
2. ✏️ Corregir importer: Contador correcto + .env.local explícito
3. ✏️ Corregir queries: Marcar como "inmediatas solamente" o usar IDs
4. ✏️ Verificar rollback: DELETE order correcto, usar .json

**Tiempo estimado de correcciones**: 30-45 minutos  
**Complejidad**: Media (cambios localizados, sin arquitectura nueva)

---

**SIGUIENTE PASO**: Generar CODIGO_FINAL_V3 con correcciones + re-ejecutar revisión estática

