/**
 * ADR-018 §15 — Mercado Pago report activity (read-only). One row per appearance of a processed (NORMAL) release report,
 * from the view fin_mp_report_activity (0079), with its coverage status. It is evidence of what Mercado Pago reported:
 * reading it never changes the ERP balance, which stays the sum of financial_posting (Movimientos ERP). The one action is
 * the explicit ADMIN confirmation of a payout to an own account (0087), done server-side.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readView } from './db';

export type MpCoverageStatus =
  | 'CONTROL' | 'PRE_CUTOVER' | 'RESERVE' | 'COVERED' | 'BACKFILL_PROCESSED' | 'BACKFILL_PENDING' | 'EXCEPTION' | 'YIELD' | 'PAYOUT' | 'OUTBOUND'
  | 'OWN_TRANSFER' | 'CLASSIFY_INFLOW'    // 0086: inflow from an own account (reclassified) / account_fund + DEBIN awaiting classification
  | 'CLASSIFIED_OUTFLOW';                 // 0088: a payout to a third party classified (supplier payment / expense / owner withdrawal)

/** 0088: how a payout to a third party was classified. */
export type MpOutflowClassification = 'SUPPLIER_PAYMENT' | 'EXPENSE' | 'CASUAL_PURCHASE' | 'OWNER_WITHDRAWAL';

export interface MpActivityRow {
  run_id: string; row_number: number; occurred_at: string | null; business_date: string; description: string | null;
  source_id: string | null; net_amount: number | null; gross_amount: number | null; payment_method: string | null;
  payment_method_type: string | null; coverage_status: MpCoverageStatus; financial_operation_id: number | null;
  /** 0086: the own account an inflow came from (OWN_TRANSFER), else null */
  counterpart_account_name?: string | null;
  /** 0088: the classification of a payout to a third party, and its supplier (or "category · supplier" for an expense) */
  classification?: MpOutflowClassification | null; classification_detail?: string | null;
}
const COLUMNS = 'run_id, row_number, occurred_at, business_date, description, source_id, net_amount, gross_amount, payment_method, '
  + 'payment_method_type, coverage_status, financial_operation_id, counterpart_account_name, classification, classification_detail';
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
  OUTBOUND: 'Pago saliente sin clasificar',   // ADR-020 (0090): classifiable like a payout to a third party
  OWN_TRANSFER: 'Transferencia entre cuentas propias',
  CLASSIFY_INFLOW: 'Clasificar ingreso',
  CLASSIFIED_OUTFLOW: 'Salida clasificada',
};

/** What the user chooses for a payout to a third party (owner CR 15/10): one "Compra / gasto", or a partner withdrawal. */
export type MpOutflowChoice = 'PURCHASE' | 'OWNER_WITHDRAWAL';
export const MP_OUTFLOW_CHOICE_LABEL: Record<MpOutflowChoice, string> = { PURCHASE: 'Compra / gasto', OWNER_WITHDRAWAL: 'Retiro de socios' };
/** Server classification shown to the user: a purchase and a payment of an existing supplier debt are both "Compra / gasto". */
export const MP_OUTFLOW_LABEL: Record<MpOutflowClassification, string> = {
  SUPPLIER_PAYMENT: 'Compra / gasto', EXPENSE: 'Compra / gasto', CASUAL_PURCHASE: 'Compra / gasto', OWNER_WITHDRAWAL: 'Retiro de socios',
};

/**
 * The status text of a row: an own-account inflow names its source account ("Transferencia desde BNA"); a confirmed
 * payout (0087) names its destination ("Transferencia a BNA").
 */
export function mpStatusLabel(r: Pick<MpActivityRow, 'coverage_status' | 'counterpart_account_name'> & { description?: string | null }
  & Partial<Pick<MpActivityRow, 'classification' | 'classification_detail'>>): string {
  if (r.coverage_status === 'CLASSIFIED_OUTFLOW' && r.classification) {
    const base = MP_OUTFLOW_LABEL[r.classification];
    const detail = r.classification === 'SUPPLIER_PAYMENT' && r.classification_detail ? `${r.classification_detail} (pago de deuda)` : r.classification_detail;
    return detail ? `${base}: ${detail}` : base;
  }
  if (r.coverage_status === 'OWN_TRANSFER' && r.counterpart_account_name) {
    return r.description === 'payout' ? `Transferencia a ${r.counterpart_account_name}` : `Transferencia desde ${r.counterpart_account_name}`;
  }
  return MP_STATUS_LABEL[r.coverage_status];
}

