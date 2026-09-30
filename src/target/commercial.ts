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
  cliente_nombre: string; lineas: OrderLineRow[];
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

type RawOrder = Omit<OrderRow, 'cliente_nombre' | 'lineas'> & { clients: { nombre: string } | null; pedido_lineas: OrderLineRow[] };
const num = (v: unknown) => Number(v ?? 0);

// ── reads ───────────────────────────────────────────────────────────────────

/** Orders in the given states, with their CURRENT line version (rectified-away versions are history). */
export async function listOrders(client: SupabaseClient, estados: OrderEstado[]): Promise<OrderRow[]> {
  const rows = await readTable<RawOrder>(client, 'pedidos',
    (q) => q.in('estado', estados).order('created_at', { ascending: false }), '*, clients(nombre), pedido_lineas(*)');
  return rows.map(({ clients, pedido_lineas, ...o }) => ({
    ...o,
    cliente_nombre: clients?.nombre ?? '—',
    lineas: (pedido_lineas ?? []).filter((l) => l.is_current)
      .map((l) => ({ ...l, cantidad: num(l.cantidad), precio_unitario: num(l.precio_unitario), subtotal: num(l.subtotal) })),
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
