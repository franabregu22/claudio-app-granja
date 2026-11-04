/**
 * Caja → Movimientos (0113): the unified financial history, read from fin_movement_history (ADMIN). One row per financial
 * operation, from the first one; the page, the total and the filters are the server's, nothing is downloaded to filter here.
 * Declared collections and unpaid obligations have no operation, so they are not movements.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { importe } from './bankReconciliation';
import { callRpc } from './db';

export const MOVEMENT_PAGE = 50;
export type MovementKind = 'TRANSFERENCIA' | 'COBRO' | 'PAGO' | 'CARGO' | 'PENDIENTE_MP' | 'OTRO' | 'SIN_VINCULAR';
export const MOVEMENT_KIND_LABEL: Record<MovementKind, string> = {
  TRANSFERENCIA: 'Transferencias', COBRO: 'Cobros', PAGO: 'Pagos', CARGO: 'Cargos e impuestos', PENDIENTE_MP: 'Mercado Pago sin clasificar', OTRO: 'Otros',
  SIN_VINCULAR: 'Movimientos bancarios sin vincular',
};

/** 0116: Caja → Movimientos → Por resolver, applied as a filter of the same list (its count is the indicator's count). */
export type PendingFilter = 'MP_CLASIFICAR' | 'GASTO_SIN_CLASIFICAR' | 'ENTRADA_SIN_VINCULAR';
export type PendingScopeFilter = 'CURRENT' | 'HISTORICAL';
export const PENDING_FILTER_LABEL: Record<PendingFilter, string> = {
  MP_CLASIFICAR: 'Pendientes de clasificar', GASTO_SIN_CLASIFICAR: 'Gastos sin clasificar', ENTRADA_SIN_VINCULAR: 'Entradas sin vincular',
};
/** What a pending needs: a mandatory classification, or an optional link (an unlinked inflow is a valid permanent state). */
export const PENDING_FILTER_REQUIRED: Record<PendingFilter, boolean> = { MP_CLASIFICAR: true, GASTO_SIN_CLASIFICAR: true, ENTRADA_SIN_VINCULAR: false };
/** Only these two have current / historical rows. */
export const pendingHasScope = (p: PendingFilter) => p !== 'GASTO_SIN_CLASIFICAR';

export interface MovementFilter { from?: string; to?: string; accountId?: string; kind?: MovementKind; search?: string; pending?: PendingFilter; scope?: PendingScopeFilter }
export interface MovementPosting { posting_id: number; account_id: string; account_name: string; account_type?: string; signed_amount: number }

/** The state of a row: what is recorded, what the bank / Mercado Pago confirmed, what still needs someone. */
export type MovementStatus = 'REGISTRADO' | 'CONCILIADO' | 'SIN_CONCILIAR' | 'PENDIENTE_CLASIFICAR' | 'SIN_CLASIFICAR' | 'SIN_VINCULAR';
export interface BankEvidence {
  statement_line_id: number; account_name: string; value_date: string; description_raw: string; bank_reference: string | null;
  signed_amount: number; running_balance: number | null; matched_at: string | null;
}
export interface MpEvidence { movement_id: number; occurred_date: string; movement_kind: string; gross_amount: number; net_amount: number; assigned_amount: number; source_id: string | null }
export type PendingKey =
  | { type: 'MP_CLASIFICAR'; source_id: string; historical: boolean }
  | { type: 'GASTO_SIN_CLASIFICAR'; pending_id: number }
  | { type: 'ENTRADA_SIN_VINCULAR'; movement_id: number; source_id: string; historical: boolean };
export interface RelatedTax { operation_id: number; amount: number; account_name: string; matched: boolean }

export interface MovementRow {
  row_type: 'OP';
  operation_id: number; effective_date: string; kind: MovementKind; label: string; operation_type: string; reason: string | null; external_ref: string | null;
  source_entity_type: string | null; created_at: string; created_by: string | null;
  /** Net of the operation in the chosen account (all of them without one): 0 for a transfer between own accounts. */
  net_amount: number;
  /** What the operation moved, whichever the account: the amount of a transfer. */
  moved_amount: number;
  postings: MovementPosting[];
  status: MovementStatus;
  bank: BankEvidence[];
  mp: MpEvidence[];
  /** Set only under a Por resolver filter: the key its action needs. */
  pending: PendingKey | null;
  related_taxes: RelatedTax[] | null;
  transfer_intent: { intent_id: number; effective_date: string } | null;
}
/** A bank statement line after the active cut with no match: bank evidence still to resolve, listed once. */
export interface BankLineRow {
  row_type: 'LINE';
  statement_line_id: number; effective_date: string; kind: 'SIN_VINCULAR'; label: string; status: 'SIN_VINCULAR';
  account_id: string; account_name: string; description_raw: string; bank_reference: string | null; signed_amount: number; running_balance: number | null;
  charge: { status: string; kind: string | null; label: string | null } | null;
}
export type ListRow = MovementRow | BankLineRow;
export interface MovementListPage { rows: ListRow[]; total: number; linesTotal: number }

