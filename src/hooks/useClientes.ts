import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as clientesApi from '../api/clientes';

export function useClientes() {
  return useQuery({
    queryKey: ['clientes'],
    queryFn: clientesApi.listarClientes,
  });
}

export function useCrearCliente() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (nombre: string) => clientesApi.crearCliente(nombre),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clientes'] });
    },
  });
}
