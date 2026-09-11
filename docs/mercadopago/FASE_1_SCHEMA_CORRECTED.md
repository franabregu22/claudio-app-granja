# FASE 1: SCHEMA PROPUESTO — CORRECCIONES CRÍTICAS APLICADAS

**Estado:** DRAFT REVISADO — SEGUNDA ITERACIÓN  
**Próxima migración:** 007_reconciliation_tables.sql (NO CREAR TODAVÍA)  
**Migraciones ejecutadas:** NO  
**Datos modificados:** NO

---

## AUDITORÍA DEL REPO

### Auth Pattern
- **Hallazgo:** No hay auth.uid(), user_id, ni políticas RLS en migraciones existentes
- **Conclusión:** Supabase Auth no está integrado en schema actual
- **Decisión FASE 1:** `created_by`, `approved_by` como **TEXT** (actores pueden ser:  usuario manual, nombre de proceso, API key, etc.)
- **RLS:** No implementar en FASE 1; documentar como deuda técnica
- **FK a users:** NO crear en FASE 1; si se agrega auth luego, será migración separada

### Migration Numbering
- **Confirmado:** supabase/migrations/ contiene 001_...sql hasta 006_add_liberaciones_source_type.sql
- **Próxima:** 007_reconciliation_tables.sql

### Existing Schema Patterns
- **ID type:** BIGSERIAL PRIMARY KEY
- **Monetary:** DECIMAL(15,2) — Rango: -9,999,999,999,999.99 a +9,999,999,999,999.99 (corrected)
- **Timestamp:** TIMESTAMP WITH TIME ZONE
- **Date:** DATE (sin hora)
- **Indexes:** CREATE INDEX IF NOT EXISTS, separado de CREATE TABLE
- **Constraints:** CHECK, UNIQUE, FOREIGN KEY con ON DELETE SET NULL / CASCADE

---

## MODELO FINAL: 4 TABLAS + 3 VIEWS

### Cambio Principal
Se requiere **4TA TABLA** `period_flow_observation` para separar:
- EVIDENCIA DE FLUJO MENSUAL (tabla 3)
- EVIDENCIA DE SALDO ACUMULADO (tabla 2)
- DECISIÓN HUMANA (tabla 4)

---

## TABLA 1: `import_period_coverage`

**Propósito:** Evidencia append-only de cobertura por período/source  
**Estrategia:** Última fila por (account_id, period_start, period_end, source_type, created_at DESC) = vigente

```sql
CREATE TABLE IF NOT EXISTS import_period_coverage (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  source_type VARCHAR(20) NOT NULL,

  source_records_count BIGINT,
  financial_movements_count BIGINT,
  ledger_entries_count BIGINT,

  min_transaction_date DATE,
  max_transaction_date DATE,

  coverage VARCHAR(20) NOT NULL,
  coverage_notes TEXT,

  import_checkpoint_id VARCHAR(100),
  validated_at TIMESTAMP WITH TIME ZONE,
  validated_by TEXT,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_coverage CHECK (coverage IN ('unknown', 'none', 'partial', 'complete')),
  CONSTRAINT valid_source_type CHECK (source_type IN ('report', 'liberaciones')),
  CONSTRAINT date_range CHECK (period_start <= period_end),
  CONSTRAINT counts_nonnegative CHECK (
    (source_records_count IS NULL OR source_records_count >= 0) AND
    (financial_movements_count IS NULL OR financial_movements_count >= 0) AND
    (ledger_entries_count IS NULL OR ledger_entries_count >= 0)
  ),
  CONSTRAINT date_order CHECK (min_transaction_date IS NULL OR max_transaction_date IS NULL OR min_transaction_date <= max_transaction_date)
);

CREATE INDEX IF NOT EXISTS idx_import_period_coverage_lookup
  ON import_period_coverage(account_id, period_start, period_end, source_type, created_at DESC, id DESC);

-- Evitar que antiguas versiones con coverage='unknown' queden como "vigentes" buscando una evidencia más reciente
CREATE INDEX IF NOT EXISTS idx_import_period_coverage_by_date
  ON import_period_coverage(account_id, created_at DESC, id DESC);
```

**Nota:** Append-only garantizado por **policy en service layer**, no por SQL.

---

## TABLA 2: `reconciliation_snapshot`

