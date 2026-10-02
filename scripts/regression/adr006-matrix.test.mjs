#!/usr/bin/env node
/**
 * ADR-006 Step 13 — whole test-matrix closure + final security check. LOCAL ONLY.
 *
 * Run (after the target-db suites, on a target at the current head):
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/regression/adr006-matrix.test.mjs
 *
 * 1. Traceability. Every row ID of ADR006_TEST_MATRIX_V1 is classified as
 *      ACTIVE     — asserted by the named check(s) of a regression suite (the label must exist verbatim);
 *      V4_BRANCH  — asserted with mp_v4_verified() redefined to true inside a rolled-back transaction;
 *      PARTIAL    — the active part asserted, the rest under a written deferral;
 *      DEFERRED   — deferred by the matrix itself (row text, the Step-7 deferral paragraph, or a section
 *                   declared "requirements only"); the deferral wording is verified in the matrix text.
 *    A matrix ID with no classification, or evidence whose label no longer exists, fails. The suites
 *    themselves are run by the Step-13 regression; this file proves the mapping is complete and real.
 * 2. The two matrix parts that had no prior assertion:
 *      C-13 (closed-period part): MANUAL allocation into a CLOSED period → PERIOD_CLOSED, Δ = 0;
 *      M-4 (V-4 test branch): an API transition with no report row → MISSING_IN_REPORT; rerun Δ = 0.
 * 3. Final security check (definer set, helpers, V-4 flag, R4 guard, views, scheduler fail-closed,
 *    pg_net perimeter).
 * Synthetic ids only: payments 7782…, clients 'S13M …'. MP is not contacted.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertSafeDestructiveTarget, assertNoProductionCredentials } from '../test-env/guard.mjs';
import { ensureLocalMpBoundary } from '../test-env/mp-boundary-fixture.mjs';   // ADR-017: RPC 40 needs the cutover boundary (fail safe)

const REPO = resolve(import.meta.dirname, '..', '..');
const MATRIX = readFileSync(join(REPO, '.planning', 'implementation-design', 'ADR006_TEST_MATRIX_V1.md'), 'utf8');
const SELF = readFileSync(import.meta.filename, 'utf8');
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const COLLECTOR = '100000001';
let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; failures.push(label); console.log(`    MAL  ${label} :: ${detail}`); }
}
const section = (n, t) => console.log(`\n  ── ${n}. ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);

// ── 1. traceability ──────────────────────────────────────────────────────────
const SUITE = (s) => (s === 'self' ? SELF : s === 'ct' ? readFileSync(join(REPO, 'scripts', 'regression', 'clean-cutover-current-target.mjs'), 'utf8')
  : readFileSync(join(REPO, 'scripts', 'target-db', `${s}.test.mjs`), 'utf8'));
const A = (...ev) => ({ s: 'ACTIVE', ev });
const V4 = (...ev) => ({ s: 'V4_BRANCH', ev });
const P = (why, ...ev) => ({ s: 'PARTIAL', why, ev });
const D = (why) => ({ s: 'DEFERRED', why, ev: [] });
const STEP7 = 'step7';   // "Step-7 deferrals (explicit)" paragraph
const MAP = {
  'W-1': A(['mp_webhook', 'W1 exactly one delivery'], ['mp_realtime', 'W1 notification with a documented id']),
  'W-2': A(['mp_webhook', 'W3 different x-request-id'], ['mp_realtime', 'W2 same notification retried with a DIFFERENT']),
  'W-2b': A(['mp_webhook', 'W2 duplicate'], ['mp_realtime', 'W2b same notification retried with the same']),
  'W-2c': A(['mp_realtime', 'W4 same natural key, different content']),
  'W-2d': A(['mp_realtime', 'W5 the same conflicting notification replayed']),
  'W-2e': A(['mp_realtime', 'W6 a second, different conflicting content']),
  'W-2f': A(['mp_realtime', 'W3 stored notification_sha256'], ['mp_realtime', 'W7 hash fallback key'], ['mp_realtime', 'W8 NULL action']),
  'W-2g': A(['mp_realtime', 'W9 notification id outside']),
  'W-3': A(['mp_worker', 'F-2 duplicate notification']),
  'W-4': A(['mp_webhook', 'W6 tampered'], ['mp_webhook', 'W7 stale']),
  'W-5': A(['mp_webhook', 'W8 foreign collector']),
  'W-6': A(['mp_webhook', 'W5 unsupported'], ['mp_realtime', 'W10 unsupported topic']),
  'W-7': A(['mp_webhook', 'W10 DB failure']),
  'W-8': A(['mp_webhook', 'W9 invalid JSON']),
  'W-9': A(['mp_webhook', 'W4 200; one chargeback delivery'], ['mp_realtime', 'C1 a verified chargeback notification']),
  'W-10': A(['mp_webhook', 'W4 chargeback retried']),
  'F-1': A(['mp_worker', 'F-1(matrix) timeout']),
  'F-2': A(['mp_worker', 'F-2(matrix) 429']),
  'F-3a': A(['mp_worker', 'F-3a / F-3c first delivery 401'], ['mp_views', 'F-3a CONFIG_BLOCKED (401)']),
  'F-3b': A(['mp_worker', 'F-3b 403']),
  'F-3c': A(['mp_worker', 'F-3a / F-3c first delivery 401']),
  'F-3d': A(['mp_worker', 'F-3d CONFIG_BLOCKED rows are never claimed'], ['mp_scheduler', 'F-3f(a) 401']),
  'F-3e': A(['mp_worker', 'F-3e ADMIN requeue']),
  'F-3f': A(['mp_worker', 'F-3f probe'], ['mp_scheduler', 'F-3f(c) next permitted probe']),
  'F-3g': A(['mp_worker', 'F-3g requeue while']),
  'F-4': A(['mp_worker', 'F-4 404 then 200']),
  'F-5': A(['mp_worker', 'F-5 transient failure beyond'], ['mp_views', 'F-5 transient failures beyond 48 h']),
  'F-6': A(['mp_worker', 'F-6 400']),
  'F-7': A(['mp_worker', 'F-7 collector mismatch']),
  'F-8': A(['mp_worker', 'F-8 crash after the claim']),
  'F-9': A(['mp_worker', 'F-9 crash after the snapshot']),
  'F-10': A(['mp_worker', 'F-10 crash after A1']),
  'F-11': A(['mp_realtime', 'Q2 concurrent claims']),
  'F-12': A(['mp_worker', 'F-12 stale worker']),
  'F-13': A(['mp_worker', 'F-13 out-of-order']),
  'F-14': A(['mp_worker', 'F-14 path']),
  'F-15': A(['mp_realtime', 'C4 p_link_payment_id on an unrelated outcome']),
  'N-1': A(['mp_payment_normalization', 'N-1 A1 → NORMALIZED']),
  'N-2': A(['mp_payment_normalization', 'N-2 identical payload']),
  'N-3': A(['mp_payment_normalization', 'N-3 changed version']),
  'N-4': A(['mp_payment_normalization', 'N-4 pending / rejected']),
  'N-5': A(['mp_payment_normalization', 'N-5 / D residual']),
  'N-6': A(['mp_payment_normalization', 'N-6 / N-14 regular_payment']),
  'N-7': D('row'),
  'N-8': D('row'),
  'N-9': A(['mp_payment_normalization', 'N-9 (Step-6 scope)'], ['mp_privileges', 'S-4d / N-9 service_role direct INSERT']),
  'N-10': A(['mp', 'B4 service-role INSERT'], ['mp', 'D1 real payment row'], ['mp_realtime', 'N1 Liberaciones payment row']),
  'N-11': A(['mp_payment_normalization', 'H / N-11 refund snapshot']),
  'N-12': A(['mp_payment_normalization', 'N-12 fixture']),
  'N-13': A(['mp_payment_normalization', 'I / N-13 charged_back first'], ['mp_payment_normalization', 'N-13 in_mediation after']),
  'N-14': A(['mp_payment_normalization', 'A / N-14 approved']),
  'T-1': A(['mp_atomic_application', 'T-1 APPLIED']),
  'T-2': A(['mp_atomic_application', 'T-2 / T-11 RPC 41']),
  'T-3': A(['mp_atomic_application', 'T-3 exact replay']),
  'T-4': A(['mp_atomic_application', 'T-4 after an RPC 41']),
  'T-5': A(['mp_atomic_application', 'T-5 pre-existing']),
  'T-6': A(['mp_atomic_application', 'T-6 failure on the 3rd posting']),
  'T-7': A(['mp_atomic_application', 'T-7 CLOSED period']),
  'T-8': A(['mp_atomic_application', 'T-8 fee 0 and tax 0']),
  'T-9': A(['mp_atomic_application', 'T-9 payout']),
  'T-10': A(['mp_atomic_application', 'T-10 / M-3 yield']),
  'T-11': A(['mp_atomic_application', 'T-2 / T-11 RPC 41'], ['mp_atomic_application', 'T-11b after A1']),
  'T-12': P(STEP7, ['mp_atomic_application', 'T-12 (Step-7 part)']),
  'C-1': A(['mp_views', 'C-1 anonymous Feria receipt'], ['mp_realtime', 'A1 CLIENT_UNASSIGNED is a valid state']),
  'C-2': A(['mp_atomic_application', 'C-2 after A1 the ADMIN allocation'], ['mp_realtime', 'A5 attribution creates NO']),
  'C-3': A(['mp_worker', 'C2-3 exact active payer map']),
  'C-4': A(['mp_worker', 'C2-1 external_reference GST:C']),
  'C-5': A(['mp_worker', 'C2-6 no evidence'], ['mp_audit_security', 'C-5 C2 without evidence']),
  'C-6': A(['mp_worker', 'C2-5 external_reference and payer map name different']),
  'C-7': A(['mp_realtime', 'A3 manual partial allocation'], ['mp_views', 'C-17 partial allocation without a flag']),
  'C-8': A(['mp_realtime', 'A4 split allocation']),
  'C-9': A(['mp_realtime', 'A11 two concurrent allocations']),
  'C-10': A(['mp_realtime', 'A6 over-allocation']),
  'C-11': A(['mp_realtime', 'A12 manual reversal'], ['mp_realtime', 'A13 reversing more than remains']),
  'C-12': A(['mp_realtime', 'A13 reversing more than remains']),
  'C-13': A(['mp_realtime', 'A8 inactive client'], ['self', 'C-13 (closed-period part)']),
  'C-14': A(['mp_atomic_application', 'C-14 allocation on a NORMALIZED'], ['mp_realtime', 'A9 a receipt whose treasury effect']),
  'C-15': A(['mp_atomic_application', 'C-15 service role cannot allocate'], ['mp_realtime', 'A10 the service role cannot choose']),
  'C-16': A(['mp_views', 'C-16a open attribution flag'], ['mp_views', 'C-16c full allocation auto-clears']),
  'C-17': A(['mp_realtime', 'A7 duplicate MANUAL key']),
  'R-1': D(STEP7), 'R-2': D(STEP7), 'R-3': D(STEP7), 'R-4': D(STEP7), 'R-5': D(STEP7), 'R-6': D(STEP7),
  'R-7': A(['mp_views', 'R-7 API snapshot status charged_back']),
  'R-8': D('row'),
  'R-9': D(STEP7), 'R-10': D(STEP7), 'R-11': D(STEP7),
  'R-12': A(['mp_worker', 'R-12 signal with'], ['mp_realtime', 'C5 SIGNAL_RECORDED with a documented']),
  'R-13': A(['mp_worker', 'R-13 signal without'], ['mp_realtime', 'C6 SIGNAL_RECORDED without']),
  'R-14': A(['mp_worker', 'R-14 the same chargeback']),
  'M-1': D(STEP7),
  'M-2': P(STEP7, ['mp_views', 'M-2 open DISCREPANCY'], ['mp_realtime', 'R3 resolve']),
  'M-3': A(['mp_atomic_application', 'T-10 / M-3 yield'], ['mp_realtime', 'N4 Liberaciones yield']),
  'M-4': V4(['self', 'M-4 (V-4 test branch)'], ['mp_realtime', 'R2 coverage while V-4 is open']),
  'M-5': D(STEP7),
  'M-6': V4(['mp_atomic_application', 'M-6 (V-4 test branch) exhausted']),
  'M-6b': V4(['mp_atomic_application', 'M-6b back-fill not exhausted'], ['mp_atomic_application', 'M-6b with mp_v4_verified() = false']),
  'M-7': A(['mp_realtime', 'R1 balance check']),
  'M-8': A(['mp_realtime', 'N1 Liberaciones payment row'], ['mp_realtime', 'N7 mp_v4_verified() is false']),
  'S-1': A(['mp_privileges', 'S-1a anon SELECT']),
  'S-2': A(['mp_privileges', 'S-2a OPERATOR sees 0 rows']),
  'S-3': A(['mp_privileges', 'S-3a ADMIN reads']),
  'S-4': A(['mp_privileges', 'S-4a service_role has no SELECT']),
  'S-5': A(['mp_privileges', 'S-5c guard triggers'], ['mp_realtime', 'S8 immutability guard']),
  'S-6': A(['mp_privileges', 'S-6c a forged external_reference']),
  'S-7': A(['mp_privileges', 'S-7a SECURITY DEFINER set']),
  'S-8': A(['mp_scheduler', 'S-8a no x-worker-invoke-secret'], ['mp_worker_http', 'A-2 wrong secret']),
  'A-1': A(['mp_audit_security', 'A-1 summary']),
  'A-2': A(['mp_audit_security', "noop('W-2 duplicate delivery"], ['mp_audit_security', "noop('T-3 A1 replay"]),
  'A-3': A(['mp_audit_security', 'A-3 zero sensitive matches']),
  'D1': A(['mp', 'D1 real payment row']),
  'D3': A(['mp', 'D3 real outgoing payment']),
  'D8': A(['mp', 'D8 normalizing a processed source']),
  'D11': A(['mp', 'D11 audit NORMALIZE']),
  'CT-1': A(['ct', 'CT-1b ledger rows = migration files present']),
  'CT-2': A(['ct', 'CT-2a the historical Run 1 plan.json sha256'], ['ct', 'CT-2d the historical runner']),
  'CT-3': A(['ct', 'CT-3b every check passes']),
  'CT-4': A(['ct', 'CT-4a DIGEST lines equal']),
  'CT-5': A(['ct', 'CT-5b zero-write fingerprint']),
};
for (const id of ['DIRECTION-1', 'DIRECTION-2', 'DIRECTION-2b', 'DIRECTION-3', 'DIRECTION-4', 'DIRECTION-5', 'DIRECTION-6', 'DIRECTION-7', 'DIRECTION-8']) MAP[id] = D('direction');
for (const id of ['CROSSREPORT-1', 'CROSSREPORT-2', 'CROSSREPORT-3', 'CROSSREPORT-4', 'CROSSREPORT-5']) MAP[id] = D('crossreport');

const matrixIds = [...new Set([...MATRIX.matchAll(/^\| ((?:W|F|N|T|C|R|M|S|A|D|CT|DIRECTION|CROSSREPORT)-?[0-9]+[a-z]?) \|/gm)].map((m) => m[1]))];
const rowText = (id) => (MATRIX.split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? '');
const step7 = MATRIX.split('\n').find((l) => l.startsWith('**Step-7 deferrals (explicit):**')) ?? '';
function deferralProven(id, why) {
  if (why === 'row') return /DEFERRED|blocked/i.test(rowText(id));
  if (why === STEP7) {
    if (/^R-[1-6]$/.test(id)) return step7.includes('R-1…R-6');
    if (/^R-(9|10|11)$/.test(id)) return step7.includes('R-9…R-11');
    if (id === 'T-12') return step7.includes('T-12 (the Liberaciones-row half)');
    if (id === 'M-2') return step7.includes('M-2 (payment form)');
    return new RegExp(`\\b${id}\\b`).test(step7);
  }
  if (why === 'direction') return /DIRECTION[\s\S]{0,400}requirements only[\s\S]{0,120}steps 16 \/ 19/.test(MATRIX);
  if (why === 'crossreport') return /CROSSREPORT[\s\S]{0,300}requirements only \(Step 16\)/.test(MATRIX);
  return false;
}

section('1', 'matrix traceability');
{
  const missing = matrixIds.filter((id) => !MAP[id]);
  const stale = Object.keys(MAP).filter((id) => !matrixIds.includes(id));
  check(`T-0 every matrix row ID has a classification (${matrixIds.length} IDs in ADR006_TEST_MATRIX_V1)`, missing.length === 0 && stale.length === 0,
    `unclassified: ${missing.join(',')} | not in matrix: ${stale.join(',')}`);
  const badEv = [];
  const badDef = [];
  for (const [id, m] of Object.entries(MAP)) {
    for (const [suite, label] of m.ev) if (!SUITE(suite).includes(label)) badEv.push(`${id}: ${suite} "${label}"`);
    if ((m.s === 'DEFERRED' || m.s === 'PARTIAL') && !deferralProven(id, m.why)) badDef.push(id);
    if ((m.s === 'ACTIVE' || m.s === 'V4_BRANCH' || m.s === 'PARTIAL') && m.ev.length === 0) badEv.push(`${id}: no evidence`);
  }
  check('T-1 every ACTIVE / V4_BRANCH / PARTIAL row names evidence that exists verbatim in its suite', badEv.length === 0, badEv.join(' | '));
  check('T-2 every DEFERRED / PARTIAL row is deferred by the matrix itself (row text, the Step-7 deferral paragraph, or a "requirements only" section)',
    badDef.length === 0, badDef.join(','));
  const by = (s) => Object.entries(MAP).filter(([, m]) => m.s === s).map(([id]) => id);
  console.log(`      ACTIVE ${by('ACTIVE').length} · V4_BRANCH ${by('V4_BRANCH').length} (${by('V4_BRANCH').join(', ')}) · PARTIAL ${by('PARTIAL').length} (${by('PARTIAL').join(', ')}) · DEFERRED ${by('DEFERRED').length}`);
  console.log(`      DEFERRED: ${by('DEFERRED').join(', ')}`);
}

// ── DB helpers ───────────────────────────────────────────────────────────────
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
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
ensureLocalMpBoundary();
const container = (spawnSync(DOCKER, ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean)[0];
function raw(s) {
  const r = spawnSync(DOCKER, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { encoding: 'utf8', input: s });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function owner(s) { const r = raw(s); if (!r.ok) throw new Error(`owner SQL failed:\n${s}\n${r.err}`); return r.out; }
const esc = (s) => String(s).replace(/'/g, "''");
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(v)}'`);
const wrap = (role, claims, s, end = 'COMMIT') => `BEGIN;\nSET LOCAL ROLE ${role};\nSET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';\n${s}\n${end};`;
const SVC = (s, end) => raw(wrap('service_role', { role: 'service_role' }, s, end));
const ADMIN = (s) => raw(wrap('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s));
const svc = (call) => { const r = SVC(`SELECT (${call})::text;`); if (!r.ok) throw new Error(`${call}\n${r.err}`); return JSON.parse(r.out); };
function cleanup() {
  owner(`
UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha = '2026-11-01' AND status <> 'OPEN';
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:7782%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op  AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '7782%';
DELETE FROM audit_events WHERE (entity_type = 'mp_source_record' AND entity_id IN (SELECT id::TEXT FROM _src))
   OR (entity_type = 'mp_financial_movement' AND entity_id IN (SELECT id::TEXT FROM _mv))
   OR (entity_type = 'mp_webhook_delivery' AND entity_id IN (SELECT id::TEXT FROM _dl));
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
DELETE FROM clients WHERE nombre LIKE 'S13M %';`);
}
cleanup();
owner(`INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false) ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true) ON CONFLICT (id) DO NOTHING;`);

// a posted payment / APPROVAL receipt through the real service path (occurred 2026-11-05)
const PID = `7782${String(Date.now()).slice(-8)}`;
const at = '2026-11-05T10:00:00.000-04:00';
const body = { id: Number(PID), operation_type: 'money_transfer', status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true,
  collector_id: Number(COLLECTOR), payer: { id: '800000999' }, external_reference: null, date_created: at, date_approved: at, transaction_amount: 100,
  transaction_details: { net_received_amount: 93 }, fee_details: [{ type: 'mercadopago_fee', amount: 5, fee_payer: 'collector' }], refunds: [],
  transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
const d = svc(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(PID)}, NULL, 'S13M', ${q(JSON.stringify({ notification_id: `s13m-${PID}` }))}::jsonb, true)`).delivery_id;
const claims = JSON.parse(SVC(`SELECT coalesce(json_agg(c), '[]')::text FROM mp_claim_deliveries(50, 120) c;`).out);
const tok = claims.find((c) => c.delivery_id === d)?.claim_token;
const src = svc(`mp_ingest_api_snapshot(${q(d)}, ${q(tok)}, ${q(PID)}, ${q(JSON.stringify(body))}::jsonb)`);
svc(`mp_normalize_source(${q(src.source_record_id)})`);
const MV = Number(owner(`SELECT id FROM mp_financial_movement WHERE mp_source_record_id = ${q(src.source_record_id)};`));
const TID = Number(owner(`SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id = ${MV};`));
svc(`mp_apply_transition(${MV})`);
svc(`mp_delivery_transition(${q(d)}, ${q(tok)}, 'FETCHED', ${q(src.source_record_id)}, NULL, NULL, NULL, NULL)`);

section('2', 'matrix parts without a prior assertion');
{
  const cli = owner(`INSERT INTO clients (nombre, activo) VALUES ('S13M client ${Date.now()}', true) RETURNING id;`);
  const snap = () => owner(`SELECT (SELECT count(*) FROM mp_client_allocation) || '|' || (SELECT count(*) FROM client_ledger) || '|' || (SELECT count(*) FROM audit_events) || '|' || (SELECT count(*) FROM collections);`);
  owner(`UPDATE management_period SET status = 'CLOSED' WHERE periodo_fecha = '2026-11-01';`);
  const s0 = snap();
  const r = ADMIN(`SELECT mp_allocate_to_client(${MV}, ${q(cli)}, 40, '2026-11-05', 'S13M-k-${PID}', 'S13M closed period');`);
  const s1 = snap();
  owner(`UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha = '2026-11-01';`);
  check('C-13 (closed-period part) a MANUAL allocation dated in a CLOSED management period → PERIOD_CLOSED; Δ allocation / client_ledger / audit / collections = 0',
    !r.ok && /PERIOD_CLOSED/.test(r.err) && s0 === s1, `${s0} → ${s1} ${r.err.split('\n')[0]}`);
}
{
  const defBefore = createHash('sha256').update(owner(`SELECT pg_get_functiondef('mp_v4_verified()'::regprocedure);`)).digest('hex');
  const wm = owner('SELECT coalesce(max(id), 0) FROM audit_events;');
  const out = owner(`BEGIN;
CREATE OR REPLACE FUNCTION mp_v4_verified() RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claims" = '{"role":"service_role"}';
SELECT 'RUN1|' || mp_check_report_coverage('csv_import', '2026-11-05', '2026-11-05')::text;
SELECT 'RUN2|' || mp_check_report_coverage('csv_import', '2026-11-05', '2026-11-05')::text;
RESET ROLE;
SELECT 'MINE|' || count(*) FROM mp_report_match WHERE outcome = 'MISSING_IN_REPORT' AND transition_id = ${TID} AND is_exception
  AND coverage_from = '2026-11-05' AND coverage_to = '2026-11-05' AND report_source_id IS NULL;
SELECT 'AUDIT|' || count(*) FROM audit_events WHERE id > ${wm} AND action = 'MP_COVERAGE_CHECK' AND performed_by IS NULL;
SELECT 'FIN|' || (SELECT count(*) FROM financial_operation WHERE id IN (SELECT financial_operation_id FROM mp_reconciliation WHERE mp_financial_movement_id = ${MV}));
ROLLBACK;`);
  const get = (k) => out.split('\n').find((l) => l.startsWith(`${k}|`))?.slice(k.length + 1);
  const run1 = JSON.parse(get('RUN1'));
  const run2 = JSON.parse(get('RUN2'));
  check('M-4 (V-4 test branch) mp_v4_verified() redefined true inside a rolled-back transaction: the API APPROVAL with no report row → MISSING_IN_REPORT (exception, coverage window, no report source), audited once; rerun → missing_inserted 0 (Δ = 0); no financial write',
    run1.v4_verified === true && run1.missing_inserted >= 1 && get('MINE') === '1' && run2.missing_inserted === 0 && get('AUDIT') === '1' && get('FIN') === '3',
    out.replace(/\n/g, ' '));
  const defAfter = createHash('sha256').update(owner(`SELECT pg_get_functiondef('mp_v4_verified()'::regprocedure);`)).digest('hex');
  check('M-4 after ROLLBACK: mp_v4_verified() = false with its original definition; no MISSING_IN_REPORT row and no coverage audit persisted',
    owner('SELECT mp_v4_verified();') === 'f' && defAfter === defBefore
      && owner(`SELECT count(*) FROM mp_report_match WHERE outcome = 'MISSING_IN_REPORT';`) === '0'
      && owner(`SELECT count(*) FROM audit_events WHERE id > ${wm} AND action = 'MP_COVERAGE_CHECK';`) === '0');
}

section('3', 'final security check');
{
  const DEFINER_69 = ['assert_period_open', 'assign_flock_feed', 'assign_freight_to_purchase', 'cancel_order', 'cancel_supplier_instrument', 'clear_cheque',
    'close_feria_summary', 'close_flock', 'close_sales_session', 'current_app_role', 'deliver_order', 'deposit_cheque', 'endorse_cheque', 'issue_supplier_instrument', 'mark_supplier_instrument_debited',
    'mp_allocate_to_client', 'mp_apply_transition', 'mp_auto_allocate', 'mp_check_report_coverage', 'mp_claim_deliveries', 'mp_clear_attribution_flag',
    'mp_delivery_transition', 'mp_flag_for_attribution', 'mp_ingest_api_snapshot', 'mp_map_payer_to_client', 'mp_normalize_report_fallback', 'mp_normalize_source',
    'mp_reconcile_movement', 'mp_record_balance_check', 'mp_register_delivery', 'mp_request_refetch', 'mp_requeue_config_blocked', 'mp_resolve_chargeback_signal',
    'mp_resolve_match', 'mp_reverse_client_allocation', 'mp_unmap_payer', 'open_sales_session', 'pay_fiscal_obligation', 'pay_supplier', 'publish_feed_formula_version', 'receive_cheque',
    'rectify_classification', 'rectify_daily_production', 'rectify_delivered_order', 'rectify_feed_manufacturing', 'rectify_feria_closing', 'rectify_mortality', 'rectify_purchase',
    'register_bank_tax', 'register_classification', 'register_collection',
    'register_count_adjustment', 'register_daily_production', 'register_feed_inventory_count', 'register_feed_manufacturing', 'register_feed_movement',
    'register_fiscal_document', 'register_fiscal_obligation', 'register_flock', 'register_freight', 'register_management_event', 'register_mortality', 'register_purchase', 'register_purchase_with_fiscal_document',
    'register_session_cash_event', 'register_session_movement', 'reject_cheque', 'reject_supplier_instrument', 'transfer_between_accounts'];
  check('X-1 SECURITY DEFINER set = the exact 69-name literal (60 ADR-006 + 2 ADR-007 + ADR-011…016 RPCs 46–52)', owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`) === DEFINER_69.join(','));
  check('X-2 helpers / trigger functions stay SECURITY INVOKER and owner-only (8)', owner(`SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('mp_is_auto_applicable','mp_v4_verified','mp_parse_report_row','mp_claim_report_payment_fallback','mp_delivery_immutable_guard','mp_report_match_guard','mp_source_raw_guard','mp_source_insert_guard')
    AND NOT p.prosecdef AND NOT (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'));`) === '8');
  check('X-3 mp_v4_verified() = false', owner('SELECT mp_v4_verified();') === 'f');
  const r4 = SVC(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date) VALUES ('api_payment', 'S13M-x', '{}'::jsonb, NOW(), CURRENT_DATE);`, 'ROLLBACK');
  check('X-4 R4 trigger guard operative: a direct service_role api_payment insert → SOURCE_TYPE_NOT_INSERTABLE', !r4.ok && /SOURCE_TYPE_NOT_INSERTABLE/.test(r4.err));
  check('X-5 privilege perimeter unchanged: application-role grants on the MP tables and ADR-006 views are exactly the Step-9 / Step-10 sets',
    owner(`SELECT string_agg(c.relname || ':' || r.rolname || ':' || a.privilege_type, ',' ORDER BY c.relname, r.rolname, a.privilege_type)
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE c.relnamespace = 'public'::regnamespace AND (c.relname LIKE 'mp\\_%' OR c.relname LIKE 'report\\_mp\\_%') AND c.relkind IN ('r','v')
        AND r.rolname IN ('anon','authenticated','service_role');`) === ['mp_attribution_flag:authenticated:SELECT', 'mp_client_allocation:authenticated:SELECT',
      'mp_financial_movement:authenticated:SELECT', 'mp_financial_movement:service_role:SELECT', 'mp_payer_client_map:authenticated:SELECT',
      'mp_reconciliation:authenticated:SELECT', 'mp_reconciliation:service_role:SELECT', 'mp_report_match:authenticated:SELECT', 'mp_report_match:service_role:SELECT',
      'mp_source_record:authenticated:SELECT', 'mp_source_record:service_role:INSERT', 'mp_source_record:service_role:SELECT', 'mp_transition_identity:authenticated:SELECT',
      'mp_transition_identity:service_role:SELECT', 'mp_webhook_delivery:authenticated:SELECT', 'mp_webhook_delivery:service_role:SELECT',
      'report_mp_delivery_health:authenticated:SELECT', 'report_mp_movement_status:authenticated:SELECT', 'report_mp_receipt_status:authenticated:SELECT',
      'report_mp_report_exceptions:authenticated:SELECT'].join(','));
  const cmd = owner(`SELECT command FROM cron.job WHERE jobname = 'mp_worker_every_minute';`);
  const noVault = raw(cmd);
  check('X-6 scheduler fail-closed: exactly one Step-11 job; no Vault scheduler entry; its statement selects no row and queues no request',
    owner('SELECT count(*) FROM cron.job;') === '1' && owner(`SELECT count(*) FROM vault.secrets WHERE name IN ('mp_worker_url','mp_worker_invoke_secret');`) === '0'
      && noVault.ok && noVault.out === '');
  const anonKey = JSON.parse(spawnSync(SUPABASE, ['status', '-o', 'json'], { cwd: REPO, encoding: 'utf8' }).stdout || '{}').ANON_KEY ?? '';
  const r1 = await fetch('http://127.0.0.1:54321/rest/v1/rpc/http_post', { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, 'content-type': 'application/json' }, body: '{}' });
  const r2 = await fetch('http://127.0.0.1:54321/rest/v1/rpc/http_post', { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, 'content-type': 'application/json', 'content-profile': 'net' }, body: '{}' });
  await r1.text(); await r2.text();
  check('X-7 pg_net perimeter as accepted (N-2): net not exposed (404 / 406); no public wrapper of net / cron / vault; cron not usable by application roles',
    anonKey !== '' && r1.status === 404 && r2.status === 406 && owner(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ~* '\\m(net|cron|vault)\\.';`) === '0'
      && ['anon', 'authenticated', 'service_role'].every((r) => owner(`SELECT has_schema_privilege('${r}', 'cron', 'USAGE');`) === 'f'), `${r1.status} ${r2.status}`);
}

cleanup();
console.log(`\n  ══ ADR-006 MATRIX + SECURITY (STEP 13) RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail) console.log(failures.map((f) => `   - ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
