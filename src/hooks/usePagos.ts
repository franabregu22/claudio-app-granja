import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import * as pagoApi from '../api/pagos';
import type { MetodoPago } from '../types/domain';

export function usePagos() {
  const queryClient = useQueryClient();
  const channelRef = useRef<any>(null);

  const query = useQuery({
    queryKey: ['pagos'],
    queryFn: () => pagoApi.listarTodosPagos(),
  });

  useEffect(() => {
    if (channelRef.current) return;

    const channel = supabase
      .channel('pagos-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pagos',
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['pagos'] });
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

export function useCrearPago() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      clienteId,
      monto,
      metodoPago,
      fechaPago,
      notas,
      movimientoCajaId,
    }: {
      clienteId: string;
      monto: number;
      metodoPago: MetodoPago;
      fechaPago: string;
      notas?: string;
      movimientoCajaId?: number;
    }) => pagoApi.crearPago(clienteId, monto, metodoPago, fechaPago, notas, movimientoCajaId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pagos'] });
      queryClient.invalidateQueries({ queryKey: ['movimientos-caja'] });
      queryClient.invalidateQueries({ queryKey: ['movimientos-caja-disponibles'] });
    },
  });
}

export function useEliminarPago() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (pagoId: string) => pagoApi.eliminarPago(pagoId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pagos'] });
    },
  });
}
