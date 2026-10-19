/**
 * Phase 27 (F27-C) — commercial flows over the target schema (RPC_CONTRACTS_V1 §COMMERCIAL / §COLLECTIONS,
 * RLS_IMPLEMENTATION_SPEC_V1: pedidos / pedido_lineas / collections / client_ledger are ADMIN-only).
 *
 * Authority split:
 *   - PENDING orders and their lines: the only authorized direct writes (frozen Part 3: a PENDING order is not a
 *     sale and is edited freely). Lines snapshot `precio_unitario` and `producto_nombre` at creation.
 *   - Delivery, cancellation, rectification of a delivered order and collections: RPCs 1–4 only. The backend
 *     derives totals, ledger entries, postings and periods; the frontend sends contract inputs only.
 *   - Balances: `report_balance_period` (client ledger). Sales: `report_sales_line`. Nothing is recomputed here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView, TargetDbError, writeTable } from './db';
import type { PriceList, PriceRow } from './masters';

export type OrderEstado = 'PENDING' | 'DELIVERED' | 'CANCELLED';
export const COLLECTION_METHODS = ['CASH', 'TRANSFER', 'MERCADOPAGO'] as const;   // CHEQUE → receive_cheque (instruments)
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export interface OrderLineRow {
  id: string; pedido_id: string; producto_id: string; producto_nombre: string; cantidad: number; precio_unitario: number;
  subtotal: number; version_seq: number; is_current: boolean;
}
export interface OrderRow {
  id: string; numero_pedido: number | null; cliente_id: string; estado: OrderEstado; delivered_at: string | null;
  delivered_date: string | null; cancelled_date: string | null; rectification_seq: number; created_at: string;
  /** The ADMIN who confirmed the delivery (0100, set by deliver_order); null = no verifiable evidence. */
  delivered_by: string | null;
  /** Email of delivered_by (perfiles, ADMIN-readable); null when unknown or not visible. Never updated_by / created_by. */
  entregado_por_email: string | null;
  cliente_nombre: string; lineas: OrderLineRow[];
  /** Rectifications of a delivered order, oldest first (display only; built from the stored line versions). */
  rectificaciones: OrderRectification[];
}
/** One product's change between two consecutive line versions. */
export interface LineChange {
  producto_id: string; producto_nombre: string; tipo: 'AGREGADO' | 'ELIMINADO' | 'MODIFICADO';
  cantidad_antes: number | null; cantidad_despues: number | null;
  /** null when the price is unchanged, or when the product has more than one price in a version (not comparable). */
  precio_antes: number | null; precio_despues: number | null;
}
/** Version N−1 → N of an order's lines: when (the new version's created_at) and by whom (its created_by). */
export interface OrderRectification {
  version: number; at: string | null; by_email: string | null; by_id: string | null;
  total_antes: number; total_despues: number; cambios: LineChange[];
}
/** A line as entered in the order form. The subtotal is never sent: the database generates it. */
export interface LineInput { producto_id: string; producto_nombre: string; cantidad: number; precio_unitario: number }

export interface CollectionRow {
  id: string; cliente_id: string; cliente_nombre: string; amount: number; payment_method: CollectionMethod | 'CHEQUE';
  receipt_id: string; effective_date: string; created_at: string;
}
export interface ClientBalance { cliente_id: string; cliente_nombre: string; balance: number; period: string }
export interface SalesLineRow {
  business_date: string; period: string; pedido_id: string; numero_pedido: number | null; cliente_id: string; cliente_nombre: string;
  pedido_linea_id: string; producto_id: string; producto_nombre: string; cantidad: number; precio_unitario: number; subtotal: number;
}

/** A stored line of any version, with its author (perfiles is ADMIN-readable; null when not visible). */
export type VersionedLine = OrderLineRow & { created_at?: string | null; created_by?: string | null; perfiles?: { email: string | null } | null };
type RawOrder = Omit<OrderRow, 'cliente_nombre' | 'lineas' | 'rectificaciones' | 'entregado_por_email' | 'delivered_by'>
  & { delivered_by?: string | null; clients: { nombre: string } | null; entrego?: { email: string | null } | null; pedido_lineas: VersionedLine[] };
const num = (v: unknown) => Number(v ?? 0);

/**
 * Rectification history from the stored line versions (version_seq 0 = original, N = Nth rectification). Each version is
 * compared with the PREVIOUS one only; unchanged products are omitted. Presentation only: nothing is sent back.
 */
