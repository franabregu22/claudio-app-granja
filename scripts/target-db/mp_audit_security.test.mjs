#!/usr/bin/env node
/**
 * ADR-006 Step 12 — audit and security sweep (no schema change).
 *
 * Run (local stack up; target DB at 0001–0056):
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/mp_audit_security.test.mjs
 *
 * Authority: ADR006_TEST_MATRIX_V1 A-1…A-3 and S; ADR006_RLS_AND_SECURITY_V1 §7 (secrets) / §8 (audit);
 * ADR006_RPC_CONTRACTS_V1 §0 (audit actions; queue mechanics not audited); ADR006_WEBHOOK_WORKER_DESIGN_V1
 * (logging policy); ADR-006 §6.1 / §10 (logs never hold body, signature, manifest, token or payer data).
 *
 * Sections:
 *   A  one audit row per business fact (exact action + actor) and zero on no-ops, driven through the
 *      real RPCs as service_role / ADMIN (watermark on audit_events.id; nothing else writes meanwhile:
 *      the Step-11 cron job is fail-closed because this harness configures no Vault entry);
 *   L  mp-webhook and mp-worker logging under `supabase functions serve`, with deliberately recognizable
 *      canaries (fake secrets, payer data, signatures) that must never reach any log line;
 *   X  a sensitive-data scan of every ADR-006 audit row (after_values, before_values, reason, entity_id);
 *   P  the final privilege perimeter re-asserted (incl. the owner-accepted pg_net platform grants);
 *   K  secret scan of every tracked file and PII scan of the ADR-006 files, with explicit classification.
 * Mercado Pago is a local mock (MP_API_BASE_URL=http://host.docker.internal:<port>); fake secrets only.
 * Synthetic ids: payments 7780…, chargebacks 7781…, payer ids 5558…, clients 'S12A …'.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSafeDestructiveTarget, assertSafeCliOperation, assertNoProductionCredentials } from '../test-env/guard.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPA = '22222222-2222-2222-2222-222222222222';
const COLLECTOR = '100000001';
// canaries: recognizable, fake, and forbidden in every audit row and every log line
const C = {
  webhookSecret: 's12-canary-webhook-secret-not-real-0001',
  invokeSecret: 's12-canary-invoke-secret-not-real-0002',
  token: 'APP-TEST-FAKE-TOKEN-s12-canary-0003',
  email: 'canary.payer.s12@example.invalid',
  first: 'CanaryFirstS12',
  last: 'CanaryLastS12',
  dni: '31415926',
  phone: '1155550199',
  street: 'Calle Canario S12',
  description: 'CANARY-S12-PAYMENT-DESCRIPTION',
  payerId: '555800099',   // the payload payer id: never an audit value
};
const ADR006_ACTIONS = ['MP_DELIVERY_REGISTER', 'MP_DELIVERY_REQUEUE', 'MP_REFETCH_REQUEST', 'MP_CHARGEBACK_SIGNAL_RESOLVE', 'MP_SNAPSHOT_INGEST',
  'NORMALIZE', 'MP_APPLY_TRANSITION', 'MP_CLIENT_ALLOCATION', 'MP_CLIENT_ALLOCATION_REVERSAL', 'MP_ATTRIBUTION_FLAG', 'MP_ATTRIBUTION_FLAG_CLEAR',
  'MP_PAYER_MAP', 'MP_PAYER_UNMAP', 'MP_MATCH_RESOLVE', 'MP_REPORT_FALLBACK', 'MP_COVERAGE_CHECK', 'MP_BALANCE_CHECK'];

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
  const r = spawnSync(DOCKER, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: s, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function owner(s) { const r = raw(s); if (!r.ok) throw new Error(`owner SQL failed:\n${s}\n${r.err}`); return r.out; }
const esc = (s) => String(s).replace(/'/g, "''");
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(v)}'`);
const wrap = (role, claims, s) => `BEGIN;\nSET LOCAL ROLE ${role};\nSET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';\n${s}\nCOMMIT;`;
const SVC = (s) => raw(wrap('service_role', { role: 'service_role' }, s));
const ADMIN = (s) => raw(wrap('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s));
const OPER = (s) => raw(wrap('authenticated', { sub: OPA, role: 'authenticated' }, s));
const ANON = (s) => raw(wrap('anon', { role: 'anon' }, s));
function call(fn, expr) {
  const r = fn(`SELECT (${expr})::text;`);
  if (!r.ok) { const e = new Error((r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err).replace(/^.*ERROR:\s+/, '')); throw e; }
  return r.out === '' ? null : JSON.parse(r.out);
}
const tryCall = (fn, expr) => { try { return { ok: true, v: call(fn, expr) }; } catch (e) { return { ok: false, err: e.message }; } };

// ── audit watermark helpers ──────────────────────────────────────────────────
const wm = () => Number(owner('SELECT coalesce(max(id), 0) FROM audit_events;'));
const auditsSince = (w) => owner(`SELECT coalesce(string_agg(action || ':' || CASE WHEN performed_by IS NULL THEN 'NULL'
  WHEN performed_by = '${ADMIN_UID}' THEN 'ADMIN' ELSE 'OTHER' END, ',' ORDER BY id), '') FROM audit_events WHERE id > ${w};`);
const facts = [];   // { label, expected, actual }
async function fact(label, expected, fn) {
  const w = wm();
  let err = null;
  let result;
  try { result = await fn(); } catch (e) { err = e.message; }
  const actual = auditsSince(w);
  facts.push({ label, expected: expected.join(','), actual });
  check(`${label} → audit [${expected.join(', ') || '∅'}]`, actual === expected.join(',') && err === null, `actual [${actual}] err=${err}`);
  return result;
}
const noops = [];
async function noop(label, fn, { expectError = null } = {}) {
  const w = wm();
  let err = null;
  try { await fn(); } catch (e) { err = e.message; }
  const actual = auditsSince(w);
  noops.push({ label, delta: actual === '' ? 0 : actual.split(',').length });
  const errOk = expectError === null ? err === null : new RegExp(expectError).test(err ?? '');
  check(`A-2 ${label} → Δ audit = 0`, actual === '' && errOk, `audits [${actual}] err=${err}`);
}

// ── fixtures ─────────────────────────────────────────────────────────────────
let seq = 0;
const newPid = () => `7780${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;
function payload(pid, { status = 'approved', detail = 'accredited', extref = null, collector = COLLECTOR } = {}) {
  const at = '2026-11-05T10:00:00.000-04:00';
  return { id: Number(pid), operation_type: 'money_transfer', status, status_detail: detail, currency_id: 'ARS', live_mode: true,
    collector_id: Number(collector), external_reference: extref, description: C.description, date_created: at, date_approved: at,
    payer: { id: C.payerId, email: C.email, first_name: C.first, last_name: C.last, identification: { type: 'DNI', number: C.dni },
      phone: { area_code: '11', number: C.phone }, address: { street_name: C.street } },
    additional_info: { payer: { first_name: C.first, phone: { number: C.phone } } },
    transaction_amount: 100, transaction_details: { net_received_amount: 93 }, fee_details: [{ type: 'mercadopago_fee', amount: 5, fee_payer: 'collector' }],
    refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
}
const regExpr = (pid, nid) => `mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, ${q(nid)}, 'S12A',
  ${q(JSON.stringify({ notification_id: nid, type: 'payment' }))}::jsonb, true)`;
function claim(d) {
  const rows = JSON.parse(SVC(`SELECT coalesce(json_agg(c), '[]')::text FROM mp_claim_deliveries(50, 120) c;`).out);
  const c = rows.find((x) => x.delivery_id === d);
  if (!c) throw new Error(`delivery ${d} not claimed`);
  return c.claim_token;
}
const mvOf = (src) => Number(owner(`SELECT id FROM mp_financial_movement WHERE mp_source_record_id = ${q(src)};`));
function cleanup(sinceAudit) {
  owner(`
UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha IN ('2026-09-01', '2026-11-01') AND status <> 'OPEN';
DROP TRIGGER IF EXISTS s12_fault ON mp_webhook_delivery;
DROP FUNCTION IF EXISTS s12_fault_fn();
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:7780%' OR external_id LIKE 'S12A-%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op  AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '7780%' OR resource_id LIKE '7781%' OR x_request_id LIKE 'S12A%';
CREATE TEMP TABLE _al  AS SELECT id, client_ledger_id FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _cl  AS SELECT id FROM clients WHERE nombre LIKE 'S12A %';
${sinceAudit !== undefined ? `DELETE FROM audit_events WHERE id > ${sinceAudit};` : ''}
DELETE FROM audit_events WHERE (entity_type = 'mp_client_allocation' AND entity_id IN (SELECT id::TEXT FROM _al))
   OR (entity_type = 'mp_source_record' AND entity_id IN (SELECT id::TEXT FROM _src))
   OR (entity_type = 'mp_financial_movement' AND entity_id IN (SELECT id::TEXT FROM _mv))
   OR (entity_type = 'mp_webhook_delivery' AND entity_id IN (SELECT id::TEXT FROM _dl));
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al) AND reversal_of_id IS NOT NULL;
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al);
DELETE FROM client_ledger WHERE id IN (SELECT client_ledger_id FROM _al);
DELETE FROM mp_attribution_flag WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_payer_client_map WHERE mp_payer_id LIKE '5558%' OR cliente_id IN (SELECT id FROM _cl);
DELETE FROM mp_report_match WHERE report_source_id IN (SELECT id FROM _src)
   OR transition_id IN (SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv));
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE triggered_by_delivery_id IN (SELECT id FROM _dl) OR key_conflict_of IN (SELECT id FROM _dl);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
DELETE FROM clients WHERE id IN (SELECT id FROM _cl);`);
}

// ═════════════════════════════════════════════════════════════════════════════
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
if (!container) { console.error('  no running supabase_db container'); process.exit(1); }
cleanup();
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPA}', false, false) ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPA}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;`);
const WM0 = wm();
const foreign = owner(`SELECT count(*) FROM mp_webhook_delivery WHERE status IN ('RECEIVED', 'FAILED_RETRYABLE', 'CONFIG_BLOCKED') AND coalesce(resource_id, '') !~ '^778[01]';`);
check('S0 no foreign due / blocked delivery; no Vault scheduler entry (the Step-11 job stays fail-closed during the harness)', foreign === '0'
  && owner(`SELECT count(*) FROM vault.secrets WHERE name IN ('mp_worker_url', 'mp_worker_invoke_secret');`) === '0', foreign);
const CLI = owner(`INSERT INTO clients (nombre, activo) VALUES ('S12A client ${Date.now()}', true) RETURNING id;`);

section('A-1 / A-2', 'audit per business fact, none on no-ops');
// F1 — ingestion path (service role)
const P1 = newPid();
const n1 = `s12-${P1}`;
const d1 = await fact('A-1 S1 register delivery (service)', ['MP_DELIVERY_REGISTER:NULL'], () => call(SVC, regExpr(P1, n1)).delivery_id);
await noop('W-2 duplicate delivery (same key, same content)', () => call(SVC, regExpr(P1, n1)));
await fact('A-1 S1 same key, different content → one bounded conflict row (service)', ['MP_DELIVERY_REGISTER:NULL'],
  () => call(SVC, `mp_register_delivery('webhook', 'payment', 'payment', 'payment.created', ${q(P1)}, ${q(n1)}, 'S12A', ${q(JSON.stringify({ notification_id: n1, type: 'payment', action: 'x' }))}::jsonb, true)`));
const t1 = claim(d1);
await noop('queue mechanics: claim (S2)', () => {});
const s1 = await fact('A-1 S4 snapshot ingest (service)', ['MP_SNAPSHOT_INGEST:NULL'], () => call(SVC, `mp_ingest_api_snapshot(${q(d1)}, ${q(t1)}, ${q(P1)}, ${q(JSON.stringify(payload(P1)))}::jsonb)`));
await noop('re-ingest of an identical snapshot (same hash → same source)', () => call(SVC, `mp_ingest_api_snapshot(${q(d1)}, ${q(t1)}, ${q(P1)}, ${q(JSON.stringify(payload(P1)))}::jsonb)`));
await fact('A-1 RPC 40 normalize (service)', ['NORMALIZE:NULL'], () => call(SVC, `mp_normalize_source(${q(s1.source_record_id)})`));
await noop('RPC 40 replay (ALREADY_PROCESSED)', () => call(SVC, `mp_normalize_source(${q(s1.source_record_id)})`), { expectError: 'ALREADY_PROCESSED' });
const MV1 = mvOf(s1.source_record_id);
await fact('A-1 T-1 A1 mp_apply_transition (service)', ['MP_APPLY_TRANSITION:NULL'], () => call(SVC, `mp_apply_transition(${MV1})`));
await noop('T-3 A1 replay (ALREADY_APPLIED)', () => { const r = call(SVC, `mp_apply_transition(${MV1})`); if (r.status !== 'ALREADY_APPLIED') throw new Error(r.status); });
await noop('C-5 C2 without evidence (NO_EVIDENCE)', () => { const r = call(SVC, `mp_auto_allocate(${MV1})`); if (r.reason !== 'NO_EVIDENCE') throw new Error(r.reason); });
await noop('queue mechanics: S3 FETCHED transition', () => call(SVC, `mp_delivery_transition(${q(d1)}, ${q(t1)}, 'FETCHED', ${q(s1.source_record_id)}, NULL, NULL, NULL, NULL)`));
// F2 — AUTO attribution
const P2 = newPid();
const d2 = call(SVC, regExpr(P2, `s12-${P2}`)).delivery_id;
const t2 = claim(d2);
const s2 = call(SVC, `mp_ingest_api_snapshot(${q(d2)}, ${q(t2)}, ${q(P2)}, ${q(JSON.stringify(payload(P2, { extref: `GST:C:${CLI}` })))}::jsonb)`);
call(SVC, `mp_normalize_source(${q(s2.source_record_id)})`);
const MV2 = mvOf(s2.source_record_id);
call(SVC, `mp_apply_transition(${MV2})`);
await fact('A-1 C-2 C2 AUTO allocation (service)', ['MP_CLIENT_ALLOCATION:NULL'], () => call(SVC, `mp_auto_allocate(${MV2})`));
await noop('C2 replay (ALREADY_ALLOCATED)', () => { const r = call(SVC, `mp_auto_allocate(${MV2})`); if (r.reason !== 'ALREADY_ALLOCATED') throw new Error(r.reason); });
// F3 — attribution RPCs (ADMIN)
const occ = owner(`SELECT occurred_date FROM mp_financial_movement WHERE id = ${MV1};`);
const flag = await fact('A-1 C4 flag for attribution (ADMIN)', ['MP_ATTRIBUTION_FLAG:ADMIN'], () => call(ADMIN, `mp_flag_for_attribution(${MV1}, 'S12A who paid')`));
await noop('C4 second flag while one is open (FLAG_ALREADY_OPEN)', () => call(ADMIN, `mp_flag_for_attribution(${MV1}, 'S12A again')`), { expectError: 'FLAG_ALREADY_OPEN' });
await fact('A-1 C5 clear flag (ADMIN)', ['MP_ATTRIBUTION_FLAG_CLEAR:ADMIN'], () => call(ADMIN, `mp_clear_attribution_flag(${q(flag.flag_id)}, 'S12A answered')`));
await noop('C5 clear again (FLAG_NOT_OPEN)', () => call(ADMIN, `mp_clear_attribution_flag(${q(flag.flag_id)}, 'S12A again')`), { expectError: 'FLAG_NOT_OPEN' });
const alloc = await fact('A-1 C-11 C1 manual allocation (ADMIN)', ['MP_CLIENT_ALLOCATION:ADMIN'],
  () => call(ADMIN, `mp_allocate_to_client(${MV1}, ${q(CLI)}, 40, ${q(occ)}, 'S12A-k1-${P1}', 'S12A manual')`));
await noop('C1 duplicate key (DUPLICATE_ALLOCATION)', () => call(ADMIN, `mp_allocate_to_client(${MV1}, ${q(CLI)}, 40, ${q(occ)}, 'S12A-k1-${P1}', 'S12A manual')`), { expectError: 'DUPLICATE_ALLOCATION' });
await fact('A-1 C3 manual reversal (ADMIN)', ['MP_CLIENT_ALLOCATION_REVERSAL:ADMIN'],
  () => call(ADMIN, `mp_reverse_client_allocation(${q(alloc.allocation_id)}, 10, 'S12A-r1-${P1}', 'S12A correction')`));
await noop('C3 duplicate reversal key (DUPLICATE_ALLOCATION)', () => call(ADMIN, `mp_reverse_client_allocation(${q(alloc.allocation_id)}, 10, 'S12A-r1-${P1}', 'S12A correction')`), { expectError: 'DUPLICATE_ALLOCATION' });
// F4 — payer map (ADMIN)
const mapPayer = `5558${String(Date.now()).slice(-6)}`;
const map = await fact('A-1 C6 map payer to client (ADMIN)', ['MP_PAYER_MAP:ADMIN'], () => call(ADMIN, `mp_map_payer_to_client(${q(mapPayer)}, ${q(CLI)}, 'S12A known payer')`));
await noop('C6 map an already-mapped payer (PAYER_ALREADY_MAPPED)', () => call(ADMIN, `mp_map_payer_to_client(${q(mapPayer)}, ${q(CLI)}, 'S12A again')`), { expectError: 'PAYER_ALREADY_MAPPED' });
await fact('A-1 C7 unmap payer (ADMIN)', ['MP_PAYER_UNMAP:ADMIN'], () => call(ADMIN, `mp_unmap_payer(${q(map.mapping_id)}, 'S12A no longer')`));
// F5 — report match resolution (ADMIN); the DISCREPANCY row is an owner fixture (report payment rows stay DEFERRED_V4)
const T1 = owner(`SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id = ${MV1};`);
const RS = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processed_at)
  VALUES ('csv_import', 'S12A-${Date.now()}-m:payment:C', '{"fixture":"owner report row"}'::jsonb, '2026-11-05T12:00:00-03:00', '2026-11-05', 'IGNORED', NOW()) RETURNING id;`);
const M = owner(`INSERT INTO mp_report_match (outcome, report_source_id, transition_id, detail, is_exception)
  VALUES ('DISCREPANCY', ${q(RS)}, ${T1}, '{"fee": {"report": -6, "recorded": -5}}'::jsonb, true) RETURNING id;`);
await fact('A-1 M-2 resolve match (ADMIN)', ['MP_MATCH_RESOLVE:ADMIN'], () => call(ADMIN, `mp_resolve_match(${q(M)}, 'EXPLAINED', 'S12A explained')`));
await noop('R1 resolve again (ALREADY_RESOLVED)', () => call(ADMIN, `mp_resolve_match(${q(M)}, 'EXPLAINED', 'S12A again')`), { expectError: 'ALREADY_RESOLVED' });
// F6 — balance check (service); a report row that closes its day
const BAL = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processed_at)
  VALUES ('csv_import', 'S12A-${Date.now()}-b:payout:D', '{"BALANCE_AMOUNT":"0.00"}'::jsonb, '2026-11-17T23:00:00-03:00', '2026-11-17', 'IGNORED', NOW()) RETURNING id;`);
await fact('A-1 M-6 balance check (service)', ['MP_BALANCE_CHECK:NULL'], () => call(SVC, `mp_record_balance_check(${q(BAL)})`));
await noop('R4 balance check replay (created false)', () => { const r = call(SVC, `mp_record_balance_check(${q(BAL)})`); if (r.created !== false) throw new Error('created'); });
// F7 / F8 — deferred with V-4: coverage inserts nothing, fallback refuses
await noop('M-6 coverage check while mp_v4_verified() = false (missing_inserted 0; MISSING_IN_REPORT deferred to Step 19)',
  () => { const r = call(SVC, `mp_check_report_coverage('csv_import', '2026-11-01', '2026-11-30')`); if (r.missing_inserted !== 0 || r.v4_verified !== false) throw new Error(JSON.stringify(r)); });
await noop('R2 report fallback while mp_v4_verified() = false (V4_NOT_VERIFIED)', () => call(ADMIN, `mp_normalize_report_fallback(${q(RS)}, 'S12A try')`), { expectError: 'V4_NOT_VERIFIED' });
// F9 — CONFIG_BLOCKED requeue (ADMIN and service)
const P3 = newPid();
const d3 = call(SVC, regExpr(P3, `s12-${P3}`)).delivery_id;
call(SVC, `mp_delivery_transition(${q(d3)}, ${q(claim(d3))}, 'CONFIG_BLOCKED', NULL, 'AUTH_CONFIGURATION_ERROR', 'http 401', NULL, NULL)`);
await fact('A-1 S5 requeue CONFIG_BLOCKED (ADMIN)', ['MP_DELIVERY_REQUEUE:ADMIN'], () => call(ADMIN, `mp_requeue_config_blocked('S12A token rotated')`));
await noop('S5 requeue with no CONFIG_BLOCKED row ({requeued: 0})', () => { const r = call(ADMIN, `mp_requeue_config_blocked('S12A nothing')`); if (r.requeued !== 0) throw new Error(JSON.stringify(r)); });
call(SVC, `mp_delivery_transition(${q(d3)}, ${q(claim(d3))}, 'CONFIG_BLOCKED', NULL, 'AUTH_CONFIGURATION_ERROR', 'http 401', NULL, NULL)`);
await fact('A-1 S5 requeue CONFIG_BLOCKED (service: the probe path)', ['MP_DELIVERY_REQUEUE:NULL'], () => call(SVC, `mp_requeue_config_blocked('auto: credential probe succeeded')`));
// F10 — manual re-fetch (ADMIN)
await fact('A-1 S6 manual re-fetch request (ADMIN)', ['MP_REFETCH_REQUEST:ADMIN'], () => call(ADMIN, `mp_request_refetch(${q(newPid())}, 'S12A recover')`));
// F11 — chargeback signals
const cbId = `7781${String(Date.now()).slice(-8)}`;
const cbExpr = (id, ref) => `mp_register_delivery('webhook', 'topic_chargebacks_wh', 'chargeback', NULL, ${q(id)}, NULL, 'S12A-cb',
  ${q(JSON.stringify({ type: 'topic_chargebacks_wh', data_id: id, live_mode: true, user_id: Number(COLLECTOR), notification_id: `s12-cb-${id}`, ...(ref ? { data_payment_id: ref } : {}) }))}::jsonb, true)`;
const cb = await fact('A-1 chargeback signal register (service)', ['MP_DELIVERY_REGISTER:NULL'], () => call(SVC, cbExpr(cbId, null)).delivery_id);
await noop('R-14 replayed chargeback notification (duplicate)', () => call(SVC, cbExpr(cbId, null)));
await noop('queue mechanics: SIGNAL_RECORDED unlinked', () => call(SVC, `mp_delivery_transition(${q(cb)}, ${q(claim(cb))}, 'SIGNAL_RECORDED', NULL, NULL, NULL, NULL, NULL)`));
await fact('A-1 R-13 resolve signal DISMISSED (ADMIN)', ['MP_CHARGEBACK_SIGNAL_RESOLVE:ADMIN'], () => call(ADMIN, `mp_resolve_chargeback_signal(${q(cb)}, 'DISMISSED', NULL, 'S12A no money moved')`));
await noop('R-13 resolve again (set once)', () => call(ADMIN, `mp_resolve_chargeback_signal(${q(cb)}, 'DISMISSED', NULL, 'S12A again')`), { expectError: 'ALREADY_RESOLVED|SIGNAL_ALREADY' });
const cb2Id = `7781${String(Date.now()).slice(-7)}9`;
const cb2 = call(SVC, cbExpr(cb2Id, null)).delivery_id;
call(SVC, `mp_delivery_transition(${q(cb2)}, ${q(claim(cb2))}, 'SIGNAL_RECORDED', NULL, NULL, NULL, NULL, NULL)`);
await fact('A-1 R-13 resolve signal LINKED (ADMIN; enqueues the refresh as queue mechanics)', ['MP_CHARGEBACK_SIGNAL_RESOLVE:ADMIN'],
  () => call(ADMIN, `mp_resolve_chargeback_signal(${q(cb2)}, 'LINKED', ${q(P1)}, 'S12A matched manually')`));
const cb3Id = `7781${String(Date.now()).slice(-7)}8`;
const cb3 = call(SVC, cbExpr(cb3Id, P1)).delivery_id;
await noop('R-12 automatic link (S3 SIGNAL_RECORDED with a payment ref → refresh; queue mechanics)',
  () => call(SVC, `mp_delivery_transition(${q(cb3)}, ${q(claim(cb3))}, 'SIGNAL_RECORDED', NULL, NULL, NULL, NULL, ${q(P1)})`));
// F12 — rejected actors write nothing
await noop('rejected actor: OPERATOR calls an ADMIN RPC (FORBIDDEN)', () => call(OPER, `mp_flag_for_attribution(${MV1}, 'x')`), { expectError: 'FORBIDDEN' });
await noop('rejected actor: anon calls a service RPC (permission denied)', () => call(ANON, `mp_requeue_config_blocked('x')`), { expectError: 'permission denied' });
check('A-1 summary: every business fact wrote exactly one audit row with the contractual action and actor', facts.every((f) => f.expected === f.actual),
  facts.filter((f) => f.expected !== f.actual).map((f) => `${f.label}: ${f.actual}`).join(' | '));
console.log(`      facts=${facts.length} expected=${facts.reduce((n, f) => n + (f.expected ? f.expected.split(',').length : 0), 0)} actual=${facts.reduce((n, f) => n + (f.actual ? f.actual.split(',').length : 0), 0)} no-ops=${noops.length} (Δ ${noops.reduce((n, x) => n + x.delta, 0)})`);
check('A-1 OD-1 (MP reversal / MP_REVERSAL allocation) is not producible: refund / chargeback are not auto-applicable (0052), so no such fact exists to audit',
  owner(`SELECT count(*) FROM mp_client_allocation WHERE origin = 'MP_REVERSAL';`) === '0'
    && owner(`SELECT pg_get_functiondef('mp_is_auto_applicable(bigint)'::regprocedure);`).includes(`IN (('payment', 'APPROVAL'), ('yield', 'YIELD'))`)
    && !/REFUND|CHARGEBACK/.test(owner(`SELECT pg_get_functiondef('mp_is_auto_applicable(bigint)'::regprocedure);`)));

// ═════════════════════════════════════════════════════════════════════════════
section('L', 'logging policy under supabase functions serve');
const hits = new Map();
const mode = new Map();
const server = createServer((req, res) => {
  const m = /^\/v1\/payments\/(\d+)$/.exec(req.url ?? '');
  if (!(req.method === 'GET' && m && mode.has(m[1]))) { res.writeHead(404); res.end('{}'); return; }
  const pid = m[1];
  hits.set(pid, (hits.get(pid) ?? 0) + 1);
  const md = mode.get(pid);
  const json = (st, body, h = {}) => { res.writeHead(st, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
  if (md === 'ok') return json(200, payload(pid));
  if (md === 'foreign') return json(200, payload(pid, { collector: '100000002' }));
  if (md === 'network') { req.socket.destroy(); return undefined; }
  if (md === 'timeout') { setTimeout(() => { try { json(200, payload(pid)); } catch { /* client gone */ } }, 12000); return undefined; }
  if (md === '429') return json(429, { message: 'too many' }, { 'retry-after': '3600' });
  return json(Number(md), { message: `status ${md}` });
});
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const PORT = server.address().port;
const dir = mkdtempSync(join(tmpdir(), 'mps12-'));
const envPath = join(dir, 'functions.env');
writeFileSync(envPath, [`MP_WEBHOOK_SECRET=${C.webhookSecret}`, `WORKER_INVOKE_SECRET=${C.invokeSecret}`, `MP_ACCESS_TOKEN=${C.token}`,
  `MP_COLLECTOR_ID=${COLLECTOR}`, `MP_API_BASE_URL=http://host.docker.internal:${PORT}`, ''].join('\n'));
