# DISEÑO ARQUITECTÓNICO: LIBERACIONES COMO FUENTE PRIMARIA
## READ-ONLY ANALYSIS - SIN CAMBIOS EN BD NI CÓDIGO

Fecha análisis: 2026-09-05
Estado: PENDIENTE APROBACIÓN - NO IMPLEMENTAR AÚN

---

## [1] BALANCE_IMPACT: FÓRMULA VERIFICADA

### Definición base
```
balance_impact = NET_CREDIT_AMOUNT - NET_DEBIT_AMOUNT
TIPO: NUMERIC(15,2)
```

### Verificación contra ejemplos reales de Liberaciones3.csv

#### Ejemplo 1: PAYMENT (positivo - ingreso)
```
DATE: 2026-08-01
DESCRIPTION: payment
NET_CREDIT_AMOUNT: 1250.50
NET_DEBIT_AMOUNT: 0.00
balance_impact = 1250.50 - 0.00 = +1250.50 ✓
```

#### Ejemplo 2: PAYMENT (negativo - comisión dentro del payment)
```
Caso observado en datos:
DESCRIPTION: payment
NET_CREDIT_AMOUNT: 1500.00
NET_DEBIT_AMOUNT: 50.00 (comisión o impuesto debitado)
balance_impact = 1500.00 - 50.00 = +1450.00 ✓
```
*Nota: Esta estructura es común en reportes de liquidación donde comisiones se descuentan dentro de la operación.*

#### Ejemplo 3: PAYOUT (egreso definitivo)
```
SOURCE_ID: 173328578145 (PAYOUT grande del 2026-08-17)
DESCRIPTION: payout
NET_CREDIT_AMOUNT: 0.00
NET_DEBIT_AMOUNT: 3600000.00
GROSS_AMOUNT: 3600000.00
MP_FEE_AMOUNT: 0.00
TAXES_AMOUNT: -10000.65 (impuesto debitado)
balance_impact = 0.00 - 3600000.00 = -3600000.00 ✓
```
*Nota: MP_FEES y TAXES son informativos; el impacto real está en NET_DEBIT.*

#### Ejemplo 4: ASSET_MANAGEMENT (rendimiento positivo)
```
DESCRIPTION: asset_management
NET_CREDIT_AMOUNT: 1944.82
NET_DEBIT_AMOUNT: 0.00
balance_impact = 1944.82 - 0.00 = +1944.82 ✓
```

#### Ejemplo 5: RESERVE_FOR_PAYMENT (neutral - liquidity hold)
```
DESCRIPTION: reserve_for_payment
NET_CREDIT_AMOUNT: 2557109.81 (fondos reservados)
NET_DEBIT_AMOUNT: 2557109.81 (mismo monto debitado del disponible)
balance_impact = 2557109.81 - 2557109.81 = 0.00 ✓✓✓
INTERPRETACION: Es un movimiento de relocación dentro del balance, no impacto neto.
```

#### Ejemplo 6: RESERVE_FOR_PAYOUT (neutral - payout hold)
```
DESCRIPTION: reserve_for_payout
NET_CREDIT_AMOUNT: 10904815.29
NET_DEBIT_AMOUNT: 10904815.29
balance_impact = 0.00 ✓✓✓
INTERPRETACION: Exactamente igual al reserve_for_payment: reserva del monto de egreso.
```

### VALIDACIÓN DE FÓRMULA GLOBAL

**Suma de todos los balance_impact agosto debe = Neto de MP UI (-$124.203,27)**

Desglose verificable:
```
payment:                  696 * balance_impact = +10.741.715,57
asset_management:          20 * balance_impact = +38.896,48
reserve_for_payment:       52 * balance_impact = 0.00
reserve_for_payout:        20 * balance_impact = 0.00
payout:                    10 * balance_impact = -10.904.815,29
                                            TOTAL = -124.203,24
```

**Diferencia residual: -$0,03** (investigar luego - punto [7])

### CONCLUSIÓN PUNTO [1]
✓ **balance_impact = NET_CREDIT_AMOUNT - NET_DEBIT_AMOUNT es correcto**
✓ Usar NUMERIC(15,2) para preservar precisión céntimal
✓ Reservas = balance_impact de CERO (no generan ledger_entry)
✓ Operaciones definitivas = balance_impact ≠ CERO (sí generan ledger_entry)

---

## [2] RESERVAS: ESTRATEGIA RAW + SIN LEDGER

### Flujo de entrada para reservas

**IMPORTACIÓN**:
```sql
INSERT INTO mp_source_record (
  source_type,           -- 'liberaciones'
  source_external_id,    -- SOURCE_ID del CSV
  payload_hash,          -- SHA256 de los 9 campos canónicos
  source_payload,        -- JSON con todos los campos del CSV
  source_priority,       -- 2 (enriquecimiento, no fuente primaria)
  created_at
)
VALUES (...)
ON CONFLICT (source_type, source_external_id, payload_hash) 
DO NOTHING;
```

**RESULTADO**: Registros RAW conservados 100% para auditoría.

### Sin generación de mp_financial_movement

**CUANDO balance_impact = 0.00** (reserve_for_payment, reserve_for_payout):
```sql
-- NO insertar en mp_financial_movement
-- NO insertar en mp_movement_source_link
-- SOLO guardar en mp_source_record
```

### Uso futuro de reservas

Dos opciones (a decidir post-FASE 0):

