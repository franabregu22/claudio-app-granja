-- ADR-025 — READ-ONLY. "Registrar sin clasif" test on AppGranja (cash): a draft whose subcategory stays pending, confirmed with
-- the UNCLASSIFIED button → exactly ONE pending row (= the outflow) in the simulator, no purchase, no duplicate.
-- psql variables: phase (before | after), snap (the "before" line, phase after), code ('' = by total + word), total, word.
-- No phone, token or secret is printed.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH sn AS (
  SELECT 'p=' || (SELECT count(*) FROM sim.purchases) || ':' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
       || ':' || (SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x.id), '')) FROM sim.purchases x)
       || '|c=' || (SELECT count(*) FROM wa.confirmation)
       || '|mp=' || (SELECT count(*) FROM sim.mp_pending_outflow) || ':' || (SELECT md5(coalesce(string_agg(m::text, ',' ORDER BY m.pending_key), '')) FROM sim.mp_pending_outflow m)
       || '|pc=' || (SELECT count(*) FROM sim.expense_pending_classification)
       || '|seq=' || (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM sim.financial_operation_seq) AS s),
part AS (SELECT (SELECT s FROM sn) AS now_s, :'snap' AS pre_s),
num AS (SELECT split_part(split_part(pre_s, '|', k), '=', 2) AS pre, split_part(split_part(now_s, '|', k), '=', 2) AS now, k FROM part, generate_series(1, 5) k),
d AS (
  SELECT x.* FROM wa.draft x
   WHERE (:'code' <> '' AND x.short_code = :'code')
      OR (:'code' = '' AND (x.payload ->> 'total')::numeric = :'total'::numeric
          AND EXISTS (SELECT 1 FROM wa.draft_version v JOIN wa.inbound_message m ON m.id = v.inbound_id
                       WHERE v.draft_id = x.id AND v.version = 1 AND m.text_body ILIKE '%' || :'word' || '%'))),
