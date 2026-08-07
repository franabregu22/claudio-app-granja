import { useEffect } from 'react';
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import * as pedidosApi from '../api/pedidos';
import type { Pedido, Lineas, Precios } from '../types/domain';

export function usePedidos(): UseQueryResult<Pedido[], Error> {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['pedidos'],
    queryFn: pedidosApi.listarPedidos,
  });

  useEffect(() => {
    const channel = supabase
      .channel('pedidos-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pedidos',
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['pedidos'] });
        }
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [queryClient]);

  return query;
}

export function useCrearPedido(): UseMutationResult<
  Pedido,
  Error,
  {
    clienteId: string;
    clienteNombre: string;
    lineas: Lineas;
    preciosSnapshot: Precios;
  }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ clienteId, clienteNombre, lineas, preciosSnapshot }) =>
      pedidosApi.crearPedido(clienteId, clienteNombre, lineas, preciosSnapshot),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pedidos'] });
    },
  });
}

export function useRectificarPedido(): UseMutationResult<
  Pedido,
  Error,
  {
    id: string;
    lineas: Lineas;
    preciosSnapshot: Precios;
  }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, lineas, preciosSnapshot }) =>
      pedidosApi.rectificarPedido(id, lineas, preciosSnapshot),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pedidos'] });
    },
  });
}

export function useCancelarPedido(): UseMutationResult<Pedido, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id) => pedidosApi.cancelarPedido(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pedidos'] });
    },
  });
}

export function useMarcarEntregado(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id) => pedidosApi.marcarEntregado(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['pedidos'] });

      const previousData = queryClient.getQueryData<Pedido[]>(['pedidos']);

      if (previousData) {
        queryClient.setQueryData<Pedido[]>(['pedidos'], (old) =>
          old?.map((p) =>
            p.id === id
              ? {
                  ...p,
                  estado: 'entregado' as const,
                  entregado_en: new Date().toISOString(),
                }
              : p
          )
        );
      }

      return { previousData };
    },
    onError: (_error, _id, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['pedidos'], context.previousData);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pedidos'] });
    },
  });
}
