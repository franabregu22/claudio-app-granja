import { supabase } from '../lib/supabase';
import type { Pago, MetodoPago } from '../types/domain';

export async function crearPago(
  clienteId: string,
  monto: number,
  metodoPago: MetodoPago,
  fechaPago: string,
  notas?: string,
  movimientoCajaId?: number
): Promise<Pago> {
  // Obtener nombre del cliente
  const { data: cliente, error: clienteError } = await supabase
    .from('clientes')
    .select('nombre')
    .eq('id', clienteId)
    .single();

  if (clienteError || !cliente) {
    throw new Error('Cliente no encontrado');
  }

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

  // Si se proporciona un movimiento existente, vincularlo; si no, crear uno nuevo
  if (movimientoCajaId) {
    // Vincular a movimiento existente
    const { error: vincularError } = await supabase
      .from('movimientos_caja')
      .update({
        vinculado_a: 'pago',
        vinculado_id: pago.id,
        cliente_id: clienteId,
      })
      .eq('id', movimientoCajaId);

    if (vincularError) {
      console.error('Error al vincular movimiento:', vincularError);
      throw new Error(`Pago creado pero no se pudo vincular el movimiento: ${vincularError.message}`);
    }

    console.log('Movimiento vinculado:', movimientoCajaId);
  } else {
    // Crear movimiento nuevo
    const { data: movimiento, error: cajaError } = await supabase
      .from('movimientos_caja')
      .insert({
        tipo: 'ingreso',
        concepto: `Cobro - ${cliente.nombre}`,
        monto,
        forma_pago: formasPago[metodoPago] || 'efectivo',
        fecha_operacion: fechaPago,
        fecha_pago: fechaPago,
        estado: 'confirmado',
        vinculado_a: 'pago',
        vinculado_id: pago.id,
        cliente_id: clienteId,
        notas: notas || null,
      })
      .select()
      .single();

    if (cajaError) {
      console.error('Error al crear movimiento en Caja:', cajaError);
      throw new Error(`Pago creado pero no se registró en Caja: ${cajaError.message}`);
    }

    console.log('Movimiento en Caja creado:', movimiento.id);
  }

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