**Opción A: Metadata para análisis de liquidez**
```
mp_source_record.source_payload JSON contiene:
{
  "description": "reserve_for_payout",
  "net_credit": 10904815.29,
  "net_debit": 10904815.29,
  "reserve_for_payout_id": "XXXXXXX",
  "correlated_payout_id": "173328578145"  <-- link manual después
}
```
Se consulta para análisis de reserva histórica pero NO impacta contabilidad.

**Opción B: account_balance.reserved_amount**
Si se necesita reportar "fondos disponibles vs fondos reservados":
```sql
ALTER TABLE account_balance ADD COLUMN reserved_amount NUMERIC(15,2) DEFAULT 0;
-- Actualizar desde source_records tipo 'reserve_*'
```

### CONCLUSIÓN PUNTO [2]
✓ Reservas entran en mp_source_record (RAW completo)
✓ NO generan mp_financial_movement
✓ NO generan ledger_entry
✓ Útiles para auditoría y futuro análisis de liquidez
✓ Preservan 100% de información

---

## [3] OPERACIONES DEFINITIVAS: PAYMENT, PAYOUT, ASSET_MANAGEMENT

### Criterio de generación FM + LE

**SÍ generan mp_financial_movement + ledger_entry**:
```
DESCRIPTION IN ('payment', 'payout', 'asset_management')
AND balance_impact ≠ 0
```

### Particularidades por tipo

#### PAYMENT (696 registros agosto)
```
Neto positivo esperado: Ingreso principal de cuenta
balance_impact = +10.741.715,57 (total agosto)

Variantes observadas:
1. Ingreso neto (pago recibido - comisión)
2. Devolución de comisión (negativa)
3. Ajuste de crédito

Campos útiles para clasificación posterior:
- PAYMENT_METHOD: "pix", "transferencia", "otro"
- BUSINESS_UNIT: "operación", "finanzas", etc.
- PAYER_NAME: Datos del origen (si existen)
```

#### PAYOUT (10 registros agosto)
```
Neto negativo: -10.904.815,29 (total agosto)

Variantes observadas en SOURCE_ID:
- 173328578145 (payout de $3.600.000, 2026-08-17) → tipo: probable transferencia interna
- 176505430684 (payout de $5.328.040, 2026-08-31) → tipo: probable transferencia grande
- Otros 8: montos pequeños ($100k-$743k rango) → tipo: desconocido

IMPORTANTE:
- NO asumir que payout = transfer_out
- NO clasificar sin confirmación en cross-reference con arch5
- GUARDAR: mp_payment_method_type, destination info si existe

Campos útiles:
- PAYMENT_METHOD_TYPE: (verificar valores reales en CSV)
- BUSINESS_UNIT: Puede indicar área que ordena el payout
- PURCHASE_ID: Puede correlacionar con facturación si existe
```

#### ASSET_MANAGEMENT (20 registros agosto)
```
Neto: +38.896,48 (rendimientos de inversión)

Muy claro: Son ganancias de activos bajo gestión MP.
- Bajo volumen (20 registros)
- Ingreso positivo siempre
- Ya validado con dato anterior ($38.896,48 exacto)

Clasificación segura: income/asset_yield
```

### CONCLUSIÓN PUNTO [3]
✓ payment → mp_financial_movement + ledger_entry (balance_impact > 0)
✓ payout → mp_financial_movement + ledger_entry (balance_impact < 0)
✓ asset_management → mp_financial_movement + ledger_entry (balance_impact > 0)
✓ Clasificación inicial genérica (no asumir tipos específicos)

---

## [4] PAYOUT: NO ASUMIR CLASIFICACIÓN A PRIORI

### Análisis de los 10 PAYOUTS agosto

**Estrategia: Conservar información, NO clasificar sin evidencia**

Tabla de análisis:

```
PAYOUT_ID         FECHA       DEBITO        PAYMENT_METHOD_TYPE    BUSINESS_UNIT    NOTABLE
─────────────────────────────────────────────────────────────────────────────────────────────
171269157013      2026-08-05  $730,356      [del CSV]              [del CSV]        Medio
172192906390      2026-08-05  $743,412      [del CSV]              [del CSV]        Medio
172195785910      2026-08-05  $100,000      [del CSV]              [del CSV]        Pequeño
172330212086      2026-08-06  $122,944      [del CSV]              [del CSV]        Pequeño
173328578145      2026-08-17  $3,600,000    [del CSV]              [del CSV]        GRANDE (27% del total)
174968636648      2026-08-21  $16,336       [del CSV]              [del CSV]        Pequeño
174102711661      2026-08-21  $42,252       [del CSV]              [del CSV]        Pequeño
176498460166      2026-08-31  $21,474       [del CSV]              [del CSV]        Pequeño
176505430684      2026-08-31  $5,328,040    [del CSV]              [del CSV]        MUY GRANDE (48% del total)
175630771675      2026-08-31  $200,000      [del CSV]              [del CSV]        Medio
                                           ────────────────────────────────────────
TOTAL agosto:                  $10,904,815
```

### Información conservada en mp_source_record.source_payload

```json
{
  "description": "payout",
  "source_id": "173328578145",
  "payment_method_type": "... valor real del CSV ...",
  "business_unit": "... valor real del CSV ...",
  "sub_unit": "... valor real del CSV ...",
  "net_debit": 3600000.00,
  "balance_before": "...",
  "balance_after": "...",
  "transaction_approval_date": "...",
  "tags": "... si existen ...",
  "notes": "PAYOUT - NO CLASIFICADO A PRIORI"
}
```

