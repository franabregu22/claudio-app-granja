# ORDEN EXACTA DE EJECUCIÓN

**Fecha:** 2026-09-11  
**Punto de partida:** 
- migration 010 preparada (NOT APPLIED)
- test SQL preparado (NOT RUN)
- cambios Netlify documentados (NOT APPLIED)

---

## PASO 1: EJECUTAR TEST TRANSACCIONAL

**Archivo:** `TEST_FINAL_BEGIN_ROLLBACK.sql`

**Acción:**
1. Copiar SQL completo
2. Ejecutar en Supabase SQL Editor (o psql)
3. Esperar ROLLBACK automático

**Validaciones esperadas:**

```
✓ after_first:
  sr_added_first = 4
  fm_added_first = 4
  fm_payment_in = 1
  fm_payment_out = 1
  fm_yield = 1
  fm_transfer_out = 1

✓ after_second:
  sr_added_second = 0 (IDEMPOTENT)

✓ after_rollback:
  sr_final = baseline (restaurado)
  fm_final = baseline (restaurado)
  le_final = baseline (restaurado)
  link_final = baseline (restaurado)
```

**Si PASS:** Proceder a Paso 2

**Si FAIL:** Detener, investigar, reportar

---

## PASO 2: APLICAR MIGRACIÓN 010

**Archivo:** `supabase/migrations/010_fix_import_v2_classifications.sql`

**Acción:**
1. Ejecutar en Supabase SQL Editor
2. Verificar creación de funciones

**Validación:**
```sql
-- Confirm functions exist
SELECT routine_name FROM information_schema.routines 
WHERE routine_name = 'import_financial_movements_reconciliation_v2';

-- Should return: import_financial_movements_reconciliation_v2
```

**Si SUCCESS:** Proceder a Paso 3

**Si ERROR:** Detener, no aplicar cambios Netlify

---

## PASO 3: REPETIR TEST TRANSACCIONAL

**Archivo:** `TEST_FINAL_BEGIN_ROLLBACK.sql` (mismo, segunda vez)

**Propósito:** Confirmar que migration 010 funciona correctamente

**Acción:**
1. Copiar SQL completo
2. Ejecutar en Supabase SQL Editor
3. Esperar ROLLBACK automático

**Validaciones:** Idénticas a Paso 1

**Si PASS:** Proceder a Paso 4

**Si FAIL:** Investigar bug en 010, posible ROLLBACK de migración 010

---

## PASO 4: APLICAR CAMBIOS EN NETLIFY FUNCTION

**Archivo:** `netlify/functions/sync-mercadopago-releases-status.ts`

**Cambios documentados en:** `CAMBIOS_NETLIFY_SYNC_RELEASES_STATUS.md`

**4 cambios específicos:**
1. Ignorar control rows sin SOURCE_ID (antes de cualquier lógica)
2. Nueva función helper: buildInputRowForRPC() (convertir centavos→pesos)
3. Construir p_input_rows con centavos→pesos (línea ~380+)
4. Bloquear unknown descriptions + WARNING log

**Acción:**
1. Abrir archivo en editor
2. Aplicar 4 cambios según especificación
3. Verificar sintaxis TypeScript
4. COMMIT (no push todavía)

**Git status esperado:**
```
M netlify/functions/sync-mercadopago-releases-status.ts
```

---

## PASO 5: EJECUTAR TEST CONTROLADO SOBRE REPORTE 65330696

**Propósito:** Primer commit real del reporte histórico

**Acción:**
1. DRY RUN debe reportar:
   ```
   csv_total_rows: 8
   csv_existing_in_supabase: 0
   csv_new_not_in_supabase: 8
   raw_only_reserves: { total: 0, duplicates: 0, new: 0 }
   financial_movements_valid: { duplicates: 0, new: 6 }
   unclassified_ambiguous: 0
   ledger_entries_would_create: 6
   neto: 115203.14
   ```

2. Llamar import_v2 con los 6 movimientos contables + 2 reserves

3. Verificar resultado:
   ```
   created_source_records: 8 (6 contables + 2 reserves)
   created_financial_movements: 6 (solo contables, reserves RAW-only)
   created_ledger_entries: 6 (solo contables)
   created_links: 6
   expected_delta: 115203.14
   ```

**Si PASS:** Proceder a Paso 6

**Si FAIL:** Detener, investigar discrepancia

---

## PASO 6: COMMIT DE REPORTE 65330696

**Acción:**
1. Ejecutar import_v2 sobre reporte 65330696 con commit=true
2. Verificar BD:
   ```sql
   SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166 AND source_type = 'report';
   -- Esperado: 270 (264 anteriores + 6 contables + 2 reserves + 2 de test anterior si se aplicó)
   
   SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166;
   -- Esperado: 4204 (4198 + 6 nuevos)
   
   SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166;
   -- Esperado: 4204 (4198 + 6 nuevos)
   
   SELECT SUM(le.balance_impact) FROM ledger_entry le
   INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
   WHERE mfm.account_id = 1054315166;
   -- Esperado: 172814.62 + 115203.14 = 288017.76
   ```

3. Verificar clasificaciones:
   ```sql
   SELECT movement_class, COUNT(*) 
   FROM mp_financial_movement 
   WHERE account_id = 1054315166 AND source_type = 'report'
   GROUP BY movement_class;
   -- payment_in: 3 (+ históricos)
   -- yield: 2 (asset_management)
   -- transfer_out: 1 (payout)
   ```

**Si PASS:** Reporte 65330696 importado exitosamente

---

## PASO 7: GIT COMMIT

**Acción:**
```bash
git add supabase/migrations/010_fix_import_v2_classifications.sql
git add netlify/functions/sync-mercadopago-releases-status.ts
git commit -m "Feat: Implement MercadoPago Release Report import with corrected 4-class classification

- migration 010: fix asset_management→yield, payment sign-based, payout→transfer_out
- sync-mercadopago-releases-status.ts: filter control rows, convert cents→pesos, block unknown
- Validated with test BEGIN/ROLLBACK (4 classes, idempotence, rollback)
- Report 65330696: 6 FM (172.77 + 77532 + 7455 + 7455 + 223.37 + 22365 = 115203.14)

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## PASO 8: FORWARD-LOOKING AUTOMATION (FUTURO)

**Status:** Desbloqueado después de Paso 7

**Próximos:**
1. Crear Netlify function para commit real (con MP_SYNC_WRITE_ENABLED env var)
2. Configurar dual-factor activation (env var + commit parameter)
3. Agendar forward-looking automático (24-hour lookback)

---

## CHECKLIST FINAL

- [ ] Test transaccional PASS (Paso 1)
- [ ] Migration 010 aplicada (Paso 2)
- [ ] Test transaccional repetido PASS (Paso 3)
- [ ] Cambios Netlify aplicados (Paso 4)
- [ ] Reporte 65330696 test PASS (Paso 5)
- [ ] Reporte 65330696 commit PASS (Paso 6)
- [ ] Git commit realizado (Paso 7)

**Estado:** BLOQUEADO en Paso 1 hasta tu ejecución

---

**Próxima acción:** Ejecutar Paso 1 (test BEGIN/ROLLBACK)
