import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { crearEtiqueta, listEtiquetas, listEtiquetasDeGastos, listTotalesEtiqueta, setEtiquetaGasto } from '../../target/etiquetas';

/** 0127 expense tags: catalog, tag per expense, totals; a write refreshes all of them and the Proyectos/Etiquetas master. */
const TAGS = ['etiquetas'];

export const useEtiquetas = () => useQuery({ queryKey: [...TAGS, 'catalogo'], queryFn: () => listEtiquetas(supabase) });
export const useEtiquetasDeGastos = () => useQuery({ queryKey: [...TAGS, 'gastos'], queryFn: () => listEtiquetasDeGastos(supabase) });
export const useTotalesEtiqueta = () => useQuery({ queryKey: [...TAGS, 'totales'], queryFn: () => listTotalesEtiqueta(supabase) });
export function useEtiquetaMutations() {
  const qc = useQueryClient();
  const refrescar = () => Promise.all([qc.invalidateQueries({ queryKey: TAGS }), qc.invalidateQueries({ queryKey: ['master', 'projects'] })]);
  return {
    asignar: useMutation({ mutationFn: (p: { purchaseId: string; etiquetaId: string | null }) => setEtiquetaGasto(supabase, p), onSuccess: refrescar }),
    crear: useMutation({ mutationFn: (nombre: string) => crearEtiqueta(supabase, nombre), onSuccess: refrescar }),
  };
}
