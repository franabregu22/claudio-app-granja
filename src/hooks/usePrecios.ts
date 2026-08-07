import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as preciosApi from '../api/precios';
import type { Categoria } from '../types/domain';

export function usePrecios() {
  return useQuery({
    queryKey: ['precios'],
    queryFn: preciosApi.leerPreciosActuales,
  });
}

export function useActualizarPrecio() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ categoria, precio }: { categoria: Categoria; precio: number }) =>
      preciosApi.actualizarPrecio(categoria, precio),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['precios'] });
    },
  });
}
