-- ADR-025 — READ-ONLY verification of one WhatsApp expense in the AppGranja bot staging (schemas wa / sim only).
-- psql variables: code (e.g. W-0007), total, concept, category, method, account, date. No phone, token or secret is printed.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH d AS (SELECT * FROM wa.draft WHERE short_code = :'code'),
c AS (SELECT x.* FROM wa.confirmation x JOIN d ON d.id = x.draft_id),
p AS (SELECT x.* FROM sim.purchases x JOIN c ON x.idempotency_key = c.idempotency_key),
cat AS (SELECT e.nombre FROM sim.expense_category e JOIN p ON p.expense_category_id = e.id),
acc AS (SELECT a.nombre FROM sim.financial_account a JOIN p ON p.paid_from_account_id = a.id),
own AS (SELECT pf.email, pf.rol_type::text AS rol FROM sim.perfiles pf JOIN d ON d.owner_perfil_id = pf.id),
checks(grp, name, got, expected) AS (VALUES
  ('GASTO', 'G-1 draft found', (SELECT count(*) FROM d)::text, '1'),
  ('GASTO', 'G-2 exactly one sim purchase for the confirmation key', (SELECT count(*) FROM p)::text, '1'),
  ('GASTO', 'G-3 purchase id = the one returned at confirmation', (SELECT (p.id::text = c.result ->> 'purchase_id')::text FROM p, c), 'true'),
  ('CAMPOS', 'F-1 amount_total', (SELECT amount_total::text FROM p), :'total'),
  ('CAMPOS', 'F-2 amount_net (cash expense: = total)', (SELECT amount_net::text FROM p), :'total'),
  ('CAMPOS', 'F-3 concept', (SELECT concept FROM p), :'concept'),
  ('CAMPOS', 'F-4 category', (SELECT nombre FROM cat), :'category'),
  ('CAMPOS', 'F-5 payment method', (SELECT payment_method::text FROM p), :'method'),
  ('CAMPOS', 'F-6 paid from account', (SELECT nombre FROM acc), :'account'),
  ('CAMPOS', 'F-7 economic date', (SELECT economic_date::text FROM p), :'date'),
  ('CAMPOS', 'F-8 nature / current / not an MP payment', (SELECT nature || '|' || is_current || '|' || (mp_source_id IS NULL) FROM p), 'OPERATING|true|true'),
  ('CAMPOS', 'F-9 draft payload = purchase (total, concept, date)', (SELECT ((d.payload ->> 'total')::numeric = p.amount_total AND d.payload ->> 'concept' = p.concept AND (d.payload ->> 'date')::date = p.economic_date)::text FROM d, p), 'true'),
  ('DUPLICADOS', 'U-1 one confirmation for the draft', (SELECT count(*) FROM c)::text, '1'),
  ('DUPLICADOS', 'U-2 purchases with this key (any)', (SELECT count(*) FROM sim.purchases x WHERE x.idempotency_key IN (SELECT idempotency_key FROM c))::text, '1'),
  ('DUPLICADOS', 'U-3 purchases tagged with this draft code in their audit reason', (SELECT count(DISTINCT a.record_id) FROM sim.audit_events a WHERE a.table_name = 'purchases' AND a.reason LIKE 'WhatsApp ' || :'code' || ' v%')::text, '1'),
  ('DUPLICADOS', 'U-4 other sim purchases with same amount + concept + date (informative: expected 0)', (SELECT count(*) FROM sim.purchases x, p WHERE x.id <> p.id AND x.amount_total = p.amount_total AND x.concept = p.concept AND x.economic_date = p.economic_date)::text, '0'),
  ('BORRADOR', 'B-1 draft state / version', (SELECT state || '|v' || version FROM d), 'CONFIRMED|v1'),
  ('BORRADOR', 'B-2 confirmation: version, key WA:<draft>:v<n>, owner = draft owner', (SELECT (c.version = d.version AND c.idempotency_key = 'WA:' || d.id || ':v' || d.version AND c.perfil_id = d.owner_perfil_id)::text FROM c, d), 'true'),
  ('BORRADOR', 'B-3 actor of the purchase = draft owner (an active synthetic ADMIN)', (SELECT (p.created_by = d.owner_perfil_id)::text || '|' || own.rol || '|' || (own.email LIKE '%@staging.invalid') FROM p, d, own), 'true|ADMIN|true'),
  ('BORRADOR', 'B-4 confirming message: explicit button of that version, used once for CONFIRM', (SELECT (m.button_payload = 'CONFIRM:' || d.id || ':' || d.version AND m.used_action = 'CONFIRM' AND m.used_draft_id = d.id AND m.outcome = 'ACCEPTED')::text
      FROM wa.inbound_message m, c, d WHERE m.id = c.inbound_id), 'true'),
  ('BORRADOR', 'B-5 nothing recorded as the gateway user', (SELECT (count(*) FILTER (WHERE x.created_by = g.gateway_user_id))::text FROM sim.purchases x, wa.config g GROUP BY g.gateway_user_id), '0'),
  ('AUDITORIA', 'A-1 sim audit: one INSERT of the purchase by the owner, reason WhatsApp <code> v<n>', (SELECT count(*) FROM sim.audit_events a, p, d WHERE a.table_name = 'purchases' AND a.record_id = p.id::text
      AND a.action = 'INSERT' AND a.performed_by = d.owner_perfil_id AND a.reason = 'WhatsApp ' || d.short_code || ' v' || d.version)::text, '1'),
  ('AUDITORIA', 'A-2 gateway audit: PROPOSE then CONFIRM/CONFIRMED, actor = owner, by the gateway user', (SELECT string_agg(e.action || ':' || e.outcome, ',' ORDER BY e.id) FILTER (WHERE e.action IN ('PROPOSE', 'CONFIRM'))
      || '|' || bool_and(e.actor_perfil_id = d.owner_perfil_id AND e.gateway_uid = g.gateway_user_id) FROM wa.audit_event e, d, wa.config g WHERE e.draft_id = d.id), 'PROPOSE:DRAFT,CONFIRM:CONFIRMED|true'),
  ('AUDITORIA', 'A-3 no FAILED confirmation for the draft', (SELECT count(*) FROM wa.audit_event e, d WHERE e.draft_id = d.id AND e.outcome = 'FAILED')::text, '0'))
SELECT 'check|' || grp || '|' || CASE WHEN got IS NULL THEN 'UNKNOWN' WHEN got = expected THEN 'PASS' ELSE 'FAIL' END || '|' || name
       || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || expected ELSE '' END
  FROM checks ORDER BY grp, name COLLATE "C";
SELECT 'info|draft ' || short_code || ' ' || state || ' v' || version || ' created ' || to_char(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI')
       || ' · versions recorded ' || (SELECT count(*) FROM wa.draft_version v WHERE v.draft_id = d.id) FROM wa.draft d WHERE short_code = :'code';
ROLLBACK;
