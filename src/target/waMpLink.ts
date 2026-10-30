/**
 * Lote 4 (0111) — WhatsApp expenses paid with Mercado Pago and confirmed WITHOUT the operation number.
 *
 * Authority (nothing is derived here):
 *   - the confirmation recorded nothing in accounting (financial_effect NONE); wa_mp_link_pending lists those expenses and, for
 *     each, the pending Mercado Pago outflows of the same amount — only listed, the user picks;
 *   - wa_link_mp_expense records the SAME expense against the chosen real outflow (the existing casual-purchase route, which
 *     releases the provisional: no second outflow), dated on the outflow, once (idempotent, audited).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc } from './db';

export interface WaMpCandidate { source_id: string; date: string; amount: number }
export interface WaMpLinkPendingRow {
  draft_id: string; short_code: string; concept: string | null; total: number; expense_date: string; category_name: string | null;
  account_name: string | null; confirmed_at: string; document_file_id: string | null; candidates: WaMpCandidate[];
}
export interface WaMpLinkResult {
  replayed: boolean; draft_id: string; short_code: string; source_id: string; purchase_id: string; fiscal_document_id: string | null;
  expense_date: string; economic_date: string; amount: number; financial_effect: 'EXISTING_MP_OUTFLOW';
}

const num = (v: unknown) => Number(v ?? 0);

export async function listWaMpLinkPending(client: SupabaseClient): Promise<WaMpLinkPendingRow[]> {
  const rows = (await callRpc<WaMpLinkPendingRow[] | null>(client, 'wa_mp_link_pending')) ?? [];
  return rows.map((r) => ({ ...r, total: num(r.total), candidates: (r.candidates ?? []).map((c) => ({ ...c, source_id: String(c.source_id), amount: num(c.amount) })) }));
}

export function linkWaMpExpense(client: SupabaseClient, p: { draftId: string; sourceId: string; reason?: string | null }) {
  return callRpc<WaMpLinkResult>(client, 'wa_link_mp_expense', { p_draft_id: p.draftId, p_source_id: p.sourceId, p_reason: p.reason?.trim() || null });
}
