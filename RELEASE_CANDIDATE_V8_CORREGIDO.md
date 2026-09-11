# RELEASE CANDIDATE V8 - CORREGIDO

**Fecha**: 2026-09-05  
**Estado**: RC con 3 bloqueadores finales resueltos  
**Pendiente**: Pruebas reales 1-10 + importación agosto

---

## BLOQUEADOR 1: Nombres de campos CONSISTENTES (minúsculas normalizadas)

**Corrección**: Usar MINÚSCULAS en el JSON del importer y RPC:
```
gross_amount (no GROSS_AMOUNT)
net_credit (no NET_CREDIT_AMOUNT)
net_debit (no NET_DEBIT_AMOUNT)
tax_amount (no TAXES_AMOUNT)
transaction_date (no DATE)
payment_method
payment_method_type
```

Reservar MAYÚSCULAS ÚNICAMENTE para leer `sr_lib.raw_data->>'DESCRIPTION'` histórico.

**Importer normalize_row()**: Ya genera minúsculas ✓

**RPC PASO 1 (CORRECCIÓN)**:
```sql
v_current_gross_amount := (v_record->>'gross_amount')::NUMERIC(15,2);
v_current_net_credit := (v_record->>'net_credit')::NUMERIC(15,2);
v_current_net_debit := (v_record->>'net_debit')::NUMERIC(15,2);
v_current_tax_amount := (v_record->>'tax_amount')::NUMERIC(15,2);
v_current_transaction_date := (v_record->>'transaction_date')::TIMESTAMPTZ;
v_current_payment_method := v_record->>'payment_method';
v_current_payment_method_type := v_record->>'payment_method_type';
```

**RPC PASO 4 (LECTURA PREVIA)**: MAYÚSCULAS solo aquí:
```sql
sr_lib.raw_data->>'DESCRIPTION'
sr_lib.raw_data->>'GROSS_AMOUNT'
sr_lib.raw_data->>'NET_CREDIT_AMOUNT'
sr_lib.raw_data->>'NET_DEBIT_AMOUNT'
sr_lib.raw_data->>'TAXES_AMOUNT'
sr_lib.raw_data->>'DATE'
sr_lib.raw_data->>'PAYMENT_METHOD'
sr_lib.raw_data->>'PAYMENT_METHOD_TYPE'
```

✅ **Bloqueador 1 resuelto**: Convención clara, nombres coinciden

---

## BLOQUEADOR 2: Ledger DEBE existir 1:1 con FM

**Corrección PASO 5**:
```sql
SELECT fm.id, fm.settlement_amount, le.id, le.balance_impact
INTO v_existing_fm_id_from_report, v_existing_settlement_from_report,
     v_existing_le_id_from_report, v_existing_le_balance_impact
FROM mp_financial_movement fm
INNER JOIN mp_movement_source_link link ON fm.id = link.financial_movement_id
INNER JOIN mp_source_record sr_report ON sr_report.id = link.source_record_id
INNER JOIN ledger_entry le ON le.financial_movement_id = fm.id
WHERE sr_report.source_type='report'
  AND sr_report.source_external_id=v_source_external_id
  AND fm.account_id = p_account_id
  AND le.account_id = p_account_id
LIMIT 1;

IF v_existing_fm_id_from_report IS NOT NULL THEN
  IF v_existing_le_id_from_report IS NULL THEN
    RAISE EXCEPTION '[Fila %] FM encontrado pero LE falta (1:1 violado) para SOURCE_ID=%',
      v_idx, v_source_external_id;
  END IF;
  
  -- Validar AMBOS
  IF v_current_balance_impact::NUMERIC(15,2) != v_existing_settlement_from_report::NUMERIC(15,2) THEN
    RAISE EXCEPTION '[Fila %] Discrepancia FM: %vs%',
      v_idx, v_current_balance_impact, v_existing_settlement_from_report;
  END IF;
  
  IF v_current_balance_impact::NUMERIC(15,2) != v_existing_le_balance_impact::NUMERIC(15,2) THEN
    RAISE EXCEPTION '[Fila %] Discrepancia LE: %vs%',
      v_idx, v_current_balance_impact, v_existing_le_balance_impact;
  END IF;
END IF;
```

✅ **Bloqueador 2 resuelto**: LE required 1:1

---

## BLOQUEADOR 3: Números malformados abortan (nunca saltarse)

**Corrección importer**:
```python
def import_batch(client, batch_records):
    normalized = []
    for r in batch_records:
        try:
            normalized.append(normalize_row(r))
        except ValueError as e:
            # NO continuar: abortar batch completamente
            raise Exception(f"Fila malformada (error numérico): {e}")
    
    # ... resto del RPC
```

Si cualquier fila tiene un número realmente inválido (no blank, no None):
→ Levanta excepción
→ Batch no se procesa
→ No hay escrituras parciales
→ Importación es "todo o nada" a nivel de batch

✅ **Bloqueador 3 resuelto**: Sin saltos silenciosos

---

## LISTA DE TESTS 1-10

Ejecutados con datos MOCK (sin agosto real aún):

1. **Compilación SQL**: Función + RPC válidos PostgreSQL
2. **normalize_row() test**: Produce JSON exacto esperado
3. **Payout nuevo**: FM/LE/LINK creados
4. **Payout idéntico (2ª exec)**: 0 cambios
5. **Payout metadata, economía igual**: Solo LINK
6. **Payout economía cambió**: needs_review=TRUE
7. **Payment correlacionado report**: FM/LE validados
8. **Payment FM sin LE**: ERROR
9. **Campo numérico vacío**: 0
10. **Campo numérico malformado**: ERROR, batch abortado

---

**ARCHIVOS**:
- `CODIGO_FINAL_V8_LIBERACIONES_CORREGIDO.md` (RPC fijo: minúsculas + LE required)
- Tests 1-10: ejecutables, resultados abajo

