import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIRECT_WRITES, normalizeDbError, TARGET_RPCS, TargetDbError, writeTable } from '../../src/target/db';
import { cleanValues, closeFlock, previousDay, registerFlock, setPrice, updateMaster } from '../../src/target/masters';
import { errorMessage } from '../../src/target/messages';

/** A minimal PostgREST-shaped stub: records the calls and answers with the queued results. */
function stubClient(results: { data: unknown; error: unknown }[]) {
  const calls: { table: string; op: string; payload?: unknown; match?: unknown }[] = [];
  const next = () => results.shift() ?? { data: [], error: null };
  const client = {
    from(table: string) {
      const q: any = {
        select: () => q,
        eq: () => q,
        is: () => q,
        order: () => q,
        insert: (payload: unknown) => { calls.push({ table, op: 'insert', payload }); return { select: async () => next() }; },
        update: (payload: unknown) => ({
          match: (match: unknown) => { calls.push({ table, op: 'update', payload, match }); return { select: async () => next() }; },
        }),
        then: (resolve: (v: unknown) => void) => { calls.push({ table, op: 'select' }); resolve(next()); },
      };
      return q;
    },
  };
  return { client: client as never, calls };
}

describe('F27-B master data layer', () => {
  it('previousDay closes a price the day before the new one (month / year boundaries)', () => {
    expect(previousDay('2026-10-01')).toBe('2026-09-30');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
  });

  it('cleanValues trims text and sends empty strings as NULL', () => {
    expect(cleanValues({ nombre: '  Cliente  ', fiscal_id: '', capacidad: 10, activo: false })).toEqual(
      { nombre: 'Cliente', fiscal_id: null, capacidad: 10, activo: false });
  });

  it('declarative constraint failures get stable codes and user messages', () => {
    expect(normalizeDbError({ code: '23505', message: 'duplicate key value' }).code).toBe('DUPLICATE');
    expect(normalizeDbError({ code: '23514', message: 'violates check constraint' }).code).toBe('CHECK_VIOLATION');
    expect(normalizeDbError({ code: '23503', message: 'violates foreign key constraint' }).code).toBe('FK_VIOLATION');
    expect(errorMessage({ code: '42501', message: 'new row violates row-level security policy' })).toMatch(/permiso/);
    expect(errorMessage(new TargetDbError('NOT_UPDATED', 'x'))).toMatch(/No se guardó/);
  });

  it('an UPDATE filtered out by RLS (zero rows) is NOT_UPDATED, never a silent success', async () => {
    const { client } = stubClient([{ data: [], error: null }]);
    const err = await updateMaster(client, 'clients', 'id-1', { nombre: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetDbError);
    expect(err.code).toBe('NOT_UPDATED');
  });

  it('masters have no delete path: the only delete grant is pedido_lineas', async () => {
    const withDelete = Object.entries(DIRECT_WRITES).filter(([, ops]) => (ops as readonly string[]).includes('delete')).map(([t]) => t);
    expect(withDelete).toEqual(['pedido_lineas']);
    const { client } = stubClient([]);
    await expect(writeTable(client, 'clients', 'delete' as never, null, { id: 'x' })).rejects.toMatchObject({ code: 'DIRECT_WRITE_NOT_ALLOWED' });
  });

  it('setPrice closes the current row, appends the new one, and reopens the old row if the append fails', async () => {
    const current = { id: 'p-1', producto_id: 'prod', price_list_type: 'MINORISTA', precio: 100, effective_from: '2026-09-01', effective_to: null };
    const ok = stubClient([
      { data: [current], error: null },                 // read current
      { data: [{ ...current, effective_to: '2026-09-30' }], error: null },   // close
      { data: [{ id: 'p-2' }], error: null },           // append
    ]);
    await setPrice(ok.client, { productId: 'prod', list: 'MINORISTA', precio: 120, effectiveFrom: '2026-10-01', userId: 'u' });
    expect(ok.calls.filter((c) => c.op !== 'select')).toEqual([
      { table: 'price_history', op: 'update', payload: { effective_to: '2026-09-30' }, match: { id: 'p-1' } },
      { table: 'price_history', op: 'insert', payload: { producto_id: 'prod', price_list_type: 'MINORISTA', precio: 120, effective_from: '2026-10-01', created_by: 'u' } },
    ]);

    const failing = stubClient([
      { data: [current], error: null },
      { data: [{ ...current, effective_to: '2026-09-30' }], error: null },
      { data: null, error: { code: '23514', message: 'violates check constraint' } },
      { data: [current], error: null },                 // reopen
    ]);
    const err = await setPrice(failing.client, { productId: 'prod', list: 'MINORISTA', precio: 120, effectiveFrom: '2026-10-01', userId: 'u' }).catch((e) => e);
    expect(err.code).toBe('CHECK_VIOLATION');
    expect(failing.calls.at(-1)).toEqual({ table: 'price_history', op: 'update', payload: { effective_to: null }, match: { id: 'p-1' } });
  });
});

describe('F27-B flock lifecycle goes through RPC 44 / 45 only (ADR-007)', () => {
  function rpcStub() {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: { ok: true }, error: null }; },
      from: () => { throw new Error('flocks must not be written directly'); },
    };
    return { client: client as never, calls };
  }

  it('registerFlock calls register_flock with trimmed optional fields and never touches the table', async () => {
    const { client, calls } = rpcStub();
    await registerFlock(client, { shedId: 's', entryDate: '2026-09-01', initialPopulation: 1000, geneticsLine: '  Hy-Line  ', birthDate: '', supplierId: '' });
    expect(calls).toEqual([{ fn: 'register_flock', args: {
      p_shed_id: 's', p_entry_date: '2026-09-01', p_initial_population: 1000, p_genetics_line: 'Hy-Line', p_birth_date: null, p_supplier_id: null, p_reason: null,
    } }]);
  });

  it('closeFlock calls close_flock with the exit date and reason', async () => {
    const { client, calls } = rpcStub();
    await closeFlock(client, { flockId: 'f', exitDate: '2026-09-20', reason: ' venta ' });
    expect(calls).toEqual([{ fn: 'close_flock', args: { p_flock_id: 'f', p_exit_date: '2026-09-20', p_reason: 'venta' } }]);
  });

  it('both RPCs are in the authorized executable set; flocks stay without a direct write grant', () => {
    expect(TARGET_RPCS).toContain('register_flock');
    expect(TARGET_RPCS).toContain('close_flock');
    expect(Object.keys(DIRECT_WRITES)).not.toContain('flocks');
    expect(errorMessage(new TargetDbError('SHED_OCCUPIED', ''))).toMatch(/lote activo/);
    expect(errorMessage(new TargetDbError('ACTIVITY_AFTER_FLOCK_EXIT', ''))).toMatch(/salida/);
  });
});

