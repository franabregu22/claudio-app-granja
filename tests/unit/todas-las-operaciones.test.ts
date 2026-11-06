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

import { FILTROS_VACIOS, filtroServidor, hayFiltros } from '../../src/features/caja/TodasLasOperaciones';

describe('Caja — Todas las operaciones 0120: filters and Limpiar filtros', () => {
  it('every owner filter reaches the server; "Sin asignar" is its own flag; subcategory and category travel together', () => {
    const f = { ...FILTROS_VACIOS, desde: '2026-10-01', hasta: '2026-10-31', tipo: 'EGRESO' as const, cuenta: 'SIN', estado: 'POR_REVISAR' as const,
      grupo: 'g1', subcategoria: 's1', naturaleza: 'INVESTMENT' as const, proveedor: 'p1', buscar: 'maíz', orden: 'CARGA' as const };
    expect(filtroServidor(f, false)).toEqual({ from: '2026-10-01', to: '2026-10-31', tipo: 'EGRESO', accountId: undefined, sinCuenta: true, estado: 'POR_REVISAR',
      groupId: 'g1', categoryId: 's1', nature: 'INVESTMENT', supplierId: 'p1', search: 'maíz', order: 'CARGA' });
    expect(filtroServidor({ ...FILTROS_VACIOS, cuenta: 'acc' }, false)).toMatchObject({ accountId: 'acc', sinCuenta: false });
    expect(filtroServidor(FILTROS_VACIOS, true).order).toBe('CARGA');
  });
  it('Limpiar filtros: everything back, dates, search and order included', () => {
    expect(hayFiltros(FILTROS_VACIOS)).toBe(false);
    for (const k of Object.keys(FILTROS_VACIOS) as (keyof typeof FILTROS_VACIOS)[]) {
      expect(hayFiltros({ ...FILTROS_VACIOS, [k]: k === 'orden' ? 'CARGA' : 'x' })).toBe(true);
    }
    expect(filtroServidor(FILTROS_VACIOS, false)).toEqual({ from: undefined, to: undefined, tipo: undefined, accountId: undefined, sinCuenta: false, estado: undefined,
      groupId: undefined, categoryId: undefined, nature: undefined, supplierId: undefined, search: undefined, order: 'FECHA' });
  });
  it('one line per row with the nine columns, a drop-down with Gastos and Transferencias actions, and the subcategory list of the chosen category', () => {
    const t = readFileSync('src/features/caja/TodasLasOperaciones.tsx', 'utf8');
    expect([...t.matchAll(/<th className="px-2 py-2[^"]*">([^<]+)<\/th>/g)].map((m) => m[1]))
      .toEqual(['Fecha', 'Tipo', 'Concepto', 'Categoría', 'Subcategoría', 'Cuenta', 'Importe', 'Estado', 'Acciones']);
    expect(t).toMatch(/colSpan=\{9\}/);
    expect(t).toMatch(/\.filter\(\(s\) => !filtros\.grupo \|\| s\.group_id === filtros\.grupo\)/);
    expect(t).toMatch(/'grupo' in cambio \? \{ subcategoria: '' \}/);
  });
});
