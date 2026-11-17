import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { withUploadedAttachments } from '../../target/attachments';
import { anularGasto, listAnulaciones, listPagosRevertidos, revertirPago, listAuditoriaGasto, raizDeCompra, rectificarGasto, registrarGasto, type NuevoGastoInput, type RectificacionInput } from '../../target/expenses';

/** A new or corrected expense can move the supplier debt, the payables, Mercado Pago links, fiscal credit, P&L and balances. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([['treasury'], ['documents'], ['commercial', 'balances'], ['fiscal'], ['pnl'], ['mp-pending'], ['unclassified-expenses'], ['expense-audit']]
    .map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** Nuevo gasto: the receipts uploaded first, then ONE route RPC (src/target/expenses.ts); uploaded files are removed if it fails. */
export function useRegisterExpense() {
  const onSuccess = useRefresh();
  return useMutation({
    mutationFn: (p: NuevoGastoInput & { userId: string; files: File[] }) =>
      withUploadedAttachments(supabase, p.userId, p.files, (attachments) => registrarGasto(supabase, p, attachments)),
    onSuccess,
  });
}

/** 0124: annul an expense with nothing paid; the annulled ones (struck through). */
export function useAnnulExpense() {
  const onSuccess = useRefresh();
  return useMutation({ mutationFn: (p: Parameters<typeof anularGasto>[1]) => anularGasto(supabase, p), onSuccess });
}
export function useRevertirPago() {
  const onSuccess = useRefresh();
  return useMutation({ mutationFn: (p: Parameters<typeof revertirPago>[1]) => revertirPago(supabase, p), onSuccess });
}
export function usePagosRevertidos() {
  return useQuery({ queryKey: ['treasury', 'payment-reversals'], queryFn: () => listPagosRevertidos(supabase) });
}
export function useAnnulments() {
  return useQuery({ queryKey: ['treasury', 'annulments'], queryFn: () => listAnulaciones(supabase) });
}
export function useRectifyExpense() {
  const onSuccess = useRefresh();
  return useMutation({ mutationFn: (p: RectificacionInput) => rectificarGasto(supabase, p), onSuccess });
}

/** The audited history of ONE expense (every version of its chain), oldest first. */
export function useExpenseAudit(purchaseId: string | null, rootId: string | null) {
  return useQuery({
    queryKey: ['expense-audit', purchaseId, rootId], enabled: !!(purchaseId || rootId),
    queryFn: async () => listAuditoriaGasto(supabase, rootId ?? await raizDeCompra(supabase, purchaseId!)),
  });
}
