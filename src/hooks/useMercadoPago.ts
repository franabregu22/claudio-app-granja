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

export function useSyncMercadoPago() {
  return useQuery({
    queryKey: ['sync-mercadopago'],
    queryFn: async () => {
      const edgeSecret = localStorage.getItem('edge_function_secret');
      if (!edgeSecret) {
        throw new Error('Edge function secret not configured');
      }

      const response = await fetch(
        'https://santotomasapp.netlify.app/.netlify/functions/sync-mercadopago',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${edgeSecret}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Sync failed: ${response.statusText}`);
      }

      return response.json();
    },
    enabled: false, // Manual trigger only
  });
}