### Clasificación inicial en mp_financial_movement

```sql
INSERT INTO mp_financial_movement (
  account_id,
  transaction_date,          -- DATE del payout
  settlement_date,           -- TRANSACTION_APPROVAL_DATE
  movement_class,            -- GENÉRICA: 'payment_out' o 'payout'
  transaction_amount,        -- NET_DEBIT
  settlement_amount,         -- NET_DEBIT (igual para payouts)
  economic_hash,             -- SHA256(amount, date, class, etc.)
  needs_review,              -- FALSE ahora, TRUE si correlación detecta discrepancia
  created_at
)
VALUES (...);
```

### Correlación POST-IMPORTACIÓN (FASE 1)

Después de que ambos reportes estén en BD:
```sql
SELECT 
  l.SOURCE_ID as liberaciones_id,
  a.SOURCE_ID as account_money_id,
  l.net_debit,
  a.transaction_amount,
  CASE 
    WHEN l.SOURCE_ID = a.SOURCE_ID THEN 'MATCH_EXACT'
    WHEN l.PURCHASE_ID = a.PURCHASE_ID THEN 'MATCH_PURCHASE'
    WHEN ABS(l.net_debit - a.transaction_amount) < 0.01 
      AND ABS(l.DATE - a.TRANSACTION_DATE) <= 1 
      THEN 'MATCH_FUZZY'
    ELSE 'NO_MATCH'
  END as correlation
FROM liberaciones_payout_records l
LEFT JOIN arch5_payout_records a ON (correlación logic)
ORDER BY l.DATE;
```

Resultado esperado:
- Algunos payouts están en AMBOS reportes (correlación confirma tipo)
- Otros payouts solo en Liberaciones (nuevos, faltantes en agosto)
- Posiblemente algún payout solo en arch5 (no liquidado aún)

### CONCLUSIÓN PUNTO [4]
✓ NO clasificar payouts a priori
✓ Usar término genérico: 'payment_out' o 'payout' en movement_class
✓ Guardar TODOS los campos del CSV en source_payload
✓ Correlación: SOURCE_ID + PURCHASE_ID + fuzzy date matching
✓ Revisar post-importación para refinar clasificación

---

## [5] SOURCE_ID: NO RESTRICCIÓN GLOBAL DE UNICIDAD

### Problema conceptual

Suponer que SOURCE_ID es único globalmente entre reportes:
- ❌ Incorrecto: Cada reporte tiene su propia secuencia de IDs
- ✓ Correcto: SOURCE_ID es único DENTRO de cada reporte (source_type)

### Estrategia de identidad RAW

**Clave primaria en mp_source_record**:
```sql
UNIQUE(source_type, source_external_id, payload_hash)
```

Esto permite:
```
source_type='account_money', source_external_id='12345', payload_hash='ABC...'
source_type='liberaciones', source_external_id='12345', payload_hash='DEF...'
```
Son DOS registros RAW diferentes (posiblemente misma operación, distinto reporte).

### Correlación inteligente (NO global)

**Por operación definitiva (payment, payout)**:

```sql
-- Para PAYMENT: comparar ingresos
SELECT 
  am.source_external_id as from_account_money,
  lq.source_external_id as from_liberaciones,
  am.transaction_amount,
  lq.NET_CREDIT_AMOUNT,
  am.PURCHASE_ID,
  lq.PURCHASE_ID,
  am.TRANSACTION_DATE,
  lq.DATE,
  CASE 
    WHEN am.PURCHASE_ID = lq.PURCHASE_ID THEN 'STRONG'
    WHEN am.source_external_id = lq.source_external_id 
      AND ABS(am.transaction_amount - lq.NET_CREDIT_AMOUNT) < 0.01 
      THEN 'MEDIUM'
    WHEN ABS(am.transaction_amount - lq.NET_CREDIT_AMOUNT) < 0.01 
      AND ABS(CAST(am.TRANSACTION_DATE AS DATE) - CAST(lq.DATE AS DATE)) <= 1 
      THEN 'WEAK'
    ELSE 'NO_MATCH'
  END as confidence
FROM (
  SELECT * FROM mp_source_record 
  WHERE source_type='account_money' 
    AND source_payload->>'TRANSACTION_TYPE' = 'payment'
) am
LEFT JOIN (
  SELECT * FROM mp_source_record 
  WHERE source_type='liberaciones' 
    AND source_payload->>'description' = 'payment'
) lq ON TRUE
ORDER BY confidence DESC;
```

### Ventajas de esta estrategia

- ✓ Permite correlacionar sin asumir unicidad
- ✓ Detecta operaciones que existen en un reporte pero no en otro
- ✓ Ayuda a encontrar discrepancias reales
- ✓ Evita crear duplicate ledger_entries

### CONCLUSIÓN PUNTO [5]
✓ source_type + source_external_id + payload_hash = identidad única RAW
✓ NO restricción global de SOURCE_ID
✓ Correlación inteligente: PURCHASE_ID > fuzzy matching > NO_MATCH
✓ Resultado: detectar verdaderas nuevas operaciones vs duplicados

---

## [6] DEDUPLICACIÓN: EVITAR DUPLICAR 716 MOVIMIENTOS HISTÓRICOS

