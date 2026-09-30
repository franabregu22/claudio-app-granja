/**
 * Phase 27 (F27-A) — thin typed primitives over the target schema.
 *
 * These are transport helpers only: they read views and authorized tables, call authorized RPCs, and
 * normalize database errors. They compute no balance, status, accounting effect or domain state; that
 * authority stays in the FROZEN backend (views and RPCs).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Read surfaces: reporting views (Phase 25 / ADR-006 Step 10). */
export const TARGET_VIEWS = [
  'report_sales_line', 'report_balance_period', 'report_mp_movement_status', 'report_feria_session_cash', 'report_flock_day',
  'report_feed_consumption_interval', 'report_classification_day', 'pnl_summary', 'pnl_line_item', 'feed_formula_line_safe',
  'report_mp_receipt_status', 'report_mp_delivery_health', 'report_mp_report_exceptions',
] as const;
export type TargetView = (typeof TARGET_VIEWS)[number];

/**
 * Tables the frontend may read directly (RLS decides the rows). The three MP tables are the Step-14
 * identifier lookups (L-C3 / L-C7 / L-S7) only.
 */
export const TARGET_READ_TABLES = [
  'perfiles', 'clients', 'products', 'price_history', 'expense_category', 'financial_account', 'sheds', 'flocks', 'suppliers', 'projects',
  'operator_assignments', 'classification_grade', 'feed_type', 'feed_ingredient', 'feed_formula_version', 'genetics_consumption_curve',
  'pedidos', 'pedido_lineas', 'daily_production', 'population_events', 'management_period', 'purchases', 'purchase_line', 'purchase_attachment',
  'freight', 'financial_instrument', 'sales_session', 'sales_session_movement', 'classification', 'classification_line', 'feed_manufacturing',
  'feed_movement', 'feed_inventory_count', 'flock_feed_assignment', 'fiscal_document', 'fiscal_obligation', 'fiscal_obligation_installment',
  'mp_client_allocation', 'mp_payer_client_map', 'mp_webhook_delivery',
  'collections', 'management_event',
] as const;
export type TargetReadTable = (typeof TARGET_READ_TABLES)[number];

/** The only direct writes the target grants to `authenticated` (masters + PENDING orders); everything else is an RPC. */
export const DIRECT_WRITES = {
  clients: ['insert', 'update'],
  products: ['insert', 'update'],
  price_history: ['insert', 'update'],
  expense_category: ['insert', 'update'],
  financial_account: ['insert', 'update'],
  sheds: ['insert', 'update'],
  suppliers: ['insert', 'update'],
  projects: ['insert', 'update'],
  operator_assignments: ['insert', 'update'],
  classification_grade: ['insert', 'update'],
  feed_type: ['insert', 'update'],
  feed_ingredient: ['insert', 'update'],
  feed_formula_version: ['insert'],
  feed_formula_line: ['insert'],
  genetics_consumption_curve: ['insert', 'update'],
  purchase_attachment: ['insert', 'update'],
  pedidos: ['insert', 'update'],
  pedido_lineas: ['insert', 'delete'],
} as const;
export type DirectWriteTable = keyof typeof DIRECT_WRITES;
export type DirectWriteOp<T extends DirectWriteTable> = (typeof DIRECT_WRITES)[T][number];

/** RPCs executable by `authenticated` (ADMIN / OPERATOR; the in-body checks decide). */
export const TARGET_RPCS = [
  'current_app_role', 'assert_period_open',
  'cancel_order', 'deliver_order', 'rectify_delivered_order', 'register_collection',
  'transfer_between_accounts', 'pay_supplier', 'register_purchase', 'rectify_purchase', 'register_freight', 'assign_freight_to_purchase',
  'receive_cheque', 'deposit_cheque', 'endorse_cheque', 'clear_cheque', 'reject_cheque',
  'issue_supplier_instrument', 'mark_supplier_instrument_debited', 'cancel_supplier_instrument', 'reject_supplier_instrument',
  'register_daily_production', 'rectify_daily_production', 'register_mortality', 'rectify_mortality', 'register_management_event',
  'register_flock', 'close_flock',
  'register_classification', 'register_feed_manufacturing', 'register_feed_movement', 'register_feed_inventory_count',
  'register_count_adjustment', 'assign_flock_feed',
  'open_sales_session', 'close_sales_session', 'register_session_movement', 'register_session_cash_event',
  'register_fiscal_document', 'register_fiscal_obligation', 'pay_fiscal_obligation',
  'mp_reconcile_movement', 'mp_allocate_to_client', 'mp_reverse_client_allocation', 'mp_flag_for_attribution', 'mp_clear_attribution_flag',
  'mp_map_payer_to_client', 'mp_unmap_payer', 'mp_resolve_match', 'mp_normalize_report_fallback', 'mp_requeue_config_blocked',
  'mp_request_refetch', 'mp_resolve_chargeback_signal',
] as const;
export type TargetRpc = (typeof TARGET_RPCS)[number];

