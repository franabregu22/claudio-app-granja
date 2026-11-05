/**
 * Cuentas a pagar → Gastos: ONE list of what was spent, read from the existing sources as served (nothing is recomputed):
 *   - supplier invoices with their payment status (fin_purchase_payment_status, 0104 / 0110): pending, scheduled cheques, paid;
 *   - pending expenses without a supplier (fin_expense_payables, ADR-026 / 0106);
 *   - expenses to review: paid but unclassified (fin_expense_pending_classification, 0101) and purchases paid with Mercado Pago
 *     whose movement is not linked yet (fin_purchase_mp_link, 0111);
 *   - other current purchases (casual, paid when registered) — the old "Compras" list.
 * Each purchase appears once (by its current version id; an invoice wins over every other source). Only presentation lives here:
 * every action is the existing RPC of its screen, and the backend keeps validating amounts, duplicates and states.
 */
import type { PurchasePaymentStatusRow } from './invoicePayments';
import type { PayableRow } from './payables';
import type { PurchaseMpLinkRow } from './purchaseMpLink';
import type { PurchaseRow } from './treasury';
import type { PendingExpenseRow } from './unclassifiedExpenses';

export type GastoEstado = 'POR_REVISAR' | 'PENDIENTE' | 'CHEQUES' | 'PAGADO';
export type GastoFiltro = GastoEstado | 'TODOS';
export const GASTO_FILTROS: { id: GastoFiltro; label: string }[] = [
  { id: 'POR_REVISAR', label: 'Por revisar' },
  { id: 'PENDIENTE', label: 'Pendientes de pago' },
  { id: 'CHEQUES', label: 'Cheques pendientes' },
  { id: 'PAGADO', label: 'Pagados' },
  { id: 'TODOS', label: 'Todos' },
];
export const GASTO_ESTADO_LABEL: Record<GastoEstado, string> = {
  POR_REVISAR: 'Por revisar', PENDIENTE: 'Pendiente de pago', CHEQUES: 'Cheques pendientes de débito', PAGADO: 'Pagado',
};

interface GastoBase {
  key: string; estado: GastoEstado; fecha: string; vence: string | null; estimada: string | null; titulo: string; detalle: string;
  total: number; pendiente: number; programado: number; origen: 'ERP' | 'WHATSAPP' | null;
  /** the current purchase version (null: an unclassified expense has no purchase yet) */
  purchaseId: string | null;
}
export type GastoItem = GastoBase & (
  | { kind: 'FACTURA'; factura: PurchasePaymentStatusRow }
  | { kind: 'A_PAGAR'; gasto: PayableRow }
  | { kind: 'SIN_CLASIFICAR'; sinClasificar: PendingExpenseRow }
  | { kind: 'MP_PENDIENTE'; mp: PurchaseMpLinkRow }
  | { kind: 'COMPRA'; compra: PurchaseRow }
);

export interface GastoFuentes {
  facturas: readonly PurchasePaymentStatusRow[]; aPagar: readonly PayableRow[]; sinClasificar: readonly PendingExpenseRow[];
  mp: readonly PurchaseMpLinkRow[]; compras: readonly PurchaseRow[];
}

const EPS = 0.005;
const pos = (v: number) => (v > EPS ? v : 0);

/** The state of an invoice from the backend figures: still owed → pending; covered only by unpaid cheques → cheques; else paid. */
export function estadoFactura(f: Pick<PurchasePaymentStatusRow, 'pending' | 'scheduled'>): GastoEstado {
  if (f.pending > EPS) return 'PENDIENTE';
  if (f.scheduled > EPS) return 'CHEQUES';
  return 'PAGADO';
}

