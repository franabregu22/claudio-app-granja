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

  console.log('Pago creado:', pago.id, 'Creando movimiento en Caja...');

  // Mapear forma de pago
  const formasPago: Record<MetodoPago, 'efectivo' | 'mercadopago' | 'echeq' | 'cheque'> = {
    'efectivo': 'efectivo',
    'transferencia': 'efectivo',
    'tarjeta': 'mercadopago',
    'mercadopago': 'mercadopago',
    'otro': 'efectivo',
    'cheque': 'cheque',
    'echeq': 'echeq',
  };

  // Crear movimiento en Caja automáticamente (ingreso)
  const { data: movimiento, error: cajaError } = await supabase
    .from('movimientos_caja')
    .insert({
      tipo: 'ingreso',
      concepto: 'Pago cliente',
      monto,
      forma_pago: formasPago[metodoPago] || 'efectivo',
      fecha_operacion: fechaPago,
      fecha_pago: fechaPago,
      estado: 'confirmado',
      vinculado_a: 'pago',
      vinculado_id: pago.id,
      notas: notas ? `Pago: ${notas}` : 'Pago registrado en Cobros',
    })
    .select()
    .single();

  if (cajaError) {
    console.error('Error al crear movimiento en Caja:', cajaError);
    throw new Error(`Pago creado pero no se registró en Caja: ${cajaError.message}`);
  }

  console.log('Movimiento en Caja creado:', movimiento.id);

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
