/**
 * Nuevo gasto and Editar / Rectificar (0117) — one form, the existing accounting RPCs (the same the WhatsApp bot uses):
 *
 *   supplier,     pending of payment → register_purchase (_with_fiscal_document): the supplier debt, no money
 *   supplier,     paid (cash / bank) → register_paid_supplier_purchase: purchase + ONE payment on the real date + its allocation
 *   supplier,     paid by Mercado Pago → refused here: the outflow is classified from its movement (never a second movement)
 *   no supplier,  pending of payment → register_pending_expense: the obligation, no money
 *   no supplier,  paid by Mercado Pago → register_casual_purchase_mp_pending: linked to its real movement later
 *   no supplier,  paid (cash / bank) on the date of the expense → register_casual_purchase: born paid
 *   no supplier,  paid on a later date → register_pending_expense + pay_pending_expense (both replay-safe by key)
 *
 * A rectification is rectify_purchase_details: a new version, audited (who, when, why, every field before / after); the backend
 * refuses what would break payments, cheques, Mercado Pago links or fiscal documents. Nothing is computed here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, readView } from './db';
import { FISCAL_VACIO, type FiscalForm, type PurchaseFiscalInput } from './fiscal';
import type { PurchaseNatureValue } from './masters';
import { payPendingExpense } from './payables';
import { registerPurchase, registerPurchaseWithFiscal, type PurchaseRow } from './treasury';

/** The three natures of the form, on the existing internal values (no new nature). */
export const NATURALEZA_GASTO: [PurchaseNatureValue, string][] = [
  ['OPERATING', 'Operativo'], ['REINVESTMENT', 'Reinversión operativa'], ['INVESTMENT', 'Inversión'],
];
export const NATURALEZA_GASTO_LABEL = Object.fromEntries(NATURALEZA_GASTO) as Record<PurchaseNatureValue, string>;

export type EstadoPago = 'PENDIENTE' | 'PAGADO';
export type MedioPago = 'CASH' | 'TRANSFER' | 'MERCADOPAGO';
export const MEDIO_PAGO_LABEL: Record<MedioPago, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', MERCADOPAGO: 'Mercado Pago' };

export type RutaGasto =
  | 'FACTURA_PENDIENTE' | 'FACTURA_PAGADA' | 'PROVEEDOR_MP_NO_PERMITIDO'
  | 'SIN_PROVEEDOR_PENDIENTE' | 'SIN_PROVEEDOR_MP' | 'SIN_PROVEEDOR_PAGADO' | 'SIN_PROVEEDOR_PAGADO_DESPUES';

/** Which existing RPC records the expense (see the table above). */
export function rutaGasto(i: { supplierId: string | null; estado: EstadoPago; medio: MedioPago | null; fecha: string; fechaPago: string }): RutaGasto {
  if (i.supplierId) {
    if (i.estado === 'PENDIENTE') return 'FACTURA_PENDIENTE';
    return i.medio === 'MERCADOPAGO' ? 'PROVEEDOR_MP_NO_PERMITIDO' : 'FACTURA_PAGADA';
  }
  if (i.estado === 'PENDIENTE') return 'SIN_PROVEEDOR_PENDIENTE';
  if (i.medio === 'MERCADOPAGO') return 'SIN_PROVEEDOR_MP';
  return i.fechaPago === i.fecha ? 'SIN_PROVEEDOR_PAGADO' : 'SIN_PROVEEDOR_PAGADO_DESPUES';
}

/** The account types a payment method is paid from (the backend checks the same). */
export const cuentaAdmitida = (medio: MedioPago, accountType: string) =>
  (medio === 'CASH' && accountType === 'CASH') || (medio === 'TRANSFER' && accountType === 'BANK_ACCOUNT')
  || (medio === 'MERCADOPAGO' && accountType === 'EXTERNAL_SERVICE');

/** The fiscal document as the casual / pending / paid-supplier RPCs take it (components as typed, direction CREDITO). */
export function fiscalJson(f: PurchaseFiscalInput, extra: { fecha: string; numero?: string | null; cuitEmisor?: string | null; nombreEmisor?: string | null }) {
  return {
    document_type: f.documentType, document_date: extra.fecha, fiscal_period: f.fiscalPeriod, net_amount: f.netAmount, total_amount: f.totalAmount,
    components: f.components.map((c) => ({ ...c, direction: 'CREDITO' })),
    external_number: extra.numero?.trim() || null, issuer_tax_id: extra.cuitEmisor ?? null, issuer_name: extra.nombreEmisor?.trim() || null,
  };
}

export interface NuevoGastoInput {
  concept: string; supplierId: string | null; amountTotal: number; fecha: string; categoryId: string; nature: PurchaseNatureValue;
  estado: EstadoPago; medio: MedioPago | null; accountId: string | null; fechaPago: string;
  invoiceNumber: string | null; fiscal: PurchaseFiscalInput | null; cuitEmisor: string | null; nombreEmisor: string | null;
  idempotencyKey: string;
}
type Meta = { storage_path: string; file_name: string; content_type: string; byte_size: number }[];

