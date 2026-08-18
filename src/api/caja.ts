import { supabase } from '../lib/supabase';
import type { MovimientoCaja, Cheque, Comision } from '../types/domain';

// Upload factura to Supabase Storage
export async function subirFactura(file: File, movimientoId?: string): Promise<string> {
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(7);
  const filename = `facturas/${timestamp}-${randomStr}-${file.name}`;

  const { data, error } = await supabase.storage
    .from('facturas')
    .upload(filename, file);

  if (error) throw error;

  // Get public URL
  const { data: publicData } = supabase.storage
    .from('facturas')
    .getPublicUrl(data.path);

  return publicData.publicUrl;
}

// Movimientos Caja
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

export async function crearMovimientoCaja(
  movimiento: Omit<MovimientoCaja, 'id' | 'creado_en' | 'actualizado_en' | 'creado_por'> & { aplica_impuesto_cheque?: boolean }
): Promise<MovimientoCaja> {
  const { aplica_impuesto_cheque, creado_por, ...resto } = movimiento as any;
  const movimientoData = { ...resto, creado_por };

  const { data, error } = await supabase
    .from('movimientos_caja')
    .insert([movimientoData])
    .select()
    .single();

  if (error) {
    throw new Error(`${error.message} (${error.code})`);
  }

  // Si aplica impuesto al cheque, crear movimiento adicional de egreso
  if (aplica_impuesto_cheque && data.id && data.creado_por) {
    const impuesto = data.monto * 0.006;
    const { error: impuestoError } = await supabase
      .from('movimientos_caja')
      .insert([{
        tipo: 'egreso',
        concepto: 'Impuesto al cheque (0.6%)',
        monto: impuesto,
        forma_pago: data.forma_pago,
        fecha_operacion: data.fecha_operacion,
        fecha_pago: data.fecha_pago,
        estado: 'confirmado',
        aplica_impuesto_cheque: false,
        vinculado_a: 'impuesto_cheque',
        vinculado_id: data.id.toString(),
        notas: `Impuesto sobre ${data.concepto}`,
        creado_por: data.creado_por,
      }]);

    if (impuestoError) {
      throw new Error(`Error al crear impuesto: ${impuestoError.message}`);
    }
  }

  return data;
}

export async function actualizarMovimientoCaja(
  id: number,
  movimiento: Partial<MovimientoCaja>
): Promise<MovimientoCaja> {
  const { data, error } = await supabase
    .from('movimientos_caja')
    .update(movimiento)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function eliminarMovimientoCaja(id: number): Promise<void> {
  const { error } = await supabase
    .from('movimientos_caja')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

// Traer movimientos disponibles para vincular a pagos (ingresos no vinculados a pagos)
export async function listarMovimientosDisponibles(): Promise<MovimientoCaja[]> {
  const { data, error } = await supabase
    .from('movimientos_caja')
    .select('*')
    .eq('tipo', 'ingreso')
    .eq('estado', 'confirmado')
    .neq('vinculado_a', 'pago')
    .order('fecha_operacion', { ascending: false });

  if (error) throw error;
  return data || [];
}

// Cheques
export async function listarCheques(): Promise<Cheque[]> {
  const { data, error } = await supabase
    .from('cheques')
    .select('*')
    .order('fecha_vencimiento', { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function crearCheque(
  cheque: Omit<Cheque, 'id' | 'creado_en' | 'actualizado_en' | 'creado_por'>
): Promise<Cheque> {
  const { data, error } = await supabase
    .from('cheques')
    .insert([cheque])
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function actualizarCheque(
  id: number,
  cheque: Partial<Cheque>
): Promise<Cheque> {
  const { data, error } = await supabase
    .from('cheques')
    .update(cheque)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Comisiones
export async function listarComisiones(
  desde?: string,
  hasta?: string
): Promise<Comision[]> {
  let query = supabase
    .from('comisiones')
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

export async function crearComision(
  comision: Omit<Comision, 'id' | 'creado_en' | 'actualizado_en' | 'creado_por'>
): Promise<Comision> {
  const { data, error } = await supabase
    .from('comisiones')
    .insert([comision])
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Anular movimiento
export async function anularMovimiento(id: number, motivo?: string): Promise<void> {
  // First, get the movimiento to check if it's linked to a pago
  const { data: movimiento, error: fetchError } = await supabase
    .from('movimientos_caja')
    .select('vinculado_a, vinculado_id')
    .eq('id', id)
    .single();

  if (fetchError) throw fetchError;

  // Update the movimiento
  const { error } = await supabase
    .from('movimientos_caja')
    .update({
      estado: 'cancelado',
      notas: motivo ? `ANULADO: ${motivo}` : 'ANULADO',
    })
    .eq('id', id);

  if (error) throw error;

  // If linked to a pago, also update the pago estado to match
  if (movimiento.vinculado_a === 'pago' && movimiento.vinculado_id) {
    const { error: pagoError } = await supabase
      .from('pagos')
      .update({ estado: 'cancelado' })
      .eq('id', movimiento.vinculado_id);

    if (pagoError) {
      console.error('Error updating associated pago:', pagoError);
      // Don't throw - movimiento is already anulado, pago update is secondary
    }
  }
}

// Resumen de Caja (para dashboard)
export async function obtenerResumenCaja(fecha: string): Promise<{
  ingresos: number;
  egresos: number;
  balance: number;
}> {
  const { data: movimientos, error } = await supabase
    .from('movimientos_caja')
    .select('tipo, monto')
    .eq('fecha_operacion', fecha)
    .eq('estado', 'confirmado');

  if (error) throw error;

  let ingresos = 0;
  let egresos = 0;

  (movimientos || []).forEach((m: any) => {
    if (m.tipo === 'ingreso') {
      ingresos += m.monto;
    } else {
      egresos += m.monto;
    }
  });

  return {
    ingresos,
    egresos,
    balance: ingresos - egresos,
  };
}
