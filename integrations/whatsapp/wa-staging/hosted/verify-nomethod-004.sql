-- ADR-025 — READ-ONLY. "Expense without a payment method" test on AppGranja: a draft from a message that does NOT say how it was
-- paid, an answer with the method, then CANCELLED. Nothing may be recorded. Also reports which method / account the bot set on its
-- own in v1 (diagnosis of the cash default). psql variables: phase (before | after), snap, code ('' = by total + word), total, word, sub.
-- No phone, token, secret or message text is printed.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH sn AS (
  SELECT 'p=' || (SELECT count(*) FROM sim.purchases) || ':' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
       || ':' || (SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x.id), '')) FROM sim.purchases x)
       || '|c=' || (SELECT count(*) FROM wa.confirmation)
       || '|mp=' || (SELECT md5(coalesce(string_agg(m::text, ',' ORDER BY m.pending_key), '')) FROM sim.mp_pending_outflow m)
       || '|pc=' || (SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x.id), '')) FROM sim.expense_pending_classification x)
       || '|seq=' || (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM sim.financial_operation_seq) AS s),
pre(n, v, w) AS (VALUES
  ('subcategory "' || :'sub' || '" selectable exactly once', (SELECT count(*)::text FROM wa.selectable_categories() WHERE nombre = :'sub'), '1'),
  ('no open draft (DRAFT / CONFIRMING) of any sender', (SELECT count(*)::text FROM wa.draft WHERE state IN ('DRAFT', 'CONFIRMING')), '0'),
  ('no earlier draft with this total (the test draft is identified by it)', (SELECT count(*)::text FROM wa.draft WHERE (payload ->> 'total')::numeric = :'total'::numeric), '0')),
d AS (
  SELECT x.* FROM wa.draft x
   WHERE (:'code' <> '' AND x.short_code = :'code')
      OR (:'code' = '' AND (x.payload ->> 'total')::numeric = :'total'::numeric
          AND EXISTS (SELECT 1 FROM wa.draft_version v JOIN wa.inbound_message m ON m.id = v.inbound_id
                       WHERE v.draft_id = x.id AND v.version = 1 AND m.text_body ILIKE '%' || :'word' || '%'))),
one AS (SELECT d.* FROM d WHERE (SELECT count(*) FROM d) = 1),
v1 AS (SELECT v.payload, m.text_body FROM wa.draft_version v JOIN one ON one.id = v.draft_id LEFT JOIN wa.inbound_message m ON m.id = v.inbound_id WHERE v.version = 1),
vs AS (SELECT v.* FROM wa.draft_version v JOIN one ON one.id = v.draft_id),
checks(grp, name, got, expected) AS (VALUES
  ('BORRADOR', 'N-1 exactly one test draft', (SELECT count(*) FROM d)::text, '1'),
  ('BORRADOR', 'N-2 type | total | state', (SELECT type || '|' || (payload ->> 'total') || '|' || state FROM one), 'CASUAL_EXPENSE|' || :'total' || '|CANCELLED'),
  ('BORRADOR', 'N-3 v1 subcategory = "' || :'sub' || '"', (SELECT c.nombre::text FROM v1 JOIN sim.expense_category c ON c.id = (v1.payload ->> 'category_id')::uuid), :'sub'),
  ('BORRADOR', 'N-4 every version keeps the total / concept / date / subcategory of v1', (SELECT bool_and(v.payload -> 'total' = v1.payload -> 'total' AND v.payload -> 'concept' = v1.payload -> 'concept'
       AND v.payload -> 'date' = v1.payload -> 'date' AND v.payload -> 'category_id' IS NOT DISTINCT FROM v1.payload -> 'category_id')::text FROM vs v, v1), 'true'),
  ('BORRADOR', 'N-5 the test went past v1 (the method answer produced a new version)', (SELECT (count(*) >= 2)::text FROM vs), 'true'),
  ('BORRADOR', 'N-6 v1: the method was NOT presumed (no method, no account, method_pending) — the message named none',
     (SELECT ((v1.payload ->> 'method') IS NULL AND (v1.payload ->> 'account_id') IS NULL AND v1.payload -> 'method_pending' = 'true'::jsonb
              AND NOT (v1.text_body ~* '(efectivo|cash|transfer|mercado ?pago|\mmp\M|banco|bna|patagonia|caja)'))::text FROM v1), 'true'),
  ('SIN_REGISTRO', 'R-1 no purchase for the draft', (SELECT count(*) FROM sim.purchases x, one WHERE x.idempotency_key LIKE 'WA:' || one.id || ':%')::text, '0'),
  ('SIN_REGISTRO', 'R-2 no confirmation for the draft', (SELECT count(*) FROM wa.confirmation c, one WHERE c.draft_id = one.id)::text, '0'),
  ('SIN_REGISTRO', 'R-3 no pending (unclassified) row for the draft', (SELECT count(*) FROM sim.expense_pending_classification x, one WHERE x.idempotency_key LIKE 'WA:' || one.id || ':%')::text, '0'),
  ('SIN_REGISTRO', 'R-4 no CONFIRM / UNCLASSIFIED button and no CONFIRM attempt on the draft', (SELECT ((SELECT count(*) FROM wa.inbound_message m WHERE m.button_payload LIKE 'CONFIRM:' || one.id || ':%'
       OR m.button_payload LIKE 'UNCLASSIFIED:' || one.id || ':%') + (SELECT count(*) FROM wa.audit_event e WHERE e.draft_id = one.id AND e.action = 'CONFIRM'))::text FROM one), '0'),
  ('SIN_REGISTRO', 'R-5 cancelled once, by its owner (CANCEL button or "cancelar")', (SELECT count(*)::text FROM wa.inbound_message m, one WHERE m.used_action = 'CANCEL' AND m.used_draft_id = one.id
       AND m.outcome = 'ACCEPTED' AND m.sender_perfil_id = one.owner_perfil_id), '1'),
  ('GLOBAL', 'G-1 purchases / confirmations / MP pending / pending rows / payment operations unchanged since the snapshot', (SELECT s FROM sn), :'snap'))
