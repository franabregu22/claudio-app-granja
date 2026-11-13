import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { payPendingExpense } from '../../target/payables';
import { payPurchaseInvoice } from '../../target/operations';
import {
  endorseChequeToPayable, issueObligationInstruments, issuePlanItemInstruments, listPayablesDue, listPlanItems, payPlanItem, setPaymentPlan,
} from '../../target/paymentPlan';

/** 0121: every open due item once (Cuentas a pagar → Pendientes). */
export function usePayablesDue() {
  return useQuery({ queryKey: ['treasury', 'payables-due'], queryFn: () => listPayablesDue(supabase) });
}
export function usePlanItems(rootId: string | null) {
  return useQuery({ queryKey: ['treasury', 'plan-items', rootId], queryFn: () => listPlanItems(supabase, rootId!), enabled: !!rootId });
}

/** A payment or a plan changes the accounts, the supplier debt, the calendar and the P&L views: every treasury view refreshes. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([['treasury'], ['commercial', 'balances'], ['pnl'], ['expense-audit'], ['documents']].map((queryKey) => qc.invalidateQueries({ queryKey })));
}
export function usePaymentPlanMutations() {
  const onSuccess = useRefresh();
  return {
    plan: useMutation({ mutationFn: (p: Parameters<typeof setPaymentPlan>[1]) => setPaymentPlan(supabase, p), onSuccess }),
    payItem: useMutation({ mutationFn: (p: Parameters<typeof payPlanItem>[1]) => payPlanItem(supabase, p), onSuccess }),
    chequesItem: useMutation({ mutationFn: (p: Parameters<typeof issuePlanItemInstruments>[1]) => issuePlanItemInstruments(supabase, p), onSuccess }),
    chequesObligation: useMutation({ mutationFn: (p: Parameters<typeof issueObligationInstruments>[1]) => issueObligationInstruments(supabase, p), onSuccess }),
    payInvoice: useMutation({ mutationFn: (p: Parameters<typeof payPurchaseInvoice>[1]) => payPurchaseInvoice(supabase, p), onSuccess }),
    endorse: useMutation({ mutationFn: (p: Parameters<typeof endorseChequeToPayable>[1]) => endorseChequeToPayable(supabase, p), onSuccess }),
    payPending: useMutation({ mutationFn: (p: Parameters<typeof payPendingExpense>[1]) => payPendingExpense(supabase, p), onSuccess }),
  };
}
