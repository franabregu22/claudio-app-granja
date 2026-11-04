/**
 * 0116 — Caja → Transferencias: anticipated transfers (Mercado Pago ↔ bank, linked to their ONE transfer), the tax recorded once
 * (associated, never recorded twice; the statement matches it instead of booking it) and the screen wiring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { listChargeProposals, REVIEW_LABEL } from '../../src/target/bankCharges';
import { TARGET_READ_TABLES, TARGET_RPCS } from '../../src/target/db';
import type { MpCandidate } from '../../src/target/mpActivity';
import {
  cancelTransferIntent, intentCandidates, intentRoute, linkTransferIntent, recordedTaxesNear, registerTransferIntent, relateBankTax, sameAmountTax,
} from '../../src/target/transferIntents';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
function stub(body: unknown) {
  const seen: { url: string; args: Record<string, unknown> }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), args: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}
const MP = { isMp: true, isBank: false };
const BANK = { isMp: false, isBank: true };
const CASH = { isMp: false, isBank: false };

describe('0116 — which transfers are anticipated', () => {
  it('Mercado Pago → bank is a payout, bank → Mercado Pago an inflow; every other pair is a direct transfer', () => {
    expect(intentRoute(MP, BANK)).toBe('PAYOUT');
    expect(intentRoute(BANK, MP)).toBe('INFLOW');
    expect(intentRoute(CASH, BANK)).toBeNull();
    expect(intentRoute(BANK, BANK)).toBeNull();
    expect(intentRoute(MP, CASH)).toBeNull();
  });
});

describe('0116 — what can settle an anticipated transfer', () => {
  const intent = { amount: 3200000, from_account_id: 'mp', to_account_id: 'bna' };
  const mov = (sourceId: string, amount: number): MpCandidate => ({ sourceId, amount, date: '2026-11-03', label: `x ${sourceId}` });
  const trf = (id: number, from: string, to: string, amount: number, linked = false) => ({
    operation_id: id, effective_date: '2026-11-03', kind: 'TRANSFERENCIA' as const, transfer_intent: linked ? { intent_id: 1, effective_date: '2026-11-03' } : null,
    postings: [{ posting_id: 1, account_id: from, account_name: from, signed_amount: -amount }, { posting_id: 2, account_id: to, account_name: to, signed_amount: amount }],
  });
  it('a Mercado Pago movement of exactly its amount, to the cent', () => {
    const c = intentCandidates(intent, [mov('186516120301', 3200000), mov('2', 3200000.01), mov('3', 320000)], []);
    expect(c.map((x) => x.sourceId)).toEqual(['186516120301']);
    expect(c[0].kind).toBe('MOVEMENT');
  });
  it('a transfer already confirmed between the same accounts, same direction and amount, not linked to another intent', () => {
    const c = intentCandidates(intent, [], [trf(9593, 'mp', 'bna', 3200000), trf(1, 'bna', 'mp', 3200000), trf(2, 'mp', 'bna', 3199999), trf(3, 'mp', 'bna', 3200000, true)]);
    expect(c.map((x) => x.operationId)).toEqual([9593]);
    expect(c[0].kind).toBe('TRANSFER');
  });
  it('nothing yet: no candidate (the intent waits; no money moved)', () => {
    expect(intentCandidates(intent, [], [])).toEqual([]);
  });
});

describe('0116 — the tax of a transfer is recorded once', () => {
  const taxes = [
    { operation_id: 10, amount: 120, effective_date: '2026-10-05', external_ref: 'STMT-LINE:4' },
    { operation_id: 11, amount: 77, effective_date: '2026-10-09', external_ref: 'IDC-x' },
    { operation_id: 12, amount: 120, effective_date: '2026-09-20', external_ref: 'IDC-y' },
  ];
  it('only the taxes within 3 days of the transfer, the closest first', () => {
    expect(recordedTaxesNear(taxes, '2026-10-06').map((t) => t.operation_id)).toEqual([10, 11]);
    expect(recordedTaxesNear(taxes, '2026-10-12').map((t) => t.operation_id)).toEqual([11]);
    expect(recordedTaxesNear(taxes, '2026-11-30')).toEqual([]);
  });
  it('a typed amount equal to one of them is that charge (to the cent): associate it, do not record it again', () => {
    const near = recordedTaxesNear(taxes, '2026-10-06');
    expect(sameAmountTax(near, 120)?.operation_id).toBe(10);
    expect(sameAmountTax(near, 120.01)).toBeNull();
    expect(sameAmountTax(near, 50)).toBeNull();
  });
});

describe('0116 — the requests', () => {
  it('register, link (exactly one of movement / operation) and cancel send only their keys; the server resolves the money', async () => {
    const { client, seen } = stub({ intent_id: 1, replayed: false });
    await registerTransferIntent(client, { fromAccountId: 'mp', toAccountId: 'bna', amount: 3200000, effectiveDate: '2026-11-03', idempotencyKey: 'TRF-1', reason: '  ' });
    await linkTransferIntent(client, { intentId: 1, sourceId: '186516120301' });
    await linkTransferIntent(client, { intentId: 1, operationId: 9593 });
    await cancelTransferIntent(client, { intentId: 1, reason: 'error' });
    await relateBankTax(client, { taxOperationId: 10, transferOperationId: 9593 });
    expect(seen.map((x) => [x.url.split('/rpc/')[1], x.args])).toEqual([
      ['fin_register_transfer_intent', { p_from_account_id: 'mp', p_to_account_id: 'bna', p_amount: 3200000, p_effective_date: '2026-11-03', p_idempotency_key: 'TRF-1', p_reason: null }],
      ['fin_link_transfer_intent', { p_intent_id: 1, p_source_id: '186516120301', p_operation_id: null }],
      ['fin_link_transfer_intent', { p_intent_id: 1, p_source_id: null, p_operation_id: 9593 }],
      ['fin_cancel_transfer_intent', { p_intent_id: 1, p_reason: 'error' }],
      ['fin_relate_bank_tax', { p_tax_operation_id: 10, p_transfer_operation_id: 9593, p_reason: null }],
    ]);
  });
  it('the RPCs and the intent table are in the contract lists', () => {
    expect(TARGET_RPCS).toEqual(expect.arrayContaining(['fin_register_transfer_intent', 'fin_link_transfer_intent', 'fin_cancel_transfer_intent', 'fin_relate_bank_tax']));
    expect(TARGET_READ_TABLES).toContain('fin_transfer_intent');
  });
  it('a statement tax already recorded arrives as RECORDED with the posting to match (numbers as numbers)', async () => {
    const { client } = stub([{ statement_line_id: 4, value_date: '2026-10-05', description_raw: 'GRAVAMEN', bank_reference: '9', signed_amount: '-120.00', running_balance: '10.00',
      status: 'RECORDED', kind: 'BANK_TAX_DEBCRED', rule_id: 1, label: 'Impuesto', expense_category_id: null, category_name: null, recorded_posting_id: '77', recorded_count: '1' }]);
    const [r] = await listChargeProposals(client, 'bna');
    expect([r.status, r.recorded_posting_id, r.recorded_count, r.signed_amount]).toEqual(['RECORDED', 77, 1, -120]);
    expect(REVIEW_LABEL.RECORDED).toBe('Ya registrado: conciliar');
  });
});

describe('0116 — the screens', () => {
  const trf = SRC('features/caja/Transferencias.tsx');
  const cargos = SRC('features/caja/CargosBancarios.tsx');
  it('a Mercado Pago transfer with no movement yet is registered ahead (no money) and linked later; the direct transfer keeps its route', () => {
    expect(trf).toMatch(/const adelantada = esMp && ruta !== null && \(anticipada \|\| sinMovimiento\);/);
    expect(trf).toMatch(/register\.mutate\(\{ fromAccountId: origen, toAccountId: destino, amount: Number\(monto\), effectiveDate: fecha, idempotencyKey: clave/);
    expect(trf).toMatch(/link\.mutate\(\{ intentId: f\.id, sourceId: c\.sourceId \?\? null, operationId: c\.operationId \?\? null \}/);
    expect(trf).toMatch(/transferWithTax\.mutate\(\{ sourceAccountId: origen, destAccountId: destino/);
    expect(trf).toMatch(/Registrada antes del movimiento|Registradas antes del movimiento/);
  });
  it('the state of every transfer is shown; the history pages on the server', () => {
    expect(trf).toMatch(/useMovementList\(\{ kind: 'TRANSFERENCIA' \}, pagina\)/);
    expect(trf).toMatch(/rowStatusLabel\(t\)/);
  });
  it('no tax is computed: only a confirmed amount; one already recorded is associated, and the same amount again needs an explicit confirmation', () => {
    expect(trf).not.toMatch(/\* 0\.006|0\.012|porcentaje \*|\* tasa/);
    expect(trf).toMatch(/no se calcula ningún porcentaje/);
    expect(trf).toMatch(/relateTax\.mutate\(\{ taxOperationId: t\.operation_id, transferOperationId: transferenciaId \}/);
    expect(trf).toMatch(/const puede = cuenta !== '' && Number\(monto\) > 0 && \(!igual \|\| otroCargo\);/);
    expect(trf).toMatch(/: datosOk && !taxRepetido;/);
  });
  it('a recorded tax line of the statement is matched with its record, never booked (the batch keeps PROPOSED lines only)', () => {
    expect(cargos).toMatch(/const registrados = filas\.filter\(\(r\) => r\.status === 'RECORDED'\)/);
    expect(cargos).toMatch(/match\.mutate\(\{ statementLineId: r\.statement_line_id, postingId: r\.recorded_posting_id as number/);
    expect(cargos).toMatch(/const propuestas = filas\.filter\(\(r\) => r\.status === 'PROPOSED'\);/);
  });
});