describe('F27-B migrated files use only the target', () => {
  const FILES = ['AdminApp', 'ClientesAdmin', 'PreciosAdmin', 'LotesAdmin', 'CategoriasAdmin', 'ProveedoresAdmin', 'CuentasAdmin',
    'AsignacionesAdmin', 'ProyectosAdmin', 'MasterEditor', 'useMasters'].map((f) => resolve(__dirname, '../../src/features/admin',
    `${f}.${f === 'useMasters' ? 'ts' : 'tsx'}`));
  const LEGACY = ['clientes', 'productos', 'precios_actuales', 'precios_historial', 'lotes', 'categorias_finanzas', 'movimientos_caja', 'dueño', 'colaborador', 'repartidor'];

  it.each(FILES)('%s: no legacy relation, legacy role, legacy hook or direct PostgREST call', (file) => {
    const text = readFileSync(file, 'utf8');
    for (const name of LEGACY) expect(text).not.toMatch(new RegExp(`['"\`]${name}['"\`]`));
    expect(text).not.toMatch(/\.from\(/);
    expect(text).not.toMatch(/\.(delete|upsert)\(/);
    expect(text).not.toMatch(/hooks\/use(Clientes|Productos|Precios|Lotes|Categorias)|api\/(clientes|precios|lotes|categorias)/);
  });
});
