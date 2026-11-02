/**
 * Caja → Movimientos (0113): the unified financial history, read from fin_movement_history (ADMIN). One row per financial
 * operation, from the first one; the page, the total and the filters are the server's, nothing is downloaded to filter here.
 * Declared collections and unpaid obligations have no operation, so they are not movements.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { importe } from './bankReconciliation';
import { callRpc } from './db';

export const MOVEMENT_PAGE = 50;
export type MovementKind = 'TRANSFERENCIA' | 'COBRO' | 'PAGO' | 'CARGO' | 'PENDIENTE_MP' | 'OTRO';
export const MOVEMENT_KIND_LABEL: Record<MovementKind, string> = {
  TRANSFERENCIA: 'Transferencias', COBRO: 'Cobros', PAGO: 'Pagos', CARGO: 'Cargos e impuestos', PENDIENTE_MP: 'Mercado Pago sin clasificar', OTRO: 'Otros',
};

export interface MovementFilter { from?: string; to?: string; accountId?: string; kind?: MovementKind; search?: string }
export interface MovementPosting { posting_id: number; account_id: string; account_name: string; signed_amount: number }
export interface MovementRow {
  operation_id: number; effective_date: string; kind: MovementKind; label: string; operation_type: string; reason: string | null; external_ref: string | null;
  source_entity_type: string | null; created_at: string; created_by: string | null;
  /** Net of the operation in the chosen account (all of them without one): 0 for a transfer between own accounts. */
  net_amount: number;
  /** What the operation moved, whichever the account: the amount of a transfer. */
  moved_amount: number;
  postings: MovementPosting[];
}
export interface MovementPage { rows: MovementRow[]; total: number }

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

export async function listMovementHistory(client: SupabaseClient, f: MovementFilter, page = 0, pageSize = MOVEMENT_PAGE): Promise<MovementPage> {
  const search = f.search?.trim() || null;
  const r = await callRpc<{ total: number; rows: MovementRow[] }>(client, 'fin_movement_history', {
    p_from: f.from || null, p_to: f.to || null, p_account_id: f.accountId || null, p_kind: f.kind || null, p_search: search,
    p_amount: search ? parseAmountSearch(search) : null, p_limit: pageSize, p_offset: page * pageSize,
  });
  return {
    total: Number(r.total),
    rows: r.rows.map((x) => ({ ...x, net_amount: Number(x.net_amount), moved_amount: Number(x.moved_amount),
      postings: x.postings.map((p) => ({ ...p, signed_amount: Number(p.signed_amount) })) })),
  };
}
