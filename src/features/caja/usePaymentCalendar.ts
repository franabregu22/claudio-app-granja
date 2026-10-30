import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { assignPayableToSupplier, listPaymentCalendar, listPaymentDateHistory, setPaymentDate, type PaymentDateKind } from '../../target/paymentCalendar';

/** Lote 3B (0110): every future commitment (invoices, pending expenses, own cheques / eCheqs to be debited). */
export function usePaymentCalendar() {
  return useQuery({ queryKey: ['treasury', 'payment-calendar'], queryFn: () => listPaymentCalendar(supabase) });
}
export function usePaymentDateHistory(rootId: string | null) {
  return useQuery({ queryKey: ['treasury', 'payment-dates', rootId], queryFn: () => listPaymentDateHistory(supabase, rootId!), enabled: !!rootId });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([['treasury'], ['documents'], ['commercial', 'balances'], ['pnl']].map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** Pending expense → supplier (one RPC; the key is one per opened form, so a retry replays instead of linking twice). */
export function useAssignPayableToSupplier() {
  const onSuccess = useRefresh();
  return useMutation({ mutationFn: (p: Parameters<typeof assignPayableToSupplier>[1]) => assignPayableToSupplier(supabase, p), onSuccess });
}

/** Only the dates that changed are sent (DUE and / or PLANNED); setting an unchanged date is a no-op in the backend too. */
export function useSetPaymentDates() {
  const onSuccess = useRefresh();
  return useMutation({
    mutationFn: async (p: { purchaseId: string; changes: { kind: PaymentDateKind; date: string | null }[]; reason: string }) => {
      for (const c of p.changes) await setPaymentDate(supabase, { purchaseId: p.purchaseId, kind: c.kind, date: c.date, reason: p.reason });
    },
    onSuccess,
  });
}
