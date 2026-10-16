/**
 * ADR-021 (0093) / ADR-023 (0095) — Caja → Pendientes de clasificar / Entradas sin vincular.
 *
 * A real Mercado Pago outflow (payout / outbound payment) reaches the balance when the release report is processed (one
 * provisional per SOURCE_ID); its classification is MANDATORY and only gives it its economic meaning — it never moves Mercado
 * Pago again. An INFLOW is never a mandatory classification (ADR-023): it is in the balance and may stay "sin vincular"
 * forever; linking it to a customer (or to an own account) is optional. Counts and totals come from the server
 * (fin_mp_pending_summary); lists are paginated, current pendings are queried apart from the historical ones (ADR-022), so the
 * historical volume can never hide a current pending. Technical exceptions are a separate list.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readView, readViewPage } from './db';

export type PendingKind = 'PAYOUT' | 'OUTBOUND';
export type DestinationStatus = 'OWN_ACCOUNT_TRANSFER_CANDIDATE' | 'THIRD_PARTY' | 'UNKNOWN_DESTINATION';
export interface PendingRow {
  pending_key: string; source_id: string; kind: PendingKind; direction: 'OUT'; business_date: string; occurred_at: string | null;
  /** the report's net debit (negative) */
  amount: number;
  /** the economic amount the classification receives (|gross|); the taxes / fees are applied apart */
  economic_amount: number; charges_amount: number; account_name: string; description: string; status: 'PENDING';
  /** always true: the outflow is already in the account balance (ADR-021) */
  already_posted: boolean; financial_operation_id: number | null;
  /** ADR-022 history (before the cutover) */
  is_historical: boolean;
  /** historical payouts only; never a full account number (last 4 digits at most) */
  destination_status: DestinationStatus | null; destination_last4: string | null; matched_account_name: string | null;
}
const PENDING_COLUMNS = 'pending_key, source_id, kind, direction, business_date, occurred_at, amount, economic_amount, charges_amount, '
  + 'account_name, description, status, already_posted, financial_operation_id, is_historical, destination_status, destination_last4, matched_account_name';

export type PendingScope = 'current' | 'historical';
export interface Page<Row> { rows: Row[]; total: number; page: number; pageSize: number }
export const PAGE_SIZE = 50;

const num = (v: unknown) => Number(v ?? 0);
const toPending = (r: PendingRow): PendingRow => ({ ...r, amount: num(r.amount), economic_amount: num(r.economic_amount), charges_amount: num(r.charges_amount),
  financial_operation_id: r.financial_operation_id === null ? null : Number(r.financial_operation_id) });

/** One page of the mandatory pendings of a scope, oldest first (deterministic: date, then SOURCE_ID). */
export async function listPendingPage(client: SupabaseClient, scope: PendingScope, page = 0, pageSize = PAGE_SIZE): Promise<Page<PendingRow>> {
  const r = await readViewPage<PendingRow>(client, 'fin_mp_pending_classification',
    (q) => q.eq('is_historical', scope === 'historical').order('business_date', { ascending: true }).order('source_id', { ascending: true }),
    PENDING_COLUMNS, page, pageSize);
  return { rows: r.rows.map(toPending), total: r.total, page, pageSize };
}

export type SummaryBucket = 'PENDING_CURRENT' | 'PENDING_HISTORICAL' | 'UNLINKED_CURRENT' | 'UNLINKED_HISTORICAL';
export type PendingSummary = Record<SummaryBucket, { count: number; amount: number }>;
/** Server-side counts / totals (never computed by downloading rows). */
export async function readPendingSummary(client: SupabaseClient): Promise<PendingSummary> {
  const rows = await readView<{ bucket: SummaryBucket; item_count: number; amount: number }>(client, 'fin_mp_pending_summary', (q) => q, 'bucket, item_count, amount');
  const out: PendingSummary = { PENDING_CURRENT: { count: 0, amount: 0 }, PENDING_HISTORICAL: { count: 0, amount: 0 },
    UNLINKED_CURRENT: { count: 0, amount: 0 }, UNLINKED_HISTORICAL: { count: 0, amount: 0 } };
  for (const r of rows) out[r.bucket] = { count: num(r.item_count), amount: num(r.amount) };
  return out;
}
/** The card: mandatory outflows only (current + historical); the total is the absolute amount already in the balance. */
export function mandatoryPending(s: PendingSummary): { count: number; outgoing: number; current: number; historical: number } {
  const round = (x: number) => Math.round(x * 100) / 100;
  return { count: s.PENDING_CURRENT.count + s.PENDING_HISTORICAL.count, outgoing: round(Math.abs(s.PENDING_CURRENT.amount) + Math.abs(s.PENDING_HISTORICAL.amount)),
    current: s.PENDING_CURRENT.count, historical: s.PENDING_HISTORICAL.count };
}

// ── Entradas sin vincular (ADR-023) ─────────────────────────────────────────
export type InflowSubtype = 'CVU' | 'DEBIN' | 'RECEIPT';
export interface UnlinkedInflowRow {
  movement_id: number; source_id: string; occurred_at: string | null; business_date: string; amount: number; net_amount: number;
  inflow_subtype: InflowSubtype; account_fund: boolean; description: string | null; is_historical: boolean; allocated_amount: number; remaining_amount: number;
}
const UNLINKED_COLUMNS = 'movement_id, source_id, occurred_at, business_date, amount, net_amount, inflow_subtype, account_fund, description, is_historical, allocated_amount, remaining_amount';
export interface UnlinkedFilter { scope: 'all' | PendingScope; from?: string; to?: string; min?: number; max?: number; search?: string }