/** A normalized database / RPC error: `code` is the contractual code (e.g. PERIOD_CLOSED, FORBIDDEN). */
export class TargetDbError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'TargetDbError';
    this.code = code;
    this.detail = detail;
  }
}

/** Contract errors are raised as `CODE: detail` / `CODE`; permission / RLS failures get a stable code. */
export function normalizeDbError(err: unknown): TargetDbError {
  if (err instanceof TargetDbError) return err;
  const e = (err ?? {}) as { message?: string; code?: string };
  const message = String(e.message ?? err ?? '');
  const m = /^([A-Z][A-Z0-9_]{2,})(?::\s*(.*))?$/s.exec(message.trim());
  if (m) return new TargetDbError(m[1], m[2] ?? '');
  if (e.code === '42501' || /permission denied/i.test(message)) return new TargetDbError('PERMISSION_DENIED', message);
  if (/row-level security/i.test(message)) return new TargetDbError('RLS_DENIED', message);
  // declarative constraints (unique names, CHECK ranges, restricted references)
  if (e.code === '23505') return new TargetDbError('DUPLICATE', message);
  if (e.code === '23514') return new TargetDbError('CHECK_VIOLATION', message);
  if (e.code === '23503') return new TargetDbError('FK_VIOLATION', message);
  if (e.code === '23502') return new TargetDbError('MISSING_VALUE', message);
  return new TargetDbError('DB_ERROR', message);
}

/** Read a reporting view; `build` may add filters / ordering (presentation only). */
export async function readView<Row>(client: SupabaseClient, view: TargetView,
  build: (q: any) => any = (q) => q, columns = '*'): Promise<Row[]> {
  const { data, error } = await build(client.from(view).select(columns));
  if (error) throw normalizeDbError(error);
  return (data ?? []) as Row[];
}

/** Read an authorized table (RLS decides the rows). */
export async function readTable<Row>(client: SupabaseClient, table: TargetReadTable,
  build: (q: any) => any = (q) => q, columns = '*'): Promise<Row[]> {
  const { data, error } = await build(client.from(table).select(columns));
  if (error) throw normalizeDbError(error);
  return (data ?? []) as Row[];
}

/** Call an authorized RPC; the backend is the only authority for its effects. */
export async function callRpc<Result>(client: SupabaseClient, rpc: TargetRpc, args: Record<string, unknown> = {}): Promise<Result> {
  const { data, error } = await client.rpc(rpc, args);
  if (error) throw normalizeDbError(error);
  return data as Result;
}

/** A direct write on one of the authorized master / PENDING-order tables. */
export async function writeTable<T extends DirectWriteTable>(client: SupabaseClient, table: T, op: DirectWriteOp<T>,
  payload: Record<string, unknown> | Record<string, unknown>[] | null, match: Record<string, unknown> = {}): Promise<unknown[]> {
  // a table outside DIRECT_WRITES (only reachable through an unchecked cast) is refused the same way
  const allowed = (DIRECT_WRITES as Record<string, readonly string[]>)[table] ?? [];
  if (!allowed.includes(op)) throw new TargetDbError('DIRECT_WRITE_NOT_ALLOWED', `${op} on ${table}`);
  const q = client.from(table);
  const r = op === 'insert' ? await q.insert(payload as never).select()
    : op === 'update' ? await q.update(payload as never).match(match).select()
      : await q.delete().match(match).select();
  if (r.error) throw normalizeDbError(r.error);
  return (r.data ?? []) as unknown[];
}