**Propósito:** Observación REAL de saldo acumulado de MP  
**Estrategia:** Immutable — última versión no supersedida es vigente

```sql
CREATE TABLE IF NOT EXISTS reconciliation_snapshot (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  balance_date DATE NOT NULL,

  observed_balance NUMERIC(15,2) NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,

  source_method VARCHAR(50),
    -- Valores permitidos: 'manual_ui_observation' (default)
    -- Extensible en futuro: 'api_report', 'webhook_notification'
  source_detail VARCHAR(255),

  notes TEXT,
  created_by TEXT,

  -- Versionado: new snapshot points to old one
  supersedes_snapshot_id BIGINT,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_supersedes FOREIGN KEY (supersedes_snapshot_id)
    REFERENCES reconciliation_snapshot(id) ON DELETE RESTRICT,
  CONSTRAINT date_range CHECK (balance_date IS NOT NULL),
  CONSTRAINT supersedes_not_self CHECK (supersedes_snapshot_id IS NULL OR supersedes_snapshot_id != id)
);

-- Index: encontrar snapshot vigente (no supersedido) rápidamente
CREATE INDEX IF NOT EXISTS idx_reconciliation_snapshot_vigent
  ON reconciliation_snapshot(account_id, balance_date)
  WHERE supersedes_snapshot_id IS NULL;

-- Index: evitar ciclos de supersession (aunque FK RESTRICT ayuda)
CREATE INDEX IF NOT EXISTS idx_reconciliation_snapshot_supersedes
  ON reconciliation_snapshot(supersedes_snapshot_id)
  WHERE supersedes_snapshot_id IS NOT NULL;

-- TRIGGER (NO CHECK) para validar same-account supersession
CREATE OR REPLACE FUNCTION reconciliation_snapshot_validate_supersession()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.supersedes_snapshot_id IS NOT NULL THEN
    PERFORM 1 FROM reconciliation_snapshot
    WHERE id = NEW.supersedes_snapshot_id
      AND account_id = NEW.account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supersedes_snapshot_id must reference same account_id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reconciliation_snapshot_validate_supersession
  BEFORE INSERT OR UPDATE ON reconciliation_snapshot
  FOR EACH ROW
  EXECUTE FUNCTION reconciliation_snapshot_validate_supersession();

-- UNIQUE parcial: un snapshot puede tener como máximo un sucesor directo
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_snapshot_unique_successor
  ON reconciliation_snapshot(supersedes_snapshot_id)
  WHERE supersedes_snapshot_id IS NOT NULL;
```

**Vigente:**  
`SELECT * WHERE account_id=X AND balance_date=Y AND supersedes_snapshot_id IS NULL`

**Immutable garantizado:** TRIGGER + SQL (ON DELETE RESTRICT prevents orphaning)

---

## TABLA 3: `period_flow_observation`

**Propósito:** Evidencia REAL del flujo neto mensual observado en UI MP  
**Estrategia:** Immutable/versionada, separada de saldo acumulado

```sql
CREATE TABLE IF NOT EXISTS period_flow_observation (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- Observación real (ej: -124203.27 del UI agosto)
  observed_net NUMERIC(15,2) NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,

  -- Fuente
  source_method VARCHAR(50),
    -- 'manual_ui_observation' (default)
    -- Extensible: 'api_account_report', 'webhook_settlement'
  source_detail VARCHAR(255),

  notes TEXT,
  created_by TEXT,

  -- Versionado: nueva observación supersede la anterior
  supersedes_observation_id BIGINT,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_supersedes FOREIGN KEY (supersedes_observation_id)
    REFERENCES period_flow_observation(id) ON DELETE RESTRICT,
  CONSTRAINT date_range CHECK (period_start <= period_end),
  CONSTRAINT supersedes_not_self CHECK (supersedes_observation_id IS NULL OR supersedes_observation_id != id)
);

CREATE INDEX IF NOT EXISTS idx_period_flow_observation_vigent
  ON period_flow_observation(account_id, period_start, period_end)
  WHERE supersedes_observation_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_period_flow_observation_supersedes
  ON period_flow_observation(supersedes_observation_id)
  WHERE supersedes_observation_id IS NOT NULL;

-- TRIGGER para validar same-account supersession
CREATE OR REPLACE FUNCTION period_flow_observation_validate_supersession()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.supersedes_observation_id IS NOT NULL THEN
    PERFORM 1 FROM period_flow_observation
    WHERE id = NEW.supersedes_observation_id
      AND account_id = NEW.account_id
      AND period_start = NEW.period_start
      AND period_end = NEW.period_end;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supersedes_observation_id must reference same period and account';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_period_flow_observation_validate_supersession
  BEFORE INSERT OR UPDATE ON period_flow_observation
  FOR EACH ROW
  EXECUTE FUNCTION period_flow_observation_validate_supersession();

CREATE UNIQUE INDEX IF NOT EXISTS idx_period_flow_observation_unique_successor
  ON period_flow_observation(supersedes_observation_id)
  WHERE supersedes_observation_id IS NOT NULL;
```

