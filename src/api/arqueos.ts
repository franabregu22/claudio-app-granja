import { supabase } from '../lib/supabase';
import type { CuentaCaja, ArqueoCaja } from '../types/domain';

// Listar todas las cuentas de caja
export async function listarCuentas(): Promise<CuentaCaja[]> {
  const { data, error } = await supabase
    .from('cuentas_caja')
    .select('*')
    .eq('activa', true)
    .order('nombre');

  if (error) throw error;
  return data || [];
}

// Obtener una cuenta por ID
export async function obtenerCuenta(cuentaId: string): Promise<CuentaCaja> {
  const { data, error } = await supabase
    .from('cuentas_caja')
    .select('*')
    .eq('id', cuentaId)
    .single();

  if (error) throw error;
  return data;
}

// Calcular saldo de efectivo registrado en el sistema
// Suma: Ingresos en efectivo - Egresos en efectivo hasta la fecha
export async function calcularSaldoEfectivoRegistrado(hastaFecha: string): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('movimientos_caja')
      .select('*')
      .eq('forma_pago', 'efectivo')
      .eq('estado', 'confirmado')
      .lte('fecha_operacion', hastaFecha);

    if (error) {
      console.error('Error al calcular saldo:', error);
      return 0;
    }

    if (!data || data.length === 0) return 0;

    const saldo = data.reduce((sum: number, m: any) => {
      const monto = m.monto || 0;
      return sum + (m.tipo === 'ingreso' ? monto : -monto);
    }, 0);

    return saldo;
  } catch (err) {
    console.error('Exception al calcular saldo:', err);
    return 0;
  }
}

// Listar arqueos de una cuenta
export async function listarArqueos(cuentaId: string, limite = 30): Promise<ArqueoCaja[]> {
  const { data, error } = await supabase
    .from('arqueos_caja')
    .select('*')
    .eq('cuenta_id', cuentaId)
    .order('fecha_arqueo', { ascending: false })
    .limit(limite);

  if (error) throw error;
  return data || [];
}

// Obtener último arqueo de una cuenta
export async function obtenerUltimoArqueo(cuentaId: string): Promise<ArqueoCaja | null> {
  const { data, error } = await supabase
    .from('arqueos_caja')
    .select('*')
    .eq('cuenta_id', cuentaId)
    .order('fecha_arqueo', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
  return data || null;
}

// Crear un nuevo arqueo
export async function crearArqueo(
  cuentaId: string,
  fechaArqueo: string,
  montoFisico: number,
  notas?: string
): Promise<ArqueoCaja> {
  // Calcular monto registrado en el sistema
  const montoRegistrado = await calcularSaldoEfectivoRegistrado(fechaArqueo);

  const { data: user } = await supabase.auth.getUser();
  if (!user.user?.id) throw new Error('Usuario no autenticado');

  const { data, error } = await supabase
    .from('arqueos_caja')
    .insert({
      cuenta_id: cuentaId,
      fecha_arqueo: fechaArqueo,
      monto_fisico: montoFisico,
      monto_registrado: montoRegistrado,
      notas: notas || null,
      creado_por: user.user.id,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}
