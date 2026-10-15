/**
 * ADR-018 §15 — Caja → Saldos → Mercado Pago → "Actividad Mercado Pago". The real supabase-js client is used with a
 * recording fetch, so the assertions are on the actual requests. The activity reads only the view fin_mp_report_activity
 * (0079), is read-only and never touches financial_posting / the ERP balance; the tab exists only for the MP account.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { TARGET_RPCS, TARGET_VIEWS } from '../../src/target/db';
import { isMercadoPagoAccount, isVisibleActivity, listMpActivity, listMpPayoutMatches, MP_STATUS_LABEL, mpActivityType, type MpCoverageStatus, type MpPayoutMatch, payoutMatchLabel } from '../../src/target/mpActivity';

function harness(rows: unknown[]) {
  const seen: URL[] = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    seen.push(url);
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: createClient('http://127.0.0.1:54321', 'anon-key', { global: { fetch: fetchImpl as typeof fetch }, auth: { persistSession: false } }), seen };
}
const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const STATUSES: MpCoverageStatus[] = ['CONTROL', 'PRE_CUTOVER', 'RESERVE', 'COVERED', 'BACKFILL_PROCESSED', 'BACKFILL_PENDING', 'EXCEPTION', 'YIELD', 'PAYOUT', 'OUTBOUND'];

describe('ADR-018 MP activity — data', () => {
  it('reads only fin_mp_report_activity for the account, newest first; numeric amounts', async () => {
    const { client, seen } = harness([{ run_id: 'r', row_number: 2, occurred_at: '2026-10-04T23:36:11+00:00', business_date: '2026-10-04', description: 'payment',
      source_id: '181403811707', net_amount: '49.70', gross_amount: '50.00', payment_method: 'available_money', payment_method_type: 'account_money',
      coverage_status: 'BACKFILL_PROCESSED', financial_operation_id: '41' }]);
    const rows = await listMpActivity(client, 'mp-acc');
    expect(seen.map((u) => u.pathname)).toEqual(['/rest/v1/fin_mp_report_activity']);
    const q = seen[0].searchParams;
    expect([q.get('financial_account_id'), q.get('limit')]).toEqual(['eq.mp-acc', '1000']);
    expect(q.get('order')).toBe('business_date.desc,occurred_at.desc.nullslast,row_number.desc');
    expect(rows[0]).toMatchObject({ net_amount: 49.7, gross_amount: 50, financial_operation_id: 41, coverage_status: 'BACKFILL_PROCESSED' });
    expect(TARGET_VIEWS).toContain('fin_mp_report_activity');
  });
  it('no account → no request', async () => {
    const { client, seen } = harness([]);
    expect(await listMpActivity(client, '')).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe('ADR-018 MP activity — labels', () => {
  it('every coverage status has a readable label', () => {
    expect(STATUSES.map((s) => MP_STATUS_LABEL[s])).toEqual(['Control del reporte', 'Anterior al corte', 'Reserva interna', 'Cubierto',
      'Recuperado del reporte', 'Recuperación pendiente', 'Excepción', 'Rendimiento', 'Retiro', 'Pago saliente (sin efecto)']);
  });
  it('type from DESCRIPTION and sign (no classification by payment method)', () => {
    expect(mpActivityType({ description: 'payment', net_amount: 49.7 })).toBe('Cobro');
    expect(mpActivityType({ description: 'payment', net_amount: -500 })).toBe('Pago');
    expect(mpActivityType({ description: 'asset_management', net_amount: 12.34 })).toBe('Rendimiento');
    expect(mpActivityType({ description: 'payout', net_amount: -200 })).toBe('Retiro');
    expect(mpActivityType({ description: 'reserve_for_payout', net_amount: -200 })).toBe('Reserva');
    expect(mpActivityType({ description: null, net_amount: null })).toBe('Control');
    expect(SRC('target/mpActivity.ts')).not.toMatch(/cvu/i);
  });
  it('the MP account is identified exactly as the database functions do', () => {
    expect(isMercadoPagoAccount({ nombre: 'Mercado Pago', account_type: 'EXTERNAL_SERVICE' })).toBe(true);
    expect(isMercadoPagoAccount({ nombre: 'Mercado Pago', account_type: 'BANK_ACCOUNT' })).toBe(false);
    expect(isMercadoPagoAccount({ nombre: 'BNA', account_type: 'BANK_ACCOUNT' })).toBe(false);
  });
});

describe('ADR-018 MP activity — screen', () => {
  const detalle = SRC('features/caja/CuentaDetalle.tsx');
  it('Caja → Saldos → Mercado Pago: "Actividad Mercado Pago" tab, separate from "Movimientos ERP", MP account only', () => {
    expect(detalle).toMatch(/const esMp = isMercadoPagoAccount\(cuenta\)/);
    expect(detalle).toMatch(/\.\.\.\(esMp \? \[\['mp', 'Actividad Mercado Pago'\]\] : \[\]\)/);
    expect(detalle).toMatch(/\['erp', 'Movimientos ERP'\]/);
    expect(detalle).toMatch(/aria-label="Actividad Mercado Pago"/);
  });
  it('shows date, type, reference, amount and coverage status; internal rows omitted; states that it does not change the ERP balance', () => {
    const fn = detalle.slice(detalle.indexOf('function ActividadMercadoPago'));
    for (const th of ['Fecha', 'Tipo', 'Referencia', 'Importe', 'Estado']) expect(fn).toContain(`>${th}</th>`);
    expect(fn).toMatch(/todas\.filter\(isVisibleActivity\)/);
    expect(fn).toMatch(/no modifica el saldo ERP/);
    expect(fn).toMatch(/MP_STATUS_LABEL\[r\.coverage_status\]/);
  });
  it('read-only: no write, no reconciliation action; the only RPC is the read-only payout match proposal (0084)', () => {
    const fn = detalle.slice(detalle.indexOf('function ActividadMercadoPago'));
    expect(fn).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|useMutation|onClick/);
    const lib = SRC('target/mpActivity.ts');
    expect(lib).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|\.delete\(/);
    expect((lib.match(/callRpc<[^;]*/g) ?? []).map((c) => c.includes("'fin_mp_payout_matches'"))).toEqual([true]);
  });
});

