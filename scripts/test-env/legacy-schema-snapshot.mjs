#!/usr/bin/env node
/**
 * Legacy schema snapshot — STRUCTURE ONLY, READ-ONLY.
 *
 * Resolves G-1 of MIGRATION_STRATEGY_V1.md: the operational legacy DDL is not
 * versioned in this repository, only the 12 MercadoPago migrations are.
 *
 * Read-only by construction: pg_dump --schema-only issues SELECTs against the
 * catalogs and nothing else. Data and privileges are excluded explicitly, so a
 * snapshot can never carry rows or credentials into the repository.
 *
 * NOT EXECUTED in Phase 12: no authenticated, provably read-only connection to the
 * live database exists in that session, and the Phase 12 rules forbid connecting
 * to production without one. This script exists so the snapshot can be taken later
 * without improvising it.
 *
 * Usage (run by the owner, with a read-only role):
 *   LEGACY_READONLY_DATABASE_URL="postgresql://readonly_user:***@HOST:5432/postgres" \
 *     node scripts/test-env/legacy-schema-snapshot.mjs
 *
 * Output: .planning/legacy-schema/legacy-schema-<UTC timestamp>.sql
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = resolve(REPO_ROOT, '.planning', 'legacy-schema');

function abort(message, detail) {
  console.error(`\n  ABORTED: ${message}`);
  if (detail) console.error(`  ${detail}`);
  console.error('');
  process.exit(1);
}

const rawUrl = process.env.LEGACY_READONLY_DATABASE_URL;

if (!rawUrl || rawUrl.trim() === '') {
  abort(
    'LEGACY_READONLY_DATABASE_URL is not set.',
    'Supply a connection string for a role with SELECT on the catalogs and nothing more. ' +
      'Do not reuse the application service-role credential.'
  );
}

let parsed;
try {
  parsed = new URL(rawUrl.trim());
} catch {
  abort('LEGACY_READONLY_DATABASE_URL is not a parseable URL.');
}

const redactedTarget = `${parsed.protocol}//***@${parsed.hostname}:${parsed.port || '(default)'}${parsed.pathname}`;

// The snapshot reads production on purpose, so refuse anything that is not a read
// of a remote host: a loopback target here means someone pointed this at the test
// instance, which would snapshot an empty schema and look like success.
if (['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
  abort(
    'The target is loopback, not the legacy database.',
    `${redactedTarget} — snapshotting the empty local instance would produce a false result.`
  );
}

const pgDump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
if (pgDump.error || pgDump.status !== 0) {
  abort(
    'pg_dump is not available on this machine.',
    'Install the PostgreSQL client tools (they ship with Docker Desktop, the ' +
      'PostgreSQL installer, or `scoop install postgresql`). This is the same external ' +
      'prerequisite that blocks the local test environment.'
  );
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
const outFile = resolve(OUT_DIR, `legacy-schema-${stamp}.sql`);

// Flags chosen so the output carries structure and nothing else:
//   --schema-only        no rows, ever
//   --no-owner           no role names
//   --no-privileges      no GRANT statements, so no credential topology leaks
//   --no-comments        smaller, stable diffs
//   --schema=public      the operational schema; auth/storage are Supabase-managed
const args = [
  '--schema-only',
  '--no-owner',
  '--no-privileges',
  '--no-comments',
  '--schema=public',
  '--file',
  outFile,
  rawUrl.trim(),
];

console.log(`\n  Snapshotting STRUCTURE ONLY from ${redactedTarget}`);
console.log('  Read-only: --schema-only issues no writes and excludes all rows.\n');

const result = spawnSync('pg_dump', args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });

if (result.status !== 0) {
  // stderr may contain the host but never the password, since pg_dump does not echo it
  abort('pg_dump failed.', (result.stderr || '').split('\n').slice(0, 5).join('\n  '));
}

console.log(`  Written: ${outFile.replace(REPO_ROOT, '.')}`);
console.log('\n  Next: confirm the file contains no INSERT/COPY data and no credentials:');
console.log(`    grep -cE "^(INSERT|COPY) " "${outFile.replace(REPO_ROOT, '.')}"   # expect 0`);
console.log('\n  The snapshot covers tables, columns, types, constraints, indexes, FKs,');
console.log('  RLS policies, functions and triggers of schema public — which is what');
console.log('  MIGRATION_STRATEGY_V1.md §5 needs to confirm or correct every mapping.\n');
