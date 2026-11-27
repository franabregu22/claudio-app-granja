import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase';
import {
  allocateFeedFreight, closeFeedMonth, listFeedFreightAllocations, unallocateFeedFreight, listConsumptionCosts, listFeedFreights, listFeedPurchaseExtras, listFeedMonths, listFeedPurchases, listFeedStockPeriods,
  listIngredientCosts, listRecipeChanges, listRecipeCosts,reopenFeedMonth, setExpenseCategoryFeed, setFeedPurchaseParts, setFeedPurchaseQuantity, setFeedTypeActive, setFormulaComment,
  setStandardBatch,
} from '../../../target/alimento';
import { listAllFeedTypes, listFormulaComposition, listFormulaVersions, listManufacturing, publishFormulaVersion, rectifyFeedManufacturing, registerFeedManufacturing } from '../../../target/feed';

/** Every Alimento query lives under ['feed'] (shared with the existing feed hooks), so any write refreshes the module. */
const FEED = ['feed'];

function useWrite<P>(fn: (c: typeof supabase, p: P) => Promise<unknown>, extra: string[][] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: P) => fn(supabase, p),
    onSuccess: () => Promise.all([FEED, ...extra].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const useAllFeedTypes = () => useQuery({ queryKey: [...FEED, 'types', 'all'], queryFn: () => listAllFeedTypes(supabase) });
export const useVersions = () => useQuery({ queryKey: [...FEED, 'formulas'], queryFn: () => listFormulaVersions(supabase) });
export const useComposition = (ids: string[]) =>
  useQuery({ queryKey: [...FEED, 'composition', ...ids], queryFn: () => listFormulaComposition(supabase, ids), enabled: ids.length > 0 });
export const useFabricaciones = (from: string, to: string) =>
  useQuery({ queryKey: [...FEED, 'manufacturing', from, to], queryFn: () => listManufacturing(supabase, from, to) });
export const useStockPeriods = () => useQuery({ queryKey: [...FEED, 'periods'], queryFn: () => listFeedStockPeriods(supabase) });

// ADMIN-only reads: callers pass enabled = rol === 'ADMIN'
export const useFeedMonths = (enabled = true) => useQuery({ queryKey: [...FEED, 'months'], queryFn: () => listFeedMonths(supabase), enabled });
export const useRecipeChanges = (enabled = true) => useQuery({ queryKey: [...FEED, 'recipe-changes'], queryFn: () => listRecipeChanges(supabase), enabled });
export const useFeedPurchases = (enabled = true) => useQuery({ queryKey: [...FEED, 'purchases'], queryFn: () => listFeedPurchases(supabase), enabled });
export const useFeedFreights = (enabled = true) => useQuery({ queryKey: [...FEED, 'freights'], queryFn: () => listFeedFreights(supabase), enabled });
export const useFeedFreightAllocations = (enabled = true) => useQuery({ queryKey: [...FEED, 'freight-allocations'], queryFn: () => listFeedFreightAllocations(supabase), enabled });
export const useRecipeCosts = (enabled = true) => useQuery({ queryKey: [...FEED, 'recipe-costs'], queryFn: () => listRecipeCosts(supabase), enabled });
export const useIngredientCosts = (enabled = true) => useQuery({ queryKey: [...FEED, 'ingredient-costs'], queryFn: () => listIngredientCosts(supabase), enabled });
export const useConsumptionCosts =(enabled = true) => useQuery({ queryKey: [...FEED, 'consumption-costs'], queryFn: () => listConsumptionCosts(supabase), enabled });

export function useAlimentoMutations() {
  return {
    register: useWrite(registerFeedManufacturing),
    rectify: useWrite(rectifyFeedManufacturing),
    publish: useWrite(publishFormulaVersion),
    comment: useWrite(setFormulaComment),
    batch: useWrite(setStandardBatch),
    active: useWrite(setFeedTypeActive),
    close: useWrite(closeFeedMonth, [['pnl']]),
    reopen: useWrite(reopenFeedMonth, [['pnl']]),
    kg: useWrite(setFeedPurchaseQuantity, [['pnl']]),
    parts: useWrite(setFeedPurchaseParts, [['pnl']]),
    freight: useWrite(allocateFeedFreight, [['pnl']]),
    unfreight: useWrite(unallocateFeedFreight, [['pnl']]),
    categoryFeed: useWrite(setExpenseCategoryFeed, [['pnl'], ['master']]),
  };
}

/** The concept and the original invoice of each feed purchase (Caja data, read-only here). */
export function useFeedPurchaseExtras(compras: { purchase_root_id: string; purchase_id: string }[]) {
  const clave = compras.map((x) => x.purchase_id).sort().join(',');
  return useQuery({ queryKey: [...FEED, 'purchase-extras', clave], enabled: compras.length > 0, queryFn: () => listFeedPurchaseExtras(supabase, compras) });
}
