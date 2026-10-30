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
  DESTINATION_STATUS_LABEL, HISTORICAL_ACTION, INFLOW_SUBTYPE_LABEL, linkDates, listPendingPage, listTechnicalReview, listUnlinkedPage, mandatoryPending,
  maskedAccount, PENDING_BALANCE_NOTE, PENDING_KIND_LABEL, postingOperationLabel, postPendingOutflow, readPendingSummary, searchClause,
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
/** a recording client that also answers the exact count (content-range), as PostgREST does for count=exact */
const counted = (body: unknown[], total: number) => {
  const seen: { url: URL; headers: Headers }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(0, body.length - 1)}/${total}` } });
  }) as typeof fetch } });
  return { client, seen };
};
const row = (p: Partial<MpActivityRow>): MpActivityRow => ({
  run_id: 'r', row_number: 1, occurred_at: null, business_date: '2026-10-15', description: 'payment', source_id: null, net_amount: null, gross_amount: null,
  payment_method: null, payment_method_type: null, coverage_status: 'COVERED', financial_operation_id: null, ...p,
});

describe('ADR-021 — pending classification data', () => {
  it('mandatory pendings: one page per scope from fin_mp_pending_classification, server count, deterministic order; no balance column', async () => {
    const { client, seen } = counted([{ pending_key: 'OUT:184280177388', source_id: '184280177388', kind: 'PAYOUT', direction: 'OUT', business_date: '2026-10-15',
      occurred_at: null, amount: '-68043.27', economic_amount: '67637.45', charges_amount: '-405.82', account_name: 'Mercado Pago', description: 'payout',
      status: 'PENDING', already_posted: true, financial_operation_id: '7', is_historical: false, destination_status: null, destination_last4: null, matched_account_name: null }], 1203);
    const r = await listPendingPage(client, 'current', 2);
    expect([r.rows[0].amount, r.rows[0].financial_operation_id, r.total, r.page]).toEqual([-68043.27, 7, 1203, 2]);
    expect(seen.map((x) => x.url.pathname)).toEqual(['/rest/v1/fin_mp_pending_classification']);
    const q = seen[0].url.searchParams;
    expect([q.get('is_historical'), q.get('order'), q.get('offset'), q.get('limit')]).toEqual(['eq.false', 'business_date.asc,source_id.asc', '100', '50']);
    expect(seen[0].headers.get('prefer')).toMatch(/count=exact/);
    expect(q.get('select')).not.toMatch(/balance|saldo|cbu|cvu|raw_row/i);
    await listPendingPage(client, 'historical', 0);
    expect(seen[1].url.searchParams.get('is_historical')).toBe('eq.true');
    expect(TARGET_VIEWS).toEqual(expect.arrayContaining(['fin_mp_pending_classification', 'fin_mp_technical_review', 'fin_mp_report_day_status', 'fin_mp_unlinked_inflows', 'fin_mp_pending_summary']));
  });
  it('technical exceptions come from their own view', async () => {
    const { client, seen } = recording([]);
    await listTechnicalReview(client);
    expect(seen.map((x) => x.url.pathname)).toEqual(['/rest/v1/fin_mp_technical_review']);
  });
  it('the card reads the server summary (never the rows): mandatory outflows only, current + historical; unlinked inflows apart', async () => {
    const { client, seen } = recording([{ bucket: 'PENDING_CURRENT', item_count: 3, amount: '-222654.96' }, { bucket: 'PENDING_HISTORICAL', item_count: 192, amount: '-85290319.52' },
      { bucket: 'UNLINKED_CURRENT', item_count: 102, amount: '1000.00' }, { bucket: 'UNLINKED_HISTORICAL', item_count: 4589, amount: '87110315.50' }]);
    const s = await readPendingSummary(client);
    expect(seen.map((x) => x.url.pathname)).toEqual(['/rest/v1/fin_mp_pending_summary']);
    expect(mandatoryPending(s)).toEqual({ count: 195, outgoing: 85512974.48, current: 3, historical: 192 });
    expect(s.UNLINKED_HISTORICAL).toEqual({ count: 4589, amount: 87110315.5 });
    expect(PENDING_BALANCE_NOTE).toBe('Estos movimientos ya están incluidos en el saldo. Falta definir su clasificación.');
  });
  it('unlinked inflows: server-side filters, newest first, paginated; the search is a SOURCE_ID or a sanitized description', async () => {
    const { client, seen } = counted([], 4691);
    const r = await listUnlinkedPage(client, { scope: 'historical', from: '2026-02-01', to: '2026-02-28', min: 100, max: 7500, search: '1846' }, 1);
    expect(r.total).toBe(4691);
    const q = seen[0].url.searchParams;
    expect(seen[0].url.pathname).toBe('/rest/v1/fin_mp_unlinked_inflows');
    expect([q.get('is_historical'), q.getAll('business_date'), q.getAll('remaining_amount'), q.get('or'), q.get('order'), q.get('offset')])
      .toEqual(['eq.true', ['gte.2026-02-01', 'lte.2026-02-28'], ['gte.100', 'lte.7500'], '(source_id.like.*1846*)', 'business_date.desc,movement_id.desc', '50']);
    expect(q.get('select')).not.toMatch(/raw_row|cbu|cvu|event_data/i);
    expect([searchClause('Juan Pérez'), searchClause('a),or(x.eq.1'), searchClause('  '), searchClause(')(')]).toEqual(['description.ilike.*Juan Pérez*', 'description.ilike.*aorx.eq.1*', null, null]);
  });
  it('labels: destination status, inflow subtype, masked account (last 4 only), the two dates of a link', () => {
    expect(DESTINATION_STATUS_LABEL).toEqual({ OWN_ACCOUNT_TRANSFER_CANDIDATE: 'Posible transferencia a cuenta propia', THIRD_PARTY: 'Destino de terceros', UNKNOWN_DESTINATION: 'Destino desconocido' });
    expect(INFLOW_SUBTYPE_LABEL).toEqual({ CVU: 'Transferencia (CVU)', DEBIN: 'DEBIN', RECEIPT: 'Cobro' });
    expect([maskedAccount('0002'), maskedAccount(null), maskedAccount('2850590940090418135201')]).toEqual(['****0002', null, null]);
    expect(linkDates({ source_date: '2026-02-12', effective_date: '2026-10-16' })).toEqual({ recibido: '2026-02-12', vinculado: '2026-10-16' });
    expect(PENDING_KIND_LABEL).toEqual({ PAYOUT: 'Retiro', OUTBOUND: 'Pago saliente' });
    expect(HISTORICAL_ACTION).toBe('Clasificación histórica pendiente (próxima etapa)');
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
  it('Caja: Pendientes (mandatory, current / historical apart, paginated, with their server totals), Entradas sin vincular (optional); no card on Saldos (Lote 3C)', () => {
    const app = SRC('features/caja/CajaApp.tsx');
    expect(app).toMatch(/\{ id: 'pendientes', label: 'Pendientes de clasificar' \}/);
    expect(app).toMatch(/\{ id: 'entradas', label: 'Entradas sin vincular' \}/);
    expect(app).toMatch(/\{vista === 'saldos' && <ResumenSaldos \/>\}/);
    expect(SRC('features/caja/ResumenSaldos.tsx')).not.toMatch(/TarjetaPendientes|usePendingSummary|from '\.\/PendientesClasificar'/);
    const v = SRC('features/caja/PendientesClasificar.tsx');
    expect(v).toMatch(/total=\{resumen\.data\?\.PENDING_CURRENT\}/);
    expect(v).toMatch(/total=\{resumen\.data\?\.PENDING_HISTORICAL\}/);
    expect(v).toMatch(/Todo clasificado/);
    expect(v).toMatch(/<ListaPendientes scope="current"/);
    expect(v).toMatch(/<ListaPendientes scope="historical"/);
    expect(v).toMatch(/\{r\.is_historical \? <span className="text-xs text-\[#8A7A5C\]">\{HISTORICAL_ACTION\}<\/span> : \(/);   // no unsupported action on history
    // ADR-025 stage 3: the same route, with the WhatsApp concept (when there is one) pre-filled
    expect(v).toMatch(/\{r\.kind === 'OUTBOUND' && <ClasificarSalida sourceId=\{r\.source_id\}( conceptoInicial=\{nota\?\.concept\})? \/>\}/);
    expect(v).toMatch(/\{r\.kind === 'PAYOUT' && <DestinoRetiro r=\{actividad\} matches=\{matches\} \/>\}/);
    expect(v).not.toMatch(/CLASSIFY_INFLOW|ClasificarIngreso|summarizePending/);   // inflows are never a mandatory classification (ADR-023)
    expect(v).toMatch(/aria-label="Revisión técnica"/);
    const e = SRC('features/caja/EntradasSinVincular.tsx');
    expect(e).toMatch(/Vincular a cliente/);
    expect(e).toMatch(/Movimiento recibido: /);
    expect(e).toMatch(/Vinculado al cliente: /);
    expect(e).not.toMatch(/raw_row|destination_value|PAYOUT_BANK_ACCOUNT_NUMBER/);
  });
});