export function buildRectifications(lines: VersionedLine[]): OrderRectification[] {
  const byVersion = new Map<number, VersionedLine[]>();
  for (const l of lines) {
    const v = num(l.version_seq);
    byVersion.set(v, [...(byVersion.get(v) ?? []), l]);
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b);
  const porProducto = (ls: VersionedLine[]) => {
    const m = new Map<string, { nombre: string; cantidad: number; precios: Set<number> }>();
    for (const l of ls) {
      const e = m.get(l.producto_id) ?? { nombre: l.producto_nombre, cantidad: 0, precios: new Set<number>() };
      e.cantidad += num(l.cantidad);
      e.precios.add(num(l.precio_unitario));
      m.set(l.producto_id, e);
    }
    return m;
  };
  const precio = (p: Set<number> | undefined) => (p && p.size === 1 ? [...p][0] : null);
  const total = (ls: VersionedLine[]) => ls.reduce((t, l) => t + num(l.subtotal), 0);
  const out: OrderRectification[] = [];
  for (let i = 1; i < versions.length; i++) {
    const prev = byVersion.get(versions[i - 1])!;
    const next = byVersion.get(versions[i])!;
    const a = porProducto(prev);
    const b = porProducto(next);
    const cambios: LineChange[] = [];
    for (const [id, x] of a) {
      const y = b.get(id);
      if (!y) {
        cambios.push({ producto_id: id, producto_nombre: x.nombre, tipo: 'ELIMINADO', cantidad_antes: x.cantidad, cantidad_despues: null, precio_antes: precio(x.precios), precio_despues: null });
        continue;
      }
      const pa = precio(x.precios);
      const pb = precio(y.precios);
      const precioCambio = pa !== null && pb !== null && pa !== pb;
      if (x.cantidad !== y.cantidad || precioCambio) {
        cambios.push({ producto_id: id, producto_nombre: y.nombre, tipo: 'MODIFICADO', cantidad_antes: x.cantidad, cantidad_despues: y.cantidad,
          precio_antes: precioCambio ? pa : null, precio_despues: precioCambio ? pb : null });
      }
    }
    for (const [id, y] of b) {
      if (!a.has(id)) cambios.push({ producto_id: id, producto_nombre: y.nombre, tipo: 'AGREGADO', cantidad_antes: null, cantidad_despues: y.cantidad, precio_antes: null, precio_despues: precio(y.precios) });
    }
    const autor = next.find((l) => l.created_by) ?? null;
    const fechas = next.map((l) => l.created_at).filter((d): d is string => !!d).sort();
    out.push({
      version: versions[i], at: fechas[0] ?? null, by_id: autor?.created_by ?? null, by_email: autor?.perfiles?.email ?? null,
      total_antes: total(prev), total_despues: total(next), cambios,
    });
  }
  return out;
}

// ── reads ───────────────────────────────────────────────────────────────────

/** Orders in the given states, with their CURRENT line version and the history of rectified-away versions. */
export async function listOrders(client: SupabaseClient, estados: OrderEstado[]): Promise<OrderRow[]> {
  const rows = await readTable<RawOrder>(client, 'pedidos',
    (q) => q.in('estado', estados).order('created_at', { ascending: false }), '*, clients(nombre), entrego:perfiles!pedidos_delivered_by_fkey(email), pedido_lineas(*, perfiles(email))');
  return rows.map(({ clients, entrego, pedido_lineas, ...o }) => ({
    ...o,
    delivered_by: o.delivered_by ?? null,
    entregado_por_email: o.delivered_by ? entrego?.email ?? null : null,
    cliente_nombre: clients?.nombre ?? '—',
    lineas: (pedido_lineas ?? []).filter((l) => l.is_current)
      .map(({ perfiles: _autor, ...l }) => ({ ...l, cantidad: num(l.cantidad), precio_unitario: num(l.precio_unitario), subtotal: num(l.subtotal) })),
    rectificaciones: buildRectifications(pedido_lineas ?? []),
  }));
}

/** Display total of an order: the sum of the database-generated subtotals of its current lines (the contract's
 * definition of the order total; presentation only, never sent back). */
export function orderTotal(order: Pick<OrderRow, 'lineas'>): number {
  return order.lineas.reduce((s, l) => s + num(l.subtotal), 0);
}

/** The current price of a product in a price list (the price_history row with no end date), if any. */
export function currentPrice(prices: PriceRow[], productoId: string, list: PriceList): number | null {
  const row = prices.find((p) => p.producto_id === productoId && p.price_list_type === list && p.effective_to === null);
  return row ? num(row.precio) : null;
}

/** Latest client balance per client: the closing balance of its most recent period in report_balance_period. */
export async function listClientBalances(client: SupabaseClient): Promise<ClientBalance[]> {
  const rows = await readView<{ entity_id: string; entity_name: string; period: string; closing_balance: number }>(client,
    'report_balance_period', (q) => q.eq('ledger', 'CLIENT').order('period', { ascending: true }));
  const latest = new Map<string, ClientBalance>();
  for (const r of rows) latest.set(r.entity_id, { cliente_id: r.entity_id, cliente_nombre: r.entity_name, balance: num(r.closing_balance), period: r.period });
  return [...latest.values()];
}

export async function listCollections(client: SupabaseClient, limit = 200): Promise<CollectionRow[]> {
  const rows = await readTable<Omit<CollectionRow, 'cliente_nombre'> & { clients: { nombre: string } | null }>(client, 'collections',
    (q) => q.order('created_at', { ascending: false }).limit(limit),
    'id, cliente_id, amount, payment_method, receipt_id, effective_date, created_at, clients(nombre)');
  return rows.map(({ clients, ...c }) => ({ ...c, amount: num(c.amount), cliente_nombre: clients?.nombre ?? '—' }));
}

