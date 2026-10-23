-- ADR-025 — READ-ONLY verification of a CANCELLED WhatsApp draft in the AppGranja bot staging (schemas wa / sim only).
-- psql variables: code ('' = identify automatically), total (e.g. 2500), word (e.g. limpieza). No phone, token or secret is printed.
-- Automatic identification: drafts whose payload total = :total AND whose concept or originating message mentions :word.
-- Exactly one candidate is required; otherwise every check is UNKNOWN.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH cand AS (
  SELECT d.* FROM wa.draft d
   WHERE (:'code' <> '' AND d.short_code = :'code')
      OR (:'code' = '' AND (d.payload ->> 'total')::numeric = :'total'::numeric
          AND (d.payload ->> 'concept' ILIKE '%' || :'word' || '%'
               OR EXISTS (SELECT 1 FROM wa.draft_version v JOIN wa.inbound_message m ON m.id = v.inbound_id
                           WHERE v.draft_id = d.id AND v.version = 1 AND m.text_body ILIKE '%' || :'word' || '%')))),
n AS (SELECT count(*) AS k FROM cand),
d AS (SELECT cand.* FROM cand, n WHERE n.k = 1),
checks(grp, name, got, expected) AS (VALUES
  ('ID', 'I-1 exactly one draft matches (code or amount + word)', (SELECT k::text FROM n), '1'),
  ('ESTADO', 'S-1 draft state', (SELECT state FROM d), 'CANCELLED'),
  ('ESTADO', 'S-2 draft type / method / amount', (SELECT type || '|' || (payload ->> 'method') || '|' || (payload ->> 'total') FROM d), 'CASUAL_EXPENSE|CASH|' || :'total'),
  ('COMPRA', 'P-1 sim purchases with an idempotency key of this draft', (SELECT count(*) FROM sim.purchases x, d WHERE x.idempotency_key LIKE 'WA:' || d.id || ':%')::text, '0'),
  ('COMPRA', 'P-2 sim accounting audit mentioning this draft', (SELECT count(*) FROM sim.audit_events a, d WHERE a.reason LIKE 'WhatsApp ' || d.short_code || ' v%')::text, '0'),
  ('COMPRA', 'P-3 draft has no accounting result', (SELECT (result IS NULL)::text FROM d), 'true'),
  ('CONFIRMACION', 'N-1 no wa.confirmation for the draft', (SELECT count(*) FROM wa.confirmation c, d WHERE c.draft_id = d.id)::text, '0'),
  ('CONFIRMACION', 'N-2 no CONFIRMED / FAILED confirmation event', (SELECT count(*) FROM wa.audit_event e, d WHERE e.draft_id = d.id AND e.action = 'CONFIRM' AND e.outcome IN ('CONFIRMED', 'FAILED'))::text, '0'),
  ('AUDITORIA', 'A-1 gateway audit ends with exactly one CANCEL:CANCELLED, after the PROPOSE', (SELECT (string_agg(e.action || ':' || e.outcome, ',' ORDER BY e.id) LIKE 'PROPOSE:%'
      AND string_agg(e.action || ':' || e.outcome, ',' ORDER BY e.id) LIKE '%CANCEL:CANCELLED'
      AND count(*) FILTER (WHERE e.action = 'CANCEL') = 1)::text FROM wa.audit_event e, d WHERE e.draft_id = d.id), 'true'),
  ('AUDITORIA', 'A-2 every event: actor = draft owner, channel = the gateway user', (SELECT bool_and(e.actor_perfil_id = d.owner_perfil_id AND e.gateway_uid = g.gateway_user_id)::text
      FROM wa.audit_event e, d, wa.config g WHERE e.draft_id = d.id), 'true'),
  ('AUDITORIA', 'A-3 owner is an active synthetic ADMIN', (SELECT p.rol_type::text || '|' || p.activo || '|' || (p.email LIKE '%@staging.invalid') FROM sim.perfiles p, d WHERE p.id = d.owner_perfil_id), 'ADMIN|true|true'),
  ('UNICA', 'U-1 exactly one message used to CANCEL this draft', (SELECT count(*) FROM wa.inbound_message m, d WHERE m.used_action = 'CANCEL' AND m.used_draft_id = d.id)::text, '1'),
  ('UNICA', 'U-2 that message: ACCEPTED, from the owner, "cancelar" text or the CANCEL button of the draft', (SELECT (m.outcome = 'ACCEPTED' AND m.sender_perfil_id = d.owner_perfil_id
      AND (m.button_payload LIKE 'CANCEL:' || d.id || ':%' OR lower(btrim(m.text_body)) IN ('cancelar', 'cancela', 'cancelo', 'cancel')))::text
      FROM wa.inbound_message m, d WHERE m.used_action = 'CANCEL' AND m.used_draft_id = d.id), 'true'),
  ('UNICA', 'U-3 no action on the draft after its cancellation', (SELECT count(*) FROM wa.audit_event e, d WHERE e.draft_id = d.id
      AND e.id > (SELECT min(x.id) FROM wa.audit_event x WHERE x.draft_id = d.id AND x.action = 'CANCEL') AND e.outcome NOT IN ('CANCELLED'))::text, '0'))
SELECT 'check|' || grp || '|' || CASE WHEN (SELECT k FROM n) <> 1 AND grp <> 'ID' THEN 'UNKNOWN' WHEN got IS NULL THEN 'UNKNOWN' WHEN got = expected THEN 'PASS' ELSE 'FAIL' END || '|' || name
       || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || expected ELSE '' END
  FROM checks ORDER BY grp, name COLLATE "C";
SELECT 'candidate|' || d.short_code || ' ' || d.state || ' v' || d.version || ' total=' || (d.payload ->> 'total') || ' created '
       || to_char(d.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI')
  FROM wa.draft d
 WHERE (:'code' <> '' AND d.short_code = :'code')
    OR (:'code' = '' AND (d.payload ->> 'total')::numeric = :'total'::numeric
        AND (d.payload ->> 'concept' ILIKE '%' || :'word' || '%'
             OR EXISTS (SELECT 1 FROM wa.draft_version v JOIN wa.inbound_message m ON m.id = v.inbound_id
                         WHERE v.draft_id = d.id AND v.version = 1 AND m.text_body ILIKE '%' || :'word' || '%')))
 ORDER BY d.created_at;
ROLLBACK;
