# LISTO PARA EJECUTAR

**Fecha:** 2026-09-11  
**Status:** Todos los archivos preparados, sin ejecutar nada  
**Próxima acción:** Ejecutar PASO 1

---

## ARCHIVOS GENERADOS

### A) SQL DE MIGRACIÓN (migration 010)
**Archivo:** `supabase/migrations/010_fix_import_v2_classifications.sql`
- ✓ Correcciones de clasificación 4-class
- ✓ is_raw_only() simplificada
- ✓ v_movement_class_final + v_ledger_category_final
- ✓ Listo para aplicar (Paso 2)

### B) SQL DE TEST
**Archivo:** `TEST_FINAL_BEGIN_ROLLBACK.sql`
- ✓ 4 filas de test (payment+, payment-, asset_mgmt, payout)
- ✓ 1ª ejecución → 4 SR/FM/LE
- ✓ 2ª ejecución → 0 nuevos (idempotencia)
- ✓ ROLLBACK automático
- ✓ Validaciones de clasificación correcta
- ✓ Listo para ejecutar (Paso 1 y 3)

### C) CAMBIOS NETLIFY
**Archivo:** `CAMBIOS_NETLIFY_SYNC_RELEASES_STATUS.md`
- ✓ 4 cambios específicos documentados
- ✓ Ignorar control rows (opening/closing sin SOURCE_ID)
- ✓ buildInputRowForRPC() helper (centavos→pesos)
- ✓ Bloquear/reportar unknown
- ✓ Listo para aplicar manualmente (Paso 4)

### D) ORDEN DE EJECUCIÓN
**Archivo:** `ORDEN_EXACTA_EJECUCION.md`
- ✓ 8 pasos detallados
- ✓ Validaciones esperadas en cada paso
- ✓ Checklist final
- ✓ Guía de referencia

---

## ESTADO ACTUAL

| Componente | Estado |
|-----------|--------|
| migration 010 | ✓ Generado, NO APLICADO |
| Test SQL | ✓ Generado, NO EJECUTADO |
| Cambios Netlify | ✓ Documentados, NO APLICADOS |
| BD (mp_source_record) | Sin cambios (264 registros) |
| BD (mp_financial_movement) | Sin cambios (4198 registros) |
| BD (ledger_entry) | Sin cambios (4198 registros) |

---

## FLUJO ESPERADO

```
PASO 1: Test BEGIN/ROLLBACK
  ↓ Si PASS
PASO 2: Aplicar migration 010
  ↓
PASO 3: Repetir test
  ↓ Si PASS
PASO 4: Aplicar cambios Netlify
  ↓
PASO 5: Test sobre reporte 65330696
  ↓ Si PASS
PASO 6: Commit real del reporte
  ↓
PASO 7: Git commit
  ↓
PASO 8: Forward-looking (futuro)
```

---

## VALIDACIONES CLAVE

**Paso 1/3 (Test transaccional):**
- ✓ fm_payment_in = 1 (payment +100)
- ✓ fm_payment_out = 1 (payment -40)
- ✓ fm_yield = 1 (asset_mgmt +5)
- ✓ fm_transfer_out = 1 (payout -20)
- ✓ 2ª ejecución: sr_added_second = 0 (idempotencia)
- ✓ ROLLBACK: estado restaurado

**Paso 5/6 (Reporte 65330696):**
- ✓ 6 FM nuevos (no 8, control rows ignorados)
- ✓ 8 SR nuevos (6 contables + 2 reserves RAW-only)
- ✓ 6 LE nuevos (solo contables)
- ✓ delta = 115203.14
- ✓ Clasificaciones: 3x payment_in, 2x yield, 1x transfer_out

---

## CÓMO PROCEDER

### Opción A: Ejecución automática (yo dirijo)
Envía: "Ejecuta Paso 1"
Yo:
1. Corro test SQL
2. Reporto PASS/FAIL
3. Si PASS, avanzo a Paso 2
4. Continúo hasta completar

### Opción B: Ejecución manual (tú diriges)
Envías cada comando, yo reporto resultado
Más lento pero tienes control total

### Opción C: Híbrida
Tú ejecutas Pasos 1-3 (test + migration)
Yo ejecuto Pasos 4-7 (cambios + commit)

---

## SIN SORPRESAS

- ✗ Ningún INSERT/UPDATE/DELETE ejecutado
- ✗ 010 NO APLICADO
- ✗ Cambios Netlify NO APLICADOS
- ✗ Reporte 65330696 NO IMPORTADO
- ✓ Solo documentación + SQL preparados

---

## PRÓXIMO COMANDO

**EJECUTA:**
```
Paso 1: Copiar TEST_FINAL_BEGIN_ROLLBACK.sql → ejecutar en Supabase
```

**REPORTA:**
- Resultado de validación (PASS/FAIL)
- Si FAIL: error message exacto
