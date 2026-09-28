-- ============================================================================
-- TARGET V1 — 0047 MERCADO PAGO REAL-TIME TABLES (ADR-006, Step 1)
-- Authority: ADR-006 (ACCEPTED 2026-09-27, revision 3 + editorial alignment, commit 0f19603)
--            .planning/implementation-design/ADR006_SCHEMA_DELTA_V1.md §1–§7 (commit 81e0a6a)
--
-- Field-agnostic schema only. No object here reads or names a Mercado Pago
-- payment-resource field (V-2 boundary). No stored balance, remaining amount or
-- attributed total is added anywhere (invariant 27): active attribution is always
-- derived as SUM(mp_client_allocation.amount).
--
-- Existing tables receive no DDL (schema delta §8).
--
-- Privileges: every new table is created fail-closed (RLS enabled, all
-- privileges revoked from PUBLIC / anon / authenticated / service_role). The final
-- grants and policies are added by 0050 (ADR006_RLS_AND_SECURITY_V1 §2). Writes
-- happen only through SECURITY DEFINER RPCs (0048 / 0049).
-- ============================================================================

-- ── enums (schema delta §1) ────────────────────────────────────────────────
CREATE TYPE mp_delivery_status AS ENUM (
  'RECEIVED','PROCESSING','FETCHED','SIGNAL_RECORDED','FAILED_RETRYABLE','FAILED_PERMANENT','CONFIG_BLOCKED','UNSUPPORTED');
CREATE TYPE mp_match_outcome AS ENUM (
  'MATCHED','DISCREPANCY','REPORT_ONLY','MISSING_IN_REPORT','BALANCE_CHECK');

