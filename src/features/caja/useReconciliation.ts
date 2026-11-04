import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import {
  accountStatementFormat, countMatchedLines, getMatchDetail, type LineFilters, listAnchorCandidates, listCutovers, listPostingCandidates, listStatementLines,
  matchStatementLine, resolveStatementCutover, reverseStatementMatch, type StatementLine,
} from '../../target/bankReconciliation';
import { bookCharges, listChargeProposals } from '../../target/bankCharges';

const ROOT = ['bank-reconciliation'];

export function useStatementLines(f: LineFilters) {
  return useQuery({ queryKey: [...ROOT, 'lines', f], queryFn: () => listStatementLines(supabase, f), enabled: f.accountId !== '' });
}
export function useCutovers(accountId: string) {
  return useQuery({ queryKey: [...ROOT, 'cutovers', accountId], queryFn: () => listCutovers(supabase, accountId), enabled: accountId !== '' });
}
export function useAccountFormat(accountId: string) {
  return useQuery({ queryKey: [...ROOT, 'format', accountId], queryFn: () => accountStatementFormat(supabase, accountId), enabled: accountId !== '' });
}
export function useMatchedCount(accountId: string) {
  return useQuery({ queryKey: [...ROOT, 'matched-count', accountId], queryFn: () => countMatchedLines(supabase, accountId), enabled: accountId !== '' });
}
export function useAnchorCandidates(accountId: string) {
  return useQuery({ queryKey: [...ROOT, 'anchors', accountId], queryFn: () => listAnchorCandidates(supabase, accountId), enabled: accountId !== '' });
}
export function usePostingCandidates(line: StatementLine) {
  return useQuery({ queryKey: [...ROOT, 'candidates', line.statement_line_id], queryFn: () => listPostingCandidates(supabase, line) });
}
/** 0114: the bank charges proposed for one account (read-only). */
export function useChargeProposals(accountId: string) {
  return useQuery({ queryKey: [...ROOT, 'charges', accountId], queryFn: () => listChargeProposals(supabase, accountId), enabled: accountId !== '' });
}
export function useMatchDetail(matchId: number | null) {
  return useQuery({ queryKey: [...ROOT, 'match', matchId], queryFn: () => getMatchDetail(supabase, matchId as number), enabled: matchId !== null });
}

/** Every reconciliation / cut effect changes classifications and match states: re-read the whole screen. */
export function useReconciliationMutations() {
  const qc = useQueryClient();
  const onSuccess = () => qc.invalidateQueries({ queryKey: ROOT });
  return {
    // a match changes the state of the operation in Caja → Movimientos (and leaves the lines to resolve): the treasury is re-read too
    match: useMutation({ mutationFn: (p: Parameters<typeof matchStatementLine>[1]) => matchStatementLine(supabase, p),
      onSuccess: () => Promise.all([ROOT, ['treasury']].map((queryKey) => qc.invalidateQueries({ queryKey }))) }),
    reverse: useMutation({ mutationFn: (p: Parameters<typeof reverseStatementMatch>[1]) => reverseStatementMatch(supabase, p), onSuccess }),
    resolveCutover: useMutation({ mutationFn: (p: Parameters<typeof resolveStatementCutover>[1]) => resolveStatementCutover(supabase, p), onSuccess }),
    // a booked charge moves the account balance and the history: the treasury and the P&L are re-read too
    bookCharges: useMutation({ mutationFn: (p: Parameters<typeof bookCharges>[1]) => bookCharges(supabase, p),
      onSuccess: () => Promise.all([ROOT, ['treasury'], ['pnl']].map((queryKey) => qc.invalidateQueries({ queryKey }))) }),
  };
}
