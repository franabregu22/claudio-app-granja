import { useQuery, useMutation, useQueryClient, type UseQueryResult, type UseMutationResult } from '@tanstack/react-query';
import * as cajaApi from '../api/caja';
import type { MovimientoCaja, Cheque, Comision } from '../types/domain';

export function useMovimientosCaja(desde?: string, hasta?: string): UseQueryResult<MovimientoCaja[], Error> {
  return useQuery({
    queryKey: ['movimientos-caja', desde, hasta],
    queryFn: () => cajaApi.listarMovimientosCaja(desde, hasta),
  });
}

export function useCrearMovimientoCaja(): UseMutationResult<
  MovimientoCaja,
  Error,
  Omit<MovimientoCaja, 'id' | 'creado_en' | 'actualizado_en' | 'creado_por'>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (movimiento) => cajaApi.crearMovimientoCaja(movimiento),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['movimientos-caja'] });
    },
  });
}

export function useActualizarMovimientoCaja(): UseMutationResult<
  MovimientoCaja,
  Error,
  { id: number; movimiento: Partial<MovimientoCaja> }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, movimiento }) => cajaApi.actualizarMovimientoCaja(id, movimiento),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['movimientos-caja'] });
    },
  });
}

export function useEliminarMovimientoCaja(): UseMutationResult<void, Error, number> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id) => cajaApi.eliminarMovimientoCaja(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['movimientos-caja'] });
    },
  });
}

export function useCheques(): UseQueryResult<Cheque[], Error> {
  return useQuery({
    queryKey: ['cheques'],
    queryFn: cajaApi.listarCheques,
  });
}

export function useCrearCheque(): UseMutationResult<
  Cheque,
  Error,
  Omit<Cheque, 'id' | 'creado_en' | 'actualizado_en' | 'creado_por'>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (cheque) => cajaApi.crearCheque(cheque),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cheques'] });
    },
  });
}

export function useActualizarCheque(): UseMutationResult<
  Cheque,
  Error,
  { id: number; cheque: Partial<Cheque> }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, cheque }) => cajaApi.actualizarCheque(id, cheque),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cheques'] });
    },
  });
}

export function useComisiones(desde?: string, hasta?: string): UseQueryResult<Comision[], Error> {
  return useQuery({
    queryKey: ['comisiones', desde, hasta],
    queryFn: () => cajaApi.listarComisiones(desde, hasta),
  });
}

export function useCrearComision(): UseMutationResult<
  Comision,
  Error,
  Omit<Comision, 'id' | 'creado_en' | 'actualizado_en' | 'creado_por'>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (comision) => cajaApi.crearComision(comision),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comisiones'] });
    },
  });
}

export function useResumenCaja(fecha: string) {
  return useQuery({
    queryKey: ['resumen-caja', fecha],
    queryFn: () => cajaApi.obtenerResumenCaja(fecha),
  });
}

export function useAnularMovimiento(): UseMutationResult<
  void,
  Error,
  { id: number; motivo?: string }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, motivo }) => cajaApi.anularMovimiento(id, motivo),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['movimientos-caja'] });
      queryClient.invalidateQueries({ queryKey: ['resumen-caja'] });
    },
  });
}
