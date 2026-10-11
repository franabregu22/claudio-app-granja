/**
 * ADR-018 — imported bank history inside Caja (account → Movimientos bancarios). The real supabase-js client is used
 * with a recording fetch, so the assertions are on the actual requests. Bank lines are evidence: the history reads only
 * fin_statement_line_status and never financial_posting / the ERP balance; it offers no reconciliation action.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  bankHistoryStatus, canMatch, CUTOVER_NOTICE, listBankHistory, needsCutoverNotice, type StatementLine,
} from '../../src/target/bankReconciliation';
import { listAccountPostings, listLedgerBalances } from '../../src/target/treasury';

function harness(routes: Record<string, unknown>) {
  const seen: URL[] = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    seen.push(url);
    const key = Object.keys(routes).find((k) => url.pathname.endsWith(k));
    return new Response(JSON.stringify(key ? routes[key] : []), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: createClient('http://127.0.0.1:54321', 'anon-key', { global: { fetch: fetchImpl as typeof fetch }, auth: { persistSession: false } }), seen };
}
const line = (over: Partial<StatementLine>): StatementLine => ({
  statement_line_id: 1, financial_account_id: 'bna', value_date: '2025-10-03', description_raw: 'DEBIN', bank_reference: '412', fecha_valor: null,
  signed_amount: 100, running_balance: 1000, active_cutover_id: null, cutoff_statement_line_id: null, opening_balance: null,
  cutover_classification: 'CUTOVER_UNRESOLVED', active_match_id: null, financial_operation_id: null, financial_posting_id: null, matched_at: null,
  match_reason: null, reconciliation_status: 'UNMATCHED', ...over,
});
const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');

describe('ADR-018 bank history in Caja — statuses', () => {
  it('readable status for every class', () => {
    expect(bankHistoryStatus(line({ cutover_classification: 'CUTOVER_UNRESOLVED' }))).toBe('Corte pendiente');
    expect(bankHistoryStatus(line({ cutover_classification: 'PRE_CUTOVER' }))).toBe('Histórico');
    expect(bankHistoryStatus(line({ cutover_classification: 'POST_CUTOVER', reconciliation_status: 'UNMATCHED' }))).toBe('Pendiente de conciliar');
    expect(bankHistoryStatus(line({ cutover_classification: 'POST_CUTOVER', reconciliation_status: 'MATCHED', active_match_id: 3 }))).toBe('Conciliado');
    expect(bankHistoryStatus(line({ cutover_classification: 'CUTOVER_AMBIGUOUS_DAY' }))).toBe('Revisar corte');
    expect(bankHistoryStatus(line({ cutover_classification: null }))).toBe('Sin clasificar');
  });
  it('an account without a cut shows the discreet notice; with a cut it does not', () => {
    expect(needsCutoverNotice([line({}), line({ statement_line_id: 2 })])).toBe(true);
    expect(needsCutoverNotice([line({ cutover_classification: 'PRE_CUTOVER' }), line({ cutover_classification: 'POST_CUTOVER' })])).toBe(false);
    expect(needsCutoverNotice([])).toBe(false);
    expect(CUTOVER_NOTICE).toBe('Estos movimientos provienen del extracto bancario. Todavía no se definió desde qué punto comienza la conciliación.');
  });
  it('no reconciliation is possible on CUTOVER_UNRESOLVED / PRE_CUTOVER lines', () => {
    expect(canMatch(line({ cutover_classification: 'CUTOVER_UNRESOLVED' }))).toBe(false);
    expect(canMatch(line({ cutover_classification: 'PRE_CUTOVER' }))).toBe(false);
  });
});

describe('ADR-018 bank history in Caja — data', () => {
  it('account without a cut and with statement lines: every line is returned (no class / match filter), newest first', async () => {
    const rows = [line({ statement_line_id: 2, value_date: '2026-09-30' }), line({ statement_line_id: 1, value_date: '2025-10-03' })];
    const { client, seen } = harness({ '/rest/v1/fin_statement_line_status': rows });
    const got = await listBankHistory(client, 'bna');
    expect(got.map((l) => [l.statement_line_id, bankHistoryStatus(l)])).toEqual([[2, 'Corte pendiente'], [1, 'Corte pendiente']]);
    const q = seen[0].searchParams;
    expect(seen[0].pathname).toBe('/rest/v1/fin_statement_line_status');
    expect([q.get('financial_account_id'), q.get('cutover_classification'), q.get('reconciliation_status'), q.get('limit')]).toEqual(['eq.bna', null, null, '2000']);
    expect(q.get('order')).toBe('value_date.desc,statement_line_id.desc');
  });
  it('PRE_CUTOVER lines (historical statements before the ERP start) stay visible as Histórico', async () => {
    const { client } = harness({ '/rest/v1/fin_statement_line_status': [line({ cutover_classification: 'PRE_CUTOVER' }), line({ statement_line_id: 2, cutover_classification: 'POST_CUTOVER' })] });
    expect((await listBankHistory(client, 'bna')).map(bankHistoryStatus)).toEqual(['Histórico', 'Pendiente de conciliar']);
  });
  it('imported lines never touch the ERP balance: the history reads only the bank read model; the balance stays report_balance_period', async () => {
    const h = harness({});
    await listBankHistory(h.client, 'bna');
    expect(h.seen.map((u) => u.pathname)).toEqual(['/rest/v1/fin_statement_line_status']);
    const b = harness({ '/rest/v1/report_balance_period': [{ entity_id: 'bna', entity_name: 'BNA', period: '2026-10-01', closing_balance: 500 }] });
    expect((await listLedgerBalances(b.client, 'ACCOUNT'))[0].balance).toBe(500);
    expect(b.seen.map((u) => u.pathname)).toEqual(['/rest/v1/report_balance_period']);
    const p = harness({ '/rest/v1/financial_posting': [{ id: 1, effective_date: '2026-10-05', signed_amount: '100.00', financial_operation: { operation_type: 'TRANSFER', external_ref: 'T-1', reason: null } }] });
    expect(await listAccountPostings(p.client, 'bna')).toEqual([{ id: 1, effective_date: '2026-10-05', signed_amount: 100, operation_type: 'TRANSFER', external_ref: 'T-1', reason: null }]);
    expect(p.seen[0].searchParams.get('financial_account_id')).toBe('eq.bna');
  });
});

describe('ADR-018 bank history in Caja — screen', () => {
  const detalle = SRC('features/caja/CuentaDetalle.tsx');
  it('Caja → Saldos opens an account; its detail has ERP and bank tabs (bank tab only for bank accounts)', () => {
    const saldos = SRC('features/caja/ResumenSaldos.tsx');
    expect(saldos).toMatch(/<CuentaDetalle key=\{c\.id\} cuenta=\{c\} saldo=\{porCuenta\.get\(c\.id\)\?\.balance \?\? null\}/);
    expect(saldos).toMatch(/useLedgerBalances\('ACCOUNT'\)/);   // the ERP balance source is unchanged
    expect(detalle).toMatch(/\['erp', 'Movimientos ERP'\], \.\.\.\(esBanco \? \[\['banco', 'Movimientos bancarios'\]\] : \[\]\)/);
    expect(detalle).toMatch(/const esBanco = cuenta\.account_type === 'BANK_ACCOUNT'/);
  });
  it('the bank history is read-only: no write, no RPC, no reconciliation or cut action', () => {
    expect(detalle).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|useReconciliationMutations|useTreasuryMutations|matchStatementLine|resolveStatementCutover/);
    expect(detalle).not.toMatch(/>Conciliar<|Definir corte|Revertir conciliación/);
    expect(detalle).toMatch(/needsCutoverNotice\(lineas\) && .*CUTOVER_NOTICE/);
    expect(detalle).toMatch(/no modifican el saldo ERP/);
  });
});
