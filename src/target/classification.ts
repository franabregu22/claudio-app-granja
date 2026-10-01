/**
 * Phase 27 (F27-E; ADR-012 block 4) — egg classification over the target schema (RPC 25 register_classification,
 * RPC 47 rectify_classification; report_classification_day). Grades are target reference data (`classification_grade`,
 * ADMIN-maintained; OPERATOR reads the active ones), never frontend constants. A session is one idempotent RPC call;
 * the backend validates the line set, the grades, the units, the period and duplicates.
 *
 * Units (ADR-012): each line is sent as typed — quantity + UNIDAD | MAPLE. The BACKEND converts to the canonical egg
 * count (MAPLE = 20 for XL, 30 otherwise) and stores both; this module never converts. There is no flock link:
 * classification is a farm-level session.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';

export const ENTRY_UNITS = ['UNIDAD', 'MAPLE'] as const;
export type EntryUnit = (typeof ENTRY_UNITS)[number];

export interface GradeRow { id: string; nombre: string; activo: boolean }
export interface ClassificationDay {
  business_date: string; classification_grade_id: string; grade_nombre: string; quantity: number; day_total: number; share_pct: number;
  day_sessions: number;
}
export interface ClassificationLineInput { classification_grade_id: string; quantity: number; unit: EntryUnit }

export interface SessionLine { grade_id: string; grade_nombre: string; entered_quantity: number; entered_unit: EntryUnit; quantity: number }
export interface SessionVersion {
  id: string; classification_date: string; location: string | null; created_at: string; version_seq: number; is_current: boolean;
  supersedes_id: string | null; rectification_reason: string | null; lines: SessionLine[]; total: number;
}
/** One session as the user sees it: the current version plus the versions it replaced (newest first). */
export interface ClassificationSession { current: SessionVersion; history: SessionVersion[] }

/** Grades the caller may use (RLS: active ones for OPERATOR, all for ADMIN), active first by name. */
export async function listGrades(client: SupabaseClient): Promise<GradeRow[]> {
  const rows = await readTable<GradeRow>(client, 'classification_grade', (q) => q.order('nombre'), 'id, nombre, activo');
  return rows.filter((g) => g.activo);
}

export async function listClassificationDays(client: SupabaseClient, from: string, to: string): Promise<ClassificationDay[]> {
  const rows = await readView<ClassificationDay>(client, 'report_classification_day',
    (q) => q.gte('business_date', from).lte('business_date', to).order('business_date', { ascending: false }).order('grade_nombre'),
    'business_date, classification_grade_id, grade_nombre, quantity, day_total, share_pct, day_sessions');
  return rows.map((r) => ({
    ...r, quantity: Number(r.quantity), day_total: Number(r.day_total), share_pct: Number(r.share_pct), day_sessions: Number(r.day_sessions),
  }));
}

type RawVersion = Omit<SessionVersion, 'lines' | 'total'> & {
  classification_line: { classification_grade_id: string; entered_quantity: number; entered_unit: EntryUnit; quantity: number;
    classification_grade: { nombre: string } | null }[];
};

/**
 * D-CLS-4: every session of `date` (RLS: OPERATOR sees its own), each with its version chain. Lines are shown
 * exactly as entered (entered_quantity + entered_unit) with the backend's canonical egg count; the session total
 * is the sum of the stored canonical quantities, never a conversion.
 */
export async function listSessions(client: SupabaseClient, date: string): Promise<ClassificationSession[]> {
  const rows = await readTable<RawVersion>(client, 'classification', (q) => q.eq('classification_date', date).order('created_at', { ascending: false }),
    'id, classification_date, location, created_at, version_seq, is_current, supersedes_id, rectification_reason, '
    + 'classification_line(classification_grade_id, entered_quantity, entered_unit, quantity, classification_grade(nombre))');
  const versions = rows.map(({ classification_line, ...v }): SessionVersion => {
    const lines = classification_line.map((l) => ({
      grade_id: l.classification_grade_id, grade_nombre: l.classification_grade?.nombre ?? '—', entered_quantity: Number(l.entered_quantity),
      entered_unit: l.entered_unit, quantity: Number(l.quantity),
    })).sort((a, b) => a.grade_nombre.localeCompare(b.grade_nombre));
    return { ...v, lines, total: lines.reduce((t, l) => t + l.quantity, 0) };
  });
  const byId = new Map(versions.map((v) => [v.id, v]));
  return versions.filter((v) => v.is_current).map((current) => {
    const history: SessionVersion[] = [];
    for (let prev = current.supersedes_id ? byId.get(current.supersedes_id) : undefined; prev; prev = prev.supersedes_id ? byId.get(prev.supersedes_id) : undefined) {
      history.push(prev);
    }
    return { current, history };
  });
}

/** Lines are sent as entered (quantity + unit); blank grades are omitted (the backend decides validity). */
export function registerClassification(client: SupabaseClient, p: {
  idempotencyKey: string; date: string; lines: ClassificationLineInput[]; location?: string | null; reason?: string | null;
}) {
  return callRpc<{ classification_id: string; line_count: number; total_quantity: number }>(client, 'register_classification', {
    p_idempotency_key: p.idempotencyKey, p_classification_date: p.date,
    p_lines: p.lines.map((l) => ({ classification_grade_id: l.classification_grade_id, quantity: l.quantity, unit: l.unit })),
    p_location: p.location && p.location.trim() !== '' ? p.location.trim() : null,
    p_reason: p.reason && p.reason.trim() !== '' ? p.reason.trim() : null,
  });
}

/** ADR-012 RPC 47: replaces one whole current session; the reason is mandatory (backend REASON_REQUIRED). */
export function rectifyClassification(client: SupabaseClient, p: {
  idempotencyKey: string; classificationId: string; lines: ClassificationLineInput[]; reason: string;
}) {
  return callRpc<{ classification_id: string; superseded_id: string; version_seq: number; total_quantity: number }>(client, 'rectify_classification', {
    p_idempotency_key: p.idempotencyKey, p_classification_id: p.classificationId,
    p_lines: p.lines.map((l) => ({ classification_grade_id: l.classification_grade_id, quantity: l.quantity, unit: l.unit })),
    p_reason: p.reason,
  });
}

const UNIDAD_LABEL: Record<EntryUnit, [string, string]> = { UNIDAD: ['unidad', 'unidades'], MAPLE: ['maple', 'maples'] };

/** "3 maples (90 huevos)" / "2 unidades": the entry exactly as stored; the egg count is the backend's canonical value. */
export function describeLine(l: Pick<SessionLine, 'entered_quantity' | 'entered_unit' | 'quantity'>): string {
  const [uno, varios] = UNIDAD_LABEL[l.entered_unit];
  const base = `${l.entered_quantity} ${l.entered_quantity === 1 ? uno : varios}`;
  return l.entered_unit === 'MAPLE' ? `${base} (${l.quantity} huevos)` : base;
}
