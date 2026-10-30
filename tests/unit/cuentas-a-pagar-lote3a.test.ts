/** Lote 3A — Cuentas a pagar y proveedores (frontend only): cards, supplier ficha, advances, pending expenses without supplier. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { TARGET_READ_TABLES } from '../../src/target/db';
import { listSupplierInvoices } from '../../src/target/invoicePayments';
import { classifySuppliers, listSupplierLedger, SUPPLIER_MOVEMENT } from '../../src/target/treasury';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
function fetchStub(body: unknown) {
  const seen: URL[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL) => {
    seen.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}
const B = (entity_id: string, entity_name: string, balance: number) => ({ entity_id, entity_name, balance, period: '2026-10-01' });
const S = (id: string, nombre: string, activo = true) => ({ id, nombre, activo });

describe('Lote 3A — supplier situations', () => {
  it('debt / up to date / credit in our favour; an active supplier without movement is up to date', () => {
    const r = classifySuppliers([B('a', 'Molino', 90000), B('b', 'Envases', -40000), B('c', 'Vete', 0)], [S('a', 'Molino'), S('b', 'Envases'), S('c', 'Vete'), S('d', 'Nuevo')]);
    expect(r.map((x) => [x.nombre, x.situation, x.balance])).toEqual([['Envases', 'A_FAVOR', -40000], ['Molino', 'DEUDA', 90000], ['Nuevo', 'AL_DIA', 0], ['Vete', 'AL_DIA', 0]]);
  });
  it('an inactive supplier is listed only while it has a balance; a balance without a visible supplier is never hidden', () => {
    const r = classifySuppliers([B('x', 'Viejo', 500), B('z', 'Fuera del maestro', 100)], [S('x', 'Viejo', false), S('y', 'Inactivo sin saldo', false)]);
    expect(r.map((x) => [x.nombre, x.situation])).toEqual([['Fuera del maestro', 'DEUDA'], ['Viejo', 'DEUDA']]);
  });
  it('cents are rounded before deciding (no phantom 0.001 debt)', () => {
    expect(classifySuppliers([B('a', 'A', 0.001)], [S('a', 'A')])[0].situation).toBe('AL_DIA');
  });
});

describe('Lote 3A — data the ficha reads (as recorded, never derived)', () => {
  it('supplier ledger of ONE supplier, newest first, read-only and allow-listed', async () => {
    const { client, seen } = fetchStub([{ id: 1, movement_type: 'PAYMENT', signed_amount: '-50000.00', effective_date: '2026-10-22', source_entity_type: null, reason: null, created_at: 'x' }]);
    const r = await listSupplierLedger(client, 's1');
    expect(r[0].signed_amount).toBe(-50000);
    expect(seen[0].pathname).toBe('/rest/v1/supplier_ledger');
    expect(seen[0].searchParams.get('supplier_id')).toBe('eq.s1');
    expect(seen[0].searchParams.get('order')).toBe('effective_date.desc,id.desc');
    expect(TARGET_READ_TABLES).toContain('supplier_ledger');
  });
  it('invoices of ONE supplier from fin_purchase_payment_status (backend figures)', async () => {
    const { client, seen } = fetchStub([{ purchase_id: 'p1', amount_total: '120000', scheduled: '60000', debited: '0', other_payments: '0', pending: '60000', voided_instruments: '0' }]);
    const [f] = await listSupplierInvoices(client, 's1');
    expect([f.amount_total, f.scheduled, f.pending]).toEqual([120000, 60000, 60000]);
    expect(seen[0].pathname).toBe('/rest/v1/fin_purchase_payment_status');
    expect(seen[0].searchParams.get('supplier_id')).toBe('eq.s1');
  });
  it('every ledger movement is labelled as obligation, real payment, own instrument or correction — never mixed', () => {
    expect(Object.fromEntries(Object.entries(SUPPLIER_MOVEMENT).map(([k, v]) => [k, v.kind]))).toEqual({
      PURCHASE: 'OBLIGACION', FREIGHT: 'OBLIGACION', OPENING_BALANCE: 'OBLIGACION', PAYMENT: 'PAGO',
      INSTRUMENT_ISSUED: 'INSTRUMENTO', CHEQUE_ENDORSED: 'INSTRUMENTO', INSTRUMENT_REJECTED: 'INSTRUMENTO', ADJUSTMENT: 'CORRECCION', REVERSAL: 'CORRECCION',
    });
  });
});

describe('Lote 3A — Cuentas a pagar screen', () => {
  const t = SRC('features/caja/CuentasAPagar.tsx');
  it('four selectable cards, one list at a time, default suppliers with debt', () => {
    for (const s of ['Proveedores con deuda', 'Gastos sin proveedor', 'Proveedores al día', 'Saldos a favor / anticipos']) expect(t).toContain(`titulo: '${s}'`);
    expect(t).toMatch(/useState<Tarjeta>\('DEUDA'\)/);
    expect(t).toMatch(/tarjeta === 'SIN_PROVEEDOR' \? <GastosAPagar titulo="Gastos sin proveedor" \/>/);
  });
  it('each supplier opens its ficha; paying more than the debt is an advance (credit), never an expense', () => {
    expect(t).toMatch(/\{open && <FichaProveedor cuenta=\{c\} \/>\}/);
    expect(t).toMatch(/queda como saldo a favor/);
    expect(t).toMatch(/No es un gasto/);
    // the existing payment paths are kept: pay_supplier, own cheques / eCheqs, Mercado Pago outflow
    expect(t).toMatch(/paySupplier\.mutate\(\{/);
    expect(t).toMatch(/issueInstrument\.mutate\(\{/);
  });
  it('the ficha shows invoices with receipts, ledger movements and cheques / eCheqs with their PDFs', () => {
    const f = SRC('features/caja/FichaProveedor.tsx');
    expect(f).toMatch(/useSupplierInvoices\(cuenta\.supplier_id\)/);
    expect(f).toMatch(/useSupplierLedger\(cuenta\.supplier_id\)/);
    expect(f).toMatch(/usePurchaseAttachments\(/);
    expect(f).toMatch(/useDocumentLinks\('FINANCIAL_INSTRUMENT'/);
    expect(f).toMatch(/Programado \(aún no debitado\)/);
  });
  it('Pagos de facturas and Vencimientos stay as they were', () => {
    const c = SRC('features/caja/CajaApp.tsx');
    expect(c).toMatch(/\{ id: 'pagosfactura', label: 'Pagos de facturas' \}/);
    expect(c).toMatch(/\{ id: 'vencimientos', label: 'Vencimientos' \}/);
  });
});