**Vigente:**  
`SELECT * WHERE account_id=X AND period_start=Y AND period_end=Z AND supersedes_observation_id IS NULL`

---

## TABLA 4: `monthly_reconciliation`

**Propósito:** Decisión humana y auditoría de reconciliación  
**Estrategia:** Una fila vigente por account+period, permite UPDATE para cambiar status/aprobación

```sql
CREATE TABLE IF NOT EXISTS monthly_reconciliation (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- Referencias a evidencia elegida
  closing_snapshot_id BIGINT,
  period_flow_observation_id BIGINT,

  -- Decisión
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
    -- 'pending': sin revisión
    -- 'reconciled': evidencia matchea, aprobado
    -- 'needs_investigation': hay discrepancia, pendiente investigación
    -- 'variance_approved': discrepancia investigada y aprobada

  -- Documentación de aprobación
  variance_approval_note TEXT,
  approved_by TEXT,
  approved_at TIMESTAMP WITH TIME ZONE,

  -- Auditoría
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Constraints
  UNIQUE(account_id, period_start, period_end),
  CONSTRAINT date_range CHECK (period_start <= period_end),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'reconciled', 'needs_investigation', 'variance_approved')),
  
  -- FKs: si IDs existen, validar account_id coincide (sin CHECK, en trigger o app)
  CONSTRAINT fk_closing_snapshot FOREIGN KEY (closing_snapshot_id)
    REFERENCES reconciliation_snapshot(id) ON DELETE SET NULL,
  CONSTRAINT fk_period_flow_observation FOREIGN KEY (period_flow_observation_id)
    REFERENCES period_flow_observation(id) ON DELETE SET NULL,

  -- Approval consistency: si variance_approved, fields deben estar presentes
  CONSTRAINT approval_consistency_check CHECK (
    (status = 'variance_approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR
    (status != 'variance_approved')
  )
);

-- Validar que snapshot y flow observation refieren al mismo account y período
CREATE OR REPLACE FUNCTION monthly_reconciliation_validate_references()
RETURNS TRIGGER AS $$
BEGIN
  -- Validar closing_snapshot_id si existe
  IF NEW.closing_snapshot_id IS NOT NULL THEN
    PERFORM 1 FROM reconciliation_snapshot
    WHERE id = NEW.closing_snapshot_id
      AND account_id = NEW.account_id
      AND balance_date = NEW.period_end;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'closing_snapshot_id must reference same account and period_end';
    END IF;
  END IF;

  -- Validar period_flow_observation_id si existe
  IF NEW.period_flow_observation_id IS NOT NULL THEN
    PERFORM 1 FROM period_flow_observation
    WHERE id = NEW.period_flow_observation_id
      AND account_id = NEW.account_id
      AND period_start = NEW.period_start
      AND period_end = NEW.period_end;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'period_flow_observation_id must reference same account and period';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_monthly_reconciliation_validate_references
  BEFORE INSERT OR UPDATE ON monthly_reconciliation
  FOR EACH ROW
  EXECUTE FUNCTION monthly_reconciliation_validate_references();

-- Updated_at trigger
CREATE OR REPLACE FUNCTION monthly_reconciliation_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_monthly_reconciliation_update_timestamp
  BEFORE UPDATE ON monthly_reconciliation
  FOR EACH ROW
  EXECUTE FUNCTION monthly_reconciliation_update_timestamp();

CREATE INDEX IF NOT EXISTS idx_monthly_reconciliation_account_date
  ON monthly_reconciliation(account_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_monthly_reconciliation_status
  ON monthly_reconciliation(account_id, status);
```