describe('ADR-018 MP activity — internal report rows hidden', () => {
  const row = (coverage_status: MpCoverageStatus, description: string | null, net: number | null) =>
    ({ coverage_status, description, net_amount: net });
  it('CONTROL and RESERVE are hidden; payment, yield, payout, outbound and every coverage state stay visible', () => {
    expect(isVisibleActivity(row('CONTROL', null, null))).toBe(false);
    expect(isVisibleActivity(row('RESERVE', 'reserve_for_payout', 759702.86))).toBe(false);
    for (const s of ['PRE_CUTOVER', 'COVERED', 'BACKFILL_PROCESSED', 'BACKFILL_PENDING', 'EXCEPTION', 'YIELD', 'PAYOUT', 'OUTBOUND'] as MpCoverageStatus[]) {
      expect(isVisibleActivity(row(s, 'payment', 1))).toBe(true);
    }
  });
  it('real case SOURCE_ID 183984533002: Retiro −759.702,86 plus its two reserve rows → only the Retiro is listed', () => {
    const rows = [
      { ...row('RESERVE', 'reserve_for_payout', 759702.86), source_id: '183984533002' },
      { ...row('RESERVE', 'reserve_for_payout', -759702.86), source_id: '183984533002' },
      { ...row('PAYOUT', 'payout', -759702.86), source_id: '183984533002' },
      { ...row('CONTROL', null, null), source_id: null },
    ];
    const listed = rows.filter(isVisibleActivity);
    expect(listed.map((r) => [mpActivityType(r), r.net_amount])).toEqual([['Retiro', -759702.86]]);
  });
  it('payment (Cobro / Pago), yield and payout types are unchanged', () => {
    expect([mpActivityType(row('BACKFILL_PROCESSED', 'payment', 49.7)), mpActivityType(row('OUTBOUND', 'payment', -37322.6)),
      mpActivityType(row('YIELD', 'asset_management', 3389.55)), mpActivityType(row('PAYOUT', 'payout', -759702.86))]).toEqual(['Cobro', 'Pago', 'Rendimiento', 'Retiro']);
  });
});

