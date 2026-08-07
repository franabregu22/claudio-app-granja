import { supabase } from '../lib/supabase';
import type { Categoria, Precios } from '../types/domain';

export async function leerPreciosActuales(): Promise<Precios> {
  const { data, error } = await supabase
    .from('precios_actuales')
    .select('categoria, precio')
    .order('categoria');

  if (error) throw error;

  const precios: Precios = {
    jumbo: 4500,
    aaa: 4200,
    aa: 3900,
    a: 3600,
    b: 3200,
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
