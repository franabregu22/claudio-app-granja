import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable } from './db';

/**
 * 0140 (owner 2026-11-25): the opening balance of a cash account by a physical count (Caja chica counted on 30/11/2026 at the end of
 * the day). The ERP balance at the count date vs the counted cash; the difference is posted once as «Saldo inicial (conteo de caja)»,
 * outside the P&L. One per cash account.
 */
export interface CashOpening {
  financial_account_id: string; count_date: string; counted_amount: number; erp_balance: number; difference: number;
  financial_operation_id: number | null; reason: string | null; created_at: string;
}
const n = (v: unknown) => Number(v ?? 0);

export async function listCashOpenings(c: SupabaseClient): Promise<CashOpening[]> {
  const rows = await readTable<CashOpening>(c, 'cash_opening_count', (q) => q.order('count_date'));
  return rows.map((r) => ({ ...r, counted_amount: n(r.counted_amount), erp_balance: n(r.erp_balance), difference: n(r.difference) }));
}
/** The ERP balance of an account at the end of a day (the caller's RLS). */
export async function balanceOn(c: SupabaseClient, accountId: string, date: string): Promise<number> {
  return n(await callRpc<number>(c, 'fin_account_balance_on', { p_account_id: accountId, p_date: date }));
}
export function registerCashOpening(c: SupabaseClient, p: { accountId: string; date: string; counted: number; reason: string }) {
  return callRpc<{ replayed: boolean; erp_balance: number; counted: number; difference: number }>(c, 'register_cash_opening', {
    p_account_id: p.accountId, p_count_date: p.date, p_counted: p.counted, p_reason: p.reason.trim() || null,
  });
}
/** The Mercado Pago classification cutover (0140): pending outflows before it are closed without detail. */
export const MP_CORTE = '2026-12-01';