// ── ADR-018 (0084): payout destination vs own accounts — read-only proposal ────────────────────────────────────────────
const BNA_ID = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const PAT_ID = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const MATCHES: MpPayoutMatch[] = [
  { source_id: '181533509871', match_status: 'OWN_ACCOUNT_EXACT', matched_account_id: BNA_ID, matched_account_name: 'BNA', confidence: 'HIGH', suggested_action: 'PROPOSE_INTERNAL_TRANSFER' },
  { source_id: '183527567414', match_status: 'OWN_ACCOUNT_EXACT', matched_account_id: BNA_ID, matched_account_name: 'BNA', confidence: 'HIGH', suggested_action: 'PROPOSE_INTERNAL_TRANSFER' },
  { source_id: '183984533002', match_status: 'NO_OWN_ACCOUNT_MATCH', matched_account_id: null, matched_account_name: null, confidence: 'NONE', suggested_action: 'CLASSIFY_OUTFLOW' },
  { source_id: '900000000077', match_status: 'OWN_ACCOUNT_EXACT', matched_account_id: PAT_ID, matched_account_name: 'Patagonia', confidence: 'HIGH', suggested_action: 'PROPOSE_INTERNAL_TRANSFER' },
  { source_id: '900000000078', match_status: 'DESTINATION_CONFLICT', matched_account_id: null, matched_account_name: null, confidence: 'REVIEW', suggested_action: 'REVIEW_DESTINATION' },
];
const payout = (source_id: string) => ({ description: 'payout', source_id });

describe('ADR-018 MP activity — payout own-account match (0084, read-only)', () => {
  it('calls only the ADMIN RPC fin_mp_payout_matches with the account id; keyed by SOURCE_ID', async () => {
    const seen: { url: URL; body: string }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      seen.push({ url, body: String(init?.body ?? '') });
      return new Response(JSON.stringify(MATCHES), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = createClient('http://127.0.0.1:54321', 'anon-key', { global: { fetch: fetchImpl as typeof fetch }, auth: { persistSession: false } });
    const m = await listMpPayoutMatches(client, 'mp-acc');
    expect(seen.map((s) => s.url.pathname)).toEqual(['/rest/v1/rpc/fin_mp_payout_matches']);
    expect(JSON.parse(seen[0].body)).toEqual({ p_account_id: 'mp-acc' });
    expect([...m.keys()]).toEqual(['181533509871', '183527567414', '183984533002', '900000000077', '900000000078']);
    expect(TARGET_RPCS).toContain('fin_mp_payout_matches');
    expect(await listMpPayoutMatches(client, '')).toEqual(new Map());
  });
  const map = new Map(MATCHES.map((x) => [x.source_id, x]));
  it('05/10 and 10/10 → "Transferencia a BNA detectada" (exact destination match)', () => {
    for (const sid of ['181533509871', '183527567414']) {
      expect(payoutMatchLabel(payout(sid), map)).toEqual({ title: 'Transferencia a BNA detectada', detail: 'Coincidencia exacta de cuenta destino', tone: 'own' });
    }
  });
  it('13/10 → "Clasificar salida" (no own account; no supplier inferred)', () => {
    expect(payoutMatchLabel(payout('183984533002'), map)).toEqual({ title: 'Clasificar salida', detail: null, tone: 'classify' });
  });
  it('Patagonia fixture → "Transferencia a Patagonia detectada"; conflicting destinations → "Revisar destino"', () => {
    expect(payoutMatchLabel(payout('900000000077'), map)?.title).toBe('Transferencia a Patagonia detectada');
    expect(payoutMatchLabel(payout('900000000078'), map)?.title).toBe('Revisar destino');
  });
  it('unknown / no destination, and non-payout rows → nothing shown (the rest of the list is unchanged)', () => {
    expect(payoutMatchLabel(payout('999999999999'), map)).toBeNull();
    expect(payoutMatchLabel({ description: 'payment', source_id: '181533509871' }, map)).toBeNull();
    expect(payoutMatchLabel({ description: 'asset_management', source_id: '183984533002' }, map)).toBeNull();
    expect(payoutMatchLabel({ description: 'payout', source_id: null }, map)).toBeNull();
  });
  it('the screen shows the proposal under the Retiro status, with no action button and no identifier value', () => {
    const s = SRC('features/caja/CuentaDetalle.tsx');
    expect(s).toMatch(/<DestinoRetiro r=\{r\} matches=\{matches\} \/>/);
    const comp = s.slice(s.indexOf('function DestinoRetiro'));
    expect(comp).not.toMatch(/<button|onClick/);
    const all = SRC('target/mpActivity.ts') + s;
    expect(all).not.toMatch(/normalized_value|identifier_value|original_value|expected_cbu|PAYOUT_BANK_ACCOUNT_NUMBER/);
    expect(JSON.stringify(MATCHES)).not.toMatch(/\d{22}/);
  });
});
