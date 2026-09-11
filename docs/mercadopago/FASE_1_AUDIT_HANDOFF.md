# FASE 1: AUDIT HANDOFF — ESTADO PARA NUEVA SESIÓN

**Fecha creación:** 2026-09-07  
**Sesión anterior:** Resumida por contexto window limit  
**Estado:** LISTO PARA AUDITORÍA READ-ONLY  

---

## FASE 0: ESTADO CERRADO Y LOCKED

✅ **COMPLETADA Y VALIDADA:** 2026-09-07  
📋 **Documento oficial:** `docs/mercadopago/FASE_0_CIERRE_JULIO_AGOSTO_2026.md`  
🔒 **Restricción:** No modificar FASE 0 datos, RPC, versionado, ni reglas de correlación  

---

## PARÁMETROS CONTABLES GLOBALES

**Account ID:** 1054315166  
**Opening Balance:** 0  
**Opening Date:** 2026-01-01 (inicio del día, inclusivo)  
**Timezone Contable:** America/Argentina/Buenos_Aires  
**Convención Fecha:** DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')  

---

## VALORES FASE 0 — CONFIRMADOS (NO INTERPRETAR COMO SALDOS SIN CÁLCULO)

### JULIO 2026

| Métrica | Valor | Semántica |
|---------|-------|-----------|
| **movement_sum final** | -4,758,185.73 | ∑balance_impact de período 07-01 a 07-31 |
| **ledger pre-Liberaciones (07-01 a 07-31)** | +9,937,335.27 | Saldo acumulado de otros orígenes antes de payouts |
| **572 correlacionados (Liberaciones3 + Account Money)** | +9,810,316.45 | Parte de pre-Liberaciones (período importado) |
| **11 extras (07-01 a 07-03)** | +127,018.82 | Antes de que Liberaciones inicie (07-04); source_type = report |
| **16 payouts (Liberaciones)** | -14,695,521.00 | settlement_amount negativo; movement_class = unclassified |
| **Observación UI cierre 31/07** | NULL | NO CONFIRMADA; no inventar |

**Nota crítica:** Valores anteriores SON NETOS DE PERÍODO, NO saldos acumulados. El saldo acumulado al 31/07 es suma de opening_balance (0) + todos los movimientos desde 2026-01-01 hasta 07-31.

### AGOSTO 2026

| Métrica | Valor | Semántica |
|---------|-------|-----------|
| **movement_sum final** | -124,203.24 | ∑balance_impact de período 08-01 a 08-31 |
| **Account Money (compartido con julio)** | +10,780,612.05 | Parte que cruza ambos períodos |
| **10 payouts (Liberaciones)** | -10,904,815.29 | settlement_amount negativo; movement_class = unclassified |
| **UI entradas observadas** | +13,337,721.84 | Fuente desconocida (no en ledger desagregado) |
| **UI salidas observadas** | -13,461,925.11 | Fuente desconocida |
| **UI neto observado** | -124,203.27 | Diferencia vs ledger -124,203.24 = -0.03 |
| **Observación UI cierre 31/08** | -124,203.27 | SEMÁNTICA AÚN NO CONFIRMADA |

**Semántica crítica pendiente:** -124,203.27 ¿es saldo acumulado de cuenta o neto del período? NO crear snapshot hasta auditar. El -0.03 residual podría ser:
- Rounding en UI vs cálculo DB
- Timestamp de reconciliación diferente
- Movimiento de medianoche UTC/ART

---

## ARQUITECTURA FASE 0

```
Liberaciones3 CSV + Account Money
    ↓
mp_source_record (versionable, raw-only para reserves)
    ↓
mp_movement_source_link (payload_hash deduplicación ON CONFLICT)
    ↓
mp_financial_movement (1:1 con ledger_entry)
    ↓
ledger_entry (1:1 con FM; balance_impact acumulable)
    ↓
account_balance (trigger auto-calcula daily, campo calculated_balance)
```

**Propiedades:**
- ✅ Correlación: 572 SOURCE_IDs julio, 716 agosto (100% cobertura, 0 faltas)
- ✅ RAW-only: 52 reserves julio, 72 agosto (no FM/LE)
- ✅ Payouts: 16 julio (-14.7M), 10 agosto (-10.9M)
- ✅ Idempotencia: segunda corrida = 0 cambios en ambos meses
- ✅ Checkpoints: `liberaciones_import_result_FIRST_RUN_*.json` preservados
- ✅ Rollbacks: `sql/rollback_liberaciones_FIRST_RUN_*.sql` generados, NO ejecutados
- ✅ Opening/checkpoint: no son transacciones, rechazados por RPC (NULL SOURCE_ID)

---

## DECISIONES FASE 1 YA APROBADAS

