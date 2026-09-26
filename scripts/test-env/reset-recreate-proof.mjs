#!/usr/bin/env node
/**
 * Phase 12 reset / recreate proof — LOCAL TEST STACK ONLY.
 *
 * Proves the test environment is genuinely disposable: it can be destroyed and
 * rebuilt to a known state, twice, without touching production.
 *
 * `supabase db reset` is CLI-mediated, so locality is proven by inspecting argv
 * (assertLocalOnlyCliArgs) rather than by a connection string: argv is what selects
 * local versus remote for the CLI. A marker fixture proves the destruction was real.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/test-env/reset-recreate-proof.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDestructiveTarget, assertSafeCliOperation } from './guard.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKER = 'public._phase12_reset_marker';
const RESET_ARGS = ['db', 'reset'];

function resolveDockerDir() {
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return null;
  const candidate = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin');
  return existsSync(candidate) ? candidate : null;
}

const dockerDir = resolveDockerDir();
const DOCKER = dockerDir ? resolve(dockerDir, 'docker.exe') : 'docker';
const CHILD_PATH = dockerDir ? `${process.env.PATH}${process.platform === 'win32' ? ';' : ':'}${dockerDir}` : process.env.PATH;

/**
 * Resolve the real Supabase CLI executable.
 *
 * The npm global install exposes `supabase` as a shell shim plus a .cmd wrapper.
 * Node cannot spawn either without `shell: true`, and shell mode concatenates
 * arguments instead of passing them as an array — which would defeat the point of
 * assertLocalOnlyCliArgs, since the guard proves the exact argv. So the real .exe is
 * located and spawned directly, keeping argv intact.
 */
