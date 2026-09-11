# FASE 1: DISEÑO FINAL — CON DECISIONES APROBADAS

**Estado:** ✅ LISTO PARA IMPLEMENTACIÓN  
**Fecha:** 2026-09-07  
**Autor aprobador:** Decisiones de usuario registradas  

---

## DECISIONES FINALES APROBADAS

### D1: RESIDUAL AGOSTO -0.03
✅ **APROBADO** — Mantener sin alterar ledger

- No inventar observación ficticia
- Estado inicial: `needs_investigation` (NO auto-approved)
- Solo usuario puede cambiar a `variance_approved` con:
  - nota obligatoria
  - reconciled_by UUID
  - reconciled_at TIMESTAMP TZ

### D2: OBSERVACIONES SIN COBERTURA
✅ **APROBADO** — Permitir ingresar observaciones antes de importar período

- `reconciliation_snapshot` puede tener `balance_date` sin datos importados
- Lo que se BLOQUEA: marcar `monthly_reconciliation.status = reconciled` si `import_coverage != complete`
- UI: Muestra "SIN DATOS IMPORTADOS" pero permite guardar observación

### D3: CAMPOS DE RECONCILIACIÓN EN account_balance
✅ **RECHAZADO** — Mantener separación de responsabilidades

- `account_balance` = cache operativo (balance calculado diario)
- `reconciliation_snapshot` = evidencia observada (historial)
- `monthly_reconciliation` = decisión formal (status)
- NO duplicar ownership de status

---

## CORRECCIONES CONCEPTUALES INCORPORADAS

### Corrección 1: `reconciliation_snapshot` VERSIONABLE

**SIN** `UNIQUE(account_id, balance_date)`

**Estructura:**
```sql
CREATE TABLE reconciliation_snapshot (
  id BIGSERIAL PRIMARY KEY,
  
  account_id BIGINT NOT NULL,
  balance_date DATE NOT NULL,        -- Fecha económica a la que corresponde
  observed_balance DECIMAL(15,2) NOT NULL,
  observed_at TIMESTAMP TZ NOT NULL,  -- Momento real de observación
  
  source_method VARCHAR(50) NOT NULL,
  source_detail TEXT NOT NULL,
  notes TEXT,
  
  created_by UUID NOT NULL,
  created_at TIMESTAMP TZ DEFAULT NOW(),
  updated_at TIMESTAMP TZ DEFAULT NOW(),
  
  -- Índice: búsqueda de observaciones por fecha económica
  INDEX idx_reconciliation_balance_date (account_id, balance_date DESC),
  -- Índice: línea de tiempo de cuándo se observó cada balance
  INDEX idx_reconciliation_observed_at (account_id, observed_at DESC),
  
  -- NO UNIQUE: permite múltiples observaciones para misma fecha
  -- Uso: User puede actualizar observación si tenía información incorrecta
);
```

**Ejemplo:**
```
balance_date = 2026-08-31
observed_at = 2026-09-01T09:15:00-03:00
observed_balance = -124,203.27

[user descubre que transcribió mal]

balance_date = 2026-08-31
observed_at = 2026-09-01T14:30:00-03:00
observed_balance = -124,203.24

[ambas observaciones se guardan, con timestamp de cuándo se ingresaron]
```

---

### Corrección 2: NO fabricar `closing_balance_observed` de julio

**Julio inicialmente:**
```
period_start = 2026-07-01
period_end = 2026-07-31

closing_balance_calculated = -4,758,185.73  [VERIFICADO]
closing_balance_observed = NULL             [SIN PRUEBA]
closing_snapshot_id = NULL
variance = NULL
status = pending
```

**SIN crear observación ficticia** copiando calculated_balance.

Cuando tengas prueba de MP (dashboard screenshot, email, etc):
```
INSERT INTO reconciliation_snapshot (
  account_id, balance_date, observed_balance, observed_at,
  source_method, source_detail, ...
)
VALUES (
  1054315166, 2026-07-31, -4758185.73,  -- Si así lo mostró MP
  NOW(),
  'manual_dashboard',
  'Observed on MP dashboard 2026-09-07 14:30 ART',
  ...
);

-- Luego se linkea en monthly_reconciliation:
UPDATE monthly_reconciliation
SET closing_snapshot_id = [snapshot_id],
    closing_balance_observed = -4758185.73,
    variance = -4758185.73 - (-4758185.73),
    status = 'reconciled'
WHERE account_id = 1054315166 AND year = 2026 AND month = 7;
```

