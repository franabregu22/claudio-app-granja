# Investigación: movement_class = NULL en RPC

## Error Observado
```
null value in column "movement_class" of relation "mp_financial_movement" 
violates not-null constraint

Failing row: id=4284, account_id=1054315166, settlement_amount=1629.44, movement_class=NULL
```

Ocurre en: **Chunk 9** del import de Report (primeros 8 chunks = 400 filas procesadas exitosamente)

---

## Análisis del Código LOCAL

### 1. Ubicación de INSERTs a mp_financial_movement

En `008_reconciliation_rpc.sql`, hay DOS lugares donde se hace INSERT a `mp_financial_movement`:

#### INSERT A (línea 408-416): En path de "collapse detection"
```sql
INSERT INTO mp_financial_movement (
  account_id, source_id, movement_class, settlement_amount,
  transaction_date, needs_review
)
VALUES (
  p_account_id, v_source_id, 'PAYOUT', v_signed_impact,
  (v_row->>'DATE')::TIMESTAMP, FALSE
)
```
- Se ejecuta cuando: `v_collapse_detected = TRUE` (SR ya existe con FM linkado pero con diferente balance)
- movement_class: **hardcoded 'PAYOUT'** → NO PUEDE SER NULL

#### INSERT B (línea 517-524): En path "create new FM"
```sql
INSERT INTO mp_financial_movement (
  account_id, source_id, movement_class, settlement_amount,
  transaction_date, needs_review
)
VALUES (
  p_account_id, v_source_id, 'PAYOUT', v_signed_impact,
  (v_row->>'DATE')::TIMESTAMP, FALSE
)
```
- Se ejecuta cuando: row es nuevo y no encuentra FM existente
- movement_class: **hardcoded 'PAYOUT'** → NO PUEDE SER NULL

### 2. Variable que CALCULA movement_class (no usada en INSERT)

En línea 349:
```sql
v_economic_class := map_to_economic_class(p_source_type, v_description);
```

Para un Report con TRANSACTION_TYPE='SETTLEMENT':
```
map_to_economic_class('report', 'SETTLEMENT') → 'PAYMENT'
```

**DISCREPANCIA CRÍTICA**: 
- El código usa `'PAYOUT'` en los INSERT
- Pero calcula `v_economic_class = 'PAYMENT'` para reports
- `v_economic_class` **NO se usa** en los INSERT (solo en fingerprints)

---

## Hipótesis: RPC Desplegada es DIFERENTE

El código LOCAL es correcto (hardcoded 'PAYOUT'), pero el comportamiento observado (NULL) sugiere que:

### Hipótesis A: Versión desplegada usa variable NULL
```sql
-- VERSIÓN INCORRECTA (desplegada?):
INSERT INTO mp_financial_movement (
  account_id, source_id, movement_class, ...
)
VALUES (
  p_account_id, v_source_id, NULL, ...  -- BUG: hardcoded NULL en lugar de 'PAYOUT'
)
```

### Hipótesis B: Versión desplegada intenta usar v_economic_class pero llega NULL
```sql
-- VERSIÓN INCORRECTA (desplegada?):
v_economic_class := map_to_economic_class(...);
-- Si v_economic_class es NULL por algún motivo...
INSERT INTO mp_financial_movement (
  ..., movement_class, ...
)
VALUES (
  ..., v_economic_class, ...  -- movement_class = NULL si v_economic_class es NULL
)
```

Pero esto no debería ocurrir porque `map_to_economic_class` siempre devuelve un valor (PAYMENT, PAYOUT, UNKNOWN, etc).

### Hipótesis C: Versión desplegada tiene código diferente al archivo local
- El archivo `008_reconciliation_rpc.sql` podría no estar sincronizado con la versión en Supabase
- La RPC pudo haber sido modificada sin actualizar el archivo SQL local

---

## Qué DEBERÍA ser movement_class

Para la fila que falló en chunk 9:
```json
{
  "SOURCE_ID": "1745105363064",
  "SETTLEMENT_NET_AMOUNT": "1629.44",
  "TRANSACTION_TYPE": "SETTLEMENT",
  "TRANSACTION_DATE": "2026-06-11T02:10:53.000-03:00",
  ...
}
```

**Según el código LOCAL:**
- `movement_class = 'PAYOUT'` (hardcoded en INSERT)

**Según `map_to_economic_class`:**
- `map_to_economic_class('report', 'SETTLEMENT') = 'PAYMENT'`

**Inconsistencia observada:** El código calcula 'PAYMENT' pero inserta 'PAYOUT'

---

## Flujo para chunk 9, row con settlement_amount=1629.44

```
1. Row entra como REPORT source_type
2. v_description = 'SETTLEMENT' (TRANSACTION_TYPE)
3. v_signed_impact = 1629.44 (SETTLEMENT_NET_AMOUNT)
4. v_economic_class = map_to_economic_class('report', 'SETTLEMENT') → 'PAYMENT'
5. v_economic_row_fp = computed hash
6. v_cross_source_fp = computed hash
7. v_is_raw_only = FALSE (reports nunca son raw-only)
8. Check Layer 1: ¿Ya existe este SR? 
   → Si NO existe, crear SR (v_new_source_records++)
9. Check Layer 2: ¿Existe FM con mismo economic_row_fp?
   → Si NO existe, crear FM + LE (INSERT a mp_financial_movement)
   → Este es donde falla en chunk 9
```

**En el INSERT fallido (línea 517):**
```sql
INSERT INTO mp_financial_movement (
  account_id, source_id, movement_class, settlement_amount,
  transaction_date, needs_review
)
VALUES (
  p_account_id, v_source_id, 'PAYOUT', v_signed_impact,
  (v_row->>'DATE')::TIMESTAMP, FALSE
)
```

Si se ejecuta como está en el código LOCAL → `movement_class = 'PAYOUT'` ✓

Si falla con `movement_class = NULL` → Versión desplegada es diferente ✗

---

## Por qué no falló en chunks 1-8

Los primeros 400 rows (chunks 1-8) devolvieron:
- created_source_records: 0
- created_financial_movements: 0
- created_ledger_entries: 0

Esto significa que NO se ejecutó el INSERT en absoluto. Posibles causas:

1. **Todos los rows ya existían** (idempotent): Layer 1 encontró match por payload_hash
2. **Todos los rows eran raw_only**: Aunque improbable para Report
3. **Todos encontraron FM existente**: Layer 2 encontró match por economic_row_fp

Luego en chunk 9:
- Una o más rows encontraron un SR nuevo que necesitaba nuevo FM
- Al intentar el INSERT, falló con movement_class=NULL

---

## Conclusión Provisional

El ERROR REAL es que la **RPC desplegada en Supabase es DIFERENTE del código en `008_reconciliation_rpc.sql`**.

**Próximo paso:** Ejecutar `DEBUG_RPC_SIGNATURES.sql` en Supabase para ver la definición actual desplegada.
