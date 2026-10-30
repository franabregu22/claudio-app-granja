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

export interface UnallocatedPaymentRow { financial_operation_id: number; supplier_id: string; effective_date: string; reason: string | null; paid: number; allocated: number; available: number }
/** Supplier payments (pay_supplier: advances, payments on account) with an amount still free to allocate to an invoice. */
export async function listUnallocatedPayments(client: SupabaseClient): Promise<UnallocatedPaymentRow[]> {
  const rows = await readView<UnallocatedPaymentRow>(client, 'fin_supplier_unallocated_payments', (q) => q.order('effective_date').limit(1000));
  return rows.map((r) => ({ ...r, paid: num(r.paid), allocated: num(r.allocated), available: num(r.available) }));
}

export interface SupplierPosition {
  supplier_id: string; nombre: string;
  /** Σ pending of its invoices, as served (nothing discounted). */
  facturasPendientes: number;
  /** Payments already made, free to allocate by hand in Pagos de facturas. */
  pagosDisponibles: number;
  /** Own cheques / eCheqs still to be debited, NOT allocated (they will leave the bank; their invoice is not determined). */
  chequesSinImputar: number;
  /** Own cheques / eCheqs still to be debited, allocated to an invoice (already excluded from that invoice's pending). */
  chequesImputados: number;
  /** The supplier account balance (authority): debt after every payment and issued cheque. */
  saldo: number;
  /** Money still to leave for this supplier: the debt (if any) plus the cheques still to be debited. */
  necesidadNeta: number;
  /** Invoices pending − balance − free payments − cheques without allocation: account items without an invoice in the calendar. */
  otros: number;
}
const r2 = (n: number) => Math.round(n * 100) / 100;
/**
 * Per supplier: the invoices' pending (gross, per document) vs the NET need of funds (supplier account balance + own cheques
 * still to be debited). Free payments and cheques without allocation are shown apart: never assigned to an invoice, never
 * discounted from one. A cheque counts once: allocated ones are already out of the invoice's pending, and the balance already
 * excludes every issued cheque. Only suppliers where the two figures differ (or something is free to allocate) are returned.
 */
export function supplierPositions(rows: CalendarRow[], balances: readonly Pick<LedgerBalance, 'entity_id' | 'balance'>[],
  unallocated: readonly Pick<UnallocatedPaymentRow, 'supplier_id' | 'available'>[], names: ReadonlyMap<string, string> = new Map()): SupplierPosition[] {
  const by = new Map<string, SupplierPosition>();
  const get = (id: string, nombre: string | null) => {
    let p = by.get(id);
    if (!p) {
      p = { supplier_id: id, nombre: nombre ?? names.get(id) ?? '', facturasPendientes: 0, pagosDisponibles: 0, chequesSinImputar: 0, chequesImputados: 0, saldo: 0, necesidadNeta: 0, otros: 0 };
      by.set(id, p);
    }
    if (!p.nombre && nombre) p.nombre = nombre;
    return p;
  };
  for (const r of rows) {
    if (!r.supplier_id) continue;
    const p = get(r.supplier_id, r.supplier_name);
    if (r.item_kind === 'FACTURA') p.facturasPendientes += r.amount;
    else if (r.item_kind === 'CHEQUE' || r.item_kind === 'ECHEQ') {
      if (r.link_status === 'SIN_IMPUTAR') p.chequesSinImputar += r.amount; else p.chequesImputados += r.amount;
    }
  }
  for (const u of unallocated) get(u.supplier_id, null).pagosDisponibles += u.available;
  const out: SupplierPosition[] = [];
  for (const p of by.values()) {
    p.facturasPendientes = r2(p.facturasPendientes); p.pagosDisponibles = r2(p.pagosDisponibles);
    p.chequesSinImputar = r2(p.chequesSinImputar); p.chequesImputados = r2(p.chequesImputados);
    p.saldo = r2(num(balances.find((b) => b.entity_id === p.supplier_id)?.balance));
    p.necesidadNeta = r2(Math.max(p.saldo, 0) + p.chequesSinImputar + p.chequesImputados);
    p.otros = r2(p.facturasPendientes - p.saldo - p.pagosDisponibles - p.chequesSinImputar);
    if (p.pagosDisponibles > 0 || p.chequesSinImputar > 0 || p.otros !== 0) out.push(p);
  }
  return out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/**
 * The net need of funds of every commitment in the calendar (not by month: a free payment or a cheque without allocation is
 * not assigned to any invoice, so it cannot be placed in a month): per supplier its necesidadNeta, plus the pending expenses
 * without supplier. The gross sum of documents is returned apart, so the two are never confused.
 */
export function netFundsNeed(rows: CalendarRow[], balances: readonly Pick<LedgerBalance, 'entity_id' | 'balance'>[],
  unallocated: readonly Pick<UnallocatedPaymentRow, 'supplier_id' | 'available'>[]): { bruto: number; neto: number; disponibles: number } {
  const suppliers = new Set<string>();
  for (const r of rows) if (r.supplier_id) suppliers.add(r.supplier_id);
  let neto = 0;
  for (const id of suppliers) {
    const saldo = num(balances.find((b) => b.entity_id === id)?.balance);
    const cheques = rows.filter((r) => r.supplier_id === id && (r.item_kind === 'CHEQUE' || r.item_kind === 'ECHEQ')).reduce((t, r) => t + r.amount, 0);
    neto += Math.max(saldo, 0) + cheques;
  }
  neto += rows.filter((r) => r.item_kind === 'GASTO').reduce((t, r) => t + r.amount, 0);
  const bruto = rows.filter((r) => r.link_status !== 'SIN_IMPUTAR').reduce((t, r) => t + r.amount, 0);
  const disponibles = unallocated.filter((u) => suppliers.has(u.supplier_id)).reduce((t, u) => t + u.available, 0);
  return { bruto: r2(bruto), neto: r2(neto), disponibles: r2(disponibles) };
}
