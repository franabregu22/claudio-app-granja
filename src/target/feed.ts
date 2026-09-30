/**
 * Phase 27 (F27-E) — feed over the target schema (RPCs 25–29 of the feed domain, with ADR-007 on assign_flock_feed;
 * report_feed_consumption_interval). No cost is read here: OPERATOR sees no monetary field (ADR-005 D2), and the
 * consumption interval is the view's kg columns as reported. Inventory is never mutated or balanced in React.
 *
 * Roles (in-body checks): manufacturing and physical counts — ADMIN and OPERATOR; movements (external sale, loss,
 * adjustments) and flock feed assignment — ADMIN only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';

export const FEED_MOVEMENT_TYPES = ['EXTERNAL_SALE', 'LOSS', 'ADJUSTMENT_POSITIVE', 'ADJUSTMENT_NEGATIVE'] as const;
export type FeedMovementType = (typeof FEED_MOVEMENT_TYPES)[number];

export interface FeedTypeRow { id: string; nombre: string; feed_category: 'LAYER' | 'BROILER' | 'PULLET' | 'INPUT'; activo: boolean }
export interface FormulaVersionRow { id: string; feed_type_id: string; version: number; effective_from: string; effective_to: string | null }
export interface FlockFeedRow { id: string; flock_id: string; feed_type_id: string; effective_from: string; effective_to: string | null }
export interface ConsumptionInterval {
  feed_type_id: string; feed_type_nombre: string; opening_date: string; business_date: string; opening_kg: number; manufactured_kg: number;
  external_sale_kg: number; loss_kg: number; adjustment_negative_kg: number; adjustment_positive_kg: number; closing_kg: number;
  internal_consumption_kg: number; theoretical_kg: number | null; variance_kg: number | null;
}

const reasonOrNull = (r?: string | null) => (r && r.trim() !== '' ? r.trim() : null);
const KG: (keyof ConsumptionInterval)[] = ['opening_kg', 'manufactured_kg', 'external_sale_kg', 'loss_kg', 'adjustment_negative_kg',
  'adjustment_positive_kg', 'closing_kg', 'internal_consumption_kg'];

export async function listFeedTypes(client: SupabaseClient): Promise<FeedTypeRow[]> {
  const rows = await readTable<FeedTypeRow>(client, 'feed_type', (q) => q.order('nombre'), 'id, nombre, feed_category, activo');
  return rows.filter((t) => t.activo);
}

/** Formula versions visible to the caller (RLS: OPERATOR sees the ones effective today). */
export function listFormulaVersions(client: SupabaseClient): Promise<FormulaVersionRow[]> {
  return readTable<FormulaVersionRow>(client, 'feed_formula_version', (q) => q.order('effective_from', { ascending: false }),
    'id, feed_type_id, version, effective_from, effective_to');
}

export function listFlockFeed(client: SupabaseClient): Promise<FlockFeedRow[]> {
  return readTable<FlockFeedRow>(client, 'flock_feed_assignment', (q) => q.order('effective_from', { ascending: false }),
    'id, flock_id, feed_type_id, effective_from, effective_to');
}

/** Closed count-to-count intervals, newest first, as the view reports them (kg only). */
export async function listConsumptionIntervals(client: SupabaseClient, limit = 50): Promise<ConsumptionInterval[]> {
  const rows = await readView<ConsumptionInterval>(client, 'report_feed_consumption_interval',
    (q) => q.order('business_date', { ascending: false }).limit(limit),
    'feed_type_id, feed_type_nombre, opening_date, business_date, opening_kg, manufactured_kg, external_sale_kg, loss_kg, '
    + 'adjustment_negative_kg, adjustment_positive_kg, closing_kg, internal_consumption_kg, theoretical_kg, variance_kg');
  return rows.map((r) => {
    const out = { ...r };
    for (const k of KG) (out as Record<string, unknown>)[k] = Number(r[k] ?? 0);
    out.theoretical_kg = r.theoretical_kg === null ? null : Number(r.theoretical_kg);
    out.variance_kg = r.variance_kg === null ? null : Number(r.variance_kg);
    return out;
  });
}

export function registerFeedManufacturing(client: SupabaseClient, p: {
  formulaVersionId: string; date: string; quantityKg: number; idempotencyKey: string; batchNumber?: string | null; reason?: string | null;
}) {
  return callRpc<{ manufacturing_id: string; quantity_kg: number }>(client, 'register_feed_manufacturing', {
    p_formula_version_id: p.formulaVersionId, p_manufacturing_date: p.date, p_quantity_kg: p.quantityKg, p_idempotency_key: p.idempotencyKey,
    p_batch_number: reasonOrNull(p.batchNumber), p_reason: reasonOrNull(p.reason),
  });
}

export function registerFeedInventoryCount(client: SupabaseClient, p: { feedTypeId: string; date: string; quantityKg: number; reason?: string | null }) {
  return callRpc<{ count_id: number }>(client, 'register_feed_inventory_count', {
    p_feed_type_id: p.feedTypeId, p_count_date: p.date, p_quantity_kg: p.quantityKg, p_reason: reasonOrNull(p.reason),
  });
}

/** ADMIN only. An external sale must reference its Pedido; adjustments and losses need a reason (backend rules). */
export function registerFeedMovement(client: SupabaseClient, p: {
  feedTypeId: string; type: FeedMovementType; quantityKg: number; date: string; pedidoId?: string | null; reason?: string | null;
}) {
  return callRpc<{ movement_id: number }>(client, 'register_feed_movement', {
    p_feed_type_id: p.feedTypeId, p_movement_type: p.type, p_quantity_kg: p.quantityKg, p_movement_date: p.date,
    p_pedido_id: p.pedidoId ?? null, p_reason: reasonOrNull(p.reason),
  });
}

/** ADMIN only. */
export function assignFlockFeed(client: SupabaseClient, p: { flockId: string; feedTypeId: string; effectiveFrom: string; reason?: string | null }) {
  return callRpc<{ assignment_id: string }>(client, 'assign_flock_feed', {
    p_flock_id: p.flockId, p_feed_type_id: p.feedTypeId, p_effective_from: p.effectiveFrom, p_reason: reasonOrNull(p.reason),
  });
}
