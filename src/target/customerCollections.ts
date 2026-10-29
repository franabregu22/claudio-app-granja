/**
 * Caja → Cobros de clientes (0092): every client collection, read from the view fin_customer_collections (ADMIN). Manual
 * collections (cash, bank, legacy manual Mercado Pago) and client allocations of Mercado Pago receipts. A corrected manual
 * Mercado Pago collection and the components that replace it (allocation of the real MP payment / cash / partner
 * withdrawal side) are shown as ONE logical collection. Read-only: nothing is computed for the balance here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readTable, readView } from './db';

export type CustomerCollectionOrigin = 'CORRECTION' | 'CASH' | 'BANK' | 'MANUAL_MP' | 'AUTO_MP';
export type CustomerCollectionStatus = 'CORRECTED' | 'MANUAL_WITHOUT_SOURCE' | 'CONCILIATED' | 'PENDING_RECONCILIATION' | 'CASH' | 'ALLOCATED_TO_CUSTOMER'
  | 'ANNULLED' | 'RECTIFIED';   // 0108
export type CorrectionRole = 'CORRECTED_ORIGINAL' | 'COMPONENT' | 'SINGLE';

export interface CustomerCollectionRow {
  row_id: string; business_date: string; created_at: string; cliente_id: string; client_name: string; amount: number;
  account_name: string; account_type: string; payment_method: string; notes: string | null; financial_operation_id: number | null;
  source_id: string | null; origin: CustomerCollectionOrigin; status: CustomerCollectionStatus; correction_id: string | null;
  correction_role: CorrectionRole; counts_for_customer: boolean;
  /** 0108: an annulled / rectified manual collection (kind, reason, when) and, on a replacement, the original's row_id */
  reversal_kind: 'ANNUL' | 'RECTIFY' | null; reversal_reason: string | null; reversal_at: string | null; replacement_of: string | null;
  /** 0108: the Feria session of a Feria collection (collections.sales_session_id, 0032 / 0070); null otherwise */
  sales_session_id: string | null;
}
const COLUMNS = 'row_id, business_date, created_at, cliente_id, client_name, amount, account_name, account_type, payment_method, notes, '
  + 'financial_operation_id, source_id, origin, status, correction_id, correction_role, counts_for_customer, reversal_kind, reversal_reason, reversal_at, replacement_of, sales_session_id';

export const COLLECTION_STATUS_LABEL: Record<CustomerCollectionStatus, string> = {
  CORRECTED: 'Corregido', MANUAL_WITHOUT_SOURCE: 'Manual sin movimiento de Mercado Pago', CONCILIATED: 'Conciliado',
  PENDING_RECONCILIATION: 'Pendiente de conciliar', CASH: 'Efectivo', ALLOCATED_TO_CUSTOMER: 'Asignado desde Mercado Pago',
  ANNULLED: 'Anulado', RECTIFIED: 'Rectificado',
};
export const COLLECTION_ORIGIN_LABEL: Record<CustomerCollectionOrigin, string> = {
  CORRECTION: 'Corrección', CASH: 'Caja', BANK: 'Banco', MANUAL_MP: 'Manual en Mercado Pago', AUTO_MP: 'Mercado Pago',
};
export const COLLECTION_METHOD_LABEL: Record<string, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', MERCADOPAGO: 'Mercado Pago', CHEQUE: 'Cheque' };

/** The collections of a date range (business date, inclusive), newest first. */
export async function listCustomerCollections(client: SupabaseClient, p: { from: string; to: string }): Promise<CustomerCollectionRow[]> {
  const rows = await readView<CustomerCollectionRow>(client, 'fin_customer_collections', (q) => q.gte('business_date', p.from).lte('business_date', p.to)
    .order('business_date', { ascending: false }).order('created_at', { ascending: false }), COLUMNS);
  return rows.map((r) => ({ ...r, amount: Number(r.amount), financial_operation_id: r.financial_operation_id === null ? null : Number(r.financial_operation_id) }));
}

/**
 * Cuentas corrientes detail: every collection that counts for the client's balance (counts_for_customer), manual and Mercado
 * Pago allocations alike, plus — as evidence only — the annulled / rectified originals (0108: reversal_kind set,
 * counts_for_customer false), newest first. A 0092 corrected original is left out: its components are what count.
 */