### Operaciones ya importadas (agosto, arch5.csv)

**Estado actual Supabase**:
```
account_id=1 (asumir):
- source_records: 716 del tipo 'account_money'
- financial_movements: ~714 (algunos Scenario B: múltiples fuentes → 1 FM)
- ledger_entries: ~714 (1:1 con FM)
- balance_impact_total: +$13.337.721,86 (ingresos) - $2.557.109,81 (comisión) = falta payout
```

### Operaciones a importar de Liberaciones (agosto, Liberaciones3.csv)

**Nuevas filas**:
```
- payment: 696 (¿cuántos ya en BD?)
- payout: 10 (0 en BD = 100% nuevos)
- asset_management: 20 (¿cuántos ya en BD?)
- reserve_*: 72 (TODO nuevo, pero balance_impact=0 así que SIN ledger_entry)
```

### Estrategia de deduplicación

**FASE A: Lectura de datos existentes**

```python
# Antes de importar Liberaciones, ejecutar:
existing_correlations = {}

# Por cada payment esperado en Liberaciones
for payment_row in liberaciones_payment_rows:
    source_id = payment_row['SOURCE_ID']
    amount = Decimal(payment_row['NET_CREDIT_AMOUNT'])
    
    # Buscar en BD si existe correlación
    existing = query(f"""
    SELECT fm.id, sr.source_external_id
    FROM mp_financial_movement fm
    JOIN mp_movement_source_link link ON fm.id = link.financial_movement_id
    JOIN mp_source_record sr ON sr.id = link.source_record_id
    WHERE sr.source_payload->>'SOURCE_ID' = '{source_id}'
       OR ABS(fm.transaction_amount - {amount}) < 0.01
       AND fm.transaction_date = '{payment_row['DATE']}'
    """)
    
    if existing:
        existing_correlations[source_id] = {
            'fm_id': existing['id'],
            'action': 'CREATE_LINK_ONLY',  # No crear FM nuevo
            'reason': 'Same amount & date as existing FM'
        }
    else:
        existing_correlations[source_id] = {
            'fm_id': None,
            'action': 'CREATE_ALL',  # Crear SR + FM + LE
            'reason': 'New operation'
        }
```

### Estrategia de importación

**OPCIÓN 1: RPC con lógica de deduplicación incluida** ✓ RECOMENDADO

```sql
-- PSEUDO-CÓDIGO para import_liberaciones_primary()

FOR each row IN liberaciones_august:
  
  -- [A] Siempre crear SR (con deduplicación)
  INSERT INTO mp_source_record (...)
  ON CONFLICT (source_type, source_external_id, payload_hash)
  DO NOTHING;
  sr_id = LASTVAL();  -- o recuperar si ya existía
  
  -- [B] Si balance_impact = 0, STOP (solo guardar RAW)
  IF balance_impact = 0:
    CONTINUE;
  END IF;
  
  -- [C] Buscar si FM ya existe
  existing_fm = SELECT fm.id FROM mp_financial_movement fm
                WHERE correlate(fm, current_row) = TRUE;
  
  -- [D] Crear FM si no existe
  IF NOT existing_fm:
    INSERT INTO mp_financial_movement (...) VALUES (...);
    fm_id = LASTVAL();
  ELSE:
    fm_id = existing_fm.id;
  END IF;
  
  -- [E] Crear link SR → FM (deduplicado)
  INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id)
  VALUES (fm_id, sr_id)
  ON CONFLICT (financial_movement_id, source_record_id)
  DO NOTHING;
  
  -- [F] Crear LE si no existe (1:1 constraint)
  existing_le = SELECT id FROM ledger_entry WHERE financial_movement_id = fm_id;
  IF NOT existing_le:
    INSERT INTO ledger_entry (...) VALUES (...);
  END IF;

END LOOP;
```

### Validación post-importación

```sql
-- Verificar que NO tenemos duplicados de ledger_entry
SELECT financial_movement_id, COUNT(*) as cnt
FROM ledger_entry
GROUP BY financial_movement_id
HAVING COUNT(*) > 1;
-- Resultado esperado: 0 filas

-- Verificar que el saldo no cambió de los 716 históricos
SELECT 
  account_id,
  (SELECT SUM(balance_impact) FROM ledger_entry 
   WHERE created_at < '2026-09-05') as saldo_antes,
  (SELECT SUM(balance_impact) FROM ledger_entry 
   WHERE created_at >= '2026-09-05' 
   AND source_type = 'account_money') as saldo_histórico,
  (SELECT SUM(balance_impact) FROM ledger_entry 
   WHERE source_type = 'liberaciones') as saldo_nuevo;
```

### Resultado esperado después de importar Liberaciones

```
payment (696):
  - Correlacionados con arch5: ~696 (reutilizar FM)
  - Nuevos: 0
  - Resultado: 0 duplicate LE creados

payout (10):
  - Correlacionados con arch5: 0
  - Nuevos: 10 (100% de payouts faltantes)
  - Resultado: 10 nuevas LE creadas

asset_management (20):
  - Correlacionados: 20 (si existen en arch5)
  - Nuevos: 0
  - Resultado: 0 duplicate LE creadas

reserve_* (72):
  - Guardados en mp_source_record
  - SIN mp_financial_movement
  - SIN ledger_entry
  - Resultado: Auditoría completa, 0 impacto contable

TOTALES:
- SR nuevos: 798 (todos Liberaciones)
- FM nuevos: 10 (payouts faltantes)
- LE nuevos: 10 (1:1 con FM nuevos)
- Total ledger_entries (histórico + nuevo): 724 (716 + 8 antes = ~724)
```

