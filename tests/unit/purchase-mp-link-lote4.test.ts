/** Lote 4 (0111, opción A) — a purchase paid with Mercado Pago: P&L + IVA at confirmation, the movement linked later (ADR-021 §2.3(c)). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { TARGET_RPCS, TARGET_VIEWS } from '../../src/target/db';
import { messageFor } from '../../src/target/messages';
import { listPurchaseMpLinks, type PurchaseMpLinkRow, samePendingAmount, settlePurchaseMp } from '../../src/target/purchaseMpLink';

const ROOT = resolve(__dirname, '../..');
const SRC = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');
const MIGRATION = SRC('supabase/target-migrations/0111_wa_invoice_receiver_mp_link.sql');
function fetchStub(body: unknown) {
  const seen: { url: URL; body: string | null }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), body: (init?.body as string) ?? null });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}
const row = (o: Partial<PurchaseMpLinkRow>): PurchaseMpLinkRow => ({ purchase_root_id: 'r', purchase_id: 'p', economic_date: '2026-09-28', amount_total: 500, concept: 'Gasoil',
  counterparty_name: null, category_name: 'Combustible', fiscal_document_id: 'f', origin: 'WHATSAPP', origin_code: 'W-0012', created_at: '', status: 'PENDIENTE_VINCULACION_MP',
  source_id: null, movement_date: null, linked_at: null, age_days: 2, candidates: [], ...o });

describe('Lote 4 — backend contract', () => {
  it('the state is read from fin_purchase_mp_link; the link is settle_purchase_mp with exactly its arguments', async () => {
    expect(TARGET_VIEWS).toContain('fin_purchase_mp_link');
    expect(TARGET_RPCS).toContain('settle_purchase_mp');
    const a = fetchStub([{ ...row({}), amount_total: '500.00', age_days: '2', candidates: [{ source_id: 930011100101, date: '2026-10-20', amount: '500.00' }] }]);
    const [r] = await listPurchaseMpLinks(a.client);
    expect([r.amount_total, r.age_days, r.candidates?.[0].source_id, r.candidates?.[0].amount]).toEqual([500, 2, '930011100101', 500]);
    expect(a.seen[0].url.pathname).toBe('/rest/v1/fin_purchase_mp_link');
    const b = fetchStub({ replayed: false });
    await settlePurchaseMp(b.client, { purchaseId: 'p', sourceId: '930011100101', idempotencyKey: 'K1', reason: ' manual ' });
    expect(b.seen[0].url.pathname).toBe('/rest/v1/rpc/settle_purchase_mp');
    expect(JSON.parse(b.seen[0].body!)).toEqual({ p_purchase_id: 'p', p_source_id: '930011100101', p_idempotency_key: 'K1', p_reason: 'manual' });
  });
  it('the duplicate warning compares the outflow comparable gross with the PENDING purchases only', () => {
    const rows = [row({ purchase_root_id: 'a' }), row({ purchase_root_id: 'b', amount_total: 400 }), row({ purchase_root_id: 'c', status: 'VINCULADO' })];
    expect(samePendingAmount(rows, 500).map((r) => r.purchase_root_id)).toEqual(['a']);
  });
  it('every error code raised by the link has a message', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('CREATE FUNCTION settle_purchase_mp'), MIGRATION.indexOf('CREATE VIEW fin_purchase_mp_link'));
    const codes = [...fn.matchAll(/RAISE EXCEPTION '([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]).filter((c) => c !== 'FORBIDDEN');
    expect(codes.length).toBeGreaterThan(8);
    for (const c of new Set(codes)) expect(messageFor(new Error(`${c}: x`)), c).toBeTruthy();
  });
  it('the link writes only the payment side: no purchase, no fiscal document; route PURCHASE_MP_LINK; the purchase is never rewritten', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('CREATE FUNCTION settle_purchase_mp'), MIGRATION.indexOf('CREATE VIEW fin_purchase_mp_link'));
    expect(fn).not.toMatch(/INSERT INTO (purchases|fiscal_document)\b|fiscal_document_insert|UPDATE purchases/);
    expect(fn).toMatch(/mp_pending_outflow_release\(v_out\.movement_id, v_uid, 'PURCHASE_MP_LINK'\)/);
    expect(fn).toMatch(/assert_period_open\(v_out\.occurred_date\)/);
    expect(fn).toMatch(/IF v_cur\.amount_total <> -v_out\.gross_amount THEN/);
    const reg = MIGRATION.slice(MIGRATION.indexOf('CREATE FUNCTION register_casual_purchase_mp_pending'), MIGRATION.indexOf('CREATE FUNCTION settle_purchase_mp'));
    expect(reg).not.toMatch(/INSERT INTO (financial_operation|financial_posting|expense_payable)\b/);
  });
});

describe('Lote 4 — screens', () => {
  it('Pendientes de clasificar: the recorded MP purchases to link, the movement chosen by the user (one key per opened row)', () => {
    const v = SRC('src/features/caja/PendientesClasificar.tsx');
    expect(v).toMatch(/<GastosMpPendientes \/>/);
    expect(v).toMatch(/useState\(\(\) => `PURCHASE-MP-\$\{crypto\.randomUUID\(\)\}`\)/);
    expect(v).toMatch(/disabled=\{!origen \|\| vincular\.isPending\}/);
    expect(v).toMatch(/gastosMpPendientes=\{posibles\}/);
  });
  it('classifying an outflow as a NEW purchase while a recorded MP purchase has that amount needs an explicit confirmation (warn, never block)', () => {
    const c = SRC('src/features/caja/CuentaDetalle.tsx');
    expect(c).toMatch(/Posible duplicado/);
    expect(c).toMatch(/&& \(!posibleDuplicado \|\| esOtroGasto\)/);
    expect(c).toMatch(/Confirmo que es un gasto distinto/);
  });
});
