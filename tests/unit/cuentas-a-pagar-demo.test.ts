/** caja-mejoras-v2: Cuentas a pagar / Cartera de cheques prototype — fictitious data only, owner decisions 2026-11-13. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  abiertoReplanificable, agregarGasto, editarGasto, editarVto, endosar, enTarjeta, grupo, pagarConCheque, pagarVto, pendiente, replanificar,
  repartirCuotas, resumenProveedor, semillaDemo, totales, validarGasto, validarPlan, type DemoPagar, type NuevoGasto,
} from '../../src/features/caja/pagarDemo';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const HOY = '2026-11-13';   // a Friday
const A = { cuando: '13/11/26 10:00', quien: 'admin@demo' };
const totalAbierto = (s: DemoPagar) => totales(s.vtos, HOY).TOTAL;

describe('Cuentas a pagar (demo)', () => {
  it('cannot reach Supabase, is labelled as a demo and has no "Recibir cheque"', () => {
    for (const f of ['features/caja/pagarDemo.ts', 'features/caja/CuentasAPagarDemo.tsx', 'features/caja/CarteraChequesDemo.tsx']) {
      expect(SRC(f), f).not.toMatch(/supabase|useMutation|useQuery|\.rpc\(|target\/|useAuth/);
      expect(SRC(f), f).not.toContain('Recibir cheque');
    }
    expect(SRC('features/caja/CuentasAPagarDemo.tsx')).toContain('Vista de demostración · Datos ficticios');
    expect(SRC('features/caja/SolapaPagar.tsx')).not.toMatch(/Por proveedor|Cartera/);
  });
  it('groups and cards (each card filters the list; Sin fecha is a card)', () => {
    expect(['2026-11-12', '2026-11-13', '2026-11-15', '2026-11-16', '2026-12-01'].map((f) => grupo(f, HOY))).toEqual(['VENCIDO', 'SEMANA', 'SEMANA', 'MES', 'ADELANTE']);
    expect(grupo(null, HOY)).toBe('SIN_FECHA');
    expect(enTarjeta({ fecha: '2026-11-20' }, 'PROX7', HOY)).toBe(true);
    expect(enTarjeta({ fecha: '2026-11-21' }, 'PROX7', HOY)).toBe(false);
    expect(enTarjeta({ fecha: null }, 'SIN_FECHA', HOY)).toBe(true);
    const t = totales(semillaDemo(HOY).vtos, HOY);
    expect(t.SIN_FECHA).toBe(180_000);
    expect(t.TOTAL).toBeGreaterThanOrEqual(t.VENCIDO + t.PROX30 + t.SIN_FECHA - 0.01);
  });
  it('one form: paid (account) or pending (plan); a cheque needs a supplier', () => {
    const base: NuevoGasto = { concepto: 'X', proveedorId: null, categoria: 'Otros', fecha: HOY, total: 1000, comprobante: null, pagado: null, vtos: [{ tipo: 'PAGO', fecha: null, importe: 1000 }] };
    expect(validarGasto(base)).toBeNull();   // pending, without supplier and without date
    expect(validarGasto({ ...base, pagado: { medio: 'CASH', cuenta: 'Caja efectivo', fecha: HOY }, vtos: [] })).toBeNull();
    expect(validarGasto({ ...base, vtos: [{ tipo: 'ECHEQ', fecha: HOY, importe: 1000, numero: 'E1' }] })).toMatch(/proveedor/);
    expect(validarPlan(1000, [{ tipo: 'CUOTA', fecha: HOY, importe: 400 }], null)).toMatch(/sumar el total/);
    const s = agregarGasto(semillaDemo(HOY), { ...base, pagado: { medio: 'CASH', cuenta: 'Caja efectivo', fecha: HOY }, vtos: [] }, 'nx', A);
    expect(totalAbierto(s)).toBe(totalAbierto(semillaDemo(HOY)));   // a paid expense is not pending
  });
  it('instalments add up; monthly keeps the day or the month end', () => {
    const c = repartirCuotas(100_000, 3, '2026-01-31', 'MENSUAL');
    expect(c.map((x) => x.fecha)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(c.reduce((t, x) => t + x.importe, 0)).toBeCloseTo(100_000, 2);
  });
  it('a payment goes to the chosen item only (partial allowed, never more than pending)', () => {
    const s = semillaDemo(HOY);
    const r = pagarVto(s, 'g1-3', 500_000, 'TRANSFER', 'BNA', A);
    expect(pendiente(r.vtos.find((v) => v.id === 'g1-3')!)).toBe(550_000);
    expect(r.vtos.find((v) => v.id === 'g1-2')!.pagado).toBe(0);
    expect(() => pagarVto(s, 'g1-3', 2_000_000, 'TRANSFER', 'BNA', A)).toThrow();
    expect(r.gastos.find((g) => g.id === 'g1')!.historial.at(-1)!.que).toMatch(/Cuota 3\/4/);
  });
  it('paying with an own cheque turns that part into a cheque to be debited; no supplier → refused', () => {
    const s = semillaDemo(HOY);
    const r = pagarConCheque(s, 'g5-1', { tipo: 'ECHEQ', numero: 'E-1', cuenta: 'BNA', fecha: '2026-12-01', importe: 100_000 }, A);
    const propios = r.vtos.filter((v) => v.gastoId === 'g5');
    expect(propios.map((v) => [v.tipo, v.importe])).toEqual([['PAGO', 115_000], ['ECHEQ', 100_000]]);
    expect(totalAbierto(r)).toBe(totalAbierto(s));   // still to leave the bank
    expect(() => pagarConCheque(s, 'g6-1', { tipo: 'CHEQUE', numero: '1', cuenta: 'BNA', fecha: HOY, importe: 1000 }, A)).toThrow('CHEQUE_SIN_PROVEEDOR');
  });
  it('change of payment plan after recording: only what is open (paid parts and cheques stay)', () => {
    const s = pagarVto(semillaDemo(HOY), 'g5-1', 15_000, 'CASH', 'Caja efectivo', A);
    expect(abiertoReplanificable(s, 'g5')).toBe(200_000);
    const r = replanificar(s, 'g5', repartirCuotas(200_000, 2, '2026-12-01', 'MENSUAL').map((c) => ({ tipo: 'CUOTA' as const, ...c })), A);
    const propios = r.vtos.filter((v) => v.gastoId === 'g5');
    expect(propios.map((v) => [v.tipo, v.importe, v.pagado])).toEqual([['PAGO', 15_000, 15_000], ['CUOTA', 100_000, 0], ['CUOTA', 100_000, 0]]);
    expect(totalAbierto(r)).toBe(totalAbierto(s));
  });
  it('pencil edits: Rectificado + who / before / after / reason in the history; totals stay consistent', () => {
    const s = semillaDemo(HOY);
    const g = s.gastos.find((x) => x.id === 'g5')!;
    expect(() => editarGasto(s, 'g5', { ...g, total: 250_000 }, '', A)).toThrow(/motivo/);
    const r = editarGasto(s, 'g5', { ...g, total: 250_000 }, 'factura corregida', A);
    const g2 = r.gastos.find((x) => x.id === 'g5')!;
    expect(g2.rectificado).toBe(true);
    expect(g2.historial.at(-1)).toMatchObject({ quien: 'admin@demo', que: 'Total', motivo: 'factura corregida' });
    expect(r.vtos.filter((v) => v.gastoId === 'g5').reduce((t, v) => t + v.importe, 0)).toBe(250_000);
    expect(() => editarGasto(s, 'g2', { ...s.gastos.find((x) => x.id === 'g2')!, proveedorId: null }, 'x', A)).toThrow(/cheques/);
    const v = editarVto(s, 'g2-1', { fecha: '2026-11-20', importe: 925_000 }, 'el proveedor pidió otra fecha', A);
    expect(v.vtos.find((x) => x.id === 'g2-1')!.fecha).toBe('2026-11-20');
    expect(() => editarVto(s, 'g2-1', { fecha: '2026-11-20', importe: 1 }, 'x', A)).toThrow(/cheque/);
    const imp = editarVto(s, 'g7-2', { fecha: s.vtos.find((x) => x.id === 'g7-2')!.fecha, importe: 50_000 }, 'ajuste', A);
    expect(imp.gastos.find((x) => x.id === 'g7')!.total).toBe(97_500);
  });
  it('endorsing a client cheque lowers the chosen item; the excess stays in the supplier\'s favour', () => {
    const s = semillaDemo(HOY);
    const r = endosar(s, 'c2', 'g5-1', A);   // 520.000 against 215.000
    expect(pendiente(r.s.vtos.find((v) => v.id === 'g5-1')!)).toBe(0);
    expect(r.aFavor).toBe(305_000);
    expect(resumenProveedor(r.s, 'p5', HOY).aFavor).toBe(305_000);
    expect(r.s.cartera.find((c) => c.id === 'c2')!.estado).toBe('ENDOSADO');
    expect(() => endosar(r.s, 'c2', 'g1-2', A)).toThrow();   // already endorsed
    expect(() => endosar(s, 'c1', 'g6-1', A)).toThrow();     // no supplier
  });
});
