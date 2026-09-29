#!/usr/bin/env node
/**
 * ADR-006 Step 11 — per-environment scheduler configuration for the LOCAL test stack.
 *
 * The cron job created by 0056 reads two Vault entries by name at run time:
 *   mp_worker_url            the mp-worker endpoint as seen from the database container
 *   mp_worker_invoke_secret  the same value as the Edge Function secret WORKER_INVOKE_SECRET
 * They are environment configuration, not schema, so they are never in a migration or in git.
 *
 * Usage (values come from the caller's environment and are never printed, echoed or logged):
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   MP_WORKER_URL=http://host.docker.internal:54321/functions/v1/mp-worker \
 *   WORKER_INVOKE_SECRET=<test-only secret> \
 *     node scripts/target-db/mp_scheduler_config.mjs            # create or update both entries
 *   node scripts/target-db/mp_scheduler_config.mjs --clear       # remove both (the job then does nothing)
 *
 * Fail closed: a missing value aborts with no write; there is no default secret. The target must be
 * the guarded local test database, and the URL must point at a local host.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSafeDestructiveTarget, assertNoProductionCredentials } from '../test-env/guard.mjs';

export const VAULT_URL_NAME = 'mp_worker_url';
export const VAULT_SECRET_NAME = 'mp_worker_invoke_secret';
const LOCAL_URL = /^http:\/\/(host\.docker\.internal|localhost|127\.0\.0\.1|kong|supabase_kong_[A-Za-z0-9_]+)(:\d+)?\/functions\/v1\/mp-worker$/;

function dockerBin() {
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  if (existsSync(c)) return c;
  throw new Error('docker not found');
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Runs SQL through stdin as the owner (the value never appears in argv). Returns stdout only. */
function ownerSql(sqlText) {
  const docker = dockerBin();
  const container = (spawnSync(docker, ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean)[0];
  if (!container) throw new Error('no running supabase_db container');
  const r = spawnSync(docker, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sqlText });
  // never surface the statement text (it contains the value); only the server error line
  if (r.status !== 0) throw new Error(`vault configuration failed: ${(r.stderr || '').split('\n').find((l) => /ERROR/.test(l)) ?? 'psql error'}`);
  return (r.stdout || '').trim();
}

const upsert = (name, value, description) => `
SELECT vault.update_secret(id, ${lit(value)}) FROM vault.secrets WHERE name = ${lit(name)};
SELECT vault.create_secret(${lit(value)}, ${lit(name)}, ${lit(description)}) WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = ${lit(name)});`;

export function configureScheduler({ url, secret }) {
  if (!url || !secret) throw new Error('MP_WORKER_URL and WORKER_INVOKE_SECRET are both required (no default, no fallback)');
  if (!LOCAL_URL.test(url)) throw new Error('MP_WORKER_URL must be a local mp-worker endpoint for this script');
  ownerSql(`${upsert(VAULT_URL_NAME, url, 'ADR-006 mp-worker endpoint (scheduler)')}
${upsert(VAULT_SECRET_NAME, secret, 'ADR-006 mp-worker invoke secret (scheduler)')}`);
}
export function clearScheduler() {
  ownerSql(`DELETE FROM vault.secrets WHERE name IN (${lit(VAULT_URL_NAME)}, ${lit(VAULT_SECRET_NAME)});`);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/').replace(/^\//, '')}` || process.argv[1]?.endsWith('mp_scheduler_config.mjs')) {
  assertNoProductionCredentials(process.env);
  assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
  if (process.argv.includes('--clear')) {
    clearScheduler();
    console.log('  scheduler vault entries removed');
  } else {
    configureScheduler({ url: process.env.MP_WORKER_URL, secret: process.env.WORKER_INVOKE_SECRET });
    console.log('  scheduler vault entries configured (values not shown)');
  }
}
