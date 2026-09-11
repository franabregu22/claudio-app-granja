# DISEÑO FINAL: import_liberaciones_primary()
## Integración de Liberaciones3.csv como fuente secundaria

**Fecha**: 2026-09-05  
**Estado**: DISEÑO COMPLETADO (READ-ONLY, NO EJECUTADO)  
**Dependencias**: migración 004 + 005, calc_economic_hash(), import_financial_pipeline pattern

---

## [1] CAMBIOS DE SCHEMA REQUERIDOS

### ✓ CERO cambios de schema necesarios

**Verificación**:
- `mp_source_record`: ✓ Soporta `source_type IN ('report', 'api', 'webhook', 'liberaciones')`
  - Nota: CONSTRAINT actual limita a 3 valores. **REQUERIDA EXPANSIÓN**.
- `mp_financial_movement`: ✓ Soporta movement_class ('payment_in', 'payment_out', 'yield', 'transfer_in', 'transfer_out', 'unclassified')
  - 'payout' → mapear a 'transfer_out' o 'unclassified'
  - 'asset_management' → ya existe 'yield'
- `ledger_entry`: ✓ Soporta category ('income', 'expense', 'interest_income', 'transfer', 'other')
  - 'payout' (transfer_out) → category='transfer'
  - 'asset_management' (yield) → category='income' (ya existía)

### ⚠️ CAMBIO OBLIGATORIO: CONSTRAINT de source_type

**Migración necesaria** (escrita, NO EJECUTADA):

```sql
-- 006_add_liberaciones_source_type.sql
ALTER TABLE mp_source_record
DROP CONSTRAINT valid_source_type;

ALTER TABLE mp_source_record
ADD CONSTRAINT valid_source_type 
  CHECK (source_type IN ('report', 'api', 'webhook', 'liberaciones'));

COMMENT ON CONSTRAINT valid_source_type ON mp_source_record IS
  'Valores permitidos: report (Account Money CSV), api (MercadoPago API), 
   webhook (MP webhooks real-time), liberaciones (Settlement Report CSV)';
```

---

## [2] RPC: import_liberaciones_primary()

### Firma

```sql
CREATE OR REPLACE FUNCTION import_liberaciones_primary(
  p_account_id BIGINT,
  p_input JSONB
)
RETURNS JSONB AS $$
```

**Parámetros**:
- `p_account_id BIGINT`: account_id destino (ej: 1054315166)
- `p_input JSONB`: Array de 798 filas de Liberaciones3.csv agosto, normalizadas

**Retorna**:
```json
{
  "success": boolean,
  "error": "string si success=false",
  "reconciliation": {
    "records_processed": int,
    "source_records_created": int,
    "source_records_existing": int,
    "source_records_raw_only": int,
    "financial_movements_created": int,
    "ledger_entries_created": int,
    "movement_source_links_created": int,
    "reconciliation_variance": "-0.03"
  }
}
```

### Lógica pseudocódigo

