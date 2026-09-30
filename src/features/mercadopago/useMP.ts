import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import {
  getDeliveryHealth, getReceipt, listReceipts, listReportExceptions, lookupActiveMappings, lookupAllocations, lookupChargebackSignals,
} from '../../target/mp';

const MP = ['mp'];

/** S-A: receipts in a date range, with the optional server-side axis filters. */
export const useReceipts = (p: { from: string; to: string; axisA: string | null; axisB: string | null }) =>
  useQuery({ queryKey: [...MP, 'receipts', p], queryFn: () => listReceipts(supabase, p) });
/** S-B: one receipt and its open exceptions. */
export const useReceipt = (movementId: number) => useQuery({ queryKey: [...MP, 'receipt', movementId], queryFn: () => getReceipt(supabase, movementId) });
export const useDeliveryHealth = () => useQuery({ queryKey: [...MP, 'health'], queryFn: () => getDeliveryHealth(supabase) });
export const useReportExceptions = () => useQuery({ queryKey: [...MP, 'exceptions'], queryFn: () => listReportExceptions(supabase) });
/** L-C3 / L-C7 / L-S7: identifier lookups for C3 / C7 / S7 only (never a state source). */
export const useAllocationLookup = (movementId: number) =>
  useQuery({ queryKey: [...MP, 'lookup-c3', movementId], queryFn: () => lookupAllocations(supabase, movementId) });
export const useMappingLookup = () => useQuery({ queryKey: [...MP, 'lookup-c7'], queryFn: () => lookupActiveMappings(supabase) });
export const useSignalLookup = () => useQuery({ queryKey: [...MP, 'lookup-s7'], queryFn: () => lookupChargebackSignals(supabase) });

/** One Step-14 action; after success every MP read is re-read (§6: "the view is re-read after every successful action"). */
export function useMPAction<P>(fn: (client: typeof supabase, p: P) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: P) => fn(supabase, p),
    onSuccess: () => Promise.all([MP, ['commercial', 'balances']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}
