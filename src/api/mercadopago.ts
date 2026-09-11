import { supabase } from '../lib/supabase';

const ACCOUNT_ID = 1054315166;

export interface MPMovement {
  id: number;
  movement_date: string;
  movement_class: string;
  ledger_category: string;
  amount_pesos: number;
  source_id?: string;
  description?: string;
}

export interface MPSummary {
  balance: number;
  ingresos: number;
  egresos: number;
  rendimientos: number;
  total_movimientos: number;
}

export async function getMPSummary(startDate: string, endDate: string): Promise<MPSummary> {
  const { data, error } = await supabase.from('ledger_entry').select(
    `
    balance_impact,
    financial_movement:mp_financial_movement(movement_class, ledger_category)
    `,
    { count: 'exact' }
  )
    .eq('financial_movement.account_id', ACCOUNT_ID)
    .gte('created_at', startDate)
    .lte('created_at', endDate);

  if (error) throw error;

  let balance = 0;
  let ingresos = 0;
  let egresos = 0;
  let rendimientos = 0;

  data?.forEach((entry: any) => {
    const amount = entry.balance_impact || 0;
    balance += amount;

    const category = entry.financial_movement?.ledger_category;
    if (category === 'income') {
      ingresos += amount;
    } else if (category === 'expense') {
      egresos += Math.abs(amount);
    } else if (category === 'interest_income') {
      rendimientos += amount;
    }
  });

  return {
    balance,
    ingresos,
    egresos,
    rendimientos,
    total_movimientos: data?.length || 0,
  };
}

export async function getMPMovements(startDate: string, endDate: string, types?: string[]): Promise<MPMovement[]> {
  let query = supabase
    .from('mp_financial_movement')
    .select(
      `
      id,
      movement_date,
      movement_class,
      ledger_category,
      amount_pesos,
      mp_movement_source_link(mp_source_record(source_external_id, source_description))
      `
    )
    .eq('account_id', ACCOUNT_ID)
    .gte('movement_date', startDate)
    .lte('movement_date', endDate)
    .order('movement_date', { ascending: false });

  const { data, error } = await query;

  if (error) throw error;

  let movements = (data || []).map((m: any) => ({
    id: m.id,
    movement_date: m.movement_date,
    movement_class: m.movement_class,
    ledger_category: m.ledger_category,
    amount_pesos: m.amount_pesos,
    source_id: m.mp_movement_source_link?.[0]?.mp_source_record?.source_external_id,
    description: m.mp_movement_source_link?.[0]?.mp_source_record?.source_description,
  }));

  if (types && types.length > 0) {
    movements = movements.filter(m => types.includes(m.movement_class));
  }

  return movements;
}

export async function getCurrentLedgerBalance(): Promise<number> {
  const { data, error } = await supabase
    .from('ledger_entry')
    .select('balance_impact', { count: 'exact' })
    .eq('financial_movement.account_id', ACCOUNT_ID);

  if (error) throw error;

  return (data || []).reduce((sum: number, entry: any) => sum + (entry.balance_impact || 0), 0);
}