### D1: Residual Agosto -0.03
✅ **DECISIÓN:** Mantener sin alterar ledger  
- No inventar observación ficticia  
- Estado inicial: `needs_investigation` (NO auto-approved)  
- Usuario puede cambiar a `variance_approved` con nota + reconciled_by + reconciled_at  

### D2: Observaciones sin cobertura
✅ **DECISIÓN:** Permitir observaciones antes de importar período  
- reconciliation_snapshot puede tener balance_date sin datos importados  
- LO QUE SE BLOQUEA: marcar monthly_reconciliation.status = reconciled si import_coverage != complete  

### D3: Campos de reconciliación en account_balance
✅ **DECISIÓN RECHAZADA:** Mantener separación de responsabilidades  
- account_balance = cache operativo (balance_calculated diario)  
- reconciliation_snapshot = evidencia histórica (múltiples observaciones)  
- monthly_reconciliation = decisión formal (status)  
- NO duplicar ownership de status  

### Correcciones conceptuales incorporadas
- ✅ reconciliation_snapshot versionable (sin UNIQUE en account_id, balance_date)  
- ✅ NO fabricar closing_balance_observed de julio  
- ✅ Agosto con status = needs_investigation (residual documentado)  
- ✅ Separación clara de responsabilidades (operativo vs historial vs decisión)  
- ✅ Campos derivados en queries, no persistentes  
- ✅ Timezone documentado como blocker para enero-junio  

---

## AUDITORÍA PENDIENTE EXACTA

**Scope:** READ-ONLY. Sin INSERT, UPDATE, DELETE, migraciones.

### 1. SQL REAL de calculate_ledger_balance()
Obtener definición completa de función en supabase/migrations/004.  
Buscar líneas con `DATE(occurred_at)` — esperado: sin `AT TIME ZONE`.  

### 2. SQL REAL de trigger trg_update_balance_on_ledger
Obtener definición completa en supabase/migrations/004.  
Buscar líneas con `DATE(NEW.occurred_at)` — esperado: sin `AT TIME ZONE`.  
Obtener función asociada update_account_balance_on_ledger().  

### 3. Schema REAL de account_balance
Confirmar campos actuales (opening_balance, opening_balance_date, calculated_balance, observed_balance_mp, variance, variance_note, etc).  
Confirmar índices y constraints.  

### 4. Confirmar tabla accounts
¿Existe tabla `accounts` en schema?  
¿Tiene PK id y FK account_id?  
¿O debe crearse para FASE 1?  

### 5. Calcular balances acumulados (READ-ONLY queries)
```
a) balance al 2026-06-30:
   opening_balance (0) + SUM(balance_impact) 
   donde DATE(occurred_at AT TIME ZONE 'ART') <= 2026-06-30

b) movement_sum solo julio:
   SUM(balance_impact)
   donde DATE(occurred_at AT TIME ZONE 'ART') BETWEEN 2026-07-01 AND 2026-07-31

c) balance al 2026-07-31:
   opening_balance (0) + SUM(balance_impact)
   donde DATE(occurred_at AT TIME ZONE 'ART') <= 2026-07-31

d) movement_sum solo agosto:
   SUM(balance_impact)
   donde DATE(occurred_at AT TIME ZONE 'ART') BETWEEN 2026-08-01 AND 2026-08-31

e) balance al 2026-08-31:
   opening_balance (0) + SUM(balance_impact)
   donde DATE(occurred_at AT TIME ZONE 'ART') <= 2026-08-31
```

### 6. Validar ecuaciones contables
```
balance_06_30 + movement_sum_julio = balance_07_31  ✓ o ✗
balance_07_31 + movement_sum_agosto = balance_08_31  ✓ o ✗
```

### 7. Comparar cálculos con timezone
Ejecutar balances con:
- a) Función actual calculate_ledger_balance() (con DATE(occurred_at) sin ART)
- b) Query explícita con DATE(occurred_at AT TIME ZONE 'ART')

Comparar resultados: ¿son iguales?

### 8. Auditar zona de riesgo medianoche UTC
Contar movimientos donde:
- DATE(occurred_at AT TIME ZONE 'UTC') != DATE(occurred_at AT TIME ZONE 'ART')
- Para julio y agosto

Esperado: Bajo/0 (si hay resultados, hay riesgo de error de 1 día).

### 9. Impacto monetario de movimientos de medianoche
Si hay movimientos en zona de riesgo:
- Calcular balance_impact total de esos movimientos
- Determinar si impacta significativamente en cierre mensual

### 10. Confirmar semántica de -124,203.27
Hipótesis: Es neto de período, no saldo acumulado.  
Evidencia: Comparar con balance_acumulado_08_31.  
- Si balance_08_31 != -124,203.27 → es neto de período ✓  
- Si balance_08_31 == -124,203.27 → es coincidencia (requiere investigación)  

