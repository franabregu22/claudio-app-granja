# ÍNDICE DE ARCHIVOS FINALES

**Preparado:** 2026-09-11  
**Próxima acción:** Ejecutar PASO 1

---

## ARCHIVOS CRÍTICOS (EJECUTAR EN ORDEN)

### 1. TEST_FINAL_BEGIN_ROLLBACK.sql [PASO 1 y 3]
- **Propósito:** Validar 010 con 4 clases + idempotencia + ROLLBACK
- **Contenido:** SQL BEGIN...ROLLBACK con 4 filas de test
- **Ejecución:** Copiar → Supabase SQL Editor → esperar ROLLBACK
- **Validación:** Verificar clasificaciones + idempotencia + restauración
- **Estado:** ✓ Listo, NO EJECUTADO

### 2. supabase/migrations/010_fix_import_v2_classifications.sql [PASO 2]
- **Propósito:** Aplicar correcciones de clasificación
- **Contenido:** 
  - DROP + CREATE is_raw_only()
  - DROP + CREATE import_v2 con v_movement_class_final
- **Ejecución:** Copiar → Supabase SQL Editor
- **Validación:** Confirmar funciones creadas
- **Estado:** ✓ Listo, NO APLICADO

### 3. CAMBIOS_NETLIFY_SYNC_RELEASES_STATUS.md [PASO 4]
- **Propósito:** Documentar 4 cambios en Netlify function
- **Contenido:**
  1. Ignorar control rows (sin SOURCE_ID)
  2. buildInputRowForRPC() helper
  3. Construir p_input_rows (centavos→pesos)
  4. Bloquear unknown + WARNING log
- **Ejecución:** Leer documento → aplicar cambios en editor
- **Archivo a modificar:** `netlify/functions/sync-mercadopago-releases-status.ts`
- **Estado:** ✓ Listo, NO APLICADO

---

## GUÍAS Y REFERENCIAS

### ORDEN_EXACTA_EJECUCION.md
- 8 pasos detallados
- Validaciones esperadas en cada paso
- Checklist final
- Guía paso-a-paso

### LISTO_PARA_EJECUTAR.md
- Resumen de estado
- Checklist de archivos
- Validaciones clave
- Próximas acciones

### ANALISIS_4_PROBLEMAS_CRITICOS.md [REFERENCIA]
- Análisis detallado de 4 problemas (histórico)
- Problemas ya resueltos en archivos finales
- No es necesario ejecutar

### RESPUESTA_A_7_PUNTOS.md [REFERENCIA]
- Análisis punto A-G (histórico)
- Ya incorporado en archivos finales
- No es necesario ejecutar

---

## ESTRUCTURA DE CARPETAS

```
c:\Users\Franabregu\Desktop\Claudio app Granja\
├── supabase/
│   └── migrations/
│       └── 010_fix_import_v2_classifications.sql          [PASO 2]
├── netlify/
│   └── functions/
│       └── sync-mercadopago-releases-status.ts             [PASO 4 - modificar]
├── TEST_FINAL_BEGIN_ROLLBACK.sql                          [PASO 1, 3]
├── CAMBIOS_NETLIFY_SYNC_RELEASES_STATUS.md               [PASO 4 - guía]
├── ORDEN_EXACTA_EJECUCION.md                              [REFERENCIA]
├── LISTO_PARA_EJECUTAR.md                                 [REFERENCIA]
├── INDICE_ARCHIVOS_FINALES.md                             [ESTE ARCHIVO]
└── ... (otros archivos históricos, ignorar)
```

---

## RESUMEN RÁPIDO

| Paso | Archivo | Acción |
|------|---------|--------|
| 1 | TEST_FINAL_BEGIN_ROLLBACK.sql | Ejecutar en Supabase |
| 2 | 010_fix_import_v2_classifications.sql | Ejecutar en Supabase |
| 3 | TEST_FINAL_BEGIN_ROLLBACK.sql | Ejecutar en Supabase (repetir) |
| 4 | CAMBIOS_NETLIFY_SYNC_RELEASES_STATUS.md | Aplicar cambios manualmente |
| 5-6 | [Validación + commit 65330696] | Ejecutar import_v2 |
| 7 | [Git commit] | Hacer commit |

---

## VALIDACIÓN FINAL

Después de Paso 7, estado esperado:
- mp_source_record: 270 (264 + 6 new)
- mp_financial_movement: 4204 (4198 + 6 new)
- ledger_entry: 4204 (4198 + 6 new)
- Total ledger impact: 288017.76 (172814.62 + 115203.14)

---

## PRÓXIMA ACCIÓN

**Envía comandato de confirmación:**
```
Paso 1
```

Y reportaré resultado.
