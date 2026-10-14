/**
 * ADR-018 §15 — Caja → Saldos → Mercado Pago → "Actividad Mercado Pago". The real supabase-js client is used with a
 * recording fetch, so the assertions are on the actual requests. The activity reads only the view fin_mp_report_activity
 * (0079), is read-only and never touches financial_posting / the ERP balance; the tab exists only for the MP account.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { TARGET_VIEWS } from '../../src/target/db';
import { isMercadoPagoAccount, isVisibleActivity, listMpActivity, MP_STATUS_LABEL, mpActivityType, type MpCoverageStatus } from '../../src/target/mpActivity';

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
  it('read-only: no RPC, no write, no reconciliation action', () => {
    const fn = detalle.slice(detalle.indexOf('function ActividadMercadoPago'));
    expect(fn).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|useMutation|onClick/);
    expect(SRC('target/mpActivity.ts')).not.toMatch(/callRpc|\.rpc\(|\.insert\(|\.update\(|\.delete\(/);
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
