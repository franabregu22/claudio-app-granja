import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modulesFor } from '../../src/target/roles';
import { PNL_LINES, listPnlLineItems, listPnlSummary, registerManagementEvent } from '../../src/target/pnl';

/** PostgREST-shaped stub recording every read / rpc, answering from a queue. */
function stub(results: { data: unknown; error: unknown }[] = []) {
  const calls: { kind: string; table?: string; fn?: string; args?: any; filters: unknown[] }[] = [];
  const next = () => results.shift() ?? { data: {}, error: null };
  const client = {
    from(table: string) {
      const filters: unknown[] = [];
      const q: any = {
        select: () => q, eq: (...a: unknown[]) => { filters.push(['eq', ...a]); return q; }, gte: (...a: unknown[]) => { filters.push(['gte', ...a]); return q; },
        lte: (...a: unknown[]) => { filters.push(['lte', ...a]); return q; }, order: () => q, limit: () => q,
        then: (res: (v: unknown) => void) => { calls.push({ kind: 'select', table, filters }); res(next()); },
      };
      return q;
    },
    rpc: async (fn: string, args: unknown) => { calls.push({ kind: 'rpc', fn, args, filters: [] }); return next(); },
  };
  return { client: client as never, calls };
}

describe('F27-G P&L data layer', () => {
  it('the monthly P&L is pnl_summary for the selected periods, every column as reported (no recomputation)', async () => {
    const row = Object.fromEntries([['period', '2026-09-01'], ...PNL_LINES.map(([c], i) => [c, String(i * 10)])]);
    const { client, calls } = stub([{ data: [row], error: null }]);
    const [r] = await listPnlSummary(client, '2026-07-01', '2026-09-01');
    expect(calls[0]).toMatchObject({ table: 'pnl_summary', filters: [['gte', 'period', '2026-07-01'], ['lte', 'period', '2026-09-01']] });
    PNL_LINES.forEach(([c], i) => expect(r[c]).toBe(i * 10));
    expect(PNL_LINES).toHaveLength(15);
    expect(PNL_LINES.map(([c]) => c).slice(2, 5)).toEqual(['costos_indirectos', 'diferencia_caja', 'resultado_operativo']);   // ADR-016
  });

  it('the drill-down is pnl_line_item of one period', async () => {
    const { client, calls } = stub([{ data: [{ bucket: 'RETIROS', signed_amount: '-1500', period: '2026-09-01' }], error: null }]);
    const [i] = await listPnlLineItems(client, '2026-09-01');
    expect(calls[0]).toMatchObject({ table: 'pnl_line_item', filters: [['eq', 'period', '2026-09-01']] });
    expect(i.signed_amount).toBe(-1500);
  });

  it('management events send exactly the RPC 43 arguments', async () => {
    const { client, calls } = stub();
    await registerManagementEvent(client, { type: 'RESERVA_INTERNA', effectiveDate: '2026-09-30', amount: 800, idempotencyKey: 'GEST-1', reason: 'r' });
    expect(calls[0]).toEqual({ kind: 'rpc', fn: 'register_management_event', filters: [], args: {
      p_event_type: 'RESERVA_INTERNA', p_effective_date: '2026-09-30', p_amount: 800, p_idempotency_key: 'GEST-1', p_reason: 'r',
      p_financial_account_id: null, p_compensates_event_id: null,
    } });
  });

  it('Finanzas is an ADMIN module only', () => {
    expect(modulesFor('ADMIN')).toContain('finanzas');
    expect(modulesFor('OPERATOR')).not.toContain('finanzas');
  });
});

describe('F27-G files carry no legacy authority and no frontend accounting formula', () => {
  const SRC = resolve(__dirname, '../../src');
  const FILES = ['target/pnl.ts', 'features/finanzas/FinanzasApp.tsx', 'features/finanzas/TendenciaMeses.tsx'];

  it.each(FILES)('%s: no legacy table / hook, no direct write, no revenue − cost or cash-flow arithmetic', (f) => {
    const text = readFileSync(resolve(SRC, f), 'utf8');
    for (const n of ['movimientos_caja', 'pedidos', 'pagos', 'categorias_finanzas', 'dueño', 'colaborador', 'repartidor']) {
      expect(text).not.toMatch(new RegExp(`['"\`]${n}['"\`]`));
    }
    expect(text).not.toMatch(/(?<!Array)\.from\(/);
    expect(text).not.toMatch(/\.(insert|update|delete|upsert)\(/);
    expect(text).not.toMatch(/useMovimientosCaja|usePedidos|api\/(caja|pedidos)\b|monto_total|ingresos\s*-\s*egresos|ventas\w*\s*-\s*costo|margen|flujo/i);
    expect(text).not.toMatch(/\.reduce\(/);   // no summing of amounts: totals are view columns
  });

  it('the legacy P&L sources are gone and there is a single trend component', () => {
    for (const f of ['features/caja/PyL.tsx', 'features/caja/PyLProesional.tsx', 'api/caja.ts', 'hooks/useCaja.ts', 'api/pedidos.ts', 'hooks/usePedidos.ts',
      'features/caja/TendenciaMeses.tsx', 'features/caja/ResumenFlujoCaja.tsx']) {
      expect(existsSync(resolve(SRC, f)), f).toBe(false);
    }
    expect(readFileSync(resolve(SRC, 'features/caja/CajaApp.tsx'), 'utf8')).not.toMatch(/TendenciaMeses/);
  });
});
