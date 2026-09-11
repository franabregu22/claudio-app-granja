# ANÁLISIS SCHEMA REAL vs RPC V8

## SCHEMA REAL VERIFICADO

### mp_source_record (SIN account_id)
```
id BIGSERIAL PK
source_type VARCHAR(20) NOT NULL
source_external_id VARCHAR(100) NOT NULL
payload_hash VARCHAR(64) NOT NULL
raw_data JSONB NOT NULL
observed_at TIMESTAMP WITH TIME ZONE NOT NULL
received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
processing_status VARCHAR(20) DEFAULT 'pending'
processing_error TEXT

UNIQUE(source_type, source_external_id, payload_hash)
CHECK source_type IN ('report', 'api', 'webhook', 'liberaciones') [after 006]
```

### mp_financial_movement (SIN ledger_entry_id)
```
id BIGSERIAL PK
account_id BIGINT NOT NULL
movement_class VARCHAR(30) NOT NULL
transaction_amount DECIMAL(15,2)
settlement_amount DECIMAL(15,2) NOT NULL
tax_amount DECIMAL(15,2)
tax_detail JSONB
tax_percentage DECIMAL(5,4)
payment_method VARCHAR(30)
payment_detail VARCHAR(50)
payer_name VARCHAR(255)
payer_id_type VARCHAR(20)
payer_id_number VARCHAR(20)
transaction_date TIMESTAMP WITH TIME ZONE NOT NULL
settlement_date TIMESTAMP WITH TIME ZONE
normalized_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
order_id VARCHAR(30)
external_reference VARCHAR(255)
bank_transfer_id VARCHAR(30)
needs_review BOOLEAN NOT NULL DEFAULT FALSE [from 005]
economic_hash VARCHAR(64) [from 005]
```

### mp_movement_source_link
```
id BIGSERIAL PK
financial_movement_id BIGINT NOT NULL FK → mp_financial_movement(id)
source_record_id BIGINT NOT NULL FK → mp_source_record(id)
is_primary BOOLEAN DEFAULT FALSE
linked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()

UNIQUE(financial_movement_id, source_record_id)
```

### ledger_entry (1:1 con FM obligatorio)
```
id BIGSERIAL PK
account_id BIGINT NOT NULL
financial_movement_id BIGINT NOT NULL UNIQUE (← 1:1 forzado)
balance_impact DECIMAL(15,2) NOT NULL
category VARCHAR(30) NOT NULL
source_reference VARCHAR(100)
description VARCHAR(255)
observation TEXT
occurred_at TIMESTAMP WITH TIME ZONE NOT NULL
recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()

FK financial_movement_id → mp_financial_movement(id)
```

---

## INCOMPATIBILIDADES RPC V8 vs SCHEMA REAL

### CRÍTICAS (bloquean ejecución)

| # | Área | V8 asume | Schema real | Impacto |
|---|------|----------|------------|---------|
| 1 | mp_source_record | INSERT account_id | NO existe account_id | **ERROR: column does not exist** |
| 2 | mp_financial_movement | INSERT... SET ledger_entry_id | NO existe ledger_entry_id | **ERROR: column does not exist** |
| 3 | ledger_entry | 1:1 relación flexible | UNIQUE(financial_movement_id) forzado | **Must create LE per FM, no multiples** |

### ARQUITECTURA (lógica incorrecta)

| # | Área | V8 asume | Schema real | Impacto |
|---|------|----------|------------|---------|
| 4 | correlation | Buscar FM sin ledger_entry | ledger_entry UNIQUE forzado | **Si FM existe → LE existe, si no ambos faltan** |
| 5 | economic_hash | calc_liberaciones_economic_hash() | calc_economic_hash() en mp_financial_movement | **Función diferente, parámetros distintos** |
| 6 | is_primary | V8 no lo usa | mp_movement_source_link.is_primary existe | **Should mark primary source, currently ignored** |
| 7 | settlement_amount | V8 lo inserta como balance_impact | Schema real: settlement_amount en FM, LE.balance_impact debe coincidir | **Orden: FM.settlement_amount → LE.balance_impact** |

### MENORES (refinemientos)

| # | Área | V8 asume | Schema real | Impacto |
|---|------|----------|------------|---------|
| 8 | FK order | LE → LINK → FM → SR | Correct order exist | **OK si se sigue strictly** |
| 9 | observed_at | V8 usa NOW() | Schema: observed_at = transaction_date de CSV | **Should use transaction_date from payload, not NOW()** |
| 10 | processing_status | V8 ignora | Schema: processing_status field exists | **Could track status, currently unused** |

---

## REGLAS CORRECTAS PARA CADA TABLA

### mp_source_record
- **INSERT sin account_id** (no pertenece aquí)
- **Deduplicación real:** UNIQUE(source_type, source_external_id, payload_hash)
- **ON CONFLICT DO NOTHING:** si payload idéntico, retrieve existing ID
- **Versionado:** mismo SOURCE_ID + diferente payload_hash = fila nueva (diferente hash)
- **observed_at:** usar transaction_date del payload, NO NOW()
- **raw_data:** preservar exacto (mayúsculas originales)

### mp_financial_movement
- **INSERT SIN ledger_entry_id** (relación inversa: LE vinculada A FM, no FM vinculada A LE)
- **settlement_amount:** obligatorio (DECIMAL 15,2 exacto)
- **account_id:** obligatorio, proviene del parámetro p_account_id
- **movement_class:** determina por DESCRIPTION whitelist
- **economic_hash:** calcular con calc_economic_hash() (NO calc_liberaciones_economic_hash)
- **needs_review:** TRUE si economic_hash del nuevo SR difiere del FM.economic_hash
- **Relación con LE:** después INSERT FM, CREATE ledger_entry vinculada a este FM.id

