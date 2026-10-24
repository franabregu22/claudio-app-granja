-- ADR-025 — READ-ONLY. CLASSIFIED expense test on AppGranja (cash): a draft with a live subcategory, confirmed with the CONFIRM
-- button (never UNCLASSIFIED) → exactly ONE simulated purchase, no pending row, no duplicate.
-- psql variables: phase (before | after), snap (the "before" line, phase after), code ('' = by total + word), total, word, sub (subcategory).
-- No phone, token or secret is printed.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH sn AS (
  SELECT 'p=' || (SELECT count(*) FROM sim.purchases) || ':' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
       || '|c=' || (SELECT count(*) FROM wa.confirmation)
       || '|mp=' || (SELECT count(*) FROM sim.mp_pending_outflow) || ':' || (SELECT md5(coalesce(string_agg(m::text, ',' ORDER BY m.pending_key), '')) FROM sim.mp_pending_outflow m)
       || '|pc=' || (SELECT count(*) FROM sim.expense_pending_classification) || ':' || (SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x.id), '')) FROM sim.expense_pending_classification x)
       || '|seq=' || (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM sim.financial_operation_seq)
       || '|pm=' || (SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x.id), '')) FROM sim.purchases x) AS s),
part AS (SELECT (SELECT s FROM sn) AS now_s, :'snap' AS pre_s),
num AS (SELECT split_part(split_part(pre_s, '|', k), '=', 2) AS pre, split_part(split_part(now_s, '|', k), '=', 2) AS now, k FROM part, generate_series(1, 6) k),
-- preconditions (phase before): the message can only give ONE result with the live catalog
pre(n, v, w) AS (VALUES
  ('subcategory "' || :'sub' || '" selectable exactly once (no homonym in another category)', (SELECT count(*)::text FROM wa.selectable_categories() WHERE nombre = :'sub'), '1'),
  ('exactly one enabled CASH account, Caja chica (no account question)', (SELECT count(*) || ':' || coalesce(min(nombre), '-') FROM wa.selectable_accounts() WHERE method = 'CASH'), '1:Caja chica'),
  ('no open draft (DRAFT / CONFIRMING) of any sender', (SELECT count(*)::text FROM wa.draft WHERE state IN ('DRAFT', 'CONFIRMING')), '0'),
  ('no earlier draft with this total (the test draft is identified by it)', (SELECT count(*)::text FROM wa.draft WHERE (payload ->> 'total')::numeric = :'total'::numeric), '0')),
d AS (
  SELECT x.* FROM wa.draft x
   WHERE (:'code' <> '' AND x.short_code = :'code')
      OR (:'code' = '' AND (x.payload ->> 'total')::numeric = :'total'::numeric
          AND EXISTS (SELECT 1 FROM wa.draft_version v JOIN wa.inbound_message m ON m.id = v.inbound_id
                       WHERE v.draft_id = x.id AND v.version = 1 AND m.text_body ILIKE '%' || :'word' || '%'))),
