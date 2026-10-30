/**
 * Lote 3B (0110) — Cuentas a pagar: pending expense → supplier, due date vs estimated payment date, the payment calendar.
 *
 * Authority (nothing is derived here that the backend does not serve):
 *   - assign_payable_to_supplier links a pending expense to a supplier ONCE: a new version of the purchase with the supplier,
 *     the supplier ledger (+ the expense, − each payment already made, no new money) and the allocation of those payments;
 *   - set_payment_date records the DUE date (contractual; changing one needs a reason) or the PLANNED date (internal, editable);
 *     a date never generates a payment;
 *   - fin_payment_calendar lists every future commitment once: supplier invoices (their pending already excludes the own
 *     cheques allocated to them), pending expenses, own cheques / eCheqs still to be debited (IMPUTADO / SIN_IMPUTAR).
 * A cheque without allocation is never matched to an invoice here: its link stays "not determined".
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';
import type { LedgerBalance } from './treasury';

export type CalendarItemKind = 'FACTURA' | 'GASTO' | 'CHEQUE' | 'ECHEQ';
export type CalendarLinkStatus = 'CONFIRMADO' | 'IMPUTADO' | 'SIN_IMPUTAR';
export interface CalendarRow {
  item_kind: CalendarItemKind; item_id: string; purchase_root_id: string | null; purchase_id: string | null; supplier_id: string | null;
  supplier_name: string | null; concept: string | null; document_number: string | null; economic_date: string | null; amount_total: number;
  amount: number; due_date: string | null; planned_date: string | null; link_status: CalendarLinkStatus; bank_account_name: string | null;
  linked_invoice_number: string | null;
}
export type PaymentDateKind = 'DUE' | 'PLANNED';
export interface PaymentDateRow { id: number; date_kind: PaymentDateKind; value: string | null; reason: string | null; created_at: string }

const num = (v: unknown) => Number(v ?? 0);

export async function listPaymentCalendar(client: SupabaseClient): Promise<CalendarRow[]> {
  const rows = await readView<CalendarRow>(client, 'fin_payment_calendar', (q) => q.limit(2000));
  return rows.map((r) => ({ ...r, amount: num(r.amount), amount_total: num(r.amount_total) }));
}

/** The history of the dates of ONE obligation (by its chain root), newest first. */
export async function listPaymentDateHistory(client: SupabaseClient, rootId: string): Promise<PaymentDateRow[]> {
  return readTable<PaymentDateRow>(client, 'purchase_payment_date', (q) => q.eq('purchase_root_id', rootId).order('id', { ascending: false }),
    'id, date_kind, value, reason, created_at');
}

export function assignPayableToSupplier(client: SupabaseClient, p: { payableId: string; supplierId: string; reason: string; idempotencyKey: string; invoiceNumber?: string | null }) {
  return callRpc<{ replayed: boolean; purchase_id: string; amount: number; paid_before: number; pending: number }>(client, 'assign_payable_to_supplier', {
    p_payable_id: p.payableId, p_supplier_id: p.supplierId, p_reason: p.reason.trim(), p_idempotency_key: p.idempotencyKey,
    p_supplier_invoice_number: p.invoiceNumber?.trim() || null,
  });
}

export function setPaymentDate(client: SupabaseClient, p: { purchaseId: string; kind: PaymentDateKind; date: string | null; reason?: string | null }) {
  return callRpc<{ replayed: boolean; value: string | null }>(client, 'set_payment_date', {
    p_purchase_id: p.purchaseId, p_kind: p.kind, p_date: p.date || null, p_reason: p.reason?.trim() || null,
  });
}

/** The date that places a commitment in the calendar: the estimated payment date when there is one, else the due date. */
export const calendarDate = (r: Pick<CalendarRow, 'due_date' | 'planned_date'>): string | null => r.planned_date ?? r.due_date;
/** Overdue is decided by the contractual due date only (never by the estimated date). */
export const isOverdue = (r: Pick<CalendarRow, 'due_date'>, today: string) => r.due_date !== null && r.due_date < today;

export interface MonthCommitments {
  enMes: CalendarRow[]; sinFecha: CalendarRow[]; vencidos: CalendarRow[];
  confirmado: number; sinImputar: number; vencido: number; totalSinFecha: number;
}
/**
 * The commitments of a month (by calendarDate) kept apart: confirmed (invoices, pending expenses, cheques allocated to an
 * invoice) vs own cheques without allocation (SIN_IMPUTAR, link not determined); obligations without any date; and overdue ones
 * from earlier months that are still pending (they are not lost when the month changes).
 */
export function monthCommitments(rows: CalendarRow[], ym: string, today: string): MonthCommitments {
  const enMes = rows.filter((r) => calendarDate(r)?.slice(0, 7) === ym);
  const sinFecha = rows.filter((r) => calendarDate(r) === null);
  const vencidos = rows.filter((r) => isOverdue(r, today) && (calendarDate(r) ?? '') < `${ym}-01`);
  const sum = (xs: CalendarRow[]) => Math.round(xs.reduce((t, x) => t + x.amount, 0) * 100) / 100;
  return {
    enMes, sinFecha, vencidos,
    confirmado: sum(enMes.filter((r) => r.link_status !== 'SIN_IMPUTAR')),
    sinImputar: sum(enMes.filter((r) => r.link_status === 'SIN_IMPUTAR')),
    vencido: sum(vencidos), totalSinFecha: sum(sinFecha),
  };
}

export interface SupplierCoverage { supplier_id: string; nombre: string; facturasPendientes: number; saldo: number; noDeterminado: number }
/**
 * Per supplier, what the invoices' pending says vs what the supplier account says. When the invoices add up to more than the
 * debt, the difference was paid with payments / cheques NOT allocated to any invoice: it is shown as "not determined" — never
 * assigned to an invoice here.
 */
export function supplierCoverage(rows: CalendarRow[], balances: readonly Pick<LedgerBalance, 'entity_id' | 'balance'>[]): SupplierCoverage[] {
  const facturas = new Map<string, { nombre: string; total: number }>();
  for (const r of rows) {
    if (r.item_kind !== 'FACTURA' || !r.supplier_id) continue;
    const f = facturas.get(r.supplier_id) ?? { nombre: r.supplier_name ?? '', total: 0 };
    f.total += r.amount;
    facturas.set(r.supplier_id, f);
  }
  const out: SupplierCoverage[] = [];
  for (const [id, f] of facturas) {
    const saldo = Math.round(num(balances.find((b) => b.entity_id === id)?.balance) * 100) / 100;
    const total = Math.round(f.total * 100) / 100;
    const noDeterminado = Math.round(Math.max(0, total - Math.max(saldo, 0)) * 100) / 100;
    if (noDeterminado > 0) out.push({ supplier_id: id, nombre: f.nombre, facturasPendientes: total, saldo, noDeterminado });
  }
  return out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
