/**
 * ADR-021 (0093) — Caja → Pendientes de clasificar. A real Mercado Pago outflow (payout / outbound payment) reaches the
 * balance when the release report is processed (one provisional per SOURCE_ID); the classification only gives it its
 * economic meaning and never moves Mercado Pago again. Inflows from an own account awaiting classification are listed too
 * (they reach the balance when classified). Receipts without an assigned client are NOT pending classification.
 * Technical exceptions (an outflow that could not be posted, report rows in error) are a separate list.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readView } from './db';

/** INFLOW (0094, ADR-022): a historical CVU / DEBIN receipt, already in the balance, awaiting classification (no action yet). */
export type PendingKind = 'PAYOUT' | 'OUTBOUND' | 'CLASSIFY_INFLOW' | 'INFLOW';
export interface PendingRow {
  pending_key: string; source_id: string; kind: PendingKind; direction: 'OUT' | 'IN'; business_date: string; occurred_at: string | null;
  /** signed: an outflow is the report's net debit (negative), an inflow its gross (positive) */
  amount: number;
  /** the economic amount the classification receives (|gross|); the taxes / fees are applied apart */
  economic_amount: number; charges_amount: number; account_name: string; description: string; status: 'PENDING';
  /** true when the amount is already in the account balance (outflows, ADR-021) */
  already_posted: boolean; financial_operation_id: number | null;
}
const PENDING_COLUMNS = 'pending_key, source_id, kind, direction, business_date, occurred_at, amount, economic_amount, charges_amount, '
  + 'account_name, description, status, already_posted, financial_operation_id';

export type TechnicalIssue = 'UNPOSTED_OUTFLOW' | 'REPORT_ROW_ERROR';
export interface TechnicalRow {
  issue: TechnicalIssue; source_id: string; description: string; business_date: string; occurred_at: string | null;
  amount: number | null; review_code: string | null; note: string | null;
}
const TECH_COLUMNS = 'issue, source_id, description, business_date, occurred_at, amount, review_code, note';

const num = (v: unknown) => Number(v ?? 0);

/** Everything waiting for a human classification, oldest first. */
export async function listPendingClassification(client: SupabaseClient): Promise<PendingRow[]> {
  const rows = await readView<PendingRow>(client, 'fin_mp_pending_classification',
    (q) => q.order('business_date', { ascending: true }).order('occurred_at', { ascending: true, nullsFirst: true }), PENDING_COLUMNS);
  return rows.map((r) => ({ ...r, amount: num(r.amount), economic_amount: num(r.economic_amount), charges_amount: num(r.charges_amount),
    financial_operation_id: r.financial_operation_id === null ? null : Number(r.financial_operation_id) }));
}

/** Technical exceptions, oldest first: never mixed with the pending classifications. */
export async function listTechnicalReview(client: SupabaseClient): Promise<TechnicalRow[]> {
  const rows = await readView<TechnicalRow>(client, 'fin_mp_technical_review',
    (q) => q.order('business_date', { ascending: true }).order('source_id', { ascending: true }), TECH_COLUMNS);
  return rows.map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount) }));
}

/** Card totals: count, outgoing (absolute) and incoming. Never a balance difference: outflows are already in the balance. */
export function summarizePending(rows: readonly Pick<PendingRow, 'direction' | 'amount'>[]): { count: number; outgoing: number; incoming: number } {
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    count: rows.length,
    outgoing: round(rows.filter((r) => r.direction === 'OUT').reduce((s, r) => s + Math.abs(r.amount), 0)),
    incoming: round(rows.filter((r) => r.direction === 'IN').reduce((s, r) => s + r.amount, 0)),
  };
}

/** Recovery of an outflow whose provisional could not be posted (idempotent; the server resolves everything). */
export function postPendingOutflow(client: SupabaseClient, sourceId: string): Promise<{ outcome: string; replayed: boolean }> {
  return callRpc(client, 'mp_post_pending_outflow', { p_source_id: sourceId });
}

export const PENDING_BALANCE_NOTE = 'Estos movimientos ya están incluidos en el saldo. Falta definir su clasificación.';
export const HISTORICAL_INFLOW_ACTION = 'Clasificación histórica: próxima etapa';
export const PENDING_INFLOW_NOTE = 'Ingreso desde una cuenta propia o cobro: se suma al saldo cuando lo clasificás.';
export const PENDING_KIND_LABEL: Record<PendingKind, string> = {
  PAYOUT: 'Retiro', OUTBOUND: 'Pago saliente', CLASSIFY_INFLOW: 'Ingreso (cuenta propia o cobro)', INFLOW: 'Ingreso CVU / DEBIN (histórico)',
};
export const TECHNICAL_ISSUE_LABEL: Record<TechnicalIssue, string> = {
  UNPOSTED_OUTFLOW: 'Salida de Mercado Pago sin registrar', REPORT_ROW_ERROR: 'Fila del reporte con error',
};

/** User-facing name of a posting's operation: the ADR-021 provisional and its release are never a generic "Ajuste". */
export function postingOperationLabel(p: { operation_type: string | null; external_ref: string | null }): string {
  if (p.external_ref?.startsWith('MP-PENDING-RELEASE:')) return 'Clasificación de salida';
  if (p.external_ref?.startsWith('MP-PENDING:')) return 'Pendiente de clasificar';
  return p.operation_type ?? '—';
}