-- ── mp_webhook_delivery — inbox / work queue, NOT financial (schema delta §2) ─
CREATE TABLE mp_webhook_delivery (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_key              VARCHAR(200) NOT NULL,
  notification_sha256       CHAR(64) NOT NULL,               -- N-SHA, computed only by the inserting RPC
  key_conflict_of           UUID REFERENCES mp_webhook_delivery(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  origin                    VARCHAR(20) NOT NULL,
  topic                     VARCHAR(50) NOT NULL,
  topic_class               VARCHAR(20) NOT NULL,
  action                    VARCHAR(50),
  resource_id               VARCHAR(100),
  x_request_id              VARCHAR(128),                    -- traceability only; never the identity
  notification_payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_verified        BOOLEAN NOT NULL,
  report_source_id          UUID REFERENCES mp_source_record(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  triggered_by_delivery_id  UUID REFERENCES mp_webhook_delivery(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  received_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signal_resolution         VARCHAR(20),
  signal_resolution_reason  TEXT,
  signal_resolved_by        UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  signal_resolved_at        TIMESTAMPTZ,
  status                    mp_delivery_status NOT NULL DEFAULT 'RECEIVED',
  attempts                  INTEGER NOT NULL DEFAULT 0,
  next_attempt_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_failed_at           TIMESTAMPTZ,
  lease_expires_at          TIMESTAMPTZ,
  claim_token               UUID,
  last_error_code           VARCHAR(50),
  last_error_detail         VARCHAR(500),
  source_record_id          UUID REFERENCES mp_source_record(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mp_webhook_delivery_delivery_key_key UNIQUE (delivery_key),
  CONSTRAINT chk_delivery_origin CHECK (origin IN ('webhook','report_backfill','chargeback_refresh','manual_refetch')),
  CONSTRAINT chk_delivery_signature CHECK (origin <> 'webhook' OR signature_verified),
  CONSTRAINT chk_delivery_topic_class CHECK (topic_class IN ('payment','chargeback','unsupported')
                                             AND (origin = 'webhook' OR topic_class = 'payment')),
  CONSTRAINT chk_delivery_payment_resource CHECK (topic_class <> 'payment' OR coalesce(resource_id, '') ~ '^[0-9]{1,20}$'),
  CONSTRAINT chk_delivery_backfill_ref CHECK ((origin = 'report_backfill') = (report_source_id IS NOT NULL)),
  CONSTRAINT chk_delivery_trigger_ref CHECK ((origin = 'chargeback_refresh') = (triggered_by_delivery_id IS NOT NULL)),
  CONSTRAINT chk_delivery_payload_keys CHECK ((notification_payload
    - ARRAY['type','topic','action','data_id','live_mode','user_id','api_version','date_created','notification_id']) = '{}'::jsonb),
  CONSTRAINT chk_delivery_fetched CHECK (status <> 'FETCHED' OR source_record_id IS NOT NULL),
  CONSTRAINT chk_delivery_signal_status CHECK ((status <> 'SIGNAL_RECORDED' OR topic_class = 'chargeback')
                                               AND (topic_class <> 'chargeback' OR status <> 'FETCHED')),
  CONSTRAINT chk_delivery_signal_resolution CHECK (
        (signal_resolution IS NULL) = (signal_resolution_reason IS NULL)
    AND (signal_resolution IS NULL) = (signal_resolved_at IS NULL)
    AND (signal_resolution IS NOT NULL OR signal_resolved_by IS NULL)     -- resolved_by may be NULL for an automatic link
    AND (signal_resolution IS NULL OR (topic_class = 'chargeback' AND signal_resolution IN ('LINKED','DISMISSED')))),
  CONSTRAINT chk_delivery_processing CHECK ((status = 'PROCESSING') = (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT chk_delivery_attempts CHECK (attempts >= 0),
  CONSTRAINT chk_delivery_config_blocked CHECK (status <> 'CONFIG_BLOCKED' OR last_error_code IS NOT DISTINCT FROM 'AUTH_CONFIGURATION_ERROR')
);
ALTER TABLE mp_webhook_delivery ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_mp_delivery_due            ON mp_webhook_delivery(next_attempt_at) WHERE status IN ('RECEIVED','FAILED_RETRYABLE');
CREATE INDEX idx_mp_delivery_lease          ON mp_webhook_delivery(lease_expires_at) WHERE status = 'PROCESSING';
CREATE INDEX idx_mp_delivery_config_blocked ON mp_webhook_delivery(updated_at) WHERE status = 'CONFIG_BLOCKED';
CREATE INDEX idx_mp_delivery_resource       ON mp_webhook_delivery(topic, resource_id);

-- Immutable identity/notification columns; signal-resolution columns NULL → value once.
-- SECURITY INVOKER (compares OLD/NEW only), same pattern as mp_source_raw_guard (0039).
CREATE OR REPLACE FUNCTION mp_delivery_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id                       IS DISTINCT FROM OLD.id
  OR NEW.delivery_key             IS DISTINCT FROM OLD.delivery_key
  OR NEW.notification_sha256      IS DISTINCT FROM OLD.notification_sha256
  OR NEW.key_conflict_of          IS DISTINCT FROM OLD.key_conflict_of
  OR NEW.origin                   IS DISTINCT FROM OLD.origin
  OR NEW.topic                    IS DISTINCT FROM OLD.topic
  OR NEW.topic_class              IS DISTINCT FROM OLD.topic_class
  OR NEW.action                   IS DISTINCT FROM OLD.action
  OR NEW.resource_id              IS DISTINCT FROM OLD.resource_id
  OR NEW.x_request_id             IS DISTINCT FROM OLD.x_request_id
  OR NEW.notification_payload     IS DISTINCT FROM OLD.notification_payload
  OR NEW.signature_verified       IS DISTINCT FROM OLD.signature_verified
  OR NEW.report_source_id         IS DISTINCT FROM OLD.report_source_id
  OR NEW.triggered_by_delivery_id IS DISTINCT FROM OLD.triggered_by_delivery_id
  OR NEW.received_at              IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'mp_webhook_delivery notification identity is immutable';
  END IF;
  IF OLD.signal_resolution IS NOT NULL AND (
        NEW.signal_resolution        IS DISTINCT FROM OLD.signal_resolution
     OR NEW.signal_resolution_reason IS DISTINCT FROM OLD.signal_resolution_reason
     OR NEW.signal_resolved_by       IS DISTINCT FROM OLD.signal_resolved_by
     OR NEW.signal_resolved_at       IS DISTINCT FROM OLD.signal_resolved_at) THEN
    RAISE EXCEPTION 'mp_webhook_delivery signal resolution is set once';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION mp_delivery_immutable_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_delivery_immutable_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_mp_delivery_immutable
  BEFORE UPDATE ON mp_webhook_delivery
  FOR EACH ROW EXECUTE FUNCTION mp_delivery_immutable_guard();

-- ── mp_transition_identity — the anti-double-count backstop (schema delta §3) ─
-- Append-only: no UPDATE / DELETE for any role (invariant 9).
CREATE TABLE mp_transition_identity (
  id                        BIGSERIAL PRIMARY KEY,
  resource_type             VARCHAR(20)  NOT NULL,
  resource_id               VARCHAR(100) NOT NULL,
  transition                VARCHAR(30)  NOT NULL,
  transition_ref            VARCHAR(100) NOT NULL DEFAULT '',
  claimed_by_source_id      UUID   NOT NULL REFERENCES mp_source_record(id)      ON DELETE RESTRICT ON UPDATE CASCADE,
  mp_financial_movement_id  BIGINT NOT NULL REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  claimed_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mp_transition UNIQUE (resource_type, resource_id, transition, transition_ref),
  CONSTRAINT mp_transition_identity_mp_financial_movement_id_key UNIQUE (mp_financial_movement_id),
  CONSTRAINT chk_transition_resource_type CHECK (resource_type IN ('payment','report')),
  CONSTRAINT chk_transition_kind CHECK (transition IN ('APPROVAL','REFUND','CHARGEBACK','YIELD','PAYOUT','ACCOUNT_TAX')),
  CONSTRAINT chk_transition_ref CHECK ((transition = 'REFUND') = (transition_ref <> '')),
  CONSTRAINT chk_transition_payment_id CHECK (resource_type <> 'payment' OR resource_id ~ '^[0-9]{1,20}$')
);
ALTER TABLE mp_transition_identity ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_mp_transition_source   ON mp_transition_identity(claimed_by_source_id);
CREATE INDEX idx_mp_transition_resource ON mp_transition_identity(resource_type, resource_id);

-- ── mp_report_match — reconciliation evidence, no financial effect (schema delta §4)
CREATE TABLE mp_report_match (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome            mp_match_outcome NOT NULL,
  report_source_id   UUID   REFERENCES mp_source_record(id)       ON DELETE RESTRICT ON UPDATE CASCADE,
  transition_id      BIGINT REFERENCES mp_transition_identity(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  coverage_from      DATE,
  coverage_to        DATE,
  detail             JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_exception       BOOLEAN NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolution         VARCHAR(20),
  resolution_reason  TEXT,
  resolved_by        UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  resolved_at        TIMESTAMPTZ,
  CONSTRAINT chk_match_shape CHECK (CASE outcome
    WHEN 'MATCHED'           THEN report_source_id IS NOT NULL AND transition_id IS NOT NULL
    WHEN 'DISCREPANCY'       THEN report_source_id IS NOT NULL AND transition_id IS NOT NULL
    WHEN 'REPORT_ONLY'       THEN report_source_id IS NOT NULL AND transition_id IS NOT NULL
    WHEN 'MISSING_IN_REPORT' THEN transition_id IS NOT NULL AND coverage_from IS NOT NULL AND coverage_to IS NOT NULL
                                  AND report_source_id IS NULL
    WHEN 'BALANCE_CHECK'     THEN report_source_id IS NOT NULL AND transition_id IS NULL
  END),
  CONSTRAINT chk_match_exception CHECK (is_exception = (outcome IN ('DISCREPANCY','MISSING_IN_REPORT')
    OR (outcome = 'BALANCE_CHECK' AND coalesce((detail->>'difference')::NUMERIC, 0) <> 0))),
  CONSTRAINT chk_match_resolution_set CHECK (
        (resolution IS NULL) = (resolution_reason IS NULL)
    AND (resolution IS NULL) = (resolved_by IS NULL)
    AND (resolution IS NULL) = (resolved_at IS NULL)),
  CONSTRAINT chk_match_resolution_value CHECK (resolution IS NULL OR resolution IN ('EXPLAINED','CORRECTED','SUPERSEDED')),
  CONSTRAINT chk_match_resolution_only_exception CHECK (resolution IS NULL OR is_exception),
  CONSTRAINT chk_match_coverage CHECK (coverage_from IS NULL OR coverage_from <= coverage_to),
  CONSTRAINT uq_match_report_outcome UNIQUE (report_source_id, outcome)
);
ALTER TABLE mp_report_match ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX uq_match_missing ON mp_report_match(transition_id, coverage_from, coverage_to)
  WHERE outcome = 'MISSING_IN_REPORT';

-- Every column immutable; the resolution columns move NULL → value exactly once.
CREATE OR REPLACE FUNCTION mp_report_match_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id               IS DISTINCT FROM OLD.id
  OR NEW.outcome          IS DISTINCT FROM OLD.outcome
  OR NEW.report_source_id IS DISTINCT FROM OLD.report_source_id
  OR NEW.transition_id    IS DISTINCT FROM OLD.transition_id
  OR NEW.coverage_from    IS DISTINCT FROM OLD.coverage_from
  OR NEW.coverage_to      IS DISTINCT FROM OLD.coverage_to
  OR NEW.detail           IS DISTINCT FROM OLD.detail
  OR NEW.is_exception     IS DISTINCT FROM OLD.is_exception
  OR NEW.created_at       IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'mp_report_match evidence is immutable';
  END IF;
  IF OLD.resolution IS NOT NULL AND (
        NEW.resolution        IS DISTINCT FROM OLD.resolution
     OR NEW.resolution_reason IS DISTINCT FROM OLD.resolution_reason
     OR NEW.resolved_by       IS DISTINCT FROM OLD.resolved_by
     OR NEW.resolved_at       IS DISTINCT FROM OLD.resolved_at) THEN
    RAISE EXCEPTION 'mp_report_match resolution is set once';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION mp_report_match_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_report_match_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_mp_report_match_guard
  BEFORE UPDATE ON mp_report_match
  FOR EACH ROW EXECUTE FUNCTION mp_report_match_guard();

-- ── mp_client_allocation — optional client attribution, NO money (schema delta §5)
-- Append-only (invariant 9). id is supplied by the RPC so the client_ledger row can
-- reference it. Cross-row rules (same client/movement on reversals, reversal ≤
-- allocation, 0 ≤ Σ amount ≤ effective applied receipt) are enforced by the RPCs
-- under the APPROVAL-movement lock.
CREATE TABLE mp_client_allocation (
  id                        UUID PRIMARY KEY,
  mp_financial_movement_id  BIGINT NOT NULL REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cliente_id                UUID   NOT NULL REFERENCES clients(id)               ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                    NUMERIC(15,2) NOT NULL,
  origin                    VARCHAR(20) NOT NULL,
  mode                      VARCHAR(10),
  reversal_of_id            UUID   REFERENCES mp_client_allocation(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  mp_transition_id          BIGINT REFERENCES mp_transition_identity(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  effective_date            DATE NOT NULL,
  evidence                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key           VARCHAR(100) NOT NULL,
  client_ledger_id          BIGINT NOT NULL REFERENCES client_ledger(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason                    TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT mp_client_allocation_idempotency_key_key  UNIQUE (idempotency_key),
  CONSTRAINT mp_client_allocation_client_ledger_id_key UNIQUE (client_ledger_id),
  CONSTRAINT chk_alloc_amount_nonzero CHECK (amount <> 0),
  CONSTRAINT chk_alloc_origin CHECK (origin IN ('ALLOCATION','MANUAL_REVERSAL','MP_REVERSAL')),
  CONSTRAINT chk_alloc_sign CHECK ((origin = 'ALLOCATION') = (amount > 0)),
  CONSTRAINT chk_alloc_reversal_link CHECK ((origin = 'ALLOCATION') = (reversal_of_id IS NULL)),
  CONSTRAINT chk_alloc_mode CHECK ((origin = 'ALLOCATION') = (mode IS NOT NULL) AND (mode IS NULL OR mode IN ('AUTO','MANUAL'))),
  CONSTRAINT chk_alloc_mp_reversal CHECK ((origin = 'MP_REVERSAL') = (mp_transition_id IS NOT NULL)),
  CONSTRAINT chk_alloc_manual_reason CHECK (origin = 'MP_REVERSAL' OR mode IS NOT DISTINCT FROM 'AUTO'
                                            OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);
ALTER TABLE mp_client_allocation ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_mp_alloc_movement ON mp_client_allocation(mp_financial_movement_id);
CREATE INDEX idx_mp_alloc_cliente  ON mp_client_allocation(cliente_id);
CREATE INDEX idx_mp_alloc_reversal ON mp_client_allocation(reversal_of_id);

-- ── mp_payer_client_map — explicit deterministic AUTO evidence (schema delta §6)
-- No DELETE: a mapping is deactivated once, preserving the evidence of past AUTO allocations.
CREATE TABLE mp_payer_client_map (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mp_payer_id          VARCHAR(50) NOT NULL,
  cliente_id           UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  activo               BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  deactivated_at       TIMESTAMPTZ,
  deactivated_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  deactivation_reason  TEXT,
  CONSTRAINT chk_payer_id_format CHECK (mp_payer_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT chk_payer_deactivation CHECK (
        activo = (deactivated_at IS NULL)
    AND (deactivated_at IS NULL) = (deactivated_by IS NULL)
    AND (deactivated_at IS NULL) = (deactivation_reason IS NULL))
);
ALTER TABLE mp_payer_client_map ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX uq_payer_active ON mp_payer_client_map(mp_payer_id) WHERE activo;

-- ── mp_attribution_flag — the ADMIN's explicit "needs a client" marker (schema delta §7)
CREATE TABLE mp_attribution_flag (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mp_financial_movement_id  BIGINT NOT NULL REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason                    TEXT NOT NULL,
  requested_by              UUID NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  requested_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_by                UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cleared_at                TIMESTAMPTZ,
  clear_reason              TEXT,
  CONSTRAINT chk_flag_reason CHECK (length(trim(reason)) > 0),
  CONSTRAINT chk_flag_clear_set CHECK (
        (cleared_at IS NULL) = (cleared_by IS NULL)
    AND (cleared_at IS NULL) = (clear_reason IS NULL))
);
ALTER TABLE mp_attribution_flag ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX uq_flag_open ON mp_attribution_flag(mp_financial_movement_id) WHERE cleared_at IS NULL;

-- ── fail-closed privileges until 0050 ──────────────────────────────────────
REVOKE ALL ON mp_webhook_delivery, mp_transition_identity, mp_report_match,
              mp_client_allocation, mp_payer_client_map, mp_attribution_flag
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE mp_transition_identity_id_seq FROM PUBLIC, anon, authenticated, service_role;
