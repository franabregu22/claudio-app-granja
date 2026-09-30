import { useEffect, useRef } from 'react';
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import * as pedidosApi from '../api/pedidos';
import type { Pedido } from '../types/domain';

export function usePedidos(): UseQueryResult<Pedido[], Error> {
  const queryClient = useQueryClient();
  const channelRef = useRef<any>(null);

  const query = useQuery({
    queryKey: ['pedidos'],
    queryFn: pedidosApi.listarPedidos,
  });

  useEffect(() => {
    if (channelRef.current) return;

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

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        channelRef.current.unsubscribe();
      }
    };
  }, [queryClient]);

  return query;
}
