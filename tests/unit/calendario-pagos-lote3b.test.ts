/** Lote 3B (0110) — pending expense → supplier, due date vs estimated payment date, the payment calendar. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { TARGET_READ_TABLES, TARGET_RPCS, TARGET_VIEWS } from '../../src/target/db';
import { messageFor } from '../../src/target/messages';
import {
  assignPayableToSupplier, calendarDate, isOverdue, listPaymentCalendar, listUnallocatedPayments, monthCommitments, netFundsNeed, setPaymentDate, supplierPositions, type CalendarRow,
} from '../../src/target/paymentCalendar';

const ROOT = resolve(__dirname, '../..');
const SRC = (f: string) => readFileSync(resolve(ROOT, 'src', f), 'utf8');
const MIGRATION = readFileSync(resolve(ROOT, 'supabase/target-migrations/0110_payables_supplier_link_calendar.sql'), 'utf8');
function fetchStub(body: unknown) {
  const seen: { url: URL; body: string | null }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), body: (init?.body as string) ?? null });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}
const R = (o: Partial<CalendarRow>): CalendarRow => ({
  item_kind: 'FACTURA', item_id: 'x', purchase_root_id: 'r', purchase_id: 'p', supplier_id: 's1', supplier_name: 'Molino', concept: null, document_number: null,
  economic_date: '2026-10-01', amount_total: 0, amount: 0, due_date: null, planned_date: null, link_status: 'CONFIRMADO', bank_account_name: null,
  linked_invoice_number: null, ...o,
});

describe('Lote 3B — calendar rules (dates are planning, never payments)', () => {
  it('a commitment sits on its estimated payment date, else its due date; overdue is decided by the due date only', () => {
    expect(calendarDate(R({ due_date: '2026-11-10', planned_date: '2026-11-05' }))).toBe('2026-11-05');
    expect(calendarDate(R({ due_date: '2026-11-10' }))).toBe('2026-11-10');
    expect(calendarDate(R({}))).toBeNull();
    expect(isOverdue(R({ due_date: '2026-11-30', planned_date: '2026-10-01' }), '2026-10-29')).toBe(false);   // a past estimate is not overdue
    expect(isOverdue(R({ due_date: '2026-10-20', planned_date: '2026-11-05' }), '2026-10-29')).toBe(true);
  });
  it('the month keeps apart: confirmed / cheques without allocation / no date / overdue from earlier months', () => {
    const rows = [
      R({ item_id: 'f1', amount: 31000, due_date: '2026-11-10' }),
      R({ item_kind: 'ECHEQ', item_id: 'e1', amount: 40000, due_date: '2026-11-15', link_status: 'IMPUTADO' }),
      R({ item_kind: 'CHEQUE', item_id: 'c1', amount: 10000, due_date: '2026-11-25', link_status: 'SIN_IMPUTAR' }),
      R({ item_kind: 'GASTO', item_id: 'g1', amount: 7000 }),
      R({ item_kind: 'GASTO', item_id: 'g2', amount: 5000, due_date: '2026-10-20' }),
    ];
    const m = monthCommitments(rows, '2026-11', '2026-10-29');
    expect(m.enMes.map((r) => r.item_id)).toEqual(['f1', 'e1', 'c1']);
    expect([m.confirmado, m.sinImputar, m.totalSinFecha]).toEqual([71000, 10000, 7000]);
    expect(monthCommitments(rows, '2026-12', '2026-11-12').vencidos.map((r) => r.item_id)).toEqual(['f1', 'g2']);
  });
  it('advance: the invoice keeps its pending; the advance is shown apart as free to allocate and the net need is the debt', () => {
    // Envases: invoice 40.500 pending, an advance of 40.000 not allocated → balance 500
    const rows = [R({ amount: 40500, supplier_id: 's2', supplier_name: 'Envases' })];
    const [p] = supplierPositions(rows, [{ entity_id: 's2', balance: 500 }], [{ supplier_id: 's2', available: 40000 }]);
    expect(p).toEqual({ supplier_id: 's2', nombre: 'Envases', facturasPendientes: 40500, pagosDisponibles: 40000, chequesSinImputar: 0, chequesImputados: 0,
      saldo: 500, necesidadNeta: 500, otros: 0 });
    expect(rows[0].amount).toBe(40500);   // never discounted from the invoice
    expect(netFundsNeed(rows, [{ entity_id: 's2', balance: 500 }], [{ supplier_id: 's2', available: 40000 }])).toEqual({ bruto: 40500, neto: 500, deudaProveedores: 500, chequesPorDebitar: 0, gastosSinProveedor: 0, disponibles: 40000 });
  });
  it('cheques count once: allocated ones are out of the invoice pending, unallocated ones are apart; both still leave the bank', () => {
    // Molino: invoices 41.000 pending (31.000 + 10.000), eCheq 40.000 allocated (not in the pending), cheque 10.000 without allocation;
    // balance = 41.000 − 10.000 = 31.000
    const rows = [
      R({ item_id: 'f1', amount: 31000 }), R({ item_id: 'f2', amount: 10000 }),
      R({ item_kind: 'ECHEQ', item_id: 'e1', amount: 40000, link_status: 'IMPUTADO' }),
      R({ item_kind: 'CHEQUE', item_id: 'c1', amount: 10000, link_status: 'SIN_IMPUTAR' }),
    ];
    const [p] = supplierPositions(rows, [{ entity_id: 's1', balance: 31000 }], []);
    expect([p.facturasPendientes, p.chequesSinImputar, p.chequesImputados, p.saldo, p.otros, p.necesidadNeta]).toEqual([41000, 10000, 40000, 31000, 0, 81000]);
    // gross by document: 31.000 + 10.000 + 40.000 (the unallocated cheque is NOT added on top of the invoices)
    expect(netFundsNeed(rows, [{ entity_id: 's1', balance: 31000 }], [])).toEqual({ bruto: 81000, neto: 81000, deudaProveedores: 31000, chequesPorDebitar: 50000, gastosSinProveedor: 0, disponibles: 0 });
  });
  it('net need reconciles with supplier_ledger + pending instruments + pending expenses, including a supplier with nothing in the calendar', () => {
    // s1 Molino: invoice 121.000 with an eCheq 40.000 allocated (partial) → pending 81.000; a cheque 10.000 without allocation;
    //            ledger 121.000 − 40.000 − 10.000 = 71.000
    // s2 Envases: invoice 40.500 pending, advance 40.000 free → ledger 500
    // s4 Fletes: opening debt 25.000, no invoice, no cheque, no date → only in supplier_ledger
    // s5 Silos: credit balance −3.000 (advance, nothing pending) → counts 0, never negative
    // pending expense without supplier 7.000
    const rows = [
      R({ item_id: 'f1', amount: 81000, amount_total: 121000 }),
      R({ item_kind: 'ECHEQ', item_id: 'e1', amount: 40000, link_status: 'IMPUTADO' }),
      R({ item_kind: 'CHEQUE', item_id: 'c1', amount: 10000, link_status: 'SIN_IMPUTAR' }),
      R({ item_id: 'f2', amount: 40500, supplier_id: 's2', supplier_name: 'Envases' }),
      R({ item_kind: 'GASTO', item_id: 'g1', supplier_id: null, supplier_name: null, amount: 7000 }),
    ];
    const ledger = [{ entity_id: 's1', entity_name: 'Molino', balance: 71000 }, { entity_id: 's2', entity_name: 'Envases', balance: 500 },
      { entity_id: 's4', entity_name: 'Fletes', balance: 25000 }, { entity_id: 's5', entity_name: 'Silos', balance: -3000 }];
    const libres = [{ supplier_id: 's2', available: 40000 }, { supplier_id: 's5', available: 3000 }];
    const n = netFundsNeed(rows, ledger, libres);
    expect(n).toEqual({ bruto: 168500, neto: 153500, deudaProveedores: 96500, chequesPorDebitar: 50000, gastosSinProveedor: 7000, disponibles: 43000 });
    // money still to leave = ledger debts (71.000 + 500 + 25.000) + cheques to debit (40.000 + 10.000) + expense 7.000 — each cheque once
    expect(n.neto).toBe(71000 + 500 + 25000 + 40000 + 10000 + 7000);
    const pos = supplierPositions(rows, ledger, libres);
    const fletes = pos.find((p) => p.supplier_id === 's4')!;
    expect([fletes.nombre, fletes.facturasPendientes, fletes.saldo, fletes.otros, fletes.necesidadNeta]).toEqual(['Fletes', 0, 25000, -25000, 25000]);
    const molino = pos.find((p) => p.supplier_id === 's1')!;
    expect([molino.facturasPendientes, molino.chequesSinImputar, molino.chequesImputados, molino.otros, molino.necesidadNeta]).toEqual([81000, 10000, 40000, 0, 121000]);
    // Σ per-supplier net need + expenses = global net need
    expect(pos.reduce((t, p) => t + p.necesidadNeta, 0) + n.gastosSinProveedor).toBe(n.neto);
    expect(rows.find((r) => r.item_id === 'f2')!.amount).toBe(40500);   // the advance is never discounted from the invoice
  });
  it('a supplier whose invoices equal its debt is not listed; a credit balance never makes the net need negative', () => {
    expect(supplierPositions([R({ amount: 5000 })], [{ entity_id: 's1', balance: 5000 }], [])).toEqual([]);
    const [p] = supplierPositions([], [{ entity_id: 's3', balance: -2000 }], [{ supplier_id: 's3', available: 2000 }], new Map([['s3', 'Fletes']]));
    expect([p.nombre, p.pagosDisponibles, p.saldo, p.necesidadNeta, p.otros]).toEqual(['Fletes', 2000, -2000, 0, 0]);
    expect(netFundsNeed([R({ item_kind: 'GASTO', supplier_id: null, amount: 7000 })], [], []).neto).toBe(7000);
  });
});

describe('Lote 3B — backend contract (allow-listed, as served)', () => {
  it('the calendar is read from fin_payment_calendar; the date history from purchase_payment_date', async () => {
    const { client, seen } = fetchStub([{ ...R({}), amount: '31000.00', amount_total: '121000.00' }]);
    const [r] = await listPaymentCalendar(client);
    expect([r.amount, r.amount_total]).toEqual([31000, 121000]);
    expect(seen[0].url.pathname).toBe('/rest/v1/fin_payment_calendar');
    expect(TARGET_VIEWS).toEqual(expect.arrayContaining(['fin_payment_calendar', 'fin_supplier_unallocated_payments']));
    expect(TARGET_READ_TABLES).toContain('purchase_payment_date');
    expect(TARGET_RPCS).toEqual(expect.arrayContaining(['assign_payable_to_supplier', 'set_payment_date']));
  });
  it('free payments are read from fin_supplier_unallocated_payments, numbers as served', async () => {
    const { client, seen } = fetchStub([{ financial_operation_id: 7, supplier_id: 's1', effective_date: '2026-10-22', reason: null, paid: '5000.00', allocated: '3000.00', available: '2000.00' }]);
    const [u] = await listUnallocatedPayments(client);
    expect([u.paid, u.allocated, u.available]).toEqual([5000, 3000, 2000]);
    expect(seen[0].url.pathname).toBe('/rest/v1/fin_supplier_unallocated_payments');
  });
  it('link and dates send exactly the RPC arguments (empty invoice → null; cleared estimated date → null)', async () => {
    const { client, seen } = fetchStub({ replayed: false });
    await assignPayableToSupplier(client, { payableId: 'pay1', supplierId: 's1', reason: ' llegó la factura ', idempotencyKey: 'K1', invoiceNumber: '  ' });
    await setPaymentDate(client, { purchaseId: 'p1', kind: 'PLANNED', date: '', reason: null });
    expect(seen[0].url.pathname).toBe('/rest/v1/rpc/assign_payable_to_supplier');
    expect(JSON.parse(seen[0].body!)).toEqual({ p_payable_id: 'pay1', p_supplier_id: 's1', p_reason: 'llegó la factura', p_idempotency_key: 'K1', p_supplier_invoice_number: null });
    expect(JSON.parse(seen[1].body!)).toEqual({ p_purchase_id: 'p1', p_kind: 'PLANNED', p_date: null, p_reason: null });
  });
  it('every new backend error code has a message', () => {
    const codes = [...MIGRATION.matchAll(/RAISE EXCEPTION '([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
    for (const c of new Set(codes)) expect(messageFor(new Error(`${c}: x`)), c).toBeTruthy();
  });
  it('the migration moves no money: no financial operation / posting, no new purchase outside the version, no fiscal document', () => {
    expect(MIGRATION).not.toMatch(/INSERT INTO financial_operation|INSERT INTO financial_posting|INSERT INTO fiscal_document|fiscal_document_insert|INSERT INTO expense_payable_payment/);
    expect(MIGRATION).toMatch(/CREATE TRIGGER trg_expense_payable_payment_link_guard BEFORE INSERT ON expense_payable_payment/);
  });
});

describe('Lote 3B — screens', () => {
  it('Gastos sin proveedor: dates and "Vincular a proveedor" (existing supplier, reason, one key per opened form)', () => {
    const g = SRC('features/caja/GastosAPagar.tsx');
    expect(g).toMatch(/Vincular a proveedor/);
    expect(g).toMatch(/useSuppliers\(\)/);
    expect(g).toMatch(/useState\(\(\) => `PAYABLE-LINK-\$\{crypto\.randomUUID\(\)\}`\)/);
    expect(g).toMatch(/<EtiquetasFechas due=\{g\.due_date\} planned=\{g\.planned_date\}/);
    expect(g).toMatch(/payPendingExpense\(/);   // partial payments kept
  });
  it('the supplier ficha shows and edits the dates of each pending invoice', () => {
    const f = SRC('features/caja/FichaProveedor.tsx');
    expect(f).toMatch(/<th className=\{TH\}>Vencimiento<\/th><th className=\{TH\}>Pago estimado<\/th>/);
    expect(f).toMatch(/<FechasPagoModal /);
  });
  it('the calendar: one source, cheques without allocation kept apart, real debits apart, debit action kept', () => {
    const c = SRC('features/caja/CalendarioPagos.tsx');
    expect(c).toMatch(/usePaymentCalendar\(\)/);
    expect(c).toMatch(/Sin imputar: factura no determinada/);
    expect(c).toMatch(/Debitados en el mes \(pagos reales\)/);
    expect(c).toMatch(/<AccionModal action="debit"/);
    expect(c).toMatch(/Obligaciones sin fecha/);
    expect(c).toMatch(/Necesidad neta de fondos/);
    expect(c).toMatch(/Anticipos y diferencias por imputar/);
    expect(c).toMatch(/Imputar en Pagos de facturas/);
    expect(c).not.toMatch(/supplierCoverage/);
    expect(SRC('features/caja/CajaApp.tsx')).toMatch(/\{vista === 'vencimientos' && <CalendarioPagos onImputar=\{\(\) => setVista\('pagosfactura'\)\} \/>\}/);
  });
  it('Pagos de facturas offers only payments with an amount free to allocate (and never above it); the ficha shows the total', () => {
    const pf = SRC('features/caja/PagosFacturas.tsx');
    expect(pf).toMatch(/useUnallocatedPayments\(\)/);
    expect(pf).toMatch(/Number\(monto\) <= disponible \+ 0\.005/);
    expect(SRC('features/caja/FichaProveedor.tsx')).toMatch(/Pagos disponibles para imputar a facturas/);
  });
});
