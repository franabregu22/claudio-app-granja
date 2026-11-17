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
import { callRpc, readTable, readView, readViewPage } from './db';

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

/**
 * The WHOLE production history the caller may see (RLS), oldest first, read in pages of 1000 rows (the response cap never hides
 * rows): only the days with production, mortality or a count adjustment — the same rows the Producción list shows.
 */
export async function listAllProduction(client: SupabaseClient): Promise<FlockDay[]> {
  const out: FlockDay[] = [];
  for (let page = 0; ; page += 1) {
    const { rows } = await readViewPage<FlockDay>(client, 'report_flock_day',
      (q) => q.or('daily_production_id.not.is.null,mortality.neq.0,count_adjustment.neq.0')
        .order('business_date', { ascending: true }).order('shed_nombre').order('flock_id'), '*', page, 1000);
    out.push(...rows.map((r) => ({
      ...r, eggs_total: numOrNull(r.eggs_total), eggs_broken: numOrNull(r.eggs_broken), eggs_dirty: numOrNull(r.eggs_dirty),
      mortality: num(r.mortality), count_adjustment: num(r.count_adjustment), population: num(r.population), age_weeks: numOrNull(r.age_weeks),
      laying_pct: numOrNull(r.laying_pct), expected_laying_pct: numOrNull(r.expected_laying_pct), quality_data_warning: !!r.quality_data_warning,
    })));
    if (rows.length < 1000) return out;
  }
}

/** report_flock_day rows in [from, to], oldest first, read in pages of 1000 (the response cap never hides rows) — the dashboard. */
export async function listFlockDaysRange(client: SupabaseClient, from: string, to: string): Promise<FlockDay[]> {
  const out: FlockDay[] = [];
  for (let page = 0; ; page += 1) {
    const { rows } = await readViewPage<FlockDay>(client, 'report_flock_day',
      (q) => q.gte('business_date', from).lte('business_date', to).order('business_date', { ascending: true }).order('shed_nombre').order('flock_id'),
      '*', page, 1000);
    out.push(...rows.map((r) => ({
      ...r, eggs_total: numOrNull(r.eggs_total), eggs_broken: numOrNull(r.eggs_broken), eggs_dirty: numOrNull(r.eggs_dirty),
      mortality: num(r.mortality), count_adjustment: num(r.count_adjustment), population: num(r.population), age_weeks: numOrNull(r.age_weeks),
      laying_pct: numOrNull(r.laying_pct), expected_laying_pct: numOrNull(r.expected_laying_pct), quality_data_warning: !!r.quality_data_warning,
    })));
    if (rows.length < 1000) return out;
  }
}

/** 0131 (owner 2026-11-17): the CSV is the whole table — time, who loaded it and the note included; dirty eggs and the expected
 *  curve are out (no longer used). */
export const PRODUCCION_CSV_CABECERA = ['Fecha', 'Hora', 'Responsable', 'Galpón', 'Lote', 'Línea genética', 'Edad (semanas)', 'Huevos', 'Rotos', '% Rotos',
  '% Postura', 'Mortandad', 'Aves', 'Ajuste de conteo', 'Notas'];
export const produccionCsvFila = (d: FlockDay, extra: { time?: string | null; by?: string | null; notes?: string | null; lote?: string | null } = {}) => [
  `${d.business_date.slice(8, 10)}/${d.business_date.slice(5, 7)}/${d.business_date.slice(0, 4)}`, extra.time ?? null, extra.by ?? null, d.shed_nombre,
  extra.lote ?? null, d.genetics_line, d.age_weeks, d.eggs_total, d.eggs_broken, brokenPct(d), d.laying_pct, d.mortality, d.population, d.count_adjustment, extra.notes ?? null,
];

/** The flock's code as the farm names it (owner 2026-11-17): G + the shed number (2 digits) + «-» + entry year and month (YYMM) —
 *  «Galpón 3» entered 2025-01 → «G03-2501». A shed name without a number keeps its name. */
export function codigoLote(f: { shed_nombre: string; entry_date: string }): string {
  const n = /(\d+)\s*$/.exec(f.shed_nombre.trim())?.[1];
  const yymm = `${f.entry_date.slice(2, 4)}${f.entry_date.slice(5, 7)}`;
  return n ? `G${n.padStart(2, '0')}-${yymm}` : `${f.shed_nombre}-${yymm}`;
}