### CONCLUSIÓN PUNTO [6]
✓ Deduplicación inteligente: SR siempre, FM solo si nuevo, LE solo si FM nuevo
✓ Correlación antes de crear: PURCHASE_ID > amount+date matching
✓ Validación post-importación: verificar UNIQUE(fm_id) en LE
✓ Resultado: 10 nuevas LE (payouts), 0 duplicados

---

## [7] DIFERENCIA DE $0,03: INVESTIGACIÓN READ-ONLY

### Hallazgo

```
Liberaciones3.csv (agosto):  -$124.203,24
MP UI (agosto):             -$124.203,27
Diferencia:                 +$0,03
```

### Hipótesis 1: Redondeo de comisiones/impuestos

**Búsqueda**: Filas donde GROSS ± FEE ± TAX ≠ NET

```python
import csv
from decimal import Decimal

discrepancias = []
with open('Liberaciones3.csv', 'r') as f:
    reader = csv.DictReader(f, delimiter=';')
    for i, row in enumerate(reader, 1):
        try:
            gross = Decimal(str(row.get('GROSS_AMOUNT', '0')).replace(',', '.'))
            fee = Decimal(str(row.get('MP_FEE_AMOUNT', '0')).replace(',', '.'))
            tax = Decimal(str(row.get('TAXES_AMOUNT', '0')).replace(',', '.'))
            cr = Decimal(str(row.get('NET_CREDIT_AMOUNT', '0')).replace(',', '.'))
            db = Decimal(str(row.get('NET_DEBIT_AMOUNT', '0')).replace(',', '.'))
            
            # Validar: GROSS - FEE - TAX debe coincidir con NET
            esperado_cr = gross - fee - tax if gross > 0 else Decimal('0')
            esperado_db = gross + fee + tax if gross < 0 else Decimal('0')
            
            if esperado_cr != cr or esperado_db != db:
                discrepancias.append({
                    'row': i,
                    'GROSS': gross,
                    'FEE': fee,
                    'TAX': tax,
                    'NET_CR': cr,
                    'NET_DB': db,
                    'diferencia_cr': cr - esperado_cr,
                    'diferencia_db': db - esperado_db
                })
        except:
            pass

print(f"Filas con discrepancia: {len(discrepancias)}")
for d in discrepancias[:10]:
    print(f"Row {d['row']}: CR diff={d['diferencia_cr']}, DB diff={d['diferencia_db']}")
```

**RESULTADO ESPERADO**: Si hay redondeos, veremos patrones de ±0.01, ±0.02, etc.

### Hipótesis 2: Montos con más de 2 decimales en CSV

**Búsqueda**: Campos que en teoría deberían ser céntimos pero tienen más de 2 decimales

```python
# Verificar si algún campo tiene más de 2 decimales
for row in all_august_records:
    for col in ['NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT', 'MP_FEE_AMOUNT', 'TAXES_AMOUNT', 'GROSS_AMOUNT']:
        val_str = row.get(col, '')
        if '.' in val_str:
            decimals = len(val_str.split('.')[1])
            if decimals > 2:
                print(f"Row: {col}={val_str} ({decimals} decimales)")
```

### Hipótesis 3: Truncación vs redondeo en MP UI

**Posibilidad**: MP UI redondea para mostrar, pero CSV tiene valores exactos.

Buscar: ¿Existe alguna operación cuyo neto sea exactamente $0,01?

```sql
-- Buscar en Liberaciones3 agosto
SELECT DATE, SOURCE_ID, DESCRIPTION, 
       ABS(NET_CREDIT_AMOUNT - NET_DEBIT_AMOUNT) as neto_abs
FROM liberaciones_3_raw
WHERE DATE >= '2026-08-01' AND DATE < '2026-09-01'
  AND ABS(NET_CREDIT_AMOUNT - NET_DEBIT_AMOUNT) IN (0.01, 0.02, 0.03)
ORDER BY neto_abs
LIMIT 10;
```

Si hay una fila con neto exacto de $0,03, esa es la culpable.

### Hipótesis 4: Impuesto negativo con más de 2 decimales

En `Ejemplo 3` vimos `TAXES_AMOUNT: -10000.65` (2 decimales OK).
Pero la fórmula puede tener redondeos intermedios.

**Búsqueda**: Filas donde TAXES_AMOUNT tenga fracciones de centavo

```python
for row in liberaciones_3_raw:
    tax_str = row.get('TAXES_AMOUNT', '')
    if '.' in tax_str:
        parts = tax_str.split('.')
        if len(parts[1]) > 2:
            print(f"TAX con >2 decimales: {row['SOURCE_ID']}={tax_str}")
```

### Plan investigativo READ-ONLY

1. **Ejecutar auditoría de discrepancias** con script Python (hipótesis 1-4)
2. **Resultados**:
   - Si hay 1 fila con neto=$0,03: problema resuelto, esa fila tiene redondeo
   - Si hay múltiples filas con pequeñas discrepancias: problemas de truncación
   - Si no hay nada: diferencia puede venir de rubros contables diferentes (comisiones acumuladas, etc.)
