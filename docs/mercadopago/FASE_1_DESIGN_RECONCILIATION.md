# FASE 1: RECONCILIATION SCHEMA — DISEÑO FINAL VALIDADO

**Fecha creación:** 2026-09-07  
**Última actualización:** 2026-09-07  
**Estado:** AUDITORÍA COMPLETA — LISTO PARA REVISIÓN SCHEMA  
**Auditoría:** `sql/FASE_1_AUDIT_ADVANCED_READ_ONLY.sql` (ejecutada, hallazgos confirmados)

---

## RESUMEN EJECUTIVO

FASE 1 implementa reconciliación de saldos para Mercado Pago con tres capas de datos:

1. **PERIOD COVERAGE** — ¿Los movimientos del mes están completos?
2. **BALANCE CHAIN COVERAGE** — ¿Toda la cadena histórica está completa? (derivado de period coverage)
3. **PERIOD FLOW RECONCILIATION** — ¿Los ingresos/egresos del mes coinciden con la observación UI?
4. **ACCOUNT BALANCE RECONCILIATION** — ¿El saldo acumulado al cierre coincide con MP?

---

## HALLAZGOS CRÍTICOS DE AUDITORÍA

### Timezone

**Configuración actual:**  
PostgreSQL `TimeZone` = `America/Argentina/Buenos_Aires`

**Impacto:**  
`DATE(occurred_at)` = `DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')`

60 movimientos difieren cuando se convierten a UTC, pero **en los cierres mensuales NO hay impacto** porque la diferencia se compensa dentro del mes.

**Deuda técnica:**  
Funciones contables (`calculate_ledger_balance()`, triggers) usan `DATE(occurred_at)` implícitamente. Para robustez futura, deberían ser explícitas: `DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')`.

### Cache Stale — BLOCKER ENCONTRADO

**Balance 31/08 en account_balance:**
- Cached: 54,308,471.80
- Function `calculate_ledger_balance()`: 39,612,950.80
- Diferencia: 14,695,521.00 (exactamente payouts julio)

**Causa:**  
El trigger `update_account_balance_on_ledger()` recalcula SOLO la fecha del movimiento insertado (`DATE(NEW.occurred_at)`), NO las fechas posteriores. Cuando se importaron payouts retroactivos de julio, agosto ya tenía balance_date precalculado → quedó stale.

**Conclusión:**  
`account_balance.calculated_balance` NO es confiable después de imports retroactivos. **FASE 1 debe calcular desde ledger en time de reconciliación, no del cache.**

### Coverage Confirmada

| Mes | Report | Liberaciones | Period | Balance Chain |
|-----|--------|--------------|--------|---------------|
| Enero | 0 | 0 | **NONE** | INCOMPLETE |
| Febrero | 442 (06/02→28) | 0 | **PARTIAL** | INCOMPLETE |
| Marzo | 633 | 0 | **PARTIAL** | INCOMPLETE |
| Abril | 430 | 0 | **PARTIAL** | INCOMPLETE |
| Mayo | 607 | 0 | **PARTIAL** | INCOMPLETE |
| Junio | 680 | 0 | **PARTIAL** | INCOMPLETE |
| Julio | 583 | 588 (04/07→31) | **COMPLETE** ✓ | INCOMPLETE (pre-07/01) |
| Agosto | 716 | 726 | **COMPLETE** ✓ | INCOMPLETE (pre-01/08) |

**Julio:**  
- 640 SR importados Liberaciones (checkpoint FASE 0: 588 links + 52 RAW-only)
- 572 definitivos compartidos + 11 report 01-03 julio + 16 payouts
- **Period coverage: COMPLETE**
- Balance chain: INCOMPLETE (enero-junio incompleto)

**Agosto:**  
- 798 SR importados Liberaciones (checkpoint: 726 links + 72 RAW-only)
- 716 compartidos + 10 payouts exclusivos
- **Period coverage: COMPLETE**
- Balance chain: INCOMPLETE (enero-junio incompleto)

### Saldos Actuales (Ledger)

**No apto para Account Balance Reconciliation hasta resolver balance_chain_coverage:**

| Fecha | Saldo | Validez |
|-------|-------|---------|
| 2026-06-30 | 44,495,339.77 | Matemáticamente correcto respecto ledger actual; cadena incompleta |
| 2026-07-31 | 39,737,154.04 | Matemáticamente correcto respecto ledger actual; cadena incompleta |
| 2026-08-31 | 39,612,950.80 | Matemáticamente correcto respecto ledger actual; cadena incompleta |

**Observación UI agosto:**  
- Entradas: +13,337,721.84
- Salidas: -13,461,925.11
- Neto: -124,203.27

**Ledger agosto:**  
movement_sum = -124,203.24

**Diferencia:** -0.03 (rounding)

**Tipo:** PERIOD FLOW DISCREPANCY (diferencia no explicada)  
**Causa:** DESCONOCIDA — requiere investigación  
**NO:** rounding, NO: reconciliación aprobada, NO: account balance variance

---

## ARQUITECTURA FINAL

