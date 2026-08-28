import { supabase } from '../lib/supabase';
import type { Produccion } from '../types/domain';

export async function listarProducciones(): Promise<Produccion[]> {
  const { data, error } = await supabase
    .from('producciones')
    .select('*')
    .order('fecha', { ascending: false });

  if (error) throw error;

  return (data || []).map((prod: any) => ({
    ...prod,
    creado_por_nombre: prod.creado_por_primer_nombre && prod.creado_por_apellido
      ? `${prod.creado_por_primer_nombre} ${prod.creado_por_apellido}`
      : null,
  }));
}

export async function obtenerProduccion(fecha: string, galpon: string): Promise<Produccion | null> {
  const { data, error } = await supabase
    .from('producciones')
    .select('*')
    .eq('fecha', fecha)
    .eq('galpon', galpon)
    .single();

  if (error && error.code !== 'PGRST116') throw error;

  if (!data) return null;

  return {
    ...data,
    creado_por_nombre: data.creado_por_primer_nombre && data.creado_por_apellido
      ? `${data.creado_por_primer_nombre} ${data.creado_por_apellido}`
      : null,
  };
}

export async function crearProduccion(
  fecha: string,
  galpon: string,
  huevos_totales_mediodia: number,
  huevos_cachados_mediodia: number,
  huevos_totales_tarde: number,
  huevos_cachados_tarde: number,
  mortandad: number,
  observaciones?: string
): Promise<Produccion> {
  const { data: { user } } = await supabase.auth.getUser();

  // Obtener nombre del usuario desde perfiles
  const { data: perfil } = await supabase
    .from('perfiles')
    .select('primer_nombre, apellido')
    .eq('id', user?.id)
    .single();

  const { data, error } = await supabase
    .from('producciones')
    .insert([{
      fecha,
      galpon,
      huevos_totales_mediodia,
      huevos_cachados_mediodia,
      huevos_totales_tarde,
      huevos_cachados_tarde,
      mortandad,
      observaciones,
      creado_por: user?.id,
      creado_por_primer_nombre: perfil?.primer_nombre || null,
      creado_por_apellido: perfil?.apellido || null,
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function actualizarProduccion(
  id: string,
  huevos_totales_mediodia: number,
  huevos_cachados_mediodia: number,
  huevos_totales_tarde: number,
  huevos_cachados_tarde: number,
  mortandad: number,
  observaciones?: string
): Promise<Produccion> {
  const { data, error } = await supabase
    .from('producciones')
    .update({
      huevos_totales_mediodia,
      huevos_cachados_mediodia,
      huevos_totales_tarde,
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