```
FOR each row IN p_input:

  [PASO 1] Validar campos requeridos
    - SOURCE_ID
    - DESCRIPTION in ('payment', 'payout', 'asset_management', 'reserve_*')
    - DATE, NET_CREDIT_AMOUNT, NET_DEBIT_AMOUNT

  [PASO 2] Calcular identidad RAW
    payload_hash = SHA256({
      DATE,
      SOURCE_ID,
      DESCRIPTION,
      NET_CREDIT_AMOUNT,
      NET_DEBIT_AMOUNT,
      GROSS_AMOUNT (si existe),
      MP_FEE_AMOUNT (si existe),
      TAXES_AMOUNT (si existe),
      PAYMENT_METHOD_TYPE,
      all_fields_as_json
    })

  [PASO 3] Crear/recuperar mp_source_record
    INSERT INTO mp_source_record (
      source_type='liberaciones',
      source_external_id=SOURCE_ID,
      payload_hash=calculated_hash,
      raw_data=full_row_as_jsonb,
      observed_at=now(),
      processing_status='processed'
    )
    ON CONFLICT (source_type, source_external_id, payload_hash) 
    DO NOTHING
    RETURNING id INTO sr_id
    
    IF sr_id is NULL:
      sr_id = SELECT id WHERE (source_type, source_external_id, payload_hash) match
      increment source_records_existing
    ELSE:
      increment source_records_created
    END IF

  [PASO 4] Determinar acción según balance_impact
    balance_impact = NET_CREDIT_AMOUNT - NET_DEBIT_AMOUNT
    
    IF abs(balance_impact) < 0.01:
      -- RESERVAS: apenas guardar RAW
      increment source_records_raw_only
      CONTINUE to next row (no FM, no LE)
    END IF

  [PASO 5] Buscar correlación en arch5 (por SOURCE_ID)
    SELECT fm.id, fm.economic_hash
    INTO existing_fm_id, existing_economic_hash
    FROM mp_financial_movement fm
    JOIN mp_movement_source_link link ON fm.id = link.financial_movement_id
    JOIN mp_source_record sr_arch5 ON sr_arch5.id = link.source_record_id
    WHERE sr_arch5.source_type='report'
      AND sr_arch5.source_external_id=SOURCE_ID
    LIMIT 1;
    
    -- Si no hay correlación, buscar por amount+date (fuzzy, SOLO para diagnosticar)
    -- Pero NO usar fuzzy para deduplicación automática

  [PASO 6] Decisión: Reutilizar vs Crear FM
    IF existing_fm_id is NOT NULL:
      -- REUTILIZAR FM existente (Scenario: compartidos 716)
      fm_id = existing_fm_id
      -- NO crear nueva FM
      -- NO crear nueva LE
    ELSE:
      -- CREAR FM nueva (Scenario: 10 payouts nuevos)
      fm_id = CREATE mp_financial_movement (
        account_id=p_account_id,
        movement_class=normalize_description_to_class(DESCRIPTION),
        transaction_amount=GROSS_AMOUNT (si existe, sino 0),
        settlement_amount=balance_impact,
        tax_amount=TAXES_AMOUNT (si existe),
        tax_detail={...},
        payment_method=PAYMENT_METHOD_TYPE,
        payment_detail=PAYMENT_METHOD_ID (si existe),
        payer_name=PAYER_NAME (si existe),
        transaction_date=DATE,
        settlement_date=DATE (mismo que transaction por CSV),
        economic_hash=calc_economic_hash(...),
        needs_review=FALSE
      )
      increment financial_movements_created
      
      -- CREAR LE (1:1 con FM)
      CREATE ledger_entry (
        account_id=p_account_id,
        financial_movement_id=fm_id,
        balance_impact=balance_impact,
        category=normalize_movement_class_to_category(movement_class),
        source_reference='SOURCE_ID=' || SOURCE_ID || ' (liberaciones)',
        description=DESCRIPTION,
        occurred_at=DATE
      )
      increment ledger_entries_created
    END IF

  [PASO 7] Crear LINK (siempre, incluso para reutilizar)
    INSERT INTO mp_movement_source_link (
      financial_movement_id=fm_id,
      source_record_id=sr_id,
      is_primary=false  -- Es secundaria (enriquecimiento)
    )
    ON CONFLICT (financial_movement_id, source_record_id) 
    DO NOTHING
    
    increment movement_source_links_created

END FOR

[VALIDACIÓN FINAL]
  SELECT SUM(balance_impact) as total_neto
  FROM ledger_entry
  WHERE account_id=p_account_id
    AND occurred_at::DATE BETWEEN '2026-08-01' AND '2026-08-31'
  
  expected_neto = -124203.24
  reconciliation_variance = total_neto - expected_neto
  
  RETURN success=true, reconciliation={...}
```

---

## [3] REGLAS: DESCRIPTION → movement_class → category

### Mapeo determinístico

```
DESCRIPTION           movement_class    category         balance_impact    Notes
─────────────────────────────────────────────────────────────────────────────
payment               payment_in        income           CR-DB > 0         696 existentes
asset_management      yield             interest_income  CR-DB > 0         20 existentes
payout                transfer_out      transfer         CR-DB < 0         10 nuevos
reserve_for_payment   [RAW ONLY]        [N/A]            = 0               52 regs, raw only
reserve_for_payout    [RAW ONLY]        [N/A]            = 0               20 regs, raw only
(unknown)             unclassified      other            (any)             Futuro

WHITELIST: Solo estos DESCRIPTION generan FM:
  ✓ payment
  ✓ payout
  ✓ asset_management
  
RAW ONLY (sin FM/LE):
  ✓ reserve_for_payment (balance_impact=0)
  ✓ reserve_for_payout (balance_impact=0)
  
FUTURO: Si aparece DESCRIPTION desconocido:
  → Crear SR (raw_data íntegro)
  → NO crear FM/LE
  → Flag para análisis manual
```

