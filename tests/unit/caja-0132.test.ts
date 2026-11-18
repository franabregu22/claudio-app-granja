/** 0132 (owner 2026-11-18): short concepts — the Mercado Pago outflow to classify no longer carries its SOURCE_ID in the concept;
 *  the cell reads it from the row's own key first (the old long concept stays a fallback). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { retiroAnulable, retiroAnulado } from '../../src/target/operations';

const src = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');

describe('0132 — Mercado Pago outflow classified from its cell', () => {
  it('the SOURCE_ID comes from mp_source_id first, then the old concept', () => {
    expect(src('features/caja/EdicionEnFila.tsx')).toMatch(/const delConcepto = r\.mp_source_id \?\? \/\\\(\(\\d\{6,20\}\)\[,\)\]\/\.exec\(r\.concepto\)/);
  });
  it('the row type carries the optional key', () => {
    expect(src('target/operations.ts')).toMatch(/mp_source_id\?: string \| null;/);
  });
});

describe('0133 — partner withdrawal: the socio from the row', () => {
  const celda = src('features/caja/EdicionEnFila.tsx');
  const tabla = src('features/caja/TodasLasOperaciones.tsx');
  it('classifying a Mercado Pago outflow as a withdrawal asks which socio (one option per socio)', () => {
    expect(celda).toMatch(/value=\{`RETIRO:\$\{x\.id\}`\}>Retiro · \{x\.nombre\}/);
    expect(celda).not.toMatch(/value="RETIRO">Retiro de socios/);
    expect(celda).toMatch(/setSocio\.mutateAsync\(\{ operationId: res\.financial_operation_id, socioId: v\.slice\(7\) \}\)/);
  });
  it('a withdrawal row: Categoría «Retiros de socios», Subcategoría its socio or «Sin socio», editable with a double click', () => {
    expect(tabla).toMatch(/retiro \? 'Retiros de socios'/);
    expect(tabla).toMatch(/>Sin socio<\/span>/);
    expect(tabla).toMatch(/\(clasificable \|\| retiro\) && campo === 'categoria'/);
    expect(celda).toMatch(/if \(socioEditableEnFila\(r\) && campo === 'categoria'\) return <SocioCelda/);
  });
});

describe('Anular retiro (owner 2026-11-18)', () => {
  const base = {
    row_key: 'OP:1', row_kind: 'OP', date: '2026-11-17', created_at: null, tipo: 'EGRESO', amount: -20000, estado: 'COMPLETADA', concepto: 'Retiro',
    detalle: '', operation_id: 1, ref_uuid: null, ref_id: null, accounts: [{ account_id: 'caja' }], retiro: { event_id: 'ev', socio_id: null },
  } as unknown as Parameters<typeof retiroAnulable>[0];
  const cuentas = [{ id: 'caja', account_type: 'CASH' }, { id: 'mp', account_type: 'EXTERNAL_SERVICE' }] as unknown as Parameters<typeof retiroAnulable>[1];
  it('a cash / bank withdrawal not given back can be annulled; fully given back it reads «anulado»', () => {
    expect(retiroAnulable(base, cuentas, new Map())).toBe(true);
    expect(retiroAnulable(base, cuentas, new Map([['ev', 5000]]))).toBe(true);   // the rest
    expect(retiroAnulado(base, new Map([['ev', 20000]]))).toBe(true);
    expect(retiroAnulable(base, cuentas, new Map([['ev', 20000]]))).toBe(false);
  });
  it('a Mercado Pago withdrawal, a non-withdrawal row or unknown compensations: no button', () => {
    expect(retiroAnulable({ ...base, accounts: [{ account_id: 'mp' }] } as typeof base, cuentas, new Map())).toBe(false);
    expect(retiroAnulable({ ...base, retiro: null } as typeof base, cuentas, new Map())).toBe(false);
    expect(retiroAnulable(base, cuentas, undefined)).toBe(false);
  });
});
