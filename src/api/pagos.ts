import { supabase } from '../lib/supabase';
import type { Pago, MetodoPago } from '../types/domain';

export async function crearPago(
  clienteId: string,
  monto: number,
  metodoPago: MetodoPago,
  fechaPago: string,
  notas?: string
): Promise<Pago> {
  // Crear pago
  const { data: pago, error: pagoError } = await supabase
    .from('pagos')
    .insert({
      cliente_id: clienteId,
      monto,
      metodo_pago: metodoPago,
      notas: notas || null,
      fecha_pago: fechaPago,
    })
    .select()
    .single();

  if (pagoError) throw pagoError;

  // Crear movimiento en Caja automáticamente (ingreso)
  const { error: cajaError } = await supabase
    .from('movimientos_caja')
    .insert({
      tipo: 'ingreso',
      concepto: `Pago cliente`,
      monto,
      forma_pago: metodoPago === 'mercadopago' ? 'mercadopago' : 'efectivo',
      fecha_operacion: fechaPago,
      fecha_pago: fechaPago,
      estado: 'confirmado',
      vinculado_a: 'pago',
      vinculado_id: pago.id,
      notas: notas ? `Pago de ${notas}` : undefined,
    });

  if (cajaError) console.error('Error al crear movimiento en Caja:', cajaError);

  return pago;
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