export function armarGastos(src: GastoFuentes): GastoItem[] {
  const out: GastoItem[] = [];
  const vistos = new Set<string>();
  const agregar = (it: GastoItem) => {
    if (it.purchaseId) {
      if (vistos.has(it.purchaseId)) return;
      vistos.add(it.purchaseId);
    }
    out.push(it);
  };
  for (const f of src.facturas) {
    agregar({
      kind: 'FACTURA', factura: f, key: `F-${f.purchase_id}`, estado: estadoFactura(f), fecha: f.economic_date, vence: f.due_date, estimada: f.planned_date,
      titulo: f.supplier_name, detalle: f.supplier_invoice_number ? `Factura ${f.supplier_invoice_number}` : 'Sin número de factura',
      total: f.amount_total, pendiente: pos(f.pending), programado: pos(f.scheduled), origen: null, purchaseId: f.purchase_id,
    });
  }
  for (const g of src.aPagar) {
    agregar({
      kind: 'A_PAGAR', gasto: g, key: `P-${g.payable_id}`, estado: g.pending > EPS ? 'PENDIENTE' : 'PAGADO', fecha: g.economic_date, vence: g.due_date,
      estimada: g.planned_date, titulo: g.concept ?? g.category_name, detalle: [g.category_name, g.counterparty_name].filter(Boolean).join(' · '),
      total: g.amount, pendiente: pos(g.pending), programado: 0, origen: g.origin, purchaseId: g.purchase_id,
    });
  }
  for (const m of src.mp) {
    if (m.status !== 'PENDIENTE_VINCULACION_MP') continue;   // linked: an ordinary paid purchase (listed below)
    agregar({
      kind: 'MP_PENDIENTE', mp: m, key: `M-${m.purchase_id}`, estado: 'POR_REVISAR', fecha: m.economic_date, vence: null, estimada: null,
      titulo: m.concept ?? m.category_name ?? 'Gasto con Mercado Pago', detalle: [m.category_name, m.counterparty_name, 'Mercado Pago sin vincular'].filter(Boolean).join(' · '),
      total: m.amount_total, pendiente: 0, programado: 0, origen: m.origin, purchaseId: m.purchase_id,
    });
  }
  for (const s of src.sinClasificar) {
    if (s.status !== 'SIN_CLASIFICAR') continue;   // classified: its purchase is listed below
    agregar({
      kind: 'SIN_CLASIFICAR', sinClasificar: s, key: `S-${s.pending_id}`, estado: 'POR_REVISAR', fecha: s.economic_date, vence: null, estimada: null,
      titulo: s.concept, detalle: [s.counterparty_name, s.account_name, 'sin clasificar'].filter(Boolean).join(' · '),
      total: s.amount, pendiente: 0, programado: 0, origen: s.origin, purchaseId: s.purchase_id,
    });
  }
  for (const c of src.compras) {
    if (c.supplier_id) continue;   // supplier purchases are the invoices above (their payment status is the backend's)
    agregar({
      kind: 'COMPRA', compra: c, key: `C-${c.id}`, estado: 'PAGADO', fecha: c.economic_date, vence: null, estimada: null,
      titulo: c.subcategory ?? c.supplier_nombre, detalle: [c.categoria_nombre, c.supplier_nombre].filter(Boolean).join(' · '),
      total: c.amount_total, pendiente: 0, programado: 0, origen: null, purchaseId: c.id,
    });
  }
  return out;
}

/** "Cheques pendientes" also shows an invoice still partly owed but with cheques waiting for their debit. */
export function coincide(it: GastoItem, filtro: GastoFiltro): boolean {
  if (filtro === 'TODOS') return true;
  if (filtro === 'CHEQUES') return it.programado > 0;
  return it.estado === filtro;
}

const normalizar = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function buscar(it: GastoItem, texto: string): boolean {
  const t = normalizar(texto.trim());
  return t === '' || normalizar(`${it.titulo} ${it.detalle}`).includes(t);
}

/** Pending: the nearest due date first (no due date last); every other list: the newest first. */
export function ordenar(items: readonly GastoItem[], filtro: GastoFiltro): GastoItem[] {
  const copia = [...items];
  if (filtro === 'PENDIENTE') {
    return copia.sort((a, b) => (a.vence ?? '9999-12-31').localeCompare(b.vence ?? '9999-12-31') || a.fecha.localeCompare(b.fecha));
  }
  return copia.sort((a, b) => b.fecha.localeCompare(a.fecha) || a.key.localeCompare(b.key));
}

export function contar(items: readonly GastoItem[]): Record<GastoFiltro, number> {
  const r: Record<GastoFiltro, number> = { POR_REVISAR: 0, PENDIENTE: 0, CHEQUES: 0, PAGADO: 0, TODOS: items.length };
  for (const it of items) for (const f of ['POR_REVISAR', 'PENDIENTE', 'CHEQUES', 'PAGADO'] as const) if (coincide(it, f)) r[f] += 1;
  return r;
}

/** The figure a list totals: what is still owed, or what waits in cheques. */
export function totalFiltro(items: readonly GastoItem[], filtro: GastoFiltro): number | null {
  if (filtro === 'PENDIENTE') return items.reduce((s, it) => s + it.pendiente, 0);
  if (filtro === 'CHEQUES') return items.reduce((s, it) => s + it.programado, 0);
  return null;
}

/** An invoice number already recorded for that supplier (the backend refuses it too: DUPLICATE_SUPPLIER_INVOICE / DUPLICATE_INVOICE). */
export function facturaRepetida(facturas: readonly Pick<PurchasePaymentStatusRow, 'supplier_id' | 'supplier_invoice_number'>[], supplierId: string, numero: string) {
  const n = numero.trim().toLowerCase();
  return n !== '' && facturas.some((f) => f.supplier_id === supplierId && (f.supplier_invoice_number ?? '').trim().toLowerCase() === n);
}

/** Same supplier, same date and same total: probably the same expense loaded twice (a warning; it can still be recorded). */
export function posibleDuplicado(facturas: readonly Pick<PurchasePaymentStatusRow, 'supplier_id' | 'economic_date' | 'amount_total'>[], supplierId: string, fecha: string, total: number) {
  return supplierId !== '' && total > 0 && facturas.some((f) => f.supplier_id === supplierId && f.economic_date === fecha && Math.abs(f.amount_total - total) < EPS);
}
