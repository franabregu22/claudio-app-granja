/**
 * Caja → Movimientos → Todas las operaciones (0119): ONE list of everything recorded, from fin_operation_list (ADMIN). Every amount once:
 * an operation with money (a transfer between own accounts is one row), and what is still unpaid — a pending expense, the unpaid part of a
 * supplier invoice (its cheques not yet debited are inside it), an own cheque not linked to an invoice, a client cheque not credited, an
 * anticipated transfer. The page, the total and the filters are the server's.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc } from './db';
import { parseAmountSearch } from './movementHistory';

export const OPERATION_PAGE = 50;
export type OperationTipo = 'INGRESO' | 'EGRESO' | 'TRANSFERENCIA';
export type OperationEstado = 'PENDIENTE' | 'COMPLETADA';
export type OperationRowKind = 'OP' | 'GASTO' | 'FACTURA' | 'CHEQUE' | 'CHEQUE_RECIBIDO' | 'TRANSFERENCIA';
export type Conciliacion = 'CONCILIADA' | 'SIN_CONCILIAR' | 'MERCADO_PAGO' | null;
export type Clasificacion = 'MP_SIN_CLASIFICAR' | 'GASTO_SIN_CLASIFICAR' | null;

export interface OperationFilter {
  from?: string; to?: string; tipo?: OperationTipo; accountId?: string; sinCuenta?: boolean; estado?: OperationEstado; search?: string;
  order?: 'FECHA' | 'CARGA';
}
export interface OperationAccount { account_id: string; account_name: string; signed_amount: number | null }
export interface PendienteGasto { total: number; pagado: number; pendiente: number; vence: string | null; estimada: string | null }
export interface PendienteFactura extends PendienteGasto { purchase_id: string; cheques_por_debitar: number; sin_cubrir: number }
export interface OperationRow {
  row_key: string; row_kind: OperationRowKind; date: string | null; created_at: string | null; tipo: OperationTipo;
  /** Signed: an egreso negative, an ingreso positive; a transfer, minus what moved. */
  amount: number; estado: OperationEstado; concepto: string; detalle: string;
  operation_id: number | null; ref_uuid: string | null; ref_id: number | null;
  accounts: OperationAccount[];
  conciliacion: Conciliacion; clasificacion: Clasificacion;
  pendiente: PendienteGasto | PendienteFactura | null;
}
export interface OperationPage { rows: OperationRow[]; total: number }

export const TIPO_LABEL: Record<OperationTipo, string> = { INGRESO: 'Ingreso', EGRESO: 'Egreso', TRANSFERENCIA: 'Transferencia' };
/** The state in the owner's words: Pendiente / Pagado (egreso) / Cobrado (ingreso) / Realizada (transferencia). */
export function estadoLabel(r: Pick<OperationRow, 'tipo' | 'estado'>): string {
  if (r.estado === 'PENDIENTE') return 'Pendiente';
  return r.tipo === 'INGRESO' ? 'Cobrado' : r.tipo === 'EGRESO' ? 'Pagado' : 'Realizada';
}
export const CONCILIACION_LABEL: Record<Exclude<Conciliacion, null>, string> = {
  CONCILIADA: 'Conciliada con el banco', SIN_CONCILIAR: 'Sin conciliar', MERCADO_PAGO: 'Movimiento de Mercado Pago',
};
export const CLASIFICACION_LABEL: Record<Exclude<Clasificacion, null>, string> = { MP_SIN_CLASIFICAR: 'Mercado Pago sin clasificar', GASTO_SIN_CLASIFICAR: 'Gasto sin clasificar' };

/** "Caja chica → BNA" (money leaves first), the account for one, "Sin asignar" for none. */
export function cuentasLabel(r: Pick<OperationRow, 'accounts' | 'row_kind'>): string {
  if (r.accounts.length === 0) return 'Sin asignar';
  if (r.row_kind === 'TRANSFERENCIA') return r.accounts.map((a) => a.account_name).join(' → ');
  const salen = r.accounts.filter((a) => (a.signed_amount ?? 0) < 0).map((a) => a.account_name);
  const entran = r.accounts.filter((a) => (a.signed_amount ?? 0) > 0).map((a) => a.account_name);
  const otras = r.accounts.filter((a) => a.signed_amount === null || a.signed_amount === 0).map((a) => a.account_name);
  return salen.length > 0 && entran.length > 0 ? `${salen.join(', ')} → ${entran.join(', ')}` : [...salen, ...entran, ...otras].join(', ');
}

/**
 * The key of the row a just-recorded expense shows as, from its route (src/target/expenses.ts) and the RPC result; null when it is not
 * a row yet (a Mercado Pago expense waits for its movement).
 */
