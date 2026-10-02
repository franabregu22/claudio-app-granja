-- PHASE 31 — LEGACY Auth inventory, READ-ONLY, COUNTS ONLY (owner-run against the LEGACY project).
-- Prints no email, hash, token or identifier. Safe to paste the OUTPUT into the runbook / chat.
-- Run in the legacy SQL editor, or: psql "<LEGACY_DB_URL>" -X -A -F '|' -f legacy-auth-counts.sql
BEGIN TRANSACTION READ ONLY;
SELECT 'auth_users' AS metric, count(*)::text AS value FROM auth.users
UNION ALL SELECT 'auth_users_unconfirmed', count(*)::text FROM auth.users WHERE email_confirmed_at IS NULL
UNION ALL SELECT 'auth_users_deleted', count(*)::text FROM auth.users WHERE deleted_at IS NOT NULL
UNION ALL SELECT 'auth_users_banned', count(*)::text FROM auth.users WHERE banned_until IS NOT NULL AND banned_until > now()
UNION ALL SELECT 'auth_users_anonymous', count(*)::text FROM auth.users WHERE is_anonymous
UNION ALL SELECT 'auth_users_sso', count(*)::text FROM auth.users WHERE is_sso_user
UNION ALL SELECT 'auth_users_without_password', count(*)::text FROM auth.users WHERE encrypted_password IS NULL OR encrypted_password = ''
UNION ALL SELECT 'identities_provider_' || provider, count(*)::text FROM auth.identities GROUP BY provider
UNION ALL SELECT 'mfa_factors', count(*)::text FROM auth.mfa_factors
UNION ALL SELECT 'users_without_perfiles', count(*)::text FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.perfiles p WHERE p.id = u.id)
UNION ALL SELECT 'perfiles_without_auth_user', count(*)::text FROM public.perfiles p WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
UNION ALL SELECT 'perfiles_by_rol_' || rol::text, count(*)::text FROM public.perfiles GROUP BY rol
UNION ALL SELECT 'sessions_informational', count(*)::text FROM auth.sessions
UNION ALL SELECT 'auth_schema_version', max(version) FROM auth.schema_migrations;
ROLLBACK;