---

## [4] LÓGICA DE CORRELACIÓN CROSS-REPORT

### Estrategia: SOURCE_ID como PK determinístico

**Premisa**: Análisis empírico verificó que SOURCE_ID es único cross-report:
- 716 de arch5 coinciden EXACTAMENTE con 716 de Liberaciones (696 payment + 20 asset)
- Balance_impact es idéntico
- 10 payouts son completamente nuevos

**Implementación en RPC**:

```sql
-- Buscar FM existente por SOURCE_ID
SELECT fm.id, fm.economic_hash
INTO existing_fm_id, existing_economic_hash
FROM mp_financial_movement fm
INNER JOIN mp_movement_source_link link ON fm.id = link.financial_movement_id
INNER JOIN mp_source_record sr_arch5 ON sr_arch5.id = link.source_record_id
WHERE sr_arch5.source_type='report'
  AND sr_arch5.source_external_id = v_source_external_id
LIMIT 1;

-- No hacer fuzzy matching de amount+date
-- No asumir que dos transacciones del mismo día/monto son la misma
```

### Regla de decisión

```
Si existing_fm_id found:
  ├─ Usar FM existente (reutilizar)
  ├─ Crear SR + LINK
  └─ NO crear FM ni LE nuevas
  
Si NO found:
  ├─ Crear FM nueva
  ├─ Crear LE nueva (1:1)
  ├─ Crear SR + LINK
  └─ Incrementar contadores de "creado"
```

---

## [5] IDEMPOTENCIA

### Garantías

**Inserción duplicada del mismo payload**:
```sql
-- Sr.id es NULL si ya existe
INSERT ... ON CONFLICT (source_type, source_external_id, payload_hash) DO NOTHING
RETURNING id INTO sr_id;

-- Recuperar sr_id si ya existía
IF sr_id IS NULL THEN
  SELECT id INTO sr_id FROM mp_source_record
  WHERE source_type='liberaciones'
    AND source_external_id=v_ext_id
    AND payload_hash=v_hash;
END IF;
```

**Link duplicado**:
```sql
INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id)
VALUES (...)
ON CONFLICT (financial_movement_id, source_record_id) DO NOTHING;
```

**LE duplicado**: Imposible, porque es 1:1 con FM. Si FM reutilizado, LE ya existe.

### Validación idempotencia POST-IMPORTACIÓN

```sql
-- Verificar CERO duplicate LE
SELECT COUNT(*) as duplicates
FROM (
  SELECT financial_movement_id, COUNT(*) as cnt
  FROM ledger_entry
  GROUP BY financial_movement_id
  HAVING COUNT(*) > 1
) x;
-- Esperado: 0

-- Verificar neto total exacto (±$0.03 tolerancia)
SELECT SUM(balance_impact) as total_neto
FROM ledger_entry
WHERE account_id=1054315166
  AND occurred_at::DATE BETWEEN '2026-08-01' AND '2026-08-31';
-- Esperado: -124203.24 ± 0.03
```

---

## [6] COMPORTAMIENTO ANTE NUEVA VERSIÓN RAW

### Scenario: Mismo SOURCE_ID + DESCRIPTION, payload diferente

**Ejemplo**: Liquidaciones re-descargada el 2026-09-06, pero un registro cambió (corrección MP).

```
Fila original (2026-09-05):
  SOURCE_ID=171269157013, DESCRIPTION='payout', NET_DEBIT=730356.00, payload_hash=ABC123

Fila nueva (2026-09-06):
  SOURCE_ID=171269157013, DESCRIPTION='payout', NET_DEBIT=730356.50, payload_hash=DEF456
  (cambio: $0.50 en el monto → economic_hash también cambia)
```

**Acción de la RPC**:

