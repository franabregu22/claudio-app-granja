/**
 * ADR-018 §23 (0114) — bank charges from the statement. The server recognises each post-cut debit by its description (rules per
 * statement format) and proposes it; nothing is recorded until an ADMIN confirms. A confirmed batch books every line as its own
 * operation, matched 1:1 to its line, in one transaction. Cheques, fiscal instalments, transfers and unknown concepts are never
 * proposed: they stay for review.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc } from './db';

export type ChargeKind = 'BANK_TAX_DEBCRED' | 'BANK_FEE' | 'BANK_IVA';
export type ChargeStatus = 'PROPOSED' | 'NO_RULE' | 'AMBIGUOUS' | 'CREDIT' | 'CATEGORY_MISSING';
export interface ChargeProposal {
  statement_line_id: number; value_date: string; description_raw: string; bank_reference: string | null; signed_amount: number; running_balance: number | null;
  status: ChargeStatus; kind: ChargeKind | null; rule_id: number | null; label: string | null; expense_category_id: string | null; category_name: string | null;
}

export const CHARGE_KINDS: ChargeKind[] = ['BANK_TAX_DEBCRED', 'BANK_FEE', 'BANK_IVA'];
export const CHARGE_KIND_LABEL: Record<ChargeKind, string> = {
  BANK_TAX_DEBCRED: 'Impuesto Débitos/Créditos', BANK_FEE: 'Gasto bancario', BANK_IVA: 'IVA bancario',
};
/** What confirming does with each kind, said before the user confirms. */
export const CHARGE_KIND_EFFECT: Record<ChargeKind, string> = {
  BANK_TAX_DEBCRED: 'Impuesto bancario: no es un gasto adicional.',
  BANK_FEE: 'Gasto en resultados, en su categoría.',
  BANK_IVA: 'Categoría fiscal aparte: no se toma como crédito fiscal.',
};
export const REVIEW_LABEL: Record<Exclude<ChargeStatus, 'PROPOSED'>, string> = {
  NO_RULE: 'Sin regla: revisar', AMBIGUOUS: 'Concepto ambiguo', CREDIT: 'Crédito: no es un cargo', CATEGORY_MISSING: 'Falta la categoría de gasto',
};

const num = (v: unknown) => Number(v);

export async function listChargeProposals(client: SupabaseClient, accountId: string): Promise<ChargeProposal[]> {
  const rows = await callRpc<ChargeProposal[]>(client, 'fin_statement_charge_proposals', { p_account_id: accountId });
  return (rows ?? []).map((r) => ({ ...r, signed_amount: num(r.signed_amount), running_balance: r.running_balance === null ? null : num(r.running_balance) }));
}

export interface BookResult { replayed: boolean; booked: number; total: number; by_kind?: Partial<Record<ChargeKind, number>> }
export async function bookCharges(client: SupabaseClient, p: { accountId: string; lines: Pick<ChargeProposal, 'statement_line_id' | 'kind'>[]; idempotencyKey: string }): Promise<BookResult> {
  const r = await callRpc<BookResult>(client, 'fin_book_statement_charges', {
    p_account_id: p.accountId, p_items: p.lines.map((l) => ({ statement_line_id: l.statement_line_id, kind: l.kind })), p_idempotency_key: p.idempotencyKey,
  });
  return { ...r, total: num(r.total) };
}

/** Totals of the chosen proposals: per kind (and per category for fees) and overall, positive amounts. */
export interface ChargeGroup { key: string; kind: ChargeKind; title: string; count: number; total: number }
export function summarizeCharges(rows: ChargeProposal[]): { groups: ChargeGroup[]; count: number; total: number } {
  const m = new Map<string, ChargeGroup>();
  for (const r of rows) {
    if (r.status !== 'PROPOSED' || !r.kind) continue;
    const key = r.kind === 'BANK_FEE' ? `${r.kind}:${r.category_name ?? ''}` : r.kind;
    const title = r.kind === 'BANK_FEE' ? `${CHARGE_KIND_LABEL[r.kind]} · ${r.category_name ?? 'sin categoría'}` : CHARGE_KIND_LABEL[r.kind];
    const g = m.get(key) ?? { key, kind: r.kind, title, count: 0, total: 0 };
    g.count += 1; g.total = Math.round((g.total - r.signed_amount) * 100) / 100;
    m.set(key, g);
  }
  const groups = [...m.values()].sort((a, b) => CHARGE_KINDS.indexOf(a.kind) - CHARGE_KINDS.indexOf(b.kind) || a.title.localeCompare(b.title));
  return { groups, count: groups.reduce((t, g) => t + g.count, 0), total: Math.round(groups.reduce((t, g) => t + g.total, 0) * 100) / 100 };
}
