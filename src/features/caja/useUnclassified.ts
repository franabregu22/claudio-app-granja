import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { listProfiles } from '../../target/masters';
import {
  classifyPendingExpense, countUnclassified, type ClassifyPendingInput, getPendingExpense, listPendingExpensesPage,
} from '../../target/unclassifiedExpenses';

const KEY = ['unclassified-expenses'];

/** Cuentas a pagar → Gastos → Por revisar: the expenses still unclassified (oldest first; at most 200 at a time). */
export function useUnclassifiedOpen() {
  return useQuery({ queryKey: [...KEY, 'open-list'], queryFn: async () => (await listPendingExpensesPage(supabase, { status: 'SIN_CLASIFICAR' }, 0, 200)).rows });
}

/** The indicator: unclassified expenses (server count). */
/** 0116: one pending expense by id or by its payment operation (the action in a Caja → Movimientos row). */
export function usePendingExpenseOne(k: { pendingId?: number; paymentOperationId?: number } | null) {
  return useQuery({ queryKey: [...KEY, 'one', k], queryFn: () => getPendingExpense(supabase, k ?? {}), enabled: k !== null });
}
export function useUnclassifiedCount() {
  return useQuery({ queryKey: [...KEY, 'count'], queryFn: () => countUnclassified(supabase) });
}
/** Caja tab badge: how many expenses are still unclassified (server count). */
export function useBadgeSinClasificar(): number {
  return useUnclassifiedCount().data ?? 0;
}
/** Author / classifier emails (ADMIN reads perfiles; the ERP already shows them in Admin). */
export function useProfileEmails() {
  return useQuery({ queryKey: ['master', 'perfiles', 'emails'], queryFn: async () => new Map((await listProfiles(supabase)).map((p) => [p.id, p.email])) });
}
/**
 * classify_pending_expense: the purchase on the EXISTING payment. Refreshes the list, the P&L and the treasury views (the
 * purchase list shows the new purchase; balances do not change — the payment is the same).
 */
export function useClassifyPendingExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: ClassifyPendingInput) => classifyPendingExpense(supabase, p),
    // also on error: a concurrent classification (ALREADY_CLASSIFIED) must disappear from the list
    onSettled: () => Promise.all([KEY, ['pnl'], ['treasury']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}
