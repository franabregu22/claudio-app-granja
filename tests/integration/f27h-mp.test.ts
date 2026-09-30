/**
 * F27-H integration: the Mercado Pago frontend data layer (src/target/mp.ts) against the guarded LOCAL stack only,
 * following the accepted Step-14 contract. Fixtures go through the backend's own service pipeline
 * (register → claim → ingest → normalize → apply), exactly like scripts/target-db/mp_views.test.mjs, with this file's
 * own identifiers (payments 7779…, chargebacks 7780…). No real Mercado Pago API, no webhook, no production.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:integration
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { TargetDbError } from '../../src/target/db';
import { createMaster } from '../../src/target/masters';
import {
  L_C3_COLUMNS, L_C7_COLUMNS, L_S7_COLUMNS, allocateToClient, clearAttributionFlag, flagForAttribution, getDeliveryHealth, getReceipt, listReceipts,
  listReportExceptions, lookupActiveMappings, lookupAllocations, lookupChargebackSignals, mapPayerToClient, requestRefetch, requeueConfigBlocked,
  resolveChargebackSignal, resolveMatch, reverseAllocation, uiIdempotencyKey, unmapPayer,
} from '../../src/target/mp';

const LOCAL_URL = 'http://127.0.0.1:54321';
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);

function localKeys(): { anon: string; service: string } {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_edge_runtime', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '')
    .trim().split('\n')[0];
  if (!c) throw new Error('local edge-runtime container not running');
  const env = (spawnSync('docker', ['inspect', c, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' }).stdout || '')
    .split(/\r?\n/);
  const get = (k: string) => (env.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
  const keys = { anon: get('SUPABASE_ANON_KEY'), service: get('SUPABASE_SERVICE_ROLE_KEY') };
  for (const [want, jwt] of [['anon', keys.anon], ['service_role', keys.service]] as const) {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}');
    if (payload.iss !== 'supabase-demo' || payload.role !== want) throw new Error(`not a local demo ${want} key`);
  }
  return keys;
}
function psql(sql: string): { ok: boolean; out: string; err: string } {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  const r = spawnSync('docker', ['exec', '-i', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: r.stderr || '' };
}
function owner(sql: string): string {
  const r = psql(sql);
  if (!r.ok) throw new Error(r.err);
  return r.out;
}
const esc = (s: string) => s.replace(/'/g, "''");
const q = (v: unknown) => (v === null || v === undefined ? 'NULL' : `'${esc(String(v))}'`);
/** One backend pipeline call as service_role (fixture only: the frontend never calls these). */
function svc(call: string): any {
  const r = psql(`BEGIN;\nSET LOCAL ROLE service_role;\nSET LOCAL "request.jwt.claims" = '{"role":"service_role"}';\nSELECT (${call})::text;\nCOMMIT;`);
  if (!r.ok) throw new Error(r.err);
  const line = r.out.split('\n').find((l) => l.startsWith('{')) ?? '{}';
  return JSON.parse(line);
}

