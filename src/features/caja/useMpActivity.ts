import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { type FinancialAccountRow, listMaster } from '../../target/masters';
import {
  classifyMpInflowAsCollection, classifyMpInflowAsOwnTransfer, classifyMpOutflow, confirmMpPayoutTransfer, listMpActivity, listMpPayoutMatches,
  type MpOutflowInput,
} from '../../target/mpActivity';
import { allocateToClient, mapPayerToClient } from '../../target/mp';
import { linkWaMpExpense, listWaMpLinkPending } from '../../target/waMpLink';
import {
  listMpWhatsappNotes, listPendingPage, listTechnicalReview, listUnlinkedPage, type PendingScope, postPendingOutflow, readPendingSummary, type UnlinkedFilter,
} from '../../target/pendingClassification';

export function useMpActivity(accountId: string) {
  return useQuery({ queryKey: ['mp-activity', accountId], queryFn: () => listMpActivity(supabase, accountId), enabled: accountId !== '' });
}

/** ADR-018 (0084): read-only own-account match of the account's payouts (ADMIN). */
export function useMpPayoutMatches(accountId: string) {
  return useQuery({ queryKey: ['mp-payout-matches', accountId], queryFn: () => listMpPayoutMatches(supabase, accountId), enabled: accountId !== '' });
}

/** Every MP confirmation / classification can move account, supplier and client balances and the P&L: refresh them all. */
function useRefreshAfterMp() {
  const qc = useQueryClient();
  return () => Promise.all([['mp-activity'], ['mp-payout-matches'], ['mp-pending'], ['treasury'], ['pnl'], ['commercial', 'balances'], ['customer-collections']]
    .map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** 0087: confirm an OWN_ACCOUNT_EXACT payout as an internal transfer (SOURCE_ID only); refreshes the activity and every balance. */
export function useConfirmPayoutTransfer() {
  const onSettled = useRefreshAfterMp();
  return useMutation({ mutationFn: (sourceId: string) => confirmMpPayoutTransfer(supabase, sourceId), onSettled });
}

/** 0088: classify a payout to a third party / a DEBIN inflow (identifiers only; the server resolves the money). */
export function useClassifyMp() {
  const onSettled = useRefreshAfterMp();
  return {
    outflow: useMutation({ mutationFn: (i: MpOutflowInput) => classifyMpOutflow(supabase, i), onSettled }),
    collection: useMutation({ mutationFn: (i: { paymentId: string; clientId: string | null }) => classifyMpInflowAsCollection(supabase, i.paymentId, i.clientId), onSettled }),
    ownTransfer: useMutation({ mutationFn: (i: { paymentId: string; fromAccountId: string }) => classifyMpInflowAsOwnTransfer(supabase, i.paymentId, i.fromAccountId), onSettled }),
  };
}

/** Active own bank accounts (the source of an inflow from an own account). */
export function useOwnBankAccounts() {
  return useQuery({ queryKey: ['master', 'financial_account'], queryFn: () => listMaster<FinancialAccountRow>(supabase, 'financial_account'),
    select: (rows) => rows.filter((a) => a.activo && a.account_type === 'BANK_ACCOUNT') });
}

/** ADR-021 / ADR-023: one page of the mandatory pending outflows of a scope (current / historical), with the server count. */
export function usePendingPage(scope: PendingScope, page: number) {
  return useQuery({ queryKey: ['mp-pending', 'page', scope, page], queryFn: () => listPendingPage(supabase, scope, page), placeholderData: keepPreviousData });
}

/** ADR-023: server-side counts / totals (mandatory current / historical, unlinked current / historical). */
/** ADR-025 stage 3: the WhatsApp notes of the listed pending outflows (read-only). */
export function useMpWhatsappNotes(sourceIds: readonly string[]) {
  return useQuery({ queryKey: ['mp-pending', 'wa-notes', [...sourceIds].sort()], queryFn: () => listMpWhatsappNotes(supabase, sourceIds), enabled: sourceIds.length > 0 });
}
export function usePendingSummary() {
  return useQuery({ queryKey: ['mp-pending', 'summary'], queryFn: () => readPendingSummary(supabase) });
}

/** ADR-023: one page of "Entradas sin vincular" (optional; never an alert). */
export function useUnlinkedInflows(filter: UnlinkedFilter, page: number) {
  return useQuery({ queryKey: ['mp-pending', 'unlinked', filter, page], queryFn: () => listUnlinkedPage(supabase, filter, page), placeholderData: keepPreviousData });
}

/** ADR-024: "Recordar este pagador" — the existing payer.id → client mapping (future payments of that payer auto-allocate). */
export function useRememberPayer() {
  const onSettled = useRefreshAfterMp();
  return useMutation({ mutationFn: (p: { payerId: string; clienteId: string }) => mapPayerToClient(supabase, { ...p, reason: 'Recordar este pagador (ADR-024)' }), onSettled });
}

/** ADR-023: link an inflow to a customer (no date: the server applies the closed-period rule); never moves Mercado Pago. */
export function useLinkInflow() {
  const onSettled = useRefreshAfterMp();
  return useMutation({ mutationFn: (p: { movementId: number; clienteId: string; amount: number; idempotencyKey: string }) =>
    allocateToClient(supabase, { ...p, effectiveDate: null, reason: 'Vinculación de entrada de Mercado Pago (ADR-023)' }), onSettled });
}

/** ADR-021 (0093): technical exceptions (unposted outflows, report rows in error), never mixed with the pendings. */
export function useTechnicalReview() {
  return useQuery({ queryKey: ['mp-pending', 'technical'], queryFn: () => listTechnicalReview(supabase) });
}

/** ADR-021 (0093): recovery of an outflow whose provisional could not be posted (SOURCE_ID only; idempotent). */
export function useRetryProvisional() {
  const onSettled = useRefreshAfterMp();
  return useMutation({ mutationFn: (sourceId: string) => postPendingOutflow(supabase, sourceId), onSettled });
}

/** Lote 4 (0111): WhatsApp expenses paid with Mercado Pago, confirmed without the operation number, still to link. */
export function useWaMpLinkPending() {
  return useQuery({ queryKey: ['mp-pending', 'wa-mp-link'], queryFn: () => listWaMpLinkPending(supabase) });
}
/** Records the expense against the chosen real outflow (once; replay-safe) and refreshes the balances, the pendings and the P&L. */
export function useLinkWaMpExpense() {
  const onSettled = useRefreshAfterMp();
  return useMutation({ mutationFn: (p: Parameters<typeof linkWaMpExpense>[1]) => linkWaMpExpense(supabase, p), onSettled });
}
