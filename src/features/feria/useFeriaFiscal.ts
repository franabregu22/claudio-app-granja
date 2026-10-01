import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import {
  closeSalesSession, listSessionCash, listSessionMovements, listSessions, openSalesSession, registerSessionCashEvent, registerSessionMovement,
} from '../../target/feria';
import {
  listFiscalDocuments, listFiscalPayments, listFiscalPeriods, listObligations, payFiscalObligation, registerFiscalDocument, registerFiscalObligation,
} from '../../target/fiscal';

const FERIA = ['feria'];
const FISCAL = ['fiscal'];
type Args<F> = F extends (client: never, ...rest: infer A) => unknown ? A : never;

/** Every Feria / fiscal effect can move account and client balances: refresh them together with the slice's reads. */
function useWrite<F extends (client: never, p: never) => Promise<unknown>>(fn: F, keys: string[][]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Args<F>[0]) => (fn as unknown as (c: typeof supabase, p: Args<F>[0]) => Promise<unknown>)(supabase, p),
    onSuccess: () => Promise.all([...keys, ['treasury'], ['commercial']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const useSessions = () => useQuery({ queryKey: [...FERIA, 'sessions'], queryFn: () => listSessions(supabase) });
export const useSessionCash = (from: string, to: string) =>
  useQuery({ queryKey: [...FERIA, 'cash', from, to], queryFn: () => listSessionCash(supabase, from, to) });
export const useSessionMovements = (sessionId: string) =>
  useQuery({ queryKey: [...FERIA, 'movements', sessionId], queryFn: () => listSessionMovements(supabase, sessionId), enabled: sessionId !== '' });

export function useFeriaMutations() {
  return {
    open: useWrite(openSalesSession, [FERIA]),
    movement: useWrite(registerSessionMovement, [FERIA]),
    cashEvent: useWrite(registerSessionCashEvent, [FERIA]),
    close: useWrite(closeSalesSession, [FERIA]),
  };
}

export const useFiscalDocuments = () => useQuery({ queryKey: [...FISCAL, 'documents'], queryFn: () => listFiscalDocuments(supabase) });
export const useFiscalPeriods = () => useQuery({ queryKey: [...FISCAL, 'periods'], queryFn: () => listFiscalPeriods(supabase) });
export const useFiscalPayments = () => useQuery({ queryKey: [...FISCAL, 'payments'], queryFn: () => listFiscalPayments(supabase) });
export const useObligations = () => useQuery({ queryKey: [...FISCAL, 'obligations'], queryFn: () => listObligations(supabase) });

export function useFiscalMutations() {
  return {
    document: useWrite(registerFiscalDocument, [FISCAL]),
    obligation: useWrite(registerFiscalObligation, [FISCAL]),
    pay: useWrite(payFiscalObligation, [FISCAL]),
  };
}
