import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import * as api from '../api/producciones';

export function useProducciones() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['producciones'],
    queryFn: api.listarProducciones,
  });

  // Suscripción a cambios en tiempo real
  React.useEffect(() => {
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

    return () => {
      supabase.removeChannel(channel);
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
      huevos_sanos_mediodia: number;
      huevos_cachados_mediodia: number;
      huevos_sanos_tarde: number;
      huevos_cachados_tarde: number;
      mortandad: number;
      observaciones?: string;
    }) =>
      api.crearProduccion(
        data.fecha,
        data.galpon,
        data.huevos_sanos_mediodia,
        data.huevos_cachados_mediodia,
        data.huevos_sanos_tarde,
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
      huevos_sanos_mediodia: number;
      huevos_cachados_mediodia: number;
      huevos_sanos_tarde: number;
      huevos_cachados_tarde: number;
      mortandad: number;
      observaciones?: string;
    }) =>
      api.actualizarProduccion(
        data.id,
        data.huevos_sanos_mediodia,
        data.huevos_cachados_mediodia,
        data.huevos_sanos_tarde,
        data.huevos_cachados_tarde,
        data.mortandad,
        data.observaciones
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['producciones'] });
    },
  });
}
