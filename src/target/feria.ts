/**
 * Phase 27 (F27-F) — Feria sales sessions over the target schema (RPC_CONTRACTS_V1 30–33; PHASE_21_FERIA;
 * report_feria_session_cash, Phase 25 V4). Roles: Feria is ADMIN-only in V1 (ADR-009) — opening, goods movements
 * (dispatch, return, loss, adjustment), cash events (expense, withdrawal, transfer out, physical COUNT) and closing
 * all carry the ADMIN guard in the backend; OPERATOR has no Feria capability.
 *
 * Authority split:
 *   - Every write is an RPC. The backend posts the money (expenses / withdrawals / transfers), records a COUNT as a
 *     pure observation, and on close turns the aggregated retail lines into the CONSUMIDOR FINAL Pedido.
 *   - The cash reconciliation is the view's: expected = opening fund − expenses − withdrawals − transfers out, and
 *     each COUNT's variance against it stays visible (never forced to 0, never auto-corrected; Phase 21 K2/K3).
 *     This is the Feria session count only — the general cash count (arqueos) is retired in V1 (P27-D1).
 *   - There is no rectification RPC for sessions: a closed session cannot receive movements or cash events.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AttachmentMeta } from './attachments';
import { callRpc, readTable, readView, TargetDbError } from './db';

export const SESSION_MOVEMENT_TYPES = ['DISPATCH', 'RETURN', 'LOSS', 'ADJUSTMENT'] as const;
export type SessionMovementType = (typeof SESSION_MOVEMENT_TYPES)[number];
/** OPENING_FUND is registered only by open_sales_session (the RPC refuses it as a cash event). */
export const SESSION_CASH_EVENT_TYPES = ['EXPENSE', 'WITHDRAWAL', 'TRANSFER_OUT', 'COUNT'] as const;
export type SessionCashEventType = (typeof SESSION_CASH_EVENT_TYPES)[number];

export interface SessionRow {
  id: string; session_date: string; location: string | null; estado: 'OPEN' | 'CLOSED'; aggregated_pedido_id: string | null;
  opened_at: string; closed_at: string | null;
}
export interface SessionMovementRow {
  id: number; sales_session_id: string; movement_type: SessionMovementType; producto_id: string; producto_nombre: string; cantidad: number;
  reason: string | null; created_at: string;
}
/** One row per session without a count, or one row per COUNT observation (values as the view reports them). */
export interface SessionCashRow {
  sales_session_id: string; business_date: string; location: string | null; estado: 'OPEN' | 'CLOSED'; opening_fund: number; expenses: number;
  withdrawals: number; transfers_out: number; expected_cash: number; count_events: number; count_event_id: number | null;
  count_date: string | null; counted_cash: number | null; variance: number | null;
}
export interface AggregatedLine { producto_id: string; cantidad: number; precio_unitario: number }

const num = (v: unknown) => Number(v ?? 0);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const reasonOrNull = (r?: string | null) => (r && r.trim() !== '' ? r.trim() : null);

// ── reads ───────────────────────────────────────────────────────────────────

/** Sessions visible to the caller (RLS: all for ADMIN, OPEN ones for OPERATOR), newest first. */
export function listSessions(client: SupabaseClient, limit = 60): Promise<SessionRow[]> {
  return readTable<SessionRow>(client, 'sales_session', (q) => q.order('session_date', { ascending: false }).limit(limit),
    'id, session_date, location, estado, aggregated_pedido_id, opened_at, closed_at');
}

export async function listSessionMovements(client: SupabaseClient, sessionId: string): Promise<SessionMovementRow[]> {
  const rows = await readTable<Omit<SessionMovementRow, 'producto_nombre'> & { products: { nombre: string } | null }>(client, 'sales_session_movement',
    (q) => q.eq('sales_session_id', sessionId).order('created_at', { ascending: false }),
    'id, sales_session_id, movement_type, producto_id, cantidad, reason, created_at, products(nombre)');
  return rows.map(({ products, ...m }) => ({ ...m, cantidad: num(m.cantidad), producto_nombre: products?.nombre ?? '—' }));
}