function resolveSupabaseBin() {
  if (process.env.SUPABASE_BIN && existsSync(process.env.SUPABASE_BIN)) return process.env.SUPABASE_BIN;
  const onPath = spawnSync('supabase', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'supabase';
  const appdata = process.env.APPDATA ?? '';
  const candidates = [
    resolve(appdata, 'npm', 'node_modules', 'supabase', 'node_modules', '@supabase', 'cli-windows-x64', 'bin', 'supabase.exe'),
    resolve(appdata, 'npm', 'node_modules', 'supabase', 'bin', 'supabase.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

const SUPABASE = resolveSupabaseBin();

let step = 0;
function heading(text) {
  step += 1;
  console.log(`\n── ${step}. ${text} ${'─'.repeat(Math.max(0, 54 - text.length))}`);
}

function fail(message, detail) {
  console.error(`\n  PROOF FAILED: ${message}`);
  if (detail) console.error(`  ${detail}`);
  process.exit(1);
}

function docker(args) {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) fail('could not run docker', r.error.message);
  return r;
}

function containerName() {
  const out = docker(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '';
  const name = out.trim().split('\n').filter(Boolean)[0];
  if (!name) fail('no running supabase_db container', 'Run `supabase start` first.');
  return name;
}

function sql(statement, { expectOk = true } = {}) {
  const r = docker([
    'exec', '-i', containerName(),
    'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    '-c', statement,
  ]);
  if (expectOk && r.status !== 0) fail(`SQL failed: ${statement}`, (r.stderr || '').trim());
  return (r.stdout || '').trim();
}

/** The known baseline the environment must return to after a reset. */
function readBaseline() {
  return {
    publicTables: sql(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public';`),
    authSchemas: sql(`SELECT count(*) FROM information_schema.schemata WHERE schema_name IN ('auth','storage');`),
    supabaseRoles: sql(`SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role');`),
    serverVersion: sql(`SHOW server_version;`),
  };
}

function printBaseline(label, b) {
  console.log(`  ${label}: public tables=${b.publicTables} auth+storage schemas=${b.authSchemas} supabase roles=${b.supabaseRoles} pg=${b.serverVersion}`);
}

function verifyEndpoint(target) {
  const mapping = (docker(['port', containerName(), '5432/tcp']).stdout || '').trim();
  if (!mapping.includes(`:${target.port}`)) {
    fail('port mapping no longer matches the guarded target', `mapping="${mapping}"`);
  }
  console.log(`  endpoint still ${target.host}:${target.port} (mapping: ${mapping.split('\n')[0]})`);
}

function runReset(cycle) {
  assertSafeCliOperation(RESET_ARGS);
  if (!SUPABASE) fail('could not locate the supabase CLI executable');
  const r = spawnSync(SUPABASE, RESET_ARGS, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: CHILD_PATH },
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error) fail(`could not run the supabase CLI on cycle ${cycle}`, r.error.message);
  if (r.status !== 0) {
    fail(
      `supabase db reset failed on cycle ${cycle} (exit ${r.status})`,
      out.trim() ? out.split('\n').slice(0, 10).join('\n  ') : '(no output captured)'
    );
  }
  out
    .split('\n')
    .filter((l) => l.trim() && !l.includes('A new version') && !l.includes('We recommend'))
    .slice(0, 6)
    .forEach((l) => console.log(`    ${l.trim()}`));
  // The reset must not have reported acting on a remote project.
  if (/linked project|remote database/i.test(out)) {
    fail('the reset output mentions a remote project', out.slice(0, 400));
  }
}

// ── Guard, twice: the URL for direct SQL, the argv for the CLI command ──────
heading('Guard the target and the command');
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
assertSafeCliOperation(RESET_ARGS);
console.log(`  container: ${containerName()}`);

heading('Clear any marker left by an earlier interrupted run');
sql(`DROP TABLE IF EXISTS ${MARKER};`);
console.log('  marker dropped if it existed, so the baseline is measured clean');

heading('Record the baseline before any reset');
const baseline = readBaseline();
printBaseline('baseline', baseline);
verifyEndpoint(target);

// ── Two full cycles, to show this is repeatable and not a one-off ───────────
for (const cycle of [1, 2]) {
  heading(`Cycle ${cycle}: create the marker`);
  sql(`DROP TABLE IF EXISTS ${MARKER};`);
  sql(`CREATE TABLE ${MARKER} (id integer PRIMARY KEY, created_at timestamptz DEFAULT now());`);
  sql(`INSERT INTO ${MARKER} (id) VALUES (1), (2), (3);`);
  const markerRows = sql(`SELECT count(*) FROM ${MARKER};`);
  const markerExists = sql(
    `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='_phase12_reset_marker';`
  );
  console.log(`  marker table present=${markerExists} rows=${markerRows}`);
  if (markerExists !== '1' || markerRows !== '3') fail('the marker was not created, so the reset would prove nothing');

  heading(`Cycle ${cycle}: destroy and recreate (supabase db reset)`);
  runReset(cycle);

  heading(`Cycle ${cycle}: verify the destruction was real`);
  const stillThere = sql(
    `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='_phase12_reset_marker';`
  );
  console.log(`  marker table after reset: ${stillThere} (expected 0)`);
  if (stillThere !== '0') fail('the marker survived the reset — the environment is not disposable');

  heading(`Cycle ${cycle}: verify the known state came back`);
  const after = readBaseline();
  printBaseline('after reset', after);
  const drift = Object.keys(baseline).filter((k) => baseline[k] !== after[k]);
  if (drift.length > 0) {
    fail(`the environment did not return to the known baseline: ${drift.join(', ')}`);
  }
  console.log('  baseline matches on every dimension: public tables, auth/storage schemas, supabase roles, server version');
  verifyEndpoint(target);
}

heading('Confirm no remote project was involved');
const linkFile = resolve(REPO_ROOT, 'supabase', '.temp', 'project-ref');
console.log(`  supabase/.temp/project-ref still present and untouched: ${existsSync(linkFile)}`);
console.log('  every reset ran as `supabase db reset` with no --linked / --db-url / --project-ref');

console.log('\n  RESET / RECREATE PROOF: PASS (2 cycles)\n');
