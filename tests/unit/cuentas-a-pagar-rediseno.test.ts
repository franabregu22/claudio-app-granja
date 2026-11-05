/** Cuentas a pagar in three sections (Gastos / Proveedores / Cheques), one list of expenses and the floating "Nuevo gasto" button. Frontend only. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  armarGastos, buscar, coincide, contar, estadoFactura, facturaRepetida, ordenar, posibleDuplicado, totalFiltro, type GastoFuentes,
} from '../../src/target/expenseHub';
import type { PurchasePaymentStatusRow } from '../../src/target/invoicePayments';
import type { PayableRow } from '../../src/target/payables';
import type { PurchaseMpLinkRow } from '../../src/target/purchaseMpLink';
import type { PurchaseRow } from '../../src/target/treasury';
import type { PendingExpenseRow } from '../../src/target/unclassifiedExpenses';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');

const factura = (p: Partial<PurchasePaymentStatusRow>): PurchasePaymentStatusRow => ({
  purchase_id: 'f1', purchase_root_id: 'f1', supplier_id: 's1', supplier_name: 'Agro Centenario', supplier_invoice_number: '0001-00000123',
  fiscal_document_id: null, economic_date: '2026-10-10', amount_total: 1000, scheduled: 0, debited: 0, other_payments: 0, pending: 1000,
  voided_instruments: 0, due_date: null, planned_date: null, ...p,
});
const aPagar = (p: Partial<PayableRow>): PayableRow => ({
  payable_id: 'p1', purchase_id: 'c1', purchase_root_id: 'c1', economic_date: '2026-10-05', concept: 'Gasoil', counterparty_name: 'YPF',
  expense_category_id: 'k', category_name: 'Combustible', fiscal_document_id: null, amount: 500, paid: 0, pending: 500, due_date: '2026-11-01',
  status: 'PENDIENTE', origin: 'WHATSAPP', created_at: '', planned_date: null, ...p,
});
const sinClasificar = (p: Partial<PendingExpenseRow>): PendingExpenseRow => ({
  pending_id: 7, status: 'SIN_CLASIFICAR', economic_date: '2026-10-20', amount: 80, financial_account_id: 'a', account_name: 'Caja', payment_method: 'CASH',
  concept: 'Ferretería', counterparty_name: null, origin: 'WHATSAPP', origin_ref: { draft_short_code: 'W-0042' }, payment_operation_id: 9, created_by: 'u', created_at: '',
  purchase_id: null, expense_category_id: null, category_name: null, nature: null, classified_by: null, classified_at: null, ...p,
});
const mp = (p: Partial<PurchaseMpLinkRow>): PurchaseMpLinkRow => ({
  purchase_root_id: 'm1', purchase_id: 'm1', economic_date: '2026-10-21', amount_total: 300, concept: 'Repuesto', counterparty_name: null, category_name: 'Mantenimiento',
  fiscal_document_id: null, origin: 'WHATSAPP', origin_code: 'W-0050', created_at: '', status: 'PENDIENTE_VINCULACION_MP', source_id: null, movement_date: null,
  linked_at: null, age_days: 3, candidates: null, ...p,
});
const compra = (p: Partial<PurchaseRow>): PurchaseRow => ({
  id: 'x1', supplier_id: null, supplier_nombre: 'Kiosco', counterparty_name: 'Kiosco', economic_date: '2026-10-02', amount_net: 50, amount_total: 50,
  expense_category_id: 'k', categoria_nombre: 'Varios', subcategory: 'Café', nature: 'OPERATING', supplier_invoice_number: null, version_seq: 0, created_at: '', lineas: [], ...p,
});
const vacio: GastoFuentes = { facturas: [], aPagar: [], sinClasificar: [], mp: [], compras: [] };

describe('Gastos — one list from the existing sources', () => {
  it('an invoice state comes from the backend figures: owed → pending; only unpaid cheques → cheques; else paid', () => {
    expect(estadoFactura({ pending: 1000, scheduled: 0 })).toBe('PENDIENTE');
    expect(estadoFactura({ pending: 400, scheduled: 600 })).toBe('PENDIENTE');
    expect(estadoFactura({ pending: 0, scheduled: 600 })).toBe('CHEQUES');
    expect(estadoFactura({ pending: 0, scheduled: 0 })).toBe('PAGADO');
  });
  it('every source lands in its filter: WhatsApp items to review, pending expenses, invoices, paid purchases', () => {
    const items = armarGastos({
      facturas: [factura({}), factura({ purchase_id: 'f2', purchase_root_id: 'f2', pending: 0, scheduled: 1000 }), factura({ purchase_id: 'f3', purchase_root_id: 'f3', pending: 0, debited: 1000 })],
      aPagar: [aPagar({})], sinClasificar: [sinClasificar({}), sinClasificar({ pending_id: 8, status: 'CLASIFICADO', purchase_id: 'x9' })],
      mp: [mp({}), mp({ purchase_id: 'm2', purchase_root_id: 'm2', status: 'VINCULADO' })], compras: [compra({})],
    });
    const c = contar(items);
    expect(c).toEqual({ POR_REVISAR: 2, PENDIENTE: 2, CHEQUES: 1, PAGADO: 2, TODOS: 7 });
    expect(items.filter((i) => coincide(i, 'POR_REVISAR')).map((i) => i.kind).sort()).toEqual(['MP_PENDIENTE', 'SIN_CLASIFICAR']);
    expect(items.find((i) => i.kind === 'A_PAGAR')?.origen).toBe('WHATSAPP');
  });
  it('a purchase appears once: the invoice wins, supplier purchases come only from the invoice status, pending-only and latest lists merge', () => {
    const f = factura({});
    const items = armarGastos({
      ...vacio, facturas: [f, { ...f }], aPagar: [aPagar({ purchase_id: 'f1' })],
      compras: [compra({ id: 'f1', supplier_id: 's1' }), compra({ id: 'c1' }), compra({ id: 'x2', supplier_id: 's2' })],
    });
    expect(items.map((i) => i.key)).toEqual(['F-f1', 'C-c1']);
  });
  it('a partly owed invoice with cheques waiting shows in Pendientes and in Cheques pendientes; totals are the backend figures', () => {
    const items = armarGastos({ ...vacio, facturas: [factura({ pending: 400, scheduled: 600 })], aPagar: [aPagar({ pending: 200, paid: 300, status: 'PARCIAL' })] });
    expect(items.filter((i) => coincide(i, 'PENDIENTE'))).toHaveLength(2);
    expect(items.filter((i) => coincide(i, 'CHEQUES'))).toHaveLength(1);
    expect(totalFiltro(items, 'PENDIENTE')).toBe(600);
    expect(totalFiltro(items, 'CHEQUES')).toBe(600);
    expect(totalFiltro(items, 'TODOS')).toBeNull();
  });
  it('pending: nearest due date first, no due date last; other lists newest first; search ignores accents and case', () => {
    const items = armarGastos({ ...vacio, facturas: [factura({ due_date: null }), factura({ purchase_id: 'f2', purchase_root_id: 'f2', due_date: '2026-11-20' })], aPagar: [aPagar({})] });
    expect(ordenar(items, 'PENDIENTE').map((i) => i.key)).toEqual(['P-p1', 'F-f2', 'F-f1']);
    expect(ordenar(items, 'TODOS')[0].fecha).toBe('2026-10-10');
    expect(items.filter((i) => buscar(i, 'centenarió')).length).toBe(2);
    expect(items.filter((i) => buscar(i, '00000123')).length).toBe(2);
  });
  it('duplicate controls of the form: same supplier + invoice number refused; same supplier, date and total warned', () => {
    const fs = [factura({})];
    expect(facturaRepetida(fs, 's1', ' 0001-00000123 ')).toBe(true);
    expect(facturaRepetida(fs, 's2', '0001-00000123')).toBe(false);
    expect(facturaRepetida(fs, 's1', '')).toBe(false);
    expect(posibleDuplicado(fs, 's1', '2026-10-10', 1000)).toBe(true);
    expect(posibleDuplicado(fs, 's1', '2026-10-11', 1000)).toBe(false);
  });
});

describe('Cuentas a pagar — navigation, floating button and reuse', () => {
  const app = SRC('features/caja/CajaApp.tsx');
  const pagar = SRC('features/caja/SolapaPagar.tsx');
  const gastos = SRC('features/caja/Gastos.tsx');
  const compras = SRC('features/caja/Compras.tsx');
  it('three sections, Gastos first and by default', () => {
    expect([...pagar.matchAll(/\{ id: '\w+', label: '([^']+)' \}/g)].map((m) => m[1])).toEqual(['Gastos', 'Proveedores', 'Cheques']);
    expect(app).toMatch(/useState<SubPagar>\('gastos'\)/);
    for (const old of ['GastosAPagar', 'PagosFacturas', "'pagosfactura'", '<Compras />']) expect(pagar + app).not.toContain(old);
  });
  it('the floating "Nuevo gasto" button lives at Caja level (every tab) and opens the existing purchase form', () => {
    expect(app).toMatch(/className="fixed bottom-6 right-4/);
    expect(app).toMatch(/\{nuevoGasto && <NuevaCompraModal onClose=\{\(\) => setNuevoGasto\(false\)\} \/>\}/);
    expect(app.indexOf("if (rol !== 'ADMIN')")).toBeLessThan(app.indexOf('<NuevaCompraModal'));
    expect(compras).toMatch(/<Modal titulo="Nuevo gasto"/);
    expect(compras).toMatch(/<DatosFiscales value=\{fiscal\} onChange=\{setFiscal\} \/>/);   // with or without invoice, fiscal validation kept
    expect(compras).toMatch(/useState\(\(\) => `CMP-\$\{crypto\.randomUUID\(\)\}`\)/);
    expect(compras).toMatch(/&& !repetida;/);
  });
  it('Gastos reuses the existing forms: eCheqs, allocation, payment, supplier link, dates, classification, rectification, freight', () => {
    for (const tag of ['<EmitirChequesModal ', '<ImputarPagoModal ', '<PagarGastoModal ', '<VincularProveedorModal ', '<FechasPagoModal ', '<AccionGastoSinClasificar ',
      '<RectificarCompraModal ', '<AsignarFleteModal ', '<DetalleFactura ', '<Fletes />']) expect(gastos, tag).toContain(tag);
    expect(gastos).not.toMatch(/\.rpc\(|callRpc|\.insert\(|\.update\(|\.delete\(|\.mutate\(/);
  });
  it('a cheque lowers the supplier debt; the bank moves only when it is debited', () => {
    expect(SRC('features/caja/PagosFacturas.tsx')).toMatch(/Baja la deuda con el proveedor; el banco se mueve recién al marcar cada cheque como debitado\./);
    expect(gastos).toMatch(/el banco se mueve recién cuando se marca el débito/);
  });
});
