-- ADR-025 B-4 / A — PRODUCTION pilot ADMIN candidates, READ-ONLY (one READ ONLY transaction, rolled back).
-- Prints, per active ADMIN profile: the first 8 characters of its id and NON-identifying recognition hints (Auth state,
-- account / last sign-in DATES, how many purchases / audit events it authored, last purchase date). No name, email, phone,
-- full UUID, amount or secret. psql variables p1, p2 = the two chosen 8-char prefixes ('' = list only, no validation).
\set ON_ERROR_STOP 1
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH a AS (
  SELECT p.id, left(p.id::text, 8) AS pre,
         u.id IS NOT NULL AS has_auth,
         u.deleted_at IS NULL AS not_deleted,
         coalesce(u.banned_until IS NULL OR u.banned_until < now(), false) AS not_banned,
         u.email_confirmed_at IS NOT NULL AS confirmed,
         NOT coalesce(u.is_anonymous, false) AS not_anonymous,
         u.created_at::date AS auth_created, u.last_sign_in_at::date AS last_sign_in,
         (SELECT count(*) FROM purchases x WHERE x.created_by = p.id) AS purchases_n,
         (SELECT max(x.created_at)::date FROM purchases x WHERE x.created_by = p.id) AS last_purchase,
         (SELECT count(*) FROM audit_events e WHERE e.performed_by = p.id) AS audit_n
    FROM perfiles p LEFT JOIN auth.users u ON u.id = p.id
   WHERE p.activo AND p.rol_type::text = 'ADMIN'),
e AS (SELECT a.*, (has_auth AND not_deleted AND not_banned AND confirmed AND not_anonymous) AS eligible FROM a),
pick AS (SELECT v FROM (VALUES (:'p1'), (:'p2')) t(v) WHERE v <> ''),
checks(grp, name, got, expected) AS (VALUES
  ('6_ADMIN', 'A-1 at least two active ADMIN profiles with a valid Auth user (exists, not deleted / banned / anonymous, email confirmed)',
     (SELECT (count(*) FILTER (WHERE eligible) >= 2)::text FROM e), 'true'),
  ('6_ADMIN', 'A-2 8-char id prefixes are unique among all profiles (safe to name a pilot profile by prefix)',
     (SELECT (count(*) = count(DISTINCT left(id::text, 8)))::text FROM perfiles), 'true'),
  ('6_ADMIN', 'A-3 the two chosen prefixes are given and distinct', (SELECT (count(*) = 2 AND count(DISTINCT v) = 2)::text FROM pick), 'true'),
  ('6_ADMIN', 'A-4 each chosen prefix matches exactly one ELIGIBLE active ADMIN profile',
     (SELECT (count(*) = 2 AND bool_and(n = 1))::text FROM (SELECT v, (SELECT count(*) FROM e WHERE e.pre = pick.v AND e.eligible) n FROM pick) z), 'true'))
SELECT 'check|' || grp || '|' || CASE WHEN got IS NULL THEN 'UNKNOWN' WHEN got = expected THEN 'PASS' ELSE 'FAIL' END || '|' || name
       || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || expected ELSE '' END
  FROM checks
UNION ALL
SELECT 'cand|' || pre || '|eligible=' || eligible || '|auth=' || has_auth || ',deleted=' || (NOT not_deleted) || ',banned=' || (NOT not_banned)
       || ',confirmed=' || confirmed || '|auth_created=' || coalesce(auth_created::text, '-') || '|last_sign_in=' || coalesce(last_sign_in::text, '-')
       || '|purchases=' || purchases_n || '|last_purchase=' || coalesce(last_purchase::text, '-') || '|audit_events=' || audit_n
       || CASE WHEN pre IN (SELECT v FROM pick) THEN '|CHOSEN' ELSE '' END
  FROM e
ORDER BY 1;
ROLLBACK;