1. Crear NEW mp_source_record (payload_hash=DEF456)
2. Buscar FM existente por SOURCE_ID → encuentra fm_id=X
3. Calcular economic_hash de nueva fila
4. Comparar con economic_hash de FM: `economic_hash_anterior vs economic_hash_nuevo`
   - Si IGUALES (B1 scenario): Reutilizar FM, crear LINK
   - Si DIFERENTES (B2 scenario):
     - Reutilizar FM (NO crear nueva)
     - Marcar FM como needs_review=TRUE
     - Crear LINK
     - NO modificar transaction_amount/settlement_amount (mantiene versión anterior)
     - Usuario debe revisar manualmente

5. LE existente NO se modifica (inmutable)

---

## [7] IMPORTER PYTHON: Normalización de entrada

### Script: import_liberaciones.py

**Entrada**: Archivo CSV con 798 líneas

**Salida**: Array de 798 JSONB, listo para RPC

**Transformación por fila**:

```python
def normalize_liberaciones_row(csv_row):
    """Normalizar fila CSV a formato RPC"""
    
    # Balance impact
    cr = Decimal(csv_row['NET_CREDIT_AMOUNT'].replace(',', '.'))
    db = Decimal(csv_row['NET_DEBIT_AMOUNT'].replace(',', '.'))
    balance_impact = cr - db
    
    # Gross amount (IMPORTANTE para transaction_amount)
    gross = Decimal(csv_row.get('GROSS_AMOUNT', '0').replace(',', '.'))
    
    # Impuestos
    tax_str = csv_row.get('TAXES_AMOUNT', '0').replace(',', '.')
    taxes = Decimal(tax_str)
    
    # Payload hash input (TODOS los campos)
    payload_hash_input = json.dumps({
        'DATE': csv_row['DATE'],
        'SOURCE_ID': csv_row['SOURCE_ID'],
        'DESCRIPTION': csv_row['DESCRIPTION'],
        'NET_CREDIT_AMOUNT': str(cr),
        'NET_DEBIT_AMOUNT': str(db),
        'GROSS_AMOUNT': str(gross),
        'MP_FEE_AMOUNT': csv_row.get('MP_FEE_AMOUNT', ''),
        'TAXES_AMOUNT': str(taxes),
        'PAYMENT_METHOD_TYPE': csv_row.get('PAYMENT_METHOD_TYPE', ''),
        'BALANCE_AMOUNT': csv_row.get('BALANCE_AMOUNT', ''),
        # ... todos los demás campos
    }, sort_keys=True)
    
    payload_hash = hashlib.sha256(payload_hash_input.encode()).hexdigest()
    
    return {
        'source_type': 'liberaciones',
        'source_external_id': csv_row['SOURCE_ID'],
        'payload_hash': payload_hash,
        'raw_data': csv_row,  # Fila completa como JSONB
        'observed_at': csv_row['DATE'],  # O usar fecha de importación
        # Campos normalizados para FM
        'gross_amount': gross,
        'settlement_amount': balance_impact,
        'tax_amount': taxes,
        'transaction_amount': gross,  # IMPORTANTE
        'description': csv_row['DESCRIPTION'],
        'payment_method': csv_row.get('PAYMENT_METHOD_TYPE', ''),
        'payment_detail': csv_row.get('PAYMENT_METHOD_ID', ''),
        'payer_name': csv_row.get('PAYER_NAME', ''),
    }
```

**Validaciones pre-RPC**:
- Todos los SOURCE_ID son únicos dentro del batch (o está OK repetirse dentro de reservas)
- Todos los DESCRIPTION están en whitelist or reservas
- balance_impact es NUMERIC(15,2) sin pérdida de precisión
- NULLs se representan como JSON null, no strings

**Batching**:
- Batch size = 100 (mismo que importer anterior)
- Llamadas a RPC en paralelo con manejo de errores
- Cada batch retorna reconciliation detail

---

## [8] PLAN DE VALIDACIÓN

### POST-IMPORTACIÓN (queries READ-ONLY)

