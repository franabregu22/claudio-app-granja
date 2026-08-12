import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { Producto } from '../types/domain';

export function useProductos() {
  return useQuery({
    queryKey: ['productos'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('productos')
        .select('*')
        .eq('activo', true)
        .order('nombre');

      if (error) throw error;
      return (data || []) as Producto[];
    },
  });
}
