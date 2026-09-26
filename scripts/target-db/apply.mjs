#!/usr/bin/env node
/**
 * TARGET V1 migration runner — LOCAL TEST DATABASE ONLY.
 *
 * Why this exists instead of supabase/migrations:
 *   supabase/migrations/ holds the 12 legacy MercadoPago migrations, two numbered
 *   009 and two numbered 010 (finding F-12-1). They stay untouched and disabled via
 *   `[db.migrations] enabled = false`. Target V1 keeps its own history, in its own
 *   directory, with its own ledger, so the two histories never share a namespace.
 *
 * Guarantees:
 *   1. ATOMIC: each migration's SQL and its ledger INSERT run in ONE PostgreSQL
 *      transaction (psql -1, ON_ERROR_STOP=1). Either both commit or neither does:
 *      no applied objects without a ledger row, no ledger row without the objects.
 *      There is no window between "migration committed" and "ledger written".
 *   2. PRECHECKED: before anything is applied, every file name is validated and
 *      duplicate version prefixes are rejected, so 0010_a.sql + 0010_b.sql aborts
 *      with nothing applied.
 *   3. NO TRANSACTION CONTROL INSIDE FILES: a file containing BEGIN / COMMIT /
 *      ROLLBACK / END could end the wrapping transaction early and break (1), so
 *      it is rejected up front.
 *   4. IMMUTABLE HISTORY: an applied migration whose sha256 changed is rejected.
 *   5. RACE-SAFE: the ledger is re-read before each file, an advisory lock
 *      serialises concurrent runners, the version is re-checked inside the
 *      transaction, and the ledger primary key makes a double-apply impossible.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/apply.mjs [--status]
 *
 * Test-only overrides (used by apply.test.mjs; defaults are the real ones):
 *   TARGET_MIGRATIONS_DIR     directory of migration files
 *   MIGRATION_LEDGER_SCHEMA   schema holding the `applied` ledger table
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = process.env.TARGET_MIGRATIONS_DIR
  ? resolve(process.env.TARGET_MIGRATIONS_DIR)
  : resolve(REPO_ROOT, 'supabase', 'target-migrations');
const LEDGER_SCHEMA = process.env.MIGRATION_LEDGER_SCHEMA || 'migration_ledger';

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const IDENT_PATTERN = /^[a-z_][a-z0-9_]*$/;
// Top-level transaction control would end psql's wrapping transaction early.
// Evaluated only after dollar-quoted bodies, string literals and comments are
// removed, so BEGIN/END inside a plpgsql function or DO block does not trip it.
const TXN_CONTROL =
  /^\s*(BEGIN|COMMIT|ROLLBACK|ABORT|END|START\s+TRANSACTION|SAVEPOINT|RELEASE)\b[^;\n]*;/im;

function resolveDockerBin() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const candidate = resolve(
    process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'
  );
  return existsSync(candidate) ? candidate : 'docker';
}
const DOCKER = resolveDockerBin();

function fail(code, message, detail) {
  console.error(`\n  MIGRATION RUN FAILED [${code}]: ${message}`);
  if (detail) console.error(`  ${String(detail).split('\n').slice(0, 12).join('\n  ')}`);
  process.exit(1);
}

function docker(args, input) {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail('DOCKER', 'could not run docker', r.error.message);
  return r;
}

/**
 * Reduces SQL to its top-level statements for the transaction-control check:
 * removes dollar-quoted bodies ($$…$$, $tag$…$tag$), single-quoted literals,
 * block comments and line comments.
 */
function topLevelSql(sqlText) {
  return sqlText
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, '');
}

// ── 1. Validate the file set BEFORE touching any database ───────────────────
if (!IDENT_PATTERN.test(LEDGER_SCHEMA)) {
  fail('LEDGER_SCHEMA', `invalid ledger schema name "${LEDGER_SCHEMA}"`);
}
if (!existsSync(MIGRATIONS_DIR)) fail('NO_DIR', 'migrations directory not found', MIGRATIONS_DIR);

const allSql = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
if (allSql.length === 0) fail('NO_FILES', 'no migration files found', MIGRATIONS_DIR);

const badNames = allSql.filter((f) => !FILE_PATTERN.test(f));
if (badNames.length > 0) {
  fail('BAD_FILENAME', 'migration file names must match NNNN_lowercase_words.sql', badNames.join('\n'));
}

const byVersion = new Map();
for (const f of allSql) {
  const version = f.match(FILE_PATTERN)[1];
  if (!byVersion.has(version)) byVersion.set(version, []);
  byVersion.get(version).push(f);
}
const duplicates = [...byVersion.entries()].filter(([, names]) => names.length > 1);
if (duplicates.length > 0) {
  fail(
    'DUPLICATE_VERSION',
    'two or more target migrations share a version prefix; nothing was applied',
    duplicates.map(([v, names]) => `${v}: ${names.join(', ')}`).join('\n')
  );
}

