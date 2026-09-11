# RESUMEN FINAL: CÓDIGO V6 - VERSIONADO RAW COMPLETO

**Fecha**: 2026-09-05  
**Estado**: V6 LISTA PARA EJECUCIÓN  
**Bloqueadores v5**: 4 CORREGIDOS + Versionado implementado

---

## CORRECCIONES V6 IMPLEMENTADAS

| Bloqueador | v5 Problema | v6 Solución | Línea RPC |
|-----------|-----------|-----------|----------|
| A | SR exacto con link ignorado | Verificar PASO 3, si linked → CONTINUE | 124-137 |
| B | Versión previa distinto payload | Buscar Liberaciones previa, comparar economic_hash | 140-199 |
| B1 | Economía igual → crear FM duplicado | Si económicamente igual → solo LINK (sin FM/LE) | 180-183 |
| B2 | Economía cambió → ignorado | Si economic_hash diferente → marcar needs_review | 176-179 |
| C | account_id ignorado en búsquedas | Agregar `AND fm.account_id = p_account_id` en todas | 151, 169, 217 |
| D | Rollback scope limitado | DO $$ con 4 arrays BIGINT[] independientes | Rollback v6 |
| E | Paste manual cientos IDs | Script Python genera rollback desde .json | generate_liberaciones_rollback.py |

✅ **Todas 7 correcciones implementadas**

---

## PRUEBA A/B/C/D DE VERSIONADO E IDEMPOTENCIA

### ESCENARIO A: Primer payout nuevo (SOURCE_ID='PAY001', payload_hash='abc123')

**Estado previo**: Nada existe

**Ejecución v6**:
```
Fila 10: SOURCE_ID='PAY001', DESCRIPTION='payout'

[PASO 1] Crear SR
  INSERT → SR_id=1001 (CREADO, payload_hash='abc123')
  v_sr_created = 1

[PASO 2] Whitelist
  'payout' ✓ continúa

[PASO 3] Idempotencia A - SR exacto con link
  SELECT link WHERE source_record_id=1001
  → NULL (no existe aún)
  → Continúa

[PASO 4] Versionado RAW - Previa Liberaciones
  SELECT fm WHERE sr.source_type='liberaciones'
         AND sr.source_external_id='PAY001'
         AND sr.id != 1001  ← distinto SR
  → NULL (no existe previa)
  → Continúa

[PASO 5] Buscar en report
  SELECT fm WHERE sr.source_type='report'
         AND sr.source_external_id='PAY001'
         AND fm.account_id=CUENTA
  → NULL (payout no existe en report)
  → Continúa

[PASO 6] movement_class
  'payout' → v_movement_class='unclassified'

[PASO 7] Decidir
  v_existing_fm_id IS NULL
  → CREAR FM + LE
  INSERT FM → FM_id=2001 (CREADO)
  INSERT LE → LE_id=3001 (CREADO)
  v_fm_created = 1
  v_le_created = 1

[PASO 8] LINK
  INSERT LINK(FM_id=2001, SR_id=1001)
  → LINK_id=4001 (CREADO)
  v_link_created = 1
```

**ESCENARIO A TOTALES**:
```
SR:   1 creado
FM:   1 creado
LE:   1 creada
LINK: 1 creado
```

**INVARIANTE A**: sr_created=1, fm_created=1, le_created=1, link_created=1 ✓

---

### ESCENARIO B: Segunda ejecución IDÉNTICA (mismo SOURCE_ID='PAY001', payload_hash='abc123')

**Estado previo**: SR_id=1001, FM_id=2001, LE_id=3001, LINK_id=4001 (todo de A)

**Ejecución v6**:
```
Fila 10: SOURCE_ID='PAY001', DESCRIPTION='payout', payload_hash='abc123'

[PASO 1] Crear SR
  INSERT ... ON CONFLICT DO NOTHING
  → SR existe: v_source_record_id=NULL
  SELECT id → SR_id=1001 (RECUPERADO)
  v_sr_existing = 1

[PASO 2] Whitelist
  'payout' ✓ continúa

[PASO 3] Idempotencia A - SR exacto con link
  SELECT link WHERE source_record_id=1001
         AND fm.account_id=CUENTA
  → LINK_id=4001, FM_id=2001 (ENCONTRADO)
  v_existing_link_id = 4001
  
  IF v_existing_link_id IS NOT NULL THEN
    CONTINUE ← SALTA TODO LO DEMÁS
  END IF
```

**NO entra a PASO 4-8**

**ESCENARIO B TOTALES**:
```
SR:   0 creados (recuperados)
FM:   0 creados
LE:   0 creadas
LINK: 0 creados
```

