/**
 * Validación de queries de MercadoPago
 * Corre cada query y reporta si hay errores o datos vacíos
 */

import { createClient } from '@supabase/supabase-js';

const ACCOUNT_ID = 1054315166;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function validateMPFinancialMovement() {
  console.log('📋 Validando: mp_financial_movement...');
  const { data, error, count } = await supabase
    .from('mp_financial_movement')
    .select('id,transaction_date,movement_class,settlement_amount', { count: 'exact' })
    .eq('account_id', ACCOUNT_ID)
    .limit(5);

  if (error) {
    console.error('❌ Error en mp_financial_movement:', error);
    return false;
  }
  console.log(`✅ mp_financial_movement: ${count} registros (muestra: ${data?.length})`);
  return true;
}

async function validateLedgerEntry() {
  console.log('📋 Validando: ledger_entry...');
  const { data, error, count } = await supabase
    .from('ledger_entry')
    .select('id,balance_impact,category,financial_movement_id', { count: 'exact' })
    .eq('account_id', ACCOUNT_ID)
    .limit(5);

  if (error) {
    console.error('❌ Error en ledger_entry:', error);
    return false;
  }
  console.log(`✅ ledger_entry: ${count} registros (muestra: ${data?.length})`);
  return true;
}

async function validateMPMovementSourceLink() {
  console.log('📋 Validando: mp_movement_source_link...');
  const { data, error, count } = await supabase
    .from('mp_movement_source_link')
    .select('id,financial_movement_id,source_record_id,is_primary', { count: 'exact' })
    .limit(5);

  if (error) {
    console.error('❌ Error en mp_movement_source_link:', error);
    return false;
  }
  console.log(`✅ mp_movement_source_link: ${count} registros (muestra: ${data?.length})`);
  return true;
}

async function validateMPSourceRecord() {
  console.log('📋 Validando: mp_source_record...');
  const { data, error, count } = await supabase
    .from('mp_source_record')
    .select('id,source_type,source_external_id', { count: 'exact' })
    .limit(5);

  if (error) {
    console.error('❌ Error en mp_source_record:', error);
    return false;
  }
  console.log(`✅ mp_source_record: ${count} registros (muestra: ${data?.length})`);
  return true;
}

async function validateAccountBalance() {
  console.log('📋 Validando: account_balance...');
  const { data, error, count } = await supabase
    .from('account_balance')
    .select('id,balance_date,calculated_balance,observed_balance_mp', { count: 'exact' })
    .eq('account_id', ACCOUNT_ID)
    .limit(5);

  if (error) {
    console.error('❌ Error en account_balance:', error);
    return false;
  }
  console.log(`✅ account_balance: ${count} registros (muestra: ${data?.length})`);
  return true;
}

async function validateComplexQuery() {
  console.log('📋 Validando: query con relaciones (como getMPPeriod)...');
  const { data, error } = await supabase
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
    .limit(3);

  if (error) {
    console.error('❌ Error en query compleja:', error);
    return false;
  }

  if (!data || data.length === 0) {
    console.warn('⚠️  Query compleja retornó sin datos');
    return false;
  }

  console.log(`✅ Query compleja OK. Muestra de 1 registro:`);
  const sample = data[0];
  console.log(`   - movement_id: ${sample.id}`);
  console.log(`   - movement_class: ${sample.movement_class}`);
  console.log(`   - ledger_entry: ${Array.isArray(sample.ledger_entry) ? sample.ledger_entry.length : sample.ledger_entry ? 1 : 0} entry(ies)`);
  console.log(`   - mp_movement_source_link: ${Array.isArray(sample.mp_movement_source_link) ? sample.mp_movement_source_link.length : 0} link(s)`);
  return true;
}

async function main() {
  console.log('🔍 Validación de MercadoPago - Queries\n');

  const results = [
    await validateMPFinancialMovement(),
    await validateLedgerEntry(),
    await validateMPMovementSourceLink(),
    await validateMPSourceRecord(),
    await validateAccountBalance(),
    await validateComplexQuery(),
  ];

  console.log('\n📊 Resumen:');
  const passed = results.filter(r => r).length;
  const total = results.length;
  console.log(`${passed}/${total} validaciones pasaron`);

  if (passed === total) {
    console.log('✅ Todas las queries están listas para usar');
    process.exit(0);
  } else {
    console.log('❌ Hay errores en las queries. Revisá arriba.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