export function claveDeRegistro(ruta: string, r: unknown): string | null {
  const x = (r ?? {}) as Record<string, unknown>;
  const op = x.financial_operation_id ?? x.payment_operation_id;
  if (ruta === 'FACTURA_PENDIENTE') return typeof x.purchase_id === 'string' ? `FACTURA:${x.purchase_id}` : null;
  if (ruta === 'SIN_PROVEEDOR_PENDIENTE') return typeof x.payable_id === 'string' ? `GASTO:${x.payable_id}` : null;
  if (ruta === 'SIN_PROVEEDOR_MP') return null;
  return op !== undefined && op !== null ? `OP:${op}` : null;
}

export async function listOperations(client: SupabaseClient, f: OperationFilter, page = 0, focus: string | null = null, pageSize = OPERATION_PAGE): Promise<OperationPage> {
  const search = f.search?.trim() || null;
  const r = await callRpc<{ total: number; rows: OperationRow[] }>(client, 'fin_operation_list', {
    p_from: f.from || null, p_to: f.to || null, p_tipo: f.tipo || null, p_account_id: f.accountId || null, p_sin_cuenta: !!f.sinCuenta,
    p_estado: f.estado || null, p_search: search, p_amount: search ? parseAmountSearch(search) : null, p_order: f.order ?? 'FECHA',
    p_focus: focus, p_limit: pageSize, p_offset: page * pageSize,
  });
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    total: Number(r.total),
    rows: r.rows.map((x) => ({
      ...x, amount: Number(x.amount), ref_id: n(x.ref_id), operation_id: n(x.operation_id),
      accounts: x.accounts.map((a) => ({ ...a, signed_amount: n(a.signed_amount) })),
      pendiente: x.pendiente ? Object.fromEntries(Object.entries(x.pendiente).map(([k, v]) => [k, typeof v === 'string' && !['vence', 'estimada', 'purchase_id'].includes(k) ? Number(v) : v])) as never : null,
    })),
  };
}

/** 0119: a supplier invoice paid from its row (cash or transfer): one movement + its allocation; replay by key. */
export function payPurchaseInvoice(client: SupabaseClient, p: { rootId: string; amount: number; date: string; method: 'CASH' | 'TRANSFER'; accountId: string; idempotencyKey: string; reference: string }) {
  return callRpc<{ replayed: boolean; financial_operation_id: number; pending: number }>(client, 'pay_purchase_invoice', {
    p_purchase_root_id: p.rootId, p_amount: p.amount, p_effective_date: p.date, p_payment_method: p.method, p_account_id: p.accountId,
    p_idempotency_key: p.idempotencyKey, p_reference: p.reference.trim() || null,
  });
}

export interface TimelineEvent {
  at: string; by: string | null; action: string; entity?: string; reason?: string | null;
  before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; detail?: Record<string, unknown> | null;
}
export function operationTimeline(client: SupabaseClient, rowKey: string) {
  return callRpc<TimelineEvent[]>(client, 'fin_operation_timeline', { p_row_key: rowKey });
}

/** What each recorded event means, in the owner's words (unknown codes are shown as recorded). */
export const ACCION_HISTORIAL: Record<string, string> = {
  OPERACION_REGISTRADA: 'Operación registrada', CONCILIADA: 'Conciliada con el extracto', CONCILIACION_REVERTIDA: 'Conciliación revertida',
  IMPUTACION: 'Imputado a la factura', PAY: 'Pago registrado', PAY_INVOICE: 'Pago de la factura registrado', CREATE: 'Gasto registrado',
  CREATE_CASUAL: 'Gasto registrado (sin proveedor)', CREATE_PENDING_EXPENSE: 'Gasto pendiente registrado', RECTIFY: 'Rectificación de importes',
  RECTIFY_DETAILS: 'Rectificación', RECLASSIFY: 'Reclasificación', LINK_SUPPLIER: 'Vinculado a proveedor', ISSUE_INSTRUMENTS: 'Cheques emitidos',
  ISSUE: 'Cheque emitido', DEBIT: 'Cheque debitado', DEBIT_PRE_CUTOVER: 'Cheque debitado antes del corte', CANCEL_ISSUED: 'Cheque anulado',
  RESCHEDULE_PAYMENT_DATE: 'Fecha de pago corregida', FECHA_DUE: 'Vencimiento cargado', FECHA_PLANNED: 'Fecha estimada de pago cargada',
  TRANSFER: 'Transferencia registrada', BANK_TAX: 'Impuesto bancario registrado', REGISTER_BANK_TAX: 'Impuesto bancario registrado',
  TRANSFERENCIA_ANTICIPADA: 'Transferencia anticipada registrada', TRANSFERENCIA_VINCULADA: 'Transferencia vinculada a su movimiento',
  TRANSFERENCIA_ANULADA: 'Transferencia anticipada anulada', CHEQUE_ISSUED: 'Cheque emitido', CHEQUE_DEBITED: 'Cheque debitado',
  CHEQUE_CANCELLED: 'Cheque anulado', CHEQUE_REJECTED: 'Cheque rechazado', CHEQUE_RECEIVED: 'Cheque recibido', CHEQUE_DEPOSITED: 'Cheque depositado',
  CHEQUE_CLEARED: 'Cheque acreditado', CHEQUE_ENDORSED: 'Cheque endosado',
};
