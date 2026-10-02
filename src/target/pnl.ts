/**
 * Phase 27 (F27-G) — P&L and management events over the target schema (ADR-004; Phase 24 views pnl_summary /
 * pnl_line_item, both security_invoker and ADMIN-only through the underlying RLS; RPC 43 register_management_event,
 * ADMIN-only).
 *
 * Every accounting number is the view's: the monthly result lines come from pnl_summary exactly as reported, and the
 * drill-down lists pnl_line_item rows as they are. Nothing here adds, nets or re-classifies amounts.
 * Management events are ADR-004 D9 source decisions: RETIRO (moves money out of a financial account) and
 * RESERVA_INTERNA (moves no money); either can be compensated by a later event of the same type.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';

/** pnl_summary columns in the order of the ADR-004 P&L cascade, with their display labels. */
export const PNL_LINES = [
  ['ventas_netas_devengadas', 'Ventas netas devengadas'],
  ['costos_directos', 'Costos directos'],
  ['costos_indirectos', 'Costos indirectos'],
  ['diferencia_caja', 'Diferencia de caja'],   // ADR-016: Feria counted − expected (shortage < 0, overage > 0)
  ['resultado_operativo', 'Resultado operativo'],
  ['otros_ingresos_financieros', 'Otros ingresos financieros'],
  ['resultado_antes_de_reinversion', 'Resultado antes de reinversión'],
  ['reinversion', 'Reinversión'],
  ['resultado_post_reinversion', 'Resultado post reinversión'],
  ['retiros', 'Retiros'],
  ['disponible_post_retiros', 'Disponible post retiros'],
  ['reservas_internas', 'Reservas internas'],
  ['post_reservas', 'Post reservas'],
  ['inversiones', 'Inversiones'],
  ['resultado_post_inversiones', 'Resultado post inversiones'],
] as const;
export type PnlColumn = (typeof PNL_LINES)[number][0];
export type PnlSummaryRow = { period: string } & Record<PnlColumn, number>;
/** The result lines of the cascade (shown emphasised); the others are its components. */
export const PNL_RESULT_LINES: readonly PnlColumn[] = [
  'resultado_operativo', 'resultado_antes_de_reinversion', 'resultado_post_reinversion', 'disponible_post_retiros', 'post_reservas',
  'resultado_post_inversiones',
];

export interface PnlLineItem {
  bucket: string; business_date: string; period: string; signed_amount: number; source_entity_type: string; source_entity_id: string;
  expense_category_id: string | null; nature: string | null; project_id: string | null; description: string | null;
}
export const MANAGEMENT_EVENT_TYPES = ['RETIRO', 'RESERVA_INTERNA'] as const;
export type ManagementEventType = (typeof MANAGEMENT_EVENT_TYPES)[number];
export interface ManagementEventRow {
  id: string; event_type: ManagementEventType; effective_date: string; amount: number; compensates_event_id: string | null;
  financial_account_id: string | null; reason: string | null; created_at: string;
}

const num = (v: unknown) => Number(v ?? 0);

/** pnl_summary periods in [fromPeriod, toPeriod] (first days of month), oldest first, values as reported. */
export async function listPnlSummary(client: SupabaseClient, fromPeriod: string, toPeriod: string): Promise<PnlSummaryRow[]> {
  const rows = await readView<Record<string, unknown>>(client, 'pnl_summary',
    (q) => q.gte('period', fromPeriod).lte('period', toPeriod).order('period', { ascending: true }));
  return rows.map((r) => {
    const out = { period: String(r.period) } as PnlSummaryRow;
    for (const [col] of PNL_LINES) out[col] = num(r[col]);
    return out;
  });
}

/** pnl_line_item rows of one period, by bucket then date (the drill-down; rows as reported, never summed here). */
export async function listPnlLineItems(client: SupabaseClient, period: string): Promise<PnlLineItem[]> {
  const rows = await readView<PnlLineItem>(client, 'pnl_line_item',
    (q) => q.eq('period', period).order('bucket').order('business_date'));
  return rows.map((r) => ({ ...r, signed_amount: num(r.signed_amount) }));
}

export async function listManagementEvents(client: SupabaseClient, limit = 100): Promise<ManagementEventRow[]> {
  const rows = await readTable<ManagementEventRow>(client, 'management_event', (q) => q.order('effective_date', { ascending: false }).limit(limit),
    'id, event_type, effective_date, amount, compensates_event_id, financial_account_id, reason, created_at');
  return rows.map((r) => ({ ...r, amount: num(r.amount) }));
}

/**
 * RPC 43 (ADMIN). RETIRO needs the account the money leaves (ACCOUNT_REQUIRED); RESERVA_INTERNA must not have one
 * (ACCOUNT_NOT_ALLOWED); a reason is required; the idempotency key is 1–95 characters.
 */
export function registerManagementEvent(client: SupabaseClient, p: {
  type: ManagementEventType; effectiveDate: string; amount: number; idempotencyKey: string; reason: string;
  accountId?: string | null; compensatesEventId?: string | null;
}) {
  return callRpc<{ management_event_id: string; financial_operation_id: number | null }>(client, 'register_management_event', {
    p_event_type: p.type, p_effective_date: p.effectiveDate, p_amount: p.amount, p_idempotency_key: p.idempotencyKey, p_reason: p.reason,
    p_financial_account_id: p.accountId ?? null, p_compensates_event_id: p.compensatesEventId ?? null,
  });
}
