#!/usr/bin/env node
/**
 * ADR-006 Step 13 — CURRENT-TARGET CLEAN-CUTOVER COMPATIBILITY REGRESSION (CT-1…CT-5). LOCAL ONLY.
 *
 * Authority: ADR006_TEST_MATRIX_V1 §CT; ADR006_IMPLEMENTATION_ORDER_V1 step 13.
 *
 * Phase 26 is COMPLETE and its artefacts are historical, read-only evidence. This harness imports
 * nothing from scripts/phase26/. It only:
 *   - reads the historical Run 1 plan / digest / summary (read-only) and hashes them before and after;
 *   - invokes the historical runner's `load` command UNCHANGED (never `rebuild`, never `validate`),
 *     pointed at a scratch --out directory holding a byte-identical, hash-verified copy of plan.json;
 *   - runs its own validator (scripts/regression/validate-current-target.sql, derived mechanically from
 *     the historical one; see current-target-validator-transform.mjs) and its own zero-write fingerprint.
 *
 *   CT-1  guarded reset + apply.mjs with every current migration; ledger rows = migration files present
 *         (derived at run time) and every ledger sha256 = the file's sha256
 *   CT-2  the historical Run 1 plan.json: sha256 = the recorded plan hash; historical `load` unchanged
 *   CT-3  current-schema business validation: every historical check except C01 (ledger = files) and
 *         C16 extended with the six ADR-006 tables = 0 rows
 *   CT-4  DIGEST lines = the historical Run 1 state-digest.txt, per table
 *   CT-5  idempotent rerun of the historical `load`: zero-write fingerprint pre = post
 *
 * Usage:  TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *           node scripts/regression/clean-cutover-current-target.mjs
 * Env (optional): P26_RUN_DIR — the historical Run directory (default: the recorded PASS run).
 * Leaves the target in the loaded state; the target-db suites start from their own reset.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSafeDestructiveTarget, assertSafeCliOperation, assertNoProductionCredentials } from '../test-env/guard.mjs';
import { deriveCurrentValidator, ADR006_TABLES } from './current-target-validator-transform.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'target-migrations');
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const HIST_RUNNER = join(REPO, 'scripts', 'phase26', 'migrate-clean-cutover.mjs');
const HIST_VALIDATOR = join(REPO, 'scripts', 'phase26', 'validate-clean-cutover.sql');
const HIST_CONFIG = join(REPO, '.planning', 'phase26-evidence', 'MIGRATION_REHEARSAL_CONFIG_V1.json');
const HIST_DOC = join(REPO, '.planning', 'PHASE_26_MIGRATION_REHEARSAL.md');
const RUN_DIR = process.env.P26_RUN_DIR
  || resolve(process.env.USERPROFILE ?? '', 'GranjaSnapshots', 'phase26', 'rehearsal-runs', '20260927T015412Z');
const RUN1 = join(RUN_DIR, 'run1');
const CURRENT_VALIDATOR = join(REPO, 'scripts', 'regression', 'validate-current-target.sql');

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; failures.push(label); console.log(`    MAL  ${label} :: ${detail}`); }
}
const section = (n, t) => console.log(`\n  ── ${n}. ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
function resolveBin(name, candidates) {
  const onPath = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return name;
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`${name} not found`);
}
const DOCKER = resolveBin('docker', [resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe')]);
const SUPABASE = resolveBin('supabase', [
  resolve(process.env.APPDATA ?? '', 'npm', 'node_modules', 'supabase', 'node_modules', '@supabase', 'cli-windows-x64', 'bin', 'supabase.exe'),
  resolve(process.env.APPDATA ?? '', 'npm', 'node_modules', 'supabase', 'bin', 'supabase.exe'),
]);
function targetContainer() {
  const names = (spawnSync(DOCKER, ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean);
  if (names.length !== 1) throw new Error(`expected exactly one supabase_db container, found ${names.length}`);
  return names[0];
}
function psql(sqlText, extra = []) {
  const r = spawnSync(DOCKER, ['exec', '-i', targetContainer(), 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', ...extra, '-f', '-'],
    { encoding: 'utf8', input: sqlText, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed:\n${r.stderr}`);
  return (r.stdout || '').trim();
}

// ── read-only historical evidence (hashed before and after) ──────────────────
const PROTECTED = [HIST_RUNNER, HIST_VALIDATOR, HIST_CONFIG, HIST_DOC, join(RUN_DIR, 'rehearsal-summary.json'),
  ...['plan.json', 'plan.json.sha256', 'state-digest.txt', 'state-digest.sha256', 'validation.txt'].map((f) => join(RUN1, f))];
const hashAll = () => Object.fromEntries(PROTECTED.map((f) => [f, existsSync(f) ? sha256(readFileSync(f)) : 'MISSING']));

// zero-write fingerprint (Phase 26 procedure, re-implemented here): every row of every ordinary table in
// public, auth, migration_ledger and phase26_migration hashed WITH its xmin — any write changes a line.
const FINGERPRINT_SQL = `SELECT 'WRITE|' || n || '|' || h FROM (
  SELECT format('%I.%I', ns.nspname, c.relname) AS n,
         (xpath('/row/h/text()', query_to_xml(format(
           'select count(*) || ''|'' || md5(coalesce(string_agg(t.xmin::text || '':'' || t::text, E''\\n'' order by t::text), '''')) as h from %I.%I t',
           ns.nspname, c.relname), false, true, '')))[1]::text AS h
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname IN ('public', 'auth', 'migration_ledger', 'phase26_migration') AND c.relkind = 'r') x ORDER BY n;`;
const fingerprint = () => { const lines = psql(FINGERPRINT_SQL).split('\n').filter((l) => l.startsWith('WRITE|')); return { lines, sha: sha256(lines.join('\n')) }; };

function runHistoricalLoad(outDir) {
  const args = [HIST_RUNNER, 'load', '--config', HIST_CONFIG, '--mode', 'rehearsal', '--out', outDir];
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function runValidator(expectedMigrations) {
  const out = psql(readFileSync(CURRENT_VALIDATOR, 'utf8'), ['-F', '|', '-v', `expected_migrations=${expectedMigrations}`]);
  const lines = out.split('\n');
  return {
    checks: lines.filter((l) => l.startsWith('CHECK|')).map((l) => { const [, id, st, ...d] = l.split('|'); return { id, st, detail: d.join('|') }; }),
    digest: lines.filter((l) => l.startsWith('DIGEST|')).sort(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const before = hashAll();
check('P26-0 the historical Phase 26 artefacts are present (runner, validator, config, Run 1 plan / digest / validation, PASS summary)',
  Object.values(before).every((h) => h !== 'MISSING'), Object.entries(before).filter(([, h]) => h === 'MISSING').map(([f]) => f).join(', '));
const summary = JSON.parse(readFileSync(join(RUN_DIR, 'rehearsal-summary.json'), 'utf8').replace(/^﻿/, ''));
check('P26-1 the historical run is the recorded PASS (result PASS, Run 1 digest = rerun = Run 2 digest, rerun wrote 0 rows)',
  summary.result === 'PASS' && summary.digest_run1 === summary.digest_rerun && summary.digest_run1 === summary.digest_run2 && summary.rerun_rows_written === 0,
  JSON.stringify(summary));

section('CT-1', 'fresh current target');
const files = readdirSync(MIGRATIONS_DIR).filter((f) => FILE_PATTERN.test(f)).sort();
{
  const args = ['db', 'reset'];
  assertSafeCliOperation(args);
  const r = spawnSync(SUPABASE, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 || /linked project|remote database/i.test(out)) throw new Error(`guarded reset failed\n${out.slice(-1500)}`);
  const a = spawnSync(process.execPath, [join(REPO, 'scripts', 'target-db', 'apply.mjs')], { cwd: REPO, encoding: 'utf8', env: process.env });
  check('CT-1a guarded `supabase db reset` + apply.mjs succeeded', a.status === 0, `${a.stdout}\n${a.stderr}`.slice(-800));
  const ledger = psql(`SELECT version || '|' || filename || '|' || sha256 FROM migration_ledger.applied ORDER BY version;`).split('\n').filter(Boolean);
  const expected = files.map((f) => `${f.match(FILE_PATTERN)[1]}|${f}|${sha256(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))}`);
  console.log(`      migration files present: ${files.length} (${files[0]} … ${files[files.length - 1]}); ledger rows: ${ledger.length}`);
  check('CT-1b ledger rows = migration files present (derived at run time, not hard-coded)', ledger.length === files.length && files.length > 0, `${ledger.length} vs ${files.length}`);
  check('CT-1c the ledger records every file with its exact version, filename and sha256 (immutable history intact)', ledger.join('\n') === expected.join('\n'),
    ledger.filter((l, i) => l !== expected[i]).slice(0, 3).join(' | '));
}

section('CT-2', 'historical clean-cutover plan (read-only) + historical load');
const work = mkdtempSync(join(tmpdir(), 'ct-current-target-'));
try {
  const planText = readFileSync(join(RUN1, 'plan.json'));
  const recorded = readFileSync(join(RUN1, 'plan.json.sha256'), 'utf8').split(/\s+/)[0];
  const actual = sha256(planText);
  console.log(`      historical source: Run 1 plan.json read-only (${RUN1}); recorded hash ${summary.plan_sha256}; actual ${actual}`);
  check('CT-2a the historical Run 1 plan.json sha256 = the recorded plan hash (plan.json.sha256 and the PASS summary)', actual === recorded && actual === summary.plan_sha256,
    `${actual} / ${recorded} / ${summary.plan_sha256}`);
  const plan = JSON.parse(planText.toString('utf8'));
  check('CT-2b the plan was built from the historical config, byte-identical today', plan.config_sha256 === sha256(readFileSync(HIST_CONFIG, 'utf8')));
  copyFileSync(join(RUN1, 'plan.json'), join(work, 'plan.json'));
  copyFileSync(join(RUN1, 'plan.json.sha256'), join(work, 'plan.json.sha256'));
  check('CT-2c the scratch --out copy is byte-identical to the historical plan (the historical run directory is never an --out target)',
    sha256(readFileSync(join(work, 'plan.json'))) === actual && readFileSync(join(work, 'plan.json.sha256'), 'utf8') === readFileSync(join(RUN1, 'plan.json.sha256'), 'utf8'));
  const load = runHistoricalLoad(work);
  check('CT-2d the historical runner\'s `load` command, invoked unchanged, loads the plan into the current target (never `rebuild` / `validate`)',
    load.ok && /load: population events written/.test(load.out), load.out.slice(-1500));
  const loadLog = load.out.split('\n').filter((l) => l.startsWith('[phase26]')).join(' / ');
  console.log(`      ${loadLog}`);

  section('CT-3', 'current-schema business validation');
  check('CT-3a validate-current-target.sql = the historical validator with exactly the C01 / C16 substitutions and the ADR-016 seed exclusion (every other check and the DIGEST query verbatim)',
    readFileSync(CURRENT_VALIDATOR, 'utf8').replace(/\r\n/g, '\n') === deriveCurrentValidator(readFileSync(HIST_VALIDATOR, 'utf8')));
  const v = runValidator(files.length);
  const histChecks = readFileSync(join(RUN1, 'validation.txt'), 'utf8').split(/\r?\n/).filter((l) => l.startsWith('CHECK|')).map((l) => l.split('|')[1]);
  const failed = v.checks.filter((c) => c.st !== 'PASS');
  console.log(`      checks: ${v.checks.length} (historical Run 1: ${histChecks.length}); failed: ${failed.length}`);
  check('CT-3b every check passes (C01–C24)', v.checks.length > 0 && failed.length === 0, failed.map((c) => `${c.id}: ${c.detail}`).join(' | '));
  check('CT-3c the check set equals the historical Run 1 check set (same ids; C01 re-based, C16 extended)',
    JSON.stringify(v.checks.map((c) => c.id).sort()) === JSON.stringify([...histChecks].sort()), `${v.checks.map((c) => c.id)} vs ${histChecks}`);
  const c01 = v.checks.find((c) => c.id === 'C01_migrations_applied');
  const c16 = v.checks.find((c) => c.id === 'C16_no_history_loaded');
  console.log(`      current C01: ${c01?.detail}; C16: ${c16?.detail}`);
  check('CT-3d current C01: ledger = migration files present', c01?.st === 'PASS' && c01.detail === `ledger=${files.length} migration_files=${files.length}`, c01?.detail);
  check('CT-3e C16: the clean cutover leaves the six ADR-006 tables empty (and every historical fact table, MP ADR-003 included, as in Phase 26)',
    c16?.st === 'PASS' && ADR006_TABLES.every((t) => c16.detail.includes(`${t}=0`)), c16?.detail);

  section('CT-4', 'business-state equality with the historical Run 1 digest');
  const hist = readFileSync(join(RUN1, 'state-digest.txt'), 'utf8').split(/\r?\n/).filter((l) => l.startsWith('DIGEST|')).sort();
  const byTable = (lines) => Object.fromEntries(lines.map((l) => { const [, t, md5, n] = l.split('|'); return [t, `${md5}|${n}`]; }));
  const H = byTable(hist);
  const C = byTable(v.digest);
  const tables = [...new Set([...Object.keys(H), ...Object.keys(C)])].sort();
  const diffs = tables.filter((t) => H[t] !== C[t]).map((t) => `${t}: historical ${H[t] ?? '-'} current ${C[t] ?? '-'}`);
  console.log(`      historical digest tables: ${Object.keys(H).length}; current: ${Object.keys(C).length}; differences: ${diffs.length}`);
  check('CT-4a DIGEST lines equal the historical Run 1 state-digest.txt per table (same table set, md5 and row count)', hist.length > 0 && diffs.length === 0, diffs.join(' | '));
  check('CT-4b the digest sha256 equals the recorded Run 1 state digest', sha256(v.digest.join('\n')) === readFileSync(join(RUN1, 'state-digest.sha256'), 'utf8').trim()
    && sha256(v.digest.join('\n')) === summary.digest_run1, sha256(v.digest.join('\n')));

  section('CT-5', 'idempotent rerun: zero writes');
  const pre = fingerprint();
  const rerun = runHistoricalLoad(work);
  const post = fingerprint();
  console.log(`      fingerprint pre ${pre.sha} (${pre.lines.length} tables); post ${post.sha}`);
  check('CT-5a the historical `load` rerun succeeds and writes no population event (all already present)', rerun.ok && /population events written 0,/.test(rerun.out), rerun.out.slice(-800));
  check('CT-5b zero-write fingerprint (every row with its xmin, public / auth / migration_ledger / phase26_migration): pre = post',
    pre.lines.length > 0 && pre.sha === post.sha && pre.lines.some((l) => l.startsWith('WRITE|phase26_migration.run_log|')),
    pre.lines.filter((l, i) => l !== post.lines[i]).slice(0, 3).join(' | '));
  const v2 = runValidator(files.length);
  check('CT-5c after the rerun the validation still passes and the digest is unchanged', v2.checks.every((c) => c.st === 'PASS') && v2.digest.join('\n') === v.digest.join('\n'));
} finally {
  rmSync(work, { recursive: true, force: true });
}

section('P26', 'historical artefacts untouched');
const after = hashAll();
check('P26-2 no historical Phase 26 artefact changed (runner, validator, config, Phase 26 document, Run 1 plan / digest / validation, PASS summary)',
  Object.keys(before).every((f) => before[f] === after[f]), Object.keys(before).filter((f) => before[f] !== after[f]).join(', '));
check('P26-3 this harness wrote nothing under the historical run directory (only the scratch --out directory was used)',
  readdirSync(RUN1).sort().join(',') === 'plan.json,plan.json.sha256,state-digest.sha256,state-digest.txt,validation.txt');

console.log(`\n  ══ CLEAN-CUTOVER CURRENT TARGET (CT-1…CT-5) RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail) console.log(failures.map((f) => `   - ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