**Qué persiste:** status, aprobación, referencias  
**Qué deriva:** opening, movement_sum, closing, variance (via VIEW)  
**Mutabilidad:** UPDATE allowed (service layer debe auditar cambios)

---

## VIEWS AUXILIARES

### View 1: `v_latest_coverage_evidence`

```sql
CREATE OR REPLACE VIEW v_latest_coverage_evidence AS
SELECT
  account_id,
  period_start,
  period_end,
  source_type,
  source_records_count,
  financial_movements_count,
  ledger_entries_count,
  min_transaction_date,
  max_transaction_date,
  coverage,
  coverage_notes,
  validated_at,
  validated_by,
  created_at
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, period_start, period_end, source_type
      ORDER BY created_at DESC, id DESC
    ) as rn
  FROM import_period_coverage
) x
WHERE rn = 1;
```

### View 2: `v_period_coverage_status`

Determina si período está COMPLETE, PARTIAL, NONE, o UNKNOWN

```sql
CREATE OR REPLACE VIEW v_period_coverage_status AS
SELECT
  account_id,
  period_start,
  period_end,
  CASE
    WHEN 
      (SELECT coverage FROM v_latest_coverage_evidence WHERE 
        account_id = c.account_id AND 
        period_start = c.period_start AND period_end = c.period_end AND 
        source_type = 'report') = 'complete'
      AND
      (SELECT coverage FROM v_latest_coverage_evidence WHERE 
        account_id = c.account_id AND 
        period_start = c.period_start AND period_end = c.period_end AND 
        source_type = 'liberaciones') = 'complete'
    THEN 'complete'
    WHEN 
      (SELECT coverage FROM v_latest_coverage_evidence WHERE 
        account_id = c.account_id AND 
        period_start = c.period_start AND period_end = c.period_end AND 
        source_type IN ('report', 'liberaciones')) IS NOT NULL
    THEN 'partial'
    ELSE 'unknown'
  END as period_coverage
FROM (SELECT DISTINCT account_id, period_start, period_end FROM import_period_coverage) c;
```

### View 3: `v_monthly_reconciliation_summary`

Resumen completo, todo derivado de ledger + configuración, nunca del cache

```sql
CREATE OR REPLACE VIEW v_monthly_reconciliation_summary AS
WITH opening_config AS (
  SELECT
    account_id,
    opening_balance,
    opening_balance_date
  FROM account_balance
  WHERE (account_id, balance_date) IN (
    SELECT account_id, MAX(balance_date) FROM account_balance
    WHERE balance_date <= CURRENT_DATE
    GROUP BY account_id
  )
),
period_data AS (
  SELECT
    mr.id,
    mr.account_id,
    mr.period_start,
    mr.period_end,
    mr.status,
    mr.variance_approval_note,
    mr.approved_by,
    mr.approved_at,
    mr.closing_snapshot_id,
    mr.period_flow_observation_id,
    mr.created_at,
    mr.updated_at,
    -- Opening: configured value + sum from opening_date until period_start - 1
    oc.opening_balance,
    oc.opening_balance_date,
    (oc.opening_balance + COALESCE(
      (SELECT SUM(balance_impact) FROM ledger_entry le
       WHERE le.account_id = mr.account_id
         AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') 
           BETWEEN oc.opening_balance_date AND (mr.period_start - INTERVAL '1 day')::DATE
      ), 0
    ))::NUMERIC(15,2) as opening_balance_calculated,
    -- Period movement sum
    (SELECT COALESCE(SUM(balance_impact), 0)
     FROM ledger_entry le
     WHERE le.account_id = mr.account_id
       AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
         BETWEEN mr.period_start AND mr.period_end
    )::NUMERIC(15,2) as period_movement_sum_calculated,
    -- Closing: opening + all movements until period_end
    (oc.opening_balance + COALESCE(
      (SELECT SUM(balance_impact) FROM ledger_entry le
       WHERE le.account_id = mr.account_id
         AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= mr.period_end
      ), 0
    ))::NUMERIC(15,2) as closing_balance_calculated
  FROM monthly_reconciliation mr
  LEFT JOIN opening_config oc ON oc.account_id = mr.account_id
),
with_observations AS (
  SELECT
    pd.*,
    rs.observed_balance as closing_balance_observed,
    rs.observed_at as closing_observed_at,
    rs.source_method as closing_source_method,
    pfo.observed_net as period_flow_observed,
    pfo.observed_at as period_flow_observed_at,
    pfo.source_method as period_flow_source_method
  FROM period_data pd
  LEFT JOIN (
    SELECT * FROM reconciliation_snapshot
    WHERE supersedes_snapshot_id IS NULL
  ) rs ON rs.id = pd.closing_snapshot_id
  LEFT JOIN (
    SELECT * FROM period_flow_observation
    WHERE supersedes_observation_id IS NULL
  ) pfo ON pfo.id = pd.period_flow_observation_id
)
SELECT
  id,
  account_id,
  period_start,
  period_end,
  opening_balance,
  opening_balance_date,
  opening_balance_calculated,
  period_movement_sum_calculated,
  closing_balance_calculated,
  closing_balance_observed,
  closing_observed_at,
  closing_source_method,
  (closing_balance_observed - closing_balance_calculated)::NUMERIC(15,2) as account_balance_variance,
  period_flow_observed,
  period_flow_observed_at,
  period_flow_source_method,
  (period_flow_observed - period_movement_sum_calculated)::NUMERIC(15,2) as period_flow_discrepancy,
  status,
  variance_approval_note,
  approved_by,
  approved_at,
  created_at,
  updated_at
FROM with_observations;
```

