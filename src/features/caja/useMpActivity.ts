import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { type FinancialAccountRow, listMaster } from '../../target/masters';
import {
  classifyMpInflowAsCollection, classifyMpInflowAsOwnTransfer, classifyMpOutflow, confirmMpPayoutTransfer, listMpActivity, listMpPayoutMatches,
  type MpOutflowInput,
} from '../../target/mpActivity';
import { listPendingClassification, listTechnicalReview, postPendingOutflow } from '../../target/pendingClassification';

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
  return () => Promise.all([['mp-activity'], ['mp-payout-matches'], ['mp-pending'], ['treasury'], ['pnl'], ['commercial', 'balances']]
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

/** ADR-021 (0093): everything waiting for a classification (ADMIN). */
export function usePendingClassification() {
  return useQuery({ queryKey: ['mp-pending', 'list'], queryFn: () => listPendingClassification(supabase) });
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
