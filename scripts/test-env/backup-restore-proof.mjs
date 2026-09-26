#!/usr/bin/env node
/**
 * Phase 12 backup / restore proof — LOCAL TEST DATABASE ONLY.
 *
 * Proves a real backup and a real restore round-trip using canary data, so the
 * roadmap criterion "Backup and restore proven in that environment" rests on an
 * execution rather than on a script existing.
 *
 * Every database operation goes through the guard first. pg_dump / psql are invoked
 * inside the local stack's own container, so no global PostgreSQL install is needed.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/test-env/backup-restore-proof.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDestructiveTarget } from './guard.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACT_DIR = resolve(REPO_ROOT, '.planning', 'phase12-evidence');
const FIXTURE = 'public._phase12_fixture';
const DUMP_IN_CONTAINER = '/tmp/phase12_backup.sql';

/**
 * Docker Desktop is installed per-user on this machine, so docker.exe is not on the
 * PATH of a fresh shell. Resolve it explicitly, preferring anything already on PATH.
 */
function resolveDockerBin() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const candidates = [
    resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return 'docker';
}

const DOCKER = resolveDockerBin();

let step = 0;
function heading(text) {
  step += 1;
  console.log(`\n── ${step}. ${text} ${'─'.repeat(Math.max(0, 56 - text.length))}`);
}

function fail(message, detail) {
  console.error(`\n  PROOF FAILED: ${message}`);
  if (detail) console.error(`  ${detail}`);
  process.exit(1);
}

function docker(args, { input } = {}) {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail('could not run docker', r.error.message);
  return r;
}

/** Runs SQL in the local container and returns trimmed stdout. */
function sql(statement, { expectOk = true } = {}) {
  const r = docker([
    'exec', '-i', containerName,
    'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    '-c', statement,
  ]);
  if (expectOk && r.status !== 0) fail(`SQL failed: ${statement}`, (r.stderr || '').trim());
  return (r.stdout || '').trim();
}

// ── Guard first, before anything touches a database ─────────────────────────
heading('Guard the target');
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);

