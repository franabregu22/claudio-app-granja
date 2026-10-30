/** Lote 4 (0111) — WhatsApp expenses paid with Mercado Pago, linked later from the ERP; Factura A receiver / issuer CUIT pending. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { TARGET_RPCS } from '../../src/target/db';
import { messageFor } from '../../src/target/messages';
import { linkWaMpExpense, listWaMpLinkPending } from '../../src/target/waMpLink';

const ROOT = resolve(__dirname, '../..');
const MIGRATION = readFileSync(resolve(ROOT, 'supabase/target-migrations/0111_wa_invoice_receiver_mp_link.sql'), 'utf8');
function fetchStub(body: unknown) {
  const seen: { url: URL; body: string | null }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), body: (init?.body as string) ?? null });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}

describe('Lote 4 — backend contract', () => {
  it('the pending list and the link are allow-listed RPCs; numbers as served; the link sends exactly its arguments', async () => {
    expect(TARGET_RPCS).toEqual(expect.arrayContaining(['wa_mp_link_pending', 'wa_link_mp_expense']));
    const a = fetchStub([{ draft_id: 'd', short_code: 'W-0012', concept: 'Gasoil', total: '500.00', expense_date: '2026-10-22', category_name: 'Combustible',
      account_name: 'Mercado Pago', confirmed_at: '2026-10-22T12:00:00Z', document_file_id: null, candidates: [{ source_id: 930011100101, date: '2026-10-20', amount: '500.00' }] }]);
    const [r] = await listWaMpLinkPending(a.client);
    expect([r.total, r.candidates[0].source_id, r.candidates[0].amount]).toEqual([500, '930011100101', 500]);
    expect(a.seen[0].url.pathname).toBe('/rest/v1/rpc/wa_mp_link_pending');
    const b = fetchStub({ replayed: false });
    await linkWaMpExpense(b.client, { draftId: 'd', sourceId: '930011100101', reason: '  manual ' });
    expect(b.seen[0].url.pathname).toBe('/rest/v1/rpc/wa_link_mp_expense');
    expect(JSON.parse(b.seen[0].body!)).toEqual({ p_draft_id: 'd', p_source_id: '930011100101', p_reason: 'manual' });
  });
  it('every error code raised by the ERP link has a message', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('CREATE FUNCTION public.wa_link_mp_expense'));
    const codes = [...fn.matchAll(/RAISE EXCEPTION '([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]).filter((c) => c !== 'FORBIDDEN');
    expect(codes.length).toBeGreaterThan(5);
    for (const c of new Set(codes)) expect(messageFor(new Error(`${c}: x`)), c).toBeTruthy();
  });
  it('the migration keeps the financial routes: a Mercado Pago expense is recorded only through wa.dispatch with its real outflow', () => {
    expect(MIGRATION).not.toMatch(/INSERT INTO (financial_operation|financial_posting|purchases|fiscal_document)\b/);
    expect(MIGRATION).toMatch(/d\.payload := d\.payload \|\| jsonb_build_object\('mp_source_id', p_source_id, 'date', v\.business_date\);\s+v_res := wa\.dispatch\(d, c\.idempotency_key\);/);
    expect(MIGRATION).toMatch(/RETURN jsonb_build_object\('mp_link_pending', true, 'financial_effect', 'NONE'/);
    expect(MIGRATION).toMatch(/WA_RECEIVER_REQUIRED/);
    expect(MIGRATION).toMatch(/WA_ISSUER_CUIT_REQUIRED/);
  });
});

describe('Lote 4 — screen', () => {
  it('Pendientes de clasificar lists the WhatsApp expenses to link; the movement is chosen by the user, never automatically', () => {
    const v = readFileSync(resolve(ROOT, 'src/features/caja/PendientesClasificar.tsx'), 'utf8');
    expect(v).toMatch(/<GastosWhatsappMp \/>/);
    expect(v).toMatch(/useWaMpLinkPending\(\)/);
    expect(v).toMatch(/disabled=\{!origen \|\| vincular\.isPending\}/);
    expect(v).toMatch(/Se registra con la fecha del movimiento/);
  });
});
