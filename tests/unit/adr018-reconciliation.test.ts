/**
 * ADR-018 reconciliation / cut UI — data layer, access and RPC contract. The REAL supabase-js client is used with a
 * recording fetch, so the assertions are on the actual PostgREST requests (view / table reads and RPC bodies).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  activeCutover, canMatch, canReverse, CUTOVER_LABEL, DEFAULT_FILTERS, importe, listAnchorCandidates, listCutovers, listPostingCandidates,
  listStatementLines, matchStatementLine, RECONCILIATION_LABEL, reconciliationErrorMessage, resolveStatementCutover, reverseStatementMatch,
  searchTerm, type StatementLine,
} from '../../src/target/bankReconciliation';
import { TARGET_READ_TABLES, TARGET_RPCS, TARGET_VIEWS, TargetDbError } from '../../src/target/db';
import { modulesFor, resolveModule } from '../../src/target/roles';

const URL_ = 'http://127.0.0.1:54321';
interface Seen { url: URL; method: string; body: string | null }
function harness(routes: Record<string, (u: URL) => Response>) {
  const seen: Seen[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    seen.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : null });
    const key = Object.keys(routes).find((k) => url.pathname.endsWith(k));
    return key ? routes[key](url) : json([])(url);
  };
  const client = createClient(URL_, 'anon-key', { global: { fetch: fetchImpl as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
  return { client, seen };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rpcError = (message: string) => json({ code: 'P0001', message, details: null, hint: null }, 400);
const line = (over: Partial<StatementLine> = {}): StatementLine => ({
  statement_line_id: 10, financial_account_id: 'acc', value_date: '2026-08-04', description_raw: 'DEBIN 30000000000', bank_reference: '412',
  fecha_valor: null, signed_amount: 1100, running_balance: 1000, active_cutover_id: 1, cutoff_statement_line_id: 5, opening_balance: -100,
  cutover_classification: 'POST_CUTOVER', active_match_id: null, financial_operation_id: null, financial_posting_id: null, matched_at: null,
  match_reason: null, reconciliation_status: 'UNMATCHED', ...over,
});

describe('ADR-018 reconciliation access: ADMIN only', () => {
  it('lives inside Caja (ADMIN module); OPERATOR has no link and a forced request falls back', () => {
    expect(modulesFor('ADMIN')).toContain('caja');
    expect(modulesFor('OPERATOR')).not.toContain('caja');
    expect(resolveModule('OPERATOR', 'caja')).not.toBe('caja');
    const ext = readFileSync(resolve(__dirname, '../../src/features/caja/ExtractosBancarios.tsx'), 'utf8');
    expect(ext).toMatch(/\['importaciones', 'Importaciones'\], \['conciliacion', 'Conciliación'\]/);
    expect(ext).toMatch(/<Conciliacion \/>/);
  });
  it('the UI writes nothing directly: no fin_* insert / update / delete, no Storage, no service key; mutations are the 3 RPCs', () => {
    for (const f of ['src/target/bankReconciliation.ts', 'src/features/caja/Conciliacion.tsx', 'src/features/caja/useReconciliation.ts']) {
      const src = readFileSync(resolve(__dirname, '../..', f), 'utf8');
      expect(src, f).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.storage\b|service_role|SERVICE_ROLE/);
      expect(src, f).not.toMatch(/expected_cbu|expected_account_number/);
    }
    const lib = readFileSync(resolve(__dirname, '../../src/target/bankReconciliation.ts'), 'utf8');
    expect([...lib.matchAll(/callRpc<[^>]*>\(client, '([a-z_]+)'/g)].map((m) => m[1]).sort())
      .toEqual(['fin_match_statement_line', 'fin_resolve_statement_cutover', 'fin_reverse_statement_match']);
  });
  it('allowlist: exactly the 3 ADR-018 RPCs added; view and the two tables registered', () => {
    expect(TARGET_RPCS.filter((r) => r.startsWith('fin_'))).toEqual(['fin_match_statement_line', 'fin_reverse_statement_match', 'fin_resolve_statement_cutover']);
    expect(TARGET_RPCS).not.toContain('fin_import_bank_statement');
    expect(TARGET_VIEWS).toContain('fin_statement_line_status');
    expect(TARGET_READ_TABLES).toEqual(expect.arrayContaining(['fin_statement_match', 'fin_statement_cutover']));
    expect(TARGET_READ_TABLES).not.toContain('fin_statement_line');
  });
});

describe('ADR-018 line list', () => {
  it('reads fin_statement_line_status for one account with the default filters POST_CUTOVER + UNMATCHED, newest first, bounded', async () => {
    const { client, seen } = harness({ '/rest/v1/fin_statement_line_status': json([{ ...line(), signed_amount: '1100.00', running_balance: null }]) });
    const rows = await listStatementLines(client, { accountId: 'acc', ...DEFAULT_FILTERS });
    expect(rows[0]).toMatchObject({ signed_amount: 1100, running_balance: null });
    const q = seen[0].url.searchParams;
    expect([q.get('financial_account_id'), q.get('cutover_classification'), q.get('reconciliation_status')]).toEqual(['eq.acc', 'eq.POST_CUTOVER', 'eq.UNMATCHED']);
    expect([q.get('order'), q.get('limit')]).toEqual(['value_date.desc,statement_line_id.desc', '200']);
  });
  it('"Todas" removes a filter; dates and the search reach the query; no account → no request', async () => {
    const { client, seen } = harness({});
    await listStatementLines(client, { accountId: 'acc', cutover: 'ALL', reconciliation: 'ALL', from: '2026-08-01', to: '2026-08-31', search: 'debin, (x)*' });
    const q = seen[0].url.searchParams;
    expect(q.get('cutover_classification')).toBeNull();
    expect(q.get('reconciliation_status')).toBeNull();
    expect(q.getAll('value_date')).toEqual(['gte.2026-08-01', 'lte.2026-08-31']);
    expect(q.get('or')).toBe('(description_raw.ilike.*debin x*,bank_reference.ilike.*debin x*)');
    expect(searchTerm(' a,b(c)*d% ')).toBe('a b c d');
    await listStatementLines(client, { accountId: '', ...DEFAULT_FILTERS });
    expect(seen).toHaveLength(1);
  });
  it('labels for every class and state', () => {
    expect(CUTOVER_LABEL).toEqual({ CUTOVER_UNRESOLVED: 'Corte pendiente', PRE_CUTOVER: 'Incluido en saldo inicial', POST_CUTOVER: 'A conciliar',
      CUTOVER_AMBIGUOUS_DAY: 'Día ambiguo' });
    expect(RECONCILIATION_LABEL).toEqual({ MATCHED: 'Conciliado', UNMATCHED: 'Sin conciliar' });
    expect(importe(-3)).toMatch(/^−\$\s?3,00$/);
    expect(importe(1100, true)).toMatch(/^\+\$\s?1\.100,00$/);
    expect(importe(null)).toBe('—');
  });
});

describe('ADR-018 match', () => {
  it('Conciliar only for POST_CUTOVER + UNMATCHED; never for PRE / UNRESOLVED / AMBIGUOUS / unclassified; Revertir only when MATCHED', () => {
    expect(canMatch(line())).toBe(true);
    for (const c of ['PRE_CUTOVER', 'CUTOVER_UNRESOLVED', 'CUTOVER_AMBIGUOUS_DAY', null] as const) expect(canMatch(line({ cutover_classification: c }))).toBe(false);
    expect(canMatch(line({ reconciliation_status: 'MATCHED', active_match_id: 7 }))).toBe(false);
    expect(canReverse(line({ reconciliation_status: 'MATCHED', active_match_id: 7 }))).toBe(true);
    expect(canReverse(line())).toBe(false);
  });
  it('candidates: same account + exact amount; already-matched flagged (not removed, not selectable); nearest date first; nothing pre-selected', async () => {
    const { client, seen } = harness({
      '/rest/v1/financial_posting': json([
        { id: 1, financial_operation_id: 11, signed_amount: '1100.00', effective_date: '2026-07-01', financial_operation: { operation_type: 'COLLECTION', external_ref: 'R-1', reason: null, source_entity_type: 'collections' } },
        { id: 2, financial_operation_id: 12, signed_amount: '1100.00', effective_date: '2026-08-05', financial_operation: { operation_type: 'TRANSFER', external_ref: null, reason: 'x', source_entity_type: null } },
        { id: 3, financial_operation_id: 13, signed_amount: '1100.00', effective_date: '2026-08-04', financial_operation: { operation_type: 'COLLECTION', external_ref: 'R-3', reason: null, source_entity_type: null } },
        { id: 4, financial_operation_id: 14, signed_amount: '1100.50', effective_date: '2026-08-04', financial_operation: null },
      ]),
      '/rest/v1/fin_statement_match': json([{ financial_posting_id: 3 }]),
    });
    const c = await listPostingCandidates(client, line());
    expect(c.map((x) => [x.id, x.already_matched, x.days_from_line])).toEqual([[2, false, 1], [1, false, 34], [3, true, 0]]);
    const [p, m] = seen.map((s) => s.url.searchParams);
    expect([p.get('financial_account_id'), p.get('signed_amount')]).toEqual(['eq.acc', 'eq.1100.00']);
    expect([m.get('financial_posting_id'), m.get('reversed_at')]).toEqual(['in.(1,2,3,4)', 'is.null']);
  });
  it('RPC contract: exactly line id, the chosen posting id and the reason (blank → null); no operation id', async () => {
    const { client, seen } = harness({ '/rest/v1/rpc/fin_match_statement_line': json({ match_id: 9, financial_operation_id: 12, replayed: false }) });
    await matchStatementLine(client, { statementLineId: 10, postingId: 2, reason: '  ' });
    await matchStatementLine(client, { statementLineId: 10, postingId: 2, reason: ' cobro agosto ' });
    expect(seen.map((s) => [s.method, JSON.parse(s.body as string)])).toEqual([
      ['POST', { p_statement_line_id: 10, p_financial_posting_id: 2, p_reason: null }],
      ['POST', { p_statement_line_id: 10, p_financial_posting_id: 2, p_reason: 'cobro agosto' }],
    ]);
  });
  it('database refusals (race / duplicate / class / mismatch) surface as clear messages', async () => {
    const cases: [string, string][] = [
      ['POSTING_ALREADY_MATCHED: posting 3 already has an active match', 'Ese movimiento ya fue conciliado.'],
      ['MATCH_CONFLICT: a concurrent active match exists', 'Ese movimiento ya fue conciliado.'],
      ['LINE_ALREADY_MATCHED: statement line 10 has active match 4', 'Esta línea del extracto ya fue conciliada.'],
      ['CUTOVER_UNRESOLVED: the account has no active statement cut', 'Primero tenés que definir el corte de esta cuenta.'],
      ['PRE_CUTOVER_LINE: the line is included in the opening balance', 'Este movimiento ya está incluido en el saldo inicial.'],
      ['CUTOVER_AMBIGUOUS_DAY: same-day order relative to the anchor is not verifiable', 'No se puede determinar con seguridad el orden de los movimientos de ese día.'],
      ['AMOUNT_MISMATCH: posting 1 vs statement line 2', 'El importe del movimiento elegido no coincide exactamente con el del extracto.'],
      ['ACCOUNT_MISMATCH: the posting and the statement line belong to different accounts', 'El movimiento elegido no corresponde a esta cuenta.'],
      ['something unexpected happened', 'Esta operación no pudo completarse.'],
    ];
    for (const [message, text] of cases) {
      const { client } = harness({ '/rest/v1/rpc/fin_match_statement_line': rpcError(message) });
      const err = await matchStatementLine(client, { statementLineId: 10, postingId: 3 }).catch((e) => e);
      expect(err).toBeInstanceOf(TargetDbError);
      expect(reconciliationErrorMessage(err), message).toBe(text);
    }
  });
});

describe('ADR-018 reversal', () => {
  it('reason mandatory (no request without it); RPC receives the match id and the trimmed reason', async () => {
    const { client, seen } = harness({ '/rest/v1/rpc/fin_reverse_statement_match': json({ match_id: 9, reversed: true }) });
    expect(() => reverseStatementMatch(client, { matchId: 9, reason: '  ' })).toThrow(TargetDbError);
    expect(seen).toHaveLength(0);
    await reverseStatementMatch(client, { matchId: 9, reason: ' posting equivocado ' });
    expect(JSON.parse(seen[0].body as string)).toEqual({ p_match_id: 9, p_reason: 'posting equivocado' });
  });
  it('after a reversal the line reads UNMATCHED again (status comes from the view, never set locally)', async () => {
    const { client } = harness({ '/rest/v1/fin_statement_line_status': json([line({ reconciliation_status: 'UNMATCHED', active_match_id: null })]) });
    const [l] = await listStatementLines(client, { accountId: 'acc', cutover: 'ALL', reconciliation: 'ALL' });
    expect([l.reconciliation_status, canMatch(l), canReverse(l)]).toEqual(['UNMATCHED', true, false]);
  });
});

describe('ADR-018 statement cut', () => {
  const cuts = [
    { id: 2, opening_balance: '597.00', cutoff_statement_line_id: 21, resolved_at: '2026-10-11T12:00:00Z', evidence_note: 'extracto sept', superseded_by: null, superseded_at: null, supersede_reason: null },
    { id: 1, opening_balance: '-100.00', cutoff_statement_line_id: 20, resolved_at: '2026-10-10T12:00:00Z', evidence_note: 'primero', superseded_by: 2, superseded_at: '2026-10-11T12:00:00Z', supersede_reason: 'ancla equivocada' },
  ];
  it('no cut → none active; with history → active first, superseded kept with their anchors', async () => {
    const empty = harness({});
    expect(activeCutover(await listCutovers(empty.client, 'acc'))).toBeNull();
    const { client, seen } = harness({
      '/rest/v1/fin_statement_cutover': json(cuts),
      '/rest/v1/fin_statement_line_status': json([
        { statement_line_id: 20, value_date: '2026-07-31', description_raw: 'SALDO', signed_amount: '5.00', running_balance: '-100.00' },
        { statement_line_id: 21, value_date: '2026-09-30', description_raw: 'X', signed_amount: '3.00', running_balance: '597.00' },
      ]),
    });
    const all = await listCutovers(client, 'acc');
    expect(all.map((c) => [c.id, c.superseded_at === null, c.opening_balance, c.anchor?.running_balance])).toEqual([[2, true, 597, 597], [1, false, -100, -100]]);
    expect(activeCutover(all)?.id).toBe(2);
    expect(seen[1].url.searchParams.get('statement_line_id')).toBe('in.(21,20)');
  });
  it('anchor candidates: only lines with a bank running balance; same-day count for the Patagonia warning', async () => {
    const { client } = harness({ '/rest/v1/fin_statement_line_status': json([
      { statement_line_id: 3, value_date: '2026-09-05', description_raw: 'A', signed_amount: '-3.00', running_balance: null },
      { statement_line_id: 2, value_date: '2026-09-05', description_raw: 'B', signed_amount: '600.00', running_balance: '597.00' },
      { statement_line_id: 1, value_date: '2026-09-01', description_raw: 'C', signed_amount: '0.50', running_balance: '0.00' },
    ]) });
    const a = await listAnchorCandidates(client, 'acc');
    expect(a.map((x) => [x.statement_line_id, x.running_balance, x.same_day_lines])).toEqual([[2, 597, 1], [1, 0, 0]]);
  });
  it('first cut: opening balance = the anchor running balance exactly, supersede reason null, evidence required', async () => {
    const { client, seen } = harness({ '/rest/v1/rpc/fin_resolve_statement_cutover': json({ cutover_id: 1, superseded_id: null }) });
    expect(() => resolveStatementCutover(client, { accountId: 'acc', anchor: { statement_line_id: 20, running_balance: null }, evidenceNote: 'x', hasActiveCut: false }))
      .toThrow(/ANCHOR_WITHOUT_BALANCE/);
    expect(() => resolveStatementCutover(client, { accountId: 'acc', anchor: { statement_line_id: 20, running_balance: -100 }, evidenceNote: ' ', hasActiveCut: false }))
      .toThrow(/EVIDENCE_REQUIRED/);
    await resolveStatementCutover(client, { accountId: 'acc', anchor: { statement_line_id: 20, running_balance: -100.5 }, evidenceNote: ' resumen julio ',
      hasActiveCut: false, supersedeReason: 'ignored' });
    expect(JSON.parse(seen[0].body as string)).toEqual({ p_account_id: 'acc', p_cutoff_statement_line_id: 20, p_opening_balance: -100.5,
      p_evidence_note: 'resumen julio', p_supersede_reason: null });
  });
  it('supersession: reason mandatory, sent with the new anchor; the opening balance is never typed by the user', async () => {
    const { client, seen } = harness({ '/rest/v1/rpc/fin_resolve_statement_cutover': json({ cutover_id: 2, superseded_id: 1 }) });
    expect(() => resolveStatementCutover(client, { accountId: 'acc', anchor: { statement_line_id: 21, running_balance: 597 }, evidenceNote: 'e', hasActiveCut: true }))
      .toThrow(/SUPERSEDE_REASON_REQUIRED/);
    await resolveStatementCutover(client, { accountId: 'acc', anchor: { statement_line_id: 21, running_balance: 597 }, evidenceNote: 'e', hasActiveCut: true,
      supersedeReason: ' ancla equivocada ' });
    expect(JSON.parse(seen[0].body as string)).toMatchObject({ p_opening_balance: 597, p_supersede_reason: 'ancla equivocada' });
    const ui = readFileSync(resolve(__dirname, '../../src/features/caja/Conciliacion.tsx'), 'utf8');
    expect(ui).toMatch(/readOnly value=\{ancla \? importe\(ancla\.running_balance\)/);
    expect(ui).toMatch(/Saldo inicial reconocido/);
    expect(ui).not.toMatch(/saldo actual/i);
  });
  it('cut refusals map to clear messages', () => {
    const m = (code: string) => reconciliationErrorMessage(new TargetDbError(code, ''));
    expect(m('ANCHOR_AMBIGUOUS_DAY')).toMatch(/mismo día/);
    expect(m('OPENING_BALANCE_MISMATCH')).toMatch(/exactamente el saldo informado por el banco/);
    expect(m('ANCHOR_WITHOUT_BALANCE')).toMatch(/no tiene saldo informado/);
    expect(m('SUPERSEDE_REASON_REQUIRED')).toMatch(/motivo del cambio/);
  });
});

describe('ADR-018 ambiguous day', () => {
  it('an AMBIGUOUS line is never offered for match and the database refusal reads clearly', () => {
    const l = line({ cutover_classification: 'CUTOVER_AMBIGUOUS_DAY' });
    expect(canMatch(l)).toBe(false);
    expect(reconciliationErrorMessage(new TargetDbError('CUTOVER_AMBIGUOUS_DAY', ''))).toBe('No se puede determinar con seguridad el orden de los movimientos de ese día.');
  });
});