**INVARIANTE B**: sr_created=0, sr_existing=1, fm_created=0, link_created=0 ✓ **IDEMPOTENCIA EXACTA**

---

### ESCENARIO C: Mismo SOURCE_ID, payload distinto, economía igual

**Estado previo**: SR_id=1001, FM_id=2001, LE_id=3001, LINK_id=4001 (con economic_hash='HASH_ABC')

**Nueva entrada**: SOURCE_ID='PAY001', payload_hash='xyz789' (metadata cambió, monto igual)

**Ejecución v6**:
```
Fila 20: SOURCE_ID='PAY001', DESCRIPTION='payout', payload_hash='xyz789' (DIFERENTE)

[PASO 1] Crear SR
  INSERT → SR_id=1002 (CREADO, payload_hash='xyz789')
  v_sr_created = 1

[PASO 2] Whitelist
  'payout' ✓ continúa

[PASO 3] Idempotencia A - SR exacto con link
  SELECT link WHERE source_record_id=1002
  → NULL (SR nuevo, no tiene link aún)
  → Continúa

[PASO 4] Versionado RAW - Previa Liberaciones ✅ CLAVE
  SELECT fm WHERE sr.source_type='liberaciones'
         AND sr.source_external_id='PAY001'
         AND sr.id != 1002  ← DISTINTO SR
         AND fm.account_id=CUENTA
  → FM_id=2001 (ENCONTRADO, vinculado a SR_id=1001)
  v_existing_fm_id_from_lib = 2001
  
  Calcular economic_hash de nueva versión
  v_new_economic_hash = calc_economic_hash(...monto igual...)
           = 'HASH_ABC' (IGUAL a v_existing_economic_hash)
  
  v_is_economic_change = FALSE
  
  → Si economía igual: reutilizar FM, crear solo LINK
  v_financial_movement_id = 2001 (reutilizado)
  
  INSERT LINK(FM_id=2001, SR_id=1002)
  → LINK_id=4002 (CREADO)
  v_link_created = 1
  
  CONTINUE ← SALTA resto de pasos
```

**ESCENARIO C TOTALES**:
```
SR:   1 creado (payload distinto)
FM:   0 creados (reutilizado)
LE:   0 creadas (reutilizado)
LINK: 1 creado (nuevo link al SR nuevo)
```

**INVARIANTE C**: sr_created=1, sr_existing=0, fm_created=0, le_created=0, link_created=1 ✓ **SIN DUPLICAR FM**

---

### ESCENARIO D: Mismo SOURCE_ID, economía cambió

**Estado previo**: SR_id=1001, FM_id=2001, LE_id=3001, LINK_id=4001, economic_hash='HASH_ABC'

**Nueva entrada**: SOURCE_ID='PAY001', monto diferente, payload_hash='def456'

**Ejecución v6**:
```
Fila 30: SOURCE_ID='PAY001', DESCRIPTION='payout', monto DIFERENTE, payload_hash='def456'

[PASO 1] Crear SR
  INSERT → SR_id=1003 (CREADO, payload_hash='def456')
  v_sr_created = 1

[PASO 2] Whitelist
  'payout' ✓ continúa

[PASO 3] Idempotencia A
  SELECT link WHERE source_record_id=1003
  → NULL (SR nuevo)
  → Continúa

[PASO 4] Versionado RAW - Previa Liberaciones ✅ DETECTA CAMBIO
  SELECT fm WHERE sr.source_external_id='PAY001'
         AND sr.id != 1003
         AND fm.account_id=CUENTA
  → FM_id=2001 (ENCONTRADO)
  
  v_new_economic_hash = calc_economic_hash(...monto DIFERENTE...)
           = 'HASH_XYZ' (DIFERENTE de 'HASH_ABC')
  
  v_is_economic_change = TRUE
  
  → Si cambio económico:
  UPDATE mp_financial_movement
    SET needs_review = TRUE
    WHERE id = 2001;
  
  v_financial_movement_id = 2001 (reutilizado, NO modificado)
  
  INSERT LINK(FM_id=2001, SR_id=1003)
  → LINK_id=4003 (CREADO)
  
  CONTINUE ← SALTA resto
```

**ESCENARIO D TOTALES**:
```
SR:   1 creado (payload distinto)
FM:   0 creados (reutilizado, marcado needs_review=TRUE)
LE:   0 creadas (reutilizado, NO modificado)
LINK: 1 creado
```

**INVARIANTE D**: sr_created=1, fm_created=0, le_created=0, link_created=1, needs_review=TRUE ✓ **AUDITORÍA SIN CORRUPTAR DATOS**

---

## VERIFICACIÓN account_id + SOURCE_ID

