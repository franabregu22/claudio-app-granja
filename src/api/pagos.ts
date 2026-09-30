import { supabase } from '../lib/supabase';

// Legacy Caja helper kept for caja/ListaMovimientos until F27-D replaces the Caja module.
// The legacy collection path (pagos insert / list / delete) was removed in F27-C: collections use register_collection.
export async function agregarPagoAlaCaja(pagoId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id;

  if (!userId) throw new Error('No authenticated user');

  // First check if it already exists
  const { data: existing, error: checkError } = await supabase
    .from('pago_en_caja')
    .select('id')
    .eq('pago_id', pagoId)
    .maybeSingle();

  if (checkError && checkError.code !== 'PGRST116') {
    throw checkError;
  }

  // If it already exists, just return without error
  if (existing) {
    console.log('Pago ya estaba agregado a caja');
    return;
  }

  // If it doesn't exist, insert it
  const { error } = await supabase
    .from('pago_en_caja')
    .insert({
      pago_id: pagoId,
      agregado_por: userId,
    });

  if (error) {
    console.error('Error inserting pago_en_caja:', error);
    throw error;
  }

  console.log('Pago agregado a caja correctamente');
}