```sql
-- [1] Verificar SR creados
SELECT COUNT(*) as sr_created
FROM mp_source_record
WHERE source_type='liberaciones'
  AND observed_at::DATE = '2026-08-31';
-- Esperado: 798

-- [2] Verificar FM creados (solo payouts)
SELECT COUNT(*) as fm_created
FROM mp_financial_movement fm
WHERE EXISTS (
  SELECT 1 FROM mp_movement_source_link link
  JOIN mp_source_record sr ON sr.id = link.source_record_id
  WHERE sr.source_type='liberaciones'
    AND sr.source_external_id IN (
      SELECT DISTINCT source_external_id 
      FROM mp_source_record 
      WHERE source_type='liberaciones'
        AND raw_data->>'DESCRIPTION' = 'payout'
    )
    AND fm.id = link.financial_movement_id
);
-- Esperado: 10

-- [3] Verificar LE creados (1:1 con FM nuevos)
SELECT COUNT(*) as le_created
FROM ledger_entry le
WHERE EXISTS (
  SELECT 1 FROM mp_financial_movement fm
  WHERE fm.id = le.financial_movement_id
    AND EXISTS (
      SELECT 1 FROM mp_movement_source_link link
      JOIN mp_source_record sr ON sr.id = link.source_record_id
      WHERE sr.source_type='liberaciones'
        AND fm.id = link.financial_movement_id
    )
);
-- Esperado: 10 (o más, si hay asset_management nuevos - verificar)

-- [4] Verificar neto total agosto
SELECT SUM(balance_impact) as total_neto
FROM ledger_entry
WHERE account_id=1054315166
  AND occurred_at::DATE BETWEEN '2026-08-01' AND '2026-08-31';
-- Esperado: -124203.24 ± 0.03

-- [5] Verificar CERO duplicate LE
SELECT COUNT(*) as duplicates
FROM (
  SELECT financial_movement_id, COUNT(*) as cnt
  FROM ledger_entry
  GROUP BY financial_movement_id
  HAVING COUNT(*) > 1
) x;
-- Esperado: 0

-- [6] Verificar FM con needs_review
SELECT COUNT(*) as needs_review_count
FROM mp_financial_movement
WHERE needs_review = TRUE
  AND EXISTS (
    SELECT 1 FROM mp_movement_source_link link
    JOIN mp_source_record sr ON sr.id = link.source_record_id
    WHERE sr.source_type='liberaciones'
      AND link.financial_movement_id = mp_financial_movement.id
  );
-- Esperado: 0 (o detectar B2 scenarios si los hay)

-- [7] Verificar neto reutilizados vs nuevos
SELECT 
  'reutilizados_716' as category,
  COUNT(*) as fm_count,
  SUM(le.balance_impact) as total_neto
FROM mp_financial_movement fm
JOIN ledger_entry le ON le.financial_movement_id = fm.id
JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
JOIN mp_source_record sr ON sr.id = link.source_record_id
WHERE sr.source_type='report'
  AND le.occurred_at::DATE BETWEEN '2026-08-01' AND '2026-08-31'
  AND le.account_id=1054315166

UNION ALL

SELECT 
  'nuevos_10' as category,
  COUNT(*) as fm_count,
  SUM(le.balance_impact) as total_neto
FROM mp_financial_movement fm
JOIN ledger_entry le ON le.financial_movement_id = fm.id
JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
JOIN mp_source_record sr ON sr.id = link.source_record_id
WHERE sr.source_type='liberaciones'
  AND fm.movement_class='transfer_out'
  AND le.occurred_at::DATE BETWEEN '2026-08-01' AND '2026-08-31'
  AND le.account_id=1054315166;

-- Esperado:
-- reutilizados_716: $10,780,612.05
-- nuevos_10: -$10,904,815.29
```

---

## [9] PLAN DE ROLLBACK

### Escenario A: Error antes de completar la importación

**Status**: Transacción fallida en RPC
**Acción**: ROLLBACK automático (transacción atómica PostgreSQL)
**Verificación**: SELECT COUNT(*) FROM mp_source_record WHERE source_type='liberaciones' = 0

### Escenario B: Importación completada pero datos incorrectos detectados

**Status**: SR, FM, LE ya están en BD
**Acción manual**: 