one AS (SELECT d.* FROM d WHERE (SELECT count(*) FROM d) = 1),
v1 AS (SELECT v.payload FROM wa.draft_version v, one WHERE v.draft_id = one.id AND v.version = 1),
cf AS (SELECT c.* FROM wa.confirmation c, one WHERE c.draft_id = one.id),
pur AS (SELECT p.* FROM sim.purchases p, one WHERE p.idempotency_key LIKE 'WA:' || one.id || ':%'),
taps AS (SELECT m.* FROM wa.inbound_message m, one WHERE m.button_payload LIKE 'CONFIRM:' || one.id || ':%'),
checks(grp, name, got, expected) AS (VALUES
  ('BORRADOR', 'B-1 exactly one test draft', (SELECT count(*) FROM d)::text, '1'),
  ('BORRADOR', 'B-2 type | total | method | state', (SELECT type || '|' || (payload ->> 'total') || '|' || (payload ->> 'method') || '|' || state FROM one), 'CASUAL_EXPENSE|' || :'total' || '|CASH|CONFIRMED'),
  ('BORRADOR', 'B-3 proposal (v1): subcategory set to "' || :'sub' || '", nothing pending',
     (SELECT c.nombre::text || '|' || (NOT (v1.payload ? 'category_pending') AND NOT (v1.payload ? 'category_options'))::text FROM v1 JOIN sim.expense_category c ON c.id = (v1.payload ->> 'category_id')::uuid), :'sub' || '|true'),
  ('BORRADOR', 'B-4 proposal (v1): account Caja chica, no account pending',
     (SELECT a.nombre::text || '|' || (NOT (v1.payload ? 'account_pending'))::text FROM v1 JOIN sim.financial_account a ON a.id = (v1.payload ->> 'account_id')::uuid), 'Caja chica|true'),
  ('BORRADOR', 'B-5 proposal (v1): concept set, date = the day of the message (Argentina)',
     (SELECT (length(coalesce(v1.payload ->> 'concept', '')) > 0 AND (v1.payload ->> 'date')::date = (one.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::text FROM v1, one), 'true'),
  ('BORRADOR', 'B-6 confirmed version keeps total / concept / date / method / account / subcategory of v1',
     (SELECT (one.payload -> 'total' = v1.payload -> 'total' AND one.payload -> 'concept' = v1.payload -> 'concept' AND one.payload -> 'date' = v1.payload -> 'date'
              AND one.payload -> 'method' = v1.payload -> 'method' AND one.payload -> 'account_id' = v1.payload -> 'account_id'
              AND one.payload -> 'category_id' = v1.payload -> 'category_id')::text FROM one, v1), 'true'),
  ('EFECTO', 'E-1 exactly ONE simulated purchase for this draft', (SELECT count(*) FROM pur)::text, '1'),
  ('EFECTO', 'E-2 purchase = the draft: total = net | subcategory | account | method | date | concept | nature | current',
     (SELECT (count(*) = 1 AND bool_and(p.amount_total = (one.payload ->> 'total')::numeric AND p.amount_net = p.amount_total AND c.nombre = :'sub'
              AND p.expense_category_id = (one.payload ->> 'category_id')::uuid AND a.nombre = 'Caja chica' AND p.payment_method::text = 'CASH'
              AND p.economic_date = (one.payload ->> 'date')::date AND p.concept = one.payload ->> 'concept' AND p.nature::text = 'OPERATING' AND p.is_current
              AND p.supplier_id IS NULL AND p.mp_source_id IS NULL))::text
        FROM pur p JOIN sim.expense_category c ON c.id = p.expense_category_id JOIN sim.financial_account a ON a.id = p.paid_from_account_id, one), 'true'),
  ('EFECTO', 'E-3 the purchase carries its payment operation, the confirmation key and the id the confirmation returned',
     (SELECT (count(*) = 1 AND bool_and(p.paid_operation_id IS NOT NULL AND p.idempotency_key = c.idempotency_key AND p.id::text = c.result ->> 'purchase_id'))::text FROM pur p, cf c), 'true'),
  ('EFECTO', 'E-4 NO pending (unclassified) row for this draft', (SELECT count(*) FROM sim.expense_pending_classification x, one WHERE x.idempotency_key LIKE 'WA:' || one.id || ':%')::text, '0'),
  ('EFECTO', 'E-5 one confirmation: classified (not unclassified), not a replay',
     (SELECT coalesce(c.result ->> 'unclassified', 'false') || '|' || (c.result ->> 'replayed') FROM cf c), 'false|false'),
  ('EFECTO', 'E-6 confirmed by the CONFIRM button of this draft, by its owner; NO UNCLASSIFIED button ever used on it',
     (SELECT (m.button_payload LIKE 'CONFIRM:' || one.id || ':%' AND m.sender_perfil_id = one.owner_perfil_id
              AND NOT EXISTS (SELECT 1 FROM wa.inbound_message u WHERE u.button_payload LIKE 'UNCLASSIFIED:' || one.id || ':%'))::text
        FROM cf c JOIN wa.inbound_message m ON m.id = c.inbound_id, one), 'true'),
  ('DOBLE_TOQUE', 'T-2 exactly one effective confirmation (CONFIRM:CONFIRMED); any other tap = ALREADY_CONFIRMED (or the same message replayed)',
     (SELECT (count(*) FILTER (WHERE e.outcome = 'CONFIRMED') = 1 AND count(*) FILTER (WHERE e.outcome NOT IN ('CONFIRMED', 'ALREADY_CONFIRMED')) = 0)::text
        FROM wa.audit_event e, one WHERE e.draft_id = one.id AND e.action = 'CONFIRM'), 'true'),
  ('GLOBAL', 'G-1 pending (unclassified) rows unchanged (count / rows)', (SELECT now FROM num WHERE k = 4), (SELECT pre FROM num WHERE k = 4)),
  ('GLOBAL', 'G-2 Mercado Pago pending outflows unchanged (rows)', (SELECT now FROM num WHERE k = 3), (SELECT pre FROM num WHERE k = 3)),
  ('GLOBAL', 'G-3 exactly +1 purchase (+ its total), +1 confirmation, +1 payment operation since the snapshot',
     (SELECT (nullif(split_part(n1.now, ':', 1), '')::numeric - nullif(split_part(n1.pre, ':', 1), '')::numeric) || '|'
           || (nullif(split_part(n1.now, ':', 2), '')::numeric - nullif(split_part(n1.pre, ':', 2), '')::numeric) || '|'
           || (nullif(n2.now, '')::numeric - nullif(n2.pre, '')::numeric) || '|' || (nullif(n5.now, '')::numeric - nullif(n5.pre, '')::numeric)
        FROM num n1, num n2, num n5 WHERE n1.k = 1 AND n2.k = 2 AND n5.k = 5), '1|' || (:'total'::numeric + 0.00) || '|1|1'),
  ('GLOBAL', 'G-4 every purchase that existed before the snapshot is unchanged',
     (SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x.id), '')) FROM sim.purchases x WHERE x.idempotency_key NOT IN (SELECT idempotency_key FROM pur)),
     (SELECT pre FROM num WHERE k = 6)))
SELECT 'check|' || grp || '|' || CASE WHEN got IS NULL THEN 'UNKNOWN' WHEN got = expected THEN 'PASS' ELSE 'FAIL' END || '|' || name
       || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || coalesce(expected, 'NULL') ELSE '' END
  FROM checks WHERE :'phase' = 'after'
-- informative only: how many CONFIRM taps reached the database (a WhatsApp client may send a reply button once; double-tap
-- idempotency is proven by the suite), and the duplicate hint shown with the proposal
UNION ALL SELECT 'info|CONFIRM button taps received|' || (SELECT count(*) FROM taps) WHERE :'phase' = 'after'
UNION ALL SELECT 'pre|' || n || '|' || coalesce(v, 'NULL') || '|' || CASE WHEN v = w THEN 'PASS' ELSE 'FAIL' END FROM pre WHERE :'phase' = 'before'
UNION ALL SELECT 'snap|' || s FROM sn WHERE :'phase' = 'before'
UNION ALL SELECT 'draft|' || x.short_code || ' ' || x.state || ' v' || x.version || ' total=' || (x.payload ->> 'total') || ' taps=' || (SELECT count(*) FROM taps)
       || ' created ' || to_char(x.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI')
  FROM one x WHERE :'phase' = 'after';
ROLLBACK;
