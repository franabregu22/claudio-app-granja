/**
 * 0116 — Caja → Transferencias.
 * · A transfer between Mercado Pago and an own bank account can be registered BEFORE its Mercado Pago movement exists: it is an
 *   anticipated transfer (fin_transfer_intent) and moves no money (0091: a Mercado Pago posting needs its movement). When the movement
 *   arrives it is linked: the server creates the ONE transfer through the existing route, or links a transfer already confirmed.
 *   Between other own accounts the transfer is recorded directly (transfer_between_accounts) and its bank line is matched later.
 * · A debits/credits tax already recorded (from the statement or by hand) is associated to its transfer, never recorded again.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable } from './db';
import type { MpCandidate } from './mpActivity';
import type { MovementRow } from './movementHistory';

export type IntentStatus = 'PENDIENTE' | 'VINCULADA' | 'ANULADA';
export const INTENT_STATUS_LABEL: Record<IntentStatus, string> = { PENDIENTE: 'Registrada · pendiente de vinculación', VINCULADA: 'Vinculada', ANULADA: 'Anulada' };
export interface TransferIntentRow {
  id: number; from_account_id: string; to_account_id: string; amount: number; effective_date: string; reason: string | null; status: IntentStatus;
  transfer_operation_id: number | null; linked_source_id: string | null; created_at: string;
  origen: string; destino: string;
}
/** 'PAYOUT': Mercado Pago → bank; 'INFLOW': bank → Mercado Pago; anything else is a direct transfer. */
export type IntentRoute = 'PAYOUT' | 'INFLOW' | null;
export function intentRoute(from: { isMp: boolean; isBank: boolean }, to: { isMp: boolean; isBank: boolean }): IntentRoute {
  if (from.isMp && to.isBank) return 'PAYOUT';
  if (to.isMp && from.isBank) return 'INFLOW';
  return null;
}

export async function listTransferIntents(client: SupabaseClient, limit = 50): Promise<TransferIntentRow[]> {
  type Raw = Omit<TransferIntentRow, 'origen' | 'destino' | 'amount'> & { amount: number | string; o: { nombre: string } | null; d: { nombre: string } | null };
  const rows = await readTable<Raw>(client, 'fin_transfer_intent', (q) => q.order('status', { ascending: false }).order('effective_date', { ascending: false }).order('id', { ascending: false }).limit(limit),
    'id, from_account_id, to_account_id, amount, effective_date, reason, status, transfer_operation_id, linked_source_id, created_at, '
    + 'o:financial_account!fin_transfer_intent_from_account_id_fkey(nombre), d:financial_account!fin_transfer_intent_to_account_id_fkey(nombre)');
  return rows.map(({ o, d, ...x }) => ({ ...x, amount: Number(x.amount), origen: o?.nombre ?? '—', destino: d?.nombre ?? '—' }));
}

export function registerTransferIntent(client: SupabaseClient, p: { fromAccountId: string; toAccountId: string; amount: number; effectiveDate: string; idempotencyKey: string; reason?: string | null }) {
  return callRpc<{ intent_id: number; replayed: boolean; status: IntentStatus }>(client, 'fin_register_transfer_intent', {
    p_from_account_id: p.fromAccountId, p_to_account_id: p.toAccountId, p_amount: p.amount, p_effective_date: p.effectiveDate,
    p_idempotency_key: p.idempotencyKey, p_reason: p.reason?.trim() || null,
  });
}
/** Exactly one of the Mercado Pago movement (the server creates the transfer) or an existing transfer operation. */
export function linkTransferIntent(client: SupabaseClient, p: { intentId: number; sourceId?: string | null; operationId?: number | null }) {
  return callRpc<{ intent_id: number; replayed: boolean; transfer_operation_id: number }>(client, 'fin_link_transfer_intent', {
    p_intent_id: p.intentId, p_source_id: p.sourceId ?? null, p_operation_id: p.operationId ?? null,
  });
}
export function cancelTransferIntent(client: SupabaseClient, p: { intentId: number; reason: string }) {
  return callRpc<{ intent_id: number; replayed: boolean }>(client, 'fin_cancel_transfer_intent', { p_intent_id: p.intentId, p_reason: p.reason });
}

