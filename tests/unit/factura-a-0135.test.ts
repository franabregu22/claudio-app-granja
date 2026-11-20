/** 0135 — Factura A on orders (owner 2026-11-20: net price + IVA 21 % apart) and the Mercado Pago débitos y créditos tax. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { clientCuit, createPendingOrder, orderIva, orderNet, orderTotal, setSaleInvoiceNumber, updatePendingOrder } from '../../src/target/commercial';
import { TARGET_RPCS } from '../../src/target/db';
import { messageFor } from '../../src/target/messages';

const ROOT = resolve(__dirname, '../..');
const SRC = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');
const MIGRATION = SRC('supabase/target-migrations/0135_factura_a_y_debcred_mp.sql');
function recording(body: unknown = [{ id: 'p1' }]) {
  const seen: { url: URL; method: string; body: string | null }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), method: init?.method ?? 'GET', body: (init?.body as string) ?? null });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}
const linea = (cantidad: number, precio: number) => ({ id: 'l', pedido_id: 'p', producto_id: 'x', producto_nombre: 'Caja', cantidad, precio_unitario: precio, subtotal: cantidad * precio, version_seq: 0, is_current: true });

describe('0135 — Factura A: the figures', () => {
  it('3 boxes at 36.000 + IVA: net 108.000, IVA 22.680, the client owes 130.680', () => {
    const p = { lineas: [linea(3, 36000)], factura_a: true };
    expect([orderNet(p), orderIva(p), orderTotal(p)]).toEqual([108000, 22680, 130680]);
  });
  it('without Factura A the total is the net (no IVA)', () => {
    const p = { lineas: [linea(3, 36000)], factura_a: false };
    expect([orderIva(p), orderTotal(p)]).toEqual([0, 108000]);
  });
  it('the IVA is rounded to cents as deliver_order books it', () => {
    expect(orderIva({ lineas: [linea(1, 1234.57)], factura_a: true })).toBe(259.26);
    expect(MIGRATION).toMatch(/v_iva := round\(v_net \* 0\.21, 2\);/);
  });
  it('the CUIT is 11 digits from any format (the same rule as client_cuit)', () => {
    expect([clientCuit('20-12345678-9'), clientCuit('30719089891'), clientCuit('12345678'), clientCuit(null)]).toEqual(['20123456789', '30719089891', null, null]);
    expect(MIGRATION).toMatch(/WHEN length\(d\) = 11 THEN d END FROM \(SELECT regexp_replace\(coalesce\(p_fiscal_id, ''\), '\[\^0-9\]', '', 'g'\) AS d\)/);
  });
});

describe('0135 — Factura A: the writes', () => {
  it('a new / edited pending order carries factura_a (false by default)', async () => {
    const { client, seen } = recording();
    await createPendingOrder(client, { clienteId: 'c1', lines: [{ producto_id: 'x', producto_nombre: 'Caja', cantidad: 3, precio_unitario: 36000 }], userId: 'u', facturaA: true });
    expect(JSON.parse(seen[0].body ?? '{}')).toMatchObject({ cliente_id: 'c1', estado: 'PENDING', factura_a: true });
    const r2 = recording();
    await updatePendingOrder(r2.client, { orderId: 'p1', clienteId: 'c1', lines: [{ producto_id: 'x', producto_nombre: 'Caja', cantidad: 1, precio_unitario: 1 }], previousLineIds: [], userId: 'u' });
    expect(JSON.parse(r2.seen[0].body ?? '{}')).toMatchObject({ factura_a: false });
  });
  it('the invoice number goes through set_sale_invoice_number (ADMIN, audited)', async () => {
    const { client, seen } = recording({ fiscal_document_id: 'd', number: '00003-00000123', changed: true });
    await setSaleInvoiceNumber(client, 'p1', '00003-00000123');
    expect(seen[0].url.pathname).toBe('/rest/v1/rpc/set_sale_invoice_number');
    expect(JSON.parse(seen[0].body ?? '{}')).toEqual({ p_order_id: 'p1', p_number: '00003-00000123' });
    expect(TARGET_RPCS).toContain('set_sale_invoice_number');
  });
  it('the database errors read in Spanish', () => {
    for (const code of ['CLIENT_CUIT_REQUIRED', 'INVOICE_A_NOT_FOR_RETAIL', 'SALE_INVOICE_NOT_FOUND', 'DUPLICATE_INVOICE_NUMBER', 'INVALID_INVOICE_NUMBER']) {
      expect(messageFor(code), code).not.toBe(code);
    }
  });
});

describe('0135 — Factura A: the screens', () => {
  const form = SRC('src/features/pedidos/FormPedido.tsx');
  const app = SRC('src/features/pedidos/PedidosApp.tsx');
  it('the order form: «Factura A» checkbox, prices without IVA, net / IVA 21 % / total; no CUIT → cannot save', () => {
    expect(form).toMatch(/<span className="block font-semibold text-\[#2C2419\]">Factura A<\/span>/);
    expect(form).toMatch(/Los precios se cargan sin IVA; al total se le suma el IVA 21 %\./);
    expect(form).toMatch(/const sinCuit = facturaA && clienteId !== '' && clientCuit\(cliente\?\.fiscal_id\) === null;/);
    expect(form).toMatch(/&& !sinCuit && !mutation\.isPending;/);
    expect(form).toMatch(/<span>IVA 21 %<\/span>/);
    expect(form).toMatch(/disabled=\{mutation\.isPending \|\| modo === 'rectificar'\}/);   // a delivered order keeps it
  });
  it('the order lists: the Factura A chip and, once delivered, its number typed in place', () => {
    expect(app.split('<FacturaA p={p} />').length - 1).toBe(4);
    expect(app).toMatch(/m\.invoiceNumber\.mutate\(\{ orderId: p\.id, number: numero\.trim\(\) \|\| null \}/);
  });
});

describe('0135 — the Mercado Pago débitos y créditos tax', () => {
  it('an inflow tax of exactly 0.6 % of its credit (MP:MPA:<n>:TAX vs :SETTLE)', () => {
    expect(MIGRATION).toMatch(/SELECT coalesce\(p_ref ~ '\^MP:MPA:\[0-9\]\+:TAX\$', false\) AND EXISTS/);
    expect(MIGRATION).toMatch(/round\(abs\(\(SELECT sum\(p\.signed_amount\) FROM financial_posting p WHERE p\.financial_operation_id = s\.id\)\) \* 0\.006, 2\)\) <= 0\.01\)/);
  });
  it('named «Imp. débitos y créditos MP» in Todas las operaciones and added to the period report next to the bank one', () => {
    expect(MIGRATION).toMatch(/OR o2\.reason ILIKE 'Impuesto débitos y créditos%' OR tax_is_debcred_mp\(o2\.external_ref\)/);
    expect(MIGRATION).toMatch(/AND \(o\.external_ref LIKE 'MP-OUTFLOW-TAX:%' OR \(o\.external_ref LIKE 'MP:MPA:%:TAX' AND tax_is_debcred_mp\(o\.external_ref\)\)\)/);
  });
});