SELECT 'check|' || grp || '|' || CASE WHEN got IS NULL THEN 'UNKNOWN' WHEN got = expected THEN 'PASS' ELSE 'FAIL' END || '|' || name
       || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || coalesce(expected, 'NULL') ELSE '' END
  FROM checks WHERE :'phase' = 'after'
-- diagnosis (informative): what the bot set on its own when the message named no method, and how each version evolved
UNION ALL SELECT 'diag|message of v1 names a method (efectivo / transfer / mercado pago / mp / a bank)|' || (SELECT (text_body ~* '(efectivo|cash|transfer|mercado ?pago|\mmp\M|banco|bna|patagonia|caja)')::text FROM v1)
  WHERE :'phase' = 'after'
UNION ALL SELECT 'diag|v1 method | account set by the bot|' || (SELECT coalesce(v1.payload ->> 'method', '(none)') || ' | ' || coalesce(a.nombre, CASE WHEN v1.payload ? 'account_pending' THEN '(pending)' ELSE '(none)' END)
       FROM v1 LEFT JOIN sim.financial_account a ON a.id = (v1.payload ->> 'account_id')::uuid) WHERE :'phase' = 'after'
UNION ALL SELECT 'diag|versions (method | account)|' || (SELECT string_agg('v' || v.version || ' ' || coalesce(v.payload ->> 'method', '-') || ' | ' || coalesce(a.nombre, CASE WHEN v.payload ? 'account_pending' THEN '(pending)' ELSE '-' END), '; ' ORDER BY v.version)
       FROM vs v LEFT JOIN sim.financial_account a ON a.id = (v.payload ->> 'account_id')::uuid) WHERE :'phase' = 'after'
UNION ALL SELECT 'pre|' || n || '|' || coalesce(v, 'NULL') || '|' || CASE WHEN v = w THEN 'PASS' ELSE 'FAIL' END FROM pre WHERE :'phase' = 'before'
UNION ALL SELECT 'snap|' || s FROM sn WHERE :'phase' = 'before'
UNION ALL SELECT 'draft|' || x.short_code || ' ' || x.state || ' v' || x.version || ' total=' || (x.payload ->> 'total') || ' created '
       || to_char(x.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI') FROM one x WHERE :'phase' = 'after';
ROLLBACK;
