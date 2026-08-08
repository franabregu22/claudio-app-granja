import { supabase } from '../lib/supabase';
import type { Categoria, Precios } from '../types/domain';

export async function leerPreciosActuales(): Promise<Precios> {
  const { data, error } = await supabase
    .from('precios_actuales')
    .select('categoria, precio')
    .order('categoria');

  if (error) throw error;

  const precios: Precios = {
    xl: 0,
    n1: 0,
    n2: 0,
    n3: 0,
    docena: 0,
  };

  (data || []).forEach((row) => {
    precios[row.categoria as Categoria] = row.precio;
  });

  return precios;
}

export async function actualizarPrecio(
  categoria: Categoria,
  precio: number
): Promise<void> {
  const { error } = await supabase
    .from('precios_actuales')
    .update({ precio })
    .eq('categoria', categoria);

  if (error) throw error;
}
