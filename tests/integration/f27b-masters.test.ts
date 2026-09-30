/**
 * F27-B integration: master data (clients, products + price_history, expense_category, sheds / flocks, suppliers,
 * financial_account, operator_assignments, projects) through the frontend data layer, as ADMIN and as OPERATOR,
 * against the guarded LOCAL stack only (127.0.0.1, local demo keys read from the running container).
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:integration
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { TargetDbError, writeTable } from '../../src/target/db';
import {
  assignOperator, createMaster, listCurrentPrices, listFlocks, listMaster, listOperatorAssignments, listProfiles, setAssignmentActive,
  setPrice, updateMaster, type MasterTable,
} from '../../src/target/masters';

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
const password = `F27b-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `f27b-admin-${run}@example.invalid` },
  OPERATOR: { email: `f27b-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const created: Record<string, string[]> = {};
const track = (table: string, id: string) => { (created[table] ??= []).push(id); return id; };

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
});

afterAll(async () => {
  const del = (table: string) => (created[table]?.length ? `DELETE FROM ${table} WHERE id IN (${created[table].map((i) => `'${i}'`).join(',')});` : '');
  owner(['operator_assignments', 'price_history', 'flocks', 'products', 'sheds', 'clients', 'suppliers', 'expense_category', 'financial_account', 'projects']
    .map(del).join('\n') || 'SELECT 1;');
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  if (ids.length) owner(`DELETE FROM perfiles WHERE id IN (${ids.map((i) => `'${i}'`).join(',')});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

const denied = (err: unknown) => err instanceof TargetDbError && ['PERMISSION_DENIED', 'RLS_DENIED'].includes(err.code);

const FORMS: { table: MasterTable; create: Record<string, unknown>; update: Record<string, unknown>; activo: boolean }[] = [
  { table: 'clients', create: { nombre: `F27B cliente ${run}`, fiscal_id: '20-00000000-0', contacto: 'test' }, update: { contacto: 'otro', activo: false }, activo: true },
  { table: 'suppliers', create: { nombre: `F27B proveedor ${run}` }, update: { fiscal_id: '30-00000000-0' }, activo: true },
  { table: 'expense_category', create: { nombre: `F27B categoria ${run}`, description: 'd', pnl_cost_class: 'DIRECT' }, update: { activo: false }, activo: true },
  { table: 'financial_account', create: { nombre: `F27B cuenta ${run}`, account_type: 'CASH' }, update: { nombre: `F27B cuenta ${run} bis` }, activo: true },
  { table: 'projects', create: { nombre: `F27B proyecto ${run}`, descripcion: 'd' }, update: { status: 'PAUSED' }, activo: false },
  { table: 'products', create: { nombre: `F27B producto ${run}`, product_type: 'VENDIBLE', unit_type: 'CARTON' }, update: { unit_type: 'UNIT' }, activo: true },
  { table: 'sheds', create: { nombre: `F27B galpon ${run}`, capacidad: 1000 }, update: { capacidad: 1200 }, activo: true },
];

describe('F27-B master forms: ADMIN writes, OPERATOR is denied by the database', () => {
  it.each(FORMS)('$table: ADMIN create / update / read; OPERATOR insert and update refused, no ADMIN-only rows leak', async (form) => {
    const row = await createMaster<{ id: string } & Record<string, unknown>>(admin(), form.table, form.create);
    track(form.table, row.id);
    const updated = await updateMaster<Record<string, unknown>>(admin(), form.table, row.id, form.update);
    for (const [k, v] of Object.entries(form.update)) expect(updated[k]).toEqual(v);
    const adminRows = await listMaster<{ id: string }>(admin(), form.table);
    expect(adminRows.map((r) => r.id)).toContain(row.id);

    const insertErr = await createMaster(operator(), form.table, { ...form.create, nombre: `${String(form.create.nombre)} op` }).catch((e) => e);
    expect(denied(insertErr)).toBe(true);
    const updateErr = await updateMaster(operator(), form.table, row.id, { nombre: 'hijacked' }).catch((e) => e);
    expect(updateErr).toBeInstanceOf(TargetDbError);
    expect(['NOT_UPDATED', 'PERMISSION_DENIED', 'RLS_DENIED']).toContain((updateErr as TargetDbError).code);
    const after = (await listMaster<{ id: string; nombre: string }>(admin(), form.table)).find((r) => r.id === row.id)!;
    expect(after.nombre).not.toBe('hijacked');

    const opRows = await listMaster<{ id: string; activo?: boolean }>(operator(), form.table);
    if (form.table === 'sheds') expect(opRows.every((r) => r.activo === true)).toBe(true);   // OPERATOR sees active sheds only
    else expect(opRows).toEqual([]);                                                         // ADMIN-only master
  });

  it('no delete path: the database refuses a raw DELETE even for ADMIN, and the frontend helper refuses before the network', async () => {
    const id = created.clients[0];
    const raw = await admin().from('clients').delete().eq('id', id).select();
    expect(raw.error).not.toBeNull();
    expect((await listMaster<{ id: string }>(admin(), 'clients')).map((r) => r.id)).toContain(id);
    await expect(writeTable(admin(), 'clients', 'delete' as never, null, { id })).rejects.toMatchObject({ code: 'DIRECT_WRITE_NOT_ALLOWED' });
  });
});

describe('F27-B prices (products + price_history)', () => {
  it('ADMIN changes a price: the old row is closed the day before, one current row per product and list', async () => {
    const productId = created.products[0];
    const first = await setPrice(admin(), { productId, list: 'MINORISTA', precio: 1000, effectiveFrom: '2026-09-01', userId: users.ADMIN.id! });
    track('price_history', first.id);
    const second = await setPrice(admin(), { productId, list: 'MINORISTA', precio: 1100, effectiveFrom: '2026-10-01', userId: users.ADMIN.id! });
    track('price_history', second.id);
    const current = (await listCurrentPrices(admin())).filter((r) => r.producto_id === productId);
    expect(current).toHaveLength(1);
    expect(Number(current[0].precio)).toBe(1100);
    expect(owner(`SELECT effective_to FROM price_history WHERE id = '${first.id}';`)).toBe('2026-09-30');
  });

  it('an invalid change is refused by the database CHECK and the current price stays intact', async () => {
    const productId = created.products[0];
    const err = await setPrice(admin(), { productId, list: 'MINORISTA', precio: 1200, effectiveFrom: '2026-10-01', userId: users.ADMIN.id! }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetDbError);
    expect(err.code).toBe('CHECK_VIOLATION');
    const current = (await listCurrentPrices(admin())).filter((r) => r.producto_id === productId);
    expect(current.map((r) => Number(r.precio))).toEqual([1100]);
  });

  it('OPERATOR cannot read or change prices', async () => {
    expect(await listCurrentPrices(operator())).toEqual([]);
    const err = await setPrice(operator(), { productId: created.products[0], list: 'MAYORISTA', precio: 1, effectiveFrom: '2026-10-01', userId: users.OPERATOR.id! })
      .catch((e) => e);
    expect(denied(err)).toBe(true);
    expect((await listCurrentPrices(admin())).filter((r) => r.price_list_type === 'MAYORISTA' && r.producto_id === created.products[0])).toEqual([]);
  });
});

describe('F27-B flocks (read-only) and operator assignments', () => {
  let flockId = '';
  let assignmentId = '';

  beforeAll(() => {
    // fixture only: the frozen contract has no frontend write path for flocks
    flockId = track('flocks', owner(`INSERT INTO flocks (shed_id, entry_date, initial_population)
      VALUES ('${created.sheds[0]}', '2026-01-10', 900) RETURNING id;`));
  });

  it('flocks have no frontend write path (no grant, even for ADMIN)', async () => {
    const raw = await admin().from('flocks').update({ initial_population: 1 }).eq('id', flockId).select();
    expect(raw.error).not.toBeNull();
    expect((await listFlocks(admin())).map((f) => f.id)).toContain(flockId);
  });

  it('ADMIN assigns an OPERATOR to a flock; a duplicate pair is refused', async () => {
    const a = await assignOperator(admin(), { operatorId: users.OPERATOR.id!, flockId, userId: users.ADMIN.id! });
    assignmentId = track('operator_assignments', a.id);
    expect(a.activo).toBe(true);
    const dup = await assignOperator(admin(), { operatorId: users.OPERATOR.id!, flockId, userId: users.ADMIN.id! }).catch((e) => e);
    expect(dup.code).toBe('DUPLICATE');
    expect((await listProfiles(admin())).map((p) => p.id)).toContain(users.OPERATOR.id);
  });

  it('OPERATOR sees only its own assignment, its assigned flock and its own profile; it cannot assign', async () => {
    expect((await listOperatorAssignments(operator())).map((a) => a.id)).toEqual([assignmentId]);
    expect((await listFlocks(operator())).map((f) => f.id)).toEqual([flockId]);
    expect((await listProfiles(operator())).map((p) => p.id)).toEqual([users.OPERATOR.id]);
    const err = await assignOperator(operator(), { operatorId: users.OPERATOR.id!, flockId, userId: users.OPERATOR.id! }).catch((e) => e);
    expect(denied(err)).toBe(true);
    const upd = await setAssignmentActive(operator(), assignmentId, false).catch((e) => e);
    expect(upd.code).toBe('NOT_UPDATED');
  });

  it('ADMIN deactivates the assignment: the OPERATOR loses the flock (RLS)', async () => {
    const a = await setAssignmentActive(admin(), assignmentId, false);
    expect(a.activo).toBe(false);
    expect(await listFlocks(operator())).toEqual([]);
  });
});
