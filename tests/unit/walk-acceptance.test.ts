/**
 * Phase 27 acceptance fixes (owner walkthrough, D-WALK-1 / D-WALK-7) — pure frontend behaviour.
 */
import { describe, expect, it } from 'vitest';
import { comprobanteVisible } from '../../src/features/cobros/ListaSaldosClientes';
import { BANK_TAX_KIND, transferWithBankTax } from '../../src/target/treasury';

function rpcStub(fail: Record<string, unknown> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fail[fn]) return { data: null, error: fail[fn] };
      return { data: fn === 'transfer_between_accounts' ? { financial_operation_id: 41 } : { financial_operation_id: 42, replayed: false }, error: null };
    },
  };
  return { client: client as never, calls };
}
const TRANSFER = { sourceAccountId: 'a', destAccountId: 'b', amount: 100000, effectiveDate: '2026-09-30', externalRef: 'TRF-1' };

describe('D-WALK-7 transfer + related bank tax', () => {
  it('without a tax only the transfer runs', async () => {
    const { client, calls } = rpcStub();
    const r = await transferWithBankTax(client, { ...TRANSFER, tax: null });
    expect(calls.map((c) => c.fn)).toEqual(['transfer_between_accounts']);
    expect(r).toEqual({ transferOperationId: 41, taxError: null });
  });

  it('with a tax: transfer first, then register_bank_tax related to it with its own idempotency key', async () => {
    const { client, calls } = rpcStub();
    const r = await transferWithBankTax(client, { ...TRANSFER, tax: { accountId: 'a', amount: 600 } });
    expect(calls.map((c) => c.fn)).toEqual(['transfer_between_accounts', 'register_bank_tax']);
    expect(calls[1].args).toMatchObject({
      p_account_id: 'a', p_amount: 600, p_effective_date: '2026-09-30', p_tax_kind: BANK_TAX_KIND, p_external_ref: 'TRF-1-IDC', p_related_operation_id: 41,
    });
    expect(r.taxError).toBeNull();
  });

  it('a tax failure after the transfer is a partial success, not an error', async () => {
    const { client } = rpcStub({ register_bank_tax: { message: 'PERIOD_CLOSED: period closed' } });
    const r = await transferWithBankTax(client, { ...TRANSFER, tax: { accountId: 'a', amount: 600 } });
    expect(r.transferOperationId).toBe(41);
    expect(r.taxError).toBeTruthy();
  });

  it('a retry with the transfer operation id never repeats the transfer', async () => {
    const { client, calls } = rpcStub();
    await transferWithBankTax(client, { ...TRANSFER, transferOperationId: 41, tax: { accountId: 'a', amount: 600 } });
    expect(calls.map((c) => c.fn)).toEqual(['register_bank_tax']);
    expect(calls[0].args.p_external_ref).toBe('TRF-1-IDC');
  });

  it('a transfer failure is thrown and no tax is attempted', async () => {
    const { client, calls } = rpcStub({ transfer_between_accounts: { message: 'SAME_ACCOUNT' } });
    await expect(transferWithBankTax(client, { ...TRANSFER, tax: { accountId: 'a', amount: 600 } })).rejects.toMatchObject({ code: 'SAME_ACCOUNT' });
    expect(calls.map((c) => c.fn)).toEqual(['transfer_between_accounts']);
  });
});

describe('D-WALK-1 technical collection key is hidden', () => {
  it('hides COBRO-<uuid>, shows a receipt the user typed', () => {
    expect(comprobanteVisible('COBRO-0b6c1f7e-3d2a-4c1b-9f00-1234567890ab')).toBe(false);
    expect(comprobanteVisible(null)).toBe(false);
    expect(comprobanteVisible('')).toBe(false);
    expect(comprobanteVisible('Recibo 0001-00012345')).toBe(true);
    expect(comprobanteVisible('COBRO-manual')).toBe(true);
  });
});