3. **Conclusión**: Registrar hallazgo, decidir si $0,03 es aceptable para importar o si necesita investigación con MercadoPago

### CONCLUSIÓN PUNTO [7]
⏳ **Investigación pendiente**: Ejecutar auditoría de redondeos
✓ Diferencia $0,03 es pequeña, probablemente aceptable
✓ NO impide importación, pero sí documentar raíz

---

## [8] BALANCE_AMOUNT: HERRAMIENTA DE RECONCILIACIÓN

### Significado del BALANCE_AMOUNT en Liberaciones3

Cada fila contiene `BALANCE_AMOUNT`, que es el saldo contable DESPUÉS de esa operación.

```
Ejemplo secuencia agosto temprano:
DATE           DESCRIPTION         NET_CREDIT  NET_DEBIT  BALANCE_AMOUNT
2026-08-01     payment                1500        0         1500.00      (saldo inicial = 0, luego 1500)
2026-08-01     payment                2000        0         3500.00      (acum = 1500 + 2000)
2026-08-02     asset_management         50        0         3550.00      (acum = 3500 + 50)
2026-08-03     reserve_for_payment      -         -            ?          ¿cambia BALANCE?
...
```

### Validación: Reconstruir BALANCE_AMOUNT

```python
running_balance = Decimal('0')  # O el saldo inicial

for row in sorted(liberaciones_3_raw_august, key=lambda x: x['DATE']):
    balance_impact = Decimal(row['NET_CREDIT']) - Decimal(row['NET_DEBIT'])
    running_balance += balance_impact
    
    reported_balance = Decimal(str(row['BALANCE_AMOUNT']).replace(',', '.'))
    
    if running_balance != reported_balance:
        print(f"DISCREPANCIA: {row['DATE']} {row['SOURCE_ID']}")
        print(f"  Esperado: {running_balance}")
        print(f"  Reportado: {reported_balance}")
        print(f"  Diferencia: {reported_balance - running_balance}")
```

### Significado si hay discrepancias

**Escenario A: BALANCE_AMOUNT incluye otros rubros**
- Comisiones acumuladas
- Impuestos acumulados
- Rendimientos no detallados
- Resultado: Nuestro balance_impact puede no coincidir exactamente con BALANCE_AMOUNT

**Escenario B: BALANCE_AMOUNT es punto-en-tiempo**
- Refleja estado de la cuenta al cierre de jornada
- Nuestras operaciones son dentro de la jornada
- Resultado: Validar que EOD (2026-08-31) coincida con saldo de cuenta

### Uso en validación final

```sql
-- Después de importar Liberaciones, verificar:

SELECT 
  account_id,
  CAST(MAX(occurred_at) AS DATE) as fecha_maxima,
  SUM(balance_impact) FILTER (
    WHERE occurred_at::DATE <= '2026-08-31'
  ) as balance_contable_calculado,
  (SELECT MAX(BALANCE_AMOUNT)::NUMERIC(15,2)
   FROM liberaciones_3_raw
   WHERE DATE = '2026-08-31') as balance_liberaciones_eod
FROM ledger_entry
WHERE account_id = 1
  AND occurred_at::DATE <= '2026-08-31'
GROUP BY account_id;
```

Si coinciden exactamente: ✓ Validación perfecta
Si difieren < $1: ✓ Aceptable (diferencia de procesamiento)
Si difieren > $1: ⚠ Investigar más

### CONCLUSIÓN PUNTO [8]
✓ BALANCE_AMOUNT es herramienta valiosa de reconciliación
✓ Validar que EOD (2026-08-31) = $71.362,90
✓ NO modificar account_balance aún
✓ Usar para validar integridad post-importación

---

## [9] RESUMEN: DISEÑO TÉCNICO FINAL (SIN IMPLEMENTAR AÚN)

### Tabla comparativa: Estado actual vs nuevo

| Aspecto | HOY (arch5) | NUEVO (Liberaciones) | Razón |
|---------|-------------|----------------------|-------|
| **Fuente primaria** | account_money | liberaciones | Liquidación definitiva con neto completo |
| **Campos neto** | SETTLEMENT_NET | NET_CREDIT/DEBIT | Más completos, comisiones explícitas |
| **Deduplica reservas** | - | SÍ, RAW only | Evitar duplicado contable |
| **Payouts capturados** | 0 | 10 nuevos | Recupera $10.9M faltantes |
| **Clasificación** | 7 tipos (yield, etc) | 3 tipos (payment, payout, asset_mgmt) | Genérica, post-correlación |

### Cambios de schema necesarios

**¿NUEVAS COLUMNAS?** NO, arquitectura actual es suficiente.

Verificación:
```sql
-- mp_source_record: TIENE todo
  - source_type ✓
  - source_external_id ✓
  - payload_hash ✓
  - source_payload (JSON, cabe TODO) ✓

-- mp_financial_movement: TIENE todo
  - account_id ✓
  - transaction_date ✓
  - settlement_date ✓
  - movement_class ✓ (usar genérico: 'payment', 'payout', 'asset_mgmt')
  - transaction_amount ✓
  - settlement_amount ✓
  - economic_hash ✓ (recalcular para Liberaciones)
  - needs_review ✓ (marcar si discrepancia)

-- mp_movement_source_link: TIENE todo
  - financial_movement_id ✓
  - source_record_id ✓

-- ledger_entry: TIENE todo
  - financial_movement_id ✓
  - account_id ✓
  - movement_class ✓
  - occurred_at ✓
  - balance_impact ✓

-- account_balance: NO modificar todavía
  (posterior: posiblemente agregar reserved_amount, pero NO ahora)
```

