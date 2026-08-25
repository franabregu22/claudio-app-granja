import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import * as api from '../api/recuentos';

export function useRecuentos() {
  const queryClient = useQueryClient();
  const channelRef = useRef<any>(null);

  const query = useQuery({
    queryKey: ['recuentos'],
    queryFn: api.listarRecuentos,
  });

  // Suscripción a cambios en tiempo real
  useEffect(() => {
    if (channelRef.current) return;

    const channel = supabase
      .channel('recuentos-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'recuentos_lote' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['recuentos'] });
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

export function useCrearRecuento() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      loteId: string;
      fechaRecuento: string;
      avesContadas: number;
      mortandadEsperada?: number;
      notas?: string;
    }) =>
      api.crearRecuento(
        data.loteId,
        data.fechaRecuento,
        data.avesContadas,
        data.mortandadEsperada,
        data.notas
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recuentos'] });
    },
  });
}

export function useActualizarRecuento() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      recuentoId: string;
      avesContadas: number;
      mortandadEsperada?: number;
      notas?: string;
    }) =>
      api.actualizarRecuento(
        data.recuentoId,
        data.avesContadas,
        data.mortandadEsperada,
        data.notas
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recuentos'] });
    },
  });
}

export function useEliminarRecuento() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (recuentoId: string) => api.eliminarRecuento(recuentoId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recuentos'] });
    },
  });
}
