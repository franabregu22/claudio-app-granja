# FASE 0: CIERRE OFICIAL — JULIO Y AGOSTO 2026

**Fecha de cierre:** 2026-09-07  
**Account:** 1054315166  
**Estado:** ✅ COMPLETADA Y VALIDADA  

---

## 1. OBJETIVO DE FASE 0

Integrar histórico de movimientos MercadoPago (Liberaciones3 reportes) para dos períodos piloto:
- **Julio 2026:** 640 registros, 16 payouts faltantes recuperados
- **Agosto 2026:** 798 registros, 10 payouts faltantes recuperados

Validar arquitectura versionable (raw/normalized/ledger) sin modificaciones funcionales ni interfaz.

---

## 2. ARQUITECTURA UTILIZADA

**Tres capas (ya implementadas en PRODUCTION):**

```
Liberaciones3 CSV
    ↓
mp_source_record (source_type = 'liberaciones' | 'report')
    ↓
mp_movement_source_link (payload_hash deduplicación ON CONFLICT)
    ↓
mp_financial_movement (reutiliza FMs existentes o crea payouts)
    ↓
ledger_entry (1:1 con FM, calc_ledger_balance)
```

**RPC:** `import_liberaciones_primary()` v8 — idempotente, versionable, batch por lote.

---

## 3. FUENTES UTILIZADAS

### Julio
- **Audit:** `data/mercadopago/Liberaciones3_julio_2026.csv` (641 filas, incluye opening)
- **Import:** `data/mercadopago/Liberaciones3_julio_2026_IMPORT.csv` (640 filas, sin opening)

### Agosto
- **Audit:** `data/mercadopago/Liberaciones3_agosto_2026.csv` (799 filas, incluye opening)
- **Import:** `data/mercadopago/Liberaciones3_agosto_2026.csv` (798 filas, sin opening — mismo archivo)

---

## 4. REGLAS DE CORRELACIÓN

### Definitivas (payment + asset_management)

Julio: 572 SOURCE_IDs únicos  
Agosto: 716 SOURCE_IDs únicos

**Precedencia:**
1. Misma fuente (versionado): mismo SOURCE_ID → mismo FM (reutilizar)
2. Cross-source (report): SOURCE_ID único → 1 FM report existente
3. Si no encuentra: crear FM (solo payouts)

**Resultado:**
- Julio: 572/572 correlacionados (0 faltas, 0 múltiples)
- Agosto: 716/716 correlacionados (0 faltas, 0 múltiples)

### RAW-Only (reserves)

No se importan como FM/LE.  
Se registran como `source_record` con `payload_hash` único.  
Preservan integridad de datos para auditoría.

**Julio:** 52 RAW-only  
**Agosto:** 72 RAW-only

---

## 5. TRATAMIENTO DE PAYOUTS

**Payouts de Liberaciones:** son diferencias netas de settlement.  
**Clasificación interna:** `movement_class = 'unclassified'` (no cambiar).  
**Source:** `source_type = 'liberaciones'`.

Julio: 16 payouts → -14,695,521.00  
Agosto: 10 payouts → -10,904,815.29

Ambos registrados como FM nuevos (no correlacionaban con payment/asset).

---

## 6. TRATAMIENTO DE OPENING/CHECKPOINT

**Julio opening (2026-07-04 00:00:00):**
- SOURCE_ID vacío
- DESCRIPTION vacía
- BALANCE_AMOUNT 5,080,770.69
- **NO importado** (RPC rechaza NULL/blank SOURCE_ID)
- **Preservado** en audit CSV para auditoría (no eliminado)

**Agosto opening:** similar, no importado.

---

## 7. VALIDACIÓN ESTRUCTURAL JULIO

### Pre-import
- **Ledger 01-31/07:** 9,937,335.27
- **572 correlacionados esperados:** 9,810,316.45
- **Extras 01-03/07 (fuera período Liberaciones):** 127,018.82
- **Suma:** 9,810,316.45 + 127,018.82 = 9,937,335.27 ✓

### Primera corrida
```
source_records_created = 640
source_records_existing = 0
source_records_raw_only = 52
financial_movements_created = 16
ledger_entries_created = 16
movement_source_links_created = 588
```

### Segunda corrida (idempotencia)
```
source_records_created = 0
source_records_existing = 640
financial_movements_created = 0
ledger_entries_created = 0
movement_source_links_created = 0
```

### Post validación
```
fm_total = 4132 (4116 + 16)
le_total = 4132 (4116 + 16)
needs_review = 2
ledger_julio = -4,758,185.73 (9,937,335.27 - 14,695,521.00)
```

✅ **Idempotencia confirmada:** POST1 = POST2

---

## 8. VALIDACIÓN ESTRUCTURAL AGOSTO

### Primera corrida
```
source_records_created = 798
source_records_existing = 0
source_records_raw_only = 72
financial_movements_created = 10
ledger_entries_created = 10
movement_source_links_created = 726
```

### Segunda corrida (idempotencia)
```
source_records_created = 0
source_records_existing = 798
financial_movements_created = 0
ledger_entries_created = 0
movement_source_links_created = 0
```

