import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TargetDbError } from '../../src/target/db';
import {
  buildRectifications, COLLECTION_METHODS, createPendingOrder, currentPrice, listClientBalances, listOrders, orderTotal, rectifyDeliveredOrder,
  registerCollection, updatePendingOrder, type LineInput, type VersionedLine,
} from '../../src/target/commercial';
import type { PriceRow } from '../../src/target/masters';

/** PostgREST-shaped stub recording every write / rpc, answering from a queue. */
function stub(results: { data: unknown; error: unknown }[] = []) {
  const calls: { kind: string; table?: string; payload?: unknown; match?: unknown; fn?: string; args?: unknown }[] = [];
  const next = () => results.shift() ?? { data: [], error: null };
  const client = {
    from(table: string) {
      const q: any = {
        select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, gte: () => q, lte: () => q, is: () => q,
        insert: (payload: unknown) => { calls.push({ kind: 'insert', table, payload }); return { select: async () => next() }; },
        update: (payload: unknown) => ({ match: (match: unknown) => { calls.push({ kind: 'update', table, payload, match }); return { select: async () => next() }; } }),
        delete: () => ({ match: (match: unknown) => { calls.push({ kind: 'delete', table, match }); return { select: async () => next() }; } }),
        then: (res: (v: unknown) => void) => { calls.push({ kind: 'select', table }); res(next()); },
      };
      return q;
    },
    rpc: async (fn: string, args: unknown) => { calls.push({ kind: 'rpc', fn, args }); return next(); },
  };
  return { client: client as never, calls };
}
const L: LineInput = { producto_id: 'p1', producto_nombre: 'Maple N1', cantidad: 2, precio_unitario: 1000 };

describe('F27-C commercial data layer', () => {
  it('orderTotal is only the sum of the database-generated subtotals (presentation)', () => {
    expect(orderTotal({ lineas: [{ subtotal: 1500 }, { subtotal: 250.5 }] as never })).toBe(1750.5);
  });

  it('currentPrice picks the open price_history row of the chosen list only', () => {
    const prices = [
      { producto_id: 'p1', price_list_type: 'MINORISTA', precio: 1000, effective_to: null },
      { producto_id: 'p1', price_list_type: 'MINORISTA', precio: 900, effective_to: '2026-08-31' },
      { producto_id: 'p1', price_list_type: 'MAYORISTA', precio: 800, effective_to: null },
    ] as PriceRow[];
    expect(currentPrice(prices, 'p1', 'MINORISTA')).toBe(1000);
    expect(currentPrice(prices, 'p1', 'MAYORISTA')).toBe(800);
    expect(currentPrice(prices, 'p2', 'MINORISTA')).toBeNull();
  });

  it('client balance = the latest closing balance of report_balance_period (no recomputation)', async () => {
    const { client } = stub([{ data: [
      { entity_id: 'c1', entity_name: 'A', period: '2026-08-01', closing_balance: 5000 },
      { entity_id: 'c1', entity_name: 'A', period: '2026-09-01', closing_balance: 1200 },
      { entity_id: 'c2', entity_name: 'B', period: '2026-09-01', closing_balance: -300 },
    ], error: null }]);
    expect(await listClientBalances(client)).toEqual([
      { cliente_id: 'c1', cliente_nombre: 'A', balance: 1200, period: '2026-09-01' },
      { cliente_id: 'c2', cliente_nombre: 'B', balance: -300, period: '2026-09-01' },
    ]);
  });

  it('a PENDING order is written as order + lines; the subtotal is never sent', async () => {
    const { client, calls } = stub([{ data: [{ id: 'o1' }], error: null }, { data: [{}], error: null }]);
    await createPendingOrder(client, { clienteId: 'c1', lines: [L], userId: 'u' });
    expect(calls).toEqual([
      { kind: 'insert', table: 'pedidos', payload: { cliente_id: 'c1', estado: 'PENDING', created_by: 'u' } },
      { kind: 'insert', table: 'pedido_lineas', payload: [{ pedido_id: 'o1', producto_id: 'p1', producto_nombre: 'Maple N1', cantidad: 2, precio_unitario: 1000, created_by: 'u' }] },
    ]);
  });

  it('an order without lines is refused before any request', async () => {
    const { client, calls } = stub();
    await expect(createPendingOrder(client, { clienteId: 'c1', lines: [], userId: 'u' })).rejects.toMatchObject({ code: 'EMPTY_LINE_SET' });
    expect(calls).toEqual([]);
  });

  it('refused lines cancel the half-created order through cancel_order (RPC 3), and the error surfaces', async () => {
    const { client, calls } = stub([{ data: [{ id: 'o1' }], error: null }, { data: null, error: { code: '23514', message: 'check' } }, { data: {}, error: null }]);
    await expect(createPendingOrder(client, { clienteId: 'c1', lines: [L], userId: 'u' })).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    expect(calls.at(-1)).toMatchObject({ kind: 'rpc', fn: 'cancel_order', args: { p_order_id: 'o1' } });
  });

  it('editing a PENDING order inserts the new lines before deleting the old ones; a non-PENDING order is NOT_UPDATED', async () => {
    const ok = stub([{ data: [{ id: 'o1' }], error: null }, { data: [{}], error: null }, { data: [{}], error: null }]);
    await updatePendingOrder(ok.client, { orderId: 'o1', clienteId: 'c1', lines: [L], previousLineIds: ['l-old'], userId: 'u' });
    expect(ok.calls.map((c) => `${c.kind}:${c.table}`)).toEqual(['update:pedidos', 'insert:pedido_lineas', 'delete:pedido_lineas']);
    const refused = stub([{ data: [], error: null }]);
    const err = await updatePendingOrder(refused.client, { orderId: 'o1', clienteId: 'c1', lines: [L], previousLineIds: [], userId: 'u' }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetDbError);
    expect(err.code).toBe('NOT_UPDATED');
    expect(refused.calls).toHaveLength(1);
  });

  it('rectification sends only the contract fields of each line to rectify_delivered_order', async () => {
    const { client, calls } = stub([{ data: {}, error: null }]);
    await rectifyDeliveredOrder(client, 'o1', [L], 'motivo');
    expect(calls).toEqual([{ kind: 'rpc', fn: 'rectify_delivered_order', args: {
      p_order_id: 'o1', p_new_lines: [{ producto_id: 'p1', cantidad: 2, precio_unitario: 1000 }], p_reason: 'motivo',
    } }]);
  });

  it('collections go through register_collection only; cheques are not offered (receive_cheque owns them)', async () => {
    expect([...COLLECTION_METHODS]).toEqual(['CASH', 'TRANSFER', 'MERCADOPAGO']);
    const { client, calls } = stub([{ data: {}, error: null }]);
    await registerCollection(client, { clienteId: 'c1', amount: 500, method: 'TRANSFER', receiptId: 'R-1', effectiveDate: '2026-09-30', accountId: 'a1', reason: '  ' });
    expect(calls).toEqual([{ kind: 'rpc', fn: 'register_collection', args: {
      p_cliente_id: 'c1', p_amount: 500, p_payment_method: 'TRANSFER', p_receipt_id: 'R-1', p_effective_date: '2026-09-30', p_financial_account_id: 'a1', p_reason: null,
    } }]);
  });
});