---

### Corrección 3: Agosto con `status = needs_investigation`

**Estado inicial agosto:**
```
period_start = 2026-08-01
period_end = 2026-08-31

closing_balance_calculated = -124,203.24  [VERIFICADO]
closing_balance_observed = NULL           [PENDIENTE OBSERVACIÓN]
closing_snapshot_id = NULL
variance = NULL
status = needs_investigation
status_notes = "Conocemos una observación real: -124,203.27 vs calculado -124,203.24 (variance -0.03). Pendiente investigación de origen."

needs_review_count = [cantidad real de FM con needs_review = TRUE]
```

**Cuando user confirme observación:**
```
Ingresa: observed_balance = -124,203.27

UPDATE monthly_reconciliation
SET closing_snapshot_id = [snapshot_id],
    closing_balance_observed = -124,203.27,
    variance = -124203.27 - (-124203.24) = -0.03,
    status = 'needs_investigation',  -- Se mantiene
    status_notes = 'Observado en MP dashboard. Variance -0.03 sin explicación. Requiere análisis.'
WHERE account_id = 1054315166 AND year = 2026 AND month = 8;
```

**Usuario puede resolver:**
```
-- OPCIÓN A: Investigación posterior
UPDATE monthly_reconciliation
SET status = 'variance_approved',
    status_notes = 'Variance -0.03 identificado como rounding UI vs DB. Aceptado como diferencia irreductible.',
    reconciled_by = [user_id],
    reconciled_at = NOW()
WHERE ...;

-- OPCIÓN B: Seguir investigando
-- status se mantiene en 'needs_investigation'
-- User adjunta evidencia en status_notes
```

---

### Corrección 4: Separación clara de responsabilidades

**`account_balance` (cache operativo):**
- ✅ Calcular diariamente
- ✅ Almacenar calculated_balance
- ✅ Referenciar observed_balance_mp (si se usa)
- ✅ Mantener variance (si se calcula)
- ❌ NO almacenar status de conciliación

**`reconciliation_snapshot` (evidencia observada):**
- ✅ Guardar múltiples observaciones por fecha
- ✅ Auditar quién/cuándo ingresó cada una
- ✅ Versionable (permite correcciones)
- ✅ Balance_date + observed_at son conceptos distintos

**`monthly_reconciliation` (decisión formal):**
- ✅ Almacenar status: pending, reconciled, needs_investigation, variance_approved, no_data
- ✅ Referenciar closing_snapshot_id (qué observación se usó)
- ✅ Guardar decisión humana (reconciled_by, reconciled_at, status_notes)
- ✅ Calcular variance una sola vez (snapshot)

---

## MODELO FINAL DE TABLAS

### Tabla 1: `reconciliation_snapshot`

```sql
CREATE TABLE reconciliation_snapshot (
  id BIGSERIAL PRIMARY KEY,
  
  -- Cuenta
  account_id BIGINT NOT NULL,
  
  -- Fechas (conceptualmente distintas)
  balance_date DATE NOT NULL,         -- Fecha económica (ej: 2026-08-31)
  observed_at TIMESTAMP TZ NOT NULL,  -- Cuándo se observó/ingresó (ej: 2026-09-01 14:30)
  
  -- Saldo observado
  observed_balance DECIMAL(15,2) NOT NULL,
  
  -- Fuente
  source_method VARCHAR(50) NOT NULL,  -- manual_dashboard, manual_email, api_balance, etc
  source_detail TEXT NOT NULL,         -- "Extracted from MP dashboard on 2026-09-01 14:30 ART"
  notes TEXT,                          -- "Includes pending transfers"
  
  -- Auditoría
  created_by UUID NOT NULL,
  created_at TIMESTAMP TZ DEFAULT NOW(),
  updated_at TIMESTAMP TZ DEFAULT NOW(),
  
  -- Índices (SIN UNIQUE para permitir múltiples versiones)
  INDEX idx_account_balance_date(account_id, balance_date DESC, observed_at DESC),
  INDEX idx_account_observed_at(account_id, observed_at DESC),
  INDEX idx_created_by(created_by, created_at DESC),
  
  CONSTRAINT valid_source CHECK (source_method IN (...)),
  CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES accounts(id)
);
```

### Tabla 2: `import_period_coverage`

