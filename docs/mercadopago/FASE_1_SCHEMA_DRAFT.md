# FASE 1: SCHEMA PROPUESTO — REVISIÓN PRE-MIGRACIÓN

**Estado:** DRAFT PARA REVISIÓN  
**Próxima migración:** 007_reconciliation_tables.sql  
**NO EJECUTAR TODAVÍA**

---

## DECISIONES ARQUITECTURA

### 1. Tipo Monetario
**NUMERIC(15,2)** — Rango: -999,999,999,999.99 a 999,999,999,999.99  
(Soporta saldos de billones, suficiente para Mercado Pago)

### 2. Timestamp
**TIMESTAMP WITH TIME ZONE** — registra hora exacta + zona (auditoría)  
**DATE** — solo fecha económica (período)

### 3. Auth Fields
**created_by TEXT** — no FK a users (auth pattern no existe en schema actual)  
**approved_by TEXT** — idem  
(Si se implementa auth en futuro, migraciones separadas para FK)

### 4. Immutability Strategy
- `reconciliation_snapshot`: INSERT-ONLY + `supersedes_snapshot_id` self-FK para trazabilidad
- `import_period_coverage`: Append-only (una fila por evidencia), último "válido" por lógica app
- `monthly_reconciliation`: Una fila por account+period (UNIQUE), pero permite UPDATE status (decisión humana)

### 5. Period Flow Reconciliation
**Decisión:** Incluir en `monthly_reconciliation` un campo `period_flow_observed` (nullable).
- Si usuario carga -124,203.27 de UI MP, se guarda ahí
- Permite detectar: ledger vs UI mismatch (-0.03)
- NO se confunde con account_balance variance

### 6. Timezone en Funciones
VIEW nueva usa `AT TIME ZONE 'America/Argentina/Buenos_Aires'` explícito.  
Funciones legacy (`calculate_ledger_balance()`) se mantienen como están.

---

## TABLA 1: `import_period_coverage`

**Propósito:** Evidencia de cobertura por período/source — append-only  
**Obtención de estado vigente:** SELECT ... WHERE account_id=X AND period_start=Y AND period_end=Z AND source_type=W ORDER BY created_at DESC LIMIT 1

```sql
CREATE TABLE IF NOT EXISTS import_period_coverage (
  id BIGSERIAL PRIMARY KEY,

  -- Identidad
  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  source_type VARCHAR(20) NOT NULL,

  -- Conteos reales de BD
  source_records_count BIGINT,
  financial_movements_count BIGINT,
  ledger_entries_count BIGINT,

  -- Rango económico verificado
  min_transaction_date DATE,
  max_transaction_date DATE,

  -- Cobertura
  coverage VARCHAR(20) NOT NULL,  -- 'unknown', 'none', 'partial', 'complete'
  coverage_notes TEXT,

  -- Evidencia/validación
  import_checkpoint_id VARCHAR(100),  -- Referencia a archivo/FASE 0 checkpoint
  validated_at TIMESTAMP WITH TIME ZONE,
  validated_by VARCHAR(100),

  -- Auditoría — append-only
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_coverage CHECK (coverage IN ('unknown', 'none', 'partial', 'complete')),
  CONSTRAINT valid_source_type CHECK (source_type IN ('report', 'liberaciones'))
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_import_period_coverage_account_date
  ON import_period_coverage(account_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_import_period_coverage_vigent_lookup
  ON import_period_coverage(account_id, period_start, period_end, source_type, created_at DESC);
```

**Estrategia vigente:** `SELECT ... ORDER BY created_at DESC LIMIT 1`  
(Última evidencia registrada es la vigente; si necesita revalidación, inserta nueva fila)

**NO UNIQUE:** Permite múltiples evidencias por período (versionado).

---

## TABLA 2: `reconciliation_snapshot`

**Propósito:** Observación REAL de saldo MP — immutable / versionada  
**Obtención vigente:** Última fila NO supersede (supersedes_snapshot_id IS NULL) para account+balance_date

