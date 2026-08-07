import { supabase } from '../lib/supabase';
import type { Cliente } from '../types/domain';

export async function listarClientes(): Promise<Cliente[]> {
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .eq('activo', true)
    .order('nombre');

  if (error) throw error;
  return data || [];
}

export async function crearCliente(nombre: string): Promise<Cliente> {
  const { data, error } = await supabase
    .from('clientes')
    .insert([{ nombre }])
    .select()
    .single();

  if (error) throw error;
  return data;
}