```sql
CREATE TABLE import_period_coverage (
  id BIGSERIAL PRIMARY KEY,
  
  account_id BIGINT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  
  -- Qué datos tenemos
  has_liberaciones BOOLEAN DEFAULT FALSE,
  has_account_money BOOLEAN DEFAULT FALSE,
  has_other_sources BOOLEAN DEFAULT FALSE,
  
  -- Estado de cobertura
  coverage VARCHAR(20) NOT NULL,  -- 'none', 'partial', 'complete', 'unknown'
  coverage_notes TEXT,             -- Documentar QUÉ significa 'complete' para este período
  
  -- Metadata
  first_movement_date DATE,
  last_movement_date DATE,
  movement_count INTEGER,
  
  -- Auditoría
  created_at TIMESTAMP TZ DEFAULT NOW(),
  updated_at TIMESTAMP TZ DEFAULT NOW(),
  
  UNIQUE(account_id, year, month),
  INDEX idx_coverage_status(account_id, coverage),
  CONSTRAINT valid_coverage CHECK (coverage IN ('none', 'partial', 'complete', 'unknown')),
  CONSTRAINT valid_month CHECK (month >= 1 AND month <= 12)
);
```

### Tabla 3: `monthly_reconciliation`

```sql
CREATE TABLE monthly_reconciliation (
  id BIGSERIAL PRIMARY KEY,
  
  -- Identificación del período
  account_id BIGINT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  period_start DATE NOT NULL,  -- 2026-07-01
  period_end DATE NOT NULL,    -- 2026-07-31
  
  -- Saldos (SNAPSHOT HISTÓRICO, NO DERIVADO)
  opening_balance_calculated DECIMAL(15,2) NOT NULL,
  closing_balance_calculated DECIMAL(15,2) NOT NULL,
  
  -- Observación
  closing_snapshot_id BIGINT,  -- FK a reconciliation_snapshot
  closing_balance_observed DECIMAL(15,2),  -- Copia de reconciliation_snapshot.observed_balance
  
  -- Resultado de conciliación
  variance DECIMAL(15,2),  -- observed - calculated (snapshot, no derivado)
  
  -- Metadata de período
  movement_count INTEGER,      -- Derivado en queries, no persistente
  movement_sum DECIMAL(15,2),  -- Derivado en queries, no persistente
  needs_review_count INTEGER,  -- Derivado en queries, no persistente
  
  -- Coverage
  import_coverage VARCHAR(20),  -- 'none', 'partial', 'complete'
  
  -- Estado de conciliación
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- pending, reconciled, needs_investigation, variance_approved, no_data, partial_data
  
  status_notes TEXT,
  reconciled_by UUID,
  reconciled_at TIMESTAMP TZ,
  
  -- Timestamps
  created_at TIMESTAMP TZ DEFAULT NOW(),
  updated_at TIMESTAMP TZ DEFAULT NOW(),
  
  UNIQUE(account_id, year, month),
  INDEX idx_status(account_id, status),
  INDEX idx_monthly_ym(account_id, year, month),
  
  -- FKs
  CONSTRAINT fk_closing_snapshot FOREIGN KEY (closing_snapshot_id) 
    REFERENCES reconciliation_snapshot(id) ON DELETE SET NULL,
  CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT valid_status CHECK (status IN (
    'pending', 'reconciled', 'needs_investigation', 'variance_approved', 'no_data', 'partial_data'
  )),
  CONSTRAINT valid_month CHECK (month >= 1 AND month <= 12)
);
```

---

## CAMPOS DERIVADOS (NO PERSISTENTES)

Los siguientes se calculan en queries, no se guardan:

```sql
-- EN QUERIES DE AUDITORÍA:
movement_count = (
  SELECT COUNT(DISTINCT financial_movement_id)
  FROM ledger_entry
  WHERE account_id = mr.account_id
    AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') 
        BETWEEN mr.period_start AND mr.period_end
)

movement_sum = (
  SELECT COALESCE(SUM(balance_impact), 0)
  FROM ledger_entry
  WHERE account_id = mr.account_id
    AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
        BETWEEN mr.period_start AND mr.period_end
)

needs_review_count = (
  SELECT COUNT(DISTINCT fm.id)
  FROM mp_financial_movement fm
  WHERE fm.account_id = mr.account_id
    AND fm.needs_review = TRUE
    AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires')
        BETWEEN mr.period_start AND mr.period_end
)
```