### 1. Tablas Nuevas

#### `import_period_coverage`

Evidencia de completitud por período y fuente.

```sql
CREATE TABLE import_period_coverage (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  source_type VARCHAR(20) NOT NULL,  -- 'report', 'liberaciones'

  -- Conteos
  source_records_count BIGINT,
  financial_movements_count BIGINT,
  ledger_entries_count BIGINT,

  -- Rango de datos
  min_transaction_date DATE,
  max_transaction_date DATE,

  -- Cobertura
  coverage VARCHAR(20) NOT NULL,  -- 'unknown', 'none', 'partial', 'complete'
  coverage_notes TEXT,

  -- Checkpoint/validación
  import_checkpoint_id VARCHAR(100),  -- Referencia a archivo importado o checkpoint FASE 0
  validated_at TIMESTAMP WITH TIME ZONE,
  validated_by VARCHAR(100),

  -- Auditoría
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  UNIQUE(account_id, period_start, period_end, source_type),
  CONSTRAINT valid_coverage CHECK (coverage IN ('unknown', 'none', 'partial', 'complete'))
);

CREATE INDEX idx_import_period_coverage_account_date
  ON import_period_coverage(account_id, period_start, period_end);
```

#### `reconciliation_snapshot`

Observaciones reales de saldo MP. **INMUTABLE, VERSIONADA.**

```sql
CREATE TABLE reconciliation_snapshot (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  balance_date DATE NOT NULL,

  -- Observación
  observed_balance DECIMAL(15,2) NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,

  -- Fuente
  source_method VARCHAR(50),  -- 'manual', 'api_account_info', 'ui_screenshot', 'sendgrid_report'
  source_detail VARCHAR(255),

  -- Documentación
  notes TEXT,
  created_by VARCHAR(100),

  -- Versionado: una corrección crea nuevo snapshot, nunca sobrescribe
  supersedes_snapshot_id BIGINT,

  -- Auditoría
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_supersedes FOREIGN KEY (supersedes_snapshot_id)
    REFERENCES reconciliation_snapshot(id) ON DELETE SET NULL
);

CREATE INDEX idx_reconciliation_snapshot_account_date
  ON reconciliation_snapshot(account_id, balance_date DESC);
```

#### `monthly_reconciliation`

Decisión formal y auditoría de reconciliación. **Persistencia de decisión, no cache.**

```sql
CREATE TABLE monthly_reconciliation (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- Referencia a observación
  closing_snapshot_id BIGINT,

  -- Estado de reconciliación
  status VARCHAR(30) NOT NULL,  -- 'pending', 'reconciled', 'needs_investigation', 'variance_approved'

  -- Documentación de decisión
  variance_approval_note TEXT,
  approved_by VARCHAR(100),
  approved_at TIMESTAMP WITH TIME ZONE,

  -- Auditoría
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  UNIQUE(account_id, period_start, period_end),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'reconciled', 'needs_investigation', 'variance_approved')),
  CONSTRAINT fk_snapshot FOREIGN KEY (closing_snapshot_id)
    REFERENCES reconciliation_snapshot(id) ON DELETE SET NULL
);

CREATE INDEX idx_monthly_reconciliation_account_date
  ON monthly_reconciliation(account_id, period_start, period_end);
```

### 2. Valores Derivados via VIEW

**NO persistir** opening_balance, movement_sum, closing_calculated, variance, etc.

Usar VIEW para resumen de reconciliación:

```sql
CREATE OR REPLACE VIEW v_monthly_reconciliation_summary AS
SELECT
  mr.account_id,
  mr.period_start,
  mr.period_end,

  -- Abierto
  COALESCE(
    (SELECT opening_balance FROM account_balance 
     WHERE account_id = mr.account_id 
     AND balance_date <= mr.period_start
     ORDER BY balance_date DESC LIMIT 1),
    0
  ) as opening_balance,

  -- Movimientos
  (SELECT COALESCE(SUM(balance_impact), 0)
   FROM ledger_entry le
   WHERE le.account_id = mr.account_id
     AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN mr.period_start AND mr.period_end
  ) as period_movement_sum,

  -- Cierre calculado
  (SELECT COALESCE(SUM(balance_impact), 0)
   FROM ledger_entry le
   WHERE le.account_id = mr.account_id
     AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= mr.period_end
  ) as closing_balance_calculated,

  -- Observado (si existe snapshot)
  rs.observed_balance,
  rs.observed_at,

  -- Diferencia
  rs.observed_balance -
  (SELECT COALESCE(SUM(balance_impact), 0)
   FROM ledger_entry le
   WHERE le.account_id = mr.account_id
     AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= mr.period_end
  ) as variance,

  mr.status,
  mr.variance_approval_note,
  mr.approved_by,
  mr.approved_at

FROM monthly_reconciliation mr
LEFT JOIN reconciliation_snapshot rs
  ON rs.id = mr.closing_snapshot_id;
```

### 3. Estrategia de Account Balance Cache

**Decisión: NO depender del cache en FASE 1.**

Alternativas futuras:

