/**
 * Phase 27 (F27-H) — Mercado Pago over the FROZEN ADR-006 backend, exactly as the accepted Step-14 contract
 * (.planning/implementation-design/ADR006_PHASE27_MP_FRONTEND_CONTRACT_V1.md) fixes it. ADMIN only.
 *
 *   - State: ONLY report_mp_receipt_status, report_mp_delivery_health, report_mp_report_exceptions (§1.1), read with
 *     the §10 field lists. axis_a_state / review_reasons / axis_b_state / effective_applied_receipt / active_attributed
 *     are shown as returned: nothing is recomputed (§1.5), no "saldo pendiente de identificar" exists (§1.6).
 *   - Lookups: exactly L-C3 / L-C7 / L-S7 (§5a) with their exact predicate and allow-listed columns. They only supply
 *     the identifier their RPC needs and never feed a state, balance, remaining amount or work item.
 *   - Actions: C1, C3–C7, R1, S5, S6, S7 through their authorized RPC; every action needs a reason (§5). R2 is
 *     DISABLED_UNTIL_STEP_19 and has no call here. No register_collection for an MP receipt (§1.3), no table write.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';

// ── labels (§4 / §10, fixed wording) ───────────────────────────────────────
export const AXIS_A_LABELS: Record<string, string> = {
  NORMALIZED: 'En aplicación', POSTED: 'Acreditado en tesorería MP', REPORT_CONFIRMED: 'Confirmado por reporte MP', REVIEW_REQUIRED: 'Requiere revisión',
};
export const REVIEW_REASON_LABELS: Record<string, string> = {
  SOURCE_ERROR: 'Datos de MP no procesables', DELIVERY_FAILED_PERMANENT: 'Consulta a MP agotada', DELIVERY_CONFIG_BLOCKED: 'Credencial de MP bloqueada',
  REPORT_EXCEPTION: 'Diferencia con reporte MP', APPLICATION_STUCK: 'Aplicación en tesorería demorada', CHARGEBACK_ALERT: 'Contracargo informado por MP',
  MEDIATION_ALERT: 'Disputa / mediación abierta en MP', CHARGEBACK_SIGNAL_REFRESH_PENDING: 'Aviso de contracargo en verificación',
  UNAPPLIED_REVERSAL: 'Devolución o contracargo sin aplicar',
};
export const AXIS_B_LABELS: Record<string, string> = {
  CLIENT_UNASSIGNED: 'Sin cliente asignado', CLIENT_PARTIAL: 'Asignación parcial', CLIENT_ASSIGNED: 'Cliente asignado',
  CLIENT_RESOLUTION_REQUESTED: 'Asignación solicitada por ADMIN',
};
export const OUTCOME_LABELS: Record<string, string> = {
  DISCREPANCY: 'Diferencia con el reporte', MISSING_IN_REPORT: 'Falta en el reporte', BALANCE_CHECK: 'Diferencia de saldo',
};
export const RESOLUTIONS = ['EXPLAINED', 'CORRECTED', 'SUPERSEDED'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export const RESOLUTION_LABELS: Record<Resolution, string> = { EXPLAINED: 'Explicada', CORRECTED: 'Corregida', SUPERSEDED: 'Reemplazada' };
/** R2 (mp_normalize_report_fallback) availability, as fixed by the contract until Step 19 / V-4. */
export const R2_AVAILABILITY = 'DISABLED_UNTIL_STEP_19' as const;

// ── §10 field lists (the only columns read) ────────────────────────────────
export const S_A_FIELDS = ['mp_financial_movement_id', 'payment_id', 'occurred_date', 'gross_amount', 'fee_amount', 'tax_amount', 'net_amount',
  'axis_a_state', 'review_reasons', 'axis_b_state', 'active_attributed', 'effective_applied_receipt', 'open_flag'] as const;
export const S_B_FIELDS = ['mp_financial_movement_id', 'transition_id', 'payment_id', 'source_type', 'source_processing_status', 'latest_snapshot_status',
  'occurred_date', 'gross_amount', 'fee_amount', 'tax_amount', 'net_amount', 'assigned_amount', 'report_matched', 'axis_a_state', 'review_reasons',
  'effective_applied_receipt', 'unapplied_reversal_count', 'unapplied_reversal_amount', 'active_attributed', 'axis_b_state', 'open_flag', 'open_flag_id'] as const;
export const S_B_EXCEPTION_FIELDS = ['match_id', 'outcome', 'detail', 'created_at', 'mp_financial_movement_id'] as const;
export const S_E_FIELDS = ['total_deliveries', 'received_count', 'processing_count', 'fetched_count', 'signal_recorded_count', 'failed_retryable_count',
  'failed_permanent_count', 'config_blocked_count', 'unsupported_count', 'due_count', 'oldest_due_at', 'failed_permanent_by_error_code',
  'auth_configuration_error', 'config_blocked_oldest', 'key_conflicts', 'unresolved_chargeback_signals', 'review_required'] as const;
