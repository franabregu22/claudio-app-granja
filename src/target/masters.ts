/**
 * Phase 27 (F27-B) — master data over the target schema (ADMIN-only tables per RLS_IMPLEMENTATION_SPEC_V1).
 *
 * Only the authorized direct master writes are used (INSERT / UPDATE; there is no delete path). Every row the
 * UI shows comes from the database; RLS decides who may read or write it. An UPDATE that RLS filters out
 * affects zero rows without raising, so it is reported as NOT_UPDATED instead of looking like a success.
 * `flocks` has no frontend write path in the frozen contract and is read-only here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readTable, TargetDbError, writeTable } from './db';

export const ACCOUNT_TYPES = ['CASH', 'BANK_ACCOUNT', 'EXTERNAL_SERVICE'] as const;
export const PROJECT_STATUSES = ['ACTIVE', 'PAUSED', 'CLOSED'] as const;
export const PRODUCT_TYPES = ['VENDIBLE', 'INPUT', 'BOTH'] as const;
export const UNIT_TYPES = ['UNIT', 'CARTON', 'KG', 'TON', 'LITER'] as const;
export const PRICE_LISTS = ['MINORISTA', 'MAYORISTA'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProductType = (typeof PRODUCT_TYPES)[number];
export type UnitType = (typeof UNIT_TYPES)[number];
export type PriceList = (typeof PRICE_LISTS)[number];

export interface ClientRow { id: string; nombre: string; fiscal_id: string | null; contacto: string | null; activo: boolean }
export interface SupplierRow { id: string; nombre: string; fiscal_id: string | null; contacto: string | null; activo: boolean }
export interface ExpenseCategoryRow {
  id: string; nombre: string; description: string | null; activo: boolean; pnl_cost_class: 'DIRECT' | 'INDIRECT';
}
export interface FinancialAccountRow { id: string; nombre: string; account_type: AccountType; activo: boolean }
export interface ProjectRow { id: string; nombre: string; descripcion: string | null; status: ProjectStatus }
export interface ProductRow { id: string; nombre: string; product_type: ProductType; unit_type: UnitType; activo: boolean }
export interface ShedRow { id: string; nombre: string; capacidad: number | null; activo: boolean }
export interface PriceRow {
  id: string; producto_id: string; price_list_type: PriceList; precio: number; effective_from: string; effective_to: string | null;
}
export interface FlockRow {
  id: string; shed_id: string; estado: 'ACTIVE' | 'RETIRED' | 'ARCHIVED'; genetics_line: string | null; birth_date: string | null;
  entry_date: string; initial_population: number; exit_date: string | null;
}
export interface OperatorAssignmentRow { id: string; operator_id: string; flock_id: string; activo: boolean; assigned_at: string }
export interface ProfileRow { id: string; email: string; rol_type: 'ADMIN' | 'OPERATOR'; activo: boolean }

/** The master tables edited through direct writes in F27-B (all INSERT / UPDATE only). */
export type MasterTable = 'clients' | 'suppliers' | 'expense_category' | 'financial_account' | 'projects' | 'products' | 'sheds';
type Values = Record<string, unknown>;

/** Trim text fields and turn empty strings into NULL; other values pass through unchanged. */
export function cleanValues(values: Values): Values {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => {
    if (typeof v !== 'string') return [k, v];
    const t = v.trim();
    return [k, t === '' ? null : t];
  }));
}

export function listMaster<Row>(client: SupabaseClient, table: MasterTable, order = 'nombre'): Promise<Row[]> {
  return readTable<Row>(client, table, (q) => q.order(order));
}

export async function createMaster<Row>(client: SupabaseClient, table: MasterTable, values: Values): Promise<Row> {
  const rows = await writeTable(client, table, 'insert', cleanValues(values));
  return rows[0] as Row;
}

async function updateById(client: SupabaseClient, table: MasterTable | 'price_history' | 'operator_assignments', id: string,
  values: Values): Promise<unknown> {
  const rows = await writeTable(client, table, 'update', values, { id });
  if (rows.length === 0) throw new TargetDbError('NOT_UPDATED', `${table} ${id}`);
  return rows[0];
}

export async function updateMaster<Row>(client: SupabaseClient, table: MasterTable, id: string, values: Values): Promise<Row> {
  const touched = table === 'clients' || table === 'suppliers' ? { ...values, updated_at: new Date().toISOString() } : values;
  return (await updateById(client, table, id, cleanValues(touched))) as Row;
}

// ── prices ───────────────────────────────────────────────────────────────────

/** Current prices: the rows with no end date (one per product and list, enforced by a unique index). */
export function listCurrentPrices(client: SupabaseClient): Promise<PriceRow[]> {
  return readTable<PriceRow>(client, 'price_history', (q) => q.is('effective_to', null));
}

/** The day before an ISO date (YYYY-MM-DD). */
export function previousDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Set a new price from `effectiveFrom`: the current row of that product / list is closed the day before and a
 * new current row is appended (the history is kept; the database CHECK and unique index validate both writes).
 * The target offers no RPC for this, so if the append fails the closed row is reopened.
 */
export async function setPrice(client: SupabaseClient, p: {
  productId: string; list: PriceList; precio: number; effectiveFrom: string; userId: string | null;
}): Promise<PriceRow> {
  const [current] = await readTable<PriceRow>(client, 'price_history',
    (q) => q.eq('producto_id', p.productId).eq('price_list_type', p.list).is('effective_to', null));
  if (current) await updateById(client, 'price_history', current.id, { effective_to: previousDay(p.effectiveFrom) });
  try {
    const rows = await writeTable(client, 'price_history', 'insert', {
      producto_id: p.productId, price_list_type: p.list, precio: p.precio, effective_from: p.effectiveFrom, created_by: p.userId,
    });
    return rows[0] as PriceRow;
  } catch (err) {
    if (current) await writeTable(client, 'price_history', 'update', { effective_to: null }, { id: current.id }).catch(() => undefined);
    throw err;
  }
}

// ── flocks and operator assignments ───────────────────────────────────────────

/** Flocks are read-only in the frontend: the frozen contract grants no INSERT / UPDATE and has no flock RPC. */
export function listFlocks(client: SupabaseClient): Promise<FlockRow[]> {
  return readTable<FlockRow>(client, 'flocks', (q) => q.order('entry_date', { ascending: false }));
}

export function listProfiles(client: SupabaseClient): Promise<ProfileRow[]> {
  return readTable<ProfileRow>(client, 'perfiles', (q) => q.order('email'), 'id, email, rol_type, activo');
}

export function listOperatorAssignments(client: SupabaseClient): Promise<OperatorAssignmentRow[]> {
  return readTable<OperatorAssignmentRow>(client, 'operator_assignments', (q) => q.order('assigned_at', { ascending: false }));
}

export async function assignOperator(client: SupabaseClient, p: { operatorId: string; flockId: string; userId: string | null }):
  Promise<OperatorAssignmentRow> {
  const rows = await writeTable(client, 'operator_assignments', 'insert', { operator_id: p.operatorId, flock_id: p.flockId, assigned_by: p.userId });
  return rows[0] as OperatorAssignmentRow;
}

export async function setAssignmentActive(client: SupabaseClient, id: string, activo: boolean): Promise<OperatorAssignmentRow> {
  return (await updateById(client, 'operator_assignments', id, { activo })) as OperatorAssignmentRow;
}