**OPCIÓN A (recomendada para FASE 1):**  
Deshabilitar el trigger automático o marcarlo como deprecated. Calcular siempre desde `calculate_ledger_balance()` en time de consulta.

**OPCIÓN B (cuando haya backfill strategy robusta):**  
Rediseñar trigger para:
1. Identificar si es insert retroactivo (occurred_at < TODAY)
2. Recalcular todas las fechas >= occurred_at, no solo occurred_at
3. O usar job async que detecte e invalide fechas posteriores

**Temporalmente:** Documentar que `account_balance.calculated_balance` es stale y NO debe usarse para auditoría.

---

## FLUJOS DE RECONCILIACIÓN

### Flujo A: Period Flow Reconciliation

Comparar movimientos netos del mes contra UI observada.

```
1. Consultar movement_sum (ledger BETWEEN period_start AND period_end)
2. Comparar contra UI (ej: -124,203.27 vs -124,203.24)
3. Si diferencia < threshold → marcar como reconciliado
4. Si diferencia > threshold → marcar como needs_investigation
5. Usuario aprueba variance con nota
```

### Flujo B: Account Balance Reconciliation

Requiere balance_chain_coverage COMPLETE.

```
1. Verificar balance_chain_coverage = COMPLETE hasta period_end
   (todos los períodos desde opening_balance_date tienen coverage=complete)

2. SI coverage INCOMPLETE:
   → NO reconciliar saldo acumulado todavía
   → marcar status = needs_investigation
   → documentar "balance_chain_coverage_incomplete"

3. SI coverage COMPLETE:
   → Calcular closing_balance = opening + movement_sum_desde_opening_hasta_period_end
   → Comparar contra observed_balance (si existe snapshot)
   → Marcar status según variance
```

---

## DECISIONES INCORPORADAS

### D1: -124,203.27 (Agosto)

**Decisión:** Tratar como PERIOD FLOW discrepancy, no account balance variance.

- NO crear reconciliation_snapshot con -124,203.27 como "balance observado"
- Mantener la diferencia -0.03 como discrepancia de auditoría pendiente
- Investigar origen (rounding, timestamp reconciliation)

### D2: Timezone Explícito

**Decisión:** Documentar deuda técnica, no cambiar funciones todavía.

Funciones `calculate_ledger_balance()`, trigger, y vistas deben usar:
```sql
DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
```

en lugar de `DATE(occurred_at)` que depende de `current_setting('TimeZone')`.

**Timing:** FASE 2 o cuando se corrija strategy de account_balance cache.

### D3: account_balance Cache

**Decisión:** Marcar como NO confiable en FASE 1, calcular desde ledger.

Documentar en schema/comments que `calculated_balance` puede quedar stale.

Proponer corrección en FASE 2 cuando se reimplemente backfill strategy.

### D4: Versionado de Observaciones

**Decisión:** `reconciliation_snapshot` es INMUTABLE con `supersedes_snapshot_id`.

Una corrección NO sobrescribe, crea nueva fila. Auditoría completa de cambios.

---

## RESTRICCIONES IMPLEMENTACIÓN

### ❌ NO HACER AHORA:

- Crear `accounts` tabla (no existe en el modelo actual)
- Agregar FK a `accounts` desde ninguna tabla
- Usar `account_balance.calculated_balance` como source-of-truth
- Cambiar funciones de timezone implícito a explícito
- Importar enero-junio sin resolver balance_chain_coverage
- Reconciliar saldos acumulados sin coverage COMPLETE en toda la cadena
- Usar account_balance trigger para recalcular fechas posteriores

### ✅ PUEDE HACERSE:

- Crear las tres tablas nuevas (import_period_coverage, reconciliation_snapshot, monthly_reconciliation)
- Crear VIEW de resumen
- Implementar RPC de auditoría para verificar coverage
- Documentar deuda técnica en comments
- Capturar observaciones manuales de MP en reconciliation_snapshot
- Marcar períodos julio/agosto como COMPLETE en import_period_coverage (con referencia a FASE 0 checkpoint)

---

## SIGUIENTE FASE

### Enero-Junio: Resolución de Balance Chain

Para poder reconciliar saldos acumulados de julio/agosto 2026, se debe:

1. Obtener Account Money completo enero-junio
2. Obtener Liberaciones (si aplica) enero-junio
3. Validar cobertura = COMPLETE para cada mes
4. Luego marcar balance_chain_coverage = COMPLETE y reconciliar

Timing: FASE 2 o posterior.

---

## AUDITORÍA REFERENCIAS

- Hallazgos completos: `sql/FASE_1_AUDIT_ADVANCED_READ_ONLY.sql`
- FASE 0 cierre: `docs/mercadopago/FASE_0_CIERRE_JULIO_AGOSTO_2026.md`
- Handoff anterior: `docs/mercadopago/FASE_1_AUDIT_HANDOFF.md`

---

**Estado:** SCHEMA PROPUESTO — LISTO PARA REVISIÓN  
**NO EJECUTAR MIGRACIONES TODAVÍA**  
**NO MODIFICAR DATOS**
