/**
 * ADR-018 §15 — Mercado Pago report activity (read-only). One row per appearance of a processed (NORMAL) release report,
 * from the view fin_mp_report_activity (0079), with its coverage status. It is evidence of what Mercado Pago reported:
 * it never changes the ERP balance, which stays the sum of financial_posting (Movimientos ERP).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readView } from './db';

export type MpCoverageStatus =
  | 'CONTROL' | 'PRE_CUTOVER' | 'RESERVE' | 'COVERED' | 'BACKFILL_PROCESSED' | 'BACKFILL_PENDING' | 'EXCEPTION' | 'YIELD' | 'PAYOUT' | 'OUTBOUND';

export interface MpActivityRow {
  run_id: string; row_number: number; occurred_at: string | null; business_date: string; description: string | null;
  source_id: string | null; net_amount: number | null; gross_amount: number | null; payment_method: string | null;
  payment_method_type: string | null; coverage_status: MpCoverageStatus; financial_operation_id: number | null;
}
const COLUMNS = 'run_id, row_number, occurred_at, business_date, description, source_id, net_amount, gross_amount, payment_method, '
  + 'payment_method_type, coverage_status, financial_operation_id';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Readable coverage status (Caja → Saldos → Mercado Pago → Actividad Mercado Pago). */
export const MP_STATUS_LABEL: Record<MpCoverageStatus, string> = {
  CONTROL: 'Control del reporte',
  PRE_CUTOVER: 'Anterior al corte',
  RESERVE: 'Reserva interna',
  COVERED: 'Cubierto',
  BACKFILL_PROCESSED: 'Recuperado del reporte',
  BACKFILL_PENDING: 'Recuperación pendiente',
  EXCEPTION: 'Excepción',
  YIELD: 'Rendimiento',
  PAYOUT: 'Retiro',
  OUTBOUND: 'Pago saliente (sin efecto)',
};

/** Movement type from the report DESCRIPTION and the sign of the net amount. */
export function mpActivityType(r: Pick<MpActivityRow, 'description' | 'net_amount'>): string {
  switch (r.description) {
    case 'payment': return (r.net_amount ?? 0) < 0 ? 'Pago' : 'Cobro';
    case 'asset_management': return 'Rendimiento';
    case 'payout': return 'Retiro';
    case 'reserve_for_payment': case 'reserve_for_payout': return 'Reserva';
    case null: return 'Control';
    default: return r.description;
  }
}

/** The account's report activity, newest first. Control rows (opening / totals) are returned too; the screen decides. */
export async function listMpActivity(client: SupabaseClient, accountId: string, limit = 1000): Promise<MpActivityRow[]> {
  if (!accountId) return [];
  const rows = await readView<MpActivityRow>(client, 'fin_mp_report_activity', (q) => q.eq('financial_account_id', accountId)
    .order('business_date', { ascending: false }).order('occurred_at', { ascending: false, nullsFirst: false })
    .order('row_number', { ascending: false }).limit(limit), COLUMNS);
  return rows.map((r) => ({ ...r, net_amount: num(r.net_amount), gross_amount: num(r.gross_amount), financial_operation_id: num(r.financial_operation_id) }));
}

/**
 * Rows of the main activity list. CONTROL (report opening balance / totals) and RESERVE (Mercado Pago internal reserve
 * pairs around a payout or an outbound payment) are report mechanics, not movements of the account: they stay in the
 * database and the view as evidence, but the list shows only Cobro / Pago / Rendimiento / Retiro rows.
 */
const HIDDEN: ReadonlySet<MpCoverageStatus> = new Set(['CONTROL', 'RESERVE']);
export const isVisibleActivity = (r: Pick<MpActivityRow, 'coverage_status'>) => !HIDDEN.has(r.coverage_status);

/** The Mercado Pago account, identified exactly as the database functions do (0048 / 0051 / 0078 / 0079). */
export const isMercadoPagoAccount = (a: { nombre: string; account_type: string }) => a.nombre === 'Mercado Pago' && a.account_type === 'EXTERNAL_SERVICE';

/**
 * ADR-018 (0084) — payout destination vs. own accounts, read-only proposal. The server compares the payout destination
 * (stored server-side, never sent here) EXACTLY with the active own-account CBUs and returns only the outcome: never a CBU or any
 * destination value. Nothing is created: no transfer, no posting, no classification (auto-transfer is OFF).
 */
export type MpPayoutMatchStatus = 'OWN_ACCOUNT_EXACT' | 'NO_OWN_ACCOUNT_MATCH' | 'DESTINATION_CONFLICT';
export interface MpPayoutMatch {
  source_id: string; match_status: MpPayoutMatchStatus; matched_account_id: string | null; matched_account_name: string | null;
  confidence: 'HIGH' | 'NONE' | 'REVIEW'; suggested_action: 'PROPOSE_INTERNAL_TRANSFER' | 'CLASSIFY_OUTFLOW' | 'REVIEW_DESTINATION';
}

/** Matches of the account's payouts, keyed by SOURCE_ID (ADMIN only; an empty map when nothing is stored). */
export async function listMpPayoutMatches(client: SupabaseClient, accountId: string): Promise<Map<string, MpPayoutMatch>> {
  if (!accountId) return new Map();
  const rows = await callRpc<MpPayoutMatch[] | null>(client, 'fin_mp_payout_matches', { p_account_id: accountId });
  return new Map((rows ?? []).map((m) => [m.source_id, m]));
}

/** What the Actividad list shows under a payout ("Retiro") row; null when there is nothing to show. */
export function payoutMatchLabel(r: Pick<MpActivityRow, 'description' | 'source_id'>, matches: ReadonlyMap<string, MpPayoutMatch>):
  { title: string; detail: string | null; tone: 'own' | 'classify' | 'review' } | null {
  if (r.description !== 'payout' || !r.source_id) return null;
  const m = matches.get(r.source_id);
  if (!m) return null;
  if (m.match_status === 'OWN_ACCOUNT_EXACT' && m.matched_account_name) {
    return { title: `Transferencia a ${m.matched_account_name} detectada`, detail: 'Coincidencia exacta de cuenta destino', tone: 'own' };
  }
  if (m.match_status === 'NO_OWN_ACCOUNT_MATCH') return { title: 'Clasificar salida', detail: null, tone: 'classify' };
  return { title: 'Revisar destino', detail: 'El reporte informó destinos distintos para este retiro', tone: 'review' };
}
