/**
 * Lote 4 (0111, ADR-021 §2.3(c)) — a casual purchase paid with Mercado Pago whose movement is linked later.
 *
 * Authority (nothing is derived here):
 *   - the purchase, its IVA and its P&L line were recorded when it was confirmed (register_casual_purchase_mp_pending, e.g. from
 *     WhatsApp); fin_purchase_mp_link lists it as PENDIENTE_VINCULACION_MP with the pending outflows of the same amount (listed
 *     only — the user picks), or VINCULADO with both dates;
 *   - settle_purchase_mp writes ONLY the payment side against the chosen real outflow (no second purchase / IVA / P&L, no second
 *     Mercado Pago movement), on the movement's date; idempotent per opened form, audited.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readView } from './db';

export interface MpOutflowCandidate { source_id: string; date: string; amount: number }
export interface PurchaseMpLinkRow {
  purchase_root_id: string; purchase_id: string; economic_date: string; amount_total: number; concept: string | null; counterparty_name: string | null;
  category_name: string | null; fiscal_document_id: string | null; origin: 'ERP' | 'WHATSAPP'; origin_code: string | null; created_at: string;
  status: 'PENDIENTE_VINCULACION_MP' | 'VINCULADO'; source_id: string | null; movement_date: string | null; linked_at: string | null;
  age_days: number; candidates: MpOutflowCandidate[] | null;
}
export interface SettlePurchaseMpResult {
  replayed: boolean; purchase_id: string; source_id: string; economic_date: string; movement_date: string; amount: number;
  fee: number; tax: number; status: 'VINCULADO'; financial_effect: 'EXISTING_MP_OUTFLOW';
}

const num = (v: unknown) => Number(v ?? 0);

export async function listPurchaseMpLinks(client: SupabaseClient): Promise<PurchaseMpLinkRow[]> {
  const rows = await readView<PurchaseMpLinkRow>(client, 'fin_purchase_mp_link', (q) => q.order('economic_date', { ascending: true }).limit(500));
  return rows.map((r) => ({ ...r, amount_total: num(r.amount_total), age_days: num(r.age_days),
    candidates: r.candidates ? r.candidates.map((c) => ({ ...c, source_id: String(c.source_id), amount: num(c.amount) })) : null }));
}

/** The pending purchases a Mercado Pago outflow of that comparable gross could belong to (for the duplicate warning). */
export const samePendingAmount = (rows: readonly PurchaseMpLinkRow[], economicAmount: number) =>
  rows.filter((r) => r.status === 'PENDIENTE_VINCULACION_MP' && Math.abs(r.amount_total - economicAmount) < 0.005);

export function settlePurchaseMp(client: SupabaseClient, p: { purchaseId: string; sourceId: string; idempotencyKey: string; reason?: string | null }) {
  return callRpc<SettlePurchaseMpResult>(client, 'settle_purchase_mp', {
    p_purchase_id: p.purchaseId, p_source_id: p.sourceId, p_idempotency_key: p.idempotencyKey, p_reason: p.reason?.trim() || null,
  });
}