export const S_F_FIELDS = ['match_id', 'outcome', 'report_source_type', 'report_external_id', 'transition_id', 'resource_type', 'resource_id', 'transition',
  'mp_financial_movement_id', 'coverage_from', 'coverage_to', 'detail', 'created_at', 'axis_a_state'] as const;
export const L_C3_COLUMNS = ['id', 'cliente_id', 'amount', 'mode', 'effective_date'] as const;
export const L_C7_COLUMNS = ['id', 'mp_payer_id', 'cliente_id', 'created_at'] as const;
export const L_S7_COLUMNS = ['id', 'resource_id', 'received_at'] as const;

export interface ReceiptRow {
  mp_financial_movement_id: number; payment_id: string | null; occurred_date: string; gross_amount: number; fee_amount: number; tax_amount: number;
  net_amount: number; axis_a_state: string; review_reasons: string[]; axis_b_state: string; active_attributed: number;
  effective_applied_receipt: number; open_flag: boolean;
}
export interface ReceiptDetail extends ReceiptRow {
  transition_id: number | null; source_type: string | null; source_processing_status: string | null; latest_snapshot_status: string | null;
  assigned_amount: number; report_matched: boolean; unapplied_reversal_count: number; unapplied_reversal_amount: number; open_flag_id: string | null;
}
export interface ReceiptException { match_id: string; outcome: string; detail: unknown; created_at: string; mp_financial_movement_id: number | null }
export type DeliveryHealth = Record<(typeof S_E_FIELDS)[number], unknown> & {
  auth_configuration_error: boolean; review_required: boolean; unresolved_chargeback_signals: number; key_conflicts: number;
};
export interface ReportException {
  match_id: string; outcome: string; report_source_type: string | null; report_external_id: string | null; transition_id: number | null;
  resource_type: string | null; resource_id: string | null; transition: string | null; mp_financial_movement_id: number | null;
  coverage_from: string | null; coverage_to: string | null; detail: unknown; created_at: string; axis_a_state: string | null;
}
export interface AllocationLookup { id: string; cliente_id: string; amount: number; mode: string; effective_date: string }
export interface MappingLookup { id: string; mp_payer_id: string; cliente_id: string; created_at: string }
export interface ChargebackSignalLookup { id: string; resource_id: string; received_at: string }

const num = (v: unknown) => Number(v ?? 0);
const receipt = <T extends ReceiptRow>(r: T): T => ({
  ...r, gross_amount: num(r.gross_amount), fee_amount: num(r.fee_amount), tax_amount: num(r.tax_amount), net_amount: num(r.net_amount),
  active_attributed: num(r.active_attributed), effective_applied_receipt: num(r.effective_applied_receipt), review_reasons: r.review_reasons ?? [],
});

// ── state reads (the three Step-10 views) ──────────────────────────────────

/** S-A: receipts in [from, to] of occurred_date, newest first; optional server-side filters on the two axes. */
export async function listReceipts(client: SupabaseClient, p: { from: string; to: string; axisA?: string | null; axisB?: string | null }): Promise<ReceiptRow[]> {
  const rows = await readView<ReceiptRow>(client, 'report_mp_receipt_status', (q) => {
    let x = q.gte('occurred_date', p.from).lte('occurred_date', p.to);
    if (p.axisA) x = x.eq('axis_a_state', p.axisA);
    if (p.axisB) x = x.eq('axis_b_state', p.axisB);
    return x.order('occurred_date', { ascending: false }).order('mp_financial_movement_id', { ascending: false });
  }, S_A_FIELDS.join(', '));
  return rows.map(receipt);
}

/** S-B: one receipt (null when not found) and its open report exceptions. */
export async function getReceipt(client: SupabaseClient, movementId: number): Promise<{ receipt: ReceiptDetail | null; exceptions: ReceiptException[] }> {
  const [rows, exceptions] = await Promise.all([
    readView<ReceiptDetail>(client, 'report_mp_receipt_status', (q) => q.eq('mp_financial_movement_id', movementId), S_B_FIELDS.join(', ')),
    readView<ReceiptException>(client, 'report_mp_report_exceptions', (q) => q.eq('mp_financial_movement_id', movementId), S_B_EXCEPTION_FIELDS.join(', ')),
  ]);
  const r = rows[0];
  return {
    receipt: r ? { ...receipt(r), assigned_amount: num(r.assigned_amount), unapplied_reversal_count: num(r.unapplied_reversal_count), unapplied_reversal_amount: num(r.unapplied_reversal_amount) } : null,
    exceptions,
  };
}

/** S-E / S-G / S-H: the single health row (null for a caller that gets none, e.g. OPERATOR). */
export async function getDeliveryHealth(client: SupabaseClient): Promise<DeliveryHealth | null> {
  const rows = await readView<DeliveryHealth>(client, 'report_mp_delivery_health', (q) => q, S_E_FIELDS.join(', '));
  return rows[0] ?? null;
}

/** S-F: every unresolved report exception, newest first. */
export function listReportExceptions(client: SupabaseClient): Promise<ReportException[]> {
  return readView<ReportException>(client, 'report_mp_report_exceptions', (q) => q.order('created_at', { ascending: false }), S_F_FIELDS.join(', '));
}

