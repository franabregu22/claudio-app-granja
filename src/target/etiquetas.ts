/**
 * 0127 — expense tags («Maíz 2027»): the catalog is the `projects` master (ADMIN direct insert / update, nothing deleted);
 * one tag per expense chain through set_purchase_tag (NULL = «Sin etiqueta»); totals by fin_expense_tag_total. Transport only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView, writeTable } from './db';

export const SIN_ETIQUETA = 'Sin etiqueta';
export interface Etiqueta { id: string; nombre: string; status: 'ACTIVE' | 'PAUSED' | 'CLOSED' }
export interface EtiquetaTotal { project_id: string; tag_nombre: string; status: Etiqueta['status']; expenses: number; total: number; first_date: string | null; last_date: string | null }

export const listEtiquetas = (c: SupabaseClient) => readTable<Etiqueta>(c, 'projects', (q) => q.order('nombre'), 'id, nombre, status');

/** purchase id (any version) → its tag. */
export async function listEtiquetasDeGastos(c: SupabaseClient): Promise<Map<string, { id: string; nombre: string }>> {
  const rows = await readView<{ purchase_id: string; project_id: string; tag_nombre: string }>(c, 'fin_purchase_tag', (q) => q, 'purchase_id, project_id, tag_nombre');
  return new Map(rows.map((r) => [r.purchase_id, { id: r.project_id, nombre: r.tag_nombre }]));
}
export async function listTotalesEtiqueta(c: SupabaseClient): Promise<EtiquetaTotal[]> {
  const rows = await readView<EtiquetaTotal>(c, 'fin_expense_tag_total', (q) => q.order('tag_nombre'));
  return rows.map((r) => ({ ...r, expenses: Number(r.expenses), total: Number(r.total) }));
}
export const setEtiquetaGasto = (c: SupabaseClient, p: { purchaseId: string; etiquetaId: string | null }) =>
  callRpc(c, 'set_purchase_tag', { p_purchase_id: p.purchaseId, p_project_id: p.etiquetaId });
export async function crearEtiqueta(c: SupabaseClient, nombre: string): Promise<Etiqueta> {
  const rows = await writeTable(c, 'projects', 'insert', { nombre: nombre.trim() });
  return rows[0] as Etiqueta;
}