describe('Pedidos — rectification history (display only, from the stored line versions)', () => {
  let n = 0;
  const line = (v: number, producto: string, cantidad: number, precio: number, extra: Partial<VersionedLine> = {}): VersionedLine => ({
    id: `l${n++}`, pedido_id: 'o1', producto_id: producto, producto_nombre: `Prod ${producto}`, cantidad, precio_unitario: precio,
    subtotal: cantidad * precio, version_seq: v, is_current: false, ...extra,
  });

  it('no rectification: nothing to show', () => {
    expect(buildRectifications([line(0, 'a', 2, 100, { is_current: true })])).toEqual([]);
  });

  it('compares each version with the PREVIOUS one, oldest first, omitting unchanged products', () => {
    const r = buildRectifications([
      // deliberately unordered input
      line(2, 'a', 1, 100, { is_current: true, created_at: '2026-10-15T15:00:00Z', created_by: 'u2', perfiles: { email: 'b@x' } }),
      line(2, 'b', 5, 50, { is_current: true, created_at: '2026-10-15T15:00:00Z', created_by: 'u2', perfiles: { email: 'b@x' } }),
      line(0, 'a', 3, 100), line(0, 'b', 5, 50),
      line(1, 'a', 2, 100, { created_at: '2026-10-14T12:00:00Z', created_by: 'u1', perfiles: { email: 'a@x' } }),
      line(1, 'b', 5, 50, { created_at: '2026-10-14T12:00:00Z', created_by: 'u1', perfiles: { email: 'a@x' } }),
    ]);
    expect(r.map((x) => [x.version, x.at, x.by_email])).toEqual([[1, '2026-10-14T12:00:00Z', 'a@x'], [2, '2026-10-15T15:00:00Z', 'b@x']]);
    // v1: 3 → 2 (vs the original); v2: 2 → 1 (vs v1, never vs the original); product b unchanged → omitted
    expect(r[0].cambios).toEqual([{ producto_id: 'a', producto_nombre: 'Prod a', tipo: 'MODIFICADO', cantidad_antes: 3, cantidad_despues: 2, precio_antes: null, precio_despues: null }]);
    expect(r[1].cambios).toEqual([{ producto_id: 'a', producto_nombre: 'Prod a', tipo: 'MODIFICADO', cantidad_antes: 2, cantidad_despues: 1, precio_antes: null, precio_despues: null }]);
    expect([r[0].total_antes, r[0].total_despues, r[1].total_antes, r[1].total_despues]).toEqual([550, 450, 450, 350]);
  });

  it('price changes, added and removed products', () => {
    const [r] = buildRectifications([
      line(0, 'a', 2, 100), line(0, 'b', 1, 300),
      line(1, 'a', 2, 120, { is_current: true }), line(1, 'c', 4, 10, { is_current: true }),
    ]);
    expect(r.cambios).toEqual([
      { producto_id: 'a', producto_nombre: 'Prod a', tipo: 'MODIFICADO', cantidad_antes: 2, cantidad_despues: 2, precio_antes: 100, precio_despues: 120 },
      { producto_id: 'b', producto_nombre: 'Prod b', tipo: 'ELIMINADO', cantidad_antes: 1, cantidad_despues: null, precio_antes: 300, precio_despues: null },
      { producto_id: 'c', producto_nombre: 'Prod c', tipo: 'AGREGADO', cantidad_antes: null, cantidad_despues: 4, precio_antes: null, precio_despues: 10 },
    ]);
    expect([r.total_antes, r.total_despues]).toEqual([500, 280]);
  });

  it('missing author / email / date stay null (never invented); the rectifier is the new version author, not the deliverer', () => {
    const [r] = buildRectifications([line(0, 'a', 1, 100), line(1, 'a', 2, 100, { created_by: 'u9', perfiles: null })]);
    expect([r.at, r.by_id, r.by_email]).toEqual([null, 'u9', null]);
  });

  it('listOrders keeps only the current lines for totals and adds the history (author email embedded, ADMIN RLS unchanged)', async () => {
    const { client } = stub([{ data: [{
      id: 'o1', numero_pedido: null, cliente_id: 'c1', estado: 'DELIVERED', delivered_at: 'x', delivered_date: '2026-10-14', cancelled_date: null,
      rectification_seq: 1, created_at: 'y', clients: { nombre: 'Cliente' },
      pedido_lineas: [line(0, 'a', 3, '100' as never, { subtotal: '300' as never }), line(1, 'a', 2, 100, { is_current: true, created_by: 'u1', perfiles: { email: 'a@x' } })],
    }], error: null }]);
    const [o] = await listOrders(client, ['DELIVERED']);
    expect(o.lineas.map((l) => [l.version_seq, l.cantidad])).toEqual([[1, 2]]);
    expect(o.lineas[0]).not.toHaveProperty('perfiles');
    expect(orderTotal(o)).toBe(200);
    expect(o.rectificaciones).toHaveLength(1);
    expect(o.rectificaciones[0]).toMatchObject({ version: 1, by_email: 'a@x', total_antes: 300, total_despues: 200 });
  });
});