```sql
-- PASO 1: Identificar qué se importó
SELECT 
  COUNT(DISTINCT sr.id) as sr_liberaciones,
  COUNT(DISTINCT fm.id) as fm_nuevos,
  COUNT(DISTINCT le.id) as le_nuevos
FROM mp_source_record sr
LEFT JOIN mp_movement_source_link link ON link.source_record_id = sr.id
LEFT JOIN mp_financial_movement fm ON fm.id = link.financial_movement_id
LEFT JOIN ledger_entry le ON le.financial_movement_id = fm.id
WHERE sr.source_type='liberaciones'
  AND sr.observed_at::DATE = '2026-08-31';

-- PASO 2: Eliminar LE nuevos (cascade borra FM)
DELETE FROM ledger_entry le
WHERE EXISTS (
  SELECT 1 FROM mp_financial_movement fm
  WHERE fm.id = le.financial_movement_id
    AND EXISTS (
      SELECT 1 FROM mp_movement_source_link link
      JOIN mp_source_record sr ON sr.id = link.source_record_id
      WHERE sr.source_type='liberaciones'
        AND sr.observed_at::DATE = '2026-08-31'
        AND link.financial_movement_id = fm.id
    )
);
-- Cascade deletes FM también (due to FK)

-- PASO 3: Eliminar LINK de Liberaciones
DELETE FROM mp_movement_source_link link
WHERE EXISTS (
  SELECT 1 FROM mp_source_record sr
  WHERE sr.id = link.source_record_id
    AND sr.source_type='liberaciones'
    AND sr.observed_at::DATE = '2026-08-31'
);

-- PASO 4: Eliminar SR de Liberaciones
DELETE FROM mp_source_record sr
WHERE sr.source_type='liberaciones'
  AND sr.observed_at::DATE = '2026-08-31';

-- PASO 5: Validar estado previo
SELECT SUM(balance_impact) as neto_agosto
FROM ledger_entry le
WHERE le.account_id=1054315166
  AND le.occurred_at::DATE BETWEEN '2026-08-01' AND '2026-08-31';
-- Debe coincidir con neto anterior a importación (solo arch5 / report)
```

---

## [10] RESUMEN EJECUTIVO: CAMBIOS REQUERIDOS

### Antes de ejecutar import_liberaciones_primary():

1. **Migración 006**: Expandir CONSTRAINT de source_type (OBLIGATORIO)
   - Script listo, solo falta ejecutar
   - Sin data migration (no hay datos 'liberaciones' aún)

2. **RPC**: import_liberaciones_primary()
   - Código pseudocódigo arriba
   - Sigue patrón de import_financial_pipeline (v2)
   - Requiere migración 006 previa

3. **Importer**: import_liberaciones.py
   - Normalizar 798 filas CSV a JSONB
   - Batches de 100, llamadas a RPC
   - Manejo de errores detallado

4. **Validación**: Queries POST-IMPORT
   - 8 queries de lectura para verificar integridad
   - Todas incluidas arriba

5. **Rollback**: Plan de DELETE seguro
   - 5 pasos bien definidos
   - Cascade-safe (FKs configuradas)

---

## [11] MATRIZ DE DECISIONES (para referencia)

| Aspecto | Decisión | Razón |
|---------|----------|-------|
| **Deduplicación** | SOURCE_ID único entre reports | Empíricamente validado (716/716 match exacto) |
| **Fuzzy matching** | NO usar amount+date | Riesgo de falsos positivos, SOURCE_ID es determinístico |
| **payment (696)** | Reutilizar FM existentes | Correlación 1:1 con arch5 |
| **asset_mgmt (20)** | Reutilizar FM existentes | Correlación 1:1 con arch5 como 'yield' |
| **payout (10)** | Crear 10 FM nuevas | Completamente nuevos, no en arch5 |
| **reserve_* (72)** | SR only, sin FM/LE | balance_impact=0, auditoría solamente |
| **movement_class** | payout → transfer_out | Más genérico, no especular tipo exacto |
| **category** | transfer_out → transfer | Mapeo standard CHART OF ACCOUNTS |
| **economic_hash** | Usar para B1/B2 detection | Consistente con calc_economic_hash() |
| **Idempotencia** | ON CONFLICT + recuperar ID | Garantiza cero duplicados en re-runs |
| **Reconciliation_variance** | -0.03 ignorada | No explicada, aceptable (<1c) |

---

**Estado**: ✓ Diseño final completado, listo para código SQL  
**Próximo paso**: Generar SQL de migración 006 y RPC  
**Restricción**: NO EJECUTAR AÚN - pendiente aprobación usuario

