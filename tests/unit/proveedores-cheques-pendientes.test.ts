import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NO_CHEQUES, supplierChequeSummary, supplierState, type InstrumentRow } from '../../src/target/treasury';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
type I = Pick<InstrumentRow, 'direction' | 'supplier_id' | 'estado' | 'amount'>;
const own = (supplier_id: string, estado: InstrumentRow['estado'], amount: number): I => ({ direction: 'ISSUED', supplier_id, estado, amount });

describe('Proveedores — cheques pendientes de débito, aparte de la deuda', () => {
  it('Agropecuaria Centenario: deuda 0, 253/254 debitados 600.000, 255/256 pendientes 600.000 → "Cheques pendientes"', () => {
    const s = supplierChequeSummary([own('cen', 'DEBITED', 300000), own('cen', 'DEBITED', 300000), own('cen', 'ISSUED', 300000), own('cen', 'ISSUED', 300000)]).get('cen')!;
    expect(s).toEqual({ pending: 600000, pendingCount: 2, debited: 600000, debitedCount: 2 });
    expect(supplierState(0, s)).toBe('CHEQUES_PENDIENTES');
  });
  it('anulados y rechazados no cuentan; cheques de terceros endosados no son propios', () => {
    const m = supplierChequeSummary([
      own('a', 'CANCELLED', 100), own('a', 'REJECTED', 200), own('a', 'ISSUED', 50),
      { direction: 'RECEIVED', supplier_id: null, estado: 'ENDORSED', amount: 999 }, { direction: 'ISSUED', supplier_id: null, estado: 'ISSUED', amount: 7 },
    ]);
    expect(m.get('a')).toEqual({ pending: 50, pendingCount: 1, debited: 0, debitedCount: 0 });
    expect(m.size).toBe(1);
    expect(supplierChequeSummary([own('b', 'CANCELLED', 100)]).has('b')).toBe(false);
  });
  it('estados: deuda y saldo a favor no cambian; sin deuda ni cheques pendientes sigue "Al día"', () => {
    const pend = { ...NO_CHEQUES, pending: 10, pendingCount: 1 };
    expect(supplierState(500, pend)).toBe('DEUDA');
    expect(supplierState(-500, pend)).toBe('A_FAVOR');
    expect(supplierState(0, { ...NO_CHEQUES, debited: 600000, debitedCount: 2 })).toBe('AL_DIA');
    expect(supplierState(0, NO_CHEQUES)).toBe('AL_DIA');
  });
  it('la lista muestra los tres importes por proveedor sin sumar los pendientes a la deuda', () => {
    const t = SRC('features/caja/CuentasAPagar.tsx');
    for (const s of ['Deuda sin cubrir:', 'Cheques pendientes de débito:', 'Cheques debitados:', "'Cheques pendientes'"]) expect(t).toContain(s);
    expect(t).toMatch(/<ImportesProveedor balance=\{c\.balance\} cheques=\{ch\} \/>/);
    expect(t).toMatch(/const deuda = Math\.max\(balance, 0\);/);
    expect(t).toMatch(/useInstruments\(\)/);
  });
  it('la ficha conserva el detalle y los estados especiales (anulado, rechazado, debitado antes del corte)', () => {
    const f = SRC('features/caja/FichaProveedor.tsx');
    for (const s of ["CANCELLED: 'Anulado'", "REJECTED: 'Rechazado'", "'Debitado antes del corte'", "ISSUED: 'Pendiente de débito'"]) expect(f).toContain(s);
    expect(f).toMatch(/<th className=\{TH\}>Número<\/th><th className=\{`\$\{TH\} text-right`\}>Importe<\/th>/);
  });
});
