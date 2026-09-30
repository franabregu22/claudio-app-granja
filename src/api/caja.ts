import { supabase } from '../lib/supabase';
import type { MovimientoCaja } from '../types/domain';

// Legacy read kept ONLY for the Finanzas P&L screens (PyLProesional / PyL), migrated in F27-G onto pnl_summary /
// pnl_line_item. Caja itself runs on the target since F27-D: no write path to the legacy cash tables remains.
export async function listarMovimientosCaja(
  desde?: string,
  hasta?: string
): Promise<MovimientoCaja[]> {
  let query = supabase
    .from('movimientos_caja')
    .select('*')
    .order('fecha_operacion', { ascending: false });

  if (desde) {
    query = query.gte('fecha_operacion', desde);
  }
  if (hasta) {
    query = query.lte('fecha_operacion', hasta);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