### mp_movement_source_link
- **INSERT después de tener FM.id**
- **is_primary:** marcar TRUE si este SR fue el principal para normalizar FM (primera vez, payout nuevo)
- **UNIQUE(financial_movement_id, source_record_id):** impedir duplicación de LINK
- **Relación many-to-one:** múltiples SRs (misma Liberación en diferentes versiones) → 1 FM

### ledger_entry
- **1:1 FORZADO:** UNIQUE(financial_movement_id) → una LE per FM, no múltiples
- **balance_impact:** = FM.settlement_amount (ambos DECIMAL 15,2 exacto)
- **occurred_at:** = FM.transaction_date
- **category:** determinar por FM.movement_class o SM.description
- **INSERT después de FM creado**
- **FK financial_movement_id:** cascada DELETE OK
- **account_id:** = p_account_id (replicado en LE por desnormalización)

---

## FLOW CORRECTO PARA LIBERACIONES

```
PARA CADA REGISTRO LIBERACIÓN:

PASO 1: SR — INSERT mp_source_record
  - (source_type='liberaciones', source_external_id, payload_hash, raw_data, observed_at)
  - ON CONFLICT (type, id, hash) DO NOTHING
  - RETRIEVE sr.id (existing o new)

PASO 2: WHITELIST
  - IF description IN ('reserve_for_payment', 'reserve_for_payout') → RAW-only, CONTINUE
  - IF description NOT IN ('payment', 'asset_management', 'payout') → RAW-only, CONTINUE
  - (defensivamente ignorar unknown types)

PASO 3: IDEMPOTENCIA
  - SELECT link WHERE source_record_id=sr.id
  - IF link EXISTS → CONTINUE (ya fue procesado)

PASO 4: VERSIONADO
  - SELECT sr previo (same source_external_id, different sr.id)
  - IF existe previous: comparar economic_hash (si tiene FM previamente vinculado)
  - IF economic cambió: UPDATE FM.needs_review=TRUE

PASO 5: CORRELACIÓN (solo para payment/asset_management)
  - Buscar FM existente (source_type='report')
  - WHERE FM.settlement_amount = balance_impact_liberación
  - AND existe LE vinculada (LE.balance_impact = settlement_amount)
  - Si encontró: use_fm = FM.id

PASO 6: DECIDIR
  - IF use_fm IS NOT NULL → reutilizar FM existente
  - ELSIF description IN ('payment', 'asset_management') → ERROR (debe tener report correlation)
  - ELSE (payout) → crear FM nuevo + LE

PASO 7: CREAR FM (solo si payout)
  - INSERT mp_financial_movement (account_id, movement_class='unclassified', 
                                  settlement_amount, ...)
  - economic_hash = calc_economic_hash(...)
  - RETRIEVE fm.id

PASO 8: CREAR LE (solo si payout)
  - INSERT ledger_entry (account_id, financial_movement_id=fm.id, 
                         balance_impact=settlement_amount, ...)
  - RETRIEVE le.id

PASO 9: LINK
  - INSERT mp_movement_source_link (financial_movement_id, source_record_id,
                                    is_primary = (TRUE si FM nuevo, FALSE si reutilizado))
  - RETRIEVE link.id

RETORNAR: {sr_created, sr_existing, sr_raw_only, fm_created, le_created, links_created, created_ids}
```

---

## CAMBIOS NECESARIOS

### En Importer (import_liberaciones.py)
- ✅ normalize_row() mantienes como está (keys minúsculas OK)
- ✅ parse_decimal() robusto OK
- ✅ checkpoint por batch OK
- ✓ No cambios críticos requeridos

### En Migraciones
- ✅ 006_add_liberaciones_source_type.sql: OK, ya aplicada
- ✅ 005_add_needs_review.sql: ya existe
- ✅ 004_mp_new_architecture.sql: ya existe
- ✗ NO crear nuevas migraciones si no es crítico

### En RPC
- ✗ RPC V8 incompatible: **RECONSTRUIR completamente**
- ✗ calc_liberaciones_economic_hash() → usar calc_economic_hash() de 005
- ✗ Usar settlement_amount, no account_id en SR
- ✗ Crear LE vinculada a FM, no al revés

---

## RIESGOS PENDIENTES

| Riesgo | Probabilidad | Mitiga |
|--------|------------|--------|
| Duplicate LINK en idempotencia | Bajo | SELECT before INSERT |
| Economic hash diverge | Bajo | Usar calc_economic_hash() consistente |
| payment/asset sin report | Bajo | RAISE EXCEPTION (no continue) |
| observed_at vicio de NOW() | Medio | Usar transaction_date payload |
| LE sin FM (constraint broken) | Bajo | INSERT FM antes que LE, INNER JOIN |

---

## CONCLUSIÓN

**RPC V8 necesita reconstrucción completa:**
- Eliminar account_id de SR
- Usar settlement_amount en FM
- Crear LE con balance_impact = settlement_amount
- Usar calc_economic_hash() (no calc_liberaciones_economic_hash)
- Marcar is_primary en LINK
- Mantener lógica de DESCRIPTION-first, payout, correlación, versionado

**Importer NO requiere cambios** (normalize_row, parse_decimal, checkpoint OK)

**Migraciones NO requieren cambios** (004, 005, 006 ya hechas)

**LISTO PARA RECONSTRUCCIÓN:** SÍ, esquema real documentado

