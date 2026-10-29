/**
 * Meta A (0090–0092) — frontend: outbound payments are classifiable in Actividad Mercado Pago; every manual route that
 * would move the Mercado Pago account picks a Mercado Pago movement instead (amount / date / SOURCE_ID from it) or is
 * blocked with the fixed message; Caja → Cobros de clientes reads fin_customer_collections and shows a corrected
 * collection once. The real supabase-js client is used with a recording fetch.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  type CustomerCollectionRow, filterLogicalCollections, groupCustomerCollections, listCustomerCollections,
} from '../../src/target/customerCollections';
import { TARGET_VIEWS } from '../../src/target/db';
import { errorMessage } from '../../src/target/messages';
import {
  isClassifiableOutbound, MP_SOURCE_MISSING_MESSAGE, MP_STATUS_LABEL, type MpActivityRow, type MpPayoutMatch, mpOutflowCandidates,
  mpOwnInflowCandidates, mpOwnPayoutCandidates, mpReceiptCandidates,
} from '../../src/target/mpActivity';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const BNA = 'bna-id';
const row = (p: Partial<MpActivityRow>): MpActivityRow => ({
  run_id: 'r', row_number: 1, occurred_at: null, business_date: '2026-10-13', description: 'payment', source_id: null, net_amount: null, gross_amount: null,
  payment_method: null, payment_method_type: null, coverage_status: 'COVERED', financial_operation_id: null, ...p,
});
const ACT: MpActivityRow[] = [
  row({ source_id: '182647082032', description: 'payment', coverage_status: 'OUTBOUND', business_date: '2026-10-06', net_amount: -103419.82, gross_amount: -102803 }),
  row({ source_id: '184117125762', description: 'payout', coverage_status: 'PAYOUT', business_date: '2026-10-14', net_amount: -1056890.93, gross_amount: -1056890.93 }),
  row({ source_id: '183984533002', description: 'payout', coverage_status: 'CLASSIFIED_OUTFLOW', net_amount: -759702.86, gross_amount: -759702.86 }),
  row({ source_id: '181533509871', description: 'payout', coverage_status: 'PAYOUT', business_date: '2026-10-05', net_amount: -500000, gross_amount: -500000 }),
  row({ source_id: '183527567414', description: 'payout', coverage_status: 'OWN_TRANSFER', net_amount: -300000, gross_amount: -300000 }),
  row({ source_id: '182961933745', description: 'payment', coverage_status: 'CLASSIFY_INFLOW', net_amount: 200000, gross_amount: 200000 }),
  row({ source_id: '182488096484', description: 'payment', coverage_status: 'COVERED', net_amount: 445000, gross_amount: 450000 }),
  row({ source_id: '999', description: 'payment', coverage_status: 'OUTBOUND', net_amount: 10, gross_amount: 10 }),
];
const MATCHES = new Map<string, MpPayoutMatch>([
  ['184117125762', { source_id: '184117125762', match_status: 'NO_OWN_ACCOUNT_MATCH', matched_account_id: null, matched_account_name: null, confidence: 'NONE', suggested_action: 'CLASSIFY_OUTFLOW' }],
  ['183984533002', { source_id: '183984533002', match_status: 'NO_OWN_ACCOUNT_MATCH', matched_account_id: null, matched_account_name: null, confidence: 'NONE', suggested_action: 'CLASSIFY_OUTFLOW' }],
  ['181533509871', { source_id: '181533509871', match_status: 'OWN_ACCOUNT_EXACT', matched_account_id: BNA, matched_account_name: 'BNA', confidence: 'HIGH', suggested_action: 'PROPOSE_INTERNAL_TRANSFER' }],
  ['183527567414', { source_id: '183527567414', match_status: 'OWN_ACCOUNT_EXACT', matched_account_id: BNA, matched_account_name: 'BNA', confidence: 'HIGH', suggested_action: 'PROPOSE_INTERNAL_TRANSFER' }],
]);

describe('Meta A — outbound payments (ADR-020)', () => {
  it('an unclassified outbound payment is classifiable; a classified one or a positive row is not', () => {
    expect(MP_STATUS_LABEL.OUTBOUND).toBe('Pago saliente sin registrar');   // ADR-021: without its provisional it is a technical exception
    expect(isClassifiableOutbound(ACT[0])).toBe(true);
    expect(isClassifiableOutbound(ACT[2])).toBe(false);
    expect(isClassifiableOutbound(ACT[7])).toBe(false);
  });
  it('Actividad Mercado Pago offers "Clasificar salida" on outbound rows', () => {
    expect(SRC('features/caja/CuentaDetalle.tsx')).toMatch(/\{isClassifiableOutbound\(r\) && r\.source_id && <ClasificarSalida sourceId=\{r\.source_id\} \/>\}/);
  });
});

describe('Meta A — Mercado Pago candidates of the manual routes', () => {
  it('outflows: unclassified third-party payouts and outbound payments, amount = |gross| (economic amount; tax apart)', () => {
    expect(mpOutflowCandidates(ACT, MATCHES).map((c) => [c.sourceId, c.amount, c.date])).toEqual([
      ['182647082032', 102803, '2026-10-06'], ['184117125762', 1056890.93, '2026-10-14']]);
  });
  it('MP → own account: only the unconfirmed payout whose destination is exactly that account', () => {
    expect(mpOwnPayoutCandidates(ACT, MATCHES, BNA).map((c) => c.sourceId)).toEqual(['181533509871']);
    expect(mpOwnPayoutCandidates(ACT, MATCHES, 'otra')).toEqual([]);
  });
  it('own account → MP: only inflows awaiting classification', () => {
    expect(mpOwnInflowCandidates(ACT).map((c) => c.sourceId)).toEqual(['182961933745']);
  });
  it('client receipts: applied in treasury with an unassigned part; offered amount = what is left to assign', () => {
    const r = mpReceiptCandidates([
      { mp_financial_movement_id: 1, payment_id: '182488096484', occurred_date: '2026-10-05', axis_a_state: 'POSTED', effective_applied_receipt: 450000, active_attributed: 0 },
      { mp_financial_movement_id: 2, payment_id: '181962105709', occurred_date: '2026-10-07', axis_a_state: 'REPORT_CONFIRMED', effective_applied_receipt: 72000, active_attributed: 72000 },
      { mp_financial_movement_id: 3, payment_id: '1', occurred_date: '2026-10-07', axis_a_state: 'NORMALIZED', effective_applied_receipt: 10, active_attributed: 0 },
      { mp_financial_movement_id: 4, payment_id: '182485544561', occurred_date: '2026-10-10', axis_a_state: 'POSTED', effective_applied_receipt: 150000, active_attributed: 40000.5 },
    ]);
    expect(r.map((c) => [c.movementId, c.sourceId, c.amount, c.date])).toEqual([[1, '182488096484', 450000, '2026-10-05'], [4, '182485544561', 109999.5, '2026-10-10']]);
  });
  it('no candidate → the fixed blocking message; the database code shows the same text', () => {
    expect(MP_SOURCE_MISSING_MESSAGE).toBe('No encontramos todavía el movimiento correspondiente en Mercado Pago. Esperá a que aparezca en Actividad Mercado Pago o registralo desde allí.');
    expect(errorMessage({ message: 'MP_POSTING_REQUIRES_SOURCE: operation 9 moves Mercado Pago without SOURCE_ID' })).toBe(MP_SOURCE_MISSING_MESSAGE);
    expect(SRC('features/caja/MovimientoMp.tsx')).toMatch(/candidatos\.length === 0\) return <BloqueoMp mensaje=\{MP_SOURCE_MISSING_MESSAGE\} \/>/);
  });
  it('every manual route uses the Mercado Pago movement (or blocks) when the account is Mercado Pago', () => {
    const cobro = SRC('features/cobros/RegistroPagoModal.tsx');
    expect(cobro).toMatch(/asignar\.mutate\(\{ movementId: elegidoMp\.movementId, clienteId: cliente\.cliente_id, amount: montoMpNum, effectiveDate: elegidoMp\.date/);
    // Lote 1B: the amount may be lower than what is left (split / partial), never higher
    expect(cobro).toMatch(/montoMpNum > 0 && montoMpNum <= \(elegidoMp\?\.amount \?\? 0\)/);
    const pagar = SRC('features/caja/CuentasAPagar.tsx');
    expect(pagar).toMatch(/outflow\.mutate\(\{ sourceId: movimientoMp, classification: 'SUPPLIER_PAYMENT', supplierId: proveedor\.entity_id \}/);
    const retiro = SRC('features/finanzas/EventoGestionModal.tsx');
    expect(retiro).toMatch(/outflow\.mutate\(\{ sourceId: movimientoMp, classification: 'OWNER_WITHDRAWAL' \}/);
    const trf = SRC('features/caja/ResumenSaldos.tsx');
    expect(trf).toMatch(/confirmarRetiro\.mutate\(movimientoMp/);
    expect(trf).toMatch(/ownTransfer\.mutate\(\{ paymentId: movimientoMp, fromAccountId: origen \}/);
    expect(SRC('features/fiscal/FiscalApp.tsx')).toMatch(/\{esMp && <BloqueoMp \/>\}/);
    expect(SRC('features/caja/Cheques.tsx')).toMatch(/\{esMp && <BloqueoMp \/>\}/);
    for (const f of ['features/cobros/RegistroPagoModal.tsx', 'features/caja/CuentasAPagar.tsx', 'features/finanzas/EventoGestionModal.tsx', 'features/caja/ResumenSaldos.tsx']) {
      expect(SRC(f)).toMatch(/useEsCuentaMp\(/);
    }
  });
});

const C = (p: Partial<CustomerCollectionRow>): CustomerCollectionRow => ({
  row_id: 'x', business_date: '2026-10-10', created_at: '2026-10-10T10:00:00Z', cliente_id: 'c1', client_name: 'Cliente', amount: 0,
  account_name: 'Mercado Pago', account_type: 'EXTERNAL_SERVICE', payment_method: 'MERCADOPAGO', notes: null, financial_operation_id: null,
  source_id: null, origin: 'MANUAL_MP', status: 'MANUAL_WITHOUT_SOURCE', correction_id: null, correction_role: 'SINGLE', counts_for_customer: true, ...p,
});
const ROWS: CustomerCollectionRow[] = [
  C({ row_id: 'C:orig200', amount: 200000, status: 'CORRECTED', correction_id: 'k200', correction_role: 'CORRECTED_ORIGINAL', counts_for_customer: false }),
  C({ row_id: 'A:mp150', amount: 150000, origin: 'CORRECTION', status: 'ALLOCATED_TO_CUSTOMER', source_id: '182485544561', correction_id: 'k200', correction_role: 'COMPONENT', created_at: '2026-10-15T10:00:00Z' }),
  C({ row_id: 'C:cash50', amount: 50000, account_name: 'Caja chica', account_type: 'CASH', payment_method: 'CASH', origin: 'CORRECTION', status: 'CASH', correction_id: 'k200', correction_role: 'COMPONENT', created_at: '2026-10-15T10:00:01Z' }),
  C({ row_id: 'C:bank', cliente_id: 'c2', client_name: 'Otro', business_date: '2026-10-12', amount: 30000, account_name: 'BNA', account_type: 'BANK_ACCOUNT', payment_method: 'TRANSFER', origin: 'BANK', status: 'PENDING_RECONCILIATION' }),
];

describe('Meta A — Caja → Cobros de clientes (0092)', () => {
  it('reads only fin_customer_collections with the date range, newest first; numeric amounts', async () => {
    const seen: URL[] = [];
    const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL) => {
      seen.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
      return new Response(JSON.stringify([{ ...ROWS[3], amount: '30000.00', financial_operation_id: '77' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch } });
    const r = await listCustomerCollections(client, { from: '2026-09-01', to: '2026-10-15' });
    expect(r[0].amount).toBe(30000);
    expect(r[0].financial_operation_id).toBe(77);
    expect(seen.map((u) => u.pathname)).toEqual(['/rest/v1/fin_customer_collections']);
    expect(seen[0].searchParams.getAll('business_date')).toEqual(['gte.2026-09-01', 'lte.2026-10-15']);
    expect(seen[0].searchParams.get('select')).not.toMatch(/cbu|cvu/i);
    expect(TARGET_VIEWS).toContain('fin_customer_collections');
  });
  it('a corrected split collection is ONE logical collection of the original amount, with its parts', () => {
    const g = groupCustomerCollections(ROWS);
    expect(g.map((i) => [i.key, i.amount, i.parts.map((p) => p.row_id)])).toEqual([
      ['C:bank', 30000, []], ['K:k200', 200000, ['A:mp150', 'C:cash50']]]);
  });
  it('filters: client, account, method, status (a group matches through any part)', () => {
    const g = groupCustomerCollections(ROWS);
    expect(filterLogicalCollections(g, { account: 'Caja chica' }).map((i) => i.key)).toEqual(['K:k200']);
    expect(filterLogicalCollections(g, { method: 'TRANSFER' }).map((i) => i.key)).toEqual(['C:bank']);
    expect(filterLogicalCollections(g, { status: 'CORRECTED' }).map((i) => i.key)).toEqual(['K:k200']);
    expect(filterLogicalCollections(g, { clienteId: 'c2' }).map((i) => i.key)).toEqual(['C:bank']);
  });
  it('the Caja tab exists', () => {
    expect(SRC('features/caja/CajaApp.tsx')).toMatch(/\{ id: 'cobros', label: 'Cobros de clientes' \}/);
  });
});
