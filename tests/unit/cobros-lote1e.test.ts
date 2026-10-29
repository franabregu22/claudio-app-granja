/** Lote 1E — anular / rectificar cobros en efectivo y bancos (0108): frontend side. The SQL side is
 * scripts/target-db/fin_collection_reversal.test.mjs (local database, rolled back). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rectifyCollection, reverseCollection } from '../../src/target/commercial';
import {
  canReverseManualCollection, collectionIdOf, type CustomerCollectionRow, rectificationEffect,
} from '../../src/target/customerCollections';
import { TARGET_RPCS } from '../../src/target/db';
import { errorMessage } from '../../src/target/messages';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const ID = '0b6c1f7e-3d2a-4c1b-9f00-1234567890ab';
const R = (p: Partial<CustomerCollectionRow>): CustomerCollectionRow => ({
  row_id: `C:${ID}`, business_date: '2026-10-10', created_at: '2026-10-10T10:00:00Z', cliente_id: 'c1', client_name: 'Mandy', amount: 100000,
  account_name: 'Caja chica', account_type: 'CASH', payment_method: 'CASH', notes: null, financial_operation_id: 1, source_id: null, origin: 'CASH',
  status: 'CASH', correction_id: null, correction_role: 'SINGLE', counts_for_customer: true, reversal_kind: null, reversal_reason: null,
  reversal_at: null, replacement_of: null, ...p,
});
function rpcStub() {
  const calls: { fn: string; args: unknown }[] = [];
  return { calls, client: { rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: {}, error: null }; } } as never };
}

describe('Lote 1E — eligibility', () => {
  it('identity: only C:<collection uuid>', () => {
    expect(collectionIdOf(R({}))).toBe(ID);
    expect(collectionIdOf(R({ row_id: `A:${ID}` }))).toBeNull();
  });
  it('Anular / Rectificar: cash or bank, still counting, no correction, not reconciled, not already reversed', () => {
    expect(canReverseManualCollection(R({}))).toBe(true);
    expect(canReverseManualCollection(R({ account_type: 'BANK_ACCOUNT', status: 'PENDING_RECONCILIATION' }))).toBe(true);
    expect(canReverseManualCollection(R({ account_type: 'BANK_ACCOUNT', status: 'CONCILIATED' }))).toBe(false);
    expect(canReverseManualCollection(R({ account_type: 'EXTERNAL_SERVICE', status: 'MANUAL_WITHOUT_SOURCE' }))).toBe(false);
    expect(canReverseManualCollection(R({ row_id: `A:${ID}`, account_type: 'EXTERNAL_SERVICE' }))).toBe(false);
    expect(canReverseManualCollection(R({ correction_id: 'k1', correction_role: 'COMPONENT', origin: 'CORRECTION' }))).toBe(false);
    expect(canReverseManualCollection(R({ reversal_kind: 'ANNUL', status: 'ANNULLED', counts_for_customer: false }))).toBe(false);
  });
});

describe('Lote 1E — net effect of a rectification (preview)', () => {
  const orig = { clienteId: 'a', clienteNombre: 'A', amount: 50000, accountName: 'BNA' };
  it('other client, other amount, other account', () => {
    expect(rectificationEffect(orig, { clienteId: 'b', clienteNombre: 'B', amount: 45000, accountName: 'Caja chica' })).toEqual({
      clientes: [{ clienteId: 'a', nombre: 'A', deuda: 50000 }, { clienteId: 'b', nombre: 'B', deuda: -45000 }],
      cuentas: [{ nombre: 'BNA', saldo: -50000 }, { nombre: 'Caja chica', saldo: 45000 }],
    });
  });
  it('same client and account: only the difference', () => {
    expect(rectificationEffect(orig, { ...orig, amount: 60000 })).toEqual({
      clientes: [{ clienteId: 'a', nombre: 'A', deuda: -10000 }], cuentas: [{ nombre: 'BNA', saldo: 10000 }] });
  });
  it('only the account changes: client untouched', () => {
    expect(rectificationEffect(orig, { ...orig, accountName: 'Patagonia' })).toEqual({
      clientes: [], cuentas: [{ nombre: 'BNA', saldo: -50000 }, { nombre: 'Patagonia', saldo: 50000 }] });
  });
});

describe('Lote 1E — RPC contract', () => {
  it('reverse_collection / rectify_collection: contract inputs only, allow-listed', async () => {
    const { client, calls } = rpcStub();
    await reverseCollection(client, { collectionId: ID, reason: 'duplicado', idempotencyKey: 'ui:k1' });
    await rectifyCollection(client, { collectionId: ID, clienteId: 'b', amount: 45000, accountId: 'acc', effectiveDate: '2026-10-10', reason: 'r', idempotencyKey: 'ui:k2' });
    expect(calls).toEqual([
      { fn: 'reverse_collection', args: { p_collection_id: ID, p_reason: 'duplicado', p_idempotency_key: 'ui:k1' } },
      { fn: 'rectify_collection', args: { p_collection_id: ID, p_cliente_id: 'b', p_amount: 45000, p_financial_account_id: 'acc',
        p_effective_date: '2026-10-10', p_reason: 'r', p_idempotency_key: 'ui:k2' } },
    ]);
    expect(TARGET_RPCS).toEqual(expect.arrayContaining(['reverse_collection', 'rectify_collection']));
  });
  it('server refusals have a readable message', () => {
    for (const code of ['ALREADY_REVERSED', 'BANK_MATCHED', 'COLLECTION_ACCOUNT_NOT_SUPPORTED', 'FERIA_COLLECTION', 'PART_OF_CORRECTION',
      'NOTHING_TO_RECTIFY', 'DUPLICATE_IDEMPOTENCY_KEY', 'PERIOD_CLOSED']) {
      expect(errorMessage({ message: `${code}: x` })).not.toMatch(new RegExp(code));
    }
  });
});

describe('Lote 1E — UI guards', () => {
  it('Anular: reason + confirmation, one key per form, no resubmit after success', () => {
    const t = SRC('features/cobros/AnularCobroModal.tsx');
    expect(t).toMatch(/const \[clave\] = useState\(\(\) => `ui:\$\{crypto\.randomUUID\(\)\}`\)/);
    expect(t).toMatch(/motivo\.trim\(\) !== '' && confirmado && !annul\.isPending && !annul\.isSuccess/);
    expect(t).toMatch(/annul\.mutate\(\{ collectionId, reason: motivo\.trim\(\), idempotencyKey: clave \}/);
  });
  it('Rectificar: cash / bank destinations only, confirmation bound to the exact data, identical data blocked', () => {
    const t = SRC('features/cobros/RectificarCobroModal.tsx');
    expect(t).toMatch(/a\.account_type === 'CASH' \|\| a\.account_type === 'BANK_ACCOUNT'/);
    expect(t).toMatch(/confirmado === firma/);
    expect(t).toMatch(/const efecto = datosOk && !igual \?/);
    expect(t).not.toMatch(/mp_allocate_to_client|allocateToClient|registerCollection/);
  });
  it('table: actions gated, reversed originals struck through with their reversal line', () => {
    const t = SRC('features/cobros/TablaCobros.tsx');
    expect(t).toMatch(/\{canReverseManualCollection\(p\) && <>/);
    expect(t).toMatch(/<NotaPopover nota=\{p\.reversal_reason\} \/>/);
    expect(t).toMatch(/Rectificación/);
  });
  it('Caja → Cobros de clientes: a reversed original is not added to the total', () => {
    expect(SRC('features/caja/CobrosClientes.tsx')).toMatch(/s \+ \(i\.main\.reversal_kind \? 0 : i\.amount\)/);
  });
});