one AS (SELECT d.* FROM d WHERE (SELECT count(*) FROM d) = 1),
v1 AS (SELECT v.payload FROM wa.draft_version v, one WHERE v.draft_id = one.id AND v.version = 1),
cf AS (SELECT c.* FROM wa.confirmation c, one WHERE c.draft_id = one.id),
pend AS (SELECT p.* FROM sim.expense_pending_classification p, one WHERE p.idempotency_key LIKE 'WA:' || one.id || ':%'),
taps AS (SELECT m.* FROM wa.inbound_message m, one WHERE m.button_payload LIKE 'UNCLASSIFIED:' || one.id || ':%'),
checks(grp, name, got, expected) AS (VALUES
  ('BORRADOR', 'B-1 exactly one test draft', (SELECT count(*) FROM d)::text, '1'),
  ('BORRADOR', 'B-2 type | total | method | state', (SELECT type || '|' || (payload ->> 'total') || '|' || (payload ->> 'method') || '|' || state FROM one), 'CASUAL_EXPENSE|' || :'total' || '|CASH|CONFIRMED'),
  ('BORRADOR', 'B-3 proposal (v1): subcategory PENDING, no subcategory chosen, category_options a valid array (any length: see info)',
     (SELECT (payload -> 'category_pending' = 'true'::jsonb AND payload ->> 'category_id' IS NULL AND jsonb_typeof(payload -> 'category_options') = 'array')::text FROM v1), 'true'),
  ('BORRADOR', 'B-4 proposal (v1): account Caja chica, no account pending',
     (SELECT a.nombre::text || '|' || (NOT (v1.payload ? 'account_pending'))::text FROM v1 JOIN sim.financial_account a ON a.id = (v1.payload ->> 'account_id')::uuid), 'Caja chica|true'),
  ('BORRADOR', 'B-5 proposal (v1): concept set, date = the day of the message (Argentina)',
     (SELECT (length(coalesce(v1.payload ->> 'concept', '')) > 0 AND (v1.payload ->> 'date')::date = (one.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::text FROM v1, one), 'true'),
  ('BORRADOR', 'B-6 confirmed version keeps total / concept / date / method / account of v1, still without subcategory',
     (SELECT (one.payload -> 'total' = v1.payload -> 'total' AND one.payload -> 'concept' = v1.payload -> 'concept' AND one.payload -> 'date' = v1.payload -> 'date'
              AND one.payload -> 'method' = v1.payload -> 'method' AND one.payload -> 'account_id' = v1.payload -> 'account_id' AND one.payload ->> 'category_id' IS NULL)::text FROM one, v1), 'true'),
  ('EFECTO', 'E-1 exactly ONE pending (unclassified) outflow in the simulator for this draft', (SELECT count(*) FROM pend)::text, '1'),
  ('EFECTO', 'E-2 pending row = the draft: amount | method | account | date | concept | origin',
     (SELECT (count(*) = 1 AND bool_and(p.amount = (one.payload ->> 'total')::numeric AND p.payment_method::text = 'CASH' AND a.nombre = 'Caja chica' AND p.economic_date = (one.payload ->> 'date')::date
              AND p.concept = one.payload ->> 'concept' AND p.origin = 'WHATSAPP' AND p.origin_ref ->> 'draft_short_code' = one.short_code))::text
        FROM pend p JOIN sim.financial_account a ON a.id = p.financial_account_id, one), 'true'),
  ('EFECTO', 'E-3 the pending row carries its payment operation (the outflow) and the confirmation key', (SELECT (count(*) = 1 AND bool_and(p.payment_operation_id IS NOT NULL AND p.idempotency_key = c.idempotency_key))::text FROM pend p, cf c), 'true'),
  ('EFECTO', 'E-4 NO classified purchase for this draft', (SELECT count(*) FROM sim.purchases x, one WHERE x.idempotency_key LIKE 'WA:' || one.id || ':%')::text, '0'),
  ('EFECTO', 'E-5 one confirmation: SIN_CLASIFICAR, unclassified, PAYMENT_POSTED, not a replay',
     (SELECT (c.result ->> 'status') || '|' || (c.result ->> 'unclassified') || '|' || (c.result ->> 'financial_effect') || '|' || (c.result ->> 'replayed') FROM cf c), 'SIN_CLASIFICAR|true|PAYMENT_POSTED|false'),
  ('EFECTO', 'E-6 confirmed by the UNCLASSIFIED button of this draft (never by text or by CONFIRM)',
     (SELECT (m.button_payload LIKE 'UNCLASSIFIED:' || one.id || ':%' AND m.sender_perfil_id = one.owner_perfil_id)::text FROM cf c JOIN wa.inbound_message m ON m.id = c.inbound_id, one), 'true'),
  ('DOBLE_TOQUE', 'T-2 exactly one effective confirmation (CONFIRM:CONFIRMED); any other tap = ALREADY_CONFIRMED (or the same message replayed)',
     (SELECT (count(*) FILTER (WHERE e.outcome = 'CONFIRMED') = 1 AND count(*) FILTER (WHERE e.outcome NOT IN ('CONFIRMED', 'ALREADY_CONFIRMED')) = 0)::text
        FROM wa.audit_event e, one WHERE e.draft_id = one.id AND e.action = 'CONFIRM'), 'true'),
  ('GLOBAL', 'G-1 classified purchases unchanged (count / sum / rows)', (SELECT now FROM num WHERE k = 1), (SELECT pre FROM num WHERE k = 1)),
  ('GLOBAL', 'G-2 Mercado Pago pending outflows unchanged (rows)', (SELECT now FROM num WHERE k = 3), (SELECT pre FROM num WHERE k = 3)),
  ('GLOBAL', 'G-3 exactly +1 confirmation, +1 pending row, +1 payment operation since the snapshot',
     (SELECT string_agg((nullif(now, '')::numeric - nullif(pre, '')::numeric)::text, '|' ORDER BY k) FROM num WHERE k IN (2, 4, 5)), '1|1|1'))
SELECT 'check|' || grp || '|' || CASE WHEN got IS NULL THEN 'UNKNOWN' WHEN got = expected THEN 'PASS' ELSE 'FAIL' END || '|' || name
       || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || coalesce(expected, 'NULL') ELSE '' END
  FROM checks WHERE :'phase' = 'after'
-- informative only (never a PASS requirement): how many options were offered, how many button taps reached the database
-- (a WhatsApp client may send a reply button once; double-tap idempotency is proven by the suite: U-6 and the R5 race)
UNION ALL SELECT 'info|B-3 options offered in v1|' || coalesce((SELECT jsonb_array_length(payload -> 'category_options')::text FROM v1 WHERE jsonb_typeof(payload -> 'category_options') = 'array'), '-')
  WHERE :'phase' = 'after'
UNION ALL SELECT 'info|T-1 UNCLASSIFIED button taps received|' || (SELECT count(*) FROM taps) WHERE :'phase' = 'after'
UNION ALL SELECT 'snap|' || s FROM sn WHERE :'phase' = 'before'
UNION ALL SELECT 'draft|' || x.short_code || ' ' || x.state || ' v' || x.version || ' total=' || (x.payload ->> 'total') || ' taps=' || (SELECT count(*) FROM taps)
       || ' created ' || to_char(x.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI')
  FROM one x WHERE :'phase' = 'after';
ROLLBACK;
