import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { createPurchaseWithAttachments } from '../../target/attachments';
import { listMaster, type ClientRow, type ExpenseCategoryGroupRow, type ExpenseCategoryRow, type SupplierRow } from '../../target/masters';
import {
  assignFreightToPurchase, cancelSupplierInstrument, clearCheque, depositCheque, endorseCheque, issueSupplierInstrument, listFreight,
  getPurchase, listInstruments, listLedgerBalances, listPnlMonths, listPrecutCandidates, listSupplierLedger, listPurchases, markInstrumentDebitedPrecut, markSupplierInstrumentDebited, paySupplier, receiveCheque, rectifyPurchase,
  registerBankTax, registerFreight, rejectCheque, rejectSupplierInstrument, transferBetweenAccounts, listBankTaxPeriods, transferWithBankTax,
  listAllInstrumentDateChanges, listInstrumentDateChanges, rescheduleIssuedInstrument,
} from '../../target/treasury';
import { listMovements, type MovementFilter } from '../../target/movementHistory';
import { cancelTransferIntent, linkTransferIntent, listTransferIntents, listUnrelatedTaxes, registerTransferIntent, relateBankTax } from '../../target/transferIntents';

const TREASURY = ['treasury'];
const BALANCES = ['treasury', 'balances'];
const INSTRUMENTS = ['treasury', 'instruments'];
const PURCHASES = ['treasury', 'purchases'];
const FREIGHT = ['treasury', 'freight'];
/** Every treasury effect can move account, supplier and client balances: refresh all of them (and F27-C's). */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([TREASURY, ['commercial', 'balances'], ['fiscal'], ['pnl']].map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** 0116: one page of Caja → Movimientos (operations with state and evidence, bank lines to resolve, Por resolver filters). */
export function useMovementList(filter: MovementFilter, page: number) {
  return useQuery({ queryKey: ['treasury', 'movement-list', filter, page], queryFn: () => listMovements(supabase, filter, page), placeholderData: keepPreviousData });
}
/** 0116: anticipated transfers (Mercado Pago ↔ bank) and their state. */
export function useTransferIntents() {
  return useQuery({ queryKey: ['treasury', 'transfer-intents'], queryFn: () => listTransferIntents(supabase) });
}
/** 0116: the debits/credits taxes of an account not related to any transfer (to associate instead of recording again). */
export function useUnrelatedTaxes(accountId: string) {
  return useQuery({ queryKey: ['treasury', 'unrelated-taxes', accountId], queryFn: () => listUnrelatedTaxes(supabase, accountId), enabled: accountId !== '' });
}
/** 0116: register / link / cancel an anticipated transfer and associate a recorded tax. Linking creates the transfer through a Mercado Pago route: MP lists refresh too. */
export function useTransferIntentMutations() {
  const qc = useQueryClient();
  const refresh = () => Promise.all([TREASURY, ['mp-activity'], ['mp-payout-matches'], ['mp-pending'], ['bank-reconciliation'], ['pnl'], ['commercial', 'balances']]
    .map((queryKey) => qc.invalidateQueries({ queryKey })));
  return {
    register: useMutation({ mutationFn: (p: Parameters<typeof registerTransferIntent>[1]) => registerTransferIntent(supabase, p), onSuccess: refresh }),
    link: useMutation({ mutationFn: (p: Parameters<typeof linkTransferIntent>[1]) => linkTransferIntent(supabase, p), onSettled: refresh }),
    cancel: useMutation({ mutationFn: (p: Parameters<typeof cancelTransferIntent>[1]) => cancelTransferIntent(supabase, p), onSuccess: refresh }),
    relateTax: useMutation({ mutationFn: (p: Parameters<typeof relateBankTax>[1]) => relateBankTax(supabase, p), onSuccess: refresh }),
  };
}
export function useLedgerBalances(ledger: 'ACCOUNT' | 'SUPPLIER') {
  return useQuery({ queryKey: [...BALANCES, ledger], queryFn: () => listLedgerBalances(supabase, ledger) });
}
/** Lote 3A: the supplier-ledger movements of one supplier (supplier ficha). */
export function useSupplierLedger(supplierId: string) {
  return useQuery({ queryKey: [...BALANCES, 'supplier-ledger', supplierId], queryFn: () => listSupplierLedger(supabase, supplierId), enabled: supplierId !== '' });
}
export function useInstruments() {
  return useQuery({ queryKey: INSTRUMENTS, queryFn: () => listInstruments(supabase) });
}
/** 0115: the statement lines that settle one own cheque before the bank cut (read only; only while the form is open). */
export function usePrecutCandidates(instrumentId: string) {
  return useQuery({ queryKey: [...INSTRUMENTS, 'precut', instrumentId], queryFn: () => listPrecutCandidates(supabase, instrumentId), enabled: instrumentId !== '' });
}
export function usePurchases(limit = 200) {
  return useQuery({ queryKey: [...PURCHASES, limit], queryFn: () => listPurchases(supabase, limit) });
}
/** One purchase version with its lines (opened on demand from Cuentas a pagar → Gastos). */
export function usePurchase(id: string | null) {
  return useQuery({ queryKey: [...PURCHASES, 'one', id], queryFn: () => getPurchase(supabase, id!), enabled: !!id });
}
export function useFreight() {
  return useQuery({ queryKey: FREIGHT, queryFn: () => listFreight(supabase) });
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
/** ADR-024: every expense subcategory (inactive included: history and the administration tree need them). */
export function useAllExpenseSubcategories() {
  return useQuery({ queryKey: ['master', 'expense_category', 'all'], queryFn: () => listMaster<ExpenseCategoryRow>(supabase, 'expense_category') });
}
/** ADR-024: the parent expense categories, in display order. */
export function useExpenseGroups() {
  return useQuery({ queryKey: ['master', 'expense_category_group'], queryFn: () => listMaster<ExpenseCategoryGroupRow>(supabase, 'expense_category_group', 'display_order') });
}
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
    markPrecut: useMutation({ mutationFn: (p: Args<typeof markInstrumentDebitedPrecut>[0]) => markInstrumentDebitedPrecut(supabase, p), onSuccess }),
    reschedule: useMutation({ mutationFn: (p: Args<typeof rescheduleIssuedInstrument>[0]) => rescheduleIssuedInstrument(supabase, p), onSuccess }),
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

/** 0118: the audited payment-date corrections of one cheque / eCheq (refreshed with every treasury change). */
export function useInstrumentDateChanges(instrumentId: string | null) {
  return useQuery({ queryKey: ['treasury', 'instrument-date-changes', instrumentId], queryFn: () => listInstrumentDateChanges(supabase, instrumentId!), enabled: !!instrumentId });
}
/** 0118: the payment-date corrections of every cheque / eCheq, by instrument id (marks the corrected ones in every list). */
export function useAllInstrumentDateChanges() {
  return useQuery({ queryKey: ['treasury', 'instrument-date-changes', 'all'], queryFn: async () => {
    const map = new Map<string, Awaited<ReturnType<typeof listAllInstrumentDateChanges>>>();
    for (const c of await listAllInstrumentDateChanges(supabase)) map.set(c.entity_id, [...(map.get(c.entity_id) ?? []), c]);
    return map;
  } });
}
