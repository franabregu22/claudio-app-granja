/**
 * Cuentas a pagar (0121, caja-mejoras-v2) — every open due item once, payment plans (instalments) and payment of ONE item.
 *
 * Authority (nothing is derived here that the backend does not serve):
 *   - fin_payables_due: plan instalments (CUOTA / PAGO), an obligation without plan as ONE item (its estimated date, else its due
 *     date), a later increase of the total that no item carries (DIFERENCIA) and own cheques / eCheqs to be debited (CHEQUE / ECHEQ);
 *     per obligation its rows add up to the payment calendar's pending — nothing is counted twice;
 *   - set_payment_plan: the items add up EXACTLY to what is open; replacing a plan needs a reason (versioned, audited);
 *   - pay_plan_item / issue_plan_item_instruments: the payment covers the CHOSEN item, never above its open amount; a payment made
 *     anywhere else goes to the oldest items (owner decision 2026-11-13). "Vencido" is decided by the due date only (0110).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readTable, readView } from './db';

export type DueRowKind = 'CUOTA' | 'PAGO' | 'DIFERENCIA' | 'CHEQUE' | 'ECHEQ';
export interface PayableDueRow {
  row_key: string; row_kind: DueRowKind; obligation_kind: 'FACTURA' | 'GASTO' | null;
  purchase_root_id: string | null; purchase_id: string | null; item_id: number | null; seq: number | null; n_items: number | null;
  due_date: string | null; planned_date: string | null; item_amount: number | null; amount: number;
  supplier_id: string | null; supplier_name: string | null; concept: string | null; document_number: string | null;
  economic_date: string | null; amount_total: number | null;
  instrument_id: string | null; cheque_number: string | null; bank_account_name: string | null; link_status: 'IMPUTADO' | 'SIN_IMPUTAR' | null;
}
export interface PlanItemRow { id: number; purchase_root_id: string; plan_version: number; seq: number; due_date: string | null; amount: number; reason: string | null; created_at: string }

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function listPayablesDue(client: SupabaseClient): Promise<PayableDueRow[]> {
  const rows = await readView<PayableDueRow>(client, 'fin_payables_due', (q) => q.limit(2000));
  return rows.map((r) => ({ ...r, amount: Number(r.amount), item_amount: n(r.item_amount), amount_total: n(r.amount_total), item_id: n(r.item_id),
    seq: n(r.seq), n_items: n(r.n_items) }));
}
/** Every version of the plan of one obligation (oldest first); the plan in force is the highest version. */
export async function listPlanItems(client: SupabaseClient, rootId: string): Promise<PlanItemRow[]> {
  const rows = await readTable<PlanItemRow>(client, 'payment_plan_item', (q) => q.eq('purchase_root_id', rootId).order('plan_version').order('seq'),
    'id, purchase_root_id, plan_version, seq, due_date, amount, reason, created_at');
  return rows.map((r) => ({ ...r, id: Number(r.id), amount: Number(r.amount) }));
}
export function setPaymentPlan(client: SupabaseClient, p: { purchaseId: string; items: { due_date: string | null; amount: number }[]; idempotencyKey: string; reason?: string | null }) {
  return callRpc<{ replayed: boolean; plan_version: number }>(client, 'set_payment_plan', {
    p_purchase_id: p.purchaseId, p_items: p.items, p_idempotency_key: p.idempotencyKey, p_reason: p.reason?.trim() || null,
  });
}
export function payPlanItem(client: SupabaseClient, p: { itemId: number; amount: number; date: string; method: 'CASH' | 'TRANSFER'; accountId: string; idempotencyKey: string; reference?: string | null }) {
  return callRpc<{ replayed: boolean }>(client, 'pay_plan_item', {
    p_item_id: p.itemId, p_amount: p.amount, p_effective_date: p.date, p_payment_method: p.method, p_account_id: p.accountId,
    p_idempotency_key: p.idempotencyKey, p_reference: p.reference?.trim() || null,
  });
}
export interface ChequeInput { instrument_type: 'CHEQUE' | 'ECHEQ'; cheque_number: string; amount: number; maturity_date: string; issued_date: string; bank_account_id: string }
export function issuePlanItemInstruments(client: SupabaseClient, p: { itemId: number; instruments: ChequeInput[]; idempotencyKey: string; reason?: string | null }) {
  return callRpc<{ replayed?: boolean }>(client, 'issue_plan_item_instruments', {
    p_item_id: p.itemId, p_instruments: p.instruments, p_idempotency_key: p.idempotencyKey, p_reason: p.reason?.trim() || null,
  });
}
export function issueObligationInstruments(client: SupabaseClient, p: { purchaseId: string; instruments: ChequeInput[]; idempotencyKey: string; reason?: string | null }) {
  return callRpc<unknown>(client, 'issue_purchase_instruments', {
    p_purchase_id: p.purchaseId, p_instruments: p.instruments, p_idempotency_key: p.idempotencyKey, p_reason: p.reason?.trim() || null,
  });
}