/** Movement type from the report DESCRIPTION and the sign of the net amount. */
export function mpActivityType(r: Pick<MpActivityRow, 'description' | 'net_amount'> & { coverage_status?: MpCoverageStatus }): string {
  if (r.coverage_status === 'OWN_TRANSFER') return 'Transferencia';   // money from an own account is not a collection
  if (r.coverage_status === 'CLASSIFY_INFLOW') return 'Ingreso';
  if (r.coverage_status === 'CLASSIFIED_OUTFLOW') return 'Salida';
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
 * ADR-018 (0084) — payout destination vs. own accounts. The server compares the payout destination (stored server-side,
 * never sent here) EXACTLY with the active own-account CBUs and returns only the outcome: never a CBU or any destination
 * value. The proposal itself creates nothing (auto-transfer is OFF); an ADMIN confirms it explicitly (0087, below).
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

/**
 * What the Actividad list shows under a payout ("Retiro") row; null when there is nothing to show. `canConfirm` is true
 * ONLY for an unconfirmed OWN_ACCOUNT_EXACT payout (0087); a confirmed one (coverage OWN_TRANSFER) shows "Confirmada".
 */
export function payoutMatchLabel(r: Pick<MpActivityRow, 'description' | 'source_id'> & { coverage_status?: MpCoverageStatus },
  matches: ReadonlyMap<string, MpPayoutMatch>):
  { title: string; detail: string | null; tone: 'own' | 'classify' | 'review'; canConfirm: boolean; canClassify: boolean } | null {
  if (r.description !== 'payout' || !r.source_id) return null;
  if (r.coverage_status === 'OWN_TRANSFER') return { title: 'Confirmada', detail: null, tone: 'own', canConfirm: false, canClassify: false };
  if (r.coverage_status === 'CLASSIFIED_OUTFLOW') return null;   // the status itself names the classification
  const m = matches.get(r.source_id);
  if (!m) return null;
  if (m.match_status === 'OWN_ACCOUNT_EXACT' && m.matched_account_name) {
    return { title: `Transferencia a ${m.matched_account_name} detectada`, detail: 'Coincidencia exacta de cuenta destino', tone: 'own', canConfirm: true, canClassify: false };
  }
  if (m.match_status === 'NO_OWN_ACCOUNT_MATCH') return { title: 'Clasificar salida', detail: null, tone: 'classify', canConfirm: false, canClassify: true };
  return { title: 'Revisar destino', detail: 'El reporte informó destinos distintos para este retiro', tone: 'review', canConfirm: false, canClassify: false };
}

/**
 * 0087 — confirm an OWN_ACCOUNT_EXACT payout as ONE internal transfer (Mercado Pago → own bank account). Only the
 * SOURCE_ID is sent: the server resolves the movement, amount, date and destination account; nothing is computed here.
 * A repeated call writes nothing (replayed = true).
 */
export interface MpPayoutConfirmation { confirmation_id: number; replayed: boolean; transfer_operation_id: number; amount: number; destination_account: string }
export async function confirmMpPayoutTransfer(client: SupabaseClient, sourceId: string): Promise<MpPayoutConfirmation> {
  return callRpc<MpPayoutConfirmation>(client, 'mp_confirm_payout_transfer', { p_source_id: sourceId });
}

/**
 * 0088 — classify a payout to a third party (NO_OWN_ACCOUNT_MATCH). Only identifiers and the concept are sent: the SOURCE_ID,
 * the classification and, by classification, the supplier / expense category / nature / concept. The server resolves amount,
 * date and the Mercado Pago account and writes through the ERP's routes ("Compra / gasto": register_purchase + pay_supplier,
 * or pay_supplier alone for an existing supplier debt; "Retiro de socios": register_management_event RETIRO).
 */
export interface MpOutflowInput {
  sourceId: string; classification: MpOutflowClassification;
  supplierId?: string | null; expenseCategoryId?: string | null; nature?: 'OPERATING' | 'REINVESTMENT' | 'INVESTMENT' | null;
  concept?: string | null;
  /** ADR-019: optional free name of the counterparty of a purchase without a registered supplier */
  counterpartyName?: string | null;
}
export async function classifyMpOutflow(client: SupabaseClient, i: MpOutflowInput): Promise<{ replayed: boolean; financial_operation_id: number; amount: number }> {
  const purchase = i.classification === 'EXPENSE' || i.classification === 'CASUAL_PURCHASE';
  return callRpc(client, 'mp_classify_payout_outflow', {
    p_source_id: i.sourceId, p_classification: i.classification,
    p_supplier_id: i.classification === 'EXPENSE' || i.classification === 'SUPPLIER_PAYMENT' ? i.supplierId ?? null : null,
    p_expense_category_id: purchase ? i.expenseCategoryId ?? null : null,
    p_nature: purchase ? i.nature ?? null : null,
    p_concept: purchase ? i.concept?.trim() || null : null,
    p_counterparty_name: i.classification === 'CASUAL_PURCHASE' ? i.counterpartyName?.trim() || null : null, p_reason: null });
}

/** 0088 — an account_fund + DEBIN inflow (CLASSIFY_INFLOW) is a client receipt: the server applies it; the client is optional. */
export async function classifyMpInflowAsCollection(client: SupabaseClient, paymentId: string, clientId: string | null): Promise<{ replayed: boolean }> {
  return callRpc(client, 'mp_classify_inflow_as_collection', { p_payment_id: paymentId, p_client_id: clientId });
}

/** 0086 — an account_fund + DEBIN inflow came from an own account: one TRANSFER own account → Mercado Pago (server-side). */
export async function classifyMpInflowAsOwnTransfer(client: SupabaseClient, paymentId: string, fromAccountId: string): Promise<{ replayed: boolean }> {
  return callRpc(client, 'mp_reclassify_inbound_own_transfer', { p_payment_id: paymentId, p_from_account_id: fromAccountId, p_reason: null });
}

/** ADR-020 (0090) — an unclassified outbound payment (money sent from Mercado Pago to a third party): "Clasificar salida". */
export const isClassifiableOutbound = (r: Pick<MpActivityRow, 'coverage_status' | 'source_id' | 'net_amount'>) =>
  r.coverage_status === 'OUTBOUND' && Boolean(r.source_id) && (r.net_amount ?? 0) < 0;

/**
 * Meta A (0091) — every operation that moves the Mercado Pago account must come from a Mercado Pago movement (SOURCE_ID).
 * The manual forms never post on Mercado Pago by themselves: with account = Mercado Pago the user picks the movement, and
 * the amount, date and SOURCE_ID come from it (the server resolves them again). Without a candidate the form is blocked.
 */
export const MP_SOURCE_MISSING_MESSAGE = 'No encontramos todavía el movimiento correspondiente en Mercado Pago. Esperá a que aparezca en Actividad Mercado Pago o registralo desde allí.';
export const MP_ROUTE_BLOCKED_MESSAGE = 'Mercado Pago no se usa en esta operación: los movimientos de Mercado Pago se registran desde Actividad Mercado Pago.';

/** A Mercado Pago movement offered to a manual form; `amount` is the absolute amount of the movement. */
export interface MpCandidate { sourceId: string; date: string; amount: number; label: string }
const candidate = (sourceId: string, date: string, amount: number, kind: string): MpCandidate =>
  ({ sourceId, date, amount: Math.abs(amount), label: `${date} · ${kind} · $ ${Math.abs(amount).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${sourceId}` });

/**
 * Outflows to a third party not yet registered: a payout to a non-own account (NO_OWN_ACCOUNT_MATCH) or an outbound
 * payment (ADR-020). Used by "Pagar a proveedor" and "Retiro de socios" (mp_classify_payout_outflow). Amount = |gross|.
 */
export function mpOutflowCandidates(rows: readonly MpActivityRow[], matches: ReadonlyMap<string, MpPayoutMatch>): MpCandidate[] {
  return rows.filter((r) => r.source_id && ((r.description === 'payout' && r.coverage_status === 'PAYOUT' && matches.get(r.source_id)?.match_status === 'NO_OWN_ACCOUNT_MATCH')
    || isClassifiableOutbound(r)))
    .map((r) => candidate(r.source_id as string, r.business_date, r.gross_amount ?? r.net_amount ?? 0, r.description === 'payout' ? 'Retiro' : 'Pago saliente'));
}

/** Transfer Mercado Pago → own account: an unconfirmed payout whose destination is exactly that account (0087). */
export function mpOwnPayoutCandidates(rows: readonly MpActivityRow[], matches: ReadonlyMap<string, MpPayoutMatch>, destAccountId: string): MpCandidate[] {
  return rows.filter((r) => r.source_id && r.description === 'payout' && r.coverage_status === 'PAYOUT'
    && matches.get(r.source_id)?.match_status === 'OWN_ACCOUNT_EXACT' && matches.get(r.source_id)?.matched_account_id === destAccountId)
    .map((r) => candidate(r.source_id as string, r.business_date, r.net_amount ?? 0, 'Retiro'));
}

/** Transfer own account → Mercado Pago: an account_fund + DEBIN inflow awaiting classification (0086). */
export function mpOwnInflowCandidates(rows: readonly MpActivityRow[]): MpCandidate[] {
  return rows.filter((r) => r.source_id && r.coverage_status === 'CLASSIFY_INFLOW')
    .map((r) => candidate(r.source_id as string, r.business_date, r.gross_amount ?? r.net_amount ?? 0, 'Ingreso'));
}

/**
 * Client collection in Mercado Pago: a receipt already applied in treasury with an unassigned part (report_mp_receipt_status).
 * The amount offered is what is left to assign (effective applied receipt − active attributions); the server re-checks it.
 */
export function mpReceiptCandidates(rows: readonly { mp_financial_movement_id: number; payment_id: string | null; occurred_date: string;
  axis_a_state: string; effective_applied_receipt: number; active_attributed: number }[]): (MpCandidate & { movementId: number })[] {
  return rows.filter((r) => r.payment_id && (r.axis_a_state === 'POSTED' || r.axis_a_state === 'REPORT_CONFIRMED')
    && r.effective_applied_receipt - r.active_attributed > 0)
    .map((r) => ({ ...candidate(r.payment_id as string, r.occurred_date, Math.round((r.effective_applied_receipt - r.active_attributed) * 100) / 100, 'Cobro'),
      movementId: r.mp_financial_movement_id }));
}