/** Records the expense through its route, with the already uploaded attachments. */
export async function registrarGasto(client: SupabaseClient, g: NuevoGastoInput, attachments: Meta) {
  const ruta = rutaGasto(g);
  const concept = g.concept.trim();
  const net = g.fiscal ? g.fiscal.netAmount : g.amountTotal;
  const invoice = g.invoiceNumber?.trim() || null;
  const casualFiscal = g.fiscal ? fiscalJson(g.fiscal, { fecha: g.fecha, numero: invoice, cuitEmisor: g.cuitEmisor, nombreEmisor: g.nombreEmisor }) : null;
  const casual = {
    p_economic_date: g.fecha, p_amount_net: net, p_amount_total: g.amountTotal, p_expense_category_id: g.categoryId, p_concept: concept, p_nature: g.nature,
    p_attachments: attachments, p_fiscal: casualFiscal,
  };
  switch (ruta) {
    case 'PROVEEDOR_MP_NO_PERMITIDO':
      throw new Error('PROVEEDOR_MP_NO_PERMITIDO');
    case 'FACTURA_PENDIENTE': {
      const base = { supplierId: g.supplierId!, economicDate: g.fecha, amountNet: net, amountTotal: g.amountTotal, categoryId: g.categoryId, subcategory: concept,
        nature: g.nature, lines: [], attachments, idempotencyKey: g.idempotencyKey, invoiceNumber: invoice };
      return g.fiscal ? registerPurchaseWithFiscal(client, { ...base, fiscal: g.fiscal }) : registerPurchase(client, base);
    }
    case 'FACTURA_PAGADA':
      return callRpc(client, 'register_paid_supplier_purchase', {
        p_supplier_id: g.supplierId, p_economic_date: g.fecha, p_amount_total: g.amountTotal, p_expense_category_id: g.categoryId, p_concept: concept,
        p_nature: g.nature, p_idempotency_key: g.idempotencyKey, p_payment_date: g.fechaPago, p_payment_method: g.medio, p_account_id: g.accountId,
        p_invoice_number: invoice, p_attachments: attachments,
        p_fiscal: g.fiscal ? { document_type: g.fiscal.documentType, fiscal_period: g.fiscal.fiscalPeriod, net_amount: g.fiscal.netAmount,
          total_amount: g.fiscal.totalAmount, components: g.fiscal.components } : null,
      });
    case 'SIN_PROVEEDOR_PENDIENTE':
      return callRpc(client, 'register_pending_expense', { ...casual, p_idempotency_key: g.idempotencyKey, p_origin: 'ERP' });
    case 'SIN_PROVEEDOR_MP':
      return callRpc(client, 'register_casual_purchase_mp_pending', { ...casual, p_idempotency_key: g.idempotencyKey, p_mp_account_id: g.accountId, p_origin: 'ERP' });
    case 'SIN_PROVEEDOR_PAGADO':
      return callRpc(client, 'register_casual_purchase', { ...casual, p_paid_from_account_id: g.accountId, p_payment_method: g.medio, p_idempotency_key: g.idempotencyKey });
    case 'SIN_PROVEEDOR_PAGADO_DESPUES': {
      const r = await callRpc<{ payable_id: string }>(client, 'register_pending_expense', { ...casual, p_idempotency_key: g.idempotencyKey, p_origin: 'ERP' });
      return payPendingExpense(client, { payableId: r.payable_id, amount: g.amountTotal, effectiveDate: g.fechaPago, accountId: g.accountId!,
        method: g.medio === 'CASH' ? 'CASH' : 'TRANSFER', idempotencyKey: `${g.idempotencyKey}:PAY` });
    }
  }
}

// ── Editar / Rectificar ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface RectificacionInput {
  purchaseId: string; concept: string; categoryId: string; nature: PurchaseNatureValue; fecha: string; supplierId: string | null;
  invoiceNumber: string | null; amountTotal: number; amountNet: number; reason: string; fiscal: ReturnType<typeof fiscalJson> | null;
}
export function rectificarGasto(client: SupabaseClient, r: RectificacionInput) {
  return callRpc<{ previous_purchase_id: string; new_purchase_id: string; purchase_root_id: string; version_seq: number; supplier_ledger_rebooked: boolean }>(
    client, 'rectify_purchase_details', {
      p_purchase_id: r.purchaseId, p_concept: r.concept.trim(), p_expense_category_id: r.categoryId, p_nature: r.nature, p_economic_date: r.fecha,
      p_supplier_id: r.supplierId, p_invoice_number: r.invoiceNumber?.trim() || null, p_amount_total: r.amountTotal, p_amount_net: r.amountNet,
      p_reason: r.reason.trim(), p_fiscal: r.fiscal,
    });
}