export async function listSalesLines(client: SupabaseClient, from: string, to: string): Promise<SalesLineRow[]> {
  const rows = await readView<SalesLineRow>(client, 'report_sales_line',
    (q) => q.gte('business_date', from).lte('business_date', to).order('business_date'));
  return rows.map((r) => ({ ...r, cantidad: num(r.cantidad), precio_unitario: num(r.precio_unitario), subtotal: num(r.subtotal) }));
}

// ── PENDING orders (authorized direct writes) ───────────────────────────────

function lineRows(orderId: string, lines: LineInput[], userId: string | null) {
  if (lines.length === 0) throw new TargetDbError('EMPTY_LINE_SET', 'an order needs at least one line');
  return lines.map((l) => ({
    pedido_id: orderId, producto_id: l.producto_id, producto_nombre: l.producto_nombre, cantidad: l.cantidad,
    precio_unitario: l.precio_unitario, created_by: userId,
  }));
}

/**
 * Create a PENDING order and its lines. The target has no order-creation RPC, so if the lines are refused the
 * just-created empty order is cancelled through RPC 3 (it can never be delivered: ORDER_HAS_NO_LINES).
 */
export async function createPendingOrder(client: SupabaseClient, p: { clienteId: string; lines: LineInput[]; userId: string | null }):
  Promise<{ id: string }> {
  if (p.lines.length === 0) throw new TargetDbError('EMPTY_LINE_SET', 'an order needs at least one line');
  const [order] = await writeTable(client, 'pedidos', 'insert', { cliente_id: p.clienteId, estado: 'PENDING', created_by: p.userId }) as { id: string }[];
  try {
    await writeTable(client, 'pedido_lineas', 'insert', lineRows(order.id, p.lines, p.userId));
  } catch (err) {
    await cancelOrder(client, order.id, 'alta de pedido incompleta: líneas rechazadas').catch(() => undefined);
    throw err;
  }
  return order;
}

/**
 * Replace the client and the lines of a PENDING order. New lines are inserted before the old ones are removed, so
 * the order never passes through an empty state; RLS refuses every write once the order is no longer PENDING.
 */
export async function updatePendingOrder(client: SupabaseClient, p: {
  orderId: string; clienteId: string; lines: LineInput[]; previousLineIds: string[]; userId: string | null;
}): Promise<void> {
  const updated = await writeTable(client, 'pedidos', 'update',
    { cliente_id: p.clienteId, updated_at: new Date().toISOString(), updated_by: p.userId }, { id: p.orderId });
  if (updated.length === 0) throw new TargetDbError('NOT_UPDATED', `pedido ${p.orderId}`);
  await writeTable(client, 'pedido_lineas', 'insert', lineRows(p.orderId, p.lines, p.userId));
  for (const id of p.previousLineIds) await writeTable(client, 'pedido_lineas', 'delete', null, { id });
}

// ── state transitions and collections (RPCs 1–4) ────────────────────────────

export function deliverOrder(client: SupabaseClient, orderId: string, deliveredAt = new Date().toISOString(), reason: string | null = null) {
  return callRpc<{ id: string; estado: 'DELIVERED'; delivered_date: string; order_total: number }>(client, 'deliver_order',
    { p_order_id: orderId, p_delivered_at: deliveredAt, p_reason: reason });
}

export function cancelOrder(client: SupabaseClient, orderId: string, reason: string | null, cancelledAt = new Date().toISOString()) {
  return callRpc<{ id: string; estado: 'CANCELLED' }>(client, 'cancel_order', { p_order_id: orderId, p_cancelled_at: cancelledAt, p_reason: reason });
}

export function rectifyDeliveredOrder(client: SupabaseClient, orderId: string, lines: LineInput[], reason: string) {
  return callRpc<{ id: string; version_seq: number; previous_total: number; new_total: number; adjustment: number }>(client,
    'rectify_delivered_order', {
      p_order_id: orderId,
      p_new_lines: lines.map((l) => ({ producto_id: l.producto_id, cantidad: l.cantidad, precio_unitario: l.precio_unitario })),
      p_reason: reason,
    });
}

export function registerCollection(client: SupabaseClient, p: {
  clienteId: string; amount: number; method: CollectionMethod; receiptId: string; effectiveDate: string; accountId: string; reason?: string | null;
}) {
  return callRpc<{ collection_id: string; financial_operation_id: string; client_ledger_id: string }>(client, 'register_collection', {
    p_cliente_id: p.clienteId, p_amount: p.amount, p_payment_method: p.method, p_receipt_id: p.receiptId,
    p_effective_date: p.effectiveDate, p_financial_account_id: p.accountId, p_reason: p.reason && p.reason.trim() !== '' ? p.reason.trim() : null,
  });
}