/** Broken eggs as a share of the day's eggs (presentation only; 2 decimals). */
export function brokenPct(d: Pick<FlockDay, 'eggs_total' | 'eggs_broken'>): number | null {
  if (d.eggs_total === null || d.eggs_broken === null || d.eggs_total <= 0) return null;
  return Math.round((d.eggs_broken * 10000) / d.eggs_total) / 100;
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

// ── 0131: the day in one call, its edits, notes and bird counts ─────────────

export interface DayNote { flock_id: string; note_date: string; notes: string }
/** The notes of the days in [from, to] (flock_day_note). */
export async function listDayNotes(client: SupabaseClient, from: string, to: string): Promise<DayNote[]> {
  return readTable<DayNote>(client, 'flock_day_note', (q) => q.gte('note_date', from).lte('note_date', to), 'flock_id, note_date, notes');
}

/** One day as the report shows it (the population the system computes for that date), or null. */
export async function getFlockDay(client: SupabaseClient, flockId: string, date: string): Promise<FlockDay | null> {
  const rows = await readView<FlockDay>(client, 'report_flock_day', (q) => q.eq('flock_id', flockId).eq('business_date', date));
  return rows.length === 0 ? null : { ...rows[0], population: num(rows[0].population), mortality: num(rows[0].mortality), count_adjustment: num(rows[0].count_adjustment) };
}

export interface DayInfo { time: string | null; by: string | null }
/** Per day in [from, to] (key «flock|date»): the time the production was recorded («HH:MM»; null for the imported history) and WHO
 *  LOADED it (the first version's author; «Importado» for the imported history) — list_production_days (0131). */
export async function listProductionDays(client: SupabaseClient, from: string, to: string): Promise<Map<string, DayInfo>> {
  const rows = (await callRpc<{ flock_id: string; date: string; time: string | null; by: string | null }[] | null>(client, 'list_production_days',
    { p_from: from, p_to: to })) ?? [];
  return new Map(rows.map((r) => [`${r.flock_id}|${r.date}`, { time: r.time, by: r.by }]));
}

/** The current time of day, «HH:MM» — what the forms propose (editable). */
export function horaActual(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const timeOrNull = (t?: string | null) => (t && /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : null);

export function registerProductionDay(client: SupabaseClient, p: {
  flockId: string; date: string; eggsTotal: number; eggsBroken: number; deaths: number; notes?: string | null; recordedTime?: string | null;
}) {
  return callRpc<{ production_id: string }>(client, 'register_production_day', {
    p_flock_id: p.flockId, p_date: p.date, p_eggs_total: p.eggsTotal, p_eggs_broken: p.eggsBroken, p_deaths: p.deaths, p_notes: reasonOrNull(p.notes),
    p_recorded_time: timeOrNull(p.recordedTime),
  });
}

/** Any user, any record; the reason is mandatory; eggsTotal null only for a day without production. */
export function editProductionDay(client: SupabaseClient, p: {
  flockId: string; date: string; eggsTotal: number | null; eggsBroken: number; deaths: number; notes: string | null; recordedTime: string | null; reason: string;
}) {
  return callRpc<unknown>(client, 'edit_production_day', {
    p_flock_id: p.flockId, p_date: p.date, p_eggs_total: p.eggsTotal, p_eggs_broken: p.eggsBroken, p_deaths: p.deaths,
    p_notes: reasonOrNull(p.notes), p_recorded_time: timeOrNull(p.recordedTime), p_reason: p.reason,
  });
}

export interface DayValues { eggs_total?: number | null; eggs_broken?: number | null; deaths?: number | null; notes?: string | null; time?: string | null }
export interface DayEdit { flock_id: string; date: string; at: string; actor: string; before: DayValues; after: DayValues; reason: string | null }
export async function listProductionDayEdits(client: SupabaseClient, from: string, to: string): Promise<DayEdit[]> {
  return (await callRpc<DayEdit[] | null>(client, 'list_production_day_edits', { p_from: from, p_to: to })) ?? [];
}

const CAMPOS: [keyof DayValues, string][] = [['time', 'Hora'], ['eggs_total', 'Huevos'], ['eggs_broken', 'Rotos'], ['deaths', 'Mortandad'], ['notes', 'Notas']];
const valor = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
/** «Huevos 582 → 590 · Mortandad 6 → 4»: only the fields that changed. */
export function describeDayEdit(e: Pick<DayEdit, 'before' | 'after'>): string {
  return CAMPOS.filter(([k]) => k in e.after && valor(e.before[k]) !== valor(e.after[k]))
    .map(([k, t]) => `${t} ${valor(e.before[k])} → ${valor(e.after[k])}`).join(' · ');
}

export interface BirdCount {
  id: number; flock_id: string; date: string; counted: number; computed: number; difference: number; reason: string | null; at: string; by: string;
  voided_at: string | null; voided_by: string | null; void_reason: string | null;
}
export async function listBirdCounts(client: SupabaseClient, flockId: string): Promise<BirdCount[]> {
  return (await callRpc<BirdCount[] | null>(client, 'list_bird_counts', { p_flock_id: flockId })) ?? [];
}
export function registerBirdCount(client: SupabaseClient, p: { flockId: string; date: string; counted: number; reason?: string | null }) {
  return callRpc<{ count_id: number; counted: number; computed: number; difference: number }>(client, 'register_bird_count', {
    p_flock_id: p.flockId, p_date: p.date, p_counted: p.counted, p_reason: reasonOrNull(p.reason),
  });
}
export function voidBirdCount(client: SupabaseClient, p: { countId: number; reason?: string | null }) {
  return callRpc<{ count_id: number }>(client, 'void_bird_count', { p_count_id: p.countId, p_reason: reasonOrNull(p.reason) });
}
/** The count that can be deleted: the newest one not deleted (the list comes newest first). */
export const lastValidCount = (counts: BirdCount[]): BirdCount | null => counts.find((c) => c.voided_at === null) ?? null;
