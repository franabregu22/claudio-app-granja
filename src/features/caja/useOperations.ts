import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { listOperations, operationTimeline, payPurchaseInvoice, setWithdrawalSocio, type OperationFilter } from '../../target/operations';
import { payPendingExpense } from '../../target/payables';

/** 0119: one page of Caja → Todas las operaciones (or exactly the row of `focus`). */
export function useOperationList(filter: OperationFilter, page: number, focus: string | null) {
  return useQuery({
    queryKey: ['treasury', 'operation-list', filter, page, focus],
    queryFn: () => listOperations(supabase, filter, page, focus),
    placeholderData: keepPreviousData,
  });
}
/** 0119: the audited chronology of one row. */
export function useOperationTimeline(rowKey: string | null) {
  return useQuery({ queryKey: ['treasury', 'operation-timeline', rowKey], queryFn: () => operationTimeline(supabase, rowKey!), enabled: !!rowKey });
}

/** Paying from the row moves an account, the supplier debt or a payable: every treasury view, P&L and balances refresh. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([['treasury'], ['commercial', 'balances'], ['pnl'], ['expense-audit']].map((queryKey) => qc.invalidateQueries({ queryKey })));
}
/** 0133: the socio of a partner withdrawal, from its row (Todas las operaciones, P&L by socio and the timeline refresh). */
export function useSetWithdrawalSocio() {
  const onSuccess = useRefresh();
  return useMutation({ mutationFn: (p: Parameters<typeof setWithdrawalSocio>[1]) => setWithdrawalSocio(supabase, p), onSuccess });
}
export function usePayFromRow() {
  const onSuccess = useRefresh();
  return {
    pendingExpense: useMutation({ mutationFn: (p: Parameters<typeof payPendingExpense>[1]) => payPendingExpense(supabase, p), onSuccess }),
    invoice: useMutation({ mutationFn: (p: Parameters<typeof payPurchaseInvoice>[1]) => payPurchaseInvoice(supabase, p), onSuccess }),
  };
}
