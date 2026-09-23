import { supabase } from '../lib/supabase';

const ACCOUNT_ID = 1054315166;

export interface MonthlyReport {
  mes: string;
  ingresos: number;
  egresos: number;
  rendimientos: number;
  impuesto_al_cheque: number;
}

async function fetchAllWithPagination(
  table: string,
  select: string,
  filter?: { field: string; operator: string; value: any }
): Promise<any[]> {
  const allData: any[] = [];
  let offset = 0;
  const pageSize = 1000;

  for (;;) {
    let query = supabase.from(table).select(select).range(offset, offset + pageSize - 1);

    if (filter) {
      query = query.filter(filter.field, filter.operator, filter.value);
    }

    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) break;
    allData.push(...(data || []));
    if ((data || []).length < pageSize) break;
    offset += pageSize;
  }

  return allData;
}

export async function getMPMonthlyReport(): Promise<MonthlyReport[]> {
  const movements = await fetchAllWithPagination(
    'mp_financial_movement',
    'transaction_date,tax_amount,id',
    { field: 'account_id', operator: 'eq', value: ACCOUNT_ID }
  );

  const ledger = await fetchAllWithPagination(
    'ledger_entry',
    'occurred_at,category,balance_impact,account_id',
    { field: 'account_id', operator: 'eq', value: ACCOUNT_ID }
  );

  const monthlyData: Record<string, any> = {};

  // Agrupar ledger por mes
  ledger.forEach((entry: any) => {
    const date = new Date(entry.occurred_at);
    const mes = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!monthlyData[mes]) {
      monthlyData[mes] = {
        ingresos: 0,
        egresos: 0,
        rendimientos: 0,
        impuesto_al_cheque: 0
      };
    }

    const amount = entry.balance_impact || 0;
    if (entry.category === 'income') {
      monthlyData[mes].ingresos += amount;
    } else if (entry.category === 'expense') {
      monthlyData[mes].egresos += Math.abs(amount);
    } else if (entry.category === 'transfer' && amount < 0) {
      monthlyData[mes].egresos += Math.abs(amount);
    } else if (entry.category === 'interest_income') {
      monthlyData[mes].rendimientos += amount;
    }
  });

  // Agrupar impuestos por mes
  movements.forEach((mov: any) => {
    if (!mov.tax_amount || mov.tax_amount === 0) return;

    const date = new Date(mov.transaction_date);
    const mes = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!monthlyData[mes]) {
      monthlyData[mes] = {
        ingresos: 0,
        egresos: 0,
        rendimientos: 0,
        impuesto_al_cheque: 0
      };
    }

    monthlyData[mes].impuesto_al_cheque += Math.abs(mov.tax_amount);
  });

  // Convertir a array ordenado
  const report: MonthlyReport[] = Object.entries(monthlyData)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, data]) => ({
      mes,
      ingresos: Math.round(data.ingresos * 100) / 100,
      egresos: Math.round(data.egresos * 100) / 100,
      rendimientos: Math.round(data.rendimientos * 100) / 100,
      impuesto_al_cheque: Math.round(data.impuesto_al_cheque * 100) / 100,
    }));

  return report;
}
