import { supabase } from '../lib/supabase';
import type { Pago, MetodoPago } from '../types/domain';

export async function crearPago(
  clienteId: string,
  monto: number,
  metodoPago: MetodoPago,
  notas?: string
): Promise<Pago> {
  const { data, error } = await supabase
    .from('pagos')
    .insert({
      cliente_id: clienteId,
      monto,
      metodo_pago: metodoPago,
      notas: notas || null,
      fecha_pago: new Date().toISOString().split('T')[0],
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listarPagosCliente(clienteId: string): Promise<Pago[]> {
  const { data, error } = await supabase
    .from('pagos')
    .select('*')
    .eq('cliente_id', clienteId)
    .order('fecha_pago', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function listarTodosPagos(): Promise<Pago[]> {
  const { data, error } = await supabase
    .from('pagos')
    .select('*')
    .order('fecha_pago', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function eliminarPago(pagoId: string): Promise<void> {
  const { error } = await supabase
    .from('pagos')
    .delete()
    .eq('id', pagoId);

  if (error) throw error;
}