**RESULTADO**: ✓ No se necesitan cambios de schema.

### Migraciones SQL necesarias

**ZERO**. No se requieren migraciones.

Razón: La arquitectura ya soporta múltiples fuentes (source_type).

### RPC nueva: import_liberaciones_primary()

```sql
CREATE OR REPLACE FUNCTION import_liberaciones_primary(
  p_input JSONB  -- Array de filas [{"date":"...", "source_id":"...", ...}]
)
RETURNS JSON AS $$
DECLARE
  v_record JSONB;
  v_sr_id BIGINT;
  v_fm_id BIGINT;
  v_existing_fm_id BIGINT;
  v_balance_impact NUMERIC(15,2);
  v_description VARCHAR(50);
  v_response JSON;
  sr_new INT := 0;
  sr_existing INT := 0;
  fm_new INT := 0;
  le_new INT := 0;
  reserves_count INT := 0;
BEGIN
  
  -- Procesar cada fila del input
  FOR v_record IN SELECT jsonb_array_elements(p_input)
  LOOP
    v_description := v_record->>'description';
    v_balance_impact := 
      (v_record->>'net_credit_amount')::NUMERIC(15,2) -
      (v_record->>'net_debit_amount')::NUMERIC(15,2);
    
    -- [PASO 1] Crear/validar mp_source_record (SIEMPRE)
    INSERT INTO mp_source_record (
      source_type,
      source_external_id,
      payload_hash,
      source_payload,
      created_at
    )
    SELECT 
      'liberaciones',
      v_record->>'source_id',
      encode(digest(
        concat_ws('|',
          v_record->>'source_id',
          v_record->>'date',
          v_record->>'net_credit_amount',
          v_record->>'net_debit_amount',
          v_record->>'mp_fee_amount',
          v_record->>'taxes_amount',
          v_record->>'description',
          v_record->>'payment_method_type'
        ), 'sha256'), 'hex'),
      v_record,
      NOW()
    ON CONFLICT (source_type, source_external_id, payload_hash) 
    DO UPDATE SET updated_at = NOW()
    RETURNING id INTO v_sr_id;
    
    IF v_sr_id IS NOT NULL THEN
      sr_new := sr_new + 1;
    ELSE
      sr_existing := sr_existing + 1;
    END IF;
    
    -- [PASO 2] Si balance_impact = 0, STOP (reservas)
    IF ABS(v_balance_impact) < 0.01 THEN
      reserves_count := reserves_count + 1;
      CONTINUE;
    END IF;
    
    -- [PASO 3] Buscar si FM ya existe (deduplicación)
    SELECT fm.id INTO v_existing_fm_id
    FROM mp_financial_movement fm
    WHERE ABS(fm.transaction_amount - v_balance_impact) < 0.01
      AND fm.transaction_date = (v_record->>'date')::DATE;
    
    -- [PASO 4] Crear FM si no existe
    IF v_existing_fm_id IS NULL THEN
      INSERT INTO mp_financial_movement (
        account_id,
        transaction_date,
        settlement_date,
        movement_class,
        transaction_amount,
        settlement_amount,
        economic_hash,
        needs_review,
        created_at
      ) VALUES (
        1,  -- account_id (asumir 1 por ahora, parameterizar después)
        (v_record->>'date')::DATE,
        (v_record->>'transaction_approval_date')::DATE,
        v_description,  -- Usar genérico: payment, payout, asset_management
        v_balance_impact,
        v_balance_impact,
        encode(digest(
          concat_ws('|', v_balance_impact, v_record->>'date', v_description), 'sha256'
        ), 'hex'),
        FALSE,
        NOW()
      )
      RETURNING id INTO v_fm_id;
      fm_new := fm_new + 1;
    ELSE
      v_fm_id := v_existing_fm_id;
    END IF;
    
    -- [PASO 5] Crear link SR → FM
    INSERT INTO mp_movement_source_link (financial_movement_id, source_record_id)
    VALUES (v_fm_id, v_sr_id)
    ON CONFLICT (financial_movement_id, source_record_id) DO NOTHING;
    
    -- [PASO 6] Crear LE si FM es nuevo
    IF v_existing_fm_id IS NULL THEN
      INSERT INTO ledger_entry (
        account_id,
        financial_movement_id,
        movement_class,
        occurred_at,
        balance_impact,
        created_at
      ) VALUES (
        1,
        v_fm_id,
        v_description,
        (v_record->>'date')::TIMESTAMP,
        v_balance_impact,
        NOW()
      );
      le_new := le_new + 1;
    END IF;
    
  END LOOP;
  
  -- Retornar resumen
  v_response := jsonb_build_object(
    'success', TRUE,
    'source_records_new', sr_new,
    'source_records_existing', sr_existing,
    'financial_movements_new', fm_new,
    'ledger_entries_new', le_new,
    'reserves_processed', reserves_count,
    'total_rows_processed', sr_new + sr_existing
  );
  
  RETURN v_response;
  
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', FALSE,
    'error', SQLERRM,
    'sqlstate', SQLSTATE
  );
END;
$$ LANGUAGE plpgsql;
```

