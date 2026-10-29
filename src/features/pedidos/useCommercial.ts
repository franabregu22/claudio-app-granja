import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import {
  cancelOrder, createPendingOrder, deliverOrder, listClientBalances, listOrders, listSalesLines,
  rectifyDeliveredOrder, registerCollection, updatePendingOrder, type LineInput, type OrderEstado,
} from '../../target/commercial';
import { listClientCollections } from '../../target/customerCollections';
import { listCurrentPrices, listMaster, type ClientRow, type FinancialAccountRow, type ProductRow } from '../../target/masters';

const ORDERS = ['commercial', 'orders'];
const BALANCES = ['commercial', 'balances'];
const SALES = ['commercial', 'sales'];
const CUSTOMER_COLLECTIONS = ['customer-collections'];   // also invalidated by the Mercado Pago allocation (MovimientoMp)

export function useOrders(estados: OrderEstado[]) {
  return useQuery({ queryKey: [...ORDERS, ...estados], queryFn: () => listOrders(supabase, estados) });
}

/** Active clients and sellable products from the target masters (F27-B), current prices from price_history. */
export function useOrderCatalog() {
  const clients = useQuery({ queryKey: ['master', 'clients'], queryFn: () => listMaster<ClientRow>(supabase, 'clients') });
  const products = useQuery({ queryKey: ['master', 'products'], queryFn: () => listMaster<ProductRow>(supabase, 'products') });
  const prices = useQuery({ queryKey: ['master', 'price_history'], queryFn: () => listCurrentPrices(supabase) });
  return {
    clients: (clients.data ?? []).filter((c) => c.activo),
    products: (products.data ?? []).filter((p) => p.activo && p.product_type !== 'INPUT'),
    prices: prices.data ?? [],
    isLoading: clients.isLoading || products.isLoading || prices.isLoading,
    error: clients.error ?? products.error ?? prices.error,
  };
}

export function useOrderMutations() {
  const qc = useQueryClient();
  const refresh = () => Promise.all([ORDERS, BALANCES, SALES].map((queryKey) => qc.invalidateQueries({ queryKey })));
  return {
    create: useMutation({
      mutationFn: (p: { clienteId: string; lines: LineInput[]; userId: string | null }) => createPendingOrder(supabase, p), onSuccess: refresh,
    }),
    updatePending: useMutation({
      mutationFn: (p: { orderId: string; clienteId: string; lines: LineInput[]; previousLineIds: string[]; userId: string | null }) =>
        updatePendingOrder(supabase, p),
      onSuccess: refresh,
    }),
    deliver: useMutation({ mutationFn: (orderId: string) => deliverOrder(supabase, orderId), onSuccess: refresh }),
    cancel: useMutation({ mutationFn: (p: { orderId: string; reason: string | null }) => cancelOrder(supabase, p.orderId, p.reason), onSuccess: refresh }),
    rectify: useMutation({
      mutationFn: (p: { orderId: string; lines: LineInput[]; reason: string }) => rectifyDeliveredOrder(supabase, p.orderId, p.lines, p.reason),
      onSuccess: refresh,
    }),
  };
}

export function useClientBalances() {
  return useQuery({ queryKey: BALANCES, queryFn: () => listClientBalances(supabase) });
}

/** Collections that count for each client's balance (fin_customer_collections); refreshed with every customer-collection change. */
export function useClientCollections() {
  return useQuery({ queryKey: [...CUSTOMER_COLLECTIONS, 'balance-detail'], queryFn: () => listClientCollections(supabase) });
}

export function useFinancialAccounts() {
  return useQuery({
    queryKey: ['master', 'financial_account'],
    queryFn: () => listMaster<FinancialAccountRow>(supabase, 'financial_account'),
    select: (rows) => rows.filter((a) => a.activo),
  });
}

export function useRegisterCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Parameters<typeof registerCollection>[1]) => registerCollection(supabase, p),
    onSuccess: () => Promise.all([BALANCES, CUSTOMER_COLLECTIONS].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export function useSalesLines(from: string, to: string, enabled = true) {
  return useQuery({ queryKey: [...SALES, from, to], queryFn: () => listSalesLines(supabase, from, to), enabled });
}
