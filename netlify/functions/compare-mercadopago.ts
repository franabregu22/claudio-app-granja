import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || '',
  process.env.VITE_SUPABASE_ANON_KEY || ''
);

const ACCOUNT_ID = 1054315166;

const handler: Handler = async () => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    const { data: movements, error: movError } = await supabase
      .from('mp_financial_movement')
      .select('movement_class,settlement_amount,transaction_date')
      .eq('account_id', ACCOUNT_ID);

    if (movError) throw movError;

    const summary: Record<string, any> = {};
    let grandTotal = 0;

    movements?.forEach((m: any) => {
      const type = m.movement_class;
      if (!summary[type]) {
        summary[type] = { count: 0, total: 0, min_date: null, max_date: null };
      }
      summary[type].count++;
      summary[type].total += m.settlement_amount;
      grandTotal += m.settlement_amount;

      const date = m.transaction_date.split('T')[0];
      if (!summary[type].min_date || date < summary[type].min_date) {
        summary[type].min_date = date;
      }
      if (!summary[type].max_date || date > summary[type].max_date) {
        summary[type].max_date = date;
      }
    });

    const { data: ledger, error: ledgerError } = await supabase
      .from('ledger_entry')
      .select('category,balance_impact')
      .eq('account_id', ACCOUNT_ID);

    if (ledgerError) throw ledgerError;

    const ledgerByCategory: Record<string, any> = {};
    let totalBalance = 0;

    ledger?.forEach((e: any) => {
      const cat = e.category;
      if (!ledgerByCategory[cat]) {
        ledgerByCategory[cat] = { count: 0, total: 0 };
      }
      ledgerByCategory[cat].count++;
      ledgerByCategory[cat].total += e.balance_impact;
      totalBalance += e.balance_impact;
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        by_movement_class: {
          ...Object.fromEntries(
            Object.entries(summary).map(([type, data]: [string, any]) => [
              type,
              {
                cantidad: data.count,
                total: parseFloat(data.total.toFixed(2)),
                periodo: `${data.min_date} a ${data.max_date}`,
              },
            ])
          ),
          grand_total: parseFloat(grandTotal.toFixed(2)),
        },
        by_ledger_category: {
          ...Object.fromEntries(
            Object.entries(ledgerByCategory).map(([cat, data]: [string, any]) => [
              cat,
              {
                cantidad: data.count,
                total: parseFloat(data.total.toFixed(2)),
              },
            ])
          ),
          saldo_total: parseFloat(totalBalance.toFixed(2)),
        },
        total_movimientos: movements?.length || 0,
        timestamp: new Date().toISOString(),
      }),
      headers,
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Error desconocido",
      }),
      headers,
    };
  }
};

export { handler };