### Script Python: import_liberaciones.py

```python
import csv
import json
from decimal import Decimal
from pathlib import Path
import supabase

# [A] Leer Liberaciones3.csv
liberaciones_path = Path("data/mercadopago/Liberaciones3.csv")
records = []

with open(liberaciones_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f, delimiter=';')
    for row in reader:
        # Filtrar a agosto
        date_str = row.get('DATE', '')[:10]
        if date_str and date_str.startswith('2026-08'):
            records.append(row)

# [B] Validar y normalizar
normalized = []
for row in records:
    normalized.append({
        'date': row['DATE'],
        'source_id': row['SOURCE_ID'],
        'description': row['DESCRIPTION'],
        'net_credit_amount': row['NET_CREDIT_AMOUNT'],
        'net_debit_amount': row['NET_DEBIT_AMOUNT'],
        'mp_fee_amount': row.get('MP_FEE_AMOUNT', '0'),
        'taxes_amount': row.get('TAXES_AMOUNT', '0'),
        'payment_method_type': row.get('PAYMENT_METHOD_TYPE', ''),
        'transaction_approval_date': row.get('TRANSACTION_APPROVAL_DATE', ''),
        'business_unit': row.get('BUSINESS_UNIT', ''),
        'purchase_id': row.get('PURCHASE_ID', '')
    })

# [C] Llamar RPC en lotes
client = supabase.Client(url, key)
batch_size = 100

for i in range(0, len(normalized), batch_size):
    batch = normalized[i:i+batch_size]
    result = client.rpc('import_liberaciones_primary', {'p_input': json.dumps(batch)}).execute()
    print(f"Batch {i//batch_size + 1}: {result.data}")
```

### Plan de validación POST-IMPORTACIÓN

```sql
-- [1] Verificar no hay duplicate LE
SELECT COUNT(*) as duplicates
FROM (
  SELECT financial_movement_id, COUNT(*) as cnt
  FROM ledger_entry
  GROUP BY financial_movement_id
  HAVING COUNT(*) > 1
) x;
-- Esperado: 0

-- [2] Verificar balance_impact de agosto
SELECT 
  SUM(balance_impact) as total_impact,
  COUNT(*) as total_entries
FROM ledger_entry
WHERE occurred_at::DATE BETWEEN '2026-08-01' AND '2026-08-31';
-- Esperado: -124203.27 (o -124203.24 ± $0.03)

-- [3] Verificar payouts se importaron
SELECT COUNT(*) as payout_count
FROM mp_financial_movement
WHERE movement_class = 'payout'
  AND transaction_date BETWEEN '2026-08-01' AND '2026-08-31';
-- Esperado: 10

-- [4] Verificar EOD balance
SELECT 
  CAST(MAX(occurred_at) AS DATE) as fecha,
  SUM(balance_impact) as balance_calculado
FROM ledger_entry
WHERE occurred_at::DATE <= '2026-08-31'
GROUP BY CAST(occurred_at AS DATE)
ORDER BY fecha DESC
LIMIT 1;
-- Esperado: 2026-08-31 → valor cercano a 71362.90
```

### CONCLUSIÓN PUNTO [9]
✓ Diseño técnico completo, listo para implementación
✓ Zero cambios de schema necesarios
✓ RPC + Python script listos
✓ Plan de validación definido
✓ **PENDIENTE**: Aprobación final y ejecución

---

## CAMBIOS PROPUESTOS vs ESTADO ACTUAL

### ✅ Mantener intacto
- Todas las tablas existentes
- Todas las columnas existentes
- Todas las restricciones
- Los 716 movimientos importados de arch5

### 🆕 Agregar
- 798 nuevos `mp_source_record` (tipo 'liberaciones')
- 10 nuevos `mp_financial_movement` (payouts faltantes)
- 10 nuevos `ledger_entry` (1:1 con FM nuevos)
- Potencial: refinar `movement_class` de 716 historicos con correlación

### ⚠️ Riesgos mitigados
1. Duplicación de LE: Validado con query de duplicates
2. Cambio de neto histórico: Mantiene los 716 immutable
3. Errores de redondeo: Usar NUMERIC(15,2) siempre
4. Pérdida de auditoría: TODO en mp_source_record.source_payload (JSON)

---

## RECOMENDACIÓN FINAL

**OPCIÓN A: APROBADA DESDE PERSPECTIVA ARQUITECTÓNICA** ✓

Implementar:
1. RPC `import_liberaciones_primary()`
2. Script `import_liberaciones.py`
3. Ejecutar importación Liberaciones3 agosto
4. Validación post-importación
5. Recuperar $10.904.815,29 en payouts faltantes
6. Correlacionar ambos reportes en FASE 1

---

## PRÓXIMOS PASOS (DESPUÉS DE APROBACIÓN)

1. ✓ Generar RPC final con handle de edge cases
2. ✓ Generar script Python con logging detallado
3. ✓ Crear plan de rollback (backup preimport)
4. ✓ Ejecutar importación
5. ✓ Validar: neto agosto = -$124.203,27 ± $0.03
6. ✓ Documentar discrepancias halladas
7. ⏳ FASE 1: Correlacionar reportes, refinar clasificaciones

---

**Estado**: DISEÑO COMPLETADO, PENDIENTE APROBACIÓN
**Responsable**: Usuario (Claudio)
**Fecha propuesta ejecución**: TBD (post-aprobación)

