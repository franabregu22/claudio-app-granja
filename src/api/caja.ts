import { supabase } from '../lib/supabase';
import type { MovimientoCaja, Cheque, Comision } from '../types/domain';

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
  movimiento: Omit<MovimientoCaja, 'id' | 'creado_en' | 'actualizado_en' | 'creado_por'>
): Promise<MovimientoCaja> {
  const { data, error } = await supabase
    .from('movimientos_caja')
    .insert([movimiento])
    .select()
    .single();

  if (error) throw error;
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
  const { error } = await supabase
    .from('movimientos_caja')
    .update({
      estado: 'cancelado',
      notas: motivo ? `ANULADO: ${motivo}` : 'ANULADO',
    })
    .eq('id', id);

  if (error) throw error;
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
