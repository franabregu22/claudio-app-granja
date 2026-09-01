import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/arqueos';
import type { CuentaCaja, ArqueoCaja } from '../types/domain';

export function useCuentas() {
  return useQuery({
    queryKey: ['cuentas_caja'],
    queryFn: api.listarCuentas,
    staleTime: 1000 * 60 * 5, // 5 minutos
  });
}

export function useArqueos(cuentaId: string) {
  return useQuery({
    queryKey: ['arqueos_caja', cuentaId],
    queryFn: () => api.listarArqueos(cuentaId),
    staleTime: 1000 * 60 * 2, // 2 minutos
  });
}

export function useUltimoArqueo(cuentaId: string) {
  return useQuery({
    queryKey: ['ultimo_arqueo', cuentaId],
    queryFn: () => api.obtenerUltimoArqueo(cuentaId),
    staleTime: 1000 * 60, // 1 minuto
  });
}

export function useCrearArqueo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      cuentaId,
      fechaArqueo,
      montoFisico,
      notas,
    }: {
      cuentaId: string;
      fechaArqueo: string;
      montoFisico: number;
      notas?: string;
    }) => api.crearArqueo(cuentaId, fechaArqueo, montoFisico, notas),
    onSuccess: (data) => {
      // Invalidar queries relacionados
      queryClient.invalidateQueries({ queryKey: ['arqueos_caja', data.cuenta_id] });
      queryClient.invalidateQueries({ queryKey: ['ultimo_arqueo', data.cuenta_id] });
    },
  });
}