/** What can settle an intent: Mercado Pago movements of exactly its amount, and transfers already confirmed between its accounts and not linked. */
export interface IntentCandidate { kind: 'MOVEMENT' | 'TRANSFER'; key: string; label: string; sourceId?: string; operationId?: number }
export function intentCandidates(intent: Pick<TransferIntentRow, 'amount' | 'from_account_id' | 'to_account_id'>, movements: readonly MpCandidate[],
  transfers: readonly Pick<MovementRow, 'operation_id' | 'effective_date' | 'postings' | 'transfer_intent' | 'kind'>[]): IntentCandidate[] {
  const cents = (x: number) => Math.round(x * 100);
  const out: IntentCandidate[] = movements.filter((m) => cents(m.amount) === cents(intent.amount))
    .map((m) => ({ kind: 'MOVEMENT', key: `mov:${m.sourceId}`, label: `Movimiento de Mercado Pago · ${m.label}`, sourceId: m.sourceId }));
  for (const t of transfers) {
    if (t.kind !== 'TRANSFERENCIA' || t.transfer_intent) continue;
    const sale = t.postings.find((p) => p.signed_amount < 0);
    const entra = t.postings.find((p) => p.signed_amount > 0);
    if (t.postings.length === 2 && sale?.account_id === intent.from_account_id && entra?.account_id === intent.to_account_id && cents(entra.signed_amount) === cents(intent.amount)) {
      out.push({ kind: 'TRANSFER', key: `op:${t.operation_id}`, label: `Transferencia ya confirmada · ${t.effective_date} · operación ${t.operation_id}`, operationId: t.operation_id });
    }
  }
  return out;
}

// ── the tax of a transfer ───────────────────────────────────────────────────
export interface RecordedTax { operation_id: number; amount: number; effective_date: string; external_ref: string | null }
/** Debits/credits taxes of the account not related to any transfer (newest first; the window is applied by recordedTaxesNear). */
export async function listUnrelatedTaxes(client: SupabaseClient, accountId: string): Promise<RecordedTax[]> {
  const rows = await readTable<{ financial_operation_id: number; amount: number | string; financial_operation: { effective_date: string; external_ref: string | null } | null }>(client, 'bank_tax_charge',
    (q) => q.eq('financial_account_id', accountId).eq('tax_kind', 'DEBITOS_CREDITOS').is('related_operation_id', null).order('financial_operation_id', { ascending: false }).limit(200),
    'financial_operation_id, amount, financial_operation(effective_date, external_ref)');
  return rows.map((r) => ({ operation_id: Number(r.financial_operation_id), amount: Number(r.amount), effective_date: r.financial_operation?.effective_date ?? '', external_ref: r.financial_operation?.external_ref ?? null }));
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
/** The taxes that can be this transfer's: within 3 days of it, the closest first (the same window the statement uses, 0116). */
export function recordedTaxesNear(taxes: readonly RecordedTax[], transferDate: string, days = 3): RecordedTax[] {
  return taxes.filter((t) => t.effective_date !== '' && Math.abs(dayDiff(t.effective_date, transferDate)) <= days)
    .sort((a, b) => Math.abs(dayDiff(a.effective_date, transferDate)) - Math.abs(dayDiff(b.effective_date, transferDate)) || a.operation_id - b.operation_id);
}
/** A typed amount equal to a recorded tax near the transfer: probably the same charge — associate it instead of recording it again. */
export const sameAmountTax = (taxes: readonly RecordedTax[], amount: number) => taxes.find((t) => Math.round(t.amount * 100) === Math.round(amount * 100)) ?? null;
export function relateBankTax(client: SupabaseClient, p: { taxOperationId: number; transferOperationId: number; reason?: string | null }) {
  return callRpc<{ tax_operation_id: number; replayed: boolean }>(client, 'fin_relate_bank_tax', {
    p_tax_operation_id: p.taxOperationId, p_transfer_operation_id: p.transferOperationId, p_reason: p.reason?.trim() || null,
  });
}
