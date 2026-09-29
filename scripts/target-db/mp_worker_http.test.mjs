#!/usr/bin/env node
/**
 * ADR-006 Step 8 — mp-worker Edge Function under `supabase functions serve` (local stack only).
 *
 * Run (local stack up with kong + rest + edge runtime, target DB at 0001–0052):
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/mp_worker_http.test.mjs
 *
 * Proves the endpoint auth (x-worker-invoke-secret, constant-time), the real PostgREST + MP adapters
 * end to end under the final Step-9 privilege perimeter (0054: service_role SELECT on mp_webhook_delivery —
 * chargeback auto-link and the CONFIG_BLOCKED probe read — with no owner simulation), and the logging policy. Mercado Pago is a local mock HTTP server on this host, reached
 * by the edge runtime through MP_API_BASE_URL=http://host.docker.internal:<port>; api.mercadopago.com
 * is never contacted. Fake secrets only.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSafeDestructiveTarget, assertSafeCliOperation, assertNoProductionCredentials } from '../test-env/guard.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const SECRET = 'mp-worker-local-test-invoke-secret';
const TOKEN = 'APP-TEST-FAKE-TOKEN-not-real-worker';
const COLLECTOR = '100000001';
const URL_ = 'http://127.0.0.1:54321/functions/v1/mp-worker';
const container = 'supabase_db_Claudio_app_Granja';
let pass = 0;
let fail = 0;
function check(label, cond, detail = '') { cond ? pass++ : fail++; console.log(`    ${cond ? 'OK  ' : 'MAL '} ${label}${cond ? '' : ` :: ${detail}`}`); }
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
function owner(s) {
  const r = spawnSync(DOCKER, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { encoding: 'utf8', input: s });
  if (r.status !== 0) throw new Error(`owner SQL failed:\n${s}\n${r.stderr}`);
  return (r.stdout || '').trim();
}
const esc = (s) => String(s).replace(/'/g, "''");
const svc = (s) => owner(`BEGIN;\nSET LOCAL ROLE service_role;\nSET LOCAL "request.jwt.claims" = '{"role":"service_role"}';\n${s}\nCOMMIT;`);

// ── mock Mercado Pago on this host ───────────────────────────────────────────
const PID = `7774${String(Date.now()).slice(-8)}`;
const CB = `7775${String(Date.now()).slice(-8)}`;
const PID2 = `77749${String(Date.now()).slice(-7)}`;
let pid2Calls = 0;
const mpLog = [];
const CLIENT_NAME = `S8H-C2 ${Date.now()}`;
let CLIENT = null;
const payload = {
  id: Number(PID), operation_type: 'money_transfer', status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true,
  collector_id: Number(COLLECTOR), payer: { id: '800000999', email: 'buyer@example.invalid', first_name: 'Buyer' }, external_reference: null, // set to GST:C:<client> below
  date_created: '2026-11-05T10:00:00.000-04:00', date_approved: '2026-11-05T10:00:00.000-04:00', transaction_amount: 100,
  transaction_details: { net_received_amount: 93 }, fee_details: [{ type: 'mercadopago_fee', amount: 5, fee_payer: 'collector' }],
  refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [],
};
const server = createServer((req, res) => {
  mpLog.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
  if (req.method === 'GET' && req.url === `/v1/payments/${PID2}`) {
    // first call 401 (credential broken), later calls 200 (credential fixed: probe + fetch)
    pid2Calls += 1;
    res.writeHead(pid2Calls === 1 ? 401 : 200, { 'content-type': 'application/json' });
    res.end(pid2Calls === 1 ? '{"message":"unauthorized"}' : JSON.stringify({ ...payload, id: Number(PID2), external_reference: null }));
    return;
  }
  if (req.method === 'GET' && req.url === `/v1/payments/${PID}`) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"message":"not found"}');
});
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const PORT = server.address().port;

function cleanup() {
  owner(`
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:7774%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op  AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '7774%' OR resource_id LIKE '7775%';
CREATE TEMP TABLE _al  AS SELECT id, client_ledger_id FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM audit_events WHERE entity_type = 'mp_client_allocation' AND entity_id IN (SELECT id::TEXT FROM _al);
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al);
DELETE FROM client_ledger WHERE id IN (SELECT client_ledger_id FROM _al);
DELETE FROM audit_events WHERE (entity_type = 'mp_source_record' AND entity_id IN (SELECT id::TEXT FROM _src))
   OR (entity_type = 'mp_financial_movement' AND entity_id IN (SELECT id::TEXT FROM _mv))
   OR (entity_type = 'mp_webhook_delivery' AND entity_id IN (SELECT id::TEXT FROM _dl));
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE triggered_by_delivery_id IN (SELECT id FROM _dl);
DELETE FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE' AND reason = 'auto: credential probe succeeded' AND performed_by IS NULL;
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
DELETE FROM clients WHERE nombre LIKE 'S8H-C2 %';`);
}

async function startServe(envPath) {
  const args = ['functions', 'serve', '--no-verify-jwt', '--env-file', envPath];
  assertSafeCliOperation(args);
  const child = spawn(SUPABASE, args, { cwd: REPO, env: { ...process.env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (!out.includes('Serving functions on')) { await sleep(500); continue; }
    try {
      const r = await fetch(URL_, { method: 'GET' });
      await r.text();
      if (r.status === 405) return { child, output: () => out };
    } catch { /* not ready */ }
    await sleep(1000);
  }
  child.kill();
  throw new Error(`functions serve did not become ready\n${out.slice(-2000)}`);
}

assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
cleanup();
CLIENT = owner(`INSERT INTO clients (nombre, activo) VALUES ('${CLIENT_NAME}', true) RETURNING id;`);
payload.external_reference = `GST:C:${CLIENT}`;
const foreignDue = owner(`SELECT count(*) FROM mp_webhook_delivery WHERE status IN ('RECEIVED', 'FAILED_RETRYABLE') AND next_attempt_at <= NOW() + INTERVAL '1 day'
  AND coalesce(resource_id, '') NOT LIKE '7774%' AND coalesce(resource_id, '') NOT LIKE '7775%';`);
check('S0 no foreign due deliveries', foreignDue === '0', foreignDue);
const foreignBlocked = owner(`SELECT count(*) FROM mp_webhook_delivery WHERE status = 'CONFIG_BLOCKED' AND coalesce(resource_id, '') NOT LIKE '7774%';`);
check('S0b no foreign CONFIG_BLOCKED deliveries (the probe must only see this suite row)', foreignBlocked === '0', foreignBlocked);

const dir = mkdtempSync(join(tmpdir(), 'mpwk-'));
const envPath = join(dir, 'functions.env');
writeFileSync(envPath, [`WORKER_INVOKE_SECRET=${SECRET}`, `MP_ACCESS_TOKEN=${TOKEN}`, `MP_COLLECTOR_ID=${COLLECTOR}`,
  `MP_API_BASE_URL=http://host.docker.internal:${PORT}`, 'MP_WEBHOOK_SECRET=mp-webhook-local-test-secret-not-real', ''].join('\n'));
