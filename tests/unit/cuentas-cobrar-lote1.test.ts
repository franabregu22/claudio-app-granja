/** Lote 1 — Cuentas a cobrar: client detail and collection modal without redundant fields. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { collectionMethodFor } from '../../src/target/commercial';
import { listClientCollections } from '../../src/target/customerCollections';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');

describe('Lote 1 — Cuentas a cobrar', () => {
  it('the collection method follows the destination account; Mercado Pago has no manual method', () => {
    expect(collectionMethodFor('CASH')).toBe('CASH');
    expect(collectionMethodFor('BANK_ACCOUNT')).toBe('TRANSFER');
    expect(collectionMethodFor('EXTERNAL_SERVICE')).toBeNull();
    expect(collectionMethodFor(undefined)).toBeNull();
  });

  it('client collections: fin_customer_collections, only what counts for the balance, newest first, numeric', async () => {
    const seen: URL[] = [];
    const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL) => {
      seen.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
      return new Response(JSON.stringify([{ row_id: 'C:1', amount: '1500.50', financial_operation_id: '9', notes: 'seña' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch } });
    const r = await listClientCollections(client);
    expect(r[0].amount).toBe(1500.5);
    expect(r[0].financial_operation_id).toBe(9);
    expect(seen.map((u) => u.pathname)).toEqual(['/rest/v1/fin_customer_collections']);
    expect(seen[0].searchParams.get('counts_for_customer')).toBe('eq.true');
    expect(seen[0].searchParams.get('order')).toBe('business_date.desc,created_at.desc');
  });

  it('Cuentas a cobrar has no "Últimos cobros registrados" block', () => {
    expect(SRC('features/cobros/CobrosApp.tsx')).not.toMatch(/Últimos cobros/);
  });

  it('client detail: no product lines, no e-mail as a person, account + comment on collections', () => {
    const t = SRC('features/cobros/ListaSaldosClientes.tsx');
    expect(t).not.toMatch(/producto_nombre|lineas\.map/);
    expect(t).not.toMatch(/email/);
    expect(t).toMatch(/N\.º pedido/);
    expect(t).toMatch(/Quién entregó/);
    expect(t).toMatch(/Quién registró/);
    expect(t).toMatch(/p\.account_name/);
    expect(t).toMatch(/p\.notes/);
  });

  it('modal: no method selector, no receipt field; the receipt id is always the generated key', () => {
    const t = SRC('features/cobros/RegistroPagoModal.tsx');
    expect(t).not.toMatch(/COLLECTION_METHODS|setMetodo|Método/);
    expect(t).not.toMatch(/comprobante/i);
    expect(t).toMatch(/useState\(\(\) => `COBRO-\$\{crypto\.randomUUID\(\)\}`\)/);
    expect(t).toMatch(/method: metodo, receiptId: claveAuto/);
    expect(t).toMatch(/collectionMethodFor\(/);
  });
});