```sql
CREATE TABLE IF NOT EXISTS reconciliation_snapshot (
  id BIGSERIAL PRIMARY KEY,

  -- Identidad
  account_id BIGINT NOT NULL,
  balance_date DATE NOT NULL,

  -- Observación real
  observed_balance NUMERIC(15,2) NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,

  -- Fuente
  source_method VARCHAR(50),  
    -- 'manual_screenshot', 'manual_typing', 'sendgrid_report'
    -- NO: 'api_account_info', 'webhook' (no implementadas todavía)
  source_detail VARCHAR(255),

  -- Documentación
  notes TEXT,
  created_by VARCHAR(100),

  -- Versionado: una corrección inserta nueva fila, nunca UPDATE
  supersedes_snapshot_id BIGINT,

  -- Auditoría — NO updated_at
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_supersedes FOREIGN KEY (supersedes_snapshot_id)
    REFERENCES reconciliation_snapshot(id) ON DELETE SET NULL,
  CONSTRAINT same_account_supersession CHECK (
    supersedes_snapshot_id IS NULL OR 
    supersedes_snapshot_id IN (
      SELECT id FROM reconciliation_snapshot rs2 
      WHERE rs2.account_id = reconciliation_snapshot.account_id
    )
  )
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_reconciliation_snapshot_account_date
  ON reconciliation_snapshot(account_id, balance_date DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_snapshot_vigent
  ON reconciliation_snapshot(account_id, balance_date, supersedes_snapshot_id);
```

**Obtención vigente:** `SELECT * WHERE account_id=X AND balance_date=Y AND supersedes_snapshot_id IS NULL`  
(Última versión no supersedida es vigente)

**NO UPDATE:** Corrección = nueva fila + supercedes_snapshot_id

**NO usar -124,203.27:** Esta fila NO se crea hasta que haya evidencia independiente de MP.

---

## TABLA 3: `monthly_reconciliation`

**Propósito:** Decisión formal de reconciliación — una fila vigente por período  
**Estrategia:** UNIQUE(account_id, period_start, period_end) permite UPDATE status

```sql
CREATE TABLE IF NOT EXISTS monthly_reconciliation (
  id BIGSERIAL PRIMARY KEY,

  -- Identidad
  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- Referencias
  closing_snapshot_id BIGINT,  -- snapshot observado si existe

  -- Periodo flow: UI MP observed neto (opcional, para auditoria)
  period_flow_observed NUMERIC(15,2),  -- ej: -124,203.27

  -- Decisión
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
    -- 'pending': sin revisión
    -- 'reconciled': saldos + flows coinciden
    -- 'needs_investigation': hay discrepancias
    -- 'variance_approved': discrepancia aprobada con nota
  
  -- Documentación de aprobación
  variance_approval_note TEXT,
  approved_by VARCHAR(100),
  approved_at TIMESTAMP WITH TIME ZONE,

  -- Auditoría
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Constraints
  UNIQUE(account_id, period_start, period_end),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'reconciled', 'needs_investigation', 'variance_approved')),
  CONSTRAINT fk_snapshot FOREIGN KEY (closing_snapshot_id)
    REFERENCES reconciliation_snapshot(id) ON DELETE SET NULL,
  CONSTRAINT approval_consistency CHECK (
    (status = 'variance_approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR
    (status != 'variance_approved')
  )
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_monthly_reconciliation_account_date
  ON monthly_reconciliation(account_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_monthly_reconciliation_status
  ON monthly_reconciliation(account_id, status);
```

**Qué persiste:** status, decisión, aprobación  
**Qué deriva:** opening_balance, movement_sum, closing_calculated, variance → via VIEW

**Versionable:** NO — una fila por período, UPDATE allowed para cambiar status/notas

---

## VIEW: `v_monthly_reconciliation_summary`

**Propósito:** Resumen completo derivando valores desde ledger, NO desde cache

