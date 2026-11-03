/** 0114 — bank charges from the statement (data layer and screen): the server proposes and books; the screen chooses and confirms. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { bookCharges, CHARGE_KIND_EFFECT, type ChargeProposal, listChargeProposals, summarizeCharges } from '../../src/target/bankCharges';
import { reconciliationErrorMessage } from '../../src/target/bankReconciliation';
import { TARGET_RPCS } from '../../src/target/db';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const MIG = readFileSync(resolve(__dirname, '../../supabase/target-migrations/0114_fin_statement_charges.sql'), 'utf8');
function stub(body: unknown) {
  const seen: { url: string; args: Record<string, unknown> }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), args: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}
const P = (id: number, kind: ChargeProposal['kind'], amount: number, status: ChargeProposal['status'] = 'PROPOSED', category: string | null = null): ChargeProposal => ({
  statement_line_id: id, value_date: '2026-10-14', description_raw: 'x', bank_reference: null, signed_amount: amount, running_balance: null,
  status, kind, rule_id: 1, label: 'l', expense_category_id: null, category_name: category,
});

describe('0114 — totals before confirming', () => {
  it('per kind (fees per category) and overall, positive, to the cent; only proposals count', () => {
    const r = summarizeCharges([P(1, 'BANK_TAX_DEBCRED', -6000), P(2, 'BANK_TAX_DEBCRED', -0.3), P(3, 'BANK_FEE', -69000, 'PROPOSED', 'Gastos bancarios'),
      P(4, 'BANK_FEE', -50, 'PROPOSED', 'Gastos bancarios'), P(5, 'BANK_IVA', -14490), P(6, null, -300000, 'NO_RULE')]);
    expect(r.groups.map((g) => [g.title, g.count, g.total])).toEqual([
      ['Impuesto Débitos/Créditos', 2, 6000.3], ['Gasto bancario · Gastos bancarios', 2, 69050], ['IVA bancario', 1, 14490]]);
    expect([r.count, r.total]).toEqual([5, 89540.3]);
  });
  it('the 28 BNA lines add up to 165,006.11', () => {
    const gravamen = [-6000, -4966.29, -1800, -13200, -600, -6000, -600, -0.3, -0.3, -0.3, -0.19, -816.16, -759.56, -4694.17, -15000, -14864.46, -1800, -1800, -6000, -1931.94, -414, -86.94];
    const rows = [...gravamen.map((a, i) => P(i, 'BANK_TAX_DEBCRED', a)), P(100, 'BANK_FEE', -69000, 'PROPOSED', 'Gastos bancarios'),
      P(101, 'BANK_FEE', -50, 'PROPOSED', 'Gastos bancarios'), P(102, 'BANK_FEE', -50, 'PROPOSED', 'Gastos bancarios'), P(103, 'BANK_FEE', -50, 'PROPOSED', 'Gastos bancarios'),
      P(104, 'BANK_IVA', -31.5), P(105, 'BANK_IVA', -14490)];
    const r = summarizeCharges(rows);
    expect(r.groups.map((g) => [g.count, g.total])).toEqual([[22, 81334.61], [4, 69150], [2, 14521.5]]);
    expect([r.count, r.total]).toEqual([28, 165006.11]);
  });
  it('says what each kind does before confirming', () => {
    expect(CHARGE_KIND_EFFECT.BANK_TAX_DEBCRED).toMatch(/no es un gasto adicional/);
    expect(CHARGE_KIND_EFFECT.BANK_IVA).toMatch(/no se toma como crédito fiscal/);
  });
});

describe('0114 — the requests', () => {
  it('proposals come from the server, numbers as numbers', async () => {
    const { client, seen } = stub([{ ...P(9, 'BANK_IVA', 0), signed_amount: '-31.50', running_balance: '100.00' }]);
    const r = await listChargeProposals(client, 'acc');
    expect(seen[0].url).toContain('/rpc/fin_statement_charge_proposals');
    expect(seen[0].args).toEqual({ p_account_id: 'acc' });
    expect([r[0].signed_amount, r[0].running_balance]).toEqual([-31.5, 100]);
  });
  it('a batch sends each line with the kind the user saw and one key', async () => {
    const { client, seen } = stub({ replayed: false, booked: 2, total: '6000.30' });
    const r = await bookCharges(client, { accountId: 'acc', lines: [P(3, 'BANK_TAX_DEBCRED', -6000), P(4, 'BANK_TAX_DEBCRED', -0.3)], idempotencyKey: 'CARGOS-1' });
    expect(seen[0].url).toContain('/rpc/fin_book_statement_charges');
    expect(seen[0].args).toEqual({ p_account_id: 'acc', p_items: [{ statement_line_id: 3, kind: 'BANK_TAX_DEBCRED' }, { statement_line_id: 4, kind: 'BANK_TAX_DEBCRED' }], p_idempotency_key: 'CARGOS-1' });
    expect(r.total).toBe(6000.3);
  });
  it('both RPCs are in the contract list; the refusals have a message', () => {
    expect(TARGET_RPCS).toEqual(expect.arrayContaining(['fin_statement_charge_proposals', 'fin_book_statement_charges']));
    for (const c of ['PROPOSAL_CHANGED', 'LINE_ALREADY_BOOKED', 'IDEMPOTENCY_KEY_REUSED', 'INVALID_ITEMS'])
      expect(reconciliationErrorMessage({ message: `${c}: x` })).not.toBe('Esta operación no pudo completarse.');
  });
});

describe('0114 — the screen', () => {
  const c = SRC('features/caja/CargosBancarios.tsx');
  it('lives in Conciliación, after the cut', () => {
    const k = SRC('features/caja/Conciliacion.tsx');
    expect(k.indexOf('<BloqueCorte accountId={cuentaId} />')).toBeLessThan(k.indexOf('<CargosBancarios accountId={cuentaId} />'));
  });
  it('the user chooses; the confirmation shows totals per category and the general total, then books once with one key per opened form', () => {
    expect(c).toMatch(/type="checkbox"/);
    expect(c).toMatch(/aria-label="Totales por categoría"/);
    expect(c).toMatch(/useState\(\(\) => `CARGOS-\$\{crypto\.randomUUID\(\)\}`\)/);
    expect(c).toMatch(/bookCharges\.mutate\(\{ accountId, lines: lineas, idempotencyKey: clave \}/);
  });
  it('lines without a proposal are only listed for review: no action on them', () => {
    const review = c.slice(c.indexOf('Para revisar'), c.indexOf('{confirmando'));
    expect(review).not.toMatch(/onClick|mutate/);
  });
  it('nothing is computed or written by the screen', () => {
    expect(c).not.toMatch(/\.rpc\(|callRpc|from\('/);
  });
});

describe('0114 — the migration', () => {
  it('bank fees go to "Gastos bancarios" (a subcategory of the existing group Servicios), never to "Comisiones"', () => {
    expect(MIG).toMatch(/SELECT 'Gastos bancarios', [^\n]+, g\.id, 'OPERATING', true\n\s+FROM expense_category_group g\n\s+WHERE g\.nombre = 'Servicios'/);
    expect(MIG).toMatch(/NOT EXISTS \(SELECT 1 FROM expense_category c WHERE c\.nombre = 'Gastos bancarios'\)/);
    expect(MIG).not.toMatch(/nombre = 'Comisiones'/);
  });
  it('the history classifier only learns the booked fee: "Cargo bancario", kind CARGO, before any other rule', () => {
    const cls = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION fin_movement_class'));
    expect(cls).toMatch(/CASE\n\s+WHEN p_ref LIKE 'PURCHASE-PAY:STMT-LINE:%' THEN 'CARGO'/);
    expect(cls).toMatch(/CASE\n\s+WHEN p_ref LIKE 'PURCHASE-PAY:STMT-LINE:%' THEN 'Cargo bancario'/);
    expect(cls).toMatch(/WHEN p_type = 'PURCHASE_PAYMENT' THEN 'Pago de compra'/);
  });
  it('the reason of a booked line carries the bank description and the account', () => {
    expect(MIG).toMatch(/v_reason := v_prop\.label \|\| ': ' \|\| v_line\.description_raw \|\| ' · ' \|\| v_acc\.nombre/);
  });
  it('cheques, fiscal instalments, transfers and unknown concepts have no rule', () => {
    const seed = MIG.slice(MIG.indexOf('INSERT INTO fin_statement_charge_rule'), MIG.indexOf('CREATE TABLE fin_statement_charge_booking'));
    expect(seed).not.toMatch(/48HS|DEBITO PAGO|DEBIN|TRANSF|INTERESES|VARIOS/);
    expect((seed.match(/'\^[^']+\$'/g) ?? []).length).toBe(5);
  });
  it('reuses the existing circuits and matches each line', () => {
    expect(MIG).toMatch(/register_bank_tax\(p_account_id, v_amount, v_line\.value_date, 'DEBITOS_CREDITOS'/);
    expect(MIG).toMatch(/register_casual_purchase\(v_line\.value_date, v_amount, v_amount, v_prop\.expense_category_id/);
    expect(MIG).toMatch(/fin_match_statement_line\(v_line\.id, v_post, v_reason\)/);
  });
  it('ADMIN first, lines locked in id order, the seen kind re-checked; no mp_ name', () => {
    const body = MIG.slice(MIG.indexOf('CREATE FUNCTION fin_book_statement_charges'));
    expect(body.indexOf("current_app_role() IS DISTINCT FROM 'ADMIN'")).toBeLessThan(body.indexOf('INVALID_IDEMPOTENCY_KEY'));
    expect(body).toMatch(/FOR UPDATE/);
    expect(body).toMatch(/PROPOSAL_CHANGED/);
    expect(MIG).not.toMatch(/FUNCTION mp_/);
  });
});