---

## DECISIONES ARQUITECTURA

### Opening Balance
- **Source:** `account_balance` (opening_balance + opening_balance_date) — solo configuración, no cache
- **Cálculo:** opening_balance + SUM(ledger.balance_impact desde opening_date HASTA period_start-1)
- **Validación:** Query verifica consistency en VIEW

### Closing Balance
- **Cálculo:** opening_balance + SUM(ledger.balance_impact HASTA period_end)
- **NUNCA:** account_balance.calculated_balance (puede quedar stale)
- **Timezone:** ART explícito en cada query

### Immutability Enforcement
- **reconciliation_snapshot:** TRIGGER `trg_reconciliation_snapshot_validate_supersession`
- **period_flow_observation:** TRIGGER `trg_period_flow_observation_validate_supersession`
- **import_period_coverage:** Policy en service layer (SQL INSERT-ONLY)
- **monthly_reconciliation:** UPDATE allowed (status, aprobación), auditar en app

### Coverage Vigente
- Múltiples evidencias por período/source
- Última vigente: `ORDER BY created_at DESC, id DESC LIMIT 1`
- View `v_latest_coverage_evidence` resuelve determinísticamente

### Period Coverage Agregado
- **COMPLETE:** report=complete AND liberaciones=complete
- **PARTIAL:** al menos uno tiene cobertura, pero no ambos complete
- **UNKNOWN:** falta evidencia vigente o hay unknown
- **NONE:** ambos explícitamente none (raro, se prefiere unknown)

### Balance Chain Coverage
Derivable pero NO persistida en DB.

Para un período dado:
1. Generar todos los meses requeridos desde opening_date hasta period_end
2. Cada mes debe tener PERIOD COVERAGE = complete
3. Si falta un mes o alguno tiene partial: balance_chain = incomplete

Validarse en service layer antes de marcar status = 'reconciled'.

---

## RESTRICCIONES GARANTIZADAS

✅ Sin CHECK con subquery (validación en TRIGGERs)  
✅ Supersession vigente: NOT EXISTS en WHERE, no IS NULL  
✅ Same-account/period supersession: TRIGGER + UNIQUE índice  
✅ Closing snapshot coincide account+period_end: TRIGGER  
✅ Approval consistency: CHECK + lógica app  
✅ opening/closing desde ledger: nunca del cache  
✅ Timezone ART explícito: en cada SUM(balance_impact)  
✅ NUMERIC(15,2): -9,999,999,999,999.99 a +9,999,999,999,999.99  
✅ Auth: TEXT, sin FK, deuda técnica documentada  
✅ RLS: ausente en FASE 1, deuda técnica  
✅ Append-only/Immutable: TRIGGERs + SQL + policy app  

---

**Estado:** SCHEMA REVISADO — LISTO PARA SEGUNDA APROBACIÓN  
**Migraciones ejecutadas:** NO  
**Datos modificados:** NO  
**Próximo paso:** Revalidar y crear 007_reconciliation_tables.sql
