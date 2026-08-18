import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import * as api from '../api/lotes';

export function useLotes() {
  const queryClient = useQueryClient();
  const channelRef = useRef<any>(null);

  const query = useQuery({
    queryKey: ['lotes'],
    queryFn: api.listarLotes,
  });

  // Suscripción a cambios en tiempo real
  useEffect(() => {
    if (channelRef.current) return;

    const channel = supabase
      .channel('lotes-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lotes' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['lotes'] });
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

export function useCrearLote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      galpon: string;
      fecha_entrada: string;
      aves_iniciales_postura: number;
      linea?: string;
      lote_id?: string;
      estado?: 'Activo' | 'Retirado' | 'Planificado';
      fecha_salida?: string | null;
      notas?: string;
    }) => api.crearLote({
      ...data,
      estado: (data.estado || 'Activo') as 'Activo' | 'Retirado' | 'Planificado',
      fecha_salida: data.fecha_salida || null,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lotes'] });
    },
  });
}

export function useActualizarLote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<any> }) =>
      api.actualizarLote(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lotes'] });
    },
  });
}
