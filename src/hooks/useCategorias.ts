import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listarCategorias,
  crearCategoria,
  actualizarMovimientoCategoria,
  type CategoriaFinanzas,
} from '../api/categorias';

export function useCategorias() {
  return useQuery({
    queryKey: ['categorias'],
    queryFn: listarCategorias,
  });
}

export function useCrearCategoria() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (categoria: Omit<CategoriaFinanzas, 'id' | 'activo'>) => crearCategoria(categoria),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categorias'] });
    },
  });
}

export function useActualizarMovimientoCategoria() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      movimientoId,
      categoriaTecnica,
      subcategoria,
    }: {
      movimientoId: number;
      categoriaTecnica: string;
      subcategoria: string;
    }) => actualizarMovimientoCategoria(movimientoId, categoriaTecnica, subcategoria),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['movimientos'] });
    },
  });
}
