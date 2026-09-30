import { supabase } from '../lib/supabase';
import type { Pedido } from '../types/domain';

// Legacy read kept only for caja/PyLProesional until F27-G. The legacy order writes, the legacy delivery RPC and
// cancellation were removed in F27-C: they use the target pedidos writes and RPCs 1–3 (src/target/commercial.ts).
export async function listarPedidos(): Promise<Pedido[]> {
  const { data: pedidos, error: pedidosError } = await supabase
    .from('pedidos')
    .select('*')
    .neq('estado', 'cancelado')
    .order('creado_en', { ascending: false });

  if (pedidosError) throw pedidosError;

  if (!pedidos || pedidos.length === 0) return [];

  // Fetch user names separately
  const userIds = new Set<string>();
  pedidos.forEach(p => {
    if (p.creado_por) userIds.add(p.creado_por);
    if (p.entregado_por) userIds.add(p.entregado_por);
  });

  const userNames: Record<string, string> = {};
  if (userIds.size > 0) {
    const { data: perfiles } = await supabase
      .from('perfiles')
      .select('id, primer_nombre, apellido')
      .in('id', Array.from(userIds));

    if (perfiles) {
      perfiles.forEach(p => {
        const nombreCompleto = [p.primer_nombre, p.apellido]
          .filter(Boolean)
          .join(' ') || '(sin nombre)';
        userNames[p.id] = nombreCompleto;
      });
    }
  }

  // Fetch lineas for all pedidos
  const { data: lineas, error: lineasError } = await supabase
    .from('pedido_lineas')
    .select('*')
    .in('pedido_id', pedidos.map(p => p.id));

  if (lineasError) throw lineasError;

  // Map lineas to their pedidos
  const lineasByPedidoId = (lineas || []).reduce((acc, linea) => {
    if (!acc[linea.pedido_id]) {
      acc[linea.pedido_id] = [];
    }
    acc[linea.pedido_id].push(linea);
    return acc;
  }, {} as Record<number, any[]>);

  // Combine pedidos with their lineas and calculate monto_total
  const result = pedidos.map((p: any) => {
    const lineas = lineasByPedidoId[p.id] || [];
    const calculatedTotal = lineas.reduce((sum: number, linea: any) => sum + (Number(linea.subtotal) || 0), 0);

    // Ensure stored monto_total is a valid number
    const storedTotal = Number(p.monto_total);
    const validStoredTotal = isNaN(storedTotal) ? 0 : storedTotal;

    // Prefer calculated if there are lineas, otherwise use stored (which is now guaranteed valid)
    const finalTotal = lineas.length > 0 ? calculatedTotal : validStoredTotal;

    const creadoPorNombre = p.creado_por ? userNames[p.creado_por] || null : null;
    const entregadoPorNombre = p.entregado_por ? userNames[p.entregado_por] || null : null;

    return {
      ...p,
      lineas,
      monto_total: isNaN(finalTotal) ? 0 : finalTotal,
      creado_por_nombre: creadoPorNombre,
      entregado_por_nombre: entregadoPorNombre,
    };
  });

  return result;
}