/** report_feria_session_cash (ADMIN) in [from, to], newest first. */
export async function listSessionCash(client: SupabaseClient, from: string, to: string): Promise<SessionCashRow[]> {
  const rows = await readView<SessionCashRow>(client, 'report_feria_session_cash',
    (q) => q.gte('business_date', from).lte('business_date', to).order('business_date', { ascending: false }));
  return rows.map((r) => ({
    ...r, opening_fund: num(r.opening_fund), expenses: num(r.expenses), withdrawals: num(r.withdrawals), transfers_out: num(r.transfers_out),
    expected_cash: num(r.expected_cash), count_events: num(r.count_events), counted_cash: numOrNull(r.counted_cash), variance: numOrNull(r.variance),
  }));
}

// ── writes (RPCs 30–33) ─────────────────────────────────────────────────────

/** ADMIN. An opening fund needs a cash account (ACCOUNT_REQUIRED); one session per idempotency key. */
export function openSalesSession(client: SupabaseClient, p: {
  date: string; location: string; idempotencyKey: string; openingFund?: number; cashAccountId?: string | null;
}) {
  return callRpc<{ session_id: string; estado: 'OPEN' }>(client, 'open_sales_session', {
    p_session_date: p.date, p_location: p.location, p_idempotency_key: p.idempotencyKey, p_opening_fund: p.openingFund ?? 0,
    p_cash_account_id: p.cashAccountId ?? null,
  });
}

/** ADMIN (ADR-009) on an OPEN session; losses and adjustments need a reason (backend rule). */
export function registerSessionMovement(client: SupabaseClient, p: {
  sessionId: string; type: SessionMovementType; productoId: string; cantidad: number; reason?: string | null;
}) {
  return callRpc<{ movement_id: number }>(client, 'register_session_movement', {
    p_session_id: p.sessionId, p_movement_type: p.type, p_producto_id: p.productoId, p_cantidad: p.cantidad, p_reason: reasonOrNull(p.reason),
  });
}

/** ADMIN. COUNT records the physically counted cash (no posting); the other events move money on the account. */
export function registerSessionCashEvent(client: SupabaseClient, p: {
  sessionId: string; type: SessionCashEventType; amount: number; accountId?: string | null; categoryId?: string | null;
  destinationAccountId?: string | null; reason?: string | null;
}) {
  return callRpc<{ event_id: number; financial_operation_id: number | null }>(client, 'register_session_cash_event', {
    p_session_id: p.sessionId, p_event_type: p.type, p_amount: p.amount, p_financial_account_id: p.accountId ?? null,
    p_expense_category_id: p.categoryId ?? null, p_destination_account_id: p.destinationAccountId ?? null, p_reason: reasonOrNull(p.reason),
  });
}

/** ADMIN. The aggregated retail lines become the CONSUMIDOR FINAL Pedido (empty array = no retail sale). */
export function closeSalesSession(client: SupabaseClient, p: { sessionId: string; lines: AggregatedLine[]; reason?: string | null }) {
  return callRpc<{ session_id: string; estado: 'CLOSED'; aggregated_pedido_id: string | null; aggregated_total: number }>(client, 'close_sales_session', {
    p_session_id: p.sessionId,
    p_aggregated_lines: p.lines.map((l) => ({ producto_id: l.producto_id, cantidad: l.cantidad, precio_unitario: l.precio_unitario })),
    p_reason: reasonOrNull(p.reason),
  });
}

// ── ADR-016: Feria V1 summarized closing (RPCs 51–52, report_feria_closing, bucket `feria-worksheets`) ──────────
// The worksheet (paper / spreadsheet) stays the detailed record. The app sends only the summary amounts; every
// derived value (total sales, expected cash, cash difference) and every accounting / treasury effect is the
// backend's. React never computes an authoritative figure.

/** One version of a summarized closing, as report_feria_closing reports it (derived values computed by the view). */
export interface FeriaClosingRow {
  closing_id: string; sales_session_id: string; closing_date: string; location: string | null; version_seq: number; is_current: boolean;
  supersedes_id: string | null; rectification_reason: string | null;
  cash_sales: number; mp_sales: number; transfer_sales: number; total_sales: number; opening_float: number; expenses: number;
  expected_cash: number; counted_cash: number; cash_difference: number;
  cash_account_id: string; cash_account_name: string; transfer_account_id: string | null; transfer_account_name: string | null;
  merma: number | null; notes: string | null; has_worksheet: boolean; worksheet_path: string | null; worksheet_file_name: string | null;
  created_at: string;
}

