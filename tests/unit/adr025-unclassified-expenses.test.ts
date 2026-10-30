/**
 * ADR-025 stage 3 (ERP migration 0101) — Caja → Gastos sin clasificar.
 * The screen reads ONLY the ADMIN view fin_expense_pending_classification and writes ONLY through classify_pending_expense:
 * no direct write to any financial table, no new operation / posting / payment from the frontend. The P&L shows the
 * GASTOS_SIN_CLASIFICAR line as a component of the operating result (never added again on the client).
 * The real supabase-js client is used with a recording fetch.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { DIRECT_WRITES, TARGET_RPCS, TARGET_VIEWS } from '../../src/target/db';
import { errorMessage } from '../../src/target/messages';
import { PNL_LINES, PNL_RESULT_LINES, listPnlSummary } from '../../src/target/pnl';
import { postingOperationLabel } from '../../src/target/pendingClassification';
import { modulesFor } from '../../src/target/roles';
import {
  classifyPendingExpense, classifyReady, countUnclassified, listPendingExpensesPage, originText, PENDING_EXPENSE_COLUMNS,
} from '../../src/target/unclassifiedExpenses';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const recording = (body: unknown, total = 0) => {
  const seen: { url: URL; method: string; headers: Headers; body: string }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), method: init?.method ?? 'GET',
      headers: new Headers(init?.headers), body: String(init?.body ?? '') });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'content-range': `0-0/${total}` } });
  }) as typeof fetch } });
  return { client, seen };
};
const ROW = { pending_id: '7', status: 'SIN_CLASIFICAR', economic_date: '2026-10-20', amount: '35000.00', financial_account_id: 'a', account_name: 'Caja chica',
  payment_method: 'CASH', concept: 'combustible', counterparty_name: null, origin: 'WHATSAPP', origin_ref: { draft_short_code: 'W-0042' }, payment_operation_id: '91',
  created_by: 'u1', created_at: '2026-10-20T12:00:00Z', purchase_id: null, expense_category_id: null, category_name: null, nature: null, classified_by: null, classified_at: null };
const ACC = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('ADR-025 stage 3 — data layer of Gastos sin clasificar', () => {
  it('the list: one page of fin_expense_pending_classification with the server count, server filters and the exact column contract', async () => {
    const { client, seen } = recording([ROW], 3);
    const r = await listPendingExpensesPage(client, { status: 'SIN_CLASIFICAR', from: '2026-10-01', to: '2026-10-31', accountId: ACC, origin: 'WHATSAPP' }, 1);
    expect([r.rows[0].pending_id, r.rows[0].amount, r.rows[0].payment_operation_id, r.total]).toEqual([7, 35000, 91, 3]);
    expect(seen.map((x) => [x.method, x.url.pathname])).toEqual([['GET', '/rest/v1/fin_expense_pending_classification']]);
    const q = seen[0].url.searchParams;
    expect([q.get('status'), q.get('origin'), q.get('financial_account_id'), q.get('order'), q.get('offset'), q.get('limit')])
      .toEqual(['eq.SIN_CLASIFICAR', 'eq.WHATSAPP', `eq.${ACC}`, 'economic_date.asc,pending_id.asc', '50', '50']);
    expect(q.getAll('economic_date')).toEqual(['gte.2026-10-01', 'lte.2026-10-31']);
    expect(q.get('select')).toBe(PENDING_EXPENSE_COLUMNS.replace(/\s+/g, ''));
    expect(seen[0].headers.get('prefer')).toMatch(/count=exact/);
  });

  it('filters that are not a date / uuid / known origin are dropped (never injected); "Todos" adds no status filter', async () => {
    const { client, seen } = recording([], 0);
    await listPendingExpensesPage(client, { status: 'ALL', from: '2026-10-01;drop', to: 'x', accountId: "a'),or(", origin: 'OTRO' as never }, 0);
    const q = seen[0].url.searchParams;
    expect([q.get('status'), q.get('economic_date'), q.get('financial_account_id'), q.get('origin'), q.get('order')])
      .toEqual([null, null, null, null, 'economic_date.desc,pending_id.desc']);
  });

  it('the indicator is a server count of SIN_CLASIFICAR (one id at most is downloaded)', async () => {
    const { client, seen } = recording([{ pending_id: 1 }], 12);
    expect(await countUnclassified(client)).toBe(12);
    const q = seen[0].url.searchParams;
    expect([seen[0].url.pathname, q.get('status'), q.get('select'), q.get('limit')]).toEqual(['/rest/v1/fin_expense_pending_classification', 'eq.SIN_CLASIFICAR', 'pending_id', '1']);
  });

  it('classify: ONLY the RPC classify_pending_expense with its named parameters; unchanged concept / counterparty are sent as null (kept)', async () => {
    const { client, seen } = recording({ pending_id: 7, purchase_id: 'p', payment_operation_id: 91, status: 'CLASIFICADO', replayed: false });
    await classifyPendingExpense(client, { pendingId: 7, expenseCategoryId: ACC, nature: 'OPERATING', concept: null, counterpartyName: null, reason: '  ' });
    await classifyPendingExpense(client, { pendingId: 7, expenseCategoryId: ACC, nature: 'INVESTMENT', concept: ' Gasoil tractor ', counterpartyName: '', reason: 'ok' });
    expect(seen.map((x) => [x.method, x.url.pathname])).toEqual([['POST', '/rest/v1/rpc/classify_pending_expense'], ['POST', '/rest/v1/rpc/classify_pending_expense']]);
    expect(JSON.parse(seen[0].body)).toEqual({ p_pending_id: 7, p_expense_category_id: ACC, p_nature: 'OPERATING', p_concept: null, p_counterparty_name: null, p_reason: null });
    expect(JSON.parse(seen[1].body)).toEqual({ p_pending_id: 7, p_expense_category_id: ACC, p_nature: 'INVESTMENT', p_concept: 'Gasoil tractor', p_counterparty_name: '', p_reason: 'ok' });
  });

  it('the form requires a subcategory id, a nature and a 1–100 character concept (incomplete data never reaches the RPC)', () => {
    expect(classifyReady({ expenseCategoryId: ACC, nature: 'OPERATING', concept: 'x' })).toBe(true);
    expect(classifyReady({ expenseCategoryId: '', nature: 'OPERATING', concept: 'x' })).toBe(false);
    expect(classifyReady({ expenseCategoryId: ACC, nature: '', concept: 'x' })).toBe(false);
    expect(classifyReady({ expenseCategoryId: ACC, nature: 'OPERATING', concept: '   ' })).toBe(false);
    expect(classifyReady({ expenseCategoryId: ACC, nature: 'OPERATING', concept: 'x'.repeat(101) })).toBe(false);
  });

  it('the origin shows the WhatsApp draft code, never a phone; the payment keeps a readable label in the account history', () => {
    expect(originText({ origin: 'WHATSAPP', origin_ref: { draft_short_code: 'W-0042' } })).toBe('WhatsApp W-0042');
    expect(originText({ origin: 'ERP', origin_ref: {} })).toBe('ERP');
    expect(postingOperationLabel({ operation_type: 'PURCHASE_PAYMENT', external_ref: 'EXPENSE-PENDING:7' })).toBe('Gasto (sin clasificar al registrarse)');
  });

  it('errors of the new contract read in Spanish', () => {
    expect(errorMessage({ message: 'CATEGORY_GROUP_INACTIVE: the category of this subcategory is inactive' })).toMatch(/categoría .* inactiva/);
    expect(errorMessage({ message: 'PENDING_EXPENSE_CLASSIFICATION: 2 egreso(s)' })).toMatch(/Gastos sin clasificar/);
    expect(errorMessage({ message: 'PERIOD_CLOSED' })).toBe('El período está cerrado.');
    expect(errorMessage({ message: 'FORBIDDEN: ADMIN required' })).toMatch(/administrador/);
    expect(errorMessage({ message: 'PENDING_NOT_FOUND' })).toMatch(/no existe/);
  });
});

describe('ADR-025 stage 3 — authorization surface and no double financial impact', () => {
  it('the view and the RPC are in the authorized surface; the pending tables are never a direct write', () => {
    expect(TARGET_VIEWS).toContain('fin_expense_pending_classification');
    expect(TARGET_RPCS).toContain('classify_pending_expense');
    expect(TARGET_RPCS).not.toContain('register_unclassified_expense' as never);   // registering is WhatsApp / backend only
    expect(Object.keys(DIRECT_WRITES)).not.toEqual(expect.arrayContaining(['expense_pending_classification']));
    expect(Object.keys(DIRECT_WRITES).some((t) => /^(purchases|financial_operation|financial_posting|expense_pending_.*)$/.test(t))).toBe(false);
  });

  it('the screen, its hooks and its data layer contain no direct table write and call no other RPC', () => {
    const code = [SRC('features/caja/GastosSinClasificar.tsx'), SRC('features/caja/useUnclassified.ts'), SRC('target/unclassifiedExpenses.ts')].join('\n');
    expect(code).not.toMatch(/\.(insert|update|upsert|delete)\(|writeTable|from\(['"](purchases|financial_operation|financial_posting|expense_pending)/);
    expect([...code.matchAll(/callRpc[^(]*\(\s*client,\s*'([a-z_]+)'/g)].map((m) => m[1])).toEqual(['classify_pending_expense']);
  });

  it('only ADMIN reaches Caja (the screen lives there); OPERATOR never mounts it', () => {
    expect(modulesFor('ADMIN')).toContain('caja');
    expect(modulesFor('OPERATOR')).not.toContain('caja');
    expect(modulesFor(null)).toEqual([]);
    expect(SRC('features/caja/CajaApp.tsx')).toMatch(/rol !== 'ADMIN'/);
    expect(SRC('features/caja/CajaApp.tsx')).toMatch(/vista === 'sinclasificar' && <GastosSinClasificar/);
  });

  it('P&L: GASTOS_SIN_CLASIFICAR is shown as a component of the operating result, read from the server, never re-added', async () => {
    const cols = PNL_LINES.map(([c]) => c);
    expect(cols.indexOf('gastos_sin_clasificar')).toBe(cols.indexOf('resultado_operativo') - 1);
    expect(PNL_RESULT_LINES).not.toContain('gastos_sin_clasificar');
    const { client } = recording([{ period: '2026-10-01', gastos_sin_clasificar: '-35000.00', resultado_operativo: '-35000.00' }]);
    const [r] = await listPnlSummary(client, '2026-10-01', '2026-10-01');
    expect([r.gastos_sin_clasificar, r.resultado_operativo]).toEqual([-35000, -35000]);
    // the screen never sums lines: every value is the view's column
    expect(SRC('features/finanzas/FinanzasApp.tsx')).not.toMatch(/gastos_sin_clasificar\s*\+|\+\s*f\.gastos_sin_clasificar/);
    expect(SRC('features/finanzas/FinanzasApp.tsx')).toMatch(/GASTOS_SIN_CLASIFICAR: 'Gastos sin clasificar'/);
  });
});

describe('ADR-025 stage 3 — WhatsApp notes on the Mercado Pago pending outflows (read-only)', () => {
  it('reads fin_mp_whatsapp_notes for the listed SOURCE_IDs only (digits; anything else dropped); nothing listed → no request', async () => {
    const { listMpWhatsappNotes, whatsappNoteText } = await import('../../src/target/pendingClassification');
    const { client, seen } = recording([{ source_id: '930000025002', draft_short_code: 'W-0042', concept: 'combustible', confirmed_at: '2026-10-20T12:00:00Z' }]);
    const m = await listMpWhatsappNotes(client, ['930000025002', '930000025002', "1),or(x", '']);
    expect(seen.map((x) => [x.method, x.url.pathname])).toEqual([['GET', '/rest/v1/fin_mp_whatsapp_notes']]);
    expect(seen[0].url.searchParams.get('source_id')).toBe('in.(930000025002)');
    // exactly the four columns of the hardened view (security_barrier; nothing else leaves wa.draft)
    expect(seen[0].url.searchParams.get('select')).toBe('source_id,draft_short_code,concept,confirmed_at');
    expect(whatsappNoteText(m.get('930000025002')!)).toBe('WhatsApp W-0042: combustible');
    expect((await listMpWhatsappNotes(client, ['abc'])).size).toBe(0);
    expect(seen).toHaveLength(1);
    expect(TARGET_VIEWS).toContain('fin_mp_whatsapp_notes');
  });

  it('the pending screen only reads the notes (no write, no MP classification RPC added) and pre-fills the existing route with the concept', () => {
    const code = SRC('features/caja/PendientesClasificar.tsx');
    expect(code).toMatch(/useMpWhatsappNotes\(scope === 'current'/);
    expect(code).toMatch(/<ClasificarSalida sourceId=\{r\.source_id\} conceptoInicial=\{nota\?\.concept\}( gastosMpPendientes=\{posibles\})? \/>/);
    expect(SRC('target/pendingClassification.ts')).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    // applied when the form opens (the note arrives after the row is mounted — found in the browser walkthrough)
    expect(SRC('features/caja/CuentaDetalle.tsx')).toMatch(/if \(concepto === '' && conceptoInicial\) setConcepto\(conceptoInicial\); setAbierto\(true\);/);
  });
});