export async function listClientCollections(client: SupabaseClient): Promise<CustomerCollectionRow[]> {
  const rows = await readView<CustomerCollectionRow>(client, 'fin_customer_collections', (q) => q.or('counts_for_customer.eq.true,reversal_kind.not.is.null')
    .order('business_date', { ascending: false }).order('created_at', { ascending: false }), COLUMNS);
  return rows.map((r) => ({ ...r, amount: Number(r.amount), financial_operation_id: r.financial_operation_id === null ? null : Number(r.financial_operation_id) }));
}

/**
 * The Mercado Pago allocation behind a row (0092 defines row_id = 'A:' || mp_client_allocation.id), or null for a manual
 * collection ('C:'). Nothing else is inferred.
 */
export function allocationIdOf(row: Pick<CustomerCollectionRow, 'row_id'>): string | null {
  const m = /^A:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(row.row_id);
  return m ? m[1] : null;
}

/**
 * "Anular cobro" (Lote 1D) is offered only for a Mercado Pago allocation that is not part of a collection correction
 * (0092 groups those) and still has something to reverse. The view's amount for an allocation is already its net
 * (allocation − reversals) = exactly what mp_reverse_client_allocation accepts as the reversible remainder.
 */
export function canAnnulMpAllocation(row: CustomerCollectionRow): boolean {
  return allocationIdOf(row) !== null && row.origin === 'AUTO_MP' && row.correction_id === null && row.amount > 0;
}

/** The manual collection behind a row ('C:' || collections.id, 0092), or null for a Mercado Pago allocation. */
export function collectionIdOf(row: Pick<CustomerCollectionRow, 'row_id'>): string | null {
  const m = /^C:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(row.row_id);
  return m ? m[1] : null;
}

/**
 * "Anular" / "Rectificar" (Lote 1E, 0108) are offered for a manual cash or bank collection that still counts, is not part
 * of a 0092 correction, is not a Feria collection (corrected through its closing) and is not reconciled with a bank
 * statement. The server re-checks everything (and also refuses a closed period, which the view does not expose).
 */
export function canReverseManualCollection(row: CustomerCollectionRow): boolean {
  return collectionIdOf(row) !== null && (row.account_type === 'CASH' || row.account_type === 'BANK_ACCOUNT') && row.counts_for_customer
    && row.correction_id === null && row.reversal_kind === null && row.sales_session_id === null && row.status !== 'CONCILIATED';
}

/** One reversal of an allocation: MANUAL_REVERSAL (an ADMIN undid it) or MP_REVERSAL (refund / chargeback in Mercado Pago). */
export interface AllocationReversal {
  id: string; amount: number; origin: 'MANUAL_REVERSAL' | 'MP_REVERSAL'; effective_date: string; reason: string | null; created_at: string;
}
export interface AllocationHistory { original: number; reversals: AllocationReversal[] }

/** The original amount and the reversals (oldest first) of the given allocations, from mp_client_allocation (ADMIN). */
export async function listAllocationHistory(client: SupabaseClient, allocationIds: readonly string[]): Promise<Map<string, AllocationHistory>> {
  const out = new Map<string, AllocationHistory>();
  if (allocationIds.length === 0) return out;
  const ids = allocationIds.join(',');
  const rows = await readTable<{ id: string; reversal_of_id: string | null; amount: number; origin: string; effective_date: string; reason: string | null; created_at: string }>(
    client, 'mp_client_allocation', (q) => q.or(`id.in.(${ids}),reversal_of_id.in.(${ids})`).order('created_at', { ascending: true }),
    'id, reversal_of_id, amount, origin, effective_date, reason, created_at');
  for (const r of rows) if (r.reversal_of_id === null) out.set(r.id, { original: Number(r.amount), reversals: [] });
  for (const r of rows) {
    if (r.reversal_of_id === null) continue;
    const h = out.get(r.reversal_of_id);
    if (h) h.reversals.push({ id: r.id, amount: -Number(r.amount), origin: r.origin as AllocationReversal['origin'], effective_date: r.effective_date, reason: r.reason, created_at: r.created_at });
  }
  return out;
}