// ── identifier lookups (§5a; never a state source) ─────────────────────────

/** L-C3: the receipt's allocations, only to choose what C3 reverses. */
export async function lookupAllocations(client: SupabaseClient, movementId: number): Promise<AllocationLookup[]> {
  const rows = await readTable<AllocationLookup>(client, 'mp_client_allocation',
    (q) => q.eq('mp_financial_movement_id', movementId).eq('origin', 'ALLOCATION'), L_C3_COLUMNS.join(', '));
  return rows.map((r) => ({ ...r, amount: num(r.amount) }));
}

/** L-C7: active payer → client mappings, only to choose what C7 removes. */
export function lookupActiveMappings(client: SupabaseClient): Promise<MappingLookup[]> {
  return readTable<MappingLookup>(client, 'mp_payer_client_map', (q) => q.eq('activo', true), L_C7_COLUMNS.join(', '));
}

/** L-S7: unresolved chargeback signals, only to choose what S7 resolves. */
export function lookupChargebackSignals(client: SupabaseClient): Promise<ChargebackSignalLookup[]> {
  return readTable<ChargebackSignalLookup>(client, 'mp_webhook_delivery',
    (q) => q.eq('topic_class', 'chargeback').eq('status', 'SIGNAL_RECORDED').is('signal_resolution', null), L_S7_COLUMNS.join(', '));
}

// ── actions (§5; ADMIN; the reason is always required) ─────────────────────

/** `ui:<uuid>`, generated once per form submission (never an MPA: / MPAUTO: / MPREV: prefix). */
export const uiIdempotencyKey = (uuid: string = crypto.randomUUID()) => `ui:${uuid}`;

export const allocateToClient = (c: SupabaseClient, p: { movementId: number; clienteId: string; amount: number; effectiveDate: string; idempotencyKey: string; reason: string }) =>
  callRpc<Record<string, unknown>>(c, 'mp_allocate_to_client', {
    p_movement_id: p.movementId, p_cliente_id: p.clienteId, p_amount: p.amount, p_effective_date: p.effectiveDate, p_idempotency_key: p.idempotencyKey, p_reason: p.reason,
  });
export const reverseAllocation = (c: SupabaseClient, p: { allocationId: string; amount: number; idempotencyKey: string; reason: string }) =>
  callRpc<Record<string, unknown>>(c, 'mp_reverse_client_allocation', { p_allocation_id: p.allocationId, p_amount: p.amount, p_idempotency_key: p.idempotencyKey, p_reason: p.reason });
export const flagForAttribution = (c: SupabaseClient, p: { movementId: number; reason: string }) =>
  callRpc<Record<string, unknown>>(c, 'mp_flag_for_attribution', { p_movement_id: p.movementId, p_reason: p.reason });
export const clearAttributionFlag = (c: SupabaseClient, p: { flagId: string; reason: string }) =>
  callRpc<Record<string, unknown>>(c, 'mp_clear_attribution_flag', { p_flag_id: p.flagId, p_reason: p.reason });
export const mapPayerToClient = (c: SupabaseClient, p: { payerId: string; clienteId: string; reason: string }) =>
  callRpc<Record<string, unknown>>(c, 'mp_map_payer_to_client', { p_mp_payer_id: p.payerId, p_cliente_id: p.clienteId, p_reason: p.reason });
export const unmapPayer = (c: SupabaseClient, p: { mappingId: string; reason: string }) =>
  callRpc<Record<string, unknown>>(c, 'mp_unmap_payer', { p_mapping_id: p.mappingId, p_reason: p.reason });
export const resolveMatch = (c: SupabaseClient, p: { matchId: string; resolution: Resolution; reason: string }) =>
  callRpc<Record<string, unknown>>(c, 'mp_resolve_match', { p_match_id: p.matchId, p_resolution: p.resolution, p_reason: p.reason });
export const requeueConfigBlocked = (c: SupabaseClient, p: { reason: string }) =>
  callRpc<Record<string, unknown>>(c, 'mp_requeue_config_blocked', { p_reason: p.reason });
export const requestRefetch = (c: SupabaseClient, p: { paymentId: string; reason: string }) =>
  callRpc<Record<string, unknown>>(c, 'mp_request_refetch', { p_payment_id: p.paymentId, p_reason: p.reason });
export const resolveChargebackSignal = (c: SupabaseClient, p: { deliveryId: string; resolution: 'LINKED' | 'DISMISSED'; paymentId?: string | null; reason: string }) =>
  callRpc<Record<string, unknown>>(c, 'mp_resolve_chargeback_signal', {
    p_delivery_id: p.deliveryId, p_resolution: p.resolution, p_payment_id: p.resolution === 'LINKED' ? p.paymentId ?? null : null, p_reason: p.reason,
  });

/** C1 availability (§5): only on a treasury-applied receipt. UX only — the RPC re-checks (RECEIPT_NOT_POSTED). */
export const canAllocate = (r: Pick<ReceiptRow, 'axis_a_state'>) => r.axis_a_state === 'POSTED' || r.axis_a_state === 'REPORT_CONFIRMED';
