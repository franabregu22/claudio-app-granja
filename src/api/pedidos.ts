import { supabase } from '../lib/supabase';
import type { Pedido, Lineas, Precios } from '../types/domain';

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
  fechaPedido: string
): Promise<Pedido> {
  const { data, error } = await supabase
    .from('pedidos')
    .insert([
      {
        cliente_id: clienteId,
        cliente_nombre: clienteNombre,
        lineas,
        precios_snapshot: preciosSnapshot,
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
  id: string,
  lineas: Lineas,
  preciosSnapshot: Precios,
  fechaPedido: string
): Promise<Pedido> {
  const { data, error } = await supabase
    .from('pedidos')
    .update({
      lineas,
      precios_snapshot: preciosSnapshot,
      fecha_pedido: fechaPedido,
      estado: 'modificado',
      rectificado: true,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function marcarEntregado(id: string): Promise<void> {
  const { error } = await supabase.rpc('marcar_pedido_entregado', {
    pedido_id: id,
  });

  if (error) throw error;
}

export async function cancelarPedido(id: string): Promise<Pedido> {
  const { data, error } = await supabase
    .from('pedidos')
    .update({ estado: 'cancelado' })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