describe('F27-C migrated files carry no legacy or duplicated authority', () => {
  const SRC = resolve(__dirname, '../../src');
  const FILES = ['target/commercial.ts', 'features/pedidos/PedidosApp.tsx', 'features/pedidos/FormPedido.tsx', 'features/pedidos/DashboardPedidos.tsx',
    'features/pedidos/useCommercial.ts', 'features/cobros/CobrosApp.tsx', 'features/cobros/ListaSaldosClientes.tsx', 'features/cobros/RegistroPagoModal.tsx'];

  it.each(FILES)('%s: no legacy relation / hook / role, no direct PostgREST call, no delivery or balance computation', (f) => {
    const text = readFileSync(resolve(SRC, f), 'utf8');
    for (const n of ['clientes', 'productos', 'pagos', 'pago_en_caja', 'movimientos_caja', 'precios_actuales', 'dueño', 'colaborador', 'repartidor', 'marcar_pedido_entregado']) {
      expect(text).not.toMatch(new RegExp(`['"\`]${n}['"\`]`));
    }
    expect(text).not.toMatch(/(?<!Array)\.from\(/);
    expect(text).not.toMatch(/hooks\/use(Clientes|Productos|Pagos|ClientesSaldo|Pedidos)\b|api\/(pedidos|pagos|clientes)\b|pedidosCalculos/);
    expect(text).not.toMatch(/totalPagado|totalPedidos|calcularHuevos|huevos/i);
  });

  it('the legacy commercial authorities are gone', () => {
    for (const f of ['hooks/useClientesSaldo.ts', 'hooks/usePagos.ts', 'hooks/useClientes.ts', 'hooks/useProductos.ts', 'api/clientes.ts',
      'features/pedidos/pedidosCalculos.ts', 'features/pedidos/PedidoCard.tsx', 'features/pedidos/ListaPedidos.tsx',
      'features/cobros/ListaClientes.tsx', 'features/cobros/ListaFinalizados.tsx', 'features/cobros/ListaClientesConCredito.tsx']) {
      expect(existsSync(resolve(SRC, f)), f).toBe(false);
    }
    // api/pedidos.ts stayed as a read-only P&L source after F27-C and was removed in F27-G
    expect(existsSync(resolve(SRC, 'api/pedidos.ts'))).toBe(false);
    // api/pagos.ts was reduced to a Caja helper in F27-C and removed entirely in F27-D
    const pagosPath = resolve(SRC, 'api/pagos.ts');
    if (existsSync(pagosPath)) expect(readFileSync(pagosPath, 'utf8')).not.toMatch(/from\('pagos'\)/);
  });
});
