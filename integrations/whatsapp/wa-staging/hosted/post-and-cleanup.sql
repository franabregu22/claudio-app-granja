-- ADR-025 §18 hosted — post-run verification (effects only in sim, actors = draft owners) and cleanup of THIS run.
-- Variables: t0 (database time before the run), gw, admin_a, admin_b, expected_purchases.
\set ON_ERROR_STOP 1
BEGIN;
WITH checks(name, got, expected) AS (VALUES
  ('P-1 sim purchases created by the run', (SELECT count(*) FROM sim.purchases WHERE created_at >= :'t0'::timestamptz)::text, :'expected_purchases'),
  ('P-2 every purchase: actor = confirmation owner = draft owner (A or B)', (SELECT count(*) FROM sim.purchases p JOIN wa.confirmation c ON c.idempotency_key = p.idempotency_key
      JOIN wa.draft d ON d.id = c.draft_id WHERE p.created_at >= :'t0'::timestamptz AND p.created_by = c.perfil_id AND c.perfil_id = d.owner_perfil_id
      AND p.created_by IN (:'admin_a'::uuid, :'admin_b'::uuid))::text, :'expected_purchases'),
  ('P-3 nothing recorded as the gateway user', ((SELECT count(*) FROM sim.purchases WHERE created_by = :'gw'::uuid) + (SELECT count(*) FROM sim.audit_events WHERE performed_by = :'gw'::uuid))::text, '0'),
  ('P-4 one confirmation per purchase, keys WA:<draft>:v<n>', (SELECT count(*) FILTER (WHERE idempotency_key ~ '^WA:[0-9a-f-]{36}:v[0-9]+$') FROM wa.confirmation WHERE confirmed_at >= :'t0'::timestamptz)::text, :'expected_purchases'),
  ('P-5 outflow 25002 classified once, linked by exactly one draft', (SELECT count(*) FROM sim.purchases WHERE mp_source_id = '930000025002')
      || '|' || (SELECT count(*) FROM wa.draft WHERE payload ->> 'mp_source_id' = '930000025002'), '1|1'),
  ('P-6 refusals audited: bad signatures ≥ 2, unauthorized senders ≥ 2', ((SELECT count(*) FROM wa.audit_event WHERE at >= :'t0'::timestamptz AND outcome = 'BAD_SIGNATURE') >= 2
      AND (SELECT count(*) FROM wa.audit_event WHERE at >= :'t0'::timestamptz AND outcome = 'UNAUTHORIZED_SENDER') >= 2)::text, 'true'),
  ('P-7 public still has no tables (accounting only in sim)', (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public')::text, '0'),
  ('P-8 no outbound HTTP from the database during the run', CASE WHEN to_regclass('net._http_response') IS NULL THEN '0'
      ELSE (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM net._http_response WHERE created >= %L::timestamptz', :'t0'), false, true, '')))[1]::text END, '0'))
SELECT 'post|' || CASE WHEN got IS NOT DISTINCT FROM expected THEN 'PASS ' ELSE 'FAIL ' END || name || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || expected ELSE '' END
  FROM checks ORDER BY name COLLATE "C";
-- cleanup: only rows of this run (all created at or after t0), the temporary secret, the sim outflow classifications
DELETE FROM wa.confirmation WHERE confirmed_at >= :'t0'::timestamptz;
DELETE FROM wa.draft_version WHERE created_at >= :'t0'::timestamptz;
DELETE FROM wa.draft WHERE created_at >= :'t0'::timestamptz;
DELETE FROM wa.audit_event WHERE at >= :'t0'::timestamptz;
DELETE FROM wa.inbound_message WHERE received_at >= :'t0'::timestamptz;
DELETE FROM sim.audit_events WHERE created_at >= :'t0'::timestamptz;
UPDATE sim.mp_pending_outflow SET classified_as = NULL, purchase_id = NULL, status = 'PENDING'
 WHERE purchase_id IN (SELECT id FROM sim.purchases WHERE created_at >= :'t0'::timestamptz);
DELETE FROM sim.purchases WHERE created_at >= :'t0'::timestamptz;
DELETE FROM sim.fiscal_document WHERE created_at >= :'t0'::timestamptz;
DELETE FROM vault.secrets WHERE name = 'wa_meta_app_secret';
SELECT 'residue|wa_rows=' || ((SELECT count(*) FROM wa.draft) + (SELECT count(*) FROM wa.inbound_message) + (SELECT count(*) FROM wa.confirmation) + (SELECT count(*) FROM wa.audit_event))
       || ' sim_purchases=' || (SELECT count(*) FROM sim.purchases) || ' outflows_pending=' || (SELECT count(*) FROM sim.mp_pending_outflow WHERE classified_as IS NULL)
       || ' secret=' || (SELECT count(*) FROM vault.secrets WHERE name = 'wa_meta_app_secret')
       || ' senders=' || (SELECT count(*) FROM wa.sender) || ' enabled=' || (SELECT enabled FROM wa.config);
COMMIT;
