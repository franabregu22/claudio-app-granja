/**
 * Phase 27 (F27-E) — production and flock population over the target schema
 * (RPC_CONTRACTS_V1 18–22 and 29 with ADR-007; RLS_IMPLEMENTATION_SPEC_V1 §8: ADMIN sees every flock, OPERATOR only
 * the flocks it is actively assigned to; ADR-005 D1/D2: laying % and population are computed by the report_flock_day view).
 *
 * Authority split:
 *   - Writes: RPCs only. The backend checks the role, the assignment, the flock state, the period, the ADR-007
 *     exit-date rule, duplicates and rectification versioning; the frontend sends contract inputs.
 *   - Reads: report_flock_day (population, laying %, expected curve, warnings) and the current rows of
 *     daily_production and population_events. Population and laying % are never recomputed here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';

export interface FlockOption {
  id: string; shed_id: string; shed_nombre: string; estado: 'ACTIVE' | 'RETIRED' | 'ARCHIVED'; entry_date: string; exit_date: string | null;
  genetics_line: string | null;
}
export interface FlockDay {
  flock_id: string; shed_id: string; shed_nombre: string; genetics_line: string | null; business_date: string; daily_production_id: string | null;
  eggs_total: number | null; eggs_broken: number | null; eggs_dirty: number | null; mortality: number; count_adjustment: number;
  population: number; age_weeks: number | null; laying_pct: number | null; expected_laying_pct: number | null; quality_data_warning: boolean;
}
export interface MortalityEvent { id: number; flock_id: string; event_date: string; deaths: number }

const num = (v: unknown) => Number(v ?? 0);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const reasonOrNull = (r?: string | null) => (r && r.trim() !== '' ? r.trim() : null);

// ── reads ───────────────────────────────────────────────────────────────────

/** Flocks the caller may see (RLS: all for ADMIN, assigned ones for OPERATOR), with the shed name. */
export async function listFlockOptions(client: SupabaseClient): Promise<FlockOption[]> {
  const rows = await readTable<Omit<FlockOption, 'shed_nombre'> & { sheds: { nombre: string } | null }>(client, 'flocks',
    (q) => q.order('entry_date', { ascending: false }), 'id, shed_id, estado, entry_date, exit_date, genetics_line, sheds(nombre)');
  return rows.map(({ sheds, ...f }) => ({ ...f, shed_nombre: sheds?.nombre ?? '—' }));
}

/** report_flock_day rows in [from, to], newest first (values exactly as the view reports them). */
export async function listFlockDays(client: SupabaseClient, from: string, to: string): Promise<FlockDay[]> {
  const rows = await readView<FlockDay>(client, 'report_flock_day',
    (q) => q.gte('business_date', from).lte('business_date', to).order('business_date', { ascending: false }).order('shed_nombre'));
  return rows.map((r) => ({
    ...r, eggs_total: numOrNull(r.eggs_total), eggs_broken: numOrNull(r.eggs_broken), eggs_dirty: numOrNull(r.eggs_dirty),
    mortality: num(r.mortality), count_adjustment: num(r.count_adjustment), population: num(r.population), age_weeks: numOrNull(r.age_weeks),
    laying_pct: numOrNull(r.laying_pct), expected_laying_pct: numOrNull(r.expected_laying_pct), quality_data_warning: !!r.quality_data_warning,
  }));
}

/** A calendar date shifted by whole days (YYYY-MM-DD; presentation ranges only). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The latest reported day of each flock in the rows given (the rows come newest first). */
export function latestPerFlock(days: FlockDay[]): FlockDay[] {
  const seen = new Map<string, FlockDay>();
  for (const d of days) if (!seen.has(d.flock_id)) seen.set(d.flock_id, d);
  return [...seen.values()];
}

/** Current (not superseded) mortality events of a flock on a date — the target of rectify_mortality. */
export async function listMortalityEvents(client: SupabaseClient, flockId: string, date: string): Promise<MortalityEvent[]> {
  const rows = await readTable<{ id: number; flock_id: string; event_date: string; delta: number }>(client, 'population_events',
    (q) => q.eq('flock_id', flockId).eq('event_date', date).eq('event_type', 'MORTALITY').eq('is_current', true),
    'id, flock_id, event_date, delta');
  return rows.map((r) => ({ id: r.id, flock_id: r.flock_id, event_date: r.event_date, deaths: Math.abs(num(r.delta)) }));
}

// ── writes (RPCs 18–22) ─────────────────────────────────────────────────────

export function registerDailyProduction(client: SupabaseClient, p: {
  flockId: string; date: string; eggsTotal: number; eggsBroken: number; eggsDirty: number; reason?: string | null;
}) {
  return callRpc<{ production_id: string; production_date: string; eggs_total: number }>(client, 'register_daily_production', {
    p_flock_id: p.flockId, p_production_date: p.date, p_eggs_total: p.eggsTotal, p_eggs_broken: p.eggsBroken, p_eggs_dirty: p.eggsDirty,
    p_reason: reasonOrNull(p.reason),
  });
}

export function rectifyDailyProduction(client: SupabaseClient, p: {
  productionId: string; eggsTotal: number; eggsBroken: number; eggsDirty: number; reason: string;
}) {
  return callRpc<{ previous_id: string; new_id: string; version_seq: number }>(client, 'rectify_daily_production', {
    p_production_id: p.productionId, p_new_eggs_total: p.eggsTotal, p_new_eggs_broken: p.eggsBroken, p_new_eggs_dirty: p.eggsDirty,
    p_reason: p.reason,
  });
}

export function registerMortality(client: SupabaseClient, p: { flockId: string; date: string; deaths: number; reason?: string | null }) {
  return callRpc<{ event_id: number; event_date: string; deaths: number }>(client, 'register_mortality', {
    p_flock_id: p.flockId, p_event_date: p.date, p_deaths: p.deaths, p_reason: reasonOrNull(p.reason),
  });
}

/** ADMIN only (in-body check). */
export function rectifyMortality(client: SupabaseClient, p: { eventId: number; deaths: number; reason: string }) {
  return callRpc<{ previous_id: number; new_id: number; version_seq: number }>(client, 'rectify_mortality', {
    p_event_id: p.eventId, p_new_deaths: p.deaths, p_reason: p.reason,
  });
}

export function registerCountAdjustment(client: SupabaseClient, p: { flockId: string; date: string; delta: number; reason: string }) {
  return callRpc<{ event_id: number; delta: number }>(client, 'register_count_adjustment', {
    p_flock_id: p.flockId, p_event_date: p.date, p_delta: p.delta, p_reason: p.reason,
  });
}