### 11. Auditar coverage real julio/agosto
Verificar que import_coverage debería ser 'complete' para ambos:
- ¿Tenemos ALL movimientos de Account Money para julio?
- ¿Tenemos ALL movimientos de Liberaciones para julio?
- ¿Same para agosto?
- ¿O hay gaps documentados?

### 12. Evaluar reconciliation_snapshot inmutable
Propuesta: immutable con supersedes_snapshot_id FK.  
Preguntas:
- ¿Es mejor versionable (múltiples observaciones sin FK) o with supersedes?
- ¿Permite auditoría de correcciones (quién cambió la observación)?

### 13. Recomendar modelo monthly_reconciliation
Opciones:
- **A) Materializado:** Guardar opening/closing/variance como snapshot histórico. Derivados (movement_count, movement_sum) en queries.
- **B) Decision+Evidencia:** Guardar SOLO status + referencia a reconciliation_snapshot. Todo lo demás se calcula en view.

Evaluar pros/cons (performance, auditabilidad, stale data risk).

### 14. Resolver modelo final de coverage + status
```
coverage IN ('none', 'partial', 'complete', 'unknown')
status IN ('pending', 'reconciled', 'needs_investigation', 'variance_approved', 'no_data', 'partial_data')
```

Matriz válida de estados: ¿qué combinaciones son lógicas?
Ejemplo:
- coverage='none' → status DEBE ser 'no_data'
- coverage='complete' → status PUEDE ser 'pending', 'reconciled', 'needs_investigation', 'variance_approved'

### 15. Actualizar FASE_1_DESIGN_RECONCILIATION.md
**SOLO DESPUÉS** de tener evidencia de los 14 puntos anteriores.  
NO modificar hasta auditoría completa.

---

## RESTRICCIONES ESTRICTAS

### ❌ PROHIBIDO:
- INSERT en cualquier tabla (especialmente ledger_entry, mp_financial_movement, reconciliation_snapshot)
- UPDATE en ledger_entry, mp_financial_movement, o FASE 0 datos
- DELETE en FASE 0 datos
- Ejecutar migraciones
- Ejecutar importaciones (RPC de import)
- Ejecutar rollbacks
- Cambios en calculate_ledger_balance() o trigger sin aprobación
- Modificar FASE 0 RPC

### ✅ PERMITIDO:
- SELECT / READ queries
- Crear nuevas tablas (migraciones FUTURAS, no ejecutadas)
- Documentar hallazgos
- Mostrar SQL propuesto (sin ejecutar)
- Análisis y recomendaciones

---

## ARCHIVOS DE REFERENCIA (NO MODIFICAR)

**FASE 0 oficial:**
- `docs/mercadopago/FASE_0_CIERRE_JULIO_AGOSTO_2026.md` (LOCKED)

**FASE 1 diseños (a auditar):**
- `docs/mercadopago/FASE_1_DESIGN_RECONCILIATION.md` (tiene error conceptual)
- `docs/mercadopago/FASE_1_AUDIT_ACTUAL_IMPLEMENTATION.md` (análisis de código actual)
- `docs/mercadopago/FASE_1_DESIGN_FINAL_APPROVED.md` (propuesta con correcciones D1-D3)

**Checkpoints FASE 0:**
- `liberaciones_import_result_FIRST_RUN_JULIO_2026.json`
- `liberaciones_import_result_FIRST_RUN_AGOSTO_2026.json`

**Rollbacks preservados (NO ejecutar):**
- `sql/rollback_liberaciones_FIRST_RUN_JULIO_2026.sql`
- `sql/rollback_liberaciones_FIRST_RUN_AGOSTO_2026.sql`

**SQL de auditoría:**
- `sql/009_pre_correlate_julio_WITH_IDS.sql`
- `sql/010_snapshot_pre_import_julio_CORRECTED.sql`
- `sql/011_audit_ledger_julio_gap_CORRECTED.sql`
- `sql/012_list_ledger_julio_extras_FIXED.sql`
- `sql/014_validate_16_payouts_julio_FIXED.sql`

---

## PRÓXIMOS PASOS (NUEVA SESIÓN)

1. **Leer este handoff** (contexto de estado)
2. **Ejecutar auditoría READ-ONLY** (15 puntos, solo SELECT)
3. **Documentar hallazgos** en FASE_1_AUDIT_FINDINGS.md (nueva sesión)
4. **Actualizar FASE_1_DESIGN_RECONCILIATION.md** con evidencia
5. **Obtener aprobación usuario** antes de migraciones
6. **Crear migraciones** (007_reconciliation_snapshot, 008_import_period_coverage, 009_monthly_reconciliation)

---

**Estado:** LISTO PARA AUDITORÍA  
**Sesión anterior cerrada:** 2026-09-07  
**No requiere aprobación:** Este es handoff técnico, no cambios en BD  

