#!/usr/bin/env node
/**
 * Mechanical tests for the TARGET V1 migration runner. LOCAL TEST DATABASE ONLY.
 *
 * Runs the real scripts/target-db/apply.mjs as a child process against temporary
 * migration directories, with a SEPARATE ledger schema (runner_ledger_test) and a
 * separate object schema (runner_test). The real ledger (migration_ledger) and the
 * Foundations schema are never touched. Both test schemas are dropped at the end.
 *
 * Proves:
 *   A. duplicate target version is rejected BEFORE anything is applied
 *   B. migration SQL failure rolls back the migration AND writes no ledger row
 *   C. ledger INSERT failure rolls back the migration's objects too
 *   D. a changed checksum is rejected, and nothing else is applied in that run
 *   E. re-run without changes applies nothing and leaves the ledger unchanged
 *   F. transaction control inside a file is rejected before anything runs,
 *      while BEGIN/END inside a plpgsql body is accepted
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/apply.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPLY = resolve(HERE, 'apply.mjs');
const LEDGER_SCHEMA = 'runner_ledger_test';
const OBJ_SCHEMA = 'runner_test';
const WORK = join(tmpdir(), `phase13-runner-test-${process.pid}`);

function resolveDockerBin() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  return existsSync(c) ? c : 'docker';
}
const DOCKER = resolveDockerBin();

assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (spawnSync(DOCKER, ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '')
  .trim().split('\n').filter(Boolean)[0];
if (!container) {
  console.error('  no running supabase_db container. Run `supabase start`.');
  process.exit(1);
}

function q(sqlText) {
  const r = spawnSync(DOCKER,
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sqlText });
  if (r.status !== 0) throw new Error(`query failed: ${sqlText}\n${r.stderr}`);
  return (r.stdout || '').trim();
}

const tableExists = (name) =>
  q(`SELECT count(*) FROM information_schema.tables WHERE table_schema='${OBJ_SCHEMA}' AND table_name='${name}';`) === '1';
const schemaExists = (name) =>
  q(`SELECT count(*) FROM information_schema.schemata WHERE schema_name='${name}';`) === '1';
const ledgerVersions = () =>
  schemaExists(LEDGER_SCHEMA)
    ? q(`SELECT coalesce(string_agg(version, ',' ORDER BY version), '') FROM ${LEDGER_SCHEMA}.applied;`)
    : '<no ledger>';

function makeDir(name, files) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
  return dir;
}

function runApply(dir) {
  const env = { ...process.env, TARGET_MIGRATIONS_DIR: dir, MIGRATION_LEDGER_SCHEMA: LEDGER_SCHEMA };
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  delete env.SUPABASE_ACCESS_TOKEN;
  delete env.SUPABASE_DB_PASSWORD;
  const r = spawnSync(process.execPath, [APPLY], { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`    OK   ${label}`); }
  else { fail += 1; console.log(`    MAL  ${label}${detail ? ` :: ${detail}` : ''}`); }
}
function section(t) { console.log(`\n  ── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`); }

function reset() {
  q(`DROP SCHEMA IF EXISTS ${OBJ_SCHEMA} CASCADE; DROP SCHEMA IF EXISTS ${LEDGER_SCHEMA} CASCADE;`);
}

const OK_0001 = `CREATE SCHEMA IF NOT EXISTS ${OBJ_SCHEMA};\nCREATE TABLE ${OBJ_SCHEMA}.t_ok (id int);\n`;

reset();
const realLedgerBefore = q(`SELECT count(*) FROM migration_ledger.applied;`);

try {
  // ── A ────────────────────────────────────────────────────────────────────
  section('A. duplicate version rejected before applying');
  let dir = makeDir('dup', {
    '0001_first.sql': `CREATE SCHEMA IF NOT EXISTS ${OBJ_SCHEMA};\nCREATE TABLE ${OBJ_SCHEMA}.dup_a (id int);\n`,
    '0001_second.sql': `CREATE SCHEMA IF NOT EXISTS ${OBJ_SCHEMA};\nCREATE TABLE ${OBJ_SCHEMA}.dup_b (id int);\n`,
  });
  let r = runApply(dir);
  check('runner exits non-zero', r.code !== 0);
  check('reports DUPLICATE_VERSION naming both files', /DUPLICATE_VERSION/.test(r.out) && /0001_first\.sql, 0001_second\.sql/.test(r.out), r.out.split('\n').find((l) => /FAILED/.test(l)));
  check('no object from either file exists', !schemaExists(OBJ_SCHEMA));
  check('no ledger was even created', !schemaExists(LEDGER_SCHEMA));

  // ── B ────────────────────────────────────────────────────────────────────
  section('B. migration SQL failure: objects and ledger roll back together');
  dir = makeDir('sqlfail', {
    '0001_ok.sql': OK_0001,
    '0002_partial_then_fail.sql': `CREATE TABLE ${OBJ_SCHEMA}.t_partial (id int);\nSELECT 1/0;\n`,
  });
  r = runApply(dir);
  check('runner exits non-zero', r.code !== 0);
  check('reports APPLY failure for 0002', /\[APPLY\]/.test(r.out) && /0002_partial_then_fail/.test(r.out));
  check('0001 before it committed normally (table present)', tableExists('t_ok'));
  check('0002 created nothing: t_partial absent', !tableExists('t_partial'));
  check('ledger holds 0001 only — no row for the failed 0002', ledgerVersions() === '0001', ledgerVersions());

  // ── C ────────────────────────────────────────────────────────────────────
  section('C. ledger INSERT failure: migration objects roll back too');
  q(`ALTER TABLE ${LEDGER_SCHEMA}.applied ADD CONSTRAINT reject_0003 CHECK (version <> '0003');`);
  dir = makeDir('ledgerfail', {
    '0001_ok.sql': OK_0001,
    '0003_valid_sql.sql': `CREATE TABLE ${OBJ_SCHEMA}.t_three (id int);\n`,
  });
  r = runApply(dir);
  check('runner exits non-zero', r.code !== 0);
  check('failure is the ledger CHECK, raised inside the same transaction', /reject_0003/.test(r.out), r.out.split('\n').find((l) => /ERROR/.test(l)));
  check('0003 SQL was valid yet rolled back: t_three absent', !tableExists('t_three'));
  check('ledger still holds 0001 only', ledgerVersions() === '0001', ledgerVersions());
  q(`ALTER TABLE ${LEDGER_SCHEMA}.applied DROP CONSTRAINT reject_0003;`);

  // ── D ────────────────────────────────────────────────────────────────────
  section('D. changed checksum rejected; nothing else applied');
  dir = makeDir('checksum', {
    '0001_ok.sql': `${OK_0001}-- edited after being applied\n`,
    '0004_new.sql': `CREATE TABLE ${OBJ_SCHEMA}.t_four (id int);\n`,
  });
  r = runApply(dir);
  check('runner exits non-zero', r.code !== 0);
  check('reports CHECKSUM_CHANGED for 0001', /CHECKSUM_CHANGED/.test(r.out) && /migration 0001/.test(r.out));
  check('the pending 0004 was NOT applied in that run', !tableExists('t_four'));
  check('ledger unchanged (0001 only)', ledgerVersions() === '0001', ledgerVersions());

  // ── E ────────────────────────────────────────────────────────────────────
  section('E. idempotent re-run');
  dir = makeDir('idem', {
    '0001_ok.sql': OK_0001,
    '0004_new.sql': `CREATE TABLE ${OBJ_SCHEMA}.t_four (id int);\n`,
  });
  r = runApply(dir);
  check('first run applies exactly the pending 0004', r.code === 0 && /applied 1 new migration/.test(r.out), r.out.split('\n').find((l) => /applied/.test(l)));
  check('t_four now exists', tableExists('t_four'));
  const afterFirst = ledgerVersions();
  r = runApply(dir);
  check('second run exits 0', r.code === 0);
  check('second run applies 0 new migrations', /applied 0 new migration/.test(r.out));
  check('ledger identical across re-run', ledgerVersions() === afterFirst && afterFirst === '0001,0004', ledgerVersions());

  // ── F ────────────────────────────────────────────────────────────────────
  section('F. transaction control rejected; plpgsql BEGIN/END accepted');
  dir = makeDir('txn', {
    '0001_ok.sql': OK_0001,
    '0004_new.sql': `CREATE TABLE ${OBJ_SCHEMA}.t_four (id int);\n`,
    '0005_commits.sql': `CREATE TABLE ${OBJ_SCHEMA}.t_five (id int);\nCOMMIT;\nCREATE TABLE ${OBJ_SCHEMA}.t_five_b (id int);\n`,
  });
  r = runApply(dir);
  check('file with top-level COMMIT is rejected', r.code !== 0 && /TXN_CONTROL/.test(r.out) && /0005_commits/.test(r.out));
  check('nothing from it ran (t_five absent)', !tableExists('t_five'));

  dir = makeDir('plpgsql', {
    '0001_ok.sql': OK_0001,
    '0004_new.sql': `CREATE TABLE ${OBJ_SCHEMA}.t_four (id int);\n`,
    '0006_function.sql':
      `CREATE FUNCTION ${OBJ_SCHEMA}.f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 1;\nEND;\n$$;\n` +
      `DO $blk$\nBEGIN\n  PERFORM 1;\nEND\n$blk$;\n`,
  });
  r = runApply(dir);
  check('BEGIN/END inside a function body and a DO block is accepted', r.code === 0 && /\+ 0006_function\.sql/.test(r.out), r.out.split('\n').find((l) => /FAILED|ERROR/.test(l)));
} finally {
  reset();
  rmSync(WORK, { recursive: true, force: true });
}

const realLedgerAfter = q(`SELECT count(*) FROM migration_ledger.applied;`);
section('isolation from the real ledger');
check(`real migration_ledger untouched (${realLedgerBefore} -> ${realLedgerAfter})`, realLedgerBefore === realLedgerAfter);
check('test schemas removed', !schemaExists(OBJ_SCHEMA) && !schemaExists(LEDGER_SCHEMA));

console.log(`\n  ══ RUNNER RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
