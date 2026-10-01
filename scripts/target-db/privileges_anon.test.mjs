#!/usr/bin/env node
/**
 * Pre-cutover B-1 regression (migration 0069). LOCAL TEST DATABASE ONLY.
 *
 * On a canonical rebuild with the current Supabase image, anon must execute NO SECURITY DEFINER function in public,
 * and authenticated must keep EXECUTE on the six early definers revoked from anon by 0069.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/privileges_anon.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
if (!container) { console.error('no local supabase_db container'); process.exit(1); }
const q = (sql) => {
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error(r.stderr);
  return (r.stdout || '').trim();
};
let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`    OK   ${label}`); } else { fail++; console.log(`    MAL  ${label} :: ${detail}`); } };

const SIX = ['assert_period_open', 'cancel_order', 'current_app_role', 'deliver_order', 'rectify_delivered_order', 'register_collection'];
const anonDefiners = q(`SELECT coalesce(string_agg(proname, ',' ORDER BY proname), '') FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND prosecdef AND has_function_privilege('anon', oid, 'EXECUTE');`);
check('B1 anon executes no SECURITY DEFINER function in public', anonDefiners === '', anonDefiners);
const authSix = q(`SELECT string_agg(proname || ':' || has_function_privilege('authenticated', oid, 'EXECUTE'), ',' ORDER BY proname) FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname IN (${SIX.map((s) => `'${s}'`).join(',')});`);
check('B2 authenticated keeps EXECUTE on the six early definers', authSix === SIX.map((s) => `${s}:true`).join(','), authSix);
const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
  { encoding: 'utf8', input: `BEGIN;\nSET LOCAL ROLE anon;\nSET LOCAL "request.jwt.claims" = '{"role":"anon"}';\nSELECT current_app_role();\nCOMMIT;` });
check('B3 anon calling current_app_role() is refused by privilege (permission denied)', r.status !== 0 && /permission denied for function/i.test(r.stderr), (r.stderr || '').split('\n')[0]);
const ledger = q(`SELECT count(*) FROM migration_ledger.applied WHERE filename = '0069_revoke_anon_execute_early_definers.sql';`);
check('B4 migration 0069 is in the ledger', ledger === '1', ledger);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
