#!/usr/bin/env node
/**
 * ADR-006 Step 11 — scheduler gate (0056): pg_cron → pg_net → mp-worker, Vault-sourced invoke secret,
 * S-8 and F-3f on the real local path.
 *
 * Run (local stack up; target DB at 0001–0056):
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/mp_scheduler.test.mjs
 *
 * - The worker runs under `supabase functions serve` with FAKE secrets; Mercado Pago is a local mock HTTP
 *   server reached through MP_API_BASE_URL=http://host.docker.internal:<port>. api.mercadopago.com is never
 *   contacted.
 * - Cron is proven by a harness-only job (`mp_worker_s11_harness`, every 2 seconds) whose command is copied
 *   verbatim from the Step-11 job, so the exact production statement is what fires. The Step-11 job itself
 *   is never altered. Attribution: the harness makes no HTTP call to the worker during the cron window,
 *   cron.job_run_details must show the harness job and no Step-11 run in that window, and pg_net must hold
 *   the worker's responses. The harness job and the Vault entries are removed in `finally`.
 * - "The next permitted hourly probe" is reached by restarting `functions serve` (a fresh worker instance:
 *   the probe rate limit is per-instance memory by design, WEBHOOK_WORKER_DESIGN §5). The one-hour
 *   arithmetic itself is proven with an injected clock in mp_worker.test.mjs (F-3d / F-3f).
 * Synthetic ids only: payments 7779….
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSafeDestructiveTarget, assertSafeCliOperation, assertNoProductionCredentials } from '../test-env/guard.mjs';
import { configureScheduler, clearScheduler, VAULT_URL_NAME, VAULT_SECRET_NAME } from './mp_scheduler_config.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const MIGRATION = join(REPO, 'supabase', 'target-migrations', '0056_mp_worker_scheduler.sql');
const SECRET = `s11-fake-invoke-secret-${Date.now()}`;
const TOKEN = 'APP-TEST-FAKE-TOKEN-not-real-s11';
const COLLECTOR = '100000001';
const WORKER_URL_HOST = 'http://127.0.0.1:54321/functions/v1/mp-worker';
const WORKER_URL_DB = 'http://host.docker.internal:54321/functions/v1/mp-worker';
const JOB = 'mp_worker_every_minute';
const HARNESS_JOB = 'mp_worker_s11_harness';
const REQUEUE_REASON = 'auto: credential probe succeeded';
let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; failures.push(label); console.log(`    MAL  ${label} :: ${detail}`); }
}
const section = (n, t) => console.log(`\n  ── ${n}. ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const container = (spawnSync(DOCKER, ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean)[0];
function raw(s) {
  const r = spawnSync(DOCKER, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { encoding: 'utf8', input: s });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function owner(s) { const r = raw(s); if (!r.ok) throw new Error(`owner SQL failed:\n${s}\n${r.err}`); return r.out; }
const esc = (s) => String(s).replace(/'/g, "''");
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(v)}'`);
const svc = (s) => owner(`BEGIN;\nSET LOCAL ROLE service_role;\nSET LOCAL "request.jwt.claims" = '{"role":"service_role"}';\n${s}\nCOMMIT;`);
const asRole = (role, claims, s) => raw(`BEGIN;\nSET LOCAL ROLE ${role};\nSET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';\n${s}\nROLLBACK;`);

// ── mock Mercado Pago (per-payment behaviour) ───────────────────────────────
const mode = new Map();   // pid → 'ok' | 'broken'
const hits = new Map();   // pid → GET count
const auths = new Set();
function payload(pid) {
  const at = '2026-11-05T10:00:00.000-04:00';
  return { id: Number(pid), operation_type: 'money_transfer', status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true,
    collector_id: Number(COLLECTOR), payer: { id: '800000999' }, external_reference: null, date_created: at, date_approved: at, transaction_amount: 100,
    transaction_details: { net_received_amount: 93 }, fee_details: [{ type: 'mercadopago_fee', amount: 5, fee_payer: 'collector' }],
    refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
}
const server = createServer((req, res) => {
  const m = /^\/v1\/payments\/(\d+)$/.exec(req.url ?? '');
  if (req.method === 'GET' && m && mode.has(m[1])) {
    hits.set(m[1], (hits.get(m[1]) ?? 0) + 1);
    auths.add(req.headers.authorization ?? '');
    const broken = mode.get(m[1]) === 'broken';
    res.writeHead(broken ? 401 : 200, { 'content-type': 'application/json' });
    res.end(broken ? '{"message":"unauthorized"}' : JSON.stringify(payload(m[1])));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"message":"not found"}');
});

// ── fixtures / cleanup ───────────────────────────────────────────────────────
function cleanup() {
  owner(`
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:7779%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op  AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '7779%';
DELETE FROM audit_events WHERE (entity_type = 'mp_source_record' AND entity_id IN (SELECT id::TEXT FROM _src))
   OR (entity_type = 'mp_financial_movement' AND entity_id IN (SELECT id::TEXT FROM _mv))
   OR (entity_type = 'mp_webhook_delivery' AND entity_id IN (SELECT id::TEXT FROM _dl));
DELETE FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);`);
}
const unscheduleHarness = () => raw(`SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ${q(HARNESS_JOB)};`);
let seq = 0;
const newPid = () => `7779${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;
const register = (pid) => JSON.parse(svc(`SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, NULL, 'S11', ${q(JSON.stringify({ notification_id: `s11-${pid}-${++seq}` }))}::jsonb, true)::text;`)).delivery_id;
const dStatus = (d) => owner(`SELECT status || '|' || attempts FROM mp_webhook_delivery WHERE id = ${q(d)};`).split('|');
const econ = (pid) => owner(`SELECT concat_ws('|', (SELECT count(*) FROM mp_source_record WHERE external_id LIKE 'MPPAY:${pid}:%'),
  (SELECT count(*) FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${pid}:%'),
  (SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${pid}:%'),
  (SELECT count(*) FROM financial_posting p JOIN mp_reconciliation r ON r.financial_operation_id = p.financial_operation_id JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id
     JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${pid}:%'),
  (SELECT count(*) FROM mp_client_allocation a JOIN mp_financial_movement m ON m.id = a.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${pid}:%'));`);
const dbFingerprint = () => owner(`SELECT md5(string_agg(x, '|')) FROM (
  SELECT (SELECT count(*) || ':' || coalesce(sum(attempts), 0) || ':' || coalesce(max(updated_at)::text, '-') FROM mp_webhook_delivery) AS x
  UNION ALL SELECT (SELECT count(*)::text FROM mp_source_record) UNION ALL SELECT (SELECT count(*)::text FROM mp_financial_movement)
  UNION ALL SELECT (SELECT count(*)::text FROM mp_reconciliation) UNION ALL SELECT (SELECT count(*)::text FROM financial_operation)
  UNION ALL SELECT (SELECT count(*)::text FROM financial_posting) UNION ALL SELECT (SELECT count(*)::text FROM client_ledger)
  UNION ALL SELECT (SELECT count(*)::text FROM audit_events)) f;`);
async function waitFor(fn, ms, step = 500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; }

async function startServe(envPath) {
  const args = ['functions', 'serve', '--no-verify-jwt', '--env-file', envPath];
  assertSafeCliOperation(args);
  const child = spawn(SUPABASE, args, { cwd: REPO, env: { ...process.env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // infrastructure readiness only (no contract assertion): the edge runtime can drop the first connections
  // while it settles, so require three consecutive 405 answers to a GET, about a second apart
  const t0 = Date.now();
  let stable = 0;
  while (Date.now() - t0 < 180000) {
    if (!out.includes('Serving functions on')) { await sleep(500); continue; }
    try {
      const r = await fetch(WORKER_URL_HOST, { method: 'GET' });
      await r.text();
      stable = r.status === 405 ? stable + 1 : 0;
      if (stable >= 3) return { child, output: () => out };
    } catch { stable = 0; }
    await sleep(1000);
  }
  child.kill();
  throw new Error(`functions serve did not become ready\n${out.slice(-1500)}`);
}
const stopServe = async (s) => { s.child.kill(); await sleep(4000); };

// ═════════════════════════════════════════════════════════════════════════════
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
if (!container) { console.error('  no running supabase_db container'); process.exit(1); }
unscheduleHarness();
clearScheduler();
cleanup();

section('E', 'extensions and the Step-11 job');
const prodJob = JSON.parse(owner(`SELECT coalesce(json_agg(j), '[]')::text FROM (SELECT jobid, jobname, schedule, command, username, database, active FROM cron.job WHERE jobname = ${q(JOB)}) j;`));
const allJobs = owner(`SELECT count(*) FROM cron.job;`);
check('E-1 pg_cron, pg_net and supabase_vault are installed; cron runs in database postgres',
  owner(`SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension WHERE extname IN ('pg_cron','pg_net','supabase_vault');`) === 'pg_cron,pg_net,supabase_vault'
    && owner(`SELECT current_setting('cron.database_name');`) === 'postgres');
check('E-2 exactly one scheduler job exists: mp_worker_every_minute, active, owned by postgres in database postgres', prodJob.length === 1 && allJobs === '1'
  && prodJob[0].active === true && prodJob[0].username === 'postgres' && prodJob[0].database === 'postgres', `${allJobs} ${JSON.stringify(prodJob)}`);
const cmd = prodJob[0]?.command ?? '';
check('E-3 cadence is exactly once per minute (\'* * * * *\')', prodJob[0]?.schedule === '* * * * *');
check('E-4 the command is a single pg_net POST to the Vault-named worker URL with the x-worker-invoke-secret header from Vault',
  (cmd.match(/net\.http_post\(/g) ?? []).length === 1 && /x-worker-invoke-secret/.test(cmd) && /vault\.decrypted_secrets/.test(cmd)
    && cmd.includes(`'${VAULT_URL_NAME}'`) && cmd.includes(`'${VAULT_SECRET_NAME}'`) && !/http_get/.test(cmd), cmd);
check('E-5 the command holds no literal secret, no URL, no bearer / Authorization / MP token and calls no RPC',
  !/https?:\/\//i.test(cmd) && !/bearer|authorization|MP_ACCESS_TOKEN|APP_USR|service_role/i.test(cmd) && !/\bmp_[a-z_]+\s*\(/i.test(cmd) && !/\bpublic\./.test(cmd), cmd);
const sqlFile = readFileSync(MIGRATION, 'utf8');
owner(sqlFile);   // re-run the whole migration file (extensions IF NOT EXISTS; cron.schedule upserts by name)
const after = JSON.parse(owner(`SELECT coalesce(json_agg(j), '[]')::text FROM (SELECT jobid, schedule, command FROM cron.job WHERE jobname = ${q(JOB)}) j;`));
check('E-6 idempotent: re-running 0056 keeps exactly one job, same jobid, same schedule and command', after.length === 1 && after[0].jobid === prodJob[0].jobid
  && after[0].command === cmd && owner('SELECT count(*) FROM cron.job;') === '1', JSON.stringify(after));
const queued = () => owner(`SELECT (SELECT count(*) FROM net.http_request_queue) + (SELECT count(*) FROM net._http_response);`);
const q0 = queued();
const noVault = raw(`${cmd}`);
check('E-7 fail closed: with no Vault entries the job statement selects no row and queues no HTTP request', noVault.ok && noVault.out === '' && queued() === q0, `${noVault.out} ${q0}→${queued()}`);

// ═════════════════════════════════════════════════════════════════════════════
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const PORT = server.address().port;
const dir = mkdtempSync(join(tmpdir(), 'mps11-'));
const envPath = join(dir, 'functions.env');
writeFileSync(envPath, [`WORKER_INVOKE_SECRET=${SECRET}`, `MP_ACCESS_TOKEN=${TOKEN}`, `MP_COLLECTOR_ID=${COLLECTOR}`,
  `MP_API_BASE_URL=http://host.docker.internal:${PORT}`, 'MP_WEBHOOK_SECRET=mp-webhook-local-test-secret-not-real', ''].join('\n'));
let serve = await startServe(envPath);
try {
  section('S-8', 'worker invoke authentication (real HTTP)');
  {
    const post = (headers) => fetch(WORKER_URL_HOST, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    const f0 = dbFingerprint();
    let r = await post({});
    await r.text();
    check('S-8a no x-worker-invoke-secret → 401; Δ database = 0', r.status === 401 && dbFingerprint() === f0, String(r.status));
    r = await post({ 'x-worker-invoke-secret': 'wrong-secret' });
    await r.text();
    check('S-8b wrong secret → 401; Δ database = 0', r.status === 401 && dbFingerprint() === f0, String(r.status));
    r = await post({ 'x-worker-invoke-secret': SECRET });
    const body = await r.json();
    check('S-8c correct secret → 200 with the run summary; nothing due → no claim, Δ database = 0 (only contracted work)', r.status === 200
      && body.claimed === 0 && body.stopped === 'completed' && dbFingerprint() === f0, JSON.stringify(body));
  }

  section('V', 'Vault configuration');
  configureScheduler({ url: WORKER_URL_DB, secret: SECRET });
  check('V-1 both Vault entries exist, encrypted at rest (ciphertext ≠ value), and decrypt to the configured values',
    owner(`SELECT count(*) FROM vault.secrets WHERE name IN (${q(VAULT_URL_NAME)}, ${q(VAULT_SECRET_NAME)});`) === '2'
      && owner(`SELECT bool_and(secret <> decrypted_secret) FROM vault.decrypted_secrets WHERE name IN (${q(VAULT_URL_NAME)}, ${q(VAULT_SECRET_NAME)});`) === 't'
      && owner(`SELECT (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ${q(VAULT_SECRET_NAME)}) = ${q(SECRET)}
                   AND (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ${q(VAULT_URL_NAME)}) = ${q(WORKER_URL_DB)};`) === 't');
  const tracked = spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const leaking = tracked.filter((f) => /\.(sql|mjs|ts|toml|md|json)$/.test(f) && existsSync(join(REPO, f))
    && /vault\.create_secret\(\s*'[^']*[A-Za-z0-9]{24,}/.test(readFileSync(join(REPO, f), 'utf8')));
  check('V-2 no secret is versioned: no migration contains a secret or a create_secret literal; no tracked file writes a literal into Vault',
    !sqlFile.includes(SECRET) && !/create_secret|update_secret/.test(sqlFile) && leaking.length === 0, leaking.join());
  configureScheduler({ url: WORKER_URL_DB, secret: SECRET });
  check('V-3 re-configuring updates in place (still exactly one entry per name)',
    owner(`SELECT count(*) FROM vault.secrets WHERE name IN (${q(VAULT_URL_NAME)}, ${q(VAULT_SECRET_NAME)});`) === '2');

  section('C', 'cron → pg_net → mp-worker (real)');
  {
    // start inside a minute so the Step-11 job (fires at second 0) cannot run inside the window
    await waitFor(() => { const s = new Date().getUTCSeconds(); return s >= 2 && s <= 12; }, 70000, 250);
    const windowStart = owner('SELECT clock_timestamp();');
    const A = newPid();
    mode.set(A, 'ok');
    const dA = register(A);
    const f0 = hits.get(A) ?? 0;
    owner(`SELECT cron.schedule(${q(HARNESS_JOB)}, '2 seconds', ${q(cmd)});`);
    const harnessId = owner(`SELECT jobid FROM cron.job WHERE jobname = ${q(HARNESS_JOB)};`);
    const fetched = await waitFor(() => dStatus(dA)[0] === 'FETCHED', 40000);
    const windowEnd = owner('SELECT clock_timestamp();');
    const harnessRuns = owner(`SELECT count(*) FILTER (WHERE status = 'succeeded') || '|' || count(*) FROM cron.job_run_details WHERE jobid = ${harnessId} AND start_time >= ${q(windowStart)};`).split('|');
    const prodRuns = owner(`SELECT count(*) FROM cron.job_run_details WHERE jobid = ${prodJob[0].jobid} AND start_time >= ${q(windowStart)} AND start_time <= ${q(windowEnd)};`);
    const responses = JSON.parse(owner(`SELECT coalesce(json_agg(json_build_object('status', status_code, 'content', content)), '[]')::text
      FROM net._http_response WHERE created >= ${q(windowStart)};`));
    const workerSummaries = responses.filter((x) => x.status === 200 && /"claimed"/.test(x.content ?? ''));
    check('C-1 a real pg_cron job (the Step-11 command, harness schedule) fired and pg_net POSTed to mp-worker: runs succeeded; pg_net holds 200 worker summaries',
      fetched && Number(harnessRuns[0]) >= 1 && workerSummaries.length >= 1 && workerSummaries.some((x) => JSON.parse(x.content).fetched >= 1),
      `fetched=${fetched} runs=${harnessRuns} responses=${responses.length}`);
    check('C-2 attribution: the fixture delivery went RECEIVED → FETCHED with the harness making no worker call; no Step-11 job run fell inside the window; MP mock saw the worker (Bearer <fake token>)',
      prodRuns === '0' && (hits.get(A) ?? 0) === f0 + 1 && econ(A) === '1|1|3|3|0' && [...auths].every((a) => a === `Bearer ${TOKEN}`), `prodRuns=${prodRuns} hits=${hits.get(A)} econ=${econ(A)}`);
    check('C-3 the invocation carried the Vault secret: an unauthenticated call would have been 401, and no pg_net response in the window is 401',
      responses.every((x) => x.status !== 401), JSON.stringify(responses.map((x) => x.status)));
  }

  section('F-3f', 'CONFIG_BLOCKED + hourly probe through the scheduler');
  {
    const B = newPid();
    mode.set(B, 'broken');
    const dB = register(B);
    const blocked = await waitFor(() => dStatus(dB)[0] === 'CONFIG_BLOCKED', 30000);
    const attemptsBlocked = dStatus(dB)[1];
    const econBlocked = econ(B);
    await sleep(16000);   // ≈ 8 further scheduler runs with the credential still broken
    const hitsBroken = hits.get(B) ?? 0;
    const runsBroken = owner(`SELECT count(*) FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = ${q(HARNESS_JOB)}) AND start_time > NOW() - INTERVAL '16 seconds';`);
    check('F-3f(a) 401 → CONFIG_BLOCKED; across ≈ 8 more scheduler runs no hot retry: the row is never claimed again (attempts unchanged), MP GETs = the first fetch + at most one probe; no financial row',
      blocked && dStatus(dB)[0] === 'CONFIG_BLOCKED' && dStatus(dB)[1] === attemptsBlocked && hitsBroken >= 1 && hitsBroken <= 2 && Number(runsBroken) >= 5
        && econBlocked === '0|0|0|0|0' && econ(B) === '0|0|0|0|0', `hits=${hitsBroken} runs=${runsBroken} econ=${econ(B)}`);
    mode.set(B, 'ok');   // credential fixed at the mock; no explicit requeue
    await sleep(10000);
    const hitsSameHour = hits.get(B) ?? 0;
    const auditBefore = Number(owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE';`));
    check('F-3f(b) same worker instance, same hour: further runs make no additional probe (≤ 1 per hour) even after the credential is fixed; still CONFIG_BLOCKED',
      hitsSameHour === hitsBroken && hitsBroken === 2 && dStatus(dB)[0] === 'CONFIG_BLOCKED', `hits ${hitsBroken}→${hitsSameHour} status=${dStatus(dB)[0]}`);
    // the next permitted probe: a fresh worker instance (per-instance rate-limit memory; the hour itself is proven in mp_worker.test.mjs)
    await stopServe(serve);
    serve = await startServe(envPath);
    const recovered = await waitFor(() => dStatus(dB)[0] === 'FETCHED', 40000);
    const newAudits = Number(owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE';`)) - auditBefore;
    const audit = [String(newAudits), ...owner(`SELECT coalesce(bool_and(performed_by IS NULL)::text, '-') || '|' || coalesce(string_agg(DISTINCT reason, ','), '-')
      FROM (SELECT performed_by, reason FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE' ORDER BY id DESC LIMIT ${Math.max(newAudits, 0)}) x;`).split('|')];
    check('F-3f(c) next permitted probe: exactly one probe GET → 200 → mp_requeue_config_blocked once (actor NULL, reason "auto: credential probe succeeded") → re-claimed → FETCHED',
      recovered && hits.get(B) === hitsSameHour + 2 && audit[0] === '1' && audit[1] === 'true' && audit[2] === REQUEUE_REASON, `recovered=${recovered} hits=${hits.get(B)} audit=${audit}`);
    check('F-3f(d) no duplicated economic effect: 1 source, 1 movement, 3 components, 3 postings, 0 attribution', econ(B) === '1|1|3|3|0', econ(B));
    await sleep(8000);
    check('F-3f(e) later scheduler runs: no further probe or fetch for the payment; no further requeue; economics unchanged',
      hits.get(B) === hitsSameHour + 2 && Number(owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE';`)) === auditBefore + 1 && econ(B) === '1|1|3|3|0',
      `hits=${hits.get(B)}`);
  }

  section('P', 'privileges (no new application access)');
  {
    const roles = ['anon', 'authenticated', 'service_role'];
    // pg_cron's own install grants PUBLIC SELECT on cron.job / job_run_details (grantor supabase_admin); without USAGE on the schema
    // they are unreachable, so the effective access is asserted with real statements
    const cronSel = [asRole('anon', { role: 'anon' }, 'SELECT count(*) FROM cron.job;'), asRole('authenticated', { role: 'authenticated' }, 'SELECT count(*) FROM cron.job_run_details;'),
      asRole('service_role', { role: 'service_role' }, 'SELECT count(*) FROM cron.job;')];
    check('P-1 cron: anon / authenticated / service_role have no USAGE on schema cron, so cron.job / job_run_details are unreachable (permission denied); no cron grant from this project',
      roles.every((r) => owner(`SELECT has_schema_privilege('${r}', 'cron', 'USAGE');`) === 'f') && cronSel.every((r) => !r.ok && /permission denied for schema cron/i.test(r.err))
        && owner(`SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace = 'cron'::regnamespace AND pg_get_userbyid(a.grantor) <> 'supabase_admin';`) === '0',
      cronSel.map((r) => r.err.split(/\r?\n/)[0]).join(' | '));
    const sched = asRole('authenticated', { sub: '11111111-1111-1111-1111-111111111111', role: 'authenticated' }, `SELECT cron.schedule('x', '* * * * *', 'SELECT 1');`);
    const schedSvc = asRole('service_role', { role: 'service_role' }, `SELECT cron.schedule('x', '* * * * *', 'SELECT 1');`);
    check('P-2 an ADMIN (authenticated) or service_role session cannot schedule a job (permission denied on schema cron)',
      !sched.ok && /permission denied/i.test(sched.err) && !schedSvc.ok && /permission denied/i.test(schedSvc.err));
    check('P-3 Vault: anon / authenticated have no access to vault.secrets / decrypted_secrets',
      ['anon', 'authenticated'].every((r) => owner(`SELECT has_schema_privilege('${r}', 'vault', 'USAGE') OR has_table_privilege('${r}', 'vault.decrypted_secrets', 'SELECT');`) === 'f'));
    check('P-4 no Vault privilege was granted by this project: every app-role grant on vault objects comes from the platform (grantor supabase_admin)',
      owner(`SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace = 'vault'::regnamespace AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))
        AND pg_get_userbyid(a.grantor) <> 'supabase_admin';`) === '0');
    check('P-5 pg_net: the only app-role grants on net are the platform installer\'s (grantor supabase_admin), none from this project',
      owner(`SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.pronamespace = 'net'::regnamespace AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))
        AND pg_get_userbyid(a.grantor) <> 'supabase_admin';`) === '0');
    const anonKey = JSON.parse(spawnSync(SUPABASE, ['status', '-o', 'json'], { cwd: REPO, encoding: 'utf8' }).stdout || '{}').ANON_KEY ?? '';
    const rpc = await fetch('http://127.0.0.1:54321/rest/v1/rpc/http_post', { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, 'content-type': 'application/json' }, body: '{"url":"http://example.invalid"}' });
    const rpcNet = await fetch('http://127.0.0.1:54321/rest/v1/rpc/http_post', { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, 'content-type': 'application/json', 'content-profile': 'net' }, body: '{"url":"http://example.invalid"}' });
    const cronRest = await fetch('http://127.0.0.1:54321/rest/v1/job', { headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, 'accept-profile': 'cron' } });
    await rpc.text(); await rpcNet.text(); await cronRest.text();
    check('P-6 unreachable through the API: anon POST /rest/v1/rpc/http_post → 404; with Content-Profile: net → 406; cron via Accept-Profile → 406 (only public / graphql_public are exposed)',
      anonKey !== '' && rpc.status === 404 && rpcNet.status === 406 && cronRest.status === 406, `${rpc.status} ${rpcNet.status} ${cronRest.status}`);
    check('P-7 no public-schema function references net / cron / vault (no wrapper exposes them)',
      owner(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ~* '\\m(net|cron|vault)\\.';`) === '0');
    check('P-8 SECURITY DEFINER set in public unchanged by the scheduler: exactly 63 (60 + ADR-007 RPCs 44 / 45 + ADR-011 RPC 46)', owner(`SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`) === '63');
    check('P-9 no new table / view privilege for application roles on any public MP object (still SELECT / report INSERT only)',
      owner(`SELECT count(*) FROM pg_class c, unnest(ARRAY['anon','authenticated','service_role']) r, unnest(ARRAY['UPDATE','DELETE','TRUNCATE']) p
        WHERE c.relnamespace = 'public'::regnamespace AND (c.relname LIKE 'mp\\_%' OR c.relname LIKE 'report\\_mp\\_%') AND c.relkind IN ('r','v') AND has_table_privilege(r, c.oid, p);`) === '0');
  }

  section('L', 'logs');
  {
    await sleep(1500);
    const logs = serve.output();
    check('L-1 serve logs hold no invoke secret, no MP token and no payload data', !logs.includes(SECRET) && !logs.includes(TOKEN) && !logs.includes('transaction_amount'));
    const netRows = owner(`SELECT count(*) FROM net._http_response WHERE content LIKE ${q(`%${SECRET}%`)};`);
    check('L-2 pg_net stored responses hold no invoke secret', netRows === '0');
  }
} finally {
  unscheduleHarness();
  try { clearScheduler(); } catch { /* reported by the check below on the next run */ }
  serve.child.kill();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
}
check('Z-1 teardown: harness job removed, Vault entries removed (the Step-11 job is back to fail-closed), Step-11 job intact',
  owner(`SELECT count(*) FROM cron.job WHERE jobname = ${q(HARNESS_JOB)};`) === '0'
    && owner(`SELECT count(*) FROM vault.secrets WHERE name IN (${q(VAULT_URL_NAME)}, ${q(VAULT_SECRET_NAME)});`) === '0'
    && owner(`SELECT count(*) FROM cron.job WHERE jobname = ${q(JOB)} AND schedule = '* * * * *' AND active;`) === '1');
console.log(`\n  ══ MP SCHEDULER (STEP 11) RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail) console.log(failures.map((f) => `   - ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
