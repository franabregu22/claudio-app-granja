import { supabase } from '../lib/supabase';
import type { Pago, MetodoPago } from '../types/domain';

export async function crearPago(
  clienteId: string,
  monto: number,
  metodoPago: MetodoPago,
  fechaPago: string,
  notas?: string,
  movimientoCajaId?: number
): Promise<Pago> {
  // Get current user ID for audit trail
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id;
  // Obtener nombre del cliente
  const { data: cliente, error: clienteError } = await supabase
    .from('clientes')
    .select('nombre')
    .eq('id', clienteId)
    .single();

  if (clienteError || !cliente) {
    throw new Error('Cliente no encontrado');
  }

  // Crear pago
  const { data: pago, error: pagoError } = await supabase
    .from('pagos')
    .insert({
      cliente_id: clienteId,
      monto,
      metodo_pago: metodoPago,
      notas: notas || null,
      fecha_pago: fechaPago,
      creado_por: userId || null,
    })
    .select()
    .single();

  if (pagoError) throw pagoError;


  // Mapear forma de pago
  const formasPago: Record<MetodoPago, 'efectivo' | 'mercadopago' | 'echeq' | 'cheque'> = {
    'efectivo': 'efectivo',
    'transferencia': 'efectivo',
    'tarjeta': 'mercadopago',
    'mercadopago': 'mercadopago',
    'otro': 'efectivo',
    'cheque': 'cheque',
    'echeq': 'echeq',
  };

  // Si se proporciona un movimiento existente, vincularlo; si no, crear uno nuevo
  if (movimientoCajaId) {
    // Vincular a movimiento existente
    const { error: vincularError } = await supabase
      .from('movimientos_caja')
      .update({
        vinculado_a: 'pago',
        vinculado_id: pago.id,
        cliente_id: clienteId,
      })
      .eq('id', movimientoCajaId);

    if (vincularError) {
      throw new Error(`Pago creado pero no se pudo vincular el movimiento: ${vincularError.message}`);
    }

  } else {
    // Crear movimiento nuevo
    const { data: movimiento, error: cajaError } = await supabase
      .from('movimientos_caja')
      .insert({
        tipo: 'ingreso',
        concepto: `Cobro - ${cliente.nombre}`,
        monto,
        forma_pago: formasPago[metodoPago] || 'efectivo',
        fecha_operacion: fechaPago,
        fecha_pago: fechaPago,
        estado: 'confirmado',
        vinculado_a: 'pago',
        vinculado_id: pago.id,
        cliente_id: clienteId,
        notas: notas || null,
      })
      .select()
      .single();

    if (cajaError) {
      throw new Error(`Pago creado pero no se registró en Caja: ${cajaError.message}`);
    }

  }

  return pago;
}

export async function listarPagosCliente(clienteId: string): Promise<Pago[]> {
  const { data, error } = await supabase
    .from('pagos')
    .select('*, pago_en_caja(*)')
    .eq('cliente_id', clienteId)
    .order('fecha_pago', { ascending: false });

  if (error) throw error;

  console.log('Pagos cliente:', data?.length);
  if (data && data.length > 0) {
    console.log('First pago pago_en_caja:', JSON.stringify(data[0].pago_en_caja, null, 2));
  }

  // Fetch user names
  const userIds = new Set<string>();
  (data || []).forEach(p => {
    if (p.creado_por) userIds.add(p.creado_por);
    if (p.pago_en_caja?.[0]?.agregado_por) userIds.add(p.pago_en_caja[0].agregado_por);
  });

  const userNames: Record<string, string> = {};
  if (userIds.size > 0) {
    const { data: perfiles } = await supabase
      .from('perfiles')
      .select('id, primer_nombre, apellido')
      .in('id', Array.from(userIds));

    if (perfiles) {
      perfiles.forEach(p => {
        const nombreCompleto = [p.primer_nombre, p.apellido]
          .filter(Boolean)
          .join(' ') || '(sin nombre)';
        userNames[p.id] = nombreCompleto;
      });
    }
  }

  return (data || []).map((p: any) => ({
    ...p,
    creado_por_nombre: p.creado_por ? userNames[p.creado_por] || null : null,
    pago_en_caja: p.pago_en_caja?.[0] ? {
      ...p.pago_en_caja[0],
      agregado_por_nombre: userNames[p.pago_en_caja[0].agregado_por] || null,
    } : null,
  }));
}

export async function listarTodosPagos(): Promise<Pago[]> {
  const { data, error } = await supabase
    .from('pagos')
    .select('*, pago_en_caja(*)')
    .order('fecha_pago', { ascending: false });

  if (error) throw error;

  // Fetch user names
  const userIds = new Set<string>();
  (data || []).forEach(p => {
    if (p.creado_por) userIds.add(p.creado_por);
    if (p.pago_en_caja?.[0]?.agregado_por) userIds.add(p.pago_en_caja[0].agregado_por);
  });

  const userNames: Record<string, string> = {};
  if (userIds.size > 0) {
    const { data: perfiles } = await supabase
      .from('perfiles')
      .select('id, primer_nombre, apellido')
      .in('id', Array.from(userIds));

    if (perfiles) {
      perfiles.forEach(p => {
        const nombreCompleto = [p.primer_nombre, p.apellido]
          .filter(Boolean)
          .join(' ') || '(sin nombre)';
        userNames[p.id] = nombreCompleto;
      });
    }
  }

  return (data || []).map((p: any) => ({
    ...p,
    creado_por_nombre: p.creado_por ? userNames[p.creado_por] || null : null,
    pago_en_caja: p.pago_en_caja?.[0] ? {
      ...p.pago_en_caja[0],
      agregado_por_nombre: userNames[p.pago_en_caja[0].agregado_por] || null,
    } : null,
  }));
}

export async function eliminarPago(pagoId: string): Promise<void> {
  const { error } = await supabase
    .from('pagos')
    .delete()
    .eq('id', pagoId);

  if (error) throw error;
}

export async function agregarPagoAlaCaja(pagoId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id;

  if (!userId) throw new Error('No authenticated user');

  const { error } = await supabase
    .from('pago_en_caja')
    .insert({
      pago_id: pagoId,
      agregado_por: userId,
    });

  // If it's a duplicate key error (code 23505), that's OK - it means it's already marked
  // Supabase returns this as a 409 Conflict with the postgres code
  if (error) {
    if (error.code === '23505' || error.message?.includes('duplicate')) {
      console.log('Pago ya estaba agregado a caja');
      return;
    }
    throw error;
  }
}

export async function verificarPagoEnCaja(pagoId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('pago_en_caja')
    .select('id')
    .eq('pago_id', pagoId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return !!data;
}
