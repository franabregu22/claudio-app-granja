-- ADR-025 §18 — READ-ONLY verification of upgrade-003 (wa.duplicate_refs + duplicates in wa_propose / wa_correct) on AppGranja.
-- psql variable: pre = accounting snapshot taken right before the upgrade (same expression as SNAP below, saved by apply-upgrade-003.sh).
-- Nothing is written: BEGIN READ ONLY ... ROLLBACK. No phone, token or secret is printed.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH fr AS (SELECT p.* FROM pg_proc p WHERE p.oid = to_regprocedure('wa.duplicate_refs(jsonb, uuid)')),
api AS (SELECT p.* FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.wa_propose(bigint, text, jsonb)'), to_regprocedure('public.wa_correct(bigint, uuid, integer, jsonb)'))),
w11 AS (SELECT * FROM wa.draft WHERE short_code = 'W-0011'),
refs AS (SELECT wa.duplicate_refs(w11.payload, w11.owner_perfil_id) AS j, wa.duplicate_hint(w11.payload) AS hint FROM w11),
nonadmin AS (SELECT wa.duplicate_refs(w11.payload, (SELECT gateway_user_id FROM wa.config WHERE singleton)) AS j FROM w11),
snap AS (SELECT 'purchases=' || (SELECT count(*) FROM sim.purchases) || '|sum=' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
           || '|current=' || (SELECT count(*) FROM sim.purchases WHERE is_current) || '|fiscal=' || (SELECT count(*) FROM sim.fiscal_document)
           || '|sim_audit=' || (SELECT count(*) FROM sim.audit_events) || '|mp_pending=' || (SELECT count(*) FROM sim.mp_pending_outflow)
           || '|confirmations=' || (SELECT count(*) FROM wa.confirmation) AS s),
checks(grp, name, got, expected) AS (VALUES
  ('FUNCION', 'F-1 wa.duplicate_refs(jsonb, uuid) exists, owner postgres, SQL STABLE',
     (SELECT count(*)::text || '|' || min(pg_get_userbyid(fr.proowner)) || '|' || min(fr.provolatile::text) FROM fr), '1|postgres|s'),
  ('FUNCION', 'F-2 wa.duplicate_refs not executable by PUBLIC / anon / authenticated / service_role',
     (SELECT (NOT has_function_privilege('anon', fr.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', fr.oid, 'EXECUTE')
              AND NOT has_function_privilege('service_role', fr.oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(fr.proacl, acldefault('f', fr.proowner))) a WHERE a.grantee = 0))::text FROM fr), 'true'),
  ('API', 'A-1 wa_propose / wa_correct: same signatures, SECURITY DEFINER, EXECUTE authenticated only, return duplicates',
     (SELECT count(*)::text FROM api WHERE api.prosecdef AND has_function_privilege('authenticated', api.oid, 'EXECUTE') AND NOT has_function_privilege('anon', api.oid, 'EXECUTE')
        AND NOT has_function_privilege('service_role', api.oid, 'EXECUTE') AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(api.proacl, acldefault('f', api.proowner))) a WHERE a.grantee = 0)
        AND api.prosrc LIKE '%''possible_duplicates'', wa.duplicate_hint(p), ''duplicates'', wa.duplicate_refs(p, %'), '2'),
  ('API', 'A-2 public wa_* functions unchanged in number', (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\_%'), '8'),
  ('REFERENCIAS', 'R-1 W-0011 (owner = ADMIN viewer) → exactly W-0007: 15000.00 · 2026-10-22 · Insumos · "Alimento y" · other category',
     (SELECT jsonb_array_length(j) || '|' || (j -> 0 ->> 'ref') || '|' || (j -> 0 ->> 'total') || '|' || (j -> 0 ->> 'date') || '|' || (j -> 0 ->> 'category')
             || '|' || (j -> 0 ->> 'concept') || '|' || (j -> 0 ->> 'same_category') FROM refs), '1|W-0007|15000.00|2026-10-22|Insumos|Alimento y|false'),
  ('REFERENCIAS', 'R-2 same criterion as the hint: references = min(hint, 3)', (SELECT (jsonb_array_length(j) = least(hint, 3))::text || '|hint=' || hint FROM refs), 'true|hint=1'),
  ('REFERENCIAS', 'R-3 no ids, actors, accounts or phones in the references', (SELECT (j::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-|\+?549|created_by|account')::text FROM refs), 'true'),
  ('VISIBILIDAD', 'V-1 a viewer that is not an active mapped ADMIN (the gateway user) sees only date / total / same_category',
     (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM nonadmin, jsonb_array_elements(nonadmin.j) e, jsonb_object_keys(e) k), 'date,same_category,total'),
  ('VISIBILIDAD', 'V-2 an unknown viewer id gets the same reduced view', (SELECT string_agg(DISTINCT k, ',' ORDER BY k)
     FROM w11, jsonb_array_elements(wa.duplicate_refs(w11.payload, '00000000-0000-4000-8000-000000000000'::uuid)) e, jsonb_object_keys(e) k), 'date,same_category,total'),
  ('SIN_CAMBIOS', 'N-1 accounting / confirmation snapshot identical to the one taken right before the upgrade', (SELECT s FROM snap), :'pre'),
  ('SIN_CAMBIOS', 'N-2 W-0007 purchase intact (one row, 15000.00, current)', (SELECT count(*)::text || '|' || coalesce(min(x.amount_total)::text, '-') || '|' || coalesce(bool_and(x.is_current)::text, '-')
      FROM sim.purchases x JOIN wa.confirmation c ON c.idempotency_key = x.idempotency_key JOIN wa.draft d ON d.id = c.draft_id WHERE d.short_code = 'W-0007'), '1|15000.00|true'),
  ('SIN_CAMBIOS', 'N-3 W-0011 not confirmed: DRAFT v2, no confirmation, no purchase', (SELECT w11.state || '|v' || w11.version || '|' || (SELECT count(*) FROM wa.confirmation c WHERE c.draft_id = w11.id)
      || '|' || (SELECT count(*) FROM sim.purchases x WHERE x.idempotency_key LIKE 'WA:' || w11.id || ':%') FROM w11), 'DRAFT|v2|0|0'))
SELECT 'check|' || grp || '|' || CASE WHEN got IS NULL THEN 'UNKNOWN' WHEN got = expected THEN 'PASS' ELSE 'FAIL' END || '|' || name
       || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || expected ELSE '' END
  FROM checks ORDER BY grp, name COLLATE "C";
SELECT 'info|snapshot now: ' || s FROM (SELECT 'purchases=' || (SELECT count(*) FROM sim.purchases) || '|sum=' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
           || '|current=' || (SELECT count(*) FROM sim.purchases WHERE is_current) || '|fiscal=' || (SELECT count(*) FROM sim.fiscal_document)
           || '|sim_audit=' || (SELECT count(*) FROM sim.audit_events) || '|mp_pending=' || (SELECT count(*) FROM sim.mp_pending_outflow)
           || '|confirmations=' || (SELECT count(*) FROM wa.confirmation) AS s) x;
ROLLBACK;