**Razón:** Evitar datos stale si se actualiza ledger retroactivamente.

---

## ESTADO INICIAL JULIO-AGOSTO

### Julio 2026:

```
period_start = 2026-07-01
period_end = 2026-07-31

opening_balance_calculated = 9,937,335.27   [SUM de extras 01-03/07]
closing_balance_calculated = -4,758,185.73
closing_snapshot_id = NULL
closing_balance_observed = NULL
variance = NULL

import_coverage = 'complete'
status = pending
status_notes = "Awaiting observación de cierre de Mercado Pago (31/07)"
needs_review_count = [TBD, buscar en BD]
```

### Agosto 2026:

```
period_start = 2026-08-01
period_end = 2026-08-31

opening_balance_calculated = -4,758,185.73
closing_balance_calculated = -124,203.24
closing_snapshot_id = [TBD, cuando ingrese observación]
closing_balance_observed = NULL (inicialmente)
variance = NULL

import_coverage = 'complete'
status = needs_investigation
status_notes = "Residual -0.03: calculated -124,203.24 vs observed -124,203.27. Causa desconocida, requiere investigación."
needs_review_count = [TBD]
```

---

## TIMEZONE — CRÍTICO ANTES DE ENERO-JUNIO

### Defecto identificado:

Función `calculate_ledger_balance()` y trigger `trg_update_balance_on_ledger` usan:

```sql
DATE(occurred_at)  -- Sin AT TIME ZONE
```

Debería ser:

```sql
DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
```

### Impacto:

- Julio-agosto: Aparentemente sin impacto (movimientos en horarios de negocio)
- Enero-junio: Riesgo crítico si hay movimientos entre 00:00-03:00 UTC (21:00-00:00 ART anterior día)

### Antes de importar enero-junio:

1. Auditar que NO hay movimientos en zona UTC 00:00-03:00
2. Corregir ambas funciones
3. Re-calcular account_balance para cualquier período problemático

### Para FASE 1:

- Documentar como blocker
- NO bloquear FASE 1 (julio-agosto no afectados)
- Incluir en migración de enero-junio

---

## AUSENCIA DE DATOS: ESTADOS

### `import_period_coverage = 'none'`:

```
status = 'no_data'
closing_balance_observed = NULL
variance = NULL

UI: "NO DATA IMPORTED - Cannot reconcile without imported movements"
```

### `import_period_coverage = 'partial'`:

```
status = 'partial_data'
closing_balance_observed = [permitido]
variance = [calculado, pero...]

UI: "DATA INCOMPLETE - Reconciliation is partial. Cannot mark as 'reconciled' until complete import."
```

### `import_period_coverage = 'complete'`:

```
status = pending | reconciled | needs_investigation | variance_approved

UI: "Can reconcile. Observación opcional pero conciliación es válida."
```

---

## ORDEN DE IMPLEMENTACIÓN (REVISADO)

### Migración 007: `reconciliation_snapshot`
- Sin UNIQUE en (account_id, balance_date)
- Índices en balance_date y observed_at

### Migración 008: `import_period_coverage`
- Estados: none, partial, complete, unknown
- Campos descriptivos para QUÉ significa cada estado

### Migración 009: `monthly_reconciliation`
- Snapshot de opening + closing (NO derivados)
- FK a reconciliation_snapshot
- Status con 6 valores (pending, reconciled, needs_investigation, variance_approved, no_data, partial_data)

### Backfill inicial:
- Julio: status = pending (esperando observación)
- Agosto: status = needs_investigation (residual conocido)

### Corrección de timezone (FUTURE):
- Antes de enero-junio
- Migración XXX que corrija calculate_ledger_balance() y trigger

---

## CRITERIOS DE ACEPTACIÓN (FINAL)

- [ ] reconciliation_snapshot permite múltiples observaciones por fecha
- [ ] Julio estado = pending (sin observación ficticia)
- [ ] Agosto estado = needs_investigation (residual documentado)
- [ ] account_balance sin cambios (solo usado como cache)
- [ ] Status de conciliación SOLO en monthly_reconciliation
- [ ] FK de closing_snapshot_id auditado correctamente
- [ ] Campos derivados en queries, no persistentes
- [ ] Timezone documentado como blocker para enero-junio
- [ ] Cero datos FASE 0 modificados durante FASE 1

---

**LISTO PARA IMPLEMENTACIÓN DE MIGRACIONES**
