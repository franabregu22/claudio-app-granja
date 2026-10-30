/**
 * ADR-026 (0106) — pending expenses: the expense is in the P&L from its registration (purchases, by its date and category); the
 * obligation (expense_payable) is paid later, totally or partially, with ONE real money movement per payment (pay_pending_expense).
 * Paying never creates another purchase, invoice or P&L line. Balances and states are read as served by fin_expense_payables.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readView } from './db';

export type PayableStatus = 'PENDIENTE' | 'PARCIAL' | 'PAGADO';
export interface PayableRow {
  payable_id: string; purchase_id: string; purchase_root_id: string; economic_date: string; concept: string | null; counterparty_name: string | null;
  expense_category_id: string; category_name: string; fiscal_document_id: string | null; amount: number; paid: number; pending: number;
  /** 0110: the due date in force (contractual) and the internal estimated payment date — never a payment by themselves. */
  due_date: string | null; status: PayableStatus; origin: 'ERP' | 'WHATSAPP'; created_at: string; planned_date: string | null;
}
export interface PayablePaymentRow { payment_id: number; payable_id: string; amount: number; effective_date: string; account_name: string }
export const PAYABLE_STATUS_LABEL: Record<PayableStatus, string> = { PENDIENTE: 'Pendiente', PARCIAL: 'Pago parcial', PAGADO: 'Pagado' };

const num = (v: unknown) => Number(v ?? 0);

export async function listPayables(client: SupabaseClient, onlyOpen: boolean): Promise<PayableRow[]> {
  const rows = await readView<PayableRow>(client, 'fin_expense_payables',
    (q) => (onlyOpen ? q.gt('pending', 0) : q).order('due_date', { ascending: true, nullsFirst: false }).order('economic_date').limit(500));
  return rows.map((r) => ({ ...r, amount: num(r.amount), paid: num(r.paid), pending: num(r.pending) }));
}

export async function listPayablePayments(client: SupabaseClient, payableId: string): Promise<PayablePaymentRow[]> {
  const rows = await readView<PayablePaymentRow>(client, 'fin_expense_payable_payments', (q) => q.eq('payable_id', payableId).order('effective_date'));
  return rows.map((r) => ({ ...r, amount: num(r.amount) }));
}

export function payPendingExpense(client: SupabaseClient, p: {
  payableId: string; amount: number; effectiveDate: string; accountId: string; method: 'CASH' | 'TRANSFER'; idempotencyKey: string; reason?: string | null;
}) {
  return callRpc<{ replayed: boolean; financial_operation_id: number; paid: number; pending: number }>(client, 'pay_pending_expense', {
    p_payable_id: p.payableId, p_amount: p.amount, p_effective_date: p.effectiveDate, p_account_id: p.accountId, p_payment_method: p.method,
    p_idempotency_key: p.idempotencyKey, p_reason: p.reason?.trim() || null,
  });
}
