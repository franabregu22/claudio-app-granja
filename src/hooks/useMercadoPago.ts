import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export interface MercadoPagoRaw {
  id: string;
  data: any;
  processed: boolean;
  creado_en: string;
  procesado_en?: string;
}

export function useMercadoPagoRaw() {
  return useQuery({
    queryKey: ['mercadopago-raw'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('mercadopago_raw')
        .select('*')
        .order('creado_en', { ascending: false })
        .limit(100);

      if (error) throw error;
      return data as MercadoPagoRaw[];
    },
    refetchInterval: 30000, // Refresh cada 30s
  });
}