// ── pure: dates, groups and cards (shared with the prototype's rules) ───────
export type Grupo = 'VENCIDO' | 'SEMANA' | 'MES' | 'ADELANTE' | 'SIN_FECHA';
export const GRUPOS: { id: Grupo; label: string }[] = [
  { id: 'VENCIDO', label: 'Vencidos' }, { id: 'SEMANA', label: 'Esta semana' }, { id: 'MES', label: 'Este mes' },
  { id: 'ADELANTE', label: 'Más adelante' }, { id: 'SIN_FECHA', label: 'Sin fecha' },
];
export type Tarjeta = 'TOTAL' | 'VENCIDO' | 'PROX7' | 'PROX30' | 'SIN_FECHA';
const dia = (s: string) => new Date(`${s}T00:00:00Z`);
export const masDias = (s: string, k: number) => { const x = dia(s); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const finSemana = (hoy: string) => masDias(hoy, 6 - ((dia(hoy).getUTCDay() + 6) % 7));
const finMes = (hoy: string) => { const [y, m] = hoy.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/** The date a row sits on: an item / cheque its own date; an obligation without plan its estimated payment date, else its due date. */
export const fechaFila = (r: Pick<PayableDueRow, 'due_date' | 'planned_date'>) => r.planned_date ?? r.due_date;
/** Overdue by the due date only (an estimated date in the past is not "vencido"). */
export const vencida = (r: Pick<PayableDueRow, 'due_date'>, hoy: string) => r.due_date !== null && r.due_date < hoy;
export function grupoFila(r: Pick<PayableDueRow, 'due_date' | 'planned_date'>, hoy: string): Grupo {
  if (vencida(r, hoy)) return 'VENCIDO';
  const f = fechaFila(r);
  if (f === null) return 'SIN_FECHA';
  if (f <= finSemana(hoy)) return 'SEMANA';   // an estimated date already past (not overdue) is still "this week"
  if (f <= finMes(hoy)) return 'MES';
  return 'ADELANTE';
}
export function enTarjeta(r: Pick<PayableDueRow, 'due_date' | 'planned_date'>, t: Tarjeta, hoy: string): boolean {
  if (t === 'TOTAL') return true;
  if (t === 'VENCIDO') return vencida(r, hoy);
  const f = fechaFila(r);
  if (t === 'SIN_FECHA') return f === null;
  return !vencida(r, hoy) && f !== null && f <= masDias(hoy, t === 'PROX7' ? 7 : 30);
}
export function totales(rows: PayableDueRow[], hoy: string): Record<Tarjeta, number> {
  const s = (t: Tarjeta) => Math.round(rows.filter((r) => enTarjeta(r, t, hoy)).reduce((x, r) => x + r.amount, 0) * 100) / 100;
  return { TOTAL: s('TOTAL'), VENCIDO: s('VENCIDO'), PROX7: s('PROX7'), PROX30: s('PROX30'), SIN_FECHA: s('SIN_FECHA') };
}
export const esChequeFila = (r: Pick<PayableDueRow, 'row_kind'>) => r.row_kind === 'CHEQUE' || r.row_kind === 'ECHEQ';
export function etiquetaFila(r: PayableDueRow): string {
  if (r.row_kind === 'CUOTA') return `Cuota ${r.seq}/${r.n_items}`;
  if (r.row_kind === 'DIFERENCIA') return 'Diferencia sin plan (el total cambió)';
  if (esChequeFila(r)) return `${r.row_kind === 'ECHEQ' ? 'eCheq' : 'Cheque'} ${r.cheque_number ?? ''} · ${r.bank_account_name ?? ''}${r.link_status === 'SIN_IMPUTAR' ? ' · sin imputar' : ''}`;
  return r.document_number ? `Factura ${r.document_number}` : 'Pago único';
}
/** n instalments of the total (the last one takes the rounding), monthly keeping the day (or the month end), or every k days. */
export function repartirCuotas(total: number, k: number, primera: string, f: 'MENSUAL' | 'QUINCENAL' | 'SEMANAL'): { due_date: string; amount: number }[] {
  const base = Math.floor((total / k) * 100) / 100;
  const mes = (i: number) => {
    const [y, m, d] = primera.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, m - 1 + i + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + i, Math.min(d, ultimo))).toISOString().slice(0, 10);
  };
  return Array.from({ length: k }, (_, i) => ({
    due_date: f === 'MENSUAL' ? mes(i) : masDias(primera, i * (f === 'QUINCENAL' ? 15 : 7)),
    amount: i === k - 1 ? Math.round((total - base * (k - 1)) * 100) / 100 : base,
  }));
}

/** 0123: a client cheque in portfolio endorsed to the supplier of ONE invoice (or ONE of its plan items); the excess stays as credit. */
export function endorseChequeToPayable(client: SupabaseClient, p: { instrumentId: string; purchaseId: string; itemId: number | null; date: string; idempotencyKey: string; reason?: string | null }) {
  return callRpc<{ replayed: boolean; allocated: number; supplier_credit: number }>(client, 'endorse_cheque_to_payable', {
    p_instrument_id: p.instrumentId, p_purchase_id: p.purchaseId, p_item_id: p.itemId, p_endorsed_date: p.date,
    p_idempotency_key: p.idempotencyKey, p_reason: p.reason?.trim() || null,
  });
}
