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

/** D-FEED-5: the versions usable for manufacturing on `date` (one per feed type by ADR-013), as read. */
export function versionsEffectiveOn(versions: FormulaVersionRow[], date: string): FormulaVersionRow[] {
  if (!date) return [];
  return versions.filter((v) => v.effective_from <= date && (v.effective_to === null || v.effective_to >= date));
}

export interface FormulaLineRow { formula_version_id: string; ingredient_id: string; ingredient_name: string; quantity_kg: number }
/** Composition without cost (feed_formula_line_safe), for the given versions. */
export async function listFormulaComposition(client: SupabaseClient, versionIds: string[]): Promise<FormulaLineRow[]> {
  if (versionIds.length === 0) return [];
  const rows = await readView<FormulaLineRow>(client, 'feed_formula_line_safe', (q) => q.in('formula_version_id', versionIds).order('ingredient_name'),
    'formula_version_id, ingredient_id, ingredient_name, quantity_kg');
  return rows.map((r) => ({ ...r, quantity_kg: Number(r.quantity_kg) }));
}

/**
 * ADR-013 RPC 48 — the only write path for formula versions and their composition. Atomic in the backend:
 * next version number, prior version closed at effectiveFrom − 1, all lines or nothing.
 */
export function publishFormulaVersion(client: SupabaseClient, p: {
  feedTypeId: string; effectiveFrom: string; lines: { ingredientId: string; quantityKg: number }[]; reason?: string | null;
}) {
  return callRpc<{ formula_version_id: string; version: number; line_count: number; closed_version_id: string | null }>(client, 'publish_feed_formula_version', {
    p_feed_type_id: p.feedTypeId, p_effective_from: p.effectiveFrom,
    p_lines: p.lines.map((l) => ({ ingredient_id: l.ingredientId, quantity_kg: l.quantityKg })), p_reason: reasonOrNull(p.reason),
  });
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

// ── manufacturing history and rectification (ADR-014) ──────────────────────

export interface ManufacturingVersion {
  id: string; formula_version_id: string; formula_version: number; feed_type_id: string; feed_type_nombre: string; manufacturing_date: string;
  quantity_kg: number; batch_number: string | null; created_at: string; created_by: string | null; version_seq: number; is_current: boolean;
  supersedes_id: string | null; rectification_reason: string | null;
}
/** One manufacturing as the user sees it: the current version plus the versions it replaced (newest first). */
export interface ManufacturingRecord { current: ManufacturingVersion; history: ManufacturingVersion[]; author: string | null }

type RawManufacturing = Omit<ManufacturingVersion, 'formula_version' | 'feed_type_id' | 'feed_type_nombre' | 'quantity_kg'> & {
  quantity_kg: number | string;
  feed_formula_version: { version: number; feed_type_id: string; feed_type: { nombre: string } | null } | null;
};

/**
 * D-FEED-7: manufacturing in [from, to] (RLS: ADMIN and OPERATOR read every row), each with its version chain. Every
 * version carries its EXACT stored formula_version_id; the composition is read for that id (never the current recipe).
 * `author` is the user who started the chain (the one who may rectify as OPERATOR).
 */
export async function listManufacturing(client: SupabaseClient, from: string, to: string): Promise<ManufacturingRecord[]> {
  const rows = await readTable<RawManufacturing>(client, 'feed_manufacturing',
    (q) => q.gte('manufacturing_date', from).lte('manufacturing_date', to).order('manufacturing_date', { ascending: false }).order('created_at', { ascending: false }),
    'id, formula_version_id, manufacturing_date, quantity_kg, batch_number, created_at, created_by, version_seq, is_current, supersedes_id, rectification_reason, '
    + 'feed_formula_version(version, feed_type_id, feed_type(nombre))');
  const versions = rows.map(({ feed_formula_version: fv, ...m }): ManufacturingVersion => ({
    ...m, quantity_kg: Number(m.quantity_kg), formula_version: fv?.version ?? 0, feed_type_id: fv?.feed_type_id ?? '', feed_type_nombre: fv?.feed_type?.nombre ?? '—',
  }));
  const byId = new Map(versions.map((v) => [v.id, v]));
  return versions.filter((v) => v.is_current).map((current) => {
    const history: ManufacturingVersion[] = [];
    for (let prev = current.supersedes_id ? byId.get(current.supersedes_id) : undefined; prev; prev = prev.supersedes_id ? byId.get(prev.supersedes_id) : undefined) {
      history.push(prev);
    }
    return { current, history, author: (history.at(-1) ?? current).created_by };
  });
}

/**
 * User label within the caller's permissions: profiles the caller can read (ADMIN: all; OPERATOR: only its own, by
 * RLS) resolve to their email; the caller is "Vos"; anyone else is "Otro usuario". No permission is broadened.
 */
export function userLabel(id: string | null, me: string | null, profiles: Map<string, string>): string {
  if (id && id === me) return 'Vos';
  return (id && profiles.get(id)) || 'Otro usuario';
}
export async function listProfileNames(client: SupabaseClient): Promise<Map<string, string>> {
  const rows = await readTable<{ id: string; email: string }>(client, 'perfiles', (q) => q, 'id, email');
  return new Map(rows.map((r) => [r.id, r.email]));
}

/** ADR-014 RPC 49: a whole-record new version; the reason is mandatory; the date is kept. */
export function rectifyFeedManufacturing(client: SupabaseClient, p: {
  idempotencyKey: string; manufacturingId: string; quantityKg: number; reason: string; batchNumber?: string | null; formulaVersionId?: string | null;
}) {
  return callRpc<{ manufacturing_id: string; superseded_id: string; version_seq: number; quantity_kg: number }>(client, 'rectify_feed_manufacturing', {
    p_idempotency_key: p.idempotencyKey, p_manufacturing_id: p.manufacturingId, p_quantity_kg: p.quantityKg, p_reason: p.reason,
    p_batch_number: reasonOrNull(p.batchNumber), p_formula_version_id: p.formulaVersionId ?? null,
  });
}
