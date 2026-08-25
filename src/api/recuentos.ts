import { supabase } from '../lib/supabase';
import type { RecuentoLote } from '../types/domain';

export async function listarRecuentos(): Promise<RecuentoLote[]> {
  const { data, error } = await supabase
    .from('recuentos_lote')
    .select('*')
    .order('fecha_recuento', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function obtenerRecuentosPorLote(loteId: string): Promise<RecuentoLote[]> {
  const { data, error } = await supabase
    .from('recuentos_lote')
    .select('*')
    .eq('lote_id', loteId)
    .order('fecha_recuento', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function crearRecuento(
  loteId: string,
  fechaRecuento: string,
  avesContadas: number,
  mortandadEsperada?: number,
  notas?: string
): Promise<RecuentoLote> {
  const { data, error } = await supabase
    .from('recuentos_lote')
    .insert({
      lote_id: loteId,
      fecha_recuento: fechaRecuento,
      aves_contadas: avesContadas,
      mortandad_esperada: mortandadEsperada,
      notas,
    })
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Failed to create recuento');
  return data;
}

export async function actualizarRecuento(
  recuentoId: string,
  avesContadas: number,
  mortandadEsperada?: number,
  notas?: string
): Promise<RecuentoLote> {
  const { data, error } = await supabase
    .from('recuentos_lote')
    .update({
      aves_contadas: avesContadas,
      mortandad_esperada: mortandadEsperada,
      notas,
      actualizado_en: new Date().toISOString(),
    })
    .eq('id', recuentoId)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Recuento not found');
  return data;
}

export async function eliminarRecuento(recuentoId: string): Promise<void> {
  const { error } = await supabase
    .from('recuentos_lote')
    .delete()
    .eq('id', recuentoId);

  if (error) throw error;
}
