-- ============================================================================
-- TARGET V1 — 0049 MERCADO PAGO DELIVERY: CHARGEBACK ENVELOPE PAYLOAD KEYS
-- (ADR-006, Step 4)
-- Authority: ADR006_SCHEMA_DELTA_V1 §2 (chk_delivery_payload_keys: "chargeback-
--            specific keys are added only if V-1 documents them");
--            ADR006_V1_WEBHOOK_EVIDENCE.md §2 / §6 (S3 documents `actions` and
--            `data.payment_id` in the chargeback notification body);
--            owner decision 2026-09-28: a new 0049; the planned payment RPCs,
--            privileges/RLS and views become 0050, 0051 and 0052.
--
-- Envelope evidence only. `data_payment_id` is never financial truth: no amount,
-- no treasury write and no API call derives from it here.
-- No function, grant or policy changes; the SECURITY DEFINER set is unchanged.
-- ============================================================================

ALTER TABLE mp_webhook_delivery DROP CONSTRAINT chk_delivery_payload_keys;

ALTER TABLE mp_webhook_delivery ADD CONSTRAINT chk_delivery_payload_keys CHECK (
      (notification_payload
         - ARRAY['type','topic','action','data_id','live_mode','user_id','api_version','date_created','notification_id',
                 'actions','data_payment_id']) = '{}'::jsonb
  -- the two chargeback keys exist only on chargeback deliveries
  AND (topic_class = 'chargeback' OR NOT (notification_payload ?| ARRAY['actions','data_payment_id']))
  -- `actions`: a JSON array (S3: ["changed_case_status"])
  AND (NOT (notification_payload ? 'actions') OR jsonb_typeof(notification_payload -> 'actions') = 'array')
  -- `data_payment_id`: a payment id as a digit string (same grammar as chk_delivery_payment_resource)
  AND (NOT (notification_payload ? 'data_payment_id')
       OR (jsonb_typeof(notification_payload -> 'data_payment_id') = 'string'
           AND (notification_payload ->> 'data_payment_id') ~ '^[0-9]{1,20}$'))
);
