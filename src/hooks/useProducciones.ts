import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import * as api from '../api/producciones';

export function useProducciones() {
  const queryClient = useQueryClient();
  const channelRef = useRef<any>(null);

  const query = useQuery({
    queryKey: ['producciones'],
    queryFn: api.listarProducciones,
  });

  // Suscripción a cambios en tiempo real
  useEffect(() => {
    if (channelRef.current) return;

    const channel = supabase
      .channel('producciones-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'producciones' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['producciones'] });
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

export function useCrearProduccion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      fecha: string;
      galpon: string;
      huevos_totales_mediodia: number;
      huevos_cachados_mediodia: number;
      huevos_totales_tarde: number;
      huevos_cachados_tarde: number;
      mortandad: number;
      observaciones?: string;
    }) =>
      api.crearProduccion(
        data.fecha,
        data.galpon,
        data.huevos_totales_mediodia,
        data.huevos_cachados_mediodia,
        data.huevos_totales_tarde,
        data.huevos_cachados_tarde,
        data.mortandad,
        data.observaciones
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['producciones'] });
    },
  });
}

export function useActualizarProduccion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      id: string;
      huevos_totales_mediodia: number;
      huevos_cachados_mediodia: number;
      huevos_totales_tarde: number;
      huevos_cachados_tarde: number;
      mortandad: number;
      observaciones?: string;
    }) =>
      api.actualizarProduccion(
        data.id,
        data.huevos_totales_mediodia,
        data.huevos_cachados_mediodia,
        data.huevos_totales_tarde,
        data.huevos_cachados_tarde,
        data.mortandad,
        data.observaciones
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['producciones'] });
    },
  });
}
