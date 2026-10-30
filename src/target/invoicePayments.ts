/**
 * ADR-025 stage 4 (0104) — paying ONE supplier invoice with one or several own cheques / eCheqs and other payments.
 *
 * Authority split (no parallel accounting):
 *   - the invoice (purchase + fiscal document, IVA) is registered once, by register_purchase(_with_fiscal_document);
 *   - each cheque is issue_supplier_instrument (supplier debt down, NO bank movement): a SCHEDULED payment;
 *   - the bank is debited only by mark_supplier_instrument_debited on the effective date: the REAL payment;
 *   - purchase_payment_allocation only says which payment covers which invoice (never above either amount).
 * Totals, pending balance and states are read from fin_purchase_payment_status / _detail / fin_scheduled_payments as served.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';
import type { ErpDocumentInput } from './documents';
import type { InstrumentEstado, InstrumentType } from './treasury';

export interface PurchasePaymentStatusRow {
  purchase_id: string; purchase_root_id: string; supplier_id: string; supplier_name: string; supplier_invoice_number: string | null;
  fiscal_document_id: string | null; economic_date: string; amount_total: number; scheduled: number; debited: number; other_payments: number;
  pending: number; voided_instruments: number;
  /** 0110: the due date in force and the estimated payment date (planning only). */
  due_date: string | null; planned_date: string | null;
}
export interface PurchasePaymentDetailRow {
  allocation_id: string; purchase_root_id: string; amount: number; created_at: string; financial_instrument_id: string | null;
  instrument_type: InstrumentType | null; cheque_number: string | null; issued_date: string | null; maturity_date: string | null;
  debited_date: string | null; rejected_date: string | null; estado: InstrumentEstado | null; replaces_instrument_id: string | null;
  bank_account_id: string | null; bank_account_name: string | null; financial_operation_id: number | null; payment_date: string | null; document_count: number;
}
export interface ScheduledPaymentRow {
  instrument_id: string; instrument_type: InstrumentType; cheque_number: string | null; amount: number; issued_date: string; maturity_date: string;
  estado: 'ISSUED'; bank_account_id: string; bank_account_name: string; supplier_id: string; supplier_name: string; replaces_instrument_id: string | null;
  purchase_root_id: string | null; supplier_invoice_number: string | null; document_count: number;
}
export interface DebitedInstrumentRow {
  id: string; instrument_type: InstrumentType; cheque_number: string | null; amount: number; debited_date: string; maturity_date: string | null;
}
/** One cheque / eCheq of the issue form. */
export interface InstrumentToIssue {
  instrument_type: InstrumentType; cheque_number: string; amount: number; issued_date: string; maturity_date: string; bank_account_id: string;
  replaces_instrument_id?: string | null; document?: ErpDocumentInput | null;
}
/** A supplier payment already registered (pay_supplier), offered to be allocated to an invoice. */
export interface SupplierPaymentRow { id: number; effective_date: string; reason: string | null; amount: number }

const num = (v: unknown) => Number(v ?? 0);

export async function listInvoicePaymentStatus(client: SupabaseClient, onlyPending: boolean): Promise<PurchasePaymentStatusRow[]> {
  const rows = await readView<PurchasePaymentStatusRow>(client, 'fin_purchase_payment_status',
    (q) => (onlyPending ? q.gt('pending', 0) : q).order('economic_date', { ascending: false }).limit(300));
  return rows.map((r) => ({ ...r, amount_total: num(r.amount_total), scheduled: num(r.scheduled), debited: num(r.debited),
    other_payments: num(r.other_payments), pending: num(r.pending), voided_instruments: num(r.voided_instruments) }));
}

export async function listInvoicePaymentDetail(client: SupabaseClient, rootId: string): Promise<PurchasePaymentDetailRow[]> {
  const rows = await readView<PurchasePaymentDetailRow>(client, 'fin_purchase_payment_detail', (q) => q.eq('purchase_root_id', rootId).order('created_at'));
  return rows.map((r) => ({ ...r, amount: num(r.amount), document_count: num(r.document_count) }));
}

