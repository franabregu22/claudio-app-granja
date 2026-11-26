/** 0121 (caja-mejoras-v2): Cuentas a pagar → Pendientes on real data — groups, cards, overdue by due date only, plans, wiring. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enTarjeta, etiquetaFila, fechaFila, grupoFila, repartirCuotas, totales, vencida, type PayableDueRow } from '../../src/target/paymentPlan';
import { reglasEdicion } from '../../src/target/expenses';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const HOY = '2026-11-13';   // a Friday
const R = (o: Partial<PayableDueRow>): PayableDueRow => ({
  row_key: 'k', row_kind: 'PAGO', obligation_kind: 'FACTURA', purchase_root_id: 'r', purchase_id: 'p', item_id: null, seq: 1, n_items: 1,
  due_date: null, planned_date: null, item_amount: null, amount: 100, supplier_id: 's', supplier_name: 'S', concept: null, document_number: null,
  economic_date: null, amount_total: null, instrument_id: null, cheque_number: null, bank_account_name: null, link_status: null, ...o,
});

describe('Cuentas a pagar → Pendientes (0121)', () => {
  it('a row sits on its estimated date, else its due date; "vencido" only by the due date', () => {
    expect(fechaFila(R({ due_date: '2026-11-30', planned_date: '2026-11-20' }))).toBe('2026-11-20');
    expect(vencida(R({ due_date: '2026-11-12' }), HOY)).toBe(true);
    expect(vencida(R({ due_date: null, planned_date: '2026-11-01' }), HOY)).toBe(false);
    expect(grupoFila(R({ due_date: null, planned_date: '2026-11-01' }), HOY)).toBe('SEMANA');   // a past estimate is not overdue
  });
  it('groups: Vencidos / Esta semana (to Sunday) / Este mes / Más adelante / Sin fecha', () => {
    expect(['2026-11-12', '2026-11-15', '2026-11-16', '2026-12-01'].map((d) => grupoFila(R({ due_date: d }), HOY))).toEqual(['VENCIDO', 'SEMANA', 'MES', 'ADELANTE']);
    expect(grupoFila(R({}), HOY)).toBe('SIN_FECHA');
  });
  it('cards filter and add up', () => {
    const rows = [R({ due_date: '2026-11-10', amount: 10 }), R({ due_date: '2026-11-18', amount: 20 }), R({ due_date: '2026-12-10', amount: 40 }), R({ amount: 80 })];
    expect(totales(rows, HOY)).toEqual({ TOTAL: 150, VENCIDO: 10, PROX7: 20, PROX30: 60, SIN_FECHA: 80 });
    expect(enTarjeta(rows[0], 'PROX7', HOY)).toBe(false);   // overdue is its own card
  });
  it('labels: instalment n/N, cheque with its account, a difference left by a rectification', () => {
    expect(etiquetaFila(R({ row_kind: 'CUOTA', seq: 2, n_items: 4 }))).toBe('Cuota 2/4');
    expect(etiquetaFila(R({ row_kind: 'ECHEQ', cheque_number: 'E-1', bank_account_name: 'BNA', link_status: 'SIN_IMPUTAR' }))).toBe('eCheq E-1 · BNA · sin imputar');
    expect(etiquetaFila(R({ row_kind: 'DIFERENCIA' }))).toMatch(/Diferencia/);
  });
  it('instalments add up to what is open', () => {
    const c = repartirCuotas(100_000, 3, '2026-01-31', 'MENSUAL');
    expect(c.map((x) => x.due_date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(c.reduce((t, x) => t + x.amount, 0)).toBeCloseTo(100_000, 2);
  });
  it('pencil: the 0117 locks are kept and each locked field shows its reason (owner decision 2026-11-13)', () => {
    const base = { conProveedor: true, pagadoAlRegistrar: false, pendienteSinProveedor: false, mpVinculado: false, asignado: 0, conFactura: false };
    expect(reglasEdicion(base).porque).toEqual({});
    const fiscal = reglasEdicion({ ...base, conFactura: true });
    expect([fiscal.proveedor, fiscal.importe, fiscal.numero]).toEqual([false, false, false]);
    expect(fiscal.porque.importe).toMatch(/nota de crédito/);
    const sinProv = reglasEdicion({ ...base, conProveedor: false, pendienteSinProveedor: true });
    expect(sinProv.importe).toBe(true);   // 0124: free while nothing is paid
    const pagado = reglasEdicion({ ...base, conProveedor: false, pendienteSinProveedor: true, pagadoPendiente: 5 });
    expect([pagado.importe, pagado.porque.importe]).toEqual([false, expect.stringMatching(/pagos registrados/)]);
    expect(reglasEdicion({ ...base, asignado: 100 }).porque.proveedor).toMatch(/pagos o cheques/);
    const ui = SRC('features/caja/EditarGasto.tsx');
    for (const k of ['proveedor', 'importe', 'fecha', 'numero']) expect(ui, k).toContain(`'${k}')}`);
  });
  it('Nuevo gasto: a pending expense takes its plan (instalments) or own cheques in the same submit', () => {
    const c = SRC('features/caja/Compras.tsx');
    expect(c).toContain("usePlanPago(totalNum, { cheques: conProveedor ? 'SI' : 'REQUIERE_PROVEEDOR' })");
    expect(c).toContain('planes.plan.mutateAsync({ purchaseId, items: plan.items, idempotencyKey: `${clave}:PLAN` })');
    expect(c).toContain('planes.chequesObligation.mutateAsync({ purchaseId, instruments: plan.cheques, idempotencyKey: `${clave}:CH` })');
  });
  it('wiring: the real list in Cuentas a pagar, each action is its RPC (no direct writes)', () => {
    const ui = SRC('features/caja/PendientesPagar.tsx');
    expect(SRC('features/caja/SolapaPagar.tsx')).toContain('<PendientesPagar onProveedores=');
    expect(ui).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
    for (const call of ['m.payItem.mutateAsync', 'm.chequesItem.mutateAsync', 'm.chequesObligation.mutateAsync', 'm.payInvoice.mutateAsync', 'm.payPending.mutateAsync', 'm.plan.mutateAsync'])
      expect(ui, call).toContain(call);
    expect(ui).toContain('<DetalleGasto it={g}');   // the shared expense detail: Editar / Rectificar with its locks, history
    expect(SRC('target/db.ts')).toMatch(/'set_payment_plan', 'pay_plan_item', 'issue_plan_item_instruments'/);
  });
});
