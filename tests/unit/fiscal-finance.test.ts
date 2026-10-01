/**
 * Phase 27 acceptance fixes — Fiscal + Finance (ADR-015, owner D-FISCAL-1…8 / D-FIN-1…2): pure frontend behaviour.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPurchaseWithAttachments } from '../../src/target/attachments';
import { DIRECT_WRITES, TARGET_RPCS, TARGET_VIEWS } from '../../src/target/db';
import { FISCAL_VACIO, fiscalInput, type FiscalForm } from '../../src/target/fiscal';
import { registerPurchaseWithFiscal } from '../../src/target/treasury';

function rpcStub() {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: { purchase_id: 'p' }, error: null }; } };
  return { client: client as never, calls };
}
const PURCHASE = {
  supplierId: 's', economicDate: '2026-09-15', amountNet: 1210, amountTotal: 1210, categoryId: 'c', nature: 'OPERATING' as const,
  lines: [], attachments: [], idempotencyKey: 'k', invoiceNumber: 'FC-1',
};
const FORM: FiscalForm = { tipo: 'INVOICE_A', periodo: '', neto: '1000', total: '1210', componentes: [{ tax_kind: 'IVA', base: '1000', alicuota: '21', importe: '210' }] };

describe('D-FISCAL-4 / 5 purchase fiscal data (no frontend tax calculation)', () => {
  it('no fiscal data → null (the purchase goes through register_purchase alone)', () => {
    expect(fiscalInput(FISCAL_VACIO, '2026-09-15')).toBeNull();
  });

  it('the typed amounts pass through exactly; the period defaults to the purchase month', () => {
    expect(fiscalInput(FORM, '2026-09-15')).toEqual({
      documentType: 'INVOICE_A', fiscalPeriod: '2026-09-01', netAmount: 1000, totalAmount: 1210,
      components: [{ tax_kind: 'IVA', base_amount: 1000, rate_applied: 21, tax_amount: 210 }],
    });
    expect(fiscalInput({ ...FORM, periodo: '2026-08' }, '2026-09-15')?.fiscalPeriod).toBe('2026-08-01');
  });

  it('nothing is derived: a component without its amount keeps the form incomplete (null), it is never computed', () => {
    expect(fiscalInput({ ...FORM, componentes: [{ tax_kind: 'IVA', base: '1000', alicuota: '21', importe: '' }] }, '2026-09-15')).toBeNull();
    expect(fiscalInput({ ...FORM, total: '' }, '2026-09-15')).toBeNull();
    const blankExtra = fiscalInput({ ...FORM, componentes: [...FORM.componentes, { tax_kind: 'PERCEPTION', base: '', alicuota: '', importe: '' }] }, '2026-09-15');
    expect(blankExtra?.components).toHaveLength(1);
  });

  it('with fiscal data the purchase is ONE RPC call (RPC 50) with direction CREDITO components', async () => {
    const { client, calls } = rpcStub();
    await registerPurchaseWithFiscal(client, { ...PURCHASE, fiscal: fiscalInput(FORM, '2026-09-15')! });
    expect(calls.map((c) => c.fn)).toEqual(['register_purchase_with_fiscal_document']);
    expect(calls[0].args).toMatchObject({
      p_fiscal_document_type: 'INVOICE_A', p_fiscal_period: '2026-09-01', p_fiscal_net_amount: 1000, p_fiscal_total_amount: 1210,
      p_fiscal_components: [{ tax_kind: 'IVA', base_amount: 1000, rate_applied: 21, tax_amount: 210, direction: 'CREDITO' }],
      p_supplier_invoice_number: 'FC-1', p_amount_total: 1210,
    });
  });

  it('createPurchaseWithAttachments routes to RPC 50 only when fiscal data exists', async () => {
    const a = rpcStub();
    await createPurchaseWithAttachments(a.client, { ...PURCHASE, userId: 'u', files: [], fiscal: null });
    expect(a.calls.map((c) => c.fn)).toEqual(['register_purchase']);
    const b = rpcStub();
    await createPurchaseWithAttachments(b.client, { ...PURCHASE, userId: 'u', files: [], fiscal: fiscalInput(FORM, '2026-09-15') });
    expect(b.calls.map((c) => c.fn)).toEqual(['register_purchase_with_fiscal_document']);
  });

  it('the fiscal report and RPC 50 are authorized; there is no direct fiscal write', () => {
    expect(TARGET_VIEWS).toContain('report_fiscal_period');
    expect(TARGET_RPCS).toContain('register_purchase_with_fiscal_document');
    expect(Object.keys(DIRECT_WRITES).filter((t) => t.startsWith('fiscal'))).toEqual([]);
  });

  it('no tax formula in the purchase / fiscal screens (no 21 % or rate × base in code)', () => {
    for (const f of ['src/features/caja/Compras.tsx', 'src/features/fiscal/FiscalApp.tsx', 'src/target/fiscal.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/\*\s*0?\.21\b|\b0?\.21\s*\*|\/\s*1\.21\b|\*\s*1\.21\b/);
      expect(src).not.toMatch(/rate_applied\s*\*|\*\s*rate_applied|base_amount\s*\*/);
    }
  });
});

describe('D-FIN-1 / D-FIN-2 finance UX', () => {
  const caja = readFileSync('src/features/caja/CajaApp.tsx', 'utf8');
  const finanzas = readFileSync('src/features/finanzas/FinanzasApp.tsx', 'utf8');
  const modal = readFileSync('src/features/finanzas/EventoGestionModal.tsx', 'utf8');

  it('the withdrawal action is "Retiro de socios" under Caja → Más acciones', () => {
    expect(caja).toMatch(/Más acciones/);
    expect(caja).toMatch(/Retiro de socios/);
    expect(caja).toMatch(/<EventoGestionModal tipo="RETIRO"/);
    expect(modal).toMatch(/RETIRO: 'Retiro de socios'/);
  });

  it('Finanzas no longer offers the withdrawal; the internal reserve is a secondary action', () => {
    expect(finanzas).not.toMatch(/tipo="RETIRO"/);
    expect(finanzas).toMatch(/<EventoGestionModal tipo="RESERVA_INTERNA"/);
    expect(finanzas).toMatch(/Más acciones/);
  });

  it('the backend contract is unchanged: both types still go through register_management_event', () => {
    expect(modal).toMatch(/registerManagementEvent\(supabase, p\)/);
    expect(TARGET_RPCS).toContain('register_management_event');
  });
});