const files = allSql.sort((a, b) => a.localeCompare(b, 'en')).map((f) => {
  const body = readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8');
  return {
    file: f,
    version: f.match(FILE_PATTERN)[1],
    body,
    sha: createHash('sha256').update(body).digest('hex'),
  };
});

const withTxnControl = files.filter((m) => TXN_CONTROL.test(topLevelSql(m.body)));
if (withTxnControl.length > 0) {
  fail(
    'TXN_CONTROL',
    'migration files must not contain transaction control; the runner owns the transaction',
    withTxnControl.map((m) => m.file).join('\n')
  );
}

// ── 2. Guard, then locate the container ─────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (docker(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '')
  .trim().split('\n').filter(Boolean)[0];
if (!container) fail('NO_CONTAINER', 'no running supabase_db container', 'Run `supabase start` first.');

const mapping = (docker(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) {
  fail('PORT_MISMATCH', 'container port mapping does not match the guarded target', `mapping="${mapping}"`);
}
console.log(`  container: ${container}`);

function sql(statement) {
  const r = docker([
    'exec', '-i', container,
    'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-c', statement,
  ]);
  if (r.status !== 0) fail('SQL', `SQL failed: ${statement.slice(0, 90)}`, r.stderr);
  return (r.stdout || '').trim();
}

// ── 3. Ledger, outside the target schema ────────────────────────────────────
const LEDGER = `${LEDGER_SCHEMA}.applied`;
sql(`CREATE SCHEMA IF NOT EXISTS ${LEDGER_SCHEMA};`);
sql(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
       version     TEXT PRIMARY KEY,
       filename    TEXT NOT NULL,
       sha256      TEXT NOT NULL,
       applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
     );`);

function readLedger() {
  const rows = sql(`SELECT version || '|' || sha256 FROM ${LEDGER} ORDER BY version;`);
  return new Map(rows ? rows.split('\n').map((l) => l.split('|')) : []);
}

// Checksum immutability is verified for the whole set before any new file runs.
const initial = readLedger();
for (const m of files) {
  if (initial.has(m.version) && initial.get(m.version) !== m.sha) {
    fail(
      'CHECKSUM_CHANGED',
      `migration ${m.version} changed after it was applied; nothing was applied`,
      `recorded sha256 ${initial.get(m.version)}\n  current  sha256 ${m.sha}\n  An applied migration must never be edited. Add a new one instead.`
    );
  }
}

if (process.argv.includes('--status')) {
  console.log('\n  version  status      file');
  for (const m of files) {
    console.log(`  ${m.version.padEnd(8)} ${(initial.has(m.version) ? 'applied' : 'pending').padEnd(11)} ${m.file}`);
  }
  console.log(`\n  ${initial.size} applied, ${files.length - initial.size} pending\n`);
  process.exit(0);
}

console.log(`\n  target-migrations: ${files.length} files, ${initial.size} already applied\n`);

// ── 4. Apply: migration SQL + ledger row in ONE transaction ─────────────────
let ran = 0;
for (const m of files) {
  // Re-read per file: never act on a stale view of the ledger.
  const current = readLedger();
  if (current.has(m.version)) {
    if (current.get(m.version) !== m.sha) {
      fail('CHECKSUM_CHANGED', `migration ${m.version} changed after it was applied`);
    }
    console.log(`  = ${m.file} (already applied)`);
    continue;
  }

  // version / file / sha are validated (digits, [a-z0-9_], hex) so they are safe literals.
  const script = `
SELECT pg_advisory_xact_lock(hashtext('target_v1_migration_runner'));
DO $runner$
BEGIN
  IF EXISTS (SELECT 1 FROM ${LEDGER} WHERE version = '${m.version}') THEN
    RAISE EXCEPTION 'ALREADY_APPLIED: % was applied concurrently', '${m.version}';
  END IF;
END
$runner$;

${m.body}

INSERT INTO ${LEDGER} (version, filename, sha256)
VALUES ('${m.version}', '${m.file}', '${m.sha}');
`;

  const r = docker(
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres',
     '-v', 'ON_ERROR_STOP=1', '-1', '-q', '-f', '-'],
    script
  );
  if (r.status !== 0) {
    fail('APPLY', `migration ${m.file} failed; its SQL and its ledger row were rolled back together`, r.stderr);
  }
  console.log(`  + ${m.file}`);
  ran += 1;
}

console.log(`\n  applied ${ran} new migration(s); ledger now holds ${sql(`SELECT count(*) FROM ${LEDGER};`)}\n`);
