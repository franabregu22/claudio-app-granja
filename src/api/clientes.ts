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

export async function listarTodosClientes(): Promise<Cliente[]> {
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .order('nombre');

  if (error) throw error;
  return data || [];
}

export async function crearCliente(nombre: string, categoria: string = 'particular'): Promise<Cliente> {
  const { data, error } = await supabase
    .from('clientes')
    .insert([{ nombre, categoria, activo: true }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function actualizarCliente(
  id: string,
  nombre: string,
  categoria: string,
  activo: boolean
): Promise<Cliente> {
  const { data, error } = await supabase
    .from('clientes')
    .update({ nombre, categoria, activo })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