const serve = await startServe(envPath);
try {
  const post = (headers) => fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  let r = await post({});
  check('A-1 missing x-worker-invoke-secret → 401', r.status === 401, String(r.status));
  await r.text();
  r = await post({ 'x-worker-invoke-secret': 'wrong-secret' });
  check('A-2 wrong secret → 401', r.status === 401, String(r.status));
  await r.text();
  r = await post({ 'x-worker-invoke-secret': SECRET.slice(0, -1) });
  check('A-3 secret prefix → 401 (whole-value, constant-time comparison)', r.status === 401);
  await r.text();
  check('A-4 no MP request was made by unauthenticated calls', mpLog.length === 0);

  // a payment delivery and a chargeback signal, then one authenticated run
  const d = JSON.parse(svc(`SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', '${PID}', NULL, 'S8H-x', '{"notification_id":"s8h-${Date.now()}"}'::jsonb, true)::text;`)).delivery_id;
  const cb = JSON.parse(svc(`SELECT mp_register_delivery('webhook', 'topic_chargebacks_wh', 'chargeback', NULL, '${CB}', NULL, 'S8H-cb',
    '{"type":"topic_chargebacks_wh","data_id":"${CB}","data_payment_id":"${PID}","live_mode":true,"user_id":${COLLECTOR},"notification_id":"s8h-cb-${Date.now()}"}'::jsonb, true)::text;`)).delivery_id;
  r = await post({ 'x-worker-invoke-secret': SECRET });
  const summary = await r.json();
  check('A-5 exact secret → 200 with the run summary', r.status === 200 && summary.claimed >= 2 && summary.fetched === 1 && summary.signals === 1, JSON.stringify(summary));
  const row = owner(`SELECT status || '|' || coalesce(source_record_id::text, '-') FROM mp_webhook_delivery WHERE id = '${d}';`).split('|');
  const ops = owner(`SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id
    JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${PID}:%';`);
  check('E-1 end to end through PostgREST: FETCHED, source RECONCILED, 3 A1 components', row[0] === 'FETCHED' && ops === '3'
    && owner(`SELECT processing_status FROM mp_source_record WHERE external_id LIKE 'MPPAY:${PID}:%';`) === 'RECONCILED', `${row} ${ops}`);
  const reqs = mpLog.filter((x) => x.url === `/v1/payments/${PID}`);
  const al = owner(`SELECT count(*) || '|' || coalesce(max(a.cliente_id::text), '-') || '|' || coalesce(max(a.mode), '-') || '|' || coalesce(sum(l.signed_amount)::text, '-')
    FROM mp_client_allocation a JOIN client_ledger l ON l.id = a.client_ledger_id JOIN mp_financial_movement m ON m.id = a.mp_financial_movement_id
    JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${PID}:%';`);
  check('E-1b deterministic evidence (external_reference GST:C:<client>) → C2 AUTO allocation through the PostgREST adapter: 1 allocation, client_ledger −100, summary.allocated = 1',
    al === `1|${CLIENT}|AUTO|-100.00` && summary.allocated === 1, al + ' ' + JSON.stringify(summary));
  check('E-2 exactly one GET /v1/payments/{id} to the mock, with Authorization: Bearer <MP_ACCESS_TOKEN>; no other MP endpoint',
    reqs.length === 1 && reqs[0].method === 'GET' && reqs[0].auth === `Bearer ${TOKEN}` && mpLog.every((x) => x.url.startsWith('/v1/payments/')), JSON.stringify(mpLog));
  check('E-3 chargeback auto-link through the real service-role PostgREST read (Step 9): data_payment_id read → SIGNAL_RECORDED + LINKED; exactly one chargeback_refresh payment delivery for that payment',
    owner(`SELECT status || '|' || coalesce(signal_resolution, '-') FROM mp_webhook_delivery WHERE id = '${cb}';`) === 'SIGNAL_RECORDED|LINKED'
      && owner(`SELECT count(*) || '|' || max(topic_class) || '|' || max(resource_id) || '|' || max(origin) FROM mp_webhook_delivery WHERE triggered_by_delivery_id = '${cb}';`) === `1|payment|${PID}|chargeback_refresh`,
    owner(`SELECT status || '|' || coalesce(signal_resolution, '-') FROM mp_webhook_delivery WHERE id = '${cb}';`));
  r = await post({ 'x-worker-invoke-secret': SECRET });
  const s2 = await r.json();
  const ledger = () => owner(`SELECT (SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id
    JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${PID}:%') || '|' || (SELECT count(*) FROM mp_client_allocation a
    JOIN mp_financial_movement m ON m.id = a.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:${PID}:%');`);
  check('E-4 the second run processes only the chargeback_refresh (current resource re-fetched → same source): FETCHED; no duplicate money or attribution',
    r.status === 200 && s2.claimed === 1 && s2.fetched === 1 && s2.applied === 0 && s2.allocated === 0 && ledger() === '3|1'
      && owner(`SELECT status FROM mp_webhook_delivery WHERE triggered_by_delivery_id = '${cb}';`) === 'FETCHED', JSON.stringify(s2) + ' ' + ledger());
  r = await post({ 'x-worker-invoke-secret': SECRET });
  const s3 = await r.json();
  check('E-4b a third run finds nothing to do', r.status === 200 && s3.claimed === 0 && ledger() === '3|1', JSON.stringify(s3));

  // CONFIG_BLOCKED probe through the real service-role PostgREST read
  const d2 = JSON.parse(svc(`SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', '${PID2}', NULL, 'S8H-p', '{"notification_id":"s8h-p-${Date.now()}"}'::jsonb, true)::text;`)).delivery_id;
  r = await post({ 'x-worker-invoke-secret': SECRET });
  const sb = await r.json();
  check('P-1 401 from MP → CONFIG_BLOCKED (auth circuit breaker); no source', sb.stopped === 'auth_circuit_breaker' && sb.config_blocked === 1
    && owner(`SELECT status FROM mp_webhook_delivery WHERE id = '${d2}';`) === 'CONFIG_BLOCKED'
    && owner(`SELECT count(*) FROM mp_source_record WHERE external_id LIKE 'MPPAY:${PID2}:%';`) === '0', JSON.stringify(sb));
  const auditsBefore = Number(owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE';`));
  r = await post({ 'x-worker-invoke-secret': SECRET });
  const sp = await r.json();
  const lastAudit = owner(`SELECT (performed_by IS NULL) || '|' || coalesce(reason, '-') FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE' ORDER BY id DESC LIMIT 1;`);
  check('P-2 next run: the service role reads the oldest CONFIG_BLOCKED row (Step-9 grant) → exactly one probe GET → 200 → mp_requeue_config_blocked (actor NULL) → the row is processed → FETCHED',
    sp.probe === 'requeued' && pid2Calls === 3 && owner(`SELECT status FROM mp_webhook_delivery WHERE id = '${d2}';`) === 'FETCHED'
      && Number(owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE';`)) === auditsBefore + 1
      && lastAudit === 'true|auto: credential probe succeeded', JSON.stringify(sp) + ` calls=${pid2Calls} ${lastAudit}`);
  check('E-5 no CORS header on the worker response', r.headers.get('access-control-allow-origin') === null || /kong/i.test(r.headers.get('via') ?? ''));

  await sleep(1500);
  const logs = serve.output();
  const fnLines = logs.split('\n').filter((l) => l.includes('"fn":"mp-worker"'));
  check('L-1 worker logs hold no invoke secret, MP token, payload or payer data', fnLines.length > 0 && !logs.includes(SECRET) && !logs.includes(TOKEN)
    && !logs.includes('buyer@example.invalid') && !logs.includes('transaction_amount') && fnLines.some((l) => l.includes('WORKER_UNAUTHORIZED')), fnLines.slice(-5).join('\n'));
} finally {
  serve.child.kill();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
}
console.log(`\n  ══ MP WORKER HTTP RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
