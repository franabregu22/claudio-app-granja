import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modulesFor } from '../../src/target/roles';
import {
  SESSION_CASH_EVENT_TYPES, closeSalesSession, listSessionCash, openSalesSession, registerSessionCashEvent, registerSessionMovement,
} from '../../src/target/feria';
import { firstOfMonth, payFiscalObligation, registerFiscalDocument, registerFiscalObligation } from '../../src/target/fiscal';

/** PostgREST-shaped stub recording every read / rpc, answering from a queue. */
function stub(results: { data: unknown; error: unknown }[] = []) {
  const calls: { kind: string; table?: string; fn?: string; args?: any }[] = [];
  const next = () => results.shift() ?? { data: {}, error: null };
  const client = {
    from(table: string) {
      const q: any = {
        select: () => q, eq: () => q, gte: () => q, lte: () => q, order: () => q, limit: () => q,
        then: (res: (v: unknown) => void) => { calls.push({ kind: 'select', table }); res(next()); },
      };
      return q;
    },
    rpc: async (fn: string, args: unknown) => { calls.push({ kind: 'rpc', fn, args }); return next(); },
  };
  return { client: client as never, calls };
}

describe('F27-F Feria data layer', () => {
  it('open / movement / cash event / close send exactly the contract arguments', async () => {
    const { client, calls } = stub();
    await openSalesSession(client, { date: '2026-09-30', location: 'Plaza', idempotencyKey: 'FERIA-1', openingFund: 5000, cashAccountId: 'a' });
    await registerSessionMovement(client, { sessionId: 's', type: 'LOSS', productoId: 'p', cantidad: 2, reason: 'rotos' });
    await registerSessionCashEvent(client, { sessionId: 's', type: 'COUNT', amount: 4000 });
    await closeSalesSession(client, { sessionId: 's', lines: [{ producto_id: 'p', cantidad: 30, precio_unitario: 1000, subtotal: 30000 } as never] });
    expect(calls).toEqual([
      { kind: 'rpc', fn: 'open_sales_session', args: { p_session_date: '2026-09-30', p_location: 'Plaza', p_idempotency_key: 'FERIA-1', p_opening_fund: 5000, p_cash_account_id: 'a' } },
      { kind: 'rpc', fn: 'register_session_movement', args: { p_session_id: 's', p_movement_type: 'LOSS', p_producto_id: 'p', p_cantidad: 2, p_reason: 'rotos' } },
      { kind: 'rpc', fn: 'register_session_cash_event', args: {
        p_session_id: 's', p_event_type: 'COUNT', p_amount: 4000, p_financial_account_id: null, p_expense_category_id: null, p_destination_account_id: null, p_reason: null } },
      { kind: 'rpc', fn: 'close_sales_session', args: { p_session_id: 's', p_aggregated_lines: [{ producto_id: 'p', cantidad: 30, precio_unitario: 1000 }], p_reason: null } },
    ]);
  });

  it('the opening fund is not a cash event (only open_sales_session registers it)', () => {
    expect([...SESSION_CASH_EVENT_TYPES]).toEqual(['EXPENSE', 'WITHDRAWAL', 'TRANSFER_OUT', 'COUNT']);
  });

  it('expected cash and variance are read from report_feria_session_cash as reported', async () => {
    const { client, calls } = stub([{ data: [{
      sales_session_id: 's', business_date: '2026-09-30', location: 'Plaza', estado: 'OPEN', opening_fund: '5000', expenses: '300', withdrawals: '1000',
      transfers_out: '0', expected_cash: '3700', count_events: 1, count_event_id: 9, count_date: '2026-09-30', counted_cash: '4000', variance: '300',
    }], error: null }]);
    const [r] = await listSessionCash(client, '2026-09-01', '2026-09-30');
    expect(calls[0].table).toBe('report_feria_session_cash');
    expect(r).toMatchObject({ expected_cash: 3700, counted_cash: 4000, variance: 300 });
  });
});

describe('F27-F fiscal data layer', () => {
  it('document / obligation / payment send exactly the contract arguments; no installments = null', async () => {
    const { client, calls } = stub();
    await registerFiscalDocument(client, {
      type: 'INVOICE_A', direction: 'CREDITO', date: '2026-09-30', fiscalPeriod: '2026-09-01', netAmount: 1000, totalAmount: 1210,
      components: [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 1000, rate_applied: 21, tax_amount: 210 }], supplierId: 'sup', externalNumber: ' ',
    });
    await registerFiscalObligation(client, { taxKind: 'IVA', fiscalPeriod: '2026-09-01', amount: 900, installments: [] });
    await payFiscalObligation(client, { obligationId: 'o', date: '2026-09-30', amount: 450, accountId: 'b', idempotencyKey: 'FISC-1' });
    expect(calls[0]).toMatchObject({ fn: 'register_fiscal_document', args: { p_supplier_id: 'sup', p_cliente_id: null, p_external_number: null, p_fiscal_period: '2026-09-01' } });
    expect(calls[1]).toMatchObject({ fn: 'register_fiscal_obligation', args: { p_installments: null, p_due_date: null } });
    expect(calls[2]).toMatchObject({ fn: 'pay_fiscal_obligation', args: { p_idempotency_key: 'FISC-1', p_installment_id: null } });
  });

  it('firstOfMonth builds the contract fiscal period', () => {
    expect(firstOfMonth('2026-09-30')).toBe('2026-09-01');
  });

  it('[ADR-009] Feria and Fiscal are ADMIN modules only; OPERATOR gets neither', () => {
    expect(modulesFor('ADMIN')).toEqual(expect.arrayContaining(['feria', 'fiscal']));
    expect(modulesFor('OPERATOR')).not.toContain('feria');
    expect(modulesFor('OPERATOR')).not.toContain('fiscal');
  });
});

describe('F27-F files carry no legacy authority and do not restore the general cash count', () => {
  const SRC = resolve(__dirname, '../../src');
  const FILES = ['target/feria.ts', 'target/fiscal.ts', 'features/feria/useFeriaFiscal.ts', 'features/feria/FeriaApp.tsx', 'features/fiscal/FiscalApp.tsx'];

  it.each(FILES)('%s: no legacy table / role, no direct PostgREST write, no general arqueo, no external fiscal call, no cash arithmetic', (f) => {
    const text = readFileSync(resolve(SRC, f), 'utf8');
    for (const n of ['arqueos_caja', 'cuentas_caja', 'movimientos_caja', 'facturas', 'pagos', 'dueño', 'colaborador', 'repartidor']) {
      expect(text).not.toMatch(new RegExp(`['"\`]${n}['"\`]`));
    }
    expect(text).not.toMatch(/(?<!Array)\.from\(/);
    expect(text).not.toMatch(/\.(insert|update|delete|upsert)\(/);
    expect(text).not.toMatch(/useArqueos|api\/arqueos|FormArqueo|HistorialArqueos/);
    expect(text).not.toMatch(/fetch\(|afip\.gob|arca\.gob|wsfe|wsaa/i);   // no external fiscal service call or endpoint
    // expected cash / variance are view columns: no local fund − expenses − withdrawals arithmetic
    expect(text).not.toMatch(/opening_fund\s*-|expected_cash\s*[-+]|counted_cash\s*-/);
  });

  it('the retired general cash-count code is still absent', () => {
    for (const f of ['api/arqueos.ts', 'hooks/useArqueos.ts', 'features/caja/ArqueoCard.tsx', 'features/caja/FormArqueo.tsx', 'features/caja/HistorialArqueos.tsx']) {
      expect(existsSync(resolve(SRC, f)), f).toBe(false);
    }
  });
});
