import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import {
  cancelOrder, createPendingOrder, deliverOrder, listClientBalances, listCollections, listOrders, listSalesLines,
  rectifyDeliveredOrder, registerCollection, updatePendingOrder, type LineInput, type OrderEstado,
} from '../../target/commercial';
import { listCurrentPrices, listMaster, type ClientRow, type FinancialAccountRow, type ProductRow } from '../../target/masters';

const ORDERS = ['commercial', 'orders'];
const BALANCES = ['commercial', 'balances'];
const COLLECTIONS = ['commercial', 'collections'];
const SALES = ['commercial', 'sales'];

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

export function useCollections() {
  return useQuery({ queryKey: COLLECTIONS, queryFn: () => listCollections(supabase) });
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
    onSuccess: () => Promise.all([BALANCES, COLLECTIONS].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export function useSalesLines(from: string, to: string) {
  return useQuery({ queryKey: [...SALES, from, to], queryFn: () => listSalesLines(supabase, from, to) });
}
