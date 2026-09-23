import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ACCOUNT_ID = 1054315166;

interface ValidationResult {
  name: string;
  status: 'pass' | 'fail' | 'warning';
  message: string;
  details?: any;
}

const handler: Handler = async (event, context) => {
  const results: ValidationResult[] = [];

  try {
    // 1. Validar mp_financial_movement
    const { count: mfCount, error: mfError } = await supabase
      .from('mp_financial_movement')
      .select('*', { count: 'exact', head: true })
      .eq('account_id', ACCOUNT_ID);

    if (mfError) {
      results.push({
        name: 'mp_financial_movement',
        status: 'fail',
        message: `Error: ${mfError.message}`,
      });
    } else {
      results.push({
        name: 'mp_financial_movement',
        status: mfCount! > 0 ? 'pass' : 'warning',
        message: `${mfCount} registros encontrados`,
        details: { count: mfCount },
      });
    }

    // 2. Validar ledger_entry
    const { count: leCount, error: leError } = await supabase
      .from('ledger_entry')
      .select('*', { count: 'exact', head: true })
      .eq('account_id', ACCOUNT_ID);

    if (leError) {
      results.push({
        name: 'ledger_entry',
        status: 'fail',
        message: `Error: ${leError.message}`,
      });
    } else {
      results.push({
        name: 'ledger_entry',
        status: leCount! > 0 ? 'pass' : 'warning',
        message: `${leCount} registros encontrados`,
        details: { count: leCount },
      });
    }

    // 3. Validar que 1:1 entre mp_financial_movement y ledger_entry
    if (mfCount && leCount) {
      if (mfCount === leCount) {
        results.push({
          name: 'Relación 1:1 (mfm ↔ ledger)',
          status: 'pass',
          message: `Ambas tablas tienen ${mfCount} registros`,
        });
      } else {
        results.push({
          name: 'Relación 1:1 (mfm ↔ ledger)',
          status: 'warning',
          message: `Desajuste: mp_financial_movement=${mfCount}, ledger_entry=${leCount}`,
        });
      }
    }

    // 4. Validar account_balance
    const { count: abCount, error: abError } = await supabase
      .from('account_balance')
      .select('*', { count: 'exact', head: true })
      .eq('account_id', ACCOUNT_ID);

    if (abError) {
      results.push({
        name: 'account_balance',
        status: 'fail',
        message: `Error: ${abError.message}`,
      });
    } else {
      results.push({
        name: 'account_balance',
        status: abCount! > 0 ? 'pass' : 'warning',
        message: `${abCount} registros encontrados`,
        details: { count: abCount },
      });
    }

    // 5. Validar query compleja (como la usa getMPPeriod)
    const { data: complexData, error: complexError } = await supabase
      .from('mp_financial_movement')
      .select(
        `id,
         transaction_date,
         movement_class,
         settlement_amount,
         ledger_entry(balance_impact,category),
         mp_movement_source_link(is_primary,mp_source_record(source_external_id))`
      )
      .eq('account_id', ACCOUNT_ID)
      .limit(1);

    if (complexError) {
      results.push({
        name: 'Query compleja (getMPPeriod)',
        status: 'fail',
        message: `Error: ${complexError.message}`,
      });
    } else {
      results.push({
        name: 'Query compleja (getMPPeriod)',
        status: 'pass',
        message: 'Query retorna datos correctamente',
        details: { sample: complexData?.[0] || null },
      });
    }

    // 6. Validar query de monthly report (como la usa getMPMonthlyReport)
    const { data: monthlyData, error: monthlyError } = await supabase
      .from('ledger_entry')
      .select('occurred_at,category,balance_impact')
      .eq('account_id', ACCOUNT_ID)
      .limit(1);

    if (monthlyError) {
      results.push({
        name: 'Query mensual (getMPMonthlyReport)',
        status: 'fail',
        message: `Error: ${monthlyError.message}`,
      });
    } else {
      results.push({
        name: 'Query mensual (getMPMonthlyReport)',
        status: 'pass',
        message: 'Query retorna datos correctamente',
      });
    }

    // Resumen
    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    const warnings = results.filter(r => r.status === 'warning').length;

    return {
      statusCode: failed > 0 ? 400 : 200,
      body: JSON.stringify({
        summary: {
          total: results.length,
          passed,
          failed,
          warnings,
          ready: failed === 0,
        },
        results,
      }),
    };
  } catch (error) {
    console.error('Validation error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Validation failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};

export { handler };