const keys = localKeys();
const service = createClient(LOCAL_URL, keys.service, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const TAG = `F27H-${run}`;
const password = `F27h-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `f27h-admin-${run}@example.invalid` },
  OPERATOR: { email: `f27h-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const COLLECTOR = '100000001';
const digits = String(parseInt(run.slice(0, 6), 16)).padStart(8, '0').slice(-8);
const PAYER = `8009${digits}`;
let seq = 0;
const newPid = () => `7779${digits.slice(-4)}${String(Date.now()).slice(-4)}${String(++seq).padStart(2, '0')}`;
const fx = { client: '', mv: 0, pid: '', tId: 0 };

function payload(pid: string) {
  const at = '2026-11-05T10:00:00.000-04:00';
  return { id: Number(pid), operation_type: 'money_transfer', status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true,
    collector_id: Number(COLLECTOR), payer: { id: PAYER }, external_reference: null, date_created: at, date_approved: at,
    transaction_amount: 100, transaction_details: { net_received_amount: 93 }, fee_details: [{ type: 'mercadopago_fee', amount: 5, fee_payer: 'collector' }],
    refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
}
function claim(deliveryId: string): string {
  const r = psql(`BEGIN;\nSET LOCAL ROLE service_role;\nSET LOCAL "request.jwt.claims" = '{"role":"service_role"}';\nSELECT coalesce(json_agg(c), '[]')::text FROM mp_claim_deliveries(50, 120) c;\nCOMMIT;`);
  const rows = JSON.parse(r.out.split('\n').find((l) => l.startsWith('[')) ?? '[]') as { delivery_id: string; claim_token: string }[];
  const c = rows.find((x) => x.delivery_id === deliveryId);
  if (!c) throw new Error(`delivery ${deliveryId} not claimed`);
  return c.claim_token;
}
const transition = (d: string, tok: string, outcome: string, src: string | null = null) =>
  svc(`mp_delivery_transition(${q(d)}, ${q(tok)}, ${q(outcome)}, ${q(src)}, NULL, NULL, NULL, NULL)`);
function receipt() {
  const pid = newPid();
  const d = svc(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, NULL, ${q(TAG)}, ${q(JSON.stringify({ notification_id: `${TAG}-${pid}` }))}::jsonb, true)`).delivery_id;
  const tok = claim(d);
  const src = svc(`mp_ingest_api_snapshot(${q(d)}, ${q(tok)}, ${q(pid)}, ${q(JSON.stringify(payload(pid)))}::jsonb)`);
  if (src.processing_status === 'PENDING') svc(`mp_normalize_source(${q(src.source_record_id)})`);
  const mv = Number(owner(`SELECT m.id FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
    WHERE t.resource_type = 'payment' AND t.resource_id = ${q(pid)} AND t.transition = 'APPROVAL';`));
  svc(`mp_apply_transition(${mv})`);
  svc(`mp_auto_allocate(${mv})`);
  transition(d, tok, 'FETCHED', src.source_record_id);
  const tId = Number(owner(`SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id = ${mv};`));
  return { pid, mv, tId };
}

function cleanup() {
  owner(`
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:7779%' OR external_id LIKE '${TAG}%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op  AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '7779%' OR resource_id LIKE '7780%';
CREATE TEMP TABLE _al  AS SELECT id, client_ledger_id FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _fl  AS SELECT id FROM mp_attribution_flag WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _mt  AS SELECT id FROM mp_report_match WHERE report_source_id IN (SELECT id FROM _src)
  OR transition_id IN (SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv));
CREATE TEMP TABLE _pm  AS SELECT id FROM mp_payer_client_map WHERE mp_payer_id LIKE '8009${digits}%';
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
DELETE FROM clients WHERE nombre LIKE '${TAG}%';`);
}

beforeAll(async () => {
  cleanup();
  for (const [role, u] of Object.entries(users)) {
    const { data, error } = await service.auth.admin.createUser({ email: u.email, password, email_confirm: true });
    if (error) throw error;
    u.id = data.user!.id;
    owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${u.id}', '${u.email}', '${role}', true);`);
    const client = createClient(LOCAL_URL, keys.anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const s = await client.auth.signInWithPassword({ email: u.email, password });
    if (s.error) throw s.error;
    u.client = client;
  }
  fx.client = (await createMaster<{ id: string }>(admin(), 'clients', { nombre: `${TAG} cliente` })).id;
  const r = receipt();
  Object.assign(fx, { mv: r.mv, pid: r.pid, tId: r.tId });
});

