import { supabase } from '../lib/supabase';
import type { Pedido, LineaPedido } from '../types/domain';

export async function listarPedidos(): Promise<Pedido[]> {
  const { data: pedidos, error: pedidosError } = await supabase
    .from('pedidos')
    .select('*')
    .neq('estado', 'cancelado')
    .order('creado_en', { ascending: false });

  if (pedidosError) throw pedidosError;

  if (!pedidos || pedidos.length === 0) return [];

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
  const result = pedidos.map(p => {
    const lineas = lineasByPedidoId[p.id] || [];
    const calculatedTotal = lineas.reduce((sum, linea) => sum + (Number(linea.subtotal) || 0), 0);

    // Ensure stored monto_total is a valid number
    const storedTotal = Number(p.monto_total);
    const validStoredTotal = isNaN(storedTotal) ? 0 : storedTotal;

    // Prefer calculated if there are lineas, otherwise use stored (which is now guaranteed valid)
    const finalTotal = lineas.length > 0 ? calculatedTotal : validStoredTotal;

    return {
      ...p,
      lineas,
      monto_total: isNaN(finalTotal) ? 0 : finalTotal,
    };
  });

  return result;
}

export async function crearPedido(
  clienteId: string,
  clienteNombre: string,
  lineas: LineaPedido[],
  fechaPedido: string,
  observaciones?: string
): Promise<Pedido> {
  // First, create the pedido
  const { data: pedido, error: pedidoError } = await supabase
    .from('pedidos')
    .insert([
      {
        cliente_id: clienteId,
        cliente_nombre: clienteNombre,
        observaciones: observaciones || null,
        estado: 'pendiente',
        fecha_operacion: fechaPedido,
      },
    ])
    .select()
    .single();

  if (pedidoError) throw pedidoError;

  // Then, create the lineas
  if (lineas.length > 0) {
    const { error: lineasError } = await supabase
      .from('pedido_lineas')
      .insert(
        lineas.map(l => ({
          pedido_id: pedido.id,
          producto_id: l.producto_id,
          producto_nombre: l.producto_nombre,
          cantidad: l.cantidad,
          precio_unitario: l.precio_unitario,
          subtotal: l.subtotal,
        }))
      );

    if (lineasError) throw lineasError;
  }

  return { ...pedido, lineas };
}

export async function rectificarPedido(
  id: number,
  lineas: LineaPedido[],
  fechaPedido: string,
  clienteId?: string,
  clienteNombre?: string,
  observaciones?: string
): Promise<Pedido> {
  // Update pedido
  const { data: pedido, error: pedidoError } = await supabase
    .from('pedidos')
    .update({
      fecha_operacion: fechaPedido,
      cliente_id: clienteId,
      cliente_nombre: clienteNombre,
      observaciones: observaciones || null,
      rectificado: true,
    })
    .eq('id', id)
    .select()
    .single();

  if (pedidoError) throw pedidoError;

  // Delete old lineas
  const { error: deleteError } = await supabase
    .from('pedido_lineas')
    .delete()
    .eq('pedido_id', id);

  if (deleteError) throw deleteError;

  // Insert new lineas
  if (lineas.length > 0) {
    const { error: lineasError } = await supabase
      .from('pedido_lineas')
      .insert(
        lineas.map(l => ({
          pedido_id: id,
          producto_id: l.producto_id,
          producto_nombre: l.producto_nombre,
          cantidad: l.cantidad,
          precio_unitario: l.precio_unitario,
          subtotal: l.subtotal,
        }))
      );

    if (lineasError) throw lineasError;
  }

  return { ...pedido, lineas };
}

export async function marcarEntregado(id: number): Promise<void> {
  const { error } = await supabase.rpc('marcar_pedido_entregado', {
    pedido_id: id,
  });

  if (error) throw error;
}

export async function cancelarPedido(id: number): Promise<Pedido> {
  const { data, error } = await supabase
    .from('pedidos')
    .update({ estado: 'cancelado' })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
