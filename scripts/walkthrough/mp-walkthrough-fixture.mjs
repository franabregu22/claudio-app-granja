#!/usr/bin/env node
/**
 * LOCAL-ONLY Mercado Pago walkthrough fixture (Phase 27 manual acceptance, block 6). Never contacts Mercado Pago or
 * production: every row is produced by the real backend pipeline RPCs on the guarded local database (service_role
 * session claims inside the local container, exactly like tests/integration/f27h-mp.test.ts) and by the ADMIN RPCs
 * executed as the local walkthrough ADMIN. Synthetic identifiers only (payment ids 7781…, payers 8008…, "WALKMP-TEST").
 *
 * Scenarios (Step 14 frontend contract):
 *   R1  receipt POSTED + CLIENT_UNASSIGNED, carrying an open report exception (DISCREPANCY)   → axis A REVIEW_REQUIRED
 *   R2  receipt POSTED, manually allocated (partial) to a synthetic client                    → CLIENT_PARTIAL
 *   R3  receipt POSTED, auto-allocated through a synthetic payer → client mapping              → CLIENT_ASSIGNED
 *   D   one FETCHED delivery per receipt (healthy) + one PERMANENT failed delivery
 *   S   one chargeback SIGNAL_RECORDED with signal_resolution NULL (signal only, no money)
 *
 * Usage (local stack only):
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/walkthrough/mp-walkthrough-fixture.mjs seed
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/walkthrough/mp-walkthrough-fixture.mjs cleanup
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const mode = process.argv[2];
if (mode !== 'seed' && mode !== 'cleanup') { console.error('usage: seed | cleanup'); process.exit(2); }

const TAG = 'WALKMP-TEST';
const ADMIN_EMAIL = 'admin.walkthrough@example.invalid';
const COLLECTOR = '100000001';   // the local MP config's synthetic collector (same as the integration tests)
const PAY = { R1: '7781000001', R2: '7781000002', R3: '7781000003', FAIL: '7781000099' };
const PAYER = { R1: '8008000001', R2: '8008000002', R3: '8008000003' };
const CB = '7782000001';

const container = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
if (!container) { console.error('no local supabase_db container'); process.exit(1); }
function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: r.stderr || '' };
}
function owner(sql) { const r = psql(sql); if (!r.ok) throw new Error(r.err); return r.out; }
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
function as(role, claims, call) {
  const r = psql(`BEGIN;\nSET LOCAL ROLE ${role};\nSET LOCAL "request.jwt.claims" = '${JSON.stringify(claims)}';\nSELECT (${call})::text;\nCOMMIT;`);
  if (!r.ok) throw new Error(r.err);
  return JSON.parse(r.out.split('\n').find((l) => l.startsWith('{')) ?? '{}');
}
const svc = (call) => as('service_role', { role: 'service_role' }, call);

const PAY_IDS = Object.values(PAY).concat(CB).map((p) => `'${p}'`).join(',');
const PAYER_IDS = Object.values(PAYER).map((p) => `'${p}'`).join(',');
function cleanup() {
  owner(`
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE ${Object.values(PAY).map((p) => `external_id LIKE 'MPPAY:${p}:%'`).join(' OR ')} OR external_id LIKE '${TAG}%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op  AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id IN (${PAY_IDS});
CREATE TEMP TABLE _al  AS SELECT id, client_ledger_id FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _fl  AS SELECT id FROM mp_attribution_flag WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _mt  AS SELECT id FROM mp_report_match WHERE report_source_id IN (SELECT id FROM _src)
  OR transition_id IN (SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv));
CREATE TEMP TABLE _pm  AS SELECT id FROM mp_payer_client_map WHERE mp_payer_id IN (${PAYER_IDS});
DELETE FROM audit_events WHERE entity_id IN (SELECT id::TEXT FROM _al UNION SELECT id::TEXT FROM _fl UNION SELECT id::TEXT FROM _mt
  UNION SELECT id::TEXT FROM _src UNION SELECT id::TEXT FROM _mv UNION SELECT id::TEXT FROM _dl UNION SELECT id::TEXT FROM _pm);
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al);
DELETE FROM client_ledger WHERE id IN (SELECT client_ledger_id FROM _al);
DELETE FROM mp_attribution_flag WHERE id IN (SELECT id FROM _fl);
DELETE FROM mp_report_match WHERE id IN (SELECT id FROM _mt);
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE triggered_by_delivery_id IN (SELECT id FROM _dl) OR key_conflict_of IN (SELECT id FROM _dl);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
DELETE FROM mp_payer_client_map WHERE id IN (SELECT id FROM _pm);
DELETE FROM client_ledger WHERE cliente_id IN (SELECT id FROM clients WHERE nombre LIKE '${TAG}%');
DELETE FROM clients WHERE nombre LIKE '${TAG}%';`);
}

if (mode === 'cleanup') { cleanup(); console.log('MP walkthrough fixture removed'); process.exit(0); }

// ── seed ─────────────────────────────────────────────────────────────────────
if (owner(`SELECT count(*) FROM mp_webhook_delivery WHERE resource_id IN (${PAY_IDS});`) !== '0') {
  console.error('the MP walkthrough fixture already exists (run cleanup first)'); process.exit(1);
}
const adminId = owner(`SELECT id FROM perfiles WHERE email = ${q(ADMIN_EMAIL)} AND rol_type = 'ADMIN' AND activo;`);
if (!adminId) { console.error(`local walkthrough ADMIN ${ADMIN_EMAIL} not found`); process.exit(1); }
const admin = (call) => as('authenticated', { sub: adminId, role: 'authenticated' }, call);
const today = owner(`SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;`);
const at = `${today}T10:00:00.000-03:00`;

function claim(deliveryId) {
  const r = psql(`BEGIN;\nSET LOCAL ROLE service_role;\nSET LOCAL "request.jwt.claims" = '{"role":"service_role"}';\nSELECT coalesce(json_agg(c), '[]')::text FROM mp_claim_deliveries(50, 120) c;\nCOMMIT;`);
  const rows = JSON.parse(r.out.split('\n').find((l) => l.startsWith('[')) ?? '[]');
  const c = rows.find((x) => x.delivery_id === deliveryId);
  if (!c) throw new Error(`delivery ${deliveryId} not claimed`);
  return c.claim_token;
}
const transition = (d, tok, outcome, src = null, errorCode = null) =>
  svc(`mp_delivery_transition(${q(d)}, ${q(tok)}, ${q(outcome)}, ${q(src)}, ${q(errorCode)}, NULL, NULL, NULL)`);
const payload = (pid, payer, amount, fee) => ({
  id: Number(pid), operation_type: 'money_transfer', status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true,
  collector_id: Number(COLLECTOR), payer: { id: payer }, external_reference: `${TAG}-${pid}`, date_created: at, date_approved: at,
  transaction_amount: amount, transaction_details: { net_received_amount: amount - fee }, fee_details: [{ type: 'mercadopago_fee', amount: fee, fee_payer: 'collector' }],
  refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [],
});
function receipt(pid, payer, amount, fee) {
  const d = svc(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, NULL, ${q(TAG)}, ${q(JSON.stringify({ notification_id: `${TAG}-${pid}` }))}::jsonb, true)`).delivery_id;
  const tok = claim(d);
  const src = svc(`mp_ingest_api_snapshot(${q(d)}, ${q(tok)}, ${q(pid)}, ${q(JSON.stringify(payload(pid, payer, amount, fee)))}::jsonb)`);
  if (src.processing_status === 'PENDING') svc(`mp_normalize_source(${q(src.source_record_id)})`);
  const mv = Number(owner(`SELECT m.id FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
    WHERE t.resource_type = 'payment' AND t.resource_id = ${q(pid)} AND t.transition = 'APPROVAL';`));
  svc(`mp_apply_transition(${mv})`);
  svc(`mp_auto_allocate(${mv})`);
  transition(d, tok, 'FETCHED', src.source_record_id);
  return { mv, tId: Number(owner(`SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id = ${mv};`)) };
}

try {
  const clientA = owner(`INSERT INTO clients (nombre) VALUES ('${TAG} Cliente asignado a mano') RETURNING id;`);
  const clientB = owner(`INSERT INTO clients (nombre) VALUES ('${TAG} Cliente por mapeo de pagador') RETURNING id;`);

  // R1: unassigned receipt with an open report exception
  const r1 = receipt(PAY.R1, PAYER.R1, 10000, 600);
  const rs = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processed_at)
    VALUES ('csv_import', '${TAG}-report:payment:${PAY.R1}', '{"fixture":"walkthrough report row"}'::jsonb, '${at}', '${today}', 'IGNORED', NOW()) RETURNING id;`);
  owner(`INSERT INTO mp_report_match (outcome, report_source_id, transition_id, detail, is_exception)
    VALUES ('DISCREPANCY', '${rs}', ${r1.tId}, '{"fee": {"report": -650, "recorded": -600}}'::jsonb, true);`);

  // R2: manual partial allocation by the walkthrough ADMIN
  const r2 = receipt(PAY.R2, PAYER.R2, 20000, 1200);
  admin(`mp_allocate_to_client(${r2.mv}, '${clientA}', 5000, '${today}', '${TAG}-alloc-${randomUUID()}', 'walkthrough: asignación parcial de prueba')`);

  // R3: payer mapping first, then the receipt auto-allocates
  admin(`mp_map_payer_to_client('${PAYER.R3}', '${clientB}', 'walkthrough: mapeo de pagador de prueba')`);
  receipt(PAY.R3, PAYER.R3, 15000, 900);

  // D: a permanently failed delivery (no movement)
  const df = svc(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(PAY.FAIL)}, NULL, ${q(TAG)}, ${q(JSON.stringify({ notification_id: `${TAG}-${PAY.FAIL}` }))}::jsonb, true)`).delivery_id;
  transition(df, claim(df), 'PERMANENT', null, 'MP_BAD_REQUEST');

  // S: chargeback signal only (no financial effect)
  const dc = svc(`mp_register_delivery('webhook', 'topic_chargebacks_wh', 'chargeback', NULL, ${q(CB)}, NULL, ${q(`${TAG}-cb`)},
    ${q(JSON.stringify({ type: 'topic_chargebacks_wh', data_id: CB, live_mode: true, user_id: Number(COLLECTOR), notification_id: `${TAG}-cb-${CB}` }))}::jsonb, true)`).delivery_id;
  transition(dc, claim(dc), 'SIGNAL_RECORDED');

  console.log('MP walkthrough fixture created (local only)');
} catch (e) {
  console.error('seed failed; rolling back the partial fixture');
  cleanup();
  throw e;
}
