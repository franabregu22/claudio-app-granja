import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import * as cajaApi from '../api/caja';
import type { MovimientoCaja } from '../types/domain';

// Read-only legacy source of the Finanzas P&L screens until F27-G (see api/caja.ts).
export function useMovimientosCaja(desde?: string, hasta?: string): UseQueryResult<MovimientoCaja[], Error> {
  return useQuery({
    queryKey: ['movimientos-caja', desde, hasta],
    queryFn: () => cajaApi.listarMovimientosCaja(desde, hasta),
  });
}
