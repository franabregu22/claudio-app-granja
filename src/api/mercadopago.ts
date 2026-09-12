import { supabase } from '../lib/supabase';
import { argentinaPeriod, collectPages, moneyCents, summarizeLedger } from '../lib/mercadopago-calculations';

const ACCOUNT_ID = 1054315166;

export interface MPMovement {
  id: number;
  transaction_date: string;
  movement_class: string;
  settlement_amount: number;
  source_id?: string;
}

export interface MPSummary {
  /** Neto del período, no saldo disponible de la cuenta. */
  balance: number;
  ingresos: number;
  egresos: number;
  rendimientos: number;
  total_movimientos: number;
}

export async function getMPSummary(startDate: string, endDate: string): Promise<MPSummary> {
  return (await getMPPeriod(startDate, endDate)).summary;
}

export async function getMPPeriod(startDate: string, endDate: string) {
  const period = argentinaPeriod(startDate, endDate);
  const data = await collectPages<any>((from, to) => supabase
    .from('mp_financial_movement')
    .select('id,transaction_date,movement_class,settlement_amount,ledger_entry(balance_impact,category),mp_movement_source_link(is_primary,mp_source_record(source_external_id))', { count: 'exact' })
    .eq('account_id', ACCOUNT_ID)
    .gte('transaction_date', period.start)
    .lt('transaction_date', period.endExclusive)
    .order('transaction_date', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to));
  const ledger = data.map(m => {
    const entries = Array.isArray(m.ledger_entry) ? m.ledger_entry : m.ledger_entry ? [m.ledger_entry] : [];
    if (entries.length !== 1 || moneyCents(entries[0].balance_impact) !== moneyCents(m.settlement_amount)) {
      throw new Error(`El movimiento ${m.id} tiene una diferencia en su registro de saldo. Revisá la conciliación.`);
    }
    return entries[0];
  });
  const movements: MPMovement[] = data.map(m => ({
    id: m.id,
    transaction_date: m.transaction_date,
    movement_class: m.movement_class,
    settlement_amount: m.settlement_amount,
    source_id: (m.mp_movement_source_link?.find((link: any) => link.is_primary) ?? m.mp_movement_source_link?.[0])?.mp_source_record?.source_external_id,
  }));
  return { summary: summarizeLedger(ledger), movements };
}

export async function getMPMovements(startDate: string, endDate: string, types?: string[]): Promise<MPMovement[]> {
  const { movements } = await getMPPeriod(startDate, endDate);
  return types?.length ? movements.filter(m => types.includes(m.movement_class)) : movements;
}

export interface MPClosingBalance {
  date: string;
  calculated: number | null;
  observed: number | null;
  difference: number | null;
}

export async function getMPClosingBalance(endDate: string): Promise<MPClosingBalance> {
  const balances = await collectPages<any>((from, to) => supabase.from('account_balance')
    .select('id,balance_date,opening_balance,opening_balance_date,observed_balance_mp', { count: 'exact' })
    .eq('account_id', ACCOUNT_ID).order('id').range(from, to));
  const observedRow = balances.find(b => b.balance_date === endDate);
  const observed = observedRow?.observed_balance_mp == null ? null : Number(observedRow.observed_balance_mp);
  const configurations = new Map<string, { amount: number; date: string }>();
  for (const b of balances) {
    if (b.opening_balance == null && b.opening_balance_date == null) continue;
    if (b.opening_balance == null || b.opening_balance_date == null) throw new Error('El saldo inicial tiene una configuración incompleta.');
    const amount = moneyCents(b.opening_balance);
    configurations.set(`${b.opening_balance_date}|${amount}`, { amount, date: b.opening_balance_date });
  }
  if (configurations.size > 1) throw new Error('Hay saldos iniciales contradictorios. Revisá la conciliación.');
  const opening = configurations.values().next().value;
  if (!opening || endDate < opening.date) return { date: endDate, calculated: null, observed, difference: null };
  const period = argentinaPeriod(opening.date, endDate);
  const ledger = await collectPages<any>((from, to) => supabase.from('ledger_entry')
    .select('id,balance_impact', { count: 'exact' }).eq('account_id', ACCOUNT_ID)
    .gte('occurred_at', period.start).lt('occurred_at', period.endExclusive).order('id').range(from, to));
  // Always recalculate: a historic import can leave account_balance's cached totals stale.
  const total = ledger.reduce((sum, row) => sum + moneyCents(row.balance_impact), opening.amount);
  return { date: endDate, calculated: total / 100, observed, difference: observed === null ? null : (total - moneyCents(observed)) / 100 };
}
