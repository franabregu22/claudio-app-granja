import { supabase } from '../lib/supabase';

export interface CategoriaFinanzas {
  id: number;
  categoria_tecnica: string;
  subcategoria: string;
  categoria_analisis: 'GASTOS_OPERATIVOS' | 'REINVERSION_OPERATIVA' | 'INVERSION';
  activo: boolean;
}

export async function listarCategorias(): Promise<CategoriaFinanzas[]> {
  const { data, error } = await supabase
    .from('categorias_finanzas')
    .select('*')
    .eq('activo', true)
    .order('categoria_tecnica', { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function crearCategoria(categoria: Omit<CategoriaFinanzas, 'id' | 'activo'>): Promise<CategoriaFinanzas> {
  const { data, error } = await supabase
    .from('categorias_finanzas')
    .insert([{ ...categoria, activo: true }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function actualizarCategoria(id: number, updates: Partial<CategoriaFinanzas>): Promise<CategoriaFinanzas> {
  const { data, error } = await supabase
    .from('categorias_finanzas')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function desactivarCategoria(id: number): Promise<void> {
  const { error } = await supabase
    .from('categorias_finanzas')
    .update({ activo: false })
    .eq('id', id);

  if (error) throw error;
}

export async function actualizarMovimientoCategoria(
  movimientoId: number,
  categoriaTecnica: string,
  subcategoria: string
): Promise<any> {
  // Find the categoria_analisis for this categoria_tecnica + subcategoria combination
  const { data: categoriaData, error: catError } = await supabase
    .from('categorias_finanzas')
    .select('categoria_analisis')
    .eq('categoria_tecnica', categoriaTecnica)
    .eq('subcategoria', subcategoria)
    .single();

  if (catError) throw new Error(`Categoría no encontrada: ${categoriaTecnica} - ${subcategoria}`);

  const { data, error } = await supabase
    .from('movimientos_caja')
    .update({
      categoria_tecnica: categoriaTecnica,
      categoria_analisis: categoriaData.categoria_analisis,
    })
    .eq('id', movimientoId)
    .select()
    .single();

  if (error) throw error;
  return data;
}
