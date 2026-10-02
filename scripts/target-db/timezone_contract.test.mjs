#!/usr/bin/env node
/**
 * Timezone contract (migration 0072, Phase 31 pre-provisioning). LOCAL TEST DATABASE ONLY.
 *
 * The database session is UTC; business "today" is (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE.
 * Scenarios run in a rolled-back transaction (no residue).
 *
 * Usage: TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/timezone_contract.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
if (!container) { console.error('no local supabase_db container'); process.exit(1); }
const run = (sql) => {
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { encoding: 'utf8', input: sql });
  return { ok: r.status === 0, out: (r.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '', err: (r.stderr || '').trim() };
};
let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`    OK   ${label}`); } else { fail++; console.log(`    MAL  ${label} :: ${String(detail).slice(0, 300)}`); } };
const BA = "(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date";

let r = run(`SELECT current_setting('TimeZone');`);
check('Z1 the database session timezone is UTC (contract; provisioning verifies the same on the target)', r.out === 'UTC', r.out);
r = run(`SELECT count(*) FROM migration_ledger.applied WHERE filename = '0072_business_today_buenos_aires.sql';`);
check('Z2 migration 0072 is in the ledger', r.out === '1', r.out);
r = run(`SELECT (SELECT count(*) FROM pg_views WHERE schemaname = 'public' AND definition ~* '\\mCURRENT_DATE\\M')
  + (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND (qual ~* '\\mCURRENT_DATE\\M' OR with_check ~* '\\mCURRENT_DATE\\M'))
  + (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ~* '\\mCURRENT_DATE\\M');`);
check('Z3 no public view, policy or function uses CURRENT_DATE (UTC date) as business today', r.out === '0', r.out);
r = run(`SELECT pg_get_viewdef('report_flock_day'::regclass) ~ 'America/Argentina/Buenos_Aires' AND pg_get_viewdef('report_flock_day'::regclass) !~* '\\mCURRENT_DATE\\M';`);
check('Z4 report_flock_day bounds an open flock with the Buenos Aires business date', r.out === 't', r.out);
r = run(`SELECT (timestamptz '2026-10-15 00:30:00+00' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date || '|' || (timestamptz '2026-10-15 00:30:00+00')::date
  || '|' || (timestamptz '2026-10-15 02:59:59.999+00' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date || '|' || (timestamptz '2026-10-15 03:00:00+00' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;`);
check('Z5 boundary: 21:30 / 23:59:59.999 Argentina is still the previous day in Buenos Aires while the UTC date has already changed; 00:00 Argentina is the new day',
  r.out === '2026-10-14|2026-10-15|2026-10-14|2026-10-15', r.out);
// an open flock entered 3 days before business today: the calculated series must end exactly at business today
r = run(`BEGIN;
INSERT INTO sheds (id, nombre) VALUES ('7a000000-0000-4000-8000-000000000001', 'TZ-TEST galpón');
INSERT INTO flocks (id, shed_id, estado, genetics_line, entry_date, initial_population, exit_date)
VALUES ('7a000000-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-000000000001', 'ACTIVE', 'TZ', ${BA} - 3, 100, NULL);
SELECT (max(business_date) = ${BA}) || '|' || count(*) FROM report_flock_day WHERE flock_id = '7a000000-0000-4000-8000-000000000002';
ROLLBACK;`);
check('Z6 report_flock_day: an open flock\'s last calculated day is the Buenos Aires business today (4 days: entry .. today)', r.out === 'true|4', r.out || r.err);
r = run(`SELECT qual FROM pg_policies WHERE tablename = 'feed_formula_version' AND policyname = 'feed_formula_version_operator_select';`);
check('Z7 OPERATOR formula visibility depends on the role only (0067), never on a server date', r.out === "(current_app_role() = 'OPERATOR'::text)", r.out);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