```sql
CREATE OR REPLACE VIEW v_monthly_reconciliation_summary AS
SELECT
  mr.id,
  mr.account_id,
  mr.period_start,
  mr.period_end,

  -- Opening
  COALESCE(
    (SELECT opening_balance FROM account_balance 
     WHERE account_id = mr.account_id AND balance_date = mr.period_start - INTERVAL '1 day'
     ORDER BY balance_date DESC LIMIT 1),
    0
  ) as opening_balance_calculated,

  -- Period flow — derivado de ledger (NO cache)
  (SELECT COALESCE(SUM(balance_impact), 0)
   FROM ledger_entry le
   WHERE le.account_id = mr.account_id
     AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') 
       BETWEEN mr.period_start AND mr.period_end
  ) as period_movement_sum_calculated,

  -- Cierre acumulado
  (SELECT COALESCE(SUM(balance_impact), 0)
   FROM ledger_entry le
   WHERE le.account_id = mr.account_id
     AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= mr.period_end
  ) as closing_balance_calculated,

  -- Period flow observed (si usuario cargó)
  mr.period_flow_observed,

  -- Period flow discrepancy
  CASE 
    WHEN mr.period_flow_observed IS NOT NULL THEN
      mr.period_flow_observed - 
      (SELECT COALESCE(SUM(balance_impact), 0)
       FROM ledger_entry le
       WHERE le.account_id = mr.account_id
         AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') 
           BETWEEN mr.period_start AND mr.period_end)
    ELSE NULL
  END as period_flow_discrepancy,

  -- Account balance observed (si snapshot existe)
  rs.observed_balance,
  rs.observed_at,
  rs.source_method,

  -- Account balance variance
  CASE
    WHEN rs.observed_balance IS NOT NULL THEN
      rs.observed_balance - 
      (SELECT COALESCE(SUM(balance_impact), 0)
       FROM ledger_entry le
       WHERE le.account_id = mr.account_id
         AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= mr.period_end)
    ELSE NULL
  END as account_balance_variance,

  -- Coverage (derivado: count de períodos COMPLETE antes de este)
  (SELECT COUNT(DISTINCT period_start)
   FROM import_period_coverage ipc
   WHERE ipc.account_id = mr.account_id
     AND ipc.period_start < mr.period_start
     AND ipc.coverage = 'complete'
  ) as complete_periods_before,

  -- Es balance chain complete? = todos los períodos desde origin son 'complete'
  CASE 
    WHEN (SELECT COUNT(DISTINCT period_start) FROM import_period_coverage ipc
          WHERE ipc.account_id = mr.account_id
            AND ipc.period_start <= mr.period_end
            AND ipc.coverage = 'complete'
          GROUP BY account_id) = (SELECT COUNT(DISTINCT period_start) 
                                  FROM import_period_coverage ipc2
                                  WHERE ipc2.account_id = mr.account_id
                                    AND ipc2.period_start <= mr.period_end)
    THEN TRUE
    ELSE FALSE
  END as balance_chain_coverage_complete,

  -- Decisión
  mr.status,
  mr.variance_approval_note,
  mr.approved_by,
  mr.approved_at,
  mr.created_at,
  mr.updated_at

FROM monthly_reconciliation mr
LEFT JOIN reconciliation_snapshot rs
  ON rs.id = mr.closing_snapshot_id;
```

**Source de truth:** ledger_entry, NO account_balance.calculated_balance  
**Timezone:** `AT TIME ZONE 'America/Argentina/Buenos_Aires'` explícito ✓  
**Balance chain:** Derivado contando períodos COMPLETE ✓

---

## RESTRICCIONES SQL

```sql
-- Constraint: closing_snapshot debe ser del mismo account_id y period_end
ALTER TABLE monthly_reconciliation ADD CONSTRAINT closing_snapshot_same_account_date CHECK (
  closing_snapshot_id IS NULL OR
  closing_snapshot_id IN (
    SELECT id FROM reconciliation_snapshot rs
    WHERE rs.account_id = monthly_reconciliation.account_id
      AND rs.balance_date = monthly_reconciliation.period_end
  )
);
```

---

## PERIODO FLOW: ¿Tabla separada?

**Recomendación:** NO necesaria ahora.

El campo `period_flow_observed` en `monthly_reconciliation` es suficiente para:
- Guardar observación UI (-124,203.27)
- Calcular discrepancia contra ledger (-0.03)
- Marcar status = needs_investigation si -0.03 > threshold

Futura entidad `period_flow_observation` solo si se necesita:
- Múltiples observaciones por período (ej: MP cambia reporting)
- Versionado específico de period_flow

Por ahora: OPCIÓN A (dentro de monthly_reconciliation)

---

## MIGRATION FILE

**Nombre:** `007_reconciliation_tables.sql`  
**Orden de creación:**
1. `import_period_coverage`
2. `reconciliation_snapshot`
3. `monthly_reconciliation` (con FKs)
4. `v_monthly_reconciliation_summary` (VIEW)

**Cada CREATE TABLE IF NOT EXISTS** para idempotencia.  
**CREATE INDEX IF NOT EXISTS** separado (patrón repo).

---

**Estado:** DRAFT LISTO PARA REVISIÓN ANTES DE MIGRACIÓN  
**NO EJECUTAR TODAVÍA**  
**NO MODIFICAR DATOS**  
**NO IMPORTAR ENERO-JUNIO**