/** PostgREST `or` value: a SOURCE_ID (digits) or a description fragment; anything else is dropped (never injected). */
export function searchClause(search: string | undefined): string | null {
  const s = (search ?? '').trim();
  if (s === '') return null;
  if (/^[0-9]{1,20}$/.test(s)) return `source_id.like.*${s}*`;
  const safe = s.replace(/[^\p{L}\p{N} ._-]/gu, '').trim();
  return safe === '' ? null : `description.ilike.*${safe}*`;
}

/** One page of the unlinked inflows, newest first (deterministic: date, then movement). */
export async function listUnlinkedPage(client: SupabaseClient, f: UnlinkedFilter, page = 0, pageSize = PAGE_SIZE): Promise<Page<UnlinkedInflowRow>> {
  const r = await readViewPage<UnlinkedInflowRow>(client, 'fin_mp_unlinked_inflows', (q) => {
    let x = q;
    if (f.scope !== 'all') x = x.eq('is_historical', f.scope === 'historical');
    if (f.from) x = x.gte('business_date', f.from);
    if (f.to) x = x.lte('business_date', f.to);
    if (f.min !== undefined && Number.isFinite(f.min)) x = x.gte('remaining_amount', f.min);
    if (f.max !== undefined && Number.isFinite(f.max)) x = x.lte('remaining_amount', f.max);
    const s = searchClause(f.search);
    if (s) x = x.or(s);
    return x.order('business_date', { ascending: false }).order('movement_id', { ascending: false });
  }, UNLINKED_COLUMNS, page, pageSize);
  return { rows: r.rows.map((x) => ({ ...x, movement_id: Number(x.movement_id), amount: num(x.amount), net_amount: num(x.net_amount),
    allocated_amount: num(x.allocated_amount), remaining_amount: num(x.remaining_amount) })), total: r.total, page, pageSize };
}

// ── technical review ─────────────────────────────────────────────────────────
export type TechnicalIssue = 'UNPOSTED_OUTFLOW' | 'REPORT_ROW_ERROR';
export interface TechnicalRow {
  issue: TechnicalIssue; source_id: string; description: string; business_date: string; occurred_at: string | null;
  amount: number | null; review_code: string | null; note: string | null;
}
const TECH_COLUMNS = 'issue, source_id, description, business_date, occurred_at, amount, review_code, note';

/** Technical exceptions, oldest first: never mixed with the pending classifications. */
export async function listTechnicalReview(client: SupabaseClient): Promise<TechnicalRow[]> {
  const rows = await readView<TechnicalRow>(client, 'fin_mp_technical_review',
    (q) => q.order('business_date', { ascending: true }).order('source_id', { ascending: true }), TECH_COLUMNS);
  return rows.map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount) }));
}

/** Recovery of an outflow whose provisional could not be posted (idempotent; the server resolves everything). */
export function postPendingOutflow(client: SupabaseClient, sourceId: string): Promise<{ outcome: string; replayed: boolean }> {
  return callRpc(client, 'mp_post_pending_outflow', { p_source_id: sourceId });
}

export const PENDING_BALANCE_NOTE = 'Estos movimientos ya están incluidos en el saldo. Falta definir su clasificación.';
export const HISTORICAL_PENDING_NOTE = 'Salidas anteriores al corte, ya incluidas en el saldo histórico de Mercado Pago. Clasificarlas no modifica el saldo; completa su imputación contable.';
export const HISTORICAL_ACTION = 'Clasificación histórica pendiente (próxima etapa)';
export const UNLINKED_NOTE = 'Entradas de Mercado Pago ya incluidas en el saldo. Vincularlas es opcional: una entrada sin vincular es un estado válido y no bloquea el cierre.';
export const PENDING_KIND_LABEL: Record<PendingKind, string> = { PAYOUT: 'Retiro', OUTBOUND: 'Pago saliente' };
export const DESTINATION_STATUS_LABEL: Record<DestinationStatus, string> = {
  OWN_ACCOUNT_TRANSFER_CANDIDATE: 'Posible transferencia a cuenta propia', THIRD_PARTY: 'Destino de terceros', UNKNOWN_DESTINATION: 'Destino desconocido',
};
export const INFLOW_SUBTYPE_LABEL: Record<InflowSubtype, string> = { CVU: 'Transferencia (CVU)', DEBIN: 'DEBIN', RECEIPT: 'Cobro' };
export const TECHNICAL_ISSUE_LABEL: Record<TechnicalIssue, string> = {
  UNPOSTED_OUTFLOW: 'Salida de Mercado Pago sin registrar', REPORT_ROW_ERROR: 'Fila del reporte con error',
};

/** "****1234" — the only form a payout destination is ever shown in. */
export const maskedAccount = (last4: string | null) => (last4 && /^[0-9]{1,4}$/.test(last4) ? `****${last4}` : null);

/** The two dates of a link: when Mercado Pago received the money and the date the customer ledger takes (ADR-023 §6). */
export function linkDates(r: { source_date?: unknown; effective_date?: unknown }): { recibido: string | null; vinculado: string | null } {
  const d = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return { recibido: d(r.source_date), vinculado: d(r.effective_date) };
}

/** User-facing name of a posting's operation: the ADR-021 provisional and its release are never a generic "Ajuste". */
export function postingOperationLabel(p: { operation_type: string | null; external_ref: string | null }): string {
  if (p.external_ref?.startsWith('MP-PENDING-RELEASE:')) return 'Clasificación de salida';
  if (p.external_ref?.startsWith('MP-PENDING:')) return 'Pendiente de clasificar';
  return p.operation_type ?? '—';
}