// ── Identify the container that backs the proven target ────────────────────
heading('Resolve the local stack container');
const psOut = docker(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '';
const containerName = psOut.trim().split('\n').filter(Boolean)[0];
if (!containerName) fail('no running supabase_db container found', 'Run `supabase start` first.');
console.log(`  container: ${containerName}`);

const mapping = (docker(['port', containerName, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) {
  fail(
    'the container port mapping does not match the guarded target',
    `mapping="${mapping}" guarded port=${target.port}`
  );
}
console.log(`  port mapping confirms the guarded target: 5432/tcp -> …:${target.port}`);

// ── 1. fixture + canary rows ───────────────────────────────────────────────
heading('Create fixture and insert canary rows');
sql(`DROP TABLE IF EXISTS ${FIXTURE};`);
sql(`CREATE TABLE ${FIXTURE} (
       id      integer PRIMARY KEY,
       label   text NOT NULL,
       amount  numeric(12,2) NOT NULL,
       note    text
     );`);
sql(`INSERT INTO ${FIXTURE} (id, label, amount, note) VALUES
       (1, 'canary-alpha',   100.00, 'original'),
       (2, 'canary-bravo',   250.50, 'original'),
       (3, 'canary-charlie', 999.99, 'original'),
       (4, 'canary-delta',    -42.25, 'original'),
       (5, 'canary-echo',       0.01, 'original');`);

const CHECKSUM_SQL = `SELECT md5(string_agg(id || '|' || label || '|' || amount || '|' || coalesce(note,''), ',' ORDER BY id)) FROM ${FIXTURE};`;
const COUNT_SQL = `SELECT count(*) FROM ${FIXTURE};`;

const beforeCount = sql(COUNT_SQL);
const beforeChecksum = sql(CHECKSUM_SQL);
const beforeRows = sql(`SELECT id || ' ' || label || ' ' || amount || ' ' || coalesce(note,'') FROM ${FIXTURE} ORDER BY id;`);
console.log(`  rows: ${beforeCount}`);
console.log(`  checksum: ${beforeChecksum}`);
console.log('  expected content:');
beforeRows.split('\n').forEach((l) => console.log(`    ${l}`));

// ── 2. real backup ─────────────────────────────────────────────────────────
heading('Take a real backup (pg_dump inside the container)');
const dump = docker([
  'exec', containerName,
  'pg_dump', '-U', 'postgres', '-d', 'postgres',
  '--schema=public', '--clean', '--if-exists', '--no-owner', '--no-privileges',
  '-f', DUMP_IN_CONTAINER,
]);
if (dump.status !== 0) fail('pg_dump failed', (dump.stderr || '').trim());

const dumpBytes = sql(`SELECT 1;`) && (docker(['exec', containerName, 'wc', '-c', DUMP_IN_CONTAINER]).stdout || '').trim();
console.log(`  dump written inside container: ${DUMP_IN_CONTAINER}`);
console.log(`  size: ${dumpBytes.split(/\s+/)[0]} bytes`);

const dumpMentionsFixture = (docker(['exec', containerName, 'grep', '-c', '_phase12_fixture', DUMP_IN_CONTAINER]).stdout || '0').trim();
if (Number(dumpMentionsFixture) === 0) fail('the dump does not contain the fixture');
console.log(`  dump references the fixture ${dumpMentionsFixture} times`);

// Keep a copy on the host as phase evidence
if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });
const hostCopy = resolve(ARTIFACT_DIR, 'phase12_backup.sql');
const cp = docker(['cp', `${containerName}:${DUMP_IN_CONTAINER}`, hostCopy]);
if (cp.status !== 0) fail('could not copy the dump to the host', (cp.stderr || '').trim());
console.log(`  copied to host: ${hostCopy.replace(REPO_ROOT, '.')}`);

// ── 3. destructive mutation ────────────────────────────────────────────────
heading('Mutate the data destructively');
sql(`DELETE FROM ${FIXTURE} WHERE id IN (2, 4);`);
sql(`UPDATE ${FIXTURE} SET amount = 0, note = 'TAMPERED' WHERE id IN (1, 3);`);

const mutatedCount = sql(COUNT_SQL);
const mutatedChecksum = sql(CHECKSUM_SQL);
console.log(`  rows now: ${mutatedCount} (was ${beforeCount})`);
console.log(`  checksum now: ${mutatedChecksum}`);
sql(`SELECT id || ' ' || label || ' ' || amount || ' ' || coalesce(note,'') FROM ${FIXTURE} ORDER BY id;`)
  .split('\n')
  .forEach((l) => console.log(`    ${l}`));

if (mutatedCount === beforeCount) fail('the mutation did not change the row count — the restore would prove nothing');
if (mutatedChecksum === beforeChecksum) fail('the mutation did not change the content');
console.log('  mutation confirmed: both count and checksum differ from the original');

// ── 4. real restore ────────────────────────────────────────────────────────
heading('Restore the backup');
const restore = docker([
  'exec', containerName,
  'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', DUMP_IN_CONTAINER,
]);
if (restore.status !== 0) fail('restore failed', (restore.stderr || '').trim());
console.log('  psql applied the dump with ON_ERROR_STOP=1 and exited 0');

// ── 5. verify exact recovery ───────────────────────────────────────────────
heading('Verify the canary data came back exactly');
const afterCount = sql(COUNT_SQL);
const afterChecksum = sql(CHECKSUM_SQL);
const afterRows = sql(`SELECT id || ' ' || label || ' ' || amount || ' ' || coalesce(note,'') FROM ${FIXTURE} ORDER BY id;`);

console.log(`  rows: ${afterCount} (expected ${beforeCount})`);
console.log(`  checksum: ${afterChecksum}`);
console.log(`  expected: ${beforeChecksum}`);
afterRows.split('\n').forEach((l) => console.log(`    ${l}`));

const tampered = sql(`SELECT count(*) FROM ${FIXTURE} WHERE note = 'TAMPERED';`);

let ok = true;
if (afterCount !== beforeCount) { console.error('  MISMATCH: row count'); ok = false; }
if (afterChecksum !== beforeChecksum) { console.error('  MISMATCH: checksum'); ok = false; }
if (afterRows !== beforeRows) { console.error('  MISMATCH: row content'); ok = false; }
if (Number(tampered) !== 0) { console.error(`  MISMATCH: ${tampered} tampered rows survived`); ok = false; }

if (!ok) fail('restore did not reproduce the original data exactly');

console.log('  row count matches, checksum matches, content matches, zero tampered rows');

// ── 6. re-assert locality, then clean up ───────────────────────────────────
heading('Re-assert the target and drop the fixture');
console.log(`  target was: ${target.redacted}`);
sql(`DROP TABLE IF EXISTS ${FIXTURE};`);
const fixtureGone = sql(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='_phase12_fixture';`);
console.log(`  fixture tables remaining: ${fixtureGone}`);
docker(['exec', containerName, 'rm', '-f', DUMP_IN_CONTAINER]);

console.log('\n  BACKUP / RESTORE PROOF: PASS\n');