afterAll(async () => {
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  const idList = ids.map((i) => `'${i}'`).join(',');
  if (ids.length) owner(`DELETE FROM audit_events WHERE performed_by IN (${idList});\nDELETE FROM perfiles WHERE id IN (${idList});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

const row = async () => (await getReceipt(admin(), fx.mv)).receipt!;

describe('F27-H state comes only from the Step-10 views (ADMIN); OPERATOR gets nothing', () => {
  it('S-A / S-B: the receipt is read from report_mp_receipt_status with both axes as returned; CLIENT_UNASSIGNED is a valid state', async () => {
    const list = await listReceipts(admin(), { from: '2026-11-01', to: '2026-11-30' });
    const r = list.find((x) => x.mp_financial_movement_id === fx.mv)!;
    expect(r).toMatchObject({ axis_a_state: 'POSTED', axis_b_state: 'CLIENT_UNASSIGNED', gross_amount: 100, active_attributed: 0 });
    expect(Object.keys(r).sort()).toEqual(['active_attributed', 'axis_a_state', 'axis_b_state', 'effective_applied_receipt', 'fee_amount', 'gross_amount',
      'mp_financial_movement_id', 'net_amount', 'occurred_date', 'open_flag', 'payment_id', 'review_reasons', 'tax_amount'].sort());
    const filtered = await listReceipts(admin(), { from: '2026-11-01', to: '2026-11-30', axisB: 'CLIENT_RESOLUTION_REQUESTED' });
    expect(filtered.map((x) => x.mp_financial_movement_id)).not.toContain(fx.mv);
    expect((await row()).payment_id).toBe(fx.pid);
    expect((await getDeliveryHealth(admin()))).not.toBeNull();
  });

  it('OPERATOR reads no MP view row and no lookup row', async () => {
    expect(await listReceipts(operator(), { from: '2026-01-01', to: '2026-12-31' })).toEqual([]);
    expect(await getDeliveryHealth(operator())).toBeNull();
    expect(await listReportExceptions(operator())).toEqual([]);
    expect(await lookupAllocations(operator(), fx.mv)).toEqual([]);
    expect(await lookupActiveMappings(operator())).toEqual([]);
    expect(await lookupChargebackSignals(operator())).toEqual([]);
  });
});

describe('F27-H axis B actions (C1, C3, C4, C5): the effect is read back from the view', () => {
  it('C1 assigns part of the receipt → CLIENT_PARTIAL; the backend enforces cap, date, reason and role', async () => {
    const base = { movementId: fx.mv, clienteId: fx.client, effectiveDate: '2026-11-05', reason: 'cliente identificado' };
    expect(code(await allocateToClient(operator(), { ...base, amount: 10, idempotencyKey: uiIdempotencyKey() }).catch((e) => e))).toBe('FORBIDDEN');
    expect(code(await allocateToClient(admin(), { ...base, amount: 10, idempotencyKey: uiIdempotencyKey(), reason: ' ' }).catch((e) => e))).toBe('REASON_REQUIRED');
    expect(code(await allocateToClient(admin(), { ...base, amount: 10, idempotencyKey: uiIdempotencyKey(), effectiveDate: '2026-11-01' }).catch((e) => e)))
      .toBe('EFFECTIVE_DATE_BEFORE_RECEIPT');
    expect(code(await allocateToClient(admin(), { ...base, amount: 10_000, idempotencyKey: uiIdempotencyKey() }).catch((e) => e))).toBe('ALLOCATION_EXCEEDS_RECEIPT');
    const k = uiIdempotencyKey();
    await allocateToClient(admin(), { ...base, amount: 40, idempotencyKey: k });
    expect(await row()).toMatchObject({ axis_b_state: 'CLIENT_PARTIAL', active_attributed: 40, axis_a_state: 'POSTED' });
    expect(code(await allocateToClient(admin(), { ...base, amount: 40, idempotencyKey: k }).catch((e) => e))).toBe('DUPLICATE_ALLOCATION');
  });

  it('C3 reverses through the L-C3 lookup (exact allow-listed columns) → back to CLIENT_UNASSIGNED', async () => {
    const allocations = await lookupAllocations(admin(), fx.mv);
    expect(allocations).toHaveLength(1);
    expect(Object.keys(allocations[0]).sort()).toEqual([...L_C3_COLUMNS].sort());
    expect(allocations[0]).toMatchObject({ cliente_id: fx.client, amount: 40 });
    const over = await reverseAllocation(admin(), { allocationId: allocations[0].id, amount: 50, idempotencyKey: uiIdempotencyKey(), reason: 'error' }).catch((e) => e);
    expect(code(over)).toBe('REVERSAL_EXCEEDS_ALLOCATION');
    await reverseAllocation(admin(), { allocationId: allocations[0].id, amount: 40, idempotencyKey: uiIdempotencyKey(), reason: 'cliente equivocado' });
    expect(await row()).toMatchObject({ axis_b_state: 'CLIENT_UNASSIGNED', active_attributed: 0 });
    expect(await lookupAllocations(admin(), fx.mv)).toHaveLength(1);   // the lookup only lists what can be reversed; it is never axis B
  });

  it('C4 opens the attribution request (the only axis-B work item); C5 closes it', async () => {
    await flagForAttribution(admin(), { movementId: fx.mv, reason: 'averiguar cliente' });
    const flagged = await row();
    expect(flagged).toMatchObject({ axis_b_state: 'CLIENT_RESOLUTION_REQUESTED', open_flag: true });
    expect(code(await flagForAttribution(admin(), { movementId: fx.mv, reason: 'otra vez' }).catch((e) => e))).toBe('FLAG_ALREADY_OPEN');
    await clearAttributionFlag(admin(), { flagId: flagged.open_flag_id!, reason: 'no se identifica: queda sin cliente' });
    expect(await row()).toMatchObject({ axis_b_state: 'CLIENT_UNASSIGNED', open_flag: false });
    expect(code(await clearAttributionFlag(admin(), { flagId: flagged.open_flag_id!, reason: 'x' }).catch((e) => e))).toBe('FLAG_NOT_OPEN');
  });
});

describe('F27-H payer mappings (C6, C7 via L-C7)', () => {
  it('C6 maps a payer id to a client; C7 removes it by the lookup id; invalid ids are refused', async () => {
    expect(code(await mapPayerToClient(admin(), { payerId: 'abc', clienteId: fx.client, reason: 'x' }).catch((e) => e))).toBe('INVALID_PAYER_ID');
    await mapPayerToClient(admin(), { payerId: `${PAYER}1`, clienteId: fx.client, reason: 'pagador habitual' });
    const m = (await lookupActiveMappings(admin())).find((x) => x.mp_payer_id === `${PAYER}1`)!;
    expect(Object.keys(m).sort()).toEqual([...L_C7_COLUMNS].sort());
    expect(m.cliente_id).toBe(fx.client);
    expect(code(await mapPayerToClient(admin(), { payerId: `${PAYER}1`, clienteId: fx.client, reason: 'x' }).catch((e) => e))).toBe('PAYER_ALREADY_MAPPED');
    await unmapPayer(admin(), { mappingId: m.id, reason: 'ya no compra' });
    expect((await lookupActiveMappings(admin())).map((x) => x.id)).not.toContain(m.id);
    expect(code(await unmapPayer(admin(), { mappingId: m.id, reason: 'x' }).catch((e) => e))).toBe('MAPPING_NOT_ACTIVE');
  });
});

describe('F27-H report exceptions (R1) and delivery recovery (S5, S6, S7)', () => {
  it('R1: an open exception is listed (S-F and inline in S-B); CORRECTED without a correction is refused; EXPLAINED resolves it', async () => {
    const rs = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processed_at)
      VALUES ('csv_import', '${TAG}-report:payment:C', '{"fixture":"report row"}'::jsonb, '2026-11-05T12:00:00-03:00', '2026-11-05', 'IGNORED', NOW()) RETURNING id;`);
    const matchId = owner(`INSERT INTO mp_report_match (outcome, report_source_id, transition_id, detail, is_exception)
      VALUES ('DISCREPANCY', '${rs}', ${fx.tId}, '{"fee": {"report": -6, "recorded": -5}}'::jsonb, true) RETURNING id;`);
    expect((await listReportExceptions(admin())).find((e) => e.match_id === matchId)).toMatchObject({ outcome: 'DISCREPANCY', mp_financial_movement_id: fx.mv });
    const detail = await getReceipt(admin(), fx.mv);
    expect(detail.exceptions.map((e) => e.match_id)).toContain(matchId);
    expect(detail.receipt!.axis_a_state).toBe('REVIEW_REQUIRED');
    expect(code(await resolveMatch(admin(), { matchId, resolution: 'CORRECTED', reason: 'x' }).catch((e) => e))).toBe('NO_CORRECTION_FOUND');
    await resolveMatch(admin(), { matchId, resolution: 'EXPLAINED', reason: 'comisión redondeada por MP' });
    expect((await listReportExceptions(admin())).map((e) => e.match_id)).not.toContain(matchId);
    expect(code(await resolveMatch(admin(), { matchId, resolution: 'EXPLAINED', reason: 'x' }).catch((e) => e))).toBe('ALREADY_RESOLVED');
  });

  it('S7: an unresolved chargeback signal is found through L-S7 (exact columns) and resolved as a SIGNAL only', async () => {
    const cb = `7780${digits.slice(-4)}${String(Date.now()).slice(-4)}`;
    const d = svc(`mp_register_delivery('webhook', 'topic_chargebacks_wh', 'chargeback', NULL, ${q(cb)}, NULL, ${q(`${TAG}-cb`)},
      ${q(JSON.stringify({ type: 'topic_chargebacks_wh', data_id: cb, live_mode: true, user_id: Number(COLLECTOR), notification_id: `${TAG}-cb-${cb}` }))}::jsonb, true)`).delivery_id;
    transition(d, claim(d), 'SIGNAL_RECORDED');
    // scoped to this file's ADMIN: other integration files create operations concurrently
    const before = owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_posting WHERE created_by = '${users.ADMIN.id}') FROM financial_operation WHERE created_by = '${users.ADMIN.id}';`);
    const s = (await lookupChargebackSignals(admin())).find((x) => x.resource_id === cb)!;
    expect(Object.keys(s).sort()).toEqual([...L_S7_COLUMNS].sort());
    expect(Number((await getDeliveryHealth(admin()))!.unresolved_chargeback_signals)).toBeGreaterThan(0);
    expect(code(await resolveChargebackSignal(admin(), { deliveryId: s.id, resolution: 'LINKED', paymentId: 'abc', reason: 'x' }).catch((e) => e))).toBe('INVALID_PAYMENT_ID');
    await resolveChargebackSignal(admin(), { deliveryId: s.id, resolution: 'DISMISSED', reason: 'aviso de prueba de MP' });
    expect((await lookupChargebackSignals(admin())).map((x) => x.id)).not.toContain(s.id);
    expect(owner(`SELECT count(*) || '|' || (SELECT count(*) FROM financial_posting WHERE created_by = '${users.ADMIN.id}') FROM financial_operation WHERE created_by = '${users.ADMIN.id}';`)).toBe(before);   // no financial application
    expect(code(await resolveChargebackSignal(admin(), { deliveryId: s.id, resolution: 'DISMISSED', reason: 'x' }).catch((e) => e))).toBe('ALREADY_RESOLVED');
  });

  it('S5 / S6 need a reason; S6 validates the payment id; OPERATOR is refused', async () => {
    expect(code(await requeueConfigBlocked(admin(), { reason: '' }).catch((e) => e))).toBe('REASON_REQUIRED');
    await requeueConfigBlocked(admin(), { reason: 'credencial corregida' });
    expect(code(await requestRefetch(admin(), { paymentId: 'x1', reason: 'x' }).catch((e) => e))).toBe('INVALID_PAYMENT_ID');
    await requestRefetch(admin(), { paymentId: fx.pid, reason: 'volver a consultar' });
    expect(code(await requestRefetch(operator(), { paymentId: fx.pid, reason: 'x' }).catch((e) => e))).toBe('FORBIDDEN');
    expect(code(await requeueConfigBlocked(operator(), { reason: 'x' }).catch((e) => e))).toBe('FORBIDDEN');
  });
});

describe('F27-H no direct write on any MP table', () => {
  it('ADMIN and OPERATOR cannot insert / update MP rows through PostgREST', async () => {
    for (const c of [admin(), operator()]) {
      expect((await c.from('mp_client_allocation').insert({ mp_financial_movement_id: fx.mv, cliente_id: fx.client, amount: 1 }).select()).error).not.toBeNull();
      expect((await c.from('mp_payer_client_map').insert({ mp_payer_id: `${PAYER}9`, cliente_id: fx.client }).select()).error).not.toBeNull();
      const upd = await c.from('mp_webhook_delivery').update({ signal_resolution: 'DISMISSED' }).eq('resource_id', '0').select();
      expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
    }
  });
});