### Post validación
```
fm_total = 4116
le_total = 4116
needs_review = 2
ledger_agosto = -124,203.24
```

✅ **Idempotencia confirmada**

---

## 9. RESIDUAL CONOCIDO: AGOSTO -0.03

**Diferencia observada:**
- UI observó: -124,203.27
- Ledger/report calculado: -124,203.24
- Variancia: -0.03

**Status:** Identificada, documentada, NO clasificada como rounding sin análisis posterior.  
**Acción:** Investigar en FASE siguiente (posible double-rounding en UI o timestamp de reconciliación).

---

## 10. ARCHIVOS CRÍTICOS (NO ELIMINAR)

### SQLs de import y validación
- `sql/006_import_liberaciones_primary_PRODUCTION.sql` — RPC principal v8
- `sql/007_validate_production_setup.sql` — Validación firma/setup
- `sql/008_post_import_validation.sql` — Estado post-import

### SQLs de auditoría Julio
- `sql/009_pre_correlate_julio_WITH_IDS.sql` — Correlación 572 SOURCE_IDs
- `sql/010_snapshot_pre_import_julio_CORRECTED.sql` — Snapshot pre
- `sql/011_audit_ledger_julio_gap_CORRECTED.sql` — Auditoría ledger gap
- `sql/012_list_ledger_julio_extras.sql` — Listado de 11 movimientos extra
- `sql/013_post_import_julio_validation.sql` — Post julio
- `sql/014_validate_16_payouts_julio.sql` — Validación 16 payouts

### Checkpoints
- `liberaciones_import_result_FIRST_RUN_JULIO_2026.json` — Checkpoint julio
- `liberaciones_import_result_FIRST_RUN_AGOSTO_2026.json` — Checkpoint agosto

### Rollbacks (preservados, NO ejecutados)
- `sql/rollback_liberaciones_FIRST_RUN_JULIO_2026.sql`
- `sql/rollback_liberaciones_FIRST_RUN_AGOSTO_2026.sql`

### Datos originales
- `data/mercadopago/Liberaciones3_julio_2026.csv` — Con opening
- `data/mercadopago/Liberaciones3_julio_2026_IMPORT.csv` — Sin opening
- `data/mercadopago/Liberaciones3_agosto_2026.csv` — Original

---

## 11. PENDIENTES DOCUMENTADOS (NO RESOLVER EN FASE 0)

### A. Residual agosto -0.03
Investigar causa exacta en FASE 1.  
Posibles fuentes: rounding UI vs report, timestamp de reconciliación, precision de cálculos.

### B. Extensión histórica
Aplicar mismo procedimiento a períodos anteriores (mayo, junio, abril).  
Validar por mes/período, preservar checkpoints separados.

### C. Reconciliación contable formal
Implementar validación:
```
opening_balance + ∑ledger_movements = observed_balance
```

### D. UI de conciliación
Agregar vistas:
- Calculated balance vs Observed balance
- Variance tracking
- needs_review flag propagación

### E. Clasificación de payouts
Actualmente: `movement_class = 'unclassified'`  
Revisar SOLO si necesita distinguir tipos funcionales:
- Transferencias propias
- Liquidaciones QR
- Impuestos
- Otros

No cambiar ahora.

---

## 12. RESTRICCIONES PARA FUTURAS IMPORTACIONES

✅ **PERMITIDO:**
- Importar meses nuevos siguiendo este procedimiento
- Ejecutar segunda corrida (idempotencia test)
- Generar rollbacks nuevos (preservar checkpoints)
- Leer datos para auditoría/validación
- Modificar UI/reports (no ledger/FM)

❌ **PROHIBIDO (hasta FASE 1+):**
- Modificar RPC de import
- Cambiar versionado o reglas de correlación
- Borrar o sobrescribir FIRST_RUN checkpoints
- Ejecutar rollbacks sin documentación explícita
- Modificar ledger_entry directamente
- Cambiar movement_class de payouts

---

## 13. ESTADO GLOBAL FINAL

| Métrica | Valor |
|---------|-------|
| **Account ID** | 1054315166 |
| **FM total** | 4,132 |
| **LE total** | 4,132 |
| **needs_review** | 2 |
| **Ledger julio** | -4,758,185.73 |
| **Ledger agosto** | -124,203.24 |

---

## 14. CRITERIOS PARA PRÓXIMAS IMPORTACIONES

1. **Crear checkpoint previo** a cualquier import
2. **Ejecutar primera corrida** controlada (batch por batch, inspeccionar)
3. **Validar POST** (FM total, LE total, ledger sums)
4. **Ejecutar segunda corrida** (debe ser 100% idempotente)
5. **Preservar FIRST_RUN checkpoint** con nombre descriptivo
6. **Generar rollback** desde checkpoint (NO ejecutar)
7. **Documentar** en este mismo archivo o nueva sección

---

## 15. FIRMAS Y AUDITORÍA

**Última modificación:** 2026-09-07 09:37:14  
**Modificado por:** Import automation v8  
**Estado:** LOCKED (no modificar sin FASE 1 autorización)

---

**FIN FASE 0**
