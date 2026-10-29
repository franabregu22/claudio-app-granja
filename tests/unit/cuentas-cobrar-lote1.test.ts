/** Lote 1 / 1B / 1C — Cuentas corrientes: client detail, collection modal without redundant fields, Mercado Pago receipt search. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { balanceAfterCollection, balanceState, collectionMethodFor } from '../../src/target/commercial';
import { listClientCollections } from '../../src/target/customerCollections';
import { filterMpReceipts, mpReceiptCandidates, type MpReceiptCandidate } from '../../src/target/mpActivity';
import { listPayerNames } from '../../src/target/pendingClassification';

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

const R = (p: Partial<MpReceiptCandidate>): MpReceiptCandidate =>
  ({ sourceId: '1', date: '2026-10-05', amount: 0, label: '', movementId: 1, original: 0, assigned: 0, ...p });
const CANDS = [
  R({ movementId: 1, sourceId: '182488096484', date: '2026-10-05', original: 450000, amount: 450000 }),
  R({ movementId: 4, sourceId: '182485544561', date: '2026-10-10', original: 150000, amount: 109999.5, assigned: 40000.5 }),
];
const NOMBRES = new Map([[4, 'José Pérez']]);
const buscar = (q: string) => filterMpReceipts(CANDS, q, (c) => NOMBRES.get(c.movementId) ?? null).map((c) => c.movementId);

describe('Lote 1B — Mercado Pago receipt search', () => {
  it('candidates carry the original amount, what is assigned and what is left', () => {
    const [c] = mpReceiptCandidates([{ mp_financial_movement_id: 4, payment_id: '182485544561', occurred_date: '2026-10-10', axis_a_state: 'POSTED',
      effective_applied_receipt: 150000, active_attributed: 40000.5, gross_amount: 150000 }]);
    expect([c.original, c.assigned, c.amount]).toEqual([150000, 40000.5, 109999.5]);
  });

  it('search by payer name (accents / case free), date, reference and amount; empty = everything', () => {
    expect(buscar('')).toEqual([1, 4]);
    expect(buscar('jose perez')).toEqual([4]);
    expect(buscar('10/10/2026')).toEqual([4]);
    expect(buscar('2026-10-05')).toEqual([1]);
    expect(buscar('96484')).toEqual([1]);
    expect(buscar('450.000')).toEqual([1]);
    expect(buscar('109.999,5')).toEqual([4]);
    expect(buscar('150000')).toEqual([4]);
    expect(buscar('maría')).toEqual([]);
  });

  it('payer names: fin_mp_unlinked_inflows, only the offered movements, only id + display name', async () => {
    const seen: URL[] = [];
    const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL) => {
      seen.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
      return new Response(JSON.stringify([{ movement_id: '4', payer_display_name: ' José Pérez ' }, { movement_id: '7', payer_display_name: '  ' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch } });
    const m = await listPayerNames(client, [4, 7]);
    expect([...m.entries()]).toEqual([[4, 'José Pérez']]);
    expect(seen[0].pathname).toBe('/rest/v1/fin_mp_unlinked_inflows');
    expect(seen[0].searchParams.get('select')).toBe('movement_id,payer_display_name');
    expect(seen[0].searchParams.get('movement_id')).toBe('in.(4,7)');
    expect((await listPayerNames(client, [])).size).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('the search is never pre-filtered by the client and replaces the HTML select in Cuentas a cobrar', () => {
    const b = SRC('features/cobros/BuscadorCobroMp.tsx');
    expect(b).not.toMatch(/cliente/);
    expect(b).toMatch(/Pagador no disponible/);
    expect(b).toMatch(/candidatos\.length === 0\) return <BloqueoMp mensaje=\{MP_SOURCE_MISSING_MESSAGE\} \/>/);
    const t = SRC('features/cobros/RegistroPagoModal.tsx');
    expect(t).not.toMatch(/SelectorMovimientoMp/);
    expect(t).toMatch(/<BuscadorCobroMp /);
    expect(t).not.toMatch(/registerCollection|registrar\.mutate\(\{[^}]*elegidoMp/);   // an MP receipt is allocated, never re-booked as money
  });

  it('collections table: comment is the last column, same row', () => {
    const t = SRC('features/cobros/ListaSaldosClientes.tsx');
    expect(t).toMatch(/Quién registró<\/th><th className=\{`\$\{TH\} w-full`\}>Comentario<\/th>/);
    expect(t).not.toMatch(/pl-\[5\.5rem\]/);
  });
});

describe('Lote 1C — Cuentas corrientes', () => {
  it('balance state: debe / al día / a favor', () => {
    expect(balanceState(150000)).toEqual({ estado: 'DEBE', monto: 150000 });
    expect(balanceState(0)).toEqual({ estado: 'AL_DIA', monto: 0 });
    expect(balanceState(-0.001)).toEqual({ estado: 'AL_DIA', monto: 0 });
    expect(balanceState(-50000)).toEqual({ estado: 'A_FAVOR', monto: 50000 });
  });

  it('resulting balance: Mandy owes 150.000 and pays 200.000 → 50.000 a favor, confirmation required', () => {
    expect(balanceAfterCollection(150000, 200000)).toEqual({ resultante: -50000, generaCredito: true });
    expect(balanceAfterCollection(150000, 150000)).toEqual({ resultante: 0, generaCredito: false });
    expect(balanceAfterCollection(150000, 100000)).toEqual({ resultante: 50000, generaCredito: false });
    expect(balanceAfterCollection(0, 1000)).toEqual({ resultante: -1000, generaCredito: true });          // prepayment
    expect(balanceAfterCollection(-5000, 1000)).toEqual({ resultante: -6000, generaCredito: true });      // increases a credit
    expect(balanceAfterCollection(-5000, 0)).toEqual({ resultante: -5000, generaCredito: false });        // nothing typed yet
  });

  it('module renamed; three selectable cards, default Cuentas a cobrar, one list at a time', () => {
    expect(SRC('App.tsx')).toMatch(/cobros: \{ label: 'Cuentas corrientes'/);
    const t = SRC('features/cobros/CobrosApp.tsx');
    expect(t).toMatch(/useState<Variante>\('deudor'\)/);
    for (const titulo of ['Cuentas a cobrar', 'Clientes al día', 'Clientes con crédito']) expect(t).toMatch(new RegExp(`titulo: '${titulo}'`));
    expect(t.match(/<ListaSaldosClientes /g)).toHaveLength(1);
  });

  it('a collection can be registered for every category', () => {
    const t = SRC('features/cobros/ListaSaldosClientes.tsx');
    expect(t).toMatch(/\{onRegistrarPago && \(/);
    expect(t).not.toMatch(/variante === 'deudor' && onRegistrarPago/);
    expect(SRC('features/cobros/CobrosApp.tsx')).toMatch(/onRegistrarPago: setCliente/);
  });

  it('modal: current and resulting balance; a credit blocks saving until that exact balance is confirmed; Disponible MP stays apart', () => {
    const t = SRC('features/cobros/RegistroPagoModal.tsx');
    expect(t).toMatch(/Saldo actual:/);
    expect(t).toMatch(/Saldo resultante:/);
    expect(t).toMatch(/const creditoOk = !generaCredito \|\| creditoConfirmado === resultante;/);
    expect(t).toMatch(/const puedeGuardar = creditoOk && /);
    expect(t).toMatch(/Disponible MP: \{formatoPesos\(elegidoMp\.amount\)\}/);
    expect(t).not.toMatch(/balanceAfterCollection\([^)]*elegidoMp\.amount/);   // the MP available amount is not the client's balance
  });
});
