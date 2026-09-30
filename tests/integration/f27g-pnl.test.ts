/**
 * F27-G integration: P&L reads and management events through the frontend data layer (src/target/pnl.ts) against
 * the guarded LOCAL stack only (127.0.0.1, local demo keys read from the running container). A management event's
 * economic effect is read back from pnl_summary / pnl_line_item / report_balance_period; OPERATOR obtains no P&L data
 * and cannot register events; nothing is written directly.
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
import { listLedgerBalances } from '../../src/target/treasury';
import { listManagementEvents, listPnlLineItems, listPnlSummary, registerManagementEvent } from '../../src/target/pnl';

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
function owner(sql: string): string {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  const r = spawnSync('docker', ['exec', '-i', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error(r.stderr);
  return (r.stdout || '').trim();
}

const keys = localKeys();
const service = createClient(LOCAL_URL, keys.service, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const TAG = `F27G-${run}`;
const password = `F27g-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `f27g-admin-${run}@example.invalid` },
  OPERATOR: { email: `f27g-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const denied = (e: unknown) => e instanceof TargetDbError && ['PERMISSION_DENIED', 'RLS_DENIED', 'FORBIDDEN'].includes(e.code);
const fx = { account: '', today: '', period: '' };
const events: string[] = [];
const key = (s: string) => `${TAG}-${s}`;
const summary = async (col: 'retiros' | 'reservas_internas') =>
  (await listPnlSummary(admin(), fx.period, fx.period))[0]?.[col] ?? 0;
const balance = async () => (await listLedgerBalances(admin(), 'ACCOUNT')).find((b) => b.entity_id === fx.account)?.balance ?? 0;

function cleanup() {
  const ids = events.length ? `(${events.map((e) => `'${e}'`).join(',')})` : '(NULL::UUID)';
  owner(`
CREATE TEMP TABLE _o AS SELECT financial_operation_id AS id FROM management_event WHERE id IN ${ids} AND financial_operation_id IS NOT NULL
  UNION SELECT financial_operation_id FROM financial_posting WHERE financial_account_id IN (SELECT id FROM financial_account WHERE nombre LIKE '${TAG}%');
DELETE FROM audit_events WHERE entity_id IN (SELECT id::TEXT FROM management_event WHERE id IN ${ids});
UPDATE management_event SET compensates_event_id = NULL WHERE id IN ${ids};
DELETE FROM management_event WHERE id IN ${ids};
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _o);
DELETE FROM financial_account WHERE nombre LIKE '${TAG}%';`);
}

beforeAll(async () => {
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
  fx.today = owner(`SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE::TEXT;`);
  fx.period = `${fx.today.slice(0, 7)}-01`;
  fx.account = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} caja`, account_type: 'CASH' })).id;
});

afterAll(async () => {
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  const idList = ids.map((i) => `'${i}'`).join(',');
  if (ids.length) owner(`DELETE FROM audit_events WHERE performed_by IN (${idList});\nDELETE FROM perfiles WHERE id IN (${idList});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

describe('F27-G management events (ADMIN) and their effect through the P&L views', () => {
  let retiro = '';

  it('the backend refuses an invalid event: account rules, reason, amount, role', async () => {
    const base = { effectiveDate: fx.today, amount: 1000, reason: 'retiro socio' };
    expect(code(await registerManagementEvent(admin(), { ...base, type: 'RETIRO', idempotencyKey: key('E1') }).catch((e) => e))).toBe('ACCOUNT_REQUIRED');
    expect(code(await registerManagementEvent(admin(), { ...base, type: 'RESERVA_INTERNA', idempotencyKey: key('E2'), accountId: fx.account }).catch((e) => e)))
      .toBe('ACCOUNT_NOT_ALLOWED');
    expect(code(await registerManagementEvent(admin(), { ...base, type: 'RETIRO', idempotencyKey: key('E3'), accountId: fx.account, reason: ' ' }).catch((e) => e)))
      .toBe('REASON_REQUIRED');
    expect(code(await registerManagementEvent(admin(), { ...base, type: 'RETIRO', idempotencyKey: key('E4'), accountId: fx.account, amount: 0 }).catch((e) => e)))
      .toBe('INVALID_AMOUNT');
    expect(code(await registerManagementEvent(admin(), { ...base, type: 'RETIRO', idempotencyKey: key('E5'), accountId: fx.account, effectiveDate: '2001-01-15' }).catch((e) => e)))
      .toBe('PERIOD_NOT_FOUND');
    expect(denied(await registerManagementEvent(operator(), { ...base, type: 'RESERVA_INTERNA', idempotencyKey: key('E6') }).catch((e) => e))).toBe(true);
  });

  it('a RETIRO appears in pnl_summary / pnl_line_item and moves the account balance; the key is idempotent', async () => {
    const [retirosBefore, balanceBefore] = [await summary('retiros'), await balance()];
    const r = await registerManagementEvent(admin(), { type: 'RETIRO', effectiveDate: fx.today, amount: 1500, idempotencyKey: key('R1'), reason: 'retiro socio', accountId: fx.account });
    retiro = r.management_event_id;
    events.push(retiro);
    expect(r.financial_operation_id).not.toBeNull();
    expect(Math.abs((await summary('retiros')) - retirosBefore)).toBe(1500);
    expect(await balance()).toBe(balanceBefore - 1500);
    const item = (await listPnlLineItems(admin(), fx.period)).find((i) => i.source_entity_id === retiro);
    expect(item).toMatchObject({ bucket: 'RETIROS' });
    expect(Math.abs(item!.signed_amount)).toBe(1500);
    expect((await listManagementEvents(admin())).map((e) => e.id)).toContain(retiro);
    const dup = await registerManagementEvent(admin(), { type: 'RETIRO', effectiveDate: fx.today, amount: 1500, idempotencyKey: key('R1'), reason: 'x', accountId: fx.account }).catch((e) => e);
    expect(code(dup)).toBe('DUPLICATE_MANAGEMENT_EVENT');
  });

  it('a RESERVA_INTERNA moves no money; a compensation must match type, account and outstanding amount', async () => {
    const [reservasBefore, balanceBefore] = [await summary('reservas_internas'), await balance()];
    const res = await registerManagementEvent(admin(), { type: 'RESERVA_INTERNA', effectiveDate: fx.today, amount: 800, idempotencyKey: key('S1'), reason: 'reserva de mantenimiento' });
    events.push(res.management_event_id);
    expect(res.financial_operation_id).toBeNull();
    expect(Math.abs((await summary('reservas_internas')) - reservasBefore)).toBe(800);
    expect(await balance()).toBe(balanceBefore);

    const mismatch = await registerManagementEvent(admin(), {
      type: 'RESERVA_INTERNA', effectiveDate: fx.today, amount: 100, idempotencyKey: key('C1'), reason: 'x', compensatesEventId: retiro,
    }).catch((e) => e);
    expect(code(mismatch)).toBe('COMPENSATION_TYPE_MISMATCH');
    const tooMuch = await registerManagementEvent(admin(), {
      type: 'RETIRO', effectiveDate: fx.today, amount: 5000, idempotencyKey: key('C2'), reason: 'x', accountId: fx.account, compensatesEventId: retiro,
    }).catch((e) => e);
    expect(code(tooMuch)).toBe('COMPENSATION_EXCEEDS_ORIGINAL');
    const retirosBefore = await summary('retiros');
    const comp = await registerManagementEvent(admin(), {
      type: 'RETIRO', effectiveDate: fx.today, amount: 500, idempotencyKey: key('C3'), reason: 'devolución parcial', accountId: fx.account, compensatesEventId: retiro,
    });
    events.push(comp.management_event_id);
    expect(Math.abs((await summary('retiros')) - retirosBefore)).toBe(500);
    expect(await balance()).toBe(balanceBefore + 500);
  });
});

describe('F27-G P&L is ADMIN-only; nothing is written directly', () => {
  it('OPERATOR obtains no pnl_summary, pnl_line_item or management event row', async () => {
    expect((await listPnlSummary(admin(), fx.period, fx.period)).length).toBe(1);
    expect(await listPnlSummary(operator(), fx.period, fx.period)).toEqual([]);
    expect(await listPnlLineItems(operator(), fx.period)).toEqual([]);
    expect(await listManagementEvents(operator())).toEqual([]);
  });

  it('management_event and financial rows cannot be written directly, even by ADMIN', async () => {
    for (const c of [admin(), operator()]) {
      expect((await c.from('management_event').insert({ event_type: 'RESERVA_INTERNA', effective_date: fx.today, amount: 1, idempotency_key: key('X'), reason: 'x' }).select()).error).not.toBeNull();
      expect((await c.from('financial_posting').insert({ financial_account_id: fx.account, signed_amount: 1, effective_date: fx.today }).select()).error).not.toBeNull();
    }
  });
});