/** What can be corrected in an expense, from its links (the backend decides again; this only explains it before trying). */
export interface ReglasEdicion { proveedor: boolean; fecha: boolean; importe: boolean; numero: boolean; agregarFactura: boolean; motivos: string[] }
export function reglasEdicion(g: {
  conProveedor: boolean; pagadoAlRegistrar: boolean; pendienteSinProveedor: boolean; mpVinculado: boolean; asignado: number; conFactura: boolean;
}): ReglasEdicion {
  const motivos: string[] = [];
  let proveedor = g.conProveedor; let fecha = true; let importe = true; let numero = g.conProveedor;
  if (!g.conProveedor) {
    motivos.push(g.pendienteSinProveedor ? 'Para asignarle un proveedor usá «Vincular a proveedor».' : 'Un gasto sin proveedor ya pagado queda sin proveedor.');
    if (g.pagadoAlRegistrar) { fecha = false; importe = false; motivos.push('Ya está pagado: conserva la fecha y el importe de su pago.'); }
    if (g.pendienteSinProveedor) { importe = false; motivos.push('El importe de un gasto pendiente sin proveedor es el de su obligación: vinculalo a un proveedor para corregirlo.'); }
    if (g.mpVinculado) { importe = false; motivos.push('Ya está vinculado a su movimiento de Mercado Pago: conserva su importe.'); }
  } else if (g.asignado > 0) {
    proveedor = false; motivos.push('Tiene pagos o cheques asignados: el proveedor no cambia y el importe no puede bajar de lo asignado.');
  }
  if (g.conFactura) {
    proveedor = false; importe = false; numero = false;
    motivos.push('Tiene comprobante fiscal: proveedor, importe y número se corrigen con una nota de crédito o débito en Fiscal.');
  }
  return { proveedor, fecha, importe, numero, agregarFactura: !g.conFactura, motivos };
}

/** The expense's links as its row in Cuentas a pagar → Gastos shows them, and how its payment is handled. */
export interface VinculosGasto { pendienteSinProveedor: boolean; mpVinculado: boolean; asignado: number; estadoPago: string; comoPagar: string }
export const reglasDeCompra = (c: PurchaseRow, v: VinculosGasto): ReglasEdicion => reglasEdicion({
  conProveedor: !!c.supplier_id, pagadoAlRegistrar: !!c.paid_operation_id, pendienteSinProveedor: v.pendienteSinProveedor,
  mpVinculado: v.mpVinculado, asignado: v.asignado, conFactura: !!c.fiscal_document_id,
});

/** The optional receipt / invoice block of the form (file, number, fiscal data, issuer CUIT without supplier). */
export interface ComprobanteForm { numero: string; archivos: File[]; errorArchivo: unknown; fiscal: FiscalForm; cuitEmisor: string; nombreEmisor: string }
export const COMPROBANTE_VACIO: ComprobanteForm = { numero: '', archivos: [], errorArchivo: null, fiscal: FISCAL_VACIO, cuitEmisor: '', nombreEmisor: '' };

// ── history ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface AuditoriaRow {
  audit_id: number; purchase_root_id: string; purchase_id: string; action: string; before_values: Record<string, unknown> | null;
  after_values: Record<string, unknown> | null; reason: string | null; performed_by: string | null; performed_at: string;
}
export async function listAuditoriaGasto(client: SupabaseClient, rootId: string): Promise<AuditoriaRow[]> {
  return readView<AuditoriaRow>(client, 'fin_purchase_audit', (q) => q.eq('purchase_root_id', rootId).order('performed_at', { ascending: true }).order('audit_id'));
}
export const raizDeCompra = (client: SupabaseClient, purchaseId: string) => callRpc<string>(client, 'purchase_chain_root', { p_purchase: purchaseId });

export const ACCION_AUDITORIA: Record<string, string> = {
  CREATE: 'Registro', RECTIFY: 'Rectificación de importes', RECTIFY_DETAILS: 'Rectificación', RECLASSIFY: 'Reclasificación', LINK_SUPPLIER: 'Vinculado a proveedor',
};
const CAMPO: Record<string, string> = {
  concept: 'Concepto', expense_category_id: 'Categoría', nature: 'Naturaleza', economic_date: 'Fecha', supplier_id: 'Proveedor',
  supplier_invoice_number: 'Nº de factura', amount_total: 'Importe', amount_net: 'Neto', fiscal_document_id: 'Comprobante fiscal', counterparty_name: 'Comercio',
};
const igual = (a: unknown, b: unknown) => (a === null || a === undefined ? null : String(a)) === (b === null || b === undefined ? null : String(b))
  || (a !== null && b !== null && a !== undefined && b !== undefined && !Number.isNaN(Number(a)) && Number(a) === Number(b) && String(a).trim() !== '');

/** The fields an audit row changed, labelled; ids are resolved by the caller (categories, suppliers). */
export function cambiosAuditoria(r: Pick<AuditoriaRow, 'before_values' | 'after_values'>): { campo: string; clave: string; antes: unknown; despues: unknown }[] {
  const antes = r.before_values ?? {};
  const despues = r.after_values ?? {};
  return Object.keys(CAMPO).filter((k) => k in despues && !igual(antes[k], despues[k]))
    .map((k) => ({ campo: CAMPO[k], clave: k, antes: antes[k] ?? null, despues: despues[k] ?? null }));
}
