-- ADR-025 — READ-ONLY. V2 compatibility test on AppGranja after upgrade-004: one classified draft proposed by the published V2
-- and CANCELLED with its button (nothing recorded). psql variables: phase (before | after), snap (the "before" line, phase after),
-- code ('' = identify by total + word), total, word. No phone, token or secret is printed.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH sn AS (
  SELECT 'p=' || (SELECT count(*) FROM sim.purchases) || ':' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
       || ':' || (SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x.id), '')) FROM sim.purchases x)
       || '|c=' || (SELECT count(*) FROM wa.confirmation)
       || '|mp=' || (SELECT count(*) FROM sim.mp_pending_outflow) || ':' || (SELECT md5(coalesce(string_agg(m::text, ',' ORDER BY m.pending_key), '')) FROM sim.mp_pending_outflow m)
       || '|pc=' || (SELECT count(*) FROM sim.expense_pending_classification) AS s),
d AS (
  SELECT x.* FROM wa.draft x
   WHERE (:'code' <> '' AND x.short_code = :'code')
      OR (:'code' = '' AND (x.payload ->> 'total')::numeric = :'total'::numeric
          AND (x.payload ->> 'concept' ILIKE '%' || :'word' || '%'
               OR EXISTS (SELECT 1 FROM wa.draft_version v JOIN wa.inbound_message m ON m.id = v.inbound_id
                           WHERE v.draft_id = x.id AND v.version = 1 AND m.text_body ILIKE '%' || :'word' || '%')))),
one AS (SELECT d.* FROM d WHERE (SELECT count(*) FROM d) = 1),
checks(grp, name, got, expected) AS (VALUES
  ('BORRADOR', 'B-1 exactly one test draft', (SELECT count(*) FROM d)::text, '1'),
  ('BORRADOR', 'B-2 classified draft: type | total | method', (SELECT type || '|' || (payload ->> 'total') || '|' || (payload ->> 'method') FROM one), 'CASUAL_EXPENSE|' || :'total' || '|CASH'),
  ('BORRADOR', 'B-3 subcategory (live catalog) = Limpieza', (SELECT c.nombre::text FROM one JOIN sim.expense_category c ON c.id = (one.payload ->> 'category_id')::uuid), 'Limpieza'),
  ('BORRADOR', 'B-4 paying account = Caja chica', (SELECT a.nombre::text FROM one JOIN sim.financial_account a ON a.id = (one.payload ->> 'account_id')::uuid), 'Caja chica'),
  ('BORRADOR', 'B-5 nothing left to choose (no category_pending / account_pending)', (SELECT (NOT (payload ? 'category_pending') AND NOT (payload ? 'account_pending'))::text FROM one), 'true'),
  ('BORRADOR', 'B-6 state', (SELECT state FROM one), 'CANCELLED'),
  ('SIN_REGISTRO', 'R-1 no purchase for the draft', (SELECT count(*) FROM sim.purchases x, one WHERE x.idempotency_key LIKE 'WA:' || one.id || ':%')::text, '0'),
  ('SIN_REGISTRO', 'R-2 no confirmation for the draft', (SELECT count(*) FROM wa.confirmation c, one WHERE c.draft_id = one.id)::text, '0'),
  ('SIN_REGISTRO', 'R-3 no pending-classification row for the draft', (SELECT count(*) FROM sim.expense_pending_classification x, one WHERE x.idempotency_key LIKE 'WA:' || one.id || ':%')::text, '0'),
  ('SIN_REGISTRO', 'R-4 cancelled by exactly one CANCEL button of this draft', (SELECT count(*) FROM wa.inbound_message m, one
      WHERE m.used_action = 'CANCEL' AND m.used_draft_id = one.id AND m.outcome = 'ACCEPTED' AND m.button_payload LIKE 'CANCEL:' || one.id || ':%')::text, '1'),
  ('SIN_REGISTRO', 'R-5 no CONFIRM attempt on the draft', (SELECT count(*) FROM wa.audit_event e, one WHERE e.draft_id = one.id AND e.action = 'CONFIRM')::text, '0'),
  ('GLOBAL', 'G-1 purchases / confirmations / MP pending (rows) / pending classification unchanged', (SELECT s FROM sn), :'snap'))
SELECT 'check|' || grp || '|' || CASE WHEN got IS NULL THEN 'UNKNOWN' WHEN got = expected THEN 'PASS' ELSE 'FAIL' END || '|' || name
       || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || expected ELSE '' END
  FROM checks WHERE :'phase' = 'after'
UNION ALL SELECT 'snap|' || s FROM sn WHERE :'phase' = 'before';
SELECT 'draft|' || x.short_code || ' ' || x.state || ' v' || x.version || ' total=' || (x.payload ->> 'total') || ' created '
       || to_char(x.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI')
  FROM wa.draft x WHERE :'phase' = 'after' AND (x.payload ->> 'total')::numeric = :'total'::numeric ORDER BY x.created_at;
ROLLBACK;
