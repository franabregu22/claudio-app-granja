/**
 * F27-C integration: commercial flows through the frontend data layer (src/target/commercial.ts) against the
 * guarded LOCAL stack only (127.0.0.1, local demo keys read from the running container). A PENDING order is
 * created and edited, delivered (RPC 1), rectified (RPC 2), collected (RPC 4) and the balance comes from
 * report_balance_period; cancellation is RPC 3. OPERATOR is refused by the database at every step.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:integration
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { callRpc, readView, TargetDbError, writeTable } from '../../src/target/db';
import {
  cancelOrder, createPendingOrder, currentPrice, deliverOrder, listClientBalances, listCollections, listOrders, listSalesLines, orderTotal,
  rectifyDeliveredOrder, registerCollection, updatePendingOrder, type LineInput,
} from '../../src/target/commercial';
import { createMaster, listCurrentPrices, listMaster, setPrice } from '../../src/target/masters';

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
const TAG = `F27C-${run}`;
const password = `F27c-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `f27c-admin-${run}@example.invalid` },
  OPERATOR: { email: `f27c-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const today = () => owner(`SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;`);
const fx = { clientId: '', productId: '', productName: `${TAG} maple`, accountId: '' };
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const denied = (e: unknown) => e instanceof TargetDbError && ['PERMISSION_DENIED', 'RLS_DENIED', 'FORBIDDEN'].includes(e.code);
const line = (cantidad: number, precio: number): LineInput => ({ producto_id: fx.productId, producto_nombre: fx.productName, cantidad, precio_unitario: precio });
const balanceOf = async (c: SupabaseClient) => (await listClientBalances(c)).find((b) => b.cliente_id === fx.clientId)?.balance;

const CLIENTS = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
DELETE FROM audit_events WHERE entity_type = 'pedido' AND entity_id IN (SELECT id::TEXT FROM pedidos WHERE cliente_id IN ${CLIENTS});
DELETE FROM audit_events WHERE entity_type = 'collections' AND entity_id IN (SELECT id::TEXT FROM collections WHERE cliente_id IN ${CLIENTS});
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM financial_operation WHERE external_ref LIKE '${TAG}%');
DELETE FROM financial_operation WHERE external_ref LIKE '${TAG}%';
DELETE FROM collections WHERE cliente_id IN ${CLIENTS};
DELETE FROM client_ledger WHERE reversal_of_id IS NOT NULL AND cliente_id IN ${CLIENTS};
DELETE FROM client_ledger WHERE cliente_id IN ${CLIENTS};
DELETE FROM pedido_lineas WHERE pedido_id IN (SELECT id FROM pedidos WHERE cliente_id IN ${CLIENTS});
DELETE FROM pedidos WHERE cliente_id IN ${CLIENTS};
DELETE FROM price_history WHERE producto_id IN (SELECT id FROM products WHERE nombre LIKE '${TAG}%');
DELETE FROM products WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
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
  // masters through the F27-B layer (ADMIN)
  fx.clientId = (await createMaster<{ id: string }>(admin(), 'clients', { nombre: `${TAG} cliente` })).id;
  fx.productId = (await createMaster<{ id: string }>(admin(), 'products', { nombre: fx.productName, product_type: 'VENDIBLE', unit_type: 'CARTON' })).id;
  fx.accountId = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} caja`, account_type: 'CASH' })).id;
  await setPrice(admin(), { productId: fx.productId, list: 'MINORISTA', precio: 1000, effectiveFrom: '2026-09-01', userId: users.ADMIN.id! });
});

afterAll(async () => {
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  if (ids.length) owner(`DELETE FROM perfiles WHERE id IN (${ids.map((i) => `'${i}'`).join(',')});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

describe('F27-C commercial flow (ADMIN)', () => {
  let orderId = '';

  it('reads clients / products / current price from the target masters; OPERATOR reads none of them', async () => {
    expect((await listMaster<{ id: string }>(admin(), 'clients')).map((c) => c.id)).toContain(fx.clientId);
    expect((await listMaster<{ id: string }>(admin(), 'products')).map((p) => p.id)).toContain(fx.productId);
    expect(currentPrice(await listCurrentPrices(admin()), fx.productId, 'MINORISTA')).toBe(1000);
    expect(currentPrice(await listCurrentPrices(admin()), fx.productId, 'MAYORISTA')).toBeNull();
    expect(await listMaster(operator(), 'clients')).toEqual([]);
    expect(await listCurrentPrices(operator())).toEqual([]);
  });

  it('creates a PENDING order whose line snapshots the current price; the total is the database subtotal', async () => {
    const price = currentPrice(await listCurrentPrices(admin()), fx.productId, 'MINORISTA')!;
    orderId = (await createPendingOrder(admin(), { clienteId: fx.clientId, lines: [line(3, price)], userId: users.ADMIN.id! })).id;
    const [o] = (await listOrders(admin(), ['PENDING'])).filter((x) => x.id === orderId);
    expect(o.estado).toBe('PENDING');
    expect(o.lineas.map((l) => [l.producto_nombre, l.cantidad, l.precio_unitario, l.subtotal])).toEqual([[fx.productName, 3, 1000, 3000]]);
    expect(orderTotal(o)).toBe(3000);
  });

  it('edits the PENDING order: new lines replace the old ones, still PENDING', async () => {
    const [o] = (await listOrders(admin(), ['PENDING'])).filter((x) => x.id === orderId);
    await updatePendingOrder(admin(), { orderId, clienteId: fx.clientId, lines: [line(4, 1000)], previousLineIds: o.lineas.map((l) => l.id), userId: users.ADMIN.id! });
    const [after] = (await listOrders(admin(), ['PENDING'])).filter((x) => x.id === orderId);
    expect(after.lineas.map((l) => l.cantidad)).toEqual([4]);
    expect(orderTotal(after)).toBe(4000);
  });

  it('OPERATOR is refused by the database: no order write, no RPC, no commercial read', async () => {
    expect(denied(await createPendingOrder(operator(), { clienteId: fx.clientId, lines: [line(1, 1)], userId: users.OPERATOR.id! }).catch((e) => e))).toBe(true);
    expect(code(await deliverOrder(operator(), orderId).catch((e) => e))).toBe('FORBIDDEN');
    expect(code(await cancelOrder(operator(), orderId, 'x').catch((e) => e))).toBe('FORBIDDEN');
    expect(code(await registerCollection(operator(), { clienteId: fx.clientId, amount: 1, method: 'CASH', receiptId: `${TAG}-op`, effectiveDate: today(), accountId: fx.accountId }).catch((e) => e))).toBe('FORBIDDEN');
    expect(await listOrders(operator(), ['PENDING', 'DELIVERED'])).toEqual([]);
    expect(await readView(operator(), 'report_sales_line')).toEqual([]);
    expect(await listClientBalances(operator())).toEqual([]);
  });

  it('delivers through deliver_order: the backend total, the sale in report_sales_line, the balance in report_balance_period', async () => {
    const r = await deliverOrder(admin(), orderId);
    expect(r.estado).toBe('DELIVERED');
    expect(Number(r.order_total)).toBe(4000);
    expect(code(await deliverOrder(admin(), orderId).catch((e) => e))).toBe('ORDER_NOT_PENDING');
    const sales = (await listSalesLines(admin(), '2026-01-01', today())).filter((s) => s.pedido_id === orderId);
    expect(sales.map((s) => [s.cantidad, s.precio_unitario, s.subtotal])).toEqual([[4, 1000, 4000]]);
    expect(await balanceOf(admin())).toBe(4000);
  });

  it('a DELIVERED order can no longer be edited directly (RLS): NOT_UPDATED, lines unchanged', async () => {
    const [o] = (await listOrders(admin(), ['DELIVERED'])).filter((x) => x.id === orderId);
    const err = await updatePendingOrder(admin(), { orderId, clienteId: fx.clientId, lines: [line(9, 1)], previousLineIds: o.lineas.map((l) => l.id), userId: users.ADMIN.id! })
      .catch((e) => e);
    expect(code(err)).toBe('NOT_UPDATED');
    const [after] = (await listOrders(admin(), ['DELIVERED'])).filter((x) => x.id === orderId);
    expect(after.lineas.map((l) => l.cantidad)).toEqual([4]);
  });

  it('a later price change never restates the delivered sale (snapshot authority)', async () => {
    await setPrice(admin(), { productId: fx.productId, list: 'MINORISTA', precio: 1500, effectiveFrom: today(), userId: users.ADMIN.id! });
    expect(currentPrice(await listCurrentPrices(admin()), fx.productId, 'MINORISTA')).toBe(1500);
    const sales = (await listSalesLines(admin(), '2026-01-01', today())).filter((s) => s.pedido_id === orderId);
    expect(sales.map((s) => s.precio_unitario)).toEqual([1000]);
  });

  it('rectifies the delivered order through rectify_delivered_order (reason required); the balance follows', async () => {
    expect(code(await rectifyDeliveredOrder(admin(), orderId, [line(2, 1000)], ' ').catch((e) => e))).toBe('REASON_REQUIRED');
    const r = await rectifyDeliveredOrder(admin(), orderId, [line(2, 1000)], 'devolvieron 2 maples');
    expect(Number(r.new_total)).toBe(2000);
    const [o] = (await listOrders(admin(), ['DELIVERED'])).filter((x) => x.id === orderId);
    expect(o.rectification_seq).toBe(1);
    expect(orderTotal(o)).toBe(2000);
    expect(await balanceOf(admin())).toBe(2000);
  });

  it('registers a collection through register_collection; duplicates and cheques are refused deterministically', async () => {
    await registerCollection(admin(), { clienteId: fx.clientId, amount: 500, method: 'CASH', receiptId: `${TAG}-r1`, effectiveDate: today(), accountId: fx.accountId, reason: 'a cuenta' });
    expect(await balanceOf(admin())).toBe(1500);
    expect((await listCollections(admin())).find((c) => c.receipt_id === `${TAG}-r1`)?.amount).toBe(500);
    expect(code(await registerCollection(admin(), { clienteId: fx.clientId, amount: 1, method: 'CASH', receiptId: `${TAG}-r1`, effectiveDate: today(), accountId: fx.accountId }).catch((e) => e)))
      .toBe('DUPLICATE_RECEIPT');
    expect(code(await registerCollection(admin(), { clienteId: fx.clientId, amount: 0, method: 'CASH', receiptId: `${TAG}-r2`, effectiveDate: today(), accountId: fx.accountId }).catch((e) => e)))
      .toBe('INVALID_AMOUNT');
    const cheque = await callRpc(admin(), 'register_collection', {
      p_cliente_id: fx.clientId, p_amount: 10, p_payment_method: 'CHEQUE', p_receipt_id: `${TAG}-r3`, p_effective_date: today(), p_financial_account_id: fx.accountId,
    }).catch((e) => e);
    expect(code(cheque)).toBe('USE_RECEIVE_CHEQUE');
    expect(await balanceOf(admin())).toBe(1500);
  });

  it('cancels a PENDING order through cancel_order; a DELIVERED order cannot be cancelled', async () => {
    const pending = (await createPendingOrder(admin(), { clienteId: fx.clientId, lines: [line(1, 1000)], userId: users.ADMIN.id! })).id;
    expect((await cancelOrder(admin(), pending, 'cliente no lo quiso')).estado).toBe('CANCELLED');
    expect((await listOrders(admin(), ['CANCELLED'])).map((o) => o.id)).toContain(pending);
    expect(code(await cancelOrder(admin(), orderId, 'x').catch((e) => e))).toBe('ONLY_PENDING_CAN_CANCEL');
    expect(await balanceOf(admin())).toBe(1500);
  });

  it('deterministic failures: an order without lines cannot be delivered; refused lines cancel the half-created order', async () => {
    const [empty] = await writeTable(admin(), 'pedidos', 'insert', { cliente_id: fx.clientId, estado: 'PENDING' }) as { id: string }[];
    expect(code(await deliverOrder(admin(), empty.id).catch((e) => e))).toBe('ORDER_HAS_NO_LINES');
    await cancelOrder(admin(), empty.id, 'fixture');
    const before = new Set((await listOrders(admin(), ['CANCELLED'])).map((o) => o.id));
    const err = await createPendingOrder(admin(), { clienteId: fx.clientId, lines: [line(0, 1000)], userId: users.ADMIN.id! }).catch((e) => e);
    expect(code(err)).toBe('CHECK_VIOLATION');
    const cancelled = (await listOrders(admin(), ['CANCELLED'])).filter((o) => !before.has(o.id));
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].lineas).toEqual([]);
    expect((await listOrders(admin(), ['PENDING'])).filter((o) => o.cliente_id === fx.clientId)).toEqual([]);
  });
});

describe('F27-C cleanup', () => {
  it('fixture cleanup leaves no commercial row of this run behind', () => {
    cleanup();
    expect(owner(`SELECT (SELECT count(*) FROM pedidos WHERE cliente_id IN ${CLIENTS}) + (SELECT count(*) FROM collections WHERE receipt_id LIKE '${TAG}%')
      + (SELECT count(*) FROM financial_operation WHERE external_ref LIKE '${TAG}%') + (SELECT count(*) FROM clients WHERE nombre LIKE '${TAG}%')
      + (SELECT count(*) FROM products WHERE nombre LIKE '${TAG}%');`)).toBe('0');
  });
});
