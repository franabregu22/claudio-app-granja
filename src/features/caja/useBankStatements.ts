import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { importStatement, listImportRuns, listStatementAccounts, reprocessRun } from '../../target/bankStatements';

const RUNS = ['bank-statements', 'runs'];

export function useStatementAccounts() {
  return useQuery({ queryKey: ['bank-statements', 'accounts'], queryFn: () => listStatementAccounts(supabase) });
}
export function useImportRuns() {
  return useQuery({ queryKey: RUNS, queryFn: () => listImportRuns(supabase) });
}

/** Import / reprocess through the Edge Function; the history is re-read afterwards (a new run or a replay). */
export function useBankStatementMutations() {
  const qc = useQueryClient();
  const onSettled = () => qc.invalidateQueries({ queryKey: RUNS });
  return {
    importStatement: useMutation({ mutationFn: (p: Parameters<typeof importStatement>[1]) => importStatement(supabase, p), onSettled }),
    reprocess: useMutation({ mutationFn: (runId: string) => reprocessRun(supabase, runId), onSettled }),
  };
}