/** Lote 3A: every invoice (current purchase) of ONE supplier with its payment status, newest first — the backend's figures. */
export async function listSupplierInvoices(client: SupabaseClient, supplierId: string): Promise<PurchasePaymentStatusRow[]> {
  const rows = await readView<PurchasePaymentStatusRow>(client, 'fin_purchase_payment_status',
    (q) => q.eq('supplier_id', supplierId).order('economic_date', { ascending: false }).limit(200));
  return rows.map((r) => ({ ...r, amount_total: num(r.amount_total), scheduled: num(r.scheduled), debited: num(r.debited),
    other_payments: num(r.other_payments), pending: num(r.pending), voided_instruments: num(r.voided_instruments) }));
}

/** Own instruments still to be debited whose maturity falls in [from, to] (the maturity calendar). */
export async function listScheduledPayments(client: SupabaseClient, from: string, to: string): Promise<ScheduledPaymentRow[]> {
  const rows = await readView<ScheduledPaymentRow>(client, 'fin_scheduled_payments',
    (q) => q.gte('maturity_date', from).lte('maturity_date', to).order('maturity_date'));
  return rows.map((r) => ({ ...r, amount: num(r.amount), document_count: num(r.document_count) }));
}

/** Own instruments already debited in [from, to] (the real payments of the month, by effective date). */
export async function listDebitedInstruments(client: SupabaseClient, from: string, to: string): Promise<DebitedInstrumentRow[]> {
  const rows = await readTable<DebitedInstrumentRow>(client, 'financial_instrument',
    (q) => q.eq('direction', 'ISSUED').eq('estado', 'DEBITED').gte('debited_date', from).lte('debited_date', to).order('debited_date'),
    'id, instrument_type, cheque_number, amount, debited_date, maturity_date');
  return rows.map((r) => ({ ...r, amount: num(r.amount) }));
}

/** SUPPLIER_PAYMENT operations of one supplier (amount = what left the account), newest first. */
export async function listSupplierPayments(client: SupabaseClient, supplierId: string): Promise<SupplierPaymentRow[]> {
  const ops = await readTable<{ id: number; effective_date: string; reason: string | null }>(client, 'financial_operation',
    (q) => q.eq('operation_type', 'SUPPLIER_PAYMENT').eq('source_entity_id', supplierId).order('effective_date', { ascending: false }).limit(50),
    'id, effective_date, reason');
  if (ops.length === 0) return [];
  const posts = await readTable<{ financial_operation_id: number; signed_amount: number }>(client, 'financial_posting',
    (q) => q.in('financial_operation_id', ops.map((o) => o.id)), 'financial_operation_id, signed_amount');
  const paid = new Map<number, number>();
  for (const p of posts) paid.set(p.financial_operation_id, (paid.get(p.financial_operation_id) ?? 0) - num(p.signed_amount));
  return ops.map((o) => ({ ...o, amount: paid.get(o.id) ?? 0 }));
}

export function issuePurchaseInstruments(client: SupabaseClient, p: { purchaseId: string; instruments: InstrumentToIssue[]; idempotencyKey: string; reason?: string | null }) {
  return callRpc<{ replayed: boolean; instrument_ids: string[]; allocated?: number; invoice_total?: number }>(client, 'issue_purchase_instruments', {
    p_purchase_id: p.purchaseId, p_instruments: p.instruments, p_idempotency_key: p.idempotencyKey, p_reason: p.reason?.trim() || null,
  });
}

export function allocatePurchasePayment(client: SupabaseClient, p: { purchaseId: string; operationId: number; amount: number; idempotencyKey: string; reason?: string | null }) {
  return callRpc<{ replayed: boolean }>(client, 'allocate_purchase_payment', {
    p_purchase_id: p.purchaseId, p_financial_operation_id: p.operationId, p_amount: p.amount, p_idempotency_key: p.idempotencyKey, p_reason: p.reason?.trim() || null,
  });
}

/** `YYYY-MM` → first and last day. */
export function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}
