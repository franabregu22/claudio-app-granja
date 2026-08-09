import { supabase } from '../lib/supabase';
import type { Produccion } from '../types/domain';

export async function listarProducciones(): Promise<Produccion[]> {
  const { data, error } = await supabase
    .from('producciones')
    .select('*')
    .order('fecha', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function obtenerProduccion(fecha: string, galpon: string): Promise<Produccion | null> {
  const { data, error } = await supabase
    .from('producciones')
    .select('*')
    .eq('fecha', fecha)
    .eq('galpon', galpon)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function crearProduccion(
  fecha: string,
  galpon: string,
  huevos_sanos_mediodia: number,
  huevos_cachados_mediodia: number,
  huevos_sanos_tarde: number,
  huevos_cachados_tarde: number,
  mortandad: number,
  observaciones?: string
): Promise<Produccion> {
  const { data, error } = await supabase
    .from('producciones')
    .insert([{
      fecha,
      galpon,
      huevos_sanos_mediodia,
      huevos_cachados_mediodia,
      huevos_sanos_tarde,
      huevos_cachados_tarde,
      mortandad,
      observaciones,
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function actualizarProduccion(
  id: string,
  huevos_sanos_mediodia: number,
  huevos_cachados_mediodia: number,
  huevos_sanos_tarde: number,
  huevos_cachados_tarde: number,
  mortandad: number,
  observaciones?: string
): Promise<Produccion> {
  const { data, error } = await supabase
    .from('producciones')
    .update({
      huevos_sanos_mediodia,
      huevos_cachados_mediodia,
      huevos_sanos_tarde,
      huevos_cachados_tarde,
      mortandad,
      observaciones,
      actualizado_en: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
