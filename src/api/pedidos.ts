import { supabase } from '../lib/supabase';
import type { Pedido, Lineas, Precios } from '../types/domain';
import { totalPedido } from '../features/pedidos/helpers';

export async function listarPedidos(): Promise<Pedido[]> {
  const { data, error } = await supabase
    .from('pedidos')
    .select('*')
    .neq('estado', 'cancelado')
    .order('creado_en', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function crearPedido(
  clienteId: string,
  clienteNombre: string,
  lineas: Lineas,
  preciosSnapshot: Precios,
  fechaPedido: string,
  observaciones?: string
): Promise<Pedido> {
  const montoTotal = totalPedido(lineas, preciosSnapshot);

  const { data, error } = await supabase
    .from('pedidos')
    .insert([
      {
        cliente_id: clienteId,
        cliente_nombre: clienteNombre,
        lineas,
        precios_snapshot: preciosSnapshot,
        monto_total: montoTotal,
        observaciones: observaciones || null,
        estado: 'pendiente',
        fecha_pedido: fechaPedido,
      },
    ])
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function rectificarPedido(
  id: number,
  lineas: Lineas,
  preciosSnapshot: Precios,
  fechaPedido: string,
  clienteId?: string,
  clienteNombre?: string,
  observaciones?: string
): Promise<Pedido> {
  const montoTotal = totalPedido(lineas, preciosSnapshot);

  const { data, error } = await supabase
    .from('pedidos')
    .update({
      lineas,
      precios_snapshot: preciosSnapshot,
      monto_total: montoTotal,
      fecha_pedido: fechaPedido,
      cliente_id: clienteId,
      cliente_nombre: clienteNombre,
      observaciones: observaciones || null,
      rectificado: true,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
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
