import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import type { AttachmentFile } from '../../target/attachments';
import {
  closeFeriaSummary, closeSalesSession, listFeriaClosings, listSessionCash, listSessionMovements, listSessions, openAndCloseFeria, openSalesSession,
  rectifyFeriaClosing, registerSessionCashEvent, registerSessionMovement, type FeriaClosingInput,
} from '../../target/feria';
import { withWorksheet } from '../../target/feriaWorksheet';
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

export const useFeriaClosings = (from: string, to: string) =>
  useQuery({ queryKey: [...FERIA, 'closings', from, to], queryFn: () => listFeriaClosings(supabase, from, to) });

type Worksheet = { userId: string; file: (AttachmentFile & Blob) | null };
// safe report only: the object key, never a token or error payload; the user still gets the original error
const onCleanupFailure = (paths: string[]) => console.warn(`feria-worksheets: ${paths.length} uploaded object(s) could not be removed`, paths);

/** ADR-016 summarized closing: optional worksheet upload → RPC 51 / 52, with compensation on failure. */
export function useFeriaClosingMutations() {
  const close = (client: typeof supabase, p: FeriaClosingInput & Worksheet & ({ sessionId: string } | { date: string; location: string; idempotencyKey: string })) =>
    withWorksheet(client, { userId: p.userId, file: p.file, onCleanupFailure }, (worksheet) => ('sessionId' in p
      ? closeFeriaSummary(client, { ...p, worksheet })
      : openAndCloseFeria(client, { ...p, worksheet })));
  const rectify = (client: typeof supabase, p: FeriaClosingInput & Worksheet & { closingId: string; reason: string; keepWorksheet: boolean }) =>
    withWorksheet(client, { userId: p.userId, file: p.file, onCleanupFailure }, (worksheet) => rectifyFeriaClosing(client, { ...p, worksheet }));
  return { close: useWrite(close, [FERIA]), rectify: useWrite(rectify, [FERIA]) };
}

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
