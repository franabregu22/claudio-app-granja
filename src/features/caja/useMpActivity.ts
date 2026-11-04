import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { type FinancialAccountRow, listMaster } from '../../target/masters';
import {
  classifyMpInflowAsCollection, classifyMpInflowAsOwnTransfer, classifyMpOutflow, confirmMpPayoutTransfer, listMpActivity, listMpPayoutMatches,
  type MpOutflowInput,
} from '../../target/mpActivity';
import { listPurchaseMpLinks, settlePurchaseMp } from '../../target/purchaseMpLink';
import {
  getPendingBySource, getUnlinkedByMovement, listMpWhatsappNotes, listTechnicalReview, postPendingOutflow, readPendingSummary,
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
    // ADR-027: never with a client (the database refuses it): a collection is declared in Cuentas corrientes
    collection: useMutation({ mutationFn: (i: { paymentId: string }) => classifyMpInflowAsCollection(supabase, i.paymentId, null), onSettled }),
    ownTransfer: useMutation({ mutationFn: (i: { paymentId: string; fromAccountId: string }) => classifyMpInflowAsOwnTransfer(supabase, i.paymentId, i.fromAccountId), onSettled }),
  };
}

/** Active own bank accounts (the source of an inflow from an own account). */
export function useOwnBankAccounts() {
  return useQuery({ queryKey: ['master', 'financial_account'], queryFn: () => listMaster<FinancialAccountRow>(supabase, 'financial_account'),
    select: (rows) => rows.filter((a) => a.activo && a.account_type === 'BANK_ACCOUNT') });
}


/** ADR-023: server-side counts / totals (mandatory current / historical, unlinked current / historical). */
/** ADR-025 stage 3: the WhatsApp notes of the listed pending outflows (read-only). */
export function useMpWhatsappNotes(sourceIds: readonly string[]) {
  return useQuery({ queryKey: ['mp-pending', 'wa-notes', [...sourceIds].sort()], queryFn: () => listMpWhatsappNotes(supabase, sourceIds), enabled: sourceIds.length > 0 });
}
/** 0116: one pending outflow by SOURCE_ID (the action in a Caja → Movimientos row). */
export function usePendingBySource(sourceId: string | null) {
  return useQuery({ queryKey: ['mp-pending', 'by-source', sourceId], queryFn: () => getPendingBySource(supabase, sourceId as string), enabled: !!sourceId });
}
/** 0116: one unlinked inflow by movement (the action in a Caja → Movimientos row). */
export function useUnlinkedByMovement(movementId: number | null) {
  return useQuery({ queryKey: ['mp-pending', 'unlinked-one', movementId], queryFn: () => getUnlinkedByMovement(supabase, movementId as number), enabled: movementId !== null });
}
export function usePendingSummary() {
  return useQuery({ queryKey: ['mp-pending', 'summary'], queryFn: () => readPendingSummary(supabase) });
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

/** Lote 4 (0111): purchases paid with Mercado Pago — pending link (with same-amount outflows) or linked. */
export function usePurchaseMpLinks() {
  return useQuery({ queryKey: ['mp-pending', 'purchase-mp-link'], queryFn: () => listPurchaseMpLinks(supabase) });
}
/** ADR-021 §2.3(c): only the payment side against the chosen outflow (once; replay-safe); refreshes balances, pendings and P&L. */
export function useSettlePurchaseMp() {
  const onSettled = useRefreshAfterMp();
  return useMutation({ mutationFn: (p: Parameters<typeof settlePurchaseMp>[1]) => settlePurchaseMp(supabase, p), onSettled });
}