/** Summary inputs of a closing (stored as entered; nothing derived). */
export interface FeriaClosingInput {
  cashSales: number; mpSales: number; transferSales: number; expenses: number; countedCash: number;
  cashAccountId: string; transferAccountId?: string | null; openingFloat?: number; merma?: number | null; notes?: string | null;
}

export async function listFeriaClosings(client: SupabaseClient, from: string, to: string): Promise<FeriaClosingRow[]> {
  const rows = await readView<FeriaClosingRow>(client, 'report_feria_closing',
    (q) => q.gte('closing_date', from).lte('closing_date', to).order('closing_date', { ascending: false }).order('version_seq', { ascending: false }));
  return rows.map((r) => ({
    ...r, cash_sales: num(r.cash_sales), mp_sales: num(r.mp_sales), transfer_sales: num(r.transfer_sales), total_sales: num(r.total_sales),
    opening_float: num(r.opening_float), expenses: num(r.expenses), expected_cash: num(r.expected_cash), counted_cash: num(r.counted_cash),
    cash_difference: num(r.cash_difference), merma: numOrNull(r.merma),
  }));
}

const closingArgs = (p: FeriaClosingInput, worksheet: AttachmentMeta | null) => ({
  p_cash_sales: p.cashSales, p_mp_sales: p.mpSales, p_transfer_sales: p.transferSales, p_expenses: p.expenses, p_counted_cash: p.countedCash,
  p_cash_account_id: p.cashAccountId, p_transfer_account_id: p.transferSales > 0 ? (p.transferAccountId ?? null) : null,
  p_opening_float: p.openingFloat ?? 0, p_merma: p.merma ?? null, p_notes: reasonOrNull(p.notes), p_worksheet: worksheet,
});

type ClosingResult = { closing_id: string; total_sales: number; expected_cash: number; cash_difference: number };

/** RPC 51 (ADMIN) on an OPEN session. */
export function closeFeriaSummary(client: SupabaseClient, p: FeriaClosingInput & { sessionId: string; worksheet?: AttachmentMeta | null }) {
  return callRpc<ClosingResult & { aggregated_pedido_id: string | null }>(client, 'close_feria_summary',
    { p_session_id: p.sessionId, ...closingArgs(p, p.worksheet ?? null) });
}

/** RPC 52 (ADMIN): replaces the current version; the original stays immutable. keepWorksheet carries the previous file. */
export function rectifyFeriaClosing(client: SupabaseClient, p: FeriaClosingInput & {
  closingId: string; reason: string; worksheet?: AttachmentMeta | null; keepWorksheet?: boolean;
}) {
  return callRpc<ClosingResult & { superseded_id: string; version_seq: number }>(client, 'rectify_feria_closing', {
    p_closing_id: p.closingId, p_reason: p.reason, ...closingArgs(p, p.worksheet ?? null), p_keep_worksheet: p.keepWorksheet ?? true,
  });
}

/**
 * "Cierre de Feria" in one step for a new date: opens the session (RPC 30, no opening-fund event: the float is a
 * closing input) and closes it summarized (RPC 51). Retrying with the same idempotency key reuses the session the
 * failed attempt opened (DUPLICATE_SESSION → look it up), so a failed close never leaves a second session.
 */
export async function openAndCloseFeria(client: SupabaseClient, p: FeriaClosingInput & {
  date: string; location: string; idempotencyKey: string; worksheet: AttachmentMeta | null;
}) {
  let sessionId: string;
  try {
    sessionId = (await openSalesSession(client, { date: p.date, location: p.location, idempotencyKey: p.idempotencyKey })).session_id;
  } catch (err) {
    if (!(err instanceof TargetDbError) || err.code !== 'DUPLICATE_SESSION') throw err;
    const rows = await readTable<{ id: string }>(client, 'sales_session', (q) => q.eq('idempotency_key', p.idempotencyKey).limit(1), 'id');
    if (!rows[0]) throw err;
    sessionId = rows[0].id;
  }
  return closeFeriaSummary(client, { ...p, sessionId });
}
