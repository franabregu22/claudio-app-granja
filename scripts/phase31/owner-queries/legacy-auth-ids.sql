-- PHASE 31 — LEGACY auth.users id list (ids only; no email / hash). Owner-run; save OUTSIDE the repository as
-- legacy-auth-ids.txt (one uuid per line), for `migrate-cutover.mjs auth-check --legacy-auth-ids <file>`.
--   psql "<LEGACY_DB_URL>" -X -A -t -c "\copy (SELECT id FROM auth.users ORDER BY id) TO STDOUT" > <private dir>/legacy-auth-ids.txt
SELECT id FROM auth.users ORDER BY id;
