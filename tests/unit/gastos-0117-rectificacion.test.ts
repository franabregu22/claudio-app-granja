/** 0117 — Nuevo gasto simplified (concept first, supplier optional, payment state) and the audited Editar / Rectificar. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  cambiosAuditoria, cuentaAdmitida, fiscalJson, NATURALEZA_GASTO, registrarGasto, reglasEdicion, rutaGasto, type NuevoGastoInput,
} from '../../src/target/expenses';
import { TARGET_RPCS, TARGET_VIEWS } from '../../src/target/db';

const ROOT = resolve(__dirname, '../..');
const SRC = (f: string) => readFileSync(resolve(ROOT, 'src', f), 'utf8');
const MIG = readFileSync(resolve(ROOT, 'supabase/target-migrations/0117_expense_paid_supplier_rectify.sql'), 'utf8');

const base: NuevoGastoInput = {
  concept: ' Maíz ', supplierId: 's1', amountTotal: 1210, fecha: '2026-11-05', categoryId: 'c1', nature: 'OPERATING', estado: 'PENDIENTE', medio: null,
  accountId: null, fechaPago: '2026-11-05', invoiceNumber: null, fiscal: null, cuitEmisor: null, nombreEmisor: null, idempotencyKey: 'GASTO-1',
};
function cliente(respuestas: Record<string, unknown> = {}) {
  const rpc = vi.fn(async (name: string) => ({ data: respuestas[name] ?? { ok: true }, error: null }));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('Nuevo gasto — one form, the existing RPC of each case', () => {
  it('the route follows supplier, payment state, method and payment date', () => {
    const r = (o: Partial<Parameters<typeof rutaGasto>[0]>) => rutaGasto({ supplierId: 's1', estado: 'PENDIENTE', medio: null, fecha: '2026-11-05', fechaPago: '2026-11-05', ...o });
    expect(r({})).toBe('FACTURA_PENDIENTE');
    expect(r({ estado: 'PAGADO', medio: 'TRANSFER' })).toBe('FACTURA_PAGADA');
    expect(r({ estado: 'PAGADO', medio: 'MERCADOPAGO' })).toBe('PROVEEDOR_MP_NO_PERMITIDO');
    expect(r({ supplierId: null })).toBe('SIN_PROVEEDOR_PENDIENTE');
    expect(r({ supplierId: null, estado: 'PAGADO', medio: 'MERCADOPAGO' })).toBe('SIN_PROVEEDOR_MP');
    expect(r({ supplierId: null, estado: 'PAGADO', medio: 'CASH' })).toBe('SIN_PROVEEDOR_PAGADO');
    expect(r({ supplierId: null, estado: 'PAGADO', medio: 'CASH', fechaPago: '2026-11-08' })).toBe('SIN_PROVEEDOR_PAGADO_DESPUES');
  });
  it('pending with supplier: register_purchase with the concept, no money', async () => {
    const { client, rpc } = cliente();
    await registrarGasto(client, base, []);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('register_purchase');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_supplier_id: 's1', p_subcategory: 'Maíz', p_amount_total: 1210, p_amount_net: 1210, p_idempotency_key: 'GASTO-1' });
  });
  it('paid to a supplier: ONE atomic RPC with the real payment date and account', async () => {
    const { client, rpc } = cliente();
    await registrarGasto(client, { ...base, estado: 'PAGADO', medio: 'TRANSFER', accountId: 'bank', fechaPago: '2026-11-07' }, []);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['register_paid_supplier_purchase']);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_payment_date: '2026-11-07', p_payment_method: 'TRANSFER', p_account_id: 'bank', p_concept: 'Maíz' });
  });
  it('paid to a supplier with Mercado Pago never reaches the database (classified from its movement)', async () => {
    const { client, rpc } = cliente();
    await expect(registrarGasto(client, { ...base, estado: 'PAGADO', medio: 'MERCADOPAGO', accountId: 'mp' }, [])).rejects.toThrow('PROVEEDOR_MP_NO_PERMITIDO');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('without supplier: pending expense; Mercado Pago linked later; paid at once; paid later = pending + its payment (replay-safe keys)', async () => {
    const sin = { ...base, supplierId: null };
    let c = cliente();
    await registrarGasto(c.client, sin, []);
    expect(c.rpc.mock.calls.map((x) => x[0])).toEqual(['register_pending_expense']);
    expect(c.rpc.mock.calls[0][1]).toMatchObject({ p_concept: 'Maíz', p_origin: 'ERP' });
    c = cliente();
    await registrarGasto(c.client, { ...sin, estado: 'PAGADO', medio: 'MERCADOPAGO', accountId: 'mp' }, []);
    expect(c.rpc.mock.calls[0]).toEqual(['register_casual_purchase_mp_pending', expect.objectContaining({ p_mp_account_id: 'mp' })]);
    c = cliente();
    await registrarGasto(c.client, { ...sin, estado: 'PAGADO', medio: 'CASH', accountId: 'cash' }, []);
    expect(c.rpc.mock.calls[0]).toEqual(['register_casual_purchase', expect.objectContaining({ p_paid_from_account_id: 'cash', p_payment_method: 'CASH' })]);
    c = cliente({ register_pending_expense: { payable_id: 'pay-1' } });
    await registrarGasto(c.client, { ...sin, estado: 'PAGADO', medio: 'TRANSFER', accountId: 'bank', fechaPago: '2026-11-09' }, []);
    expect(c.rpc.mock.calls.map((x) => x[0])).toEqual(['register_pending_expense', 'pay_pending_expense']);
    expect(c.rpc.mock.calls[1][1]).toMatchObject({ p_payable_id: 'pay-1', p_effective_date: '2026-11-09', p_idempotency_key: 'GASTO-1:PAY', p_payment_method: 'TRANSFER' });
  });
  it('fiscal data as typed: net from the invoice, components CREDITO, the issuer CUIT without supplier', async () => {
    const fiscal = { documentType: 'INVOICE_A' as const, fiscalPeriod: '2026-11-01', netAmount: 1000, totalAmount: 1210,
      components: [{ tax_kind: 'IVA' as const, base_amount: 1000, rate_applied: 21, tax_amount: 210 }] };
    expect(fiscalJson(fiscal, { fecha: '2026-11-05', numero: ' 0001-1 ', cuitEmisor: '30719089891' })).toMatchObject({
      document_type: 'INVOICE_A', net_amount: 1000, external_number: '0001-1', issuer_tax_id: '30719089891', components: [{ direction: 'CREDITO', tax_amount: 210 }] });
    const { client, rpc } = cliente();
    await registrarGasto(client, { ...base, supplierId: null, fiscal, cuitEmisor: '30719089891' }, []);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_amount_net: 1000, p_fiscal: { issuer_tax_id: '30719089891' } });
  });
  it('exactly three natures, on the existing values; accounts by method', () => {
    expect(NATURALEZA_GASTO).toEqual([['OPERATING', 'Operativo'], ['REINVESTMENT', 'Reinversión operativa'], ['INVESTMENT', 'Inversión']]);
    expect(cuentaAdmitida('CASH', 'CASH')).toBe(true);
    expect(cuentaAdmitida('CASH', 'BANK_ACCOUNT')).toBe(false);
    expect(cuentaAdmitida('TRANSFER', 'BANK_ACCOUNT')).toBe(true);
    expect(cuentaAdmitida('MERCADOPAGO', 'EXTERNAL_SERVICE')).toBe(true);
  });
  it('the form: owner order, no Notas / Detalle de ítems / Más datos, the receipt folded and optional', () => {
    const c = SRC('features/caja/Compras.tsx');
    const form = c.slice(c.indexOf('export function NuevaCompraModal'), c.indexOf('export function SelectorNaturaleza'));
    const orden = ['Concepto del gasto', '>Proveedor', 'Importe total', '<SelectorCategoria ', '<SelectorNaturaleza ', 'Estado del pago', '<BloqueComprobante '].map((t) => form.indexOf(t));
    expect(orden.every((i) => i > 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
    for (const t of ['Notas', 'Detalle de ítems', 'Más datos', 'reason: notas']) expect(form).not.toContain(t);
    expect(form).toMatch(/<option value="">Sin proveedor<\/option>/);
    expect(form).toMatch(/useRegisterExpense\(\)/);
    expect(c).toMatch(/Factura o comprobante \(opcional\)/);
  });
});

describe('Editar / Rectificar — what each link allows', () => {
  const g = { conProveedor: true, pagadoAlRegistrar: false, pendienteSinProveedor: false, mpVinculado: false, asignado: 0, conFactura: false };
  it('a pending invoice: everything', () => {
    expect(reglasEdicion(g)).toMatchObject({ proveedor: true, fecha: true, importe: true, numero: true, agregarFactura: true, motivos: [] });
  });
  it('payments allocated: no supplier change (amount still editable, never below what is allocated)', () => {
    expect(reglasEdicion({ ...g, asignado: 500 })).toMatchObject({ proveedor: false, importe: true });
  });
  it('a fiscal document: supplier, amount and number locked; no second document', () => {
    expect(reglasEdicion({ ...g, conFactura: true })).toMatchObject({ proveedor: false, importe: false, numero: false, agregarFactura: false, fecha: true });
  });
  it('paid without supplier: date and amount are its payment\'s; pending without supplier: amount is the obligation\'s', () => {
    expect(reglasEdicion({ ...g, conProveedor: false, pagadoAlRegistrar: true })).toMatchObject({ proveedor: false, fecha: false, importe: false });
    expect(reglasEdicion({ ...g, conProveedor: false, pendienteSinProveedor: true })).toMatchObject({ proveedor: false, fecha: true, importe: false });
    expect(reglasEdicion({ ...g, conProveedor: false, mpVinculado: true })).toMatchObject({ importe: false });
  });
  it('the history lists only what changed, labelled', () => {
    expect(cambiosAuditoria({
      before_values: { concept: 'Maíz', amount_total: '1000.00', nature: 'OPERATING', economic_date: '2026-10-10', version: 0 },
      after_values: { concept: 'Maíz partido', amount_total: 1000, nature: 'REINVESTMENT', economic_date: '2026-10-10', version: 1, new_id: 'x' },
    }).map((c) => `${c.campo}:${c.antes}>${c.despues}`)).toEqual(['Concepto:Maíz>Maíz partido', 'Naturaleza:OPERATING>REINVESTMENT']);
  });
  it('the action is in every expense detail, with its history; the reason is required; one audited RPC', () => {
    const gastos = SRC('features/caja/Gastos.tsx');
    expect(gastos).toMatch(/>Editar \/ Rectificar<\/button>/);
    expect(gastos).toMatch(/<HistorialGasto purchaseId=\{c\.id\} rootId=\{raizDe\(it\)\} \/>/);
    const ed = SRC('features/caja/EditarGasto.tsx');
    expect(ed).toMatch(/motivo\.trim\(\) !== ''/);
    expect(ed).toMatch(/useRectifyExpense\(\)/);
    expect(ed).not.toMatch(/\.from\(|callRpc|\.insert\(|\.update\(/);
    expect(SRC('target/expenses.ts')).toMatch(/'rectify_purchase_details'/);
    for (const r of ['register_paid_supplier_purchase', 'rectify_purchase_details', 'register_casual_purchase', 'register_casual_purchase_mp_pending', 'purchase_chain_root'])
      expect(TARGET_RPCS as readonly string[]).toContain(r);
    expect(TARGET_VIEWS as readonly string[]).toContain('fin_purchase_audit');
  });
});

describe('0117 — the database keeps the rules and the trace', () => {
  it('no existing row is rewritten: only the current flag of the rectified version flips', () => {
    expect(MIG.match(/UPDATE purchases SET[^;]*/g)).toEqual(['UPDATE purchases SET is_current = false WHERE id = v_old.id']);
    expect(MIG).not.toMatch(/DELETE FROM|TRUNCATE|ALTER TABLE/);
    expect(MIG).toMatch(/UPDATE freight_allocation SET purchase_id = v_new_id/);   // freight follows the version (as rectify_purchase)
  });
  it('every refusal of the GO is enforced in the backend', () => {
    for (const code of ['REASON_REQUIRED', 'PURCHASE_HAS_PAYMENTS', 'OVER_ALLOCATION', 'FISCAL_DOCUMENT_LOCKED', 'PAID_EXPENSE_DATE_LOCKED',
      'CASUAL_PURCHASE_AMOUNT_LOCKED', 'PENDING_EXPENSE_AMOUNT_LOCKED', 'MP_LINKED_AMOUNT_LOCKED', 'SUPPLIER_CHANGE_NOT_ALLOWED',
      'DUPLICATE_SUPPLIER_INVOICE', 'NOTHING_TO_RECTIFY', 'INVALID_PAYMENT_METHOD']) expect(MIG).toContain(`'${code}`);
  });
  it('one audit row per rectification: before, after, reason, user; the history view is ADMIN through RLS (security_invoker)', () => {
    expect(MIG).toMatch(/INSERT INTO audit_events \(entity_type, entity_id, action, before_values, after_values, reason, performed_by\)\n  VALUES \('purchases', v_old\.id::TEXT, 'RECTIFY_DETAILS', v_before, v_after, btrim\(p_reason\), v_uid\)/);
    expect(MIG).toMatch(/CREATE VIEW fin_purchase_audit WITH \(security_invoker = true\)/);
  });
  it('paid to a supplier: the existing RPCs in one transaction, Mercado Pago refused, replay by key', () => {
    const f = MIG.slice(MIG.indexOf('CREATE FUNCTION register_paid_supplier_purchase'), MIG.indexOf('CREATE FUNCTION rectify_purchase_details'));
    for (const t of ['register_purchase(', 'register_purchase_with_fiscal_document(', 'pay_supplier(', 'allocate_purchase_payment(', "'replayed', true"]) expect(f).toContain(t);
    expect(f).toMatch(/NOT IN \('CASH', 'TRANSFER'\)/);
  });
});
