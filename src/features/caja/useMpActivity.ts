import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { confirmMpPayoutTransfer, listMpActivity, listMpPayoutMatches } from '../../target/mpActivity';

export function useMpActivity(accountId: string) {
  return useQuery({ queryKey: ['mp-activity', accountId], queryFn: () => listMpActivity(supabase, accountId), enabled: accountId !== '' });
}

/** ADR-018 (0084): read-only own-account match of the account's payouts (ADMIN). */
export function useMpPayoutMatches(accountId: string) {
  return useQuery({ queryKey: ['mp-payout-matches', accountId], queryFn: () => listMpPayoutMatches(supabase, accountId), enabled: accountId !== '' });
}

/** 0087: confirm an OWN_ACCOUNT_EXACT payout as an internal transfer (SOURCE_ID only); refreshes the activity and every balance. */
export function useConfirmPayoutTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => confirmMpPayoutTransfer(supabase, sourceId),
    onSettled: () => Promise.all([['mp-activity'], ['mp-payout-matches'], ['treasury'], ['pnl']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}
