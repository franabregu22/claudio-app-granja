/**
 * ADR-025 stage 3 (ERP migration 0101) — Caja → Gastos sin clasificar.
 *
 * A confirmed expense whose subcategory was doubtful is ALREADY in the balance: one payment, one posting on the paying account
 * (register_unclassified_expense, e.g. from WhatsApp "Registrar sin clasif"). Only its economic classification is pending.
 * Classifying it (classify_pending_expense, ADMIN) adds the purchase on THAT payment: no new operation, posting or payment, the
 * balance does not change and the P&L line moves from GASTOS_SIN_CLASIFICAR to its category (the total does not change).
 * Mercado Pago outflows are NOT here: they stay in their own pending list (ADR-021) and are classified through their routes.
 * Reads: the ADMIN-only view fin_expense_pending_classification (RLS / security_invoker); writes: the RPC only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readViewPage } from './db';
import type { PurchaseNatureValue } from './masters';

export type PendingExpenseStatus = 'SIN_CLASIFICAR' | 'CLASIFICADO';
export type PendingExpenseOrigin = 'WHATSAPP' | 'ERP';
export interface PendingExpenseRow {
  pending_id: number; status: PendingExpenseStatus; economic_date: string; amount: number; financial_account_id: string; account_name: string;
  payment_method: string; concept: string; counterparty_name: string | null; origin: PendingExpenseOrigin;
  /** WhatsApp: the draft short code (e.g. W-0042) — never a phone number */
  origin_ref: { draft_short_code?: string } | null;
  payment_operation_id: number; created_by: string; created_at: string;
  purchase_id: string | null; expense_category_id: string | null; category_name: string | null; nature: PurchaseNatureValue | null;
  classified_by: string | null; classified_at: string | null;
}
/** The exact columns the screen reads (the SQL contract test of 0101, supabase/target-candidates/0102, selects the same list). */
export const PENDING_EXPENSE_COLUMNS = 'pending_id, status, economic_date, amount, financial_account_id, account_name, payment_method, concept, '
  + 'counterparty_name, origin, origin_ref, payment_operation_id, created_by, created_at, purchase_id, expense_category_id, category_name, nature, '
  + 'classified_by, classified_at';

export interface PendingExpenseFilter {
  status: PendingExpenseStatus | 'ALL'; from?: string; to?: string; accountId?: string; origin?: PendingExpenseOrigin | '';
}
export const PENDING_EXPENSE_PAGE = 50;
const isoDate = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const uuid = (v?: string) => (v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : undefined);

/** One page of the list (oldest pending first; classified: most recent first), with the server's exact count. */
export async function listPendingExpensesPage(client: SupabaseClient, f: PendingExpenseFilter, page = 0, pageSize = PENDING_EXPENSE_PAGE) {
  const r = await readViewPage<PendingExpenseRow>(client, 'fin_expense_pending_classification', (q) => {
    let x = q;
    if (f.status !== 'ALL') x = x.eq('status', f.status);
    if (isoDate(f.from)) x = x.gte('economic_date', isoDate(f.from));
    if (isoDate(f.to)) x = x.lte('economic_date', isoDate(f.to));
    if (uuid(f.accountId)) x = x.eq('financial_account_id', uuid(f.accountId));
    if (f.origin === 'WHATSAPP' || f.origin === 'ERP') x = x.eq('origin', f.origin);
    const asc = f.status === 'SIN_CLASIFICAR';
    return x.order('economic_date', { ascending: asc }).order('pending_id', { ascending: asc });
  }, PENDING_EXPENSE_COLUMNS, page, pageSize);
  return { rows: r.rows.map((x) => ({ ...x, pending_id: Number(x.pending_id), amount: Number(x.amount), payment_operation_id: Number(x.payment_operation_id) })),
           total: r.total, page, pageSize };
}

/** The indicator: how many expenses are still unclassified (server count; no row is downloaded). */
export async function countUnclassified(client: SupabaseClient): Promise<number> {
  const r = await readViewPage<{ pending_id: number }>(client, 'fin_expense_pending_classification', (q) => q.eq('status', 'SIN_CLASIFICAR').order('pending_id'),
    'pending_id', 0, 1);
  return r.total;
}

export interface ClassifyPendingInput {
  pendingId: number; expenseCategoryId: string; nature: PurchaseNatureValue;
  /** null keeps the registered concept */
  concept: string | null;
  /** null keeps the registered counterparty; '' clears it */
  counterpartyName: string | null;
  reason: string | null;
}
/**
 * classify_pending_expense (ADMIN): the purchase on the existing payment. Replays return the same result; a different
 * classification afterwards is ALREADY_CLASSIFIED (reclassify through the purchase rectification).
 */
export function classifyPendingExpense(client: SupabaseClient, p: ClassifyPendingInput) {
  return callRpc<{ pending_id: number; purchase_id: string; payment_operation_id: number; status: 'CLASIFICADO'; replayed: boolean }>(client, 'classify_pending_expense', {
    p_pending_id: p.pendingId, p_expense_category_id: p.expenseCategoryId, p_nature: p.nature,
    p_concept: p.concept === null ? null : p.concept.trim() || null,
    p_counterparty_name: p.counterpartyName === null ? null : p.counterpartyName.trim(),
    p_reason: p.reason?.trim() || null,
  });
}

/** What the form requires before calling the RPC (the database validates everything again). */
export function classifyReady(i: { expenseCategoryId: string; nature: string; concept: string }): boolean {
  return /^[0-9a-f-]{36}$/i.test(i.expenseCategoryId) && ['OPERATING', 'REINVESTMENT', 'INVESTMENT'].includes(i.nature)
    && i.concept.trim().length >= 1 && i.concept.trim().length <= 100;
}

export const PENDING_EXPENSE_STATUS_LABEL: Record<PendingExpenseStatus, string> = { SIN_CLASIFICAR: 'Sin clasificar', CLASIFICADO: 'Clasificado' };
export const PENDING_EXPENSE_ORIGIN_LABEL: Record<PendingExpenseOrigin, string> = { WHATSAPP: 'WhatsApp', ERP: 'ERP' };
/** "WhatsApp W-0042" / "ERP" */
export const originText = (r: Pick<PendingExpenseRow, 'origin' | 'origin_ref'>) =>
  r.origin === 'WHATSAPP' && r.origin_ref?.draft_short_code ? `WhatsApp ${r.origin_ref.draft_short_code}` : PENDING_EXPENSE_ORIGIN_LABEL[r.origin];
export const UNCLASSIFIED_BALANCE_NOTE = 'Estos egresos ya descontaron el saldo de su cuenta. Falta elegir la categoría y subcategoría; clasificarlos no genera otro movimiento.';
export const UNCLASSIFIED_MP_NOTE = 'Los egresos de Mercado Pago sin clasificar siguen en "Pendientes de clasificar" (ruta de Mercado Pago): ya están en el saldo y se clasifican desde ahí, sin otro movimiento.';