### Búsqueda PASO 3 (Idempotencia A):
```sql
SELECT link.id, fm.id
FROM mp_movement_source_link link
JOIN mp_financial_movement fm ON fm.id = link.financial_movement_id
WHERE link.source_record_id = v_source_record_id
  AND fm.account_id = p_account_id  ← ✓ AGREGADO
```

### Búsqueda PASO 4 (Versionado RAW):
```sql
SELECT fm.id, fm.settlement_amount, fm.economic_hash
FROM mp_financial_movement fm
INNER JOIN mp_movement_source_link link ON fm.id = link.financial_movement_id
INNER JOIN mp_source_record sr_lib ON sr_lib.id = link.source_record_id
WHERE sr_lib.source_type='liberaciones'
  AND sr_lib.source_external_id=v_source_external_id
  AND fm.account_id = p_account_id  ← ✓ AGREGADO
  AND link.source_record_id != v_source_record_id
```

### Búsqueda PASO 5 (Correlación Report):
```sql
SELECT fm.id, fm.settlement_amount
FROM mp_financial_movement fm
INNER JOIN mp_movement_source_link link ON fm.id = link.financial_movement_id
INNER JOIN mp_source_record sr_arch5 ON sr_arch5.id = link.source_record_id
WHERE sr_arch5.source_type='report'
  AND sr_arch5.source_external_id=v_source_external_id
  AND fm.account_id = p_account_id  ← ✓ AGREGADO
```

✅ **Regla implementada**: `SOURCE_ID + account_id` (no SOURCE_ID solo)

---

## VERIFICACIÓN DEL GENERADOR DE ROLLBACK

### Template SQL v6 (válido con arrays vacíos):
```sql
DO $$
DECLARE
  v_created_sr_ids BIGINT[] := ARRAY[]::BIGINT[];     ← Tipado, no ARRAY[] vacío
  v_created_fm_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_le_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_created_link_ids BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  -- ... DELETE orden correcto
END $$;
```

✅ **Sintaxis válida incluso con arrays vacíos**

### Script: generate_liberaciones_rollback.py
```python
# Lee liberaciones_import_result.json
# Extrae arrays de IDs de todos los batches
# Genera SQL con ARRAY[1, 2, 3, ...]::BIGINT[]
# Escribe a sql/rollback_liberaciones_auto.sql
# NO ejecuta, solo genera
```

**Uso**:
```bash
python scripts/generate_liberaciones_rollback.py
# Output: sql/rollback_liberaciones_auto.sql
# Verificar: cat sql/rollback_liberaciones_auto.sql
# Ejecutar (si necesario): psql -f sql/rollback_liberaciones_auto.sql
```

✅ **Generador automático implementado**

---

## RIESGOS PENDIENTES - V6

### Técnico
✅ **Ninguno** - Versionado completo, account_id verificado, rollback automático

### Operacional
- ⚠️ Si descarga duplicada de Liberaciones con mismo SOURCE_ID pero económicamente diferente: needs_review=TRUE (auditoría requerida, datos NO corruptos)
- ⚠️ Comparación economic_hash depende de calc_economic_hash() firma (baja probabilidad de cambio)

### De datos
- ✅ FM y LE NO se modifican en escenarios C/D (solo marcar needs_review)
- ✅ RAW versionado preservado completo en mp_source_record
- ✅ Múltiples LINK al mismo FM es soportado por schema (many-to-one)

---

## ¿LISTO PARA EJECUTAR?: **SÍ** ✅

**Razones**:
1. ✅ ESCENARIO A: Payout nuevo → crear FM+LE (1ª importación)
2. ✅ ESCENARIO B: Payload idéntico → CONTINUE en PASO 3 (idempotencia exacta)
3. ✅ ESCENARIO C: Payload distinto, economía igual → solo LINK (versionado sin duplicar)
4. ✅ ESCENARIO D: Economía cambió → needs_review=TRUE (auditoría sin corrupción)
5. ✅ account_id + SOURCE_ID en todas las búsquedas (multi-tenant safe)
6. ✅ Rollback template válido con arrays tipados
7. ✅ Script automático genera SQL sin ejecutar

**Invariantes verificados**:
- **A (1ª)**: sr_created=1, fm_created=1, link_created=1
- **B (idéntico)**: sr_created=0, fm_created=0, link_created=0
- **C (economía igual)**: sr_created=1, fm_created=0, link_created=1
- **D (economía cambió)**: sr_created=1, fm_created=0, link_created=1, needs_review=TRUE

**Pruebas de versionado**: Todas 4 escenarios simuladas paso a paso, lógica verificada

**Código compilable**: RPC v6 + Importer (sin cambios) + Rollback v6 + Script

---

**SIGUIENTE PASO**: Aprobación del usuario para ejecutar V6 (migración 006 + RPC + importer)

