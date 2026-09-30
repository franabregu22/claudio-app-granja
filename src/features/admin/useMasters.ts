import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import {
  assignOperator, createMaster, listCurrentPrices, listFlocks, listMaster, listOperatorAssignments, listProfiles,
  setAssignmentActive, setPrice, updateMaster, type MasterTable, type PriceList,
} from '../../target/masters';

export function useMasterList<Row>(table: MasterTable, order?: string) {
  return useQuery({ queryKey: ['master', table], queryFn: () => listMaster<Row>(supabase, table, order) });
}

export function useMasterMutations(table: MasterTable) {
  const qc = useQueryClient();
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['master', table] });
  return {
    create: useMutation({ mutationFn: (values: Record<string, unknown>) => createMaster(supabase, table, values), onSuccess }),
    update: useMutation({
      mutationFn: (v: { id: string; values: Record<string, unknown> }) => updateMaster(supabase, table, v.id, v.values), onSuccess,
    }),
  };
}

export function useCurrentPrices() {
  return useQuery({ queryKey: ['master', 'price_history'], queryFn: () => listCurrentPrices(supabase) });
}

export function useSetPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { productId: string; list: PriceList; precio: number; effectiveFrom: string; userId: string | null }) =>
      setPrice(supabase, p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['master', 'price_history'] }),
  });
}

export function useFlocks() {
  return useQuery({ queryKey: ['master', 'flocks'], queryFn: () => listFlocks(supabase) });
}

export function useProfiles() {
  return useQuery({ queryKey: ['master', 'perfiles'], queryFn: () => listProfiles(supabase) });
}

export function useOperatorAssignments() {
  return useQuery({ queryKey: ['master', 'operator_assignments'], queryFn: () => listOperatorAssignments(supabase) });
}

export function useAssignmentMutations() {
  const qc = useQueryClient();
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['master', 'operator_assignments'] });
  return {
    assign: useMutation({
      mutationFn: (p: { operatorId: string; flockId: string; userId: string | null }) => assignOperator(supabase, p), onSuccess,
    }),
    setActive: useMutation({ mutationFn: (p: { id: string; activo: boolean }) => setAssignmentActive(supabase, p.id, p.activo), onSuccess }),
  };
}