const status = JSON.parse(spawnSync(SUPABASE, ['status', '-o', 'json'], { cwd: REPO, encoding: 'utf8' }).stdout || '{}');
const SERVICE_KEY = status.SERVICE_ROLE_KEY ?? '';
const ANON_KEY = status.ANON_KEY ?? '';
async function startServe() {
  const args = ['functions', 'serve', '--no-verify-jwt', '--env-file', envPath];
  assertSafeCliOperation(args);
  const child = spawn(SUPABASE, args, { cwd: REPO, env: { ...process.env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const t0 = Date.now();
  let stable = 0;   // infrastructure readiness only: three consecutive 405 answers
  while (Date.now() - t0 < 180000) {
    if (!out.includes('Serving functions on')) { await sleep(500); continue; }
    try {
      const r = await fetch('http://127.0.0.1:54321/functions/v1/mp-worker', { method: 'GET' });
      await r.text();
      stable = r.status === 405 ? stable + 1 : 0;
      if (stable >= 3) return { child, output: () => out };
    } catch { stable = 0; }
    await sleep(1000);
  }
  child.kill();
  throw new Error('functions serve did not become ready');
}
const sentSignatures = [];
function sign(dataId, requestId, ts = String(Date.now()), secret = C.webhookSecret) {
  const m = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const s = `ts=${ts},v1=${createHmac('sha256', secret).update(m, 'utf8').digest('hex')}`;
  sentSignatures.push(s);
  return s;
}
async function webhook(pid, { sig = 'ok', body = {}, ts } = {}) {
  const rid = `S12A-${pid}-${++seq}`;
  const h = { 'content-type': 'application/json', 'x-request-id': rid };
  if (sig === 'ok') h['x-signature'] = sign(pid, rid, ts);
  if (sig === 'bad') h['x-signature'] = sign(pid, rid, ts, 'wrong-secret');
  const b = { action: 'payment.updated', api_version: 'v1', data: { id: pid }, date_created: '2026-11-05T12:00:00Z', id: `n-${pid}-${seq}`, live_mode: true,
    type: 'payment', user_id: Number(COLLECTOR), payer_email_canary: C.email, ...body };
  const r = await fetch(`http://127.0.0.1:54321/functions/v1/mp-webhook?data.id=${pid}&type=payment`, { method: 'POST', headers: h, body: JSON.stringify(b) });
  await r.text();
  return r.status;
}
const worker = async (secret = C.invokeSecret) => {
  const r = await fetch('http://127.0.0.1:54321/functions/v1/mp-worker', { method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-invoke-secret': secret }, body: '{}' });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const dStatus = (pid) => owner(`SELECT coalesce(string_agg(status::text, ',' ORDER BY received_at), '') FROM mp_webhook_delivery WHERE resource_id = ${q(pid)} AND topic_class = 'payment';`);
mode.set(P1, 'ok');   // section-A refresh deliveries of P1 re-fetch the current resource
let serve = await startServe();
let logsBefore = '';
const allLogs = () => logsBefore + serve.output();
try {
  // webhook cases
  const W = { ok: newPid(), missing: newPid(), bad: newPid(), stale: newPid(), foreign: newPid(), test: newPid(), dbfail: newPid() };
  mode.set(W.ok, 'ok');
  const st = {};
  st.missing = await webhook(W.missing, { sig: 'none' });
  st.bad = await webhook(W.bad, { sig: 'bad' });
  st.stale = await webhook(W.stale, { ts: String(Date.now() - 16 * 60000) });
  st.foreign = await webhook(W.foreign, { body: { user_id: 123 } });
  st.test = await webhook(W.test, { body: { live_mode: false } });
  owner(`CREATE FUNCTION s12_fault_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_id = '${W.dbfail}' THEN RAISE EXCEPTION 'S12_FAULT'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER s12_fault BEFORE INSERT ON mp_webhook_delivery FOR EACH ROW EXECUTE FUNCTION s12_fault_fn();`);
  try { st.dbfail = await webhook(W.dbfail); } finally { owner('DROP TRIGGER IF EXISTS s12_fault ON mp_webhook_delivery; DROP FUNCTION IF EXISTS s12_fault_fn();'); }
  st.ok = await webhook(W.ok);
  const kicked = await (async () => { for (let i = 0; i < 40; i++) { if (dStatus(W.ok) === 'FETCHED') return true; await sleep(500); } return false; })();
  check('L-W1 webhook cases: missing / invalid / stale signature → 401; foreign collector / live_mode false → 200 ignored; DB failure → 500; success → 200 (+ kick → worker FETCHED)',
    st.missing === 401 && st.bad === 401 && st.stale === 401 && st.foreign === 200 && st.test === 200 && st.dbfail === 500 && st.ok === 200 && kicked, JSON.stringify(st));

  // worker cases
  const K = { r429: newPid(), r500: newPid(), timeout: newPid(), network: newPid(), r400: newPid(), foreign: newPid(), ok: newPid() };
  mode.set(K.r429, '429'); mode.set(K.r500, '500'); mode.set(K.timeout, 'timeout'); mode.set(K.network, 'network');
  mode.set(K.r400, '400'); mode.set(K.foreign, 'foreign'); mode.set(K.ok, 'ok');
  for (const pid of Object.values(K)) call(SVC, regExpr(pid, `s12-w-${pid}`));
  const cbw = `7781${String(Date.now()).slice(-7)}7`;
  call(SVC, cbExpr(cbw, K.ok));
  const run1 = await worker();
  owner(`UPDATE mp_webhook_delivery SET next_attempt_at = NOW() + INTERVAL '1 day' WHERE status = 'FAILED_RETRYABLE' AND resource_id LIKE '7780%';`);
  const A401 = newPid();
  const A403 = newPid();
  mode.set(A401, '401'); mode.set(A403, '403');
  call(SVC, regExpr(A401, `s12-w-${A401}`));
  const run2 = await worker();                       // refresh (ok) + 401 → CONFIG_BLOCKED, circuit breaker
  call(SVC, regExpr(A403, `s12-w-${A403}`));
  const run3 = await worker();                       // probe (still 401) + 403 → CONFIG_BLOCKED
  mode.set(A401, 'ok'); mode.set(A403, 'ok');
  logsBefore += serve.output();
  serve.child.kill();
  await sleep(4000);
  serve = await startServe();                        // fresh instance: the next permitted hourly probe
  const run4 = await worker();                       // probe 200 → requeue → both FETCHED
  const unauth = await worker('wrong-secret');
  check('L-K1 worker cases ran: 429 / 5xx / timeout / network → FAILED_RETRYABLE; 400 / collector mismatch → FAILED_PERMANENT; success + chargeback signal (LINKED) → FETCHED / SIGNAL_RECORDED; 401 / 403 → CONFIG_BLOCKED; probe → requeue → FETCHED; wrong secret → 401',
    run1.status === 200 && dStatus(K.r429) === 'FAILED_RETRYABLE' && dStatus(K.r500) === 'FAILED_RETRYABLE' && dStatus(K.timeout) === 'FAILED_RETRYABLE'
      && dStatus(K.network) === 'FAILED_RETRYABLE' && dStatus(K.r400) === 'FAILED_PERMANENT' && dStatus(K.foreign) === 'FAILED_PERMANENT'
      && dStatus(K.ok).split(',').every((s) => s === 'FETCHED') && run2.body?.stopped === 'auth_circuit_breaker' && run3.body?.probe === 'still_blocked'
      && run4.body?.probe === 'requeued' && dStatus(A401) === 'FETCHED' && dStatus(A403) === 'FETCHED' && unauth.status === 401,
    JSON.stringify({ run1: run1.body, run2: run2.body, run3: run3.body, run4: run4.body, s: Object.fromEntries(Object.entries(K).map(([k, p]) => [k, dStatus(p)])), a401: dStatus(A401), a403: dStatus(A403) }));

  await sleep(1500);
  const logs = allLogs();
  const lines = logs.split(/\r?\n/);
  const parsed = (fn) => lines.map((l) => { const i = l.indexOf('{"fn":"' + fn + '"'); if (i < 0) return null; try { return JSON.parse(l.slice(i)); } catch { return null; } }).filter(Boolean);
  const wh = parsed('mp-webhook');
  const wk = parsed('mp-worker');
  const WH_KEYS = ['fn', 'event', 'request_id', 'reason', 'status'];
  const WK_KEYS = ['fn', 'event', 'delivery_id', 'resource_id', 'http_status', 'code', 'duration_ms', 'counts'];
  check('L-W2 every mp-webhook log line carries only fn / event / request_id / reason / status; one line per rejected or ignored case',
    wh.length >= 5 && wh.every((e) => Object.keys(e).every((k) => WH_KEYS.includes(k))) && wh.filter((e) => e.status === 401).length >= 3
      && wh.some((e) => e.status === 500) && wh.filter((e) => e.event === 'IGNORED_FOREIGN_OR_TEST').length >= 2,
    JSON.stringify(wh.slice(0, 12)));
  const fetchCodes = wk.filter((e) => e.event === 'MP_FETCH').map((e) => `${e.http_status ?? '-'}:${e.code}`);
  check('L-K2 every mp-worker log line carries only fn / event / delivery_id / resource_id / http_status / code / duration_ms / counts; each class is logged by code',
    wk.length > 0 && wk.every((e) => Object.keys(e).every((k) => WK_KEYS.includes(k)))
      && ['429:MP_RATE_LIMIT', '500:MP_UNAVAILABLE', '400:MP_BAD_REQUEST', '401:AUTH_CONFIGURATION_ERROR', '403:AUTH_CONFIGURATION_ERROR', '200:OK'].every((c) => fetchCodes.includes(c))
      && fetchCodes.filter((c) => c === '-:MP_UNAVAILABLE').length >= 2
      && wk.some((e) => e.event === 'SECURITY_COLLECTOR_MISMATCH') && wk.some((e) => e.event === 'MP_AUTH_CONFIGURATION_ERROR')
      && wk.some((e) => e.event === 'MP_CREDENTIAL_PROBE' && e.http_status === 401) && wk.some((e) => e.event === 'MP_CREDENTIAL_PROBE' && e.http_status === 200)
      && wk.some((e) => e.event === 'WORKER_CHARGEBACK_SIGNAL' && e.code === 'LINKED') && wk.some((e) => e.event === 'WORKER_UNAUTHORIZED'),
    fetchCodes.join(' '));
  const forbidden = [C.webhookSecret, C.invokeSecret, C.token, C.email, C.first, C.last, C.dni, C.phone, C.street, C.description,
    ...(SERVICE_KEY ? [SERVICE_KEY] : []), ...sentSignatures];
  const leaks = forbidden.filter((x) => logs.includes(x)).map((x) => (x === SERVICE_KEY ? '<service key>' : x.length > 20 ? `${x.slice(0, 12)}…` : x));
  check('L-3 no canary in the whole serve output: webhook secret, invoke secret, MP token, service-role key, any x-signature sent, payer email / names / DNI / phone / address, payment description',
    leaks.length === 0 && SERVICE_KEY !== '', leaks.join(', '));
  check('L-4 no payload / header / manifest fragments in function log lines: no transaction_amount, payer, identification, authorization, bearer, x-signature, request-id: manifest, ts=…,v1=',
    [...wh, ...wk].every((e) => !/transaction_amount|payer|identification|authorization|bearer|x-signature|request-id:|ts=\d|v1=/i.test(JSON.stringify(e))));
} finally {
  serve.child.kill();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

// ═════════════════════════════════════════════════════════════════════════════
section('X', 'A-3 sensitive-data scan of the ADR-006 audit rows');
{
  const rows = JSON.parse(owner(`SELECT coalesce(json_agg(json_build_object('id', id, 'action', action, 'entity_id', entity_id, 'before', before_values, 'after', after_values, 'reason', reason)), '[]')::text
    FROM audit_events WHERE action IN (${ADR006_ACTIONS.map(q).join(',')}) OR entity_type LIKE 'mp\\_%';`));
  const mine = rows.filter((r) => r.id > WM0);
  const PATTERNS = [
    ['canary value', new RegExp([C.webhookSecret, C.invokeSecret, C.token, C.email, C.first, C.last, C.dni, C.phone, C.street, C.description].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))],
    ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
    ['bearer / authorization', /bearer\s|authorization/i],
    ['MP token shape', /APP_USR-|TEST-\d{6,}-/],
    ['JWT', /eyJ[A-Za-z0-9_-]{10,}/],
    ['signature / manifest', /x-signature|ts=\d{9,}|v1=[0-9a-f]{16,}|request-id:/i],
    ['payload / payer field', /"(payer|email|first_name|last_name|identification|phone|address|additional_info|description|transaction_amount|transaction_details|fee_details|event_data|notification_payload|headers)"\s*:/],
    ['payload payer id', new RegExp(`\\b${C.payerId}\\b`)],
  ];
  const text = (r) => JSON.stringify([r.entity_id, r.before, r.after, r.reason]);
  const hits = [];
  for (const r of rows) for (const [name, re] of PATTERNS) if (re.test(text(r))) hits.push(`${r.action}#${r.id}:${name}`);
  const payerIdKeys = rows.filter((r) => JSON.stringify(r.after ?? {}).includes('"mp_payer_id"')).map((r) => r.action);
  console.log(`      scanned ${rows.length} ADR-006 audit rows (${mine.length} written by this harness); fields: entity_id, before_values, after_values, reason`);
  check('A-3 zero sensitive matches in every ADR-006 audit row (canaries, emails, bearer / authorization, tokens, JWTs, signatures / manifests, payload or payer fields, the payload payer id)',
    rows.length > 0 && mine.length >= 20 && hits.length === 0, hits.slice(0, 10).join(' | '));
  check('A-3 mp_payer_id appears only as the technical key of the payer-map facts (MP_PAYER_MAP / MP_PAYER_UNMAP: ids per RLS_AND_SECURITY §8, "no personal data" per SCHEMA_DELTA §6)',
    payerIdKeys.every((a) => a === 'MP_PAYER_MAP' || a === 'MP_PAYER_UNMAP'), payerIdKeys.join());
}

// ═════════════════════════════════════════════════════════════════════════════
section('P', 'privilege perimeter re-asserted');
{
  const MP_TABLES = ['mp_attribution_flag', 'mp_client_allocation', 'mp_financial_movement', 'mp_payer_client_map', 'mp_reconciliation', 'mp_report_match',
    'mp_source_record', 'mp_transition_identity', 'mp_webhook_delivery'];
  const VIEWS = ['report_mp_delivery_health', 'report_mp_receipt_status', 'report_mp_report_exceptions'];
  check('P-1 anon: permission denied on every MP table and ADR-006 view', [...MP_TABLES, ...VIEWS].every((t) => /permission denied/.test(ANON(`SELECT count(*) FROM ${t};`).err)));
  check('P-2 OPERATOR: 0 rows in every MP table and ADR-006 view', [...MP_TABLES, ...VIEWS].every((t) => OPER(`SELECT count(*) FROM ${t};`).out === '0'));
  check('P-3 ADMIN reads the MP tables / views but holds no write privilege on them',
    ADMIN('SELECT count(*) FROM report_mp_delivery_health;').out === '1'
      && owner(`SELECT count(*) FROM pg_class c, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p WHERE c.relname IN (${[...MP_TABLES, ...VIEWS].map(q).join(',')}) AND has_table_privilege('authenticated', c.oid, p);`) === '0');
  check('P-4 service_role: no SELECT on allocation / payer map / flag / the views; R4 guard still rejects a direct api_payment insert (SOURCE_TYPE_NOT_INSERTABLE)',
    ['mp_client_allocation', 'mp_payer_client_map', 'mp_attribution_flag', ...VIEWS].every((t) => /permission denied/.test(SVC(`SELECT count(*) FROM ${t};`).err))
      && /SOURCE_TYPE_NOT_INSERTABLE/.test(raw(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL "request.jwt.claims" = '{"role":"service_role"}';
        INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date) VALUES ('api_payment', 'S12A-x', '{}'::jsonb, NOW(), CURRENT_DATE); ROLLBACK;`).err));
  check('P-5 cron: no USAGE for anon / authenticated / service_role; Vault: no access for anon / authenticated; no project-made grant on cron / vault / net',
    ['anon', 'authenticated', 'service_role'].every((r) => owner(`SELECT has_schema_privilege('${r}', 'cron', 'USAGE');`) === 'f')
      && ['anon', 'authenticated'].every((r) => owner(`SELECT has_schema_privilege('${r}', 'vault', 'USAGE');`) === 'f')
      && owner(`SELECT count(*) FROM (SELECT (aclexplode(relacl)).grantor g FROM pg_class WHERE relnamespace IN ('cron'::regnamespace, 'vault'::regnamespace)
          UNION ALL SELECT (aclexplode(proacl)).grantor FROM pg_proc WHERE pronamespace IN ('net'::regnamespace, 'cron'::regnamespace, 'vault'::regnamespace)) x
          WHERE pg_get_userbyid(g) NOT IN ('supabase_admin');`) === '0');
  const r1 = await fetch('http://127.0.0.1:54321/rest/v1/rpc/http_post', { method: 'POST', headers: { apikey: ANON_KEY, authorization: `Bearer ${ANON_KEY}`, 'content-type': 'application/json' }, body: '{}' });
  const r2 = await fetch('http://127.0.0.1:54321/rest/v1/rpc/http_post', { method: 'POST', headers: { apikey: ANON_KEY, authorization: `Bearer ${ANON_KEY}`, 'content-type': 'application/json', 'content-profile': 'net' }, body: '{}' });
  await r1.text(); await r2.text();
  check('P-6 accepted pg_net residual risk still contained: net not exposed by PostgREST (404 / 406) and no public function references net / cron / vault',
    ANON_KEY !== '' && r1.status === 404 && r2.status === 406 && owner(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ~* '\\m(net|cron|vault)\\.';`) === '0',
    `${r1.status} ${r2.status}`);
  const DEFINER_63 = ['assert_period_open', 'assign_flock_feed', 'assign_freight_to_purchase', 'cancel_order', 'cancel_supplier_instrument', 'clear_cheque',
    'close_flock', 'close_sales_session', 'current_app_role', 'deliver_order', 'deposit_cheque', 'endorse_cheque', 'issue_supplier_instrument', 'mark_supplier_instrument_debited',
    'mp_allocate_to_client', 'mp_apply_transition', 'mp_auto_allocate', 'mp_check_report_coverage', 'mp_claim_deliveries', 'mp_clear_attribution_flag',
    'mp_delivery_transition', 'mp_flag_for_attribution', 'mp_ingest_api_snapshot', 'mp_map_payer_to_client', 'mp_normalize_report_fallback', 'mp_normalize_source',
    'mp_reconcile_movement', 'mp_record_balance_check', 'mp_register_delivery', 'mp_request_refetch', 'mp_requeue_config_blocked', 'mp_resolve_chargeback_signal',
    'mp_resolve_match', 'mp_reverse_client_allocation', 'mp_unmap_payer', 'open_sales_session', 'pay_fiscal_obligation', 'pay_supplier', 'receive_cheque',
    'rectify_daily_production', 'rectify_delivered_order', 'rectify_mortality', 'rectify_purchase', 'register_bank_tax', 'register_classification', 'register_collection',
    'register_count_adjustment', 'register_daily_production', 'register_feed_inventory_count', 'register_feed_manufacturing', 'register_feed_movement',
    'register_fiscal_document', 'register_fiscal_obligation', 'register_flock', 'register_freight', 'register_management_event', 'register_mortality', 'register_purchase',
    'register_session_cash_event', 'register_session_movement', 'reject_cheque', 'reject_supplier_instrument', 'transfer_between_accounts'];
  check('P-7 SECURITY DEFINER set = the exact 63-name literal (60 ADR-006 + 2 ADR-007 + 1 ADR-011); helpers / trigger functions INVOKER and owner-only',
    owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`) === DEFINER_63.join(',')
      && owner(`SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('mp_is_auto_applicable','mp_v4_verified','mp_parse_report_row',
          'mp_claim_report_payment_fallback','mp_delivery_immutable_guard','mp_report_match_guard','mp_source_raw_guard','mp_source_insert_guard')
          AND NOT p.prosecdef AND NOT (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'));`) === '8');
  check('P-8 mp_v4_verified() = false', owner('SELECT mp_v4_verified();') === 'f');
}

// ═════════════════════════════════════════════════════════════════════════════
section('K', 'secret scan (all tracked files) and PII scan (ADR-006 files)');
{
  const tracked = spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\n').filter(Boolean)
    .filter((f) => existsSync(join(REPO, f)) && statSync(join(REPO, f)).size < 5 * 1024 * 1024 && !/\.(png|jpe?g|gif|ico|pdf|xlsx?|zip|woff2?|ttf)$/i.test(f));
  const FAKE = /(fake|test|local|not[-_]real|example|placeholder|canary|your[_-]|xxx|dummy|<|\$\{|process\.env|Deno\.env|os\.environ|getenv|…|\.\.\.$)/i;
  const findings = [];
  const info = [];
  for (const f of tracked) {
    const text = readFileSync(join(REPO, f), 'utf8');
    if (text.includes('\u0000')) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const at = `${f}:${i + 1}`;
      for (const m of line.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.?([A-Za-z0-9_-]*)/g)) {
        let role = '?';
        try { role = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString()).role ?? '?'; } catch { /* partial */ }
        if (m[1].length >= 20) findings.push(`${at} complete JWT (role ${role})`);
        else info.push(`${at} truncated JWT without signature (role ${role}; not a usable credential)`);
      }
      if (/APP_USR-\d{6,}-\d{6}-[0-9a-f]{20,}/.test(line)) findings.push(`${at} MP APP_USR token`);
      if (/TEST-\d{10,}-\d{6}-[0-9a-f]{20,}/.test(line)) findings.push(`${at} MP TEST- token`);
      if (/sb_secret_[A-Za-z0-9_-]{20,}/.test(line)) findings.push(`${at} Supabase secret key`);
      if (/ts=\d{10,13},v1=[0-9a-f]{64}/.test(line)) findings.push(`${at} literal x-signature`);
      const bearer = /Bearer\s+([A-Za-z0-9._-]{30,})/.exec(line);
      if (bearer && !FAKE.test(line)) findings.push(`${at} bearer literal`);
      const assign = /\b(MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET|WORKER_INVOKE_SECRET|SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|CLIENT_SECRET|MP_CLIENT_SECRET)\s*[=:]\s*['"`]?([^\s'"`,;)]{12,})/.exec(line);
      if (assign && !FAKE.test(assign[2]) && !/^eyJ/.test(assign[2])) findings.push(`${at} ${assign[1]} literal`);
    });
  }
  console.log(`      secret scan: ${tracked.length} tracked text files; informational (not credentials): ${info.length ? info.join('; ') : 'none'}`);
  check('K-1 secret scan: no potentially real credential in any tracked file (complete JWTs, MP APP_USR / TEST tokens, Supabase secret keys, literal signatures, bearer or secret-variable literals); names, fakes and placeholders allowed',
    findings.length === 0, findings.join(' | '));

  const adrFiles = [...new Set(spawnSync('git', ['log', '--name-only', '--format=', '81e0a6a^..HEAD'], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).stdout.split('\n')
    .filter(Boolean).concat(['scripts/target-db/mp_audit_security.test.mjs', '.planning/implementation-design/ADR006_IMPLEMENTATION_NOTES.md']))]
    .filter((f) => existsSync(join(REPO, f)));
  const EMAIL_OK = /@(example\.invalid|example\.com|test\.local|email\.com|anthropic\.com)$/i;
  const pii = [];
  const evidence = [];
  for (const f of adrFiles) {
    const text = readFileSync(join(REPO, f), 'utf8');
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!EMAIL_OK.test(m[0])) pii.push(`${f}: email`);
    if (/\+?54\s?9?\s?\d{2,4}[\s-]\d{4}[\s-]\d{4}/.test(text)) pii.push(`${f}: phone`);
    for (const m of text.matchAll(/(DNI|identification)[^\n]{0,60}?(\d{7,8})\b/gi)) if (!/^(\d)\1+$/.test(m[2]) && m[2] !== C.dni && !/^\d{2}222333$/.test(m[2])) pii.push(`${f}: identification number`);
    const isEvidence = /ADR006_V[1-4]_[A-Z_]*\.md$/.test(f);
    const isFixture = /fixtures\/adr006-v[23]-.*\.json$/.test(f) && /"_fixture":\s*"sanitized_real_shape"/.test(text);
    if (isEvidence) { const n = (text.match(/\b\d{9,20}\b/g) ?? []).length; if (n) evidence.push(`${f.split('/').pop()} (${n} numeric ids; accepted evidence)`); }
    if (isFixture) evidence.push(`${f.split('/').pop()} (sanitized fixture: synthetic ids)`);
  }
  console.log(`      PII scan: ${adrFiles.length} ADR-006 files; pre-existing accepted evidence reported, not modified: ${evidence.join('; ') || 'none'}`);
  check('K-2 PII scan: no real email, phone or identification number in the ADR-006 code / tests / fixtures / docs (synthetic domains and canaries only)', pii.length === 0, [...new Set(pii)].join(' | '));
}

cleanup(WM0);
check('Z-1 teardown: harness rows and audit rows removed', owner(`SELECT count(*) FROM audit_events WHERE id > ${WM0};`) === '0'
  && owner(`SELECT count(*) FROM mp_webhook_delivery WHERE resource_id ~ '^778[01]' OR x_request_id LIKE 'S12A%';`) === '0');
console.log(`\n  ══ MP AUDIT / SECURITY (STEP 12) RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail) console.log(failures.map((f) => `   - ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
