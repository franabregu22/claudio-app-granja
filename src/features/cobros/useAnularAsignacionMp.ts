import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { reverseAllocation } from '../../target/mp';

/** Lote 1D "Anular cobro": mp_reverse_client_allocation only (the MP money stays; the receipt's available amount comes back). */
export function useAnularAsignacionMp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Parameters<typeof reverseAllocation>[1]) => reverseAllocation(supabase, p),
    onSuccess: () => Promise.all([['mp'], ['commercial'], ['treasury'], ['customer-collections']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}
