#!/usr/bin/env node
/**
 * Phase 31 provision-target.mjs — vault-set worker URL validation and connection-ref guards. OFFLINE: no case reaches a
 * database or Vault. A case that PASSES the URL validation stops at the next check (WORKER_INVOKE_SECRET is unset on
 * purpose), so nothing is ever written.
 *
 * Usage: node scripts/phase31/provision-target.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { stateFailures } from './verify-state.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const P = join(REPO, 'scripts', 'phase31', 'provision-target.mjs');
const REF = 'abcdefghijklmnopqrst';
const OTHER = 'zyxwvutsrqponmlkjihg';
const LEGACY = 'legacyrefxxxxxxxxxxx';
let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`    OK   ${label}`); } else { fail++; console.log(`    MAL  ${label} :: ${String(detail).slice(0, 300)}`); } };

function vaultSet({ dbUrl, host, workerUrl }) {
  const env = { ...process.env, CUTOVER_TARGET_DB_URL: dbUrl };
  delete env.WORKER_INVOKE_SECRET;
  const args = [P, 'vault-set', '--kind', 'PRODUCTION_TARGET', '--expected-host', host, '--expected-ref', REF,
    '--forbidden-hosts', `db.${LEGACY}.supabase.co`, '--forbidden-refs', LEGACY, '--client', 'no-such-container'];
  if (workerUrl !== undefined) args.push('--worker-url', workerUrl);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  return `${r.stdout || ''}${r.stderr || ''}`;
}
const urlAccepted = (out) => /\[SECRET\]: WORKER_INVOKE_SECRET/.test(out);           // validation passed, stopped at the next check
const urlRefused = (out) => /\[USAGE\]: --worker-url must be exactly https:\/\/abcdefghijklmnopqrst\.supabase\.co\/functions\/v1\/mp-worker/.test(out);
const GOOD = `https://${REF}.supabase.co/functions/v1/mp-worker`;
const DIRECT = { dbUrl: `postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`, host: `db.${REF}.supabase.co` };
const POOLER = { dbUrl: `postgresql://postgres.${REF}:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`, host: 'aws-0-sa-east-1.pooler.supabase.com' };

let out = vaultSet({ ...DIRECT, workerUrl: GOOD });
check('W1 direct DB host + the expected-ref worker URL → accepted', urlAccepted(out), out);
out = vaultSet({ ...POOLER, workerUrl: GOOD });
check('W2 Session Pooler host + the expected-ref worker URL → accepted (the API host comes from --expected-ref, not the pooler host)', urlAccepted(out), out);
out = vaultSet({ ...POOLER, workerUrl: `https://${OTHER}.supabase.co/functions/v1/mp-worker` });
check('W3 pooler host + a worker URL of ANOTHER project ref → refused', urlRefused(out), out);
out = vaultSet({ ...POOLER, workerUrl: `https://${REF}.supabase.co/functions/v1/mp-webhook` });
check('W4 correct ref, wrong function path → refused', urlRefused(out), out);
out = vaultSet({ ...POOLER, workerUrl: `http://${REF}.supabase.co/functions/v1/mp-worker` });
check('W5 http instead of https → refused', urlRefused(out), out);
out = vaultSet({ ...POOLER, workerUrl: `${GOOD}/extra` });
check('W6 arbitrary suffix after the path → refused', urlRefused(out), out);
out = vaultSet({ ...POOLER, workerUrl: `${GOOD}?x=1` });
check('W7 query string appended → refused', urlRefused(out), out);
out = vaultSet({ ...POOLER, workerUrl: 'not a url' });
check('W8 malformed URL → refused', urlRefused(out), out);
out = vaultSet({ ...POOLER, workerUrl: `https://${REF}.supabase.co.evil.example/functions/v1/mp-worker` });
check('W9 look-alike host (ref as a subdomain prefix) → refused', urlRefused(out), out);
out = vaultSet({ ...POOLER });
check('W10 missing --worker-url → refused', /\[USAGE\]: --worker-url https:\/\/<target-ref>/.test(out), out);
// connection-ref guards are unchanged
out = vaultSet({ dbUrl: `postgresql://postgres.${OTHER}:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`, host: 'aws-0-sa-east-1.pooler.supabase.com', workerUrl: GOOD });
check('W11 pooler user of another project ref → refused before any URL check (connection ref guard unchanged)', /connection project ref zyxwvutsrqponmlkjihg differs from --expected-ref/.test(out), out);
out = vaultSet({ dbUrl: `postgresql://postgres.${LEGACY}:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`, host: 'aws-0-sa-east-1.pooler.supabase.com', workerUrl: GOOD });
check('W12 the legacy project ref is refused', /differs from --expected-ref|LEGACY/.test(out), out);

// ── verify Auth / emptiness state contract (pure) ──
const RESTORED_OK = { auth_users: 5, auth_identities: 5, auth_providers: ['email'], auth_sessions: 0, auth_refresh_tokens: 0, business_facts: 0, mp_boundary: 0 };
const sf = (over, phase = 'RESTORED') => stateFailures({ ...RESTORED_OK, ...over }, phase);
check('V1 RESTORED: 5 users / 5 email identities / 0 sessions / 0 refresh tokens → PASS', sf({}).length === 0, sf({}).join(' | '));
check('V2 RESTORED: 0 users → FAIL', sf({ auth_users: 0, auth_identities: 0, auth_providers: [] }).some((x) => /^auth_users=0/.test(x)));
check('V3 RESTORED: 6 users → FAIL', sf({ auth_users: 6 }).some((x) => /^auth_users=6/.test(x)));
check('V4 RESTORED: business_facts > 0 → FAIL', sf({ business_facts: 1 }).some((x) => /^business_facts=1/.test(x)));
check('V5 RESTORED: mp_boundary > 0 → FAIL', sf({ mp_boundary: 1 }).some((x) => /mp_cutover_boundary/.test(x)));
check('V6 RESTORED: a 6th identity / a non-email provider / a live session or refresh token → FAIL',
  [sf({ auth_identities: 6 }), sf({ auth_providers: ['email', 'google'] }), sf({ auth_sessions: 1 }), sf({ auth_refresh_tokens: 1 })].every((x) => x.length === 1));
const PRE_OK = { auth_users: 0, auth_identities: 0, auth_providers: [], auth_sessions: 0, auth_refresh_tokens: 0, business_facts: 0, mp_boundary: 0 };
check('V7 PRE_RESTORE (historical provisioning): 0 Auth rows → PASS', stateFailures(PRE_OK, 'PRE_RESTORE').length === 0);
check('V8 PRE_RESTORE: 5 users → FAIL', stateFailures(RESTORED_OK, 'PRE_RESTORE').some((x) => /^auth_users=5/.test(x)));
check('V9 unknown / missing auth phase → FAIL', stateFailures(RESTORED_OK, undefined).length === 1);
const vr = spawnSync(process.execPath, [P, 'verify', '--kind', 'PRODUCTION_TARGET', '--expected-host', 'h', '--client', 'c'], { encoding: 'utf8', env: { ...process.env, CUTOVER_TARGET_DB_URL: '' } });
check('V10 verify without --auth-phase is refused before any connection', /verify requires --auth-phase/.test(`${vr.stdout}${vr.stderr}`), vr.stderr);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
