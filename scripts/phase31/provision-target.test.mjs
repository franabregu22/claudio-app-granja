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

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