/** One logical collection: a single row, or a corrected original with the components that replace it. */
export interface LogicalCollection {
  key: string; business_date: string; cliente_id: string; client_name: string;
  /** what counts for the client: the single row, or the corrected original's amount (= sum of its components) */
  amount: number; main: CustomerCollectionRow; parts: CustomerCollectionRow[];
}

/**
 * Groups the rows: a correction (correction_id) becomes one logical collection headed by its CORRECTED_ORIGINAL, with the
 * components as parts; the client amount is the original's. A component whose original is outside the range heads its own group.
 */
export function groupCustomerCollections(rows: readonly CustomerCollectionRow[]): LogicalCollection[] {
  const out: LogicalCollection[] = [];
  const groups = new Map<string, CustomerCollectionRow[]>();
  for (const r of rows) {
    if (!r.correction_id) { out.push({ key: r.row_id, business_date: r.business_date, cliente_id: r.cliente_id, client_name: r.client_name, amount: r.amount, main: r, parts: [] }); continue; }
    const g = groups.get(r.correction_id) ?? [];
    g.push(r); groups.set(r.correction_id, g);
  }
  for (const [id, g] of groups) {
    const main = g.find((r) => r.correction_role === 'CORRECTED_ORIGINAL') ?? g[0];
    const parts = g.filter((r) => r !== main);
    const amount = main.correction_role === 'CORRECTED_ORIGINAL' ? main.amount : g.reduce((s, r) => s + r.amount, 0);
    out.push({ key: `K:${id}`, business_date: main.business_date, cliente_id: main.cliente_id, client_name: main.client_name, amount, main, parts });
  }
  return out.sort((a, b) => (a.business_date === b.business_date ? b.main.created_at.localeCompare(a.main.created_at) : b.business_date.localeCompare(a.business_date)));
}

export interface CollectionFilter { clienteId?: string; account?: string; method?: string; status?: CustomerCollectionStatus | '' }

/** A logical collection matches when its head or any component matches every chosen filter. */
export function filterLogicalCollections(items: readonly LogicalCollection[], f: CollectionFilter): LogicalCollection[] {
  const ok = (r: CustomerCollectionRow) => (!f.account || r.account_name === f.account) && (!f.method || r.payment_method === f.method)
    && (!f.status || r.status === f.status);
  return items.filter((i) => (!f.clienteId || i.cliente_id === f.clienteId) && [i.main, ...i.parts].some(ok));
}

/** One side of a rectification, as shown to the user. */
export interface CollectionSide { clienteId: string; clienteNombre: string; amount: number; accountName: string }
/** Net effect line: `deuda` > 0 raises the client's debt; `saldo` > 0 adds money to the account. */
export interface RectificationEffect {
  clientes: { clienteId: string; nombre: string; deuda: number }[];
  cuentas: { nombre: string; saldo: number }[];
}

/**
 * Preview of a rectification (0108: reversal of the original + the correct collection). Same client / same account lines are
 * merged, zero lines dropped. Presentation only: the server books it.
 */
export function rectificationEffect(original: CollectionSide, nuevo: CollectionSide): RectificationEffect {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const clientes = new Map<string, { clienteId: string; nombre: string; deuda: number }>();
  const cuenta = new Map<string, number>();
  const cli = (id: string, nombre: string, d: number) => {
    const e = clientes.get(id) ?? { clienteId: id, nombre, deuda: 0 };
    e.deuda = r2(e.deuda + d); clientes.set(id, e);
  };
  cli(original.clienteId, original.clienteNombre, original.amount);   // the original collection is undone: debt back up
  cli(nuevo.clienteId, nuevo.clienteNombre, -nuevo.amount);           // the correct collection lowers the debt
  cuenta.set(original.accountName, r2((cuenta.get(original.accountName) ?? 0) - original.amount));
  cuenta.set(nuevo.accountName, r2((cuenta.get(nuevo.accountName) ?? 0) + nuevo.amount));
  return {
    clientes: [...clientes.values()].filter((c) => c.deuda !== 0),
    cuentas: [...cuenta.entries()].map(([nombre, saldo]) => ({ nombre, saldo })).filter((c) => c.saldo !== 0),
  };
}
