import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { createPurchaseWithAttachments } from '../../target/attachments';
import { listMaster, type ClientRow, type ExpenseCategoryRow, type SupplierRow } from '../../target/masters';
import {
  assignFreightToPurchase, cancelSupplierInstrument, clearCheque, depositCheque, endorseCheque, issueSupplierInstrument, listFreight,
  listInstruments, listLedgerBalances, listPnlMonths, listPurchases, markSupplierInstrumentDebited, paySupplier, receiveCheque, rectifyPurchase,
  registerBankTax, registerFreight, rejectCheque, rejectSupplierInstrument, transferBetweenAccounts, listTransfers, listBankTaxPeriods, transferWithBankTax,
} from '../../target/treasury';

const TREASURY = ['treasury'];
const BALANCES = ['treasury', 'balances'];
const INSTRUMENTS = ['treasury', 'instruments'];
const PURCHASES = ['treasury', 'purchases'];
const FREIGHT = ['treasury', 'freight'];
/** Every treasury effect can move account, supplier and client balances: refresh all of them (and F27-C's). */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([TREASURY, ['commercial', 'balances']].map((queryKey) => qc.invalidateQueries({ queryKey })));
}

export function useLedgerBalances(ledger: 'ACCOUNT' | 'SUPPLIER') {
  return useQuery({ queryKey: [...BALANCES, ledger], queryFn: () => listLedgerBalances(supabase, ledger) });
}
export function useInstruments() {
  return useQuery({ queryKey: INSTRUMENTS, queryFn: () => listInstruments(supabase) });
}
export function usePurchases() {
  return useQuery({ queryKey: PURCHASES, queryFn: () => listPurchases(supabase) });
}
export function useFreight() {
  return useQuery({ queryKey: FREIGHT, queryFn: () => listFreight(supabase) });
}
export function useTransfers() {
  return useQuery({ queryKey: ['treasury', 'transfers'], queryFn: () => listTransfers(supabase) });
}
export function useBankTaxPeriods() {
  return useQuery({ queryKey: ['treasury', 'bank-tax'], queryFn: () => listBankTaxPeriods(supabase) });
}
export function usePnlMonths() {
  return useQuery({ queryKey: ['treasury', 'pnl-months'], queryFn: () => listPnlMonths(supabase) });
}

/** Active suppliers / expense categories / clients from the F27-B masters. */
export function useActiveMaster<Row extends { activo: boolean }>(table: 'suppliers' | 'expense_category' | 'clients') {
  return useQuery({ queryKey: ['master', table], queryFn: () => listMaster<Row>(supabase, table), select: (rows) => rows.filter((r) => r.activo) });
}
export const useSuppliers = () => useActiveMaster<SupplierRow>('suppliers');
export const useExpenseCategories = () => useActiveMaster<ExpenseCategoryRow>('expense_category');
export const useClients = () => useActiveMaster<ClientRow>('clients');

type Args<F> = F extends (client: never, ...rest: infer A) => unknown ? A : never;

export function useTreasuryMutations() {
  const onSuccess = useRefresh();
  return {
    transfer: useMutation({ mutationFn: (p: Args<typeof transferBetweenAccounts>[0]) => transferBetweenAccounts(supabase, p), onSuccess }),
    transferWithTax: useMutation({ mutationFn: (p: Args<typeof transferWithBankTax>[0]) => transferWithBankTax(supabase, p), onSuccess }),
    bankTax: useMutation({ mutationFn: (p: Args<typeof registerBankTax>[0]) => registerBankTax(supabase, p), onSuccess }),
    paySupplier: useMutation({ mutationFn: (p: Args<typeof paySupplier>[0]) => paySupplier(supabase, p), onSuccess }),
    issueInstrument: useMutation({ mutationFn: (p: Args<typeof issueSupplierInstrument>[0]) => issueSupplierInstrument(supabase, p), onSuccess }),
    rectifyPurchase: useMutation({ mutationFn: (p: Args<typeof rectifyPurchase>[0]) => rectifyPurchase(supabase, p), onSuccess }),
    registerFreight: useMutation({ mutationFn: (p: Args<typeof registerFreight>[0]) => registerFreight(supabase, p), onSuccess }),
    assignFreight: useMutation({ mutationFn: (p: Args<typeof assignFreightToPurchase>[0]) => assignFreightToPurchase(supabase, p), onSuccess }),
    receiveCheque: useMutation({ mutationFn: (p: Args<typeof receiveCheque>[0]) => receiveCheque(supabase, p), onSuccess }),
    createPurchase: useMutation({
      mutationFn: (p: Omit<Args<typeof createPurchaseWithAttachments>[0], 'onCleanupFailure'>) => createPurchaseWithAttachments(supabase, {
        ...p,
        // safe report only: object keys, no token / error payload; the user still gets the original error
        onCleanupFailure: (paths) => console.warn(`purchase-attachments: ${paths.length} uploaded object(s) could not be removed`, paths),
      }),
      onSuccess,
    }),
  };
}

export type InstrumentAction = 'deposit' | 'clear' | 'endorse' | 'reject' | 'debit' | 'cancel';
export interface InstrumentActionInput {
  action: InstrumentAction; instrumentId: string; direction: 'RECEIVED' | 'ISSUED'; date: string; reason: string;
  bankAccountId?: string; supplierId?: string;
}

/** One lifecycle step = one contract RPC (0016 / 0018); the frontend never writes an instrument state. */
export function useInstrumentAction() {
  const onSuccess = useRefresh();
  return useMutation({
    mutationFn: (p: InstrumentActionInput) => {
      switch (p.action) {
        case 'deposit': return depositCheque(supabase, p.instrumentId, p.date, p.reason);
        case 'clear': return clearCheque(supabase, p.instrumentId, p.date, p.bankAccountId ?? '', p.reason);
        case 'endorse': return endorseCheque(supabase, p.instrumentId, p.supplierId ?? '', p.date, p.reason);
        case 'debit': return markSupplierInstrumentDebited(supabase, p.instrumentId, p.date, p.reason);
        case 'cancel': return cancelSupplierInstrument(supabase, p.instrumentId, p.date, p.reason);
        case 'reject': return p.direction === 'RECEIVED'
          ? rejectCheque(supabase, p.instrumentId, p.date, p.reason)
          : rejectSupplierInstrument(supabase, p.instrumentId, p.date, p.reason);
      }
    },
    onSuccess,
  });
}
