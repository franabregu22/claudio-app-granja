/**
 * ADR-021 (0093) — frontend: a real Mercado Pago outflow is already in the balance and only waits for its classification.
 * Caja → Saldos shows the pending card ("Pendientes de clasificar: N" / "Todo clasificado"), Caja → Pendientes de clasificar
 * lists only what needs a person (technical exceptions apart, receipts without a client never), and a pending outflow keeps
 * the existing classification routes. The real supabase-js client is used with a recording fetch.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { TARGET_RPCS, TARGET_VIEWS } from '../../src/target/db';
import { errorMessage } from '../../src/target/messages';
import {
  isClassifiableOutbound, MP_STATUS_LABEL, type MpActivityRow, type MpPayoutMatch, mpOutflowCandidates, mpOwnPayoutCandidates, mpStatusLabel,
  PENDING_ACTIVITY_NOTE,
} from '../../src/target/mpActivity';
import {
  HISTORICAL_INFLOW_ACTION, listPendingClassification, listTechnicalReview, PENDING_BALANCE_NOTE, PENDING_KIND_LABEL, postingOperationLabel, postPendingOutflow, summarizePending,
} from '../../src/target/pendingClassification';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const recording = (body: unknown) => {
  const seen: { url: URL; body: string }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
};
const row = (p: Partial<MpActivityRow>): MpActivityRow => ({
  run_id: 'r', row_number: 1, occurred_at: null, business_date: '2026-10-15', description: 'payment', source_id: null, net_amount: null, gross_amount: null,
  payment_method: null, payment_method_type: null, coverage_status: 'COVERED', financial_operation_id: null, ...p,
});

describe('ADR-021 — pending classification data', () => {
  it('reads only fin_mp_pending_classification; numeric amounts; no balance column', async () => {
    const { client, seen } = recording([{ pending_key: 'OUT:184280177388', source_id: '184280177388', kind: 'PAYOUT', direction: 'OUT', business_date: '2026-10-15',
      occurred_at: null, amount: '-68043.27', economic_amount: '67637.45', charges_amount: '-405.82', account_name: 'Mercado Pago', description: 'payout',
      status: 'PENDING', already_posted: true, financial_operation_id: '7' }]);
    const r = await listPendingClassification(client);
    expect(r[0].amount).toBe(-68043.27);
    expect(r[0].financial_operation_id).toBe(7);
    expect(seen.map((x) => x.url.pathname)).toEqual(['/rest/v1/fin_mp_pending_classification']);
    expect(seen[0].url.searchParams.get('select')).not.toMatch(/balance|saldo|cbu|cvu/i);
    expect(TARGET_VIEWS).toEqual(expect.arrayContaining(['fin_mp_pending_classification', 'fin_mp_technical_review', 'fin_mp_report_day_status']));
  });
  it('technical exceptions come from their own view', async () => {
    const { client, seen } = recording([]);
    await listTechnicalReview(client);
    expect(seen.map((x) => x.url.pathname)).toEqual(['/rest/v1/fin_mp_technical_review']);
  });
  it('the card totals are what is left to classify, never a balance difference (15/10: 3 outflows, 222,654.96)', () => {
    expect(summarizePending([{ direction: 'OUT', amount: -131674.89 }, { direction: 'OUT', amount: -68043.27 }, { direction: 'OUT', amount: -22936.8 }]))
      .toEqual({ count: 3, outgoing: 222654.96, incoming: 0 });
    expect(summarizePending([{ direction: 'IN', amount: 100000 }])).toEqual({ count: 1, outgoing: 0, incoming: 100000 });
    expect(summarizePending([])).toEqual({ count: 0, outgoing: 0, incoming: 0 });
    expect(PENDING_BALANCE_NOTE).toBe('Estos movimientos ya están incluidos en el saldo. Falta definir su clasificación.');
  });
  it('recovery sends only the SOURCE_ID', async () => {
    const { client, seen } = recording({ outcome: 'POSTED', replayed: false });
    await postPendingOutflow(client, '184280177388');
    expect(seen.map((x) => [x.url.pathname, JSON.parse(x.body)])).toEqual([['/rest/v1/rpc/mp_post_pending_outflow', { p_source_id: '184280177388' }]]);
    expect(TARGET_RPCS).toContain('mp_post_pending_outflow');
  });
  it('the provisional and its release are never shown as a generic "Ajuste"', () => {
    expect(postingOperationLabel({ operation_type: 'ADJUSTMENT', external_ref: 'MP-PENDING:184280177388' })).toBe('Pendiente de clasificar');
    expect(postingOperationLabel({ operation_type: 'ADJUSTMENT', external_ref: 'MP-PENDING-RELEASE:184280177388' })).toBe('Clasificación de salida');
    expect(postingOperationLabel({ operation_type: 'ADJUSTMENT', external_ref: 'MP-OUTFLOW-TAX:1' })).toBe('ADJUSTMENT');
    expect(SRC('features/caja/CuentaDetalle.tsx')).toMatch(/\{postingOperationLabel\(p\)\}/);
  });
  it('period close and guard errors read clearly', () => {
    expect(errorMessage({ message: 'PENDING_CLASSIFICATION: 3 movimiento(s) pendiente(s) …' })).toBe('Hay movimientos pendientes de clasificar en este período. Clasificalos antes de cerrarlo.');
    expect(errorMessage({ message: 'MP_PENDING_NOT_RELEASED: movement 9 …' })).toMatch(/pendiente de clasificar/);
  });
});

describe('ADR-021 — activity and classification routes', () => {
  const MATCH = new Map<string, MpPayoutMatch>([
    ['184280177388', { source_id: '184280177388', match_status: 'NO_OWN_ACCOUNT_MATCH', matched_account_id: null, matched_account_name: null, confidence: 'NONE', suggested_action: 'CLASSIFY_OUTFLOW' }],
    ['900', { source_id: '900', match_status: 'OWN_ACCOUNT_EXACT', matched_account_id: 'bna', matched_account_name: 'BNA', confidence: 'HIGH', suggested_action: 'PROPOSE_INTERNAL_TRANSFER' }],
  ]);
  const ACT = [
    row({ source_id: '183240248717', description: 'payment', coverage_status: 'PENDING_CLASSIFICATION', net_amount: -131674.89, gross_amount: -130889.55 }),
    row({ source_id: '184280177388', description: 'payout', coverage_status: 'PENDING_CLASSIFICATION', net_amount: -68043.27, gross_amount: -67637.45 }),
    row({ source_id: '900', description: 'payout', coverage_status: 'PENDING_CLASSIFICATION', net_amount: -500, gross_amount: -500 }),
    row({ source_id: '183240248717', description: 'reserve_for_payment', coverage_status: 'RESERVE', net_amount: -131674.89 }),
  ];
  it('PENDING_CLASSIFICATION is labelled and explained; an outflow without provisional is a technical label', () => {
    expect(MP_STATUS_LABEL.PENDING_CLASSIFICATION).toBe('Pendiente de clasificar');
    expect(mpStatusLabel(ACT[0])).toBe('Pendiente de clasificar');
    expect(PENDING_ACTIVITY_NOTE).toBe('Ya incluido en el saldo · pendiente de clasificar');
    expect([MP_STATUS_LABEL.PAYOUT, MP_STATUS_LABEL.OUTBOUND]).toEqual(['Retiro sin registrar', 'Pago saliente sin registrar']);
  });
  it('a pending outbound payment is classifiable; a pending payout keeps its destination routes; reserves never', () => {
    expect(isClassifiableOutbound(ACT[0])).toBe(true);
    expect(isClassifiableOutbound(ACT[1])).toBe(false);
    expect(isClassifiableOutbound(ACT[3])).toBe(false);
    expect(mpOutflowCandidates(ACT, MATCH).map((c) => [c.sourceId, c.amount])).toEqual([['183240248717', 130889.55], ['184280177388', 67637.45]]);
    expect(mpOwnPayoutCandidates(ACT, MATCH, 'bna').map((c) => c.sourceId)).toEqual(['900']);
  });
  it('Caja: a "Pendientes de clasificar" tab and the Saldos card; the view uses the existing routes and keeps technical exceptions apart', () => {
    const app = SRC('features/caja/CajaApp.tsx');
    expect(app).toMatch(/\{ id: 'pendientes', label: 'Pendientes de clasificar' \}/);
    expect(app).toMatch(/<ResumenSaldos onVerPendientes=\{\(\) => setVista\('pendientes'\)\} \/>/);
    const v = SRC('features/caja/PendientesClasificar.tsx');
    expect(v).toMatch(/Pendientes de clasificar: \{s\.count\}/);
    expect(v).toMatch(/Todo clasificado/);
    expect(v).toMatch(/\{r\.kind === 'OUTBOUND' && <ClasificarSalida sourceId=\{r\.source_id\} \/>\}/);
    expect(v).toMatch(/\{r\.kind === 'PAYOUT' && <DestinoRetiro r=\{actividad\} matches=\{matches\} \/>\}/);
    expect(v).toMatch(/\{r\.kind === 'CLASSIFY_INFLOW' && <ClasificarIngreso paymentId=\{r\.source_id\} \/>\}/);
    expect(v).toMatch(/\{r\.kind === 'INFLOW' && <span className="text-xs text-\[#8A7A5C\]">\{HISTORICAL_INFLOW_ACTION\}<\/span>\}/);   // ADR-022 historical CVU / DEBIN: no action yet
    expect([PENDING_KIND_LABEL.INFLOW, HISTORICAL_INFLOW_ACTION]).toEqual(['Ingreso CVU / DEBIN (histórico)', 'Clasificación histórica: próxima etapa']);
    expect(v).toMatch(/aria-label="Revisión técnica"/);
    expect(v).not.toMatch(/report_mp_receipt_status|Cobros sin cliente/);   // receipts without a client are not pending classification
  });
});
