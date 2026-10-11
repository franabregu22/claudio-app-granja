/**
 * ADR-018 reconciliation / cut UI — local end-to-end through the frontend data layer (src/target/bankReconciliation.ts)
 * against the real view fin_statement_line_status, RLS and the 0075 RPCs. Statements enter through the Edge Function
 * (src/target/bankStatements.ts); compatible / incompatible postings come from the transfer contract RPC.
 *
 * It writes immutable rows, so it runs ONLY on a disposable local project and is skipped otherwise:
 *   FIN_E2E_PROJECT=granja_fresh_0073 TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     npx vitest run tests/integration/adr018-reconciliation.test.ts
 * SYNTHETIC statements only.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { buildPdf } from '../../scripts/adr018/synthetic-pdf';
import {
  activeCutover, canMatch, canReverse, getMatchDetail, listAnchorCandidates, listCutovers, listPostingCandidates, listStatementLines,
  matchStatementLine, reconciliationErrorMessage, resolveStatementCutover, reverseStatementMatch, type StatementLine,
} from '../../src/target/bankReconciliation';
import { importStatement } from '../../src/target/bankStatements';
import { TargetDbError } from '../../src/target/db';
import { transferBetweenAccounts } from '../../src/target/treasury';
import { obtenerHoyBA } from '../../src/utils/dateUtils';

const PROJECT = process.env.FIN_E2E_PROJECT ?? '';
const ENABLED = PROJECT !== '' && PROJECT !== 'Claudio_app_Granja';
const LOCAL_URL = 'http://127.0.0.1:54321';

describe.skipIf(!ENABLED)('ADR-018 reconciliation / cut — local E2E (disposable project)', () => {
  const docker = (args: string[], input?: string) => spawnSync('docker', args, { encoding: 'utf8', input });
  const DB = `supabase_db_${PROJECT}`;
  const EDGE = `supabase_edge_runtime_${PROJECT}`;
  const psql = (sql: string) => {
    const r = docker(['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql);
    if (r.status !== 0) throw new Error(r.stderr);
    return (r.stdout || '').trim();
  };
  type Page = { n: number; items: { str: string; x: number; top: number; w: number }[] };
  type Fixture = { name: string; format: string; config: { expected_account_number: string; expected_cbu: string; expected_extra: Record<string, string> }; pages: Page[] };
  const FIXTURES: Fixture[] = JSON.parse(readFileSync(resolve(__dirname, '../../scripts/adr018/fixtures/unpdf-synthetic-statements.json'), 'utf8')).fixtures;
  const BNA = FIXTURES.find((f) => f.name === 'bna-synthetic')!;
  const PAT = FIXTURES.find((f) => f.name === 'patagonia-synthetic')!;
  // a second Patagonia statement whose 5/09 movements are dated 16/09: new lines on the anchor's date (ambiguous order)
  const PAT_SAME_DAY: Page[] = structuredClone(PAT.pages);
  for (const p of PAT_SAME_DAY) for (const it of p.items) if (it.str === '5/09/26') { it.str = '16/09/26'; it.x -= 4.9; it.w = (it.w * 8) / 7; }
  const pdf = (pages: Page[], name: string) => new File([buildPdf(pages) as Uint8Array<ArrayBuffer>], name, { type: 'application/pdf' });
  const tag = randomUUID().slice(0, 8);
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const acc = { bna: '', pat: '', other: '', cash: '' };
  const users: Record<'ADMIN' | 'OPERATOR', SupabaseClient> = {} as never;
  const admin = () => users.ADMIN;
  const today = obtenerHoyBA();

  beforeAll(async () => {
    assertNoProductionCredentials(process.env);
    assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
    const running = (docker(['ps', '--format', '{{.Names}}']).stdout || '').split(/\r?\n/);
    if (!running.includes(DB) || !running.includes(EDGE) || running.some((n) => n.endsWith('_Claudio_app_Granja'))) {
      throw new Error(`the disposable project ${PROJECT} must be the only local stack running`);
    }
    const env = (docker(['inspect', EDGE, '--format', '{{range .Config.Env}}{{println .}}{{end}}']).stdout || '').split(/\r?\n/);
    const get = (k: string) => (env.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
    const account = (name: string, f: Fixture) => psql(`WITH a AS (INSERT INTO financial_account (nombre, account_type) VALUES ('${name}', 'BANK_ACCOUNT') RETURNING id)
      INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu, expected_extra)
      SELECT id, '${f.format}', '${f.config.expected_account_number}', '${f.config.expected_cbu}', '${JSON.stringify(f.config.expected_extra)}'::jsonb FROM a
      RETURNING financial_account_id;`);
    acc.bna = account(`Conc BNA ${tag}`, BNA);
    acc.pat = account(`Conc PAT ${tag}`, PAT);
    acc.other = psql(`INSERT INTO financial_account (nombre, account_type) VALUES ('Conc otra ${tag}', 'BANK_ACCOUNT') RETURNING id;`);
    acc.cash = psql(`INSERT INTO financial_account (nombre, account_type) VALUES ('Conc caja ${tag}', 'CASH') RETURNING id;`);
    const service = createClient(LOCAL_URL, get('SUPABASE_SERVICE_ROLE_KEY'), opts);
    for (const role of ['ADMIN', 'OPERATOR'] as const) {
      const email = `adr018-conc-${role.toLowerCase()}-${tag}@example.invalid`;
      const password = `Adr018c-${randomUUID()}`;
      const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw error;
      psql(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${data.user!.id}', '${email}', '${role}', true);`);
      const client = createClient(LOCAL_URL, get('SUPABASE_ANON_KEY'), opts);
      const s = await client.auth.signInWithPassword({ email, password });
      if (s.error) throw s.error;
      users[role] = client;
    }
    // statements through the Edge Function
    expect((await importStatement(admin(), { accountId: acc.bna, file: pdf(BNA.pages, 'bna.pdf') })).status).toBe('PARSED');
    expect((await importStatement(admin(), { accountId: acc.pat, file: pdf(PAT.pages, 'pat.pdf') })).status).toBe('PARSED');
    // postings: +52.00 and +53.00 into the BNA account, +52.00 into another account, −6.60 out of the BNA account
    const transfer = (source: string, dest: string, amount: number, ref: string) =>
      transferBetweenAccounts(admin(), { sourceAccountId: source, destAccountId: dest, amount, effectiveDate: today, externalRef: `${ref}-${tag}`, reason: ref });
    await transfer(acc.cash, acc.bna, 52, 'COMPATIBLE-52');
    await transfer(acc.cash, acc.bna, 52, 'COMPATIBLE-52-B');
    await transfer(acc.cash, acc.bna, 53, 'INCOMPATIBLE-53');
    await transfer(acc.cash, acc.other, 52, 'OTRA-CUENTA-52');
    await transfer(acc.bna, acc.cash, 6.6, 'COMPATIBLE-M6.60');
    await transfer(acc.cash, acc.pat, 500, 'PAT-500');
  });

  const lines = (accountId: string) => listStatementLines(admin(), { accountId, cutover: 'ALL', reconciliation: 'ALL' });
  const byAmount = async (accountId: string, amount: number) => (await lines(accountId)).find((l) => l.signed_amount === amount) as StatementLine;

  it('OPERATOR reads no line, no cut and cannot call the RPCs', async () => {
    expect(await listStatementLines(users.OPERATOR, { accountId: acc.bna, cutover: 'ALL', reconciliation: 'ALL' })).toEqual([]);
    expect(await listCutovers(users.OPERATOR, acc.bna)).toEqual([]);
    const l = await byAmount(acc.bna, 52);
    const err = await matchStatementLine(users.OPERATOR, { statementLineId: l.statement_line_id, postingId: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetDbError);
    expect(['FORBIDDEN', 'USER_NOT_FOUND_OR_INACTIVE', 'PERMISSION_DENIED']).toContain(err.code);
  });

  it('1–2: without a cut every line is CUTOVER_UNRESOLVED, nothing is reconcilable, and the database agrees', async () => {
    const all = await lines(acc.bna);
    expect(all).toHaveLength(4);
    expect(new Set(all.map((l) => l.cutover_classification))).toEqual(new Set(['CUTOVER_UNRESOLVED']));
    expect(all.some(canMatch)).toBe(false);
    expect(activeCutover(await listCutovers(admin(), acc.bna))).toBeNull();
    const l = all.find((x) => x.signed_amount === 52)!;
    const [cand] = await listPostingCandidates(admin(), l);
    const err = await matchStatementLine(admin(), { statementLineId: l.statement_line_id, postingId: cand.id }).catch((e) => e);
    expect(err.code).toBe('CUTOVER_UNRESOLVED');
    expect(reconciliationErrorMessage(err)).toBe('Primero tenés que definir el corte de esta cuenta.');
  });

  it('3–5: first cut on the first line (opening = its bank balance); the anchor is PRE, later lines are POST', async () => {
    const anchors = await listAnchorCandidates(admin(), acc.bna);
    const first = anchors.find((a) => a.signed_amount === 1100)!;
    expect(first.running_balance).toBe(1000);
    // a mistyped opening balance never reaches the database through the UI; the RPC also refuses it
    const { error } = await admin().rpc('fin_resolve_statement_cutover', { p_account_id: acc.bna, p_cutoff_statement_line_id: first.statement_line_id,
      p_opening_balance: 999.99, p_evidence_note: 'x', p_supersede_reason: null });
    expect(error?.message).toMatch(/^OPENING_BALANCE_MISMATCH/);
    const r = await resolveStatementCutover(admin(), { accountId: acc.bna, anchor: first, evidenceNote: 'Resumen agosto, primera línea', hasActiveCut: false });
    expect(r.superseded_id).toBeNull();
    const cut = activeCutover(await listCutovers(admin(), acc.bna))!;
    expect([cut.opening_balance, cut.anchor?.running_balance, cut.cutoff_statement_line_id]).toEqual([1000, 1000, first.statement_line_id]);
    const all = await lines(acc.bna);
    expect(all.map((l) => [l.signed_amount, l.cutover_classification]).sort()).toEqual(
      [[-1145.4, 'POST_CUTOVER'], [-6.6, 'POST_CUTOVER'], [1100, 'PRE_CUTOVER'], [52, 'POST_CUTOVER']].sort());
    const pre = all.find((l) => l.signed_amount === 1100)!;
    expect(canMatch(pre)).toBe(false);
    const err = await matchStatementLine(admin(), { statementLineId: pre.statement_line_id, postingId: 1 }).catch((e) => e);
    expect(['PRE_CUTOVER_LINE', 'AMOUNT_MISMATCH', 'POSTING_NOT_FOUND', 'ACCOUNT_MISMATCH']).toContain(err.code);
  });

  it('6: candidates are exactly the same-account, same-amount postings; none pre-selected', async () => {
    const l = await byAmount(acc.bna, 52);
    expect(canMatch(l)).toBe(true);
    const c = await listPostingCandidates(admin(), l);
    expect(c).toHaveLength(2);   // the two +52.00 into this account; not +53.00, not the +52.00 of another account
    expect(c.every((x) => x.signed_amount === 52 && !x.already_matched && x.operation_type === 'TRANSFER')).toBe(true);
    expect(c.map((x) => x.reason).sort()).toEqual(['COMPATIBLE-52', 'COMPATIBLE-52-B']);
    const neg = await listPostingCandidates(admin(), await byAmount(acc.bna, -6.6));
    expect(neg.map((x) => [x.signed_amount, x.reason])).toEqual([[-6.6, 'COMPATIBLE-M6.60']]);
  });

  it('7–11: match → MATCHED (posting then flagged for other lines) → reverse with reason → UNMATCHED → match again', async () => {
    const l = await byAmount(acc.bna, 52);
    const [chosen, other] = await listPostingCandidates(admin(), l);
    const m = await matchStatementLine(admin(), { statementLineId: l.statement_line_id, postingId: chosen.id, reason: 'cobro identificado' });
    expect(m.replayed).toBe(false);
    const matched = await byAmount(acc.bna, 52);
    expect([matched.reconciliation_status, matched.financial_posting_id, canMatch(matched), canReverse(matched)]).toEqual(['MATCHED', chosen.id, false, true]);
    // the same posting is now flagged as taken
    expect((await listPostingCandidates(admin(), l)).find((x) => x.id === chosen.id)?.already_matched).toBe(true);
    // a second match for a matched line is refused by the database
    const dup = await matchStatementLine(admin(), { statementLineId: l.statement_line_id, postingId: other.id }).catch((e) => e);
    expect(reconciliationErrorMessage(dup)).toBe('Esta línea del extracto ya fue conciliada.');
    const detail = await getMatchDetail(admin(), matched.active_match_id!);
    expect([detail?.financial_posting_id, detail?.operation_type, detail?.posting_amount, detail?.reason]).toEqual([chosen.id, 'TRANSFER', 52, 'cobro identificado']);
    expect(() => reverseStatementMatch(admin(), { matchId: matched.active_match_id!, reason: ' ' })).toThrow(TargetDbError);
    await reverseStatementMatch(admin(), { matchId: matched.active_match_id!, reason: 'posting equivocado' });
    const back = await byAmount(acc.bna, 52);
    expect([back.reconciliation_status, back.active_match_id, canMatch(back)]).toEqual(['UNMATCHED', null, true]);
    expect(psql(`SELECT count(*) || '|' || count(*) FILTER (WHERE reversed_at IS NOT NULL) FROM fin_statement_match WHERE statement_line_id = ${l.statement_line_id};`)).toBe('1|1');
    const again = await matchStatementLine(admin(), { statementLineId: l.statement_line_id, postingId: other.id });
    expect(again.replayed).toBe(false);
    expect((await byAmount(acc.bna, 52)).financial_posting_id).toBe(other.id);
  });

  it('12–14 (0077): a cut change that would leave the matched line PRE is refused; after reversing it, the change succeeds', async () => {
    const active = activeCutover(await listCutovers(admin(), acc.bna))!;
    const third = (await listAnchorCandidates(admin(), acc.bna)).find((a) => a.signed_amount === 52)!;   // the matched +52.00 line itself
    expect(() => resolveStatementCutover(admin(), { accountId: acc.bna, anchor: third, evidenceNote: 'e', hasActiveCut: true })).toThrow(/SUPERSEDE_REASON_REQUIRED/);
    const before = await lines(acc.bna);
    const refused = await resolveStatementCutover(admin(), { accountId: acc.bna, anchor: third, evidenceNote: 'Saldo conciliado al 05/08', hasActiveCut: true,
      supersedeReason: 'El saldo inicial real incluye hasta el 05/08' }).catch((e) => e);
    expect(refused.code).toBe('CUTOVER_ACTIVE_MATCH_CONFLICT');
    expect(reconciliationErrorMessage(refused)).toBe('No se puede cambiar el corte porque hay movimientos conciliados que dejarían de quedar posteriores al nuevo corte. Revertí primero esas conciliaciones.');
    // nothing changed: same active cut, same history, same classification and matches
    const cutsAfterRefusal = await listCutovers(admin(), acc.bna);
    expect(cutsAfterRefusal.map((c) => [c.id, c.superseded_at === null])).toEqual([[active.id, true]]);
    expect(await lines(acc.bna)).toEqual(before);
    // the ADMIN reverses the affected match first, then the same change goes through
    const l52 = await byAmount(acc.bna, 52);
    await reverseStatementMatch(admin(), { matchId: l52.active_match_id!, reason: 'pasa a saldo inicial con el nuevo corte' });
    const r = await resolveStatementCutover(admin(), { accountId: acc.bna, anchor: third, evidenceNote: 'Saldo conciliado al 05/08', hasActiveCut: true,
      supersedeReason: 'El saldo inicial real incluye hasta el 05/08' });
    expect(r.superseded_id).toBe(active.id);
    const cuts = await listCutovers(admin(), acc.bna);
    expect(cuts.map((c) => [c.id === r.cutover_id, c.superseded_at === null, c.opening_balance])).toEqual([[true, true, 1045.4], [false, false, 1000]]);
    expect(cuts[1].supersede_reason).toBe('El saldo inicial real incluye hasta el 05/08');
    const cls = Object.fromEntries((await lines(acc.bna)).map((l) => [l.signed_amount, l.cutover_classification]));
    expect(cls).toEqual({ 1100: 'PRE_CUTOVER', '-6.6': 'PRE_CUTOVER', 52: 'PRE_CUTOVER', '-1145.4': 'POST_CUTOVER' });
    const after52 = await byAmount(acc.bna, 52);
    expect([after52.reconciliation_status, canMatch(after52)]).toEqual(['UNMATCHED', false]);
    // invariant in the read model: no active match on a non-POST line
    expect((await lines(acc.bna)).filter((l) => l.reconciliation_status === 'MATCHED' && l.cutover_classification !== 'POST_CUTOVER')).toEqual([]);
  });

  it('15–16: Patagonia — an anchor sharing its date is refused; a later same-day line is AMBIGUOUS and not reconcilable', async () => {
    const anchors = await listAnchorCandidates(admin(), acc.pat);
    const shared = anchors.find((a) => a.value_date === '2026-09-05')!;
    expect(shared.same_day_lines).toBe(1);
    const refused = await resolveStatementCutover(admin(), { accountId: acc.pat, anchor: shared, evidenceNote: 'x', hasActiveCut: false }).catch((e) => e);
    expect(refused.code).toBe('ANCHOR_AMBIGUOUS_DAY');
    expect(reconciliationErrorMessage(refused)).toMatch(/mismo día/);
    const alone = anchors.find((a) => a.value_date === '2026-09-16')!;
    expect(alone.same_day_lines).toBe(0);
    await resolveStatementCutover(admin(), { accountId: acc.pat, anchor: alone, evidenceNote: 'Resumen septiembre', hasActiveCut: false });
    expect((await importStatement(admin(), { accountId: acc.pat, file: pdf(PAT_SAME_DAY, 'pat-16.pdf') })).status).toBe('PARSED');
    const all = await lines(acc.pat);
    const ambiguous = all.filter((l) => l.cutover_classification === 'CUTOVER_AMBIGUOUS_DAY');
    expect(ambiguous.map((l) => l.signed_amount).sort((a, b) => a - b)).toEqual([-3, 500]);
    expect(all.find((l) => l.statement_line_id === alone.statement_line_id)?.cutover_classification).toBe('PRE_CUTOVER');
    expect(ambiguous.some(canMatch)).toBe(false);
    // the database refuses it too, with a same-account, same-amount posting
    const line500 = ambiguous.find((l) => l.signed_amount === 500)!;
    const [posting] = await listPostingCandidates(admin(), line500);
    expect(posting.reason).toBe('PAT-500');
    const err = await matchStatementLine(admin(), { statementLineId: line500.statement_line_id, postingId: posting.id }).catch((e) => e);
    expect(err.code).toBe('CUTOVER_AMBIGUOUS_DAY');
    expect(reconciliationErrorMessage(err)).toBe('No se puede determinar con seguridad el orden de los movimientos de ese día.');
  });
});
