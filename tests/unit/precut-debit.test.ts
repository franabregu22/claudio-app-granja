/** 0115 — an own cheque debited before the bank cut: the server finds the line and settles it without money; the screen chooses and confirms. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { TARGET_RPCS } from '../../src/target/db';
import { errorMessage } from '../../src/target/messages';
import { listInstruments, listPrecutCandidates, markInstrumentDebitedPrecut } from '../../src/target/treasury';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const MIG = readFileSync(resolve(__dirname, '../../supabase/target-migrations/0115_fin_instrument_precut_debit.sql'), 'utf8');
function stub(body: unknown) {
  const seen: { url: string; args: Record<string, unknown> }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), args: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}

describe('0115 — the requests', () => {
  it('candidates come from the server for one instrument, numbers as numbers', async () => {
    const { client, seen } = stub([{ statement_line_id: '45', value_date: '2026-09-30', description_raw: '48HS. BANCOS', bank_reference: '31', signed_amount: '-827714.40', running_balance: '1000.00' }]);
    const r = await listPrecutCandidates(client, 'inst-31');
    expect(seen[0].url).toContain('/rpc/fin_instrument_precut_candidates');
    expect(seen[0].args).toEqual({ p_instrument_id: 'inst-31' });
    expect([r[0].statement_line_id, r[0].signed_amount, r[0].running_balance]).toEqual([45, -827714.4, 1000]);
  });
  it('the debit sends the instrument, the chosen line, the date of that line and one key', async () => {
    const { client, seen } = stub({ replayed: false, estado: 'DEBITED' });
    await markInstrumentDebitedPrecut(client, { instrumentId: 'inst-29', statementLineId: 321, debitedDate: '2026-10-01', idempotencyKey: 'PRECUT-1', reason: ' ' });
    expect(seen[0].url).toContain('/rpc/fin_mark_instrument_debited_precut');
    expect(seen[0].args).toEqual({ p_instrument_id: 'inst-29', p_statement_line_id: 321, p_debited_date: '2026-10-01', p_idempotency_key: 'PRECUT-1', p_reason: null });
  });
  it('the cheque list knows which ones were debited before the cut (object or array embedding)', async () => {
    const base = { id: 'a', instrument_type: 'ECHEQ', direction: 'ISSUED', estado: 'DEBITED', amount: '1.00', clients: null, emisor: { nombre: 'P' }, endosado: null };
    const { client, seen } = stub([{ ...base, precut: { statement_line_id: 45 } }, { ...base, id: 'b', precut: [{ statement_line_id: 321 }] }, { ...base, id: 'c', precut: null }, { ...base, id: 'd', precut: [] }]);
    const r = await listInstruments(client);
    expect(decodeURIComponent(seen[0].url)).toContain('precut:fin_instrument_precut_debit(statement_line_id)');
    expect(r.map((i) => i.precut_line_id)).toEqual([45, 321, null, null]);
  });
  it('both RPCs are in the contract list; every refusal has its own message', () => {
    expect(TARGET_RPCS).toEqual(expect.arrayContaining(['fin_instrument_precut_candidates', 'fin_mark_instrument_debited_precut']));
    for (const c of ['LINE_NOT_IN_ACCOUNT', 'AMOUNT_MISMATCH', 'CHEQUE_NUMBER_MISMATCH', 'DEBIT_DATE_MISMATCH', 'DEBIT_BEFORE_ISSUE', 'NOT_PRE_CUTOVER',
      'LINE_ALREADY_USED', 'IDEMPOTENCY_KEY_REUSED', 'PRECUT_DEBIT_FINAL', 'LINE_NOT_FOUND'])
      expect(errorMessage({ message: `${c}: x` })).not.toBe('No se pudo completar la operación. Intentá de nuevo.');
  });
});

describe('0115 — the screen (Caja → Cuentas a pagar → Cheques, no new tab)', () => {
  const c = SRC('features/caja/Cheques.tsx');
  const modal = c.slice(c.indexOf('function DebitoAnteriorCorteModal'), c.indexOf('function RecibirChequeModal'));
  it('the action is offered only for an own cheque still issued', () => {
    expect(c).toMatch(/\{i\.direction === 'ISSUED' && i\.estado === 'ISSUED' && \(\n\s+<button onClick=\{\(\) => setAnteriorCorte\(i\)\}/);
  });
  it('a cheque debited before the cut is never offered "Rechazar", and shows its line', () => {
    expect(c).toMatch(/INSTRUMENT_ACTIONS\[i\.estado\]\.filter\(\(a\) => !\(a === 'reject' && i\.precut_line_id !== null\)\)/);
    expect(c).toMatch(/antes del corte \(línea \{i\.precut_line_id\}\)/);
  });
  it('only a line found by the server can be chosen; the date sent is that line\'s; one key per opened form', () => {
    expect(modal).toMatch(/usePrecutCandidates\(inst\.id\)/);
    expect(modal).toMatch(/debitedDate: elegida\.value_date/);
    expect(modal).toMatch(/useState\(\(\) => `PRECUT-\$\{crypto\.randomUUID\(\)\}`\)/);
    expect(modal).not.toMatch(/type="date"/);
  });
  it('the screen computes and writes nothing itself', () => {
    expect(modal).not.toMatch(/\.rpc\(|callRpc|from\('/);
  });
  it('the usual "Marcar debitado" is unchanged', () => {
    expect(SRC('target/treasury.ts')).toMatch(/ISSUED: \['debit', 'cancel', 'reject'\]/);
  });
});

describe('0115 — the migration', () => {
  const rpc = MIG.slice(MIG.indexOf('CREATE FUNCTION fin_mark_instrument_debited_precut'));
  it('no money: the RPC writes no operation, no posting, no match and no supplier movement', () => {
    expect(rpc).not.toMatch(/INSERT INTO (financial_operation|financial_posting|fin_statement_match|supplier_ledger)/);
    expect(rpc).not.toMatch(/mark_supplier_instrument_debited|fin_match_statement_line/);
    expect(rpc).toMatch(/INSERT INTO financial_instrument_event \([^)]+\)\n\s+VALUES \(v_inst\.id, 'DEBITED', v_line\.value_date, NULL,/);
  });
  it('ADMIN first; the key, then the rows locked; the account FOR SHARE so the cut cannot change meanwhile', () => {
    expect(rpc.indexOf("current_app_role() IS DISTINCT FROM 'ADMIN'")).toBeLessThan(rpc.indexOf('INVALID_IDEMPOTENCY_KEY'));
    expect(rpc).toMatch(/FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE/);
    expect(rpc).toMatch(/FROM fin_statement_line WHERE id = p_statement_line_id FOR UPDATE/);
    expect(rpc).toMatch(/FROM financial_account WHERE id = v_line\.financial_account_id FOR SHARE/);
  });
  it('the exact checks: account, amount, number, issue date, the cut (0114 classification: BNA coverage and position), unused', () => {
    const chk = MIG.slice(MIG.indexOf('CREATE FUNCTION fin_instrument_precut_check'), MIG.indexOf('CREATE FUNCTION fin_instrument_precut_candidates'));
    for (const code of ['WRONG_DIRECTION', 'INVALID_STATE', 'LINE_NOT_IN_ACCOUNT', 'AMOUNT_MISMATCH', 'CHEQUE_NUMBER_MISMATCH', 'DEBIT_BEFORE_ISSUE', 'NOT_PRE_CUTOVER', 'LINE_ALREADY_USED'])
      expect(chk).toContain(`'${code}'`);
    expect(chk).toMatch(/fin_statement_line_cut_class\(p_line\.id\) IS DISTINCT FROM 'PRE_CUTOVER'/);
    expect(rpc).toMatch(/IF p_debited_date IS DISTINCT FROM v_line\.value_date THEN\n\s+RAISE EXCEPTION 'DEBIT_DATE_MISMATCH/);
  });
  it('the evidence is immutable and one per instrument and per line; a pre-cut debit can never leave DEBITED', () => {
    expect(MIG).toMatch(/financial_instrument_id UUID\s+PRIMARY KEY/);
    expect(MIG).toMatch(/statement_line_id\s+BIGINT\s+NOT NULL UNIQUE/);
    expect(MIG).toMatch(/BEFORE UPDATE OR DELETE ON fin_instrument_precut_debit\n\s+FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard\(\)/);
    expect(MIG).toMatch(/CREATE TRIGGER trg_financial_instrument_precut_final BEFORE UPDATE ON financial_instrument/);
  });
  it('no existing function is replaced; no mp_ name', () => {
    expect(MIG).not.toMatch(/CREATE OR REPLACE/);
    expect(MIG).not.toMatch(/FUNCTION mp_/);
  });
});
