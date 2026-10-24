-- ADR-025 — READ-ONLY diagnosis of one "Registrar sin clasif" draft (B-3 / T-1). psql variable: code (e.g. W-0015).
-- Prints flags, counts, staging catalog names and times only: no phone, token, secret, message text or full UUID.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH d AS (SELECT * FROM wa.draft WHERE short_code = :'code'),
v1 AS (SELECT v.* FROM wa.draft_version v JOIN d ON d.id = v.draft_id WHERE v.version = 1),
m1 AS (SELECT m.* FROM wa.inbound_message m JOIN v1 ON m.id = v1.inbound_id),
cat AS (SELECT * FROM wa.selectable_categories()),
lines(n, k, v) AS (
  SELECT 1, 'A draft', (SELECT short_code || ' ' || state || ' v' || version || ' ' || type || ' created ' || to_char(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI:SS') FROM d)
  UNION ALL SELECT 2, 'A versions', (SELECT string_agg('v' || v.version || ' at ' || to_char(v.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI:SS'), ', ' ORDER BY v.version) FROM wa.draft_version v JOIN d ON d.id = v.draft_id)
  UNION ALL SELECT 3, 'B v1 category_pending (raw)', (SELECT coalesce(payload -> 'category_pending', 'null'::jsonb)::text FROM v1)
  UNION ALL SELECT 4, 'B v1 category_id is null', (SELECT (payload ->> 'category_id' IS NULL)::text FROM v1)
  UNION ALL SELECT 5, 'B v1 category_options (type | length)', (SELECT coalesce(jsonb_typeof(payload -> 'category_options'), 'absent') || ' | ' || coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(payload -> 'category_options') = 'array' THEN payload -> 'category_options' END), 0) FROM v1)
  UNION ALL SELECT 6, 'B v1 offered options (grupo › subcategoria)', (SELECT coalesce(string_agg(c.grupo || ' › ' || c.nombre, ', '), '(none)') FROM v1, jsonb_array_elements_text(CASE WHEN jsonb_typeof(v1.payload -> 'category_options') = 'array' THEN v1.payload -> 'category_options' ELSE '[]' END) o LEFT JOIN cat c ON c.id::text = o)
  UNION ALL SELECT 7, 'B v1 total | method | account | date | concept length', (SELECT (payload ->> 'total') || ' | ' || (payload ->> 'method') || ' | ' || coalesce((SELECT nombre FROM sim.financial_account WHERE id = (payload ->> 'account_id')::uuid), '(none)') || ' | ' || (payload ->> 'date') || ' | ' || length(coalesce(payload ->> 'concept', '')) FROM v1)
  UNION ALL SELECT 8, 'B v1 message mentions "operaci" | names a live subcategory', (SELECT (m1.text_body ILIKE '%operaci%')::text || ' | ' || coalesce((SELECT string_agg(c.nombre, ',') FROM cat c WHERE m1.text_body ILIKE '%' || c.nombre || '%'), 'none') FROM m1)
  UNION ALL SELECT 9, 'C live catalog: groups (selectable subcategories)', (SELECT string_agg(grupo || ' (' || n || ')', ', ' ORDER BY grupo) FROM (SELECT grupo, count(*) n FROM cat GROUP BY grupo) g)
  UNION ALL SELECT 10, 'C live catalog: groups whose name contains "operaci"', (SELECT count(DISTINCT grupo)::text FROM cat WHERE grupo ILIKE '%operaci%')
  UNION ALL SELECT 11, 'D inbound messages tied to the draft (id kind button outcome used_action at)', (SELECT string_agg(m.id || ' ' || m.kind || ' ' || coalesce(split_part(m.button_payload, ':', 1), 'text') || ' ' || m.outcome || ' ' || coalesce(m.used_action, '-') || ' ' || to_char(m.received_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI:SS'), '; ' ORDER BY m.id)
       FROM wa.inbound_message m, d WHERE m.used_draft_id = d.id OR m.button_payload LIKE '%' || d.id || '%')
  UNION ALL SELECT 12, 'D button messages naming the draft (any outcome / used or not)', (SELECT count(*)::text FROM wa.inbound_message m, d WHERE m.button_payload LIKE '%' || d.id || '%')
  UNION ALL SELECT 13, 'D button messages from the owner within 15 min after the confirmation (any draft)', (SELECT count(*)::text FROM wa.inbound_message m, d, wa.confirmation c
       WHERE c.draft_id = d.id AND m.sender_perfil_id = d.owner_perfil_id AND m.button_payload IS NOT NULL AND m.received_at BETWEEN c.confirmed_at - interval '1 minute' AND c.confirmed_at + interval '15 minutes')
  UNION ALL SELECT 14, 'D any inbound from the owner after the confirmation (count)', (SELECT count(*)::text FROM wa.inbound_message m, d, wa.confirmation c WHERE c.draft_id = d.id AND m.sender_perfil_id = d.owner_perfil_id AND m.received_at > c.confirmed_at)
  UNION ALL SELECT 15, 'E gateway audit of the draft (action:outcome at)', (SELECT string_agg(e.action || ':' || e.outcome || ' ' || to_char(e.at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI:SS'), ', ' ORDER BY e.id) FROM wa.audit_event e, d WHERE e.draft_id = d.id)
  UNION ALL SELECT 16, 'F confirmation: version | button | status | unclassified | effect | replayed', (SELECT c.version || ' | ' || coalesce(split_part(m.button_payload, ':', 1), 'text') || ' | ' || (c.result ->> 'status') || ' | ' || (c.result ->> 'unclassified') || ' | ' || (c.result ->> 'financial_effect') || ' | ' || (c.result ->> 'replayed')
       FROM wa.confirmation c JOIN d ON d.id = c.draft_id JOIN wa.inbound_message m ON m.id = c.inbound_id)
  UNION ALL SELECT 17, 'G pending rows of the draft (count | amount | method | account)', (SELECT count(*) || ' | ' || coalesce(min(p.amount)::text, '-') || ' | ' || coalesce(min(p.payment_method::text), '-') || ' | ' || coalesce(min(a.nombre), '-')
       FROM sim.expense_pending_classification p JOIN sim.financial_account a ON a.id = p.financial_account_id, d WHERE p.idempotency_key LIKE 'WA:' || d.id || ':%')
  UNION ALL SELECT 18, 'G classified purchases of the draft', (SELECT count(*)::text FROM sim.purchases x, d WHERE x.idempotency_key LIKE 'WA:' || d.id || ':%')
  UNION ALL SELECT 19, 'H confirmed payload: type CASUAL_EXPENSE, no category_id, account set (the UNCLASSIFIED rule)', (SELECT (d.type = 'CASUAL_EXPENSE' AND d.payload ->> 'category_id' IS NULL AND d.payload ->> 'account_id' IS NOT NULL)::text FROM d)
)
SELECT 'diag|' || lpad(n::text, 2, '0') || '|' || k || '|' || coalesce(v, 'NULL') FROM lines ORDER BY n;
ROLLBACK;
