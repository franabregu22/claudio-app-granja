/**
 * Caja → Cobros de clientes (0092): every client collection, read from the view fin_customer_collections (ADMIN). Manual
 * collections (cash, bank, legacy manual Mercado Pago) and client allocations of Mercado Pago receipts. A corrected manual
 * Mercado Pago collection and the components that replace it (allocation of the real MP payment / cash / partner
 * withdrawal side) are shown as ONE logical collection. Read-only: nothing is computed for the balance here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readView } from './db';

export type CustomerCollectionOrigin = 'CORRECTION' | 'CASH' | 'BANK' | 'MANUAL_MP' | 'AUTO_MP';
export type CustomerCollectionStatus = 'CORRECTED' | 'MANUAL_WITHOUT_SOURCE' | 'CONCILIATED' | 'PENDING_RECONCILIATION' | 'CASH' | 'ALLOCATED_TO_CUSTOMER';
export type CorrectionRole = 'CORRECTED_ORIGINAL' | 'COMPONENT' | 'SINGLE';

export interface CustomerCollectionRow {
  row_id: string; business_date: string; created_at: string; cliente_id: string; client_name: string; amount: number;
  account_name: string; account_type: string; payment_method: string; notes: string | null; financial_operation_id: number | null;
  source_id: string | null; origin: CustomerCollectionOrigin; status: CustomerCollectionStatus; correction_id: string | null;
  correction_role: CorrectionRole; counts_for_customer: boolean;
}
const COLUMNS = 'row_id, business_date, created_at, cliente_id, client_name, amount, account_name, account_type, payment_method, notes, '
  + 'financial_operation_id, source_id, origin, status, correction_id, correction_role, counts_for_customer';

export const COLLECTION_STATUS_LABEL: Record<CustomerCollectionStatus, string> = {
  CORRECTED: 'Corregido', MANUAL_WITHOUT_SOURCE: 'Manual sin movimiento de Mercado Pago', CONCILIATED: 'Conciliado',
  PENDING_RECONCILIATION: 'Pendiente de conciliar', CASH: 'Efectivo', ALLOCATED_TO_CUSTOMER: 'Asignado desde Mercado Pago',
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
 * Cuentas a cobrar detail: every collection that counts for the client's balance (counts_for_customer), manual and Mercado
 * Pago allocations alike, newest first. A corrected original is left out: its components are what count.
 */
export async function listClientCollections(client: SupabaseClient): Promise<CustomerCollectionRow[]> {
  const rows = await readView<CustomerCollectionRow>(client, 'fin_customer_collections', (q) => q.eq('counts_for_customer', true)
    .order('business_date', { ascending: false }).order('created_at', { ascending: false }), COLUMNS);
  return rows.map((r) => ({ ...r, amount: Number(r.amount), financial_operation_id: r.financial_operation_id === null ? null : Number(r.financial_operation_id) }));
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
