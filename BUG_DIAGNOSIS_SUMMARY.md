# Bug Diagnosis: movement_class = NULL en import_financial_movements_reconciliation_v2

## El Problema

El chunk 9 falla cuando intenta hacer INSERT a `mp_financial_movement`:
```
Error: null value in column "movement_class" violates not-null constraint
Failing row: id=4284, account_id=1054315166, settlement_amount=1629.44, movement_class=NULL
```

Los primeros 400 rows (chunks 1-8) procesaron sin errores pero tampoco crearon registros (todos los contadores en 0).

---

## Qué DEBERÍA ocurrir (según código LOCAL)

Para una fila Report con:
- `TRANSACTION_TYPE`: "SETTLEMENT"
- `SETTLEMENT_NET_AMOUNT`: 1629.44

### Flujo esperado:
```
1. Determinar v_economic_class:
   map_to_economic_class('report', 'SETTLEMENT') → 'PAYMENT'

2. Si no existe SR previo → crear mp_source_record

3. Si no existe FM con economic_row_fp → INSERT a mp_financial_movement:
   
   INSERT INTO mp_financial_movement (
     account_id, source_id, movement_class, settlement_amount, ...
   )
   VALUES (
     1054315166, 
     v_source_id, 
     'PAYOUT',              ← HARDCODED en el código LOCAL
     1629.44,
     ...
   )
   
   ✓ movement_class = 'PAYOUT' (nunca NULL si se ejecuta como está en LOCAL)
```

---

## Dónde se pierde el valor

**Línea 517-524 en `008_reconciliation_rpc.sql` (RPC import function)**

```sql
-- Cuando: NO encuentra FM existente, necesita crear nuevo
IF NOT v_is_raw_only THEN
  IF p_source_type = 'report' THEN
    SELECT * INTO v_existing_fm FROM get_existing_fm_by_econ_fp(...);
  ...
  END IF;

  IF FOUND AND v_existing_fm IS NOT NULL THEN
    -- Link to existing FM
    INSERT INTO mp_movement_source_link ...
  ELSE
    -- ← ESTA RAMA FALLA EN CHUNK 9
    INSERT INTO mp_financial_movement (
      account_id, source_id, movement_class, settlement_amount,
      transaction_date, needs_review
    )
    VALUES (
      p_account_id, v_source_id, 'PAYOUT', v_signed_impact,
      (v_row->>'DATE')::TIMESTAMP, FALSE
    )
    RETURNING id INTO v_new_fm_id;
    
    -- Si llega aquí con movement_class='PAYOUT' → OK
    -- Si llega aquí con movement_class=NULL → ERROR (lo que pasó en chunk 9)
  END IF;
END IF;
```

---

## Por qué los chunks 1-8 devolvieron 0 en todo

Los primeros 400 rows todos devolvieron:
```
created_source_records: 0
created_financial_movements: 0
created_ledger_entries: 0
```

Esto significa que **NINGUNO ejecutó el INSERT**. Por lo tanto, ni siquiera llegó a la rama que fallaría.

Hipótesis: Todos fueron idempotentes (SR ya existe) o todos encontraron FM existente.

---

## Conclusión: RPC Desplegada ≠ Código LOCAL

El código en `008_reconciliation_rpc.sql` tiene hardcoded `'PAYOUT'`:
```sql
VALUES (
  p_account_id, v_source_id, 'PAYOUT', v_signed_impact,
  ...
)
```

Pero el error muestra `movement_class=NULL`, lo cual significa:

1. **La versión desplegada en Supabase es DIFERENTE**
2. O tiene un bug donde pasa NULL en lugar de 'PAYOUT'
3. O intenta usar una variable que es NULL

---

## Pasos siguientes (SIN EJECUTAR)

### 1. Query READ-ONLY a ejecutar en Supabase SQL Editor

Archivo: `DEBUG_RPC_SIGNATURES.sql`

Esta query inspeccionará:
- La definición actual desplegada de `import_financial_movements_reconciliation_v2`
- La definición actual desplegada de `map_to_economic_class`
- El estado actual de la fila 4284 que falló
- Los constraints de la tabla `mp_financial_movement`
- Cualquier trigger que pueda estar NULLing campos

### 2. Qué buscar en la salida de la query

En la definición de `import_financial_movements_reconciliation_v2`, buscar:

```
✗ Malo: INSERT INTO mp_financial_movement ... VALUES (..., NULL, ...)
✗ Malo: INSERT INTO mp_financial_movement ... VALUES (..., v_undefined_var, ...)
✓ Bueno: INSERT INTO mp_financial_movement ... VALUES (..., 'PAYOUT', ...)
✓ Bueno: INSERT INTO mp_financial_movement ... VALUES (..., v_economic_class, ...)
```

Si dice NULL o usa una variable, eso explica el bug.

---

## Lo que NO voy a hacer

- No ejecutaré queries de escritura ni rollbacks
- No modificaré la RPC (como pidió)
- No haré cambios a ningún archivo SQL en Supabase

El análisis es **READ-ONLY puro** hasta confirmar el bug.