export const MOVEMENT_STATUS_LABEL: Record<MovementStatus, string> = {
  REGISTRADO: 'Registrado', CONCILIADO: 'Conciliado', SIN_CONCILIAR: 'Sin conciliar', PENDIENTE_CLASIFICAR: 'Pendiente de clasificar',
  SIN_CLASIFICAR: 'Sin clasificar', SIN_VINCULAR: 'Sin vincular',
};
/** A transfer reads in its own words: recorded, waiting for its bank / Mercado Pago evidence, or reconciled. */
export function rowStatusLabel(r: Pick<ListRow, 'status' | 'kind'>): string {
  if (r.kind === 'TRANSFERENCIA') return r.status === 'CONCILIADO' ? 'Conciliada' : r.status === 'SIN_CONCILIAR' ? 'Pendiente de vinculación' : 'Registrada';
  return MOVEMENT_STATUS_LABEL[r.status];
}
/** Needs someone (amber) / done (green) / just recorded (neutral). */
export function rowStatusTone(s: MovementStatus): 'action' | 'done' | 'neutral' {
  if (s === 'PENDIENTE_CLASIFICAR' || s === 'SIN_CLASIFICAR' || s === 'SIN_CONCILIAR' || s === 'SIN_VINCULAR') return 'action';
  return s === 'CONCILIADO' ? 'done' : 'neutral';
}
export const rowKey = (r: ListRow) => (r.row_type === 'OP' ? `op:${r.operation_id}` : `line:${r.statement_line_id}`);
/** The Mercado Pago SOURCE_ID of a provisional outflow ("MP-PENDING:<id>"): its classification works without the Por resolver filter too. */
export const pendingMpSource = (r: Pick<MovementRow, 'kind' | 'external_ref'>) =>
  (r.kind === 'PENDIENTE_MP' && r.external_ref?.startsWith('MP-PENDING:') ? r.external_ref.slice('MP-PENDING:'.length) : null);

/**
 * The amount a search text can mean, written the Argentine or the plain way ("$ 1.234,50", "1234,5", "1234.50", "1.234"), or null
 * when it is not a number. A point followed by three digits is a thousands separator; the text is still searched as text.
 */
export function parseAmountSearch(text: string): number | null {
  const t = text.replace(/[$\s]/g, '');
  if (!/^\d[\d.,]*$/.test(t)) return null;
  const miles = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t);
  const plano = /^\d+([.,]\d{1,2})?$/.test(t);
  if (!miles && !plano) return null;
  const n = Number((miles ? t.replace(/\./g, '') : t).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Each row's shown amount, to the cent: signed in its account; a transfer seen from all the accounts has no sign. */
export const movementSign = (r: Pick<MovementRow, 'net_amount'>): 'IN' | 'OUT' | 'NEUTRAL' => (r.net_amount > 0 ? 'IN' : r.net_amount < 0 ? 'OUT' : 'NEUTRAL');
export const movementAmount = (r: Pick<MovementRow, 'net_amount' | 'moved_amount'>) => (r.net_amount === 0 ? importe(r.moved_amount) : importe(r.net_amount, true));

/** "Caja chica → BNA" for several accounts (money leaves first), the account name for one. */
export function movementAccounts(r: Pick<MovementRow, 'postings'>): string {
  const salen = r.postings.filter((p) => p.signed_amount < 0).map((p) => p.account_name);
  const entran = r.postings.filter((p) => p.signed_amount > 0).map((p) => p.account_name);
  return salen.length > 0 && entran.length > 0 ? `${salen.join(', ')} → ${entran.join(', ')}` : [...salen, ...entran].join(', ');
}

/** The recorded reason, unless it is a technical trace ("ADR-018 auto-apply"); the operation detail always shows it. */
export const movementNote = (r: Pick<MovementRow, 'reason'>) => (r.reason && !/^(ADR-?\d|phase\d)/i.test(r.reason) ? r.reason : null);

/**
 * 0116 — the unified list (fin_movement_list): operations with their state and evidence, the bank lines still to resolve, and the
 * Por resolver filters. Paged, counted and filtered by the server.
 */
export async function listMovements(client: SupabaseClient, f: MovementFilter, page = 0, pageSize = MOVEMENT_PAGE): Promise<MovementListPage> {
  const search = f.search?.trim() || null;
  const r = await callRpc<{ total: number; lines_total: number; rows: ListRow[] }>(client, 'fin_movement_list', {
    p_from: f.from || null, p_to: f.to || null, p_account_id: f.accountId || null, p_kind: f.kind || null, p_search: search,
    p_amount: search ? parseAmountSearch(search) : null, p_pending: f.pending || null, p_scope: f.pending && pendingHasScope(f.pending) ? f.scope || null : null,
    p_limit: pageSize, p_offset: page * pageSize,
  });
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    total: Number(r.total), linesTotal: Number(r.lines_total),
    rows: r.rows.map((x): ListRow => (x.row_type === 'LINE'
      ? { ...x, signed_amount: Number(x.signed_amount), running_balance: n(x.running_balance) }
      : { ...x, net_amount: Number(x.net_amount), moved_amount: Number(x.moved_amount),
          postings: x.postings.map((p) => ({ ...p, signed_amount: Number(p.signed_amount) })),
          bank: (x.bank ?? []).map((b) => ({ ...b, signed_amount: Number(b.signed_amount), running_balance: n(b.running_balance) })),
          mp: (x.mp ?? []).map((m) => ({ ...m, gross_amount: Number(m.gross_amount), net_amount: Number(m.net_amount), assigned_amount: Number(m.assigned_amount) })),
          related_taxes: x.related_taxes === null ? null : x.related_taxes.map((t) => ({ ...t, amount: Number(t.amount) })),
          pending: x.pending ? (x.pending.type === 'GASTO_SIN_CLASIFICAR' ? { ...x.pending, pending_id: Number(x.pending.pending_id) }
            : x.pending.type === 'ENTRADA_SIN_VINCULAR' ? { ...x.pending, movement_id: Number(x.pending.movement_id) } : x.pending) : null })),
  };
}
