/**
 * Phase 27 (F27-E) — egg classification over the target schema (RPC 27 register_classification;
 * report_classification_day). Grades are target reference data (`classification_grade`, ADMIN-maintained; OPERATOR
 * reads the active ones), never frontend constants. A session is one idempotent RPC call; the backend validates the
 * line set, the grades, the period and duplicates. There is no flock link: classification is a farm-level session.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';

export interface GradeRow { id: string; nombre: string; activo: boolean }
export interface ClassificationDay {
  business_date: string; classification_grade_id: string; grade_nombre: string; quantity: number; day_total: number; share_pct: number;
  day_sessions: number;
}
export interface ClassificationLineInput { classification_grade_id: string; quantity: number }

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

/** Lines with a quantity are sent as entered; blank grades are omitted (the backend decides validity). */
export function registerClassification(client: SupabaseClient, p: {
  idempotencyKey: string; date: string; lines: ClassificationLineInput[]; location?: string | null; reason?: string | null;
}) {
  return callRpc<{ classification_id: string; line_count: number; total_quantity: number }>(client, 'register_classification', {
    p_idempotency_key: p.idempotencyKey, p_classification_date: p.date,
    p_lines: p.lines.map((l) => ({ classification_grade_id: l.classification_grade_id, quantity: l.quantity })),
    p_location: p.location && p.location.trim() !== '' ? p.location.trim() : null,
    p_reason: p.reason && p.reason.trim() !== '' ? p.reason.trim() : null,
  });
}
