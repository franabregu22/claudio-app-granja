import { supabase } from '../lib/supabase';
import type { Lote } from '../types/domain';

export async function listarLotes(): Promise<Lote[]> {
  const { data, error } = await supabase
    .from('lotes')
    .select('*')
    .order('fecha_entrada', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function listarLotesActivos(): Promise<Lote[]> {
  const { data, error } = await supabase
    .from('lotes')
    .select('*')
    .is('fecha_salida', null)
    .eq('estado', 'Activo')
    .order('fecha_entrada', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function obtenerLoteActivo(galpon: string): Promise<Lote | null> {
  const { data, error } = await supabase
    .from('lotes')
    .select('*')
    .eq('galpon', galpon)
    .is('fecha_salida', null)
    .eq('estado', 'Activo')
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function crearLote(lote: Omit<Lote, 'id' | 'creado_en' | 'actualizado_en' | 'creado_por'> & { creado_por?: string }): Promise<Lote> {
  const { data, error } = await supabase
    .from('lotes')
    .insert([lote])
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function actualizarLote(id: string, actualizaciones: Partial<Lote>): Promise<Lote> {
  const { data, error } = await supabase
    .from('lotes')
    .update(actualizaciones)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function eliminarLote(id: string): Promise<void> {
  const { error } = await supabase
    .from('lotes')
    .delete()
    .eq('id', id);

  if (error) throw error;
}
