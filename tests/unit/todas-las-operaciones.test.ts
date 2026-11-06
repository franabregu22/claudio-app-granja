import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
import { TARGET_RPCS } from '../../src/target/db';
import { claveDeRegistro, cuentasLabel, estadoLabel, type OperationRow } from '../../src/target/operations';
import { pagableDesdeFila } from '../../src/features/caja/TodasLasOperaciones';

const fila = (o: Partial<OperationRow>): OperationRow => ({
  row_key: 'OP:1', row_kind: 'OP', date: '2026-11-06', created_at: null, tipo: 'EGRESO', amount: -100, estado: 'COMPLETADA', concepto: 'x', detalle: 'y',
  operation_id: 1, ref_uuid: null, ref_id: null, accounts: [], conciliacion: null, clasificacion: null, pendiente: null, ...o,
});

describe('Caja — Todas las operaciones (0119)', () => {
  it('states in the owner words: Pendiente / Pagado / Cobrado / Realizada', () => {
    expect(estadoLabel({ tipo: 'EGRESO', estado: 'PENDIENTE' })).toBe('Pendiente');
    expect(estadoLabel({ tipo: 'EGRESO', estado: 'COMPLETADA' })).toBe('Pagado');
    expect(estadoLabel({ tipo: 'INGRESO', estado: 'COMPLETADA' })).toBe('Cobrado');
    expect(estadoLabel({ tipo: 'TRANSFERENCIA', estado: 'COMPLETADA' })).toBe('Realizada');
    expect(estadoLabel({ tipo: 'TRANSFERENCIA', estado: 'PENDIENTE' })).toBe('Pendiente');
  });

  it('accounts: "Sin asignar" for an unpaid obligation; money leaves first in a transfer', () => {
    expect(cuentasLabel(fila({ accounts: [] }))).toBe('Sin asignar');
    expect(cuentasLabel(fila({ tipo: 'TRANSFERENCIA', accounts: [
      { account_id: 'b', account_name: 'BNA', signed_amount: 500 }, { account_id: 'm', account_name: 'Mercado Pago', signed_amount: -500 }] }))).toBe('Mercado Pago → BNA');
    expect(cuentasLabel(fila({ row_kind: 'TRANSFERENCIA', accounts: [
      { account_id: 'm', account_name: 'Mercado Pago', signed_amount: null }, { account_id: 'b', account_name: 'BNA', signed_amount: null }] }))).toBe('Mercado Pago → BNA');
  });

  it('a just-recorded expense is found by the key of its row (by route), Mercado Pago waits for its movement', () => {
    expect(claveDeRegistro('SIN_PROVEEDOR_PENDIENTE', { payable_id: 'p1' })).toBe('GASTO:p1');
    expect(claveDeRegistro('FACTURA_PENDIENTE', { purchase_id: 'f1' })).toBe('FACTURA:f1');
    expect(claveDeRegistro('FACTURA_PAGADA', { financial_operation_id: 42 })).toBe('OP:42');
    expect(claveDeRegistro('SIN_PROVEEDOR_PAGADO', { payment_operation_id: 7 })).toBe('OP:7');
    expect(claveDeRegistro('SIN_PROVEEDOR_PAGADO_DESPUES', { financial_operation_id: 8 })).toBe('OP:8');
    expect(claveDeRegistro('SIN_PROVEEDOR_MP', { purchase_id: 'x' })).toBeNull();
  });

  it('payable from the row: a pending expense remainder; the part of an invoice no cheque covers; nothing else', () => {
    expect(pagableDesdeFila(fila({ row_kind: 'GASTO', estado: 'PENDIENTE', pendiente: { total: 1000, pagado: 400, pendiente: 600, vence: null, estimada: null } }))).toBe(600);
    expect(pagableDesdeFila(fila({ row_kind: 'FACTURA', estado: 'PENDIENTE', pendiente: { purchase_id: 'f', total: 1000, pagado: 0, pendiente: 1000, cheques_por_debitar: 1000, sin_cubrir: 0, vence: null, estimada: null } }))).toBeNull();
    expect(pagableDesdeFila(fila({ row_kind: 'FACTURA', estado: 'PENDIENTE', pendiente: { purchase_id: 'f', total: 1000, pagado: 0, pendiente: 1000, cheques_por_debitar: 300, sin_cubrir: 700, vence: null, estimada: null } }))).toBe(700);
    expect(pagableDesdeFila(fila({ row_kind: 'OP' }))).toBeNull();
    expect(pagableDesdeFila(fila({ row_kind: 'CHEQUE', estado: 'PENDIENTE' }))).toBeNull();
  });

  it('wiring: the three 0119 RPCs are allowlisted; Movimientos shows the list and keeps Por resolver; payments reuse the existing contracts', () => {
    expect(TARGET_RPCS).toEqual(expect.arrayContaining(['fin_operation_list', 'fin_operation_timeline', 'pay_purchase_invoice', 'pay_pending_expense']));
    const mov = readFileSync('src/features/caja/Movimientos.tsx', 'utf8');
    expect(mov).toMatch(/<TodasLasOperaciones /);
    expect(mov).toMatch(/<MovimientosHistoricos /);
    const ops = readFileSync('src/features/caja/useOperations.ts', 'utf8');
    expect(ops).toMatch(/payPendingExpense\(supabase, p\)/);
    expect(ops).toMatch(/payPurchaseInvoice\(supabase, p\)/);
  });
});
