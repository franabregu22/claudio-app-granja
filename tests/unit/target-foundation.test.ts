import { describe, expect, it } from 'vitest';
import { canSeeModule, modulesFor, parseAppRole } from '../../src/target/roles';
import { DIRECT_WRITES, normalizeDbError, TargetDbError, writeTable } from '../../src/target/db';

describe('role model (P27-D3)', () => {
  it('accepts only the two target roles', () => {
    expect(parseAppRole('ADMIN')).toBe('ADMIN');
    expect(parseAppRole('OPERATOR')).toBe('OPERATOR');
    for (const legacy of ['dueño', 'colaborador', 'repartidor', 'admin', '', null, undefined]) expect(parseAppRole(legacy)).toBeNull();
  });
  it('ADMIN sees every module; OPERATOR only the production working set; no role sees nothing', () => {
    expect(modulesFor('ADMIN')).toEqual(['dashboard_produccion', 'produccion', 'clasificacion', 'alimento', 'pedidos', 'cobros', 'caja', 'feria', 'fiscal', 'mercadopago', 'finanzas', 'admin']);
    expect(modulesFor('OPERATOR')).toEqual(['produccion', 'clasificacion', 'alimento']);   // owner decision 2026-10-04: no Dashboard
    expect(modulesFor(null)).toEqual([]);
  });
  it('OPERATOR never gets an ADMIN-only module', () => {
    // F27-E: the production dashboard joined the OPERATOR working set (plan §2 row 3: assigned flocks only, RLS)
    for (const m of ['pedidos', 'cobros', 'caja', 'feria', 'fiscal', 'mercadopago', 'finanzas', 'admin'] as const) {
      expect(canSeeModule('OPERATOR', m)).toBe(false);
      expect(canSeeModule(null, m)).toBe(false);
    }
  });
});

describe('data-access primitives', () => {
  it('normalizes contract errors to their code', () => {
    expect(normalizeDbError({ message: 'PERIOD_CLOSED: period 2026-11-01 is CLOSED' }).code).toBe('PERIOD_CLOSED');
    expect(normalizeDbError({ message: 'FORBIDDEN: ADMIN required' }).code).toBe('FORBIDDEN');
    expect(normalizeDbError({ message: 'permission denied for table x', code: '42501' }).code).toBe('PERMISSION_DENIED');
    expect(normalizeDbError({ message: 'something else' }).code).toBe('DB_ERROR');
  });
  it('refuses a direct write that is not in the target allow-list, before any request', async () => {
    const client = { from: () => { throw new Error('must not reach the network'); } } as never;
    await expect(writeTable(client, 'pedido_lineas', 'update' as never, {})).rejects.toBeInstanceOf(TargetDbError);
    expect(DIRECT_WRITES.pedido_lineas).toEqual(['insert', 'delete']);
  });
});
